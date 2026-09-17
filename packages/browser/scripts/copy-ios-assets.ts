import { loadIosAsset } from './ios-assets'

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
  const bytes = await loadIosAsset(
    new URL(name, directory),
    new URL(name, downloadBase),
    metadata,
  )
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
