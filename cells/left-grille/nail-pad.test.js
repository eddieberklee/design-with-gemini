const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STORAGE_KEY,
  NailPadClassifier,
  synthesizeSoftPadTap,
  synthesizeNailTap,
  synthesizeNailScratch,
  synthesizeVoicedSpeech,
  mountNailPadCell,
  spec
} = require('./nail-pad.js');

test('1. Soft Pad Tap classification at 48 kHz (duration 10–55 ms, LF 80–950 Hz dominates, centroid < 1.8 kHz)', () => {
  for (const durMs of [18, 28, 44]) {
    const clf = new NailPadClassifier({ sampleRate: 48000 });
    const samples = synthesizeSoftPadTap({
      sampleRate: 48000,
      durationMs: durMs,
      seed: 100 + durMs
    });
    const events = clf.processSamples(samples, 48000);

    assert.equal(events.length, 1, `Expected 1 event for ${durMs}ms soft-pad tap`);
    const ev = events[0];
    assert.equal(ev.gesture, 'soft-pad');
    assert.ok(ev.confidence >= 0.7, `Expected confidence >= 0.70, got ${ev.confidence}`);
    assert.ok(
      ev.centroidKhz < 1.8,
      `Expected soft-pad centroidKhz < 1.8 kHz, got ${ev.centroidKhz}`
    );
    assert.ok(ev.hfLfDb < -2.0, `Expected negative hfLfDb for soft-pad, got ${ev.hfLfDb}`);
    assert.ok(
      ev.durationMs >= 10 && ev.durationMs <= 55,
      `Expected durationMs in 10..55ms, got ${ev.durationMs}`
    );
    assert.ok(ev.intensityPct >= 10 && ev.intensityPct <= 100);
  }
});

test('2. Nail Tap classification at 48 kHz (duration 6–45 ms, < 3 ms attack, 2.8–14 kHz click, centroid > 2.6 kHz)', () => {
  for (const durMs of [10, 16, 30]) {
    const clf = new NailPadClassifier({ sampleRate: 48000 });
    const samples = synthesizeNailTap({
      sampleRate: 48000,
      durationMs: durMs,
      seed: 200 + durMs
    });
    const events = clf.processSamples(samples, 48000);

    assert.equal(events.length, 1, `Expected 1 event for ${durMs}ms nail-tap`);
    const ev = events[0];
    assert.equal(ev.gesture, 'nail-tap');
    assert.ok(ev.confidence >= 0.74, `Expected confidence >= 0.74, got ${ev.confidence}`);
    assert.ok(
      ev.centroidKhz > 2.6,
      `Expected nail-tap centroidKhz > 2.6 kHz, got ${ev.centroidKhz}`
    );
    assert.ok(ev.hfLfDb > 2.0, `Expected positive hfLfDb for nail-tap, got ${ev.hfLfDb}`);
    assert.ok(
      ev.durationMs >= 6 && ev.durationMs <= 45,
      `Expected durationMs in 6..45ms, got ${ev.durationMs}`
    );
    assert.ok(ev.attackMs <= 3.5, `Expected crisp < 3.5 ms attack, got ${ev.attackMs}`);
    assert.ok(ev.crestFactor >= 3.2, `Expected high crest factor, got ${ev.crestFactor}`);
  }
});

test('3. Nail Scratch classification at 48 kHz (duration >= 70 ms, 3.5–15 kHz chatter, Wiener flatness > 0.25)', () => {
  for (const durMs of [95, 165, 260]) {
    const clf = new NailPadClassifier({ sampleRate: 48000 });
    const samples = synthesizeNailScratch({
      sampleRate: 48000,
      durationMs: durMs,
      seed: 300 + durMs
    });
    const events = clf.processSamples(samples, 48000);

    assert.equal(events.length, 1, `Expected 1 event for ${durMs}ms nail-scratch`);
    const ev = events[0];
    assert.equal(ev.gesture, 'nail-scratch');
    assert.ok(ev.confidence >= 0.72, `Expected confidence >= 0.72, got ${ev.confidence}`);
    assert.ok(
      ev.durationMs >= 70,
      `Expected nail-scratch durationMs >= 70 ms, got ${ev.durationMs}`
    );
    assert.ok(
      ev.centroidKhz > 2.8,
      `Expected high scratch centroidKhz > 2.8 kHz, got ${ev.centroidKhz}`
    );
    assert.ok(
      ev.flatness > 0.25,
      `Expected Wiener spectral flatness > 0.25, got ${ev.flatness}`
    );
    assert.ok(ev.zcr >= 0.14, `Expected elevated ZCR >= 0.14, got ${ev.zcr}`);
  }
});

