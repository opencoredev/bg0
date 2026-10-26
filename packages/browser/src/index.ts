import {
  clearIndexedDbCache,
  createIndexedDbCache,
  createSafeCache,
  isIndexedDbAvailable,
  lastReaderOf,
  type ModelCache,
  type SafeModelCache,
} from './cache'
import {
  createLoadWatch,
  type LoadWatch,
  ModelDownloadError,
  ModelStartTimeoutError,
  modelLoadTimings,
} from './download'
import { createFailureEvictions } from './eviction'
import { BackgroundRemovalError, normalizeError } from './errors'
import {
  blockFullModel,
  clearFullModelGuard,
  isFullModelBlocked,
  markFullModelRunning,
} from './guard'
import {
  decodeImage,
  imageToPng,
  inspectMask,
  maskToPng,
  prepareImageForInference,
  validateImage,
} from './image'
import { clearIosModel, prepareIosModel, removeIosBackground } from './ios'
import {
  choicesForTier,
  detectEngineChoices,
  type EngineChoice,
  type ExecutionProvider,
  engineKey,
  FULL_MODEL,
  LITE_MODEL,
  type ModelDefinition,
  type ModelTier,
  modelUrl,
  type RemovalModel,
} from './models'
import { createMaskRefinement, type InferenceMask } from './refinement'
import { canUseOnnxWebGpu, shouldUseSingleThreadedWasm } from './runtime'

function useIosModel() {
  return (
    typeof navigator !== 'undefined' &&
    shouldUseSingleThreadedWasm(navigator.userAgent, navigator.maxTouchPoints)
  )
}

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
export {
  type ExecutionProvider,
  MODEL_TIER_BYTES,
  MODEL_TIERS,
  type ModelTier,
  type RemovalModel,
} from './models'
export { shouldUseSingleThreadedWasm as isIosBrowser } from './runtime'

export interface RemovalProgress {
  stage: 'preparing' | 'downloading' | 'processing' | 'finishing'
  progress: number
  message: string
  /** Model bytes received so far. Present only while the model downloads. */
  download?: { loadedBytes: number; totalBytes: number }
  /** Execution provider, once the engine for this run has been chosen. */
  provider?: ExecutionProvider
  /** Model the run is loading or using, once its engine has been chosen. */
  model?: RemovalModel
}

export interface RemoveBackgroundOptions {
  quality?: RemovalQuality
  /** Which weights to use. Defaults to `auto`. Ignored on iPhone and iPad. */
  model?: ModelTier
  onProgress?: (progress: RemovalProgress) => void
  signal?: AbortSignal
}

export interface PrepareBackgroundRemovalOptions {
  /** Which weights to prepare. Defaults to `auto`. Ignored on iPhone and iPad. */
  model?: ModelTier
  /** Stops waiting. The shared load continues unless it becomes unwanted. */
  signal?: AbortSignal
}

