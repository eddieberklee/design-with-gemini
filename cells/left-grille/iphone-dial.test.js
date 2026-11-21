'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Dial = require('./iphone-dial.js');
const {
  DETENT_COUNT,
  DETENT_STEP_DEG,
  STATIONARY_DEADBAND_DEG_PER_SEC,
  wrapAngle360,
  wrapAngleDiffDeg,
  normalizeGravityVector,
  projectDeskSpinRate,
  RotaryDialTracker,
  parseBleRotaryPayload,
  resolveDialPhoneUrl
} = Dial;

test('1. Clockwise and counter-clockwise 360-degree desk spin integration & RPM', () => {
  const tracker = new RotaryDialTracker({ initialValue: 50, enableBiasEstimation: false });

  // Spin clockwise at +90 deg/s for 4.0 seconds (100 steps of dt = 0.04s => +360 deg)
  for (let i = 0; i < 100; i++) {
    tracker.ingestMotion({
      alpha: 90,
      beta: 0,
      gamma: 0,
      gx: 0,
      gy: 0,
      gz: 9.81,
      dt: 0.04
    });
  }

  let st = tracker.getState();
  assert.ok(Math.abs(st.cumulativeDeg - 360) < 1e-6, `Expected +360 deg, got ${st.cumulativeDeg}`);
  assert.ok(Math.abs(st.turns - 1.0) < 1e-6, `Expected +1.00 turn, got ${st.turns}`);
  assert.ok(st.angleDeg < 1e-6 || Math.abs(st.angleDeg - 360) < 1e-6);
  // 90 deg/s = 15.0 RPM
  assert.ok(Math.abs(st.rpm - 15.0) < 0.25, `Expected ~15 RPM, got ${st.rpm}`);
  assert.equal(st.detentIndex, 24);
  assert.equal(st.totalDetentTicks, 24);
  assert.equal(st.dialValue, 100);

  // Now spin counter-clockwise at -180 deg/s for 2.0 seconds (50 steps of dt = 0.04s => -360 deg back to 0)
  for (let i = 0; i < 50; i++) {
    tracker.ingestMotion({
      alpha: -180,
      beta: 0,
      gamma: 0,
      gx: 0,
      gy: 0,
      gz: 9.81,
      dt: 0.04
    });
  }

  st = tracker.getState();
  assert.ok(Math.abs(st.cumulativeDeg) < 1e-6, `Expected 0 cumulativeDeg, got ${st.cumulativeDeg}`);
  assert.ok(Math.abs(st.turns) < 1e-6);
  assert.equal(st.detentIndex, 0);
  assert.equal(st.totalDetentTicks, 48); // 24 CW + 24 CCW
  assert.ok(Math.abs(st.dialValue) < 1e-6, `Expected dialValue 0 after -360 deg from 100, got ${st.dialValue}`);
});

