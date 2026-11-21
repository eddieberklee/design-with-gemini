import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Lab = require('./grille-swipe.js');

function runBufferThroughEngine(buf, sr, sonarOn) {
  const engine = Lab.createStreamEngine(sr);
  engine.setSonarTarget(sonarOn, 0.13, false);
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);
  const strokes = [];
  let leftEnergy = 0;
  let rightEnergy = 0;

  for (let off = 0; off < buf.length; off += 128) {
    const slice = buf.subarray(off, Math.min(buf.length, off + 128));
    outL.fill(99);
    outR.fill(0);
    engine.processQuantum(slice, outL, outR, {
      operatingGain: 0.13,
      onStroke: (feat) => strokes.push(feat)
    });
    for (let i = 0; i < slice.length; i++) {
      leftEnergy += outL[i] * outL[i];
      rightEnergy += outR[i] * outR[i];
    }
  }
  return { strokes, leftEnergy, rightEnergy };
}

test('Coherent TX keeps Left speaker strictly 0.0 and emits 19kHz only on Right channel when >=44.1kHz', () => {
  const silent = new Float32Array(48000 * 0.25);
  const res48 = runBufferThroughEngine(silent, 48000, true);
  assert.equal(res48.leftEnergy, 0, 'Left speaker near 3-MEMS array must stay strictly 0.0');
  assert.ok(res48.rightEnergy > 0.1, 'Right tweeter channel must emit 19kHz carrier at 48kHz');

  const res16 = runBufferThroughEngine(silent, 16000, true);
  assert.equal(res16.rightEnergy, 0, 'Nyquist guard must mute 19kHz carrier when sampleRate < 44100 Hz');
});

test('Left Grille Control separates UP vs DOWN zero-shot in Passive mode', () => {
  for (const dir of ['UP', 'DOWN']) {
    const buf = Lab.synthesizeMac16Stroke({ sampleRate: 48000, dir, grille: 'left', sonarOn: false, seed: 101 });
    const { strokes } = runBufferThroughEngine(buf, 48000, false);
    assert.equal(strokes.length, 1, `Expected 1 stroke for Left ${dir}`);
    const pred = Lab.classifyStroke(strokes[0], null, 'left', false);
    assert.equal(pred.dir, dir);
    assert.ok(pred.confidence > 0.80, `Expected high confidence on Left Grille ${dir}, got ${pred.confidence}`);
  }
});

test('Right Grille + 19.0 kHz Sonar separates UP vs DOWN across 44.1 kHz, 48 kHz, and 96 kHz despite Fresnel phase shift', () => {
  for (const sr of [44100, 48000, 96000]) {
    for (const dir of ['UP', 'DOWN']) {
      const buf = Lab.synthesizeMac16Stroke({
        sampleRate: sr,
        dir,
        grille: 'right',
        sonarOn: true,
        fresnelRad: 2.2,
        seed: sr + (dir === 'UP' ? 7 : 19)
      });
      const { strokes } = runBufferThroughEngine(buf, sr, true);
      assert.equal(strokes.length, 1, `Expected 1 stroke at ${sr}Hz Right ${dir}`);
      const feat = strokes[0];
      assert.ok(feat.dipDb > 2.0, `Expected measurable tweeter occlusion dip at ${sr}Hz, got ${feat.dipDb}`);
      if (dir === 'UP') {
        assert.ok(feat.rawX[4] > 0.05, `Expected positive late occlusion timing x5 for UP, got ${feat.rawX[4]}`);
        assert.ok(feat.rawX[5] > 0.10, `Expected positive blueshift Doppler x6 for UP, got ${feat.rawX[5]}`);
      } else {
        assert.ok(feat.rawX[4] < -0.05, `Expected negative early occlusion timing x5 for DOWN, got ${feat.rawX[4]}`);
        assert.ok(feat.rawX[5] < -0.10, `Expected negative redshift Doppler x6 for DOWN, got ${feat.rawX[5]}`);
      }
      const pred = Lab.classifyStroke(feat, null, 'right', true);
      assert.equal(pred.dir, dir);
      assert.ok(pred.confidence > 0.78, `Expected strong sonar confidence at ${sr}Hz, got ${pred.confidence}`);
    }
  }
});

