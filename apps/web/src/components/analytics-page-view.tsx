import { useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'

import { capturePageView, initializeAnalytics } from '#/lib/analytics'

export function AnalyticsPageView() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  useEffect(() => capturePageView(pathname), [pathname])

  useEffect(() => {
    initializeAnalytics()
  }, [])

  return null
}
