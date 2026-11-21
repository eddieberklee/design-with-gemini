import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { createStickBridgeServer } from './bridge.mjs';

const require = createRequire(import.meta.url);
const ColorEngine = require('./color-engine.js');
const Transport = require('./transport.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('OKLCH gamut mapping stays strictly inside [0..255] sRGB without clipping jumps', () => {
  for (let h = 0; h < 360; h += 15) {
    for (const L of [0.15, 0.35, 0.58, 0.78, 0.92]) {
      const c = ColorEngine.oklchToSrgbGamutMapped(L, 0.28, h);
      assert.ok(c.r >= 0 && c.r <= 255);
      assert.ok(c.g >= 0 && c.g <= 255);
      assert.ok(c.b >= 0 && c.b <= 255);
      assert.match(c.hex, /^#[0-9A-F]{6}$/);
    }
  }

  // Smooth circular wrap between 359 deg and 1 deg
  const c359 = ColorEngine.mapImuToColor(Math.cos((359 * Math.PI) / 180) * 0.7, Math.sin((359 * Math.PI) / 180) * 0.7, 0.7, 0, 0);
  const c001 = ColorEngine.mapImuToColor(Math.cos((1 * Math.PI) / 180) * 0.7, Math.sin((1 * Math.PI) / 180) * 0.7, 0.7, 0, 0);
  assert.ok(Math.abs(c359.r - c001.r) <= 6);
  assert.ok(Math.abs(c359.g - c001.g) <= 6);
  assert.ok(Math.abs(c359.b - c001.b) <= 6);
});

test('pickAdaptiveTheme guarantees >= 4.5:1 WCAG AA contrast for ink across full RGB cube', () => {
  const steps = [0, 51, 102, 153, 204, 255];
  for (const r of steps) {
    for (const g of steps) {
      for (const b of steps) {
        const theme = ColorEngine.pickAdaptiveTheme(r, g, b);
        assert.ok(
          theme.contrastRatio >= 4.5,
          `Expected >= 4.5 contrast for rgb(${r},${g},${b}), got ${theme.contrastRatio.toFixed(2)}`
        );
      }
    }
  }
});

