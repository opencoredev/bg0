import { describe, expect, test } from 'bun:test'

const SITE_URL = 'https://bg0.dev'

async function getPublicUrls(): Promise<string[]> {
  const webRoutes = await Array.fromAsync(
    new Bun.Glob('src/routes/*.tsx').scan({ onlyFiles: true }),
  )
  const webUrls = webRoutes
    .map((path) =>
      path
        .replaceAll('\\', '/')
        .split('/')
        .at(-1)
        ?.replace(/\.tsx$/, '') ?? '',
    )
    .filter((route) => route && !route.startsWith('__') && !route.includes('$'))
    .map((route) => `${SITE_URL}${route === 'index' ? '/' : `/${route}`}`)

  const docsPages = await Array.fromAsync(
    new Bun.Glob('../docs/docs/**/*.mdx').scan({ onlyFiles: true }),
  )
  const docsUrls = docsPages.map((path) => {
    const route = path
      .replaceAll('\\', '/')
      .replace('../docs/docs/', '')
      .replace(/\.mdx$/, '')
      .split('/')
      .map((segment) => segment.replace(/^\d+-/, ''))
      .filter((segment) => segment !== 'index')
      .join('/')

    return `${SITE_URL}/docs${route ? `/${route}` : ''}`
  })

  return [...webUrls, ...docsUrls].sort()
}

describe('search crawler files', () => {
  test('sitemap lists every canonical public page once', async () => {
    const sitemap = await Bun.file('public/sitemap.xml').text()
    const locations = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(
      ([, location]) => location,
    )

    expect(locations.sort()).toEqual(await getPublicUrls())
    expect(new Set(locations).size).toBe(locations.length)
    expect(sitemap).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    )
  })

  test('robots allows crawling and points to the canonical sitemap', async () => {
    const robots = await Bun.file('public/robots.txt').text()

    expect(robots).toContain('User-agent: *')
    expect(robots).toContain('Allow: /')
    expect(robots).toContain('Sitemap: https://bg0.dev/sitemap.xml')
    expect(robots).not.toContain('Disallow: /')
  })
})
