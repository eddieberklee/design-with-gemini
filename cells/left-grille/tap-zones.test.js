'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TapZones = require('./tap-zones.js');

function feedBlocks(engine, samples, sampleRate = 48000, blockSize = 512) {
  const events = [];
  for (let off = 0; off < samples.length; off += blockSize) {
    const slice = samples.subarray(off, Math.min(samples.length, off + blockSize));
    const evs = engine.processBlock(slice, sampleRate, off / sampleRate);
    for (let i = 0; i < evs.length; i++) events.push(evs[i]);
  }
  return events;
}

test('4/4 chassis zone classification accuracy on 48 kHz synthesized taps across seeds & tap forces', () => {
  const seeds = [11, 42, 107, 313, 997, 2029];
  const gains = [0.7, 0.9, 1.0, 1.15, 1.35, 0.82];

  for (const zoneId of TapZones.ZONE_ORDER) {
    let correct = 0;
    const riseTimes = [];
    const hfRatios = [];
    const subRatios = [];
    const midRatios = [];

    for (let i = 0; i < seeds.length; i++) {
      const engine = new TapZones.TapZoneEngine({ sampleRate: 48000 });
      const wave = TapZones.synthesizeZoneTap(zoneId, {
        sampleRate: 48000,
        seed: seeds[i],
        gainScale: gains[i]
      });
      const events = feedBlocks(engine, wave, 48000, 512);
      const taps = events.filter((e) => e.type === 'tap');
      assert.equal(taps.length, 1, `Expected 1 tap for ${zoneId} (seed ${seeds[i]}), got ${taps.length}`);
      const tap = taps[0];
      if (tap.zone === zoneId) correct++;
      assert.ok(tap.confidence >= 0.55, `Expected high confidence for ${zoneId}, got ${tap.confidence}`);
      assert.ok(tap.durationMs >= 6 && tap.durationMs <= 65, `Tap duration out of crisp range: ${tap.durationMs}ms`);
      riseTimes.push(tap.features.riseTimeMs);
      hfRatios.push(tap.features.hfAirRatioDb);
      subRatios.push(tap.features.subBassRatioDb);
      midRatios.push(tap.features.midPlateRatioDb);
    }

    assert.equal(correct, seeds.length, `Expected 100% accuracy for ${zoneId}, got ${correct}/${seeds.length}`);

    const meanRise = riseTimes.reduce((a, b) => a + b, 0) / riseTimes.length;
    const meanHf = hfRatios.reduce((a, b) => a + b, 0) / hfRatios.length;
    const meanSub = subRatios.reduce((a, b) => a + b, 0) / subRatios.length;
    const meanMid = midRatios.reduce((a, b) => a + b, 0) / midRatios.length;

    if (zoneId === 'top-left') {
      assert.ok(meanRise < 2.5, `top-left riseTimeMs should be <2.5ms, got ${meanRise}`);
      assert.ok(meanHf > -4.0, `top-left hfAirRatioDb should be bright (>-4dB), got ${meanHf}`);
    } else if (zoneId === 'left-palm') {
      assert.ok(meanSub > -5.0, `left-palm subBassRatioDb should capture woofer boom (>-5dB), got ${meanSub}`);
      assert.ok(meanRise >= 2.0 && meanRise <= 4.5, `left-palm riseTimeMs expected 2.0-4.5ms, got ${meanRise}`);
    } else if (zoneId === 'trackpad-rim') {
      assert.ok(meanMid > -4.0, `trackpad-rim midPlateRatioDb should dominate (>-4dB), got ${meanMid}`);
      assert.ok(meanSub < -10.0, `trackpad-rim subBassRatioDb should be muted (<-10dB), got ${meanSub}`);
      assert.ok(meanRise >= 2.5 && meanRise <= 4.8, `trackpad-rim riseTimeMs expected 2.5-4.8ms, got ${meanRise}`);
    } else if (zoneId === 'right-palm') {
      assert.ok(meanHf < -14.0, `right-palm hfAirRatioDb should be heavily damped across keyboard (<-14dB), got ${meanHf}`);
      assert.ok(meanRise >= 4.5 && meanRise <= 9.5, `right-palm riseTimeMs expected 4.5-9.5ms, got ${meanRise}`);
    }
  }
});

