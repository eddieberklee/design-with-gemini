# Secondary Grid Cell 07 — iPhone Spinning Dial Control (`cells/left-grille/iphone-dial.*`)

## 1. Intent & Architecture

Secondary Grid Cell 07 (`#lg-sec-cell-7`) turns an iPhone lying flat on the desk next to the MacBook into a precision **24-detent rotary encoder knob** (`0–360°`, `RPM`, unwrapped `turns`, and normalized `0–100` control value) with three real-time connectivity paths and an immediate desktop circular drag-to-spin platter:

- `cells/left-grille/iphone-dial.js`:
  - `RotaryDialTracker`: Pure gravity-projected 3D gyroscope + compass rotary physics engine exported via UMD (`module.exports` in Node, `window.LeftGrilleDial` and `window.LeftGrilleLab.RotaryDialTracker` in browser).
  - `parseBleRotaryPayload` & `resolveDialPhoneUrl`: Web Bluetooth Nordic UART / binary angle packet decoder and QR target URL resolver.
  - `mountIphoneDialCell`: Registers into `window.LeftGrilleLab` Slot `7` (`id: 'iphone-dial'`, `title: 'iPhone Spin Dial'`).
- `cells/left-grille/iphone-dial.css`: (1) `.id-cell` on the shared tile frame (left-grille `NOTES.md` "Sensor cell frame"): `.id-stage` is a `.lg-cell-stage` column of `ui-tile-head` (index `07`, "iPhone dial", status `ui-pill` `.id-led.id-pill` with its label `.id-status-text`, Pair QR + BLE `ui-btn--sm`), `ui-tile-body` (hero: the dial in a `ui-well` with angle + turns in its hub; quiet Value and Speed readouts; the QR panel `.id-qr-overlay` covers the body only) and `ui-tile-foot` (`Sim` label, +360° / −180° quiet buttons, Zero, link meta). SVG colours are `--ui-` tokens; QR colours read the tokens once per mount (`readQrColours`). Size steps `@container ui-tile`: `< 320px` (base hides the foot) shows "Widen for Sim", `< 240px` is header + dial only. (2) `.dp-body`, the phone page, on `../../ui/base.css` tokens: light paper by default, a dark token set under `[data-theme="dark"]`, 44 px touch targets.
- `cells/left-grille/dial-phone.html` & `cells/left-grille/dial-phone.js`: Standalone mobile controller page that reuses `cells/motion/transport.js` (`window.MotionGrid.Transport`) and `RotaryDialTracker`, featuring a 1-tap iOS 13+ gyroscope permission gate, counter-rotated upright digital readout (`rotate(-angleDeg)`), 24-detent Web Audio micro-tick synthesis, and a circular touch-ring fallback.
- `cells/left-grille/iphone-dial.test.js`: Node test suite (`node --test`) verifying CW/CCW spin integration, face-up vs face-down vs tilted-desk gravity projection, `0.00°/min` stationary drift rejection, `360°` wrap/unwrap, 24-detent click hysteresis, O(1) detents for huge deltas (run in a `vm` with a timeout), BLE payload decoding, the desktop relay link lifecycle with fake timers (test `10b`), and `dial-phone.js` VM execution (session, status, bounded desktop wait, retry, hidden page, bfcache, no-sensor probe).

---

## 2. Physics & Multi-Transport Design Decisions

1. **Gimbal-Lock-Free Gravity-Projected Desk Spin (`projectDeskSpinRate` & `RotaryDialTracker.prototype.ingestMotion`)**:
   - Rather than relying on Euler orientation angles (`alpha`/`beta`/`gamma`) which suffer from gimbal lock or compass interference near laptop speakers/MagSafe magnets, `RotaryDialTracker` low-pass filters `accelerationIncludingGravity` (minus linear `acceleration`) into a unit surface-normal vector $\hat{g} = [g_x, g_y, g_z] / |\vec{g}|$ and projects the 3-axis gyroscope rate vector $\vec{\omega} = [\beta, \gamma, \alpha]$ directly onto $\hat{g}$:
     $$\omega_{\text{proj}} = \beta \hat{g}_x + \gamma \hat{g}_y + \alpha \hat{g}_z$$
   - Because flipping the iPhone face-down reverses both the device Z-axis gyroscope rate (`alpha`) and the Z-component of the gravity vector ($\hat{g}_z$), their dot product $\vec{\omega} \cdot \hat{g}$ preserves identical clockwise/counter-clockwise polarity whether the phone lies **face-up**, **face-down**, or on a **tilted laptop stand**.
2. **Stationary Zero-Velocity Bias Removal (`< 0.8 deg/s` Deadband)**:
   - When $|\omega_{\text{proj}}| < 1.16\text{ deg/s}$ and total 3-axis rotation magnitude is quiet for $\ge 80\text{ ms}$, an adaptive bias tracker estimates the MEMS gyro offset `gyroBias`. Any residual rate below `STATIONARY_DEADBAND_DEG_PER_SEC = 0.8 deg/s` is hard-clamped to `0`, guaranteeing **exact `0.00°/min` drift** while the phone sits untouched on the desk.
