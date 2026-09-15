import { describe, expect, test } from 'bun:test'

interface PackageMetadata {
  exports: Record<string, Record<string, string>>
  files: string[]
}

describe('package metadata', () => {
  test('every exported entry is included in the published files', async () => {
    const packageJson = (await Bun.file(
      new URL('../package.json', import.meta.url),
    ).json()) as PackageMetadata

    for (const conditions of Object.values(packageJson.exports)) {
      for (const target of Object.values(conditions)) {
        const topLevelDirectory = target.replace(/^\.\//, '').split('/')[0]
        expect(packageJson.files).toContain(topLevelDirectory)
      }
    }

    expect(packageJson.files).toContain('LICENSE')
    expect(packageJson.files).toContain('THIRD_PARTY_NOTICES.md')
  })
})
