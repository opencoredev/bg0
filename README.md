# BG0

**Background → zero.**

BG0 is an open-source background remover that runs locally in the browser. It
uses WebGPU when available, falls back to WebAssembly, and produces a transparent
PNG without uploading the source image.

## Why local

- Images and derived pixels stay in browser memory.
- There is no account, API key, server inference, billing, or usage limit.
- The browser downloads a pinned BiRefNet-lite ONNX model and caches it locally.
- `@bg0/browser` can add the same private flow to another web application.

## Quick start

Install [Bun](https://bun.sh/) 1.4, then:

```bash
bun install --frozen-lockfile
bun run dev
```

The web app starts on port 3000 and the docs start on port 4321. During
development, the web app serves the docs at `/docs`.

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

## Browser layout regression check

With the web app running locally, run:

```bash
bunx playwright install chromium
bun run --cwd apps/web test:layout
```

This uses the licensed cat sample and real model inference, then checks export
controls at 11 viewport widths, transparent output, download, reset, and an
invalid upload. The first run needs network access for the model. Set
`BG0_TEST_URL` for a different local port, `BG0_TEST_BROWSER` to `firefox` or
`webkit` (install that Playwright engine first), and optionally
`BG0_TEST_SCREENSHOTS` to an output directory outside the repository.

## Browser library

```ts
import { removeBackground } from '@bg0/browser'

const result = await removeBackground(file, {
  quality: 'quality',
  onProgress: ({ progress, message }) => console.log(progress, message),
})

const url = URL.createObjectURL(result.blob)
```

The package owns capability detection, model loading and caching, preprocessing,
ONNX inference, mask postprocessing, alpha compositing, progress, cancellation,
and useful errors. Application code does not depend on ONNX internals.

## Repository

| Area | Responsibility |
| --- | --- |
| `apps/web` | TanStack Start site and anonymous local remover |
| `apps/docs` | Blume documentation served at `bg0.dev/docs` |
| `packages/browser` | Reusable WebGPU/WASM inference and PNG output |
| `ARCHITECTURE.md` | Runtime, privacy, and deployment boundaries |

No backend is needed for background removal. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the complete data flow.

## Contributing

Read `AGENTS.md` before changing the application. Keep the product focused on
local background removal, never send image contents or metadata to analytics,
and run the root checks before opening a pull request.

## License

BG0 source is licensed under [Apache License 2.0](LICENSE). Model weights retain
the licenses listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
