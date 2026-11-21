'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('./client.js');

test('rankImageModels prioritizes Nano Banana Pro and 3.1 Flash Image over 2.5 Flash Image', () => {
  const ranked = client.rankImageModels([
    { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-image-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3-pro-image-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/imagen-3.0-generate-002', supportedGenerationMethods: ['predict'] }
  ]);

  assert.deepEqual(
    ranked.map((m) => m.id),
    [
      'gemini-3-pro-image-preview',
      'gemini-3.1-flash-image-preview',
      'gemini-2.5-flash-image'
    ]
  );
});

test('buildGenerateRequest includes responseModalities and imageConfig.aspectRatio', () => {
  const req = client.buildGenerateRequest('A stoneware mug', { aspectRatio: '16:9' });
  assert.equal(req.contents[0].parts[0].text, 'A stoneware mug');
  assert.deepEqual(req.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  assert.deepEqual(req.generationConfig.imageConfig, { aspectRatio: '16:9' });
});

test('buildGenerateRequest omits imageConfig when omitImageConfig is true', () => {
  const req = client.buildGenerateRequest('A stoneware mug', {
    aspectRatio: '16:9',
    omitImageConfig: true
  });
  assert.equal(req.generationConfig.imageConfig, undefined);
});

test('buildGenerateRequest prepends referenceImages as inlineData parts', () => {
  const req = client.buildGenerateRequest('Try on this jacket', {
    aspectRatio: '3:4',
    referenceImages: [
      { mimeType: 'image/jpeg', data: 'UEVSU09O' },
      { mimeType: 'image/png', data: 'UFJPRFVDVA==' }
    ]
  });
  assert.equal(req.contents[0].parts.length, 3);
  assert.deepEqual(req.contents[0].parts[0], { inlineData: { mimeType: 'image/jpeg', data: 'UEVSU09O' } });
  assert.deepEqual(req.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'UFJPRFVDVA==' } });
  assert.deepEqual(req.contents[0].parts[2], { text: 'Try on this jacket' });
});

test('parseGenerateResponse extracts camelCase inlineData and text', () => {
  const parsed = client.parseGenerateResponse({
    candidates: [
      {
        finishReason: 'STOP',
        content: {
          parts: [
            { text: 'Here is your image.' },
            { inlineData: { mimeType: 'image/png', data: 'QUJD' } }
          ]
        }
      }
    ]
  });

  assert.deepEqual(parsed.image, { mimeType: 'image/png', data: 'QUJD' });
  assert.equal(parsed.text, 'Here is your image.');
  assert.equal(parsed.blockReason, '');
});

test('parseGenerateResponse extracts snake_case inline_data and blockReason', () => {
  const parsed = client.parseGenerateResponse({
    promptFeedback: { blockReason: 'SAFETY' },
    candidates: []
  });
  assert.equal(parsed.image, null);
  assert.equal(parsed.blockReason, 'SAFETY');

  const snake = client.parseGenerateResponse({
    candidates: [
      {
        content: {
          parts: [{ inline_data: { mime_type: 'image/webp', data: 'WFlZ' } }]
        }
      }
    ]
  });
  assert.deepEqual(snake.image, { mimeType: 'image/webp', data: 'WFlZ' });
});

// ---------------------------------------------------------------------------
// Browser-like sandbox: classic scripts in one global scope, optional API Matrix
// KeyStore (the shared key contract), optional throwing storage, stub fetch.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FAKE_KEY = 'AIzaFAKEfakeFAKEfakeFAKEfakeFAKEfake012';

function makeStorage(bag, throws) {
  return {
    getItem: (k) => { if (throws) throw new Error('SecurityError'); return Object.prototype.hasOwnProperty.call(bag, k) ? bag[k] : null; },
    setItem: (k, v) => { if (throws) throw new Error('QuotaExceededError'); bag[k] = String(v); },
    removeItem: (k) => { if (throws) throw new Error('SecurityError'); delete bag[k]; }
  };
}

