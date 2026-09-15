import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { cleanup, fireEvent, render } from '@testing-library/react'

import { ThemeToggle } from './theme-toggle'

GlobalRegistrator.register()

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  document.documentElement.classList.remove('dark')
  document.documentElement.style.colorScheme = ''
})
afterAll(() => GlobalRegistrator.unregister())

describe('ThemeToggle', () => {
  test('persists the choice for the app and the docs site', () => {
    document.documentElement.classList.add('dark')
    const view = render(<ThemeToggle />)

    fireEvent.click(view.getByRole('button', { name: 'Toggle color theme' }))

    expect(window.localStorage.getItem('bg0-theme')).toBe('light')
    expect(window.localStorage.getItem('blume-theme')).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('light')

    fireEvent.click(view.getByRole('button', { name: 'Toggle color theme' }))

    expect(window.localStorage.getItem('bg0-theme')).toBe('dark')
    expect(window.localStorage.getItem('blume-theme')).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })
})
