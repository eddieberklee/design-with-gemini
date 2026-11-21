const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const {
  CHIRP_PERIOD,
  CHIRP_ACTIVE_LEN,
  F_START_HZ,
  F_END_HZ,
  STORAGE_KEY,
  computePeriodForSampleRate,
  fftRadix2,
  buildLidPingWaveform,
  buildChirpPiggybackWaveform,
  generateLidPingBlock,
  computeReflectionIndex,
  LidCalibration,
  LidAngleKalman,
  LidSonarEstimator,
  synthesizeScreenBounceFrame
} = require('./lid-angle.js');

const { StereoChirpGenerator } = require('./chirp-sonar.js');

function createMockStorage() {
  const map = new Map();
  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
    _map: map
  };
}

function measureSettledAngle(angleDeg, opts = {}) {
  const sr = opts.sampleRate || 48000;
  const txMode = opts.txMode || 'lid-ping';
  const est = new LidSonarEstimator({
    sampleRate: sr,
    txMode,
    calibration: opts.calibration || null
  });
  let last = null;
  for (let i = 0; i < 12; i++) {
    const { frame } = synthesizeScreenBounceFrame({
      sampleRate: sr,
      angleDeg,
      txMode,
      directDelaySamples: opts.directDelaySamples !== undefined ? opts.directDelaySamples : 137.4,
      directGain: opts.directGain !== undefined ? opts.directGain : 0.42,
      echoPolarity: opts.echoPolarity !== undefined ? opts.echoPolarity : 1,
      noiseStd: opts.noiseStd !== undefined ? opts.noiseStd : 0.00035,
      seed: 1000 + i * 37
    });
    // Push in realistic 512-sample shared-bus chunks (2 chunks @ 44.1/48 kHz, 4 chunks @ 96 kHz)
    let emitted = [];
    for (let off = 0; off < frame.length; off += 512) {
      const r = est.pushSamples(frame.subarray(off, off + 512), sr, txMode);
      emitted = emitted.concat(r);
    }
    assert.equal(emitted.length, 1);
    last = emitted[0];
  }
  return last;
}

test('TX generator emits click-free 18.2–20.4 kHz Hann chirp on leftOut and silences < 40 kHz', () => {
  const sr = 48000;
  const fullL = new Float32Array(CHIRP_PERIOD);
  const fullR = new Float32Array(CHIRP_PERIOD);
  // Fill across 8 x 128-sample AudioWorklet quanta
  for (let off = 0; off < CHIRP_PERIOD; off += 128) {
    const subL = fullL.subarray(off, off + 128);
    const subR = fullR.subarray(off, off + 128);
    subR.fill(1.0); // verify rightOut is actively zeroed
    generateLidPingBlock(subL, subR, sr, off);
  }

  // Exact Hann zero endpoints and quiet listen tail
  assert.equal(fullL[0], 0);
  assert.equal(fullL[CHIRP_ACTIVE_LEN - 1], 0);
  for (let i = CHIRP_ACTIVE_LEN; i < CHIRP_PERIOD; i++) {
    assert.equal(fullL[i], 0);
  }
  for (let i = 0; i < CHIRP_PERIOD; i++) {
    assert.equal(fullR[i], 0);
  }

  // Spectral concentration strictly inside 18.2–20.4 kHz ultrasonic band
  const re = Float64Array.from(fullL);
  const im = new Float64Array(CHIRP_PERIOD);
  fftRadix2(re, im, false);
  const bLo = Math.floor((17600 * CHIRP_PERIOD) / sr);
  const bHi = Math.ceil((21000 * CHIRP_PERIOD) / sr);
  let inBand = 0;
  let outBand = 0;
  for (let b = 1; b < CHIRP_PERIOD >> 1; b++) {
    const p = re[b] * re[b] + im[b] * im[b];
    if (b >= bLo && b <= bHi) inBand += p;
    else outBand += p;
  }
  assert.ok(inBand > outBand * 100, `expected >20dB in-band energy ratio, got ${inBand / Math.max(1e-12, outBand)}`);

  // Bluetooth HFP 16 kHz safety: must output exact silence
  const lowL = new Float32Array(512).fill(0.5);
  const lowR = new Float32Array(512).fill(0.5);
  generateLidPingBlock(lowL, lowR, 16000, 0);
  for (let i = 0; i < 512; i++) {
    assert.equal(lowL[i], 0);
    assert.equal(lowR[i], 0);
  }
});

test('Acoustic screen-bounce sonar estimates monotonic lid angles (35° < 75° < 120°)', () => {
  const est35 = measureSettledAngle(35);
  const est75 = measureSettledAngle(75);
  const est120 = measureSettledAngle(120);

  assert.equal(est35.signalPresent, true);
  assert.equal(est75.signalPresent, true);
  assert.equal(est120.signalPresent, true);

  // Monotonic physical reflection cues: closer lid => higher echoGainDb & shorter lag
  assert.ok(
    est35.echoGainDb > est75.echoGainDb + 3.0,
    `expected 35° echo (${est35.echoGainDb.toFixed(2)} dB) > 75° echo (${est75.echoGainDb.toFixed(2)} dB)`
  );
  assert.ok(
    est75.echoGainDb > est120.echoGainDb + 3.0,
    `expected 75° echo (${est75.echoGainDb.toFixed(2)} dB) > 120° echo (${est120.echoGainDb.toFixed(2)} dB)`
  );
  assert.ok(
    est35.peakLagMs < est75.peakLagMs - 0.25,
    `expected 35° lag (${est35.peakLagMs.toFixed(3)} ms) < 75° lag (${est75.peakLagMs.toFixed(3)} ms)`
  );
  assert.ok(
    est75.peakLagMs < est120.peakLagMs - 0.25,
    `expected 75° lag (${est75.peakLagMs.toFixed(3)} ms) < 120° lag (${est120.peakLagMs.toFixed(3)} ms)`
  );

  // Strict monotonic lid angle ordering with clean separation
  assert.ok(
    est35.angleDeg < est75.angleDeg - 20,
    `expected 35° est (${est35.angleDeg.toFixed(1)}°) < 75° est (${est75.angleDeg.toFixed(1)}°)`
  );
  assert.ok(
    est75.angleDeg < est120.angleDeg - 20,
    `expected 75° est (${est75.angleDeg.toFixed(1)}°) < 120° est (${est120.angleDeg.toFixed(1)}°)`
  );

  // Physically calibrated ballpark ranges
  assert.ok(est35.angleDeg >= 25 && est35.angleDeg <= 50, `35° est out of range: ${est35.angleDeg}`);
  assert.ok(est75.angleDeg >= 60 && est75.angleDeg <= 92, `75° est out of range: ${est75.angleDeg}`);
  assert.ok(est120.angleDeg >= 105 && est120.angleDeg <= 135, `120° est out of range: ${est120.angleDeg}`);
});

