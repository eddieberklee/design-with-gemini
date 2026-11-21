/**
 * Secondary Grid Cell 03 — Nail Scratch vs Soft Finger Tap (`cells/left-grille/nail-pad.js`)
 *
 * Implements combined TapSense (Harrison et al., UIST 2011) + ScratchInput (Harrison & Hudson,
 * UIST 2008) acoustic surface interaction sensing on the MacBook Pro aluminum deck and left
 * speaker grille strictly below 16 kHz (`72 Hz – 15.2 kHz`) so 18–21 kHz ultrasonic sonar
 * pilots on the shared bus never interfere.
 *
 * Distinguishes three physical finger interactions + harmonic voice veto:
 *   1. `soft-pad`     — Viscoelastic fingertip pad tap (10–55 ms, 80–950 Hz flexural thud
 *                       dominates, steep > 3 kHz roll-off, centroid < 1.8 kHz, moderate crest).
 *   2. `nail-tap`     — Rigid alpha-keratin fingernail impact (6–45 ms, Dirac-like < 3 ms
 *                       attack, bright 2.8–14 kHz click, centroid > 2.6 kHz, high crest factor).
 *   3. `nail-scratch` — Sustained fingernail drag across bead-blasted aluminum / CNC grille
 *                       (>= 70 ms, continuous 3.5–15 kHz stick-slip micro-chatter, Wiener
 *                       spectral flatness > 0.25, elevated ZCR, harmonic voiced-speech veto).
 *
 * UMD module: exports pure DSP classes & 48 kHz physical waveform synthesizers in Node
 * (`module.exports`) and mounts Secondary Slot 3 via `window.LeftGrilleLab`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
  } else {
    root.LeftGrilleNailPad = factory(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function nailPadFactory(global) {
  'use strict';

  const STORAGE_KEY = 'dwg.nailPadCal.v1';
  const QUANTUM = 128;
  const FFT_SIZE = 256;
  const MAX_PASSBAND_HZ = 15200;
  const DEFAULT_THRESHOLD_DB = 10.0;
  const DEFAULT_HFLF_BIAS_DB = 0.0;

  function clamp(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  function isDocHidden() {
    return typeof document !== 'undefined' && Boolean(document) && document.hidden === true;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function createRng(seed = 1337) {
    let s = (seed >>> 0) || 1337;
    return function rand() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randNormal(rng) {
    const u1 = Math.max(1e-9, rng());
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * In-place Radix-2 Cooley-Tukey Complex FFT.
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
   * Direct Form II Transposed 2nd-Order Biquad Filter.
   * Supports 'lowpass', 'highpass', and 'notch' so 18–21 kHz sonar carriers are
   * crushed by > 50 dB in the time domain prior to ZCR, attack, and crest-factor metrics.
   */
  class BiquadFilter {
    constructor(type, fcHz, sampleRate, Q = 0.70710678) {
      this.z1 = 0;
      this.z2 = 0;
      const fs = Math.max(8000, sampleRate || 48000);
      const nyq = fs * 0.47;
      const fc = clamp(fcHz, 20, nyq);
      const w0 = (2 * Math.PI * fc) / fs;
      const cosw0 = Math.cos(w0);
      const sinw0 = Math.sin(w0);
      const alpha = sinw0 / (2 * Math.max(0.1, Q));

      let b0 = 1;
      let b1 = 0;
      let b2 = 0;
      let a0 = 1;
      let a1 = 0;
      let a2 = 0;

      if (type === 'lowpass') {
        b0 = (1 - cosw0) * 0.5;
        b1 = 1 - cosw0;
        b2 = (1 - cosw0) * 0.5;
        a0 = 1 + alpha;
        a1 = -2 * cosw0;
        a2 = 1 - alpha;
      } else if (type === 'highpass') {
        b0 = (1 + cosw0) * 0.5;
        b1 = -(1 + cosw0);
        b2 = (1 + cosw0) * 0.5;
        a0 = 1 + alpha;
        a1 = -2 * cosw0;
        a2 = 1 - alpha;
      } else if (type === 'notch') {
        b0 = 1;
        b1 = -2 * cosw0;
        b2 = 1;
        a0 = 1 + alpha;
        a1 = -2 * cosw0;
        a2 = 1 - alpha;
      }

      this.b0 = b0 / a0;
      this.b1 = b1 / a0;
      this.b2 = b2 / a0;
      this.a1 = a1 / a0;
      this.a2 = a2 / a0;
    }

    process(x) {
      const inVal = Number.isFinite(x) ? x : 0;
      const y = this.b0 * inVal + this.z1;
      this.z1 = this.b1 * inVal - this.a1 * y + this.z2;
      this.z2 = this.b2 * inVal - this.a2 * y;
      if (!Number.isFinite(this.z1) || !Number.isFinite(this.z2)) {
        this.z1 = 0;
        this.z2 = 0;
        return 0;
      }
      return y;
    }

    reset() {
      this.z1 = 0;
      this.z2 = 0;
    }
  }

  function sanitizeCalibration(raw) {
    if (!raw || typeof raw !== 'object') {
      return {
        thresholdDb: DEFAULT_THRESHOLD_DB,
        hfLfBiasDb: DEFAULT_HFLF_BIAS_DB
      };
    }
    return {
      thresholdDb: Number.isFinite(raw.thresholdDb)
        ? clamp(Number(raw.thresholdDb), 5.0, 22.0)
        : DEFAULT_THRESHOLD_DB,
      hfLfBiasDb: Number.isFinite(raw.hfLfBiasDb)
        ? clamp(Number(raw.hfLfBiasDb), -8.0, 8.0)
        : DEFAULT_HFLF_BIAS_DB
    };
  }

  function loadStoredCalibration() {
    try {
      if (typeof localStorage === 'undefined') return sanitizeCalibration(null);
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return sanitizeCalibration(null);
      return sanitizeCalibration(JSON.parse(raw));
    } catch (_) {
      return sanitizeCalibration(null);
    }
  }

  function saveStoredCalibration(cal) {
    const clean = sanitizeCalibration(cal);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
      }
    } catch (_) {}
    return clean;
  }

  /**
   * Core `< 16 kHz` TapSense + ScratchInput Acoustic Classifier.
   */
  class NailPadClassifier {
    constructor(options = {}) {
      const sr = Number(options.sampleRate);
      this.sampleRate = Number.isFinite(sr) && sr >= 16000 ? sr : 48000;
      this.decim = this.sampleRate >= 72000 ? Math.max(1, Math.round(this.sampleRate / 48000)) : 1;
      this.effectiveRate = this.sampleRate / this.decim;
      this.dtQuantum = QUANTUM / this.effectiveRate;
      this.binHz = this.effectiveRate / FFT_SIZE;

      const savedCal = options.calibration
        ? sanitizeCalibration(options.calibration)
        : loadStoredCalibration();
      this.thresholdDb = Number.isFinite(options.thresholdDb)
        ? clamp(options.thresholdDb, 5.0, 22.0)
        : savedCal.thresholdDb;
      this.hfLfBiasDb = Number.isFinite(options.hfLfBiasDb)
        ? clamp(options.hfLfBiasDb, -8.0, 8.0)
        : savedCal.hfLfBiasDb;

      this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
      this.onTelemetry = typeof options.onTelemetry === 'function' ? options.onTelemetry : null;

      this._initFiltersAndWindows();
      this.resetState();
    }

    _initFiltersAndWindows() {
      const fs = this.effectiveRate;
      const lpCut = Math.min(MAX_PASSBAND_HZ, fs * 0.43);

      // High-pass at 72 Hz to strip DC/handling drift
      this.hpf72 = new BiquadFilter('highpass', 72, fs, 0.7071);

      // 4th-order Butterworth low-pass at 15.2 kHz + dual ultrasonic notches (18.8k & 20.5k)
      this.lpf1 = new BiquadFilter('lowpass', lpCut, fs, 0.5412);
      this.lpf2 = new BiquadFilter('lowpass', lpCut, fs, 1.3065);
      this.useSonarNotches = fs >= 42000;
      this.notch18k = this.useSonarNotches ? new BiquadFilter('notch', 18750, fs, 2.2) : null;
      this.notch20k = this.useSonarNotches ? new BiquadFilter('notch', 20600, fs, 2.2) : null;

      // Dedicated 80–900 Hz viscoelastic pad thud tracker
      this.lfTracker = new BiquadFilter('lowpass', 900, fs, 0.7071);

      // Normalized periodic Hann window of length 256
      this.hann256 = new Float64Array(FFT_SIZE);
      let wSum = 0;
      for (let i = 0; i < FFT_SIZE; i++) {
        const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / FFT_SIZE));
        this.hann256[i] = w;
        wSum += w;
      }
      const norm = FFT_SIZE / wSum;
      for (let i = 0; i < FFT_SIZE; i++) {
        this.hann256[i] *= norm;
      }

      // Strictly < 16 kHz bin indices
      const nyqBin = (FFT_SIZE >> 1) - 2;
      this.maxPassBin = Math.min(nyqBin, Math.floor(Math.min(15500, fs * 0.44) / this.binHz));
      this.lfStartBin = 1;
      this.lfEndBin = Math.max(2, Math.min(this.maxPassBin - 4, Math.round(950 / this.binHz)));
      this.midStartBin = this.lfEndBin + 1;
      this.midEndBin = Math.max(
        this.midStartBin + 1,
        Math.min(this.maxPassBin - 2, Math.round(2750 / this.binHz))
      );
      this.hfStartBin = this.midEndBin + 1;
      this.hfEndBin = Math.max(
        this.hfStartBin + 1,
        Math.min(this.maxPassBin, Math.round(14200 / this.binHz))
      );
      this.scratchStartBin = Math.max(
        this.hfStartBin,
        Math.min(this.maxPassBin - 1, Math.round(3400 / this.binHz))
      );
      this.scratchEndBin = this.maxPassBin;

      this.fftRe = new Float64Array(FFT_SIZE);
      this.fftIm = new Float64Array(FFT_SIZE);
    }

    resetState() {
      this.hpf72.reset();
      this.lpf1.reset();
      this.lpf2.reset();
      if (this.notch18k) this.notch18k.reset();
      if (this.notch20k) this.notch20k.reset();
      this.lfTracker.reset();

      this.decimAcc = 0;
      this.decimCount = 0;
      this.quantumBuf = new Float32Array(QUANTUM);
      this.quantumFill = 0;
      this.slidingWin = new Float32Array(FFT_SIZE);
      this.quantaProcessed = 0;
      this.timeSec = 0;

      // Adaptive noise floor state (in dB)
      this.floorInit = false;
      this.noiseFloorDb = -68.0;
      this.lfFloorDb = -72.0;
      this.hfFloorDb = -74.0;

      // 3-quantum pre-onset ring buffer so < 3 ms Dirac nail attacks are never clipped
      this.preRing = [];
      this.activeBurst = null;
      this.quietHoldQuanta = 0;
      this.cooldownQuanta = 0;

      // Sustained elevated broadband floor tracker (independent of activeBurst reset)
      this.sustainedHotQuanta = 0;
      this.sustainedQuietQuanta = 0;
      this.hotFrameDbEma = -68.0;
      this.hotLfDbEma = -72.0;
      this.hotHfDbEma = -74.0;

      this.smoothLfLevel = 0;
      this.smoothHfLevel = 0;
      this.smoothCentroidKhz = 0;
      this.lastEvent = null;
      this.lastVetoReason = null;
    }

    reset() {
      this.resetState();
    }

    setCalibration(cal = {}) {
      const next = sanitizeCalibration({
        thresholdDb: cal.thresholdDb !== undefined ? cal.thresholdDb : this.thresholdDb,
        hfLfBiasDb: cal.hfLfBiasDb !== undefined ? cal.hfLfBiasDb : this.hfLfBiasDb
      });
      this.thresholdDb = next.thresholdDb;
      this.hfLfBiasDb = next.hfLfBiasDb;
      if (cal.persist !== false) {
        saveStoredCalibration(next);
      }
      return next;
    }

    getCalibration() {
      return {
        thresholdDb: this.thresholdDb,
        hfLfBiasDb: this.hfLfBiasDb
      };
    }

    resetCalibration() {
      return this.setCalibration({
        thresholdDb: DEFAULT_THRESHOLD_DB,
        hfLfBiasDb: DEFAULT_HFLF_BIAS_DB,
        persist: true
      });
    }

    /**
     * Feeds a block or buffer of audio samples through the < 16 kHz DSP pipeline.
     * Returns an array of committed gesture events emitted during this call.
     */
    processSamples(samples, sampleRate, timeSec) {
      if (!samples || !samples.length) return [];
      if (
        Number.isFinite(sampleRate) &&
        sampleRate >= 16000 &&
        Math.abs(sampleRate - this.sampleRate) > 100
      ) {
        this.sampleRate = sampleRate;
        this.decim =
          this.sampleRate >= 72000 ? Math.max(1, Math.round(this.sampleRate / 48000)) : 1;
        this.effectiveRate = this.sampleRate / this.decim;
        this.dtQuantum = QUANTUM / this.effectiveRate;
        this.binHz = this.effectiveRate / FFT_SIZE;
        this._initFiltersAndWindows();
        this.resetState();
      }
      if (Number.isFinite(timeSec) && this.quantaProcessed === 0) {
        this.timeSec = timeSec;
      }

      const committedEvents = [];
      for (let i = 0; i < samples.length; i++) {
        const s = Number.isFinite(samples[i]) ? samples[i] : 0;
        this.decimAcc += s;
        this.decimCount++;
        if (this.decimCount >= this.decim) {
          const decimatedSample = this.decimAcc / this.decimCount;
          this.decimAcc = 0;
          this.decimCount = 0;

          // Strictly band-limit time domain to 72 Hz .. 15.2 kHz + dual ultrasonic notches
          let y = this.hpf72.process(decimatedSample);
          if (this.notch18k) y = this.notch18k.process(y);
          if (this.notch20k) y = this.notch20k.process(y);
          y = this.lpf2.process(this.lpf1.process(y));

          this.quantumBuf[this.quantumFill++] = y;
          if (this.quantumFill >= QUANTUM) {
            this.quantumFill = 0;
            const ev = this._processQuantum(this.quantumBuf);
            if (ev) committedEvents.push(ev);
          }
        }
      }
      return committedEvents;
    }

    _processQuantum(qBuf) {
      this.quantaProcessed++;
      this.timeSec += this.dtQuantum;

      // Shift 256-sample sliding window by 128 samples and append new quantum
      this.slidingWin.copyWithin(0, QUANTUM);
      this.slidingWin.set(qBuf, QUANTUM);

      // 1. Time-domain metrics on strictly < 15.2 kHz filtered quantum
      let sumSq = 0;
      let lfTimeSq = 0;
      let peakAbs = 0;
      let peakIdxInQuantum = 0;
      let zeroCrossings = 0;
      let prevSample = this.slidingWin[QUANTUM - 1];

      for (let i = 0; i < QUANTUM; i++) {
        const x = qBuf[i];
        const ax = Math.abs(x);
        sumSq += x * x;
        if (ax > peakAbs) {
          peakAbs = ax;
          peakIdxInQuantum = i;
        }
        if ((x >= 0 && prevSample < 0) || (x < 0 && prevSample >= 0)) {
          if (ax > 1e-4 || Math.abs(prevSample) > 1e-4) {
            zeroCrossings++;
          }
        }
        prevSample = x;

        const lfSample = this.lfTracker.process(x);
        lfTimeSq += lfSample * lfSample;
      }

      const qRms = Math.sqrt(sumSq / QUANTUM);
      const qLfTimePow = lfTimeSq / QUANTUM;
      const qZcr = zeroCrossings / QUANTUM;
      const qCrest = peakAbs / (qRms + 1e-9);

      // 2. 256-point Periodic Hann FFT (strictly evaluated on bins <= maxPassBin < 16 kHz)
      for (let i = 0; i < FFT_SIZE; i++) {
        this.fftRe[i] = this.slidingWin[i] * this.hann256[i];
        this.fftIm[i] = 0;
      }
      fftRadix2(this.fftRe, this.fftIm);

      const scale = 2.0 / (FFT_SIZE * FFT_SIZE);
      let sumLfPow = 0;
      let sumMidPow = 0;
      let sumHfPow = 0;
      let sumScratchPow = 0;
      let totalPassPow = 0;
      let weightedFreqSum = 0;

      // For Wiener spectral flatness (375 Hz .. 15.2 kHz) and vocal harmonicity check
      let flatBinCount = 0;
      let flatArithSum = 0;
      const flatBinPows = [];
      let maxVocalBinPow = 0;
      let sumVocalBinPow = 0;
      let vocalBinCount = 0;

      for (let k = 1; k <= this.maxPassBin; k++) {
        const re = this.fftRe[k];
        const im = this.fftIm[k];
        const p = (re * re + im * im) * scale;
        const fHz = k * this.binHz;

        totalPassPow += p;
        weightedFreqSum += fHz * p;

        if (k >= this.lfStartBin && k <= this.lfEndBin) {
          sumLfPow += p;
        } else if (k >= this.midStartBin && k <= this.midEndBin) {
          sumMidPow += p;
        } else if (k >= this.hfStartBin && k <= this.hfEndBin) {
          sumHfPow += p;
        }

        if (k >= this.scratchStartBin && k <= this.scratchEndBin) {
          sumScratchPow += p;
        }

        if (k >= 2 && k <= this.maxPassBin) {
          flatBinPows.push(p);
          flatArithSum += p;
          flatBinCount++;
        }

        // Vocal fundamental + formant region (180 Hz .. 3200 Hz)
        if (fHz >= 175 && fHz <= 3200) {
          if (p > maxVocalBinPow) maxVocalBinPow = p;
          sumVocalBinPow += p;
          vocalBinCount++;
        }
      }

      // Fuse sub-200 Hz time-domain flexural pad power so 80–187 Hz chassis modes are captured accurately
      const subBassPow = Math.max(0, qLfTimePow - sumLfPow * 0.55);
      const effLfPow = sumLfPow + subBassPow;
      const effTotalPow = totalPassPow + subBassPow;

      const centroidHz =
        effTotalPow > 1e-14 ? (weightedFreqSum + 140 * subBassPow) / effTotalPow : 600;
      const centroidKhz = clamp(centroidHz / 1000, 0.08, 15.5);

      const lfBins = Math.max(1, this.lfEndBin - this.lfStartBin + 1);
      const hfBins = Math.max(1, this.hfEndBin - this.hfStartBin + 1);
      const normLf = effLfPow / Math.sqrt(lfBins);
      const normHf = (sumHfPow + 0.35 * sumScratchPow) / Math.sqrt(hfBins);
      const hfLfDb = 10 * Math.log10((normHf + 1e-15) / (normLf + 1e-15)) + this.hfLfBiasDb;

      // Regularized Wiener Spectral Flatness across 375 Hz .. 15.2 kHz
      let flatness = 0;
      if (flatBinCount > 0 && flatArithSum > 1e-14) {
        const arithMean = flatArithSum / flatBinCount;
        const regFloor = arithMean * 0.012 + 1e-15;
        let logSum = 0;
        for (let i = 0; i < flatBinCount; i++) {
          logSum += Math.log(flatBinPows[i] + regFloor);
        }
        const geomMean = Math.exp(logSum / flatBinCount);
        flatness = clamp(geomMean / (arithMean + regFloor), 0, 1);
      }

      const vocalMeanPow = vocalBinCount > 0 ? sumVocalBinPow / vocalBinCount : 0;
      const vocalSpectralCrest = maxVocalBinPow / (vocalMeanPow + 1e-15);
      const vocalBandFrac = (sumLfPow * 0.35 + sumMidPow) / (effTotalPow + 1e-15);

      // Pitch autocorrelation periodicity check in 95–360 Hz human voice fundamental range
      const pitchPeriodicity = this._computePitchPeriodicity();

      const frameDb = 10 * Math.log10(effTotalPow + 1e-14);
      const lfDb = 10 * Math.log10(effLfPow + 1e-14);
      const hfDb = 10 * Math.log10(sumHfPow + sumScratchPow * 0.5 + 1e-14);

      // 3. Adaptive Noise Floor Update (only when no active burst is underway)
      if (!this.floorInit) {
        this.noiseFloorDb = Math.min(-42, frameDb);
        this.lfFloorDb = Math.min(-44, lfDb);
        this.hfFloorDb = Math.min(-46, hfDb);
        if (this.quantaProcessed >= 6) this.floorInit = true;
      } else if (!this.activeBurst) {
        const snrPre = frameDb - this.noiseFloorDb;
        if (snrPre < this.thresholdDb * 0.75) {
          const alpha = frameDb < this.noiseFloorDb ? 0.08 : 0.004;
          this.noiseFloorDb = lerp(this.noiseFloorDb, frameDb, alpha);
          this.lfFloorDb = lerp(this.lfFloorDb, lfDb, alpha);
          this.hfFloorDb = lerp(this.hfFloorDb, hfDb, alpha);
        }
      }

      const onsetGateDb = this.thresholdDb;
      const sustainGateDb = Math.max(4.5, this.thresholdDb - 4.2);
      const maxScratchQuanta = Math.round(0.65 / this.dtQuantum); // ~650 ms finite scratch cap
      const reanchorQuanta = Math.round(1.2 / this.dtQuantum); // 1.2 s steady fan/HVAC floor re-anchor

      let snrDb = frameDb - this.noiseFloorDb;
      let lfSnrDb = Math.max(0, lfDb - this.lfFloorDb);
      let hfSnrDb = Math.max(0, hfDb - this.hfFloorDb);

      // Track continuous elevated energy independently of activeBurst reset so steady
      // broadband fan/HVAC step-ups re-anchor cleanly instead of looping false scratches.
      if (this.floorInit) {
        if (snrDb >= sustainGateDb) {
          this.sustainedHotQuanta++;
          this.sustainedQuietQuanta = 0;
          if (this.sustainedHotQuanta === 1) {
            this.hotFrameDbEma = frameDb;
            this.hotLfDbEma = lfDb;
            this.hotHfDbEma = hfDb;
          } else {
            this.hotFrameDbEma = lerp(this.hotFrameDbEma, frameDb, 0.08);
            this.hotLfDbEma = lerp(this.hotLfDbEma, lfDb, 0.08);
            this.hotHfDbEma = lerp(this.hotHfDbEma, hfDb, 0.08);
          }

          if (this.sustainedHotQuanta >= reanchorQuanta) {
            this.noiseFloorDb = this.hotFrameDbEma;
            this.lfFloorDb = this.hotLfDbEma;
            this.hfFloorDb = this.hotHfDbEma;
            this.activeBurst = null;
            this.quietHoldQuanta = 0;
            this.sustainedHotQuanta = 0;
            this.sustainedQuietQuanta = 0;
            this.cooldownQuanta = Math.max(
              this.cooldownQuanta,
              Math.round(0.06 / this.dtQuantum)
            );
            this.lastVetoReason = 'sustained';
            snrDb = frameDb - this.noiseFloorDb;
            lfSnrDb = Math.max(0, lfDb - this.lfFloorDb);
            hfSnrDb = Math.max(0, hfDb - this.hfFloorDb);
          }
        } else {
          this.sustainedQuietQuanta++;
          if (this.sustainedQuietQuanta >= 4) {
            this.sustainedHotQuanta = 0;
            if (this.lastVetoReason === 'sustained') {
              this.lastVetoReason = null;
            }
          }
        }
      }

      const frameSummary = {
        qIndex: this.quantaProcessed,
        timeSec: this.timeSec,
        frameDb,
        snrDb,
        effTotalPow,
        effLfPow,
        sumMidPow,
        sumHfPow,
        sumScratchPow,
        centroidKhz,
        hfLfDb,
        flatness,
        qRms,
        peakAbs,
        peakIdxInQuantum,
        qCrest,
        qZcr,
        vocalSpectralCrest,
        vocalBandFrac,
        pitchPeriodicity
      };

      // Keep 3-quantum pre-onset ring
      this.preRing.push(frameSummary);
      if (this.preRing.length > 3) this.preRing.shift();

      if (this.cooldownQuanta > 0) {
        this.cooldownQuanta--;
      }

      let committedEvent = null;

      // 4. Burst Segmentation State Machine
      if (!this.activeBurst) {
        if (
          this.cooldownQuanta === 0 &&
          this.sustainedHotQuanta < maxScratchQuanta &&
          snrDb >= onsetGateDb &&
          this.quantaProcessed >= 4
        ) {
          // Include 1 lookback quantum if it already started rising (> sustainGateDb * 0.65)
          const frames = [];
          if (this.preRing.length >= 2) {
            const prev = this.preRing[this.preRing.length - 2];
            if (prev.snrDb >= sustainGateDb * 0.65) {
              frames.push(prev);
            }
          }
          frames.push(frameSummary);
          this.activeBurst = {
            startQ: frames[0].qIndex,
            frames,
            peakDb: frameDb,
            peakPow: effTotalPow,
            peakAbs,
            peakFrameIdx: frames.length - 1
          };
          this.quietHoldQuanta = 0;
          this.lastVetoReason = null;
        }
      } else {
        const b = this.activeBurst;
        b.frames.push(frameSummary);
        if (frameDb > b.peakDb) {
          b.peakDb = frameDb;
          b.peakPow = effTotalPow;
          b.peakFrameIdx = b.frames.length - 1;
        }
        if (peakAbs > b.peakAbs) {
          b.peakAbs = peakAbs;
        }

        // Frame counts as active if above sustainGateDb AND within 22 dB of burst peak
        const withinPeakEnvelope = frameDb >= b.peakDb - 22.0;
        const isStillHot = snrDb >= sustainGateDb && withinPeakEnvelope;

        if (isStillHot) {
          this.quietHoldQuanta = 0;
        } else {
          this.quietHoldQuanta++;
        }

        const totalQuanta = b.frames.length;

        if (this.quietHoldQuanta >= 4) {
          committedEvent = this._classifyAndCommitBurst(b);
          this.activeBurst = null;
          this.quietHoldQuanta = 0;
          this.cooldownQuanta = 3;
        } else if (totalQuanta >= maxScratchQuanta) {
          // Continuous elevated energy >= 0.65 s with no baseline drop (e.g. HVAC / fan step-up):
          // abort without emitting a false 'nail-scratch' and wait for quiet return or 1.2 s re-anchor.
          this.activeBurst = null;
          this.quietHoldQuanta = 0;
          this.sustainedHotQuanta = Math.max(this.sustainedHotQuanta, maxScratchQuanta);
          this.cooldownQuanta = 3;
          this.lastVetoReason = 'sustained';
        }
      }

      // 5. Compute smooth live telemetry `{ lfLevel, hfLevel, centroidKhz, active }`
      const rawLfLevel = clamp(lfSnrDb / 28.0, 0, 1);
      const rawHfLevel = clamp(hfSnrDb / 28.0, 0, 1);
      const isActive = Boolean(this.activeBurst);

      this.smoothLfLevel =
        rawLfLevel > this.smoothLfLevel
          ? lerp(this.smoothLfLevel, rawLfLevel, 0.55)
          : lerp(this.smoothLfLevel, rawLfLevel, 0.18);
      this.smoothHfLevel =
        rawHfLevel > this.smoothHfLevel
          ? lerp(this.smoothHfLevel, rawHfLevel, 0.55)
          : lerp(this.smoothHfLevel, rawHfLevel, 0.18);

      if (isActive || snrDb >= sustainGateDb) {
        this.smoothCentroidKhz =
          this.smoothCentroidKhz === 0
            ? centroidKhz
            : lerp(this.smoothCentroidKhz, centroidKhz, 0.45);
      }

      const telemetry = {
        lfLevel: Math.round(this.smoothLfLevel * 1000) / 1000,
        hfLevel: Math.round(this.smoothHfLevel * 1000) / 1000,
        centroidKhz:
          Math.round((isActive ? centroidKhz : this.smoothCentroidKhz || centroidKhz) * 100) / 100,
        active: isActive,
        hfLfDb: Math.round(hfLfDb * 10) / 10,
        flatness: Math.round(flatness * 1000) / 1000,
        zcr: Math.round(qZcr * 1000) / 1000,
        snrDb: Math.round(snrDb * 10) / 10,
        noiseFloorDb: Math.round(this.noiseFloorDb * 10) / 10,
        vetoReason: this.lastVetoReason,
        event: committedEvent,
        timeSec: this.timeSec
      };

      if (this.onTelemetry) {
        this.onTelemetry(telemetry);
      }
      if (committedEvent && this.onEvent) {
        this.onEvent(committedEvent);
      }

      return committedEvent;
    }

    /**
     * Normalized autocorrelation peak in the human vocal pitch lag range (95 Hz .. 370 Hz)
     * across the current 256-sample sliding window. Voiced vowels/hums exhibit strong periodic
     * repetition (> 0.65), whereas damped impact transients and random scratch chatter do not.
     */
    _computePitchPeriodicity() {
      const w = this.slidingWin;
      const minLag = Math.max(16, Math.floor(this.effectiveRate / 370)); // ~129 at 48k
      const maxLag = Math.min(FFT_SIZE - 24, Math.ceil(this.effectiveRate / 195)); // ~246 at 48k
      let r0 = 0;
      for (let i = 0; i < FFT_SIZE; i++) {
        r0 += w[i] * w[i];
      }
      if (r0 < 1e-12) return 0;

      let bestNorm = 0;
      for (let lag = minLag; lag <= maxLag; lag += 2) {
        let corr = 0;
        let e1 = 0;
        let e2 = 0;
        const limit = FFT_SIZE - lag;
        for (let i = 0; i < limit; i++) {
          const a = w[i];
          const b = w[i + lag];
          corr += a * b;
          e1 += a * a;
          e2 += b * b;
        }
        const denom = Math.sqrt(e1 * e2) + 1e-12;
        const norm = corr / denom;
        if (norm > bestNorm) bestNorm = norm;
      }
      return clamp(bestNorm, 0, 1);
    }

    _classifyAndCommitBurst(burst) {
      const allFrames = burst.frames;
      if (!allFrames.length) return null;

      // Trim quiet trailing hangover frames and measure effective -18 dB energy span
      const cutoffDb = Math.max(
        this.noiseFloorDb + Math.max(4.0, this.thresholdDb - 4.5),
        burst.peakDb - 18.0
      );

      let firstIdx = 0;
      while (firstIdx < allFrames.length - 1 && allFrames[firstIdx].frameDb < cutoffDb) {
        firstIdx++;
      }
      let lastIdx = allFrames.length - 1;
      while (lastIdx > firstIdx && allFrames[lastIdx].frameDb < cutoffDb) {
        lastIdx--;
      }

      const coreFrames = allFrames.slice(firstIdx, lastIdx + 1);
      const nFrames = coreFrames.length;
      const peakSnrDb = burst.peakDb - this.noiseFloorDb;

      if (nFrames === 0 || peakSnrDb < this.thresholdDb) {
        return null;
      }

      // Compute power-weighted spectral and temporal features across core active frames
      let sumPow = 0;
      let sumSqRms = 0;
      let weightedCentroid = 0;
      let weightedHfLfDb = 0;
      let weightedFlatness = 0;
      let weightedZcr = 0;
      let weightedVocalCrest = 0;
      let weightedVocalFrac = 0;
      let weightedPitch = 0;
      let maxFramePow = 0;
      let peakCoreIdx = 0;

      for (let i = 0; i < nFrames; i++) {
        const f = coreFrames[i];
        const w = Math.max(1e-12, f.effTotalPow);
        sumPow += w;
        sumSqRms += f.qRms * f.qRms;
        weightedCentroid += f.centroidKhz * w;
        weightedHfLfDb += f.hfLfDb * w;
        weightedFlatness += f.flatness * w;
        weightedZcr += f.qZcr * w;
        weightedVocalCrest += f.vocalSpectralCrest * w;
        weightedVocalFrac += f.vocalBandFrac * w;
        weightedPitch += f.pitchPeriodicity * w;
        if (f.effTotalPow > maxFramePow) {
          maxFramePow = f.effTotalPow;
          peakCoreIdx = i;
        }
      }

      const centroidKhz = weightedCentroid / sumPow;
      const hfLfDb = weightedHfLfDb / sumPow;
      const meanFlatness = weightedFlatness / sumPow;
      const meanZcr = weightedZcr / sumPow;
      const meanVocalCrest = weightedVocalCrest / sumPow;
      const meanVocalFrac = weightedVocalFrac / sumPow;
      const meanPitch = weightedPitch / sumPow;

      const meanRms = Math.sqrt(sumSqRms / nFrames);
      const crestFactor = burst.peakAbs / (meanRms + 1e-9);

      // Sub-quantum attack time estimation (ms from burst onset to peak)
      const peakFrame = coreFrames[peakCoreIdx];
      const attackSamples =
        peakCoreIdx * QUANTUM + (peakFrame ? peakFrame.peakIdxInQuantum : QUANTUM * 0.5);
      const attackMs = Math.max(0.4, (attackSamples / this.effectiveRate) * 1000);

      // Effective physical duration in ms
      let rawDurationMs = nFrames * this.dtQuantum * 1000;
      if (nFrames <= 3) {
        // Refine sub-quantum impulse width using crest factor so ultra-crisp nail taps report 6–18 ms
        const crestComp = clamp(4.2 / Math.max(2.2, crestFactor), 0.58, 1.0);
        rawDurationMs = Math.max(6.0, rawDurationMs * crestComp);
      }
      const durationMs = Math.round(rawDurationMs);

      // -----------------------------------------------------------------------
      // Step 1: Harmonic Voiced-Speech / Tonal Veto
      // -----------------------------------------------------------------------
      const isHarmonicVoice =
        (durationMs >= 65 &&
          (meanFlatness < 0.24 ||
            centroidKhz < 2.4 ||
            meanZcr < 0.12 ||
            (meanPitch > 0.52 && meanVocalFrac > 0.4))) ||
        (durationMs >= 22 &&
          meanPitch > 0.62 &&
          meanVocalFrac > 0.48 &&
          meanFlatness < 0.19 &&
          meanVocalCrest > 4.2 &&
          crestFactor < 3.4);

      if (isHarmonicVoice) {
        this.lastVetoReason = 'voice';
        return null;
      }

      // -----------------------------------------------------------------------
      // Step 2: 3-Class Physical Decision (Nail Scratch vs Nail Tap vs Soft Pad)
      // -----------------------------------------------------------------------
      let gesture = 'soft-pad';
      let confidence = 0.78;

      if (durationMs >= 70) {
        // NAIL SCRATCH: duration >= 70 ms, broadband 3.5–15 kHz chatter, Wiener flatness > 0.25, high ZCR
        if (meanFlatness >= 0.25 && centroidKhz >= 2.3 && meanZcr >= 0.12 && hfLfDb >= -2.0) {
          gesture = 'nail-scratch';
          const durScore = clamp((durationMs - 70) / 140, 0, 1);
          const flatScore = clamp((meanFlatness - 0.25) / 0.35, 0, 1);
          const centScore = clamp((centroidKhz - 2.6) / 4.2, 0, 1);
          confidence = clamp(0.74 + 0.08 * durScore + 0.1 * flatScore + 0.07 * centScore, 0.72, 0.99);
        } else {
          // Sustained low-flatness / low-centroid sound >= 70 ms is non-scratch tonal/rumble noise
          this.lastVetoReason = 'voice';
          return null;
        }
      } else {
        // Short transient impact (< 70 ms): distinguish NAIL TAP vs SOFT PAD TAP
        // Score > 0 favors Rigid Keratin Nail Tap; Score <= 0 favors Viscoelastic Soft Pad Tap
        const centroidTerm = (centroidKhz - 2.2) / 0.75;
        const ratioTerm = (hfLfDb - 0.5) / 4.5;
        const attackTerm = (3.4 - attackMs) / 2.5;
        const crestTerm = (crestFactor - 3.6) / 1.8;

        const nailScore =
          0.42 * centroidTerm + 0.34 * ratioTerm + 0.14 * crestTerm + 0.1 * attackTerm;

        if (centroidKhz >= 2.6 && hfLfDb >= 0.5) {
          gesture = 'nail-tap';
          confidence = clamp(0.76 + 0.08 * Math.min(2.8, Math.max(0, nailScore)), 0.74, 0.99);
        } else if (centroidKhz <= 1.8 && hfLfDb <= -0.5) {
          gesture = 'soft-pad';
          confidence = clamp(0.76 + 0.08 * Math.min(2.8, Math.max(0, -nailScore)), 0.74, 0.99);
        } else if (nailScore > 0) {
          gesture = 'nail-tap';
          confidence = clamp(0.66 + 0.1 * Math.min(2.5, nailScore), 0.65, 0.96);
        } else {
          gesture = 'soft-pad';
          confidence = clamp(0.66 + 0.1 * Math.min(2.5, -nailScore), 0.65, 0.96);
        }
      }

      const intensityPct = Math.round(clamp(((peakSnrDb - 4.0) / 32.0) * 100, 8, 100));

      const eventObj = {
        gesture,
        confidence: Math.round(confidence * 100) / 100,
        centroidKhz: Math.round(centroidKhz * 100) / 100,
        hfLfDb: Math.round(hfLfDb * 10) / 10,
        durationMs,
        intensityPct,
        crestFactor: Math.round(crestFactor * 100) / 100,
        flatness: Math.round(meanFlatness * 1000) / 1000,
        zcr: Math.round(meanZcr * 1000) / 1000,
        attackMs: Math.round(attackMs * 10) / 10,
        timeSec: Math.round(this.timeSec * 1000) / 1000
      };

      this.lastEvent = eventObj;
      this.lastVetoReason = null;
      return eventObj;
    }
  }

  // ===========================================================================
  // Genuine 48 kHz Physical Acoustic Waveform Synthesizers
  // ===========================================================================

  /**
   * 1. Viscoelastic Soft Fingertip Pad Tap (`10–55 ms`, 80–950 Hz flexural plate thud,
   *    steep > 3 kHz roll-off, spectral centroid < 1.8 kHz, moderate crest factor).
   */
  function synthesizeSoftPadTap(options = {}) {
    const sr = options.sampleRate || 48000;
    const durMs = clamp(options.durationMs || 28, 14, 52);
    const preSec = options.preIdleSec !== undefined ? options.preIdleSec : 0.065;
    const postSec = options.postIdleSec !== undefined ? options.postIdleSec : 0.075;
    const amp = options.amplitude !== undefined ? options.amplitude : 0.42;
    const addSonar = Boolean(options.addSonar);
    const rng = createRng(options.seed || 101);

    const durSec = durMs / 1000;
    const totalSamples = Math.floor((preSec + durSec + postSec) * sr);
    const out = new Float32Array(totalSamples);
    const s0 = Math.floor(preSec * sr);
    const s1 = s0 + Math.floor(durSec * sr);

    const lpThud = new BiquadFilter('lowpass', 720, sr, 0.707);
    const lpRoll = new BiquadFilter('lowpass', 1450, sr, 0.707);

    for (let n = 0; n < totalSamples; n++) {
      let x = randNormal(rng) * 0.0004;
      if (addSonar) {
        // Smooth 10 ms edge ramp prevents artificial rectangular step click at buffer boundaries
        const edgeSamples = Math.floor(0.01 * sr);
        const sonarEnv =
          n < edgeSamples
            ? 0.5 * (1 - Math.cos((Math.PI * n) / edgeSamples))
            : n > totalSamples - edgeSamples
            ? 0.5 * (1 - Math.cos((Math.PI * (totalSamples - n)) / edgeSamples))
            : 1.0;
        x +=
          sonarEnv *
          (0.08 * Math.sin((2 * Math.PI * 18375 * n) / sr) +
            0.07 * Math.sin((2 * Math.PI * 20250 * n) / sr));
      }

      if (n >= s0 && n < s1) {
        const t = (n - s0) / sr;
        const prog = (n - s0) / Math.max(1, s1 - s0);
        // Viscoelastic soft flesh contact rise (~5.5 ms) + exponential plate damping
        const rise = Math.sin(Math.min(1, prog / 0.24) * (Math.PI * 0.5));
        const decay = Math.exp(-t / (durSec * 0.36));
        const env = rise * rise * decay;

        // Fundamental aluminum chassis flexural modes (170 Hz, 320 Hz, 540 Hz, 790 Hz)
        const modes =
          0.52 * Math.sin(2 * Math.PI * 175 * t) +
          0.34 * Math.sin(2 * Math.PI * 330 * t + 0.4) +
          0.2 * Math.sin(2 * Math.PI * 560 * t + 1.1) +
          0.11 * Math.sin(2 * Math.PI * 810 * t + 2.0);
        const fleshNoise = lpThud.process(randNormal(rng)) * 0.45;
        const rawImpact = lpRoll.process((modes + fleshNoise) * env * amp);
        x += rawImpact;
      }
      out[n] = x;
    }
    return out;
  }

  /**
   * 2. Rigid Keratin Fingernail Tap (`6–45 ms`, Dirac-like < 3 ms attack,
   *    bright 2.8–14 kHz flexural/air click, centroid > 2.6 kHz, high crest factor).
   */
  function synthesizeNailTap(options = {}) {
    const sr = options.sampleRate || 48000;
    const durMs = clamp(options.durationMs || 16, 8, 42);
    const preSec = options.preIdleSec !== undefined ? options.preIdleSec : 0.065;
    const postSec = options.postIdleSec !== undefined ? options.postIdleSec : 0.075;
    const amp = options.amplitude !== undefined ? options.amplitude : 0.54;
    const addSonar = Boolean(options.addSonar);
    const rng = createRng(options.seed || 202);

    const durSec = durMs / 1000;
    const totalSamples = Math.floor((preSec + durSec + postSec) * sr);
    const out = new Float32Array(totalSamples);
    const s0 = Math.floor(preSec * sr);
    const s1 = s0 + Math.floor(durSec * sr);

    const hpClick = new BiquadFilter('highpass', 3200, sr, 0.85);
    const lpClick = new BiquadFilter('lowpass', 13600, sr, 0.75);

    for (let n = 0; n < totalSamples; n++) {
      let x = randNormal(rng) * 0.0004;
      if (addSonar) {
        const edgeSamples = Math.floor(0.01 * sr);
        const sonarEnv =
          n < edgeSamples
            ? 0.5 * (1 - Math.cos((Math.PI * n) / edgeSamples))
            : n > totalSamples - edgeSamples
            ? 0.5 * (1 - Math.cos((Math.PI * (totalSamples - n)) / edgeSamples))
            : 1.0;
        x +=
          sonarEnv *
          (0.08 * Math.sin((2 * Math.PI * 18375 * n) / sr) +
            0.07 * Math.sin((2 * Math.PI * 20250 * n) / sr));
      }

      if (n >= s0 && n < s1) {
        const k = n - s0;
        const t = k / sr;
        // Sub-millisecond (< 0.6 ms) Dirac-like keratin contact onset + fast flexural dispersion
        const attack = Math.min(1, k / Math.max(1, Math.floor(0.0005 * sr)));
        const fastClickEnv = attack * Math.exp(-t / 0.0018);
        const plateRingEnv = attack * Math.exp(-t / (durSec * 0.26));

        const highModes =
          0.38 * Math.sin(2 * Math.PI * 3950 * t) +
          0.42 * Math.sin(2 * Math.PI * 6350 * t + 0.7) +
          0.35 * Math.sin(2 * Math.PI * 9100 * t + 1.5) +
          0.25 * Math.sin(2 * Math.PI * 11850 * t + 2.3);
        const broadbandClick = lpClick.process(hpClick.process(randNormal(rng)));

        x += amp * (0.75 * fastClickEnv * broadbandClick + 0.52 * plateRingEnv * highModes);
      }
      out[n] = x;
    }
    return out;
  }

  /**
   * 3. Sustained Fingernail Scratch across Anodized Aluminum / CNC Grille (`>= 70 ms`,
   *    continuous broadband 3.5–15 kHz micro-chatter, Wiener flatness > 0.25, high ZCR).
   */
  function synthesizeNailScratch(options = {}) {
    const sr = options.sampleRate || 48000;
    const durMs = Math.max(75, options.durationMs || 175);
    const preSec = options.preIdleSec !== undefined ? options.preIdleSec : 0.065;
    const postSec = options.postIdleSec !== undefined ? options.postIdleSec : 0.075;
    const amp = options.amplitude !== undefined ? options.amplitude : 0.26;
    const addSonar = Boolean(options.addSonar);
    const rng = createRng(options.seed || 303);

    const durSec = durMs / 1000;
    const totalSamples = Math.floor((preSec + durSec + postSec) * sr);
    const out = new Float32Array(totalSamples);
    const s0 = Math.floor(preSec * sr);
    const s1 = s0 + Math.floor(durSec * sr);

    const hpChatter = new BiquadFilter('highpass', 3500, sr, 0.707);
    const lpChatter = new BiquadFilter('lowpass', 14600, sr, 0.707);

    for (let n = 0; n < totalSamples; n++) {
      let x = randNormal(rng) * 0.0004;
      if (addSonar) {
        const edgeSamples = Math.floor(0.01 * sr);
        const sonarEnv =
          n < edgeSamples
            ? 0.5 * (1 - Math.cos((Math.PI * n) / edgeSamples))
            : n > totalSamples - edgeSamples
            ? 0.5 * (1 - Math.cos((Math.PI * (totalSamples - n)) / edgeSamples))
            : 1.0;
        x +=
          sonarEnv *
          (0.08 * Math.sin((2 * Math.PI * 18375 * n) / sr) +
            0.07 * Math.sin((2 * Math.PI * 20250 * n) / sr));
      }

      if (n >= s0 && n < s1) {
        const t = (n - s0) / sr;
        const prog = (n - s0) / Math.max(1, s1 - s0);
        const edgeEnv =
          prog < 0.08 ? prog / 0.08 : prog > 0.92 ? (1 - prog) / 0.08 : 1.0;
        // Stick-slip CNC grille hole micro-impulses (~135 Hz hole-crossing modulation)
        const holeMod = 0.68 + 0.32 * Math.sin(2 * Math.PI * 135 * t);
        const chatter = lpChatter.process(hpChatter.process(randNormal(rng)));
        x += amp * edgeEnv * holeMod * chatter;
      }
      out[n] = x;
    }
    return out;
  }

  /**
   * 4. Harmonic Voiced Speech Generator (`F0 = 110–240 Hz` + vocal tract formants F1/F2/F3)
   *    for verifying false-positive rejection.
   */
  function synthesizeVoicedSpeech(options = {}) {
    const sr = options.sampleRate || 48000;
    const durMs = options.durationMs || 210;
    const f0 = options.f0Hz || 142;
    const preSec = options.preIdleSec !== undefined ? options.preIdleSec : 0.065;
    const postSec = options.postIdleSec !== undefined ? options.postIdleSec : 0.075;
    const amp = options.amplitude !== undefined ? options.amplitude : 0.34;
    const rng = createRng(options.seed || 404);

    const durSec = durMs / 1000;
    const totalSamples = Math.floor((preSec + durSec + postSec) * sr);
    const out = new Float32Array(totalSamples);
    const s0 = Math.floor(preSec * sr);
    const s1 = s0 + Math.floor(durSec * sr);

    let phase = 0;
    for (let n = 0; n < totalSamples; n++) {
      let x = randNormal(rng) * 0.0004;
      if (n >= s0 && n < s1) {
        const t = (n - s0) / sr;
        const prog = (n - s0) / Math.max(1, s1 - s0);
        const env = prog < 0.12 ? prog / 0.12 : prog > 0.88 ? (1 - prog) / 0.12 : 1.0;
        const instF0 = f0 * (1 + 0.015 * Math.sin(2 * Math.PI * 5.2 * t));
        phase += (2 * Math.PI * instF0) / sr;

        // Glottal harmonic stack shaped by vowel formants (F1=520Hz, F2=1480Hz, F3=2450Hz)
        let vowel = 0;
        for (let h = 1; h <= 16; h++) {
          const fh = h * instF0;
          const g1 = Math.exp(-Math.pow((fh - 520) / 190, 2));
          const g2 = 0.65 * Math.exp(-Math.pow((fh - 1480) / 260, 2));
          const g3 = 0.28 * Math.exp(-Math.pow((fh - 2450) / 320, 2));
          const weight = (1 / Math.pow(h, 0.85)) * (0.25 + g1 + g2 + g3);
          vowel += weight * Math.sin(h * phase + h * 0.37);
        }
        x += amp * env * vowel * 0.35;
      }
      out[n] = x;
    }
    return out;
  }

  // ===========================================================================
  // Secondary Grid Cell 03 DOM UI (`mount(cellEl, bus)`)
  // ===========================================================================

  const SVG_NS = 'http://www.w3.org/2000/svg';

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

  function ensureStylesheetLoaded() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.querySelector('link[href*="nail-pad.css"]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'cells/left-grille/nail-pad.css';
    document.head.appendChild(link);
  }

  function buildTactileIndicatorSvg() {
    const holes = [];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 6; c++) {
        holes.push(
          svgEl('circle', {
            cx: 14 + c * 12,
            cy: 14 + r * 12,
            r: 1.35,
            class: 'np-svg-hole'
          })
        );
      }
    }

    // 1. Soft Pad concentric viscoelastic rings (Cobalt #0052cc)
    const padGroup = svgEl('g', { class: 'np-svg-glyph np-svg-glyph--pad' }, [
      svgEl('circle', { cx: 44, cy: 32, r: 9, class: 'np-pad-core' }),
      svgEl('circle', { cx: 44, cy: 32, r: 16, class: 'np-pad-ring np-pad-ring--1' }),
      svgEl('circle', { cx: 44, cy: 32, r: 23, class: 'np-pad-ring np-pad-ring--2' })
    ]);

    // 2. Nail Tap crisp Dirac keratin impulse star (Emerald #047857)
    const nailGroup = svgEl('g', { class: 'np-svg-glyph np-svg-glyph--nail' }, [
      svgEl('line', { x1: 44, y1: 8, x2: 44, y2: 56, class: 'np-nail-ray' }),
      svgEl('line', { x1: 20, y1: 32, x2: 68, y2: 32, class: 'np-nail-ray' }),
      svgEl('line', { x1: 28, y1: 16, x2: 60, y2: 48, class: 'np-nail-ray np-nail-ray--diag' }),
      svgEl('line', { x1: 60, y1: 16, x2: 28, y2: 48, class: 'np-nail-ray np-nail-ray--diag' }),
      svgEl('polygon', { points: '44,24 52,32 44,40 36,32', class: 'np-nail-diamond' })
    ]);

    // 3. Nail Scratch serrated tribological micro-chatter wave (Vermilion #c93700)
    const scratchGroup = svgEl('g', { class: 'np-svg-glyph np-svg-glyph--scratch' }, [
      svgEl('polyline', {
        points: '10,36 17,22 23,42 29,18 35,44 41,20 47,43 53,19 59,41 65,23 71,38 78,28',
        class: 'np-scratch-trace'
      })
    ]);

    return svgEl(
      'svg',
      {
        viewBox: '0 0 88 64',
        class: 'np-tactile-svg',
        'aria-hidden': 'true'
      },
      [
        svgEl('rect', {
          x: 1,
          y: 1,
          width: 86,
          height: 62,
          rx: 5,
          class: 'np-svg-plate'
        }),
        ...holes,
        padGroup,
        nailGroup,
        scratchGroup
      ]
    );
  }

  // Tooltip copy (ui/NOTES.md section 4). Each text was checked against its handler below.
  const NP_TIPS = {
    arm: 'Turn on the shared grille microphone for every sensor on this page.',
    armNoBus: 'No shared microphone on this page; click to play a synthetic nail tap.',
    armLive: 'Listening. Click to turn the shared microphone off for every sensor.',
    armRequesting: 'Waiting for microphone permission. Click to cancel.',
    armRetry: 'The microphone failed. Click to ask for it again.',
    ready: 'Microphone off. Try Sim, or Arm to classify your own taps.',
    arming: 'Waiting for microphone permission.',
    live: 'Listening on the shared microphone for finger-pad taps, nail taps and scratches.',
    sim: 'Showing a synthetic gesture, not the microphone.',
    veto: 'Ignored a voiced sound such as speech or humming; it clears on the next tap.',
    simPad: 'Play a synthetic soft fingertip tap through the detector.',
    simNail: 'Play a synthetic fingernail tap through the detector.',
    simScratch: 'Play a synthetic fingernail scratch through the detector.',
    trim: 'Adjust the detection threshold and high/low balance; saved in this browser.',
    trimReset: 'Restore the default threshold and balance.',
    trimDone: 'Close the trim panel.',
    threshold: 'How far above the noise floor a sound must rise to count, in dB.',
    bias: 'Shifts the high/low balance: plus leans toward nail, minus toward pad.',
    glyph: 'Simulate a soft tap. Shift-click for a nail tap, Option-click for a scratch.',
    confidence: 'How sure the classifier is about the last gesture.',
    intensity: 'Intensity: how far the last gesture rose above the noise floor, on a 0–100 scale.',
    meta: 'Typical range of each class: pad thud band, nail click band, scratch length.',
    metaPad: 'Duration, crest factor (CF: peak over average level) and the pad thud band.',
    metaNail: 'Duration, attack under 3 ms and the nail click band.',
    metaScratch: 'Duration, spectral flatness (SFM: how noise-like) and the scratch band.',
    centroid: 'Centroid: the average pitch of the sound; nails sound higher than finger pads.',
    hfLf: 'HF/LF: high- versus low-frequency energy, in decibels.',
    zonePad: 'Finger-pad range: centroid below 1.8 kHz.',
    zoneNail: 'Nail range: centroid above 2.6 kHz, for taps and scratches.',
    split: 'Live share of low (LF) and high (HF) frequency energy.',
    history: 'The last three gestures, newest first.',
    floor: 'NF, noise floor: the quietest level the mic hears now, in dB.',
    compact: 'This tile is too narrow for the Sim and Trim controls. Widen the window.'
  };
  const SIM_STATUS = {
    'soft-pad': 'SIM · PAD',
    'nail-tap': 'SIM · NAIL',
    'nail-scratch': 'SIM · SCRATCH',
    voice: 'SIM · VOICE'
  };

  function mountNailPadCell(cellEl, passedBus) {
    if (!cellEl) return null;
    ensureStylesheetLoaded();

    while (cellEl.firstChild) cellEl.removeChild(cellEl.firstChild);
    cellEl.classList.add('np-cell');
    cellEl.setAttribute('aria-label', '03 Nail Scratch vs Soft Finger Tap Acoustic Classifier');

    const getBus = () => passedBus || (global.LeftGrilleLab && global.LeftGrilleLab.bus) || null;

    let simTimer = null;
    let announceTimer = null;
    let simSeedCounter = 1;
    let trimOpen = false;
    let busState = { state: 'idle', sampleRate: 48000 };
    const recentHistory = [];

    const classifier = new NailPadClassifier({
      sampleRate: 48000,
      onTelemetry: handleTelemetry,
      onEvent: handleGestureEvent
    });

    const srLive = h('div', {
      className: 'np-sr-only ui-sr-only',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true'
    });

    function announce(msg) {
      srLive.textContent = '';
      if (announceTimer !== null) clearTimeout(announceTimer);
      announceTimer = setTimeout(() => {
        announceTimer = null;
        srLive.textContent = msg;
      }, 18);
    }

    // -------------------------------------------------------------------------
    // Head: index · title · status pill · Arm (shared sensor cell frame, left-grille NOTES.md)
    // -------------------------------------------------------------------------
    const armLabel = h('span', { textContent: 'Arm' });
    const armBtn = h(
      'button',
      {
        type: 'button',
        className: 'np-btn--arm ui-btn ui-btn--sm',
        dataset: { armed: 'false' },
        'aria-pressed': 'false',
        'data-tone': 'idle',
        'data-tip': getBus() ? NP_TIPS.arm : NP_TIPS.armNoBus,
        onClick: () => {
          const b = getBus();
          if (!b) {
            runSyntheticWaveform('nail-tap');
            return;
          }
          const isActive =
            busState.state === 'listening' ||
            busState.state === 'requesting' ||
            b.state === 'listening' ||
            b.state === 'requesting';
          if (isActive && typeof b.stopAll === 'function') {
            b.stopAll({ dispatchClose: false });
          } else if (typeof b.requestArm === 'function') {
            b.requestArm();
          } else {
            runSyntheticWaveform('nail-tap');
          }
        }
      },
      [armLabel]
    );

    // The pill's label keeps the `np-status` hook (text + data-veto); tone and tip live on the wrapper.
    const statusPill = h('span', { className: 'ui-pill-label np-status', textContent: 'READY' });
    const statusWrap = h(
      'span',
      { className: 'ui-pill np-pill-status', role: 'note', tabindex: '0', 'data-tone': 'idle', 'data-tip': NP_TIPS.ready },
      [statusPill]
    );

    const simBtn = (label, cls, tip, kind) =>
      h(
        'button',
        {
          type: 'button',
          className: `np-mini-btn ${cls} ui-btn ui-btn--sm ui-btn--quiet`,
          'data-tip': tip,
          onClick: () => runSyntheticWaveform(kind)
        },
        [label]
      );
    const simPadBtn = simBtn('Pad', 'np-mini-btn--pad', NP_TIPS.simPad, 'soft-pad');
    const simNailBtn = simBtn('Nail', 'np-mini-btn--nail', NP_TIPS.simNail, 'nail-tap');
    const simScratchBtn = simBtn('Scratch', 'np-mini-btn--scratch', NP_TIPS.simScratch, 'nail-scratch');

    const trimBtn = h(
      'button',
      {
        type: 'button',
        className: 'np-btn--trim ui-btn ui-btn--sm ui-btn--quiet',
        'aria-expanded': 'false',
        'data-tip': NP_TIPS.trim,
        onClick: () => toggleTrimPopover(undefined, true)
      },
      ['Trim']
    );

    const bezel = h('header', { className: 'np-bezel ui-tile-head' }, [
      h('span', { className: 'ui-tile-index', textContent: '03' }),
      h('span', { className: 'ui-tile-title', textContent: 'Nail or pad' }),
      h('div', { className: 'ui-tile-actions' }, [statusWrap, armBtn])
    ]);

    // -------------------------------------------------------------------------
    // Body hero: the pad / nail / scratch class with its spectrum (centroid scale + HF/LF split)
    // -------------------------------------------------------------------------
    const tactileTag = h('span', { className: 'np-tactile-caption ui-sr-only', textContent: 'DECK' });
    const tactileWell = h(
      'button',
      {
        type: 'button',
        className: 'np-tactile-well',
        dataset: { gesture: 'idle', active: 'false' },
        'aria-label': 'Simulate a gesture on the deck',
        'data-tip': NP_TIPS.glyph,
        onClick: (ev) => {
          if (ev.altKey) runSyntheticWaveform('nail-scratch');
          else if (ev.shiftKey) runSyntheticWaveform('nail-tap');
          else runSyntheticWaveform('soft-pad');
        }
      },
      [buildTactileIndicatorSvg(), tactileTag]
    );

    const confPill = h('span', { className: 'np-pill ui-readout', 'data-tip': NP_TIPS.confidence, textContent: '—' });
    const intPill = h('span', {
      className: 'np-pill np-pill--int ui-readout ui-readout--quiet',
      'data-tip': NP_TIPS.intensity,
      textContent: 'IDLE'
    });
    const heroBadge = h('div', {
      className: 'np-badge',
      dataset: { gesture: 'idle' },
      textContent: '— TAP OR SCRATCH'
    });
    const heroMeta = h('div', {
      className: 'np-hero-meta ui-readout ui-readout--quiet',
      'data-tip': NP_TIPS.meta,
      textContent: 'Pad 80–950Hz · Nail 2.8–14k · Scratch ≥70ms'
    });

    const heroCard = h('div', { className: 'np-hero-card', dataset: { gesture: 'idle' } }, [
      tactileWell,
      heroBadge,
      heroMeta,
      h('div', { className: 'np-pill-group' }, [confPill, intPill])
    ]);

    const centroidVal = h('strong', { className: 'np-num ui-readout', textContent: '0.00 kHz' });
    const hfLfVal = h('strong', {
      className: 'np-num np-num--ratio ui-readout',
      dataset: { polarity: 'neutral' },
      textContent: '0.0 dB'
    });

    const centroidMarker = h('div', {
      className: 'np-centroid-marker',
      dataset: { gesture: 'idle' },
      style: 'left: 12%;'
    });

    const centroidTrack = h('div', { className: 'np-centroid-track' }, [
      h('div', { className: 'np-zone np-zone--pad', 'data-tip': NP_TIPS.zonePad }, ['Pad']),
      h('div', { className: 'np-zone np-zone--mid' }),
      h('div', { className: 'np-zone np-zone--nail', 'data-tip': NP_TIPS.zoneNail }, ['Nail · scratch']),
      centroidMarker
    ]);

    const lfFill = h('div', { className: 'np-split-fill np-split-fill--lf', style: 'width: 4%;' });
    const hfFill = h('div', {
      className: 'np-split-fill np-split-fill--hf',
      dataset: { gesture: 'idle' },
      style: 'width: 4%;'
    });
    const lfPctText = h('span', { className: 'np-split-tag ui-readout ui-readout--quiet', textContent: 'LF 0%' });
    const hfPctText = h('span', { className: 'np-split-tag ui-readout ui-readout--quiet', textContent: 'HF 0%' });

    const splitMeterRow = h('div', { className: 'np-split-row', 'data-tip': NP_TIPS.split }, [
      lfPctText,
      h('div', { className: 'np-split-bar' }, [
        h('div', { className: 'np-split-half np-split-half--lf' }, [lfFill]),
        h('div', { className: 'np-split-divider' }),
        h('div', { className: 'np-split-half np-split-half--hf' }, [hfFill])
      ]),
      hfPctText
    ]);

    const metersCard = h('div', { className: 'np-meters-card' }, [
      h('div', { className: 'np-meters-head' }, [
        h('span', { className: 'np-meter-stat', 'data-tip': NP_TIPS.centroid }, [
          h('span', { className: 'ui-label', textContent: 'Centroid' }),
          centroidVal
        ]),
        h('span', { className: 'np-meter-stat', 'data-tip': NP_TIPS.hfLf }, [
          h('span', { className: 'ui-label', textContent: 'HF/LF' }),
          hfLfVal
        ])
      ]),
      centroidTrack,
      splitMeterRow
    ]);

    const historyTape = h('div', { className: 'np-history-tape ui-hide-compact', 'data-tip': NP_TIPS.history }, [
      h('span', { className: 'np-hist-empty ui-readout ui-readout--quiet', textContent: 'No gestures yet' })
    ]);

    // -------------------------------------------------------------------------
    // Foot: Sim group + Trim, noise floor on the right
    // -------------------------------------------------------------------------
    const floorTag = h('span', {
      className: 'np-floor-tag ui-readout ui-readout--quiet',
      'data-tip': NP_TIPS.floor,
      textContent: 'NF -68dB'
    });

    const footer = h('footer', { className: 'np-footer ui-tile-foot' }, [
      h('div', { className: 'np-sim-group' }, [
        h('span', { className: 'ui-label', textContent: 'Sim' }),
        simPadBtn,
        simNailBtn,
        simScratchBtn,
        h('span', { className: 'np-foot-sep', 'aria-hidden': 'true' }),
        trimBtn
      ]),
      floorTag
    ]);

    // -------------------------------------------------------------------------
    // Optional Calibration Trim Popover (`localStorage` `dwg.nailPadCal.v1`)
    // -------------------------------------------------------------------------
    const threshReadout = h('span', {
      className: 'np-trim-val ui-readout',
      textContent: `${classifier.thresholdDb.toFixed(1)} dB`
    });
    const threshInput = h('input', {
      type: 'range',
      className: 'np-trim-slider ui-slider',
      min: '6',
      max: '20',
      step: '0.5',
      value: String(classifier.thresholdDb),
      'aria-label': 'Onset threshold above the noise floor, in dB',
      'data-tip': NP_TIPS.threshold,
      onInput: (e) => {
        const v = parseFloat(e.target.value);
        classifier.setCalibration({ thresholdDb: v });
        threshReadout.textContent = `${classifier.thresholdDb.toFixed(1)} dB`;
      }
    });

    const biasReadout = h('span', {
      className: 'np-trim-val ui-readout',
      textContent: `${classifier.hfLfBiasDb >= 0 ? '+' : ''}${classifier.hfLfBiasDb.toFixed(1)} dB`
    });
    const biasInput = h('input', {
      type: 'range',
      className: 'np-trim-slider ui-slider',
      min: '-6',
      max: '6',
      step: '0.5',
      value: String(classifier.hfLfBiasDb),
      'aria-label': 'High/low frequency balance trim, in dB',
      'data-tip': NP_TIPS.bias,
      onInput: (e) => {
        const v = parseFloat(e.target.value);
        classifier.setCalibration({ hfLfBiasDb: v });
        biasReadout.textContent = `${
          classifier.hfLfBiasDb >= 0 ? '+' : ''
        }${classifier.hfLfBiasDb.toFixed(1)} dB`;
      }
    });

    const trimOverlay = h('div', { className: 'np-trim-overlay', hidden: true, role: 'group', 'aria-label': 'Trim' }, [
      h('div', { className: 'np-trim-head' }, [
        h('span', { className: 'ui-label', textContent: 'Trim · saved in this browser' }),
        h('div', { className: 'np-trim-actions' }, [
          h(
            'button',
            {
              type: 'button',
              className: 'np-mini-btn ui-btn ui-btn--sm',
              'data-tip': NP_TIPS.trimReset,
              onClick: () => {
                const def = classifier.resetCalibration();
                threshInput.value = String(def.thresholdDb);
                biasInput.value = String(def.hfLfBiasDb);
                threshReadout.textContent = `${def.thresholdDb.toFixed(1)} dB`;
                biasReadout.textContent = '+0.0 dB';
              }
            },
            ['Reset']
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'np-mini-btn ui-btn ui-btn--sm',
              'data-tip': NP_TIPS.trimDone,
              'data-tip-key': 'Escape',
              onClick: () => toggleTrimPopover(false, true)
            },
            ['Done']
          )
        ])
      ]),
      h('label', { className: 'np-trim-row' }, [
        h('span', { className: 'ui-label', textContent: 'Threshold' }),
        threshInput,
        threshReadout
      ]),
      h('label', { className: 'np-trim-row' }, [
        h('span', { className: 'ui-label', textContent: 'HF/LF bias' }),
        biasInput,
        biasReadout
      ])
    ]);

    function toggleTrimPopover(forceState, restoreFocus = false) {
      const wasOpen = trimOpen;
      trimOpen = typeof forceState === 'boolean' ? forceState : !trimOpen;
      trimOverlay.hidden = !trimOpen;
      trimBtn.setAttribute('aria-expanded', trimOpen ? 'true' : 'false');
      if (trimOpen && !wasOpen) {
        if (typeof threshInput.focus === 'function') {
          threshInput.focus();
        }
      } else if (!trimOpen && wasOpen && restoreFocus) {
        if (typeof trimBtn.focus === 'function') {
          trimBtn.focus();
        }
      }
    }

    const body = h('div', { className: 'np-body ui-tile-body' }, [
      heroCard,
      metersCard,
      historyTape,
      h('span', { className: 'np-compact-note ui-label', 'data-tip': NP_TIPS.compact, textContent: 'Widen for Sim and Trim' }),
      trimOverlay
    ]);

    const stage = h('div', { className: 'np-stage lg-cell-stage' }, [bezel, body, footer, srLive]);

    cellEl.appendChild(stage);

    // -------------------------------------------------------------------------
    // Live Telemetry & Committed Event Rendering
    // -------------------------------------------------------------------------
    function renderMeters(centroidKhz, hfLfDb, lfLevel, hfLevel, activeGesture) {
      centroidVal.textContent = `${centroidKhz.toFixed(2)} kHz`;
      const sign = hfLfDb > 0 ? '+' : '';
      hfLfVal.textContent = `${sign}${hfLfDb.toFixed(1)} dB`;
      hfLfVal.dataset.polarity = hfLfDb >= 1.0 ? 'hf' : hfLfDb <= -1.0 ? 'lf' : 'neutral';

      const markerPct = clamp((centroidKhz / 12.0) * 100, 3, 97);
      centroidMarker.style.left = `${markerPct.toFixed(1)}%`;
      if (activeGesture) {
        centroidMarker.dataset.gesture = activeGesture;
        hfFill.dataset.gesture = activeGesture;
      }

      const lfPct = Math.round(clamp(lfLevel * 100, 0, 100));
      const hfPct = Math.round(clamp(hfLevel * 100, 0, 100));
      lfFill.style.width = `${Math.max(4, lfPct)}%`;
      hfFill.style.width = `${Math.max(4, hfPct)}%`;
      lfPctText.textContent = `LF ${lfPct}%`;
      hfPctText.textContent = `HF ${hfPct}%`;
    }

    function handleTelemetry(tel) {
      tactileWell.dataset.active = tel.active ? 'true' : 'false';
      floorTag.textContent = `NF ${Math.round(tel.noiseFloorDb)}dB`;

      if (tel.vetoReason === 'voice') {
        setStatus('VOICE VETO', true);
      } else if (simTimer === null && statusPill.dataset.veto === 'true') {
        // Veto cleared (next burst started or committed): restore the bus status label.
        setStatus(baseStatusText(), false);
      }

      if (tel.active || !classifier.lastEvent) {
        const provisionalGesture =
          tel.centroidKhz < 1.9 ? 'soft-pad' : tel.flatness > 0.3 ? 'nail-scratch' : 'nail-tap';
        renderMeters(
          tel.centroidKhz,
          tel.hfLfDb,
          tel.lfLevel,
          tel.hfLevel,
          tel.active ? provisionalGesture : classifier.lastEvent?.gesture || 'idle'
        );
      } else {
        // Keep committed event's centroid/ratio sticky while still updating live LF/HF bars
        const ev = classifier.lastEvent;
        const lfPct = Math.round(clamp(tel.lfLevel * 100, 0, 100));
        const hfPct = Math.round(clamp(tel.hfLevel * 100, 0, 100));
        lfFill.style.width = `${Math.max(4, lfPct)}%`;
        hfFill.style.width = `${Math.max(4, hfPct)}%`;
      }
    }

    function handleGestureEvent(ev) {
      const g = ev.gesture;
      heroBadge.dataset.gesture = g;
      heroCard.dataset.gesture = g;
      tactileWell.dataset.gesture = g;

      if (g === 'soft-pad') {
        heroBadge.textContent = '● SOFT PAD';
        tactileTag.textContent = 'PAD';
        heroMeta.textContent = `${ev.durationMs}ms · CF ${ev.crestFactor.toFixed(1)} · 80–950Hz thud`;
        heroMeta.setAttribute('data-tip', NP_TIPS.metaPad);
      } else if (g === 'nail-tap') {
        heroBadge.textContent = '◆ NAIL TAP';
        tactileTag.textContent = 'NAIL';
        heroMeta.textContent = `${ev.durationMs}ms · <3ms atk · 2.8–14k click`;
        heroMeta.setAttribute('data-tip', NP_TIPS.metaNail);
      } else {
        heroBadge.textContent = '≈ NAIL SCRATCH';
        tactileTag.textContent = 'SCRATCH';
        heroMeta.textContent = `${ev.durationMs}ms · SFM ${ev.flatness.toFixed(2)} · 3.5–15k chatter`;
        heroMeta.setAttribute('data-tip', NP_TIPS.metaScratch);
      }

      confPill.textContent = `${Math.round(ev.confidence * 100)}%`;
      intPill.textContent = `${ev.intensityPct}% INT`;

      const displayLf =
        g === 'soft-pad' ? clamp(ev.intensityPct / 100, 0.35, 1) : clamp(0.18 - ev.hfLfDb * 0.008, 0.06, 0.4);
      const displayHf =
        g === 'soft-pad' ? clamp(0.16 + ev.hfLfDb * 0.006, 0.05, 0.32) : clamp(ev.intensityPct / 100, 0.4, 1);

      renderMeters(ev.centroidKhz, ev.hfLfDb, displayLf, displayHf, g);

      // Update recent history tape (max 3 compact pills)
      const shortName = g === 'soft-pad' ? 'PAD' : g === 'nail-tap' ? 'NAIL' : 'SCR';
      recentHistory.unshift({
        gesture: g,
        text: `${shortName} ${ev.durationMs}ms · ${ev.centroidKhz.toFixed(1)}k`
      });
      if (recentHistory.length > 3) recentHistory.pop();

      while (historyTape.firstChild) historyTape.removeChild(historyTape.firstChild);
      recentHistory.forEach((item) => {
        historyTape.appendChild(
          h('span', {
            className: 'np-hist-pill',
            dataset: { gesture: item.gesture },
            textContent: item.text
          })
        );
      });

      announce(
        `${g.replace('-', ' ')}, centroid ${ev.centroidKhz.toFixed(1)} kilohertz, duration ${
          ev.durationMs
        } milliseconds, confidence ${Math.round(ev.confidence * 100)} percent.`
      );
    }

    /**
     * Synthesizes a genuine 48 kHz physical waveform (`soft-pad`, `nail-tap`, or `nail-scratch`)
     * and streams it in 512-sample chunks through the real `NailPadClassifier` instance.
     */
    function runSyntheticWaveform(kind, opts = {}) {
      if (simTimer !== null) {
        clearInterval(simTimer);
        simTimer = null;
      }
      const seed = (opts.seed || Date.now() + simSeedCounter++ * 97) >>> 0;
      let samples;
      if (kind === 'soft-pad') {
        samples = synthesizeSoftPadTap({ sampleRate: 48000, seed, addSonar: true });
      } else if (kind === 'nail-tap') {
        samples = synthesizeNailTap({ sampleRate: 48000, seed, addSonar: true });
      } else if (kind === 'nail-scratch') {
        samples = synthesizeNailScratch({ sampleRate: 48000, seed, addSonar: true });
      } else if (kind === 'voice') {
        samples = synthesizeVoicedSpeech({ sampleRate: 48000, seed });
      } else {
        samples = synthesizeSoftPadTap({ sampleRate: 48000, seed });
      }

      if (opts.immediate) {
        return classifier.processSamples(samples, 48000);
      }

      setStatus(SIM_STATUS[kind] || 'SIM · TAP', false);
      const chunkSize = 512;
      let offset = 0;
      simTimer = setInterval(() => {
        if (offset >= samples.length || isDocHidden()) {
          // Finished, or the tab hid mid-Sim (a one-shot demo is dropped, not replayed late).
          clearInterval(simTimer);
          simTimer = null;
          setStatus(baseStatusText(), false);
          return;
        }
        const slice = samples.subarray(offset, Math.min(samples.length, offset + chunkSize));
        offset += chunkSize;
        classifier.processSamples(slice, 48000);
      }, 8);
      return null;
    }

    // -------------------------------------------------------------------------
    // Shared Bus Wiring (`subscribeAudio`, `onStateChange`, `lg-secondary-close`)
    // -------------------------------------------------------------------------
    let unsubAudio = null;
    let unsubState = null;
    // Set when mic frames were dropped while the tab was hidden; the adaptive floor and burst
    // state are stale after the gap, so the classifier restarts on the first visible frame.
    let skippedWhileHidden = false;

    function baseStatusText() {
      const st = busState && busState.state;
      if (st === 'listening') return `LIVE · ${Math.round((busState.sampleRate || 48000) / 1000)}k`;
      if (st === 'requesting') return 'ARMING…';
      // Mic denied or failed: same words and tone as chirp sonar and tap zones (Sim still works).
      if (st === 'error') return 'SIM ONLY';
      return 'READY';
    }

    // One writer for the status pill: label text + data-veto (test hooks) and the wrapper's
    // tone and tip, so the tip always describes the label that is showing.
    function setStatus(text, veto) {
      statusPill.dataset.veto = veto ? 'true' : 'false';
      statusPill.textContent = text;
      let tone = 'attention';
      let tip;
      if (veto) tip = NP_TIPS.veto;
      else if (text.indexOf('SIM ·') === 0) {
        tone = 'idle';
        tip = NP_TIPS.sim;
      } else if (text === 'ARMING…') tip = NP_TIPS.arming;
      else if (text === 'SIM ONLY') {
        const err = busState && busState.error ? String(busState.error).trim() : 'Microphone error.';
        const full = /[.!?]$/.test(err) ? err : `${err}.`;
        tip = /\bsim\b/i.test(err) ? full : `${full} Sim buttons still work.`;
      } else if (text.indexOf('LIVE') === 0) tip = NP_TIPS.live;
      else {
        tone = 'idle';
        tip = NP_TIPS.ready;
      }
      statusWrap.setAttribute('data-tone', tone);
      statusWrap.setAttribute('data-tip', tip);
    }

    function attachBus(b) {
      if (!b) return;
      if (typeof b.subscribeAudio === 'function' && !unsubAudio) {
        unsubAudio = b.subscribeAudio((pkt) => {
          if (simTimer !== null || !pkt || !pkt.samples) return;
          if (isDocHidden()) {
            skippedWhileHidden = true;
            return;
          }
          if (skippedWhileHidden) {
            skippedWhileHidden = false;
            classifier.reset();
          }
          classifier.processSamples(pkt.samples, pkt.sampleRate || 48000, pkt.timeSec);
        });
      }
      if (typeof b.onStateChange === 'function' && !unsubState) {
        unsubState = b.onStateChange((st) => {
          if (!st) return;
          busState = st;
          if (st.state === 'idle') {
            classifier.reset();
          }
          const isArmed = st.state === 'listening' || st.state === 'requesting';
          armBtn.dataset.armed = isArmed ? 'true' : 'false';
          armBtn.setAttribute('aria-pressed', isArmed ? 'true' : 'false');
          armLabel.textContent =
            st.state === 'requesting' ? 'Arming…' : st.state === 'listening' ? 'Live' : st.state === 'error' ? 'Retry' : 'Arm';
          // Running (live or asking for the mic) is a rust quiet button, per the sensor frame.
          armBtn.setAttribute('data-tone', isArmed ? 'attention' : 'idle');
          armBtn.setAttribute(
            'data-tip',
            st.state === 'listening'
              ? NP_TIPS.armLive
              : st.state === 'requesting'
                ? NP_TIPS.armRequesting
                : st.state === 'error'
                  ? NP_TIPS.armRetry
                  : NP_TIPS.arm
          );
          if (simTimer === null) {
            setStatus(baseStatusText(), false);
          }
        });
      }
    }

    attachBus(getBus());

    function onDocKeyDown(e) {
      if (trimOpen && e && e.key === 'Escape') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        toggleTrimPopover(false, true);
      }
    }

    function onSecondaryClose() {
      if (simTimer !== null) {
        clearInterval(simTimer);
        simTimer = null;
      }
      toggleTrimPopover(false, false);
      classifier.reset();
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('lg-secondary-close', onSecondaryClose);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('keydown', onDocKeyDown, true);
    }

    return {
      classifier,
      runSyntheticWaveform,
      attachBus,
      destroy() {
        if (simTimer !== null) {
          clearInterval(simTimer);
          simTimer = null;
        }
        if (announceTimer !== null) {
          clearTimeout(announceTimer);
          announceTimer = null;
        }
        if (typeof unsubAudio === 'function') unsubAudio();
        if (typeof unsubState === 'function') unsubState();
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('lg-secondary-close', onSecondaryClose);
        }
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
          document.removeEventListener('keydown', onDocKeyDown, true);
        }
      }
    };
  }

  // Register Secondary Slot 3 on `window.LeftGrilleLab`
  const Lab = (global.LeftGrilleLab = global.LeftGrilleLab || { _pending: [] });
  const spec = {
    id: 'nail-pad',
    title: 'Nail vs Soft Pad',
    mount: mountNailPadCell
  };
  if (typeof Lab.registerCell === 'function') {
    Lab.registerCell(3, spec);
  } else {
    (Lab._pending = Lab._pending || []).push([3, spec]);
  }

  return {
    STORAGE_KEY,
    QUANTUM,
    FFT_SIZE,
    MAX_PASSBAND_HZ,
    BiquadFilter,
    NailPadClassifier,
    NailPadDspCore: NailPadClassifier,
    synthesizeSoftPadTap,
    synthesizeNailTap,
    synthesizeNailScratch,
    synthesizeVoicedSpeech,
    mountNailPadCell,
    spec
  };
});
