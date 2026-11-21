const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const {
  CHIRP_PERIOD,
  CHIRP_ACTIVE_LEN,
  F_START_HZ,
  F_END_HZ,
  STORAGE_KEY,
  fftRadix2,
  buildLidPingWaveform,
  generateLidPingBlock,
  computeReflectionIndex,
  LidCalibration,
  LidAngleKalman,
  LidSonarEstimator,
  synthesizeScreenBounceFrame
} = require('./lid-angle.js');

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
    // Push in realistic 512-sample shared-bus chunks
    const halfA = frame.subarray(0, 512);
    const halfB = frame.subarray(512, 1024);
    const r1 = est.pushSamples(halfA, sr, txMode);
    assert.equal(r1.length, 0);
    const r2 = est.pushSamples(halfB, sr, txMode);
    assert.equal(r2.length, 1);
    last = r2[0];
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

test('Passively piggybacking on Cell 04 chirp TX mode preserves monotonic 35° < 75° < 120°', () => {
  const c35 = measureSettledAngle(35, { txMode: 'chirp' });
  const c75 = measureSettledAngle(75, { txMode: 'chirp' });
  const c120 = measureSettledAngle(120, { txMode: 'chirp' });

  assert.equal(c35.signalPresent, true);
  assert.equal(c75.signalPresent, true);
  assert.equal(c120.signalPresent, true);
  assert.equal(c75.txMode, 'chirp');
  assert.ok(c35.angleDeg < c75.angleDeg - 15, `chirp 35° (${c35.angleDeg}) vs 75° (${c75.angleDeg})`);
  assert.ok(c75.angleDeg < c120.angleDeg - 15, `chirp 75° (${c75.angleDeg}) vs 120° (${c120.angleDeg})`);
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
  await bridge.start();
  const addr = bridge.server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const angleRes = await fetch(`${baseUrl}/angle`);
    assert.equal(angleRes.status, 200);
    assert.equal(angleRes.headers.get('access-control-allow-origin'), '*');
    const angleJson = await angleRes.json();
    assert.equal(angleJson.available, false);
    assert.equal(angleJson.source, 'iohid');

    const optRes = await fetch(`${baseUrl}/angle`, { method: 'OPTIONS' });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get('access-control-allow-origin'), '*');

    // Verify SSE /events emits initial `event: angle` frame with CORS header
    const sseChunk = await new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}/events`, (res) => {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['access-control-allow-origin'], '*');
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

    // Probe live HID bridge -> switches to HW HID · LIVE with exact 0.1° readout
    const okHid = await handle.probeHidBridge({ userInitiated: true });
    assert.equal(okHid, true);
    assert.equal(badge.textContent, 'HW HID · LIVE');
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