test('Firmware C++ color_math.h and Browser JS color-engine.js match within <= 1 LSB across all 4 modes', () => {
  const headerPath = path.join(__dirname, 'firmware', 'src', 'color_math.h');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-color-parity-'));
  const cppFile = path.join(tmpDir, 'parity.cpp');
  const binFile = path.join(tmpDir, 'parity');

  const cppSrc = `
#include <stdio.h>
#include "${headerPath.replace(/\\/g, '\\\\')}"
using namespace sticks3_color;
int main() {
  const float vecs[][4] = {
    {0.0f, 0.0f, 1.0f, 0.0f},
    {0.65f, -0.25f, 0.72f, 0.12f},
    {-0.80f, 0.45f, -0.35f, 0.55f},
    {0.15f, 0.88f, 0.10f, 0.90f},
    {-0.42f, -0.71f, -0.85f, 0.05f}
  };
  for (int m = 0; m < 4; ++m) {
    for (int i = 0; i < 5; ++i) {
      RgbColor c = mapImuToColor(vecs[i][0], vecs[i][1], vecs[i][2], vecs[i][3], (uint8_t)m);
      printf("%d,%d,%u,%u,%u\\n", m, i, c.r, c.g, c.b);
    }
  }
  return 0;
}
`;

  try {
    fs.writeFileSync(cppFile, cppSrc, 'utf8');
    execFileSync('clang++', ['-std=c++17', '-O2', cppFile, '-o', binFile], { stdio: 'pipe' });
    const out = execFileSync(binFile, [], { encoding: 'utf8' }).trim().split('\n');

    const vecs = [
      [0.0, 0.0, 1.0, 0.0],
      [0.65, -0.25, 0.72, 0.12],
      [-0.80, 0.45, -0.35, 0.55],
      [0.15, 0.88, 0.10, 0.90],
      [-0.42, -0.71, -0.85, 0.05]
    ];

    assert.equal(out.length, 20);
    for (const line of out) {
      const [m, idx, cr, cg, cb] = line.split(',').map(Number);
      const [tx, ty, az, kin] = vecs[idx];
      const jsCol = ColorEngine.mapImuToColor(tx, ty, az, kin, m);
      assert.ok(Math.abs(jsCol.r - cr) <= 1, `mode ${m} vec ${idx} R: js=${jsCol.r} cpp=${cr}`);
      assert.ok(Math.abs(jsCol.g - cg) <= 1, `mode ${m} vec ${idx} G: js=${jsCol.g} cpp=${cg}`);
      assert.ok(Math.abs(jsCol.b - cb) <= 1, `mode ${m} vec ${idx} B: js=${jsCol.b} cpp=${cb}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('parseTelemetryLine and buildHostCommand handle live packets, hold hex override, and malformed input', () => {
  assert.equal(ColorEngine.parseTelemetryLine('not json'), null);
  assert.equal(ColorEngine.parseTelemetryLine('{"t":"other"}'), null);

  const pkt = ColorEngine.parseTelemetryLine(
    '{"t":"s3","seq":77,"ax":0.5,"ay":-0.25,"az":0.83,"tx":0.5,"ty":-0.25,"r":28.1,"p":-15.2,"kin":0.2,"m":2,"h":1,"hex":"#D94F1E","bat":88,"ev":"swatch"}'
  );
  assert.ok(pkt);
  assert.equal(pkt.seq, 77);
  assert.equal(pkt.mode, 2);
  assert.equal(pkt.hold, true);
  assert.equal(pkt.color.hex, '#D94F1E');
  assert.equal(pkt.battery, 88);
  assert.equal(pkt.event, 'swatch');

  assert.equal(ColorEngine.buildHostCommand({ cmd: 'mode', m: 3 }), '{"cmd":"mode","m":3}\n');
  assert.equal(ColorEngine.buildHostCommand({ cmd: 'hold', h: true }), '{"cmd":"hold","h":1}\n');
  assert.equal(ColorEngine.buildHostCommand({ cmd: 'tare' }), '{"cmd":"tare"}\n');
});

test('Local Bridge Server fans out StickS3 telemetry over WebSocket and HTTP status cleanly', async () => {
  const bridge = createStickBridgeServer({ port: 0, enableSerial: false });
  const { port } = await bridge.start();

  try {
    // Connect raw RFC 6455 WebSocket client
    const wsMessages = [];
    const key = crypto.randomBytes(16).toString('base64');
    const client = net.createConnection({ host: '127.0.0.1', port });

    await new Promise((resolve, reject) => {
      let upgraded = false;
      let buf = Buffer.alloc(0);
      client.on('error', reject);
      client.on('connect', () => {
        client.write(
          `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        );
      });
      client.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (!upgraded) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx !== -1) {
            upgraded = true;
            buf = buf.subarray(idx + 4);
            // Ingest a simulated StickS3 telemetry packet
            bridge.ingestRawSerialLine(
              '{"t":"s3","seq":12,"ax":0.42,"ay":0.31,"az":0.85,"tx":0.42,"ty":0.31,"kin":0.1,"m":0,"h":0,"hex":"#4499CC","bat":95,"ev":""}'
            );
          }
        }
        while (buf.length >= 2) {
          let len = buf[1] & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buf.length < 4) break;
            len = buf.readUInt16BE(2);
            offset = 4;
          }
          if (buf.length < offset + len) break;
          const msg = JSON.parse(buf.subarray(offset, offset + len).toString('utf8'));
          wsMessages.push(msg);
          buf = buf.subarray(offset + len);
          if (msg.t === 's3' && msg.seq === 12) {
            resolve();
          }
        }
      });
    });

    client.destroy();
    const s3Msg = wsMessages.find((m) => m.t === 's3');
    assert.ok(s3Msg);
    assert.equal(s3Msg.seq, 12);
    assert.equal(s3Msg.bat, 95);

    const statusRes = await fetch(`http://127.0.0.1:${port}/api/stick-s3/status`);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.serialConnected, true);
    assert.equal(statusJson.lastPacket.seq, 12);
  } finally {
    await bridge.close();
  }
});

test('Transport createStickLink routes incoming lines and deduplicates source priority', () => {
  const received = [];
  const link = Transport.createStickLink({
    onTelemetry: (pkt, src) => received.push({ pkt, src })
  });
  link.handleIncomingLine(
    '{"t":"s3","seq":5,"ax":-0.5,"ay":0.2,"az":0.84,"tx":-0.5,"ty":0.2,"m":1,"h":0,"hex":"#33AA77","bat":72,"ev":""}',
    'serial'
  );
  assert.equal(received.length, 1);
  assert.equal(received[0].pkt.seq, 5);
  assert.equal(received[0].src, 'serial');
});

