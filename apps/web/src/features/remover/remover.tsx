import {
  BackgroundRemovalError,
  type BackgroundRemovalErrorCode,
  type BackgroundRemovalResult,
  IMAGE_ACCEPT_ATTRIBUTE,
  isIosBrowser,
  type RemovalProgress,
  prepareBackgroundRemoval,
  removeBackground,
  SUPPORTED_IMAGE_FORMAT_LABEL,
  SUPPORTED_IMAGE_MIME_TYPES,
} from '@bg0/browser'
import {
  Camera,
  Check,
  ClipboardPaste,
  Copy,
  Download,
  FolderOpen,
  RotateCcw,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '#/components/ui/button'
import { Kbd } from '#/components/ui/kbd'
import { Tabs, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { Toast, type ToastMessage } from '#/components/ui/toast'
import {
  captureAppException,
  captureFeatureUsed,
  captureImageSelected,
  captureRemovalFailed,
  captureRemovalSucceeded,
  captureResultDownloaded,
} from '#/lib/analytics'
import { cn } from '#/lib/utils'
import { CompareSlider, type CompareView } from './compare-slider'

type State =
  | { status: 'idle' }
  | { status: 'processing'; sourceUrl: string; progress: RemovalProgress }
  | {
      status: 'result'
      sourceUrl: string
      resultUrl: string
      result: BackgroundRemovalResult
      name: string
    }
  | { status: 'error'; message: string; code: BackgroundRemovalErrorCode }

const CLIPBOARD_TIMEOUT_MS = 1500
type InputMethod = 'drop' | 'paste' | 'picker'
type RemoveBackground = typeof removeBackground
type WaitForPaint = () => Promise<void>

interface RemoverProps {
  removeBackgroundImpl?: RemoveBackground
  waitForPaintImpl?: WaitForPaint
}

export function warmBackgroundRemovalModel(
  userAgent = navigator.userAgent,
  prepare = prepareBackgroundRemoval,
  maxTouchPoints = navigator.maxTouchPoints,
): void {
  if (isIosBrowser(userAgent, maxTouchPoints)) return
  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string }
    }
  ).connection
  if (
    connection?.saveData ||
    connection?.effectiveType === '2g' ||
    connection?.effectiveType === 'slow-2g'
  ) {
    return
  }
  void prepare().catch(() => {
    // The normal processing path retries and presents a useful error if needed.
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('Clipboard timed out')),
      ms,
    )
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function waitForNextPaint(
  requestFrame: typeof requestAnimationFrame = requestAnimationFrame,
  scheduleTask: (callback: () => void) => number = (callback) =>
    window.setTimeout(callback, 0),
): Promise<void> {
  return new Promise((resolve) => {
    requestFrame(() => scheduleTask(resolve))
  })
}

function isModifier(event: KeyboardEvent) {
  return event.metaKey || event.ctrlKey
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
  )
}

function fileFromClipboard(data: DataTransfer | null): File | null {
  if (!data) return null
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) return file
    }
  }
  return null
}

function isFileTransfer(data: DataTransfer): boolean {
  if (
    data.files.length > 0 ||
    Array.from(data.items).some((item) => item.kind === 'file') ||
    data.types.includes('Files') ||
    data.types.includes('public.file-url')
  ) {
    return true
  }
  // String contents may be hidden until drop. Only claim a string-only transfer
  // when it exposes a local file URL; ordinary text and web links stay native.
  return [data.getData('text/uri-list'), data.getData('text/plain')].some(
    (value) => value.split(/\r?\n/).some((line) => /^file:/i.test(line.trim())),
  )
}

function fileFromDrop(data: DataTransfer): File | null {
  const file = data.files.item?.(0) ?? data.files[0]
  if (file) return file
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) return file
  }
  return null
}

function clipboardImagesSupported() {
  return (
    typeof navigator !== 'undefined' &&
    window.isSecureContext &&
    typeof ClipboardItem !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function'
  )
}

