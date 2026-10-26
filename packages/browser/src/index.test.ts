import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import {
  AutoModel,
  AutoProcessor,
  env,
  Tensor,
} from '@huggingface/transformers'
import * as cacheModule from './cache'
import { modelLoadTimings } from './download'
import * as image from './image'
import {
  clearModelCache,
  prepareBackgroundRemoval,
  type RemovalProgress,
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

/**
 * Reports that the load has opened its model file, as Transformers.js does
 * once it has chosen between the cache and the network.
 */
function reportModelFileOpened(
  id: string,
  options?: { progress_callback?: (event: never) => void },
) {
  options?.progress_callback?.({
    status: 'download',
    name: id,
    file: 'onnx/model_fp16.onnx',
  } as never)
}

/**
 * Reads the model file through the installed cache, then reports opening it,
 * in the order Transformers.js does.
 */
async function openModelFile(
  id: string,
  options?: { progress_callback?: (event: never) => void },
) {
  const definition = [FULL_MODEL, LITE_MODEL].find((model) => model.id === id)
  const cache = env.customCache as {
    match?: (key: string) => Promise<Response | undefined>
  } | null
  if (definition && cache?.match) {
    await cache.match(
      `https://huggingface.co/${definition.id}/resolve/${definition.revision}/onnx/model_fp16.onnx`,
    )
  }
  reportModelFileOpened(id, options)
}

/**
 * Opens the model file and reports load progress, which later callers of the
 * same load receive on joining.
 */
async function reportLoadProgress(
  id: string,
  options?: { progress_callback?: (event: never) => void },
) {
  await openModelFile(id, options)
  options?.progress_callback?.({
    status: 'progress',
    name: id,
    file: 'onnx/model_fp16.onnx',
    progress: 40,
    loaded: 40,
    total: 100,
  } as never)
}

/** Resolves `joined` once `count` callers have received progress from one model load. */
function sharedLoad(count: number) {
  let waiting = count
  let resolve: () => void = () => undefined
  const joined = new Promise<void>((done) => {
    resolve = done
  })
  return {
    joined,
    caller() {
      let seen = false
      return (event: RemovalProgress) => {
        if (seen || event.message !== 'Loading cached model…') return
        seen = true
        waiting -= 1
        if (waiting === 0) resolve()
      }
    },
  }
}

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
    const reported: (string | undefined)[] = []
    const result = await removeBackground(png, {
      onProgress: ({ provider }) => reported.push(provider),
    })
    expect(result.provider).toBe('wasm')
    // Progress names the provider actually chosen, not the one tried first.
    expect(reported).toContain('wasm')
    expect(reported).not.toContain('webgpu')
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

describe('model load recovery', () => {
  const originalFetch = env.fetch
  const timings = { ...modelLoadTimings }
  const cachesDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  const sessionDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'sessionStorage',
  )
  const modelFile = (definition: typeof FULL_MODEL) =>
    `https://huggingface.co/${definition.id}/resolve/${definition.revision}/onnx/model_fp16.onnx`

  afterEach(() => {
    env.fetch = originalFetch
    Object.assign(modelLoadTimings, timings)
    for (const [key, descriptor] of [
      ['caches', cachesDescriptor],
      ['sessionStorage', sessionDescriptor],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })

  function installCaches(put: (key: string, response: Response) => unknown) {
    const entries = new Map<string, Response>()
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: {
        open: async () => ({
          match: async (key: string) => entries.get(key)?.clone(),
          put: async (key: string, response: Response) => {
            await put(key, response)
            entries.set(key, response)
          },
          delete: async (key: string) => entries.delete(key),
        }),
      },
    })
    return entries
  }

  test('a corrupt cached model is evicted and the lite model still loads', async () => {
    const entries = installCaches(() => undefined)
    entries.set(
      modelFile(FULL_MODEL),
      new Response('x', {
        headers: { 'content-length': String(FULL_MODEL.bytes) },
      }),
    )
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        await openModelFile(id, options)
        if (id === FULL_MODEL.id) {
          throw new Error(
            "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.",
          )
        }
        return model('logits') as never
      },
    )
    expect(await removeBackground(png)).toMatchObject({
      model: 'birefnet-lite',
      provider: 'webgpu',
    })
    expect(entries.has(modelFile(FULL_MODEL))).toBe(false)
    // The full model is downloaded again once before falling back.
    expect(load.mock.calls.map((call) => call[0])).toEqual([
      FULL_MODEL.id,
      FULL_MODEL.id,
      LITE_MODEL.id,
    ])
    expect(storage.size).toBe(0)
  })

  test('a corrupt lite WASM model is evicted and downloaded again once', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Firefox/150.0' },
    })
    const entries = installCaches(() => undefined)
    entries.set(
      modelFile(LITE_MODEL),
      new Response('x', {
        headers: { 'content-length': String(LITE_MODEL.bytes) },
      }),
    )
    const corrupt = new Error(
      "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.",
    )
    let corruptLoads = 1
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        await openModelFile(id, options)
        if (corruptLoads > 0) {
          corruptLoads -= 1
          throw corrupt
        }
        return model('logits') as never
      },
    )
    expect(await removeBackground(png)).toMatchObject({
      model: 'birefnet-lite',
      provider: 'wasm',
    })
    expect(entries.has(modelFile(LITE_MODEL))).toBe(false)
    expect(load).toHaveBeenCalledTimes(2)

    // A download that is corrupt every time is retried once, not forever.
    clearModelCache()
    corruptLoads = Number.POSITIVE_INFINITY
    load.mockClear()
    await expect(removeBackground(png)).rejects.toMatchObject({
      code: 'model-load-failed',
    })
    expect(load).toHaveBeenCalledTimes(2)
    await expect(removeBackground(png)).rejects.toMatchObject({
      code: 'model-load-failed',
    })
    expect(load).toHaveBeenCalledTimes(2)
  })

  test('a corrupt retry is evicted even when it reuses the error object', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Firefox/150.0' },
    })
    const entries = installCaches(() => undefined)
    entries.set(
      modelFile(LITE_MODEL),
      new Response('x', {
        headers: { 'content-length': String(LITE_MODEL.bytes) },
      }),
    )
    const corrupt = new Error(
      "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.",
    )
    spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        await openModelFile(id, options)
        if (!entries.has(modelFile(LITE_MODEL))) {
          // The retry downloads and caches a file that is corrupt too.
          const cache = env.customCache as {
            put: (key: string, response: Response) => Promise<void>
          }
          await cache.put(
            modelFile(LITE_MODEL),
            new Response('y', {
              headers: { 'content-length': String(LITE_MODEL.bytes) },
            }),
          )
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        throw corrupt
      },
    )
    await expect(removeBackground(png)).rejects.toMatchObject({
      code: 'model-load-failed',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(entries.has(modelFile(LITE_MODEL))).toBe(false)
  })

  test('callers sharing a corrupt load both get the one retry', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Firefox/150.0' },
    })
    const entries = installCaches(() => undefined)
    entries.set(
      modelFile(LITE_MODEL),
      new Response('x', {
        headers: { 'content-length': String(LITE_MODEL.bytes) },
      }),
    )
    const corrupt = new Error(
      "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.",
    )
    // The first load fails only after both callers have joined it.
    let failFirst: () => void = () => undefined
    const firstLoad = new Promise<void>((resolve) => {
      failFirst = resolve
    })
    let loads = 0
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        loads += 1
        if (loads === 1) {
          await reportLoadProgress(id, options)
          await firstLoad
          throw corrupt
        }
        return model('logits') as never
      },
    )
    const deletes = spyOn(entries, 'delete')
    const shared = sharedLoad(2)
    const running = Promise.all([
      removeBackground(png, { onProgress: shared.caller() }),
      removeBackground(png, { onProgress: shared.caller() }),
    ])
    await shared.joined
    expect(load).toHaveBeenCalledTimes(1)
    failFirst()
    const results = await running
    for (const result of results) {
      expect(result).toMatchObject({ model: 'birefnet-lite', provider: 'wasm' })
    }
    expect(load).toHaveBeenCalledTimes(2)
    // Both callers read the same copy, so it is deleted once.
    expect(
      deletes.mock.calls.filter(([key]) => key === modelFile(LITE_MODEL)),
    ).toHaveLength(1)
  })

  test('a corrupt load evicts its copy after every caller cancelled', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Firefox/150.0' },
    })
    const entries = installCaches(() => undefined)
    entries.set(
      modelFile(LITE_MODEL),
      new Response('x', {
        headers: { 'content-length': String(LITE_MODEL.bytes) },
      }),
    )
    let failFirst: () => void = () => undefined
    const firstLoad = new Promise<void>((resolve) => {
      failFirst = resolve
    })
    let opened: () => void = () => undefined
    const fileOpened = new Promise<void>((resolve) => {
      opened = resolve
    })
    let loads = 0
    spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        loads += 1
        if (loads === 1) {
          await openModelFile(id, options)
          opened()
          await firstLoad
          throw new Error(
            "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.",
          )
        }
        return model('logits') as never
      },
    )
    const controller = new AbortController()
    const pending = removeBackground(png, { signal: controller.signal })
    await fileOpened
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    // Loads that joined this read cannot evict the damaged copy, so the load
    // that read it must, although nobody is waiting for it any more.
    failFirst()
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(entries.has(modelFile(LITE_MODEL))).toBe(false)
  })

  test('a load from before a cache reset keeps the model cached since', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Firefox/150.0' },
    })
    const entries = installCaches(() => undefined)
    entries.set(
      modelFile(LITE_MODEL),
      new Response('x', {
        headers: { 'content-length': String(LITE_MODEL.bytes) },
      }),
    )
    let failFirst: () => void = () => undefined
    const firstLoad = new Promise<void>((resolve) => {
      failFirst = resolve
    })
    let opened: () => void = () => undefined
    const fileOpened = new Promise<void>((resolve) => {
      opened = resolve
    })
    let loads = 0
    spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        loads += 1
        if (loads === 1) {
          await openModelFile(id, options)
          opened()
          await firstLoad
          throw new Error(
            "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.",
          )
        }
        // After the reset, the next load caches a healthy download.
        await (
          env.customCache as {
            put: (key: string, response: Response) => Promise<void>
          }
        ).put(
          modelFile(LITE_MODEL),
          new Response('fresh', {
            headers: { 'content-length': String(LITE_MODEL.bytes) },
          }),
        )
        await openModelFile(id, options)
        return model('logits') as never
      },
    )
    const controller = new AbortController()
    const pending = removeBackground(png, { signal: controller.signal })
    await fileOpened
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    clearModelCache()
    expect(await removeBackground(png)).toMatchObject({
      model: 'birefnet-lite',
    })
    // The load from before the reset read another copy, so it evicts nothing.
    failFirst()
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(await entries.get(modelFile(LITE_MODEL))?.text()).toBe('fresh')
  })

  test('a reset between a load read and its file-open event keeps the new model', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Firefox/150.0' },
    })
    const entries = installCaches(() => undefined)
    entries.set(
      modelFile(LITE_MODEL),
      new Response('x', {
        headers: { 'content-length': String(LITE_MODEL.bytes) },
      }),
    )
    let resumeFirst: () => void = () => undefined
    const firstResumed = new Promise<void>((resolve) => {
      resumeFirst = resolve
    })
    let failFirst: () => void = () => undefined
    const firstFails = new Promise<void>((resolve) => {
      failFirst = resolve
    })
    let read: () => void = () => undefined
    const fileRead = new Promise<void>((resolve) => {
      read = resolve
    })
    let opened: () => void = () => undefined
    const fileOpened = new Promise<void>((resolve) => {
      opened = resolve
    })
    let loads = 0
    spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        loads += 1
        const cache = env.customCache as {
          match: (key: string) => Promise<Response | undefined>
          put: (key: string, response: Response) => Promise<void>
        }
        if (loads === 1) {
          // The first load reads the damaged copy through the old cache and
          // reports opening it only after the reset.
          await cache.match(modelFile(LITE_MODEL))
          read()
          await firstResumed
          reportModelFileOpened(id, options)
          opened()
          await firstFails
          throw new Error(
            "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.",
          )
        }
        await cache.put(
          modelFile(LITE_MODEL),
          new Response('fresh', {
            headers: { 'content-length': String(LITE_MODEL.bytes) },
          }),
        )
        await openModelFile(id, options)
        return model('logits') as never
      },
    )
    const controller = new AbortController()
    const pending = removeBackground(png, { signal: controller.signal })
    await fileRead
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    clearModelCache()
    resumeFirst()
    await fileOpened
    expect(await removeBackground(png)).toMatchObject({
      model: 'birefnet-lite',
    })
    // The first load read a copy of the replaced cache, so it evicts nothing.
    failFirst()
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(await entries.get(modelFile(LITE_MODEL))?.text()).toBe('fresh')
  })

  test('a load that reads through a cache installed after it started evicts its damaged copy', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Firefox/150.0' },
    })
    const entries = installCaches(() => undefined)
    entries.set(
      modelFile(LITE_MODEL),
      new Response('x', {
        headers: { 'content-length': String(LITE_MODEL.bytes) },
      }),
    )
    const gate = () => {
      let open: () => void = () => undefined
      const opened = new Promise<void>((resolve) => {
        open = resolve
      })
      return { open, opened }
    }
    const firstStarted = gate()
    const secondStarted = gate()
    const firstReads = gate()
    const firstOpened = gate()
    const firstFails = gate()
    const secondFails = gate()
    let retrySawDamaged: boolean | undefined
    let loads = 0
    const corrupt = () =>
      new Error(
        "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.",
      )
    spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        loads += 1
        if (loads === 1) {
          // Still preparing when the reset and the next load install a new
          // cache, so it reads the damaged file through that cache.
          firstStarted.open()
          await firstReads.opened
          await openModelFile(id, options)
          firstOpened.open()
          await firstFails.opened
          throw corrupt()
        }
        if (loads === 2) {
          // Joins the first load's read, so it reports no file of its own.
          secondStarted.open()
          await secondFails.opened
          throw corrupt()
        }
        retrySawDamaged = entries.has(modelFile(LITE_MODEL))
        return model('logits') as never
      },
    )
    const controller = new AbortController()
    const first = removeBackground(png, { signal: controller.signal })
    await firstStarted.opened
    controller.abort()
    await expect(first).rejects.toMatchObject({ code: 'cancelled' })
    clearModelCache()
    const second = removeBackground(png)
    await secondStarted.opened
    firstReads.open()
    await firstOpened.opened
    firstFails.open()
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(entries.has(modelFile(LITE_MODEL))).toBe(false)
    secondFails.open()
    expect(await second).toMatchObject({ model: 'birefnet-lite' })
    expect(retrySawDamaged).toBe(false)
  })

  test('a load records the copy it opened, not the copy when it started', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Firefox/150.0' },
    })
    const entries = installCaches(() => undefined)
    entries.set(
      modelFile(LITE_MODEL),
      new Response('x', {
        headers: { 'content-length': String(LITE_MODEL.bytes) },
      }),
    )
    const cache = () =>
      env.customCache as {
        put: (key: string, response: Response) => Promise<void>
        delete: (key: string) => Promise<boolean>
      }
    let openFile: () => void = () => undefined
    const fileReady = new Promise<void>((resolve) => {
      openFile = resolve
    })
    let started: () => void = () => undefined
    const loadStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let retrySawDamaged: boolean | undefined
    let loads = 0
    spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        loads += 1
        if (loads === 1) {
          started()
          await fileReady
          // The file was evicted after this load started. It downloads a
          // replacement that is damaged too, then opens it.
          await cache().put(
            modelFile(LITE_MODEL),
            new Response('y', {
              headers: { 'content-length': String(LITE_MODEL.bytes) },
            }),
          )
          await new Promise((resolve) => setTimeout(resolve, 0))
          await openModelFile(id, options)
          throw new Error(
            "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.",
          )
        }
        retrySawDamaged = entries.has(modelFile(LITE_MODEL))
        return model('logits') as never
      },
    )
    const pending = removeBackground(png)
    await loadStarted
    await cache().delete(modelFile(LITE_MODEL))
    openFile()
    expect(await pending).toMatchObject({
      model: 'birefnet-lite',
      provider: 'wasm',
    })
    expect(retrySawDamaged).toBe(false)
  })

  test('a shared corrupt load keeps the retry download in the cache', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Firefox/150.0' },
    })
    let finishWrite: () => void = () => undefined
    let writes = 0
    const entries = installCaches(async () => {
      writes += 1
      await new Promise<void>((resolve) => {
        finishWrite = resolve
      })
    })
    entries.set(
      modelFile(LITE_MODEL),
      new Response('x', {
        headers: { 'content-length': String(LITE_MODEL.bytes) },
      }),
    )
    const corrupt = new Error(
      "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.",
    )
    let failFirst: () => void = () => undefined
    const firstLoad = new Promise<void>((resolve) => {
      failFirst = resolve
    })
    let loads = 0
    spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        loads += 1
        if (loads === 1) {
          await reportLoadProgress(id, options)
          await firstLoad
          throw corrupt
        }
        // The retry downloads a fresh file; its cache write lands later.
        const cache = env.customCache as {
          put: (key: string, response: Response) => Promise<void>
        }
        await cache.put(
          modelFile(LITE_MODEL),
          new Response('fresh', {
            headers: { 'content-length': String(LITE_MODEL.bytes) },
          }),
        )
        return model('logits') as never
      },
    )
    const shared = sharedLoad(2)
    const running = Promise.all([
      removeBackground(png, { onProgress: shared.caller() }),
      removeBackground(png, {
        onProgress: shared.caller(),
        signal: new AbortController().signal,
      }),
    ])
    await shared.joined
    failFirst()
    await running
    expect(writes).toBe(1)
    finishWrite()
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(await entries.get(modelFile(LITE_MODEL))?.text()).toBe('fresh')
  })

  test('a cached model with the wrong size is ignored and removed', async () => {
    const entries = installCaches(() => undefined)
    entries.set(
      modelFile(FULL_MODEL),
      new Response('x', { headers: { 'content-length': '4096' } }),
    )
    const events: string[] = []
    spyOn(AutoModel, 'from_pretrained').mockResolvedValue(
      model('logits') as never,
    )
    await removeBackground(png, {
      onProgress: (event) => events.push(event.message),
    })
    expect(entries.has(modelFile(FULL_MODEL))).toBe(false)
    expect(events).not.toContain('Loading cached model…')
  })

  test('a failed cache write does not fail or delay the load', async () => {
    installCaches(async () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    spyOn(AutoModel, 'from_pretrained').mockImplementation(async () => {
      const cache = env.customCache as {
        put: (key: string, response: Response) => Promise<void>
      }
      await cache.put(modelFile(FULL_MODEL), new Response('model'))
      return model() as never
    })
    expect((await removeBackground(png)).model).toBe('birefnet')
  })

  test('a Cache API that refuses to open falls back to IndexedDB', async () => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: {
        open: async () => {
          throw new DOMException('Cache storage is disabled', 'SecurityError')
        },
      },
    })
    const stored = new Map<string, Response>()
    const available = spyOn(cacheModule, 'isIndexedDbAvailable')
    available.mockReturnValue(true)
    spyOn(cacheModule, 'createIndexedDbCache').mockReturnValue({
      match: async (key) => stored.get(String(key))?.clone(),
      put: async (key, response) => {
        stored.set(String(key), response)
      },
      delete: async (key) => stored.delete(String(key)),
    })
    spyOn(AutoModel, 'from_pretrained').mockImplementation(async () => {
      const cache = env.customCache as {
        put: (key: string, response: Response) => Promise<void>
      }
      await cache.put(modelFile(FULL_MODEL), new Response('model'))
      return model() as never
    })
    expect((await removeBackground(png)).model).toBe('birefnet')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stored.has(modelFile(FULL_MODEL))).toBe(true)
    // clearModelCache runs before mocks are restored and would reach for a
    // real IndexedDB, which this runtime does not have.
    available.mockRestore()
  })

  test('network failures surface a useful error without disabling WebGPU', async () => {
    let online = false
    env.fetch = mock(async () => {
      if (!online) throw new TypeError('Failed to fetch')
      return new Response('ok')
    })
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id) => {
        await (
          await env.fetch(`https://huggingface.co/${id}/config.json`)
        ).arrayBuffer()
        return model('logits') as never
      },
    )
    await expect(removeBackground(png)).rejects.toMatchObject({
      code: 'model-load-failed',
      message:
        'The local model could not be loaded. Check your connection and try again.',
    })
    // The lite file is shared by both runtimes, so it is not fetched twice,
    // even though the WASM runtime files differ from the WebGPU ones.
    expect(load.mock.calls.map((call) => [call[0], call[1]?.device])).toEqual([
      [FULL_MODEL.id, 'webgpu'],
      [LITE_MODEL.id, 'webgpu'],
    ])
    expect(storage.size).toBe(0)
    online = true
    expect(await removeBackground(png)).toMatchObject({
      model: 'birefnet-lite',
      provider: 'webgpu',
    })
  })

  test('a failed WebGPU runtime file falls back to lite WASM', async () => {
    let online = false
    env.fetch = mock(async (input: RequestInfo | URL) => {
      if (!online && String(input).includes('jsep')) {
        throw new TypeError('Failed to fetch')
      }
      return new Response('ok')
    })
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        await (
          await env.fetch(`https://huggingface.co/${id}/config.json`)
        ).arrayBuffer()
        const runtime =
          options?.device === 'webgpu'
            ? 'ort-wasm-simd-threaded.jsep.wasm'
            : 'ort-wasm-simd-threaded.wasm'
        await (
          await env.fetch(`https://cdn.jsdelivr.net/npm/ort/dist/${runtime}`)
        ).arrayBuffer()
        return model('logits') as never
      },
    )
    expect(await removeBackground(png)).toMatchObject({
      model: 'birefnet-lite',
      provider: 'wasm',
    })
    // The model files were reachable, so only the GPU runtime is skipped.
    expect(load.mock.calls.map((call) => [call[0], call[1]?.device])).toEqual([
      [FULL_MODEL.id, 'webgpu'],
      [LITE_MODEL.id, 'wasm'],
    ])
    expect(storage.size).toBe(0)
    online = true
    expect(await removeBackground(png)).toMatchObject({
      model: 'birefnet',
      provider: 'webgpu',
    })
  })

  function stalledResponse() {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4))
        },
      }),
    )
  }

  test('a stalled full-model download falls back to the lite model', async () => {
    modelLoadTimings.stallMs = 20
    env.fetch = mock(async () => stalledResponse())
    spyOn(AutoModel, 'from_pretrained').mockImplementation(async (id) => {
      if (id === FULL_MODEL.id) {
        await (await env.fetch(modelFile(FULL_MODEL))).arrayBuffer()
      }
      return model('logits') as never
    })
    expect(await removeBackground(png)).toMatchObject({
      model: 'birefnet-lite',
      provider: 'webgpu',
    })
    expect(storage.size).toBe(0)
  })

  test('a download that stalls on every model ends with a retryable error', async () => {
    modelLoadTimings.stallMs = 20
    env.fetch = mock(async () => stalledResponse())
    spyOn(AutoModel, 'from_pretrained').mockImplementation(async (id) => {
      await (
        await env.fetch(`https://huggingface.co/${id}/x.onnx`)
      ).arrayBuffer()
      return model('logits') as never
    })
    await expect(removeBackground(png)).rejects.toMatchObject({
      code: 'model-load-failed',
      message:
        'The model download stopped responding. Check your connection and try again.',
    })
  })

  test('a model that never finishes starting stops the walk and skips the full model next time', async () => {
    modelLoadTimings.startMs = 20
    let finish: (value: never) => void = () => undefined
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        if (id !== FULL_MODEL.id) return model('logits') as never
        options?.progress_callback?.({
          status: 'done',
          name: id,
          file: 'onnx/model_fp16.onnx',
        })
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    )
    await expect(removeBackground(png)).rejects.toMatchObject({
      code: 'model-load-failed',
      message:
        'The local model took too long to start. Reload the page and try again.',
    })
    expect(load).toHaveBeenCalledTimes(1)
    expect(storage.has('bg0:full-model-blocked:v1')).toBe(true)
    expect((await removeBackground(png)).model).toBe('birefnet-lite')
    // Let the abandoned load end so its crash marker is released.
    finish(model('logits') as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  test('a timed-out full model keeps its crash marker until the load really stops', async () => {
    modelLoadTimings.startMs = 20
    const session = new Map<string, string>()
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => session.get(key) ?? null,
        setItem: (key: string, value: string) => session.set(key, value),
        removeItem: (key: string) => session.delete(key),
      },
    })
    let finish: (value: never) => void = () => undefined
    spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        if (id !== FULL_MODEL.id) return model('logits') as never
        options?.progress_callback?.({
          status: 'done',
          name: id,
          file: 'onnx/model_fp16.onnx',
        })
        return new Promise((resolve) => {
          finish = resolve
        })
      },
    )
    await expect(removeBackground(png)).rejects.toMatchObject({
      code: 'model-load-failed',
    })
    // Session creation is still running, and it can still kill the tab.
    expect(session.has('bg0:full-model-running:v1')).toBe(true)
    finish(model('logits') as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(session.has('bg0:full-model-running:v1')).toBe(false)
  })

  test('a tab that died during full-model work uses the lite model after reload', async () => {
    const session = new Map([['bg0:full-model-running:v1', '1']])
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => session.get(key) ?? null,
        setItem: (key: string, value: string) => session.set(key, value),
        removeItem: (key: string) => session.delete(key),
      },
    })
    const load = spyOn(AutoModel, 'from_pretrained').mockResolvedValue(
      model('logits') as never,
    )
    expect((await removeBackground(png)).model).toBe('birefnet-lite')
    expect(load.mock.calls[0][0]).toBe(LITE_MODEL.id)
    expect(session.size).toBe(0)
  })

  test('cancelling stops waiting on a model that is still loading', async () => {
    modelLoadTimings.startMs = 200
    let finish: (value: never) => void = () => undefined
    spyOn(AutoModel, 'from_pretrained').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const controller = new AbortController()
    const pending = removeBackground(png, { signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    const startedAt = performance.now()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(performance.now() - startedAt).toBeLessThan(150)
    // Settle the shared load so its watchdog does not supervise later tests.
    finish(model() as never)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  test('a load that fails after every caller cancelled is not reused', async () => {
    let failFirst: ((error: Error) => void) | undefined
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation((() => {
      if (!failFirst) {
        return new Promise((_resolve, reject) => {
          failFirst = reject
        })
      }
      return Promise.resolve(model())
    }) as never)
    const controller = new AbortController()
    const pending = removeBackground(png, { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    failFirst?.(new Error('device lost'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The next image starts a fresh load of the same model instead of
    // inheriting the failure and falling back.
    expect((await removeBackground(png)).model).toBe('birefnet')
    expect(load.mock.calls.map((call) => call[0])).toEqual([
      FULL_MODEL.id,
      FULL_MODEL.id,
    ])
  })

  test('reports downloaded bytes and the runtime while the model downloads', async () => {
    spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        options?.progress_callback?.({
          status: 'progress',
          name: id,
          file: 'onnx/model_fp16.onnx',
          progress: 40,
          loaded: 40_000_000,
          total: 100_000_000,
        })
        return model() as never
      },
    )
    const events: Parameters<
      NonNullable<Parameters<typeof removeBackground>[1]>['onProgress'] & object
    >[0][] = []
    await removeBackground(png, { onProgress: (event) => events.push(event) })
    const downloading = events.find((event) => event.stage === 'downloading')
    expect(downloading).toMatchObject({
      message: 'Downloading local model…',
      provider: 'webgpu',
      download: { loadedBytes: 40_000_000 },
    })
    expect(downloading?.download?.totalBytes).toBeGreaterThanOrEqual(
      100_000_000,
    )
    expect(
      events.filter((event) => event.stage !== 'downloading' && event.download),
    ).toEqual([])
  })

  describe('pinned model tiers', () => {
    async function until(condition: () => boolean) {
      for (let tries = 0; tries < 200 && !condition(); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      expect(condition()).toBe(true)
    }

    /** The full model downloads until its request is aborted; lite loads. */
    function stallFullDownload() {
      const signals: AbortSignal[] = []
      env.fetch = mock(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.signal) signals.push(init.signal)
          return stalledResponse()
        },
      )
      const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
        async (id) => {
          if (id === FULL_MODEL.id && signals.length === 0) {
            await (await env.fetch(modelFile(FULL_MODEL))).arrayBuffer()
          }
          return model('logits') as never
        },
      )
      return { signals, load }
    }

    test('lite skips the full model on a device that could run it', async () => {
      const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
        async (id, options) => {
          options?.progress_callback?.({
            status: 'progress',
            name: id,
            file: 'onnx/model_fp16.onnx',
            progress: 50,
            loaded: 1,
            total: 2,
          })
          return model('logits') as never
        },
      )
      const events: RemovalProgress[] = []
      const result = await removeBackground(png, {
        model: 'lite',
        onProgress: (event) => events.push(event),
      })
      expect(result).toMatchObject({
        model: 'birefnet-lite',
        provider: 'webgpu',
      })
      expect(load.mock.calls.map((call) => call[0])).toEqual([LITE_MODEL.id])
      expect(
        events.find((event) => event.stage === 'downloading'),
      ).toMatchObject({ model: 'birefnet-lite', provider: 'webgpu' })
      // Every event after the engine is chosen names it, through finishing.
      const chosen = events.slice(
        events.findIndex((event) => event.model !== undefined),
      )
      expect(chosen.map((event) => event.message)).toContain(
        'Background removed',
      )
      expect(chosen.every((event) => event.model === 'birefnet-lite')).toBe(
        true,
      )
    })

    test('full runs the full model on a device detection would keep on lite', async () => {
      Object.assign(globalThis.navigator, { deviceMemory: 2 })
      const load = spyOn(AutoModel, 'from_pretrained').mockResolvedValue(
        model('logits') as never,
      )
      expect(await removeBackground(png)).toMatchObject({
        model: 'birefnet-lite',
      })
      expect(await removeBackground(png, { model: 'full' })).toMatchObject({
        model: 'birefnet',
        provider: 'webgpu',
      })
      expect(await prepareBackgroundRemoval({ model: 'full' })).toBe('webgpu')
      expect(load.mock.calls.map((call) => call[0])).toEqual([
        LITE_MODEL.id,
        FULL_MODEL.id,
      ])
    })

    test('choosing lite stops a full download nobody waits on, without marking it failed', async () => {
      const { signals, load } = stallFullDownload()
      const warm = new AbortController()
      const warming = prepareBackgroundRemoval({ signal: warm.signal })
      await until(() => signals.length === 1)
      warm.abort()
      await expect(warming).rejects.toMatchObject({ code: 'cancelled' })
      // Cancelling alone keeps the shared download going for the next image.
      expect(signals[0].aborted).toBe(false)

      expect(await removeBackground(png, { model: 'lite' })).toMatchObject({
        model: 'birefnet-lite',
      })
      expect(signals[0].aborted).toBe(true)

      // Switching back starts the full model again instead of skipping it.
      expect(await removeBackground(png)).toMatchObject({ model: 'birefnet' })
      expect(load.mock.calls.map((call) => call[0])).toEqual([
        FULL_MODEL.id,
        LITE_MODEL.id,
        FULL_MODEL.id,
      ])
      expect(storage.size).toBe(0)
    })

    test('a load stopped while its processor loads never fetches the full weights', async () => {
      let finishProcessor: (value: never) => void = () => undefined
      spyOn(AutoProcessor, 'from_pretrained').mockImplementation(((
        id: string,
      ) =>
        id === FULL_MODEL.id
          ? new Promise((resolve) => {
              finishProcessor = resolve
            })
          : Promise.resolve(async () => ({ pixel_values: 'pixels' }))) as never)
      const load = spyOn(AutoModel, 'from_pretrained').mockResolvedValue(
        model('logits') as never,
      )
      const warm = new AbortController()
      const warming = prepareBackgroundRemoval({ signal: warm.signal })
      await until(
        () =>
          (AutoProcessor.from_pretrained as ReturnType<typeof spyOn>).mock.calls
            .length === 1,
      )
      warm.abort()
      await expect(warming).rejects.toMatchObject({ code: 'cancelled' })
      expect(await removeBackground(png, { model: 'lite' })).toMatchObject({
        model: 'birefnet-lite',
      })
      finishProcessor((async () => ({ pixel_values: 'pixels' })) as never)
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(load.mock.calls.map((call) => call[0])).toEqual([LITE_MODEL.id])
    })

    test('an already cancelled prepare records lite without loading anything', async () => {
      const { signals, load } = stallFullDownload()
      const warm = new AbortController()
      const warming = prepareBackgroundRemoval({ signal: warm.signal })
      await until(() => signals.length === 1)
      warm.abort()
      await expect(warming).rejects.toMatchObject({ code: 'cancelled' })
      await expect(
        prepareBackgroundRemoval({
          model: 'lite',
          signal: AbortSignal.abort(),
        }),
      ).rejects.toMatchObject({ code: 'cancelled' })
      // The stop settles a few microtasks later, once the load's race rejects.
      await until(() => signals[0].aborted)
      expect(load.mock.calls.map((call) => call[0])).toEqual([FULL_MODEL.id])
    })

    test('choosing lite releases a loaded full session nobody holds', async () => {
      const full = model('logits')
      const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
        async (id) => (id === FULL_MODEL.id ? full : model('logits')) as never,
      )
      expect(await removeBackground(png)).toMatchObject({ model: 'birefnet' })
      expect(full.dispose).not.toHaveBeenCalled()

      expect(await removeBackground(png, { model: 'lite' })).toMatchObject({
        model: 'birefnet-lite',
      })
      expect(full.dispose).toHaveBeenCalledTimes(1)

      // Auto loads the full model again rather than reusing the released one.
      expect(await removeBackground(png)).toMatchObject({ model: 'birefnet' })
      expect(load.mock.calls.map((call) => call[0])).toEqual([
        FULL_MODEL.id,
        LITE_MODEL.id,
        FULL_MODEL.id,
      ])
    })

    test('a full session that finishes starting after lite was chosen is released', async () => {
      let finishFull: (value: never) => void = () => undefined
      const full = model('logits')
      spyOn(AutoModel, 'from_pretrained').mockImplementation(((
        id: string,
        options?: { progress_callback?: (event: unknown) => void },
      ) => {
        if (id !== FULL_MODEL.id) return Promise.resolve(model('logits'))
        // The weights are in: the session is starting and cannot be stopped.
        options?.progress_callback?.({
          status: 'done',
          name: id,
          file: 'onnx/model_fp16.onnx',
        })
        return new Promise((resolve) => {
          finishFull = resolve
        })
      }) as never)
      const warm = new AbortController()
      const warming = prepareBackgroundRemoval({ signal: warm.signal })
      await until(
        () =>
          (AutoModel.from_pretrained as ReturnType<typeof spyOn>).mock.calls
            .length === 1,
      )
      warm.abort()
      await expect(warming).rejects.toMatchObject({ code: 'cancelled' })
      expect(await removeBackground(png, { model: 'lite' })).toMatchObject({
        model: 'birefnet-lite',
      })
      finishFull(full as never)
      await until(() => full.dispose.mock.calls.length === 1)
    })

    test('a full download a caller still waits on continues until that caller leaves', async () => {
      const { signals } = stallFullDownload()
      const first = new AbortController()
      const waiting = removeBackground(png, { signal: first.signal })
      await until(() => signals.length === 1)

      expect(await removeBackground(png, { model: 'lite' })).toMatchObject({
        model: 'birefnet-lite',
      })
      expect(signals[0].aborted).toBe(false)

      first.abort()
      await expect(waiting).rejects.toMatchObject({ code: 'cancelled' })
      await until(() => signals[0].aborted)
    })

    test('auto and full keep a full download running', async () => {
      const { signals } = stallFullDownload()
      const warm = new AbortController()
      const warming = prepareBackgroundRemoval({ signal: warm.signal })
      await until(() => signals.length === 1)
      warm.abort()
      await expect(warming).rejects.toMatchObject({ code: 'cancelled' })
      void prepareBackgroundRemoval({
        model: 'full',
        signal: AbortSignal.abort(),
      }).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(signals[0].aborted).toBe(false)
    })
  })
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
    expect((image.maskToPng as ReturnType<typeof spyOn>).mock.calls[0][0]).toBe(
      pngBitmap,
    )
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
test.each(['no-context', 'draw', 'pixels'])(
  'failed refinement releases its canvas: %s',
  async (failure) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const canvas = {
      width: 0,
      height: 0,
      getContext: () =>
        failure === 'no-context'
          ? null
          : {
              drawImage() {
                if (failure === 'draw') throw new Error('draw failed')
              },
              getImageData() {
                throw new Error('pixels unavailable')
              },
            },
    }
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => canvas },
    })
    spyOn(AutoModel, 'from_pretrained').mockResolvedValue(model() as never)
    const closed = mock(() => undefined)
    spyOn(image, 'decodeImage').mockResolvedValue({
      width: 800,
      height: 600,
      close: closed,
    } as unknown as ImageBitmap)
    try {
      expect((await removeBackground(png, { quality: 'quality' })).blob).toBe(
        png,
      )
      expect([canvas.width, canvas.height]).toEqual([0, 0])
      expect(closed).toHaveBeenCalledTimes(2)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'document', descriptor)
      else Reflect.deleteProperty(globalThis, 'document')
    }
  },
)
