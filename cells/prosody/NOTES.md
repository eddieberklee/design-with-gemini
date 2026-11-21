# Voice Prosody Button Sizer (`cells/prosody/`)

Interactive Cell #2 prototype mounted into `#cell-prosody` in [index.html](../../index.html). Uses **Gemini native audio understanding** (`gemini-2.5-flash`) to map vocal stress, vowel elongation, and tone directly to the size of a button centered in the cell.

## 1. Intent & Architecture

- **Core thesis**: Spoken UI commands carry continuous analog intent in *how* words are delivered, not just in the text transcript. Flat *"make this button a little smaller"* applies a standard step (`-12%`), whereas stressed/elongated *"make this button a **liiiittle** smaller"* applies a micro-nudge (`-3%`).
- **Module graph (`window.GeminiProsody`)**:
  - [client.js](client.js) — Shares `dc_gemini_api_key_session` / `dc_gemini_api_key_local` with Cell #1, sends raw base64 mic audio (`audio/webm` or `audio/mp4`) directly to `POST /v1beta/models/gemini-2.5-flash:generateContent` with a strict `responseSchema`, and provides 3 instant prosody demo presets when no key is configured.
  - [ui.js](ui.js) — Mounts the 4:3 cell with the centered resizable button, dashed ghost outline of the previous size, live `scale · W×H` telemetry, `MediaRecorder` + Web Audio waveform canvas, emphasized-word transcript highlight, and API key popover.
  - [prosody.css](prosody.css) — Strictly scoped under `.cell--prosody` and `.ps-*` so sibling grid cells remain unaffected.

## 2. Hazards & Invariants

- **Zero-build compatibility**: Classic `<script defer>` (no ES modules) so `index.html` works over both `file://` and `http://localhost:8000`. Note that `navigator.mediaDevices.getUserMedia` requires a secure context (`http://localhost` or `https://`).
- **No `innerHTML`**: All DOM nodes in `ui.js` are built with `document.createElement` + `textContent` to prevent injection from model transcripts.

## 3. How to Run & Verify

1. Syntax check:
   ```bash
   node --check cells/prosody/client.js && node --check cells/prosody/ui.js
   ```
2. Serve locally (`python3 -m http.server 8000`) and open `http://localhost:8000`.
3. Click the demo chips (`"a little smaller"`, `"a LIIIITTLE smaller"`, `"MUCH bigger"`) to verify ghost-outline delta comparison, or click `+ KEY` to test live `gemini-2.5-flash` audio prosody with your microphone.