test('Vetoes reject impulsive taps, low-frequency desk thumps, and harmonic speech', () => {
  for (const kind of ['tap', 'thump', 'speech']) {
    const buf = Lab.synthesizeMac16Stroke({ sampleRate: 48000, kind, grille: 'right', sonarOn: true, seed: 303 });
    const { strokes } = runBufferThroughEngine(buf, 48000, true);
    const valid = strokes.filter((f) => !(f.isTapVeto || f.isThumpVeto || f.isSpeechVeto));
    assert.equal(valid.length, 0, `Expected ${kind} to be vetoed`);
  }
});

test('4-Stroke Cholesky Shrinkage Fisher LDA achieves high d_OOF on real strokes and resists hallucination on pure noise', () => {
  const upStrokes = [11, 22].map((seed) => {
    const b = Lab.synthesizeMac16Stroke({ sampleRate: 48000, dir: 'UP', grille: 'right', sonarOn: true, seed });
    return runBufferThroughEngine(b, 48000, true).strokes[0];
  });
  const dnStrokes = [33, 44].map((seed) => {
    const b = Lab.synthesizeMac16Stroke({ sampleRate: 48000, dir: 'DOWN', grille: 'right', sonarOn: true, seed });
    return runBufferThroughEngine(b, 48000, true).strokes[0];
  });

  const model = Lab.fitShrinkageLDA(upStrokes, dnStrokes, 'right', true);
  assert.ok(model && model.calibrated);
  assert.ok(model.dPrimeOof > 1.8, `Expected strong out-of-fold d'_OOF > 1.8, got ${model.dPrimeOof}`);

  // Held-out strokes classify accurately
  const heldUp = runBufferThroughEngine(
    Lab.synthesizeMac16Stroke({ sampleRate: 48000, dir: 'UP', grille: 'right', sonarOn: true, seed: 99 }),
    48000,
    true
  ).strokes[0];
  const heldDn = runBufferThroughEngine(
    Lab.synthesizeMac16Stroke({ sampleRate: 48000, dir: 'DOWN', grille: 'right', sonarOn: true, seed: 105 }),
    48000,
    true
  ).strokes[0];
  assert.equal(Lab.classifyStroke(heldUp, model, 'right', true).dir, 'UP');
  assert.equal(Lab.classifyStroke(heldDn, model, 'right', true).dir, 'DOWN');

  // Null-distribution check: identical-distribution noise vectors must NOT hallucinate huge d'_OOF
  const nullA = [
    { scaledX: [0.10, -0.05, 0.02, -0.04, 0, 0], fricCurve64: new Float32Array(64), dopCurve64: new Float32Array(64) },
    { scaledX: [-0.12, 0.08, -0.03, 0.05, 0, 0], fricCurve64: new Float32Array(64), dopCurve64: new Float32Array(64) }
  ];
  const nullB = [
    { scaledX: [0.09, 0.06, -0.01, -0.03, 0, 0], fricCurve64: new Float32Array(64), dopCurve64: new Float32Array(64) },
    { scaledX: [-0.08, -0.07, 0.04, 0.02, 0, 0], fricCurve64: new Float32Array(64), dopCurve64: new Float32Array(64) }
  ];
  const nullModel = Lab.fitShrinkageLDA(nullA, nullB, 'right', false);
  assert.ok(nullModel.dPrimeOof < 0.8, `Null noise must not hallucinate high d'_OOF, got ${nullModel.dPrimeOof}`);
});

test('CoreAudio input ranking prioritizes MacBook Pro Microphone over DJI Wireless Mic and iPhone Continuity', () => {
  const sMbp = Lab.rankAudioInputDevice('MacBook Pro Microphone (Built-in)');
  const sDji = Lab.rankAudioInputDevice('Wireless Mic Rx (DJI Technology Co., Ltd.)');
  const sIphone = Lab.rankAudioInputDevice('Ed’s iPhone Microphone');
  const sHue = Lab.rankAudioInputDevice('Hue Sync Audio');
  assert.ok(sMbp > 90);
  assert.ok(sDji < 0 && sIphone < 0 && sHue < 0);
});
