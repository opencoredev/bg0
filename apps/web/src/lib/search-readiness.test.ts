import { describe, expect, test } from 'bun:test'

const PUBLIC_URLS = [
  'https://bg0.dev/',
  'https://bg0.dev/privacy',
  'https://bg0.dev/terms',
  'https://bg0.dev/docs',
  'https://bg0.dev/docs/quickstart',
  'https://bg0.dev/docs/web',
  'https://bg0.dev/docs/web/shortcuts',
  'https://bg0.dev/docs/web/privacy',
  'https://bg0.dev/docs/library',
]

describe('search crawler files', () => {
  test('sitemap lists every canonical public page once', async () => {
    const sitemap = await Bun.file('public/sitemap.xml').text()
    const locations = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(
      ([, location]) => location,
    )

    expect(locations).toEqual(PUBLIC_URLS)
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
