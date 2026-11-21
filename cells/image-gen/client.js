(function (global) {
  'use strict';

  const REST_BASE = 'https://generativelanguage.googleapis.com/v1beta';
  const SESSION_KEY = 'dc_gemini_api_key_session';
  const LOCAL_KEY = 'dc_gemini_api_key_local';

  const DEFAULT_MODELS = [
    { id: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro (3 Pro)' },
    { id: 'gemini-3.1-flash-image-preview', label: 'Nano Banana 2 (3.1 Flash)' },
    { id: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image' }
  ];

  const MODEL_RANK_PATTERNS = [
    /^gemini-3-pro-image$/,
    /^gemini-3-pro-image-preview$/,
    /^gemini-3(\.\d+)?-pro-image/,
    /^gemini-3\.1-flash-image$/,
    /^gemini-3\.1-flash-image-preview$/,
    /^gemini-3(\.\d+)?-flash-image/,
    /^gemini-nano-banana-2\.1/,
    /^gemini-nano-banana/,
    /^gemini-2\.5-flash-image$/,
    /^gemini-2\.5-flash-image/,
    /^gemini-.*image/
  ];

  const ASPECT_RATIOS = ['4:3', '1:1', '16:9', '9:16'];

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
      if (s) {
        memoryKey = s;
        return s;
      }
      const l = safeGet('localStorage', LOCAL_KEY);
      if (l) {
        memoryKey = l;
        return l;
      }
      const matrixKs = global.GeminiApiMatrix && global.GeminiApiMatrix.KeyStore;
      if (matrixKs && typeof matrixKs.get === 'function') {
        try {
          const k = matrixKs.get();
          if (k) {
            memoryKey = k;
            return k;
          }
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
        if (persistLocal) {
          safeSet('localStorage', LOCAL_KEY, cleaned);
        } else {
          safeSet('sessionStorage', SESSION_KEY, cleaned);
        }
      }
      const matrixKs = global.GeminiApiMatrix && global.GeminiApiMatrix.KeyStore;
      if (matrixKs && typeof matrixKs.set === 'function') {
        try {
          matrixKs.set(cleaned, Boolean(persistLocal));
        } catch (_err) {}
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

  function rankImageModels(rawModels) {
    const seen = Object.create(null);
    const candidates = [];
    (Array.isArray(rawModels) ? rawModels : []).forEach(function (m) {
      if (!m || !m.name) return;
      const id = stripModelsPrefix(m.name);
      if (seen[id]) return;
      const methods = Array.isArray(m.supportedGenerationMethods)
        ? m.supportedGenerationMethods
        : [];
      const isGeminiImage = /(^gemini-.*image|^gemini-nano-banana)/i.test(id);
      if (!isGeminiImage) return;
      if (methods.length && methods.indexOf('generateContent') < 0) return;
      seen[id] = true;
      candidates.push({
        id: id,
        label: m.displayName ? m.displayName + ' (' + id + ')' : id
      });
    });

    candidates.sort(function (a, b) {
      const ra = MODEL_RANK_PATTERNS.findIndex(function (re) { return re.test(a.id); });
      const rb = MODEL_RANK_PATTERNS.findIndex(function (re) { return re.test(b.id); });
      const sa = ra >= 0 ? ra : MODEL_RANK_PATTERNS.length;
      const sb = rb >= 0 ? rb : MODEL_RANK_PATTERNS.length;
      if (sa !== sb) return sa - sb;
      return a.id.localeCompare(b.id);
    });

    return candidates;
  }

  function buildGenerateRequest(prompt, options) {
    const opts = options || {};
    const text = String(prompt || '').trim();
    const generationConfig = {
      responseModalities: ['TEXT', 'IMAGE']
    };
    if (opts.aspectRatio && !opts.omitImageConfig) {
      generationConfig.imageConfig = {
        aspectRatio: opts.aspectRatio
      };
    }
    return {
      contents: [
        {
          role: 'user',
          parts: [{ text: text }]
        }
      ],
      generationConfig: generationConfig
    };
  }

  function parseGenerateResponse(json) {
    const candidates = (json && Array.isArray(json.candidates)) ? json.candidates : [];
    let image = null;
    const textParts = [];

    for (let i = 0; i < candidates.length; i++) {
      const parts = (candidates[i] && candidates[i].content && Array.isArray(candidates[i].content.parts))
        ? candidates[i].content.parts
        : [];
      for (let j = 0; j < parts.length; j++) {
        const part = parts[j];
        if (!part) continue;
        const inline = part.inlineData || part.inline_data;
        if (!image && inline && inline.data) {
          image = {
            mimeType: inline.mimeType || inline.mime_type || 'image/png',
            data: inline.data
          };
        }
        if (typeof part.text === 'string' && part.text.trim()) {
          textParts.push(part.text.trim());
        }
      }
    }

    const blockReason =
      (json && json.promptFeedback && json.promptFeedback.blockReason) ||
      (candidates[0] && candidates[0].finishReason && candidates[0].finishReason !== 'STOP'
        ? candidates[0].finishReason
        : '');

    return {
      image: image,
      text: textParts.join('\n'),
      blockReason: blockReason
    };
  }

  function extractErrorMessage(status, body) {
    if (body && body.error && body.error.message) {
      return 'HTTP ' + status + ': ' + body.error.message;
    }
    return 'HTTP ' + status + ' error';
  }

  async function discoverImageModels(apiKey, signal) {
    const key = String(apiKey || '').trim();
    if (!key) return DEFAULT_MODELS.slice();
    const res = await fetch(REST_BASE + '/models?pageSize=200', {
      method: 'GET',
      headers: { 'x-goog-api-key': key },
      signal: signal
    });
    if (!res.ok) return DEFAULT_MODELS.slice();
    const json = await res.json();
    const ranked = rankImageModels(json && json.models);
    return ranked.length ? ranked : DEFAULT_MODELS.slice();
  }

  async function generateImage(params) {
    const apiKey = String((params && params.apiKey) || '').trim();
    const model = stripModelsPrefix((params && params.model) || DEFAULT_MODELS[0].id);
    const prompt = String((params && params.prompt) || '').trim();
    const aspectRatio = (params && params.aspectRatio) || '4:3';
    const signal = params && params.signal;

    if (!apiKey) {
      throw new Error('Missing Gemini API key. Click Key to add one.');
    }
    if (!prompt) {
      throw new Error('Enter a prompt first.');
    }

    const url = REST_BASE + '/models/' + encodeURIComponent(model) + ':generateContent';

    async function callOnce(omitImageConfig) {
      const body = buildGenerateRequest(prompt, {
        aspectRatio: aspectRatio,
        omitImageConfig: omitImageConfig
      });
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
      try {
        json = await res.json();
      } catch (_err) {}
      return { res: res, json: json };
    }

    const t0 = Date.now();
    let attempt = await callOnce(false);
    if (!attempt.res.ok && attempt.res.status === 400 &&
        attempt.json && attempt.json.error &&
        /imageConfig|aspectRatio/i.test(attempt.json.error.message || '')) {
      attempt = await callOnce(true);
    }

    if (!attempt.res.ok) {
      throw new Error(extractErrorMessage(attempt.res.status, attempt.json));
    }

    const parsed = parseGenerateResponse(attempt.json);
    if (!parsed.image) {
      const detail = parsed.blockReason
        ? 'No image returned (' + parsed.blockReason + ').'
        : (parsed.text ? 'Model replied with text only: ' + parsed.text : 'No image returned in response.');
      throw new Error(detail);
    }

    return {
      model: model,
      mimeType: parsed.image.mimeType,
      dataUrl: 'data:' + parsed.image.mimeType + ';base64,' + parsed.image.data,
      text: parsed.text,
      elapsedMs: Date.now() - t0
    };
  }

  const api = {
    DEFAULT_MODELS: DEFAULT_MODELS,
    ASPECT_RATIOS: ASPECT_RATIOS,
    KeyStore: KeyStore,
    rankImageModels: rankImageModels,
    buildGenerateRequest: buildGenerateRequest,
    parseGenerateResponse: parseGenerateResponse,
    extractErrorMessage: extractErrorMessage,
    discoverImageModels: discoverImageModels,
    generateImage: generateImage
  };

  global.GeminiImageGen = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
