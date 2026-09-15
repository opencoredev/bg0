import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

import { isIPhone, Remover } from './remover'

GlobalRegistrator.register()

class IntersectionObserverStub {
  observe() {}
  disconnect() {}
}

globalThis.IntersectionObserver =
  IntersectionObserverStub as unknown as typeof IntersectionObserver

afterEach(cleanup)
afterAll(() => GlobalRegistrator.unregister())

const IPHONE_SAFARI_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1'

const MAC_SAFARI_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15'

describe('iPhone memory warning', () => {
  test('detects iPhone without treating Mac or iPad as iPhone', () => {
    expect(isIPhone(IPHONE_SAFARI_USER_AGENT)).toBe(true)
    expect(isIPhone(MAC_SAFARI_USER_AGENT)).toBe(false)
    expect(
      isIPhone(
        'Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1',
      ),
    ).toBe(false)
  })

  test('renders only for an iPhone browser', async () => {
    const originalUserAgent = navigator.userAgent

    try {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: MAC_SAFARI_USER_AGENT,
      })
      const desktopView = render(<Remover />)
      expect(desktopView.queryByText(/iOS limits browser memory/)).toBeNull()
      desktopView.unmount()

      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: IPHONE_SAFARI_USER_AGENT,
      })
      const iPhoneView = render(<Remover />)
      await waitFor(() => {
        expect(iPhoneView.getByText(/iOS limits browser memory/)).toBeTruthy()
      })
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: originalUserAgent,
      })
    }
  })
})

describe('Remover image pickers', () => {
  test('keeps photo and file picker actions distinct across entry points', () => {
    const view = render(<Remover />)
    const photoInput = view.getByLabelText('Choose a photo')
    const fileInput = view.getByLabelText(
      'Choose an image file to remove its background',
    )
    const photoClick = mock(() => {})
    const fileClick = mock(() => {})

    photoInput.click = photoClick
    fileInput.click = fileClick

    const photoButtons = Array.from(
      view.container.querySelectorAll('button'),
    ).filter((button) => button.textContent?.trim() === 'Choose a photo')

    expect(photoButtons).toHaveLength(2)
    for (const button of photoButtons) {
      fireEvent.click(button)
    }
    expect(photoClick).toHaveBeenCalledTimes(2)
    expect(fileClick).not.toHaveBeenCalled()
    expect(photoInput.getAttribute('accept')).toBe(
      'image/png,image/jpeg,image/webp',
    )

    fireEvent.click(view.getByRole('button', { name: 'Files' }))
    fireEvent.click(view.getByRole('button', { name: /Choose image/ }))
    fireEvent.keyDown(window, { ctrlKey: true, key: 'o' })
    fireEvent.keyDown(window, { metaKey: true, key: 'o' })

    expect(fileClick).toHaveBeenCalledTimes(4)
    expect(photoClick).toHaveBeenCalledTimes(2)
    expect(fileInput.hasAttribute('accept')).toBe(false)
  })
})
