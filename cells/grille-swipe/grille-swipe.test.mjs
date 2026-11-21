import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Lab = require('./grille-swipe.js');

function runBufferThroughEngine(buf, sr, sonarOn) {
  const engine = Lab.createStreamEngine(sr);
  engine.setSonarTarget(sonarOn, 0.13, false);
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);
  const strokes = [];
  let leftEnergy = 0;
  let rightEnergy = 0;

  for (let off = 0; off < buf.length; off += 128) {
    const slice = buf.subarray(off, Math.min(buf.length, off + 128));
    outL.fill(99);
    outR.fill(0);
    engine.processQuantum(slice, outL, outR, {
      operatingGain: 0.13,
      onStroke: (feat) => strokes.push(feat)
    });
    for (let i = 0; i < slice.length; i++) {
      leftEnergy += outL[i] * outL[i];
      rightEnergy += outR[i] * outR[i];
    }
  }
  return { strokes, leftEnergy, rightEnergy, engine };
}

// --- Lightweight DOM + WebAudio + MediaDevices Harness for Race & UI Tests ---
function createBrowserEnv(opts = {}) {
  const listeners = new Map();
  const addEv = (map, type, fn) => {
    if (!map.has(type)) map.set(type, new Set());
    map.get(type).add(fn);
  };
  const remEv = (map, type, fn) => {
    if (map.has(type)) map.get(type).delete(fn);
  };
  const fireEv = (map, type, ev = {}) => {
    if (!map.has(type)) return;
    for (const fn of Array.from(map.get(type))) fn(ev);
  };

  function makeEl(tag, cls = '', attrs = {}) {
    const elListeners = new Map();
    const classSet = new Set(cls ? cls.split(/\s+/).filter(Boolean) : []);
    const el = {
      tagName: tag.toUpperCase(),
      className: cls,
      dataset: {},
      attributes: { ...attrs },
      children: [],
      parentElement: null,
      hidden: !!attrs.hidden,
      value: attrs.value || '',
      textContent: '',
      innerHTML: '',
      title: attrs.title || '',
      clientWidth: opts.cellWidth ?? 520,
      clientHeight: opts.cellHeight ?? 390,
      classList: {
        add: (...names) => names.forEach((n) => classSet.add(n)),
        remove: (...names) => names.forEach((n) => classSet.delete(n)),
        contains: (n) => classSet.has(n)
      },
      setAttribute(k, v) {
        this.attributes[k] = String(v);
      },
      getAttribute(k) {
        return this.attributes[k];
      },
      addEventListener: (t, fn) => addEv(elListeners, t, fn),
      removeEventListener: (t, fn) => remEv(elListeners, t, fn),
      dispatchEvent: (t, ev = {}) => fireEv(elListeners, t, { target: el, preventDefault() {}, ...ev }),
      click() {
        fireEv(elListeners, 'click', { target: el, preventDefault() {} });
      },
      appendChild(child) {
        child.parentElement = el;
        el.children.push(child);
        return child;
      },
      insertBefore(node, ref) {
        node.parentElement = el;
        const idx = el.children.indexOf(ref);
        if (idx >= 0) el.children.splice(idx, 0, node);
        else el.children.push(node);
        return node;
      },
      removeChild(child) {
        const idx = el.children.indexOf(child);
        if (idx >= 0) el.children.splice(idx, 1);
        child.parentElement = null;
        return child;
      },
      contains(target) {
        let cur = target;
        while (cur) {
          if (cur === el) return true;
          cur = cur.parentElement;
        }
        return false;
      },
      closest() {
        return null;
      },
      setPointerCapture() {},
      focus() {
        documentMock.activeElement = el;
      },
      // Tests mark layout-dependent elements (display:none in one tier) via el.isRendered
      getClientRects() {
        return typeof el.isRendered === 'function' && !el.isRendered() ? [] : [{}];
      },
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 320, height: 200 }),
      getContext: () => ({
        setTransform() {},
        clearRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        arcTo() {},
        arc() {},
        closePath() {},
        stroke() {},
        fill() {},
        fillRect() {},
        strokeRect() {},
        setLineDash() {},
        fillText() {}
      })
    };
    return el;
  }

  // Populate queryable child nodes when mountCell assigns cellEl.innerHTML
  const parentGrid = makeEl('main', 'grid');
  for (let i = 0; i < (opts.siblingsBefore || 0); i++) parentGrid.appendChild(makeEl('section', 'cell'));
  const cellEl = makeEl('section', 'cell cell-acoustic');
  parentGrid.appendChild(cellEl);

  const subMap = new Map();
  const slotBtns = [0, 1, 2, 3].map((i) => {
    const b = makeEl('button', 'ag-btn ag-slot-btn');
    b.dataset.slot = String(i);
    b.dataset.dir = i < 2 ? 'UP' : 'DOWN';
    return b;
  });
  const grilleBtns = ['right', 'left'].map((g) => {
    const b = makeEl('button', 'ag-seg-btn');
    b.dataset.grille = g;
    return b;
  });
  const modeBtns = ['sonar', 'passive'].map((m) => {
    const b = makeEl('button', 'ag-seg-btn');
    b.dataset.mode = m;
    return b;
  });

  const singleSelectors = [
    '.ag-led', '.ag-vernier-mini', '.ag-mic-wrap', '.ag-mic-select',
    '.ag-demo-up', '.ag-demo-dn', '.ag-expand-btn', '.ag-micro-cta',
    '.ag-arm-btn', '.ag-cal-btn', '.ag-cal-reset', '.ag-oof-verdict',
    '.ag-hw-status', '.ag-loop-status', '.ag-gain-slider', '.ag-gain-val',
    '.ag-export-btn', '.ag-stage-well', '.ag-stage-wrap', '.ag-stage-canvas',
    '.ag-scope-wrap', '.ag-scope-canvas', '.ag-wf-wrap', '.ag-wf-canvas',
    '.ag-lda-wrap', '.ag-lda-canvas', '.ag-scope-meta', '.ag-toast',
    '.ag-toast-text', '.ag-toast-close'
  ];
  for (const sel of singleSelectors) {
    const tag = sel.includes('canvas') ? 'canvas' : sel.includes('select') ? 'select' : 'div';
    const sub = makeEl(tag, sel.slice(1));
    sub.parentElement = cellEl;
    subMap.set(sel, sub);
  }
  cellEl.querySelector = (sel) => subMap.get(sel) || null;
  cellEl.querySelectorAll = (sel) => {
    if (sel === '.ag-slot-btn') return slotBtns;
    if (sel === '[data-grille]') return grilleBtns;
    if (sel === '[data-mode]') return modeBtns;
    return [];
  };

  // Track hardware resources to prove 0 leaks
  const tracks = [];
  const contexts = [];
  const workletNodes = [];
  const unrevokedUrls = new Set();
  let urlSeq = 0;

  const makeStream = (deviceId = 'mbp-mic', label = 'MacBook Pro Microphone') => {
    const track = {
      label,
      stopped: false,
      stop() { this.stopped = true; },
      getSettings: () => ({ deviceId })
    };
    tracks.push(track);
    return {
      getTracks: () => [track],
      getAudioTracks: () => [track]
    };
  };

  const mediaListeners = new Map();
  const mediaDevices = {
    getUserMedia: opts.getUserMedia || (async (c) => {
      const devId = c?.audio?.deviceId?.exact || 'mbp-mic';
      return makeStream(devId, devId === 'ext-mic' ? 'USB Mic' : 'MacBook Pro Microphone');
    }),
    enumerateDevices: opts.enumerateDevices || (async () => [
      { kind: 'audioinput', deviceId: 'mbp-mic', label: 'MacBook Pro Microphone' },
      { kind: 'audiooutput', deviceId: 'mbp-spk', label: 'MacBook Pro Speakers' }
    ]),
    addEventListener: (t, fn) => addEv(mediaListeners, t, fn),
    removeEventListener: (t, fn) => remEv(mediaListeners, t, fn),
    fire: (t, ev) => fireEv(mediaListeners, t, ev)
  };

  class MockAudioContext {
    constructor(ctxOpts = {}) {
      if (opts.throwOn48k && ctxOpts.sampleRate === 48000) {
        throw new Error('NotSupportedError: 48000 not supported');
      }
      this.sampleRate = opts.contextSampleRate || ctxOpts.sampleRate || 44100;
      this.state = opts.initialCtxState || 'running';
      this.destination = {};
      this.sinkId = '';
      this.audioWorklet = opts.disableWorklet ? null : {
        addModule: opts.addModule || (async () => {})
      };
      contexts.push(this);
    }
    async resume() {
      if (opts.onResume) await opts.onResume(this);
      if (this.state !== 'closed') this.state = 'running';
    }
    async suspend() {
      if (this.state !== 'closed') this.state = 'suspended';
    }
    async close() {
      if (opts.onClose) await opts.onClose(this);
      this.state = 'closed';
    }
    async setSinkId(id) {
      this.sinkId = id;
    }
    createMediaStreamSource() {
      if (opts.throwOnCreateSource) throw new Error('DOMException: sampleRate mismatch');
      return { connect() {}, disconnect() {} };
    }
    createScriptProcessor() {
      return { connect() {}, disconnect() {}, onaudioprocess: null };
    }
  }

  class MockAudioWorkletNode {
    constructor() {
      this.port = {
        onmessage: null,
        posted: [],
        postMessage: (m) => { this.port.posted.push(m); }
      };
      this.onprocessorerror = null;
      this.disconnected = false;
      workletNodes.push(this);
    }
    connect() {}
    disconnect() { this.disconnected = true; }
  }

  const storageMap = new Map();
  if (opts.initialStorage) {
    for (const [k, v] of Object.entries(opts.initialStorage)) storageMap.set(k, v);
  }
  const sessionStorageMock = {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k)
  };

  let rafQueue = [];
  let rafSeq = 1;
  const docListeners = new Map();
  const winListeners = new Map();

  const documentMock = {
    readyState: 'complete',
    hidden: false,
    activeElement: null,
    createElement: (tag) => makeEl(tag),
    getElementById: () => null,
    addEventListener: (t, fn) => addEv(docListeners, t, fn),
    removeEventListener: (t, fn) => remEv(docListeners, t, fn),
    fire: (t, ev) => fireEv(docListeners, t, ev),
    startViewTransition: opts.startViewTransition || null
  };

  const windowMock = {
    isSecureContext: opts.isSecureContext ?? true,
    devicePixelRatio: 2,
    AudioContext: MockAudioContext,
    matchMedia: () => ({ matches: !!opts.reducedMotion }),
    addEventListener: (t, fn) => addEv(winListeners, t, fn),
    removeEventListener: (t, fn) => remEv(winListeners, t, fn),
    fire: (t, ev) => fireEv(winListeners, t, ev)
  };

  const prevGlobals = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    sessionStorage: globalThis.sessionStorage,
    AudioWorkletNode: globalThis.AudioWorkletNode,
    Blob: globalThis.Blob,
    URL: globalThis.URL,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame
  };

  const install = () => {
    Object.defineProperty(globalThis, 'window', { value: windowMock, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'document', { value: documentMock, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices, clipboard: opts.clipboard },
      configurable: true,
      writable: true
    });
    Object.defineProperty(globalThis, 'sessionStorage', { value: sessionStorageMock, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'AudioWorkletNode', { value: MockAudioWorkletNode, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'URL', {
      value: {
        createObjectURL: () => {
          const u = 'blob:mock-' + (++urlSeq);
          unrevokedUrls.add(u);
          return u;
        },
        revokeObjectURL: (u) => {
          unrevokedUrls.delete(u);
        }
      },
      configurable: true,
      writable: true
    });
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      value: (cb) => {
        const id = rafSeq++;
        rafQueue.push({ id, cb });
        return id;
      },
      configurable: true,
      writable: true
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      value: (id) => {
        rafQueue = rafQueue.filter((item) => item.id !== id);
      },
      configurable: true,
      writable: true
    });
  };

  const restore = () => {
    for (const [k, v] of Object.entries(prevGlobals)) {
      if (v === undefined) delete globalThis[k];
      else Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
    }
  };

  const stepRaf = (ts = 16) => {
    const batch = rafQueue.slice();
    rafQueue = [];
    for (const item of batch) item.cb(ts);
    return batch.length;
  };

  return {
    parentGrid,
    cellEl,
    subMap,
    slotBtns,
    grilleBtns,
    modeBtns,
    tracks,
    contexts,
    workletNodes,
    unrevokedUrls,
    makeStream,
    mediaDevices,
    documentMock,
    windowMock,
    storageMap,
    getRafCount: () => rafQueue.length,
    stepRaf,
    install,
    restore
  };
}

