import { describe, expect, test } from 'bun:test'
import { BackgroundRemovalError } from './errors'
import {
  decodeImage,
  detectImageFormat,
  findRefinementCrop,
  inspectMask,
  imageToPng,
  MAX_IMAGE_BYTES,
  maskToPng,
  sniffImageFormat,
  validateImage,
} from './image'

describe('validateImage', () => {
  test('accepts the existing browser image formats', async () => {
    await expect(
      validateImage(new Blob(['image'], { type: 'image/png' })),
    ).resolves.toBe('png')
    await expect(
      validateImage(new Blob(['image'], { type: 'image/jpeg' })),
    ).resolves.toBe('jpeg')
    await expect(
      validateImage(new Blob(['image'], { type: 'image/webp' })),
    ).resolves.toBe('webp')
  })

  test('accepts HEIC and HEIF MIME aliases', async () => {
    for (const type of [
      'image/heic',
      'image/heif',
      'image/x-heic',
      'image/x-heif',
    ]) {
      await expect(
        validateImage(new Blob([blobPart(heifHeader('heic'))], { type })),
      ).resolves.toBe('heic')
    }
  })

  test('accepts HEIC by extension when the browser omits its MIME', async () => {
    await expect(
      validateImage(new File([blobPart(heifHeader('heic'))], 'photo.HEIC')),
    ).resolves.toBe('heic')
    await expect(
      validateImage(
        new File([blobPart(heifHeader('mif1', 'heic'))], 'photo.heif', {
          type: 'application/octet-stream',
        }),
      ),
    ).resolves.toBe('heic')
    await expect(
      validateImage(new File([blobPart(heifHeader('heic'))], 'photo.hif')),
    ).resolves.toBe('heic')
  })

  test('rejects sequence MIME types and HEIC labels without an HEVC signature', async () => {
    await expect(
      validateImage(
        new Blob([blobPart(heifHeader('heic'))], {
          type: 'image/heic-sequence',
        }),
      ),
    ).rejects.toMatchObject({ code: 'unsupported-image' })
    await expect(
      validateImage(new Blob(['not HEIF'], { type: 'image/heic' })),
    ).rejects.toMatchObject({ code: 'unsupported-image' })
  })

  test('rejects unsupported formats with a product error', async () => {
    await expect(
      validateImage(new Blob(['image'], { type: 'image/gif' })),
    ).rejects.toBeInstanceOf(BackgroundRemovalError)
  })

  test('rejects images over the local limit', async () => {
    const image = new Blob([new Uint8Array(MAX_IMAGE_BYTES + 1)], {
      type: 'image/jpeg',
    })
    await expect(validateImage(image)).rejects.toThrow('over 40 MB')
  })
})

