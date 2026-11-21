# iPhone Motion Grid Controller (`cells/motion/`)

Interactive Cell #3 prototype mounted into `#cell-motion` in [index.html](../../index.html). Displays a scannable QR code that opens a standalone mobile web controller (`phone.html`) on an iPhone and uses the phone's accelerometer and orientation sensors (rotate/tilt, raise up/down, or pull/push) to dynamically resize every cell in the desktop grid in real time.

---

## 1. Intent & Architecture

Zero-build, zero-dependency browser + Node architecture matching `cells/decisions/` (classic `<script defer>` scripts so `index.html` works over `file://`, `http://localhost`, and `https://`):

| File | Responsibility |
| :--- | :--- |
| [qr.js](qr.js) | Self-contained ISO/IEC 18004 Byte-mode QR encoder (Versions 1–10, EC Level M, GF(256) Reed-Solomon, 8-mask penalty evaluation) rendering crisp inline SVG with a 4-module quiet zone (`window.MotionGrid.QR`). |
| [physics.js](physics.js) | Shared sensor-fusion and physics core (`window.MotionGrid.Physics`): exponential low-pass `GravityFilter`, continuous tilt extraction, gravity-projected world-up (`Lift`) and orthogonal screen-normal (`Pull`) ZUPT velocity integrators, and critically damped `SpringDamper` for 60fps desktop layout smoothing. |
| [transport.js](transport.js) | Dual-path real-time link (`window.MotionGrid.Transport`): minimal pure-JS MQTT 3.1.1 over WSS relay (`wss://broker.emqx.io:8084/mqtt` with HiveMQ/Mosquitto failover) plus same-origin local WebSocket (`/ws`) and HTTP POST/SSE fallback (`LocalBridgeTransport`). |
| [ui.js](ui.js) | Desktop Cell #2 card, large Pairing Studio `<dialog>`, auto-discovery of local HTTPS bridge (`/api/motion-config`), live 3-axis meters, desktop scale scrub simulator, floating resize HUD, and `--mg-cell-w` grid controller. |
| [motion.css](motion.css) | Strictly scoped under `.cell--motion`, `.mg-*`, `.mg-dialog`, `.mg-hud`, and opt-in `.grid.is-motion-controlled` (`Reflow` and `Lock 3×3` modes) with `@container mg-card` micro-cell adaptation down to `140px`. |
| [phone.html](phone.html), [phone.css](phone.css), [phone.js](phone.js) | One-handed dark-instrument iPhone web app with iOS `DeviceMotionEvent.requestPermission()` gesture gate, radial scale dial, bubble reticle, `All / Tilt / Lift / Pull` gesture modes, `Clutch` ratchet mode, `Zero Pose`, `Reset 100%`, Screen Wake Lock, and manual trim slider. |
| [server.mjs](server.mjs) | Zero-dependency Node HTTPS + RFC 6455 WebSocket + SSE/POST local bridge (`node cells/motion/server.mjs`) that auto-detects/launches an `ngrok` trusted HTTPS tunnel and falls back to ephemeral self-signed LAN TLS in `os.tmpdir()`. |

---

## 2. Design & Technical Decisions

- **Why dual-path transport (Local WS/HTTPS + MQTT 3.1.1 over WSS)**:
  - Works completely backend-free when hosted on any static HTTPS host (GitHub Pages, Vercel, Netlify, Tailscale Serve) via pure-JS MQTT over WSS (`~100ms` RTT, works across Wi-Fi and 5G cellular).
  - Automatically upgrades to `< 5ms` same-origin WebSocket (with HTTP POST/SSE fallback for self-signed iOS Safari sessions) whenever `node cells/motion/server.mjs` is running.
- **Why world-up gravity projection + ZUPT (`physics.js:MotionProcessor.prototype.ingestMotion`)**:
  - Raw `event.acceleration.z` only means "up" when the phone is perfectly flat. Projecting linear acceleration onto the low-pass unit gravity vector $\hat{g}$ ensures **raising up / lowering down** works regardless of how the user holds the iPhone.
  - Pure double-integration of MEMS accelerometers drifts quadratically within seconds; pairing an adaptive noise deadzone (`0.42 m/s²`) with Zero-Velocity Update (ZUPT) exponential damping converts intentional lift/pull motions into crisp relative cell-size changes with zero idle drift.
- **Why `Reflow` default + `Lock 3×3` toggle (`motion.css:.grid.is-motion-controlled`)**:
  - At `1.00×` neutral scale, `.is-motion-controlled` is inactive so `index.html` remains pixel-identical to baseline.
  - In `Reflow` mode (`repeat(auto-fill, min(100%, var(--mg-cell-w)))`), cells smoothly shrink down to `140px` contact-sheet thumbnails (`6+` per row) and expand up to `960px` full hero cards (`1` per row) while every intermediate pixel visibly resizes every tile. `Lock 3×3` preserves strict 3-column topology for scaling within the 3×3 grid.

---

## 3. Hazards & Invariants

- **iOS Safari Secure Context (`phone.js`)**: `DeviceMotionEvent` and `DeviceOrientationEvent` are blocked by WebKit over non-HTTPS LAN URLs (`http://192.168.x.x`). `ui.js:recomputeQrUrl` never silently emits a broken `file://` or `localhost` QR URL; it resolves real `https://` origins, probes `server.mjs`'s `/api/motion-config`, or prompts the user to run `node cells/motion/server.mjs` or supply a hosted HTTPS URL.
- **Synchronous iOS permission gesture (`phone.js:enableBtn`)**: `DeviceMotionEvent.requestPermission()` MUST be invoked synchronously inside the button `click` handler before any unrelated `await`.
- **iOS accelerometer sign inversion (`physics.js:MotionProcessor.prototype.ingestMotion`)**: iOS Safari negates `accelerationIncludingGravity` and `acceleration` relative to the W3C / Android spec; `isIOS` normalizes signs so clockwise tilt and upward lift consistently grow cells across devices.
- **No self-squish at micro cell sizes (`motion.css:@container mg-card`)**: Because Cell #2 shrinks itself along with the grid, below `245px` it automatically swaps out the QR grid for a high-contrast tabular pixel/scale tile with a `Reset 100%` button, and a fixed bottom-right `.mg-hud` keeps reset/zero reachable even if cells expand past the viewport.

---

## 4. How to Run & Verify

1. **Automated unit & relay tests**:
   ```bash
   node --test cells/motion/motion.test.mjs
   ```
2. **Syntax check all browser scripts**:
   ```bash
   node --check cells/motion/qr.js && node --check cells/motion/physics.js && node --check cells/motion/transport.js && node --check cells/motion/ui.js && node --check cells/motion/phone.js && node --check cells/motion/server.mjs
   ```
3. **Live iPhone test (1 command)**:
   ```bash
   node cells/motion/server.mjs
   ```
   Open `http://localhost:8443` on desktop, scan the QR code in Cell #2 with your iPhone Camera, tap **Enable Motion**, and rotate, raise up/down, or pull the phone to smoothly resize the grid cells.
