import { createFileRoute } from '@tanstack/react-router'

import { LegalPage } from '#/components/legal-page'

export const Route = createFileRoute('/contact')({
  head: () => ({
    meta: [
      { title: 'Contact BG0' },
      { name: 'description', content: 'Contact and support options for BG0.' },
    ],
    links: [{ rel: 'canonical', href: 'https://bg0.dev/contact' }],
  }),
  component: Contact,
})

function Contact() {
  return (
    <LegalPage title="Contact BG0" updated="September 27, 2026">
      <p>BG0 is an open-source browser-only background remover. For product feedback, bug reports, and documentation questions, use the <a href="https://github.com/opencoredev/bg0/issues/new/choose">public issue tracker</a>. Include the browser, operating system, route, and steps to reproduce. Do not attach private images or paste image URLs.</p>
      <h2>Project information</h2>
      <p>For general project context, read the <a href="/about">about page</a>, <a href="/privacy">privacy policy</a>, and <a href="/docs">documentation</a>. The project does not provide a hosted image-processing API or account support queue because images are processed locally and never uploaded.</p>
      <p>Security reports should follow the repository's security policy on GitHub rather than being posted publicly. This keeps sensitive details private while maintainers investigate them.</p>
    </LegalPage>
  )
}