test('Coherent TX keeps Left speaker strictly 0.0 and emits 19kHz only on Right channel when >=44.1kHz', () => {
  const silent = new Float32Array(48000 * 0.25);
  const res48 = runBufferThroughEngine(silent, 48000, true);
  assert.equal(res48.leftEnergy, 0, 'Left speaker near 3-MEMS array must stay strictly 0.0');
  assert.ok(res48.rightEnergy > 0.1, 'Right tweeter channel must emit 19kHz carrier at 48kHz');

  const res16 = runBufferThroughEngine(silent, 16000, true);
  assert.equal(res16.rightEnergy, 0, 'Nyquist guard must mute 19kHz carrier when sampleRate < 44100 Hz');
});

test('Left Grille Control separates UP vs DOWN zero-shot in Passive mode', () => {
  for (const dir of ['UP', 'DOWN']) {
    const buf = Lab.synthesizeMac16Stroke({ sampleRate: 48000, dir, grille: 'left', sonarOn: false, seed: 101 });
    const { strokes } = runBufferThroughEngine(buf, 48000, false);
    assert.equal(strokes.length, 1, `Expected 1 stroke for Left ${dir}`);
    const pred = Lab.classifyStroke(strokes[0], null, 'left', false);
    assert.equal(pred.dir, dir);
    assert.ok(pred.confidence > 0.80, `Expected high confidence on Left Grille ${dir}, got ${pred.confidence}`);
  }
});

test('Right Grille + 19.0 kHz Sonar separates UP vs DOWN across 44.1 kHz, 48 kHz, and 96 kHz despite Fresnel phase shift', () => {
  for (const sr of [44100, 48000, 96000]) {
    for (const dir of ['UP', 'DOWN']) {
      const buf = Lab.synthesizeMac16Stroke({
        sampleRate: sr,
        dir,
        grille: 'right',
        sonarOn: true,
        fresnelRad: 2.2,
        seed: sr + (dir === 'UP' ? 7 : 19)
      });
      const { strokes } = runBufferThroughEngine(buf, sr, true);
      assert.equal(strokes.length, 1, `Expected 1 stroke at ${sr}Hz Right ${dir}`);
      const feat = strokes[0];
      assert.ok(feat.dipDb > 2.0, `Expected measurable tweeter occlusion dip at ${sr}Hz, got ${feat.dipDb}`);
      if (dir === 'UP') {
        assert.ok(feat.rawX[4] > 0.05, `Expected positive late occlusion timing x5 for UP, got ${feat.rawX[4]}`);
        assert.ok(feat.rawX[5] > 0.10, `Expected positive blueshift Doppler x6 for UP, got ${feat.rawX[5]}`);
      } else {
        assert.ok(feat.rawX[4] < -0.05, `Expected negative early occlusion timing x5 for DOWN, got ${feat.rawX[4]}`);
        assert.ok(feat.rawX[5] < -0.10, `Expected negative redshift Doppler x6 for DOWN, got ${feat.rawX[5]}`);
      }
      const pred = Lab.classifyStroke(feat, null, 'right', true);
      assert.equal(pred.dir, dir);
      assert.ok(pred.confidence > 0.78, `Expected strong sonar confidence at ${sr}Hz, got ${pred.confidence}`);
    }
  }
});

