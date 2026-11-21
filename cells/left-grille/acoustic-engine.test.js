const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  AcousticDspCore,
  QUANTUM,
  SPEED_OF_SOUND_CMS,
  OBLIQUE_GEOMETRY_FACTOR,
  buildCarrierMultiples,
  createWorkletSource
} = require('./acoustic-engine.js');
const { LeftGrilleSensorController } = require('./acoustic-controller.js');

function createRng(seed = 1337) {
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

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function simulateGrilleAudio({
  core,
  preIdleSec = 0.28,
  swipeDurationSec = 0.42,
  postIdleSec = 0.22,
  yStart = 0.88,
  yEnd = 0.12,
  contactFriction = true,
  sonarReflection = true,
  tweeterNonlinearImd = false,
  seed = 42
}) {
  const sr = core.sampleRate;
  const rng = createRng(seed);
  const totalSamples = Math.floor((preIdleSec + swipeDurationSec + postIdleSec) * sr);
  const txBuf = new Float32Array(QUANTUM);
  const rxAll = new Float32Array(totalSamples);

  let lpMid = 0;
  let lpSub = 0;
  let lpHpRef = 0;
  const alphaMid = 1 - Math.exp((-2 * Math.PI * Math.min(1900, sr * 0.14)) / sr);
  const alphaSub = 1 - Math.exp((-2 * Math.PI * 130) / sr);
  const alphaHp = 1 - Math.exp((-2 * Math.PI * Math.min(5500, sr * 0.30)) / sr);

  const swipeStartSample = Math.floor(preIdleSec * sr);
  const swipeEndSample = swipeStartSample + Math.floor(swipeDurationSec * sr);

  const crestPhases = core.carrierMultiples.map((_, k) => (Math.PI * k * k) / core.numCarriers);

  for (let n = 0; n < totalSamples; n++) {
    if ((n & 127) === 0) {
      core.fillTxBlock(txBuf, null);
    }
    const wNoise = randNormal(rng);
    let sample = wNoise * 0.00055;

    const inSwipe = n >= swipeStartSample && n < swipeEndSample;
    const progress = inSwipe
      ? (n - swipeStartSample) / Math.max(1, swipeEndSample - swipeStartSample)
      : n < swipeStartSample
      ? 0
      : 1;

    let env = 0;
    if (inSwipe) {
      const edge = 0.1;
      if (progress < edge) env = 0.5 * (1 - Math.cos((Math.PI * progress) / edge));
      else if (progress > 1 - edge) env = 0.5 * (1 - Math.cos((Math.PI * (1 - progress)) / edge));
      else env = 1.0;
    }

    const y = yStart + (yEnd - yStart) * progress;
    const distToMicCm = Math.max(0.8, y * core.grilleLengthCm);

    const pinholeCover = inSwipe && contactFriction ? Math.exp(-Math.pow((y - 0.13) / 0.11, 2)) : 0;
    const txSample = txBuf[n & 127];
    sample += txSample * 0.35 * (1.0 - 0.62 * pinholeCover * env);

    if (tweeterNonlinearImd) {
      sample += 0.08 * txSample * txSample;
    }

    if (inSwipe && sonarReflection && core.txEnabled && core.numCarriers > 0) {
      const reflAmp = 0.0042 * env;
      for (let k = 0; k < core.numCarriers; k++) {
        const f = core.carrierFreqs[k];
        const phaseDelay =
          (2 * Math.PI * f * (OBLIQUE_GEOMETRY_FACTOR * distToMicCm)) / SPEED_OF_SOUND_CMS;
        const thetaTx =
          (2 * Math.PI * core.carrierMultiples[k] * (n % core.txPeriod)) / core.txPeriod +
          crestPhases[k];
        sample += (reflAmp / core.numCarriers) * Math.cos(thetaTx - phaseDelay);
      }
    }

    if (inSwipe && contactFriction) {
      const rubWhite = randNormal(rng);
      lpMid += alphaMid * (rubWhite - lpMid);
      lpSub += alphaSub * (rubWhite - lpSub);
      lpHpRef += alphaHp * (rubWhite - lpHpRef);
      const hpAir = (rubWhite - lpHpRef) * 2.0;

      const topProx = clamp01(1 - y);
      const chassisGain = 0.0045 + 0.014 * Math.pow(topProx, 1.3);
      const airHoleGain = 0.0004 + 0.026 * Math.pow(topProx, 2.4);
      const pneuGain = 0.035 * pinholeCover;

      sample += env * (chassisGain * lpMid + airHoleGain * hpAir + pneuGain * lpSub);
    }

    rxAll[n] = sample;
  }

  return core.processSamples(rxAll);
}

test('Non-uniform carrier comb and >= 2-bin Hann-zero clearance on guardBins', () => {
  for (const sr of [44100, 48000, 96000, 192000]) {
    const core = new AcousticDspCore({ sampleRate: sr });
    assert.ok(core.numCarriers >= 4, `Expected >=4 carriers at ${sr}`);
    assert.ok(core.carrierFreqs[0] >= 17200, `Expected ultrasonic carrier at ${sr}, got ${core.carrierFreqs[0]}`);
    for (let i = 1; i < core.carrierMultiples.length; i++) {
      assert.ok(core.carrierMultiples[i] - core.carrierMultiples[i - 1] >= 2);
    }
    assert.ok(core.guardBins.length >= 2, `Expected non-empty guardBins at ${sr}`);
    for (const gb of core.guardBins) {
      for (const m of core.carrierMultiples) {
        assert.ok(
          Math.abs(gb - m) >= 2,
          `Guard bin ${gb} within Hann mainlobe of carrier ${m} at ${sr} Hz`
        );
      }
    }
  }
});

test('createWorkletSource() parses, instantiates, and processes quanta cleanly in isolated AudioWorkletGlobalScope', () => {
  const src = createWorkletSource();
  let registeredName = null;
  let ProcessorCls = null;
  const posted = [];

  class MockAudioWorkletProcessor {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (m) => posted.push(m)
      };
    }
  }

  const sandbox = {
    sampleRate: 48000,
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    registerProcessor: (name, cls) => {
      registeredName = name;
      ProcessorCls = cls;
    },
    Float32Array,
    Float64Array,
    Math,
    Number,
    Object,
    Array,
    Set
  };

  vm.runInNewContext(src, sandbox);
  assert.equal(registeredName, 'left-grille-swipe-processor');
  assert.equal(typeof ProcessorCls, 'function');

  const proc = new ProcessorCls({ processorOptions: { txEnabled: true, txGain: 0.036, polarity: 1 } });
  const inCh = new Float32Array(128);
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);
  outR.fill(0.5);

  for (let q = 0; q < 12; q++) {
    const keepAlive = proc.process([[inCh]], [[outL, outR]]);
    assert.equal(keepAlive, true);
  }
  assert.ok(outL.some((v) => Math.abs(v) > 1e-4), 'Expected Left TX ultrasonic output');
  assert.ok(outR.every((v) => v === 0), 'Expected strict digital zero on Right channel');
  assert.ok(posted.length >= 3, 'Expected telemetry messages posted from worklet');

  // Verify message handlers inside worklet (`setTx`, `startCalStep`, `cancelCalStep`, `finishCalStep`)
  proc.port.onmessage({ data: { type: 'startCalStep', step: 'up' } });
  proc.port.onmessage({ data: { type: 'cancelCalStep' } });
  proc.port.onmessage({ data: { type: 'finishCalStep' } });
  const calMsg = posted.find((m) => m.type === 'calibrationResult');
  assert.ok(calMsg && calMsg.result.ok === false);
});

