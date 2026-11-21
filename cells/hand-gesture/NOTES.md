# Cell 08 — Webcam Hand & Spatial Gesture Cursor (`cells/hand-gesture/`)

## 1. Intent & Architecture

`cells/hand-gesture/` implements **Cell 08** on the primary grid and its in-page **9-Cell Spatial Hand & Gesture Studio**, turning a standard RGB webcam (`@mediapipe/tasks-vision@1.2.3`) into a low-latency spatial cursor supporting **hand raise recognition, 2D position tracking, pinch (click/drag/zoom), continuous wrist rotation, and vertical up/down control**:

- **Primary Grid Cell (`#cell-hand-gesture` in `cells/hand-gesture/ui.js:mountHandGestureCell`)**: Tactile Swiss/Linear `4:3` card with live 21-joint hand schematic, 4-row primitive status (`POS`, `PINCH`, `ROT`, `UP/DN`), quick **`Cam`** and **`Sim`** toggles (which activate the floating spatial hand cursor across the **entire main page** to click controls and V-scroll), and **`Studio ↗`** to open the full 9-cell workbench. Runs **zero** `requestAnimationFrame` loops while in `STANDBY`.
- **Secondary 9-Cell `.grid` Studio (`#hand-gesture-page`)**: Uses the exact `.grid` and `.cell` classes as `index.html` (`#hand-gesture` History hash, `← Grid`, `Escape`, and View Transition `hg-stage-portal`), housing 9 specialized gesture instruments:
  1. **`01` Optical Rig & 21-Joint**: Live mirrored webcam feed + 21-joint bone/knuckle overlay, interactive pointer-driven `SyntheticHandRig`, and 1-click `Auto Tour`.
  2. **`02` XY Locus & 1€ Scope**: 2D locus pad + live 60fps dual-trace raw-vs-`OneEuroFilter2D` oscilloscope reporting real-time RMS jitter attenuation (`dB`).
  3. **`03` Schmitt Pinch Matrix**: 3×3 zero-slip button matrix + analog Schmitt hysteresis bar (`engage < 0.28`, `release > 0.40`, `14 px` lock).
  4. **`04` Knuckle Rotary Dial**: Multi-turn (`±720°`) rotary encoder driven by unwrapped wrist twist (`Fused` 72% knuckle bar + 28% wrist-pinch lever, `±3.5°` deadzone, `2.0×` gain).
  5. **`05` Spatial Transform Stage**: 1-hand pinch-drag + twist artboard with automatic promotion to 2-hand pinch zoom + steering angle.
  6. **`06` Target-Latched Fader**: Off-axis vertical pinch-scrub fader (`-∞..+6 dB`) with peak-hold indicator.
  7. **`07` V-Scroll Momentum Tape**: 28-row specification tape driven by the Two-Finger Peace (`V-Scroll`) posture with `0.94` momentum decay and low-velocity (`< 18 px/s`) soft row detents.
  8. **`08` Magnetic Signal Pucks**: Tap (`< 14 px`) to bypass/unmute, or pinch-drag (`>= 14 px`) to swap slot order.
  9. **`09` Kinematic Tuner & Gates**: Live trimmers (`1€ MinCut`, `1€ Beta`, `Pinch Engage`, `Sim Tremor`), `Map: ROI / Clutch` switch, and `Chiral: Auto / Inv` toggle.

### Module Ownership

| File | Responsibility |
| :--- | :--- |
| `kinematics.js` (`HandGestureKinematics`) | Pure `MIT-0` zero-GC kinematics core (`OneEuroFilter2D`, `ScopeRingBuffer`, `KinematicEngine`, `SyntheticHandRig`) shared across UMD browser `<script defer>` and CommonJS `node --test`. |
| `hand-tracker.js` (`HandGestureTracker`) | Lazy dynamic `import()` of `@mediapipe/tasks-vision@1.2.3` (`GPU` with `CPU` fallback), `sessionEpoch` race guard, and `video.currentTime` frame gating. |
| `hand-gesture.css` | Strictly scoped styles (`.cell--hand-gesture`, `.hg-secondary-page`, `.hg-spatial-overlay`) with `container-type: size` breakpoints down to `220px` mobile tiles. |
| `ui.js` (`HandGestureUI`) | Main-grid portal tile, global spatial reticle dispatcher, 9-cell secondary workbench, `ResizeObserver` `Float32Array` hit-rect cache, and WCAG keyboard parity. |
| `kinematics.test.js` | Reproducible `node --test` verification of 1€ jitter attenuation, `NaN` quarantine, chiral 3D normals, engagement FSM, zero-slip pinch, unwrapped twist, V-scroll, and fist-clutch. |

---

## 2. Design & Technical Decisions (`Protocol B` Best-of-3 Synthesis)

