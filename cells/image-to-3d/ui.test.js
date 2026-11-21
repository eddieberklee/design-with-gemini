'use strict';

// Loads renderer.js + client.js + ui.js in a vm with a small fake DOM: three tiles, a counting
// fetch and a manual requestAnimationFrame queue. Pins the cost and lifecycle invariants.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DIR = process.env.I3D_DIR || __dirname;
const FAKE_KEY = 'AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE00';

function makeCtx2d() {
  return new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : (k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {})),
    set: (t, k, v) => { t[k] = v; return true; }
  });
}

class FakeEl {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.doc = doc;
    this.attrs = {};
    this.listeners = {};
    this.children = [];
    this.cache = {};
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.value = '';
    this.className = '';
    this.style = { setProperty() {} };
    this.width = 0;
    this.height = 0;
    const cls = new Set();
    this.classList = {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
      toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); }
    };
    this._html = '';
  }
  set innerHTML(v) { this._html = String(v); this.cache = {}; this.children = []; }
  get innerHTML() { return this._html; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatch(type, extra) {
    const ev = Object.assign({ type, target: this, preventDefault() {}, stopPropagation() { this._stop = true; } }, extra || {});
    (this.listeners[type] || []).slice().forEach((fn) => fn(ev));
    return ev;
  }
  click() { this.dispatch('click'); }
  focus() {}
  appendChild(c) { this.children.push(c); return c; }
  contains() { return false; }
  querySelector(sel) {
    if (!this.cache[sel]) {
      const tag = sel.includes('canvas') ? 'canvas' : (sel.includes('select') ? 'select' : 'div');
      const el = new FakeEl(tag, this.doc);
      el.selector = sel;
      if (sel === '.ui-pill-label') el.textContent = 'Key';
      this.cache[sel] = el;
    }
    return this.cache[sel];
  }
  querySelectorAll() { return []; }
  getContext() { return makeCtx2d(); }
  getBoundingClientRect() { return { width: 120, height: 90, left: 0, top: 0 }; }
  toDataURL() { return 'data:image/jpeg;base64,QUJD'; }
  showModal() {}
  close() {}
}

function setup(opts) {
  const o = opts || {};
  const fetchCalls = [];
  const rafQueue = [];
  const winListeners = {};
  const doc = {
    readyState: 'complete',
    visibilityState: 'visible',
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    createElement: (tag) => new FakeEl(tag, doc),
    querySelectorAll: (sel) => (sel === '.cell--image-to-3d' ? roots : [])
  };
  const roots = [11, 12, 13].map((i) => {
    const r = new FakeEl('section', doc);
    r.attrs['data-cell-index'] = String(i);
    return r;
  });
  const store = Object.create(null);
  if (o.key) store.dc_gemini_api_key_session = o.key;
  const storage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  const sandbox = {
    console, Date, JSON, Promise, Math, Blob, URL, AbortController, Set, Proxy,
    // unref: the 10 s discovery timeout must not keep the test process alive.
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    clearTimeout,
    setInterval: () => 1, clearInterval: () => {},
    document: doc,
    devicePixelRatio: 1.25,
    sessionStorage: storage,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame: () => {},
    addEventListener: (type, fn) => { (winListeners[type] = winListeners[type] || []).push(fn); },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    dispatchEvent: (ev) => { (winListeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
    FileReader: class {
      readAsDataURL() { this.result = 'data:image/png;base64,QUJD'; setTimeout(() => this.onload(), 0); }
    },
    Image: class {
      set src(v) { this.width = 64; this.height = 48; setTimeout(() => this.onload(), 0); }
    },
    fetch: (url, init) => {
      fetchCalls.push({ url: String(url), method: (init && init.method) || 'GET', signal: init && init.signal });
      if (o.fetch) return o.fetch(url, init);
      return new Promise((_res, rej) => {
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            rej(e);
          });
        }
      });
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  ['renderer.js', 'client.js', 'ui.js'].forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
  });
  return { sandbox, roots, fetchCalls, rafQueue, doc, winListeners };
}

const q = (root, sel) => root.querySelector(sel);
const flush = () => new Promise((r) => setTimeout(r, 5));