test('Rejects sustained speech/swipes (>90ms) and steady ambient noise without false triggers', () => {
  for (const durSec of [0.14, 0.24, 0.42]) {
    const engine = new TapZones.TapZoneEngine({ sampleRate: 48000 });
    const speech = TapZones.synthesizeSustainedSpeech({
      sampleRate: 48000,
      durationSec: durSec,
      amplitude: 0.16,
      seed: Math.round(durSec * 10000)
    });
    const events = feedBlocks(engine, speech, 48000, 512);
    const taps = events.filter((e) => e.type === 'tap');
    const vetoes = events.filter((e) => e.type === 'veto' && e.reason === 'sustained');
    assert.equal(taps.length, 0, `Sustained ${durSec * 1000}ms speech must produce 0 taps`);
    assert.ok(vetoes.length >= 1, `Sustained ${durSec * 1000}ms speech should emit sustained veto`);
  }

  // Steady ambient room noise (1.0 s) must yield 0 taps
  const noiseEngine = new TapZones.TapZoneEngine({ sampleRate: 48000 });
  const sr = 48000;
  const steadyNoise = new Float32Array(sr);
  let s = 1234567;
  for (let i = 0; i < steadyNoise.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    steadyNoise[i] = ((s / 4294967296) - 0.5) * 0.008;
  }
  const noiseEvents = feedBlocks(noiseEngine, steadyNoise, sr, 512);
  assert.equal(noiseEvents.filter((e) => e.type === 'tap').length, 0, 'Steady noise must produce 0 taps');

  // Verify clean recovery: a real tap following sustained speech is still detected accurately
  const speechThenTap = new TapZones.TapZoneEngine({ sampleRate: 48000 });
  const sp = TapZones.synthesizeSustainedSpeech({ sampleRate: 48000, durationSec: 0.2, postSec: 0.12 });
  const tap = TapZones.synthesizeZoneTap('left-palm', { sampleRate: 48000, seed: 55, preSec: 0.05 });
  const combined = new Float32Array(sp.length + tap.length);
  combined.set(sp, 0);
  combined.set(tap, sp.length);
  const recoveryEvents = feedBlocks(speechThenTap, combined, 48000, 512);
  const recoveredTaps = recoveryEvents.filter((e) => e.type === 'tap');
  assert.equal(recoveredTaps.length, 1, 'Tap after sustained speech must still be detected');
  assert.equal(recoveredTaps[0].zone, 'left-palm');
});

