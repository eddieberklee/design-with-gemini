# Cell 07 — M5StickS3 Accelerometer Color Studio (`cells/stick-s3/`)

## 1. Intent & Architecture

`cells/stick-s3/` pairs an **M5Stack M5StickS3** (`ESP32-S3-PICO-1-N8R8`, `ST7789P3` 135×240 IPS LCD, **Bosch BMI270** 6-axis IMU, **M5PM1** PMIC, `KEY1` `GPIO11`, `KEY2` `GPIO12`) directly to an M5StickS3-matched `#101010` obsidian instrument cell (`#cell-stick-s3`) framing a dominant hero color swatch card (`.s3-stage`, `~77%–88%` of cell area) so tilting, flipping, or shaking the physical stick steers the cell's color at 50–60 Hz with pixel-locked color math on both screens.

### Module Ownership & Data Flow

1. **`cells/stick-s3/firmware/src/color_math.h` & `main.cpp` (Flashed Embedded C++ Firmware)**:
   - Initializes `M5Unified` (`board_M5StickS3`) + tear-free 16-bit `M5Canvas` sprite (`135×240` portrait, `KEY1` under thumb) + `BLEDevice` GATT server (`"StickS3-Color"`).
   - Samples the internal BMI270 6-axis accelerometer + gyroscope (`SDA=GPIO47`, `SCL=GPIO48`, `0x68`), negates raw proper-acceleration `imu.accel.x` and `imu.accel.y` (`tiltRightAx = -imu.accel.x`, `tiltUpAy = -imu.accel.y`) so physical right-tilt maps to `+X` (`+tx`) and forward/up-tilt maps to `+Y` (`+ty`) across the LCD/browser Gravity Dome, hue wheel, and 3D twin pitch/roll, applies an EMA filter (`alpha = 0.24`), computes kinetic shake energy, and maps `(tx, ty, az, kin)` into sRGB via `sticks3_color::mapImuToColor`.
   - Streams 50 Hz newline-delimited JSON packets (`{"t":"s3","seq":...}`) over native ESP32-S3 `USB-Serial/JTAG` (`115200`) and 30 Hz BLE GATT Notifications (`beb5483e-36e1-4688-b7f5-ea07361b26a8`), while accepting bidirectional JSON host commands (`mode`, `hold`, `tare`).
   - Physical hardware controls:
     - **`KEY1` (`M5.BtnA`, `GPIO11`) short press**: Freezes/unfreezes color (`HOLD`) and emits `"ev":"swatch"` to pin a Pantone swatch chip into the browser cell.
     - **`KEY1` (`M5.BtnA`) 600 ms long press**: Zeroes/tares `(tx, ty)` to the current grip angle.
     - **`KEY2` (`M5.BtnB`, `GPIO12`) press**: Cycles the 4 color engines (`OKLCH`, `RGB`, `THERM`, `PRISM`) on both the StickS3 LCD and browser cell simultaneously.
2. **`cells/stick-s3/bridge.mjs` (`createStickBridgeServer`)**:
   - Zero-npm-dependency Node HTTP + RFC 6455 WebSocket (`/ws`) + SSE (`/api/stick-s3/stream`) local bridge (`127.0.0.1:8791`, localhost/`file://` `Origin`-guarded) backed by an inline Python 3 stdlib `termios` worker (`CLOCAL | CREAD`, non-blocking `/dev/cu.usbmodem*` auto-discovery).
   - Enables **zero-click live hardware control** immediately upon opening `index.html` over `file://` or `http://localhost`, and exposes `/api/stick-s3/release` + `/claim` so direct browser Web Serial (`navigator.serial`) can claim the USB port on demand without `EBUSY` contention.
3. **`cells/stick-s3/color-engine.js` (`StickS3Color.ColorEngine`)**:
   - Exact JavaScript mirror of `firmware/src/color_math.h` (verified within `<= 1` sRGB LSB across all 4 modes by host `clang++` parity tests in `stick-s3.test.mjs`), perceptual OKLab interpolation (`lerpColorOklab`), and WCAG 2.1 contrast/hysteresis solver (`pickAdaptiveTheme`).
