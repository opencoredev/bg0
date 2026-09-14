import type { CaptureResult, Properties } from 'posthog-js'

const DATA_IMAGE_URL = /data:image\//i
const BLOB_URL = /\bblob:[^\s"')]+/gi
const PRIVATE_IMAGE_URL = '[private image URL]'

export function redactPrivateUrls(value: unknown): unknown {
  if (typeof value === 'string') {
    // A data URI can contain quotes, whitespace, and arbitrary SVG markup. Once
    // one appears, discard the complete property so no image content survives.
    if (DATA_IMAGE_URL.test(value)) return PRIVATE_IMAGE_URL
    return value.replace(BLOB_URL, PRIVATE_IMAGE_URL)
  }
  if (Array.isArray(value)) return value.map(redactPrivateUrls)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        redactPrivateUrls(nested),
      ]),
    )
  }
  return value
}

function safeProperties(properties: Properties | undefined) {
  if (!properties) return undefined
  const sanitized = redactPrivateUrls(properties) as Properties
  delete sanitized.$current_url
  delete sanitized.$referrer
  delete sanitized.$initial_current_url
  delete sanitized.$initial_referrer
  return sanitized
}

export function sanitizeCapture(capture: CaptureResult | null) {
  if (!capture) return null
  return {
    ...capture,
    properties: safeProperties(capture.properties) ?? {},
    $set: safeProperties(capture.$set),
    $set_once: safeProperties(capture.$set_once),
  }
}
