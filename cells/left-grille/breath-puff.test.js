const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BreathPuffDspCore,
  PinwheelPhysics,
  synthesizeBreathWaveform,
  registerIntoLab,
  mountBreathPuffCell
} = require('./breath-puff.js');

function createRng(seed = 101) {
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

function feedInBlocks(core, samples, blockSize = 512) {
  const events = [];
  const sr = core.sampleRate;
  for (let i = 0; i < samples.length; i += blockSize) {
    const chunk = samples.subarray(i, Math.min(samples.length, i + blockSize));
    const evs = core.processSamples(chunk, i / sr);
    for (let k = 0; k < evs.length; k++) events.push(evs[k]);
  }
  return events;
}

test('Detects SHARP PUFF and drives live airflowPct + rotorRpm', () => {
  const core = new BreathPuffDspCore({ sampleRate: 48000 });
  const wave = synthesizeBreathWaveform('puff', { sampleRate: 48000, seed: 7331 });
  const events = feedInBlocks(core, wave);

  const puffs = events.filter((e) => e.type === 'puff').map((e) => e.puff);
  const telemetry = events.filter((e) => e.type === 'telemetry');

  assert.equal(puffs.length, 1, `Expected 1 puff, got ${puffs.length}`);
  assert.equal(puffs[0].kind, 'SHARP PUFF');
  assert.ok(puffs[0].peakSnrDb >= 14, `Expected peakSnrDb >= 14, got ${puffs[0].peakSnrDb}`);
  assert.ok(puffs[0].durationMs >= 95, `Expected durationMs >= 95, got ${puffs[0].durationMs}`);
  assert.ok(puffs[0].attackRiseMs >= 25, `Expected attackRiseMs >= 25, got ${puffs[0].attackRiseMs}`);
  assert.ok(puffs[0].rolloffSubMidDb > 8, `Expected Sub/Mid rolloff > 8 dB`);
  assert.ok(puffs[0].rolloffSubHfDb > 16, `Expected Sub/HF rolloff > 16 dB`);
  assert.ok(puffs[0].impulse > 0.02, `Expected positive aerodynamic impulse`);
  assert.ok(puffs[0].intensityPct >= 45 && puffs[0].intensityPct <= 100);

  const maxFlow = Math.max(...telemetry.map((t) => t.airflowPct));
  const maxRpm = Math.max(...telemetry.map((t) => t.rotorRpm));
  assert.ok(maxFlow >= 40, `Expected airflowPct >= 40, got ${maxFlow}`);
  assert.ok(maxRpm >= 50, `Expected rotorRpm >= 50, got ${maxRpm}`);
});

test('Detects SUSTAINED BLOW with higher duration & impulse than SHARP PUFF', () => {
  const puffCore = new BreathPuffDspCore({ sampleRate: 48000 });
  const puffEvs = feedInBlocks(puffCore, synthesizeBreathWaveform('puff', { sampleRate: 48000 }));
  const sharpPuff = puffEvs.find((e) => e.type === 'puff')?.puff;

  const blowCore = new BreathPuffDspCore({ sampleRate: 48000 });
  const blowEvs = feedInBlocks(blowCore, synthesizeBreathWaveform('blow', { sampleRate: 48000 }));
  const puffs = blowEvs.filter((e) => e.type === 'puff').map((e) => e.puff);

  assert.equal(puffs.length, 1, `Expected 1 sustained blow, got ${puffs.length}`);
  assert.equal(puffs[0].kind, 'SUSTAINED BLOW');
  assert.ok(puffs[0].durationMs >= 450, `Expected duration >= 450 ms, got ${puffs[0].durationMs}`);
  assert.ok(puffs[0].impulse > sharpPuff.impulse * 2, 'Sustained blow must have >2x impulse');
});

test('Detects GENTLE BREEZE on soft low-velocity airflow', () => {
  const core = new BreathPuffDspCore({ sampleRate: 48000 });
  const wave = synthesizeBreathWaveform('breeze', { sampleRate: 48000, seed: 4077 });
  const events = feedInBlocks(core, wave);
  const puffs = events.filter((e) => e.type === 'puff').map((e) => e.puff);

  assert.equal(puffs.length, 1, `Expected 1 gentle breeze, got ${puffs.length}`);
  assert.equal(puffs[0].kind, 'GENTLE BREEZE');
  assert.ok(puffs[0].peakSnrDb >= 14 && puffs[0].peakSnrDb < 22.5);
  assert.ok(puffs[0].durationMs >= 95);
});

test('100% false-positive rejection: sharp <35ms desk taps & resonant 140ms desk thumps', () => {
  const sr = 48000;
  const rng = createRng(555);
  const core = new BreathPuffDspCore({ sampleRate: sr });

  const total = Math.floor(1.4 * sr);
  const sig = new Float32Array(total);
  for (let n = 0; n < total; n++) {
    sig[n] = randNormal(rng) * 0.00055;
  }

  // Event 1 at t=0.25s: sharp 24ms desk tap (fast 2ms rise, 95 Hz damped impulse)
  const tapStart = Math.floor(0.25 * sr);
  const tapLen = Math.floor(0.028 * sr);
  for (let k = 0; k < tapLen; k++) {
    const t = k / sr;
    const env = Math.min(1, t / 0.002) * Math.exp(-t / 0.008);
    sig[tapStart + k] += 0.35 * env * Math.sin(2 * Math.PI * 95 * t);
  }

  // Event 2 at t=0.75s: resonant 140ms wooden desk thump (instant 3ms impact, slow ring)
  const thumpStart = Math.floor(0.75 * sr);
  const thumpLen = Math.floor(0.14 * sr);
  for (let k = 0; k < thumpLen; k++) {
    const t = k / sr;
    const env = Math.min(1, t / 0.003) * Math.exp(-t / 0.045);
    sig[thumpStart + k] += 0.40 * env * (Math.sin(2 * Math.PI * 78 * t) + 0.35 * randNormal(rng) * Math.exp(-t / 0.015));
  }

  const events = feedInBlocks(core, sig);
  const puffs = events.filter((e) => e.type === 'puff');
  const vetoes = events.filter((e) => e.type === 'telemetry' && e.vetoReason === 'impulse');

  assert.equal(puffs.length, 0, `Desk taps/thumps must yield 0 puffs, got ${JSON.stringify(puffs)}`);
  assert.ok(vetoes.length > 0, 'Expected impulse veto telemetry');
});

test('100% false-positive rejection: high-frequency nail scratches & grille rubs', () => {
  const sr = 48000;
  const rng = createRng(888);
  const core = new BreathPuffDspCore({ sampleRate: sr });

  const total = Math.floor(1.1 * sr);
  const sig = new Float32Array(total);
  let prev = 0;
  const s0 = Math.floor(0.24 * sr);
  const s1 = Math.floor(0.68 * sr);

  for (let n = 0; n < total; n++) {
    let x = randNormal(rng) * 0.00055;
    if (n >= s0 && n < s1) {
      const prog = (n - s0) / (s1 - s0);
      const env = Math.sin(Math.PI * prog);
      const w = randNormal(rng);
      const hp = w - prev;
      prev = w;
      // Strong 1–9 kHz tribological rub + tiny low rumble (non-steep rolloff)
      x += env * (0.045 * hp + 0.018 * w);
    }
    sig[n] = x;
  }

  const events = feedInBlocks(core, sig);
  const puffs = events.filter((e) => e.type === 'puff');
  const frictionVetoes = events.filter((e) => e.type === 'telemetry' && e.vetoReason === 'friction');

  assert.equal(puffs.length, 0, 'High-frequency scratches must yield 0 puffs');
  assert.ok(frictionVetoes.length > 0, 'Expected friction veto telemetry');
});

test('100% false-positive rejection: voiced speech & 120 Hz humming with harmonics', () => {
  const sr = 48000;
  const rng = createRng(999);
  const core = new BreathPuffDspCore({ sampleRate: sr });

  const total = Math.floor(1.6 * sr);
  const sig = new Float32Array(total);
  for (let n = 0; n < total; n++) {
    sig[n] = randNormal(rng) * 0.00055;
  }

  // Case A (0.24s - 0.74s): 120 Hz hum "mmmm" + harmonics (240, 360, 480 Hz) with smooth breath-like envelope
  const a0 = Math.floor(0.24 * sr);
  const a1 = Math.floor(0.74 * sr);
  for (let n = a0; n < a1; n++) {
    const t = (n - a0) / sr;
    const prog = (n - a0) / (a1 - a0);
    const env = prog < 0.15 ? prog / 0.15 : prog > 0.85 ? (1 - prog) / 0.15 : 1;
    const hum =
      0.16 * Math.sin(2 * Math.PI * 120 * t) +
      0.06 * Math.sin(2 * Math.PI * 240 * t) +
      0.025 * Math.sin(2 * Math.PI * 360 * t) +
      0.01 * Math.sin(2 * Math.PI * 480 * t);
    sig[n] += env * hum;
  }

  // Case B (0.95s - 1.38s): Voiced speech "hello" (145 Hz F0 + harmonics + mild breath aspiration)
  const b0 = Math.floor(0.95 * sr);
  const b1 = Math.floor(1.38 * sr);
  for (let n = b0; n < b1; n++) {
    const t = (n - b0) / sr;
    const prog = (n - b0) / (b1 - b0);
    const env = Math.sin(Math.PI * prog);
    const f0 = 145 + 18 * Math.sin(2 * Math.PI * 2.2 * t);
    const voiced =
      0.11 * Math.sin(2 * Math.PI * f0 * t) +
      0.09 * Math.sin(2 * Math.PI * 2 * f0 * t) +
      0.05 * Math.sin(2 * Math.PI * 3 * f0 * t) +
      0.02 * Math.sin(2 * Math.PI * 4 * f0 * t) +
      0.004 * randNormal(rng);
    sig[n] += env * voiced;
  }

  const events = feedInBlocks(core, sig);
  const puffs = events.filter((e) => e.type === 'puff');
  const voicedVetoes = events.filter((e) => e.type === 'telemetry' && e.vetoReason === 'voiced');

  assert.equal(puffs.length, 0, `Voiced speech/hum must yield 0 puffs, got ${JSON.stringify(puffs)}`);
  assert.ok(voicedVetoes.length > 0, 'Expected voiced veto telemetry');
});

test('Sample-rate invariance (44.1 kHz & 96 kHz) and NaN sanitization', () => {
  for (const sr of [44100, 96000]) {
    const core = new BreathPuffDspCore({ sampleRate: sr });
    const preNan = new Float32Array(512);
    preNan[10] = NaN;
    preNan[20] = Infinity;
    core.processSamples(preNan, 0);

    const wave = synthesizeBreathWaveform('puff', { sampleRate: sr, seed: 1234 });
    const events = feedInBlocks(core, wave);
    const puffs = events.filter((e) => e.type === 'puff').map((e) => e.puff);
    assert.equal(puffs.length, 1, `Expected 1 puff at ${sr} Hz`);
    assert.equal(puffs[0].kind, 'SHARP PUFF');
    assert.ok(Number.isFinite(puffs[0].peakSnrDb));
  }
});

test('PinwheelPhysics accelerates with airflow and decays to 0 RPM via viscous drag', () => {
  const rotor = new PinwheelPhysics();
  for (let i = 0; i < 40; i++) rotor.step(85, 0.016);
  const peakRpm = rotor.step(85, 0.016).rpm;
  assert.ok(peakRpm > 120, `Expected high RPM under airflow, got ${peakRpm}`);

  for (let i = 0; i < 250; i++) rotor.step(0, 0.016);
  const restRpm = rotor.step(0, 0.016).rpm;
  assert.equal(restRpm, 0, `Expected rotor to coast down to 0 RPM, got ${restRpm}`);
});

test('LeftGrilleLab Slot 5 registration and DOM mount + Sim Puff/Blow smoke check', () => {
  // Minimal DOM mock without innerHTML
  function makeMockEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      className: '',
      children: [],
      attributes: {},
      dataset: {},
      style: {},
      listeners: {},
      _text: '',
      classList: {
        _set: new Set(),
        add(...cls) {
          cls.forEach((c) => this._set.add(c));
          el.className = Array.from(this._set).join(' ');
        }
      },
      setAttribute(k, v) {
        this.attributes[k] = String(v);
        if (k === 'class') this.className = String(v);
      },
      getAttribute(k) {
        return this.attributes[k];
      },
      addEventListener(type, fn) {
        (this.listeners[type] = this.listeners[type] || []).push(fn);
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
      },
      get firstChild() {
        return this.children[0] || null;
      },
      set textContent(v) {
        this._text = String(v);
      },
      get textContent() {
        if (this.children.length === 0) return this._text;
        return this._text + this.children.map((c) => c.textContent || '').join(' ');
      }
    };
    return el;
  }

  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement: (t) => makeMockEl(t),
    createElementNS: (_ns, t) => makeMockEl(t),
    createTextNode: (txt) => ({ textContent: String(txt) })
  };

  try {
    const fakeGlobal = {};
    const specPending = registerIntoLab(fakeGlobal);
    assert.equal(fakeGlobal.LeftGrilleLab._pending.length, 1);
    assert.equal(fakeGlobal.LeftGrilleLab._pending[0][0], 5);
    assert.equal(specPending.id, 'breath-puff');

    let registeredSlot = null;
    fakeGlobal.LeftGrilleLab.registerCell = (slot, spec) => {
      registeredSlot = { slot, spec };
    };
    registerIntoLab(fakeGlobal);
    assert.equal(registeredSlot.slot, 5);

    const cellEl = makeMockEl('div');
    let audioCb = null;
    let armedCalled = 0;
    const bus = {
      subscribeAudio(cb) {
        audioCb = cb;
        return () => {
          audioCb = null;
        };
      },
      requestArm() {
        armedCalled++;
        return Promise.resolve(true);
      },
      onStateChange(cb) {
        cb({ state: 'listening', sampleRate: 48000, txMode: 'off', micLabel: 'Built-in', error: '' });
        return () => {};
      }
    };

    const inst = mountBreathPuffCell(cellEl, bus);
    assert.ok(cellEl.classList._set.has('bp-cell'));
    assert.ok(typeof audioCb === 'function');

    // Feed live synthesized sustained blow via bus.subscribeAudio
    const blowWave = synthesizeBreathWaveform('blow', { sampleRate: 48000 });
    for (let i = 0; i < blowWave.length; i += 512) {
      audioCb({
        samples: blowWave.subarray(i, Math.min(blowWave.length, i + 512)),
        sampleRate: 48000,
        timeSec: i / 48000
      });
    }
    assert.ok(cellEl.textContent.includes('SUSTAINED BLOW'), 'UI should display SUSTAINED BLOW badge');

    const simRes = inst.runSimulation('puff');
    assert.equal(simRes.kind, 'SHARP PUFF');
    inst.destroy();
    assert.equal(audioCb, null);
    assert.equal(armedCalled, 0);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('Disarm calls stopAll({ dispatchClose: false }), idle resets DSP cooldown across t=120s -> t=0s rearm, and bezel renders 05 kicker', () => {
  function makeMockEl(tag) {
    const el = {
      tagName: String(tag).toUpperCase(),
      className: '',
      children: [],
      attributes: {},
      dataset: {},
      style: {},
      listeners: {},
      _text: '',
      classList: {
        _set: new Set(),
        add(...cls) {
          cls.forEach((c) => this._set.add(c));
          el.className = Array.from(this._set).join(' ');
        }
      },
      setAttribute(k, v) {
        this.attributes[k] = String(v);
        if (k === 'class') this.className = String(v);
      },
      getAttribute(k) {
        return this.attributes[k];
      },
      addEventListener(type, fn) {
        (this.listeners[type] = this.listeners[type] || []).push(fn);
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
      },
      get firstChild() {
        return this.children[0] || null;
      },
      set textContent(v) {
        this._text = String(v);
      },
      get textContent() {
        if (this.children.length === 0) return this._text;
        return this._text + this.children.map((c) => c.textContent || '').join(' ');
      }
    };
    return el;
  }

  function findAll(node, pred, acc = []) {
    if (pred(node)) acc.push(node);
    for (const c of node.children || []) findAll(c, pred, acc);
    return acc;
  }

  const prevDoc = globalThis.document;
  globalThis.document = {
    createElement: (t) => makeMockEl(t),
    createElementNS: (_ns, t) => makeMockEl(t),
    createTextNode: (txt) => ({ textContent: String(txt), children: [] })
  };

  try {
    const cellEl = makeMockEl('div');
    let audioCb = null;
    let stateCb = null;
    const stopAllCalls = [];
    const bus = {
      subscribeAudio(cb) {
        audioCb = cb;
        return () => {
          audioCb = null;
        };
      },
      requestArm() {
        stateCb({ state: 'listening', sampleRate: 48000, txMode: 'off', micLabel: 'Built-in', error: '' });
        return Promise.resolve(true);
      },
      stopAll(opts) {
        stopAllCalls.push(opts);
        stateCb({ state: 'idle', sampleRate: 48000, txMode: 'off', micLabel: 'Built-in', error: '' });
      },
      onStateChange(cb) {
        stateCb = cb;
        cb({ state: 'listening', sampleRate: 48000, txMode: 'off', micLabel: 'Built-in', error: '' });
        return () => {
          stateCb = null;
        };
      }
    };

    const inst = mountBreathPuffCell(cellEl, bus);

    // 1. Slot 05 kicker badge present in .bp-bezel
    const kicker = findAll(cellEl, (n) => n.className && n.className.includes('bp-kicker'))[0];
    assert.ok(kicker, 'Expected .bp-kicker badge in .bp-bezel');
    assert.equal(kicker.textContent, '05');

    const armBtn = findAll(cellEl, (n) => n.className && n.className.includes('bp-btn--arm'))[0];
    const heroBadge = findAll(cellEl, (n) => n.className && n.className.includes('bp-hero-badge'))[0];
    const srLive = findAll(cellEl, (n) => n.className && n.className.includes('bp-sr-only'))[0];

    // 2. Detect sustained blow at t = 120 s (sets dsp.cooldownUntilSec > 120 s)
    const blowWave = synthesizeBreathWaveform('blow', { sampleRate: 48000, seed: 9103 });
    for (let i = 0; i < blowWave.length; i += 512) {
      audioCb({
        samples: blowWave.subarray(i, Math.min(blowWave.length, i + 512)),
        sampleRate: 48000,
        timeSec: 120 + i / 48000
      });
    }
    assert.equal(heroBadge.textContent, 'SUSTAINED BLOW');

    // 3. Disarming via LIVE button must pass { dispatchClose: false } and reset DSP on idle
    armBtn.listeners.click[0]();
    assert.equal(stopAllCalls.length, 1);
    assert.deepEqual(stopAllCalls[0], { dispatchClose: false });

    // 4. Re-arm with bus timeSec restarting at 0 s -> immediate puff around t = 0.3 s must detect!
    armBtn.listeners.click[0]();
    srLive.textContent = '';
    const puffWave = synthesizeBreathWaveform('puff', { sampleRate: 48000, preSec: 0.2, seed: 7331 });
    for (let i = 0; i < puffWave.length; i += 512) {
      audioCb({
        samples: puffWave.subarray(i, Math.min(puffWave.length, i + 512)),
        sampleRate: 48000,
        timeSec: i / 48000
      });
    }
    assert.equal(heroBadge.textContent, 'SHARP PUFF', 'Puff at t=0.3s after disarm/rearm must detect immediately');
    assert.ok(srLive.textContent.includes('SHARP PUFF'));

    inst.destroy();
  } finally {
    globalThis.document = prevDoc;
  }
});
