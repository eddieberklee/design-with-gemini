# Secondary Grid Cell 04 — 18–20.5 kHz Ultrasonic Chirp Sonar (`cells/left-grille/chirp-sonar.*`)

## 1. Intent & Architecture

Cell 04 turns a MacBook's stereo speakers (`~30 cm` physical baseline across the keyboard) and built-in microphone into a contactless **18.0–20.5 kHz FDMA linear FMCW ultrasonic radar** detecting:

1. **Live Hand Distance (`5..55 cm`)** + **24-bin Range-Time Radar Waterfall** (`4..55 cm`).
2. **Radial Gestures**: `PUSH IN ↓` (approaching laptop, e.g. `42 cm -> 10 cm`) and `PULL OUT ↑` (receding, `10 cm -> 42 cm`).
3. **Stereo Cross-Channel Waves**: `WAVE →` (`L -> R`) and `WAVE ←` (`R -> L`) extracted from the relative echo arrival/energy-centroid shift between the Left (`18.00–19.15 kHz`) and Right (`19.35–20.50 kHz`) ultrasonic bands.

### Owned Files & Exports

| File | Responsibility |
| :--- | :--- |
| `cells/left-grille/chirp-sonar.js` | UMD module exporting `StereoChirpGenerator`, `ChirpSonarEngine`, `synthesizeGestureSignal`, `buildReferenceChirp`, `buildAnalyticRefSpectrum`, `fftRadix2`, `ifftRadix2`, and `mountChirpSonarCell`; registers Secondary Slot `4` (`LeftGrilleLab.registerCell(4, spec)` or `LeftGrilleLab._pending`) and shared-bus TX generator `'chirp'`. |
| `cells/left-grille/chirp-sonar.css` | Strictly `.cs-*` scoped Swiss/Braun styles with `.cs-stage { position: absolute; inset: 0; }` 4:3 lock and `@container` responsive rules down to `150px` cell width. |
| `cells/left-grille/chirp-sonar.test.js` | Reproducible `node --test` suite verifying click-free FDMA spectrum & `< 40 kHz` TX mute, `8..44 cm` range accuracy, static room clutter rejection, `push` / `pull` / `wave-right` / `wave-left` detection on synthesized 48 kHz echoes, hardware loopback auto-alignment, `44.1k/96k/16k` rates, and `NaN` sanitization. |

---

## 2. Design & Technical Decisions

1. **384-Sample Hann-Windowed Active Pulse inside `N = 1024` Period (`chirp-sonar.js:buildReferenceChirp`)**:
   - *Won*: `384`-sample (`8.0 ms`) raised-cosine Hann linear chirp followed by `640` samples (`13.33 ms`) of quiet listening inside the `1024`-sample (`21.33 ms`, `46.875 Hz`) radar sweep period (`2048` samples at `88.2/96 kHz` to keep identical `46.875 Hz` bin spacing and sweep rate).
   - *Why rival 100%-duty Tukey (`L = 1024`) lost*: Empirical measurement showed `L = 1024` Tukey suffers `21.4 cm` of FMCW range-Doppler walk at `60 cm/s` hand velocity (`f_d ≈ 67 Hz` vs `S = 53.9 kHz/s`), pushing approaching close-range echoes past lag `0`. Shortening the active Hann pulse to `384` samples raises sweep rate `2.67×` (`143.75 kHz/s`), cutting Doppler walk to `8.0 cm` at `60 cm/s` while achieving **`47.0 dB` Left/Right FDMA isolation** across the `200 Hz` guard band (`19.15–19.35 kHz`) and `C^1`-continuous zero-click edges.
