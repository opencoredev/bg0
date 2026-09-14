import { type ErrorComponentProps, Link } from '@tanstack/react-router'
import { useEffect } from 'react'

import { Button } from '#/components/ui/button'
import { captureAppException } from '#/lib/analytics'

export function AppError({ error, reset }: ErrorComponentProps) {
  useEffect(() => captureAppException(error, { area: 'route' }), [error])

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-5xl flex-col items-center justify-center px-5 text-center">
      <p className="font-mono text-sm text-muted-foreground">APP ERROR</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">
        Something went wrong
      </h1>
      <p className="mt-3 max-w-md text-muted-foreground">
        BG0 could not finish loading this page. Your images stayed on this
        device.
      </p>
      <div className="mt-7 flex gap-3">
        <Button type="button" onClick={reset}>
          Try again
        </Button>
        <Button asChild variant="secondary">
          <Link to="/">Back to BG0</Link>
        </Button>
      </div>
    </main>
  )
}
