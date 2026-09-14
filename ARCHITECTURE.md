# BG0 architecture

BG0 has one image path. It runs entirely inside the browser.

```text
file picker / drop / paste
            ↓
      @bg0/browser
            ↓
cached BiRefNet-lite ONNX model
            ↓
       WebGPU / WASM
            ↓
 transparent PNG in browser memory
            ↓
      download / copy
```

## Runtime boundaries

`apps/web` contains the TanStack Start website and remover interface.
`packages/browser` contains all model-specific work: capability detection, model
loading and caching, preprocessing, ONNX inference, mask postprocessing, alpha
compositing, cancellation, progress, and error normalization. UI code never
imports ONNX or model internals directly.

`apps/docs` is a separate static Blume application built under `/docs`. The web
development server proxies that path to the docs server, and production routes
the same path to the deployed static docs.

There is no control plane, database, authentication system, billing system,
hosted inference service, public image API, Docker inference server, CLI, SDK, or
MCP server in the current product.

## Image and user data

Selected image bytes, decoded pixels, masks, previews, and output PNGs remain in
browser memory. They must never be sent to analytics, logs, error reporting, or
another service. Object URLs are revoked when a result is cleared.

The browser downloads static model files from the documented model host. That
host sees an ordinary asset request and does not receive an image or image
metadata. BG0 may collect coarse product events such as a removal completing,
but those events must not contain filenames, dimensions, sizes, URLs, pixels, or
other information about the image.

## Model cache

On HTTPS, Transformers.js uses the browser Cache API. Development origins that
cannot use Cache Storage fall back to BG0's IndexedDB adapter. Calls in the same
page reuse an initialized engine. A reload can reuse stored model files but must
still initialize ONNX and upload weights to WebGPU. Browser storage eviction,
private browsing, or clearing site data can require another download.

## Deployment

- `apps/web`: deployed as the BG0 product site.
- `apps/docs`: built as static assets under `/docs`.
- `packages/browser`: bundled into the web app and publishable as
  `@bg0/browser`.

The deployed application needs no secret environment variables and performs no
server-side image processing. Production builds can use a PostHog personal API
key to upload private source maps; that build-only credential is never included
in the application bundle or runtime.
