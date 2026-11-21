# iPhone Motion Grid Controller (`cells/motion/`)

Interactive Cell #3 prototype mounted into `#cell-motion` in [index.html](../../index.html). Displays a scannable QR code that opens a standalone mobile web controller (`phone.html`) on an iPhone and uses the phone's accelerometer (`DeviceMotionEvent`) — rotating/tilting, raising up/down, or pulling/pushing — to dynamically resize every cell in the desktop grid in real time.

---

## 1. Intent & Architecture

Zero-build, zero-dependency browser + Node architecture matching `cells/decisions/` (classic `<script defer>` scripts so `index.html` works over `file://`, `http://localhost`, and `https://`):

| File | Responsibility |
| :--- | :--- |
| [qr.js](qr.js) | Self-contained ISO/IEC 18004 Byte-mode QR encoder (Versions 1–10, EC Level M, GF(256) Reed-Solomon, 8-mask penalty evaluation) rendering crisp inline SVG with a 4-module quiet zone (`window.MotionGrid.QR`). |
| [physics.js](physics.js) | Shared accelerometer sensor-fusion and physics core (`window.MotionGrid.Physics`): linear-subtracted `GravityFilter`, continuous unwrapped tilt extraction (`gravityToTiltDeg` + `wrapAngleDiffDeg`), gravity-projected world-up (`Lift`) and orthogonal screen-normal (`Pull`) ZUPT velocity integrators, and critically damped `SpringDamper` for 60fps desktop layout smoothing. |
| [transport.js](transport.js) | Dual-path real-time link (`window.MotionGrid.Transport`): minimal pure-JS MQTT 3.1.1 over WSS relay (`wss://broker.emqx.io:8084/mqtt` with HiveMQ/Mosquitto failover, `64KB` `rxBuf` cap, malformed-packet teardown), strict session ID validation (`SESSION_ID_RE`), plus same-origin local WebSocket (`/ws`) and liveness-checked HTTP POST/SSE fallback (`LocalBridgeTransport`). |
| [ui.js](ui.js) | Desktop Cell #3 card, large Pairing Studio `<dialog>` (with trigger focus restoration and modal-safe clipboard copy), `probeSeq`-guarded auto-discovery of local HTTPS bridge (`/api/motion-config` with ngrok-startup re-probe), storage-restricted `try/catch` lookup (`safeStorageGet`/`safeStorageSet`), `prefers-reduced-motion` instant snap, floating resize HUD, `--mg-cell-w` grid controller, and idempotent `unmount()` disposer. |
| [motion.css](motion.css) | Strictly scoped under `.cell--motion`, `.mg-*`, `.mg-dialog`, `.mg-hud`, and opt-in `.grid.is-motion-controlled` (`max-width: min(92vw, 1600px)` matching `index.html`, `Reflow` and `Lock 3×3` modes) with `@container mg-card` micro/narrow/hero adaptation (`140px` to `960px`), WCAG AA tertiary contrast (`--mg-ink-3: #666661`), `:focus-visible` rings, and `prefers-reduced-motion` support. |
| [phone.html](phone.html), [phone.css](phone.css), [phone.js](phone.js) | One-handed dark-instrument iPhone web app with synchronous iOS `DeviceMotionEvent.requestPermission()` gate (plus touch-slider dismiss fallback and window-level `pointerup`/`pointercancel` scrub release), piecewise radial dial anchored at `1.00× = 0°`, bubble reticle, `All / Tilt / Lift / Pull` gesture modes, `Clutch` ratchet mode, `Zero Pose` (with deferred pre-sample calibration), `Reset 100%`, Screen Wake Lock re-acquisition, WCAG AA contrast (`--ink-3: #8c8c85`), and `44pt` touch targets. |
| [server.mjs](server.mjs) | Zero-dependency Node HTTPS + RFC 6455 WebSocket + SSE/POST local bridge (`node cells/motion/server.mjs`) that auto-detects/launches a port-matched `ngrok` HTTPS tunnel, falls back to ephemeral `fs.mkdtempSync` (`0o700` dir / `0o600` key, deleted in `finally`) self-signed LAN TLS, validates `Origin` on HTTP CORS and `/ws` upgrades (`403 Forbidden` against CSWSH), rejects unmasked client WS frames (`1002`), enforces strict web-asset allowlisting + `fs.realpath` containment, bounds WS/POST payload sizes (`8192B`), and closes open SSE/WS connections cleanly on shutdown. |
| [motion.test.mjs](motion.test.mjs) | Node test suite (`node --test cells/motion/motion.test.mjs`) verifying QR ISO structure/RS syndromes, accelerometer physics (`NaN` resilience, pre-motion `calibrate()`, roll sign, gravity de-contamination, lift ZUPT, clutch), MQTT/LocalBridge framing & timer cleanup, `mountMotionCell` storage/unmount safety, and hardened `server.mjs` CSWSH/unmasked-frame/traversal/TLS security & relay behavior. |

---

## 2. Design & Technical Decisions

- **Why dual-path transport (Local WS/HTTPS + MQTT 3.1.1 over WSS)**:
  - Works completely backend-free when hosted on any static HTTPS host (GitHub Pages, Vercel, Netlify, Tailscale Serve) via pure-JS MQTT over WSS (`~100ms` RTT, works across Wi-Fi and 5G cellular).
  - Automatically upgrades to `< 5ms` same-origin WebSocket whenever `node cells/motion/server.mjs` is running, while liveness-checking HTTP POST/SSE fallback via `EventSource.onopen` so a dead local bridge never starves healthy MQTT WSS.