test('Direct-path CLEAN cancels pure direct path and stays invariant to speaker volume & polarity', () => {
  const est = new LidSonarEstimator({ sampleRate: 48000 });
  const { frame: directOnly } = synthesizeScreenBounceFrame({
    angleDeg: 110,
    echoRatio: 0,
    noiseStd: 0,
    directDelaySamples: 211.35
  });
  const resDirect = est.processFrame(directOnly, 48000, 'lid-ping');
  assert.equal(resDirect.signalPresent, true);
  assert.ok(
    resDirect.echoGainDb <= -40,
    `expected clean direct-path cancellation <= -40 dB, got ${resDirect.echoGainDb.toFixed(2)} dB`
  );

  // Volume invariance: 0.2x vs 1.6x gain must yield nearly identical lid angle
  const quiet = measureSettledAngle(75, { directGain: 0.14, noiseStd: 0.00005 });
  const loud = measureSettledAngle(75, { directGain: 1.12, noiseStd: 0.0004 });
  assert.ok(
    Math.abs(quiet.angleDeg - loud.angleDeg) < 1.2,
    `volume invariance drifted: quiet=${quiet.angleDeg.toFixed(2)}° vs loud=${loud.angleDeg.toFixed(2)}°`
  );

  // Inverted reflection polarity still preserves strict 35° < 75° < 120° monotonicity
  const inv35 = measureSettledAngle(35, { echoPolarity: -1 });
  const inv75 = measureSettledAngle(75, { echoPolarity: -1 });
  const inv120 = measureSettledAngle(120, { echoPolarity: -1 });
  assert.ok(inv35.angleDeg < inv75.angleDeg - 15);
  assert.ok(inv75.angleDeg < inv120.angleDeg - 15);

  // Pure silence / low-level room noise must not report signalPresent
  const silentRes = est.processFrame(new Float32Array(CHIRP_PERIOD), 48000, 'lid-ping');
  assert.equal(silentRes.signalPresent, false);
});

