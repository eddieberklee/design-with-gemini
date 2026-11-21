(function (global) {
  'use strict';

  const NS = (global.GeminiImageTo3D = global.GeminiImageTo3D || {});

  const REST_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const SESSION_KEY = 'dc_gemini_api_key_session';
  const LOCAL_KEY = 'dc_gemini_api_key_local';

  const DEFAULT_FOUR_MODELS = [
    'gemini-3-pro-preview',
    'gemini-3.8-flash',
    'gemini-3.1-flash-lite-preview',
    'gemini-4-neon'
  ];

  const EXTRA_MODELS = [
    'gemini-4-hydrogen',
    'gemini-4-argon',
    'gemini-4-carbon',
    'gemini-4-neon'
  ];

  const MODEL_SLOTS_PREFERENCE = [
    [/^gemini-3(\.\d+)?-pro(?!.*image)/i, /^gemini-4-hydrogen$/i, /^gemini-2\.5-pro$/i],
    [/^gemini-3\.8-flash$/i, /^gemini-3(\.\d+)?-flash(?!.*(lite|image|tts|audio))/i, /^gemini-4-argon$/i],
    [/^gemini-3(\.\d+)?-flash-lite/i, /^gemini-4-carbon$/i],
    [/^gemini-4-neon$/i, /^gemini-4-hydrogen$/i, /^gemini-4-argon$/i, /^gemini-4-carbon$/i, /^gemini-3\.8-flash$/i]
  ];

  const EXCLUDE_RE = /(tts|image|live|audio|embedding|aqa|robotics|computer-use|deep-research|lyria|veo|imagen|gemma|decision|transcribe|learnlm|nano-banana|genie|^gemini-2\.0-|^gemini-2\.5-flash$)/i;

  const SYSTEM_PROMPT = [
    'You are a 3D CAD & sculptural modeling engine. Given an image of an object or scene,',
    'reconstruct it as a recognizable, well-proportioned 3D model composed of 12 to 32 geometric primitives.',
    'Return ONLY valid JSON matching this exact shape:',
    '{"title":"short object name","parts":[{"type":"box|sphere|cylinder|cone|torus","pos":[x,y,z],"rot":[rx,ry,rz],"scale":[sx,sy,sz],"color":"#rrggbb"}]}',
    'Rules:',
    '- Coordinates are right-handed (+Y is up). Center the subject near [0,0,0] with total size roughly 2 units.',
    '- rot is Euler angles in degrees [rx,ry,rz]. scale is positive dimensions [sx,sy,sz].',
    '- Use accurate colors sampled from the image in #rrggbb hex.',
    '- Build recognizable silhouettes with distinct body, limbs/handles/wheels/details.'
  ].join('\n');

  let memoryKey = '';

  function safeGet(storeName, key) {
    try {
      const store = global[storeName];
      return store ? store.getItem(key) || '' : '';
    } catch (_err) {
      return '';
    }
  }

  function safeSet(storeName, key, value) {
    try {
      const store = global[storeName];
      if (!store) return false;
      store.setItem(key, value);
      return true;
    } catch (_err) {
      return false;
    }
  }

  function safeRemove(storeName, key) {
    try {
      const store = global[storeName];
      if (store) store.removeItem(key);
    } catch (_err) {}
  }

  const KeyStore = {
    get: function () {
      const s = safeGet('sessionStorage', SESSION_KEY);
      if (s) { memoryKey = s; return s; }
      const l = safeGet('localStorage', LOCAL_KEY);
      if (l) { memoryKey = l; return l; }
      const matrixKs = global.GeminiApiMatrix && global.GeminiApiMatrix.KeyStore;
      if (matrixKs && typeof matrixKs.get === 'function') {
        try {
          const k = matrixKs.get();
          if (k) { memoryKey = k; return k; }
        } catch (_err) {}
      }
      return memoryKey || '';
    },
    set: function (rawKey, persistLocal) {
      const cleaned = String(rawKey || '').trim();
      memoryKey = cleaned;
      safeRemove('sessionStorage', SESSION_KEY);
      safeRemove('localStorage', LOCAL_KEY);
      if (cleaned) {
        if (persistLocal) safeSet('localStorage', LOCAL_KEY, cleaned);
        else safeSet('sessionStorage', SESSION_KEY, cleaned);
      }
      const matrixKs = global.GeminiApiMatrix && global.GeminiApiMatrix.KeyStore;
      if (matrixKs && typeof matrixKs.set === 'function') {
        try { matrixKs.set(cleaned, Boolean(persistLocal)); } catch (_err) {}
      }
      return cleaned;
    },
    clear: function () {
      KeyStore.set('', false);
    }
  };

  function stripModelsPrefix(name) {
    return String(name || '').replace(/^models\//, '');
  }

  function listEligibleModels(rawModels) {
    const eligible = [];
    const seen = Object.create(null);
    (Array.isArray(rawModels) ? rawModels : []).forEach(function (m) {
      if (!m || !m.name) return;
      const id = stripModelsPrefix(m.name);
      if (seen[id]) return;
      const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
      if (methods.length && methods.indexOf('generateContent') < 0) return;
      if (!/^gemini-/i.test(id) || EXCLUDE_RE.test(id)) return;
      seen[id] = true;
      eligible.push(id);
    });
    return eligible;
  }

  function pickFourModels(rawModels) {
    const eligible = listEligibleModels(rawModels);
    if (!eligible.length) return DEFAULT_FOUR_MODELS.slice();

    const chosen = [];
    for (let slot = 0; slot < MODEL_SLOTS_PREFERENCE.length; slot++) {
      const patterns = MODEL_SLOTS_PREFERENCE[slot];
      let picked = '';
      for (let p = 0; p < patterns.length && !picked; p++) {
        for (let i = 0; i < eligible.length; i++) {
          if (chosen.indexOf(eligible[i]) >= 0) continue;
          if (patterns[p].test(eligible[i])) {
            picked = eligible[i];
            break;
          }
        }
      }
      if (picked) chosen.push(picked);
    }

    for (let i = 0; i < eligible.length && chosen.length < 4; i++) {
      if (chosen.indexOf(eligible[i]) < 0) chosen.push(eligible[i]);
    }
    for (let i = 0; i < DEFAULT_FOUR_MODELS.length && chosen.length < 4; i++) {
      if (chosen.indexOf(DEFAULT_FOUR_MODELS[i]) < 0) chosen.push(DEFAULT_FOUR_MODELS[i]);
    }

    return chosen.slice(0, 4);
  }

  function parse3DSceneFromText(rawText) {
    let text = String(rawText || '').trim();
    if (!text) throw new Error('Empty model response');
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      text = text.slice(firstBrace, lastBrace + 1);
    }
    const parsed = JSON.parse(text);
    const rawParts = Array.isArray(parsed && parsed.parts) ? parsed.parts : [];
    const parts = [];
    for (let i = 0; i < rawParts.length && parts.length < 64; i++) {
      const p = rawParts[i];
      if (!p || typeof p !== 'object') continue;
      const pos = Array.isArray(p.pos) && p.pos.length === 3 ? p.pos.map(Number) : [0, 0, 0];
      const rot = Array.isArray(p.rot) && p.rot.length === 3 ? p.rot.map(Number) : [0, 0, 0];
      const scale = Array.isArray(p.scale) && p.scale.length === 3 ? p.scale.map(Number) : [0.5, 0.5, 0.5];
      if (pos.some(Number.isNaN) || rot.some(Number.isNaN) || scale.some(Number.isNaN)) continue;
      parts.push({
        type: String(p.type || 'box').toLowerCase(),
        pos: pos,
        rot: rot,
        scale: scale.map(function (v) { return Math.max(0.03, Math.abs(v)); }),
        color: typeof p.color === 'string' ? p.color : '#a0a8b0'
      });
    }
    if (!parts.length) throw new Error('No valid 3D parts in JSON');
    return {
      title: String((parsed && parsed.title) || '3D Model').slice(0, 48),
      parts: parts
    };
  }

  async function discoverModels(apiKey, signal) {
    const key = String(apiKey || '').trim();
    if (!key) {
      return {
        selected: DEFAULT_FOUR_MODELS.slice(),
        available: DEFAULT_FOUR_MODELS.slice()
      };
    }
    try {
      const res = await fetch(REST_BASE + '/models?pageSize=200', {
        method: 'GET',
        headers: { 'x-goog-api-key': key },
        signal: signal
      });
      if (!res.ok) {
        return { selected: DEFAULT_FOUR_MODELS.slice(), available: DEFAULT_FOUR_MODELS.slice() };
      }
      const json = await res.json();
      const eligible = listEligibleModels(json && json.models);
      const selected = pickFourModels(json && json.models);
      const merged = selected.slice();
      EXTRA_MODELS.concat(eligible).forEach(function (id) {
        if (merged.indexOf(id) < 0) merged.push(id);
      });
      return {
        selected: selected,
        available: merged
      };
    } catch (_err) {
      return { selected: DEFAULT_FOUR_MODELS.slice(), available: DEFAULT_FOUR_MODELS.slice() };
    }
  }

  async function generate3DForModel(params) {
    const apiKey = String((params && params.apiKey) || '').trim();
    const model = stripModelsPrefix(params && params.model);
    const base64Data = params && params.base64Data;
    const mimeType = (params && params.mimeType) || 'image/jpeg';
    const signal = params && params.signal;

    if (!apiKey) throw new Error('Missing API key');
    if (!base64Data) throw new Error('No image provided');

    const t0 = Date.now();
    const url = REST_BASE + '/models/' + encodeURIComponent(model) + ':generateContent';
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: mimeType, data: base64Data } },
            { text: 'Generate the 3D JSON primitive model of the main subject in this image.' }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.35
      }
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(body),
      signal: signal
    });

    let json = null;
    try { json = await res.json(); } catch (_err) {}

    if (!res.ok) {
      const msg = (json && json.error && json.error.message)
        ? 'HTTP ' + res.status + ': ' + json.error.message
        : 'HTTP ' + res.status;
      throw new Error(msg);
    }

    const parts = (json && json.candidates && json.candidates[0] &&
      json.candidates[0].content && json.candidates[0].content.parts) || [];
    const text = parts.map(function (p) { return p && p.text ? p.text : ''; }).join('\n');
    const scene = parse3DSceneFromText(text);

    return {
      model: model,
      scene: scene,
      elapsedMs: Date.now() - t0
    };
  }

  NS.Client = {
    DEFAULT_FOUR_MODELS: DEFAULT_FOUR_MODELS,
    KeyStore: KeyStore,
    listEligibleModels: listEligibleModels,
    pickFourModels: pickFourModels,
    parse3DSceneFromText: parse3DSceneFromText,
    discoverModels: discoverModels,
    generate3DForModel: generate3DForModel
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = NS.Client;
  }
})(typeof window !== 'undefined' ? window : globalThis);
