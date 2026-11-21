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
  - Rejected standalone abstract louver blinds (hid hardware placement) and multi-panel `1×1` dashboards (crowded `< 440px` tiles).
- **Zero-Reflow Empirical Workbench Overlay**:
  - Expanding (`.cell-acoustic.is-expanded` at `>= 768px` and `@container cell (width >= 540px)`) inserts an in-place `.ag-grid-placeholder` so sibling cells never shift regardless of grid column (`1`, `2`, or `3`), while elevating the Workbench to reveal the Frozen `s ∈ [0, 1]` Dual-Trace Stroke Oscilloscope, `19.00 kHz ± 100 Hz` MTI Waterfall, and 6-Feature Signed Diverging Fisher Log-Odds chart.

---

## 3. DSP & Layout Invariants (`cells/grille-swipe/grille-swipe.js`)

- **Coherent Homodyne Single-Worklet TX+RX (`createStreamEngine`)**: Synthesizes the right-channel `19.0 kHz` carrier and mixes RX `I/Q` using one shared `Float64` phase accumulator (`0.0000 Hz` drift), keeping Left output strictly `0.0`.
- **Two-Phase CoreAudio Input Lock (`rankAudioInputDevice`)**: Automatically switches off external default hijackers (USB wireless receivers, iPhone Continuity mics, AirPods) onto `MacBook Pro Microphone` with `echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`.
- **180 ms `-30.5 dBFS` Ultrasonic Loopback Self-Test**: Probes `19.0 kHz` SNR over `17.6 kHz` noise floor (`>= +8 dB`) before ramping to operating gain (`-18 dBFS`), catching muted speakers, headphones in Safari (where `audiooutput` labels are hidden), or macOS Voice Isolation.
- **Pre-Passive `19 kHz` Notch & Real-Envelope `filtfiltReal`**: Notches `19.0 kHz` (`Q = 12`) before computing `Sub/Mid/Air/Fric` and `>1.5 kHz` crest factor; computes `|z[m]| = hypot(I, Q)` *before* zero-phase `8 Hz` forward-backward filtering so Fresnel diffraction phase rotation never creates false interference nulls.
- **Container Query Isolation**: Uses `container-type: inline-size` on `.cell-acoustic` with an absolute `.ag-shell` child and `ResizeObserver` strictly on `.ag-canvas-wrap` wrappers (`0` Retina canvas feedback loops).

---

## 4. Verification

- Run automated DSP, filter, veto, and Shrinkage Fisher LDA tests:
  `timeout 60 node --test cells/grille-swipe/grille-swipe.test.mjs`
- Serve locally for live `getUserMedia` + `AudioWorklet` testing (`window.isSecureContext` required by browsers):
  `python3 -m http.server 8000` → open `http://localhost:8000`
