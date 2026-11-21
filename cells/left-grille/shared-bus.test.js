const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  BLOCK_SIZE,
  SharedAcousticBus,
  createLeftGrilleLab
} = require('./shared-bus.js');

function makeMockElement(tag, docRef) {
  const listeners = {};
  const attrs = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
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
      if (child && child.id && docRef && docRef._byId) {
        docRef._byId.set(child.id, child);
      }
      if (child && child.children && docRef && docRef._indexSubtree) {
        docRef._indexSubtree(child);
      }
      return child;
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
      this.firstChild = this.children[0] || null;
      return child;
    },
    insertAdjacentElement(_pos, sibling) {
      if (docRef) {
        docRef._secondary = sibling;
        docRef._indexSubtree(sibling);
      }
      return sibling;
    },
    setAttribute(k, v) {
      attrs[k] = String(v);
      if (k === 'id') {
        this.id = String(v);
        if (docRef && docRef._byId) docRef._byId.set(this.id, this);
      }
    },
    getAttribute(k) {
      return attrs[k];
    },
    addEventListener(ev, fn) {
      (listeners[ev] = listeners[ev] || []).push(fn);
    },
    dispatch(ev, payload = {}) {
      (listeners[ev] || []).forEach((fn) =>
        fn(Object.assign({ preventDefault() {} }, payload))
      );
    },
    focus() {
      if (docRef) docRef.activeElement = this;
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, width: 240, height: 90 };
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
  return el;
}

function createMockDomEnv(opts = {}) {
  const docListeners = {};
  const winListeners = {};
  const byId = new Map();
  const loc = { hash: opts.initialHash || '', pathname: '/', search: '', protocol: 'http:' };

  const doc = {
    readyState: 'complete',
    hidden: false,
    activeElement: null,
    _secondary: null,
    _byId: byId,
    _indexSubtree(node) {
      if (!node || typeof node !== 'object') return;
      if (node.id) byId.set(node.id, node);
      if (Array.isArray(node.children)) {
        node.children.forEach((c) => doc._indexSubtree(c));
      }
    },
    createElement: (tag) => makeMockElement(tag, doc),
    createElementNS: (_ns, tag) => makeMockElement(tag, doc),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    querySelector: (sel) => (sel === 'main.grid' ? mainGrid : null),
    getElementById: (id) => byId.get(id) || null,
    addEventListener(ev, fn) {
      (docListeners[ev] = docListeners[ev] || []).push(fn);
    },
    emitDocEvent(ev, payload) {
      (docListeners[ev] || []).forEach((fn) => fn(payload));
    }
  };

  const mainGrid = makeMockElement('main', doc);
  mainGrid.className = 'grid';
  const portalCell = makeMockElement('section', doc);
  portalCell.setAttribute('id', 'cell-left-grille');
  portalCell.className = 'cell cell--left-grille';

  class MockCustomEvent {
    constructor(type, detail) {
      this.type = type;
      this.detail = detail;
    }
  }

  const win = {
    document: doc,
    location: loc,
    devicePixelRatio: 2,
    CustomEvent: MockCustomEvent,
    Event: MockCustomEvent,
    performance: { now: () => Date.now() },
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
        (winListeners.popstate || []).forEach((fn) => fn());
        (winListeners.hashchange || []).forEach((fn) => fn());
      }
    },
    addEventListener(ev, fn) {
      (winListeners[ev] = winListeners[ev] || []).push(fn);
    },
    dispatchEvent(ev) {
      const list = winListeners[ev.type] || [];
      list.forEach((fn) => fn(ev));
      return true;
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  };
  win.window = win;
  win.globalThis = win;

  return { win, doc, mainGrid, portalCell, winListeners };
}

test('Slot registry preserves pre-queued _pending entries, supports immediate & deferred mounting, and isolates mount errors', () => {
  const { win, doc } = createMockDomEnv();

  const mountedCalls = [];
  // Pre-seed _pending BEFORE shared-bus initializes (simulating sibling script executing first)
  const preExistingObj = {
    _pending: [
      [
        2,
        {
          id: 'tap-zones',
          title: 'Chassis Tap Zones',
          mount(cellEl, bus) {
            mountedCalls.push({ slot: 2, id: cellEl.id, hasBus: Boolean(bus) });
          }
        }
      ],
      [
        3,
        {
          id: 'broken-cell',
          title: 'Faulty Cell',
          mount() {
            throw new Error('Synthetic mount failure');
          }
        }
      ]
    ]
  };
  win.LeftGrilleLab = preExistingObj;

  const lab = createLeftGrilleLab(win);
  assert.equal(win.LeftGrilleLab, preExistingObj, 'Must preserve existing LeftGrilleLab reference');
  assert.equal(lab._pending.length, 0, 'Pre-seeded _pending array must drain on init');
  assert.equal(mountedCalls.length, 0, 'Must wait until DOM slot elements exist');

  // Create secondary grid slots 2..7 in DOM and attach
  const slotMap = {};
  for (let s = 2; s <= 7; s++) {
    const el = doc.createElement('section');
    el.setAttribute('id', `lg-sec-cell-${s}`);
    el.className = 'cell';
    slotMap[s] = el;
  }
  lab.attachSecondarySlots(slotMap);

  assert.equal(mountedCalls.length, 1);
  assert.deepEqual(mountedCalls[0], { slot: 2, id: 'lg-sec-cell-2', hasBus: true });
  assert.equal(slotMap[2].getAttribute('aria-label'), 'Chassis Tap Zones');
  assert.equal(slotMap[2].dataset.cellId, 'tap-zones');

  // Registering slot 7 AFTER DOM already has #lg-sec-cell-7 must mount immediately and idempotently
  const dialSpec = {
    id: 'iphone-dial',
    title: 'iPhone Spin Dial',
    mount(cellEl, bus) {
      mountedCalls.push({ slot: 7, id: cellEl.id, hasBus: Boolean(bus) });
    }
  };
  assert.equal(lab.registerCell(7, dialSpec), true);
  assert.equal(mountedCalls.length, 2);
  assert.equal(mountedCalls[1].slot, 7);

  // Re-attaching must NOT double-mount already mounted (spec, el) pairs
  lab.attachSecondarySlots(slotMap);
  assert.equal(mountedCalls.length, 2);

  // Out-of-range slot numbers safely return false
  assert.equal(lab.registerCell(1, dialSpec), false);
  assert.equal(lab.registerCell(10, dialSpec), false);
});