test('Passively piggybacking on REAL Cell 04 StereoChirpGenerator preserves monotonic 35° < 75° < 120° at 48 kHz and 96 kHz', () => {
  function applyPeriodicFracDelay(sig, delaySamp) {
    const N = sig.length;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = sig[i];
    fftRadix2(re, im, false);
    const oRe = new Float64Array(N);
    const oIm = new Float64Array(N);
    for (let b = 0; b <= N >> 1; b++) {
      const ang = (-2 * Math.PI * b * delaySamp) / N;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const nr = re[b] * c - im[b] * s;
      const ni = re[b] * s + im[b] * c;
      oRe[b] = nr;
      oIm[b] = ni;
      if (b > 0 && b < N >> 1) {
        oRe[N - b] = nr;
        oIm[N - b] = -ni;
      }
    }
    fftRadix2(oRe, oIm, true);
    return oRe;
  }

  for (const sr of [44100, 48000, 96000]) {
    const gen = new StereoChirpGenerator({ gain: 0.04 });
    const tables = gen.getTables(sr);
    const pig = buildChirpPiggybackWaveform(sr);
    assert.equal(pig.length, tables.period, `period mismatch at ${sr} Hz`);
    for (let i = 0; i < tables.period; i++) {
      assert.ok(
        Math.abs(pig[i] - tables.refL[i]) < 1e-6,
        `waveform mismatch at ${sr} Hz sample ${i}: ${pig[i]} vs ${tables.refL[i]}`
      );
    }

    // Generate actual stereo TX via StereoChirpGenerator.fillBuffers (128-sample AudioWorklet chunks)
    const txL = new Float32Array(tables.period);
    const txR = new Float32Array(tables.period);
    for (let off = 0; off < tables.period; off += 128) {
      gen.fillBuffers(txL.subarray(off, off + 128), txR.subarray(off, off + 128), sr, off);
    }

    const results = {};
    for (const angleDeg of [35, 75, 120]) {
      const est = new LidSonarEstimator({ sampleRate: sr, txMode: 'chirp' });
      assert.equal(est.period, tables.period);
      const u = (angleDeg - 25) / (135 - 25);
      const echoRel = Math.pow(10, (-4.2 - 22.8 * u) / 20);
      const echoLagMs = 0.40 + 1.42 * u;
      const directDelay = 137.4 * (sr / 48000);
      // Include BOTH Left chirp direct+lid-bounce AND Right chirp cross-keyboard arrival (+0.73 ms)
      const dL = applyPeriodicFracDelay(txL, directDelay);
      const eL = applyPeriodicFracDelay(txL, directDelay + (echoLagMs * sr) / 1000);
      const dR = applyPeriodicFracDelay(txR, directDelay + (0.73 * sr) / 1000);
      const eR = applyPeriodicFracDelay(txR, directDelay + ((0.73 + echoLagMs) * sr) / 1000);

      let seed = (2026 + sr + angleDeg * 17) >>> 0;
      const nextNoise = () => {
        seed = (seed + 0x6d2b79f5) >>> 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return (((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5) * 0.0005;
      };

      let last = null;
      for (let f = 0; f < 12; f++) {
        const frame = new Float32Array(tables.period);
        for (let i = 0; i < tables.period; i++) {
          frame[i] =
            0.42 * (dL[i] + echoRel * eL[i]) +
            0.35 * (dR[i] + echoRel * eR[i]) +
            nextNoise();
        }
        for (let off = 0; off < frame.length; off += 512) {
          const out = est.pushSamples(frame.subarray(off, off + 512), sr, 'chirp');
          if (out.length) last = out[out.length - 1];
        }
      }
      assert.ok(last, `expected frame output at ${sr} Hz / ${angleDeg}°`);
      assert.equal(last.signalPresent, true, `signalPresent false at ${sr} Hz / ${angleDeg}°`);
      assert.equal(last.txMode, 'chirp');
      results[angleDeg] = last;
    }

    assert.ok(
      results[35].angleDeg < results[75].angleDeg - 15,
      `real chirp ${sr} Hz: 35° (${results[35].angleDeg.toFixed(1)}°) vs 75° (${results[75].angleDeg.toFixed(1)}°)`
    );
    assert.ok(
      results[75].angleDeg < results[120].angleDeg - 15,
      `real chirp ${sr} Hz: 75° (${results[75].angleDeg.toFixed(1)}°) vs 120° (${results[120].angleDeg.toFixed(1)}°)`
    );
  }
});

test('Infinity / NaN inputs are sanitized in LidSonarEstimator without leaking NaN directSnrDb', () => {
  const est = new LidSonarEstimator({ sampleRate: 48000 });
  const badFrame = new Float32Array(CHIRP_PERIOD);
  badFrame[5] = Number.POSITIVE_INFINITY;
  badFrame[17] = Number.NEGATIVE_INFINITY;
  badFrame[42] = Number.NaN;
  const res = est.processFrame(badFrame, 48000, 'lid-ping');
  assert.equal(Number.isFinite(res.directSnrDb), true, `directSnrDb must stay finite, got ${res.directSnrDb}`);
  assert.equal(Number.isFinite(res.angleDeg), true, `angleDeg must stay finite, got ${res.angleDeg}`);
  assert.equal(res.signalPresent, false);

  // Pushing non-finite samples via pushSamples also stays finite
  const r2 = est.pushSamples(badFrame, 48000, 'lid-ping');
  assert.equal(r2.length, 1);
  assert.equal(Number.isFinite(r2[0].directSnrDb), true);
});

test('Multi-rate compatibility (44.1 kHz, 96 kHz, and safe 16 kHz reject)', () => {
  for (const sr of [44100, 96000]) {
    const a35 = measureSettledAngle(35, { sampleRate: sr });
    const a75 = measureSettledAngle(75, { sampleRate: sr });
    const a120 = measureSettledAngle(120, { sampleRate: sr });
    assert.ok(a35.angleDeg < a75.angleDeg - 15, `${sr}Hz: 35°=${a35.angleDeg}, 75°=${a75.angleDeg}`);
    assert.ok(a75.angleDeg < a120.angleDeg - 15, `${sr}Hz: 75°=${a75.angleDeg}, 120°=${a120.angleDeg}`);
  }

  const lowEst = new LidSonarEstimator({ sampleRate: 16000 });
  const lowRes = lowEst.processFrame(new Float32Array(CHIRP_PERIOD), 16000, 'lid-ping');
  assert.equal(lowRes.signalPresent, false);
  assert.equal(lowRes.unsupportedRate, true);
});

test('2-point calibration math ([Set Open 110°] & [Set Low 50°]) and dwg.lidAngleCal.v1 persistence', () => {
  const store = createMockStorage();
  const cal = new LidCalibration();

  // 1-point Open shift preserves positive slope and locks Open anchor exactly to 110°
  const r1 = cal.setOpenAnchor(-19.5, store);
  assert.equal(r1.ok, true);
  assert.equal(cal.openCalibrated, true);
  assert.equal(cal.lowCalibrated, false);
  assert.ok(Math.abs(cal.mapToAngleDeg(-19.5) - 110) < 1e-6);

  // 2-point Low anchor locks 50° and interpolates midpoint to 80°
  const r2 = cal.setLowAnchor(-9.5, store);
  assert.equal(r2.ok, true);
  assert.equal(cal.lowCalibrated, true);
  assert.ok(Math.abs(cal.mapToAngleDeg(-19.5) - 110) < 1e-6);
  assert.ok(Math.abs(cal.mapToAngleDeg(-9.5) - 50) < 1e-6);
  assert.ok(Math.abs(cal.mapToAngleDeg(-14.5) - 80) < 1e-6);

  // Smooth extrapolation clamped cleanly to [25°, 135°]
  assert.equal(cal.mapToAngleDeg(-35.0), 135);
  assert.equal(cal.mapToAngleDeg(5.0), 25);

  // Reject degenerate / inverted anchor without overwriting valid calibration
  const badLow = cal.setLowAnchor(-20.0, store);
  assert.equal(badLow.ok, false);
  assert.ok(Math.abs(cal.mapToAngleDeg(-9.5) - 50) < 1e-6);

  // Exact localStorage key persistence and reload
  assert.ok(store.getItem(STORAGE_KEY), 'expected calibration saved under dwg.lidAngleCal.v1');
  const reloaded = LidCalibration.load(store);
  assert.equal(reloaded.openCalibrated, true);
  assert.equal(reloaded.lowCalibrated, true);
  assert.ok(Math.abs(reloaded.mapToAngleDeg(-14.5) - 80) < 1e-6);

  // Corrupted storage falls back gracefully to factory defaults
  store.setItem(STORAGE_KEY, '{"openRefIndex": -5, "lowRefIndex": -15}'); // inverted
  const fallback = LidCalibration.load(store);
  assert.equal(fallback.isCalibrated, false);
  assert.ok(fallback.lowRefIndex > fallback.openRefIndex);

  // Reset clears storage key
  reloaded.reset(store);
  assert.equal(store.getItem(STORAGE_KEY), null);
});

test('Kalman smoother tracks hinge steps smoothly and dampens single-frame spikes', () => {
  const kf = new LidAngleKalman({ initialAngle: 110, initialized: true });
  // Single low-confidence noise outlier should barely perturb the estimate
  const afterSpike = kf.update(35, 0.02133, 0.15);
  assert.ok(afterSpike > 103, `outlier pulled Kalman too far: ${afterSpike}`);

  // Sustained steady reading at 60° converges smoothly within ~20 frames (~0.43 s)
  let val = afterSpike;
  for (let i = 0; i < 25; i++) {
    val = kf.update(60, 0.02133, 0.95);
  }
  assert.ok(Math.abs(val - 60) < 2.5, `expected convergence near 60°, got ${val.toFixed(2)}°`);
});

test('lid-bridge.mjs passes node --check and serves CORS JSON /angle + SSE /events', async () => {
  const bridgePath = path.join(__dirname, 'lid-bridge.mjs');
  execFileSync(process.execPath, ['--check', bridgePath], { stdio: 'pipe' });

  const mod = await import(pathToFileURL(bridgePath).href);
  assert.equal(typeof mod.parseHelperLine, 'function');
  assert.equal(typeof mod.createBridgeServer, 'function');

  // Verify Swift helper JSON line parsing
  const good = mod.parseHelperLine('{"available":true,"angleDeg":108.4,"raw":108,"source":"iohid"}');
  assert.equal(good.available, true);
  assert.equal(good.angleDeg, 108.4);
  const unavail = mod.parseHelperLine('{"available":false,"angleDeg":null,"reason":"restricted"}');
  assert.equal(unavail.available, false);
  assert.equal(unavail.reason, 'restricted');
  assert.equal(mod.parseHelperLine('not-json'), null);

  // Spin up ephemeral bridge server (hardware disabled for deterministic CI test)
  const bridge = mod.createBridgeServer({ host: '127.0.0.1', port: 0, disableHardware: true });
  const started = await bridge.start();
  const addr = bridge.server.address();
  assert.ok(started.port > 0, `start() must resolve actual bound port, got ${started.port}`);
  assert.equal(started.port, addr.port);
  const baseUrl = `http://127.0.0.1:${started.port}`;

  try {
    // file:// pages send `Origin: null`; the bridge echoes it (never a blanket `*`)
    const angleRes = await fetch(`${baseUrl}/angle`, { headers: { Origin: 'null' } });
    assert.equal(angleRes.status, 200);
    assert.equal(angleRes.headers.get('access-control-allow-origin'), 'null');
    const angleJson = await angleRes.json();
    assert.equal(angleJson.available, false);
    assert.equal(angleJson.source, 'iohid');

    const optRes = await fetch(`${baseUrl}/angle`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:8000' }
    });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get('access-control-allow-origin'), 'http://localhost:8000');

    // Malformed request target must return 400 JSON without crashing the server
    const badStatus = await new Promise((resolve, reject) => {
      const sock = net.connect(started.port, '127.0.0.1', () => {
        sock.write('GET //[::1 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (c) => {
        buf += c;
      });
      sock.on('end', () => resolve(buf));
      sock.on('error', reject);
    });
    assert.match(badStatus, /^HTTP\/1\.1 400 /);
    assert.match(badStatus, /Malformed request URL/);

    // Verify server stays healthy after malformed request
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);

    // Verify SSE /events emits initial `event: angle` frame with CORS header
    const sseChunk = await new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}/events`, { headers: { Origin: 'null' } }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['access-control-allow-origin'], 'null');
        assert.match(res.headers['content-type'], /text\/event-stream/);
        res.setEncoding('utf8');
        res.once('data', (chunk) => {
          req.destroy();
          resolve(chunk);
        });
      });
      req.on('error', reject);
    });
    assert.match(sseChunk, /event: angle/);
    assert.match(sseChunk, /data: \{.*"available":false/);
  } finally {
    await bridge.close();
  }
});

function rawHttp(port, requestText) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(requestText));
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (c) => {
      buf += c;
      // SSE responses never end; the status line is all we need
      if (/\r\n\r\n/.test(buf)) {
        sock.destroy();
        resolve(buf);
      }
    });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
  });
}

test('lid-bridge.mjs refuses cross-site origins, DNS-rebinding Host headers and unbounded SSE clients', async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, 'lid-bridge.mjs')).href);
  const bridge = mod.createBridgeServer({ host: '127.0.0.1', port: 0, disableHardware: true });
  const { port } = await bridge.start();
  const base = `http://127.0.0.1:${port}`;
  const held = [];
  try {
    // Cross-site page: no data and no CORS grant (was 200 + `Access-Control-Allow-Origin: *`)
    const evil = await fetch(`${base}/angle`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const evilSse = await fetch(`${base}/events`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(evilSse.status, 403);
    // Look-alike loopback origins are not loopback
    const lookalike = await fetch(`${base}/angle`, { headers: { Origin: 'http://127.0.0.1.evil.example' } });
    assert.equal(lookalike.status, 403);

    // Loopback dev servers on any port are allowed and get their own origin echoed back
    for (const o of ['http://localhost:8000', 'http://127.0.0.1:5500', 'http://[::1]:8080']) {
      const ok = await fetch(`${base}/angle`, { headers: { Origin: o } });
      assert.equal(ok.status, 200, o);
      assert.equal(ok.headers.get('access-control-allow-origin'), o);
      assert.match(ok.headers.get('vary') || '', /Origin/);
    }

    // DNS rebinding: attacker hostname resolving to 127.0.0.1 arrives with its own Host header
    const rebind = await rawHttp(port, 'GET /angle HTTP/1.1\r\nHost: evil.example:' + port + '\r\nConnection: close\r\n\r\n');
    assert.match(rebind, /^HTTP\/1\.1 403 /);
    const noHost = await rawHttp(port, 'GET /angle HTTP/1.0\r\n\r\n');
    assert.match(noHost, /^HTTP\/1\.[01] 403 /);
    const localHost = await rawHttp(port, 'GET /angle HTTP/1.1\r\nHost: localhost:' + port + '\r\nConnection: close\r\n\r\n');
    assert.match(localHost, /^HTTP\/1\.1 200 /);

    // SSE fan-out is capped
    for (let i = 0; i < mod.MAX_SSE_CLIENTS; i++) {
      held.push(
        await new Promise((resolve, reject) => {
          const req = http.get(`${base}/events`, (res) => {
            assert.equal(res.statusCode, 200);
            resolve(req);
          });
          req.on('error', reject);
        })
      );
    }
    const overflow = await fetch(`${base}/events`);
    assert.equal(overflow.status, 503);
  } finally {
    held.forEach((r) => r.destroy());
    await bridge.close();
  }
});

test('lid bridge port: page and server agree, and no other local server in the repo uses it', async () => {
  const fs = require('node:fs');
  const mod = await import(pathToFileURL(path.join(__dirname, 'lid-bridge.mjs')).href);
  const { BRIDGE_ORIGIN } = require('./lid-angle.js');
  assert.notEqual(mod.DEFAULT_PORT, 8791, 'cells/stick-s3/bridge.mjs listens on 127.0.0.1:8791');
  assert.notEqual(mod.DEFAULT_PORT, 8792, 'cells/left-grille/cal-collector.mjs listens on 127.0.0.1:8792');
  assert.equal(BRIDGE_ORIGIN, `http://${mod.DEFAULT_HOST}:${mod.DEFAULT_PORT}`);
  const cellsDir = path.join(__dirname, '..');
  const portRe = new RegExp(`\\b${mod.DEFAULT_PORT}\\b`);
  for (const cell of fs.readdirSync(cellsDir)) {
    const dir = path.join(cellsDir, cell);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.mjs') || f === 'lid-bridge.mjs' || /\.test\./.test(f)) continue;
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!portRe.test(text), `cells/${cell}/${f} also uses port ${mod.DEFAULT_PORT}`);
    }
  }
});

