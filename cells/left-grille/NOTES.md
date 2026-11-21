# Cell 05 — Left Grille & Hardware Acoustic Secondary Grid Lab (`cells/left-grille/`)

## 1. Intent & Architecture

`cells/left-grille/` implements **Cell 05** on the primary grid (`#cell-left-grille`) and its seamless in-page **9-Cell Secondary Grid** (`#left-grille-secondary-grid`), preserving 100% `.grid` and `4:3` `.cell` sizing parity with the main grid while hosting **7 physical MacBook & iPhone hardware-sensing instruments** coordinated by a single `48 kHz` unprocessed Web Audio bus (`window.LeftGrilleLab.bus`):

| Secondary Slot | Instrument | Core Physics & Transport | Slice Notes & Tests |
| :--- | :--- | :--- | :--- |
| **Slot 01 (`#lg-sec-cell-1`)** | **Left Grille Swipe Sonar** | 4-carrier left-speaker ultrasonic comb (`18.375–21.375 kHz`), `2.93 Hz/bin` baseband Doppler, pinhole shadow, 5-zone non-monotonic RBF position estimator + shrinkage Fisher LDA direction classifier (`UP`/`DOWN`, `cm/s`, `% TOP`/`% BTM`) & 14-step empirical calibration suite (`cal-collector.mjs`) | `acoustic-engine.js` · `cal-collector.mjs` · `acoustic-engine.test.js` (`20` tests) |
| **Slot 02 (`#lg-sec-cell-2`)** | **Chassis Tap Zones** | `< 16 kHz` Lamb plate-wave dispersion, forward-scan `riseTimeMs`, cavity boom & HF air attenuation + 4-zone Mahalanobis learner (`top-left`, `left-palm`, `trackpad-rim`, `right-palm`) | [`tap-zones.NOTES.md`](tap-zones.NOTES.md) · `tap-zones.test.js` (`11` tests) |
| **Slot 03 (`#lg-sec-cell-3`)** | **Nail vs Soft Pad** | *TapSense* + *ScratchInput* `< 16 kHz` spectral centroid, `-18 dB` core duration, Wiener flatness, fan-step recovery & harmonic voice veto (`soft-pad`, `nail-tap`, `nail-scratch`) | [`nail-pad.NOTES.md`](nail-pad.NOTES.md) · `nail-pad.test.js` (`13` tests) |
| **Slot 04 (`#lg-sec-cell-4`)** | **18–20.5 kHz Chirp Sonar** | Stereo FDMA Hann-tapered FMCW chirps (`18.00–19.15 kHz` L, `19.35–20.50 kHz` R), analytic matched filter + motion-gated clutter subtraction (`push`, `pull`, `wave-left`, `wave-right`, `4–55 cm`) | [`chirp-sonar.NOTES.md`](chirp-sonar.NOTES.md) · `chirp-sonar.test.js` (`14` tests) |
| **Slot 05 (`#lg-sec-cell-5`)** | **Grille Breath Puff** | Dual-rate `20–200 Hz` Karman vortex stagnation-pressure roar + `-12 dB/oct` roll-off + NACF harmonic voice/hum veto driving an inertial anemometer pinwheel (`breeze`, `puff`, `blow`) | [`breath-puff.NOTES.md`](breath-puff.NOTES.md) · `breath-puff.test.js` (`11` tests) |
| **Slot 06 (`#lg-sec-cell-6`)** | **Lid Angle (`0°–135°`)** | Dual-mode: (A) `18.2–20.4 kHz` + bit-exact `'chirp'`-piggyback Wiener-deconvolved display reflection sonar + (B) `lid-bridge.mjs` (`127.0.0.1:8793`) local SSE helper reading Apple `IOHIDManager` `LidAngleSensor` (`0x05AC:0x8104`) | [`lid-angle.NOTES.md`](lid-angle.NOTES.md) · `lid-angle.test.js` (`17` tests) |
| **Slot 07 (`#lg-sec-cell-7`)** | **iPhone Spin Dial** | 3D gravity-projected `DeviceMotionEvent.rotationRate` (`dot(ω, g_hat)`, face-up/down gimbal-free, `0°/min` rest drift, 24 detents) via scannable QR (`dial-phone.html`) over WSS MQTT / Wi-Fi WS / Web Bluetooth (`navigator.bluetooth`) | [`iphone-dial.NOTES.md`](iphone-dial.NOTES.md) · `iphone-dial.test.js` (`13` tests) |
| **Shared Bus & Portal** | **`LeftGrilleLab.bus` & `ui.js`** | Single-prompt raw `48 kHz` mic capture, stereo `15 ms` raised-cosine TX multiplexer, `[● ARM ARRAY]` 1-click header arming, bidirectional Cell 01 handoff, and `lg-secondary-open` / `lg-secondary-close` lifecycle | [`hub-bus.NOTES.md`](hub-bus.NOTES.md) · `shared-bus.test.js` (`20` tests) |

