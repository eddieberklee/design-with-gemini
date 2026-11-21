'use strict';

// Pure-logic tests for the Decisions triptych: schema.js, presets.js, client.js.
// ui.js is DOM-bound and is exercised in the browser instead (see NOTES.md "How to verify").
// Run: node --test cells/decisions/decisions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeStorage(bag, opts) {
  return {
    getItem: (k) => {
      if (opts && opts.throws) throw new Error('SecurityError');
      return Object.prototype.hasOwnProperty.call(bag, k) ? bag[k] : null;
    },
    setItem: (k, v) => {
      if (opts && opts.throws) throw new Error('QuotaExceededError');
      bag[k] = String(v);
    },
    removeItem: (k) => {
      if (opts && opts.throws) throw new Error('SecurityError');
      delete bag[k];
    }
  };
}

function load(extra) {
  const bags = { session: Object.create(null), local: Object.create(null) };
  const events = [];
  const fetchCalls = [];
  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    AbortController: AbortController,
    performance: { now: () => Date.now() },
    navigator: { onLine: true },
    sessionStorage: makeStorage(bags.session, extra && extra.storageThrows ? { throws: true } : null),
    localStorage: makeStorage(bags.local, extra && extra.storageThrows ? { throws: true } : null),
    document: {
      createElement: function () {
        // presets.js draws sample receipts on a canvas; with no 2D context it returns the blank canvas.
        return { width: 0, height: 0, getContext: () => null, toDataURL: () => 'data:image/png;base64,AAAA' };
      }
    },
    CustomEvent: function (type, init) {
      this.type = type;
      this.detail = init && init.detail;
    },
    dispatchEvent: function (ev) {
      events.push(ev);
      return true;
    },
    fetch: function (url, init) {
      fetchCalls.push({ url: String(url), init: init });
      return extra && extra.fetch ? extra.fetch(url, init) : Promise.reject(new Error('no fetch stub'));
    }
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  ['schema.js', 'presets.js', 'client.js'].forEach(function (file) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), ctx, { filename: file });
  });
  const NS = sandbox.GeminiDecisions;
  return { NS: NS, Schema: NS.Schema, Presets: NS.Presets, Client: NS.Client, bags: bags, events: events, fetchCalls: fetchCalls, sandbox: sandbox };
}

// Values created inside the vm context have a different Object.prototype; compare structurally.
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

