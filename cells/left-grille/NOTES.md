# Cell 05 — Left Grille Acoustic Swipe Sonar (`cells/left-grille/`)

## 1. Intent & Architecture

`cells/left-grille/` implements **Cell 05** on the primary grid and its seamless in-page **Secondary Grid** portal:

- **Primary Grid Cell (`#cell-left-grille` in `cells/left-grille/ui.js:mountLeftGrillePortal`)**: A Swiss/Braun tactile specimen tile (`05 · TG-L1`) rendering an inline SVG schematic of the MacBook Pro left speaker grille (`8%–22%` CNC microphone through-holes vs `28%–96%` blind dimples). Tapping replaces `<main class="grid">` in-page without a reload using a spatial homothety View Transition (`lg-stage-portal`), History/hash state (`#left-grille`), `Escape` return, and a `← Grid` back button.
- **Secondary Grid (`#left-grille-secondary-grid`)**: Uses the exact `.grid` and `.cell` classes as the main grid (`repeat(2, minmax(0, 1fr))` mobile / `repeat(3, minmax(0, 1fr))` `>=768px`, `4px` gap, `4:3` cells) so sizing and layout rules remain 100% identical.
- **Secondary Cell 1 (`#lg-sec-cell-1`)**: Houses the live **Left-Grille Acoustic Swipe Detector** combining Web Audio left-channel ultrasonic sonar with 3-mic tribological spectral tracking to output:
  1. **Swipe Direction**: `↑ SWIPE UP` vs `↓ SWIPE DOWN` (plus confidence `%`)
  2. **Swipe Speed**: Cruising and peak speed in `cm/s`
  3. **Relative Distance**: Simultaneous `% FROM TOP` (`esc`) and `% FROM BTM` (`fn`) plus `cm` along the `11.0 cm` MacBook Pro left speaker grille.

### Module Ownership

| File | Responsibility |
| :--- | :--- |
| `acoustic-engine.js` (`LeftGrilleAcousticEngine`) | Zero-dependency DSP core (`AcousticDspCore`, `fftRadix2`, `buildCarrierMultiples`, `theilSenSlope`, `createWorkletSource`) shared identically across `AudioWorkletGlobalScope`, `ScriptProcessorNode`, and Node tests. |
| `acoustic-controller.js` (`LeftGrilleController`) | Raw `48 kHz` `getUserMedia` acquisition, `sessionEpoch` race guard, automatic Built-in MacBook Mic/Speaker pinning (`enumerateDevices` + `setSinkId`), left-speaker hard pan (`pan = -1`), `localStorage` calibration (`dwg.leftGrilleCalibration.v1`), `Sim ↑/↓` synthesizer, and deterministic teardown. |
| `left-grille.css` | Strictly scoped styles (`.cell--left-grille`, `.lg-secondary-page`) with `container-type: inline-size` and `position: absolute; inset: 0` stage lock so internal controls never stretch 4:3 grid rows. |
| `ui.js` (`LeftGrilleUI`) | Portal tile, spatial View Transition & History router, 2-column vernier grille + 3-tier telemetry readout, DPR-scaled `<canvas>` trajectory/Doppler scope, 1-stroke calibration wizard, and rail pointer-drag / keyboard scrub fallback. |
| `acoustic-engine.test.js` | Reproducible 6-scenario `48 kHz` / `44.1 kHz` physical waveform synthesis & false-positive rejection suite (`node --test`). |

---

## 2. Design & Technical Decisions (`Protocol B` Best-of-4 Synthesis)

Four orthogonal candidates (*Braun Tactile Vernier*, *Spatial-Kinetic Blueshift/Redshift Oscilloscope*, *Ergonomic Self-Calibrating Sensor*, and *Architectural Homothety + Heteroscedastic Kalman*) were scored by an independent critic before synthesizing the shipped design:

1. **Non-Uniform Integer-Periodic Carrier Comb (`acoustic-engine.js:buildCarrierMultiples`)**:
   - *Won*: `4` Newman-phased carriers at non-uniform integer multiples of `sampleRate / 128` (`[49, 51, 54, 57] × 375 Hz = [18375, 19125, 20250, 21375] Hz` at `48 kHz`), with minimum separation `>= 2` bins (`750 Hz`) where the periodic Hann window places exact `-∞ dB` analytical spectral zeros, while non-uniform spacings prevent coherent 2nd-order tweeter intermodulation difference tones (`|m_i - m_j|`) and allow exact IMD bin notching in `eMid`.
   - *Rejected*: Uniform `750 Hz` comb starting at `18.00 kHz` (`-20.7 dBFS`), which is audible to younger ears and injects coherent `750/1500/2250 Hz` tweeter nonlinearity into the `375–2700 Hz` passive chassis band.
