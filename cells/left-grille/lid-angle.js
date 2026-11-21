/**
 * Secondary Grid Cell 06 — MacBook Lid Angle Sensor (`cells/left-grille/lid-angle.js`)
 *
 * Dual-mode lid hinge angle sensor (`0°–135°`) registered into `LeftGrilleLab` slot 6:
 *
 * 1. Mode A — Pure-Browser Acoustic Screen-Bounce Sonar (`18.2–20.4 kHz`):
 *    - Registers `'lid-ping'` TX generator on the shared 48 kHz acoustic bus (512-sample
 *      Hann-windowed linear FM chirp inside a 1024-sample period @ 44.1/48 kHz, scaled to
 *      2048 @ 88.2/96 kHz, on the upward-firing left channel so cross-keyboard right-speaker
 *      direct arrival at ~0.73 ms cannot masquerade as a lid bounce). Also passively
 *      piggybacks when `bus.getTxMode() === 'chirp'` using Cell 04's exact left-channel
 *      384/1024 (768/2048 @ 96 kHz) Hann-windowed cosine chirp (`18.00–19.15 kHz`).
 *    - Applies passband-restricted analytic Wiener deconvolution + exact sub-sample direct-path
 *      CLEAN subtraction to isolate early glass-lid specular reflections (`0.35–2.20 ms` lag,
 *      `~6–38 cm` bounce path), normalized to the direct-path peak so readings are invariant
 *      to speaker volume and microphone gain.
 *    - Fuses `(echoGainDb, peakLagMs)` into a monotonic `reflectionIndex`, maps through a
 *      2-point linear calibration (`[Set Open 110°]` / `[Set Low 50°]`, persisted in
 *      `localStorage['dwg.lidAngleCal.v1']`), and smooths with a 1D adaptive Kalman filter.
 *
 * 2. Mode B — Optional Exact Hardware IOHIDManager Bridge (`cells/left-grille/lid-bridge.mjs`):
 *    - Quietly probes `http://127.0.0.1:8793/angle` (600 ms timeout) when Cell 05 is open
 *      (`lg-secondary-open` / `#left-grille`) or on `[HID]` click, never eagerly on the
 *      hidden main grid. When live, streams exact `0.1°` Apple `LidAngleSensor`
 *      (`0x05AC:0x8104`, UsagePage `0x0020`, Usage `0x008A`) readings over SSE `/events`.
 *
 * 3. Interactive Hinge Drag Fallback:
 *    - Side-elevation MacBook Pro hinge SVG (`0°–135°`) with pointer-drag & keyboard slider
 *      scrubbing directly on the pivoting display lid.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.LeftGrilleLidAngle = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Acoustic Sonar Constants
  const CHIRP_PERIOD = 1024;
  const CHIRP_ACTIVE_LEN = 512;
  const CHIRP_PIGGYBACK_ACTIVE_LEN = 384; // Matches Cell 04 StereoChirpGenerator (384 / 1024 duty)
  const CHIRP_PIGGYBACK_F0_HZ = 18000;
  const CHIRP_PIGGYBACK_F1_HZ = 19150;
  const CHIRP_PIGGYBACK_TX_GAIN = 0.04;
  const F_START_HZ = 18200;
  const F_END_HZ = 20400;
  const CHIRP_GAIN = 0.052;
  const MIN_ULTRASONIC_SR = 40000;
  const LAG_MIN_MS = 0.35;
  const LAG_MAX_MS = 2.20;
  const SPEED_OF_SOUND_CMS = 34300;

  // Calibration & Range Constants
  const STORAGE_KEY = 'dwg.lidAngleCal.v1';
  const ANGLE_MIN_SONAR = 25;
  const ANGLE_MAX_SONAR = 135;
  const ANGLE_MIN_UI = 0;
  const ANGLE_MAX_UI = 135;
  const DEFAULT_OPEN_ANGLE = 110;
  const DEFAULT_LOW_ANGLE = 50;
  // Default reflectionIndex anchors matching Wiener-CLEAN normalized screen bounce:
  // ~110° open => echoGainDb ~ -23.0 dB, peakLagMs ~ 1.55 ms => reflectionIndex ~ -17.57
  // ~50° low   => echoGainDb ~ -11.0 dB, peakLagMs ~ 0.68 ms => reflectionIndex ~ -6.98
  const DEFAULT_OPEN_REF_INDEX = -17.6;
  const DEFAULT_LOW_REF_INDEX = -7.0;
  const MIN_CALIBRATION_SPAN = 1.0;

  // Hardware Bridge Defaults
  const BRIDGE_ORIGIN = 'http://127.0.0.1:8793';
  const BRIDGE_PROBE_TIMEOUT_MS = 600;

  // Tooltip copy (ui/NOTES.md section 4). The status pill and both header buttons follow state.
  const SONAR_TIP_OFF = 'Play inaudible 18–20 kHz pings and time their screen echo to estimate the angle.';
  const SONAR_TIP_ON = 'Sonar is on. Click to stop the pings, and the mic if Sonar turned it on.';
  const SONAR_TIP_CHIRP = 'Reading the angle from Chirp sonar’s tones. Click to use this sensor’s own pings.';
  const SONAR_TIP_ARMING = 'Waiting for microphone access.';
  const HID_TIP_OFF = 'Read the exact hinge angle from the lid bridge on this Mac (127.0.0.1:8793).';
  const HID_TIP_ON = 'The hinge angle is streaming from the lid bridge. Click to disconnect.';
  const PILL_TIPS = {
    idle: 'No sensor is running. Start Sonar or HID, or drag the lid to simulate.',
    hid: 'Live: the exact hinge angle comes from the lid bridge on this Mac.',
    sonar: 'Live: the angle is estimated from inaudible echoes off the screen.',
    noEcho: 'Sonar is on but hears no screen echo yet, so the angle is not measured.',
    drag: 'Simulated: the angle follows your drag, not a sensor.'
  };

  // SVG Side-Elevation Geometry (`viewBox="0 0 212 134"`)
  const SVG_HX = 86;
  const SVG_HY = 112;
  const SVG_LID_LEN = 90;
  const SVG_ARC_R = 62;

  function clamp(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  /**
   * In-place Cooley-Tukey radix-2 FFT / IFFT.
   * `re` and `im` must have identical power-of-2 length.
   */
  function fftRadix2(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    const dir = inverse ? 2 : -2;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const ang = (dir * Math.PI) / len;
      const wRe = Math.cos(ang);
      const wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curRe = 1;
        let curIm = 0;
        for (let j = 0; j < half; j++) {
          const idx1 = i + j;
          const idx2 = idx1 + half;
          const uRe = re[idx1];
          const uIm = im[idx1];
          const vRe = re[idx2] * curRe - im[idx2] * curIm;
          const vIm = re[idx2] * curIm + im[idx2] * curRe;
          re[idx1] = uRe + vRe;
          im[idx1] = uIm + vIm;
          re[idx2] = uRe - vRe;
          im[idx2] = uIm - vIm;
          const nextRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = nextRe;
        }
      }
    }
    if (inverse) {
      const invN = 1 / n;
      for (let i = 0; i < n; i++) {
        re[i] *= invN;
        im[i] *= invN;
      }
    }
  }

  function computePeriodForSampleRate(sampleRate) {
    if (!Number.isFinite(sampleRate) || sampleRate < 80000) return CHIRP_PERIOD;
    if (sampleRate < 160000) return CHIRP_PERIOD * 2;
    return CHIRP_PERIOD * 4;
  }

  /**
   * Builds one period template (`1024` @ 44.1/48 kHz, `2048` @ 88.2/96 kHz) of the
   * `18.2–20.4 kHz` Hann-windowed upward-chirp ping (50% active burst + 50% listen guard).
   */
  function buildLidPingWaveform(sampleRate = 48000, opts = {}) {
    const period = opts.period || computePeriodForSampleRate(sampleRate);
    const defaultActiveLen = Math.round((period * CHIRP_ACTIVE_LEN) / CHIRP_PERIOD);
    const activeLen = Math.min(period, opts.activeLen || defaultActiveLen);
    const f0 = opts.f0 !== undefined ? opts.f0 : F_START_HZ;
    const f1 = opts.f1 !== undefined ? opts.f1 : F_END_HZ;
    const gain = opts.gain !== undefined ? opts.gain : 1.0;
    const out = new Float32Array(period);

    if (!Number.isFinite(sampleRate) || sampleRate < MIN_ULTRASONIC_SR) {
      return out;
    }

    const durSec = activeLen / sampleRate;
    const df = f1 - f0;
    const denom = Math.max(1, activeLen - 1);
    for (let n = 0; n < activeLen; n++) {
      const t = n / sampleRate;
      const win = 0.5 * (1 - Math.cos((2 * Math.PI * n) / denom));
      const phase = 2 * Math.PI * (f0 * t + (0.5 * df * t * t) / durSec);
      out[n] = gain * win * Math.sin(phase);
    }
    return out;
  }

  /**
   * Builds the exact Cell 04 (`StereoChirpGenerator`) left-channel `18.00–19.15 kHz`
   * Hann-windowed cosine chirp (`384/1024` duty: `384` active inside `1024` @ 44.1/48 kHz,
   * `768` active inside `2048` @ 88.2/96 kHz) for passively piggybacking on `'chirp'` TX.
   */
  function buildChirpPiggybackWaveform(sampleRate = 48000, opts = {}) {
    const period = opts.period || computePeriodForSampleRate(sampleRate);
    const defaultActiveLen = Math.round((period * CHIRP_PIGGYBACK_ACTIVE_LEN) / CHIRP_PERIOD);
    const activeLen = Math.min(period, opts.activeLen || defaultActiveLen);
    const f0 = opts.f0 !== undefined ? opts.f0 : CHIRP_PIGGYBACK_F0_HZ;
    const f1 = opts.f1 !== undefined ? opts.f1 : CHIRP_PIGGYBACK_F1_HZ;
    const gain = opts.gain !== undefined ? opts.gain : 1.0;
    const out = new Float32Array(period);
    if (!Number.isFinite(sampleRate) || sampleRate < MIN_ULTRASONIC_SR) return out;
    const durSec = activeLen / sampleRate;
    const sweepRate = (f1 - f0) / durSec;
    const denom = Math.max(1, activeLen - 1);
    for (let n = 0; n < activeLen; n++) {
      const t = n / sampleRate;
      const win = 0.5 * (1 - Math.cos((2 * Math.PI * n) / denom));
      const phase = 2 * Math.PI * (f0 * t + 0.5 * sweepRate * t * t);
      out[n] = gain * win * Math.cos(phase);
    }
    return out;
  }

  // Per-sample-rate cached TX waveform table for zero-allocation audio-callback filling
  const _txCache = new Map();

  function getCachedLidPing(sampleRate) {
    const key = Math.round(sampleRate || 0);
    let buf = _txCache.get(key);
    if (!buf) {
      buf = buildLidPingWaveform(sampleRate, { gain: CHIRP_GAIN });
      if (_txCache.size > 8) _txCache.clear();
      _txCache.set(key, buf);
    }
    return buf;
  }

  /**
   * Shared-bus TX generator registered under `'lid-ping'`.
   * Drives the upward-firing left tweeter (`leftOut`) cleanly and silences `rightOut`
   * so cross-keyboard right-speaker direct travel (~0.73 ms) never creates a false screen bounce.
   * Forces total silence whenever `sampleRate < 40000` (Bluetooth HFP safety).
   */
  function generateLidPingBlock(leftOut, rightOut, sampleRate, sampleOffset) {
    const len = leftOut ? leftOut.length : rightOut ? rightOut.length : 0;
    if (!len) return;
    if (!Number.isFinite(sampleRate) || sampleRate < MIN_ULTRASONIC_SR) {
      if (leftOut) leftOut.fill(0);
      if (rightOut) rightOut.fill(0);
      return;
    }
    const table = getCachedLidPing(sampleRate);
    const period = table.length;
    const base = (((sampleOffset || 0) % period) + period) % period;
    for (let i = 0; i < len; i++) {
      const s = table[(base + i) % period];
      if (leftOut) leftOut[i] = s;
      if (rightOut) rightOut[i] = 0;
    }
  }

  /**
   * Combines early screen-reflection energy (`echoGainDb`) and peak/centroid bounce delay
   * (`lagMs`) into a monotonic acoustic closeness index (higher = lid closer to keyboard).
   */
  function computeReflectionIndex(echoGainDb, lagMs) {
    const gDb = clamp(Number.isFinite(echoGainDb) ? echoGainDb : -30, -45, 6);
    const lMs = clamp(Number.isFinite(lagMs) ? lagMs : 1.35, LAG_MIN_MS, LAG_MAX_MS);
    const lagCueDb = (1.10 - lMs) * 8.0;
    return 0.72 * gDb + 0.28 * lagCueDb;
  }

  /**
   * 2-point linear calibration store & mapper (`[Set Open 110°]` & `[Set Low 50°]`),
   * persisted to `localStorage['dwg.lidAngleCal.v1']`.
   */
  class LidCalibration {
    constructor(initial = null) {
      this.openAngleDeg = DEFAULT_OPEN_ANGLE;
      this.lowAngleDeg = DEFAULT_LOW_ANGLE;
      this.openRefIndex = DEFAULT_OPEN_REF_INDEX;
      this.lowRefIndex = DEFAULT_LOW_REF_INDEX;
      this.openCalibrated = false;
      this.lowCalibrated = false;
      this.updatedAt = 0;
      if (initial) this.apply(initial);
    }

    static sanitize(raw) {
      if (!raw || typeof raw !== 'object') return null;
      const openAngleDeg = Number.isFinite(raw.openAngleDeg)
        ? clamp(raw.openAngleDeg, 70, 135)
        : DEFAULT_OPEN_ANGLE;
      const lowAngleDeg = Number.isFinite(raw.lowAngleDeg)
        ? clamp(raw.lowAngleDeg, 25, 85)
        : DEFAULT_LOW_ANGLE;
      if (openAngleDeg - lowAngleDeg < 15) return null;

      const openRefIndex = Number(raw.openRefIndex);
      const lowRefIndex = Number(raw.lowRefIndex);
      if (!Number.isFinite(openRefIndex) || !Number.isFinite(lowRefIndex)) return null;
      if (lowRefIndex - openRefIndex < MIN_CALIBRATION_SPAN) return null;

      return {
        version: 1,
        openAngleDeg,
        lowAngleDeg,
        openRefIndex,
        lowRefIndex,
        openCalibrated: Boolean(raw.openCalibrated),
        lowCalibrated: Boolean(raw.lowCalibrated),
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
      };
    }

    static load(storage) {
      try {
        // Reading the `localStorage` global itself throws (SecurityError) when site data is blocked.
        const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
        if (!store) return new LidCalibration();
        const raw = store.getItem(STORAGE_KEY);
        if (!raw) return new LidCalibration();
        const parsed = LidCalibration.sanitize(JSON.parse(raw));
        return parsed ? new LidCalibration(parsed) : new LidCalibration();
      } catch (_) {
        return new LidCalibration();
      }
    }

    apply(data) {
      const clean = LidCalibration.sanitize(data);
      if (!clean) return false;
      this.openAngleDeg = clean.openAngleDeg;
      this.lowAngleDeg = clean.lowAngleDeg;
      this.openRefIndex = clean.openRefIndex;
      this.lowRefIndex = clean.lowRefIndex;
      this.openCalibrated = clean.openCalibrated;
      this.lowCalibrated = clean.lowCalibrated;
      this.updatedAt = clean.updatedAt;
      return true;
    }

    toJSON() {
      return {
        version: 1,
        openAngleDeg: this.openAngleDeg,
        lowAngleDeg: this.lowAngleDeg,
        openRefIndex: this.openRefIndex,
        lowRefIndex: this.lowRefIndex,
        openCalibrated: this.openCalibrated,
        lowCalibrated: this.lowCalibrated,
        updatedAt: this.updatedAt
      };
    }

    save(storage) {
      try {
        const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
        if (!store) return;
        if (!this.openCalibrated && !this.lowCalibrated) {
          store.removeItem(STORAGE_KEY);
        } else {
          store.setItem(STORAGE_KEY, JSON.stringify(this.toJSON()));
        }
      } catch (_) {}
    }

    reset(storage) {
      this.openAngleDeg = DEFAULT_OPEN_ANGLE;
      this.lowAngleDeg = DEFAULT_LOW_ANGLE;
      this.openRefIndex = DEFAULT_OPEN_REF_INDEX;
      this.lowRefIndex = DEFAULT_LOW_REF_INDEX;
      this.openCalibrated = false;
      this.lowCalibrated = false;
      this.updatedAt = 0;
      this.save(storage);
      return this.toJSON();
    }

    /**
     * Captures the `[Set Open 110°]` anchor.
     * - If `[Set Low 50°]` is already calibrated, validates `lowRefIndex - idx >= 1.0`.
     * - If only Open is being calibrated, preserves the existing slope span so 1-point
     *   offset alignment works immediately without distorting scale.
     */
    setOpenAnchor(refIndex, storage) {
      if (!Number.isFinite(refIndex)) {
        return { ok: false, reason: 'Invalid acoustic reflection sample.' };
      }
      if (this.lowCalibrated) {
        if (this.lowRefIndex - refIndex < MIN_CALIBRATION_SPAN) {
          return {
            ok: false,
            reason: 'Open echo must be weaker than 50° anchor — tilt lid wider and retry.'
          };
        }
        this.openRefIndex = refIndex;
      } else {
        const span = Math.max(4.0, this.lowRefIndex - this.openRefIndex);
        this.openRefIndex = refIndex;
        this.lowRefIndex = refIndex + span;
      }
      this.openCalibrated = true;
      this.updatedAt = Date.now();
      this.save(storage);
      return { ok: true, calibration: this.toJSON() };
    }

    /**
     * Captures the `[Set Low 50°]` anchor.
     * - If `[Set Open 110°]` is already calibrated, validates `idx - openRefIndex >= 1.0`.
     * - If only Low is being calibrated, preserves the existing slope span.
     */
    setLowAnchor(refIndex, storage) {
      if (!Number.isFinite(refIndex)) {
        return { ok: false, reason: 'Invalid acoustic reflection sample.' };
      }
      if (this.openCalibrated) {
        if (refIndex - this.openRefIndex < MIN_CALIBRATION_SPAN) {
          return {
            ok: false,
            reason: '50° echo must be stronger than 110° anchor — close lid further and retry.'
          };
        }
        this.lowRefIndex = refIndex;
      } else {
        const span = Math.max(4.0, this.lowRefIndex - this.openRefIndex);
        this.lowRefIndex = refIndex;
        this.openRefIndex = refIndex - span;
      }
      this.lowCalibrated = true;
      this.updatedAt = Date.now();
      this.save(storage);
      return { ok: true, calibration: this.toJSON() };
    }

    /**
     * Maps `reflectionIndex` smoothly to estimated lid angle in `[25°, 135°]`.
     */
    mapToAngleDeg(refIndex) {
      if (!Number.isFinite(refIndex)) return DEFAULT_OPEN_ANGLE;
      const denom = Math.max(MIN_CALIBRATION_SPAN, this.lowRefIndex - this.openRefIndex);
      const t = (this.lowRefIndex - refIndex) / denom;
      const raw = this.lowAngleDeg + t * (this.openAngleDeg - this.lowAngleDeg);
      return clamp(raw, ANGLE_MIN_SONAR, ANGLE_MAX_SONAR);
    }

    get isCalibrated() {
      return this.openCalibrated || this.lowCalibrated;
    }
  }

  /**
   * Lightweight 1D constant-velocity Kalman filter for smooth, lag-free hinge tracking.
   */
  class LidAngleKalman {
    constructor(opts = {}) {
      this.angle = Number.isFinite(opts.initialAngle) ? opts.initialAngle : 108;
      this.vel = 0;
      this.p00 = 25.0;
      this.p01 = 0;
      this.p11 = 16.0;
      this.processAccelVar = Number.isFinite(opts.processAccelVar) ? opts.processAccelVar : 420.0;
      this.baseMeasVar = Number.isFinite(opts.baseMeasVar) ? opts.baseMeasVar : 18.0;
      this.initialized = Boolean(opts.initialized);
    }

    reset(angleDeg = 108) {
      this.angle = clamp(angleDeg, ANGLE_MIN_UI, ANGLE_MAX_UI);
      this.vel = 0;
      this.p00 = 9.0;
      this.p01 = 0;
      this.p11 = 8.0;
      this.initialized = true;
      return this.angle;
    }

    update(measuredDeg, dtSec = 0.02133, confidence = 1.0) {
      if (!Number.isFinite(measuredDeg)) return this.angle;
      const z = clamp(measuredDeg, ANGLE_MIN_UI, ANGLE_MAX_UI);
      if (!this.initialized) {
        return this.reset(z);
      }

      const dt = clamp(dtSec, 0.005, 0.25);
      // Predict
      const predAngle = clamp(this.angle + this.vel * dt, ANGLE_MIN_UI, ANGLE_MAX_UI);
      const predVel = this.vel * Math.exp(-dt * 4.5); // gentle velocity damping at rest

      const dt2 = dt * dt;
      const dt3 = dt2 * dt;
      const dt4 = dt2 * dt2;
      const q = this.processAccelVar;

      const p00 = this.p00 + 2 * dt * this.p01 + dt2 * this.p11 + 0.25 * dt4 * q;
      const p01 = this.p01 + dt * this.p11 + 0.5 * dt3 * q;
      const p11 = this.p11 + dt2 * q;

      // Measurement variance inversely weighted by acoustic SNR confidence
      const conf = clamp(confidence, 0.12, 1.0);
      const R = this.baseMeasVar / (conf * conf);
      const S = p00 + R;
      const k0 = p00 / S;
      const k1 = p01 / S;
      const innov = z - predAngle;

      this.angle = clamp(predAngle + k0 * innov, ANGLE_MIN_UI, ANGLE_MAX_UI);
      this.vel = clamp(predVel + k1 * innov, -220, 220);

      this.p00 = (1 - k0) * p00;
      this.p01 = (1 - k0) * p01;
      this.p11 = Math.max(0.05, p11 - k1 * p01);
      return this.angle;
    }
  }

  /**
   * Core acoustic screen-bounce sonar estimator (`Mode A`).
   * Consumes streaming audio blocks (any chunk size, typically 512 samples) or single
   * 1024-sample frames and outputs live lid reflection & angle telemetry.
   */
  class LidSonarEstimator {
    constructor(opts = {}) {
      this.sampleRate = opts.sampleRate || 48000;
      this.period = computePeriodForSampleRate(this.sampleRate);
      this.activeTxMode = opts.txMode === 'chirp' ? 'chirp' : 'lid-ping';
      this.calibration =
        opts.calibration instanceof LidCalibration
          ? opts.calibration
          : new LidCalibration(opts.calibration || null);
      this.kalman = new LidAngleKalman(opts.kalman || {});

      // Smoothed acoustic metrics for rock-solid calibration snapshots
      this._emaEchoGainDb = null;
      this._emaPeakLagMs = null;
      this._emaRefIndex = null;
      this._lastEstimate = null;

      this._allocateBuffers(this.period);
      this._buildFilterTables(this.sampleRate, this.activeTxMode);
    }

    _allocateBuffers(period) {
      this.period = period;
      this._stageBuf = new Float32Array(period);
      this._stageFill = 0;
      // Reusable FFT scratch buffers (zero per-frame allocations)
      this._rRe = new Float64Array(period);
      this._rIm = new Float64Array(period);
      this._hRe = new Float64Array(period);
      this._hIm = new Float64Array(period);
      this._tRe = new Float64Array(period);
      this._tIm = new Float64Array(period);
      this._eRe = new Float64Array(period);
      this._eIm = new Float64Array(period);
    }

    _buildFilterTables(sampleRate, txMode) {
      const nextPeriod = computePeriodForSampleRate(sampleRate);
      if (nextPeriod !== this.period || !this._stageBuf || this._stageBuf.length !== nextPeriod) {
        this._allocateBuffers(nextPeriod);
      }
      const N = this.period;
      this.sampleRate = sampleRate;
      this.activeTxMode = txMode === 'chirp' ? 'chirp' : 'lid-ping';
      this.supported = Number.isFinite(sampleRate) && sampleRate >= MIN_ULTRASONIC_SR;

      this._filtRe = new Float64Array(N);
      this._filtIm = new Float64Array(N);
      this._psfSpec = new Float64Array(N);
      this._psf0 = 1;
      this._bLo = 0;
      this._bHi = 0;

      if (!this.supported) return;

      const ref =
        this.activeTxMode === 'chirp'
          ? buildChirpPiggybackWaveform(sampleRate, { period: N, gain: 1.0 })
          : buildLidPingWaveform(sampleRate, { period: N, gain: 1.0 });

      const txRe = new Float64Array(N);
      const txIm = new Float64Array(N);
      for (let i = 0; i < N; i++) txRe[i] = ref[i];
      fftRadix2(txRe, txIm, false);

      const isChirpPiggyback = this.activeTxMode === 'chirp';
      const fLo = isChirpPiggyback ? 17650 : 17900;
      const fHi = isChirpPiggyback ? 19300 : 20700;
      const nyqBin = (N >> 1) - 1;
      const bLo = clamp(Math.floor((fLo * N) / sampleRate), 2, nyqBin - 4);
      const bHi = clamp(Math.ceil((fHi * N) / sampleRate), bLo + 4, nyqBin);
      this._bLo = bLo;
      this._bHi = bHi;

      let maxPow = 0;
      for (let b = bLo; b <= bHi; b++) {
        const p = txRe[b] * txRe[b] + txIm[b] * txIm[b];
        if (p > maxPow) maxPow = p;
      }
      // Narrower 1.15 kHz Cell 04 left chirp uses lighter Wiener regularization & taper
      // to preserve sharp sub-millisecond early-bounce separation while staying below 19.35 kHz R band.
      const reg = Math.max(1e-12, maxPow * (isChirpPiggyback ? 0.006 : 0.03));
      const span = Math.max(1, bHi - bLo);
      const tukeyAlpha = isChirpPiggyback ? 0.2 : 0.35;
      let psf0 = 0;

      for (let b = bLo; b <= bHi; b++) {
        const u = (b - bLo) / span;
        let tw = 1;
        if (u < tukeyAlpha * 0.5) {
          tw = 0.5 * (1 - Math.cos((2 * Math.PI * u) / tukeyAlpha));
        } else if (u > 1 - tukeyAlpha * 0.5) {
          tw = 0.5 * (1 - Math.cos((2 * Math.PI * (1 - u)) / tukeyAlpha));
        }
        const p = txRe[b] * txRe[b] + txIm[b] * txIm[b];
        const denom = p + reg;
        const scale = (2 * tw) / denom;
        this._filtRe[b] = txRe[b] * scale;
        this._filtIm[b] = -txIm[b] * scale;
        this._psfSpec[b] = (2 * tw * p) / denom;
        psf0 += this._psfSpec[b];
      }
      this._psf0 = Math.max(1e-9, psf0);
    }

    resetState(angleDeg) {
      this._stageFill = 0;
      this._emaEchoGainDb = null;
      this._emaPeakLagMs = null;
      this._emaRefIndex = null;
      if (Number.isFinite(angleDeg)) {
        this.kalman.reset(angleDeg);
      } else {
        this.kalman.initialized = false;
      }
    }

    /**
     * Feeds an arbitrary-length audio chunk (e.g., 512 samples from SharedAcousticBus)
     * and returns an array of frame estimates whenever a 1024-sample period completes.
     */
    pushSamples(samples, sampleRate, txMode = 'lid-ping') {
      const results = [];
      if (!samples || !samples.length) return results;
      const mode = txMode === 'chirp' ? 'chirp' : 'lid-ping';
      if (sampleRate !== this.sampleRate || mode !== this.activeTxMode) {
        this._buildFilterTables(sampleRate, mode);
        this._stageFill = 0;
      }

      let offset = 0;
      while (offset < samples.length) {
        const take = Math.min(this.period - this._stageFill, samples.length - offset);
        for (let i = 0; i < take; i++) {
          const s = samples[offset + i];
          this._stageBuf[this._stageFill + i] = Number.isFinite(s) ? s : 0;
        }
        this._stageFill += take;
        offset += take;
        if (this._stageFill === this.period) {
          this._stageFill = 0;
          results.push(this.processFrame(this._stageBuf, sampleRate, mode));
        }
      }
      return results;
    }

    /**
     * Analyzes one exact period-length frame (`1024` @ 44.1/48 kHz, `2048` @ 88.2/96 kHz)
     * via passband Wiener deconvolution + sub-sample direct-path CLEAN subtraction.
     */
    processFrame(frame, sampleRate = this.sampleRate, txMode = this.activeTxMode) {
      const mode = txMode === 'chirp' ? 'chirp' : 'lid-ping';
      if (sampleRate !== this.sampleRate || mode !== this.activeTxMode) {
        this._buildFilterTables(sampleRate, mode);
      }

      if (!this.supported) {
        return {
          signalPresent: false,
          unsupportedRate: true,
          txMode: mode,
          angleDeg: this.kalman.angle,
          rawAngleDeg: this.kalman.angle,
          echoGainDb: -40,
          peakLagMs: 1.5,
          centroidLagMs: 1.5,
          reflectionIndex: DEFAULT_OPEN_REF_INDEX,
          directSnrDb: 0,
          confidence: 0
        };
      }

      const N = this.period;
      const rRe = this._rRe;
      const rIm = this._rIm;
      const frameLen = frame ? frame.length : 0;
      for (let i = 0; i < N; i++) {
        const v = i < frameLen ? frame[i] : 0;
        rRe[i] = Number.isFinite(v) ? v : 0;
        rIm[i] = 0;
      }
      fftRadix2(rRe, rIm, false);

      const hRe = this._hRe;
      const hIm = this._hIm;
      const tRe = this._tRe;
      const tIm = this._tIm;
      hRe.fill(0);
      hIm.fill(0);
      tRe.fill(0);
      tIm.fill(0);

      const bLo = this._bLo;
      const bHi = this._bHi;
      const filtRe = this._filtRe;
      const filtIm = this._filtIm;

      for (let b = bLo; b <= bHi; b++) {
        const vr = rRe[b] * filtRe[b] - rIm[b] * filtIm[b];
        const vi = rRe[b] * filtIm[b] + rIm[b] * filtRe[b];
        hRe[b] = vr;
        hIm[b] = vi;
        tRe[b] = vr;
        tIm[b] = vi;
      }
      fftRadix2(tRe, tIm, true);

      // 1. Locate direct speaker-to-mic peak `k0` (invariant to OS audio loopback latency)
      let k0 = 0;
      let maxMag = 0;
      for (let k = 0; k < N; k++) {
        const m = Math.hypot(tRe[k], tIm[k]);
        if (m > maxMag) {
          maxMag = m;
          k0 = k;
        }
      }

      // Compute far-lag noise floor (5 ms .. 10 ms away from direct path) for SNR gating
      const noiseLo = Math.min(N >> 1, Math.round(0.005 * sampleRate));
      const noiseHi = Math.min(N - 16, Math.round(0.010 * sampleRate));
      let noiseSq = 0;
      let noiseCount = 0;
      for (let d = noiseLo; d <= noiseHi; d++) {
        const idx = (k0 + d) % N;
        const m = Math.hypot(tRe[idx], tIm[idx]);
        noiseSq += m * m;
        noiseCount++;
      }
      const noiseRms = Math.sqrt(noiseSq / Math.max(1, noiseCount));
      const directSnrDb = 20 * Math.log10(Math.max(1e-9, maxMag) / Math.max(1e-9, noiseRms));

      if (maxMag < 1e-6 || directSnrDb < 7.0) {
        return {
          signalPresent: false,
          unsupportedRate: false,
          txMode: mode,
          angleDeg: this.kalman.angle,
          rawAngleDeg: this.kalman.angle,
          echoGainDb: this._emaEchoGainDb !== null ? this._emaEchoGainDb : -30,
          peakLagMs: this._emaPeakLagMs !== null ? this._emaPeakLagMs : 1.5,
          centroidLagMs: this._emaPeakLagMs !== null ? this._emaPeakLagMs : 1.5,
          reflectionIndex: this._emaRefIndex !== null ? this._emaRefIndex : DEFAULT_OPEN_REF_INDEX,
          directSnrDb,
          confidence: 0
        };
      }

      // 2. Sub-sample log-parabolic peak refinement around k0
      const kPrev = (k0 - 1 + N) % N;
      const kNext = (k0 + 1) % N;
      const mL = Math.log(Math.max(1e-12, Math.hypot(tRe[kPrev], tIm[kPrev])));
      const mC = Math.log(Math.max(1e-12, maxMag));
      const mR = Math.log(Math.max(1e-12, Math.hypot(tRe[kNext], tIm[kNext])));
      const parDen = mL - 2 * mC + mR;
      const delta = Math.abs(parDen) > 1e-9 ? clamp((0.5 * (mL - mR)) / parDen, -0.5, 0.5) : 0;
      const tau0 = k0 + delta;

      // 3. Shift passband spectrum to exact direct-path alignment & subtract direct-path PSF
      const eRe = this._eRe;
      const eIm = this._eIm;
      eRe.fill(0);
      eIm.fill(0);
      let sumRe = 0;
      let sumIm = 0;
      const twoPiTauOverN = (2 * Math.PI * tau0) / N;

      for (let b = bLo; b <= bHi; b++) {
        const ang = b * twoPiTauOverN;
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const ar = hRe[b] * c - hIm[b] * s;
        const ai = hRe[b] * s + hIm[b] * c;
        eRe[b] = ar;
        eIm[b] = ai;
        sumRe += ar;
        sumIm += ai;
      }

      const a0Re = sumRe / this._psf0;
      const a0Im = sumIm / this._psf0;
      const directMag = Math.max(1e-9, Math.hypot(sumRe, sumIm) / N);
      const psfSpec = this._psfSpec;

      for (let b = bLo; b <= bHi; b++) {
        eRe[b] -= a0Re * psfSpec[b];
        eIm[b] -= a0Im * psfSpec[b];
      }
      fftRadix2(eRe, eIm, true);

      // 4. Measure early screen-reflection window (lag 0.35 ms .. 2.20 ms)
      const lagLo = Math.max(2, Math.round((LAG_MIN_MS * sampleRate) / 1000));
      const lagHi = Math.min((N >> 1) - 4, Math.round((LAG_MAX_MS * sampleRate) / 1000));

      let peakMag = 0;
      let peakK = lagLo;
      let sqSum = 0;
      let count = 0;
      for (let k = lagLo; k <= lagHi; k++) {
        const m = Math.hypot(eRe[k], eIm[k]);
        sqSum += m * m;
        count++;
        if (m > peakMag) {
          peakMag = m;
          peakK = k;
        }
      }

      // Parabolic sub-sample peak lag inside screen-bounce window
      let peakLagSamp = peakK;
      if (peakK > lagLo && peakK < lagHi && peakMag > 1e-9) {
        const pL = Math.hypot(eRe[peakK - 1], eIm[peakK - 1]);
        const pR = Math.hypot(eRe[peakK + 1], eIm[peakK + 1]);
        const d = pL - 2 * peakMag + pR;
        if (Math.abs(d) > 1e-12) {
          peakLagSamp = peakK + clamp((0.5 * (pL - pR)) / d, -0.5, 0.5);
        }
      }

      // Energy-weighted centroid lag across bins >= 45% of peak (smooth against multipath split)
      let wSum = 0;
      let kWSum = 0;
      const thresh = peakMag * 0.45;
      for (let k = lagLo; k <= lagHi; k++) {
        const m = Math.hypot(eRe[k], eIm[k]);
        if (m >= thresh) {
          const w = m * m;
          wSum += w;
          kWSum += w * k;
        }
      }
      const centroidSamp = wSum > 0 ? kWSum / wSum : peakLagSamp;

      const rmsMag = Math.sqrt(sqSum / Math.max(1, count));
      const combinedEcho = 0.65 * peakMag + 0.35 * rmsMag;
      const echoGainDb = clamp(20 * Math.log10(Math.max(1e-6, combinedEcho / directMag)), -45, 6);
      const peakLagMs = clamp((peakLagSamp / sampleRate) * 1000, LAG_MIN_MS, LAG_MAX_MS);
      const centroidLagMs = clamp((centroidSamp / sampleRate) * 1000, LAG_MIN_MS, LAG_MAX_MS);
      const effectiveLagMs = 0.65 * peakLagMs + 0.35 * centroidLagMs;
      const reflectionIndex = computeReflectionIndex(echoGainDb, effectiveLagMs);

      // Smooth acoustic features for calibration capture stability
      const alphaFeat = 0.28;
      this._emaEchoGainDb =
        this._emaEchoGainDb === null
          ? echoGainDb
          : this._emaEchoGainDb + alphaFeat * (echoGainDb - this._emaEchoGainDb);
      this._emaPeakLagMs =
        this._emaPeakLagMs === null
          ? peakLagMs
          : this._emaPeakLagMs + alphaFeat * (peakLagMs - this._emaPeakLagMs);
      this._emaRefIndex =
        this._emaRefIndex === null
          ? reflectionIndex
          : this._emaRefIndex + alphaFeat * (reflectionIndex - this._emaRefIndex);

      const confidence = clamp((directSnrDb - 7.0) / 22.0, 0.15, 1.0);
      const rawAngleDeg = this.calibration.mapToAngleDeg(reflectionIndex);
      const dtSec = N / sampleRate;
      const angleDeg = this.kalman.update(rawAngleDeg, dtSec, confidence);

      const out = {
        signalPresent: true,
        unsupportedRate: false,
        txMode: mode,
        angleDeg,
        rawAngleDeg,
        echoGainDb,
        smoothEchoGainDb: this._emaEchoGainDb,
        peakLagMs,
        smoothPeakLagMs: this._emaPeakLagMs,
        centroidLagMs,
        bouncePathCm: (peakLagMs / 1000) * SPEED_OF_SOUND_CMS * 0.5,
        reflectionIndex,
        smoothReflectionIndex: this._emaRefIndex,
        directSnrDb,
        confidence
      };
      this._lastEstimate = out;
      return out;
    }

    getLastEstimate() {
      return this._lastEstimate;
    }
  }

  /**
   * Deterministic physical MacBook glass-lid reflection synthesizer for unit tests & verification.
   * Models direct speaker-to-mic arrival at fractional latency `directDelaySamples` plus specular
   * screen-bounce reflection whose amplitude grows monotonically and lag shortens as `angleDeg`
   * closes from `135°` toward `25°`.
   */
  function synthesizeScreenBounceFrame(opts = {}) {
    const sampleRate = opts.sampleRate || 48000;
    const angleDeg = clamp(opts.angleDeg !== undefined ? opts.angleDeg : 90, 25, 135);
    const txMode = opts.txMode === 'chirp' ? 'chirp' : 'lid-ping';
    const directDelaySamples =
      opts.directDelaySamples !== undefined ? opts.directDelaySamples : 137.4;
    const directGain = opts.directGain !== undefined ? opts.directGain : 0.42;
    const noiseStd = opts.noiseStd !== undefined ? opts.noiseStd : 0.0004;
    const echoPolarity = opts.echoPolarity !== undefined ? opts.echoPolarity : 1;

    // Monotonic physical clamshell reflection model (25°..135°):
    // 35° => echoRel ~ 0.48 (-6.4 dB), lag ~ 0.52 ms (~9 cm one-way bounce)
    // 75° => echoRel ~ 0.19 (-14.4 dB), lag ~ 1.04 ms (~18 cm)
    // 120° => echoRel ~ 0.06 (-24.4 dB), lag ~ 1.66 ms (~28 cm)
    const u = (angleDeg - 25) / (135 - 25); // 0 = 25° closed, 1 = 135° wide open
    const defaultEchoDb = -4.2 - 22.8 * u;
    const echoRel =
      opts.echoRatio !== undefined ? opts.echoRatio : Math.pow(10, defaultEchoDb / 20);
    const echoLagMs = opts.echoLagMs !== undefined ? opts.echoLagMs : 0.40 + 1.42 * u;

    const N = computePeriodForSampleRate(sampleRate);
    const baseTx =
      txMode === 'chirp'
        ? buildChirpPiggybackWaveform(sampleRate, { period: N, gain: CHIRP_PIGGYBACK_TX_GAIN })
        : buildLidPingWaveform(sampleRate, { period: N, gain: CHIRP_GAIN });

    const txRe = new Float64Array(N);
    const txIm = new Float64Array(N);
    for (let i = 0; i < N; i++) txRe[i] = baseTx[i];
    fftRadix2(txRe, txIm, false);

    function applyFracDelay(delaySamp) {
      const re = new Float64Array(N);
      const im = new Float64Array(N);
      for (let b = 0; b <= N >> 1; b++) {
        const ang = (-2 * Math.PI * b * delaySamp) / N;
        const c = Math.cos(ang);
        const s = Math.sin(ang);
        const nr = txRe[b] * c - txIm[b] * s;
        const ni = txRe[b] * s + txIm[b] * c;
        re[b] = nr;
        im[b] = ni;
        if (b > 0 && b < N >> 1) {
          re[N - b] = nr;
          im[N - b] = -ni;
        }
      }
      fftRadix2(re, im, true);
      return re;
    }

    const dSig = applyFracDelay(directDelaySamples);
    const eSig = applyFracDelay(directDelaySamples + (echoLagMs * sampleRate) / 1000);

    // Deterministic seeded PRNG for reproducible tests
    let seed = (opts.seed || 2026) >>> 0;
    function nextRand() {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
    }

    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      out[i] = directGain * (dSig[i] + echoPolarity * echoRel * eSig[i]) + nextRand() * noiseStd * 2;
    }
    return {
      frame: out,
      expectedLagMs: echoLagMs,
      expectedEchoDb: 20 * Math.log10(Math.max(1e-6, echoRel))
    };
  }

  // ===========================================================================
  // DOM & SVG Helpers (Strict zero-innerHTML construction)
  // ===========================================================================

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'className') el.className = v;
        else if (k === 'textContent') el.textContent = String(v);
        else if (k === 'dataset') {
          Object.keys(v).forEach((dk) => {
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
      list.forEach((c) => {
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
      Object.keys(attrs).forEach((k) => {
        if (attrs[k] !== undefined && attrs[k] !== null) {
          node.setAttribute(k, String(attrs[k]));
        }
      });
    }
    if (children) {
      children.forEach((c) => {
        if (c) node.appendChild(c);
      });
    }
    return node;
  }

  function postureForAngle(deg) {
    if (deg < 12) return 'CLOSED';
    if (deg < 42) return 'PEEK';
    if (deg < 72) return 'LOW';
    if (deg < 118) return 'WORK';
    return 'WIDE';
  }

  function buildArcSectorPath(deg) {
    const a = clamp(deg, 0, ANGLE_MAX_UI);
    if (a < 0.8) return '';
    const rad = (a * Math.PI) / 180;
    const x0 = SVG_HX + SVG_ARC_R;
    const y0 = SVG_HY;
    const x1 = SVG_HX + SVG_ARC_R * Math.cos(rad);
    const y1 = SVG_HY - SVG_ARC_R * Math.sin(rad);
    return `M ${SVG_HX} ${SVG_HY} L ${x0.toFixed(1)} ${y0.toFixed(1)} A ${SVG_ARC_R} ${SVG_ARC_R} 0 0 0 ${x1.toFixed(
      1
    )} ${y1.toFixed(1)} Z`;
  }

  function buildArcStrokePath(deg) {
    const a = clamp(deg, 0, ANGLE_MAX_UI);
    if (a < 0.8) return '';
    const rad = (a * Math.PI) / 180;
    const x0 = SVG_HX + SVG_ARC_R;
    const y0 = SVG_HY;
    const x1 = SVG_HX + SVG_ARC_R * Math.cos(rad);
    const y1 = SVG_HY - SVG_ARC_R * Math.sin(rad);
    return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${SVG_ARC_R} ${SVG_ARC_R} 0 0 0 ${x1.toFixed(
      1
    )} ${y1.toFixed(1)}`;
  }

  /**
   * Builds the side-elevation MacBook Pro hinge SVG (`viewBox="0 0 212 134"`).
   */
  function buildHingeDiagramSvg() {
    const ticks = [];
    for (let deg = 0; deg <= 135; deg += 15) {
      const rad = (deg * Math.PI) / 180;
      const major = deg % 45 === 0;
      const rIn = major ? SVG_ARC_R - 6 : SVG_ARC_R - 3.5;
      const rOut = SVG_ARC_R + 2;
      ticks.push(
        svgEl('line', {
          x1: (SVG_HX + rIn * Math.cos(rad)).toFixed(1),
          y1: (SVG_HY - rIn * Math.sin(rad)).toFixed(1),
          x2: (SVG_HX + rOut * Math.cos(rad)).toFixed(1),
          y2: (SVG_HY - rOut * Math.sin(rad)).toFixed(1),
          class: major ? 'la-tick la-tick--major' : 'la-tick'
        })
      );
      if (major) {
        const rLbl = SVG_ARC_R + 12.5;
        ticks.push(
          svgEl(
            'text',
            {
              x: (SVG_HX + rLbl * Math.cos(rad)).toFixed(1),
              y: (SVG_HY - rLbl * Math.sin(rad) + 2.5).toFixed(1),
              class: 'la-arc-label',
              'text-anchor': 'middle'
            },
            [document.createTextNode(`${deg}°`)]
          )
        );
      }
    }

    // Subtle calibration reference pips at 50° and 110°
    const calPips = [50, 110].map((deg) => {
      const rad = (deg * Math.PI) / 180;
      return svgEl('circle', {
        cx: (SVG_HX + SVG_ARC_R * Math.cos(rad)).toFixed(1),
        cy: (SVG_HY - SVG_ARC_R * Math.sin(rad)).toFixed(1),
        r: '2.1',
        class: 'la-cal-pip',
        'data-cal-deg': String(deg)
      });
    });

    const fullArcRad = (135 * Math.PI) / 180;
    const fullArcPath = `M ${(SVG_HX + SVG_ARC_R).toFixed(1)} ${SVG_HY} A ${SVG_ARC_R} ${SVG_ARC_R} 0 0 0 ${(
      SVG_HX +
      SVG_ARC_R * Math.cos(fullArcRad)
    ).toFixed(1)} ${(SVG_HY - SVG_ARC_R * Math.sin(fullArcRad)).toFixed(1)}`;

    const sectorPath = svgEl('path', { class: 'la-arc-sector', d: buildArcSectorPath(108) });
    const activeArcPath = svgEl('path', { class: 'la-arc-active', d: buildArcStrokePath(108) });

    // Acoustic screen-bounce sonar ray path (speaker -> glass midpoint -> mic)
    const sonarRayPath = svgEl('path', {
      class: 'la-sonar-ray',
      d: '',
      opacity: '0'
    });
    const sonarWaveArc = svgEl('circle', {
      class: 'la-sonar-pulse',
      cx: String(SVG_HX + 28),
      cy: String(SVG_HY - 4),
      r: '4',
      opacity: '0'
    });

    // Pivoting MacBook Pro Display Lid (drawn horizontally at 0°, then rotated `-deg` around hinge!)
    const lidGroup = svgEl('g', {
      class: 'la-lid-group',
      transform: `rotate(-108 ${SVG_HX} ${SVG_HY})`
    }, [
      // Anodized aluminum outer back cover
      svgEl('rect', {
        x: String(SVG_HX - 1),
        y: String(SVG_HY - 6.2),
        width: String(SVG_LID_LEN + 2),
        height: '4.6',
        rx: '2.1',
        class: 'la-lid-shell'
      }),
      // Specular glass display surface facing keyboard
      svgEl('line', {
        x1: String(SVG_HX + 4),
        y1: String(SVG_HY - 1.5),
        x2: String(SVG_HX + SVG_LID_LEN - 2),
        y2: String(SVG_HY - 1.5),
        class: 'la-lid-glass'
      }),
      // Tactile grab knob near lid tip for pointer scrubbing
      svgEl('circle', {
        cx: String(SVG_HX + SVG_LID_LEN - 5),
        cy: String(SVG_HY - 3.9),
        r: '5.5',
        class: 'la-lid-handle-halo'
      }),
      svgEl('circle', {
        cx: String(SVG_HX + SVG_LID_LEN - 5),
        cy: String(SVG_HY - 3.9),
        r: '2.6',
        class: 'la-lid-handle-dot'
      })
    ]);

    // Fixed MacBook Pro Base Deck Chassis
    const baseGroup = svgEl('g', { class: 'la-base-group' }, [
      // Desk surface reference hairline
      svgEl('line', {
        x1: '10',
        y1: String(SVG_HY + 10.5),
        x2: '202',
        y2: String(SVG_HY + 10.5),
        class: 'la-desk-line'
      }),
      // Rubber feet pads
      svgEl('rect', {
        x: String(SVG_HX + 8),
        y: String(SVG_HY + 8),
        width: '12',
        height: '2.5',
        rx: '1',
        class: 'la-chassis-foot'
      }),
      svgEl('rect', {
        x: String(SVG_HX + 82),
        y: String(SVG_HY + 8),
        width: '12',
        height: '2.5',
        rx: '1',
        class: 'la-chassis-foot'
      }),
      // Main aluminum lower chassis
      svgEl('path', {
        d: `M ${SVG_HX - 4} ${SVG_HY + 1} L ${SVG_HX + 100} ${SVG_HY + 1} Q ${SVG_HX + 105} ${
          SVG_HY + 1
        } ${SVG_HX + 105} ${SVG_HY + 5} L ${SVG_HX + 102} ${SVG_HY + 8} L ${SVG_HX + 1} ${
          SVG_HY + 8
        } Q ${SVG_HX - 4} ${SVG_HY + 8} ${SVG_HX - 4} ${SVG_HY + 4} Z`,
        class: 'la-base-shell'
      }),
      // Recessed keyboard / upward-firing speaker grille slot
      svgEl('line', {
        x1: String(SVG_HX + 18),
        y1: String(SVG_HY + 1),
        x2: String(SVG_HX + 68),
        y2: String(SVG_HY + 1),
        class: 'la-key-deck'
      }),
      // Upward-firing speaker / mic array acoustic marker
      svgEl('circle', {
        cx: String(SVG_HX + 28),
        cy: String(SVG_HY + 2.8),
        r: '1.8',
        class: 'la-spk-dot'
      }),
      // Precision cylindrical clutch hinge pin
      svgEl('circle', {
        cx: String(SVG_HX),
        cy: String(SVG_HY),
        r: '5.2',
        class: 'la-hinge-outer'
      }),
      svgEl('circle', {
        cx: String(SVG_HX),
        cy: String(SVG_HY),
        r: '2.0',
        class: 'la-hinge-pin'
      })
    ]);

    const svg = svgEl(
      'svg',
      {
        viewBox: '0 0 212 134',
        class: 'la-hinge-svg',
        preserveAspectRatio: 'xMidYMid meet',
        role: 'slider',
        tabindex: '0',
        'aria-label': 'MacBook lid hinge angle',
        'aria-valuemin': String(ANGLE_MIN_UI),
        'aria-valuemax': String(ANGLE_MAX_UI),
        'aria-valuenow': '108',
        'aria-valuetext': '108 degrees, work posture'
      },
      [
        svgEl('path', { class: 'la-arc-track', d: fullArcPath }),
        sectorPath,
        activeArcPath,
        ...ticks,
        ...calPips,
        sonarRayPath,
        sonarWaveArc,
        lidGroup,
        baseGroup
      ]
    );

    return { svg, sectorPath, activeArcPath, sonarRayPath, sonarWaveArc, lidGroup, calPips };
  }

  // ===========================================================================
  // Secondary Grid Cell 06 Mount (`mountLidAngleCell`)
  // ===========================================================================

  function mountLidAngleCell(cellEl, bus, opts = {}) {
    if (!cellEl) return null;

    const bridgeOrigin = opts.bridgeOrigin || BRIDGE_ORIGIN;
    const calibration = LidCalibration.load(opts.storage);
    const estimator = new LidSonarEstimator({ calibration });

    // Runtime state
    let currentAngle = 108.0;
    let sourceMode = 'idle'; // 'hid' | 'sonar' | 'drag' | 'idle'
    let hidLive = false;
    let hidAvailableReason = '';
    let hidEventSource = null;
    let hidProbeAbort = null;
    let hidReconnectTimer = null;
    let hidReconnectTried = false;
    let hidWantedOnReopen = false;
    let hidEpoch = 0;
    let hidProbing = false;
    let hidUserDisconnected = false;

    let busState = { state: 'idle', sampleRate: 48000, txMode: 'off' };
    let sonarSignalPresent = false;
    let lastEchoDb = -16.2;
    let lastLagMs = 1.05;
    let lastBounceCm = 18.0;
    let isDragging = false;
    let dragPointerId = null;
    let noteTimer = null;
    let destroyed = false;
    let secondaryOpen = false;
    let sonarArmedBus = false;

    // Clear target container safely without innerHTML
    while (cellEl.firstChild) cellEl.removeChild(cellEl.firstChild);
    cellEl.classList.add('la-cell');
    cellEl.setAttribute('aria-label', 'MacBook Lid Angle Sensor');

    // -------------------------------------------------------------------------
    // 1. Build UI DOM Tree
    // -------------------------------------------------------------------------
    // Shared tile anatomy (ui/NOTES.md section 2, left-grille NOTES "Sensor cell frame"):
    // head = index + title + status pill + Sonar + HID; body = hinge drawing + angle (the hero);
    // foot = calibration buttons + note.
    const sonarBtnLabel = h('span', { textContent: 'Sonar' });
    const sonarBtn = h(
      'button',
      {
        type: 'button',
        className: 'la-btn la-btn--sonar ui-btn ui-btn--sm',
        dataset: { active: 'false' },
        'aria-pressed': 'false',
        'data-tip': SONAR_TIP_OFF,
        onClick: () => toggleSonar()
      },
      [sonarBtnLabel]
    );

    // No ui-hide-* class: HID stays reachable at every width (the bridge is the exact source).
    const hidBtn = h(
      'button',
      {
        type: 'button',
        className: 'la-btn la-btn--hid ui-btn ui-btn--sm',
        dataset: { live: 'false' },
        'aria-pressed': 'false',
        'data-tip': HID_TIP_OFF,
        onClick: () => handleHidButtonClick()
      },
      ['HID']
    );

    // The label keeps `la-source-badge` (tests and code write its text); the pill carries the tone.
    const sourceBadge = h('span', {
      className: 'la-source-badge ui-pill-label',
      dataset: { source: 'idle' },
      textContent: 'READY'
    });
    const statusPill = h(
      'span',
      {
        className: 'la-pill ui-pill',
        role: 'note',
        tabindex: '0',
        dataset: { tone: 'idle' },
        'data-tip': PILL_TIPS.idle
      },
      [sourceBadge]
    );

    const cellKicker = h('span', { className: 'la-kicker ui-tile-index', textContent: '06' });

    const bezel = h('header', { className: 'la-bezel ui-tile-head' }, [
      cellKicker,
      h('span', { className: 'la-title ui-tile-title', textContent: 'Lid angle' }),
      h('div', { className: 'la-bezel-group ui-tile-actions' }, [statusPill, sonarBtn, hidBtn])
    ]);

    const diagram = buildHingeDiagramSvg();
    diagram.svg.setAttribute('data-tip', 'Drag the lid, or use the arrow keys, to simulate an angle.');
    const diagramWell = h('div', { className: 'la-diagram-well ui-well' }, [diagram.svg]);

    const angleValueEl = h('span', { className: 'la-angle-num', textContent: '108' });
    const angleUnitEl = h('span', { className: 'la-angle-deg ui-readout-unit', textContent: '°' });
    const postureEl = h('div', {
      className: 'la-posture ui-readout ui-readout--quiet',
      textContent: 'WORK · 108°'
    });

    const echoValEl = h('span', { className: 'la-metric-val ui-readout', textContent: '— dB' });
    const lagValEl = h('span', { className: 'la-metric-val ui-readout', textContent: '— ms' });
    const echoBarFill = h('div', { className: 'la-meter-fill' });
    const echoBarTrack = h('div', { className: 'la-meter-track', 'aria-hidden': 'true' }, [
      echoBarFill
    ]);

    const metricsCard = h('div', { className: 'la-metrics' }, [
      h('div', { className: 'la-metric-row', 'data-tip': 'Strength of the echo off the screen, in decibels.' }, [
        h('span', { className: 'la-metric-key ui-label', textContent: 'Echo' }),
        echoValEl
      ]),
      h('div', { className: 'la-metric-row', 'data-tip': 'Delay of the screen echo; a wider lid gives a longer delay.' }, [
        h('span', { className: 'la-metric-key ui-label', textContent: 'Lag' }),
        lagValEl
      ]),
      echoBarTrack
    ]);

    const readoutCol = h('div', { className: 'la-readout' }, [
      h('div', { className: 'la-hero-card' }, [
        h('div', { className: 'la-angle-hero ui-readout ui-readout--hero' }, [angleValueEl, angleUnitEl]),
        postureEl
      ]),
      metricsCard
    ]);

    const narrowNote = h('span', {
      className: 'la-narrow-note ui-label',
      'data-tip': 'Calibration buttons appear when this tile is at least 320 px wide.',
      textContent: 'Widen to calibrate'
    });

    const mainBody = h('div', { className: 'la-body ui-tile-body' }, [diagramWell, readoutCol, narrowNote]);

    const setOpenBtn = h(
      'button',
      {
        type: 'button',
        className: 'la-cal-btn ui-btn ui-btn--sm ui-btn--quiet',
        dataset: { calibrated: calibration.openCalibrated ? 'true' : 'false' },
        'data-tip': 'Open the lid to 110°, then click to save this echo as the 110° reference.',
        onClick: () => captureCalibration('open')
      },
      [
        h('span', { className: 'la-cal-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'la-cal-long', textContent: 'Set 110°' })
      ]
    );

    const setLowBtn = h(
      'button',
      {
        type: 'button',
        className: 'la-cal-btn ui-btn ui-btn--sm ui-btn--quiet',
        dataset: { calibrated: calibration.lowCalibrated ? 'true' : 'false' },
        'data-tip': 'Lower the lid to 50°, then click to save this echo as the 50° reference.',
        onClick: () => captureCalibration('low')
      },
      [
        h('span', { className: 'la-cal-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'la-cal-long', textContent: 'Set 50°' })
      ]
    );

    const resetCalBtn = h(
      'button',
      {
        type: 'button',
        className: 'la-cal-btn la-cal-btn--reset ui-btn ui-btn--sm ui-btn--quiet',
        hidden: !calibration.isCalibrated,
        'data-tip': 'Forget both saved references and use the default angle curve.',
        onClick: () => resetCalibration()
      },
      ['Reset']
    );

    const calNote = h('span', {
      className: 'la-cal-note',
      role: 'status',
      'aria-live': 'polite',
      textContent: calibration.isCalibrated ? 'Calibrated · 18.2–20.4k' : '18.2–20.4 kHz screen bounce'
    });

    const calBar = h('footer', { className: 'la-cal-bar ui-tile-foot' }, [
      h('div', { className: 'la-cal-actions' }, [setOpenBtn, setLowBtn, resetCalBtn]),
      calNote
    ]);

    const stage = h('div', { className: 'la-stage lg-cell-stage', dataset: { source: 'idle' } }, [
      bezel,
      mainBody,
      calBar
    ]);

    cellEl.appendChild(stage);

    // -------------------------------------------------------------------------
    // 2. Render Synchronization
    // -------------------------------------------------------------------------
    function setNote(text, transientMs = 0) {
      if (noteTimer) {
        clearTimeout(noteTimer);
        noteTimer = null;
      }
      calNote.textContent = text;
      if (transientMs > 0) {
        noteTimer = setTimeout(() => {
          noteTimer = null;
          refreshDefaultNote();
        }, transientMs);
      }
    }

    function refreshDefaultNote(force = false) {
      if (!force && noteTimer) return;
      if (hidLive) {
        calNote.textContent = 'Apple IOHID 0x8104 · 0.1°';
      } else if (
        busState.state === 'listening' &&
        (busState.txMode === 'lid-ping' || busState.txMode === 'chirp') &&
        busState.sampleRate < MIN_ULTRASONIC_SR
      ) {
        calNote.textContent = 'Needs >= 40 kHz mic (disable BT HFP)';
      } else if (busState.state === 'listening' && busState.txMode === 'chirp') {
        calNote.textContent = 'Piggybacking Cell 04 chirp';
      } else if (busState.state === 'listening' && busState.txMode === 'lid-ping') {
        calNote.textContent = calibration.isCalibrated
          ? 'Sonar locked · Calibrated'
          : 'Tilt & tap Set 110° / 50°';
      } else if (calibration.isCalibrated) {
        calNote.textContent = 'Calibrated · 18.2–20.4k';
      } else {
        calNote.textContent = '18.2–20.4 kHz screen bounce';
      }
    }

    function updateCalButtons() {
      setOpenBtn.dataset.calibrated = calibration.openCalibrated ? 'true' : 'false';
      setLowBtn.dataset.calibrated = calibration.lowCalibrated ? 'true' : 'false';
      resetCalBtn.hidden = !calibration.isCalibrated;
      diagram.calPips.forEach((pip) => {
        const d = pip.getAttribute('data-cal-deg');
        const locked = d === '110' ? calibration.openCalibrated : calibration.lowCalibrated;
        pip.setAttribute('data-locked', locked ? 'true' : 'false');
      });
    }

    function updateVisuals() {
      const deg = clamp(currentAngle, ANGLE_MIN_UI, ANGLE_MAX_UI);
      const rad = (deg * Math.PI) / 180;
      const isExact = sourceMode === 'hid';
      const displayStr = isExact ? deg.toFixed(1) : String(Math.round(deg));
      const posture = postureForAngle(deg);

      stage.dataset.source = sourceMode;
      sourceBadge.dataset.source = sourceMode;
      // Pill tone (green rule): ok only while the HID bridge stream delivers angles; sonar
      // (armed or measuring) is attention; a drag is a simulation and says so; idle is grey.
      let pillTone = 'idle';
      let pillTip = PILL_TIPS.idle;
      if (sourceMode === 'hid') {
        sourceBadge.textContent = 'HW HID · LIVE';
        pillTone = 'ok';
        pillTip = PILL_TIPS.hid;
      } else if (sourceMode === 'sonar') {
        // Armed is not measuring: until an echo frame arrives the angle is not a sonar reading.
        sourceBadge.textContent = !sonarSignalPresent
          ? 'SONAR · NO ECHO'
          : busState.txMode === 'chirp'
            ? 'SONAR · CHIRP'
            : 'SONAR';
        pillTone = 'attention';
        pillTip = sonarSignalPresent ? PILL_TIPS.sonar : PILL_TIPS.noEcho;
      } else if (sourceMode === 'drag') {
        sourceBadge.textContent = 'SIM · DRAG';
        pillTip = PILL_TIPS.drag;
      } else {
        sourceBadge.textContent = 'READY';
      }
      statusPill.dataset.tone = pillTone;
      statusPill.setAttribute('data-tip', pillTip);

      angleValueEl.textContent = displayStr;
      postureEl.textContent = isExact
        ? `${posture} · IOHID`
        : sourceMode === 'sonar'
          ? `${posture} · ${Math.round(lastBounceCm)}cm`
          : `${posture} · ${Math.round(deg)}°`;

      // Update SVG geometry
      diagram.lidGroup.setAttribute('transform', `rotate(${(-deg).toFixed(2)} ${SVG_HX} ${SVG_HY})`);
      diagram.sectorPath.setAttribute('d', buildArcSectorPath(deg));
      diagram.activeArcPath.setAttribute('d', buildArcStrokePath(deg));

      diagram.svg.setAttribute('aria-valuenow', String(Math.round(deg)));
      diagram.svg.setAttribute('aria-valuetext', `${displayStr} degrees, ${posture.toLowerCase()} posture`);

      // Acoustic bounce ray visualization (visible when Sonar or Dragging)
      const showRay = (sourceMode === 'sonar' && sonarSignalPresent) || sourceMode === 'drag';
      if (showRay && deg >= 12) {
        const spkX = SVG_HX + 28;
        const spkY = SVG_HY - 1;
        const micX = SVG_HX + 15;
        const micY = SVG_HY - 1;
        const hitDist = clamp(52 - (135 - deg) * 0.14, 30, 56);
        const hitX = SVG_HX + hitDist * Math.cos(rad);
        const hitY = SVG_HY - hitDist * Math.sin(rad);
        diagram.sonarRayPath.setAttribute(
          'd',
          `M ${spkX.toFixed(1)} ${spkY.toFixed(1)} L ${hitX.toFixed(1)} ${hitY.toFixed(1)} L ${micX.toFixed(
            1
          )} ${micY.toFixed(1)}`
        );
        const strength = clamp((lastEchoDb + 30) / 24, 0.18, 0.95);
        diagram.sonarRayPath.setAttribute('opacity', strength.toFixed(2));
        diagram.sonarWaveArc.setAttribute('opacity', (strength * 0.55).toFixed(2));
      } else {
        diagram.sonarRayPath.setAttribute('opacity', '0');
        diagram.sonarWaveArc.setAttribute('opacity', '0');
      }

      // Telemetry metrics panel
      if (sourceMode === 'hid') {
        echoValEl.textContent = '0x8104';
        lagValEl.textContent = '0.1° HW';
        echoBarFill.style.width = `${clamp((deg / ANGLE_MAX_UI) * 100, 3, 100).toFixed(1)}%`;
      } else if (sourceMode === 'sonar' && sonarSignalPresent) {
        echoValEl.textContent = `${lastEchoDb.toFixed(1)} dB`;
        lagValEl.textContent = `${lastLagMs.toFixed(2)} ms`;
        const fillPct = clamp(((lastEchoDb + 32) / 28) * 100, 4, 100);
        echoBarFill.style.width = `${fillPct.toFixed(1)}%`;
      } else if (sourceMode === 'drag') {
        echoValEl.textContent = `${lastEchoDb.toFixed(1)} dB`;
        lagValEl.textContent = `${lastLagMs.toFixed(2)} ms`;
        const fillPct = clamp(((lastEchoDb + 32) / 28) * 100, 4, 100);
        echoBarFill.style.width = `${fillPct.toFixed(1)}%`;
      } else {
        echoValEl.textContent = '— dB';
        lagValEl.textContent = '— ms';
        echoBarFill.style.width = '0%';
      }

      // Button states
      const sonarActive =
        busState.state === 'listening' &&
        (busState.txMode === 'lid-ping' || busState.txMode === 'chirp');
      sonarBtn.dataset.active = sonarActive ? 'true' : 'false';
      sonarBtn.setAttribute('aria-pressed', sonarActive ? 'true' : 'false');
      const requesting = busState.state === 'requesting';
      const chirpOnly = busState.state === 'listening' && busState.txMode === 'chirp';
      sonarBtnLabel.textContent = requesting ? 'Arming…' : chirpOnly ? 'Chirp' : 'Sonar';
      // Running (pinging, or waiting for the mic it asked for): rust, like every armed toggle.
      if (sonarActive || requesting) sonarBtn.dataset.tone = 'attention';
      else delete sonarBtn.dataset.tone;
      sonarBtn.setAttribute(
        'data-tip',
        requesting ? SONAR_TIP_ARMING : chirpOnly ? SONAR_TIP_CHIRP : sonarActive ? SONAR_TIP_ON : SONAR_TIP_OFF
      );

      hidBtn.dataset.live = hidLive ? 'true' : 'false';
      hidBtn.setAttribute('aria-pressed', hidLive ? 'true' : 'false');
      hidBtn.setAttribute('data-tip', hidLive || hidEventSource ? HID_TIP_ON : HID_TIP_OFF);
    }

    // -------------------------------------------------------------------------
    // 3. Shared Acoustic Bus Integration (Mode A)
    // -------------------------------------------------------------------------
    let unsubAudio = null;
    let unsubState = null;

    if (bus) {
      if (typeof bus.registerTxGenerator === 'function') {
        bus.registerTxGenerator('lid-ping', generateLidPingBlock);
      }

      if (typeof bus.onStateChange === 'function') {
        unsubState = bus.onStateChange((st) => {
          if (destroyed || !st) return;
          const wasListening = busState.state === 'listening';
          busState = Object.assign({ state: 'idle', sampleRate: 48000, txMode: 'off' }, st);
          // Ownership of a mic SONAR armed ends when the bus stops, or when another cell takes
          // over the TX (e.g. chirp sonar) — same rule as tap-zones' CAL arm.
          if (
            busState.state === 'idle' ||
            busState.state === 'error' ||
            (busState.txMode && busState.txMode !== 'lid-ping')
          ) {
            sonarArmedBus = false;
          }
          // A fresh arm supersedes an earlier transient failure note.
          if (!wasListening && busState.state === 'listening' && noteTimer) {
            clearTimeout(noteTimer);
            noteTimer = null;
          }
          const sonarReady =
            busState.state === 'listening' &&
            (busState.txMode === 'lid-ping' || busState.txMode === 'chirp');

          if (!sonarReady) {
            sonarSignalPresent = false;
            if (sourceMode === 'sonar') {
              sourceMode = hidLive ? 'hid' : 'idle';
            }
          } else if (busState.sampleRate < MIN_ULTRASONIC_SR) {
            setNote('Needs >= 40 kHz mic (disable BT HFP)', 3500);
          } else if (!hidLive && !isDragging) {
            sourceMode = 'sonar';
          }
          refreshDefaultNote();
          updateVisuals();
        });
      }

      if (typeof bus.subscribeAudio === 'function') {
        unsubAudio = bus.subscribeAudio((pkt) => {
          if (destroyed || !pkt || !pkt.samples) return;
          const activeMode =
            pkt.txMode || (typeof bus.getTxMode === 'function' ? bus.getTxMode() : busState.txMode);
          if (activeMode !== 'lid-ping' && activeMode !== 'chirp') return;

          const sr = pkt.sampleRate || busState.sampleRate || 48000;
          const frames = estimator.pushSamples(pkt.samples, sr, activeMode);
          if (!frames.length) return;
          const est = frames[frames.length - 1];

          sonarSignalPresent = Boolean(est.signalPresent);
          if (est.signalPresent) {
            lastEchoDb = est.smoothEchoGainDb;
            lastLagMs = est.smoothPeakLagMs;
            lastBounceCm = est.bouncePathCm;
            if (!hidLive && !isDragging) {
              sourceMode = 'sonar';
              currentAngle = est.angleDeg;
            }
          }
          updateVisuals();
        });
      }
    }

    async function toggleSonar() {
      if (!bus) {
        setNote('Acoustic bus unavailable — drag lid to simulate', 2600);
        return;
      }
      const tx = typeof bus.getTxMode === 'function' ? bus.getTxMode() : busState.txMode;
      if (busState.state === 'listening' && tx === 'lid-ping') {
        // If SONAR is what turned the mic on, turning it off releases the mic too (the shared
        // nav ARRAY button or another cell keeps it only when they armed it).
        if (sonarArmedBus && typeof bus.stopAll === 'function') {
          sonarArmedBus = false;
          bus.stopAll({ dispatchClose: false });
        } else if (typeof bus.setTxMode === 'function') {
          bus.setTxMode('off');
        }
        sonarSignalPresent = false;
        if (sourceMode === 'sonar') sourceMode = hidLive ? 'hid' : 'idle';
        refreshDefaultNote();
        updateVisuals();
        return;
      }
      estimator.resetState(currentAngle);
      if (typeof bus.requestArm === 'function') {
        if (busState.state === 'idle' || busState.state === 'error') sonarArmedBus = true;
        const ok = await bus.requestArm('lid-ping');
        // `false` also means "aborted" (page closed, ARRAY disarmed): only an error state is a failure.
        if (!ok && !destroyed && busState.state === 'error') {
          setNote('Mic unavailable — drag lid SVG or run HID bridge', 3200);
        }
      } else if (typeof bus.setTxMode === 'function') {
        bus.setTxMode('lid-ping');
      }
    }

    // -------------------------------------------------------------------------
    // 4. Calibration Controls (`[Set Open 110°]` & `[Set Low 50°]`)
    // -------------------------------------------------------------------------
    function captureCalibration(kind) {
      const est = estimator.getLastEstimate();
      const canCapture =
        busState.state === 'listening' &&
        (busState.txMode === 'lid-ping' || busState.txMode === 'chirp') &&
        est &&
        est.signalPresent &&
        Number.isFinite(est.smoothReflectionIndex);

      if (!canCapture) {
        setNote('Arm SONAR first to capture screen echo', 2600);
        return;
      }

      const idx = est.smoothReflectionIndex;
      const res =
        kind === 'open'
          ? calibration.setOpenAnchor(idx, opts.storage)
          : calibration.setLowAnchor(idx, opts.storage);

      if (!res.ok) {
        setNote(res.reason, 3200);
        return;
      }

      const targetAngle = kind === 'open' ? DEFAULT_OPEN_ANGLE : DEFAULT_LOW_ANGLE;
      estimator.kalman.reset(targetAngle);
      if (!hidLive && !isDragging) {
        currentAngle = targetAngle;
      }
      updateCalButtons();
      updateVisuals();
      setNote(kind === 'open' ? 'Locked Open 110° anchor' : 'Locked Low 50° anchor', 2400);
    }

    function resetCalibration() {
      calibration.reset(opts.storage);
      updateCalButtons();
      setNote('Calibration reset to default', 2000);
      updateVisuals();
    }

    // -------------------------------------------------------------------------
    // 5. Mode B — Local Hardware IOHIDManager Bridge (`127.0.0.1:8793`)
    // -------------------------------------------------------------------------
    function closeHidBridge(optsClose = {}) {
      hidEpoch++;
      hidProbing = false;
      if (hidProbeAbort) {
        try {
          hidProbeAbort.abort();
        } catch (_) {}
        hidProbeAbort = null;
      }
      if (hidReconnectTimer) {
        clearTimeout(hidReconnectTimer);
        hidReconnectTimer = null;
      }
      if (hidEventSource) {
        try {
          hidEventSource.close();
        } catch (_) {}
        hidEventSource = null;
      }
      if (optsClose.rememberIfLive && hidLive) {
        hidWantedOnReopen = true;
      }
      hidLive = false;
      if (sourceMode === 'hid') {
        const sonarOn =
          busState.state === 'listening' &&
          (busState.txMode === 'lid-ping' || busState.txMode === 'chirp');
        sourceMode = sonarOn ? 'sonar' : 'idle';
      }
      refreshDefaultNote(true);
      updateVisuals();
    }

    function applyHidPayload(data) {
      if (destroyed || !data || typeof data !== 'object') return;
      if (data.available && Number.isFinite(data.angleDeg)) {
        hidLive = true;
        hidAvailableReason = '';
        hidReconnectTried = false;
        if (noteTimer) {
          clearTimeout(noteTimer);
          noteTimer = null;
        }
        if (!isDragging) {
          sourceMode = 'hid';
          currentAngle = clamp(data.angleDeg, ANGLE_MIN_UI, ANGLE_MAX_UI);
        }
        refreshDefaultNote(true);
        updateVisuals();
      } else {
        hidAvailableReason = data.reason || 'LidAngleSensor unavailable';
        hidLive = false;
        if (sourceMode === 'hid') sourceMode = 'idle';
        refreshDefaultNote(true); // drop the 'Apple IOHID … 0.1°' note
        updateVisuals();
      }
    }

    function connectHidEvents(expectedEpoch) {
      const myEpoch = expectedEpoch !== undefined ? expectedEpoch : hidEpoch;
      if (destroyed || myEpoch !== hidEpoch || typeof EventSource === 'undefined') return;
      if (hidEventSource) {
        try {
          hidEventSource.close();
        } catch (_) {}
        hidEventSource = null;
      }
      try {
        const es = new EventSource(`${bridgeOrigin}/events`);
        hidEventSource = es;

        const onAngleData = (ev) => {
          if (destroyed || myEpoch !== hidEpoch || hidEventSource !== es) return;
          try {
            applyHidPayload(JSON.parse(ev.data));
          } catch (_) {}
        };
        es.addEventListener('angle', onAngleData);
        es.onmessage = onAngleData;

        es.onerror = () => {
          if (hidEventSource !== es || myEpoch !== hidEpoch) return;
          try {
            es.close();
          } catch (_) {}
          hidEventSource = null;
          hidLive = false;
          if (sourceMode === 'hid') {
            sourceMode =
              busState.state === 'listening' &&
              (busState.txMode === 'lid-ping' || busState.txMode === 'chirp')
                ? 'sonar'
                : 'idle';
          }
          refreshDefaultNote(true); // the bridge went away: drop the 'Apple IOHID … 0.1°' note
          updateVisuals();
          // Single bounded retry to avoid noisy reconnect loops
          if (!hidReconnectTried && !destroyed && myEpoch === hidEpoch) {
            hidReconnectTried = true;
            hidReconnectTimer = setTimeout(() => {
              hidReconnectTimer = null;
              if (destroyed || myEpoch !== hidEpoch) return;
              probeHidBridge({ userInitiated: false });
            }, 2500);
          }
        };
      } catch (_) {}
    }

    async function probeHidBridge(probeOpts = {}) {
      const userInitiated = Boolean(probeOpts.userInitiated);
      if (destroyed || typeof fetch !== 'function') {
        if (userInitiated) setNote('Run: node cells/left-grille/lid-bridge.mjs', 3600);
        return false;
      }
      if (hidReconnectTimer) {
        clearTimeout(hidReconnectTimer);
        hidReconnectTimer = null;
      }
      const myHidEpoch = ++hidEpoch;
      hidProbing = true;
      if (hidProbeAbort) {
        try {
          hidProbeAbort.abort();
        } catch (_) {}
      }
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      hidProbeAbort = ac;
      const timer = ac ? setTimeout(() => ac.abort(), BRIDGE_PROBE_TIMEOUT_MS) : null;

      try {
        const res = await fetch(`${bridgeOrigin}/angle`, {
          method: 'GET',
          mode: 'cors',
          cache: 'no-store',
          signal: ac ? ac.signal : undefined
        });
        if (timer) clearTimeout(timer);
        if (hidProbeAbort === ac) hidProbeAbort = null;
        if (destroyed || myHidEpoch !== hidEpoch) return false;
        if (!res || !res.ok) throw new Error('bridge_status');
        const data = await res.json();
        if (destroyed || myHidEpoch !== hidEpoch) return false;

        if (data && data.available && Number.isFinite(data.angleDeg)) {
          applyHidPayload(data);
          connectHidEvents(myHidEpoch);
          return true;
        }
        hidAvailableReason = (data && data.reason) || 'HID sensor unavailable';
        if (userInitiated) {
          setNote(`Bridge live · ${hidAvailableReason}`, 3400);
        }
        return false;
      } catch (_) {
        if (timer) clearTimeout(timer);
        if (hidProbeAbort === ac) hidProbeAbort = null;
        if (userInitiated && !destroyed && myHidEpoch === hidEpoch) {
          setNote('Start: node cells/left-grille/lid-bridge.mjs', 3800);
        }
        return false;
      } finally {
        if (myHidEpoch === hidEpoch) {
          hidProbing = false;
        }
      }
    }

    function handleHidButtonClick() {
      if (hidReconnectTimer) {
        clearTimeout(hidReconnectTimer);
        hidReconnectTimer = null;
      }
      if (hidLive || hidEventSource) {
        hidUserDisconnected = true;
        hidWantedOnReopen = false;
        closeHidBridge();
        setNote('HID bridge disconnected', 2000);
        return;
      }
      hidUserDisconnected = false;
      hidReconnectTried = false;
      probeHidBridge({ userInitiated: true });
    }

    // -------------------------------------------------------------------------
    // 6. Interactive Pointer-Drag & Keyboard Scrubbing on Hinge SVG
    // -------------------------------------------------------------------------
    function applySimulatedDragAngle(deg) {
      const a = clamp(deg, ANGLE_MIN_UI, ANGLE_MAX_UI);
      currentAngle = a;
      sourceMode = 'drag';
      // Preview realistic acoustic echo response while scrubbing the lid
      const u = clamp((a - 25) / (135 - 25), 0, 1);
      lastEchoDb = -5.4 - 20.5 * u;
      lastLagMs = 0.42 + 1.38 * u;
      lastBounceCm = (lastLagMs / 1000) * SPEED_OF_SOUND_CMS * 0.5;
      updateVisuals();
    }

    function pointerEventToAngleDeg(e) {
      let sx = SVG_HX;
      let sy = SVG_HY - 40;
      const svg = diagram.svg;
      if (typeof svg.getScreenCTM === 'function' && typeof svg.createSVGPoint === 'function') {
        const ctm = svg.getScreenCTM();
        if (ctm && typeof ctm.inverse === 'function') {
          const pt = svg.createSVGPoint();
          pt.x = e.clientX;
          pt.y = e.clientY;
          const local = pt.matrixTransform(ctm.inverse());
          sx = local.x;
          sy = local.y;
        }
      } else {
        const rect = svg.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          sx = ((e.clientX - rect.left) / rect.width) * 212;
          sy = ((e.clientY - rect.top) / rect.height) * 134;
        }
      }

      let deg = Math.atan2(SVG_HY - sy, sx - SVG_HX) * (180 / Math.PI);
      if (deg < -90) deg = ANGLE_MAX_UI;
      else if (deg < 0) deg = ANGLE_MIN_UI;
      else if (deg > ANGLE_MAX_UI) deg = ANGLE_MAX_UI;
      return deg;
    }

    diagram.svg.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      diagram.svg.focus({ preventScroll: true });
      isDragging = true;
      dragPointerId = e.pointerId;
      if (diagram.svg.setPointerCapture) {
        try {
          diagram.svg.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
      applySimulatedDragAngle(pointerEventToAngleDeg(e));
    });

    diagram.svg.addEventListener('pointermove', (e) => {
      if (!isDragging || e.pointerId !== dragPointerId) return;
      applySimulatedDragAngle(pointerEventToAngleDeg(e));
    });

    function finishDrag(e) {
      if (!isDragging || (e && e.pointerId !== dragPointerId)) return;
      isDragging = false;
      dragPointerId = null;
      if (hidLive) {
        sourceMode = 'hid';
        updateVisuals();
      } else if (
        busState.state === 'listening' &&
        (busState.txMode === 'lid-ping' || busState.txMode === 'chirp') &&
        sonarSignalPresent
      ) {
        sourceMode = 'sonar';
        updateVisuals();
      }
    }

    diagram.svg.addEventListener('pointerup', finishDrag);
    diagram.svg.addEventListener('pointercancel', finishDrag);

    diagram.svg.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 5 : 1;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        applySimulatedDragAngle(currentAngle + step);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        applySimulatedDragAngle(currentAngle - step);
      } else if (e.key === 'Home') {
        e.preventDefault();
        applySimulatedDragAngle(ANGLE_MIN_UI);
      } else if (e.key === 'End') {
        e.preventDefault();
        applySimulatedDragAngle(ANGLE_MAX_UI);
      }
    });

    // -------------------------------------------------------------------------
    // 7. Lifecycle Cleanup (`lg-secondary-close` & `pagehide`)
    // -------------------------------------------------------------------------
    function onSecondaryClose() {
      secondaryOpen = false;
      closeHidBridge({ rememberIfLive: true });
      if (noteTimer) {
        clearTimeout(noteTimer);
        noteTimer = null;
      }
      isDragging = false;
      dragPointerId = null;
    }

    function onSecondaryOpen() {
      secondaryOpen = true;
      if (destroyed || opts.autoProbeHid === false) return;
      if (hidUserDisconnected || hidLive || hidEventSource || hidProbing) return;
      hidWantedOnReopen = false;
      probeHidBridge({ userInitiated: false });
    }

    // Hidden tab: close the bridge event stream (it pushes ~2 updates/s into a page nobody sees).
    // Visible again: reconnect only what hiding closed, and only while the page is open.
    function onVisibilityChange() {
      if (destroyed || typeof document === 'undefined') return;
      if (document.visibilityState === 'hidden') {
        if (hidLive || hidEventSource || hidProbing) {
          closeHidBridge();
          hidWantedOnReopen = true;
        }
      } else if (hidWantedOnReopen && secondaryOpen && !hidUserDisconnected) {
        hidWantedOnReopen = false;
        probeHidBridge({ userInitiated: false });
      }
    }

    function onHashReopen() {
      if (destroyed) return;
      if (typeof location !== 'undefined' && location && location.hash === '#left-grille') {
        onSecondaryOpen();
      }
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('lg-secondary-open', onSecondaryOpen);
      window.addEventListener('lg-secondary-close', onSecondaryClose);
      window.addEventListener('pagehide', onSecondaryClose);
      window.addEventListener('hashchange', onHashReopen);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    updateCalButtons();
    refreshDefaultNote(true);
    updateVisuals();

    // Only probe local IOHIDManager bridge on mount when Cell 05 secondary view is already open
    // (never eagerly on hidden main grid load). Otherwise `lg-secondary-open` / `hashchange` probes on open.
    const shouldProbeOnMount =
      (global.LeftGrilleLab &&
        typeof global.LeftGrilleLab.isSecondaryOpen === 'function' &&
        global.LeftGrilleLab.isSecondaryOpen()) ||
      (typeof location !== 'undefined' && location && location.hash === '#left-grille') ||
      (cellEl && typeof cellEl.closest === 'function' && !cellEl.closest('[hidden]'));

    secondaryOpen = Boolean(shouldProbeOnMount);
    if (opts.autoProbeHid !== false && shouldProbeOnMount) {
      probeHidBridge({ userInitiated: false });
    }

    return {
      estimator,
      calibration,
      probeHidBridge,
      closeHidBridge,
      destroy() {
        destroyed = true;
        onSecondaryClose();
        if (unsubAudio) unsubAudio();
        if (unsubState) unsubState();
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('lg-secondary-open', onSecondaryOpen);
          window.removeEventListener('lg-secondary-close', onSecondaryClose);
          window.removeEventListener('pagehide', onSecondaryClose);
          window.removeEventListener('hashchange', onHashReopen);
        }
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
          document.removeEventListener('visibilitychange', onVisibilityChange);
        }
      }
    };
  }

  // ===========================================================================
  // Secondary Grid Slot 6 Registration (`window.LeftGrilleLab`)
  // ===========================================================================
  const CELL_SPEC = {
    id: 'lid-angle',
    title: 'Lid Angle',
    mount(cellEl, bus) {
      return mountLidAngleCell(cellEl, bus);
    }
  };

  if (typeof document !== 'undefined') {
    const Lab = (global.LeftGrilleLab = global.LeftGrilleLab || { _pending: [] });
    if (typeof Lab.registerCell === 'function') {
      Lab.registerCell(6, CELL_SPEC);
    } else {
      (Lab._pending = Lab._pending || []).push([6, CELL_SPEC]);
    }
  }

  return {
    CHIRP_PERIOD,
    CHIRP_ACTIVE_LEN,
    F_START_HZ,
    F_END_HZ,
    CHIRP_GAIN,
    MIN_ULTRASONIC_SR,
    LAG_MIN_MS,
    LAG_MAX_MS,
    STORAGE_KEY,
    BRIDGE_ORIGIN,
    DEFAULT_OPEN_ANGLE,
    DEFAULT_LOW_ANGLE,
    DEFAULT_OPEN_REF_INDEX,
    DEFAULT_LOW_REF_INDEX,
    computePeriodForSampleRate,
    fftRadix2,
    buildLidPingWaveform,
    buildChirpPiggybackWaveform,
    generateLidPingBlock,
    computeReflectionIndex,
    LidCalibration,
    LidAngleKalman,
    LidSonarEstimator,
    synthesizeScreenBounceFrame,
    mountLidAngleCell,
    CELL_SPEC
  };
});
