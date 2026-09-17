import { BackgroundRemovalError } from './errors'

export const MAX_IMAGE_BYTES = 40 * 1024 * 1024
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/x-heic',
  'image/x-heif',
] as const
export const IMAGE_ACCEPT_ATTRIBUTE = [
  ...SUPPORTED_IMAGE_MIME_TYPES,
  '.heic',
  '.heif',
  '.hif',
].join(',')
export const SUPPORTED_IMAGE_FORMAT_LABEL = 'PNG, JPG, WebP, HEIC, or HEIF'

export type SupportedImageFormat = 'jpeg' | 'png' | 'webp' | 'heic'

type ImageSignatureInspection =
  | { kind: 'supported'; format: SupportedImageFormat }
  | { kind: 'unsupported' }
  | { kind: 'unknown' }

const MIME_FORMATS = new Map<string, SupportedImageFormat>([
  ['image/jpeg', 'jpeg'],
  ['image/jpg', 'jpeg'],
  ['image/pjpeg', 'jpeg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/heic', 'heic'],
  ['image/heif', 'heic'],
  ['image/x-heic', 'heic'],
  ['image/x-heif', 'heic'],
])
const EXTENSION_FORMATS = new Map<string, SupportedImageFormat>([
  ['jpg', 'jpeg'],
  ['jpeg', 'jpeg'],
  ['png', 'png'],
  ['webp', 'webp'],
  ['heic', 'heic'],
  ['heif', 'heic'],
  ['hif', 'heic'],
])
const GENERIC_MIME_TYPES = new Set([
  '',
  'application/octet-stream',
  'application/binary',
])
const HEVC_STILL_IMAGE_BRANDS = new Set(['heic', 'heix', 'heim', 'heis'])
const HEVC_SEQUENCE_BRANDS = new Set(['hevc', 'hevx', 'hevm', 'hevs', 'msf1'])
const UNSUPPORTED_ISO_IMAGE_BRANDS = new Set([
  ...HEVC_SEQUENCE_BRANDS,
  'avif',
  'avis',
])

export async function validateImage(
  input: Blob,
): Promise<SupportedImageFormat> {
  if (input.size > MAX_IMAGE_BYTES) {
    throw new BackgroundRemovalError(
      'image-too-large',
      'This image is over 40 MB. Choose a smaller file.',
    )
  }

  const format = await detectImageFormat(input)
  if (!format) {
    throw new BackgroundRemovalError(
      'unsupported-image',
      `Choose a ${SUPPORTED_IMAGE_FORMAT_LABEL} image.`,
    )
  }
  return format
}

export async function detectImageFormat(
  input: Blob,
): Promise<SupportedImageFormat | null> {
  const mime = input.type.toLowerCase().trim()
  const mimeFormat = MIME_FORMATS.get(mime)
  if (!mimeFormat && !GENERIC_MIME_TYPES.has(mime)) return null

  const signatureBytes = new Uint8Array(
    await input.slice(0, 4096).arrayBuffer(),
  )
  const signature = inspectImageSignature(
    signatureBytes,
    input.size <= signatureBytes.length,
  )
  if (signature.kind === 'unsupported') return null
  if (signature.kind === 'supported') return signature.format

  // HEIC/HEIF routing must be backed by its container signature; otherwise a
  // mislabeled legacy image would invoke a large fallback decoder needlessly.
  if (mimeFormat === 'heic') return null
  if (mimeFormat) return mimeFormat

  if (typeof File !== 'undefined' && input instanceof File) {
    const extension = input.name.split('.').pop()?.toLowerCase()
    const extensionFormat = extension
      ? EXTENSION_FORMATS.get(extension)
      : undefined
    if (extensionFormat !== 'heic') return extensionFormat ?? null
  }

  return null
}

export function sniffImageFormat(
  bytes: Uint8Array,
): SupportedImageFormat | null {
  const signature = inspectImageSignature(bytes)
  return signature.kind === 'supported' ? signature.format : null
}

