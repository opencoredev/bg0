import { createFileRoute } from '@tanstack/react-router'

function jsonError(
  code: string,
  message: string,
  resolution: string,
  status: number,
) {
  return Response.json(
    { error: { code, message, resolution } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )
}

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: () =>
        jsonError(
          'API_ROUTE_NOT_FOUND',
          'The requested BG0 API route does not exist.',
          'Read https://bg0.dev/openapi.json for the documented public endpoints.',
          404,
        ),
      POST: () =>
        jsonError(
          'METHOD_NOT_SUPPORTED',
          'BG0 does not accept image uploads or hosted processing requests.',
          'Process images locally with the browser app or use GET /api/capabilities.',
          405,
        ),
      PUT: () =>
        jsonError(
          'METHOD_NOT_SUPPORTED',
          'This BG0 API route does not support PUT requests.',
          'Read https://bg0.dev/openapi.json for supported operations.',
          405,
        ),
      HEAD: () =>
        jsonError(
          'API_ROUTE_NOT_FOUND',
          'The requested BG0 API route does not exist.',
          'Read https://bg0.dev/openapi.json for the documented public endpoints.',
          404,
        ),
      OPTIONS: () =>
        new Response(null, { status: 204, headers: { Allow: 'GET, HEAD, OPTIONS' } }),
      DELETE: () =>
        jsonError(
          'METHOD_NOT_SUPPORTED',
          'This BG0 API route does not support DELETE requests.',
          'Read https://bg0.dev/openapi.json for supported operations.',
          405,
        ),
    },
  },
})