test('lid-bridge.mjs start() spawns the HID helper only after the port is bound', async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, 'lid-bridge.mjs')).href);
  const first = mod.createBridgeServer({ host: '127.0.0.1', port: 0, disableHardware: true });
  const { port } = await first.start();
  // With hardware disabled, "helper started" is observable as the 'Hardware probe disabled' snapshot.
  assert.equal(first.getSnapshot().reason, 'Hardware probe disabled');
  const second = mod.createBridgeServer({ host: '127.0.0.1', port, disableHardware: true });
  try {
    await assert.rejects(second.start(), /EADDRINUSE/);
    assert.equal(
      second.getSnapshot().reason,
      'Initializing IOHIDManager bridge…',
      'a bridge that failed to bind must not have started its helper'
    );
  } finally {
    await second.close().catch(() => {});
    await first.close();
  }
});

test('mountLidAngleCell wires shared bus, updates SVG lid, probes HID SSE, and cleans up on lg-secondary-close', async () => {
  const { mountLidAngleCell } = require('./lid-angle.js');

  function makeMockNode(tag, ns) {
    const attrs = new Map();
    const listeners = new Map();
    const classes = new Set();
    const node = {
      tagName: tag.toUpperCase(),
      namespaceURI: ns || null,
      children: [],
      dataset: {},
      style: {},
      hidden: false,
      _text: '',
      get firstChild() {
        return this.children[0] || null;
      },
      get textContent() {
        return this._text;
      },
      set textContent(v) {
        this._text = String(v);
      },
      get className() {
        return Array.from(classes).join(' ');
      },
      set className(v) {
        classes.clear();
        String(v || '')
          .split(/\s+/)
          .filter(Boolean)
          .forEach((c) => classes.add(c));
      },
      classList: {
        add(...cs) {
          cs.forEach((c) => classes.add(c));
        },
        contains(c) {
          return classes.has(c);
        }
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
        return child;
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'class') this.className = v;
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        if (listeners.has(type)) listeners.get(type).delete(fn);
      },
      dispatchEvent(ev) {
        const set = listeners.get(ev.type);
        if (set) set.forEach((fn) => fn(ev));
      },
      focus() {},
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 212, height: 134 };
      }
    };
    return node;
  }

  function findByClass(root, cls) {
    const out = [];
    (function walk(n) {
      if (!n) return;
      if (n.classList && n.classList.contains(cls)) out.push(n);
      if (n.children) n.children.forEach(walk);
    })(root);
    return out;
  }

  const winListeners = new Map();
  const prevDoc = global.document;
  const prevWin = global.window;
  const prevES = global.EventSource;
  const prevFetch = global.fetch;

  let esClosedCount = 0;
  let activeEs = null;
  class MockEventSource {
    constructor(url) {
      this.url = url;
      this._listeners = new Map();
      this.closed = false;
      activeEs = this;
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(fn);
    }
    emit(type, data) {
      const set = this._listeners.get(type);
      if (set) set.forEach((fn) => fn({ data }));
    }
    close() {
      if (!this.closed) {
        this.closed = true;
        esClosedCount++;
      }
    }
  }

  global.document = {
    createElement: (tag) => makeMockNode(tag, null),
    createElementNS: (ns, tag) => makeMockNode(tag, ns),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) })
  };
  global.window = {
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    dispatchEvent(ev) {
      const set = winListeners.get(ev.type);
      if (set) set.forEach((fn) => fn(ev));
    }
  };
  global.EventSource = MockEventSource;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ available: true, angleDeg: 103.5, raw: 103, source: 'iohid' })
  });

  try {
    const registeredTx = new Map();
    let audioCb = null;
    let stateCb = null;
    let txMode = 'off';
    const mockBus = {
      registerTxGenerator(id, fn) {
        registeredTx.set(id, fn);
      },
      subscribeAudio(fn) {
        audioCb = fn;
        return () => {
          audioCb = null;
        };
      },
      onStateChange(fn) {
        stateCb = fn;
        fn({ state: 'idle', sampleRate: 48000, txMode });
        return () => {
          stateCb = null;
        };
      },
      getTxMode: () => txMode,
      setTxMode(m) {
        txMode = m;
        if (stateCb) stateCb({ state: 'listening', sampleRate: 48000, txMode });
      },
      async requestArm(m) {
        txMode = m || 'lid-ping';
        if (stateCb) stateCb({ state: 'listening', sampleRate: 48000, txMode });
        return true;
      }
    };

    const cellEl = makeMockNode('section', null);
    const store = createMockStorage();
    const handle = mountLidAngleCell(cellEl, mockBus, { autoProbeHid: false, storage: store });

    assert.ok(registeredTx.has('lid-ping'), 'expected lid-ping TX generator registered on bus');
    assert.ok(typeof audioCb === 'function', 'expected subscribeAudio callback registered');

    // Feed 48 kHz sonar frames at 55° via bus and confirm UI angle + SVG rotation update
    await mockBus.requestArm('lid-ping');
    for (let i = 0; i < 10; i++) {
      const { frame } = synthesizeScreenBounceFrame({ angleDeg: 55, seed: 500 + i });
      audioCb({ samples: frame.subarray(0, 512), sampleRate: 48000, timeSec: i * 0.02, txMode: 'lid-ping' });
      audioCb({ samples: frame.subarray(512, 1024), sampleRate: 48000, timeSec: i * 0.02 + 0.01, txMode: 'lid-ping' });
    }
    const badge = findByClass(cellEl, 'la-source-badge')[0];
    const angleEl = findByClass(cellEl, 'la-angle-num')[0];
    const lidGroup = findByClass(cellEl, 'la-lid-group')[0];
    assert.equal(badge.textContent, 'SONAR');
    assert.ok(Number(angleEl.textContent) >= 35 && Number(angleEl.textContent) <= 75);
    assert.match(lidGroup.getAttribute('transform'), /^rotate\(-\d+\.\d+ 86 112\)$/);

    // Verify ARIA live region attributes on calNote
    const calNote = findByClass(cellEl, 'la-cal-note')[0];
    assert.equal(calNote.getAttribute('role'), 'status');
    assert.equal(calNote.getAttribute('aria-live'), 'polite');

    // Verify < 40 kHz warning is preserved (not overwritten by refreshDefaultNote)
    stateCb({ state: 'listening', sampleRate: 16000, txMode: 'lid-ping' });
    assert.equal(calNote.textContent, 'Needs >= 40 kHz mic (disable BT HFP)');
    stateCb({ state: 'listening', sampleRate: 48000, txMode: 'lid-ping' });

    // Probe live HID bridge -> switches to HW HID · LIVE with exact 0.1° readout
    const okHid = await handle.probeHidBridge({ userInitiated: true });
    assert.equal(okHid, true);
    assert.equal(badge.textContent, 'HW HID · LIVE');
    assert.equal(findByClass(cellEl, 'la-pill')[0].dataset.tone, 'ok', 'green only while the HID stream delivers');
    assert.equal(angleEl.textContent, '103.5');
    assert.ok(activeEs && !activeEs.closed);

    // Live SSE update updates angle with 0.1° precision
    activeEs.emit('angle', JSON.stringify({ available: true, angleDeg: 92.4, source: 'iohid' }));
    assert.equal(angleEl.textContent, '92.4');

    // Dispatching `lg-secondary-close` cleanly closes SSE EventSource
    global.window.dispatchEvent({ type: 'lg-secondary-close' });
    assert.equal(esClosedCount, 1);
    assert.equal(activeEs.closed, true);

    handle.destroy();
  } finally {
    global.document = prevDoc;
    global.window = prevWin;
    global.EventSource = prevES;
    global.fetch = prevFetch;
  }
});

