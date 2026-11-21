# Google Gemini API Matrix Cell (`cells/api-matrix/`)

Interactive Cell #4 prototype and full-viewport Secondary Grid for live-probing **18 Google Gemini API surfaces** directly from the browser using a standard Google AI Studio Gemini API key, mounted into `#cell-api-matrix` in [index.html](../../index.html).

---

## 1. Intent & Architecture

Antigravity's desktop account session does not expose a raw `generativelanguage.googleapis.com` API key to shell commands or browser pages. Cell #4 gives developers a single tap-to-open **Secondary API Status Grid** that accepts a standard Google AI Studio `AIza...` key (synced live with Cell #1's local storage keys), dynamically discovers all models enabled on that key via `GET /v1beta/models`, and runs safe, minimal-cost live probes across every major Google Gemini API endpoint.

### Module Graph (`window.GeminiApiMatrix`)

All files load via classic `<script defer>` (never `type="module"`) so the grid works zero-build over both `file://` and `http://localhost`:

| File | Responsibility |
| :--- | :--- |
| [audio.js](audio.js) | Chunked 32KB Base64 encode/decode with strict Base64 payload validation (avoids call-stack overflow on large audio), `audio/L16` PCM16LE→WAV wrapper with RIFF magic-byte detection and channel-frame (`ch * 2`) byte alignment, and a procedural 0.35s 440Hz WAV test-tone generator for multimodal audio input probing. |
| [probes.js](probes.js) | Cross-cell `KeyStore` synced with `cells/decisions/client.js`, central `redactSecrets` sanitizer, paginated `/v1beta/models?pageSize=1000` capability catalog builder, all 18 endpoint probe runners (REST with non-JSON proxy rejection, SSE with stream cancellation, WebSocket Live API with error-frame detection, TTS, Audio Input, Opt-in Image Gen, Platform list probes, OpenAI compat), staged `runBatch` concurrency/429 scheduler, and JSON/Markdown report exporters. |
| [ui.js](ui.js) | Mounts tile 04's single-button 6×3 probe matrix in `#cell-api-matrix` (built once by `buildPrimaryCell`, then patched in place by `renderPrimaryCell`; mount returns an idempotent `unmount()` disposer and preserving its `aria-live` node across updates), full-viewport `#api-matrix` `<dialog>` secondary grid with `closingViaHistory`-guarded URL hash history sync, collapsible API key bar, sticky filter rail, 18-card secondary grid, Inspector Drawer (with `←`/`→` endpoint stepping, keyboard-accessible `role="tablist"`/`role="tabpanel"` code tabs, inline TTS `<audio>` playback, opt-in Image preview, redacted cURL/JSON), and Discovered Models browser drawer. |
| [api-matrix.css](api-matrix.css) | Cell-specific rules only, scoped to `.am-*`; every colour, size, radius and font is a `--ui-` token from `ui/base.css`. Tile steps are the shared `@container ui-tile` steps (320 / 240 px) plus one local 170 px step that hides the probe codes. Shaped status dots (`.am-led`), studio-bar layout, card grid, inspector drawer (bottom sheet under 768 px), `prefers-reduced-motion` guard. |
| [probes.test.js](probes.test.js) | Zero-dependency Node `vm` script (24 cases) verifying Base64/PCM→WAV audio codecs, secret redaction, thinking-safe configs, catalog bucketing, cross-cell `KeyStore` sync/clear (including the memory-only fallback when storage writes throw), `validateApiKey`, `runBatch` `haltReason`, `KeyStore.mask`, staged 18-endpoint batch execution, SSE/WS/TTS/image edge cases, and 429 retry vs hard-quota fast-fail. |

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
- **Staged Run-All scheduler (`probes.js:runBatch`)**: Runs `models` first as a Stage 0 auth/discovery gate (halting on `401`/`403`/`INVALID KEY` with `haltReason: 'auth'`, or on `NETWORK ERR` with `haltReason: 'network'`; `haltedOnAuth` stays `true` for both for older callers, and `ui.js:startBatchRun` words the notice from `haltReason`), then Stage 1 free metadata/read-only probes (concurrency `3`), then Stage 2 metered probes (concurrency `2`, `450ms` stagger, serialized per `bareModel`) with `429 RetryInfo` backoff and fast-fail on daily/zero-limit `QuotaFailure`.
- **PCM16LE endianness (`audio.js:pcm16leToWavBytes`)**: Gemini TTS emits signed 16-bit little-endian PCM even when `mimeType` reads `audio/L16;codec=pcm;rate=24000`; bytes are wrapped directly in a RIFF/WAVE header without byte-swapping, and existing `RIFF` headers are preserved without double-wrapping.
- **Cost guardrails**: `veo` and `lyria` perform `$0` metadata checks only; `image_gen` performs `$0` metadata checks in batch runs and exposes an explicit opt-in **Generate image** button in its Inspector Drawer; `grounding` can be toggled off in the filter rail.
- **Loop-free `#api-matrix` history (`ui.js:openSecondaryGrid` / `ui.js:closeSecondaryGrid`)**: Tracks `openedFromGrid` so the studio bar's **Close** (`data-am-focus="back"`) calls `history.back()` when entered from Cell #4, or `history.replaceState` when deep-linked directly to `#api-matrix`.
- **Rejected Protocol B alternatives**: Rejected (a) flat table layout in favor of a tactile secondary card grid matching `index.html`'s physical cell grammar, (b) firing all 18 probes concurrently (`Promise.all`) which triggers instant free-tier 429 bursts, and (c) auto-running probes on modal open before a key is validated.

