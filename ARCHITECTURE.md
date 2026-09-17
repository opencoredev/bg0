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
attempt first. Non-mobile Chromium browsers reporting fp16 shaders, a 256 MiB buffer limit,
a 128 MiB storage binding limit, and no RAM hint below 4 GiB attempt full BiRefNet.
Missing RAM hints do not exclude a desktop. Android, iOS, and desktop-mode iPad
use lite even when their system RAM and GPU buffer hints look desktop-sized.
Those hints do not measure a mobile tab's memory budget; a killed tab cannot
recover through the exception-based fallback. These are selection heuristics, not
verified compatibility claims. The full Swin-L model uses a patched 512px
export; the lite Swin-T export also takes
512px input. Both weights and processor configurations are pinned by revision.

Browsers reporting low memory attempt lite on WebGPU. Without an eligible fp16 GPU,
browsers reporting at least four logical CPU cores and no RAM hint below 4 GiB
attempt full BiRefNet on WASM; mobile browsers and smaller or unknown CPU counts select lite.
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

### Mobile image memory

On mobile browsers the site skips eager model warming and omits the original
full-resolution image element during processing. This avoids keeping an extra
preview decode alongside inference. Desktop processing previews and completed
full-resolution exports remain unchanged.

PNG compositing builds the alpha mask in the output canvas, then applies the
photo with `source-in`. Refinement no longer requires a second full-resolution
canvas. Temporary mask buffers are cleared after drawing; output buffers are
cleared after asynchronous PNG encoding settles, including failure paths.

This reduces avoidable allocations, not ONNX activation memory or native image
decoding peaks. A 48 MP source still needs a large bitmap and output canvas.
Physical iPhone Safari reliability remains unverified; keep the warning until
tested on hardware. Chromium mobile emulation is not a Safari memory-limit test.

The first physical iPhone preview reloaded during model loading. As an isolated
compatibility experiment, iPhone and desktop-mode iPad now select the matched
plain ONNX WASM factory and binary instead of the default Asyncify pair. The
asset version comes from the loaded ONNX runtime, and configuration happens
before its first session. One thread and the same fp16 lite model are retained;
Android/desktop runtime settings are unchanged. A related upstream report
(microsoft/onnxruntime#26827) describes Safari resource growth with JSEP builds,
but is not proof of the cause here. The plain runtime may block the UI while
computing; its physical-iPhone memory behavior still requires verification.

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
