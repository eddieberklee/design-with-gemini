(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  const ns = (root.MotionGrid = root.MotionGrid || {});
  ns.Physics = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const MIN_SCALE = 0.34;
  const MAX_SCALE = 2.15;
  const DEFAULT_SCALE = 1.0;
  const MIN_CELL_W = 140;
  const MAX_CELL_W = 960;

  function clamp(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /**
   * Tracks the gravity vector from accelerationIncludingGravity via an exponential
   * low-pass filter, returning a normalized unit vector gHat so world-up and tilt
   * math stay invariant to device orientation and iOS/Android sign conventions.
   */
  function GravityFilter(alpha) {
    this.alpha = typeof alpha === 'number' ? alpha : 0.86;
    this.initialized = false;
    this.gx = 0;
    this.gy = 0;
    this.gz = -9.81;
  }

  GravityFilter.prototype.reset = function () {
    this.initialized = false;
    this.gx = 0;
    this.gy = 0;
    this.gz = -9.81;
  };

  GravityFilter.prototype.update = function (ax, ay, az) {
    const x = Number.isFinite(ax) ? ax : 0;
    const y = Number.isFinite(ay) ? ay : 0;
    const z = Number.isFinite(az) ? az : 0;
    const mag = Math.hypot(x, y, z);
    if (mag < 0.5) {
      return this.getUnit();
    }
    if (!this.initialized) {
      this.gx = x;
      this.gy = y;
      this.gz = z;
      this.initialized = true;
    } else {
      const a = this.alpha;
      this.gx = a * this.gx + (1 - a) * x;
      this.gy = a * this.gy + (1 - a) * y;
      this.gz = a * this.gz + (1 - a) * z;
    }
    return this.getUnit();
  };

  GravityFilter.prototype.getUnit = function () {
    const mag = Math.hypot(this.gx, this.gy, this.gz);
    if (mag < 1e-4) {
      return { x: 0, y: 0, z: -1, mag: 9.81 };
    }
    return {
      x: this.gx / mag,
      y: this.gy / mag,
      z: this.gz / mag,
      mag: mag
    };
  };

  /**
   * Computes continuous tilt angles (degrees) from the normalized gravity vector.
   * Works smoothly across full portrait/flat handheld grips without Euler gimbal flip.
   */
  function gravityToTiltDeg(gUnit) {
    // Roll: tilting left/right around the phone's long axis (-90..+90)
    // Pitch: tilting nose up/down around the phone's horizontal axis (-90..+90)
    const radToDeg = 180 / Math.PI;
    const roll = Math.atan2(gUnit.x, Math.hypot(gUnit.y, gUnit.z)) * radToDeg;
    const pitch = Math.atan2(gUnit.y, Math.hypot(gUnit.x, gUnit.z)) * radToDeg;
    return { roll: roll, pitch: pitch };
  }

  /**
   * Core Phone Accelerometer & Orientation Processor.
   * Converts raw iOS/Android DeviceMotion + DeviceOrientation events into a smooth,
   * drift-controlled grid cell scale in [MIN_SCALE, MAX_SCALE].
   *
   * Supported modes:
   * - 'all'  : Fused Tilt Dial + Vertical Lift + Pull/Push impulses (immediate response to any gesture)
   * - 'tilt' : Zero-drift absolute rotation/tilt relative to calibrated neutral pose
   * - 'lift' : World-up projected linear acceleration (raise phone up = bigger, lower = smaller)
   * - 'pull' : Screen-normal/forward linear acceleration (pull toward self = bigger, push away = smaller)
   */
  function MotionProcessor(opts) {
    const cfg = opts || {};
    this.mode = cfg.mode || 'all';
    this.sensitivity = typeof cfg.sensitivity === 'number' ? cfg.sensitivity : 1.0;
    this.clutchRequired = Boolean(cfg.clutchRequired);
    this.clutchActive = false;

    this.gravity = new GravityFilter(0.86);
    this.baseScale = DEFAULT_SCALE;
    this.scale = DEFAULT_SCALE;
    this.impulseOffset = 0;

    // Neutral pose calibration (captured on first valid reading or Zero button)
    this.calibrated = false;
    this.zeroRoll = 0;
    this.zeroPitch = 0;
    this.zeroGamma = 0;
    this.zeroBeta = 0;
    this.hasOrientation = false;
    this.lastGamma = 0;
    this.lastBeta = 0;

    // Velocity-damped ZUPT linear integrators (prevents MEMS quadratic drift)
    this.velLift = 0;
    this.velPull = 0;
    this.quietLiftMs = 0;
    this.quietPullMs = 0;
    this.lastTs = null;

    // Latest smoothed telemetry for UI meters
    this.telemetry = {
      ax: 0, ay: 0, az: 0,
      gx: 0, gy: 0, gz: -9.81,
      roll: 0, pitch: 0,
      liftA: 0, pullA: 0,
      scale: DEFAULT_SCALE,
      mode: this.mode
    };
  }

  MotionProcessor.prototype.setMode = function (mode) {
    const allowed = ['all', 'tilt', 'lift', 'pull'];
    if (allowed.indexOf(mode) < 0) return;
    if (this.mode !== mode) {
      // Carry current scale cleanly as the new baseline so switching modes never jumps!
      this.baseScale = this.scale;
      this.impulseOffset = 0;
      this.velLift = 0;
      this.velPull = 0;
      this.zeroRoll = this.telemetry.roll;
      this.zeroPitch = this.telemetry.pitch;
      this.zeroGamma = this.lastGamma;
      this.zeroBeta = this.lastBeta;
      this.mode = mode;
      this.telemetry.mode = mode;
    }
  };

  MotionProcessor.prototype.setClutchRequired = function (req) {
    this.clutchRequired = Boolean(req);
    if (!this.clutchRequired) {
      this.clutchActive = false;
    }
  };

  MotionProcessor.prototype.setClutch = function (active) {
    const next = Boolean(active);
    if (next && !this.clutchActive) {
      // Re-anchor tilt on clutch press so you can ratchet like a trackpad
      this.baseScale = this.scale;
      this.impulseOffset = 0;
      this.zeroRoll = this.telemetry.roll;
      this.zeroPitch = this.telemetry.pitch;
      this.zeroGamma = this.lastGamma;
      this.zeroBeta = this.lastBeta;
      this.velLift = 0;
      this.velPull = 0;
    } else if (!next && this.clutchActive) {
      this.baseScale = this.scale;
      this.impulseOffset = 0;
      this.velLift = 0;
      this.velPull = 0;
    }
    this.clutchActive = next;
  };

  MotionProcessor.prototype.calibrate = function () {
    this.zeroRoll = this.telemetry.roll;
    this.zeroPitch = this.telemetry.pitch;
    this.zeroGamma = this.lastGamma;
    this.zeroBeta = this.lastBeta;
    this.baseScale = this.scale;
    this.impulseOffset = 0;
    this.velLift = 0;
    this.velPull = 0;
    this.calibrated = true;
  };

  MotionProcessor.prototype.resetScale = function (targetScale) {
    const s = clamp(typeof targetScale === 'number' ? targetScale : DEFAULT_SCALE, MIN_SCALE, MAX_SCALE);
    this.baseScale = s;
    this.scale = s;
    this.impulseOffset = 0;
    this.velLift = 0;
    this.velPull = 0;
    this.zeroRoll = this.telemetry.roll;
    this.zeroPitch = this.telemetry.pitch;
    this.zeroGamma = this.lastGamma;
    this.zeroBeta = this.lastBeta;
    this.telemetry.scale = s;
    return s;
  };

  MotionProcessor.prototype.ingestOrientation = function (beta, gamma) {
    if (Number.isFinite(beta) && Number.isFinite(gamma)) {
      this.lastBeta = beta;
      this.lastGamma = gamma;
      if (!this.hasOrientation) {
        this.hasOrientation = true;
        this.zeroBeta = beta;
        this.zeroGamma = gamma;
      }
    }
  };

  /**
   * Process one DeviceMotion sample.
   * @param {Object} sample
   *   { ax, ay, az, gx, gy, gz, ts, isIOS }
   *   - ax,ay,az: linear acceleration (m/s^2, gravity removed)
   *   - gx,gy,gz: accelerationIncludingGravity (m/s^2)
   *   - ts: timestamp in ms
   *   - isIOS: optional boolean (iOS Safari reports accelerationIncludingGravity with inverted sign vs W3C/Android)
   */
  MotionProcessor.prototype.ingestMotion = function (sample) {
    const s = sample || {};
    const ts = Number.isFinite(s.ts) ? s.ts : Date.now();
    let dt = this.lastTs === null ? 0.016 : (ts - this.lastTs) / 1000;
    if (!Number.isFinite(dt) || dt <= 0 || dt > 0.25) dt = 0.016;
    this.lastTs = ts;

    // Normalize iOS inverted accelerometer axes so +up and +right feel consistent everywhere
    const sign = s.isIOS ? -1 : 1;
    const rawGx = Number.isFinite(s.gx) ? s.gx * sign : 0;
    const rawGy = Number.isFinite(s.gy) ? s.gy * sign : 0;
    const rawGz = Number.isFinite(s.gz) ? s.gz * sign : 0;

    const gUnit = this.gravity.update(rawGx, rawGy, rawGz);

    // Linear acceleration: prefer hardware-fused event.acceleration; fall back to high-pass (accIncGrav - g)
    const hasLinear = Number.isFinite(s.ax) && Number.isFinite(s.ay) && Number.isFinite(s.az);
    const linX = hasLinear ? s.ax * sign : (rawGx - this.gravity.gx);
    const linY = hasLinear ? s.ay * sign : (rawGy - this.gravity.gy);
    const linZ = hasLinear ? s.az * sign : (rawGz - this.gravity.gz);

    const tilt = gravityToTiltDeg(gUnit);
    if (!this.calibrated) {
      this.zeroRoll = tilt.roll;
      this.zeroPitch = tilt.pitch;
      this.calibrated = true;
    }

    // World-Up projection: gravity vector in W3C convention points UP along normal reaction (+9.81 on flat table)
    // With sign normalized to W3C convention, gUnit points along world-UP!
    const liftA = linX * gUnit.x + linY * gUnit.y + linZ * gUnit.z;

    // Pull/Push axis: screen-normal (+Z out of glass toward user's face), orthogonalized against gravity
    const nzDotG = gUnit.z;
    const px = -nzDotG * gUnit.x;
    const py = -nzDotG * gUnit.y;
    const pz = 1 - nzDotG * gUnit.z;
    const pMag = Math.hypot(px, py, pz);
    // When phone is held flat (screen faces straight up), screen-normal coincides with world-up;
    // fall back to phone's -Y axis (pulling phone along table toward chest).
    let pullA;
    if (pMag > 0.25) {
      pullA = (linX * px + linY * py + linZ * pz) / pMag;
    } else {
      pullA = -linY;
    }

    this.telemetry.ax = linX;
    this.telemetry.ay = linY;
    this.telemetry.az = linZ;
    this.telemetry.gx = this.gravity.gx;
    this.telemetry.gy = this.gravity.gy;
    this.telemetry.gz = this.gravity.gz;
    this.telemetry.roll = tilt.roll;
    this.telemetry.pitch = tilt.pitch;
    this.telemetry.liftA = liftA;
    this.telemetry.pullA = pullA;

    // If clutch mode is enabled and thumb isn't down, hold current scale steady
    if (this.clutchRequired && !this.clutchActive) {
      this.velLift *= Math.exp(-dt / 0.08);
      this.velPull *= Math.exp(-dt / 0.08);
      this.telemetry.scale = this.scale;
      return this.telemetry;
    }

    // 1. Tilt delta relative to calibrated neutral pose (degrees)
    const dRoll = clamp(tilt.roll - this.zeroRoll, -65, 65);
    const dPitch = clamp(tilt.pitch - this.zeroPitch, -65, 65);
    // Deadzone 2.5 deg for steady hands
    const rollEff = Math.abs(dRoll) < 2.5 ? 0 : dRoll - Math.sign(dRoll) * 2.5;
    const pitchEff = Math.abs(dPitch) < 2.5 ? 0 : dPitch - Math.sign(dPitch) * 2.5;
    // Clockwise roll (+roll) or tilting nose up (+pitch) grows the grid cells
    const tiltContribution = ((rollEff * 0.0155) + (pitchEff * 0.0115)) * this.sensitivity;

    // 2. Lift (Raise Up / Lower Down) velocity-damped ZUPT integrator
    const LIFT_DEADZONE = 0.42; // m/s^2
    if (Math.abs(liftA) > LIFT_DEADZONE) {
      const eff = liftA - Math.sign(liftA) * LIFT_DEADZONE;
      this.velLift += clamp(eff, -18, 18) * dt;
      this.quietLiftMs = 0;
    } else {
      this.quietLiftMs += dt * 1000;
      const decayTau = this.quietLiftMs > 120 ? 0.07 : 0.22;
      this.velLift *= Math.exp(-dt / decayTau);
      if (Math.abs(this.velLift) < 0.015) this.velLift = 0;
    }
    this.velLift = clamp(this.velLift, -3.5, 3.5);

    // 3. Pull (Toward Self / Push Away) velocity-damped ZUPT integrator
    const PULL_DEADZONE = 0.45; // m/s^2
    if (Math.abs(pullA) > PULL_DEADZONE) {
      const eff = pullA - Math.sign(pullA) * PULL_DEADZONE;
      this.velPull += clamp(eff, -18, 18) * dt;
      this.quietPullMs = 0;
    } else {
      this.quietPullMs += dt * 1000;
      const decayTau = this.quietPullMs > 120 ? 0.07 : 0.22;
      this.velPull *= Math.exp(-dt / decayTau);
      if (Math.abs(this.velPull) < 0.015) this.velPull = 0;
    }
    this.velPull = clamp(this.velPull, -3.5, 3.5);

    // Combine according to active mode
    let nextScale = this.scale;
    if (this.mode === 'tilt') {
      nextScale = this.baseScale + tiltContribution;
    } else if (this.mode === 'lift') {
      this.impulseOffset += this.velLift * dt * 0.85 * this.sensitivity;
      nextScale = this.baseScale + this.impulseOffset;
    } else if (this.mode === 'pull') {
      this.impulseOffset += this.velPull * dt * 0.85 * this.sensitivity;
      nextScale = this.baseScale + this.impulseOffset;
    } else {
      // 'all': seamless fusion of tilt dial + vertical lift & depth pull impulses
      this.impulseOffset += (this.velLift * 0.62 + this.velPull * 0.55) * dt * this.sensitivity;
      this.impulseOffset = clamp(this.impulseOffset, -1.2, 1.4);
      nextScale = this.baseScale + tiltContribution + this.impulseOffset;
    }

    const clamped = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    // Anti-windup: if impulse pushed past bounds, keep impulseOffset tight to the bound
    if (clamped !== nextScale && this.mode !== 'tilt') {
      const overshot = nextScale - clamped;
      this.impulseOffset -= overshot;
    }

    this.scale = clamped;
    this.telemetry.scale = clamped;
    return this.telemetry;
  };

  /**
   * Critically damped spring-damper for silky 60fps desktop grid resizing.
   */
  function SpringDamper(initial, stiffness, damping) {
    this.value = Number.isFinite(initial) ? initial : DEFAULT_SCALE;
    this.target = this.value;
    this.velocity = 0;
    this.stiffness = typeof stiffness === 'number' ? stiffness : 180;
    this.damping = typeof damping === 'number' ? damping : 26;
  }

  SpringDamper.prototype.setTarget = function (t) {
    if (Number.isFinite(t)) this.target = t;
  };

  SpringDamper.prototype.snap = function (v) {
    if (!Number.isFinite(v)) return;
    this.value = v;
    this.target = v;
    this.velocity = 0;
  };

  SpringDamper.prototype.step = function (dtSec) {
    const dt = clamp(dtSec, 0.001, 0.05);
    const force = (this.target - this.value) * this.stiffness;
    const damp = this.velocity * this.damping;
    this.velocity += (force - damp) * dt;
    this.value += this.velocity * dt;

    if (Math.abs(this.target - this.value) < 0.0005 && Math.abs(this.velocity) < 0.001) {
      this.value = this.target;
      this.velocity = 0;
      return false; // settled
    }
    return true; // still moving
  };

  /**
   * Maps a normalized scale factor in [MIN_SCALE, MAX_SCALE] to an exact grid cell width
   * anchored around the grid's natural baseline 3-column cell width.
   */
  function scaleToCellWidth(scale, baseCellWidth, maxContainerWidth) {
    const base = clamp(baseCellWidth || 420, 180, 600);
    const maxW = Math.max(MIN_CELL_W, Math.min(MAX_CELL_W, maxContainerWidth || MAX_CELL_W));
    const raw = base * clamp(scale, MIN_SCALE, MAX_SCALE);
    return Math.round(clamp(raw, MIN_CELL_W, maxW));
  }

  return {
    MIN_SCALE: MIN_SCALE,
    MAX_SCALE: MAX_SCALE,
    DEFAULT_SCALE: DEFAULT_SCALE,
    MIN_CELL_W: MIN_CELL_W,
    MAX_CELL_W: MAX_CELL_W,
    clamp: clamp,
    lerp: lerp,
    GravityFilter: GravityFilter,
    gravityToTiltDeg: gravityToTiltDeg,
    MotionProcessor: MotionProcessor,
    SpringDamper: SpringDamper,
    scaleToCellWidth: scaleToCellWidth
  };
});
