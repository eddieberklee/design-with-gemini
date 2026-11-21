'use strict';

// Node tests for cells/prosody. client.js and ui.js are classic IIFEs on `window`, so they are
// loaded into a vm sandbox (same pattern as cells/api-matrix/probes.test.js) with a minimal fake
// DOM, fake storage, fake WebSocket, fake AudioContext and fake getUserMedia. Nothing here opens a
// real socket or touches a microphone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT_SRC = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
const UI_SRC = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeStorage(opts) {
  const bag = Object.create(null);
  const throwing = Boolean(opts && opts.throwing);
  return {
    bag: bag,
    getItem(k) {
      if (throwing) throw new Error('SecurityError');
      return Object.prototype.hasOwnProperty.call(bag, k) ? bag[k] : null;
    },
    setItem(k, v) {
      if (throwing) throw new Error('SecurityError');
      bag[k] = String(v);
    },
    removeItem(k) {
      if (throwing) throw new Error('SecurityError');
      delete bag[k];
    }
  };
}

function makeFakeWebSocketClass(registry) {
  function FakeWS(url) {
    this.url = url;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    this.closedByClient = false;
    registry.push(this);
  }
  FakeWS.CONNECTING = 0;
  FakeWS.OPEN = 1;
  FakeWS.CLOSING = 2;
  FakeWS.CLOSED = 3;
  FakeWS.prototype.send = function (payload) {
    this.sent.push(payload);
  };
  FakeWS.prototype.close = function () {
    this.readyState = 3;
    this.closedByClient = true;
  };
  // Test helpers
  FakeWS.prototype.serverOpen = function () {
    this.readyState = 1;
    if (this.onopen) this.onopen({});
  };
  FakeWS.prototype.serverSend = function (data) {
    if (this.onmessage) this.onmessage({ data: data });
  };
  FakeWS.prototype.serverClose = function (code, reason) {
    this.readyState = 3;
    if (this.onclose) this.onclose({ code: code, reason: reason || '' });
  };
  return FakeWS;
}

function makeFakeAudioContextClass(registry) {
  function node(extra) {
    return Object.assign(
      {
        connected: [],
        disconnected: false,
        connect(target) {
          this.connected.push(target);
        },
        disconnect() {
          this.disconnected = true;
        }
      },
      extra || {}
    );
  }
  function FakeAC() {
    this.state = 'running';
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.destination = node();
    this.closed = false;
    this.oscillators = 0;
    this.nodes = [];
    registry.push(this);
  }
  FakeAC.prototype.close = function () {
    this.state = 'closed';
    this.closed = true;
    return Promise.resolve();
  };
  FakeAC.prototype.resume = function () {
    return Promise.resolve();
  };
  FakeAC.prototype.createOscillator = function () {
    this.oscillators += 1;
    return node({
      type: 'sine',
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      start() {},
      stop() {}
    });
  };
  FakeAC.prototype.createGain = function () {
    const n = node({ gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} } });
    this.nodes.push(n);
    return n;
  };
  FakeAC.prototype.createMediaStreamSource = function () {
    const n = node();
    this.nodes.push(n);
    return n;
  };
  FakeAC.prototype.createAnalyser = function () {
    const n = node({ fftSize: 2048, getByteTimeDomainData() {} });
    this.nodes.push(n);
    return n;
  };
  FakeAC.prototype.createScriptProcessor = function () {
    const n = node({ onaudioprocess: null });
    this.nodes.push(n);
    return n;
  };
  return FakeAC;
}

function makeFakeStream() {
  const track = {
    stopped: false,
    onended: null,
    stop() {
      this.stopped = true;
    }
  };
  return {
    track: track,
    getTracks() {
      return [track];
    }
  };
}