test('Vetoes reject impulsive taps, low-frequency desk thumps, and harmonic speech', () => {
  for (const kind of ['tap', 'thump', 'speech']) {
    const buf = Lab.synthesizeMac16Stroke({ sampleRate: 48000, kind, grille: 'right', sonarOn: true, seed: 303 });
    const { strokes } = runBufferThroughEngine(buf, 48000, true);
    const valid = strokes.filter((f) => !(f.isTapVeto || f.isThumpVeto || f.isSpeechVeto));
    assert.equal(valid.length, 0, `Expected ${kind} to be vetoed`);
  }
});

test('4-Stroke Cholesky Shrinkage Fisher LDA achieves high d_OOF on real strokes and resists hallucination on pure noise', () => {
  const upStrokes = [11, 22].map((seed) => {
    const b = Lab.synthesizeMac16Stroke({ sampleRate: 48000, dir: 'UP', grille: 'right', sonarOn: true, seed });
    return runBufferThroughEngine(b, 48000, true).strokes[0];
  });
  const dnStrokes = [33, 44].map((seed) => {
    const b = Lab.synthesizeMac16Stroke({ sampleRate: 48000, dir: 'DOWN', grille: 'right', sonarOn: true, seed });
    return runBufferThroughEngine(b, 48000, true).strokes[0];
  });

  const model = Lab.fitShrinkageLDA(upStrokes, dnStrokes, 'right', true);
  assert.ok(model && model.calibrated);
  assert.ok(model.dPrimeOof > 1.8, `Expected strong out-of-fold d'_OOF > 1.8, got ${model.dPrimeOof}`);

  const heldUp = runBufferThroughEngine(
    Lab.synthesizeMac16Stroke({ sampleRate: 48000, dir: 'UP', grille: 'right', sonarOn: true, seed: 99 }),
    48000,
    true
  ).strokes[0];
  const heldDn = runBufferThroughEngine(
    Lab.synthesizeMac16Stroke({ sampleRate: 48000, dir: 'DOWN', grille: 'right', sonarOn: true, seed: 105 }),
    48000,
    true
  ).strokes[0];
  assert.equal(Lab.classifyStroke(heldUp, model, 'right', true).dir, 'UP');
  assert.equal(Lab.classifyStroke(heldDn, model, 'right', true).dir, 'DOWN');

  const nullA = [
    { scaledX: [0.10, -0.05, 0.02, -0.04, 0, 0], fricCurve64: new Float32Array(64), dopCurve64: new Float32Array(64) },
    { scaledX: [-0.12, 0.08, -0.03, 0.05, 0, 0], fricCurve64: new Float32Array(64), dopCurve64: new Float32Array(64) }
  ];
  const nullB = [
    { scaledX: [0.09, 0.06, -0.01, -0.03, 0, 0], fricCurve64: new Float32Array(64), dopCurve64: new Float32Array(64) },
    { scaledX: [-0.08, -0.07, 0.04, 0.02, 0, 0], fricCurve64: new Float32Array(64), dopCurve64: new Float32Array(64) }
  ];
  const nullModel = Lab.fitShrinkageLDA(nullA, nullB, 'right', false);
  assert.ok(nullModel.dPrimeOof < 0.8, `Null noise must not hallucinate high d'_OOF, got ${nullModel.dPrimeOof}`);
});

test('CoreAudio input ranking prioritizes MacBook Pro Microphone over DJI Wireless Mic and iPhone Continuity', () => {
  const sMbp = Lab.rankAudioInputDevice('MacBook Pro Microphone (Built-in)');
  const sDji = Lab.rankAudioInputDevice('Wireless Mic Rx (DJI Technology Co., Ltd.)');
  const sIphone = Lab.rankAudioInputDevice('Ed’s iPhone Microphone');
  const sHue = Lab.rankAudioInputDevice('Hue Sync Audio');
  assert.ok(sMbp > 90);
  assert.ok(sDji < 0 && sIphone < 0 && sHue < 0);
});

// =========================================================================
// Stage 2 Regression Suite 1: Isolated AudioWorkletGlobalScope Execution
// =========================================================================
test('Suite 1: buildWorkletSource executes in isolated node:vm AudioWorkletGlobalScope with 0 ReferenceErrors', () => {
  const src = Lab.buildWorkletSource();
  assert.ok(src.includes('FEATURE_SCALES'), 'Worklet source must define FEATURE_SCALES');

  let RegisteredCtor = null;
  const posted = [];
  class AudioWorkletProcessor {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (msg) => posted.push(msg)
      };
    }
  }

  const sandbox = vm.createContext({
    sampleRate: 48000,
    AudioWorkletProcessor,
    registerProcessor: (name, ctor) => {
      assert.equal(name, 'grille-homodyne-processor');
      RegisteredCtor = ctor;
    },
    Float32Array,
    Float64Array,
    Math,
    Array,
    Number,
    JSON
  });

  vm.runInContext(src, sandbox);
  assert.equal(typeof RegisteredCtor, 'function', 'GrilleHomodyneProcessor must register cleanly');

  const proc = new RegisteredCtor();
  proc.port.onmessage({ data: { type: 'config', sonar: true, operatingGain: 0.13, probe: false } });

  const buf = Lab.synthesizeMac16Stroke({ sampleRate: 48000, dir: 'UP', grille: 'right', sonarOn: true, seed: 515 });
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);
  for (let off = 0; off < buf.length; off += 128) {
    const slice = buf.subarray(off, Math.min(buf.length, off + 128));
    const keepAlive = proc.process([[slice]], [[outL, outR]]);
    assert.equal(keepAlive, true);
    for (let i = 0; i < outL.length; i++) assert.equal(outL[i], 0);
  }

  const strokeMsgs = posted.filter((m) => m.type === 'stroke');
  assert.equal(strokeMsgs.length, 1, 'Worklet must emit 1 stroke without throwing ReferenceError');
  const strokeFeat = strokeMsgs[0].feat;
  assert.equal(strokeFeat.scaledX.length, 6);
  assert.ok(strokeFeat.scaledX.every((v) => Number.isFinite(v)), 'All 6 scaledX features must be finite');
  assert.equal(Lab.classifyStroke(strokeFeat, null, 'right', true).dir, 'UP');
});

