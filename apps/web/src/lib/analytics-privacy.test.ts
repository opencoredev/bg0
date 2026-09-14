import { describe, expect, test } from 'bun:test'
import type { CaptureResult } from 'posthog-js'
import { redactPrivateUrls, sanitizeCapture } from './analytics-privacy'

describe('analytics privacy', () => {
  test('redacts a complete quoted SVG data URI', () => {
    const value =
      'decode failed: data:image/svg+xml,<svg viewBox="0 0"><text>SECRET_SVG_PAYLOAD</text></svg>'

    expect(redactPrivateUrls(value)).toBe('[private image URL]')
  })

  test('redacts nested capture fields and removes browsing URLs', () => {
    const capture = {
      event: '$exception',
      properties: {
        nested: {
          source:
            'data:image/svg+xml,<svg viewBox="0 0">SECRET_PROPERTIES</svg>',
        },
        $current_url: 'https://bg0.dev/private-route',
      },
      $set: {
        preview: 'blob:https://bg0.dev/SECRET_SET',
        $referrer: 'https://example.com/private',
      },
      $set_once: {
        preview:
          'prefix data:image/png;base64,SECRET_SET_ONCE with trailing text',
        $initial_current_url: 'https://bg0.dev/private-route',
      },
    } as unknown as CaptureResult

    const result = sanitizeCapture(capture)
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain('SECRET')
    expect(serialized).not.toContain('private-route')
    expect(serialized).not.toContain('example.com')
    expect(result?.properties).toEqual({
      nested: { source: '[private image URL]' },
    })
    expect(result?.$set).toEqual({ preview: '[private image URL]' })
    expect(result?.$set_once).toEqual({ preview: '[private image URL]' })
  })

  test('leaves ordinary error context intact', () => {
    expect(redactPrivateUrls('model initialization failed')).toBe(
      'model initialization failed',
    )
  })
})
