'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadMatrixModules(extraGlobals) {
  const storageBacking = { session: Object.create(null), local: Object.create(null) };
  function makeStorage(bag) {
    return {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(bag, k) ? bag[k] : null),
      setItem: (k, v) => { bag[k] = String(v); },
      removeItem: (k) => { delete bag[k]; }
    };
  }

  const sandbox = Object.assign(
    {
      console: console,
      Buffer: Buffer,
      TextDecoder: TextDecoder,
      Uint8Array: Uint8Array,
      ArrayBuffer: ArrayBuffer,
      DataView: DataView,
      URL: URL,
      Blob: typeof Blob === 'function' ? Blob : undefined,
      AbortController: AbortController,
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
      performance: { now: () => Date.now() },
      sessionStorage: makeStorage(storageBacking.session),
      localStorage: makeStorage(storageBacking.local)
    },
    extraGlobals || {}
  );
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  const dir = __dirname;
  ['audio.js', 'probes.js'].forEach((file) => {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    vm.runInContext(src, ctx, { filename: file });
  });
  return { ns: sandbox.GeminiApiMatrix, sandbox: sandbox };
}

async function runTests() {
  const { ns } = loadMatrixModules();
  const Audio = ns.Audio;
  const Probes = ns.Probes;
  const KeyStore = ns.KeyStore;

  // 1. Audio chunked base64 > 80KB (must not throw RangeError)
  const big = new Uint8Array(90000);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  const bigB64 = Audio.uint8ArrayToBase64(big);
  const bigRoundTrip = Audio.base64ToUint8Array(bigB64);
  assert.equal(bigRoundTrip.length, big.length);
  assert.equal(bigRoundTrip[0], 0);
  assert.equal(bigRoundTrip[89999], 89999 & 0xff);

  // 2. PCM params & odd-byte WAV wrapping without double-wrapping
  assert.deepEqual(Audio.parsePcmParams('audio/L16;codec=pcm;rate=24000;channels=1'), { sampleRate: 24000, channels: 1 });
  assert.deepEqual(Audio.parsePcmParams('audio/L16;rate=48000;channels=2'), { sampleRate: 48000, channels: 2 });
  const oddPcm = new Uint8Array([1, 2, 3, 4, 5]);
  const wav = Audio.pcm16leToWavBytes(oddPcm, 24000, 1);
  assert.equal(wav.byteLength, 44 + 4);
  assert.equal(Audio.hasRiffWaveHeader(wav), true);

  const alreadyWav = Audio.audioBytesToPlayableBlob(Audio.uint8ArrayToBase64(wav), 'audio/wav');
  assert.equal(alreadyWav.wrapped, false);
  assert.equal(alreadyWav.bytes, wav.byteLength);

  // 3. Procedural test tone
  const tone = Audio.generateTestToneWavBase64();
  assert.equal(tone.mimeType, 'audio/wav');
  assert.ok(tone.bytes > 11000 && tone.bytes < 12000);
  assert.equal(Audio.hasRiffWaveHeader(Audio.base64ToUint8Array(tone.base64)), true);

  // 4. Secret redaction
  const fakeKey = 'AIzaSyFakeTestKeyForUnitTests1234567890';
  const leaked = 'curl "https://example.com?key=' + fakeKey + '" -H "x-goog-api-key: ' + fakeKey + '" -H "Authorization: Bearer ' + fakeKey + '"';
  const redacted = Probes.redactSecrets(leaked, fakeKey);
  assert.equal(redacted.includes(fakeKey), false);
  assert.equal(redacted.includes('AIzaSy'), false);

  // 5. Thinking-safe generation config
  assert.deepEqual(Probes.buildSafeTextGenConfig('gemini-2.5-flash', 32), {
    maxOutputTokens: 32,
    thinkingConfig: { thinkingBudget: 0 }
  });
  assert.deepEqual(Probes.buildSafeTextGenConfig('gemini-2.5-pro', 32), {
    maxOutputTokens: 256,
    thinkingConfig: { thinkingBudget: 128 }
  });
  assert.deepEqual(Probes.buildSafeTextGenConfig('gemini-3.8-flash', 32), {
    maxOutputTokens: 64,
    thinkingConfig: { thinkingLevel: 'MINIMAL' }
  });
  assert.deepEqual(Probes.buildSafeTextGenConfig('gemini-2.0-flash', 32), {
    maxOutputTokens: 32
  });

  // 6. Thought part filtering
  const visible = Probes.extractVisibleText({
    content: {
      parts: [
        { thought: true, text: 'internal reasoning' },
        { text: 'OK' }
      ]
    }
  });
  assert.equal(visible, 'OK');

  // 7. Catalog bucketing & ranking
  const catalog = Probes.buildCatalogFromModels([
    { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
    { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-native-audio-preview-12-2025', supportedGenerationMethods: ['bidiGenerateContent'] },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/veo-3.1-fast-generate-preview', supportedGenerationMethods: ['predictLongRunning'] }
  ]);
  assert.equal(catalog.buckets.text[0].bare, 'gemini-2.5-flash');
  assert.equal(catalog.buckets.tts[0].bare, 'gemini-2.5-flash-preview-tts');
  assert.equal(catalog.buckets.live[0].bare, 'gemini-2.5-flash-native-audio-preview-12-2025');
  assert.equal(catalog.buckets.embeddings[0].bare, 'gemini-embedding-001');
  assert.equal(catalog.buckets.image[0].bare, 'gemini-2.5-flash-image');
  assert.equal(catalog.buckets.veo[0].bare, 'veo-3.1-fast-generate-preview');

  // 8. Inspector payload sanitizer truncates huge base64 & long float vectors
  const sanitized = Probes.sanitizePayloadForInspector({
    inlineData: { data: 'A'.repeat(500) },
    embedding: { values: new Array(768).fill(0.123) }
  });
  assert.ok(sanitized.inlineData.data.includes('<base64 payload omitted'));
  assert.equal(sanitized.embedding.values.length, 7);

  // 9. KeyStore storage & masking
  KeyStore.set(fakeKey, false);
  assert.equal(KeyStore.get(), fakeKey);
  assert.equal(KeyStore.getStorageType(), 'session');
  assert.equal(KeyStore.mask(fakeKey), 'AIza••••7890');
  KeyStore.clear();
  assert.equal(KeyStore.get(), '');

  // 10. Stage 0 auth halt prevents firing remaining 17 probes on 401
  let fetchCalls = 0;
  const mockEnv = loadMatrixModules({
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: false,
        status: 401,
        headers: { get: () => null },
        text: async () => JSON.stringify({ error: { code: 401, message: 'API key not valid.' } })
      };
    }
  });
  const haltOutcome = await mockEnv.ns.Probes.runBatch({
    apiKey: fakeKey,
    onResult: () => {}
  });
  assert.equal(haltOutcome.haltedOnAuth, true);
  assert.equal(fetchCalls, 1);

  assert.equal(Probes.ENDPOINTS.length, 18);
  console.log('ALL 10 API MATRIX UNIT TESTS PASSED (18 endpoints verified)');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
