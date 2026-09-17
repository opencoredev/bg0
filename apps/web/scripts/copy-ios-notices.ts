import { existsSync } from 'node:fs'

const roots = ['../.output/public/', '../.vercel/output/static/']
const files = ['manifest.json', 'BiRefNet-LICENSE.txt', 'ONNX-Runtime-LICENSE.txt', 'ONNX-Runtime-ThirdPartyNotices.txt']
for (const root of roots) {
  const destination = new URL(root, import.meta.url)
  if (!existsSync(destination)) continue
  for (const name of files) {
    await Bun.write(new URL(`third-party/ios/${name}`, destination), Bun.file(new URL(`../../../packages/browser/vendor/ios/${name}`, import.meta.url)))
  }
}
