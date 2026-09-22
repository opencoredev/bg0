import { createFileRoute } from '@tanstack/react-router'
import { type ComponentType, useEffect, useState } from 'react'
import { Button } from '#/components/ui/button'

const loadRemover = import.meta.env.SSR
  ? null
  : () => import('#/features/remover/remover')

export const Route = createFileRoute('/')({
  head: () => ({ links: [{ rel: 'canonical', href: 'https://bg0.dev/' }] }),
  component: Home,
})

function Home() {
  return (
    <main className="px-5 pt-7 pb-14 sm:px-8 sm:pt-20 sm:pb-[120px]">
      <section className="mx-auto max-w-(--container-page)">
        <h1 className="text-[30px] font-semibold leading-9 tracking-[-0.025em] sm:text-center sm:text-[46px] sm:leading-[52px] sm:tracking-[-0.03em]">
          Remove an image background
        </h1>
        <p className="mt-2.5 text-[15px] leading-[22px] text-muted-foreground sm:mt-4 sm:text-center sm:text-[17px] sm:leading-[26px]">
          Choose an image and download a transparent PNG. Nothing is uploaded.
        </p>
        <div id="remover" className="mt-6 scroll-mt-6 sm:mt-9">
          <BrowserRemover />
        </div>
        <nav
          aria-label="Background removal guides"
          className="mx-auto mt-10 flex max-w-2xl flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-muted-foreground"
        >
          <a
            className="underline-offset-4 hover:text-foreground hover:underline"
            href="/background-remover"
          >
            Free background remover
          </a>
          <a
            className="underline-offset-4 hover:text-foreground hover:underline"
            href="/transparent-png"
          >
            Make a transparent PNG
          </a>
          <a
            className="underline-offset-4 hover:text-foreground hover:underline"
            href="/product-photo-background-remover"
          >
            Product photo remover
          </a>
        </nav>
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
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let mounted = true
    void loadRemover?.()
      ?.then(({ Remover, warmBackgroundRemovalModel }) => {
        if (!mounted) return
        warmBackgroundRemovalModel()
        setComponent(() => Remover)
      })
      ?.catch(() => {
        if (!mounted) return
        setFailed(true)
      })
    return () => {
      mounted = false
    }
  }, [])

  if (failed) {
    return (
      <section
        role="alert"
        aria-label="Failed to load local background remover"
        className="grid min-h-[430px] place-items-center rounded-xl border border-border-subtle bg-card p-6 text-center text-sm text-muted-foreground sm:min-h-[520px]"
      >
        <div className="flex flex-col items-center gap-3">
          <p>Local remover could not be loaded.</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => window.location.reload()}
          >
            Reload
          </Button>
        </div>
      </section>
    )
  }

  return Component ? <Component /> : <RemoverFallback />
}
