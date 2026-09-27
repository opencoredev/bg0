import { createFileRoute } from '@tanstack/react-router'

import { LegalPage } from '#/components/legal-page'

export const Route = createFileRoute('/about')({
  head: () => ({
    meta: [
      { title: 'About BG0' },
      { name: 'description', content: 'About BG0, a private browser-only background remover.' },
    ],
    links: [{ rel: 'canonical', href: 'https://bg0.dev/about' }],
  }),
  component: About,
})

function About() {
  return (
    <LegalPage title="About BG0" updated="September 27, 2026">
      <p>BG0 is an open-source background remover built for people who want a transparent PNG without sending an image to a remote service. The complete product runs in the browser. A model is downloaded to the browser, inference runs on the device, and the result is assembled locally.</p>
      <p>BG0 is free, anonymous, and unlimited for local use. There is no account, billing system, hosted inference API, or asset library. This narrow design keeps the privacy boundary easy to understand and makes the app useful for product photos, profile images, illustrations, and quick personal work.</p>
      <h2>Open source</h2>
      <p>BG0 is maintained in the public repository on <a href="https://github.com/opencoredev/bg0">GitHub</a>. Read the <a href="/docs">documentation</a> for the browser package and the <a href="/privacy">privacy policy</a> for data handling.</p>
    </LegalPage>
  )
}
