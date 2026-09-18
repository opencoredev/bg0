import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import {
  BackgroundRemovalError,
  type BackgroundRemovalResult,
  type RemoveBackgroundOptions,
} from '@bg0/browser'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from '@testing-library/react'

import {
  Remover,
  waitForNextPaint,
  warmBackgroundRemovalModel,
} from './remover'

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register()
}

class IntersectionObserverStub {
  observe() {}
  disconnect() {}
}

globalThis.IntersectionObserver =
  IntersectionObserverStub as unknown as typeof IntersectionObserver

afterEach(cleanup)
afterAll(() => {
  if (GlobalRegistrator.isRegistered) {
    void GlobalRegistrator.unregister()
  }
})

const IPHONE_SAFARI_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1'

const MAC_SAFARI_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/27.0 Safari/605.1.15'

describe('iOS export notice', () => {
  test('does not warm the model on iPhone', () => {
    const prepare = mock(() => Promise.resolve('wasm' as const))

    warmBackgroundRemovalModel(IPHONE_SAFARI_USER_AGENT, prepare)
    expect(prepare).not.toHaveBeenCalled()

    warmBackgroundRemovalModel(MAC_SAFARI_USER_AGENT, prepare)
    expect(prepare).toHaveBeenCalledTimes(1)
  })

  test('warms Android normally but not desktop-mode iPad', () => {
    const prepare = mock(() => Promise.resolve('wasm' as const))
    warmBackgroundRemovalModel('Android Chrome/150.0 Mobile', prepare, 5)
    expect(prepare).toHaveBeenCalledTimes(1)
    prepare.mockClear()
    warmBackgroundRemovalModel(MAC_SAFARI_USER_AGENT, prepare, 5)
    expect(prepare).not.toHaveBeenCalled()
  })

  test('does not warm the model when saveData or slow connection is active', () => {
    const prepare = mock(() => Promise.resolve('wasm' as const))
    const originalConnection = (navigator as Navigator & { connection?: unknown }).connection

    try {
      Object.defineProperty(navigator, 'connection', {
        configurable: true,
        value: { saveData: true },
      })
      warmBackgroundRemovalModel(MAC_SAFARI_USER_AGENT, prepare)
      expect(prepare).not.toHaveBeenCalled()

      Object.defineProperty(navigator, 'connection', {
        configurable: true,
        value: { saveData: false, effectiveType: '2g' },
      })
      warmBackgroundRemovalModel(MAC_SAFARI_USER_AGENT, prepare)
      expect(prepare).not.toHaveBeenCalled()

      Object.defineProperty(navigator, 'connection', {
        configurable: true,
        value: { saveData: false, effectiveType: '4g' },
      })
      warmBackgroundRemovalModel(MAC_SAFARI_USER_AGENT, prepare)
      expect(prepare).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(navigator, 'connection', {
        configurable: true,
        value: originalConnection,
      })
    }
  })

  test('does not decode a full-resolution processing preview on phones', async () => {
    const originalUserAgent = navigator.userAgent
    const urls = trackObjectUrls()
    try {
      for (const userAgent of [IPHONE_SAFARI_USER_AGENT, 'iPad Safari/605.1']) {
        Object.defineProperty(navigator, 'userAgent', {
          configurable: true,
          value: userAgent,
        })
        const request = deferred<BackgroundRemovalResult>()
        const view = render(
          <Remover
            removeBackgroundImpl={() => request.promise}
            waitForPaintImpl={() => Promise.resolve()}
          />,
        )
        selectFile(
          view,
          new File(['image'], 'photo.png', { type: 'image/png' }),
        )
        expect(view.getByText('Preparing…')).toBeTruthy()
        expect(
          view.queryByRole('img', { name: 'Original being processed' }),
        ).toBeNull()
        view.unmount()
      }
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: originalUserAgent,
      })
      urls.restore()
    }
  })

  test.each([
    ['iPhone', IPHONE_SAFARI_USER_AGENT, 5, true],
    [
      'iPad',
      'Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
      5,
      true,
    ],
    ['desktop-mode iPad', MAC_SAFARI_USER_AGENT, 5, true],
    ['Mac', MAC_SAFARI_USER_AGENT, 0, false],
    [
      'Android',
      'Mozilla/5.0 (Linux; Android 15) Chrome/150.0 Mobile',
      5,
      false,
    ],
  ] as const)(
    'discloses the export cap correctly on %s',
    async (_name, userAgent, maxTouchPoints, expected) => {
      const originalUserAgent = Object.getOwnPropertyDescriptor(
        navigator,
        'userAgent',
      )
      const originalTouchPoints = Object.getOwnPropertyDescriptor(
        navigator,
        'maxTouchPoints',
      )
      try {
        Object.defineProperty(navigator, 'userAgent', {
          configurable: true,
          value: userAgent,
        })
        Object.defineProperty(navigator, 'maxTouchPoints', {
          configurable: true,
          value: maxTouchPoints,
        })
        const view = render(<Remover />)
        await waitFor(() => {
          expect(Boolean(view.queryByText(/exports up to 1280px/))).toBe(
            expected,
          )
        })
        view.unmount()
      } finally {
        if (originalUserAgent)
          Object.defineProperty(navigator, 'userAgent', originalUserAgent)
        else Reflect.deleteProperty(navigator, 'userAgent')
        if (originalTouchPoints)
          Object.defineProperty(
            navigator,
            'maxTouchPoints',
            originalTouchPoints,
          )
        else Reflect.deleteProperty(navigator, 'maxTouchPoints')
      }
    },
  )
})

