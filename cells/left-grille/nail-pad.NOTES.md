# Secondary Grid Cell 03 — Nail Scratch vs Soft Finger Tap (`cells/left-grille/nail-pad.*`)

## 1. Intent & Architecture

`cells/left-grille/nail-pad.js` and `cells/left-grille/nail-pad.css` implement **Secondary Grid Slot 03 (`#lg-sec-cell-3`)**, combining **TapSense** (Harrison et al., UIST 2011) and **ScratchInput** (Harrison & Hudson, UIST 2008) on the MacBook Pro unibody aluminum deck and left speaker grille:

- **Shared Bus Registration**: Registers into Secondary Slot `3` on `window.LeftGrilleLab` (`registerCell(3, spec)` or `_pending.push([3, spec])`), subscribing to `bus.subscribeAudio(({ samples, sampleRate, timeSec }) => ...)`, `bus.requestArm()`, and `bus.onStateChange(cb)`.
- **Strict `< 16 kHz` Acoustic Passband (`72 Hz – 15.2 kHz`)**: Every incoming audio sample passes through a 2nd-order `72 Hz` high-pass filter, dual `18.75 kHz` / `20.6 kHz` ultrasonic notch biquads, and a 4th-order `15.2 kHz` Butterworth low-pass filter before time-domain feature extraction, while the `256`-point periodic-Hann FFT strictly evaluates bins `<= 15.5 kHz`. This guarantees that `18–21 kHz` ultrasonic sonar carriers emitted on the shared bus never corrupt either spectral features or time-domain metrics (`crestFactor`, `zcr`, `attackMs`).
- **Three Physical Surface Classes + Harmonic Voice Veto**:
  1. **`SOFT PAD TAP` (`'soft-pad'`)**: Viscoelastic fingertip flesh tap (`duration 10–55 ms`, low-frequency flexural thud `80–950 Hz` dominates, steep roll-off `> 3 kHz`, spectral centroid `< 1.8 kHz`, negative `hfLfDb`, moderate crest factor).
  2. **`NAIL TAP` (`'nail-tap'`)**: Rigid $\alpha$-keratin fingernail impact (`duration 6–45 ms`, Dirac-like `< 3 ms` attack, bright `2.8–14 kHz` flexural/air click, spectral centroid `> 2.6 kHz`, positive `hfLfDb`, high crest factor).
  3. **`NAIL SCRATCH` (`'nail-scratch'`)**: Sustained fingernail drag across bead-blasted aluminum / CNC grille perforations (`duration >= 70 ms`, continuous broadband `3.5–15 kHz` stick-slip micro-chatter, Wiener spectral flatness `> 0.25`, high zero-crossing rate `>= 0.14`).
  4. **Voiced Speech Veto (`vetoReason: 'voice'`)**: Rejects human vowels, hums, and speech (`F0 = 95–370 Hz` pitch autocorrelation periodicity + `175–3200 Hz` formant concentration + low Wiener spectral flatness `< 0.24`).

### Module Ownership

| File | Responsibility |
| :--- | :--- |
| `cells/left-grille/nail-pad.js` (`LeftGrilleNailPad`) | `BiquadFilter`, `NailPadClassifier`, 48 kHz physical waveform synthesizers (`synthesizeSoftPadTap`, `synthesizeNailTap`, `synthesizeNailScratch`, `synthesizeVoicedSpeech`), `localStorage` calibration (`dwg.nailPadCal.v1`), and Secondary Slot 3 DOM UI (`mountNailPadCell`). |
| `cells/left-grille/nail-pad.css` | `.np-*`-scoped hero styles on the shared `ui-` classes and `--ui-` tokens; `position: absolute; inset: 0` 4:3 lock; class colours `--np-pad` (`--lg-sig-up`), `--np-nail` (`--ui-ink`; green is reserved for real connections), `--np-scratch` (`--lg-sig-down`); `ui-tile` container steps. |
| `cells/left-grille/nail-pad.test.js` | 13-test suite covering `soft-pad`, `nail-tap`, `nail-scratch`, voiced speech rejection, `18–21 kHz` sonar immunity, multi-gesture streaming, `44.1k`/`96k` + `NaN` resilience, fan step-up, `localStorage` calibration, DOM mount wiring, Trim/ARM lifecycle, `VOICE VETO` label recovery, and hidden-tab frame skipping. |

---

## 2. Design & Technical Decisions (`Protocol B` Synthesis)

1. **Dual Ultrasonic Notch + 4th-Order `15.2 kHz` Time-Domain Pre-Conditioner (`nail-pad.js:NailPadClassifier._initFiltersAndWindows`)**:
   - *Won*: Cascading biquad transmission zeros at `18.75 kHz` and `20.6 kHz` with a 4th-order `15.2 kHz` Butterworth low-pass filter before computing time-domain ZCR, peak, RMS, and crest factor, paired with a `256`-point periodic-Hann FFT capped at `15.5 kHz`.
   - *Rejected*: Filtering only in the FFT bin summation. Because `18.375 kHz` is only `0.29` octaves above `15.0 kHz`, a simple low-pass filter leaves enough ultrasonic carrier amplitude in the time domain to inflate zero-crossing rate (`qZcr`) and suppress crest factor during active sonar playback.
