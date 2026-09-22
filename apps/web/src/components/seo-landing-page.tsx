import { Link } from '@tanstack/react-router'
import { Button } from '#/components/ui/button'
import { SITE_URL } from '#/lib/site'

type LandingPageProps = {
  title: string
  intro: string
  steps: string[]
  points: Array<{ title: string; body: string }>
  related: Array<{ href: string; label: string }>
}

export function SeoLandingPage({
  title,
  intro,
  steps,
  points,
  related,
}: LandingPageProps) {
  return (
    <main className="px-5 pt-12 pb-20 sm:px-8 sm:pt-20">
      <article className="mx-auto max-w-3xl">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          BG0 · local image tool
        </p>
        <h1 className="mt-4 text-4xl font-semibold leading-tight tracking-[-0.03em] sm:text-5xl">
          {title}
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-muted-foreground">
          {intro}
        </p>
        <Button asChild className="mt-8">
          <a href="/#remover">Remove an image background</a>
        </Button>
        <p className="mt-4 text-sm text-muted-foreground">
          Use BG0 regularly? Bookmark bg0.dev for your next image. No account
          needed.
        </p>

        <section className="mt-16 border-t border-border-subtle pt-10">
          <h2 className="text-2xl font-semibold tracking-tight">
            How it works
          </h2>
          <ol className="mt-6 grid gap-4 sm:grid-cols-3">
            {steps.map((step, index) => (
              <li
                key={step}
                className="rounded-lg border border-border-subtle bg-card p-5"
              >
                <span className="font-mono text-sm text-muted-foreground">
                  0{index + 1}
                </span>
                <p className="mt-3 text-sm leading-6">{step}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-14 grid gap-8 sm:grid-cols-2">
          {points.map((point) => (
            <div key={point.title}>
              <h2 className="text-lg font-semibold">{point.title}</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {point.body}
              </p>
            </div>
          ))}
        </section>

        <section className="mt-14 rounded-lg border border-border-subtle bg-card p-6 sm:p-8">
          <h2 className="text-lg font-semibold">More from BG0</h2>
          <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {related.map((item) => (
              <Link
                key={item.href}
                to={item.href}
                className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                {item.label}
              </Link>
            ))}
            <Link
              to="/privacy"
              className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Privacy details
            </Link>
          </div>
        </section>
      </article>
    </main>
  )
}

export function landingHead(title: string, description: string, path: string) {
  return {
    meta: [
      { title: `${title} — BG0` },
      { name: 'description', content: description },
      { property: 'og:title', content: `${title} — BG0` },
      { property: 'og:description', content: description },
      { property: 'og:url', content: `${SITE_URL}${path}` },
      { name: 'twitter:title', content: `${title} — BG0` },
      { name: 'twitter:description', content: description },
    ],
    links: [{ rel: 'canonical', href: `${SITE_URL}${path}` }],
  }
}
