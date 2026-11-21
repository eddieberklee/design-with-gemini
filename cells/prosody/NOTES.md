# Voice Prosody Button Sizer (`cells/prosody/`)

Interactive Cell #2 prototype mounted into `#cell-prosody` in [index.html](../../index.html). Uses **Gemini native audio understanding** (`gemini-3.8-flash`) to map vocal stress, vowel elongation, and tone directly to the size of a button centered in the cell.

## 1. Intent & Architecture

- **Core thesis**: Spoken UI commands carry continuous analog intent in *how* words are delivered, not just in the text transcript. Flat *"make this button a little smaller"* applies a standard step (`-12%`), whereas stressed/elongated *"make this button a **liiiittle** smaller"* applies a micro-nudge (`-3%`).
- **Module graph (`window.GeminiProsody`)**:
  - [client.js](client.js) — `KeyStore` shares `dc_gemini_api_key_session` / `dc_gemini_api_key_local` with Cell #1; `analyzeAudioLive` sends raw base64 mic audio (`audio/webm` or `audio/mp4`) directly to `POST /v1beta/models/gemini-3.8-flash:generateContent` with a strict `responseSchema` and 25s timeout; `DEMO_PRESETS` provides 3 instant prosody demo chips when no key is configured.
  - [ui.js](ui.js) — `mount` renders the 4:3 cell with the centered resizable button, layered ghost outline of the previous size, stage-clamped dimensions, live `% · W×H` telemetry, `MediaRecorder` + HiDPI Web Audio waveform canvas, emphasized-word transcript highlight, and API key popover.
  - [prosody.css](prosody.css) — Strictly scoped under `.cell--prosody` and `.ps-*` so sibling grid cells remain unaffected.

## 2. Design & Technical Decisions

- **Native audio (`gemini-3.8-flash`) over Web Speech STT**: Browser Web Speech API flattens speech into text, discarding word stress, vowel elongation, and vocal intensity. Passing raw audio inline to Gemini preserves prosody end-to-end.
- **Multiplicative scale + `scale^0.72` font curve (`ui.js:computeButtonDims`)**: Proportional percentage deltas feel consistent across consecutive tweaks while keeping label typography readable at `45%` and restrained at `185%`, clamped to actual stage bounds so the button never clips or covers the top HUD pills.
- **Layered ghost outline (`prosody.css:.ps-ghost-btn`)**: Rendered above `.ps-target-btn` (`z-index: 2`) with a high-contrast inner ring when growing (`.is-growing`) so both shrink and grow deltas remain legible.

## 3. Hazards & Invariants

- **Zero-build compatibility**: Classic `<script defer>` (no ES modules) so `index.html` works over both `file://` and `http://localhost:8000`. Note that `navigator.mediaDevices.getUserMedia` requires a secure context (`http://localhost` or `https://`).
- **Cross-cell key sync (`client.js:KeyStore`)**: Reads `sessionStorage`/`localStorage` live on every `get()` and clears both keys on `set()`/`clear()` so key rotations in Cell #1 never leave Cell #2 stale.
- **Async & hardware race guards (`ui.js:mount`)**: `requestingMic` prevents concurrent `getUserMedia` leaks; `state.abortController === controller` guards `.then`/`.catch`/`.finally` against stale-request clobbering; a `15s` cap prevents unbounded recordings.
- **No `innerHTML`**: All DOM nodes in `ui.js` are built with `document.createElement` + `textContent` / `createTextNode` to prevent injection from model transcripts.

## 4. How to Run & Verify

1. Syntax check:
   ```bash
   node --check cells/prosody/client.js && node --check cells/prosody/ui.js
   ```
2. Serve locally (`python3 -m http.server 8000`) and open `http://localhost:8000`.
3. Click the demo chips (`"a little smaller"`, `"a LIIIITTLE smaller"`, `"MUCH bigger"`) to verify ghost-outline delta comparison on both shrink and grow, or click `SIM · +KEY` to test live `gemini-3.8-flash` audio prosody with your microphone (hold or click).