test('2. Face-up vs Face-down vs Tilted-Desk 3D gravity vector projection (zero gimbal lock)', () => {
  // Case A: Face-Up (gz = +9.81) vs Face-Down (gz = -9.81)
  const upTracker = new RotaryDialTracker({ enableBiasEstimation: false });
  const downTracker = new RotaryDialTracker({ enableBiasEstimation: false });

  for (let i = 0; i < 50; i++) {
    // Face-up clockwise spin: +120 deg/s around +Z, gravity +9.81 on Z
    upTracker.ingestMotion({ alpha: 120, beta: 0, gamma: 0, gx: 0, gy: 0, gz: 9.81, dt: 0.02 });
    // Face-down clockwise spin viewed from above: phone is upside down so Z axis points into desk
    // (alpha = -120 deg/s in device frame, gz = -9.81 in device frame)
    downTracker.ingestMotion({ alpha: -120, beta: 0, gamma: 0, gx: 0, gy: 0, gz: -9.81, dt: 0.02 });
  }

  const upState = upTracker.getState();
  const downState = downTracker.getState();

  assert.equal(upState.faceUp, true);
  assert.equal(downState.faceUp, false);
  assert.ok(Math.abs(upState.cumulativeDeg - 120) < 1e-5);
  assert.ok(Math.abs(downState.cumulativeDeg - 120) < 1e-5);
  assert.equal(upState.detentIndex, 8);
  assert.equal(downState.detentIndex, 8);

  // Case B: Tilted drafting desk (30 deg pitch & 20 deg roll) — spinning around desk surface normal
  const tiltedTracker = new RotaryDialTracker({ enableBiasEstimation: false });
  const gRaw = { x: 2.8, y: 4.5, z: 8.2 };
  const gUnit = normalizeGravityVector(gRaw.x, gRaw.y, gRaw.z);
  const spinRateDegPerSec = 150;

  // Angular velocity vector aligned with the tilted desk normal: omega = spinRate * gUnit
  for (let i = 0; i < 60; i++) {
    tiltedTracker.ingestMotion({
      beta: spinRateDegPerSec * gUnit.x,  // X-axis rate
      gamma: spinRateDegPerSec * gUnit.y, // Y-axis rate
      alpha: spinRateDegPerSec * gUnit.z, // Z-axis rate
      gx: gRaw.x,
      gy: gRaw.y,
      gz: gRaw.z,
      dt: 0.02
    });
  }

  const tiltedState = tiltedTracker.getState();
  // 60 * 0.02s * 150 deg/s = 180 deg
  assert.ok(
    Math.abs(tiltedState.cumulativeDeg - 180) < 1e-4,
    `Tilted desk spin should integrate to 180 deg without gimbal lock, got ${tiltedState.cumulativeDeg}`
  );
  assert.equal(tiltedState.detentIndex, 12);
});

test('3. Stationary drift rejection: 0.00 deg drift over 60 seconds at rest (< 0.8 deg/s deadband)', () => {
  const tracker = new RotaryDialTracker({ initialValue: 50 });

  // Simulate 60 full seconds at 60 Hz (3,600 frames) with MEMS bias (+0.42 deg/s) + micro-jitter
  for (let i = 0; i < 3600; i++) {
    const jitter = 0.22 * Math.sin(i * 0.17) + 0.11 * Math.cos(i * 0.43);
    tracker.ingestMotion({
      alpha: 0.42 + jitter, // strictly inside < 0.8 deg/s deadband
      beta: 0.15 * Math.sin(i * 0.1),
      gamma: -0.12 * Math.cos(i * 0.2),
      gx: 0.02,
      gy: -0.01,
      gz: 9.81,
      dt: 1 / 60
    });
  }

  const st = tracker.getState();
  assert.equal(st.cumulativeDeg, 0, 'Must have exact 0.00 deg cumulative drift at rest');
  assert.equal(st.angleDeg, 0, 'Must have exact 0.00 deg angle drift at rest');
  assert.equal(st.totalDetentTicks, 0, 'Must fire 0 spurious detent ticks at rest');
  assert.equal(st.dialValue, 50, 'Dial value must stay locked at 50.0 at rest');
  assert.equal(st.stationary, true);
  assert.equal(st.degPerSec, 0);
});

test('4. 360-degree wrap/unwrap and boundary crossing continuity (350 deg <-> 10 deg)', () => {
  assert.equal(wrapAngle360(0), 0);
  assert.equal(wrapAngle360(360), 0);
  assert.equal(wrapAngle360(725.5), 5.5);
  assert.equal(wrapAngle360(-45), 315);
  assert.equal(wrapAngleDiffDeg(10, 350), 20);
  assert.equal(wrapAngleDiffDeg(350, 10), -20);

  const tracker = new RotaryDialTracker({ initialValue: 50 });
  tracker.ingestAbsoluteAngle(350, 0.02); // -10 deg from 0
  assert.ok(Math.abs(tracker.angleDeg - 350) < 1e-6);
  assert.ok(Math.abs(tracker.cumulativeDeg - (-10)) < 1e-6);

  // Cross 0-degree seam clockwise to 15 deg (+25 deg delta)
  const st = tracker.ingestAbsoluteAngle(15, 0.02);
  assert.ok(Math.abs(st.angleDeg - 15) < 1e-6);
  assert.ok(Math.abs(st.cumulativeDeg - 15) < 1e-6);
  assert.equal(st.detentIndex, 1);
  assert.equal(st.totalDetentTicks, 1);
});

