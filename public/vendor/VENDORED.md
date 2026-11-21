# Vendored browser libraries

Copied verbatim from npm — do not edit. Each keeps its own licence alongside it.
Served by AirScribe itself, so the page needs no CDN, as WifiDB does it (WifiDB's
`lib/js/VENDORED.md`).

| directory | package | version | files |
|---|---|---|---|
| `maplibre-gl/` | `maplibre-gl` | 6.16.0 | `dist/maplibre-gl.mjs`, `dist/maplibre-gl-worker.mjs`, `dist/maplibre-gl.css`, `LICENSE.txt` |
| `qrcode-generator/` | `qrcode-generator` | 2.0.4 | `dist/qrcode.mjs` (MIT; the licence is in its header) |

The same 6.16.0 that WifiDB's map uses with the tiles.wifidb.net styles.

SHA-256, as published:

    fbbdf8ddd9a48e49059a4be6795a4f214a711314bb5809f72d3730b48e7897e3  maplibre-gl.mjs
    0bf06492bdb7ba3d4132b78e435621bfba60d5250967991c02b1a73affea8cd5  maplibre-gl-worker.mjs
    a90798a1953017790e590f7e1bd35ff103a8a4263972cb47290b78adf86f8c20  maplibre-gl.css
    ea91d7118a5395289170da848b7c6758b996163bfbccf312591ab65a4911b7c0  qrcode.mjs

## Why ESM, and why an import map

maplibre-gl 6 has no UMD build: `dist/` is `.mjs` only, so there is no
`maplibregl` global, and `public/map.js` imports it as a module. The import map
in `index.html` maps the bare name `maplibre-gl` to the file here, which keeps
the copy byte-identical rather than rewritten. `map.js` imports it only when the
Map view is first opened, so the other views never load it.

`maplibre-gl.mjs` loads `maplibre-gl-worker.mjs` by relative path at runtime, so
the two have to stay in the same directory. Served from AirScribe's own origin,
the worker is allowed; from a CDN it would not be.

`.gitattributes` marks this directory `-text`, so no line-ending conversion ever
touches these files.

## Refreshing

    npm pack maplibre-gl@6.x.y

then copy the files named above out of the tarball's `package/`, update the
version and checksums here, and check the import map in `index.html` still names
the entry file.

## qrcode-generator

Draws the QR code an authenticator app scans when two-step verification is set
up (`public/twostep.js`, docs/two-step.md). It's drawn in the page, so the
secret in the code never goes to an image service. Imported only when that QR
code is shown.