// =========================================================================
// Stage 2 Regression Suite 2: Async armAudio / disarmAudio Leak & Race Suite
// =========================================================================
test('Suite 2: Async armAudio/disarmAudio races, addModule failure, onprocessorerror, sampleRate fallback & ViewTransition', async () => {
  const flush = () => new Promise((r) => setTimeout(r, 15));

  // 2a. Double-click Arm Mic (both synchronous 0ms and staggered mid-getUserMedia) -> 0 leaked tracks or contexts
  {
    let gumCalls = 0;
    const gates = [];
    const env = createBrowserEnv({
      getUserMedia: () => new Promise((resolve) => {
        gumCalls++;
        gates.push(() => resolve(env.makeStream('mbp-mic', 'MacBook Pro Microphone')));
      })
    });
    env.install();
    try {
      const api = Lab.mountCell(env.cellEl);
      const armBtn = env.subMap.get('.ag-arm-btn');
      // Synchronous 0ms double-click aborts 1st call before getUserMedia even fires
      armBtn.click();
      armBtn.click();
      await flush();
      assert.equal(gumCalls, 1, 'Synchronous double-click cancels stale arm before 1st getUserMedia');
      // Staggered click while 1st getUserMedia is still in-flight spawns 2nd getUserMedia and stops 1st on resolve
      armBtn.click();
      await flush();
      assert.equal(gumCalls, 2, 'Staggered double-click overlaps 2 concurrent getUserMedia calls');
      gates.forEach((g) => g());
      await flush();
      assert.equal(env.tracks.filter((t) => !t.stopped).length, 1, 'Only winning stream stays live while armed');
      await api.disarm();
      await flush();
      assert.equal(env.tracks.filter((t) => !t.stopped).length, 0, '0 live tracks after double-click arm + disarm');
      assert.equal(env.contexts.filter((c) => c.state !== 'closed').length, 0, '0 open AudioContexts');
      await api.destroy();
    } finally {
      env.restore();
    }
  }

  // 2b. Disarm during pending getUserMedia -> 0 live tracks, stays disarmed
  {
    let resolveGum;
    const env = createBrowserEnv({
      getUserMedia: () => new Promise((r) => { resolveGum = r; })
    });
    env.install();
    try {
      const api = Lab.mountCell(env.cellEl);
      env.subMap.get('.ag-arm-btn').click();
      await flush();
      const disarmP = api.disarm();
      resolveGum(env.makeStream());
      await disarmP;
      await flush();
      assert.equal(env.subMap.get('.ag-arm-btn').dataset.armed, 'false');
      assert.equal(env.tracks.filter((t) => !t.stopped).length, 0, 'Pending stream must stop immediately on stale resolve');
      assert.equal(env.contexts.filter((c) => c.state !== 'closed').length, 0);
      await api.destroy();
    } finally {
      env.restore();
    }
  }

  // 2c. Error after getUserMedia (createMediaStreamSource throws) -> 0 leaked tracks / contexts
  {
    const env = createBrowserEnv({ throwOnCreateSource: true, throwOn48k: true });
    env.install();
    try {
      const api = Lab.mountCell(env.cellEl);
      env.subMap.get('.ag-arm-btn').click();
      await flush();
      assert.equal(env.subMap.get('.ag-arm-btn').dataset.armed, 'false');
      assert.equal(env.tracks.filter((t) => !t.stopped).length, 0, 'Stream must be stopped in catch block');
      assert.equal(env.contexts.filter((c) => c.state !== 'closed').length, 0, 'AudioContext must be closed in catch block');
      assert.equal(env.subMap.get('.ag-toast').hidden, false);
      await api.destroy();
    } finally {
      env.restore();
    }
  }

  // 2d. Disarm mid-addModule AND addModule failure immediate Blob URL revocation + onprocessorerror
  {
    let rejectAddModule;
    const env = createBrowserEnv({
      addModule: () => new Promise((_, rej) => { rejectAddModule = rej; })
    });
    env.install();
    try {
      const api = Lab.mountCell(env.cellEl);
      env.subMap.get('.ag-arm-btn').click();
      await flush();
      assert.equal(env.unrevokedUrls.size, 1);
      // Fail addModule while still armed -> falls back to ScriptProcessor AND revokes Blob URL immediately!
      rejectAddModule(new Error('CSP blocked blob worklet'));
      await flush();
      assert.equal(env.unrevokedUrls.size, 0, 'Blob URL must be revoked immediately when addModule fails');
      assert.equal(env.subMap.get('.ag-arm-btn').dataset.armed, 'true', 'ScriptProcessor fallback arms cleanly');
      await api.disarm();
      assert.equal(env.tracks.filter((t) => !t.stopped).length, 0);
      assert.equal(env.contexts.filter((c) => c.state !== 'closed').length, 0);

      // Now disarm WHILE addModule is pending -> must NOT fall back to ScriptProcessor!
      env.subMap.get('.ag-arm-btn').click();
      await flush();
      const dProm = api.disarm();
      rejectAddModule(new Error('Aborted'));
      await dProm;
      await flush();
      assert.equal(env.subMap.get('.ag-arm-btn').dataset.armed, 'false');
      assert.equal(env.unrevokedUrls.size, 0);
      assert.equal(env.tracks.filter((t) => !t.stopped).length, 0);
      assert.equal(env.contexts.filter((c) => c.state !== 'closed').length, 0);
      await api.destroy();
    } finally {
      env.restore();
    }
  }

  // 2e. Worklet onprocessorerror disarms cleanly, 16kHz sampleRate reloads calibration, uncoupled visibilitychange safe, devicechange debounced
  {
    const env = createBrowserEnv({ contextSampleRate: 48000, throwOn48k: true });
    env.install();
    try {
      const api = Lab.mountCell(env.cellEl);
      env.subMap.get('.ag-arm-btn').click();
      await flush();
      assert.equal(env.subMap.get('.ag-arm-btn').dataset.armed, 'true');
      assert.equal(env.workletNodes.length, 1);

      // Simulate failed loopback probe -> uncoupled
      const wNode = env.workletNodes[0];
      wNode.port.onmessage({ data: { type: 'probe', ok: false, snrDb: 0.2 } });
      wNode.port.posted.length = 0;

      // Hide & show tab -> must NOT re-enable sonar after failed probe!
      env.documentMock.hidden = true;
      env.documentMock.fire('visibilitychange');
      env.documentMock.hidden = false;
      env.documentMock.fire('visibilitychange');
      await flush();
      const sonarPosts = wNode.port.posted.filter((m) => m.type === 'config' && m.sonar === true);
      assert.equal(sonarPosts.length, 0, 'Tab visibility resume must not bypass failed loopback probe');

      // Rapid triple devicechange -> debounced into 1 re-arm, 0 leaked resources
      env.mediaDevices.fire('devicechange');
      env.mediaDevices.fire('devicechange');
      env.mediaDevices.fire('devicechange');
      await new Promise((r) => setTimeout(r, 230));
      assert.equal(env.tracks.filter((t) => !t.stopped).length, 1, 'Exactly 1 active track after debounced devicechange');
      assert.equal(env.contexts.filter((c) => c.state !== 'closed').length, 1, 'Exactly 1 active AudioContext');

      // Trigger onprocessorerror on active worklet node -> disarms cleanly + warning toast
      const latestNode = env.workletNodes[env.workletNodes.length - 1];
      latestNode.onprocessorerror(new Error('Worklet crash'));
      await flush();
      assert.equal(env.subMap.get('.ag-arm-btn').dataset.armed, 'false');
      assert.equal(env.tracks.filter((t) => !t.stopped).length, 0);
      assert.equal(env.contexts.filter((c) => c.state !== 'closed').length, 0);
      await api.destroy();
    } finally {
      env.restore();
    }
  }

  // 2f. 16 kHz Bluetooth HFP sampleRate switches to Passive AND reloads calibration; toggleExpand + destroy never orphans placeholder or throws AbortError
  {
    const vtCallbacks = [];
    const env = createBrowserEnv({
      contextSampleRate: 16000,
      startViewTransition: (cb) => {
        vtCallbacks.push(cb);
        const abortErr = Object.assign(new Error('Transition was skipped'), { name: 'AbortError' });
        return {
          ready: Promise.reject(abortErr),
          finished: Promise.reject(abortErr),
          updateCallbackDone: Promise.resolve()
        };
      }
    });
    env.install();
    try {
      const api = Lab.mountCell(env.cellEl);
      // Calibrate 4 strokes in unarmed Sonar mode first
      env.subMap.get('.ag-cal-btn').click();
      api.injectDemoStroke('UP');
      api.injectDemoStroke('UP');
      api.injectDemoStroke('DOWN');
      api.injectDemoStroke('DOWN');
      assert.equal(env.subMap.get('.ag-cal-btn').dataset.calibrated, 'true');

      // Arm on 16 kHz HFP -> auto-switches to Passive and reloads Passive calibration (uncalibrated!)
      env.subMap.get('.ag-arm-btn').click();
      await flush();
      assert.equal(env.subMap.get('.ag-cal-btn').dataset.calibrated, 'false', '16kHz passive switch must clear active sonar LDA model');

      // Rapid toggleExpand double-call + immediate destroy before async VT callback fires
      api.toggleExpand(true);
      api.toggleExpand(false);
      api.toggleExpand(true);
      await api.destroy();
      for (const cb of vtCallbacks) cb();
      await flush();
      assert.equal(env.cellEl.classList.contains('is-expanded'), false, 'Destroyed cell must not stay .is-expanded');
      assert.equal(env.parentGrid.children.filter((c) => c.className.includes('ag-grid-placeholder')).length, 0, '0 orphaned placeholders');
      assert.equal(env.cellEl.dataset.agMounted, undefined, 'destroy() must delete dataset.agMounted');
    } finally {
      env.restore();
    }
  }
});

