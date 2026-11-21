/**
 * Unit, Kinematics, Camera Lifecycle & Multi-Portal Verification Suite (`cells/hand-gesture/kinematics.test.js`)
 * SPDX-License-Identifier: MIT-0
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('./kinematics.js');
const T = require('./hand-tracker.js');

function runFrames(eng, rig, t, n, vw = 1200, vh = 800) {
  for (let i = 0; i < n; i++) {
    t += 1 / 60;
    eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, vw, vh, 4 / 3);
  }
  return t;
}

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

  const badLm = Array.from({ length: 21 }, (_, idx) => ({
    x: idx === 8 ? NaN : 0.5,
    y: 0.5,
    z: 0,
  }));
  const valid = eng.ingestMediaPipeResult({ landmarks: [badLm], worldLandmarks: [badLm] }, 4 / 3);
  assert.equal(valid, 0);
  eng.step(valid, true, t + 1 / 60, 1200, 800, 4 / 3);

  assert.equal(eng.slots[0].state, K.HAND_STATE.COASTING);
  assert.ok(Number.isFinite(eng.slots[0].interactiveX));
  assert.ok(Number.isFinite(eng.slots[0].pinchVel));
});

test('Chiral 3D palm-facing normal accepts both Left and Right open palms and rejects dorsal back-of-hand', () => {
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  const norm = new Float64Array(63);
  const world = new Float64Array(63);

  rig.buildPoseForTest({ isLeftLabel: true, dorsal: 0 }, norm, world);
  const cosRightPalm = K.computePalmFacingCosFlat(world, true, false);
  assert.ok(cosRightPalm > 0.85, `Expected Right open palm > +0.85, got ${cosRightPalm}`);

  rig.buildPoseForTest({ isLeftLabel: false, dorsal: 0 }, norm, world);
  const cosLeftPalm = K.computePalmFacingCosFlat(world, false, false);
  assert.ok(cosLeftPalm > 0.85, `Expected Left open palm > +0.85, got ${cosLeftPalm}`);

  rig.buildPoseForTest({ isLeftLabel: true, dorsal: 1.0 }, norm, world);
  const cosDorsal = K.computePalmFacingCosFlat(world, true, false);
  assert.ok(cosDorsal < -0.85, `Expected dorsal back-of-hand < -0.85, got ${cosDorsal}`);
});

test('Engagement FSM enforces keyboard exclusion (y >= 0.86), 200ms dwell, and 4-frame dropout coasting', () => {
  const eng = new K.KinematicEngine();
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;

  rig.camY = 0.91;
  let t = 0;
  for (let i = 0; i < 30; i++) {
    t += 1 / 60;
    eng.step(rig.stepAndPopulate(eng, 1 / 60, 4 / 3), true, t, 1000, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].state, K.HAND_STATE.IDLE);

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

  eng.updateConfig({ mappingMode: K.MAPPING_MODE.RELATIVE_CLUTCH });
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

test('Re-engage after standby restarts the 200ms arming dwell and the 1-Euro filter from the new position', () => {
  const eng = new K.KinematicEngine();
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  rig.mirrorX = 0.30;
  let t = runFrames(eng, rig, 0, 20);
  assert.equal(eng.slots[0].state, K.HAND_STATE.ARMED);

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
  assert.ok(Math.abs(prev - 593) < 25, `expected ~593 deg total twist, got ${prev}`);
});

test('SyntheticHandRig.resetPosture clears a leftover Auto Tour pose so the hand can arm again', () => {
  const eng = new K.KinematicEngine();
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  rig.autoTour = true;
  let t = runFrames(eng, rig, 0, 60 * 10);
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

test('Hand 2 (s1) arming during active Hand 1 (s0) drag never clobbers primary drag delta', () => {
  const eng = new K.KinematicEngine();
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  const n0 = new Float64Array(63);
  const w0 = new Float64Array(63);
  const n1 = new Float64Array(63);
  const w1 = new Float64Array(63);

  let t = 0;
  for (let i = 0; i < 18; i++) {
    t += 1 / 60;
    rig.buildPoseForTest({ rawCamX: 0.72, camY: 0.50, pinch: 0, isLeftLabel: true }, n0, w0);
    eng.setFlatCandidate(0, n0, w0, true, 4 / 3);
    eng.step(1, true, t, 1280, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].state, K.HAND_STATE.ARMED);

  for (let i = 0; i < 10; i++) {
    t += 1 / 60;
    const rawX = 0.72 - i * 0.008;
    rig.buildPoseForTest({ rawCamX: rawX, camY: 0.50, pinch: 1, isLeftLabel: true }, n0, w0);
    eng.setFlatCandidate(0, n0, w0, true, 4 / 3);
    eng.step(1, true, t, 1280, 800, 4 / 3);
  }
  for (let i = 0; i < 24; i++) {
    t += 1 / 60;
    rig.buildPoseForTest({ rawCamX: 0.648, camY: 0.50, pinch: 1, isLeftLabel: true }, n0, w0);
    eng.setFlatCandidate(0, n0, w0, true, 4 / 3);
    eng.step(1, true, t, 1280, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].pinchMode, K.PINCH_MODE.DRAG);

  let maxAbsSpike = 0;
  for (let i = 0; i < 22; i++) {
    t += 1 / 60;
    rig.buildPoseForTest({ rawCamX: 0.648, camY: 0.50, pinch: 1, isLeftLabel: true }, n0, w0);
    rig.buildPoseForTest({ rawCamX: 0.26, camY: 0.50, pinch: 0, isLeftLabel: false }, n1, w1);
    eng.setFlatCandidate(0, n0, w0, true, 4 / 3);
    eng.setFlatCandidate(1, n1, w1, false, 4 / 3);
    const ev = eng.step(2, true, t, 1280, 800, 4 / 3);
    maxAbsSpike = Math.max(maxAbsSpike, Math.abs(ev.dragDeltaX), Math.abs(ev.dragDeltaY));
  }
  assert.equal(eng.slots[1].state, K.HAND_STATE.ARMED, 'Hand 2 must finish arming');
  assert.ok(maxAbsSpike < 0.5, `Expected zero teleport spike (<0.5px) when Hand 2 arms, got ${maxAbsSpike.toFixed(2)}px`);
});

test('Two-hand pinch updates s0.interactiveX/Y live and cleans up s1.pinchMode on asymmetric release', () => {
  const eng = new K.KinematicEngine();
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  const n0 = new Float64Array(63);
  const w0 = new Float64Array(63);
  const n1 = new Float64Array(63);
  const w1 = new Float64Array(63);

  let t = 0;
  for (let i = 0; i < 18; i++) {
    t += 1 / 60;
    rig.buildPoseForTest({ rawCamX: 0.35, camY: 0.50, scale: 0.145, pinch: 0, isLeftLabel: true }, n0, w0);
    rig.buildPoseForTest({ rawCamX: 0.65, camY: 0.50, scale: 0.135, pinch: 0, isLeftLabel: false }, n1, w1);
    eng.setFlatCandidate(0, n0, w0, true, 4 / 3);
    eng.setFlatCandidate(1, n1, w1, false, 4 / 3);
    eng.step(2, true, t, 1200, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].state, K.HAND_STATE.ARMED);
  assert.equal(eng.slots[1].state, K.HAND_STATE.ARMED);

  const startScreenX = eng.slots[0].screenX;
  for (let i = 0; i < 12; i++) {
    t += 1 / 60;
    const shift = i * 0.008;
    rig.buildPoseForTest({ rawCamX: 0.35 + shift, camY: 0.50, scale: 0.145, pinch: 1, isLeftLabel: true }, n0, w0);
    rig.buildPoseForTest({ rawCamX: 0.65 - shift, camY: 0.50, scale: 0.135, pinch: 1, isLeftLabel: false }, n1, w1);
    eng.setFlatCandidate(0, n0, w0, true, 4 / 3);
    eng.setFlatCandidate(1, n1, w1, false, 4 / 3);
    eng.step(2, true, t, 1200, 800, 4 / 3);
  }
  assert.equal(eng.events.twoHandActive, true);
  assert.equal(eng.slots[0].pinchMode, K.PINCH_MODE.TWO_HAND);
  assert.equal(eng.slots[0].interactiveX, eng.slots[0].screenX, 's0.interactiveX must track s0.screenX in TWO_HAND');
  assert.ok(Math.abs(eng.slots[0].interactiveX - startScreenX) > 40, 's0.interactiveX must move during 2-hand zoom');

  rig.buildPoseForTest({ rawCamX: 0.438, camY: 0.50, scale: 0.145, pinch: 0, isLeftLabel: true }, n0, w0);
  rig.buildPoseForTest({ rawCamX: 0.562, camY: 0.50, scale: 0.135, pinch: 1, isLeftLabel: false }, n1, w1);
  t += 1 / 60;
  eng.setFlatCandidate(0, n0, w0, true, 4 / 3);
  eng.setFlatCandidate(1, n1, w1, false, 4 / 3);
  const evEnd = eng.step(2, true, t, 1200, 800, 4 / 3);
  assert.equal(evEnd.twoHandJustEnded, true);
  assert.equal(eng.slots[0].pinched, false);
  assert.equal(eng.slots[0].pinchMode, K.PINCH_MODE.NONE);
  assert.equal(eng.slots[1].pinched, true);
  assert.equal(eng.slots[1].pinchMode, K.PINCH_MODE.DRAG, 's1 must not remain stuck at PINCH_MODE.TWO_HAND');
});

test('Boundary & NaN guards: x=0 lockOrigin, ScopeRingBuffer NaN ry/sy & min capacity, posture/span NaN, step(5), and public API', () => {
  const tinyScope = new K.ScopeRingBuffer(1);
  assert.ok(tinyScope.capacity >= 4);

  const scope = new K.ScopeRingBuffer(64);
  for (let i = 0; i < 30; i++) {
    const j = (i % 2 === 0 ? 1 : -1) * 0.01;
    scope.push(0.5 + j, 0.5 - j, 0.5 + j * 0.1, 0.5 - j * 0.1, 0.2, 1.0, false);
  }
  const dbBefore = scope.attenuationDb;
  assert.ok(dbBefore < -12);
  scope.push(0.5, NaN, 0.5, 0.5, 0.2, 1.0, false);
  scope.push(0.5, 0.5, 0.5, NaN, 0.2, 1.0, false);
  assert.equal(scope.attenuationDb, dbBefore, 'NaN in ry or sy must not corrupt attenuationDb');

  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  const norm = new Float64Array(63);
  const world = new Float64Array(63);
  rig.buildPoseForTest({ vScroll: 1 }, norm, world);
  const spanNaN = K.computePalmSpanFlat(norm, NaN);
  assert.ok(Number.isFinite(spanNaN) && spanNaN > 0.05);
  assert.equal(K.detectVScrollPostureFlat(norm, spanNaN, 4 / 3, NaN), false);

  const f = new K.OneEuroFilter2D();
  f.filter(0.4, 0.4, 1.0, NaN, NaN, NaN);
  f.filter(0.5, 0.5, 1.02, NaN, NaN, NaN);
  assert.ok(Number.isFinite(f.cutoffHz) && Number.isFinite(f.x) && Number.isFinite(f.y));

  const eng = new K.KinematicEngine({ clickBreakoutPx: 0 });
  let t = 0;
  for (let i = 0; i < 18; i++) {
    t += 1 / 60;
    rig.buildPoseForTest({ rawCamX: 0.85, camY: 0.18, pinch: 0 }, norm, world);
    eng.setFlatCandidate(0, norm, world, true, 4 / 3);
    eng.step(1, true, t, 1000, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].state, K.HAND_STATE.ARMED);
  assert.equal(eng.slots[0].screenX, 0);
  assert.equal(eng.slots[0].screenY, 0);

  for (let i = 0; i < 4; i++) {
    t += 1 / 60;
    rig.buildPoseForTest({ rawCamX: 0.85, camY: 0.18, pinch: 1 }, norm, world);
    eng.setFlatCandidate(0, norm, world, true, 4 / 3);
    const ev = eng.step(1, true, t, 1000, 800, 4 / 3);
    assert.equal(eng.slots[0].lockOriginX, 0, 'lockOriginX at left edge must stay 0');
    assert.equal(eng.slots[0].lockOriginY, 0, 'lockOriginY at top edge must stay 0');
    assert.ok(Number.isFinite(eng.slots[0].interactiveX) && Number.isFinite(eng.slots[0].interactiveY));
    assert.ok(Number.isFinite(ev.dragDeltaX) && Number.isFinite(ev.dragDeltaY));
  }

  assert.doesNotThrow(() => {
    eng.step(5, true, NaN, 1000, 800, 4 / 3);
  });
  assert.ok(Number.isFinite(eng.slots[0].lastSeenSec));

  assert.ok(Number.isFinite(rig.sampleNoise()));
  eng.addScrollImpulse(300);
  const evImp = eng.step(0, false, t + 1 / 60, 1000, 800, 4 / 3);
  assert.ok(evImp.scrollVelocityPx > 250);
  eng.stepPointerSample(0.35, 0.65, t + 2 / 60);
  assert.ok(Math.abs(eng.slots[0].rawU - 0.35) < 1e-6);
  eng.resetSlot(0);
  assert.equal(eng.slots[0].state, K.HAND_STATE.IDLE);
});

test('RELATIVE_CLUTCH fist during CLICK_LOCK emits pinchRelease & !keepAlive / COASTING clear transient flags', () => {
  const eng = new K.KinematicEngine({ mappingMode: K.MAPPING_MODE.RELATIVE_CLUTCH });
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  const norm = new Float64Array(63);
  const world = new Float64Array(63);

  let t = 0;
  for (let i = 0; i < 18; i++) {
    t += 1 / 60;
    rig.buildPoseForTest({ rawCamX: 0.5, camY: 0.5, pinch: 0 }, norm, world);
    eng.setFlatCandidate(0, norm, world, true, 4 / 3);
    eng.step(1, true, t, 1200, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].state, K.HAND_STATE.ARMED);

  t += 1 / 60;
  rig.buildPoseForTest({ rawCamX: 0.5, camY: 0.5, pinch: 1, rollRad: 0 }, norm, world);
  eng.setFlatCandidate(0, norm, world, true, 4 / 3);
  eng.step(1, true, t, 1200, 800, 4 / 3);
  assert.equal(eng.slots[0].pinchMode, K.PINCH_MODE.CLICK_LOCK);

  t += 1 / 60;
  rig.buildPoseForTest({ rawCamX: 0.5, camY: 0.5, pinch: 1, rollRad: -0.35 }, norm, world);
  eng.setFlatCandidate(0, norm, world, true, 4 / 3);
  eng.step(1, true, t, 1200, 800, 4 / 3);
  assert.equal(eng.slots[0].twistBrokenOut, true);

  t += 1 / 60;
  rig.buildPoseForTest({ rawCamX: 0.5, camY: 0.5, pinch: 0, fist: 1, rollRad: -0.35 }, norm, world);
  eng.setFlatCandidate(0, norm, world, true, 4 / 3);
  const evFist = eng.step(1, true, t, 1200, 800, 4 / 3);
  assert.equal(eng.slots[0].pinched, false);
  assert.equal(evFist.pinchRelease, true, 'Fist cancelling CLICK_LOCK must emit pinchRelease');
  assert.equal(eng.slots[0].twistBrokenOut, false);
  assert.equal(eng.slots[0].twistTotalDeg, 0);

  t += 1 / 60;
  rig.buildPoseForTest({ rawCamX: 0.5, camY: 0.5, pinch: 0, fist: 0 }, norm, world);
  eng.setFlatCandidate(0, norm, world, true, 4 / 3);
  eng.step(1, true, t, 1200, 800, 4 / 3);

  t += 1 / 60;
  rig.buildPoseForTest({ rawCamX: 0.5, camY: 0.5, pinch: 1, rollRad: -0.4 }, norm, world);
  eng.setFlatCandidate(0, norm, world, true, 4 / 3);
  eng.step(1, true, t, 1200, 800, 4 / 3);

  t += 1 / 60;
  rig.buildPoseForTest({ rawCamX: 0.5, camY: 0.97, pinch: 1, rollRad: -0.4 }, norm, world);
  eng.setFlatCandidate(0, norm, world, true, 4 / 3);
  const evDrop = eng.step(1, true, t, 1200, 800, 4 / 3);
  assert.equal(evDrop.justDisarmed, true);
  assert.equal(evDrop.pinchRelease, true);
  assert.equal(eng.slots[0].twistBrokenOut, false);
  assert.equal(eng.slots[0].twistTotalDeg, 0);
  assert.equal(eng.slots[0].clutchReleased, false);
  assert.equal(eng.slots[0].velocityDamped, false);

  eng.updateConfig({ mappingMode: K.MAPPING_MODE.ABSOLUTE_ROI });
  for (let i = 0; i < 18; i++) {
    t += 1 / 60;
    rig.buildPoseForTest({ rawCamX: 0.5, camY: 0.45, vScroll: 1 }, norm, world);
    eng.setFlatCandidate(0, norm, world, true, 4 / 3);
    eng.step(1, true, t, 1200, 800, 4 / 3);
  }
  assert.equal(eng.slots[0].vWasActive, true);
  t += 1 / 60;
  eng.step(0, true, t, 1200, 800, 4 / 3);
  assert.equal(eng.slots[0].state, K.HAND_STATE.COASTING);
  assert.equal(eng.slots[0].vWasActive, false, 'COASTING must reset vWasActive');
  t += 1 / 60;
  rig.buildPoseForTest({ rawCamX: 0.5, camY: 0.70, vScroll: 1 }, norm, world);
  eng.setFlatCandidate(0, norm, world, true, 4 / 3);
  const evReappear = eng.step(1, true, t, 1200, 800, 4 / 3);
  assert.equal(evReappear.scrollVelocityPx, 0, 'First frame back from COASTING must re-seed vPrevMidY without spiking');
});

test('SyntheticHandRig AutoTour exercises all 4 phases including Phase 1 zero-slip clickFired', () => {
  const eng = new K.KinematicEngine();
  const rig = new K.SyntheticHandRig();
  rig.noiseSigma = 0;
  rig.autoTour = true;

  let t = 0;
  let phase1Clicks = 0;
  let maxTwistAbs = 0;
  let sawVScroll = false;
  let sawTwoHand = false;

  for (let i = 0; i < 720; i++) {
    const dt = 1 / 60;
    t += dt;
    const count = rig.stepAndPopulate(eng, dt, 4 / 3);
    const ev = eng.step(count, true, t, 1280, 800, 4 / 3);
    if (rig.tourTimeSec < 3.0 && ev.clickFired) phase1Clicks++;
    if (rig.tourTimeSec >= 3.0 && rig.tourTimeSec < 6.0) {
      maxTwistAbs = Math.max(maxTwistAbs, Math.abs(eng.slots[0].twistTotalDeg));
    }
    if (rig.tourTimeSec >= 6.0 && rig.tourTimeSec < 9.0 && eng.slots[0].vScrollActive && Math.abs(ev.scrollVelocityPx) > 20) {
      sawVScroll = true;
    }
    if (rig.tourTimeSec >= 9.0 && ev.twoHandActive) {
      sawTwoHand = true;
    }
  }

  assert.ok(phase1Clicks >= 1, `Expected >=1 Phase 1 clickFired in AutoTour, got ${phase1Clicks}`);
  assert.ok(maxTwistAbs > 25, `Expected Phase 2 twist > 25 deg, got ${maxTwistAbs.toFixed(1)} deg`);
  assert.equal(sawVScroll, true, 'Expected Phase 3 V-Scroll activation');
  assert.equal(sawTwoHand, true, 'Expected Phase 4 2-hand zoom/steer activation');
});

test('HandTrackerController stops tracks on loader failure / stale epoch / teardown and coalesces startups', async () => {
  function makeMockTrack() {
    const listeners = {};
    return {
      stopped: false,
      stop() { this.stopped = true; },
      addEventListener(type, fn) { listeners[type] = fn; },
      removeEventListener(type, fn) { if (listeners[type] === fn) delete listeners[type]; },
      emitEnded() { if (listeners.ended) listeners.ended(); },
    };
  }
  function makeMockVideo() {
    const classes = new Set();
    return {
      srcObject: null,
      playsInline: false,
      muted: false,
      videoWidth: 640,
      videoHeight: 480,
      readyState: 4,
      currentTime: 0.1,
      classList: {
        add(c) { classes.add(c); },
        remove(c) { classes.delete(c); },
        toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
        contains(c) { return classes.has(c); },
      },
      play() { return Promise.resolve(); },
    };
  }

  // Case A: getUserMedia resolves BEFORE loadVision rejects -> stream tracks MUST stop (zero leak)
  {
    const trackA = makeMockTrack();
    const eng = new K.KinematicEngine();
    const rig = new K.SyntheticHandRig();
    const tracker = new T.HandTrackerController(eng, rig, makeMockVideo(), {
      mediaDevices: {
        getUserMedia: () => Promise.resolve({ getTracks: () => [trackA] }),
      },
      loadVision: () => new Promise((_, reject) => setTimeout(() => reject(new Error('WASM offline')), 5)),
    });
    const ok = await tracker.enableWebcam(T.TRACKER_MODE.IDLE);
    assert.equal(ok, false);
    assert.equal(trackA.stopped, true, 'Track must stop when loader rejects after getUserMedia resolved');
    assert.equal(tracker.mode, T.TRACKER_MODE.IDLE);
    assert.ok(!tracker.cameraError.includes('Synthetic Hand Rig active'), 'IDLE fallback must not claim Synth Rig active');
  }

  // Case B: loadVision rejects BEFORE getUserMedia resolves -> late-resolving stream MUST stop immediately
  {
    const trackB = makeMockTrack();
    let resolveGum;
    const eng = new K.KinematicEngine();
    const rig = new K.SyntheticHandRig();
    const tracker = new T.HandTrackerController(eng, rig, makeMockVideo(), {
      mediaDevices: {
        getUserMedia: () => new Promise((res) => { resolveGum = res; }),
      },
      loadVision: () => Promise.reject(new Error('CDN blocked')),
    });
    const ok = await tracker.enableWebcam(T.TRACKER_MODE.SYNTH);
    assert.equal(ok, false);
    resolveGum({ getTracks: () => [trackB] });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(trackB.stopped, true, 'Late-resolving getUserMedia track must stop after earlier loader failure');
  }

  // Case C: Double-click coalescing + teardown() mid-flight (simulating pagehide)
  {
    const trackC = makeMockTrack();
    let gumCalls = 0;
    let resolveGum;
    const eng = new K.KinematicEngine();
    const rig = new K.SyntheticHandRig();
    const tracker = new T.HandTrackerController(eng, rig, makeMockVideo(), {
      mediaDevices: {
        getUserMedia: () => {
          gumCalls++;
          return new Promise((res) => { resolveGum = res; });
        },
      },
      loadVision: () => Promise.resolve({ detectForVideo: () => ({ landmarks: [] }), delegateUsed: 'GPU' }),
    });
    const p1 = tracker.enableWebcam(T.TRACKER_MODE.SYNTH);
    assert.equal(tracker.isWebcamStarting, true);
    const p2 = tracker.enableWebcam(T.TRACKER_MODE.SYNTH);
    assert.equal(p1, p2, 'Concurrent enableWebcam calls must coalesce');
    assert.equal(gumCalls, 1, 'getUserMedia must only be invoked once');

    const prevEpoch = tracker.sessionEpoch;
    tracker.teardown();
    assert.ok(tracker.sessionEpoch > prevEpoch, 'teardown() must increment sessionEpoch');
    resolveGum({ getTracks: () => [trackC] });
    const res = await p1;
    assert.equal(res, false);
    assert.equal(trackC.stopped, true, 'teardown() must stop late-resolving stream');
  }

  // Case D: Video handoff resets lastVideoTime, detectForVideo throw is caught, and track.ended falls back
  {
    const trackD = makeMockTrack();
    const vid1 = makeMockVideo();
    const vid2 = makeMockVideo();
    const eng = new K.KinematicEngine();
    const rig = new K.SyntheticHandRig();
    let shouldThrow = true;
    const tracker = new T.HandTrackerController(eng, rig, vid1, {
      mediaDevices: {
        getUserMedia: () => Promise.resolve({ getTracks: () => [trackD] }),
      },
      loadVision: () => Promise.resolve({
        delegateUsed: 'GPU',
        detectForVideo: () => {
          if (shouldThrow) throw new Error('Transient WebGL texture loss');
          return { landmarks: [] };
        },
      }),
    });
    const ok = await tracker.enableWebcam(T.TRACKER_MODE.SYNTH);
    assert.equal(ok, true);
    assert.doesNotThrow(() => tracker.tick(100, 1280, 800));
    shouldThrow = false;
    tracker.setVideoElement(vid2);
    assert.equal(tracker.lastVideoTime, -1, 'setVideoElement must reset lastVideoTime');
    assert.equal(vid1.srcObject, null);
    assert.ok(vid2.srcObject !== null);

    trackD.emitEnded();
    assert.equal(tracker.cameraStatus, T.CAMERA_STATUS.ERROR);
    assert.equal(tracker.mode, T.TRACKER_MODE.SYNTH);
  }
});

test('Multi-portal hash transitions, popstate+hashchange VT deduplication, AbortError safety, SVG class, and Cell 07 Flick isolation', async () => {
  function createEl(tag, ns) {
    const attrs = {};
    const listeners = {};
    const classes = new Set();
    const el = {
      tagName: String(tag).toUpperCase(),
      namespaceURI: ns || null,
      id: '',
      hidden: false,
      disabled: false,
      textContent: '',
      value: '',
      scrollTop: 0,
      style: {},
      dataset: {},
      children: [],
      parentNode: null,
      nextSibling: null,
      classList: {
        add(...cs) { cs.forEach((c) => c && classes.add(c)); },
        remove(...cs) { cs.forEach((c) => classes.delete(c)); },
        toggle(c, force) {
          const on = force !== undefined ? Boolean(force) : !classes.has(c);
          if (on) classes.add(c); else classes.delete(c);
          return on;
        },
        contains(c) { return classes.has(c); },
      },
      setAttribute(k, v) {
        attrs[k] = String(v);
        if (k === 'id') el.id = String(v);
        if (k === 'hidden') el.hidden = true;
        if (k === 'class') {
          classes.clear();
          String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
        }
      },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
      appendChild(child) {
        if (!child || typeof child !== 'object') return child;
        child.parentNode = el;
        if (el.children.length > 0) el.children[el.children.length - 1].nextSibling = child;
        el.children.push(child);
        return child;
      },
      insertBefore(node, ref) {
        node.parentNode = el;
        const idx = ref ? el.children.indexOf(ref) : -1;
        if (idx >= 0) el.children.splice(idx, 0, node);
        else el.children.push(node);
        return node;
      },
      addEventListener(type, fn) {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(fn);
      },
      dispatchEvent(ev) {
        const list = listeners[ev.type] || [];
        ev.target = ev.target || el;
        ev.preventDefault = ev.preventDefault || function () {};
        ev.stopPropagation = ev.stopPropagation || function () {};
        list.forEach((fn) => fn(ev));
        return true;
      },
      click() {
        el.dispatchEvent({ type: 'click', target: el });
      },
      focus() {
        doc.activeElement = el;
      },
      closest(sel) {
        if (sel === 'main.grid') return mainGrid;
        if (sel.includes('button') && el.tagName === 'BUTTON') return el;
        return null;
      },
      querySelector(sel) {
        return findFirst(el, sel);
      },
      getBoundingClientRect() {
        return el.rectOverride || { left: 0, top: 0, right: 300, bottom: 225, width: 300, height: 225 };
      },
      getContext() {
        return new Proxy({}, { get: () => function () {} });
      },
    };
    Object.defineProperty(el, 'className', {
      get() { return Array.from(classes).join(' '); },
      set(v) {
        classes.clear();
        String(v || '').split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
      },
    });
    return el;
  }

  function matchesSimple(node, sel) {
    if (!node || !node.tagName) return false;
    if (sel === 'input') return node.tagName === 'INPUT';
    if (sel === 'main.grid') return node.tagName === 'MAIN' && node.classList.contains('grid');
    if (sel === 'dialog[open]') return node.tagName === 'DIALOG' && Boolean(node.open);
    if (sel === '[id$="-page"]:not([hidden])') {
      return Boolean(node.id && node.id.endsWith('-page') && !node.hidden);
    }
    if (sel.startsWith('#')) return node.id === sel.slice(1);
    if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
    return false;
  }

  function findFirst(root, sel) {
    if (!root || !root.children) return null;
    for (let i = 0; i < root.children.length; i++) {
      const c = root.children[i];
      if (matchesSimple(c, sel)) return c;
      const hit = findFirst(c, sel);
      if (hit) return hit;
    }
    return null;
  }

  function findByText(root, text) {
    if (!root) return null;
    if (root.textContent === text && root.tagName === 'BUTTON') return root;
    if (!root.children) return null;
    for (let i = 0; i < root.children.length; i++) {
      const hit = findByText(root.children[i], text);
      if (hit) return hit;
    }
    return null;
  }

  const body = createEl('body');
  const mainGrid = createEl('main');
  mainGrid.className = 'grid';
  const portalCell = createEl('section');
  portalCell.id = 'cell-hand-gesture';
  portalCell.className = 'cell cell--hand-gesture';
  const lgPage = createEl('section');
  lgPage.id = 'left-grille-page';
  lgPage.className = 'lg-secondary-page';
  lgPage.hidden = true;
  const lgBackBtn = createEl('button');
  lgBackBtn.textContent = 'LG Back';
  lgPage.appendChild(lgBackBtn);

  mainGrid.appendChild(portalCell);
  body.appendChild(mainGrid);
  body.appendChild(lgPage);

  const winListeners = {};
  const docListeners = {};
  const locationObj = { hash: '', pathname: '/', search: '' };
  let vtCalls = 0;
  let activeVtAbort = null;
  const pendingCallbacks = [];

  const doc = {
    readyState: 'complete',
    hidden: false,
    body,
    activeElement: body,
    createElement: (t) => createEl(t),
    createElementNS: (ns, t) => createEl(t, ns),
    createTextNode: (txt) => ({ nodeType: 3, textContent: String(txt) }),
    getElementById: (id) => findFirst(body, '#' + id),
    querySelector: (sel) => findFirst(body, sel),
    addEventListener(type, fn) {
      if (!docListeners[type]) docListeners[type] = [];
      docListeners[type].push(fn);
    },
    startViewTransition(cb) {
      vtCalls++;
      if (activeVtAbort) activeVtAbort();
      let rejectReady;
      let rejectFinished;
      let resolveReady;
      let resolveFinished;
      const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
      const finished = new Promise((res, rej) => { resolveFinished = res; rejectFinished = rej; });
      let aborted = false;
      activeVtAbort = () => {
        if (aborted) return;
        aborted = true;
        const err = new Error('Transition was skipped');
        err.name = 'AbortError';
        rejectReady(err);
        rejectFinished(err);
      };
      pendingCallbacks.push(() => {
        cb();
        if (!aborted) {
          resolveReady();
          resolveFinished();
          activeVtAbort = null;
        }
      });
      return { ready, updateCallbackDone: Promise.resolve(), finished };
    },
  };

  let rafCallback = null;
  let nextRafId = 1;
  const sandbox = {
    window: null,
    globalThis: null,
    document: doc,
    location: locationObj,
    navigator: {},
    performance: { now: () => 1000 },
    Event: function (type) { this.type = type; },
    HandGestureKinematics: K,
    HandGestureTracker: T,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (fn) => { rafCallback = fn; return nextRafId++; },
    cancelAnimationFrame: () => { rafCallback = null; },
    scrollBy: () => {},
    scrollTo: () => {},
    scrollY: 0,
    setTimeout,
    clearTimeout,
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 2,
    addEventListener(type, fn) {
      if (!winListeners[type]) winListeners[type] = [];
      winListeners[type].push(fn);
    },
    history: {
      pushState(_s, _t, url) { locationObj.hash = url; },
      replaceState() { locationObj.hash = ''; },
      back() {
        locationObj.hash = '';
        (winListeners.popstate || []).forEach((fn) => fn({ type: 'popstate' }));
        (winListeners.hashchange || []).forEach((fn) => fn({ type: 'hashchange' }));
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const uiCode = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');
  vm.runInNewContext(uiCode, sandbox, { filename: 'ui.js' });

  const hgPage = findFirst(body, '#hand-gesture-page');
  assert.ok(hgPage, 'Expected #hand-gesture-page to mount');

  // Verify svgEl wrote `class` (not `className`) on `.hg-spatial-chord` and `.hg-mini-svg`
  const chordSvg = findFirst(body, '.hg-spatial-chord');
  const miniSvg = findFirst(portalCell, '.hg-mini-svg');
  assert.ok(chordSvg && chordSvg.getAttribute('class') === 'hg-spatial-chord');
  assert.ok(miniSvg && miniSvg.getAttribute('class') === 'hg-mini-svg');

  // 1. Open Studio via `Studio ↗` -> 1 VT; flush callback
  const studioBtn = findByText(portalCell, 'Studio ↗');
  studioBtn.click();
  assert.equal(vtCalls, 1);
  while (pendingCallbacks.length) pendingCallbacks.shift()();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(mainGrid.hidden, true);
  assert.equal(hgPage.hidden, false);

  // 2. Click `← Grid` -> triggers history.back() firing BOTH popstate + hashchange before VT callback runs!
  vtCalls = 0;
  const backBtn = findByText(hgPage, '← Grid');
  backBtn.click();
  assert.equal(vtCalls, 1, 'popstate + hashchange must coalesce to exactly 1 startViewTransition');
  if (activeVtAbort) activeVtAbort();
  while (pendingCallbacks.length) pendingCallbacks.shift()();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(mainGrid.hidden, false);
  assert.equal(hgPage.hidden, true);

  // 3. Re-open #hand-gesture, then navigate cross-portal `#hand-gesture` -> `#left-grille`
  studioBtn.click();
  while (pendingCallbacks.length) pendingCallbacks.shift()();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(hgPage.hidden, false);

  vtCalls = 0;
  locationObj.hash = '#left-grille';
  mainGrid.hidden = true;
  lgPage.hidden = false;
  lgBackBtn.focus();
  (winListeners.hashchange || []).forEach((fn) => fn({ type: 'hashchange' }));
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(vtCalls, 0, 'Cross-cell hash switch must not launch a competing ViewTransition');
  assert.equal(hgPage.hidden, true, '#hand-gesture-page must hide');
  assert.equal(lgPage.hidden, false, '#left-grille-page must stay visible');
  assert.equal(mainGrid.hidden, true, 'main.grid must remain hidden behind #left-grille-page');
  assert.equal(doc.activeElement, lgBackBtn, 'Cross-cell hash close must not steal focus back to Studio ↗');

  // 4. Navigate `#left-grille` -> `#hand-gesture` and verify Cell 07 Flick ↓ does not hijack Cell 06 fader
  lgPage.hidden = true;
  locationObj.hash = '#hand-gesture';
  (winListeners.hashchange || []).forEach((fn) => fn({ type: 'hashchange' }));
  assert.equal(hgPage.hidden, false);

  const wbCells = hgPage.querySelector('.hg-workbench-grid').children;
  wbCells.forEach((cell, idx) => {
    cell.rectOverride = idx === 5
      ? { left: 400, top: 200, right: 900, bottom: 600, width: 500, height: 400 }
      : { left: 0, top: 0, right: 50, bottom: 50, width: 50, height: 50 };
  });
  let simTimeMs = 1000;
  for (let i = 0; i < 20; i++) {
    simTimeMs += 16.67;
    if (rafCallback) rafCallback(simTimeMs);
  }
  const faderSlider = findFirst(wbCells[5], '.hg-fader-track-wrap');
  const faderBefore = faderSlider.getAttribute('aria-valuenow');
  const tapeList = findFirst(wbCells[6], '.hg-tape-list');
  const flickDownBtn = findByText(wbCells[6], 'Flick ↓');
  flickDownBtn.click();
  for (let i = 0; i < 5; i++) {
    simTimeMs += 16.67;
    if (rafCallback) rafCallback(simTimeMs);
  }
  assert.equal(faderSlider.getAttribute('aria-valuenow'), faderBefore, 'Cell 07 Flick ↓ must not move Cell 06 fader');
  assert.ok(tapeList.scrollTop > 20, `Expected Cell 07 tape scrollTop > 20 after Flick ↓, got ${tapeList.scrollTop}`);
});
