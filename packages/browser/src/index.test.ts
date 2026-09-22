import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { AutoModel, AutoProcessor, Tensor } from '@huggingface/transformers'
import * as image from './image'
import {
  clearModelCache,
  prepareBackgroundRemoval,
  removeBackground,
} from './index'
import { FULL_MODEL, LITE_MODEL } from './models'
import * as refinement from './refinement'

const navigatorDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  'navigator',
)
const storageDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  'localStorage',
)
const storage = new Map<string, string>()
const png = new Blob(['png'], { type: 'image/png' })

beforeEach(() => {
  storage.clear()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'Chrome/150.0.0.0',
      gpu: {
        requestAdapter: async () => ({
          features: new Set(['shader-f16']),
          limits: {
            maxBufferSize: 1024 ** 3,
            maxStorageBufferBindingSize: 1024 ** 3,
          },
        }),
      },
    },
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  clearModelCache()
  spyOn(AutoProcessor, 'from_pretrained').mockResolvedValue((async () => ({
    pixel_values: 'pixels',
  })) as never)
  spyOn(image, 'prepareImageForInference').mockResolvedValue({
    data: new Uint8ClampedArray(512 * 512 * 4),
    width: 512,
    height: 512,
    sourceWidth: 800,
    sourceHeight: 600,
  })
  spyOn(image, 'decodeImage').mockResolvedValue({
    width: 800,
    height: 600,
    close: () => undefined,
  } as ImageBitmap)
  spyOn(image, 'maskToPng').mockResolvedValue(png)
})

