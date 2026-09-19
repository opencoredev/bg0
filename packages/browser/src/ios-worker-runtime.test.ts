import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Exercise the shipped worker handler with deterministic runtime tensors.
const source = readFileSync(
  new URL('../vendor/ios/worker.mjs', import.meta.url),
  'utf8',
)
  .replaceAll(
    'import.meta.url',
    JSON.stringify('https://example.test/worker.mjs'),
  )
  .replace('await import(/* @vite-ignore */ runtimeUrl)', 'await loadRuntime()')

test.each([-100, 100, 0, NaN])(
  'worker handles uniform logits %s without confusing valid masks with corruption',
  async (logit) => {
    const messages: { id?: number; error?: string; alpha?: ArrayBuffer }[] = []
    let released = 0
    const scope = {
      onmessage: undefined as unknown as (event: {
        data: object
      }) => Promise<void>,
      postMessage: (data: (typeof messages)[number]) => messages.push(data),
    }
    const runtime = {
      env: { wasm: {} },
      Tensor: class {
        dispose() {
          released++
        }
      },
      InferenceSession: {
        create: async () => ({
          inputNames: ['input'],
          outputNames: ['output'],
          run: async () => ({
            output: {
              data: new Float32Array(512 * 512).fill(logit),
              dispose() {
                released++
              },
            },
          }),
        }),
      },
    }
    runInNewContext(source, {
      URL,
      self: scope,
      loadRuntime: async () => runtime,
      fetch: async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1),
      }),
    })
    await scope.onmessage({ data: { id: 1, type: 'load' } })
    await scope.onmessage({
      data: { id: 2, type: 'run', buffer: new ArrayBuffer(512 * 512 * 3 * 4) },
    })
    const result = messages.find((m) => m.id === 2)!
    if (Number.isFinite(logit)) {
      expect(result.error).toBeUndefined()
      expect(new Float32Array(result.alpha!)[0]).toBeCloseTo(
        1 / (1 + Math.exp(-logit)),
      )
    } else expect(result.error).toBe('inference-failed')
    expect(released).toBe(2)
  },
)