test('subscribeAudio frames arbitrary chunks into 512-sample blocks, sanitizes NaN/Inf, and isolates subscriber buffers', () => {
  const bus = new SharedAcousticBus({ root: {} });
  assert.equal(BLOCK_SIZE, 512);

  const subAPackets = [];
  const subBPackets = [];

  const unsubA = bus.subscribeAudio((pkt) => {
    subAPackets.push({
      len: pkt.samples.length,
      first: pkt.samples[0],
      nanSanitized: pkt.samples[10],
      infSanitized: pkt.samples[11],
      sampleRate: pkt.sampleRate,
      timeSec: pkt.timeSec,
      txMode: pkt.txMode
    });
    // Mutate buffer in place to prove sibling subscriber B is completely unaffected!
    pkt.samples.fill(999);
  });

  bus.subscribeAudio((pkt) => {
    subBPackets.push({
      len: pkt.samples.length,
      first: pkt.samples[0],
      nanSanitized: pkt.samples[10],
      infSanitized: pkt.samples[11],
      timeSec: pkt.timeSec
    });
  });

  // Feed 300 + 300 + 424 = 1024 samples (exact 2 blocks of 512)
  const chunk1 = new Float32Array(300).fill(0.25);
  chunk1[10] = Number.NaN;
  chunk1[11] = Number.POSITIVE_INFINITY;
  const chunk2 = new Float32Array(300).fill(0.25);
  const chunk3 = new Float32Array(424).fill(-0.5);

  bus._deliverAudioSamples(chunk1, 48000);
  assert.equal(subAPackets.length, 0, '300 samples < 512 must stage without premature emit');

  bus._deliverAudioSamples(chunk2, 48000);
  assert.equal(subAPackets.length, 1);
  assert.equal(subBPackets.length, 1);

  bus._deliverAudioSamples(chunk3, 48000);
  assert.equal(subAPackets.length, 2);
  assert.equal(subBPackets.length, 2);

  // Verify NaN/Infinity sanitization and sibling isolation
  assert.equal(subAPackets[0].nanSanitized, 0);
  assert.equal(subAPackets[0].infSanitized, 0);
  assert.equal(subBPackets[0].first, 0.25, 'In-place mutation by subA must not corrupt subB');
  assert.equal(subBPackets[0].nanSanitized, 0);
  assert.equal(subBPackets[0].timeSec, 0);
  assert.ok(Math.abs(subBPackets[1].timeSec - 512 / 48000) < 1e-9);

  // Unsubscribe A -> only B receives block 3
  unsubA();
  bus._deliverAudioSamples(new Float32Array(512).fill(0.125), 48000);
  assert.equal(subAPackets.length, 2);
  assert.equal(subBPackets.length, 3);
});

test('TX stereo generator multiplexer performs smooth 15 ms raised-cosine ramp-in, crossfade, and ramp-out', () => {
  const bus = new SharedAcousticBus({ root: { document: { hidden: false } } });
  const sr = 48000;

  bus.registerTxGenerator('chirp', (leftOut, rightOut, sampleRate, sampleOffset) => {
    assert.equal(sampleRate, sr);
    assert.equal(sampleOffset % 512, 0);
    for (let i = 0; i < leftOut.length; i++) {
      leftOut[i] = 0.5;
      rightOut[i] = -0.25;
    }
  });

  bus.registerTxGenerator('lid-ping', (leftOut, rightOut) => {
    for (let i = 0; i < leftOut.length; i++) {
      leftOut[i] = 0.2;
      rightOut[i] = 0.4;
    }
  });

  const outL = new Float32Array(512);
  const outR = new Float32Array(512);

  // 1. Mode 'off' -> strict digital zero
  bus._renderTxBlock(outL, outR, sr);
  assert.ok(outL.every((v) => v === 0));
  assert.ok(outR.every((v) => v === 0));

  // 2. Switch to 'chirp' -> smooth 15 ms (720 samples) raised-cosine ramp-in
  bus.setTxMode('chirp');
  assert.equal(bus.getTxMode(), 'chirp');

  bus._renderTxBlock(outL, outR, sr); // Samples 0..511
  assert.ok(Math.abs(outL[0]) < 1e-4, `Expected near-zero initial sample, got ${outL[0]}`);
  assert.ok(outL[255] > 0.05 && outL[255] < 0.45, 'Mid-ramp sample should be smoothly rising');
  assert.ok(outR[255] < -0.02 && outR[255] > -0.24, 'Independent right stereo channel ramps negatively');

  bus._renderTxBlock(outL, outR, sr); // Samples 512..1023 (reaches steady state at sample 720)
  assert.ok(Math.abs(outL[511] - 0.5) < 1e-6, 'Must reach exact steady-state Left gain after 15 ms');
  assert.ok(Math.abs(outR[511] - -0.25) < 1e-6, 'Must reach exact steady-state Right gain after 15 ms');

  // 3. Crossfade 'chirp' (0.5, -0.25) -> 'lid-ping' (0.2, +0.4) with zero step discontinuity
  const prevEndL = outL[511];
  const prevEndR = outR[511];
  bus.setTxMode('lid-ping');
  bus._renderTxBlock(outL, outR, sr); // Block 1 of crossfade
  assert.ok(Math.abs(outL[0] - prevEndL) < 1e-3, 'Crossfade start Left must be continuous');
  assert.ok(Math.abs(outR[0] - prevEndR) < 1e-3, 'Crossfade start Right must be continuous');
  bus._renderTxBlock(outL, outR, sr); // Block 2 completes 15 ms crossfade
  assert.ok(Math.abs(outL[511] - 0.2) < 1e-6);
  assert.ok(Math.abs(outR[511] - 0.4) < 1e-6);

  // 4. Ramp-out 'lid-ping' -> 'off' decays smoothly to exact digital silence
  bus.setTxMode('off');
  bus._renderTxBlock(outL, outR, sr);
  assert.ok(outL[0] > 0.19, 'Ramp-out starts smoothly from prior level');
  bus._renderTxBlock(outL, outR, sr);
  assert.equal(outL[511], 0, 'Must reach exact 0.0 after 15 ms ramp-out');
  assert.equal(outR[511], 0);
});

