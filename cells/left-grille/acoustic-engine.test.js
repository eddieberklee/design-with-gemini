const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  AcousticDspCore,
  QUANTUM,
  SPEED_OF_SOUND_CMS,
  OBLIQUE_GEOMETRY_FACTOR,
  CALIBRATION_PROTOCOL,
  buildCarrierMultiples,
  createWorkletSource,
  fitEmpiricalCalibration,
  predictRbfY
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

/**
 * Physically realistic Mac16,5 left speaker grille simulator with the non-monotonic 18% MEMS
 * through-hole top-fold: `y = 0.18` (beside ~ / Tab) is significantly louder and produces deeper
 * ultrasonic occlusion & sub-bass pneumatic energy than BOTH `y = 0.02` (Esc) AND `y = 0.96` (Fn).
 */
function simulateMac165FoldAudio({
  core,
  preIdleSec = 0.14,
  activeSec = 0.45,
  postIdleSec = 0.12,
  yStart = 0.04,
  yEnd = 0.96,
  isNegativeClicks = false,
  lowBinThudGain = 0.03,
  seed = 4242
}) {
  const sr = core.sampleRate;
  const rng = createRng(seed);
  const totalSamples = Math.floor((preIdleSec + activeSec + postIdleSec) * sr);
  const txBuf = new Float32Array(QUANTUM);
  const rxAll = new Float32Array(totalSamples);

  let lpSub = 0;
  let lpLo = 0;
  let lpMid = 0;
  let lpHi1 = 0;
  let lpHi2 = 0;
  const aSub = 1 - Math.exp((-2 * Math.PI * 140) / sr);
  const aLo = 1 - Math.exp((-2 * Math.PI * 1100) / sr);
  const aMid = 1 - Math.exp((-2 * Math.PI * 3200) / sr);
  const aHi1 = 1 - Math.exp((-2 * Math.PI * 6200) / sr);
  const aHi2 = 1 - Math.exp((-2 * Math.PI * 10200) / sr);

  const s0 = Math.floor(preIdleSec * sr);
  const s1 = s0 + Math.floor(activeSec * sr);
  const crestPhases = core.carrierMultiples.map((_, k) => (Math.PI * k * k) / core.numCarriers);

  for (let n = 0; n < totalSamples; n++) {
    if ((n & 127) === 0) core.fillTxBlock(txBuf, null);
    const txS = txBuf[n & 127];
    let x = randNormal(rng) * 0.0005;

    if (isNegativeClicks) {
      x += txS * 0.35;
      const t = n / sr;
      for (const clickT of [preIdleSec + 0.08, preIdleSec + 0.24, preIdleSec + 0.38]) {
        if (t >= clickT && t < clickT + 0.028) {
          x += randNormal(rng) * 0.045 * Math.exp(-(t - clickT) / 0.008);
        }
      }
      rxAll[n] = x;
      continue;
    }

    const inAct = n >= s0 && n < s1;
    const prog = inAct ? (n - s0) / Math.max(1, s1 - s0) : n < s0 ? 0 : 1;
    let env = 0;
    if (inAct) {
      const edge = 0.09;
      if (prog < edge) env = 0.5 * (1 - Math.cos((Math.PI * prog) / edge));
      else if (prog > 1 - edge) env = 0.5 * (1 - Math.cos((Math.PI * (1 - prog)) / edge));
      else env = 1.0;
    }

    const y = yStart + (yEnd - yStart) * prog;
    // True Mac16,5 3-MEMS port sits at y = 0.18!
    const distFromMic = Math.abs(y - 0.18);
    const micPortProx = Math.exp(-Math.pow(distFromMic / 0.13, 2));
    // Distinct spatial spectral color across top corner (0.02), mic fold (0.18), mid (0.50), low (0.75), btm (0.96)
    const topRimMode = Math.exp(-Math.pow((y - 0.02) / 0.09, 2));
    const midPlateMode = Math.exp(-Math.pow((y - 0.50) / 0.18, 2));
    const lowPlateMode = Math.exp(-Math.pow((y - 0.75) / 0.16, 2));
    const btmPalmMode = Math.exp(-Math.pow((y - 0.96) / 0.15, 2));

    // Carrier occlusion peaks sharply at y = 0.18 (NOT at y = 0.02!)
    x += txS * 0.35 * (1.0 - 0.70 * micPortProx * env);

    // Subtle oblique sonar reflection referenced to top-edge speaker-to-mic path
    if (inAct && core.txEnabled && core.numCarriers > 0) {
      const distCm = Math.max(0.8, y * core.grilleLengthCm);
      const reflAmp = 0.0028 * env;
      for (let k = 0; k < core.numCarriers; k++) {
        const f = core.carrierFreqs[k];
        const phaseDelay =
          (2 * Math.PI * f * (OBLIQUE_GEOMETRY_FACTOR * distCm)) / SPEED_OF_SOUND_CMS;
        const thetaTx =
          (2 * Math.PI * core.carrierMultiples[k] * (n % core.txPeriod)) / core.txPeriod +
          crestPhases[k];
        x += (reflAmp / core.numCarriers) * Math.cos(thetaTx - phaseDelay);
      }
    }

    if (inAct) {
      const w = randNormal(rng);
      lpSub += aSub * (w - lpSub);
      lpLo += aLo * (w - lpLo);
      lpMid += aMid * (w - lpMid);
      lpHi1 += aHi1 * (w - lpHi1);
      lpHi2 += aHi2 * (w - lpHi2);

      const bandLo = lpLo - lpSub;
      const bandMid = lpMid - lpLo;
      const bandHi1 = lpHi1 - lpMid;
      const bandHi2 = lpHi2 - lpHi1;
      const bandAir = w - lpHi2;

      // Peak overall loudness at y = 0.18 (`micPortProx`), clearly louder than y = 0.02 AND y = 0.96!
      const gSub = 0.004 + 0.048 * micPortProx + 0.006 * topRimMode + 0.012 * btmPalmMode;
      const gLo = 0.005 + 0.022 * micPortProx + 0.009 * topRimMode + 0.014 * lowPlateMode + 0.018 * btmPalmMode;
      const gMid = 0.004 + 0.024 * micPortProx + 0.021 * topRimMode + 0.016 * midPlateMode + 0.005 * lowPlateMode;
      const gHi1 = 0.003 + 0.028 * micPortProx + 0.018 * topRimMode + 0.008 * midPlateMode + 0.003 * lowPlateMode;
      const gHi2 = 0.0015 + 0.032 * micPortProx + 0.007 * topRimMode + 0.0035 * midPlateMode;
      const gAir = 0.001 + 0.034 * micPortProx + 0.011 * topRimMode + 0.002 * midPlateMode;

      const tSec = n / sr;
      // Add fleshy finger-pad <750 Hz pneumatic thud especially near the 18% MEMS ports
      const thud =
        lowBinThudGain *
        (0.3 + 0.7 * micPortProx) *
        (Math.sin(2 * Math.PI * 375 * tSec) + 0.45 * Math.sin(2 * Math.PI * 750 * tSec));

      x +=
        env *
        (gSub * lpSub +
          gLo * bandLo +
          gMid * bandMid +
          gHi1 * bandHi1 +
          gHi2 * bandHi2 +
          gAir * bandAir +
          thud);
    }

    rxAll[n] = x;
  }

  return core.processSamples(rxAll);
}