export interface BackgroundRemovalResult {
  blob: Blob
  /** Displayable source PNG: always bounded on iOS; otherwise provided for HEIC/HEIF. */
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

type EngineProgress = {
  progress: number
  initializing: boolean
  loadedBytes: number
  totalBytes: number
}
type EngineProgressListener = (progress: EngineProgress) => void
type EngineLoad = {
  promise: Promise<Engine>
  listeners: Set<EngineProgressListener>
  progress?: EngineProgress
  users: number
  retired: boolean
  /**
   * The cached copy of the model this load read, for eviction. Unset until
   * the load has opened its model file, and left unset when the load joined
   * another load's read of the file; that load evicts the copy instead.
   */
  copy?: number
  disposal?: Promise<void>
  definition: ModelDefinition
  settled: boolean
  /** Aborts the load's requests and rejects it. */
  stop: AbortController
}

const MODEL_CACHE_NAME = 'transformers-cache'
const engineLoads = new Map<string, EngineLoad>()
const failedEngines = new Set<string>()
// A damaged cached model is evicted once, however many loads read it.
const corruptModels = createFailureEvictions(
  evictCachedModel,
  modelUrl,
  (model) => getModelCache()?.copy(modelUrl(model)) ?? 0,
)
let detectedChoices: Promise<EngineChoice[]> | undefined
let webgpuUsableForSession = true
// The tier the latest prepare or removal call asked for. While it is lite, a
// full-model download no caller waits on is stopped instead of finishing in
// the background and competing with the lite download for a slow connection.
let latestTier: ModelTier = 'auto'

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
  clearIosModel()
  for (const load of engineLoads.values()) {
    void retireEngine(load)
  }
  engineLoads.clear()
  failedEngines.clear()
  detectedChoices = undefined
  webgpuUsableForSession = true
  latestTier = 'auto'
  modelCache = undefined
  try {
    localStorage.removeItem(WEBGPU_FAILURE_KEY)
  } catch {
    // Storage can be unavailable in privacy modes. The in-memory reset remains useful.
  }
  clearFullModelGuard()
  void clearIndexedDbCache()
}

/**
 * Download and initialize the model before the first image is selected.
 * Concurrent calls share the same initialization work with removeBackground.
 */
