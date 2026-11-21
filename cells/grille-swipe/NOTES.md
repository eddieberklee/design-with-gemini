# Cell 06 — 16-inch MacBook Pro (`Mac16,5`) Right Grille Acoustic Swipe Lab (`cells/grille-swipe/`)

## 1. Hardware Ground Truth & Physical Asymmetry

- **Microphone Placement (`Mac16,5` & 2019–2024+ 16-inch MacBook Pro)**:
  - All **three** studio-quality MEMS microphones sit in a compact planar triangle **underneath the upper third of the LEFT speaker grille**, directly beside the `` ~ ` `` and `tab` keys (just below `esc`).
  - **Zero** microphones sit inside the display/camera notch, and **zero** microphones sit under the **right speaker grille** (which houses only the upward-firing right tweeter and dual force-cancelling woofers).
  - macOS CoreAudio beams the 3-MEMS array in DSP and exposes `MacBook Pro Microphone` to browsers as a **single mono channel (`Input Channels: 1`, `48000 Hz`)**, ruling out raw multi-capsule inter-microphone TDOA in WebAudio.
- **Why Right-Grille Up vs Down Fails Under Naive Passive Loudness**:
  - From the upper-left 3-MEMS array (`x ≈ -15.5 cm, y ≈ +3.8 cm`), the top of the right speaker grille is `31.0 cm` away and the bottom is `32.4 cm` away — a `1.4 cm` (`4.5%`, `< 0.4 dB`) airborne path-length delta easily swamped by finger pressure variance.
  - By contrast, swiping on the **Left Grille (`L Ctrl`)** moves directly onto/off the upper-left MEMS ports (`+15..+25 dB` proximity & `8–16 kHz` shear ramp), separating Up vs Down zero-shot.
- **How Right-Grille Swipe Up vs Down Is Differentiated**:
  1. **Coherent Hard-Right `19.0 kHz` Tweeter Sonar (`19k Sonar` mode)**: Panned `100%` right (`outputs[0][0] = 0`, `outputs[0][1] = g * cos(phi)`) so the right speaker grille's upward-firing tweeter acts as an active acoustic beacon. Moving a finger/hand UP vs DOWN produces opposite-sign **clutter-cancelled MTI Doppler shifts** (`+20..+95 Hz` blueshift vs `-95..-20 Hz` redshift) and opposite **tweeter-aperture occlusion timing (`τ_dip`)**.
  2. **Unibody Boundary Stiffness Tilt + 4-Stroke Shrinkage Fisher LDA (`Cal ↑↑↓↓`)**: The top of the right grille borders the stiff CNC hinge/Touch ID rib while the bottom borders the compliant palm-rest plate (`8–16 kHz` vs `120–600 Hz` spectral tilt slope). Recording `2× UP` + `2× DOWN` strokes fits a `6×6` Cholesky shrinkage-regularized Fisher linear discriminant (`λ = 0.75` at `N = 4`) and reports honest Leave-One-Out cross-validated separation (`d'_OOF`).

---

## 2. Architecture & Design Decisions (Protocol B Synthesis)

Synthesized from a 3-way divergent tournament (*Braun-Rams Precision Instrument*, *Acoustic Telemetry & Stroke-Trajectory Lab*, *Spatial Kinetic Louver & Grille Scrubber*):

