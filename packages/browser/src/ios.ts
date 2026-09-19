import { BackgroundRemovalError, normalizeError } from './errors'
import {
  decodeImage,
  imageToPng,
  inspectMask,
  maskToPng,
  prepareImageForInference,
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
    // Reject a queued caller immediately without releasing the active queue slot.
    // The skipped slot must still wait for earlier work to prevent overlapping heaps.
    queue = queue.then(async () => {
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) return
      try {
        resolve(await operation())
      } catch (error) {
        reject(error)
      }
    })
  })
}
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new BackgroundRemovalError('cancelled', 'Processing was cancelled.')
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
      options.onProgress?.({ stage, progress, message })
    }
    const abort = () => {
      worker?.dispose(
        new BackgroundRemovalError('cancelled', 'Processing was cancelled.'),
      )
      if (cached === worker) cached = undefined
    }
    try {
      cancelled(options.signal)
      const format = await validateImage(input)
      notify('preparing', 0.03, 'Preparing image…')
      // Close the original bitmap before loading weights. Retain only 512px RGBA.
      const prepared = await prepareImageForInference(input, 512, 512, format)
      cancelled(options.signal)
      worker = engine()
      active = worker
      options.signal?.addEventListener('abort', abort, { once: true })
      cancelled(options.signal)
      worker.onStage = (stage) =>
        notify(
          stage === 'loading' ? 'downloading' : 'preparing',
          stage === 'loading' ? 0.08 : 0.6,
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
      notify('finishing', 0.92, 'Finishing edges…')
      bitmap = await decodeImage(input, format)
      if (bitmap.width !== output.width || bitmap.height !== output.height) {
        const resized = await createImageBitmap(bitmap, {
          resizeWidth: output.width,
          resizeHeight: output.height,
          resizeQuality: 'high',
        })
        bitmap.close()
        bitmap = resized
      }
      cancelled(options.signal)
      // Bounded original for Compare: don't decode the original camera photo again in the UI.
      const sourceBlob = await imageToPng(bitmap)
      const blob = await maskToPng(bitmap, alpha, 512, 512, quality, refinement)
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

export class IosWorker {
  private worker: Worker
  private nextId = 0
  private pending = new Map<
    number,
    {
      resolve: (value: { alpha?: ArrayBuffer }) => void
      reject: (error: Error) => void
    }
  >()
  private loaded?: Promise<void>
  private dead = false
  onStage?: (stage: string) => void
  constructor(
    createWorker = () =>
      new Worker(new URL('./vendor/ios/worker.mjs', import.meta.url), {
        type: 'module',
      }),
  ) {
    this.worker = createWorker()
    this.worker.onmessage = ({ data }) => {
      if (data.stage) {
        this.onStage?.(data.stage)
        return
      }
      const request = this.pending.get(data.id)
      if (!request) return
      this.pending.delete(data.id)
      if (data.error)
        request.reject(
          new BackgroundRemovalError(
            data.error === 'model-load-failed'
              ? 'model-load-failed'
              : 'inference-failed',
            data.error === 'model-load-failed'
              ? 'The local model could not be loaded. Check your connection and try again.'
              : 'Local processing could not finish. Try a smaller image.',
          ),
        )
      else request.resolve(data)
    }
    this.worker.onerror = () =>
      this.dispose(
        new BackgroundRemovalError(
          'model-load-failed',
          'The local model stopped. Please try again.',
        ),
      )
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
    const result = await this.request('run', buffer)
    if (!result.alpha || result.alpha.byteLength !== 512 * 512 * 4)
      throw new Error('Invalid mask shape')
    return new Float32Array(result.alpha)
  }
  private request(
    type: 'load' | 'run',
    buffer?: ArrayBuffer,
  ): Promise<{ alpha?: ArrayBuffer }> {
    if (this.dead) return Promise.reject(new Error('Worker stopped'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.worker.postMessage({ id, type, buffer }, buffer ? [buffer] : [])
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
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
  }
}
