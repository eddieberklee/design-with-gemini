# Google Gemini API Matrix Cell (`cells/api-matrix/`)

Interactive Cell #4 prototype and full-viewport Secondary Grid for live-probing **18 Google Gemini API surfaces** directly from the browser using a standard Google AI Studio Gemini API key, mounted into `#cell-api-matrix` in [index.html](../../index.html).

---

## 1. Intent & Architecture

Antigravity's desktop account session does not expose a raw `generativelanguage.googleapis.com` API key to shell commands or browser pages. Cell #4 gives developers a single tap-to-open **Secondary API Status Grid** that accepts a standard Google AI Studio `AIza...` key (synced live with Cell #1's local storage keys), dynamically discovers all models enabled on that key via `GET /v1beta/models`, and runs safe, minimal-cost live probes across every major Google Gemini API endpoint.

### Module Graph (`window.GeminiApiMatrix`)

All files load via classic `<script defer>` (never `type="module"`) so the grid works zero-build over both `file://` and `http://localhost`:

| File | Responsibility |
| :--- | :--- |
| [audio.js](audio.js) | Chunked 32KB Base64 encode/decode (avoids call-stack overflow on large audio), `audio/L16` PCM16LE→WAV wrapper with RIFF magic-byte detection and odd-byte alignment, and a procedural 0.35s 440Hz WAV test-tone generator for multimodal audio input probing. |
| [probes.js](probes.js) | Cross-cell `KeyStore` synced with `cells/decisions/client.js`, central `redactSecrets` sanitizer, paginated `/v1beta/models?pageSize=1000` capability catalog builder, all 18 endpoint probe runners (REST, SSE, WebSocket Live API, TTS, Audio Input, Opt-in Image Gen, Platform list probes, OpenAI compat), staged `runBatch` concurrency/429 scheduler, and JSON/Markdown report exporters. |
| [ui.js](ui.js) | Mounts Cell #4's single-button 6×3 micro-LED card in `#cell-api-matrix`, full-viewport `#api-matrix` `<dialog>` secondary grid with loop-free URL hash history sync, collapsible API key bar, sticky filter rail, 18-card secondary grid, Inspector Drawer (with `←`/`→` stepping, inline TTS `<audio>` playback, opt-in Image preview, redacted cURL/JSON), and Discovered Models browser drawer. |
| [api-matrix.css](api-matrix.css) | Strictly scoped under `.cell--api-matrix`, `.am-dialog`, and `.am-*`, mirroring Cell #1's Swiss Instrument tokens (including AA `--am-needle-ink` & `--am-ink-3`), `@container am-card` breakpoints, colorblind-safe status geometry, mobile bottom-sheet drawer, `>= 36px` touch targets, and `prefers-reduced-motion` guards. |
| [probes.test.js](probes.test.js) | Zero-dependency Node `vm` unit & integration test suite verifying Base64/PCM→WAV audio codecs, secret redaction, thinking-safe configs, catalog bucketing, cross-cell `KeyStore` sync/clear, staged 18-endpoint batch execution, SSE/WS/TTS/image edge cases, and 429 retry vs hard-quota fast-fail. |

---

## 2. Verified Endpoint Matrix & Browser CORS

Live `OPTIONS` preflight checks against `https://generativelanguage.googleapis.com` verified `HTTP/2 200` with `access-control-allow-headers: content-type,x-goog-api-key` (and `authorization` on `/v1beta/openai/models`) across all REST surfaces:

| Group | Probes (18 total) |
| :--- | :--- |
| **Core (6)** | `models` (`GET /v1beta/models?pageSize=1000`), `generate` (`:generateContent`), `stream` (`:streamGenerateContent?alt=sse`), `interactions` (`POST /v1beta/interactions`), `decisions` (`POST /v1beta/decisions`), `grounding` (`google_search` tool) |
| **Audio & Live (4)** | `live_ws` (`WSS BidiGenerateContent`), `tts` (`AUDIO` modality + playable WAV), `audio_in` (0.35s WAV `inlineData` + transcribe discovery), `lyria` (catalog + model metadata) |
| **Media & Vectors (4)** | `embeddings` (`:embedContent`), `count_tokens` (`:countTokens`), `image_gen` ($0 metadata + opt-in live generation), `veo` ($0 metadata; never auto-triggers billable LRO video renders) |
| **Platform (4)** | `files` (`GET /v1beta/files`), `caching` (`GET /v1beta/cachedContents`), `batches` (`GET /v1beta/batches`), `openai` (`GET /v1beta/openai/models` via `Bearer`) |