test('5. 24-detent virtual click tick counting (every 15 deg), reversal hysteresis & Fine 0.25x mode', () => {
  assert.equal(DETENT_COUNT, 24);
  assert.equal(DETENT_STEP_DEG, 15);
  assert.equal(STATIONARY_DEADBAND_DEG_PER_SEC, 0.8);

  const tracker = new RotaryDialTracker({ initialValue: 50 });

  // Advance to +15.2 deg -> crosses detent #1 (+15 deg)
  let st = tracker.ingestDeltaAngle(15.2, 0.02);
  assert.equal(st.detentIndex, 1);
  assert.equal(st.detentSlot, 1);
  assert.equal(st.detentDelta, 1);
  assert.equal(st.totalDetentTicks, 1);

  // Micro-jitter back by -1.0 deg (to +14.2 deg) then forward +1.0 deg (to +15.2 deg):
  // Hysteresis must prevent any extra detent click at the 15-deg boundary!
  st = tracker.ingestDeltaAngle(-1.0, 0.02);
  assert.equal(st.detentDelta, 0);
  assert.equal(st.totalDetentTicks, 1);
  st = tracker.ingestDeltaAngle(1.0, 0.02);
  assert.equal(st.detentDelta, 0);
  assert.equal(st.totalDetentTicks, 1);

  // Fine mode (0.25x sensitivity): 360 deg turn changes dialValue by 25 instead of 100
  tracker.zero(50);
  tracker.setFineMode(true);
  st = tracker.ingestDeltaAngle(360, 0.5);
  assert.equal(st.detentIndex, 24);
  assert.equal(st.totalDetentTicks, 24);
  assert.ok(Math.abs(st.dialValue - 75) < 1e-6, `Expected 75 in 0.25x fine mode, got ${st.dialValue}`);
});

test('6. Web Bluetooth BLE rotary payload parser & QR URL resolver', () => {
  // JSON absolute angle
  const p1 = parseBleRotaryPayload('{"angle": 270.5, "val": 82}');
  assert.deepEqual(p1, { kind: 'absolute', angleDeg: 270.5, dialValue: 82 });

  // JSON delta angle
  const p2 = parseBleRotaryPayload('{"delta": -15}');
  assert.deepEqual(p2, { kind: 'delta', deltaDeg: -15, dialValue: undefined });

  // ASCII delta string
  const p3 = parseBleRotaryPayload('d:+7.5\n');
  assert.deepEqual(p3, { kind: 'delta', deltaDeg: 7.5 });

  // Binary Uint16LE (18000 => 180.00 deg)
  const buf = new Uint8Array([18000 & 0xff, (18000 >> 8) & 0xff]);
  const p4 = parseBleRotaryPayload(buf.buffer);
  assert.deepEqual(p4, { kind: 'absolute', angleDeg: 180 });

  // QR URL resolution with custom LAN host
  const resolved = resolveDialPhoneUrl(
    '192.168.1.42:8000',
    null,
    { protocol: 'http:', origin: 'http://localhost:8000', pathname: '/index.html' },
    'DL123456'
  );
  assert.equal(
    resolved.qrUrl,
    'http://192.168.1.42:8000/cells/left-grille/dial-phone.html?s=DL123456&t=mqtt'
  );
  assert.equal(resolved.isLocalhost, false);
});

