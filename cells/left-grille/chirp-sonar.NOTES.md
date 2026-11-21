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
| `cells/left-grille/chirp-sonar.css` | `.cs-*`-scoped hero styles on the shared `ui-` classes and `--ui-` tokens; `.cs-stage { position: absolute; inset: 0; }` 4:3 lock; `ui-tile` container steps. |
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
   - Encodes Left-dominant echoes in `--lg-sig-up`, Right-dominant echoes in `--lg-sig-down`, and centred echoes in a slate (`#1d2a44`, hero-only) on a `4..55 cm` top-down range canvas so pushes sweep visually downward toward the keyboard and waves change colour left-to-right or right-to-left. The palette (`--ui-well`, `--ui-ink`, `--ui-surface`, the two signal tokens) is read once on the first draw (`readPalette`), with literal fallbacks for Node mocks.

---

## 3. Hazards, Invariants & Edge Cases

- **Sub-40 kHz TX Safety (`StereoChirpGenerator.fillBuffers`)**: Never emit chirps when `sampleRate < 40000` (e.g., Bluetooth HFP `16 kHz`); both output channels fill with `0` and `ChirpSonarEngine` sets `ultrasonicSupported = false`.
- **Far-Zone Noise Floor Estimation (`ChirpSonarEngine._processFrame`)**: Noise floor samples both `4..55 cm` and quiet outer lags (`lagMax + 24 .. lagMax + 120`) using `min(nearMedian, farMedian)` so a broad near-field hand echo cannot inflate the noise floor and suppress its own SNR.
- **Zero `innerHTML` & Strict 4:3 Lock (`chirp-sonar.js:h`, `chirp-sonar.css:.cs-stage`)**: All DOM updates use `textContent` / `dataset`; `.cs-stage` uses `position: absolute; inset: 0;` so the cell never blows out secondary grid row heights.
- **Bus Coordination**: Subscribes to `bus.subscribeAudio` and ignores frames whenever `pkt.txMode !== 'chirp'` or while a local `Sim` playback is running; `stopSim()` always restores `engine.setAutoAlignDirectPath(true)` for live hardware alignment, `resetClutter()` clears partial `_frameFill` buffers, and `handleSecondaryClose()` stops simulation timers and cancels any pending `rafId` on `lg-secondary-close`.
- **No Frames ⇒ Explicit Not-Live Readout (`chirp-sonar.js:renderNotLive`)**: once sonar stops being live (SONAR off → `txMode 'off'`, ARM ARRAY disarm, page close → bus `idle`) or a Sim ends while sonar is off, no further frames arrive, so `renderNotLive()` replaces `LISTENING` / `TRACKING` and the range readout with the last gesture (or `STANDBY`) and `--.-`.
- **Hidden Tab (`chirp-sonar.js:mountChirpSonarCell` audio subscriber)**: the bus mutes TX and suspends its AudioContext while `document.hidden`. Any block that still arrives while hidden (async suspend, `processDuplexFrame` injection) carries `txMode: 'chirp'` but no chirp; it is dropped (no FFTs) and `engine.resetClutter()` runs on the first visible block after such a drop, so the direct path returning is relearned instead of showing as a phantom echo. A running Sim stops at its next tick when the tab hides.
- **Below 40 kHz (`chirp-sonar.js:applyFrameToUi`)**: frames with `ultrasonicSupported === false` show `NO ULTRASOUND` (`16k mic < 40k`) instead of a permanent `CALIBRATING`; the status pill shows `LOW RATE · 16k`.
- **Status Pill Error Text (`chirp-sonar.js:updateStatusPill` / `setPill`)**: a bus error shows `SIM ONLY` (same wording as the nav bar) with the full bus message in the pill's `data-tip`. Every branch of `updateStatusPill` sets text, tone and tip together through `setPill`, so no tip outlives its state. Do not use `title` here: the tooltip copies a title into `data-tip` on first show, so a later-removed title would leave a stale error tip.
- **Narrow Tiles**: the page grid keeps every tile at 328 px or wider, so Sim and Zero in the foot are always reachable there. A narrower mount (< 320 px) loses the foot to the base size step and shows `.cs-compact-note` ("Widen for Sim and Zero") instead.

---

## 4. UI (shared sensor cell frame, `left-grille/NOTES.md`)

- Head: `04` · `Chirp sonar` · status pill (`READY`, `ARMING…`, `LIVE · 48k`, `LOW RATE · 16k`,
  `SIM · PUSH` …, `SIM ONLY`) · `Sonar` (`.cs-btn--sonar.ui-btn--sm`, rust + `aria-pressed` while
  chirping; `Arming…` / `Retry` labels; `aria-disabled` with no bus).
- Body hero: range (`.cs-range-num` in a 24 px `ui-readout--hero`, `--.-` when no hand) with the gesture
  on the right (`.cs-gesture-val`, colour by side), the L/R echo balance hairline, and the echo
  profile canvas in a `ui-well` filling the rest.
- Foot: `Sim` label + `Push` / `Pull` / `Wave`, `Zero`, and `FMCW` (tip explains it) on the right.
- Every control, readout and the pill has a `data-tip` (`CS_TIPS`); no `title`.

Sibling contract across `tap-zones`, `nail-pad`, `chirp-sonar` (and `breath-puff`, `lid-angle`, `iphone-dial`):
same head, same pill words (`READY`, `ARMING…`, `LIVE · 48k`, `SIM · …`, `SIM ONLY` for a bus error
with the full error in the pill's `data-tip`), Arm label in sentence case (`Arm` / `Arming…` /
`Live` / `Retry`), running = `aria-pressed="true"` + `data-tone="attention"`, extra controls in the
foot as quiet `ui-btn--sm`. Pills are never green: idle grey for ready / paused / simulated,
rust for live, arming, calibrating, vetoes and errors. Below 320 px tile width the base hides the
foot; a `*-compact-note` line in the body then says the foot controls need a wider tile (the page
grid never goes below 328 px, so this only shows for narrow mounts).

## 5. How to Run & Verify

- **Syntax check**:
  `node --check cells/left-grille/chirp-sonar.js`
- **Hidden tabs**: in a background/hidden tab the Sim buttons stop at the first interval tick (by design, see Hidden Tab above); drive them in a visible tab, or override `document.hidden` when automating.
- **Unit & synthesized 48 kHz acoustic physics test suite (14 tests, incl. not-live readout, hidden-tab skip, sub-40k label)**:
  `timeout 60 node --test cells/left-grille/chirp-sonar.test.js`
- **Interactive verification**:
  Open the Left Grille secondary grid (`#left-grille`), inspect **Cell 04 (`18–20kHz Chirp Sonar`)**, click Sim `Push`, `Pull`, and `Wave` (alternating `→`/`←`) to verify live matched-filter waterfall trajectories and gesture readouts, or click `Sonar` on a 48 kHz MacBook to run live contactless ultrasonic sonar.
