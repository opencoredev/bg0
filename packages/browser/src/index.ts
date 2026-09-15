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
import { createMaskRefinement } from './refinement'
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
export type ExecutionProvider = 'webgpu' | 'wasm'

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
  quality: RemovalQuality
  durationMs: number
}

export interface BrowserCapabilities {
  webgpu: boolean
  wasm: boolean
}

const MODEL_ID = 'studioludens/birefnet-lite-512'
const MODEL_REVISION = '4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7'
const MODEL_BASE_URL = `https://huggingface.co/${MODEL_ID}/resolve/${MODEL_REVISION}`
const WEBGPU_FAILURE_KEY = `bg0:webgpu-failure:${MODEL_REVISION}`
// Size of onnx/model_fp16.onnx at the pinned revision, used to weight progress
// when a response arrives without a Content-Length.
const MODEL_BYTES = 98_484_532

type TensorLike = {
  data: Float32Array | Uint8Array | Int32Array | BigInt64Array
  dims: number[]
  sigmoid: () => TensorLike
}

type ModelOutput = { logits?: TensorLike; output_image?: TensorLike }
type ModelRunner = (input: Record<string, unknown>) => Promise<ModelOutput>
type ProcessorRunner = (image: unknown) => Promise<Record<string, unknown>>
type Engine = {
  model: ModelRunner
  processor: ProcessorRunner
  provider: ExecutionProvider
}

const enginePromises: Partial<Record<ExecutionProvider, Promise<Engine>>> = {}
const engineProgressListeners: Partial<
  Record<
    ExecutionProvider,
    Set<(progress: number, initializing: boolean) => void>
  >
> = {}
const engineProgress: Partial<
  Record<ExecutionProvider, { progress: number; initializing: boolean }>
> = {}
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
  enginePromises.webgpu = undefined
  enginePromises.wasm = undefined
  engineProgress.webgpu = undefined
  engineProgress.wasm = undefined
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
  const engine = await getPreferredEngine(
    getPreferredProvider(),
    () => undefined,
  )
  return engine.provider
}