test('7. Standalone mobile dial-phone.js syntax & Secondary Slot 7 registration', () => {
  const phoneJsPath = path.join(__dirname, 'dial-phone.js');
  const code = fs.readFileSync(phoneJsPath, 'utf8');
  // Compile in isolated VM context to verify zero syntax or top-level reference errors
  const script = new vm.Script(code, { filename: 'dial-phone.js' });
  const sandbox = { window: {}, globalThis: {} };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  script.runInNewContext(sandbox);

  // Verify iphone-dial.js registered Slot 7 into LeftGrilleLab._pending
  const lab = globalThis.LeftGrilleLab;
  assert.ok(lab && Array.isArray(lab._pending), 'LeftGrilleLab._pending should exist');
  const slot7 = lab._pending.find((entry) => entry[0] === 7);
  assert.ok(slot7, 'Secondary Slot 7 must be registered');
  assert.equal(slot7[1].id, 'iphone-dial');
  assert.equal(typeof slot7[1].mount, 'function');
});

test('8. Compass / DeviceOrientation fusion when flat and magnetic spike rejection', () => {
  const tracker = new RotaryDialTracker({ initialValue: 50, enableBiasEstimation: false, compassBlend: 0.1 });
  // Prime initial compass heading at 0 deg
  tracker.ingestMotion({
    alpha: 90,
    beta: 0,
    gamma: 0,
    gx: 0,
    gy: 0,
    gz: 9.81,
    webkitCompassHeading: 0,
    dt: 0.02
  });
  // Next sample: gyro moves +1.8 deg (90 * 0.02), compass agrees at +2.0 deg
  const st1 = tracker.ingestMotion({
    alpha: 90,
    beta: 0,
    gamma: 0,
    gx: 0,
    gy: 0,
    gz: 9.81,
    webkitCompassHeading: 2.0,
    dt: 0.02
  });
  // Blended step should be 0.9 * 1.8 + 0.1 * 2.0 = 1.82 deg (total 1.8 + 1.82 = 3.62 deg)
  assert.ok(Math.abs(st1.cumulativeDeg - 3.62) < 1e-4, `Expected 3.62 deg, got ${st1.cumulativeDeg}`);

  // Magnetic interference spike (+95 deg jump in 20 ms while gyro says +1.8 deg) must be rejected
  const st2 = tracker.ingestMotion({
    alpha: 90,
    beta: 0,
    gamma: 0,
    gx: 0,
    gy: 0,
    gz: 9.81,
    webkitCompassHeading: 97.0,
    dt: 0.02
  });
  assert.ok(Math.abs(st2.cumulativeDeg - (3.62 + 1.8)) < 1e-4, 'Magnetic spike must be ignored');
});

test('9. Omitted rot.alpha ({beta:0,gamma:90}), W3C {x,y,z} linear acceleration subtraction & iOS faceUp', () => {
  // (a) Omitted rot.alpha must not zero out gamma when gravity lies along +Y
  const trackerY = new RotaryDialTracker({ enableBiasEstimation: false });
  const stY = trackerY.ingestMotion({
    beta: 0,
    gamma: 90,
    gx: 0,
    gy: 9.81,
    gz: 0,
    dt: 0.1
  });
  assert.ok(Math.abs(stY.rawDegPerSec - 90) < 1e-5, `Expected 90 deg/s when alpha omitted, got ${stY.rawDegPerSec}`);
  assert.ok(Math.abs(stY.cumulativeDeg - 9) < 1e-5, `Expected +9 deg cumulative, got ${stY.cumulativeDeg}`);

  // (b) W3C accelerationIncludingGravity {x,y,z} minus acceleration {x,y,z} yields 0 deg tilt on flat desk
  const trackerLin = new RotaryDialTracker({ enableBiasEstimation: false });
  const stLin = trackerLin.ingestMotion({
    rotationRate: { alpha: 90, beta: 0, gamma: 0 },
    accelerationIncludingGravity: { x: 0, y: 5.0, z: 9.81 },
    acceleration: { x: 0, y: 5.0, z: 0 },
    dt: 0.02
  });
  assert.ok(stLin.tiltDeg < 0.01, `Expected 0 deg tilt after W3C acceleration subtraction, got ${stLin.tiltDeg}`);

  // (c) Real iOS Safari face-up (gz = -9.81, alpha = -90) reports faceUp: true and clockwise +90 deg/s
  const iosTracker = new RotaryDialTracker({ enableBiasEstimation: false, iosGravity: true });
  const stIosUp = iosTracker.ingestMotion({
    alpha: -90,
    beta: 0,
    gamma: 0,
    gx: 0,
    gy: 0,
    gz: -9.81,
    dt: 0.1
  });
  assert.equal(stIosUp.faceUp, true, 'iOS Safari face-up (gz = -9.81) must report faceUp: true');
  assert.ok(Math.abs(stIosUp.cumulativeDeg - 9) < 1e-5, `Expected +9 deg CW on iOS face-up, got ${stIosUp.cumulativeDeg}`);
});

