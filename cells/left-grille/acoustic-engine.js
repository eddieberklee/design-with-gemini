/**
 * Left-Grille Acoustic Swipe Sensing Engine (`cells/left-grille/acoustic-engine.js`)
 *
 * Hybrid active-ultrasonic + passive-tribological DSP pipeline tailored to
 * MacBook Pro 14"/16" (e.g. Mac16,5) left speaker grille geometry:
 *   - Top of left grille (y ≈ 0.08–0.22, ~1.65 cm from top): Studio 3-mic array beneath
 *     real CNC-machined through-holes.
 *   - Mid/Bottom of left grille (y ≈ 0.23–1.00, 11.0 cm total span): Blind cosmetic
 *     indentations over unibody aluminum; left-channel speaker vents acoustically across
 *     the left grille surface.
 *
 * Synthesizes the Protocol B multi-cue architecture with Stage 2 hardening:
 *   1. Clock-locked single-worklet full-duplex topology (`QUANTUM = 128`, 375 Hz at 48 kHz;
 *      integer boxcar decimation `decim = round(sampleRate / 48000)` at 88.2k/96k/192k so
 *      high-rate interfaces keep exact 375 Hz framing and >= 18.3 kHz carriers; automatic
 *      passive-only fallback below 40 kHz).
 *   2. 4 non-uniform integer-periodic Newman-phased ultrasonic carriers (`[18375, 19125,
 *      20250, 21375] Hz` at 48 kHz, minimum spacing >= 2 bins so periodic Hann window places
 *      exact -inf dB analytical zeros on every neighbor carrier while non-uniform gaps prevent
 *      coherent tweeter 2nd-order IMD addition) + tau = 15 ms exponential start/stop ramp.
 *   3. 64-frame Hann-windowed, DC-clutter-notched, 128-pt Complex Baseband FFT (`2.93 Hz/bin`)
 *      aligned at 1.65x oblique surface geometry with LLAP conjugate-product phase velocity.
 *   4. Contact-frozen cross-carrier median Pinhole Shadow (`pinholeOcclusion`) + `<165 Hz`
 *      pneumatic seal energy over the top-left CNC mic ports.
 *   5. PSD-per-bin normalized, velocity-tilt-compensated tribological spectral ratio,
 *      `>= 2`-bin-cleared ultrasonic click blanker, Wiener spectral flatness speech veto,
 *      18-frame (~48 ms, 85 ms TTL) pre-roll onset buffer, 3.5 s max-stroke fan-latch recovery,
 *      NaN/non-finite sanitization, and robust Theil-Sen stroke regression.
 *
 * UMD-compatible: runs identically in AudioWorkletGlobalScope, main-thread fallback, and Node.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LeftGrilleAcousticEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function engineFactory() {
  'use strict';

  const QUANTUM = 128;
  const DOPPLER_HISTORY = 64;
  const DOPPLER_FFT_SIZE = 128;
  const DEFAULT_GRILLE_CM = 11.0;
  const SPEED_OF_SOUND_CMS = 34300;
  const OBLIQUE_GEOMETRY_FACTOR = 1.65;

  function clamp(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function median(arr) {
    if (!arr.length) return 0;
    const copy = arr.slice().sort((a, b) => a - b);
    const mid = copy.length >> 1;
    return copy.length % 2 ? copy[mid] : 0.5 * (copy[mid - 1] + copy[mid]);
  }

  /**
   * In-place iterative Radix-2 Cooley-Tukey Complex FFT.
   * Forward transform: X[k] = sum_{n=0}^{N-1} x[n] * exp(-j 2*pi*k*n / N)
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
   * Computes integer decimation factor so high hardware rates (88.2k, 96k, 192k)
   * map cleanly into an effective ~44.1–48 kHz internal DSP clock.
   */
  function computeDecimationFactor(sampleRate) {
    if (!Number.isFinite(sampleRate) || sampleRate < 64000) return 1;
    return Math.max(1, Math.round(sampleRate / 48000));
  }

  /**
   * Non-uniform integer-periodic carrier multiples `m_k` (`f_k = m_k * effectiveRate / 128`).
   * Returns `[]` when `effectiveRate < 40000` (e.g. 8k/16k Bluetooth HFP) so audible tones
   * can never be synthesized on low-rate voice profiles.
   */
  function buildCarrierMultiples(sampleRate) {
    const decim = computeDecimationFactor(sampleRate);
    const effRate = sampleRate / decim;
    if (effRate < 40000) return [];
    const fFrame = effRate / QUANTUM;
    const maxBin = Math.min(60, Math.floor(Math.min(21600, effRate * 0.456) / fFrame));
    const offsets = [0, 3, 6, 8]; // non-uniform spacings: 2, 3, 3 bins -> diffs {2,3,5,6,8}
    const multiples = [];
    for (let i = offsets.length - 1; i >= 0; i--) {
      const m = maxBin - offsets[i];
      if (m >= 24 && m * fFrame >= 17100) {
        multiples.push(m);
      }
    }
    return multiples;
  }

  /**
   * Robust Median Theil-Sen pairwise slope estimator `dy/dt`.
   */
  function theilSenSlope(points) {
    const n = points.length;
    if (n < 2) return 0;
    const slopes = [];
    const stride = n > 64 ? Math.ceil(n / 64) : 1;
    for (let i = 0; i < n; i += stride) {
      for (let j = i + stride; j < n; j += stride) {
        const dt = points[j].t - points[i].t;
        if (dt >= 0.024) {
          slopes.push((points[j].y - points[i].y) / dt);
        }
      }
    }
    if (!slopes.length) {
      const dt = points[n - 1].t - points[0].t;
      return dt > 1e-4 ? (points[n - 1].y - points[0].y) / dt : 0;
    }
    return median(slopes);
  }

  class AcousticDspCore {
    constructor(options = {}) {
      const rawSr = Number(options.sampleRate);
      this.sampleRate = Number.isFinite(rawSr) && rawSr >= 8000 ? rawSr : 48000;
      this.decim = computeDecimationFactor(this.sampleRate);
      this.effectiveRate = this.sampleRate / this.decim;
      this.canUseSonar = this.effectiveRate >= 40000;

      this.grilleLengthCm =
        Number.isFinite(options.grilleLengthCm) && options.grilleLengthCm > 2
          ? options.grilleLengthCm
          : DEFAULT_GRILLE_CM;
      this.frameRate = this.effectiveRate / QUANTUM;
      this.dt = QUANTUM / this.effectiveRate;

      this.txEnabled = this.canUseSonar && options.txEnabled !== false;
      this.txGain =
        Number.isFinite(options.txGain) && options.txGain >= 0 ? options.txGain : 0.036;
      this.currentTxEnv = 0;
      this.txPhasePos = 0;
      this.polarity = options.polarity === -1 ? -1 : 1;

      this.calibration = {
        specBottomDb: -8.2,
        specTopDb: 3.8,
        snrBottomDb: 7.5,
        snrTopDb: 29.0
      };
      if (options.calibration) {
        this.setCalibration(options.calibration);
      }

      // Periodic Hann window (exact analytical spectral zeros at |Δbin| >= 2)
      this.hann128 = new Float64Array(QUANTUM);
      let hannSum = 0;
      for (let n = 0; n < QUANTUM; n++) {
        const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / QUANTUM));
        this.hann128[n] = w;
        hannSum += w;
      }
      const hannNorm = QUANTUM / hannSum;
      for (let n = 0; n < QUANTUM; n++) {
        this.hann128[n] *= hannNorm;
      }

      this.hann64 = new Float64Array(DOPPLER_HISTORY);
      for (let n = 0; n < DOPPLER_HISTORY; n++) {
        this.hann64[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (DOPPLER_HISTORY - 1)));
      }

      this.carrierMultiples = buildCarrierMultiples(this.sampleRate);
      this.numCarriers = this.carrierMultiples.length;
      this.carrierFreqs = this.carrierMultiples.map((m) => m * this.frameRate);
      this.centerCarrierHz = this.numCarriers ? median(this.carrierFreqs) : 19687.5;

      // Scale passive band bin bounds safely below Nyquist for all rates (8k, 16k, 44.1k, 48k, 96k, 192k)
      const nyquistBin = (QUANTUM >> 1) - 2; // 62
      const binHz = this.frameRate;
      const maxPassiveBin =
        this.numCarriers > 0
          ? Math.min(nyquistBin, this.carrierMultiples[0] - 4, Math.round(15200 / binHz))
          : Math.min(nyquistBin, Math.max(6, Math.floor((this.effectiveRate * 0.44) / binHz)));
      this.midStartBin = Math.max(1, Math.min(maxPassiveBin - 3, Math.round(375 / binHz)));
      this.midEndBin = Math.max(
        this.midStartBin + 1,
        Math.min(maxPassiveBin - 2, Math.round(Math.min(2700, this.effectiveRate * 0.14) / binHz))
      );
      this.hf1EndBin = Math.max(
        this.midEndBin + 1,
        Math.min(maxPassiveBin - 1, Math.round(Math.min(5600, this.effectiveRate * 0.26) / binHz))
      );
      this.hf2EndBin = Math.max(this.hf1EndBin + 1, maxPassiveBin);

      // Compute exact 2nd-order tweeter IMD difference bins |m_i - m_j| so passive E_mid notches them out
      this.imdBins = new Set();
      for (let i = 0; i < this.numCarriers; i++) {
        for (let j = i + 1; j < this.numCarriers; j++) {
          this.imdBins.add(Math.abs(this.carrierMultiples[j] - this.carrierMultiples[i]));
        }
      }

      // Guard bins strictly >= 2 bins clear of EVERY carrier (zero Hann mainlobe leakage!)
      this.guardBins = [];
      if (this.numCarriers > 0) {
        const gLo = Math.max(this.hf2EndBin + 2, this.carrierMultiples[0] - 4);
        const gHi = Math.min(nyquistBin, this.carrierMultiples[this.numCarriers - 1] + 3);
        for (let b = gLo; b <= gHi; b++) {
          let clear = true;
          for (let k = 0; k < this.numCarriers; k++) {
            if (Math.abs(b - this.carrierMultiples[k]) < 2) {
              clear = false;
              break;
            }
          }
          if (clear) this.guardBins.push(b);
        }
      }

      // Precompute demodulator tables (at decimated QUANTUM=128) AND native-rate TX period (`QUANTUM * decim`)
      this.cosTable = [];
      this.sinTable = [];
      this.txPeriod = QUANTUM * this.decim;
      this.txQuantum = new Float32Array(this.txPeriod);

      for (let k = 0; k < this.numCarriers; k++) {
        const m = this.carrierMultiples[k];
        const cArr = new Float64Array(QUANTUM);
        const sArr = new Float64Array(QUANTUM);
        const crestPhase = (Math.PI * k * k) / this.numCarriers;
        for (let n = 0; n < QUANTUM; n++) {
          const theta = (2 * Math.PI * m * n) / QUANTUM + crestPhase;
          cArr[n] = Math.cos(theta);
          sArr[n] = Math.sin(theta);
        }
        for (let n = 0; n < this.txPeriod; n++) {
          const thetaNative = (2 * Math.PI * m * n) / this.txPeriod + crestPhase;
          this.txQuantum[n] += Math.cos(thetaNative) / this.numCarriers;
        }
        this.cosTable.push(cArr);
        this.sinTable.push(sArr);
      }

      let peakTx = 0;
      for (let n = 0; n < this.txPeriod; n++) {
        const a = Math.abs(this.txQuantum[n]);
        if (a > peakTx) peakTx = a;
      }
      if (peakTx > 0) {
        for (let n = 0; n < this.txPeriod; n++) {
          this.txQuantum[n] /= peakTx;
        }
      }

      this.fftRe = new Float64Array(QUANTUM);
      this.fftIm = new Float64Array(QUANTUM);
      this.dopplerRe = new Float64Array(DOPPLER_FFT_SIZE);
      this.dopplerIm = new Float64Array(DOPPLER_FFT_SIZE);
      this.dopplerPower = new Float64Array(DOPPLER_FFT_SIZE);

      this.iqHistI = [];
      this.iqHistQ = [];
      this.carrierBaseline = new Float64Array(this.numCarriers);
      this.prevDynI = new Float64Array(this.numCarriers);
      this.prevDynQ = new Float64Array(this.numCarriers);
      this.bgI = new Float64Array(this.numCarriers);
      this.bgQ = new Float64Array(this.numCarriers);
      for (let k = 0; k < this.numCarriers; k++) {
        this.iqHistI.push(new Float64Array(DOPPLER_HISTORY));
        this.iqHistQ.push(new Float64Array(DOPPLER_HISTORY));
      }
      this.iqWriteIdx = 0;
      this.framesProcessed = 0;

      this.lpAlpha = 1 - Math.exp((-2 * Math.PI * 165) / this.effectiveRate);
      this.lpState = 0;

      // Decimation accumulator + 128-sample frame ring buffer
      this.decimSum = 0;
      this.decimCount = 0;
      this.inRing = new Float32Array(QUANTUM);
      this.inRingFill = 0;

      this.ambientFricDb = -68;
      this.ambientHfDb = -74;
      this.ambientGuardPow = 1e-12;
      this.ambientDopplerPower = 1e-10;
      this.nonSilentWarmupFrames = 0;
      this.floorsInitialized = false;

      // 18-frame (~48 ms at 48 kHz, 85 ms max age TTL) onset pre-roll ring buffer
      this.preRoll = [];
      this.preRollMax = 18;

      this.y = 0.5;
      this.vy = 0;
      this.uncertaintyPct = 10;
      this.speedCmPerSec = 0;
      this.activeStroke = null;
      this.cooldownUntilSec = 0;
      this.lastVeto = null;
      this.swipeCount = 0;
      this.calibrationCapture = null;
    }

    setTxEnabled(enabled, gain) {
      this.txEnabled = Boolean(enabled) && this.canUseSonar;
      if (Number.isFinite(gain) && gain >= 0) {
        this.txGain = clamp(gain, 0, 0.25);
      }
    }

    setCalibration(partial) {
      if (!partial || typeof partial !== 'object') return;
      if (typeof partial.polarity === 'number' && Number.isFinite(partial.polarity)) {
        this.polarity = partial.polarity < 0 ? -1 : 1;
      }
      if (Number.isFinite(partial.specBottomDb)) this.calibration.specBottomDb = partial.specBottomDb;
      if (Number.isFinite(partial.specTopDb)) this.calibration.specTopDb = partial.specTopDb;
      if (Number.isFinite(partial.snrBottomDb)) this.calibration.snrBottomDb = partial.snrBottomDb;
      if (Number.isFinite(partial.snrTopDb)) this.calibration.snrTopDb = partial.snrTopDb;
    }

    startCalibrationStep(stepName) {
      this.calibrationCapture = { step: stepName || 'up', samples: [] };
    }

    cancelCalibrationStep() {
      this.calibrationCapture = null;
    }

    finishCalibrationStep() {
      const cap = this.calibrationCapture;
      this.calibrationCapture = null;
      if (!cap || cap.samples.length < 6) {
        return { ok: false, reason: 'insufficient_signal' };
      }
      const n = cap.samples.length;
      const q1End = Math.max(2, Math.floor(n * 0.3));
      const q4Start = Math.min(n - 2, Math.floor(n * 0.7));
      const earlySpec = median(cap.samples.slice(0, q1End).map((s) => s.specRatioDb));
      const lateSpec = median(cap.samples.slice(q4Start).map((s) => s.specRatioDb));
      const earlySnr = median(cap.samples.slice(0, q1End).map((s) => s.fricSnrDb));
      const lateSnr = median(cap.samples.slice(q4Start).map((s) => s.fricSnrDb));
      const meanRawDoppler = median(cap.samples.map((s) => s.rawDopplerAsym));

      // User swiped UP (Bottom -> Top): on standard Top-Mic hardware, late > early and rawDoppler > 0
      const tribDelta = (lateSnr - earlySnr) + (lateSpec - earlySpec);
      let naturalSign = true;
      if (Math.abs(tribDelta) > 1.2) {
        naturalSign = tribDelta >= 0;
      } else if (Math.abs(meanRawDoppler) > 0.08) {
        naturalSign = meanRawDoppler >= 0;
      } else {
        return { ok: false, reason: 'insufficient_contrast' };
      }

      this.polarity = naturalSign ? 1 : -1;
      const topSpec = this.polarity === 1 ? lateSpec : earlySpec;
      const botSpec = this.polarity === 1 ? earlySpec : lateSpec;
      const topSnr = this.polarity === 1 ? lateSnr : earlySnr;
      const botSnr = this.polarity === 1 ? earlySnr : lateSnr;

      if (topSpec > botSpec + 1.5) {
        this.calibration.specTopDb = topSpec;
        this.calibration.specBottomDb = botSpec;
      }
      if (topSnr > botSnr + 3.0) {
        this.calibration.snrTopDb = topSnr;
        this.calibration.snrBottomDb = Math.max(4, botSnr);
      }

      return {
        ok: true,
        calibration: Object.assign({}, this.calibration),
        polarity: this.polarity
      };
    }

    /**
     * Fills Left-Speaker output (`leftOut`) with tau = 15 ms smooth exponential ramp
     * so arming/disarming produces zero audible click; forces strict digital 0.0 on `rightOut`.
     */
    fillTxBlock(leftOut, rightOut) {
      const len = leftOut.length;
      const target = this.txEnabled && this.canUseSonar && this.txPeriod > 0 ? this.txGain : 0;
      const stepAlpha = 1 - Math.exp(-1 / Math.max(1, 0.015 * this.sampleRate));
      let env = this.currentTxEnv;
      let pos = this.txPhasePos;
      const period = this.txPeriod;

      if (period > 0 && (target > 0 || env > 1e-7)) {
        for (let i = 0; i < len; i++) {
          env += stepAlpha * (target - env);
          leftOut[i] = env * this.txQuantum[pos];
          pos++;
          if (pos >= period) pos = 0;
        }
      } else {
        env = 0;
        leftOut.fill(0);
      }
      this.currentTxEnv = env;
      this.txPhasePos = pos;

      if (rightOut) {
        rightOut.fill(0);
      }
    }

    processSamples(inputSamples) {
      const events = [];
      const total = inputSamples.length;
      const decim = this.decim;

      if (decim === 1) {
        for (let i = 0; i < total; i++) {
          const raw = inputSamples[i];
          this.inRing[this.inRingFill++] = Number.isFinite(raw) ? raw : 0;
          if (this.inRingFill === QUANTUM) {
            const frameResult = this._processQuantum(this.inRing);
            if (frameResult) events.push(frameResult);
            this.inRingFill = 0;
          }
        }
      } else {
        for (let i = 0; i < total; i++) {
          const raw = inputSamples[i];
          this.decimSum += Number.isFinite(raw) ? raw : 0;
          this.decimCount++;
          if (this.decimCount === decim) {
            this.inRing[this.inRingFill++] = this.decimSum / decim;
            this.decimSum = 0;
            this.decimCount = 0;
            if (this.inRingFill === QUANTUM) {
              const frameResult = this._processQuantum(this.inRing);
              if (frameResult) events.push(frameResult);
              this.inRingFill = 0;
            }
          }
        }
      }
      return events;
    }

    _processQuantum(buf) {
      const idx = this.iqWriteIdx;
      const timeSec = this.framesProcessed * this.dt;
      this.framesProcessed++;

      // 1. Sub-165 Hz pneumatic pinhole-seal energy & Hann-windowed quantum prep
      let pneuEnergy = 0;
      let lp = Number.isFinite(this.lpState) ? this.lpState : 0;
      const lpA = this.lpAlpha;
      for (let n = 0; n < QUANTUM; n++) {
        const raw = buf[n];
        const x = Number.isFinite(raw) ? raw : 0;
        lp += lpA * (x - lp);
        pneuEnergy += lp * lp;
        this.fftRe[n] = x * this.hann128[n];
        this.fftIm[n] = 0;
      }
      this.lpState = lp;
      pneuEnergy /= QUANTUM;

      // 2. Coherent Quadrature Demodulation across non-uniform ultrasonic pilot comb
      let phaseVelAccum = 0;
      let phaseWeightAccum = 0;
      const occRatiosDb = [];
      let carrierMagMean = 0;

      for (let k = 0; k < this.numCarriers; k++) {
        const cTab = this.cosTable[k];
        const sTab = this.sinTable[k];
        let sumI = 0;
        let sumQ = 0;
        for (let n = 0; n < QUANTUM; n++) {
          const wx = this.fftRe[n];
          sumI += wx * cTab[n];
          sumQ -= wx * sTab[n];
        }
        const I = (2 * sumI) / QUANTUM;
        const Q = (2 * sumQ) / QUANTUM;
        this.iqHistI[k][idx] = I;
        this.iqHistQ[k][idx] = Q;

        const mag = Math.hypot(I, Q);
        carrierMagMean += mag / this.numCarriers;

        if (this.framesProcessed <= 10) {
          this.carrierBaseline[k] = mag;
          this.bgI[k] = I;
          this.bgQ[k] = Q;
        } else {
          const bgAlpha = this.activeStroke ? 0.002 : 0.04;
          this.bgI[k] += bgAlpha * (I - this.bgI[k]);
          this.bgQ[k] += bgAlpha * (Q - this.bgQ[k]);
          if (!this.activeStroke && mag > 1e-7) {
            this.carrierBaseline[k] += 0.015 * (mag - this.carrierBaseline[k]);
          }
        }

        if (this.carrierBaseline[k] > 1e-5) {
          occRatiosDb.push(20 * Math.log10((mag + 1e-8) / (this.carrierBaseline[k] + 1e-8)));
        }

        const dynI = I - this.bgI[k];
        const dynQ = Q - this.bgQ[k];
        const dynPow = dynI * dynI + dynQ * dynQ;
        const prevI = this.prevDynI[k];
        const prevQ = this.prevDynQ[k];
        const cross = dynQ * prevI - dynI * prevQ;
        const dot = dynI * prevI + dynQ * prevQ;
        if (dynPow > 1e-11 && prevI * prevI + prevQ * prevQ > 1e-11) {
          const dPhi = Math.atan2(cross, dot);
          // Match oblique 1.65x geometry factor with zoomed Doppler FFT
          const vRadCms =
            ((dPhi * this.frameRate) * SPEED_OF_SOUND_CMS) /
            (OBLIQUE_GEOMETRY_FACTOR * 2 * Math.PI * this.carrierFreqs[k]);
          phaseVelAccum += vRadCms * dynPow;
          phaseWeightAccum += dynPow;
        }
        this.prevDynI[k] = dynI;
        this.prevDynQ[k] = dynQ;
      }

      if (this.numCarriers > 0) {
        this.iqWriteIdx = (idx + 1) & (DOPPLER_HISTORY - 1);
      }

      // 3. 128-pt Passive Tribological FFT (IMD-notched mid band + open-pinhole HF band)
      fftRadix2(this.fftRe, this.fftIm);

      let eMid = 0;
      let nMid = 0;
      let eHf1 = 0;
      let nHf1 = 0;
      let eHf2 = 0;
      let nHf2 = 0;
      let logSum = 0;
      let linSum = 0;
      let flatCount = 0;
      let maxBinPow = 0;

      for (let b = 1; b <= this.hf2EndBin; b++) {
        const p = (this.fftRe[b] * this.fftRe[b] + this.fftIm[b] * this.fftIm[b]) / (QUANTUM * QUANTUM);
        if (b >= this.midStartBin && b <= this.midEndBin) {
          if (!this.txEnabled || !this.imdBins.has(b)) {
            eMid += p;
            nMid++;
          }
        } else if (b > this.midEndBin && b <= this.hf1EndBin) {
          eHf1 += p;
          nHf1++;
        } else if (b > this.hf1EndBin) {
          eHf2 += p;
          nHf2++;
        }

        const ps = p + 1e-16;
        logSum += Math.log(ps);
        linSum += ps;
        if (ps > maxBinPow) maxBinPow = ps;
        flatCount++;
      }

      const psdMid = eMid / Math.max(1, nMid);
      const psdHf1 = eHf1 / Math.max(1, nHf1);
      const psdHf2 = eHf2 / Math.max(1, nHf2);

      // Ultrasonic quiet guard-bin click detector (all bins >= 2 away from every carrier)
      if (this.guardBins.length > 0) {
        let guardPow = 0;
        for (let g = 0; g < this.guardBins.length; g++) {
          const gb = this.guardBins[g];
          guardPow +=
            (this.fftRe[gb] * this.fftRe[gb] + this.fftIm[gb] * this.fftIm[gb]) / (QUANTUM * QUANTUM);
        }
        guardPow /= this.guardBins.length;
        if (!this.floorsInitialized && this.framesProcessed >= 8) {
          this.ambientGuardPow = Math.max(1e-15, guardPow);
        } else if (!this.activeStroke) {
          const gAlpha = guardPow < this.ambientGuardPow ? 0.15 : 0.008;
          this.ambientGuardPow += gAlpha * (guardPow - this.ambientGuardPow);
        }
        const guardSpikeRatio = guardPow / (this.ambientGuardPow + 1e-15);
        if (!this.activeStroke && guardSpikeRatio > 5.5) {
          const prevSlot = idx & (DOPPLER_HISTORY - 1);
          for (let k = 0; k < this.numCarriers; k++) {
            this.iqHistI[k][prevSlot] = this.bgI[k];
            this.iqHistQ[k][prevSlot] = this.bgQ[k];
          }
        }
      }

      const geomMean = Math.exp(logSum / Math.max(1, flatCount));
      const arithMean = linSum / Math.max(1, flatCount);
      const spectralFlatness = clamp(geomMean / (arithMean + 1e-16), 0, 1);
      const tonalCrest = maxBinPow / (arithMean + 1e-16);

      const totalFricEnergy = eMid + eHf1 + eHf2;
      const hfFricEnergy = eHf1 + eHf2;
      const isDigitalSilence = totalFricEnergy < 1e-13;
      const fricDb = Math.max(-92, 10 * Math.log10(totalFricEnergy + 1e-15));
      const hfDb = Math.max(-96, 10 * Math.log10(hfFricEnergy + 1e-15));

      if (!isDigitalSilence && !this.floorsInitialized) {
        this.nonSilentWarmupFrames++;
        if (this.nonSilentWarmupFrames === 1) {
          this.ambientFricDb = fricDb;
          this.ambientHfDb = hfDb;
        } else {
          this.ambientFricDb = 0.7 * this.ambientFricDb + 0.3 * fricDb;
          this.ambientHfDb = 0.7 * this.ambientHfDb + 0.3 * hfDb;
        }
        if (this.nonSilentWarmupFrames >= 6) {
          this.floorsInitialized = true;
        }
      } else if (this.floorsInitialized && !isDigitalSilence && !this.activeStroke) {
        const alphaFloor = fricDb < this.ambientFricDb ? 0.12 : 0.006;
        this.ambientFricDb += alphaFloor * (fricDb - this.ambientFricDb);
        const alphaHf = hfDb < this.ambientHfDb ? 0.12 : 0.006;
        this.ambientHfDb += alphaHf * (hfDb - this.ambientHfDb);
      }

      const fricSnrDb = this.floorsInitialized
        ? 0.45 * (fricDb - this.ambientFricDb) + 0.55 * (hfDb - this.ambientHfDb)
        : 0;
      const hfSnrDb = this.floorsInitialized ? hfDb - this.ambientHfDb : 0;

      // Consistent velocity-tilt compensation across both live observation and calibration capture
      const velTiltCompDb = 0.028 * Math.min(this.speedCmPerSec, 42);
      const rawSpecRatioDb = 10 * Math.log10(
        (psdHf2 + 0.025 * pneuEnergy + 1e-16) / (psdMid + 0.25 * psdHf1 + 1e-16)
      );
      const specRatioDb = rawSpecRatioDb - velTiltCompDb;

      const occDb = occRatiosDb.length ? median(occRatiosDb) : 0;
      const pinholeOcclusion = carrierMagMean > 8e-5 ? clamp((-occDb - 1.2) / 9.5, 0, 1) : 0;

      // 4. Multi-Carrier Zoomed Complex Baseband Doppler Spectrum (2.93 Hz/bin at 48 kHz)
      let rawDopplerAsym = 0;
      let dopplerAsym = 0;
      let dopplerVelCms = 0;
      let dopplerSnrDb = 0;
      const shouldRunDoppler =
        this.numCarriers > 0 && (this.framesProcessed & 1) === 0 && this.framesProcessed >= 16;

      if (shouldRunDoppler) {
        this.dopplerPower.fill(0);
        const histAvail = Math.min(DOPPLER_HISTORY, this.framesProcessed);

        for (let k = 0; k < this.numCarriers; k++) {
          const hI = this.iqHistI[k];
          const hQ = this.iqHistQ[k];
          let meanI = 0;
          let meanQ = 0;
          for (let m = 0; m < histAvail; m++) {
            const rIdx = (this.iqWriteIdx - histAvail + m + DOPPLER_HISTORY) & (DOPPLER_HISTORY - 1);
            meanI += hI[rIdx];
            meanQ += hQ[rIdx];
          }
          meanI /= histAvail;
          meanQ /= histAvail;

          this.dopplerRe.fill(0);
          this.dopplerIm.fill(0);
          const padOffset = DOPPLER_HISTORY - histAvail;
          for (let m = 0; m < histAvail; m++) {
            const rIdx = (this.iqWriteIdx - histAvail + m + DOPPLER_HISTORY) & (DOPPLER_HISTORY - 1);
            const w = this.hann64[m + padOffset];
            this.dopplerRe[m] = (hI[rIdx] - meanI) * w;
            this.dopplerIm[m] = (hQ[rIdx] - meanQ) * w;
          }

          fftRadix2(this.dopplerRe, this.dopplerIm);

          for (let b = 0; b < DOPPLER_FFT_SIZE; b++) {
            this.dopplerPower[b] +=
              (this.dopplerRe[b] * this.dopplerRe[b] + this.dopplerIm[b] * this.dopplerIm[b]) /
              this.numCarriers;
          }
        }

        const dopplerBinHz = this.frameRate / DOPPLER_FFT_SIZE;
        const minBin = Math.max(2, Math.ceil(5.5 / dopplerBinHz));
        const maxBin = Math.min(40, Math.floor(95.0 / dopplerBinHz));

        let posPow = 0;
        let negPow = 0;
        let weightedHz = 0;
        let weightSum = 0;
        let maxSidebandBin = 0;
        const sidebandBins = [];

        for (let b = minBin; b <= maxBin; b++) {
          const pPos = this.dopplerPower[b];
          const pNeg = this.dopplerPower[DOPPLER_FFT_SIZE - b];
          const fHz = b * dopplerBinHz;
          posPow += pPos;
          negPow += pNeg;
          if (pPos > maxSidebandBin) maxSidebandBin = pPos;
          if (pNeg > maxSidebandBin) maxSidebandBin = pNeg;
          sidebandBins.push(pPos, pNeg);
          weightedHz += fHz * (pPos - pNeg);
          weightSum += pPos + pNeg;
        }

        const medBinPow = median(sidebandBins) + 1e-16;
        const dopplerPeakRatio = maxSidebandBin / medBinPow;

        const totalDopplerPow = posPow + negPow;
        if (!this.activeStroke && totalDopplerPow > 0) {
          const dAlpha = totalDopplerPow < this.ambientDopplerPower ? 0.15 : 0.01;
          this.ambientDopplerPower += dAlpha * (totalDopplerPow - this.ambientDopplerPower);
        }

        dopplerSnrDb = 10 * Math.log10((totalDopplerPow + 1e-16) / (this.ambientDopplerPower + 1e-16));
        rawDopplerAsym =
          (posPow - negPow) / (totalDopplerPow + 2.5 * this.ambientDopplerPower + 1e-15);
        dopplerAsym = rawDopplerAsym * this.polarity;

        if (weightSum > 1e-15) {
          const signedDopplerHz = (weightedHz / weightSum) * this.polarity;
          dopplerVelCms =
            (signedDopplerHz * SPEED_OF_SOUND_CMS) / (OBLIQUE_GEOMETRY_FACTOR * this.centerCarrierHz);
        }

        this._lastDoppler = { rawDopplerAsym, dopplerAsym, dopplerVelCms, dopplerSnrDb, dopplerPeakRatio };
      } else if (this._lastDoppler && this.numCarriers > 0) {
        rawDopplerAsym = this._lastDoppler.rawDopplerAsym;
        dopplerAsym = rawDopplerAsym * this.polarity;
        dopplerVelCms = this._lastDoppler.dopplerVelCms;
        dopplerSnrDb = this._lastDoppler.dopplerSnrDb;
      }
      const dopplerPeakRatio = this._lastDoppler ? this._lastDoppler.dopplerPeakRatio : 1;

      const llapVelCms =
        phaseWeightAccum > 1e-10 ? (phaseVelAccum / phaseWeightAccum) * this.polarity : 0;

      // 5. Contact & Ultrasonic Gesture Gate + Veto Diagnostics
      const isVoiceLike =
        fricDb - this.ambientFricDb > 9.0 &&
        (hfSnrDb < 3.5 || tonalCrest >= 14.0 || spectralFlatness < 0.14);
      if (isVoiceLike && !this.activeStroke) {
        this.lastVeto = { reason: 'voice', untilSec: timeSec + 0.18 };
      }

      const isBroadbandFriction =
        fricSnrDb > 5.2 && hfSnrDb > 4.2 && spectralFlatness > 0.16 && tonalCrest < 13.5;
      const isStrongPinholeRub =
        fricSnrDb > 12.0 &&
        hfSnrDb > 6.5 &&
        (pinholeOcclusion > 0.25 || (spectralFlatness > 0.12 && tonalCrest < 16.0));
      const isPureSonarWave =
        carrierMagMean > 8e-5 &&
        dopplerSnrDb > 9.0 &&
        Math.abs(dopplerAsym) > 0.38 &&
        dopplerPeakRatio > 3.2;

      const isActiveSignal =
        timeSec >= this.cooldownUntilSec && (isBroadbandFriction || isStrongPinholeRub || isPureSonarWave);

      // 6. Instantaneous Position Estimate yObs in [0=Top, 1=Bottom] & Heteroscedastic Uncertainty
      const cal = this.calibration;
      const cueSpec = clamp(
        (specRatioDb - cal.specBottomDb) / Math.max(2.5, cal.specTopDb - cal.specBottomDb),
        0,
        1
      );
      const cueAmp = clamp(
        (fricSnrDb - cal.snrBottomDb) / Math.max(5.0, cal.snrTopDb - cal.snrBottomDb),
        0,
        1
      );

      let proxTop = clamp(0.54 * cueSpec + 0.32 * cueAmp + 0.14 * pinholeOcclusion, 0, 1);
      if (pinholeOcclusion > 0.45 && fricSnrDb > 10) {
        proxTop = Math.max(proxTop, 0.78 + 0.18 * pinholeOcclusion);
      }
      const rawYObs = this.polarity === 1 ? 1.0 - proxTop : proxTop;

      const targetUncPct = pinholeOcclusion > 0.35 ? 4.5 : isActiveSignal ? lerp(11.5, 5.5, proxTop) : 12.0;
      this.uncertaintyPct = 0.8 * this.uncertaintyPct + 0.2 * targetUncPct;

      if (this.calibrationCapture && (isBroadbandFriction || isStrongPinholeRub || isPureSonarWave)) {
        this.calibrationCapture.samples.push({
          t: timeSec,
          specRatioDb,
          fricSnrDb,
          rawDopplerAsym,
          pinholeOcclusion
        });
        if (this.calibrationCapture.samples.length > 1500) {
          this.calibrationCapture.samples.shift();
        }
      }

      // Prune stale pre-roll (> 85 ms age TTL) so sustained low noise never skews stroke startTime
      while (this.preRoll.length && timeSec - this.preRoll[0].t > 0.085) {
        this.preRoll.shift();
      }
      if (!this.activeStroke && fricSnrDb > 2.8 && hfSnrDb > 2.2) {
        this.preRoll.push({ t: timeSec, rawY: rawYObs, w: 0.4 });
        if (this.preRoll.length > this.preRollMax) this.preRoll.shift();
      } else if (!this.activeStroke && fricSnrDb <= 2.0) {
        this.preRoll.length = 0;
      }

      // 7. Heteroscedastic 1D Kinematic Filter & Max-Duration Fan/HVAC Latch Protection
      const pinholeVelDamp = pinholeOcclusion > 0.4 ? 0.35 : 1.0;
      const sonarVy = (-(0.68 * dopplerVelCms + 0.32 * llapVelCms) * pinholeVelDamp) / this.grilleLengthCm;
      const hasFriction = isBroadbandFriction || isStrongPinholeRub;
      const sonarWeight = clamp((dopplerSnrDb - 5.0) / 12.0, 0, 1) * pinholeVelDamp;

      let committedSwipe = null;

      // Guard against sustained ambient noise floor step-up (e.g. fan/HVAC spin-up > 3.5 s)
      if (this.activeStroke && timeSec - this.activeStroke.startTime > 3.5) {
        this.activeStroke = null;
        this.ambientFricDb = fricDb;
        this.ambientHfDb = hfDb;
        this.cooldownUntilSec = timeSec + 0.12;
      } else if (isActiveSignal) {
        if (!this.activeStroke) {
          const seedPoints = hasFriction && this.preRoll.length ? this.preRoll.slice(-6) : [];
          this.preRoll.length = 0;
          const initY = hasFriction
            ? seedPoints.length
              ? seedPoints[0].rawY
              : rawYObs
            : clamp(0.5 + (dopplerAsym > 0 ? 0.22 : -0.22), 0.08, 0.92);
          this.y = initY;
          this.vy = sonarWeight > 0.3 ? sonarVy : 0;
          this.activeStroke = {
            startTime: seedPoints.length ? seedPoints[0].t : timeSec,
            lastActiveTime: timeSec,
            points: seedPoints.map((p) => ({
              t: p.t,
              y: p.rawY,
              rawY: p.rawY,
              speedCms: 0,
              w: p.w
            })),
            dopplerImpulse: 0,
            dopplerWeightSum: 0,
            flatnessSum: 0,
            tonalCrestSum: 0,
            maxFricSnrDb: fricSnrDb,
            maxDopplerSnrDb: dopplerSnrDb,
            peakSpeedCms: 0,
            activeFrames: 0,
            contactFrames: 0,
            sonarFrames: 0
          };
        }

        const st = this.activeStroke;
        st.lastActiveTime = timeSec;
        st.activeFrames++;
        if (hasFriction) st.contactFrames++;
        if (isPureSonarWave) st.sonarFrames++;
        if (fricSnrDb > st.maxFricSnrDb) st.maxFricSnrDb = fricSnrDb;
        if (dopplerSnrDb > st.maxDopplerSnrDb) st.maxDopplerSnrDb = dopplerSnrDb;
        st.flatnessSum += spectralFlatness;
        st.tonalCrestSum += tonalCrest;

        const prevY = this.y;
        const predictedY = clamp(this.y + (sonarWeight * sonarVy + (1 - sonarWeight) * this.vy) * this.dt, 0, 1);

        if (hasFriction) {
          const obsGain = clamp(
            0.18 + 0.16 * clamp(fricSnrDb / 22, 0, 1) + 0.12 * pinholeOcclusion,
            0.16,
            0.44
          );
          this.y = clamp(predictedY + obsGain * (rawYObs - predictedY), 0, 1);
        } else {
          this.y = clamp(this.y + sonarVy * this.dt * 1.15, 0.02, 0.98);
        }

        const instVy = (this.y - prevY) / this.dt;
        this.vy = 0.72 * this.vy + 0.28 * (hasFriction ? instVy : sonarVy);

        const trajSpeedCms = Math.abs(this.vy) * this.grilleLengthCm;
        const rawSonarSpeedCms = Math.abs(dopplerVelCms);
        const fusedSpeedCms = hasFriction
          ? lerp(trajSpeedCms, Math.max(trajSpeedCms, rawSonarSpeedCms), 0.35 * sonarWeight)
          : rawSonarSpeedCms;

        this.speedCmPerSec = 0.65 * this.speedCmPerSec + 0.35 * clamp(fusedSpeedCms, 0, 140);
        if (this.speedCmPerSec > st.peakSpeedCms && st.points.length >= 3) {
          st.peakSpeedCms = this.speedCmPerSec;
        }

        const ptWeight = clamp(fricSnrDb / 18, 0.2, 1.5) + sonarWeight;
        st.points.push({
          t: timeSec,
          y: this.y,
          rawY: rawYObs,
          speedCms: this.speedCmPerSec,
          w: ptWeight
        });

        if (sonarWeight > 0.08) {
          st.dopplerImpulse += dopplerAsym * sonarWeight;
          st.dopplerWeightSum += sonarWeight;
        }
      } else if (this.activeStroke) {
        const gapSec = timeSec - this.activeStroke.lastActiveTime;
        if (gapSec > 0.048) {
          const strokeDur =
            this.activeStroke.points.length > 1
              ? this.activeStroke.points[this.activeStroke.points.length - 1].t -
                this.activeStroke.points[0].t
              : 0;
          committedSwipe = this._finalizeStroke(this.activeStroke);
          if (!committedSwipe && strokeDur > 0 && strokeDur < 0.062) {
            this.lastVeto = { reason: 'key', untilSec: timeSec + 0.18 };
          }
          this.activeStroke = null;
          if (committedSwipe) {
            this.cooldownUntilSec = timeSec + 0.13;
          }
        }
      } else {
        this.vy *= 0.85;
        this.speedCmPerSec *= 0.82;
      }

      const emitStride = Math.max(1, Math.round(this.frameRate / 125));
      if (!committedSwipe && this.framesProcessed % emitStride !== 0) {
        return null;
      }

      const distTopPct = Math.round(clamp(this.y * 100, 0, 100) * 10) / 10;
      const distBottomPct = Math.round((100 - distTopPct) * 10) / 10;
      const activeVeto =
        this.lastVeto && timeSec <= this.lastVeto.untilSec ? this.lastVeto.reason : null;

      // Polarity-aware 32-bin Doppler display (skipping DC skirt bin 1, spanning bins 2..33 ≈ +-82 cm/s)
      const dopplerDisplay = new Float32Array(32);
      for (let i = 0; i < 16; i++) {
        const binOffset = 2 + i * 2;
        const rawPos = Math.max(
          this.dopplerPower[binOffset] || 0,
          this.dopplerPower[binOffset + 1] || 0
        );
        const rawNeg = Math.max(
          this.dopplerPower[DOPPLER_FFT_SIZE - binOffset] || 0,
          this.dopplerPower[DOPPLER_FFT_SIZE - binOffset - 1] || 0
        );
        const downPow = this.polarity === 1 ? rawNeg : rawPos;
        const upPow = this.polarity === 1 ? rawPos : rawNeg;
        dopplerDisplay[15 - i] = Math.log10(1 + downPow * 1e9);
        dopplerDisplay[16 + i] = Math.log10(1 + upPow * 1e9);
      }

      return {
        type: committedSwipe ? 'swipe' : 'telemetry',
        timeSec,
        active: Boolean(this.activeStroke),
        y: this.y,
        uncertaintyPct: Math.round(this.uncertaintyPct * 10) / 10,
        distanceFromTopPct: distTopPct,
        distanceFromBottomPct: distBottomPct,
        distanceFromTopCm: Math.round(this.y * this.grilleLengthCm * 10) / 10,
        distanceFromBottomCm: Math.round((1 - this.y) * this.grilleLengthCm * 10) / 10,
        speedCmPerSec: Math.round(this.speedCmPerSec * 10) / 10,
        liveDirection: Math.abs(this.vy) < 0.18 ? 'idle' : this.vy < 0 ? 'up' : 'down',
        fricSnrDb: Math.round(fricSnrDb * 10) / 10,
        dopplerSnrDb: Math.round(dopplerSnrDb * 10) / 10,
        dopplerAsym: Math.round(dopplerAsym * 100) / 100,
        pinholeOcclusion: Math.round(pinholeOcclusion * 100) / 100,
        spectralFlatness: Math.round(spectralFlatness * 100) / 100,
        carrierActive: carrierMagMean > 8e-5,
        vetoReason: activeVeto,
        dopplerSpectrum: Array.from(dopplerDisplay),
        swipe: committedSwipe
      };
    }

    _finalizeStroke(st) {
      const n = st.points.length;
      const minFrames = Math.max(6, Math.round(0.064 * this.frameRate));
      if (n < minFrames) return null;
      const durationSec = st.points[n - 1].t - st.points[0].t;
      if (durationSec < 0.068 || durationSec > 3.5) return null;

      const minModeFrames = Math.max(4, Math.round(0.026 * this.frameRate));
      const minSonarFrames = Math.max(4, Math.round(0.021 * this.frameRate));

      const meanFlatness = st.flatnessSum / Math.max(1, st.activeFrames);
      const meanCrest = st.tonalCrestSum / Math.max(1, st.activeFrames);
      const hasStrongSonar = st.sonarFrames >= minSonarFrames && st.maxDopplerSnrDb > 9.0;

      if (!hasStrongSonar && (meanFlatness < 0.16 || meanCrest > 15.5)) {
        return null;
      }

      const headCount = Math.max(2, Math.min(10, Math.floor(n * 0.25)));
      const startY = median(st.points.slice(0, headCount).map((p) => p.rawY));
      const endY = median(st.points.slice(n - headCount).map((p) => p.rawY));
      const rawSlopeY = theilSenSlope(st.points.map((p) => ({ t: p.t, y: p.rawY })));
      const filteredSlopeY = theilSenSlope(st.points);

      const half = n >> 1;
      const firstHalfY = median(st.points.slice(0, half).map((p) => p.rawY));
      const secondHalfY = median(st.points.slice(half).map((p) => p.rawY));
      const halfDiffY = secondHalfY - firstHalfY;

      const meanDopplerAsym =
        st.dopplerWeightSum > 0.25 ? st.dopplerImpulse / st.dopplerWeightSum : 0;

      const tribVote =
        st.contactFrames >= minModeFrames
          ? clamp(-0.55 * (endY - startY) * 2.4 - 0.45 * halfDiffY * 2.8 - 0.25 * rawSlopeY * 0.6, -1.5, 1.5)
          : 0;
      const sonarVote = clamp(meanDopplerAsym * 2.1, -1.5, 1.5);

      let upScore = 0;
      let sensingMode = 'hybrid';
      if (st.contactFrames >= minModeFrames && st.dopplerWeightSum > 1.2) {
        upScore = 0.62 * tribVote + 0.38 * sonarVote;
        sensingMode = 'hybrid';
      } else if (st.contactFrames >= minModeFrames) {
        upScore = tribVote;
        sensingMode = 'tribological';
      } else if (hasStrongSonar) {
        upScore = sonarVote;
        sensingMode = 'ultrasonic';
      } else {
        return null;
      }

      if (Math.abs(upScore) < 0.14) return null;

      const direction = upScore > 0 ? 'up' : 'down';
      const confidence =
        Math.round(clamp(0.44 + 0.48 * Math.min(1.15, Math.abs(upScore)), 0.48, 0.99) * 100) / 100;

      let finalStartTopPct;
      let finalEndTopPct;
      if (st.contactFrames >= minModeFrames) {
        finalStartTopPct = clamp(startY * 100, 2, 98);
        finalEndTopPct = clamp(endY * 100, 2, 98);
        if (direction === 'up' && finalEndTopPct > finalStartTopPct - 4) {
          const mid = 0.5 * (finalStartTopPct + finalEndTopPct);
          const span = Math.max(12, Math.abs(filteredSlopeY * durationSec * 100));
          finalStartTopPct = clamp(mid + span * 0.5, 5, 98);
          finalEndTopPct = clamp(mid - span * 0.5, 2, 93);
        } else if (direction === 'down' && finalEndTopPct < finalStartTopPct + 4) {
          const mid = 0.5 * (finalStartTopPct + finalEndTopPct);
          const span = Math.max(12, Math.abs(filteredSlopeY * durationSec * 100));
          finalStartTopPct = clamp(mid - span * 0.5, 2, 93);
          finalEndTopPct = clamp(mid + span * 0.5, 5, 98);
        }
      } else {
        const estTravelCm = clamp(
          median(st.points.map((p) => p.speedCms)) * durationSec,
          2.2,
          this.grilleLengthCm * 0.9
        );
        const spanPct = (estTravelCm / this.grilleLengthCm) * 100;
        if (direction === 'up') {
          finalStartTopPct = clamp(50 + spanPct * 0.5, 15, 95);
          finalEndTopPct = clamp(50 - spanPct * 0.5, 5, 85);
        } else {
          finalStartTopPct = clamp(50 - spanPct * 0.5, 5, 85);
          finalEndTopPct = clamp(50 + spanPct * 0.5, 15, 95);
        }
      }

      const spanPct = Math.abs(finalEndTopPct - finalStartTopPct);
      const distCm = (spanPct / 100) * this.grilleLengthCm;
      const avgSpeedFromSpan = distCm / Math.max(0.07, durationSec);
      const activeSpeedPts = st.points.filter((p) => p.speedCms > 0.5);
      const medianPointSpeed = activeSpeedPts.length
        ? median(activeSpeedPts.map((p) => p.speedCms))
        : avgSpeedFromSpan;
      const speedCmPerSec =
        Math.round(
          clamp(0.55 * avgSpeedFromSpan + 0.45 * Math.max(avgSpeedFromSpan, medianPointSpeed), 2.5, 130) * 10
        ) / 10;
      const peakSpeedCmPerSec = Math.round(Math.max(speedCmPerSec, st.peakSpeedCms) * 10) / 10;

      this.y = finalEndTopPct / 100;
      this.swipeCount++;

      return {
        id: this.swipeCount,
        direction,
        confidence,
        sensingMode,
        speedCmPerSec,
        peakSpeedCmPerSec,
        durationMs: Math.round(durationSec * 1000),
        startFromTopPct: Math.round(finalStartTopPct * 10) / 10,
        endFromTopPct: Math.round(finalEndTopPct * 10) / 10,
        distanceFromTopPct: Math.round(finalEndTopPct * 10) / 10,
        distanceFromBottomPct: Math.round((100 - finalEndTopPct) * 10) / 10,
        distanceFromTopCm: Math.round((finalEndTopPct / 100) * this.grilleLengthCm * 10) / 10,
        distanceFromBottomCm: Math.round(((100 - finalEndTopPct) / 100) * this.grilleLengthCm * 10) / 10,
        spanPct: Math.round(spanPct * 10) / 10,
        spanCm: Math.round(distCm * 10) / 10
      };
    }
  }

  function createWorkletSource() {
    return `
      const LeftGrilleAcousticEngine = (${engineFactory.toString()})();
      class LeftGrilleSwipeProcessor extends AudioWorkletProcessor {
        constructor(options) {
          super();
          const opts = (options && options.processorOptions) || {};
          this.core = new LeftGrilleAcousticEngine.AcousticDspCore({
            sampleRate: sampleRate,
            txEnabled: opts.txEnabled !== false,
            txGain: opts.txGain !== undefined ? opts.txGain : 0.036,
            polarity: opts.polarity || 1,
            calibration: opts.calibration || undefined
          });
          this.port.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'setTx') {
              this.core.setTxEnabled(msg.enabled, msg.gain);
            } else if (msg.type === 'setCalibration') {
              this.core.setCalibration(msg.calibration);
            } else if (msg.type === 'startCalStep') {
              this.core.startCalibrationStep(msg.step);
            } else if (msg.type === 'cancelCalStep') {
              this.core.cancelCalibrationStep();
            } else if (msg.type === 'finishCalStep') {
              const res = this.core.finishCalibrationStep();
              this.port.postMessage({ type: 'calibrationResult', result: res });
            }
          };
        }
        process(inputs, outputs) {
          const out = outputs[0];
          if (out && out.length > 0) {
            this.core.fillTxBlock(out[0], out[1] || null);
          }
          const inp = inputs[0];
          if (inp && inp.length > 0 && inp[0] && inp[0].length > 0) {
            const events = this.core.processSamples(inp[0]);
            for (let i = 0; i < events.length; i++) {
              this.port.postMessage(events[i]);
            }
          }
          return true;
        }
      }
      registerProcessor('left-grille-swipe-processor', LeftGrilleSwipeProcessor);
    `;
  }

  return {
    QUANTUM,
    DEFAULT_GRILLE_CM,
    SPEED_OF_SOUND_CMS,
    OBLIQUE_GEOMETRY_FACTOR,
    fftRadix2,
    computeDecimationFactor,
    buildCarrierMultiples,
    theilSenSlope,
    AcousticDspCore,
    createWorkletSource
  };
});