// =========================================================================
// Stage 2 Regression Suite 3: 44.1/48/96 kHz Loopback Probe & Gain Blanking
// =========================================================================
test('Suite 3: Acoustic loopback probe achieves >= +22 dB SNR across 44.1/48/96 kHz and gain transitions fire 0 phantom strokes', () => {
  for (const sr of [44100, 48000, 96000]) {
    // Uncoupled muted-speaker check (white noise + 440 Hz tone) must fail probe cleanly
    const uncoupledEng = Lab.createStreamEngine(sr);
    uncoupledEng.setSonarTarget(true, 0.13, true);
    const outL = new Float32Array(128);
    const outR = new Float32Array(128);
    const noiseIn = new Float32Array(128);
    let uncoupledProbe = null;
    let seed = 91;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return ((seed / 4294967296) - 0.5) * 0.002;
    };
    const probeQuanta = Math.ceil((sr * 0.25) / 128);
    for (let q = 0; q < probeQuanta; q++) {
      for (let i = 0; i < 128; i++) {
        const t = (q * 128 + i) / sr;
        noiseIn[i] = rng() + 0.01 * Math.sin(2 * Math.PI * 440 * t);
      }
      uncoupledEng.processQuantum(noiseIn, outL, outR, {
        operatingGain: 0.13,
        onProbeResult: (ok, snrDb) => { uncoupledProbe = { ok, snrDb }; }
      });
    }
    assert.ok(uncoupledProbe && uncoupledProbe.ok === false, `Muted speaker at ${sr}Hz must fail loopback probe`);

    // Coupled 18 ms latency loopback + probe ramp + Pilot slider jumps + idle sleep/wake -> >= +22 dB SNR & 0 phantom strokes
    const eng = Lab.createStreamEngine(sr);
    eng.setSonarTarget(true, 0.13, true);
    const delayLen = Math.round(0.018 * sr);
    const delayLine = new Float32Array(delayLen);
    let dPtr = 0;
    const rx = new Float32Array(128);
    let coupledProbe = null;
    const phantomStrokes = [];
    let opGain = 0.13;
    const totalQuanta = Math.ceil((sr * 2.6) / 128);

    for (let q = 0; q < totalQuanta; q++) {
      const tSec = (q * 128) / sr;
      if (Math.abs(tSec - 0.70) < 128 / sr) { opGain = 0.22; eng.setSonarTarget(true, opGain, false); }
      if (Math.abs(tSec - 1.15) < 128 / sr) { opGain = 0.04; eng.setSonarTarget(true, opGain, false); }
      if (Math.abs(tSec - 1.60) < 128 / sr) { eng.setSonarTarget(false, opGain, false); }
      if (Math.abs(tSec - 2.00) < 128 / sr) { opGain = 0.15; eng.setSonarTarget(true, opGain, false); }

      for (let i = 0; i < 128; i++) rx[i] = delayLine[(dPtr + i) % delayLen];
      eng.processQuantum(rx, outL, outR, {
        operatingGain: opGain,
        onProbeResult: (ok, snrDb) => { coupledProbe = { ok, snrDb }; },
        onStroke: (feat) => phantomStrokes.push(feat)
      });
      for (let i = 0; i < 128; i++) {
        delayLine[dPtr] = 0.35 * outR[i] + rng() * 0.15;
        dPtr = (dPtr + 1) % delayLen;
      }
    }

    assert.ok(coupledProbe && coupledProbe.ok === true, `Expected coupled probe pass at ${sr}Hz`);
    assert.ok(coupledProbe.snrDb >= 22.0, `Expected probe SNR >= 22 dB at ${sr}Hz, got ${coupledProbe.snrDb}`);
    assert.equal(phantomStrokes.length, 0, `Expected 0 phantom strokes across gain ramps at ${sr}Hz, got ${phantomStrokes.length}`);
  }
});

