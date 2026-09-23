import { X } from 'lucide-react'
import { useState } from 'react'

import { Button } from '#/components/ui/button'
import {
  captureCrossPromoClicked,
  captureCrossPromoDismissed,
} from '#/lib/analytics'

const SOCIAL_SDK_URL =
  'https://social-sdk.dev/?utm_source=bg0.dev&utm_medium=banner&utm_campaign=social-sdk-launch'

export const LAUNCH_BANNER_DISMISSED_KEY = 'bg0-banner-dismissed:social-sdk'
export const LAUNCH_BANNER_HIDDEN_CLASS = 'launch-banner-dismissed'

// Runs before paint so returning visitors who closed the banner never see it flash.
export const LAUNCH_BANNER_SCRIPT = `try{if(localStorage.getItem('${LAUNCH_BANNER_DISMISSED_KEY}')==='true')document.documentElement.classList.add('${LAUNCH_BANNER_HIDDEN_CLASS}')}catch(_){}`

export function LaunchBanner() {
  const [open, setOpen] = useState(true)
  if (!open) return null

  function dismiss() {
    setOpen(false)
    captureCrossPromoDismissed('social-sdk')
    try {
      window.localStorage.setItem(LAUNCH_BANNER_DISMISSED_KEY, 'true')
    } catch {
      // The banner still closes for this visit when storage is unavailable.
    }
  }

  return (
    <div className="relative flex h-10 items-center justify-center border-b border-border bg-secondary pr-10 pl-3 text-center text-xs font-medium in-[.launch-banner-dismissed]:hidden sm:text-sm">
      <a
        href={SOCIAL_SDK_URL}
        target="_blank"
        rel="noopener"
        onClick={() => captureCrossPromoClicked('social-sdk')}
        className="truncate rounded-sm text-muted-foreground outline-none transition-colors duration-(--duration-quick) ease-(--ease-out) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="hidden sm:inline">Hey, Leo here 👋 </span>I just
        launched{' '}
        <span className="font-semibold text-foreground underline underline-offset-4">
          Social SDK
        </span>
        <span className="hidden sm:inline">, my new open source project</span>.
        Come check it out →
      </a>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Close announcement"
        onClick={dismiss}
        className="absolute top-1/2 right-1 -translate-y-1/2"
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  )
}
