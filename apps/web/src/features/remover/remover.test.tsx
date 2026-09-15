import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { cleanup, fireEvent, render } from '@testing-library/react'

import { Remover } from './remover'

GlobalRegistrator.register()

class IntersectionObserverStub {
  observe() {}
  disconnect() {}
}

globalThis.IntersectionObserver =
  IntersectionObserverStub as unknown as typeof IntersectionObserver

afterEach(cleanup)
afterAll(() => GlobalRegistrator.unregister())

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
