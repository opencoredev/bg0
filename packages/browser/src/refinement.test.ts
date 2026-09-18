import { describe, expect, mock, test } from 'bun:test'
import { RawImage } from '@huggingface/transformers'
import type { InferenceMask } from './refinement'
import { createMaskRefinement } from './refinement'

function compactMask(): InferenceMask {
  const alpha = new Float32Array(100)
  for (let y = 3; y <= 6; y += 1) {
    for (let x = 3; x <= 6; x += 1) alpha[y * 10 + x] = 1
  }
  return {
    alpha,
    maskWidth: 10,
    maskHeight: 10,
    inspection: { valid: true, hasForegroundSignal: true },
  }
}

function source(): RawImage {
  const image = {
    width: 100,
    height: 100,
    clone: () => ({ crop: async () => image }),
  }
  return image as unknown as RawImage
}

describe('createMaskRefinement', () => {
  test('runs a focused inference only for quality mode', async () => {
    const infer = mock(async () => compactMask())
    const onRefining = mock(() => undefined)

    expect(
      await createMaskRefinement({
        quality: 'fast',
        source: source(),
        outputWidth: 400,
        outputHeight: 200,
        base: compactMask(),
        onRefining,
        infer,
      }),
    ).toBeUndefined()
    expect(infer).not.toHaveBeenCalled()

    await expect(
      createMaskRefinement({
        quality: 'quality',
        source: source(),
        outputWidth: 400,
        outputHeight: 200,
        base: compactMask(),
        onRefining,
        infer,
      }),
    ).resolves.toMatchObject({
      crop: { left: 100, top: 50, right: 300, bottom: 150 },
    })
    expect(infer).toHaveBeenCalledTimes(1)
    expect(onRefining).toHaveBeenCalledTimes(1)
  })

  test('uses highResSource and inclusive crop bounds when provided', async () => {
    let croppedBox: number[] | undefined
    const highRes = {
      width: 400,
      height: 200,
      clone: () => ({
        crop: async (box: number[]) => {
          croppedBox = box
          return highRes
        },
      }),
    } as unknown as RawImage

    const infer = mock(async () => compactMask())
    const result = await createMaskRefinement({
      quality: 'quality',
      source: source(),
      highResSource: highRes,
      outputWidth: 400,
      outputHeight: 200,
      base: compactMask(),
      onRefining: () => undefined,
      infer,
    })

    expect(infer).toHaveBeenCalledTimes(1)
    expect(croppedBox).toEqual([100, 40, 299, 159])
    expect(result?.crop).toEqual({ left: 100, top: 40, right: 300, bottom: 160 })
  })

  test('verifies RawImage.crop produces exact inclusive dimensions', async () => {
    const raw = new RawImage(new Uint8Array(400 * 200 * 4), 400, 200, 4)
    const cropped = await raw.crop([100, 40, 299, 159])
    expect(cropped.width).toBe(200)
    expect(cropped.height).toBe(120)
  })

  test('keeps the base result when optional inference fails', async () => {
    const infer = mock(async () => {
      throw new Error('refinement allocation failed')
    })

    await expect(
      createMaskRefinement({
        quality: 'quality',
        source: source(),
        outputWidth: 400,
        outputHeight: 200,
        base: compactMask(),
        onRefining: () => undefined,
        infer,
      }),
    ).resolves.toBeUndefined()
  })

  test.each([
    { valid: false, hasForegroundSignal: false },
    { valid: true, hasForegroundSignal: false },
  ])('ignores an unusable refined mask: %o', async (inspection) => {
    await expect(
      createMaskRefinement({
        quality: 'quality',
        source: source(),
        outputWidth: 400,
        outputHeight: 200,
        base: compactMask(),
        onRefining: () => undefined,
        infer: async () => ({ ...compactMask(), inspection }),
      }),
    ).resolves.toBeUndefined()
  })

  test('honors cancellation while focused inference is running', async () => {
    let releaseRefinement: () => void = () => undefined
    const waiting = new Promise<void>((resolve) => {
      releaseRefinement = resolve
    })
    const controller = new AbortController()
    const result = createMaskRefinement({
      quality: 'quality',
      source: source(),
      outputWidth: 400,
      outputHeight: 200,
      base: compactMask(),
      signal: controller.signal,
      onRefining: () => undefined,
      infer: async () => {
        await waiting
        return compactMask()
      },
    })

    controller.abort()
    releaseRefinement()

    await expect(result).rejects.toMatchObject({ code: 'cancelled' })
  })
})