test('10. Lifecycle: zero main-grid leak, lg-secondary-open activation, and lg-secondary-close teardown + BLE race abort', async () => {
  const { mountIphoneDialCell } = Dial;

  function makeElem(tag) {
    const attrs = {};
    const listeners = {};
    const classes = new Set();
    return {
      tagName: String(tag || 'div').toUpperCase(),
      children: [],
      dataset: {},
      style: {},
      hidden: false,
      parentNode: null,
      textContent: '',
      get firstChild() {
        return this.children[0] || null;
      },
      classList: {
        add: (...cs) => cs.forEach((c) => classes.add(c)),
        remove: (...cs) => cs.forEach((c) => classes.delete(c)),
        toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
        contains: (c) => classes.has(c)
      },
      appendChild(child) {
        if (child && typeof child === 'object') child.parentNode = this;
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        return child;
      },
      setAttribute(k, v) {
        attrs[k] = String(v);
        if (k === 'hidden') this.hidden = true;
      },
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
      },
      hasAttribute(k) {
        return Object.prototype.hasOwnProperty.call(attrs, k);
      },
      closest(sel) {
        if (sel === '[hidden]') {
          let cur = this;
          while (cur) {
            if (cur.hidden === true || (cur.hasAttribute && cur.hasAttribute('hidden'))) return cur;
            cur = cur.parentNode;
          }
        }
        return null;
      },
      addEventListener(type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      removeEventListener(type, fn) {
        if (!listeners[type]) return;
        listeners[type] = listeners[type].filter((f) => f !== fn);
      },
      dispatchEvent(ev) {
        (listeners[ev.type] || []).slice().forEach((fn) => fn(ev));
      },
      focus() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 160, height: 160 })
    };
  }

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevMG = globalThis.MotionGrid;
  const prevNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const prevSetInterval = globalThis.setInterval;
  const prevClearInterval = globalThis.clearInterval;

  const activeIntervals = new Set();
  let nextTimerId = 500;
  globalThis.setInterval = (fn, ms) => {
    const id = ++nextTimerId;
    activeIntervals.add(id);
    return id;
  };
  globalThis.clearInterval = (id) => {
    activeIntervals.delete(id);
  };

  let createdLinks = 0;
  let closedLinks = 0;
  globalThis.MotionGrid = {
    Transport: {
      isValidSessionId: (s) => /^[A-Z0-9]{6,16}$/.test(String(s || '')),
      generateSessionId: () => '8492K7',
      createLink() {
        createdLinks++;
        return {
          start() {},
          send() {},
          close() {
            closedLinks++;
          }
        };
      }
    }
  };

  let gattConnectResolve = null;
  let gattDisconnectCalls = 0;
  let notificationsStarted = 0;
  let gattListeners = [];
  const mockBleDevice = {
    addEventListener(type, fn) {
      if (type === 'gattserverdisconnected') gattListeners.push(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'gattserverdisconnected') {
        gattListeners = gattListeners.filter((f) => f !== fn);
      }
    },
    gatt: {
      connected: false,
      connect() {
        return new Promise((resolve) => {
          gattConnectResolve = () => {
            mockBleDevice.gatt.connected = true;
            resolve({
              async getPrimaryService() {
                return {
                  async getCharacteristic() {
                    return {
                      async startNotifications() {
                        notificationsStarted++;
                      },
                      addEventListener() {},
                      removeEventListener() {}
                    };
                  }
                };
              }
            });
          };
        });
      },
      disconnect() {
        gattDisconnectCalls++;
        mockBleDevice.gatt.connected = false;
      }
    }
  };

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      bluetooth: {
        async requestDevice() {
          return mockBleDevice;
        }
      }
    }
  });

  const hiddenPage = makeElem('div');
  hiddenPage.hidden = true;
  const cellEl = makeElem('section');
  hiddenPage.appendChild(cellEl);

  const winListeners = {};
  globalThis.document = {
    createElement: (t) => makeElem(t),
    createElementNS: (_ns, t) => makeElem(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    getElementById: (id) => (id === 'left-grille-page' ? hiddenPage : null),
    addEventListener() {},
    removeEventListener() {}
  };
  globalThis.window = globalThis;
  const origAddEv = globalThis.addEventListener;
  const origRemEv = globalThis.removeEventListener;
  globalThis.addEventListener = (type, fn) => {
    (winListeners[type] = winListeners[type] || []).push(fn);
  };
  globalThis.removeEventListener = (type, fn) => {
    if (!winListeners[type]) return;
    winListeners[type] = winListeners[type].filter((f) => f !== fn);
  };
  const emitWin = (type) => {
    (winListeners[type] || []).slice().forEach((fn) => fn({ type }));
  };

  try {
    // 1. Mount while #left-grille-page is hidden on the main grid -> ZERO timers, ZERO transport links
    const instance = mountIphoneDialCell(cellEl);
    assert.equal(activeIntervals.size, 0, 'Must not start heartbeatTimer while hidden on main grid');
    assert.equal(createdLinks, 0, 'Must not open MQTT/WS transport while hidden on main grid');

    // 2. Open secondary grid (`lg-secondary-open`) -> starts heartbeatTimer & transport link
    hiddenPage.hidden = false;
    emitWin('lg-secondary-open');
    assert.equal(activeIntervals.size, 1, 'Expected 1 heartbeatTimer after lg-secondary-open');
    assert.equal(createdLinks, 1, 'Expected 1 transport link after lg-secondary-open');

    // 3. Start BLE pairing (`handleBleClick`) and fire `lg-secondary-close` mid-flight during `gatt.connect()`
    const blePromise = instance.handleBleClick();
    await Promise.resolve(); // allow requestDevice() to resolve and enter gatt.connect()
    assert.equal(typeof gattConnectResolve, 'function', 'gatt.connect should be pending');
    assert.equal(gattListeners.length, 1, 'gattserverdisconnected listener attached during connect');

    // Close secondary view while gatt.connect() is still in flight
    emitWin('lg-secondary-close');
    assert.equal(activeIntervals.size, 0, 'lg-secondary-close must clear heartbeatTimer');
    assert.equal(closedLinks, 1, 'lg-secondary-close must close active transport link');
    assert.equal(gattListeners.length, 0, 'lg-secondary-close must remove gattserverdisconnected listener');

    // Now resolve the late gatt.connect() -> must immediately disconnect and never start notifications
    gattConnectResolve();
    await blePromise;
    assert.equal(notificationsStarted, 0, 'Aborted mid-flight BLE connect must not start notifications');
    assert.equal(mockBleDevice.gatt.connected, false, 'Late GATT connection must be disconnected immediately');
    assert.ok(gattDisconnectCalls >= 1, 'gatt.disconnect() must be called on stale mid-flight connect');

    instance.unmount();
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.MotionGrid = prevMG;
    globalThis.setInterval = prevSetInterval;
    globalThis.clearInterval = prevClearInterval;
    if (origAddEv) globalThis.addEventListener = origAddEv;
    else delete globalThis.addEventListener;
    if (origRemEv) globalThis.removeEventListener = origRemEv;
    else delete globalThis.removeEventListener;
    if (prevNav) Object.defineProperty(globalThis, 'navigator', prevNav);
  }
});

