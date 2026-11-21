# Cell 05 — Left Grille Acoustic Swipe Sonar (`cells/left-grille/`)

## 1. Intent & Architecture

`cells/left-grille/` implements **Cell 05** on the primary grid and its seamless in-page **Secondary Grid** portal:

- **Primary Grid Cell (`#cell-left-grille` in `cells/left-grille/ui.js:mountLeftGrillePortal`)**: A Swiss/Braun tactile specimen tile (`05 · Left Grille Sonar`) rendering an inline SVG schematic of the MacBook Pro left speaker grille (`8%–22%` dark CNC microphone through-holes + blind dimples outside `8%–22%`). Tapping replaces `<main class="grid">` in-page without a reload using a spatial homothety View Transition (`lg-stage-portal`), History/hash state (`#left-grille`), `Escape` return, and a `← Grid` back button.
- **Secondary Grid (`#left-grille-secondary-grid`)**: Uses the exact `.grid` and `.cell` classes as the main grid (`repeat(2, minmax(0, 1fr))` mobile / `repeat(3, minmax(0, 1fr))` `>=768px`, `4px` gap, `4:3` cells) so sizing and layout rules remain 100% identical.
- **Secondary Cell 1 (`#lg-sec-cell-1`)**: Houses the live **Left-Grille Acoustic Swipe Detector** combining Web Audio left-channel ultrasonic sonar with 3-mic tribological spectral tracking to output:
  1. **Swipe Direction**: `↑ SWIPE UP` vs `↓ SWIPE DOWN` (plus confidence `%`)
  2. **Swipe Speed**: Cruising and peak speed in `cm/s`
  3. **Relative Distance**: Simultaneous `% TOP` (`esc`) and `% BTM` (`fn`) plus `cm` along the `11.0 cm` MacBook Pro left speaker grille.

### Module Ownership

| File | Responsibility |
| :--- | :--- |
| `acoustic-engine.js` (`LeftGrilleAcousticEngine`) | Zero-dependency DSP core (`AcousticDspCore`, `fftRadix2`, `computeDecimationFactor`, `buildCarrierMultiples`, `theilSenSlope`, `createWorkletSource`) shared identically across `AudioWorkletGlobalScope`, `ScriptProcessorNode`, and Node tests. |
| `acoustic-controller.js` (`LeftGrilleController`) | Raw `48 kHz` `getUserMedia` acquisition, per-invocation `sessionEpoch` handle isolation, automatic Built-in MacBook Mic/Speaker pinning (`enumerateDevices` + `setSinkId`), left-speaker hard pan (`pan = -1`), `localStorage` calibration (`dwg.leftGrilleCalibration.v1`), `Sim ↑/↓` synthesizer, and synchronous-detach `stop()`. |
| `left-grille.css` | Strictly scoped styles (`.cell--left-grille`, `.lg-secondary-page`) with `container-type: inline-size` and `position: absolute; inset: 0` stage lock so internal controls never stretch 4:3 grid rows. |
| `ui.js` (`LeftGrilleUI`) | Portal tile, race-free `targetOpen`/`vtSeq` View Transition & History router, 2-column vernier grille + 3-tier telemetry readout, full-column calibration/error overlay, DPR-scaled `<canvas>` trajectory/Doppler scope, and vertical slider rail-drag / keyboard fallback. |
| `acoustic-engine.test.js` | Reproducible 11-test `16k`/`44.1k`/`48k`/`96k`/`192k` physical waveform, `AudioWorklet` VM, false-positive immunity, controller `sessionEpoch` race, and UI View Transition re-entrancy suite (`node --test`). |

---

## 2. Design & Technical Decisions (`Protocol B` Synthesis + `Stage 2` Hardening)

Four orthogonal candidates (*Braun Tactile Vernier*, *Spatial-Kinetic Blueshift/Redshift Oscilloscope*, *Ergonomic Self-Calibrating Sensor*, and *Architectural Homothety + Heteroscedastic Kalman*) were scored by an independent critic and hardened across a 4-lens cross-Gemini Stage 2 audit:

1. **Non-Uniform Integer-Periodic Carrier Comb & Multi-Rate Decimation (`acoustic-engine.js:buildCarrierMultiples` / `computeDecimationFactor`)**:
   - *Won*: `4` Newman-phased carriers at non-uniform integer multiples of `effectiveRate / 128` (`[49, 51, 54, 57] × 375 Hz = [18375, 19125, 20250, 21375] Hz` at `48 kHz`, ramped via `tau = 15 ms` exponential envelope), with minimum separation `>= 2` bins where the periodic Hann window places exact `-∞ dB` analytical spectral zeros, while non-uniform spacings prevent coherent 2nd-order tweeter IMD (`|m_i - m_j|`) and allow exact IMD bin notching in `eMid`. High sample rates (`88.2k`/`96k`/`192k`) boxcar-decimate into `~44.1–48 kHz` effective DSP rate while synthesizing native-rate ultrasonic TX; `< 40 kHz` (Bluetooth HFP) forces passive-only mode so audible carriers can never emit.
   - *Rejected*: Uniform `750 Hz` comb starting at `18.00 kHz` (`-20.7 dBFS`), which is audible to younger ears and injects coherent `750/1500/2250 Hz` tweeter nonlinearity into `eMid`.
2. **PSD-Normalized, Velocity-Tilt-Compensated Spectral Ratio + Zoomed Baseband Doppler (`acoustic-engine.js:_processQuantum`)**:
   - *Won*: Per-bin PSD normalization between `6–15 kHz` open-pinhole air turbulence + `<165 Hz` pneumatic seal vs `375–2700 Hz` aluminum plate-wave conduction, compensated for sliding speed (`velTiltCompDb`), fused at consistent `1.65x` oblique geometry with a `64`-frame DC-notched, `128`-pt Complex Baseband FFT (`2.93 Hz/bin`), LLAP phase velocity, and top-pinhole carrier occlusion (`pinholeOcclusion`).
   - *Rejected*: Unnormalized band sums, `180 Hz` IIR decimators near `187.5 Hz` Nyquist, and partial-stroke online quantile normalizers.
3. **4:3 Spatial Homothety View Transition & Full-Column Overlay (`ui.js` & `left-grille.css`)**:
   - *Won*: Synchronous `targetOpen` + monotonic `vtSeq` guarding `view-transition-name: lg-stage-portal`, paired with a `22%` physical grille rail + `78%` 3-tier readout (`@container` breakpoints at `335px` and `245px`) where `.lg-inline-overlay` mounts directly on `.lg-telemetry` so calibration and error banners remain visible even when `.lg-scope-box` hides below `245px`.

---

## 3. Hazards, Invariants & Edge Cases

- **Named UMD Factory for Worklet Serialization (`acoustic-engine.js:createWorkletSource`)**: The inner UMD factory must remain named `function engineFactory()` so `engineFactory.toString()` resolves cleanly inside `createWorkletSource()` without falling back to `ScriptProcessorNode`.
- **Disable Browser Voice DSP (`acoustic-controller.js:_requestRawMic`)**: `echoCancellation`, `noiseSuppression`, and `autoGainControl` must stay `false` (retrying relaxed boolean constraints only on `OverconstrainedError`/`TypeError`, never double-prompting on `NotAllowedError`).
- **Guard-Bin Hann Clearance (`acoustic-engine.js:AcousticDspCore`)**: Every bin in `guardBins` must satisfy `|b - m_k| >= 2` so `±1` bin Hann carrier mainlobes (`-6 dB`) never inflate `ambientGuardPow`.
- **Epoch-Scoped Handle Isolation (`acoustic-controller.js:_runStart` / `stop`)**: `stop()` detaches instance handles synchronously before its `24 ms` ramp-down wait, and aborted `_runStart()` calls dispose only their own `local` handles so an older aborted prompt never closes a newer active session.
- **Sustained Fan/HVAC Recovery (`acoustic-engine.js:_processQuantum`)**: Strokes exceeding `3.5 s` auto-abort and re-anchor `ambientFricDb`/`ambientHfDb` so sudden fan spin-up cannot permanently latch `activeStroke`.

---

## 4. How to Run & Verify

- **DSP, Worklet VM & controller race test suite**:
  `timeout 60 node --test cells/left-grille/acoustic-engine.test.js`
- **Syntax verification**:
  `node --check cells/left-grille/acoustic-engine.js && node --check cells/left-grille/acoustic-controller.js && node --check cells/left-grille/ui.js`
- **Live browser verification**:
  Serve repo root (`python3 -m http.server 8000`), open `http://localhost:8000`, click **Cell 05 (`Left Grille Sonar`)**, click **`ARM MIC`**, and swipe a finger up (`Fn → Esc`) and down (`Esc → Fn`) along the MacBook's left speaker grille.
