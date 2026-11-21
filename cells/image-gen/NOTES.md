# Cell 10 — Gemini Image Gen (`cells/image-gen/`)

Interactive tile for testing Google's native Gemini image generation API (**Nano Banana Pro** / `gemini-3-pro-image-preview`, **Nano Banana 2** / `gemini-3.1-flash-image-preview`, and `gemini-2.5-flash-image`) via `POST /v1beta/models/{model}:generateContent`.

## Architecture

- **`client.js`** (`window.GeminiImageGen`):
  - **Shared KeyStore**: Reads/writes `dc_gemini_api_key_session` and `dc_gemini_api_key_local` and syncs with `GeminiApiMatrix.KeyStore` so a key pasted in any cell works immediately here.
  - **Model Discovery & Ranking** (`rankImageModels`): Queries `GET /v1beta/models?pageSize=200` when a key is present, filters to Gemini native image models supporting `generateContent`, and ranks `gemini-3-pro-image*` → `gemini-3.1-flash-image*` → `gemini-nano-banana*` → `gemini-2.5-flash-image*`.
  - **Generation** (`generateImage`): Sends `responseModalities: ['TEXT', 'IMAGE']` + `imageConfig: { aspectRatio }` with an automatic retry omitting `imageConfig` if an older/variant model rejects `imageConfig` with HTTP 400. Supports `AbortController` cancellation.
- **`ui.js`**: Mounts into `#cell-image-gen` using `ui/base.css` `.ui-tile` anatomy. Includes 4 one-click prompt chips, model & aspect-ratio selectors, inline key bar, live elapsed timer, download link, and full-res `<dialog class="ui-dialog">` lightbox.
- **`image-gen.css`**: Scoped `.cell--image-gen` / `.ig-*` styles built exclusively on `--ui-*` tokens.

## How to Verify

```sh
bash scripts/check.sh
node --test cells/image-gen/client.test.js
```

In the browser (`index.html`):
1. Open the **Key** pill (or reuse an existing key from Cell 01/04), paste a Gemini API key, and click **Save**.
2. Click any preset chip or enter a prompt and press **Enter** / **Generate**.
3. Confirm the image renders in the stage, latency + natural dimensions appear in the footer, and clicking the image opens the full-resolution lightbox with working **Download**.
