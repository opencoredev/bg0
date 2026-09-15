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

export interface MaskInspection {
  valid: boolean
  hasForegroundSignal: boolean
}

export interface CropBounds {
  left: number
  top: number
  right: number
  bottom: number
}

export interface MaskRefinement {
  mask: Float32Array
  maskWidth: number
  maskHeight: number
  crop: CropBounds
}

const FOREGROUND_THRESHOLD = 0.1
const REFINEMENT_PADDING_RATIO = 0.12
const MAX_REFINEMENT_AREA_RATIO = 0.85
const LOW_ZOOM_AREA_RATIO = 0.8
const MIN_LOW_ZOOM_FOREGROUND_DENSITY = 0.4

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

/**
 * A 512px model wastes most of its detail budget when the subject is small in
 * the source image. Find a padded subject crop for one focused quality pass.
 * Full-frame subjects return null so they do not pay for duplicate inference.
 */
export function findRefinementCrop(
  mask: Float32Array,
  maskWidth: number,
  maskHeight: number,
  imageWidth: number,
  imageHeight: number,
): CropBounds | null {
  let minX = maskWidth
  let minY = maskHeight
  let maxX = -1
  let maxY = -1
  let foregroundPixels = 0

  for (let y = 0; y < maskHeight; y += 1) {
    for (let x = 0; x < maskWidth; x += 1) {
      if (mask[y * maskWidth + x] < FOREGROUND_THRESHOLD) continue
      foregroundPixels += 1
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }

  if (maxX < minX || maxY < minY) return null

  const scaleX = imageWidth / maskWidth
  const scaleY = imageHeight / maskHeight
  let left = Math.floor(minX * scaleX)
  let top = Math.floor(minY * scaleY)
  let right = Math.ceil((maxX + 1) * scaleX)
  let bottom = Math.ceil((maxY + 1) * scaleY)
  const padding = Math.ceil(
    Math.max(right - left, bottom - top) * REFINEMENT_PADDING_RATIO,
  )
  left = Math.max(0, left - padding)
  top = Math.max(0, top - padding)
  right = Math.min(imageWidth, right + padding)
  bottom = Math.min(imageHeight, bottom + padding)

  const cropWidth = right - left
  const cropHeight = bottom - top
  const cropArea = cropWidth * cropHeight
  const imageArea = imageWidth * imageHeight
  if (cropWidth < 32 || cropHeight < 32) return null
  if (cropArea >= imageArea * MAX_REFINEMENT_AREA_RATIO) return null

  // A crop this large provides little extra model resolution. Sparse subjects
  // in that range (for example, thin eyeglass frames) can lose edge pixels on
  // a second pass, while dense subjects can still benefit from corrected
  // framing along one axis.
  const foregroundArea = foregroundPixels * scaleX * scaleY
  if (
    cropArea >= imageArea * LOW_ZOOM_AREA_RATIO &&
    foregroundArea / cropArea < MIN_LOW_ZOOM_FOREGROUND_DENSITY
  ) {
    return null
  }

  return { left, top, right, bottom }
}

export function maskToPng(
  image: ImageBitmap,
  mask: Float32Array,
  maskWidth: number,
  maskHeight: number,
  quality: 'fast' | 'quality',
  refinement?: MaskRefinement,
): Promise<Blob> {
  let maskCanvas = alphaCanvas(mask, maskWidth, maskHeight, quality)

  if (refinement) {
    const combinedCanvas = document.createElement('canvas')
    combinedCanvas.width = image.width
    combinedCanvas.height = image.height
    const maskContext = combinedCanvas.getContext('2d')
    if (!maskContext) throw new Error('Canvas is unavailable')
    maskContext.imageSmoothingEnabled = true
    maskContext.imageSmoothingQuality = 'high'
    maskContext.drawImage(maskCanvas, 0, 0, image.width, image.height)
    const refinedCanvas = alphaCanvas(
      refinement.mask,
      refinement.maskWidth,
      refinement.maskHeight,
      quality,
    )
    const { left, top, right, bottom } = refinement.crop
    maskContext.clearRect(left, top, right - left, bottom - top)
    maskContext.drawImage(
      refinedCanvas,
      left,
      top,
      right - left,
      bottom - top,
    )
    maskCanvas = combinedCanvas
  }

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

function alphaCanvas(
  mask: Float32Array,
  width: number,
  height: number,
  quality: 'fast' | 'quality',
) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas is unavailable')
  const pixels = context.createImageData(width, height)
  for (let index = 0; index < mask.length; index += 1) {
    const alpha =
      quality === 'quality' ? mask[index] : smoothstep(0.08, 0.92, mask[index])
    const offset = index * 4
    pixels.data[offset] = 255
    pixels.data[offset + 1] = 255
    pixels.data[offset + 2] = 255
    pixels.data[offset + 3] = Math.round(alpha * 255)
  }
  context.putImageData(pixels, 0, 0)
  return canvas
}

function smoothstep(min: number, max: number, value: number): number {
  const x = Math.max(0, Math.min(1, (value - min) / (max - min)))
  return x * x * (3 - 2 * x)
}
