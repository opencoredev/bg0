import type { PostHog } from 'posthog-js'
import {
  createReportableError,
  type ReportableErrorContext,
  sanitizeCapture,
} from './analytics-privacy'

const POSTHOG_KEY = 'phc_wVUY4kf7cB9GCtKztaQ4dk6ooYU8QaagC88breDYcgaj'
const POSTHOG_HOST = 'https://us.i.posthog.com'
const RESULT_SURVEY_ID = '01a0bb11-7aee-0000-29d8-a9f80fa33910'
const RESULT_SURVEY_SHOWN_KEY = `bg0-survey-shown:${RESULT_SURVEY_ID}`

type InputMethod = 'drop' | 'paste' | 'picker'
type ResultView = 'compare' | 'original' | 'result'
type Feature =
  | 'compare_slider'
  | 'copy_result'
  | 'start_another_image'
  | `view_${ResultView}`

let clientPromise: Promise<PostHog | null> | null = null
let resultSurveyPending = false

function observeResultSurveyRender(onRendered: () => void) {
  const surveyClassName = `PostHogSurvey-${RESULT_SURVEY_ID}`
  const finishWhenRendered = () => {
    if (document.getElementsByClassName(surveyClassName).length === 0) return
    observer.disconnect()
    onRendered()
  }
  const observer = new MutationObserver(finishWhenRendered)
  observer.observe(document.body, { childList: true, subtree: true })
  finishWhenRendered()
  return () => observer.disconnect()
}

function captureControlledException(
  client: PostHog,
  error: unknown,
  context: ReportableErrorContext,
) {
  client.captureException(
    createReportableError(error, context, window.location.origin),
    context,
  )
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

/**
 * Start PostHog early in the page lifecycle so surveys are ready by the time a
 * local removal completes. This does not capture an event or send image data.
 */
export function initializeAnalytics() {
  void getClient()
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

export function showResultSurvey() {
  if (resultSurveyPending) return
  try {
    if (window.localStorage.getItem(RESULT_SURVEY_SHOWN_KEY)) return
  } catch {
    // PostHog can still display the survey when storage is unavailable.
  }

  resultSurveyPending = true
  void getClient().then((client) => {
    if (!client) {
      resultSurveyPending = false
      return
    }

    let handled = false
    let unsubscribe = () => {}
    let stopObserving = () => {}
    const timeout = window.setTimeout(() => {
      resultSurveyPending = false
      unsubscribe()
      stopObserving()
    }, 120_000)

    unsubscribe = client.onSurveysLoaded((surveys, context) => {
      if (handled || !context?.isLoaded) return
      handled = true
      // The callback can run synchronously during registration, so defer the
      // unsubscribe until its return value has been assigned.
      queueMicrotask(() => unsubscribe())

      if (!surveys.some((survey) => survey.id === RESULT_SURVEY_ID)) {
        resultSurveyPending = false
        window.clearTimeout(timeout)
        return
      }
      stopObserving = observeResultSurveyRender(() => {
        resultSurveyPending = false
        window.clearTimeout(timeout)
        try {
          window.localStorage.setItem(RESULT_SURVEY_SHOWN_KEY, 'true')
        } catch {
          // A storage failure should not prevent a voluntary response.
        }
      })
      client.displaySurvey(RESULT_SURVEY_ID, {
        displayType: 'popover',
        // BG0 controls the exact post-result timing and one-time frequency.
        // The dashboard uses a never-captured sentinel event so the survey
        // cannot also appear automatically on page load.
        ignoreConditions: true,
        ignoreDelay: true,
      })
    })
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

export function captureCrossPromoClicked(project: 'social-sdk') {
  capture('cross_promo_clicked', { project, placement: 'banner' })
}

export function captureCrossPromoDismissed(project: 'social-sdk') {
  capture('cross_promo_dismissed', { project, placement: 'banner' })
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