3. **Hysteresis-Protected 24-Detent Click Ladder (`DETENT_STEP_DEG = 15`)**:
   - Detent transitions occur when `cumulativeDeg` crosses `(detentIndex ± 1) * 15°`. Advancing `detentIndex` shifts the reference center by `15°`, creating an inherent `15°` reversal deadband right at each click threshold so boundary micro-tremors never double-trigger ticks while delivering exact `24` clicks per `360°` revolution in both CW and CCW directions.

---

## 3. Hazards, Invariants & Edge Cases

- **Strict `4:3` Lock & Narrow Ergonomics**: the slot is the tile (`.cell.ui-tile`, `overflow: hidden`) and `.id-stage` is absolute `inset: 0` via `.lg-cell-stage`, so neither the dial SVG nor the QR panel inflates row height. Below `320px` the QR hint and SID hide; below `240px` the panel is the QR code only. The panel's Close (`Esc`) returns to the dial.
- **Reduced Motion & Contrast**: `@media (prefers-reduced-motion: reduce)` drops the value-bar and phone-button transitions, and `mountIphoneDialCell` skips `startInertialFlywheel()` under reduced motion. Phone dark tokens: `--ui-ink-3` `#a3a39b` (6.9:1 on `#1b1b19`), `--ui-accent` `#ef8a5c`, `--ui-positive` `#4cc796`.
- **Storage Keys & Session ID Namespace Isolation**:
  - `localStorage` key `dwg.iphoneDialHost.v1`: Persists custom LAN IP or HTTPS tunnel host override (`STORAGE_HOST_KEY`, wrapped in `try/catch`).
  - `sessionStorage` key `dwg.iphoneDialSid.v1`: Persists the `'DL'`-prefixed 8-character uppercase alphanumeric session ID (`STORAGE_SID_KEY`, validated via `MotionGrid.Transport.isValidSessionId`), preventing topic collisions with Main Grid Cell 03. In `dial-phone.js`, a missing or invalid `?s=` opens **no** link (there is no shared fallback room) and the status reads `NO SESSION · RESCAN QR`.