// =========================================================================
// Stage 2 Regression Suite 4: Post-Roll Clutter Invariance & tauDip Symmetry
// =========================================================================
test('Suite 4: 920ms late-occluded stroke preserves pre-onset clutter/noise baseline and UP/DOWN tauDip is symmetric', () => {
  const sr = 48000;
  const len = Math.floor(sr * 1.45);
  const buf = new Float32Array(len);
  let seed = 2026;
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return ((seed / 4294967296) - 0.5) * 0.0004;
  };

  // Idle carrier 0..300ms, then 960ms stroke (300..1260ms) with heavy late occlusion (-10dB) + Doppler right across 920ms cap & 48ms post-roll
  let phiC = 0;
  let echoPhi = 0.2;
  const dPhi = (2 * Math.PI * Lab.CARRIER_HZ) / sr;
  const s0 = Math.floor(0.30 * sr);
  const s1 = Math.floor(1.26 * sr);
  for (let i = 0; i < len; i++) {
    const inS = i >= s0 && i < s1;
    const late = i >= Math.floor(1.05 * sr) && i < s1;
    const occ = late ? 0.68 : (inS ? 0.25 : 0);
    const dop = inS ? 42 : 0;
    const direct = 0.026 * (1 - occ) * Math.cos(phiC);
    phiC += dPhi;
    if (phiC >= 2 * Math.PI) phiC -= 2 * Math.PI;
    echoPhi += (2 * Math.PI * (Lab.CARRIER_HZ + dop)) / sr;
    const echo = (inS ? 0.006 : 0.0001) * Math.cos(echoPhi);
    buf[i] = direct + echo + (inS ? 0.006 : 1) * rng();
  }

  const eng = Lab.createStreamEngine(sr);
  eng.setSonarTarget(true, 0.13, false);
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);
  let preDbg = null;
  let postStrokeDbg = null;
  const strokes = [];

  for (let off = 0; off < len; off += 128) {
    if (off === Math.floor(0.28 * sr / 128) * 128) {
      preDbg = eng.getDebugState();
    }
    eng.processQuantum(buf.subarray(off, Math.min(len, off + 128)), outL, outR, {
      operatingGain: 0.13,
      onStroke: (f) => {
        strokes.push(f);
        postStrokeDbg = eng.getDebugState();
      }
    });
  }

  assert.equal(strokes.length, 1, 'Expected 920ms capped stroke to emit cleanly');
  const preMag = Math.hypot(preDbg.clutterI, preDbg.clutterQ);
  const postMag = Math.hypot(postStrokeDbg.clutterI, postStrokeDbg.clutterQ);
  const relDrift = Math.abs(postMag - preMag) / preMag;
  assert.ok(relDrift < 0.02, `Clutter magnitude must stay invariant across post-roll, drifted ${(relDrift * 100).toFixed(2)}%`);
  assert.ok(postStrokeDbg.noiseDopPow < preDbg.noiseDopPow * 2.0, 'Doppler noise floor must not inflate during post-roll');
  assert.ok(strokes[0].dipDb > 6.5, `Late-occluded stroke must preserve true dipDb > 6.5 dB, got ${strokes[0].dipDb}`);

  // Verify 1:1 UP/DOWN tauDip & x5 symmetry (twStation = 0.68 vs 0.32 -> sum ~ 1.00)
  const upFeat = runBufferThroughEngine(
    Lab.synthesizeMac16Stroke({ sampleRate: 48000, dir: 'UP', grille: 'right', sonarOn: true, seed: 808 }),
    48000,
    true
  ).strokes[0];
  const dnFeat = runBufferThroughEngine(
    Lab.synthesizeMac16Stroke({ sampleRate: 48000, dir: 'DOWN', grille: 'right', sonarOn: true, seed: 808 }),
    48000,
    true
  ).strokes[0];
  assert.ok(Math.abs((upFeat.tauDip + dnFeat.tauDip) - 1.0) < 0.04, `Expected symmetric tauDip around 0.5, got UP=${upFeat.tauDip}, DOWN=${dnFeat.tauDip}`);
  assert.ok(Math.abs(upFeat.rawX[4] + dnFeat.rawX[4]) < 0.06, `Expected symmetric opposite-sign x5, got UP=${upFeat.rawX[4]}, DOWN=${dnFeat.rawX[4]}`);
});

// =========================================================================
// Stage 2 Regression Suite 5: Numerical & UI Edge Cases
// =========================================================================
test('Suite 5: Numerical & UI edge cases (nP=0/1, resampleCurve, filtfiltReal n=0..130, no-arg synth, corrupted sessionStorage, reducedMotion wheel)', async () => {
  // 5a. extractStrokeFeatures with nP = 0 and nP = 1 produces 0 NaNs
  for (const pFrames of [[], [{ eSub: 1e-6, eMid: 1e-6, eAir: 1e-6, eFric: 1e-6, crest: 2.1, sfm: 0.4 }]]) {
    const feat = Lab.extractStrokeFeatures({
      passiveFrames: pFrames,
      bbI: new Float64Array(32),
      bbQ: new Float64Array(32),
      m0: 4,
      m1: 24,
      fbb: 1000,
      clutterI: 0.02,
      clutterQ: 0,
      sonarActive: true,
      noiseAirDb: -75,
      noiseDopPow: 1e-9,
      durMs: 120
    });
    assert.ok(feat.rawX.every((v) => Number.isFinite(v)), `rawX must be finite for nP=${pFrames.length}`);
    assert.ok(feat.scaledX.every((v) => Number.isFinite(v)), `scaledX must be finite for nP=${pFrames.length}`);
  }

  // 5b. resampleCurve edge lengths (0, 1, 64)
  assert.equal(Lab.resampleCurve([3.5, 7.0], 0).length, 0);
  const rc1 = Lab.resampleCurve([3.5, 7.0], 1);
  assert.equal(rc1.length, 1);
  assert.equal(rc1[0], 3.5);

  // 5c. filtfiltReal across all lengths n = 0..130 produces 0 NaNs
  for (let n = 0; n <= 130; n++) {
    const arr = new Float64Array(n);
    for (let i = 0; i < n; i++) arr[i] = Math.sin(i * 0.2) + 0.5;
    const out = Lab.filtfiltReal(arr, 8.0, 1000);
    assert.equal(out.length, n);
    for (let i = 0; i < n; i++) assert.ok(Number.isFinite(out[i]), `filtfiltReal NaN at n=${n}, i=${i}`);
  }

  // 5d. synthesizeMac16Stroke() with zero arguments succeeds
  const defBuf = Lab.synthesizeMac16Stroke();
  assert.ok(defBuf instanceof Float32Array && defBuf.length > 1000);

  // 5e. fitShrinkageLDA handles identical inputs (dPrimeOof = 0, finite) and rejects NaN/malformed inputs
  const ident = [{ scaledX: [1, 2, 3, 4, 5, 6] }, { scaledX: [1, 2, 3, 4, 5, 6] }];
  const identModel = Lab.fitShrinkageLDA(ident, ident, 'right', true);
  assert.ok(identModel && Number.isFinite(identModel.dPrimeOof) && identModel.dPrimeOof === 0);
  assert.equal(Lab.fitShrinkageLDA([{ scaledX: [NaN, 0, 0, 0, 0, 0] }, { scaledX: [0, 0, 0, 0, 0, 0] }], ident, 'right', true), null);
  assert.equal(Lab.fitShrinkageLDA([{}, {}], [{}, {}], 'right', true), null);

  // 5f. Corrupted sessionStorage + prefers-reduced-motion wheel RAF sleep
  const env = createBrowserEnv({
    reducedMotion: true,
    initialStorage: {
      'ag_lda_v1::right::sonar': '[{},{},{},{}]'
    }
  });
  env.install();
  try {
    const api = Lab.mountCell(env.cellEl);
    assert.ok(env.slotBtns.every((b) => b.dataset.filled === 'false'), 'Corrupted sessionStorage must not mark slots filled');
    assert.equal(env.subMap.get('.ag-cal-btn').dataset.calibrated, 'false');

    // Drain initial render frame, then fire wheel under prefers-reduced-motion: reduce
    env.stepRaf(16);
    assert.equal(env.getRafCount(), 0);
    env.subMap.get('.ag-stage-well').dispatchEvent('wheel', { deltaY: -120 });
    assert.equal(env.getRafCount(), 1, 'Wheel queues 1 render frame');
    env.stepRaf(32);
    assert.equal(env.getRafCount(), 0, 'RAF must sleep immediately after 1 frame under prefers-reduced-motion');
    await api.destroy();
  } finally {
    env.restore();
  }
});

// =========================================================================
// Deep-pass Regression Suite 6: label, permission paths, hidden-tab tone, probe bypass,
// pagehide, calibration cancel, demo veto feedback, expand focus, rAF sleep
// =========================================================================
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const lastConfig = (node) => node.port.posted.filter((m) => m.type === 'config').slice(-1)[0];
const liveTracks = (env) => env.tracks.filter((t) => !t.stopped).length;
const openContexts = (env) => env.contexts.filter((c) => c.state !== 'closed').length;

test('Suite 6a: tile title is README number 06 even when the cell is the 8th grid child', async () => {
  const env = createBrowserEnv({ siblingsBefore: 7 });
  env.install();
  try {
    const api = Lab.mountCell(env.cellEl);
    assert.match(env.cellEl.innerHTML, /06 · RIGHT GRILLE/);
    assert.match(env.cellEl.innerHTML, /06 · MBP-16 RIGHT GRILLE/);
    assert.doesNotMatch(env.cellEl.innerHTML, /08 · /);
    await api.destroy();
  } finally {
    env.restore();
  }
});

