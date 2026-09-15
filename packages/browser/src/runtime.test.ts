import { describe, expect, test } from 'bun:test'
import { canUseOnnxWebGpu, shouldUseSingleThreadedWasm } from './runtime'

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
})
