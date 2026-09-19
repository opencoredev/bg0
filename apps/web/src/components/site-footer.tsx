import { LogoMark } from '#/components/logo'
import { GITHUB_URL } from '#/lib/site'

const links = [
  { href: '/docs', label: 'Docs' },
  { href: '/docs/library', label: 'Library' },
  { href: GITHUB_URL, label: 'GitHub' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
]

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border-subtle">
      <div className="mx-auto flex max-w-(--container-page) flex-col gap-3.5 px-5 pt-6 pb-24 text-[13px] text-muted-foreground sm:h-[72px] sm:flex-row-reverse sm:items-center sm:justify-between sm:px-8 sm:py-0">
        <nav aria-label="Footer" className="flex flex-wrap gap-4 font-medium">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="rounded-sm outline-none transition-colors duration-(--duration-quick) ease-(--ease-out) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {link.label}
            </a>
          ))}
        </nav>
        <span className="inline-flex items-center gap-2.5 text-xs text-faint-foreground sm:text-[13px] sm:text-muted-foreground">
          <LogoMark className="hidden size-4 text-foreground sm:block" />©{' '}
          {new Date().getFullYear()} bg0 · Apache 2.0
        </span>
      </div>
    </footer>
  )
}
