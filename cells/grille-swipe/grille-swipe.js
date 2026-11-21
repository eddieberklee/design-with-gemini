(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.GrilleSwipeLab = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CARRIER_HZ = 19000;
  var FEATURE_SCALES = [6.0, 4.5, 0.40, 0.30, 0.25, 0.35];
  var FEATURE_NAMES = [
    'Env Slope',
    'Air/Sub Tilt',
    'Centroid Oct',
    'Crest Skew',
    '19k Occlusion',
    '19k Doppler'
  ];

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function normVec(v) {
    var s = 0;
    for (var i = 0; i < v.length; i++) s += v[i] * v[i];
    var inv = s > 1e-18 ? 1 / Math.sqrt(s) : 0;
    var out = new Array(v.length);
    for (var j = 0; j < v.length; j++) out[j] = v[j] * inv;
    return out;
  }

  function getPriorWeights(grille, sonarActive) {
    if (grille === 'left') {
      return normVec([0.82, 0.36, 0.28, 0.08, 0.0, 0.0]);
    }
    if (sonarActive) {
      // Right grille + 19 kHz hard-right tweeter sonar:
      // Doppler blueshift (+x6) + chassis stiffness tilt (+x2) + centroid (+x3) lead zero-shot;
      // 4-stroke calibration adapts x5 (tweeter dip timing) to exact user stroke span.
      return normVec([0.08, 0.30, 0.22, 0.10, 0.35, 0.84]);
    }
    return normVec([0.14, 0.64, 0.54, 0.50, 0.0, 0.0]);
  }

  // --- Biquad Filter Factory (Direct Form I, parameterized by dynamic sampleRate) ---
  function makeBiquadCoeffs(type, fc, Q, sr) {
    var nyq = sr * 0.48;
    var f = clamp(fc, 2, nyq);
    var w0 = (2 * Math.PI * f) / sr;
    var cosw = Math.cos(w0);
    var sinw = Math.sin(w0);
    var alpha = sinw / (2 * Q);
    var b0, b1, b2, a0, a1, a2;
    if (type === 'lowpass') {
      b0 = (1 - cosw) * 0.5;
      b1 = 1 - cosw;
      b2 = (1 - cosw) * 0.5;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
    } else if (type === 'highpass') {
      b0 = (1 + cosw) * 0.5;
      b1 = -(1 + cosw);
      b2 = (1 + cosw) * 0.5;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
    } else if (type === 'bandpass') {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
    } else {
      // notch
      b0 = 1;
      b1 = -2 * cosw;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
    }
    return {
      b0: b0 / a0,
      b1: b1 / a0,
      b2: b2 / a0,
      a1: a1 / a0,
      a2: a2 / a0
    };
  }

  function createBiquad(type, fc, Q, sr) {
    var c = makeBiquadCoeffs(type, fc, Q, sr);
    return {
      b0: c.b0, b1: c.b1, b2: c.b2, a1: c.a1, a2: c.a2,
      x1: 0, x2: 0, y1: 0, y2: 0,
      step: function (x) {
        var y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
        this.x2 = this.x1; this.x1 = x;
        this.y2 = this.y1; this.y1 = y;
        return y;
      },
      reset: function (v) {
        var val = v || 0;
        this.x1 = val; this.x2 = val; this.y1 = val; this.y2 = val;
      }
    };
  }

  // Forward-backward zero-phase 2nd-order Butterworth filtfilt on a REAL Float64Array
  function filtfiltReal(arr, fc, sr) {
    var n = arr.length;
    if (n < 6) return Float64Array.from(arr);
    var c = makeBiquadCoeffs('lowpass', fc, Math.SQRT1_2, sr);
    var pad = Math.min(n - 1, Math.max(12, Math.round(sr / Math.max(fc, 1))));
    var extLen = n + 2 * pad;
    var ext = new Float64Array(extLen);
    var left0 = arr[0];
    var right0 = arr[n - 1];
    for (var i = 0; i < pad; i++) {
      ext[i] = 2 * left0 - arr[pad - i];
      ext[n + pad + i] = 2 * right0 - arr[n - 2 - i];
    }
    for (var j = 0; j < n; j++) ext[pad + j] = arr[j];

    var fwd = new Float64Array(extLen);
    var initF = ext[0];
    var x1 = initF, x2 = initF, y1 = initF, y2 = initF;
    for (var k = 0; k < extLen; k++) {
      var x = ext[k];
      var y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      fwd[k] = y;
    }

    var bwd = new Float64Array(extLen);
    var initB = fwd[extLen - 1];
    x1 = initB; x2 = initB; y1 = initB; y2 = initB;
    for (var m = extLen - 1; m >= 0; m--) {
      var xb = fwd[m];
      var yb = c.b0 * xb + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = xb; y2 = y1; y1 = yb;
      bwd[m] = yb;
    }

    var out = new Float64Array(n);
    for (var q = 0; q < n; q++) out[q] = bwd[pad + q];
    return out;
  }

  // Ordinary Least Squares slope of y(u) across normalized u in [0, 1]
  function olsSlopeUnit(yArr, iStart, iEnd) {
    var s0 = Math.max(0, iStart);
    var s1 = Math.min(yArr.length - 1, iEnd);
    var count = s1 - s0 + 1;
    if (count < 2) return 0;
    var denomN = Math.max(1, yArr.length - 1);
    var su = 0, sy = 0, suy = 0, suu = 0;
    for (var i = s0; i <= s1; i++) {
      var u = i / denomN;
      var y = yArr[i];
      su += u;
      sy += y;
      suy += u * y;
      suu += u * u;
    }
    var varU = suu - (su * su) / count;
    if (varU < 1e-12) return 0;
    return (suy - (su * sy) / count) / varU;
  }

  function resampleCurve(arr, targetLen) {
    var nOut = Math.max(0, targetLen | 0);
    var out = new Float32Array(nOut);
    if (nOut === 0 || !arr || arr.length === 0) return out;
    if (arr.length === 1 || nOut === 1) {
      out.fill(arr[0]);
      return out;
    }
    for (var i = 0; i < nOut; i++) {
      var pos = (i / (nOut - 1)) * (arr.length - 1);
      var idx = Math.floor(pos);
      var frac = pos - idx;
      var v0 = arr[idx];
      var v1 = arr[Math.min(arr.length - 1, idx + 1)];
      out[i] = v0 + frac * (v1 - v0);
    }
    return out;
  }

  // --- Extract 6-Feature Acoustic + Sonar Vector from Captured Stroke ---
  // Passive hops arrive at ~f_bb / 4 (~250 Hz, 4 ms per passive frame)
  // Baseband IQ samples arrive at f_bb (~1000 Hz, 1 ms per IQ sample), with pre-roll & post-roll
  function extractStrokeFeatures(strokeData) {
    var sd = strokeData || {};
    var pFrames = sd.passiveFrames || [];
    var bbI = sd.bbI; // includes prePad before m0 and postPad after m1
    var bbQ = sd.bbQ;
    var m0 = sd.m0 || 0;
    var m1 = sd.m1 || 0;
    var fbb = sd.fbb || 1000;
    var clutterI = sd.clutterI || 0;
    var clutterQ = sd.clutterQ || 0;
    var sonarActive = !!sd.sonarActive;
    var noiseAirDb = typeof sd.noiseAirDb === 'number' ? sd.noiseAirDb : -75;
    var noiseDopPow = Math.max(1e-14, sd.noiseDopPow || 1e-11);

    var nP = pFrames.length;
    var durMs = sd.durMs || 0;
    var lFric = new Float64Array(nP);
    var lTilt = new Float64Array(nP);
    var octCent = new Float64Array(nP);
    var crests = new Float64Array(nP);
    var maxAirSnrDb = -99;
    var sumSubDb = 0, sumFricDb = 0, sumSfm = 0;

    for (var i = 0; i < nP; i++) {
      var pf = pFrames[i];
      var dbSub = 10 * Math.log10(pf.eSub + 1e-15);
      var dbAir = 10 * Math.log10(pf.eAir + 1e-15);
      var dbFric = 10 * Math.log10(pf.eFric + 1e-15);
      lFric[i] = dbFric;
      lTilt[i] = dbAir - dbSub;
      var tot = pf.eSub + pf.eMid + pf.eAir + 1e-15;
      var cHz = (320 * pf.eSub + 3400 * pf.eMid + 11500 * pf.eAir) / tot;
      octCent[i] = Math.log2(Math.max(120, cHz) / 1000);
      crests[i] = pf.crest;
      var airSnr = dbAir - noiseAirDb;
      if (airSnr > maxAirSnrDb) maxAirSnrDb = airSnr;
      sumSubDb += dbSub;
      sumFricDb += dbFric;
      sumSfm += pf.sfm;
    }

    var x1 = 0, x2 = 0, x3 = 0, x4 = 0;
    if (nP >= 2) {
      var trim0 = Math.floor(nP * 0.08);
      var trim1 = Math.min(nP - 1, Math.max(trim0 + 1, Math.ceil(nP * 0.92) - 1));
      x1 = olsSlopeUnit(lFric, trim0, trim1);
      x2 = olsSlopeUnit(lTilt, trim0, trim1);
      x3 = olsSlopeUnit(octCent, trim0, trim1);

      // Crest skew: late vs early mean normalized by std + 0.25
      var midIdx = Math.max(trim0 + 1, Math.floor((trim0 + trim1 + 1) * 0.5));
      var sumEarly = 0, nEarly = 0, sumLate = 0, nLate = 0, meanC = 0;
      for (var cIdx = trim0; cIdx <= trim1; cIdx++) {
        meanC += crests[cIdx];
        if (cIdx < midIdx) { sumEarly += crests[cIdx]; nEarly++; }
        else { sumLate += crests[cIdx]; nLate++; }
      }
      var nCore = Math.max(1, trim1 - trim0 + 1);
      meanC /= nCore;
      var varC = 0;
      for (var vc = trim0; vc <= trim1; vc++) {
        var dc = crests[vc] - meanC;
        varC += dc * dc;
      }
      var stdC = Math.sqrt(varC / nCore);
      x4 = (nEarly > 0 && nLate > 0)
        ? ((sumLate / nLate) - (sumEarly / nEarly)) / (stdC + 0.25)
        : 0;
    }

    // --- Active Sonar Features x5 (Real-Magnitude Zero-Phase Occlusion) & x6 (MTI Bistatic Doppler) ---
    var x5 = 0;
    var x6 = 0;
    var tauDip = 0.5;
    var dipDb = 0;
    var occCurve64 = new Float32Array(64);
    var dopCurve64 = new Float32Array(64);
    var specBins = new Float32Array(33); // -100..+100 Hz waterfall slice

    var strokeBbLen = Math.max(0, m1 - m0);
    if (sonarActive && bbI && strokeBbLen >= 16) {
      var clutterMag = Math.hypot(clutterI, clutterQ);
      if (clutterMag > 1e-6) {
        // 1. Real magnitude FIRST (immune to Fresnel diffraction phase rotation!), then 8 Hz zero-phase filtfilt
        var rawMag = new Float64Array(bbI.length);
        for (var bi = 0; bi < bbI.length; bi++) {
          rawMag[bi] = Math.hypot(bbI[bi], bbQ[bi]);
        }
        var smoothMag = filtfiltReal(rawMag, 8.0, fbb);
        var minMag = clutterMag;
        var wSum = 0, wuSum = 0;
        var strokeOcc = new Float32Array(strokeBbLen);
        for (var s = 0; s < strokeBbLen; s++) {
          var aLp = smoothMag[m0 + s];
          if (aLp < minMag) minMag = aLp;
          var drop = Math.max(0, clutterMag - aLp);
          var relDrop = drop / (clutterMag + 1e-9);
          strokeOcc[s] = relDrop;
          var wOcc = drop * drop * drop;
          var uPos = strokeBbLen > 1 ? s / (strokeBbLen - 1) : 0.5;
          wSum += wOcc;
          wuSum += wOcc * uPos;
        }
        dipDb = 20 * Math.log10((clutterMag + 1e-9) / Math.max(clutterMag * 0.05, minMag + 1e-9));
        tauDip = wSum > 1e-18 ? wuSum / wSum : 0.5;
        var gammaOcc = clamp((dipDb - 0.8) / 2.2, 0, 1);
        x5 = clamp(2 * gammaOcc * (tauDip - 0.5), -1, 1);
        occCurve64 = resampleCurve(strokeOcc, 64);

        // 2. Clutter-subtracted 4th-order 15 Hz Butterworth Complex MTI HPF + 128 ms Hann Complex DFT
        var hpI1 = createBiquad('highpass', 15.0, 0.5411961, fbb);
        var hpI2 = createBiquad('highpass', 15.0, 1.3065630, fbb);
        var hpQ1 = createBiquad('highpass', 15.0, 0.5411961, fbb);
        var hpQ2 = createBiquad('highpass', 15.0, 1.3065630, fbb);
        var d0I = bbI[0] - clutterI;
        var d0Q = bbQ[0] - clutterQ;
        hpI1.reset(d0I); hpI2.reset(0);
        hpQ1.reset(d0Q); hpQ2.reset(0);

        var mtiI = new Float64Array(bbI.length);
        var mtiQ = new Float64Array(bbQ.length);
        for (var mi = 0; mi < bbI.length; mi++) {
          mtiI[mi] = hpI2.step(hpI1.step(bbI[mi] - clutterI));
          mtiQ[mi] = hpQ2.step(hpQ1.step(bbQ[mi] - clutterQ));
        }

        var winN = Math.max(32, Math.round(0.128 * fbb)); // 128 ms window -> df = 7.8125 Hz
        var hopN = Math.max(4, Math.round(0.016 * fbb));  // 16 ms hop
        var hann = new Float64Array(winN);
        for (var h = 0; h < winN; h++) {
          hann[h] = 0.5 * (1 - Math.cos((2 * Math.PI * h) / (winN - 1)));
        }

        // Precompute DFT frequencies purely in +-20..+-95 Hz (strictly outside +-15.6 Hz Hann DC mainlobe)
        var freqs = [];
        var df = fbb / winN;
        for (var kBin = 1; kBin < Math.floor(winN / 2); kBin++) {
          var fHz = kBin * df;
          if (fHz >= 19.5 && fHz <= 96.0) {
            freqs.push({ k: kBin, fHz: fHz, omega: (2 * Math.PI * kBin) / winN });
          }
        }

        var nFramesDft = Math.max(1, Math.floor(Math.max(0, strokeBbLen - winN) / hopN) + 1);
        var frameDopHz = new Float32Array(nFramesDft);
        var numAsym = 0, denWeight = 0;
        var n0Floor = noiseDopPow * winN * 0.25 + 1e-12;

        // Accumulate 33-bin (-100..+100 Hz in 6.25 Hz steps) spectrum for waterfall visualization
        for (var wi = 0; wi < 33; wi++) specBins[wi] = 0;

        for (var qf = 0; qf < nFramesDft; qf++) {
          var startIdx;
          if (strokeBbLen >= winN) {
            startIdx = m0 + qf * hopN;
          } else {
            // Center short stroke in zero-padded 128 ms window using only stroke samples
            startIdx = m0;
          }

          var pPlus = 0, pMinus = 0, weightedHz = 0;
          for (var fi = 0; fi < freqs.length; fi++) {
            var om = freqs[fi].omega;
            var fVal = freqs[fi].fHz;
            var reP = 0, imP = 0, reM = 0, imM = 0;
            if (strokeBbLen >= winN) {
              for (var n = 0; n < winN; n++) {
                var wv = hann[n];
                var si = mtiI[startIdx + n] * wv;
                var sq = mtiQ[startIdx + n] * wv;
                var cs = Math.cos(om * n);
                var sn = Math.sin(om * n);
                // X(+k): sum (I + jQ)(cos - j sin) = (I cos + Q sin) + j(Q cos - I sin)
                reP += si * cs + sq * sn;
                imP += sq * cs - si * sn;
                // X(-k): sum (I + jQ)(cos + j sin) = (I cos - Q sin) + j(Q cos + I sin)
                reM += si * cs - sq * sn;
                imM += sq * cs + si * sn;
              }
            } else {
              var padOff = Math.floor((winN - strokeBbLen) * 0.5);
              for (var ns = 0; ns < strokeBbLen; ns++) {
                var wn = padOff + ns;
                var wvs = 0.5 * (1 - Math.cos((2 * Math.PI * ns) / Math.max(1, strokeBbLen - 1)));
                var sis = mtiI[m0 + ns] * wvs;
                var sqs = mtiQ[m0 + ns] * wvs;
                var css = Math.cos(om * wn);
                var sns = Math.sin(om * wn);
                reP += sis * css + sqs * sns;
                imP += sqs * css - sis * sns;
                reM += sis * css - sqs * sns;
                imM += sqs * css + sis * sns;
              }
            }
            var powP = (reP * reP + imP * imP) / winN;
            var powM = (reM * reM + imM * imM) / winN;
            pPlus += powP;
            pMinus += powM;
            weightedHz += fVal * (powP - powM);

            var binP = clamp(Math.round(16 + (fVal / 100) * 16), 0, 32);
            var binM = clamp(Math.round(16 - (fVal / 100) * 16), 0, 32);
            specBins[binP] += powP / nFramesDft;
            specBins[binM] += powM / nFramesDft;
          }

          var totP = pPlus + pMinus;
          var wq = totP / (totP + n0Floor);
          var dirQ = (pPlus - pMinus) / (totP + n0Floor);
          numAsym += wq * dirQ;
          denWeight += wq;
          frameDopHz[qf] = wq * (weightedHz / (totP + n0Floor));
        }

        x6 = denWeight > 1e-6 ? clamp(numAsym / (denWeight + 0.08), -1, 1) : 0;
        dopCurve64 = resampleCurve(frameDopHz, 64);
      }
    }

    var meanSubMinusFric = nP > 0 ? (sumSubDb - sumFricDb) / nP : 0;
    var meanSfm = nP > 0 ? sumSfm / nP : 0;
    var isTapVeto = durMs < 88;
    var isThumpVeto = meanSubMinusFric > 12.5 && dipDb < 1.8;
    var isSpeechVeto = meanSfm < 0.19 && dipDb < 1.8 && Math.abs(x6) < 0.18;
    var isNearLeftGrille = maxAirSnrDb > 26.0 && dipDb < 1.0;

    return {
      durMs: durMs,
      rawX: [x1, x2, x3, x4, x5, x6],
      scaledX: [
        x1 / FEATURE_SCALES[0],
        x2 / FEATURE_SCALES[1],
        x3 / FEATURE_SCALES[2],
        x4 / FEATURE_SCALES[3],
        x5 / FEATURE_SCALES[4],
        x6 / FEATURE_SCALES[5]
      ],
      tauDip: tauDip,
      dipDb: dipDb,
      maxAirSnrDb: maxAirSnrDb,
      meanSfm: meanSfm,
      isTapVeto: isTapVeto,
      isThumpVeto: isThumpVeto,
      isSpeechVeto: isSpeechVeto,
      isNearLeftGrille: isNearLeftGrille,
      fricCurve64: resampleCurve(lFric, 64),
      occCurve64: occCurve64,
      dopCurve64: dopCurve64,
      specBins: specBins
    };
  }

  function isValidScaledVec6(v) {
    if (!v || v.length !== 6) return false;
    for (var i = 0; i < 6; i++) {
      if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) return false;
    }
    return true;
  }

  // --- 6x6 Cholesky Linear Solver for Shrinkage Fisher LDA ---
  function solveCholesky6(A, b) {
    var n = 6;
    var L = new Float64Array(n * n);
    for (var i = 0; i < n; i++) {
      for (var j = 0; j <= i; j++) {
        var sum = A[i * n + j];
        for (var k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k];
        if (i === j) {
          L[i * n + i] = Math.sqrt(Math.max(1e-9, sum));
        } else {
          L[i * n + j] = sum / L[j * n + j];
        }
      }
    }
    var y = new Float64Array(n);
    for (var r = 0; r < n; r++) {
      var s = b[r];
      for (var c = 0; c < r; c++) s -= L[r * n + c] * y[c];
      y[r] = s / L[r * n + r];
    }
    var x = new Float64Array(n);
    for (var r2 = n - 1; r2 >= 0; r2--) {
      var s2 = y[r2];
      for (var c2 = r2 + 1; c2 < n; c2++) s2 -= L[c2 * n + r2] * x[c2];
      x[r2] = s2 / L[r2 * n + r2];
    }
    return Array.from(x);
  }

  function fitSingleFoldLDA(upVecs, downVecs, wPrior) {
    var D = 6;
    var nUp = upVecs.length;
    var nDn = downVecs.length;
    var N = nUp + nDn;
    var muUp = new Float64Array(D);
    var muDn = new Float64Array(D);
    for (var i = 0; i < nUp; i++) for (var d = 0; d < D; d++) muUp[d] += upVecs[i][d] / nUp;
    for (var j = 0; j < nDn; j++) for (var d2 = 0; d2 < D; d2++) muDn[d2] += downVecs[j][d2] / nDn;

    var df = Math.max(1, N - 2);
    var S = new Float64Array(D * D);
    var addScatter = function (vecs, mu) {
      for (var k = 0; k < vecs.length; k++) {
        for (var r = 0; r < D; r++) {
          var dr = vecs[k][r] - mu[r];
          for (var c = 0; c < D; c++) {
            S[r * D + c] += (dr * (vecs[k][c] - mu[c])) / df;
          }
        }
      }
    };
    addScatter(upVecs, muUp);
    addScatter(downVecs, muDn);

    var lam = D / (Math.max(1, N - 2) + D); // 0.75 at N=4, 0.857 at N=3 LOO fold
    var Stilde = new Float64Array(D * D);
    for (var r2 = 0; r2 < D; r2++) {
      for (var c2 = 0; c2 < D; c2++) {
        var emp = S[r2 * D + c2];
        var target = r2 === c2 ? (0.5 * emp + 0.5) : 0;
        Stilde[r2 * D + c2] = (1 - lam) * emp + lam * target;
      }
    }

    var delta = new Float64Array(D);
    var center = new Float64Array(D);
    for (var m = 0; m < D; m++) {
      delta[m] = muUp[m] - muDn[m];
      center[m] = 0.5 * (muUp[m] + muDn[m]);
    }

    var wEmp = normVec(solveCholesky6(Stilde, delta));
    var wBlend = new Array(D);
    for (var q = 0; q < D; q++) {
      wBlend[q] = 0.85 * wEmp[q] + 0.15 * wPrior[q];
    }
    var wHat = normVec(wBlend);

    // Within-class projected variance w^T Stilde w
    var projVar = 0;
    for (var a = 0; a < D; a++) {
      for (var b = 0; b < D; b++) {
        projVar += wHat[a] * Stilde[a * D + b] * wHat[b];
      }
    }
    var sigmaW = Math.sqrt(Math.max(0.15, projVar));
    var theta = 0;
    for (var t = 0; t < D; t++) theta += wHat[t] * center[t];

    return {
      w: wHat,
      theta: theta,
      center: Array.from(center),
      muUp: Array.from(muUp),
      muDn: Array.from(muDn),
      sigmaW: sigmaW
    };
  }

  function fitShrinkageLDA(upSamples, downSamples, grille, sonarActive) {
    var w0 = getPriorWeights(grille, sonarActive);
    if (!upSamples || !downSamples || upSamples.length < 2 || downSamples.length < 2) {
      return null;
    }
    var upVecs = [];
    var dnVecs = [];
    for (var ui = 0; ui < upSamples.length; ui++) {
      if (!upSamples[ui] || !isValidScaledVec6(upSamples[ui].scaledX)) return null;
      upVecs.push(upSamples[ui].scaledX);
    }
    for (var di = 0; di < downSamples.length; di++) {
      if (!downSamples[di] || !isValidScaledVec6(downSamples[di].scaledX)) return null;
      dnVecs.push(downSamples[di].scaledX);
    }
    var full = fitSingleFoldLDA(upVecs, dnVecs, w0);

    // Standardized Leave-One-Out cross-validation for honest d'_OOF
    var oofUp = [];
    var oofDn = [];
    for (var i = 0; i < upVecs.length; i++) {
      var subUp = upVecs.filter(function (_, idx) { return idx !== i; });
      var foldU = fitSingleFoldLDA(subUp, dnVecs, w0);
      var dotU = 0;
      for (var d = 0; d < 6; d++) dotU += foldU.w[d] * upVecs[i][d];
      oofUp.push((dotU - foldU.theta) / foldU.sigmaW);
    }
    for (var j = 0; j < dnVecs.length; j++) {
      var subDn = dnVecs.filter(function (_, idx) { return idx !== j; });
      var foldD = fitSingleFoldLDA(upVecs, subDn, w0);
      var dotD = 0;
      for (var d2 = 0; d2 < 6; d2++) dotD += foldD.w[d2] * dnVecs[j][d2];
      oofDn.push((dotD - foldD.theta) / foldD.sigmaW);
    }

    var meanZUp = oofUp.reduce(function (a, b) { return a + b; }, 0) / oofUp.length;
    var meanZDn = oofDn.reduce(function (a, b) { return a + b; }, 0) / oofDn.length;
    var N = oofUp.length + oofDn.length;
    var ss = 0;
    for (var u = 0; u < oofUp.length; u++) ss += (oofUp[u] - meanZUp) * (oofUp[u] - meanZUp);
    for (var v = 0; v < oofDn.length; v++) ss += (oofDn[v] - meanZDn) * (oofDn[v] - meanZDn);
    var sOof2 = ss / Math.max(1, N - 2);
    var sPost = Math.sqrt((2 * 1.0 + Math.max(1, N - 2) * sOof2) / N);
    var dPrimeOof = Math.max(0, (meanZUp - meanZDn) / sPost);

    return {
      calibrated: true,
      w: full.w,
      theta: full.theta,
      center: full.center,
      sigmaW: full.sigmaW,
      dPrimeOof: dPrimeOof,
      oofUp: oofUp,
      oofDn: oofDn
    };
  }

  function classifyStroke(feat, model, grille, sonarActive) {
    var w, theta, sigmaW, gainScale;
    var center = [0, 0, 0, 0, 0, 0];
    if (model && model.calibrated) {
      w = model.w;
      theta = model.theta;
      sigmaW = model.sigmaW;
      center = model.center;
      gainScale = Math.min(3.5, Math.max(0.35, model.dPrimeOof));
    } else {
      w = getPriorWeights(grille, sonarActive);
      theta = 0;
      sigmaW = 1.0;
      gainScale = grille === 'left' ? 2.2 : (sonarActive ? 1.85 : 0.85);
    }

    var rawProj = 0;
    var contribs = new Float32Array(6);
    for (var d = 0; d < 6; d++) {
      var term = w[d] * (feat.scaledX[d] - center[d]);
      contribs[d] = term / sigmaW;
      rawProj += w[d] * feat.scaledX[d];
    }
    var zScore = (rawProj - theta) / sigmaW;
    var logit = gainScale * zScore;
    var probUp = 1 / (1 + Math.exp(-clamp(logit, -8, 8)));
    var dir = zScore >= 0 ? 'UP' : 'DOWN';
    var conf = dir === 'UP' ? probUp : (1 - probUp);

    return {
      dir: dir,
      zScore: zScore,
      probUp: probUp,
      confidence: conf,
      contribs: contribs,
      calibrated: !!(model && model.calibrated),
      dPrimeOof: model && model.calibrated ? model.dPrimeOof : null
    };
  }

  // --- Real-Time Streaming Detector State Machine (runs identically in Worklet, Fallback, or Node Tests) ---
  function createStreamEngine(sr) {
    var canSonar = sr >= 44100;
    var D = Math.max(1, Math.round(sr / 1000)); // ~1000 Hz decimated IQ rate
    var fbb = sr / D;
    var pHop = 4; // 4 baseband ticks (~4 ms) per passive frame

    var notch19k = createBiquad('notch', CARRIER_HZ, 12.0, sr);
    var lpCeil16k = createBiquad('lowpass', Math.min(16200, sr * 0.45), 0.707, sr);
    var bpSub = createBiquad('bandpass', 300, 0.8, sr);
    var bpMid = createBiquad('bandpass', 3200, 0.7, sr);
    var hpAir = createBiquad('highpass', Math.min(8200, sr * 0.36), 0.707, sr);
    var hpFric = createBiquad('highpass', 1000, 0.707, sr);
    var hpCrest = createBiquad('highpass', 1500, 0.707, sr);

    // 4th-order 160 Hz Butterworth anti-alias LPF before D-decimation
    var lpI1 = createBiquad('lowpass', 160, 0.5411961, sr);
    var lpI2 = createBiquad('lowpass', 160, 1.3065630, sr);
    var lpQ1 = createBiquad('lowpass', 160, 0.5411961, sr);
    var lpQ2 = createBiquad('lowpass', 160, 1.3065630, sr);

    // Matched 2-stage 19.0 kHz probe vs ~16.2 kHz guardband floor for >= +22 dB SNR across 44.1/48/96 kHz
    var bp19kProbe1 = createBiquad('bandpass', CARRIER_HZ, 18.0, sr);
    var bp19kProbe2 = createBiquad('bandpass', CARRIER_HZ, 18.0, sr);
    var guardFloorHz = Math.min(16200, sr * 0.40);
    var bp16kFloor1 = createBiquad('bandpass', guardFloorHz, 14.0, sr);
    var bp16kFloor2 = createBiquad('bandpass', guardFloorHz, 14.0, sr);

    var phi = 0;
    var dPhi = (2 * Math.PI * CARRIER_HZ) / sr;
    var gEnv = 0;
    var gTarget = 0;
    var alphaG = 1 - Math.exp(-1 / (0.020 * sr));

    // Pre-allocated 2.5s circular baseband buffer (~2500 samples) for zero-GC pre/post roll
    var RING_LEN = Math.max(2048, Math.ceil(fbb * 2.6));
    var ringI = new Float64Array(RING_LEN);
    var ringQ = new Float64Array(RING_LEN);
    var ringW = 0;
    var totalBb = 0;
    var delay60 = Math.max(8, Math.round(0.060 * fbb));
    var blankDurationBb = Math.max(32, Math.round(0.180 * fbb));

    var clutterI = 0, clutterQ = 0, clutterReady = false;
    var prevDelI = 0, prevDelQ = 0;
    var noiseAirDb = -75, noiseDopPow = 1e-10, noiseInit = false;

    var decCount = 0;
    var pTick = 0;
    var accSub = 0, accMid = 0, accAir = 0, accFric = 0, accCrestSq = 0, peakCrest = 0, pSamples = 0;

    var activeGateCount = 0;
    var quietCount = 0;
    var inStroke = false;
    var postRollLeft = 0;
    var sonarBlankLeft = 0;
    var postStrokeHoldoff = 0;
    var strokeStartBb = 0;
    var strokeEndBb = 0;
    var preGatePassive = [];
    var strokePassive = [];
    var strokeClutterI = 0, strokeClutterQ = 0;
    var strokeNoiseAirDb = -75, strokeNoiseDopPow = 1e-10;
    var blankDopSum = 0, blankDopN = 0;
    var sonarMode = false;

    var probeSamples = 0, probe19Pow = 0, probe17Pow = 0, probePending = false;

    function triggerGainBlanking() {
      sonarBlankLeft = blankDurationBb;
      blankDopSum = 0;
      blankDopN = 0;
      inStroke = false;
      activeGateCount = 0;
      quietCount = 0;
      postRollLeft = 0;
      preGatePassive = [];
      strokePassive = [];
      clutterReady = false;
    }

    return {
      canSonar: canSonar,
      fbb: fbb,
      getDebugState: function () {
        return {
          clutterI: clutterI,
          clutterQ: clutterQ,
          clutterReady: clutterReady,
          noiseAirDb: noiseAirDb,
          noiseDopPow: noiseDopPow,
          sonarBlankLeft: sonarBlankLeft
        };
      },
      setSonarTarget: function (enabled, gainVal, runProbe) {
        var nextSonar = !!(enabled && canSonar);
        var nextTarget = 0;
        if (!nextSonar) {
          nextTarget = 0;
          probePending = false;
        } else if (runProbe) {
          nextTarget = 0.03; // -30.5 dBFS safe 180 ms acoustic loopback check
          probeSamples = 0;
          probe19Pow = 0;
          probe17Pow = 0;
          bp19kProbe1.reset(0);
          bp19kProbe2.reset(0);
          bp16kFloor1.reset(0);
          bp16kFloor2.reset(0);
          probePending = true;
        } else {
          nextTarget = clamp(gainVal || 0.13, 0, 0.25);
          probePending = false;
        }
        if (Math.abs(nextTarget - gTarget) > 1e-6) {
          triggerGainBlanking();
        }
        sonarMode = nextSonar;
        gTarget = nextTarget;
      },
      processQuantum: function (inChan, outL, outR, callbacks) {
        var n = inChan ? inChan.length : (outR ? outR.length : 128);
        var operatingGain = (callbacks && callbacks.operatingGain) || 0.13;

        for (var i = 0; i < n; i++) {
          var x = inChan ? inChan[i] : 0;
          gEnv += alphaG * (gTarget - gEnv);
          var cosP = Math.cos(phi);
          var sinP = Math.sin(phi);
          phi += dPhi;
          if (phi >= 2 * Math.PI) phi -= 2 * Math.PI;

          if (outL) outL[i] = 0; // Left speaker strictly silent near upper-left 3-MEMS!
          if (outR) outR[i] = canSonar ? (gEnv * cosP) : 0;

          // 180 ms loopback probe check
          if (probePending) {
            var v19 = bp19kProbe2.step(bp19kProbe1.step(x));
            var v16 = bp16kFloor2.step(bp16kFloor1.step(x));
            if (probeSamples > Math.round(0.035 * sr)) {
              probe19Pow += v19 * v19;
              probe17Pow += v16 * v16;
            }
            probeSamples++;
            if (probeSamples >= Math.round(0.180 * sr)) {
              probePending = false;
              var snr19Db = 10 * Math.log10((probe19Pow + 1e-16) / (probe17Pow + 1e-16));
              if (snr19Db >= 8.0) {
                if (Math.abs(operatingGain - gTarget) > 1e-6) triggerGainBlanking();
                gTarget = operatingGain;
                if (callbacks && callbacks.onProbeResult) callbacks.onProbeResult(true, snr19Db);
              } else {
                if (gTarget > 1e-6) triggerGainBlanking();
                gTarget = 0;
                sonarMode = false;
                if (callbacks && callbacks.onProbeResult) callbacks.onProbeResult(false, snr19Db);
              }
            }
          }

          // Coherent homodyne IQ mix
          var iFilt = lpI2.step(lpI1.step(2.0 * x * cosP));
          var qFilt = lpQ2.step(lpQ1.step(-2.0 * x * sinP));

          // Pre-passive 19 kHz notch + 16.2 kHz ceiling before subbands & crest factor
          var xp = lpCeil16k.step(notch19k.step(x));
          var vs = bpSub.step(xp);
          var vm = bpMid.step(xp);
          var va = hpAir.step(xp);
          var vf = hpFric.step(xp);
          var vc = hpCrest.step(xp);

          accSub += vs * vs;
          accMid += vm * vm;
          accAir += va * va;
          accFric += vf * vf;
          accCrestSq += vc * vc;
          var absC = Math.abs(vc);
          if (absC > peakCrest) peakCrest = absC;
          pSamples++;

          decCount++;
          if (decCount >= D) {
            decCount = 0;
            ringI[ringW] = iFilt;
            ringQ[ringW] = qFilt;
            ringW = (ringW + 1) % RING_LEN;
            totalBb++;

            if (sonarBlankLeft > 0) {
              if (sonarBlankLeft <= 48 && totalBb >= 4) {
                var bPrevIdx = (ringW - 2 + RING_LEN) % RING_LEN;
                var bDi = iFilt - ringI[bPrevIdx];
                var bDq = qFilt - ringQ[bPrevIdx];
                blankDopSum += bDi * bDi + bDq * bDq;
                blankDopN++;
              }
              sonarBlankLeft--;
              clutterReady = false;
              inStroke = false;
              activeGateCount = 0;
              quietCount = 0;
              postRollLeft = 0;
              preGatePassive = [];
            }
            if (postStrokeHoldoff > 0) {
              postStrokeHoldoff--;
            }

            // 60 ms delayed clutter tracker (frozen whenever stroke, pre-gate, post-roll, or blanking active)
            var delIdx = (ringW - delay60 + RING_LEN) % RING_LEN;
            var delI = ringI[delIdx];
            var delQ = ringQ[delIdx];
            var baselineFrozen = inStroke || activeGateCount > 0 || postRollLeft > 0 || sonarBlankLeft > 0 || probePending;
            if (totalBb > delay60 + 20 && sonarBlankLeft === 0 && !probePending) {
              if (!clutterReady) {
                clutterI = iFilt;
                clutterQ = qFilt;
                prevDelI = delI;
                prevDelQ = delQ;
                if (blankDopN >= 8) {
                  noiseDopPow = Math.max(1e-12, (blankDopSum / blankDopN) * 1.25);
                  blankDopSum = 0;
                  blankDopN = 0;
                }
                clutterReady = true;
              } else if (!baselineFrozen && postStrokeHoldoff === 0) {
                clutterI += 0.025 * (delI - clutterI);
                clutterQ += 0.025 * (delQ - clutterQ);
                var stepDiffI = delI - prevDelI;
                var stepDiffQ = delQ - prevDelQ;
                var instDopNoise = stepDiffI * stepDiffI + stepDiffQ * stepDiffQ;
                noiseDopPow = 0.98 * noiseDopPow + 0.02 * instDopNoise;
              }
            }
            prevDelI = delI;
            prevDelQ = delQ;

            pTick++;
            if (pTick >= pHop) {
              pTick = 0;
              var invN = 1 / Math.max(1, pSamples);
              var eSub = accSub * invN;
              var eMid = accMid * invN;
              var eAir = accAir * invN;
              var eFric = accFric * invN;
              var rmsC = Math.sqrt(accCrestSq * invN + 1e-16);
              var crest = peakCrest / rmsC;

              // 3-band geometric/arithmetic spectral flatness proxy across Sub/Mid/Air
              var b1 = eSub + 1e-15, b2 = eMid + 1e-15, b3 = eAir + 1e-15;
              var sfm = Math.cbrt(b1 * b2 * b3) / ((b1 + b2 + b3) / 3);

              accSub = 0; accMid = 0; accAir = 0; accFric = 0; accCrestSq = 0; peakCrest = 0; pSamples = 0;

              var dbAir = 10 * Math.log10(eAir + 1e-15);
              if (!noiseInit && totalBb > 60 && sonarBlankLeft === 0 && !probePending) {
                noiseAirDb = dbAir;
                noiseInit = true;
              } else if (noiseInit && !baselineFrozen) {
                if (dbAir < noiseAirDb + 3.5) {
                  noiseAirDb = 0.96 * noiseAirDb + 0.04 * dbAir;
                } else {
                  noiseAirDb = 0.997 * noiseAirDb + 0.003 * dbAir;
                }
              }

              // Multi-modal gate evaluation
              var snrAir = noiseInit ? (dbAir - noiseAirDb) : 0;
              var curMag = Math.hypot(iFilt, qFilt);
              var clutMag = Math.hypot(clutterI, clutterQ);
              var dipDbLive = (sonarMode && clutterReady && sonarBlankLeft === 0 && clutMag > 1e-5)
                ? 20 * Math.log10((clutMag + 1e-9) / Math.max(clutMag * 0.05, curMag + 1e-9))
                : 0;
              var prevIdx = (ringW - 2 + RING_LEN) % RING_LEN;
              var dI = iFilt - ringI[prevIdx];
              var dQ = qFilt - ringQ[prevIdx];
              var dopSnrDb = (sonarMode && clutterReady && sonarBlankLeft === 0)
                ? 10 * Math.log10((dI * dI + dQ * dQ + 1e-16) / (noiseDopPow + 1e-16))
                : 0;

              var passiveTrig = snrAir > 6.2 && sfm > 0.16;
              var sonarTrig = sonarMode && clutterReady && sonarBlankLeft === 0 && (dipDbLive > 2.6 || dopSnrDb > 8.2);
              var holdTrig = (snrAir > 3.2) || (sonarMode && clutterReady && sonarBlankLeft === 0 && (dipDbLive > 1.3 || dopSnrDb > 4.5));

              // Live telemetry at ~62 Hz (every 4th passive frame ~16 ms)
              if (callbacks && callbacks.onTelemetry && (totalBb % 16 === 0)) {
                var fLive = clamp(Math.max((snrAir - 2) / 18, dipDbLive / 8, (dopSnrDb - 3) / 14), 0, 1);
                callbacks.onTelemetry({
                  fLive: fLive,
                  snrAir: snrAir,
                  dipDb: dipDbLive,
                  dopSnrDb: dopSnrDb,
                  inStroke: inStroke
                });
              }

              var pFrame = { eSub: eSub, eMid: eMid, eAir: eAir, eFric: eFric, crest: crest, sfm: sfm };

              if (!inStroke && postRollLeft === 0 && sonarBlankLeft === 0 && !probePending) {
                if (noiseInit && totalBb > delay60 + 30 && (passiveTrig || sonarTrig)) {
                  if (activeGateCount === 0) {
                    strokeClutterI = clutterI;
                    strokeClutterQ = clutterQ;
                    strokeNoiseAirDb = noiseAirDb;
                    strokeNoiseDopPow = noiseDopPow;
                    preGatePassive = [];
                  }
                  activeGateCount++;
                  if (activeGateCount < 4) {
                    preGatePassive.push(pFrame);
                  } else { // >= 16 ms sustained onset; prepend frames 1..3 so passive & baseband align 1:1
                    inStroke = true;
                    quietCount = 0;
                    strokeStartBb = totalBb - activeGateCount * pHop;
                    strokePassive = preGatePassive.slice();
                    preGatePassive = [];
                  }
                } else {
                  activeGateCount = 0;
                  preGatePassive = [];
                }
              }

              if (inStroke) {
                strokePassive.push(pFrame);
                if (!holdTrig) {
                  quietCount++;
                } else {
                  quietCount = 0;
                  postStrokeHoldoff = delay60 + 16;
                }

                var strokeDurMs = (strokePassive.length * pHop * 1000) / fbb;
                if (quietCount >= 7 || strokeDurMs >= 920) {
                  inStroke = false;
                  activeGateCount = 0;
                  preGatePassive = [];
                  var validPCount = Math.max(4, strokePassive.length - quietCount);
                  strokePassive = strokePassive.slice(0, validPCount);
                  strokeEndBb = strokeStartBb + validPCount * pHop;
                  postRollLeft = Math.min(48, Math.round(0.048 * fbb)); // 48 ms post-roll for zero-phase filtfilt
                  postStrokeHoldoff = delay60 + postRollLeft + 16;
                }
              } else if (postRollLeft > 0) {
                postRollLeft -= pHop;
                if (postRollLeft <= 0) {
                  postRollLeft = 0;
                  var prePad = Math.min(48, Math.round(0.048 * fbb));
                  var postPad = Math.min(48, Math.round(0.048 * fbb));
                  var rawLen = strokeEndBb - strokeStartBb;
                  var totalCopy = prePad + rawLen + postPad;
                  if (rawLen >= 16 && totalCopy < RING_LEN - 8) {
                    var copyI = new Float64Array(totalCopy);
                    var copyQ = new Float64Array(totalCopy);
                    var firstAbs = strokeStartBb - prePad;
                    for (var ci = 0; ci < totalCopy; ci++) {
                      var rPos = (ringW - 1 - (totalBb - 1 - (firstAbs + ci)) + RING_LEN * 4) % RING_LEN;
                      copyI[ci] = ringI[rPos];
                      copyQ[ci] = ringQ[rPos];
                    }
                    var feat = extractStrokeFeatures({
                      passiveFrames: strokePassive,
                      bbI: copyI,
                      bbQ: copyQ,
                      m0: prePad,
                      m1: prePad + rawLen,
                      fbb: fbb,
                      clutterI: strokeClutterI,
                      clutterQ: strokeClutterQ,
                      sonarActive: sonarMode,
                      noiseAirDb: strokeNoiseAirDb,
                      noiseDopPow: strokeNoiseDopPow,
                      durMs: (rawLen * 1000) / fbb
                    });
                    if (callbacks && callbacks.onStroke) callbacks.onStroke(feat);
                  }
                }
              }
            }
          }
        }
      }
    };
  }

  // --- Synthesize Authentic Mac16,5 Physical Reference Waveforms for Demo & Unit Tests ---
  function synthesizeMac16Stroke(opts) {
    var cfg = opts || {};
    var sr = cfg.sampleRate || 48000;
    var dir = cfg.dir || 'UP';
    var grille = cfg.grille || 'right';
    var sonarOn = cfg.sonarOn !== undefined ? cfg.sonarOn : true;
    var seedVal = cfg.seed || 1337;
    var kind = cfg.kind || 'swipe'; // 'swipe' | 'tap' | 'speech' | 'thump'
    var fresnelRad = typeof cfg.fresnelRad === 'number' ? cfg.fresnelRad : 0.9;

    var rng = function () {
      seedVal = (seedVal * 1664525 + 1013904223) >>> 0;
      var u1 = (seedVal + 1) / 4294967297;
      seedVal = (seedVal * 1664525 + 1013904223) >>> 0;
      var u2 = (seedVal + 1) / 4294967297;
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    };

    var totalSec = 0.85;
    var len = Math.floor(sr * totalSec);
    var out = new Float32Array(len);
    var s0 = Math.floor(sr * 0.26);
    var durSec = kind === 'tap' ? 0.028 : 0.27;
    var durN = Math.floor(sr * durSec);

    var lpSub = createBiquad('lowpass', 420, 0.9, sr);
    var bpMid = createBiquad('bandpass', 3400, 0.8, sr);
    var hpAir = createBiquad('highpass', Math.min(9200, sr * 0.40), 0.8, sr);

    var dPhiC = (2 * Math.PI * CARRIER_HZ) / sr;
    var phiC = 0;
    var echoPhi = 0.6;
    var canCarry = sonarOn && sr >= 44100;

    for (var i = 0; i < len; i++) {
      var sample = 0.00028 * rng();
      var inEvt = i >= s0 && i < s0 + durN;
      var u = inEvt ? (i - s0) / durN : 0;
      var env = inEvt ? Math.pow(Math.sin(Math.PI * u), 0.55) : 0;

      if (canCarry) {
        // Upper-half tweeter occlusion station (y_tw ~ 0.68 along stroke) + Fresnel phase shift
        var twStation = dir === 'UP' ? 0.68 : 0.32;
        var occ = (inEvt && kind === 'swipe' && grille === 'right')
          ? 0.48 * Math.exp(-Math.pow(u - twStation, 2) / 0.022)
          : 0;
        var fresnelShift = inEvt ? fresnelRad * Math.sin(Math.PI * u) : 0;
        var direct = 0.026 * (1 - occ) * Math.cos(phiC + fresnelShift * 0.08);
        phiC += dPhiC;
        if (phiC >= 2 * Math.PI) phiC -= 2 * Math.PI;

        var dopHz = (inEvt && kind === 'swipe' && grille === 'right')
          ? (dir === 'UP' ? +38 : -38)
          : 0;
        echoPhi += (2 * Math.PI * (CARRIER_HZ + dopHz)) / sr;
        // Include realistic near-field intensity bulge near tweeter station
        var nearBoost = inEvt ? (1 + 1.8 * Math.exp(-Math.pow(u - twStation, 2) / 0.03)) : 0.04;
        var echo = (inEvt && kind === 'swipe' ? 0.0032 * env * nearBoost : 0.0001) * Math.cos(echoPhi);
        sample += direct + echo;
      }

      if (inEvt) {
        var wn = rng();
        var vSub = lpSub.step(wn);
        var vMid = bpMid.step(wn);
        var vAir = hpAir.step(wn);

        if (kind === 'swipe' && grille === 'left') {
          var prox = dir === 'UP' ? (0.22 + 2.2 * u) : (2.42 - 2.2 * u);
          sample += env * (0.0035 * vSub + 0.012 * prox * vMid + 0.032 * prox * vAir);
        } else if (kind === 'swipe' && grille === 'right') {
          var yDeck = dir === 'UP' ? u : (1 - u); // 0=hollow palm plate, 1=stiff upper Touch ID/hinge rib
          var subG = 0.0034 * (1.35 - 0.58 * yDeck);
          var midG = 0.0024 * (0.88 + 0.28 * yDeck);
          var airG = 0.0030 * (0.68 + 0.68 * yDeck);
          // Finger extension push (UP) has slightly sharper late bristle micro-impulses
          var bristle = (i % Math.round(sr / 360) < 3) ? (dir === 'UP' ? 1.5 + u : 2.3 - u) * 0.0022 : 0;
          sample += env * (subG * vSub + midG * vMid + airG * vAir + bristle * (vMid + vAir));
        } else if (kind === 'tap') {
          sample += Math.exp(-u * 9) * (0.045 * vSub + 0.025 * vMid + 0.02 * vAir);
        } else if (kind === 'thump') {
          sample += env * (0.08 * vSub + 0.0005 * vAir);
        } else if (kind === 'speech') {
          var f0 = 155;
          sample += env * (0.035 * Math.sin((2 * Math.PI * f0 * i) / sr) +
            0.020 * Math.sin((4 * Math.PI * f0 * i) / sr) +
            0.009 * Math.sin((6 * Math.PI * f0 * i) / sr));
        }
      }
      out[i] = sample;
    }
    return out;
  }

  // --- Rank CoreAudio Input Devices (Lock onto MacBook Pro Microphone over DJI / Continuity / AirPods) ---
  function rankAudioInputDevice(label) {
    var l = String(label || '');
    if (/macbook\s*pro\s*microphone/i.test(l)) return 100;
    if (/macbook.*microphone/i.test(l)) return 95;
    if (/built-in.*mic|internal.*mic/i.test(l)) return 85;
    if (/dji|wireless\s*mic|iphone|ipad|continuity|airpods|bluetooth|usb|blackhole|loopback|hue\s*sync|virtual/i.test(l)) {
      return -100;
    }
    return 10;
  }

  // --- Generate Self-Contained AudioWorklet Source & Blob URL ---
  function buildWorkletSource() {
    return [
      'const CARRIER_HZ = ' + CARRIER_HZ + ';',
      'const FEATURE_SCALES = ' + JSON.stringify(FEATURE_SCALES) + ';',
      clamp.toString(),
      makeBiquadCoeffs.toString(),
      createBiquad.toString(),
      filtfiltReal.toString(),
      olsSlopeUnit.toString(),
      resampleCurve.toString(),
      extractStrokeFeatures.toString(),
      createStreamEngine.toString(),
      'class GrilleHomodyneProcessor extends AudioWorkletProcessor {',
      '  constructor() {',
      '    super();',
      '    this.engine = createStreamEngine(sampleRate);',
      '    this.operatingGain = 0.13;',
      '    this.port.onmessage = (ev) => {',
      '      const d = ev.data || {};',
      '      if (d.type === "config") {',
      '        if (typeof d.operatingGain === "number") this.operatingGain = d.operatingGain;',
      '        this.engine.setSonarTarget(!!d.sonar, this.operatingGain, !!d.probe);',
      '      }',
      '    };',
      '  }',
      '  process(inputs, outputs) {',
      '    const inCh = inputs[0] && inputs[0][0] ? inputs[0][0] : null;',
      '    const outL = outputs[0] && outputs[0][0] ? outputs[0][0] : null;',
      '    const outR = outputs[0] && outputs[0][1] ? outputs[0][1] : null;',
      '    this.engine.processQuantum(inCh, outL, outR, {',
      '      operatingGain: this.operatingGain,',
      '      onProbeResult: (ok, snrDb) => this.port.postMessage({ type: "probe", ok, snrDb }),',
      '      onTelemetry: (t) => this.port.postMessage({ type: "telemetry", data: t }),',
      '      onStroke: (feat) => this.port.postMessage({ type: "stroke", feat })',
      '    });',
      '    return true;',
      '  }',
      '}',
      'registerProcessor("grille-homodyne-processor", GrilleHomodyneProcessor);'
    ].join('\n');
  }

  function buildWorkletBlobUrl() {
    var src = buildWorkletSource();
    var blob = new Blob([src], { type: 'application/javascript' });
    return URL.createObjectURL(blob);
  }

  // =========================================================================
  // Interactive Browser UI Controller for Cell 06 (#cell-grille-swipe)
  // =========================================================================
  function mountCell(cellEl) {
    if (!cellEl || cellEl.dataset.agMounted === 'true') return null;
    cellEl.dataset.agMounted = 'true';

    var reducedMotionQuery = typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : { matches: false };

    var slotIndex = cellEl.parentElement
      ? Array.prototype.indexOf.call(cellEl.parentElement.children, cellEl) + 1
      : 6;
    var numPrefix = String(slotIndex > 0 ? slotIndex : 6).padStart(2, '0');

    cellEl.innerHTML = [
      '<div class="ag-shell" role="region" aria-label="16-inch MacBook Pro Right Grille Acoustic Swipe Instrument">',
      '  <header class="ag-header">',
      '    <span class="ag-led" data-state="idle" aria-hidden="true"></span>',
      '    <span class="ag-title">',
      '      <span class="ag-title-short">' + numPrefix + ' · RIGHT GRILLE</span>',
      '      <span class="ag-title-long">' + numPrefix + ' · MBP-16 RIGHT GRILLE</span>',
      '    </span>',
      '    <span class="ag-spacer"></span>',
      '    <span class="ag-vernier-mini ag-num">+0.0</span>',
      '    <div class="ag-mic-wrap" data-warn="false">',
      '      <select class="ag-mic-select" aria-label="Microphone input source" title="Microphone input source">',
      '        <option value="">MBP 3-Mic Array</option>',
      '      </select>',
      '    </div>',
      '    <div class="ag-demo-pair">',
      '      <button type="button" class="ag-btn ag-demo-up" title="Inject synthetic Right-Grille UP swipe">Demo ↑</button>',
      '      <button type="button" class="ag-btn ag-demo-dn" title="Inject synthetic Right-Grille DOWN swipe">Demo ↓</button>',
      '    </div>',
      '    <button type="button" class="ag-icon-btn ag-expand-btn" aria-expanded="false" aria-label="Expand Acoustic Workbench" title="Expand Acoustic Workbench">⤢</button>',
      '  </header>',
      '  <div class="ag-lab-strip">',
      '    <span class="ag-lab-badge ag-hw-status"><strong>HW:</strong> Unarmed · 3× MEMS Left (~/tab), 0 Right/Notch</span>',
      '    <span class="ag-lab-badge ag-loop-status"><strong>19kHz:</strong> Standby</span>',
      '    <label class="ag-gain-wrap"><span>Pilot</span><input type="range" class="ag-gain-slider" min="0.04" max="0.22" step="0.01" value="0.13"><span class="ag-num ag-gain-val">-18dB</span></label>',
      '    <button type="button" class="ag-btn ag-export-btn" title="Copy calibration & last stroke JSON">Copy JSON</button>',
      '  </div>',
      '  <div class="ag-workbench">',
      '    <div class="ag-primary-col">',
      '      <div class="ag-stage-well" tabindex="0" role="slider" aria-orientation="vertical" aria-label="Right speaker grille vertical louver scrubber" aria-valuemin="-10" aria-valuemax="10" aria-valuenow="0" aria-valuetext="+0.0 · Right Grille">',
      '        <div class="ag-canvas-wrap ag-stage-wrap"><canvas class="ag-stage-canvas"></canvas></div>',
      '        <div class="ag-toast" hidden><span class="ag-toast-text"></span><button type="button" class="ag-btn ag-toast-close">OK</button></div>',
      '      </div>',
      '      <div class="ag-cal-studio">',
      '        <div class="ag-cal-row">',
      '          <span><strong>4-Stroke LDA:</strong></span>',
      '          <button type="button" class="ag-btn ag-slot-btn" data-slot="0" data-dir="UP" aria-pressed="false" aria-label="Calibration stroke 1 (UP 1): empty">↑1</button>',
      '          <button type="button" class="ag-btn ag-slot-btn" data-slot="1" data-dir="UP" aria-pressed="false" aria-label="Calibration stroke 2 (UP 2): empty">↑2</button>',
      '          <button type="button" class="ag-btn ag-slot-btn" data-slot="2" data-dir="DOWN" aria-pressed="false" aria-label="Calibration stroke 3 (DOWN 1): empty">↓1</button>',
      '          <button type="button" class="ag-btn ag-slot-btn" data-slot="3" data-dir="DOWN" aria-pressed="false" aria-label="Calibration stroke 4 (DOWN 2): empty">↓2</button>',
      '          <button type="button" class="ag-btn ag-cal-reset" title="Clear calibration">Reset</button>',
      '          <span class="ag-spacer"></span>',
      '          <span class="ag-num ag-oof-verdict">Prior Mode</span>',
      '        </div>',
      '      </div>',
      '    </div>',
      '    <div class="ag-lab-col">',
      '      <div class="ag-panel">',
      '        <div class="ag-panel-head"><span><strong>STROKE TRAJECTORY</strong> s ∈ [0 → 1] · Fric/Tilt + 19k Dop/Occ</span><span class="ag-num ag-scope-meta">Idle</span></div>',
      '        <div class="ag-canvas-wrap ag-scope-wrap"><canvas class="ag-scope-canvas"></canvas></div>',
      '      </div>',
      '      <div class="ag-panel">',
      '        <div class="ag-panel-head"><span><strong>19.00 kHz MTI WATERFALL</strong> −100..+100 Hz</span><span class="ag-num ag-wf-meta">±15Hz Notch</span></div>',
      '        <div class="ag-canvas-wrap ag-wf-wrap"><canvas class="ag-wf-canvas"></canvas></div>',
      '      </div>',
      '      <div class="ag-panel">',
      '        <div class="ag-panel-head"><span><strong>FISHER LOG-ODDS</strong> wⱼ·(x̃ⱼ − c̃ⱼ)</span><span class="ag-num ag-lda-meta">← DN | UP →</span></div>',
      '        <div class="ag-canvas-wrap ag-lda-wrap"><canvas class="ag-lda-canvas"></canvas></div>',
      '      </div>',
      '    </div>',
      '  </div>',
      '  <footer class="ag-footer">',
      '    <button type="button" class="ag-btn ag-micro-cta"><span>Right Grille Lab</span><span>⤢</span></button>',
      '    <div class="ag-controls-bar">',
      '      <button type="button" class="ag-btn ag-arm-btn" data-armed="false">● Arm Mic</button>',
      '      <div class="ag-seg ag-seg-grille" role="group" aria-label="Target speaker grille">',
      '        <button type="button" class="ag-seg-btn" data-grille="right" aria-pressed="true" title="Right Speaker Grille (0 mics, ~31.7cm from left 3-mic array)">R Grille</button>',
      '        <button type="button" class="ag-seg-btn" data-grille="left" aria-pressed="false" title="Left Speaker Grille Control (3x MEMS under upper third)">L Ctrl</button>',
      '      </div>',
      '      <div class="ag-seg ag-seg-mode" role="group" aria-label="Acoustic sensing mode">',
      '        <button type="button" class="ag-seg-btn" data-mode="sonar" aria-pressed="true" title="19.0 kHz Hard-Right Tweeter Ultrasonic Sonar + Friction">19k Sonar</button>',
      '        <button type="button" class="ag-seg-btn" data-mode="passive" aria-pressed="false" title="Passive Perforation Friction & Chassis Tilt Only">Passive</button>',
      '      </div>',
      '      <button type="button" class="ag-btn ag-cal-btn" data-active="false" data-calibrated="false" title="Calibrate Right Grille with 2 UP + 2 DOWN strokes">Cal ↑↑↓↓</button>',
      '    </div>',
      '  </footer>',
      '</div>'
    ].join('\n');

    var els = {
      led: cellEl.querySelector('.ag-led'),
      vernierMini: cellEl.querySelector('.ag-vernier-mini'),
      micWrap: cellEl.querySelector('.ag-mic-wrap'),
      micSelect: cellEl.querySelector('.ag-mic-select'),
      demoUp: cellEl.querySelector('.ag-demo-up'),
      demoDn: cellEl.querySelector('.ag-demo-dn'),
      expandBtn: cellEl.querySelector('.ag-expand-btn'),
      microCta: cellEl.querySelector('.ag-micro-cta'),
      armBtn: cellEl.querySelector('.ag-arm-btn'),
      grilleBtns: cellEl.querySelectorAll('[data-grille]'),
      modeBtns: cellEl.querySelectorAll('[data-mode]'),
      calBtn: cellEl.querySelector('.ag-cal-btn'),
      slotBtns: cellEl.querySelectorAll('.ag-slot-btn'),
      calReset: cellEl.querySelector('.ag-cal-reset'),
      oofVerdict: cellEl.querySelector('.ag-oof-verdict'),
      hwStatus: cellEl.querySelector('.ag-hw-status'),
      loopStatus: cellEl.querySelector('.ag-loop-status'),
      gainSlider: cellEl.querySelector('.ag-gain-slider'),
      gainVal: cellEl.querySelector('.ag-gain-val'),
      exportBtn: cellEl.querySelector('.ag-export-btn'),
      stageWell: cellEl.querySelector('.ag-stage-well'),
      stageWrap: cellEl.querySelector('.ag-stage-wrap'),
      stageCanvas: cellEl.querySelector('.ag-stage-canvas'),
      scopeWrap: cellEl.querySelector('.ag-scope-wrap'),
      scopeCanvas: cellEl.querySelector('.ag-scope-canvas'),
      wfWrap: cellEl.querySelector('.ag-wf-wrap'),
      wfCanvas: cellEl.querySelector('.ag-wf-canvas'),
      ldaWrap: cellEl.querySelector('.ag-lda-wrap'),
      ldaCanvas: cellEl.querySelector('.ag-lda-canvas'),
      scopeMeta: cellEl.querySelector('.ag-scope-meta'),
      toast: cellEl.querySelector('.ag-toast'),
      toastText: cellEl.querySelector('.ag-toast-text'),
      toastClose: cellEl.querySelector('.ag-toast-close')
    };

    var LOUVER_N = 31;
    var WATERFALL_MAX_COLS = 36;
    var armGen = 0;
    var isDestroyed = false;
    var deviceChangeTimer = null;
    var demoSeedSeq = 0;
    var loadedCalKey = '';

    var state = {
      expanded: false,
      armed: false,
      grille: 'right',
      mode: 'sonar', // 'sonar' | 'passive'
      sonarCoupled: false,
      loopbackSnrDb: null,
      operatingGain: 0.13,
      micLabel: 'MacBook Pro Mic',
      selectedDeviceId: '',
      externalMicWarn: false,
      vernierTarget: 0,
      vernierPos: 0,
      vernierVel: 0,
      stationY: 0.5, // 0 = bottom palm plate, 1 = top stiff hinge
      fLive: 0,
      wavePhase: -1,
      waveDir: 'UP',
      lastResult: null,
      lastFeat: null,
      calActiveSlot: -1, // 0..3 when recording calibration
      calSlots: [null, null, null, null], // [UP1, UP2, DN1, DN2]
      ldaModel: null,
      waterfallCols: [], // ring of 36 Float32Array(33) columns
      louverAngle: new Float32Array(LOUVER_N),
      louverVel: new Float32Array(LOUVER_N),
      audioCtx: null,
      stream: null,
      sourceNode: null,
      procNode: null,
      workletUrl: null,
      idleSleepTimer: null,
      sonarSleeping: false,
      scrubDragging: false,
      lastDragY: 0
    };

    var sizes = {
      stage: { w: 300, h: 200 },
      scope: { w: 300, h: 120 },
      wf: { w: 300, h: 70 },
      lda: { w: 300, h: 90 }
    };

    function isSonarEffective() {
      return state.grille === 'right' && state.mode === 'sonar' && (!state.armed || state.sonarCoupled);
    }

    function effectiveCalMode() {
      if (state.grille === 'left' || state.mode !== 'sonar') return 'passive';
      if (state.armed && !state.sonarCoupled) return 'uncoupled';
      return 'sonar';
    }

    function storageKey() {
      return 'ag_lda_v1::' + state.grille + '::' + effectiveCalMode();
    }

    function saveCalibration() {
      try {
        if (!state.calSlots.every(Boolean)) return;
        var slim = state.calSlots.map(function (s) {
          return {
            scaledX: s.scaledX,
            fricCurve64: Array.from(s.fricCurve64),
            dopCurve64: Array.from(s.dopCurve64)
          };
        });
        loadedCalKey = storageKey();
        sessionStorage.setItem(loadedCalKey, JSON.stringify(slim));
      } catch (_) {}
    }

    function loadCalibration(forceReload) {
      var key = storageKey();
      if (!forceReload && key === loadedCalKey) {
        syncControlsUI();
        return;
      }
      loadedCalKey = key;
      state.calSlots = [null, null, null, null];
      state.ldaModel = null;
      state.calActiveSlot = -1;
      try {
        var raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(key) : null;
        if (raw) {
          var parsed = JSON.parse(raw);
          if (
            Array.isArray(parsed) &&
            parsed.length === 4 &&
            parsed.every(function (p) { return p && isValidScaledVec6(p.scaledX); })
          ) {
            var nextSlots = parsed.map(function (p) {
              var fc = new Float32Array(64);
              var dc = new Float32Array(64);
              if (Array.isArray(p.fricCurve64)) {
                for (var fi = 0; fi < Math.min(64, p.fricCurve64.length); fi++) {
                  fc[fi] = Number.isFinite(p.fricCurve64[fi]) ? p.fricCurve64[fi] : 0;
                }
              }
              if (Array.isArray(p.dopCurve64)) {
                for (var di = 0; di < Math.min(64, p.dopCurve64.length); di++) {
                  dc[di] = Number.isFinite(p.dopCurve64[di]) ? p.dopCurve64[di] : 0;
                }
              }
              return {
                scaledX: p.scaledX.slice(0, 6),
                fricCurve64: fc,
                dopCurve64: dc
              };
            });
            var candidateModel = fitShrinkageLDA(
              [nextSlots[0], nextSlots[1]],
              [nextSlots[2], nextSlots[3]],
              state.grille,
              isSonarEffective()
            );
            if (candidateModel) {
              state.calSlots = nextSlots;
              state.ldaModel = candidateModel;
            }
          }
        }
      } catch (_) {}
      syncControlsUI();
    }

    function recomputeCalibration() {
      if (state.calSlots[0] && state.calSlots[1] && state.calSlots[2] && state.calSlots[3]) {
        state.ldaModel = fitShrinkageLDA(
          [state.calSlots[0], state.calSlots[1]],
          [state.calSlots[2], state.calSlots[3]],
          state.grille,
          isSonarEffective()
        );
      } else {
        state.ldaModel = null;
      }
    }

    function showToast(msg, tone) {
      els.toastText.textContent = msg;
      els.toast.dataset.tone = tone || 'info';
      els.toast.hidden = false;
    }

    function hideToast() {
      els.toast.hidden = true;
    }

    function resetIdleWatchdog() {
      if (state.idleSleepTimer) {
        clearTimeout(state.idleSleepTimer);
        state.idleSleepTimer = null;
      }
      var canIdleSleep = state.armed &&
        state.mode === 'sonar' &&
        state.grille === 'right' &&
        state.sonarCoupled &&
        (typeof document === 'undefined' || !document.hidden);
      if (!canIdleSleep) {
        state.sonarSleeping = false;
        return;
      }
      if (state.sonarSleeping) {
        state.sonarSleeping = false;
        pushWorkletConfig(false);
        syncControlsUI();
      }
      state.idleSleepTimer = setTimeout(function () {
        state.idleSleepTimer = null;
        if (isDestroyed || !state.armed || state.mode !== 'sonar' || state.grille !== 'right' || !state.sonarCoupled) {
          return;
        }
        state.sonarSleeping = true;
        sendWorkletRaw({ type: 'config', sonar: false, operatingGain: state.operatingGain, probe: false });
        syncControlsUI();
      }, 60000);
    }

    function sendWorkletRaw(msg) {
      if (!state.procNode) return;
      if (state.procNode.port) {
        state.procNode.port.postMessage(msg);
      } else if (state.procNode._fallbackUpdate) {
        state.procNode._fallbackUpdate(msg);
      }
    }

    function pushWorkletConfig(runProbe) {
      var canTrySonar = state.armed &&
        state.mode === 'sonar' &&
        state.grille === 'right' &&
        (!state.audioCtx || state.audioCtx.sampleRate >= 44100);
      var wantSonar = canTrySonar && (!!runProbe || state.sonarCoupled) && !state.sonarSleeping;
      sendWorkletRaw({
        type: 'config',
        sonar: wantSonar,
        operatingGain: state.operatingGain,
        probe: !!(wantSonar && runProbe)
      });
    }

    function teardownActiveAudio(silent) {
      state.armed = false;
      state.sonarCoupled = false;
      state.sonarSleeping = false;
      state.fLive = 0;
      if (state.idleSleepTimer) {
        clearTimeout(state.idleSleepTimer);
        state.idleSleepTimer = null;
      }
      sendWorkletRaw({ type: 'config', sonar: false, operatingGain: 0, probe: false });
      if (state.procNode) {
        if (state.procNode.port) state.procNode.port.onmessage = null;
        state.procNode.onprocessorerror = null;
        state.procNode.onaudioprocess = null;
        state.procNode._fallbackUpdate = null;
        try { state.procNode.disconnect(); } catch (_) {}
        state.procNode = null;
      }
      if (state.sourceNode) {
        try { state.sourceNode.disconnect(); } catch (_) {}
        state.sourceNode = null;
      }
      if (state.stream) {
        state.stream.getTracks().forEach(function (t) {
          try { t.stop(); } catch (_) {}
        });
        state.stream = null;
      }
      var oldCtx = state.audioCtx;
      state.audioCtx = null;
      if (state.workletUrl) {
        try { URL.revokeObjectURL(state.workletUrl); } catch (_) {}
        state.workletUrl = null;
      }
      if (!silent && !isDestroyed) {
        loadCalibration(false);
        syncControlsUI();
      }
      if (oldCtx && oldCtx.state !== 'closed') {
        return Promise.resolve().then(function () { return oldCtx.close(); }).catch(function () {});
      }
      return Promise.resolve();
    }

    // --- Two-Phase CoreAudio Built-In Mic Lock & Race-Proof Audio Pipeline Startup ---
    async function armAudio(explicitDeviceId) {
      if (isDestroyed) return;
      var gen = ++armGen;
      hideToast();

      if (typeof window !== 'undefined' && !window.isSecureContext) {
        showToast('Mic needs localhost/HTTPS (python3 -m http.server 8000). Use Demo ↑↓ meanwhile.', 'warn');
        return;
      }
      if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast('Browser lacks getUserMedia support. Use Demo ↑↓ to inspect strokes.', 'warn');
        return;
      }

      var localStream = null;
      var localCtx = null;
      var localWorkletUrl = null;
      var isStale = function () {
        return gen !== armGen || isDestroyed;
      };
      var cleanupLocal = function () {
        if (localStream) {
          localStream.getTracks().forEach(function (t) {
            try { t.stop(); } catch (_) {}
          });
          localStream = null;
        }
        if (localCtx) {
          try {
            if (localCtx.state !== 'closed') {
              Promise.resolve(localCtx.close()).catch(function () {});
            }
          } catch (_) {}
          localCtx = null;
        }
        if (localWorkletUrl) {
          try { URL.revokeObjectURL(localWorkletUrl); } catch (_) {}
          localWorkletUrl = null;
        }
      };

      try {
        await teardownActiveAudio(true);
        if (isStale()) { cleanupLocal(); return; }

        var makeConstraints = function (devId, strictExact) {
          var flag = strictExact ? { exact: false } : false;
          var audio = {
            echoCancellation: flag,
            noiseSuppression: flag,
            autoGainControl: flag,
            channelCount: { ideal: 1 },
            sampleRate: { ideal: 48000 }
          };
          if (devId) audio.deviceId = { exact: devId };
          return { audio: audio };
        };

        try {
          localStream = await navigator.mediaDevices.getUserMedia(makeConstraints(explicitDeviceId, true));
        } catch (_) {
          if (isStale()) { cleanupLocal(); return; }
          localStream = await navigator.mediaDevices.getUserMedia(makeConstraints(explicitDeviceId, false));
        }
        if (isStale()) { cleanupLocal(); return; }

        // Enumerate devices now that labels are unlocked, and auto-switch off DJI / iPhone / AirPods!
        var devices = navigator.mediaDevices.enumerateDevices
          ? await navigator.mediaDevices.enumerateDevices()
          : [];
        if (isStale()) { cleanupLocal(); return; }

        var inputs = devices.filter(function (d) { return d.kind === 'audioinput'; });
        var outputs = devices.filter(function (d) { return d.kind === 'audiooutput'; });

        if (!explicitDeviceId && inputs.length > 0) {
          var best = inputs[0];
          var bestScore = rankAudioInputDevice(best.label);
          for (var i = 1; i < inputs.length; i++) {
            var sc = rankAudioInputDevice(inputs[i].label);
            if (sc > bestScore) {
              best = inputs[i];
              bestScore = sc;
            }
          }
          var curTrack = localStream.getAudioTracks()[0];
          var curSettings = curTrack && curTrack.getSettings ? curTrack.getSettings() : {};
          if (
            best &&
            best.deviceId &&
            curSettings.deviceId &&
            best.deviceId !== curSettings.deviceId &&
            bestScore > rankAudioInputDevice(curTrack.label)
          ) {
            localStream.getTracks().forEach(function (t) {
              try { t.stop(); } catch (_) {}
            });
            localStream = null;
            try {
              localStream = await navigator.mediaDevices.getUserMedia(makeConstraints(best.deviceId, true));
            } catch (_) {
              if (isStale()) { cleanupLocal(); return; }
              localStream = await navigator.mediaDevices.getUserMedia(makeConstraints(best.deviceId, false));
            }
            if (isStale()) { cleanupLocal(); return; }
          }
        }

        var AudioCtx = window.AudioContext || window.webkitAudioContext;
        try {
          localCtx = new AudioCtx({ latencyHint: 'interactive', sampleRate: 48000 });
        } catch (_) {
          localCtx = new AudioCtx({ latencyHint: 'interactive' });
        }
        if (localCtx.state === 'suspended') {
          await localCtx.resume();
          if (isStale()) { cleanupLocal(); return; }
        }

        // Pin output sink to MacBook Pro Speakers when supported (Chromium)
        if (typeof localCtx.setSinkId === 'function' && outputs.length > 0) {
          var mbpSpk = outputs.find(function (o) {
            return /macbook\s*pro\s*speakers|built-in\s*output|internal\s*speakers/i.test(o.label);
          });
          if (mbpSpk && mbpSpk.deviceId) {
            try { await localCtx.setSinkId(mbpSpk.deviceId); } catch (_) {}
            if (isStale()) { cleanupLocal(); return; }
          }
        }

        var src = localCtx.createMediaStreamSource(localStream);

        var handleMsg = function (msg) {
          if (!msg || gen !== armGen || isDestroyed || !state.armed) return;
          if (msg.type === 'probe') {
            state.loopbackSnrDb = msg.snrDb;
            var prevCoupled = state.sonarCoupled;
            state.sonarCoupled = !!msg.ok;
            if (prevCoupled !== state.sonarCoupled) {
              var wasCalibrating = state.calActiveSlot >= 0;
              loadCalibration(false);
              if (wasCalibrating && state.calActiveSlot < 0) {
                state.calSlots = [null, null, null, null];
                state.ldaModel = null;
                state.calActiveSlot = 0;
              }
            }
            if (!msg.ok && state.mode === 'sonar') {
              showToast('19 kHz uncoupled (' + msg.snrDb.toFixed(1) + ' dB — check Mute / Headphones / Voice Isolation). Using Passive weights.', 'warn');
            }
            syncControlsUI();
            resetIdleWatchdog();
          } else if (msg.type === 'telemetry') {
            state.fLive = msg.data.fLive;
            if (msg.data.inStroke && state.sonarSleeping) resetIdleWatchdog();
          } else if (msg.type === 'stroke') {
            onDetectedStroke(msg.feat, false);
          }
        };

        // Preferred: Coherent Single-Worklet TX+RX; Fallback: ScriptProcessorNode(512, 1, 2)
        var procNode = null;
        if (
          localCtx.audioWorklet &&
          typeof Blob !== 'undefined' &&
          typeof URL !== 'undefined' &&
          typeof AudioWorkletNode !== 'undefined'
        ) {
          try {
            localWorkletUrl = buildWorkletBlobUrl();
            await localCtx.audioWorklet.addModule(localWorkletUrl);
            if (isStale()) {
              try { src.disconnect(); } catch (_) {}
              cleanupLocal();
              return;
            }
            var wNode = new AudioWorkletNode(localCtx, 'grille-homodyne-processor', {
              numberOfInputs: 1,
              numberOfOutputs: 1,
              outputChannelCount: [2]
            });
            wNode.port.onmessage = function (ev) { handleMsg(ev.data); };
            wNode.onprocessorerror = function () {
              if (gen !== armGen || isDestroyed) return;
              disarmAudio(false);
              showToast('AudioWorklet processor halted unexpectedly — disarmed microphone.', 'warn');
            };
            src.connect(wNode);
            wNode.connect(localCtx.destination);
            procNode = wNode;
          } catch (_) {
            if (localWorkletUrl) {
              try { URL.revokeObjectURL(localWorkletUrl); } catch (_) {}
              localWorkletUrl = null;
            }
            if (isStale()) {
              try { src.disconnect(); } catch (_) {}
              cleanupLocal();
              return;
            }
            procNode = null;
          }
        }

        if (!procNode) {
          var engine = createStreamEngine(localCtx.sampleRate);
          var sp = localCtx.createScriptProcessor(512, 1, 2);
          var opGain = state.operatingGain;
          sp._fallbackUpdate = function (d) {
            if (typeof d.operatingGain === 'number') opGain = d.operatingGain;
            engine.setSonarTarget(!!d.sonar, opGain, !!d.probe);
          };
          sp.onaudioprocess = function (ev) {
            if (gen !== armGen || isDestroyed) return;
            var inCh = ev.inputBuffer.getChannelData(0);
            var outL = ev.outputBuffer.getChannelData(0);
            var outR = ev.outputBuffer.getChannelData(1);
            engine.processQuantum(inCh, outL, outR, {
              operatingGain: opGain,
              onProbeResult: function (ok, snrDb) { handleMsg({ type: 'probe', ok: ok, snrDb: snrDb }); },
              onTelemetry: function (t) { handleMsg({ type: 'telemetry', data: t }); },
              onStroke: function (feat) { handleMsg({ type: 'stroke', feat: feat }); }
            });
          };
          src.connect(sp);
          sp.connect(localCtx.destination);
          procNode = sp;
        }

        populateDevicePicker(inputs, localStream);

        var track = localStream.getAudioTracks()[0];
        var settings = track && track.getSettings ? track.getSettings() : {};
        state.micLabel = (track && track.label) ? track.label : 'Built-in Microphone';
        state.selectedDeviceId = settings.deviceId || explicitDeviceId || '';
        state.externalMicWarn = rankAudioInputDevice(state.micLabel) < 0;

        state.audioCtx = localCtx;
        state.stream = localStream;
        state.sourceNode = src;
        state.procNode = procNode;
        state.workletUrl = localWorkletUrl;
        localCtx = null;
        localStream = null;
        localWorkletUrl = null;

        state.armed = true;
        state.sonarSleeping = false;
        var sampleRateFallback = false;
        if (state.audioCtx.sampleRate < 44100) {
          state.mode = 'passive';
          state.sonarCoupled = false;
          sampleRateFallback = true;
          loadCalibration(false);
        } else {
          state.sonarCoupled = state.mode === 'sonar' && state.grille === 'right';
          loadCalibration(false);
        }

        var runProbe = state.sonarCoupled;
        pushWorkletConfig(runProbe);
        syncControlsUI();
        resetIdleWatchdog();

        if (sampleRateFallback) {
          showToast('Sample rate ' + state.audioCtx.sampleRate + ' Hz < 44.1 kHz (Bluetooth HFP?). Switched to Passive.', 'warn');
        } else if (state.externalMicWarn) {
          showToast('External mic active (' + state.micLabel + '). Select MacBook Pro Microphone above.', 'warn');
        }
      } catch (err) {
        cleanupLocal();
        if (isStale()) return;
        await teardownActiveAudio(true);
        syncControlsUI();
        showToast('Microphone access blocked (' + (err && err.name ? err.name : 'Error') + '). Try Demo ↑↓.', 'warn');
      }
    }

    async function disarmAudio(silent) {
      armGen++;
      if (deviceChangeTimer) {
        clearTimeout(deviceChangeTimer);
        deviceChangeTimer = null;
      }
      await teardownActiveAudio(silent);
    }

    function populateDevicePicker(inputs, activeStream) {
      var activeTrack = activeStream && activeStream.getAudioTracks()[0];
      var activeId = activeTrack && activeTrack.getSettings ? activeTrack.getSettings().deviceId : '';
      els.micSelect.innerHTML = '';
      if (!inputs || inputs.length === 0) {
        var opt0 = document.createElement('option');
        opt0.value = '';
        opt0.textContent = 'MBP 3-Mic Array';
        els.micSelect.appendChild(opt0);
        return;
      }
      var sorted = inputs.slice().sort(function (a, b) {
        return rankAudioInputDevice(b.label) - rankAudioInputDevice(a.label);
      });
      for (var i = 0; i < sorted.length; i++) {
        var d = sorted[i];
        var opt = document.createElement('option');
        opt.value = d.deviceId;
        var cleanLabel = (d.label || ('Mic ' + (i + 1)))
          .replace(/MacBook Pro Microphone/i, 'MBP 3-Mic')
          .replace(/\s*\([^)]*\)\s*/g, ' ')
          .trim();
        var bad = rankAudioInputDevice(d.label) < 0;
        opt.textContent = (bad ? '▲ ' : '● ') + cleanLabel;
        if (d.deviceId === activeId) opt.selected = true;
        els.micSelect.appendChild(opt);
      }
    }

    // --- Handle Live or Synthetic Stroke Classification + Calibration ---
    function onDetectedStroke(feat, isSynthetic) {
      resetIdleWatchdog();

      // Veto checks
      if (feat.isTapVeto || feat.isThumpVeto || feat.isSpeechVeto) {
        if (state.calActiveSlot >= 0) {
          var reason = feat.isTapVeto ? 'Tap (<88ms) ignored — glide smoothly along grille.'
            : feat.isThumpVeto ? 'Low-freq desk thump ignored — brush perforations lightly.'
              : 'Voice harmonic ignored — swipe speaker grille.';
          showToast(reason, 'warn');
        }
        return;
      }

      if (state.grille === 'right' && feat.isNearLeftGrille && !isSynthetic) {
        showToast('Near-field Left Grille 3-Mic overload detected! Swipe the RIGHT grille (or switch to L Ctrl).', 'warn');
        if (state.calActiveSlot >= 0) return;
      }

      state.lastFeat = feat;
      state.waterfallCols.push(feat.specBins);
      if (state.waterfallCols.length > WATERFALL_MAX_COLS) state.waterfallCols.shift();

      // Guided 4-Stroke Calibration capture
      if (state.calActiveSlot >= 0) {
        var slot = state.calActiveSlot;
        state.calSlots[slot] = feat;
        var nextMissing = state.calSlots.findIndex(function (s) { return !s; });
        state.calActiveSlot = nextMissing;
        if (nextMissing === -1) {
          recomputeCalibration();
          saveCalibration();
          hideToast();
        }
      }

      var sonarEff = isSonarEffective();
      var res = classifyStroke(feat, state.ldaModel, state.grille, sonarEff);
      state.lastResult = res;

      // Drive kinetic 31-louver directional wave & Vernier carriage
      var stepDelta = res.dir === 'UP' ? +1.0 : -1.0;
      state.vernierTarget = clamp(Math.round((state.vernierTarget + stepDelta) * 2) / 2, -10, 10);
      state.stationY = res.dir === 'UP' ? 0.84 : 0.16;
      state.waveDir = res.dir;
      state.wavePhase = 0;

      if (reducedMotionQuery.matches) {
        state.vernierPos = state.vernierTarget;
        state.vernierVel = 0;
        state.wavePhase = -1;
      }

      syncControlsUI();
    }

    function injectDemoStroke(dir) {
      var sonarOn = isSonarEffective();
      var engine = createStreamEngine(48000);
      engine.setSonarTarget(sonarOn, 0.13, false);
      demoSeedSeq = (demoSeedSeq + 1) >>> 0;
      var seed = (((Date.now() & 0xffff) + demoSeedSeq * 7919 + (dir === 'UP' ? 17 : 53)) >>> 0) || 1;
      var buf = synthesizeMac16Stroke({
        sampleRate: 48000,
        dir: dir,
        grille: state.grille,
        sonarOn: sonarOn,
        seed: seed
      });
      var outL = new Float32Array(128);
      var outR = new Float32Array(128);
      var captured = null;
      for (var off = 0; off < buf.length; off += 128) {
        var slice = buf.subarray(off, Math.min(buf.length, off + 128));
        engine.processQuantum(slice, outL, outR, {
          operatingGain: 0.13,
          onStroke: function (f) { captured = f; }
        });
      }
      if (captured) onDetectedStroke(captured, true);
    }

    function syncControlsUI() {
      var sonarLive = state.armed && state.mode === 'sonar' && state.grille === 'right' && state.sonarCoupled && !state.sonarSleeping;
      els.led.dataset.state = !state.armed ? 'idle' : (state.externalMicWarn ? 'warn' : (sonarLive ? 'sonar' : 'live'));
      els.micWrap.dataset.warn = state.externalMicWarn ? 'true' : 'false';

      els.armBtn.dataset.armed = state.armed ? 'true' : 'false';
      els.armBtn.textContent = state.armed ? '■ Live' : '● Arm Mic';

      els.grilleBtns.forEach(function (b) {
        b.setAttribute('aria-pressed', b.dataset.grille === state.grille ? 'true' : 'false');
      });
      els.modeBtns.forEach(function (b) {
        b.setAttribute('aria-pressed', b.dataset.mode === state.mode ? 'true' : 'false');
      });

      var calDone = !!(state.ldaModel && state.ldaModel.calibrated);
      els.calBtn.dataset.active = state.calActiveSlot >= 0 ? 'true' : 'false';
      els.calBtn.dataset.calibrated = (calDone && state.calActiveSlot < 0) ? 'true' : 'false';
      if (state.calActiveSlot >= 0) {
        var prompts = ['Swipe ↑ 1/4', 'Swipe ↑ 2/4', 'Swipe ↓ 3/4', 'Swipe ↓ 4/4'];
        els.calBtn.textContent = prompts[state.calActiveSlot];
      } else if (calDone) {
        els.calBtn.textContent = "Cal ✓ d'" + state.ldaModel.dPrimeOof.toFixed(1);
      } else {
        els.calBtn.textContent = 'Cal ↑↑↓↓';
      }

      els.slotBtns.forEach(function (sb) {
        var idx = Number(sb.dataset.slot);
        var filled = !!state.calSlots[idx];
        var rec = state.calActiveSlot === idx;
        var dirLabel = sb.dataset.dir === 'UP' ? 'UP' : 'DOWN';
        var numInDir = (idx % 2) + 1;
        sb.dataset.filled = filled ? 'true' : 'false';
        sb.dataset.recording = rec ? 'true' : 'false';
        sb.setAttribute('aria-pressed', rec ? 'true' : 'false');
        sb.setAttribute(
          'aria-label',
          'Calibration stroke ' + (idx + 1) + ' (' + dirLabel + ' ' + numInDir + '): ' +
            (rec ? 'recording' : (filled ? 'captured' : 'empty'))
        );
      });

      if (calDone) {
        var dp = state.ldaModel.dPrimeOof;
        var verd = dp >= 1.6 ? 'Locked' : (dp >= 0.9 ? 'Usable' : 'Marginal');
        els.oofVerdict.textContent = "d'_OOF " + dp.toFixed(2) + ' · ' + verd;
      } else if (state.grille === 'left') {
        els.oofVerdict.textContent = 'Left 3-Mic Prior (High)';
      } else if (state.mode === 'sonar' && (!state.armed || state.sonarCoupled)) {
        els.oofVerdict.textContent = '19kHz Sonar Prior';
      } else if (state.mode === 'sonar') {
        els.oofVerdict.textContent = 'Uncoupled Passive Prior';
      } else {
        els.oofVerdict.textContent = 'Passive Prior (Δ4.5% Low)';
      }

      if (state.armed && state.audioCtx) {
        var srK = (state.audioCtx.sampleRate / 1000).toFixed(1) + 'kHz';
        els.hwStatus.innerHTML = '<strong>HW:</strong> ' + escapeHtml(state.micLabel) + ' · ' + srK + ' · EC/NS/AGC:OFF';
      } else {
        els.hwStatus.innerHTML = '<strong>HW:</strong> Unarmed · 3× MEMS Left (~/tab), 0 Right/Notch';
      }

      if (!state.armed) {
        els.loopStatus.innerHTML = '<strong>19kHz:</strong> Standby (Right Tweeter R+1.0)';
      } else if (state.grille === 'left' || state.mode === 'passive') {
        els.loopStatus.innerHTML = '<strong>19kHz:</strong> Muted (Passive Mode)';
      } else if (state.sonarCoupled) {
        if (state.sonarSleeping) {
          els.loopStatus.innerHTML = '<strong>19kHz:</strong> Idle Sleep (swipe or click to wake)';
        } else {
          var snrTxt = state.loopbackSnrDb !== null ? ('+' + state.loopbackSnrDb.toFixed(1) + ' dB') : 'Locked';
          els.loopStatus.innerHTML = '<strong>19kHz:</strong> Coupled (' + snrTxt + ' R+1.0)';
        }
      } else {
        els.loopStatus.innerHTML = '<strong>19kHz:</strong> Uncoupled (Fallback Passive)';
      }

      var vSign = state.vernierTarget >= 0 ? '+' : '';
      var vTxt = vSign + state.vernierTarget.toFixed(1);
      els.vernierMini.textContent = vTxt;
      els.stageWell.setAttribute('aria-valuenow', String(state.vernierTarget));
      var ariaCtx = state.lastResult
        ? ((state.lastResult.dir === 'UP' ? 'UP ' : 'DOWN ') + Math.round(state.lastResult.confidence * 100) + '%')
        : (state.grille === 'right' ? 'Right Grille' : 'Left Grille');
      els.stageWell.setAttribute('aria-valuetext', vTxt + ' · ' + ariaCtx);

      if (state.lastResult) {
        var arrow = state.lastResult.dir === 'UP' ? '↑ UP ' : '↓ DN ';
        var pct = Math.round(state.lastResult.confidence * 100) + '%';
        els.microCta.innerHTML = '<span class="ag-num">' + arrow + pct + '</span><span>⤢</span>';
        els.scopeMeta.textContent = arrow + pct + ' · ' + Math.round(state.lastFeat.durMs) + 'ms';
      } else {
        els.microCta.innerHTML = '<span>Right Grille Lab</span><span>⤢</span>';
      }
      requestRender();
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    var placeholderEl = null;
    var expandToken = 0;

    function applyExpandDOM(targetExpanded) {
      var activeExp = !!(targetExpanded && !isDestroyed);
      if (activeExp) {
        if (!placeholderEl && cellEl.parentElement) {
          placeholderEl = document.createElement('div');
          placeholderEl.className = 'cell ag-grid-placeholder';
          placeholderEl.setAttribute('aria-hidden', 'true');
          cellEl.parentElement.insertBefore(placeholderEl, cellEl);
        }
        cellEl.classList.add('is-expanded');
      } else {
        cellEl.classList.remove('is-expanded');
        if (placeholderEl && placeholderEl.parentElement) {
          placeholderEl.parentElement.removeChild(placeholderEl);
        }
        placeholderEl = null;
      }
      var expLabel = activeExp ? 'Collapse Acoustic Workbench (Esc)' : 'Expand Acoustic Workbench';
      els.expandBtn.setAttribute('aria-expanded', activeExp ? 'true' : 'false');
      els.expandBtn.setAttribute('aria-label', expLabel);
      els.expandBtn.title = expLabel;
      els.expandBtn.textContent = activeExp ? '⤡' : '⤢';
      if (!isDestroyed) requestRender();
    }

    // --- Toggle Expanded Empirical Workbench (Zero Sibling Grid Reflow & Race-Safe ViewTransition) ---
    function toggleExpand(forceVal) {
      if (isDestroyed && forceVal !== false) return;
      var next = typeof forceVal === 'boolean' ? forceVal : !state.expanded;
      if (next === state.expanded) return;
      state.expanded = next;
      var tok = ++expandToken;

      if (
        !isDestroyed &&
        typeof document !== 'undefined' &&
        typeof document.startViewTransition === 'function' &&
        !reducedMotionQuery.matches
      ) {
        try {
          var vt = document.startViewTransition(function () {
            if (tok !== expandToken && !isDestroyed) {
              applyExpandDOM(state.expanded);
              return;
            }
            applyExpandDOM(state.expanded);
          });
          if (vt) {
            if (vt.ready && typeof vt.ready.catch === 'function') vt.ready.catch(function () {});
            if (vt.finished && typeof vt.finished.catch === 'function') vt.finished.catch(function () {});
            if (vt.updateCallbackDone && typeof vt.updateCallbackDone.catch === 'function') vt.updateCallbackDone.catch(function () {});
          }
        } catch (_) {
          applyExpandDOM(state.expanded);
        }
      } else {
        applyExpandDOM(state.expanded);
      }
    }

    // --- Event Listeners ---
    cellEl.addEventListener('click', function (ev) {
      if (state.sonarSleeping && state.armed && (!els.armBtn || !els.armBtn.contains(ev.target))) {
        resetIdleWatchdog();
      }
    });

    els.armBtn.addEventListener('click', function () {
      if (state.armed) disarmAudio(false);
      else armAudio('');
    });

    els.micSelect.addEventListener('change', function () {
      if (els.micSelect.value) armAudio(els.micSelect.value);
    });

    els.grilleBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.grille = btn.dataset.grille;
        if (state.armed) {
          if (state.grille === 'right' && state.mode === 'sonar' && state.audioCtx && state.audioCtx.sampleRate >= 44100) {
            state.sonarSleeping = false;
            var needProbe = !state.sonarCoupled;
            if (needProbe) state.sonarCoupled = true;
            pushWorkletConfig(needProbe);
          } else {
            state.sonarSleeping = false;
            pushWorkletConfig(false);
          }
        }
        resetIdleWatchdog();
        loadCalibration(false);
        syncControlsUI();
      });
    });

    els.modeBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.mode = btn.dataset.mode;
        if (state.armed) {
          if (state.mode === 'sonar' && state.grille === 'right' && state.audioCtx && state.audioCtx.sampleRate >= 44100) {
            state.sonarSleeping = false;
            var needProbe = !state.sonarCoupled;
            if (needProbe) state.sonarCoupled = true;
            pushWorkletConfig(needProbe);
          } else {
            state.sonarSleeping = false;
            pushWorkletConfig(false);
          }
        }
        resetIdleWatchdog();
        loadCalibration(false);
        syncControlsUI();
      });
    });

    els.calBtn.addEventListener('click', function () {
      if (state.calActiveSlot >= 0) {
        state.calActiveSlot = -1;
      } else {
        state.calSlots = [null, null, null, null];
        state.ldaModel = null;
        state.calActiveSlot = 0;
        if (!state.armed) {
          var cellW = cellEl.clientWidth || 0;
          if (state.expanded || cellW >= 500) {
            showToast('Calibrating: Arm Mic for live grille swipes, or click Demo ↑ / Demo ↓ 2× each.', 'info');
          } else {
            showToast('Calibrating: Arm Mic for live swipes, press ↑ / ↓ keys 2×, or open ⤢ Workbench.', 'info');
          }
        }
      }
      syncControlsUI();
    });

    els.slotBtns.forEach(function (sb) {
      sb.addEventListener('click', function () {
        state.calActiveSlot = Number(sb.dataset.slot);
        syncControlsUI();
      });
    });

    els.calReset.addEventListener('click', function () {
      state.calSlots = [null, null, null, null];
      state.ldaModel = null;
      state.calActiveSlot = -1;
      try { sessionStorage.removeItem(storageKey()); } catch (_) {}
      syncControlsUI();
    });

    els.demoUp.addEventListener('click', function () { injectDemoStroke('UP'); });
    els.demoDn.addEventListener('click', function () { injectDemoStroke('DOWN'); });
    els.expandBtn.addEventListener('click', function () { toggleExpand(); });
    els.microCta.addEventListener('click', function () { toggleExpand(true); });
    els.toastClose.addEventListener('click', hideToast);

    els.gainSlider.addEventListener('input', function () {
      state.operatingGain = parseFloat(els.gainSlider.value) || 0.13;
      var db = Math.round(20 * Math.log10(state.operatingGain));
      els.gainVal.textContent = db + 'dB';
      if (state.armed && state.sonarCoupled) {
        state.sonarSleeping = false;
        pushWorkletConfig(false);
        resetIdleWatchdog();
        syncControlsUI();
      }
    });

    els.exportBtn.addEventListener('click', function () {
      var payload = {
        hardware: 'Mac16,5 (16-inch MacBook Pro)',
        micPlacement: '3x MEMS triangle under upper-left speaker grille beside ~ and tab; 0 in notch or right grille',
        grille: state.grille,
        mode: state.mode,
        sonarCoupled: state.sonarCoupled,
        loopbackSnrDb: state.loopbackSnrDb,
        dPrimeOof: state.ldaModel ? state.ldaModel.dPrimeOof : null,
        weights: state.ldaModel ? state.ldaModel.w : getPriorWeights(state.grille, isSonarEffective()),
        lastFeatures: state.lastFeat ? state.lastFeat.rawX : null,
        lastResult: state.lastResult
      };
      var jsonStr = JSON.stringify(payload, null, 2);
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(jsonStr).then(function () {
          showToast('Copied telemetry & LDA JSON to clipboard.', 'info');
        }).catch(function () {
          showToast('Clipboard write blocked in this context — use HTTPS/localhost.', 'warn');
        });
      } else {
        showToast('Clipboard API unavailable (requires HTTPS/localhost).', 'warn');
      }
    });

    // Direct pointer / wheel / keyboard Demo scrub on the stage
    els.stageWell.addEventListener('pointerdown', function (ev) {
      if (state.sonarSleeping && state.armed) resetIdleWatchdog();
      if (ev.target && ev.target.closest && ev.target.closest('button')) return;
      state.scrubDragging = true;
      state.lastDragY = ev.clientY;
      try { els.stageWell.setPointerCapture(ev.pointerId); } catch (_) {}
    });

    els.stageWell.addEventListener('pointermove', function (ev) {
      if (!state.scrubDragging) return;
      var dy = state.lastDragY - ev.clientY; // dragging UP -> positive dy
      state.lastDragY = ev.clientY;
      state.vernierTarget = clamp(state.vernierTarget + dy * 0.06, -10, 10);
      var rect = els.stageWell.getBoundingClientRect();
      state.stationY = clamp(1 - (ev.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
      if (reducedMotionQuery.matches) {
        state.vernierPos = state.vernierTarget;
        state.vernierVel = 0;
      } else {
        var idx = clamp(Math.floor((1 - state.stationY) * (LOUVER_N - 1)), 0, LOUVER_N - 1);
        state.louverVel[idx] += clamp(dy * 0.28, -4, 4);
      }
      syncControlsUI();
    });

    var endDrag = function () {
      if (!state.scrubDragging) return;
      state.scrubDragging = false;
      state.vernierTarget = Math.round(state.vernierTarget * 2) / 2;
      if (reducedMotionQuery.matches) {
        state.vernierPos = state.vernierTarget;
        state.vernierVel = 0;
      }
      syncControlsUI();
    };
    els.stageWell.addEventListener('pointerup', endDrag);
    els.stageWell.addEventListener('pointercancel', endDrag);

    els.stageWell.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      if (state.sonarSleeping && state.armed) resetIdleWatchdog();
      var step = ev.deltaY < 0 ? 0.5 : -0.5;
      state.vernierTarget = clamp(Math.round((state.vernierTarget + step) * 2) / 2, -10, 10);
      state.stationY = clamp(state.stationY + step * 0.08, 0, 1);
      state.waveDir = step > 0 ? 'UP' : 'DOWN';
      if (reducedMotionQuery.matches) {
        state.vernierPos = state.vernierTarget;
        state.vernierVel = 0;
        state.wavePhase = -1;
      } else {
        state.wavePhase = 0;
      }
      syncControlsUI();
    }, { passive: false });

    els.stageWell.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowRight') {
        ev.preventDefault();
        injectDemoStroke('UP');
      } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowLeft') {
        ev.preventDefault();
        injectDemoStroke('DOWN');
      } else if (ev.key === 'Home') {
        ev.preventDefault();
        state.vernierTarget = -10;
        state.stationY = 0;
        if (reducedMotionQuery.matches) {
          state.vernierPos = state.vernierTarget;
          state.vernierVel = 0;
          state.wavePhase = -1;
        }
        syncControlsUI();
      } else if (ev.key === 'End') {
        ev.preventDefault();
        state.vernierTarget = 10;
        state.stationY = 1;
        if (reducedMotionQuery.matches) {
          state.vernierPos = state.vernierTarget;
          state.vernierVel = 0;
          state.wavePhase = -1;
        }
        syncControlsUI();
      } else if (ev.key === 'Escape' && state.expanded) {
        toggleExpand(false);
      }
    });

    var onGlobalKey = function (ev) {
      if (ev.key === 'Escape' && state.expanded) toggleExpand(false);
    };
    window.addEventListener('keydown', onGlobalKey);
    var onGlobalPointerDown = function (ev) {
      if (state.expanded && !cellEl.contains(ev.target)) {
        toggleExpand(false);
      }
    };
    window.addEventListener('pointerdown', onGlobalPointerDown);

    var onVisChange = function () {
      if (isDestroyed || !state.audioCtx) return;
      if (document.hidden) {
        if (state.idleSleepTimer) {
          clearTimeout(state.idleSleepTimer);
          state.idleSleepTimer = null;
        }
        sendWorkletRaw({ type: 'config', sonar: false, operatingGain: 0, probe: false });
        state.audioCtx.suspend().catch(function () {});
      } else if (state.armed) {
        var resumeGen = armGen;
        var resumeCtx = state.audioCtx;
        resumeCtx.resume().then(function () {
          if (isDestroyed || resumeGen !== armGen || !state.armed || state.audioCtx !== resumeCtx || document.hidden) {
            return;
          }
          if (state.sonarCoupled && state.mode === 'sonar' && state.grille === 'right') {
            state.sonarSleeping = false;
            pushWorkletConfig(false);
            resetIdleWatchdog();
          } else {
            sendWorkletRaw({ type: 'config', sonar: false, operatingGain: 0, probe: false });
          }
          syncControlsUI();
        }).catch(function () {});
      }
    };
    document.addEventListener('visibilitychange', onVisChange);

    var onPageHide = function () { disarmAudio(true); };
    window.addEventListener('pagehide', onPageHide);

    var onDeviceChange = function () {
      if (isDestroyed || !state.armed) return;
      if (deviceChangeTimer) clearTimeout(deviceChangeTimer);
      deviceChangeTimer = setTimeout(async function () {
        deviceChangeTimer = null;
        if (isDestroyed || !state.armed) return;
        var keepDeviceId = '';
        if (state.selectedDeviceId && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
          try {
            var devs = await navigator.mediaDevices.enumerateDevices();
            if (isDestroyed || !state.armed) return;
            var stillPresent = devs.some(function (d) {
              return d.kind === 'audioinput' && d.deviceId === state.selectedDeviceId;
            });
            if (stillPresent) keepDeviceId = state.selectedDeviceId;
          } catch (_) {}
        }
        if (!isDestroyed && state.armed) {
          armAudio(keepDeviceId);
        }
      }, 180);
    };
    if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    }

    // --- HiDPI ResizeObserver strictly on .ag-canvas-wrap elements ---
    function syncCanvasSize(wrapEl, canvasEl, slotKey) {
      var r = wrapEl.getBoundingClientRect();
      var w = Math.max(1, Math.round(r.width));
      var h = Math.max(1, Math.round(r.height));
      var dpr = Math.min((window.devicePixelRatio || 1), 2);
      var pw = Math.round(w * dpr);
      var ph = Math.round(h * dpr);
      if (canvasEl.width !== pw || canvasEl.height !== ph) {
        canvasEl.width = pw;
        canvasEl.height = ph;
      }
      sizes[slotKey] = { w: w, h: h, dpr: dpr };
    }

    var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(function () {
      syncCanvasSize(els.stageWrap, els.stageCanvas, 'stage');
      syncCanvasSize(els.scopeWrap, els.scopeCanvas, 'scope');
      syncCanvasSize(els.wfWrap, els.wfCanvas, 'wf');
      syncCanvasSize(els.ldaWrap, els.ldaCanvas, 'lda');
      requestRender();
    }) : null;

    if (ro) {
      ro.observe(els.stageWrap);
      ro.observe(els.scopeWrap);
      ro.observe(els.wfWrap);
      ro.observe(els.ldaWrap);
    }

    // --- Symplectic Coupled 31-Louver & Vernier Physics + Demand-Driven Canvas Renderer ---
    // Sleeps at 0% idle CPU when unarmed and mechanically settled; wakes immediately on motion/arm.
    var rafId = 0;
    var lastTs = 0;

    function isKineticActive() {
      if (state.armed || state.scrubDragging || state.wavePhase >= 0) return true;
      if (Math.abs(state.vernierTarget - state.vernierPos) > 0.002 || Math.abs(state.vernierVel) > 0.004) return true;
      for (var i = 0; i < LOUVER_N; i++) {
        if (Math.abs(state.louverAngle[i]) > 0.002 || Math.abs(state.louverVel[i]) > 0.004) return true;
      }
      return false;
    }

    function requestRender() {
      if (!rafId && !isDestroyed) {
        lastTs = 0;
        rafId = requestAnimationFrame(frame);
      }
    }

    function stepPhysics(dt) {
      if (reducedMotionQuery.matches) {
        state.vernierPos = state.vernierTarget;
        state.vernierVel = 0;
        state.wavePhase = -1;
        for (var r = 0; r < LOUVER_N; r++) {
          state.louverAngle[r] = 0;
          state.louverVel[r] = 0;
        }
        return;
      }

      var subSteps = 2;
      var h = Math.min(0.032, dt) / subSteps;

      for (var s = 0; s < subSteps; s++) {
        // Critically damped Vernier carriage (omega = 22 rad/s, zeta = 1.0)
        var errV = state.vernierTarget - state.vernierPos;
        var accV = 484 * errV - 44 * state.vernierVel;
        state.vernierVel += accV * h;
        state.vernierPos += state.vernierVel * h;

        // Post-stroke 165 ms directional wavefront across the 31 louvers
        var waveIdx = -99;
        if (state.wavePhase >= 0) {
          state.wavePhase += h / 0.165;
          if (state.wavePhase > 1.35) {
            state.wavePhase = -1;
          } else {
            var prog = clamp(state.wavePhase, 0, 1);
            // Index 0 = top (hinge), LOUVER_N-1 = bottom (palm plate)
            waveIdx = state.waveDir === 'UP'
              ? (1 - prog) * (LOUVER_N - 1)
              : prog * (LOUVER_N - 1);
          }
        }

        for (var k = 0; k < LOUVER_N; k++) {
          var neighbor = 0;
          if (k > 0) neighbor += state.louverAngle[k - 1] - state.louverAngle[k];
          if (k < LOUVER_N - 1) neighbor += state.louverAngle[k + 1] - state.louverAngle[k];

          var drive = 0;
          if (waveIdx > -50) {
            var dist = Math.abs(k - waveIdx);
            if (dist < 3.5) {
              drive += (state.waveDir === 'UP' ? 1 : -1) * 28 * Math.exp(-(dist * dist) / 2.8);
            }
          }
          if (state.fLive > 0.04) {
            var centerDist = Math.abs(k / (LOUVER_N - 1) - (1 - state.stationY));
            drive += state.fLive * 8 * Math.exp(-(centerDist * centerDist) / 0.08);
          }

          var acc = -190 * state.louverAngle[k] + 42 * neighbor - 22 * state.louverVel[k] + drive;
          state.louverVel[k] += acc * h;
          state.louverAngle[k] = clamp(state.louverAngle[k] + state.louverVel[k] * h, -1.2, 1.2);
        }
      }
    }

    function drawStage(nowMs) {
      var sz = sizes.stage;
      var ctx = els.stageCanvas.getContext('2d');
      if (!ctx || sz.w < 10 || sz.h < 10) return;
      var dpr = sz.dpr || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, sz.w, sz.h);

      var w = sz.w, h = sz.h;
      var compact = w < 260 || h < 130;

      // Layout columns inside unified Mac16,5 stage:
      // [Left 3-MEMS Origin] --- [Cross-Deck Chord] --- [Magnified Right Grille 31-Louver Stack] --- [Vernier Rail]
      var padX = compact ? 6 : 10;
      var padY = compact ? 6 : 10;
      var topBarH = compact ? 0 : 14;
      var innerY = padY + topBarH;
      var innerH = Math.max(24, h - innerY - padY);

      if (!compact) {
        // Top display hinge datum & NOTCH · 0 MICS callout
        ctx.strokeStyle = '#d4d3cd';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padX, padY + 6);
        ctx.lineTo(w - padX, padY + 6);
        ctx.stroke();

        var notchW = Math.min(90, Math.max(74, w * 0.24));
        var notchX = clamp(w * 0.42 - notchW * 0.5, padX + 4, w - padX - notchW - 4);
        ctx.fillStyle = '#f6f6f4';
        ctx.fillRect(notchX - 4, padY, notchW + 8, 12);
        ctx.strokeStyle = '#bcbab3';
        ctx.setLineDash([2, 2]);
        ctx.strokeRect(notchX, padY + 1, notchW, 10);
        ctx.setLineDash([]);
        ctx.fillStyle = '#62615c';
        ctx.font = '500 8px ui-monospace, "SF Mono", Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('NOTCH · 0 MICS', notchX + notchW * 0.5, padY + 6.5);
      }

      var leftZoneW = compact ? w * 0.22 : Math.max(72, w * 0.27);
      var vernierW = compact ? 0 : Math.min(92, Math.max(54, w * 0.20));
      var rightGrilleW = compact ? w * 0.42 : Math.min(148, Math.max(66, w * 0.28));
      var bridgeW = Math.max(24, w - 2 * padX - leftZoneW - rightGrilleW - vernierW - (compact ? 6 : 14));

      var leftX = padX;
      var bridgeX = leftX + leftZoneW + 4;
      var rightX = bridgeX + bridgeW + 4;
      var vernierX = rightX + rightGrilleW + 6;

      // --- 1. Left Grille & 3-MEMS Triangle (Upper Third beside esc / ~ / tab) ---
      var lgW = compact ? Math.max(16, leftZoneW * 0.46) : clamp(Math.round(leftZoneW * 0.34), 22, 42);
      ctx.fillStyle = state.grille === 'left' ? '#e7efe9' : '#eae9e4';
      ctx.strokeStyle = state.grille === 'left' ? '#047857' : '#cfcec8';
      ctx.lineWidth = 1;
      roundRect(ctx, leftX, innerY, lgW, innerH, 4);
      ctx.fill();
      ctx.stroke();

      // Subtle micro-perforation dot matrix on Left Grille
      ctx.fillStyle = '#c5c4be';
      for (var py = innerY + 5; py < innerY + innerH - 4; py += 5) {
        for (var px = leftX + 4; px < leftX + lgW - 3; px += 5) {
          ctx.fillRect(px, py, 1, 1);
        }
      }

      // Acute 3-MEMS Microphone Triangle in UPPER THIRD (y = 14%..34% from top)
      var mic1X = leftX + lgW * 0.36, mic1Y = innerY + innerH * 0.17;
      var mic2X = leftX + lgW * 0.72, mic2Y = innerY + innerH * 0.24;
      var mic3X = leftX + lgW * 0.36, mic3Y = innerY + innerH * 0.32;
      var micCx = (mic1X + mic2X + mic3X) / 3;
      var micCy = (mic1Y + mic2Y + mic3Y) / 3;

      ctx.strokeStyle = 'rgba(4, 120, 87, 0.35)';
      ctx.beginPath();
      ctx.moveTo(mic1X, mic1Y);
      ctx.lineTo(mic2X, mic2Y);
      ctx.lineTo(mic3X, mic3Y);
      ctx.closePath();
      ctx.stroke();

      [[mic1X, mic1Y], [mic2X, mic2Y], [mic3X, mic3Y]].forEach(function (pt) {
        ctx.fillStyle = '#047857';
        ctx.beginPath();
        ctx.arc(pt[0], pt[1], compact ? 2.1 : 2.7, 0, Math.PI * 2);
        ctx.fill();
      });

      // 3 sequential landmark keys (esc, ~, tab) with 0 overlap at any stage height
      var keyX = leftX + lgW + 4;
      var keyW = Math.max(24, Math.min(44, leftZoneW - lgW - 6));
      var keyH = clamp(Math.floor(innerH * 0.105), 12, 17);
      var keyGap = clamp(Math.floor(innerH * 0.025), 3, 5);
      var yEsc = innerY + 4;
      var yTilde = yEsc + keyH + keyGap;
      var yTab = yTilde + keyH + keyGap;
      if (!compact) {
        var keys = [
          { label: 'esc', y: yEsc },
          { label: '~ `', y: yTilde },
          { label: 'tab', y: yTab }
        ];
        ctx.font = '500 7.5px ui-monospace, "SF Mono", Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        keys.forEach(function (k) {
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#d8d7d1';
          roundRect(ctx, keyX, k.y, keyW, keyH, 2.5);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#62615c';
          ctx.fillText(k.label, keyX + 4, k.y + keyH * 0.52);
        });
      }

      // --- 2. Magnified Right Grille = 31-Blade Kinetic Louver Sensor ---
      ctx.fillStyle = '#ecebe7';
      ctx.strokeStyle = state.grille === 'right' ? '#aba9a2' : '#d5d4ce';
      ctx.lineWidth = 1;
      roundRect(ctx, rightX, innerY, rightGrilleW, innerH, 5);
      ctx.fill();
      ctx.stroke();

      var bladeCount = compact ? 15 : LOUVER_N;
      var bladePadY = compact ? 5 : 13;
      var bladeSpanH = Math.max(16, innerH - 2 * bladePadY);
      var bladeW = rightGrilleW - 10;

      if (!compact) {
        ctx.font = '600 7.5px ui-monospace, "SF Mono", Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#62615c';
        ctx.fillText('RIGHT · 0 MICS', rightX + rightGrilleW * 0.5, innerY + 7);
        ctx.fillText('PALM PLATE', rightX + rightGrilleW * 0.5, innerY + innerH - 5.5);
      }

      // Render coupled spring-damper louvers inside Right Grille
      for (var b = 0; b < bladeCount; b++) {
        var srcIdx = Math.round((b / Math.max(1, bladeCount - 1)) * (LOUVER_N - 1));
        var ang = state.louverAngle[srcIdx];
        var by = innerY + bladePadY + (b / Math.max(1, bladeCount - 1)) * bladeSpanH + ang * 2.2;
        var mag = Math.min(1, Math.abs(ang) * 1.4);

        if (mag > 0.08) {
          ctx.strokeStyle = ang >= 0
            ? 'rgba(0, 82, 204, ' + (0.28 + 0.68 * mag).toFixed(2) + ')'
            : 'rgba(201, 55, 0, ' + (0.28 + 0.68 * mag).toFixed(2) + ')';
          ctx.lineWidth = compact ? 2.0 : 2.3;
        } else {
          ctx.strokeStyle = '#c2c1bb';
          ctx.lineWidth = 1.2;
        }
        ctx.beginPath();
        ctx.moveTo(rightX + 5, by);
        ctx.lineTo(rightX + 5 + bladeW, by);
        ctx.stroke();
      }

      // Right Tweeter R+1.0 marker (upper-mid station u = 0.68 from bottom -> y = 0.32 from top)
      var twY = innerY + bladePadY + 0.32 * bladeSpanH;
      var sonarVis = state.mode === 'sonar' && state.grille === 'right';
      ctx.fillStyle = sonarVis ? '#0052cc' : '#8d8c86';
      ctx.beginPath();
      ctx.arc(rightX + rightGrilleW - 4, twY, 2.5, 0, Math.PI * 2);
      ctx.fill();

      // --- 3. Cross-Chassis Acoustic Chord & 19 kHz Ultrasonic Wavefront Arcs ---
      var targetY = innerY + bladePadY + (1 - state.stationY) * bladeSpanH;
      var pathCm = 31.0 + (1 - state.stationY) * 1.42; // 31.0 cm top .. 32.4 cm bottom

      if (sonarVis) {
        var phaseAnim = reducedMotionQuery.matches ? 0.3 : ((nowMs * 0.0022) % 1);
        for (var arc = 0; arc < 3; arc++) {
          var rad = 10 + ((phaseAnim + arc / 3) % 1) * bridgeW * 0.92;
          var alphaArc = (1 - rad / (bridgeW + 12)) * (state.armed && state.sonarCoupled ? 0.36 : 0.18);
          ctx.strokeStyle = 'rgba(0, 82, 204, ' + Math.max(0.03, alphaArc).toFixed(2) + ')';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(rightX, twY, rad, Math.PI * 0.72, Math.PI * 1.28);
          ctx.stroke();
        }
      }

      ctx.strokeStyle = '#9e9d97';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(micCx + 3, micCy);
      ctx.lineTo(rightX, targetY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Clean key-column callout below `tab` (never crosses Left Grille border or chord line)
      if (!compact) {
        var memsLabelY = yTab + keyH + Math.max(9, Math.min(13, innerH * 0.065));
        var colBoxW = Math.min(48, Math.max(34, leftZoneW - lgW - 4));
        ctx.fillStyle = '#f6f6f4';
        ctx.fillRect(keyX - 1, memsLabelY - 6, colBoxW, 21);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#047857';
        ctx.font = '600 8px ui-monospace, "SF Mono", Menlo, monospace';
        ctx.fillText('3× MEMS', keyX, memsLabelY);
        ctx.fillStyle = '#62615c';
        ctx.font = '500 7.5px ui-monospace, "SF Mono", Menlo, monospace';
        ctx.fillText('LEFT · 1ch', keyX, memsLabelY + 10);

        var midBridgeX = bridgeX + bridgeW * 0.5;
        var midBridgeY = clamp((micCy + targetY) * 0.5, innerY + 14, innerY + innerH - 14);
        var pillW = Math.min(46, Math.max(22, bridgeW - 2));
        ctx.fillStyle = '#f6f6f4';
        ctx.fillRect(midBridgeX - pillW * 0.5, midBridgeY - 10.5, pillW, 21);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (bridgeW >= 42) {
          ctx.fillStyle = '#141413';
          ctx.font = '600 8.5px ui-monospace, "SF Mono", Menlo, monospace';
          ctx.fillText(pathCm.toFixed(1) + 'cm', midBridgeX, midBridgeY - 4);
          ctx.fillStyle = '#62615c';
          ctx.font = '500 7.5px ui-monospace, "SF Mono", Menlo, monospace';
          ctx.fillText('Δ4.5%', midBridgeX, midBridgeY + 5.5);
        } else if (bridgeW >= 30) {
          ctx.fillStyle = '#141413';
          ctx.font = '600 7px ui-monospace, "SF Mono", Menlo, monospace';
          ctx.fillText(pathCm.toFixed(1) + 'cm', midBridgeX, midBridgeY - 3.5);
          ctx.fillStyle = '#62615c';
          ctx.font = '500 6.8px ui-monospace, "SF Mono", Menlo, monospace';
          ctx.fillText('Δ4.5%', midBridgeX, midBridgeY + 5);
        } else {
          ctx.fillStyle = '#141413';
          ctx.font = '600 6.8px ui-monospace, "SF Mono", Menlo, monospace';
          ctx.fillText(Math.round(pathCm) + 'cm', midBridgeX, midBridgeY - 3.5);
          ctx.fillStyle = '#62615c';
          ctx.font = '500 6.5px ui-monospace, "SF Mono", Menlo, monospace';
          ctx.fillText('4.5%', midBridgeX, midBridgeY + 5);
        }
      }

      // --- 4. Vertical Vernier Detent Carriage (-10..+10) & Direction Lock Badge ---
      if (!compact && vernierW >= 54) {
        ctx.strokeStyle = '#d4d3cd';
        ctx.lineWidth = 1;
        var railX = vernierX + 8;
        var railTop = innerY + 12;
        var railBot = innerY + innerH - 12;
        var railH = Math.max(20, railBot - railTop);
        ctx.beginPath();
        ctx.moveTo(railX, railTop);
        ctx.lineTo(railX, railBot);
        ctx.stroke();

        for (var tick = -10; tick <= 10; tick += 2) {
          var ty = railTop + ((10 - tick) / 20) * railH;
          var major = tick % 10 === 0 || tick === 0;
          ctx.beginPath();
          ctx.moveTo(railX - (major ? 4 : 2), ty);
          ctx.lineTo(railX + (major ? 4 : 2), ty);
          ctx.stroke();
        }

        var carY = railTop + ((10 - clamp(state.vernierPos, -10, 10)) / 20) * railH;
        var res = state.lastResult;
        var accent = !res ? '#141413' : (res.dir === 'UP' ? '#0052cc' : '#c93700');

        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.moveTo(railX + 5, carY);
        ctx.lineTo(railX + 11, carY - 4);
        ctx.lineTo(railX + 11, carY + 4);
        ctx.closePath();
        ctx.fill();

        var cardX = railX + 14;
        var cardW = Math.max(38, vernierW - 22);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#141413';
        ctx.font = '700 12px ui-monospace, "SF Mono", Menlo, monospace';
        var vPre = state.vernierTarget >= 0 ? '+' : '';
        ctx.fillText(vPre + state.vernierTarget.toFixed(1), cardX, innerY + 16);

        if (res) {
          ctx.fillStyle = '#ffffff';
          roundRect(ctx, cardX - 2, innerY + 28, cardW, 20, 3.5);
          ctx.fill();
          ctx.fillStyle = res.dir === 'UP' ? 'rgba(0, 82, 204, 0.07)' : 'rgba(201, 55, 0, 0.06)';
          ctx.strokeStyle = res.dir === 'UP' ? 'rgba(0, 82, 204, 0.38)' : 'rgba(201, 55, 0, 0.38)';
          ctx.lineWidth = 1;
          roundRect(ctx, cardX - 2, innerY + 28, cardW, 20, 3.5);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = accent;
          ctx.font = '700 9px ui-monospace, "SF Mono", Menlo, monospace';
          ctx.fillText((res.dir === 'UP' ? '↑ ' : '↓ ') + Math.round(res.confidence * 100) + '%', cardX + 2, innerY + 38.5);
        } else {
          ctx.fillStyle = '#62615c';
          ctx.font = '500 8px ui-monospace, "SF Mono", Menlo, monospace';
          ctx.fillText(state.armed ? 'SWIPE' : 'SCRUB', cardX, innerY + 37);
        }

        // Bottom empirical d' / prior status tag
        ctx.fillStyle = state.ldaModel ? '#047857' : '#62615c';
        ctx.font = '600 8px ui-monospace, "SF Mono", Menlo, monospace';
        var tagTxt = state.ldaModel
          ? ("d' " + state.ldaModel.dPrimeOof.toFixed(1))
          : (sonarVis ? '19kHz' : 'PRIOR');
        ctx.fillText(tagTxt, cardX, innerY + innerH - 7);
      }
    }

    function drawWorkbenchPanels() {
      if (!state.expanded) return;

      // Panel 1: Dual-Trace Frozen Stroke Trajectory Oscilloscope s in [0, 1]
      var sSz = sizes.scope;
      var sCtx = els.scopeCanvas.getContext('2d');
      if (sCtx && sSz.w > 20 && sSz.h > 20) {
        var dpr = sSz.dpr || 1;
        sCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        sCtx.clearRect(0, 0, sSz.w, sSz.h);
        var midH = Math.floor(sSz.h * 0.48);

        // Divider & baseline axes
        sCtx.strokeStyle = '#deddd7';
        sCtx.lineWidth = 1;
        sCtx.beginPath();
        sCtx.moveTo(0, midH);
        sCtx.lineTo(sSz.w, midH);
        sCtx.moveTo(0, midH + (sSz.h - midH) * 0.5);
        sCtx.lineTo(sSz.w, midH + (sSz.h - midH) * 0.5);
        sCtx.stroke();

        if (state.lastFeat) {
          var fc = state.lastFeat.fricCurve64;
          var minF = Infinity, maxF = -Infinity;
          for (var i = 0; i < 64; i++) {
            if (fc[i] < minF) minF = fc[i];
            if (fc[i] > maxF) maxF = fc[i];
          }
          var spanF = Math.max(6, maxF - minF);
          sCtx.strokeStyle = '#141413';
          sCtx.lineWidth = 1.6;
          sCtx.beginPath();
          for (var j = 0; j < 64; j++) {
            var x = (j / 63) * (sSz.w - 8) + 4;
            var y = midH - 5 - ((fc[j] - minF) / spanF) * (midH - 10);
            if (j === 0) sCtx.moveTo(x, y);
            else sCtx.lineTo(x, y);
          }
          sCtx.stroke();

          // Lower subplot: 19 kHz Doppler trajectory + tau_dip caliper pin
          var dc = state.lastFeat.dopCurve64;
          var botZero = midH + (sSz.h - midH) * 0.5;
          var botAmp = (sSz.h - midH) * 0.42;
          sCtx.strokeStyle = state.lastResult && state.lastResult.dir === 'UP' ? '#0052cc' : '#c93700';
          sCtx.lineWidth = 1.6;
          sCtx.beginPath();
          for (var m = 0; m < 64; m++) {
            var xd = (m / 63) * (sSz.w - 8) + 4;
            var yd = botZero - clamp(dc[m] / 55, -1, 1) * botAmp;
            if (m === 0) sCtx.moveTo(xd, yd);
            else sCtx.lineTo(xd, yd);
          }
          sCtx.stroke();

          if (state.lastFeat.dipDb > 0.8) {
            var dipX = 4 + state.lastFeat.tauDip * (sSz.w - 8);
            sCtx.strokeStyle = 'rgba(201, 55, 0, 0.65)';
            sCtx.setLineDash([2, 2]);
            sCtx.beginPath();
            sCtx.moveTo(dipX, midH + 2);
            sCtx.lineTo(dipX, sSz.h - 2);
            sCtx.stroke();
            sCtx.setLineDash([]);
          }
        } else {
          sCtx.fillStyle = '#62615c';
          sCtx.font = '500 9px ui-monospace, "SF Mono", Menlo, monospace';
          sCtx.fillText('Swipe grille or click Demo ↑↓ to freeze stroke profile', 6, midH * 0.55);
        }
      }

      // Panel 2: 19.00 kHz +-100 Hz MTI Doppler Waterfall
      var wSz = sizes.wf;
      var wCtx = els.wfCanvas.getContext('2d');
      if (wCtx && wSz.w > 20 && wSz.h > 16) {
        var dprW = wSz.dpr || 1;
        wCtx.setTransform(dprW, 0, 0, dprW, 0, 0);
        wCtx.clearRect(0, 0, wSz.w, wSz.h);

        // Shaded +-15 Hz clutter notch band around center
        wCtx.fillStyle = '#ecebe6';
        wCtx.fillRect(0, wSz.h * 0.42, wSz.w, wSz.h * 0.16);

        var cols = state.waterfallCols;
        var maxCols = WATERFALL_MAX_COLS;
        var colW = wSz.w / maxCols;
        var binH = wSz.h / 33;
        for (var ci = 0; ci < cols.length; ci++) {
          var spec = cols[ci];
          var maxP = 1e-12;
          for (var bi = 0; bi < 33; bi++) if (spec[bi] > maxP) maxP = spec[bi];
          var cx = (maxCols - cols.length + ci) * colW;
          for (var b2 = 0; b2 < 33; b2++) {
            var norm = clamp(spec[b2] / maxP, 0, 1);
            if (norm < 0.06) continue;
            var cy = (32 - b2) * binH; // top = +100 Hz blueshift, bottom = -100 Hz redshift
            wCtx.fillStyle = b2 >= 16
              ? 'rgba(0, 82, 204, ' + (0.15 + 0.8 * norm).toFixed(2) + ')'
              : 'rgba(201, 55, 0, ' + (0.15 + 0.8 * norm).toFixed(2) + ')';
            wCtx.fillRect(cx, cy, Math.ceil(colW), Math.ceil(binH));
          }
        }
      }

      // Panel 3: 6-Feature Signed Diverging Fisher Log-Odds Bars
      var lSz = sizes.lda;
      var lCtx = els.ldaCanvas.getContext('2d');
      if (lCtx && lSz.w > 20 && lSz.h > 20) {
        var dprL = lSz.dpr || 1;
        lCtx.setTransform(dprL, 0, 0, dprL, 0, 0);
        lCtx.clearRect(0, 0, lSz.w, lSz.h);

        var labelW = 74;
        var plotW = Math.max(20, lSz.w - labelW - 8);
        var zeroX = labelW + plotW * 0.5;
        var rowH = lSz.h / 6;

        lCtx.strokeStyle = '#cfcec8';
        lCtx.lineWidth = 1;
        lCtx.beginPath();
        lCtx.moveTo(zeroX, 2);
        lCtx.lineTo(zeroX, lSz.h - 2);
        lCtx.stroke();

        var contribs = state.lastResult ? state.lastResult.contribs : null;
        lCtx.font = '500 8.5px ui-monospace, "SF Mono", Menlo, monospace';
        lCtx.textBaseline = 'middle';

        for (var f = 0; f < 6; f++) {
          var ry = (f + 0.5) * rowH;
          lCtx.fillStyle = '#52514d';
          lCtx.textAlign = 'left';
          lCtx.fillText(FEATURE_NAMES[f], 2, ry);

          var val = contribs ? clamp(contribs[f] / 1.6, -1, 1) : 0;
          var barLen = Math.abs(val) * (plotW * 0.46);
          if (barLen >= 1) {
            lCtx.fillStyle = val >= 0 ? '#0052cc' : '#c93700';
            lCtx.fillRect(val >= 0 ? zeroX : zeroX - barLen, ry - Math.max(2.5, rowH * 0.30), barLen, Math.max(5, rowH * 0.60));
          }
        }
      }
    }

    function roundRect(ctx, x, y, w, h, r) {
      var rad = Math.min(r, w * 0.5, h * 0.5);
      ctx.beginPath();
      ctx.moveTo(x + rad, y);
      ctx.arcTo(x + w, y, x + w, y + h, rad);
      ctx.arcTo(x + w, y + h, x, y + h, rad);
      ctx.arcTo(x, y + h, x, y, rad);
      ctx.arcTo(x, y, x + w, y, rad);
      ctx.closePath();
    }

    function frame(ts) {
      rafId = 0;
      if (isDestroyed) return;
      var dt = lastTs ? (ts - lastTs) / 1000 : 0.016;
      lastTs = ts;
      stepPhysics(dt);
      drawStage(ts);
      drawWorkbenchPanels();
      if (isKineticActive()) {
        rafId = requestAnimationFrame(frame);
      }
    }

    loadCalibration(true);
    syncCanvasSize(els.stageWrap, els.stageCanvas, 'stage');
    requestRender();

    return {
      disarm: function () { return disarmAudio(false); },
      injectDemoStroke: injectDemoStroke,
      toggleExpand: toggleExpand,
      destroy: function () {
        isDestroyed = true;
        state.expanded = false;
        expandToken++;
        applyExpandDOM(false);
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        if (ro) ro.disconnect();
        if (deviceChangeTimer) {
          clearTimeout(deviceChangeTimer);
          deviceChangeTimer = null;
        }
        window.removeEventListener('keydown', onGlobalKey);
        window.removeEventListener('pointerdown', onGlobalPointerDown);
        document.removeEventListener('visibilitychange', onVisChange);
        window.removeEventListener('pagehide', onPageHide);
        if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.removeEventListener) {
          navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
        }
        delete cellEl.dataset.agMounted;
        return disarmAudio(true);
      }
    };
  }

  if (typeof document !== 'undefined') {
    var boot = function () {
      var el = document.getElementById('cell-grille-swipe');
      if (el) mountCell(el);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  return {
    CARRIER_HZ: CARRIER_HZ,
    FEATURE_NAMES: FEATURE_NAMES,
    FEATURE_SCALES: FEATURE_SCALES,
    createBiquad: createBiquad,
    filtfiltReal: filtfiltReal,
    resampleCurve: resampleCurve,
    extractStrokeFeatures: extractStrokeFeatures,
    fitShrinkageLDA: fitShrinkageLDA,
    classifyStroke: classifyStroke,
    createStreamEngine: createStreamEngine,
    synthesizeMac16Stroke: synthesizeMac16Stroke,
    rankAudioInputDevice: rankAudioInputDevice,
    buildWorkletSource: buildWorkletSource,
    buildWorkletBlobUrl: buildWorkletBlobUrl,
    mountCell: mountCell
  };
});
