# iOS BiRefNet-lite candidate

## Scope and device evidence

Same BiRefNet-lite family, 512px model input; optimized graph + uint8 weights,
not U2Netp. No desktop/Android model-selection change. Normal UI and quality
refinement preserved. iOS output/Compare sources capped at 1280px to retain the
experiment's memory safeguard; this is a product tradeoff requiring review.

On a physical iPhone 13, the contributor reports both the 384px and 512px
experimental pages work. A real camera portrait processed successfully; their
same-photo comparison looked about as good as desktop (subjective, not a claim
of better accuracy). The integrated UI also completed the cat, portrait, and
synthetic 4032×3024 fixtures on that iPhone 13. Original downloaded RGBA PNGs
were verified at 768×512, 512×512, and 1280×960 with alpha transparency.
The exact five-run/no-refresh sequence and refinement interactions were not
separately confirmed. iPad, newer iPhones, native HEIC and large batches remain
unverified.

Desktop Chrome isolated renderer RSS, indicative single runs (NOT Safari RAM):
original 2.4–2.7 GiB; optimized 512px worker about 1.24 GiB. Mask foreground IoU
against the original on two public fixtures: cat 99.647%, NASA portrait 99.964%.
Agreement with the original is not segmentation accuracy or a broad benchmark.

## Assets and hosting: maintainer decision before merge

`packages/browser/vendor/ios/manifest.json` pins the model/runtime SHA-256 hashes,
byte sizes, source checkpoint, and licenses. `copy-ios-assets.ts` verifies every
binary before packaging it. Generated binaries are ignored by Git; build output
contains same-origin static assets, not a runtime dependency on the review host.
The script can acquire missing assets from the contributor's HTTPS preview.
**This is temporary review infrastructure. Choose maintainer-owned immutable
hosting before merging/publishing.** A build with missing or changed artifacts
fails checksum validation rather than shipping different weights silently.

The WASM factory, binary, and JS runtime must remain version-matched. Do not
substitute Asyncify/JSEP or enable borrowed initializer memory: the Web binding
frees the model buffer after session creation. Initializer borrowing produced
corrupt outputs in testing; it is explicitly disabled.

## Reproduce the selected model (offline build; not a browser requirement)

Scripts live in `tools/ios-model`. Use isolated Python environments. Reviewed
source snapshot is pinned to ZhengPeng7/BiRefNet_lite revision
`7838f1c3472f827cd8ce13ab5ccc2ce48077360f`; model.safetensors SHA-256:
`4417d89795250e698c3cb0ae8df15743810065f646f48a694fdfa7ca052d0815`.

1. Download that snapshot's `model.safetensors`, `birefnet.py`,
   `BiRefNet_config.py`, and `config.json` into `tools/ios-model/source-checkpoint`.
   Verify the safetensors checksum; review the Python source before loading it.
   Set `bb_pretrained: false` in local config.json to avoid a redundant backbone
   download; all learned weights are loaded from the safetensors checkpoint.
2. Install `requirements-export.txt` in Python 3.13. Run:
   `python tools/ios-model/export.py --size 512 --out tools/ios-model/grid-512-fp32.onnx`.
   The exporter compares the sequential deformable operation and logits against
   torchvision/reference before folding static operations and deduplicating.
3. In a separate Python 3.9 environment using `requirements-quantize.txt`, run
   `python tools/ios-model/quantize.py`. This writes the quantized ONNX and
   portable ORT artifact to an ignored `tools/ios-model/output` directory.
4. Re-run browser output comparisons before accepting regenerated artifacts.
   Conversion/library versions can affect bytes and floating-point results;
   hashes in the manifest identify the tested artifacts, not a guarantee of
   bit-identical conversion on arbitrary systems. Never update hashes blindly.

Exporter adapted from CoderViking's BiRefNet-lite GridSample export:
https://huggingface.co/CoderViking/birefnet-lite-onnx/blob/main/export_birefnet_lite.py
Upstream model: https://github.com/ZhengPeng7/BiRefNet (MIT).
ONNX Runtime: MIT, accompanying third-party notices included.

## Suggested physical validation

Open the integrated preview, select a photo normally (no separate load button),
check Compare/Original/Result and Download PNG. Repeat 3–5 photos without reload,
including a camera photo. Compare the *same input* against bg0.dev on desktop;
inspect hair, transparent gaps and edges, not just the page thumbnail. Check
cancellation/retry and record the phone/iOS version and processing stage if a
reload occurs. No user photos should be committed or uploaded without consent.
