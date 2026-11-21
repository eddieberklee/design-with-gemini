# Cells 11–13 — Image → 3D (6-Model Arena) (`cells/image-to-3d/`)

Drop, paste or pick an image, press **Run 6×**, and six Gemini models each reconstruct it as a
3D primitive mesh, rendered in a 3×2 grid of interactive viewports with each model's name.

`index.html` mounts the cell three times (`#cell-image-to-3d`, `#cell-image-to-3d-2`,
`#cell-image-to-3d-3`, `data-cell-index` 11 / 12 / 13), each spanning two grid columns
(`image-to-3d.css` `.cell--image-to-3d { grid-column: span 2 }`). All three start from the same
`Client.DEFAULT_MODELS` line-up (Gemini 4 Hydrogen, Argon, Carbon, Neon, 3.1 Pro Preview, 3.1
Flash Lite); only the index differs.

## Architecture

- **`renderer.js`** (`window.GeminiImageTo3D.Renderer`): Canvas 2D software renderer (no WebGL,
  so no context cap): perspective projection, key + fill shading, painter's sort, pointer drag to
  orbit, pinch / Ctrl+wheel zoom, auto-turntable, `.OBJ` export. Tessellates `box`, `sphere`,
  `cylinder`, `cone`, `pyramid`, `torus` and normalises the bounding box.
- **`client.js`** (`window.GeminiImageTo3D.Client`): `KeyStore` (delegates to
  `GeminiApiMatrix.KeyStore`), `discoverModels` (`GET /v1beta/models`), `pickSixModels`,
  `parse3DSceneFromText`, `generate3DForModel` (structured-JSON `generateContent`).
- **`ui.js`**: `initAllImageTo3DCells` mounts every `.cell--image-to-3d`; each mount
  (`mountImageTo3DCell`) has its own closure state (image, run, ticker, slots). No element ids,
  no `document`-level queries for tile parts.

## UI (shared `ui/` system)

- **Header**: index (`data-cell-index`) · "Image → 3D" · status pill (`.i3d-key-btn`, opens the
  key bar) · Sync (`aria-pressed`) · 6-Up. Pill states from `ui.js` `PILL` / `refreshKeyState`:
  `No key` and `Key set` grey; `Running` and `Error` (no model returned a mesh) rust; `Done` green
  only after at least one mesh came back. Each state sets its own `data-tip` and `aria-label`.
  No header line-up: all three tiles start with the same models and each well already names its
  model, so a line-up only repeated it and squeezed the title at 900 / 390 px.
- **Hero**: six light wells (`--ui-well`, the canvas stage reads `--ui-well` / `--ui-surface` once
  via `renderer.js` `getPalette`) with a faint ground shadow. Light rather than a dark stage: the
  model colours (dark bases, metal greys) read better on the well, and three tiles of black
  panels read as a wall. Model select (short name, full id in its tip) and state readout are laid
  over the top of each well (`.i3d-slot-head`, zero height). `.i3d-slot[data-state]`: `waiting`,
  `running` (rust edge + elapsed seconds, no spinner), `done` (`3.2s · 7p`, tip has the mesh
  title), `failed` (rust readout, reason on the well), `stopped`. OBJ download appears on done
  (hidden in wells under 160 px; always in the 6-Up dialog).
- **Intake bar** (`.i3d-bar`, 30 px, replaces the footer): image chip (`.i3d-dropbar`, dashed
  until an image is in), status, and the one black primary Run 6× (rust "Stop" while running via
  `aria-pressed`; `aria-disabled` with a tip until an image is in).
- **6-Up dialog**: `ui-studio-bar` with index, title, Re-run, Close (Esc) last; the six wells
  large, with the mesh title captioned.
- **Size steps**: below 768 px page width the tile is 4:3 (8:3 left 24 px wells on a phone);
  < 320 px tile hides the status; < 240 px hides the bar and the readouts. Checked with no overflow
  at 1600 / 900 / 390 px and with the Motion size slider at both ends.
