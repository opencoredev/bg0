import { createFileRoute, Link } from '@tanstack/react-router'

import { Button } from '#/components/ui/button'

const MARKDOWN_404 = `# Page not found\n\nThe requested BG0 page does not exist. Read the [BG0 documentation](https://bg0.dev/docs) or return to the [background remover](https://bg0.dev/).\n`

function notFoundResponse(request: Request): Response {
  const acceptsMarkdown = request.headers
    .get('accept')
    ?.toLowerCase()
    .includes('text/markdown')

  if (acceptsMarkdown) {
    return new Response(MARKDOWN_404, {
      status: 404,
      headers: { 'Content-Type': 'text/markdown; charset=utf-8', Vary: 'Accept' },
    })
  }

  return new Response(
    '<!doctype html><html lang="en"><head><title>Page not found — BG0</title></head><body><main><h1>Page not found</h1><p>The requested BG0 page does not exist. <a href="/docs">Read the documentation</a>.</p></main></body></html>',
    {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8', Vary: 'Accept' },
    },
  )
}

function ClientNotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-5xl flex-col items-center justify-center px-5 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-3 max-w-md text-muted-foreground">The page you requested does not exist. Read the BG0 documentation or return to the background remover.</p>
      <Button asChild className="mt-7"><Link to="/">Back to BG0</Link></Button>
    </main>
  )
}

export const Route = createFileRoute('/$')({
  component: ClientNotFound,
  server: {
    handlers: {
      GET: ({ request }) => notFoundResponse(request),
      HEAD: ({ request }) => notFoundResponse(request),
    },
  },
})
