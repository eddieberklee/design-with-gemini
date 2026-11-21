# Cell 10 — Gemini Image Gen and Cell 14 — Virtual Try-On (`cells/image-gen/`)

One script mounts every `.cell--image-gen` section: `#cell-image-gen` (tile 10, prompt + optional reference image) and `#cell-image-tryon` (`data-cell-index="14"`, `data-mode="try-on"`: person photo + product photo + a fixed prompt). Each mount has its own closure state; nothing is shared between the two tiles except `GeminiImageGen` (stateless apart from the shared key store). Interactive tile for testing Google's native Gemini image generation API (**Nano Banana Pro** / `gemini-3-pro-image-preview`, **Nano Banana 2** / `gemini-3.1-flash-image-preview`, and `gemini-2.5-flash-image`) via `POST /v1beta/models/{model}:generateContent`.

## Architecture

- **`client.js`** (`window.GeminiImageGen`):
  - **Shared KeyStore** (`KeyStore`): when `GeminiApiMatrix.KeyStore` (`cells/api-matrix/probes.js`) is loaded it is the source of truth for `get`/`set`/`clear`, including `''` after another cell cleared the key. The cell keeps no private copy that could outlive a clear elsewhere. Without API Matrix it reads/writes `dc_gemini_api_key_session` / `dc_gemini_api_key_local` itself and keeps a memory-only key only when storage writes fail. `KeyStore.mask` is the only form of the key that reaches the DOM (the key input placeholder).
  - **Model Discovery & Ranking** (`discoverImageModels`, `rankImageModels`): `GET /v1beta/models?pageSize=200`, filtered to Gemini native image models supporting `generateContent`, ranked `gemini-3-pro-image*` → `gemini-3.1-flash-image*` → `gemini-nano-banana*` → `gemini-2.5-flash-image*`.
  - **Generation** (`generateImage`): sends `responseModalities: ['TEXT', 'IMAGE']` + `imageConfig: { aspectRatio }`, retrying once without `imageConfig` if a model rejects it with HTTP 400. The key travels only in the `x-goog-api-key` header; a key with characters that cannot be a header value is rejected before `fetch` (`isHeaderSafeKey`). Returns the image as one decoded `Blob` (`decodeBase64Image`); malformed base64 is an error, not a broken image. `parseGenerateResponse` prefers a non-`thought` image part and ignores non-image inline data.
  - **`createRunSlot`**: one in-flight request. A cancelled or replaced run cannot clean up or render over the run that replaced it.
- **`ui.js`**: `mountImageGenCell(root, index)` per section, `ui/base.css` `.ui-tile` anatomy.
  - **Reference images** (`readImageFile`): checked by `client.js` `checkReferenceFile` (must be `image/*`, at most 20 MB; the message is shown on the stage), read through a short-lived object URL (revoked on load/error), drawn on a white canvas (transparent PNGs stay white, not black) at most 1024 px, sent as JPEG base64 `inlineData` parts before the text. Only the base64 (in memory) and a 256 px thumbnail data URL are kept; clearing a slot drops both. `createLatestGuard` makes the latest pick win over a slower earlier read and drops a read still pending when the slot is cleared.
  - Tile 10: "+ Ref" picks one reference (also drop on the stage or paste an image into the prompt); while attached the button shows its thumbnail and a click removes it. Tile 14: two slots (click, drop, or paste while focused); Try On needs both and names the missing one.
- **`image-gen.css`**: scoped `.cell--image-gen` / `.ig-*` styles on `--ui-*` tokens only. `.cell--image-gen [hidden]` hides every part toggled with `hidden`.

## UI (shared `ui/` system)