function allPresetStates(Presets) {
  const out = [];
  Presets.LIST.forEach(function (p) {
    p.variants.forEach(function (v, idx) {
      out.push({ preset: p, variant: v, state: Presets.createPresetState(p.id, idx) });
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// schema.js — validateState
// ---------------------------------------------------------------------------

test('validateState: every preset × variant validates with 3 active questions', () => {
  const { Schema, Presets } = load();
  allPresetStates(Presets).forEach(function (entry) {
    const v = Schema.validateState(entry.state);
    assert.equal(v.valid, true, entry.preset.id + '/' + entry.variant.id + ': ' + JSON.stringify(v.errors));
    assert.equal(v.activeCount, 3);
  });
});

test('validateState: empty input, no questions, and null state report errors without throwing', () => {
  const { Schema } = load();
  const v = Schema.validateState({ inputText: '   ', image: null, questions: [] });
  assert.equal(v.valid, false);
  assert.deepEqual(plain(v.errors.map((e) => e.field)), ['input', 'questions']);
  assert.equal(Schema.validateState(null).valid, false);
  assert.equal(Schema.validateState(undefined).valid, false);
  const disabled = Schema.validateState({ inputText: 'x', questions: [{ id: 'a', enabled: false, key: 'k', type: 'noul', instructions: 'i' }] });
  assert.equal(disabled.errors[0].field, 'questions');
});

test('validateState: question key rules (empty, too long, bad chars, reserved, duplicate)', () => {
  const { Schema } = load();
  const base = { id: 'q', type: 'noul', instructions: 'Is it?' };
  function keyErrors(keys) {
    const v = Schema.validateState({
      inputText: 'text',
      questions: keys.map((k, i) => Object.assign({}, base, { id: 'q' + i, key: k }))
    });
    return v.errors.filter((e) => e.field === 'question.key');
  }
  assert.equal(keyErrors(['']).length, 1);
  assert.equal(keyErrors(['a'.repeat(65)]).length, 1);
  assert.equal(keyErrors(['a'.repeat(64)]).length, 0);
  assert.equal(keyErrors(['has space']).length, 1);
  assert.equal(keyErrors(['__proto__'])[0].message.includes('reserved'), true);
  const dup = keyErrors(['same', ' same ']);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].questionId, 'q1');
  assert.match(dup[0].message, /Duplicate/);
});

test('validateState: choice needs ≥2 options with unique, valid keys and descriptions', () => {
  const { Schema } = load();
  function errs(options) {
    return Schema.validateState({
      inputText: 'text',
      questions: [{ id: 'c', key: 'route', type: 'choice', instructions: 'Which?', options: options }]
    }).errors;
  }
  assert.equal(errs([{ key: 'a', description: 'A' }])[0].field, 'question.options');
  assert.equal(errs([]).some((e) => e.field === 'question.options'), true);
  const dup = errs([{ key: 'a', description: 'A' }, { key: 'a', description: 'B' }]);
  assert.equal(dup.length, 1);
  assert.equal(dup[0].field, 'question.option.key');
  assert.equal(dup[0].optionIndex, 1);
  const blank = errs([{ key: 'a', description: '' }, { key: 'b c', description: 'B' }]);
  assert.deepEqual(plain(blank.map((e) => e.field)).sort(), ['question.option.description', 'question.option.key']);
  // null option entries must not throw
  assert.doesNotThrow(() => errs([null, { key: 'b', description: 'B' }]));
});

test('validateState: score needs ≥2 non-empty rubric levels; unsupported type and empty instructions flagged', () => {
  const { Schema } = load();
  function errs(q) {
    return Schema.validateState({ inputText: 'text', questions: [Object.assign({ id: 's', key: 'k', instructions: 'Rate' }, q)] }).errors;
  }
  assert.equal(errs({ type: 'score', levels: [] })[0].field, 'question.levels');
  assert.equal(errs({ type: 'score', levels: ['only'] })[0].field, 'question.levels');
  const empty = errs({ type: 'score', levels: ['a', '  ', 3] });
  assert.deepEqual(plain(empty.map((e) => e.levelIndex)), [1, 2]);
  assert.equal(errs({ type: 'bogus' })[0].field, 'question.type');
  assert.equal(errs({ type: 'noul', instructions: '  ' })[0].field, 'question.instructions');
});

test('validateState: more than 1,000 active questions is rejected', () => {
  const { Schema } = load();
  const qs = [];
  for (let i = 0; i < 1001; i++) qs.push({ id: 'q' + i, key: 'k' + i, type: 'noul', instructions: 'x' });
  const v = Schema.validateState({ inputText: 'x', questions: qs });
  assert.equal(v.valid, false);
  assert.match(v.errors[0].message, /1,000/);
});

// ---------------------------------------------------------------------------
// schema.js — buildRequestBody / formatRequestJson / buildCurl
// ---------------------------------------------------------------------------

test('buildRequestBody: text-only input is a plain string; questions map matches wire contract', () => {
  const { Schema, Presets } = load();
  const st = Presets.createPresetState('support', 1);
  const body = plain(Schema.buildRequestBody(st));
  assert.equal(body.model, 'gemini-decision-1');
  assert.equal(typeof body.input, 'string');
  assert.equal(body.input, st.inputText.trim());
  assert.deepEqual(Object.keys(body.questions), ['needs_escalation', 'routing_queue', 'severity']);
  assert.deepEqual(Object.keys(body.questions.needs_escalation).sort(), ['criteria', 'instructions', 'type']);
  assert.deepEqual(Object.keys(body.questions.needs_escalation.criteria).sort(), ['false_description', 'true_description']);
  assert.deepEqual(Object.keys(body.questions.routing_queue.criteria), ['engineering', 'billing', 'account_access', 'general']);
  assert.equal(Array.isArray(body.questions.severity.criteria), true);
  assert.equal(body.questions.severity.criteria.length, 4);
  // UI-only fields never reach the wire
  const wire = JSON.stringify(body);
  ['cardQuestion', 'levelLabels', 'threshold', '"label"', '"enabled"', '"id"'].forEach((f) => assert.equal(wire.includes(f), false, f));
});

test('buildRequestBody: image + text is an array with the image part first; resolution falls back to medium', () => {
  const { Schema, Presets } = load();
  const st = Presets.createPresetState('receipt', 0);
  st.resolution = 'ultra';
  const body = plain(Schema.buildRequestBody(st));
  assert.equal(Array.isArray(body.input), true);
  assert.deepEqual(body.input.map((p) => p.type), ['image', 'text']);
  assert.equal(body.input[0].mime_type, 'image/png');
  assert.equal(body.input[0].resolution, 'medium');
  st.inputText = '   ';
  assert.deepEqual(plain(Schema.buildRequestBody(st)).input.map((p) => p.type), ['image']);
});

test('buildRequestBody: disabled, reserved and keyless questions are dropped; empty noul criteria omitted', () => {
  const { Schema } = load();
  const body = plain(Schema.buildRequestBody({
    inputText: ' hi ',
    questions: [
      { key: ' keep ', type: 'noul', instructions: ' Is it? ', trueDescription: ' ', falseDescription: '' },
      { key: 'off', type: 'noul', instructions: 'x', enabled: false },
      { key: '__proto__', type: 'noul', instructions: 'x' },
      { key: '', type: 'noul', instructions: 'x' },
      null
    ]
  }));
  assert.equal(body.input, 'hi');
  assert.deepEqual(body.questions, { keep: { type: 'noul', instructions: 'Is it?' } });
});

test('buildCurl: key is always the $GEMINI_API_KEY placeholder; single quotes are shell-escaped; base64 omitted by default', () => {
  const { Schema, Presets } = load();
  const st = Presets.createPresetState('receipt', 0);
  st.inputText = "it's a test";
  const curl = Schema.buildCurl(Schema.buildRequestBody(st));
  assert.match(curl, /-H "x-goog-api-key: \$GEMINI_API_KEY"/);
  assert.equal(curl.includes('AIza'), false);
  assert.equal(curl.includes("it'\\''s a test"), true);
  assert.match(curl, /<base64 image\/png · .* omitted>/);
  assert.equal(curl.startsWith('curl -X POST https://generativelanguage.googleapis.com/v1beta/decisions'), true);
  const full = Schema.formatRequestJson(Schema.buildRequestBody(st), { includeBase64: true });
  assert.equal(full.includes('"data": "AAAA"'), true);
});

// ---------------------------------------------------------------------------
// schema.js — normalizeResponse
// ---------------------------------------------------------------------------

function receiptQuestions(Presets) {
  return Presets.createPresetState('receipt', 0).questions;
}

test('normalizeResponse: well-formed answers for all three types', () => {
  const { Schema, Presets } = load();
  const qs = receiptQuestions(Presets);
  const n = Schema.normalizeResponse({
    answers: {
      policy_violation: { noul: 0.83, confidence: 0.83 },
      expense_category: { choice: 'unallowable_bar', probabilities: { meals_client: 0.1, unallowable_bar: 0.8, travel_transit: 0.02, needs_manual_audit: 0.08 }, confidence: 0.8 },
      audit_readiness: { score: 0.4, probabilities: { 0: 0.65, 1: 0.3, 2: 0.05, 3: 0 }, legend: { 0: 'Reject' } }
    },
    usage: { total_input_tokens: 600, total_output_tokens: 0, total_tokens: 600 }
  }, { questions: qs });
  const a = n.answers;
  assert.equal(a.policy_violation.noul, 0.83);
  assert.equal(a.expense_category.choice, 'unallowable_bar');
  assert.equal(a.expense_category.ranked[0].key, 'unallowable_bar');
  assert.equal(a.expense_category.winnerProb, 0.8);
  assert.equal(a.audit_readiness.min, 0);
  assert.equal(a.audit_readiness.max, 3);
  assert.equal(a.audit_readiness.peakIndex, 0);
  assert.equal(a.audit_readiness.levels[0].description, 'Reject');
  assert.equal(a.audit_readiness.levels[1].description, qs[2].levels[1]);
  assert.equal(n.usage.total_output_tokens, 0);
  assert.deepEqual(plain(n.invalid), []);
});

test('normalizeResponse: malformed roots never throw and yield no answers', () => {
  const { Schema, Presets } = load();
  const qs = receiptQuestions(Presets);
  [null, undefined, 'text', 42, [], { answers: [] }, { answers: 'x' }, { answers: null }].forEach(function (raw) {
    const n = Schema.normalizeResponse(raw, { questions: qs });
    assert.deepEqual(Object.keys(n.answers), []);
    assert.equal(n.usage.total_tokens, 0);
  });
  assert.doesNotThrow(() => Schema.normalizeResponse({ answers: { a: null, b: [], c: 'x', __proto__x: {} } }, null));
});

test('normalizeResponse: a non-numeric noul is reported invalid instead of rendered as a fabricated 50%', () => {
  const { Schema, Presets } = load();
  const n = Schema.normalizeResponse({ answers: { policy_violation: { noul: 'abc' } } }, { questions: receiptQuestions(Presets) });
  assert.equal(n.answers.policy_violation, undefined);
  assert.deepEqual(plain(n.invalid).map((i) => i.key), ['policy_violation']);
  // out-of-range but numeric values are still clamped to the documented 0.01..0.99 band
  const hi = Schema.normalizeResponse({ answers: { policy_violation: { noul: 7 } } }, { questions: receiptQuestions(Presets) });
  assert.equal(hi.answers.policy_violation.noul, 0.99);
});

test('normalizeResponse: a choice with no usable probability is invalid, not "0% winner"', () => {
  const { Schema, Presets } = load();
  const n = Schema.normalizeResponse({ answers: { expense_category: { probabilities: { meals_client: 'x', travel_transit: null } } } }, { questions: receiptQuestions(Presets) });
  assert.equal(n.answers.expense_category, undefined);
  assert.equal(n.invalid[0].key, 'expense_category');
  const none = Schema.normalizeResponse({ answers: { expense_category: { choice: 'meals_client' } } }, { questions: receiptQuestions(Presets) });
  assert.equal(none.answers.expense_category, undefined);
});

test('normalizeResponse: declared choice that is not the top probability keeps its own probability', () => {
  const { Schema, Presets } = load();
  const n = Schema.normalizeResponse({
    answers: { expense_category: { choice: 'travel_transit', probabilities: { meals_client: 0.6, travel_transit: 0.3, unallowable_bar: 0.1 } } }
  }, { questions: receiptQuestions(Presets) });
  const a = n.answers.expense_category;
  assert.equal(a.choice, 'travel_transit');
  assert.equal(a.winnerProb, 0.3);
  assert.equal(a.ranked[0].key, 'meals_client');
});

test('normalizeResponse: score range follows the question rubric even when levels are missing from the response', () => {
  const { Schema, Presets } = load();
  const n = Schema.normalizeResponse({
    answers: { audit_readiness: { probabilities: [0.1, 'NaN', 0.5] } }
  }, { questions: receiptQuestions(Presets) });
  const a = n.answers.audit_readiness;
  assert.equal(a.min, 0);
  assert.equal(a.max, 3);
  assert.deepEqual(plain(a.levels.map((l) => l.index)), [0, 1, 2, 3]);
  assert.deepEqual(plain(a.levels.map((l) => l.prob)), [0.1, 0, 0.5, 0]);
  // no declared score: expected value is normalised by the probability mass (0*0.1 + 2*0.5) / 0.6
  assert.ok(Math.abs(a.score - 1 / 0.6) < 1e-9, String(a.score));
  assert.equal(a.peakIndex, 2);
  assert.ok(Number.isFinite(a.stdDev));
});

test('normalizeResponse: a score with zero probability mass is invalid', () => {
  const { Schema, Presets } = load();
  const n = Schema.normalizeResponse({ answers: { audit_readiness: { probabilities: { 0: 0, 1: 'x' } } } }, { questions: receiptQuestions(Presets) });
  assert.equal(n.answers.audit_readiness, undefined);
  assert.equal(n.invalid[0].key, 'audit_readiness');
});

test('normalizeResponse: reserved answer keys are ignored', () => {
  const { Schema } = load();
  const raw = JSON.parse('{"answers":{"__proto__":{"noul":0.9},"constructor":{"noul":0.9},"ok":{"noul":0.2}}}');
  const n = Schema.normalizeResponse(raw, { questions: [] });
  assert.deepEqual(Object.keys(n.answers), ['ok']);
});

// ---------------------------------------------------------------------------
// schema.js — toDisplayPercents
// ---------------------------------------------------------------------------

test('toDisplayPercents: distributions that sum to ~1 display as whole percents summing to 100', () => {
  const { Schema } = load();
  const cases = [
    [0.005, 0.495, 0.495, 0.005],
    [0.333, 0.333, 0.334],
    [0.004, 0.012, 0.294, 0.69],
    [0.5, 0.49, 0.01],
    [0.735, 0.255, 0.01, 0]
  ];
  cases.forEach(function (probs) {
    const pct = plain(Schema.toDisplayPercents(probs));
    assert.equal(pct.reduce((a, b) => a + b, 0), 100, JSON.stringify(probs) + ' -> ' + JSON.stringify(pct));
    const rawPeak = probs.indexOf(Math.max.apply(null, probs));
    assert.equal(pct[rawPeak], Math.max.apply(null, pct), 'peak preserved for ' + JSON.stringify(probs));
    pct.forEach((p, i) => assert.ok(Math.abs(p - probs[i] * 100) < 1, 'within 1pt'));
  });
});

test('toDisplayPercents: partial or malformed distributions are rounded independently, never forced to 100', () => {
  const { Schema } = load();
  assert.deepEqual(plain(Schema.toDisplayPercents([0.1, 0.5])), [10, 50]);
  assert.deepEqual(plain(Schema.toDisplayPercents([NaN, 'x', 0.25, -1])), [0, 0, 25, 0]);
  assert.deepEqual(plain(Schema.toDisplayPercents([])), []);
  assert.deepEqual(plain(Schema.toDisplayPercents(null)), []);
});

// ---------------------------------------------------------------------------
// presets.js — integrity
// ---------------------------------------------------------------------------

test('presets: four scenarios, two variants each, one question of each type with consistent labels', () => {
  const { Presets } = load();
  assert.deepEqual(plain(Presets.LIST.map((p) => p.shortLabel)), ['Receipt', 'Ticket', 'UI QA', 'PR Gate']);
  Presets.LIST.forEach(function (p) {
    assert.equal(p.variants.length, 2, p.id);
    p.variants.forEach(function (v) {
      assert.ok(v.buttonLabel && v.title && v.summary && v.text, p.id + '/' + v.id);
      assert.equal(Array.isArray(v.bullets) && v.bullets.length >= 1, true);
    });
    assert.deepEqual(plain(p.questions.map((q) => q.type)), ['noul', 'choice', 'score']);
    const ids = p.questions.map((q) => q.id);
    assert.equal(new Set(ids).size, ids.length);
    const noul = p.questions[0];
    assert.ok(noul.threshold >= 0.05 && noul.threshold <= 0.95);
    const choice = p.questions[1];
    choice.options.forEach((o) => assert.ok(o.label && o.label.trim(), choice.key + '.' + o.key + ' label'));
    const score = p.questions[2];
    assert.equal(score.levelLabels.length, score.levels.length, score.key);
  });
});

test('presets: createPresetState returns independent copies and tolerates bad variant indexes', () => {
  const { Presets } = load();
  const a = Presets.createPresetState('receipt', 0);
  a.questions[1].options[0].key = 'mutated';
  a.questions[2].levels[0] = 'mutated';
  const b = Presets.createPresetState('receipt', 0);
  assert.equal(b.questions[1].options[0].key, 'meals_client');
  assert.equal(b.questions[2].levels[0].startsWith('Reject'), true);
  assert.equal(Presets.createPresetState('receipt', 7).variantIndex, 0);
  assert.equal(Presets.createPresetState('receipt', 1.5).variantIndex, 0);
  assert.equal(Presets.createPresetState('nope', 1).presetId, 'receipt');
});

// ---------------------------------------------------------------------------
// client.js — simulator
// ---------------------------------------------------------------------------

test('runSimulated: every preset produces in-range, normalisable answers that sum to 1 and are deterministic', () => {
  const { Schema, Presets, Client } = load();
  allPresetStates(Presets).forEach(function (entry) {
    const st = entry.state;
    const body = Schema.buildRequestBody(st);
    const sim = Client.runSimulated(st, body);
    const again = Client.runSimulated(Presets.createPresetState(st.presetId, st.variantIndex), body);
    assert.deepEqual(plain(sim.raw), plain(again.raw), 'deterministic ' + st.presetId);
    assert.equal(sim.mode, 'simulated');
    assert.equal(sim.raw.usage.total_output_tokens, 0);
    const n = Schema.normalizeResponse(sim.raw, st);
    assert.deepEqual(plain(n.invalid), []);
    st.questions.forEach(function (q) {
      const a = n.answers[q.key];
      assert.ok(a, st.presetId + ' ' + q.key);
      if (q.type === 'noul') {
        assert.ok(a.noul >= 0.01 && a.noul <= 0.99);
      } else if (q.type === 'choice') {
        assert.equal(Math.round(a.sum * 1000), 1000, q.key);
        a.ranked.forEach((r) => assert.ok(r.prob >= 0 && r.prob <= 1));
        assert.equal(a.choice, a.ranked[0].key);
        assert.equal(Object.keys(a.probabilities).length, q.options.length);
      } else {
        assert.equal(Math.round(a.sum * 1000), 1000, q.key);
        assert.equal(a.levels.length, q.levels.length);
        assert.ok(a.score >= 0 && a.score <= q.levels.length - 1);
      }
    });
  });
});

test('runSimulated: the A/B specimens of each scenario disagree on the yes/no check', () => {
  const { Schema, Presets, Client } = load();
  Presets.LIST.forEach(function (p) {
    const ps = [0, 1].map(function (i) {
      const st = Presets.createPresetState(p.id, i);
      const raw = Client.runSimulated(st, Schema.buildRequestBody(st)).raw;
      return raw.answers[p.questions[0].key].noul >= 0.5;
    });
    assert.notEqual(ps[0], ps[1], p.id);
  });
});

// ---------------------------------------------------------------------------
// client.js — live client error handling (no network: fetch is stubbed)
// ---------------------------------------------------------------------------

function jsonResponse(status, body, headers) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status: status,
    statusText: 'X',
    headers: { get: (h) => (headers && headers[h]) || null },
    text: () => Promise.resolve(text)
  };
}

test('runLive: key travels only in the x-goog-api-key header, never in the URL', async () => {
  const env = load({ fetch: () => Promise.resolve(jsonResponse(200, { answers: { a: { noul: 0.4 } } })) });
  const res = await env.Client.runLive({ model: 'm', input: 'x', questions: {} }, '  AIzaSECRET123456  ', null);
  assert.equal(res.mode, 'live');
  assert.equal(env.fetchCalls.length, 1);
  const call = env.fetchCalls[0];
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/decisions');
  assert.equal(call.url.includes('SECRET'), false);
  assert.equal(call.init.headers['x-goog-api-key'], 'AIzaSECRET123456');
  assert.equal(call.init.body.includes('SECRET'), false);
});

test('runLive: missing key rejects with MISSING_KEY and makes no request', async () => {
  const env = load();
  await assert.rejects(env.Client.runLive({}, '   ', null), (e) => e.code === 'MISSING_KEY');
  assert.equal(env.fetchCalls.length, 0);
});

test('runLive: an invalid key (HTTP 400 "API key not valid") is classified as a key problem', async () => {
  const env = load({
    fetch: () => Promise.resolve(jsonResponse(400, {
      error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' }
    }))
  });
  await assert.rejects(env.Client.runLive({}, 'AIzaBAD', null), function (e) {
    assert.equal(e.httpStatus, 400);
    assert.equal(e.code, 'API_KEY_INVALID');
    assert.equal(e.keyProblem, true);
    assert.match(e.headline, /key/i);
    assert.doesNotMatch(e.remediation, /Request JSON/);
    return true;
  });
  // The structured google.rpc ErrorInfo reason is honoured too.
  const env2 = load({
    fetch: () => Promise.resolve(jsonResponse(400, {
      error: { code: 400, message: 'Bad', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] }
    }))
  });
  await assert.rejects(env2.Client.runLive({}, 'AIzaBAD', null), (e) => e.code === 'API_KEY_INVALID' && e.keyProblem === true);
  // A genuine schema 400 is still a payload problem.
  const env3 = load({ fetch: () => Promise.resolve(jsonResponse(400, { error: { code: 400, message: 'questions.x.criteria: required', status: 'INVALID_ARGUMENT' } })) });
  await assert.rejects(env3.Client.runLive({}, 'AIzaOK', null), (e) => e.code === '400' && !e.keyProblem && /Request JSON/.test(e.remediation));
});

