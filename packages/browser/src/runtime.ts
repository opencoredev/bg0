// The WebGPU API being present does not mean ONNX Runtime supports that
// browser's implementation. Keep GPU inference on the runtime's supported
// Chromium engines; all iOS browsers use WebKit regardless of their brand.
const IOS_DEVICE = /\b(?:iPhone|iPad|iPod)\b/i
const MACINTOSH = /\bMacintosh\b/i
const SUPPORTED_CHROMIUM = /\b(?:Chrome|Chromium|Edg|OPR|SamsungBrowser)\/\d+/i

export function canUseOnnxWebGpu(
  userAgent: string,
  hasNavigatorGpu: boolean,
): boolean {
  return (
    hasNavigatorGpu &&
    !IOS_DEVICE.test(userAgent) &&
    SUPPORTED_CHROMIUM.test(userAgent)
  )
}

export function shouldUseSingleThreadedWasm(
  userAgent: string,
  maxTouchPoints = 0,
): boolean {
  return (
    IOS_DEVICE.test(userAgent) ||
    (MACINTOSH.test(userAgent) && maxTouchPoints > 1)
  )
}
