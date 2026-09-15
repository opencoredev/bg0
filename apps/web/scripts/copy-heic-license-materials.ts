const sourceFiles = [
  'heic-to-1.5.2.tgz',
  'libheif-1.22.2.tar.gz',
  'libde265-1.0.16.tar.gz',
] as const

for (const name of sourceFiles) {
  const source = Bun.file(
    new URL(`../../../third_party/heic-to/source/${name}`, import.meta.url),
  )
  if (!(await source.exists())) {
    throw new Error(`Missing HEIC corresponding source: ${name}`)
  }
  await Bun.write(
    new URL(`../.output/public/third-party/source/${name}`, import.meta.url),
    source,
  )
}

const buildMaterials = [
  ['heic-to-primary.patch', 'heic-to-primary.patch'],
  ['HEIC_DECODER_BUILD.md', 'BUILD.md'],
] as const

for (const [sourceName, destinationName] of buildMaterials) {
  const source = Bun.file(
    new URL(
      `../../../packages/browser/vendor/${sourceName}`,
      import.meta.url,
    ),
  )
  if (!(await source.exists())) {
    throw new Error(`Missing HEIC decoder build material: ${sourceName}`)
  }
  await Bun.write(
    new URL(
      `../.output/public/third-party/source/${destinationName}`,
      import.meta.url,
    ),
    source,
  )
}

const transformation = Bun.file(
  new URL(
    '../../../packages/browser/scripts/heic-decoder.ts',
    import.meta.url,
  ),
)
if (!(await transformation.exists())) {
  throw new Error('Missing guarded HEIC decoder transformation')
}
await Bun.write(
  new URL(
    '../.output/public/third-party/source/guarded-transform.ts',
    import.meta.url,
  ),
  transformation,
)
