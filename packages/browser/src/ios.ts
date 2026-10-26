import { BackgroundRemovalError, normalizeError } from './errors'
import {
  imageToPng,
  inspectMask,
  maskToPng,
  prepareBoundedImage,
  validateImage,
  findRefinementCrop,
  type MaskRefinement,
} from './image'
import type { BackgroundRemovalResult, RemoveBackgroundOptions } from './index'
import { iosOutputSize, normalizeIosPixels } from './ios-pixels'

// Separate runtime: never initializes Transformers.js/WebGPU on this path.
// Calls are serialized so two library callers cannot overlap activation heaps.
let queue: Promise<unknown> = Promise.resolve()
let cached: IosWorker | undefined
let active: IosWorker | undefined
// Calls queued behind the running one. When none are waiting after inference,
// the worker is released so its WASM heap (which never shrinks, roughly 1 GB
// after one inference) does not stay alive while the PNG is encoded or while
// the next photo is decoded.
let waiting = 0
function serialize<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        new BackgroundRemovalError('cancelled', 'Processing was cancelled.'),
      )
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    waiting += 1
    // Reject a queued caller immediately without releasing the active queue slot.
    // The skipped slot must still wait for earlier work to prevent overlapping heaps.
    queue = queue.then(async () => {
      waiting -= 1
      signal?.removeEventListener('abort', abort)
      try {
        if (signal?.aborted) return
        resolve(await operation())
      } catch (error) {
        reject(error)
      } finally {
        retireIdleWorker()
      }
    })
  })
}
// A call that kept the worker for a queued photo cannot know whether that
// photo will be cancelled or fail before inference, so the queue releases an
// inference-sized heap once nothing is running or waiting. A preloaded worker
// that has not run yet is kept.
function retireIdleWorker() {
  if (waiting > 0 || active || !cached?.hasRun) return
  const idle = cached
  cached = undefined
  idle.dispose()
}
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new BackgroundRemovalError('cancelled', 'Processing was cancelled.')
}
// Decoding and PNG encoding run outside the worker, so terminating it cannot
// stop them. Reject on abort instead, so a hung stage cannot hold the queue
// and block a retry. A result that arrives after the abort is released and
// never reaches later work.
function unlessAborted<T>(
  task: Promise<T>,
  signal?: AbortSignal,
  release?: (value: T) => void,
): Promise<T> {
  if (!signal) return task
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        new BackgroundRemovalError('cancelled', 'Processing was cancelled.'),
      )
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    task.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        if (signal.aborted) release?.(value)
        else resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}
function engine() {
  if (!cached || cached.isDisposed) cached = new IosWorker()
  return cached
}

export function clearIosModel(): void {
  const old = cached
  cached = undefined
  if (old !== active) old?.dispose()
}

export function prepareIosModel(): Promise<'wasm'> {
  return serialize(async () => {
    const worker = engine()
    active = worker
    try {
      await worker.load()
      return 'wasm' as const
    } catch (error) {
      if (cached === worker) cached = undefined
      throw normalizeError(error)
    } finally {
      active = undefined
      if (cached !== worker) worker.dispose()
    }
  })
}