export async function prepareBackgroundRemoval(
  options: PrepareBackgroundRemovalOptions = {},
): Promise<ExecutionProvider> {
  if (useIosModel()) {
    throwIfCancelled(options.signal)
    return untilCancelled(prepareIosModel(), options.signal)
  }
  const tier = requestTier(options.model)
  // A call that is already cancelled still records the tier, so choosing lite
  // stops an unwanted full download without starting another one.
  throwIfCancelled(options.signal)
  const lease = await getPreferredEngine(
    await getPreferredChoices(tier),
    () => undefined,
    options.signal,
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
  if (useIosModel()) return removeIosBackground(input, options)
  const startedAt = performance.now()
  const quality = options.quality ?? 'fast'
  const tier = requestTier(options.model)
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
    // Browsers without native HEIC decoding run the WASM decoder over the full
    // photo. Decode once and keep a compressed PNG for the remaining passes
    // instead of holding the decoded bitmap while the model initializes.
    let source = input
    let sourceFormat = format
    let sourceBlob: Blob | undefined
    if (format === 'heic') {
      const image = await decodeImage(input, format)
      try {
        throwIfCancelled(options.signal)
        sourceBlob = await imageToPng(image)
      } finally {
        image.close()
      }
      source = sourceBlob
      sourceFormat = 'png'
    }
    throwIfCancelled(options.signal)
    const choices = await getPreferredChoices(tier)
    throwIfCancelled(options.signal)
    const preparedImage = await prepareImageForInference(
      source,
      choices[0].definition.inputSize,
      choices[0].definition.inputSize,
      sourceFormat,
    )
    throwIfCancelled(options.signal)

    lease = await getPreferredEngine(
      choices,
      (load, modelIsCached, choice) => {
        const downloading = !modelIsCached && !load.initializing
        notify({
          stage: downloading ? 'downloading' : 'preparing',
          progress: 0.08 + load.progress * 0.58,
          message: load.initializing
            ? 'Starting local model…'
            : modelIsCached
              ? 'Loading cached model…'
              : 'Downloading local model…',
          provider: choice.provider,
          model: choice.definition.name,
          ...(downloading && load.totalBytes > 0
            ? {
                download: {
                  loadedBytes: load.loadedBytes,
                  totalBytes: load.totalBytes,
                },
              }
            : {}),
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
      provider: engine.provider,
      model: engine.definition.name,
    })
    const { RawImage } = await import('@huggingface/transformers')
    const modelInput = new RawImage(
      preparedImage.data,
      preparedImage.width,
      preparedImage.height,
      4,
    )
    let inference: InferenceMask
    while (true) {
      throwIfCancelled(options.signal)
      try {
        inference = await inferMask(engine, modelInput)
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
          (load, cached, choice) => {
            const downloading = !cached && !load.initializing
            notify({
              stage: downloading ? 'downloading' : 'preparing',
              progress: 0.74 + load.progress * 0.14,
              message: load.initializing
                ? 'Starting compatibility mode…'
                : 'Preparing compatibility mode…',
              provider: choice.provider,
              model: choice.definition.name,
              ...(downloading && load.totalBytes > 0
                ? {
                    download: {
                      loadedBytes: load.loadedBytes,
                      totalBytes: load.totalBytes,
                    },
                  }
                : {}),
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
          provider: engine.provider,
          model: engine.definition.name,
        })
      }
    }

    throwIfCancelled(options.signal)
    let highResSource: InstanceType<typeof RawImage> | undefined
    if (quality === 'quality') {
      try {
        throwIfCancelled(options.signal)
        const image = await decodeImage(source, sourceFormat)
        try {
          const maxDim = Math.max(image.width, image.height)
          const scale = maxDim > 1024 ? 1024 / maxDim : 1
          const w = Math.round(image.width * scale)
          const h = Math.round(image.height * scale)
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          try {
            const ctx = canvas.getContext('2d', { willReadFrequently: true })
            if (ctx) {
              ctx.drawImage(image, 0, 0, w, h)
              const data = ctx.getImageData(0, 0, w, h).data
              highResSource = new RawImage(data, w, h, 4)
            }
          } finally {
            canvas.width = 0
            canvas.height = 0
          }
        } finally {
          image.close()
        }
      } catch {
        throwIfCancelled(options.signal)
        // Refinement is optional; fallback to base source
      }
    }

    const refinement = await createMaskRefinement({
      quality,
      source: modelInput,
      highResSource,
      outputWidth: preparedImage.sourceWidth,
      outputHeight: preparedImage.sourceHeight,
      base: inference,
      signal: options.signal,
      onRefining: () => {
        notify({
          stage: 'processing',
          progress: 0.84,
          message: 'Refining fine details…',
          provider: engine.provider,
          model: engine.definition.name,
        })
      },
      infer: (croppedSource) => inferMask(engine, croppedSource),
    })

    notify({
      stage: 'finishing',
      progress: 0.92,
      message: 'Finishing edges…',
      provider: engine.provider,
      model: engine.definition.name,
    })
    const image = await decodeImage(source, sourceFormat)
    decodedImage = image
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
    notify({
      stage: 'finishing',
      progress: 1,
      message: 'Background removed',
      provider: engine.provider,
      model: engine.definition.name,
    })

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
    progress: EngineProgress,
    cached: boolean,
    choice: EngineChoice,
  ) => void,
  signal?: AbortSignal,
): Promise<EngineLease> {
  let lastError: unknown
  // A model whose download failed is not retried with another runtime in the
  // same walk: the file is shared, so the second attempt would fail the same way.
  const unreachableModels = new Set<string>()
  // Runtime files differ per provider, so their failure only skips that one.
  const unreachableProviders = new Set<ExecutionProvider>()
  // Engines this walk already reloaded after a corrupt cached model.
  const reloaded = new Set<string>()
  const queue = [...choices]
  for (let index = 0; index < queue.length; index += 1) {
    const choice = queue[index]
    throwIfCancelled(signal)
    const key = engineKey(choice)
    if (
      failedEngines.has(key) ||
      unreachableModels.has(choice.definition.id) ||
      unreachableProviders.has(choice.provider)
    )
      continue
    const cached = await isModelCached(choice.definition)
    throwIfCancelled(signal)
    if (failedEngines.has(key)) continue
    const attempt: EngineAttempt = {}
    try {
      return await getEngine(
        choice,
        (progress) => onDownload(progress, cached, choice),
        signal,
        attempt,
      )
    } catch (error) {
      throwIfCancelled(signal)
      lastError = error
      if (error instanceof ModelStartTimeoutError) {
        // The runtime queues session creation, so a start that never ends
        // would block every later choice too. Stop here and ask for a reload.
        rememberEngineFailure(choice)
        if (choice.definition.name === 'birefnet') blockFullModel()
        break
      }
      if (error instanceof ModelDownloadError) {
        // Network trouble says nothing about the GPU. Do not disable WebGPU.
        if (error.asset === 'runtime') {
          unreachableProviders.add(choice.provider)
          continue
        }
        // Stop re-downloading the large model in this session.
        unreachableModels.add(choice.definition.id)
        if (choice.definition.name === 'birefnet') failedEngines.add(key)
        continue
      }
      if (isCorruptModelError(error)) {
        // A damaged cached file fails every later load until it is replaced.
        // Retry once with a fresh download: for lite WASM there is no later
        // choice. A download that is corrupt again is not fetched a third time.
        await corruptModels.fail(choice.definition, attempt.load?.copy)
        throwIfCancelled(signal)
        if (reloaded.has(key)) {
          failedEngines.add(key)
        } else {
          reloaded.add(key)
          queue.splice(index + 1, 0, choice)
        }
        continue
      }
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

/** Record the tier a call asked for, and stop downloads it makes unwanted. */
function requestTier(tier: ModelTier = 'auto'): ModelTier {
  latestTier = tier
  for (const [key, load] of engineLoads) stopIfUnwanted(key, load)
  return tier
}

/**
 * Once lite is wanted, stop a full-model download no caller waits on, and
 * release a loaded full session no caller holds. Session creation is left to
 * finish: it cannot be interrupted, so the session is released once it ends.
 */
function stopIfUnwanted(key: string, load: EngineLoad): void {
  if (
    latestTier !== 'lite' ||
    load.definition.name !== 'birefnet' ||
    load.users > 0 ||
    (!load.settled && load.progress?.initializing)
  ) {
    return
  }
  if (engineLoads.get(key) === load) engineLoads.delete(key)
  if (load.settled) {
    // A loaded full session would otherwise stay in memory beside lite.
    void retireEngine(load)
    return
  }
  load.stop.abort(
    new BackgroundRemovalError(
      'cancelled',
      'The full model download stopped because lite was chosen.',
    ),
  )
}

async function getPreferredChoices(tier: ModelTier): Promise<EngineChoice[]> {
  detectedChoices ??= detectEngineChoices()
  const choices = choicesForTier(await detectedChoices, tier)
  const skipFullModel = await isFullModelBlocked()
  const usable = choices.filter(
    (choice) =>
      (choice.provider !== 'webgpu' || canTryWebgpu()) &&
      (choice.definition.name !== 'birefnet' || !skipFullModel),
  )
  // Detection always ends with lite WASM, but keep a usable path regardless.
  return usable.length > 0
    ? usable
    : [{ definition: LITE_MODEL, provider: 'wasm' }]
}

function isCorruptModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /protobuf|failed to load model|invalid model/i.test(message)
}

function expectedModelBytes(url: string): number | undefined {
  for (const definition of [LITE_MODEL, FULL_MODEL]) {
    if (url === modelUrl(definition)) return definition.bytes
  }
  return undefined
}

let modelCache: SafeModelCache | undefined

/** The cache transformers.js reads and writes, wrapped so it cannot fail a load. */
function getModelCache(): SafeModelCache | undefined {
  if (modelCache) return modelCache
  // The Cache API only exists in secure contexts. Fall back to IndexedDB so
  // the model is still cached on plain-http previews and older browsers.
  let open: (() => Promise<ModelCache | undefined>) | undefined
  const indexedDb = isIndexedDbAvailable() ? createIndexedDbCache() : undefined
  if (typeof caches !== 'undefined') {
    // Some browsers expose the Cache API but reject opening it, for example
    // in private windows. IndexedDB may still work there.
    open = () =>
      caches.open(MODEL_CACHE_NAME).catch((error: unknown) => {
        if (indexedDb) return indexedDb
        throw error
      })
  } else if (indexedDb) {
    open = async () => indexedDb
  }
  if (!open) return undefined
  modelCache = createSafeCache(open, expectedModelBytes)
  return modelCache
}

async function evictCachedModel(model: ModelDefinition): Promise<void> {
  try {
    await getModelCache()?.delete(modelUrl(model))
  } catch {
    // The retry still runs; a failed delete means it may read the old file.
  }
}

async function isModelCached(model: ModelDefinition): Promise<boolean> {
  try {
    return Boolean(await getModelCache()?.has(modelUrl(model)))
  } catch {
    // A blocked cache should not prevent local inference.
    return false
  }
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

/** Records which shared load a caller joined, so its failure can be named. */
type EngineAttempt = { load?: EngineLoad }

async function getEngine(
  choice: EngineChoice,
  onDownload: EngineProgressListener,
  signal?: AbortSignal,
  attempt?: EngineAttempt,
): Promise<EngineLease> {
  const key = engineKey(choice)
  let load = engineLoads.get(key)
  if (!load) {
    const listeners: EngineLoad['listeners'] = new Set()
    const stop = new AbortController()
    let currentLoad: EngineLoad
    const promise = loadEngine(
      choice,
      (progress) => {
        if (engineLoads.get(key) !== currentLoad) return
        currentLoad.progress = progress
        for (const listener of currentLoad.listeners) {
          notifyEngineProgress(listener, progress)
        }
      },
      () => {
        // Copy numbers are unique across cache instances, so a copy read
        // through a cache that has since been replaced never matches, and the
        // load evicts nothing.
        const url = modelUrl(choice.definition)
        currentLoad.copy ??= (
          lastReaderOf(url) ?? getModelCache()
        )?.copyLastRead(url)
      },
      stop.signal,
    )
    currentLoad = {
      promise,
      listeners,
      users: 0,
      retired: false,
      definition: choice.definition,
      settled: false,
      stop,
    }
    load = currentLoad
    engineLoads.set(key, load)
    const settle = () => {
      currentLoad.settled = true
      // A full session that finished starting after lite was chosen, with
      // nobody waiting on it, is released instead of kept.
      stopIfUnwanted(key, currentLoad)
    }
    promise.then(settle, settle)
    // A failed load must not be reused, even when every caller cancelled
    // before it settled.
    promise.catch((error) => {
      if (engineLoads.get(key) === currentLoad) engineLoads.delete(key)
      // The load evicts a damaged copy it read even when every caller has
      // cancelled: loads that joined its read cannot evict it themselves.
      // A caller still waiting shares this eviction.
      if (isCorruptModelError(error)) {
        void corruptModels.fail(choice.definition, currentLoad.copy)
      }
    })
  }

  // Reserve before awaiting initialization or notifying callers: a cache reset
  // must preserve pending acquisitions as well as active inference/refinement.
  const reservedLoad = load
  if (attempt) attempt.load = reservedLoad
  reservedLoad.users++
  let released = false
  const release = async () => {
    if (released) return
    released = true
    reservedLoad.users--
    if (reservedLoad.retired) await retireEngine(reservedLoad)
    else stopIfUnwanted(key, reservedLoad)
  }
  reservedLoad.listeners.add(onDownload)
  try {
    if (reservedLoad.progress) {
      notifyEngineProgress(onDownload, reservedLoad.progress)
    }
    // Cancelling stops this caller from waiting. The shared load continues
    // for other callers and for the next image.
    const engine = await untilCancelled(reservedLoad.promise, signal)
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
    if (!signal?.aborted && engineLoads.get(key) === reservedLoad) {
      engineLoads.delete(key)
    }
    await release()
    throw error
  } finally {
    reservedLoad.listeners.delete(onDownload)
  }
}

function untilCancelled<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise
  throwIfCancelled(signal)
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(
        new BackgroundRemovalError('cancelled', 'Processing was cancelled.'),
      )
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([promise, cancelled]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  })
}

function notifyEngineProgress(
  listener: EngineProgressListener,
  progress: EngineProgress,
): void {
  try {
    listener(progress)
  } catch {
    // Progress reporting is advisory and must not interrupt model loading.
  }
}

function modelLoadError(error: unknown) {
  let message =
    'The local model could not be loaded. Check your connection and try again.'
  if (error instanceof ModelStartTimeoutError) {
    message =
      'The local model took too long to start. Reload the page and try again.'
  } else if (
    error instanceof ModelDownloadError &&
    error.reason === 'stalled'
  ) {
    message =
      'The model download stopped responding. Check your connection and try again.'
  }
  return new BackgroundRemovalError('model-load-failed', message, {
    cause: error,
  })
}

async function inferMask(engine: Engine, source: unknown) {
  // Running the full model is where low-memory tabs get killed.
  const settle =
    engine.definition.name === 'birefnet' ? markFullModelRunning() : undefined
  try {
    return await runInference(engine, source)
  } finally {
    settle?.()
  }
}

async function runInference(engine: Engine, source: unknown) {
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
  onDownload: EngineProgressListener,
  onModelFileReady: () => void = () => undefined,
) {
  const files = new Map<string, { loaded: number; total: number }>()
  let reported = 0

  const expectedTotal = (file: string, total: number | undefined) => {
    if (total && total > 0) return total
    return file.endsWith('.onnx') ? modelBytes : 4096
  }

  const totals = () => {
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
    return { loaded, total }
  }

  const report = () => {
    const { loaded, total } = totals()
    const value = total > 0 ? loaded / total : 0
    if (value > reported) {
      reported = value
      onDownload({
        progress: Math.min(1, value),
        initializing: false,
        loadedBytes: loaded,
        totalBytes: total,
      })
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
      onModelFileReady()
      const { total } = totals()
      onDownload({
        progress: 1,
        initializing: true,
        loadedBytes: total,
        totalBytes: total,
      })
    }
  }
}

type TransformersEnv = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  useBrowserCache: boolean
  useCustomCache: boolean
  customCache: unknown
}

type WatchedLoad = { watch: LoadWatch; definition: ModelDefinition }
const watchedLoads = new Set<WatchedLoad>()
let networkFetch: TransformersEnv['fetch'] | undefined
let supervisedFetch: TransformersEnv['fetch'] | undefined

/**
 * Route every transformers.js request through the watchdog of the load that
 * made it. Model files carry the model id in their URL. Runtime files, such
 * as the ONNX Runtime binary, go to the newest load. A fetch installed on
 * `env` by the host page is kept as the underlying transport.
 */
function superviseFetch(env: TransformersEnv): TransformersEnv['fetch'] {
  if (!supervisedFetch || env.fetch !== supervisedFetch) {
    networkFetch = env.fetch
    supervisedFetch = (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      const loads = [...watchedLoads]
      const owner =
        loads.find((entry) => isModelFileUrl(url, entry.definition)) ??
        loads.at(-1)
      return owner ? owner.watch.fetch(input, init) : baseFetch(input, init)
    }
    env.fetch = supervisedFetch
  }
  return baseFetch
}

function isModelFileOpened(
  event: unknown,
  definition: ModelDefinition,
): boolean {
  if (typeof event !== 'object' || event === null) return false
  const { status, name, file } = event as Record<string, unknown>
  return (
    status === 'download' &&
    name === definition.id &&
    typeof file === 'string' &&
    modelUrl(definition).endsWith(`/${file}`)
  )
}

function isModelFileUrl(url: string, definition?: ModelDefinition): boolean {
  const definitions = definition ? [definition] : [LITE_MODEL, FULL_MODEL]
  return definitions.some((entry) => url.includes(`/${entry.id}/`))
}

function baseFetch(input: RequestInfo | URL, init?: RequestInit) {
  if (!networkFetch) return fetch(input, init)
  return networkFetch(input, init)
}

function configureModelCache(env: TransformersEnv): void {
  const cache = getModelCache()
  env.useBrowserCache = false
  env.useCustomCache = Boolean(cache)
  env.customCache = cache ?? null
}

async function loadEngine(
  choice: EngineChoice,
  onDownload: EngineProgressListener,
  onModelFileOpened: () => void,
  stop: AbortSignal,
): Promise<Engine> {
  const { provider, definition } = choice
  const { AutoModel, AutoProcessor, env } = await import(
    '@huggingface/transformers'
  )
  const transformersEnv = env as unknown as TransformersEnv
  configureModelCache(transformersEnv)
  const watch = createLoadWatch(superviseFetch(transformersEnv), {
    ...modelLoadTimings,
    expectedBytes: (url) =>
      url === modelUrl(definition) ? definition.bytes : undefined,
    // Model files carry the model id in their URL, as in `superviseFetch`.
    assetOf: (url) => (isModelFileUrl(url) ? 'model' : 'runtime'),
  })
  const watched = { watch, definition }
  watchedLoads.add(watched)
  let settleFullModel: (() => void) | undefined
  const progressCallback = createDownloadTracker(
    definition.bytes,
    onDownload,
    () => {
      // Session creation for the full model is where low-memory tabs die.
      if (definition.name === 'birefnet') {
        settleFullModel ??= markFullModelRunning()
      }
    },
  )
  const trackedProgress = (event: unknown) => {
    watch.touch()
    // Transformers.js reports `download` once it has chosen between the cache
    // and the network, before any other load can read the file.
    if (isModelFileOpened(event, definition)) onModelFileOpened()
    progressCallback(event)
  }

  let abandoned = false
  const pending = (async (): Promise<Engine> => {
    const processor = (await AutoProcessor.from_pretrained(definition.id, {
      revision: definition.revision,
      progress_callback: trackedProgress,
    })) as unknown as ProcessorRunner
    // A load stopped or timed out while the processor loaded must not go on
    // to fetch the weights: its watchdog no longer supervises the request.
    if (abandoned) throw new Error('The model load was abandoned')

    const model = (await AutoModel.from_pretrained(definition.id, {
      revision: definition.revision,
      device: provider,
      dtype: 'fp16',
      progress_callback: trackedProgress,
    })) as unknown as ModelRunner
    return { model, processor, ...choice }
  })()
  // A load that finishes after its watchdog gave up must not hold memory.
  pending.then(
    (engine) => {
      if (abandoned) void engine.model.dispose().catch(() => undefined)
    },
    () => undefined,
  )

  const stopped = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(stop.reason)
    if (stop.aborted) abort()
    else stop.addEventListener('abort', abort, { once: true })
  })
  stopped.catch(() => undefined)

  let failure: Error | undefined
  try {
    return await Promise.race([pending, watch.failed, stopped])
  } catch (error) {
    abandoned = true
    failure = error instanceof Error ? error : new Error('Model load failed.')
    if (
      error instanceof ModelStartTimeoutError ||
      error instanceof ModelDownloadError ||
      stop.aborted
    ) {
      throw error
    }
    // transformers.js may replace a failed request with its own error.
    throw watch.downloadFailure ?? error
  } finally {
    watch.dispose(failure)
    watchedLoads.delete(watched)
    if (abandoned) {
      // An abandoned load can still be creating the session, which is where
      // low-memory tabs die, so keep the marker until it really stops.
      const settle = () => settleFullModel?.()
      pending.then(settle, settle)
    } else {
      settleFullModel?.()
    }
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BackgroundRemovalError('cancelled', 'Processing was cancelled.')
  }
}
