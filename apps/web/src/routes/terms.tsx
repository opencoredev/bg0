import { createFileRoute } from '@tanstack/react-router'

import { LegalPage } from '#/components/legal-page'
import { GITHUB_URL } from '#/lib/site'

export const Route = createFileRoute('/terms')({
  head: () => ({
    meta: [
      { title: 'Terms — BG0' },
      {
        name: 'description',
        content:
          'The terms for using bg0.dev and the BG0 open-source software.',
      },
    ],
    links: [{ rel: 'canonical', href: 'https://bg0.dev/terms' }],
  }),
  component: Terms,
})

function Terms() {
  return (
    <LegalPage title="Terms" updated="September 15, 2026">
      <p>
        These terms cover the bg0.dev website and the BG0 software. They are
        short because the product is simple: a tool that runs on your device.
      </p>
      <h2>The software</h2>
      <p>
        BG0 is open source under the Apache 2.0 license. You can use, copy,
        modify, and redistribute it under the terms of that license, which is in
        the repository. The model weights and HEIC decoder are licensed
        separately by their authors; see the{' '}
        <a href="/third-party/THIRD_PARTY_NOTICES.txt">third-party notices</a>.
      </p>
      <h2>The website</h2>
      <p>
        bg0.dev is provided free of charge and as is. We aim to keep it
        available but make no guarantee of uptime, and we may change or
        discontinue it at any time.
      </p>
      <h2>Your content</h2>
      <p>
        Images you process stay on your device, so you keep every right to them
        and we never hold a copy. You are responsible for having the right to
        process the images you use.
      </p>
      <h2>No warranty</h2>
      <p>
        The site and the software are provided without warranty of any kind, to
        the extent permitted by law. Results depend on the input image and may
        need manual touch-up.
      </p>
      <h2>Contact</h2>
      <p>
        Questions and reports go to the issue tracker on{' '}
        <a href={`${GITHUB_URL}/issues`}>GitHub</a>.
      </p>
    </LegalPage>
  )
}
