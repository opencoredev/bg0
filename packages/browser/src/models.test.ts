import { describe, expect, test } from 'bun:test'
import {
  choicesForTier,
  detectEngineChoices,
  type EngineChoice,
  FULL_MODEL,
  LITE_MODEL,
  MODEL_TIER_BYTES,
  modelUrl,
} from './models'

const chrome = 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36'
const adapter = {
  features: new Set(['shader-f16']),
  limits: {
    maxBufferSize: 1024 * 1024 * 1024,
    maxStorageBufferBindingSize: 128 * 1024 * 1024,
  },
}
const gpu = { requestAdapter: async () => adapter }

describe('hardware-based model selection', () => {
  test('prefers the full model on ordinary integrated GPUs, including unknown RAM', async () => {
    for (const deviceMemory of [undefined, 4, 8]) {
      expect(
        await detectEngineChoices({ userAgent: chrome, gpu, deviceMemory }),
      ).toEqual([
        { definition: FULL_MODEL, provider: 'webgpu' },
        { definition: LITE_MODEL, provider: 'webgpu' },
        { definition: LITE_MODEL, provider: 'wasm' },
      ])
    }
  })

  test('keeps the lite GPU model on known low-memory devices or small buffers', async () => {
    for (const hardware of [
      { userAgent: chrome, gpu, deviceMemory: 2 },
      {
        userAgent: chrome,
        gpu: {
          requestAdapter: async () => ({
            ...adapter,
            limits: { ...adapter.limits, maxBufferSize: 128 * 1024 * 1024 },
          }),
        },
      },
      {
        userAgent: chrome,
        gpu: {
          requestAdapter: async () => ({
            ...adapter,
            limits: {
              ...adapter.limits,
              maxStorageBufferBindingSize: 64 * 1024 * 1024,
            },
          }),
        },
      },
    ]) {
      expect(
        (await detectEngineChoices(hardware)).map(
          (choice) => choice.definition.name,
        ),
      ).toEqual(['birefnet-lite', 'birefnet-lite'])
    }
  })

  test('uses lite WASM when the GPU probe is absent, rejected, software-only or lacks fp16', async () => {
    for (const hardware of [
      { userAgent: chrome },
      { userAgent: chrome, gpu: { requestAdapter: async () => null } },
      {
        userAgent: chrome,
        gpu: {
          requestAdapter: async () => {
            throw new Error('blocked')
          },
        },
      },
      {
        userAgent: chrome,
        gpu: {
          requestAdapter: async () => ({
            ...adapter,
            features: new Set<string>(),
          }),
        },
      },
      {
        userAgent: chrome,
        gpu: {
          requestAdapter: async () => ({ ...adapter, isFallbackAdapter: true }),
        },
      },
      { userAgent: 'Version/18.0 Safari/605.1.15', gpu },
      { userAgent: 'iPhone CriOS/150.0.0.0', gpu },
    ]) {
      expect(await detectEngineChoices(hardware)).toEqual([
        { definition: LITE_MODEL, provider: 'wasm' },
      ])
    }
  })

  test('pins separate cache URLs and byte estimates for both exports', () => {
    expect(modelUrl(FULL_MODEL)).not.toBe(modelUrl(LITE_MODEL))
    for (const model of [FULL_MODEL, LITE_MODEL]) {
      expect(model.revision).toMatch(/^[a-f0-9]{40}$/)
      expect(modelUrl(model)).toContain(
        `/resolve/${model.revision}/onnx/model_fp16.onnx`,
      )
      expect(model.bytes).toBeGreaterThan(90_000_000)
    }
  })

  test('uses full BiRefNet on capable CPU-only desktops, including missing RAM hints', async () => {
    for (const userAgent of [
      chrome,
      'Macintosh Version/18.0 Safari/605.1.15',
      'Firefox/150.0',
    ]) {
      for (const deviceMemory of [undefined, 4, 8]) {
        expect(
          await detectEngineChoices({
            userAgent,
            hardwareConcurrency: 4,
            deviceMemory,
          }),
        ).toEqual([
          { definition: FULL_MODEL, provider: 'wasm' },
          { definition: LITE_MODEL, provider: 'wasm' },
        ])
      }
    }
  })

  test('keeps CPU inference light on low-memory, low-core, iPhone and iPad devices', async () => {
    for (const hardware of [
      { userAgent: chrome, hardwareConcurrency: 2 },
      { userAgent: chrome, hardwareConcurrency: 8, deviceMemory: 2 },
      { userAgent: 'iPhone CriOS/150.0', hardwareConcurrency: 8 },
      {
        userAgent: 'Macintosh Version/18.0 Safari/605.1.15',
        hardwareConcurrency: 8,
        maxTouchPoints: 5,
      },
    ]) {
      expect(await detectEngineChoices(hardware)).toEqual([
        { definition: LITE_MODEL, provider: 'wasm' },
      ])
    }
  })

  test('a GPU that never answers falls back to CPU choices', async () => {
    const hanging = {
      requestAdapter: () => new Promise<never>(() => undefined),
    }
    expect(
      await detectEngineChoices(
        { userAgent: chrome, gpu: hanging, hardwareConcurrency: 8 },
        { adapterTimeoutMs: 5 },
      ),
    ).toEqual([
      { definition: FULL_MODEL, provider: 'wasm' },
      { definition: LITE_MODEL, provider: 'wasm' },
    ])
  })
})

describe('pinned model tiers', () => {
  const capable: EngineChoice[] = [
    { definition: FULL_MODEL, provider: 'webgpu' },
    { definition: LITE_MODEL, provider: 'webgpu' },
    { definition: LITE_MODEL, provider: 'wasm' },
  ]
  const liteGpu: EngineChoice[] = [
    { definition: LITE_MODEL, provider: 'webgpu' },
    { definition: LITE_MODEL, provider: 'wasm' },
  ]
  const cpuOnly: EngineChoice[] = [{ definition: LITE_MODEL, provider: 'wasm' }]

  test('auto keeps the detected order', () => {
    expect(choicesForTier(capable, 'auto')).toEqual(capable)
    expect(choicesForTier(cpuOnly, 'auto')).toEqual(cpuOnly)
  })

  test('lite drops the full model on a device that could run it', () => {
    expect(choicesForTier(capable, 'lite')).toEqual(liteGpu)
    expect(
      choicesForTier(
        [{ definition: FULL_MODEL, provider: 'wasm' }, ...cpuOnly],
        'lite',
      ),
    ).toEqual(cpuOnly)
  })

  test('full tries the full model where detection declined it, keeping lite as the fallback', () => {
    expect(choicesForTier(capable, 'full')).toEqual(capable)
    expect(choicesForTier(liteGpu, 'full')).toEqual([
      { definition: FULL_MODEL, provider: 'webgpu' },
      ...liteGpu,
    ])
    expect(choicesForTier(cpuOnly, 'full')).toEqual([
      { definition: FULL_MODEL, provider: 'wasm' },
      ...cpuOnly,
    ])
  })

  test('publishes the download size of each pinned tier', () => {
    expect(MODEL_TIER_BYTES).toEqual({
      lite: LITE_MODEL.bytes,
      full: FULL_MODEL.bytes,
    })
    // The sizes the picker shows: 93.9 MiB and 451.5 MiB, rounded.
    expect(Math.round(MODEL_TIER_BYTES.lite / 1024 ** 2)).toBe(94)
    expect(Math.round(MODEL_TIER_BYTES.full / 1024 ** 2)).toBe(452)
  })
})
