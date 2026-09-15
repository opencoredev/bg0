import { useState } from 'react'

const clamp = (value: number) => Math.min(100, Math.max(0, value))

export function ComparePreview() {
  const [position, setPosition] = useState(50)
  const [dragging, setDragging] = useState(false)
  const [peeking, setPeeking] = useState(false)

  const moveToPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const next = ((event.clientX - bounds.left) / bounds.width) * 100
    setPosition(clamp(next))
  }

  const moveBy = (delta: number) => {
    setPosition((current) => clamp(current + delta))
  }

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Compare the original image with the background-removed result"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(position)}
      aria-valuetext={`${Math.round(position)}% original visible`}
      data-view="compare"
      data-peek={peeking ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      data-instant={peeking || dragging ? 'true' : undefined}
      className="compare relative m-2 h-[200px] touch-none select-none overflow-hidden rounded-[10px] border border-border-subtle bg-checker outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:h-60"
      style={{ '--wipe-pos': `${position}%` } as React.CSSProperties}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
        moveToPointer(event)
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        moveToPointer(event)
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId)
        }
        setDragging(false)
      }}
      onPointerCancel={() => setDragging(false)}
      onLostPointerCapture={() => setDragging(false)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 10 : 3
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          moveBy(-step)
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          moveBy(step)
        } else if (event.key === 'Home') {
          event.preventDefault()
          setPosition(0)
        } else if (event.key === 'End') {
          event.preventDefault()
          setPosition(100)
        } else if (event.code === 'Space') {
          event.preventDefault()
          setPeeking(true)
        }
      }}
      onKeyUp={(event) => {
        if (event.code !== 'Space') return
        event.preventDefault()
        setPeeking(false)
      }}
      onBlur={() => setPeeking(false)}
    >
      <img
        src="/samples/cat-bg0.webp"
        alt="The same cat with its background removed"
        width={768}
        height={512}
        loading="lazy"
        draggable={false}
        className="absolute inset-0 size-full object-cover"
      />
      <img
        src="/samples/cat.webp"
        alt=""
        width={768}
        height={512}
        loading="lazy"
        draggable={false}
        className="compare-source absolute inset-0 size-full object-cover"
      />
      <div
        aria-hidden="true"
        className="compare-line compare-fade absolute inset-y-0 w-0.5 -translate-x-1/2 bg-wipe"
      />
      <div
        aria-hidden="true"
        className="compare-handle compare-fade absolute top-1/2 flex size-9 items-center justify-center gap-[3px] rounded-full border border-border bg-primary text-primary-foreground shadow-[0_2px_8px_rgba(0,0,0,0.6)]"
      >
        <Chevron direction="left" />
        <Chevron direction="right" />
      </div>
      <span className="compare-fade absolute top-2.5 left-2.5 hidden rounded bg-black/55 px-1.5 py-[3px] font-mono text-[10px] tracking-[0.08em] text-white sm:block">
        BEFORE
      </span>
      <span className="compare-fade absolute top-2.5 right-2.5 hidden rounded bg-black/55 px-1.5 py-[3px] font-mono text-[10px] tracking-[0.08em] text-white sm:block">
        AFTER
      </span>
      <span className="compare-fade absolute right-2.5 bottom-2.5 hidden rounded bg-black/55 px-1.5 py-[3px] font-mono text-[10px] text-white/70 sm:block">
        1.8s · WebGPU
      </span>
    </div>
  )
}

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg
      width="5"
      height="9"
      viewBox="0 0 6 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={direction === 'left' ? 'M5 1 1 5l4 4' : 'm1 1 4 4-4 4'} />
    </svg>
  )
}