function loadCell(opts) {
  const o = opts || {};
  const bags = { session: Object.create(null), local: Object.create(null) };
  const fetchCalls = [];
  const sandbox = {
    console, Uint8Array, ArrayBuffer, Blob, URL, AbortController, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, atob, btoa, Date, JSON, Promise,
    sessionStorage: makeStorage(bags.session, o.throwingStorage),
    localStorage: makeStorage(bags.local, o.throwingStorage),
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    dispatchEvent: () => true,
    fetch: (url, init) => {
      fetchCalls.push({ url: String(url), init: init });
      return o.fetch ? o.fetch(url, init) : Promise.reject(new Error('unexpected fetch'));
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  const files = [];
  if (o.withMatrix) files.push('../api-matrix/audio.js', '../api-matrix/probes.js');
  files.push('client.js');
  files.forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), ctx, { filename: f });
  });
  return { sandbox, client: sandbox.GeminiImageGen, matrix: sandbox.GeminiApiMatrix, bags, fetchCalls };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    json: async () => body
  };
}

// 1x1 transparent PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('KeyStore: a key cleared in API Matrix is gone here too (no stale memory copy)', () => {
  const env = loadCell({ withMatrix: true });
  env.client.KeyStore.set(FAKE_KEY, false);
  assert.equal(env.client.KeyStore.get(), FAKE_KEY);
  assert.equal(env.matrix.KeyStore.get(), FAKE_KEY);
  env.matrix.KeyStore.clear();
  assert.equal(env.client.KeyStore.get(), '');
});

test('KeyStore: a key saved in API Matrix is read here, and a clear here reaches API Matrix', () => {
  const env = loadCell({ withMatrix: true });
  env.matrix.KeyStore.set(FAKE_KEY, true);
  assert.equal(env.client.KeyStore.get(), FAKE_KEY);
  env.client.KeyStore.clear();
  assert.equal(env.matrix.KeyStore.get(), '');
  assert.equal(env.bags.local.dc_gemini_api_key_local, undefined);
});

test('KeyStore without API Matrix: storage emptied by a sibling reads as no key', () => {
  const env = loadCell({});
  env.client.KeyStore.set(FAKE_KEY, false);
  assert.equal(env.client.KeyStore.get(), FAKE_KEY);
  delete env.bags.session.dc_gemini_api_key_session;
  assert.equal(env.client.KeyStore.get(), '');
});

test('KeyStore keeps a memory-only key when storage throws, and clears it', () => {
  [false, true].forEach((withMatrix) => {
    const env = loadCell({ throwingStorage: true, withMatrix: withMatrix });
    env.client.KeyStore.set(FAKE_KEY, true);
    assert.equal(env.client.KeyStore.get(), FAKE_KEY, 'withMatrix=' + withMatrix);
    env.client.KeyStore.clear();
    assert.equal(env.client.KeyStore.get(), '', 'withMatrix=' + withMatrix);
  });
});

test('KeyStore.mask never shows the middle of the key', () => {
  assert.equal(client.KeyStore.mask(FAKE_KEY), 'AIza••••e012');
  assert.equal(client.KeyStore.mask('short1234'), '••••34');
  assert.equal(client.KeyStore.mask(''), '');
});

test('generateImage rejects a key that cannot be an HTTP header before any fetch', async () => {
  const env = loadCell({ fetch: async () => jsonResponse(200, {}) });
  await assert.rejects(
    env.client.generateImage({ apiKey: 'AIza​key', prompt: 'mug' }),
    /characters an API key cannot have/
  );
  assert.equal(env.fetchCalls.length, 0);
});

test('generateImage sends the key only in a header, and returns one decoded Blob (no data URL)', async () => {
  const env = loadCell({
    fetch: async () => jsonResponse(200, {
      candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } }]
    })
  });
  const out = await env.client.generateImage({ apiKey: FAKE_KEY, prompt: ' mug ', model: 'gemini-3-pro-image-preview', aspectRatio: '1:1' });
  assert.equal(env.fetchCalls.length, 1);
  assert.equal(env.fetchCalls[0].url.includes(FAKE_KEY), false);
  assert.equal(env.fetchCalls[0].url.endsWith('/models/gemini-3-pro-image-preview:generateContent'), true);
  assert.equal(env.fetchCalls[0].init.headers['x-goog-api-key'], FAKE_KEY);
  assert.equal(out.dataUrl, undefined);
  assert.equal(out.blob.type, 'image/png');
  const bytes = new Uint8Array(await out.blob.arrayBuffer());
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
});