test('4. Voiced speech false-positive rejection across male/female F0 pitches and durations', () => {
  for (const f0Hz of [115, 148, 215]) {
    const telemetryLog = [];
    const clf = new NailPadClassifier({
      sampleRate: 48000,
      onTelemetry: (t) => telemetryLog.push(t)
    });
    const speech = synthesizeVoicedSpeech({
      sampleRate: 48000,
      durationMs: 220,
      f0Hz,
      amplitude: 0.42,
      seed: 400 + f0Hz
    });
    const events = clf.processSamples(speech, 48000);

    assert.equal(
      events.length,
      0,
      `Expected 0 false-positive gestures on voiced speech (F0=${f0Hz}Hz), got ${JSON.stringify(
        events
      )}`
    );
    assert.ok(
      telemetryLog.some((t) => t.vetoReason === 'voice'),
      `Expected voice veto telemetry flag for F0=${f0Hz}Hz`
    );
  }
});

test('5. Strict < 16 kHz passband immunity against 18–21 kHz ultrasonic sonar interference', () => {
  for (const [expected, synthFn] of [
    ['soft-pad', synthesizeSoftPadTap],
    ['nail-tap', synthesizeNailTap],
    ['nail-scratch', synthesizeNailScratch]
  ]) {
    const clf = new NailPadClassifier({ sampleRate: 48000 });
    const samples = synthFn({ sampleRate: 48000, addSonar: true, seed: 777 });
    const events = clf.processSamples(samples, 48000);
    assert.equal(events.length, 1, `Expected 1 event for ${expected} under active 18-21kHz sonar`);
    assert.equal(events[0].gesture, expected);
  }
});

test('6. Sequential multi-gesture stream (Soft Pad -> Nail Tap -> Nail Scratch) in 512-sample shared-bus blocks', () => {
  const clf = new NailPadClassifier({ sampleRate: 48000 });
  const pad = synthesizeSoftPadTap({ sampleRate: 48000, seed: 11 });
  const nail = synthesizeNailTap({ sampleRate: 48000, seed: 22 });
  const scratch = synthesizeNailScratch({ sampleRate: 48000, seed: 33 });

  const stream = new Float32Array(pad.length + nail.length + scratch.length);
  stream.set(pad, 0);
  stream.set(nail, pad.length);
  stream.set(scratch, pad.length + nail.length);

  const collected = [];
  for (let offset = 0; offset < stream.length; offset += 512) {
    const chunk = stream.subarray(offset, Math.min(stream.length, offset + 512));
    const evs = clf.processSamples(chunk, 48000, offset / 48000);
    collected.push(...evs);
  }

  assert.equal(collected.length, 3);
  assert.deepEqual(
    collected.map((e) => e.gesture),
    ['soft-pad', 'nail-tap', 'nail-scratch']
  );
});

test('7. Multi-rate invariance (44.1 kHz and 96 kHz decimation) & NaN/Infinity sanitization', () => {
  for (const sr of [44100, 96000]) {
    const clf = new NailPadClassifier({ sampleRate: sr });
    const badChunk = new Float32Array(256);
    badChunk[10] = NaN;
    badChunk[20] = Infinity;
    badChunk[30] = -Infinity;
    clf.processSamples(badChunk, sr);

    const padEvs = clf.processSamples(synthesizeSoftPadTap({ sampleRate: sr, seed: 51 }), sr);
    assert.equal(padEvs.length, 1, `Expected soft-pad at ${sr} Hz`);
    assert.equal(padEvs[0].gesture, 'soft-pad');

    const nailEvs = clf.processSamples(synthesizeNailTap({ sampleRate: sr, seed: 52 }), sr);
    assert.equal(nailEvs.length, 1, `Expected nail-tap at ${sr} Hz`);
    assert.equal(nailEvs[0].gesture, 'nail-tap');

    const scrEvs = clf.processSamples(synthesizeNailScratch({ sampleRate: sr, seed: 53 }), sr);
    assert.equal(scrEvs.length, 1, `Expected nail-scratch at ${sr} Hz`);
    assert.equal(scrEvs[0].gesture, 'nail-scratch');
  }
});

