import { MODEL_TIER_BYTES, MODEL_TIERS, type ModelTier } from '@bg0/browser'

/** `?model=lite` pins a tier for one visit without changing the saved choice. */
export const MODEL_TIER_PARAM = 'model'
export const MODEL_TIER_STORAGE_KEY = 'bg0:model-tier'

type TierStorage = Pick<Storage, 'getItem' | 'setItem'>

export interface NetworkHint {
  saveData?: boolean
  effectiveType?: string
}

export function parseModelTier(value: string | null): ModelTier | undefined {
  return MODEL_TIERS.find((tier) => tier === value)
}

/** The URL parameter wins, then the saved choice, then `auto`. */
export function readModelTier({
  search,
  storage,
}: {
  search: string
  storage?: TierStorage
}): ModelTier {
  const fromUrl = parseModelTier(
    new URLSearchParams(search).get(MODEL_TIER_PARAM),
  )
  if (fromUrl) return fromUrl
  try {
    return (
      parseModelTier(storage?.getItem(MODEL_TIER_STORAGE_KEY) ?? null) ?? 'auto'
    )
  } catch {
    // Storage can be blocked in privacy modes.
    return 'auto'
  }
}

export function saveModelTier(tier: ModelTier, storage?: TierStorage): void {
  try {
    storage?.setItem(MODEL_TIER_STORAGE_KEY, tier)
  } catch {
    // The choice still applies to this page.
  }
}

/**
 * The URL after choosing a tier. A link that already pins a tier is kept in
 * step with the choice; a URL without one stays clean.
 */
export function urlWithModelTier(href: string, tier: ModelTier): string {
  const url = new URL(href)
  if (!url.searchParams.has(MODEL_TIER_PARAM)) return href
  url.searchParams.set(MODEL_TIER_PARAM, tier)
  return url.href
}

/** Data saver or a cellular-class connection make the full download a long wait. */
export function isSlowConnection(connection: NetworkHint | undefined): boolean {
  return Boolean(
    connection?.saveData ||
      connection?.effectiveType === 'slow-2g' ||
      connection?.effectiveType === '2g' ||
      connection?.effectiveType === '3g',
  )
}

/** Wait this long before judging throughput, so connection setup is excluded. */
export const DOWNLOAD_SAMPLE_MS = 3_000
/** A download expected to need longer than this is worth offering lite for. */
export const SLOW_DOWNLOAD_REMAINING_MS = 60_000

/**
 * Whether the bytes still to come would take more than a minute at the rate
 * measured since the download was first seen.
 */
export function isSlowDownload({
  elapsedMs,
  receivedBytes,
  remainingBytes,
}: {
  elapsedMs: number
  receivedBytes: number
  remainingBytes: number
}): boolean {
  if (elapsedMs < DOWNLOAD_SAMPLE_MS) return false
  if (receivedBytes <= 0) return true
  const remainingMs = (remainingBytes / receivedBytes) * elapsedMs
  return remainingMs > SLOW_DOWNLOAD_REMAINING_MS
}

/** Model sizes in binary megabytes, matching the download progress. */
export function toMebibytes(bytes: number): number {
  return Math.round(bytes / 1024 ** 2)
}

export const LITE_DOWNLOAD_LABEL = `${toMebibytes(MODEL_TIER_BYTES.lite)} MiB`
export const FULL_DOWNLOAD_LABEL = `${toMebibytes(MODEL_TIER_BYTES.full)} MiB`
