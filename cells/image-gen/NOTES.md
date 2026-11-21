# Cell 10 — Gemini Image Gen (`cells/image-gen/`)

Interactive tile for testing Google's native Gemini image generation API (**Nano Banana Pro** / `gemini-3-pro-image-preview`, **Nano Banana 2** / `gemini-3.1-flash-image-preview`, and `gemini-2.5-flash-image`) via `POST /v1beta/models/{model}:generateContent`.

## Architecture

- **`client.js`** (`window.GeminiImageGen`):
  - **Shared KeyStore** (`KeyStore`): when `GeminiApiMatrix.KeyStore` (`cells/api-matrix/probes.js`) is loaded it is the source of truth for `get`/`set`/`clear`, including `''` after another cell cleared the key. The cell keeps no private copy that could outlive a clear elsewhere. Without API Matrix it reads/writes `dc_gemini_api_key_session` / `dc_gemini_api_key_local` itself and keeps a memory-only key only when storage writes fail. `KeyStore.mask` is the only form of the key that reaches the DOM (the key input placeholder).
  - **Model Discovery & Ranking** (`discoverImageModels`, `rankImageModels`): `GET /v1beta/models?pageSize=200`, filtered to Gemini native image models supporting `generateContent`, ranked `gemini-3-pro-image*` → `gemini-3.1-flash-image*` → `gemini-nano-banana*` → `gemini-2.5-flash-image*`.
  - **Generation** (`generateImage`): sends `responseModalities: ['TEXT', 'IMAGE']` + `imageConfig: { aspectRatio }`, retrying once without `imageConfig` if a model rejects it with HTTP 400. The key travels only in the `x-goog-api-key` header; a key with characters that cannot be a header value is rejected before `fetch` (`isHeaderSafeKey`). Returns the image as one decoded `Blob` (`decodeBase64Image`); malformed base64 is an error, not a broken image. `parseGenerateResponse` prefers a non-`thought` image part and ignores non-image inline data.
  - **`createRunSlot`**: one in-flight request. A cancelled or replaced run cannot clean up or render over the run that replaced it.
- **`ui.js`**: mounts into `#cell-image-gen` using `ui/base.css` `.ui-tile` anatomy: 4 prompt chips, model and aspect-ratio selectors, inline key bar, live elapsed timer, download link, full-size `<dialog class="ui-dialog">` lightbox.
- **`image-gen.css`**: scoped `.cell--image-gen` / `.ig-*` styles on `--ui-*` tokens only. `.cell--image-gen [hidden]` hides every part toggled with `hidden`.

## UI (shared `ui/` system)

- **Header**: `10` · Image Gen · status pill (`.ig-key-btn`, a button that opens the key bar) · model select (`.ui-hide-compact`). Pill states from `ui.js` `PILL` / `renderPill`: `No key` and `Key set` grey; `Running` and `Error` rust; `Done` green only after an image came back and decoded. Each state sets its own `data-tip` and `aria-label`. The label width is reserved (7ch) above the tiny step so the header never shifts.
- **Hero** (`.ig-stage`): empty = a white sheet (`.ig-frame`) in the selected aspect ratio (`--ig-ar`, set by `syncAspectFrame` on aspect change) with its ratio in the corner, a one-line hint and the example chips inside it. Loading = the sheet border turns rust and the elapsed seconds are the hero readout (no spinner loop); over a previous image the readout sits on a surface veil. Error = rust note along the stage bottom; the previous image stays. Result = the image, contained, on the well.
- **Composer**: prompt, aspect select (`.ui-hide-compact`), the one black primary Generate (turns rust "Cancel" via `aria-pressed` while running; `data-tip` follows the state).
- **Footer**: last result (seconds, pixel size, model), View and Download.
- **Lightbox**: `ui-studio-bar` with `10`, "Generated image", Download, Close (Esc) last; image on the well; prompt in sans and the facts in mono below.
- **Size steps**: < 320 px tile hides the footer and both selects; < 240 px hides the composer too (header + hero only); an open key bar keeps input + Save. What fits inside the empty sheet is decided by the sheet's own size (`.ig-empty` is the `ig-sheet` size container): the hint goes below 220 × 120 px, the chips below the room for their rows; then the sheet shows only its ratio. Measured with no overflow at page widths 360–1920, all four ratios, key bar open and closed.
- **Tooltips** (`data-tip`): pill (per state), model, aspect, Generate (`Enter`), each chip, Remember, Save (`Enter`), Clear, View, the tile image, Close (`Esc`). Plain Download links have none.

## Invariants (cost and safety)

- **Only an explicit Generate submit (button click or Enter in the prompt) sends a request.** Nothing runs on load, on Save, on `gemini-key-changed` / `storage` sync, or on a chip click (chips only fill the prompt). Model discovery runs from `ui.js` `discoverModelsOnce`, inside `runGeneration`, once per key, not awaited. `populateModels` keeps the selected model even if a refreshed list lacks it, so a list refresh never changes what the next paid click uses.
- **Key**: never prefilled into the input, never in a URL, attribute or the console. Saving an empty input does nothing (Clear removes the key for every cell). Save/Escape close the bar and return focus to the Key pill.
- **Image**: one object URL per result shared by the tile image, the lightbox and both download links; the previous one is revoked when a new result is shown. The image is decoded off-screen (`loadImage`) before it replaces the previous one; a decode failure is shown as an error and the previous image stays.
- **Ticker**: the 100 ms elapsed-seconds interval (`startTicker` / `stopTicker`) runs only while a request is in flight and the tab is visible; `visibilitychange` stops and resumes it. The request itself has no client timeout; Cancel aborts it.
- Clearing the error banner outside a run (`showError('')`, e.g. on Save) returns the pill from `Error` to idle.
- The tile image is `role="button"` `tabindex="0"` (Enter/Space opens the lightbox), because the footer View button hides on compact tiles.
- `.ig-foot-actions[hidden]` must stay `display: none` (the class sets `inline-flex`, which would otherwise show dead Full/Save buttons before the first image).

## How to Verify

```sh
bash scripts/check.sh
timeout 120 node --test "cells/image-gen/*.test.*"
```

`client.test.js` loads `client.js` (and, for the key tests, `cells/api-matrix/audio.js` + `probes.js`) in a `vm` sandbox with stub storage and `fetch`.

In the browser (`index.html`), without a key: Generate opens the key bar; with a key, stub `fetch` to check loading, Cancel, a second Generate while one is in flight, success, safety block and malformed payloads. With a real key:
1. Open the **Key** pill (or reuse an existing key from Cell 01/04), paste a Gemini API key, and click **Save**.
2. Click a preset chip (fills the prompt) or type a prompt, then press **Enter** / **Generate**.
3. Confirm the image renders in the stage, latency + natural dimensions appear in the footer, and clicking the image opens the lightbox with a working **Download**.