4. **`cells/stick-s3/transport.js` (`StickS3Color.Transport`)**:
   - Unified multi-transport link supporting (a) Local USB Bridge WebSocket + SSE fallback, (b) Direct Browser Web Serial (`0x303A`), and (c) Wireless Web Bluetooth (`4fafc201-1fb5-459e-8fcc-c5c9c331914b`) when running unplugged on battery.
   - Bridge probing is bounded (`transport.js:MAX_BRIDGE_ATTEMPTS = 4` consecutive ws/SSE attempts, then `bridgeProbe: 'stopped'`), never runs while `document.visibilityState === 'hidden'` (a page loaded in a background tab makes zero probes, `bridgeProbe: 'paused'`), and re-arms only through `retryBridge()` (Studio "Retry bridge" button) or the tab becoming visible; a failed or cancelled Web Serial / BLE attempt makes at most one extra probe. `sendCommand` POSTs to the bridge only while its SSE stream is open.
   - `status.connected` means StickS3 telemetry arrived within `HW_FRESH_MS` (3.2 s). `bridge_status.serialConnected` (the bridge merely has a port open) is reported as `bridgePortOpen`, never as connected. The freshness watchdog interval exists only while telemetry is fresh.
   - `connectWebSerial` opens the chooser first; only after a port is picked does it ask the bridge to `/release`, so a cancelled (`NotFoundError`) or denied (`SecurityError`) chooser leaves the bridge and any BLE link untouched.
