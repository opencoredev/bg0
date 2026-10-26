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

The removal success event includes a coarse duration bucket (`<5s`, `5-15s`,
`15-30s`, `30-60s`, `>60s`) measured from choosing the image to the result. It
does not report exact timings, which could hint at image size.

PostHog survey answers are restricted in code to an allowlist of choices and
0–10 scores. Answers outside it cause the whole survey event to be dropped, and
this applies to sent, dismissed, and abandoned events. The only free text is
the result survey's optional "Anything else we should know?" answer, which
appears only after a poor rating. Before sending it, BG0 trims it, caps it at
500 characters, and replaces email addresses, links, `blob:` and `data:` URIs,
image filenames and dimensions, and long numbers such as phone numbers with
placeholders. Text is accepted only
under that question's ID in the survey set in
`apps/web/src/lib/survey-config.ts`; text on any other answer drops the event.
The "What was in the image?" question is a category the visitor picks. BG0
never derives it from the image. The `$survey_questions` snapshot and other
unrecognized `$survey_*` properties are removed. Survey configuration must not
add open-text choices or questions outside this design. Exception reports use
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

Every load failure walks the same list: full to lite, then WebGPU to WASM. A
download that stops sending bytes for 30 seconds, a short body, or a network
error marks that model file unreachable for the page and moves on without
disabling WebGPU. A cached model that ONNX cannot parse is evicted before the
next attempt. A GPU adapter that does not answer within 5 seconds counts as no
GPU. If loading goes 150 seconds with nothing downloading and no progress,
for example while a model starts, it stops with a retryable error instead of
trying a heavier fallback on a struggling device. Both limits are idle limits:
a slow download that keeps delivering bytes is never cut off.

A tab killed by the browser while the full model starts or runs leaves a marker
in sessionStorage. The next attempt in that tab skips the full model, and the
device keeps using lite for a week. Clearing the model cache removes the block.

BG0 patches the ONNX backend of the pinned Transformers.js release so one
failed session creation or inference no longer rejects every later one in the
page. The patch applies to this repository's builds; consumers installing
`@bg0/browser` from npm do not get it.
The existing `quality` option controls mask refinement independently of model
selection. Detection and fallback stay inside the browser package.

A `model` option (`auto`, `lite`, `full`) pins the weights before the walk
starts. `lite` drops the full model from the list; `full` puts it first even
where detection declined it, on WebGPU when detection found a usable fp16 GPU,
and keeps lite as the fallback. Session failures and the full-model block still
apply. When the latest call asks for lite, a full-model download no call waits
on is aborted rather than finishing in the background, and a loaded full
session no call holds is released. The web app saves the
choice in localStorage under `bg0:model-tier`, accepts `?model=` for one visit,
and offers Lite while the full model downloads.

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

The photo is decoded once. That decode yields the 512px model input and a copy
bounded to the export size, and the full-resolution bitmap is closed before the
model loads; finishing never decodes the photo again. iOS skips eager warming/full-photo processing previews. After inference, exports
and the Compare source are capped at 1280px longest-edge (disclosed by the UI).
The quality option retains the optional focused refinement pass. This cap is a
reviewable memory/quality tradeoff, not a claim of original-resolution export.

Calls are serialized. Queued calls reuse the worker; when nothing is queued after
inference, the worker is terminated before PNG encoding, because its WASM heap
never shrinks. The next photo starts a new worker from the HTTP-cached files.
The model streams into one buffer of its known size. Worker requests have a
watchdog (load: no progress for 90 s; inference: 120 s) that terminates the
worker and returns a retryable error, and allocation failures are reported as
out-of-memory. Abort terminates the worker and settles pending requests. Decode
and PNG encode run outside the worker, so abort abandons them instead: the call
settles at once so a retry is not queued behind a hung stage, and a late bitmap
is closed when it arrives. Cache reset defers retirement until active work ends.
Buffers are transferred rather than cloned. Model-load failures are retryable;
no fallback to the known memory-heavy iPhone model is attempted. The worker does
not bypass Safari's per-tab memory budget.

When Safari exceeds that budget it kills the page and reloads it, so no failure
event can be sent. The remover keeps a sessionStorage marker during each run
that holds only the stage, the provider, the start time, and a random run id.
The provider is `unknown` until `@bg0/browser` reports the one it chose in a
progress event, and goes back to `unknown` when a fallback engine starts
loading. Browsers copy sessionStorage into duplicated tabs and tabs
opened from this one, so each run also holds a Web Lock named after its id
until the marker clears. A page that dies releases its locks. A marker found on
the next load within 10 minutes produces one anonymous
`background_removal_interrupted` event with only `stage` and `provider`, and an
explanation for the user. Success, failure, cancel, reset, unmount, and
`pagehide` clear it. A marker whose lock another tab still holds is a copy of
that tab's live run, so it is removed from this tab and not reported. Without the Web Locks API every fresh marker is
reported, as before. A run with no progress for 5 minutes on any platform
becomes a retryable error.

PNG compositing uses one output canvas, releasing temporary mask/output buffers
after encoding (including failure paths). This allocation improvement is shared
with desktop/Android; pixel equivalence is covered separately.

Contributor confirmed both experimental variants on an iPhone 13, including a
camera portrait with visually comparable hair to desktop. The integrated UI
also completed all three supplied fixtures on a physical iPhone 13, including a
synthetic 4032×3024 image. Downloaded RGBA PNG dimensions and transparency were
verified. The exact five-run/no-refresh sequence and refinement interactions
were not separately confirmed; iPad/other iPhones remain unverified.

## Model cache

Desktop/Android: on HTTPS, Transformers.js uses the browser Cache API. Development origins that
cannot use Cache Storage fall back to BG0's IndexedDB adapter. Cache writes run
in the background and a failed write never fails the load. A cached model whose
size does not match the pinned file is deleted and downloaded again. Calls in the same
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