test('Strict <16 kHz ultrasonic sonar immunity (18.375–21.375 kHz bursts & simultaneous carriers)', () => {
  // 1. Direct stopband attenuation check on TapBandFilter
  const sr = 48000;
  function measureGainDb(freqHz) {
    const f = new TapZones.TapBandFilter(sr);
    let inSq = 0;
    let outSq = 0;
    const total = 2400;
    const settle = 600;
    for (let n = 0; n < total; n++) {
      const x = Math.sin((2 * Math.PI * freqHz * n) / sr);
      const y = f.process(x);
      if (n >= settle) {
        inSq += x * x;
        outSq += y * y;
      }
    }
    return 10 * Math.log10((outSq + 1e-18) / (inSq + 1e-18));
  }

  const pass1k = measureGainDb(1000);
  const pass10k = measureGainDb(10000);
  const stop18k = measureGainDb(18375);
  const stop19k = measureGainDb(19600);
  const stop21k = measureGainDb(21000);

  assert.ok(Math.abs(pass1k) < 0.5, `1 kHz passband gain should be ~0 dB, got ${pass1k}`);
  assert.ok(Math.abs(pass10k) < 1.2, `10 kHz passband gain should stay flat, got ${pass10k}`);
  assert.ok(stop18k < -50, `18.375 kHz carrier must be attenuated >50 dB, got ${stop18k} dB`);
  assert.ok(stop19k < -60, `19.6 kHz carrier must be attenuated >60 dB, got ${stop19k} dB`);
  assert.ok(stop21k < -60, `21.0 kHz carrier must be attenuated >60 dB, got ${stop21k} dB`);

  // 2. Loud pulsed ultrasonic burst produces zero taps
  const burstEngine = new TapZones.TapZoneEngine({ sampleRate: sr });
  const burst = TapZones.synthesizeUltrasonicBurst({ sampleRate: sr, amplitude: 0.5 });
  const burstEvents = feedBlocks(burstEngine, burst, sr, 512);
  assert.equal(burstEvents.filter((e) => e.type === 'tap').length, 0, 'Ultrasonic sonar burst must trigger 0 taps');

  // 3. Simultaneous 18.375–21.375 kHz sonar does not degrade 4/4 zone classification
  for (const zoneId of TapZones.ZONE_ORDER) {
    const cleanEng = new TapZones.TapZoneEngine({ sampleRate: sr });
    const sonarEng = new TapZones.TapZoneEngine({ sampleRate: sr });
    const wClean = TapZones.synthesizeZoneTap(zoneId, { sampleRate: sr, seed: 77, sonarAmp: 0 });
    const wSonar = TapZones.synthesizeZoneTap(zoneId, { sampleRate: sr, seed: 77, sonarAmp: 0.4 });
    const tClean = feedBlocks(cleanEng, wClean, sr, 512).find((e) => e.type === 'tap');
    const tSonar = feedBlocks(sonarEng, wSonar, sr, 512).find((e) => e.type === 'tap');
    assert.ok(tClean && tSonar, `Tap must detect cleanly with sonar on for ${zoneId}`);
    assert.equal(tSonar.zone, zoneId, `Sonar+tap must classify as ${zoneId}`);
    assert.ok(
      Math.abs(tSonar.features.hfAirRatioDb - tClean.features.hfAirRatioDb) < 0.05,
      `Ultrasonic carrier leaked into hfAirRatioDb for ${zoneId}`
    );
  }
});

test('110ms refractory cooldown suppresses rebounds while allowing spaced double-taps', () => {
  const sr = 48000;
  // Rebound at +65ms (< 110ms refractory)
  const tap1 = TapZones.synthesizeZoneTap('top-left', { sampleRate: sr, seed: 5, preSec: 0.06, postSec: 0.14 });
  const rebound = TapZones.synthesizeZoneTap('top-left', { sampleRate: sr, seed: 6, preSec: 0.0, postSec: 0.06 });
  const reboundMix = new Float32Array(tap1.length);
  reboundMix.set(tap1);
  const reboundOff = Math.round((0.06 + 0.065) * sr);
  for (let i = 0; i < rebound.length && reboundOff + i < reboundMix.length; i++) {
    reboundMix[reboundOff + i] += rebound[i] * 0.7;
  }
  const rebEng = new TapZones.TapZoneEngine({ sampleRate: sr });
  const rebTaps = feedBlocks(rebEng, reboundMix, sr, 512).filter((e) => e.type === 'tap');
  assert.equal(rebTaps.length, 1, `Rebound 65ms after onset must be suppressed by 110ms refractory (got ${rebTaps.length})`);

  // Distinct double-tap spaced 190ms apart (> 110ms refractory)
  const first = TapZones.synthesizeZoneTap('top-left', { sampleRate: sr, seed: 12, preSec: 0.06, postSec: 0.13 });
  const second = TapZones.synthesizeZoneTap('right-palm', { sampleRate: sr, seed: 19, preSec: 0.06, postSec: 0.12 });
  const seq = new Float32Array(first.length + second.length);
  seq.set(first, 0);
  seq.set(second, first.length);
  const dblEng = new TapZones.TapZoneEngine({ sampleRate: sr });
  const dblTaps = feedBlocks(dblEng, seq, sr, 512).filter((e) => e.type === 'tap');
  assert.equal(dblTaps.length, 2, `Expected 2 distinct taps spaced 190ms apart, got ${dblTaps.length}`);
  assert.equal(dblTaps[0].zone, 'top-left');
  assert.equal(dblTaps[1].zone, 'right-palm');
});

