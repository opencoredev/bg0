const UPSTREAM_SELECTION = 'let w8=D1[0],L=w8.get_width()'
const PRIMARY_SELECTION =
  'let w8=D1.find(H6=>H6.is_primary());if(!w8)throw new Error("HEIF primary image not found");let L=w8.get_width()'

export const UPSTREAM_DECODER_SHA256 =
  'e524af5d01a1f32b29ef95592897ee8ba3e4a8dd56efde077c959617b1e0fffb'
export const BG0_DECODER_SHA256 =
  '0cc4e7be7d726f50b5f3527677466ad3c82ae14bfccc7079006e34bb0c288e8a'

interface HeifImage {
  is_primary: () => boolean
}

export function selectPrimaryHeifImage<T extends HeifImage>(images: T[]): T {
  const primaryImage = images.find((image) => image.is_primary())
  if (!primaryImage) throw new Error('HEIF primary image not found')
  return primaryImage
}

export function patchHeicDecoder(source: string): string {
  const firstMatch = source.indexOf(UPSTREAM_SELECTION)
  if (firstMatch === -1 || source.indexOf(UPSTREAM_SELECTION, firstMatch + 1) !== -1) {
    throw new Error('Unexpected heic-to 1.5.2 decoder artifact')
  }
  return source.replace(UPSTREAM_SELECTION, PRIMARY_SELECTION)
}

export function sha256(value: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex')
}

if (import.meta.main) {
  const [sourcePath, destinationPath] = Bun.argv.slice(2)
  if (!sourcePath || !destinationPath) {
    throw new Error('Usage: bun guarded-transform.ts <upstream.js> <output.js>')
  }
  const upstream = await Bun.file(sourcePath).text()
  if (sha256(upstream) !== UPSTREAM_DECODER_SHA256) {
    throw new Error('Unexpected heic-to 1.5.2 decoder hash')
  }
  const patched = patchHeicDecoder(upstream)
  if (sha256(patched) !== BG0_DECODER_SHA256) {
    throw new Error('Unexpected BG0 HEIC decoder hash')
  }
  await Bun.write(destinationPath, patched)
}
