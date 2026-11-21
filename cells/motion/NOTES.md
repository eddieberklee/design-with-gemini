# iPhone Motion Grid Controller (`cells/motion/`)

Interactive Cell #3 prototype mounted into `#cell-motion` in [index.html](../../index.html). Displays a scannable QR code that opens a standalone mobile web controller (`phone.html`) on an iPhone and uses the phone's accelerometer (`DeviceMotionEvent`) — rotating/tilting, raising up/down, or pulling/pushing — to dynamically resize every cell in the desktop grid in real time.

---

## 1. Intent & Architecture

Zero-build, zero-dependency browser + Node architecture matching `cells/decisions/` (classic `<script defer>` scripts so `index.html` works over `file://`, `http://localhost`, and `https://`):

| File | Responsibility |
| :--- | :--- |
| [qr.js](qr.js) | Self-contained ISO/IEC 18004 Byte-mode QR encoder (Versions 1–10, EC Level M, GF(256) Reed-Solomon, 8-mask penalty evaluation) rendering crisp inline SVG with a 4-module quiet zone (`window.MotionGrid.QR`). |
| [physics.js](physics.js) | Shared accelerometer sensor-fusion and physics core (`window.MotionGrid.Physics`): linear-subtracted `GravityFilter`, continuous unwrapped tilt extraction (`gravityToTiltDeg` + `wrapAngleDiffDeg`), gravity-projected world-up (`Lift`) and orthogonal screen-normal (`Pull`) ZUPT velocity integrators, and critically damped `SpringDamper` for 60fps desktop layout smoothing. |
| [transport.js](transport.js) | Dual-path real-time link (`window.MotionGrid.Transport`, also consumed by `cells/left-grille/iphone-dial.js` and `dial-phone.js`): minimal pure-JS MQTT 3.1.1 over WSS relay (`wss://broker.emqx.io:8084/mqtt` with HiveMQ/Mosquitto failover, `64KB` `rxBuf` cap, malformed-packet teardown), strict session ID validation (`SESSION_ID_RE`), plus same-origin local WebSocket (`/ws`) and liveness-checked HTTP POST/SSE fallback (`LocalBridgeTransport`). Every reconnect loop has a ceiling (`MQTT_MAX_ATTEMPTS`, `LOCAL_WS_MAX_ATTEMPTS`, `LOCAL_HTTP_MAX_ERRORS`) and ends in a terminal `'failed'` status; `start()` re-arms. |
| [ui.js](ui.js) | Desktop Cell #3 card, large Pairing Studio `<dialog>` (with trigger focus restoration and modal-safe clipboard copy), `probeSeq`-guarded auto-discovery of local HTTPS bridge (`/api/motion-config` with ngrok-startup re-probe, at most 6), storage-restricted `try/catch` lookup (`safeStorageGet`/`safeStorageSet`), `prefers-reduced-motion` instant snap, floating resize HUD, `--mg-cell-w` grid controller, link lifecycle (`syncTransport` / `desiredLinkKey`, `syncPhoneTimers`, `onVisibilityChange`), and idempotent `unmount()` disposer. |
| [motion.css](motion.css) | Strictly scoped under `.cell--motion`, `.mg-*`, `.mg-dialog`, `.mg-hud`, and opt-in `.grid.is-motion-controlled` (`max-width: min(92vw, 1600px)` matching `index.html`, `Reflow` and locked-columns `fixed3` modes) with `@container mg-card` micro/narrow/hero adaptation (`140px` to `960px`), WCAG AA tertiary contrast (`--mg-ink-3: #666661`), `:focus-visible` rings, and `prefers-reduced-motion` support. |
| [phone.html](phone.html), [phone.css](phone.css), [phone.js](phone.js) | One-handed dark-instrument iPhone web app with synchronous iOS `DeviceMotionEvent.requestPermission()` gate (plus touch-slider dismiss fallback, tap-the-dial to bring the gate back, a 2.5 s no-sensor probe `onSensorProbeTimeout`, and window-level `pointerup`/`pointercancel` scrub release), piecewise radial dial anchored at `1.00× = 0°`, ring bubble reticle, `All / Tilt / Lift / Pull` gesture modes, `Clutch` ratchet mode, `Zero Pose` (with deferred pre-sample calibration), `Reset 100%`, Screen Wake Lock re-acquisition, truthful link status (`renderStatus`: `LIVE` only while desktop `state` feedback arrives, else `WAIT DESKTOP`; `OFFLINE · TAP` after the retry ceiling, tap or return to the page to retry), a 2 s `hb` heartbeat (`syncHeartbeat`, only while linked and visible) so an idle slider-only phone is not dropped by the desktop's 6.5 s timeout, and `hello` sent only when the usable path changes, WCAG AA contrast (`--ink-3: #8c8c85`), and `44pt` touch targets. |
| [server.mjs](server.mjs) | Zero-dependency Node HTTPS + RFC 6455 WebSocket + SSE/POST local bridge (`node cells/motion/server.mjs`; `isMainModule` compares real paths so a symlinked checkout or `/tmp` path still starts it) that auto-detects/launches a port-matched `ngrok` HTTPS tunnel (child handed to the shutdown handler as soon as it spawns, so Ctrl+C during the tunnel poll kills it), falls back to ephemeral `fs.mkdtempSync` (`0o700` dir / `0o600` key, deleted in `finally`) self-signed LAN TLS, validates `Origin` on HTTP CORS and `/ws` upgrades (`403 Forbidden` against CSWSH), rejects unmasked client WS frames (`1002`), enforces strict web-asset allowlisting + `fs.realpath` containment, bounds WS/POST payload sizes (`8192B`), and closes open SSE/WS connections cleanly on shutdown. |
| [motion.test.mjs](motion.test.mjs) | Node test suite (`node --test cells/motion/motion.test.mjs`) verifying QR ISO structure/RS syndromes, accelerometer physics (`NaN` resilience, pre-motion `calibrate()`, roll sign, gravity de-contamination, lift ZUPT, clutch), `scaleToCellWidth` at phone widths, MQTT/LocalBridge framing, retry ceilings & timer cleanup, `createLink` aggregate status, `mountMotionCell` storage/unmount safety, idle/hidden link and timer lifecycle, and hardened `server.mjs` CSWSH/unmasked-frame/traversal/TLS security & relay behavior. |

