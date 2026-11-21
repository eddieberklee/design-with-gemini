/**
 * Secondary Grid Cell 07 — iPhone Spinning Dial Control (`cells/left-grille/iphone-dial.js`)
 *
 * Implements:
 * 1. `RotaryDialTracker`: Pure gravity-projected 3D gyroscope + compass rotary encoder physics.
 *    Projects `DeviceMotionEvent.rotationRate` (`[beta, gamma, alpha]` in deg/s) onto the
 *    normalized 3D gravity unit vector `g_hat = [gx, gy, gz] / |g|` so spinning an iPhone
 *    flat on a desk (face-up, face-down, or on a tilted surface) integrates yaw cleanly with
 *    zero gimbal lock and 0.00 deg/min stationary drift (`< 0.8 deg/s` deadband + adaptive
 *    stationary bias cancellation). Computes `angleDeg` (`0..360°`), `cumulativeDeg`, `turns`,
 *    `degPerSec`, `rpm`, 24-detent virtual click ticks (`every 15°`), and normalized
 *    `dialValue` (`0..100`, `1x` coarse / `0.25x` fine sensitivity).
 * 2. `parseBleRotaryPayload`: Decodes Web Bluetooth BLE notifications from Nordic UART
 *    (`6e400003-b5a3-f393-e0a9-e50e24dcca9e` JSON/ASCII angle or delta strings) and binary
 *    16-bit angle/CSC frames.
 * 3. Secondary Slot 07 UI (`mount(cellEl, bus)`): Swiss/Braun & Teenage Engineering TP-7
 *    machined aluminum rotary platter SVG with 24 detent ticks, circular pointer drag with
 *    inertial flywheel momentum, scannable QR pairing popover (`dial-phone.html?s=<SID>`),
 *    editable LAN/HTTPS host override, and Web Bluetooth (`navigator.bluetooth`) pairing.
 */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.LeftGrilleDial = api;

  const Lab = (root.LeftGrilleLab = root.LeftGrilleLab || { _pending: [] });
  Lab.RotaryDialTracker = api.RotaryDialTracker;
  const spec = {
    id: 'iphone-dial',
    title: 'iPhone Spin Dial',
    mount: api.mountIphoneDialCell
  };
  if (typeof Lab.registerCell === 'function') {
    Lab.registerCell(7, spec);
  } else {
    (Lab._pending = Lab._pending || []).push([7, spec]);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DETENT_COUNT = 24;
  const DETENT_STEP_DEG = 360 / DETENT_COUNT; // 15 deg per click detent
  const STATIONARY_DEADBAND_DEG_PER_SEC = 0.8;
  const DEFAULT_COARSE_SENSITIVITY = 1.0;
  const DEFAULT_FINE_SENSITIVITY = 0.25;
  const STORAGE_HOST_KEY = 'dwg.iphoneDialHost.v1';
  const STORAGE_SID_KEY = 'dwg.iphoneDialSid.v1';
  const BLE_UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const BLE_UART_TX_CHAR = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
  const MAX_QR_URL_BYTES = 213;

  function clamp(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  /**
   * Wraps any angle in degrees into [0, 360).
   */
  function wrapAngle360(deg) {
    if (!Number.isFinite(deg)) return 0;
    const mod = ((deg % 360) + 360) % 360;
    return mod === 360 || Object.is(mod, -0) ? 0 : mod;
  }

  /**
   * Shortest signed angular difference (a - b) wrapped into [-180, +180] degrees.
   */
  function wrapAngleDiffDeg(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    let d = (a - b) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d === 0 ? 0 : d;
  }

  /**
   * Normalizes a 3D gravity vector [gx, gy, gz] and returns unit components + magnitude.
   */
  function normalizeGravityVector(gx, gy, gz, fallbackZ) {
    const x = Number.isFinite(gx) ? gx : 0;
    const y = Number.isFinite(gy) ? gy : 0;
    const z = Number.isFinite(gz) ? gz : (Number.isFinite(fallbackZ) ? fallbackZ : 9.81);
    const mag = Math.hypot(x, y, z);
    if (mag < 1e-4) {
      return { x: 0, y: 0, z: 1, mag: 9.81 };
    }
    return {
      x: x / mag,
      y: y / mag,
      z: z / mag,
      mag: mag
    };
  }

  /**
   * Projects 3-axis device angular velocity `rotationRate` onto the unit gravity vector `gUnit`.
   *
   * Axis mapping (W3C DeviceMotion & iOS Safari):
   * - `beta`  = rotation rate around device X axis (deg/s)
   * - `gamma` = rotation rate around device Y axis (deg/s)
   * - `alpha` = rotation rate around device Z axis (screen normal, deg/s)
   *
   * Dot product `omega_proj = beta * gUnit.x + gamma * gUnit.y + alpha * gUnit.z`:
   * - Projects pure rotation around the desk's vertical normal regardless of whether the
   *   phone lies flat face-up (`gUnit.z = +1`), flat face-down (`gUnit.z = -1`), or on a
   *   tilted desk (`gUnit = [gx, gy, gz] / |g|`), eliminating Euler-angle gimbal lock.
   * - On iOS Safari, `accelerationIncludingGravity` negates `[gx, gy, gz]` (`gz = -9.81`
   *   when face-up) while clockwise spin viewed from above yields `alpha < 0`, so their
   *   product `alpha * gUnit.z` is positive (`+`) for clockwise rotation on both iOS hardware
   *   and W3C positive-Z test vectors.
   */
  function projectDeskSpinRate(rotationRate, gUnit) {
    const r = rotationRate || {};
    const g = gUnit || { x: 0, y: 0, z: 1 };
    const wx = Number.isFinite(r.beta) ? r.beta : 0;
    const wy = Number.isFinite(r.gamma) ? r.gamma : 0;
    const wz = Number.isFinite(r.alpha) ? r.alpha : 0;
    return wx * g.x + wy * g.y + wz * g.z;
  }

  /**
   * Precision Gravity-Projected Rotary Dial Tracker.
   */
  function RotaryDialTracker(opts) {
    const cfg = opts || {};
    this.deadbandDegPerSec = Number.isFinite(cfg.deadbandDegPerSec) && cfg.deadbandDegPerSec >= 0
      ? cfg.deadbandDegPerSec
      : STATIONARY_DEADBAND_DEG_PER_SEC;
    this.coarseSensitivity = Number.isFinite(cfg.coarseSensitivity) && cfg.coarseSensitivity > 0
      ? cfg.coarseSensitivity
      : DEFAULT_COARSE_SENSITIVITY;
    this.fineSensitivity = Number.isFinite(cfg.fineSensitivity) && cfg.fineSensitivity > 0
      ? cfg.fineSensitivity
      : DEFAULT_FINE_SENSITIVITY;
    this.fineMode = Boolean(cfg.fineMode);
    this.compassBlend = Number.isFinite(cfg.compassBlend)
      ? clamp(cfg.compassBlend, 0, 0.25)
      : 0.025;
    this.enableBiasEstimation = cfg.enableBiasEstimation !== false;

    this.initialValue = Number.isFinite(cfg.initialValue)
      ? clamp(cfg.initialValue, 0, 100)
      : 50;

    // Gravity low-pass filter state
    this.gInitialized = false;
    this.gx = 0;
    this.gy = 0;
    this.gz = 9.81;
    this.gravityAlpha = Number.isFinite(cfg.gravityAlpha) ? clamp(cfg.gravityAlpha, 0, 0.98) : 0.82;

    // Stationary gyro bias estimator
    this.gyroBias = 0;
    this.stationaryTimeSec = 0;

    // Compass / DeviceOrientation unwrap state
    this.lastCompassCwDeg = null;

    // Rotary encoder state
    this.angleDeg = 0;
    this.cumulativeDeg = 0;
    this.turns = 0;
    this.degPerSec = 0;
    this.rawDegPerSec = 0;
    this.rpm = 0;
    this.detentIndex = 0;
    this.detentSlot = 0;
    this.detentDelta = 0;
    this.totalDetentTicks = 0;
    this.dialValue = this.initialValue;
    this.faceUp = true;
    this.flatness = 1;
    this.tiltDeg = 0;
    this.stationary = true;
    this.lastTs = null;
  }

  RotaryDialTracker.prototype.getEffectiveSensitivity = function () {
    return this.fineMode ? this.fineSensitivity : this.coarseSensitivity;
  };

  RotaryDialTracker.prototype.setFineMode = function (enabled) {
    this.fineMode = Boolean(enabled);
    return this.getState();
  };

  RotaryDialTracker.prototype.setSensitivity = function (sens) {
    if (Number.isFinite(sens) && sens > 0) {
      this.coarseSensitivity = clamp(sens, 0.05, 10);
    }
    return this.getState();
  };

  RotaryDialTracker.prototype.setValue = function (val) {
    if (Number.isFinite(val)) {
      this.dialValue = clamp(val, 0, 100);
    }
    return this.getState();
  };

  RotaryDialTracker.prototype.zero = function (resetValue) {
    this.angleDeg = 0;
    this.cumulativeDeg = 0;
    this.turns = 0;
    this.degPerSec = 0;
    this.rawDegPerSec = 0;
    this.rpm = 0;
    this.detentIndex = 0;
    this.detentSlot = 0;
    this.detentDelta = 0;
    this.totalDetentTicks = 0;
    this.stationary = true;
    this.lastCompassCwDeg = null;
    if (Number.isFinite(resetValue)) {
      this.dialValue = clamp(resetValue, 0, 100);
    }
    return this.getState();
  };

  RotaryDialTracker.prototype._updateGravity = function (sample) {
    const s = sample || {};
    const accG = s.accelerationIncludingGravity || s;
    const accLin = s.acceleration || s;

    const hasG = Number.isFinite(accG.gx) || Number.isFinite(accG.gy) || Number.isFinite(accG.gz) ||
      Number.isFinite(accG.x) || Number.isFinite(accG.y) || Number.isFinite(accG.z);

    if (!hasG) {
      return normalizeGravityVector(this.gx, this.gy, this.gz, 9.81);
    }

    const rawGx = Number.isFinite(accG.gx) ? accG.gx : (Number.isFinite(accG.x) ? accG.x : 0);
    const rawGy = Number.isFinite(accG.gy) ? accG.gy : (Number.isFinite(accG.y) ? accG.y : 0);
    const rawGz = Number.isFinite(accG.gz) ? accG.gz : (Number.isFinite(accG.z) ? accG.z : 0);

    const ax = Number.isFinite(accLin.ax) ? accLin.ax : 0;
    const ay = Number.isFinite(accLin.ay) ? accLin.ay : 0;
    const az = Number.isFinite(accLin.az) ? accLin.az : 0;

    const gx = rawGx - ax;
    const gy = rawGy - ay;
    const gz = rawGz - az;
    const mag = Math.hypot(gx, gy, gz);

    if (mag > 0.5) {
      if (!this.gInitialized) {
        this.gx = gx;
        this.gy = gy;
        this.gz = gz;
        this.gInitialized = true;
      } else {
        // If polarity flipped abruptly (e.g. phone flipped face-up <-> face-down in tests), snap immediately
        const dotPrev = gx * this.gx + gy * this.gy + gz * this.gz;
        if (dotPrev < 0) {
          this.gx = gx;
          this.gy = gy;
          this.gz = gz;
        } else {
          const a = this.gravityAlpha;
          this.gx = a * this.gx + (1 - a) * gx;
          this.gy = a * this.gy + (1 - a) * gy;
          this.gz = a * this.gz + (1 - a) * gz;
        }
      }
    }

    const unit = normalizeGravityVector(this.gx, this.gy, this.gz, 9.81);
    this.faceUp = unit.z >= 0;
    this.flatness = Math.abs(unit.z);
    this.tiltDeg = Math.acos(clamp(this.flatness, 0, 1)) * (180 / Math.PI);
    return unit;
  };

  /**
   * Advances the rotary encoder by an incremental angle `deltaDeg` over `dtSec`.
   */
  RotaryDialTracker.prototype._advanceAngle = function (deltaDeg, instDegPerSec, dtSec) {
    const dt = clamp(Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0.016, 0.001, 0.25);
    const dDeg = Number.isFinite(deltaDeg) ? deltaDeg : 0;

    if (Math.abs(dDeg) === 0) {
      this.stationary = true;
      this.rawDegPerSec = 0;
      // Exponentially damp display velocity to 0 when stationary
      this.degPerSec *= Math.exp(-dt / 0.045);
      if (Math.abs(this.degPerSec) < 0.05) this.degPerSec = 0;
      this.rpm = this.degPerSec / 6;
      this.detentDelta = 0;
      return this.getState();
    }

    this.stationary = false;
    this.rawDegPerSec = Number.isFinite(instDegPerSec) ? instDegPerSec : dDeg / dt;
    const velAlpha = clamp(dt / (0.028 + dt), 0.15, 1);
    this.degPerSec = this.degPerSec + velAlpha * (this.rawDegPerSec - this.degPerSec);
    this.rpm = this.degPerSec / 6;

    this.cumulativeDeg += dDeg;
    this.turns = this.cumulativeDeg / 360;
    this.angleDeg = wrapAngle360(this.cumulativeDeg);

    // 24-detent (15 deg) hysteresis-protected click detector:
    // Current detent center is `this.detentIndex * 15`. Crossing `center ± 15` advances
    // the detent index, naturally providing a full 15-degree reversal deadband right at
    // the click boundary while yielding exact 24 ticks per 360-degree revolution in both
    // CW (+360 -> +24) and CCW (-360 -> -24) directions.
    let stepClicks = 0;
    const eps = 1e-7;
    while (this.cumulativeDeg >= (this.detentIndex + 1) * DETENT_STEP_DEG - eps) {
      this.detentIndex += 1;
      stepClicks += 1;
    }
    while (this.cumulativeDeg <= (this.detentIndex - 1) * DETENT_STEP_DEG + eps) {
      this.detentIndex -= 1;
      stepClicks -= 1;
    }

    this.detentDelta = stepClicks;
    if (stepClicks !== 0) {
      this.totalDetentTicks += Math.abs(stepClicks);
    }
    this.detentSlot = ((this.detentIndex % DETENT_COUNT) + DETENT_COUNT) % DETENT_COUNT;

    const sens = this.getEffectiveSensitivity();
    const valueDelta = (dDeg / 360) * 100 * sens;
    this.dialValue = clamp(this.dialValue + valueDelta, 0, 100);

    return this.getState();
  };

  /**
   * Ingests a `DeviceMotionEvent`-style sample (`{ alpha, beta, gamma, gx, gy, gz, dt, ts }`).
   */
  RotaryDialTracker.prototype.ingestMotion = function (sample) {
    const s = sample || {};
    let dt = Number.isFinite(s.dt) && s.dt > 0 ? s.dt : null;
    if (dt === null) {
      if (Number.isFinite(s.ts)) {
        dt = this.lastTs === null ? 0.016 : (s.ts - this.lastTs) / 1000;
        this.lastTs = s.ts;
      } else {
        dt = 0.016;
      }
    }
    if (!Number.isFinite(dt) || dt <= 0 || dt > 0.25) dt = 0.016;

    const gUnit = this._updateGravity(s);
    const rot = s.rotationRate || s;
    const wx = Number.isFinite(rot.beta) ? rot.beta : 0;
    const wy = Number.isFinite(rot.gamma) ? rot.gamma : 0;
    const wz = Number.isFinite(rot.alpha) ? rot.alpha : 0;
    const totalRotMag = Math.hypot(wx, wy, wz);

    const omegaProj = projectDeskSpinRate({ alpha: wz, beta: wx, gamma: wz === rot.alpha ? wy : 0 }, gUnit);

    // Stationary zero-velocity bias tracker & hard < 0.8 deg/s deadband
    const residualFromBias = omegaProj - this.gyroBias;
    if (
      this.enableBiasEstimation &&
      Math.abs(omegaProj) < this.deadbandDegPerSec * 1.45 &&
      totalRotMag < this.deadbandDegPerSec * 2.2
    ) {
      this.stationaryTimeSec += dt;
      if (this.stationaryTimeSec >= 0.08) {
        const biasRate = clamp(dt * 1.8, 0.01, 0.2);
        this.gyroBias += residualFromBias * biasRate;
        this.gyroBias = clamp(this.gyroBias, -this.deadbandDegPerSec * 0.95, this.deadbandDegPerSec * 0.95);
      }
    } else {
      this.stationaryTimeSec = 0;
    }

    const omegaCorr = omegaProj - this.gyroBias;
    if (Math.abs(omegaProj) < this.deadbandDegPerSec || Math.abs(omegaCorr) < this.deadbandDegPerSec) {
      // Strictly zero velocity at rest -> 0.00 deg/min drift
      return this._advanceAngle(0, 0, dt);
    }

    let deltaDeg = omegaCorr * dt;

    // Optional complementary fusion with unwrapped compass / DeviceOrientation.alpha when flat
    const hasCompass = Number.isFinite(s.webkitCompassHeading) || Number.isFinite(s.orientationAlpha);
    if (hasCompass && this.flatness > 0.7) {
      const compassCw = Number.isFinite(s.webkitCompassHeading)
        ? wrapAngle360(s.webkitCompassHeading)
        : wrapAngle360(this.faceUp ? -s.orientationAlpha : s.orientationAlpha);
      if (this.lastCompassCwDeg !== null) {
        const compassDelta = wrapAngleDiffDeg(compassCw, this.lastCompassCwDeg);
        // Guard against magnetic interference spikes (> 18 deg mismatch from gyro step)
        if (Math.abs(compassDelta - deltaDeg) < 18) {
          deltaDeg = (1 - this.compassBlend) * deltaDeg + this.compassBlend * compassDelta;
        }
      }
      this.lastCompassCwDeg = compassCw;
    }

    return this._advanceAngle(deltaDeg, deltaDeg / dt, dt);
  };

  /**
   * Ingests a direct angular increment `deltaDeg` (e.g. desktop pointer drag, touch ring, or BLE delta).
   */
  RotaryDialTracker.prototype.ingestDeltaAngle = function (deltaDeg, dtSec) {
    const dt = clamp(Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0.016, 0.001, 0.25);
    const d = Number.isFinite(deltaDeg) ? deltaDeg : 0;
    return this._advanceAngle(d, d / dt, dt);
  };

  /**
   * Ingests an absolute dial angle `absAngleDeg` (`0..360°`), unwrapping shortest-path delta.
   */
  RotaryDialTracker.prototype.ingestAbsoluteAngle = function (absAngleDeg, dtSec) {
    if (!Number.isFinite(absAngleDeg)) return this.getState();
    const targetWrapped = wrapAngle360(absAngleDeg);
    const delta = wrapAngleDiffDeg(targetWrapped, this.angleDeg);
    return this.ingestDeltaAngle(delta, dtSec);
  };

  /**
   * Ingests a standalone `DeviceOrientationEvent` (`{ alpha, webkitCompassHeading, beta, gamma, ts }`).
   */
  RotaryDialTracker.prototype.ingestOrientation = function (ev, dtSec) {
    if (!ev || typeof ev !== 'object') return this.getState();
    const hasHeading = Number.isFinite(ev.webkitCompassHeading) || Number.isFinite(ev.alpha);
    if (!hasHeading) return this.getState();
    const headingCw = Number.isFinite(ev.webkitCompassHeading)
      ? wrapAngle360(ev.webkitCompassHeading)
      : wrapAngle360(this.faceUp ? -ev.alpha : ev.alpha);
    if (this.lastCompassCwDeg === null) {
      this.lastCompassCwDeg = headingCw;
      return this.getState();
    }
    const delta = wrapAngleDiffDeg(headingCw, this.lastCompassCwDeg);
    this.lastCompassCwDeg = headingCw;
    if (Math.abs(delta) < 0.15) {
      return this._advanceAngle(0, 0, dtSec || 0.016);
    }
    return this.ingestDeltaAngle(delta, dtSec || 0.016);
  };

  RotaryDialTracker.prototype.getState = function () {
    return {
      angleDeg: this.angleDeg,
      cumulativeDeg: this.cumulativeDeg,
      turns: this.turns,
      degPerSec: this.degPerSec,
      rawDegPerSec: this.rawDegPerSec,
      rpm: this.rpm,
      detentIndex: this.detentIndex,
      detentSlot: this.detentSlot,
      detentDelta: this.detentDelta,
      totalDetentTicks: this.totalDetentTicks,
      dialValue: this.dialValue,
      sensitivity: this.getEffectiveSensitivity(),
      fineMode: this.fineMode,
      faceUp: this.faceUp,
      flatness: this.flatness,
      tiltDeg: this.tiltDeg,
      stationary: this.stationary,
      gyroBias: this.gyroBias
    };
  };

  // =========================================================================
  // Web Bluetooth BLE Payload Decoder (Nordic UART JSON/ASCII + Binary Angle)
  // =========================================================================

  function parseBleRotaryPayload(raw) {
    if (!raw) return null;
    let bytes = null;
    if (typeof raw === 'string') {
      return parseBleTextPayload(raw);
    }
    if (raw instanceof DataView) {
      bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    } else if (raw instanceof ArrayBuffer) {
      bytes = new Uint8Array(raw);
    } else if (ArrayBuffer.isView(raw)) {
      bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    }
    if (!bytes || bytes.length === 0) return null;

    // Check if printable ASCII / UTF-8 JSON or number string
    let isPrintable = true;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b !== 9 && b !== 10 && b !== 13 && (b < 32 || b > 126)) {
        isPrintable = false;
        break;
      }
    }
    if (isPrintable) {
      let text = '';
      if (typeof TextDecoder !== 'undefined') {
        text = new TextDecoder().decode(bytes);
      } else {
        for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
      }
      const parsedText = parseBleTextPayload(text);
      if (parsedText) return parsedText;
    }

    // Binary fallback: 2-byte little-endian Uint16 angle (0..36000 => 0.00..360.00 deg, or 0..360)
    if (bytes.length === 2) {
      const u16 = bytes[0] | (bytes[1] << 8);
      const deg = u16 > 360 ? (u16 / 100) % 360 : u16;
      return { kind: 'absolute', angleDeg: wrapAngle360(deg) };
    }

    return null;
  }

  function parseBleTextPayload(str) {
    const trimmed = String(str || '').trim();
    if (!trimmed) return null;
    if (trimmed[0] === '{') {
      try {
        const obj = JSON.parse(trimmed);
        if (Number.isFinite(obj.delta) || Number.isFinite(obj.d)) {
          return {
            kind: 'delta',
            deltaDeg: Number.isFinite(obj.delta) ? obj.delta : obj.d,
            dialValue: Number.isFinite(obj.val) ? obj.val : undefined
          };
        }
        if (Number.isFinite(obj.angle) || Number.isFinite(obj.angleDeg) || Number.isFinite(obj.a)) {
          const a = Number.isFinite(obj.angle)
            ? obj.angle
            : Number.isFinite(obj.angleDeg)
              ? obj.angleDeg
              : obj.a;
          return {
            kind: 'absolute',
            angleDeg: wrapAngle360(a),
            dialValue: Number.isFinite(obj.val) ? obj.val : undefined
          };
        }
      } catch (_e) {
        return null;
      }
    }
    // Check explicit delta prefix ("d:1.5" or "delta:-2.0")
    const deltaMatch = /^d(?:elta)?\s*[:=]\s*([+-]?\d+(?:\.\d+)?)$/i.exec(trimmed);
    if (deltaMatch) {
      return { kind: 'delta', deltaDeg: parseFloat(deltaMatch[1]) };
    }
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      return { kind: 'absolute', angleDeg: wrapAngle360(num) };
    }
    return null;
  }

  // =========================================================================
  // URL Resolution Helpers for Mobile `dial-phone.html` QR Pairing
  // =========================================================================

  function utf8ByteLength(str) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(String(str)).length;
    }
    return String(str).length;
  }

  function resolveDialPhoneUrl(customHostInput, bridgeConfig, locationObj, sessionId) {
    const loc = locationObj || (root && root.location) || {};
    const sid = sessionId || 'DL000000';
    let base = '';
    let transportMode = 'mqtt';
    let source = 'origin';

    const rawCustom = String(customHostInput || '').trim();
    if (rawCustom) {
      try {
        const withProto = /^https?:\/\//i.test(rawCustom) ? rawCustom : 'http://' + rawCustom;
        const u = new URL(withProto);
        let p = u.pathname || '/';
        if (/\/index\.html?$/i.test(p)) {
          p = p.replace(/\/index\.html?$/i, '/cells/left-grille/dial-phone.html');
        } else if (/\/phone\.html?$/i.test(p)) {
          p = p.replace(/\/cells\/motion\/phone\.html?$/i, '/cells/left-grille/dial-phone.html');
          p = p.replace(/\/phone\.html?$/i, '/cells/left-grille/dial-phone.html');
        } else if (!/\/dial-phone\.html?$/i.test(p)) {
          if (!p.endsWith('/')) p += '/';
          p += 'cells/left-grille/dial-phone.html';
        }
        u.pathname = p;
        u.search = '';
        u.hash = '';
        base = u.toString();
        source = 'custom';
      } catch (_e) {
        base = '';
      }
    }

    if (!base && bridgeConfig && bridgeConfig.phoneBaseUrl) {
      base = String(bridgeConfig.phoneBaseUrl).replace(
        /\/cells\/motion\/phone\.html?$/i,
        '/cells/left-grille/dial-phone.html'
      );
      transportMode = bridgeConfig.transport || 'dual';
      source = 'bridge';
    }

    if (!base && loc && (loc.protocol === 'http:' || loc.protocol === 'https:')) {
      const dir = String(loc.pathname || '/').replace(/[^/]*$/, '');
      base = String(loc.origin || '') + dir + 'cells/left-grille/dial-phone.html';
      source = 'origin';
    }

    if (!base) {
      base = 'https://localhost:8443/cells/left-grille/dial-phone.html';
      source = 'fallback';
    }

    const sep = base.indexOf('?') >= 0 ? '&' : '?';
    const fullUrl = base + sep + 's=' + encodeURIComponent(sid) + '&t=' + encodeURIComponent(transportMode);
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(base);
    const isHttps = /^https:\/\//i.test(base);
    const tooLong = utf8ByteLength(fullUrl) > MAX_QR_URL_BYTES;

    return {
      baseUrl: base,
      qrUrl: tooLong ? '' : fullUrl,
      source: source,
      transportMode: transportMode,
      isLocalhost: isLocalhost,
      isHttps: isHttps,
      error: tooLong ? 'URL exceeds 213-byte QR capacity; use a shorter host.' : ''
    };
  }

  // =========================================================================
  // DOM & SVG Construction Helpers (Zero innerHTML!)
  // =========================================================================

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'className') el.className = v;
        else if (k === 'textContent') el.textContent = String(v);
        else if (k === 'dataset') {
          Object.keys(v).forEach(function (dk) {
            if (v[dk] !== undefined && v[dk] !== null) el.dataset[dk] = String(v[dk]);
          });
        } else if (k.startsWith('on') && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v === true) {
          el.setAttribute(k, '');
        } else {
          el.setAttribute(k, String(v));
        }
      });
    }
    if (children !== undefined && children !== null) {
      const list = Array.isArray(children) ? children : [children];
      list.forEach(function (c) {
        if (c === undefined || c === null || c === false) return;
        if (typeof c === 'string' || typeof c === 'number') {
          el.appendChild(document.createTextNode(String(c)));
        } else {
          el.appendChild(c);
        }
      });
    }
    return el;
  }

  function svgEl(tag, attrs, children) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (attrs[k] !== undefined && attrs[k] !== null) {
          node.setAttribute(k, String(attrs[k]));
        }
      });
    }
    if (children) {
      children.forEach(function (c) {
        if (c) node.appendChild(c);
      });
    }
    return node;
  }

  function clearChildren(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function safeStorageGet(storeName, key) {
    try {
      const st = root[storeName];
      return (st && st.getItem(key)) || '';
    } catch (_e) {
      return '';
    }
  }

  function safeStorageSet(storeName, key, val) {
    try {
      const st = root[storeName];
      if (!st) return;
      if (!val) st.removeItem(key);
      else st.setItem(key, val);
    } catch (_e) {}
  }

  function polarToCartesian(cx, cy, r, deg) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function describeRingArc(cx, cy, r, startDeg, endDeg) {
    const span = clamp(endDeg - startDeg, 0, 359.9);
    if (span < 0.8) return '';
    const s = polarToCartesian(cx, cy, r, startDeg);
    const e = polarToCartesian(cx, cy, r, startDeg + span);
    const largeArc = span > 180 ? 1 : 0;
    return (
      'M ' + s.x.toFixed(2) + ' ' + s.y.toFixed(2) +
      ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' 1 ' +
      e.x.toFixed(2) + ' ' + e.y.toFixed(2)
    );
  }

  // Subtle Web Audio mechanical detent click synthesizer
  function createDetentClickSynth() {
    let audioCtx = null;
    return {
      playTick: function (isMajor) {
        try {
          const Ctx = root.AudioContext || root.webkitAudioContext;
          if (!Ctx) return;
          if (!audioCtx) audioCtx = new Ctx();
          if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(function () {});
          }
          const now = audioCtx.currentTime;
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(isMajor ? 1480 : 1120, now);
          osc.frequency.exponentialRampToValueAtTime(260, now + 0.011);
          gain.gain.setValueAtTime(isMajor ? 0.065 : 0.038, now);
          gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.012);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(now);
          osc.stop(now + 0.013);
        } catch (_e) {}
      },
      close: function () {
        if (audioCtx) {
          try { audioCtx.close(); } catch (_e) {}
          audioCtx = null;
        }
      }
    };
  }

  // =========================================================================
  // Secondary Grid Cell 07 Mount (`#lg-sec-cell-7`)
  // =========================================================================

  function mountIphoneDialCell(cellEl) {
    if (!cellEl || typeof document === 'undefined') return null;

    if (typeof cellEl._idUnmount === 'function') {
      cellEl._idUnmount();
    }

    cellEl.classList.add('id-cell');
    cellEl.setAttribute('aria-label', '07 — iPhone Spinning Dial Control (Wi-Fi / WSS / BLE Rotary Encoder)');
    clearChildren(cellEl);

    const NS = root.MotionGrid || {};
    const Transport = NS.Transport;
    const QR = NS.QR;

    let sessionId = safeStorageGet('sessionStorage', STORAGE_SID_KEY);
    if (!sessionId || !(Transport && Transport.isValidSessionId(sessionId))) {
      const rand = Transport && typeof Transport.generateSessionId === 'function'
        ? Transport.generateSessionId(6)
        : '8492K7';
      sessionId = 'DL' + rand;
      safeStorageSet('sessionStorage', STORAGE_SID_KEY, sessionId);
    }

    const tracker = new RotaryDialTracker({ initialValue: 50 });
    const clickSynth = createDetentClickSynth();

    let customHost = safeStorageGet('localStorage', STORAGE_HOST_KEY);
    let bridgeConfig = null;
    let link = null;
    let linkState = 'connecting';
    let linkTransport = 'mqtt';
    let phoneConnected = false;
    let lastPhoneRxMs = 0;
    let bleDevice = null;
    let bleChar = null;
    let bleConnected = false;
    let qrOpen = false;
    let inertiaRaf = 0;
    let simTimer = 0;
    let heartbeatTimer = 0;
    let unmounted = false;

    // 1. Top Bezel Bar
    const ledDot = h('span', { className: 'id-led', dataset: { state: 'standby' }, 'aria-hidden': 'true' });
    const statusLabel = h('span', { className: 'id-status-text', textContent: 'DRAG · QR · BLE' });

    const qrBtn = h(
      'button',
      {
        type: 'button',
        className: 'id-btn id-btn--qr',
        'aria-expanded': 'false',
        title: 'Scan QR code with iPhone to spin phone flat on desk as a wireless rotary dial',
        onClick: function () { toggleQrOverlay(); }
      },
      ['PAIR QR']
    );

    const bleBtn = h(
      'button',
      {
        type: 'button',
        className: 'id-btn id-btn--ble',
        'aria-pressed': 'false',
        title: 'Pair BLE Rotary Encoder / Nordic UART via Web Bluetooth',
        onClick: function () { handleBleClick(); }
      },
      ['BLE']
    );

    const zeroBtn = h(
      'button',
      {
        type: 'button',
        className: 'id-btn',
        title: 'Zero rotary angle and turn counter (Z)',
        onClick: function () { handleZero(); }
      },
      ['ZERO']
    );

    const bezel = h('div', { className: 'id-bezel' }, [
      h('div', { className: 'id-bezel-left' }, [
        h('span', { className: 'id-kicker', textContent: '07' }),
        h('span', { className: 'id-title', textContent: 'iPhone Spin Dial' }),
        ledDot,
        statusLabel
      ]),
      h('div', { className: 'id-bezel-right' }, [qrBtn, bleBtn, zeroBtn])
    ]);

    // 2. Machined Braun / Teenage Engineering Rotary Encoder SVG
    const tickNodes = [];
    for (let i = 0; i < DETENT_COUNT; i++) {
      const deg = i * DETENT_STEP_DEG;
      const isCardinal = i % 6 === 0;
      const p1 = polarToCartesian(100, 100, isCardinal ? 84 : 87, deg);
      const p2 = polarToCartesian(100, 100, 95, deg);
      const line = svgEl('line', {
        x1: p1.x.toFixed(2),
        y1: p1.y.toFixed(2),
        x2: p2.x.toFixed(2),
        y2: p2.y.toFixed(2),
        class: isCardinal ? 'id-tick id-tick--major' : 'id-tick'
      });
      tickNodes.push(line);
    }

    const valueArcPath = svgEl('path', {
      class: 'id-value-arc',
      d: describeRingArc(100, 100, 80, 0, 180)
    });

    const rotorGroup = svgEl('g', { class: 'id-rotor', transform: 'rotate(0 100 100)' }, [
      // Outer machined aluminum chamfer
      svgEl('circle', { cx: 100, cy: 100, r: 72, class: 'id-rotor-rim' }),
      // Brushed metal platter face
      svgEl('circle', { cx: 100, cy: 100, r: 66, class: 'id-rotor-face' }),
      // Concentric lathe grooves
      svgEl('circle', { cx: 100, cy: 100, r: 54, class: 'id-rotor-groove' }),
      svgEl('circle', { cx: 100, cy: 100, r: 41, class: 'id-rotor-groove' }),
      // Braun Vermilion 12-o'clock index notch
      svgEl('line', { x1: 100, y1: 30, x2: 100, y2: 45, class: 'id-rotor-notch' }),
      // Teenage Engineering TP-7 finger dimple
      svgEl('circle', { cx: 100, cy: 52, r: 6.5, class: 'id-rotor-dimple' })
    ]);

    const dialSvg = svgEl(
      'svg',
      {
        viewBox: '0 0 200 200',
        class: 'id-dial-svg',
        'aria-hidden': 'true'
      },
      [
        svgEl('circle', { cx: 100, cy: 100, r: 96, class: 'id-stator-well' }),
        svgEl('circle', { cx: 100, cy: 100, r: 80, class: 'id-value-track' }),
        valueArcPath,
        svgEl('g', { class: 'id-ticks' }, tickNodes),
        rotorGroup,
        svgEl('circle', { cx: 100, cy: 100, r: 29, class: 'id-hub-cap' })
      ]
    );

    const hubAngleText = h('div', { className: 'id-hub-angle', textContent: '0.0°' });
    const hubTurnsText = h('div', { className: 'id-hub-turns', textContent: '0.00t · DET 00' });

    const dialPad = h(
      'div',
      {
        className: 'id-dial-pad',
        tabIndex: 0,
        role: 'slider',
        'aria-label': 'iPhone Rotary Encoder Dial',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': '50',
        'aria-valuetext': 'Angle 0.0 degrees, Value 50.0',
        title: 'Drag in a circle to spin dial, scroll wheel, or pair iPhone via QR / BLE'
      },
      [
        dialSvg,
        h('div', { className: 'id-hub-readout' }, [hubAngleText, hubTurnsText])
      ]
    );

    // 3. Right-Column Telemetry & Controls
    const valReadout = h('span', { className: 'id-metric-num', textContent: '50.0' });
    const fineBtn = h(
      'button',
      {
        type: 'button',
        className: 'id-mini-pill',
        'aria-pressed': 'false',
        title: 'Toggle Coarse (1x) vs Fine (0.25x) rotary sensitivity',
        onClick: function () {
          tracker.setFineMode(!tracker.fineMode);
          sendToPhone({ t: 'cmd', cmd: 'fine', val: tracker.fineMode });
          renderTelemetry();
        }
      },
      ['1× COARSE']
    );
    const valFill = h('div', { className: 'id-bar-fill' });
    const poseBadge = h('div', { className: 'id-sub-meta', textContent: 'Flat desk · Z-axis gravity lock' });

    const rpmReadout = h('span', { className: 'id-metric-num', textContent: '0.0' });
    const degSecMeta = h('div', { className: 'id-sub-meta', textContent: '0.0°/s · 0 clicks' });

    const spinSimBtn = h(
      'button',
      {
        type: 'button',
        className: 'id-mini-btn',
        title: 'Simulate a 360-degree clockwise desk spin (24 detent ticks)',
        onClick: function () { runSyntheticSpin(360); }
      },
      ['Spin +360°']
    );

    const spinCcwBtn = h(
      'button',
      {
        type: 'button',
        className: 'id-mini-btn',
        title: 'Simulate a counter-clockwise desk spin (-180 deg)',
        onClick: function () { runSyntheticSpin(-180); }
      },
      ['Spin −180°']
    );

    const linkMetaText = h('span', {
      className: 'id-link-meta',
      textContent: 'WSS ' + sessionId.slice(0, 6)
    });

    const telemetryCol = h('div', { className: 'id-telemetry' }, [
      h('div', { className: 'id-card' }, [
        h('div', { className: 'id-card-head' }, [
          h('span', { className: 'id-label', textContent: 'DIAL VALUE' }),
          fineBtn
        ]),
        h('div', { className: 'id-metric-row' }, [
          valReadout,
          h('span', { className: 'id-metric-unit', textContent: '/ 100' })
        ]),
        h('div', { className: 'id-bar-track' }, [valFill]),
        poseBadge
      ]),
      h('div', { className: 'id-card' }, [
        h('div', { className: 'id-card-head' }, [
          h('span', { className: 'id-label', textContent: 'VELOCITY · 24-DETENT' })
        ]),
        h('div', { className: 'id-metric-row' }, [
          rpmReadout,
          h('span', { className: 'id-metric-unit', textContent: ' RPM' })
        ]),
        degSecMeta
      ]),
      h('div', { className: 'id-footer-row' }, [
        h('div', { className: 'id-sim-group' }, [spinSimBtn, spinCcwBtn]),
        linkMetaText
      ])
    ]);

    // 4. In-Cell QR Pairing & LAN/HTTPS Host Overlay Popover
    const qrSvgSlot = h('div', { className: 'id-qr-box' });
    const qrHintText = h('div', {
      className: 'id-qr-hint',
      textContent: 'Scan with iPhone camera, tap Enable Gyroscope, and lay phone flat on desk to spin.'
    });
    const hostInput = h('input', {
      type: 'url',
      className: 'id-host-input',
      placeholder: 'LAN IP or HTTPS URL (e.g. https://192.168.1.10:8443)',
      value: customHost,
      'aria-label': 'Mobile controller LAN IP or HTTPS host override',
      onInput: function (e) {
        customHost = String(e.target.value || '').trim();
        safeStorageSet('localStorage', STORAGE_HOST_KEY, customHost);
        renderQrPopover();
      }
    });
    const copyUrlBtn = h(
      'button',
      {
        type: 'button',
        className: 'id-mini-btn',
        onClick: function () {
          const info = resolveDialPhoneUrl(customHost, bridgeConfig, root.location, sessionId);
          const target = info.qrUrl || info.baseUrl;
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(target).then(function () {
              copyUrlBtn.textContent = 'Copied ✓';
              setTimeout(function () { copyUrlBtn.textContent = 'Copy URL'; }, 1000);
            }).catch(function () {});
          }
        }
      },
      ['Copy URL']
    );
    const closeQrBtn = h(
      'button',
      {
        type: 'button',
        className: 'id-mini-btn id-mini-btn--close',
        onClick: function () { closeQrOverlay(true); }
      },
      ['Done']
    );

    const qrOverlay = h('div', { className: 'id-qr-overlay', hidden: true }, [
      qrSvgSlot,
      h('div', { className: 'id-qr-meta' }, [
        h('div', { className: 'id-qr-top' }, [
          h('span', { className: 'id-qr-sid', textContent: 'SID ' + sessionId }),
          h('div', { className: 'id-qr-actions' }, [copyUrlBtn, closeQrBtn])
        ]),
        qrHintText,
        hostInput
      ])
    ]);

    const stage = h('div', { className: 'id-stage' }, [
      bezel,
      h('div', { className: 'id-body' }, [dialPad, telemetryCol]),
      qrOverlay
    ]);

    cellEl.appendChild(stage);

    // =========================================================================
    // Rendering & Live UI Sync
    // =========================================================================

    function renderTelemetry() {
      const st = tracker.getState();
      const angleStr = st.angleDeg.toFixed(1) + '°';
      const valStr = st.dialValue.toFixed(1);
      const turnsSign = st.turns >= 0 ? '+' : '−';
      const slotStr = String(st.detentSlot).padStart(2, '0');

      rotorGroup.setAttribute('transform', 'rotate(' + st.angleDeg.toFixed(2) + ' 100 100)');
      const arcDeg = (st.dialValue / 100) * 359.5;
      valueArcPath.setAttribute('d', describeRingArc(100, 100, 80, 0, arcDeg));

      for (let i = 0; i < tickNodes.length; i++) {
        tickNodes[i].classList.toggle('is-active', i === st.detentSlot);
      }

      hubAngleText.textContent = angleStr;
      hubTurnsText.textContent = turnsSign + Math.abs(st.turns).toFixed(2) + 't · #' + slotStr;

      valReadout.textContent = valStr;
      valFill.style.width = clamp(st.dialValue, 0, 100).toFixed(1) + '%';

      fineBtn.setAttribute('aria-pressed', st.fineMode ? 'true' : 'false');
      fineBtn.textContent = st.fineMode ? '0.25× FINE' : '1× COARSE';

      const absRpm = Math.abs(st.rpm);
      rpmReadout.textContent = absRpm.toFixed(1);
      const rateSign = st.degPerSec >= 0 ? '+' : '−';
      degSecMeta.textContent =
        rateSign + Math.abs(st.degPerSec).toFixed(1) + '°/s · ' + st.totalDetentTicks + ' ticks';

      if (phoneConnected) {
        const orientTag = st.faceUp ? 'Face-Up' : 'Face-Down';
        poseBadge.textContent =
          'iPhone ' + orientTag + ' · Tilt ' + st.tiltDeg.toFixed(1) + '° · 0-drift';
      } else if (bleConnected) {
        poseBadge.textContent = 'BLE Rotary Linked · 24-detent lock';
      } else {
        poseBadge.textContent = 'Flat desk · Z-axis gravity lock';
      }

      dialPad.setAttribute('aria-valuenow', String(Math.round(st.dialValue)));
      dialPad.setAttribute(
        'aria-valuetext',
        'Angle ' + angleStr + ', Value ' + valStr + ' of 100'
      );

      updateStatusPill();
    }

    function updateStatusPill() {
      if (phoneConnected) {
        ledDot.dataset.state = 'live';
        statusLabel.textContent = linkTransport === 'local-ws' ? 'IPHONE · WS' : 'IPHONE · WSS';
      } else if (bleConnected) {
        ledDot.dataset.state = 'live';
        statusLabel.textContent = 'BLE LIVE';
      } else if (linkState === 'ready') {
        ledDot.dataset.state = 'ready';
        statusLabel.textContent = 'READY · SCAN/DRAG';
      } else {
        ledDot.dataset.state = 'standby';
        statusLabel.textContent = 'DRAG · QR · BLE';
      }
    }

    function renderQrPopover() {
      clearChildren(qrSvgSlot);
      const info = resolveDialPhoneUrl(customHost, bridgeConfig, root.location, sessionId);

      if (info.qrUrl && QR && typeof QR.renderSVGElement === 'function') {
        try {
          const rendered = QR.renderSVGElement(info.qrUrl, {
            quiet: 3,
            fg: '#141413',
            bg: '#ffffff',
            label: 'Scan with iPhone camera to open iPhone Spin Dial controller'
          });
          qrSvgSlot.appendChild(rendered.svg);
        } catch (_e) {
          qrSvgSlot.appendChild(h('div', { className: 'id-qr-fallback', textContent: 'QR ERR' }));
        }
      } else {
        qrSvgSlot.appendChild(
          h('div', { className: 'id-qr-fallback', textContent: info.error || 'QR READY' })
        );
      }

      if (info.error) {
        qrHintText.textContent = info.error;
      } else if (info.isLocalhost && !customHost) {
        qrHintText.textContent =
          'Opened on localhost: enter your Mac LAN IP or HTTPS tunnel below so iPhone on Wi-Fi can reach dial-phone.html.';
      } else {
        qrHintText.textContent =
          'Scan on iPhone -> Tap Enable Gyroscope -> Lay phone flat on desk and spin like a knob.';
      }
    }

    function toggleQrOverlay() {
      if (qrOpen) {
        closeQrOverlay(true);
      } else {
        qrOpen = true;
        qrBtn.setAttribute('aria-expanded', 'true');
        renderQrPopover();
        qrOverlay.hidden = false;
        hostInput.focus({ preventScroll: true });
      }
    }

    function closeQrOverlay(restoreFocus) {
      if (!qrOpen) return;
      qrOpen = false;
      qrOverlay.hidden = true;
      qrBtn.setAttribute('aria-expanded', 'false');
      if (restoreFocus) {
        qrBtn.focus({ preventScroll: true });
      }
    }

    function handleZero() {
      stopInertia();
      tracker.zero();
      sendToPhone({ t: 'cmd', cmd: 'zero' });
      renderTelemetry();
    }

    // =========================================================================
    // Desktop Circular Drag-to-Spin + Inertial Flywheel Momentum
    // =========================================================================

    let dragState = null;

    function stopInertia() {
      if (inertiaRaf) {
        cancelAnimationFrame(inertiaRaf);
        inertiaRaf = 0;
      }
      if (simTimer) {
        clearInterval(simTimer);
        simTimer = 0;
      }
    }

    function pointerAngleFromCenter(clientX, clientY) {
      const rect = dialPad.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const rad = Math.atan2(clientY - cy, clientX - cx);
      return wrapAngle360((rad * 180) / Math.PI + 90);
    }

    dialPad.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      stopInertia();
      dialPad.focus({ preventScroll: true });
      if (dialPad.setPointerCapture) {
        try { dialPad.setPointerCapture(e.pointerId); } catch (_err) {}
      }
      const now = performance.now();
      dragState = {
        pointerId: e.pointerId,
        lastAngle: pointerAngleFromCenter(e.clientX, e.clientY),
        lastTime: now,
        velDegPerSec: 0
      };
      dialPad.classList.add('is-dragging');
    });

    dialPad.addEventListener('pointermove', function (e) {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      const now = performance.now();
      const dt = Math.max(0.004, Math.min(0.1, (now - dragState.lastTime) / 1000));
      const curAngle = pointerAngleFromCenter(e.clientX, e.clientY);
      const delta = wrapAngleDiffDeg(curAngle, dragState.lastAngle);

      dragState.lastAngle = curAngle;
      dragState.lastTime = now;
      dragState.velDegPerSec = 0.65 * (delta / dt) + 0.35 * dragState.velDegPerSec;

      const st = tracker.ingestDeltaAngle(delta, dt);
      if (st.detentDelta !== 0) {
        clickSynth.playTick(st.detentSlot % 6 === 0);
      }
      renderTelemetry();
    });

    function finishPointerDrag(e, cancelled) {
      if (!dragState || (e && e.pointerId !== dragState.pointerId)) return;
      const releaseVel = cancelled ? 0 : dragState.velDegPerSec;
      dragState = null;
      dialPad.classList.remove('is-dragging');

      if (Math.abs(releaseVel) > 28) {
        startInertialFlywheel( clamp(releaseVel, -1080, 1080) );
      } else {
        tracker.ingestDeltaAngle(0, 0.016);
        renderTelemetry();
      }
    }

    dialPad.addEventListener('pointerup', function (e) { finishPointerDrag(e, false); });
    dialPad.addEventListener('pointercancel', function (e) { finishPointerDrag(e, true); });

    function startInertialFlywheel(initialVelDegPerSec) {
      stopInertia();
      let vel = initialVelDegPerSec;
      let lastTs = performance.now();

      function stepFlywheel(now) {
        if (unmounted) {
          inertiaRaf = 0;
          return;
        }
        const dt = Math.max(0.004, Math.min(0.05, (now - lastTs) / 1000));
        lastTs = now;
        vel *= Math.exp(-dt / 0.58);
        if (Math.abs(vel) < 3.0) {
          tracker.ingestDeltaAngle(0, dt);
          renderTelemetry();
          inertiaRaf = 0;
          return;
        }
        const st = tracker.ingestDeltaAngle(vel * dt, dt);
        if (st.detentDelta !== 0) {
          clickSynth.playTick(st.detentSlot % 6 === 0);
        }
        renderTelemetry();
        inertiaRaf = requestAnimationFrame(stepFlywheel);
      }

      inertiaRaf = requestAnimationFrame(stepFlywheel);
    }

    // Wheel & Keyboard precision control
    dialPad.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault();
        stopInertia();
        const delta = clamp(-(e.deltaY || e.deltaX) * 0.35, -30, 30);
        const st = tracker.ingestDeltaAngle(delta, 0.016);
        if (st.detentDelta !== 0) {
          clickSynth.playTick(st.detentSlot % 6 === 0);
        }
        renderTelemetry();
      },
      { passive: false }
    );

    dialPad.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        stopInertia();
        const step = e.shiftKey ? 1.5 : DETENT_STEP_DEG;
        const st = tracker.ingestDeltaAngle(step, 0.016);
        if (st.detentDelta !== 0) clickSynth.playTick(st.detentSlot % 6 === 0);
        renderTelemetry();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        stopInertia();
        const step = e.shiftKey ? -1.5 : -DETENT_STEP_DEG;
        const st = tracker.ingestDeltaAngle(step, 0.016);
        if (st.detentDelta !== 0) clickSynth.playTick(st.detentSlot % 6 === 0);
        renderTelemetry();
      } else if (e.key === 'Home') {
        e.preventDefault();
        tracker.setValue(0);
        renderTelemetry();
      } else if (e.key === 'End') {
        e.preventDefault();
        tracker.setValue(100);
        renderTelemetry();
      } else if (e.key === 'z' || e.key === 'Z' || e.key === '0') {
        e.preventDefault();
        handleZero();
      }
    });

    function runSyntheticSpin(totalDegrees) {
      stopInertia();
      const steps = 24;
      const stepDeg = totalDegrees / steps;
      let count = 0;
      simTimer = setInterval(function () {
        if (unmounted || count >= steps) {
          clearInterval(simTimer);
          simTimer = 0;
          tracker.ingestDeltaAngle(0, 0.016);
          renderTelemetry();
          return;
        }
        count++;
        const st = tracker.ingestMotion({
          alpha: stepDeg / 0.016,
          beta: 0,
          gamma: 0,
          gx: 0,
          gy: 0,
          gz: 9.81,
          dt: 0.016
        });
        if (st.detentDelta !== 0) {
          clickSynth.playTick(st.detentSlot % 6 === 0);
        }
        renderTelemetry();
      }, 16);
    }

    // =========================================================================
    // Path 1 & 2: Wi-Fi Local WS + Zero-Server MQTT over WSS Relay
    // =========================================================================

    function sendToPhone(msg) {
      if (link) link.send(msg);
    }

    function handlePhonePacket(msg) {
      if (!msg || typeof msg !== 'object') return;
      lastPhoneRxMs = Date.now();
      if (!phoneConnected) {
        phoneConnected = true;
        if (qrOpen) closeQrOverlay(false);
      }

      if (msg.t === 'hello') {
        sendToPhone({
          t: 'state',
          dialValue: Number(tracker.dialValue.toFixed(2)),
          fineMode: tracker.fineMode
        });
        renderTelemetry();
        return;
      }

      if (msg.t === 'act') {
        if (msg.cmd === 'zero') {
          tracker.zero();
        } else if (msg.cmd === 'reset') {
          tracker.zero(50);
        } else if (msg.cmd === 'fine') {
          tracker.setFineMode(Boolean(msg.val));
        }
        renderTelemetry();
        return;
      }

      if (msg.t === 'm' || msg.t === 'dial') {
        stopInertia();
        const prevSlot = tracker.detentSlot;
        if (Number.isFinite(msg.deltaDeg)) {
          tracker.ingestDeltaAngle(msg.deltaDeg, msg.dt || 0.025);
        } else if (Number.isFinite(msg.angleDeg)) {
          tracker.ingestAbsoluteAngle(msg.angleDeg, 0.025);
        }
        if (Number.isFinite(msg.cumulativeDeg)) tracker.cumulativeDeg = msg.cumulativeDeg;
        if (Number.isFinite(msg.turns)) tracker.turns = msg.turns;
        if (Number.isFinite(msg.degPerSec)) tracker.degPerSec = msg.degPerSec;
        if (Number.isFinite(msg.rpm)) tracker.rpm = msg.rpm;
        if (Number.isFinite(msg.detentIndex)) tracker.detentIndex = msg.detentIndex;
        if (Number.isFinite(msg.detentSlot)) tracker.detentSlot = msg.detentSlot;
        if (Number.isFinite(msg.totalDetentTicks)) tracker.totalDetentTicks = msg.totalDetentTicks;
        if (Number.isFinite(msg.dialValue)) tracker.dialValue = clamp(msg.dialValue, 0, 100);
        if (typeof msg.fineMode === 'boolean') tracker.fineMode = msg.fineMode;
        if (typeof msg.faceUp === 'boolean') tracker.faceUp = msg.faceUp;
        if (Number.isFinite(msg.tiltDeg)) tracker.tiltDeg = msg.tiltDeg;

        if (tracker.detentSlot !== prevSlot) {
          clickSynth.playTick(tracker.detentSlot % 6 === 0);
        }
        renderTelemetry();
      }
    }

    function connectTransport() {
      if (!Transport || typeof Transport.createLink !== 'function') return;
      if (link) {
        link.close();
        link = null;
      }
      const hasBridge = Boolean(bridgeConfig && bridgeConfig.desktopWsUrl);
      const wsUrl = hasBridge
        ? bridgeConfig.desktopWsUrl + '?s=' + encodeURIComponent(sessionId) + '&role=desktop'
        : '';
      const httpBase = hasBridge ? bridgeConfig.desktopHttpBase : '';

      link = Transport.createLink({
        mode: hasBridge ? 'dual' : 'mqtt',
        sessionId: sessionId,
        role: 'desktop',
        wsUrl: wsUrl,
        httpBase: httpBase,
        onStatus: function (st, info) {
          linkState = st;
          linkTransport = (info && info.transport) || 'mqtt';
          linkMetaText.textContent =
            (linkTransport === 'local-ws' ? 'WS ' : 'WSS ') + sessionId.slice(0, 6);
          updateStatusPill();
        },
        onMessage: handlePhonePacket
      });
      link.start();
    }

    function probeLocalBridge() {
      if (typeof root.fetch !== 'function') return;
      const loc = root.location || {};
      if (loc.protocol !== 'http:' && loc.protocol !== 'https:') return;
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const tId = setTimeout(function () {
        if (ctrl) {
          try { ctrl.abort(); } catch (_e) {}
        }
      }, 900);
      root.fetch(loc.origin + '/api/motion-config', {
        method: 'GET',
        signal: ctrl ? ctrl.signal : undefined
      })
        .then(function (r) {
          clearTimeout(tId);
          return r && r.ok ? r.json() : null;
        })
        .then(function (cfg) {
          if (unmounted || !cfg || !cfg.ok) return;
          bridgeConfig = cfg;
          connectTransport();
          if (qrOpen) renderQrPopover();
        })
        .catch(function () {
          clearTimeout(tId);
        });
    }

    // =========================================================================
    // Path 3: Web Bluetooth BLE (`navigator.bluetooth`)
    // =========================================================================

    function disconnectBle() {
      if (bleChar) {
        try { bleChar.removeEventListener('characteristicvaluechanged', onBleValueChanged); } catch (_e) {}
        bleChar = null;
      }
      if (bleDevice && bleDevice.gatt && bleDevice.gatt.connected) {
        try { bleDevice.gatt.disconnect(); } catch (_e) {}
      }
      bleDevice = null;
      bleConnected = false;
      bleBtn.setAttribute('aria-pressed', 'false');
      bleBtn.textContent = 'BLE';
      updateStatusPill();
    }

    function onBleValueChanged(ev) {
      const val = ev && ev.target && ev.target.value;
      const parsed = parseBleRotaryPayload(val);
      if (!parsed) return;
      stopInertia();
      let st;
      if (parsed.kind === 'delta') {
        st = tracker.ingestDeltaAngle(parsed.deltaDeg, 0.02);
      } else {
        st = tracker.ingestAbsoluteAngle(parsed.angleDeg, 0.02);
      }
      if (Number.isFinite(parsed.dialValue)) {
        tracker.setValue(parsed.dialValue);
      }
      if (st && st.detentDelta !== 0) {
        clickSynth.playTick(st.detentSlot % 6 === 0);
      }
      renderTelemetry();
    }

    async function handleBleClick() {
      if (bleConnected) {
        disconnectBle();
        renderTelemetry();
        return;
      }
      const bt = root.navigator && root.navigator.bluetooth;
      if (!bt || typeof bt.requestDevice !== 'function') {
        statusLabel.textContent = 'BLE N/A · USE QR';
        poseBadge.textContent = 'Web Bluetooth requires Chrome/Edge · Use [PAIR QR] on Safari';
        return;
      }
      try {
        statusLabel.textContent = 'BLE PAIRING…';
        const device = await bt.requestDevice({
          acceptAllDevices: true,
          optionalServices: [BLE_UART_SERVICE, 0x1816, 0x180d, 'battery_service']
        });
        if (!device || !device.gatt) return;
        bleDevice = device;
        device.addEventListener('gattserverdisconnected', function () {
          disconnectBle();
          renderTelemetry();
        });
        const server = await device.gatt.connect();
        let boundChar = null;

        try {
          const uartSvc = await server.getPrimaryService(BLE_UART_SERVICE);
          boundChar = await uartSvc.getCharacteristic(BLE_UART_TX_CHAR);
        } catch (_e) {
          const services = await server.getPrimaryServices();
          for (let s = 0; s < services.length && !boundChar; s++) {
            try {
              const chars = await services[s].getCharacteristics();
              for (let c = 0; c < chars.length; c++) {
                if (chars[c].properties && chars[c].properties.notify) {
                  boundChar = chars[c];
                  break;
                }
              }
            } catch (_e2) {}
          }
        }

        if (boundChar) {
          bleChar = boundChar;
          await boundChar.startNotifications();
          boundChar.addEventListener('characteristicvaluechanged', onBleValueChanged);
        }
        bleConnected = true;
        bleBtn.setAttribute('aria-pressed', 'true');
        bleBtn.textContent = 'BLE ON';
        renderTelemetry();
      } catch (err) {
        disconnectBle();
        const msg = String((err && err.message) || err || '');
        if (!/cancelled|canceled|user/i.test(msg)) {
          statusLabel.textContent = 'BLE RETRY / QR';
        } else {
          updateStatusPill();
        }
      }
    }

    // Lifecycle & Secondary Grid Close Handling
    function onSecondaryClose() {
      stopInertia();
      closeQrOverlay(false);
      if (bleConnected) disconnectBle();
    }

    function onKeyDownDoc(e) {
      if (e.key === 'Escape' && qrOpen) {
        e.stopPropagation();
        e.preventDefault();
        closeQrOverlay(true);
      }
    }

    root.addEventListener('lg-secondary-close', onSecondaryClose);
    document.addEventListener('keydown', onKeyDownDoc, true);

    heartbeatTimer = setInterval(function () {
      if (phoneConnected && Date.now() - lastPhoneRxMs > 7000) {
        phoneConnected = false;
        renderTelemetry();
      }
    }, 1500);

    connectTransport();
    probeLocalBridge();
    renderTelemetry();

    cellEl._idUnmount = function () {
      unmounted = true;
      stopInertia();
      clearInterval(heartbeatTimer);
      if (link) {
        link.close();
        link = null;
      }
      disconnectBle();
      clickSynth.close();
      root.removeEventListener('lg-secondary-close', onSecondaryClose);
      document.removeEventListener('keydown', onKeyDownDoc, true);
    };

    return {
      tracker: tracker,
      zero: handleZero,
      runSyntheticSpin: runSyntheticSpin,
      unmount: cellEl._idUnmount
    };
  }

  return {
    DETENT_COUNT: DETENT_COUNT,
    DETENT_STEP_DEG: DETENT_STEP_DEG,
    STATIONARY_DEADBAND_DEG_PER_SEC: STATIONARY_DEADBAND_DEG_PER_SEC,
    clamp: clamp,
    wrapAngle360: wrapAngle360,
    wrapAngleDiffDeg: wrapAngleDiffDeg,
    normalizeGravityVector: normalizeGravityVector,
    projectDeskSpinRate: projectDeskSpinRate,
    RotaryDialTracker: RotaryDialTracker,
    parseBleRotaryPayload: parseBleRotaryPayload,
    resolveDialPhoneUrl: resolveDialPhoneUrl,
    mountIphoneDialCell: mountIphoneDialCell
  };
});