test('mountLidAngleCell skips eager hidden mount probe, wakes on lg-secondary-open, and prevents EventSource leak on mid-probe close', async () => {
  const { mountLidAngleCell } = require('./lid-angle.js');

  function makeNode(tag, ns, isHiddenAncestor) {
    const attrs = new Map();
    const listeners = new Map();
    const classes = new Set();
    return {
      tagName: tag.toUpperCase(),
      namespaceURI: ns || null,
      children: [],
      dataset: {},
      style: {},
      hidden: false,
      textContent: '',
      get firstChild() {
        return this.children[0] || null;
      },
      get className() {
        return Array.from(classes).join(' ');
      },
      set className(v) {
        classes.clear();
        String(v || '')
          .split(/\s+/)
          .filter(Boolean)
          .forEach((c) => classes.add(c));
      },
      classList: {
        add(...cs) {
          cs.forEach((c) => classes.add(c));
        },
        contains(c) {
          return classes.has(c);
        }
      },
      closest(sel) {
        return sel === '[hidden]' && isHiddenAncestor ? { hidden: true } : null;
      },
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        return c;
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'class') this.className = v;
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      addEventListener(t, fn) {
        if (!listeners.has(t)) listeners.set(t, new Set());
        listeners.get(t).add(fn);
      },
      removeEventListener(t, fn) {
        if (listeners.has(t)) listeners.get(t).delete(fn);
      },
      dispatchEvent(ev) {
        const set = listeners.get(ev.type);
        if (set) set.forEach((fn) => fn(ev));
      },
      focus() {},
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 212, height: 134 };
      }
    };
  }

  const winListeners = new Map();
  const prevDoc = global.document;
  const prevWin = global.window;
  const prevES = global.EventSource;
  const prevFetch = global.fetch;
  const prevLab = global.LeftGrilleLab;

  let fetchCalls = 0;
  let esCreated = 0;
  let esClosed = 0;
  let resolveJson = null;

  class TrackedES {
    constructor(url) {
      this.url = url;
      this.closed = false;
      esCreated++;
    }
    addEventListener() {}
    close() {
      if (!this.closed) {
        this.closed = true;
        esClosed++;
      }
    }
  }

  global.document = {
    createElement: (tag) => makeNode(tag, null, false),
    createElementNS: (ns, tag) => makeNode(tag, ns, false),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) })
  };
  global.window = {
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (winListeners.has(type)) winListeners.get(type).delete(fn);
    },
    dispatchEvent(ev) {
      const set = winListeners.get(ev.type);
      if (set) set.forEach((fn) => fn(ev));
    }
  };
  global.EventSource = TrackedES;
  global.LeftGrilleLab = { isSecondaryOpen: () => false };
  global.fetch = async () => {
    fetchCalls++;
    return {
      ok: true,
      json: () =>
        new Promise((resolve) => {
          resolveJson = resolve;
        })
    };
  };

  try {
    const hiddenCell = makeNode('section', null, true);
    const handle = mountLidAngleCell(hiddenCell, null, { storage: createMockStorage() });

    // 1. No eager fetch when mounted hidden on main grid
    assert.equal(fetchCalls, 0, 'must not eagerly probe HID bridge while hidden on main grid');

    // 2. Opening Cell 05 via lg-secondary-open triggers probe
    global.window.dispatchEvent({ type: 'lg-secondary-open' });
    await Promise.resolve();
    assert.equal(fetchCalls, 1, 'lg-secondary-open must wake up and probe HID bridge');
    assert.equal(typeof resolveJson, 'function');

    // 3. Closing Cell 05 mid-res.json() increments hidEpoch -> resolving JSON MUST NOT leak EventSource
    global.window.dispatchEvent({ type: 'lg-secondary-close' });
    resolveJson({ available: true, angleDeg: 101.2, source: 'iohid' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(esCreated, 0, 'mid-probe lg-secondary-close must prevent EventSource creation');
    assert.equal(esClosed, 0);

    // 4. Re-opening via lg-secondary-open probes cleanly and connects when not closed mid-flight
    resolveJson = null;
    global.window.dispatchEvent({ type: 'lg-secondary-open' });
    await Promise.resolve();
    assert.equal(fetchCalls, 2);
    resolveJson({ available: true, angleDeg: 99.8, source: 'iohid' });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(esCreated, 1, 'open probe should connect EventSource');
    assert.equal(esClosed, 0);

    handle.destroy();
    assert.equal(esClosed, 1);
  } finally {
    global.document = prevDoc;
    global.window = prevWin;
    global.EventSource = prevES;
    global.fetch = prevFetch;
    global.LeftGrilleLab = prevLab;
  }
});