2. **Analytic Complex Matched Filter + Motion-Gated Complex Clutter Subtraction (`chirp-sonar.js:buildAnalyticRefSpectrum`, `ChirpSonarEngine._processFrame`)**:
   - *Won*: Doubling positive reference FFT bins (`1..N/2-1`) and zeroing negative bins yields the complex analytic envelope `H[lag]` with zero `19 kHz` carrier ripple. Subtracting complex `H_bg[lag]` cancels phase-locked direct speaker-to-mic leakage (including its near-field sidelobes) and static desk/screen multipath in I/Q space.
   - *Motion-gated adaptation*: Fast background tracking (`alpha = 0.08`) when quiet, frozen (`alpha = 0`) during active hand motion so high-SNR gestures never burn a post-exit ghost echo into `H_bg`, resuming (`alpha = 0.08`) after `~0.65 s` (`30` frames) of stationary presence so newly placed desk objects fade out cleanly. Silent startup frames (`maxAbs < 1e-6`) are skipped during warmup so initial hardware-loopback silence cannot bias `H_bg`.
3. **Optional Hardware Direct-Path Auto-Alignment (`ChirpSonarEngine.autoAlignDirectPath`)**:
   - *Won*: Live hardware sessions enable `autoAlignDirectPath: true` so `directLagL`/`directLagR` lock onto the strongest stationary direct speaker-to-mic peak during the 6-frame warmup, removing arbitrary macOS CoreAudio loopback buffer latency automatically. Synthesized tests/Sim playback set `autoAlignDirectPath: false` (`lag0 = 0`) so strong static reflectors never shift range zero.
4. **Stereo-Tinted 24-Bin Waterfall (`chirp-sonar.js:mountChirpSonarCell`)**:
   - Encodes Left-dominant echoes in Blueshift Cobalt (`#0052cc`), Right-dominant echoes in Braun Vermilion (`#c93700`), and centered echoes in deep slate (`#1d2a44`) on a `4..55 cm` top-down range canvas so pushes sweep visually downward toward the keyboard and waves transition color left-to-right or right-to-left.

---

## 3. Hazards, Invariants & Edge Cases

- **Sub-40 kHz TX Safety (`StereoChirpGenerator.fillBuffers`)**: Never emit chirps when `sampleRate < 40000` (e.g., Bluetooth HFP `16 kHz`); both output channels fill with `0` and `ChirpSonarEngine` sets `ultrasonicSupported = false`.
- **Far-Zone Noise Floor Estimation (`ChirpSonarEngine._processFrame`)**: Noise floor samples both `4..55 cm` and quiet outer lags (`lagMax + 24 .. lagMax + 120`) using `min(nearMedian, farMedian)` so a broad near-field hand echo cannot inflate the noise floor and suppress its own SNR.
- **Zero `innerHTML` & Strict 4:3 Lock (`chirp-sonar.js:h`, `chirp-sonar.css:.cs-stage`)**: All DOM updates use `textContent` / `dataset`; `.cs-stage` uses `position: absolute; inset: 0;` and `@container` breakpoints at `310px`, `235px`, and `180px` so the cell never blows out secondary grid row heights.
- **Bus Coordination**: Subscribes to `bus.subscribeAudio` and ignores frames whenever `pkt.txMode !== 'chirp'` or while a local `Sim` playback is running; `stopSim()` always restores `engine.setAutoAlignDirectPath(true)` for live hardware alignment, `resetClutter()` clears partial `_frameFill` buffers, and `handleSecondaryClose()` stops simulation timers and cancels any pending `rafId` on `lg-secondary-close`.

---

## 4. How to Run & Verify

- **Syntax check**:
  `node --check cells/left-grille/chirp-sonar.js`
- **Unit & synthesized 48 kHz acoustic physics test suite**:
  `timeout 60 node --test cells/left-grille/chirp-sonar.test.js`
- **Interactive verification**:
  Open the Left Grille secondary grid (`#left-grille`), inspect **Cell 04 (`18–20kHz Chirp Sonar`)**, click `Sim Push`, `Sim Pull`, and `Sim Wave` (alternating `→`/`←`) to verify live matched-filter waterfall trajectories and gesture readouts, or click `SONAR` on a 48 kHz MacBook to run live contactless ultrasonic sonar.