test('generateImage reports malformed base64 as an error instead of a broken image', async () => {
  const env = loadCell({
    fetch: async () => jsonResponse(200, {
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'not base64 at all!!' } }] } }]
    })
  });
  await assert.rejects(env.client.generateImage({ apiKey: FAKE_KEY, prompt: 'mug' }), /not valid base64/);
});

test('generateImage explains safety blocks and empty candidates', async () => {
  const blocked = loadCell({ fetch: async () => jsonResponse(200, { promptFeedback: { blockReason: 'SAFETY' } }) });
  await assert.rejects(blocked.client.generateImage({ apiKey: FAKE_KEY, prompt: 'x' }), /No image returned \(SAFETY\)/);
  const imageSafety = loadCell({ fetch: async () => jsonResponse(200, { candidates: [{ finishReason: 'IMAGE_SAFETY' }] }) });
  await assert.rejects(imageSafety.client.generateImage({ apiKey: FAKE_KEY, prompt: 'x' }), /IMAGE_SAFETY/);
  const empty = loadCell({ fetch: async () => jsonResponse(200, { candidates: [] }) });
  await assert.rejects(empty.client.generateImage({ apiKey: FAKE_KEY, prompt: 'x' }), /No image returned in response/);
  const notJson = loadCell({ fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }) });
  await assert.rejects(notJson.client.generateImage({ apiKey: FAKE_KEY, prompt: 'x' }), /No image returned in response/);
});

test('parseGenerateResponse prefers the final image over a thought draft and skips non-image inline data', () => {
  const parsed = client.parseGenerateResponse({
    candidates: [{
      content: {
        parts: [
          { thought: true, text: 'Planning the composition.' },
          { thought: true, inlineData: { mimeType: 'image/png', data: 'RFJBRlQ=' } },
          { inlineData: { mimeType: 'application/pdf', data: 'UERG' } },
          { inlineData: { mimeType: 'image/png', data: 'RklOQUw=' } },
          { text: 'Done.' }
        ]
      }
    }]
  });
  assert.equal(parsed.image.data, 'RklOQUw=');
  assert.equal(parsed.text, 'Done.');

  const onlyThought = client.parseGenerateResponse({
    candidates: [{ content: { parts: [{ thought: true, inlineData: { mimeType: 'image/png', data: 'RFJBRlQ=' } }] } }]
  });
  assert.equal(onlyThought.image.data, 'RFJBRlQ=');
});

test('createRunSlot: a cancelled run cannot finish (clean up) the run that replaced it', () => {
  const slot = client.createRunSlot();
  const first = slot.begin();
  assert.equal(slot.busy(), true);
  assert.equal(slot.cancel(), true);
  assert.equal(first.signal.aborted, true);
  const second = slot.begin();
  assert.equal(slot.finish(first), false);
  assert.equal(slot.isCurrent(first), false);
  assert.equal(slot.busy(), true);
  assert.equal(slot.isCurrent(second), true);
  assert.equal(slot.finish(second), true);
  assert.equal(slot.busy(), false);
});

test('createRunSlot: begin while busy aborts the older request', () => {
  const slot = client.createRunSlot();
  const first = slot.begin();
  const second = slot.begin();
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
});

test('image-gen.css lets the hidden attribute hide the footer actions (and every ig- part)', () => {
  const css = fs.readFileSync(path.join(__dirname, 'image-gen.css'), 'utf8');
  // The restyle replaced the per-part `.ig-foot-actions[hidden]` rule with one cell-scoped rule
  // that beats every `.ig-*` display value.
  assert.match(css, /\.cell--image-gen \[hidden\]\s*\{\s*display:\s*none !important;?\s*\}/);
  assert.match(css, /\.ig-foot-actions\s*\{[^}]*display:\s*inline-flex/);
});

