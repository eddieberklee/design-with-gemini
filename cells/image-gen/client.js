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
  // True only when the last set() could not reach browser storage (quota, private mode);
  // otherwise empty storage means the key was cleared (possibly by another cell).
  let memoryOnly = false;

  function matrixKeyStore() {
    const ks = global.GeminiApiMatrix && global.GeminiApiMatrix.KeyStore;
    return ks && typeof ks.get === 'function' && typeof ks.set === 'function' ? ks : null;
  }

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

  // GeminiApiMatrix.KeyStore (cells/api-matrix/probes.js) is the shared contract: when it is
  // loaded its answer is authoritative, including '' after another cell cleared the key.
  // The local path below runs only when this file is used without the API Matrix cell.
  const KeyStore = {
    get: function () {
      const matrixKs = matrixKeyStore();
      if (matrixKs) {
        try {
          memoryKey = String(matrixKs.get() || '');
          return memoryKey;
        } catch (_err) {}
      }
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
      if (!memoryOnly) memoryKey = '';
      return memoryKey;
    },

    set: function (rawKey, persistLocal) {
      const cleaned = String(rawKey || '').trim();
      memoryKey = cleaned;
      const matrixKs = matrixKeyStore();
      if (matrixKs) {
        // Writes storage, syncs Decisions/Prosody and fires `gemini-key-changed`.
        try {
          matrixKs.set(cleaned, Boolean(persistLocal));
          return cleaned;
        } catch (_err) {}
      }
      safeRemove('sessionStorage', SESSION_KEY);
      safeRemove('localStorage', LOCAL_KEY);
      let stored = false;
      if (cleaned) {
        stored = persistLocal
          ? safeSet('localStorage', LOCAL_KEY, cleaned)
          : safeSet('sessionStorage', SESSION_KEY, cleaned);
      }
      memoryOnly = Boolean(cleaned) && !stored;
      return cleaned;
    },

    clear: function () {
      KeyStore.set('', false);
    },

    // Display form only; never put the raw key in the DOM.
    mask: function (key) {
      const k = String(key || '').trim();
      if (!k) return '';
      if (k.length < 16) return '••••' + k.slice(-2);
      return k.slice(0, 4) + '••••' + k.slice(-4);
    }
  };

  // fetch() throws a raw TypeError ("non ISO-8859-1 code point") for such a header value
  // before any request is sent; catch it first with a message the user can act on.
  function isHeaderSafeKey(key) {
    return /^[\x21-\x7e]+$/.test(String(key || ''));
  }

  // One in-flight request at a time. A run that was cancelled or replaced must not
  // clean up (or render over) the run that replaced it.
  function createRunSlot() {
    let current = null;
    return {
      begin: function () {
        if (current) current.abort();
        current = new AbortController();
        return current;
      },
      cancel: function () {
        if (!current) return false;
        current.abort();
        current = null;
        return true;
      },
      isCurrent: function (ctrl) {
        return Boolean(ctrl) && ctrl === current;
      },
      finish: function (ctrl) {
        if (!ctrl || ctrl !== current) return false;
        current = null;
        return true;
      },
      busy: function () {
        return Boolean(current);
      }
    };
  }

  const IMAGE_MIME_RE = /^image\/(png|jpeg|jpg|webp|gif|avif|heic|heif)$/i;

  // Decodes the base64 payload once into a Blob (the UI shows it through one object URL),
  // so the multi-megabyte string is not copied into several DOM attributes.
  function decodeBase64Image(data, mimeType) {
    const clean = String(data || '').replace(/\s+/g, '');
    if (!clean || /[^A-Za-z0-9+/=_-]/.test(clean)) {
      throw new Error('Image data in the response is not valid base64.');
    }
    let bin;
    try {
      bin = global.atob(clean.replace(/-/g, '+').replace(/_/g, '/'));
    } catch (_err) {
      throw new Error('Image data in the response is not valid base64.');
    }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
  }

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
    let thoughtImage = null;
    const textParts = [];

    for (let i = 0; i < candidates.length; i++) {
      const parts = (candidates[i] && candidates[i].content && Array.isArray(candidates[i].content.parts))
        ? candidates[i].content.parts
        : [];
      for (let j = 0; j < parts.length; j++) {
        const part = parts[j];
        if (!part) continue;
        // Thinking models can return interim drafts and reasoning marked `thought: true`;
        // the rendered answer is the non-thought part.
        const isThought = part.thought === true;
        const inline = part.inlineData || part.inline_data;
        if (inline && typeof inline.data === 'string' && inline.data) {
          const mimeType = String(inline.mimeType || inline.mime_type || 'image/png');
          if (IMAGE_MIME_RE.test(mimeType)) {
            const found = { mimeType: mimeType, data: inline.data };
            if (!isThought && !image) image = found;
            if (isThought && !thoughtImage) thoughtImage = found;
          }
        }
        if (!isThought && typeof part.text === 'string' && part.text.trim()) {
          textParts.push(part.text.trim());
        }
      }
    }
    if (!image) image = thoughtImage;

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
    if (!isHeaderSafeKey(apiKey)) {
      throw new Error('The saved key contains spaces or characters an API key cannot have. Paste it again.');
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

    const blob = decodeBase64Image(parsed.image.data, parsed.image.mimeType);
    return {
      model: model,
      mimeType: parsed.image.mimeType,
      blob: blob,
      text: parsed.text,
      elapsedMs: Date.now() - t0
    };
  }

  const api = {
    DEFAULT_MODELS: DEFAULT_MODELS,
    ASPECT_RATIOS: ASPECT_RATIOS,
    KeyStore: KeyStore,
    isHeaderSafeKey: isHeaderSafeKey,
    createRunSlot: createRunSlot,
    decodeBase64Image: decodeBase64Image,
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
