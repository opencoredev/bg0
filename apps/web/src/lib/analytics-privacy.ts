import type { CaptureResult, Properties } from 'posthog-js'

const DATA_IMAGE_URL = /data:image\//i
const BLOB_URL = /\bblob:[^\s"')]+/gi
const PRIVATE_IMAGE_URL = '[private image URL]'
const SURVEY_SENT_EVENT = 'survey sent'
const ALLOWED_SURVEY_RESPONSES = new Set([
  'Great',
  'Good',
  'Needs work',
  'Unusable',
  'Background remained',
  'Part of the subject was removed',
  'Edges look rough',
  'Transparency looks wrong',
  'Not at all likely',
  'Extremely likely',
  'Background removal quality',
  'Speed',
  'Ease of use',
  'Privacy',
  'Something else',
])

const ALLOWED_RECOMMENDATION_SCORE_MIN = 0
const ALLOWED_RECOMMENDATION_SCORE_MAX = 10

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
  if (
    capture.event === SURVEY_SENT_EVENT &&
    !hasOnlyAllowedSurveyResponses(capture.properties)
  ) {
    return null
  }
  return {
    ...capture,
    properties: safeProperties(capture.properties) ?? {},
    $set: safeProperties(capture.$set),
    $set_once: safeProperties(capture.$set_once),
  }
}

function hasOnlyAllowedSurveyResponses(properties: Properties | undefined) {
  if (!properties) return false
  const responses = Object.entries(properties).filter(([key]) =>
    key.startsWith('$survey_response'),
  )
  return (
    responses.length > 0 &&
    responses.every(([, value]) => {
      if (typeof value === 'string') {
        return (
          ALLOWED_SURVEY_RESPONSES.has(value) ||
          isRecommendationScore(value)
        )
      }
      if (typeof value === 'number') return isRecommendationScore(value)
      return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every(
          (answer) =>
            (typeof answer === 'string' || typeof answer === 'number') &&
            (ALLOWED_SURVEY_RESPONSES.has(String(answer)) ||
              isRecommendationScore(answer)),
        )
      )
    })
  )
}

function isRecommendationScore(value: string | number) {
  if (typeof value === 'string' && !/^\d{1,2}$/.test(value)) return false
  const score = typeof value === 'number' ? value : Number(value)
  return (
    Number.isInteger(score) &&
    score >= ALLOWED_RECOMMENDATION_SCORE_MIN &&
    score <= ALLOWED_RECOMMENDATION_SCORE_MAX
  )
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