describe('Remover image pickers', () => {
  test('waits for an animation frame and a following task', async () => {
    let frame: FrameRequestCallback | undefined
    let task: (() => void) | undefined
    let settled = false
    const paint = waitForNextPaint(
      (callback) => {
        frame = callback
        return 1
      },
      (callback) => {
        task = callback
        return 1
      },
    ).then(() => {
      settled = true
    })

    expect(frame).toBeDefined()
    expect(task).toBeUndefined()
    expect(settled).toBe(false)

    frame?.(0)
    expect(task).toBeDefined()
    expect(settled).toBe(false)

    task?.()
    await paint
    expect(settled).toBe(true)
  })

  test('paints a pasted image before background removal starts', async () => {
    const urls = trackObjectUrls()
    const request = deferred<BackgroundRemovalResult>()
    const paint = deferred<void>()
    const remove = mock(
      (_input: Blob, _options?: RemoveBackgroundOptions) => request.promise,
    )
    const view = render(
      <Remover
        removeBackgroundImpl={remove}
        waitForPaintImpl={() => paint.promise}
      />,
    )

    try {
      const transfer = new DataTransfer()
      transfer.items.add(
        new File(['image'], 'clipboard.png', { type: 'image/png' }),
      )

      fireEvent.paste(window, { clipboardData: transfer })

      const preview = view.getByRole('img', {
        name: 'Original being processed',
      })
      expect(preview.getAttribute('src')).toBe('blob:test-1')
      expect(view.getByText('Preparing…')).toBeTruthy()
      expect(remove).not.toHaveBeenCalled()
      await act(async () => paint.resolve())
      expect(remove).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
      urls.restore()
    }
  })

  test('keeps photo and file picker actions distinct across entry points', () => {
    const view = render(<Remover />)
    const photoInput = view.getByLabelText('Choose a photo')
    const fileInput = view.getByLabelText(
      'Choose an image file to remove its background',
    )
    const photoClick = mock(() => {})
    const fileClick = mock(() => {})

    photoInput.click = photoClick
    fileInput.click = fileClick

    const photoButtons = Array.from(
      view.container.querySelectorAll('button'),
    ).filter((button) => button.textContent?.trim() === 'Choose a photo')

    expect(photoButtons).toHaveLength(2)
    for (const button of photoButtons) {
      fireEvent.click(button)
    }
    expect(photoClick).toHaveBeenCalledTimes(2)
    expect(fileClick).not.toHaveBeenCalled()
    expect(photoInput.getAttribute('accept')).toBe(
      'image/png,image/jpeg,image/webp,image/heic,image/heif,image/x-heic,image/x-heif,.heic,.heif,.hif',
    )

    fireEvent.click(view.getByRole('button', { name: 'Files' }))
    fireEvent.click(view.getByRole('button', { name: /Choose image/ }))
    fireEvent.keyDown(window, { ctrlKey: true, key: 'o' })
    fireEvent.keyDown(window, { metaKey: true, key: 'o' })

    expect(fileClick).toHaveBeenCalledTimes(4)
    expect(photoClick).toHaveBeenCalledTimes(2)
    expect(fileInput.getAttribute('accept')).toBe(
      'image/png,image/jpeg,image/webp,image/heic,image/heif,image/x-heic,image/x-heif,.heic,.heif,.hif',
    )
  })

  test('clears file input value on selection to allow picking the same file again', () => {
    const view = render(<Remover />)
    const fileInput = view.getByLabelText(
      'Choose an image file to remove its background',
    ) as HTMLInputElement
    const photoInput = view.getByLabelText('Choose a photo') as HTMLInputElement

    selectFile(view, new File(['test'], 'image.png', { type: 'image/png' }))
    expect(fileInput.value).toBe('')

    const transfer = new DataTransfer()
    transfer.items.add(new File(['test'], 'photo.png', { type: 'image/png' }))
    fireEvent.change(photoInput, { target: { files: transfer.files } })
    expect(photoInput.value).toBe('')
  })

  test('does not install a result that resolves after reset', async () => {
    const urls = trackObjectUrls()
    const request = deferred<BackgroundRemovalResult>()
    const remove = mock(
      (_input: Blob, _options?: RemoveBackgroundOptions) => request.promise,
    )

    try {
      const view = render(<Remover removeBackgroundImpl={remove} />)
      selectFile(view, new File(['heic'], 'photo.heic', { type: 'image/heic' }))
      fireEvent.keyDown(window, { key: 'Escape' })

      expect(urls.revoked).toEqual(['blob:test-1'])
      await act(async () => request.resolve(resultWithSource()))

      expect(view.getByText('Drop an image anywhere on this page')).toBeTruthy()
      expect(urls.created).toHaveLength(1)
      expect(urls.revoked).toEqual(['blob:test-1'])
    } finally {
      urls.restore()
    }
  })

  test('keeps replacement results isolated and revokes every owned URL', async () => {
    const urls = trackObjectUrls()
    const first = deferred<BackgroundRemovalResult>()
    const second = deferred<BackgroundRemovalResult>()
    const requests = [first, second]
    const remove = mock(
      (_input: Blob, _options?: RemoveBackgroundOptions) =>
        requests.shift()?.promise ??
        Promise.reject(new Error('unexpected call')),
    )

    try {
      const view = render(
        <Remover
          removeBackgroundImpl={remove}
          waitForPaintImpl={() => Promise.resolve()}
        />,
      )
      selectFile(view, new File(['one'], 'one.heic', { type: 'image/heic' }))
      await act(async () => {
        await Promise.resolve()
      })
      selectFile(view, new File(['two'], 'two.heic', { type: 'image/heic' }))
      await act(async () => {
        await Promise.resolve()
      })

      expect(urls.revoked).toEqual(['blob:test-1'])
      await act(async () => first.resolve(resultWithSource()))
      expect(urls.created).toHaveLength(2)

      await act(async () => second.resolve(resultWithSource()))
      await waitFor(() => {
        expect(view.getByText(/Background removed in/)).toBeTruthy()
      })
      expect(urls.created).toHaveLength(4)
      expect(urls.revoked).toEqual(['blob:test-1', 'blob:test-2'])

      view.unmount()
      expect(urls.revoked).toEqual([
        'blob:test-1',
        'blob:test-2',
        'blob:test-4',
        'blob:test-3',
      ])
    } finally {
      urls.restore()
    }
  })

  test('revokes the pending source and ignores completion after unmount', async () => {
    const urls = trackObjectUrls()
    const request = deferred<BackgroundRemovalResult>()
    const remove = mock(
      (_input: Blob, _options?: RemoveBackgroundOptions) => request.promise,
    )

    try {
      const view = render(<Remover removeBackgroundImpl={remove} />)
      selectFile(view, new File(['heic'], 'photo.heic', { type: 'image/heic' }))
      view.unmount()

      expect(urls.revoked).toEqual(['blob:test-1'])
      await act(async () => request.resolve(resultWithSource()))
      expect(urls.created).toHaveLength(1)
      expect(urls.revoked).toEqual(['blob:test-1'])
    } finally {
      urls.restore()
    }
  })
})

