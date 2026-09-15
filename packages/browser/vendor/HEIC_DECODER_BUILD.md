# HEIC decoder build materials

`heic-to-1.5.2.tgz` is the exact upstream npm source archive.

BG0's production artifact is generated deterministically from the pinned
upstream `dist/heic-to.js`, not from a fresh source compilation. The package
build verifies the upstream SHA-256, applies one guarded string transformation
that changes `data[0]` to primary-item selection, verifies the resulting
SHA-256, and emits it as a replaceable standalone ES module. The expected
hashes and transformation are included here as `guarded-transform.ts`. From
this directory, the exact production artifact is reproduced by:

```sh
mkdir heic-to-source
tar -xzf heic-to-1.5.2.tgz -C heic-to-source
bun guarded-transform.ts heic-to-source/package/dist/heic-to.js heic-to.js
```

`heic-to-primary.patch` is the corresponding source-level change. To inspect
or build the equivalent source modification:

```sh
(cd heic-to-source && patch -p0 < ../heic-to-primary.patch)
(cd heic-to-source/package && npm install && npm run build)
```

Because upstream declares a range for esbuild, a fresh source compilation is
not claimed to be byte-identical to BG0's guarded transformation of the pinned
upstream distribution artifact.

The only source change makes the decoder select the HEIF primary image rather
than relying on the order of top-level image IDs returned by libheif.
