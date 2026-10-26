import { describe, expect, test } from 'bun:test'

import {
  FULL_DOWNLOAD_LABEL,
  isSlowConnection,
  isSlowDownload,
  LITE_DOWNLOAD_LABEL,
  MODEL_TIER_STORAGE_KEY,
  parseModelTier,
  readModelTier,
  saveModelTier,
  urlWithModelTier,
} from './model-tier'

function memoryStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial))
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value)
    },
  }
}

describe('model tier preference', () => {
  test('accepts only known tiers', () => {
    expect(parseModelTier('lite')).toBe('lite')
    expect(parseModelTier('full')).toBe('full')
    expect(parseModelTier('auto')).toBe('auto')
    for (const value of ['LITE', 'standard', '', null]) {
      expect(parseModelTier(value)).toBeUndefined()
    }
  })

  test('the URL parameter wins over the saved choice, which wins over auto', () => {
    const storage = memoryStorage({ [MODEL_TIER_STORAGE_KEY]: 'full' })
    expect(readModelTier({ search: '?model=lite', storage })).toBe('lite')
    expect(readModelTier({ search: '', storage })).toBe('full')
    expect(readModelTier({ search: '?model=huge', storage })).toBe('full')
    expect(readModelTier({ search: '', storage: memoryStorage() })).toBe('auto')
    expect(readModelTier({ search: '' })).toBe('auto')
  })

  test('ignores a corrupt saved value and blocked storage', () => {
    expect(
      readModelTier({
        search: '',
        storage: memoryStorage({ [MODEL_TIER_STORAGE_KEY]: 'giant' }),
      }),
    ).toBe('auto')
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
    }
    expect(readModelTier({ search: '', storage: blocked })).toBe('auto')
    expect(() => saveModelTier('lite', blocked)).not.toThrow()
  })

  test('saves the choice', () => {
    const storage = memoryStorage()
    saveModelTier('lite', storage)
    expect(storage.entries.get(MODEL_TIER_STORAGE_KEY)).toBe('lite')
    expect(readModelTier({ search: '', storage })).toBe('lite')
  })

  test('keeps a pinned URL in step and leaves other URLs alone', () => {
    expect(
      urlWithModelTier('https://bg0.dev/?model=full#remover', 'lite'),
    ).toBe('https://bg0.dev/?model=lite#remover')
    expect(urlWithModelTier('https://bg0.dev/?ref=x', 'lite')).toBe(
      'https://bg0.dev/?ref=x',
    )
  })

  test('labels the download sizes in MiB', () => {
    expect(LITE_DOWNLOAD_LABEL).toBe('94 MiB')
    expect(FULL_DOWNLOAD_LABEL).toBe('452 MiB')
  })
})

describe('slow network hints', () => {
  test('data saver and cellular-class connections count as slow', () => {
    expect(isSlowConnection({ saveData: true, effectiveType: '4g' })).toBe(true)
    for (const effectiveType of ['slow-2g', '2g', '3g']) {
      expect(isSlowConnection({ effectiveType })).toBe(true)
    }
    expect(isSlowConnection({ effectiveType: '4g' })).toBe(false)
    expect(isSlowConnection(undefined)).toBe(false)
  })

  test('judges throughput only after a few seconds', () => {
    expect(
      isSlowDownload({
        elapsedMs: 1_000,
        receivedBytes: 0,
        remainingBytes: 400 * 1024 ** 2,
      }),
    ).toBe(false)
  })

  test('flags a download with more than a minute left at the measured rate', () => {
    // 1 MiB/s with 400 MiB left: about seven minutes.
    expect(
      isSlowDownload({
        elapsedMs: 4_000,
        receivedBytes: 4 * 1024 ** 2,
        remainingBytes: 400 * 1024 ** 2,
      }),
    ).toBe(true)
    // 20 MiB/s with 400 MiB left: 20 seconds.
    expect(
      isSlowDownload({
        elapsedMs: 4_000,
        receivedBytes: 80 * 1024 ** 2,
        remainingBytes: 400 * 1024 ** 2,
      }),
    ).toBe(false)
    // Nothing arrived in the sample window.
    expect(
      isSlowDownload({
        elapsedMs: 4_000,
        receivedBytes: 0,
        remainingBytes: 400 * 1024 ** 2,
      }),
    ).toBe(true)
  })
})
