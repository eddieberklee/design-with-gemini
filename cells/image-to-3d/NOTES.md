# Cell 11 — Image → 3D (4-Model Arena) (`cells/image-to-3d/`)

Drop or pick any image and race **4 Gemini models in parallel** to reconstruct it as a 3D primitive mesh, rendered side by side in 4 interactive 3D viewers with each model's exact name.

## Architecture

- **`renderer.js`** (`window.GeminiImageTo3D.Renderer`): Zero-dependency Canvas 2D software 3D engine (perspective projection, directional + fill shading, painter's-algorithm depth sort, pointer drag-to-orbit, wheel zoom, auto-turntable, and `.OBJ` export). Tessellates `box`, `sphere`, `cylinder`, `cone`, `pyramid`, and `torus` primitives and auto-normalizes bounding boxes.
- **`client.js`** (`window.GeminiImageTo3D.Client`): Shares `dc_gemini_api_key_session` / `dc_gemini_api_key_local` with sibling cells, dynamically picks 4 distinct Gemini multimodal models from `/v1beta/models` (falling back to `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.0-flash`), and runs structured JSON `generateContent` requests in parallel.
- **`ui.js`** & **`image-to-3d.css`**: 4 side-by-side 3D viewports inside `#cell-image-to-3d` plus a full-width **4-Up** `<dialog class="ui-dialog">` studio, optional **Sync** camera orbit across all 4 viewers, per-model elapsed timers, and `.OBJ` download per model.

## How to Verify

```sh
bash scripts/check.sh
node --test cells/image-to-3d/client.test.js
```

In the browser (`index.html`):
1. Ensure a Gemini API key is saved (Cell 11 shares the key with Cells 01, 04, and 10).
2. Drop any image onto Cell 11 (or click the drop bar to choose a file).
3. Watch all 4 Gemini models generate and render side by side; drag any viewport to orbit all 4 in sync, click **4-Up** for a full-width comparison, or click **.OBJ** to download a mesh.
