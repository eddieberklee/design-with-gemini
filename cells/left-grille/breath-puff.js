/**
 * Secondary Grid Cell 05 — Grille Breath Puff Detector (`cells/left-grille/breath-puff.js`)
 *
 * Passive < 12 kHz aerodynamic turbulence DSP + Braun/Swiss Precision Anemometer Pinwheel UI.
 *
 * Acoustic Physics (MacBook Pro Left Speaker Grille 3-Mic Array):
 *   1. Sub-bass / low-frequency vortex roar (`20–200 Hz`): rises `+14 to +40 dB` above ambient.
 *   2. Steep aerodynamic spectral roll-off:
 *        - `10 * log10(psdSub / psdMid) > +8 dB` (`Mid = 500–2200 Hz`)
 *        - `10 * log10(psdSub / psdHf)  > +16 dB` (`HF  = 3500–11000 Hz`)
 *      Rejects nail scratches, grille rubs, and high-frequency friction (`vetoReason: 'friction'`).
 *   3. Smooth aerodynamic envelope: `duration >= 95 ms`, initial attack rise `>= 25 ms`,
 *      cleanly rejecting `< 35 ms` desk thumps and sharp taps (`vetoReason: 'impulse'`).
 *   4. Aperiodic turbulence (Voiced Speech / Hum Veto): anti-aliased `12 kHz` stream computes
 *      first-zero-guarded normalized autocorrelation (`NACF`) and local harmonic prominence
 *      in `90–600 Hz`, 100% rejecting humming (`"mmmm"`) and speech (`vetoReason: 'voiced'`).
 *
 * UMD-compatible: exports pure DSP classes & simulators in Node.js for `node --test`, and
 * registers into Secondary Slot `5` via `window.LeftGrilleLab` in the browser.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    const api = factory();
    root.LeftGrilleBreathPuff = api;
    api.registerIntoLab(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function breathPuffFactory() {
  'use strict';

  const EPS = 1e-18;

  function clamp(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  function median(arr) {
    if (!arr || !arr.length) return 0;
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
  }

  function computeDecimationFactor(sampleRate) {
    if (!Number.isFinite(sampleRate) || sampleRate < 64000) return 1;
    return Math.max(1, Math.round(sampleRate / 48000));
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

  function makeHannWindow(n) {
    const w = new Float64Array(n);
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const v = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
      w[i] = v;
      s2 += v * v;
    }
    return { w, s2 };
  }

  /**
   * Direct Form II Transposed Biquad IIR filter.
   */
  class BiquadFilter {
    constructor(b0, b1, b2, a1, a2) {
      this.b0 = b0;
      this.b1 = b1;
      this.b2 = b2;
      this.a1 = a1;
      this.a2 = a2;
      this.z1 = 0;
      this.z2 = 0;
    }

    static lowpass(fc, fs, q = Math.SQRT1_2) {
      const w0 = (2 * Math.PI * clamp(fc, 1, fs * 0.45)) / fs;
      const cosW = Math.cos(w0);
      const alpha = Math.sin(w0) / (2 * q);
      const a0 = 1 + alpha;
      return new BiquadFilter(
        ((1 - cosW) * 0.5) / a0,
        (1 - cosW) / a0,
        ((1 - cosW) * 0.5) / a0,
        (-2 * cosW) / a0,
        (1 - alpha) / a0
      );
    }

    static highpass(fc, fs, q = Math.SQRT1_2) {
      const w0 = (2 * Math.PI * clamp(fc, 1, fs * 0.45)) / fs;
      const cosW = Math.cos(w0);
      const alpha = Math.sin(w0) / (2 * q);
      const a0 = 1 + alpha;
      return new BiquadFilter(
        ((1 + cosW) * 0.5) / a0,
        -(1 + cosW) / a0,
        ((1 + cosW) * 0.5) / a0,
        (-2 * cosW) / a0,
        (1 - alpha) / a0
      );
    }

    process(x) {
      const y = this.b0 * x + this.z1;
      this.z1 = this.b1 * x - this.a1 * y + this.z2;
      this.z2 = this.b2 * x - this.a2 * y;
      return y;
    }

    reset() {
      this.z1 = 0;
      this.z2 = 0;
    }
  }

  /**
   * Physical Pinwheel Rotor Model:
   * Real angular momentum + quadratic aerodynamic drag + viscous/stiction bearing damping.
   */
  class PinwheelPhysics {
    constructor(options = {}) {
      this.inertia = Number.isFinite(options.inertia) ? options.inertia : 0.085;
      this.viscousDrag = Number.isFinite(options.viscousDrag) ? options.viscousDrag : 0.14;
      this.bearingFriction = Number.isFinite(options.bearingFriction) ? options.bearingFriction : 0.45;
      this.driveGain = Number.isFinite(options.driveGain) ? options.driveGain : 12.8;
      this.omega = 0; // rad/s
      this.angleDeg = 0;
    }

    step(airflowPct, dtSec) {
      const dt = clamp(dtSec, 0.0005, 0.1);
      const flow = clamp(airflowPct / 100, 0, 1.35);
      const driveTorque = this.driveGain * Math.pow(flow, 1.15);
      const dragTorque = this.viscousDrag * this.omega + (this.omega > 0.02 ? this.bearingFriction : 0);
      const alpha = (driveTorque - dragTorque) / this.inertia;
      this.omega = Math.max(0, this.omega + alpha * dt);
      if (flow < 0.02 && this.omega < 0.08) {
        this.omega = 0;
      }
      const rpm = (this.omega * 60) / (2 * Math.PI);
      this.angleDeg = (this.angleDeg + ((this.omega * 180) / Math.PI) * dt) % 360;
      return { rpm, angleDeg: this.angleDeg };
    }

    reset() {
      this.omega = 0;
      this.angleDeg = 0;
    }
  }

  /**
   * Pure DSP Engine for Passive Grille Breath Puff Detection (< 12 kHz).
   */
  class BreathPuffDspCore {
    constructor(options = {}) {
      const rawSr = Number(options.sampleRate);
      this.sampleRate = Number.isFinite(rawSr) && rawSr >= 8000 ? rawSr : 48000;
      this.decim = computeDecimationFactor(this.sampleRate);
      this.effRate = this.sampleRate / this.decim;

      // Low-rate stream (~12 kHz) for crisp 20–200 Hz PSD + 90–600 Hz pitch periodicity
      this.lowDecim = Math.max(1, Math.round(this.effRate / 12000));
      this.lowRate = this.effRate / this.lowDecim;

      // Sub-frame hop (~5.33 ms: 256 samples @ 48k effective, 64 samples @ 12k low)
      this.subHopLow = Math.max(32, Math.round(this.lowRate * 0.005333));
      this.subHopEff = this.subHopLow * this.lowDecim;
      this.dt = this.subHopEff / this.effRate;

      // Full-rate high-band FFT (512-pt) & low-rate FFT (1024-pt)
      this.fftHiSize = 512;
      this.fftLoSize = 1024;
      const hiWin = makeHannWindow(this.fftHiSize);
      const loWin = makeHannWindow(this.fftLoSize);
      this.hannHi = hiWin.w;
      this.s2Hi = hiWin.s2;
      this.hannLo = loWin.w;
      this.s2Lo = loWin.s2;

      this.fftHiRe = new Float64Array(this.fftHiSize);
      this.fftHiIm = new Float64Array(this.fftHiSize);
      this.fftLoRe = new Float64Array(this.fftLoSize);
      this.fftLoIm = new Float64Array(this.fftLoSize);
      this.psdLo = new Float64Array(this.fftLoSize >> 1);

      // Ring buffers
      this.effRing = new Float64Array(this.fftHiSize);
      this.effRingPos = 0;
      this.loRing = new Float64Array(this.fftLoSize);
      this.loRingPos = 0;
      this.voiceRing = new Float64Array(512); // ~42 ms at 12 kHz for NACF
      this.voiceRingPos = 0;

      // Precompute FFT bin ranges
      const dfHi = this.effRate / this.fftHiSize;
      const dfLo = this.lowRate / this.fftLoSize;
      this.subBins = this._binRange(dfLo, 20, 200, 1, (this.fftLoSize >> 1) - 1);
      this.voiceBins = this._binRange(dfLo, 90, 600, 1, (this.fftLoSize >> 1) - 1);
      this.midBins = this._binRange(dfHi, 500, 2200, 1, (this.fftHiSize >> 1) - 1);
      const hfCeil = Math.min(11000, this.effRate * 0.44);
      const hfFloor = Math.min(3500, hfCeil * 0.65);
      this.hfBins = this._binRange(dfHi, hfFloor, hfCeil, 1, (this.fftHiSize >> 1) - 1);

      // Anti-alias LPF before lowDecim downsampling
      const aaFc = this.lowRate * 0.36;
      this.aaLpf1 = BiquadFilter.lowpass(aaFc, this.effRate);
      this.aaLpf2 = BiquadFilter.lowpass(aaFc, this.effRate);

      // 20–200 Hz 4th-order-like sub-bass filterbank on lowRate for 5.33 ms envelope
      this.subHpf = BiquadFilter.highpass(20, this.lowRate);
      this.subLpf1 = BiquadFilter.lowpass(200, this.lowRate);
      this.subLpf2 = BiquadFilter.lowpass(200, this.lowRate);

      // 90–900 Hz bandpass on lowRate for pitch autocorrelation (NACF)
      this.voiceHpf = BiquadFilter.highpass(90, this.lowRate);
      this.voiceLpf = BiquadFilter.lowpass(900, this.lowRate);

      // Lag bounds for 85–600 Hz periodicity on lowRate
      this.minVoiceLag = Math.max(8, Math.floor(this.lowRate / 600));
      this.maxVoiceLag = Math.min(260, Math.ceil(this.lowRate / 85));

      this.rotor = new PinwheelPhysics();

      // Decimation & hop accumulators
      this.decimSum = 0;
      this.decimCount = 0;
      this.lowDecimCount = 0;
      this.subSampleCount = 0;
      this.subEnergyAccum = 0;
      this.effSampleClock = 0;
      this.frameIndex = 0;

      // Ambient & state machine
      this.ambientSubDb = null;
      this.ambientMidDb = null;
      this.ambientHfDb = null;
      this.subPowerEma = 0;
      this.quietFrames = 0;
      this.nonEventFrames = 0;
      this.voicedStreak = 0;
      this.preRoll = [];
      this.maxPreRoll = 34; // ~180 ms lookback
      this.activeEvent = null;
      this.cooldownUntilSec = -1;
      this.vetoHoldFrames = 0;
      this.lastVetoReason = null;
      this.puffSeq = 0;
      this.hangoverFrames = Math.max(4, Math.round(0.065 / this.dt));
    }

    _binRange(df, fLo, fHi, minBin, maxBin) {
      const b0 = Math.max(minBin, Math.floor(fLo / df));
      const b1 = Math.min(maxBin, Math.ceil(fHi / df));
      const bins = [];
      for (let b = b0; b <= b1; b++) bins.push(b);
      if (!bins.length) bins.push(clamp(Math.round(((fLo + fHi) * 0.5) / df), minBin, maxBin));
      return bins;
    }

    reset() {
      this.effRing.fill(0);
      this.loRing.fill(0);
      this.voiceRing.fill(0);
      this.effRingPos = 0;
      this.loRingPos = 0;
      this.voiceRingPos = 0;
      this.aaLpf1.reset();
      this.aaLpf2.reset();
      this.subHpf.reset();
      this.subLpf1.reset();
      this.subLpf2.reset();
      this.voiceHpf.reset();
      this.voiceLpf.reset();
      this.rotor.reset();
      this.decimSum = 0;
      this.decimCount = 0;
      this.lowDecimCount = 0;
      this.subSampleCount = 0;
      this.subEnergyAccum = 0;
      this.effSampleClock = 0;
      this.frameIndex = 0;
      this.ambientSubDb = null;
      this.ambientMidDb = null;
      this.ambientHfDb = null;
      this.subPowerEma = 0;
      this.quietFrames = 0;
      this.nonEventFrames = 0;
      this.voicedStreak = 0;
      this.preRoll = [];
      this.activeEvent = null;
      this.cooldownUntilSec = -1;
      this.vetoHoldFrames = 0;
      this.lastVetoReason = null;
    }

    processSamples(samples, baseTimeSec) {
      const events = [];
      if (!samples || !samples.length) return events;

      const startClock =
        Number.isFinite(baseTimeSec) ? baseTimeSec : this.effSampleClock / this.effRate;
      let effOffset = 0;

      for (let i = 0; i < samples.length; i++) {
        const raw = samples[i];
        const x = Number.isFinite(raw) ? raw : 0;
        this.decimSum += x;
        this.decimCount++;
        if (this.decimCount < this.decim) continue;

        const xEff = this.decimSum / this.decim;
        this.decimSum = 0;
        this.decimCount = 0;

        this.effRing[this.effRingPos] = xEff;
        this.effRingPos = (this.effRingPos + 1) % this.fftHiSize;

        // Anti-alias filter at full effective rate before downsampling to ~12 kHz
        const aa = this.aaLpf2.process(this.aaLpf1.process(xEff));
        this.lowDecimCount++;
        if (this.lowDecimCount >= this.lowDecim) {
          this.lowDecimCount = 0;

          this.loRing[this.loRingPos] = aa;
          this.loRingPos = (this.loRingPos + 1) % this.fftLoSize;

          const subSample = this.subLpf2.process(this.subLpf1.process(this.subHpf.process(aa)));
          this.subEnergyAccum += subSample * subSample;

          const voiceSample = this.voiceLpf.process(this.voiceHpf.process(aa));
          this.voiceRing[this.voiceRingPos] = voiceSample;
          this.voiceRingPos = (this.voiceRingPos + 1) % this.voiceRing.length;
        }

        this.subSampleCount++;
        effOffset++;
        this.effSampleClock++;

        if (this.subSampleCount >= this.subHopEff) {
          this.subSampleCount = 0;
          const frameTimeSec =
            Number.isFinite(baseTimeSec)
              ? startClock + effOffset / this.effRate
              : this.effSampleClock / this.effRate;
          const frameEvents = this._analyzeSubFrame(frameTimeSec);
          for (let e = 0; e < frameEvents.length; e++) events.push(frameEvents[e]);
        }
      }
      return events;
    }

    _computeNacf() {
      const len = this.voiceRing.length;
      const winLen = Math.min(len - this.maxVoiceLag - 2, Math.round(this.lowRate * 0.028));
      if (winLen < 64) return 0;

      // Copy newest segment linearly for fast inner loops
      const buf = new Float64Array(winLen + this.maxVoiceLag + 2);
      const startIdx = (this.voiceRingPos - buf.length + len * 4) % len;
      for (let i = 0; i < buf.length; i++) {
        buf[i] = this.voiceRing[(startIdx + i) % len];
      }

      const baseOffset = this.maxVoiceLag;
      let energy0 = 0;
      for (let i = 0; i < winLen; i++) {
        const v = buf[baseOffset + i];
        energy0 += v * v;
      }
      if (energy0 < 1e-11) return 0;

      // Require first zero-crossing of autocorrelation so lowpass noise lag-0 mainlobe
      // never masquerades as high-frequency pitch periodicity.
      let seenZeroCrossing = false;
      let bestNacf = 0;

      for (let lag = 1; lag <= this.maxVoiceLag; lag++) {
        let num = 0;
        let energyLag = 0;
        for (let i = 0; i < winLen; i++) {
          const a = buf[baseOffset + i];
          const b = buf[baseOffset + i - lag];
          num += a * b;
          energyLag += b * b;
        }
        const denom = Math.sqrt(energy0 * energyLag + EPS);
        const r = num / denom;
        if (!seenZeroCrossing && r <= 0.12) {
          seenZeroCrossing = true;
        }
        if (seenZeroCrossing && lag >= this.minVoiceLag && r > bestNacf) {
          bestNacf = r;
        }
      }
      return clamp(bestNacf, 0, 1);
    }

    _computeLocalHarmonicProminenceDb() {
      let maxPromDb = 0;
      const bins = this.voiceBins;
      const halfLimit = this.psdLo.length - 1;
      for (let idx = 0; idx < bins.length; idx++) {
        const k = bins[idx];
        const centerPow = this.psdLo[k];
        if (centerPow <= 1e-16) continue;
        const neighbors = [];
        for (let d = 2; d <= 5; d++) {
          if (k - d >= 1) neighbors.push(this.psdLo[k - d]);
          if (k + d <= halfLimit) neighbors.push(this.psdLo[k + d]);
        }
        if (neighbors.length < 3) continue;
        const bg = median(neighbors);
        const promDb = 10 * Math.log10((centerPow + EPS) / (bg + EPS));
        if (promDb > maxPromDb) maxPromDb = promDb;
      }
      return maxPromDb;
    }

    _analyzeSubFrame(timeSec) {
      const events = [];
      this.frameIndex++;

      const subPow = this.subEnergyAccum / this.subHopLow;
      const subRms = Math.sqrt(subPow + EPS);
      this.subEnergyAccum = 0;
      // ~16 ms smoothed power envelope stabilizes sub-bass variance while keeping raw subRms for taps
      if (this.subPowerEma <= 0) {
        this.subPowerEma = subPow;
      } else {
        this.subPowerEma += 0.36 * (subPow - this.subPowerEma);
      }
      const subEnvRms = Math.sqrt(this.subPowerEma + EPS);
      const subRmsDb = 20 * Math.log10(subEnvRms + 1e-9);

      // 1. Low-rate 1024-pt Hann FFT (20–200 Hz PSD & 90–600 Hz harmonic prominence)
      for (let n = 0; n < this.fftLoSize; n++) {
        const idx = (this.loRingPos + n) % this.fftLoSize;
        this.fftLoRe[n] = this.loRing[idx] * this.hannLo[n];
        this.fftLoIm[n] = 0;
      }
      fftRadix2(this.fftLoRe, this.fftLoIm);

      const loScale = 2 / (this.s2Lo * this.lowRate);
      for (let k = 1; k < this.psdLo.length; k++) {
        const re = this.fftLoRe[k];
        const im = this.fftLoIm[k];
        this.psdLo[k] = (re * re + im * im) * loScale;
      }

      let psdSubSum = 0;
      for (let i = 0; i < this.subBins.length; i++) {
        psdSubSum += this.psdLo[this.subBins[i]];
      }
      const psdSub = psdSubSum / this.subBins.length;

      // 2. Full-rate 512-pt Hann FFT (Mid 500–2200 Hz & HF 3500–11000 Hz PSD)
      for (let n = 0; n < this.fftHiSize; n++) {
        const idx = (this.effRingPos + n) % this.fftHiSize;
        this.fftHiRe[n] = this.effRing[idx] * this.hannHi[n];
        this.fftHiIm[n] = 0;
      }
      fftRadix2(this.fftHiRe, this.fftHiIm);

      const hiScale = 2 / (this.s2Hi * this.effRate);
      let psdMidSum = 0;
      for (let i = 0; i < this.midBins.length; i++) {
        const b = this.midBins[i];
        psdMidSum += (this.fftHiRe[b] * this.fftHiRe[b] + this.fftHiIm[b] * this.fftHiIm[b]) * hiScale;
      }
      const psdMid = psdMidSum / this.midBins.length;

      let psdHfSum = 0;
      for (let i = 0; i < this.hfBins.length; i++) {
        const b = this.hfBins[i];
        psdHfSum += (this.fftHiRe[b] * this.fftHiRe[b] + this.fftHiIm[b] * this.fftHiIm[b]) * hiScale;
      }
      const psdHf = psdHfSum / this.hfBins.length;

      const psdSubDb = 10 * Math.log10(psdSub + EPS);
      const psdMidDb = 10 * Math.log10(psdMid + EPS);
      const psdHfDb = 10 * Math.log10(psdHf + EPS);

      const rolloffSubMidDb = psdSubDb - psdMidDb;
      const rolloffSubHfDb = psdSubDb - psdHfDb;

      // Combine time-domain RMS and sub-FFT PSD floor for stable low-band SNR.
      // During the first ~64 ms (or while unseeded from digital silence), warm up ambient floor
      // so IIR transient startup or zero-padding never triggers a false onset.
      const safeSubDb = Math.max(-94, subRmsDb);
      const safeMidDb = Math.max(-135, psdMidDb);
      const safeHfDb = Math.max(-145, psdHfDb);

      if (subRms > 1e-6 && (this.ambientSubDb === null || this.frameIndex <= 12)) {
        if (this.ambientSubDb === null) {
          this.ambientSubDb = safeSubDb;
          this.ambientMidDb = safeMidDb;
          this.ambientHfDb = safeHfDb;
        } else {
          this.ambientSubDb = Math.max(-94, this.ambientSubDb + 0.35 * (safeSubDb - this.ambientSubDb));
          this.ambientMidDb += 0.35 * (safeMidDb - this.ambientMidDb);
          this.ambientHfDb += 0.35 * (safeHfDb - this.ambientHfDb);
        }
      }

      const baseSubDb = this.ambientSubDb === null ? safeSubDb : this.ambientSubDb;
      const baseMidDb = this.ambientMidDb === null ? safeMidDb : this.ambientMidDb;
      const baseHfDb = this.ambientHfDb === null ? safeHfDb : this.ambientHfDb;

      const subSnrDb = this.frameIndex <= 12 ? 0 : Math.max(0, subRmsDb - baseSubDb);
      const midRiseDb = this.frameIndex <= 12 ? 0 : Math.max(0, psdMidDb - baseMidDb);
      const hfRiseDb = this.frameIndex <= 12 ? 0 : Math.max(0, psdHfDb - baseHfDb);

      // 3. Voiced Speech / Hum Periodicity Analysis (90–600 Hz)
      const nacfMax = subSnrDb >= 6 || midRiseDb >= 6 ? this._computeNacf() : 0;
      const localPromDb = subSnrDb >= 6 || midRiseDb >= 6 ? this._computeLocalHarmonicProminenceDb() : 0;
      if (nacfMax >= 0.62 && (subSnrDb >= 6 || midRiseDb >= 6)) {
        this.voicedStreak++;
      } else {
        this.voicedStreak = 0;
      }
      const isVoiced =
        localPromDb >= 18.5 ||
        (nacfMax >= 0.68 && localPromDb >= 14.0) ||
        this.voicedStreak >= 4;

      const steepRolloff = rolloffSubMidDb > 8.0 && rolloffSubHfDb > 16.0;
      const isFriction = (hfRiseDb >= 10.0 || midRiseDb >= 10.0) && !steepRolloff;

      // Update adaptive ambient floor during quiet non-zero frames (or after steady non-aerodynamic background shift)
      if (!this.activeEvent && subRms > 1e-6 && subSnrDb < 7.5 && midRiseDb < 7.5 && hfRiseDb < 7.5) {
        this.quietFrames++;
        this.nonEventFrames = 0;
        const alphaUp = this.quietFrames < 18 ? 0.14 : 0.018;
        const alphaDown = 0.16;
        this.ambientSubDb = Math.max(
          -94,
          baseSubDb + (safeSubDb < baseSubDb ? alphaDown : alphaUp) * (safeSubDb - baseSubDb)
        );
        this.ambientMidDb =
          baseMidDb + (safeMidDb < baseMidDb ? alphaDown : alphaUp) * (safeMidDb - baseMidDb);
        this.ambientHfDb =
          baseHfDb + (safeHfDb < baseHfDb ? alphaDown : alphaUp) * (safeHfDb - baseHfDb);
      } else {
        this.quietFrames = 0;
        if (!this.activeEvent && subRms > 1e-6 && !(subSnrDb >= 14.0 && steepRolloff && !isVoiced)) {
          this.nonEventFrames++;
          if (this.nonEventFrames > 18) {
            this.ambientSubDb = Math.max(-94, baseSubDb + 0.06 * (safeSubDb - baseSubDb));
            this.ambientMidDb = baseMidDb + 0.06 * (safeMidDb - baseMidDb);
            this.ambientHfDb = baseHfDb + 0.06 * (safeHfDb - baseHfDb);
          }
        } else {
          this.nonEventFrames = 0;
        }
      }

      const frame = {
        timeSec,
        subRms: subEnvRms,
        subRawRms: subRms,
        subRmsDb,
        subSnrDb,
        rolloffSubMidDb,
        rolloffSubHfDb,
        isVoiced,
        nacfMax,
        localPromDb,
        steepRolloff
      };
      this.preRoll.push(frame);
      if (this.preRoll.length > this.maxPreRoll) this.preRoll.shift();

      let frameVeto = null;
      if (isVoiced && (subSnrDb >= 8.0 || midRiseDb >= 8.0)) {
        frameVeto = 'voiced';
      } else if (isFriction) {
        frameVeto = 'friction';
      }

      // 4. Aerodynamic Puff Event State Machine
      const isAerodynamicFrame = subSnrDb >= 14.0 && steepRolloff && !isVoiced;

      if (!this.activeEvent) {
        if (isAerodynamicFrame && timeSec >= this.cooldownUntilSec) {
          // Walk backward through pre-roll to capture gradual attack ramp onset
          let onsetIdx = this.preRoll.length - 1;
          let gap = 0;
          for (let i = this.preRoll.length - 2; i >= 0; i--) {
            const pf = this.preRoll[i];
            if (pf.isVoiced) break;
            if (pf.subSnrDb >= 2.2) {
              onsetIdx = i;
              gap = 0;
            } else {
              gap++;
              if (gap > 1) break;
            }
          }

          const seedFrames = this.preRoll.slice(onsetIdx);
          const ev = {
            onsetTimeSec: seedFrames[0].timeSec - this.dt,
            lastActiveTimeSec: timeSec,
            frames: seedFrames.slice(),
            peakSnrDb: 0,
            peakSubRms: 0,
            rolloffMidList: [],
            rolloffHfList: [],
            voicedCount: 0,
            totalCount: 0,
            belowCount: 0,
            impulse: 0
          };
          for (let i = 0; i < seedFrames.length; i++) {
            const sf = seedFrames[i];
            ev.totalCount++;
            if (sf.isVoiced) ev.voicedCount++;
            if (sf.subSnrDb > ev.peakSnrDb) ev.peakSnrDb = sf.subSnrDb;
            if (sf.subRms > ev.peakSubRms) ev.peakSubRms = sf.subRms;
            if (sf.subSnrDb >= 10) {
              ev.rolloffMidList.push(sf.rolloffSubMidDb);
              ev.rolloffHfList.push(sf.rolloffSubHfDb);
            }
            ev.impulse += clamp((sf.subSnrDb - 6) / 30, 0, 1.3) * this.dt;
          }
          this.activeEvent = ev;
        }
      } else {
        const ev = this.activeEvent;
        ev.frames.push(frame);
        ev.totalCount++;
        if (isVoiced) ev.voicedCount++;
        if (subSnrDb > ev.peakSnrDb) ev.peakSnrDb = subSnrDb;
        if (subRms > ev.peakSubRms) ev.peakSubRms = subRms;
        if (subSnrDb >= 10 && !isVoiced) {
          ev.rolloffMidList.push(rolloffSubMidDb);
          ev.rolloffHfList.push(rolloffSubHfDb);
        }

        const activeHold = subSnrDb >= 7.5 && !isVoiced && (steepRolloff || subSnrDb >= 12.0);
        if (activeHold) {
          ev.lastActiveTimeSec = timeSec;
          ev.belowCount = 0;
          ev.impulse += clamp((subSnrDb - 6) / 30, 0, 1.3) * this.dt;
        } else {
          ev.belowCount++;
          if (isVoiced) ev.belowCount++; // Abort faster on speech transition
        }

        const elapsedMs = (ev.lastActiveTimeSec - ev.onsetTimeSec) * 1000;
        const shouldFinalize =
          ev.belowCount >= this.hangoverFrames || elapsedMs >= 4000;

        if (shouldFinalize) {
          const outcome = this._finalizeEvent(ev);
          this.activeEvent = null;
          if (outcome.puff) {
            events.push({ type: 'puff', timeSec, puff: outcome.puff });
            this.cooldownUntilSec = timeSec + 0.045;
          } else if (outcome.vetoReason) {
            frameVeto = outcome.vetoReason;
          }
        }
      }

      if (frameVeto) {
        this.lastVetoReason = frameVeto;
        this.vetoHoldFrames = Math.round(0.24 / this.dt);
      } else if (this.vetoHoldFrames > 0) {
        this.vetoHoldFrames--;
        if (this.vetoHoldFrames === 0) this.lastVetoReason = null;
      }

      // 5. Continuous Airflow % & Pinwheel Rotor Physics
      let airflowPct = 0;
      if (!isVoiced && steepRolloff && subSnrDb >= 6.0) {
        airflowPct = clamp(Math.round(((subSnrDb - 5.5) / 29.0) * 100), 0, 100);
      }
      const rotorStep = this.rotor.step(airflowPct, this.dt);

      const activeDurMs = this.activeEvent
        ? Math.max(0, Math.round((this.activeEvent.lastActiveTimeSec - this.activeEvent.onsetTimeSec) * 1000))
        : 0;
      const liveKind =
        this.activeEvent && activeDurMs >= 450 && this.activeEvent.peakSnrDb >= 16.5
          ? 'SUSTAINED BLOW'
          : null;

      // Emit telemetry every 2nd sub-frame (~93.75 Hz -> ~10.67 ms at 48 kHz)
      if ((this.frameIndex & 1) === 0 || events.length > 0) {
        events.unshift({
          type: 'telemetry',
          timeSec,
          airflowPct,
          rotorRpm: Math.round(rotorStep.rpm),
          subSnrDb: Math.round(subSnrDb * 10) / 10,
          rolloffSubMidDb: Math.round(rolloffSubMidDb * 10) / 10,
          rolloffSubHfDb: Math.round(rolloffSubHfDb * 10) / 10,
          vetoReason: this.lastVetoReason,
          active: Boolean(this.activeEvent),
          activeDurationMs: activeDurMs,
          liveKind,
          bands: {
            sub: clamp((subSnrDb + 4) / 40, 0, 1),
            mid: clamp((midRiseDb + 2) / 36, 0, 1),
            hf: clamp((hfRiseDb + 2) / 36, 0, 1)
          }
        });
      }

      return events;
    }

    _finalizeEvent(ev) {
      const frames = ev.frames;
      if (!frames.length) return { puff: null, vetoReason: null };

      // Trim leading ambient-noise frames & trailing below-threshold frames
      let globalPeakRms = 0;
      for (let i = 0; i < frames.length; i++) {
        if (frames[i].subRms > globalPeakRms) globalPeakRms = frames[i].subRms;
      }
      const edgeRmsFloor = Math.max(1e-7, 0.03 * globalPeakRms);
      let startIdx = 0;
      while (startIdx < frames.length - 1 && (frames[startIdx].subSnrDb < 2.2 || frames[startIdx].subRms < edgeRmsFloor)) {
        startIdx++;
      }
      let endIdx = frames.length - 1;
      while (endIdx > startIdx && (frames[endIdx].subSnrDb < 7.5 || frames[endIdx].subRms < edgeRmsFloor)) {
        endIdx--;
      }
      const trimmed = frames.slice(startIdx, endIdx + 1);
      if (trimmed.length < 3) return { puff: null, vetoReason: 'impulse' };

      const eventOnsetTime = trimmed[0].timeSec - this.dt;
      const durationMs = Math.round((trimmed[trimmed.length - 1].timeSec - eventOnsetTime) * 1000);
      const peakSnrDb = Math.round(ev.peakSnrDb * 10) / 10;

      // Gate 1: Voiced Speech / Hum domination (ratio or median harmonic periodicity)
      const activeNacfs = trimmed.map((f) => f.nacfMax);
      const activeProms = trimmed.map((f) => f.localPromDb);
      if (
        ev.voicedCount / Math.max(1, ev.totalCount) >= 0.28 ||
        median(activeNacfs) >= 0.58 ||
        median(activeProms) >= 16.5
      ) {
        return { puff: null, vetoReason: 'voiced' };
      }

      // Gate 2: Steep aerodynamic spectral roll-off
      const medMidRolloff = ev.rolloffMidList.length ? median(ev.rolloffMidList) : -99;
      const medHfRolloff = ev.rolloffHfList.length ? median(ev.rolloffHfList) : -99;
      if (!(medMidRolloff > 8.0 && medHfRolloff > 16.0)) {
        return { puff: null, vetoReason: 'friction' };
      }

      // Gate 3: Minimum duration >= 95 ms (rejects < 35 ms desk thumps & micro-taps)
      if (durationMs < 95) {
        return { puff: null, vetoReason: 'impulse' };
      }

      // Gate 4: Attack rise >= 25 ms — walk backward from initial peak to true slope base
      let initialPeakIdx = 0;
      let initialPeakRms = 0;
      const targetPeakFloor = 0.65 * globalPeakRms;
      for (let i = 0; i < trimmed.length; i++) {
        const r = trimmed[i].subRms;
        if (r > initialPeakRms) {
          initialPeakRms = r;
          initialPeakIdx = i;
        }
        // Stop once we pass a clear initial crest >= 65% of global peak and start dipping
        if (initialPeakRms >= targetPeakFloor && i > initialPeakIdx && r < 0.88 * initialPeakRms) {
          break;
        }
      }

      let riseStartIdx = 0;
      for (let i = initialPeakIdx; i >= 0; i--) {
        if (trimmed[i].subRms < 0.03 * initialPeakRms || trimmed[i].subSnrDb < 2.2) {
          riseStartIdx = Math.min(initialPeakIdx, i + 1);
          break;
        }
      }
      const riseStartTime = trimmed[riseStartIdx].timeSec - this.dt;
      let riseEndTime = trimmed[initialPeakIdx].timeSec;
      for (let i = riseStartIdx; i <= initialPeakIdx; i++) {
        if (trimmed[i].subRms >= 0.85 * initialPeakRms) {
          riseEndTime = trimmed[i].timeSec;
          break;
        }
      }

      const attackRiseMs = Math.round((riseEndTime - riseStartTime) * 1000);
      if (attackRiseMs < 25) {
        return { puff: null, vetoReason: 'impulse' };
      }

      // Gate 5: Minimum peak sub-bass SNR >= 14 dB
      if (peakSnrDb < 14.0) {
        return { puff: null, vetoReason: null };
      }

      const intensityPct = clamp(Math.round(((peakSnrDb - 10) / 26) * 100), 8, 100);
      let kind = 'GENTLE BREEZE';
      if (durationMs >= 450 && (peakSnrDb >= 18.5 || durationMs >= 650)) {
        kind = 'SUSTAINED BLOW';
      } else if (peakSnrDb >= 22.5) {
        kind = 'SHARP PUFF';
      }

      return {
        puff: {
          id: ++this.puffSeq,
          kind,
          intensityPct,
          peakSnrDb,
          durationMs,
          attackRiseMs,
          impulse: Math.round(ev.impulse * 1000) / 1000,
          rolloffSubMidDb: Math.round(medMidRolloff * 10) / 10,
          rolloffSubHfDb: Math.round(medHfRolloff * 10) / 10,
          timeSec: trimmed[trimmed.length - 1].timeSec
        },
        vetoReason: null
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Synthesized 48 kHz Physical Waveforms (Live Sim Buttons + Node Unit Tests)
  // ---------------------------------------------------------------------------

  function createRng(seed = 2026) {
    let s = seed >>> 0;
    return function rand() {
      s += 0x6d2b79f5;
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
   * Synthesizes realistic passive aerodynamic breath turbulence (`< 200 Hz` vortex roar
   * with steep `-18 dB/oct` roll-off) over a quiet room-noise floor.
   */
  function synthesizeBreathWaveform(kind = 'puff', options = {}) {
    const sr = options.sampleRate || 48000;
    const rng = createRng(options.seed || (kind === 'blow' ? 9103 : kind === 'breeze' ? 4077 : 7331));
    const preSec = options.preSec !== undefined ? options.preSec : 0.24;
    const postSec = options.postSec !== undefined ? options.postSec : 0.30;

    let durSec = 0.21;
    let attackSec = 0.048;
    let releaseSec = 0.085;
    let amp = 0.0055;
    if (kind === 'blow') {
      durSec = options.durationSec || 0.78;
      attackSec = options.attackSec || 0.095;
      releaseSec = 0.14;
      amp = options.amplitude || 0.0045;
    } else if (kind === 'breeze') {
      durSec = options.durationSec || 0.28;
      attackSec = options.attackSec || 0.070;
      releaseSec = 0.11;
      amp = options.amplitude || 0.0026;
    } else {
      durSec = options.durationSec || 0.21;
      attackSec = options.attackSec || 0.048;
      releaseSec = 0.085;
      amp = options.amplitude || 0.0055;
    }

    const total = Math.floor((preSec + durSec + postSec) * sr);
    const out = new Float32Array(total);
    const s0 = Math.floor(preSec * sr);
    const s1 = s0 + Math.floor(durSec * sr);

    const hpf = BiquadFilter.highpass(22, sr);
    const lpf1 = BiquadFilter.lowpass(135, sr);
    const lpf2 = BiquadFilter.lowpass(175, sr);
    const ambLpf = BiquadFilter.lowpass(350, sr);
    for (let k = 0; k < 240; k++) ambLpf.process(randNormal(rng));

    for (let n = 0; n < total; n++) {
      const wn = randNormal(rng);
      // Realistic quiet-room ambient floor: gentle 1/f low room hum + -78 dBFS ADC floor
      let x = ambLpf.process(wn) * 0.0012 + randNormal(rng) * 0.00012;
      if (n >= s0 && n < s1) {
        const tIn = (n - s0) / sr;
        const tLeft = (s1 - n) / sr;
        let env = 1.0;
        if (tIn < attackSec) {
          env = 0.5 * (1 - Math.cos((Math.PI * tIn) / attackSec));
        } else if (tLeft < releaseSec) {
          env = 0.5 * (1 - Math.cos((Math.PI * tLeft) / releaseSec));
        }
        // Subtle 4.5 Hz Karman eddy flutter during sustained blow
        const flutter = kind === 'blow' ? 0.88 + 0.12 * Math.sin(2 * Math.PI * 4.5 * tIn) : 1.0;
        const w = randNormal(rng);
        const turb = lpf2.process(lpf1.process(hpf.process(w)));
        x += env * flutter * amp * turb * 3.2;
      }
      out[n] = x;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // UI Construction (Swiss/Braun Precision Anemometer Pinwheel Cell)
  // ---------------------------------------------------------------------------

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

  function buildPinwheelSvg() {
    const cx = 60;
    const cy = 60;
    const ticks = [];
    for (let i = 0; i < 12; i++) {
      const a = (i * 30 * Math.PI) / 180;
      const r0 = i % 3 === 0 ? 48 : 50;
      const r1 = 54;
      ticks.push(
        svgEl('line', {
          x1: (cx + Math.cos(a) * r0).toFixed(2),
          y1: (cy + Math.sin(a) * r0).toFixed(2),
          x2: (cx + Math.cos(a) * r1).toFixed(2),
          y2: (cy + Math.sin(a) * r1).toFixed(2),
          stroke: i % 3 === 0 ? '#52524e' : '#c8c8c2',
          'stroke-width': i % 3 === 0 ? '1.6' : '1'
        })
      );
    }

    // 4 machined swept anemometer blades (blade 0 has Cobalt index tip for crisp motion legibility)
    const blades = [];
    for (let b = 0; b < 4; b++) {
      const deg = b * 90;
      const vane = svgEl(
        'g',
        { transform: `rotate(${deg} ${cx} ${cy})` },
        [
          svgEl('path', {
            d: 'M 60 55 C 63 39, 73 26, 62 15 C 57 18, 55 34, 57 55 Z',
            fill: b === 0 ? '#141413' : b === 2 ? '#2c2c29' : '#63635f'
          }),
          svgEl('circle', {
            cx: 62,
            cy: 17.5,
            r: 3.6,
            fill: b === 0 ? '#0052cc' : '#141413'
          }),
          svgEl('circle', {
            cx: 62,
            cy: 17.5,
            r: 1.5,
            fill: '#ffffff',
            opacity: b === 0 ? '0.92' : '0.45'
          })
        ]
      );
      blades.push(vane);
    }

    const rotorGroup = svgEl('g', { class: 'bp-rotor-blades' }, blades);
    const flowArcRadius = 46;
    const flowArcCirc = 2 * Math.PI * flowArcRadius;

    const flowArc = svgEl('circle', {
      cx,
      cy,
      r: flowArcRadius,
      fill: 'none',
      stroke: '#0052cc',
      'stroke-width': '2.6',
      'stroke-linecap': 'round',
      'stroke-dasharray': flowArcCirc.toFixed(2),
      'stroke-dashoffset': flowArcCirc.toFixed(2),
      transform: `rotate(-90 ${cx} ${cy})`,
      class: 'bp-flow-arc'
    });

    const svg = svgEl(
      'svg',
      {
        viewBox: '0 0 120 120',
        class: 'bp-pinwheel-svg',
        'aria-hidden': 'true'
      },
      [
        svgEl('circle', {
          cx,
          cy,
          r: 56,
          fill: '#ffffff',
          stroke: '#e2e2dd',
          'stroke-width': '1.2'
        }),
        svgEl('circle', {
          cx,
          cy,
          r: flowArcRadius,
          fill: 'none',
          stroke: '#ecece8',
          'stroke-width': '2.6'
        }),
        flowArc,
        ...ticks,
        rotorGroup,
        svgEl('circle', {
          cx,
          cy,
          r: 7.5,
          fill: '#f5f5f3',
          stroke: '#141413',
          'stroke-width': '1.6'
        }),
        svgEl('circle', {
          cx,
          cy,
          r: 2.3,
          fill: '#141413'
        })
      ]
    );

    return { svg, rotorGroup, flowArc, flowArcCirc };
  }

  function mountBreathPuffCell(cellEl, bus) {
    if (!cellEl) return null;
    while (cellEl.firstChild) cellEl.removeChild(cellEl.firstChild);
    cellEl.classList.add('bp-cell');

    let dsp = new BreathPuffDspCore({ sampleRate: 48000 });
    const uiRotor = new PinwheelPhysics();
    let currentRate = 48000;
    let targetAirflowPct = 0;
    let lastPuff = null;
    let simTimer = null;
    let animRaf = null;
    let lastAnimTs = 0;
    let busState = { state: 'idle', sampleRate: 48000, error: '' };
    let unsubAudio = null;
    let unsubState = null;

    const reducedMotion = () =>
      Boolean(
        typeof globalThis.matchMedia === 'function' &&
          globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
      );

    // Build Top Micro-Bezel
    const armDot = h('span', { className: 'bp-dot', 'aria-hidden': 'true' });
    const armText = h('span', { textContent: 'ARM' });
    const armBtn = h(
      'button',
      {
        type: 'button',
        className: 'bp-btn bp-btn--arm',
        dataset: { armed: 'false' },
        'aria-pressed': 'false',
        title: 'Arm shared 48 kHz grille microphone array',
        onClick: () => handleArmClick()
      },
      [armDot, armText]
    );

    const statusPill = h('span', {
      className: 'bp-status-pill',
      textContent: 'READY · <12k passive'
    });

    const simPuffBtn = h(
      'button',
      {
        type: 'button',
        className: 'bp-mini-btn',
        title: 'Run synthesized 48 kHz Sharp Puff waveform through DSP',
        onClick: () => runSimulation('puff')
      },
      ['Sim Puff']
    );

    const simBlowBtn = h(
      'button',
      {
        type: 'button',
        className: 'bp-mini-btn bp-mini-btn--blow',
        title: 'Run synthesized 48 kHz Sustained Blow waveform through DSP',
        onClick: () => runSimulation('blow')
      },
      ['Sim Blow']
    );

    const bezel = h('div', { className: 'bp-bezel' }, [
      h('div', { className: 'bp-bezel-group' }, [armBtn, statusPill]),
      h('div', { className: 'bp-bezel-group bp-sim-group' }, [simPuffBtn, simBlowBtn])
    ]);

    // Left Column: Precision Anemometer Pinwheel SVG
    const pinwheel = buildPinwheelSvg();
    const snrBadge = h('span', { className: 'bp-snr-chip', textContent: '+0 dB' });

    const rotorWell = h('div', { className: 'bp-rotor-well' }, [
      pinwheel.svg,
      h('div', { className: 'bp-rotor-foot' }, [
        h('span', { className: 'bp-rotor-cap', textContent: '20–200 Hz' }),
        snrBadge
      ])
    ]);

    // Right Column: Hero Badge + 3 Tabular Readouts + 3-Band Roll-off Strip
    const eventTag = h('span', { className: 'bp-kind-tag', textContent: 'PASSIVE' });
    const heroBadge = h('div', {
      className: 'bp-hero-badge',
      dataset: { kind: 'idle' },
      textContent: '— READY'
    });
    const heroMeta = h('div', {
      className: 'bp-hero-meta',
      textContent: 'Blow across left grille'
    });

    const heroCard = h('div', { className: 'bp-card bp-hero-card' }, [
      h('div', { className: 'bp-card-head' }, [
        h('span', { className: 'bp-label', textContent: 'Aerodynamic' }),
        eventTag
      ]),
      heroBadge,
      heroMeta
    ]);

    const airflowVal = h('div', { className: 'bp-metric-val', textContent: '0%' });
    const rpmVal = h('div', { className: 'bp-metric-val', textContent: '0' });
    const durVal = h('div', { className: 'bp-metric-val', textContent: '0 ms' });

    const metricsGrid = h('div', { className: 'bp-metrics' }, [
      h('div', { className: 'bp-card bp-metric-card' }, [
        h('span', { className: 'bp-label', textContent: 'Airflow' }),
        airflowVal
      ]),
      h('div', { className: 'bp-card bp-metric-card' }, [
        h('span', { className: 'bp-label', textContent: 'Rotor RPM' }),
        rpmVal
      ]),
      h('div', { className: 'bp-card bp-metric-card bp-metric-card--dur' }, [
        h('span', { className: 'bp-label', textContent: 'Duration' }),
        durVal
      ])
    ]);

    const barSub = h('div', { className: 'bp-band-fill bp-band-fill--sub' });
    const barMid = h('div', { className: 'bp-band-fill bp-band-fill--mid' });
    const barHf = h('div', { className: 'bp-band-fill bp-band-fill--hf' });
    const rolloffNote = h('span', {
      className: 'bp-rolloff-note',
      textContent: 'Sub/Mid +0 dB'
    });

    const spectrumStrip = h('div', { className: 'bp-spectrum-strip' }, [
      h('div', { className: 'bp-bands' }, [
        h('div', { className: 'bp-band-row' }, [
          h('span', { className: 'bp-band-lbl', textContent: 'SUB' }),
          h('div', { className: 'bp-band-track' }, [barSub])
        ]),
        h('div', { className: 'bp-band-row' }, [
          h('span', { className: 'bp-band-lbl', textContent: 'MID' }),
          h('div', { className: 'bp-band-track' }, [barMid])
        ]),
        h('div', { className: 'bp-band-row' }, [
          h('span', { className: 'bp-band-lbl', textContent: 'HF' }),
          h('div', { className: 'bp-band-track' }, [barHf])
        ])
      ]),
      rolloffNote
    ]);

    const telemetryCol = h('div', { className: 'bp-telemetry' }, [
      heroCard,
      metricsGrid,
      spectrumStrip
    ]);

    const stage = h('div', { className: 'bp-stage' }, [
      bezel,
      h('div', { className: 'bp-body' }, [rotorWell, telemetryCol])
    ]);

    const srLive = h('div', {
      className: 'bp-sr-only',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true'
    });

    cellEl.appendChild(stage);
    cellEl.appendChild(srLive);

    function kindSlug(kind) {
      if (kind === 'SHARP PUFF') return 'sharp';
      if (kind === 'SUSTAINED BLOW') return 'sustained';
      if (kind === 'GENTLE BREEZE') return 'breeze';
      return 'idle';
    }

    function updateRotorVisual(flowPct, rpm, angleDeg) {
      const norm = clamp(flowPct / 100, 0, 1);
      const offset = pinwheel.flowArcCirc * (1 - norm);
      pinwheel.flowArc.setAttribute('stroke-dashoffset', offset.toFixed(2));
      if (!reducedMotion()) {
        pinwheel.rotorGroup.setAttribute('transform', `rotate(${angleDeg.toFixed(1)} 60 60)`);
      }
      rpmVal.textContent = String(Math.round(rpm));
    }

    function ensureRotorAnimLoop() {
      if (animRaf !== null) return;
      if (typeof globalThis.requestAnimationFrame !== 'function') return;
      lastAnimTs = 0;
      const tick = (ts) => {
        const dt = lastAnimTs ? Math.min(0.05, (ts - lastAnimTs) / 1000) : 0.016;
        lastAnimTs = ts;
        const step = uiRotor.step(targetAirflowPct, dt);
        updateRotorVisual(targetAirflowPct, step.rpm, step.angleDeg);
        if (targetAirflowPct > 0 || step.rpm > 0.5) {
          animRaf = globalThis.requestAnimationFrame(tick);
        } else {
          animRaf = null;
          lastAnimTs = 0;
        }
      };
      animRaf = globalThis.requestAnimationFrame(tick);
    }

    function handleDspEvent(ev) {
      if (!ev) return;
      if (ev.type === 'telemetry') {
        targetAirflowPct = ev.airflowPct;
        airflowVal.textContent = `${ev.airflowPct}%`;
        snrBadge.textContent = `+${Math.round(ev.subSnrDb)} dB`;

        if (ev.bands) {
          barSub.style.width = `${Math.round(ev.bands.sub * 100)}%`;
          barMid.style.width = `${Math.round(ev.bands.mid * 100)}%`;
          barHf.style.width = `${Math.round(ev.bands.hf * 100)}%`;
        }
        const sign = ev.rolloffSubMidDb >= 0 ? '+' : '';
        rolloffNote.textContent = `Sub/Mid ${sign}${ev.rolloffSubMidDb.toFixed(0)} dB`;

        if (ev.vetoReason) {
          statusPill.dataset.veto = 'true';
          statusPill.textContent =
            ev.vetoReason === 'voiced'
              ? 'VOICE VETO'
              : ev.vetoReason === 'impulse'
              ? 'TAP VETO'
              : 'RUB VETO';
        } else {
          statusPill.dataset.veto = 'false';
          if (simTimer !== null) {
            statusPill.textContent = 'SIM WAVEFORM';
          } else if (busState.state === 'listening') {
            const khz = Math.round(currentRate / 100) / 10;
            statusPill.textContent = ev.active
              ? `FLOW +${Math.round(ev.subSnrDb)}dB`
              : `LIVE · ${khz}k`;
          }
        }

        if (ev.active) {
          durVal.textContent = `${ev.activeDurationMs} ms`;
          if (ev.liveKind) {
            heroBadge.textContent = ev.liveKind;
            heroBadge.dataset.kind = kindSlug(ev.liveKind);
            eventTag.textContent = 'FLOWING';
          }
        }

        if (typeof globalThis.requestAnimationFrame === 'function') {
          ensureRotorAnimLoop();
        } else {
          const st = uiRotor.step(targetAirflowPct, 0.011);
          updateRotorVisual(targetAirflowPct, st.rpm, st.angleDeg);
        }
      } else if (ev.type === 'puff' && ev.puff) {
        lastPuff = ev.puff;
        const p = ev.puff;
        heroBadge.textContent = p.kind;
        heroBadge.dataset.kind = kindSlug(p.kind);
        eventTag.textContent = `${p.intensityPct}%`;
        durVal.textContent = `${p.durationMs} ms`;
        heroMeta.textContent = `+${p.peakSnrDb.toFixed(1)} dB · imp ${p.impulse.toFixed(2)}`;
        srLive.textContent = `${p.kind}, ${p.intensityPct} percent, ${p.durationMs} milliseconds`;
      }
    }

    function stopSimulation() {
      if (simTimer !== null) {
        clearInterval(simTimer);
        simTimer = null;
      }
    }

    function runSimulation(mode) {
      stopSimulation();
      const simDsp = new BreathPuffDspCore({ sampleRate: 48000 });
      const wave = synthesizeBreathWaveform(mode === 'blow' ? 'blow' : 'puff', {
        sampleRate: 48000
      });

      const events = [];
      const blockSize = 512;
      for (let i = 0; i < wave.length; i += blockSize) {
        const chunk = wave.subarray(i, Math.min(wave.length, i + blockSize));
        const evs = simDsp.processSamples(chunk, i / 48000);
        for (let k = 0; k < evs.length; k++) events.push(evs[k]);
      }

      const playback = events.filter((e) => e.timeSec >= 0.18);
      if (!playback.length) return null;

      const totalPlayMs = mode === 'blow' ? 920 : 420;
      const stepMs = Math.max(10, Math.round(totalPlayMs / playback.length));
      let idx = 0;
      statusPill.dataset.veto = 'false';
      statusPill.textContent = mode === 'blow' ? 'SIM BLOW' : 'SIM PUFF';

      simTimer = setInterval(() => {
        if (idx >= playback.length) {
          stopSimulation();
          targetAirflowPct = 0;
          airflowVal.textContent = '0%';
          ensureRotorAnimLoop();
          updateStateUi(busState);
          return;
        }
        handleDspEvent(playback[idx++]);
      }, stepMs);

      return playback.find((e) => e.type === 'puff')?.puff || null;
    }

    function updateStateUi(st) {
      busState = st || { state: 'idle', sampleRate: 48000, error: '' };
      const armed = busState.state === 'listening' || busState.state === 'requesting';
      armBtn.dataset.armed = armed ? 'true' : 'false';
      armBtn.setAttribute('aria-pressed', armed ? 'true' : 'false');
      armText.textContent =
        busState.state === 'requesting'
          ? 'ARMING…'
          : busState.state === 'listening'
          ? 'LIVE'
          : 'ARM';

      if (simTimer !== null) return;
      statusPill.dataset.veto = 'false';
      if (busState.state === 'listening') {
        const khz = Math.round((busState.sampleRate || 48000) / 100) / 10;
        statusPill.textContent = `LIVE · ${khz}k`;
      } else if (busState.state === 'error') {
        statusPill.textContent = 'SIM ONLY';
        if (busState.error && !lastPuff) {
          heroMeta.textContent = busState.error;
        }
      } else {
        targetAirflowPct = 0;
        airflowVal.textContent = '0%';
        statusPill.textContent = 'READY · <12k passive';
      }
    }

    function handleArmClick() {
      if (!bus) return;
      if (busState.state === 'listening' || busState.state === 'requesting') {
        if (typeof bus.stopAll === 'function') bus.stopAll();
      } else if (typeof bus.requestArm === 'function') {
        bus.requestArm();
      }
    }

    if (bus) {
      if (typeof bus.subscribeAudio === 'function') {
        unsubAudio = bus.subscribeAudio(({ samples, sampleRate, timeSec }) => {
          if (simTimer !== null) return; // Keep sim waveform pure
          if (sampleRate && Math.abs(sampleRate - currentRate) > 10) {
            currentRate = sampleRate;
            dsp = new BreathPuffDspCore({ sampleRate });
          }
          const evs = dsp.processSamples(samples, timeSec);
          for (let i = 0; i < evs.length; i++) {
            handleDspEvent(evs[i]);
          }
        });
      }
      if (typeof bus.onStateChange === 'function') {
        unsubState = bus.onStateChange(updateStateUi);
      }
    }

    const onSecondaryClose = () => {
      stopSimulation();
      targetAirflowPct = 0;
      uiRotor.reset();
      if (animRaf !== null && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(animRaf);
        animRaf = null;
      }
      updateRotorVisual(0, 0, 0);
      airflowVal.textContent = '0%';
      dsp.reset();
    };

    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('lg-secondary-close', onSecondaryClose);
    }

    return {
      runSimulation,
      destroy() {
        stopSimulation();
        if (animRaf !== null && typeof globalThis.cancelAnimationFrame === 'function') {
          globalThis.cancelAnimationFrame(animRaf);
          animRaf = null;
        }
        if (unsubAudio) unsubAudio();
        if (unsubState) unsubState();
        if (typeof globalThis.removeEventListener === 'function') {
          globalThis.removeEventListener('lg-secondary-close', onSecondaryClose);
        }
      }
    };
  }

  function registerIntoLab(globalObj) {
    const g = globalObj || globalThis;
    const Lab = (g.LeftGrilleLab = g.LeftGrilleLab || { _pending: [] });
    const spec = {
      id: 'breath-puff',
      title: 'Grille Breath Puff',
      mount(cellEl, bus) {
        return mountBreathPuffCell(cellEl, bus);
      }
    };
    if (typeof Lab.registerCell === 'function') {
      Lab.registerCell(5, spec);
    } else {
      (Lab._pending = Lab._pending || []).push([5, spec]);
    }
    return spec;
  }

  return {
    BreathPuffDspCore,
    PinwheelPhysics,
    BiquadFilter,
    fftRadix2,
    computeDecimationFactor,
    synthesizeBreathWaveform,
    mountBreathPuffCell,
    registerIntoLab
  };
});