test('1-tap-per-zone quick calibration ([CAL 4Z]) learns shifted chassis acoustics & persists to dwg.tapZonesCal.v1', () => {
  // Simulate a heavily damped / custom-case laptop whose 4 zone acoustics are shifted
  // significantly from factory centroids (in fact permuted/shifted in spectral space)
  const customSignatures = {
    'top-left': {
      subBassRatioDb: -6.0,
      midPlateRatioDb: -4.0,
      hfAirRatioDb: -7.5,
      riseTimeMs: 2.2,
      decayRatio: 3.1,
      peakDb: -16.0
    },
    'left-palm': {
      subBassRatioDb: -14.0,
      midPlateRatioDb: -3.2,
      hfAirRatioDb: -5.0,
      riseTimeMs: 1.8,
      decayRatio: 5.5,
      peakDb: -14.0
    },
    'trackpad-rim': {
      subBassRatioDb: -2.0,
      midPlateRatioDb: -8.5,
      hfAirRatioDb: -15.0,
      riseTimeMs: 5.2,
      decayRatio: 1.7,
      peakDb: -20.0
    },
    'right-palm': {
      subBassRatioDb: -11.0,
      midPlateRatioDb: -1.8,
      hfAirRatioDb: -12.5,
      riseTimeMs: 8.4,
      decayRatio: 1.15,
      peakDb: -28.0
    }
  };

  // Confirm factory classifier gets < 4/4 on this shifted custom chassis
  const factoryCls = new TapZones.TapZoneClassifier();
  let factoryHits = 0;
  for (const z of TapZones.ZONE_ORDER) {
    if (factoryCls.classify(customSignatures[z]).zone === z) factoryHits++;
  }
  assert.ok(factoryHits < 4, `Expected shifted chassis to confuse factory centroids, got ${factoryHits}/4`);

  // Perform 1-tap-per-zone calibration and persist via mock localStorage
  const storeMap = new Map();
  const mockStorage = {
    getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
    setItem: (k, v) => storeMap.set(k, String(v)),
    removeItem: (k) => storeMap.delete(k)
  };

  const payload = factoryCls.calibrateZones(customSignatures);
  assert.ok(payload, 'calibrateZones must return calibration payload');
  assert.equal(TapZones.saveStoredCalibration(payload, mockStorage), true);
  assert.ok(storeMap.has(TapZones.STORAGE_KEY), `Must persist under ${TapZones.STORAGE_KEY}`);

  // Reload into a fresh TapZoneClassifier instance and verify 4/4 accuracy on noisy probes
  const reloaded = TapZones.loadStoredCalibration(mockStorage);
  assert.ok(reloaded, 'loadStoredCalibration must parse stored payload');
  const learnedCls = new TapZones.TapZoneClassifier({ calibration: reloaded });
  assert.equal(learnedCls.isCalibrated(), true);

  for (const z of TapZones.ZONE_ORDER) {
    const base = customSignatures[z];
    const noisyProbe = {
      subBassRatioDb: base.subBassRatioDb + 0.7,
      midPlateRatioDb: base.midPlateRatioDb - 0.6,
      hfAirRatioDb: base.hfAirRatioDb + 0.8,
      riseTimeMs: base.riseTimeMs + 0.25,
      decayRatio: base.decayRatio * 1.08,
      peakDb: base.peakDb - 3.5
    };
    const res = learnedCls.classify(noisyProbe);
    assert.equal(res.zone, z, `Calibrated classifier must predict ${z}, got ${res.zone}`);
    assert.ok(res.confidence >= 0.7, `Expected >=70% calibrated confidence for ${z}, got ${res.confidence}`);
  }

  // Corrupt storage payload safety + reset to factory
  mockStorage.setItem(TapZones.STORAGE_KEY, '{"centroids":{"top-left":{"subBassRatioDb":"bad"}}}');
  assert.equal(TapZones.loadStoredCalibration(mockStorage), null);
  learnedCls.resetToFactory();
  assert.equal(learnedCls.isCalibrated(), false);
  TapZones.saveStoredCalibration(null, mockStorage);
  assert.equal(storeMap.has(TapZones.STORAGE_KEY), false);
});