---

## 2. Design & Technical Decisions

- **Why dual-path transport (Local WS/HTTPS + MQTT 3.1.1 over WSS)**:
  - Works completely backend-free when hosted on any static HTTPS host (GitHub Pages, Vercel, Netlify, Tailscale Serve) via pure-JS MQTT over WSS (`~100ms` RTT, works across Wi-Fi and 5G cellular).
  - Automatically upgrades to `< 5ms` same-origin WebSocket whenever `node cells/motion/server.mjs` is running, while liveness-checking HTTP POST/SSE fallback via `EventSource.onopen` so a dead local bridge never starves healthy MQTT WSS.
- **Why gravity-subtracted tilt + world-up ZUPT (`physics.js:MotionProcessor.prototype.ingestMotion`)**:
  - Subtracting hardware-fused `event.acceleration` before updating `GravityFilter` prevents brisk pulls or lifts from tilting the estimated gravity vector and causing false pitch drops.
  - Projecting linear acceleration onto the unit gravity vector $\hat{g}$ ensures **raising up / lowering down** works regardless of grip orientation, while adaptive deadzones (`0.42 m/s²`) + Zero-Velocity Update (ZUPT) damping eliminate MEMS double-integration drift.
- **Why `Reflow` default + truthful locked columns (`motion.css:.grid.is-motion-controlled`)**:
  - At `1.00×` neutral scale (`ui.js:NEUTRAL_SCALE_EPS`, one threshold for grid control, HUD and the `100%` chip), `.is-motion-controlled` is inactive so `index.html` remains pixel-identical to baseline.
  - `ui.js:measureBaseCellWidth` floors the real track width from `gridEl.clientWidth` and `matchMedia('(min-width: 768px)')` (177px at a 390px viewport, never a 180px floor), so a phone paired at `1.00×` keeps the natural 2 or 3 columns.
  - In `Reflow` mode (`repeat(auto-fill, min(100%, var(--mg-cell-w)))`), cells shrink down to `140px` contact-sheet thumbnails and expand up to `960px` hero cards (`1` per row); any growth above `1.00×` drops a column by design. `fixed3` (button `Lock 3 col` from 768px, `Lock 2 col` below) keeps the natural column count and caps reported `currentCellW` to that column maximum so readouts match rendered DOM widths.

---

## 3. Hazards & Invariants