- **Header**: index · title · status pill (`.ig-key-btn`, opens the key bar) · model select (`.ui-hide-compact`). Pill (`PILL` / `renderPill`), one vocabulary with the other Gemini tiles: `No key` and `Key set` grey; `Running` and `Error` rust; `Live` green only after an image came back and decoded (shown uppercase). Each state sets its own `data-tip` and `aria-label`; the label width is reserved above the tiny step.
- **Hero, tile 10** (`.ig-stage`): empty = a white sheet (`.ig-frame`) in the selected aspect ratio (`--ig-ar`, `syncAspectFrame`) with its ratio in the corner, a hint and the example chips inside it (what fits is decided by the sheet's own size, `ig-sheet` container). Loading = rust sheet border and the elapsed seconds as the hero readout. Error = rust note at the stage bottom; the previous image stays. Result = the image on the well.
- **Hero, tile 14** (`.ig-tryon`): Person + Product slots stacked on the left, → the result stage on the right (same sheet/loading/error/result states). A filled slot shows the photo with its file name on a strip and a remove button; what a slot shows is decided by its own size (`ig-slot` container).
- **Composer**: tile 10 `+ Ref`, prompt, aspect, black Generate; tile 14 "Fixed prompt" label (tip summarises the built-in prompt), aspect, black Try On. The primary turns rust "Cancel" while running.
- **Footer**: last result (seconds, pixel size, model), View and Download. **Lightbox**: `ui-studio-bar` with the index, title, Download, Close (Esc); per-tile heading id `ig-dialog-title-<index>`.
- **Size steps**: < 320 px tile hides the footer and both selects; < 240 px hides the composer (header + hero only). Measured with no overflow at page widths 360–1920, all four ratios, key bar open and closed, slots empty and filled.
- **Tooltips** (`data-tip`): pill (per state), model, aspect, Generate (`Enter`) / Try On, each chip, + Ref (per state), each slot, remove photo, Fixed prompt, Remember, Save (`Enter`), Clear, View, the result image, Close (`Esc`).

## Invariants (cost and safety)

- **Only an explicit Generate / Try On (button click, or Enter in the tile-10 prompt) sends a request**, and only from the tile clicked. Nothing runs on load (0 requests from either tile with a key present), on Save, on `gemini-key-changed` / `storage` sync, on picking a reference, or on a chip click (chips only fill the prompt). Model discovery runs from `ui.js` `discoverModelsOnce`, inside `runGeneration`, once per key per tile, not awaited. `populateModels` keeps the selected model even if a refreshed list lacks it, so a list refresh never changes what the next paid click uses.
- **Key**: never prefilled into the input, never in a URL, attribute or the console. Saving an empty input does nothing (Clear removes the key for every cell). Save/Escape close the bar and return focus to the Key pill.
- **Image**: one object URL per result shared by the tile image, the lightbox and both download links; the previous one is revoked when a new result is shown. The image is decoded off-screen (`loadImage`) before it replaces the previous one; a decode failure is shown as an error and the previous image stays.
- **Ticker**: the 100 ms elapsed-seconds interval (`startTicker` / `stopTicker`) runs only while a request is in flight and the tab is visible; `visibilitychange` stops and resumes it. The request itself has no client timeout; Cancel aborts it.
- Clearing the error banner outside a run (`showError('')`, e.g. on Save or a new reference) returns the pill from `Error` to idle.
- The tile image is `role="button"` `tabindex="0"` (Enter/Space opens the lightbox), because the footer View button hides on compact tiles.
- `.cell--image-gen [hidden]` must stay `display: none !important` (classes set `display`, which would otherwise show dead View/Download buttons before the first image).
- Enter on a slot's remove button removes the photo; it does not open the file picker (`wireRefSpot` ignores keydown from children). A file dropped on the tile-14 result area is ignored instead of replacing the page.

## How to Verify

```sh
bash scripts/check.sh
timeout 120 node --test "cells/image-gen/*.test.*"
```

`client.test.js` loads `client.js` (and, for the key tests, `cells/api-matrix/audio.js` + `probes.js`) in a `vm` sandbox with stub storage and `fetch`. `ui.js` needs a DOM, so its wiring rules (no discovery outside Generate, chips do not generate, run slot, revoked URLs, no key prefill, reference-file checks) are pinned by static checks on its source; behaviour is checked in the browser.

In the browser (`index.html`), without a key: Generate opens the key bar; with a key, stub `fetch` to check loading, Cancel, a second Generate while one is in flight, success, safety block and malformed payloads. With a real key:
1. Open the **Key** pill (or reuse an existing key from Cell 01/04), paste a Gemini API key, and click **Save**.
2. Click a preset chip (fills the prompt) or type a prompt, then press **Enter** / **Generate**. In tile 14, add a person and a product photo and press **Try On**.
3. Confirm the image renders in the stage, latency + natural dimensions appear in the footer, and clicking the image opens the lightbox with a working **Download**.
