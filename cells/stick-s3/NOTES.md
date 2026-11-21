# Cell 07 — M5StickS3 Accelerometer Color Studio (`cells/stick-s3/`)

## 1. Intent & Architecture

`cells/stick-s3/` pairs an **M5Stack M5StickS3** (`ESP32-S3-PICO-1-N8R8`, `ST7789P3` 135×240 IPS LCD, **Bosch BMI270** 6-axis IMU, **M5PM1** PMIC, `KEY1` `GPIO11`, `KEY2` `GPIO12`) directly to a full-bleed chromatic grid cell (`#cell-stick-s3`) so tilting, flipping, or shaking the physical stick steers the cell's color at 50–60 Hz with pixel-locked color math on both screens.

### Module Ownership & Data Flow

1. **`cells/stick-s3/firmware/src/color_math.h` & `main.cpp` (Flashed Embedded C++ Firmware)**:
   - Initializes `M5Unified` (`board_M5StickS3`) + tear-free 16-bit `M5Canvas` sprite (`135×240` portrait, `KEY1` under thumb) + `BLEDevice` GATT server (`"StickS3-Color"`).
   - Samples the internal BMI270 6-axis accelerometer + gyroscope (`SDA=GPIO47`, `SCL=GPIO48`, `0x68`), applies an EMA filter (`alpha = 0.24`), computes kinetic shake energy, and maps `(tx, ty, az, kin)` into sRGB via `sticks3_color::mapImuToColor`.
   - Streams 50 Hz newline-delimited JSON packets (`{"t":"s3","seq":...}`) over native ESP32-S3 `USB-Serial/JTAG` (`115200`) and 30 Hz BLE GATT Notifications (`beb5483e-36e1-4688-b7f5-ea07361b26a8`), while accepting bidirectional JSON host commands (`mode`, `hold`, `tare`).
   - Physical hardware controls:
     - **`KEY1` (`M5.BtnA`, `GPIO11`) short press**: Freezes/unfreezes color (`HOLD`) and emits `"ev":"swatch"` to pin a Pantone swatch chip into the browser cell.
     - **`KEY1` (`M5.BtnA`) 600 ms long press**: Zeroes/tares `(tx, ty)` to the current grip angle.
     - **`KEY2` (`M5.BtnB`, `GPIO12`) press**: Cycles the 4 color engines (`OKLCH`, `RGB`, `THERM`, `PRISM`) on both the StickS3 LCD and browser cell simultaneously.
2. **`cells/stick-s3/bridge.mjs` (`createStickBridgeServer`)**:
   - Zero-npm-dependency Node HTTP + RFC 6455 WebSocket (`/ws`) + SSE (`/api/stick-s3/stream`) local bridge (`127.0.0.1:8791`, CORS `*`) backed by an inline Python 3 stdlib `termios` worker (`CLOCAL | CREAD`, non-blocking `/dev/cu.usbmodem*` auto-discovery).
   - Enables **zero-click live hardware control** immediately upon opening `index.html` over `file://` or `http://localhost`, and exposes `/api/stick-s3/release` + `/claim` so direct browser Web Serial (`navigator.serial`) can claim the USB port on demand without `EBUSY` contention.
3. **`cells/stick-s3/color-engine.js` (`StickS3Color.ColorEngine`)**:
   - Exact JavaScript mirror of `firmware/src/color_math.h` (verified within `<= 1` sRGB LSB across all 4 modes by host `clang++` parity tests in `stick-s3.test.mjs`), perceptual OKLab interpolation (`lerpColorOklab`), and WCAG 2.1 contrast/hysteresis solver (`pickAdaptiveTheme`).
4. **`cells/stick-s3/transport.js` (`StickS3Color.Transport`)**:
   - Unified multi-transport link supporting (a) Local USB Bridge WebSocket + SSE fallback, (b) Direct Browser Web Serial (`0x303A`), and (c) Wireless Web Bluetooth (`4fafc201-1fb5-459e-8fcc-c5c9c331914b`) when running unplugged on battery.
