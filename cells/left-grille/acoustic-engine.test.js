const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AcousticDspCore,
  QUANTUM,
  SPEED_OF_SOUND_CMS,
  buildCarrierMultiples
} = require('./acoustic-engine.js');

function createRng(seed = 1337) {
  let s = seed >>> 0;
  return function rand() {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randNormal(rng) {
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function simulateGrilleAudio({
  core,
  preIdleSec = 0.28,
  swipeDurationSec = 0.42,
  postIdleSec = 0.22,
  yStart = 0.88,
  yEnd = 0.12,
  contactFriction = true,
  sonarReflection = true,
  tweeterNonlinearImd = false,
  seed = 42
}) {
  const sr = core.sampleRate;
  const rng = createRng(seed);
  const totalSamples = Math.floor((preIdleSec + swipeDurationSec + postIdleSec) * sr);
  const txBuf = new Float32Array(QUANTUM);
  const rxAll = new Float32Array(totalSamples);

  let lpMid = 0;
  let lpSub = 0;
  let prevWhite = 0;
  const alphaMid = 1 - Math.exp((-2 * Math.PI * 1900) / sr);
  const alphaSub = 1 - Math.exp((-2 * Math.PI * 130) / sr);

  const swipeStartSample = Math.floor(preIdleSec * sr);
  const swipeEndSample = swipeStartSample + Math.floor(swipeDurationSec * sr);

  const crestPhases = core.carrierMultiples.map((_, k) => (Math.PI * k * k) / core.numCarriers);

  for (let n = 0; n < totalSamples; n++) {
    if ((n & 127) === 0) {
      core.fillTxBlock(txBuf, null);
    }
    const wNoise = randNormal(rng);
    let sample = wNoise * 0.00055;

    const inSwipe = n >= swipeStartSample && n < swipeEndSample;
    const progress = inSwipe
      ? (n - swipeStartSample) / Math.max(1, swipeEndSample - swipeStartSample)
      : n < swipeStartSample
      ? 0
      : 1;

    let env = 0;
    if (inSwipe) {
      const edge = 0.1;
      if (progress < edge) env = 0.5 * (1 - Math.cos((Math.PI * progress) / edge));
      else if (progress > 1 - edge) env = 0.5 * (1 - Math.cos((Math.PI * (1 - progress)) / edge));
      else env = 1.0;
    }

    const y = yStart + (yEnd - yStart) * progress;
    const distToMicCm = Math.max(0.8, y * core.grilleLengthCm);

    const pinholeCover = inSwipe && contactFriction ? Math.exp(-Math.pow((y - 0.13) / 0.11, 2)) : 0;
    const txSample = txBuf[n & 127];
    sample += txSample * 0.35 * (1.0 - 0.62 * pinholeCover * env);

    // Optional 2nd-order tweeter nonlinearity test (x + 0.08 * x^2)
    if (tweeterNonlinearImd) {
      sample += 0.08 * txSample * txSample;
    }

    if (inSwipe && sonarReflection) {
      const reflAmp = 0.0042 * env;
      for (let k = 0; k < core.numCarriers; k++) {
        const f = core.carrierFreqs[k];
        const phaseDelay = (2 * Math.PI * f * (1.65 * distToMicCm)) / SPEED_OF_SOUND_CMS;
        const thetaTx = (2 * Math.PI * core.carrierMultiples[k] * (n & 127)) / QUANTUM + crestPhases[k];
        sample += (reflAmp / core.numCarriers) * Math.cos(thetaTx - phaseDelay);
      }
    }

    if (inSwipe && contactFriction) {
      const rubWhite = randNormal(rng);
      lpMid += alphaMid * (rubWhite - lpMid);
      lpSub += alphaSub * (rubWhite - lpSub);
      const hpAir = rubWhite - prevWhite;
      prevWhite = rubWhite;

      const topProx = clamp01(1 - y);
      const chassisGain = 0.0045 + 0.014 * Math.pow(topProx, 1.3);
      const airHoleGain = 0.0004 + 0.026 * Math.pow(topProx, 2.4);
      const pneuGain = 0.035 * pinholeCover;

      sample += env * (chassisGain * lpMid + airHoleGain * hpAir + pneuGain * lpSub);
    }

    rxAll[n] = sample;
  }

  return core.processSamples(rxAll);
}

test('Non-uniform carrier comb avoids uniform IMD spacing and stays >= 18.3 kHz at 48 kHz', () => {
  const mults = buildCarrierMultiples(48000);
  assert.ok(mults.length >= 4);
  const freqs = mults.map((m) => (m * 48000) / 128);
  assert.ok(freqs[0] >= 18300, `Expected lowest carrier >= 18.3 kHz, got ${freqs[0]}`);
  assert.ok(freqs[freqs.length - 1] <= 21600);
  for (let i = 1; i < mults.length; i++) {
    assert.ok(mults[i] - mults[i - 1] >= 2, 'Minimum spacing >= 2 bins for exact Hann spectral zeros');
  }
});

test('Swipe UP vs Swipe DOWN detection across slow, medium, and fast speeds + nonlinear tweeter IMD', () => {
  const scenarios = [
    { label: 'slow UP', yStart: 0.90, yEnd: 0.12, dur: 0.85, expectedDir: 'up' },
    { label: 'medium UP', yStart: 0.88, yEnd: 0.10, dur: 0.38, expectedDir: 'up' },
    { label: 'fast flick UP', yStart: 0.92, yEnd: 0.08, dur: 0.16, expectedDir: 'up' },
    { label: 'slow DOWN', yStart: 0.10, yEnd: 0.90, dur: 0.85, expectedDir: 'down' },
    { label: 'medium DOWN', yStart: 0.12, yEnd: 0.88, dur: 0.38, expectedDir: 'down' },
    { label: 'fast flick DOWN', yStart: 0.08, yEnd: 0.92, dur: 0.16, expectedDir: 'down' }
  ];

  const recordedSpeeds = {};
  for (const sc of scenarios) {
    const core = new AcousticDspCore({ sampleRate: 48000 });
    const events = simulateGrilleAudio({
      core,
      swipeDurationSec: sc.dur,
      yStart: sc.yStart,
      yEnd: sc.yEnd,
      tweeterNonlinearImd: true,
      seed: 100 + Math.round(sc.dur * 100)
    });
    const swipes = events.filter((e) => e.type === 'swipe').map((e) => e.swipe);
    assert.equal(swipes.length, 1, `Expected 1 swipe for ${sc.label}, got ${swipes.length}`);
    assert.equal(swipes[0].direction, sc.expectedDir, `Wrong direction for ${sc.label}`);
    assert.ok(swipes[0].confidence >= 0.55);
    recordedSpeeds[sc.label] = swipes[0].speedCmPerSec;
  }

  assert.ok(
    recordedSpeeds['slow UP'] < recordedSpeeds['medium UP'] &&
      recordedSpeeds['medium UP'] < recordedSpeeds['fast flick UP']
  );
  assert.ok(
    recordedSpeeds['slow DOWN'] < recordedSpeeds['medium DOWN'] &&
      recordedSpeeds['medium DOWN'] < recordedSpeeds['fast flick DOWN']
  );
});

test('Pure ultrasonic hover swipes (zero surface rub, left-speaker sonar reflection only)', () => {
  for (const [dir, yStart, yEnd] of [
    ['up', 0.85, 0.15],
    ['down', 0.15, 0.85]
  ]) {
    const core = new AcousticDspCore({ sampleRate: 48000 });
    const events = simulateGrilleAudio({
      core,
      swipeDurationSec: 0.36,
      yStart,
      yEnd,
      contactFriction: false,
      sonarReflection: true,
      seed: dir === 'up' ? 777 : 888
    });
    const swipes = events.filter((e) => e.type === 'swipe').map((e) => e.swipe);
    assert.equal(swipes.length, 1);
    assert.equal(swipes[0].direction, dir);
    assert.equal(swipes[0].sensingMode, 'ultrasonic');
  }
});

test('Relative distance from Top and Bottom distinguishes upper-half vs lower-half swipes', () => {
  const coreTop = new AcousticDspCore({ sampleRate: 48000 });
  const topSwipe = simulateGrilleAudio({
    core: coreTop,
    swipeDurationSec: 0.40,
    yStart: 0.46,
    yEnd: 0.08,
    seed: 201
  }).find((e) => e.type === 'swipe')?.swipe;
  assert.ok(topSwipe);
  assert.equal(topSwipe.direction, 'up');

  const coreBot = new AcousticDspCore({ sampleRate: 48000 });
  const botSwipe = simulateGrilleAudio({
    core: coreBot,
    swipeDurationSec: 0.40,
    yStart: 0.52,
    yEnd: 0.92,
    seed: 202
  }).find((e) => e.type === 'swipe')?.swipe;
  assert.ok(botSwipe);
  assert.equal(botSwipe.direction, 'down');

  assert.ok(topSwipe.distanceFromTopPct < 35, `Got ${topSwipe.distanceFromTopPct}%`);
  assert.ok(botSwipe.distanceFromTopPct > 65, `Got ${botSwipe.distanceFromTopPct}%`);
  assert.equal(Math.round(topSwipe.distanceFromTopPct + topSwipe.distanceFromBottomPct), 100);
});

test('False-positive immunity: rejects keyboard clicks, voiced harmonic speech, and nonlinear tweeter IMD', () => {
  const sr = 48000;
  const core = new AcousticDspCore({ sampleRate: sr });
  const rng = createRng(999);
  const total = sr * 2;
  const buf = new Float32Array(total);
  const tx = new Float32Array(QUANTUM);

  for (let n = 0; n < total; n++) {
    if ((n & 127) === 0) core.fillTxBlock(tx, null);
    const txS = tx[n & 127];
    let x = randNormal(rng) * 0.0005 + txS * 0.35 + 0.08 * txS * txS;

    const t = n / sr;
    for (const clickT of [0.4, 0.7, 1.0]) {
      if (t >= clickT && t < clickT + 0.020) {
        x += randNormal(rng) * 0.06 * Math.exp(-(t - clickT) / 0.005);
      }
    }
    if (t >= 1.3 && t < 1.65) {
      for (let h = 1; h <= 14; h++) {
        x += (0.018 / Math.pow(h, 1.15)) * Math.sin(2 * Math.PI * 145 * h * t);
      }
    }
    buf[n] = x;
  }

  const events = core.processSamples(buf);
  const falseSwipes = events.filter((e) => e.type === 'swipe');
  assert.equal(falseSwipes.length, 0);
});

test('44.1 kHz rate adaptation and empirical calibration wizard polarity detection', () => {
  const core44 = new AcousticDspCore({ sampleRate: 44100, polarity: -1 });
  const swipes44 = simulateGrilleAudio({
    core: core44,
    swipeDurationSec: 0.4,
    yStart: 0.12,
    yEnd: 0.88,
    seed: 515
  })
    .filter((e) => e.type === 'swipe')
    .map((e) => e.swipe);
  assert.equal(swipes44.length, 1);
  assert.equal(swipes44[0].direction, 'up');

  const coreCal = new AcousticDspCore({ sampleRate: 48000, polarity: 1 });
  coreCal.startCalibrationStep('up');
  simulateGrilleAudio({
    core: coreCal,
    swipeDurationSec: 0.45,
    yStart: 0.10,
    yEnd: 0.90,
    seed: 606
  });
  const calRes = coreCal.finishCalibrationStep();
  assert.equal(calRes.ok, true);
  assert.equal(calRes.polarity, -1);
});
