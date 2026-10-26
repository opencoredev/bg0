import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
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
afterAll(async () => {
  // React can still have a scheduled commit callback after the last cleanup.
  // Let it run before the DOM globals it reads are removed.
  await new Promise((resolve) => setTimeout(resolve, 50))
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister()
  }
})

const MIB = 1024 ** 2

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

  test('a newer warm-up replaces the last one and passes the tier', () => {
    const prepare = mock(
      (_options?: { model?: string; signal?: AbortSignal }) =>
        Promise.resolve('wasm' as const),
    )
    warmBackgroundRemovalModel(MAC_SAFARI_USER_AGENT, prepare, 0, 'auto')
    warmBackgroundRemovalModel(MAC_SAFARI_USER_AGENT, prepare, 0, 'lite')
    const [first, second] = prepare.mock.calls.map(([options]) => options)
    expect(first?.model).toBe('auto')
    expect(first?.signal?.aborted).toBe(true)
    expect(second?.model).toBe('lite')
    expect(second?.signal?.aborted).toBe(false)
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
    const originalConnection = (
      navigator as Navigator & { connection?: unknown }
    ).connection

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

      // Choosing lite on a slow connection only records the tier.
      const record = mock(
        (_options?: { model?: string; signal?: AbortSignal }) =>
          Promise.resolve('wasm' as const),
      )
      warmBackgroundRemovalModel(MAC_SAFARI_USER_AGENT, record, 0, 'lite')
      expect(record.mock.calls[0][0]?.model).toBe('lite')
      expect(record.mock.calls[0][0]?.signal?.aborted).toBe(true)
      warmBackgroundRemovalModel(MAC_SAFARI_USER_AGENT, record, 0, 'full')
      expect(record).toHaveBeenCalledTimes(1)

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

  test('hides the processing preview when the browser cannot decode the source', async () => {
    const urls = trackObjectUrls()
    const request = deferred<BackgroundRemovalResult>()
    const view = render(
      <Remover
        removeBackgroundImpl={() => request.promise}
        waitForPaintImpl={() => Promise.resolve()}
      />,
    )

    try {
      selectFile(view, new File(['heic'], 'photo.heic', { type: 'image/heic' }))
      const first = view.getByRole('img', {
        name: 'Original being processed',
      })

      selectFile(view, new File(['image'], 'photo.png', { type: 'image/png' }))
      expect(
        view
          .getByRole('img', { name: 'Original being processed' })
          .getAttribute('src'),
      ).toBe('blob:test-2')
      expect(first.isConnected).toBe(false)

      fireEvent.error(first)
      expect(
        view
          .getByRole('img', { name: 'Original being processed' })
          .getAttribute('src'),
      ).toBe('blob:test-2')

      fireEvent.error(
        view.getByRole('img', { name: 'Original being processed' }),
      )
      expect(
        view.queryByRole('img', { name: 'Original being processed' }),
      ).toBeNull()
      expect(view.getByText('Preparing…')).toBeTruthy()

      selectFile(
        view,
        new File(['image2'], 'photo-2.png', { type: 'image/png' }),
      )
      expect(
        view
          .getByRole('img', { name: 'Original being processed' })
          .getAttribute('src'),
      ).toBe('blob:test-3')
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

  test('asks the iPhone photo picker for JPEG instead of HEIC, but Files keeps HEIC', async () => {
    const originalUserAgent = navigator.userAgent
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: IPHONE_SAFARI_USER_AGENT,
    })
    try {
      const view = render(<Remover />)
      await waitFor(() =>
        expect(
          view.getByLabelText('Choose a photo').getAttribute('accept'),
        ).toBe('image/png,image/jpeg,image/webp'),
      )
      expect(
        view
          .getByLabelText('Choose an image file to remove its background')
          .getAttribute('accept'),
      ).toContain('.heic')
      view.unmount()
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: originalUserAgent,
      })
    }
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

describe('Remover result screen', () => {
  async function renderWithResult() {
    const urls = trackObjectUrls()
    const requests: ReturnType<typeof deferred<BackgroundRemovalResult>>[] = []
    const remove = mock((_input: Blob, _options?: RemoveBackgroundOptions) => {
      const request = deferred<BackgroundRemovalResult>()
      requests.push(request)
      return request.promise
    })
    const view = render(
      <Remover
        removeBackgroundImpl={remove}
        waitForPaintImpl={() => Promise.resolve()}
      />,
    )
    selectFile(view, new File(['one'], 'one.png', { type: 'image/png' }))
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
    await act(async () => requests[0]?.resolve(resultWithSource()))
    await waitFor(() => {
      expect(view.getByRole('button', { name: /Download PNG/ })).toBeTruthy()
    })
    // blob:test-1 is the picked file (released once the decoded source
    // exists), blob:test-2 the result, and blob:test-3 the preview source.
    expect(urls.revoked).toEqual(['blob:test-1'])
    return { urls, remove, requests, view }
  }

  function liveRegion(view: ReturnType<typeof render>) {
    return view.container.querySelector('[aria-live="polite"]')?.textContent
  }

  test('shows a replace affordance while dragging and processes a dropped image', async () => {
    const { urls, remove, requests, view } = await renderWithResult()
    try {
      const overlay = view.getByTestId('replace-drop-overlay')
      expect(overlay.getAttribute('aria-hidden')).toBe('true')
      expect(overlay.getAttribute('data-visible')).toBe('false')

      const file = new File(['two'], 'two.png', { type: 'image/png' })
      const transfer = new DataTransfer()
      transfer.items.add(file)
      expect(fireEvent.dragEnter(window, { dataTransfer: transfer })).toBe(
        false,
      )
      expect(overlay.getAttribute('data-visible')).toBe('true')
      // Screen readers can read the replacement warning while it is shown.
      expect(overlay.getAttribute('aria-hidden')).toBe('false')
      expect(overlay.textContent).toContain('Release to remove the background')
      expect(overlay.textContent).toContain('has not been downloaded')

      expect(fireEvent.drop(window, { dataTransfer: transfer })).toBe(false)
      expect(overlay.getAttribute('data-visible')).toBe('false')
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(2))
      expect(remove.mock.calls[1]?.[0]).toBe(file)
      expect(
        view.getByRole('img', { name: 'Original being processed' }),
      ).toBeTruthy()
      // The previous result and its preview source are released immediately.
      expect(urls.revoked).toEqual([
        'blob:test-1',
        'blob:test-3',
        'blob:test-2',
      ])
      expect(liveRegion(view)).toBe(
        'Previous result replaced before download. Removing the background from the new image on this device.',
      )
      expect(
        view.getByText('Previous result replaced before download'),
      ).toBeTruthy()

      await act(async () => requests[1]?.resolve(resultWithSource()))
      await waitFor(() => {
        expect(view.getByRole('button', { name: /Download PNG/ })).toBeTruthy()
      })
      expect(view.getByAltText('Background removed').getAttribute('src')).toBe(
        'blob:test-5',
      )
    } finally {
      view.unmount()
      urls.restore()
    }
  })

  test('replaces a downloaded result from a paste without a warning', async () => {
    const { urls, remove, view } = await renderWithResult()
    const click = mock(() => {})
    const originalClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = click
    try {
      fireEvent.click(view.getByRole('button', { name: /Download PNG/ }))
      expect(click).toHaveBeenCalledTimes(1)

      const transfer = new DataTransfer()
      transfer.items.add(new File(['two'], 'two.png', { type: 'image/png' }))
      fireEvent.dragEnter(window, { dataTransfer: transfer })
      expect(view.getByTestId('replace-drop-overlay').textContent).toContain(
        'This replaces the current result.',
      )
      fireEvent.dragLeave(window, { dataTransfer: transfer })

      const pasted = new DataTransfer()
      pasted.items.add(
        new File(['three'], 'clipboard.png', { type: 'image/png' }),
      )
      fireEvent.paste(window, { clipboardData: pasted })
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(2))
      expect(liveRegion(view)).toBe(
        'Removing the background from the new image on this device.',
      )
      expect(
        view.queryByText('Previous result replaced before download'),
      ).toBeNull()
      expect(urls.revoked).toEqual([
        'blob:test-1',
        'blob:test-3',
        'blob:test-2',
      ])
    } finally {
      HTMLAnchorElement.prototype.click = originalClick
      view.unmount()
      urls.restore()
    }
  })

  test('a new result does not inherit the previous result copy label', async () => {
    const { urls, remove, requests, view } = await renderWithResult()
    const secure = Object.getOwnPropertyDescriptor(window, 'isSecureContext')
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const originalClipboardItem = globalThis.ClipboardItem
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: async () => undefined },
    })
    globalThis.ClipboardItem = class {
      constructor(readonly items: Record<string, Blob>) {}
    } as unknown as typeof ClipboardItem
    try {
      fireEvent.click(view.getByRole('button', { name: /^Copy/ }))
      await waitFor(() => {
        expect(
          view.getByRole('button', { name: /^Copied/ }).textContent,
        ).toContain('Copied')
      })
      selectFile(view, new File(['two'], 'two.png', { type: 'image/png' }))
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(2))
      await act(async () => requests[1]?.resolve(resultWithSource()))
      await waitFor(() => {
        expect(view.getByRole('button', { name: /Download PNG/ })).toBeTruthy()
      })
      expect(
        view.getByRole('button', { name: /^Copy/ }).textContent,
      ).not.toContain('Copied')
    } finally {
      if (secure) Object.defineProperty(window, 'isSecureContext', secure)
      else delete (window as { isSecureContext?: boolean }).isSecureContext
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
      else delete (navigator as { clipboard?: Clipboard }).clipboard
      globalThis.ClipboardItem = originalClipboardItem
      view.unmount()
      urls.restore()
    }
  })

  test('a copy that finishes after a replacement leaves the new result unsaved', async () => {
    const { urls, remove, requests, view } = await renderWithResult()
    const write = deferred<void>()
    const secure = Object.getOwnPropertyDescriptor(window, 'isSecureContext')
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const originalClipboardItem = globalThis.ClipboardItem
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: () => write.promise },
    })
    globalThis.ClipboardItem = class {
      constructor(readonly items: Record<string, Blob>) {}
    } as unknown as typeof ClipboardItem
    try {
      fireEvent.click(view.getByRole('button', { name: /^Copy/ }))
      selectFile(view, new File(['two'], 'two.png', { type: 'image/png' }))
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(2))
      await act(async () => requests[1]?.resolve(resultWithSource()))
      await waitFor(() => {
        expect(view.getByRole('button', { name: /Download PNG/ })).toBeTruthy()
      })
      await act(async () => write.resolve())
      expect(
        view.getByRole('button', { name: /^Copy/ }).textContent,
      ).not.toContain('Copied')
      expect(view.queryByText('PNG copied to the clipboard')).toBeNull()

      selectFile(view, new File(['three'], 'three.png', { type: 'image/png' }))
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(3))
      expect(liveRegion(view)).toBe(
        'Previous result replaced before download. Removing the background from the new image on this device.',
      )
    } finally {
      if (secure) Object.defineProperty(window, 'isSecureContext', secure)
      else delete (window as { isSecureContext?: boolean }).isSecureContext
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard)
      else delete (navigator as { clipboard?: Clipboard }).clipboard
      globalThis.ClipboardItem = originalClipboardItem
      view.unmount()
      urls.restore()
    }
  })

  test('opens the file picker from the result screen in one click', async () => {
    const { urls, remove, view } = await renderWithResult()
    try {
      const fileInput = view.getByLabelText(
        'Choose an image file to remove its background',
      )
      const fileClick = mock(() => {})
      fileInput.click = fileClick

      const button = view.getByRole('button', { name: /^New image/ })
      fireEvent.click(button)
      expect(fileClick).toHaveBeenCalledTimes(1)
      // Cancelling the picker keeps the current result.
      expect(view.getByRole('button', { name: /Download PNG/ })).toBeTruthy()

      selectFile(view, new File(['two'], 'two.png', { type: 'image/png' }))
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(2))
      expect(
        view.getByRole('img', { name: 'Original being processed' }),
      ).toBeTruthy()
    } finally {
      view.unmount()
      urls.restore()
    }
  })
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
            view.getByText(
              code === 'image-too-large'
                ? 'This image is too large'
                : 'That image could not be processed',
            ),
          ).toBeTruthy()
        })
        expect(view.getAllByText(`${code} message`).length).toBe(2)
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