test('Multi-sample-rate (44.1k, 96k, 16k) classification and NaN/Infinity input resilience', () => {
  for (const sr of [44100, 96000]) {
    for (const z of TapZones.ZONE_ORDER) {
      const eng = new TapZones.TapZoneEngine({ sampleRate: sr });
      const wave = TapZones.synthesizeZoneTap(z, { sampleRate: sr, seed: 303 });
      const taps = feedBlocks(eng, wave, sr, 512).filter((e) => e.type === 'tap');
      assert.equal(taps.length, 1, `Expected 1 tap at ${sr} Hz for ${z}`);
      assert.equal(taps[0].zone, z, `Expected ${z} at ${sr} Hz, got ${taps[0].zone}`);
    }
  }

  // 16 kHz HFP Bluetooth fallback: must stay finite & crash-free
  const eng16k = new TapZones.TapZoneEngine({ sampleRate: 16000 });
  const w16k = TapZones.synthesizeZoneTap('left-palm', { sampleRate: 16000, seed: 88 });
  const ev16k = feedBlocks(eng16k, w16k, 16000, 256);
  for (const ev of ev16k) {
    if (ev.type === 'tap') {
      for (const k of TapZones.FEATURE_KEYS) {
        assert.ok(Number.isFinite(ev.features[k]), `16 kHz feature ${k} must be finite`);
      }
    }
  }

  // NaN / Infinity mid-stream must not poison biquad filter state
  const nanEng = new TapZones.TapZoneEngine({ sampleRate: 48000 });
  const badBlock = new Float32Array(512);
  badBlock[10] = Number.NaN;
  badBlock[20] = Number.POSITIVE_INFINITY;
  badBlock[30] = Number.NEGATIVE_INFINITY;
  nanEng.processBlock(badBlock, 48000, 0);

  const followTap = TapZones.synthesizeZoneTap('trackpad-rim', { sampleRate: 48000, seed: 71, preSec: 0.08 });
  const afterNan = feedBlocks(nanEng, followTap, 48000, 512).filter((e) => e.type === 'tap');
  assert.equal(afterNan.length, 1, 'Detector must recover cleanly after NaN/Infinity block');
  assert.equal(afterNan[0].zone, 'trackpad-rim');

  // Extreme finite overflow spike (1e308) must reset BiquadFilter state instead of permanently bricking TapBandFilter
  const band = new TapZones.TapBandFilter(48000);
  const spikeOut = band.process(1e308);
  assert.equal(Number.isFinite(spikeOut), true, '1e308 spike output must stay finite');
  assert.equal(band.hpf.z1, 0, 'HPF z1 must reset on overflow');
  assert.equal(band.hpf.z2, 0, 'HPF z2 must reset on overflow');
  let recoveredNonZero = false;
  for (let i = 0; i < 16; i++) {
    const y = band.process(0.1);
    assert.equal(Number.isFinite(y), true);
    if (Math.abs(y) > 1e-6) recoveredNonZero = true;
  }
  assert.equal(recoveredNonZero, true, 'TapBandFilter must produce non-zero finite output after 1e308 spike');

  const overflowEng = new TapZones.TapZoneEngine({ sampleRate: 48000 });
  const overflowBlock = new Float64Array(512);
  overflowBlock[12] = 1e308;
  overflowBlock[13] = -1e308;
  overflowEng.processBlock(overflowBlock, 48000, 0);
  const postOverflowTap = TapZones.synthesizeZoneTap('top-left', { sampleRate: 48000, seed: 91, preSec: 0.08 });
  const afterOverflow = feedBlocks(overflowEng, postOverflowTap, 48000, 512).filter((e) => e.type === 'tap');
  assert.equal(afterOverflow.length, 1, 'TapZoneEngine must recover cleanly after 1e308 overflow spike');
  assert.equal(afterOverflow[0].zone, 'top-left');
});