test('Root-cause fix: huge 375 Hz / 750 Hz low-bin pneumatic finger-rub energy never self-vetoes as voice while speech stays rejected', () => {
  const sr = 48000;
  const core = new AcousticDspCore({ sampleRate: sr });
  const rng = createRng(5551);
  const preSec = 0.22;
  const durSec = 0.42;
  const postSec = 0.16;
  const total = Math.floor((preSec + durSec + postSec) * sr);
  const tx = new Float32Array(QUANTUM);
  const rx = new Float32Array(total);

  const s0 = Math.floor(preSec * sr);
  const s1 = s0 + Math.floor(durSec * sr);
  let lpMid = 0;
  let lpHpRef = 0;
  const aMid = 1 - Math.exp((-2 * Math.PI * 1900) / sr);
  const aHp = 1 - Math.exp((-2 * Math.PI * 5500) / sr);

  for (let n = 0; n < total; n++) {
    if ((n & 127) === 0) core.fillTxBlock(tx, null);
    let x = randNormal(rng) * 0.0005 + tx[n & 127] * 0.35;
    if (n >= s0 && n < s1) {
      const prog = (n - s0) / Math.max(1, s1 - s0);
      const y = 0.85 - 0.72 * prog; // UP swipe
      const topProx = clamp01(1 - y);
      const w = randNormal(rng);
      lpMid += aMid * (w - lpMid);
      lpHpRef += aHp * (w - lpHpRef);
      const hp = (w - lpHpRef) * 2.0;
      const t = n / sr;
      // Huge 375 Hz + 750 Hz (bins 1..2) fleshy finger-pad pneumatic energy that previously inflated tonalCrest > 25!
      const massiveLowBinThud =
        0.11 * Math.sin(2 * Math.PI * 375 * t) + 0.065 * Math.sin(2 * Math.PI * 750 * t);
      x +=
        (0.0045 + 0.014 * Math.pow(topProx, 1.3)) * lpMid +
        (0.001 + 0.024 * Math.pow(topProx, 2.2)) * hp +
        massiveLowBinThud;
    }
    rx[n] = x;
  }

  const events = core.processSamples(rx);
  const voiceVetosDuringSwipe = events.filter(
    (e) => e.timeSec >= preSec + 0.03 && e.timeSec <= preSec + durSec && e.vetoReason === 'voice'
  );
  const swipes = events.filter((e) => e.type === 'swipe').map((e) => e.swipe);
  assert.equal(voiceVetosDuringSwipe.length, 0, 'Low-bin 375/750 Hz finger thud must not trigger voice veto');
  assert.equal(swipes.length, 1, 'Fleshy finger swipe with huge 375 Hz energy must still be detected');
  assert.equal(swipes[0].direction, 'up');

  // Verify genuine voiced harmonic speech (145 Hz harmonics up to 3.2 kHz, weak 6-15 kHz shear) is STILL vetoed
  const speechCore = new AcousticDspCore({ sampleRate: sr });
  const speechBuf = new Float32Array(sr * 1.4);
  const speechRng = createRng(5552);
  for (let n = 0; n < speechBuf.length; n++) {
    if ((n & 127) === 0) speechCore.fillTxBlock(tx, null);
    let x = randNormal(speechRng) * 0.0005 + tx[n & 127] * 0.35;
    const t = n / sr;
    if (t >= 0.35 && t < 0.85) {
      for (let h = 1; h <= 22; h++) {
        x += (0.02 / Math.pow(h, 1.15)) * Math.sin(2 * Math.PI * 145 * h * t);
      }
    }
    speechBuf[n] = x;
  }
  const speechEvents = speechCore.processSamples(speechBuf);
  assert.equal(
    speechEvents.filter((e) => e.type === 'swipe').length,
    0,
    'Harmonic speech up to 3.2 kHz must remain rejected'
  );
  assert.ok(
    speechEvents.some((e) => e.vetoReason === 'voice'),
    'Harmonic speech should emit voice veto diagnostics'
  );
});

