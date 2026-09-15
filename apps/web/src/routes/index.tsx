import { createFileRoute, useLoaderData } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import { type ComponentType, useEffect, useState } from 'react'

import { ComparePreview } from '#/components/compare-preview'
import { GitHubIcon } from '#/components/icons'
import { Button } from '#/components/ui/button'
import { Card, CardDescription, CardTitle } from '#/components/ui/card'
import { Kbd } from '#/components/ui/kbd'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { formatStars, GITHUB_URL } from '#/lib/site'

const loadRemover = import.meta.env.SSR
  ? null
  : () => import('#/features/remover/remover')

export const Route = createFileRoute('/')({
  head: () => ({ links: [{ rel: 'canonical', href: 'https://bg0.dev/' }] }),
  component: Home,
})

const shortcuts: { keys: string[]; action: string }[] = [
  { keys: ['⌘O'], action: 'Open a file' },
  { keys: ['⌘V'], action: 'Paste an image from the clipboard' },
  { keys: ['Space'], action: 'Hold to peek at the original' },
  { keys: ['←', '→'], action: 'Slide the compare line, Shift for 10%' },
  { keys: ['1', '2', '3'], action: 'Compare, result, original' },
  { keys: ['⌘S'], action: 'Download the PNG' },
  { keys: ['⌘C'], action: 'Copy the PNG to the clipboard' },
  { keys: ['Esc'], action: 'Clear and wait for the next image' },
]