test('TX safety gates strictly force digital silence when sampleRate < 40000 or document.hidden is true', () => {
  const mockDoc = { hidden: false };
  const bus = new SharedAcousticBus({ root: { document: mockDoc } });

  bus.registerTxGenerator('chirp', (leftOut, rightOut) => {
    leftOut.fill(0.6);
    rightOut.fill(0.6);
  });
  bus.setTxMode('chirp');

  const outL = new Float32Array(512);
  const outR = new Float32Array(512);

  // 16 kHz Bluetooth HFP rate -> must emit strict zero across all samples
  bus._renderTxBlock(outL, outR, 16000);
  assert.ok(outL.every((v) => v === 0), 'sampleRate < 40000 must force strict Left silence');
  assert.ok(outR.every((v) => v === 0), 'sampleRate < 40000 must force strict Right silence');

  // 48 kHz visible -> emits ultrasonic output
  bus._renderTxBlock(outL, outR, 48000);
  bus._renderTxBlock(outL, outR, 48000);
  assert.ok(Math.abs(outL[511] - 0.6) < 1e-6);

  // Hidden tab -> immediately forces strict digital zero
  mockDoc.hidden = true;
  bus._renderTxBlock(outL, outR, 48000);
  assert.ok(outL.every((v) => v === 0), 'document.hidden = true must force strict silence');
  assert.ok(outR.every((v) => v === 0));

  // Tab visible again -> ramps smoothly back from 0 without click
  mockDoc.hidden = false;
  bus._renderTxBlock(outL, outR, 48000);
  assert.ok(outL[0] < 1e-3 && outL[511] > 0.2);
});