---

## Sensor cell frame (binding for every secondary slot; owner: `ui.js` + `left-grille.css`)

The secondary page is one studio of seven instruments on paper. Each instrument is a tile in the
shared anatomy (`ui/NOTES.md` section 2), so the page reads like the main grid.

**Grid** (`#left-grille-secondary-grid.grid`, rules in `left-grille.css` section 3). Tiles keep
`.cell` 4:3. Gap `var(--ui-2)` (8 px) at every width. Columns by viewport, so no tile drops under
320 px (no compact step on this page):

| Page width | Columns | Tile width (approx.) |
| :--- | :--- | :--- |
| 1600 px | 3 (from 1200 px) | 485 px |
| 900 px | 2 (720–1199 px) | 410 px |
| 390 px | 1 (below 720 px) | 358 px |

**Slots.** `ui.js` creates `section#lg-sec-cell-N` for N = 1..9, in order, with classes
`cell ui-tile` (+ `lg-sec-slot` and `data-slot="N"` for 2..9). Siblings may assume:

- The slot is the tile: border, radius, white surface, `overflow: hidden`, `position: relative`,
  and the `ui-tile` size container. Do not set `container` / `container-name` on it (that would
  drop the `ui-tile` name the base size steps use). `container-type: inline-size` is harmless.
- `shared-bus.js` mounts by `spec.mount(slotEl, bus)` once the slot exists; the sensor clears the
  slot, adds its `xx-cell` class and appends one stage. Keep doing exactly that.
- A slot with no children is `display: none`: slots 8 and 9 are removed from the layout, not shown
  as empty tiles. Mounting into one later makes it appear.
- Numbering is the slot: `01` Swipe sonar, `02` Tap zones, `03` Nail pad, `04` Chirp sonar,
  `05` Breath puff, `06` Lid angle, `07` iPhone dial.

**Inside the tile** (adoptable by adding classes in the existing `h(...)` calls, no restructuring):

```html
<section id="lg-sec-cell-2" class="cell lg-sec-slot ui-tile tz-cell">
  <div class="tz-stage lg-cell-stage">              <!-- absolute inset 0, flex column, no padding -->
    <header class="tz-bezel ui-tile-head">          <!-- 36 px, hairline under -->
      <span class="ui-tile-index">02</span>
      <span class="ui-tile-title">Tap zones</span>
      <div class="ui-tile-actions">                 <!-- pill first, then at most 2 small buttons -->
        <span class="ui-pill" data-tip="…"><span class="ui-pill-label">Ready</span></span>
        <button class="ui-btn ui-btn--sm" aria-pressed="false" data-tip="…">Arm</button>
      </div>
    </header>
    <div class="ui-tile-body">…one hero…</div>     <!-- relative; overlays go inside it -->
    <footer class="ui-tile-foot">…quiet readouts, Sim buttons…</footer>  <!-- optional -->
  </div>
</section>
```

