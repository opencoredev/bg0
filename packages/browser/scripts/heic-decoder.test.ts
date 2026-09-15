import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BG0_DECODER_SHA256,
  patchHeicDecoder,
  selectPrimaryHeifImage,
  sha256,
  UPSTREAM_DECODER_SHA256,
} from './heic-decoder'

describe('HEIC decoder patch', () => {
  test('selects a collection primary image regardless of item order', () => {
    const first = { id: 1, is_primary: () => false }
    const primary = { id: 2, is_primary: () => true }

    expect(selectPrimaryHeifImage([first, primary])).toBe(primary)
    expect(() => selectPrimaryHeifImage([first])).toThrow(
      'HEIF primary image not found',
    )
  })

  test('selects the primary image instead of dependency order', () => {
    const source =
      'before;let w8=D1[0],L=w8.get_width(),U6=w8.get_height();after'
    const patched = patchHeicDecoder(source)

    expect(patched).not.toContain('D1[0]')
    expect(patched).toContain('D1.find(H6=>H6.is_primary())')
    expect(patched).toContain('HEIF primary image not found')
  })

  test('fails the build if the pinned upstream artifact changes', () => {
    expect(() => patchHeicDecoder('different decoder')).toThrow(
      'Unexpected heic-to 1.5.2 decoder artifact',
    )
    expect(() =>
      patchHeicDecoder(
        'let w8=D1[0],L=w8.get_width();let w8=D1[0],L=w8.get_width()',
      ),
    ).toThrow('Unexpected heic-to 1.5.2 decoder artifact')
  })

  test('applies the distributed source patch with standard tooling', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'bg0-heic-patch-'))
    const archive = fileURLToPath(
      new URL(
        '../../../third_party/heic-to/source/heic-to-1.5.2.tgz',
        import.meta.url,
      ),
    )
    const patch = fileURLToPath(
      new URL('../vendor/heic-to-primary.patch', import.meta.url),
    )

    try {
      expect(
        Bun.spawnSync(['tar', '-xzf', archive, '-C', temporaryDirectory])
          .exitCode,
      ).toBe(0)
      const application = Bun.spawnSync(
        ['patch', '--batch', '-p0', '-i', patch],
        { cwd: temporaryDirectory },
      )
      expect(new TextDecoder().decode(application.stderr)).toBe('')
      expect(application.exitCode).toBe(0)

      const worker = readFileSync(
        join(temporaryDirectory, 'package/src/worker.js'),
        'utf8',
      )
      expect(worker).toContain(
        'data.find((candidate) => candidate.is_primary())',
      )
      expect(worker).not.toContain('data[0]')

      const upstreamArtifact = join(
        temporaryDirectory,
        'package/dist/heic-to.js',
      )
      const reproducedArtifact = join(temporaryDirectory, 'heic-to.js')
      const transformation = fileURLToPath(
        new URL('./heic-decoder.ts', import.meta.url),
      )
      const reproduction = Bun.spawnSync(
        [process.execPath, transformation, upstreamArtifact, reproducedArtifact],
        { cwd: temporaryDirectory },
      )
      expect(new TextDecoder().decode(reproduction.stderr)).toBe('')
      expect(reproduction.exitCode).toBe(0)
      expect(sha256(readFileSync(reproducedArtifact))).toBe(BG0_DECODER_SHA256)
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true })
    }
  })

  test('pins the guarded production artifact transformation', async () => {
    const upstream = await Bun.file(
      new URL('../node_modules/heic-to/dist/heic-to.js', import.meta.url),
    ).text()

    expect(sha256(upstream)).toBe(UPSTREAM_DECODER_SHA256)
    expect(sha256(patchHeicDecoder(upstream))).toBe(BG0_DECODER_SHA256)
  })
})