test('8. Live frame telemetry contract ({ lfLevel, hfLevel, centroidKhz, active }) & localStorage calibration', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };

  try {
    const frames = [];
    const clf = new NailPadClassifier({
      sampleRate: 48000,
      onTelemetry: (f) => frames.push(f)
    });

    const updated = clf.setCalibration({ thresholdDb: 11.5, hfLfBiasDb: 1.5, persist: true });
    assert.equal(updated.thresholdDb, 11.5);
    assert.equal(updated.hfLfBiasDb, 1.5);
    assert.equal(STORAGE_KEY, 'dwg.nailPadCal.v1');
    assert.ok(store.has('dwg.nailPadCal.v1'));

    // Reload from stored calibration
    const clf2 = new NailPadClassifier({ sampleRate: 48000 });
    assert.equal(clf2.getCalibration().thresholdDb, 11.5);
    assert.equal(clf2.getCalibration().hfLfBiasDb, 1.5);

    clf.resetCalibration();
    assert.equal(clf.getCalibration().thresholdDb, 10.0);
    assert.equal(clf.getCalibration().hfLfBiasDb, 0.0);

    const samples = synthesizeNailTap({ sampleRate: 48000, seed: 909 });
    clf.processSamples(samples, 48000);

    assert.ok(frames.length > 10, 'Expected per-quantum telemetry frames');
    assert.ok(frames.some((f) => f.active), 'Expected active telemetry frames during tap');
    for (const f of frames) {
      assert.equal(typeof f.lfLevel, 'number');
      assert.equal(typeof f.hfLevel, 'number');
      assert.equal(typeof f.centroidKhz, 'number');
      assert.equal(typeof f.active, 'boolean');
      assert.ok(f.lfLevel >= 0 && f.lfLevel <= 1);
      assert.ok(f.hfLevel >= 0 && f.hfLevel <= 1);
    }
  } finally {
    delete globalThis.localStorage;
  }
});

test('9. Secondary Slot 3 registration & DOM mount integration with shared bus and synthetic test buttons', () => {
  assert.equal(spec.id, 'nail-pad');
  assert.equal(spec.title, 'Nail vs Soft Pad');
  assert.equal(typeof mountNailPadCell, 'function');

  // Minimal DOM mock to verify zero-innerHTML DOM construction, bus wiring, and immediate synth tests
  class MockNode {
    constructor(tag) {
      this.tagName = tag;
      this.className = '';
      this.textContent = '';
      this.hidden = false;
      this.style = {};
      this.dataset = {};
      this.attrs = {};
      this.children = [];
      this.listeners = {};
      this.classList = {
        add: (c) => {
          this.className = `${this.className} ${c}`.trim();
        }
      };
    }
    get firstChild() {
      return this.children[0] || null;
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
  }

  globalThis.document = {
    head: new MockNode('head'),
    querySelector: () => true,
    createElement: (tag) => new MockNode(tag),
    createElementNS: (_ns, tag) => new MockNode(tag),
    createTextNode: (txt) => ({ nodeType: 3, textContent: String(txt) })
  };

  try {
    let audioSub = null;
    let stateSub = null;
    let armRequested = 0;
    const mockBus = {
      state: 'idle',
      subscribeAudio(fn) {
        audioSub = fn;
        return () => {
          audioSub = null;
        };
      },
      onStateChange(fn) {
        stateSub = fn;
        fn({ state: 'idle', sampleRate: 48000 });
        return () => {
          stateSub = null;
        };
      },
      requestArm() {
        armRequested++;
        return Promise.resolve(true);
      }
    };

    const cellEl = new MockNode('section');
    const mounted = mountNailPadCell(cellEl, mockBus);
    assert.ok(mounted);
    assert.equal(typeof audioSub, 'function');
    assert.equal(typeof stateSub, 'function');

    // Run immediate synthetic waveform tests for all 3 classes through mounted controller
    const padEvs = mounted.runSyntheticWaveform('soft-pad', { immediate: true, seed: 1 });
    assert.equal(padEvs.length, 1);
    assert.equal(padEvs[0].gesture, 'soft-pad');

    const nailEvs = mounted.runSyntheticWaveform('nail-tap', { immediate: true, seed: 2 });
    assert.equal(nailEvs.length, 1);
    assert.equal(nailEvs[0].gesture, 'nail-tap');

    const scrEvs = mounted.runSyntheticWaveform('nail-scratch', { immediate: true, seed: 3 });
    assert.equal(scrEvs.length, 1);
    assert.equal(scrEvs[0].gesture, 'nail-scratch');

    // Also feed samples via bus.subscribeAudio callback
    const busSamples = synthesizeNailTap({ sampleRate: 48000, seed: 44 });
    audioSub({ samples: busSamples, sampleRate: 48000, timeSec: 1.0 });
    assert.equal(mounted.classifier.lastEvent.gesture, 'nail-tap');

    mounted.destroy();
    assert.equal(audioSub, null);
    assert.equal(stateSub, null);
  } finally {
    delete globalThis.document;
  }
});
