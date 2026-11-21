# Cell 05 — Left Grille & Hardware Acoustic Secondary Grid Lab (`cells/left-grille/`)

## 1. Intent & Architecture

`cells/left-grille/` implements **Cell 05** on the primary grid (`#cell-left-grille`) and its seamless in-page **9-Cell Secondary Grid** (`#left-grille-secondary-grid`), preserving 100% `.grid` and `4:3` `.cell` sizing parity with the main grid while hosting **7 physical MacBook & iPhone hardware-sensing instruments** coordinated by a single `48 kHz` unprocessed Web Audio bus (`window.LeftGrilleLab.bus`):

| Secondary Slot | Instrument | Core Physics & Transport | Slice Notes & Tests |
| :--- | :--- | :--- | :--- |
| **Slot 01 (`#lg-sec-cell-1`)** | **Left Grille Swipe Sonar** | 4-carrier left-speaker ultrasonic comb (`18.375–21.375 kHz`), `2.93 Hz/bin` baseband Doppler, pinhole shadow & velocity-compensated tribological tilt (`UP`/`DOWN`, `cm/s`, `% TOP`/`% BTM`) | `acoustic-engine.js` · `acoustic-engine.test.js` (`11` tests) |
| **Slot 02 (`#lg-sec-cell-2`)** | **Chassis Tap Zones** | `< 16 kHz` Lamb plate-wave dispersion, forward-scan `riseTimeMs`, cavity boom & HF air attenuation + 4-zone Mahalanobis learner (`top-left`, `left-palm`, `trackpad-rim`, `right-palm`) | [`tap-zones.NOTES.md`](tap-zones.NOTES.md) · `tap-zones.test.js` (`9` tests) |
| **Slot 03 (`#lg-sec-cell-3`)** | **Nail vs Soft Pad** | *TapSense* + *ScratchInput* `< 16 kHz` spectral centroid, `-18 dB` core duration, Wiener flatness, fan-step recovery & harmonic voice veto (`soft-pad`, `nail-tap`, `nail-scratch`) | [`nail-pad.NOTES.md`](nail-pad.NOTES.md) · `nail-pad.test.js` (`11` tests) |
| **Slot 04 (`#lg-sec-cell-4`)** | **18–20.5 kHz Chirp Sonar** | Stereo FDMA Hann-tapered FMCW chirps (`18.00–19.15 kHz` L, `19.35–20.50 kHz` R), analytic matched filter + motion-gated clutter subtraction (`push`, `pull`, `wave-left`, `wave-right`, `4–55 cm`) | [`chirp-sonar.NOTES.md`](chirp-sonar.NOTES.md) · `chirp-sonar.test.js` (`11` tests) |
| **Slot 05 (`#lg-sec-cell-5`)** | **Grille Breath Puff** | Dual-rate `20–200 Hz` Karman vortex stagnation-pressure roar + `-12 dB/oct` roll-off + NACF harmonic voice/hum veto driving an inertial anemometer pinwheel (`breeze`, `puff`, `blow`) | [`breath-puff.NOTES.md`](breath-puff.NOTES.md) · `breath-puff.test.js` (`10` tests) |
| **Slot 06 (`#lg-sec-cell-6`)** | **Lid Angle (`0°–135°`)** | Dual-mode: (A) `18.2–20.4 kHz` + bit-exact `'chirp'`-piggyback Wiener-deconvolved display reflection sonar + (B) `lid-bridge.mjs` local SSE helper reading Apple `IOHIDManager` `LidAngleSensor` (`0x05AC:0x8104`) | [`lid-angle.NOTES.md`](lid-angle.NOTES.md) · `lid-angle.test.js` (`11` tests) |
| **Slot 07 (`#lg-sec-cell-7`)** | **iPhone Spin Dial** | 3D gravity-projected `DeviceMotionEvent.rotationRate` (`dot(ω, g_hat)`, face-up/down gimbal-free, `0°/min` rest drift, 24 detents) via scannable QR (`dial-phone.html`) over WSS MQTT / Wi-Fi WS / Web Bluetooth (`navigator.bluetooth`) | [`iphone-dial.NOTES.md`](iphone-dial.NOTES.md) · `iphone-dial.test.js` (`11` tests) |
| **Shared Bus & Portal** | **`LeftGrilleLab.bus` & `ui.js`** | Single-prompt raw `48 kHz` mic capture, stereo `15 ms` raised-cosine TX multiplexer, `[● ARM ARRAY]` 1-click header arming, bidirectional Cell 01 handoff, and `lg-secondary-open` / `lg-secondary-close` lifecycle | [`hub-bus.NOTES.md`](hub-bus.NOTES.md) · `shared-bus.test.js` (`12` tests) |

---

## 2. Key Architectural Invariants & Hazards

1. **Frequency-Division Coexistence (`< 16 kHz` Passive vs `18.0–21.4 kHz` Active Sonar)**:
   - Slots `02` (`tap-zones`), `03` (`nail-pad`), and `05` (`breath-puff`) notch/low-pass strictly below `16 kHz` so they run **simultaneously** on the shared `48 kHz` mic stream even while Slot `04` (`chirp-sonar`) or Slot `06` (`lid-angle`) actively emits `18.0–20.5 kHz` stereo ultrasonic chirps.
2. **Single-Stream Hardware Arbitration (`shared-bus.js:SharedAcousticBus` & `ui.js`)**:
   - Clicking `[● ARM ARRAY]` in the secondary nav bar opens a single unprocessed `getUserMedia` stream (`echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`, auto-pinned to Built-in MacBook Mic & `setSinkId` Speakers) and coordinates mutually with Slot `01`'s standalone `AudioWorklet` controller so two `getUserMedia` sessions never compete.
3. **Deterministic Back/Escape Teardown (`ui.js:runPortalTransition` & `shared-bus.js:stopAll`)**:
   - Returning to the main grid (`← Grid`, `Escape`, browser Back, or cross-cell hash change) synchronously detaches audio handles, extinguishes the macOS menu-bar mic indicator, closes `AudioContext`, and dispatches `lg-secondary-close` so Slot `06` SSE probes and Slot `07` BLE/WSS links clean up immediately.
4. **Strict `4:3` Zero-Overflow Containment**:
   - Every secondary slot (`#lg-sec-cell-1` .. `#lg-sec-cell-9`) retains `.cell` (`aspect-ratio: 4 / 3; position: relative; overflow: hidden; container-type: inline-size;`) with `position: absolute; inset: 0;` inner stages so internal controls never stretch grid row heights from `320px` to `2560px`.

---

## 3. How to Run & Verify

- **All 86 unit, physics & lifecycle tests across all 8 suites**:
  `timeout 60 node --test cells/left-grille/*.test.js`
- **JavaScript syntax gate**:
  `for f in cells/left-grille/*.js cells/left-grille/*.mjs; do node --check "$f"; done`
- **Optional native MacBook Lid Angle HID bridge (`127.0.0.1:8791`)**:
  `node cells/left-grille/lid-bridge.mjs`
- **Live browser server**:
  `python3 -m http.server 8000` → open `http://localhost:8000/#left-grille`
