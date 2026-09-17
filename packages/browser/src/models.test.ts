import { describe, expect, test } from 'bun:test'
import { detectEngineChoices, FULL_MODEL, LITE_MODEL, modelUrl } from './models'

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
})