---

## 4. Hazards & Invariants

- **Cross-cell key contract (do not rename)**: storage keys `dc_gemini_api_key_session` / `dc_gemini_api_key_local`, the `window.GeminiApiMatrix.KeyStore` object (`get`/`set`/`clear`/`mask`/`getStorageType`/`isStorageRestricted`, called by `cells/prosody/client.js:syncSiblingsAndNotify`), and the window event `gemini-key-changed` (`detail: { hasKey, storage }`, also dispatched and consumed by Prosody). `KeyStore.set` / `clear` write storage, then call `GeminiDecisions.Client.KeyStore` and `GeminiProsody.Client.KeyStore` `set`/`clear`. `cells/left-grille/ui.js` reacts to the `#api-matrix` hash.
- **Memory-only key (`probes.js:KeyStore` / `memoryFallback`)**: when storage writes throw (quota, private mode) `set` returns `'memory'`; `get` then reads Cell #1's closure key (`GeminiDecisions.Client.KeyStore.get`) so a Decisions clear still propagates, and falls back to its own `memoryKey` when Decisions is absent. With writable storage, empty stores still mean "cleared elsewhere".
- **Key validation (`probes.js:validateApiKey`)**: rejects only values that cannot be sent as a header (internal whitespace, non-ASCII). Format/length is left to the server (a 20,000-char key returns a clean `400 API key not valid`). `ui.js:requireKeyOrPrompt` re-validates the stored key because sibling cells write the same store.
- **Key exposure**: REST probes send the key only in headers (`x-goog-api-key` or `Authorization: Bearer`), never query strings, and the key never reaches state, DOM (except the masked/`Show` input), our own console calls, cURL, or reports (`probes.js:redactSecrets`). **Exception:** the browser `WebSocket` API cannot set headers, so `probes.js:probeLiveWebSocket` puts the key in `?key=`; when that socket fails to connect, Chrome itself logs `WebSocket connection to 'wss://…?key=<full key>' failed` in DevTools. Page code cannot suppress this; the fix needs ephemeral tokens from a server.
- **`Remember on this device` under `file://`**: `localStorage` for `file://` is one origin shared by every local HTML file opened in that browser, so any of them can read `dc_gemini_api_key_local`. Session storage (the default) is per tab.
- **Focus across re-renders (`ui.js:preserveFocus`)**: every render rebuilds its controls. Focusable controls carry `data-am-focus` (plus optional `data-am-focus-fallback`); `renderAll`, `renderProgressUpdate`, `renderStatusNote`, filter clicks and `onWindowFocus` restore focus by key only when it fell to `<body>`/the dialog. New controls must get a key or keyboard focus drops on the next probe update.
- **Drawer re-render (`ui.js:renderDrawer`)**: same view (`data-am-view`) keeps `.am-drawer-body` scroll and re-attaches the same TTS `<audio>`; a view change stops audio. `renderSecondarySections` always calls `renderDrawer`, so a dialog closed with a drawer open reopens clean. A no-key/invalid-key probe click closes the drawer first (`requireKeyOrPrompt`) so the key prompt is visible and focusable.
- **Escape (`ui.js` `cancel` listener)**: when Chrome's close-watcher guard makes `cancel` non-cancelable (no user activation since the last Escape), the listener runs `closeSecondaryGrid({ immediate: true })` (history + focus) instead of only closing the drawer. In a hidden tab Chrome does not fire `<dialog>` `close` events at all, so cleanup must not depend on the `close` listener.
- **WebSocket binary frames (`probes.js:probeLiveWebSocket`)**: Gemini Live API sends JSON frames as binary payloads (`Blob`/`ArrayBuffer`); `ws.binaryType = 'arraybuffer'` + `TextDecoder` is mandatory before parsing `setupComplete`.
- **Media lifecycle (`ui.js:revokeMediaUrl`, `ui.js:stopActiveAudio`)**: Every `URL.createObjectURL` is tracked per endpoint and revoked on replacement, reset, Run All, unmount, and `beforeunload`; TTS `<audio>` playback is paused and rewound on drawer close, card switch, or dialog close (not on a same-view re-render).

