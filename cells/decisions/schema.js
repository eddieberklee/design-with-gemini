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
          const optKey = typeof opt.key === 'string' ? opt.key.trim() : '';
          const optDesc = typeof opt.description === 'string' ? opt.description.trim() : '';
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
      const key = (q.key || '').trim();
      if (!key || isReservedKey(key)) return;

      if (q.type === 'noul') {
        const entry = {
          type: 'noul',
          instructions: (q.instructions || '').trim()
        };
        const td = (q.trueDescription || '').trim();
        const fd = (q.falseDescription || '').trim();
        if (td || fd) {
          entry.criteria = {};
          if (td) entry.criteria.true_description = td;
          if (fd) entry.criteria.false_description = fd;
        }
        questionsMap[key] = entry;
      } else if (q.type === 'choice') {
        const criteria = Object.create(null);
        (q.options || []).forEach(function (opt) {
          const ok = (opt.key || '').trim();
          if (ok && !isReservedKey(ok)) criteria[ok] = (opt.description || '').trim();
        });
        questionsMap[key] = {
          type: 'choice',
          instructions: (q.instructions || '').trim(),
          criteria: criteria
        };
      } else if (q.type === 'score') {
        questionsMap[key] = {
          type: 'score',
          instructions: (q.instructions || '').trim(),
          criteria: (q.levels || []).map(function (lvl) {
            return String(lvl || '').trim();
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
    const rawAnswers = (raw && raw.answers && typeof raw.answers === 'object') ? raw.answers : {};
    const questions = Array.isArray(state && state.questions) ? state.questions : [];
    const byKey = Object.create(null);
    questions.forEach(function (q) {
      if (q && q.key) byKey[q.key.trim()] = q;
    });

    const normalizedAnswers = Object.create(null);

    Object.keys(rawAnswers).forEach(function (key) {
      if (isReservedKey(key)) return;
      const ans = rawAnswers[key];
      if (!ans || typeof ans !== 'object') return;
      const qDef = byKey[key] || null;
      const type = ans.type || (qDef && qDef.type) || 'noul';

      if (type === 'noul') {
        const rawNoul = toFiniteNumber(ans.noul);
        const safeP = Number.isFinite(rawNoul) ? clamp(rawNoul, 0.01, 0.99) : 0.5;
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
        const probs = (ans.probabilities && typeof ans.probabilities === 'object') ? ans.probabilities : {};
        const descMap = Object.create(null);
        if (qDef && Array.isArray(qDef.options)) {
          qDef.options.forEach(function (o) {
            if (o && o.key) descMap[o.key.trim()] = o.description || '';
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
        const topProb = ranked[0] ? ranked[0].prob : 0;
        const runnerUpProb = ranked[1] ? ranked[1].prob : 0;
        const rawConf = toFiniteNumber(ans.confidence);
        const conf = Number.isFinite(rawConf) ? rawConf : topProb;

        normalizedAnswers[key] = {
          type: 'choice',
          choice: winner,
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

        const rawScore = toFiniteNumber(ans.score);
        const scoreVal = Number.isFinite(rawScore) ? rawScore : expected;
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
      usage: usage,
      raw: raw
    };
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
    normalizeResponse: normalizeResponse
  };
})(window);
