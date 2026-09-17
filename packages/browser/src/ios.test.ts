import { describe, expect, test } from 'bun:test'
import { IosWorker } from './ios'
import { iosOutputSize, normalizeIosPixels } from './ios-pixels'

function fakeWorker() {
  const sent: { id: number; type: string }[] = []
  const worker = {
    onmessage: undefined as ((event: { data: object }) => void) | undefined,
    onerror: undefined as (() => void) | undefined,
    onmessageerror: undefined as (() => void) | undefined,
    terminated: false,
    postMessage(message: { id: number; type: string }) {
      sent.push(message)
    },
    terminate() {
      this.terminated = true
    },
  }
  return {
    worker,
    sent,
    engine: new IosWorker(() => worker as unknown as Worker),
  }
}

describe('iOS runtime lifetime', () => {
  test('initialization is shared and stale replies are ignored', async () => {
    const { worker, sent, engine } = fakeWorker()
    const first = engine.load()
    const second = engine.load()
    expect(sent).toHaveLength(1)
    worker.onmessage?.({ data: { id: 99, ready: true } })
    worker.onmessage?.({ data: { id: sent[0].id, ready: true } })
    await Promise.all([first, second])
    expect(engine.load()).toBe(first)
    engine.dispose()
    expect(worker.terminated).toBe(true)
  })
  test('worker death settles pending initialization instead of hanging', async () => {
    const { worker, engine } = fakeWorker()
    const result = engine.load()
    worker.onerror?.()
    await expect(result).rejects.toMatchObject({ code: 'model-load-failed' })
    expect(worker.terminated).toBe(true)
  })
  test('disposal cancels pending inference and frees the worker', async () => {
    const { worker, sent, engine } = fakeWorker()
    const result = engine.run(new Uint8ClampedArray(512 * 512 * 4))
    expect(sent[0].type).toBe('run')
    engine.dispose()
    await expect(result).rejects.toThrow('Worker stopped')
    expect(worker.terminated).toBe(true)
  })
  test('invalid output shape never reaches compositing', async () => {
    const { worker, sent, engine } = fakeWorker()
    const result = engine.run(new Uint8ClampedArray(512 * 512 * 4))
    worker.onmessage?.({ data: { id: sent[0].id, alpha: new ArrayBuffer(4) } })
    await expect(result).rejects.toThrow('Invalid mask shape')
    engine.dispose()
  })
  test('raw worker errors are not surfaced to users', async () => {
    const { worker, sent, engine } = fakeWorker()
    const result = engine.load()
    worker.onmessage?.({ data: { id: sent[0].id, error: 'model-load-failed' } })
    await expect(result).rejects.toMatchObject({
      code: 'model-load-failed',
      message:
        'The local model could not be loaded. Check your connection and try again.',
    })
    engine.dispose()
  })
})

describe('iOS bounded image path', () => {
  test('camera exports are bounded without stretching or upscaling', () => {
    expect(iosOutputSize(4032, 3024)).toEqual({ width: 1280, height: 960 })
    expect(iosOutputSize(3024, 4032)).toEqual({ width: 960, height: 1280 })
    expect(iosOutputSize(768, 512)).toEqual({ width: 768, height: 512 })
  })
  test('normalizes RGB independently of alpha using ImageNet constants', () => {
    const pixels = new Uint8ClampedArray([255, 0, 128, 255, 0, 255, 64, 0])
    const data = normalizeIosPixels(pixels, 2, 1)
    expect(data[0]).toBeCloseTo((1 - 0.485) / 0.229)
    expect(data[1]).toBeCloseTo(-0.485 / 0.229)
    expect(data[2]).toBeCloseTo(-0.456 / 0.224)
    expect(data[3]).toBeCloseTo((1 - 0.456) / 0.224)
    expect(data[4]).toBeCloseTo((128 / 255 - 0.406) / 0.225)
    expect(data[5]).toBeCloseTo((64 / 255 - 0.406) / 0.225)
    expect(() => normalizeIosPixels(pixels, 3, 1)).toThrow(
      'Invalid pixel buffer',
    )
  })
})

// Exercise the public API routing and abort boundary, not just the RPC helper.
import { afterEach, beforeEach, mock, spyOn } from 'bun:test'
import * as image from './image'
import { clearModelCache, removeBackground } from './index'
import { AutoModel } from '@huggingface/transformers'
const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const savedWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
const png = new Blob(['png'], { type: 'image/png' })
let constructed = 0
let disposed = 0
beforeEach(() => {
  constructed = disposed = 0
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'iPhone Safari/605.1', maxTouchPoints: 5 },
  })
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    value: class {
      onmessage?: (event: { data: object }) => void
      constructor() {
        constructed++
      }
      postMessage(message: { id: number; type: string }) {
        queueMicrotask(() =>
          this.onmessage?.({
            data:
              message.type === 'load'
                ? { id: message.id, ready: true }
                : {
                    id: message.id,
                    alpha: new Float32Array(512 * 512).fill(0.5).buffer,
                  },
          }),
        )
      }
      terminate() {
        disposed++
      }
    },
  })
  spyOn(image, 'validateImage').mockResolvedValue('png')
  spyOn(image, 'prepareImageForInference').mockResolvedValue({
    data: new Uint8ClampedArray(512 * 512 * 4),
    width: 512,
    height: 512,
    sourceWidth: 768,
    sourceHeight: 512,
  })
  spyOn(image, 'decodeImage').mockResolvedValue({
    width: 768,
    height: 512,
    close() {},
  } as ImageBitmap)
  spyOn(image, 'imageToPng').mockResolvedValue(png)
  spyOn(image, 'maskToPng').mockResolvedValue(png)
})
afterEach(() => {
  clearModelCache()
  mock.restore()
  for (const [name, descriptor] of [
    ['navigator', savedNavigator],
    ['Worker', savedWorker],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

test('public iPhone flow reuses worker and never initializes Transformers', async () => {
  const load = spyOn(AutoModel, 'from_pretrained')
  const [first, second] = await Promise.all([
    removeBackground(png),
    removeBackground(png),
  ])
  expect(first).toMatchObject({
    width: 768,
    height: 512,
    provider: 'wasm',
    model: 'birefnet-lite',
    sourceBlob: png,
  })
  expect(second.blob).toBe(png)
  expect(constructed).toBe(1)
  expect(load).not.toHaveBeenCalled()
})

test('abort at processing frees worker and a fresh request recovers', async () => {
  const abort = new AbortController()
  await expect(
    removeBackground(png, {
      signal: abort.signal,
      onProgress: ({ stage }) => {
        if (stage === 'processing') abort.abort()
      },
    }),
  ).rejects.toMatchObject({ code: 'cancelled' })
  expect(disposed).toBe(1)
  expect((await removeBackground(png)).blob).toBe(png)
  expect(constructed).toBe(2)
})

test('cache clear during finishing preserves active work then retires worker', async () => {
  await removeBackground(png, {
    onProgress: ({ stage }) => {
      if (stage === 'finishing') {
        clearModelCache()
        expect(disposed).toBe(0)
      }
    },
  })
  expect(disposed).toBe(1)
  await removeBackground(png)
  expect(constructed).toBe(2)
})
