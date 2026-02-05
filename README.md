# msdf-tools

CLI for turning fonts or SVG artwork into multi-channel signed distance field (MSDF) atlases ready for WebGL.

## Install

```bash
bun install
```

> If Bun cannot write to the default temp dir, set `TMPDIR=/tmp` before running `bun install`.

## Usage

Both commands share common packing options like `--size`, `--range`, `--max-width`, `--max-height`, `--padding`, `--pot`, and `--rotate`.

### Fonts → MSDF

```bash
bun run index.ts font path/to/font.ttf \\
  --charset ascii               # default; or latin1
  --chars \"ABC123\"             # optional explicit characters
  --charset-file path/to/list.txt # optional file with characters
  --out-dir out/font
```

Outputs `*.png` atlas pages plus a `{basename}.json` metadata file (page info, glyph quads, metrics, distanceRange).

### SVG → MSDF

Wraps the SVG path(s) into a temporary font, then runs the same MSDF pipeline:

```bash
bun run index.ts svg in/vector.svg \\
  --codepoint 57344 \\
  --out-dir out/svg
```

### Example

```bash
bun run index.ts svg in/vector.svg --out-dir out_svg --size 48 --range 8
```

Produces `out_svg/vector_0.png` and `out_svg/vector.json`.

### Default batch mode

Run with no arguments and it will scan `./in` for `.ttf/.otf/.woff/.svg` files and write outputs to `./out` using defaults:

```bash
bun run index.ts
```

## Quick viewer (Three.js)

Open `demo/index.html` in a local server to preview the generated MSDF atlas in WebGL. By default it looks for `../out/vector.json`; change the JSON path and text in the header controls.

Example using Bun’s static file server from repo root:

```bash
bunx serve .
# then open http://localhost:3000/demo/index.html
```

## Output metadata

- `pages[]`: filename and atlas dimensions per page
- `glyphs[]`: `id`, `page`, `x/y`, `width/height`, `xadvance`, `xoffset`, `yoffset`, `rotated`
- `metrics`: raw font metrics as reported by msdfgen
- `distanceRange`: the spread used when generating the MSDF

## Notes

- SVG arcs are converted to cubic curves; unsupported commands will throw.
- The embedded msdfgen wasm is loaded from `node_modules/msdfgen-wasm/wasm/msdfgen.wasm`; override with `--wasm`.
