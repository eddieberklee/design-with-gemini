# Shared 48 kHz Acoustic Bus & Secondary Grid Slot Registry (`cells/left-grille/hub-bus.NOTES.md`)

## 1. Intent & Architecture

`cells/left-grille/shared-bus.js` + `cells/left-grille/ui.js` provide the **Shared Full-Duplex 48 kHz Acoustic Bus** and **Dynamic Secondary Slot Registry** (`window.LeftGrilleLab`) that host Secondary Grid Cells `02–07` alongside Cell `01` (`Left Grille Swipe Detector`) inside `#left-grille-secondary-grid`:

- **Secondary Grid Slot Registry (`shared-bus.js:createLeftGrilleLab`)**:
  - Preserves any pre-created `window.LeftGrilleLab` object reference and drains its `_pending` queue (`[slotNumber, spec]`) so sibling cell scripts (`tap-zones.js`, `nail-pad.js`, `chirp-sonar.js`, `breath-puff.js`, `lid-angle.js`, `iphone-dial.js`) can load in **any** `<script defer>` order relative to `shared-bus.js` and `ui.js`.
  - Exposes `LeftGrilleLab.registerCell(slotNumber, spec)` for secondary slots `2..9` (`#lg-sec-cell-2` .. `#lg-sec-cell-9`). Mounts immediately if `#lg-sec-cell-${slotNumber}` is already in the DOM, or queues in the registry until `ui.js:mountLeftGrillePortal` calls `LeftGrilleLab.attachSecondarySlots(secondarySlotMap)`.
  - Isolates `spec.mount(cellEl, bus)` inside a `try/catch` guard and tracks `(spec, el)` pairs so a fault in one sensor cell can never break sibling cells or double-mount.

- **Shared 48 kHz Acoustic Bus (`shared-bus.js:SharedAcousticBus`, exposed as `LeftGrilleLab.bus`)**:
  - Acquires **one** raw unprocessed hardware microphone stream (`echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`, `sampleRate: { ideal: 48000 }`), automatically preferring `/macbook|built-in|internal/i` input + `AudioContext.setSinkId` built-in stereo speakers when external/Bluetooth audio devices are active.
  - Fans out sanitized `512`-sample `Float32Array` blocks (`~93.75 Hz` at `48 kHz`) to all `subscribeAudio(fn)` listeners with `{ samples, sampleRate, timeSec, txMode }`.
  - Multiplexes true-stereo ultrasonic TX generators (`registerTxGenerator(modeId, genFn)` + `setTxMode(modeId)` / `getTxMode()`) across Left (`leftOut`) and Right (`rightOut`) MacBook speakers with `15 ms` raised-cosine ramp-in, ramp-out, and overlap crossfading.
  - Coordinates mutually with Cell `01` (`ui.js:bindSharedLab` / `disarmSharedBusForCell1`) and `.lg-nav-bar`'s global **`[● ARM ARRAY]`** toggle (`#lg-arm-array-btn`) so 1 click arms all secondary acoustic cells (`02–06`), switching between Cell `01` and the shared bus never opens competing hardware streams, and exiting the secondary view (`ui.js:runPortalTransition`) invokes `LeftGrilleLab.bus.stopAll()` and dispatches `CustomEvent('lg-secondary-close')`.

---

## 2. Design & Technical Decisions

1. **Lock-Step Full-Duplex Framing + `AudioWorkletNode` Fallback (`shared-bus.js:SharedAcousticBus._runArm`)**:
   - *Won*: Full-duplex `512`-sample stereo `ScriptProcessorNode(512, 1, 2)` when available (giving main-thread closure generators `genFn(leftOut, rightOut, sampleRate, sampleOffset)` zero-jitter lock-step framing at exact multiples of `512`, dividing `N_chirp = 1024` evenly and avoiding `file://` Blob CSP blocks), paired with a self-contained `AudioWorkletNode` (`lg-shared-acoustic-bus-processor`) fallback that accumulates `4 × 128 = 512` RX quanta and streams `512`-sample stereo TX blocks when `createScriptProcessor` is absent.
   - *Rejected*: Attempting `genFn.toString()` inside `AudioWorkletGlobalScope`, which breaks any sibling generator closing over module-scoped lookup tables (`chirp-sonar`, `lid-angle`).

