import {
  clearIndexedDbCache,
  createIndexedDbCache,
  isIndexedDbAvailable,
} from './cache'
import { BackgroundRemovalError, normalizeError } from './errors'
import {
  decodeImage,
  imageToPng,
  inspectMask,
  maskToPng,
  prepareImageForInference,
  validateImage,
} from './image'
import {
  detectEngineChoices,
  engineKey,
  LITE_MODEL,
  modelUrl,
  type EngineChoice,
  type ExecutionProvider,
  type ModelDefinition,
  type RemovalModel,
} from './models'
import { createMaskRefinement, type InferenceMask } from './refinement'
import { canUseOnnxWebGpu, shouldUseSingleThreadedWasm } from './runtime'

export {
  BackgroundRemovalError,
  type BackgroundRemovalErrorCode,
} from './errors'
export {
  IMAGE_ACCEPT_ATTRIBUTE,
  SUPPORTED_IMAGE_FORMAT_LABEL,
  SUPPORTED_IMAGE_MIME_TYPES,
} from './image'

export type RemovalQuality = 'fast' | 'quality'
export { isMobileBrowser } from './runtime'
export type { ExecutionProvider, RemovalModel } from './models'

export interface RemovalProgress {
  stage: 'preparing' | 'downloading' | 'processing' | 'finishing'
  progress: number
  message: string
}

export interface RemoveBackgroundOptions {
  quality?: RemovalQuality
  onProgress?: (progress: RemovalProgress) => void
  signal?: AbortSignal
}

export interface BackgroundRemovalResult {
  blob: Blob
  sourceBlob?: Blob
  width: number
  height: number
  provider: ExecutionProvider
  model: RemovalModel
  quality: RemovalQuality
  durationMs: number
}

export interface BrowserCapabilities {
  webgpu: boolean
  wasm: boolean
}

// Retry GPUs rejected by the older runtime after moving to Transformers.js 4.
const WEBGPU_FAILURE_KEY = `bg0:webgpu-failure:v4:${LITE_MODEL.revision}`

type TensorLike = {
  data: Float32Array | Uint8Array | Int32Array | BigInt64Array
  dims: number[]
  sigmoid: () => TensorLike
}

type ModelOutput = { logits?: TensorLike; output_image?: TensorLike }
type ModelRunner = {
  (input: Record<string, unknown>): Promise<ModelOutput>
  dispose: () => Promise<unknown>
}
type ProcessorRunner = (image: unknown) => Promise<Record<string, unknown>>
type Engine = EngineChoice & {
  model: ModelRunner
  processor: ProcessorRunner
}
type EngineLease = {
  engine: Engine
  retire: () => Promise<void>
  release: () => Promise<void>
}

type EngineProgress = { progress: number; initializing: boolean }
type EngineLoad = {
  promise: Promise<Engine>
  listeners: Set<(progress: number, initializing: boolean) => void>
  progress?: EngineProgress
  users: number
  retired: boolean
  disposal?: Promise<void>
}

const engineLoads = new Map<string, EngineLoad>()
const failedEngines = new Set<string>()
let detectedChoices: Promise<EngineChoice[]> | undefined
let webgpuUsableForSession = true

export function getBrowserCapabilities(): BrowserCapabilities {
  const hasNavigatorGpu = typeof navigator !== 'undefined' && 'gpu' in navigator
  return {
    webgpu:
      typeof navigator !== 'undefined' &&
      canUseOnnxWebGpu(navigator.userAgent, hasNavigatorGpu),
    wasm: true,
  }
}

export function clearModelCache(): void {
  for (const load of engineLoads.values()) {
    void retireEngine(load)
  }
  engineLoads.clear()
  failedEngines.clear()
  detectedChoices = undefined
  webgpuUsableForSession = true
  try {
    localStorage.removeItem(WEBGPU_FAILURE_KEY)
  } catch {
    // Storage can be unavailable in privacy modes. The in-memory reset remains useful.
  }
  void clearIndexedDbCache()
}

/**
 * Download and initialize the model before the first image is selected.
 * Concurrent calls share the same initialization work with removeBackground.
 */
export async function prepareBackgroundRemoval(): Promise<ExecutionProvider> {
  const lease = await getPreferredEngine(
    await getPreferredChoices(),
    () => undefined,
  )
  try {
    return lease.engine.provider
  } finally {
    await lease.release()
  }
}

