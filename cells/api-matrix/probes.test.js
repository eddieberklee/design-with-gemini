'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadMatrixModules(extraGlobals, opts) {
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
      TextEncoder: TextEncoder,
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
      localStorage: makeStorage(storageBacking.local),
      atob: (s) => Buffer.from(s, 'base64').toString('binary'),
      btoa: (s) => Buffer.from(s, 'binary').toString('base64')
    },
    extraGlobals || {}
  );
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  const dir = __dirname;
  if (opts && opts.withDecisions) {
    const decClient = fs.readFileSync(path.join(dir, '..', 'decisions', 'client.js'), 'utf8');
    vm.runInContext(decClient, ctx, { filename: 'decisions/client.js' });
  }
  ['audio.js', 'probes.js'].forEach((file) => {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    vm.runInContext(src, ctx, { filename: file });
  });
  return { ns: sandbox.GeminiApiMatrix, sandbox: sandbox, storageBacking: storageBacking };
}

function makeFakeStream(chunks) {
  let idx = 0;
  const enc = new TextEncoder();
  return {
    getReader: () => ({
      read: async () => {
        if (idx >= chunks.length) return { done: true, value: undefined };
        return { done: false, value: enc.encode(chunks[idx++]) };
      }
    })
  };
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

  // 4. Secret redaction (AIza, non-AIza, JSON-escaped, 1-char guard)
  const fakeKey = 'AIzaSyFakeTestKeyForUnitTests1234567890';
  const leaked = 'curl "https://example.com?key=' + fakeKey + '" -H "x-goog-api-key: ' + fakeKey + '" -H "Authorization: Bearer ' + fakeKey + '"';
  const redacted = Probes.redactSecrets(leaked, fakeKey);
  assert.equal(redacted.includes(fakeKey), false);
  assert.equal(redacted.includes('AIzaSy'), false);
  // 1-char activeKey must NOT corrupt normal strings
  assert.equal(Probes.redactSecrets('hello api world', 'a'), 'hello api world');
  // Non-AIza token with quote/newline escaped in JSON
  const weirdKey = 'ya29.secret"token';
  const jsonText = JSON.stringify({ err: weirdKey });
  assert.equal(Probes.redactSecrets(jsonText, weirdKey).includes('ya29.secret'), false);

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

  // 9. Cross-cell KeyStore sync & clear without stale memoryKey resurrection
  const crossEnv = loadMatrixModules({}, { withDecisions: true });
  crossEnv.ns.KeyStore.set(fakeKey, false);
  assert.equal(crossEnv.ns.KeyStore.get(), fakeKey);
  assert.equal(crossEnv.sandbox.GeminiDecisions.Client.KeyStore.get(), fakeKey);
  crossEnv.sandbox.GeminiDecisions.Client.KeyStore.clear();
  assert.equal(crossEnv.ns.KeyStore.get(), '');
  assert.equal(crossEnv.ns.KeyStore.getStorageType(), 'none');

  // 10. Stage 0 auth halt prevents firing remaining 17 probes on Google HTTP 400 "API key not valid." AND redacts echoed key
  let fetchCalls = 0;
  const nonAizaKey = 'custom-secret-token-9999';
  const authEnv = loadMatrixModules({
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key. (' + nonAizaKey + ')',
            details: [{ reason: 'API_KEY_INVALID' }]
          }
        })
      };
    }
  });
  const haltOutcome = await authEnv.ns.Probes.runBatch({
    apiKey: nonAizaKey,
    onResult: () => {}
  });
  assert.equal(haltOutcome.haltedOnAuth, true);
  assert.equal(haltOutcome.modelsResult.badge, 'INVALID KEY');
  assert.equal(fetchCalls, 1);
  assert.equal(haltOutcome.modelsResult.summary.includes(nonAizaKey), false);
  assert.equal(JSON.stringify(haltOutcome.modelsResult.raw).includes(nonAizaKey), false);

  // 10b. Live WebSocket 1007 with "API key not valid" classifies as fail / INVALID KEY (not SETUP 1007)
  class InvalidKeyWs {
    constructor() {
      this.readyState = 0;
      setTimeout(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen({});
        setTimeout(() => {
          this.readyState = 3;
          if (this.onclose) this.onclose({ code: 1007, reason: 'API key not valid. Please pass a valid API key.' });
        }, 5);
      }, 5);
    }
    send() {}
    close() {}
  }
  const wsBadKeyEnv = loadMatrixModules({ WebSocket: InvalidKeyWs });
  const wsBadRes = await wsBadKeyEnv.ns.Probes.runSingleProbe('live_ws', {
    apiKey: fakeKey,
    catalog: catalog
  });
  assert.equal(wsBadRes.status, 'fail');
  assert.equal(wsBadRes.badge, 'INVALID KEY');

  // 11. Live WebSocket sync-close race & close code classification (1006, 1007, 1008)
  class SyncCloseWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.binaryType = 'blob';
      setTimeout(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen({});
      }, 5);
    }
    send() {
      const payload = new TextEncoder().encode(JSON.stringify({ setupComplete: {} })).buffer;
      setTimeout(() => {
        if (this.onmessage) this.onmessage({ data: payload });
      }, 5);
    }
    close(code) {
      this.readyState = 3;
      // Fire synchronously inside close() to catch ws.close()-before-finish() race!
      if (this.onclose) this.onclose({ code: code || 1000, reason: '' });
    }
  }
  const wsEnv = loadMatrixModules({ WebSocket: SyncCloseWebSocket });
  const wsRes = await wsEnv.ns.Probes.runSingleProbe('live_ws', {
    apiKey: fakeKey,
    catalog: catalog
  });
  assert.equal(wsRes.status, 'pass');
  assert.equal(wsRes.badge, 'WS READY');
  assert.equal(wsRes.httpStatus, 101);

  // 12. Full Stage 0 -> 1 -> 2 batch sweep across all 18 endpoints (pagination, split SSE,
  // TTS 400 fallback, empty protobuf {}, 429 retry vs hard quota, and non-abort error capture)
  let modelsPageCalls = 0;
  let ttsCalls = 0;
  let streamCalls = 0;
  const fullEnv = loadMatrixModules({
    WebSocket: SyncCloseWebSocket,
    fetch: async (url, init) => {
      if (url.includes('/v1beta/models?pageSize=1000')) {
        modelsPageCalls += 1;
        if (!url.includes('pageToken=p2')) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () =>
              JSON.stringify({
                models: [
                  { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
                  { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
                  { name: 'models/gemini-2.5-flash-native-audio-preview-12-2025', supportedGenerationMethods: ['bidiGenerateContent'] }
                ],
                nextPageToken: 'p2'
              })
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () =>
            JSON.stringify({
              models: [
                { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
                { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/veo-3.1-fast-generate-preview', supportedGenerationMethods: ['predictLongRunning'] },
                { name: 'models/lyria-3.5', supportedGenerationMethods: ['bidiGenerateMusic'] }
              ]
            })
        };
      }
      if (url.includes(':streamGenerateContent')) {
        streamCalls += 1;
        if (streamCalls === 1) {
          return {
            ok: false,
            status: 429,
            headers: { get: () => null },
            text: async () => JSON.stringify({ error: { code: 429, message: 'RPM limit', details: [{ retryDelay: '0.02s' }] } })
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: makeFakeStream([
            'data: {"candidates":[{"content":{"parts":[{"text":"STR',
            'EAM "}]}}]}\n\ndata: {"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}\n\ndata: [DONE]\n\n'
          ])
        };
      }
      if (url.includes('preview-tts:generateContent')) {
        ttsCalls += 1;
        if (ttsCalls === 1) {
          return {
            ok: false,
            status: 400,
            headers: { get: () => null },
            text: async () => JSON.stringify({ error: { message: 'Unknown field prebuiltVoiceConfig' } })
          };
        }
        const pcmB64 = Audio.uint8ArrayToBase64(new Uint8Array([0, 0, 10, 0, 20, 0, 30, 0]));
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () =>
            JSON.stringify({
              candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcmB64 } }] } }]
            })
        };
      }
      if (url.includes('/v1beta/interactions')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ id: 'int_1234567890abcdef', status: 'completed', outputs: [{ type: 'text', text: 'OK' }] })
        };
      }
      if (url.includes('/v1beta/decisions')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ answers: { is_healthy: { type: 'noul', noul: 0.97 } }, usage: { total_output_tokens: 0 } })
        };
      }
      if (url.includes(':embedContent')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ embedding: { values: [0.1, 0.2, 0.3, 0.4] } })
        };
      }
      if (url.includes(':countTokens')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ totalTokens: 7 })
        };
      }
      if (url.includes('/v1beta/files') || url.includes('/v1beta/cachedContents') || url.includes('/v1beta/batches')) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' };
      }
      if (url.includes('/v1beta/openai/models')) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ object: 'list', data: [{ id: 'models/gemini-2.5-flash' }] }) };
      }
      if (url.includes(':generateContent')) {
        const parsedReq = init && init.body ? JSON.parse(init.body) : {};
        if (parsedReq.tools) {
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () =>
              JSON.stringify({
                candidates: [{ content: { parts: [{ text: '2026-11-21' }] }, groundingMetadata: { webSearchQueries: ['today utc date'], groundingChunks: [{}] } }]
              })
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }], usageMetadata: { totalTokenCount: 12 } })
        };
      }
      // GET /v1beta/models/<id> metadata checks
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ name: 'models/test', supportedGenerationMethods: ['predictLongRunning'] })
      };
    }
  });

  const batchResults = {};
  const batchOutcome = await fullEnv.ns.Probes.runBatch({
    apiKey: fakeKey,
    includeGrounding: true,
    onResult: (id, r) => { batchResults[id] = r; }
  });
  assert.equal(batchOutcome.haltedOnAuth, false);
  assert.equal(modelsPageCalls, 2);
  assert.equal(ttsCalls, 2);
  assert.equal(streamCalls, 2);
  assert.equal(Object.keys(batchResults).length, 18);
  assert.equal(batchResults.tts.status, 'pass');
  assert.ok(batchResults.tts.curl.includes('"voice": "Kore"'));
  assert.equal(batchResults.stream.status, 'pass');
  assert.equal(batchResults.files.badge, '0 FILES');
  assert.equal(batchResults.caching.badge, '0 CACHED');
  assert.equal(batchResults.batches.badge, '0 JOBS');

  // 13. Non-abort error thrown inside a batch probe must call onResult with fail (never silently disappear)
  const errEnv = loadMatrixModules({
    atob: () => { throw new Error('Invalid base64'); },
    fetch: async (url) => {
      if (url.includes('/v1beta/models?pageSize=1000')) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] }] }) };
      }
      if (url.includes('tts:generateContent')) {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: '!!!' } }] } }] }) };
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' };
    }
  });
  const errResults = {};
  await errEnv.ns.Probes.runBatch({
    apiKey: fakeKey,
    includeGrounding: false,
    onResult: (id, r) => { errResults[id] = r; }
  });
  assert.equal(Object.keys(errResults).length, 17);
  assert.equal(errResults.tts.status, 'fail');
  assert.equal(errResults.tts.badge, 'ERROR');

  // 14. Opt-in image_gen rejects unsafe image/svg+xml MIME
  const imgEnv = loadMatrixModules({
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/svg+xml', data: 'PHN2Zz48L3N2Zz4=' } }] } }]
        })
    })
  });
  const svgRes = await imgEnv.ns.Probes.runSingleProbe('image_gen', {
    apiKey: fakeKey,
    catalog: catalog,
    liveGen: true
  });
  assert.equal(svgRes.status, 'warn');
  assert.equal(svgRes.badge, 'NO IMAGE');

  // 15. Export report & Markdown redaction + multi-line / pipe escaping
  const jsonReport = Probes.buildExportReport(batchResults, batchOutcome.catalog, fakeKey);
  const mdReport = Probes.buildMarkdownSummary(batchResults, batchOutcome.catalog, fakeKey);
  assert.equal(jsonReport.includes(fakeKey), false);
  assert.equal(mdReport.includes(fakeKey), false);
  assert.equal(JSON.parse(jsonReport).passed, 18);

  const multilineResults = Object.assign({}, batchResults, {
    generate: Object.assign({}, batchResults.generate, {
      summary: 'HTTP 500 · First line\r\nSecond line\nThird | pipe'
    })
  });
  const escapedMd = Probes.buildMarkdownSummary(multilineResults, batchOutcome.catalog, fakeKey);
  const tableLines = escapedMd.split('\n').filter((l) => l.startsWith('|'));
  assert.equal(tableLines.length, 2 + Probes.ENDPOINTS.length);
  const genRow = tableLines.find((l) => l.includes('Generate Content'));
  assert.ok(genRow.includes('First line Second line Third \\| pipe'));

  // 16. Stereo WAV frame alignment (6 bytes -> 4 bytes) & invalid base64 payload validation
  const stereoSix = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const stereoWav = Audio.pcm16leToWavBytes(stereoSix, 24000, 2);
  assert.equal(stereoWav.byteLength, 44 + 4);
  assert.equal(new DataView(stereoWav.buffer).getUint32(40, true), 4);
  assert.throws(() => Audio.base64ToUint8Array('abcde'), /Invalid base64 audio payload/);
  assert.throws(() => Audio.base64ToUint8Array('!!!BAD!!'), /Invalid base64 audio payload/);

  // 17. Live WebSocket server { error } frame -> fail, ws.send() throw closes socket, & Blob.text() catch
  let errWsClosed = false;
  class ServerErrorWs {
    constructor() {
      this.readyState = 0;
      setTimeout(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen({});
      }, 5);
    }
    send() {
      setTimeout(() => {
        if (this.onmessage) {
          this.onmessage({
            data: JSON.stringify({ error: { code: 403, message: 'Permission denied' } })
          });
        }
      }, 5);
    }
    close() {
      errWsClosed = true;
      this.readyState = 3;
    }
  }
  const wsErrFrameRes = await loadMatrixModules({ WebSocket: ServerErrorWs }).ns.Probes.runSingleProbe('live_ws', {
    apiKey: fakeKey,
    catalog: catalog
  });
  assert.equal(wsErrFrameRes.status, 'fail');
  assert.equal(wsErrFrameRes.badge, 'WS ERR 403');
  assert.equal(errWsClosed, true);

  let wsSendThrowClosedSocket = false;
  class SendThrowWs {
    constructor() {
      this.readyState = 0;
      setTimeout(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen({});
      }, 5);
    }
    send() {
      throw new Error('Socket broken');
    }
    close() {
      wsSendThrowClosedSocket = true;
      this.readyState = 3;
    }
  }
  const wsSendThrowRes = await loadMatrixModules({ WebSocket: SendThrowWs }).ns.Probes.runSingleProbe('live_ws', {
    apiKey: fakeKey,
    catalog: catalog
  });
  assert.equal(wsSendThrowRes.status, 'fail');
  assert.equal(wsSendThrowRes.badge, 'WS SEND ERR');
  assert.equal(wsSendThrowClosedSocket, true);

  if (typeof Blob === 'function') {
    let badBlobClosed = false;
    class BadBlobWs {
      constructor() {
        this.readyState = 0;
        setTimeout(() => {
          this.readyState = 1;
          if (this.onopen) this.onopen({});
        }, 5);
      }
      send() {
        const fakeBlob = Object.create(Blob.prototype);
        fakeBlob.text = () => Promise.reject(new Error('Unreadable blob'));
        setTimeout(() => {
          if (this.onmessage) this.onmessage({ data: fakeBlob });
        }, 5);
      }
      close() {
        badBlobClosed = true;
        this.readyState = 3;
      }
    }
    const badBlobRes = await loadMatrixModules({ WebSocket: BadBlobWs }).ns.Probes.runSingleProbe('live_ws', {
      apiKey: fakeKey,
      catalog: catalog
    });
    assert.equal(badBlobRes.status, 'fail');
    assert.equal(badBlobRes.badge, 'WS READ ERR');
    assert.equal(badBlobClosed, true);
  }

  // 18. HTTP 200 HTML proxy responses -> status: 'fail' (INVALID JSON)
  const htmlEnv = loadMatrixModules({
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '<html><body>502 Proxy HTML</body></html>'
    })
  });
  for (const epId of ['models', 'generate', 'interactions', 'decisions', 'stream']) {
    const htmlRes = await htmlEnv.ns.Probes.runSingleProbe(epId, {
      apiKey: fakeKey,
      catalog: catalog
    });
    assert.equal(htmlRes.status, 'fail', epId + ' should fail on HTTP 200 HTML');
    assert.equal(htmlRes.badge, 'INVALID JSON', epId + ' should report INVALID JSON');
  }

  // 19. probeStream subword concatenation (no spurious spaces) & reader.cancel() on abort
  const subwordEnv = loadMatrixModules({
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: makeFakeStream([
        'data: {"candidates":[{"content":{"parts":[{"text":"Hel"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"lo"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":" world"}]}}]}\n\ndata: [DONE]\n\n'
      ])
    })
  });
  const subwordRes = await subwordEnv.ns.Probes.runSingleProbe('stream', {
    apiKey: fakeKey,
    catalog: catalog
  });
  assert.equal(subwordRes.status, 'pass');
  assert.equal(subwordRes.raw.visibleText, 'Hello world');

  let readerCancelled = false;
  const abortStreamAc = new AbortController();
  const cancelStreamEnv = loadMatrixModules({
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: () => new Promise(() => {}),
          cancel: () => {
            readerCancelled = true;
            return Promise.resolve();
          }
        })
      }
    })
  });
  const pendingStream = cancelStreamEnv.ns.Probes.runSingleProbe('stream', {
    apiKey: fakeKey,
    catalog: catalog,
    signal: abortStreamAc.signal
  });
  setTimeout(() => abortStreamAc.abort(), 10);
  await assert.rejects(pendingStream, (err) => Boolean(err && err.aborted));
  assert.equal(readerCancelled, true);

  // 20. probeDecisions guards noul: null / undefined without coercing to p=0.00
  const nullNoulEnv = loadMatrixModules({
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ answers: { is_healthy: { type: 'noul', noul: null } }, usage: { total_output_tokens: 0 } })
    })
  });
  const nullNoulRes = await nullNoulEnv.ns.Probes.runSingleProbe('decisions', {
    apiKey: fakeKey,
    catalog: catalog
  });
  assert.equal(nullNoulRes.badge, 'HTTP 200');
  assert.ok(nullNoulRes.summary.includes('noul = n/a'));

  assert.equal(Probes.ENDPOINTS.length, 18);
  console.log('ALL 20 API MATRIX UNIT & INTEGRATION TESTS PASSED (18 endpoints verified)');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
