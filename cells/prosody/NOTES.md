# Live Voice Prosody Button Sizer (`cells/prosody/`)

Interactive Cell #2 prototype mounted into `#cell-prosody` in [index.html](../../index.html). Uses the **Gemini Live API** (`BidiGenerateContent` WebSocket) to stream continuous 16kHz PCM mic audio, show detected words in a live marquee, and resize a centered button with synthesized tactile sound feedback.

## 1. Intent & Architecture

- **Core thesis**: Continuous streaming lets you speak naturally (*"a little smaller… a liiiittle smaller… MUCH bigger"*) and watch + hear the button respond live as vocal stress and elongation are detected.
- **Module graph (`window.GeminiProsody`)**:
  - [client.js](client.js) — `KeyStore` shares `dc_gemini_api_key_session` / `dc_gemini_api_key_local` with Cell #1 (`GeminiDecisions`) and Cell #4 (`GeminiApiMatrix`), dispatching `'gemini-key-changed'` and falling back to an in-memory key when storage getters are restricted; `createLiveSession` opens a `BidiGenerateContent` WebSocket (`models/gemini-3.8-live` with automatic fallback to `models/gemini-live-2.5-flash-native-audio`), enables `inputAudioTranscription`, resamples and streams 16kHz PCM chunks (`downsampleTo16k` + `floatTo16BitPCMBase64`), and handles `adjust_button_size` tool calls; `SoundFX` synthesizes pitched Web Audio resize ticks/chimes (micro-nudge tick, marimba interval, bold chord, reset chime) with graceful `SoundFX.close()` cleanup.
  - [ui.js](ui.js) — `UI.mount` renders the 4:3 cell with the centered resizable button, layered ghost outline, live detected-word marquee ribbon (`.ps-marquee`), HiDPI waveform canvas, `SFX On/Off` toggle (`aria-pressed`), and demo chips, returning an idempotent `unmount()` disposer.
  - [prosody.css](prosody.css) — Strictly scoped under `.cell--prosody` and `.ps-*` with `@container ps-card` compact rules (`340px`, `300px`, `265px`), WCAG AA contrast (`#b43a10`, `#6e6e6a`), and full `prefers-reduced-motion` support.

## 2. Hazards, Constraints & Lifecycle Invariants

- **Browser WebSocket `?key=` constraint (`client.js:createLiveSession`)**: Unlike REST `fetch` calls (which send `x-goog-api-key` request headers), the browser `WebSocket` API does not permit custom HTTP upgrade headers, so `BidiGenerateContent` requires passing `?key=` in the `wss://generativelanguage.googleapis.com/...` URL. The socket URL is never logged, exported, or written into DOM attributes, and keys default to `sessionStorage` (`dc_gemini_api_key_session`) with `try/catch`-guarded storage-getter access (`client.js:getStore`).
- **WebSocket fallback & frame-type safety (`client.js:createLiveSession`)**: Each connection attempt captures `const sock = ws`, arms a `12s` setup handshake timeout, detaches handlers before retrying `models/gemini-live-2.5-flash-native-audio` so stale `ws0` callbacks cannot clobber `ws1`, drops PCM frames when `ws.bufferedAmount > 262144`, guards non-object JSON frames (e.g. `"null"`), decodes `string`, `Blob`, and binary `ArrayBuffer`/`TypedArray` frames, and re-checks `closed || sock !== ws` after async `Blob.text()`.
- **Async mic toggle & teardown (`ui.js:startLiveStream`, `ui.js:stopLiveStream`, `ui.js:mount`)**: A monotonic `sessionEpoch` counter is incremented on every `stopLiveStream` and verified when `getUserMedia` resolves/rejects and inside all `createLiveSession` / `track.onended` / `onaudioprocess` callbacks so rapid `Start → Stop → Start` clicks never leak `MediaStream` tracks, `AudioContext`, `ScriptProcessorNode`, or sockets. `UI.mount` auto-cleans any prior mount on the same container, observes `stage` via `ResizeObserver` (so Cell #3 `--mg-cell-w` changes recompute button clamping and canvas DPI without height clamp inversion), and tears down streams/listeners on `pagehide` and `unmount()`.
- **Sub-16 kHz resampling (`client.js:downsampleTo16k`)**: Guards non-positive sample rates (`<= 0`) and linearly interpolates `< 16 kHz` inputs (such as `8 kHz` Bluetooth HFP/SCO microphones) instead of box-averaging, avoiding odd-sample zero-stuffing Nyquist noise while preserving anti-aliased box-averaging for `> 16 kHz` inputs (`44.1 kHz` / `48 kHz`).

## 3. How to Run & Verify

1. Syntax check:
   ```bash
   node --check cells/prosody/client.js && node --check cells/prosody/ui.js
   ```
2. Serve locally (`python3 -m http.server 8000`) and open `http://localhost:8000`.
3. Click `Start Live Mic` (with a Gemini API key) to stream continuously, watch words flow in the marquee, and hear the pitched resize sounds — or tap any demo chip to preview the marquee, ghost outline, and synthesized sounds immediately.
