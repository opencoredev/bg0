# Third-party notices

## BiRefNet-lite browser model

BG0 downloads the pinned `studioludens/birefnet-lite-512` ONNX model in the
browser. The export and its upstream `ZhengPeng7/BiRefNet_lite` model are marked
MIT licensed. Source, model card, attribution, limitations, and citation:

- https://huggingface.co/studioludens/birefnet-lite-512
- https://github.com/ZhengPeng7/BiRefNet

The model weights are not included in this repository. Their original license
continues to apply when a browser downloads and caches them.

## heic-to 1.5.2

BG0 ships a minimally modified `heic-to` 1.5.2 browser module as a standalone
runtime asset. The modification selects a collection's primary image instead
of relying on libheif's top-level image ordering. `@bg0/browser` loads the
module through its public ES module interface only when a browser needs the
HEIC/HEIF fallback. The standalone module can be replaced with a compatible
modified build without rebuilding `@bg0/browser`.

`heic-to` and its bundled libheif 1.22.2 and libde265 1.0.16 decoder components
are licensed under LGPL-3.0-or-later. The LGPL terms and incorporated GNU GPLv3
terms accompany both the npm package and web distribution.

Exact corresponding source archives are included in this repository under
`third_party/heic-to/source/`, copied into the npm package under
`dist/vendor/source/`, and deployed on the website under
`/third-party/source/`:

- `heic-to-1.5.2.tgz` (SHA-256 `a301b46a2e5a2a050c44d7c1655d63b4c17415312ebcfa82920e950baffc5a7f`)
- `libheif-1.22.2.tar.gz` (SHA-256 `af30a8b32dfbc1dc86a7f0f55a53107dad35010a65ebf1feb468082e402b11e0`)
- `libde265-1.0.16.tar.gz` (SHA-256 `ed12c931759c1575848832f70db5071a001ac813db4e4f568ee08aef6e234d4e`)

The same directories include `heic-to-primary.patch`, `guarded-transform.ts`,
and `BUILD.md`, which document the source modification and reproduce the exact
production artifact from the pinned upstream distribution file.

Runtime dependencies retain the licenses declared by their respective packages.