- **Desktop Relay Link Lifecycle (`mountIphoneDialCell:wantLink`, `syncLink`, `startPairingWindow`, `syncHeartbeat`, `onVisibilityChange`)** — the same resident-cost rules as `cells/motion/ui.js`:
  - Opening the secondary page opens no socket and starts no timer (only the one-shot same-origin `/api/motion-config` probe on `http(s)`). The link to the public MQTT broker exists only while the page is open and visible, the QR target is phone-reachable (`isScannable`: not the `fallback` URL, not `localhost`; on `file://` the user must enter a LAN host), and either a phone is paired or a pairing window runs.
  - `PAIR QR` starts one `PAIR_WINDOW_MS = 90 s` window. No phone packet in that window → the link closes and the status reads `PAIR TIMEOUT · QR`. A dropped phone (`PHONE_TIMEOUT_MS = 7 s` of silence) gets one more window, then the link closes.
  - While a phone is paired and the tab is visible, a `HEARTBEAT_MS = 1.5 s` interval checks phone liveness and sends `{ t: 'hb' }` so the phone can show `LIVE` truthfully. `hello` is answered with `{ t: 'state' }`; the first packet of any other type is answered with `{ t: 'hb' }` (presence only, so the phone's own value is not overwritten).
  - `createLink` reporting `failed` (every sub-link hit its retry ceiling) releases the link: `RELAY OFFLINE · PAIR QR`. Retry = `PAIR QR` or the tab becoming visible again.
  - Hidden tab: link, heartbeat, pairing window, inertia and the click `AudioContext` stop. Visible: only what hiding suspended resumes, with a fresh pairing window.
  - Only `lg-secondary-open` / `lg-secondary-close` drive the session. There are no `popstate`/`hashchange` listeners: they fire after `lg-secondary-close` while `LeftGrilleLab.isSecondaryOpen()` still reads `true` (deferred view transition) and used to re-open the broker link on the main grid.
  - Status text (all through `setStatus(text, tone, tip)`): `IPHONE · WS/WSS` green `ok` (the only green: a paired phone answering), `BLE LIVE` rust (a knob is linked but the green rule names only the phone), `WAITING · SCAN QR` idle grey, `LINKING…` / `BLE PAIRING…` rust (pairing in progress), `RELAY OFFLINE · PAIR QR`, `NO LINK · SET HOST`, `PAIR TIMEOUT · QR`, `BLE N/A · USE QR`, `BLE RETRY / QR` rust, else `READY` idle. Footer: `WSS <SID>` only while a link exists, else `NO LINK`. Tooltips: `data-tip` on the pill (per state), Pair QR (open/close), BLE (on/off), Zero, both Sims, the fine toggle, the dial (keycap `Z`: the Z/0 shortcut is bound only on the focused dial), Value, Speed, link meta, and in the QR panel SID, host input, Copy URL and Close (`Esc`). No `title` attributes.
- **Remote Input Bounds (`RotaryDialTracker.prototype._advanceAngle`, `handlePhonePacket:remoteNum`)**: detent stepping is closed-form (`Math.floor/ceil`), so any delta costs O(1); the old `while` loops let one relay packet with `deltaDeg: 1e12` hang the tab. Phone fields are clamped (`deltaDeg` ±3600, angles ±1e7, `detentIndex` rounded, `detentSlot`/`turns`/`rpm` derived from them).
- **Phone Page Link (`dial-phone.js:connect`, `renderStatus`, `onLinkTick`)**: `LIVE · <path>` only while desktop messages (`state`, `cmd`, `hb`) arrived within `DESKTOP_SILENCE_MS = 6 s`; relay up without a desktop reads `WAIT DESKTOP · <path>`. One `LINK_TICK_MS = 2.5 s` interval runs only while the link is ready and the page visible: it sends `hb` while the desktop answers, otherwise re-sends `hello` at most `HELLO_MAX_TRIES = 8` times and then closes the link (`NO DESKTOP · TAP`). `failed` → `OFFLINE · TAP`. Tapping the status (`#dp-status` is a button) or the page becoming visible reconnects; a hidden page closes the link; `pageshow` with `persisted` (back/forward cache) reconnects after `pagehide` closed it. Phone look (`dial-phone.html`): status is a `ui-pill` button with a 44 px hit area (`button.dp-status::after`), grey while `LINKING` / `WAIT DESKTOP`, green only for `LIVE`, rust for `NO SESSION · RESCAN QR`, `NO TRANSPORT`, `PAUSED · TAP`, `NO DESKTOP · TAP`, `OFFLINE · TAP`; the gyroscope gate (and the no-gyroscope note) is an opaque disc over the wheel. Detent tick colours are CSS classes (`.dp-tick`, `.is-active`), not stroke attributes. No hover tooltips on the phone.
- **Velocity Readout at Rest (`mountIphoneDialCell:settleVelocity`, `dial-phone.js:settleVelocity`)**: `RotaryDialTracker` only decays `degPerSec` when new samples arrive, so discrete inputs (arrow keys, wheel, drag release, end of `Spin ±`, end of the flywheel, touch-ring release on the phone) zero the velocity explicitly; otherwise one `ArrowRight` left `56.8 RPM` on screen.
- **Phone No-Sensor Probe (`dial-phone.js:onSensorProbeTimeout`)**: `Enable Gyroscope` on a browser without a gyroscope (desktop, insecure page) re-opens the gate after `SENSOR_PROBE_MS = 2.5 s` with "No gyroscope data…" and removes the motion listeners, instead of leaving a dead dial.
- **Phone Handshake & `pagehide` Cleanup**: On transport ready, `dial-phone.js` sends `{ t: 'hello' }` without blasting default `{ dialValue: 50, fineMode: false }` telemetry, preserving the desktop's `dialValue` and `fineMode` until it replies with `{ t: 'state' }`. On `pagehide` it cancels inertial `rAF` and closes the link and `AudioContext`. `iphone-dial.css` sets `box-sizing: border-box` under `.dp-body` (the page has no reset; the padded `100dvh` app overflowed by 24 px at 390×844).
- **Lifecycle & BLE Async Race Guard**:
  - Full Teardown on `lg-secondary-close`: `onSecondaryClose()` stops inertial `requestAnimationFrame` loops, closes the QR popover, aborts any in-flight `/api/motion-config` fetch, stops the pairing window and heartbeat, closes `link`, closes `clickSynth` (`AudioContext`), and calls `disconnectBle()`.
  - Monotonic `bleEpoch` Race Guard: `disconnectBle()` increments `bleEpoch`, removes the named `gattserverdisconnected` and `characteristicvaluechanged` listeners, and disconnects GATT even if `handleBleClick()` is mid-flight (`await requestDevice`, `gatt.connect`, `getPrimaryService`, `getCharacteristic`, or `startNotifications`).

---

## 4. Verification

```bash
node --check cells/left-grille/iphone-dial.js && \
node --check cells/left-grille/dial-phone.js && \
timeout 60 node --test cells/left-grille/iphone-dial.test.js
```

Browser: open `index.html#left-grille` and count `WebSocket` constructions: none on open; `Pair QR` on `file://` shows `NO LINK · SET HOST` and still none; entering a LAN host opens one broker socket. Close the page (`Esc`) and confirm no socket is created afterwards. `dial-phone.html` without `?s=` must create no socket.