test('requestArm auto-pins built-in MacBook mic/speakers, avoids NotAllowedError re-prompt, and isolates sessionEpoch aborts', async () => {
  // 1. Single-prompt NotAllowedError check
  let gumPrompts = 0;
  const states1 = [];
  const deniedBus = new SharedAcousticBus({
    root: {
      navigator: {
        mediaDevices: {
          getUserMedia: async () => {
            gumPrompts++;
            const err = new Error('Denied');
            err.name = 'NotAllowedError';
            throw err;
          }
        }
      }
    }
  });
  deniedBus.onStateChange((st) => states1.push(st.state));
  assert.equal(states1[0], 'idle', 'onStateChange must immediately emit initial state');

  const okDenied = await deniedBus.requestArm('chirp');
  assert.equal(okDenied, false);
  assert.equal(gumPrompts, 1, 'Must never double-prompt on NotAllowedError');
  assert.equal(deniedBus.state, 'error');

  // 2. Built-in MacBook device upgrade + setSinkId + sessionEpoch mid-prompt abort race safety
  let gumCall = 0;
  let resolveSlowFirstGum;
  let stoppedAirpods = 0;
  let stoppedBuiltIn = 0;
  let stoppedAborted = 0;
  let sinkAssigned = null;
  const constraintsSeen = [];

  class MockAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'suspended';
      this.destination = { maxChannelCount: 2 };
    }
    async resume() {
      this.state = 'running';
    }
    async setSinkId(id) {
      sinkAssigned = id;
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createScriptProcessor() {
      return { connect() {}, disconnect() {}, onaudioprocess: null };
    }
    async close() {
      this.state = 'closed';
    }
  }

  const closeEvents = [];
  const envRoot = {
    AudioContext: MockAudioContext,
    CustomEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    dispatchEvent(ev) {
      closeEvents.push(ev.type);
    },
    navigator: {
      mediaDevices: {
        getUserMedia: (c) => {
          gumCall++;
          constraintsSeen.push(c);
          if (gumCall === 1) {
            return new Promise((res) => {
              resolveSlowFirstGum = () =>
                res({
                  getTracks: () => [{ stop: () => stoppedAborted++ }],
                  getAudioTracks: () => [{ label: 'MacBook Pro Microphone', stop: () => stoppedAborted++ }]
                });
            });
          }
          if (gumCall === 2) {
            // Initial stream in session #2 defaults to AirPods -> should upgrade to built-in MacBook mic!
            return Promise.resolve({
              getTracks: () => [{ stop: () => stoppedAirpods++ }],
              getAudioTracks: () => [{ label: 'AirPods Pro', stop: () => stoppedAirpods++ }]
            });
          }
          return Promise.resolve({
            getTracks: () => [{ stop: () => stoppedBuiltIn++ }],
            getAudioTracks: () => [{ label: 'MacBook Pro Microphone', stop: () => stoppedBuiltIn++ }]
          });
        },
        enumerateDevices: async () => [
          { kind: 'audioinput', deviceId: 'airpods-in', label: 'AirPods Pro' },
          { kind: 'audioinput', deviceId: 'mbp-mic-id', label: 'MacBook Pro Microphone' },
          { kind: 'audiooutput', deviceId: 'mbp-spk-id', label: 'MacBook Pro Speakers' }
        ]
      }
    }
  };

  const bus = new SharedAcousticBus({ root: envRoot });

  // Start session #1, then immediately abort via stopAll() while getUserMedia #1 is pending
  const pArm1 = bus.requestArm('chirp');
  await bus.stopAll();
  assert.equal(closeEvents.length, 1);
  assert.equal(closeEvents[0], 'lg-secondary-close');

  // Start session #2 — upgrades AirPods -> MacBook Pro Microphone + MacBook Pro Speakers
  const ok2 = await bus.requestArm('lid-ping');
  assert.equal(ok2, true);
  assert.equal(bus.state, 'listening');
  assert.equal(bus.getTxMode(), 'lid-ping');
  assert.equal(bus.micLabel, 'MacBook Pro Microphone');
  assert.equal(sinkAssigned, 'mbp-spk-id');
  assert.equal(stoppedAirpods, 1, 'Replaced AirPods stream must be stopped immediately');
  assert.equal(constraintsSeen[1].audio.echoCancellation, false);
  assert.equal(constraintsSeen[1].audio.noiseSuppression, false);
  assert.equal(constraintsSeen[1].audio.autoGainControl, false);

  // Now resolve stale getUserMedia #1 -> must dispose ONLY aborted stream #1 without touching live session #2!
  resolveSlowFirstGum();
  assert.equal(await pArm1, false);
  assert.equal(stoppedAborted, 1);
  assert.equal(stoppedBuiltIn, 0, 'Active session #2 built-in stream must remain alive');
  assert.equal(bus.state, 'listening');

  await bus.stopAll({ immediate: true });
  assert.equal(bus.state, 'idle');
  assert.equal(stoppedBuiltIn, 1);
  assert.equal(closeEvents.length, 2);
});

test('AudioWorkletNode full-duplex fallback accumulates 4x128 RX quanta into 512-sample blocks and renders TX', async () => {
  let WorkletProcessorCls = null;
  let lastCreatedNode = null;

  class MockAudioWorkletProcessor {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (msg) => {
          if (lastCreatedNode && lastCreatedNode.port.onmessage) {
            lastCreatedNode.port.onmessage({ data: msg });
          }
        }
      };
    }
  }

  class MockWorkletNode {
    constructor(_ctx, name) {
      assert.equal(name, 'lg-shared-acoustic-bus-processor');
      lastCreatedNode = this;
      this.proc = null;
      this.port = {
        onmessage: null,
        postMessage: (msg) => {
          if (this.proc && this.proc.port.onmessage) {
            this.proc.port.onmessage({ data: msg });
          }
        }
      };
      this.proc = new WorkletProcessorCls();
    }
    connect() {}
    disconnect() {}
  }

  const blobSources = new Map();
  const origBlob = globalThis.Blob;
  const origURL = globalThis.URL;

  try {
    globalThis.Blob = class MockBlob {
      constructor(parts) {
        this.code = parts.join('');
      }
    };
    globalThis.URL = {
      createObjectURL(blob) {
        const u = 'blob:mock-shared-bus';
        blobSources.set(u, blob.code);
        return u;
      },
      revokeObjectURL(u) {
        blobSources.delete(u);
      }
    };

    const workletRoot = {
      AudioWorkletNode: MockWorkletNode,
      AudioContext: class {
        constructor() {
          this.sampleRate = 48000;
          this.state = 'running';
          this.destination = { maxChannelCount: 2 };
          this.audioWorklet = {
            async addModule(url) {
              const code = blobSources.get(url);
              vm.runInNewContext(code, {
                AudioWorkletProcessor: MockAudioWorkletProcessor,
                registerProcessor: (_n, cls) => {
                  WorkletProcessorCls = cls;
                },
                Float32Array,
                Number
              });
            }
          };
        }
        createMediaStreamSource() {
          return { connect() {}, disconnect() {} };
        }
        // Intentionally omit createScriptProcessor to exercise AudioWorkletNode path!
        async close() {
          this.state = 'closed';
        }
      },
      navigator: {
        mediaDevices: {
          getUserMedia: async () => ({
            getTracks: () => [{ stop() {} }],
            getAudioTracks: () => [{ label: 'Built-in Microphone', stop() {} }]
          }),
          enumerateDevices: async () => []
        }
      }
    };

    const bus = new SharedAcousticBus({ root: workletRoot });
    bus.registerTxGenerator('chirp', (l, r) => {
      l.fill(0.4);
      r.fill(-0.4);
    });

    const rxBlocks = [];
    bus.subscribeAudio((pkt) => rxBlocks.push(pkt));

    const ok = await bus.requestArm('chirp', { preferWorklet: true });
    assert.equal(ok, true);
    assert.equal(blobSources.size, 0, 'Blob URL must be revoked in finally block');

    const in128 = new Float32Array(128).fill(0.125);
    const outL = new Float32Array(128);
    const outR = new Float32Array(128);

    for (let q = 0; q < 4; q++) {
      lastCreatedNode.proc.process([[in128]], [[outL, outR]]);
    }
    assert.equal(rxBlocks.length, 1, '4 x 128 quanta must emit exact 1 x 512-sample block');
    assert.equal(rxBlocks[0].samples.length, 512);
    assert.ok(outL.some((v) => v > 0), 'Worklet must output ramped Left TX samples');
    assert.ok(outR.some((v) => v < 0), 'Worklet must output ramped Right TX samples');

    await bus.stopAll({ immediate: true });
  } finally {
    globalThis.Blob = origBlob;
    globalThis.URL = origURL;
  }
});