Three parallel prototypes (*Prototype A: Swiss Instrument Grid*, *Prototype B: Spatial Indirect Fluid UI*, and *Prototype C: Kinetic Studio Workbench*) were evaluated by an independent Taste & Kinematics Critic (`44.0 / 50` winner: *Kinetic Studio Workbench*):

1. **Zero-GC `Float64Array(63)` Core + `ResizeObserver` Rect Caching (`kinematics.js:KinematicEngine`, `ui.js:refreshRectCache`)**:
   - *Won*: Pre-allocated `HandSlot` and `CandidateScratch` typed buffers plus cached `Float32Array` bounding boxes (`0` `getBoundingClientRect()` reads or SVG `innerHTML` reparses inside the 60fps `onFrame` loop).
   - *Rejected*: Per-frame object allocations, interleaved DOM rect reads/style writes, and placing a secondary spring in series after `OneEuroFilter2D` (which added sluggish cursor overshoot in *Prototype B*).
2. **Rigid Metacarpal Anchor + Pre-Pinch Brake + `14 px` Click-Lock (`kinematics.js:KinematicEngine._updateSlotFromSample`)**:
   - *Won*: Anchoring `(x, y)` at `0.50·L5 + 0.30·L9 + 0.20·L0` decouples the pointer from `INDEX_TIP (L8)`, which dips `25–45 mm` downward during natural thumb-index flexion (*Heisenberg Effect*). Combined with `0.08×` pre-pinch closing velocity damping and a `14 px` click-lock deadzone, taps fire with `0.0 px` slip.
   - *Rejected*: Raw `INDEX_TIP` tracking and `atan2(L8 - L4)` pinch-tip rotation (whose lever arm collapses to `0` at pinch contact, causing `±90°` angular noise).
3. **Fused Rigid Rotation + Switchable Absolute ROI / Relative Fist-Clutch (`kinematics.js:ROTATION_SOURCE`, `kinematics.js:MAPPING_MODE`)**:
   - *Won*: Blending `0.72·knuckleBar (L17-L5) + 0.28·wristLever (mid(L4,L8)-L0)` via branch-free `unwrapAngleDelta`, paired with both `[0.22, 0.78]` interior ROI mapping and closed-fist Relative Clutch trackpad ratcheting (grafted from *Prototype B*).

---

## 3. Hazards, Invariants & Edge Cases

- **Chiral 3D Normal Sign on Unmirrored Video (`kinematics.js:computePalmFacingCosFlat`)**: MediaPipe's handedness classifier assumes selfie-mirrored input, so on raw unmirrored `<video>` a physical Right palm facing the camera yields `(L5-L0)×(L17-L0)` `nz < 0` with label `'Left'` (`sign = -1 → +1`), and a physical Left palm yields `nz > 0` with label `'Right'` (`sign = +1 → +1`). Never invert `sign` without checking both chiralities (`kinematics.test.js` guards both).
- **Normalized-Unit `1€` `beta` Scaling (`kinematics.js:DEFAULT_CONFIG`)**: `OneEuroFilter2D` operates on `[0, 1]` ROI coordinates (`beta = 0.85`, `dCutoff = 1.8`), **not** pixel coordinates (`~0.0005`). Using pixel-scale `beta` constants on `[0, 1]` coordinates starves velocity adaptation and causes `~130 ms` sweep lag.
- **Non-Finite Landmark Quarantine (`kinematics.js:clamp`, `kinematics.js:copyLandmarksToFlat`)**: Any frame containing `NaN`/`±Infinity` coordinates is dropped before touching `OneEuroFilter2D` or `document.elementFromPoint(x, y)`, transitioning the slot smoothly into 4-frame `COASTING`.
- **Camera Teardown & Race Safety (`hand-tracker.js:HandTrackerController.enableWebcam`)**: `_sessionEpoch` increments on mode switches, `Escape` / `← Grid` navigation, and `pagehide` so a late `getUserMedia` resolution stops its tracks immediately rather than leaving the macOS camera LED active.
- **Dual `file://` and `http://localhost` Compatibility**: All local scripts load as classic UMD `<script defer>` files without ES-module `file://` CORS failures; if `getUserMedia` or CDN WASM is unavailable offline, `Synth Rig`, `Auto Tour`, and `Pointer` modes keep all 9 cells fully interactive.

---

## 4. How to Run & Verify

- **Automated kinematics & edge-case unit suite**:
  `timeout 60 node --test cells/hand-gesture/kinematics.test.js`
- **Syntax check across all cell scripts**:
  `node --check cells/hand-gesture/kinematics.js && node --check cells/hand-gesture/hand-tracker.js && node --check cells/hand-gesture/ui.js`
- **Live browser & webcam verification**:
  Serve repo root (`python3 -m http.server 8000`), open `http://localhost:8000`, click **`Cam`** on **Cell 08** (to drive the cursor across the main grid) or click **`Studio ↗`** (`http://localhost:8000/#hand-gesture`) to test all 9 gesture instruments.