- **iOS Safari Secure Context (`phone.js`, `ui.js:recomputeQrUrl`)**: `DeviceMotionEvent` is blocked by WebKit over non-HTTPS URLs. `recomputeQrUrl` only accepts `httpsReady` bridge configs, real `https://` origins, or validated user custom URLs (`<= 213` UTF-8 bytes) and wraps `QR.renderSVGElement` in `try/catch` so invalid saved URLs never brick Cell #3.
- **Synchronous iOS permission gesture (`phone.js:refs.enableBtn`)**: `DeviceMotionEvent.requestPermission()` MUST be invoked synchronously inside the button `click` handler before any unrelated `await`.
- **iOS accelerometer sign normalization (`physics.js:MotionProcessor.prototype.ingestMotion`, `physics.js:gravityToTiltDeg`)**: iOS Safari negates `accelerationIncludingGravity` and `acceleration` relative to the W3C spec; `isIOS` normalizes to W3C world-up (`+Z` out of flat face-up glass), and `roll = atan2(-gUnit.x, hypot(gUnit.y, gUnit.z))` maps clockwise wrist twist to `+roll` (enlarge).
- **Hardened local bridge (`server.mjs:handleRequest`, `server.mjs:handleUpgrade`, `server.mjs:generateSelfSignedCert`)**: Safely parses malformed URLs (`400` instead of uncaught `URIError`), rejects `..`, dotfiles (`.git/*`, `.env`), non-allowlisted extensions (`GEMINI.md`, `AGENTS.md`), and symlink escapes via `fs.realpath`, attaches `'error'`/`'close'` handlers on static `fs.createReadStream` streams, validates non-empty `Origin` headers on `/ws` upgrades (`403 Forbidden` to prevent Cross-Site WebSocket Hijacking) and HTTP CORS, rejects unmasked client WS frames (`1002`), enforces `8192B` limits on WS frames and HTTP POST bodies, and removes `fs.mkdtempSync` TLS temp directories in `finally` immediately after loading key/cert buffers.
- **Public MQTT WSS relay trust model (`transport.js:MqttRelayTransport`)**: Zero-backend fallback connects over TLS (`wss://`) to public unauthenticated MQTT brokers (`broker.emqx.io`, `broker.hivemq.com`, `test.mosquitto.org`) under topic `dwg-motion-v1/<sid>/{p2d,d2p}`. Payloads contain only non-sensitive numeric motion/layout state (never credentials or personal data), and random 8-char session IDs (`SESSION_ID_RE = /^[A-Z0-9]{6,12}$/`, blocking MQTT `+`/`#` wildcards) isolate casual rooms; however, public MQTT topics are observable and spoofable by anyone on the broker who discovers `<sid>`. Run `node cells/motion/server.mjs` for origin-checked local WS/HTTPS transport.
- **Clean lifecycle & cross-cell shortcut isolation (`ui.js:mountMotionCell`)**: `mountMotionCell(rootEl)` resolves `window[storeName]` inside `try/catch` (safe under sandboxed/blocked storage getters), skips global `R` reset when any `<dialog open>`, `[data-expanded="true"]`, `.cell-acoustic.is-expanded`, `.lg-is-expanded`, or `main.grid[hidden]` view is active, honors `prefers-reduced-motion: reduce` by snapping scale immediately without queuing `SpringDamper` RAF ticks, and returns an idempotent `unmount()` disposer (also auto-invoked on re-mount; removes the `visibilitychange` listener).
- **Resident cost (`ui.js:syncTransport`, `ui.js:syncPhoneTimers`, `ui.js:onVisibilityChange`)**: No relay link is opened until a scannable QR URL exists (the `SETUP` tile on `file://` makes no public-broker connection; footer reads `NO LINK`). The 1 Hz liveness/rate timer and the 220 ms desktop→phone feedback timer run only while a phone is paired and the tab is visible. A hidden tab closes the link and marks the phone disconnected; becoming visible reopens only a link it suspended. After the transport retry ceiling the pill reads `OFFLINE` and the link stays down until the user clicks the pill, the QR/↗ button, or `Retry Bridge` (`ui.js:retryFailedLink`). `createLink` reports `'failed'` only when every sub-link failed; `link.subStatus('local')` lets a successful bridge probe relink after a bridge restart at the same URL (`ui.js:probeLocalBridge`), so `LOCAL WS` comes back via `Retry Bridge` or reopening the studio.
- **No self-squish at micro cell sizes (`motion.css:@container mg-card`)**: Below `245px` (including the default 177px tile at 390px viewport) Cell #3 switches to a compact pixel/scale tile (`Reset 100%`) and keeps the compact `↗` studio button, which is the only route to the QR studio once the status pill hides below `195px`; a fixed `.mg-hud` keeps `Reset 100%` (and `Zero` when phone is live) reachable.
- **Bridge `Origin: null` (`server.mjs:isAllowedOrigin`)**: `null` is allowed so the `file://` page can probe `/api/motion-config`; sandboxed iframes on any site also send `Origin: null`, so a hostile page can read the config (phone URL) and open `/ws` rooms whose 8-char session ID it would still have to guess. Known, not changed.

---

## 4. How to Run & Verify

1. **Automated unit, physics, transport-ceiling, lifecycle, security & relay tests** (pass the file; on Node 22 `node --test cells/motion/` treats the directory as a module and fails):
   ```bash
   node --test cells/motion/motion.test.mjs
   ```
2. **Syntax check all browser & server scripts**:
   ```bash
   node --check cells/motion/qr.js && node --check cells/motion/physics.js && node --check cells/motion/transport.js && node --check cells/motion/ui.js && node --check cells/motion/phone.js && node --check cells/motion/server.mjs
   ```
3. **Live iPhone test (1 command)**:
   ```bash
   node cells/motion/server.mjs
   ```
   Open `http://localhost:8443` on desktop, scan the QR code in Cell #3 with your iPhone Camera, tap **Enable Motion**, and rotate, raise up/down, or pull the phone to smoothly resize the grid cells.
