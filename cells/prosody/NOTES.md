# Live Voice Prosody Button Sizer (`cells/prosody/`)

Interactive Cell #2 prototype mounted into `#cell-prosody` in [index.html](../../index.html). Uses the **Gemini Live API** (`BidiGenerateContent` WebSocket) to stream continuous 16kHz PCM mic audio, show detected words in a live marquee, and resize a centered button with synthesized tactile sound feedback.

## 1. Intent & Architecture

- **Core thesis**: Continuous streaming lets you speak naturally (*"a little smaller… a liiiittle smaller… MUCH bigger"*) and watch + hear the button respond live as vocal stress and elongation are detected.
- **Module graph (`window.GeminiProsody`)**:
  - [client.js](client.js) — `KeyStore` shares `dc_gemini_api_key_session` / `dc_gemini_api_key_local` with Cell #1; `createLiveSession` opens a `BidiGenerateContent` WebSocket (`models/gemini-3.8-live` with automatic fallback to `models/gemini-2.5-flash-native-audio-preview-12-2025`), enables `inputAudioTranscription`, streams 16kHz PCM chunks, and handles `adjust_button_size` tool calls; `SoundFX` synthesizes pitched Web Audio resize ticks/chimes (micro-nudge tick, marimba interval, bold chord, reset chime).
  - [ui.js](ui.js) — `mount` renders the 4:3 cell with the centered resizable button, layered ghost outline, live detected-word marquee ribbon (`.ps-marquee`), HiDPI waveform canvas, `SFX On/Off` toggle, and demo chips.
  - [prosody.css](prosody.css) — Strictly scoped under `.cell--prosody` and `.ps-*`.

## 2. How to Run & Verify

1. Syntax check:
   ```bash
   node --check cells/prosody/client.js && node --check cells/prosody/ui.js
   ```
2. Serve locally (`python3 -m http.server 8000`) and open `http://localhost:8000`.
3. Click `Start Live Mic` (with a Gemini API key) to stream continuously, watch words flow in the marquee, and hear the pitched resize sounds — or tap any demo chip to preview the marquee, ghost outline, and synthesized sounds immediately.