function pickImage(root) {
  const input = q(root, '.i3d-file-input');
  input.files = [{ type: 'image/png', size: 1000, name: 'a.png' }];
  input.dispatch('change');
}

test('mounting three tiles with a saved key sends no request', async () => {
  const env = setup({ key: FAKE_KEY });
  await flush();
  assert.equal(env.fetchCalls.length, 0);
});

test('a key change from another tile sends no request', async () => {
  const env = setup({ key: FAKE_KEY });
  env.sandbox.dispatchEvent(new env.sandbox.CustomEvent('gemini-key-changed', { detail: { hasKey: true } }));
  await flush();
  assert.equal(env.fetchCalls.length, 0);
});

test('loading an image sends no request; only Run does', async () => {
  const env = setup({ key: FAKE_KEY });
  pickImage(env.roots[0]);
  await flush();
  await flush();
  assert.equal(env.fetchCalls.length, 0);
  assert.equal(q(env.roots[0], '.i3d-run-btn').getAttribute('aria-disabled'), null);
});

test('one Run click starts exactly one tile\'s six requests and leaves the other tiles alone', async () => {
  const env = setup({ key: FAKE_KEY });
  pickImage(env.roots[1]);
  await flush();
  await flush();
  const before0 = q(env.roots[0], '.i3d-status').textContent;
  const before2 = q(env.roots[2], '.i3d-status').textContent;
  q(env.roots[1], '.i3d-run-btn').click();
  await flush();
  const posts = env.fetchCalls.filter((c) => c.method === 'POST');
  const gets = env.fetchCalls.filter((c) => c.method === 'GET');
  assert.equal(posts.length, 6);
  assert.ok(gets.length <= 1, 'at most one model-list GET');
  assert.equal(q(env.roots[0], '.i3d-status').textContent, before0);
  assert.equal(q(env.roots[2], '.i3d-status').textContent, before2);
  assert.equal(q(env.roots[0], '.i3d-run-btn').textContent === 'Stop', false);
});

test('Stop then Run: the stopped run cannot end the new run', async () => {
  const env = setup({ key: FAKE_KEY });
  const root = env.roots[0];
  pickImage(root);
  await flush();
  await flush();
  const run = q(root, '.i3d-run-btn');
  run.click(); // run A
  await flush();
  run.click(); // stop A
  run.click(); // run B
  await flush();
  await flush();
  assert.equal(run.textContent, 'Stop', 'run B is still running and can be stopped');
  const signals = env.fetchCalls.filter((c) => c.method === 'POST').map((c) => c.signal);
  assert.equal(signals.length, 12);
  assert.equal(signals.slice(6).every((s) => !s.aborted), true);
});

const MODELS_BODY = { models: [
  { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.1-pro-preview', supportedGenerationMethods: ['generateContent'] }
] };

test('discovery only adds options: the next Run posts to the same models; two tiles share one GET', async () => {
  const env = setup({
    key: FAKE_KEY,
    fetch: (url) => (String(url).includes('/models?')
      ? Promise.resolve({ ok: true, status: 200, json: async () => MODELS_BODY })
      : Promise.resolve({ ok: false, status: 400, json: async () => ({}) }))
  });
  const posted = () => env.fetchCalls.filter((c) => c.method === 'POST').map((c) => c.url.split('/models/')[1]);
  pickImage(env.roots[0]);
  pickImage(env.roots[1]);
  await flush(); await flush();
  q(env.roots[0], '.i3d-run-btn').click();
  await flush(); await flush();
  const first = posted();
  q(env.roots[1], '.i3d-run-btn').click();
  await flush(); await flush();
  q(env.roots[0], '.i3d-run-btn').click();
  await flush(); await flush();
  const all = posted();
  assert.equal(all.length, 18);
  assert.deepEqual(all.slice(12), first, 'second Run of tile 11 uses the same six models');
  assert.equal(env.fetchCalls.filter((c) => c.method === 'GET').length, 1, 'one model-list GET per key for the page');
});

test('a new image during a run stops it, and late answers paint nothing', async () => {
  const pending = [];
  const env = setup({ key: FAKE_KEY, fetch: () => new Promise((res) => pending.push(res)) });
  const root = env.roots[0];
  pickImage(root);
  await flush(); await flush();
  q(root, '.i3d-run-btn').click();
  await flush();
  pickImage(root);
  await flush(); await flush();
  assert.equal(q(root, '.i3d-run-btn').textContent, 'Run 6×');
  pending.forEach((res) => res({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ title: 'Late', parts: [{ type: 'box', pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }] }) }] } }] }) }));
  await flush(); await flush();
  assert.notEqual(pill(root).label, 'Done', 'late answers do not count as a result');
  assert.equal(q(root, '.i3d-status').textContent, 'Image ready');
});