test('pickAdaptiveTheme upholds >= 4.5:1 WCAG AA contrast and Schmitt-trigger hysteresis [0.1750, 0.1833]', () => {
  // Sweep all 256 neutral steps across both hysteresis polarities
  for (let v = 0; v <= 255; v++) {
    for (const prev of [undefined, true, false]) {
      const theme = ColorEngine.pickAdaptiveTheme(v, v, v, prev);
      assert.ok(
        theme.contrastRatio >= 4.5,
        `Gray ${v} (prev=${prev}) fell below 4.5:1 AA: ${theme.contrastRatio.toFixed(3)}`
      );
      assert.equal(theme.ink, theme.isLightBg ? '#000000' : '#ffffff');
    }
  }

  // Bi-stable hysteresis inside [0.1750, 0.1833]: #757575 (Y=0.1779) & #767676 (Y=0.1812)
  for (const mid of [117, 118]) {
    const stayLight = ColorEngine.pickAdaptiveTheme(mid, mid, mid, true);
    const stayDark = ColorEngine.pickAdaptiveTheme(mid, mid, mid, false);
    assert.equal(stayLight.isLightBg, true);
    assert.equal(stayLight.ink, '#000000');
    assert.ok(stayLight.contrastRatio >= 4.5);
    assert.equal(stayDark.isLightBg, false);
    assert.equal(stayDark.ink, '#ffffff');
    assert.ok(stayDark.contrastRatio >= 4.5);
  }

  // Guard overrides hysteresis outside AA-safe band
  const forcedDarkBg = ColorEngine.pickAdaptiveTheme(108, 108, 108, true);
  assert.equal(forcedDarkBg.isLightBg, false);
  assert.equal(forcedDarkBg.ink, '#ffffff');
  assert.ok(forcedDarkBg.contrastRatio >= 4.5);

  const forcedLightBg = ColorEngine.pickAdaptiveTheme(126, 126, 126, false);
  assert.equal(forcedLightBg.isLightBg, true);
  assert.equal(forcedLightBg.ink, '#000000');
  assert.ok(forcedLightBg.contrastRatio >= 4.5);
});