// Minimal fake DOM: just what cells/prosody/ui.js touches.
function makeDom(env) {
  function ClassList() {
    const set = new Set();
    return {
      set: set,
      add() {
        for (let i = 0; i < arguments.length; i++) set.add(String(arguments[i]));
      },
      remove() {
        for (let i = 0; i < arguments.length; i++) set.delete(String(arguments[i]));
      },
      toggle(name, force) {
        const on = force === undefined ? !set.has(name) : Boolean(force);
        if (on) set.add(name);
        else set.delete(name);
        return on;
      },
      contains(name) {
        return set.has(name);
      }
    };
  }

  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.style = {};
      this.attrs = Object.create(null);
      this.listeners = Object.create(null);
      this.classList = ClassList();
      this._text = '';
      this.value = '';
      this.type = '';
      this.title = '';
      this.placeholder = '';
      this.autocomplete = '';
      this.scrollLeft = 0;
      this.width = 0;
      this.height = 0;
    }
    get className() {
      return Array.from(this.classList.set).join(' ');
    }
    set className(v) {
      this.classList.set.clear();
      String(v || '')
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => this.classList.set.add(c));
    }
    get firstChild() {
      return this.children[0] || null;
    }
    get textContent() {
      if (this.children.length) return this.children.map((c) => c.textContent).join('');
      return this._text;
    }
    set textContent(v) {
      this.children.forEach((c) => {
        c.parentNode = null;
      });
      this.children = [];
      this._text = String(v);
    }
    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      this.children.push(c);
      return c;
    }
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    }
    getAttribute(k) {
      return k in this.attrs ? this.attrs[k] : null;
    }
    removeAttribute(k) {
      delete this.attrs[k];
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    removeEventListener(type, fn) {
      const arr = this.listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }
    dispatch(type, init) {
      let stopped = false;
      const ev = Object.assign(
        {
          type: type,
          target: this,
          defaultPrevented: false,
          preventDefault() {
            this.defaultPrevented = true;
          },
          stopPropagation() {
            stopped = true;
          }
        },
        init || {}
      );
      let node = this;
      while (node) {
        (node.listeners[type] || []).slice().forEach((fn) => fn.call(node, ev));
        if (stopped || type === 'click') break;
        node = node.parentNode;
      }
      return ev;
    }
    click() {
      this.dispatch('click');
    }
    focus() {
      env.document.activeElement = this;
    }
    matches(cls) {
      return this.classList.contains(cls);
    }
    querySelectorAll(sel) {
      const cls = String(sel).replace(/^\./, '');
      const out = [];
      (function walk(n) {
        n.children.forEach((c) => {
          if (c.classList.contains(cls)) out.push(c);
          walk(c);
        });
      })(this);
      return out;
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    get clientWidth() {
      if (this.classList.contains('ps-stage')) return env.stage.w;
      if (this.classList.contains('ps-wave-canvas')) return 120;
      return 0;
    }
    get clientHeight() {
      if (this.classList.contains('ps-stage')) return env.stage.h;
      if (this.classList.contains('ps-wave-canvas')) return 26;
      return 0;
    }
    get scrollWidth() {
      return 0;
    }
    getContext() {
      return null;
    }
  }

  const docListeners = Object.create(null);
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    hidden: false,
    activeElement: null,
    createElement(tag) {
      return new El(tag);
    },
    getElementById() {
      return null;
    },
    addEventListener(type, fn) {
      (docListeners[type] = docListeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = docListeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    listeners: docListeners,
    fire(type) {
      (docListeners[type] || []).slice().forEach((fn) => fn({ type: type }));
    }
  };
  return { El: El, document: document };
}

function loadEnv(opts) {
  const o = opts || {};
  const env = {
    stage: o.stage || { w: 486, h: 240 },
    padding: o.padding || null,
    sockets: [],
    audioContexts: [],
    streams: [],
    gumCalls: 0
  };
  const dom = makeDom(env);
  env.document = dom.document;
  const winListeners = Object.create(null);

  const sandbox = {
    console: console,
    Buffer: Buffer,
    TextDecoder: TextDecoder,
    Uint8Array: Uint8Array,
    Float32Array: Float32Array,
    ArrayBuffer: ArrayBuffer,
    DataView: DataView,
    Promise: Promise,
    Date: Date,
    Math: Math,
    Number: Number,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    devicePixelRatio: 1,
    document: dom.document,
    sessionStorage: o.sessionStorage || makeStorage(),
    localStorage: o.localStorage || makeStorage(),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    navigator: {},
    addEventListener(type, fn) {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = winListeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatchEvent(ev) {
      (winListeners[ev.type] || []).slice().forEach((fn) => fn(ev));
      return true;
    },
    CustomEvent: function (type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  };
  if (env.padding) {
    sandbox.getComputedStyle = function (node) {
      if (node.classList.contains('ps-stage')) {
        return {
          paddingTop: env.padding[0] + 'px',
          paddingRight: env.padding[1] + 'px',
          paddingBottom: env.padding[2] + 'px',
          paddingLeft: env.padding[3] + 'px'
        };
      }
      return {};
    };
  }
  if (o.resizeObserver) {
    env.observers = [];
    sandbox.ResizeObserver = function (cb) {
      this.cb = cb;
      this.targets = [];
      this.disconnected = false;
      env.observers.push(this);
    };
    sandbox.ResizeObserver.prototype.observe = function (t) {
      this.targets.push(t);
    };
    sandbox.ResizeObserver.prototype.disconnect = function () {
      this.disconnected = true;
    };
  }
  if (o.audio !== false) sandbox.AudioContext = makeFakeAudioContextClass(env.audioContexts);
  if (o.websocket !== false) sandbox.WebSocket = makeFakeWebSocketClass(env.sockets);
  if (o.gum) {
    sandbox.navigator.mediaDevices = {
      getUserMedia() {
        env.gumCalls += 1;
        return o.gum(env);
      }
    };
  }
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  env.win = sandbox;
  env.winListeners = winListeners;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(CLIENT_SRC, ctx, { filename: 'client.js' });
  if (o.ui !== false) vm.runInContext(UI_SRC, ctx, { filename: 'ui.js' });
  env.NS = sandbox.GeminiProsody;
  return env;
}

function mountUi(env) {
  const container = new (env.document.createElement('div').constructor)('section');
  container.className = 'cell cell--prosody';
  const unmount = env.NS.UI.mount(container);
  const q = (sel) => container.querySelector(sel);
  return {
    container: container,
    unmount: unmount,
    q: q,
    chips: () => container.querySelectorAll('.ps-demo-chip'),
    headerButtons: () => q('.ps-header-actions').querySelectorAll('.ps-icon-btn'),
    sfxBtn: () => q('.ps-header-actions').querySelectorAll('.ps-icon-btn')[0],
    resetBtn: () => q('.ps-header-actions').querySelectorAll('.ps-icon-btn')[1],
    metrics: () => q('.ps-metrics-corner').textContent,
    pill: () => q('.ps-delta-pill'),
    ghost: () => q('.ps-ghost-btn'),
    btn: () => q('.ps-target-btn'),
    readout: () => q('.ps-readout-text'),
    marquee: () => q('.ps-marquee-track'),
    badge: () => q('.ps-badge'),
    mic: () => q('.ps-mic-btn'),
    keyPanel: () => q('.ps-key-panel'),
    keyInput: () => q('.ps-key-input'),
    keySave: () => q('.ps-btn-primary'),
    keyButtons: () => q('.ps-key-actions').querySelectorAll('.ps-icon-btn')
  };
}

function domContains(node, needle) {
  const own = [node._text, node.title, node.value].concat(Object.values(node.attrs));
  if (own.some((v) => String(v || '').includes(needle))) return true;
  return node.children.some((c) => domContains(c, needle));
}

function px(v) {
  return Number(String(v).replace('px', ''));
}

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// client.js: resampler + PCM encoder
// ---------------------------------------------------------------------------

test('downsampleTo16k: passthrough, box-average, linear upsample, invalid rates', () => {
  const C = loadEnv({ ui: false }).NS.Client;
  const same = new Float32Array([0.1, 0.2]);
  assert.equal(C.downsampleTo16k(same, 16000), same);

  // 48 kHz -> 16 kHz: every 3 samples averaged.
  const hi = new Float32Array([0, 0.3, 0.6, 1, 1, 1, -1, -1, -1]);
  const down = C.downsampleTo16k(hi, 48000);
  assert.equal(down.length, 3);
  assert.ok(Math.abs(down[0] - 0.3) < 1e-6);
  assert.ok(Math.abs(down[1] - 1) < 1e-6);
  assert.ok(Math.abs(down[2] + 1) < 1e-6);

  // 44.1 kHz chunk of 4096 -> round(4096 / 2.75625) = 1486
  assert.equal(C.downsampleTo16k(new Float32Array(4096), 44100).length, 1486);

  // 8 kHz -> 16 kHz: doubles length, interpolates midpoints, holds last sample.
  const lo = new Float32Array([0, 1, 0]);
  const up = C.downsampleTo16k(lo, 8000);
  assert.equal(up.length, 6);
  assert.deepEqual(Array.from(up), [0, 0.5, 1, 0.5, 0, 0]);

  // Invalid inputs give an empty buffer, never NaN.
  [0, -8000, NaN, Infinity, undefined].forEach((rate) => {
    assert.equal(C.downsampleTo16k(new Float32Array([0.5]), rate).length, 0, 'rate ' + rate);
  });
  assert.equal(C.downsampleTo16k(new Float32Array(0), 48000).length, 0);
  assert.equal(C.downsampleTo16k(null, 48000).length, 0);

  // Non-finite samples become 0 instead of poisoning the average.
  const dirty = C.downsampleTo16k(new Float32Array([NaN, 0.3, 0.3]), 48000);
  assert.ok(Math.abs(dirty[0] - 0.2) < 1e-6);
  const dirtyUp = C.downsampleTo16k(new Float32Array([NaN, 1]), 8000);
  assert.ok(Array.from(dirtyUp).every(Number.isFinite));
});

test('floatTo16BitPCMBase64: clamps and encodes little-endian int16', () => {
  const C = loadEnv({ ui: false }).NS.Client;
  assert.equal(C.floatTo16BitPCMBase64(new Float32Array(0)), '');
  const b64 = C.floatTo16BitPCMBase64(new Float32Array([0, 1, -1, 2, -2, NaN, 0.5]));
  const buf = Buffer.from(b64, 'base64');
  const vals = [];
  for (let i = 0; i < buf.length; i += 2) vals.push(buf.readInt16LE(i));
  assert.deepEqual(vals, [0, 32767, -32768, 32767, -32768, 0, 16383]);
});

// ---------------------------------------------------------------------------
// client.js: Live session protocol with a fake WebSocket
// ---------------------------------------------------------------------------

function openReadySession(env, extraCb) {
  const events = { ready: [], resize: [], errors: [], closes: [], tx: [], server: 0 };
  const cb = Object.assign(
    {
      onReady: (m) => events.ready.push(m),
      onResize: (r) => events.resize.push(r),
      onError: (e) => events.errors.push(e),
      onClose: (r) => events.closes.push(r),
      onTranscript: (t, interim) => events.tx.push([t, interim]),
      onServerEvent: () => {
        events.server += 1;
      }
    },
    extraCb || {}
  );
  const sess = env.NS.Client.createLiveSession('AIza test/key+1', cb);
  const sock = env.sockets[env.sockets.length - 1];
  sock.serverOpen();
  sock.serverSend(JSON.stringify({ setupComplete: {} }));
  return { sess: sess, sock: sock, events: events };
}

test('createLiveSession: setup, key encoding, tool calls over every frame type', async () => {
  const env = loadEnv({ ui: false });
  const { sess, sock, events } = openReadySession(env);
  assert.ok(sock.url.endsWith('?key=' + encodeURIComponent('AIza test/key+1')));
  const setup = JSON.parse(sock.sent[0]).setup;
  assert.equal(setup.model, env.NS.Client.LIVE_MODELS[0]);
  assert.deepEqual(events.ready, [env.NS.Client.LIVE_MODELS[0]]);

  const call = (args, id) =>
    JSON.stringify({ toolCall: { functionCalls: [{ id: id, name: 'adjust_button_size', args: args }] } });

  sock.serverSend(call({ direction: 'smaller', delta_percent: 12, transcript: ' a little smaller ' }, 'a'));
  sock.serverSend({ text: () => Promise.resolve(call({ direction: 'BIGGER', delta_percent: 99 }, 'b')) });
  sock.serverSend(new TextEncoder().encode(call({ direction: 'reset', delta_percent: 30 }, 'c')).buffer);
  sock.serverSend(new TextEncoder().encode(call({}, 'd')));
  sock.serverSend(call({ direction: 'sideways', delta_percent: 'abc' }, 'e'));
  sock.serverSend('null');
  sock.serverSend('not json');
  sock.serverSend(new Uint8Array([0xff, 0xfe, 0x00]));
  await flush();

  const byOrder = events.resize.map((r) => [r.direction, r.delta_percent, r.transcript]);
  assert.deepEqual(byOrder, [
    ['smaller', -12, 'a little smaller'],
    ['reset', 0, ''],
    ['none', 0, ''],
    ['none', 0, ''],
    ['bigger', 40, '']
  ]);
  const responses = sock.sent
    .slice(1)
    .map((s) => JSON.parse(s))
    .filter((m) => m.toolResponse)
    .map((m) => m.toolResponse.functionResponses[0]);
  assert.deepEqual(
    responses.map((r) => [r.id, r.response.output.applied]).sort(),
    [['a', -12], ['b', 40], ['c', 0], ['d', 0], ['e', 0]]
  );
  assert.equal(events.errors.length, 0);

  // Transcription: final wins over interim; serverContent nesting supported.
  sock.serverSend(JSON.stringify({ serverContent: { inputTranscription: { text: 'much bigger' } } }));
  sock.serverSend(JSON.stringify({ interimInputTranscription: { text: 'mu' } }));
  assert.deepEqual(events.tx, [['much bigger', false], ['mu', true]]);

  // Backpressure and close.
  sock.bufferedAmount = 300000;
  assert.equal(sess.sendPCM(new Float32Array(480), 48000), false);
  sock.bufferedAmount = 0;
  assert.equal(sess.sendPCM(new Float32Array(480), 48000), true);
  const audio = JSON.parse(sock.sent[sock.sent.length - 1]).realtimeInput.audio;
  assert.equal(audio.mimeType, 'audio/pcm;rate=16000');
  assert.equal(Buffer.from(audio.data, 'base64').length, 160 * 2);
  sess.close();
  assert.equal(sock.closedByClient, true);
  assert.equal(sock.onmessage, null);
  assert.equal(sess.sendPCM(new Float32Array(480), 48000), false);
});

test('createLiveSession: sendPCM is refused before setupComplete', () => {
  const env = loadEnv({ ui: false });
  const sess = env.NS.Client.createLiveSession('k', {});
  env.sockets[0].serverOpen();
  assert.equal(sess.sendPCM(new Float32Array(480), 48000), false);
  sess.close();
});

test('createLiveSession: falls back to the second model once, then reports and stops', () => {
  const env = loadEnv({ ui: false });
  const errors = [];
  const closes = [];
  env.NS.Client.createLiveSession('k', {
    onError: (e) => errors.push(e),
    onClose: (r) => closes.push(r)
  });
  assert.equal(env.sockets.length, 1);
  env.sockets[0].serverOpen();
  env.sockets[0].serverClose(1008, 'model not found');
  assert.equal(env.sockets.length, 2);
  assert.equal(JSON.parse(env.sockets[0].sent[0]).setup.model, env.NS.Client.LIVE_MODELS[0]);
  env.sockets[1].serverOpen();
  assert.equal(JSON.parse(env.sockets[1].sent[0]).setup.model, env.NS.Client.LIVE_MODELS[1]);
  // A stale event from the first socket must not affect anything.
  if (env.sockets[0].onclose) env.sockets[0].onclose({ code: 1000 });
  env.sockets[1].serverClose(1008, 'API key not valid');
  assert.equal(env.sockets.length, 2, 'no third connection attempt');
  assert.deepEqual(closes, ['API key not valid']);
  // Errors after setup failed on the last model are reported through onClose only.
  assert.equal(errors.length, 0);
});

test('createLiveSession: no WebSocket support reports asynchronously, never throws', async () => {
  const env = loadEnv({ ui: false, websocket: false });
  const seen = [];
  const sess = env.NS.Client.createLiveSession('k', {
    onError: (e) => seen.push('err:' + e),
    onClose: (e) => seen.push('close:' + e)
  });
  assert.deepEqual(seen, []);
  await flush();
  assert.equal(seen.length, 2);
  assert.equal(sess.sendPCM(new Float32Array(10), 48000), false);
});

// ---------------------------------------------------------------------------
// client.js: KeyStore + SoundFX
// ---------------------------------------------------------------------------

test('KeyStore: trims, clears on blank, keeps a memory copy when storage throws', () => {
  const env = loadEnv({ ui: false });
  const KS = env.NS.Client.KeyStore;
  assert.equal(KS.get(), '');
  assert.equal(KS.set('  AIzaKey  '), 'AIzaKey');
  assert.equal(env.win.sessionStorage.bag.dc_gemini_api_key_session, 'AIzaKey');
  assert.equal(KS.getStorageType(), 'session');
  KS.set('AIzaKey', true);
  assert.equal(env.win.localStorage.bag.dc_gemini_api_key_local, 'AIzaKey');
  assert.equal(env.win.sessionStorage.bag.dc_gemini_api_key_session, undefined);
  assert.equal(KS.getStorageType(), 'local');
  KS.set('   ');
  assert.equal(KS.get(), '');
  assert.equal(KS.getStorageType(), 'none');

  const locked = loadEnv({
    ui: false,
    sessionStorage: makeStorage({ throwing: true }),
    localStorage: makeStorage({ throwing: true })
  });
  const LKS = locked.NS.Client.KeyStore;
  assert.equal(LKS.get(), '');
  LKS.set('AIzaMem');
  assert.equal(LKS.get(), 'AIzaMem');
  assert.equal(LKS.isStorageRestricted(), true);
  assert.equal(LKS.getStorageType(), 'memory');
  LKS.clear();
  assert.equal(LKS.get(), '');

  // Storage globals whose getter throws (sandboxed file:// iframes).
  const getterThrows = loadEnv({ ui: false });
  Object.defineProperty(getterThrows.win, 'sessionStorage', {
    get() {
      throw new Error('SecurityError');
    }
  });
  Object.defineProperty(getterThrows.win, 'localStorage', {
    get() {
      throw new Error('SecurityError');
    }
  });
  const GKS = getterThrows.NS.Client.KeyStore;
  assert.equal(GKS.get(), '');
  GKS.set('AIzaX');
  assert.equal(GKS.get(), 'AIzaX');
});

test('SoundFX: no AudioContext until a sound plays; muting closes it and stays silent', () => {
  const env = loadEnv({ ui: false });
  const FX = env.NS.Client.SoundFX;
  assert.equal(env.audioContexts.length, 0);
  FX.playResize('smaller', -12);
  assert.equal(env.audioContexts.length, 1);
  assert.ok(env.audioContexts[0].oscillators > 0);
  assert.equal(FX.toggleMute(), true);
  assert.equal(env.audioContexts[0].closed, true, 'muting releases the audio context');
  FX.playResize('bigger', 26);
  FX.playStreamToggle(true);
  assert.equal(env.audioContexts.length, 1, 'muted: no new context');
  assert.equal(FX.toggleMute(), false);
  FX.playResize('bigger', 26);
  assert.equal(env.audioContexts.length, 2);
});

// ---------------------------------------------------------------------------
// ui.js on the fake DOM
// ---------------------------------------------------------------------------

test('demo chips: each step differs, delta pill shows the applied change, clamps hold', () => {
  const env = loadEnv();
  const ui = mountUi(env);
  assert.equal(ui.metrics(), '100% · 136×44px');
  assert.equal(env.audioContexts.length, 0, 'no AudioContext before a gesture');

  const [small, little, much] = ui.chips();
  small.click();
  assert.equal(ui.metrics(), '88% · 120×39px');
  assert.equal(ui.pill().textContent, '-12%');
  assert.ok(ui.ghost().classList.contains('is-visible'));
  assert.equal(px(ui.ghost().style.width), 136, 'ghost shows the previous size');

  little.click();
  assert.equal(ui.metrics(), '85% · 116×38px');
  assert.equal(ui.pill().textContent, '-3%');
  assert.equal(px(ui.ghost().style.width), 120);

  much.click();
  assert.equal(ui.pill().textContent, '+26%');
  assert.match(ui.metrics(), /^108% · 146×47px$/);
  assert.ok(ui.ghost().classList.contains('is-growing'));

  // Hammer "MUCH bigger": never exceeds 185%, never NaN, last real step reports the applied delta.
  const seenPills = [];
  for (let i = 0; i < 25; i++) {
    much.click();
    seenPills.push(ui.pill().textContent);
    assert.doesNotMatch(ui.metrics(), /NaN/);
  }
  assert.match(ui.metrics(), /^185% · 252×81px$/);
  assert.equal(px(ui.btn().style.width), 252);
  assert.equal(px(ui.btn().style.height), 81);
  // 108% -> 136% -> 171% -> 185% (clamped: +8%, not +26%) -> MAX ...
  assert.deepEqual(seenPills.slice(0, 4), ['+26%', '+26%', '+8%', 'MAX']);
  assert.equal(ui.ghost().classList.contains('is-visible'), false, 'no ghost when nothing changed');
  assert.match(ui.readout().textContent, /max/i);

  for (let i = 0; i < 80; i++) little.click();
  for (let i = 0; i < 20; i++) small.click();
  assert.match(ui.metrics(), /^45% · /);
  assert.equal(ui.pill().textContent, 'MIN');
  assert.match(ui.readout().textContent, /min/i);
  ui.unmount();
});

test('button stays inside the stage box at min and max on a small stage', () => {
  // 1024 px page: stage 309x112, default padding 28/12/34/12.
  const env = loadEnv({ stage: { w: 309, h: 112 }, padding: [28, 12, 34, 12] });
  const ui = mountUi(env);
  const availW = 309 - 24;
  const availH = 112 - 62;
  const sizes = [];
  const [, little, much] = ui.chips();
  for (let i = 0; i < 8; i++) {
    much.click();
    sizes.push(px(ui.btn().style.height));
  }
  assert.ok(px(ui.btn().style.width) <= availW);
  assert.ok(px(ui.btn().style.height) <= availH);
  // Every real step up is visible in pixels (no silent saturation below the clamp).
  const real = sizes.slice(0, 3);
  assert.ok(real[0] < real[1] && real[1] < real[2], 'heights ' + sizes.join(','));
  for (let i = 0; i < 80; i++) little.click();
  assert.ok(px(ui.btn().style.width) <= availW);
  assert.ok(px(ui.btn().style.height) <= availH);
  ui.unmount();

  // 390 px page: stage 175x54 with compact padding 20/6/20/6.
  const tiny = loadEnv({ stage: { w: 175, h: 54 }, padding: [20, 6, 20, 6] });
  const t = mountUi(tiny);
  for (let i = 0; i < 8; i++) t.chips()[2].click();
  assert.ok(px(t.btn().style.width) <= 175 - 12);
  assert.ok(px(t.btn().style.height) <= 54 - 40);
  const m = t.metrics().match(/(\d+)×(\d+)px$/);
  assert.equal(Number(m[1]), px(t.btn().style.width), 'metrics readout matches the real width');
  assert.equal(Number(m[2]), px(t.btn().style.height));
  t.unmount();
});

test('stage resize re-fits the button (ResizeObserver and window resize paths)', () => {
  const env = loadEnv({ stage: { w: 486, h: 240 }, padding: [28, 12, 34, 12], resizeObserver: true });
  const ui = mountUi(env);
  assert.equal(env.observers.length, 1);
  assert.ok(env.observers[0].targets[0].classList.contains('ps-stage'));
  for (let i = 0; i < 4; i++) ui.chips()[2].click();
  assert.equal(ui.metrics(), '185% · 252×81px');
  // Stage shrinks (wide page -> 1024 px page): observer callback re-fits inside the new box.
  env.stage = { w: 309, h: 112 };
  env.observers[0].cb([]);
  assert.ok(px(ui.btn().style.height) <= 112 - 62, ui.metrics());
  assert.match(ui.metrics(), /^185% · (\d+)×(\d+)px$/);
  assert.notEqual(ui.metrics(), '185% · 252×81px');
  // Window resize path (the only one a hidden tab can drive) does the same.
  env.stage = { w: 486, h: 240 };
  env.win.dispatchEvent({ type: 'resize' });
  assert.equal(ui.metrics(), '185% · 252×81px');
  ui.unmount();
  assert.equal(env.observers[0].disconnected, true);
});

test('Reset returns to exactly 100% and clears transcript, ghost and delta', () => {
  const env = loadEnv();
  const ui = mountUi(env);
  ui.chips()[2].click();
  ui.chips()[0].click();
  assert.ok(ui.marquee().querySelectorAll('ps-marquee-word').length > 0);
  ui.resetBtn().click();
  assert.equal(ui.metrics(), '100% · 136×44px');
  assert.equal(ui.ghost().classList.contains('is-visible'), false);
  assert.equal(ui.pill().classList.contains('is-visible'), false);
  assert.equal(ui.pill().textContent, '');
  assert.equal(ui.marquee().querySelectorAll('ps-marquee-word').length, 0);
  assert.ok(ui.marquee().querySelector('ps-marquee-placeholder'));
  assert.equal(ui.readout().textContent, 'Reset to 100% (136×44px).');

  // On a small stage the readout reports the real rendered size, not 136x44.
  const tiny = loadEnv({ stage: { w: 175, h: 54 }, padding: [20, 6, 20, 6] });
  const t = mountUi(tiny);
  t.resetBtn().click();
  const dims = t.metrics().split(' · ')[1];
  assert.equal(t.readout().textContent, 'Reset to 100% (' + dims + ').');
  t.unmount();
  ui.unmount();
});

test('SFX toggle: off means no sound and no new AudioContext', () => {
  const env = loadEnv();
  const ui = mountUi(env);
  assert.equal(ui.sfxBtn().textContent, 'SFX On');
  ui.sfxBtn().click();
  assert.equal(ui.sfxBtn().textContent, 'SFX Off');
  assert.equal(ui.sfxBtn().getAttribute('aria-pressed'), 'false');
  ui.chips()[0].click();
  ui.resetBtn().click();
  assert.equal(env.audioContexts.length, 0);
  ui.sfxBtn().click();
  ui.chips()[0].click();
  assert.equal(env.audioContexts.length, 1);
  ui.unmount();
});

test('key panel: blank and malformed input never clear or store a key', () => {
  const env = loadEnv();
  const ui = mountUi(env);
  const KS = env.NS.Client.KeyStore;
  KS.set('AIzaExisting');
  env.win.dispatchEvent({ type: 'gemini-key-changed' });
  assert.equal(ui.badge().textContent, 'KEY SET');

  ui.badge().click();
  assert.ok(ui.keyPanel().classList.contains('is-open'));
  assert.equal(env.document.activeElement, ui.keyInput());

  ['', '    ', 'AIza abc def', 'AIza\nabc'].forEach((val) => {
    ui.keyInput().value = val;
    ui.keySave().click();
    assert.equal(KS.get(), 'AIzaExisting', 'value ' + JSON.stringify(val));
    assert.ok(ui.keyPanel().classList.contains('is-open'), 'panel stays open for ' + JSON.stringify(val));
    assert.ok(ui.q('.ps-key-notice').textContent.length > 0);
  });

  ui.keyInput().value = '  AIzaNew  ';
  ui.keyInput().dispatch('keydown', { key: 'Enter' });
  assert.equal(KS.get(), 'AIzaNew');
  assert.equal(ui.keyPanel().classList.contains('is-open'), false);
  assert.equal(env.document.activeElement, ui.badge(), 'focus returns to the badge');

  // Escape closes once and restores focus.
  ui.badge().click();
  ui.keyInput().dispatch('keydown', { key: 'Escape' });
  assert.equal(ui.keyPanel().classList.contains('is-open'), false);

  // Clear really clears.
  ui.badge().click();
  ui.keyButtons()[0].click();
  assert.equal(KS.get(), '');
  assert.equal(ui.badge().textContent, 'SIM · +KEY');
  ui.unmount();
});

test('key panel: Save keeps a key remembered on this device in localStorage', () => {
  const env = loadEnv();
  const ui = mountUi(env);
  env.NS.Client.KeyStore.set('AIzaRemembered', true);
  ui.badge().click();
  ui.keySave().click();
  assert.equal(env.win.localStorage.bag.dc_gemini_api_key_local, 'AIzaRemembered');
  assert.equal(env.win.sessionStorage.bag.dc_gemini_api_key_session, undefined);
  ui.unmount();
});

test('Start Live Mic: no key opens the key panel; no mic API gives a truthful error', () => {
  const env = loadEnv();
  const ui = mountUi(env);
  ui.mic().click();
  assert.ok(ui.keyPanel().classList.contains('is-open'));
  assert.match(ui.mic().textContent, /Start Live Mic/);
  assert.equal(env.sockets.length, 0);

  env.NS.Client.KeyStore.set('AIzaKey');
  ui.mic().click();
  assert.match(ui.readout().textContent, /Microphone capture is unavailable/);
  assert.ok(ui.readout().classList.contains('is-error'));
  assert.match(ui.mic().textContent, /Start Live Mic/);
  assert.equal(ui.mic().getAttribute('aria-pressed'), 'false');
  assert.equal(env.sockets.length, 0);
  ui.unmount();
});

test('Start Live Mic: permission denied resets the button and opens no socket', async () => {
  const env = loadEnv({
    gum: () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }))
  });
  const ui = mountUi(env);
  env.NS.Client.KeyStore.set('AIzaKey');
  ui.mic().click();
  assert.match(ui.mic().textContent, /Connecting/);
  assert.match(ui.readout().textContent, /microphone/i);
  await flush();
  assert.match(ui.readout().textContent, /Mic error: Permission denied/);
  assert.match(ui.mic().textContent, /Start Live Mic/);
  assert.equal(ui.mic().classList.contains('is-processing'), false);
  assert.equal(env.sockets.length, 0);
  // Button is usable again.
  ui.mic().click();
  assert.equal(env.gumCalls, 2);
  await flush();
  ui.unmount();
});