test('UI + SharedAcousticBus integration: #lg-sec-cell-2..9, [ARM ARRAY] nav button, Cell 1 mutual exclusion, and close teardown', async () => {
  const { win, doc, portalCell } = createMockDomEnv();

  let activeStreams = 0;
  let closeEventCount = 0;
  win.addEventListener('lg-secondary-close', () => {
    closeEventCount++;
  });

  win.AudioContext = class MockCtx {
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

  win.navigator = {
    mediaDevices: {
      getUserMedia: async () => {
        activeStreams++;
        let stopped = false;
        const stop = () => {
          if (!stopped) {
            stopped = true;
            activeStreams--;
          }
        };
        return {
          getTracks: () => [{ stop }],
          getAudioTracks: () => [{ label: 'MacBook Pro Microphone', stop }]
        };
      },
      enumerateDevices: async () => []
    }
  };

  const engineCode = fs.readFileSync(path.join(__dirname, 'acoustic-engine.js'), 'utf8');
  const controllerCode = fs.readFileSync(path.join(__dirname, 'acoustic-controller.js'), 'utf8');
  const sharedBusCode = fs.readFileSync(path.join(__dirname, 'shared-bus.js'), 'utf8');
  const uiCode = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');

  // Execute all scripts inside the same browser window VM (matching <script defer> in index.html)
  vm.runInNewContext(engineCode, win);
  vm.runInNewContext(controllerCode, win);
  vm.runInNewContext(sharedBusCode, win);
  let mountedSlot4El = null;
  win.LeftGrilleLab.registerCell(4, {
    id: 'chirp-sonar',
    title: '18–20kHz Chirp Sonar',
    mount(cellEl, bus) {
      mountedSlot4El = cellEl;
      bus.registerTxGenerator('chirp', (l, r) => {
        l.fill(0.1);
        r.fill(0.1);
      });
    }
  });
  vm.runInNewContext(uiCode, win);

  // 1. Verify #lg-sec-cell-1 .. #lg-sec-cell-9 exist with exact .cell class
  for (let slot = 1; slot <= 9; slot++) {
    const cell = doc.getElementById(`lg-sec-cell-${slot}`);
    assert.ok(cell, `Expected #lg-sec-cell-${slot} in DOM`);
    assert.ok(cell.className.split(/\s+/).includes('cell'), `#lg-sec-cell-${slot} must keep .cell class`);
  }
  assert.equal(mountedSlot4El, doc.getElementById('lg-sec-cell-4'));

  // Open secondary view
  portalCell.children[0].dispatch('click');

  const armArrayBtn = doc.getElementById('lg-arm-array-btn');
  assert.ok(armArrayBtn, 'Expected #lg-arm-array-btn in .lg-nav-bar');
  assert.equal(armArrayBtn.dataset.armed, 'false');

  // 2. Click [ARM ARRAY] -> arms bus in 'chirp' mode (powering passive cells 2,3,5 + active 4,6)
  armArrayBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(win.LeftGrilleLab.bus.state, 'listening');
  assert.equal(win.LeftGrilleLab.bus.getTxMode(), 'chirp');
  assert.equal(armArrayBtn.dataset.armed, 'true');
  assert.equal(activeStreams, 1);

  // 3. Arming Cell 1 standalone mic must automatically disarm bus first (only 1 stream open, no close event!)
  const secCell1 = doc.getElementById('lg-sec-cell-1');
  const cell1ArmBtn = secCell1.children[0].children[0].children[0].children[0];
  cell1ArmBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(win.LeftGrilleLab.bus.state, 'idle', 'Cell 1 arming must stop shared bus');
  assert.equal(cell1ArmBtn.dataset.armed, 'true', 'Cell 1 controller must now be listening');
  assert.equal(activeStreams, 1, 'Must hold at most 1 open hardware mic stream');
  assert.equal(closeEventCount, 0, 'Switching between Cell 1 and bus must not fire lg-secondary-close');

  // 4. Arming bus from a secondary cell (bus.requestArm()) must automatically stop Cell 1 standalone mic!
  await win.LeftGrilleLab.bus.requestArm('chirp');
  assert.equal(win.LeftGrilleLab.bus.state, 'listening');
  assert.equal(cell1ArmBtn.dataset.armed, 'false', 'Bus arming must stop Cell 1 controller');
  assert.equal(activeStreams, 1);

  // 5. Closing secondary view via Back button calls bus.stopAll() and dispatches lg-secondary-close!
  const backBtn = doc._secondary.children[0].children[0].children[0];
  backBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(win.LeftGrilleLab.bus.state, 'idle');
  assert.equal(activeStreams, 0, 'All mic streams must stop when secondary view closes');
  assert.ok(closeEventCount >= 1, 'Closing secondary view must dispatch lg-secondary-close');
});

test('Reverse script-order resilience: sibling _pending + ui.js running BEFORE shared-bus.js still mounts & wires bus', () => {
  const { win, doc } = createMockDomEnv();

  const engineCode = fs.readFileSync(path.join(__dirname, 'acoustic-engine.js'), 'utf8');
  const controllerCode = fs.readFileSync(path.join(__dirname, 'acoustic-controller.js'), 'utf8');
  const sharedBusCode = fs.readFileSync(path.join(__dirname, 'shared-bus.js'), 'utf8');
  const uiCode = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');

  // 1. Sibling cell registers into _pending BEFORE ui.js or shared-bus.js
  let mounted5 = null;
  win.LeftGrilleLab = {
    _pending: [
      [
        5,
        {
          id: 'breath-puff',
          title: 'Grille Breath Puff',
          mount(cellEl, bus) {
            mounted5 = { id: cellEl.id, hasBus: Boolean(bus) };
          }
        }
      ]
    ]
  };

  // 2. ui.js runs BEFORE shared-bus.js
  vm.runInNewContext(engineCode, win);
  vm.runInNewContext(controllerCode, win);
  vm.runInNewContext(uiCode, win);
  assert.equal(mounted5, null);

  // 3. shared-bus.js loads last -> drains _pending, attaches #lg-sec-cell-2..9, and invokes _onReady
  vm.runInNewContext(sharedBusCode, win);
  assert.deepEqual(mounted5, { id: 'lg-sec-cell-5', hasBus: true });
  assert.equal(doc.getElementById('lg-sec-cell-5').getAttribute('aria-label'), 'Grille Breath Puff');
});

test('Regression #6A: stopAll() -> requestArm("lid-ping") within 20 ms ScriptProcessor fade never invokes new TX mode on dying context', async () => {
  const contexts = [];
  class MockFadeAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = { maxChannelCount: 2 };
      this.scriptNode = null;
      contexts.push(this);
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createScriptProcessor() {
      const node = { connect() {}, disconnect() {}, onaudioprocess: null };
      this.scriptNode = node;
      return node;
    }
    async close() {
      this.state = 'closed';
    }
  }

  const bus = new SharedAcousticBus({
    root: {
      document: { hidden: false },
      AudioContext: MockFadeAudioContext,
      navigator: {
        mediaDevices: {
          getUserMedia: async () => ({
            getTracks: () => [{ stop() {} }],
            getAudioTracks: () => [{ label: 'Built-in Microphone', stop() {} }]
          }),
          enumerateDevices: async () => []
        }
      }
    }
  });

  let chirpCalls = 0;
  let lidPingCalls = 0;
  const lidPingOffsets = [];

  bus.registerTxGenerator('chirp', (l, r, _sr, sampleOffset) => {
    assert.equal(sampleOffset % BLOCK_SIZE, 0);
    chirpCalls++;
    l.fill(0.5);
    r.fill(-0.5);
  });

  bus.registerTxGenerator('lid-ping', (l, r, _sr, sampleOffset) => {
    lidPingCalls++;
    lidPingOffsets.push(sampleOffset);
    l.fill(0.35);
    r.fill(0.35);
  });

  function makeAudioProcessEvent() {
    const outL = new Float32Array(BLOCK_SIZE);
    const outR = new Float32Array(BLOCK_SIZE);
    const inCh = new Float32Array(BLOCK_SIZE);
    return {
      outL,
      outR,
      ev: {
        outputBuffer: {
          numberOfChannels: 2,
          getChannelData: (ch) => (ch === 0 ? outL : outR)
        },
        inputBuffer: {
          getChannelData: () => inCh
        }
      }
    };
  }

  assert.equal(await bus.requestArm('chirp'), true);
  assert.equal(contexts.length, 1);
  const dyingCtx = contexts[0];

  // Pump 2 blocks on session #1 so 'chirp' reaches full steady-state phase (1.0)
  dyingCtx.scriptNode.onaudioprocess(makeAudioProcessEvent().ev);
  dyingCtx.scriptNode.onaudioprocess(makeAudioProcessEvent().ev);
  assert.equal(chirpCalls, 2);

  // Initiate 20 ms ScriptProcessor fade-out WITHOUT awaiting completion yet
  const stopPromise = bus.stopAll({ dispatchClose: false });
  const chirpCallsAfterSnapshot = chirpCalls;

  // Immediately re-arm with 'lid-ping' inside the 20 ms window!
  const okRearm = await bus.requestArm('lid-ping');
  assert.equal(okRearm, true);
  assert.equal(contexts.length, 2);
  const liveCtx = contexts[1];
  assert.equal(bus.getTxMode(), 'lid-ping');
  assert.equal(lidPingCalls, 0);

  // Fire callbacks on the DYING ScriptProcessorNode during the 20 ms ramp-down window
  const fade1 = makeAudioProcessEvent();
  dyingCtx.scriptNode.onaudioprocess(fade1.ev);
  const fade2 = makeAudioProcessEvent();
  dyingCtx.scriptNode.onaudioprocess(fade2.ev);

  assert.equal(lidPingCalls, 0, 'Dying context must NEVER invoke newly armed lid-ping generator');
  assert.equal(
    chirpCalls,
    chirpCallsAfterSnapshot,
    'Dying context must drain pre-snapshotted fade samples without re-calling generators'
  );
  assert.equal(bus._txSampleOffset, 0, 'Dying context must never advance live _txSampleOffset');
  assert.equal(bus._activeTxPhase, 0, 'Dying context must never advance live _activeTxPhase');
  assert.ok(fade1.outL[0] > 0.4, 'Dying context must smoothly ramp down prior chirp Left');
  assert.ok(fade1.outR[0] < -0.4, 'Dying context must smoothly ramp down prior negative chirp Right');
  assert.equal(fade2.outL[511], 0, 'Dying context fade must reach exact digital zero within 2 blocks');
  assert.equal(fade2.outR[511], 0);

  // Live context starts 'lid-ping' cleanly from sampleOffset === 0
  const live1 = makeAudioProcessEvent();
  liveCtx.scriptNode.onaudioprocess(live1.ev);
  assert.equal(lidPingCalls, 1);
  assert.equal(lidPingOffsets[0], 0);
  assert.ok(live1.outR[255] > 0, 'Live context emits positive lid-ping Right channel');

  await stopPromise;
  assert.equal(dyingCtx.state, 'closed');
  assert.equal(liveCtx.state, 'running');
  await bus.stopAll({ immediate: true, dispatchClose: false });
});

