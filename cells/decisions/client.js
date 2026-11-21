(function (global) {
  'use strict';

  const NS = (global.GeminiDecisions = global.GeminiDecisions || {});

  const SESSION_KEY = 'dc_gemini_api_key_session';
  const LOCAL_KEY = 'dc_gemini_api_key_local';
  let memoryKey = '';
  let storageRestricted = false;

  function getStore(storeName) {
    try {
      return global[storeName] || null;
    } catch (_e) {
      storageRestricted = true;
      return null;
    }
  }

  function safeGet(storeName, key) {
    try {
      const store = getStore(storeName);
      if (!store) return '';
      return store.getItem(key) || '';
    } catch (_e) {
      storageRestricted = true;
      return '';
    }
  }

  function safeSet(storeName, key, val) {
    try {
      const store = getStore(storeName);
      if (!store) return false;
      store.setItem(key, val);
      return true;
    } catch (_e) {
      storageRestricted = true;
      return false;
    }
  }

  function safeRemove(storeName, key) {
    try {
      const store = getStore(storeName);
      if (!store) return;
      store.removeItem(key);
    } catch (_e) {
      storageRestricted = true;
    }
  }

  const KeyStore = {
    get: function () {
      if (memoryKey) return memoryKey;
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
      return '';
    },
    getStorageType: function () {
      if (safeGet('sessionStorage', SESSION_KEY)) return 'session';
      if (safeGet('localStorage', LOCAL_KEY)) return 'local';
      if (memoryKey) return 'memory';
      return 'none';
    },
    set: function (rawKey, persistLocal) {
      const cleaned = String(rawKey || '').trim();
      memoryKey = cleaned;
      safeRemove('sessionStorage', SESSION_KEY);
      safeRemove('localStorage', LOCAL_KEY);
      if (!cleaned) return 'none';
      if (persistLocal) {
        return safeSet('localStorage', LOCAL_KEY, cleaned) ? 'local' : 'memory';
      }
      return safeSet('sessionStorage', SESSION_KEY, cleaned) ? 'session' : 'memory';
    },
    clear: function () {
      memoryKey = '';
      safeRemove('sessionStorage', SESSION_KEY);
      safeRemove('localStorage', LOCAL_KEY);
    },
    mask: function (key) {
      const k = String(key || '').trim();
      if (!k) return '';
      if (k.length <= 8) return '••••' + k.slice(-2);
      return k.slice(0, 4) + '••••' + k.slice(-4);
    },
    isStorageRestricted: function () {
      return storageRestricted;
    }
  };

  function classifyApiError(httpStatus, payload, fallbackMessage, retryAfter) {
    const errObj = (payload && payload.error && typeof payload.error === 'object') ? payload.error : {};
    const rawCode = errObj.code !== undefined && errObj.code !== null ? String(errObj.code) : '';
    const rawStatus = errObj.status !== undefined && errObj.status !== null ? String(errObj.status) : '';
    const code = rawCode || rawStatus || String(httpStatus || 'UNKNOWN');
    const detail = String(errObj.message || fallbackMessage || 'Request failed.');

    const safetyCodes = ['safety', 'prohibited_content', 'blocklist', 'image_safety', 'content_blocked'];
    const matchedSafety = [rawCode, rawStatus].find(function (token) {
      return token && safetyCodes.indexOf(token.toLowerCase()) >= 0;
    });
    if (matchedSafety) {
      return {
        code: matchedSafety,
        httpStatus: httpStatus,
        headline: 'Input blocked by Gemini safety filter (' + matchedSafety + ')',
        detail: detail,
        remediation: 'Adjust the input text or image and retry.'
      };
    }

    if (httpStatus === 400) {
      return {
        code: code,
        httpStatus: 400,
        headline: 'Invalid Decisions API payload (HTTP 400)',
        detail: detail,
        remediation: 'Inspect the Request JSON tab for schema or criteria mismatches.'
      };
    }
    if (httpStatus === 401) {
      return {
        code: code,
        httpStatus: 401,
        headline: 'Invalid or rejected Gemini API key (HTTP 401)',
        detail: detail,
        remediation: 'Check your standard Gemini API key from Google AI Studio and update it.'
      };
    }
    if (httpStatus === 403) {
      return {
        code: code,
        httpStatus: 403,
        headline: 'Key lacks permission for gemini-decision-1 (HTTP 403)',
        detail: detail,
        remediation: 'Confirm Generative Language API access and regional availability for your key.'
      };
    }
    if (httpStatus === 404) {
      return {
        code: code,
        httpStatus: 404,
        headline: 'Decisions endpoint or model not found (HTTP 404)',
        detail: detail,
        remediation: 'Verify gemini-decision-1 availability on v1beta/decisions for your project.'
      };
    }
    if (httpStatus === 429) {
      return {
        code: code,
        httpStatus: 429,
        headline: 'Rate limit or quota exceeded (HTTP 429)',
        detail: detail,
        remediation: retryAfter
          ? 'Wait ' + retryAfter + 's before retrying, or inspect your AI Studio quota.'
          : 'Pause briefly and retry, or check your Google AI Studio quota limits.',
        retryAfter: retryAfter || null
      };
    }
    return {
      code: code,
      httpStatus: httpStatus || 0,
      headline: 'Gemini Decisions API error' + (httpStatus ? ' (HTTP ' + httpStatus + ')' : ''),
      detail: detail,
      remediation: 'Retry the live request or switch explicitly to Simulated mode.'
    };
  }

  function runLive(body, apiKey, externalSignal) {
    const key = String(apiKey || '').trim();
    if (!key) {
      return Promise.reject({
        code: 'MISSING_KEY',
        httpStatus: 0,
        headline: 'No Gemini API key configured',
        detail: 'Paste a standard Gemini API key (x-goog-api-key) to run live evaluations.',
        remediation: 'Open the API Key popover or switch explicitly to Simulated mode.'
      });
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, 25000);

    function onExternalAbort() {
      controller.abort();
    }
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer);
        return Promise.reject({ aborted: true });
      }
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const startedAt = performance.now();

    return fetch(NS.Schema.ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
      .then(function (resp) {
        const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
        const retryAfter = resp.headers.get('Retry-After');
        return resp.text().then(function (text) {
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch (_e) {
            parsed = null;
          }
          if (!resp.ok) {
            throw classifyApiError(resp.status, parsed, text || resp.statusText, retryAfter);
          }
          if (!parsed || typeof parsed !== 'object' || !parsed.answers) {
            throw classifyApiError(resp.status, parsed, 'Response did not contain an answers map.', null);
          }
          return {
            mode: 'live',
            httpStatus: resp.status,
            latencyMs: latencyMs,
            raw: parsed,
            evaluatedAt: new Date().toISOString()
          };
        });
      })
      .catch(function (err) {
        if (err && err.aborted) throw err;
        if (err && err.headline) throw err;
        if (err && err.name === 'AbortError') {
          if (timedOut) {
            throw {
              code: 'TIMEOUT',
              httpStatus: 0,
              headline: 'Live request timed out after 25s',
              detail: 'generativelanguage.googleapis.com did not respond before the client timeout.',
              remediation: 'Retry the live call or check your network connection.'
            };
          }
          throw { aborted: true };
        }
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        throw {
          code: offline ? 'OFFLINE' : 'NETWORK_ERROR',
          httpStatus: 0,
          headline: offline ? 'Browser appears offline' : 'Network request to Gemini Decisions API failed',
          detail: (err && err.message) ? err.message : 'Unable to reach generativelanguage.googleapis.com.',
          remediation: offline
            ? 'Reconnect to the internet to run Live evaluations, or switch to Simulated mode.'
            : 'Check network connectivity or browser extensions blocking generativelanguage.googleapis.com.'
        };
      })
      .finally(function () {
        clearTimeout(timer);
        if (externalSignal) {
          externalSignal.removeEventListener('abort', onExternalAbort);
        }
      });
  }

  // --- Honest Deterministic Local Simulator ---

  function fnv1a(str) {
    let h = 2166136261;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967295;
  }

  function tokenize(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(function (w) {
        return w.length >= 3;
      });
  }

  function overlapScore(inputTokens, targetText) {
    const tks = tokenize(targetText);
    if (!tks.length || !inputTokens.length) return 0;
    const set = Object.create(null);
    inputTokens.forEach(function (t) {
      set[t] = true;
    });
    let hits = 0;
    tks.forEach(function (t) {
      if (set[t]) hits += 1;
    });
    return hits / Math.sqrt(tks.length + 2);
  }

  function softmax(logits, temp) {
    if (!logits.length) return [];
    const t = Math.max(0.15, temp || 1);
    let maxL = -Infinity;
    for (let i = 0; i < logits.length; i++) {
      if (logits[i] > maxL) maxL = logits[i];
    }
    const exps = logits.map(function (v) {
      return Math.exp((v - maxL) / t);
    });
    const sum = exps.reduce(function (a, b) {
      return a + b;
    }, 0) || 1;
    return exps.map(function (e) {
      return e / sum;
    });
  }

  // Largest-remainder rounding to 1,000 milli-units (exact sum = 1.000, monotonic/argmax-preserving)
  function roundProbsToSumOne(probs) {
    if (!Array.isArray(probs) || probs.length === 0) return [];
    const scale = 1000;
    const raw = probs.map(function (p, idx) {
      const scaled = Math.max(0, Number(p) || 0) * scale;
      const base = Math.floor(scaled);
      return { idx: idx, base: base, frac: scaled - base, orig: Number(p) || 0 };
    });
    let sum = raw.reduce(function (acc, item) {
      return acc + item.base;
    }, 0);
    let remainder = scale - sum;
    if (remainder > 0) {
      const order = raw.slice().sort(function (a, b) {
        if (b.frac !== a.frac) return b.frac - a.frac;
        return b.orig - a.orig;
      });
      for (let i = 0; i < remainder && i < order.length; i++) {
        order[i].base += 1;
      }
    } else if (remainder < 0) {
      const order = raw.slice().sort(function (a, b) {
        return a.frac - b.frac;
      });
      for (let i = 0; i < -remainder && i < order.length; i++) {
        if (order[i].base > 0) order[i].base -= 1;
      }
    }
    return raw.map(function (item) {
      return item.base / scale;
    });
  }

  function resolutionSharpness(state) {
    if (!state || !state.image) return 1.0;
    if (state.resolution === 'low') return 0.72;
    if (state.resolution === 'high') return 1.18;
    return 1.0;
  }

  function resolutionImageTokens(res) {
    if (res === 'low') return 70;
    if (res === 'high') return 560;
    return 258;
  }

  function presetSignal(state) {
    const imgKind = state && state.image ? state.image.kind : null;
    const text = String((state && state.inputText) || '').toLowerCase();

    if (imgKind === 'receipt_clean') return { kind: 'receipt_clean', risk: 0.08, quality: 0.92, prefChoice: 'meals_client' };
    if (imgKind === 'receipt_flagged') return { kind: 'receipt_flagged', risk: 0.93, quality: 0.14, prefChoice: 'unallowable_bar' };
    if (imgKind === 'ui_clean') return { kind: 'ui_clean', risk: 0.09, quality: 0.91, prefChoice: 'clean_pass' };
    if (imgKind === 'ui_regressed') return { kind: 'ui_regressed', risk: 0.89, quality: 0.19, prefChoice: 'contrast_a11y' };

    const urgentHits = (text.match(/urgent|chargeback|double-charged|locked|outage|breaking|remove deprecated|401|violation|mismatch|overlap/g) || []).length;
    const calmHits = (text.match(/workaround|no rush|polished|unit tests|no public api|cleanly|reconciles|compliant/g) || []).length;
    const risk = NS.Schema.clamp(0.42 + urgentHits * 0.16 - calmHits * 0.16, 0.05, 0.95);

    let prefChoice = null;
    if (/double-charged|chargeback|refund|invoice|billing/.test(text)) prefChoice = 'billing';
    else if (/safari|csv|bug|export|crash/.test(text)) prefChoice = 'engineering';
    else if (/sso|lockout|login|permission/.test(text)) prefChoice = 'account_access';
    else if (/remove deprecated|breaking|tenant_uuid|401/.test(text)) prefChoice = 'major';
    else if (/unit tests|guard against|no public api/.test(text)) prefChoice = 'patch';

    return { kind: 'generic', risk: risk, quality: 1 - risk, prefChoice: prefChoice };
  }

  function runSimulated(state, body) {
    const sharp = resolutionSharpness(state);
    const sig = presetSignal(state);
    const corpus = String((state && state.inputText) || '') + ' ' + (state && state.image ? state.image.name : '');
    const inputTokens = tokenize(corpus);
    const answers = Object.create(null);

    const questions = (state && Array.isArray(state.questions)) ? state.questions : [];
    questions.forEach(function (q) {
      if (!q || q.enabled === false) return;
      const key = (q.key || '').trim();
      if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') return;

      const seed = fnv1a(key + '|' + corpus + '|' + (state.resolution || 'medium') + '|' + (q.instructions || ''));

      if (q.type === 'noul') {
        const inst = String(q.instructions || '').toLowerCase();
        let baseP;
        if (/ship|ready|compliant|safe|valid|approve/.test(inst) && !/violat|escalat|migrat|break|defect|damage/.test(inst)) {
          baseP = sig.quality;
        } else if (/violat|escalat|migrat|break|defect|damage|flag|risk|urgent/.test(inst)) {
          baseP = sig.risk;
        } else {
          const tMatch = overlapScore(inputTokens, (q.trueDescription || '') + ' ' + q.instructions);
          const fMatch = overlapScore(inputTokens, q.falseDescription || '');
          baseP = 1 / (1 + Math.exp(-(tMatch - fMatch) * 2.2 + (seed - 0.5) * 0.8));
        }
        const logit = Math.log(NS.Schema.clamp(baseP, 0.02, 0.98) / (1 - NS.Schema.clamp(baseP, 0.02, 0.98)));
        const adjusted = 1 / (1 + Math.exp(-(logit * sharp + (seed - 0.5) * 0.16)));
        const p = Math.round(NS.Schema.clamp(adjusted, 0.01, 0.99) * 100) / 100;
        answers[key] = {
          type: 'noul',
          noul: p,
          confidence: Math.round(Math.max(p, 1 - p) * 100) / 100
        };
      } else if (q.type === 'choice') {
        const opts = Array.isArray(q.options) ? q.options : [];
        const sortedOpts = opts.slice().sort(function (a, b) {
          const ak = (a.key || '').trim();
          const bk = (b.key || '').trim();
          return ak < bk ? -1 : ak > bk ? 1 : 0;
        });

        const logits = sortedOpts.map(function (opt) {
          const ok = (opt.key || '').trim();
          let score = overlapScore(inputTokens, ok.replace(/_/g, ' ') + ' ' + (opt.description || '')) * 2.4;
          if (sig.prefChoice && ok === sig.prefChoice) score += 2.6;
          if (sig.kind === 'receipt_flagged' && ok === 'needs_manual_audit') score += 1.25;
          if (sig.kind === 'ui_regressed' && ok === 'layout_overlap') score += 2.15;
          if (sig.kind === 'generic' && /sso|locked/.test(corpus.toLowerCase()) && ok === 'account_access') score += 1.6;
          score += (fnv1a(key + '|' + ok + '|' + corpus) - 0.5) * 0.45;
          return score;
        });

        const probs = roundProbsToSumOne(softmax(logits, 0.95 / sharp));
        const probMap = Object.create(null);
        let bestKey = '';
        let bestP = 0;
        sortedOpts.forEach(function (opt, i) {
          const ok = (opt.key || '').trim();
          if (!ok || ok === '__proto__' || ok === 'constructor' || ok === 'prototype') return;
          probMap[ok] = probs[i];
          if (probs[i] > bestP || (bestKey === '' && i === 0)) {
            bestP = probs[i];
            bestKey = ok;
          }
        });

        answers[key] = {
          type: 'choice',
          choice: bestKey,
          probabilities: probMap,
          confidence: bestP
        };
      } else if (q.type === 'score') {
        const levels = Array.isArray(q.levels) ? q.levels : [];
        const kCount = Math.max(2, levels.length);
        const inst = String(q.instructions || '').toLowerCase();
        const higherIsWorse = /sever|blast|risk|danger|urgent|damage/.test(inst);
        const targetRatio = higherIsWorse ? sig.risk : sig.quality;
        const center = targetRatio * (kCount - 1) + (seed - 0.5) * 0.25;
        const spread = state.image && state.resolution === 'low' ? 0.95 : state.image && state.resolution === 'high' ? 0.42 : 0.58;

        const logits = levels.map(function (desc, idx) {
          const dist = idx - center;
          const gauss = -(dist * dist) / (2 * spread * spread);
          const lex = overlapScore(inputTokens, desc) * 0.7;
          return gauss + lex;
        });

        const probs = roundProbsToSumOne(softmax(logits, 1.0));
        const probMap = Object.create(null);
        const legend = Object.create(null);
        let expected = 0;
        let maxP = 0;
        levels.forEach(function (desc, idx) {
          const sk = String(idx);
          probMap[sk] = probs[idx];
          legend[sk] = String(desc || '').trim();
          expected += idx * probs[idx];
          if (probs[idx] > maxP) maxP = probs[idx];
        });

        answers[key] = {
          type: 'score',
          score: Math.round(expected * 100) / 100,
          legend: legend,
          probabilities: probMap,
          confidence: maxP
        };
      }
    });

    const textStr = JSON.stringify(body.questions || {}) + ' ' + String((state && state.inputText) || '');
    const textTokens = Math.max(24, Math.round(textStr.length / 4));
    const modalities = [{ modality: 'text', tokens: textTokens }];
    let totalIn = textTokens;
    if (state && state.image && state.image.data) {
      const imgTok = resolutionImageTokens(state.resolution);
      modalities.unshift({ modality: 'image', tokens: imgTok });
      totalIn += imgTok;
    }

    return {
      mode: 'simulated',
      httpStatus: null,
      latencyMs: null,
      raw: {
        answers: answers,
        usage: {
          total_input_tokens: totalIn,
          input_tokens_by_modality: modalities,
          total_output_tokens: 0,
          total_tokens: totalIn
        }
      },
      evaluatedAt: new Date().toISOString()
    };
  }

  NS.Client = {
    KeyStore: KeyStore,
    runLive: runLive,
    runSimulated: runSimulated
  };
})(window);
