import {
  BG0_DECODER_SHA256,
  patchHeicDecoder,
  sha256,
  UPSTREAM_DECODER_SHA256,
} from './heic-decoder'

const decoderSource = Bun.file(
  new URL('../node_modules/heic-to/dist/heic-to.js', import.meta.url),
)
if (!(await decoderSource.exists())) {
  throw new Error('Missing HEIC decoder build input: heic-to.js')
}
const upstreamDecoder = await decoderSource.text()
if (sha256(upstreamDecoder) !== UPSTREAM_DECODER_SHA256) {
  throw new Error('Unexpected heic-to 1.5.2 decoder hash')
}
const patchedDecoder = patchHeicDecoder(upstreamDecoder)
if (sha256(patchedDecoder) !== BG0_DECODER_SHA256) {
  throw new Error('Unexpected BG0 HEIC decoder hash')
}
await Bun.write(
  new URL('../dist/vendor/heic-to.js', import.meta.url),
  patchedDecoder,
)

const files = [
  ['../node_modules/heic-to/LICENSE', '../dist/vendor/heic-to-LICENSE.txt'],
  ['../vendor/GPL-3.0.txt', '../dist/vendor/GPL-3.0.txt'],
  [
    '../../../third_party/heic-to/source/heic-to-1.5.2.tgz',
    '../dist/vendor/source/heic-to-1.5.2.tgz',
  ],
  [
    '../../../third_party/heic-to/source/libheif-1.22.2.tar.gz',
    '../dist/vendor/source/libheif-1.22.2.tar.gz',
  ],
  [
    '../../../third_party/heic-to/source/libde265-1.0.16.tar.gz',
    '../dist/vendor/source/libde265-1.0.16.tar.gz',
  ],
  [
    '../vendor/heic-to-primary.patch',
    '../dist/vendor/source/heic-to-primary.patch',
  ],
  ['../vendor/HEIC_DECODER_BUILD.md', '../dist/vendor/source/BUILD.md'],
  [
    './heic-decoder.ts',
    '../dist/vendor/source/guarded-transform.ts',
  ],
] as const

for (const [source, destination] of files) {
  const sourceFile = Bun.file(new URL(source, import.meta.url))
  if (!(await sourceFile.exists())) {
    throw new Error(`Missing HEIC decoder build input: ${source}`)
  }
  await Bun.write(new URL(destination, import.meta.url), sourceFile)
}
