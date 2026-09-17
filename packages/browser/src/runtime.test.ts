import { describe, expect, test } from 'bun:test'
import {
  canUseOnnxWebGpu,
  configureIosWasm,
  shouldUseSingleThreadedWasm,
} from './runtime'

describe('iOS plain WASM runtime', () => {
  const version = '1.31.0-dev.20260914-8d85527a0'
  const settings = () => ({
    versions: { web: version, common: '1.30.0' },
    wasm: {
      numThreads: 4,
      wasmPaths: { mjs: 'original.asyncify.mjs', wasm: 'original.asyncify.wasm' },
    },
  })

  test.each([
    ['iPhone Safari/605.1', 0],
    ['iPhone CriOS/153.0', 0],
    ['Macintosh Safari/605.1', 5],
  ])('uses a matching plain factory/binary on %s', (ua, touches) => {
    const onnx = settings()
    configureIosWasm(onnx, ua, touches)
    const base = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/ort-wasm-simd-threaded`
    expect(onnx.wasm).toEqual({
      numThreads: 1,
      wasmPaths: { mjs: `${base}.mjs`, wasm: `${base}.wasm` },
    })
  })

  test.each(['Android Chrome/152.0', 'Macintosh Safari/605.1', 'Chrome/152.0'])(
    'leaves other platforms unchanged: %s',
    (ua) => {
      const onnx = settings()
      configureIosWasm(onnx, ua)
      expect(onnx).toEqual(settings())
    },
  )

  test('does not silently use an unversioned or incompatible iOS runtime', () => {
    expect(() => configureIosWasm({ wasm: {} }, 'iPhone')).toThrow(
      'runtime version is unavailable',
    )
  })
})

describe('canUseOnnxWebGpu', () => {
  test('rejects iPhone Safari even when WebKit exposes navigator.gpu', () => {
    expect(
      canUseOnnxWebGpu(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1',
        true,
      ),
    ).toBe(false)
  })

  test('rejects every iOS browser because they use WebKit', () => {
    const chromeIos =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 CriOS/153.0 Mobile/15E148 Safari/604.1'

    expect(canUseOnnxWebGpu(chromeIos, true)).toBe(false)
  })

  test('rejects desktop Safari and Firefox for this ONNX runtime', () => {
    const safari =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15'
    const firefox =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0'

    expect(canUseOnnxWebGpu(safari, true)).toBe(false)
    expect(canUseOnnxWebGpu(firefox, true)).toBe(false)
  })

  test('allows supported Chromium browsers when navigator.gpu exists', () => {
    const chrome =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36'
    const edge =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0'

    expect(canUseOnnxWebGpu(chrome, true)).toBe(true)
    expect(canUseOnnxWebGpu(edge, true)).toBe(true)
    expect(canUseOnnxWebGpu(chrome, false)).toBe(false)
  })
})

describe('shouldUseSingleThreadedWasm', () => {
  test('uses one WASM thread on iOS to avoid shared-memory reload crashes', () => {
    const iphone =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1'
    const android =
      'Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro) AppleWebKit/537.36 Chrome/152.0.0.0 Mobile Safari/537.36'

    expect(shouldUseSingleThreadedWasm(iphone)).toBe(true)
    expect(shouldUseSingleThreadedWasm(android)).toBe(false)
  })

  test('detects iPadOS when Safari requests a desktop user agent', () => {
    const desktopIpad =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15'

    expect(shouldUseSingleThreadedWasm(desktopIpad, 5)).toBe(true)
    expect(shouldUseSingleThreadedWasm(desktopIpad, 0)).toBe(false)
  })
})
