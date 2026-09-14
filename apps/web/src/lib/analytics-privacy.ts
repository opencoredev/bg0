import type { CaptureResult, Properties } from 'posthog-js'

const DATA_IMAGE_URL = /data:image\//i
const BLOB_URL = /\bblob:[^\s"')]+/gi
const PRIVATE_IMAGE_URL = '[private image URL]'

export type ReportableErrorContext =
  | {
      area: 'background_removal'
      reason:
        | 'decode-failed'
        | 'image-too-large'
        | 'inference-failed'
        | 'model-load-failed'
        | 'out-of-memory'
        | 'unsupported-image'
    }
  | { area: 'route' }
  | { area: 'unhandled_error' }
  | { area: 'unhandled_rejection' }

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

export function createReportableError(
  originalError: unknown,
  context: ReportableErrorContext,
  applicationOrigin = '',
) {
  const message =
    context.area === 'background_removal'
      ? `Background removal failed: ${context.reason}`
      : context.area === 'route'
        ? 'Application route failed'
        : context.area === 'unhandled_error'
          ? 'Unhandled application error'
          : 'Unhandled promise rejection'
  const error = new Error(message)
  error.name = 'BG0Error'
  const frames = extractApplicationFrames(originalError, applicationOrigin)
  if (frames.length > 0) {
    error.stack = `${error.name}: ${error.message}\n${frames.join('\n')}`
  }
  return error
}

function extractApplicationFrames(error: unknown, applicationOrigin: string) {
  if (!(error instanceof Error) || !error.stack || !applicationOrigin) return []

  return error.stack.split('\n').flatMap((line) => {
    const match = line.match(/(https?:\/\/[^\s)]+):(\d+):(\d+)/)
    if (!match) return []

    try {
      const source = new URL(match[1])
      const isApplicationCode =
        source.origin === applicationOrigin &&
        (/^\/assets\/[\w./-]+\.js$/.test(source.pathname) ||
          /^\/src\/[\w./-]+\.(?:js|jsx|ts|tsx)$/.test(source.pathname))
      if (!isApplicationCode) return []
      source.search = ''
      source.hash = ''
      return [`    at ${source.href}:${match[2]}:${match[3]}`]
    } catch {
      return []
    }
  })
}