describe('Remover image drops', () => {
  test.each([
    ['text/plain', 'ordinary selected text'],
    ['text/uri-list', 'https://example.com/'],
  ])('leaves ordinary %s drops to the browser', (type, value) => {
    const remove = mock(() => Promise.resolve(resultWithSource()))
    const view = render(<Remover removeBackgroundImpl={remove} />)
    const transfer = new DataTransfer()
    transfer.setData(type, value)

    expect(fireEvent.dragEnter(window, { dataTransfer: transfer })).toBe(true)
    // Admit the drop to inspect its protected contents, but leave the actual
    // drop uncancelled and do not show image feedback for ordinary strings.
    expect(fireEvent.dragOver(window, { dataTransfer: transfer })).toBe(false)
    expect(fireEvent.drop(window, { dataTransfer: transfer })).toBe(true)
    expect(view.getByText('Drop an image anywhere on this page')).toBeTruthy()
    expect(view.queryByText(/Export the photo from Photos/)).toBeNull()
    expect(remove).not.toHaveBeenCalled()
  })

  test('preserves native text dragging into editable controls', () => {
    const view = render(
      <>
        <Remover />
        <textarea aria-label="Text drop target" />
      </>,
    )
    const transfer = new DataTransfer()
    transfer.setData('text/plain', 'ordinary selected text')
    const input = view.getByRole('textbox', { name: 'Text drop target' })

    expect(fireEvent.dragOver(input, { dataTransfer: transfer })).toBe(true)
    expect(fireEvent.drop(input, { dataTransfer: transfer })).toBe(true)
    expect(view.queryByText(/Export the photo from Photos/)).toBeNull()
  })

  test.each(['text/uri-list', 'text/plain'])(
    'accepts a protected %s transfer before its local file URL becomes readable',
    async (type) => {
      const remove = mock(() => Promise.resolve(resultWithSource()))
      const view = render(<Remover removeBackgroundImpl={remove} />)
      const transfer = new DataTransfer()
      transfer.setData(type, 'file:///Photos%20Library/fixture.jpeg')
      const getData = mock(() => '')
      Object.defineProperty(transfer, 'getData', { value: getData })

      expect(fireEvent.dragEnter(window, { dataTransfer: transfer })).toBe(true)
      expect(fireEvent.dragOver(window, { dataTransfer: transfer })).toBe(false)
      expect(view.getByText('Drop an image anywhere on this page')).toBeTruthy()
      getData.mockReturnValue('file:///Photos%20Library/fixture.jpeg')
      expect(fireEvent.drop(window, { dataTransfer: transfer })).toBe(false)

      await waitFor(() => {
        expect(
          view.getAllByText(/Export the photo from Photos/).length,
        ).toBeGreaterThan(0)
      })
      expect(remove).not.toHaveBeenCalled()
    },
  )

  test.each(['text/uri-list', 'text/plain'])(
    'prevents navigation for a Photos file link exposed as %s',
    async (type) => {
      const remove = mock(() => Promise.resolve(resultWithSource()))
      const view = render(<Remover removeBackgroundImpl={remove} />)
      const transfer = new DataTransfer()
      transfer.setData(type, 'file:///Photos%20Library/fixture.jpeg')

      expect(fireEvent.dragEnter(window, { dataTransfer: transfer })).toBe(
        false,
      )
      expect(fireEvent.dragOver(window, { dataTransfer: transfer })).toBe(false)
      expect(fireEvent.drop(window, { dataTransfer: transfer })).toBe(false)

      await waitFor(() => {
        expect(
          view.getAllByText(/Export the photo from Photos/).length,
        ).toBeGreaterThan(0)
      })
      expect(view.getByText('Drop an image anywhere on this page')).toBeTruthy()
      expect(remove).not.toHaveBeenCalled()
      expect(view.container.textContent).not.toContain('file:///')
    },
  )

  test('prevents navigation when a file drop provides no accessible file', async () => {
    const remove = mock(() => Promise.resolve(resultWithSource()))
    const view = render(<Remover removeBackgroundImpl={remove} />)
    const transfer = {
      types: ['Files'],
      files: { length: 0, item: () => null },
      items: [{ kind: 'file', getAsFile: () => null }],
    }

    fireEvent.dragEnter(window, { dataTransfer: transfer })
    expect(fireEvent.drop(window, { dataTransfer: transfer })).toBe(false)

    await waitFor(() => {
      expect(
        view.getAllByText(/Export the photo from Photos/).length,
      ).toBeGreaterThan(0)
    })
    expect(view.getByText('Drop an image anywhere on this page')).toBeTruthy()
    expect(remove).not.toHaveBeenCalled()
  })

  test('prevents navigation when a protected file URL is still unreadable at drop', async () => {
    const remove = mock(() => Promise.resolve(resultWithSource()))
    const view = render(<Remover removeBackgroundImpl={remove} />)
    const transfer = new DataTransfer()
    transfer.setData('text/uri-list', 'file:///Photos%20Library/fixture.jpeg')
    Object.defineProperty(transfer, 'getData', { value: () => '' })

    expect(fireEvent.drop(window, { dataTransfer: transfer })).toBe(false)
    await waitFor(() => {
      expect(
        view.getAllByText(/Export the photo from Photos/).length,
      ).toBeGreaterThan(0)
    })
    expect(remove).not.toHaveBeenCalled()
  })

  test.each(['files', 'items'])(
    'processes a readable dropped image from DataTransfer.%s',
    async (source) => {
      const urls = trackObjectUrls()
      const request = deferred<BackgroundRemovalResult>()
      const remove = mock(() => request.promise)
      const view = render(
        <Remover
          removeBackgroundImpl={remove}
          waitForPaintImpl={async () => {}}
        />,
      )
      const file = new File(['image'], 'fixture.png', { type: 'image/png' })
      const transfer = new DataTransfer()
      transfer.items.add(file)
      const dataTransfer =
        source === 'files'
          ? transfer
          : {
              files: { length: 0, item: () => null },
              items: transfer.items,
            }

      try {
        expect(fireEvent.drop(window, { dataTransfer })).toBe(false)
        await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
        expect(urls.created).toEqual([file])
        expect(
          view.getByRole('img', { name: 'Original being processed' }),
        ).toBeTruthy()

        // An unreadable drop must preserve the removal already in progress.
        const link = new DataTransfer()
        link.setData('text/uri-list', 'file:///Photos%20Library/fixture.jpeg')
        fireEvent.drop(window, { dataTransfer: link })
        await act(async () => request.resolve(resultWithSource()))
        expect(view.getByRole('button', { name: /Download PNG/ })).toBeTruthy()
        expect(remove).toHaveBeenCalledTimes(1)
      } finally {
        view.unmount()
        urls.restore()
      }
    },
  )
})

