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
| `cells/left-grille/nail-pad.css` | Strictly scoped styles (`.np-cell`, `.np-stage`) with `position: absolute; inset: 0` 4:3 cell lock, Swiss/Braun palette (`#0052cc` Cobalt for Soft Pad, `#047857` Emerald for Nail Tap, `#c93700` Vermilion for Nail Scratch), and `@container` breakpoints down to `150px`. |
| `cells/left-grille/nail-pad.test.js` | 9-test verification suite covering `soft-pad`, `nail-tap`, `nail-scratch`, voiced speech rejection, `18–21 kHz` sonar immunity, multi-gesture streaming, `44.1k`/`96k` + `NaN` resilience, `localStorage` calibration, and DOM mount wiring. |

---

## 2. Design & Technical Decisions (`Protocol B` Synthesis)

1. **Dual Ultrasonic Notch + 4th-Order `15.2 kHz` Time-Domain Pre-Conditioner (`nail-pad.js:NailPadClassifier._initFiltersAndWindows`)**:
   - *Won*: Cascading biquad transmission zeros at `18.75 kHz` and `20.6 kHz` with a 4th-order `15.2 kHz` Butterworth low-pass filter before computing time-domain ZCR, peak, RMS, and crest factor, paired with a `256`-point periodic-Hann FFT capped at `15.5 kHz`.
   - *Rejected*: Filtering only in the FFT bin summation. Because `18.375 kHz` is only `0.29` octaves above `15.0 kHz`, a simple low-pass filter leaves enough ultrasonic carrier amplitude in the time domain to inflate zero-crossing rate (`qZcr`) and suppress crest factor during active sonar playback.
2. **Peak-Relative `-18 dB` Core Duration Trimming (`nail-pad.js:NailPadClassifier._classifyAndCommitBurst`)**:
   - *Won*: Trimming trailing hangover frames that fall more than `18 dB` below the burst's peak frame power before computing `durationMs` and power-weighted spectral features.
   - *Rejected*: Measuring duration strictly from first threshold crossing to final hangover drop, which allows low-level room reverberation after a strong `15 ms` nail tap to inflate `durationMs` toward the `70 ms` scratch boundary.
3. **Swiss/Braun 3-Color Semantic Coding & Tactile Specimen Well (`nail-pad.js:mountNailPadCell`, `nail-pad.css`)**:
   - *Won*: Pairing a 3-mode SVG tactile deck indicator (concentric Cobalt viscoelastic rings for `SOFT PAD`, radial Emerald Dirac star for `NAIL TAP`, serrated Vermilion tribological wave for `NAIL SCRATCH`) with a live `0–12 kHz` spectral centroid vernier scale, opposing LF/HF split bar, and 3 synthetic 48 kHz test buttons (`Pad`, `Nail`, `Scratch`).

---

## 3. Hazards, Invariants & Edge Cases

- **Ultrasonic Isolation (`nail-pad.js:MAX_PASSBAND_HZ`)**: Never inspect FFT bins above `15.5 kHz` or bypass the time-domain notch/LPF cascade, as Cell 01 and sibling sonar cells transmit `18.375–21.375 kHz` carriers on the shared bus.
- **Zero Dynamic `innerHTML` (`nail-pad.js:h` / `svgEl`)**: All DOM and SVG nodes are constructed via `document.createElement` / `document.createElementNS` and `textContent`.
- **4:3 Row-Height Invariant (`nail-pad.css:.np-stage`)**: `.np-stage` must keep `position: absolute; inset: 0` inside `.np-cell` so internal controls and the calibration trim overlay never stretch the grid row height.

---

## 4. How to Run & Verify

- **Syntax & Unit Test Suite**:
  `node --check cells/left-grille/nail-pad.js && timeout 60 node --test cells/left-grille/nail-pad.test.js`