function createUiVmHarness(opts = {}) {
  let nowMs = 1_700_000_000_000;
  let nextTimerId = 1;
  const activeTimers = new Map();
  let nextRafId = 1;
  const rafQueue = new Map();
  const cancelledRafs = [];
  const wsInstances = [];
  let reducedMotion = Boolean(opts.reducedMotion);
  let clipboardReject = Boolean(opts.clipboardReject);
  let execCopyCount = 0;

  class MockTextNode {
    constructor(text) {
      this.nodeType = 3;
      this.data = String(text);
      this.parentNode = null;
    }
    get textContent() {
      return this.data;
    }
    set textContent(v) {
      this.data = String(v);
    }
  }

  class MockElement {
    constructor(tagName, doc, ns = null) {
      this.nodeType = 1;
      this.namespaceURI = ns;
      this.tagName = ns ? String(tagName) : String(tagName).toUpperCase();
      this.ownerDocument = doc;
      this.id = '';
      this._classes = new Set();
      this.dataset = {};
      this.attributes = new Map();
      this.childNodes = [];
      this.parentNode = null;
      this.listeners = new Map();
      this.open = false;
      this.width = 0;
      this.height = 0;
      this._ctx2d = null;

      const styleProps = new Map();
      this.style = {
        setProperty(k, v) {
          styleProps.set(k, String(v));
        },
        getPropertyValue(k) {
          return styleProps.get(k) || '';
        }
      };

      const self = this;
      this.classList = {
        add(...tokens) {
          tokens.forEach((t) => { if (t) self._classes.add(t); });
        },
        remove(...tokens) {
          tokens.forEach((t) => self._classes.delete(t));
        },
        toggle(token, force) {
          const shouldAdd = force === undefined ? !self._classes.has(token) : Boolean(force);
          if (shouldAdd) self._classes.add(token);
          else self._classes.delete(token);
          return shouldAdd;
        },
        contains(token) {
          return self._classes.has(token);
        }
      };
    }

    get className() {
      return Array.from(this._classes).join(' ');
    }
    set className(v) {
      this._classes = new Set(String(v || '').split(/\s+/).filter(Boolean));
    }

    get firstChild() {
      return this.childNodes[0] || null;
    }

    get children() {
      return this.childNodes.filter((n) => n.nodeType === 1);
    }

    get textContent() {
      return this.childNodes.map((n) => n.textContent).join('');
    }
    set textContent(v) {
      this.childNodes.forEach((n) => { n.parentNode = null; });
      this.childNodes = [];
      const s = String(v ?? '');
      if (s.length > 0) {
        const tn = new MockTextNode(s);
        tn.parentNode = this;
        this.childNodes.push(tn);
      }
    }

    setAttribute(k, v) {
      const str = String(v);
      this.attributes.set(k, str);
      if (k === 'id') this.id = str;
      else if (k === 'class') this.className = str;
      else if (k === 'width') this.width = Number(str) || 0;
      else if (k === 'height') this.height = Number(str) || 0;
    }

    getAttribute(k) {
      if (k === 'class') return this.className;
      return this.attributes.has(k) ? this.attributes.get(k) : null;
    }

    appendChild(child) {
      if (!child) return child;
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }

    removeChild(child) {
      const idx = this.childNodes.indexOf(child);
      if (idx !== -1) {
        this.childNodes.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    }

    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }

    removeEventListener(type, fn) {
      const arr = this.listeners.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    }

    dispatchEvent(rawEv) {
      const ev = Object.assign(
        {
          target: this,
          defaultPrevented: false,
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
          preventDefault() {
            this.defaultPrevented = true;
          }
        },
        rawEv
      );
      if (!ev.target) ev.target = this;
      let cur = this;
      while (cur) {
        const handlers = cur.listeners.get(ev.type);
        if (handlers) {
          for (const fn of [...handlers]) fn.call(cur, ev);
        }
        cur = cur.parentNode;
      }
      return ev;
    }

    click() {
      return this.dispatchEvent({ type: 'click', target: this });
    }

    focus() {
      this.ownerDocument.activeElement = this;
    }

    select() {}
    setPointerCapture() {}

    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 100 };
    }

    showModal() {
      this.open = true;
    }

    close() {
      if (this.open) {
        this.open = false;
        this.dispatchEvent({ type: 'close', target: this });
      }
    }

    getContext(kind) {
      if (kind !== '2d') return null;
      if (!this._ctx2d) {
        const calls = { texts: [], rects: [], strokes: 0 };
        this._ctx2d = {
          calls,
          fillStyle: '#000000',
          strokeStyle: '#000000',
          lineWidth: 1,
          font: '',
          fillRect(x, y, w, h) {
            calls.rects.push({ fillStyle: this.fillStyle, x, y, w, h });
          },
          fillText(text, x, y) {
            calls.texts.push({ text: String(text), fillStyle: this.fillStyle, x, y });
          },
          beginPath() {},
          moveTo() {},
          lineTo() {},
          arc() {},
          stroke() {
            calls.strokes++;
          },
          fill() {}
        };
      }
      return this._ctx2d;
    }

    toDataURL() {
      return 'data:image/png;base64,AA==';
    }

    matches(selector) {
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      if (selector.startsWith('.')) return this._classes.has(selector.slice(1));
      const dotIdx = selector.indexOf('.');
      if (dotIdx > 0) {
        const tag = selector.slice(0, dotIdx).toUpperCase();
        const cls = selector.slice(dotIdx + 1);
        return this.tagName === tag && this._classes.has(cls);
      }
      return this.tagName === selector.toUpperCase();
    }

    querySelectorAll(selector) {
      const results = [];
      const walk = (node) => {
        for (const ch of node.children) {
          if (ch.matches(selector)) results.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return results;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
  }

  const document = {
    readyState: 'complete',
    activeElement: null,
    body: null,
    createElement(tag) {
      return new MockElement(tag, document, null);
    },
    createElementNS(ns, tag) {
      return new MockElement(tag, document, ns);
    },
    createTextNode(text) {
      return new MockTextNode(text);
    },
    getElementById(id) {
      return document.body.querySelector('#' + id);
    },
    execCommand(cmd) {
      if (cmd === 'copy') {
        execCopyCount++;
        return true;
      }
      return false;
    },
    addEventListener() {}
  };
  document.body = new MockElement('body', document, null);

  const storageMap = new Map();
  const localStorage = {
    getItem(k) { return storageMap.has(k) ? storageMap.get(k) : null; },
    setItem(k, v) { storageMap.set(k, String(v)); }
  };

  class MockWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closed = false;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      wsInstances.push(this);
    }
    send(data) {
      this.sent.push(String(data));
    }
    close() {
      this.closed = true;
      this.readyState = 3;
      if (typeof this.onclose === 'function') this.onclose();
    }
    openNow() {
      this.readyState = 1;
      if (typeof this.onopen === 'function') this.onopen();
    }
    receiveJson(obj) {
      const data = typeof obj === 'string' ? obj : JSON.stringify(obj);
      if (typeof this.onmessage === 'function') this.onmessage({ data });
    }
  }

  const FakeDate = function (...args) {
    return new Date(...args);
  };
  FakeDate.now = () => nowMs;
  FakeDate.UTC = Date.UTC;
  FakeDate.parse = Date.parse;

  const navigator = {
    clipboard: {
      writeText() {
        if (clipboardReject) return Promise.reject(new Error('NotAllowedError on file://'));
        return Promise.resolve();
      }
    }
  };

  const sandbox = {
    document,
    navigator,
    localStorage,
    WebSocket: MockWebSocket,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    matchMedia: () => ({
      get matches() { return reducedMotion; }
    }),
    requestAnimationFrame(cb) {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelledRafs.push(id);
      rafQueue.delete(id);
    },
    setTimeout(fn, ms) {
      const id = nextTimerId++;
      activeTimers.set(id, { fn, ms, kind: 'timeout' });
      return id;
    },
    clearTimeout(id) {
      activeTimers.delete(id);
    },
    setInterval(fn, ms) {
      const id = nextTimerId++;
      activeTimers.set(id, { fn, ms, kind: 'interval' });
      return id;
    },
    clearInterval(id) {
      activeTimers.delete(id);
    },
    Date: FakeDate,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON,
    RegExp,
    Error,
    TypeError,
    Promise,
    Uint8Array,
    TextEncoder,
    TextDecoder
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const ctx = vm.createContext(sandbox);
  for (const rel of ['color-engine.js', 'transport.js', 'ui.js']) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    vm.runInContext(src, ctx, { filename: rel });
  }

  function stepFrame(frameTs = nowMs) {
    const entries = [...rafQueue.entries()];
    rafQueue.clear();
    for (const [, cb] of entries) cb(frameTs);
  }

  return {
    sandbox,
    document,
    localStorage,
    wsInstances,
    activeTimers,
    rafQueue,
    cancelledRafs,
    stepFrame,
    advanceTime(deltaMs) { nowMs += deltaMs; },
    setReducedMotion(val) { reducedMotion = Boolean(val); },
    setClipboardReject(val) { clipboardReject = Boolean(val); },
    getExecCopyCount() { return execCopyCount; }
  };
}

