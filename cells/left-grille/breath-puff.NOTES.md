# Secondary Cell 05 — Grille Breath Puff Detector (`cells/left-grille/breath-puff.*`)

## 1. Intent & Architecture

`cells/left-grille/breath-puff.js` and `cells/left-grille/breath-puff.css` implement **Secondary Grid Cell 05** (`#lg-sec-cell-5`) inside the Left Grille Acoustic Lab: a passive (`< 12 kHz`, zero speaker TX) aerodynamic turbulence detector that converts breath puffs and sustained blowing across the MacBook Pro left speaker grille's 3-mic through-holes into live airflow telemetry, pinwheel rotation physics, and discrete aerodynamic gesture events.

### Module Ownership & Contracts

- **`cells/left-grille/breath-puff.js` (`LeftGrilleBreathPuff`)**:
  - Registers `{ id: 'breath-puff', title: 'Grille Breath Puff', mount(cellEl, bus) }` into `LeftGrilleLab` Slot `5` (draining via `_pending` if loaded before `shared-bus.js` initializes `registerCell`).
  - Subscribes to the shared acoustic hub via `bus.subscribeAudio(({ samples, sampleRate, timeSec }) => ...)`, `bus.requestArm()`, `bus.stopAll()`, and `bus.onStateChange(cb)`, and cleans up animations, timers, and subscriptions on `lg-secondary-close` or `destroy()`.
  - Exports pure DSP and physics classes via UMD (`BreathPuffDspCore`, `PinwheelPhysics`, `BiquadFilter`, `fftRadix2`, `computeDecimationFactor`, `synthesizeBreathWaveform`, `mountBreathPuffCell`, `registerIntoLab`) for headless Node verification.
- **`cells/left-grille/breath-puff.css`**:
  - Shared tile frame (left-grille `NOTES.md` "Sensor cell frame"): `.bp-stage` is a `.lg-cell-stage` column of `ui-tile-head` (index `05`, "Breath puff", status `ui-pill` `.bp-pill` with its label `.bp-status-pill`, Arm `ui-btn--sm`), `ui-tile-body` (hero: pinwheel in a `ui-well` + `Airflow` `ui-readout--hero`; quiet kind, RPM, duration, three band meters) and `ui-tile-foot` (`Sim` label + Puff / Blow quiet buttons, Sub/Mid and low-band dB readouts). Colours are `--ui-` tokens; the pinwheel SVG palette is read from the tokens once per mount (`readPinwheelPalette`, token-value fallbacks in Node). Size steps use `@container ui-tile`: `< 360px` drops the Sub/Mid readout, `< 320px` (base hides the foot) shows a "Widen for Sim" note and hides bands + meta, `< 240px` is header + pinwheel + airflow only.
- **`cells/left-grille/breath-puff.test.js`**:
  - Reproducible `node --test` suite verifying `SHARP PUFF`, `SUSTAINED BLOW`, `GENTLE BREEZE`, multi-rate (`44.1 kHz` / `96 kHz`) + `NaN` resilience, `PinwheelPhysics`, `LeftGrilleLab` Slot `5` mounting, status text after mic denial / recovery / close mid-sim, and 100% rejection of `< 35 ms` desk taps, `140 ms` resonant desk thumps, high-frequency grille scratches, and voiced speech / `120 Hz` humming.

---

## 2. DSP Physics & Design Decisions

1. **Dual-Rate Spectral Architecture (`BreathPuffDspCore._analyzeSubFrame`)**:
   - *Design*: Decimates high hardware rates (`>= 64 kHz`) via `computeDecimationFactor` to `~44.1–48 kHz` (`512`-pt Hann FFT for `Mid = 500–2200 Hz` and `HF = 3500–11000 Hz` Parseval PSDs), and cascades a 4th-order anti-alias lowpass (`0.36 * lowRate`) before downsampling to `~12 kHz` for a `1024`-pt Hann FFT (`11.72 Hz/bin` at `12 kHz`) resolving `Sub = 20–200 Hz` and `Voice = 90–600 Hz`.
   - *Rationale*: A single `512`-pt FFT at `48 kHz` (`93.75 Hz/bin`) cannot separate `20–200 Hz` Karman vortex roar from `120 Hz` hum harmonics; anti-aliasing before `~12 kHz` downsampling prevents `3.5–11 kHz` scratch energy from aliasing into `20–200 Hz` while keeping per-hop CPU negligible.
2. **Envelope Attack-Rise & Impulse Rejection (`BreathPuffDspCore._finalizeEvent`)**:
   - *Design*: Tracks a `~16 ms` smoothed sub-band RMS envelope (`subPowerEma` over `~5.33 ms` `20–200 Hz` biquad sub-frames) to prevent half-cycle sub-bass waveform oscillations from splitting attacks, trims leading noise frames (`< 2.2 dB` SNR or `< 0.03 * globalPeakRms`), and walks backward from `initialPeakIdx` to verify `durationMs >= 95` and `attackRiseMs >= 25` alongside `rolloffSubMidDb > +8 dB` and `rolloffSubHfDb > +16 dB`.
   - *Rationale*: Measuring onset from raw pre-roll with wide noise gaps previously allowed pre-tap ambient jitter (`0.00005` RMS) to stitch onto a `0.25` RMS desk tap; walking backward from `initialPeakIdx` against `0.03 * initialPeakRms` isolates true tap/thump impact slopes (`5–11 ms`) while preserving full `27–95 ms` breath attack ramps.