function pill(root) {
  const btn = q(root, '.i3d-key-btn');
  return { tone: btn.getAttribute('data-tone'), label: q(btn, '.ui-pill-label').textContent, tip: btn.getAttribute('data-tip') };
}

const SCENE_TEXT = JSON.stringify({ title: 'Cube', parts: [{ type: 'box', pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], color: '#888888' }] });
const okResponse = () => Promise.resolve({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: SCENE_TEXT }] } }] }) });
const errResponse = () => Promise.resolve({ ok: false, status: 429, json: async () => ({ error: { message: 'quota' } }) });

test('pill: grey without a key and with a key; never green for a saved key', () => {
  assert.equal(pill(setup({}).roots[0]).label, 'No key');
  assert.equal(pill(setup({}).roots[0]).tone, null);
  const withKey = pill(setup({ key: FAKE_KEY }).roots[0]);
  assert.equal(withKey.label, 'Key set');
  assert.equal(withKey.tone, null);
});

test('pill: rust Error when no model returned a mesh, green Done when at least one did', async () => {
  const failing = setup({ key: FAKE_KEY, fetch: (url) => (String(url).includes('/models?') ? errResponse() : errResponse()) });
  pickImage(failing.roots[0]);
  await flush(); await flush();
  q(failing.roots[0], '.i3d-run-btn').click();
  assert.equal(pill(failing.roots[0]).tone, 'attention', 'running is rust');
  await flush(); await flush();
  assert.deepEqual([pill(failing.roots[0]).label, pill(failing.roots[0]).tone], ['Error', 'attention']);

  let n = 0;
  const partial = setup({ key: FAKE_KEY, fetch: (url) => (String(url).includes('/models?') ? errResponse() : (n++ === 0 ? okResponse() : errResponse())) });
  pickImage(partial.roots[0]);
  await flush(); await flush();
  q(partial.roots[0], '.i3d-run-btn').click();
  await flush(); await flush();
  assert.deepEqual([pill(partial.roots[0]).label, pill(partial.roots[0]).tone], ['Done', 'ok']);
  assert.equal(pill(partial.roots[1]).label, 'Key set', 'other tiles keep their own state');
});

test('Run tip names the paid fan-out once an image is in', async () => {
  const env = setup({ key: FAKE_KEY });
  const run = q(env.roots[0], '.i3d-run-btn');
  assert.equal(run.getAttribute('aria-disabled'), 'true');
  assert.match(run.getAttribute('data-tip'), /image first/);
  pickImage(env.roots[0]);
  await flush(); await flush();
  assert.match(run.getAttribute('data-tip'), /6 paid requests/);
});

test('Enter on the Run button does not open the file picker', () => {
  const env = setup({ key: FAKE_KEY });
  const root = env.roots[0];
  let pickerOpened = 0;
  q(root, '.i3d-file-input').click = () => { pickerOpened += 1; };
  q(root, '.i3d-dropbar').dispatch('keydown', { key: 'Enter', target: q(root, '.i3d-run-btn') });
  assert.equal(pickerOpened, 0);
  q(root, '.i3d-dropbar').dispatch('keydown', { key: 'Enter' });
  assert.equal(pickerOpened, 1);
});

test('opening the key bar never writes the saved key into the input', () => {
  const env = setup({ key: FAKE_KEY });
  const root = env.roots[0];
  q(root, '.i3d-key-bar').hidden = true;
  q(root, '.i3d-key-btn').click();
  assert.equal(q(root, '.i3d-key-input').value, '');
});