test('Regression #6B: NotAllowedError during requestArm("lid-ping") resets getTxMode() === "off" before passive re-arm', async () => {
  let attempt = 0;
  let activeNode = null;

  class MockCtx {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = { maxChannelCount: 2 };
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    createScriptProcessor() {
      activeNode = { connect() {}, disconnect() {}, onaudioprocess: null };
      return activeNode;
    }
    async close() {
      this.state = 'closed';
    }
  }

  const bus = new SharedAcousticBus({
    root: {
      document: { hidden: false },
      AudioContext: MockCtx,
      navigator: {
        mediaDevices: {
          getUserMedia: async () => {
            attempt++;
            if (attempt === 1) {
              const err = new Error('Permission denied');
              err.name = 'NotAllowedError';
              throw err;
            }
            return {
              getTracks: () => [{ stop() {} }],
              getAudioTracks: () => [{ label: 'Built-in Microphone', stop() {} }]
            };
          },
          enumerateDevices: async () => []
        }
      }
    }
  });

  let lidPingCalls = 0;
  bus.registerTxGenerator('lid-ping', (l, r) => {
    lidPingCalls++;
    l.fill(0.4);
    r.fill(0.4);
  });

  const snapshots = [];
  bus.onStateChange((snap) => snapshots.push(snap));

  // 1. Active arm fails with NotAllowedError -> txMode must reset to 'off'
  const ok1 = await bus.requestArm('lid-ping');
  assert.equal(ok1, false);
  assert.equal(bus.state, 'error');
  assert.equal(bus.getTxMode(), 'off', 'Failed requestArm must reset _txMode to "off"');
  assert.equal(snapshots[snapshots.length - 1].txMode, 'off');

  // 2. Subsequent passive requestArm() (no preferredTxMode) must stay passive ('off')
  const ok2 = await bus.requestArm();
  assert.equal(ok2, true);
  assert.equal(bus.state, 'listening');
  assert.equal(bus.getTxMode(), 'off');

  const outL = new Float32Array(BLOCK_SIZE);
  const outR = new Float32Array(BLOCK_SIZE);
  activeNode.onaudioprocess({
    outputBuffer: {
      numberOfChannels: 2,
      getChannelData: (ch) => (ch === 0 ? outL : outR)
    },
    inputBuffer: {
      getChannelData: () => new Float32Array(BLOCK_SIZE)
    }
  });
  assert.equal(lidPingCalls, 0, 'Passive arm after failed active arm must not transmit lid-ping');
  assert.ok(outL.every((v) => v === 0));
  assert.ok(outR.every((v) => v === 0));

  await bus.stopAll({ immediate: true, dispatchClose: false });
});