export function removeIosBackground(
  input: Blob,
  options: RemoveBackgroundOptions,
): Promise<BackgroundRemovalResult> {
  return serialize(async () => {
    const started = performance.now()
    const quality = options.quality ?? 'fast'
    let bitmap: ImageBitmap | undefined
    let worker: IosWorker | undefined
    let progress = 0
    const notify = (
      stage: 'preparing' | 'downloading' | 'processing' | 'finishing',
      value: number,
      message: string,
    ) => {
      progress = Math.max(progress, value)
      options.onProgress?.({
        stage,
        progress,
        message,
        provider: 'wasm',
        model: 'birefnet-lite',
      })
    }
    const abort = () => {
      worker?.dispose(
        new BackgroundRemovalError('cancelled', 'Processing was cancelled.'),
      )
      if (cached === worker) cached = undefined
    }
    try {
      cancelled(options.signal)
      options.signal?.addEventListener('abort', abort, { once: true })
      const format = await unlessAborted(validateImage(input), options.signal)
      notify('preparing', 0.03, 'Preparing image…')
      cancelled(options.signal)
      // Decode once. Keep only the 512px model input and a copy bounded to the
      // output size; the full-resolution bitmap is closed before model load.
      const prepared = await unlessAborted(
        prepareBoundedImage(input, 512, iosOutputSize, format),
        options.signal,
        (late) => late.bounded.close(),
      )
      bitmap = prepared.bounded
      cancelled(options.signal)
      worker = engine()
      active = worker
      worker.onStage = (stage, value = 0) =>
        notify(
          stage === 'loading' ? 'downloading' : 'preparing',
          stage === 'loading' ? 0.08 + 0.5 * value : 0.6,
          stage === 'loading'
            ? 'Downloading local model…'
            : 'Starting local model…',
        )
      await worker.load()
      cancelled(options.signal)
      notify('processing', 0.7, 'Removing background…')
      const alpha = await worker.run(prepared.data)
      cancelled(options.signal)
      if (!inspectMask(alpha, 512 * 512).valid)
        throw new Error('Invalid alpha mask')
      const output = iosOutputSize(prepared.sourceWidth, prepared.sourceHeight)
      let refinement: MaskRefinement | undefined
      if (quality === 'quality') {
        const crop = findRefinementCrop(alpha, 512, 512, 512, 512)
        if (crop) {
          notify('processing', 0.84, 'Refining fine details…')
          // Optional second pass uses only the small prepared image, never full-photo pixels.
          const sourceCanvas = document.createElement('canvas')
          const cropCanvas = document.createElement('canvas')
          try {
            sourceCanvas.width =
              sourceCanvas.height =
              cropCanvas.width =
              cropCanvas.height =
                512
            const context = sourceCanvas.getContext('2d')
            const cropped = cropCanvas.getContext('2d', {
              willReadFrequently: true,
            })
            if (!context || !cropped) throw new Error('Canvas unavailable')
            context.putImageData(
              new ImageData(new Uint8ClampedArray(prepared.data), 512, 512),
              0,
              0,
            )
            cropped.drawImage(
              sourceCanvas,
              crop.left,
              crop.top,
              crop.right - crop.left,
              crop.bottom - crop.top,
              0,
              0,
              512,
              512,
            )
            const mask = await worker.run(
              cropped.getImageData(0, 0, 512, 512).data,
            )
            if (inspectMask(mask, 512 * 512).hasForegroundSignal)
              refinement = {
                mask,
                maskWidth: 512,
                maskHeight: 512,
                crop: {
                  left: Math.floor((crop.left * output.width) / 512),
                  top: Math.floor((crop.top * output.height) / 512),
                  right: Math.ceil((crop.right * output.width) / 512),
                  bottom: Math.ceil((crop.bottom * output.height) / 512),
                },
              }
          } catch {
            if (worker.isDisposed && cached === worker) cached = undefined
            cancelled(options.signal)
          } finally {
            sourceCanvas.width =
              sourceCanvas.height =
              cropCanvas.width =
              cropCanvas.height =
                0
          }
        }
      }
      cancelled(options.signal)
      if (waiting === 0 && cached === worker) {
        // Free the model heap before encoding. A later call starts a new worker.
        cached = undefined
        worker.dispose()
      }
      notify('finishing', 0.92, 'Finishing edges…')
      // Bounded original for Compare: don't decode the original camera photo again in the UI.
      // Both encoders draw the bitmap before awaiting, so closing it after an
      // abort is safe. Each releases its own canvases when it settles, and an
      // abort settles it even if toBlob never calls back.
      const sourceBlob = await unlessAborted(
        imageToPng(bitmap, options.signal),
        options.signal,
      )
      const blob = await unlessAborted(
        maskToPng(bitmap, alpha, 512, 512, quality, refinement, options.signal),
        options.signal,
      )
      cancelled(options.signal)
      notify('finishing', 1, 'Background removed')
      return {
        blob,
        sourceBlob,
        width: output.width,
        height: output.height,
        model: 'birefnet-lite',
        provider: 'wasm',
        quality,
        durationMs: Math.round(performance.now() - started),
      }
    } catch (error) {
      if (worker && cached === worker) cached = undefined
      cancelled(options.signal)
      throw normalizeError(error)
    } finally {
      options.signal?.removeEventListener('abort', abort)
      bitmap?.close()
      active = undefined
      if (worker) {
        worker.onStage = undefined
        if (cached !== worker) worker.dispose()
      }
    }
  }, options.signal)
}

export interface IosWorkerTimeouts {
  /** Longest silence allowed while the model downloads and starts. */
  loadIdleMs?: number
  /** Longest single inference allowed before the worker is treated as hung. */
  runMs?: number
}