---

## 3. Design Decisions & Pre-Build Audit Synthesis

- **Thinking-safe token config (`probes.js:buildSafeTextGenConfig`)**: `gemini-2.5-*` and `gemini-3.x`/`4.x` count reasoning tokens against `maxOutputTokens`. Using `maxOutputTokens: 8` starves visible output; sending both `thinkingBudget` and `thinkingLevel` returns `400`. The helper dispatches per model family and filters out `part.thought === true`.
- **Staged Run-All scheduler (`probes.js:runBatch`)**: Runs `models` first as a Stage 0 auth/discovery gate (halting immediately on `401`/`403`), then Stage 1 free metadata/read-only probes (concurrency `3`), then Stage 2 metered probes (concurrency `2`, `450ms` stagger, serialized per `bareModel`) with `429 RetryInfo` backoff and fast-fail on daily/zero-limit `QuotaFailure`.
- **PCM16LE endianness (`audio.js:pcm16leToWavBytes`)**: Gemini TTS emits signed 16-bit little-endian PCM even when `mimeType` reads `audio/L16;codec=pcm;rate=24000`; bytes are wrapped directly in a RIFF/WAVE header without byte-swapping, and existing `RIFF` headers are preserved without double-wrapping.
- **Cost guardrails**: `veo` and `lyria` perform `$0` metadata checks only; `image_gen` performs `$0` metadata checks in batch runs and exposes an explicit opt-in `Run Live Image Gen` button in its Inspector Drawer; `grounding` can be toggled off in the filter rail.
- **Loop-free `#api-matrix` history (`ui.js:openSecondaryGrid` / `ui.js:closeSecondaryGrid`)**: Tracks `openedFromGrid` so `← Back to Grid` calls `history.back()` when entered from Cell #4, or `history.replaceState` when deep-linked directly to `#api-matrix`.
- **Rejected Protocol B alternatives**: Rejected (a) flat table layout in favor of a tactile secondary card grid matching `index.html`'s physical cell grammar, (b) firing all 18 probes concurrently (`Promise.all`) which triggers instant free-tier 429 bursts, and (c) auto-running probes on modal open before a key is validated.

---

## 4. Hazards & Invariants

- **Cross-cell key cache (`probes.js:KeyStore`)**: Cell #1 (`cells/decisions/client.js`) caches its key in a module closure (`memoryKey`). `KeyStore.set` / `KeyStore.clear` update both `sessionStorage`/`localStorage` (`dc_gemini_api_key_session` / `dc_gemini_api_key_local`) **and** `window.GeminiDecisions.Client.KeyStore`, then dispatch `gemini-key-changed`.
- **Zero key leakage (`probes.js:redactSecrets`)**: All HTTP REST probes use headers (`x-goog-api-key` or `Authorization: Bearer`), never query strings. Only browser `WebSocket` (`probes.js:probeLiveWebSocket`) requires `?key=`, and neither `ws.url` nor raw keys are ever written into state, DOM, logs, cURL, or exported reports.
- **WebSocket binary frames (`probes.js:probeLiveWebSocket`)**: Gemini Live API sends JSON frames as binary payloads (`Blob`/`ArrayBuffer`); `ws.binaryType = 'arraybuffer'` + `TextDecoder` is mandatory before parsing `setupComplete`.
- **Media lifecycle (`ui.js:revokeMediaUrl`, `ui.js:stopActiveAudio`)**: Every `URL.createObjectURL` is tracked per endpoint and revoked on replacement, reset, and `beforeunload`; TTS `<audio>` playback is paused and rewound on drawer close or card switch.

---

## 5. How to Run & Verify

1. **Syntax & unit/integration tests**:
   ```bash
   node --check cells/api-matrix/audio.js && node --check cells/api-matrix/probes.js && node --check cells/api-matrix/ui.js && node --check cells/api-matrix/probes.test.js && node cells/api-matrix/probes.test.js
   ```
2. **Browser check**: Open `index.html` via `python3 -m http.server 8000` (or `file://`), tap Cell #4 (`04 · API Matrix`), paste a Google AI Studio Gemini API key, and click **Save & Run All**. Inspect any card for redacted cURL, raw JSON, inline TTS playback, or opt-in live image generation.