test('runLive: 200 with unreadable body is a MALFORMED_RESPONSE, and 401/429/safety map to their headlines', async () => {
  const bodies = ['not json', '[]', '{"answers":[]}', '{}'];
  for (const b of bodies) {
    const env = load({ fetch: () => Promise.resolve(jsonResponse(200, b)) });
    await assert.rejects(env.Client.runLive({}, 'AIzaOK', null), (e) => e.code === 'MALFORMED_RESPONSE' && e.httpStatus === 200, b);
  }
  const e401 = load({ fetch: () => Promise.resolve(jsonResponse(401, { error: { code: 401, message: 'no' } })) });
  await assert.rejects(e401.Client.runLive({}, 'k', null), (e) => e.httpStatus === 401 && e.keyProblem === true);
  const e429 = load({ fetch: () => Promise.resolve(jsonResponse(429, { error: { code: 429 } }, { 'Retry-After': '7' })) });
  await assert.rejects(e429.Client.runLive({}, 'k', null), (e) => e.retryAfter === '7' && /Wait 7s/.test(e.remediation));
  const eSafe = load({ fetch: () => Promise.resolve(jsonResponse(400, { error: { status: 'PROHIBITED_CONTENT' } })) });
  await assert.rejects(eSafe.Client.runLive({}, 'k', null), (e) => /safety/.test(e.headline));
});