2. **Multi-Overlap `15 ms` Raised-Cosine Crossfade Engine (`shared-bus.js:SharedAcousticBus._renderTxBlock`)**:
   - *Won*: Per-mode raised-cosine phase tracking (`0.5 - 0.5 * Math.cos(Math.PI * phase)` over `round(0.015 * sampleRate)` samples) with a `_fadingModes` map so even rapid `< 15 ms` multi-switches (`chirp -> lid-ping -> off`) reach exact `0.0` with zero first-derivative clicks and unity steady-state gain (`1.0`).
   - *Rejected*: Abrupt buffer switching (audible speaker clicks that trigger false chassis-tap detections in Slots `02`/`03`) or asymptotic single-pole IIR envelopes that never reach exact `0.0`.

3. **One-Click Whole-Array Acoustic Coexistence (`ui.js:toggleSharedArray`)**:
   - *Won*: Passive cells (`02` Tap Zones, `03` Nail vs Pad, `05` Breath Puff) operate below `16 kHz`, while `04` Chirp Sonar emits `18.0–20.5 kHz` (`'chirp'`) and `06` Lid Angle passively piggybacks on `'chirp'` (or uses `'lid-ping'`). Clicking `[● ARM ARRAY]` in `.lg-nav-bar` auto-selects `'chirp'` (falling back to `'lid-ping'` or `'off'`) so one click powers all five acoustic cells simultaneously.

---

## 3. Hazards, Invariants & Edge Cases

- **Bluetooth HFP `< 40 kHz` & Hidden-Tab Ultrasonic Silence (`shared-bus.js:SharedAcousticBus._renderTxBlock`)**: Whenever `sampleRate < 40000` or `document.hidden` is true, `_renderTxBlock` immediately zero-fills `leftOut` and `rightOut` and resets `_activeTxPhase = 0` so `18–20.5 kHz` carriers can never alias into audible tones on `16 kHz` Bluetooth HFP profiles.
- **Per-Subscriber `Float32Array(512)` Isolation (`shared-bus.js:SharedAcousticBus._emit512Block`)**: Each subscriber receives an isolated `Float32Array(512)` copy (with `NaN`/`±Infinity` sanitized to `0`) so in-place Hann windowing or ring-buffer retention in one cell never corrupts downstream subscribers.
- **`sessionEpoch` Handle Detach & Single-Prompt `NotAllowedError` (`shared-bus.js:SharedAcousticBus.stopAll` / `_requestRawMic`)**: `stopAll()` increments `_sessionEpoch` and detaches Web Audio handles synchronously before the `20 ms` TX ramp-down, and `_requestRawMic()` retries relaxed boolean constraints only on `OverconstrainedError`/`TypeError`.
- **Close Event Even When Bus Was Idle (`shared-bus.js:SharedAcousticBus.stopAll`)**: `stopAll()` dispatches `CustomEvent('lg-secondary-close')` even when `bus.state === 'idle'` so non-mic secondary cells (`06` Lid HID SSE, `07` iPhone BLE/WSS) still tear down cleanly when leaving `#left-grille` (whereas internal handoffs to Cell `01` pass `{ dispatchClose: false }`).
- **Secondary `.cell` Layout Lock (`left-grille.css:#left-grille-secondary-grid > .cell`)**: Every `#lg-sec-cell-1` .. `#lg-sec-cell-9` preserves `.cell` (`aspect-ratio: 4 / 3`) plus `position: relative; overflow: hidden; container-type: inline-size;` scoped strictly under `#left-grille-secondary-grid`.

---

## 4. How to Run & Verify

- **Syntax check**:
  `node --check cells/left-grille/shared-bus.js && node --check cells/left-grille/ui.js && node --check cells/left-grille/shared-bus.test.js`
- **Unit & integration test suites (`shared-bus` + Cell `01` regression)**:
  `timeout 60 node --test cells/left-grille/shared-bus.test.js cells/left-grille/acoustic-engine.test.js`