test('Regression #6C: setHiddenMuted(true) immediately flushes pre-queued AudioWorklet TX blocks to strict 0', async () => {
  let WorkletProcessorCls = null;
  let lastCreatedNode = null;

  class MockAudioWorkletProcessor {
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (msg) => {
          if (lastCreatedNode && lastCreatedNode.port.onmessage) {
            lastCreatedNode.port.onmessage({ data: msg });
          }
        }
      };
    }
  }

  class MockWorkletNode {
    constructor(_ctx, name) {
      assert.equal(name, 'lg-shared-acoustic-bus-processor');
      lastCreatedNode = this;
      this.proc = null;
      this.port = {
        onmessage: null,
        postMessage: (msg) => {
          if (this.proc && this.proc.port.onmessage) {
            this.proc.port.onmessage({ data: msg });
          }
        }
      };
      this.proc = new WorkletProcessorCls();
    }
    connect() {}
    disconnect() {}
  }

  const blobSources = new Map();
  const origBlob = globalThis.Blob;
  const origURL = globalThis.URL;

  try {
    globalThis.Blob = class MockBlob {
      constructor(parts) {
        this.code = parts.join('');
      }
    };
    globalThis.URL = {
      createObjectURL(blob) {
        const u = 'blob:mock-shared-bus-flush';
        blobSources.set(u, blob.code);
        return u;
      },
      revokeObjectURL(u) {
        blobSources.delete(u);
      }
    };

    const mockDoc = { hidden: false };
    const workletRoot = {
      document: mockDoc,
      AudioWorkletNode: MockWorkletNode,
      AudioContext: class {
        constructor() {
          this.sampleRate = 48000;
          this.state = 'running';
          this.destination = { maxChannelCount: 2 };
          this.audioWorklet = {
            async addModule(url) {
              const code = blobSources.get(url);
              vm.runInNewContext(code, {
                AudioWorkletProcessor: MockAudioWorkletProcessor,
                registerProcessor: (_n, cls) => {
                  WorkletProcessorCls = cls;
                },
                Float32Array,
                Number
              });
            }
          };
        }
        createMediaStreamSource() {
          return { connect() {}, disconnect() {} };
        }
        async close() {
          this.state = 'closed';
        }
      },
      navigator: {
        mediaDevices: {
          getUserMedia: async () => ({
            getTracks: () => [{ stop() {} }],
            getAudioTracks: () => [{ label: 'Built-in Microphone', stop() {} }]
          }),
          enumerateDevices: async () => []
        }
      }
    };

    const bus = new SharedAcousticBus({ root: workletRoot });
    bus.registerTxGenerator('chirp', (l, r) => {
      l.fill(0.5);
      r.fill(-0.5);
    });

    assert.equal(await bus.requestArm('chirp', { preferWorklet: true }), true);
    assert.equal(lastCreatedNode.proc.txQueue.length, 3, '3 TX blocks pre-queued on start');

    const in128 = new Float32Array(128).fill(0.05);
    const outL = new Float32Array(128);
    const outR = new Float32Array(128);

    // Process 1 visible quantum -> consumes part of block 1, leaving curTx + 2 queued blocks
    lastCreatedNode.proc.process([[in128]], [[outL, outR]]);
    assert.ok(outL.some((v) => v > 0), 'Visible quantum emits ultrasonic samples');
    assert.equal(lastCreatedNode.proc.txQueue.length, 2);
    assert.ok(lastCreatedNode.proc.curTx !== null);

    // Hide tab -> must immediately flush queued worklet TX blocks so ZERO non-zero samples leak
    mockDoc.hidden = true;
    bus.setHiddenMuted(true);
    assert.equal(lastCreatedNode.proc.txQueue.length, 0);
    assert.equal(lastCreatedNode.proc.curTx, null);

    for (let q = 0; q < 8; q++) {
      outL.fill(1);
      outR.fill(-1);
      lastCreatedNode.proc.process([[in128]], [[outL, outR]]);
      assert.ok(outL.every((v) => v === 0), `Quantum ${q} Left must be strict 0 after hide`);
      assert.ok(outR.every((v) => v === 0), `Quantum ${q} Right must be strict 0 after hide`);
    }

    // Unhide tab -> smoothly ramps back in from 0
    mockDoc.hidden = false;
    bus.setHiddenMuted(false);
    lastCreatedNode.proc.process([[in128]], [[outL, outR]]);
    assert.ok(Math.abs(outL[0]) < 1e-3 && outL[127] > 0.01, 'Smoothly ramps back in after unhide');

    await bus.stopAll({ immediate: true, dispatchClose: false });
  } finally {
    globalThis.Blob = origBlob;
    globalThis.URL = origURL;
  }
});