function makeBareNode() {
  return {
    children: [],
    dataset: {},
    style: {},
    hidden: false,
    textContent: '',
    classList: { add() {}, contains: () => false },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    removeChild() {},
    get firstChild() {
      return null;
    },
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    closest: () => null,
    focus() {}
  };
}

test('SONAR: armed-without-echo is labelled, and turning SONAR off releases a mic that SONAR itself armed', async () => {
  const { mountLidAngleCell } = require('./lid-angle.js');
  function el() {
    const listeners = {};
    let cls = '';
    return {
      children: [],
      dataset: {},
      style: {},
      hidden: false,
      textContent: '',
      get className() {
        return cls;
      },
      set className(v) {
        cls = String(v);
      },
      classList: { add(c) { cls += ' ' + c; }, contains: (c) => cls.split(' ').includes(c) },
      appendChild(c) {
        this.children.push(c);
        return c;
      },
      removeChild() {},
      get firstChild() {
        return null;
      },
      setAttribute(k, v) {
        if (k === 'class') cls = String(v);
      },
      getAttribute: () => null,
      addEventListener(t, fn) {
        (listeners[t] = listeners[t] || []).push(fn);
      },
      fire(t) {
        return Promise.all((listeners[t] || []).map((fn) => fn({})));
      },
      closest: () => null,
      focus() {}
    };
  }
  const find = (n, c) => {
    if (n.classList && n.classList.contains(c)) return n;
    for (const k of n.children || []) {
      const f = find(k, c);
      if (f) return f;
    }
    return null;
  };
  const prevDoc = global.document;
  global.document = { createElement: el, createElementNS: el, createTextNode: () => ({}) };
  try {
    let stateCb = null;
    let tx = 'off';
    const stopCalls = [];
    const bus = {
      registerTxGenerator() {},
      subscribeAudio: () => () => {},
      onStateChange(fn) {
        stateCb = fn;
        fn({ state: 'idle', sampleRate: 48000, txMode: tx });
        return () => {};
      },
      getTxMode: () => tx,
      setTxMode(m) {
        tx = m;
        stateCb({ state: 'listening', sampleRate: 48000, txMode: tx });
      },
      async requestArm(m) {
        tx = m;
        stateCb({ state: 'listening', sampleRate: 48000, txMode: tx });
        return true;
      },
      stopAll(opts) {
        stopCalls.push(opts);
        tx = 'off';
        stateCb({ state: 'idle', sampleRate: 48000, txMode: 'off' });
      }
    };
    const cell = el();
    const handle = mountLidAngleCell(cell, bus, { autoProbeHid: false, storage: createMockStorage() });
    const sonarBtn = find(cell, 'la-btn--sonar');
    const badge = find(cell, 'la-source-badge');
    const pill = find(cell, 'la-pill');
    assert.equal(pill.dataset.tone, 'idle');
    await sonarBtn.fire('click');
    assert.equal(badge.textContent, 'SONAR · NO ECHO', 'armed with no echo yet is not a sonar reading');
    assert.equal(pill.dataset.tone, 'attention', 'armed sonar is rust, not green');
    assert.equal(sonarBtn.dataset.tone, 'attention');
    await sonarBtn.fire('click');
    assert.deepEqual(stopCalls, [{ dispatchClose: false }], 'SONAR armed the mic, so SONAR off releases it');
    assert.equal(badge.textContent, 'READY');
    assert.equal(pill.dataset.tone, 'idle');
    assert.equal(sonarBtn.dataset.tone, undefined);

    // When something else armed the bus, SONAR off only stops the lid ping
    stateCb({ state: 'listening', sampleRate: 48000, txMode: 'off' });
    await sonarBtn.fire('click');
    await sonarBtn.fire('click');
    assert.equal(stopCalls.length, 1);
    assert.equal(tx, 'off');

    // SONAR armed the mic, then chirp sonar took over the TX: ownership is gone
    stateCb({ state: 'idle', sampleRate: 48000, txMode: 'off' });
    await sonarBtn.fire('click');
    bus.setTxMode('chirp');
    await sonarBtn.fire('click'); // back to lid-ping
    await sonarBtn.fire('click'); // off: must not kill the mic chirp sonar is using
    assert.equal(stopCalls.length, 1);
    assert.equal(tx, 'off');
    handle.destroy();
  } finally {
    global.document = prevDoc;
  }
});