test('Suite 6b: denied getUserMedia asks once and leaves a recoverable UI; only constraint errors retry', async () => {
  {
    const calls = [];
    const env = createBrowserEnv({
      getUserMedia: async (c) => {
        calls.push(c);
        throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
      }
    });
    env.install();
    try {
      const api = Lab.mountCell(env.cellEl);
      const arm = env.subMap.get('.ag-arm-btn');
      arm.click();
      await tick();
      assert.equal(calls.length, 1, 'NotAllowedError must not trigger a second permission request');
      assert.equal(arm.dataset.armed, 'false');
      assert.equal(arm.textContent, '● Arm Mic');
      assert.equal(env.subMap.get('.ag-led').dataset.state, 'idle');
      assert.equal(env.subMap.get('.ag-toast').hidden, false);
      assert.match(env.subMap.get('.ag-toast-text').textContent, /permission denied/i);
      arm.click();
      await tick();
      assert.equal(calls.length, 2, 'Arm stays clickable after a denial (one request per click)');
      await api.destroy();
    } finally {
      env.restore();
    }
  }
  {
    let n = 0;
    let env = null;
    env = createBrowserEnv({
      getUserMedia: async () => {
        n++;
        if (n === 1) throw Object.assign(new Error('exact:false unsupported'), { name: 'OverconstrainedError' });
        return env.makeStream();
      }
    });
    env.install();
    try {
      const api = Lab.mountCell(env.cellEl);
      env.subMap.get('.ag-arm-btn').click();
      await tick();
      assert.equal(n, 2, 'OverconstrainedError retries once with relaxed constraints');
      assert.equal(env.subMap.get('.ag-arm-btn').dataset.armed, 'true');
      await api.destroy();
      assert.equal(liveTracks(env), 0);
    } finally {
      env.restore();
    }
  }
});

test('Suite 6c: a never-resolving AudioContext.resume() fails at a ceiling and a newer arm releases the stale one at once', async () => {
  const env = createBrowserEnv({
    initialCtxState: 'suspended',
    onResume: () => new Promise(() => {})
  });
  env.install();
  try {
    const api = Lab.mountCell(env.cellEl);
    const arm = env.subMap.get('.ag-arm-btn');
    arm.click();
    await tick(40);
    assert.equal(liveTracks(env), 1, 'first arm holds its stream while resume() is pending');
    arm.click(); // supersede while the first resume() is still pending
    await tick(40);
    assert.equal(env.tracks[0].stopped, true, 'superseded arm must stop its stream immediately');
    assert.equal(env.contexts[0].state, 'closed', 'superseded arm must close its AudioContext immediately');
    await tick(2200);
    assert.equal(arm.dataset.armed, 'false');
    assert.equal(liveTracks(env), 0, 'no live mic track after the resume ceiling');
    assert.equal(openContexts(env), 0, 'no open AudioContext after the resume ceiling');
    assert.match(env.subMap.get('.ag-toast-text').textContent, /suspended/i);
    await api.destroy();
  } finally {
    env.restore();
  }
});

test('Suite 6d: a devicechange re-arm that completes in a hidden tab emits no tone until visible, then re-probes', async () => {
  const env = createBrowserEnv({ contextSampleRate: 48000 });
  env.install();
  try {
    const api = Lab.mountCell(env.cellEl);
    env.subMap.get('.ag-arm-btn').click();
    await tick();
    env.workletNodes[0].port.onmessage({ data: { type: 'probe', ok: true, snrDb: 30 } });
    env.documentMock.hidden = true;
    env.documentMock.fire('visibilitychange');
    env.mediaDevices.fire('devicechange');
    await tick(260);
    assert.equal(env.workletNodes.length, 2, 'devicechange re-armed');
    const node = env.workletNodes[1];
    assert.equal(node.port.posted.filter((m) => m.type === 'config' && m.sonar === true).length, 0,
      'hidden re-arm must not switch the 19 kHz tone on');
    assert.equal(env.contexts[env.contexts.length - 1].state, 'suspended', 'hidden re-arm must suspend its context');
    assert.notEqual(env.subMap.get('.ag-led').dataset.state, 'sonar', 'LED must not claim sonar before the probe passes');
    env.documentMock.hidden = false;
    env.documentMock.fire('visibilitychange');
    await tick();
    const cfg = lastConfig(node);
    assert.equal(cfg.sonar, true);
    assert.equal(cfg.probe, true, 'tone returns only through the loopback probe');
    await api.destroy();
  } finally {
    env.restore();
  }
});

test('Suite 6e: hiding, the Pilot slider, or a mode round-trip during the 180 ms probe never skip the probe', async () => {
  const cases = {
    hideShow: (env) => {
      env.documentMock.hidden = true;
      env.documentMock.fire('visibilitychange');
      env.documentMock.hidden = false;
      env.documentMock.fire('visibilitychange');
    },
    gainSlider: (env) => {
      const g = env.subMap.get('.ag-gain-slider');
      g.value = '0.20';
      g.dispatchEvent('input');
    },
    modeRoundTrip: (env) => {
      env.modeBtns[1].click(); // Passive
      env.modeBtns[0].click(); // back to 19k Sonar
    }
  };
  for (const [name, act] of Object.entries(cases)) {
    const env = createBrowserEnv({ contextSampleRate: 48000 });
    env.install();
    try {
      const api = Lab.mountCell(env.cellEl);
      env.subMap.get('.ag-arm-btn').click();
      await tick();
      const node = env.workletNodes[0];
      assert.equal(lastConfig(node).probe, true, `${name}: arm starts the probe`);
      act(env);
      await tick();
      const sonarOnNoProbe = node.port.posted.filter((m) => m.type === 'config' && m.sonar === true && m.probe !== true);
      assert.equal(sonarOnNoProbe.length, 0, `${name}: operating gain sent before any probe result`);
      assert.equal(lastConfig(node).probe, true, `${name}: pending probe must be re-sent`);
      assert.match(env.subMap.get('.ag-loop-status').innerHTML, /self-test/i, `${name}: strip must not claim Coupled before the probe`);
      assert.notEqual(env.subMap.get('.ag-led').dataset.state, 'sonar', `${name}: LED must not claim sonar before the probe`);
      node.port.onmessage({ data: { type: 'probe', ok: true, snrDb: 28 } });
      assert.equal(env.subMap.get('.ag-led').dataset.state, 'sonar', `${name}: LED turns sonar once the probe passes`);
      assert.match(env.subMap.get('.ag-loop-status').innerHTML, /Coupled/);
      await api.destroy();
    } finally {
      env.restore();
    }
  }
});

test('Suite 6f: pagehide resets the Arm button so a back/forward-cache restore is truthful', async () => {
  const env = createBrowserEnv();
  env.install();
  try {
    const api = Lab.mountCell(env.cellEl);
    env.subMap.get('.ag-arm-btn').click();
    await tick();
    assert.equal(env.subMap.get('.ag-arm-btn').dataset.armed, 'true');
    env.windowMock.fire('pagehide');
    await tick();
    assert.equal(env.subMap.get('.ag-arm-btn').dataset.armed, 'false');
    assert.equal(env.subMap.get('.ag-led').dataset.state, 'idle');
    assert.equal(liveTracks(env), 0);
    await api.destroy();
  } finally {
    env.restore();
  }
});

