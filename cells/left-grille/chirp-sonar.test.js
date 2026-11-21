/**
 * Acoustic Physics & FMCW Sonar DSP Test Suite (`cells/left-grille/chirp-sonar.test.js`)
 *
 * Run: `timeout 60 node --test cells/left-grille/chirp-sonar.test.js`
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  ChirpSonarEngine,
  StereoChirpGenerator,
  synthesizeGestureSignal,
  fftRadix2,
  constants
} = require('./chirp-sonar.js');

function feedInChunks(engine, samples, sampleRate, chunkSize) {
  const events = [];
  const frames = [];
  const step = chunkSize || 512;
  let t = 0;
  for (let i = 0; i < samples.length; i += step) {
    const slice = samples.subarray(i, Math.min(i + step, samples.length));
    t += slice.length / sampleRate;
    const res = engine.processBlock(slice, sampleRate, t);
    if (res) {
      frames.push(res);
      if (res.gestureEvent) events.push(res.gestureEvent);
    }
  }
  return { events, frames };
}

test('StereoChirpGenerator emits click-free FDMA 18.0-20.5 kHz chirps and mutes < 40 kHz', () => {
  const gen = new StereoChirpGenerator({ gain: 0.04 });
  const sr = 48000;
  const N = 1024;
  const outL = new Float32Array(N);
  const outR = new Float32Array(N);

  // 1. Sub-40 kHz Bluetooth HFP safety: strictly silent
  gen.fillBuffers(outL, outR, 16000, 0);
  assert.equal(outL.reduce((a, b) => a + Math.abs(b), 0), 0);
  assert.equal(outR.reduce((a, b) => a + Math.abs(b), 0), 0);

  gen.fillBuffers(outL, outR, 32000, 0);
  assert.equal(outL.reduce((a, b) => a + Math.abs(b), 0), 0);
  assert.equal(outR.reduce((a, b) => a + Math.abs(b), 0), 0);

  // 2. 48 kHz active FDMA stereo chirps
  gen.fillBuffers(outL, outR, sr, 0);
  const maxL = Math.max(...Array.from(outL, Math.abs));
  const maxR = Math.max(...Array.from(outR, Math.abs));
  assert.ok(maxL > 0.035 && maxL <= 0.041, `Left peak ${maxL} should be ~0.04`);
  assert.ok(maxR > 0.035 && maxR <= 0.041, `Right peak ${maxR} should be ~0.04`);

  // Zero-click edge continuity (Hann window starts/ends at exact 0)
  assert.ok(Math.abs(outL[0]) < 1e-6, 'Left chirp must start at 0');
  assert.ok(Math.abs(outR[0]) < 1e-6, 'Right chirp must start at 0');
  assert.ok(Math.abs(outL[N - 1]) < 1e-6, 'Left period must end at 0');
  assert.ok(Math.abs(outR[N - 1]) < 1e-6, 'Right period must end at 0');

  // Verify spectral energy resides inside [18.0-19.15 kHz] (L) and [19.35-20.5 kHz] (R)
  // with negligible audible (< 16 kHz) leakage
  function bandPowerRatio(buf, fLo, fHi) {
    const re = Float64Array.from(buf);
    const im = new Float64Array(N);
    fftRadix2(re, im);
    let inBand = 0;
    let audible = 0;
    let total = 0;
    for (let k = 1; k < N / 2; k++) {
      const freq = (k * sr) / N;
      const p = re[k] * re[k] + im[k] * im[k];
      total += p;
      if (freq >= fLo && freq <= fHi) inBand += p;
      if (freq < 16500) audible += p;
    }
    return { inBandFrac: inBand / total, audibleFrac: audible / total };
  }

  const specL = bandPowerRatio(outL, 17850, 19300);
  const specR = bandPowerRatio(outR, 19200, 20650);
  assert.ok(specL.inBandFrac > 0.99, `Left band concentration ${specL.inBandFrac}`);
  assert.ok(specR.inBandFrac > 0.99, `Right band concentration ${specR.inBandFrac}`);
  assert.ok(specL.audibleFrac < 1e-4, `Left audible leakage ${specL.audibleFrac}`);
  assert.ok(specR.audibleFrac < 1e-4, `Right audible leakage ${specR.audibleFrac}`);

  // Cross-channel isolation across continuous 512-sample chunks
  const c1L = new Float32Array(512);
  const c1R = new Float32Array(512);
  const c2L = new Float32Array(512);
  const c2R = new Float32Array(512);
  gen.fillBuffers(c1L, c1R, sr, 0);
  gen.fillBuffers(c2L, c2R, sr, 512);
  for (let i = 0; i < 512; i++) {
    assert.ok(Math.abs(c1L[i] - outL[i]) < 1e-7);
    assert.ok(Math.abs(c2L[i] - outL[i + 512]) < 1e-7);
    assert.ok(Math.abs(c1R[i] - outR[i]) < 1e-7);
    assert.ok(Math.abs(c2R[i] - outR[i + 512]) < 1e-7);
  }
});

test('Matched-filter pulse compression measures exact target distance across 6..46 cm and populates 24-bin profile', () => {
  for (const targetCm of [8, 18, 30, 44]) {
    const engine = new ChirpSonarEngine({ sampleRate: 48000, autoAlignDirectPath: false });
    const synth = synthesizeGestureSignal('static-target', {
      sampleRate: 48000,
      targetRangeCm: targetCm,
      warmupFrames: 8,
      gestureFrames: 12,
      tailFrames: 2,
      noiseStd: 0.0001
    });

    const { frames } = feedInChunks(engine, synth.samples, 48000, 512);
    const active = frames.filter((f) => f.warmedUp && f.handPresent && f.rangeCm !== null);
    assert.ok(active.length >= 6, `Expected active detection at ${targetCm} cm`);

    const mid = active[Math.floor(active.length / 2)];
    assert.equal(mid.rangeProfile.length, constants.DEFAULT_NUM_BINS);
    assert.ok(
      Math.abs(mid.rangeCm - targetCm) <= 2.0,
      `Target ${targetCm} cm measured as ${mid.rangeCm.toFixed(2)} cm`
    );

    // Check 24-bin range profile peaks in the matching bin (±1 bin tolerance)
    let peakBin = 0;
    for (let b = 1; b < mid.rangeProfile.length; b++) {
      if (mid.rangeProfile[b] > mid.rangeProfile[peakBin]) peakBin = b;
    }
    const expectedBin = Math.floor(
      ((targetCm - constants.MIN_RANGE_CM) / (constants.MAX_RANGE_CM - constants.MIN_RANGE_CM)) *
        constants.DEFAULT_NUM_BINS
    );
    assert.ok(
      Math.abs(peakBin - expectedBin) <= 1,
      `Target ${targetCm} cm peaked at bin ${peakBin}, expected ~${expectedBin}`
    );
  }
});

test('Adaptive complex clutter cancellation rejects static room reflectors with zero false gestures', () => {
  const engine = new ChirpSonarEngine({ sampleRate: 48000, autoAlignDirectPath: false });
  const synth = synthesizeGestureSignal('clutter-only', {
    sampleRate: 48000,
    warmupFrames: 8,
    gestureFrames: 36,
    tailFrames: 8,
    directGainL: 0.55,
    directGainR: 0.45,
    clutterReflectors: [
      { rangeCm: 14, gainL: 0.35, gainR: 0.25 },
      { rangeCm: 29, gainL: 0.28, gainR: 0.32 },
      { rangeCm: 47, gainL: 0.20, gainR: 0.18 }
    ],
    noiseStd: 0.0002
  });

  const { events, frames } = feedInChunks(engine, synth.samples, 48000, 512);
  assert.equal(events.length, 0, `Expected 0 false gestures on static clutter, got ${JSON.stringify(events)}`);

  const postWarmup = frames.slice(12);
  const falseDetections = postWarmup.filter((f) => f.handPresent);
  assert.equal(falseDetections.length, 0, 'Static clutter must not trigger handPresent after warmup');
});

test('Detects PUSH IN (42 cm -> 10 cm) on synthesized 48 kHz stereo chirp echoes with static clutter', () => {
  const engine = new ChirpSonarEngine({ sampleRate: 48000, autoAlignDirectPath: false });
  const synth = synthesizeGestureSignal('push', {
    sampleRate: 48000,
    startCm: 42,
    endCm: 10,
    warmupFrames: 10,
    gestureFrames: 24,
    tailFrames: 10
  });

  const { events, frames } = feedInChunks(engine, synth.samples, 48000, 512);
  assert.equal(events.length, 1, `Expected 1 push event, got ${JSON.stringify(events)}`);
  assert.equal(events[0].type, 'push');
  assert.equal(events[0].label, 'PUSH IN ↓');
  assert.ok(events[0].deltaCm < -15, `Expected negative deltaCm, got ${events[0].deltaCm}`);
  assert.ok(events[0].velocityCms < -20, `Expected negative velocity, got ${events[0].velocityCms}`);

  const tracked = frames.filter((f) => f.handPresent && f.rangeCm !== null);
  assert.ok(tracked.length >= 12);
  assert.ok(tracked[0].rangeCm > tracked[tracked.length - 1].rangeCm + 15);
});

test('Detects PULL OUT (10 cm -> 42 cm) on synthesized 48 kHz stereo chirp echoes with static clutter', () => {
  const engine = new ChirpSonarEngine({ sampleRate: 48000, autoAlignDirectPath: false });
  const synth = synthesizeGestureSignal('pull', {
    sampleRate: 48000,
    startCm: 10,
    endCm: 42,
    warmupFrames: 10,
    gestureFrames: 24,
    tailFrames: 10
  });

  const { events, frames } = feedInChunks(engine, synth.samples, 48000, 512);
  assert.equal(events.length, 1, `Expected 1 pull event, got ${JSON.stringify(events)}`);
  assert.equal(events[0].type, 'pull');
  assert.equal(events[0].label, 'PULL OUT ↑');
  assert.ok(events[0].deltaCm > 15, `Expected positive deltaCm, got ${events[0].deltaCm}`);
  assert.ok(events[0].velocityCms > 20, `Expected positive velocity, got ${events[0].velocityCms}`);

  const tracked = frames.filter((f) => f.handPresent && f.rangeCm !== null);
  assert.ok(tracked.length >= 12);
  assert.ok(tracked[tracked.length - 1].rangeCm > tracked[0].rangeCm + 15);
});

test('Detects WAVE RIGHT (L -> R) via cross-channel stereo echo centroid & balance shift', () => {
  const engine = new ChirpSonarEngine({ sampleRate: 48000, autoAlignDirectPath: false });
  const synth = synthesizeGestureSignal('wave-right', {
    sampleRate: 48000,
    warmupFrames: 10,
    gestureFrames: 24,
    tailFrames: 10
  });

  const { events } = feedInChunks(engine, synth.samples, 48000, 512);
  assert.equal(events.length, 1, `Expected 1 wave-right event, got ${JSON.stringify(events)}`);
  assert.equal(events[0].type, 'wave-right');
  assert.equal(events[0].label, 'WAVE →');
  assert.ok(events[0].dtLRMs > 40, `Expected positive L->R centroid lag, got ${events[0].dtLRMs} ms`);
  assert.ok(events[0].balanceShift > 0.4, `Expected positive L->R balance shift, got ${events[0].balanceShift}`);
});

test('Detects WAVE LEFT (R -> L) via cross-channel stereo echo centroid & balance shift', () => {
  const engine = new ChirpSonarEngine({ sampleRate: 48000, autoAlignDirectPath: false });
  const synth = synthesizeGestureSignal('wave-left', {
    sampleRate: 48000,
    warmupFrames: 10,
    gestureFrames: 24,
    tailFrames: 10
  });

  const { events } = feedInChunks(engine, synth.samples, 48000, 512);
  assert.equal(events.length, 1, `Expected 1 wave-left event, got ${JSON.stringify(events)}`);
  assert.equal(events[0].type, 'wave-left');
  assert.equal(events[0].label, 'WAVE ←');
  assert.ok(events[0].dtLRMs < -40, `Expected negative R->L centroid lag, got ${events[0].dtLRMs} ms`);
  assert.ok(events[0].balanceShift < -0.4, `Expected negative R->L balance shift, got ${events[0].balanceShift}`);
});

test('Auto direct-path hardware latency alignment cancels arbitrary loopback offset', () => {
  const engine = new ChirpSonarEngine({ sampleRate: 48000, autoAlignDirectPath: true });
  const hardwareLoopbackLag = 213; // ~4.4 ms arbitrary CoreAudio loopback latency
  const synth = synthesizeGestureSignal('push', {
    sampleRate: 48000,
    directLag: hardwareLoopbackLag,
    directGainL: 0.48,
    directGainR: 0.42,
    startCm: 40,
    endCm: 11,
    warmupFrames: 10,
    gestureFrames: 24,
    tailFrames: 10
  });

  const { events } = feedInChunks(engine, synth.samples, 48000, 512);
  assert.equal(engine.directPathLocked, true);
  assert.ok(
    Math.abs(engine.directLagL - hardwareLoopbackLag) <= 1,
    `Expected directLagL ~${hardwareLoopbackLag}, got ${engine.directLagL}`
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'push');
});

test('Sample-rate resilience (44.1 kHz, 96 kHz, 16 kHz disable) and NaN/Infinity input sanitization', () => {
  // 44.1 kHz push
  const eng44 = new ChirpSonarEngine({ sampleRate: 44100, autoAlignDirectPath: false });
  const synth44 = synthesizeGestureSignal('push', { sampleRate: 44100 });
  const res44 = feedInChunks(eng44, synth44.samples, 44100, 512);
  assert.equal(res44.events.length, 1);
  assert.equal(res44.events[0].type, 'push');

  // 96 kHz wave-right (auto-scales period to 2048 so sweep rate remains 46.875 Hz)
  const eng96 = new ChirpSonarEngine({ sampleRate: 96000, autoAlignDirectPath: false });
  assert.equal(eng96.period, 2048);
  const synth96 = synthesizeGestureSignal('wave-right', { sampleRate: 96000 });
  const res96 = feedInChunks(eng96, synth96.samples, 96000, 512);
  assert.equal(res96.events.length, 1);
  assert.equal(res96.events[0].type, 'wave-right');

  // 16 kHz disables ultrasonic cleanly
  const eng16 = new ChirpSonarEngine({ sampleRate: 16000 });
  const out16 = eng16.processBlock(new Float32Array(512), 16000, 0.032);
  assert.equal(out16.ultrasonicSupported, false);
  assert.equal(out16.gestureEvent, null);

  // NaN / Infinity sanitization never poisons state
  const engNan = new ChirpSonarEngine({ sampleRate: 48000, autoAlignDirectPath: false });
  const poison = new Float32Array(1024);
  poison[10] = Number.NaN;
  poison[100] = Number.POSITIVE_INFINITY;
  poison[200] = Number.NEGATIVE_INFINITY;
  engNan.processBlock(poison, 48000, 0.02);

  const synthPull = synthesizeGestureSignal('pull', { sampleRate: 48000 });
  const resAfterNan = feedInChunks(engNan, synthPull.samples, 48000, 512);
  assert.equal(resAfterNan.events.length, 1);
  assert.equal(resAfterNan.events[0].type, 'pull');
  assert.ok(Number.isFinite(engNan.noiseFloorL) && Number.isFinite(engNan.balance));
});

test('Browser slot 4 registration (pending + live registerCell) and zero innerHTML hygiene', () => {
  const srcPath = path.join(__dirname, 'chirp-sonar.js');
  const src = fs.readFileSync(srcPath, 'utf8');
  assert.equal(/\.\s*innerHTML\b|\[['"]innerHTML['"]\]/.test(src), false, 'chirp-sonar.js must not access innerHTML');

  // Case A: loaded before shared-bus.js -> queues into LeftGrilleLab._pending
  const sandboxA = { globalThis: null };
  sandboxA.globalThis = sandboxA;
  vm.runInNewContext(src, sandboxA, { filename: 'chirp-sonar.js' });
  assert.ok(sandboxA.LeftGrilleLab && Array.isArray(sandboxA.LeftGrilleLab._pending));
  assert.equal(sandboxA.LeftGrilleLab._pending.length, 1);
  assert.equal(sandboxA.LeftGrilleLab._pending[0][0], 4);
  assert.equal(sandboxA.LeftGrilleLab._pending[0][1].id, 'chirp-sonar');
  assert.equal(typeof sandboxA.LeftGrilleLab._pending[0][1].mount, 'function');

  // Case B: loaded after shared-bus.js -> invokes LeftGrilleLab.registerCell(4, spec)
  const registered = [];
  const sandboxB = {
    globalThis: null,
    LeftGrilleLab: {
      registerCell(slot, spec) {
        registered.push([slot, spec]);
      }
    }
  };
  sandboxB.globalThis = sandboxB;
  vm.runInNewContext(src, sandboxB, { filename: 'chirp-sonar.js' });
  assert.equal(registered.length, 1);
  assert.equal(registered[0][0], 4);
  assert.equal(registered[0][1].id, 'chirp-sonar');
});