test('LidCalibration and mountLidAngleCell survive a localStorage global that throws (blocked site data)', () => {
  const { mountLidAngleCell } = require('./lid-angle.js');
  const prevDesc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const prevDoc = global.document;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      const err = new Error('The operation is insecure.');
      err.name = 'SecurityError';
      throw err;
    }
  });
  global.document = {
    createElement: makeBareNode,
    createElementNS: makeBareNode,
    createTextNode: () => ({})
  };
  try {
    const cal = LidCalibration.load();
    assert.equal(cal.isCalibrated, false);
    assert.doesNotThrow(() => cal.setOpenAnchor(-19.5));
    assert.doesNotThrow(() => cal.reset());
    const handle = mountLidAngleCell(makeBareNode(), null, { autoProbeHid: false });
    assert.ok(handle && handle.calibration, 'cell must still mount');
    handle.destroy();
  } finally {
    if (prevDesc) Object.defineProperty(globalThis, 'localStorage', prevDesc);
    else delete globalThis.localStorage;
    global.document = prevDoc;
  }
});

test('mountLidAngleCell closes the bridge event stream while the tab is hidden and reconnects on return', async () => {
  const { mountLidAngleCell } = require('./lid-angle.js');
  const docListeners = {};
  const winListeners = {};
  let visibility = 'visible';
  const prev = {
    document: global.document,
    window: global.window,
    EventSource: global.EventSource,
    fetch: global.fetch,
    LeftGrilleLab: global.LeftGrilleLab
  };
  const sources = [];
  let fetches = 0;
  global.document = {
    get visibilityState() {
      return visibility;
    },
    createElement: makeBareNode,
    createElementNS: makeBareNode,
    createTextNode: () => ({}),
    addEventListener(type, fn) {
      (docListeners[type] = docListeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      docListeners[type] = (docListeners[type] || []).filter((f) => f !== fn);
    }
  };
  global.window = {
    addEventListener(type, fn) {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      winListeners[type] = (winListeners[type] || []).filter((f) => f !== fn);
    }
  };
  global.EventSource = class {
    constructor(url) {
      this.url = url;
      this.closed = false;
      sources.push(this);
    }
    addEventListener() {}
    close() {
      this.closed = true;
    }
  };
  global.fetch = async () => {
    fetches++;
    return { ok: true, json: async () => ({ available: true, angleDeg: 101.5, source: 'iohid' }) };
  };
  global.LeftGrilleLab = { isSecondaryOpen: () => true };
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const setVisibility = async (v) => {
    visibility = v;
    (docListeners.visibilitychange || []).forEach((fn) => fn({}));
    await settle();
  };
  try {
    const cell = makeBareNode();
    const handle = mountLidAngleCell(cell, null, { storage: createMockStorage() });
    await settle();
    assert.equal(fetches, 1);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].closed, false);

    await setVisibility('hidden');
    assert.equal(sources[0].closed, true, 'hidden tab must close the SSE stream');
    assert.equal(fetches, 1);

    await setVisibility('visible');
    assert.equal(fetches, 2, 'visible again re-probes the bridge once');
    assert.equal(sources.length, 2);
    assert.equal(sources[1].closed, false);

    // Bridge dies while open: the hardware note must not stay, and exactly one retry follows
    const findCls = (n, c) => {
      if (n && n.className === c) return n;
      for (const k of (n && n.children) || []) {
        const f = findCls(k, c);
        if (f) return f;
      }
      return null;
    };
    const note = findCls(cell, 'la-cal-note');
    assert.match(note.textContent, /IOHID/);
    const realSetTimeout = global.setTimeout;
    let retryFn = null;
    global.setTimeout = (fn, ms) => {
      if (ms === 2500) {
        retryFn = fn;
        return 0;
      }
      return realSetTimeout(fn, ms);
    };
    try {
      sources[1].onerror();
    } finally {
      global.setTimeout = realSetTimeout;
    }
    assert.doesNotMatch(note.textContent, /IOHID/, 'stale hardware note after the bridge went away');
    assert.equal(typeof retryFn, 'function', 'one bounded retry is scheduled');
    global.fetch = async () => {
      fetches++;
      throw new TypeError('Failed to fetch');
    };
    retryFn();
    await settle();
    assert.equal(fetches, 3);
    assert.equal(sources.length, 2, 'failed retry opens no stream and schedules nothing more');

    // After the page closes, visibility changes must not reconnect anything
    (winListeners['lg-secondary-close'] || []).forEach((fn) => fn({}));
    assert.equal(sources[1].closed, true);
    await setVisibility('hidden');
    await setVisibility('visible');
    assert.equal(fetches, 3);
    assert.equal(sources.length, 2);
    handle.destroy();
  } finally {
    Object.assign(global, prev);
  }
});
