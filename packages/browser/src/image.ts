import { BackgroundRemovalError } from './errors'

export const MAX_IMAGE_BYTES = 40 * 1024 * 1024
const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export function validateImage(input: Blob): void {
  if (!SUPPORTED_TYPES.has(input.type)) {
    throw new BackgroundRemovalError(
      'unsupported-image',
      'Choose a PNG, JPG, or WebP image.',
    )
  }
  if (input.size > MAX_IMAGE_BYTES) {
    throw new BackgroundRemovalError(
      'image-too-large',
      'This image is over 40 MB. Choose a smaller file.',
    )
  }
}

export async function decodeImage(input: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(input, { imageOrientation: 'from-image' })
  } catch (error) {
    throw new BackgroundRemovalError(
      'decode-failed',
      'This image could not be opened. Try exporting it as PNG or JPG.',
      { cause: error },
    )
  }
}

export interface PreparedInferenceImage {
  data: Uint8ClampedArray
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
}

/**
 * Decode the source before the model is loaded, then immediately reduce it to
 * the model's fixed input size. Keeping a full-resolution phone photo alive
 * while ONNX initializes can push memory-constrained browsers over their tab
 * limit even when the compressed upload itself is small.
 */
export async function prepareImageForInference(
  input: Blob,
  width = 512,
  height = 512,
): Promise<PreparedInferenceImage> {
  const image = await decodeImage(input)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas is unavailable')
    context.drawImage(image, 0, 0, width, height)
    const data = context.getImageData(0, 0, width, height).data

    // Release the canvas backing store as soon as its pixels have been copied.
    canvas.width = 0
    canvas.height = 0

    return {
      data,
      width,
      height,
      sourceWidth: image.width,
      sourceHeight: image.height,
    }
  } finally {
    image.close()
  }
}

export interface MaskInspection {
  valid: boolean
  hasForegroundSignal: boolean
}

/**
 * WebGPU can complete without throwing while returning a corrupt, flat mask on
 * some browser/GPU combinations. Inspect the tensor before it reaches canvas
 * compositing so callers can retry with the compatibility provider.
 */
export function inspectMask(
  mask: Float32Array,
  expectedPixels: number,
): MaskInspection {
  if (mask.length !== expectedPixels || mask.length === 0) {
    return { valid: false, hasForegroundSignal: false }
  }

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const value of mask) {
    if (!Number.isFinite(value)) {
      return { valid: false, hasForegroundSignal: false }
    }
    min = Math.min(min, value)
    max = Math.max(max, value)
  }

  return {
    valid: true,
    hasForegroundSignal: max >= 0.05 && max - min >= 0.005,
  }
}

export function maskToPng(
  image: ImageBitmap,
  mask: Float32Array,
  maskWidth: number,
  maskHeight: number,
  quality: 'fast' | 'quality',
): Promise<Blob> {
  const maskCanvas = document.createElement('canvas')
  maskCanvas.width = maskWidth
  maskCanvas.height = maskHeight
  const maskContext = maskCanvas.getContext('2d')
  if (!maskContext) throw new Error('Canvas is unavailable')

  const pixels = maskContext.createImageData(maskWidth, maskHeight)
  for (let index = 0; index < mask.length; index += 1) {
    const alpha =
      quality === 'quality' ? mask[index] : smoothstep(0.08, 0.92, mask[index])
    const offset = index * 4
    pixels.data[offset] = 255
    pixels.data[offset + 1] = 255
    pixels.data[offset + 2] = 255
    pixels.data[offset + 3] = Math.round(alpha * 255)
  }
  maskContext.putImageData(pixels, 0, 0)

  const output = document.createElement('canvas')
  output.width = image.width
  output.height = image.height
  const context = output.getContext('2d')
  if (!context) throw new Error('Canvas is unavailable')
  context.drawImage(image, 0, 0)
  context.globalCompositeOperation = 'destination-in'
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = quality === 'quality' ? 'high' : 'medium'
  context.drawImage(maskCanvas, 0, 0, image.width, image.height)

  return new Promise((resolve, reject) => {
    output.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG export failed'))),
      'image/png',
    )
  })
}

function smoothstep(min: number, max: number, value: number): number {
  const x = Math.max(0, Math.min(1, (value - min) / (max - min)))
  return x * x * (3 - 2 * x)
}
