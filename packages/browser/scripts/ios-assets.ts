import { createHash } from 'node:crypto'

export async function loadIosAsset(
  sourceUrl: URL,
  downloadUrl: URL,
  metadata: { bytes: number; sha256: string },
): Promise<Uint8Array> {
  const source = Bun.file(sourceUrl)
  const exists = await source.exists()
  let bytes: Uint8Array
  if (exists) {
    bytes = new Uint8Array(await source.arrayBuffer())
  } else {
    const response = await fetch(downloadUrl)
    if (!response.ok) {
      throw new Error(`Cannot acquire iOS build asset: ${sourceUrl.pathname}`)
    }
    bytes = new Uint8Array(await response.arrayBuffer())
  }
  if (
    bytes.byteLength !== metadata.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== metadata.sha256
  ) {
    throw new Error(`iOS asset checksum mismatch: ${sourceUrl.pathname}`)
  }
  // BunFile caches the missing file's zero length after exists(). Reuse the
  // verified download buffer instead of reading that stale BunFile after write.
  if (!exists) await Bun.write(sourceUrl, bytes)
  return bytes
}