5. **`cells/stick-s3/ui.js` & `cells/stick-s3/stick-s3.css` (`StickS3Color.UI`)**:
   - Status pill (`ui.js:renderStaticControls`, attribute `data-link`): `held` (HELD), `connecting` (CONNECTING while a Web Serial/BLE chooser is open; buttons disabled), `live` (STICK S3 / S3 USB / S3 BLE, the only green `.is-live` state), `demo` (DEMO ORBIT…), `failed` (USB FAILED / BLE FAILED), `waiting` (USB · NO DATA / BLE · NO DATA), `manual` (TILT PAD, no device). The Studio transport summary keeps the cancel/denied/unavailable reason (`state.linkNote`) until the next action.
   - Mirrors the physical M5StickS3 LCD UI directly in the 4:3 grid cell: `.cell.cell--stick-s3` (`#101010` obsidian bezel, specificity `(0,2,0)` so `index.html`'s inline `.cell { background: #ffffff }` never overrides it) frames a dominant `.s3-stage` hero rounded live color swatch card (`var(--s3-live-hex)` + inline `backgroundColor`) displaying top-corner `OKLCH`/`Lxx` stamps, a clean center tilt reticle, large bottom-left `#HEX` copy stamp, and bottom-bar coral/emerald/cobalt `X/Y/Z` center-zero telemetry bars, plus the `<dialog class="s3-dialog">` Studio Workbench with CSS-3D rotating StickS3 twin, live `135×240` LCD mirror `<canvas>`, 60-sample 3-axis oscilloscope, and untainted `<canvas>` PNG Tear-Sheet exporter.

---

## 2. Design & Technical Decisions (Protocol B Best-of-3 Synthesis)

Three initial candidates were evaluated and refined with direct user feedback to mirror the physical M5StickS3 screen UI:
- **StickS3 Obsidian Bezel + Hero Color Swatch Card (Shipped)**: Uses `.cell.cell--stick-s3` (`#101010` obsidian bezel, specificity `(0,2,0)` so `index.html`'s `.cell { background: #ffffff }` never overrides it) around a dominant `.s3-stage` rounded pigment card (`~77%–88%` of cell area, `94.7%` unobstructed) with direct corner stamps (`OKLCH`, `Lxx`, `#HEX`, `C·H°`), a compact center circular tilt reticle, bottom-bar coral/emerald/cobalt `X/Y/Z` center-zero telemetry bars, and Pantone swatch chips; matte Swiss paper capsules (`rgba(255, 255, 255, 0.93)`) are used inside `<dialog class="s3-dialog">` (`.s3-hero-pill`).
- **Static White Bezel (`swiss_colorimeter_bezel`)**: Rejected because a bright white outer bezel competed with light OKLCH tints instead of matching the physical StickS3's `#101010` screen contrast.
- **In-Grid 3D Stick Brick (`spatial_3d_wand_studio`)**: Rejected for the small 4:3 card because the dark 3D hardware silhouette occluded the color field at narrow container widths, and promoted instead to the left column of the expanded `<dialog>` Studio Workbench.

---

## 3. Hazards, Invariants & Edge Cases

- **M5StickS3 Download Mode (`boot:0x20`) & Watchdog Reset (`firmware/post_upload_reset.py`)**: Entering first-flash Download Mode via long-pressing the side power button (M5PM1 PMIC + `USB-Serial/JTAG` `303A:1001`) can leave the ESP32-S3 in `boot:0x20 (DOWNLOAD(USB/UART0))` across standard RTS `hard_reset` pulses, and opening `/dev/cu.usbmodem*` with `DTR=1` -> `RTS=1` re-latches `IO0=0`. `post_upload_reset.py` runs `esptool.py --after watchdog_reset` post-upload to boot SPI flash cleanly, and `bridge.mjs` opens `/dev/cu.usbmodem*` via `O_NOCTTY | O_NONBLOCK` + `CLOCAL` without pulsing modem lines.
- **WCAG AA Contrast Floor & Hysteresis (`color-engine.js:pickAdaptiveTheme`, `firmware/src/main.cpp:renderInstrumentScreen`)**: Using `#141413` (`L=0.0070`) as dark reticle ink drops contrast to `4.31:1` near the IEC crossover (`Y = 0.1791`, e.g., `rgb(102,102,255)`). Shipped dark reticle ink uses `#000000` (`L=0.0`, and `0x0000u` vs `0xFFFFu` at threshold `0.1791f` on the physical LCD), guaranteeing `>= 4.58:1` WCAG AA at the `0.1791` IEC crossover and `>= 4.50:1` across all `16,777,216` sRGB colors. Because `crDark >= 4.5` requires `Y >= 0.1750` and `crLight >= 4.5` requires `Y <= 0.1833`, enforcing the strict `>= 4.5:1` floor clamps the nominal Schmitt-trigger thresholds (`0.168 .. 0.192`) to an effective bi-stable hysteresis band of `[0.1750, 0.1833]`, preventing 50 Hz reticle polarity flicker.
- **450 ms Optimistic Command Leases & Swatch Pinning (`ui.js:mountStickS3Cell`)**: Outbound `mode` and `hold` commands set a `450 ms` optimistic command lease (`COMMAND_LEASE_MS = 450` via `pendingModeUntil`, `pendingHoldUntil`, covering both USB-Serial and BLE GATT RTTs). During `pendingModeUntil`, incoming IMU vectors are mapped locally with `ColorEngine.mapImuToColor` under `state.mode` so in-flight packets never flash the previous mode's color; clicking a captured swatch sets `pinnedCustomSwatch` alongside `hold` so 50 Hz telemetry packets never overwrite a previewed swatch until unheld or overridden by physical `KEY1` (`BtnA`).
- **BLE GATT MTU & Core-1 Spinlock Command Queue (`firmware/src/main.cpp:setupBle`, `transport.js:createStickLink`)**: `setupBle` negotiates `BLEDevice::setMTU(247)` and clamps newline-delimited JSON payloads while `transport.js` reassembles BLE notifications and serializes GATT writes. Bluedroid callbacks on Core 0 enqueue incoming BLE commands and connection state transitions inside a `portMUX_TYPE` spinlock critical section (`portENTER_CRITICAL` / `portEXIT_CRITICAL`), draining them exclusively on Core 1 at the top of `loop()` to eliminate cross-core state/display/speaker races.
- **Localhost Origin + Host Guard (`bridge.mjs:createStickBridgeServer`)**: HTTP requests and WebSocket `/ws` upgrades restrict `Origin` to local contexts (missing `Origin`, `'null'` from `file://`, `http(s)://localhost`, `http(s)://127.0.0.1`, and `http(s)://[::1]`) and require a loopback `Host` (`isAllowedHost`, DNS-rebinding guard). CORS headers (`setCors`) are sent only on `/api/stick-s3/*`; static files get none, and any path segment starting with `.` (`.git/`, `.claude/`) is a 404. Residual risk, by design: `Origin: null` must stay allowed for `file://`, so a sandboxed iframe on any site can still use the API (send mode/hold/tare, ingest fake telemetry, `/release`). The helper's stdin has an `error` handler (EPIPE after the helper dies used to crash the bridge) and respawning stops after 5 exits within 5 s each (`/claim` re-arms).
- **Axis sign (`firmware/src/main.cpp:loop`)**: the firmware negates raw `accel.x` and `accel.y` before smoothing, so telemetry `ax/tx` = right and `ay/ty` = up. `color-engine.js:parseTelemetryLine`, `bridge.mjs` and `ui.js` pass them through unchanged; the tilt pad and demo presets use the same convention (`stick-s3.test.mjs` "axis sign contract").

---

## 4. How to Run, Flash & Verify

```bash
# 1. Syntax & unit/parity/WCAG/bridge tests (includes host clang++ C++ <-> JS color parity check)
node --check cells/stick-s3/color-engine.js
node --check cells/stick-s3/transport.js
node --check cells/stick-s3/ui.js
node --check cells/stick-s3/bridge.mjs
timeout 120 node --test "cells/stick-s3/*.test.*"   # stick-s3 + transport + bridge suites; no serial port or python3 used

# 2. Compile & flash physical M5StickS3 over USB-C
pio run -d cells/stick-s3/firmware -t upload --upload-port /dev/cu.usbmodem1101

# 3. Start zero-click local USB serial -> WebSocket/SSE bridge (http://127.0.0.1:8791)
node cells/stick-s3/bridge.mjs
```
