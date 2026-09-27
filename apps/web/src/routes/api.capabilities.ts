import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/capabilities')({
  server: {
    handlers: {
      GET: () =>
        Response.json({
          name: 'BG0',
          description: 'Private, browser-only image background removal.',
          processing: 'on-device',
          uploads: false,
          authentication: 'none',
          output: 'transparent PNG',
          docs: 'https://bg0.dev/docs',
          openapi: 'https://bg0.dev/openapi.json',
        }),
    },
  },
})