test('an empty Save does not clear the shared key', () => {
  const env = setup({ key: FAKE_KEY });
  const root = env.roots[0];
  q(root, '.i3d-key-input').value = '   ';
  q(root, '.i3d-key-save').click();
  assert.equal(env.sandbox.sessionStorage.getItem('dc_gemini_api_key_session'), FAKE_KEY);
});

test('a wrong file type is refused with a message', async () => {
  const env = setup({ key: FAKE_KEY });
  const root = env.roots[0];
  const input = q(root, '.i3d-file-input');
  input.files = [{ type: 'application/pdf', size: 10, name: 'a.pdf' }];
  input.dispatch('change');
  await flush();
  assert.match(q(root, '.i3d-status').textContent, /Not an image/);
  assert.equal(env.fetchCalls.length, 0);
});

test('viewers schedule no frames while idle', async () => {
  const env = setup({ key: FAKE_KEY });
  await flush();
  // A mount may queue at most one frame per viewer; running the queue must not refill it.
  const first = env.rafQueue.splice(0);
  first.forEach((fn) => fn(0));
  assert.equal(env.rafQueue.length, 0);
});

test('a spinning viewer stops when off screen or the tab is hidden', () => {
  const env = setup({});
  const R = env.sandbox.GeminiImageTo3D.Renderer;
  let ioCb = null;
  env.sandbox.IntersectionObserver = class { constructor(cb) { ioCb = cb; } observe() {} disconnect() {} };
  const canvas = new FakeEl('canvas', env.doc);
  const viewer = R.createViewer(canvas, {});
  env.rafQueue.length = 0;
  viewer.setMesh(R.buildMeshFromScene({ parts: [{ type: 'box', pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }] }));
  assert.equal(env.rafQueue.length, 1, 'spinning mesh schedules a frame');
  env.rafQueue.shift()(0);
  assert.equal(env.rafQueue.length, 1, 'and keeps spinning while visible');
  ioCb([{ isIntersecting: false }]);
  env.rafQueue.shift()(0);
  assert.equal(env.rafQueue.length, 0, 'off screen: loop stops');
  ioCb([{ isIntersecting: true }]);
  assert.equal(env.rafQueue.length, 1, 'back on screen: loop resumes');
  env.doc.visibilityState = 'hidden';
  env.rafQueue.shift()(0);
  assert.equal(env.rafQueue.length, 0, 'hidden tab: loop stops');
});

test('canvas backing store is not reallocated each frame at a fractional DPR', () => {
  const env = setup({});
  const R = env.sandbox.GeminiImageTo3D.Renderer;
  const canvas = new FakeEl('canvas', env.doc);
  canvas.getBoundingClientRect = () => ({ width: 121, height: 91 }); // 121 * 1.25 = 151.25
  let writes = 0;
  let w = 0;
  Object.defineProperty(canvas, 'width', { get: () => w, set: (v) => { writes += 1; w = v >>> 0; } }); // like a real canvas: integer
  const viewer = R.createViewer(canvas, {});
  viewer.setCamera({ yaw: 1, pitch: 0, zoom: 1 });
  env.rafQueue.splice(0).forEach((fn) => fn(0));
  viewer.setCamera({ yaw: 2, pitch: 0, zoom: 1 });
  env.rafQueue.splice(0).forEach((fn) => fn(0));
  assert.equal(writes, 1);
});

test('a plain wheel over a viewport scrolls the page; pinch/Ctrl zooms only with a mesh', () => {
  const env = setup({});
  const R = env.sandbox.GeminiImageTo3D.Renderer;
  const canvas = new FakeEl('canvas', env.doc);
  const viewer = R.createViewer(canvas, {});
  let prevented = 0;
  const wheel = (ctrlKey) => canvas.dispatch('wheel', { deltaY: 10, ctrlKey, preventDefault: () => { prevented += 1; } });
  wheel(false);
  wheel(true);
  assert.equal(prevented, 0, 'no mesh: never trap the wheel');
  viewer.setMesh(R.buildMeshFromScene({ parts: [{ type: 'box', pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }] }));
  wheel(false);
  assert.equal(prevented, 0, 'plain wheel scrolls');
  wheel(true);
  assert.equal(prevented, 1, 'pinch zooms');
});