2. **Peak-Relative `-18 dB` Core Duration Trimming (`nail-pad.js:NailPadClassifier._classifyAndCommitBurst`)**:
   - *Won*: Trimming trailing hangover frames that fall more than `18 dB` below the burst's peak frame power before computing `durationMs` and power-weighted spectral features.
   - *Rejected*: Measuring duration strictly from first threshold crossing to final hangover drop, which allows low-level room reverberation after a strong `15 ms` nail tap to inflate `durationMs` toward the `70 ms` scratch boundary.
3. **Swiss/Braun 3-Color Semantic Coding & Tactile Specimen Well (`nail-pad.js:mountNailPadCell`, `nail-pad.css`)**:
   - *Won*: Pairing a 3-mode SVG glyph (rings for `SOFT PAD`, ink star for `NAIL TAP`, rust zig-zag for `NAIL SCRATCH`) with a live `0–12 kHz` spectral centroid band, opposing LF/HF split bar, and 3 synthetic 48 kHz Sim buttons (`Pad`, `Nail`, `Scratch`).

---

## 3. Hazards, Invariants & Edge Cases

- **Ultrasonic Isolation (`nail-pad.js:MAX_PASSBAND_HZ`)**: Never inspect FFT bins above `15.5 kHz` or bypass the time-domain notch/LPF cascade, as Cell 01 and sibling sonar cells transmit `18.375–21.375 kHz` carriers on the shared bus.
- **Zero Dynamic `innerHTML` (`nail-pad.js:h` / `svgEl`)**: All DOM and SVG nodes are constructed via `document.createElement` / `document.createElementNS` and `textContent`.
- **4:3 Row-Height Invariant (`nail-pad.css:.np-stage`)**: `.np-stage` must keep `position: absolute; inset: 0` inside `.np-cell` so internal controls and the calibration trim overlay never stretch the grid row height.
- **Status Pill Has One Source (`nail-pad.js:mountNailPadCell` / `baseStatusText` / `setStatus`)**: `LIVE · 48k` / `ARMING…` / `SIM ONLY` (bus error, was `SIM READY`) / `READY` derive from the last bus state. `VOICE VETO` is an override that is cleared back to `baseStatusText()` once the classifier's `vetoReason` clears; a finished Sim also restores it (so a denied mic still reads `SIM ONLY`, never `LIVE`). `setStatus` is the only writer: label text + `data-veto` on `.np-status`, tone + tip on the `.ui-pill` wrapper.
- **Hidden Tab Costs Nothing (`nail-pad.js:attachBus` audio subscriber)**: the bus suspends its AudioContext while hidden; any mic block that still arrives while `document.hidden` (async suspend, `processDuplexFrame` injection) is dropped and `classifier.reset()` runs on the first visible block after such a drop. A running Sim interval stops at its next tick once the tab is hidden.
- **`[ARM]` Disarms the Whole Shared Bus**: when the bus is live, `[LIVE]` calls `bus.stopAll({ dispatchClose: false })`, which also stops chirp sonar TX and the other passive cells (tap-zones instead pauses locally). Test 11 pins this behaviour.
- **Narrow Tiles**: the page grid keeps every tile at 328 px or wider (one column below 720 px), so Sim and Trim in the foot are always reachable there. A narrower mount (< 320 px) loses the foot to the base size step and shows `.np-compact-note` ("Widen for Sim and Trim") instead of silently dropping the controls.

---

## 4. UI (shared sensor cell frame, `left-grille/NOTES.md`)

- Head: `03` · `Nail or pad` · status pill · `Arm` (`.np-btn--arm.ui-btn--sm`; `Arm` / `Arming…` /
  `Live` / `Retry`; rust while live or arming; a click while live disarms the whole shared bus).
- Body hero: glyph button (`.np-tactile-well`: click = pad, Shift = nail, Option = scratch) + class
  name (`.np-badge`, 24 px, quiet grey until the first gesture) + meta line with confidence and
  intensity; then the spectrum: `Centroid` / `HF/LF` readouts, the centroid band (grows to fill the
  body, 16–96 px), the LF/HF split, and the last three gestures as one quiet line.
- Foot: `Sim` label + `Pad` / `Nail` / `Scratch` (quiet `ui-btn--sm`), `Trim`, and `NF` on the right.
- Trim panel covers the body only (head and foot stay usable), `ui-slider`s, Reset / Done (Esc).
- Every control, readout and the pill has a `data-tip` (`NP_TIPS`); no `title`.

Sibling contract across `tap-zones`, `nail-pad`, `chirp-sonar` (and `breath-puff`, `lid-angle`, `iphone-dial`):
same head, same pill words (`READY`, `ARMING…`, `LIVE · 48k`, `SIM · …`, `SIM ONLY` for a bus error
with the full error in the pill's `data-tip`), Arm label in sentence case (`Arm` / `Arming…` /
`Live` / `Retry`), running = `aria-pressed="true"` + `data-tone="attention"`, extra controls in the
foot as quiet `ui-btn--sm`. Pills are never green: idle grey for ready / paused / simulated,
rust for live, arming, calibrating, vetoes and errors. Below 320 px tile width the base hides the
foot; a `*-compact-note` line in the body then says the foot controls need a wider tile (the page
grid never goes below 328 px, so this only shows for narrow mounts).

## 5. How to Run & Verify

- **Hidden tabs**: a Sim (`Pad` / `Nail` / `Scratch`, tactile well) stops at its first interval tick while `document.hidden`; drive it in a visible tab, or override `document.hidden` when automating.
- **Syntax & Unit Test Suite**:
  `node --check cells/left-grille/nail-pad.js && timeout 60 node --test cells/left-grille/nail-pad.test.js`
