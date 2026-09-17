import type { env } from '@huggingface/transformers'

// The WebGPU API being present does not mean ONNX Runtime supports that
// browser's implementation. Keep GPU inference on the runtime's supported
// Chromium engines; all iOS browsers use WebKit regardless of their brand.
const IOS_DEVICE = /\b(?:iPhone|iPad|iPod)\b/i
const MACINTOSH = /\bMacintosh\b/i
const SUPPORTED_CHROMIUM = /\b(?:Chrome|Chromium|Edg|OPR|SamsungBrowser)\/\d+/i

/** Device RAM and GPU buffer limits do not measure a mobile tab's budget. */
export function isMobileBrowser(
  userAgent: string,
  maxTouchPoints = 0,
): boolean {
  return (
    /\b(?:Android|Mobile)\b/i.test(userAgent) ||
    shouldUseSingleThreadedWasm(userAgent, maxTouchPoints)
  )
}

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

/** Configure before the first session: ORT's WASM runtime is page-global. */
export function configureIosWasm(
  onnx: typeof env.backends.onnx,
  userAgent: string,
  maxTouchPoints = 0,
): void {
  if (!shouldUseSingleThreadedWasm(userAgent, maxTouchPoints)) return
  const version = onnx.versions?.web
  if (!onnx.wasm || !version) {
    throw new Error('The iOS WASM runtime version is unavailable')
  }
  // Match the loaded JS runtime exactly. Do not mix a plain WASM binary with
  // the Asyncify factory, or infer compatibility from a successful download.
  // This is a physical-iOS experiment, not a confirmed memory-pressure fix.
  const base = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/ort-wasm-simd-threaded`
  onnx.wasm.numThreads = 1
  onnx.wasm.wasmPaths = { mjs: `${base}.mjs`, wasm: `${base}.wasm` }
}
