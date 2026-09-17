import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadIosAsset } from './ios-assets'

test('downloads missing assets and reuses verified cached bytes offline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bg0-ios-assets-'))
  const payload = new Uint8Array([1, 2, 3, 4])
  const metadata = {
    bytes: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'),
  }
  let requests = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      requests++
      return new Response(payload)
    },
  })
  const source = pathToFileURL(join(directory, 'model.ort'))
  try {
    expect(await loadIosAsset(source, server.url, metadata)).toEqual(payload)
    expect(new Uint8Array(await Bun.file(source).arrayBuffer())).toEqual(
      payload,
    )
    expect(requests).toBe(1)
    server.stop(true)
    expect(await loadIosAsset(source, server.url, metadata)).toEqual(payload)
    expect(requests).toBe(1)
    await Bun.write(source, new Uint8Array([4, 3, 2, 1]))
    await expect(loadIosAsset(source, server.url, metadata)).rejects.toThrow(
      'checksum mismatch',
    )
  } finally {
    server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects bad downloads without caching them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bg0-ios-assets-'))
  const payload = new Uint8Array([1, 2, 3, 4])
  const metadata = {
    bytes: payload.length,
    sha256: createHash('sha256').update(payload).digest('hex'),
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/missing') return new Response('Not found', { status: 404 })
      return new Response(
        path === '/truncated'
          ? new Uint8Array([1, 2])
          : new Uint8Array([4, 3, 2, 1]),
      )
    },
  })
  try {
    for (const path of ['truncated', 'wrong-hash', 'missing']) {
      const source = pathToFileURL(join(directory, path))
      await expect(
        loadIosAsset(source, new URL(path, server.url), metadata),
      ).rejects.toThrow(
        path === 'missing' ? 'Cannot acquire' : 'checksum mismatch',
      )
      expect(await Bun.file(source).exists()).toBe(false)
    }
  } finally {
    server.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
})