- **Tooltips** (`data-tip`): pill (per state), Sync (per state), 6-Up, Run / Re-run (per state,
  names the six paid requests), each model select (full id), each readout (per state), OBJ, the
  well (orbit / zoom), image chip, Remember, Save (`Enter`), Clear, Close (`Esc`).

## Invariants (cost and safety)

- **Only a click on Run 6× (or Re-run 6× in the 6-Up dialog) sends requests**: six
  `generateContent` POSTs for that one tile. Loading an image (drop, paste, picker), saving or
  clearing the key, `gemini-key-changed` / `storage` sync, model changes and page load send
  nothing.
- **Model discovery** (`ui.js` `discoverModelsOnce`): the `GET /models` call runs only inside a
  Run click, once per key for the whole page (shared by the three tiles), not awaited, bounded by
  `DISCOVERY_TIMEOUT_MS`. It only adds dropdown options (`mergeDiscovered`); it never changes the
  model a slot is set to, so what is on screen at click time is what gets billed.
  `pickSixModels` is no longer applied automatically. Before any discovery the dropdowns offer
  `DEFAULT_MODELS`.
- **Run lifecycle** (`runAllFour`, `cancelRun`): one `activeRun` per tile. Stop aborts and paints
  unfinished slots "Cancelled"; a stopped or replaced run's late results, errors and `finally`
  are ignored, so it cannot end or overwrite the run after it. Model selects are disabled while
  running. A new image during a run stops the run ("Stopped: image changed").
- **Image input** (`handleImageFile`): non-images and files over 40 MB are refused with a status
  message; a newer image wins over an older one still being read (`imageSeq`). Paste is handled
  on the tile root, so it reaches only the tile that has focus.
- **Key**: `client.js` `KeyStore.get` returns the API Matrix answer, including `''` after a
  clear elsewhere, and survives storage that throws. The key is never written into the input
  (the placeholder shows `KeyStore.mask`), never in a URL, attribute or console; it travels only
  in the `x-goog-api-key` header. A key with spaces or non-ASCII is refused before any request
  (`isHeaderSafeKey`). Empty Save does nothing; Clear removes the key for every tile.
- **Renderer cost** (`createViewer`): draws on demand. The frame loop runs only while a mesh is
  auto-spinning in a canvas that is on screen (IntersectionObserver) in a visible tab; a
  ResizeObserver redraws the 6-Up canvases when the dialog opens; one shared
  `visibilitychange` listener resumes spinning viewers. Measured: 0 live loops with no results or
  scrolled away; 1 per spinning result in view. Backing store is integer-sized (no realloc per
  frame at fractional DPR). A plain wheel scrolls the page; zoom needs pinch or Ctrl/Cmd.
- **Untrusted model output**: `JSON.parse` only; parts with non-finite or |value| > 1000
  coordinates are dropped, at most 64 parts, colours must be hex, titles go in via
  `textContent`.
- **Sync** mirrors camera moves across the twelve viewers (tile + 6-Up) of its own tile only.

## How to verify

```sh
bash scripts/check.sh
timeout 120 node --test "cells/image-to-3d/*.test.*"
```

`ui.test.js` loads `renderer.js` + `client.js` + `ui.js` in a `vm` with a fake DOM, three tiles
and a counting `fetch`: no request on mount, key sync or image load; one Run = six POSTs in one
tile; Stop + Run race; Enter on Run; key never prefilled; empty Save; render loop stops off
screen / hidden; wheel; DPR. `client.test.js` covers KeyStore delegation, parsing and models.

In the browser without a key: stub `window.fetch` before load to count requests, drop / paste a
generated PNG on one tile and check the other two do not change; with a stub key, return canned
`{candidates:[{content:{parts:[{text: JSON}]}}]}` bodies, HTTP errors and hanging promises.
