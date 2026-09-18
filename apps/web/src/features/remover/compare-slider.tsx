import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { cn } from '#/lib/utils'

export type CompareView = 'compare' | 'result' | 'original'

const MIN_TAP_DISTANCE = 3 // percent moved by a single arrow tap
const BASE_SPEED = 70 // percent per second while an arrow is held
const SHIFT_MULTIPLIER = 2.2

function clamp(value: number) {
  return Math.min(100, Math.max(0, value))
}

/**
 * Before/after wipe.
 * The wipe position lives in a CSS custom property that is written
 * directly to the DOM, so dragging never waits on a React render. The
 * CSS transition is disabled while dragging and re-enabled for taps,
 * view switches, and the arrow-key glide.
 */
export function CompareSlider({
  sourceUrl,
  resultUrl,
  view,
  peeking,
  active,
  onRequestCompare,
  className,
}: {
  sourceUrl: string
  resultUrl: string
  view: CompareView
  peeking: boolean
  /** When false, arrow keys are ignored (another surface owns focus). */
  active: boolean
  onRequestCompare: () => void
  className?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const sourceRef = useRef<HTMLImageElement>(null)
  const mediaBoundsRef = useRef({ left: 0, width: 0, top: 0, height: 0 })
  const wipeRef = useRef(50)
  const [dragging, setDragging] = useState(false)
  const [announced, setAnnounced] = useState(50)

  const write = useCallback((value: number) => {
    const next = clamp(value)
    wipeRef.current = next
    const root = rootRef.current
    if (!root) return
    root.style.setProperty('--wipe', String(next))
    const bounds = mediaBoundsRef.current
    if (bounds.width > 0) {
      root.style.setProperty(
        '--wipe-pos',
        `${bounds.left + (bounds.width * next) / 100}px`,
      )
    }
  }, [])

  const commit = useCallback(
    () => setAnnounced(Math.round(wipeRef.current)),
    [],
  )

  const positionFromPointer = useCallback((clientX: number) => {
    const rect = rootRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return wipeRef.current
    const bounds = mediaBoundsRef.current
    if (bounds.width === 0) return wipeRef.current
    return ((clientX - rect.left - bounds.left) / bounds.width) * 100
  }, [])

  const measureMedia = useCallback(() => {
    const root = rootRef.current
    const image = sourceRef.current
    if (!root || !image?.naturalWidth || !image.naturalHeight) return
    const width = root.clientWidth
    const height = root.clientHeight
    if (width === 0 || height === 0) return

    const scale = Math.min(
      width / image.naturalWidth,
      height / image.naturalHeight,
    )
    const mediaWidth = image.naturalWidth * scale
    const mediaHeight = image.naturalHeight * scale
    const bounds = {
      left: (width - mediaWidth) / 2,
      width: mediaWidth,
      top: (height - mediaHeight) / 2,
      height: mediaHeight,
    }
    mediaBoundsRef.current = bounds
    root.style.setProperty('--media-top', `${bounds.top}px`)
    root.style.setProperty('--media-height', `${bounds.height}px`)
    write(wipeRef.current)
  }, [write])

  useLayoutEffect(() => {
    const root = rootRef.current
    const image = sourceRef.current
    if (!root || !image) return
    measureMedia()
    image.addEventListener('load', measureMedia)
    const observer = new ResizeObserver(measureMedia)
    observer.observe(root)
    return () => {
      image.removeEventListener('load', measureMedia)
      observer.disconnect()
    }
  }, [measureMedia])

  // Peeking must be instant both ways: no clip-path tween while Space is
  // held, and none on release either. The attribute is cleared one frame
  // after the DOM has settled back to the wipe position.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    root.setAttribute('data-instant', 'true')
    if (peeking) return
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => root.removeAttribute('data-instant'))
    })
    return () => cancelAnimationFrame(frame)
  }, [peeking])

  // Arrow keys glide the line while held and nudge it on a tap.
  useEffect(() => {
    if (!active) return
    let direction = 0
    let shift = false
    let frame = 0
    let last = 0
    let travelled = 0

    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const speed = BASE_SPEED * (shift ? SHIFT_MULTIPLIER : 1)
      const delta = direction * speed * dt
      travelled += Math.abs(delta)
      write(wipeRef.current + delta)
      if (direction !== 0) frame = requestAnimationFrame(step)
    }

    const stop = () => {
      if (direction === 0) return
      cancelAnimationFrame(frame)
      // A quick tap should still visibly move the line.
      if (travelled < MIN_TAP_DISTANCE) {
        rootRef.current?.removeAttribute('data-dragging')
        write(wipeRef.current + direction * (MIN_TAP_DISTANCE - travelled))
      } else {
        rootRef.current?.removeAttribute('data-dragging')
      }
      direction = 0
      travelled = 0
      commit()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (
        target.isContentEditable ||
        ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(target.tagName) ||
        target.getAttribute('role') === 'button'
      ) {
        if (!rootRef.current?.contains(target)) return
      } else if (target !== document.body && !rootRef.current?.contains(target)) {
        return
      }
      event.preventDefault()
      shift = event.shiftKey
      if (event.repeat) return
      onRequestCompare()
      direction = event.key === 'ArrowLeft' ? -1 : 1
      travelled = 0
      last = performance.now()
      rootRef.current?.setAttribute('data-dragging', 'true')
      frame = requestAnimationFrame(step)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') shift = false
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') stop()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', stop)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', stop)
    }
  }, [active, write, commit, onRequestCompare])

  return (
    <div
      ref={rootRef}
      data-view={view}
      data-peek={peeking ? 'true' : undefined}
      className={cn(
        'compare relative aspect-[16/9] max-h-[560px] w-full touch-none select-none overflow-hidden bg-checker',
        className,
      )}
      style={{ '--wipe': 50 } as React.CSSProperties}
      onPointerDown={(event) => {
        if (view !== 'compare' || event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        // First contact animates to the pointer; movement after that is raw.
        write(positionFromPointer(event.clientX))
      }}
      onPointerMove={(event) => {
        if (view !== 'compare' || event.buttons !== 1) return
        if (!dragging) {
          setDragging(true)
          event.currentTarget.setAttribute('data-dragging', 'true')
        }
        write(positionFromPointer(event.clientX))
      }}
      onPointerUp={(event) => {
        event.currentTarget.removeAttribute('data-dragging')
        setDragging(false)
        commit()
      }}
      onPointerCancel={(event) => {
        event.currentTarget.removeAttribute('data-dragging')
        setDragging(false)
        commit()
      }}
    >
      <img
        src={resultUrl}
        alt="Background removed"
        draggable={false}
        className="absolute inset-0 size-full object-contain"
      />
      <img
        ref={sourceRef}
        src={sourceUrl}
        alt=""
        draggable={false}
        className="compare-source absolute inset-0 size-full object-contain"
      />
      <div
        aria-hidden="true"
        className="compare-line compare-fade absolute w-0.5 -translate-x-1/2 bg-wipe"
      />
      <div
        role="slider"
        tabIndex={view === 'compare' ? 0 : -1}
        aria-label="Compare original and result"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={announced}
        className="compare-handle compare-fade absolute top-1/2 flex size-9 cursor-ew-resize items-center justify-center gap-1 rounded-full border border-border bg-primary text-primary-foreground shadow-[0_2px_8px_rgba(0,0,0,0.5)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Chevron direction="left" />
        <Chevron direction="right" />
      </div>
      <span className="compare-fade absolute top-3 left-3 rounded bg-black/55 px-1.5 py-1 font-mono text-[10px] tracking-[0.08em] text-white">
        BEFORE
      </span>
      <span className="compare-fade absolute top-3 right-3 rounded bg-black/55 px-1.5 py-1 font-mono text-[10px] tracking-[0.08em] text-white">
        AFTER
      </span>
    </div>
  )
}

function Chevron({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg
      width="6"
      height="10"
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