test('runLive: user-facing remediation names the "Demo Data" mode the UI actually shows', async () => {
  const msgs = [];
  const env = load({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
  await env.Client.runLive({}, '', null).catch((e) => msgs.push(e.remediation));
  await env.Client.runLive({}, 'k', null).catch((e) => msgs.push(e.remediation));
  const e500 = load({ fetch: () => Promise.resolve(jsonResponse(500, 'boom')) });
  await e500.Client.runLive({}, 'k', null).catch((e) => msgs.push(e.remediation));
  assert.equal(msgs.length, 3);
  msgs.forEach((m) => assert.doesNotMatch(m, /Simulated/));
});

test('runLive: an external abort rejects with {aborted:true}; a pre-aborted signal makes no request', async () => {
  let rejectFetch;
  const env = load({
    fetch: (url, init) => new Promise((resolve, reject) => {
      rejectFetch = reject;
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })
  });
  const ac = new AbortController();
  const p = env.Client.runLive({}, 'k', ac.signal);
  ac.abort();
  await assert.rejects(p, (e) => e.aborted === true);
  assert.equal(typeof rejectFetch, 'function');
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(env.Client.runLive({}, 'k', pre.signal), (e) => e.aborted === true);
  assert.equal(env.fetchCalls.length, 1);
});

// ---------------------------------------------------------------------------
// client.js — KeyStore
// ---------------------------------------------------------------------------

test('KeyStore: session by default, local when asked, trims, clears, masks, and notifies', () => {
  const env = load();
  const ks = env.Client.KeyStore;
  assert.equal(ks.get(), '');
  assert.equal(ks.set('  AIzaSyABCDEFGH12345678  ', false), 'session');
  assert.equal(env.bags.session.dc_gemini_api_key_session, 'AIzaSyABCDEFGH12345678');
  assert.equal(ks.getStorageType(), 'session');
  assert.equal(ks.set('AIzaSyABCDEFGH12345678', true), 'local');
  assert.equal(env.bags.session.dc_gemini_api_key_session, undefined);
  assert.equal(env.bags.local.dc_gemini_api_key_local, 'AIzaSyABCDEFGH12345678');
  assert.equal(ks.mask('AIzaSyABCDEFGH12345678'), 'AIza••••5678');
  assert.equal(ks.mask('short'), '••••rt');
  assert.equal(ks.mask(''), '');
  ks.clear();
  assert.equal(ks.get(), '');
  assert.equal(Object.keys(env.bags.local).length + Object.keys(env.bags.session).length, 0);
  assert.equal(env.events.length, 3);
  env.events.forEach((ev) => {
    assert.equal(ev.type, 'gemini-key-changed');
    assert.equal(JSON.stringify(ev.detail).includes('AIza'), false);
  });
});

test('KeyStore: an external clear of storage is seen on the next get()', () => {
  const env = load();
  env.Client.KeyStore.set('AIzaKEY', false);
  delete env.bags.session.dc_gemini_api_key_session;
  assert.equal(env.Client.KeyStore.get(), '');
});

test('KeyStore: throwing storage falls back to page memory', () => {
  const env = load({ storageThrows: true });
  const ks = env.Client.KeyStore;
  assert.equal(ks.set('AIzaMEM', false), 'memory');
  assert.equal(ks.get(), 'AIzaMEM');
  assert.equal(ks.getStorageType(), 'memory');
  assert.equal(ks.isStorageRestricted(), true);
  ks.clear();
  assert.equal(ks.get(), '');
});