2. **PSD-Normalized, Velocity-Tilt-Compensated Spectral Ratio + Zoomed Baseband Doppler (`acoustic-engine.js:_processQuantum`)**:
   - *Won*: Per-bin PSD normalization between `6–15 kHz` open-pinhole air turbulence + `<165 Hz` pneumatic seal vs `375–2700 Hz` aluminum plate-wave conduction, compensated for sliding speed (`velTiltCompDb`), fused with a `64`-frame DC-notched, `128`-pt Complex Baseband FFT (`2.93 Hz/bin`) and top-pinhole carrier occlusion (`pinholeOcclusion`).
   - *Rejected*: Unnormalized band sums (which bias wider HF bands by `+5.5 dB`), `180 Hz` IIR decimators near the `187.5 Hz` Nyquist (aliasing), and partial-stroke online quantile normalizers (which corrupt `0%–100%` endpoints after repeated mid-grille swipes).
3. **4:3 Spatial Homothety View Transition & Calm 2-Column Vernier Layout (`ui.js` & `left-grille.css`)**:
   - *Won*: `view-transition-name: lg-stage-portal` expanding `#cell-left-grille` into `#left-grille-secondary-grid` (avoiding the illusion of an in-place card mutation among empty sibling `.cell` slots), paired with a `22%` 1:1 physical grille rail + `78%` 3-tier readout (`@container` breakpoints at `335px` and `245px`) and zero idle `<canvas>` loop on the main grid.
   - *Rejected*: Over-packed 5–6 row vertical stacks and continuous main-grid canvas animations.

---

## 3. Hazards, Invariants & Edge Cases

- **Disable Browser Voice DSP (`acoustic-controller.js:_requestRawMic`)**: `echoCancellation`, `noiseSuppression`, and `autoGainControl` must stay `false`; macOS `VoiceProcessingIO` cancels speaker pilots and suppresses sustained surface friction within `~100 ms`.
- **Headphone / External Display Hijack (`acoustic-controller.js:start`)**: When AirPods or Studio Display audio is system default, `enumerateDevices()` + `AudioContext.setSinkId` re-binds input and left-channel output to `/macbook|built-in|internal/i` automatically when present.
- **Click Ringing in Baseband History (`acoustic-engine.js:_processQuantum`)**: Sharp `15–20 ms` keyboard/trackpad clicks contain broadband `18–21 kHz` energy that would linger in the `64`-frame (`170 ms`) Doppler buffer unless blanked via `guardBins` (`guardSpikeRatio > 5.5` while idle).
- **Mid-Prompt Back Navigation Race (`acoustic-controller.js:start` / `stop`)**: `sessionEpoch` increments on `stop()` so a delayed `getUserMedia` resolution after the user already returned to the main grid stops its tracks immediately instead of leaving the macOS orange mic indicator lit.
- **Dual `file://` and `http://localhost` Support**: Classic UMD `<script defer>` tags load cleanly on `file://` without ES-module CORS errors; when a browser blocks `getUserMedia` on `file://`, `Sim ↑`, `Sim ↓`, and vertical pointer-drag / `ArrowUp`/`ArrowDown` on the rail exercise the UI and `48 kHz` DSP core without failing.

---

## 4. How to Run & Verify

- **DSP physics & false-positive unit suite**:
  `timeout 60 node --test cells/left-grille/acoustic-engine.test.js`
- **Syntax verification**:
  `node --check cells/left-grille/acoustic-engine.js && node --check cells/left-grille/acoustic-controller.js && node --check cells/left-grille/ui.js`
- **Live browser verification**:
  Serve repo root (`python3 -m http.server 8000`), open `http://localhost:8000`, click **Cell 05 (`Left Grille Sonar`)**, click **`ARM MIC`**, and swipe a finger up (`Fn → Esc`) and down (`Esc → Fn`) along the MacBook's left speaker grille.
