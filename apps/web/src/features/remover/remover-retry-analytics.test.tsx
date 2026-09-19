import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

const imageSelectedCalls: string[] = []

mock.module('#/lib/analytics', () => ({
  capturePageView: () => {},
  captureImageSelected: (inputMethod: string) => {
    imageSelectedCalls.push(inputMethod)
  },
  captureRemovalSucceeded: () => {},
  showResultSurvey: () => {},
  captureRemovalFailed: () => {},
  captureResultDownloaded: () => {},
  captureFeatureUsed: () => {},
  captureAppException: () => {},
}))

const { Remover } = await import('./remover')
const { BackgroundRemovalError } = await import('@bg0/browser')
const { cleanup, fireEvent, render, waitFor } = await import(
  '@testing-library/react'
)

import type { BackgroundRemovalResult } from '@bg0/browser'

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register()
}

class IntersectionObserverStub {
  observe() {}
  disconnect() {}
}

globalThis.IntersectionObserver =
  IntersectionObserverStub as unknown as typeof IntersectionObserver

afterEach(() => {
  cleanup()
  imageSelectedCalls.length = 0
})

afterAll(() => {
  if (GlobalRegistrator.isRegistered) {
    void GlobalRegistrator.unregister()
  }
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

describe('Remover retry analytics', () => {
  test('a genuine selection emits once and retry does not emit again', async () => {
    let calls = 0
    const remove = mock(() => {
      calls += 1
      if (calls === 1) {
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
      selectFile(view, new File(['image'], 'retry.png', { type: 'image/png' }))
      await waitFor(() => {
        expect(view.getByRole('button', { name: 'Try again' })).toBeTruthy()
      })
      expect(imageSelectedCalls).toEqual(['picker'])

      fireEvent.click(view.getByRole('button', { name: 'Try again' }))
      await waitFor(() => {
        expect(view.getByRole('button', { name: /Download PNG/ })).toBeTruthy()
      })
      expect(remove).toHaveBeenCalledTimes(2)
      expect(imageSelectedCalls).toEqual(['picker'])
    } finally {
      view.unmount()
    }
  })

  test('a new selection after reset emits again', async () => {
    const remove = mock(() => Promise.resolve(resultWithSource()))
    const view = render(
      <Remover
        removeBackgroundImpl={remove}
        waitForPaintImpl={async () => {}}
      />,
    )

    try {
      selectFile(view, new File(['one'], 'one.png', { type: 'image/png' }))
      await waitFor(() => {
        expect(view.getByRole('button', { name: /Download PNG/ })).toBeTruthy()
      })
      expect(imageSelectedCalls).toEqual(['picker'])

      fireEvent.keyDown(window, { key: 'Escape' })
      await waitFor(() => {
        expect(
          view.getByText('Drop an image anywhere on this page'),
        ).toBeTruthy()
      })

      selectFile(view, new File(['two'], 'two.png', { type: 'image/png' }))
      await waitFor(() => {
        expect(remove).toHaveBeenCalledTimes(2)
      })
      expect(imageSelectedCalls).toEqual(['picker', 'picker'])
    } finally {
      view.unmount()
    }
  })
})