test('ui.js VM harness: first-connect + live 91% battery sync, swatch-pin & mode-lease races, Cmd+T pass-through, ArrowKey dome, a11y, and destroy()', async () => {
  const h = createUiVmHarness({ clipboardReject: true, reducedMotion: true });
  const cellEl = h.document.createElement('section');
  cellEl.id = 'cell-stick-s3';
  cellEl.className = 'cell cell--stick-s3';
  h.document.body.appendChild(cellEl);

  const handle = h.sandbox.StickS3Color.UI.mount(cellEl);
  assert.ok(handle && typeof handle.destroy === 'function');

  try {
    // 1. Micro badge is a keyboard-focusable <button>, dialog mounted, initial simulated state
    const microBtn = cellEl.querySelector('button.s3-micro');
    assert.ok(microBtn, 'Expected microWrap to be a <button class="s3-micro">');
    assert.equal(microBtn.getAttribute('aria-label'), 'Open M5StickS3 Color Studio');

    const statusPill = cellEl.querySelector('.s3-status-pill');
    assert.equal(statusPill.textContent, 'TILT PAD');
    assert.equal(statusPill.classList.contains('is-live'), false);

    const dialog = h.document.body.querySelector('dialog.s3-dialog');
    assert.ok(dialog);
    cellEl.querySelector('.s3-open-btn').click();
    assert.equal(dialog.open, true);

    // Simulated oscilloscope & Twin LCD 'SIM' badge before hardware connects
    h.stepFrame(0);
    h.stepFrame(40);
    const twinCtx = dialog.querySelector('canvas.s3-twin-lcd').getContext('2d');
    const scopeCtx = dialog.querySelector('canvas.s3-scope-canvas').getContext('2d');
    assert.ok(twinCtx.calls.texts.some((t) => t.text === 'SIM'), 'Twin LCD should show SIM when offline');
    assert.ok(twinCtx.calls.rects.some((r) => r.fillStyle === '#b45309'), 'Twin LCD SIM badge should use amber #b45309');
    assert.ok(scopeCtx.calls.strokes >= 4, 'Simulated oscilloscope should draw 3-axis traces at ~30 Hz');

    const heroMetrics = dialog.querySelector('.s3-hero-metrics');
    assert.match(heroMetrics.textContent, /\b\d{3}deg\)/, 'Hero hue must be zero-padded to 3 digits');

    // Web Serial unsupported toast on non-serial context (e.g. file://)
    await dialog.querySelector('.s3-btn--primary').click();
    const toastEl = cellEl.querySelector('.s3-toast');
    assert.equal(toastEl.textContent, 'WEB SERIAL UNSUPPORTED');

    // Clipboard fallback when navigator.clipboard.writeText rejects on file://
    cellEl.querySelector('.s3-hex-copy').click();
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(h.getExecCopyCount() >= 1, 'Rejected clipboard Promise must fall back to execCommand("copy")');

    // 2. First-connect status sync (telemetry arriving BEFORE bridge_status) + live 91% battery pill update
    assert.equal(h.wsInstances.length, 1);
    const ws = h.wsInstances[0];
    ws.openNow();
    assert.equal(statusPill.textContent, 'TILT PAD');

    // First packet arrives before any bridge_status -> must immediately flip .is-live and show 88%
    ws.receiveJson({
      t: 's3', seq: 9, ax: 0.0, ay: 0.0, az: 0.95,
      tx: 0.0, ty: 0.0, kin: 0.0, m: 0, h: 0, hex: '#D5C8C0', bat: 88, ev: ''
    });
    assert.equal(statusPill.classList.contains('is-live'), true);
    assert.equal(statusPill.textContent, 'STICK S3 · 88%');

    // Subsequent packet updates battery to 91% and flips Z hemisphere to Z−
    ws.receiveJson({
      t: 's3', seq: 10, ax: 0.25, ay: -0.15, az: -0.92,
      tx: 0.25, ty: -0.15, kin: 0.05, m: 0, h: 0, hex: '#446688', bat: 91, ev: ''
    });
    assert.equal(statusPill.textContent, 'STICK S3 · 91%');
    const chipBtns = cellEl.querySelectorAll('.s3-chip-btn');
    const holdBtn = chipBtns[0];
    const zFlipBtn = chipBtns[2];
    assert.equal(zFlipBtn.textContent, 'Z−');

    // 3. Swatch-pin persistence across 50 Hz packets (both during 450ms lease and after lease expiry)
    const firstSwatchDot = cellEl.querySelector('.s3-swatch-dot');
    assert.ok(firstSwatchDot);
    firstSwatchDot.click();
    const pinnedHex = cellEl.querySelector('.s3-hex-copy').textContent;
    assert.equal(pinnedHex, '#D94F1E');
    assert.equal(holdBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(statusPill.textContent, 'HELD');
    assert.ok(ws.sent.some((m) => JSON.parse(m).cmd === 'hold' && JSON.parse(m).h === 1));

    // Twin LCD HOLD badge uses WCAG AA #b43a10
    twinCtx.calls.rects.length = 0;
    twinCtx.calls.texts.length = 0;
    h.stepFrame(80);
    assert.ok(twinCtx.calls.texts.some((t) => t.text === 'HOLD'));
    assert.ok(twinCtx.calls.rects.some((r) => r.fillStyle === '#b43a10'));

    // Feed 50 Hz packets: in-flight unheld packet, firmware 'hold' echo, and post-lease (>450ms) held packets
    ws.receiveJson({
      t: 's3', seq: 11, ax: 0.6, ay: 0.4, az: 0.7, tx: 0.6, ty: 0.4, kin: 0, m: 0, h: 0, hex: '#11AA55', bat: 91, ev: ''
    });
    ws.receiveJson({
      t: 's3', seq: 12, ax: 0.6, ay: 0.4, az: 0.7, tx: 0.6, ty: 0.4, kin: 0, m: 0, h: 1, hex: '#11AA55', bat: 91, ev: 'hold'
    });
    h.advanceTime(600); // Advance past COMMAND_LEASE_MS (450ms)
    for (let s = 13; s <= 20; s++) {
      ws.receiveJson({
        t: 's3', seq: s, ax: -0.5, ay: 0.5, az: 0.7, tx: -0.5, ty: 0.5, kin: 0, m: 0, h: 1, hex: '#2288CC', bat: 91, ev: ''
      });
    }
    h.stepFrame(700);
    assert.equal(cellEl.style.getPropertyValue('--s3-live-hex'), '#D94F1E');
    assert.equal(cellEl.querySelector('.s3-hex-copy').textContent, '#D94F1E');
    assert.equal(holdBtn.getAttribute('aria-pressed'), 'true');

    // Hardware BtnA 'swatch' event clears custom pin and adopts hardware swatch
    ws.receiveJson({
      t: 's3', seq: 21, ax: 0.3, ay: 0.3, az: 0.9, tx: 0.3, ty: 0.3, kin: 0, m: 0, h: 1, hex: '#22AA66', bat: 91, ev: 'swatch'
    });
    h.stepFrame(740);
    assert.equal(cellEl.style.getPropertyValue('--s3-live-hex'), '#22AA66');

    // Unhold and verify mode-lease color flash immunity
    holdBtn.click();
    assert.equal(holdBtn.getAttribute('aria-pressed'), 'false');
    const modeBtns = cellEl.querySelectorAll('.s3-mode-btn');
    modeBtns[2].click(); // Select mode 2 (THERM)
    assert.equal(modeBtns[2].getAttribute('aria-pressed'), 'true');

    // In-flight packet still stamped with old mode m: 0 must render under new mode 2 during lease
    ws.receiveJson({
      t: 's3', seq: 22, ax: 0.7, ay: -0.3, az: 0.65, tx: 0.7, ty: -0.3, kin: 0.4, m: 0, h: 0, hex: '#00FF00', bat: 91, ev: ''
    });
    h.stepFrame(780);
    const expectedTherm = ColorEngine.mapImuToColor(0.7, -0.3, 0.65, 0.4, 2);
    assert.equal(modeBtns[2].getAttribute('aria-pressed'), 'true');
    assert.equal(cellEl.style.getPropertyValue('--s3-live-hex'), expectedTherm.hex);

    // 4. Cmd+T / Ctrl+M / Alt+T modifier pass-through
    const sentCountBefore = ws.sent.length;
    const cmdT = cellEl.dispatchEvent({ type: 'keydown', key: 't', metaKey: true });
    const ctrlM = cellEl.dispatchEvent({ type: 'keydown', key: 'm', ctrlKey: true });
    const altT = cellEl.dispatchEvent({ type: 'keydown', key: 'T', altKey: true });
    assert.equal(cmdT.defaultPrevented, false);
    assert.equal(ctrlM.defaultPrevented, false);
    assert.equal(altT.defaultPrevented, false);
    assert.equal(ws.sent.length, sentCountBefore);
    assert.equal(modeBtns[2].getAttribute('aria-pressed'), 'true');

    // 5. Disconnect resets battery & ArrowKey dome navigation breaks out of preset/hold
    h.advanceTime(4000);
    ws.receiveJson({ t: 'bridge_status', serialConnected: false, port: '' });
    assert.equal(statusPill.classList.contains('is-live'), false);
    assert.equal(statusPill.textContent, 'TILT PAD');

    // Reconnect with unknown battery (-1) must not leak stale 91%
    ws.receiveJson({ t: 'bridge_status', serialConnected: true, port: '/dev/cu.usbmodem1101' });
    assert.equal(statusPill.textContent, 'STICK S3');
    h.advanceTime(4000);
    ws.receiveJson({ t: 'bridge_status', serialConnected: false, port: '' });

    // Activate 'orbit' preset + hold, then press ArrowRight & ArrowUp on domePad
    const domePad = cellEl.querySelector('.s3-dome-pad');
    domePad.dispatchEvent({ type: 'dblclick' });
    const orbitBtn = dialog.querySelectorAll('.s3-btn').find((b) => b.dataset.preset === 'orbit');
    orbitBtn.click();
    assert.equal(statusPill.textContent, 'DEMO ORBIT');
    holdBtn.click();
    assert.equal(statusPill.textContent, 'HELD');

    const arrowRight = domePad.dispatchEvent({ type: 'keydown', key: 'ArrowRight' });
    const arrowUp = domePad.dispatchEvent({ type: 'keydown', key: 'ArrowUp' });
    assert.equal(arrowRight.defaultPrevented, true);
    assert.equal(arrowUp.defaultPrevented, true);
    assert.equal(holdBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(statusPill.textContent, 'TILT PAD');

    h.stepFrame(820);
    const puck = cellEl.querySelector('.s3-dome-puck');
    const cxAfterArrow = Number(puck.getAttribute('cx'));
    const cyAfterArrow = Number(puck.getAttribute('cy'));
    assert.ok(cxAfterArrow > 50, 'ArrowRight should move dome puck right of center');
    assert.ok(cyAfterArrow < 50, 'ArrowUp should move dome puck above center');

    // Subsequent frame must not overwrite ArrowKey coordinates with 'orbit' demo motion
    h.stepFrame(860);
    assert.equal(Number(puck.getAttribute('cx')), cxAfterArrow);
    assert.equal(Number(puck.getAttribute('cy')), cyAfterArrow);

    // Verify unified 8-swatch storage cap across repeated captures
    for (let i = 0; i < 10; i++) {
      const hex = `#${String(10 + i).padStart(2, '0')}4488`;
      ws.receiveJson({
        t: 's3', seq: 100 + i, ax: 0.1, ay: 0.1, az: 0.98,
        tx: 0.1, ty: 0.1, kin: 0, m: 0, h: 1, hex, bat: 90, ev: 'swatch'
      });
    }
    const storedSwatches = JSON.parse(h.localStorage.getItem('s3_captured_swatches_v1'));
    assert.equal(storedSwatches.length, 8, 'Saved swatches must be capped at 8');
  } finally {
    // 6. destroy() cancels rAF, closes WS/timers, and removes dialog from document.body
    handle.destroy();
  }

  assert.ok(h.cancelledRafs.length >= 1, 'destroy() must cancel scheduled requestAnimationFrame');
  assert.equal(h.rafQueue.size, 0);
  assert.equal(h.document.body.querySelector('dialog.s3-dialog'), null, 'destroy() must remove <dialog>');
  assert.equal(h.wsInstances[0].closed, true, 'destroy() must close active transport WebSocket');
  assert.equal(h.activeTimers.size, 0, 'destroy() must leave zero leaked timers/intervals');
});

test('ColorEngine handles 1e309/Infinity/null/NaN safely and preserves #FFFFFF/#000000 endpoints in lerpColorOklab', () => {
  assert.equal(ColorEngine.clamp(Infinity, -1, 1), 1);
  assert.equal(ColorEngine.clamp(-Infinity, -1, 1), -1);
  assert.equal(ColorEngine.clamp(NaN, -1, 1), 0);

  const infPkt = ColorEngine.parseTelemetryLine('{"t":"s3","seq":1e309,"m":1e309,"ax":null,"ay":null,"bat":null,"r":null,"ev":"mode"}');
  assert.ok(infPkt);
  assert.equal(Number.isFinite(infPkt.mode), true);
  assert.ok(infPkt.mode >= 0 && infPkt.mode < 4);
  assert.equal(Number.isFinite(infPkt.seq), true);
  assert.equal(infPkt.ax, 0);
  assert.equal(infPkt.ay, 0);
  assert.equal(infPkt.battery, -1);

  assert.equal(ColorEngine.buildHostCommand({ cmd: 'mode', m: Infinity }), '{"cmd":"mode","m":0}\n');

  const white = ColorEngine.parseHexToSpec('#FFFFFF');
  const black = ColorEngine.parseHexToSpec('#000000');
  assert.equal(ColorEngine.lerpColorOklab(white, white, 0.28).hex, '#FFFFFF');
  assert.equal(ColorEngine.lerpColorOklab(black, black, 0.28).hex, '#000000');
  assert.equal(ColorEngine.lerpColorOklab(black, white, 1.0).hex, '#FFFFFF');
});

test('Bridge rejects malformed URI (%ZZ), blocks foreign Origin, ignores ingest bridge_port spoofing, and survives rapid release/claim', async () => {
  const bridge = createStickBridgeServer({ port: 0, enableSerial: false });
  const { port } = await bridge.start();

  try {
    // 1. Malformed URI /%ZZ returns 400 without crashing server
    const badUriStatus = await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: '127.0.0.1', port }, () => {
        s.write('GET /%ZZ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      });
      let out = '';
      s.on('data', (c) => { out += c.toString('utf8'); });
      s.on('end', () => resolve(out.split('\r\n')[0]));
      s.on('error', reject);
    });
    assert.match(badUriStatus, /HTTP\/1\.1 400/);

    // 2. Foreign Origin is rejected with 403
    const foreignRes = await fetch(`http://127.0.0.1:${port}/api/stick-s3/status`, {
      headers: { Origin: 'https://evil.example.com' }
    });
    assert.equal(foreignRes.status, 403);

    // 3. file:// ('null') Origin is allowed
    const fileOriginRes = await fetch(`http://127.0.0.1:${port}/api/stick-s3/status`, {
      headers: { Origin: 'null' }
    });
    assert.equal(fileOriginRes.status, 200);
    assert.equal(fileOriginRes.headers.get('access-control-allow-origin'), 'null');

    // 4. /api/stick-s3/ingest cannot spoof bridge_port metadata
    await fetch(`http://127.0.0.1:${port}/api/stick-s3/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: 'bridge_port', connected: true, port: '/dev/spoofed' })
    });
    const stAfterSpoof = await (await fetch(`http://127.0.0.1:${port}/api/stick-s3/status`)).json();
    assert.notEqual(stAfterSpoof.port, '/dev/spoofed');

    // 5. Rapid release -> claim transitions cleanly
    const relRes = await (await fetch(`http://127.0.0.1:${port}/api/stick-s3/release`, { method: 'POST' })).json();
    assert.equal(relRes.released, true);
    const clmRes = await (await fetch(`http://127.0.0.1:${port}/api/stick-s3/claim`, { method: 'POST' })).json();
    assert.equal(clmRes.released, false);
  } finally {
    await bridge.close();
  }
});