export async function removeBackground(
  input: Blob,
  options: RemoveBackgroundOptions = {},
): Promise<BackgroundRemovalResult> {
  const startedAt = performance.now()
  const quality = options.quality ?? 'fast'
  let reportedProgress = 0
  const notify = (progress: RemovalProgress) => {
    reportedProgress = Math.max(reportedProgress, progress.progress)
    options.onProgress?.({ ...progress, progress: reportedProgress })
  }
  let decodedImage: ImageBitmap | undefined
  let lease: EngineLease | undefined

  try {
    throwIfCancelled(options.signal)
    const format = await validateImage(input)
    notify({ stage: 'preparing', progress: 0.03, message: 'Preparing image…' })
    const choices = await getPreferredChoices()
    throwIfCancelled(options.signal)
    const preparedImage = await prepareImageForInference(
      input,
      choices[0].definition.inputSize,
      choices[0].definition.inputSize,
      format,
    )
    throwIfCancelled(options.signal)

    lease = await getPreferredEngine(
      choices,
      (progress, initializing, modelIsCached) => {
        notify({
          stage: modelIsCached || initializing ? 'preparing' : 'downloading',
          progress: 0.08 + progress * 0.58,
          message: initializing
            ? 'Starting local model…'
            : modelIsCached
              ? 'Loading cached model…'
              : 'Downloading local model…',
        })
      },
      options.signal,
    )
    let engine = lease.engine
    throwIfCancelled(options.signal)

    notify({
      stage: 'processing',
      progress: 0.7,
      message: 'Removing background…',
    })
    const { RawImage } = await import('@huggingface/transformers')
    const source = new RawImage(
      preparedImage.data,
      preparedImage.width,
      preparedImage.height,
      4,
    )
    let inference: InferenceMask
    while (true) {
      throwIfCancelled(options.signal)
      try {
        inference = await inferMask(engine, source)
        if (
          !inference.inspection.valid ||
          (engine.provider === 'webgpu' &&
            !inference.inspection.hasForegroundSignal)
        ) {
          throw new Error('The model returned an invalid alpha mask')
        }
        break
      } catch (error) {
        throwIfCancelled(options.signal)
        if (
          engine.provider === 'wasm' &&
          engine.definition.name === 'birefnet-lite'
        )
          throw error
        rememberEngineFailure(engine)
        await lease.retire()
        await lease.release()
        lease = undefined
        throwIfCancelled(options.signal)
        notify({
          stage: 'preparing',
          progress: 0.74,
          message: 'Switching to a compatible model…',
        })
        lease = await getPreferredEngine(
          choices,
          (progress, initializing, cached) => {
            notify({
              stage: initializing || cached ? 'preparing' : 'downloading',
              progress: 0.74 + progress * 0.14,
              message: initializing
                ? 'Starting compatibility mode…'
                : 'Preparing compatibility mode…',
            })
          },
          options.signal,
        )
        engine = lease.engine
        throwIfCancelled(options.signal)
        notify({
          stage: 'processing',
          progress: 0.89,
          message: 'Retrying background removal…',
        })
      }
    }

    const refinement = await createMaskRefinement({
      quality,
      source,
      outputWidth: preparedImage.sourceWidth,
      outputHeight: preparedImage.sourceHeight,
      base: inference,
      signal: options.signal,
      onRefining: () => {
        notify({
          stage: 'processing',
          progress: 0.84,
          message: 'Refining fine details…',
        })
      },
      infer: (croppedSource) => inferMask(engine, croppedSource),
    })

    notify({ stage: 'finishing', progress: 0.92, message: 'Finishing edges…' })
    const image = await decodeImage(input, format)
    decodedImage = image
    throwIfCancelled(options.signal)
    const sourceBlob = format === 'heic' ? await imageToPng(image) : undefined
    throwIfCancelled(options.signal)
    const blob = await maskToPng(
      image,
      inference.alpha,
      inference.maskWidth,
      inference.maskHeight,
      quality,
      refinement,
    )
    throwIfCancelled(options.signal)
    notify({ stage: 'finishing', progress: 1, message: 'Background removed' })

    return {
      blob,
      sourceBlob,
      width: preparedImage.sourceWidth,
      height: preparedImage.sourceHeight,
      provider: engine.provider,
      model: engine.definition.name,
      quality,
      durationMs: Math.round(performance.now() - startedAt),
    }
  } catch (error) {
    throw normalizeError(error)
  } finally {
    decodedImage?.close()
    await lease?.release()
  }
}

