import type { PostHog } from 'posthog-js'
import {
  redactPrivateUrls,
  sanitizeCapture,
} from './analytics-privacy'

const POSTHOG_KEY = 'phc_wVUY4kf7cB9GCtKztaQ4dk6ooYU8QaagC88breDYcgaj'
const POSTHOG_HOST = 'https://us.i.posthog.com'

type InputMethod = 'drop' | 'paste' | 'picker'
type ResultView = 'compare' | 'original' | 'result'
type Feature =
  | 'compare_slider'
  | 'copy_result'
  | 'start_another_image'
  | `view_${ResultView}`

let clientPromise: Promise<PostHog | null> | null = null

function safeError(error: unknown) {
  if (!(error instanceof Error)) {
    return new Error('A non-Error value was thrown')
  }
  const sanitized = new Error(redactPrivateUrls(error.message) as string)
  sanitized.name = error.name
  sanitized.stack = redactPrivateUrls(error.stack) as string | undefined
  return sanitized
}

function analyticsEnabled() {
  if (typeof window === 'undefined') return false
  return (
    import.meta.env.VITE_POSTHOG_ENABLED === 'true' ||
    window.location.hostname === 'bg0.dev' ||
    window.location.hostname === 'www.bg0.dev'
  )
}

function getClient(): Promise<PostHog | null> {
  if (!analyticsEnabled()) return Promise.resolve(null)
  if (!clientPromise) {
    clientPromise = import('posthog-js')
      .then(({ default: posthog }) => {
        posthog.init(POSTHOG_KEY, {
          api_host: POSTHOG_HOST,
          autocapture: false,
          capture_dead_clicks: false,
          capture_pageleave: true,
          capture_pageview: false,
          capture_performance: false,
          capture_exceptions: {
            capture_unhandled_errors: true,
            capture_unhandled_rejections: true,
            capture_console_errors: false,
          },
          disable_session_recording: true,
          disable_surveys: false,
          advanced_only_evaluate_survey_feature_flags: true,
          person_profiles: 'never',
          persistence: 'localStorage',
          before_send: sanitizeCapture,
        })
        return posthog
      })
      .catch(() => null)
  }
  return clientPromise
}

function capture(event: string, properties: Record<string, string>) {
  void getClient().then((client) => client?.capture(event, properties))
}

export function capturePageView(route: string) {
  capture('$pageview', { route })
}

export function captureImageSelected(inputMethod: InputMethod) {
  capture('image_selected', { input_method: inputMethod })
}

export function captureRemovalSucceeded(
  inputMethod: InputMethod,
  provider: 'wasm' | 'webgpu',
) {
  capture('background_removal_succeeded', {
    input_method: inputMethod,
    provider,
  })
}

export function captureRemovalFailed(
  inputMethod: InputMethod,
  reason:
    | 'cancelled'
    | 'decode-failed'
    | 'image-too-large'
    | 'inference-failed'
    | 'model-load-failed'
    | 'out-of-memory'
    | 'unsupported-image',
) {
  capture('background_removal_failed', {
    input_method: inputMethod,
    reason,
  })
}

export function captureResultDownloaded(provider: 'wasm' | 'webgpu') {
  capture('result_downloaded', { provider })
}

export function captureFeatureUsed(feature: Feature) {
  capture('feature_used', { feature })
}

export function captureAppException(
  error: unknown,
  properties: { area: 'background_removal' | 'route'; reason?: string },
) {
  void getClient().then((client) =>
    client?.captureException(safeError(error), properties),
  )
}