test('14-step CALIBRATION_PROTOCOL + fitEmpiricalCalibration resolves non-monotonic Mac16,5 18% MEMS top-fold with 100% LOO accuracy', () => {
  assert.equal(CALIBRATION_PROTOCOL.length, 14);
  assert.equal(CALIBRATION_PROTOCOL[0].id, 'zone-0');
  assert.equal(CALIBRATION_PROTOCOL[1].id, 'zone-20');
  assert.equal(CALIBRATION_PROTOCOL[1].targetY, 0.18);
  assert.equal(CALIBRATION_PROTOCOL[13].id, 'veto-keys');
  assert.equal(CALIBRATION_PROTOCOL[13].kind, 'negative');

  const core = new AcousticDspCore({ sampleRate: 48000 });
  // Warm up ambient floors before calibration recording
  const warmRng = createRng(9001);
  const warmBuf = new Float32Array(Math.floor(0.25 * 48000));
  const txBuf = new Float32Array(QUANTUM);
  for (let n = 0; n < warmBuf.length; n++) {
    if ((n & 127) === 0) core.fillTxBlock(txBuf, null);
    warmBuf[n] = randNormal(warmRng) * 0.0005 + txBuf[n & 127] * 0.35;
  }
  core.processSamples(warmBuf);

  const recordedEvents = [];
  for (let i = 0; i < CALIBRATION_PROTOCOL.length; i++) {
    const step = CALIBRATION_PROTOCOL[i];
    core.beginRecordEvent(step);
    if (step.kind === 'zone') {
      simulateMac165FoldAudio({
        core,
        preIdleSec: 0.08,
        activeSec: 0.35,
        postIdleSec: 0.08,
        yStart: step.targetY,
        yEnd: step.targetY,
        seed: 7100 + i
      });
    } else if (step.kind === 'swipe') {
      const isFast = step.id.includes('fast');
      const isHalf = step.id.startsWith('top-') || step.id.startsWith('btm-');
      const dur = isFast ? 0.20 : isHalf ? 0.34 : 0.65;
      simulateMac165FoldAudio({
        core,
        preIdleSec: 0.08,
        activeSec: dur,
        postIdleSec: 0.08,
        yStart: step.startY,
        yEnd: step.endY,
        seed: 7200 + i
      });
    } else {
      simulateMac165FoldAudio({
        core,
        preIdleSec: 0.08,
        activeSec: 0.48,
        postIdleSec: 0.08,
        isNegativeClicks: true,
        seed: 7300 + i
      });
    }

    const res = core.endRecordEvent();
    assert.equal(res.ok, true, `Step ${step.id} should record ok (activeFrames=${res.activeFrameCount})`);
    assert.ok(res.eventRecord.frames.length > 10);
    const sampleFrame = res.eventRecord.frames[Math.floor(res.eventRecord.frames.length / 2)];
    assert.equal(sampleFrame.bandsDb.length, 8, 'Each recorded frame must include 8 log-PSD bands');
    recordedEvents.push(res.eventRecord);
  }

  // Confirm the test physics genuinely exhibit the Mac16,5 18% non-monotonic loudness fold!
  const z0 = recordedEvents.find((e) => e.stepId === 'zone-0');
  const z20 = recordedEvents.find((e) => e.stepId === 'zone-20');
  const z100 = recordedEvents.find((e) => e.stepId === 'zone-100');
  assert.ok(
    z20.peakSnrDb > z0.peakSnrDb + 1.5 && z20.peakSnrDb > z100.peakSnrDb + 3.0,
    `Expected zone-20 (${z20.peakSnrDb} dB) louder than zone-0 (${z0.peakSnrDb} dB) and zone-100 (${z100.peakSnrDb} dB)`
  );

  // Fit Empirical RBF + Shrinkage Fisher LDA calibration
  const fit = fitEmpiricalCalibration(recordedEvents);
  assert.equal(fit.ok, true);
  assert.equal(fit.zoneCount, 5);
  assert.equal(fit.swipeCount, 8);
  assert.equal(fit.looAccuracyPct, 100, `Expected 100% honest LOO accuracy, got ${fit.looAccuracyPct}%`);
  assert.ok(fit.dPrime > 2.0, `Expected strong LOO dPrime > 2.0, got ${fit.dPrime}`);
  assert.equal(fit.model.rbf.prototypes.length, 5);
  assert.ok(fit.model.minStrokeDurationSec >= 0.068 && fit.model.minStrokeDurationSec <= 0.14);

  // Verify RBF unfolds y=0.02 < y=0.18 < y=0.50 < y=0.75 < y=0.96 monotonically in y_hat despite non-monotonic loudness
  const medianZoneRbfY = (stepId) => {
    const ev = recordedEvents.find((e) => e.stepId === stepId);
    const act = ev.frames.filter((f) => f.active);
    const core = act.slice(Math.floor(act.length * 0.25), Math.ceil(act.length * 0.75));
    const ys = core.map((f) => predictRbfY(f, fit.model.rbf).y).sort((a, b) => a - b);
    return ys[ys.length >> 1];
  };
  const rbfAt0 = medianZoneRbfY('zone-0');
  const rbfAt20 = medianZoneRbfY('zone-20');
  const rbfAt50 = medianZoneRbfY('zone-50');
  const rbfAt75 = medianZoneRbfY('zone-75');
  const rbfAt100 = medianZoneRbfY('zone-100');
  assert.ok(
    rbfAt0 < rbfAt20 && rbfAt20 < rbfAt50 && rbfAt50 < rbfAt75 && rbfAt75 < rbfAt100,
    `RBF must preserve spatial order across 18% fold: ${rbfAt0.toFixed(2)} < ${rbfAt20.toFixed(2)} < ${rbfAt50.toFixed(2)} < ${rbfAt75.toFixed(2)} < ${rbfAt100.toFixed(2)}`
  );

  // Apply fitted model to live AcousticDspCore and test unseen swipes including top-down vs top-up across the 18% fold!
  const liveTests = [
    { label: 'unseen top-down (0.04->0.50)', yStart: 0.04, yEnd: 0.50, dur: 0.34, expectedDir: 'down', seed: 8101 },
    { label: 'unseen top-up (0.50->0.04)', yStart: 0.50, yEnd: 0.04, dur: 0.34, expectedDir: 'up', seed: 8102 },
    { label: 'unseen full-down (0.04->0.96)', yStart: 0.04, yEnd: 0.96, dur: 0.46, expectedDir: 'down', seed: 8103 },
    { label: 'unseen full-up (0.96->0.04)', yStart: 0.96, yEnd: 0.04, dur: 0.46, expectedDir: 'up', seed: 8104 }
  ];

  for (const tc of liveTests) {
    const liveCore = new AcousticDspCore({ sampleRate: 48000, empiricalModel: fit.model });
    const evs = simulateMac165FoldAudio({
      core: liveCore,
      preIdleSec: 0.22,
      activeSec: tc.dur,
      postIdleSec: 0.16,
      yStart: tc.yStart,
      yEnd: tc.yEnd,
      seed: tc.seed
    });
    const swipes = evs.filter((e) => e.type === 'swipe').map((e) => e.swipe);
    assert.equal(swipes.length, 1, `Expected 1 live swipe for ${tc.label}, got ${swipes.length}`);
    assert.equal(swipes[0].direction, tc.expectedDir, `Wrong live direction for ${tc.label}`);
    assert.equal(swipes[0].sensingMode, 'calibrated');
  }

  // Verify resetCalibration() clears empiricalModel cleanly
  const resetCore = new AcousticDspCore({ sampleRate: 48000, empiricalModel: fit.model });
  assert.ok(resetCore.empiricalModel !== null);
  resetCore.resetCalibration();
  assert.equal(resetCore.empiricalModel, null);
});