test('UI lifecycle & Escape guard: lg-secondary-open event, LeftGrilleLab.isSecondaryOpen(), and defaultPrevented Escape', () => {
  const { win, doc, portalCell } = createMockDomEnv();

  const engineCode = fs.readFileSync(path.join(__dirname, 'acoustic-engine.js'), 'utf8');
  const controllerCode = fs.readFileSync(path.join(__dirname, 'acoustic-controller.js'), 'utf8');
  const sharedBusCode = fs.readFileSync(path.join(__dirname, 'shared-bus.js'), 'utf8');
  const uiCode = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');

  vm.runInNewContext(engineCode, win);
  vm.runInNewContext(controllerCode, win);
  vm.runInNewContext(sharedBusCode, win);
  vm.runInNewContext(uiCode, win);

  assert.equal(typeof win.LeftGrilleLab.isSecondaryOpen, 'function');
  assert.equal(win.LeftGrilleLab.isSecondaryOpen(), false);

  const openSnapshots = [];
  win.addEventListener('lg-secondary-open', () => {
    openSnapshots.push({
      isOpen: win.LeftGrilleLab.isSecondaryOpen(),
      pageHidden: doc.getElementById('left-grille-page').hidden
    });
  });

  // 1. First open via portal tap (history.pushState)
  portalCell.children[0].dispatch('click');
  assert.equal(openSnapshots.length, 1);
  assert.deepEqual(openSnapshots[0], { isOpen: true, pageHidden: false });
  assert.equal(win.LeftGrilleLab.isSecondaryOpen(), true);

  // 2. Escape already handled by an in-cell capture-phase popover (defaultPrevented = true) must NOT close secondary page!
  doc.emitDocEvent('keydown', {
    key: 'Escape',
    defaultPrevented: true,
    preventDefault() {}
  });
  assert.equal(win.LeftGrilleLab.isSecondaryOpen(), true);
  assert.equal(doc.getElementById('left-grille-page').hidden, false);

  // 3. Unhandled Escape closes secondary page cleanly
  let prevented = false;
  doc.emitDocEvent('keydown', {
    key: 'Escape',
    defaultPrevented: false,
    preventDefault() {
      prevented = true;
    }
  });
  assert.equal(prevented, true);
  assert.equal(win.LeftGrilleLab.isSecondaryOpen(), false);
  assert.equal(doc.getElementById('left-grille-page').hidden, true);

  // 4. Re-opening via portal tap (history.pushState without hashchange) fires lg-secondary-open again!
  portalCell.children[0].dispatch('click');
  assert.equal(openSnapshots.length, 2);
  assert.deepEqual(openSnapshots[1], { isOpen: true, pageHidden: false });
});
