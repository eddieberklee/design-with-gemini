/**
 * Left-Grille Acoustic Swipe Sensing Engine (`cells/left-grille/acoustic-engine.js`)
 *
 * Hybrid active-ultrasonic + passive-tribological DSP pipeline tailored to
 * MacBook Pro 14"/16" (e.g. Mac16,5) left speaker grille geometry:
 *   - Top of left grille (y ≈ 0.08–0.22, ~1.65 cm from top): Studio 3-mic array beneath
 *     real CNC-machined through-holes.
 *   - Mid/Bottom of left grille (y ≈ 0.28–1.00, 11.0 cm total span): Blind cosmetic
 *     indentations over unibody aluminum; left-channel speaker vents acoustically across
 *     the left grille surface.
 *
 * Synthesizes the winning Protocol B multi-cue architecture:
 *   1. Clock-locked single-worklet full-duplex topology (`QUANTUM = 128`, 375 Hz at 48 kHz)
 *      with 4 non-uniform integer-periodic Newman-phased ultrasonic carriers (`>= 18.375 kHz`
 *      at 48 kHz, minimum spacing >= 2 bins so periodic Hann window places exact -inf dB
 *      analytical zeros on every sibling carrier while non-uniform gaps prevent coherent
 *      tweeter 2nd-order IMD addition) + 45 ms raised-cosine start/stop envelope.
 *   2. 64-frame Hann-windowed, DC-clutter-notched, 128-pt Complex Baseband FFT (`2.93 Hz/bin`)
 *      with 85th-percentile micro-Doppler edge + LLAP conjugate-product phase velocity.
 *   3. Contact-frozen cross-carrier median Pinhole Shadow (`pinholeOcclusion`) + `<165 Hz`
 *      pneumatic seal energy over the top-left CNC mic ports.
 *   4. PSD-per-bin normalized, velocity-tilt-compensated tribological spectral ratio
 *      (`6–15 kHz` air turbulence vs `375–2700 Hz` IMD-notched chassis conduction),
 *      odd-bin ultrasonic click blanker, Wiener spectral flatness speech veto, 64 ms
 *      pre-roll onset buffer, heteroscedastic uncertainty `uncertaintyPct`, and robust
 *      Theil-Sen stroke regression.
 *
 * UMD-compatible: runs identically in AudioWorkletGlobalScope, main-thread fallback, and Node.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LeftGrilleAcousticEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const QUANTUM = 128;
  const DOPPLER_HISTORY = 64;
  const DOPPLER_FFT_SIZE = 128;
  const DEFAULT_GRILLE_CM = 11.0;
  const SPEED_OF_SOUND_CMS = 34300;

  function clamp(v, lo, hi) {
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
   * Non-uniform integer-periodic carrier multiples `m_k` (`f_k = m_k * sampleRate / 128`):
   * - At 48 kHz (`fFrame = 375 Hz`): `[49, 51, 54, 57]` -> `[18375, 19125, 20250, 21375]` Hz.
   *   Minimum gap >= 2 bins (`750 Hz`) guarantees exact -infinity dB periodic Hann zeros on
   *   every neighbor carrier, while non-uniform spacings (`2, 3, 3` -> pairwise diffs `2, 3, 5, 6, 8`)
   *   prevent coherent tweeter intermodulation and let us notch exact IMD bins in `eMid`.
   * - Adapts cleanly to 44.1 kHz (`[50, 52, 55, 58]` -> `17.2..20.0 kHz`) and 96 kHz.
   */
  function buildCarrierMultiples(sampleRate) {
    const fFrame = sampleRate / QUANTUM;
    const maxBin = Math.min(60, Math.floor((Math.min(21600, sampleRate * 0.456)) / fFrame));
    const offsets = [0, 3, 6, 8]; // spacings from top: -3, -3, -2 -> [mTop-8, mTop-6, mTop-3, mTop]
    const multiples = [];
    for (let i = offsets.length - 1; i >= 0; i--) {
      const m = maxBin - offsets[i];
      if (m >= 24 && m * fFrame >= 17100) {
        multiples.push(m);
      }
    }
    if (multiples.length < 3) {
      return [maxBin - 6, maxBin - 4, maxBin - 2, maxBin].filter((m) => m > 16);
    }
    return multiples;
  }

  /**
   * Robust Weighted / Median Theil-Sen pairwise slope estimator `dy/dt`.
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
      this.sampleRate = options.sampleRate || 48000;
      this.grilleLengthCm = options.grilleLengthCm || DEFAULT_GRILLE_CM;
      this.frameRate = this.sampleRate / QUANTUM;
      this.dt = QUANTUM / this.sampleRate;
      this.txEnabled = options.txEnabled !== false;
      this.txGain = options.txGain !== undefined ? options.txGain : 0.036; // ~ -31 dBFS composite RMS (inaudible, linear)
      this.currentTxEnv = 0; // Raised-cosine / smooth ramp state for zero-pop arm/disarm
      this.polarity = options.polarity === -1 ? -1 : 1;

      this.calibration = Object.assign(
        {
          specBottomDb: -8.2,
          specTopDb: 3.8,
          snrBottomDb: 7.5,
          snrTopDb: 29.0
        },
        options.calibration || {}
      );

      // Periodic Hann window (exact analytical spectral zeros at +-2, +-3, ... bins!)
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
      this.centerCarrierHz = median(this.carrierFreqs);

      // Compute exact 2nd-order tweeter IMD difference bins |m_i - m_j| so passive E_mid notches them out
      this.imdBins = new Set();
      for (let i = 0; i < this.numCarriers; i++) {
        for (let j = i + 1; j < this.numCarriers; j++) {
          this.imdBins.add(Math.abs(this.carrierMultiples[j] - this.carrierMultiples[i]));
        }
      }

      // Compute quiet ultrasonic guard bins strictly >=1 bin away from every carrier
      const carrierSet = new Set(this.carrierMultiples);
      this.guardBins = [];
      for (let b = this.carrierMultiples[0] - 2; b <= this.carrierMultiples[this.numCarriers - 1] + 1; b++) {
        if (b > 38 && b < 62 && !carrierSet.has(b)) {
          this.guardBins.push(b);
        }
      }

      this.cosTable = [];
      this.sinTable = [];
      this.txQuantum = new Float32Array(QUANTUM);
      for (let k = 0; k < this.numCarriers; k++) {
        const m = this.carrierMultiples[k];
        const cArr = new Float64Array(QUANTUM);
        const sArr = new Float64Array(QUANTUM);
        const crestPhase = (Math.PI * k * k) / this.numCarriers; // Newman phase
        for (let n = 0; n < QUANTUM; n++) {
          const theta = (2 * Math.PI * m * n) / QUANTUM + crestPhase;
          cArr[n] = Math.cos(theta);
          sArr[n] = Math.sin(theta);
          this.txQuantum[n] += cArr[n] / this.numCarriers;
        }
        this.cosTable.push(cArr);
        this.sinTable.push(sArr);
      }

      let peakTx = 0;
      for (let n = 0; n < QUANTUM; n++) {
        const a = Math.abs(this.txQuantum[n]);
        if (a > peakTx) peakTx = a;
      }
      if (peakTx > 0) {
        for (let n = 0; n < QUANTUM; n++) {
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

      this.lpAlpha = 1 - Math.exp((-2 * Math.PI * 165) / this.sampleRate);
      this.lpState = 0;

      this.inRing = new Float32Array(QUANTUM);
      this.inRingFill = 0;

      this.ambientFricDb = -68;
      this.ambientHfDb = -74;
      this.ambientGuardPow = 1e-12;
      this.ambientDopplerPower = 1e-10;
      this.floorsInitialized = false;

      // 18-frame (~48 ms) onset pre-roll ring buffer so fast flicks preserve initial y_start%
      this.preRoll = [];
      this.preRollMax = 18;

      this.y = 0.5;
      this.vy = 0;
      this.uncertaintyPct = 10;
      this.speedCmPerSec = 0;
      this.activeStroke = null;
      this.cooldownUntilSec = 0;
      this.lastVeto = null;
      this.lastSwipe = null;
      this.swipeCount = 0;
      this.calibrationCapture = null;
    }

    setCalibration(partial) {
      if (!partial) return;
      if (typeof partial.polarity === 'number') {
        this.polarity = partial.polarity < 0 ? -1 : 1;
      }
      Object.assign(this.calibration, partial);
    }

    startCalibrationStep(stepName) {
      this.calibrationCapture = { step: stepName, samples: [] };
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
      const meanDoppler = median(cap.samples.map((s) => s.dopplerAsym));

      if (cap.step === 'top') {
        this.calibration.specTopDb = median(cap.samples.map((s) => s.specRatioDb));
        this.calibration.snrTopDb = Math.max(12, median(cap.samples.map((s) => s.fricSnrDb)));
        return { ok: true, calibration: Object.assign({}, this.calibration), polarity: this.polarity };
      }
      if (cap.step === 'bottom') {
        this.calibration.specBottomDb = median(cap.samples.map((s) => s.specRatioDb));
        this.calibration.snrBottomDb = Math.max(4, median(cap.samples.map((s) => s.fricSnrDb)));
        return { ok: true, calibration: Object.assign({}, this.calibration), polarity: this.polarity };
      }

      if (cap.step === 'up') {
        const naturalSign = lateSnr + lateSpec >= earlySnr + earlySpec || meanDoppler >= 0;
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
      } else if (cap.step === 'down') {
        const naturalSign = earlySnr + earlySpec >= lateSnr + lateSpec || meanDoppler <= 0;
        this.polarity = naturalSign ? 1 : -1;
      }

      return {
        ok: true,
        calibration: Object.assign({}, this.calibration),
        polarity: this.polarity
      };
    }

    /**
     * Fills Left-Speaker output (`leftOut`) with smooth 45 ms raised-cosine/exponential ramp
     * so arming/disarming produces zero audible click; forces strict digital 0.0 on `rightOut`.
     */
    fillTxBlock(leftOut, rightOut) {
      const len = leftOut.length;
      const target = this.txEnabled ? this.txGain : 0;
      const stepAlpha = 1 - Math.exp(-1 / Math.max(1, 0.015 * this.sampleRate));
      let env = this.currentTxEnv;
      for (let i = 0; i < len; i++) {
        env += stepAlpha * (target - env);
        leftOut[i] = env * this.txQuantum[i & 127];
      }
      this.currentTxEnv = env;
      if (rightOut) {
        rightOut.fill(0);
      }
    }

    processSamples(inputSamples) {
      const events = [];
      let offset = 0;
      const total = inputSamples.length;
      while (offset < total) {
        const needed = QUANTUM - this.inRingFill;
        const avail = total - offset;
        const copyCount = avail < needed ? avail : needed;
        for (let i = 0; i < copyCount; i++) {
          this.inRing[this.inRingFill + i] = inputSamples[offset + i];
        }
        this.inRingFill += copyCount;
        offset += copyCount;
        if (this.inRingFill === QUANTUM) {
          const frameResult = this._processQuantum(this.inRing);
          if (frameResult) events.push(frameResult);
          this.inRingFill = 0;
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
      let lp = this.lpState;
      const lpA = this.lpAlpha;
      for (let n = 0; n < QUANTUM; n++) {
        const x = buf[n];
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
          const vRadCms = ((dPhi * this.frameRate) * SPEED_OF_SOUND_CMS) / (4 * Math.PI * this.carrierFreqs[k]);
          phaseVelAccum += vRadCms * dynPow;
          phaseWeightAccum += dynPow;
        }
        this.prevDynI[k] = dynI;
        this.prevDynQ[k] = dynQ;
      }

      this.iqWriteIdx = (idx + 1) & (DOPPLER_HISTORY - 1);

      // 3. 128-pt Passive Tribological FFT (IMD-notched mid band + open-pinhole HF band)
      fftRadix2(this.fftRe, this.fftIm);

      const binHz = this.frameRate;
      const midStart = Math.max(1, Math.round(375 / binHz));
      const midEnd = Math.max(midStart + 1, Math.round(2700 / binHz));
      const hf1End = Math.max(midEnd + 1, Math.round(5600 / binHz));
      const hf2End = Math.min(43, Math.round(15200 / binHz));

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

      for (let b = 1; b <= hf2End; b++) {
        const p = (this.fftRe[b] * this.fftRe[b] + this.fftIm[b] * this.fftIm[b]) / (QUANTUM * QUANTUM);
        if (b >= midStart && b <= midEnd) {
          // Notch exact 2nd-order tweeter IMD difference bins if TX pilot is active
          if (!this.imdBins.has(b)) {
            eMid += p;
            nMid++;
          }
        } else if (b <= hf1End) {
          eHf1 += p;
          nHf1++;
        } else {
          eHf2 += p;
          nHf2++;
        }

        if (b >= 1 && b <= hf2End) {
          const ps = p + 1e-16;
          logSum += Math.log(ps);
          linSum += ps;
          if (ps > maxBinPow) maxBinPow = ps;
          flatCount++;
        }
      }

      const psdMid = eMid / Math.max(1, nMid);
      const psdHf1 = eHf1 / Math.max(1, nHf1);
      const psdHf2 = eHf2 / Math.max(1, nHf2);

      // Ultrasonic quiet guard-bin click detector (blanks impulsive clicks before 64-frame I/Q FFT)
      let guardPow = 0;
      for (let g = 0; g < this.guardBins.length; g++) {
        const gb = this.guardBins[g];
        guardPow += (this.fftRe[gb] * this.fftRe[gb] + this.fftIm[gb] * this.fftIm[gb]) / (QUANTUM * QUANTUM);
      }
      guardPow /= Math.max(1, this.guardBins.length);
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

      const geomMean = Math.exp(logSum / Math.max(1, flatCount));
      const arithMean = linSum / Math.max(1, flatCount);
      const spectralFlatness = clamp(geomMean / (arithMean + 1e-16), 0, 1);
      const tonalCrest = maxBinPow / (arithMean + 1e-16);

      const totalFricEnergy = eMid + eHf1 + eHf2;
      const hfFricEnergy = eHf1 + eHf2;
      const fricDb = 10 * Math.log10(totalFricEnergy + 1e-15);
      const hfDb = 10 * Math.log10(hfFricEnergy + 1e-15);

      if (!this.floorsInitialized && this.framesProcessed >= 8) {
        this.ambientFricDb = fricDb;
        this.ambientHfDb = hfDb;
        this.floorsInitialized = true;
      } else if (!this.activeStroke) {
        const alphaFloor = fricDb < this.ambientFricDb ? 0.12 : 0.004;
        this.ambientFricDb += alphaFloor * (fricDb - this.ambientFricDb);
        const alphaHf = hfDb < this.ambientHfDb ? 0.12 : 0.004;
        this.ambientHfDb += alphaHf * (hfDb - this.ambientHfDb);
      }

      const fricSnrDb = 0.45 * (fricDb - this.ambientFricDb) + 0.55 * (hfDb - this.ambientHfDb);
      const hfSnrDb = hfDb - this.ambientHfDb;

      // Velocity-tilt-compensated spectral ratio (prevents fast bottom swipes from mimicking top pinhole HF)
      const velTiltCompDb = 0.055 * Math.min(this.speedCmPerSec, 42);
      const rawSpecRatioDb = 10 * Math.log10(
        (psdHf2 + 0.025 * pneuEnergy + 1e-16) / (psdMid + 0.25 * psdHf1 + 1e-16)
      );
      const specRatioDb = rawSpecRatioDb - velTiltCompDb;

      const occDb = occRatiosDb.length ? median(occRatiosDb) : 0;
      const pinholeOcclusion = carrierMagMean > 8e-5 ? clamp((-occDb - 1.2) / 9.5, 0, 1) : 0;

      // 4. Multi-Carrier Zoomed Complex Baseband Doppler Spectrum (2.93 Hz/bin at 48 kHz)
      let dopplerAsym = 0;
      let dopplerVelCms = 0;
      let dopplerSnrDb = 0;
      const shouldRunDoppler = (this.framesProcessed & 1) === 0 && this.framesProcessed >= 16;

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
        dopplerAsym =
          ((posPow - negPow) / (totalDopplerPow + 2.5 * this.ambientDopplerPower + 1e-15)) * this.polarity;

        if (weightSum > 1e-15) {
          const signedDopplerHz = (weightedHz / weightSum) * this.polarity;
          dopplerVelCms = (signedDopplerHz * SPEED_OF_SOUND_CMS) / (1.65 * this.centerCarrierHz);
        }

        this._lastDoppler = { dopplerAsym, dopplerVelCms, dopplerSnrDb, dopplerPeakRatio };
      } else if (this._lastDoppler) {
        dopplerAsym = this._lastDoppler.dopplerAsym;
        dopplerVelCms = this._lastDoppler.dopplerVelCms;
        dopplerSnrDb = this._lastDoppler.dopplerSnrDb;
      }
      const dopplerPeakRatio = this._lastDoppler ? this._lastDoppler.dopplerPeakRatio : 1;

      const llapVelCms =
        phaseWeightAccum > 1e-10 ? (phaseVelAccum / phaseWeightAccum) * this.polarity : 0;

      // 5. Contact & Ultrasonic Gesture Gate + Veto Diagnostics
      const isVoiceLike =
        (fricDb - this.ambientFricDb) > 9.0 && (hfSnrDb < 3.5 || tonalCrest >= 14.0 || spectralFlatness < 0.14);
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
        (rawSpecRatioDb - velTiltCompDb * 0.5 - cal.specBottomDb) /
          Math.max(2.5, cal.specTopDb - cal.specBottomDb),
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

      // Heteroscedastic uncertainty: snaps tight (±4.5%) over top CNC mic pinholes, ±11% over lower blind dimples
      const targetUncPct = pinholeOcclusion > 0.35 ? 4.5 : isActiveSignal ? lerp(11.5, 5.5, proxTop) : 12.0;
      this.uncertaintyPct = 0.8 * this.uncertaintyPct + 0.2 * targetUncPct;

      if (this.calibrationCapture && (isBroadbandFriction || isStrongPinholeRub || isPureSonarWave)) {
        this.calibrationCapture.samples.push({
          t: timeSec,
          specRatioDb,
          fricSnrDb,
          dopplerAsym,
          pinholeOcclusion
        });
      }

      // Maintain short onset pre-roll while idle for crisp fast-flick y_start%
      if (!this.activeStroke && fricSnrDb > 2.8 && hfSnrDb > 2.2) {
        this.preRoll.push({ t: timeSec, rawY: rawYObs, w: 0.4 });
        if (this.preRoll.length > this.preRollMax) this.preRoll.shift();
      } else if (!this.activeStroke && fricSnrDb <= 2.0) {
        this.preRoll.length = 0;
      }

      // 7. Heteroscedastic 1D Kinematic Filter (inflates R_v over pinholes so occlusion phase jumps don't spike velocity)
      const pinholeVelDamp = pinholeOcclusion > 0.4 ? 0.35 : 1.0;
      const sonarVy = (-(0.68 * dopplerVelCms + 0.32 * llapVelCms) * pinholeVelDamp) / this.grilleLengthCm;
      const hasFriction = isBroadbandFriction || isStrongPinholeRub;
      const sonarWeight = clamp((dopplerSnrDb - 5.0) / 12.0, 0, 1) * pinholeVelDamp;

      let committedSwipe = null;

      if (isActiveSignal) {
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
            contactFrames: 0,
            sonarFrames: 0
          };
        }

        const st = this.activeStroke;
        st.lastActiveTime = timeSec;
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
          const strokeLen = this.activeStroke.points.length;
          committedSwipe = this._finalizeStroke(this.activeStroke);
          if (!committedSwipe && strokeLen > 0 && strokeLen < 22) {
            this.lastVeto = { reason: 'key', untilSec: timeSec + 0.18 };
          }
          this.activeStroke = null;
          if (committedSwipe) {
            // 130 ms refractory gate suppresses airborne hand-return bounce in opposite direction
            this.cooldownUntilSec = timeSec + 0.13;
          }
        }
      } else {
        this.vy *= 0.85;
        this.speedCmPerSec *= 0.82;
      }

      if (!committedSwipe && this.framesProcessed % 3 !== 0) {
        return null;
      }

      const distTopPct = Math.round(clamp(this.y * 100, 0, 100) * 10) / 10;
      const distBottomPct = Math.round((100 - distTopPct) * 10) / 10;
      const activeVeto =
        this.lastVeto && timeSec <= this.lastVeto.untilSec ? this.lastVeto.reason : null;

      const dopplerDisplay = new Float32Array(32);
      for (let i = 0; i < 16; i++) {
        const negBin = DOPPLER_FFT_SIZE - 16 + i;
        const posBin = i + 1;
        dopplerDisplay[i] = Math.log10(1 + this.dopplerPower[negBin] * 1e9);
        dopplerDisplay[16 + i] = Math.log10(1 + this.dopplerPower[posBin] * 1e9);
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
      if (n < 24) return null;
      const durationSec = st.points[n - 1].t - st.points[0].t;
      if (durationSec < 0.068 || durationSec > 3.5) return null;

      const activeFrames = Math.max(1, st.contactFrames + st.sonarFrames);
      const meanFlatness = st.flatnessSum / activeFrames;
      const meanCrest = st.tonalCrestSum / activeFrames;
      const hasStrongSonar = st.sonarFrames >= 8 && st.maxDopplerSnrDb > 9.0;

      if (!hasStrongSonar && (meanFlatness < 0.16 || meanCrest > 15.5)) {
        return null;
      }

      const headCount = Math.max(3, Math.min(10, Math.floor(n * 0.25)));
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
        st.contactFrames >= 10
          ? clamp(-0.55 * (endY - startY) * 2.4 - 0.45 * halfDiffY * 2.8 - 0.25 * rawSlopeY * 0.6, -1.5, 1.5)
          : 0;
      const sonarVote = clamp(meanDopplerAsym * 2.1, -1.5, 1.5);

      let upScore = 0;
      let sensingMode = 'hybrid';
      if (st.contactFrames >= 10 && st.dopplerWeightSum > 1.2) {
        upScore = 0.62 * tribVote + 0.38 * sonarVote;
        sensingMode = 'hybrid';
      } else if (st.contactFrames >= 10) {
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
      if (st.contactFrames >= 10) {
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

      const swipeEvent = {
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

      this.lastSwipe = swipeEvent;
      return swipeEvent;
    }
  }

  function createWorkletSource() {
    return `
      const LeftGrilleAcousticEngine = (${factory.toString()})();
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
              this.core.txEnabled = Boolean(msg.enabled);
              if (typeof msg.gain === 'number') this.core.txGain = msg.gain;
            } else if (msg.type === 'setCalibration') {
              this.core.setCalibration(msg.calibration);
            } else if (msg.type === 'startCalStep') {
              this.core.startCalibrationStep(msg.step);
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
    fftRadix2,
    buildCarrierMultiples,
    theilSenSlope,
    AcousticDspCore,
    createWorkletSource
  };
});