describe('Remover loading status', () => {
  test('shows download sizes, the one-time note and a CPU expectation', async () => {
    const urls = trackObjectUrls()
    const request = deferred<BackgroundRemovalResult>()
    let report: RemoveBackgroundOptions['onProgress']
    const remove = mock((_input: Blob, options?: RemoveBackgroundOptions) => {
      report = options?.onProgress
      return request.promise
    })
    const view = render(
      <Remover
        removeBackgroundImpl={remove}
        waitForPaintImpl={() => Promise.resolve()}
      />,
    )

    try {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['image'], 'a.png', { type: 'image/png' }))
      fireEvent.paste(window, { clipboardData: transfer })
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))

      act(() =>
        report?.({
          stage: 'downloading',
          progress: 0.3,
          message: 'Downloading local model…',
          provider: 'wasm',
          download: { loadedBytes: 40 * MIB, totalBytes: 94 * MIB },
        }),
      )
      expect(
        view.getAllByText('Downloading model · 40 of 94 MiB').length,
      ).toBeGreaterThan(0)
      expect(
        view.getByText(
          'Usually a one-time download, so later runs are faster.',
        ),
      ).toBeTruthy()
      const live = view.container.querySelector('[aria-live="polite"]')
      expect(live?.textContent).toBe(
        'Downloading the model (94 MiB). BG0 tries to keep it so later runs are faster.',
      )

      act(() =>
        report?.({
          stage: 'downloading',
          progress: 0.5,
          message: 'Downloading local model…',
          provider: 'wasm',
          download: { loadedBytes: 70 * MIB, totalBytes: 94 * MIB },
        }),
      )
      expect(
        view.getAllByText('Downloading model · 70 of 94 MiB').length,
      ).toBeGreaterThan(0)

      act(() =>
        report?.({
          stage: 'processing',
          progress: 0.7,
          message: 'Removing background…',
          provider: 'wasm',
        }),
      )
      expect(
        view.getByText(
          'Running without GPU acceleration, so this can take a minute.',
        ),
      ).toBeTruthy()

      act(() =>
        report?.({
          stage: 'processing',
          progress: 0.7,
          message: 'Removing background…',
          provider: 'webgpu',
        }),
      )
      expect(view.queryByText(/without GPU acceleration/)).toBeNull()
    } finally {
      view.unmount()
      urls.restore()
    }
  })
})