async function startLive(env, ui) {
  env.NS.Client.KeyStore.set('AIzaLiveKey');
  env.win.dispatchEvent({ type: 'gemini-key-changed' });
  ui.mic().click();
  await flush();
  const sock = env.sockets[env.sockets.length - 1];
  sock.serverOpen();
  sock.serverSend(JSON.stringify({ setupComplete: {} }));
  return sock;
}

function assertTornDown(env, sock) {
  const stream = env.streams[env.streams.length - 1];
  const ac = env.audioContexts.find((c) => c.nodes.some((n) => 'onaudioprocess' in n));
  assert.equal(stream.track.stopped, true, 'mic track stopped');
  assert.equal(ac.closed, true, 'capture AudioContext closed');
  const proc = ac.nodes.find((n) => 'onaudioprocess' in n);
  assert.equal(proc.disconnected, true, 'processor disconnected');
  assert.equal(proc.onaudioprocess, null);
  assert.equal(sock.closedByClient, true, 'socket closed');
}

function liveEnv() {
  return loadEnv({
    gum: (env) => {
      const s = makeFakeStream();
      env.streams.push(s);
      return Promise.resolve(s);
    }
  });
}

test('live session (fakes): ready state, stop button, and full teardown', async () => {
  const env = liveEnv();
  const ui = mountUi(env);
  const sock = await startLive(env, ui);
  assert.match(ui.mic().textContent, /Live/);
  assert.equal(ui.badge().textContent, 'LIVE');
  assert.ok(sock.url.includes('AIzaLiveKey'));
  assert.equal(domContains(ui.container, 'AIzaLiveKey'), false, 'key never rendered into the DOM');
  sock.serverSend(
    JSON.stringify({
      toolCall: { functionCalls: [{ id: '1', name: 'adjust_button_size', args: { direction: 'bigger', delta_percent: 12 } }] }
    })
  );
  assert.match(ui.metrics(), /^112% /);
  ui.mic().click();
  assertTornDown(env, sock);
  assert.match(ui.mic().textContent, /Start Live Mic/);
  assert.equal(ui.badge().textContent, 'KEY SET');
  ui.unmount();
});

