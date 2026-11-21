# Secondary Grid Cell 06 — MacBook Lid Angle Sensor (`cells/left-grille/lid-angle.*`)

## 1. Intent & Architecture

Secondary Grid Cell 06 (`#lg-sec-cell-6`) implements a dual-mode **MacBook Lid Angle Sensor** (`0°–135°`) registered into `window.LeftGrilleLab` slot `6`:

| File | Responsibility |
| :--- | :--- |
| `cells/left-grille/lid-angle.js` (`LeftGrilleLidAngle`) | UMD DSP core (`LidSonarEstimator`, `LidCalibration`, `LidAngleKalman`, `generateLidPingBlock`, `fftRadix2`, `synthesizeScreenBounceFrame`), shared-bus slot `6` registration, quiet `127.0.0.1:8791` HID probe + SSE consumer, side-elevation hinge SVG renderer, and pointer/keyboard drag scrubbing. |
| `cells/left-grille/lid-angle.css` | Strictly `.la-cell` / `.la-stage`-scoped Swiss/Braun styles with `position: absolute; inset: 0` strict `4:3` lock and `@container` breakpoints down to `150px`. |
| `cells/left-grille/lid-bridge.mjs` | Zero-npm-dependency Node HTTP + SSE server (`127.0.0.1:8791`) compiling/caching a tiny `os.tmpdir()` Swift IOKit reader for Apple's hardware `LidAngleSensor` (`0x05AC:0x8104`, UsagePage `0x0020`, Usage `0x008A`, 3-byte feature report `[0x01, lo, hi]`). |
| `cells/left-grille/lid-angle.test.js` | Deterministic `node --test` suite covering TX spectral containment & `< 40 kHz` silence, monotonic acoustic estimation (`35° < 75° < 120°`), volume/polarity invariance, `'chirp'` piggyback mode, 2-point calibration math & `dwg.lidAngleCal.v1` persistence, Kalman filtering, and `lid-bridge.mjs` HTTP/SSE + syntax checks. |

### Dual-Mode Data Flow