async function getPreferredEngine(
  choices: EngineChoice[],
  onDownload: (
    progress: number,
    initializing: boolean,
    cached: boolean,
  ) => void,
  signal?: AbortSignal,
): Promise<EngineLease> {
  let lastError: unknown
  for (const choice of choices) {
    throwIfCancelled(signal)
    if (failedEngines.has(engineKey(choice))) continue
    const cached = await isModelCached(choice.definition)
    throwIfCancelled(signal)
    if (failedEngines.has(engineKey(choice))) continue
    try {
      return await getEngine(choice, (progress, initializing) => {
        onDownload(progress, initializing, cached)
      })
    } catch (error) {
      lastError = error
      // Leave the final lite WASM path retryable after a transient error.
      if (
        choice.provider === 'webgpu' ||
        choice.definition.name === 'birefnet'
      ) {
        rememberEngineFailure(choice)
      }
    }
  }
  throw modelLoadError(lastError)
}

async function getPreferredChoices(): Promise<EngineChoice[]> {
  detectedChoices ??= detectEngineChoices()
  const choices = await detectedChoices
  return choices.filter(
    (choice) => choice.provider !== 'webgpu' || canTryWebgpu(),
  )
}

async function isModelCached(model: ModelDefinition): Promise<boolean> {
  const url = modelUrl(model)
  try {
    if (typeof caches !== 'undefined') {
      return Boolean(await (await caches.open('transformers-cache')).match(url))
    }
    if (isIndexedDbAvailable()) {
      return Boolean(await createIndexedDbCache().match(url))
    }
  } catch {
    // A blocked cache should not prevent local inference.
  }
  return false
}

function rememberEngineFailure(choice: EngineChoice): void {
  failedEngines.add(engineKey(choice))
  // A large model failing must not disable the smaller model's GPU path.
  if (
    choice.provider === 'webgpu' &&
    choice.definition.name === 'birefnet-lite'
  ) {
    rememberWebgpuFailure()
  }
}

async function retireEngine(load: EngineLoad): Promise<void> {
  load.retired = true
  if (load.users > 0) return
  load.disposal ??= load.promise
    .then((engine) => engine.model.dispose())
    .then(() => undefined)
    .catch(() => undefined)
  await load.disposal
}

function canTryWebgpu(): boolean {
  if (!webgpuUsableForSession) return false
  try {
    return localStorage.getItem(WEBGPU_FAILURE_KEY) !== navigator.userAgent
  } catch {
    return true
  }
}

function rememberWebgpuFailure(): void {
  webgpuUsableForSession = false
  try {
    localStorage.setItem(WEBGPU_FAILURE_KEY, navigator.userAgent)
  } catch {
    // The current session still avoids repeating a known-bad WebGPU run.
  }
}

async function getEngine(
  choice: EngineChoice,
  onDownload: (progress: number, initializing: boolean) => void,
): Promise<EngineLease> {
  const key = engineKey(choice)
  let load = engineLoads.get(key)
  if (!load) {
    const listeners: EngineLoad['listeners'] = new Set()
    let currentLoad: EngineLoad
    const promise = loadEngine(choice, (progress, initializing) => {
      if (engineLoads.get(key) !== currentLoad) return
      currentLoad.progress = { progress, initializing }
      for (const listener of currentLoad.listeners) {
        notifyEngineProgress(listener, currentLoad.progress)
      }
    })
    currentLoad = { promise, listeners, users: 0, retired: false }
    load = currentLoad
    engineLoads.set(key, load)
  }

  // Reserve before awaiting initialization or notifying callers: a cache reset
  // must preserve pending acquisitions as well as active inference/refinement.
  const reservedLoad = load
  reservedLoad.users++
  let released = false
  const release = async () => {
    if (released) return
    released = true
    reservedLoad.users--
    if (reservedLoad.retired) await retireEngine(reservedLoad)
  }
  reservedLoad.listeners.add(onDownload)
  try {
    if (reservedLoad.progress) {
      notifyEngineProgress(onDownload, reservedLoad.progress)
    }
    const engine = await reservedLoad.promise
    if (engineLoads.get(key) === reservedLoad) reservedLoad.progress = undefined
    return {
      engine,
      retire: () => {
        if (engineLoads.get(key) === reservedLoad) engineLoads.delete(key)
        return retireEngine(reservedLoad)
      },
      release,
    }
  } catch (error) {
    if (engineLoads.get(key) === reservedLoad) engineLoads.delete(key)
    await release()
    throw error
  } finally {
    reservedLoad.listeners.delete(onDownload)
  }
}

function notifyEngineProgress(
  listener: (progress: number, initializing: boolean) => void,
  progress: EngineProgress,
): void {
  try {
    listener(progress.progress, progress.initializing)
  } catch {
    // Progress reporting is advisory and must not interrupt model loading.
  }
}

function modelLoadError(error: unknown) {
  return new BackgroundRemovalError(
    'model-load-failed',
    'The local model could not be loaded. Check your connection and try again.',
    { cause: error },
  )
}

