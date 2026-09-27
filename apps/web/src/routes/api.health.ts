import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () =>
        Response.json({
          ok: true,
          service: 'bg0',
          mode: 'browser-only',
          message: 'BG0 is ready. Image processing runs in the browser.',
        }),
    },
  },
})