---

## 5. How to Run & Verify

1. **Syntax & unit/integration tests** (Node 22 does not expand a directory argument to `node --test`; pass the file or a quoted glob):
   ```bash
   node --check cells/api-matrix/audio.js && node --check cells/api-matrix/probes.js && node --check cells/api-matrix/ui.js && node --check cells/api-matrix/probes.test.js && node cells/api-matrix/probes.test.js
   node --test 'cells/api-matrix/*.test.js'
   ```
2. **Browser check, no key**: open `index.html`, tap Cell #4. Focus must land in the key field. Open any Inspector and press **Re-test**: the drawer closes and the key prompt is focused. Paste `AIza✓x` and **Save key**: an inline error appears and nothing is stored.
3. **Browser check, in flight without a key**: replace `window.fetch` / `window.WebSocket` with canned responses (see `probes.test.js` case 12) plus a few hundred ms delay, store any ASCII key, then **Run all** with focus on a card's **Inspect**: focus must stay there through the batch; **Stop** with the Models drawer open must re-enable **Refresh**.
4. **Browser check, real key**: paste a Google AI Studio key and click **Save & run all**. Inspect any card for redacted cURL, raw JSON, inline TTS playback, or opt-in live image generation.

## 6. UI and tooltips (shared system, `ui/NOTES.md`)

- **Tile** (`ui.js:buildPrimaryCell` / `renderPrimaryCell`): `#cell-api-matrix` gets `.ui-tile` from JS (index.html stays untouched). One `button.ui-tile-trigger.am-cell-trigger` holds `ui-tile-head` (04, title, `ui-pill` status, quiet "Grid ↗" cue), the 6×3 matrix (hero) and `ui-tile-foot` (host + dot tally). Nothing interactive sits inside the trigger. The trigger is built once and patched in place (attributes and text only), so an open tooltip updates instead of vanishing and focus never leaves the trigger; it is rebuilt only if it is no longer a child of the root.
- **Status dots** (`.am-led[data-status]`): shape carries the state, colour only confirms it: not tested = hollow grey ring, probing = rust arc (turns; static under reduced motion), passed = filled green disc, warning = rust half disc, failed = filled rust square. The foot tally and the studio-bar summary use the same dots, so they are the legend.
- **Pill tones**: No key / Key set idle grey; Probing, N failed, N warnings `attention`; `ok` green only when every tested probe passed. Card pills and the inspector pill follow `ui.js:pillTone`.
- **Tooltips** (`data-tip`): each matrix cell = `CODE_TIPS[code]` + `statusTip(status, result)` (hover only, inside the button); pill and foot tally on the tile; in the dialog every tag (`CODE_TIPS`, `PROTOCOL_TIPS`, `COST_TIPS`), card pill, latency readout, filter (`FILTER_TIPS`), button, checkbox label, nav arrow (with ←/→ keycaps) and Close (Esc keycap). Tips never contain the key; the key is shown only through `KeyStore.mask`.
- **Dialog**: `dialog.ui-dialog.am-dialog` (full viewport). `header.ui-studio-bar` = index, title, summary, actions (Copy MD, JSON, Models, Key, Run all as the one primary / Stop as `data-tone="attention"`), Close last. Under 1200 px the bar is two rows with Close kept top right. Filters are a `ui-seg` (wraps under 768 px). The key button's `aria-expanded` is set by `renderKeybar`, because several paths re-render only the key row. Drawer close buttons say "Close" (Esc), keys `drawer-close`.
- **Verify the looks without a key**: replace `window.fetch` and `window.WebSocket` in the page (a never-resolving fetch that rejects on abort gives the probing look; canned responses give pass / warn / fail), store a fake key with `KeyStore.set(key, false)` (session only, never tick Remember under `file://`), then assert the raw key is absent from `document.documentElement.outerHTML`.