test('live session (fakes): removing the key elsewhere stops the open session', async () => {
  const env = liveEnv();
  const ui = mountUi(env);
  const sock = await startLive(env, ui);
  // Unrelated focus / repeated key events with the same key keep the session.
  env.win.dispatchEvent({ type: 'focus' });
  env.win.dispatchEvent({ type: 'gemini-key-changed' });
  assert.equal(sock.closedByClient, false);
  // Simulate api-matrix clearing the shared store.
  env.win.sessionStorage.removeItem('dc_gemini_api_key_session');
  env.win.dispatchEvent({ type: 'gemini-key-changed' });
  assertTornDown(env, sock);
  assert.match(ui.readout().textContent, /key/i);
  assert.equal(ui.badge().textContent, 'SIM · +KEY');
  ui.unmount();
});

test('live session (fakes): hiding the tab stops capture; unmount cleans everything', async () => {
  const env = liveEnv();
  const ui = mountUi(env);
  const sock = await startLive(env, ui);
  env.document.visibilityState = 'hidden';
  env.document.hidden = true;
  env.document.fire('visibilitychange');
  assertTornDown(env, sock);
  assert.match(ui.readout().textContent, /hidden/i);

  env.document.visibilityState = 'visible';
  env.document.hidden = false;
  env.document.fire('visibilitychange');
  assert.equal(env.sockets.length, 1, 'no automatic reconnect');

  const sock2 = await startLive(env, ui);
  ui.unmount();
  assertTornDown(env, sock2);
  assert.equal(ui.container.children.length, 0);
  ['focus', 'gemini-key-changed', 'storage', 'resize', 'pagehide'].forEach((t) => {
    assert.equal((env.winListeners[t] || []).length, 0, t + ' listener removed');
  });
  assert.equal((env.document.listeners.visibilitychange || []).length, 0);
});

test('live session (fakes): server close after setup ends the session with a reason', async () => {
  const env = liveEnv();
  const ui = mountUi(env);
  const sock = await startLive(env, ui);
  sock.serverClose(1011, 'Internal error');
  assert.match(ui.readout().textContent, /Live session ended: Internal error/);
  assert.match(ui.mic().textContent, /Start Live Mic/);
  const stream = env.streams[0];
  assert.equal(stream.track.stopped, true);
  ui.unmount();
});
