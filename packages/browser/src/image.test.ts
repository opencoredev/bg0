import { describe, expect, test } from 'bun:test'
import { BackgroundRemovalError } from './errors'
import {
  findRefinementCrop,
  inspectMask,
  MAX_IMAGE_BYTES,
  maskToPng,
  validateImage,
} from './image'

describe('validateImage', () => {
  test('accepts supported image formats', () => {
    expect(() =>
      validateImage(new Blob(['image'], { type: 'image/png' })),
    ).not.toThrow()
  })

  test('rejects unsupported formats with a product error', () => {
    expect(() =>
      validateImage(new Blob(['image'], { type: 'image/gif' })),
    ).toThrow(BackgroundRemovalError)
  })

  test('rejects images over the local limit', () => {
    const image = new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], {
      type: 'image/jpeg',
    })
    expect(() => validateImage(image)).toThrow('over 40 MB')
  })
})

describe('inspectMask', () => {
  test('accepts a finite mask with foreground signal', () => {
    expect(inspectMask(new Float32Array([0.01, 0.12, 0.7, 0.99]), 4)).toEqual({
      valid: true,
      hasForegroundSignal: true,
    })
  })

  test('identifies the flat transparent output seen on broken WebGPU runs', () => {
    expect(inspectMask(new Float32Array(16), 16)).toEqual({
      valid: true,
      hasForegroundSignal: false,
    })
  })

  test('rejects malformed or non-finite tensors', () => {
    expect(inspectMask(new Float32Array([0, Number.NaN]), 2).valid).toBe(false)
    expect(inspectMask(new Float32Array([0, 1]), 3).valid).toBe(false)
  })
})

describe('findRefinementCrop', () => {
  test('returns a padded crop for a compact subject', () => {
    const mask = new Float32Array(100)
    for (let y = 3; y <= 6; y += 1) {
      for (let x = 3; x <= 6; x += 1) mask[y * 10 + x] = 1
    }

    expect(findRefinementCrop(mask, 10, 10, 1000, 1000)).toEqual({
      left: 252,
      top: 252,
      right: 748,
      bottom: 748,
    })
  })

  test('skips a second pass when the subject already fills the frame', () => {
    expect(
      findRefinementCrop(new Float32Array(100).fill(1), 10, 10, 1000, 1000),
    ).toBeNull()
  })

  test('skips sparse subjects when a crop would add little resolution', () => {
    const mask = new Float32Array(10_000)
    for (let x = 0; x < 100; x += 1) mask[20 * 100 + x] = 1
    for (let x = 0; x < 100; x += 1) mask[79 * 100 + x] = 1

    expect(findRefinementCrop(mask, 100, 100, 1000, 1000)).toBeNull()
  })

  test('ignores empty and tiny artifact masks', () => {
    expect(
      findRefinementCrop(new Float32Array(100), 10, 10, 1000, 1000),
    ).toBeNull()

    const artifact = new Float32Array(100)
    artifact[55] = 1
    expect(findRefinementCrop(artifact, 10, 10, 20, 20)).toBeNull()
  })
})

describe('maskToPng refinement', () => {
  test('replaces only the crop while retaining the full base mask', async () => {
    const originalDocument = globalThis.document
    const canvases: FakeCanvas[] = []
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => {
          const canvas = new FakeCanvas()
          canvases.push(canvas)
          return canvas
        },
      } as unknown as Document,
    })

    try {
      const image = { width: 4, height: 4 } as ImageBitmap
      await maskToPng(
        image,
        new Float32Array([0, 0.25, 0.5, 1]),
        2,
        2,
        'quality',
        {
          mask: new Float32Array([1]),
          maskWidth: 1,
          maskHeight: 1,
          crop: { left: 1, top: 1, right: 3, bottom: 3 },
        },
      )

      expect(canvases).toHaveLength(4)
      expect(canvases[0]?.context.imageData?.data.filter((_, index) => index % 4 === 3)).toEqual(
        new Uint8ClampedArray([0, 64, 128, 255]),
      )
      expect(canvases[2]?.context.imageData?.data[3]).toBe(255)
      expect(canvases[1]?.context.drawCalls[0]?.slice(1)).toEqual([
        0, 0, 4, 4,
      ])
      expect(canvases[1]?.context.clearCalls).toEqual([[1, 1, 2, 2]])
      expect(canvases[1]?.context.drawCalls[1]?.slice(1)).toEqual([
        1, 1, 2, 2,
      ])
      expect(canvases[3]?.context.drawCalls[1]?.[0]).toBe(canvases[1])
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      })
    }
  })
})

class FakeCanvas {
  width = 0
  height = 0
  readonly context = new FakeCanvasContext()

  getContext() {
    return this.context
  }

  toBlob(callback: (blob: Blob | null) => void) {
    callback(new Blob(['png'], { type: 'image/png' }))
  }
}

class FakeCanvasContext {
  globalCompositeOperation = 'source-over'
  imageSmoothingEnabled = false
  imageSmoothingQuality: ImageSmoothingQuality = 'low'
  imageData: ImageData | undefined
  readonly clearCalls: number[][] = []
  readonly drawCalls: unknown[][] = []

  createImageData(width: number, height: number) {
    return {
      colorSpace: 'srgb',
      data: new Uint8ClampedArray(width * height * 4),
      height,
      width,
    } as ImageData
  }

  putImageData(imageData: ImageData) {
    this.imageData = imageData
  }

  clearRect(...values: number[]) {
    this.clearCalls.push(values)
  }

  drawImage(...values: unknown[]) {
    this.drawCalls.push(values)
  }
}