export async function removeBackground(
  input: Blob,
  options: RemoveBackgroundOptions = {},
): Promise<BackgroundRemovalResult> {
  const startedAt = performance.now()
  const quality = options.quality ?? 'fast'
  const notify = options.onProgress ?? (() => undefined)
  let decodedImage: ImageBitmap | undefined

  try {
    throwIfCancelled(options.signal)
    const format = await validateImage(input)
    notify({ stage: 'preparing', progress: 0.03, message: 'Preparing image…' })
    const preparedImage = await prepareImageForInference(
      input,
      512,
      512,
      format,
    )
    throwIfCancelled(options.signal)

    const preferredProvider = getPreferredProvider()
    const modelIsCached = await isModelCached()
    let engine = await getPreferredEngine(
      preferredProvider,
      (progress, initializing) => {
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
    )
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
    let inference = await runInference(engine, source)

    if (
      engine.provider === 'webgpu' &&
      (!inference.inspection.valid || !inference.inspection.hasForegroundSignal)
    ) {
      rememberWebgpuFailure()
      throwIfCancelled(options.signal)
      notify({
        stage: 'downloading',
        progress: 0.74,
        message: 'Switching to compatibility mode…',
      })
      engine = await getEngine('wasm', (progress, initializing) => {
        notify({
          stage: initializing ? 'preparing' : 'downloading',
          progress: 0.74 + progress * 0.14,
          message: initializing
            ? 'Starting compatibility mode…'
            : 'Preparing compatibility mode…',
        })
      })
      throwIfCancelled(options.signal)
      notify({
        stage: 'processing',
        progress: 0.89,
        message: 'Retrying background removal…',
      })
      inference = await runInference(engine, source)
    }

    if (!inference.inspection.valid) {
      throw new Error('The model returned an invalid alpha mask')
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
      infer: (croppedSource) => runInference(engine, croppedSource),
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
      quality,
      durationMs: Math.round(performance.now() - startedAt),
    }
  } catch (error) {
    throw normalizeError(error)
  } finally {
    decodedImage?.close()
  }
}

async function getPreferredEngine(
  preferred: ExecutionProvider,
  onDownload: (progress: number, initializing: boolean) => void,
): Promise<Engine> {
  try {
    return await getEngine(preferred, onDownload)
  } catch (error) {
    if (preferred === 'webgpu') {
      rememberWebgpuFailure()
      try {
        return await getEngine('wasm', onDownload)
      } catch (fallbackError) {
        throw modelLoadError(fallbackError)
      }
    }
    throw modelLoadError(error)
  }
}

function getPreferredProvider(): ExecutionProvider {
  return getBrowserCapabilities().webgpu && canTryWebgpu() ? 'webgpu' : 'wasm'
}

async function isModelCached(): Promise<boolean> {
  const url = `${MODEL_BASE_URL}/onnx/model_fp16.onnx`
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
  provider: ExecutionProvider,
  onDownload: (progress: number, initializing: boolean) => void,
): Promise<Engine> {
  const existingPromise = enginePromises[provider]
  let listeners = engineProgressListeners[provider]
  if (!listeners) {
    listeners = new Set()
    engineProgressListeners[provider] = listeners
  }
  listeners.add(onDownload)
  let enginePromise = existingPromise
  if (enginePromise) {
    const latest = engineProgress[provider]
    if (latest) onDownload(latest.progress, latest.initializing)
  } else {
    enginePromise = loadEngine(
      provider,
      (progress, initializing) => {
        engineProgress[provider] = { progress, initializing }
        for (const listener of listeners) listener(progress, initializing)
      },
    )
    enginePromises[provider] = enginePromise
  }
  try {
    const engine = await enginePromise
    if (enginePromises[provider] === enginePromise) {
      engineProgress[provider] = undefined
    }
    return engine
  } catch (error) {
    if (enginePromises[provider] === enginePromise) {
      enginePromises[provider] = undefined
      engineProgress[provider] = undefined
    }
    throw error
  } finally {
    listeners.delete(onDownload)
  }
}

function modelLoadError(error: unknown) {
  return new BackgroundRemovalError(
    'model-load-failed',
    'The local model could not be loaded. Check your connection and try again.',
    { cause: error },
  )
}

async function runInference(engine: Engine, source: unknown) {
  const processed = await engine.processor(source)
  const pixelValues = processed.pixel_values
  if (!pixelValues) throw new Error('Image preprocessing failed')
  const output = await engine.model({ input_image: pixelValues })
  const tensor = output.logits ?? output.output_image
  if (!tensor) throw new Error('The model returned no alpha mask')
  const alpha = (output.logits ? tensor.sigmoid() : tensor).data
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
  onDownload: (progress: number, initializing: boolean) => void,
) {
  const files = new Map<string, { loaded: number; total: number }>()
  let reported = 0

  const expectedTotal = (file: string, total: number | undefined) => {
    if (total && total > 0) return total
    return file.endsWith('.onnx') ? MODEL_BYTES : 4096
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
    if (!sawModel) total += MODEL_BYTES
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
  provider: ExecutionProvider,
  onDownload: (progress: number, initializing: boolean) => void,
): Promise<Engine> {
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

  const progressCallback = createDownloadTracker(onDownload)

  const processor = (await AutoProcessor.from_pretrained(MODEL_ID, {
    revision: MODEL_REVISION,
    progress_callback: progressCallback,
  })) as unknown as ProcessorRunner

  const model = (await AutoModel.from_pretrained(MODEL_ID, {
    revision: MODEL_REVISION,
    device: provider,
    dtype: 'fp16',
    progress_callback: progressCallback,
  })) as unknown as ModelRunner
  return { model, processor, provider }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BackgroundRemovalError('cancelled', 'Processing was cancelled.')
  }
}
