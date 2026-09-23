import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from '@tanstack/react-router'

import { AnalyticsPageView } from '#/components/analytics-page-view'
import { AppError } from '#/components/app-error'
import { LAUNCH_BANNER_SCRIPT, LaunchBanner } from '#/components/launch-banner'
import { SiteFooter } from '#/components/site-footer'
import { SiteHeader } from '#/components/site-header'
import { Button } from '#/components/ui/button'
import { getStarCount } from '#/lib/github'
import { SITE_URL } from '#/lib/site'
import appCss from '../styles.css?url'

const DESCRIPTION =
  'Background removal that stays on your device. Drop an image, get a transparent PNG. Nothing is uploaded.'

const GOOGLE_SITE_VERIFICATION = import.meta.env
  .VITE_GOOGLE_SITE_VERIFICATION as string | undefined

const STRUCTURED_DATA = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: 'BG0',
  url: SITE_URL,
  description: DESCRIPTION,
  applicationCategory: 'MultimediaApplication',
  operatingSystem: 'Any',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
  },
})

const THEME_SCRIPT = `(function(){try{var saved=localStorage.getItem('blume-theme')||localStorage.getItem('bg0-theme');var theme=saved==='light'||saved==='dark'?saved:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');var root=document.documentElement;root.classList.toggle('dark',theme==='dark');root.style.colorScheme=theme;var meta=document.querySelector('meta[name="theme-color"]');if(meta)meta.content=theme==='dark'?'#0a0a0a':'#ffffff'}catch(_){}})()`

export const Route = createRootRoute({
  loader: async () => ({ stars: await getStarCount() }),
  staleTime: 10 * 60 * 1000,
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'BG0 — Remove backgrounds locally' },
      { name: 'description', content: DESCRIPTION },
      ...(GOOGLE_SITE_VERIFICATION
        ? [
            {
              name: 'google-site-verification',
              content: GOOGLE_SITE_VERIFICATION,
            },
          ]
        : []),
      { name: 'theme-color', content: '#0a0a0a' },
      { name: 'color-scheme', content: 'light dark' },
      { property: 'og:type', content: 'website' },
      { property: 'og:locale', content: 'en_US' },
      { property: 'og:site_name', content: 'BG0' },
      { property: 'og:title', content: 'BG0 — Remove backgrounds locally' },
      { property: 'og:description', content: DESCRIPTION },
      { property: 'og:url', content: SITE_URL },
      { property: 'og:image', content: `${SITE_URL}/og.png` },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      {
        property: 'og:image:alt',
        content: 'BG0: background removal that stays on your device',
      },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:site', content: '@leodev' },
      { name: 'twitter:title', content: 'BG0 — Remove backgrounds locally' },
      { name: 'twitter:description', content: DESCRIPTION },
      { name: 'twitter:image', content: `${SITE_URL}/og.png` },
    ],
    links: [
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      {
        rel: 'icon',
        href: '/favicon-32.png',
        type: 'image/png',
        sizes: '32x32',
      },
      {
        rel: 'apple-touch-icon',
        href: '/apple-touch-icon.png',
        sizes: '180x180',
      },
      { rel: 'manifest', href: '/site.webmanifest' },
      { rel: 'stylesheet', href: appCss },
    ],
  }),
  notFoundComponent: NotFound,
  errorComponent: AppError,
  shellComponent: RootDocument,
  component: RootLayout,
})

function RootLayout() {
  const { stars } = Route.useLoaderData()
  return (
    <>
      <LaunchBanner />
      <SiteHeader stars={stars} />
      <Outlet />
      <SiteFooter />
    </>
  )
}

function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-5xl flex-col items-center justify-center px-5 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">
        Page not found
      </h1>
      <p className="mt-3 text-muted-foreground">
        The page you requested does not exist.
      </p>
      <Button asChild className="mt-7">
        <Link to="/">Back to BG0</Link>
      </Button>
    </main>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: this static script runs before CSS to prevent a theme flash and contains no user input. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: this static script hides a dismissed banner before paint and contains no user input. */}
        <script dangerouslySetInnerHTML={{ __html: LAUNCH_BANNER_SCRIPT }} />
        <script type="application/ld+json">{STRUCTURED_DATA}</script>
        <HeadContent />
      </head>
      <body className="flex min-h-dvh flex-col">
        <AnalyticsPageView />
        {children}
        <Scripts />
      </body>
    </html>
  )
}