test('checkReferenceFile: rejects non-images and oversized files with a message, accepts images', () => {
  assert.match(client.checkReferenceFile({ name: 'notes.pdf', type: 'application/pdf', size: 10 }), /notes\.pdf is not an image/);
  assert.match(client.checkReferenceFile({ name: 'x', type: '', size: 10 }), /not an image/);
  assert.match(client.checkReferenceFile({ name: 'huge.png', type: 'image/png', size: 64 * 1048576 }), /huge\.png is 64 MB; reference images are limited to 20 MB/);
  assert.equal(client.checkReferenceFile({ name: 'ok.jpg', type: 'image/jpeg', size: 2 * 1048576 }), '');
  assert.match(client.checkReferenceFile(null), /No file/);
});

test('createLatestGuard: a slow earlier read cannot replace a later one, and invalidate drops both', () => {
  const guard = client.createLatestGuard();
  const first = guard.next();
  const second = guard.next();
  assert.equal(guard.isLatest(first), false);
  assert.equal(guard.isLatest(second), true);
  guard.invalidate(); // the slot was cleared while the read was pending
  assert.equal(guard.isLatest(second), false);
});

// ui.js needs a real DOM (it is exercised in the browser); these pin the wiring rules that
// were lost once already when the file was rewritten (static checks on the source).
const uiSrc = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');

function functionBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'ui.js must define ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced ' + name);
}

test('ui.js: no request on load or key sync: refreshKeyState never discovers; discovery runs from runGeneration only', () => {
  assert.equal(/discoverImageModels|discoverModelsOnce|generateImage/.test(functionBody(uiSrc, 'refreshKeyState')), false);
  assert.equal(uiSrc.split('\n').filter((l) => /discoverModelsOnce\(key\);/.test(l)).length, 1);
  assert.match(functionBody(uiSrc, 'runGeneration'), /discoverModelsOnce\(key\);/);
  assert.equal((uiSrc.match(/client\.discoverImageModels\(/g) || []).length, 1);
  assert.equal((uiSrc.match(/client\.generateImage\(/g) || []).length, 1);
});

test('ui.js: preset chips only fill the prompt (a chip click must not generate)', () => {
  const chips = uiSrc.slice(uiSrc.indexOf('PRESETS.forEach'), uiSrc.indexOf('function closeKeyBar'));
  assert.ok(chips.length > 0);
  assert.equal(/runGeneration\(/.test(chips), false);
});

test('ui.js: one run slot per tile (cancel race), one revoked object URL per result, decode before showing', () => {
  assert.match(uiSrc, /client\.createRunSlot\(\)/);
  assert.equal(/activeController/.test(uiSrc), false);
  const run = functionBody(uiSrc, 'runGeneration');
  assert.match(run, /if \(runSlot\.finish\(ctrl\)\) setBusy\(false\)/);
  assert.match(run, /await loadImage\(url\)/);
  assert.match(functionBody(uiSrc, 'showResult'), /URL\.revokeObjectURL\(previousUrl\)/);
  assert.equal(/result\.dataUrl/.test(uiSrc), false);
});

test('ui.js: the key is never prefilled, empty Save is a no-op, other tiles\' key changes repaint', () => {
  assert.equal(/keyInput\.value\s*=\s*client\.KeyStore\.get\(\)/.test(uiSrc), false);
  assert.match(uiSrc, /if \(!keyInput\.value\.trim\(\)\)/);
  assert.match(uiSrc, /addEventListener\('gemini-key-changed', refreshKeyState\)/);
});

test('ui.js: reference images: no FileReader copy, white under transparency, errors shown, latest wins', () => {
  const read = functionBody(uiSrc, 'readImageFile');
  assert.equal(/FileReader/.test(read), false);
  assert.match(read, /URL\.revokeObjectURL\(src\)/);
  assert.match(read, /fillStyle = '#ffffff'/);
  assert.match(read, /checkReferenceFile\(file\)/);
  const spot = functionBody(uiSrc, 'wireRefSpot');
  assert.equal(/catch\(function \(\) \{\}\)/.test(spot), false);
  assert.match(spot, /guard\.isLatest\(token\)/);
  // Enter on the clear button must clear the slot, not open the file picker.
  assert.match(spot, /if \(e\.target !== spotEl\) return;/);
});