test('11. dial-phone.js invalid ?s=BAD! fallback, hello state handshake without overwrite, and pagehide cleanup', () => {
  const phoneJsPath = path.join(__dirname, 'dial-phone.js');
  const code = fs.readFileSync(phoneJsPath, 'utf8');

  function makePhoneNode() {
    const attrs = {};
    const listeners = {};
    return {
      dataset: {},
      style: {},
      hidden: false,
      textContent: '',
      appendChild() {},
      setAttribute(k, v) {
        attrs[k] = String(v);
      },
      getAttribute(k) {
        return attrs[k] || null;
      },
      addEventListener(type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      trigger(type, ev) {
        (listeners[type] || []).forEach((fn) => fn(ev || {}));
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 240, height: 240 })
    };
  }

  const elements = {};
  const sentPackets = [];
  let capturedLinkOpts = null;
  let linkClosed = 0;
  let audioClosed = 0;
  const pageListeners = {};

  const sandbox = {
    URLSearchParams,
    Math,
    Number,
    String,
    Boolean,
    Object,
    Array,
    Date,
    Promise,
    performance: { now: () => 1000 },
    location: {
      search: '?s=BAD!&t=mqtt',
      protocol: 'https:',
      host: 'localhost:8443',
      origin: 'https://localhost:8443'
    },
    navigator: {},
    LeftGrilleDial: Dial,
    MotionGrid: {
      Transport: {
        isValidSessionId: (s) => /^[A-Z0-9]{6,16}$/.test(String(s || '')),
        generateSessionId: () => 'PH1234',
        createLink(opts) {
          if (!/^[A-Z0-9]{6,16}$/.test(opts.sessionId)) {
            throw new Error('Invalid sessionId for MQTT transport');
          }
          capturedLinkOpts = opts;
          return {
            start() {
              opts.onStatus('ready', { transport: 'mqtt' });
            },
            send(pkt) {
              sentPackets.push(pkt);
            },
            close() {
              linkClosed++;
            }
          };
        }
      }
    },
    AudioContext: class {
      constructor() {
        this.state = 'running';
        this.currentTime = 0;
        this.destination = {};
      }
      createOscillator() {
        return {
          type: 'triangle',
          frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect() {},
          start() {},
          stop() {}
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect() {}
        };
      }
      close() {
        this.state = 'closed';
        audioClosed++;
      }
    },
    document: {
      body: makePhoneNode(),
      getElementById(id) {
        if (!elements[id]) elements[id] = makePhoneNode();
        return elements[id];
      },
      createElementNS: () => makePhoneNode()
    },
    addEventListener(type, fn) {
      (pageListeners[type] = pageListeners[type] || []).push(fn);
    },
    cancelAnimationFrame() {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const script = new vm.Script(code, { filename: 'dial-phone.js' });
  script.runInNewContext(sandbox);

  // 1. Invalid `?s=BAD!` must fall back to `'DL000000'` without throwing
  assert.ok(capturedLinkOpts, 'Transport.createLink must be called');
  assert.equal(capturedLinkOpts.sessionId, 'DL000000', 'Invalid ?s=BAD! must fall back to DL000000');

  // 2. On connect (`ready`), phone sends ONLY `{ t: 'hello' }` and does NOT blast `{ t: 'm', dialValue: 50 }`
  assert.equal(sentPackets.length, 1, 'Connect must send only hello without overwriting desktop state');
  assert.equal(sentPackets[0].t, 'hello');

  // 3. Receiving desktop `{ t: 'state', dialValue: 82.5, fineMode: true }` syncs phone UI
  capturedLinkOpts.onMessage({ t: 'state', dialValue: 82.5, fineMode: true });
  assert.equal(elements['dp-value'].textContent, 'VAL 82.5');
  assert.equal(elements['dp-fine-btn'].textContent, '0.25× Fine');

  // 4. Triggering audio tick + `pagehide` closes both link and AudioContext
  elements['dp-touch-only-btn'].trigger('click');
  (pageListeners.pagehide || []).forEach((fn) => fn());
  assert.equal(linkClosed, 1, 'pagehide must close active Transport link');
  assert.equal(audioClosed, 1, 'pagehide must close active AudioContext');
});


