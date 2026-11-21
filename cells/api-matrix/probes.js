(function (global) {
  'use strict';

  const NS = (global.GeminiApiMatrix = global.GeminiApiMatrix || {});

  const REST_BASE = 'https://generativelanguage.googleapis.com';
  const WS_LIVE_BASE =
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

  const SESSION_KEY = 'dc_gemini_api_key_session';
  const LOCAL_KEY = 'dc_gemini_api_key_local';
  const ALLOWED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'];

  let memoryKey = '';
  let storageRestricted = false;
  // True when the last KeyStore.set could not write sessionStorage/localStorage (quota, private mode)
  // and the key lives only in memory; get() must then not read "empty storage" as a clear.
  let memoryFallback = false;

  function safeStorageGet(storeName, key) {
    try {
      const store = global[storeName];
      if (!store) return '';
      return store.getItem(key) || '';
    } catch (_err) {
      storageRestricted = true;
      return '';
    }
  }

  function safeStorageSet(storeName, key, value) {
    try {
      const store = global[storeName];
      if (!store) return false;
      store.setItem(key, value);
      return true;
    } catch (_err) {
      storageRestricted = true;
      return false;
    }
  }

  function safeStorageRemove(storeName, key) {
    try {
      const store = global[storeName];
      if (!store) return;
      store.removeItem(key);
    } catch (_err) {
      storageRestricted = true;
    }
  }

  // Live cross-cell key store synced with Cell #1 (decisions) & Cell #2 (prosody).
  const KeyStore = {
    get: function () {
      storageRestricted = false;
      const s = safeStorageGet('sessionStorage', SESSION_KEY);
      if (s) {
        memoryKey = s;
        return s;
      }
      const l = safeStorageGet('localStorage', LOCAL_KEY);
      if (l) {
        memoryKey = l;
        return l;
      }
      // If browser storage is readable, both stores are empty and our last save did reach storage,
      // a clear happened elsewhere.
      if (!storageRestricted && !memoryFallback) {
        memoryKey = '';
        return '';
      }
      const decisionsKs =
        global.GeminiDecisions &&
        global.GeminiDecisions.Client &&
        global.GeminiDecisions.Client.KeyStore;
      if (decisionsKs && typeof decisionsKs.get === 'function') {
        // Cell #1 keeps the same key in its closure; its clear() empties it, so it is the
        // cross-cell source of truth while storage cannot hold the key.
        let fromDecisions = '';
        try { fromDecisions = decisionsKs.get() || ''; } catch (_err) {}
        memoryKey = fromDecisions;
        return fromDecisions;
      }
      return memoryKey || '';
    },

    getStorageType: function () {
      if (safeStorageGet('sessionStorage', SESSION_KEY)) return 'session';
      if (safeStorageGet('localStorage', LOCAL_KEY)) return 'local';
      if (KeyStore.get()) return 'memory';
      return 'none';
    },

    set: function (rawKey, persistLocal) {
      const cleaned = String(rawKey || '').trim();
      memoryKey = cleaned;
      safeStorageRemove('sessionStorage', SESSION_KEY);
      safeStorageRemove('localStorage', LOCAL_KEY);

      let mode = 'none';
      if (cleaned) {
        if (persistLocal) {
          mode = safeStorageSet('localStorage', LOCAL_KEY, cleaned) ? 'local' : 'memory';
        } else {
          mode = safeStorageSet('sessionStorage', SESSION_KEY, cleaned) ? 'session' : 'memory';
        }
      }
      memoryFallback = mode === 'memory';

      // Keep sibling cells' closure caches in sync so all cells stay live without reloading.
      ['GeminiDecisions', 'GeminiProsody'].forEach(function (nsName) {
        const ks = global[nsName] && global[nsName].Client && global[nsName].Client.KeyStore;
        if (!ks) return;
        if (cleaned && typeof ks.set === 'function') {
          ks.set(cleaned, Boolean(persistLocal));
        } else if (!cleaned && typeof ks.clear === 'function') {
          ks.clear();
        }
      });

      if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
        global.dispatchEvent(new global.CustomEvent('gemini-key-changed', { detail: { hasKey: Boolean(cleaned), storage: mode } }));
      }
      return mode;
    },

    clear: function () {
      return KeyStore.set('', false);
    },

    mask: function (key) {
      const k = String(key || '').trim();
      if (!k) return '';
      // Never reveal more than a quarter of a short value (a 9-char value used to show 8 chars).
      if (k.length < 16) return '••••' + k.slice(-2);
      return k.slice(0, 4) + '••••' + k.slice(-4);
    },

    isStorageRestricted: function () {
      return storageRestricted || memoryFallback;
    }
  };

  // Rejects input that can never be sent as an HTTP header value: fetch() throws
  // "String contains non ISO-8859-1 code point" before any request leaves the browser,
  // which used to surface as a misleading NETWORK ERR / "Key rejected" halt.
  // Format (AIza prefix, length) is left to the server, which answers 400 API_KEY_INVALID.
  function validateApiKey(rawKey) {
    const key = String(rawKey == null ? '' : rawKey).trim();
    if (!key) {
      return { ok: false, key: '', error: 'Paste a Gemini API key (AIza...) first.' };
    }
    if (/\s/.test(key)) {
      return { ok: false, key: key, error: 'API key contains spaces or line breaks. Paste the key only.' };
    }
    if (/[^\x21-\x7E]/.test(key)) {
      return { ok: false, key: key, error: 'API key contains non-ASCII characters and cannot be sent in a request header.' };
    }
    return { ok: true, key: key, error: '' };
  }

  function stripModelsPrefix(id) {
    return String(id || '').trim().replace(/^models\//i, '');
  }

  function withModelsPrefix(id) {
    const bare = stripModelsPrefix(id);
    return bare ? 'models/' + bare : '';
  }

  function redactSecrets(input, activeKey) {
    let out;
    if (typeof input === 'string') {
      out = input;
    } else {
      try {
        out = JSON.stringify(input, null, 2);
      } catch (_err) {
        out = String(input);
      }
    }
    const key = String(activeKey || '').trim();
    if (key.length >= 4) {
      out = out.split(key).join('$GEMINI_API_KEY');
      const enc = encodeURIComponent(key);
      if (enc && enc !== key) {
        out = out.split(enc).join('$GEMINI_API_KEY');
      }
      try {
        const jsonEscaped = JSON.stringify(key).slice(1, -1);
        if (jsonEscaped && jsonEscaped !== key) {
          out = out.split(jsonEscaped).join('$GEMINI_API_KEY');
        }
      } catch (_err) {}
    }
    return out
      .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '***REDACTED_KEY***')
      .replace(/([?&](?:key|access_token)=)[^&\s"'#]+/gi, '$1$GEMINI_API_KEY')
      .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, '$1$GEMINI_API_KEY')
      .replace(/(x-goog-api-key:\s*)[^\s"']+/gi, '$1$GEMINI_API_KEY');
  }

  function redactDeep(value, activeKey) {
    if (typeof value === 'string') return redactSecrets(value, activeKey);
    if (Array.isArray(value)) {
      return value.map(function (v) { return redactDeep(v, activeKey); });
    }
    if (value && typeof value === 'object') {
      const out = {};
      Object.keys(value).forEach(function (k) {
        out[k] = redactDeep(value[k], activeKey);
      });
      return out;
    }
    return value;
  }

  function scrubProbeResult(result, activeKey) {
    if (!result || typeof result !== 'object') return result;
    const copy = Object.assign({}, result);
    if (typeof copy.summary === 'string') copy.summary = redactSecrets(copy.summary, activeKey);
    if (typeof copy.remediation === 'string') copy.remediation = redactSecrets(copy.remediation, activeKey);
    if (typeof copy.curl === 'string') copy.curl = redactSecrets(copy.curl, activeKey);
    if (copy.raw !== undefined) copy.raw = redactDeep(copy.raw, activeKey);
    return copy;
  }

  function formatByteCount(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function sanitizePayloadForInspector(value) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
      if (value.length > 60 && typeof value[0] === 'number') {
        return value.slice(0, 6).concat(['... (' + value.length + ' floats total)']);
      }
      return value.map(sanitizePayloadForInspector);
    }
    if (typeof value === 'object') {
      const out = {};
      Object.keys(value).forEach(function (k) {
        const v = value[k];
        if ((k === 'data' || k === 'bytesBase64Encoded') && typeof v === 'string' && v.length > 240) {
          const approxBytes = Math.floor((v.length * 3) / 4);
          out[k] = '<base64 payload omitted · ' + formatByteCount(approxBytes) + '>';
        } else {
          out[k] = sanitizePayloadForInspector(v);
        }
      });
      return out;
    }
    return value;
  }

  function escapeSingleQuotedShell(str) {
    return String(str).replace(/'/g, "'\\''");
  }

  function buildCurl(opts) {
    const method = opts.method || 'GET';
    const url = opts.url;
    const headers = opts.headers || {};
    const body = opts.body;
    const lines = ['curl -X ' + method + ' "' + url + '"'];
    Object.keys(headers).forEach(function (h) {
      lines.push('  -H "' + h + ': ' + headers[h] + '"');
    });
    if (body !== undefined && body !== null) {
      const displayBody = sanitizePayloadForInspector(body);
      const json = typeof displayBody === 'string' ? displayBody : JSON.stringify(displayBody, null, 2);
      lines.push("  -d '" + escapeSingleQuotedShell(json) + "'");
    }
    return lines.join(' \\\n');
  }

  // Prevents thinking models from burning all output tokens internally and returning empty visible text.
  function buildSafeTextGenConfig(bareModel, minVisible) {
    const id = stripModelsPrefix(bareModel).toLowerCase();
    const minTok = Number(minVisible) || 64;
    if (/^gemini-[34]/.test(id)) {
      const isPro = id.indexOf('pro') >= 0;
      return {
        maxOutputTokens: isPro ? Math.max(256, minTok) : Math.max(64, minTok),
        thinkingConfig: { thinkingLevel: isPro ? 'LOW' : 'MINIMAL' }
      };
    }
    if (/^gemini-2\.5/.test(id)) {
      const isPro = id.indexOf('pro') >= 0;
      return isPro
        ? { maxOutputTokens: Math.max(256, minTok), thinkingConfig: { thinkingBudget: 128 } }
        : { maxOutputTokens: Math.max(32, minTok), thinkingConfig: { thinkingBudget: 0 } };
    }
    return { maxOutputTokens: Math.max(16, minTok) };
  }

  function extractVisibleTextRaw(candidate) {
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : [];
    return parts
      .filter(function (p) {
        return p && !p.thought && typeof p.text === 'string';
      })
      .map(function (p) {
        return p.text;
      })
      .join('');
  }

  function extractVisibleText(candidate) {
    return extractVisibleTextRaw(candidate).trim();
  }

  // =========================================================================
  // 18 GOOGLE GEMINI API ENDPOINT DEFINITIONS
  // =========================================================================

  const ENDPOINTS = [
    {
      id: 'models',
      code: 'MOD',
      name: 'Models Catalog',
      category: 'core',
      protocol: 'REST',
      costTier: 'free',
      stage: 0,
      runInBatch: true,
      endpointTemplate: 'GET /v1beta/models?pageSize=1000',
      description: 'Lists every model enabled on this API key and drives dynamic model discovery for all other probes.'
    },
    {
      id: 'generate',
      code: 'GEN',
      name: 'Generate Content',
      category: 'core',
      protocol: 'REST',
      costTier: 'micro',
      stage: 2,
      runInBatch: true,
      endpointTemplate: 'POST /v1beta/models/{model}:generateContent',
      description: 'Standard unary text and multimodal generation with thinking-safe token configuration.'
    },
    {
      id: 'stream',
      code: 'SSE',
      name: 'Streaming SSE',
      category: 'core',
      protocol: 'SSE',
      costTier: 'micro',
      stage: 2,
      runInBatch: true,
      endpointTemplate: 'POST /v1beta/models/{model}:streamGenerateContent?alt=sse',
      description: 'Server-Sent Events streaming generation; verifies chunked framing and measures time-to-first-token.'
    },
    {
      id: 'interactions',
      code: 'INT',
      name: 'Interactions API',
      category: 'core',
      protocol: 'REST',
      costTier: 'micro',
      stage: 2,
      runInBatch: true,
      endpointTemplate: 'POST /v1beta/interactions',
      description: 'Stateful server-managed turn API supporting multi-turn IDs, background tasks, and tool orchestration.'
    },
    {
      id: 'decisions',
      code: 'DEC',
      name: 'Decisions API',
      category: 'core',
      protocol: 'REST',
      costTier: 'micro',
      stage: 2,
      runInBatch: true,
      endpointTemplate: 'POST /v1beta/decisions',
      description: 'Single-pass calibrated probability classifier (gemini-decision-1) returning zero output tokens.'
    },
    {
      id: 'grounding',
      code: 'SRH',
      name: 'Search Grounding',
      category: 'core',
      protocol: 'REST',
      costTier: 'metered',
      stage: 2,
      runInBatch: true,
      endpointTemplate: 'POST /v1beta/models/{model}:generateContent (google_search)',
      description: 'Live Google Search tool grounding; checks search query invocation and groundingMetadata support.'
    },
    {
      id: 'live_ws',
      code: 'WSS',
      name: 'Live API (WebSocket)',
      category: 'audio',
      protocol: 'WSS',
      costTier: 'micro',
      stage: 2,
      runInBatch: true,
      endpointTemplate: 'WSS /ws/...GenerativeService.BidiGenerateContent',
      description: 'Real-time bi-directional audio/video WebSocket handshake verifying setupComplete and clean close.'
    },
    {
      id: 'tts',
      code: 'TTS',
      name: 'Speech Synthesis (TTS)',
      category: 'audio',
      protocol: 'AUDIO',
      costTier: 'micro',
      stage: 2,
      runInBatch: true,
      endpointTemplate: 'POST /v1beta/models/{ttsModel}:generateContent (AUDIO)',
      description: 'Generates native Gemini speech audio (Kore voice), wraps PCM16LE into WAV, and enables inline playback.'
    },
    {
      id: 'audio_in',
      code: 'AUD',
      name: 'Audio Input & Transcribe',
      category: 'audio',
      protocol: 'AUDIO',
      costTier: 'micro',
      stage: 2,
      runInBatch: true,
      endpointTemplate: 'POST /v1beta/models/{model}:generateContent (audio/wav)',
      description: 'Uploads a procedural 0.35s 440Hz WAV clip to verify multimodal audio intake plus transcribe model discovery.'
    },
    {
      id: 'lyria',
      code: 'LYR',
      name: 'Music · Lyria',
      category: 'audio',
      protocol: 'MEDIA',
      costTier: 'free',
      stage: 1,
      runInBatch: true,
      endpointTemplate: 'GET /v1beta/models/{lyriaModel}',
      description: 'Checks whether Lyria music generation models are listed and accessible on this API key.'
    },
    {
      id: 'embeddings',
      code: 'EMB',
      name: 'Embeddings',
      category: 'media',
      protocol: 'REST',
      costTier: 'micro',
      stage: 2,
      runInBatch: true,
      endpointTemplate: 'POST /v1beta/models/{embedModel}:embedContent',
      description: 'Generates dense semantic vectors and verifies returned embedding dimensions.'
    },
    {
      id: 'count_tokens',
      code: 'TOK',
      name: 'Count Tokens',
      category: 'media',
      protocol: 'REST',
      costTier: 'free',
      stage: 1,
      runInBatch: true,
      endpointTemplate: 'POST /v1beta/models/{model}:countTokens',
      description: 'Free tokenizer check returning exact model token counts prior to generation.'
    },
    {
      id: 'image_gen',
      code: 'IMG',
      name: 'Image Generation',
      category: 'media',
      protocol: 'MEDIA',
      costTier: 'opt-in',
      stage: 1,
      runInBatch: true,
      supportsLiveGen: true,
      endpointTemplate: 'GET /v1beta/models/{imageModel} (+ opt-in live gen)',
      description: 'Checks Gemini Image / Imagen model access for $0 in batch runs; supports opt-in live image rendering.'
    },
    {
      id: 'veo',
      code: 'VEO',
      name: 'Video · Veo',
      category: 'media',
      protocol: 'MEDIA',
      costTier: 'free',
      stage: 1,
      runInBatch: true,
      endpointTemplate: 'GET /v1beta/models/{veoModel}',
      description: 'Checks Veo video model availability and predictLongRunning support without triggering billable video renders.'
    },
    {
      id: 'files',
      code: 'FIL',
      name: 'Files API',
      category: 'platform',
      protocol: 'REST',
      costTier: 'free',
      stage: 1,
      runInBatch: true,
      endpointTemplate: 'GET /v1beta/files?pageSize=5',
      description: 'Read-only check of the hosted multimodal file storage API (zero mutation).'
    },
    {
      id: 'caching',
      code: 'CAC',
      name: 'Context Caching',
      category: 'platform',
      protocol: 'REST',
      costTier: 'free',
      stage: 1,
      runInBatch: true,
      endpointTemplate: 'GET /v1beta/cachedContents?pageSize=5',
      description: 'Read-only check of server-side context cache access and active cached resources.'
    },
    {
      id: 'batches',
      code: 'BAT',
      name: 'Batch API',
      category: 'platform',
      protocol: 'REST',
      costTier: 'free',
      stage: 1,
      runInBatch: true,
      endpointTemplate: 'GET /v1beta/batches?pageSize=5',
      description: 'Read-only check of asynchronous batch job listing and operations access.'
    },
    {
      id: 'openai',
      code: 'OAI',
      name: 'OpenAI Compatibility',
      category: 'platform',
      protocol: 'REST',
      costTier: 'free',
      stage: 1,
      runInBatch: true,
      endpointTemplate: 'GET /v1beta/openai/models (Bearer)',
      description: 'Verifies drop-in OpenAI SDK compatibility layer using Bearer auth with your Gemini API key.'
    }
  ];

  // =========================================================================
  // DYNAMIC MODEL DISCOVERY CATALOG
  // =========================================================================

  function createEmptyCatalog() {
    return {
      models: [],
      loadedAt: null,
      buckets: {
        text: [],
        interactions: [],
        live: [],
        tts: [],
        transcribe: [],
        embeddings: [],
        image: [],
        veo: [],
        lyria: [],
        decisions: []
      }
    };
  }

  function rankByPreference(models, preferredPatterns) {
    return models.slice().sort(function (a, b) {
      const aBare = stripModelsPrefix(a.name).toLowerCase();
      const bBare = stripModelsPrefix(b.name).toLowerCase();
      let aRank = preferredPatterns.length;
      let bRank = preferredPatterns.length;
      for (let i = 0; i < preferredPatterns.length; i++) {
        if (aRank === preferredPatterns.length && preferredPatterns[i].test(aBare)) aRank = i;
        if (bRank === preferredPatterns.length && preferredPatterns[i].test(bBare)) bRank = i;
      }
      if (aRank !== bRank) return aRank - bRank;
      return aBare < bBare ? -1 : aBare > bBare ? 1 : 0;
    });
  }

  function buildCatalogFromModels(rawModels) {
    const byName = Object.create(null);
    const models = [];
    (Array.isArray(rawModels) ? rawModels : []).forEach(function (m) {
      if (!m || !m.name) return;
      if (byName[m.name]) return;
      byName[m.name] = true;
      models.push({
        name: m.name,
        bare: stripModelsPrefix(m.name),
        displayName: m.displayName || stripModelsPrefix(m.name),
        description: m.description || '',
        inputTokenLimit: m.inputTokenLimit || null,
        outputTokenLimit: m.outputTokenLimit || null,
        supportedGenerationMethods: Array.isArray(m.supportedGenerationMethods)
          ? m.supportedGenerationMethods.slice()
          : []
      });
    });

    function hasMethod(m, method) {
      return m.supportedGenerationMethods.indexOf(method) >= 0;
    }

    const excludeFromGeneralText =
      /(tts|image|live|audio|embedding|aqa|robotics|computer-use|deep-research|lyria|veo|imagen|gemma|decision|transcribe|learnlm|nano-banana|genie)/i;

    const textModels = rankByPreference(
      models.filter(function (m) {
        return hasMethod(m, 'generateContent') && /^gemini-/i.test(m.bare) && !excludeFromGeneralText.test(m.bare);
      }),
      [
        /^gemini-2\.5-flash$/,
        /^gemini-2\.5-flash-lite/,
        /^gemini-3(\.\d+)?-flash/,
        /^gemini-2\.5-pro/,
        /^gemini-2\.0-flash$/,
        /^gemini-2\.0-flash-lite/,
        /flash/
      ]
    );

    const interactionsModels = rankByPreference(
      textModels.filter(function (m) {
        return /^gemini-(2\.5|3|4)/i.test(m.bare);
      }),
      [/^gemini-2\.5-flash$/, /^gemini-3(\.\d+)?-flash/, /^gemini-2\.5-pro/, /flash/]
    );

    const liveModels = rankByPreference(
      models.filter(function (m) {
        return hasMethod(m, 'bidiGenerateContent') || /live|native-audio/i.test(m.bare);
      }),
      [/native-audio/, /^gemini-3(\.\d+)?-live/, /gemini-2\.5.*live/, /gemini-2\.0-flash-exp/, /live/]
    );

    const ttsModels = rankByPreference(
      models.filter(function (m) {
        return /tts/i.test(m.bare);
      }),
      [/^gemini-2\.5-flash.*tts/, /^gemini-3(\.\d+)?-flash.*tts/, /flash.*tts/, /tts/]
    );

    const transcribeModels = rankByPreference(
      models.filter(function (m) {
        return /transcribe/i.test(m.bare);
      }),
      [/transcribe-live/, /transcribe/]
    );

    const embedModels = rankByPreference(
      models.filter(function (m) {
        return hasMethod(m, 'embedContent') || /embedding/i.test(m.bare);
      }),
      [/^gemini-embedding-001$/, /^gemini-embedding-2/, /^gemini-embedding/, /^text-embedding-004/, /embedding/]
    );

    const imageModels = rankByPreference(
      models.filter(function (m) {
        return /(gemini-.*image|nano-banana|^imagen-)/i.test(m.bare);
      }),
      [/^gemini-2\.5-flash-image/, /^gemini-3(\.\d+)?-flash-image/, /^gemini-2\.0-flash.*image/, /^imagen-4/, /^imagen-3/, /image/]
    );

    const veoModels = rankByPreference(
      models.filter(function (m) {
        return /^veo-/i.test(m.bare) || hasMethod(m, 'predictLongRunning');
      }),
      [/^veo-3(\.\d+)?-fast/, /^veo-3/, /^veo-2/, /^veo-/]
    );

    const lyriaModels = rankByPreference(
      models.filter(function (m) {
        return /lyria/i.test(m.bare);
      }),
      [/^lyria-3/, /^lyria-/]
    );

    const decisionModels = models.filter(function (m) {
      return /decision/i.test(m.bare);
    });

    return {
      models: models,
      loadedAt: new Date().toISOString(),
      buckets: {
        text: textModels,
        interactions: interactionsModels.length ? interactionsModels : textModels,
        live: liveModels,
        tts: ttsModels,
        transcribe: transcribeModels,
        embeddings: embedModels,
        image: imageModels,
        veo: veoModels,
        lyria: lyriaModels,
        decisions: decisionModels
      }
    };
  }

  function pickBare(catalog, bucket, fallback) {
    const list = catalog && catalog.buckets && Array.isArray(catalog.buckets[bucket])
      ? catalog.buckets[bucket]
      : [];
    if (list.length > 0) return list[0].bare;
    return fallback || '';
  }

  function matchingNames(catalog, bucket) {
    const list = catalog && catalog.buckets && Array.isArray(catalog.buckets[bucket])
      ? catalog.buckets[bucket]
      : [];
    return list.map(function (m) {
      return m.bare;
    });
  }

  // =========================================================================
  // HTTP & 429 HELPERS
  // =========================================================================

  function sleepAbortable(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) {
        reject({ aborted: true });
        return;
      }
      const id = setTimeout(function () {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(id);
        reject({ aborted: true });
      }
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  function createCombinedController(timeoutMs, externalSignal) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    function onExternalAbort() {
      controller.abort();
    }
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer);
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    return {
      signal: controller.signal,
      didTimeout: function () {
        return timedOut;
      },
      cleanup: function () {
        clearTimeout(timer);
        if (externalSignal) {
          externalSignal.removeEventListener('abort', onExternalAbort);
        }
      }
    };
  }

  function parseRetryDelayMs(resp, payload) {
    const ra = resp && resp.headers ? resp.headers.get('Retry-After') : null;
    if (ra) {
      const secs = Number(ra);
      if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000);
    }
    const details = payload && payload.error && Array.isArray(payload.error.details)
      ? payload.error.details
      : [];
    for (let i = 0; i < details.length; i++) {
      const d = details[i];
      if (d && typeof d.retryDelay === 'string') {
        const match = /([\d.]+)s/i.exec(d.retryDelay);
        if (match) return Math.round(Number(match[1]) * 1000);
      }
    }
    return null;
  }

  function isHardQuotaExhausted(payload) {
    const msg = String((payload && payload.error && payload.error.message) || '');
    if (/limit:\s*0|per\s*day|daily\s+quota|billing|exceeded your current quota/i.test(msg)) {
      return true;
    }
    const details = payload && payload.error && Array.isArray(payload.error.details)
      ? payload.error.details
      : [];
    for (let i = 0; i < details.length; i++) {
      const str = JSON.stringify(details[i] || {});
      if (/PerDay|GenerateRequestsPerDay|limit.*0/i.test(str)) return true;
    }
    return false;
  }

  const INVALID_KEY_RE = /api[_ ]?key\s+(?:is\s+)?(?:not\s+valid|invalid)|api_key_invalid/i;

  function isInvalidKeyError(detail, payload) {
    if (INVALID_KEY_RE.test(String(detail || ''))) return true;
    if (payload && payload.error) {
      try {
        if (INVALID_KEY_RE.test(JSON.stringify(payload.error))) return true;
      } catch (_err) {}
    }
    return false;
  }

  function classifyHttpError(httpStatus, payload, fallbackText, endpointId) {
    const errObj = payload && payload.error && typeof payload.error === 'object' ? payload.error : {};
    const detail = String(errObj.message || fallbackText || 'HTTP ' + httpStatus);

    if (httpStatus === 401) {
      return {
        status: 'fail',
        badge: 'INVALID KEY',
        summary: 'HTTP 401 · API key rejected.',
        remediation: 'Check your Google AI Studio Gemini API key and save it again.'
      };
    }
    if (httpStatus === 400 && isInvalidKeyError(detail, payload)) {
      return {
        status: 'fail',
        badge: 'INVALID KEY',
        summary: 'HTTP 400 · API key is not valid.',
        remediation: 'Verify you pasted a valid Google AI Studio key (AIza...).'
      };
    }
    if (httpStatus === 403) {
      const isPreview = endpointId === 'decisions' || endpointId === 'lyria' || endpointId === 'veo';
      return {
        status: isPreview ? 'warn' : 'fail',
        badge: isPreview ? 'RESTRICTED' : 'DENIED 403',
        summary: 'HTTP 403 · ' + detail.slice(0, 110),
        remediation: isPreview
          ? 'This API/model requires preview allowlist, billing tier, or region enablement on this key.'
          : 'Confirm Generative Language API is enabled for this key and check key restrictions/billing.'
      };
    }
    if (httpStatus === 404) {
      const isPreview = endpointId === 'decisions' || endpointId === 'interactions' || endpointId === 'tts' || endpointId === 'lyria' || endpointId === 'veo';
      return {
        status: isPreview ? 'warn' : 'fail',
        badge: 'NOT FOUND',
        summary: 'HTTP 404 · ' + detail.slice(0, 110),
        remediation: 'Endpoint or model ID is not enabled on this API key or project region.'
      };
    }
    if (httpStatus === 429) {
      return {
        status: 'warn',
        badge: 'QUOTA 429',
        summary: 'HTTP 429 · ' + detail.slice(0, 110),
        remediation: 'Rate limit or quota reached on this key. Wait briefly or inspect Google AI Studio billing/quotas.'
      };
    }
    if (httpStatus === 400) {
      const billingHint = /billing|paid|tier/i.test(detail);
      return {
        status: billingHint ? 'warn' : 'fail',
        badge: billingHint ? 'TIER LIMIT' : 'HTTP 400',
        summary: 'HTTP 400 · ' + detail.slice(0, 110),
        remediation: billingHint
          ? 'This capability requires a billed Google AI Studio tier.'
          : 'Inspect Raw Response for exact request schema or model parameter rejection.'
      };
    }
    return {
      status: 'fail',
      badge: 'HTTP ' + httpStatus,
      summary: 'HTTP ' + httpStatus + ' · ' + detail.slice(0, 110),
      remediation: 'Retry the probe or inspect Raw Response for server diagnostics.'
    };
  }

  function fetchJsonWithRetry(opts) {
    const timeoutMs = opts.timeoutMs || 15000;
    const maxRetries = opts.allowRetry429 ? 1 : 0;
    let attempt = 0;

    function runAttempt() {
      const ctrl = createCombinedController(timeoutMs, opts.signal);
      const startedAt = performance.now();

      return fetch(opts.url, {
        method: opts.method || 'GET',
        headers: opts.headers || {},
        body: opts.body !== undefined && opts.body !== null ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal
      })
        .then(function (resp) {
          const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
          return resp.text().then(function (text) {
            ctrl.cleanup();
            let parsed = null;
            try {
              parsed = text ? JSON.parse(text) : {};
            } catch (_err) {
              parsed = { _rawText: text.slice(0, 1200) };
            }

            if (resp.status === 429 && attempt < maxRetries && !isHardQuotaExhausted(parsed)) {
              attempt += 1;
              const serverDelay = parseRetryDelayMs(resp, parsed);
              const waitMs = Math.min(serverDelay || 3000, 15000) + Math.round(Math.random() * 500);
              if (typeof opts.onStatusNote === 'function') {
                opts.onStatusNote('429 backoff (retrying in ' + (waitMs / 1000).toFixed(1) + 's)…');
              }
              return sleepAbortable(waitMs, opts.signal).then(runAttempt);
            }

            return {
              ok: resp.ok,
              httpStatus: resp.status,
              latencyMs: latencyMs,
              data: parsed,
              rawText: text
            };
          });
        })
        .catch(function (err) {
          ctrl.cleanup();
          if (err && err.aborted) throw err;
          if (err && err.name === 'AbortError') {
            if (ctrl.didTimeout()) {
              return {
                ok: false,
                httpStatus: 0,
                latencyMs: timeoutMs,
                timedOut: true,
                networkError: 'Timed out after ' + Math.round(timeoutMs / 1000) + 's.'
              };
            }
            throw { aborted: true };
          }
          return {
            ok: false,
            httpStatus: 0,
            latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
            networkError: err && err.message ? err.message : 'Network or CORS error.'
          };
        });
    }

    return runAttempt();
  }

  function makeNetworkResult(endpointId, modelUsed, curlCmd, res, extra) {
    if (res.timedOut) {
      return Object.assign(
        {
          id: endpointId,
          status: 'fail',
          badge: 'TIMEOUT',
          httpStatus: 0,
          latencyMs: res.latencyMs,
          modelUsed: modelUsed || null,
          summary: res.networkError,
          remediation: 'Retry the probe or check network latency to generativelanguage.googleapis.com.',
          curl: curlCmd,
          raw: { error: res.networkError },
          probedAt: new Date().toISOString()
        },
        extra || {}
      );
    }

    const isOpenAi = endpointId === 'openai';
    return Object.assign(
      {
        id: endpointId,
        status: isOpenAi ? 'warn' : 'fail',
        badge: isOpenAi ? 'CORS BLOCKED' : 'NETWORK ERR',
        httpStatus: 0,
        latencyMs: res.latencyMs,
        modelUsed: modelUsed || null,
        summary: isOpenAi
          ? 'Browser CORS / preflight blocked Authorization header on /v1beta/openai/models.'
          : 'Network or CORS error: ' + res.networkError,
        remediation: isOpenAi
          ? 'Copy the redacted cURL command in the Inspector to test OpenAI compatibility from terminal.'
          : 'Check internet connectivity or browser extensions blocking generativelanguage.googleapis.com.',
        curl: curlCmd,
        raw: { error: res.networkError },
        probedAt: new Date().toISOString()
      },
      extra || {}
    );
  }

  function isNonJsonResponse(res) {
    return Boolean(
      !res ||
      !res.data ||
      typeof res.data !== 'object' ||
      Array.isArray(res.data) ||
      Object.prototype.hasOwnProperty.call(res.data, '_rawText')
    );
  }

  function makeInvalidJsonResult(endpointId, modelUsed, curlCmd, res, extra) {
    const preview = res && res.data && typeof res.data._rawText === 'string'
      ? res.data._rawText.replace(/\s+/g, ' ').trim().slice(0, 90)
      : String((res && res.rawText) || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    return Object.assign(
      {
        id: endpointId,
        status: 'fail',
        badge: 'INVALID JSON',
        httpStatus: res ? res.httpStatus : 200,
        latencyMs: res ? res.latencyMs : 0,
        modelUsed: modelUsed || null,
        summary:
          'HTTP ' +
          (res ? res.httpStatus : 200) +
          ' returned non-JSON payload' +
          (preview ? ': ' + preview : '.'),
        remediation: 'Check for captive portals, HTML error proxies, or extensions intercepting generativelanguage.googleapis.com.',
        curl: curlCmd,
        raw: sanitizePayloadForInspector(res && res.data !== undefined ? res.data : { _rawText: preview }),
        probedAt: new Date().toISOString()
      },
      extra || {}
    );
  }

  function makeHttpErrorResult(endpointId, modelUsed, curlCmd, res, extra) {
    const info = classifyHttpError(res.httpStatus, res.data, res.rawText, endpointId);
    return Object.assign(
      {
        id: endpointId,
        status: info.status,
        badge: info.badge,
        httpStatus: res.httpStatus,
        latencyMs: res.latencyMs,
        modelUsed: modelUsed || null,
        summary: info.summary,
        remediation: info.remediation,
        curl: curlCmd,
        raw: sanitizePayloadForInspector(res.data),
        probedAt: new Date().toISOString()
      },
      extra || {}
    );
  }

  // =========================================================================
  // INDIVIDUAL PROBE IMPLEMENTATIONS (ALL 18 ENDPOINTS)
  // =========================================================================

  function probeModels(ctx) {
    const urlBase = REST_BASE + '/v1beta/models?pageSize=1000';
    const curl = buildCurl({
      method: 'GET',
      url: urlBase,
      headers: { 'x-goog-api-key': '$GEMINI_API_KEY' }
    });

    const allModels = [];
    let pageCount = 0;
    let totalLatency = 0;

    function fetchPage(pageToken) {
      const url = pageToken
        ? urlBase + '&pageToken=' + encodeURIComponent(pageToken)
        : urlBase;
      return fetchJsonWithRetry({
        url: url,
        method: 'GET',
        headers: { 'x-goog-api-key': ctx.apiKey },
        timeoutMs: 15000,
        signal: ctx.signal,
        allowRetry429: true,
        onStatusNote: ctx.onStatusNote
      }).then(function (res) {
        totalLatency += res.latencyMs || 0;
        if (res.networkError || res.timedOut) {
          return { errorResult: makeNetworkResult('models', null, curl, res) };
        }
        if (!res.ok) {
          return { errorResult: makeHttpErrorResult('models', null, curl, res) };
        }
        if (isNonJsonResponse(res)) {
          return { errorResult: makeInvalidJsonResult('models', null, curl, res) };
        }
        pageCount += 1;
        const pageModels = Array.isArray(res.data && res.data.models) ? res.data.models : [];
        for (let i = 0; i < pageModels.length; i++) {
          allModels.push(pageModels[i]);
        }
        if (res.data && res.data.nextPageToken && pageCount < 5) {
          return fetchPage(res.data.nextPageToken);
        }
        return { ok: true, httpStatus: res.httpStatus };
      });
    }

    return fetchPage(null).then(function (outcome) {
      if (outcome.errorResult) return outcome.errorResult;
      const catalog = buildCatalogFromModels(allModels);
      const b = catalog.buckets;
      return {
        id: 'models',
        status: 'pass',
        badge: catalog.models.length + ' MODELS',
        httpStatus: outcome.httpStatus,
        latencyMs: totalLatency,
        modelUsed: pickBare(catalog, 'text', null),
        catalog: catalog,
        discoveredModels: catalog.models.slice(0, 12).map(function (m) { return m.bare; }),
        summary:
          catalog.models.length +
          ' models discovered (' +
          b.text.length +
          ' text · ' +
          b.live.length +
          ' live · ' +
          b.tts.length +
          ' tts · ' +
          b.image.length +
          ' img · ' +
          b.veo.length +
          ' veo)',
        remediation: null,
        curl: curl,
        raw: {
          totalModels: catalog.models.length,
          pagesFetched: pageCount,
          bucketCounts: {
            text: b.text.length,
            interactions: b.interactions.length,
            live: b.live.length,
            tts: b.tts.length,
            transcribe: b.transcribe.length,
            embeddings: b.embeddings.length,
            image: b.image.length,
            veo: b.veo.length,
            lyria: b.lyria.length,
            decisions: b.decisions.length
          },
          sampleModels: catalog.models.slice(0, 20).map(function (m) {
            return { name: m.name, methods: m.supportedGenerationMethods };
          })
        },
        probedAt: new Date().toISOString()
      };
    });
  }

  function probeGenerate(ctx) {
    const bare = pickBare(ctx.catalog, 'text', 'gemini-2.5-flash');
    const url = REST_BASE + '/v1beta/models/' + encodeURIComponent(bare) + ':generateContent';
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'Reply with OK only.' }] }],
      generationConfig: buildSafeTextGenConfig(bare, 32)
    };
    const curl = buildCurl({
      method: 'POST',
      url: url,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': '$GEMINI_API_KEY' },
      body: body
    });

    return fetchJsonWithRetry({
      url: url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey },
      body: body,
      timeoutMs: 18000,
      signal: ctx.signal,
      allowRetry429: true,
      onStatusNote: ctx.onStatusNote
    }).then(function (res) {
      if (res.networkError || res.timedOut) return makeNetworkResult('generate', bare, curl, res);
      if (!res.ok) return makeHttpErrorResult('generate', bare, curl, res);
      if (isNonJsonResponse(res)) return makeInvalidJsonResult('generate', bare, curl, res);
      const cand = res.data && Array.isArray(res.data.candidates) ? res.data.candidates[0] : null;
      const visible = extractVisibleText(cand);
      const usage = res.data && res.data.usageMetadata ? res.data.usageMetadata : null;
      return {
        id: 'generate',
        status: 'pass',
        badge: 'HTTP 200',
        httpStatus: res.httpStatus,
        latencyMs: res.latencyMs,
        modelUsed: bare,
        discoveredModels: matchingNames(ctx.catalog, 'text').slice(0, 8),
        summary:
          'Reply: "' +
          (visible || '(empty)') +
          '"' +
          (usage && usage.totalTokenCount ? ' · ' + usage.totalTokenCount + ' tok' : ''),
        remediation: null,
        curl: curl,
        raw: sanitizePayloadForInspector(res.data),
        probedAt: new Date().toISOString()
      };
    });
  }

  function probeStream(ctx) {
    const bare = pickBare(ctx.catalog, 'text', 'gemini-2.5-flash');
    const url = REST_BASE + '/v1beta/models/' + encodeURIComponent(bare) + ':streamGenerateContent?alt=sse';
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'Reply with: STREAM OK' }] }],
      generationConfig: buildSafeTextGenConfig(bare, 64)
    };
    const curl = buildCurl({
      method: 'POST',
      url: url,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': '$GEMINI_API_KEY' },
      body: body
    });

    let attempt = 0;

    function runStreamAttempt() {
      const ctrl = createCombinedController(20000, ctx.signal);
      const startedAt = performance.now();

      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal
      })
        .then(function (resp) {
          const headerMs = Math.max(1, Math.round(performance.now() - startedAt));
          if (!resp.ok) {
            return resp.text().then(function (text) {
              ctrl.cleanup();
              let parsed = null;
              try { parsed = text ? JSON.parse(text) : {}; } catch (_e) { parsed = { _rawText: text.slice(0, 1200) }; }
              if (resp.status === 429 && attempt < 1 && !isHardQuotaExhausted(parsed)) {
                attempt += 1;
                const serverDelay = parseRetryDelayMs(resp, parsed);
                const waitMs = Math.min(serverDelay || 3000, 15000) + Math.round(Math.random() * 500);
                if (typeof ctx.onStatusNote === 'function') {
                  ctx.onStatusNote('429 backoff (retrying in ' + (waitMs / 1000).toFixed(1) + 's)…');
                }
                return sleepAbortable(waitMs, ctx.signal).then(runStreamAttempt);
              }
              return makeHttpErrorResult('stream', bare, curl, {
                httpStatus: resp.status,
                latencyMs: headerMs,
                data: parsed,
                rawText: text
              });
            });
          }

          if (!resp.body || typeof resp.body.getReader !== 'function') {
            return resp.text().then(function (text) {
              ctrl.cleanup();
              const totalMs = Math.max(1, Math.round(performance.now() - startedAt));
              if (!/^data:/m.test(String(text || ''))) {
                return makeInvalidJsonResult('stream', bare, curl, {
                  httpStatus: resp.status,
                  latencyMs: totalMs,
                  data: { _rawText: String(text || '').slice(0, 1200) },
                  rawText: String(text || '')
                });
              }
              return {
                id: 'stream',
                status: 'pass',
                badge: 'SSE OK',
                httpStatus: resp.status,
                latencyMs: totalMs,
                modelUsed: bare,
                discoveredModels: matchingNames(ctx.catalog, 'text').slice(0, 8),
                summary: 'SSE response received (' + text.length + ' bytes, non-streaming body fallback).',
                remediation: null,
                curl: curl,
                raw: { ttfbMs: headerMs, totalMs: totalMs, preview: text.slice(0, 600) },
                probedAt: new Date().toISOString()
              };
            });
          }

          const reader = resp.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';
          let rawSample = '';
          let chunkCount = 0;
          let firstDataMs = null;
          let visibleText = '';
          let readerCancelled = false;
          const parsedEvents = [];

          function cancelReader() {
            if (readerCancelled) return;
            readerCancelled = true;
            try {
              if (reader && typeof reader.cancel === 'function') {
                Promise.resolve(reader.cancel()).catch(function () {});
              }
            } catch (_e) {}
          }

          let rejectAbort = null;
          const abortPromise = new Promise(function (_resolve, reject) {
            rejectAbort = reject;
          });
          abortPromise.catch(function () {});

          function onStreamAbort() {
            cancelReader();
            const abortErr = new Error('SSE stream aborted');
            abortErr.name = 'AbortError';
            if (rejectAbort) rejectAbort(abortErr);
          }

          if (ctrl.signal.aborted) {
            onStreamAbort();
          } else {
            ctrl.signal.addEventListener('abort', onStreamAbort, { once: true });
          }

          function processBuffer(flush) {
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = flush ? '' : blocks.pop();
            blocks.forEach(function (block) {
              const lines = block.split(/\r?\n/);
              const dataLines = [];
              lines.forEach(function (line) {
                if (line.startsWith('data:')) {
                  dataLines.push(line.slice(5).trim());
                }
              });
              if (!dataLines.length) return;
              const joined = dataLines.join('\n');
              if (!joined || joined === '[DONE]') return;
              chunkCount += 1;
              if (firstDataMs === null) {
                firstDataMs = Math.max(1, Math.round(performance.now() - startedAt));
              }
              try {
                const obj = JSON.parse(joined);
                if (parsedEvents.length < 5) parsedEvents.push(obj);
                const cand = obj && Array.isArray(obj.candidates) ? obj.candidates[0] : null;
                const txt = extractVisibleTextRaw(cand);
                if (txt) visibleText += txt;
              } catch (_err) {
                // Ignore partial non-JSON lines
              }
            });
          }

          function pump() {
            return reader.read().then(function (step) {
              if (step.done) {
                const tail = decoder.decode();
                if (tail && rawSample.length < 600) rawSample += tail.slice(0, 600 - rawSample.length);
                buffer += tail;
                processBuffer(true);
                ctrl.signal.removeEventListener('abort', onStreamAbort);
                ctrl.cleanup();
                const totalMs = Math.max(1, Math.round(performance.now() - startedAt));
                if (chunkCount === 0 && /<\s*html|<!doctype/i.test(rawSample)) {
                  return makeInvalidJsonResult('stream', bare, curl, {
                    httpStatus: resp.status,
                    latencyMs: totalMs,
                    data: { _rawText: rawSample },
                    rawText: rawSample
                  });
                }
                return {
                  id: 'stream',
                  status: chunkCount > 0 ? 'pass' : 'warn',
                  badge: chunkCount > 0 ? 'TTFT ' + (firstDataMs || headerMs) + 'ms' : '0 CHUNKS',
                  httpStatus: resp.status,
                  latencyMs: totalMs,
                  modelUsed: bare,
                  discoveredModels: matchingNames(ctx.catalog, 'text').slice(0, 8),
                  summary:
                    chunkCount +
                    ' SSE chunk' +
                    (chunkCount === 1 ? '' : 's') +
                    ' · TTFT ' +
                    (firstDataMs || headerMs) +
                    'ms · "' +
                    (visibleText.trim() || '(no visible text)') +
                    '"',
                  remediation: chunkCount === 0 ? 'Stream returned HTTP 200 without SSE data frames.' : null,
                  curl: curl,
                  raw: sanitizePayloadForInspector({
                    headersMs: headerMs,
                    firstDataMs: firstDataMs,
                    totalMs: totalMs,
                    chunkCount: chunkCount,
                    visibleText: visibleText.trim(),
                    sampleEvents: parsedEvents
                  }),
                  probedAt: new Date().toISOString()
                };
              }
              const chunkStr = decoder.decode(step.value, { stream: true });
              if (chunkStr && rawSample.length < 600) rawSample += chunkStr.slice(0, 600 - rawSample.length);
              buffer += chunkStr;
              processBuffer(false);
              return pump();
            });
          }

          return Promise.race([pump(), abortPromise]).catch(function (err) {
            ctrl.signal.removeEventListener('abort', onStreamAbort);
            cancelReader();
            throw err;
          });
        })
        .catch(function (err) {
          ctrl.cleanup();
          if (err && err.aborted) throw err;
          if (err && err.name === 'AbortError') {
            if (ctrl.didTimeout()) {
              return makeNetworkResult('stream', bare, curl, {
                timedOut: true,
                latencyMs: 20000,
                networkError: 'SSE stream timed out after 20s.'
              });
            }
            throw { aborted: true };
          }
          return makeNetworkResult('stream', bare, curl, {
            latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
            networkError: err && err.message ? err.message : 'SSE request failed.'
          });
        });
    }

    return runStreamAttempt();
  }

  function probeInteractions(ctx) {
    const bare = pickBare(ctx.catalog, 'interactions', 'gemini-2.5-flash');
    const url = REST_BASE + '/v1beta/interactions';
    const body = {
      model: bare,
      input: 'Reply with OK only.',
      generation_config: {
        max_output_tokens: 128
      }
    };
    const curl = buildCurl({
      method: 'POST',
      url: url,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': '$GEMINI_API_KEY' },
      body: body
    });

    return fetchJsonWithRetry({
      url: url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey },
      body: body,
      timeoutMs: 20000,
      signal: ctx.signal,
      allowRetry429: true,
      onStatusNote: ctx.onStatusNote
    }).then(function (res) {
      if (res.networkError || res.timedOut) return makeNetworkResult('interactions', bare, curl, res);
      if (!res.ok) return makeHttpErrorResult('interactions', bare, curl, res);
      if (isNonJsonResponse(res)) return makeInvalidJsonResult('interactions', bare, curl, res);
      const outputs = Array.isArray(res.data && res.data.outputs) ? res.data.outputs : [];
      const textOut = outputs
        .filter(function (o) { return o && o.type === 'text' && typeof o.text === 'string'; })
        .map(function (o) { return o.text; })
        .join(' ')
        .trim();
      const interactionId = res.data && res.data.id ? String(res.data.id) : null;
      return {
        id: 'interactions',
        status: 'pass',
        badge: res.data && res.data.status ? String(res.data.status).toUpperCase() : 'HTTP 200',
        httpStatus: res.httpStatus,
        latencyMs: res.latencyMs,
        modelUsed: bare,
        discoveredModels: matchingNames(ctx.catalog, 'interactions').slice(0, 8),
        summary:
          (textOut ? 'Reply: "' + textOut.slice(0, 60) + '"' : outputs.length + ' output block(s)') +
          (interactionId ? ' · id ' + interactionId.slice(0, 14) + '…' : ''),
        remediation: null,
        curl: curl,
        raw: sanitizePayloadForInspector(res.data),
        probedAt: new Date().toISOString()
      };
    });
  }

  function probeDecisions(ctx) {
    const bare = pickBare(ctx.catalog, 'decisions', 'gemini-decision-1');
    const url = REST_BASE + '/v1beta/decisions';
    const body = {
      model: bare,
      input: 'Service health check returned HTTP 200 OK in 42ms.',
      questions: {
        is_healthy: {
          type: 'noul',
          instructions: 'Does this status message indicate a healthy service?'
        }
      }
    };
    const curl = buildCurl({
      method: 'POST',
      url: url,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': '$GEMINI_API_KEY' },
      body: body
    });

    return fetchJsonWithRetry({
      url: url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey },
      body: body,
      timeoutMs: 20000,
      signal: ctx.signal,
      allowRetry429: true,
      onStatusNote: ctx.onStatusNote
    }).then(function (res) {
      if (res.networkError || res.timedOut) return makeNetworkResult('decisions', bare, curl, res);
      if (!res.ok) return makeHttpErrorResult('decisions', bare, curl, res);
      if (isNonJsonResponse(res)) return makeInvalidJsonResult('decisions', bare, curl, res);
      const ans = res.data && res.data.answers ? res.data.answers.is_healthy : null;
      const rawNoul = ans ? ans.noul : null;
      const p =
        rawNoul !== null &&
        rawNoul !== undefined &&
        rawNoul !== '' &&
        typeof rawNoul !== 'boolean' &&
        Number.isFinite(Number(rawNoul))
          ? Number(rawNoul)
          : null;
      const outTok = res.data && res.data.usage ? res.data.usage.total_output_tokens : 0;
      return {
        id: 'decisions',
        status: 'pass',
        badge: p !== null ? 'p=' + p.toFixed(2) : 'HTTP 200',
        httpStatus: res.httpStatus,
        latencyMs: res.latencyMs,
        modelUsed: bare,
        discoveredModels: matchingNames(ctx.catalog, 'decisions'),
        summary:
          'is_healthy noul = ' +
          (p !== null ? p.toFixed(2) : 'n/a') +
          ' · ' +
          (outTok || 0) +
          ' output tokens',
        remediation: null,
        curl: curl,
        raw: sanitizePayloadForInspector(res.data),
        probedAt: new Date().toISOString()
      };
    });
  }

  function probeGrounding(ctx) {
    const bare = pickBare(ctx.catalog, 'text', 'gemini-2.5-flash');
    const url = REST_BASE + '/v1beta/models/' + encodeURIComponent(bare) + ':generateContent';
    const body = {
      contents: [{ role: 'user', parts: [{ text: "What is today's UTC date? Reply YYYY-MM-DD only." }] }],
      tools: [{ google_search: {} }],
      generationConfig: buildSafeTextGenConfig(bare, 128)
    };
    const curl = buildCurl({
      method: 'POST',
      url: url,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': '$GEMINI_API_KEY' },
      body: body
    });

    return fetchJsonWithRetry({
      url: url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey },
      body: body,
      timeoutMs: 25000,
      signal: ctx.signal,
      allowRetry429: true,
      onStatusNote: ctx.onStatusNote
    }).then(function (res) {
      if (res.networkError || res.timedOut) return makeNetworkResult('grounding', bare, curl, res);
      if (!res.ok) return makeHttpErrorResult('grounding', bare, curl, res);
      if (isNonJsonResponse(res)) return makeInvalidJsonResult('grounding', bare, curl, res);
      const cand = res.data && Array.isArray(res.data.candidates) ? res.data.candidates[0] : null;
      const visible = extractVisibleText(cand);
      const meta = cand && cand.groundingMetadata ? cand.groundingMetadata : null;
      const queries = meta && Array.isArray(meta.webSearchQueries) ? meta.webSearchQueries : [];
      const chunks = meta && Array.isArray(meta.groundingChunks) ? meta.groundingChunks : [];
      return {
        id: 'grounding',
        status: 'pass',
        badge: queries.length > 0 ? queries.length + ' SEARCH' : 'TOOL OK',
        httpStatus: res.httpStatus,
        latencyMs: res.latencyMs,
        modelUsed: bare,
        discoveredModels: matchingNames(ctx.catalog, 'text').slice(0, 6),
        summary:
          (visible ? '"' + visible.slice(0, 40) + '"' : 'Response OK') +
          ' · ' +
          queries.length +
          ' search quer' +
          (queries.length === 1 ? 'y' : 'ies') +
          ' · ' +
          chunks.length +
          ' source' +
          (chunks.length === 1 ? '' : 's'),
        remediation: null,
        curl: curl,
        raw: sanitizePayloadForInspector(res.data),
        probedAt: new Date().toISOString()
      };
    });
  }

  function probeLiveWebSocket(ctx) {
    const bare = pickBare(ctx.catalog, 'live', 'gemini-2.5-flash-native-audio-preview-12-2025');
    const setupFrame = {
      setup: {
        model: withModelsPrefix(bare),
        generationConfig: {
          responseModalities: ['AUDIO']
        }
      }
    };
    const curlNote =
      '# Browser WebSocket handshake (wscat / websocat test; key redacted)\n' +
      'websocat "' +
      WS_LIVE_BASE +
      '?key=$GEMINI_API_KEY"\n' +
      '# First client JSON frame:\n' +
      JSON.stringify(setupFrame, null, 2);

    if (typeof WebSocket !== 'function') {
      return Promise.resolve({
        id: 'live_ws',
        status: 'fail',
        badge: 'NO WS API',
        httpStatus: 0,
        latencyMs: 0,
        modelUsed: bare,
        discoveredModels: matchingNames(ctx.catalog, 'live'),
        summary: 'WebSocket API is unavailable in this environment.',
        remediation: 'Run this probe in a modern desktop or mobile browser.',
        curl: curlNote,
        raw: { error: 'WebSocket unavailable' },
        probedAt: new Date().toISOString()
      });
    }

    return new Promise(function (resolve, reject) {
      let settled = false;
      let ws = null;
      const startedAt = performance.now();

      function cleanup() {
        clearTimeout(timer);
        if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
        if (ws) {
          ws.onopen = null;
          ws.onmessage = null;
          ws.onerror = null;
          ws.onclose = null;
        }
      }

      function finish(result) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      }

      function onAbort() {
        if (settled) return;
        settled = true;
        cleanup();
        try { if (ws && ws.readyState < 2) ws.close(1000, 'Aborted'); } catch (_e) {}
        reject({ aborted: true });
      }

      if (ctx.signal && ctx.signal.aborted) {
        reject({ aborted: true });
        return;
      }
      if (ctx.signal) ctx.signal.addEventListener('abort', onAbort, { once: true });

      const timer = setTimeout(function () {
        const sock = ws;
        finish({
          id: 'live_ws',
          status: 'fail',
          badge: 'TIMEOUT',
          httpStatus: 0,
          latencyMs: 10000,
          modelUsed: bare,
          discoveredModels: matchingNames(ctx.catalog, 'live'),
          summary: 'WebSocket Live API handshake timed out after 10s.',
          remediation: 'Check firewall/proxy WebSocket support or verify a bidiGenerateContent model is enabled.',
          curl: curlNote,
          raw: { error: 'Handshake timeout after 10000ms', model: withModelsPrefix(bare) },
          probedAt: new Date().toISOString()
        });
        try { if (sock && sock.readyState < 2) sock.close(1000, 'Timeout'); } catch (_e) {}
      }, 10000);

      try {
        // Browser WebSocket cannot pass custom HTTP headers; key is never serialized into logs/DOM.
        ws = new WebSocket(WS_LIVE_BASE + '?key=' + encodeURIComponent(ctx.apiKey));
        ws.binaryType = 'arraybuffer';
      } catch (err) {
        finish({
          id: 'live_ws',
          status: 'fail',
          badge: 'WS INIT ERR',
          httpStatus: 0,
          latencyMs: 1,
          modelUsed: bare,
          discoveredModels: matchingNames(ctx.catalog, 'live'),
          summary: 'WebSocket constructor failed: ' + redactSecrets(err && err.message ? err.message : String(err), ctx.apiKey),
          remediation: 'Inspect browser console or Content-Security-Policy connect-src rules.',
          curl: curlNote,
          raw: { error: redactSecrets(String(err), ctx.apiKey) },
          probedAt: new Date().toISOString()
        });
        return;
      }

      let gotOpen = false;

      ws.onopen = function () {
        gotOpen = true;
        const sock = ws;
        try {
          sock.send(JSON.stringify(setupFrame));
        } catch (err) {
          finish({
            id: 'live_ws',
            status: 'fail',
            badge: 'WS SEND ERR',
            httpStatus: 0,
            latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
            modelUsed: bare,
            discoveredModels: matchingNames(ctx.catalog, 'live'),
            summary: 'Failed to send BidiGenerateContentSetup frame.',
            remediation: 'Retry the probe.',
            curl: curlNote,
            raw: { error: redactSecrets(String(err), ctx.apiKey) },
            probedAt: new Date().toISOString()
          });
          try { if (sock) sock.close(); } catch (_e) {}
        }
      };

      ws.onmessage = function (evt) {
        const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
        function handleText(text) {
          let msg = null;
          try {
            msg = JSON.parse(text);
          } catch (_e) {
            msg = { _raw: String(text || '').slice(0, 500) };
          }
          const sock = ws;
          if (!msg || typeof msg !== 'object' || Array.isArray(msg) || Object.prototype.hasOwnProperty.call(msg, '_raw')) {
            finish({
              id: 'live_ws',
              status: 'fail',
              badge: 'WS BAD FRAME',
              httpStatus: 0,
              latencyMs: latencyMs,
              modelUsed: bare,
              discoveredModels: matchingNames(ctx.catalog, 'live'),
              summary: 'Live WebSocket returned non-JSON or malformed frame.',
              remediation: 'Check WebSocket proxy or inspect Raw Response.',
              curl: curlNote,
              raw: sanitizePayloadForInspector({ handshakeMs: latencyMs, firstServerFrame: msg }),
              probedAt: new Date().toISOString()
            });
            try { if (sock) sock.close(1000, 'Malformed frame'); } catch (_e) {}
            return;
          }
          if (msg.error) {
            const errObj = typeof msg.error === 'object' && msg.error !== null ? msg.error : { message: String(msg.error) };
            const errCode = typeof errObj.code === 'number' ? errObj.code : 0;
            const errMsg = redactSecrets(String(errObj.message || errObj.status || 'WebSocket server error frame'), ctx.apiKey);
            const badKey = isInvalidKeyError(errMsg, msg);
            finish({
              id: 'live_ws',
              status: 'fail',
              badge: badKey ? 'INVALID KEY' : errCode ? 'WS ERR ' + errCode : 'WS ERROR',
              httpStatus: errCode || 0,
              latencyMs: latencyMs,
              modelUsed: bare,
              discoveredModels: matchingNames(ctx.catalog, 'live'),
              summary: 'Live WebSocket error' + (errCode ? ' (' + errCode + ')' : '') + ': ' + errMsg.slice(0, 110),
              remediation: badKey
                ? 'Check your Google AI Studio Gemini API key and save it again.'
                : 'Inspect Raw Response for Live API setup or permission error details.',
              curl: curlNote,
              raw: sanitizePayloadForInspector({
                handshakeMs: latencyMs,
                model: withModelsPrefix(bare),
                firstServerFrame: msg
              }),
              probedAt: new Date().toISOString()
            });
            try { if (sock) sock.close(1000, 'Server error'); } catch (_e) {}
            return;
          }
          if (Object.prototype.hasOwnProperty.call(msg, 'setupComplete')) {
            finish({
              id: 'live_ws',
              status: 'pass',
              badge: 'WS READY',
              httpStatus: 101,
              latencyMs: latencyMs,
              modelUsed: bare,
              discoveredModels: matchingNames(ctx.catalog, 'live'),
              summary: 'setupComplete received in ' + latencyMs + 'ms (AUDIO modality ready, closed 1000).',
              remediation: null,
              curl: curlNote,
              raw: sanitizePayloadForInspector({
                handshakeMs: latencyMs,
                model: withModelsPrefix(bare),
                firstServerFrame: msg
              }),
              probedAt: new Date().toISOString()
            });
            try { if (sock && sock.readyState < 2) sock.close(1000, 'Probe complete'); } catch (_e) {}
          } else {
            finish({
              id: 'live_ws',
              status: 'pass',
              badge: 'WS FRAME',
              httpStatus: 101,
              latencyMs: latencyMs,
              modelUsed: bare,
              discoveredModels: matchingNames(ctx.catalog, 'live'),
              summary: 'Live WebSocket connected and replied in ' + latencyMs + 'ms.',
              remediation: null,
              curl: curlNote,
              raw: sanitizePayloadForInspector({ handshakeMs: latencyMs, firstServerFrame: msg }),
              probedAt: new Date().toISOString()
            });
            try { if (sock && sock.readyState < 2) sock.close(1000, 'Probe complete'); } catch (_e) {}
          }
        }

        if (evt.data instanceof ArrayBuffer) {
          handleText(new TextDecoder('utf-8').decode(evt.data));
        } else if (typeof Blob === 'function' && evt.data instanceof Blob) {
          evt.data.text().then(handleText).catch(function (err) {
            const sock = ws;
            finish({
              id: 'live_ws',
              status: 'fail',
              badge: 'WS READ ERR',
              httpStatus: 0,
              latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
              modelUsed: bare,
              discoveredModels: matchingNames(ctx.catalog, 'live'),
              summary: 'Failed to decode binary WebSocket frame.',
              remediation: 'Retry the probe.',
              curl: curlNote,
              raw: { error: redactSecrets(String(err), ctx.apiKey) },
              probedAt: new Date().toISOString()
            });
            try { if (sock) sock.close(); } catch (_e) {}
          });
        } else {
          handleText(String(evt.data || ''));
        }
      };

      ws.onerror = function () {
        // Wait briefly for onclose to carry the exact close code/reason.
      };

      ws.onclose = function (evt) {
        const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
        const code = evt ? evt.code : 1006;
        const reason = redactSecrets(evt && evt.reason ? evt.reason : '', ctx.apiKey);
        let badge = 'WS ' + code;
        let status = 'fail';
        let remediation = 'Verify a bidiGenerateContent-capable model is available on this key.';
        if (INVALID_KEY_RE.test(reason)) {
          badge = 'INVALID KEY';
          status = 'fail';
          remediation = 'Check your Google AI Studio Gemini API key and save it again.';
        } else if (code === 1006 && !gotOpen) {
          badge = 'AUTH / 1006';
          remediation = 'WebSocket upgrade failed — check API key validity or network/proxy WebSocket access.';
        } else if (code === 1007) {
          badge = 'SETUP 1007';
          status = 'warn';
          remediation = 'Server rejected setup frame or modality for ' + bare + '.';
        } else if (code === 1008) {
          badge = 'POLICY 1008';
          status = 'warn';
          remediation = 'Model ' + bare + ' is unsupported, not found, or restricted on this key.';
        }
        finish({
          id: 'live_ws',
          status: status,
          badge: badge,
          httpStatus: code,
          latencyMs: latencyMs,
          modelUsed: bare,
          discoveredModels: matchingNames(ctx.catalog, 'live'),
          summary: 'WebSocket closed (' + code + ')' + (reason ? ': ' + reason.slice(0, 110) : '.'),
          remediation: remediation,
          curl: curlNote,
          raw: { closeCode: code, reason: reason, model: withModelsPrefix(bare), opened: gotOpen },
          probedAt: new Date().toISOString()
        });
      };
    });
  }

  function probeTts(ctx) {
    const bare = pickBare(ctx.catalog, 'tts', 'gemini-2.5-flash-preview-tts');
    const url = REST_BASE + '/v1beta/models/' + encodeURIComponent(bare) + ':generateContent';
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'Say: OK.' }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: 'Kore'
            }
          }
        }
      }
    };
    let curl = buildCurl({
      method: 'POST',
      url: url,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': '$GEMINI_API_KEY' },
      body: body
    });

    function runTtsRequest(reqBody) {
      return fetchJsonWithRetry({
        url: url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey },
        body: reqBody,
        timeoutMs: 25000,
        signal: ctx.signal,
        allowRetry429: true,
        onStatusNote: ctx.onStatusNote
      });
    }

    return runTtsRequest(body).then(function (res) {
      // Fallback once if newer 3.x TTS rejects prebuiltVoiceConfig syntax.
      if (!res.ok && res.httpStatus === 400 && /prebuiltVoiceConfig/i.test(res.rawText || '')) {
        const altBody = {
          contents: body.contents,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { voice: 'Kore' } }
          }
        };
        curl = buildCurl({
          method: 'POST',
          url: url,
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': '$GEMINI_API_KEY' },
          body: altBody
        });
        return runTtsRequest(altBody);
      }
      return res;
    }).then(function (res) {
      if (res.networkError || res.timedOut) return makeNetworkResult('tts', bare, curl, res);
      if (!res.ok) return makeHttpErrorResult('tts', bare, curl, res);
      if (isNonJsonResponse(res)) return makeInvalidJsonResult('tts', bare, curl, res);

      const cand = res.data && Array.isArray(res.data.candidates) ? res.data.candidates[0] : null;
      const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
      const audioPart = parts.find(function (p) {
        return p && p.inlineData && typeof p.inlineData.mimeType === 'string' && p.inlineData.mimeType.indexOf('audio/') === 0;
      });

      if (!audioPart || !audioPart.inlineData.data) {
        return {
          id: 'tts',
          status: 'warn',
          badge: 'NO AUDIO',
          httpStatus: res.httpStatus,
          latencyMs: res.latencyMs,
          modelUsed: bare,
          discoveredModels: matchingNames(ctx.catalog, 'tts'),
          summary: 'HTTP 200 returned without an audio inlineData part.',
          remediation: 'Inspect Raw Response; confirm a dedicated *-tts model is selected.',
          curl: curl,
          raw: sanitizePayloadForInspector(res.data),
          probedAt: new Date().toISOString()
        };
      }

      const playable = NS.Audio.audioBytesToPlayableBlob(audioPart.inlineData.data, audioPart.inlineData.mimeType);
      return {
        id: 'tts',
        status: 'pass',
        badge: 'AUDIO OK',
        httpStatus: res.httpStatus,
        latencyMs: res.latencyMs,
        modelUsed: bare,
        discoveredModels: matchingNames(ctx.catalog, 'tts'),
        audioMedia: {
          blob: playable.blob,
          mimeType: playable.mimeType,
          sourceMimeType: audioPart.inlineData.mimeType,
          bytes: playable.bytes,
          durationSec: playable.durationSec || null
        },
        summary:
          'Synthesized ' +
          formatByteCount(playable.bytes) +
          ' ' +
          playable.mimeType +
          (playable.durationSec ? ' (' + playable.durationSec + 's)' : '') +
          ' · playable in Inspector',
        remediation: null,
        curl: curl,
        raw: sanitizePayloadForInspector(res.data),
        probedAt: new Date().toISOString()
      };
    });
  }

  function probeAudioInput(ctx) {
    const bare = pickBare(ctx.catalog, 'text', 'gemini-2.5-flash');
    const tone = NS.Audio.generateTestToneWavBase64();
    const url = REST_BASE + '/v1beta/models/' + encodeURIComponent(bare) + ':generateContent';
    const body = {
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Identify this short sound in 3 words.' },
            { inlineData: { mimeType: tone.mimeType, data: tone.base64 } }
          ]
        }
      ],
      generationConfig: buildSafeTextGenConfig(bare, 64)
    };
    const curl = buildCurl({
      method: 'POST',
      url: url,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': '$GEMINI_API_KEY' },
      body: body
    });

    const transcribeList = matchingNames(ctx.catalog, 'transcribe');

    return fetchJsonWithRetry({
      url: url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey },
      body: body,
      timeoutMs: 25000,
      signal: ctx.signal,
      allowRetry429: true,
      onStatusNote: ctx.onStatusNote
    }).then(function (res) {
      if (res.networkError || res.timedOut) return makeNetworkResult('audio_in', bare, curl, res);
      if (!res.ok) return makeHttpErrorResult('audio_in', bare, curl, res);
      if (isNonJsonResponse(res)) return makeInvalidJsonResult('audio_in', bare, curl, res);
      const cand = res.data && Array.isArray(res.data.candidates) ? res.data.candidates[0] : null;
      const visible = extractVisibleText(cand);
      const transcribeNote = transcribeList.length
        ? ' · ' + transcribeList.length + ' transcribe model(s)'
        : ' · native multimodal audio STT';
      return {
        id: 'audio_in',
        status: 'pass',
        badge: 'WAV OK',
        httpStatus: res.httpStatus,
        latencyMs: res.latencyMs,
        modelUsed: bare,
        discoveredModels: transcribeList.concat(matchingNames(ctx.catalog, 'text').slice(0, 4)),
        summary: '440Hz WAV → "' + (visible || '(accepted)') + '"' + transcribeNote,
        remediation: null,
        curl: curl,
        raw: sanitizePayloadForInspector({
          probeAudio: { mimeType: tone.mimeType, durationSec: tone.durationSec, frequencyHz: tone.frequencyHz, bytes: tone.bytes },
          dedicatedTranscribeModels: transcribeList,
          response: res.data
        }),
        probedAt: new Date().toISOString()
      };
    });
  }

  function probeCatalogMetadataModel(ctx, cfg) {
    const matches = matchingNames(ctx.catalog, cfg.bucket);
    const bare = matches[0] || '';
    if (!bare) {
      const curl = buildCurl({
        method: 'GET',
        url: REST_BASE + '/v1beta/models?pageSize=1000',
        headers: { 'x-goog-api-key': '$GEMINI_API_KEY' }
      });
      return Promise.resolve({
        id: cfg.id,
        status: 'warn',
        badge: 'NOT LISTED',
        httpStatus: ctx.catalog && ctx.catalog.loadedAt ? 200 : null,
        latencyMs: 1,
        modelUsed: null,
        discoveredModels: [],
        summary: cfg.notListedSummary,
        remediation: cfg.notListedRemediation,
        curl: curl,
        raw: { catalogChecked: Boolean(ctx.catalog && ctx.catalog.loadedAt), matchingModels: [] },
        probedAt: new Date().toISOString()
      });
    }

    const url = REST_BASE + '/v1beta/' + withModelsPrefix(bare);
    const curl = buildCurl({
      method: 'GET',
      url: url,
      headers: { 'x-goog-api-key': '$GEMINI_API_KEY' }
    });

    return fetchJsonWithRetry({
      url: url,
      method: 'GET',
      headers: { 'x-goog-api-key': ctx.apiKey },
      timeoutMs: 15000,
      signal: ctx.signal,
      allowRetry429: true,
      onStatusNote: ctx.onStatusNote
    }).then(function (res) {
      if (res.networkError || res.timedOut) return makeNetworkResult(cfg.id, bare, curl, res);
      if (!res.ok) return makeHttpErrorResult(cfg.id, bare, curl, res);
      if (isNonJsonResponse(res)) return makeInvalidJsonResult(cfg.id, bare, curl, res);
      const methods = Array.isArray(res.data && res.data.supportedGenerationMethods)
        ? res.data.supportedGenerationMethods
        : [];
      return {
        id: cfg.id,
        status: 'pass',
        badge: cfg.passBadge || 'AVAILABLE',
        httpStatus: res.httpStatus,
        latencyMs: res.latencyMs,
        modelUsed: bare,
        discoveredModels: matches,
        summary:
          matches.length +
          ' model' +
          (matches.length === 1 ? '' : 's') +
          ' (' +
          bare +
          ') · ' +
          (methods.length ? methods.join(', ') : 'metadata verified'),
        remediation: null,
        curl: curl,
        raw: sanitizePayloadForInspector(res.data),
        probedAt: new Date().toISOString()
      };
    });
  }

  function probeLyria(ctx) {
    return probeCatalogMetadataModel(ctx, {
      id: 'lyria',
      bucket: 'lyria',
      passBadge: 'LISTED',
      notListedSummary: 'No lyria-* models listed in /v1beta/models for this API key.',
      notListedRemediation: 'Lyria music generation may require preview/allowlist access or v1alpha BidiGenerateMusic.'
    });
  }

  function probeVeo(ctx) {
    return probeCatalogMetadataModel(ctx, {
      id: 'veo',
      bucket: 'veo',
      passBadge: 'LISTED ($0)',
      notListedSummary: 'No veo-* models listed in /v1beta/models for this API key.',
      notListedRemediation: 'Veo video generation typically requires a billed Google AI Studio tier.'
    });
  }

  function probeImageGen(ctx) {
    if (!ctx.liveGen) {
      return probeCatalogMetadataModel(ctx, {
        id: 'image_gen',
        bucket: 'image',
        passBadge: 'LISTED ($0)',
        notListedSummary: 'No gemini-*-image or imagen-* models listed on this key.',
        notListedRemediation: 'Image generation models may require paid billing or regional availability.'
      });
    }

    const bare = pickBare(ctx.catalog, 'image', 'gemini-2.5-flash-image');
    const isImagen = /^imagen-/i.test(bare);
    const url = isImagen
      ? REST_BASE + '/v1beta/models/' + encodeURIComponent(bare) + ':predict'
      : REST_BASE + '/v1beta/models/' + encodeURIComponent(bare) + ':generateContent';

    const body = isImagen
      ? {
          instances: [{ prompt: 'Minimal Swiss red square on pure white matte paper' }],
          parameters: { sampleCount: 1, aspectRatio: '1:1', outputMimeType: 'image/jpeg' }
        }
      : {
          contents: [{ role: 'user', parts: [{ text: 'Generate a minimal Swiss red square on pure white matte paper.' }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
        };

    const curl = buildCurl({
      method: 'POST',
      url: url,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': '$GEMINI_API_KEY' },
      body: body
    });

    return fetchJsonWithRetry({
      url: url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey },
      body: body,
      timeoutMs: 45000,
      signal: ctx.signal,
      allowRetry429: true,
      onStatusNote: ctx.onStatusNote
    }).then(function (res) {
      if (res.networkError || res.timedOut) return makeNetworkResult('image_gen', bare, curl, res);
      if (!res.ok) return makeHttpErrorResult('image_gen', bare, curl, res);
      if (isNonJsonResponse(res)) return makeInvalidJsonResult('image_gen', bare, curl, res);

      let mimeType = '';
      let b64 = '';
      if (isImagen) {
        const pred = res.data && Array.isArray(res.data.predictions) ? res.data.predictions[0] : null;
        if (pred && pred.bytesBase64Encoded) {
          b64 = pred.bytesBase64Encoded;
          mimeType = pred.mimeType || 'image/jpeg';
        }
      } else {
        const cand = res.data && Array.isArray(res.data.candidates) ? res.data.candidates[0] : null;
        const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
        const imgPart = parts.find(function (p) {
          return p && p.inlineData && p.inlineData.data && ALLOWED_IMAGE_MIMES.indexOf(String(p.inlineData.mimeType || '').toLowerCase()) >= 0;
        });
        if (imgPart) {
          b64 = imgPart.inlineData.data;
          mimeType = imgPart.inlineData.mimeType;
        }
      }

      if (!b64 || ALLOWED_IMAGE_MIMES.indexOf(String(mimeType).toLowerCase()) < 0) {
        return {
          id: 'image_gen',
          status: 'warn',
          badge: 'NO IMAGE',
          httpStatus: res.httpStatus,
          latencyMs: res.latencyMs,
          modelUsed: bare,
          discoveredModels: matchingNames(ctx.catalog, 'image'),
          summary: 'HTTP 200 returned without a safe PNG/JPEG/WebP image payload.',
          remediation: 'Inspect Raw Response for text refusal or safety feedback.',
          curl: curl,
          raw: sanitizePayloadForInspector(res.data),
          probedAt: new Date().toISOString()
        };
      }

      const bytes = NS.Audio.base64ToUint8Array(b64);
      const blob = typeof Blob === 'function' ? new Blob([bytes], { type: mimeType }) : null;
      return {
        id: 'image_gen',
        status: 'pass',
        badge: 'IMAGE OK',
        httpStatus: res.httpStatus,
        latencyMs: res.latencyMs,
        modelUsed: bare,
        discoveredModels: matchingNames(ctx.catalog, 'image'),
        imageMedia: {
          blob: blob,
          mimeType: mimeType,
          bytes: bytes.byteLength
        },
        summary: 'Generated ' + formatByteCount(bytes.byteLength) + ' ' + mimeType + ' via ' + bare,
        remediation: null,
        curl: curl,
        raw: sanitizePayloadForInspector(res.data),
        probedAt: new Date().toISOString()
      };
    });
  }

  function probeEmbeddings(ctx) {
    const bare = pickBare(ctx.catalog, 'embeddings', 'gemini-embedding-001');
    const url = REST_BASE + '/v1beta/models/' + encodeURIComponent(bare) + ':embedContent';
    const body = {
      model: withModelsPrefix(bare),
      content: { parts: [{ text: 'Gemini API connectivity probe.' }] }
    };
    const curl = buildCurl({
      method: 'POST',
      url: url,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': '$GEMINI_API_KEY' },
      body: body
    });

    return fetchJsonWithRetry({
      url: url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey },
      body: body,
      timeoutMs: 15000,
      signal: ctx.signal,
      allowRetry429: true,
      onStatusNote: ctx.onStatusNote
    }).then(function (res) {
      if (res.networkError || res.timedOut) return makeNetworkResult('embeddings', bare, curl, res);
      if (!res.ok) return makeHttpErrorResult('embeddings', bare, curl, res);
      if (isNonJsonResponse(res)) return makeInvalidJsonResult('embeddings', bare, curl, res);
      const vals = res.data && res.data.embedding && Array.isArray(res.data.embedding.values)
        ? res.data.embedding.values
        : [];
      return {
        id: 'embeddings',
        status: vals.length > 0 ? 'pass' : 'warn',
        badge: vals.length > 0 ? vals.length + '-D' : 'EMPTY VEC',
        httpStatus: res.httpStatus,
        latencyMs: res.latencyMs,
        modelUsed: bare,
        discoveredModels: matchingNames(ctx.catalog, 'embeddings'),
        summary: vals.length > 0 ? vals.length + '-dimensional embedding vector returned.' : 'HTTP 200 with empty embedding vector.',
        remediation: vals.length > 0 ? null : 'Inspect Raw Response.',
        curl: curl,
        raw: sanitizePayloadForInspector(res.data),
        probedAt: new Date().toISOString()
      };
    });
  }

  function probeCountTokens(ctx) {
    const bare = pickBare(ctx.catalog, 'text', 'gemini-2.5-flash');
    const url = REST_BASE + '/v1beta/models/' + encodeURIComponent(bare) + ':countTokens';
    const body = {
      contents: [{ role: 'user', parts: [{ text: 'Hello Gemini API tokenizer probe.' }] }]
    };
    const curl = buildCurl({
      method: 'POST',
      url: url,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': '$GEMINI_API_KEY' },
      body: body
    });

    return fetchJsonWithRetry({
      url: url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ctx.apiKey },
      body: body,
      timeoutMs: 15000,
      signal: ctx.signal,
      allowRetry429: true,
      onStatusNote: ctx.onStatusNote
    }).then(function (res) {
      if (res.networkError || res.timedOut) return makeNetworkResult('count_tokens', bare, curl, res);
      if (!res.ok) return makeHttpErrorResult('count_tokens', bare, curl, res);
      if (isNonJsonResponse(res)) return makeInvalidJsonResult('count_tokens', bare, curl, res);
      const total = res.data && typeof res.data.totalTokens === 'number' ? res.data.totalTokens : null;
      return {
        id: 'count_tokens',
        status: total !== null ? 'pass' : 'warn',
        badge: total !== null ? total + ' TOK' : 'HTTP 200',
        httpStatus: res.httpStatus,
        latencyMs: res.latencyMs,
        modelUsed: bare,
        discoveredModels: matchingNames(ctx.catalog, 'text').slice(0, 6),
        summary: total !== null ? 'Exact token count: ' + total + ' tokens ($0).' : 'HTTP 200 without totalTokens field.',
        remediation: null,
        curl: curl,
        raw: sanitizePayloadForInspector(res.data),
        probedAt: new Date().toISOString()
      };
    });
  }

  function probeReadOnlyList(ctx, cfg) {
    const url = REST_BASE + cfg.path;
    const curl = buildCurl({
      method: 'GET',
      url: url,
      headers: { 'x-goog-api-key': '$GEMINI_API_KEY' }
    });

    return fetchJsonWithRetry({
      url: url,
      method: 'GET',
      headers: { 'x-goog-api-key': ctx.apiKey },
      timeoutMs: 15000,
      signal: ctx.signal,
      allowRetry429: true,
      onStatusNote: ctx.onStatusNote
    }).then(function (res) {
      if (res.networkError || res.timedOut) return makeNetworkResult(cfg.id, null, curl, res);
      if (!res.ok) return makeHttpErrorResult(cfg.id, null, curl, res);
      if (isNonJsonResponse(res)) return makeInvalidJsonResult(cfg.id, null, curl, res);
      // Protobuf JSON omits empty arrays ({} means 0 items).
      let items = [];
      for (let i = 0; i < cfg.arrayKeys.length; i++) {
        const arr = res.data && res.data[cfg.arrayKeys[i]];
        if (Array.isArray(arr)) {
          items = arr;
          break;
        }
      }
      return {
        id: cfg.id,
        status: 'pass',
        badge: items.length + ' ' + cfg.unitShort,
        httpStatus: res.httpStatus,
        latencyMs: res.latencyMs,
        modelUsed: null,
        discoveredModels: [],
        summary: 'Endpoint reachable · ' + items.length + ' ' + cfg.unitLong + ' listed (read-only).',
        remediation: null,
        curl: curl,
        raw: sanitizePayloadForInspector(res.data),
        probedAt: new Date().toISOString()
      };
    });
  }

  function probeFiles(ctx) {
    return probeReadOnlyList(ctx, {
      id: 'files',
      path: '/v1beta/files?pageSize=5',
      arrayKeys: ['files'],
      unitShort: 'FILES',
      unitLong: 'file(s)'
    });
  }

  function probeCaching(ctx) {
    return probeReadOnlyList(ctx, {
      id: 'caching',
      path: '/v1beta/cachedContents?pageSize=5',
      arrayKeys: ['cachedContents'],
      unitShort: 'CACHED',
      unitLong: 'cached context(s)'
    });
  }

  function probeBatches(ctx) {
    return probeReadOnlyList(ctx, {
      id: 'batches',
      path: '/v1beta/batches?pageSize=5',
      arrayKeys: ['operations', 'batches'],
      unitShort: 'JOBS',
      unitLong: 'batch job(s)'
    });
  }

  function probeOpenAiCompat(ctx) {
    const url = REST_BASE + '/v1beta/openai/models';
    const curl = buildCurl({
      method: 'GET',
      url: url,
      headers: { Authorization: 'Bearer $GEMINI_API_KEY' }
    });

    return fetchJsonWithRetry({
      url: url,
      method: 'GET',
      headers: { Authorization: 'Bearer ' + ctx.apiKey },
      timeoutMs: 15000,
      signal: ctx.signal,
      allowRetry429: true,
      onStatusNote: ctx.onStatusNote
    }).then(function (res) {
      if (res.networkError || res.timedOut) return makeNetworkResult('openai', null, curl, res);
      if (!res.ok) return makeHttpErrorResult('openai', null, curl, res);
      if (isNonJsonResponse(res)) return makeInvalidJsonResult('openai', null, curl, res);
      const list = Array.isArray(res.data && res.data.data) ? res.data.data : [];
      return {
        id: 'openai',
        status: 'pass',
        badge: list.length + ' MODELS',
        httpStatus: res.httpStatus,
        latencyMs: res.latencyMs,
        modelUsed: list[0] && list[0].id ? stripModelsPrefix(list[0].id) : null,
        discoveredModels: list.slice(0, 10).map(function (m) { return stripModelsPrefix(m.id); }),
        summary: 'OpenAI-compatible /v1beta/openai/models returned ' + list.length + ' model(s).',
        remediation: null,
        curl: curl,
        raw: sanitizePayloadForInspector({
          object: res.data && res.data.object,
          count: list.length,
          sample: list.slice(0, 12)
        }),
        probedAt: new Date().toISOString()
      };
    });
  }

  const RUNNERS = {
    models: probeModels,
    generate: probeGenerate,
    stream: probeStream,
    interactions: probeInteractions,
    decisions: probeDecisions,
    grounding: probeGrounding,
    live_ws: probeLiveWebSocket,
    tts: probeTts,
    audio_in: probeAudioInput,
    lyria: probeLyria,
    embeddings: probeEmbeddings,
    count_tokens: probeCountTokens,
    image_gen: probeImageGen,
    veo: probeVeo,
    files: probeFiles,
    caching: probeCaching,
    batches: probeBatches,
    openai: probeOpenAiCompat
  };

  function runSingleProbe(endpointId, ctx) {
    const runner = RUNNERS[endpointId];
    if (!runner) {
      return Promise.reject(new Error('Unknown endpoint probe: ' + endpointId));
    }
    const activeKey = ctx && ctx.apiKey ? ctx.apiKey : '';
    return Promise.resolve()
      .then(function () {
        return runner(ctx);
      })
      .then(function (result) {
        return scrubProbeResult(result, activeKey);
      });
  }

  // =========================================================================
  // STAGED RUN-ALL SCHEDULER (STAGE 0 GATE -> STAGE 1 FREE -> STAGE 2 METERED)
  // =========================================================================

  function runPool(ids, concurrency, staggerMs, workerFn, signal) {
    let cursor = 0;
    let active = 0;
    let lastLaunchAt = 0;

    return new Promise(function (resolve, reject) {
      if (!ids.length) {
        resolve();
        return;
      }

      function next() {
        if (signal && signal.aborted) {
          if (active === 0) reject({ aborted: true });
          return;
        }
        if (cursor >= ids.length && active === 0) {
          resolve();
          return;
        }
        while (active < concurrency && cursor < ids.length) {
          const id = ids[cursor++];
          active += 1;
          const now = Date.now();
          const wait = staggerMs > 0 ? Math.max(0, lastLaunchAt + staggerMs - now) : 0;
          lastLaunchAt = now + wait;

          const startPromise = wait > 0 ? sleepAbortable(wait, signal) : Promise.resolve();
          startPromise
            .then(function () {
              return workerFn(id);
            })
            .then(
              function () {
                active -= 1;
                next();
              },
              function (err) {
                active -= 1;
                if (err && err.aborted) {
                  if (active === 0) reject({ aborted: true });
                } else {
                  next();
                }
              }
            );
        }
      }

      next();
    });
  }

  function runBatch(options) {
    const apiKey = String(options.apiKey || '').trim();
    const signal = options.signal;
    const includeGrounding = options.includeGrounding !== false;
    const onStart = options.onStart || function () {};
    const onStatusNote = options.onStatusNote || function () {};
    const onResult = options.onResult || function () {};

    let catalog = options.catalog || createEmptyCatalog();
    const modelLocks = Object.create(null);

    function runSerializedByModel(id, modelKey, taskFn) {
      if (!modelKey) return taskFn();
      const prev = modelLocks[modelKey] || Promise.resolve();
      const chained = prev.then(
        function () { return taskFn(); },
        function () { return taskFn(); }
      );
      modelLocks[modelKey] = chained.catch(function () {});
      return chained;
    }

    function executeId(id, stage2Serialize) {
      if (signal && signal.aborted) return Promise.reject({ aborted: true });
      let lockKey = null;
      if (stage2Serialize) {
        if (id === 'interactions') {
          lockKey = pickBare(catalog, 'interactions', 'gemini-2.5-flash');
        } else if (id === 'generate' || id === 'stream' || id === 'grounding' || id === 'audio_in') {
          lockKey = pickBare(catalog, 'text', 'gemini-2.5-flash');
        }
      }
      return runSerializedByModel(id, lockKey, function () {
        if (signal && signal.aborted) return Promise.reject({ aborted: true });
        onStart(id);
        return runSingleProbe(id, {
          apiKey: apiKey,
          catalog: catalog,
          signal: signal,
          liveGen: false,
          onStatusNote: function (note) {
            onStatusNote(id, note);
          }
        })
          .then(function (result) {
            if (id === 'models' && result.catalog) {
              catalog = result.catalog;
            }
            onResult(id, result);
            return result;
          })
          .catch(function (err) {
            if (err && err.aborted) throw err;
            const errResult = scrubProbeResult(
              {
                id: id,
                status: 'fail',
                badge: 'ERROR',
                httpStatus: 0,
                latencyMs: 0,
                modelUsed: null,
                discoveredModels: [],
                summary: err && err.message ? err.message : 'Unexpected probe error.',
                remediation: 'Retry this endpoint probe or inspect browser console.',
                curl: '',
                raw: { error: String(err) },
                probedAt: new Date().toISOString()
              },
              apiKey
            );
            onResult(id, errResult);
            return errResult;
          });
      });
    }

    // Stage 0: Blocking gate — verify key & discover models before firing 17 other probes.
    return executeId('models', false).then(function (modelsRes) {
      if (signal && signal.aborted) throw { aborted: true };
      const keyRejected =
        modelsRes.httpStatus === 401 ||
        modelsRes.httpStatus === 403 ||
        modelsRes.badge === 'INVALID KEY';
      const unreachable = modelsRes.badge === 'NETWORK ERR';

      if (keyRejected || unreachable) {
        // haltedOnAuth is kept for existing callers; haltReason tells the UI which message is true.
        return {
          haltedOnAuth: true,
          haltReason: keyRejected ? 'auth' : 'network',
          catalog: catalog,
          modelsResult: modelsRes
        };
      }

      const stage1Ids = ENDPOINTS.filter(function (e) {
        return e.stage === 1 && e.runInBatch;
      }).map(function (e) {
        return e.id;
      });

      const stage2Ids = ENDPOINTS.filter(function (e) {
        if (e.stage !== 2 || !e.runInBatch) return false;
        if (e.id === 'grounding' && !includeGrounding) return false;
        return true;
      }).map(function (e) {
        return e.id;
      });

      return runPool(
        stage1Ids,
        3,
        120,
        function (id) { return executeId(id, false); },
        signal
      ).then(function () {
        return runPool(
          stage2Ids,
          2,
          450,
          function (id) { return executeId(id, true); },
          signal
        );
      }).then(function () {
        return { haltedOnAuth: false, haltReason: null, catalog: catalog, modelsResult: modelsRes };
      });
    });
  }

  function buildExportReport(resultsMap, catalog, activeKey) {
    const items = ENDPOINTS.map(function (ep) {
      const r = resultsMap[ep.id];
      return {
        id: ep.id,
        code: ep.code,
        name: ep.name,
        category: ep.category,
        protocol: ep.protocol,
        costTier: ep.costTier,
        status: r ? r.status : 'idle',
        badge: r ? r.badge : 'IDLE',
        httpStatus: r ? r.httpStatus : null,
        latencyMs: r ? r.latencyMs : null,
        modelUsed: r ? r.modelUsed : null,
        summary: r ? r.summary : 'Not probed yet.',
        remediation: r ? r.remediation : null,
        probedAt: r ? r.probedAt : null
      };
    });

    const summary = {
      generatedAt: new Date().toISOString(),
      discoveredModelsCount: catalog && catalog.models ? catalog.models.length : 0,
      passed: items.filter(function (x) { return x.status === 'pass'; }).length,
      warnings: items.filter(function (x) { return x.status === 'warn'; }).length,
      failed: items.filter(function (x) { return x.status === 'fail'; }).length,
      idle: items.filter(function (x) { return x.status === 'idle'; }).length,
      endpoints: items
    };

    return redactSecrets(JSON.stringify(summary, null, 2), activeKey);
  }

  function escapeMarkdownCell(str) {
    return String(str || '')
      .replace(/\r?\n|\r/g, ' ')
      .replace(/\|/g, '\\|')
      .trim();
  }

  function buildMarkdownSummary(resultsMap, catalog, activeKey) {
    const lines = [
      '# Gemini API Matrix Status Report',
      '',
      '- Generated: `' + new Date().toISOString() + '`',
      '- Discovered models: `' + (catalog && catalog.models ? catalog.models.length : 0) + '`',
      '',
      '| API | Protocol | Status | HTTP/Code | Latency | Model | Summary |',
      '| :--- | :--- | :--- | :--- | :--- | :--- | :--- |'
    ];
    ENDPOINTS.forEach(function (ep) {
      const r = resultsMap[ep.id];
      const st = r ? escapeMarkdownCell(r.status.toUpperCase() + ' (' + r.badge + ')') : 'IDLE';
      const code = r && r.httpStatus ? escapeMarkdownCell(String(r.httpStatus)) : '—';
      const lat = r && r.latencyMs ? r.latencyMs + ' ms' : '—';
      const mod = r && r.modelUsed ? '`' + escapeMarkdownCell(r.modelUsed) + '`' : '—';
      const sum = r ? escapeMarkdownCell(r.summary) : 'Not probed';
      lines.push('| **' + ep.name + '** | `' + ep.protocol + '` | ' + st + ' | `' + code + '` | ' + lat + ' | ' + mod + ' | ' + sum + ' |');
    });
    return redactSecrets(lines.join('\n'), activeKey);
  }

  NS.KeyStore = KeyStore;
  NS.Probes = {
    REST_BASE: REST_BASE,
    WS_LIVE_BASE: WS_LIVE_BASE,
    ENDPOINTS: ENDPOINTS,
    stripModelsPrefix: stripModelsPrefix,
    withModelsPrefix: withModelsPrefix,
    redactSecrets: redactSecrets,
    validateApiKey: validateApiKey,
    sanitizePayloadForInspector: sanitizePayloadForInspector,
    buildSafeTextGenConfig: buildSafeTextGenConfig,
    extractVisibleText: extractVisibleText,
    createEmptyCatalog: createEmptyCatalog,
    buildCatalogFromModels: buildCatalogFromModels,
    runSingleProbe: runSingleProbe,
    runBatch: runBatch,
    buildExportReport: buildExportReport,
    buildMarkdownSummary: buildMarkdownSummary
  };
})(typeof window !== 'undefined' ? window : globalThis);
