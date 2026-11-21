# Secondary Grid Cell 06 — MacBook Lid Angle Sensor (`cells/left-grille/lid-angle.*`)

## 1. Intent & Architecture

Secondary Grid Cell 06 (`#lg-sec-cell-6`) implements a dual-mode **MacBook Lid Angle Sensor** (`0°–135°`) registered into `window.LeftGrilleLab` slot `6`:

| File | Responsibility |
| :--- | :--- |
| `cells/left-grille/lid-angle.js` (`LeftGrilleLidAngle`) | UMD DSP core (`LidSonarEstimator`, `LidCalibration`, `LidAngleKalman`, `generateLidPingBlock`, `fftRadix2`, `synthesizeScreenBounceFrame`), shared-bus slot `6` registration, quiet `127.0.0.1:8793` HID probe + SSE consumer (`BRIDGE_ORIGIN`), side-elevation hinge SVG renderer, and pointer/keyboard drag scrubbing. |
| `cells/left-grille/lid-angle.css` | Strictly `.la-cell` / `.la-stage`-scoped Swiss/Braun styles with `position: absolute; inset: 0` strict `4:3` lock and `@container` breakpoints down to `150px`. |
| `cells/left-grille/lid-bridge.mjs` | Zero-npm-dependency Node HTTP + SSE server (`127.0.0.1:8793`, `DEFAULT_PORT`) compiling/caching a tiny `os.tmpdir()` Swift IOKit reader for Apple's hardware `LidAngleSensor` (`0x05AC:0x8104`, UsagePage `0x0020`, Usage `0x008A`, 3-byte feature report `[0x01, lo, hi]`). |
| `cells/left-grille/lid-angle.test.js` | Deterministic `node --test` suite covering TX spectral containment & `< 40 kHz` silence, monotonic acoustic estimation (`35° < 75° < 120°`), volume/polarity invariance, `'chirp'` piggyback mode, 2-point calibration math & `dwg.lidAngleCal.v1` persistence (including a `localStorage` getter that throws), Kalman filtering, `lid-bridge.mjs` HTTP/SSE, origin/Host policy, SSE cap, helper-after-bind and port checks, hidden-tab SSE teardown, and SONAR on/off bus ownership. |

### Dual-Mode Data Flow