test('Browser slot 2 registration contract (immediate & _pending) and zero innerHTML audit', () => {
  const srcPath = path.join(__dirname, 'tap-zones.js');
  const src = fs.readFileSync(srcPath, 'utf8');

  // Strict zero innerHTML check
  assert.equal(/\.innerHTML\b/.test(src), false, 'tap-zones.js must never assign innerHTML');

  // Path 1: LeftGrilleLab.registerCell already loaded
  let registered = null;
  const ctxImmediate = {
    document: {},
    LeftGrilleLab: {
      registerCell(slot, spec) {
        registered = { slot, spec };
      }
    }
  };
  ctxImmediate.globalThis = ctxImmediate;
  vm.runInNewContext(src, ctxImmediate);
  assert.ok(registered, 'Expected immediate registration into LeftGrilleLab.registerCell');
  assert.equal(registered.slot, 2);
  assert.equal(registered.spec.id, 'tap-zones');
  assert.equal(registered.spec.title, 'Chassis Tap Zones');
  assert.equal(typeof registered.spec.mount, 'function');

  // Path 2: LeftGrilleLab not yet loaded -> queues into _pending
  const ctxDeferred = { document: {} };
  ctxDeferred.globalThis = ctxDeferred;
  vm.runInNewContext(src, ctxDeferred);
  assert.ok(Array.isArray(ctxDeferred.LeftGrilleLab._pending));
  assert.equal(ctxDeferred.LeftGrilleLab._pending.length, 1);
  assert.equal(ctxDeferred.LeftGrilleLab._pending[0][0], 2);
  assert.equal(ctxDeferred.LeftGrilleLab._pending[0][1].id, 'tap-zones');
});

test('mountTapZonesCell renders 4:3 stage, SVG chassis map, bus wiring, simulation, and clean destroy()', () => {
  // Minimal DOM mock to exercise real mountTapZonesCell + SVG click + bus audio + destroy()
  function createMockEl(tag) {
    const attrs = {};
    const listeners = {};
    const classes = new Set();
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      dataset: {},
      style: {},
      hidden: false,
      _text: '',
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
        String(v)
          .split(/\s+/)
          .filter(Boolean)
          .forEach((c) => classes.add(c));
      },
      classList: {
        add: (...cs) => cs.forEach((c) => classes.add(c)),
        remove: (...cs) => cs.forEach((c) => classes.delete(c)),
        contains: (c) => classes.has(c)
      },
      get firstChild() {
        return this.children[0] || null;
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        return child;
      },
      setAttribute(k, v) {
        attrs[k] = String(v);
        if (k === 'class') this.className = v;
      },
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
      },
      addEventListener(type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      dispatch(type, ev = {}) {
        (listeners[type] || []).forEach((fn) => fn(Object.assign({ preventDefault() {} }, ev)));
      },
      getBoundingClientRect() {
        return { width: 320, height: 240 };
      }
    };
    return el;
  }

  function findAll(node, pred, acc = []) {
    if (pred(node)) acc.push(node);
    for (const c of node.children || []) findAll(c, pred, acc);
    return acc;
  }

  const prevDoc = global.document;
  const prevWin = global.window;
  let audioCb = null;
  let stateCb = null;
  let armCalls = 0;
  let audioUnsubbed = false;
  let stateUnsubbed = false;
  const winListeners = {};

  global.document = {
    createElement: (tag) => createMockEl(tag),
    createElementNS: (_ns, tag) => createMockEl(tag),
    createTextNode: (txt) => ({ nodeType: 3, textContent: String(txt), children: [] })
  };
  global.window = {
    addEventListener: (t, fn) => {
      (winListeners[t] = winListeners[t] || []).push(fn);
    },
    removeEventListener: (t, fn) => {
      if (!winListeners[t]) return;
      winListeners[t] = winListeners[t].filter((x) => x !== fn);
    }
  };

  try {
    const cellEl = createMockEl('section');
    const bus = {
      subscribeAudio(fn) {
        audioCb = fn;
        return () => {
          audioUnsubbed = true;
        };
      },
      onStateChange(fn) {
        stateCb = fn;
        fn({ state: 'idle', sampleRate: 48000, txMode: 'off', error: '' });
        return () => {
          stateUnsubbed = true;
        };
      },
      requestArm() {
        armCalls++;
        if (stateCb) stateCb({ state: 'listening', sampleRate: 48000, txMode: 'off', error: '' });
        return Promise.resolve(true);
      }
    };

    const handle = TapZones.mountTapZonesCell(cellEl, bus);
    assert.ok(handle, 'mountTapZonesCell should return handle');
    assert.equal(cellEl.classList.contains('tz-cell'), true);

    const stages = findAll(cellEl, (n) => n.classList && n.classList.contains('tz-stage'));
    assert.equal(stages.length, 1, 'Must wrap content in .tz-stage');

    const zoneNodes = findAll(cellEl, (n) => n.getAttribute && n.getAttribute('data-zone'));
    assert.equal(zoneNodes.length, 4, 'Must render 4 interactive SVG tap zones');

    const zoneValEl = findAll(cellEl, (n) => n.classList && n.classList.contains('tz-zone-val'))[0];
    assert.ok(zoneValEl);

    // Click each zone on SVG -> exercises real 48 kHz synth + DSP + UI readout update
    for (const zNode of zoneNodes) {
      const expectedZone = zNode.getAttribute('data-zone');
      zNode.dispatch('click');
      assert.equal(zoneValEl.textContent, TapZones.ZONES[expectedZone].shortLabel);
    }

    // Arm bus via ARM button, stream real 48 kHz tap blocks through bus.subscribeAudio
    const armBtn = findAll(cellEl, (n) => n.classList && n.classList.contains('tz-btn--arm'))[0];
    armBtn.dispatch('click');
    assert.equal(armCalls, 1);

    const liveWave = TapZones.synthesizeZoneTap('right-palm', { sampleRate: 48000, seed: 505 });
    for (let off = 0; off < liveWave.length; off += 512) {
      audioCb({
        samples: liveWave.subarray(off, Math.min(liveWave.length, off + 512)),
        sampleRate: 48000,
        timeSec: off / 48000
      });
    }
    assert.equal(zoneValEl.textContent, TapZones.ZONES['right-palm'].shortLabel);

    // Clean teardown unsubscribes both bus hooks and removes window listener
    handle.destroy();
    assert.equal(audioUnsubbed, true);
    assert.equal(stateUnsubbed, true);
    assert.equal((winListeners['lg-secondary-close'] || []).length, 0);
  } finally {
    global.document = prevDoc;
    global.window = prevWin;
  }
});

