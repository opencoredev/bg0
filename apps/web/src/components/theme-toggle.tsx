import { Moon, Sun } from 'lucide-react'
import { useEffect } from 'react'

import { Button } from '#/components/ui/button'

const STORAGE_KEY = 'bg0-theme'
// The docs site (Blume) persists its choice under this key on the same origin.
const DOCS_STORAGE_KEY = 'blume-theme'

function applyTheme(theme: 'dark' | 'light') {
  const dark = theme === 'dark'
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = theme
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0a0a0a' : '#ffffff')
}

export function ThemeToggle() {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const followSystem = (event: MediaQueryListEvent) => {
      if (!window.localStorage.getItem(STORAGE_KEY)) {
        applyTheme(event.matches ? 'dark' : 'light')
      }
    }
    media.addEventListener('change', followSystem)
    return () => media.removeEventListener('change', followSystem)
  }, [])

  function toggleTheme() {
    const theme = document.documentElement.classList.contains('dark')
      ? 'light'
      : 'dark'
    window.localStorage.setItem(STORAGE_KEY, theme)
    window.localStorage.setItem(DOCS_STORAGE_KEY, theme)
    applyTheme(theme)
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size="icon-sm"
      aria-label="Toggle color theme"
      title="Toggle color theme"
      onClick={toggleTheme}
    >
      <Sun aria-hidden="true" className="hidden dark:block" />
      <Moon aria-hidden="true" className="block dark:hidden" />
    </Button>
  )
}
