/**
 * Secondary Grid Cell 02 — Chassis Tap Zones (`cells/left-grille/tap-zones.js`)
 *
 * Acoustic Physics & DSP Pipeline (strictly < 16 kHz so 18–21 kHz ultrasonic sonar
 * from sibling cells never interferes):
 *   1. Front-end conditioning: 2nd-order Butterworth HPF (45 Hz) + 8th-order
 *      Butterworth LPF (14.0 kHz, clamped <= 0.43 * fs) + ultrasonic notches at
 *      18.375/19.6 kHz yielding >50–65 dB stopband suppression across 18–21 kHz.
 *   2. Crisp transient impulse detector: 1 ms micro-frame adaptive noise floor with
 *      16 ms pre-trigger ring buffer, 8–55 ms impulse acceptance window, 110 ms
 *      refractory cooldown, and >90 ms sustained speech/swipe veto + steady-fan
 *      floor recovery.
 *   3. 6D Vibro-Acoustic Feature Vector per tap (MacBook Pro Top-Left 3-mic array):
 *      - `subBassRatioDb`  (60–350 Hz corner woofer-chamber cavity boom vs <15 kHz)
 *      - `midPlateRatioDb` (400–2200 Hz A0 aluminum flexural Lamb wave vs <15 kHz)
 *      - `hfAirRatioDb`    (3500–14500 Hz direct air-coupled transient vs <15 kHz)
 *      - `riseTimeMs`      (onset-to-peak dispersive arrival delay)
 *      - `decayRatio`      (early 0–12 ms vs tail 12–35 ms RMS ring ratio)
 *      - `peakDb`          (peak impulse level in dBFS)
 *   4. 4-Zone Mahalanobis / Weighted Euclidean Classifier (`top-left`, `left-palm`,
 *      `trackpad-rim`, `right-palm`) with factory MacBook Pro centroids and
 *      1-tap-per-zone quick calibration (`[CAL 4Z]`, persisted in `dwg.tapZonesCal.v1`).
 *   5. Interactive Swiss/Braun MacBook Pro Unibody Chassis Map SVG where clicking
 *      any zone synthesizes a physical 48 kHz waveform through the real DSP engine.
 *
 * UMD-compatible: exports pure DSP classes for Node `node --test` AND registers
 * into `window.LeftGrilleLab` Secondary Slot 2 in browsers.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.LeftGrilleTapZones = api;
    if (typeof document !== 'undefined') {
      const Lab = (root.LeftGrilleLab = root.LeftGrilleLab || { _pending: [] });
      const spec = {
        id: 'tap-zones',
        title: 'Chassis Tap Zones',
        mount(cellEl, bus) {
          return api.mountTapZonesCell(cellEl, bus);
        }
      };
      if (typeof Lab.registerCell === 'function') {
        Lab.registerCell(2, spec);
      } else {
        (Lab._pending = Lab._pending || []).push([2, spec]);
      }
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function tapZonesFactory(global) {
  'use strict';

  const STORAGE_KEY = 'dwg.tapZonesCal.v1';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const ZONE_ORDER = ['top-left', 'left-palm', 'trackpad-rim', 'right-palm'];

  const ZONES = {
    'top-left': {
      id: 'top-left',
      code: 'Z1',
      label: 'Top-Left Deck',
      shortLabel: 'TOP-LEFT',
      hint: 'Near Esc / Left Grille',
      accent: 'cobalt',
      // Coordinates on 320x206 MacBook Pro Unibody SVG map
      cx: 48,
      cy: 56
    },
    'left-palm': {
      id: 'left-palm',
      code: 'Z2',
      label: 'Left Palm Rest',
      shortLabel: 'LEFT PALM',
      hint: 'Left of Trackpad',
      accent: 'cobalt',
      cx: 58,
      cy: 158
    },
    'trackpad-rim': {
      id: 'trackpad-rim',
      code: 'Z3',
      label: 'Trackpad Rim',
      shortLabel: 'TRACKPAD',
      hint: 'Front Center Bezel',
      accent: 'vermilion',
      cx: 160,
      cy: 158
    },
    'right-palm': {
      id: 'right-palm',
      code: 'Z4',
      label: 'Right Palm / Deck',
      shortLabel: 'RIGHT DECK',
      hint: 'Across Keyboard Cutout',
      accent: 'vermilion',
      cx: 262,
      cy: 148
    }
  };

  const FEATURE_KEYS = [
    'subBassRatioDb',
    'midPlateRatioDb',
    'hfAirRatioDb',
    'riseTimeMs',
    'decayRatio',
    'peakDb'
  ];

  /**
   * Factory MacBook Pro 14"/16" vibro-acoustic centroids (3-mic array under Top-Left Grille).
   */
  const FACTORY_CENTROIDS = {
    'top-left': {
      subBassRatioDb: -18.5,
      midPlateRatioDb: -8.5,
      hfAirRatioDb: -1.4,
      riseTimeMs: 1.4,
      decayRatio: 8.2,
      peakDb: -11.0
    },
    'left-palm': {
      subBassRatioDb: -2.6,
      midPlateRatioDb: -6.8,
      hfAirRatioDb: -10.8,
      riseTimeMs: 3.1,
      decayRatio: 2.2,
      peakDb: -17.0
    },
    'trackpad-rim': {
      subBassRatioDb: -14.5,
      midPlateRatioDb: -2.0,
      hfAirRatioDb: -8.5,
      riseTimeMs: 3.8,
      decayRatio: 3.6,
      peakDb: -19.5
    },
    'right-palm': {
      subBassRatioDb: -8.2,
      midPlateRatioDb: -1.4,
      hfAirRatioDb: -19.5,
      riseTimeMs: 6.8,
      decayRatio: 1.45,
      peakDb: -24.5
    }
  };

  /**
   * Mahalanobis diagonal feature scales (sigma) and relative discriminative weights.
   * `decayRatio` is compared in log2-octave space (`sigma = 0.72` octaves) so fast
   * top-left impulses and slow right-deck rings remain homoscedastic.
   * `peakDb` uses wide sigma & lower weight so soft/firm taps classify by acoustic physics.
   */
  const DEFAULT_SCALES = {
    subBassRatioDb: 3.2,
    midPlateRatioDb: 2.9,
    hfAirRatioDb: 3.3,
    riseTimeMs: 1.25,
    decayRatio: 0.72,
    peakDb: 12.0
  };

  const FEATURE_WEIGHTS = {
    subBassRatioDb: 1.05,
    midPlateRatioDb: 1.0,
    hfAirRatioDb: 1.2,
    riseTimeMs: 1.2,
    decayRatio: 0.9,
    peakDb: 0.3
  };

  function transformFeature(key, val) {
    if (key === 'decayRatio') {
      return Math.log2(Math.max(0.2, Number.isFinite(val) ? val : 1.0));
    }
    return Number.isFinite(val) ? val : 0;
  }

  function clamp(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  /**
   * Deterministic Mulberry32 PRNG for reproducible tests and natural tap texture.
   */
  function createPrng(seed) {
    let s = (seed >>> 0) || 0x12345678;
    return function nextRand() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * In-place iterative Radix-2 Cooley-Tukey Complex FFT.
   */
  function fftRadix2(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) {
        j ^= bit;
      }
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

    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wlenRe = Math.cos(ang);
      const wlenIm = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let wRe = 1.0;
        let wIm = 0.0;
        for (let j = 0; j < half; j++) {
          const uRe = re[i + j];
          const uIm = im[i + j];
          const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
          const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
          re[i + j] = uRe + vRe;
          im[i + j] = uIm + vIm;
          re[i + j + half] = uRe - vRe;
          im[i + j + half] = uIm - vIm;
          const nextWRe = wRe * wlenRe - wIm * wlenIm;
          wIm = wRe * wlenIm + wIm * wlenRe;
          wRe = nextWRe;
        }
      }
    }
  }

  /**
   * Direct Form II Transposed Biquad IIR Filter.
   */
  class BiquadFilter {
    constructor(type, fc, sampleRate, Q) {
      this.b0 = 1;
      this.b1 = 0;
      this.b2 = 0;
      this.a1 = 0;
      this.a2 = 0;
      this.z1 = 0;
      this.z2 = 0;
      this.configure(type, fc, sampleRate, Q);
    }

    configure(type, fc, sampleRate, Q = Math.SQRT1_2) {
      const sr = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : 48000;
      const safeFc = clamp(fc, 10, sr * 0.46);
      const w0 = (2 * Math.PI * safeFc) / sr;
      const cosW = Math.cos(w0);
      const sinW = Math.sin(w0);
      const alpha = sinW / (2 * Math.max(0.1, Q));

      let b0 = 1;
      let b1 = 0;
      let b2 = 0;
      let a0 = 1;
      let a1 = 0;
      let a2 = 0;

      if (type === 'lowpass') {
        b0 = (1 - cosW) * 0.5;
        b1 = 1 - cosW;
        b2 = (1 - cosW) * 0.5;
        a0 = 1 + alpha;
        a1 = -2 * cosW;
        a2 = 1 - alpha;
      } else if (type === 'highpass') {
        b0 = (1 + cosW) * 0.5;
        b1 = -(1 + cosW);
        b2 = (1 + cosW) * 0.5;
        a0 = 1 + alpha;
        a1 = -2 * cosW;
        a2 = 1 - alpha;
      } else if (type === 'bandpass') {
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        a0 = 1 + alpha;
        a1 = -2 * cosW;
        a2 = 1 - alpha;
      } else if (type === 'notch') {
        b0 = 1;
        b1 = -2 * cosW;
        b2 = 1;
        a0 = 1 + alpha;
        a1 = -2 * cosW;
        a2 = 1 - alpha;
      }

      this.b0 = b0 / a0;
      this.b1 = b1 / a0;
      this.b2 = b2 / a0;
      this.a1 = a1 / a0;
      this.a2 = a2 / a0;
    }

    reset() {
      this.z1 = 0;
      this.z2 = 0;
    }

    process(x) {
      const y = this.b0 * x + this.z1;
      this.z1 = this.b1 * x - this.a1 * y + this.z2;
      this.z2 = this.b2 * x - this.a2 * y;
      return y;
    }
  }

  /**
   * Strict `< 16 kHz` Front-End Filter:
   * - 2nd-order Butterworth HPF at 45 Hz (blocks DC drift & sub-audible handling thumps)
   * - 8th-order Butterworth LPF at 14.0 kHz (4 cascaded biquad sections) + ultrasonic
   *   stopband notches at 18.375 kHz & 19.6 kHz (when fs >= 40 kHz), yielding >75 dB
   *   suppression across 18–21.5 kHz sonar while keeping passband < 13.5 kHz flat.
   */
  class TapBandFilter {
    constructor(sampleRate = 48000) {
      this.sampleRate = sampleRate;
      this.hpf = new BiquadFilter('highpass', 45, sampleRate, Math.SQRT1_2);
      const lpfFc = Math.min(14000, sampleRate * 0.43);
      // 8th-order Butterworth Q factors: 1 / (2 * cos(pi*(2k+1)/16)) for k=0..3
      this.lpf1 = new BiquadFilter('lowpass', lpfFc, sampleRate, 0.50979558);
      this.lpf2 = new BiquadFilter('lowpass', lpfFc, sampleRate, 0.60134489);
      this.lpf3 = new BiquadFilter('lowpass', lpfFc, sampleRate, 0.89997622);
      this.lpf4 = new BiquadFilter('lowpass', lpfFc, sampleRate, 2.56291545);
      // Targeted ultrasonic notches when hardware supports ultrasonic carriers (>= 40 kHz)
      this.notch1 = sampleRate >= 40000 ? new BiquadFilter('notch', 18375, sampleRate, 3.0) : null;
      this.notch2 = sampleRate >= 42000 ? new BiquadFilter('notch', 19600, sampleRate, 3.0) : null;
    }

    reset() {
      this.hpf.reset();
      this.lpf1.reset();
      this.lpf2.reset();
      this.lpf3.reset();
      this.lpf4.reset();
      if (this.notch1) this.notch1.reset();
      if (this.notch2) this.notch2.reset();
    }

    process(x) {
      const s = Number.isFinite(x) ? x : 0;
      let y = this.hpf.process(s);
      y = this.lpf1.process(y);
      y = this.lpf2.process(y);
      y = this.lpf3.process(y);
      y = this.lpf4.process(y);
      if (this.notch1) y = this.notch1.process(y);
      if (this.notch2) y = this.notch2.process(y);
      return Number.isFinite(y) ? y : 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Calibration Persistence (`dwg.tapZonesCal.v1`)
  // ---------------------------------------------------------------------------

  function cloneCentroid(c) {
    const out = {};
    for (let i = 0; i < FEATURE_KEYS.length; i++) {
      const k = FEATURE_KEYS[i];
      out[k] = Number(c[k]);
    }
    return out;
  }

  function sanitizeCalibrationPayload(raw) {
    if (!raw || typeof raw !== 'object' || !raw.centroids || typeof raw.centroids !== 'object') {
      return null;
    }
    const centroids = {};
    let validCount = 0;
    for (let z = 0; z < ZONE_ORDER.length; z++) {
      const zoneId = ZONE_ORDER[z];
      const src = raw.centroids[zoneId];
      if (!src || typeof src !== 'object') continue;
      let allFinite = true;
      const clean = {};
      for (let i = 0; i < FEATURE_KEYS.length; i++) {
        const k = FEATURE_KEYS[i];
        if (!Number.isFinite(src[k])) {
          allFinite = false;
          break;
        }
        clean[k] = src[k];
      }
      if (allFinite) {
        centroids[zoneId] = clean;
        validCount++;
      }
    }
    if (validCount === 0) return null;

    const scales = {};
    if (raw.scales && typeof raw.scales === 'object') {
      for (let i = 0; i < FEATURE_KEYS.length; i++) {
        const k = FEATURE_KEYS[i];
        if (Number.isFinite(raw.scales[k]) && raw.scales[k] > 0.05) {
          scales[k] = raw.scales[k];
        }
      }
    }

    return {
      version: 1,
      centroids,
      scales: Object.keys(scales).length === FEATURE_KEYS.length ? scales : null,
      calibratedZones: Object.keys(centroids),
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now()
    };
  }

  function loadStoredCalibration(storage) {
    try {
      const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      if (!store || typeof store.getItem !== 'function') return null;
      const text = store.getItem(STORAGE_KEY);
      if (!text) return null;
      return sanitizeCalibrationPayload(JSON.parse(text));
    } catch (_) {
      return null;
    }
  }

  function saveStoredCalibration(payload, storage) {
    try {
      const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      if (!store) return false;
      if (!payload) {
        if (typeof store.removeItem === 'function') store.removeItem(STORAGE_KEY);
        return true;
      }
      const clean = sanitizeCalibrationPayload(payload);
      if (!clean || typeof store.setItem !== 'function') return false;
      store.setItem(STORAGE_KEY, JSON.stringify(clean));
      return true;
    } catch (_) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // 4-Zone Mahalanobis / Weighted Euclidean Classifier
  // ---------------------------------------------------------------------------

  class TapZoneClassifier {
    constructor(options = {}) {
      this.centroids = {};
      this.scales = Object.assign({}, DEFAULT_SCALES);
      this.weights = Object.assign({}, FEATURE_WEIGHTS, options.weights || {});
      this.calibratedZones = new Set();
      this.resetToFactory();

      if (options.calibration) {
        this.applyCalibration(options.calibration);
      }
    }

    resetToFactory() {
      this.centroids = {};
      for (let i = 0; i < ZONE_ORDER.length; i++) {
        const z = ZONE_ORDER[i];
        this.centroids[z] = cloneCentroid(FACTORY_CENTROIDS[z]);
      }
      this.scales = Object.assign({}, DEFAULT_SCALES);
      this.calibratedZones.clear();
    }

    isCalibrated() {
      return this.calibratedZones.size > 0;
    }

    applyCalibration(payload) {
      const clean = sanitizeCalibrationPayload(payload);
      if (!clean) return false;
      for (let i = 0; i < ZONE_ORDER.length; i++) {
        const z = ZONE_ORDER[i];
        if (clean.centroids[z]) {
          this.centroids[z] = cloneCentroid(clean.centroids[z]);
          this.calibratedZones.add(z);
        }
      }
      if (clean.scales) {
        this.scales = Object.assign({}, DEFAULT_SCALES, clean.scales);
      } else {
        this._recomputeAdaptiveScales();
      }
      return true;
    }

    /**
     * Update one or more zone centroids from 1-tap-per-zone calibration features.
     * Computes regularized diagonal Mahalanobis scales so 1-tap calibration
     * generalizes reliably across soft/firm taps without variance collapse.
     */
    calibrateZones(zoneFeatureMap) {
      if (!zoneFeatureMap || typeof zoneFeatureMap !== 'object') return null;
      let updated = 0;
      for (let i = 0; i < ZONE_ORDER.length; i++) {
        const z = ZONE_ORDER[i];
        const feat = zoneFeatureMap[z];
        if (!feat || typeof feat !== 'object') continue;
        let ok = true;
        const clean = {};
        for (let k = 0; k < FEATURE_KEYS.length; k++) {
          const fk = FEATURE_KEYS[k];
          if (!Number.isFinite(feat[fk])) {
            ok = false;
            break;
          }
          clean[fk] = feat[fk];
        }
        if (ok) {
          this.centroids[z] = clean;
          this.calibratedZones.add(z);
          updated++;
        }
      }
      if (updated === 0) return null;
      this._recomputeAdaptiveScales();
      return this.exportCalibration();
    }

    _recomputeAdaptiveScales() {
      // Blend factory prior scales with inter-centroid spread in transformed space
      const nextScales = {};
      for (let k = 0; k < FEATURE_KEYS.length; k++) {
        const fk = FEATURE_KEYS[k];
        const prior = DEFAULT_SCALES[fk];
        const vals = ZONE_ORDER.map((z) => transformFeature(fk, this.centroids[z][fk]));
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const variance = vals.reduce((a, v) => a + (v - mean) * (v - mean), 0) / vals.length;
        const spread = Math.sqrt(variance);
        // Scale stays within [0.55 * prior, 1.55 * prior] so single-tap calibration stays robust
        const blended = 0.65 * prior + 0.35 * Math.max(prior * 0.4, spread * 0.65);
        nextScales[fk] = clamp(blended, prior * 0.55, prior * 1.55);
      }
      this.scales = nextScales;
    }

    exportCalibration() {
      const centroids = {};
      this.calibratedZones.forEach((z) => {
        if (this.centroids[z]) centroids[z] = cloneCentroid(this.centroids[z]);
      });
      if (Object.keys(centroids).length === 0) return null;
      return {
        version: 1,
        centroids,
        scales: Object.assign({}, this.scales),
        calibratedZones: Array.from(this.calibratedZones),
        updatedAt: Date.now()
      };
    }

    distanceToZone(features, zoneId) {
      const c = this.centroids[zoneId];
      if (!c || !features) return Infinity;
      let sumW = 0;
      let sumSq = 0;
      for (let i = 0; i < FEATURE_KEYS.length; i++) {
        const k = FEATURE_KEYS[i];
        const w = this.weights[k] || 1;
        const s = this.scales[k] || DEFAULT_SCALES[k] || 1;
        const xVal = Number.isFinite(features[k]) ? features[k] : c[k];
        const diff = (transformFeature(k, xVal) - transformFeature(k, c[k])) / s;
        sumSq += w * diff * diff;
        sumW += w;
      }
      return Math.sqrt(sumSq / Math.max(1e-9, sumW));
    }

    classify(features) {
      const distances = {};
      let bestZone = ZONE_ORDER[0];
      let bestDist = Infinity;

      for (let i = 0; i < ZONE_ORDER.length; i++) {
        const z = ZONE_ORDER[i];
        const d = this.distanceToZone(features, z);
        distances[z] = d;
        if (d < bestDist) {
          bestDist = d;
          bestZone = z;
        }
      }

      // Softmax over squared normalized Mahalanobis distance (effective D_eff ~= 2.85
      // accounting for spectral-sum correlation, plus gentle outlier attenuation)
      const temperature = 0.35;
      const weights = {};
      let denom = 0;
      for (let i = 0; i < ZONE_ORDER.length; i++) {
        const z = ZONE_ORDER[i];
        const deltaSq = distances[z] * distances[z] - bestDist * bestDist;
        const w = Math.exp(-0.5 * deltaSq / temperature);
        weights[z] = w;
        denom += w;
      }

      const probabilities = {};
      for (let i = 0; i < ZONE_ORDER.length; i++) {
        const z = ZONE_ORDER[i];
        probabilities[z] = denom > 0 ? weights[z] / denom : 0.25;
      }

      const rawConf = probabilities[bestZone];
      const outlierPenalty = bestDist > 2.8 ? Math.exp(-(bestDist - 2.8) * 0.35) : 1.0;
      const confidence = clamp(rawConf * outlierPenalty, 0.05, 0.99);

      return {
        zone: bestZone,
        label: ZONES[bestZone].label,
        shortLabel: ZONES[bestZone].shortLabel,
        confidence,
        distance: bestDist,
        distances,
        probabilities,
        calibrated: this.isCalibrated()
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Real-Time Chassis Tap Transient Detector & 6D Feature Extractor
  // ---------------------------------------------------------------------------

  class TapZoneDetector {
    constructor(options = {}) {
      this.sampleRate = Number.isFinite(options.sampleRate) && options.sampleRate >= 8000
        ? options.sampleRate
        : 48000;
      this.refractoryMs = Number.isFinite(options.refractoryMs) ? options.refractoryMs : 110;
      this.minTapMs = Number.isFinite(options.minTapMs) ? options.minTapMs : 5.5;
      this.maxTapMs = Number.isFinite(options.maxTapMs) ? options.maxTapMs : 82;
      this.sustainedVetoMs = Number.isFinite(options.sustainedVetoMs) ? options.sustainedVetoMs : 90;
      this.minTriggerRms = Number.isFinite(options.minTriggerRms) ? options.minTriggerRms : 0.0014;
      this.triggerSnrRatio = Number.isFinite(options.triggerSnrRatio) ? options.triggerSnrRatio : 3.8;

      this._initForSampleRate(this.sampleRate);
    }

    _initForSampleRate(sr) {
      this.sampleRate = sr;
      this.filter = new TapBandFilter(sr);

      // 1 ms micro-frames for sharp onset & duration tracking
      this.frameSamples = Math.max(8, Math.round(sr * 0.001));
      this.frameMs = (this.frameSamples * 1000) / sr;
      this.preRollSamples = Math.round(sr * 0.016); // 16 ms pre-trigger buffer
      this.maxCaptureSamples = Math.round(sr * 0.125); // 125 ms capture capacity

      this.preRing = new Float32Array(this.preRollSamples);
      this.preRingPos = 0;
      this.preRingFilled = 0;

      // Capture scratch buffer (preRoll + capture)
      this.captureBuf = new Float32Array(this.preRollSamples + this.maxCaptureSamples);
      this.captureLen = 0;
      this.capturePreLen = 0;

      // FFT buffers for 42 ms feature extraction window (~23.4 Hz/bin at 48 kHz)
      const targetFft = nextPow2(Math.round(sr * 0.042));
      this.fftSize = clamp(targetFft, 512, 4096);
      this.fftRe = new Float64Array(this.fftSize);
      this.fftIm = new Float64Array(this.fftSize);

      this.reset();
    }

    reset() {
      this.filter.reset();
      this.preRing.fill(0);
      this.preRingPos = 0;
      this.preRingFilled = 0;

      this.state = 'IDLE'; // 'IDLE' | 'CAPTURE' | 'SUSTAINED_WAIT'
      this.totalSamples = 0;
      this.clockAnchorSec = null;
      this.clockAnchorSample = 0;

      this.frameSqSum = 0;
      this.framePeak = 0;
      this.frameCount = 0;

      // Adaptive noise floor & short pre-onset history (12 ms)
      this.noiseFloorRms = 0.00035;
      this.floorInitialized = false;
      this.recentRms = new Float64Array(12);
      this.recentRmsPos = 0;
      this.recentRmsCount = 0;

      this.refractoryUntilMs = -1000;
      this.captureLen = 0;
      this.capturePreLen = 0;
      this.captureStartMs = 0;
      this.captureElapsedMs = 0;
      this.capturePeakRms = 0;
      this.capturePeakAbs = 0;
      this.capturePeakElapsedMs = 0;
      this.captureLastActiveMs = 0;
      this.captureQuietStreakMs = 0;

      this.sustainedElapsedMs = 0;
      this.sustainedQuietMs = 0;
    }

    _currentTimeMs() {
      return (this.totalSamples * 1000) / this.sampleRate;
    }

    _currentTimeSec() {
      if (this.clockAnchorSec !== null) {
        return this.clockAnchorSec + (this.totalSamples - this.clockAnchorSample) / this.sampleRate;
      }
      return this.totalSamples / this.sampleRate;
    }

    _recentAvgRms() {
      if (this.recentRmsCount === 0) return this.noiseFloorRms;
      let sum = 0;
      for (let i = 0; i < this.recentRmsCount; i++) sum += this.recentRms[i];
      return sum / this.recentRmsCount;
    }

    _pushRecentRms(v) {
      this.recentRms[this.recentRmsPos] = v;
      this.recentRmsPos = (this.recentRmsPos + 1) % this.recentRms.length;
      if (this.recentRmsCount < this.recentRms.length) this.recentRmsCount++;
    }

    _copyPreRollIntoCapture() {
      const count = Math.min(this.preRingFilled, this.preRollSamples);
      const start = (this.preRingPos - count + this.preRollSamples) % this.preRollSamples;
      for (let i = 0; i < count; i++) {
        this.captureBuf[i] = this.preRing[(start + i) % this.preRollSamples];
      }
      this.capturePreLen = count;
      this.captureLen = count;
    }

    /**
     * Feed a block of mono audio samples (arbitrary length, e.g. 128, 512, or full waveform).
     * Returns an array of discrete events (`tapCandidate` or `veto`).
     */
    processBlock(samples, sampleRate, timeSec) {
      if (!samples || !samples.length) return [];
      const sr = Number.isFinite(sampleRate) && sampleRate >= 8000 ? sampleRate : this.sampleRate;
      if (Math.abs(sr - this.sampleRate) > 1) {
        this._initForSampleRate(sr);
      }
      if (Number.isFinite(timeSec) && this.clockAnchorSec === null) {
        this.clockAnchorSec = timeSec;
        this.clockAnchorSample = this.totalSamples;
      }

      const events = [];
      const n = samples.length;

      for (let i = 0; i < n; i++) {
        const y = this.filter.process(samples[i]);
        this.totalSamples++;

        // Always maintain pre-trigger ring buffer in IDLE (and capture buffer during CAPTURE)
        if (this.state === 'CAPTURE') {
          if (this.captureLen < this.captureBuf.length) {
            this.captureBuf[this.captureLen++] = y;
          }
        }
        this.preRing[this.preRingPos] = y;
        this.preRingPos = (this.preRingPos + 1) % this.preRollSamples;
        if (this.preRingFilled < this.preRollSamples) this.preRingFilled++;

        const absY = Math.abs(y);
        this.frameSqSum += y * y;
        if (absY > this.framePeak) this.framePeak = absY;
        this.frameCount++;

        if (this.frameCount >= this.frameSamples) {
          const rms = Math.sqrt(this.frameSqSum / this.frameCount);
          const peak = this.framePeak;
          this.frameSqSum = 0;
          this.framePeak = 0;
          this.frameCount = 0;

          const ev = this._onMicroFrame(rms, peak);
          if (ev) events.push(ev);
        }
      }

      return events;
    }

    _onMicroFrame(rms, peak) {
      const nowMs = this._currentTimeMs();

      if (!this.floorInitialized) {
        this.noiseFloorRms = Math.max(0.00012, Math.min(rms, 0.015));
        this.floorInitialized = true;
        this._pushRecentRms(rms);
        return null;
      }

      if (this.state === 'IDLE') {
        const floor = Math.max(0.00012, this.noiseFloorRms);
        const recentAvg = Math.max(floor, this._recentAvgRms());
        const rmsThresh = Math.max(floor * this.triggerSnrRatio, this.minTriggerRms);
        const peakThresh = Math.max(floor * 6.0, this.minTriggerRms * 2.2);

        const sharpStep = rms > recentAvg * 2.15 || peak > recentAvg * 4.2;
        const aboveFloor = rms > rmsThresh || (peak > peakThresh && rms > floor * 2.8);

        if (aboveFloor && sharpStep && nowMs >= this.refractoryUntilMs) {
          this._copyPreRollIntoCapture();
          this.state = 'CAPTURE';
          this.captureStartMs = nowMs;
          this.captureElapsedMs = this.frameMs;
          this.capturePeakRms = rms;
          this.capturePeakAbs = peak;
          this.capturePeakElapsedMs = this.frameMs;
          this.captureLastActiveMs = this.frameMs;
          this.captureQuietStreakMs = 0;
          return null;
        }

        // Update adaptive noise floor smoothly while IDLE (fast downward, slow upward)
        const alpha = rms < this.noiseFloorRms ? 0.07 : 0.0022;
        const clampedSample = Math.min(rms, this.noiseFloorRms * 2.8 + 0.0008);
        this.noiseFloorRms = Math.max(0.00012, this.noiseFloorRms + alpha * (clampedSample - this.noiseFloorRms));
        this._pushRecentRms(rms);
        return null;
      }

      if (this.state === 'SUSTAINED_WAIT') {
        this.sustainedElapsedMs += this.frameMs;
        const quietCutoff = Math.max(this.noiseFloorRms * 2.35, this.minTriggerRms * 0.9);
        if (rms < quietCutoff) {
          this.sustainedQuietMs += this.frameMs;
          if (this.sustainedQuietMs >= 36) {
            this.state = 'IDLE';
            this.refractoryUntilMs = Math.max(this.refractoryUntilMs, nowMs + 35);
            this._pushRecentRms(rms);
          }
        } else {
          this.sustainedQuietMs = 0;
          // Fan/HVAC spin-up recovery: if constant steady noise persists > 550 ms, adapt floor up
          if (this.sustainedElapsedMs > 550) {
            this.noiseFloorRms += 0.008 * (rms - this.noiseFloorRms);
            if (rms < this.noiseFloorRms * 1.9) {
              this.state = 'IDLE';
              this.refractoryUntilMs = Math.max(this.refractoryUntilMs, nowMs + 50);
            }
          }
        }
        return null;
      }

      // state === 'CAPTURE'
      this.captureElapsedMs += this.frameMs;
      if (rms > this.capturePeakRms) {
        this.capturePeakRms = rms;
        this.capturePeakElapsedMs = this.captureElapsedMs;
      }
      if (peak > this.capturePeakAbs) {
        this.capturePeakAbs = peak;
      }

      const activeCutoff = Math.max(this.noiseFloorRms * 2.5, this.capturePeakRms * 0.16, this.minTriggerRms * 0.65);
      if (rms >= activeCutoff) {
        this.captureLastActiveMs = this.captureElapsedMs;
        this.captureQuietStreakMs = 0;
      } else {
        this.captureQuietStreakMs += this.frameMs;
      }

      // 1. Sustained (> 90 ms) speech/swipe rejection check
      if (this.captureElapsedMs >= this.sustainedVetoMs) {
        const stillActive = this.captureQuietStreakMs < 14 || this.captureLastActiveMs > this.maxTapMs;
        if (stillActive) {
          const vetoDur = Math.round(this.captureElapsedMs);
          this.state = 'SUSTAINED_WAIT';
          this.sustainedElapsedMs = this.captureElapsedMs;
          this.sustainedQuietMs = 0;
          return {
            type: 'veto',
            reason: 'sustained',
            durationMs: vetoDur,
            timeSec: this._currentTimeSec()
          };
        }
        return this._finalizeCapture();
      }

      // 2. Early crisp tap commit once >= 52 ms elapsed (covers full 0–35 ms decay window)
      //    and confirmed quiet settle (>= 18 ms quiet streak)
      if (this.captureElapsedMs >= 52 && this.captureQuietStreakMs >= 18) {
        return this._finalizeCapture();
      }

      return null;
    }

    _finalizeCapture() {
      const sr = this.sampleRate;
      const len = this.captureLen;
      const buf = this.captureBuf;
      const nowMs = this._currentTimeMs();
      const timeSec = this._currentTimeSec();

      // Always return to IDLE after finalizing a bounded transient
      this.state = 'IDLE';

      if (len < Math.round(sr * 0.036)) {
        return null;
      }

      // Compute broadband 1.2 ms moving-RMS envelope for amplitude/duration gating AND
      // a >280 Hz flexural+air 1.2 ms moving-RMS envelope for phase-invariant riseTimeMs
      // (prevents 112 Hz sub-bass half-cycle beats from shifting peak by +4.5 ms!).
      const win = Math.max(12, Math.round(sr * 0.0012));
      const env = new Float32Array(len);
      const dispEnv = new Float32Array(len);
      const dispHpf = new BiquadFilter('highpass', 280, sr, Math.SQRT1_2);
      const dispBuf = new Float32Array(len);

      let sqSum = 0;
      let dispSqSum = 0;
      let peakEnv = 0;
      let peakEnvIdx = this.capturePreLen;
      let dispPeakEnv = 0;
      let dispPeakIdx = this.capturePreLen;
      let peakAbs = 0;

      // Peak of a true tap occurs within the first 35 ms after trigger
      const searchStart = Math.max(0, this.capturePreLen - Math.round(sr * 0.006));
      const searchEnd = Math.min(len, this.capturePreLen + Math.round(sr * 0.038));

      for (let i = 0; i < len; i++) {
        const x = buf[i];
        const ax = Math.abs(x);
        if (i >= searchStart && i < searchEnd && ax > peakAbs) {
          peakAbs = ax;
        }
        sqSum += x * x;
        if (i >= win) {
          const old = buf[i - win];
          sqSum -= old * old;
          if (sqSum < 0) sqSum = 0;
        }
        const e = Math.sqrt(sqSum / Math.min(i + 1, win));
        env[i] = e;
        if (i >= searchStart && i < searchEnd && e > peakEnv) {
          peakEnv = e;
          peakEnvIdx = i;
        }

        const xd = dispHpf.process(x);
        dispBuf[i] = xd;
        dispSqSum += xd * xd;
        if (i >= win) {
          const oldD = dispBuf[i - win];
          dispSqSum -= oldD * oldD;
          if (dispSqSum < 0) dispSqSum = 0;
        }
        const ed = Math.sqrt(dispSqSum / Math.min(i + 1, win));
        dispEnv[i] = ed;
        if (i >= searchStart && i < searchEnd && ed > dispPeakEnv) {
          dispPeakEnv = ed;
          dispPeakIdx = i;
        }
      }

      if (peakEnv < this.minTriggerRms * 0.9 || peakAbs < this.minTriggerRms * 1.4) {
        return null;
      }

      // Forward-scan from quiet pre-roll to find true leading arrival edge (never fooled
      // by mid-attack modal interference troughs that break backward scans!).
      const onsetThresh = Math.max(peakEnv * 0.1, this.noiseFloorRms * 2.5);
      const maxBack = Math.round(sr * 0.016);
      const scanStart = Math.max(0, Math.min(this.capturePreLen - Math.round(sr * 0.01), peakEnvIdx - maxBack));
      let onsetIdx = peakEnvIdx;
      for (let i = scanStart; i <= peakEnvIdx; i++) {
        if (env[i] >= onsetThresh) {
          onsetIdx = i;
          break;
        }
      }
      onsetIdx = clamp(onsetIdx, 0, Math.max(0, len - 1));

      // Compute dispersive onset-to-peak riseTimeMs on >280 Hz flexural+air envelope
      // (falling back to broadband envelope if >280 Hz energy is negligible).
      let riseTimeMs;
      if (dispPeakEnv >= peakEnv * 0.14) {
        const dispOnsetThresh = Math.max(dispPeakEnv * 0.1, this.noiseFloorRms * 2.2);
        const dispScanStart = Math.max(0, Math.min(onsetIdx, dispPeakIdx - maxBack));
        let dispOnsetIdx = dispPeakIdx;
        for (let i = dispScanStart; i <= dispPeakIdx; i++) {
          if (dispEnv[i] >= dispOnsetThresh) {
            dispOnsetIdx = i;
            break;
          }
        }
        riseTimeMs = clamp(((dispPeakIdx - dispOnsetIdx) * 1000) / sr, 0.25, 25.0);
      } else {
        riseTimeMs = clamp(((peakEnvIdx - onsetIdx) * 1000) / sr, 0.25, 25.0);
      }

      // Measure active impulse width (-16 dB from peak = 0.16 * peakEnv, above floor)
      const tailThresh = Math.max(peakEnv * 0.16, this.noiseFloorRms * 2.4);
      let endIdx = peakEnvIdx;
      for (let i = peakEnvIdx; i < len; i++) {
        if (env[i] >= tailThresh) {
          endIdx = i;
        }
      }

      const durationMs = ((endIdx - onsetIdx) * 1000) / sr;

      // Check late tail energy (55–85 ms) vs early energy (0–35 ms) to catch slow-fading speech/swipes
      const earlyEnd = Math.min(len, onsetIdx + Math.round(sr * 0.035));
      const lateStart = Math.min(len, onsetIdx + Math.round(sr * 0.055));
      const lateEnd = Math.min(len, onsetIdx + Math.round(sr * 0.085));
      let earlyPow = 0;
      for (let i = onsetIdx; i < earlyEnd; i++) earlyPow += buf[i] * buf[i];
      earlyPow /= Math.max(1, earlyEnd - onsetIdx);

      let latePow = 0;
      if (lateEnd > lateStart + 16) {
        for (let i = lateStart; i < lateEnd; i++) latePow += buf[i] * buf[i];
        latePow /= lateEnd - lateStart;
      }
      const lateToEarlyRatio = latePow / (earlyPow + 1e-12);

      // Crisp physical tap gate: reject electrical micro-glitches (< minTapMs), slow swells, or sustained > 90 ms
      if (durationMs < this.minTapMs) {
        return { type: 'veto', reason: 'glitch', durationMs, timeSec };
      }
      if (durationMs > this.maxTapMs || lateToEarlyRatio > 0.28) {
        this.state = 'SUSTAINED_WAIT';
        this.sustainedElapsedMs = durationMs;
        this.sustainedQuietMs = 0;
        return { type: 'veto', reason: 'sustained', durationMs, timeSec };
      }
      if (riseTimeMs > 16.0) {
        return { type: 'veto', reason: 'slow-onset', durationMs, timeSec };
      }

      // Extract the 6D vibro-acoustic feature vector
      const features = this._extractFeatures(buf, len, onsetIdx, peakAbs, riseTimeMs);

      // Enforce 110 ms refractory cooldown anchored from the tap onset
      const tapOnsetMs = this.captureStartMs;
      this.refractoryUntilMs = Math.max(nowMs + 15, tapOnsetMs + this.refractoryMs);

      return {
        type: 'tapCandidate',
        features,
        durationMs: Math.round(durationMs * 10) / 10,
        timeSec
      };
    }

    _extractFeatures(buf, len, onsetIdx, peakAbs, riseTimeMs) {
      const sr = this.sampleRate;
      const N = this.fftSize;
      const re = this.fftRe;
      const im = this.fftIm;
      re.fill(0);
      im.fill(0);

      // Left-aligned asymmetric Tukey window starting 1.5 ms before onset so the leading
      // direct-air HF crack stays at 1.0 gain (zero Hann leading-edge attenuation!)
      const prePad = Math.round(sr * 0.0015);
      const winStart = Math.max(0, onsetIdx - prePad);
      const avail = Math.min(N, len - winStart);
      const fadeIn = Math.max(8, Math.round(sr * 0.0012));
      const fadeOut = Math.max(16, Math.round(sr * 0.006));

      for (let i = 0; i < avail; i++) {
        let w = 1.0;
        if (i < fadeIn) {
          w = 0.5 * (1 - Math.cos((Math.PI * i) / fadeIn));
        } else if (i > avail - fadeOut) {
          const rem = avail - 1 - i;
          w = 0.5 * (1 - Math.cos((Math.PI * Math.max(0, rem)) / fadeOut));
        }
        re[i] = buf[winStart + i] * w;
      }

      fftRadix2(re, im);

      const binHz = sr / N;
      const maxBin = Math.min((N >> 1) - 1, Math.floor(Math.min(14950, sr * 0.46) / binHz));
      const bSubLo = Math.max(1, Math.round(60 / binHz));
      const bSubHi = Math.min(maxBin, Math.round(350 / binHz));
      const bMidLo = Math.max(1, Math.round(400 / binHz));
      const bMidHi = Math.min(maxBin, Math.round(2200 / binHz));
      const bHfLo = Math.max(1, Math.round(3500 / binHz));
      const bHfHi = Math.min(maxBin, Math.round(Math.min(14500, sr * 0.45) / binHz));

      let eTotal = 0;
      let eSub = 0;
      let eMid = 0;
      let eHf = 0;

      for (let k = bSubLo; k <= maxBin; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        eTotal += p;
        if (k <= bSubHi) eSub += p;
        if (k >= bMidLo && k <= bMidHi) eMid += p;
        if (k >= bHfLo && k <= bHfHi) eHf += p;
      }

      const eps = 1e-14;
      const subBassRatioDb = clamp(10 * Math.log10((eSub + eps) / (eTotal + eps)), -45, 0);
      const midPlateRatioDb = clamp(10 * Math.log10((eMid + eps) / (eTotal + eps)), -45, 0);
      const hfAirRatioDb = clamp(10 * Math.log10((eHf + eps) / (eTotal + eps)), -45, 0);

      // Early (0–12 ms) vs Tail (12–35 ms) RMS plate-ring decay ratio
      const idx0 = onsetIdx;
      const idx12 = Math.min(len, onsetIdx + Math.round(sr * 0.012));
      const idx35 = Math.min(len, onsetIdx + Math.round(sr * 0.035));

      let earlySq = 0;
      for (let i = idx0; i < idx12; i++) earlySq += buf[i] * buf[i];
      const earlyRms = Math.sqrt(earlySq / Math.max(1, idx12 - idx0));

      let tailSq = 0;
      for (let i = idx12; i < idx35; i++) tailSq += buf[i] * buf[i];
      const tailRms = Math.sqrt(tailSq / Math.max(1, idx35 - idx12));

      const decayRatio = clamp(earlyRms / Math.max(tailRms, this.noiseFloorRms * 0.5, 1e-6), 0.2, 20.0);
      const peakDb = clamp(20 * Math.log10(peakAbs + 1e-9), -96, 0);

      return {
        subBassRatioDb: Math.round(subBassRatioDb * 100) / 100,
        midPlateRatioDb: Math.round(midPlateRatioDb * 100) / 100,
        hfAirRatioDb: Math.round(hfAirRatioDb * 100) / 100,
        riseTimeMs: Math.round(riseTimeMs * 100) / 100,
        decayRatio: Math.round(decayRatio * 100) / 100,
        peakDb: Math.round(peakDb * 100) / 100
      };
    }
  }

  /**
   * Combined Engine pairing `TapZoneDetector` + `TapZoneClassifier`.
   */
  class TapZoneEngine {
    constructor(options = {}) {
      this.detector = new TapZoneDetector(options);
      this.classifier = new TapZoneClassifier(options);
    }

    reset() {
      this.detector.reset();
    }

    processBlock(samples, sampleRate, timeSec) {
      const rawEvents = this.detector.processBlock(samples, sampleRate, timeSec);
      const out = [];
      for (let i = 0; i < rawEvents.length; i++) {
        const ev = rawEvents[i];
        if (ev.type === 'tapCandidate') {
          const cls = this.classifier.classify(ev.features);
          out.push({
            type: 'tap',
            zone: cls.zone,
            label: cls.label,
            shortLabel: cls.shortLabel,
            confidence: cls.confidence,
            distance: cls.distance,
            distances: cls.distances,
            probabilities: cls.probabilities,
            calibrated: cls.calibrated,
            features: ev.features,
            durationMs: ev.durationMs,
            timeSec: ev.timeSec
          });
        } else {
          out.push(ev);
        }
      }
      return out;
    }
  }

  // ---------------------------------------------------------------------------
  // Physical 48 kHz Chassis Tap & Disturbance Synthesizers (Testing + UI Sim)
  // ---------------------------------------------------------------------------

  const ZONE_SYNTH_PROFILES = {
    'top-left': {
      tPeakMs: 1.35,
      alpha: 2.1,
      subAmp: 0.085,
      subTauMs: 10.5,
      midAmp: 0.36,
      midTauMs: 10.5,
      hfAmp: 0.92,
      hfTauMs: 6.5,
      masterGain: 0.25
    },
    'left-palm': {
      tPeakMs: 3.1,
      alpha: 2.6,
      subAmp: 0.72,
      subTauMs: 17.5,
      midAmp: 0.48,
      midTauMs: 14.0,
      hfAmp: 0.33,
      hfTauMs: 7.5,
      masterGain: 0.165
    },
    'trackpad-rim': {
      tPeakMs: 4.1,
      alpha: 2.8,
      subAmp: 0.15,
      subTauMs: 12.0,
      midAmp: 0.88,
      midTauMs: 14.5,
      hfAmp: 0.30,
      hfTauMs: 8.5,
      masterGain: 0.145
    },
    'right-palm': {
      tPeakMs: 7.4,
      alpha: 3.2,
      subAmp: 0.40,
      subTauMs: 24.0,
      midAmp: 0.92,
      midTauMs: 26.5,
      hfAmp: 0.08,
      hfTauMs: 12.0,
      masterGain: 0.085
    }
  };

  /**
   * Synthesize a realistic vibro-acoustic MacBook Pro chassis tap waveform at `sampleRate`.
   * Includes quiet ambient pre-roll (`preSec`) and post-roll (`postSec`) so feeding
   * straight into `TapZoneEngine` exercises the entire onset, duration, and 6D pipeline.
   */
  function synthesizeZoneTap(zoneId, options = {}) {
    const profile = ZONE_SYNTH_PROFILES[zoneId] || ZONE_SYNTH_PROFILES['top-left'];
    const sr = Number.isFinite(options.sampleRate) ? options.sampleRate : 48000;
    const preSec = Number.isFinite(options.preSec) ? options.preSec : 0.08;
    const postSec = Number.isFinite(options.postSec) ? options.postSec : 0.11;
    const gainScale = Number.isFinite(options.gainScale) ? options.gainScale : 1.0;
    const noiseFloor = Number.isFinite(options.noiseFloor) ? options.noiseFloor : 0.00045;
    const sonarAmp = Number.isFinite(options.sonarAmp) ? options.sonarAmp : 0;
    const pitchShift = Number.isFinite(options.pitchShift) ? options.pitchShift : 1.0;
    const rand = createPrng(options.seed !== undefined ? options.seed : 0x51a7f321);

    const totalSamples = Math.round((preSec + postSec) * sr);
    const onsetSample = Math.round(preSec * sr);
    const out = new Float32Array(totalSamples);

    const hfBand1 = new BiquadFilter('bandpass', Math.min(7200 * pitchShift, sr * 0.42), sr, 1.1);
    const hfBand2 = new BiquadFilter('bandpass', Math.min(10800 * pitchShift, sr * 0.43), sr, 1.3);
    const midNoiseBp = new BiquadFilter('bandpass', 1150 * pitchShift, sr, 1.2);
    const subNoiseBp = new BiquadFilter('bandpass', 175 * pitchShift, sr, 1.4);

    // Random initial modal phases for organic tap realism
    const p1 = rand() * Math.PI * 2;
    const p2 = rand() * Math.PI * 2;
    const p3 = rand() * Math.PI * 2;
    const p4 = rand() * Math.PI * 2;

    const tPeakSec = Math.max(0.0006, (profile.tPeakMs / 1000) * (options.riseScale || 1.0));
    const alpha = profile.alpha;
    const subTau = (profile.subTauMs / 1000) * (options.decayScale || 1.0);
    const midTau = (profile.midTauMs / 1000) * (options.decayScale || 1.0);
    const hfTau = (profile.hfTauMs / 1000) * (options.decayScale || 1.0);

    for (let n = 0; n < totalSamples; n++) {
      // Quiet room noise floor
      const wn = (rand() - 0.5) * 2;
      let x = wn * noiseFloor;

      // Optional 18.375–21.375 kHz ultrasonic sonar interference (must be rejected <16 kHz!)
      if (sonarAmp > 0) {
        const tAbs = n / sr;
        x +=
          sonarAmp *
          0.25 *
          (Math.sin(2 * Math.PI * 18375 * tAbs) +
            Math.sin(2 * Math.PI * 19125 * tAbs + 0.7) +
            Math.sin(2 * Math.PI * 20250 * tAbs + 1.9) +
            Math.sin(2 * Math.PI * 21375 * tAbs + 3.1));
      }

      if (n >= onsetSample) {
        const t = (n - onsetSample) / sr;
        if (t < 0.065) {
          // Dispersive onset-to-peak gamma shaping envelope
          const ratio = Math.max(1e-6, t / tPeakSec);
          const gammaEnv = Math.pow(ratio, alpha) * Math.exp(alpha * (1 - ratio));
          const onsetRamp = Math.min(1, Math.pow(ratio, alpha * 0.85));

          const excitation = (rand() - 0.5) * 2;

          // Sub-bass corner woofer-chamber cavity resonance (60–350 Hz)
          const subEnv = onsetRamp * Math.exp(-t / subTau);
          const subTone =
            0.55 * Math.sin(2 * Math.PI * 112 * pitchShift * t + p1) +
            0.35 * Math.sin(2 * Math.PI * 192 * pitchShift * t + p2) +
            0.22 * Math.sin(2 * Math.PI * 278 * pitchShift * t + p3) +
            0.45 * subNoiseBp.process(excitation);

          // Mid aluminum A0 flexural Lamb plate resonance (400–2200 Hz)
          const midEnv = (0.35 * gammaEnv + 0.65 * onsetRamp * Math.exp(-t / midTau));
          const midTone =
            0.42 * Math.sin(2 * Math.PI * 585 * pitchShift * t + p2) +
            0.38 * Math.sin(2 * Math.PI * 1020 * pitchShift * t + p3) +
            0.30 * Math.sin(2 * Math.PI * 1540 * pitchShift * t + p4) +
            0.22 * Math.sin(2 * Math.PI * 1960 * pitchShift * t + p1) +
            0.75 * midNoiseBp.process(excitation);

          // Direct air-coupled HF transient crack (3500–14500 Hz)
          const hfEnv = (0.55 * gammaEnv + 0.45 * onsetRamp * Math.exp(-t / hfTau));
          const hfSignal =
            1.4 * hfBand1.process(excitation) + 1.45 * hfBand2.process(excitation);

          const tapSample =
            profile.subAmp * subEnv * subTone +
            profile.midAmp * midEnv * midTone +
            profile.hfAmp * hfEnv * hfSignal;

          x += tapSample * profile.masterGain * gainScale;
        }
      }

      out[n] = clamp(x, -0.99, 0.99);
    }

    return out;
  }

  /**
   * Synthesize sustained speech/swipe (> 90 ms) for veto testing.
   */
  function synthesizeSustainedSpeech(options = {}) {
    const sr = Number.isFinite(options.sampleRate) ? options.sampleRate : 48000;
    const preSec = Number.isFinite(options.preSec) ? options.preSec : 0.08;
    const durSec = Number.isFinite(options.durationSec) ? options.durationSec : 0.24;
    const postSec = Number.isFinite(options.postSec) ? options.postSec : 0.1;
    const amp = Number.isFinite(options.amplitude) ? options.amplitude : 0.14;
    const rand = createPrng(options.seed !== undefined ? options.seed : 0x9931a02b);

    const total = Math.round((preSec + durSec + postSec) * sr);
    const s0 = Math.round(preSec * sr);
    const s1 = s0 + Math.round(durSec * sr);
    const out = new Float32Array(total);
    const fricBp = new BiquadFilter('bandpass', 4200, sr, 1.2);

    for (let n = 0; n < total; n++) {
      let x = (rand() - 0.5) * 0.0008;
      if (n >= s0 && n < s1) {
        const prog = (n - s0) / Math.max(1, s1 - s0);
        const t = (n - s0) / sr;
        const env = prog < 0.08 ? prog / 0.08 : prog > 0.88 ? (1 - prog) / 0.12 : 1.0;
        const vowel =
          0.45 * Math.sin(2 * Math.PI * 165 * t) +
          0.35 * Math.sin(2 * Math.PI * 495 * t) +
          0.25 * Math.sin(2 * Math.PI * 1180 * t) +
          0.35 * fricBp.process((rand() - 0.5) * 2);
        x += amp * env * vowel;
      }
      out[n] = clamp(x, -0.99, 0.99);
    }
    return out;
  }

  /**
   * Synthesize pulsed 18–21 kHz ultrasonic sonar burst (must produce ZERO tap detections).
   */
  function synthesizeUltrasonicBurst(options = {}) {
    const sr = Number.isFinite(options.sampleRate) ? options.sampleRate : 48000;
    const preSec = Number.isFinite(options.preSec) ? options.preSec : 0.08;
    const durSec = Number.isFinite(options.durationSec) ? options.durationSec : 0.025;
    const postSec = Number.isFinite(options.postSec) ? options.postSec : 0.1;
    const amp = Number.isFinite(options.amplitude) ? options.amplitude : 0.35;
    const rand = createPrng(options.seed !== undefined ? options.seed : 0x7712b401);

    const total = Math.round((preSec + durSec + postSec) * sr);
    const s0 = Math.round(preSec * sr);
    const s1 = s0 + Math.round(durSec * sr);
    const out = new Float32Array(total);

    for (let n = 0; n < total; n++) {
      let x = (rand() - 0.5) * 0.0006;
      if (n >= s0 && n < s1) {
        const prog = (n - s0) / Math.max(1, s1 - s0);
        const t = n / sr;
        // Smooth 3 ms cosine taper so burst edges stay ultrasonic (> 18 kHz)
        const env = Math.sin(Math.PI * prog);
        x +=
          amp *
          env *
          0.25 *
          (Math.sin(2 * Math.PI * 18375 * t) +
            Math.sin(2 * Math.PI * 19125 * t) +
            Math.sin(2 * Math.PI * 20250 * t) +
            Math.sin(2 * Math.PI * 21375 * t));
      }
      out[n] = clamp(x, -0.99, 0.99);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // DOM / SVG Helpers (Zero innerHTML — Strict XSS Safety)
  // ---------------------------------------------------------------------------

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      const keys = Object.keys(attrs);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'className') el.className = v;
        else if (k === 'textContent') el.textContent = String(v);
        else if (k === 'dataset') {
          const dks = Object.keys(v);
          for (let j = 0; j < dks.length; j++) {
            const dk = dks[j];
            if (v[dk] !== undefined && v[dk] !== null) el.dataset[dk] = String(v[dk]);
          }
        } else if (k.startsWith('on') && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v === true) {
          el.setAttribute(k, '');
        } else {
          el.setAttribute(k, String(v));
        }
      }
    }
    if (children !== undefined && children !== null) {
      const list = Array.isArray(children) ? children : [children];
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c === undefined || c === null || c === false) continue;
        if (typeof c === 'string' || typeof c === 'number') {
          el.appendChild(document.createTextNode(String(c)));
        } else {
          el.appendChild(c);
        }
      }
    }
    return el;
  }

  function svgEl(tag, attrs, children) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      const keys = Object.keys(attrs);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (attrs[k] !== undefined && attrs[k] !== null) {
          node.setAttribute(k, String(attrs[k]));
        }
      }
    }
    if (children) {
      for (let i = 0; i < children.length; i++) {
        if (children[i]) node.appendChild(children[i]);
      }
    }
    return node;
  }

  // ---------------------------------------------------------------------------
  // Interactive MacBook Pro Unibody Chassis Map SVG Builder
  // ---------------------------------------------------------------------------

  function buildChassisMapSvg(onZoneTrigger) {
    const zoneGroups = {};
    const rippleRings = {};
    const zoneBadges = {};

    // Speaker grille perforation dots (left = top-left CNC 3-mic array highlighted, right = matching grille)
    const grilleDots = [];
    for (let r = 0; r < 14; r++) {
      const yFrac = r / 13;
      const cy = 28 + yFrac * 84;
      const isMicPort = yFrac >= 0.05 && yFrac <= 0.25;
      for (let c = 0; c < 4; c++) {
        const lx = 22 + c * 4.5;
        grilleDots.push(
          svgEl('circle', {
            cx: lx.toFixed(1),
            cy: cy.toFixed(1),
            r: isMicPort ? '1.25' : '0.9',
            fill: isMicPort ? '#141413' : '#b8b8b2',
            opacity: isMicPort ? '0.92' : '0.7'
          })
        );
        const rx = 284.5 + c * 4.5;
        grilleDots.push(
          svgEl('circle', {
            cx: rx.toFixed(1),
            cy: cy.toFixed(1),
            r: '0.9',
            fill: '#b8b8b2',
            opacity: '0.68'
          })
        );
      }
    }

    // Minimal Swiss keyboard keycap grid inside recessed deck well (acoustic barrier visual)
    const keysGroupChildren = [
      svgEl('rect', {
        x: '46',
        y: '24',
        width: '228',
        height: '92',
        rx: '5',
        fill: '#e9e9e5',
        stroke: '#d8d8d2',
        'stroke-width': '0.9'
      })
    ];
    const rowY = [29, 43, 57, 71, 85, 99];
    const rowH = [10, 11, 11, 11, 11, 12];
    const rowCols = [14, 14, 13, 12, 11, 8];
    for (let r = 0; r < rowY.length; r++) {
      const cols = rowCols[r];
      const padX = 51;
      const usableW = 218;
      const gap = 2.6;
      const keyW = (usableW - gap * (cols - 1)) / cols;
      for (let c = 0; c < cols; c++) {
        const kx = padX + c * (keyW + gap);
        keysGroupChildren.push(
          svgEl('rect', {
            x: kx.toFixed(1),
            y: rowY[r],
            width: keyW.toFixed(1),
            height: rowH[r],
            rx: '1.6',
            fill: '#f7f7f5',
            stroke: '#d8d8d2',
            'stroke-width': '0.6'
          })
        );
      }
    }

    // Acoustic propagation ray from detected zone -> Top-Left 3-Mic Array (`x=29, y=42`)
    const propRay = svgEl('line', {
      class: 'tz-prop-ray',
      x1: '29',
      y1: '42',
      x2: '29',
      y2: '42',
      'stroke-dasharray': '3 2.5',
      opacity: '0'
    });

    // Zone geometry definitions (clean non-overlapping clickable hit regions)
    const zoneRects = {
      'top-left': { x: 14, y: 18, width: 72, height: 68, rx: 6, labelX: 50, labelY: 79 },
      'left-palm': { x: 14, y: 122, width: 88, height: 68, rx: 6, labelX: 58, labelY: 162 },
      'trackpad-rim': { x: 108, y: 122, width: 104, height: 68, rx: 6, labelX: 160, labelY: 162 },
      'right-palm': { x: 218, y: 102, width: 88, height: 88, rx: 6, labelX: 262, labelY: 162 }
    };

    const zoneNodes = [];
    for (let i = 0; i < ZONE_ORDER.length; i++) {
      const zoneId = ZONE_ORDER[i];
      const meta = ZONES[zoneId];
      const geom = zoneRects[zoneId];

      const hitRect = svgEl('rect', {
        class: 'tz-zone-rect',
        x: geom.x,
        y: geom.y,
        width: geom.width,
        height: geom.height,
        rx: geom.rx
      });

      const ripple1 = svgEl('circle', {
        class: 'tz-ripple tz-ripple--outer',
        cx: meta.cx,
        cy: meta.cy,
        r: '8'
      });
      const ripple2 = svgEl('circle', {
        class: 'tz-ripple tz-ripple--inner',
        cx: meta.cx,
        cy: meta.cy,
        r: '5'
      });
      const targetDot = svgEl('circle', {
        class: 'tz-zone-dot',
        cx: meta.cx,
        cy: meta.cy,
        r: '3.2'
      });

      const codeText = svgEl('text', {
        class: 'tz-zone-code',
        x: geom.x + 6,
        y: geom.y + 12
      });
      codeText.textContent = meta.code;

      const nameText = svgEl('text', {
        class: 'tz-zone-label',
        x: geom.labelX,
        y: geom.labelY,
        'text-anchor': 'middle'
      });
      nameText.textContent = meta.shortLabel;

      const calBadge = svgEl('text', {
        class: 'tz-zone-cal-mark',
        x: geom.x + geom.width - 7,
        y: geom.y + 12,
        'text-anchor': 'end'
      });
      calBadge.textContent = '';

      const group = svgEl(
        'g',
        {
          class: `tz-zone tz-zone--${meta.accent}`,
          role: 'button',
          tabindex: '0',
          'data-zone': zoneId,
          'data-active': 'false',
          'data-cal-target': 'false',
          'aria-label': `Simulate chassis tap on ${meta.label} (${meta.hint})`
        },
        [hitRect, ripple1, ripple2, targetDot, codeText, nameText, calBadge]
      );

      group.addEventListener('click', (ev) => {
        ev.preventDefault();
        onZoneTrigger(zoneId);
      });
      group.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onZoneTrigger(zoneId);
        }
      });

      zoneGroups[zoneId] = group;
      rippleRings[zoneId] = [ripple1, ripple2];
      zoneBadges[zoneId] = calBadge;
      zoneNodes.push(group);
    }

    const micBadgeRect = svgEl('rect', {
      x: '17',
      y: '29',
      width: '24',
      height: '24',
      rx: '3',
      fill: 'none',
      stroke: '#0052cc',
      'stroke-width': '1',
      'stroke-dasharray': '2 1.8',
      opacity: '0.7'
    });
    const micCallout = svgEl('text', {
      class: 'tz-mic-tag',
      x: '29',
      y: '14',
      'text-anchor': 'middle'
    });
    micCallout.textContent = '3×MIC';

    const svg = svgEl(
      'svg',
      {
        class: 'tz-chassis-svg',
        viewBox: '0 0 320 206',
        preserveAspectRatio: 'xMidYMid meet',
        role: 'group',
        'aria-label': 'Interactive MacBook Pro unibody 4-zone chassis tap map'
      },
      [
        // Unibody chassis shell
        svgEl('rect', {
          x: '6',
          y: '6',
          width: '308',
          height: '194',
          rx: '13',
          fill: '#f1f1ed',
          stroke: '#d3d3cd',
          'stroke-width': '1.2'
        }),
        // Inner anodized chamfer border
        svgEl('rect', {
          x: '10',
          y: '10',
          width: '300',
          height: '186',
          rx: '10',
          fill: '#f6f6f3',
          stroke: '#e6e6e1',
          'stroke-width': '0.8'
        }),
        // Rear display hinge bar
        svgEl('rect', {
          x: '56',
          y: '6',
          width: '208',
          height: '6',
          rx: '2',
          fill: '#deded8'
        }),
        // Front center lid thumb-scoop notch
        svgEl('path', {
          d: 'M 134 200 C 138 195 142 194 160 194 C 178 194 182 195 186 200',
          fill: '#e4e4df',
          stroke: '#d3d3cd',
          'stroke-width': '0.8'
        }),
        // Left & right speaker grilles + 3-mic through-hole array
        svgEl('g', { 'aria-hidden': 'true' }, grilleDots),
        micBadgeRect,
        micCallout,
        // Keyboard recessed well
        svgEl('g', { 'aria-hidden': 'true' }, keysGroupChildren),
        // Force Touch trackpad bezel
        svgEl('rect', {
          x: '112',
          y: '126',
          width: '96',
          height: '60',
          rx: '5',
          fill: '#eeeeea',
          stroke: '#d5d5cf',
          'stroke-width': '0.9',
          'aria-hidden': 'true'
        }),
        // Wavefront propagation ray from active zone -> Top-Left 3-mic array
        propRay,
        // 4 interactive tap zones
        ...zoneNodes
      ]
    );

    return { svg, zoneGroups, rippleRings, zoneBadges, propRay };
  }

  // ---------------------------------------------------------------------------
  // Secondary Grid Cell 02 Mount (`mountTapZonesCell`)
  // ---------------------------------------------------------------------------

  function mountTapZonesCell(cellEl, bus) {
    if (!cellEl) return null;

    cellEl.classList.add('tz-cell');
    while (cellEl.firstChild) cellEl.removeChild(cellEl.firstChild);

    const savedCal = loadStoredCalibration();
    const engine = new TapZoneEngine({ calibration: savedCal });

    let busState = { state: 'idle', sampleRate: 48000, txMode: 'off', error: '' };
    let localPaused = false;
    let activePulseTimer = null;
    let vetoFlashTimer = null;
    let announceTimer = null;
    let simSeedCounter = 1;

    // 4-Zone Calibration Wizard State
    let calActive = false;
    let calStepIdx = 0;
    let calCaptured = {};

    // Screen-reader live region
    const srLive = h('div', {
      className: 'tz-sr-only',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true'
    });

    function announce(msg) {
      srLive.textContent = '';
      if (announceTimer) clearTimeout(announceTimer);
      announceTimer = setTimeout(() => {
        srLive.textContent = msg;
      }, 20);
    }

    // 1. Top Bezel
    const armDot = h('span', { className: 'tz-dot', 'aria-hidden': 'true' });
    const armText = h('span', { textContent: 'ARM' });
    const armBtn = h(
      'button',
      {
        type: 'button',
        className: 'tz-btn tz-btn--arm',
        dataset: { armed: 'false' },
        'aria-pressed': 'false',
        title: 'Arm shared 48 kHz microphone bus (or pause local tap detection)',
        onClick: () => handleArmClick()
      },
      [armDot, armText]
    );

    const statusPill = h('span', {
      className: 'tz-status',
      textContent: savedCal ? 'CAL · TAP MAP' : 'READY · TAP MAP'
    });

    const calBtn = h(
      'button',
      {
        type: 'button',
        className: 'tz-btn tz-btn--cal',
        dataset: { calibrated: savedCal ? 'true' : 'false' },
        'aria-expanded': 'false',
        title: '1-tap-per-zone quick chassis calibration (saved to localStorage)',
        onClick: () => toggleCalibration()
      },
      ['CAL 4Z']
    );

    const bezel = h('div', { className: 'tz-bezel' }, [
      h('div', { className: 'tz-bezel-group' }, [
        h('span', { className: 'tz-kicker', textContent: '02' }),
        h('span', { className: 'tz-title', textContent: 'Tap Zones' }),
        armBtn
      ]),
      h('div', { className: 'tz-bezel-group tz-bezel-group--right' }, [statusPill, calBtn])
    ]);

    // 2. Center Chassis Map Stage + Docked Calibration / Notice Bar
    const chassisMap = buildChassisMapSvg((zoneId) => runSimulatedZoneTap(zoneId));

    const calBarMsg = h('span', { className: 'tz-cal-msg', textContent: '' });
    const calResetBtn = h(
      'button',
      {
        type: 'button',
        className: 'tz-mini-btn',
        title: 'Restore MacBook Pro factory centroids',
        onClick: () => resetCalibration()
      },
      ['Reset']
    );
    const calCancelBtn = h(
      'button',
      {
        type: 'button',
        className: 'tz-mini-btn',
        onClick: () => cancelCalibration()
      },
      ['Done']
    );

    const calBar = h(
      'div',
      { className: 'tz-cal-bar', hidden: true, role: 'region', 'aria-label': '4-Zone Calibration' },
      [calBarMsg, h('div', { className: 'tz-cal-actions' }, [calResetBtn, calCancelBtn])]
    );

    const mapWell = h('div', { className: 'tz-map-well' }, [chassisMap.svg, calBar]);

    // 3. Bottom Telemetry Strip
    const zoneVal = h('span', { className: 'tz-metric-val tz-zone-val', textContent: 'TAP CHASSIS' });
    const confPill = h('span', { className: 'tz-conf-pill', textContent: '—' });
    const zoneSub = h('span', { className: 'tz-metric-sub', textContent: '4-zone <16kHz DSP' });

    const riseVal = h('span', { className: 'tz-metric-val', textContent: '— ms' });
    const decaySub = h('span', { className: 'tz-metric-sub', textContent: 'DEC —×' });

    const hfVal = h('span', { className: 'tz-metric-val', textContent: '— dB' });
    const subBassSub = h('span', { className: 'tz-metric-sub', textContent: 'SUB —dB' });

    const telemetry = h('div', { className: 'tz-telemetry' }, [
      h('div', { className: 'tz-card tz-card--zone' }, [
        h('div', { className: 'tz-card-head' }, [
          h('span', { className: 'tz-label', textContent: 'Zone' }),
          confPill
        ]),
        zoneVal,
        zoneSub
      ]),
      h('div', { className: 'tz-card' }, [
        h('span', { className: 'tz-label', textContent: 'Rise' }),
        riseVal,
        decaySub
      ]),
      h('div', { className: 'tz-card' }, [
        h('span', { className: 'tz-label', textContent: 'HF Tilt' }),
        hfVal,
        subBassSub
      ])
    ]);

    const stage = h('div', { className: 'tz-stage' }, [bezel, mapWell, telemetry, srLive]);
    cellEl.appendChild(stage);

    // -------------------------------------------------------------------------
    // UI State Helpers
    // -------------------------------------------------------------------------

    function refreshCalBadges() {
      const isCal = engine.classifier.isCalibrated();
      calBtn.dataset.calibrated = isCal ? 'true' : 'false';
      for (let i = 0; i < ZONE_ORDER.length; i++) {
        const z = ZONE_ORDER[i];
        const grp = chassisMap.zoneGroups[z];
        const badge = chassisMap.zoneBadges[z];
        const isTarget = calActive && ZONE_ORDER[calStepIdx] === z;
        grp.setAttribute('data-cal-target', isTarget ? 'true' : 'false');
        if (calActive && calCaptured[z]) {
          badge.textContent = '✓';
        } else if (!calActive && engine.classifier.calibratedZones.has(z)) {
          badge.textContent = '●';
        } else {
          badge.textContent = '';
        }
      }
    }

    function updateStatusLine(overrideText, isVeto) {
      statusPill.dataset.veto = isVeto ? 'true' : 'false';
      if (overrideText) {
        statusPill.textContent = overrideText;
        return;
      }
      if (calActive) {
        statusPill.textContent = `CAL ${calStepIdx + 1}/4`;
        return;
      }
      if (busState.state === 'listening') {
        const srKhz = Math.round((busState.sampleRate || 48000) / 100) / 10;
        statusPill.textContent = localPaused ? 'PAUSED' : `LIVE · ${srKhz}k`;
      } else if (busState.state === 'requesting') {
        statusPill.textContent = 'ARMING…';
      } else if (busState.state === 'error') {
        statusPill.textContent = 'SIM MODE';
      } else {
        statusPill.textContent = engine.classifier.isCalibrated() ? 'CAL · TAP MAP' : 'READY · TAP MAP';
      }
    }

    function updateBusUi(st) {
      busState = Object.assign({ state: 'idle', sampleRate: 48000, txMode: 'off', error: '' }, st || {});
      const isListening = busState.state === 'listening' && !localPaused;
      const isRequesting = busState.state === 'requesting';

      armBtn.dataset.armed = isListening ? 'true' : isRequesting ? 'requesting' : 'false';
      armBtn.setAttribute('aria-pressed', isListening ? 'true' : 'false');
      armText.textContent = isRequesting ? '…' : isListening ? 'LIVE' : localPaused && busState.state === 'listening' ? 'PAUSED' : 'ARM';

      if (busState.state === 'idle') {
        localPaused = false;
        engine.reset();
      } else if (busState.state === 'error') {
        zoneSub.textContent = 'Mic unavailable · tap map';
      }
      updateStatusLine();
    }

    async function handleArmClick() {
      if (!bus || typeof bus.requestArm !== 'function') {
        updateStatusLine('SIM ONLY', false);
        return;
      }
      if (busState.state === 'listening') {
        localPaused = !localPaused;
        if (!localPaused) engine.reset();
        updateBusUi(busState);
        return;
      }
      localPaused = false;
      try {
        await bus.requestArm();
      } catch (_) {
        updateStatusLine('MIC ERROR', true);
      }
    }

    // -------------------------------------------------------------------------
    // Calibration Flow (`[CAL 4Z]`)
    // -------------------------------------------------------------------------

    function renderCalPrompt() {
      if (!calActive) {
        calBar.hidden = true;
        calBtn.setAttribute('aria-expanded', 'false');
        refreshCalBadges();
        updateStatusLine();
        return;
      }
      const targetId = ZONE_ORDER[calStepIdx];
      const meta = ZONES[targetId];
      calBar.hidden = false;
      calBtn.setAttribute('aria-expanded', 'true');
      calBarMsg.textContent = `Tap ${calStepIdx + 1}/4: ${meta.label} (${meta.hint})`;
      calCancelBtn.textContent = 'Cancel';
      refreshCalBadges();
      updateStatusLine();
    }

    async function toggleCalibration() {
      if (calActive) {
        cancelCalibration();
        return;
      }
      calActive = true;
      calStepIdx = 0;
      calCaptured = {};
      if (bus && busState.state !== 'listening' && typeof bus.requestArm === 'function') {
        // Attempt arming mic seamlessly, while keeping SVG tap-cal working if mic isn't granted
        bus.requestArm().catch(() => {});
      }
      localPaused = false;
      renderCalPrompt();
      announce(`Calibration started. Tap ${ZONES[ZONE_ORDER[0]].label}.`);
    }

    function cancelCalibration() {
      calActive = false;
      calCaptured = {};
      renderCalPrompt();
    }

    function resetCalibration() {
      engine.classifier.resetToFactory();
      saveStoredCalibration(null);
      calActive = false;
      calCaptured = {};
      renderCalPrompt();
      zoneSub.textContent = 'Factory MBP centroids';
      announce('Tap zone calibration reset to factory defaults.');
    }

    function captureCalibrationTap(features, sourceTag) {
      const targetId = ZONE_ORDER[calStepIdx];
      calCaptured[targetId] = features;
      triggerZoneVisual(targetId, 1.0, features, `CAL ${calStepIdx + 1}/4 · ${sourceTag}`);

      calStepIdx++;
      if (calStepIdx >= ZONE_ORDER.length) {
        const saved = engine.classifier.calibrateZones(calCaptured);
        if (saved) saveStoredCalibration(saved);
        calActive = false;
        calCaptured = {};
        renderCalPrompt();
        zoneSub.textContent = '4-Zone Cal Locked';
        announce('4-zone chassis tap calibration saved.');
      } else {
        renderCalPrompt();
        const nextMeta = ZONES[ZONE_ORDER[calStepIdx]];
        announce(`Captured. Next, tap ${nextMeta.label}.`);
      }
    }

    // -------------------------------------------------------------------------
    // Visual Feedback & DSP Event Handling
    // -------------------------------------------------------------------------

    function triggerZoneVisual(zoneId, confidence, features, sourceTag) {
      const meta = ZONES[zoneId];
      if (!meta) return;

      // Highlight active SVG zone & retrigger crisp CSS ripple animation
      for (let i = 0; i < ZONE_ORDER.length; i++) {
        const z = ZONE_ORDER[i];
        const grp = chassisMap.zoneGroups[z];
        grp.setAttribute('data-active', z === zoneId ? 'true' : 'false');
        grp.classList.remove('tz-zone--pulse');
      }

      const activeGrp = chassisMap.zoneGroups[zoneId];
      // Trigger SVG ripple cleanly via class toggle after layout flush
      if (typeof activeGrp.getBoundingClientRect === 'function') {
        activeGrp.getBoundingClientRect();
      }
      activeGrp.classList.add('tz-zone--pulse');

      // Show acoustic wavefront ray from detected zone -> Top-Left 3-Mic Array (`29, 42`)
      chassisMap.propRay.setAttribute('x2', String(meta.cx));
      chassisMap.propRay.setAttribute('y2', String(meta.cy));
      chassisMap.propRay.setAttribute('opacity', '0.68');
      chassisMap.propRay.dataset.accent = meta.accent;

      if (activePulseTimer) clearTimeout(activePulseTimer);
      activePulseTimer = setTimeout(() => {
        activeGrp.classList.remove('tz-zone--pulse');
        chassisMap.propRay.setAttribute('opacity', '0.18');
      }, 900);

      // Telemetry readouts
      const confPct = Math.round(clamp(confidence, 0, 1) * 100);
      zoneVal.textContent = meta.shortLabel;
      zoneVal.dataset.accent = meta.accent;
      confPill.textContent = `${confPct}%`;
      confPill.dataset.accent = meta.accent;
      zoneSub.textContent = sourceTag || (engine.classifier.isCalibrated() ? 'CAL · <16kHz' : 'MBP · <16kHz');

      riseVal.textContent = `${features.riseTimeMs.toFixed(1)} ms`;
      decaySub.textContent = `DEC ${features.decayRatio.toFixed(1)}×`;

      hfVal.textContent = `${features.hfAirRatioDb.toFixed(1)} dB`;
      subBassSub.textContent = `SUB ${features.subBassRatioDb.toFixed(0)}dB`;
    }

    function handleEngineEvents(events, sourceTag) {
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (ev.type === 'veto') {
          const msg = ev.reason === 'sustained' ? 'SPEECH/SWIPE VETO' : 'TRANSIENT VETO';
          updateStatusLine(msg, true);
          if (vetoFlashTimer) clearTimeout(vetoFlashTimer);
          vetoFlashTimer = setTimeout(() => {
            updateStatusLine();
          }, 850);
          continue;
        }
        if (ev.type === 'tap') {
          if (calActive) {
            captureCalibrationTap(ev.features, sourceTag);
          } else {
            triggerZoneVisual(ev.zone, ev.confidence, ev.features, `${sourceTag} · ${ev.durationMs.toFixed(0)}ms`);
            announce(
              `${ev.label}, ${Math.round(ev.confidence * 100)} percent confidence, rise ${ev.features.riseTimeMs.toFixed(1)} milliseconds.`
            );
          }
        }
      }
    }

    /**
     * Synthesizes a realistic 48 kHz physical waveform for `zoneId` and runs it
     * through an isolated real `TapZoneDetector` + the live `TapZoneClassifier`
     * in 512-sample bus blocks (identical DSP path to live mic without perturbing
     * the live mic's adaptive floor!).
     */
    function runSimulatedZoneTap(zoneId) {
      if (calActive && zoneId !== ZONE_ORDER[calStepIdx]) {
        const expected = ZONES[ZONE_ORDER[calStepIdx]];
        updateStatusLine(`TAP ${expected.code} NEXT`, true);
        if (vetoFlashTimer) clearTimeout(vetoFlashTimer);
        vetoFlashTimer = setTimeout(() => updateStatusLine(), 900);
        return;
      }
      const sr = 48000;
      const seed = (simSeedCounter++ * 2654435761) >>> 0;
      const jitter = 0.92 + (seed % 17) * 0.01;
      const wave = synthesizeZoneTap(zoneId, {
        sampleRate: sr,
        seed,
        gainScale: jitter,
        preSec: 0.06,
        postSec: 0.1
      });

      const simDet = new TapZoneDetector({ sampleRate: sr });
      const blockSize = 512;
      const collected = [];
      for (let off = 0; off < wave.length; off += blockSize) {
        const slice = wave.subarray(off, Math.min(wave.length, off + blockSize));
        const raw = simDet.processBlock(slice, sr, off / sr);
        for (let j = 0; j < raw.length; j++) {
          const r = raw[j];
          if (r.type === 'tapCandidate') {
            const cls = engine.classifier.classify(r.features);
            collected.push({
              type: 'tap',
              zone: cls.zone,
              label: cls.label,
              shortLabel: cls.shortLabel,
              confidence: cls.confidence,
              features: r.features,
              durationMs: r.durationMs,
              timeSec: r.timeSec
            });
          }
        }
      }

      if (collected.length > 0) {
        handleEngineEvents(collected, 'SIM');
      }
    }

    // -------------------------------------------------------------------------
    // Shared Bus Subscriptions & Lifecycle Cleanup
    // -------------------------------------------------------------------------

    let unsubAudio = null;
    let unsubState = null;

    if (bus && typeof bus.subscribeAudio === 'function') {
      unsubAudio = bus.subscribeAudio(({ samples, sampleRate, timeSec }) => {
        if (localPaused || !samples) return;
        const events = engine.processBlock(samples, sampleRate, timeSec);
        if (events.length > 0) {
          handleEngineEvents(events, 'MIC');
        }
      });
    }

    if (bus && typeof bus.onStateChange === 'function') {
      unsubState = bus.onStateChange((st) => updateBusUi(st));
    }

    function onSecondaryClose() {
      if (calActive) cancelCalibration();
      localPaused = false;
      engine.reset();
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('lg-secondary-close', onSecondaryClose);
    }

    refreshCalBadges();

    return {
      engine,
      simulateZoneTap: runSimulatedZoneTap,
      destroy() {
        if (activePulseTimer) clearTimeout(activePulseTimer);
        if (vetoFlashTimer) clearTimeout(vetoFlashTimer);
        if (announceTimer) clearTimeout(announceTimer);
        if (typeof unsubAudio === 'function') unsubAudio();
        if (typeof unsubState === 'function') unsubState();
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('lg-secondary-close', onSecondaryClose);
        }
      }
    };
  }

  return {
    STORAGE_KEY,
    ZONE_ORDER,
    ZONES,
    FEATURE_KEYS,
    FACTORY_CENTROIDS,
    DEFAULT_SCALES,
    FEATURE_WEIGHTS,
    BiquadFilter,
    TapBandFilter,
    fftRadix2,
    TapZoneClassifier,
    TapZoneDetector,
    TapZoneEngine,
    synthesizeZoneTap,
    synthesizeSustainedSpeech,
    synthesizeUltrasonicBurst,
    loadStoredCalibration,
    saveStoredCalibration,
    mountTapZonesCell
  };
});
