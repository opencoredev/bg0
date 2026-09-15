import { describe, expect, test } from 'bun:test'
import { BackgroundRemovalError } from './errors'
import {
  findRefinementCrop,
  inspectMask,
  MAX_IMAGE_BYTES,
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
