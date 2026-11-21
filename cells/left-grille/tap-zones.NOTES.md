# Secondary Grid Cell 02 — Chassis Tap Zones (`cells/left-grille/tap-zones.*`)

## 1. Intent & Architecture

Implements **Secondary Grid Cell 02 (`Chassis Tap Zones`)** mounted into `#lg-sec-cell-2` via the `window.LeftGrilleLab` slot registry (`Slot 2`) and consuming the shared 48 kHz unprocessed microphone stream from `LeftGrilleLab.bus` (`subscribeAudio`, `requestArm`, `onStateChange`).

### Owned Files

| File | Responsibility |
| :--- | :--- |
| `cells/left-grille/tap-zones.js` | UMD DSP engine (`TapBandFilter`, `TapZoneDetector`, `TapZoneClassifier`, `TapZoneEngine`), physical 48 kHz waveform synthesizers (`synthesizeZoneTap`, `synthesizeSustainedSpeech`, `synthesizeUltrasonicBurst`), `dwg.tapZonesCal.v1` persistence, interactive MacBook Pro Unibody Chassis Map SVG, and `LeftGrilleLab` Slot `2` registration. |
| `cells/left-grille/tap-zones.css` | Strictly `.tz-cell`-scoped Swiss/Braun styles locked inside `.tz-stage { position: absolute; inset: 0; }` with `@container` responsive rules down to `150px` and `prefers-reduced-motion` support. |
| `cells/left-grille/tap-zones.test.js` | Node `--test` suite proving 4/4 classification accuracy, `< 16 kHz` ultrasonic sonar immunity, `> 90 ms` sustained speech/swipe rejection, `110 ms` refractory cooldown, 1-tap-per-zone calibration learning/persistence, multi-rate/NaN resilience, and Slot `2` registration. |

### Data Flow

```text
SharedAcousticBus (512-sample blocks, 48 kHz)
  └─> TapBandFilter (45 Hz 2nd-ord HPF + 14.0 kHz 8th-ord Butterworth LPF + 18.375/19.6 kHz notches)
        └─> TapZoneDetector (1 ms micro-frames, 16 ms pre-roll, adaptive noise floor, 8–55 ms gate, >90 ms veto, 110 ms refractory)
              └─> 6D Vibro-Acoustic Feature Vector (2048-pt asymmetric Tukey FFT + >280 Hz forward-scan rise time + 0–12 / 12–35 ms decay ratio)
                    └─> TapZoneClassifier (log2-homoscedastic weighted Mahalanobis distance, factory MBP or dwg.tapZonesCal.v1 centroids)
                          └─> Chassis Map SVG ripple + wavefront propagation ray + Zone / Rise / HF-Tilt telemetry
```

---

## 2. Design & Technical Decisions

1. **Strict `< 16 kHz` Two-Stage Ultrasonic Front-End (`tap-zones.js:TapBandFilter`)**:
   - *Choice*: Cascade a 45 Hz 2nd-order Butterworth HPF, a 14.0 kHz 8th-order Butterworth LPF (4 Direct-Form-II-Transposed biquads), and two ultrasonic stopband notches (`18.375 kHz` and `19.6 kHz`, active when `fs >= 40 kHz`) BEFORE envelope tracking, onset detection, and FFT (`< 15 kHz`).
   - *Why*: Sibling cells on `LeftGrilleLab.bus` transmit 18–21.5 kHz ultrasonic sonar pilots. A 6th-order 14.5 kHz LPF alone allowed `-48 dBFS` leakage on loud `0.45`-amplitude ultrasonic pulses; adding the 8th-order 14.0 kHz LPF + targeted notches yields `> 50–65 dB` attenuation across `18.375–21.375 kHz` with `< 0.1 ms` passband group delay and bit-identical 4-zone tap features when sonar runs concurrently.
2. **Forward-Scan `> 280 Hz` Dispersive Rise-Time Estimator (`tap-zones.js:TapZoneDetector._finalizeCapture`)**:
   - *Choice*: Measure `riseTimeMs` by forward-scanning from the `16 ms` quiet pre-roll on a `> 280 Hz`, `1.2 ms` moving-RMS structural/air envelope (falling back to broadband if `> 280 Hz` is negligible).
   - *Why*: Two real acoustic traps surfaced during testing: (a) narrow `0.5 ms` backward scans stop early at mid-attack modal interference dips (collapsing `right-palm` rise time to `< 1 ms`), and (b) slow `112 Hz` woofer-chamber half-cycles (`4.5 ms`) jump the broadband peak on `left-palm` taps to the second lobe (`~9 ms`). Forward-scanning the `> 280 Hz` flexural+air envelope eliminates both artifacts cleanly (`< 2.5 ms` Top-Left, `2.5–4.5 ms` Left Palm / Trackpad, `4.5–9.5 ms` Right Deck).