- `.lg-cell-stage` (defined here, id-specific so it beats a sensor's own `.xx-stage` padding/grid)
  makes the stage the tile column. A sensor may instead write the same in its own CSS.
- Header: two-digit `ui-tile-index`, sans `ui-tile-title` (not mono caps), `ui-tile-actions` with
  the status `ui-pill` first. ARM / SONAR are `ui-btn ui-btn--sm`; while running they carry
  `aria-pressed="true"` and `data-tone="attention"` (rust). Extra controls (CAL, Sim, Trim, Zero)
  go in the foot or the body, not a second header row.
- Pills (green rule): idle grey for ready / demo / passive; `attention` for armed, tracking,
  calibrating, error; `ok` only for a real link (lid HID bridge, phone or BLE dial connected).
  A simulated reading says "Sim" in its pill. Every pill has a `data-tip`.
- No black `ui-btn--primary` in a sensor tile: the page's one primary is ARM ARRAY in the studio
  bar. A calibration overlay may use one primary for its step action.
- One hero per tile in `ui-tile-body` (`--flush` for a full-bleed canvas). Secondary readouts are
  `ui-readout` / `ui-label` with spacing or `ui-well`, not boxed cards.
- Colours: `--ui-*` tokens. For a two-polarity signal (up/down, approach/recede, push/pull) use
  `--lg-sig-up` (`#0052cc`), `--lg-sig-down` (`--ui-accent`) and their `-tint`s, set on the grid.
- Tiles never shrink below 320 px here, but sensors also mount at narrow widths in tests: keep
  `.ui-hide-compact` / `.ui-hide-tiny` on secondary controls so the base size steps still work.

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
   - At `<= 245px` container width (2-column grid at a 390 px viewport) `.lg-tier-dist` wraps so `Sim ↑/↓` sit under the `TOP/BTM` pair instead of overlapping it.
5. **Secondary Page Navigation (`ui.js:runPortalTransition`, `requestCloseSecondaryView`, `syncLocationHash`)**:
   - Opens from the tile (pushes `#left-grille` with `history.state.lgSecondary`), from `#left-grille` on load, and by Back/Forward; closes by `← Grid`, `Escape`, Back, or another cell's hash. Every `ViewTransition` promise is handled, and a hidden tab swaps the DOM without a transition.
   - Open saves the main-grid `scrollY` (only while the grid is the visible page) and scrolls to top; close restores it and focuses the tile. Close never unhides `main.grid` while another `*-secondary-page` is visible, and a pending `history.back()` blocks a second close for up to `1 s`.
6. **CSS Reach Outside the Cell (`left-grille.css`)**:
   - `main.grid[hidden]` is hidden only while `.lg-secondary-page` is shown; `body:has(main.grid[hidden]) .mg-hud` hides Cell 03's fixed scale HUD whenever the main grid is hidden; `::view-transition-*(lg-stage-portal)` match only this cell's transition name.
7. **14-Step Empirical Calibration Suite & Local Disk Telemetry Collector (`ui.js:openCalibrationWizard`, `acoustic-engine.js:fitEmpiricalCalibration`, `cal-collector.mjs`)**:
   - Excludes `< 1.1 kHz` finger-pad pneumatic thud from `spectralFlatness`/`tonalCrest` so near-port rubs never self-veto as speech.
   - Clicking `CAL` in Slot `01` opens an in-cell guided 14-step calibration suite inside `.lg-inline-overlay` (5 spatial zone rubs at `0%, 18%, 50%, 75%, 100%`, 8 slow/fast/half `UP` & `DOWN` swipes, and 1 negative key-click baseline) fitting a 5-zone non-monotonic Gaussian RBF position curve + shrinkage Fisher LDA (`LOO %` & `d'`) + speed scale, releasing any auto-armed mic on `Cancel`/`Escape`/`Reset` while keeping the mic live after a successful fit.
   - When `cal-collector.mjs` is running on `127.0.0.1:8792`, it enforces loopback `Host` (`127.0.0.1`, `localhost`, `[::1]`) and loopback `Origin` (`http(s)://localhost|127.0.0.1|[::1]`, rejecting `Origin: null` and non-loopback origins with `403`, and echoing `Access-Control-Allow-Origin` + `Vary: Origin`), requires `Content-Type: application/json` (`415`) and strict `event`/`fit` schemas (`400`) on `POST /record`, displays `● DISK REC` in the UI, and atomically persists every recorded step (`POST /record` `{ type: 'event' }`) plus the fitted model bundle (`POST /record` `{ type: 'fit' }`) into gitignored `.worktrees/cal-data/events.jsonl` (bounded to `25 MB`), `.worktrees/cal-data/session-<sid>.json` (pruned to `MAX_SAVED_SESSIONS = 32`), and `.worktrees/cal-data/latest-session.json` (in addition to `localStorage` `dwg.leftGrilleCalibration.v2` persistence and 1-click `left-grille-calibration.json` download).

---

## 3. How to Run & Verify

- **All unit, physics & lifecycle tests across all 8 suites**:
  `timeout 60 node --test cells/left-grille/*.test.js`
- **JavaScript syntax gate**:
  `for f in cells/left-grille/*.js cells/left-grille/*.mjs; do node --check "$f"; done`
- **Local Disk Calibration Telemetry Collector (`127.0.0.1:8792` → `.worktrees/cal-data/latest-session.json`)**:
  `node cells/left-grille/cal-collector.mjs`
- **Optional native MacBook Lid Angle HID bridge (`127.0.0.1:8793`)**:
  `node cells/left-grille/lid-bridge.mjs`
- **Live browser server**:
  `python3 -m http.server 8000` → open `http://localhost:8000/#left-grille`
