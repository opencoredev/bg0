import { createHash } from 'node:crypto'

const directory = new URL('../vendor/ios/', import.meta.url)
const manifest = await Bun.file(new URL('manifest.json', directory)).json()
// Temporary review host. Replace with maintainer-owned, immutable model hosting
// before merging. Hash verification prevents mutable preview content substitution.
const downloadBase =
  'https://bg0-mobile-preview.vercel.app/birefnet-test/assets/'
for (const [name, metadata] of Object.entries(manifest.files) as [
  string,
  { bytes: number; sha256: string },
][]) {
  const source = Bun.file(new URL(name, directory))
  if (!(await source.exists())) {
    const response = await fetch(new URL(name, downloadBase))
    if (!response.ok) throw new Error(`Cannot acquire iOS build asset: ${name}`)
    const bytes = await response.arrayBuffer()
    if (
      bytes.byteLength !== metadata.bytes ||
      createHash('sha256').update(new Uint8Array(bytes)).digest('hex') !==
        metadata.sha256
    ) {
      throw new Error(`Invalid iOS build asset: ${name}`)
    }
    await Bun.write(source, bytes)
  }
  const bytes = new Uint8Array(await source.arrayBuffer())
  if (
    bytes.byteLength !== metadata.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== metadata.sha256
  ) {
    throw new Error(`iOS asset checksum mismatch: ${name}`)
  }
  await Bun.write(new URL(`../dist/vendor/ios/${name}`, import.meta.url), bytes)
}
for (const name of [
  'worker.mjs',
  'manifest.json',
  'BiRefNet-LICENSE.txt',
  'ONNX-Runtime-LICENSE.txt',
  'ONNX-Runtime-ThirdPartyNotices.txt',
]) {
  await Bun.write(
    new URL(`../dist/vendor/ios/${name}`, import.meta.url),
    Bun.file(new URL(name, directory)),
  )
}