describe('image format detection', () => {
  test('sniffs HEIF brands with an empty or generic MIME', async () => {
    const heic = heifHeader('heic')
    const heif = heifHeader('mif1', 'heic')

    expect(sniffImageFormat(heic)).toBe('heic')
    expect(sniffImageFormat(heif)).toBe('heic')
    await expect(detectImageFormat(new Blob([blobPart(heic)]))).resolves.toBe(
      'heic',
    )
    await expect(
      detectImageFormat(
        new Blob([blobPart(heif)], { type: 'application/octet-stream' }),
      ),
    ).resolves.toBe('heic')
  })

  test('does not treat unrelated ISO media or misleading extensions as HEIF', async () => {
    expect(sniffImageFormat(isoMediaHeader(['avif', 'mif1']))).toBeNull()
    expect(sniffImageFormat(isoMediaHeader(['avif'], ['heic']))).toBeNull()
    expect(
      sniffImageFormat(isoMediaHeader(['avif', 'mif1'], [], 'heic')),
    ).toBeNull()
    await expect(
      detectImageFormat(
        new File(['not an image'], 'photo.heic', { type: 'image/gif' }),
      ),
    ).resolves.toBeNull()
  })

  test('rejects every HEIC sequence brand with generic metadata', async () => {
    for (const brand of ['hevc', 'hevx', 'hevm', 'hevs', 'msf1']) {
      const sequence = blobPart(isoMediaHeader([brand, 'heic']))
      await expect(detectImageFormat(new Blob([sequence]))).resolves.toBeNull()
      await expect(
        detectImageFormat(
          new File([sequence], 'sequence.heic', {
            type: 'application/octet-stream',
          }),
        ),
      ).resolves.toBeNull()
    }
  })

  test('sequence signatures override supported legacy metadata', async () => {
    const legacyMimes = [
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/pjpeg',
      'image/webp',
    ]
    const legacyNames = [
      'sequence.png',
      'sequence.jpg',
      'sequence.jpeg',
      'sequence.webp',
    ]

    for (const brand of ['hevc', 'hevx', 'hevm', 'hevs', 'msf1']) {
      const sequence = blobPart(isoMediaHeader([brand, 'heic']))
      for (const type of legacyMimes) {
        await expect(
          detectImageFormat(new Blob([sequence], { type })),
        ).resolves.toBeNull()
      }
      for (const name of legacyNames) {
        await expect(
          detectImageFormat(
            new File([sequence], name, { type: 'application/octet-stream' }),
          ),
        ).resolves.toBeNull()
      }
    }
  })

  test('unknown signatures retain legacy metadata fallback', async () => {
    for (const [type, format] of [
      ['image/png', 'png'],
      ['image/jpeg', 'jpeg'],
      ['image/webp', 'webp'],
    ] as const) {
      await expect(
        detectImageFormat(new Blob(['unknown header'], { type })),
      ).resolves.toBe(format)
    }

    await expect(
      detectImageFormat(new File(['unknown header'], 'photo.jpg')),
    ).resolves.toBe('jpeg')
  })

  test('does not treat sequence compatible brands as still images', () => {
    for (const brand of ['hevc', 'hevx', 'hevm', 'hevs', 'msf1']) {
      expect(sniffImageFormat(isoMediaHeader(['mif1', brand]))).toBeNull()
    }
  })

  test('rejects mixed still and unsupported compatible brands in any order', async () => {
    const mixedContainers = [
      isoMediaHeader(['heic', 'hevc']),
      isoMediaHeader(['heic', 'avif']),
      isoMediaHeader(['mif1', 'heic', 'hevc']),
      isoMediaHeader(['mif1', 'hevc', 'heic']),
      extendedIsoMediaHeader(['heic', 'hevc']),
      extendedIsoMediaHeader(['mif1', 'heic', 'hevc']),
      extendedIsoMediaHeader(['mif1', 'hevc', 'heic']),
    ]

    for (const container of mixedContainers) {
      expect(sniffImageFormat(container)).toBeNull()
      await expect(
        detectImageFormat(
          new File([blobPart(container)], 'photo.jpg', { type: 'image/jpeg' }),
        ),
      ).resolves.toBeNull()
      await expect(
        validateImage(new Blob([blobPart(container)], { type: 'image/heic' })),
      ).rejects.toMatchObject({ code: 'unsupported-image' })
    }
  })

  test('complete unsupported containers override legacy metadata', async () => {
    const unsupportedContainers = [
      isoMediaHeader(['avif', 'mif1']),
      isoMediaHeader(['avis', 'msf1']),
      isoMediaHeader(['mif1']),
      ...['hevc', 'hevx', 'hevm', 'hevs', 'msf1'].map((brand) =>
        isoMediaHeader(['mif1', brand]),
      ),
    ]
    const legacyMimes = [
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/pjpeg',
      'image/webp',
    ]
    const legacyNames = ['photo.png', 'photo.jpg', 'photo.jpeg', 'photo.webp']

    for (const container of unsupportedContainers) {
      for (const type of legacyMimes) {
        await expect(
          detectImageFormat(new Blob([blobPart(container)], { type })),
        ).resolves.toBeNull()
      }
      for (const name of legacyNames) {
        await expect(
          detectImageFormat(
            new File([blobPart(container)], name, {
              type: 'application/octet-stream',
            }),
          ),
        ).resolves.toBeNull()
      }
    }
  })

  test('handles extended-size ftyp boxes under conflicting legacy metadata', async () => {
    const unsupportedContainers = [
      extendedIsoMediaHeader(['avif', 'mif1']),
      extendedIsoMediaHeader(['avis', 'msf1']),
      extendedIsoMediaHeader(['mif1']),
      ...['hevc', 'hevx', 'hevm', 'hevs', 'msf1'].flatMap((brand) => [
        extendedIsoMediaHeader([brand, 'heic']),
        extendedIsoMediaHeader(['mif1', brand]),
      ]),
    ]
    const legacyMimes = ['image/png', 'image/jpeg', 'image/webp']
    const legacyNames = ['photo.png', 'photo.jpg', 'photo.webp']

    for (const container of unsupportedContainers) {
      for (const type of legacyMimes) {
        await expect(
          detectImageFormat(new Blob([blobPart(container)], { type })),
        ).resolves.toBeNull()
      }
      for (const name of legacyNames) {
        await expect(
          detectImageFormat(
            new File([blobPart(container)], name, {
              type: 'application/octet-stream',
            }),
          ),
        ).resolves.toBeNull()
      }
    }

    for (const brand of ['heic', 'heix', 'heim', 'heis']) {
      for (const heic of [
        extendedIsoMediaHeader([brand]),
        extendedIsoMediaHeader(['mif1', brand]),
      ]) {
        expect(sniffImageFormat(heic)).toBe('heic')
        await expect(
          detectImageFormat(
            new File([blobPart(heic)], 'photo.jpg', { type: 'image/png' }),
          ),
        ).resolves.toBe('heic')
      }
    }
  })

  test('handles complete size-zero boxes and safely defers incomplete huge boxes', async () => {
    const unsupportedToEof = isoMediaHeader(['avif', 'mif1'])
    new DataView(unsupportedToEof.buffer).setUint32(0, 0)
    await expect(
      detectImageFormat(
        new Blob([blobPart(unsupportedToEof)], { type: 'image/jpeg' }),
      ),
    ).resolves.toBeNull()

    const supportedToEof = isoMediaHeader(['mif1', 'heic'])
    new DataView(supportedToEof.buffer).setUint32(0, 0)
    expect(sniffImageFormat(supportedToEof)).toBe('heic')

    const incompleteToEof = new Uint8Array(4100)
    incompleteToEof.set(unsupportedToEof)
    await expect(
      detectImageFormat(
        new Blob([blobPart(incompleteToEof)], { type: 'image/jpeg' }),
      ),
    ).resolves.toBe('jpeg')

    const huge = extendedIsoMediaHeader(['avif', 'mif1'])
    new DataView(huge.buffer).setUint32(8, 1)
    await expect(
      detectImageFormat(new Blob([blobPart(huge)], { type: 'image/jpeg' })),
    ).resolves.toBe('jpeg')
  })

  test('incomplete ftyp sniff windows retain metadata fallback', async () => {
    const incompleteAvif = new Uint8Array(4100)
    new DataView(incompleteAvif.buffer).setUint32(0, incompleteAvif.length)
    incompleteAvif.set(bytes('ftyp'), 4)
    incompleteAvif.set(bytes('avif'), 8)
    incompleteAvif.set(bytes('mif1'), 16)

    await expect(
      detectImageFormat(
        new Blob([blobPart(incompleteAvif)], { type: 'image/jpeg' }),
      ),
    ).resolves.toBe('jpeg')
  })

  test('recognizable bytes override conflicting supported MIME and extensions', async () => {
    const heic = blobPart(heifHeader('heic'))
    await expect(
      detectImageFormat(new File([heic], 'photo.jpg', { type: 'image/jpeg' })),
    ).resolves.toBe('heic')
    await expect(
      detectImageFormat(new File([heic], 'photo.jpg')),
    ).resolves.toBe('heic')

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await expect(
      detectImageFormat(
        new File([blobPart(png)], 'photo.heic', { type: 'image/heic' }),
      ),
    ).resolves.toBe('png')
  })

  test('sniffs existing formats when MIME metadata is missing', () => {
    expect(
      sniffImageFormat(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe('png')
    expect(sniffImageFormat(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('jpeg')
    expect(sniffImageFormat(bytes('RIFF\0\0\0\0WEBP'))).toBe('webp')
  })
})

describe('decodeImage', () => {
  test('keeps existing formats on the native decoder path', async () => {
    const bitmap = {} as ImageBitmap
    let heicCalls = 0
    await expect(
      decodeImage(new Blob(['png'], { type: 'image/png' }), undefined, {
        native: async () => bitmap,
        heic: async () => {
          heicCalls += 1
          return bitmap
        },
      }),
    ).resolves.toBe(bitmap)
    expect(heicCalls).toBe(0)
  })

  test('uses the local HEIC decoder when native decoding fails', async () => {
    const bitmap = {} as ImageBitmap
    let heicCalls = 0
    await expect(
      decodeImage(new Blob([blobPart(heifHeader('heic'))]), undefined, {
        native: async () => {
          throw new Error('unsupported by browser')
        },
        heic: async () => {
          heicCalls += 1
          return bitmap
        },
      }),
    ).resolves.toBe(bitmap)
    expect(heicCalls).toBe(1)
  })

  test('normalizes HEIC decoder failures into a useful product error', async () => {
    await expect(
      decodeImage(new Blob([blobPart(heifHeader('heic'))]), undefined, {
        native: async () => {
          throw new Error('unsupported by browser')
        },
        heic: async () => {
          throw new Error('invalid HEIF payload')
        },
      }),
    ).rejects.toMatchObject({ code: 'decode-failed' })
  })
})

function bytes(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0))
}

function blobPart(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return copy.buffer
}

function heifHeader(majorBrand: string, compatibleBrand?: string): Uint8Array {
  return isoMediaHeader(
    compatibleBrand ? [majorBrand, compatibleBrand] : [majorBrand],
  )
}

function isoMediaHeader(
  brands: string[],
  trailingBrands: string[] = [],
  minorVersion = '\0\0\0\0',
) {
  const boxSize = 16 + Math.max(0, brands.length - 1) * 4
  const result = new Uint8Array(boxSize + trailingBrands.length * 4)
  new DataView(result.buffer).setUint32(0, boxSize)
  result.set(bytes('ftyp'), 4)
  result.set(bytes(brands[0] ?? '    '), 8)
  result.set(bytes(minorVersion), 12)
  brands.slice(1).forEach((brand, index) => {
    result.set(bytes(brand), 16 + index * 4)
  })
  trailingBrands.forEach((brand, index) => {
    result.set(bytes(brand), boxSize + index * 4)
  })
  return result
}

function extendedIsoMediaHeader(brands: string[]): Uint8Array {
  const boxSize = 24 + Math.max(0, brands.length - 1) * 4
  const result = new Uint8Array(boxSize)
  const view = new DataView(result.buffer)
  view.setUint32(0, 1)
  result.set(bytes('ftyp'), 4)
  view.setUint32(8, 0)
  view.setUint32(12, boxSize)
  result.set(bytes(brands[0] ?? '    '), 16)
  brands.slice(1).forEach((brand, index) => {
    result.set(bytes(brand), 24 + index * 4)
  })
  return result
}

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

      expect(canvases).toHaveLength(3)
      expect(
        canvases[0]?.context.imageData?.data.filter(
          (_, index) => index % 4 === 3,
        ),
      ).toEqual(new Uint8ClampedArray([0, 64, 128, 255]))
      expect(canvases[2]?.context.imageData?.data[3]).toBe(255)
      expect(canvases[1]?.context.drawCalls[0]?.slice(1)).toEqual([0, 0, 4, 4])
      expect(canvases[1]?.context.clearCalls).toEqual([[1, 1, 2, 2]])
      expect(canvases[1]?.context.drawCalls[1]?.slice(1)).toEqual([1, 1, 2, 2])
      expect(canvases[1]?.context.drawCalls[2]?.[0]).toBe(image)
      expect(canvases[1]?.context.globalCompositeOperation).toBe('source-in')
      expect(
        canvases.every((canvas) => canvas.width === 0 && canvas.height === 0),
      ).toBe(true)
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      })
    }
  })
})

