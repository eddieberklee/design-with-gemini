/**
 * Secondary Grid Cell 04 — 18–20.5 kHz Ultrasonic Chirp Sonar
 * (`cells/left-grille/chirp-sonar.js`)
 *
 * Inaudible stereo FDMA linear FMCW ultrasonic sonar for contactless hand
 * distance (`5..55 cm`), Push-In / Pull-Out radial tracking, and Left<->Right
 * stereo hand-wave detection across the ~30 cm MacBook speaker baseline.
 *
 * Physics & DSP Pipeline:
 *   1. Stereo FDMA Chirp TX (`N_CHIRP = 1024` @ 44.1/48 kHz, `21.33 ms` period /
 *      `46.875 Hz` sweep rate; `2048` @ 88.2/96 kHz to preserve exact sweep rate):
 *      - Left speaker:  `18.00 kHz -> 19.15 kHz` (`B = 1150 Hz`)
 *      - Right speaker: `19.35 kHz -> 20.50 kHz` (`B = 1150 Hz`, `200 Hz` guard band)
 *      - Click-free Hann-windowed `384`-sample (`8.0 ms`) active pulse inside each
 *        `1024`-sample period: `47 dB` L/R cross-channel isolation, 2.7x lower FMCW
 *        range-Doppler walk than a 100% duty chirp, and `13.3 ms` quiet listening tail.
 *      - Silent (`0`) whenever `sampleRate < 40000` (e.g. Bluetooth HFP).
 *   2. Analytic Complex Matched Filter (`IFFT(FFT(rx) * conj(FFT_analytic(ref)))`):
 *      Zeroes negative frequencies to yield a smooth carrier-free I/Q range envelope.
 *   3. Adaptive Complex Clutter Cancellation (`ΔH = H - H_bg`):
 *      Cancels phase-locked direct speaker-to-mic coupling and static room multipath,
 *      with optional hardware direct-path lag auto-alignment (`autoAlignDirectPath`)
 *      for arbitrary CoreAudio loopback latency.
 *   4. Gesture Extraction:
 *      - `push` (`PUSH IN ↓`) / `pull` (`PULL OUT ↑`) via SNR-weighted range slope
 *        `dr/dt`, net range travel, and R^2 trajectory monotonicity.
 *      - `wave-right` (`WAVE →`) / `wave-left` (`WAVE ←`) via cross-channel echo
 *        energy-weighted time centroid lag (`t_R - t_L`) and L/R balance reversal.
 *
 * UMD-compatible: exports pure DSP classes via `module.exports` in Node.js and
 * registers Secondary Slot `4` on `window.LeftGrilleLab` in the browser.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.LeftGrilleChirpSonar = api;
    const Lab = (root.LeftGrilleLab = root.LeftGrilleLab || { _pending: [] });
    const spec = {
      id: 'chirp-sonar',
      title: '18–20kHz Chirp Sonar',
      mount(cellEl, bus) {
        return api.mountChirpSonarCell(cellEl, bus);
      }
    };
    if (typeof Lab.registerCell === 'function') {
      Lab.registerCell(4, spec);
    } else {
      (Lab._pending = Lab._pending || []).push([4, spec]);
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function chirpSonarFactory(global) {
  'use strict';

  const SPEED_OF_SOUND_CMS = 34300;
  const MIN_ULTRASONIC_SR = 40000;
  const BASE_CHIRP_PERIOD = 1024;
  const BASE_PULSE_LEN = 384; // 8.0 ms Hann pulse inside 21.33 ms period @ 48 kHz
  const DEFAULT_TX_GAIN = 0.04;
  const LEFT_F0_HZ = 18000;
  const LEFT_F1_HZ = 19150;
  const RIGHT_F0_HZ = 19350;
  const RIGHT_F1_HZ = 20500;
  const MIN_RANGE_CM = 4;
  const MAX_RANGE_CM = 55;
  const DISPLAY_MIN_RANGE_CM = 5;
  const DEFAULT_NUM_BINS = 24;
  const WARMUP_FRAMES = 6;

  function clamp(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  function median(arr) {
    if (!arr || !arr.length) return 0;
    const sorted = Array.from(arr).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
  }

  function computeChirpPeriod(sampleRate) {
    if (!Number.isFinite(sampleRate) || sampleRate < 80000) return BASE_CHIRP_PERIOD;
    if (sampleRate < 160000) return BASE_CHIRP_PERIOD * 2;
    return BASE_CHIRP_PERIOD * 4;
  }

  function computePulseLen(period) {
    return Math.round((period * BASE_PULSE_LEN) / BASE_CHIRP_PERIOD);
  }

  /**
   * In-place iterative Radix-2 Cooley-Tukey Complex FFT.
   * Forward: X[k] = sum_{n=0}^{N-1} x[n] * exp(-j 2*pi*k*n / N)
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
   * In-place Inverse Radix-2 Complex FFT: IFFT(Y) = conj(FFT(conj(Y))) / N
   */
  function ifftRadix2(re, im) {
    const n = re.length;
    for (let i = 0; i < n; i++) {
      im[i] = -im[i];
    }
    fftRadix2(re, im);
    const invN = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= invN;
      im[i] = -im[i] * invN;
    }
  }

  /**
   * Builds a click-free raised-cosine Hann-windowed linear FMCW chirp of active
   * length `pulseLen` embedded inside a `period`-sample repeating frame.
   */
  function buildReferenceChirp(f0Hz, f1Hz, sampleRate, period) {
    const N = period || computeChirpPeriod(sampleRate);
    const L = computePulseLen(N);
    const buf = new Float32Array(N);
    if (!Number.isFinite(sampleRate) || sampleRate < MIN_ULTRASONIC_SR) {
      return buf;
    }
    const T = L / sampleRate;
    const sweepRate = (f1Hz - f0Hz) / T;
    const denom = Math.max(1, L - 1);
    for (let n = 0; n < L; n++) {
      const t = n / sampleRate;
      const win = 0.5 * (1 - Math.cos((2 * Math.PI * n) / denom));
      const phase = 2 * Math.PI * (f0Hz * t + 0.5 * sweepRate * t * t);
      buf[n] = win * Math.cos(phase);
    }
    return buf;
  }

  /**
   * Builds the energy-normalized analytic spectrum `Ra[k]` of a real reference
   * chirp (`2 * FFT(ref)[k]` for positive bins `1..N/2-1`, `0` elsewhere) so that
   * `IFFT(FFT(rx) * conj(Ra))` yields a smooth complex envelope peaking at `A`
   * for `rx[n] = A * ref[(n - d) mod N]`.
   */
  function buildAnalyticRefSpectrum(refChirp) {
    const N = refChirp.length;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      re[i] = refChirp[i];
    }
    fftRadix2(re, im);

    let halfPowerSum = 0;
    const half = N >> 1;
    for (let k = 1; k < half; k++) {
      halfPowerSum += re[k] * re[k] + im[k] * im[k];
    }
    // Scaling factor: (2 / N) * halfPowerSum equals sum(ref[n]^2)
    const energyNorm = Math.max(1e-12, (2 / N) * halfPowerSum);
    const scale = 2 / energyNorm;

    const aRe = new Float64Array(N);
    const aIm = new Float64Array(N);
    for (let k = 1; k < half; k++) {
      aRe[k] = re[k] * scale;
      aIm[k] = im[k] * scale;
    }
    return { re: aRe, im: aIm, energyNorm };
  }

  /**
   * Stereo FDMA Ultrasonic Chirp Generator (`bus.registerTxGenerator('chirp', ...)`).
   * Caches unit-amplitude reference tables per sample rate for zero-allocation
   * audio-thread playback and disables cleanly when `sampleRate < 40000`.
   */
  class StereoChirpGenerator {
    constructor(opts) {
      const cfg = opts || {};
      this.gain = Number.isFinite(cfg.gain) ? clamp(cfg.gain, 0, 0.25) : DEFAULT_TX_GAIN;
      this.leftF0 = cfg.leftF0 || LEFT_F0_HZ;
      this.leftF1 = cfg.leftF1 || LEFT_F1_HZ;
      this.rightF0 = cfg.rightF0 || RIGHT_F0_HZ;
      this.rightF1 = cfg.rightF1 || RIGHT_F1_HZ;
      this._cachedRate = 0;
      this._period = BASE_CHIRP_PERIOD;
      this._refL = null;
      this._refR = null;
      this._fallbackOffset = 0;
    }

    _ensureTables(sampleRate) {
      const sr = Math.round(sampleRate || 0);
      if (sr === this._cachedRate && this._refL && this._refR) return;
      this._cachedRate = sr;
      this._period = computeChirpPeriod(sr);
      this._refL = buildReferenceChirp(this.leftF0, this.leftF1, sr, this._period);
      this._refR = buildReferenceChirp(this.rightF0, this.rightF1, sr, this._period);
    }

    getTables(sampleRate) {
      this._ensureTables(sampleRate);
      return {
        sampleRate: this._cachedRate,
        period: this._period,
        pulseLen: computePulseLen(this._period),
        refL: this._refL,
        refR: this._refR
      };
    }

    fillBuffers(leftOut, rightOut, sampleRate, sampleOffset) {
      const len = leftOut ? leftOut.length : rightOut ? rightOut.length : 0;
      if (!len) return;

      if (!Number.isFinite(sampleRate) || sampleRate < MIN_ULTRASONIC_SR) {
        if (leftOut) leftOut.fill(0);
        if (rightOut) rightOut.fill(0);
        return;
      }

      this._ensureTables(sampleRate);
      const N = this._period;
      const refL = this._refL;
      const refR = this._refR;
      const gain = this.gain;
      const baseOffset = Number.isFinite(sampleOffset)
        ? Math.floor(sampleOffset)
        : this._fallbackOffset;

      let idx = ((baseOffset % N) + N) % N;
      for (let i = 0; i < len; i++) {
        if (leftOut) leftOut[i] = refL[idx] * gain;
        if (rightOut) rightOut[i] = refR[idx] * gain;
        idx++;
        if (idx >= N) idx = 0;
      }
      this._fallbackOffset = (baseOffset + len) % N;
    }
  }

  /**
   * Real-Time Stereo FDMA Ultrasonic FMCW Chirp Sonar Engine.
   * Performs analytic FFT matched filtering, complex adaptive background clutter
   * subtraction, sub-centimeter range tracking, 24-bin waterfall binning, and
   * Push / Pull / Wave-Right / Wave-Left gesture classification.
   */
  class ChirpSonarEngine {
    constructor(opts) {
      const cfg = opts || {};
      this.txGain = Number.isFinite(cfg.txGain) ? cfg.txGain : DEFAULT_TX_GAIN;
      this.minRangeCm = Number.isFinite(cfg.minRangeCm) ? cfg.minRangeCm : MIN_RANGE_CM;
      this.maxRangeCm = Number.isFinite(cfg.maxRangeCm) ? cfg.maxRangeCm : MAX_RANGE_CM;
      this.numRangeBins = Number.isFinite(cfg.numRangeBins) ? cfg.numRangeBins : DEFAULT_NUM_BINS;
      this.autoAlignDirectPath = Boolean(cfg.autoAlignDirectPath);
      this.leftF0 = cfg.leftF0 || LEFT_F0_HZ;
      this.leftF1 = cfg.leftF1 || LEFT_F1_HZ;
      this.rightF0 = cfg.rightF0 || RIGHT_F0_HZ;
      this.rightF1 = cfg.rightF1 || RIGHT_F1_HZ;

      this._configureRate(Number.isFinite(cfg.sampleRate) ? cfg.sampleRate : 48000);
    }

    _configureRate(sampleRate) {
      const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
      this.sampleRate = sr;
      this.ultrasonicSupported = sr >= MIN_ULTRASONIC_SR;
      this.period = computeChirpPeriod(sr);
      this.pulseLen = computePulseLen(this.period);
      this.frameDurationSec = this.period / sr;

      this.refL = buildReferenceChirp(this.leftF0, this.leftF1, sr, this.period);
      this.refR = buildReferenceChirp(this.rightF0, this.rightF1, sr, this.period);
      this.specL = buildAnalyticRefSpectrum(this.refL);
      this.specR = buildAnalyticRefSpectrum(this.refR);

      // Range lag bounds: r = c * tau / (2 * fs) => tau = 2 * r * fs / c
      this.lagMin = Math.max(1, Math.floor((2 * this.minRangeCm * sr) / SPEED_OF_SOUND_CMS));
      this.lagMax = Math.min(
        this.period - 2,
        Math.ceil((2 * this.maxRangeCm * sr) / SPEED_OF_SOUND_CMS)
      );

      // Scratch FFT buffers (allocated once per sample rate)
      this._frameBuf = new Float64Array(this.period);
      this._frameFill = 0;
      this._xRe = new Float64Array(this.period);
      this._xIm = new Float64Array(this.period);
      this._hLRe = new Float64Array(this.period);
      this._hLIm = new Float64Array(this.period);
      this._hRRe = new Float64Array(this.period);
      this._hRIm = new Float64Array(this.period);
      this._magL = new Float64Array(this.lagMax + 2);
      this._magR = new Float64Array(this.lagMax + 2);
      this._combPow = new Float64Array(this.lagMax + 2);

      // Adaptive complex background clutter state
      this._bgLRe = new Float64Array(this.period);
      this._bgLIm = new Float64Array(this.period);
      this._bgRRe = new Float64Array(this.period);
      this._bgRIm = new Float64Array(this.period);

      // Precomputed 24-bin lag ranges
      this._binLagRanges = [];
      const spanCm = this.maxRangeCm - this.minRangeCm;
      for (let b = 0; b < this.numRangeBins; b++) {
        const cm0 = this.minRangeCm + (b * spanCm) / this.numRangeBins;
        const cm1 = this.minRangeCm + ((b + 1) * spanCm) / this.numRangeBins;
        const l0 = clamp(
          Math.floor((2 * cm0 * sr) / SPEED_OF_SOUND_CMS),
          this.lagMin,
          this.lagMax
        );
        const l1 = clamp(
          Math.ceil((2 * cm1 * sr) / SPEED_OF_SOUND_CMS),
          l0,
          this.lagMax
        );
        this._binLagRanges.push([l0, l1, 0.5 * (cm0 + cm1)]);
      }

      this.reset();
    }

    reset() {
      this._frameFill = 0;
      this.framesProcessed = 0;
      this._bgLRe.fill(0);
      this._bgLIm.fill(0);
      this._bgRRe.fill(0);
      this._bgRIm.fill(0);
      this.directLagL = 0;
      this.directLagR = 0;
      this.directPathLocked = false;

      this.noiseFloorL = 1e-4;
      this.noiseFloorR = 1e-4;
      this.displayPeakScale = 0.002;

      this.smoothedRangeCm = null;
      this.rangeCm = null;
      this.balance = 0;
      this.energyL = 0;
      this.energyR = 0;
      this.snr = 0;
      this.handPresent = false;
      this._stationaryFrames = 0;
      this._prevRawRangeCm = null;

      this._activeFrames = [];
      this._dropoutFrames = 0;
      this._cooldownFrames = 0;
      this._simTimeSec = 0;

      this.lastGesture = null;
      this.lastFrame = {
        frameIndex: 0,
        timeSec: 0,
        sampleRate: this.sampleRate,
        ultrasonicSupported: this.ultrasonicSupported,
        warmedUp: false,
        handPresent: false,
        rangeCm: null,
        rawRangeCm: null,
        balance: 0,
        energyL: 0,
        energyR: 0,
        snr: 0,
        directLagL: 0,
        directLagR: 0,
        rangeProfile: new Float32Array(this.numRangeBins),
        rangeProfileL: new Float32Array(this.numRangeBins),
        rangeProfileR: new Float32Array(this.numRangeBins),
        rangeProfileNorm: new Float32Array(this.numRangeBins),
        rangeTint: new Float32Array(this.numRangeBins),
        gestureEvent: null,
        lastGesture: null
      };
    }

    resetClutter() {
      this.framesProcessed = 0;
      this._bgLRe.fill(0);
      this._bgLIm.fill(0);
      this._bgRRe.fill(0);
      this._bgRIm.fill(0);
      this.directLagL = 0;
      this.directLagR = 0;
      this.directPathLocked = false;
      this.noiseFloorL = 1e-4;
      this.noiseFloorR = 1e-4;
      this._activeFrames = [];
      this._dropoutFrames = 0;
      this._cooldownFrames = 0;
      this._stationaryFrames = 0;
      this.smoothedRangeCm = null;
      this.rangeCm = null;
      this.handPresent = false;
    }

    setAutoAlignDirectPath(enabled) {
      const next = Boolean(enabled);
      if (this.autoAlignDirectPath !== next) {
        this.autoAlignDirectPath = next;
        this.resetClutter();
      }
    }

    getSnapshot() {
      return this.lastFrame;
    }

    /**
     * Ingests an arbitrary-length Float32Array/Array of mono mic samples.
     * Processes one full `period`-sample matched-filter frame whenever ready.
     * Returns the newest frame result if at least one frame completed, else `null`.
     */
    processBlock(samples, sampleRate, timeSec) {
      if (Number.isFinite(sampleRate) && Math.round(sampleRate) !== Math.round(this.sampleRate)) {
        this._configureRate(sampleRate);
      }
      if (!samples || !samples.length) return null;

      if (!this.ultrasonicSupported) {
        const t = Number.isFinite(timeSec) ? timeSec : this._simTimeSec;
        this.lastFrame = {
          ...this.lastFrame,
          timeSec: t,
          sampleRate: this.sampleRate,
          ultrasonicSupported: false,
          handPresent: false,
          rangeCm: null,
          gestureEvent: null
        };
        return this.lastFrame;
      }

      const N = this.period;
      const buf = this._frameBuf;
      let fill = this._frameFill;
      let latestResult = null;
      const baseTime = Number.isFinite(timeSec) ? timeSec : null;

      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        buf[fill++] = Number.isFinite(s) ? s : 0;
        if (fill >= N) {
          fill = 0;
          const frameTime =
            baseTime !== null
              ? baseTime + (i + 1 - samples.length) / this.sampleRate
              : this._simTimeSec + this.frameDurationSec;
          this._simTimeSec = frameTime;
          latestResult = this._processFrame(frameTime);
        }
      }
      this._frameFill = fill;
      return latestResult;
    }

    _correlateChannel(xRe, xIm, specRe, specIm, outRe, outIm) {
      const N = this.period;
      const half = N >> 1;
      outRe[0] = 0;
      outIm[0] = 0;
      for (let k = 1; k < half; k++) {
        // X[k] * conj(Ra[k])
        const xr = xRe[k];
        const xi = xIm[k];
        const rr = specRe[k];
        const ri = specIm[k];
        outRe[k] = xr * rr + xi * ri;
        outIm[k] = xi * rr - xr * ri;
      }
      for (let k = half; k < N; k++) {
        outRe[k] = 0;
        outIm[k] = 0;
      }
      ifftRadix2(outRe, outIm);
    }

    _estimateDirectLag(bgRe, bgIm) {
      const N = this.period;
      let maxMag = 0;
      let maxIdx = 0;
      const sampleMags = [];
      const stride = Math.max(1, N >> 6);
      for (let i = 0; i < N; i++) {
        const m = Math.hypot(bgRe[i], bgIm[i]);
        if (m > maxMag) {
          maxMag = m;
          maxIdx = i;
        }
        if (i % stride === 0) sampleMags.push(m);
      }
      const med = median(sampleMags);
      if (maxMag > Math.max(1e-5, med * 7.5)) {
        return { locked: true, lag: maxIdx };
      }
      return { locked: false, lag: 0 };
    }

    _processFrame(timeSec) {
      const N = this.period;
      const xRe = this._xRe;
      const xIm = this._xIm;
      const frameBuf = this._frameBuf;

      let frameMaxAbs = 0;
      for (let i = 0; i < N; i++) {
        const v = frameBuf[i];
        const av = v < 0 ? -v : v;
        if (av > frameMaxAbs) frameMaxAbs = av;
        xRe[i] = v;
        xIm[i] = 0;
      }

      // Skip totally silent frames during startup warmup (e.g. before hardware speaker
      // TX reaches the mic or after NaN-sanitized silence) so silence never biases H_bg.
      if (this.framesProcessed < WARMUP_FRAMES && frameMaxAbs < 1e-6) {
        this.lastFrame = {
          ...this.lastFrame,
          timeSec,
          sampleRate: this.sampleRate,
          ultrasonicSupported: true,
          warmedUp: false,
          handPresent: false,
          gestureEvent: null
        };
        return this.lastFrame;
      }

      fftRadix2(xRe, xIm);

      const hLRe = this._hLRe;
      const hLIm = this._hLIm;
      const hRRe = this._hRRe;
      const hRIm = this._hRIm;

      this._correlateChannel(xRe, xIm, this.specL.re, this.specL.im, hLRe, hLIm);
      this._correlateChannel(xRe, xIm, this.specR.re, this.specR.im, hRRe, hRIm);

      this.framesProcessed++;

      // Warmup phase: rapidly lock complex static background clutter H_bg
      if (this.framesProcessed <= WARMUP_FRAMES) {
        const alphaWarm = 1 / this.framesProcessed;
        const oneMinus = 1 - alphaWarm;
        for (let i = 0; i < N; i++) {
          this._bgLRe[i] = oneMinus * this._bgLRe[i] + alphaWarm * hLRe[i];
          this._bgLIm[i] = oneMinus * this._bgLIm[i] + alphaWarm * hLIm[i];
          this._bgRRe[i] = oneMinus * this._bgRRe[i] + alphaWarm * hRRe[i];
          this._bgRIm[i] = oneMinus * this._bgRIm[i] + alphaWarm * hRIm[i];
        }

        if (this.framesProcessed === WARMUP_FRAMES && this.autoAlignDirectPath) {
          const lockL = this._estimateDirectLag(this._bgLRe, this._bgLIm);
          const lockR = this._estimateDirectLag(this._bgRRe, this._bgRIm);
          if (lockL.locked && lockR.locked) {
            this.directLagL = lockL.lag;
            this.directLagR = lockR.lag;
            this.directPathLocked = true;
          } else if (lockL.locked) {
            this.directLagL = lockL.lag;
            this.directLagR = lockL.lag;
            this.directPathLocked = true;
          } else if (lockR.locked) {
            this.directLagL = lockR.lag;
            this.directLagR = lockR.lag;
            this.directPathLocked = true;
          }
        }

        // Seed noise floor from warmup residuals after frame 2
        if (this.framesProcessed >= 3) {
          let sumL = 0;
          let sumR = 0;
          let count = 0;
          for (let lag = this.lagMin; lag <= this.lagMax; lag++) {
            const idxL = (this.directLagL + lag) % N;
            const idxR = (this.directLagR + lag) % N;
            sumL += Math.hypot(hLRe[idxL] - this._bgLRe[idxL], hLIm[idxL] - this._bgLIm[idxL]);
            sumR += Math.hypot(hRRe[idxR] - this._bgRRe[idxR], hRIm[idxR] - this._bgRIm[idxR]);
            count++;
          }
          if (count > 0) {
            this.noiseFloorL = Math.max(1e-5, (sumL / count) * 1.15);
            this.noiseFloorR = Math.max(1e-5, (sumR / count) * 1.15);
          }
        }

        this.lastFrame = {
          frameIndex: this.framesProcessed,
          timeSec,
          sampleRate: this.sampleRate,
          ultrasonicSupported: true,
          warmedUp: this.framesProcessed >= WARMUP_FRAMES,
          handPresent: false,
          rangeCm: null,
          rawRangeCm: null,
          balance: 0,
          energyL: 0,
          energyR: 0,
          snr: 0,
          directLagL: this.directLagL,
          directLagR: this.directLagR,
          rangeProfile: new Float32Array(this.numRangeBins),
          rangeProfileL: new Float32Array(this.numRangeBins),
          rangeProfileR: new Float32Array(this.numRangeBins),
          rangeProfileNorm: new Float32Array(this.numRangeBins),
          rangeTint: new Float32Array(this.numRangeBins),
          gestureEvent: null,
          lastGesture: this.lastGesture
        };
        return this.lastFrame;
      }

      // 1. Complex clutter subtraction |ΔH_L[lag]|, |ΔH_R[lag]| across 4..55 cm
      const lagMin = this.lagMin;
      const lagMax = this.lagMax;
      const magL = this._magL;
      const magR = this._magR;
      const combPow = this._combPow;

      let peakMagL = 0;
      let peakMagR = 0;
      let peakLagL = lagMin;
      let peakLagR = lagMin;
      let peakComb = 0;
      let peakLagComb = lagMin;

      const sampleL = [];
      const sampleR = [];

      for (let lag = lagMin; lag <= lagMax; lag++) {
        const idxL = (this.directLagL + lag) % N;
        const idxR = (this.directLagR + lag) % N;
        const dLRe = hLRe[idxL] - this._bgLRe[idxL];
        const dLIm = hLIm[idxL] - this._bgLIm[idxL];
        const dRRe = hRRe[idxR] - this._bgRRe[idxR];
        const dRIm = hRIm[idxR] - this._bgRIm[idxR];

        const mL = Math.hypot(dLRe, dLIm);
        const mR = Math.hypot(dRRe, dRIm);
        magL[lag] = mL;
        magR[lag] = mR;

        if (mL > peakMagL) {
          peakMagL = mL;
          peakLagL = lag;
        }
        if (mR > peakMagR) {
          peakMagR = mR;
          peakLagR = lag;
        }

        const p = mL * mL + mR * mR;
        combPow[lag] = p;
        if (p > peakComb) {
          peakComb = p;
          peakLagComb = lag;
        }

        if ((lag - lagMin) % 3 === 0) {
          sampleL.push(mL);
          sampleR.push(mR);
        }
      }

      // Measure quiet far-zone noise floor (lagMax + 20 .. lagMax + 110) so a wide hand
      // echo inside 4..55 cm never inflates the noise baseline!
      const farSamplesL = [];
      const farSamplesR = [];
      const farStart = Math.min(N - 64, lagMax + 24);
      const farEnd = Math.min(N - 4, farStart + 96);
      for (let lag = farStart; lag < farEnd; lag += 4) {
        const idxL = (this.directLagL + lag) % N;
        const idxR = (this.directLagR + lag) % N;
        farSamplesL.push(Math.hypot(hLRe[idxL] - this._bgLRe[idxL], hLIm[idxL] - this._bgLIm[idxL]));
        farSamplesR.push(Math.hypot(hRRe[idxR] - this._bgRRe[idxR], hRIm[idxR] - this._bgRIm[idxR]));
      }

      const instFloorL = Math.max(1e-5, Math.min(median(sampleL), median(farSamplesL) || Infinity));
      const instFloorR = Math.max(1e-5, Math.min(median(sampleR), median(farSamplesR) || Infinity));

      // Evaluate dynamic SNR against current noise floor before adapting floor
      const snrL = peakMagL / Math.max(1e-5, this.noiseFloorL);
      const snrR = peakMagR / Math.max(1e-5, this.noiseFloorR);
      const peakSnr = Math.max(snrL, snrR);

      // Absolute minimum echo floor prevents zero-noise numerical dust from triggering
      const minAbsEcho = Math.max(8e-5, this.txGain * 0.0025);
      const peakAmp = Math.max(peakMagL, peakMagR);
      const isEchoDetected = peakSnr >= 3.4 && peakAmp >= minAbsEcho;

      // Adapt noise floor quickly when quiet, slowly when echo present
      const floorAlpha = isEchoDetected ? 0.02 : 0.14;
      this.noiseFloorL = Math.max(1e-5, (1 - floorAlpha) * this.noiseFloorL + floorAlpha * instFloorL);
      this.noiseFloorR = Math.max(1e-5, (1 - floorAlpha) * this.noiseFloorR + floorAlpha * instFloorR);

      // 2. High-precision range estimation via 3-point parabolic refinement + local centroid
      let rawRangeCm = null;
      if (isEchoDetected) {
        let refinedLag = peakLagComb;
        if (peakLagComb > lagMin && peakLagComb < lagMax) {
          const y0 = Math.sqrt(combPow[peakLagComb - 1]);
          const y1 = Math.sqrt(combPow[peakLagComb]);
          const y2 = Math.sqrt(combPow[peakLagComb + 1]);
          const denom = y0 - 2 * y1 + y2;
          if (Math.abs(denom) > 1e-12) {
            const delta = clamp(0.5 * (y0 - y2) / denom, -0.5, 0.5);
            refinedLag = peakLagComb + delta;
          }
        }
        // Blend lightly with local ±6-sample power centroid for multipath stability
        let wSum = 0;
        let lwSum = 0;
        const cLo = Math.max(lagMin, peakLagComb - 6);
        const cHi = Math.min(lagMax, peakLagComb + 6);
        for (let l = cLo; l <= cHi; l++) {
          const w = combPow[l];
          wSum += w;
          lwSum += l * w;
        }
        const centroidLag = wSum > 0 ? lwSum / wSum : refinedLag;
        const finalLag = 0.65 * refinedLag + 0.35 * centroidLag;
        rawRangeCm = clamp((finalLag * SPEED_OF_SOUND_CMS) / (2 * this.sampleRate), DISPLAY_MIN_RANGE_CM, this.maxRangeCm);
      }

      // Stationary-object detector: if an echo sits unmoving for > 1.8 s, let clutter
      // canceller absorb it cleanly (e.g. placing a mug or book on the desk)
      if (isEchoDetected && rawRangeCm !== null && this._prevRawRangeCm !== null) {
        if (Math.abs(rawRangeCm - this._prevRawRangeCm) < 0.7) {
          this._stationaryFrames++;
        } else {
          this._stationaryFrames = 0;
        }
      } else {
        this._stationaryFrames = 0;
      }
      this._prevRawRangeCm = rawRangeCm;

      // Motion-gated adaptive background update: freeze H_bg during active hand motion
      // so high-SNR gestures never burn a "ghost echo" into static clutter; resume
      // adaptation immediately when quiet or if a new object stays stationary > ~0.65 s.
      let bgAlpha = 0.08;
      if (isEchoDetected) {
        bgAlpha = this._stationaryFrames > 30 ? 0.08 : 0;
      }
      if (bgAlpha > 0) {
        const bgOneMinus = 1 - bgAlpha;
        for (let i = 0; i < N; i++) {
          this._bgLRe[i] = bgOneMinus * this._bgLRe[i] + bgAlpha * hLRe[i];
          this._bgLIm[i] = bgOneMinus * this._bgLIm[i] + bgAlpha * hLIm[i];
          this._bgRRe[i] = bgOneMinus * this._bgRRe[i] + bgAlpha * hRRe[i];
          this._bgRIm[i] = bgOneMinus * this._bgRIm[i] + bgAlpha * hRIm[i];
        }
      }

      // 3. Build 24-bin Range Profile (`4..55 cm`) + per-bin stereo tint
      const profileL = new Float32Array(this.numRangeBins);
      const profileR = new Float32Array(this.numRangeBins);
      const profile = new Float32Array(this.numRangeBins);
      const profileNorm = new Float32Array(this.numRangeBins);
      const rangeTint = new Float32Array(this.numRangeBins);

      let maxBinMag = 0;
      for (let b = 0; b < this.numRangeBins; b++) {
        const [l0, l1] = this._binLagRanges[b];
        let bMaxL = 0;
        let bMaxR = 0;
        for (let l = l0; l <= l1; l++) {
          if (magL[l] > bMaxL) bMaxL = magL[l];
          if (magR[l] > bMaxR) bMaxR = magR[l];
        }
        // Subtract quiet noise floor for crisp waterfall contrast
        const cleanL = Math.max(0, bMaxL - this.noiseFloorL * 1.4);
        const cleanR = Math.max(0, bMaxR - this.noiseFloorR * 1.4);
        const comb = Math.hypot(cleanL, cleanR);
        profileL[b] = cleanL;
        profileR[b] = cleanR;
        profile[b] = comb;
        if (comb > maxBinMag) maxBinMag = comb;
        rangeTint[b] = comb > 1e-7 ? (cleanR - cleanL) / (cleanR + cleanL + 1e-9) : 0;
      }

      // AGC scale for waterfall rendering (fast attack, smooth decay)
      const targetScale = Math.max(minAbsEcho * 2.5, maxBinMag);
      if (targetScale > this.displayPeakScale) {
        this.displayPeakScale = 0.55 * this.displayPeakScale + 0.45 * targetScale;
      } else {
        this.displayPeakScale = Math.max(
          minAbsEcho * 2.5,
          0.96 * this.displayPeakScale + 0.04 * targetScale
        );
      }
      const invDisplay = 1 / Math.max(1e-6, this.displayPeakScale);
      for (let b = 0; b < this.numRangeBins; b++) {
        // Gentle gamma curve (0.72) keeps faint approaching echoes legible
        const linear = clamp(profile[b] * invDisplay, 0, 1);
        profileNorm[b] = Math.pow(linear, 0.72);
      }

      // 4. Stereo energy & balance (`-1` Left speaker .. `+1` Right speaker)
      const excessL = Math.max(0, peakMagL - this.noiseFloorL * 1.5);
      const excessR = Math.max(0, peakMagR - this.noiseFloorR * 1.5);
      const totalExcess = excessL + excessR;
      const instBalance = totalExcess > 1e-7 ? (excessR - excessL) / totalExcess : 0;

      if (isEchoDetected) {
        this.smoothedRangeCm =
          this.smoothedRangeCm === null
            ? rawRangeCm
            : 0.58 * this.smoothedRangeCm + 0.42 * rawRangeCm;
        this.balance = 0.55 * this.balance + 0.45 * instBalance;
      } else {
        this.balance *= 0.85;
      }

      this.energyL = excessL;
      this.energyR = excessR;
      this.snr = peakSnr;
      this.handPresent = isEchoDetected;
      this.rangeCm = isEchoDetected ? this.smoothedRangeCm : this.rangeCm;

      // 5. Gesture Segmentation & Classification (`push`, `pull`, `wave-right`, `wave-left`)
      let gestureEvent = null;
      if (this._cooldownFrames > 0) {
        this._cooldownFrames--;
      }

      if (this._cooldownFrames === 0) {
        if (isEchoDetected && rawRangeCm !== null) {
          this._dropoutFrames = 0;
          this._activeFrames.push({
            t: timeSec,
            rangeCm: rawRangeCm,
            energyL: excessL,
            energyR: excessR,
            bal: instBalance,
            snr: peakSnr,
            peakLagL,
            peakLagR
          });

          // Cap rolling buffer length (~1.3 s)
          if (this._activeFrames.length > 62) {
            this._activeFrames.shift();
          }

          // Check for clean completion if gesture has been active long enough (>= 1.05 s)
          if (this._activeFrames.length >= 50) {
            gestureEvent = this._classifyWindow(this._activeFrames, timeSec);
            if (gestureEvent) {
              this._activeFrames = [];
              this._cooldownFrames = 12;
            }
          }
        } else if (this._activeFrames.length > 0) {
          this._dropoutFrames++;
          if (this._dropoutFrames >= 3) {
            if (this._activeFrames.length >= 6) {
              gestureEvent = this._classifyWindow(this._activeFrames, timeSec);
              if (gestureEvent) {
                this._cooldownFrames = 12;
              }
            }
            this._activeFrames = [];
            this._dropoutFrames = 0;
            this.smoothedRangeCm = null;
          }
        }
      } else if (!isEchoDetected) {
        this._activeFrames = [];
        this._dropoutFrames = 0;
        this.smoothedRangeCm = null;
      }

      if (gestureEvent) {
        this.lastGesture = gestureEvent;
      }

      this.lastFrame = {
        frameIndex: this.framesProcessed,
        timeSec,
        sampleRate: this.sampleRate,
        ultrasonicSupported: true,
        warmedUp: true,
        handPresent: isEchoDetected,
        rangeCm: isEchoDetected ? this.smoothedRangeCm : null,
        rawRangeCm,
        balance: this.balance,
        energyL: excessL,
        energyR: excessR,
        snr: peakSnr,
        directLagL: this.directLagL,
        directLagR: this.directLagR,
        rangeProfile: profile,
        rangeProfileL: profileL,
        rangeProfileR: profileR,
        rangeProfileNorm: profileNorm,
        rangeTint,
        gestureEvent,
        lastGesture: this.lastGesture
      };
      return this.lastFrame;
    }

    _classifyWindow(frames, nowSec) {
      const n = frames.length;
      if (n < 6) return null;

      const t0 = frames[0].t;
      const tEnd = frames[n - 1].t;
      const duration = Math.max(this.frameDurationSec, tEnd - t0);
      if (duration < 0.1) return null;

      // --- A. Lateral Stereo Wave Analysis (L -> R vs R -> L) ---
      let maxEL = 0;
      let maxER = 0;
      let sumEL = 0;
      let sumER = 0;
      let sumTEL = 0;
      let sumTER = 0;
      let minBal = 1;
      let maxBal = -1;

      for (let i = 0; i < n; i++) {
        const f = frames[i];
        const dt = f.t - t0;
        const wL = f.energyL * f.energyL;
        const wR = f.energyR * f.energyR;
        if (f.energyL > maxEL) maxEL = f.energyL;
        if (f.energyR > maxER) maxER = f.energyR;
        sumEL += wL;
        sumER += wR;
        sumTEL += dt * wL;
        sumTER += dt * wR;
        if (f.bal < minBal) minBal = f.bal;
        if (f.bal > maxBal) maxBal = f.bal;
      }

      let waveStrength = 0;
      let waveDir = 0; // +1 = wave-right (L->R), -1 = wave-left (R->L)
      let dtLR = 0;
      let dBal = 0;

      const minChannelRatio =
        maxEL > 0 && maxER > 0 ? Math.min(maxEL, maxER) / Math.max(maxEL, maxER) : 0;

      if (sumEL > 0 && sumER > 0 && minChannelRatio >= 0.22) {
        const tCentroidL = sumTEL / sumEL;
        const tCentroidR = sumTER / sumER;
        dtLR = tCentroidR - tCentroidL; // > 0 => Left peaked before Right (L -> R)

        // Weighted balance of opening third vs closing third
        const sliceLen = Math.max(2, Math.floor(n * 0.35));
        let bStartNum = 0;
        let bStartDen = 0;
        for (let i = 0; i < sliceLen; i++) {
          const w = frames[i].energyL + frames[i].energyR + 1e-9;
          bStartNum += frames[i].bal * w;
          bStartDen += w;
        }
        let bEndNum = 0;
        let bEndDen = 0;
        for (let i = n - sliceLen; i < n; i++) {
          const w = frames[i].energyL + frames[i].energyR + 1e-9;
          bEndNum += frames[i].bal * w;
          bEndDen += w;
        }
        const balStart = bStartDen > 0 ? bStartNum / bStartDen : 0;
        const balEnd = bEndDen > 0 ? bEndNum / bEndDen : 0;
        dBal = balEnd - balStart;

        const balSwing = maxBal - minBal;
        const signsAgree = dtLR * dBal > 0;
        if (signsAgree && Math.abs(dtLR) >= 0.032 && Math.abs(dBal) >= 0.28 && balSwing >= 0.35) {
          waveStrength =
            Math.min(Math.abs(dtLR) / 0.065, 2.2) * 0.55 +
            Math.min(Math.abs(dBal) / 0.55, 2.2) * 0.45;
          waveDir = dtLR > 0 ? 1 : -1;
        }
      }

      // --- B. Radial Push / Pull Analysis (dr/dt & Range Displacement) ---
      let wSum = 0;
      let tMean = 0;
      let rMean = 0;
      for (let i = 0; i < n; i++) {
        const f = frames[i];
        const w = clamp(f.snr, 1, 20);
        wSum += w;
        tMean += w * (f.t - t0);
        rMean += w * f.rangeCm;
      }
      tMean /= wSum;
      rMean /= wSum;

      let sTT = 0;
      let sTR = 0;
      let sRR = 0;
      for (let i = 0; i < n; i++) {
        const f = frames[i];
        const w = clamp(f.snr, 1, 20);
        const dt = f.t - t0 - tMean;
        const dr = f.rangeCm - rMean;
        sTT += w * dt * dt;
        sTR += w * dt * dr;
        sRR += w * dr * dr;
      }

      const slopeCms = sTT > 1e-6 ? sTR / sTT : 0;
      const netDeltaCm = slopeCms * duration;
      const r2 = sTT > 1e-6 && sRR > 1e-6 ? clamp((sTR * sTR) / (sTT * sRR), 0, 1) : 0;

      // Also verify opening vs closing median range agrees in sign
      const edgeN = Math.max(2, Math.floor(n * 0.28));
      const startMed = median(frames.slice(0, edgeN).map((f) => f.rangeCm));
      const endMed = median(frames.slice(n - edgeN).map((f) => f.rangeCm));
      const rawDeltaCm = endMed - startMed;

      let radialStrength = 0;
      let radialDir = 0; // -1 = push (range decreasing), +1 = pull (range increasing)
      if (
        netDeltaCm * rawDeltaCm > 0 &&
        Math.abs(netDeltaCm) >= 9.0 &&
        Math.abs(rawDeltaCm) >= 7.5 &&
        Math.abs(slopeCms) >= 10 &&
        r2 >= 0.45
      ) {
        radialStrength = (Math.abs(netDeltaCm) / 12.0) * (0.4 + 0.6 * r2);
        radialDir = netDeltaCm < 0 ? -1 : 1;
      }

      // --- C. Arbitration ---
      if (waveStrength >= 0.65 && waveStrength >= radialStrength * 0.85) {
        const type = waveDir > 0 ? 'wave-right' : 'wave-left';
        return {
          type,
          label: type === 'wave-right' ? 'WAVE →' : 'WAVE ←',
          confidence: clamp(Math.round(55 + Math.min(waveStrength, 2.0) * 21), 55, 99),
          deltaCm: Math.round(netDeltaCm * 10) / 10,
          velocityCms: Math.round(slopeCms * 10) / 10,
          dtLRMs: Math.round(dtLR * 1000),
          balanceShift: Math.round(dBal * 100) / 100,
          timestampSec: nowSec
        };
      }

      if (radialStrength >= 0.75) {
        const type = radialDir < 0 ? 'push' : 'pull';
        return {
          type,
          label: type === 'push' ? 'PUSH IN ↓' : 'PULL OUT ↑',
          confidence: clamp(Math.round(55 + Math.min(radialStrength, 2.2) * 20), 55, 99),
          deltaCm: Math.round(netDeltaCm * 10) / 10,
          velocityCms: Math.round(slopeCms * 10) / 10,
          dtLRMs: Math.round(dtLR * 1000),
          balanceShift: Math.round(dBal * 100) / 100,
          timestampSec: nowSec
        };
      }

      return null;
    }
  }

  /**
   * Deterministic PRNG (Mulberry32) for reproducible thermal noise in tests & Sim.
   */
  function createPrng(seed) {
    let a = (seed >>> 0) || 0x18205a5a;
    return function next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function sampleFractionalPeriodic(table, pos) {
    const N = table.length;
    const wrapped = ((pos % N) + N) % N;
    const i0 = Math.floor(wrapped);
    const i1 = (i0 + 1) % N;
    const frac = wrapped - i0;
    return table[i0] * (1 - frac) + table[i1] * frac;
  }

  /**
   * Synthesizes physically realistic 48 kHz (or configurable) round-trip delayed
   * stereo ultrasonic chirp echoes with direct speaker-to-mic coupling, static
   * room clutter reflectors, and thermal noise.
   *
   * Supported `kind`:
   *   - `'push'`: Hand approaching `42 cm -> 10 cm`
   *   - `'pull'`: Hand receding `10 cm -> 42 cm`
   *   - `'wave-right'`: Hand sweeping `L -> R` across `30 cm` stereo keyboard baseline
   *   - `'wave-left'`: Hand sweeping `R -> L` across `30 cm` stereo keyboard baseline
   *   - `'clutter-only'`: Strong static reflectors + direct path, zero moving hand
   *   - `'static-target'`: Constant target at `opts.targetRangeCm` (for range accuracy test)
   */
  function synthesizeGestureSignal(kind, opts) {
    const cfg = opts || {};
    const sampleRate = cfg.sampleRate || 48000;
    const txGain = Number.isFinite(cfg.txGain) ? cfg.txGain : DEFAULT_TX_GAIN;
    const warmupFrames = Number.isFinite(cfg.warmupFrames) ? cfg.warmupFrames : 10;
    const gestureFrames = Number.isFinite(cfg.gestureFrames) ? cfg.gestureFrames : 24;
    const tailFrames = Number.isFinite(cfg.tailFrames) ? cfg.tailFrames : 8;
    const directLag = Number.isFinite(cfg.directLag) ? cfg.directLag : 0;
    const directGainL = Number.isFinite(cfg.directGainL) ? cfg.directGainL : 0.35;
    const directGainR = Number.isFinite(cfg.directGainR) ? cfg.directGainR : 0.28;
    const noiseStd = Number.isFinite(cfg.noiseStd) ? cfg.noiseStd : 0.00025;
    const clutterReflectors =
      cfg.clutterReflectors !== undefined
        ? cfg.clutterReflectors
        : [
            { rangeCm: 26, gainL: 0.14, gainR: 0.11 },
            { rangeCm: 46, gainL: 0.09, gainR: 0.12 }
          ];

    const gen = new StereoChirpGenerator({ gain: txGain });
    const { period, refL, refR } = gen.getTables(sampleRate);
    const totalFrames = warmupFrames + gestureFrames + tailFrames;
    const totalSamples = totalFrames * period;
    const out = new Float32Array(totalSamples);
    const rand = createPrng(cfg.seed || 0x504e4152);

    const startSample = warmupFrames * period;
    const endSample = (warmupFrames + gestureFrames) * period;
    const gestureLen = Math.max(1, endSample - startSample);
    const cmToLag = (2 * sampleRate) / SPEED_OF_SOUND_CMS;

    // Precompute static clutter lags
    const clutter = clutterReflectors.map((c) => ({
      lag: directLag + c.rangeCm * cmToLag,
      gainL: (c.gainL || 0) * txGain,
      gainR: (c.gainR || 0) * txGain
    }));

    const echoBaseGain = (Number.isFinite(cfg.echoGain) ? cfg.echoGain : 0.16) * txGain;

    for (let n = 0; n < totalSamples; n++) {
      // 1. Direct speaker-to-mic acoustic leakage
      let s =
        directGainL * txGain * sampleFractionalPeriodic(refL, n - directLag) +
        directGainR * txGain * sampleFractionalPeriodic(refR, n - directLag);

      // 2. Static room clutter echoes
      for (let c = 0; c < clutter.length; c++) {
        const cl = clutter[c];
        s +=
          cl.gainL * sampleFractionalPeriodic(refL, n - cl.lag) +
          cl.gainR * sampleFractionalPeriodic(refR, n - cl.lag);
      }

      // 3. Moving hand echo during active gesture interval
      if (n >= startSample && n < endSample && kind !== 'clutter-only') {
        const u = (n - startSample) / gestureLen; // 0..1
        // Smooth S-curve easing (hand accelerates from rest & decelerates)
        const ease = 0.5 - 0.5 * Math.cos(Math.PI * u);
        // Smooth entry/exit hand-presence envelope
        const presenceEnv = Math.sin(Math.PI * u);
        const env = Math.pow(clamp(presenceEnv, 0, 1), 0.35);

        if (kind === 'push' || kind === 'pull') {
          const rStart = kind === 'push' ? cfg.startCm || 42 : cfg.startCm || 10;
          const rEnd = kind === 'push' ? cfg.endCm || 10 : cfg.endCm || 42;
          const rangeCm = rStart + (rEnd - rStart) * ease;
          const lag = directLag + rangeCm * cmToLag;
          // Near-field acoustic attenuation (stronger closer to laptop)
          const distScale = clamp(Math.pow(22 / Math.max(8, rangeCm), 0.75), 0.55, 1.85);
          const amp = echoBaseGain * env * distScale;
          s +=
            amp * sampleFractionalPeriodic(refL, n - lag) +
            amp * 0.92 * sampleFractionalPeriodic(refR, n - lag);
        } else if (kind === 'wave-right' || kind === 'wave-left') {
          // 30 cm MacBook speaker stereo baseline: Left at x=-15 cm, Right at x=+15 cm
          const xStart = kind === 'wave-right' ? -19 : 19;
          const xEnd = kind === 'wave-right' ? 19 : -19;
          const xCm = xStart + (xEnd - xStart) * ease;
          const zCm = Number.isFinite(cfg.waveHeightCm) ? cfg.waveHeightCm : 18;

          // True 3D slant range from Left speaker (-15, 0) & Right speaker (+15, 0)
          const rLCm = Math.hypot(xCm - -15, zCm);
          const rRCm = Math.hypot(xCm - 15, zCm);
          const lagL = directLag + rLCm * cmToLag;
          const lagR = directLag + rRCm * cmToLag;

          // Directional tweeter/hand beam patterns centered over L (-13 cm) and R (+13 cm)
          const beamL = Math.exp(-Math.pow((xCm + 13) / 11.5, 2));
          const beamR = Math.exp(-Math.pow((xCm - 13) / 11.5, 2));
          const ampL = echoBaseGain * 1.15 * env * beamL;
          const ampR = echoBaseGain * 1.15 * env * beamR;
          s +=
            ampL * sampleFractionalPeriodic(refL, n - lagL) +
            ampR * sampleFractionalPeriodic(refR, n - lagR);
        } else if (kind === 'static-target') {
          const targetRangeCm = Number.isFinite(cfg.targetRangeCm) ? cfg.targetRangeCm : 24;
          const lag = directLag + targetRangeCm * cmToLag;
          const amp = echoBaseGain * 1.1;
          s +=
            amp * sampleFractionalPeriodic(refL, n - lag) +
            amp * sampleFractionalPeriodic(refR, n - lag);
        }
      }

      // 4. White thermal noise (Box-Muller light approximation via sum of 2 uniforms)
      if (noiseStd > 0) {
        s += (rand() + rand() - 1) * noiseStd * 2.45;
      }
      out[n] = s;
    }

    return {
      samples: out,
      sampleRate,
      period,
      totalFrames,
      warmupFrames,
      gestureFrames,
      tailFrames
    };
  }

  // ===========================================================================
  // UI Helper & Secondary Grid Cell 04 Mount
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

  function mountChirpSonarCell(cellEl, bus) {
    if (!cellEl) return null;

    cellEl.classList.add('cs-cell');
    while (cellEl.firstChild) {
      cellEl.removeChild(cellEl.firstChild);
    }

    const txGen = new StereoChirpGenerator({ gain: DEFAULT_TX_GAIN });
    const engine = new ChirpSonarEngine({
      sampleRate: 48000,
      txGain: DEFAULT_TX_GAIN,
      autoAlignDirectPath: true,
      numRangeBins: DEFAULT_NUM_BINS
    });

    // Register stereo TX chirp generator on shared bus
    if (bus && typeof bus.registerTxGenerator === 'function') {
      bus.registerTxGenerator('chirp', (leftOut, rightOut, sampleRate, sampleOffset) => {
        txGen.fillBuffers(leftOut, rightOut, sampleRate, sampleOffset);
      });
    }

    const WATERFALL_COLS = 96;
    const waterfallHistory = [];
    for (let i = 0; i < WATERFALL_COLS; i++) {
      waterfallHistory.push({
        bins: new Float32Array(DEFAULT_NUM_BINS),
        tints: new Float32Array(DEFAULT_NUM_BINS),
        rangeCm: null
      });
    }
    let wfWriteIdx = 0;
    let rafId = 0;
    let canvasDirty = true;

    let busState = {
      state: 'idle',
      sampleRate: 48000,
      txMode: 'off',
      micLabel: '',
      error: null
    };

    let simTimer = null;
    let simActive = false;
    let simKind = null;
    let nextWaveDir = 'wave-right';
    let gestureHoldUntil = 0;
    let activeGestureState = null;

    // --- DOM Construction (Zero `innerHTML`) ---
    const srLive = h('div', {
      className: 'cs-sr-only',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true'
    });

    const sonarDot = h('span', { className: 'cs-dot', 'aria-hidden': 'true' });
    const sonarLabel = h('span', { textContent: 'SONAR' });
    const sonarBtn = h(
      'button',
      {
        type: 'button',
        className: 'cs-btn cs-btn--sonar',
        dataset: { active: 'false' },
        'aria-pressed': 'false',
        title: 'Toggle 18.0–20.5 kHz Stereo FMCW Ultrasonic Chirp Sonar',
        onClick: () => handleSonarToggle()
      },
      [sonarDot, sonarLabel]
    );

    const statusPill = h('span', {
      className: 'cs-status-pill',
      textContent: '18–20.5k FMCW'
    });

    const gestureText = h('span', {
      className: 'cs-gesture-val',
      dataset: { kind: 'idle' },
      textContent: 'STANDBY'
    });
    const gestureMeta = h('span', {
      className: 'cs-gesture-meta',
      textContent: 'Push · Pull · Wave'
    });

    const rangeVal = h('span', {
      className: 'cs-range-num',
      textContent: '--.-'
    });
    const rangeReadout = h('div', { className: 'cs-range-val' }, [
      rangeVal,
      h('span', { className: 'cs-range-unit', textContent: ' cm' })
    ]);

    const balFillL = h('div', { className: 'cs-bal-fill cs-bal-fill--l' });
    const balFillR = h('div', { className: 'cs-bal-fill cs-bal-fill--r' });
    const balNeedle = h('div', { className: 'cs-bal-needle' });
    const balRow = h('div', { className: 'cs-bal-row', title: 'Left (18–19.15k) vs Right (19.35–20.5k) echo balance' }, [
      h('span', { className: 'cs-bal-tag', textContent: 'L' }),
      h('div', { className: 'cs-bal-track', 'aria-hidden': 'true' }, [
        balFillL,
        balFillR,
        h('div', { className: 'cs-bal-center' }),
        balNeedle
      ]),
      h('span', { className: 'cs-bal-tag', textContent: 'R' })
    ]);

    const canvas = h('canvas', {
      className: 'cs-waterfall-canvas',
      'aria-label': 'Live 24-bin ultrasonic range-time radar waterfall (4 to 55 cm)'
    });
    const ctx = canvas.getContext('2d');

    const simPushBtn = h(
      'button',
      {
        type: 'button',
        className: 'cs-mini-btn',
        title: 'Synthesize 48 kHz approaching hand echo (42 cm to 10 cm)',
        onClick: () => runSim('push')
      },
      ['Sim Push']
    );
    const simPullBtn = h(
      'button',
      {
        type: 'button',
        className: 'cs-mini-btn',
        title: 'Synthesize 48 kHz receding hand echo (10 cm to 42 cm)',
        onClick: () => runSim('pull')
      },
      ['Sim Pull']
    );
    const simWaveBtn = h(
      'button',
      {
        type: 'button',
        className: 'cs-mini-btn',
        title: 'Synthesize 48 kHz stereo hand wave (alternates L->R and R->L)',
        onClick: () => {
          const dir = nextWaveDir;
          nextWaveDir = dir === 'wave-right' ? 'wave-left' : 'wave-right';
          runSim(dir);
        }
      },
      ['Sim Wave']
    );
    const zeroBtn = h(
      'button',
      {
        type: 'button',
        className: 'cs-mini-btn cs-mini-btn--zero',
        title: 'Re-zero static background room clutter',
        onClick: () => {
          stopSim();
          engine.resetClutter();
          clearWaterfall();
          updateStatusPill();
          scheduleDraw();
        }
      },
      ['Zero']
    );

    const stage = h('div', { className: 'cs-stage' }, [
      srLive,
      h('div', { className: 'cs-bezel' }, [
        h('div', { className: 'cs-bezel-left' }, [
          h('span', { className: 'cs-kicker', textContent: '04' }),
          sonarBtn
        ]),
        statusPill
      ]),
      h('div', { className: 'cs-hero' }, [
        h('div', { className: 'cs-card cs-card--gesture' }, [
          h('div', { className: 'cs-card-head' }, [
            h('span', { className: 'cs-label', textContent: 'GESTURE' }),
            gestureMeta
          ]),
          gestureText
        ]),
        h('div', { className: 'cs-card cs-card--range' }, [
          h('div', { className: 'cs-card-head' }, [
            h('span', { className: 'cs-label', textContent: 'RANGE' }),
            rangeReadout
          ]),
          balRow
        ])
      ]),
      h('div', { className: 'cs-radar-box' }, [
        canvas,
        h('div', { className: 'cs-radar-ticks', 'aria-hidden': 'true' }, [
          h('span', { textContent: '55cm' }),
          h('span', { textContent: '4cm' })
        ]),
        h('div', { className: 'cs-sim-bar' }, [
          h('div', { className: 'cs-sim-group' }, [simPushBtn, simPullBtn, simWaveBtn]),
          zeroBtn
        ])
      ])
    ]);

    cellEl.appendChild(stage);

    function announce(text) {
      srLive.textContent = '';
      setTimeout(() => {
        srLive.textContent = text;
      }, 15);
    }

    function clearWaterfall() {
      for (let i = 0; i < WATERFALL_COLS; i++) {
        waterfallHistory[i].bins.fill(0);
        waterfallHistory[i].tints.fill(0);
        waterfallHistory[i].rangeCm = null;
      }
      wfWriteIdx = 0;
      canvasDirty = true;
    }

    function isSonarLive() {
      return busState.state === 'listening' && busState.txMode === 'chirp';
    }

    function updateStatusPill() {
      const live = isSonarLive();
      sonarBtn.dataset.active = live ? 'true' : 'false';
      sonarBtn.setAttribute('aria-pressed', live ? 'true' : 'false');

      if (simActive) {
        const tag =
          simKind === 'push'
            ? 'SIM · PUSH'
            : simKind === 'pull'
              ? 'SIM · PULL'
              : simKind === 'wave-right'
                ? 'SIM · WAVE →'
                : 'SIM · WAVE ←';
        statusPill.textContent = tag;
        statusPill.dataset.warn = 'false';
        return;
      }
      if (busState.state === 'requesting') {
        statusPill.textContent = 'ARMING…';
        statusPill.dataset.warn = 'false';
        return;
      }
      if (busState.state === 'error') {
        statusPill.textContent = busState.error ? String(busState.error).slice(0, 22) : 'MIC ERROR';
        statusPill.dataset.warn = 'true';
        return;
      }
      if (live) {
        const sr = busState.sampleRate || 48000;
        if (sr < MIN_ULTRASONIC_SR) {
          statusPill.textContent = `LOW SR (${Math.round(sr / 1000)}k)`;
          statusPill.dataset.warn = 'true';
        } else {
          const khz = (sr / 1000).toFixed(sr % 1000 === 0 ? 0 : 1);
          statusPill.textContent = `18–20.5k · ${khz}k`;
          statusPill.dataset.warn = 'false';
        }
        return;
      }
      statusPill.textContent = '18–20.5k FMCW';
      statusPill.dataset.warn = 'false';
    }

    async function handleSonarToggle() {
      stopSim();
      if (!bus) return;
      if (isSonarLive()) {
        if (typeof bus.setTxMode === 'function') {
          bus.setTxMode('off');
        }
      } else {
        engine.setAutoAlignDirectPath(true);
        engine.resetClutter();
        if (busState.state === 'listening' && typeof bus.setTxMode === 'function') {
          bus.setTxMode('chirp');
        } else if (typeof bus.requestArm === 'function') {
          try {
            await bus.requestArm('chirp');
          } catch (_) {
            // Bus state listener surfaces any permission/hardware error cleanly
          }
        }
      }
      updateStatusPill();
    }

    function applyFrameToUi(frame) {
      if (!frame) return;

      // Record waterfall column
      const slot = waterfallHistory[wfWriteIdx];
      slot.bins.set(frame.rangeProfileNorm);
      slot.tints.set(frame.rangeTint);
      slot.rangeCm = frame.handPresent ? frame.rangeCm : null;
      wfWriteIdx = (wfWriteIdx + 1) % WATERFALL_COLS;
      canvasDirty = true;

      // Range readout
      if (frame.handPresent && Number.isFinite(frame.rangeCm)) {
        rangeVal.textContent = frame.rangeCm.toFixed(1);
      } else {
        rangeVal.textContent = '--.-';
      }

      // Stereo L/R balance bar (`balance` in -1..+1)
      const bal = clamp(frame.balance || 0, -1, 1);
      const pct = Math.abs(bal) * 50;
      if (bal < 0) {
        balFillL.style.width = `${pct.toFixed(1)}%`;
        balFillR.style.width = '0%';
      } else {
        balFillL.style.width = '0%';
        balFillR.style.width = `${pct.toFixed(1)}%`;
      }
      balNeedle.style.left = `${(50 + bal * 46).toFixed(1)}%`;

      // Gesture display with 2.2 s crisp hold after commit
      const now = Date.now();
      if (frame.gestureEvent) {
        activeGestureState = frame.gestureEvent;
        gestureHoldUntil = now + 2200;
        const g = frame.gestureEvent;
        gestureText.textContent = g.label;
        gestureText.dataset.kind = g.type;
        if (g.type === 'push' || g.type === 'pull') {
          const sign = g.deltaCm > 0 ? '+' : '';
          gestureMeta.textContent = `${sign}${g.deltaCm.toFixed(0)}cm · ${g.confidence}%`;
        } else {
          gestureMeta.textContent = `Δt ${g.dtLRMs >= 0 ? '+' : ''}${g.dtLRMs}ms · ${g.confidence}%`;
        }
        announce(`Chirp sonar detected ${g.label}`);
      } else if (now > gestureHoldUntil) {
        if (frame.handPresent && Number.isFinite(frame.rangeCm)) {
          gestureText.textContent = 'TRACKING';
          gestureText.dataset.kind = 'tracking';
          gestureMeta.textContent = `SNR ${frame.snr.toFixed(1)}x`;
        } else if (isSonarLive() || simActive) {
          gestureText.textContent = frame.warmedUp ? 'LISTENING' : 'CALIBRATING';
          gestureText.dataset.kind = 'idle';
          gestureMeta.textContent = frame.warmedUp ? '18–20.5k Active' : 'Locking clutter';
        } else {
          gestureText.textContent = activeGestureState ? activeGestureState.label : 'STANDBY';
          gestureText.dataset.kind = activeGestureState ? activeGestureState.type : 'idle';
          if (!activeGestureState) gestureMeta.textContent = 'Push · Pull · Wave';
        }
      }

      scheduleDraw();
    }

    function stopSim() {
      if (simTimer !== null) {
        clearInterval(simTimer);
        simTimer = null;
      }
      simActive = false;
      simKind = null;
      updateStatusPill();
    }

    function runSim(kind) {
      stopSim();
      simActive = true;
      simKind = kind;
      updateStatusPill();

      // Use zero hardware offset for synthesized playback, re-anchor clutter cleanly
      engine.setAutoAlignDirectPath(false);
      engine.resetClutter();

      const synth = synthesizeGestureSignal(kind, {
        sampleRate: 48000,
        txGain: DEFAULT_TX_GAIN,
        warmupFrames: 8,
        gestureFrames: 24,
        tailFrames: 8,
        seed: (Date.now() & 0xffff) ^ 0x504e
      });

      let cursor = 0;
      const chunkLen = 512;
      let simTime = 0;

      // Process warmup frames immediately so user sees echo enter right away
      const warmupSamples = synth.warmupFrames * synth.period;
      while (cursor < warmupSamples && cursor < synth.samples.length) {
        const slice = synth.samples.subarray(cursor, cursor + chunkLen);
        cursor += slice.length;
        simTime += slice.length / synth.sampleRate;
        engine.processBlock(slice, synth.sampleRate, simTime);
      }

      // Stream active gesture + tail at real-time 48 kHz sonar cadence (~21.3 ms / chirp)
      simTimer = setInterval(() => {
        if (!simActive) return;
        for (let step = 0; step < 2; step++) {
          if (cursor >= synth.samples.length) {
            stopSim();
            if (isSonarLive()) {
              engine.setAutoAlignDirectPath(true);
              engine.resetClutter();
            }
            return;
          }
          const slice = synth.samples.subarray(cursor, cursor + chunkLen);
          cursor += slice.length;
          simTime += slice.length / synth.sampleRate;
          const res = engine.processBlock(slice, synth.sampleRate, simTime);
          if (res) applyFrameToUi(res);
        }
      }, 21);
    }

    // --- DPR-Scaled Range-Time Radar Waterfall Rendering ---
    function resizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const hPx = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== hPx) {
        canvas.width = w;
        canvas.height = hPx;
        canvasDirty = true;
      }
    }

    function drawWaterfall() {
      rafId = 0;
      if (!ctx || !canvasDirty) return;
      canvasDirty = false;
      resizeCanvas();

      const w = canvas.width;
      const hPx = canvas.height;
      if (w < 4 || hPx < 4) return;

      // Reserve bottom strip height for Sim buttons so ticks stay clear
      ctx.fillStyle = '#f5f5f3';
      ctx.fillRect(0, 0, w, hPx);

      // Subtle Swiss range gridlines (50, 35, 20, 10 cm)
      ctx.strokeStyle = 'rgba(20, 20, 19, 0.07)';
      ctx.lineWidth = Math.max(1, Math.floor((global.devicePixelRatio || 1)));
      const gridRanges = [10, 22, 34, 46];
      for (let g = 0; g < gridRanges.length; g++) {
        const frac = 1 - (gridRanges[g] - MIN_RANGE_CM) / (MAX_RANGE_CM - MIN_RANGE_CM);
        const y = Math.round(frac * hPx) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      const colW = w / WATERFALL_COLS;
      const binH = hPx / DEFAULT_NUM_BINS;

      // Draw columns oldest (left) to newest (right); top = 55 cm, bottom = 4 cm
      for (let c = 0; c < WATERFALL_COLS; c++) {
        const entry = waterfallHistory[(wfWriteIdx + c) % WATERFALL_COLS];
        const bins = entry.bins;
        const tints = entry.tints;
        const x = c * colW;
        const cellW = Math.ceil(colW) + 0.5;

        for (let b = 0; b < DEFAULT_NUM_BINS; b++) {
          const v = bins[b];
          if (v < 0.05) continue;

          // Stereo color mapping: Left (-1) = Cobalt #0052cc, Right (+1) = Vermilion #c93700,
          // Centered (0) = Deep Braun Slate #1d2a44
          const tint = clamp(tints[b], -1, 1);
          let r = 29;
          let gr = 42;
          let bl = 68;
          if (tint < 0) {
            const t = -tint;
            r = Math.round(29 * (1 - t) + 0 * t);
            gr = Math.round(42 * (1 - t) + 82 * t);
            bl = Math.round(68 * (1 - t) + 204 * t);
          } else if (tint > 0) {
            const t = tint;
            r = Math.round(29 * (1 - t) + 201 * t);
            gr = Math.round(42 * (1 - t) + 55 * t);
            bl = Math.round(68 * (1 - t) + 0 * t);
          }
          const alpha = clamp(v * 0.92, 0.04, 0.94);
          ctx.fillStyle = `rgba(${r},${gr},${bl},${alpha.toFixed(3)})`;
          const y = hPx - (b + 1) * binH;
          ctx.fillRect(x, y, cellW, Math.ceil(binH) + 0.5);
        }
      }

      // Draw crisp range centroid trajectory trace across recent active columns
      ctx.beginPath();
      let tracing = false;
      ctx.strokeStyle = 'rgba(20, 20, 19, 0.78)';
      ctx.lineWidth = Math.max(1.5, 1.5 * (global.devicePixelRatio || 1));
      ctx.lineJoin = 'round';
      for (let c = 0; c < WATERFALL_COLS; c++) {
        const entry = waterfallHistory[(wfWriteIdx + c) % WATERFALL_COLS];
        if (entry.rangeCm !== null) {
          const x = (c + 0.5) * colW;
          const normR = clamp((entry.rangeCm - MIN_RANGE_CM) / (MAX_RANGE_CM - MIN_RANGE_CM), 0, 1);
          const y = (1 - normR) * hPx;
          if (!tracing) {
            ctx.moveTo(x, y);
            tracing = true;
          } else {
            ctx.lineTo(x, y);
          }
        } else {
          tracing = false;
        }
      }
      ctx.stroke();

      // Highlight live range dot on rightmost active sample
      const latest = waterfallHistory[(wfWriteIdx + WATERFALL_COLS - 1) % WATERFALL_COLS];
      if (latest.rangeCm !== null) {
        const normR = clamp((latest.rangeCm - MIN_RANGE_CM) / (MAX_RANGE_CM - MIN_RANGE_CM), 0, 1);
        const y = (1 - normR) * hPx;
        const x = w - Math.max(4, colW * 1.2);
        const dotR = Math.max(2.5, 2.5 * (global.devicePixelRatio || 1));
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x, y, dotR + 1.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#0052cc';
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function scheduleDraw() {
      if (rafId || typeof global.requestAnimationFrame !== 'function') return;
      rafId = global.requestAnimationFrame(drawWaterfall);
    }

    let resizeObserver = null;
    if (typeof global.ResizeObserver === 'function') {
      resizeObserver = new global.ResizeObserver(() => {
        canvasDirty = true;
        scheduleDraw();
      });
      resizeObserver.observe(canvas);
    }

    // Subscribe to Shared Acoustic Bus audio & state
    let unsubAudio = null;
    let unsubState = null;

    if (bus && typeof bus.onStateChange === 'function') {
      unsubState = bus.onStateChange((next) => {
        const wasLive = isSonarLive();
        busState = { ...busState, ...(next || {}) };
        const nowLive = isSonarLive();
        if (nowLive && !wasLive && !simActive) {
          engine.setAutoAlignDirectPath(true);
          engine.resetClutter();
        }
        updateStatusPill();
      });
    }

    if (bus && typeof bus.subscribeAudio === 'function') {
      unsubAudio = bus.subscribeAudio((pkt) => {
        if (simActive || !pkt || pkt.txMode !== 'chirp') return;
        const res = engine.processBlock(pkt.samples, pkt.sampleRate, pkt.timeSec);
        if (res) applyFrameToUi(res);
      });
    }

    function handleSecondaryClose() {
      stopSim();
    }
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('lg-secondary-close', handleSecondaryClose);
    }

    updateStatusPill();
    scheduleDraw();

    return {
      engine,
      txGenerator: txGen,
      runSim,
      stopSim,
      destroy() {
        stopSim();
        if (rafId && typeof global.cancelAnimationFrame === 'function') {
          global.cancelAnimationFrame(rafId);
          rafId = 0;
        }
        if (resizeObserver) {
          resizeObserver.disconnect();
          resizeObserver = null;
        }
        if (typeof unsubAudio === 'function') unsubAudio();
        if (typeof unsubState === 'function') unsubState();
        if (typeof global.removeEventListener === 'function') {
          global.removeEventListener('lg-secondary-close', handleSecondaryClose);
        }
      }
    };
  }

  return {
    ChirpSonarEngine,
    StereoChirpGenerator,
    synthesizeGestureSignal,
    buildReferenceChirp,
    buildAnalyticRefSpectrum,
    fftRadix2,
    ifftRadix2,
    mountChirpSonarCell,
    constants: {
      SPEED_OF_SOUND_CMS,
      MIN_ULTRASONIC_SR,
      BASE_CHIRP_PERIOD,
      BASE_PULSE_LEN,
      DEFAULT_TX_GAIN,
      LEFT_F0_HZ,
      LEFT_F1_HZ,
      RIGHT_F0_HZ,
      RIGHT_F1_HZ,
      MIN_RANGE_CM,
      MAX_RANGE_CM,
      DEFAULT_NUM_BINS
    }
  };
});