test('Worklet beginRec / endRec / setEmpiricalModel / resetCalibration round-trip in isolated vm.runInNewContext', () => {
  const src = createWorkletSource();
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
    registerProcessor: (_name, cls) => {
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
  const proc = new ProcessorCls({ processorOptions: { txEnabled: true, txGain: 0.036, polarity: 1 } });
  const rng = createRng(31415);
  const inCh = new Float32Array(128);
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);

  // 1. Warm up ambient floors inside worklet
  for (let q = 0; q < 24; q++) {
    for (let i = 0; i < 128; i++) inCh[i] = randNormal(rng) * 0.0005;
    proc.process([[inCh]], [[outL, outR]]);
  }

  // 2. Begin recording zone-20, inject broadband rub, and endRec with reqId
  proc.port.onmessage({ data: { type: 'beginRec', stepMeta: CALIBRATION_PROTOCOL[1] } });
  for (let q = 0; q < 40; q++) {
    for (let i = 0; i < 128; i++) inCh[i] = randNormal(rng) * 0.025;
    proc.process([[inCh]], [[outL, outR]]);
  }
  proc.port.onmessage({ data: { type: 'endRec', reqId: 77 } });

  const recMsg = posted.find((m) => m.type === 'recEventResult' && m.reqId === 77);
  assert.ok(recMsg, 'Expected recEventResult posted back with matching reqId');
  assert.equal(recMsg.result.ok, true);
  assert.equal(recMsg.result.eventRecord.stepId, 'zone-20');
  assert.ok(recMsg.result.activeFrameCount >= 10);
  assert.equal(recMsg.result.eventRecord.frames[0].bandsDb.length, 8);

  // 3. Apply and clear empiricalModel via port messages
  const mockModel = {
    version: 2,
    polarity: 1,
    rbf: {
      prototypes: [
        { anchorY: 0.02, vector: new Array(11).fill(1) },
        { anchorY: 0.96, vector: new Array(11).fill(5) }
      ],
      scale: new Array(11).fill(2),
      temp: 0.45
    },
    lda: {
      weights: [1, 0, 0, 0, 0, 0, 0, 0],
      bias: 0,
      featMean: new Array(8).fill(0),
      featStd: new Array(8).fill(1),
      lambda: 0.35
    },
    speedScale: 1.1,
    minStrokeDurationSec: 0.075
  };
  proc.port.onmessage({ data: { type: 'setEmpiricalModel', model: mockModel } });
  assert.ok(proc.core.empiricalModel !== null);
  assert.equal(proc.core.empiricalModel.speedScale, 1.1);

  proc.port.onmessage({ data: { type: 'resetCalibration' } });
  assert.equal(proc.core.empiricalModel, null);
});

