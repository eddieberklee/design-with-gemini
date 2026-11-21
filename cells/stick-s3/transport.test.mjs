// Node tests for cells/stick-s3/transport.js: localhost bridge probing budget, hidden-tab pause,
// re-arm, status truthfulness and the Web Serial cancel path. transport.js runs in a vm sandbox
// with fake WebSocket / EventSource / timers / document so nothing touches 127.0.0.1:8791.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createTransportSandbox(opts = {}) {
  let nowMs = 1_800_000_000_000;
  let nextTimerId = 1;
  const timers = new Map();
  const sockets = [];
  const eventSources = [];
  const fetches = [];
  const docListeners = new Map();

  const document = {
    visibilityState: opts.hidden ? 'hidden' : 'visible',
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      if (docListeners.has(type)) docListeners.get(type).delete(fn);
    }
  };

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }
    send(data) { this.sent.push(String(data)); }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      if (typeof this.onclose === 'function') this.onclose({});
    }
    open() {
      this.readyState = 1;
      if (typeof this.onopen === 'function') this.onopen({});
    }
    refuse() {
      // Connection refused: browsers fire error then close without ever opening.
      this.readyState = 3;
      if (typeof this.onerror === 'function') this.onerror({});
      if (typeof this.onclose === 'function') this.onclose({});
    }
    receive(obj) {
      if (typeof this.onmessage === 'function') this.onmessage({ data: JSON.stringify(obj) });
    }
  }

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      eventSources.push(this);
    }
    close() { this.readyState = 2; }
    refuse() {
      this.readyState = 2;
      if (typeof this.onerror === 'function') this.onerror({});
    }
  }

  const FakeDate = function (...args) { return new Date(...args); };
  FakeDate.now = () => nowMs;

  const sandbox = {
    document,
    navigator: opts.navigator || {},
    location: { protocol: 'file:', hostname: '', port: '', origin: 'null' },
    WebSocket: FakeWebSocket,
    EventSource: FakeEventSource,
    fetch: async (url, init) => {
      fetches.push({ url: String(url), method: (init && init.method) || 'GET' });
      throw new TypeError('Failed to fetch');
    },
    AbortController,
    TextEncoder,
    TextDecoder,
    setTimeout(fn, ms) {
      const id = nextTimerId++;
      timers.set(id, { fn, ms: Number(ms) || 0, kind: 'timeout' });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) {
      const id = nextTimerId++;
      timers.set(id, { fn, ms: Number(ms) || 0, kind: 'interval' });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    Date: FakeDate,
    Math, Number, String, Boolean, Array, Object, JSON, Error, TypeError, Promise, Uint8Array
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  for (const rel of ['color-engine.js', 'transport.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, rel), 'utf8'), ctx, { filename: rel });
  }

  return {
    Transport: sandbox.StickS3Color.Transport,
    document,
    sockets,
    eventSources,
    fetches,
    timers,
    pendingTimeouts() { return [...timers.values()].filter((t) => t.kind === 'timeout').length; },
    intervals() { return [...timers.values()].filter((t) => t.kind === 'interval').length; },
    advance(ms) { nowMs += ms; },
    // Fire every pending one-shot timer once (time jumps past its delay).
    runTimeouts() {
      const due = [...timers.entries()].filter(([, t]) => t.kind === 'timeout');
      for (const [id, t] of due) {
        timers.delete(id);
        nowMs += t.ms;
        t.fn();
      }
      return due.length;
    },
    runIntervals() {
      for (const t of [...timers.values()]) if (t.kind === 'interval') t.fn();
    },
    setHidden(hidden) {
      document.visibilityState = hidden ? 'hidden' : 'visible';
      for (const fn of [...(docListeners.get('visibilitychange') || [])]) fn({ type: 'visibilitychange' });
    },
    visibilityListenerCount() { return (docListeners.get('visibilitychange') || new Set()).size; },
    // Refuse every connection attempt that is still pending.
    refuseAll() {
      for (const s of sockets) if (s.readyState === 0) s.refuse();
      for (const e of eventSources) if (e.readyState === 0) e.refuse();
    },
    attempts() { return sockets.length + eventSources.length; }
  };
}

function lastOf(arr) { return arr[arr.length - 1]; }

test('bridge probing with no bridge running stops after a bounded number of attempts', () => {
  const h = createTransportSandbox();
  const statuses = [];
  const link = h.Transport.createStickLink({ onStatus: (s) => statuses.push(s) });
  link.start();

  // Simulate ten minutes of "connection refused" with every retry timer firing.
  for (let i = 0; i < 60; i++) {
    h.refuseAll();
    if (h.runTimeouts() === 0 && h.sockets.every((s) => s.readyState !== 0)) break;
  }
  h.refuseAll();

  assert.ok(h.attempts() >= 2, `expected a few probes, got ${h.attempts()}`);
  assert.ok(h.attempts() <= 4, `probing must have a ceiling; saw ${h.attempts()} WebSocket/EventSource attempts`);
  assert.equal(h.pendingTimeouts(), 0, 'no retry timer may stay armed once probing has stopped');
  assert.equal(h.intervals(), 0, 'no polling interval may run while no device is linked');
  assert.equal(lastOf(statuses).bridgeProbe, 'stopped');
  assert.equal(lastOf(statuses).connected, false);
  link.destroy();
});

test('a user retry re-arms probing with a fresh budget, and a found bridge resets it', () => {
  const h = createTransportSandbox();
  const link = h.Transport.createStickLink({});
  link.start();
  for (let i = 0; i < 60 && (h.refuseAll(), h.runTimeouts() > 0); i++);
  const stoppedAt = h.attempts();

  assert.equal(link.retryBridge(), true);
  assert.equal(h.attempts(), stoppedAt + 1, 'retryBridge() must start exactly one new probe');
  assert.equal(link.retryBridge(), false, 'a second retry while a probe is in flight is a no-op');

  for (let i = 0; i < 60 && (h.refuseAll(), h.runTimeouts() > 0); i++);
  assert.ok(h.attempts() - stoppedAt <= 4, 'the re-armed budget is bounded too');
  assert.equal(h.pendingTimeouts(), 0);

  // Bridge appears: next retry opens, and losing it later gets a fresh bounded budget.
  link.retryBridge();
  lastOf(h.sockets).open();
  const beforeLoss = h.attempts();
  lastOf(h.sockets).close();
  for (let i = 0; i < 60 && (h.refuseAll(), h.runTimeouts() > 0); i++);
  const afterLoss = h.attempts() - beforeLoss;
  assert.ok(afterLoss >= 1 && afterLoss <= 4, `lost bridge should be re-probed a bounded number of times, saw ${afterLoss}`);
  link.destroy();
});

test('probing never runs while the tab is hidden and re-arms when it becomes visible', () => {
  const h = createTransportSandbox({ hidden: true });
  const statuses = [];
  const link = h.Transport.createStickLink({ onStatus: (s) => statuses.push(s) });
  link.start();
  assert.equal(h.attempts(), 0, 'a tab loaded in the background must not probe localhost');

  h.setHidden(false);
  assert.equal(h.attempts(), 1, 'becoming visible starts one probe');

  h.refuseAll(); // first failure arms a backoff timer
  assert.equal(h.pendingTimeouts(), 1);
  h.setHidden(true);
  h.runTimeouts();
  h.refuseAll();
  assert.equal(h.attempts(), 1, 'a retry that comes due while hidden must not connect');
  assert.equal(h.pendingTimeouts(), 0, 'and must not keep re-arming while hidden');
  assert.equal(lastOf(statuses).bridgeProbe, 'paused');

  h.setHidden(false);
  assert.equal(h.attempts(), 2, 'becoming visible again re-arms probing');
  link.destroy();
  assert.equal(h.visibilityListenerCount(), 0, 'destroy() must remove the visibilitychange listener');
});

test('status is connected only while StickS3 telemetry is fresh, not when the bridge merely has a port open', () => {
  const h = createTransportSandbox();
  const statuses = [];
  const link = h.Transport.createStickLink({ onStatus: (s) => statuses.push(s) });
  link.start();
  const ws = h.sockets[0];
  ws.open();
  assert.equal(lastOf(statuses).connected, false, 'bridge reachable is not a connected device');
  assert.equal(lastOf(statuses).bridgeReachable, true);

  ws.receive({ t: 'bridge_status', serialConnected: true, port: '/dev/cu.usbmodem1101' });
  assert.equal(lastOf(statuses).connected, false, 'an open serial port with no telemetry is not a connected StickS3');
  assert.equal(h.intervals(), 0);

  ws.receive({ t: 's3', seq: 1, ax: 0.1, ay: 0, az: 1, tx: 0.1, ty: 0, m: 0, h: 0, hex: '#D5C8C0', bat: 70, ev: '' });
  assert.equal(lastOf(statuses).connected, true);
  assert.equal(lastOf(statuses).source, 'bridge');

  h.advance(5000);
  h.runIntervals();
  assert.equal(lastOf(statuses).connected, false, 'telemetry stopped: status must drop to not connected');
  assert.equal(h.intervals(), 0, 'the freshness watchdog stops itself once telemetry is stale');
  link.destroy();
  assert.equal(h.timers.size, 0, 'destroy() leaves zero timers');
});

test('sendCommand does not probe localhost over HTTP when no bridge is reachable', async () => {
  const h = createTransportSandbox();
  const link = h.Transport.createStickLink({});
  link.start();
  h.refuseAll();
  const sent = await link.sendCommand({ cmd: 'mode', m: 2 });
  assert.equal(sent, false);
  assert.equal(h.fetches.filter((f) => f.method === 'POST').length, 0, 'no POST to 127.0.0.1:8791 without a bridge');
  link.destroy();
});

test('cancelling the Web Serial chooser leaves the bridge alone and reports a cancellation', async () => {
  const cancelled = Object.assign(new Error('No port selected by the user.'), { name: 'NotFoundError' });
  const h = createTransportSandbox({
    navigator: { serial: { requestPort: () => Promise.reject(cancelled) } }
  });
  const link = h.Transport.createStickLink({});
  link.start();
  const ws = h.sockets[0];
  ws.open();

  await assert.rejects(link.connectWebSerial(), (err) => err.name === 'NotFoundError');
  assert.equal(
    h.fetches.filter((f) => /\/api\/stick-s3\/(release|claim)$/.test(f.url)).length,
    0,
    'the bridge must not release (and re-claim) the USB port when the user picks nothing'
  );
  assert.equal(ws.readyState, 1, 'the bridge socket stays open after a cancelled chooser');
  assert.equal(h.sockets.length, 1);

  // A retry after cancelling is accepted (no stuck "already in progress" state).
  await assert.rejects(link.connectWebSerial(), (err) => err.name === 'NotFoundError');
  link.destroy();
});

function fakeBleDevice({ connectError, serviceError } = {}) {
  return {
    name: 'StickS3-Color',
    addEventListener() {},
    removeEventListener() {},
    gatt: {
      connected: false,
      connect() {
        if (connectError) return Promise.reject(connectError);
        this.connected = true;
        return Promise.resolve({
          getPrimaryService: () => (serviceError ? Promise.reject(serviceError) : Promise.reject(new Error('unexpected')))
        });
      },
      disconnect() { this.connected = false; }
    }
  };
}

test('a BLE device that fails to connect after being picked puts the bridge back', async () => {
  const gattFail = Object.assign(new Error('GATT Server is disconnected.'), { name: 'NetworkError' });
  const h = createTransportSandbox({
    navigator: { bluetooth: { requestDevice: () => Promise.resolve(fakeBleDevice({ connectError: gattFail })) } }
  });
  const statuses = [];
  const link = h.Transport.createStickLink({ onStatus: (s) => statuses.push(s) });
  link.start();
  h.sockets[0].open();
  h.sockets[0].receive({ t: 's3', seq: 1, ax: 0, ay: 0, az: 1, tx: 0, ty: 0, m: 0, h: 0, hex: '#D5C8C0', bat: 70, ev: '' });

  await assert.rejects(link.connectWebBluetooth(), (err) => err.name === 'NetworkError');
  assert.equal(h.sockets.length, 2, 'the bridge socket closed for BLE must be reopened after BLE fails');
  assert.equal(h.sockets[0].readyState, 3);
  link.destroy();
});

test('a picked BLE device without the StickS3 service is reported as a failure, not a cancelled chooser', async () => {
  const noService = Object.assign(new Error('No Services matching UUID found in Device.'), { name: 'NotFoundError' });
  const h = createTransportSandbox({
    navigator: { bluetooth: { requestDevice: () => Promise.resolve(fakeBleDevice({ serviceError: noService })) } }
  });
  const link = h.Transport.createStickLink({});
  link.start();
  await assert.rejects(link.connectWebBluetooth(), (err) => err.name !== 'NotFoundError' && /service not found/i.test(err.message));
  link.destroy();
});
