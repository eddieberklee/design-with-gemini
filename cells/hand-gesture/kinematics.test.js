/**
 * Unit & Kinematics Verification Suite (`cells/hand-gesture/kinematics.test.js`)
 * SPDX-License-Identifier: MIT-0
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('./kinematics.js');

test('OneEuroFilter2D suppresses high-frequency jitter while adapting to fast sweeps (beta=0.85)', () => {
  const scope = new K.ScopeRingBuffer(240);
  const f = new K.OneEuroFilter2D();
  let t = 0;
  for (let i = 0; i < 90; i++) {
    t += 1 / 60;
    const jitter = (i % 2 === 0 ? 1 : -1) * 0.008;
    const rx = 0.5 + jitter;
    const ry = 0.5 - jitter;
    f.filter(rx, ry, t, 1.15, 0.85, 1.8);
    scope.push(rx, ry, f.x, f.y, f.speed, 1.0, false);
  }
  assert.ok(scope.attenuationDb < -14, `Expected <-14 dB jitter attenuation, got ${scope.attenuationDb.toFixed(2)} dB`);

  // Fast sweep raises cutoff significantly above minCutoff
  for (let i = 0; i < 12; i++) {
    t += 1 / 60;
    f.filter(0.2 + i * 0.05, 0.5, t, 1.15, 0.85, 1.8);
  }
  assert.ok(f.cutoffHz > 2.8, `Expected adaptive cutoff > 2.8 Hz during fast sweep, got ${f.cutoffHz.toFixed(2)} Hz`);
});

test('NaN and non-finite landmarks are quarantined without poisoning state or throwing', () => {
  assert.equal(K.clamp(NaN, 0, 1), 0);
  assert.equal(K.clamp(Infinity, 0, 1), 1);

  const eng = new K.KinematicEngine();
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  let t = 0;
  for (let i = 0; i < 20; i++) {
    t += 1 / 60;
    const n = rig.stepAndPopulate(eng, 1 / 60, 4 / 3);
    eng.step(n, true, t, 1200, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].state, K.HAND_STATE.ARMED);

  // Inject NaN frame via MediaPipe ingestion
  const badLm = Array.from({ length: 21 }, (_, idx) => ({
    x: idx === 8 ? NaN : 0.5,
    y: 0.5,
    z: 0,
  }));
  const valid = eng.ingestMediaPipeResult({ landmarks: [badLm], worldLandmarks: [badLm] }, 4 / 3);
  assert.equal(valid, 0);
  eng.step(valid, true, t + 1 / 60, 1200, 800, 4 / 3);

  // Slot coasts cleanly with finite coordinates
  assert.equal(eng.slots[0].state, K.HAND_STATE.COASTING);
  assert.ok(Number.isFinite(eng.slots[0].interactiveX));
  assert.ok(Number.isFinite(eng.slots[0].pinchVel));
});

test('Chiral 3D palm-facing normal accepts both Left and Right open palms and rejects dorsal back-of-hand', () => {
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  const norm = new Float64Array(63);
  const world = new Float64Array(63);

  // Physical Right hand facing camera (MediaPipe unmirrored label 'Left' -> isLeftLabel = true)
  rig._buildHandLandmarks(0.5, 0.5, 0.14, 0, 0, 0, 0, 0, true, 4 / 3, norm, world);
  const cosRightPalm = K.computePalmFacingCosFlat(world, true, false);
  assert.ok(cosRightPalm > 0.85, `Expected Right open palm > +0.85, got ${cosRightPalm}`);

  // Physical Left hand facing camera (MediaPipe unmirrored label 'Right' -> isLeftLabel = false)
  rig._buildHandLandmarks(0.5, 0.5, 0.14, 0, 0, 0, 0, 0, false, 4 / 3, norm, world);
  const cosLeftPalm = K.computePalmFacingCosFlat(world, false, false);
  assert.ok(cosLeftPalm > 0.85, `Expected Left open palm > +0.85, got ${cosLeftPalm}`);

  // Dorsal back-of-hand (dorsal = 1.0 -> 180 deg flip)
  rig._buildHandLandmarks(0.5, 0.5, 0.14, 0, 0, 0, 0, 1.0, true, 4 / 3, norm, world);
  const cosDorsal = K.computePalmFacingCosFlat(world, true, false);
  assert.ok(cosDorsal < -0.85, `Expected dorsal back-of-hand < -0.85, got ${cosDorsal}`);
});

test('Engagement FSM enforces keyboard exclusion (y >= 0.86), 200ms dwell, and 4-frame dropout coasting', () => {
  const eng = new K.KinematicEngine();
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;

  // Hand resting on keyboard (camY = 0.91 >= 0.86) must NOT arm
  rig.camY = 0.91;
  let t = 0;
  for (let i = 0; i < 30; i++) {
    t += 1 / 60;
    eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1000, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].state, K.HAND_STATE.IDLE);

  // Raise hand to camY = 0.50 -> arms after ~200ms
  rig.camY = 0.50;
  for (let i = 0; i < 6; i++) {
    t += 1 / 60;
    eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1000, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].state, K.HAND_STATE.ARMING);
  for (let i = 0; i < 12; i++) {
    t += 1 / 60;
    eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1000, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].state, K.HAND_STATE.ARMED);

  // Drop 3 frames -> stays COASTING; drop >4 frames -> resets to IDLE
  for (let i = 0; i < 3; i++) {
    t += 1 / 60;
    eng.step(0, true, t, 1000, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].state, K.HAND_STATE.COASTING);
  for (let i = 0; i < 3; i++) {
    t += 1 / 60;
    eng.step(0, true, t, 1000, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].state, K.HAND_STATE.IDLE);
});

test('Metacarpal anchor & Schmitt pinch deliver 0px-slip click (<280ms) and smooth breakout drag (>=14px)', () => {
  const eng = new K.KinematicEngine();
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  let t = 0;
  for (let i = 0; i < 20; i++) {
    t += 1 / 60;
    eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1200, 800, 4 / 3);
  }
  const hoverX = eng.slots[0].interactiveX;
  const hoverY = eng.slots[0].interactiveY;

  // Quick pinch tap (< 280ms) without hand translation -> fires exact zero-slip click
  rig.targetPinch = 1;
  for (let i = 0; i < 6; i++) {
    t += 1 / 60;
    eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1200, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].pinched, true);
  assert.equal(eng.slots[0].pinchMode, K.PINCH_MODE.CLICK_LOCK);
  assert.ok(Math.hypot(eng.slots[0].interactiveX - hoverX, eng.slots[0].interactiveY - hoverY) < 1.5);

  rig.targetPinch = 0;
  let clicked = false;
  for (let i = 0; i < 8; i++) {
    t += 1 / 60;
    const ev = eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1200, 800, 4 / 3);
    if (ev.clickFired) clicked = true;
  }
  assert.equal(clicked, true);

  // Pinch and drag across screen -> promotes cleanly to DRAG past 14px
  rig.targetPinch = 1;
  for (let i = 0; i < 6; i++) {
    t += 1 / 60;
    eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1200, 800, 4 / 3);
  }
  for (let i = 0; i < 12; i++) {
    t += 1 / 60;
    rig.mirrorX += 0.015;
    eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1200, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].pinchMode, K.PINCH_MODE.DRAG);
});

test('Mirrored clockwise wrist roll (+deg), V-Scroll momentum, and Relative Fist-Clutch work cleanly', () => {
  const eng = new K.KinematicEngine();
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  let t = 0;
  for (let i = 0; i < 20; i++) {
    t += 1 / 60;
    eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1200, 800, 4 / 3);
  }

  // Pinch and roll wrist +25 deg clockwise -> twistTotalDeg should be positive (> +30 deg at 2.0x gain)
  rig.targetPinch = 1;
  for (let i = 0; i < 6; i++) {
    t += 1 / 60;
    eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1200, 800, 4 / 3);
  }
  rig.wristRollDeg = 25;
  for (let i = 0; i < 6; i++) {
    t += 1 / 60;
    eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1200, 800, 4 / 3);
  }
  assert.ok(eng.slots[0].twistBrokenOut, 'Expected twist deadzone breakout');
  assert.ok(eng.slots[0].twistTotalDeg > 35, `Expected clockwise +twistTotalDeg > 35, got ${eng.slots[0].twistTotalDeg}`);

  // Unpinch, switch to V-Scroll posture, move vertically -> generates scroll velocity
  rig.targetPinch = 0;
  rig.wristRollDeg = 0;
  rig.targetVScroll = 1;
  for (let i = 0; i < 10; i++) {
    t += 1 / 60;
    rig.camY += 0.012;
    eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1200, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].vScrollActive, true);
  assert.ok(eng.events.scrollVelocityPx > 40, `Expected positive scroll velocity, got ${eng.events.scrollVelocityPx}`);

  // Relative Clutch mode: closed fist freezes cursor while hand repositions
  eng.config.mappingMode = K.MAPPING_MODE.RELATIVE_CLUTCH;
  rig.targetVScroll = 0;
  rig.targetFist = 1;
  for (let i = 0; i < 10; i++) {
    t += 1 / 60;
    eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1200, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].clutchReleased, true);
  const frozenX = eng.slots[0].screenX;
  rig.mirrorX = 0.25;
  for (let i = 0; i < 6; i++) {
    t += 1 / 60;
    eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1200, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].screenX, frozenX, 'Cursor must remain stationary while closed-fist clutch is released');
});

function runFrames(eng, rig, t, n, vw = 1200, vh = 800) {
  for (let i = 0; i < n; i++) {
    t += 1 / 60;
    eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, vw, vh, 4 / 3);
  }
  return t;
}

test('Re-engage after standby restarts the 200ms arming dwell and the 1-Euro filter from the new position', () => {
  const eng = new K.KinematicEngine();
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  rig.mirrorX = 0.30;
  let t = runFrames(eng, rig, 0, 20);
  assert.equal(eng.slots[0].state, K.HAND_STATE.ARMED);

  // Standby (mode switch) for 10 s, then the hand is back somewhere else.
  eng.resetAll();
  t += 10;
  rig.mirrorX = 0.70;
  t += 1 / 60;
  eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1200, 800, 4 / 3);
  const s0 = eng.slots[0];
  assert.notEqual(s0.state, K.HAND_STATE.ARMED, 'First frame after standby must not skip the arming dwell');
  assert.ok(s0.armProgress < 0.2, `armProgress after one frame should be ~1/12, got ${s0.armProgress}`);
  assert.ok(Math.abs(s0.euroFilter.x - s0.rawU) < 1e-9, 'Filter must restart at the new raw position, not blend the old one');
  t = runFrames(eng, rig, t, 14);
  assert.equal(eng.slots[0].state, K.HAND_STATE.ARMED);
});

test('Two-hand gesture: when the primary hand leaves mid-pinch the remaining hand becomes primary and keeps dragging', () => {
  const eng = new K.KinematicEngine();
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  rig.autoOrbit = false;
  rig.dualHand = true;
  let t = runFrames(eng, rig, 0, 24);
  assert.equal(eng.slots[0].state, K.HAND_STATE.ARMED);
  assert.equal(eng.slots[1].state, K.HAND_STATE.ARMED);
  rig.targetPinch = 1;
  t = runFrames(eng, rig, t, 12);
  assert.equal(eng.events.twoHandActive, true);
  const survivor = eng.slots[1];

  // Hand A (slot 0) leaves: only hand B's landmarks arrive from now on.
  let endedCount = 0;
  for (let i = 0; i < 12; i++) {
    t += 1 / 60;
    rig.stepAndPopulate(eng, 1 / 60, 4 / 3);
    eng.setFlatCandidate(0, rig.normBuf1, rig.worldBuf1, false, 4 / 3);
    const ev = eng.step(1, true, t, 1200, 800, 4 / 3);
    if (ev.twoHandJustEnded) endedCount++;
    assert.ok(Number.isFinite(ev.dragDeltaX) && Number.isFinite(ev.dragDeltaY));
  }
  assert.equal(endedCount, 1);
  assert.equal(eng.events.twoHandActive, false);
  assert.equal(eng.slots[0], survivor, 'Remaining hand must be promoted to the primary slot');
  assert.equal(eng.slots[0].state, K.HAND_STATE.ARMED);
  assert.equal(eng.slots[0].pinched, true);
  assert.equal(eng.slots[0].pinchMode, K.PINCH_MODE.DRAG);
  assert.equal(eng.slots[1].state, K.HAND_STATE.IDLE);

  // Releasing the pinch on the promoted hand emits a primary pinchRelease.
  rig.targetPinch = 0;
  let released = false;
  for (let i = 0; i < 10; i++) {
    t += 1 / 60;
    rig.stepAndPopulate(eng, 1 / 60, 4 / 3);
    eng.setFlatCandidate(0, rig.normBuf1, rig.worldBuf1, false, 4 / 3);
    if (eng.step(1, true, t, 1200, 800, 4 / 3).pinchRelease) released = true;
  }
  assert.equal(released, true);
});

test('Schmitt pinch never flaps when engage >= release is configured', () => {
  const eng = new K.KinematicEngine({ pinchEngage: 0.45, pinchRelease: 0.40 });
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  rig.autoOrbit = false;
  let t = runFrames(eng, rig, 0, 20);
  assert.equal(eng.slots[0].state, K.HAND_STATE.ARMED);

  // Find a held pinch amount whose ratio sits between release (0.40) and engage (0.45).
  const probe = new K.KinematicEngine();
  const probeRig = new K.SyntheticHandRig();
  probeRig.noiseSigma = 0;
  let amount = -1;
  for (let p = 0; p <= 1; p += 0.01) {
    probeRig.targetPinch = p;
    probeRig.pinchAmount = p;
    probe.step(probeRig.stepAndPopulate(probe, 1 / 60, 4 / 3), true, 1 + p, 1200, 800, 4 / 3);
    const r = probe.slots[0].pinchRatio;
    if (r > 0.41 && r < 0.44) { amount = p; break; }
  }
  assert.ok(amount > 0, 'probe must find an in-band pinch amount');

  let starts = 0;
  let clicks = 0;
  for (let i = 0; i < 30; i++) {
    rig.targetPinch = amount;
    rig.pinchAmount = amount;
    t += 1 / 60;
    const ev = eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1200, 800, 4 / 3);
    if (ev.pinchStart) starts++;
    if (ev.clickFired) clicks++;
  }
  assert.ok(starts <= 1, `expected at most one pinch start while held in band, got ${starts}`);
  assert.equal(clicks, 0);
});

test('Click-lock breakout with a zero-radius lock never produces NaN drag offsets', () => {
  const eng = new K.KinematicEngine({ clickBreakoutPx: 0 });
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  rig.autoOrbit = false;
  let t = runFrames(eng, rig, 0, 30);
  rig.targetPinch = 1;
  t = runFrames(eng, rig, t, 10);
  const s0 = eng.slots[0];
  assert.equal(s0.pinched, true);
  assert.equal(s0.pinchMode, K.PINCH_MODE.DRAG);
  assert.ok(Number.isFinite(s0.breakoutOffsetX) && Number.isFinite(s0.breakoutOffsetY));
  assert.ok(Number.isFinite(s0.interactiveX) && Number.isFinite(s0.interactiveY));
  assert.ok(Number.isFinite(eng.events.dragDeltaX));
});

test('Pinched wrist twist unwraps continuously through +-180 degrees without a 360 jump', () => {
  const eng = new K.KinematicEngine();
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  rig.autoOrbit = false;
  let t = runFrames(eng, rig, 0, 20);
  rig.targetPinch = 1;
  t = runFrames(eng, rig, t, 10);
  assert.equal(eng.slots[0].pinched, true);
  let prev = eng.slots[0].twistTotalDeg;
  for (let deg = 0; deg <= 300; deg += 3) {
    rig.wristRollDeg = deg;
    t = runFrames(eng, rig, t, 1);
    const cur = eng.slots[0].twistTotalDeg;
    assert.ok(Math.abs(cur - prev) < 20, `twist jumped ${cur - prev} deg at roll ${deg}`);
    prev = cur;
  }
  assert.equal(eng.slots[0].pinched, true);
  // 2.0x gain on (300 - 3.5 deadzone) deg
  assert.ok(Math.abs(prev - 593) < 25, `expected ~593 deg total twist, got ${prev}`);
});

test('SyntheticHandRig.resetPosture clears a leftover Auto Tour pose so the hand can arm again', () => {
  const eng = new K.KinematicEngine();
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  rig.autoTour = true;
  let t = runFrames(eng, rig, 0, 60 * 10); // ends in the 2-hand pinch phase
  assert.equal(rig.dualHand, true);
  assert.ok(rig.targetPinch > 0.5);

  rig.resetPosture();
  eng.resetAll();
  assert.equal(rig.autoTour, false);
  assert.equal(rig.dualHand, false);
  t = runFrames(eng, rig, t, 20);
  assert.equal(eng.slots[0].state, K.HAND_STATE.ARMED);
  assert.equal(eng.slots[0].pinched, false);
  assert.equal(eng.slots[1].state, K.HAND_STATE.IDLE);
});
