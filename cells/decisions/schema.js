(function (global) {
  'use strict';

  const NS = (global.GeminiDecisions = global.GeminiDecisions || {});

  const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';
  const MODEL = 'gemini-decision-1';
  const KEY_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
  const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];
  const VALID_TYPES = { noul: true, choice: true, score: true };
  const RESOLUTIONS = ['low', 'medium', 'high'];

  function clamp(num, min, max) {
    if (!Number.isFinite(num)) return min;
    return Math.min(max, Math.max(min, num));
  }

  function toFiniteNumber(val) {
    if (val === null || val === undefined || val === '') return NaN;
    const n = Number(val);
    return Number.isFinite(n) ? n : NaN;
  }

  function isReservedKey(key) {
    return RESERVED_KEYS.indexOf(key) >= 0;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function estimateBase64Bytes(b64) {
    if (!b64 || typeof b64 !== 'string') return 0;
    const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
  }

  function validateState(state) {
    const errors = [];
    const text = (state && typeof state.inputText === 'string' ? state.inputText : '').trim();
    const hasImage = Boolean(state && state.image && state.image.data);

    if (!text && !hasImage) {
      errors.push({
        field: 'input',
        message: 'Provide input text or attach an image to evaluate.'
      });
    }

    const questions = Array.isArray(state && state.questions) ? state.questions : [];
    const active = questions.filter(function (q) {
      return q && q.enabled !== false;
    });

    if (active.length === 0) {
      errors.push({
        field: 'questions',
        message: 'Enable at least one question to evaluate.'
      });
    } else if (active.length > 1000) {
      errors.push({
        field: 'questions',
        message: 'Decisions API accepts at most 1,000 questions per request.'
      });
    }

    const seenQuestionKeys = Object.create(null);

    active.forEach(function (q) {
      const qKey = typeof q.key === 'string' ? q.key.trim() : '';
      if (!KEY_REGEX.test(qKey) || isReservedKey(qKey)) {
        errors.push({
          field: 'question.key',
          questionId: q.id,
          message: isReservedKey(qKey)
            ? 'Question key "' + qKey + '" is a reserved JavaScript property name.'
            : 'Question key "' + (qKey || '(empty)') + '" must be 1–64 chars matching [A-Za-z0-9_-].'
        });
      } else if (seenQuestionKeys[qKey]) {
        errors.push({
          field: 'question.key',
          questionId: q.id,
          message: 'Duplicate question key "' + qKey + '".'
        });
      } else {
        seenQuestionKeys[qKey] = true;
      }

      if (!Object.prototype.hasOwnProperty.call(VALID_TYPES, q.type)) {
        errors.push({
          field: 'question.type',
          questionId: q.id,
          message: 'Question "' + (qKey || '(unnamed)') + '" has unsupported type "' + String(q.type) + '".'
        });
        return;
      }

      const instructions = typeof q.instructions === 'string' ? q.instructions.trim() : '';
      if (!instructions) {
        errors.push({
          field: 'question.instructions',
          questionId: q.id,
          message: 'Question "' + (qKey || q.type) + '" requires instructions.'
        });
      }

      if (q.type === 'choice') {
        const opts = Array.isArray(q.options) ? q.options : [];
        if (opts.length < 2) {
          errors.push({
            field: 'question.options',
            questionId: q.id,
            message: 'Choice "' + (qKey || 'question') + '" needs at least 2 options.'
          });
        } else if (opts.length > 255) {
          errors.push({
            field: 'question.options',
            questionId: q.id,
            message: 'Choice "' + (qKey || 'question') + '" supports at most 255 options.'
          });
        }
        const seenOptKeys = Object.create(null);
        opts.forEach(function (opt, idx) {
          const optKey = opt && typeof opt.key === 'string' ? opt.key.trim() : '';
          const optDesc = opt && typeof opt.description === 'string' ? opt.description.trim() : '';
          if (!optKey || !KEY_REGEX.test(optKey) || isReservedKey(optKey)) {
            errors.push({
              field: 'question.option.key',
              questionId: q.id,
              optionIndex: idx,
              message: isReservedKey(optKey)
                ? 'Option key "' + optKey + '" in "' + (qKey || 'choice') + '" is reserved.'
                : 'Option #' + (idx + 1) + ' in "' + (qKey || 'choice') + '" needs a key matching [A-Za-z0-9_-].'
            });
          } else if (seenOptKeys[optKey]) {
            errors.push({
              field: 'question.option.key',
              questionId: q.id,
              optionIndex: idx,
              message: 'Duplicate option key "' + optKey + '" in "' + (qKey || 'choice') + '".'
            });
          } else {
            seenOptKeys[optKey] = true;
          }
          if (!optDesc) {
            errors.push({
              field: 'question.option.description',
              questionId: q.id,
              optionIndex: idx,
              message: 'Option "' + (optKey || '#' + (idx + 1)) + '" in "' + (qKey || 'choice') + '" needs a description.'
            });
          }
        });
      } else if (q.type === 'score') {
        const levels = Array.isArray(q.levels) ? q.levels : [];
        if (levels.length < 2) {
          errors.push({
            field: 'question.levels',
            questionId: q.id,
            message: 'Score "' + (qKey || 'question') + '" needs at least 2 rubric levels.'
          });
        } else if (levels.length > 255) {
          errors.push({
            field: 'question.levels',
            questionId: q.id,
            message: 'Score "' + (qKey || 'question') + '" supports at most 255 rubric levels.'
          });
        }
        levels.forEach(function (lvl, idx) {
          if (typeof lvl !== 'string' || !lvl.trim()) {
            errors.push({
              field: 'question.level',
              questionId: q.id,
              levelIndex: idx,
              message: 'Score level ' + idx + ' in "' + (qKey || 'score') + '" cannot be empty.'
            });
          }
        });
      }
    });

    return {
      valid: errors.length === 0,
      errors: errors,
      activeCount: active.length
    };
  }

  function buildRequestBody(state) {
    const text = (state && typeof state.inputText === 'string' ? state.inputText : '').trim();
    const img = state && state.image && state.image.data ? state.image : null;
    const resolution = RESOLUTIONS.indexOf(state && state.resolution) >= 0 ? state.resolution : 'medium';

    let input;
    if (img) {
      input = [
        {
          type: 'image',
          data: img.data,
          mime_type: img.mimeType || 'image/png',
          resolution: resolution
        }
      ];
      if (text) {
        input.push({
          type: 'text',
          text: text
        });
      }
    } else {
      input = text;
    }

    const questionsMap = Object.create(null);
    const questions = Array.isArray(state && state.questions) ? state.questions : [];
    questions.forEach(function (q) {
      if (!q || q.enabled === false) return;
      const key = typeof q.key === 'string' ? q.key.trim() : '';
      if (!key || isReservedKey(key)) return;
      const instructions = typeof q.instructions === 'string' ? q.instructions.trim() : '';

      if (q.type === 'noul') {
        const entry = {
          type: 'noul',
          instructions: instructions
        };
        const td = typeof q.trueDescription === 'string' ? q.trueDescription.trim() : '';
        const fd = typeof q.falseDescription === 'string' ? q.falseDescription.trim() : '';
        if (td || fd) {
          entry.criteria = {};
          if (td) entry.criteria.true_description = td;
          if (fd) entry.criteria.false_description = fd;
        }
        questionsMap[key] = entry;
      } else if (q.type === 'choice') {
        const criteria = Object.create(null);
        (Array.isArray(q.options) ? q.options : []).forEach(function (opt) {
          if (!opt || typeof opt !== 'object') return;
          const ok = typeof opt.key === 'string' ? opt.key.trim() : '';
          const desc = typeof opt.description === 'string' ? opt.description.trim() : '';
          if (ok && !isReservedKey(ok)) criteria[ok] = desc;
        });
        questionsMap[key] = {
          type: 'choice',
          instructions: instructions,
          criteria: criteria
        };
      } else if (q.type === 'score') {
        questionsMap[key] = {
          type: 'score',
          instructions: instructions,
          criteria: (Array.isArray(q.levels) ? q.levels : []).map(function (lvl) {
            return String(lvl === null || lvl === undefined ? '' : lvl).trim();
          })
        };
      }
    });

    return {
      model: MODEL,
      input: input,
      questions: questionsMap
    };
  }

  function cloneBodyForDisplay(body, includeBase64) {
    if (includeBase64 || !body || !Array.isArray(body.input)) {
      return body;
    }
    return {
      model: body.model,
      input: body.input.map(function (part) {
        if (part && part.type === 'image' && typeof part.data === 'string') {
          const size = formatBytes(estimateBase64Bytes(part.data));
          return {
            type: part.type,
            mime_type: part.mime_type,
            resolution: part.resolution,
            data: '<base64 ' + (part.mime_type || 'image') + ' · ' + size + ' omitted>'
          };
        }
        return part;
      }),
      questions: body.questions
    };
  }

  function formatRequestJson(body, opts) {
    const includeBase64 = Boolean(opts && opts.includeBase64);
    return JSON.stringify(cloneBodyForDisplay(body, includeBase64), null, 2);
  }

  function escapeSingleQuotedShell(str) {
    return String(str).replace(/'/g, "'\\''");
  }

  function buildCurl(body, opts) {
    const json = formatRequestJson(body, opts);
    return [
      'curl -X POST ' + ENDPOINT + ' \\',
      '  -H "Content-Type: application/json" \\',
      '  -H "x-goog-api-key: $GEMINI_API_KEY" \\',
      "  -d '" + escapeSingleQuotedShell(json) + "'"
    ].join('\n');
  }

  function normalizeResponse(raw, state) {
    const rawAnswers = (raw && raw.answers && typeof raw.answers === 'object' && !Array.isArray(raw.answers)) ? raw.answers : {};
    const questions = Array.isArray(state && state.questions) ? state.questions : [];
    const byKey = Object.create(null);
    questions.forEach(function (q) {
      if (q && typeof q.key === 'string' && q.key.trim()) {
        byKey[q.key.trim()] = q;
      }
    });

    const normalizedAnswers = Object.create(null);
    // Answers whose core value is missing or non-numeric. They are left out of `answers` so the UI
    // shows "no valid answer" instead of a fabricated 50% / 0% result.
    const invalid = [];

    Object.keys(rawAnswers).forEach(function (key) {
      if (isReservedKey(key)) return;
      const ans = rawAnswers[key];
      if (!ans || typeof ans !== 'object' || Array.isArray(ans)) return;
      const qDef = byKey[key] || null;
      const type = ans.type || (qDef && qDef.type) || 'noul';

      if (type === 'noul') {
        const rawNoul = toFiniteNumber(ans.noul);
        if (!Number.isFinite(rawNoul)) {
          invalid.push({ key: key, type: 'noul', reason: 'noul is not a number' });
          return;
        }
        const safeP = clamp(rawNoul, 0.01, 0.99);
        const rawConf = toFiniteNumber(ans.confidence);
        const conf = Number.isFinite(rawConf)
          ? clamp(rawConf, 0.5, 0.99)
          : Math.max(safeP, 1 - safeP);
        normalizedAnswers[key] = {
          type: 'noul',
          noul: safeP,
          confidence: conf
        };
      } else if (type === 'choice') {
        const probs = (ans.probabilities && typeof ans.probabilities === 'object' && !Array.isArray(ans.probabilities)) ? ans.probabilities : {};
        const descMap = Object.create(null);
        if (qDef && Array.isArray(qDef.options)) {
          qDef.options.forEach(function (o) {
            if (o && typeof o.key === 'string' && o.key.trim()) {
              descMap[o.key.trim()] = typeof o.description === 'string' ? o.description : '';
            }
          });
        }

        const keys = Object.keys(probs);
        let sum = 0;
        const ranked = keys.map(function (k) {
          const val = toFiniteNumber(probs[k]);
          const p = Number.isFinite(val) ? Math.max(0, val) : 0;
          sum += p;
          return {
            key: k,
            prob: p,
            description: descMap[k] || ''
          };
        });

        if (!(sum > 0)) {
          invalid.push({ key: key, type: 'choice', reason: 'no usable probabilities' });
          return;
        }

        const declaredWinner = typeof ans.choice === 'string' && ans.choice ? ans.choice : '';

        ranked.sort(function (a, b) {
          if (b.prob !== a.prob) return b.prob - a.prob;
          if (declaredWinner) {
            if (a.key === declaredWinner && b.key !== declaredWinner) return -1;
            if (b.key === declaredWinner && a.key !== declaredWinner) return 1;
          }
          return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
        });

        const winner = declaredWinner || (ranked[0] ? ranked[0].key : '');
        const winnerEntry = ranked.find(function (r) {
          return r.key === winner;
        });
        const topProb = ranked[0] ? ranked[0].prob : 0;
        const runnerUpProb = ranked[1] ? ranked[1].prob : 0;
        const rawConf = toFiniteNumber(ans.confidence);
        const conf = Number.isFinite(rawConf) ? rawConf : topProb;

        normalizedAnswers[key] = {
          type: 'choice',
          choice: winner,
          winnerProb: winnerEntry ? winnerEntry.prob : 0,
          probabilities: probs,
          ranked: ranked,
          sum: sum,
          margin: Math.max(0, topProb - runnerUpProb),
          confidence: conf
        };
      } else if (type === 'score') {
        const probs = (ans.probabilities && typeof ans.probabilities === 'object') ? ans.probabilities : {};
        const legend = (ans.legend && typeof ans.legend === 'object') ? ans.legend : {};
        const rawKeys = Object.keys(probs).length ? Object.keys(probs) : Object.keys(legend);
        // The rubric defines the range: levels the response leaves out still get a 0% column, so
        // "Rubric Score (0–3)" never shrinks to the levels that happened to come back.
        if (qDef && Array.isArray(qDef.levels)) {
          for (let li = 0; li < qDef.levels.length; li++) {
            if (rawKeys.indexOf(String(li)) < 0) rawKeys.push(String(li));
          }
        }
        const numericKeys = rawKeys.slice().sort(function (a, b) {
          return Number(a) - Number(b);
        });

        let sum = 0;
        let expected = 0;
        let peakIndex = 0;
        let peakProb = -1;

        const levels = numericKeys.map(function (k, fallbackIdx) {
          const parsedIdx = toFiniteNumber(k);
          const idxNum = Number.isFinite(parsedIdx) ? parsedIdx : fallbackIdx;
          const val = toFiniteNumber(probs[k]);
          const p = Number.isFinite(val) ? Math.max(0, val) : 0;
          sum += p;
          expected += idxNum * p;
          if (p > peakProb) {
            peakProb = p;
            peakIndex = idxNum;
          }
          let fallbackDesc = '';
          if (qDef && Array.isArray(qDef.levels)) {
            if (Number.isInteger(idxNum) && idxNum >= 0 && idxNum < qDef.levels.length) {
              fallbackDesc = qDef.levels[idxNum];
            } else if (fallbackIdx < qDef.levels.length) {
              fallbackDesc = qDef.levels[fallbackIdx];
            }
          }
          return {
            index: idxNum,
            key: String(k),
            prob: p,
            description: legend[k] || fallbackDesc || ('Level ' + k)
          };
        });

        if (!(sum > 0)) {
          invalid.push({ key: key, type: 'score', reason: 'no usable probabilities' });
          return;
        }

        const rawScore = toFiniteNumber(ans.score);
        const scoreVal = Number.isFinite(rawScore) ? rawScore : expected / sum;
        let variance = 0;
        levels.forEach(function (lvl) {
          const diff = lvl.index - scoreVal;
          variance += lvl.prob * diff * diff;
        });

        const minIndex = levels.length ? levels[0].index : 0;
        const maxIndex = levels.length ? levels[levels.length - 1].index : 1;
        const rawConf = toFiniteNumber(ans.confidence);
        const conf = Number.isFinite(rawConf)
          ? rawConf
          : Math.max(0, peakProb);

        normalizedAnswers[key] = {
          type: 'score',
          score: scoreVal,
          min: minIndex,
          max: maxIndex,
          levels: levels,
          peakIndex: peakIndex,
          peakProb: Math.max(0, peakProb),
          stdDev: Math.sqrt(Math.max(0, variance)),
          sum: sum,
          confidence: conf
        };
      }
    });

    const rawUsage = (raw && raw.usage && typeof raw.usage === 'object') ? raw.usage : {};
    const totalIn = toFiniteNumber(rawUsage.total_input_tokens);
    const totalOut = toFiniteNumber(rawUsage.total_output_tokens);
    const totalAll = toFiniteNumber(rawUsage.total_tokens);
    const usage = {
      total_input_tokens: Number.isFinite(totalIn) ? totalIn : 0,
      input_tokens_by_modality: Array.isArray(rawUsage.input_tokens_by_modality)
        ? rawUsage.input_tokens_by_modality
        : [],
      total_output_tokens: Number.isFinite(totalOut) ? totalOut : 0,
      total_tokens: Number.isFinite(totalAll) ? totalAll : 0
    };

    return {
      answers: normalizedAnswers,
      invalid: invalid,
      usage: usage,
      raw: raw
    };
  }

  // Whole-number percentages for display. A distribution whose mass is ~1 is rounded with the
  // largest-remainder method so the shown bars add up to exactly 100% (plain rounding can show
  // 99% or 101%). The raw peak always keeps the largest displayed value. Anything else (partial or
  // malformed probabilities) is rounded value by value and never forced to 100.
  function toDisplayPercents(probs) {
    if (!Array.isArray(probs) || !probs.length) return [];
    const vals = probs.map(function (p) {
      const n = toFiniteNumber(p);
      return Number.isFinite(n) && n > 0 ? n : 0;
    });
    const total = vals.reduce(function (a, b) {
      return a + b;
    }, 0);
    if (Math.abs(total - 1) > 0.02) {
      return vals.map(function (v) {
        return Math.round(v * 100);
      });
    }
    const scaled = vals.map(function (v, idx) {
      const s = (v / total) * 100;
      return { idx: idx, base: Math.floor(s), frac: s - Math.floor(s), raw: v };
    });
    let remainder = 100 - scaled.reduce(function (a, s) {
      return a + s.base;
    }, 0);
    scaled
      .slice()
      .sort(function (a, b) {
        if (b.frac !== a.frac) return b.frac - a.frac;
        if (b.raw !== a.raw) return b.raw - a.raw;
        return a.idx - b.idx;
      })
      .forEach(function (s) {
        if (remainder > 0) {
          s.base += 1;
          remainder -= 1;
        }
      });
    const out = scaled.map(function (s) {
      return s.base;
    });
    // Guard: rounding must never make a non-peak bar outrank the raw peak.
    let peak = 0;
    vals.forEach(function (v, i) {
      if (v > vals[peak]) peak = i;
    });
    out.forEach(function (p, i) {
      if (i !== peak && p > out[peak]) {
        out[i] -= 1;
        out[peak] += 1;
      }
    });
    return out;
  }

  NS.Schema = {
    ENDPOINT: ENDPOINT,
    MODEL: MODEL,
    KEY_REGEX: KEY_REGEX,
    RESOLUTIONS: RESOLUTIONS,
    clamp: clamp,
    formatBytes: formatBytes,
    estimateBase64Bytes: estimateBase64Bytes,
    validateState: validateState,
    buildRequestBody: buildRequestBody,
    formatRequestJson: formatRequestJson,
    buildCurl: buildCurl,
    normalizeResponse: normalizeResponse,
    toDisplayPercents: toDisplayPercents
  };
})(window);
