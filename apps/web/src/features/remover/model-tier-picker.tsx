import type { ModelTier } from '@bg0/browser'
import { useId } from 'react'

import { cn } from '#/lib/utils'
import { FULL_DOWNLOAD_LABEL, LITE_DOWNLOAD_LABEL } from './model-tier'

const OPTIONS: { tier: ModelTier; label: string; size?: string }[] = [
  { tier: 'auto', label: 'Auto' },
  { tier: 'lite', label: 'Lite', size: LITE_DOWNLOAD_LABEL },
  { tier: 'full', label: 'Full', size: FULL_DOWNLOAD_LABEL },
]

const DESCRIPTIONS: Record<ModelTier, string> = {
  auto: 'Chooses Full or Lite for this device.',
  lite: 'Smaller download, less fine detail.',
  full: 'Most detail, largest download.',
}

export function ModelTierPicker({
  value,
  onChange,
}: {
  value: ModelTier
  onChange: (tier: ModelTier) => void
}) {
  const id = useId()
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1.5">
        <span id={`${id}-label`} className="text-[13px] text-muted-foreground">
          Model
        </span>
        <div
          role="radiogroup"
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-description`}
          className="inline-flex items-center gap-0.5 rounded-full border border-border bg-card p-0.5"
        >
          {OPTIONS.map((option) => (
            <label
              key={option.tier}
              className={cn(
                'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-muted-foreground transition-colors duration-(--duration-quick) ease-(--ease-out) hover:text-foreground has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                value === option.tier && 'bg-accent text-foreground',
              )}
            >
              <input
                type="radio"
                name={`${id}-tier`}
                value={option.tier}
                checked={value === option.tier}
                onChange={() => onChange(option.tier)}
                className="sr-only"
              />
              {option.label}
              {option.size && (
                <span className="font-mono text-[11px] tabular-nums opacity-70">
                  {option.size}
                </span>
              )}
            </label>
          ))}
        </div>
      </div>
      <p
        id={`${id}-description`}
        className="text-center text-xs text-muted-foreground"
      >
        {DESCRIPTIONS[value]}
      </p>
    </div>
  )
}
