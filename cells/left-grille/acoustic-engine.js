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
  const NUM_BANDS = 8;
  const MAX_REC_FRAMES = 1500;
  const CANONICAL_ANCHORS = [0.02, 0.18, 0.5, 0.75, 0.96];
  const POS_MIN_SCALES = [1.6, 1.6, 1.6, 1.6, 1.6, 1.6, 1.6, 1.6, 1.6, 4.5, 1.2];
  const LDA_MIN_STDS = [0.05, 0.45, 0.75, 0.05, 0.04, 0.05, 0.75, 0.75];

  const CALIBRATION_PROTOCOL = Object.freeze([
    Object.freeze({
      id: 'zone-0',
      kind: 'zone',
      targetY: 0.02,
      label: '1/14 · Rub VERY TOP (beside Esc)',
      short: 'Top 0%'
    }),
    Object.freeze({
      id: 'zone-20',
      kind: 'zone',
      targetY: 0.18,
      label: '2/14 · Rub UPPER-LEFT (beside ~ / Tab mics)',
      short: 'Mics 18%'
    }),
    Object.freeze({
      id: 'zone-50',
      kind: 'zone',
      targetY: 0.50,
      label: '3/14 · Rub MIDDLE (beside Caps Lock)',
      short: 'Mid 50%'
    }),
    Object.freeze({
      id: 'zone-75',
      kind: 'zone',
      targetY: 0.75,
      label: '4/14 · Rub LOWER-MID (beside Shift)',
      short: 'Low 75%'
    }),
    Object.freeze({
      id: 'zone-100',
      kind: 'zone',
      targetY: 0.96,
      label: '5/14 · Rub BOTTOM (beside Fn / Ctrl)',
      short: 'Btm 100%'
    }),
    Object.freeze({
      id: 'down-slow',
      kind: 'swipe',
      direction: 'down',
      startY: 0.04,
      endY: 0.96,
      label: '6/14 · Swipe DOWN Slowly (Esc → Fn, ~0.8s)',
      short: 'Slow ↓'
    }),
    Object.freeze({
      id: 'down-fast',
      kind: 'swipe',
      direction: 'down',
      startY: 0.04,
      endY: 0.96,
      label: '7/14 · Swipe DOWN Fast (Esc → Fn flick)',
      short: 'Fast ↓'
    }),
    Object.freeze({
      id: 'up-slow',
      kind: 'swipe',
      direction: 'up',
      startY: 0.96,
      endY: 0.04,
      label: '8/14 · Swipe UP Slowly (Fn → Esc, ~0.8s)',
      short: 'Slow ↑'
    }),
    Object.freeze({
      id: 'up-fast',
      kind: 'swipe',
      direction: 'up',
      startY: 0.96,
      endY: 0.04,
      label: '9/14 · Swipe UP Fast (Fn → Esc flick)',
      short: 'Fast ↑'
    }),
    Object.freeze({
      id: 'top-down',
      kind: 'swipe',
      direction: 'down',
      startY: 0.04,
      endY: 0.50,
      label: '10/14 · Top-Half Swipe DOWN (Esc → Caps)',
      short: 'Top ↓'
    }),
    Object.freeze({
      id: 'top-up',
      kind: 'swipe',
      direction: 'up',
      startY: 0.50,
      endY: 0.04,
      label: '11/14 · Top-Half Swipe UP (Caps → Esc)',
      short: 'Top ↑'
    }),
    Object.freeze({
      id: 'btm-down',
      kind: 'swipe',
      direction: 'down',
      startY: 0.50,
      endY: 0.96,
      label: '12/14 · Bottom-Half Swipe DOWN (Caps → Fn)',
      short: 'Btm ↓'
    }),
    Object.freeze({
      id: 'btm-up',
      kind: 'swipe',
      direction: 'up',
      startY: 0.96,
      endY: 0.50,
      label: '13/14 · Bottom-Half Swipe UP (Fn → Caps)',
      short: 'Btm ↑'
    }),
    Object.freeze({
      id: 'veto-keys',
      kind: 'negative',
      label: '14/14 · Tap ~, Caps & Shift keys once (Veto check)',
      short: 'Keys Veto'
    })
  ]);

  function round2(v) {
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
  }

  function round3(v) {
    return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
  }

  function meanOf(arr) {
    if (!arr.length) return 0;
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function varianceOf(arr, mu) {
    if (arr.length < 2) return 0;
    const m = mu !== undefined ? mu : meanOf(arr);
    let s = 0;
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i] - m;
      s += d * d;
    }
    return s / (arr.length - 1);
  }

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

  function allFiniteNumbers(arr, expectedLen, positiveOnly) {
    if (!Array.isArray(arr) || arr.length !== expectedLen) return false;
    for (let i = 0; i < expectedLen; i++) {
      if (!(i in arr)) return false;
      const v = arr[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
      if (positiveOnly && v <= 0) return false;
    }
    return true;
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

  function extractPosFeature(frame) {
    const out = new Array(11);
    const bands =
      frame &&
      frame.bandsDb &&
      typeof frame.bandsDb === 'object' &&
      typeof frame.bandsDb.length === 'number'
        ? frame.bandsDb
        : null;
    let bandMean = 0;
    for (let i = 0; i < NUM_BANDS; i++) {
      const v = bands && bands.length > i && Number.isFinite(bands[i]) ? bands[i] : 0;
      out[i] = v;
      bandMean += v;
    }
    bandMean /= NUM_BANDS;
    // Mean-center bandsDb[0..7] into a pressure-invariant 8-band spectral shape signature
    // (overall loudness is preserved explicitly in out[9] = fricSnrDb)
    for (let i = 0; i < NUM_BANDS; i++) {
      out[i] -= bandMean;
    }
    out[8] = frame && Number.isFinite(frame.specRatioDb) ? frame.specRatioDb : 0;
    out[9] = frame && Number.isFinite(frame.fricSnrDb) ? frame.fricSnrDb : 0;
    out[10] = frame && Number.isFinite(frame.occDb) ? frame.occDb : 0;
    return out;
  }

  function isFrameRecActive(f) {
    if (!f) return false;
    if (typeof f.active === 'boolean') return f.active;
    const snr = Number.isFinite(f.fricSnrDb) ? f.fricSnrDb : 0;
    const hf = Number.isFinite(f.hfSnrDb) ? f.hfSnrDb : 0;
    const occ = Number.isFinite(f.pinholeOcclusion) ? f.pinholeOcclusion : 0;
    const dop = Number.isFinite(f.dopplerSnrDb) ? f.dopplerSnrDb : 0;
    return snr > 4.5 || hf > 5.0 || occ > 0.22 || dop > 8.5;
  }

  function getDominantActiveFrames(frames) {
    if (!Array.isArray(frames) || !frames.length) return [];
    const activeIndices = [];
    for (let i = 0; i < frames.length; i++) {
      if (isFrameRecActive(frames[i])) activeIndices.push(i);
    }
    if (!activeIndices.length) {
      if (frames.length < 4) return [];
      const snrs = frames
        .map((f) => (f && Number.isFinite(f.fricSnrDb) ? f.fricSnrDb : -99))
        .sort((a, b) => a - b);
      const thr = snrs[Math.floor(snrs.length * 0.65)];
      if (thr <= 1.0) return [];
      return frames.filter((f) => f && Number.isFinite(f.fricSnrDb) && f.fricSnrDb >= thr);
    }

    const segments = [];
    let segStart = activeIndices[0];
    let segPrev = activeIndices[0];
    for (let k = 1; k < activeIndices.length; k++) {
      const idx = activeIndices[k];
      const dtGap =
        Number.isFinite(frames[idx].t) && Number.isFinite(frames[segPrev].t)
          ? frames[idx].t - frames[segPrev].t
          : (idx - segPrev) / 187.5;
      if (dtGap > 0.085 && idx - segPrev > 16) {
        segments.push([segStart, segPrev]);
        segStart = idx;
      }
      segPrev = idx;
    }
    segments.push([segStart, segPrev]);

    let bestSeg = segments[0];
    let bestScore = -1;
    for (let s = 0; s < segments.length; s++) {
      const [lo, hi] = segments[s];
      let energySum = 0;
      let count = 0;
      for (let i = lo; i <= hi; i++) {
        if (isFrameRecActive(frames[i])) {
          energySum += Math.max(1, frames[i].fricSnrDb || 0);
          count++;
        }
      }
      const score = count * (1 + energySum / Math.max(1, count) * 0.15);
      if (score > bestScore) {
        bestScore = score;
        bestSeg = segments[s];
      }
    }

    const out = [];
    for (let i = bestSeg[0]; i <= bestSeg[1]; i++) {
      if (isFrameRecActive(frames[i])) out.push(frames[i]);
    }
    return out;
  }

  function extractPercussiveBurstDurations(frames) {
    if (!Array.isArray(frames) || !frames.length) return [];
    const activeIndices = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (!f) continue;
      if (f.active === true || (Number.isFinite(f.fricSnrDb) && f.fricSnrDb > 4.5)) {
        activeIndices.push(i);
      }
    }
    if (!activeIndices.length) return [];
    const durations = [];
    let segStart = activeIndices[0];
    let segPrev = activeIndices[0];
    const pushSeg = (lo, hi) => {
      const t0 = frames[lo] && Number.isFinite(frames[lo].t) ? frames[lo].t : lo / 187.5;
      const t1 = frames[hi] && Number.isFinite(frames[hi].t) ? frames[hi].t : hi / 187.5;
      const dur = Math.max(0.005, t1 - t0 + 1 / 187.5);
      if (dur < 0.14) durations.push(dur);
    };
    for (let k = 1; k < activeIndices.length; k++) {
      const idx = activeIndices[k];
      const dtGap =
        Number.isFinite(frames[idx].t) && Number.isFinite(frames[segPrev].t)
          ? frames[idx].t - frames[segPrev].t
          : (idx - segPrev) / 187.5;
      if (dtGap > 0.032) {
        pushSeg(segStart, segPrev);
        segStart = idx;
      }
      segPrev = idx;
    }
    pushSeg(segStart, segPrev);
    return durations;
  }

  function fitRbfPositionModel(zoneEvents, swipeEvents) {
    const D = 11;
    const buckets = CANONICAL_ANCHORS.map((a) => ({
      anchorY: a,
      zoneVecs: [],
      swipeVecs: [],
      swipeYs: []
    }));

    function findOrAddBucket(targetY, maxDist, allowCreate) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < buckets.length; i++) {
        const d = Math.abs(buckets[i].anchorY - targetY);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0 && bestDist <= maxDist) {
        return buckets[bestIdx];
      }
      if (allowCreate) {
        const b = { anchorY: clamp(targetY, 0, 1), zoneVecs: [], swipeVecs: [], swipeYs: [] };
        buckets.push(b);
        return b;
      }
      return null;
    }

    for (let i = 0; i < zoneEvents.length; i++) {
      const ev = zoneEvents[i];
      if (!ev || !Number.isFinite(ev.targetY)) continue;
      const active = getDominantActiveFrames(ev.frames);
      if (!active.length) continue;
      // Keep steady high-SNR core of stationary zone rub so fade-in/out & Doppler tails don't inflate scale
      let peakSnr = -Infinity;
      for (let k = 0; k < active.length; k++) {
        if (Number.isFinite(active[k].fricSnrDb) && active[k].fricSnrDb > peakSnr) {
          peakSnr = active[k].fricSnrDb;
        }
      }
      const coreThr = Number.isFinite(peakSnr) ? Math.max(4.0, peakSnr - 7.5) : 2.5;
      const coreFrames = active.filter((f) => Number.isFinite(f.fricSnrDb) && f.fricSnrDb >= coreThr);
      const useFrames = coreFrames.length >= 4 ? coreFrames : active;

      const b = findOrAddBucket(ev.targetY, 0.06, true);
      if (b && b.zoneVecs.length === 0) {
        b.anchorY = clamp(ev.targetY, 0, 1);
      }
      for (let k = 0; k < useFrames.length; k++) {
        b.zoneVecs.push(extractPosFeature(useFrames[k]));
      }
    }

    for (let i = 0; i < swipeEvents.length; i++) {
      const ev = swipeEvents[i];
      if (!ev || !Number.isFinite(ev.startY) || !Number.isFinite(ev.endY)) continue;
      const active = getDominantActiveFrames(ev.frames);
      const M = active.length;
      if (M < 4) continue;

      const sliceCount = Math.max(2, Math.floor(M * 0.2));
      const midLo = Math.floor(M * 0.4);
      const midHi = Math.max(midLo + 1, Math.ceil(M * 0.6));
      const slices = [
        { frames: active.slice(0, sliceCount), y: lerp(ev.startY, ev.endY, 0.1) },
        { frames: active.slice(midLo, midHi), y: lerp(ev.startY, ev.endY, 0.5) },
        { frames: active.slice(M - sliceCount), y: lerp(ev.startY, ev.endY, 0.9) }
      ];

      for (let s = 0; s < slices.length; s++) {
        const sl = slices[s];
        const b = findOrAddBucket(sl.y, 0.18, false);
        if (!b) continue;
        for (let k = 0; k < sl.frames.length; k++) {
          b.swipeVecs.push(extractPosFeature(sl.frames[k]));
          b.swipeYs.push(sl.y);
        }
      }
    }

    const prototypes = [];
    const absDevsByDim = Array.from({ length: D }, () => []);

    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      const hasZone = b.zoneVecs.length >= 2;
      const hasSwipe = b.swipeVecs.length >= 2;
      if (!hasZone && !hasSwipe) continue;

      const vec = new Array(D).fill(0);
      let anchorY = b.anchorY;
      const samplesForProto = hasZone ? b.zoneVecs : b.swipeVecs;
      if (!hasZone) {
        anchorY = clamp(meanOf(b.swipeYs), 0.02, 0.96);
      }

      for (let d = 0; d < D; d++) {
        const col = samplesForProto.map((v) => v[d]);
        const med = median(col);
        vec[d] = med;
        if (samplesForProto.length >= 3) {
          for (let k = 0; k < col.length; k++) {
            absDevsByDim[d].push(Math.abs(col[k] - med));
          }
        }
      }

      prototypes.push({
        anchorY: round3(anchorY),
        vector: vec.map(round3)
      });
    }

    if (prototypes.length < 2) return null;
    prototypes.sort((a, b) => a.anchorY - b.anchorY);

    const scale = new Array(D);
    for (let d = 0; d < D; d++) {
      const madStd = absDevsByDim[d].length >= 4 ? 1.4826 * median(absDevsByDim[d]) : 0;
      scale[d] = round3(Math.max(POS_MIN_SCALES[d], madStd));
    }

    const adjDist2 = [];
    for (let i = 1; i < prototypes.length; i++) {
      const a = prototypes[i - 1].vector;
      const b = prototypes[i].vector;
      let d2 = 0;
      for (let d = 0; d < D; d++) {
        const z = (a[d] - b[d]) / scale[d];
        d2 += z * z;
      }
      adjDist2.push(d2 / D);
    }
    const medAdj = adjDist2.length ? median(adjDist2) : 2.0;
    const temp = round3(clamp(medAdj * 0.18, 0.18, 2.0));

    return {
      prototypes,
      scale,
      temp
    };
  }

  function predictRbfY(frameOrVec, rbfModel, opts) {
    if (!rbfModel || !Array.isArray(rbfModel.prototypes) || rbfModel.prototypes.length < 2) {
      return { y: 0.5, maxWeight: 0, weights: [] };
    }
    const txActive = !opts || opts.txActive !== false;
    const x = Array.isArray(frameOrVec) ? frameOrVec : extractPosFeature(frameOrVec);
    const protos = rbfModel.prototypes;
    const scale = rbfModel.scale;
    const D = scale.length;
    const denom = 2 * Math.max(0.05, rbfModel.temp || 0.45);

    const logits = new Array(protos.length);
    let maxLogit = -Infinity;
    for (let i = 0; i < protos.length; i++) {
      const pv = protos[i].vector;
      let d2 = 0;
      let usedDims = 0;
      for (let d = 0; d < D; d++) {
        // Mask sonar-only occDb (index 10) when operating in passive (txEnabled === false) mode
        if (!txActive && d === 10) continue;
        const s = Number.isFinite(scale[d]) && scale[d] > 1e-4 ? scale[d] : 1;
        const xv = Number.isFinite(x[d]) ? x[d] : 0;
        const pvd = pv && Number.isFinite(pv[d]) ? pv[d] : 0;
        const z = (xv - pvd) / s;
        d2 += z * z;
        usedDims++;
      }
      const l = -(d2 / Math.max(1, usedDims)) / denom;
      logits[i] = l;
      if (l > maxLogit) maxLogit = l;
    }

    const weights = new Array(protos.length);
    let wSum = 0;
    for (let i = 0; i < protos.length; i++) {
      const w = Math.exp(Math.max(-60, logits[i] - maxLogit));
      weights[i] = w;
      wSum += w;
    }

    let yHat = 0;
    let maxWeight = 0;
    for (let i = 0; i < protos.length; i++) {
      const wn = wSum > 0 ? weights[i] / wSum : 1 / protos.length;
      weights[i] = wn;
      yHat += wn * protos[i].anchorY;
      if (wn > maxWeight) maxWeight = wn;
    }
    return { y: clamp(yHat, 0, 1), maxWeight, weights };
  }

  function extractStrokeFeatures(frames, rbfModel, opts) {
    const M = Array.isArray(frames) ? frames.length : 0;
    if (M < 2) return [0, 0, 0, 0, 0, 0, 0, 0];

    const k1 = Math.max(1, Math.floor(M / 3));
    const k2 = Math.min(M - 1, Math.max(k1, Math.floor((2 * M) / 3)));
    const early = frames.slice(0, k1);
    const late = frames.slice(k2);

    // 1. deltaY_rbf (late - early; positive = DOWN, negative = UP)
    let deltaYRbf = 0;
    if (rbfModel && Array.isArray(rbfModel.prototypes) && rbfModel.prototypes.length >= 2) {
      const earlyY = median(early.map((f) => predictRbfY(f, rbfModel, opts).y));
      const lateY = median(late.map((f) => predictRbfY(f, rbfModel, opts).y));
      deltaYRbf = lateY - earlyY;
    }

    // 2. thirdDiffSpec
    const thirdDiffSpec =
      median(late.map((f) => (f && Number.isFinite(f.specRatioDb) ? f.specRatioDb : 0))) -
      median(early.map((f) => (f && Number.isFinite(f.specRatioDb) ? f.specRatioDb : 0)));

    // 3. thirdDiffSnr
    const thirdDiffSnr =
      median(late.map((f) => (f && Number.isFinite(f.fricSnrDb) ? f.fricSnrDb : 0))) -
      median(early.map((f) => (f && Number.isFinite(f.fricSnrDb) ? f.fricSnrDb : 0)));

    // 4. peakPosNorm - 0.5 (smoothed 3-frame peak timing of fricSnrDb)
    let peakIdx = 0;
    let peakVal = -Infinity;
    for (let i = 0; i < M; i++) {
      let s = 0;
      let c = 0;
      for (let o = -1; o <= 1; o++) {
        const idx = i + o;
        if (idx >= 0 && idx < M && frames[idx] && Number.isFinite(frames[idx].fricSnrDb)) {
          s += frames[idx].fricSnrDb;
          c++;
        }
      }
      const v = c > 0 ? s / c : -99;
      if (v > peakVal) {
        peakVal = v;
        peakIdx = i;
      }
    }
    const peakPosCentered = peakIdx / Math.max(1, M - 1) - 0.5;

    // 5. occTimingSkew (occlusion-weighted temporal center - 0.5)
    let occTimeSum = 0;
    let occWeightSum = 0;
    for (let i = 0; i < M; i++) {
      const f = frames[i];
      if (!f) continue;
      const po = Number.isFinite(f.pinholeOcclusion) ? Math.max(0, f.pinholeOcclusion) : 0;
      const od = Number.isFinite(f.occDb) ? Math.max(0, -f.occDb - 0.5) * 0.12 : 0;
      const w = po + od;
      if (w > 0) {
        occTimeSum += w * (i / Math.max(1, M - 1));
        occWeightSum += w;
      }
    }
    const occTimingSkew = occWeightSum > 1e-4 ? occTimeSum / occWeightSum - 0.5 : 0;

    // 6. meanRawDopplerAsym (SNR-weighted raw Doppler asymmetry)
    let dopSum = 0;
    let dopW = 0;
    for (let i = 0; i < M; i++) {
      const f = frames[i];
      if (!f) continue;
      const asym = Number.isFinite(f.rawDopplerAsym) ? f.rawDopplerAsym : 0;
      const dSnr = Number.isFinite(f.dopplerSnrDb) ? f.dopplerSnrDb : 0;
      const w = 0.25 + clamp((dSnr - 3.0) / 10.0, 0, 1.5);
      dopSum += w * asym;
      dopW += w;
    }
    const meanRawDopplerAsym = dopW > 0 ? dopSum / dopW : 0;

    // 7. earlyVsLateHf (bands 5..7: 5.6 - 15.2 kHz, late minus early)
    const hfMean = (f) => {
      if (!f) return 0;
      const b =
        f.bandsDb && typeof f.bandsDb === 'object' && typeof f.bandsDb.length === 'number'
          ? f.bandsDb
          : null;
      if (b && b.length >= 8) {
        let sum = 0;
        let cnt = 0;
        for (let k = 5; k <= 7; k++) {
          if (Number.isFinite(b[k])) {
            sum += b[k];
            cnt++;
          }
        }
        if (cnt > 0) return sum / cnt;
      }
      return Number.isFinite(f.hfSnrDb) ? f.hfSnrDb : 0;
    };
    const earlyVsLateHf = median(late.map(hfMean)) - median(early.map(hfMean));

    // 8. earlyVsLateSub (bands 0..1: <180 Hz & 375-750 Hz, late minus early)
    const subMean = (f) => {
      if (!f) return 0;
      const b =
        f.bandsDb && typeof f.bandsDb === 'object' && typeof f.bandsDb.length === 'number'
          ? f.bandsDb
          : null;
      if (!b || b.length < 2) return 0;
      const b0 = Number.isFinite(b[0]) ? b[0] : null;
      const b1 = Number.isFinite(b[1]) ? b[1] : null;
      if (b0 !== null && b1 !== null) return 0.65 * b0 + 0.35 * b1;
      if (b0 !== null) return b0;
      if (b1 !== null) return b1;
      return 0;
    };
    const earlyVsLateSub = median(late.map(subMean)) - median(early.map(subMean));

    const out = [
      deltaYRbf,
      thirdDiffSpec,
      thirdDiffSnr,
      peakPosCentered,
      occTimingSkew,
      meanRawDopplerAsym,
      earlyVsLateHf,
      earlyVsLateSub
    ];
    for (let i = 0; i < out.length; i++) {
      if (!Number.isFinite(out[i])) out[i] = 0;
    }
    return out;
  }

  function solveLinearSystem(A, b) {
    const n = b.length;
    const M = new Array(n);
    const rhs = b.slice();
    for (let i = 0; i < n; i++) M[i] = A[i].slice();

    for (let col = 0; col < n; col++) {
      let piv = col;
      let maxAbs = Math.abs(M[col][col]);
      for (let r = col + 1; r < n; r++) {
        const a = Math.abs(M[r][col]);
        if (a > maxAbs) {
          maxAbs = a;
          piv = r;
        }
      }
      if (maxAbs < 1e-12) continue;
      if (piv !== col) {
        const tmp = M[col];
        M[col] = M[piv];
        M[piv] = tmp;
        const tr = rhs[col];
        rhs[col] = rhs[piv];
        rhs[piv] = tr;
      }
      const diag = M[col][col];
      for (let r = col + 1; r < n; r++) {
        const factor = M[r][col] / diag;
        if (factor === 0) continue;
        M[r][col] = 0;
        for (let c = col + 1; c < n; c++) {
          M[r][c] -= factor * M[col][c];
        }
        rhs[r] -= factor * rhs[col];
      }
    }

    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = rhs[r];
      for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
      x[r] = Math.abs(M[r][r]) > 1e-12 ? s / M[r][r] : 0;
      if (!Number.isFinite(x[r])) return b.slice();
    }
    return x;
  }

  function fitShrinkageLda(upVecs, downVecs, lambda = 0.35) {
    const D = 8;
    const nUp = upVecs.length;
    const nDown = downVecs.length;
    if (nUp < 1 || nDown < 1) return null;
    const all = upVecs.concat(downVecs);
    const featMean = new Array(D).fill(0);
    const featStd = new Array(D).fill(1);

    for (let d = 0; d < D; d++) {
      const col = all.map((v) => (v && Number.isFinite(v[d]) ? v[d] : 0));
      const mu = meanOf(col);
      featMean[d] = Number.isFinite(mu) ? mu : 0;
      const sd = Math.sqrt(varianceOf(col, featMean[d]));
      featStd[d] = Math.max(LDA_MIN_STDS[d], Number.isFinite(sd) ? sd : 0);
    }

    const stdUp = upVecs.map((v) =>
      Array.from({ length: D }, (_, d) => ((v && Number.isFinite(v[d]) ? v[d] : 0) - featMean[d]) / featStd[d])
    );
    const stdDown = downVecs.map((v) =>
      Array.from({ length: D }, (_, d) => ((v && Number.isFinite(v[d]) ? v[d] : 0) - featMean[d]) / featStd[d])
    );

    const muUp = new Array(D).fill(0);
    const muDown = new Array(D).fill(0);
    for (let i = 0; i < nUp; i++) {
      for (let d = 0; d < D; d++) muUp[d] += stdUp[i][d] / nUp;
    }
    for (let i = 0; i < nDown; i++) {
      for (let d = 0; d < D; d++) muDown[d] += stdDown[i][d] / nDown;
    }

    const diff = new Array(D);
    const mid = new Array(D);
    for (let d = 0; d < D; d++) {
      diff[d] = muUp[d] - muDown[d];
      mid[d] = 0.5 * (muUp[d] + muDown[d]);
    }

    const Sw = Array.from({ length: D }, () => new Array(D).fill(0));
    const dof = Math.max(1, nUp + nDown - 2);
    for (let k = 0; k < nUp; k++) {
      for (let i = 0; i < D; i++) {
        const di = stdUp[k][i] - muUp[i];
        for (let j = 0; j < D; j++) {
          Sw[i][j] += (di * (stdUp[k][j] - muUp[j])) / dof;
        }
      }
    }
    for (let k = 0; k < nDown; k++) {
      for (let i = 0; i < D; i++) {
        const di = stdDown[k][i] - muDown[i];
        for (let j = 0; j < D; j++) {
          Sw[i][j] += (di * (stdDown[k][j] - muDown[j])) / dof;
        }
      }
    }

    let trace = 0;
    for (let d = 0; d < D; d++) trace += Sw[d][d];
    const avgVar = Math.max(0.25, trace / D);

    const Sreg = Array.from({ length: D }, (_, i) =>
      Array.from({ length: D }, (__, j) => {
        const base = (1 - lambda) * Sw[i][j];
        return i === j ? base + lambda * avgVar + 1e-4 : base;
      })
    );

    const rawW = solveLinearSystem(Sreg, diff);
    let sep = 0;
    for (let d = 0; d < D; d++) sep += rawW[d] * diff[d];
    const halfSep = Math.max(0.35, 0.5 * Math.abs(sep));
    const sign = sep >= 0 ? 1 : -1;
    const weights = new Array(D);
    let bias = 0;
    for (let d = 0; d < D; d++) {
      weights[d] = (sign * rawW[d]) / halfSep;
      bias -= weights[d] * mid[d];
    }

    return {
      weights: weights.map(round3),
      bias: round3(bias),
      featMean: featMean.map(round3),
      featStd: featStd.map(round3),
      lambda
    };
  }

  function scoreShrinkageLda(vec8, ldaModel, opts) {
    if (!ldaModel || !Array.isArray(ldaModel.weights) || ldaModel.weights.length !== 8) return 0;
    const txActive = !opts || opts.txActive !== false;
    let score = Number.isFinite(ldaModel.bias) ? ldaModel.bias : 0;
    for (let d = 0; d < 8; d++) {
      // Mask sonar-only standardized terms (index 4: occTimingSkew, index 5: meanRawDopplerAsym) in passive mode
      if (!txActive && (d === 4 || d === 5)) continue;
      const w = Number.isFinite(ldaModel.weights[d]) ? ldaModel.weights[d] : 0;
      const s =
        ldaModel.featStd && Number.isFinite(ldaModel.featStd[d]) && ldaModel.featStd[d] > 1e-4
          ? ldaModel.featStd[d]
          : 1;
      const m = ldaModel.featMean && Number.isFinite(ldaModel.featMean[d]) ? ldaModel.featMean[d] : 0;
      const v = vec8 && Number.isFinite(vec8[d]) ? vec8[d] : 0;
      const z = (v - m) / s;
      score += w * z;
    }
    return Number.isFinite(score) ? score : 0;
  }

  function fitEmpiricalCalibration(events) {
    const list = Array.isArray(events) ? events.filter(Boolean) : [];
    const zoneEvents = [];
    const swipeEvents = [];
    const negativeEvents = [];

    for (let i = 0; i < list.length; i++) {
      const ev = list[i];
      if (ev.kind === 'zone') {
        if (getDominantActiveFrames(ev.frames).length >= 2) {
          zoneEvents.push(ev);
        }
      } else if (ev.kind === 'negative') {
        negativeEvents.push(ev);
      } else if (ev.kind === 'swipe' && (ev.direction === 'up' || ev.direction === 'down')) {
        const act = getDominantActiveFrames(ev.frames);
        if (act.length >= 3) {
          swipeEvents.push(Object.assign({}, ev, { _activeFrames: act }));
        }
      }
    }

    const upSwipes = swipeEvents.filter((e) => e.direction === 'up');
    const downSwipes = swipeEvents.filter((e) => e.direction === 'down');

    if (swipeEvents.length < 2 || upSwipes.length < 1 || downSwipes.length < 1) {
      return {
        ok: false,
        reason: 'insufficient_swipes',
        eventCount: list.length,
        swipeCount: swipeEvents.length,
        zoneCount: zoneEvents.length,
        negativeCount: negativeEvents.length,
        looAccuracyPct: 0,
        inSampleAccuracyPct: 0,
        looFolds: 0,
        inSampleOnly: true,
        dPrime: 0,
        model: null
      };
    }

    // 1. Fit 5-Zone Non-Monotonic Gaussian RBF Position Model
    const rbf = fitRbfPositionModel(zoneEvents, swipeEvents);

    // 2. Fit Full Regularized Shrinkage Fisher LDA (lambda = 0.35)
    const upVecs = upSwipes.map((ev) => extractStrokeFeatures(ev._activeFrames, rbf));
    const downVecs = downSwipes.map((ev) => extractStrokeFeatures(ev._activeFrames, rbf));
    const lda = fitShrinkageLda(upVecs, downVecs, 0.35);

    // 3. Honest Balanced Leave-One-Out Cross-Validation (only when >= 2 UP and >= 2 DOWN swipes)
    const canRunBalancedLoo = upSwipes.length >= 2 && downSwipes.length >= 2;
    let looCorrect = 0;
    let looTotal = 0;
    const looUpScores = [];
    const looDownScores = [];

    if (canRunBalancedLoo) {
      for (let i = 0; i < swipeEvents.length; i++) {
        const held = swipeEvents[i];
        const trainSwipes = swipeEvents.filter((_, idx) => idx !== i);
        const trainUp = trainSwipes.filter((e) => e.direction === 'up');
        const trainDown = trainSwipes.filter((e) => e.direction === 'down');
        if (trainUp.length < 1 || trainDown.length < 1) continue;

        const foldRbf = fitRbfPositionModel(zoneEvents, trainSwipes);
        const foldUpVecs = trainUp.map((ev) => extractStrokeFeatures(ev._activeFrames, foldRbf));
        const foldDownVecs = trainDown.map((ev) => extractStrokeFeatures(ev._activeFrames, foldRbf));
        const foldLda = fitShrinkageLda(foldUpVecs, foldDownVecs, 0.35);
        if (!foldLda) continue;

        const testVec = extractStrokeFeatures(held._activeFrames, foldRbf);
        const sc = scoreShrinkageLda(testVec, foldLda);
        const predDir = sc >= 0 ? 'up' : 'down';
        looTotal++;
        if (predDir === held.direction) looCorrect++;
        if (held.direction === 'up') looUpScores.push(sc);
        else looDownScores.push(sc);
      }
    }

    const inSampleUpScores = upVecs.map((v) => scoreShrinkageLda(v, lda));
    const inSampleDownScores = downVecs.map((v) => scoreShrinkageLda(v, lda));
    const inSampleCorrect =
      inSampleUpScores.filter((s) => s >= 0).length +
      inSampleDownScores.filter((s) => s < 0).length;
    const inSampleAccuracyPct =
      Math.round((inSampleCorrect / Math.max(1, swipeEvents.length)) * 1000) / 10;

    const inSampleOnly = looTotal === 0;
    const evalUpScores =
      !inSampleOnly && looUpScores.length >= 2 && looDownScores.length >= 2
        ? looUpScores
        : inSampleUpScores;
    const evalDownScores =
      !inSampleOnly && looUpScores.length >= 2 && looDownScores.length >= 2
        ? looDownScores
        : inSampleDownScores;

    const looAccuracyPct = !inSampleOnly
      ? Math.round((looCorrect / looTotal) * 1000) / 10
      : inSampleAccuracyPct;

    const muUpSc = meanOf(evalUpScores);
    const muDownSc = meanOf(evalDownScores);
    const varUpSc = varianceOf(evalUpScores, muUpSc);
    const varDownSc = varianceOf(evalDownScores, muDownSc);
    const pooledSd = Math.sqrt(Math.max(0.04, 0.5 * (varUpSc + varDownSc)));
    const dPrime = round2((muUpSc - muDownSc) / pooledSd);

    // 4. Empirical Speed Scale & Shortest Real Swipe Duration
    const speedRatios = [];
    let minSwipeDurSec = 0.25;
    for (let i = 0; i < swipeEvents.length; i++) {
      const ev = swipeEvents[i];
      const act = ev._activeFrames;
      const t0 = Number.isFinite(act[0].t) ? act[0].t : 0;
      const t1 = Number.isFinite(act[act.length - 1].t) ? act[act.length - 1].t : (act.length - 1) / 187.5;
      const activeDur = Math.max(0.04, t1 - t0);
      if (activeDur < minSwipeDurSec) minSwipeDurSec = activeDur;

      if (Number.isFinite(ev.startY) && Number.isFinite(ev.endY) && Math.abs(ev.endY - ev.startY) >= 0.15) {
        const trueSpanCm = Math.abs(ev.endY - ev.startY) * DEFAULT_GRILLE_CM;
        const trueSpeed = trueSpanCm / activeDur;
        let estSpanCm = trueSpanCm;
        if (rbf) {
          const headN = Math.max(2, Math.floor(act.length * 0.22));
          const y0 = median(act.slice(0, headN).map((f) => predictRbfY(f, rbf).y));
          const y1 = median(act.slice(act.length - headN).map((f) => predictRbfY(f, rbf).y));
          estSpanCm = Math.max(1.5, Math.abs(y1 - y0) * DEFAULT_GRILLE_CM);
        }
        const estSpeed = estSpanCm / activeDur;
        if (estSpeed > 0.5) {
          speedRatios.push(trueSpeed / estSpeed);
        }
      }
    }
    const speedScale = speedRatios.length ? round3(clamp(median(speedRatios), 0.55, 1.85)) : 1.0;

    // 5. Key-Click Veto Margin (`minStrokeDurationSec`) from negative events (`veto-keys`)
    let minStrokeDurationSec = 0.068;
    const keyBursts = [];
    for (let i = 0; i < negativeEvents.length; i++) {
      const durs = extractPercussiveBurstDurations(negativeEvents[i].frames);
      for (let k = 0; k < durs.length; k++) keyBursts.push(durs[k]);
    }
    if (keyBursts.length > 0) {
      const maxKeyDur = Math.max(...keyBursts);
      const upperSafe = Math.max(0.068, Math.min(0.14, minSwipeDurSec * 0.72));
      minStrokeDurationSec = round3(clamp(maxKeyDur + 0.014, 0.068, upperSafe));
    }

    // 6. Derive legacy polarity & anchor summary for UI/fallback display compatibility
    let polarity = 1;
    const upSpecDiff = meanOf(upVecs.map((v) => v[1] + v[2]));
    const downSpecDiff = meanOf(downVecs.map((v) => v[1] + v[2]));
    const upDoppler = meanOf(upVecs.map((v) => v[5]));
    const downDoppler = meanOf(downVecs.map((v) => v[5]));
    if (Math.abs(upSpecDiff - downSpecDiff) > 1.5) {
      polarity = upSpecDiff >= downSpecDiff ? 1 : -1;
    } else if (Math.abs(upDoppler - downDoppler) > 0.1) {
      polarity = upDoppler >= downDoppler ? 1 : -1;
    }

    let legacyCalibration = null;
    if (rbf && rbf.prototypes.length >= 2) {
      const topProto = rbf.prototypes[0].vector;
      const btmProto = rbf.prototypes[rbf.prototypes.length - 1].vector;
      if (topProto[8] > btmProto[8] + 1.0 || topProto[9] > btmProto[9] + 2.0) {
        legacyCalibration = {
          specTopDb: round2(Math.max(topProto[8], btmProto[8] + 2.5)),
          specBottomDb: round2(btmProto[8]),
          snrTopDb: round2(Math.max(topProto[9], btmProto[9] + 5.0)),
          snrBottomDb: round2(Math.max(4, btmProto[9]))
        };
      }
    }

    const model = {
      version: 2,
      fittedAt: typeof Date !== 'undefined' ? Date.now() : 0,
      polarity,
      rbf,
      lda,
      speedScale,
      minStrokeDurationSec,
      legacyCalibration,
      stats: {
        eventCount: list.length,
        swipeCount: swipeEvents.length,
        zoneCount: zoneEvents.length,
        negativeCount: negativeEvents.length,
        looAccuracyPct,
        inSampleAccuracyPct,
        dPrime,
        looFolds: looTotal,
        inSampleOnly
      }
    };

    return {
      ok: true,
      eventCount: list.length,
      swipeCount: swipeEvents.length,
      zoneCount: zoneEvents.length,
      negativeCount: negativeEvents.length,
      looAccuracyPct,
      inSampleAccuracyPct,
      dPrime,
      looFolds: looTotal,
      inSampleOnly,
      model
    };
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
      this.empiricalModel = null;
      if (options.calibration) {
        this.setCalibration(options.calibration);
      }
      if (options.empiricalModel) {
        const hasExplicitPolarity =
          typeof options.polarity === 'number' && Number.isFinite(options.polarity);
        this.setEmpiricalModel(options.empiricalModel, { syncPolarity: !hasExplicitPolarity });
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
      this.binHz = binHz;
      const maxPassiveBin =
        this.numCarriers > 0
          ? Math.min(nyquistBin, this.carrierMultiples[0] - 4, Math.round(15200 / binHz))
          : Math.min(nyquistBin, Math.max(6, Math.floor((this.effectiveRate * 0.44) / binHz)));
      this.midStartBin = Math.max(1, Math.min(maxPassiveBin - 3, Math.round(950 / binHz)));
      this.midEndBin = Math.max(
        this.midStartBin + 1,
        Math.min(maxPassiveBin - 2, Math.round(Math.min(2700, this.effectiveRate * 0.14) / binHz))
      );
      this.hf1EndBin = Math.max(
        this.midEndBin + 1,
        Math.min(maxPassiveBin - 1, Math.round(Math.min(5600, this.effectiveRate * 0.26) / binHz))
      );
      this.hf2EndBin = Math.max(this.hf1EndBin + 1, maxPassiveBin);

      // Anchor spectralFlatness & tonalCrest at ~1150 Hz across all sample rates:
      // clears the Hann mainlobe of <= 750 Hz finger-pad pneumatic thud (exact zero at bin 4 / 1500 Hz
      // for 48 kHz) while catching 1250..2000 Hz vocal F2 harmonics across 8k..192k!
      this.flatStartBin = Math.min(
        this.hf2EndBin - 1,
        Math.max(this.midStartBin, Math.ceil(1150 / this.binHz))
      );

      // Partition passive bins 1..hf2EndBin into 7 log-spaced upper bands (Band 0 is <180 Hz pneuEnergy)
      const maxBandHz = this.hf2EndBin * binHz;
      const bandScale = Math.min(1, maxBandHz / 15200);
      const bandTargetEdgesHz = [900, 2000, 3500, 5400, 8000, 11400, 15400];
      this.bandRanges = [];
      let prevHi = 0;
      for (let j = 0; j < 7; j++) {
        const remaining = 6 - j;
        const lo = Math.min(this.hf2EndBin - remaining, prevHi + 1);
        const rawHi =
          j === 6
            ? this.hf2EndBin
            : Math.round((bandTargetEdgesHz[j] * bandScale) / binHz);
        const hi = Math.max(lo, Math.min(this.hf2EndBin - remaining, rawHi));
        this.bandRanges.push([lo, hi]);
        prevHi = hi;
      }

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
      this.binPow = new Float64Array(QUANTUM >> 1);
      this.currBandsDb = new Float64Array(NUM_BANDS);
      this.ambientBandsDb = new Float64Array(NUM_BANDS);
      this.ambientBandsDb.fill(-82);
      this.relBandsDb = new Float64Array(NUM_BANDS);
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
      this.iqCount = 0;
      this.txActiveFrames = 0;
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
      this.recCapture = null;
    }

    _resetSonarState() {
      this.iqWriteIdx = 0;
      this.iqCount = 0;
      this.txActiveFrames = 0;
      this.carrierBaseline.fill(0);
      this.prevDynI.fill(0);
      this.prevDynQ.fill(0);
      this.bgI.fill(0);
      this.bgQ.fill(0);
      for (let k = 0; k < this.numCarriers; k++) {
        this.iqHistI[k].fill(0);
        this.iqHistQ[k].fill(0);
      }
      this.dopplerPower.fill(0);
      this.ambientDopplerPower = 1e-10;
      this._lastDoppler = null;
    }

    setTxEnabled(enabled, gain) {
      const wasTx = this.txEnabled;
      this.txEnabled = Boolean(enabled) && this.canUseSonar;
      if (Number.isFinite(gain) && gain >= 0) {
        this.txGain = clamp(gain, 0, 0.25);
      }
      if (wasTx !== this.txEnabled) {
        this._resetSonarState();
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

    setEmpiricalModel(model, opts) {
      if (!model || typeof model !== 'object' || Array.isArray(model)) {
        this.empiricalModel = null;
        return;
      }
      let cleanRbf = null;
      if (
        model.rbf &&
        Array.isArray(model.rbf.prototypes) &&
        model.rbf.prototypes.length >= 2 &&
        allFiniteNumbers(model.rbf.scale, 11, true)
      ) {
        const protos = [];
        for (let i = 0; i < model.rbf.prototypes.length; i++) {
          const p = model.rbf.prototypes[i];
          if (
            p &&
            typeof p === 'object' &&
            !Array.isArray(p) &&
            typeof p.anchorY === 'number' &&
            Number.isFinite(p.anchorY) &&
            allFiniteNumbers(p.vector, 11, false)
          ) {
            protos.push({ anchorY: clamp(p.anchorY, 0, 1), vector: p.vector.slice() });
          }
        }
        if (protos.length >= 2) {
          cleanRbf = {
            prototypes: protos,
            scale: model.rbf.scale.slice(),
            temp: Number.isFinite(model.rbf.temp) ? clamp(model.rbf.temp, 0.08, 4.0) : 0.45
          };
        }
      }

      let cleanLda = null;
      if (
        model.lda &&
        allFiniteNumbers(model.lda.weights, 8, false) &&
        allFiniteNumbers(model.lda.featMean, 8, false) &&
        allFiniteNumbers(model.lda.featStd, 8, true) &&
        typeof model.lda.bias === 'number' &&
        Number.isFinite(model.lda.bias)
      ) {
        cleanLda = {
          weights: model.lda.weights.slice(),
          bias: model.lda.bias,
          featMean: model.lda.featMean.slice(),
          featStd: model.lda.featStd.slice(),
          lambda: Number.isFinite(model.lda.lambda) ? model.lda.lambda : 0.35
        };
      }

      if (!cleanRbf && !cleanLda) {
        this.empiricalModel = null;
        return;
      }

      const pol = model.polarity === -1 ? -1 : 1;
      if (opts && opts.syncPolarity === true) {
        this.polarity = pol;
      }
      if (model.legacyCalibration && typeof model.legacyCalibration === 'object' && !Array.isArray(model.legacyCalibration)) {
        const leg = {};
        for (const k of ['specBottomDb', 'specTopDb', 'snrBottomDb', 'snrTopDb']) {
          if (Number.isFinite(model.legacyCalibration[k])) leg[k] = model.legacyCalibration[k];
        }
        this.setCalibration(leg);
      }

      this.empiricalModel = {
        version: Number.isFinite(model.version) && model.version > 0 ? Math.floor(model.version) : 2,
        polarity: pol,
        rbf: cleanRbf,
        lda: cleanLda,
        speedScale: Number.isFinite(model.speedScale) ? clamp(model.speedScale, 0.55, 1.85) : 1.0,
        minStrokeDurationSec: Number.isFinite(model.minStrokeDurationSec)
          ? clamp(model.minStrokeDurationSec, 0.055, 0.16)
          : 0.068
      };
    }

    resetCalibration() {
      this.polarity = 1;
      this.calibration = {
        specBottomDb: -8.2,
        specTopDb: 3.8,
        snrBottomDb: 7.5,
        snrTopDb: 29.0
      };
      this.empiricalModel = null;
      this.calibrationCapture = null;
      this.recCapture = null;
    }

    beginRecordEvent(stepMeta) {
      this.recCapture = {
        stepMeta: stepMeta && typeof stepMeta === 'object' ? Object.assign({}, stepMeta) : {},
        startTimeSec: this.framesProcessed * this.dt,
        frameCounter: 0,
        frames: []
      };
    }

    cancelRecordEvent() {
      this.recCapture = null;
    }

    endRecordEvent() {
      const rec = this.recCapture;
      this.recCapture = null;
      if (!rec) {
        return {
          ok: false,
          reason: 'no_active_recording',
          frameCount: 0,
          activeFrameCount: 0,
          peakSnrDb: 0,
          eventRecord: null
        };
      }
      const frames = rec.frames;
      const frameCount = frames.length;
      let activeFrameCount = 0;
      let peakSnrDb = -Infinity;
      for (let i = 0; i < frameCount; i++) {
        const f = frames[i];
        if (f.active) activeFrameCount++;
        if (Number.isFinite(f.fricSnrDb) && f.fricSnrDb > peakSnrDb) {
          peakSnrDb = f.fricSnrDb;
        }
      }
      const safePeakSnrDb = Number.isFinite(peakSnrDb) ? Math.round(peakSnrDb * 10) / 10 : 0;
      const meta = rec.stepMeta || {};
      const stepId = meta.id || meta.stepId || 'custom';
      const kind = meta.kind || 'swipe';
      const ok =
        frameCount > 0 &&
        (kind === 'negative' || (activeFrameCount >= 4 && safePeakSnrDb >= 5.0));

      const eventRecord = {
        stepId,
        id: stepId,
        kind,
        label: meta.label || stepId,
        short: meta.short || stepId,
        targetY: Number.isFinite(meta.targetY) ? meta.targetY : undefined,
        direction: meta.direction || undefined,
        startY: Number.isFinite(meta.startY) ? meta.startY : undefined,
        endY: Number.isFinite(meta.endY) ? meta.endY : undefined,
        recordedAt: typeof Date !== 'undefined' ? Date.now() : 0,
        sampleRate: this.sampleRate,
        frameRateHz: Math.round((this.frameRate / 2) * 10) / 10,
        frameCount,
        activeFrameCount,
        peakSnrDb: safePeakSnrDb,
        frames
      };

      return {
        ok,
        reason: ok ? undefined : frameCount === 0 ? 'empty_recording' : 'insufficient_signal',
        frameCount,
        activeFrameCount,
        peakSnrDb: safePeakSnrDb,
        eventRecord
      };
    }

    startCalibrationStep(stepName) {
      this.calibrationCapture = { step: stepName || 'up', samples: [] };
    }

    cancelCalibrationStep() {
      this.calibrationCapture = null;
      this.recCapture = null;
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

      // 2. Coherent Quadrature Demodulation across non-uniform ultrasonic pilot comb (gated strictly on txEnabled)
      const sonarActive = this.txEnabled && this.numCarriers > 0;
      let phaseVelAccum = 0;
      let phaseWeightAccum = 0;
      const occRatiosDb = [];
      let carrierMagMean = 0;

      if (sonarActive) {
        this.txActiveFrames++;
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

          if (this.txActiveFrames <= 10) {
            this.carrierBaseline[k] = mag;
            this.bgI[k] = I;
            this.bgQ[k] = Q;
          } else {
            const bgAlpha = this.activeStroke || this.recCapture ? 0.002 : 0.04;
            this.bgI[k] += bgAlpha * (I - this.bgI[k]);
            this.bgQ[k] += bgAlpha * (Q - this.bgQ[k]);
            if (!this.activeStroke && !this.recCapture && mag > 1e-7) {
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

        this.iqWriteIdx = (idx + 1) & (DOPPLER_HISTORY - 1);
        if (this.iqCount < DOPPLER_HISTORY) this.iqCount++;
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
        this.binPow[b] = p;
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

        // Compute spectralFlatness & tonalCrest strictly across upper bins (>= flatStartBin)
        // so < 1.1 kHz fleshy fingertip pneumatic energy never triggers tonal voice rejection
        if (b >= this.flatStartBin) {
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

      // 8-band log-PSD vector: Band 0 (<180 Hz pneuEnergy) + 7 log-spaced passive FFT bands up to 15.2 kHz
      this.currBandsDb[0] = Math.max(-96, 10 * Math.log10(pneuEnergy + 1e-15));
      for (let j = 0; j < 7; j++) {
        const range = this.bandRanges[j];
        let bSum = 0;
        let bCnt = 0;
        let rawSum = 0;
        let rawCnt = 0;
        for (let b = range[0]; b <= range[1]; b++) {
          const p = this.binPow[b];
          rawSum += p;
          rawCnt++;
          if (!this.txEnabled || !this.imdBins.has(b)) {
            bSum += p;
            bCnt++;
          }
        }
        const bandPsd = bCnt > 0 ? bSum / bCnt : rawSum / Math.max(1, rawCnt);
        this.currBandsDb[j + 1] = Math.max(-96, 10 * Math.log10(bandPsd + 1e-15));
      }

      // Ultrasonic quiet guard-bin click detector (all bins >= 2 away from every carrier)
      if (sonarActive && this.guardBins.length > 0) {
        let guardPow = 0;
        for (let g = 0; g < this.guardBins.length; g++) {
          const gb = this.guardBins[g];
          guardPow +=
            (this.fftRe[gb] * this.fftRe[gb] + this.fftIm[gb] * this.fftIm[gb]) / (QUANTUM * QUANTUM);
        }
        guardPow /= this.guardBins.length;
        if (!this.floorsInitialized && eMid + eHf1 + eHf2 >= 1e-13) {
          this.ambientGuardPow =
            this.nonSilentWarmupFrames === 0
              ? Math.max(1e-15, guardPow)
              : 0.7 * this.ambientGuardPow + 0.3 * Math.max(1e-15, guardPow);
        } else if (this.floorsInitialized && !this.activeStroke && !this.recCapture) {
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
          for (let j = 0; j < NUM_BANDS; j++) {
            this.ambientBandsDb[j] = this.currBandsDb[j];
          }
        } else {
          this.ambientFricDb = 0.7 * this.ambientFricDb + 0.3 * fricDb;
          this.ambientHfDb = 0.7 * this.ambientHfDb + 0.3 * hfDb;
          for (let j = 0; j < NUM_BANDS; j++) {
            this.ambientBandsDb[j] = 0.7 * this.ambientBandsDb[j] + 0.3 * this.currBandsDb[j];
          }
        }
        if (this.nonSilentWarmupFrames >= 6) {
          this.floorsInitialized = true;
        }
      } else if (this.floorsInitialized && !isDigitalSilence && !this.activeStroke) {
        if (!this.recCapture) {
          const alphaFloor = fricDb < this.ambientFricDb ? 0.12 : 0.006;
          this.ambientFricDb += alphaFloor * (fricDb - this.ambientFricDb);
          const alphaHf = hfDb < this.ambientHfDb ? 0.12 : 0.006;
          this.ambientHfDb += alphaHf * (hfDb - this.ambientHfDb);
          for (let j = 0; j < NUM_BANDS; j++) {
            const bAlpha = this.currBandsDb[j] < this.ambientBandsDb[j] ? 0.12 : 0.006;
            this.ambientBandsDb[j] += bAlpha * (this.currBandsDb[j] - this.ambientBandsDb[j]);
          }
        } else if (this.framesProcessed < 24) {
          // Cold-start symmetric settle during first ~64 ms; never ratchet floors downward during recCapture
          const sAlpha = 0.08;
          this.ambientFricDb += sAlpha * (fricDb - this.ambientFricDb);
          this.ambientHfDb += sAlpha * (hfDb - this.ambientHfDb);
          for (let j = 0; j < NUM_BANDS; j++) {
            this.ambientBandsDb[j] += sAlpha * (this.currBandsDb[j] - this.ambientBandsDb[j]);
          }
        }
      }

      for (let j = 0; j < NUM_BANDS; j++) {
        this.relBandsDb[j] = this.floorsInitialized ? this.currBandsDb[j] - this.ambientBandsDb[j] : 0;
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

      const occDb = sonarActive && occRatiosDb.length ? median(occRatiosDb) : 0;
      const pinholeOcclusion =
        sonarActive && carrierMagMean > 8e-5 ? clamp((-occDb - 1.2) / 9.5, 0, 1) : 0;

      // 4. Multi-Carrier Zoomed Complex Baseband Doppler Spectrum (2.93 Hz/bin at 48 kHz)
      let rawDopplerAsym = 0;
      let dopplerAsym = 0;
      let dopplerVelCms = 0;
      let dopplerSnrDb = 0;
      const shouldRunDoppler =
        sonarActive && (this.framesProcessed & 1) === 0 && this.framesProcessed >= 16 && this.iqCount >= 16;

      if (shouldRunDoppler) {
        this.dopplerPower.fill(0);
        const histAvail = Math.min(DOPPLER_HISTORY, this.iqCount);

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
        const dopplerReady = this.framesProcessed >= 64 && this.iqCount >= DOPPLER_HISTORY;
        if ((!this.activeStroke && !this.recCapture && totalDopplerPow > 0) || !dopplerReady) {
          if (totalDopplerPow > 0) {
            const dAlpha = !dopplerReady
              ? 0.25
              : totalDopplerPow < this.ambientDopplerPower
              ? 0.15
              : 0.01;
            this.ambientDopplerPower += dAlpha * (totalDopplerPow - this.ambientDopplerPower);
          }
        }

        if (dopplerReady) {
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
        }
      } else if (this._lastDoppler && sonarActive && this.framesProcessed >= 64) {
        rawDopplerAsym = this._lastDoppler.rawDopplerAsym;
        dopplerAsym = rawDopplerAsym * this.polarity;
        dopplerVelCms = this._lastDoppler.dopplerVelCms;
        dopplerSnrDb = this._lastDoppler.dopplerSnrDb;
      }
      const dopplerPeakRatio =
        sonarActive && this._lastDoppler && this.framesProcessed >= 64
          ? this._lastDoppler.dopplerPeakRatio
          : 1;

      const llapVelCms =
        sonarActive && phaseWeightAccum > 1e-10
          ? (phaseVelAccum / phaseWeightAccum) * this.polarity
          : 0;

      // 5. Contact & Ultrasonic Gesture Gate + Veto Diagnostics
      const isNarrowbandHarmonicSpeech =
        (tonalCrest >= 16.5 && spectralFlatness < 0.14) ||
        (tonalCrest >= 13.5 && spectralFlatness < 0.09);

      const isVoiceLike =
        fricDb - this.ambientFricDb > 9.0 &&
        (hfSnrDb < 3.5 ||
          isNarrowbandHarmonicSpeech ||
          (pinholeOcclusion <= 0.18 && hfSnrDb <= 5.5 && (tonalCrest >= 14.0 || spectralFlatness < 0.14)));
      if (isVoiceLike && !this.activeStroke) {
        this.lastVeto = { reason: 'voice', untilSec: timeSec + 0.18 };
      }

      const isBroadbandFriction =
        fricSnrDb > 5.2 &&
        hfSnrDb > 4.2 &&
        !isNarrowbandHarmonicSpeech &&
        ((spectralFlatness > 0.16 && tonalCrest < 13.5) ||
          pinholeOcclusion > 0.18 ||
          hfSnrDb > 5.5);
      const isStrongPinholeRub =
        fricSnrDb > 12.0 &&
        hfSnrDb > 6.5 &&
        !isNarrowbandHarmonicSpeech &&
        (pinholeOcclusion > 0.25 || (spectralFlatness > 0.12 && tonalCrest < 16.0));
      const isPureSonarWave =
        sonarActive &&
        carrierMagMean > 8e-5 &&
        dopplerSnrDb > 9.0 &&
        Math.abs(dopplerAsym) > 0.38 &&
        dopplerPeakRatio > 3.2;

      const isActiveSignal =
        timeSec >= this.cooldownUntilSec && (isBroadbandFriction || isStrongPinholeRub || isPureSonarWave);

      // Un-vetoed 2x downsampled (~187.5 Hz, max 1500 frames) raw feature capture during guided calibration
      if (this.recCapture) {
        const shouldCaptureFrame = (this.recCapture.frameCounter++ & 1) === 0;
        if (shouldCaptureFrame) {
          const bandsArr = new Array(NUM_BANDS);
          for (let j = 0; j < NUM_BANDS; j++) {
            bandsArr[j] = round2(this.relBandsDb[j]);
          }
          const recActive =
            fricSnrDb > 4.5 ||
            hfSnrDb > 5.0 ||
            pinholeOcclusion > 0.22 ||
            (sonarActive && this.framesProcessed >= 64 && dopplerSnrDb > 8.5);
          this.recCapture.frames.push({
            t: round3(timeSec - this.recCapture.startTimeSec),
            bandsDb: bandsArr,
            fricSnrDb: round2(fricSnrDb),
            hfSnrDb: round2(hfSnrDb),
            specRatioDb: round2(specRatioDb),
            occDb: round2(occDb),
            pinholeOcclusion: round3(pinholeOcclusion),
            rawDopplerAsym: round3(rawDopplerAsym),
            dopplerVelCms: round2(dopplerVelCms),
            dopplerSnrDb: round2(dopplerSnrDb),
            spectralFlatness: round3(spectralFlatness),
            tonalCrest: round2(tonalCrest),
            active: recActive
          });
          if (this.recCapture.frames.length > MAX_REC_FRAMES) {
            this.recCapture.frames.shift();
          }
        }
      }

      // 6. Instantaneous Position Estimate yObs in [0=Top, 1=Bottom] & Heteroscedastic Uncertainty
      let rawYObs;
      let targetUncPct;
      const empRbf = this.empiricalModel && this.empiricalModel.rbf;
      if (empRbf && empRbf.prototypes && empRbf.prototypes.length >= 2) {
        const posVec = extractPosFeature({
          bandsDb: this.relBandsDb,
          specRatioDb,
          fricSnrDb,
          occDb
        });
        const rbfRes = predictRbfY(posVec, empRbf, { txActive: sonarActive });
        const calFlip =
          (this.polarity === -1 ? -1 : 1) * (this.empiricalModel.polarity === -1 ? -1 : 1);
        rawYObs = calFlip === -1 ? 1 - rbfRes.y : rbfRes.y;
        targetUncPct = isActiveSignal ? lerp(10.5, 4.2, rbfRes.maxWeight) : 12.0;
      } else {
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
        rawYObs = this.polarity === 1 ? 1.0 - proxTop : proxTop;
        targetUncPct = pinholeOcclusion > 0.35 ? 4.5 : isActiveSignal ? lerp(11.5, 5.5, proxTop) : 12.0;
      }
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

      const makeStrokeFeatureSnap = () => ({
        t: timeSec,
        bandsDb: Array.from(this.relBandsDb),
        fricSnrDb,
        hfSnrDb,
        specRatioDb,
        occDb,
        pinholeOcclusion,
        rawDopplerAsym,
        dopplerSnrDb
      });

      // Prune stale pre-roll (> 85 ms age TTL) so sustained low noise never skews stroke startTime
      while (this.preRoll.length && timeSec - this.preRoll[0].t > 0.085) {
        this.preRoll.shift();
      }
      if (!this.activeStroke && fricSnrDb > 2.8 && hfSnrDb > 2.2) {
        this.preRoll.push({
          t: timeSec,
          rawY: rawYObs,
          w: 0.4,
          feat: this.empiricalModel ? makeStrokeFeatureSnap() : null
        });
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

      // Guard against sustained ambient noise floor step-up (e.g. fan/HVAC spin-up > 3.5 s),
      // suppressed during recCapture so holding a long zone rub > 3.5 s never snaps ambient floors.
      if (this.activeStroke && !this.recCapture && timeSec - this.activeStroke.startTime > 3.5) {
        this.activeStroke = null;
        this.ambientFricDb = fricDb;
        this.ambientHfDb = hfDb;
        for (let j = 0; j < NUM_BANDS; j++) {
          this.ambientBandsDb[j] = this.currBandsDb[j];
        }
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
          const seedFeats = [];
          if (this.empiricalModel) {
            for (let i = 0; i < seedPoints.length; i += 2) {
              if (seedPoints[i].feat) seedFeats.push(seedPoints[i].feat);
            }
          }
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
            featureFrames: seedFeats,
            dopplerImpulse: 0,
            dopplerWeightSum: 0,
            flatnessSum: 0,
            tonalCrestSum: 0,
            hfSnrSum: 0,
            maxPinholeOcclusion: pinholeOcclusion,
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
        if (pinholeOcclusion > st.maxPinholeOcclusion) st.maxPinholeOcclusion = pinholeOcclusion;
        st.flatnessSum += spectralFlatness;
        st.tonalCrestSum += tonalCrest;
        st.hfSnrSum += hfSnrDb;

        if (this.empiricalModel && (st.activeFrames & 1) === 1 && st.featureFrames.length < MAX_REC_FRAMES) {
          st.featureFrames.push(makeStrokeFeatureSnap());
        }

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
        if (st.points.length < MAX_REC_FRAMES * 2) {
          st.points.push({
            t: timeSec,
            y: this.y,
            rawY: rawYObs,
            speedCms: this.speedCmPerSec,
            w: ptWeight
          });
        }

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
          const minStrokeDur =
            this.empiricalModel && Number.isFinite(this.empiricalModel.minStrokeDurationSec)
              ? this.empiricalModel.minStrokeDurationSec
              : 0.068;
          committedSwipe = this._finalizeStroke(this.activeStroke);
          if (!committedSwipe && strokeDur > 0 && strokeDur < minStrokeDur) {
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
      if (sonarActive && this.framesProcessed >= 64) {
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
        carrierActive: sonarActive && carrierMagMean > 8e-5,
        vetoReason: activeVeto,
        dopplerSpectrum: Array.from(dopplerDisplay),
        swipe: committedSwipe
      };
    }

    _finalizeStroke(st) {
      const n = st.points.length;
      const minStrokeDur =
        this.empiricalModel && Number.isFinite(this.empiricalModel.minStrokeDurationSec)
          ? this.empiricalModel.minStrokeDurationSec
          : 0.068;
      const minFrames = Math.max(6, Math.round(Math.max(0.064, minStrokeDur - 0.004) * this.frameRate));
      if (n < minFrames) return null;
      const durationSec = st.points[n - 1].t - st.points[0].t;
      if (durationSec < minStrokeDur || durationSec > 3.5) return null;

      const minModeFrames = Math.max(4, Math.round(0.026 * this.frameRate));
      const minSonarFrames = Math.max(4, Math.round(0.021 * this.frameRate));

      const meanFlatness = st.flatnessSum / Math.max(1, st.activeFrames);
      const meanCrest = st.tonalCrestSum / Math.max(1, st.activeFrames);
      const meanHfSnrDb = st.hfSnrSum / Math.max(1, st.activeFrames);
      const hasStrongSonar = st.sonarFrames >= minSonarFrames && st.maxDopplerSnrDb > 9.0;
      const isMeanNarrowbandSpeech =
        (meanCrest >= 16.5 && meanFlatness < 0.14) ||
        (meanCrest >= 13.5 && meanFlatness < 0.09);
      const hasPinholeOrStrongHf = st.maxPinholeOcclusion > 0.18 || meanHfSnrDb > 5.5;

      if (
        !hasStrongSonar &&
        (isMeanNarrowbandSpeech || (!hasPinholeOrStrongHf && (meanFlatness < 0.16 || meanCrest > 15.5)))
      ) {
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
      const hasEmpLda =
        this.empiricalModel &&
        this.empiricalModel.lda &&
        st.contactFrames >= minModeFrames &&
        st.featureFrames &&
        st.featureFrames.length >= 4;

      if (hasEmpLda) {
        const txActive = this.txEnabled && this.numCarriers > 0;
        const empRbf =
          this.empiricalModel.rbf &&
          Array.isArray(this.empiricalModel.rbf.prototypes) &&
          this.empiricalModel.rbf.prototypes.length >= 2
            ? this.empiricalModel.rbf
            : null;
        const strokeVec = extractStrokeFeatures(st.featureFrames, empRbf, { txActive });
        const calFlip =
          (this.polarity === -1 ? -1 : 1) * (this.empiricalModel.polarity === -1 ? -1 : 1);
        const ldaScore = clamp(
          scoreShrinkageLda(strokeVec, this.empiricalModel.lda, { txActive }) * calFlip,
          -2.0,
          2.0
        );
        const rbfVote = empRbf ? clamp(-(endY - startY) * 2.2 - halfDiffY * 2.2, -1.5, 1.5) : 0;
        const rbfWeight = empRbf ? 0.28 : 0;
        upScore = (1 - rbfWeight) * ldaScore + rbfWeight * rbfVote;
        sensingMode = 'calibrated';
      } else if (st.contactFrames >= minModeFrames && st.dopplerWeightSum > 1.2) {
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
      const speedScale =
        this.empiricalModel && Number.isFinite(this.empiricalModel.speedScale)
          ? this.empiricalModel.speedScale
          : 1.0;
      const rawSpeed =
        (0.55 * avgSpeedFromSpan + 0.45 * Math.max(avgSpeedFromSpan, medianPointSpeed)) * speedScale;
      const speedCmPerSec = Math.round(clamp(rawSpeed, 2.5, 130) * 10) / 10;
      const peakSpeedCmPerSec =
        Math.round(clamp(Math.max(speedCmPerSec, st.peakSpeedCms * speedScale), 2.5, 140) * 10) / 10;

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
            polarity: opts.polarity,
            calibration: opts.calibration || undefined,
            empiricalModel: opts.empiricalModel || undefined
          });
          this.port.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'setTx') {
              this.core.setTxEnabled(msg.enabled, msg.gain);
            } else if (msg.type === 'setCalibration') {
              this.core.setCalibration(msg.calibration);
            } else if (msg.type === 'setEmpiricalModel') {
              this.core.setEmpiricalModel(msg.model, { syncPolarity: Boolean(msg.syncPolarity) });
            } else if (msg.type === 'resetCalibration') {
              this.core.resetCalibration();
            } else if (msg.type === 'beginRec') {
              this.core.beginRecordEvent(msg.stepMeta);
            } else if (msg.type === 'cancelRec') {
              this.core.cancelRecordEvent();
            } else if (msg.type === 'endRec') {
              const res = this.core.endRecordEvent();
              this.port.postMessage({ type: 'recEventResult', reqId: msg.reqId, result: res });
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
    CALIBRATION_PROTOCOL,
    fftRadix2,
    computeDecimationFactor,
    buildCarrierMultiples,
    theilSenSlope,
    predictRbfY,
    extractStrokeFeatures,
    fitShrinkageLda,
    scoreShrinkageLda,
    fitEmpiricalCalibration,
    AcousticDspCore,
    createWorkletSource
  };
});