async function inferMask(engine: Engine, source: unknown) {
  const processed = await engine.processor(source)
  const pixelValues = processed.pixel_values
  if (!pixelValues) throw new Error('Image preprocessing failed')
  const output = await engine.model({ input_image: pixelValues })
  const tensor = output.logits ?? output.output_image
  if (!tensor) throw new Error('The model returned no alpha mask')
  // Both exports emit logits, including the full model's output_image tensor.
  const alpha = tensor.sigmoid().data
  if (!(alpha instanceof Float32Array)) {
    throw new Error('The model returned an invalid alpha mask')
  }
  const maskHeight = tensor.dims.at(-2)
  const maskWidth = tensor.dims.at(-1)
  if (!maskWidth || !maskHeight) {
    throw new Error('The model returned an invalid mask shape')
  }
  return {
    alpha,
    maskWidth,
    maskHeight,
    inspection: inspectMask(alpha, maskWidth * maskHeight),
  }
}

/**
 * transformers.js reports progress per file, and the model is several files.
 * Reading each event directly makes the bar sprint to 100% and snap back for
 * the next file, and the tiny config files finish before the model file is
 * even announced. This weights every file by its size, treats the model file
 * as the bulk of the work, and never lets the figure go backwards.
 */
function createDownloadTracker(
  modelBytes: number,
  onDownload: (progress: number, initializing: boolean) => void,
) {
  const files = new Map<string, { loaded: number; total: number }>()
  let reported = 0

  const expectedTotal = (file: string, total: number | undefined) => {
    if (total && total > 0) return total
    return file.endsWith('.onnx') ? modelBytes : 4096
  }

  const report = () => {
    let loaded = 0
    let total = 0
    let sawModel = false
    for (const [file, entry] of files) {
      loaded += Math.min(entry.loaded, entry.total)
      total += entry.total
      if (file.endsWith('.onnx')) sawModel = true
    }
    // Until the model file is announced the small config files would read
    // as "done"; hold the bar back so it only moves forward.
    if (!sawModel) total += modelBytes
    const value = total > 0 ? loaded / total : 0
    if (value > reported) {
      reported = value
      onDownload(Math.min(1, value), false)
    }
  }

  return (event: unknown) => {
    if (!event || typeof event !== 'object') return
    const data = event as {
      status?: string
      file?: string
      loaded?: number
      total?: number
    }
    if (!data.file) return
    const current = files.get(data.file)
    if (data.status === 'initiate') {
      if (!current) {
        files.set(data.file, { loaded: 0, total: expectedTotal(data.file, 0) })
      }
    } else if (data.status === 'progress') {
      const total = expectedTotal(data.file, data.total)
      files.set(data.file, {
        loaded: Math.max(current?.loaded ?? 0, data.loaded ?? 0),
        total,
      })
    } else if (data.status === 'done') {
      const total = current?.total ?? expectedTotal(data.file, 0)
      files.set(data.file, { loaded: total, total })
    } else {
      return
    }
    report()
    if (data.status === 'done' && data.file.endsWith('.onnx')) {
      onDownload(1, true)
    }
  }
}

async function loadEngine(
  choice: EngineChoice,
  onDownload: (progress: number, initializing: boolean) => void,
): Promise<Engine> {
  const { provider, definition } = choice
  const { AutoModel, AutoProcessor, env } = await import(
    '@huggingface/transformers'
  )
  if (
    provider === 'wasm' &&
    typeof navigator !== 'undefined' &&
    env.backends.onnx.wasm &&
    shouldUseSingleThreadedWasm(navigator.userAgent, navigator.maxTouchPoints)
  ) {
    env.backends.onnx.wasm.numThreads = 1
  }
  // The Cache API only exists in secure contexts. Fall back to IndexedDB so
  // the model is still cached on plain-http previews and older browsers.
  if (typeof caches !== 'undefined') {
    env.useBrowserCache = true
  } else if (isIndexedDbAvailable()) {
    env.useBrowserCache = false
    env.useCustomCache = true
    env.customCache = createIndexedDbCache()
  } else {
    env.useBrowserCache = false
  }

  const progressCallback = createDownloadTracker(definition.bytes, onDownload)

  const processor = (await AutoProcessor.from_pretrained(definition.id, {
    revision: definition.revision,
    progress_callback: progressCallback,
  })) as unknown as ProcessorRunner

  const model = (await AutoModel.from_pretrained(definition.id, {
    revision: definition.revision,
    device: provider,
    dtype: 'fp16',
    progress_callback: progressCallback,
  })) as unknown as ModelRunner
  return { model, processor, ...choice }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BackgroundRemovalError('cancelled', 'Processing was cancelled.')
  }
}