test('Swipe UP vs Swipe DOWN detection across slow, medium, and fast speeds + nonlinear tweeter IMD', () => {
  const scenarios = [
    { label: 'slow UP', yStart: 0.90, yEnd: 0.12, dur: 0.85, expectedDir: 'up' },
    { label: 'medium UP', yStart: 0.88, yEnd: 0.10, dur: 0.38, expectedDir: 'up' },
    { label: 'fast flick UP', yStart: 0.92, yEnd: 0.08, dur: 0.16, expectedDir: 'up' },
    { label: 'slow DOWN', yStart: 0.10, yEnd: 0.90, dur: 0.85, expectedDir: 'down' },
    { label: 'medium DOWN', yStart: 0.12, yEnd: 0.88, dur: 0.38, expectedDir: 'down' },
    { label: 'fast flick DOWN', yStart: 0.08, yEnd: 0.92, dur: 0.16, expectedDir: 'down' }
  ];

  const recordedSpeeds = {};
  for (const sc of scenarios) {
    const core = new AcousticDspCore({ sampleRate: 48000 });
    const events = simulateGrilleAudio({
      core,
      swipeDurationSec: sc.dur,
      yStart: sc.yStart,
      yEnd: sc.yEnd,
      tweeterNonlinearImd: true,
      seed: 100 + Math.round(sc.dur * 100)
    });
    const swipes = events.filter((e) => e.type === 'swipe').map((e) => e.swipe);
    assert.equal(swipes.length, 1, `Expected 1 swipe for ${sc.label}, got ${swipes.length}`);
    assert.equal(swipes[0].direction, sc.expectedDir, `Wrong direction for ${sc.label}`);
    assert.ok(swipes[0].confidence >= 0.55);
    recordedSpeeds[sc.label] = swipes[0].speedCmPerSec;
  }

  assert.ok(
    recordedSpeeds['slow UP'] < recordedSpeeds['medium UP'] &&
      recordedSpeeds['medium UP'] < recordedSpeeds['fast flick UP']
  );
  assert.ok(
    recordedSpeeds['slow DOWN'] < recordedSpeeds['medium DOWN'] &&
      recordedSpeeds['medium DOWN'] < recordedSpeeds['fast flick DOWN']
  );
});