5. **`cells/stick-s3/ui.js` & `cells/stick-s3/stick-s3.css` (`StickS3Color.UI`)**:
   - Full-bleed living pigment grid cell + Leica/Braun SVG Gravity Dome + `<dialog class="s3-dialog">` Studio Workbench with CSS-3D rotating StickS3 twin, live `135×240` LCD mirror `<canvas>`, 60-sample 3-axis oscilloscope, and untainted `<canvas>` PNG Tear-Sheet exporter.

---

## 2. Design & Technical Decisions (Protocol B Best-of-3 Synthesis)

Three divergent candidates were evaluated by an independent Design & Color-Science Critic:
- **Candidate A (`full_bleed_adaptive_glass` — Winner, synthesized)**: Floods the entire `.cell--stick-s3` background edge-to-edge with the live accelerometer color so the cell itself acts as a visceral block of living pigment in the grid.
- **Candidate B (`swiss_colorimeter_bezel` — Runner-up)**: Framed pigment inside a static white bezel; rejected as primary layout because a static outer frame diluted the sensation of directly coloring the grid cell, though its **constant D65 Matte Swiss Paper capsules** (`rgba(255, 255, 255, 0.93)`) and **Pantone swatch chips** were merged into Candidate A to eliminate HUD polarity strobing.
- **Candidate C (`spatial_3d_wand_studio` — Runner-up)**: Placed a dark 3D stick brick over the in-grid cell; rejected for the small 4:3 card because the dark hardware silhouette occluded the color field at narrow container widths, and promoted instead to the left column of the expanded `<dialog>` Studio Workbench.

---

## 3. Hazards, Invariants & Edge Cases

- **M5StickS3 Download Mode (`boot:0x20`) & Watchdog Reset (`firmware/post_upload_reset.py`)**: Entering first-flash Download Mode via long-pressing the side power button (M5PM1 PMIC + `USB-Serial/JTAG` `303A:1001`) can leave the ESP32-S3 in `boot:0x20 (DOWNLOAD(USB/UART0))` across standard RTS `hard_reset` pulses, and opening `/dev/cu.usbmodem*` with `DTR=1` -> `RTS=1` re-latches `IO0=0`. `post_upload_reset.py` runs `esptool.py --after watchdog_reset` post-upload to boot SPI flash cleanly, and `bridge.mjs` opens `/dev/cu.usbmodem*` via `O_NOCTTY | O_NONBLOCK` + `CLOCAL` without pulsing modem lines.
- **WCAG AA Contrast Floor & Hysteresis (`color-engine.js:pickAdaptiveTheme`)**: Using `#141413` (`L=0.0070`) as dark reticle ink drops contrast to `4.31:1` near the IEC crossover (`Y = 0.1791`, e.g., `rgb(102,102,255)`). Using `#080808` (`L=0.0024`) guarantees `>= 4.53:1` WCAG AA across all `16,777,216` sRGB colors, while Schmitt-trigger hysteresis (`0.168 .. 0.192`) prevents 50 Hz reticle flicker.
- **50 Hz Optimistic Command Leases (`ui.js:mountStickS3Cell`)**: Outbound `mode` and `hold` commands set a `260 ms` lease (`pendingModeUntil`, `pendingHoldUntil`) so in-flight serial frames from the StickS3 never snap browser UI controls backward before hardware round-trip acknowledgement.

---

## 4. How to Run, Flash & Verify

```bash
# 1. Syntax & unit/parity/WCAG/bridge tests (includes host clang++ C++ <-> JS color parity check)
node --check cells/stick-s3/color-engine.js
node --check cells/stick-s3/transport.js
node --check cells/stick-s3/ui.js
node --check cells/stick-s3/bridge.mjs
timeout 60 node --test cells/stick-s3/stick-s3.test.mjs

# 2. Compile & flash physical M5StickS3 over USB-C
pio run -d cells/stick-s3/firmware -t upload --upload-port /dev/cu.usbmodem1101

# 3. Start zero-click local USB serial -> WebSocket/SSE bridge (http://127.0.0.1:8791)
node cells/stick-s3/bridge.mjs
```