afterEach(async () => {
  clearModelCache()
  await Promise.resolve()
  mock.restore()
  for (const [key, descriptor] of [
    ['navigator', navigatorDescriptor],
    ['localStorage', storageDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

function model(output = 'output_image') {
  return Object.assign(
    mock(async () => ({
      [output]: new Tensor('float32', new Float32Array([-4, 4]), [1, 1, 1, 2]),
    })),
    { dispose: mock(async () => undefined) },
  )
}

describe('automatic model lifecycle', () => {
  test('warm-up and removal share the full engine and apply sigmoid to output_image', async () => {
    const full = model()
    const load = spyOn(AutoModel, 'from_pretrained').mockResolvedValue(
      full as never,
    )
    await Promise.all([prepareBackgroundRemoval(), prepareBackgroundRemoval()])
    const result = await removeBackground(png)
    expect(load).toHaveBeenCalledTimes(1)
    expect(load.mock.calls[0][0]).toBe(FULL_MODEL.id)
    expect(load.mock.calls[0][1]).toMatchObject({
      revision: FULL_MODEL.revision,
      device: 'webgpu',
      dtype: 'fp16',
    })
    expect(result).toMatchObject({
      model: 'birefnet',
      provider: 'webgpu',
      width: 800,
      height: 600,
    })
    const alpha = (image.maskToPng as ReturnType<typeof spyOn>).mock
      .calls[0][1] as Float32Array
    expect(alpha[0]).toBeCloseTo(0.017986, 5)
    expect(alpha[1]).toBeCloseTo(0.982014, 5)
  })

  test('a full-model load failure falls back to lite GPU and stays downgraded for the session', async () => {
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id) => {
        if (id === FULL_MODEL.id) throw new Error('allocation failed')
        return model('logits') as never
      },
    )
    expect(await prepareBackgroundRemoval()).toBe('webgpu')
    expect((await removeBackground(png)).model).toBe('birefnet-lite')
    expect(load.mock.calls.map((call) => call[0])).toEqual([
      FULL_MODEL.id,
      LITE_MODEL.id,
    ])
    expect(storage.size).toBe(0)
  })

  test.each(['exception', 'invalid', 'empty'])(
    'recovers from a full-model %s during inference and disposes it',
    async (failure) => {
      const full = Object.assign(
        mock(async () => {
          if (failure === 'exception') throw new Error('device lost')
          return {
            output_image: new Tensor(
              'float32',
              new Float32Array(
                failure === 'invalid' ? [NaN, NaN] : [-100, -100],
              ),
              [1, 1, 1, 2],
            ),
          }
        }),
        { dispose: mock(async () => undefined) },
      )
      const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
        async (id) => (id === FULL_MODEL.id ? full : model('logits')) as never,
      )
      const result = await removeBackground(png)
      expect(result).toMatchObject({
        model: 'birefnet-lite',
        provider: 'webgpu',
      })
      expect(full.dispose).toHaveBeenCalledTimes(1)
      await removeBackground(png)
      expect(load).toHaveBeenCalledTimes(2)
      expect(storage.size).toBe(0)
    },
  )

  test('falls back through both GPU models to WASM and remembers only lite GPU failure', async () => {
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (_id, options) => {
        if (options?.device === 'webgpu') throw new Error('unsupported GPU')
        return model('logits') as never
      },
    )
    expect((await removeBackground(png)).provider).toBe('wasm')
    expect(load.mock.calls.map((call) => [call[0], call[1]?.device])).toEqual([
      [FULL_MODEL.id, 'webgpu'],
      [LITE_MODEL.id, 'webgpu'],
      [LITE_MODEL.id, 'wasm'],
    ])
    expect(storage.size).toBe(1)
  })

  test('cancellation during failed inference does not start a fallback', async () => {
    const controller = new AbortController()
    const full = Object.assign(
      async () => {
        controller.abort()
        throw new Error('device lost')
      },
      { dispose: async () => undefined },
    )
    const load = spyOn(AutoModel, 'from_pretrained').mockResolvedValue(
      full as never,
    )
    await expect(
      removeBackground(png, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(load).toHaveBeenCalledTimes(1)
  })

  test('cancellation during loading does not download another model', async () => {
    const controller = new AbortController()
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async () => {
        controller.abort()
        throw new Error('allocation failed')
      },
    )
    await expect(
      removeBackground(png, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(load).toHaveBeenCalledTimes(1)
  })

  test('download progress stays monotonic when switching models', async () => {
    spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        options?.progress_callback?.({
          status: 'progress',
          name: id,
          file: 'onnx/model_fp16.onnx',
          progress: 90,
          loaded: 90,
          total: 100,
        })
        if (id === FULL_MODEL.id) throw new Error('allocation failed')
        return model('logits') as never
      },
    )
    const progress: number[] = []
    await removeBackground(png, {
      onProgress: (event) => progress.push(event.progress),
    })
    expect(progress.length).toBeGreaterThan(3)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(progress.at(-1)).toBe(1)
  })

  test('cache reset releases engines and allows the full model to be tried again', async () => {
    const load = spyOn(AutoModel, 'from_pretrained')
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(model() as never)
    await prepareBackgroundRemoval()
    clearModelCache()
    expect((await removeBackground(png)).model).toBe('birefnet')
    expect(load.mock.calls.map((call) => call[0])).toEqual([
      FULL_MODEL.id,
      LITE_MODEL.id,
      FULL_MODEL.id,
    ])
  })

  test('cache reset after acquisition keeps the selected engine alive until removal finishes', async () => {
    const full = model()
    const load = spyOn(AutoModel, 'from_pretrained').mockResolvedValue(
      full as never,
    )
    const result = await removeBackground(png, {
      onProgress: ({ stage }) => {
        if (stage === 'processing') clearModelCache()
      },
    })
    expect(result.model).toBe('birefnet')
    expect(load).toHaveBeenCalledTimes(1)
    expect(full).toHaveBeenCalledTimes(1)
    expect(full.dispose).toHaveBeenCalledTimes(1)
  })

  test('cache reset during loading preserves the reservation for the pending removal', async () => {
    const full = model()
    let reset = false
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async () => {
        if (!reset) {
          reset = true
          clearModelCache()
        }
        await Promise.resolve()
        return full as never
      },
    )
    expect((await removeBackground(png)).model).toBe('birefnet')
    expect(load).toHaveBeenCalledTimes(1)
    expect(full).toHaveBeenCalledTimes(1)
    expect(full.dispose).toHaveBeenCalledTimes(1)
  })

  test('cache reset between base inference and refinement does not release the model', async () => {
    const full = model()
    spyOn(AutoModel, 'from_pretrained').mockResolvedValue(full as never)
    spyOn(refinement, 'createMaskRefinement').mockImplementation(
      async ({ infer, source }) => {
        clearModelCache()
        await Promise.resolve()
        expect(full.dispose).not.toHaveBeenCalled()
        await infer(source)
        return undefined
      },
    )
    expect((await removeBackground(png, { quality: 'quality' })).model).toBe(
      'birefnet',
    )
    expect(full).toHaveBeenCalledTimes(2)
    expect(full.dispose).toHaveBeenCalledTimes(1)
  })

  test('cache reset waits for every concurrent removal before disposal', async () => {
    const full = model()
    spyOn(AutoModel, 'from_pretrained').mockResolvedValue(full as never)
    const reachedFinishing = Promise.withResolvers<void>()
    const finishSecond = Promise.withResolvers<void>()
    let finishing = 0
    spyOn(image, 'maskToPng').mockImplementation(async () => {
      finishing++
      if (finishing === 2) {
        clearModelCache()
        reachedFinishing.resolve()
        await finishSecond.promise
      } else {
        await reachedFinishing.promise
      }
      return png
    })
    const first = removeBackground(png)
    const second = removeBackground(png)
    await reachedFinishing.promise
    try {
      expect((await first).model).toBe('birefnet')
      expect(full.dispose).not.toHaveBeenCalled()
    } finally {
      finishSecond.resolve()
      await second
    }
    expect(full.dispose).toHaveBeenCalledTimes(1)
  })

  test('cancellation after cache reset releases the acquired model without inference', async () => {
    const controller = new AbortController()
    const full = model()
    const load = spyOn(AutoModel, 'from_pretrained').mockResolvedValue(
      full as never,
    )
    await expect(
      removeBackground(png, {
        signal: controller.signal,
        onProgress: ({ stage }) => {
          if (stage === 'processing') {
            clearModelCache()
            controller.abort()
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(load).toHaveBeenCalledTimes(1)
    expect(full).not.toHaveBeenCalled()
    expect(full.dispose).toHaveBeenCalledTimes(1)
  })

  test('all load failures remain useful and WASM can be retried', async () => {
    const load = spyOn(AutoModel, 'from_pretrained').mockRejectedValue(
      new Error('offline'),
    )
    await expect(removeBackground(png)).rejects.toMatchObject({
      code: 'model-load-failed',
    })
    load.mockResolvedValue(model('logits') as never)
    expect((await removeBackground(png)).provider).toBe('wasm')
  })

  test.each(['load', 'inference'])(
    'full WASM %s failure falls back to lite WASM without disabling GPUs',
    async (failure) => {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { userAgent: 'Firefox/150.0', hardwareConcurrency: 8 },
      })
      const full = Object.assign(
        async () => {
          throw new Error('allocation failed')
        },
        { dispose: mock(async () => undefined) },
      )
      const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
        async (id) => {
          if (id === FULL_MODEL.id) {
            if (failure === 'load') throw new Error('allocation failed')
            return full as never
          }
          return model('logits') as never
        },
      )
      const result = await removeBackground(png)
      expect(result).toMatchObject({ model: 'birefnet-lite', provider: 'wasm' })
      expect(load.mock.calls.map((call) => [call[0], call[1]?.device])).toEqual(
        [
          [FULL_MODEL.id, 'wasm'],
          [LITE_MODEL.id, 'wasm'],
        ],
      )
      if (failure === 'inference') expect(full.dispose).toHaveBeenCalledTimes(1)
      expect(storage.size).toBe(0)
      await removeBackground(png)
      expect(load).toHaveBeenCalledTimes(2)
    },
  )
})

describe('HEIC sources', () => {
  // ftyp box: size 16, 'ftyp', major 'heic', minor 0.
  const heic = new Blob(
    [
      new Uint8Array([
        0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0,
      ]),
    ],
    { type: 'image/heic' },
  )

  test('decodes a HEIC source once and runs the pipeline on the PNG transcode', async () => {
    const heicBitmap = {
      width: 800,
      height: 600,
      close: mock(() => undefined),
    }
    const pngBitmap = {
      width: 800,
      height: 600,
      close: mock(() => undefined),
    }
    const transcoded = new Blob(['transcoded'], { type: 'image/png' })
    const decode = spyOn(image, 'decodeImage').mockImplementation(
      async (_input, format) =>
        (format === 'heic' ? heicBitmap : pngBitmap) as ImageBitmap,
    )
    const toPng = spyOn(image, 'imageToPng').mockResolvedValue(transcoded)
    spyOn(AutoModel, 'from_pretrained').mockResolvedValue(model() as never)

    const result = await removeBackground(heic, { quality: 'quality' })

    expect(decode.mock.calls).toEqual([
      [heic, 'heic'],
      [transcoded, 'png'],
      [transcoded, 'png'],
    ])
    expect(toPng.mock.calls).toEqual([[heicBitmap]])
    expect(image.prepareImageForInference).toHaveBeenCalledWith(
      transcoded,
      expect.any(Number),
      expect.any(Number),
      'png',
    )
    expect(
      (image.maskToPng as ReturnType<typeof spyOn>).mock.calls[0][0],
    ).toBe(pngBitmap)
    expect(heicBitmap.close).toHaveBeenCalledTimes(1)
    expect(pngBitmap.close).toHaveBeenCalledTimes(2)
    expect(result.sourceBlob).toBe(transcoded)
  })

  test('cancellation during the HEIC decode skips the PNG transcode', async () => {
    const controller = new AbortController()
    const heicBitmap = {
      width: 800,
      height: 600,
      close: mock(() => undefined),
    }
    const transcoded = new Blob(['transcoded'], { type: 'image/png' })
    spyOn(image, 'decodeImage').mockImplementation(async () => {
      controller.abort()
      return heicBitmap as ImageBitmap
    })
    const toPng = spyOn(image, 'imageToPng').mockResolvedValue(transcoded)
    spyOn(AutoModel, 'from_pretrained').mockResolvedValue(model() as never)

    await expect(
      removeBackground(heic, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(toPng).not.toHaveBeenCalled()
    expect(heicBitmap.close).toHaveBeenCalledTimes(1)
  })

  test('returns no sourceBlob for natively displayable formats', async () => {
    const toPng = spyOn(image, 'imageToPng')
    spyOn(AutoModel, 'from_pretrained').mockResolvedValue(model() as never)

    const result = await removeBackground(png)

    expect(result.sourceBlob).toBeUndefined()
    expect(toPng).not.toHaveBeenCalled()
  })
})