describe('PNG canvas ownership', () => {
  for (const mode of [
    'success',
    'null-blob',
    'throw-encode',
    'context-failure',
  ] as const) {
    test(`releases all buffers after ${mode}, but not before encoding`, async () => {
      const originalDocument = globalThis.document
      const canvases: FakeCanvas[] = []
      const encoders: ((blob: Blob | null) => void)[] = []
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
          createElement: () => {
            const canvas = new FakeCanvas()
            if (mode === 'context-failure') {
              canvas.getContext = () => {
                throw new Error('Canvas allocation failed')
              }
            }
            canvas.toBlob = (callback) => {
              if (mode === 'throw-encode') throw new Error('Encoder failed')
              encoders.push(callback)
            }
            canvases.push(canvas)
            return canvas
          },
        },
      })
      try {
        for (const exportImage of [
          (image: ImageBitmap) => imageToPng(image),
          (image: ImageBitmap) =>
            maskToPng(image, new Float32Array([1]), 1, 1, 'fast'),
        ]) {
          encoders.length = 0
          const pending = exportImage({
            width: 4000,
            height: 3000,
          } as ImageBitmap)
          if (mode === 'success' || mode === 'null-blob') {
            expect(canvases.at(-1)?.width).toBe(4000)
            expect(encoders[0]).toBeDefined()
            encoders[0]?.(mode === 'success' ? new Blob(['png']) : null)
          }
          if (mode === 'success')
            await expect(pending).resolves.toBeInstanceOf(Blob)
          else await expect(pending).rejects.toBeInstanceOf(Error)
          expect(
            canvases.every(
              (canvas) => canvas.width === 0 && canvas.height === 0,
            ),
          ).toBe(true)
        }
      } finally {
        Object.defineProperty(globalThis, 'document', {
          configurable: true,
          value: originalDocument,
        })
      }
    })
  }
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
