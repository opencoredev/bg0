// Run the app locally first, then: bun run --cwd apps/web test:layout
// Install engines with: bunx playwright install chromium firefox webkit
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, firefox, webkit } from 'playwright'

const engines = { chromium, firefox, webkit }
const engineName = process.env.BG0_TEST_BROWSER ?? 'chromium'
assert(engineName in engines, `Unknown browser: ${engineName}`)
const engine = engines[engineName as keyof typeof engines]
const baseUrl = process.env.BG0_TEST_URL ?? 'http://127.0.0.1:3000'
const screenshots = process.env.BG0_TEST_SCREENSHOTS
const fixture = fileURLToPath(
  new URL('../public/samples/cat.webp', import.meta.url),
)
const browser = await engine.launch({ headless: true })
try {
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(baseUrl)
  const input = page.locator('input[type=file]').first()
  await input.setInputFiles(fixture)
  const downloadButton = page.getByTestId('download-result')
  await downloadButton.waitFor({ timeout: 180_000 })
  const card = page
    .getByRole('region', { name: 'Background remover' })
    .locator(':scope > div')
    .first()
  if (screenshots) await mkdir(screenshots, { recursive: true })

  for (const width of [
    320, 360, 375, 639, 640, 700, 767, 768, 1023, 1024, 1280,
  ]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    )
    const bounds = await card.boundingBox()
    assert(bounds)
    for (const button of [page.getByTestId('copy-result'), downloadButton]) {
      const rect = await button.boundingBox()
      assert(rect)
      assert(
        rect.x >= bounds.x &&
          rect.x + rect.width <= bounds.x + bounds.width + 1,
        `${engineName} ${width}px: export button extends beyond the card`,
      )
      assert(
        rect.y >= bounds.y &&
          rect.y + rect.height <= bounds.y + bounds.height + 1,
        `${engineName} ${width}px: export button is vertically clipped`,
      )
      assert(
        await button.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
        `${engineName} ${width}px: export label overflows its button`,
      )
    }
    if (screenshots)
      await page.screenshot({
        path: `${screenshots}/${engineName}-${width}.png`,
      })
  }

  const alpha = await page
    .getByAltText('Background removed', { exact: true })
    .evaluate(async (element) => {
      const image = element as HTMLImageElement
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Canvas is unavailable')
      ctx.drawImage(image, 0, 0)
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let transparent = 0
      let opaque = 0
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] === 0) transparent += 1
        if (pixels[i] === 255) opaque += 1
      }
      return { transparent, opaque }
    })
  assert(
    alpha.transparent > 0 && alpha.opaque > 0,
    'Expected a nonempty transparent cutout',
  )
  const pendingDownload = page.waitForEvent('download')
  await downloadButton.click()
  const download = await pendingDownload
  assert.equal(await download.failure(), null)
  assert.equal(download.suggestedFilename(), 'cat-bg0.png')
  await page.keyboard.press('Escape')
  await page
    .getByRole('button', { name: 'Choose image', exact: false })
    .waitFor()
  await input.setInputFiles({
    name: 'invalid.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not an image'),
  })
  await page
    .getByText('That image could not be processed', { exact: true })
    .waitFor()
  assert.deepEqual(errors, [])
  console.log(
    `${engineName} ${browser.version()}: 11 widths, PNG alpha, download, reset, and invalid input passed`,
  )
} finally {
  await browser.close()
}