test('Controller calibration recording, fitRecordedCalibration, localStorage v2/v1 fallback, trackSettings, and collector POST', async () => {
  const origNav = globalThis.navigator;
  const origAudioCtx = globalThis.AudioContext;
  const origFetch = globalThis.fetch;
  const origLS = globalThis.localStorage;

  const store = new Map();
  const mockLocalStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  const fetchCalls = [];

  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: mockLocalStorage
    });

    globalThis.fetch = async (url, opts = {}) => {
      fetchCalls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
      if (String(url).endsWith('/health')) {
        return { ok: true, json: async () => ({ ok: true, savedSessions: 1 }) };
      }
      if (String(url).endsWith('/record')) {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: false };
    };

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
          getUserMedia: async () => ({
            getTracks: () => [{ stop() {} }],
            getAudioTracks: () => [
              {
                label: 'MacBook Pro Microphone',
                stop() {},
                getSettings: () => ({
                  sampleRate: 48000,
                  channelCount: 1,
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false
                })
              }
            ]
          }),
          enumerateDevices: async () => []
        }
      }
    });

    // Verify v1 localStorage fallback before v2 exists
    mockLocalStorage.setItem(
      'dwg.leftGrilleCalibration.v1',
      JSON.stringify({ polarity: -1, calibration: { specTopDb: 4.1, specBottomDb: -7.5 } })
    );
    const v1Ctrl = new LeftGrilleSensorController();
    assert.equal(v1Ctrl.polarity, -1);
    assert.equal(v1Ctrl.calibration.specTopDb, 4.1);
    assert.equal(v1Ctrl.empiricalModel, null);

    // Start controller & verify trackSettings + getCalibrationProtocol + probeCollector
    const ctrl = new LeftGrilleSensorController();
    assert.equal(ctrl.getCalibrationProtocol().length, 14);
    const started = await ctrl.start();
    assert.equal(started, true);
    assert.equal(ctrl.trackSettings.echoCancellation, false);
    assert.equal(ctrl.trackSettings.sampleRate, 48000);

    const online = await ctrl.probeCollector();
    assert.equal(online, true);
    assert.ok(fetchCalls.some((c) => c.url === 'http://127.0.0.1:8792/health'));

    // Warm up fallbackCore floors
    const warmRng = createRng(4444);
    const warmBuf = new Float32Array(Math.floor(0.2 * 48000));
    const txBuf = new Float32Array(QUANTUM);
    for (let n = 0; n < warmBuf.length; n++) {
      if ((n & 127) === 0) ctrl.fallbackCore.fillTxBlock(txBuf, null);
      warmBuf[n] = randNormal(warmRng) * 0.0005 + txBuf[n & 127] * 0.35;
    }
    ctrl.fallbackCore.processSamples(warmBuf);

    // Record 2 zones + 4 swipes (2 UP + 2 DOWN) and test duplicate stepId replacement
    const subset = [
      CALIBRATION_PROTOCOL[0], // zone-0
      CALIBRATION_PROTOCOL[1], // zone-20
      CALIBRATION_PROTOCOL[5], // down-slow
      CALIBRATION_PROTOCOL[6], // down-fast
      CALIBRATION_PROTOCOL[7], // up-slow
      CALIBRATION_PROTOCOL[8], // up-fast
      CALIBRATION_PROTOCOL[8] // re-record up-fast -> should overwrite, not duplicate
    ];

    for (let i = 0; i < subset.length; i++) {
      const step = subset[i];
      ctrl.beginCalibrationRecord(step);
      simulateMac165FoldAudio({
        core: ctrl.fallbackCore,
        preIdleSec: 0.06,
        activeSec: step.kind === 'zone' ? 0.3 : 0.35,
        postIdleSec: 0.06,
        yStart: step.kind === 'zone' ? step.targetY : step.startY,
        yEnd: step.kind === 'zone' ? step.targetY : step.endY,
        seed: 9500 + i
      });
      const recRes = await ctrl.completeCalibrationRecord();
      assert.equal(recRes.ok, true);
      assert.equal(recRes.collectorSaved, true);
      assert.ok(recRes.activeFrameCount >= 4);
    }
    assert.equal(ctrl.recordedEvents.length, 6, 'Re-recording same stepId must replace in-place');

    const fitRes = await ctrl.fitRecordedCalibration();
    assert.equal(fitRes.ok, true);
    assert.equal(fitRes.swipeCount, 4);
    assert.equal(fitRes.zoneCount, 2);
    assert.equal(fitRes.looAccuracyPct, 100);
    assert.equal(fitRes.collectorSaved, true);
    assert.ok(ctrl.fallbackCore.empiricalModel !== null);

    // Confirm POST /record was called for both event and fit
    assert.ok(fetchCalls.some((c) => c.url === 'http://127.0.0.1:8792/record' && c.body.type === 'event'));
    assert.ok(fetchCalls.some((c) => c.url === 'http://127.0.0.1:8792/record' && c.body.type === 'fit'));

    // Verify v2 localStorage persistence restores empiricalModel in a fresh controller
    assert.ok(mockLocalStorage.getItem('dwg.leftGrilleCalibration.v2'));
    const restoredCtrl = new LeftGrilleSensorController();
    assert.ok(restoredCtrl.empiricalModel !== null);
    assert.equal(restoredCtrl.calSummary.looAccuracyPct, 100);

    // Verify exportCalibrationBundle JSON & clearRecordedCalibration
    const bundle = JSON.parse(ctrl.exportCalibrationBundle());
    assert.equal(bundle.version, 2);
    assert.equal(bundle.events.length, 6);
    assert.ok(bundle.empiricalModel && bundle.trackSettings.sampleRate === 48000);

    ctrl.clearRecordedCalibration();
    assert.equal(ctrl.recordedEvents.length, 0);

    await ctrl.stop({ immediate: true });
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: origNav });
    globalThis.AudioContext = origAudioCtx;
    globalThis.fetch = origFetch;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: origLS });
  }
});