const LOAD_IDLE_MS = 90_000
const RUN_MS = 120_000

function workerError(code: string): BackgroundRemovalError {
  if (code === 'out-of-memory')
    return new BackgroundRemovalError(
      'out-of-memory',
      'Safari ran out of memory for this image. Close other tabs and try again, or try a smaller image or a desktop browser.',
    )
  if (code === 'model-load-failed')
    return new BackgroundRemovalError(
      'model-load-failed',
      'The local model could not be loaded. Check your connection and try again.',
    )
  return new BackgroundRemovalError(
    'inference-failed',
    'Local processing could not finish. Try a smaller image.',
  )
}

export class IosWorker {
  private worker: Worker
  private nextId = 0
  private pending = new Map<
    number,
    {
      type: 'load' | 'run'
      resolve: (value: { alpha?: ArrayBuffer }) => void
      reject: (error: Error) => void
      timer?: ReturnType<typeof setTimeout>
    }
  >()
  private loaded?: Promise<void>
  private dead = false
  /** True once an inference has grown the worker heap. */
  hasRun = false
  private readonly loadIdleMs: number
  private readonly runMs: number
  onStage?: (stage: string, progress?: number) => void
  constructor(
    createWorker = () =>
      new Worker(new URL('./vendor/ios/worker.mjs', import.meta.url), {
        type: 'module',
      }),
    timeouts: IosWorkerTimeouts = {},
  ) {
    this.loadIdleMs = timeouts.loadIdleMs ?? LOAD_IDLE_MS
    this.runMs = timeouts.runMs ?? RUN_MS
    this.worker = createWorker()
    this.worker.onmessage = ({ data }) => {
      if (data.stage) {
        // Any sign of life during load restarts the load watchdog.
        for (const [id, request] of this.pending)
          if (request.type === 'load') this.watch(id)
        this.onStage?.(
          data.stage,
          typeof data.progress === 'number' ? data.progress : undefined,
        )
        return
      }
      const request = this.pending.get(data.id)
      if (!request) return
      clearTimeout(request.timer)
      this.pending.delete(data.id)
      if (data.error) request.reject(workerError(data.error))
      else request.resolve(data)
    }
    this.worker.onerror = () => {
      const running = [...this.pending.values()].some(
        (request) => request.type === 'run',
      )
      this.dispose(
        running
          ? new BackgroundRemovalError(
              'inference-failed',
              'Local processing stopped. Try again, or try a smaller image or a desktop browser.',
            )
          : new BackgroundRemovalError(
              'model-load-failed',
              'The local model stopped. Please try again.',
            ),
      )
    }
    this.worker.onmessageerror = () =>
      this.dispose(new Error('Worker response unavailable'))
  }
  get isDisposed(): boolean {
    return this.dead
  }
  load(): Promise<void> {
    this.loaded ??= this.request('load').then(() => undefined)
    return this.loaded
  }
  async run(pixels: Uint8ClampedArray): Promise<Float32Array> {
    const buffer = normalizeIosPixels(pixels, 512, 512).buffer as ArrayBuffer
    this.hasRun = true
    const result = await this.request('run', buffer)
    if (!result.alpha || result.alpha.byteLength !== 512 * 512 * 4)
      throw new Error('Invalid mask shape')
    return new Float32Array(result.alpha)
  }
  /** (Re)arm the watchdog so a worker that never answers cannot hang the page. */
  private watch(id: number) {
    const request = this.pending.get(id)
    if (!request) return
    clearTimeout(request.timer)
    const load = request.type === 'load'
    request.timer = setTimeout(
      () =>
        this.dispose(
          load
            ? new BackgroundRemovalError(
                'model-load-failed',
                'The local model stopped responding. Check your connection and try again.',
              )
            : new BackgroundRemovalError(
                'inference-failed',
                'Local processing stopped responding. Try again, or try a smaller image or a desktop browser.',
              ),
        ),
      load ? this.loadIdleMs : this.runMs,
    )
  }
  private request(
    type: 'load' | 'run',
    buffer?: ArrayBuffer,
  ): Promise<{ alpha?: ArrayBuffer }> {
    if (this.dead) return Promise.reject(new Error('Worker stopped'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { type, resolve, reject })
      try {
        this.worker.postMessage({ id, type, buffer }, buffer ? [buffer] : [])
        this.watch(id)
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  dispose(error = new Error('Worker stopped')) {
    if (this.dead) return
    this.dead = true
    this.worker.terminate()
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
}