test('mountTapZonesCell [CAL 4Z] capture-phase Escape cancel, focus handoff/restore, and lg-secondary-close timer cleanup', () => {
  let focusedEl = null;

  function createMockEl(tag) {
    const attrs = {};
    const listeners = {};
    const classes = new Set();
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      dataset: {},
      style: {},
      hidden: false,
      _text: '',
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
        String(v)
          .split(/\s+/)
          .filter(Boolean)
          .forEach((c) => classes.add(c));
      },
      classList: {
        add: (...cs) => cs.forEach((c) => classes.add(c)),
        remove: (...cs) => cs.forEach((c) => classes.delete(c)),
        contains: (c) => classes.has(c)
      },
      get firstChild() {
        return this.children[0] || null;
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        return child;
      },
      setAttribute(k, v) {
        attrs[k] = String(v);
        if (k === 'class') this.className = v;
      },
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
      },
      addEventListener(type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      dispatch(type, ev = {}) {
        (listeners[type] || []).forEach((fn) => fn(Object.assign({ preventDefault() {}, stopPropagation() {} }, ev)));
      },
      focus() {
        focusedEl = el;
      },
      getBoundingClientRect() {
        return { width: 320, height: 240 };
      }
    };
    return el;
  }

  function findAll(node, pred, acc = []) {
    if (pred(node)) acc.push(node);
    for (const c of node.children || []) findAll(c, pred, acc);
    return acc;
  }

  const prevDoc = global.document;
  const prevWin = global.window;
  const docCaptureListeners = [];
  const winListeners = {};

  global.document = {
    createElement: (tag) => createMockEl(tag),
    createElementNS: (_ns, tag) => createMockEl(tag),
    createTextNode: (txt) => ({ nodeType: 3, textContent: String(txt), children: [] }),
    addEventListener(type, fn, capture) {
      if (type === 'keydown') docCaptureListeners.push({ fn, capture: Boolean(capture) });
    },
    removeEventListener(type, fn, capture) {
      if (type === 'keydown') {
        const idx = docCaptureListeners.findIndex((l) => l.fn === fn && l.capture === Boolean(capture));
        if (idx >= 0) docCaptureListeners.splice(idx, 1);
      }
    }
  };
  global.window = {
    addEventListener(t, fn) {
      (winListeners[t] = winListeners[t] || []).push(fn);
    },
    removeEventListener(t, fn) {
      if (!winListeners[t]) return;
      winListeners[t] = winListeners[t].filter((x) => x !== fn);
    }
  };

  try {
    const cellEl = createMockEl('section');
    const bus = {
      subscribeAudio() {
        return () => {};
      },
      onStateChange(fn) {
        fn({ state: 'idle', sampleRate: 48000, txMode: 'off', error: '' });
        return () => {};
      },
      requestArm() {
        return Promise.resolve(true);
      }
    };

    const handle = TapZones.mountTapZonesCell(cellEl, bus);
    assert.equal(docCaptureListeners.length, 1);
    assert.equal(docCaptureListeners[0].capture, true, 'Escape listener must be registered in capture phase');

    const calBtn = findAll(cellEl, (n) => n.classList && n.classList.contains('tz-btn--cal'))[0];
    const calBar = findAll(cellEl, (n) => n.classList && n.classList.contains('tz-cal-bar'))[0];
    const calCancelBtn = findAll(calBar, (n) => n.tagName === 'BUTTON')[1];
    assert.ok(calBtn && calBar && calCancelBtn);

    // Opening [CAL 4Z] shows bar and moves focus to calCancelBtn
    calBtn.dispatch('click');
    assert.equal(calBar.hidden, false);
    assert.equal(calBtn.getAttribute('aria-expanded'), 'true');
    assert.equal(focusedEl, calCancelBtn, 'Focus must move to calCancelBtn when opening calibration');

    // Pressing Escape intercepts in capture phase, hides bar, and restores focus to calBtn
    let prevented = false;
    let stopped = false;
    docCaptureListeners[0].fn({
      key: 'Escape',
      preventDefault() {
        prevented = true;
      },
      stopPropagation() {
        stopped = true;
      }
    });
    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.equal(calBar.hidden, true);
    assert.equal(calBtn.getAttribute('aria-expanded'), 'false');
    assert.equal(focusedEl, calBtn, 'Escape must restore focus to calBtn');

    // Completing all 4 calibration zones also restores focus to calBtn
    calBtn.dispatch('click');
    assert.equal(focusedEl, calCancelBtn);
    const zoneNodes = findAll(cellEl, (n) => n.getAttribute && n.getAttribute('data-zone'));
    for (const zNode of zoneNodes) {
      zNode.dispatch('click');
    }
    assert.equal(calBar.hidden, true);
    assert.equal(focusedEl, calBtn, 'Calibration completion must restore focus to calBtn');

    // Triggering lg-secondary-close clears pending activePulseTimer/vetoFlashTimer cleanly
    const origClearTimeout = global.clearTimeout;
    let clearedOnClose = 0;
    global.clearTimeout = (id) => {
      clearedOnClose++;
      return origClearTimeout(id);
    };
    try {
      zoneNodes[0].dispatch('click');
      const beforeCloseClears = clearedOnClose;
      (winListeners['lg-secondary-close'] || []).forEach((fn) => fn());
      assert.ok(
        clearedOnClose > beforeCloseClears,
        'lg-secondary-close must clear pending activePulseTimer/vetoFlashTimer'
      );
    } finally {
      global.clearTimeout = origClearTimeout;
    }

    handle.destroy();
    assert.equal(docCaptureListeners.length, 0, 'destroy() must remove capture-phase keydown listener');
    assert.equal((winListeners['lg-secondary-close'] || []).length, 0);
  } finally {
    global.document = prevDoc;
    global.window = prevWin;
  }
});