3. **Aperiodic Turbulence vs. Voiced Speech / Hum Veto (`_computeNacf` & `_computeLocalHarmonicProminenceDb`)**:
   - *Design*: Combines first-zero-crossing-guarded Normalized Autocorrelation (`NACF` over `85–600 Hz` lags on `90–900 Hz` bandpassed `12 kHz` audio, requiring `>= 4` consecutive voiced frames or concurrent harmonic prominence) with local neighborhood median harmonic prominence (`[k-5..k-2, k+2..k+5]` excluding `±1` Hann sidelobes).
   - *Rationale*: Global `max/median` in `90–600 Hz` mistakes natural `1/f^2` brown turbulence roll-off for tonal crest, and unguarded 1-frame `NACF` fluctuates briefly on lowpass noise. Local neighbor prominence + sustained `NACF` scores `100%` on `100–400 Hz` hums and voiced speech while passing `10/10` randomized seeds across `breeze`, `puff`, and `blow`.
4. **Classification & Pinwheel Mechanics (`PinwheelPhysics`)**:
   - Classifies puffs into `SUSTAINED BLOW` (`durationMs >= 450` with `peakSnrDb >= 18.5` or `durationMs >= 650`), `SHARP PUFF` (`peakSnrDb >= 22.5`), or `GENTLE BREEZE` (`14.0 <= peakSnrDb < 22.5`), emitting `{ id, kind, intensityPct, peakSnrDb, durationMs, attackRiseMs, impulse, rolloffSubMidDb, rolloffSubHfDb, timeSec }`.
   - Drives a Braun-styled 4-blade anemometer SVG via real angular momentum, aerodynamic drive torque, viscous drag, and light bearing stiction (`PinwheelPhysics.step`), updating live `airflowPct`, `rotorRpm`, `subSnrDb`, and `vetoReason`.

---

## 3. Hazards, Invariants & Edge Cases

- **Startup Filter Warm-Up (`BreathPuffDspCore._analyzeSubFrame`)**: Ambient floors (`ambientSubDb`, `ambientMidDb`, `ambientHfDb`) warm up over the first `12` sub-frames (`~64 ms`) and skip seeding from digital-zero/NaN silence (`subRms <= 1e-6`, clamped `>= -94 dBFS`), preventing `NaN` or muted-mic pre-buffers from latching `subSnrDb` permanently high.
- **No `innerHTML` with Dynamic Strings (`mountBreathPuffCell`)**: All DOM and SVG elements are constructed via `document.createElement` / `document.createElementNS` and `.textContent`.
- **Simulation Isolation (`mountBreathPuffCell.runSimulation`)**: Live `bus.subscribeAudio` frames are ignored while `simTimer` plays back `Sim Puff` / `Sim Blow` waveforms so room noise never corrupts simulation telemetry.
- **Reduced Motion (`prefers-reduced-motion: reduce`)**: Rotor SVG angular rotation pauses while numeric `Airflow %`, `Rotor RPM`, `Duration`, and hero classification readouts remain live.
- **Truthful Status (`mountBreathPuffCell:updateStateUi`, `setPill`)**: every pill write goes through `setPill(text, tone, tip)`. Tones: `READY` and `SIM · PUFF` / `SIM · BLOW` idle grey (a simulation says SIM), `ARMING…`, `LIVE · 48k`, `FLOW +NdB`, `… VETO` and `SIM ONLY` (bus error) rust `attention`; never green (no hardware link). A bus error shows `SIM ONLY`, the error in `.bp-hero-meta`, and `Retry` on the arm button with the error plus "Click to try again." as its `data-tip` (below `240px` the pill collapses to its dot, so the button carries the failure). Once the bus leaves `error` the error text is replaced (`metaShowsError`), so it never sits next to `Live`. Closing the secondary page mid-sim stops the sim and re-renders the pill (`onSecondaryClose` → `updateStateUi`), so `SIM WAVEFORM` cannot persist. Arm labels: `Arm` / `Arming…` / `Live` / `Retry`; while armed it carries `aria-pressed="true"` and `data-tone="attention"`.
- **Tooltips**: `data-tip` on the pill (per state), Arm (per state), both Sim buttons (accessible names `Sim puff` / `Sim blow`), the pinwheel, kind row, RPM, duration, band meters and both foot readouts. No `title` attributes.
- **Hidden Tab & Close**: the bus suspends its `AudioContext` while the tab is hidden (`shared-bus.js:_applyVisibilitySuspend`), so no audio callbacks reach the DSP. The rotor `rAF` loop runs only while airflow or rotor speed is non-zero and is cancelled on `lg-secondary-close`, which also arrives with the bus already `idle` (mic released).

---

## 4. How to Run & Verify

- **Syntax & Unit/False-Positive Suite**:
  ```sh
  node --check cells/left-grille/breath-puff.js && timeout 60 node --test cells/left-grille/breath-puff.test.js
  ```
- **Live Browser Check**:
  Open the Left Grille secondary grid (`#left-grille`), inspect **Slot 5 (`Grille Breath Puff`)**, trigger **Sim `Puff`** and **Sim `Blow`**, or click **`Arm`** and blow softly vs sharply across the MacBook Pro left speaker grille (`8%–22%` mic ports) while testing voice/tap immunity.
  Without a mic prompt: stub `navigator.mediaDevices.getUserMedia` to reject with `NotAllowedError` (expect `Retry` + `SIM ONLY` + the denial text), then to resolve a silent `createMediaStreamDestination()` stream and click `Retry` with a user gesture (expect `Live` / `LIVE · 48k` and the denial text gone). Start Sim `Blow`, close with `Esc`, reopen: the pill must read `READY`.