describe('Remover model tier', () => {
  const STORAGE_KEY = 'bg0:model-tier'
  const pageUrl = window.location.href
  const setUrl = (url: string) =>
    (
      window as unknown as { happyDOM: { setURL: (url: string) => void } }
    ).happyDOM.setURL(url)

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY)
    setUrl(pageUrl)
    Reflect.deleteProperty(navigator, 'connection')
  })

  function pasteImage() {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['image'], 'a.png', { type: 'image/png' }))
    fireEvent.paste(window, { clipboardData: transfer })
  }

  test('shows each tier with its download size, saves the choice and re-warms', () => {
    const warm = mock((_model: string) => undefined)
    const view = render(<Remover warmImpl={warm} />)
    const group = view.getByRole('radiogroup', { name: 'Model' })
    expect(group.textContent).toContain('Auto')
    expect(group.textContent).toContain('Lite94 MiB')
    expect(group.textContent).toContain('Full452 MiB')
    expect(view.getByRole('radio', { name: 'Auto' })).toHaveProperty(
      'checked',
      true,
    )

    fireEvent.click(view.getByRole('radio', { name: /Lite/ }))
    expect(view.getByRole('radio', { name: /Lite/ })).toHaveProperty(
      'checked',
      true,
    )
    expect(localStorage.getItem(STORAGE_KEY)).toBe('lite')
    expect(warm.mock.calls).toEqual([['lite']])
    expect(view.getByText('Smaller download, less fine detail.')).toBeTruthy()
    // A URL without the parameter is left alone.
    expect(window.location.search).toBe('')
    view.unmount()

    // The saved choice survives a reload.
    const again = render(<Remover warmImpl={warm} />)
    expect(again.getByRole('radio', { name: /Lite/ })).toHaveProperty(
      'checked',
      true,
    )
  })

  test('a ?model= link pins the tier and stays in step with the picker', async () => {
    localStorage.setItem(STORAGE_KEY, 'full')
    setUrl('https://bg0.dev/?model=lite')
    const remove = mock(
      (_input: Blob, _options?: RemoveBackgroundOptions) =>
        new Promise<BackgroundRemovalResult>(() => undefined),
    )
    const view = render(
      <Remover
        removeBackgroundImpl={remove}
        waitForPaintImpl={() => Promise.resolve()}
        warmImpl={() => undefined}
      />,
    )
    expect(view.getByRole('radio', { name: /Lite/ })).toHaveProperty(
      'checked',
      true,
    )
    pasteImage()
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
    expect(remove.mock.calls[0][1]?.model).toBe('lite')

    fireEvent.click(view.getByRole('radio', { name: /Full/ }))
    expect(window.location.search).toBe('?model=full')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('full')
    view.unmount()
  })

  test('offers Lite while the full model downloads and restarts the image with it', async () => {
    const urls = trackObjectUrls()
    const reports: NonNullable<RemoveBackgroundOptions['onProgress']>[] = []
    const remove = mock((_input: Blob, options?: RemoveBackgroundOptions) => {
      if (options?.onProgress) reports.push(options.onProgress)
      return new Promise<BackgroundRemovalResult>(() => undefined)
    })
    const warm = mock((_model: string) => undefined)
    const view = render(
      <Remover
        removeBackgroundImpl={remove}
        waitForPaintImpl={() => Promise.resolve()}
        warmImpl={warm}
      />,
    )
    try {
      pasteImage()
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
      expect(remove.mock.calls[0][1]?.model).toBe('auto')

      act(() =>
        reports[0]({
          stage: 'downloading',
          progress: 0.1,
          message: 'Downloading local model…',
          provider: 'webgpu',
          model: 'birefnet-lite',
          download: { loadedBytes: 10 * MIB, totalBytes: 94 * MIB },
        }),
      )
      // Lite is already downloading: nothing to switch to.
      expect(view.queryByTestId('switch-to-lite')).toBeNull()

      act(() =>
        reports[0]({
          stage: 'downloading',
          progress: 0.1,
          message: 'Downloading local model…',
          provider: 'webgpu',
          model: 'birefnet',
          download: { loadedBytes: 10 * MIB, totalBytes: 452 * MIB },
        }),
      )
      const action = view.getByTestId('switch-to-lite')
      expect(action.textContent).toBe('Switch to Lite94 MiB')
      expect(
        view.getByText(
          'Usually a one-time download, so later runs are faster.',
        ),
      ).toBeTruthy()

      const firstSignal = remove.mock.calls[0][1]?.signal
      fireEvent.click(action)
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(2))
      expect(firstSignal?.aborted).toBe(true)
      expect(remove.mock.calls[1][1]?.model).toBe('lite')
      expect(localStorage.getItem(STORAGE_KEY)).toBe('lite')
      expect(view.getByRole('radio', { name: /Lite/ })).toHaveProperty(
        'checked',
        true,
      )
      // The page-load warm-up is replaced, so it stops holding the full load.
      expect(warm.mock.calls).toEqual([['lite']])
      const live = view.container.querySelector('[aria-live="polite"]')
      expect(live?.textContent).toBe(
        'Switched to Lite (94 MiB). Starting this image again.',
      )
    } finally {
      view.unmount()
      urls.restore()
    }
  })

  test('a slow connection explains the wait and offers Lite even when Full is pinned', async () => {
    const urls = trackObjectUrls()
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { effectiveType: '3g' },
    })
    let report: RemoveBackgroundOptions['onProgress']
    const remove = mock((_input: Blob, options?: RemoveBackgroundOptions) => {
      report = options?.onProgress
      return new Promise<BackgroundRemovalResult>(() => undefined)
    })
    const view = render(
      <Remover
        removeBackgroundImpl={remove}
        waitForPaintImpl={() => Promise.resolve()}
        warmImpl={() => undefined}
      />,
    )
    try {
      expect(
        view.getByText(
          'Slow connection? Lite downloads 94 MiB instead of 452 MiB.',
        ),
      ).toBeTruthy()
      fireEvent.click(view.getByRole('radio', { name: /Full/ }))
      expect(view.queryByText(/^Slow connection\?/)).toBeNull()

      pasteImage()
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
      act(() =>
        report?.({
          stage: 'downloading',
          progress: 0.1,
          message: 'Downloading local model…',
          provider: 'webgpu',
          model: 'birefnet',
          download: { loadedBytes: 10 * MIB, totalBytes: 452 * MIB },
        }),
      )
      expect(view.getByText('This download looks slow.')).toBeTruthy()
      expect(view.getByTestId('switch-to-lite')).toBeTruthy()
    } finally {
      view.unmount()
      urls.restore()
    }
  })

  test('a pinned Full download that pauses still gets the slow hint', async () => {
    const urls = trackObjectUrls()
    localStorage.setItem(STORAGE_KEY, 'full')
    const now = spyOn(performance, 'now')
    let report: RemoveBackgroundOptions['onProgress']
    const remove = mock((_input: Blob, options?: RemoveBackgroundOptions) => {
      report = options?.onProgress
      return new Promise<BackgroundRemovalResult>(() => undefined)
    })
    const view = render(
      <Remover
        removeBackgroundImpl={remove}
        waitForPaintImpl={() => Promise.resolve()}
        warmImpl={() => undefined}
      />,
    )
    try {
      pasteImage()
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
      now.mockReturnValue(1_000)
      act(() =>
        report?.({
          stage: 'downloading',
          progress: 0.1,
          message: 'Downloading local model…',
          provider: 'webgpu',
          model: 'birefnet',
          download: { loadedBytes: 1 * MIB, totalBytes: 452 * MIB },
        }),
      )
      expect(view.queryByTestId('switch-to-lite')).toBeNull()
      // No further progress arrives: the download has paused.
      now.mockReturnValue(5_000)
      await waitFor(
        () => expect(view.getByTestId('switch-to-lite')).toBeTruthy(),
        {
          timeout: 2_500,
        },
      )
    } finally {
      now.mockRestore()
      view.unmount()
      urls.restore()
    }
  })

  test('a pinned Full download offers Lite once the measured speed is slow', async () => {
    const urls = trackObjectUrls()
    localStorage.setItem(STORAGE_KEY, 'full')
    const now = spyOn(performance, 'now')
    let report: RemoveBackgroundOptions['onProgress']
    const remove = mock((_input: Blob, options?: RemoveBackgroundOptions) => {
      report = options?.onProgress
      return new Promise<BackgroundRemovalResult>(() => undefined)
    })
    const view = render(
      <Remover
        removeBackgroundImpl={remove}
        waitForPaintImpl={() => Promise.resolve()}
        warmImpl={() => undefined}
      />,
    )
    const download = (at: number, loaded: number) => {
      now.mockReturnValue(at)
      act(() =>
        report?.({
          stage: 'downloading',
          progress: 0.1,
          message: 'Downloading local model…',
          provider: 'webgpu',
          model: 'birefnet',
          download: { loadedBytes: loaded * MIB, totalBytes: 452 * MIB },
        }),
      )
    }
    try {
      pasteImage()
      await waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
      download(1_000, 1)
      expect(view.queryByTestId('switch-to-lite')).toBeNull()
      // 1 MiB/s: about seven minutes still to go.
      download(5_000, 5)
      expect(view.getByTestId('switch-to-lite')).toBeTruthy()
      expect(view.getByText(/This download looks slow/)).toBeTruthy()
    } finally {
      now.mockRestore()
      view.unmount()
      urls.restore()
    }
  })
})
