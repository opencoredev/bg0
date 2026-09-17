# BG0 architecture

BG0 has one image path. It runs entirely inside the browser.

```text
file picker / drop / paste
            ↓
      @bg0/browser
            ↓
hardware-selected BiRefNet ONNX model
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

PostHog survey submissions are restricted in code to the result-quality rating
choices and predefined failure reasons. Survey configuration must not add free
text or response choices outside that allowlist. Exception reports use
controlled error categories and only same-origin JavaScript source locations;
arbitrary exception messages and stack text stay in the browser.

## Automatic model selection

`@bg0/browser` probes an actual WebGPU adapter before choosing which model to
attempt first. Chromium browsers reporting fp16 shaders, a 256 MiB buffer limit,
a 128 MiB storage binding limit, and no RAM hint below 4 GiB attempt full BiRefNet.
Missing RAM hints do not exclude a device. These are selection heuristics, not
verified compatibility claims. The full Swin-L model uses a patched 512px
export; the lite Swin-T export also takes
512px input. Both weights and processor configurations are pinned by revision.

Browsers reporting low memory attempt lite on WebGPU. Without an eligible fp16 GPU,
browsers reporting at least four logical CPU cores and no RAM hint below 4 GiB
attempt full BiRefNet on WASM; iOS and smaller or unknown CPU counts select lite.
A full-model loading or inference failure falls back to lite on the same
provider, then lite on WASM if necessary.
Failed full-model and GPU engines are skipped for the page session and disposed
after pending preparation and removal calls release them, including refinement.
A full-model failure does not disable lite WebGPU.
The existing `quality` option controls mask refinement independently of model
selection. Detection and fallback stay inside the browser package.

Local verification exercised full and lite models on WebGPU and WASM with an
Apple M4 Max, 64 GiB RAM, macOS, and Chrome for Testing 153. Low-memory and
CPU-only selection used simulated hints on that Mac. Other physical devices,
Safari, Firefox, and the deployed origin remain unverified for this change.

Transformers.js 4 ran the full export's GPU operators in that environment;
3.8.1 failed the full 512px graph, and the unpatched 1024px full export exceeded
the tested adapter's shader binding limits despite sufficient RAM.

### iOS memory-constrained inference

On iPhone/iPad (including desktop-mode iPad), the browser package uses a dedicated
single-threaded plain-WASM worker and a portable 512px quantized BiRefNet-lite
export. Desktop/Android model and provider selection are unchanged. No selector,
server inference, or image upload is introduced. See `docs/ios-model.md` for model
provenance, reproduction, measurement limits, and the temporary review asset host.

The optimized graph replaces deformable-convolution expansion with sequential
per-tap GridSample operations, deduplicates weights, and uses dynamic uint8
Conv/MatMul quantization. Its weights derive from the official BiRefNet-lite
checkpoint, not a different network family. Quantization can change results.

Before loading, reduce the decoded photo to 512px pixels and release its bitmap.
iOS skips eager warming/full-photo processing previews. After inference, exports
and the Compare source are capped at 1280px longest-edge (disclosed by the UI).
The quality option retains the optional focused refinement pass. This cap is a
reviewable memory/quality tradeoff, not a claim of original-resolution export.

Calls are serialized; repeated calls reuse the worker. Abort terminates it and
settles pending requests. Cache reset defers retirement until active work ends.
Buffers are transferred rather than cloned. Model-load failures are retryable;
no fallback to the known memory-heavy iPhone model is attempted. The worker does
not bypass Safari's per-tab memory budget.

PNG compositing uses one output canvas, releasing temporary mask/output buffers
after encoding (including failure paths). This allocation improvement is shared
with desktop/Android; pixel equivalence is covered separately.

Contributor confirmed both experimental variants on an iPhone 13, including a
camera portrait with visually comparable hair to desktop. Integrated UI still
requires its own physical-device test; iPad/other iPhones are unverified.

## Model cache

Desktop/Android: on HTTPS, Transformers.js uses the browser Cache API. Development origins that
cannot use Cache Storage fall back to BG0's IndexedDB adapter. Calls in the same
page reuse an initialized engine. A reload can reuse stored model files but must
still initialize ONNX and upload weights to WebGPU. Browser storage eviction,
private browsing, or clearing site data can require another download.

iOS uses same-origin build-emitted, content-hashed assets and the normal HTTP
cache; cache eviction/private browsing can require a fresh download. Reloading
still initializes the worker. No photo or mask is persisted.

## Deployment

- `apps/web`: deployed as the BG0 product site.
- `apps/docs`: built as static assets under `/docs`.
- `packages/browser`: bundled into the web app and publishable as
  `@bg0/browser`.

The deployed application needs no secret environment variables and performs no
server-side image processing. Production builds can use a PostHog personal API
key to upload private source maps; that build-only credential is never included
in the application bundle or runtime.