test('Pure ultrasonic hover swipes (zero surface rub, left-speaker sonar reflection only)', () => {
  for (const [dir, yStart, yEnd] of [
    ['up', 0.85, 0.15],
    ['down', 0.15, 0.85]
  ]) {
    const core = new AcousticDspCore({ sampleRate: 48000 });
    const events = simulateGrilleAudio({
      core,
      swipeDurationSec: 0.36,
      yStart,
      yEnd,
      contactFriction: false,
      sonarReflection: true,
      seed: dir === 'up' ? 777 : 888
    });
    const swipes = events.filter((e) => e.type === 'swipe').map((e) => e.swipe);
    assert.equal(swipes.length, 1);
    assert.equal(swipes[0].direction, dir);
    assert.equal(swipes[0].sensingMode, 'ultrasonic');
  }
});

test('Relative distance from Top and Bottom distinguishes upper-half vs lower-half swipes', () => {
  const coreTop = new AcousticDspCore({ sampleRate: 48000 });
  const topSwipe = simulateGrilleAudio({
    core: coreTop,
    swipeDurationSec: 0.40,
    yStart: 0.46,
    yEnd: 0.08,
    seed: 201
  }).find((e) => e.type === 'swipe')?.swipe;
  assert.ok(topSwipe);
  assert.equal(topSwipe.direction, 'up');

  const coreBot = new AcousticDspCore({ sampleRate: 48000 });
  const botSwipe = simulateGrilleAudio({
    core: coreBot,
    swipeDurationSec: 0.40,
    yStart: 0.52,
    yEnd: 0.92,
    seed: 202
  }).find((e) => e.type === 'swipe')?.swipe;
  assert.ok(botSwipe);
  assert.equal(botSwipe.direction, 'down');

  assert.ok(topSwipe.distanceFromTopPct < 35, `Got ${topSwipe.distanceFromTopPct}%`);
  assert.ok(botSwipe.distanceFromTopPct > 65, `Got ${botSwipe.distanceFromTopPct}%`);
  assert.equal(Math.round(topSwipe.distanceFromTopPct + topSwipe.distanceFromBottomPct), 100);
});

test('False-positive immunity: rejects keyboard clicks, voiced harmonic speech, and nonlinear tweeter IMD', () => {
  const sr = 48000;
  const core = new AcousticDspCore({ sampleRate: sr });
  const rng = createRng(999);
  const total = sr * 2;
  const buf = new Float32Array(total);
  const tx = new Float32Array(QUANTUM);

  for (let n = 0; n < total; n++) {
    if ((n & 127) === 0) core.fillTxBlock(tx, null);
    const txS = tx[n & 127];
    let x = randNormal(rng) * 0.0005 + txS * 0.35 + 0.08 * txS * txS;

    const t = n / sr;
    for (const clickT of [0.4, 0.7, 1.0]) {
      if (t >= clickT && t < clickT + 0.020) {
        x += randNormal(rng) * 0.06 * Math.exp(-(t - clickT) / 0.005);
      }
    }
    if (t >= 1.3 && t < 1.65) {
      for (let h = 1; h <= 14; h++) {
        x += (0.018 / Math.pow(h, 1.15)) * Math.sin(2 * Math.PI * 145 * h * t);
      }
    }
    buf[n] = x;
  }

  const events = core.processSamples(buf);
  const falseSwipes = events.filter((e) => e.type === 'swipe');
  assert.equal(falseSwipes.length, 0);
});

