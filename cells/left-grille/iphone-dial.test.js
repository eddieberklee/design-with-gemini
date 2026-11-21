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