describe('Remover retry', () => {
  test.each([
    ['inference-failed', true],
    ['decode-failed', true],
    ['model-load-failed', true],
    ['out-of-memory', true],
    ['image-too-large', false],
    ['unsupported-image', false],
  ] as const)(
    'shows retry for %s only when retryable',
    async (code, shouldShowRetry) => {
      const remove = mock(() =>
        Promise.reject(new BackgroundRemovalError(code, `${code} message`)),
      )
      const view = render(
        <Remover
          removeBackgroundImpl={remove}
          waitForPaintImpl={async () => {}}
        />,
      )

      try {
        selectFile(view, new File(['x'], 'test.png', { type: 'image/png' }))
        await waitFor(() => {
          expect(
            view.getByText('That image could not be processed'),
          ).toBeTruthy()
        })
        if (shouldShowRetry) {
          expect(view.getByRole('button', { name: 'Try again' })).toBeTruthy()
        } else {
          expect(view.queryByRole('button', { name: 'Try again' })).toBeNull()
        }
        expect(
          view.getByRole('button', { name: 'Choose another image' }),
        ).toBeTruthy()
      } finally {
        view.unmount()
      }
    },
  )

  test('retry reprocesses the same file without a new selection', async () => {
    const urls = trackObjectUrls()
    const seen: Blob[] = []
    const remove = mock((input: Blob, _options?: RemoveBackgroundOptions) => {
      seen.push(input)
      if (seen.length === 1) {
        return Promise.reject(
          new BackgroundRemovalError('inference-failed', 'transient boom'),
        )
      }
      return Promise.resolve(resultWithSource())
    })
    const view = render(
      <Remover
        removeBackgroundImpl={remove}
        waitForPaintImpl={async () => {}}
      />,
    )

    try {
      const file = new File(['image'], 'retry.png', { type: 'image/png' })
      selectFile(view, file)
      await waitFor(() => {
        expect(view.getByRole('button', { name: 'Try again' })).toBeTruthy()
      })
      expect(remove).toHaveBeenCalledTimes(1)

      fireEvent.click(view.getByRole('button', { name: 'Try again' }))
      await waitFor(() => {
        expect(view.getByRole('button', { name: /Download PNG/ })).toBeTruthy()
      })
      expect(remove).toHaveBeenCalledTimes(2)
      expect(seen[0]).toBe(seen[1])
    } finally {
      view.unmount()
      urls.restore()
    }
  })

  test('reset then a new error retries the new file', async () => {
    const urls = trackObjectUrls()
    const seen: Blob[] = []
    const remove = mock((input: Blob, _options?: RemoveBackgroundOptions) => {
      seen.push(input)
      if (seen.length <= 2) {
        return Promise.reject(
          new BackgroundRemovalError('inference-failed', 'transient boom'),
        )
      }
      return Promise.resolve(resultWithSource())
    })
    const view = render(
      <Remover
        removeBackgroundImpl={remove}
        waitForPaintImpl={async () => {}}
      />,
    )

    try {
      selectFile(view, new File(['one'], 'one.png', { type: 'image/png' }))
      await waitFor(() => {
        expect(view.getByRole('button', { name: 'Try again' })).toBeTruthy()
      })
      fireEvent.keyDown(window, { key: 'Escape' })
      await waitFor(() => {
        expect(
          view.getByText('Drop an image anywhere on this page'),
        ).toBeTruthy()
      })

      const second = new File(['two'], 'two.png', { type: 'image/png' })
      selectFile(view, second)
      await waitFor(() => {
        expect(view.getByRole('button', { name: 'Try again' })).toBeTruthy()
      })
      fireEvent.click(view.getByRole('button', { name: 'Try again' }))
      await waitFor(() => {
        expect(view.getByRole('button', { name: /Download PNG/ })).toBeTruthy()
      })
      expect(remove).toHaveBeenCalledTimes(3)
      expect(seen[1]).toBe(second)
      expect(seen[2]).toBe(second)
    } finally {
      view.unmount()
      urls.restore()
    }
  })
})

function selectFile(view: ReturnType<typeof render>, file: File) {
  const transfer = new DataTransfer()
  transfer.items.add(file)
  fireEvent.change(
    view.getByLabelText('Choose an image file to remove its background'),
    { target: { files: transfer.files } },
  )
}

function resultWithSource(): BackgroundRemovalResult {
  return {
    blob: new Blob(['result'], { type: 'image/png' }),
    sourceBlob: new Blob(['source'], { type: 'image/png' }),
    width: 1,
    height: 1,
    provider: 'wasm',
    quality: 'quality',
    durationMs: 10,
    model: 'birefnet-lite',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function trackObjectUrls() {
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  const created: Blob[] = []
  const revoked: string[] = []

  URL.createObjectURL = mock((blob: Blob) => {
    created.push(blob)
    return `blob:test-${created.length}`
  })
  URL.revokeObjectURL = mock((url: string) => revoked.push(url))

  return {
    created,
    revoked,
    restore: () => {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
    },
  }
}