test('Multi-rate resilience across 16 kHz (Bluetooth HFP passive), 44.1 kHz, 96 kHz, and 192 kHz', () => {
  // 16 kHz Bluetooth HFP: ultrasonic TX must force-disable (zero audible tones!), passive swipes still work
  const core16 = new AcousticDspCore({ sampleRate: 16000, txEnabled: true });
  assert.equal(core16.canUseSonar, false);
  assert.equal(core16.txEnabled, false);
  const out16 = new Float32Array(128);
  core16.fillTxBlock(out16, null);
  assert.ok(out16.every((v) => v === 0), '16 kHz must never emit audible carrier tones');
  core16.setTxEnabled(true, 0.05);
  assert.equal(core16.txEnabled, false);

  const sw16 = simulateGrilleAudio({ core: core16, swipeDurationSec: 0.42, yStart: 0.88, yEnd: 0.10, seed: 301 })
    .filter((e) => e.type === 'swipe')
    .map((e) => e.swipe);
  assert.equal(sw16.length, 1);
  assert.equal(sw16[0].direction, 'up');

  // 96 kHz & 192 kHz decimated full-duplex sonar + tribology
  for (const sr of [44100, 96000, 192000]) {
    const coreUp = new AcousticDspCore({ sampleRate: sr });
    const up = simulateGrilleAudio({ core: coreUp, swipeDurationSec: 0.40, yStart: 0.88, yEnd: 0.12, seed: 401 })
      .filter((e) => e.type === 'swipe')
      .map((e) => e.swipe);
    assert.equal(up.length, 1, `Expected 1 UP swipe at ${sr} Hz`);
    assert.equal(up[0].direction, 'up');
    assert.ok(up[0].distanceFromTopPct < 42, `Expected top end <42% at ${sr} Hz, got ${up[0].distanceFromTopPct}%`);
  }
});

test('Calibration wizard works in passive mode, preserves inverted polarity on re-cal, and supports cancel', () => {
  // 1. Passive mode (`txEnabled: false`) on inverted bottom-mic hardware
  const passiveInv = new AcousticDspCore({ sampleRate: 48000, txEnabled: false, polarity: 1 });
  passiveInv.startCalibrationStep('up');
  simulateGrilleAudio({
    core: passiveInv,
    swipeDurationSec: 0.45,
    yStart: 0.10,
    yEnd: 0.90,
    sonarReflection: false,
    seed: 606
  });
  const res1 = passiveInv.finishCalibrationStep();
  assert.equal(res1.ok, true);
  assert.equal(res1.polarity, -1, 'Passive calibration must detect inverted mic polarity');

  // 2. Re-calibrating when ALREADY `polarity: -1` must stay `-1` (never flip back to +1!)
  passiveInv.startCalibrationStep('up');
  simulateGrilleAudio({
    core: passiveInv,
    swipeDurationSec: 0.45,
    yStart: 0.10,
    yEnd: 0.90,
    sonarReflection: true,
    seed: 607
  });
  const res2 = passiveInv.finishCalibrationStep();
  assert.equal(res2.ok, true);
  assert.equal(res2.polarity, -1, 'Re-calibrating inverted hardware must keep polarity = -1');

  // 3. `cancelCalibrationStep()` clears capture immediately
  passiveInv.startCalibrationStep('up');
  passiveInv.cancelCalibrationStep();
  assert.equal(passiveInv.calibrationCapture, null);
});