function Home() {
  const { stars } = useLoaderData({ from: '__root__' })
  return (
    <main>
      <section className="px-5 pt-7 sm:px-8 sm:pt-20">
        <div className="mx-auto max-w-(--container-page)">
          <h1 className="text-[30px] font-semibold leading-9 tracking-[-0.025em] sm:text-center sm:text-[46px] sm:leading-[52px] sm:tracking-[-0.03em]">
            Background removal that stays on your device
          </h1>
          <p className="mt-2.5 text-[15px] leading-[22px] text-muted-foreground sm:mt-4 sm:text-center sm:text-[17px] sm:leading-[26px]">
            <span className="sm:hidden">
              Pick a photo, get a transparent PNG. Nothing is uploaded.
            </span>
            <span className="hidden sm:inline">
              Drop an image, get a transparent PNG. Runs in your browser,
              nothing is uploaded.
            </span>
          </p>
          <div className="mt-6 sm:mt-9">
            <BrowserRemover />
          </div>
        </div>
      </section>

      <section className="px-5 pt-14 sm:px-8 sm:pt-[120px]">
        <Tabs defaultValue="flow" className="mx-auto max-w-(--container-page)">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-[22px] font-semibold leading-7 tracking-[-0.02em] sm:text-[28px] sm:leading-[34px]">
                <span className="sm:hidden">Photo to PNG in three taps</span>
                <span className="hidden sm:inline">
                  Three keys from photo to PNG
                </span>
              </h2>
              <p className="mt-2 hidden text-[15px] leading-[22px] text-muted-foreground sm:block">
                Every step has a shortcut. Hands never leave the keyboard.
              </p>
            </div>
            <TabsList
              className="hidden gap-1.5 sm:inline-flex"
              pillClassName="bg-primary"
            >
              {[
                ['flow', 'Flow'],
                ['shortcuts', 'Shortcuts'],
              ].map(([value, label]) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="h-8 border border-border bg-secondary px-3.5 text-[13px] data-[state=active]:border-transparent data-[state=active]:bg-transparent data-[state=active]:text-primary-foreground"
                >
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="flow" className="mt-4 sm:mt-8">
            <div className="grid gap-3 sm:grid-cols-3 sm:gap-5">
              <StageCard
                title="Drop"
                keys={['⌘V', '⌘O']}
                description="Drag, paste, or open. The model starts the moment the file lands."
                mobileTitle="Pick"
                mobileDescription="Camera, library, paste, or share sheet."
              >
                <DropPreview />
              </StageCard>
              <StageCard
                title="Compare"
                keys={['Space', '←', '→']}
                description="Drag the line or click anywhere. Hold Space to see the original; use arrows for fine control."
                mobileDescription="Tap or drag anywhere to compare before and after."
                className="order-first sm:order-none"
              >
                <ComparePreview />
              </StageCard>
              <StageCard
                title="Download"
                keys={['⌘S', '⌘C', 'Esc']}
                description="Save the PNG or copy it straight to the clipboard. Esc clears and waits for the next one."
                mobileTitle="Save"
                mobileDescription="To Photos, Files, or straight into another app."
              >
                <DownloadPreview />
              </StageCard>
            </div>
          </TabsContent>

          <TabsContent value="shortcuts" className="mt-8">
            <Card className="divide-y divide-border-subtle">
              {shortcuts.map((shortcut) => (
                <div
                  key={shortcut.action}
                  className="flex items-center justify-between gap-6 px-5 py-3.5 text-sm"
                >
                  <span className="text-muted-foreground">
                    {shortcut.action}
                  </span>
                  <span className="flex gap-1">
                    {shortcut.keys.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </span>
                </div>
              ))}
            </Card>
          </TabsContent>
        </Tabs>
      </section>

      <section className="px-5 py-14 sm:px-8 sm:py-[120px]">
        <div className="mx-auto flex max-w-(--container-page) flex-col gap-8 sm:gap-12">
          <div className="flex flex-col gap-3.5 sm:flex-row sm:items-end sm:justify-between sm:gap-8">
            <div className="flex flex-col gap-3 sm:max-w-[640px]">
              <h2 className="text-[26px] font-semibold leading-8 tracking-[-0.025em] sm:text-[36px] sm:leading-[42px] sm:tracking-[-0.03em]">
                Local by design
              </h2>
              <p className="text-[15px] leading-6 text-muted-foreground sm:text-[17px] sm:leading-7">
                Most background removers upload your photo to a server. BG0 runs
                the model in your browser instead, so your photo and result stay
                on your device from start to finish.
              </p>
            </div>
            <Button
              variant="secondary"
              asChild
              className="hidden sm:inline-flex"
            >
              <a href={GITHUB_URL}>
                <GitHubIcon /> View on GitHub
                {stars !== null && ` · ${formatStars(stars)}`}
              </a>
            </Button>
          </div>

          <div className="grid gap-3 sm:grid-cols-3 sm:gap-5">
            <LocalPoint
              title="Runs on your GPU"
              body="BiRefNet runs through WebGPU when available, with a WebAssembly fallback for browsers that do not support it."
            >
              <span className="font-mono text-[11px] tracking-wide text-faint-foreground">
                WEBGPU · WASM FALLBACK
              </span>
            </LocalPoint>
            <LocalPoint
              title="Nothing is uploaded"
              body="Open the network panel and process an image. Your image pixels, filename, dimensions, and result never appear in a request. Close the tab and the image is gone."
            >
              <a
                href="/privacy"
                className="text-[13px] font-medium text-foreground underline-offset-4 hover:underline"
              >
                Read the privacy page
              </a>
            </LocalPoint>
            <LocalPoint
              title="Open source"
              body="Apache 2.0. Read the browser code, fork the site, or drop the browser package into your own product. No usage limits, no key to request."
            >
              <a
                href={GITHUB_URL}
                className="text-[13px] font-medium text-foreground underline-offset-4 hover:underline"
              >
                Read the source
              </a>
            </LocalPoint>
          </div>

          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Want the same thing in your own app? The browser package is the
              engine behind this page.
            </p>
            <Card className="flex flex-col gap-1 border-code-border bg-code px-5 py-4 font-mono text-[13px] leading-6 text-code-foreground sm:px-6">
              <span>
                <span className="text-syntax-flag">import</span>{' '}
                {'{ removeBackground }'}{' '}
                <span className="text-syntax-flag">from</span>{' '}
                <span className="text-syntax-string">'@bg0/browser'</span>
              </span>
              <span>
                <span className="text-syntax-flag">const</span> png ={' '}
                <span className="text-syntax-flag">await</span>{' '}
                <span className="text-syntax-command">removeBackground</span>
                (file)
              </span>
            </Card>
            <div className="flex items-center gap-2">
              <Button variant="secondary" asChild>
                <a href="/docs/library">Library docs</a>
              </Button>
              <Button variant="secondary" asChild className="sm:hidden">
                <a href={GITHUB_URL}>
                  <GitHubIcon /> GitHub
                  {stars !== null && ` · ${formatStars(stars)}`}
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}

function RemoverFallback() {
  return (
    <section
      aria-label="Preparing the local background remover"
      className="grid min-h-[430px] place-items-center rounded-xl border border-border-subtle bg-card text-sm text-muted-foreground sm:min-h-[520px]"
    >
      Preparing local remover…
    </section>
  )
}

function BrowserRemover() {
  const [Component, setComponent] = useState<ComponentType | null>(null)

  useEffect(() => {
    let mounted = true
    void loadRemover?.().then(({ Remover }) => {
      if (mounted) setComponent(() => Remover)
    })
    return () => {
      mounted = false
    }
  }, [])

  return Component ? <Component /> : <RemoverFallback />
}

function StageCard({
  title,
  mobileTitle,
  description,
  mobileDescription,
  keys,
  className,
  children,
}: {
  title: string
  mobileTitle?: string
  description: string
  mobileDescription?: string
  keys: string[]
  className?: string
  children: React.ReactNode
}) {
  return (
    <Card className={className}>
      {children}
      <div className="flex flex-col gap-2 px-4 pt-3 pb-[18px]">
        <div className="flex items-center justify-between">
          <CardTitle>
            {mobileTitle ? (
              <>
                <span className="sm:hidden">{mobileTitle}</span>
                <span className="hidden sm:inline">{title}</span>
              </>
            ) : (
              title
            )}
          </CardTitle>
          <span className="hidden gap-1 sm:flex">
            {keys.map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </span>
        </div>
        <CardDescription>
          {mobileDescription ? (
            <>
              <span className="sm:hidden">{mobileDescription}</span>
              <span className="hidden sm:inline">{description}</span>
            </>
          ) : (
            description
          )}
        </CardDescription>
      </div>
    </Card>
  )
}

function PreviewFrame({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={
        'relative m-2 h-[200px] overflow-hidden rounded-[10px] border border-border-subtle bg-background sm:h-60 ' +
        (className ?? '')
      }
    >
      {children}
    </div>
  )
}

function DropPreview() {
  return (
    <PreviewFrame className="hidden sm:block">
      <div className="absolute inset-2.5 rounded-lg border border-dashed border-wipe opacity-70" />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pb-8">
        <span className="text-[13px] font-medium">Release to remove</span>
        <span className="text-xs text-faint-foreground">cat.jpg · 768×512</span>
      </div>
      <img
        src="/samples/cat.webp"
        alt="A cat being dragged onto the drop zone"
        width={132}
        height={88}
        loading="lazy"
        className="absolute right-9 bottom-7 h-[88px] w-[132px] -rotate-6 rounded-lg border border-white/15 object-cover shadow-[0_16px_32px_rgba(0,0,0,0.65)]"
      />
      <svg
        className="absolute right-[26px] bottom-[22px]"
        width="18"
        height="20"
        viewBox="0 0 18 20"
        fill="#EDEDED"
        stroke="#0A0A0A"
        strokeWidth="1.2"
        aria-hidden="true"
      >
        <path d="M2 1l14 9-6 1.5L13.5 18 10 19.5 6.5 13 2 16z" />
      </svg>
    </PreviewFrame>
  )
}

function DownloadPreview() {
  return (
    <PreviewFrame className="hidden sm:block">
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3.5">
        <div className="flex h-14 items-center gap-3 rounded-xl border border-input bg-secondary pr-4 pl-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_12px_32px_rgba(0,0,0,0.5)]">
          <span className="grid size-8 place-items-center rounded-[7px] border border-input bg-background">
            <Check aria-hidden="true" className="size-4 text-success" />
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium">cat-bg0.png</span>
            <span className="font-mono text-[11px] text-faint-foreground">
              768×512 · alpha · 470 KB
            </span>
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-flex h-8 items-center rounded-full bg-linear-to-b from-(--primary-gradient-from) to-(--primary-gradient-to) px-3.5 text-[13px] font-medium text-primary-foreground shadow-[inset_0_1px_0_var(--primary-highlight),inset_0_-1px_0_var(--primary-shade),0_1px_2px_rgba(0,0,0,0.5)]">
            Download
          </span>
          <span className="inline-flex h-8 items-center rounded-full border border-input bg-secondary px-3.5 text-[13px] font-medium">
            Copy
          </span>
        </div>
      </div>
    </PreviewFrame>
  )
}

function LocalPoint({
  title,
  body,
  children,
}: {
  title: string
  body: string
  children?: React.ReactNode
}) {
  return (
    <Card className="flex flex-col gap-3 p-5 sm:p-6">
      <CardTitle className="text-[17px]">{title}</CardTitle>
      <CardDescription className="text-[14px] leading-[22px]">
        {body}
      </CardDescription>
      {children && <div className="mt-auto pt-1">{children}</div>}
    </Card>
  )
}
