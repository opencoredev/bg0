import type { PostHog } from 'posthog-js'
import {
  createReportableError,
  sanitizeCapture,
  type ReportableErrorContext,
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

function captureControlledException(
  client: PostHog,
  error: unknown,
  context: ReportableErrorContext,
) {
  client.captureException(createReportableError(error, context), context)
}

function registerUnhandledErrorTracking(client: PostHog) {
  window.addEventListener('error', (event) => {
    captureControlledException(client, event.error, { area: 'unhandled_error' })
  })
  window.addEventListener('unhandledrejection', (event) => {
    captureControlledException(client, event.reason, {
      area: 'unhandled_rejection',
    })
  })
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
          capture_exceptions: false,
          disable_session_recording: true,
          disable_surveys: false,
          advanced_only_evaluate_survey_feature_flags: true,
          person_profiles: 'never',
          persistence: 'localStorage',
          before_send: sanitizeCapture,
        })
        registerUnhandledErrorTracking(posthog)
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
  context: Extract<
    ReportableErrorContext,
    { area: 'background_removal' | 'route' }
  >,
) {
  void getClient().then((client) =>
    client ? captureControlledException(client, error, context) : undefined,
  )
}