- **Unified `1×1` Swiss-Braun Stage (`cells/grille-swipe/grille-swipe.css`, `GrilleSwipeLab.mountCell`)**:
  - Embeds a **31-blade symplectic torsional spring-damper louver stack** directly inside the magnified `Mac16,5` Right Speaker Grille cutaway alongside the upper-left `3× MEMS` landmark diagram (`esc`, `` ~ ` ``, `tab`, `NOTCH · 0 MICS`), live `31.0–32.4 cm · Δ4.5%` acoustic chord, and critically damped Vertical Vernier Carriage (`-10..+10`).
  - Progressive `@container cell` breakpoints keep every control unclipped: `< 280px` Tier 0 (`.ag-micro-cta` + `.ag-vernier-mini`), `>= 280px` Tier 1 (`.ag-controls-bar` + `.ag-mic-wrap`), `>= 380px` Tier 2, `>= 445px` Tier 2b (`.ag-seg-grille`), and `>= 500px` Tier 3 (`.ag-demo-pair`).
  - Synchronized WCAG AA palette across CSS tokens and `<canvas>` strokes/badges (`--ag-up: #0052cc`, `--ag-down: #c93700`, `--ag-ok: #047857`, `--ag-ink-muted: #62615c`, `>= 4.8:1` contrast).
- **Zero-Reflow Responsive Empirical Workbench Overlay (`.cell-acoustic.is-expanded`)**:
  - Opens at **all** viewports using an in-place `.ag-grid-placeholder` (`0` sibling reflow across columns `1`, `2`, or `3`) and race-safe `ViewTransition` token synchronization.
  - Below `560px` container width (mobile viewports), renders a fitted/scrollable 1-column Empirical Workbench exposing `Demo ↑/↓`, `R Grille / L Ctrl`, `4-Stroke LDA`, and all 3 diagnostic canvases; at `@container cell (width >= 560px)`, switches `.ag-workbench` to a 2-column side-by-side layout.

---

## 3. DSP, Concurrency & Layout Invariants (`cells/grille-swipe/grille-swipe.js`)

- **Coherent Homodyne Single-Worklet TX+RX (`createStreamEngine`, `buildWorkletSource`, `buildWorkletBlobUrl`)**: Serializes `CARRIER_HZ`, `FEATURE_SCALES`, and DSP helpers into a self-contained `AudioWorklet` processor sharing one `Float64` phase accumulator (`0.0000 Hz` drift, Left channel strictly `0.0`), with immediate Blob URL revocation on `addModule` failure and `onprocessorerror` auto-disarm fallback.
- **Monotonic Generation Race Serialization (`armGen` in `mountCell`)**: Every `armAudio` and `disarmAudio` increments `armGen`, re-validates `gen === armGen && !isDestroyed` across every async boundary (`getUserMedia`, `enumerateDevices`, `resume`, `setSinkId`, `addModule`), and debounces `devicechange` (`180 ms`) so zero `MediaStreamTrack`s or `AudioContext`s can ever leak.
- **Two-Phase CoreAudio Input Lock (`rankAudioInputDevice`)**: Automatically switches off external default hijackers (USB wireless receivers, iPhone Continuity mics, AirPods) onto `MacBook Pro Microphone` with `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`.
- **Matched 2-Stage `180 ms` Ultrasonic Loopback Self-Test & Gain-Step Blanking**: Cascades 2-stage `19.0 kHz` (`Q = 18`) vs `min(16.2 kHz, 0.40 * sr)` (`Q = 14`) bandpass filters (`>= +22 dB` coupled SNR across `44.1`, `48`, and `96 kHz`), and enforces an `180 ms` `sonarBlankLeft` detector holdoff + Doppler floor re-seed across every `gTarget` transition (`setSonarTarget`, probe ramp, Pilot gain slider, sleep/wake) so gain ramps never self-trigger phantom strokes.
- **1:1 Pre-Gate Frame Alignment & Frozen Pre-Onset Baseline**: Buffers passive frames during `activeGateCount = 1..3` so `strokePassive` aligns 1:1 with `[strokeStartBb, strokeEndBb)` (symmetric `UP`/`DOWN` `τ_dip`), snapshots `strokeClutterI/Q`, `strokeNoiseAirDb`, and `strokeNoiseDopPow` at onset, and freezes idle clutter/noise tracking across pre-gate, stroke, `48 ms` `filtfiltReal` post-roll, and `60 ms` delay-line holdoff.
- **Regime-Isolated Calibration (`ag_lda_v1::<grille>::<sonar|uncoupled|passive>`)**: Separates coupled `19 kHz` sonar, uncoupled fallback, and passive calibrations with strict finite 6-vector validation (`fitShrinkageLDA`).

---

## 4. Verification

- Syntax check and full DSP, `node:vm` `AudioWorklet`, async hardware-race, loopback probe, clutter-invariance, and edge-case test suite:
  `node --check cells/grille-swipe/grille-swipe.js && timeout 60 node --test cells/grille-swipe/grille-swipe.test.mjs`
- Serve locally for live `getUserMedia` + `AudioWorklet` testing (`window.isSecureContext` required by browsers):
  `python3 -m http.server 8000` → open `http://localhost:8000`