- **Why gravity-subtracted tilt + world-up ZUPT (`physics.js:MotionProcessor.prototype.ingestMotion`)**:
  - Subtracting hardware-fused `event.acceleration` before updating `GravityFilter` prevents brisk pulls or lifts from tilting the estimated gravity vector and causing false pitch drops.
  - Projecting linear acceleration onto the unit gravity vector $\hat{g}$ ensures **raising up / lowering down** works regardless of grip orientation, while adaptive deadzones (`0.42 m/s²`) + Zero-Velocity Update (ZUPT) damping eliminate MEMS double-integration drift.
- **Why `Reflow` default + truthful `Lock 3×3` (`motion.css:.grid.is-motion-controlled`)**:
  - At `1.00×` neutral scale, `.is-motion-controlled` is inactive so `index.html` remains pixel-identical to baseline.
  - In `Reflow` mode (`repeat(auto-fill, min(100%, var(--mg-cell-w)))`), cells smoothly shrink down to `140px` contact-sheet thumbnails (`6+` per row) and expand up to `960px` hero cards (`1` per row). `Lock 3×3` keeps 3 columns and caps reported `currentCellW` to the exact 3-column maximum so UI readouts always match rendered DOM widths.

---

## 3. Hazards & Invariants

- **iOS Safari Secure Context (`phone.js`, `ui.js:recomputeQrUrl`)**: `DeviceMotionEvent` is blocked by WebKit over non-HTTPS URLs. `recomputeQrUrl` only accepts `httpsReady` bridge configs, real `https://` origins, or validated user custom URLs (`<= 213` UTF-8 bytes) and wraps `QR.renderSVGElement` in `try/catch` so invalid saved URLs never brick Cell #3.
- **Synchronous iOS permission gesture (`phone.js:refs.enableBtn`)**: `DeviceMotionEvent.requestPermission()` MUST be invoked synchronously inside the button `click` handler before any unrelated `await`.
- **iOS accelerometer sign normalization (`physics.js:MotionProcessor.prototype.ingestMotion`, `physics.js:gravityToTiltDeg`)**: iOS Safari negates `accelerationIncludingGravity` and `acceleration` relative to the W3C spec; `isIOS` normalizes to W3C world-up (`+Z` out of flat face-up glass), and `roll = atan2(-gUnit.x, hypot(gUnit.y, gUnit.z))` maps clockwise wrist twist to `+roll` (enlarge).
- **Hardened local bridge (`server.mjs:handleRequest`, `server.mjs:handleUpgrade`, `server.mjs:generateSelfSignedCert`)**: Safely parses malformed URLs (`400` instead of uncaught `URIError`), rejects `..`, dotfiles (`.git/*`, `.env`), non-allowlisted extensions (`GEMINI.md`, `AGENTS.md`), and symlink escapes via `fs.realpath`, attaches `'error'`/`'close'` handlers on static `fs.createReadStream` streams, validates non-empty `Origin` headers on `/ws` upgrades (`403 Forbidden` to prevent Cross-Site WebSocket Hijacking) and HTTP CORS, rejects unmasked client WS frames (`1002`), enforces `8192B` limits on WS frames and HTTP POST bodies, and removes `fs.mkdtempSync` TLS temp directories in `finally` immediately after loading key/cert buffers.
- **Public MQTT WSS relay trust model (`transport.js:MqttRelayTransport`)**: Zero-backend fallback connects over TLS (`wss://`) to public unauthenticated MQTT brokers (`broker.emqx.io`, `broker.hivemq.com`, `test.mosquitto.org`) under topic `dwg-motion-v1/<sid>/{p2d,d2p}`. Payloads contain only non-sensitive numeric motion/layout state (never credentials or personal data), and random 8-char session IDs (`SESSION_ID_RE = /^[A-Z0-9]{6,12}$/`, blocking MQTT `+`/`#` wildcards) isolate casual rooms; however, public MQTT topics are observable and spoofable by anyone on the broker who discovers `<sid>`. Run `node cells/motion/server.mjs` for origin-checked local WS/HTTPS transport.
- **Clean lifecycle & cross-cell shortcut isolation (`ui.js:mountMotionCell`)**: `mountMotionCell(rootEl)` resolves `window[storeName]` inside `try/catch` (safe under sandboxed/blocked storage getters), skips global `R` reset when any `<dialog open>`, `[data-expanded="true"]`, `.cell-acoustic.is-expanded`, `.lg-is-expanded`, or `main.grid[hidden]` view is active, honors `prefers-reduced-motion: reduce` by snapping scale immediately without queuing `SpringDamper` RAF ticks, and returns an idempotent `unmount()` disposer (also auto-invoked on re-mount).
- **No self-squish at micro cell sizes (`motion.css:@container mg-card`)**: Below `245px` Cell #3 switches to a compact pixel/scale tile (`Reset 100%`), hiding the status pill below `195px` so nothing clips even at `140px × 105px`, while a fixed `.mg-hud` keeps `Reset 100%` (and `Zero` when phone is live) always reachable.

---

## 4. How to Run & Verify

1. **Automated unit, physics, security & relay tests**:
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