function inspectImageSignature(
  bytes: Uint8Array,
  isComplete = true,
): ImageSignatureInspection {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { kind: 'supported', format: 'png' }
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return { kind: 'supported', format: 'jpeg' }
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === 'RIFF' &&
    ascii(bytes, 8, 12) === 'WEBP'
  ) {
    return { kind: 'supported', format: 'webp' }
  }
  if (bytes.length >= 8 && ascii(bytes, 4, 8) === 'ftyp') {
    const size32 = readUint32(bytes, 0)
    let headerSize = 8
    let declaredSize = size32
    if (size32 === 0) {
      // A zero-sized box extends to EOF. Only inspect it when the bounded read
      // contains the whole input; otherwise retain metadata fallback just as
      // we do for any other incomplete ftyp box.
      if (!isComplete) return { kind: 'unknown' }
      declaredSize = bytes.length
    } else if (size32 === 1) {
      if (bytes.length < 16) return { kind: 'unknown' }

      const sizeHigh = readUint32(bytes, 8)
      const sizeLow = readUint32(bytes, 12)
      // Any non-zero high word is larger than both the sniff window and BG0's
      // upload limit. Do not combine it into an imprecise JavaScript Number.
      if (sizeHigh !== 0) return { kind: 'unknown' }
      headerSize = 16
      declaredSize = sizeLow
    }

    const brandFieldsSize = 8
    if (
      declaredSize < headerSize + brandFieldsSize ||
      declaredSize > bytes.length ||
      (declaredSize - headerSize - brandFieldsSize) % 4 !== 0
    ) {
      return { kind: 'unknown' }
    }

    const majorBrand = ascii(bytes, headerSize, headerSize + 4)
    if (UNSUPPORTED_ISO_IMAGE_BRANDS.has(majorBrand)) {
      return { kind: 'unsupported' }
    }

    let hasStillCompatibleBrand = false
    for (
      let offset = headerSize + brandFieldsSize;
      offset < declaredSize;
      offset += 4
    ) {
      const compatibleBrand = ascii(bytes, offset, offset + 4)
      if (UNSUPPORTED_ISO_IMAGE_BRANDS.has(compatibleBrand)) {
        return { kind: 'unsupported' }
      }
      if (HEVC_STILL_IMAGE_BRANDS.has(compatibleBrand)) {
        hasStillCompatibleBrand = true
      }
    }

    if (HEVC_STILL_IMAGE_BRANDS.has(majorBrand)) {
      return { kind: 'supported', format: 'heic' }
    }

    // `mif1` is the generic still-image HEIF container. Its compatible brands
    // identify the codec; the four bytes after the major brand are the
    // numeric minor version.
    if (majorBrand === 'mif1') {
      return hasStillCompatibleBrand
        ? { kind: 'supported', format: 'heic' }
        : { kind: 'unsupported' }
    }
    return { kind: 'unknown' }
  }
  return { kind: 'unknown' }
}

interface ImageDecoders {
  native: (input: Blob) => Promise<ImageBitmap>
  heic: (input: Blob) => Promise<ImageBitmap>
}

export async function decodeImage(
  input: Blob,
  format?: SupportedImageFormat,
  decoders: ImageDecoders = defaultImageDecoders,
): Promise<ImageBitmap> {
  try {
    const resolvedFormat = format ?? (await validateImage(input))
    if (resolvedFormat !== 'heic') return await decoders.native(input)

    try {
      return await decoders.native(input)
    } catch {
      return await decoders.heic(input)
    }
  } catch (error) {
    throw new BackgroundRemovalError(
      'decode-failed',
      'This image could not be opened. Try exporting it as PNG or JPG.',
      { cause: error },
    )
  }
}

