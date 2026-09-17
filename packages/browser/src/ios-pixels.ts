/** The existing BiRefNet processor's ImageNet normalization, planar RGB. */
export function normalizeIosPixels(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  if (pixels.length !== width * height * 4)
    throw new Error('Invalid pixel buffer')
  const result = new Float32Array(3 * width * height)
  const means = [0.485, 0.456, 0.406]
  const deviations = [0.229, 0.224, 0.225]
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++)
      result[c * width * height + i] =
        (pixels[i * 4 + c] / 255 - means[c]) / deviations[c]
  }
  return result
}

export function iosOutputSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const scale = Math.min(1, 1280 / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}