1. **Mode A — Pure-Browser Acoustic Screen-Bounce Sonar (`18.2–20.4 kHz`)**:
   - Registers TX mode `'lid-ping'` via `bus.registerTxGenerator('lid-ping', generateLidPingBlock)` (`512`-sample Hann-windowed upward chirp inside a `1024`-sample period at `44.1/48 kHz`, scaled to `1024`/`2048` at `88.2/96 kHz`), and passively piggybacks whenever `bus.getTxMode() === 'chirp'` using Cell 04's exact `StereoChirpGenerator` left-channel waveform (`384`-sample Hann-windowed cosine chirp `18.00–19.15 kHz` inside `1024` @ `44.1/48 kHz`, scaled to `768`/`2048` @ `88.2/96 kHz`).
   - Incoming `512`-sample bus blocks accumulate into `computePeriodForSampleRate(sampleRate)` frames (`1024` @ `44.1/48 kHz`, `2048` @ `88.2/96 kHz`), sanitized with `Number.isFinite` and processed by `LidSonarEstimator.processFrame`:
     1. Passband-restricted analytic Wiener deconvolution (`17.9–20.7 kHz`, Tukey `α = 0.35` for `'lid-ping'`; `17.65–19.30 kHz`, Tukey `α = 0.20` for `'chirp'` piggyback to keep early-bounce resolution crisp while staying cleanly below Cell 04's `19.35–20.50 kHz` right channel) yields a smooth carrier-phase-invariant complex envelope.
     2. Direct-path peak localization (`k0 + δ` via log-parabolic sub-sample refinement) locks automatically onto any arbitrary OS/Web Audio loopback latency.
     3. Exact sub-sample complex direct-path CLEAN subtraction (`e[b] = h_aligned[b] - a0 * psfSpec[b]`) cancels pure direct leakage down below `-45 dB` even at `0.35 ms` lag.
     4. Screen-bounce reflection energy (`echoGainDb`, normalized to direct-path magnitude for speaker-volume & mic-gain invariance) and peak/centroid reflection lag (`0.35–2.20 ms`, `~6–38 cm` bounce path) combine into `reflectionIndex = 0.72 * echoGainDb + 0.28 * ((1.10 - lagMs) * 8.0)`.
     5. `LidCalibration.mapToAngleDeg` maps `reflectionIndex` linearly between `[Set Open 110°]` and `[Set Low 50°]` anchors (`localStorage['dwg.lidAngleCal.v1']`) into `25°..135°`, smoothed by `LidAngleKalman`.
2. **Mode B — Exact Hardware `IOHIDManager` Hinge Sensor (`lid-bridge.mjs`)**:
   - Never probes eagerly on hidden main-grid load; probes `http://127.0.0.1:8793/angle` (`600 ms` timeout) only when Cell 05 is open (`LeftGrilleLab.isSecondaryOpen()`, `location.hash === '#left-grille'`, visible container), on `lg-secondary-open` / `hashchange`, or on `[HID]` click. If `{ available: true }`, it connects to `/events` SSE for exact `0.1°` hardware telemetry (`HW HID · LIVE`), taking display priority over Sonar. Measured in the browser with nothing on the lid port: one `fetch` when the page opens and nothing else over the next 22 s (no `EventSource`, no `WebSocket`). With the bridge live and then killed while the page is open: one retry probe `2.5 s` after the stream error, then silence; the `Apple IOHID` note is cleared when the stream drops.
   - `window.addEventListener('lg-secondary-close', ...)` increments `hidEpoch`, immediately closes `EventSource`, aborts in-flight probes (re-checking `hidEpoch` after both `await fetch` and `await res.json()` so no late `EventSource` can leak), and clears timers when exiting the secondary grid.
   - A hidden tab closes the stream too (`mountLidAngleCell:onVisibilityChange`); visible again re-probes once, only while the page is open (`secondaryOpen`, set by our own open/close events) and only if hiding closed something.

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
- **Deferred Bridge Probe & Close-Epoch Guard (`lid-angle.js:probeHidBridge`, `closeHidBridge`)**: Bridge probes skip hidden main-grid loads (`lg-secondary-open` triggers probing once Cell 05 is opened), use `AbortController` (`600 ms` timeout), catch all JS errors silently (note: when `lid-bridge.mjs` is stopped, browser DevTools' network log may still show a localhost `ERR_CONNECTION_REFUSED` when Cell 05 opens), check `hidEpoch` after both `await fetch` and `await res.json()` before constructing `EventSource`, and never spawn infinite reconnect loops (at most one delayed retry after a live disconnect, cleared on `[HID]` click or close).
- **Bridge HTTP Hardening (`lid-bridge.mjs:createBridgeServer`)**: Wraps `new URL(...)` in `try/catch` (returning HTTP `400` JSON on malformed targets), drains `helperProc.stderr.resume()`, calls `server.closeAllConnections?.()` in `closeAll()` for instant `SIGINT`/`SIGTERM` shutdown, and resolves the actual bound `server.address().port` from `start()` (including ephemeral `port: 0`).
- **Bridge Access Policy (`lid-bridge.mjs:isAllowedHost`, `isAllowedOrigin`)**: Binds `127.0.0.1` only. Every request needs a loopback `Host` header (`127.0.0.1`, `localhost`, `[::1]`, any port), which blocks DNS rebinding. A request with an `Origin` must come from a loopback `http(s)` page or be `Origin: null` (the `file://` page); anything else gets `403` with no CORS header. Allowed origins are echoed (`Access-Control-Allow-Origin: <origin>`, `Vary: Origin`), never `*`. Known cost: sandboxed iframes on any site also send `Origin: null` and can read the angle (same trade-off as `cells/motion/server.mjs`).
- **Bridge Resource Bounds**: at most `MAX_SSE_CLIENTS = 8` event streams (`503` beyond), a client whose unsent buffer exceeds `64 KB` is dropped (`writeOrDrop`), and helper stdout without a newline is discarded past `16 KB`. The Swift helper is spawned only after `listen` succeeds, so a failed bind leaves no child; `close()` sends it `SIGTERM`. With no sensor the helper prints one `{ available: false, reason }` line and exits; the bridge keeps serving that snapshot.
- **Port (`lid-bridge.mjs:DEFAULT_PORT`, `lid-angle.js:BRIDGE_ORIGIN`)**: `8793`. `8791` belongs to `cells/stick-s3/bridge.mjs` (with both on one port the HID button reached the StickS3 bridge and got `404`) and `8792` to `cells/left-grille/cal-collector.mjs`; a test fails if any other `cells/*/*.mjs` server mentions the lid port. `LID_BRIDGE_PORT` is used only when it is a valid port number; the page always probes `8793`.
- **Storage (`lid-angle.js:LidCalibration.load`, `save`)**: reading the `localStorage` global happens inside `try`, so blocked site data (getter throws `SecurityError`) falls back to the default curve instead of failing the mount.
- **SONAR Ownership (`mountLidAngleCell:toggleSonar`)**: `SONAR` arms the shared bus with `'lid-ping'`. If SONAR is what turned the mic on (`sonarArmedBus`), turning it off calls `bus.stopAll({ dispatchClose: false })`; if the nav `ARM ARRAY` or another cell armed it, SONAR off only sets TX `off`. Ownership ends when the bus goes `idle`/`error` or another cell switches the TX away from `'lid-ping'` (same rule as `tap-zones.js` CAL). The badge reads `SONAR · NO ECHO` until a frame with `signalPresent` arrives. A `false` from `requestArm` shows `Mic unavailable` only when the bus is in `error` (not when an arm was aborted by closing the page).
- **`Reset` Button (`lid-angle.css:.la-cal-btn[hidden]`)**: `.la-cal-btn` sets `display: inline-flex`, which overrides the `hidden` attribute; the explicit `[hidden]` rule keeps `Reset` hidden until a calibration exists.
- **Degenerate Calibration Guard (`lid-angle.js:LidCalibration`)**: Two-point calibration requires `lowRefIndex - openRefIndex >= 1.0`; clicking both buttons at the same lid angle preserves the prior valid curve and notifies the user inline. One-point calibration shifts offset while preserving slope.
- **macOS IOHID Entitlement Fallback (`lid-bridge.mjs:SWIFT_LID_HELPER_SRC`)**: If `IOHIDManagerOpen`, device lookup, or `IOHIDDeviceGetReport` fails (non-Mac, missing sensor, or sandboxed entitlement), the bridge stays healthy and returns HTTP 200 `{ available: false, reason }` so the UI seamlessly stays on Acoustic Sonar + Drag.
- **Strict 4:3 Cell Lock (`lid-angle.css:.la-stage`)**: `.la-stage` is locked to `position: absolute; inset: 0; overflow: hidden;` with `container-type: inline-size` on `.la-cell` and `@container` breakpoints at `340px`, `265px`, `210px`, and `175px` so the cell never overflows or distorts grid rows down to `150px`.

---

## 4. How to Run & Verify

- **Syntax & unit test suite**:
  `node --check cells/left-grille/lid-angle.js && node --check cells/left-grille/lid-bridge.mjs && timeout 60 node --test cells/left-grille/lid-angle.test.js`
- **Optional local macOS hardware HID bridge**:
  `node cells/left-grille/lid-bridge.mjs`
  Then inspect `curl -s http://127.0.0.1:8793/angle` or click **`HID`** in Secondary Grid Cell 06. `curl -H 'Origin: https://example.com' http://127.0.0.1:8793/angle` must return `403`. Run it bounded (`timeout 40 node …`) and check `pgrep -f 'dwg-lid-angle-hi[d]'` is empty afterwards.
- **Interactive UI states to verify**:
  1. Drag the lid directly on the hinge SVG (`0°–135°`) or focus and press Arrow keys (`DRAG` badge, simulated echo/lag rays).
  2. Click **`SONAR`** (`18.2–20.4 kHz` screen bounce), tilt lid to `~110°` → **`Set Open 110°`**, tilt to `~50°` → **`Set Low 50°`**, verify reload persistence in `localStorage['dwg.lidAngleCal.v1']`.
  3. Exit secondary grid (`← Grid` / `Esc`) and confirm `lg-secondary-close` closes any active SSE stream cleanly.