test('NaN/Infinity sample sanitization and >3.5s sustained fan/HVAC floor step-up recovery', () => {
  const sr = 48000;
  const core = new AcousticDspCore({ sampleRate: sr });

  // Inject warmup + NaN/Infinity burst
  const nanChunk = new Float32Array(1024);
  nanChunk[200] = Number.NaN;
  nanChunk[450] = Number.POSITIVE_INFINITY;
  nanChunk[700] = Number.NEGATIVE_INFINITY;
  core.processSamples(nanChunk);
  assert.ok(Number.isFinite(core.ambientFricDb));
  assert.ok(Number.isFinite(core.lpState));

  // Inject 4.2s sustained +12 dB broadband fan step-up -> must auto-abort & re-adapt floor
  const rng = createRng(1234);
  const fanSamples = new Float32Array(Math.floor(4.2 * sr));
  for (let i = 0; i < fanSamples.length; i++) {
    fanSamples[i] = randNormal(rng) * 0.003;
  }
  core.processSamples(fanSamples);
  assert.equal(core.activeStroke, null, 'Sustained fan noise >3.5s must not latch activeStroke');

  // Subsequent normal UP swipe must still register cleanly!
  const coreAfter = new AcousticDspCore({ sampleRate: sr });
  coreAfter.processSamples(nanChunk);
  const swipes = simulateGrilleAudio({
    core: coreAfter,
    swipeDurationSec: 0.38,
    yStart: 0.88,
    yEnd: 0.12,
    seed: 707
  })
    .filter((e) => e.type === 'swipe')
    .map((e) => e.swipe);
  assert.equal(swipes.length, 1);
  assert.equal(swipes[0].direction, 'up');
});

test('Controller error handling (`NotAllowedError`) and `sessionEpoch` mid-start abort isolation', async () => {
  const origNav = globalThis.navigator;
  const states = [];
  let gumCalls = 0;

  try {
    // 1. NotAllowedError must prompt ONCE and transition to state='error' (not stuck in 'requesting'!)
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            gumCalls++;
            const err = new Error('Permission denied');
            err.name = 'NotAllowedError';
            throw err;
          },
          enumerateDevices: async () => []
        }
      }
    });

    const ctrl = new LeftGrilleSensorController({
      onStateChange: (st) => states.push(st.state)
    });
    const ok = await ctrl.start();
    assert.equal(ok, false);
    assert.equal(gumCalls, 1, 'NotAllowedError must not trigger fallback retry prompt');
    assert.equal(ctrl.state, 'error', 'Controller must emit error state rather than sticking on requesting');
    assert.ok(states.includes('error'));

    // 2. Stale start() aborted by stop() must NOT clobber a newer start() session!
    let resolveGum1;
    let stoppedTracks1 = 0;
    let stoppedTracks2 = 0;
    let callIdx = 0;

    const origAudioCtx = globalThis.AudioContext;
    globalThis.AudioContext = class MockCtx {
      constructor() {
        this.sampleRate = 48000;
        this.state = 'running';
        this.destination = { maxChannelCount: 2 };
      }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createStereoPanner() {
        return { pan: { value: 0 }, connect() {}, disconnect() {} };
      }
      createScriptProcessor() {
        return { connect() {}, disconnect() {}, onaudioprocess: null };
      }
      async close() {
        this.state = 'closed';
      }
    };

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: () => {
            callIdx++;
            if (callIdx === 1) {
              return new Promise((res) => {
                resolveGum1 = () =>
                  res({
                    getTracks: () => [{ stop: () => stoppedTracks1++ }],
                    getAudioTracks: () => [{ label: 'Built-in Microphone', stop: () => stoppedTracks1++ }]
                  });
              });
            }
            return Promise.resolve({
              getTracks: () => [{ stop: () => stoppedTracks2++ }],
              getAudioTracks: () => [{ label: 'Built-in Microphone', stop: () => stoppedTracks2++ }]
            });
          },
          enumerateDevices: async () => []
        }
      }
    });

    const ctrl2 = new LeftGrilleSensorController();
    const p1 = ctrl2.start();
    await ctrl2.stop(); // User hits Back while start #1 is awaiting getUserMedia
    const p2 = await ctrl2.start(); // User re-opens and starts session #2
    assert.equal(p2, true);
    assert.equal(ctrl2.state, 'listening');

    // Now stale getUserMedia #1 finally resolves — must dispose ONLY stream #1, leaving session #2 alive!
    resolveGum1();
    await p1;
    assert.equal(stoppedTracks1, 1);
    assert.equal(stoppedTracks2, 0, 'Newer active session stream must remain open');
    assert.equal(ctrl2.state, 'listening');
    assert.ok(ctrl2.audioCtx !== null);

    await ctrl2.stop({ immediate: true });
    globalThis.AudioContext = origAudioCtx;
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: origNav
    });
  }
});

