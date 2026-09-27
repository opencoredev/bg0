import { createFileRoute } from '@tanstack/react-router'

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

export const Route = createFileRoute('/$')({
  server: {
    handlers: {
      GET: ({ request }) => notFoundResponse(request),
      HEAD: ({ request }) => notFoundResponse(request),
    },
  },
})
