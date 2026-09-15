import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { cleanup, fireEvent, render } from '@testing-library/react'

import { ComparePreview } from './compare-preview'

GlobalRegistrator.register()

afterEach(cleanup)
afterAll(() => GlobalRegistrator.unregister())

function renderSlider() {
  const view = render(<ComparePreview />)
  const slider = view.getByRole('slider') as HTMLDivElement
  Object.defineProperty(slider, 'getBoundingClientRect', {
    value: () => ({
      bottom: 100,
      height: 100,
      left: 10,
      right: 210,
      top: 0,
      width: 200,
      x: 10,
      y: 0,
      toJSON: () => ({}),
    }),
  })
  return slider
}

describe('ComparePreview', () => {
  test('tracks a captured pointer and clears dragging on release', () => {
    const slider = renderSlider()
    const setPointerCapture = mock(() => {})
    const releasePointerCapture = mock(() => {})
    Object.assign(slider, {
      hasPointerCapture: () => true,
      releasePointerCapture,
      setPointerCapture,
    })

    fireEvent.pointerDown(slider, { button: 0, clientX: 50, pointerId: 7 })
    expect(setPointerCapture).toHaveBeenCalledWith(7)
    expect(slider.getAttribute('aria-valuenow')).toBe('20')
    expect(slider.dataset.dragging).toBe('true')
    expect(slider.dataset.instant).toBe('true')

    fireEvent.pointerMove(slider, { clientX: 160, pointerId: 7 })
    expect(slider.getAttribute('aria-valuenow')).toBe('75')

    fireEvent.pointerUp(slider, { button: 0, clientX: 160, pointerId: 7 })
    expect(releasePointerCapture).toHaveBeenCalledWith(7)
    expect(slider.dataset.dragging).toBeUndefined()
  })

  test('clears dragging when a pointer is cancelled or capture is lost', () => {
    const slider = renderSlider()
    Object.assign(slider, {
      hasPointerCapture: () => true,
      releasePointerCapture: () => {},
      setPointerCapture: () => {},
    })

    fireEvent.pointerDown(slider, { button: 0, clientX: 110, pointerId: 1 })
    fireEvent.pointerCancel(slider, { pointerId: 1 })
    expect(slider.dataset.dragging).toBeUndefined()

    fireEvent.pointerDown(slider, { button: 0, clientX: 110, pointerId: 2 })
    fireEvent(slider, new Event('lostpointercapture', { bubbles: true }))
    expect(slider.dataset.dragging).toBeUndefined()
  })

  test('supports arrow, shifted arrow, Home, and End keys', () => {
    const slider = renderSlider()

    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(slider.getAttribute('aria-valuenow')).toBe('53')

    fireEvent.keyDown(slider, { key: 'ArrowLeft', shiftKey: true })
    expect(slider.getAttribute('aria-valuenow')).toBe('43')

    fireEvent.keyDown(slider, { key: 'End' })
    expect(slider.getAttribute('aria-valuenow')).toBe('100')

    fireEvent.keyDown(slider, { key: 'Home' })
    expect(slider.getAttribute('aria-valuenow')).toBe('0')
  })

  test('shows the original while Space is held and clears peek on blur', () => {
    const slider = renderSlider()

    fireEvent.keyDown(slider, { code: 'Space', key: ' ' })
    expect(slider.dataset.peek).toBe('true')
    expect(slider.dataset.instant).toBe('true')

    fireEvent.keyUp(slider, { code: 'Space', key: ' ' })
    expect(slider.dataset.peek).toBeUndefined()
    expect(slider.dataset.instant).toBeUndefined()

    fireEvent.keyDown(slider, { code: 'Space', key: ' ' })
    fireEvent.blur(slider)
    expect(slider.dataset.peek).toBeUndefined()
  })
})