test('UI View Transition re-entrancy, popstate+hashchange deduplication, and mid-transition Back safety', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const uiCode = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');

  // Minimal headless DOM environment with asynchronous startViewTransition callbacks
  function makeMockEl(tag) {
    const listeners = {};
    const attrs = {};
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '',
      id: '',
      hidden: false,
      disabled: false,
      tabIndex: -1,
      textContent: '',
      dataset: {},
      style: { viewTransitionName: '' },
      children: [],
      firstChild: null,
      appendChild(child) {
        this.children.push(child);
        this.firstChild = this.children[0] || null;
        return child;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        this.firstChild = this.children[0] || null;
        return child;
      },
      insertAdjacentElement(_pos, sibling) {
        sibling._inserted = true;
        doc._secondary = sibling;
        return sibling;
      },
      setAttribute(k, v) {
        attrs[k] = String(v);
      },
      getAttribute(k) {
        return attrs[k];
      },
      addEventListener(ev, fn) {
        (listeners[ev] = listeners[ev] || []).push(fn);
      },
      dispatch(ev, payload = {}) {
        (listeners[ev] || []).forEach((fn) => fn(Object.assign({ preventDefault() {} }, payload)));
      },
      focus() {
        doc.activeElement = this;
      },
      getBoundingClientRect() {
        return { top: 0, left: 0, width: 220, height: 80 };
      },
      getContext() {
        return {
          save() {},
          restore() {},
          scale() {},
          clearRect() {},
          beginPath() {},
          moveTo() {},
          lineTo() {},
          stroke() {},
          fill() {},
          closePath() {},
          fillRect() {},
          setLineDash() {}
        };
      }
    };
    return node;
  }

  const mainGrid = makeMockEl('main');
  mainGrid.className = 'grid';
  const portalCell = makeMockEl('section');
  portalCell.id = 'cell-left-grille';
  portalCell.className = 'cell cell--left-grille';

  const pendingVtCallbacks = [];
  let vtCount = 0;

  const docListeners = {};
  const winListeners = {};
  const loc = { hash: '', pathname: '/', search: '', protocol: 'http:' };

  const doc = {
    readyState: 'complete',
    hidden: false,
    activeElement: null,
    _secondary: null,
    createElement: makeMockEl,
    createElementNS: (_ns, tag) => makeMockEl(tag),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    querySelector: (sel) => (sel === 'main.grid' ? mainGrid : null),
    getElementById: (id) => (id === 'cell-left-grille' ? portalCell : null),
    addEventListener(ev, fn) {
      (docListeners[ev] = docListeners[ev] || []).push(fn);
    },
    startViewTransition(cb) {
      vtCount++;
      let resolveFinished;
      const finished = new Promise((r) => {
        resolveFinished = r;
      });
      pendingVtCallbacks.push(() => {
        cb();
        resolveFinished();
      });
      return { finished };
    }
  };

  const win = {
    document: doc,
    location: loc,
    devicePixelRatio: 2,
    performance: { now: () => Date.now() },
    LeftGrilleAcousticEngine: require('./acoustic-engine.js'),
    LeftGrilleController: require('./acoustic-controller.js'),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    matchMedia: () => ({ matches: false }),
    history: {
      pushState(_st, _t, url) {
        loc.hash = url;
      },
      replaceState(_st, _t, _url) {
        loc.hash = '';
      },
      back() {
        loc.hash = '';
        // Simulate browser firing BOTH popstate AND hashchange synchronously before VT callbacks flush!
        (winListeners.popstate || []).forEach((fn) => fn());
        (winListeners.hashchange || []).forEach((fn) => fn());
      }
    },
    addEventListener(ev, fn) {
      (winListeners[ev] = winListeners[ev] || []).push(fn);
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  win.window = win;
  win.globalThis = win;

  vm.runInNewContext(uiCode, win);

  const portalBtn = portalCell.children[0];
  assert.ok(portalBtn, 'Portal button should mount inside #cell-left-grille');
  assert.ok(doc._secondary, 'Secondary page should mount adjacent to main.grid');

  // 1. Rapid double-tap on portalBtn must start ONLY 1 View Transition!
  portalBtn.dispatch('click');
  portalBtn.dispatch('click');
  assert.equal(vtCount, 1, 'Rapid double-tap must not trigger duplicate View Transitions');

  // Flush open transition
  while (pendingVtCallbacks.length) pendingVtCallbacks.shift()();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(mainGrid.hidden, true);
  assert.equal(doc._secondary.hidden, false);
  assert.equal(portalCell.style.viewTransitionName, '');

  // 2. Normal Back click firing popstate + hashchange must start ONLY 1 close View Transition!
  const backBtn = doc._secondary.children[0].children[0].children[0];
  vtCount = 0;
  backBtn.dispatch('click');
  assert.equal(vtCount, 1, 'popstate + hashchange must deduplicate into 1 close transition');
  while (pendingVtCallbacks.length) pendingVtCallbacks.shift()();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(mainGrid.hidden, false);
  assert.equal(doc._secondary.hidden, true);
  assert.equal(portalCell.style.viewTransitionName, '');
  assert.equal(doc._secondary.children[1].style.viewTransitionName, '');

  // 3. Open -> immediate Back BEFORE open VT callback runs must reconcile to CLOSED (never stuck open)!
  portalBtn.dispatch('click');
  assert.equal(pendingVtCallbacks.length, 1);
  backBtn.dispatch('click'); // Immediate Back mid-flight!
  while (pendingVtCallbacks.length) pendingVtCallbacks.shift()();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(loc.hash, '');
  assert.equal(mainGrid.hidden, false, 'Immediate Back before VT callback must end on mainGrid visible');
  assert.equal(doc._secondary.hidden, true, 'Immediate Back before VT callback must end on secondary hidden');
  assert.equal(portalCell.style.viewTransitionName, '', 'No leaked viewTransitionName on portalCell');
  assert.equal(doc._secondary.children[1].style.viewTransitionName, '', 'No leaked viewTransitionName on secondaryGrid');
});