test('Suite 6g: cancelling a re-calibration restores the saved model and clears the calibration toast', async () => {
  const env = createBrowserEnv();
  env.install();
  try {
    const api = Lab.mountCell(env.cellEl);
    const cal = env.subMap.get('.ag-cal-btn');
    cal.click();
    ['UP', 'UP', 'DOWN', 'DOWN'].forEach((d) => api.injectDemoStroke(d));
    assert.equal(cal.dataset.calibrated, 'true');
    cal.click(); // start a new run
    assert.equal(env.subMap.get('.ag-toast').hidden, false);
    cal.click(); // cancel it
    assert.equal(cal.dataset.calibrated, 'true', 'saved calibration must come back on cancel');
    assert.equal(env.subMap.get('.ag-toast').hidden, true, 'stale "Calibrating" toast must clear');
    cal.click();
    env.grilleBtns[1].click(); // leaving the regime also ends the run
    assert.equal(env.subMap.get('.ag-toast').hidden, true);
    await api.destroy();
  } finally {
    env.restore();
  }
});

test('Suite 6h: every Demo click either moves the readout or explains why it did not', async () => {
  const env = createBrowserEnv();
  env.install();
  try {
    const api = Lab.mountCell(env.cellEl);
    // L Ctrl and R Grille, both directions. (Synthetic left strokes are often speech-vetoed;
    // see NOTES section 5. This test holds whether or not that is ever changed.)
    for (const g of [1, 0]) {
      env.grilleBtns[g].click();
      for (let i = 0; i < 12; i++) {
        const dir = i % 2 ? 'DOWN' : 'UP';
        const before = env.subMap.get('.ag-vernier-mini').textContent;
        api.injectDemoStroke(dir);
        const moved = env.subMap.get('.ag-vernier-mini').textContent !== before ||
          env.subMap.get('.ag-vernier-mini').textContent === (dir === 'UP' ? '+10.0' : '-10.0');
        if (!moved) {
          assert.equal(env.subMap.get('.ag-toast').hidden, false, 'a Demo click with no stroke must explain itself');
          assert.match(env.subMap.get('.ag-toast-text').textContent, /^Demo stroke (rejected by .*veto|was not detected)/);
        }
      }
    }
    await api.destroy();
  } finally {
    env.restore();
  }
});

test('Suite 6l: session warnings clear on disarm; the worklet-crash warning survives its own disarm', async () => {
  const env = createBrowserEnv({ contextSampleRate: 48000 });
  env.install();
  try {
    const api = Lab.mountCell(env.cellEl);
    const arm = env.subMap.get('.ag-arm-btn');
    const toast = env.subMap.get('.ag-toast');
    arm.click();
    await tick();
    env.workletNodes[0].port.onmessage({ data: { type: 'probe', ok: false, snrDb: 1.2 } });
    assert.equal(toast.hidden, false);
    assert.match(env.subMap.get('.ag-toast-text').textContent, /uncoupled/);
    arm.click(); // disarm
    await tick();
    assert.equal(arm.dataset.armed, 'false');
    assert.equal(toast.hidden, true, 'stale "19 kHz uncoupled" warning must clear on disarm');

    arm.click();
    await tick();
    env.workletNodes[env.workletNodes.length - 1].onprocessorerror(new Error('crash'));
    await tick();
    assert.equal(arm.dataset.armed, 'false');
    assert.equal(toast.hidden, false, 'the crash explanation must stay visible');
    assert.match(env.subMap.get('.ag-toast-text').textContent, /halted/);
    await api.destroy();
  } finally {
    env.restore();
  }
});

test('Suite 6m: cancelling a Cal run restores the previous model even without sessionStorage', async () => {
  const env = createBrowserEnv();
  env.install();
  try {
    Object.defineProperty(globalThis, 'sessionStorage', {
      get() { throw new Error('SecurityError: storage disabled'); },
      configurable: true
    });
    const api = Lab.mountCell(env.cellEl);
    const cal = env.subMap.get('.ag-cal-btn');
    cal.click();
    ['UP', 'UP', 'DOWN', 'DOWN'].forEach((d) => api.injectDemoStroke(d));
    assert.equal(cal.dataset.calibrated, 'true');
    const label = cal.textContent;
    cal.click();
    api.injectDemoStroke('UP'); // partial capture of the new run
    cal.click(); // cancel
    assert.equal(cal.dataset.calibrated, 'true');
    assert.equal(cal.textContent, label, 'the pre-run model, not the partial run, is restored');
    assert.ok(env.slotBtns.every((b) => b.dataset.filled === 'true'));
    await api.destroy();
  } finally {
    env.restore();
  }
});

test('Suite 6i: expanding from the micro CTA keeps focus in the cell and Escape returns it to the CTA', async () => {
  const env = createBrowserEnv();
  env.install();
  try {
    const api = Lab.mountCell(env.cellEl);
    const cta = env.subMap.get('.ag-micro-cta');
    const expandBtn = env.subMap.get('.ag-expand-btn');
    cta.isRendered = () => !env.cellEl.classList.contains('is-expanded');
    cta.focus();
    cta.click();
    assert.equal(env.cellEl.classList.contains('is-expanded'), true);
    assert.equal(env.documentMock.activeElement, expandBtn, 'focus moves off the now-hidden CTA');
    env.windowMock.fire('keydown', { key: 'Escape' });
    assert.equal(env.cellEl.classList.contains('is-expanded'), false);
    assert.equal(env.documentMock.activeElement, cta, 'focus returns to the control that opened the workbench');

    cta.click();
    const outside = { parentElement: null };
    env.documentMock.activeElement = outside;
    env.windowMock.fire('pointerdown', { target: outside });
    assert.equal(env.cellEl.classList.contains('is-expanded'), false);
    assert.equal(env.documentMock.activeElement, outside, 'outside-click collapse must not steal focus');
    await api.destroy();
  } finally {
    env.restore();
  }
});

test('Suite 6j: the render loop sleeps after a Demo stroke settles (no idle rAF)', async () => {
  const env = createBrowserEnv();
  env.install();
  try {
    const api = Lab.mountCell(env.cellEl);
    api.injectDemoStroke('UP');
    let frames = 0;
    let ts = 16;
    while (env.getRafCount() > 0 && frames < 600) {
      ts += 16;
      env.stepRaf(ts);
      frames++;
    }
    assert.equal(env.getRafCount(), 0, `render loop still scheduled after ${frames} frames`);
    assert.ok(frames > 5, 'the stroke animates for a while before sleeping');
    await api.destroy();
  } finally {
    env.restore();
  }
});

test('Suite 6k: horizontal wheel leaves the scrubber alone and Copy JSON exports contribs as an array', async () => {
  let copied = null;
  const env = createBrowserEnv({ clipboard: { writeText: async (t) => { copied = t; } } });
  env.install();
  try {
    const api = Lab.mountCell(env.cellEl);
    const well = env.subMap.get('.ag-stage-well');
    let prevented = false;
    well.dispatchEvent('wheel', { deltaX: 40, deltaY: 0, preventDefault() { prevented = true; } });
    assert.equal(env.subMap.get('.ag-vernier-mini').textContent, '+0.0', 'deltaY 0 must not step the scrubber');
    assert.equal(prevented, false, 'horizontal scroll must not be swallowed');
    api.injectDemoStroke('UP');
    env.subMap.get('.ag-export-btn').click();
    await tick();
    const payload = JSON.parse(copied);
    assert.ok(Array.isArray(payload.lastResult.contribs), 'contribs must serialize as an array');
    assert.equal(payload.lastResult.contribs.length, 6);
    await api.destroy();
  } finally {
    env.restore();
  }
});
