import { LogoMark } from '#/components/logo'
import { otherOpenCoreSites } from '#/lib/opencore-sites'
import { GITHUB_URL, SITE_URL } from '#/lib/site'

const links = [
  { href: '/docs', label: 'Docs' },
  { href: '/docs/library', label: 'Library' },
  { href: GITHUB_URL, label: 'GitHub' },
  { href: '/about', label: 'About' },
  { href: '/contact', label: 'Contact' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
]

// Plain followed links on purpose: they share authority between our sites.
const openCoreSites = otherOpenCoreSites(SITE_URL)

const linkClass =
  'rounded-sm outline-none transition-colors duration-(--duration-quick) ease-(--ease-out) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring'

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border-subtle">
      <div className="mx-auto max-w-(--container-page) px-5 text-[13px] text-muted-foreground sm:px-8">
        <nav
          aria-labelledby="footer-opencore"
          className="flex flex-col gap-3 pt-6 sm:pt-8"
        >
          <h2 id="footer-opencore" className="font-medium text-foreground">
            More from OpenCore
          </h2>
          <ul className="grid gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {openCoreSites.map((site) => (
              <li key={site.url}>
                <a href={site.url} className={linkClass}>
                  <span className="font-medium text-foreground">
                    {site.name}
                  </span>{' '}
                  {site.description}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex flex-col gap-3.5 pt-6 pb-24 sm:h-[72px] sm:flex-row-reverse sm:items-center sm:justify-between sm:py-0 sm:mt-2">
          <nav aria-label="Footer" className="flex flex-wrap gap-4 font-medium">
            {links.map((link) => (
              <a key={link.label} href={link.href} className={linkClass}>
                {link.label}
              </a>
            ))}
          </nav>
          <span className="inline-flex items-center gap-2.5 text-xs text-faint-foreground sm:text-[13px] sm:text-muted-foreground">
            <LogoMark className="hidden size-4 text-foreground sm:block" />©{' '}
            {new Date().getFullYear()} bg0 · Apache 2.0
          </span>
        </div>
      </div>
    </footer>
  )
}