test('Controller suspends capture while hidden (resumes only what it suspended) and stops on an ended mic track', async () => {
  const origNav = globalThis.navigator;
  const origAudioCtx = globalThis.AudioContext;
  const calls = [];
  const ctxs = [];
  const tracks = [];
  try {
    globalThis.AudioContext = class MockCtx {
      constructor() {
        this.sampleRate = 48000;
        this.state = 'running';
        this.destination = { maxChannelCount: 2 };
        ctxs.push(this);
      }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} };
      }
      createStereoPanner() {
        return { pan: { value: 0 }, connect() {}, disconnect() {} };
      }
      createScriptProcessor() {
        return { connect() {}, disconnect() {}, onaudioprocess: null };
      }
      async suspend() {
        calls.push('suspend');
        this.state = 'suspended';
      }
      async resume() {
        calls.push('resume');
        this.state = 'running';
      }
      async close() {
        this.state = 'closed';
      }
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            const listeners = {};
            const track = {
              label: 'Built-in Microphone',
              stopped: false,
              stop() {
                this.stopped = true;
              },
              addEventListener(ev, fn) {
                listeners[ev] = fn;
              },
              fire(ev) {
                if (listeners[ev]) listeners[ev]();
              }
            };
            tracks.push(track);
            return { getTracks: () => [track], getAudioTracks: () => [track] };
          },
          enumerateDevices: async () => []
        }
      }
    });

    const states = [];
    const ctrl = new LeftGrilleSensorController({ onStateChange: (st) => states.push(st) });
    assert.equal(await ctrl.start(), true);
    ctrl.setHiddenMuted(true);
    assert.deepEqual(calls, ['suspend']);
    ctrl.setHiddenMuted(false);
    assert.deepEqual(calls, ['suspend', 'resume']);

    calls.length = 0;
    ctxs[0].state = 'suspended'; // suspended by someone else
    ctrl.setHiddenMuted(true);
    ctrl.setHiddenMuted(false);
    assert.deepEqual(calls, [], 'Must not resume a context it did not suspend');
    ctxs[0].state = 'running';

    tracks[0].fire('ended');
    assert.equal(ctrl.state, 'error');
    assert.match(states[states.length - 1].error, /disconnected/i);
    assert.equal(tracks[0].stopped, true);
    assert.equal(ctxs[0].state, 'closed');
  } finally {
    globalThis.AudioContext = origAudioCtx;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: origNav });
  }
});
