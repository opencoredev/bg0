import { createFileRoute } from '@tanstack/react-router'
import { type ComponentType, useEffect, useState } from 'react'

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
        <div className="mt-6 sm:mt-9">
          <BrowserRemover />
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
    void loadRemover?.().then(({ Remover, warmBackgroundRemovalModel }) => {
      warmBackgroundRemovalModel()
      if (mounted) setComponent(() => Remover)
    })
    return () => {
      mounted = false
    }
  }, [])

  return Component ? <Component /> : <RemoverFallback />
}