3. **Asymmetric Tukey FFT Window & Log2-Space `decayRatio` (`tap-zones.js:_extractFeatures` & `TapZoneClassifier`)**:
   - *Choice*: Left-aligned Tukey window (`1.2 ms` ramp-in before onset, flat `1.0` over the initial transient, `6 ms` fade-out) + comparing `decayRatio` in `log2(decayRatio)` octave space inside `distanceToZone`.
   - *Why*: Standard symmetric Hann windows attenuate the leading direct-air HF transient by `> 25 dB`, while linear `decayRatio` explodes for fast `< 10 ms` Top-Left taps (`10–20×`), distorting Euclidean distance. Log2 comparison keeps fast and resonant zones homoscedastic, and wide `peakDb` sigma (`12 dB`, weight `0.3`) keeps classification invariant across soft and firm taps.
4. **Docked Calibration Banner over Visible Chassis Map (`tap-zones.js:mountTapZonesCell` & `tap-zones.css:.tz-cal-bar`)**:
   - *Choice*: Dock `[CAL 4Z]` prompts along the bottom of `.tz-map-well` while pulsing the active target zone (`data-cal-target="true"`) directly on the MacBook Pro SVG, rather than covering the map with an opaque modal.
   - *Why*: Users immediately see the exact physical chassis region to tap while keeping interactive click-to-simulate testing usable at every container width down to `150px`.

---

## 3. Hazards, Invariants & Edge Cases

- **Strict `4:3` Grid Lock (`tap-zones.css:.tz-cell` / `.tz-stage`)**: `.tz-stage` must remain `position: absolute; inset: 0;` inside `.tz-cell` so telemetry or calibration bars can never expand the secondary `.grid` row height.
- **No Global Mic Teardown on Local Pause (`tap-zones.js:handleArmClick`)**: Because `LeftGrilleLab.bus` is shared across Secondary Cells `2..6`, clicking `[LIVE]` toggles a local `localPaused` gate rather than calling `bus.stopAll()`, preventing Cell 02 from muting sibling acoustic cells.
- **Isolated Simulation Detector (`tap-zones.js:runSimulatedZoneTap`)**: Clicking a zone on the SVG runs the synthesized 48 kHz waveform through a fresh `TapZoneDetector` paired with the live `TapZoneClassifier` (sharing calibrated centroids) so clicking never perturbs the live microphone's adaptive noise floor or IIR biquad state.
- **Zero `innerHTML` & Safe `localStorage` (`tap-zones.js:h`, `svgEl`, `loadStoredCalibration`)**: Every DOM/SVG element uses `createElement`/`createElementNS` + `textContent`; corrupt or restricted `localStorage` (`dwg.tapZonesCal.v1`) falls back cleanly to `FACTORY_CENTROIDS`.
- **Sustained Noise / Fan Recovery (`tap-zones.js:TapZoneDetector._onMicroFrame`)**: Continuous non-tap noise lasting `> 550 ms` smoothly adapts `noiseFloorRms` upward inside `SUSTAINED_WAIT` so a laptop fan spinning up cannot permanently latch out tap detection.
- **Hidden Tab Costs Nothing (`tap-zones.js:mountTapZonesCell` audio subscriber)**: the bus suspends its AudioContext while hidden (`shared-bus.js:_applyVisibilitySuspend`), and the subscriber additionally drops any block that still arrives while `document.hidden` (suspend is async; `processDuplexFrame` injection) and calls `engine.reset()` on the first visible block after such a drop, because the adaptive floor, pre-roll and clock anchor are stale after the gap.
- **`[CAL 4Z]` Implicit Arm Is Scoped (`tap-zones.js:toggleCalibration` / `releaseCalArm`)**: Opening calibration on an `idle`/`error` bus calls `bus.requestArm()` so physical taps can be captured. That arm belongs to the calibration session: Cancel/Done, Escape, Reset and 4/4 completion call `bus.stopAll({ dispatchClose: false })`. Ownership is dropped (mic stays on) if the bus goes idle/error, another cell changes the TX mode (e.g. chirp sonar), or the user clicks `[ARM]`. A bus that was already live is never disarmed by CAL.
- **Sim Clicks During CAL Persist Synthetic Centroids**: clicking SVG zones while `[CAL 4Z]` is open captures the synthesized waveform's features and saves them to `dwg.tapZonesCal.v1` like a real tap. Use `Reset` to return to factory centroids.

---

## 4. How to Run & Verify

- **Syntax & unit tests (11: DSP, 4/4 accuracy, speech veto, ultrasonic immunity, calibration, Slot 2 contract, CAL arm release, hidden-tab skip)**:
  ```bash
  node --check cells/left-grille/tap-zones.js && timeout 60 node --test cells/left-grille/tap-zones.test.js
  ```
- **Visual / interactive check**:
  Serve repo root (`python3 -m http.server 8000`), open **Cell 05 (`Left Grille Sonar`)**, inspect **Secondary Cell 02 (`Chassis Tap Zones`)**, click all 4 zones on the MacBook Pro chassis map SVG, test `[CAL 4Z]` 4-zone capture + `Reset`, and arm the shared microphone bus to tap the physical chassis.