const defaultImageDecoders: ImageDecoders = {
  native: (input) =>
    createImageBitmap(input, { imageOrientation: 'from-image' }),
  heic: async (input) => {
    const decoderUrl = new URL('./vendor/heic-to.js', import.meta.url).href
    const { heicTo } = await import(/* @vite-ignore */ decoderUrl)
    return heicTo({
      blob: input,
      type: 'bitmap',
      options: { imageOrientation: 'from-image' },
    })
  },
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] * 0x1000000 +
      bytes[offset + 1] * 0x10000 +
      bytes[offset + 2] * 0x100 +
      bytes[offset + 3]) >>>
    0
  )
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
  format?: SupportedImageFormat,
): Promise<PreparedInferenceImage> {
  const image = await decodeImage(input, format)
  let canvas: HTMLCanvasElement | undefined
  try {
    canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Canvas is unavailable')
    context.drawImage(image, 0, 0, width, height)
    const data = context.getImageData(0, 0, width, height).data

    return {
      data,
      width,
      height,
      sourceWidth: image.width,
      sourceHeight: image.height,
    }
  } finally {
    if (canvas) releaseCanvas(canvas)
    image.close()
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

export async function maskToPng(
  image: ImageBitmap,
  mask: Float32Array,
  maskWidth: number,
  maskHeight: number,
  quality: 'fast' | 'quality',
  refinement?: MaskRefinement,
): Promise<Blob> {
  const canvases: HTMLCanvasElement[] = []
  try {
    const base = alphaCanvas(mask, maskWidth, maskHeight, quality)
    canvases.push(base)
    const output = document.createElement('canvas')
    canvases.push(output)
    output.width = image.width
    output.height = image.height
    const context = output.getContext('2d')
    if (!context) throw new Error('Canvas is unavailable')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = quality === 'quality' ? 'high' : 'medium'
    context.drawImage(base, 0, 0, image.width, image.height)
    releaseCanvas(base)

    if (refinement) {
      const refined = alphaCanvas(
        refinement.mask,
        refinement.maskWidth,
        refinement.maskHeight,
        quality,
      )
      canvases.push(refined)
      const { left, top, right, bottom } = refinement.crop
      context.clearRect(left, top, right - left, bottom - top)
      context.drawImage(refined, left, top, right - left, bottom - top)
      releaseCanvas(refined)
    }

    // Reuse the full-size mask as the output. source-in retains the photo's
    // colors with the mask alpha, without a second full-resolution canvas.
    context.globalCompositeOperation = 'source-in'
    context.drawImage(image, 0, 0)
    // toBlob is asynchronous: keep pixels alive until encoding has settled.
    return await canvasToPng(output)
  } finally {
    for (const canvas of canvases) releaseCanvas(canvas)
  }
}

export async function imageToPng(image: ImageBitmap): Promise<Blob> {
  const canvas = document.createElement('canvas')
  try {
    canvas.width = image.width
    canvas.height = image.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is unavailable')
    context.drawImage(image, 0, 0)
    return await canvasToPng(canvas)
  } finally {
    releaseCanvas(canvas)
  }
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0
  canvas.height = 0
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
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
  try {
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas is unavailable')
    const pixels = context.createImageData(width, height)
    for (let index = 0; index < mask.length; index += 1) {
      const alpha =
        quality === 'quality'
          ? mask[index]
          : smoothstep(0.08, 0.92, mask[index])
      const offset = index * 4
      pixels.data[offset] = 255
      pixels.data[offset + 1] = 255
      pixels.data[offset + 2] = 255
      pixels.data[offset + 3] = Math.round(alpha * 255)
    }
    context.putImageData(pixels, 0, 0)
    return canvas
  } catch (error) {
    releaseCanvas(canvas)
    throw error
  }
}

function smoothstep(min: number, max: number, value: number): number {
  const x = Math.max(0, Math.min(1, (value - min) / (max - min)))
  return x * x * (3 - 2 * x)
}
