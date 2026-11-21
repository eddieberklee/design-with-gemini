# Secondary Grid Cell 07 — iPhone Spinning Dial Control (`cells/left-grille/iphone-dial.*`)

## 1. Intent & Architecture

Secondary Grid Cell 07 (`#lg-sec-cell-7`) turns an iPhone lying flat on the desk next to the MacBook into a precision **24-detent rotary encoder knob** (`0–360°`, `RPM`, unwrapped `turns`, and normalized `0–100` control value) with three real-time connectivity paths and an immediate desktop circular drag-to-spin platter:

- `cells/left-grille/iphone-dial.js`:
  - `RotaryDialTracker`: Pure gravity-projected 3D gyroscope + compass rotary physics engine exported via UMD (`module.exports` in Node, `window.LeftGrilleDial` and `window.LeftGrilleLab.RotaryDialTracker` in browser).
  - `parseBleRotaryPayload` & `resolveDialPhoneUrl`: Web Bluetooth Nordic UART / binary angle packet decoder and QR target URL resolver.
  - `mountIphoneDialCell`: Registers into `window.LeftGrilleLab` Slot `7` (`id: 'iphone-dial'`, `title: 'iPhone Spin Dial'`).
- `cells/left-grille/iphone-dial.css`: Strictly scoped styles for `.id-cell` (desktop Secondary Cell 07 with `@container` breakpoints at `310px` and `245px` down to `150px`) and `.dp-body` (standalone mobile controller in Dark OLED Studio & Braun Light Ceramic themes).
- `cells/left-grille/dial-phone.html` & `cells/left-grille/dial-phone.js`: Standalone mobile controller page that reuses `cells/motion/transport.js` (`window.MotionGrid.Transport`) and `RotaryDialTracker`, featuring a 1-tap iOS 13+ gyroscope permission gate, counter-rotated upright digital readout (`rotate(-angleDeg)`), 24-detent Web Audio micro-tick synthesis, and a circular touch-ring fallback.
- `cells/left-grille/iphone-dial.test.js`: Node test suite (`node --test`) verifying CW/CCW spin integration, face-up vs face-down vs tilted-desk gravity projection, `0.00°/min` stationary drift rejection, `360°` wrap/unwrap, 24-detent click hysteresis, BLE payload decoding, and `dial-phone.js` VM execution.

---

## 2. Physics & Multi-Transport Design Decisions

1. **Gimbal-Lock-Free Gravity-Projected Desk Spin (`projectDeskSpinRate` & `RotaryDialTracker.prototype.ingestMotion`)**:
   - Rather than relying on Euler orientation angles (`alpha`/`beta`/`gamma`) which suffer from gimbal lock or compass interference near laptop speakers/MagSafe magnets, `RotaryDialTracker` low-pass filters `accelerationIncludingGravity` (minus linear `acceleration`) into a unit surface-normal vector $\hat{g} = [g_x, g_y, g_z] / |\vec{g}|$ and projects the 3-axis gyroscope rate vector $\vec{\omega} = [\beta, \gamma, \alpha]$ directly onto $\hat{g}$:
     $$\omega_{\text{proj}} = \beta \hat{g}_x + \gamma \hat{g}_y + \alpha \hat{g}_z$$
   - Because flipping the iPhone face-down reverses both the device Z-axis gyroscope rate (`alpha`) and the Z-component of the gravity vector ($\hat{g}_z$), their dot product $\vec{\omega} \cdot \hat{g}$ preserves identical clockwise/counter-clockwise polarity whether the phone lies **face-up**, **face-down**, or on a **tilted laptop stand**.
2. **Stationary Zero-Velocity Bias Removal (`< 0.8 deg/s` Deadband)**:
   - When $|\omega_{\text{proj}}| < 1.16\text{ deg/s}$ and total 3-axis rotation magnitude is quiet for $\ge 80\text{ ms}$, an adaptive bias tracker estimates the MEMS gyro offset `gyroBias`. Any residual rate below `STATIONARY_DEADBAND_DEG_PER_SEC = 0.8 deg/s` is hard-clamped to `0`, guaranteeing **exact `0.00°/min` drift** while the phone sits untouched on the desk.
3. **Hysteresis-Protected 24-Detent Click Ladder (`DETENT_STEP_DEG = 15`)**:
   - Detent transitions occur when `cumulativeDeg` crosses `(detentIndex ± 1) * 15°`. Advancing `detentIndex` shifts the reference center by `15°`, creating an inherent `15°` reversal deadband right at each click threshold so boundary micro-tremors never double-trigger ticks while delivering exact `24` clicks per `360°` revolution in both CW and CCW directions.

---

## 3. Hazards, Invariants & Edge Cases

- **Strict `4:3` Grid Aspect-Ratio Lock**: `.id-stage` uses `position: absolute; inset: 0;` inside `.id-cell` (`position: relative; overflow: hidden; container-type: inline-size;`) so neither the rotary platter SVG nor the `[PAIR QR]` overlay ever inflates row height.
- **Session ID Namespace Isolation**: Desktop Cell 07 prefixes generated session IDs with `'DL'` (`8` uppercase alphanumeric characters matching `MotionGrid.Transport.SESSION_ID_RE`), preventing topic collisions with Main Grid Cell 03.
- **Lifecycle Cleanup**: `mountIphoneDialCell` listens for `window.addEventListener('lg-secondary-close', ...)` to cancel active inertial flywheel `requestAnimationFrame` loops, close the QR popover, and disconnect active Web Bluetooth GATT sessions when the user exits the secondary grid.

---

## 4. Verification

```bash
node --check cells/left-grille/iphone-dial.js && \
node --check cells/left-grille/dial-phone.js && \
timeout 60 node --test cells/left-grille/iphone-dial.test.js
```