1. **Mode A — Pure-Browser Acoustic Screen-Bounce Sonar (`18.2–20.4 kHz`)**:
   - Registers TX mode `'lid-ping'` via `bus.registerTxGenerator('lid-ping', generateLidPingBlock)` (`512`-sample Hann-windowed upward chirp inside a `1024`-sample period at `48 kHz`), and passively piggybacks whenever `bus.getTxMode() === 'chirp'` (correlating Cell 04's `18.00–19.15 kHz` left-channel sweep).
   - Incoming `512`-sample bus blocks accumulate into `1024`-sample frames processed by `LidSonarEstimator.processFrame`:
     1. Passband-restricted analytic Wiener deconvolution (`17.9–20.7 kHz`, Tukey `α = 0.35` spectral taper) yields a smooth carrier-phase-invariant complex envelope.
     2. Direct-path peak localization (`k0 + δ` via log-parabolic sub-sample refinement) locks automatically onto any arbitrary OS/Web Audio loopback latency.
     3. Exact sub-sample complex direct-path CLEAN subtraction (`e[b] = h_aligned[b] - a0 * psfSpec[b]`) cancels pure direct leakage down below `-45 dB` even at `0.35 ms` lag.
     4. Screen-bounce reflection energy (`echoGainDb`, normalized to direct-path magnitude for speaker-volume & mic-gain invariance) and peak/centroid reflection lag (`0.35–2.20 ms`, `~6–38 cm` bounce path) combine into `reflectionIndex = 0.72 * echoGainDb + 0.28 * ((1.10 - lagMs) * 8.0)`.
     5. `LidCalibration.mapToAngleDeg` maps `reflectionIndex` linearly between `[Set Open 110°]` and `[Set Low 50°]` anchors (`localStorage['dwg.lidAngleCal.v1']`) into `25°..135°`, smoothed by `LidAngleKalman`.
2. **Mode B — Exact Hardware `IOHIDManager` Hinge Sensor (`lid-bridge.mjs`)**:
   - On cell mount and `[HID]` click, the cell issues a quiet `600 ms`-timeout CORS probe to `http://127.0.0.1:8791/angle`. If `{ available: true }`, it connects to `/events` SSE for exact `0.1°` hardware telemetry (`HW HID · LIVE`), taking display priority over Sonar.
   - `window.addEventListener('lg-secondary-close', ...)` immediately closes `EventSource`, aborts in-flight probes, and clears timers when exiting the secondary grid.

---

## 2. Design & Technical Decisions

1. **Left-Channel-Only `'lid-ping'` Emission (`lid-angle.js:generateLidPingBlock`)**:
   - *Chosen*: Drive the upward-firing left tweeter (`leftOut`) and explicitly zero `rightOut` (and correlate only the `18.00–19.15 kHz` left band when piggybacking on `'chirp'`).
   - *Why*: On 14"/16" MacBook Pro and Air decks, the 3-mic array sits under the left grille (`~5 cm` from left tweeter, `~30 cm` from right tweeter). Emitting identical chirps on both channels injects a right-speaker direct cross-keyboard wave at `Δτ ≈ 0.73 ms`, squarely inside the `0.35–2.20 ms` screen-bounce window. Left-only emission eliminates that false echo completely.
2. **Analytic Wiener Deconvolution + Sub-Sample Direct-Path CLEAN (`lid-angle.js:LidSonarEstimator.processFrame`)**:
   - *Chosen*: One-sided passband analytic Wiener filter with coherent sub-sample direct-path subtraction.
   - *Rejected*: Real-valued matched filtering without direct-path subtraction, which oscillates at the `19.3 kHz` carrier period and bleeds direct-path Hann mainlobes (`~0.65 ms`) across the `0.35–0.70 ms` closed-lid reflection window.
3. **Non-Coherent Envelope + 1D Kalman Tracking (`lid-angle.js:LidAngleKalman`)**:
   - *Chosen*: Per-frame envelope extraction + Kalman smoothing rather than multi-frame complex coherent averaging.
   - *Why*: At `19.3 kHz` (`λ ≈ 1.78 cm`), tilting the lid by `1 cm` flips reflection phase by `180°`, which would cancel a moving echo under coherent averaging.
4. **Side-Elevation Hinged Protractor SVG (`lid-angle.js:buildHingeDiagramSvg`)**:
   - *Chosen*: Right-side CAD elevation with hinge at `(86, 112)` so `0°` lies flat along the right-extending keyboard deck, `90°` is vertical, and `135°` leans back-left cleanly inside `viewBox="0 0 212 134"`, with direct pointer-drag and keyboard slider semantics (`role="slider"`).

---

## 3. Hazards, Invariants & Edge Cases

- **Bluetooth HFP `< 40 kHz` Safety (`lid-angle.js:generateLidPingBlock` / `LidSonarEstimator`)**: Whenever `sampleRate < 40000`, TX outputs exact zeros and sonar returns `{ signalPresent: false, unsupportedRate: true }` so audible chirp leakage can never occur.
- **No Console Spam on Absent Bridge (`lid-angle.js:probeHidBridge`)**: Bridge probes use `AbortController` (`600 ms` timeout), catch all errors silently, and never spawn infinite `EventSource` reconnect loops (at most one delayed retry after a live disconnect).
- **Degenerate Calibration Guard (`lid-angle.js:LidCalibration`)**: Two-point calibration requires `lowRefIndex - openRefIndex >= 1.0`; clicking both buttons at the same lid angle preserves the prior valid curve and notifies the user inline. One-point calibration shifts offset while preserving slope.
- **macOS IOHID Entitlement Fallback (`lid-bridge.mjs:SWIFT_LID_HELPER_SRC`)**: If `IOHIDManagerOpen`, device lookup, or `IOHIDDeviceGetReport` fails (non-Mac, missing sensor, or sandboxed entitlement), the bridge stays healthy and returns HTTP 200 `{ available: false, reason }` so the UI seamlessly stays on Acoustic Sonar + Drag.
- **Strict 4:3 Cell Lock (`lid-angle.css:.la-stage`)**: `.la-stage` is locked to `position: absolute; inset: 0; overflow: hidden;` with `container-type: inline-size` on `.la-cell` and `@container` breakpoints at `340px`, `265px`, `210px`, and `175px` so the cell never overflows or distorts grid rows down to `150px`.

---

## 4. How to Run & Verify

- **Syntax & unit test suite**:
  `node --check cells/left-grille/lid-angle.js && node --check cells/left-grille/lid-bridge.mjs && timeout 60 node --test cells/left-grille/lid-angle.test.js`
- **Optional local macOS hardware HID bridge**:
  `node cells/left-grille/lid-bridge.mjs`
  Then inspect `curl -s http://127.0.0.1:8791/angle` or click **`HID`** in Secondary Grid Cell 06.
- **Interactive UI states to verify**:
  1. Drag the lid directly on the hinge SVG (`0°–135°`) or focus and press Arrow keys (`DRAG` badge, simulated echo/lag rays).
  2. Click **`SONAR`** (`18.2–20.4 kHz` screen bounce), tilt lid to `~110°` → **`Set Open 110°`**, tilt to `~50°` → **`Set Low 50°`**, verify reload persistence in `localStorage['dwg.lidAngleCal.v1']`.
  3. Exit secondary grid (`← Grid` / `Esc`) and confirm `lg-secondary-close` closes any active SSE stream cleanly.