export function Remover({
  removeBackgroundImpl = removeBackground,
  waitForPaintImpl = waitForNextPaint,
}: RemoverProps = {}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)
  const abortController = useRef<AbortController | null>(null)
  const latestState = useRef<State>({ status: 'idle' })
  const mounted = useRef(true)
  const toastId = useRef(0)
  const lastFile = useRef<{ file: File; inputMethod: InputMethod } | null>(null)
  const [state, setState] = useState<State>({ status: 'idle' })
  const [view, setView] = useState<CompareView>('compare')
  const [peeking, setPeeking] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [copied, setCopied] = useState(false)
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [showIosExportNotice, setShowIosExportNotice] = useState(false)
  const [mobile, setMobile] = useState(false)
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string>()
  const pickerRef = useRef<HTMLDivElement>(null)
  const [pickerOffscreen, setPickerOffscreen] = useState(false)

  useEffect(() => {
    setShowIosExportNotice(
      isIosBrowser(navigator.userAgent, navigator.maxTouchPoints),
    )
    setMobile(isIosBrowser(navigator.userAgent, navigator.maxTouchPoints))
  }, [])

  useEffect(() => {
    latestState.current = state
  }, [state])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      abortController.current?.abort()
      cleanupUrls(latestState.current)
    }
  }, [])

  const commitState = useCallback((next: State) => {
    latestState.current = next
    setState(next)
  }, [])

  const notify = useCallback((text: string, tone?: ToastMessage['tone']) => {
    toastId.current += 1
    setToast({ id: toastId.current, text, tone })
    setAnnouncement(text)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToast((current) => (current?.id === id ? null : current))
  }, [])

  const process = useCallback(
    async (file: File, inputMethod: InputMethod, emitAnalytics = true) => {
      if (emitAnalytics) captureImageSelected(inputMethod)

      abortController.current?.abort()
      cleanupUrls(latestState.current)
      const sourceUrl = URL.createObjectURL(file)
      const controller = new AbortController()
      abortController.current = controller
      setView('compare')
      setAnnouncement('Removing background on this device.')
      commitState({
        status: 'processing',
        sourceUrl,
        progress: { stage: 'preparing', progress: 0, message: 'Preparing…' },
      })

      try {
        // Give the browser a frame to paint the source before inference can
        // occupy the main thread.
        await waitForPaintImpl()
        if (
          controller.signal.aborted ||
          abortController.current !== controller ||
          !mounted.current
        ) {
          return
        }

        const result = await removeBackgroundImpl(file, {
          quality: 'quality',
          signal: controller.signal,
          onProgress: (progress) => {
            if (
              controller.signal.aborted ||
              abortController.current !== controller ||
              !mounted.current
            ) {
              return
            }
            setState((current) => {
              if (current.status !== 'processing') return current
              const next = { ...current, progress }
              latestState.current = next
              return next
            })
          },
        })
        if (
          controller.signal.aborted ||
          abortController.current !== controller ||
          !mounted.current
        ) {
          return
        }

        let resultUrl: string | undefined
        let previewSourceUrl: string | undefined
        try {
          resultUrl = URL.createObjectURL(result.blob)
          previewSourceUrl = result.sourceBlob
            ? URL.createObjectURL(result.sourceBlob)
            : sourceUrl
        } catch (error) {
          if (resultUrl) URL.revokeObjectURL(resultUrl)
          throw error
        }
        if (previewSourceUrl !== sourceUrl) URL.revokeObjectURL(sourceUrl)
        commitState({
          status: 'result',
          sourceUrl: previewSourceUrl,
          resultUrl,
          result,
          name: file.name.replace(/\.[^.]+$/, '') || 'image',
        })
        setAnnouncement(
          `Background removed in ${(result.durationMs / 1000).toFixed(1)} seconds.`,
        )
        captureRemovalSucceeded(inputMethod, result.provider)
        lastFile.current = null
      } catch (error) {
        if (
          controller.signal.aborted ||
          abortController.current !== controller ||
          !mounted.current
        ) {
          return
        }
        URL.revokeObjectURL(sourceUrl)
        const code =
          error instanceof BackgroundRemovalError
            ? error.code
            : 'inference-failed'
        const message =
          error instanceof BackgroundRemovalError
            ? error.message
            : 'Local processing could not finish. Try again.'
        commitState({ status: 'error', message, code })
        setAnnouncement(message)
        captureRemovalFailed(inputMethod, code)
        if (
          code === 'model-load-failed' ||
          code === 'out-of-memory' ||
          code === 'inference-failed'
        ) {
          captureAppException(error, {
            area: 'background_removal',
            reason: code,
          })
        }
      }
    },
    [commitState, removeBackgroundImpl, waitForPaintImpl],
  )

  const selectFiles = useCallback(
    (files: FileList | null, inputMethod: InputMethod) => {
      const file = files?.item?.(0) ?? files?.[0]
      if (file) {
        lastFile.current = { file, inputMethod }
        void process(file, inputMethod)
      }
    },
    [process],
  )

  const reset = useCallback(() => {
    abortController.current?.abort()
    cleanupUrls(latestState.current)
    lastFile.current = null
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (photoInputRef.current) photoInputRef.current.value = ''
    abortController.current = null
    commitState({ status: 'idle' })
    setAnnouncement('Ready for the next image.')
    captureFeatureUsed('start_another_image')
  }, [commitState])

  const openFilePicker = useCallback(() => fileInputRef.current?.click(), [])
  const openPhotoPicker = useCallback(() => photoInputRef.current?.click(), [])

  const download = useCallback(() => {
    const current = latestState.current
    if (current.status !== 'result') return
    const link = document.createElement('a')
    link.href = current.resultUrl
    link.download = `${current.name}-bg0.png`
    link.click()
    notify('PNG downloaded')
    captureResultDownloaded(current.result.provider)
  }, [notify])

  const copyResult = useCallback(async () => {
    const current = latestState.current
    if (current.status !== 'result') return
    if (!clipboardImagesSupported()) {
      notify(
        window.isSecureContext
          ? 'This browser cannot copy images. Download instead.'
          : 'Copying needs an https page. Download instead.',
        'error',
      )
      return
    }
    try {
      const png = new Blob([current.result.blob], { type: 'image/png' })
      await withTimeout(
        navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]),
        CLIPBOARD_TIMEOUT_MS,
      )
      setCopied(true)
      notify('PNG copied to the clipboard')
      captureFeatureUsed('copy_result')
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      notify('Clipboard blocked by the browser. Download instead.', 'error')
    }
  }, [notify])

  const pasteFromClipboard = useCallback(async () => {
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const type = item.types.find((candidate) =>
          SUPPORTED_IMAGE_MIME_TYPES.includes(
            candidate as (typeof SUPPORTED_IMAGE_MIME_TYPES)[number],
          ),
        )
        if (type) {
          const blob = await item.getType(type)
          const file = new File([blob], 'clipboard.png', { type })
          lastFile.current = { file, inputMethod: 'paste' }
          void process(file, 'paste')
          return
        }
      }
      notify('No image on the clipboard', 'error')
    } catch {
      notify('Paste is unavailable here. Choose a photo instead.', 'error')
    }
  }, [process, notify])

  // Drop anywhere on the page.
  useEffect(() => {
    let depth = 0
    const onEnter = (event: DragEvent) => {
      if (!event.dataTransfer || !isFileTransfer(event.dataTransfer)) return
      event.preventDefault()
      depth += 1
      setIsDragging(true)
    }
    const onOver = (event: DragEvent) => {
      const data = event.dataTransfer
      if (!data) return
      const fileTransfer = isFileTransfer(data)
      // Protected strings are unreadable until drop. Admit potential file URLs
      // without showing the image overlay or consuming an ordinary text/link
      // drop. Editable controls already accept text with their native behavior.
      const protectedString =
        !isEditableTarget(event.target) &&
        (data.types.includes('text/uri-list') ||
          data.types.includes('text/plain'))
      if (!fileTransfer && !protectedString) return
      event.preventDefault()
      if (fileTransfer) data.dropEffect = 'copy'
    }
    const onLeave = () => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setIsDragging(false)
    }
    const onDrop = (event: DragEvent) => {
      depth = 0
      setIsDragging(false)
      const data = event.dataTransfer
      if (!data) return
      const fileTransfer = isFileTransfer(data)
      const protectedString =
        !isEditableTarget(event.target) &&
        (data.types.includes('text/uri-list') ||
          data.types.includes('text/plain'))
      const unreadableProtectedString =
        protectedString &&
        [data.getData('text/uri-list'), data.getData('text/plain')].every(
          (value) => value.length === 0,
        )
      if (!fileTransfer && !unreadableProtectedString) return
      // Photos can expose a file URL without granting access to the file.
      // Cancel navigation even when there is no readable file in the drop.
      event.preventDefault()
      const file = fileFromDrop(data)
      if (file) {
        lastFile.current = { file, inputMethod: 'drop' }
        void process(file, 'drop')
      } else {
        notify(
          'That drop did not include a readable file. Export the photo from Photos, then choose or drop the exported file.',
          'error',
        )
      }
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [process, notify])

  // Paste anywhere on the page.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isEditableTarget(event.target)) return
      const file = fileFromClipboard(event.clipboardData)
      if (!file) return
      event.preventDefault()
      lastFile.current = { file, inputMethod: 'paste' }
      void process(file, 'paste')
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [process])

  // Keyboard flow. Arrow keys live inside CompareSlider.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      const current = latestState.current
      const key = event.key.toLowerCase()

      if (isModifier(event) && key === 'o') {
        event.preventDefault()
        openFilePicker()
        return
      }
      if (key === 'escape' && current.status !== 'idle') {
        event.preventDefault()
        reset()
        return
      }
      if (current.status !== 'result') return

      if (isModifier(event) && key === 's') {
        event.preventDefault()
        download()
      } else if (
        isModifier(event) &&
        key === 'c' &&
        !window.getSelection()?.toString()
      ) {
        event.preventDefault()
        void copyResult()
      } else if (event.key === ' ' && !event.repeat) {
        event.preventDefault()
        setPeeking(true)
      } else if (key === '1' || key === '2' || key === '3') {
        const nextView =
          key === '1' ? 'compare' : key === '2' ? 'result' : 'original'
        setView(nextView)
        captureFeatureUsed(`view_${nextView}`)
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ') setPeeking(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [openFilePicker, reset, download, copyResult])

  const requestCompare = useCallback(() => {
    setView('compare')
    captureFeatureUsed('compare_slider')
  }, [])

  // Sticky CTA on phones once the picker has scrolled away.
  useEffect(() => {
    const picker = pickerRef.current
    if (!picker || state.status !== 'idle') {
      setPickerOffscreen(false)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => setPickerOffscreen(!entry.isIntersecting),
      { threshold: 0 },
    )
    observer.observe(picker)
    return () => observer.disconnect()
  }, [state.status])

  const retry = useCallback(() => {
    if (lastFile.current)
      void process(lastFile.current.file, lastFile.current.inputMethod, false)
  }, [process])

  return (
    <section
      aria-label="Background remover"
      className="mx-auto w-full max-w-[960px]"
    >
      <div
        className={cn(
          'relative overflow-hidden rounded-2xl border border-border bg-card shadow-elevated transition-[border-color,box-shadow] duration-(--duration-quick) ease-(--ease-out)',
          isDragging && 'border-wipe ring-1 ring-wipe',
        )}
      >
        {state.status === 'idle' && (
          <div className="t-stage relative flex min-h-[220px] flex-col items-center justify-center gap-4 p-6 sm:min-h-[400px]">
            <div
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute inset-3 rounded-[10px] border border-dashed border-input transition-colors duration-(--duration-quick) ease-(--ease-out)',
                isDragging && 'border-wipe',
              )}
            />
            <p className="hidden text-base font-medium sm:block">
              {isDragging
                ? 'Release to remove the background'
                : 'Drop an image anywhere on this page'}
            </p>
            <Button
              type="button"
              size="lg"
              onClick={openFilePicker}
              className="hidden sm:inline-flex"
            >
              Choose image
              <Kbd variant="onPrimary" className="hidden sm:inline-flex">
                ⌘O
              </Kbd>
            </Button>
            <div className="hidden items-center gap-3 text-[13px] text-muted-foreground sm:flex">
              <span className="inline-flex items-center gap-1.5">
                or paste <Kbd>⌘V</Kbd>
              </span>
              <span className="text-input">·</span>
              <span>{SUPPORTED_IMAGE_FORMAT_LABEL}</span>
            </div>
            <div
              ref={pickerRef}
              className="flex w-full max-w-[320px] flex-col gap-2.5 sm:hidden"
            >
              <Button
                type="button"
                size="xl"
                className="w-full"
                onClick={openPhotoPicker}
              >
                <Camera aria-hidden="true" /> Choose a photo
              </Button>
              <div className="grid grid-cols-2 gap-2.5">
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  className="h-11"
                  onClick={() => void pasteFromClipboard()}
                >
                  <ClipboardPaste aria-hidden="true" /> Paste
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  className="h-11"
                  onClick={openFilePicker}
                >
                  <FolderOpen aria-hidden="true" /> Files
                </Button>
              </div>
              <p className="text-center text-xs text-faint-foreground">
                {SUPPORTED_IMAGE_FORMAT_LABEL} · free, no account
              </p>
            </div>
            {showIosExportNotice && (
              <p className="relative z-10 flex max-w-[460px] items-start justify-center gap-1.5 text-center text-[11px] leading-4 text-muted-foreground">
                <TriangleAlert
                  aria-hidden="true"
                  className="mt-0.5 size-3.5 shrink-0"
                />
                <span>
                  iPhone and iPad use a lower-memory model with exports up to
                  1280px. Photos stay on your device. Larger images may still
                  need more memory than Safari allows.
                </span>
              </p>
            )}
          </div>
        )}

        {state.status === 'processing' && (
          <div
            aria-busy="true"
            className="t-stage relative flex min-h-[220px] items-center justify-center bg-checker sm:min-h-[400px]"
          >
            {/* A source the browser cannot decode (HEIC on Chromium) fires
                error; drop the preview instead of showing alt text. */}
            {!mobile && state.sourceUrl !== failedPreviewUrl && (
              <img
                key={state.sourceUrl}
                src={state.sourceUrl}
                alt="Original being processed"
                draggable={false}
                onError={() => setFailedPreviewUrl(state.sourceUrl)}
                className="absolute inset-0 size-full object-contain"
              />
            )}
            <div className="absolute inset-x-0 top-0 h-0.5 bg-border-subtle">
              <div
                className="h-full bg-wipe transition-[width] duration-(--duration-medium) ease-(--ease-smooth-out)"
                style={{
                  width: `${Math.max(4, Math.round(state.progress.progress * 100))}%`,
                }}
              />
            </div>
            <div className="absolute inset-x-0 bottom-4 flex justify-center">
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-background/85 px-3.5 py-1.5 font-mono text-[11px] tracking-wide backdrop-blur-sm">
                <span
                  className="t-shimmer"
                  data-text={progressLabel(state.progress)}
                >
                  {progressLabel(state.progress)}
                </span>
              </span>
            </div>
          </div>
        )}

        {state.status === 'result' && (
          <div className="t-stage flex flex-col">
            <div className="flex h-11 items-center justify-between border-b border-border px-3">
              <Tabs
                value={view}
                onValueChange={(value) => {
                  const nextView = value as CompareView
                  setView(nextView)
                  captureFeatureUsed(`view_${nextView}`)
                }}
              >
                <TabsList aria-label="View">
                  <TabsTrigger value="compare">Compare</TabsTrigger>
                  <TabsTrigger value="result">Result</TabsTrigger>
                  <TabsTrigger value="original">Original</TabsTrigger>
                </TabsList>
              </Tabs>
              <span className="hidden items-center gap-2 font-mono text-[11px] tracking-wide text-muted-foreground sm:inline-flex">
                <span className="size-1.5 rounded-full bg-success" />
                {state.result.provider === 'webgpu' ? 'WEBGPU' : 'WASM'} ·{' '}
                {(state.result.durationMs / 1000).toFixed(1)}s ·{' '}
                {state.result.width}×{state.result.height}
              </span>
            </div>

            <CompareSlider
              sourceUrl={state.sourceUrl}
              resultUrl={state.resultUrl}
              view={view}
              peeking={peeking}
              active
              onRequestCompare={requestCompare}
            />

            <div className="flex flex-col gap-3 border-t border-border p-3 sm:h-[60px] sm:flex-row sm:items-center sm:justify-between sm:px-4 sm:py-0">
              <div className="hidden items-center gap-3 text-[13px] text-muted-foreground lg:flex">
                <span className="inline-flex items-center gap-1.5">
                  Hold <Kbd>Space</Kbd> to peek
                </span>
                <span className="text-input">·</span>
                <span className="inline-flex items-center gap-1.5">
                  <Kbd>←</Kbd>
                  <Kbd>→</Kbd> slide
                </span>
                <span className="text-input">·</span>
                <span className="inline-flex items-center gap-1.5">
                  <Kbd>Esc</Kbd> next image
                </span>
              </div>
              <div className="flex flex-wrap gap-2 sm:ml-auto sm:flex-nowrap">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={reset}
                  aria-label="Start over with another image"
                  className="sm:hidden"
                >
                  <RotateCcw aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => void copyResult()}
                  data-testid="copy-result"
                  className="flex-1 sm:flex-none"
                >
                  <span
                    className="t-icon-swap size-4"
                    data-state={copied ? 'b' : 'a'}
                  >
                    <Copy aria-hidden="true" className="t-icon" data-icon="a" />
                    <Check
                      aria-hidden="true"
                      className="t-icon text-success"
                      data-icon="b"
                    />
                  </span>
                  {copied ? 'Copied' : 'Copy'}
                  <Kbd className="hidden sm:inline-flex">⌘C</Kbd>
                </Button>
                <Button
                  type="button"
                  onClick={download}
                  data-testid="download-result"
                  className="flex-1 sm:flex-none"
                >
                  <Download aria-hidden="true" />
                  Download PNG
                  <span className="hidden font-mono text-[11px] opacity-60 sm:inline">
                    {formatBytes(state.result.blob.size)}
                  </span>
                </Button>
              </div>
            </div>
          </div>
        )}

        {state.status === 'error' && (
          <div className="t-stage flex min-h-[220px] flex-col items-center justify-center gap-4 p-8 text-center sm:min-h-[400px]">
            <span className="grid size-11 place-items-center rounded-xl bg-destructive/12 text-destructive">
              <X aria-hidden="true" className="size-5" />
            </span>
            <div>
              <h2 className="text-base font-semibold">
                That image could not be processed
              </h2>
              <p className="mt-1.5 max-w-sm text-[13px] leading-5 text-muted-foreground">
                {state.message}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {isRetryableError(state.code) && (
                <Button type="button" variant="secondary" onClick={retry}>
                  Try again
                </Button>
              )}
              <Button type="button" variant="secondary" onClick={reset}>
                Choose another image
              </Button>
            </div>
          </div>
        )}
      </div>

      <input
        ref={photoInputRef}
        type="file"
        accept={IMAGE_ACCEPT_ATTRIBUTE}
        className="sr-only"
        onChange={(event) => {
          selectFiles(event.target.files, 'picker')
          event.target.value = ''
        }}
        aria-label="Choose a photo"
      />
      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_ACCEPT_ATTRIBUTE}
        className="sr-only"
        onChange={(event) => {
          selectFiles(event.target.files, 'picker')
          event.target.value = ''
        }}
        aria-label="Choose an image file to remove its background"
      />
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <Toast
        message={toast}
        onDone={dismissToast}
        durationMs={toast?.tone === 'error' ? 6000 : 2200}
      />
      <div
        aria-hidden={!pickerOffscreen}
        className={cn(
          't-toast pointer-events-none fixed inset-x-0 bottom-0 z-40 px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:hidden',
          pickerOffscreen && 'is-open pointer-events-auto',
        )}
      >
        <Button
          type="button"
          size="xl"
          className="w-full shadow-[0_12px_32px_rgba(0,0,0,0.6)]"
          onClick={openPhotoPicker}
          tabIndex={pickerOffscreen ? 0 : -1}
        >
          <Camera aria-hidden="true" /> Choose a photo
        </Button>
      </div>
    </section>
  )
}

function progressLabel(progress: RemovalProgress) {
  if (progress.stage === 'downloading') {
    return `${progress.message} · cached after this`
  }
  return progress.message
}

function isRetryableError(code: BackgroundRemovalErrorCode): boolean {
  return code !== 'unsupported-image' && code !== 'image-too-large'
}

function cleanupUrls(state: State) {
  if (state.status === 'processing' || state.status === 'result')
    URL.revokeObjectURL(state.sourceUrl)
  if (state.status === 'result') URL.revokeObjectURL(state.resultUrl)
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
