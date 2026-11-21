(function (global) {
  'use strict';

  const NS = (global.GeminiProsody = global.GeminiProsody || {});

  const MODEL = 'gemini-3.8-flash';
  const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent';
  const REQUEST_TIMEOUT_MS = 25000;

  // Share the same storage keys as Cell #1 so a key entered once works across the grid.
  const SESSION_KEY = 'dc_gemini_api_key_session';
  const LOCAL_KEY = 'dc_gemini_api_key_local';
  let memoryKey = '';
  let storageRestricted = false;

  function safeGet(store, key) {
    try {
      return (store && store.getItem(key)) || '';
    } catch (_e) {
      storageRestricted = true;
      return '';
    }
  }

  function safeSet(store, key, val) {
    try {
      if (store) store.setItem(key, val);
      return true;
    } catch (_e) {
      storageRestricted = true;
      return false;
    }
  }

  function safeRemove(store, key) {
    try {
      if (store) store.removeItem(key);
    } catch (_e) {
      storageRestricted = true;
    }
  }

  const KeyStore = {
    get: function () {
      const s = safeGet(global.sessionStorage, SESSION_KEY);
      if (s) {
        memoryKey = s;
        return s;
      }
      const l = safeGet(global.localStorage, LOCAL_KEY);
      if (l) {
        memoryKey = l;
        return l;
      }
      if (!storageRestricted) {
        memoryKey = '';
      }
      return memoryKey;
    },
    set: function (rawKey) {
      const cleaned = String(rawKey || '').trim();
      memoryKey = cleaned;
      safeRemove(global.sessionStorage, SESSION_KEY);
      safeRemove(global.localStorage, LOCAL_KEY);
      if (cleaned) {
        safeSet(global.sessionStorage, SESSION_KEY, cleaned);
      }
      return cleaned;
    },
    clear: function () {
      memoryKey = '';
      safeRemove(global.sessionStorage, SESSION_KEY);
      safeRemove(global.localStorage, LOCAL_KEY);
    }
  };

  const SYSTEM_INSTRUCTION = [
    'You are a vocal prosody and emphasis interpreter controlling the size of a UI button.',
    'Listen carefully to the raw audio: word stress, vowel elongation, pitch contour, volume, and speaking rate.',
    'Map BOTH the words AND how they are spoken to a signed percentage delta (delta_percent) between -40 and +40:',
    '- Neutral "make it a little smaller" -> delta_percent around -12.',
    '- Emphasized or elongated "make it a LIIIITTLE smaller" or "just a TINY bit smaller" (cautious/stressed qualifier) -> micro-nudge, delta_percent around -2 to -4.',
    '- Emphasized "make it MUCH smaller" or loud/sharp "smaller!" -> larger step, delta_percent around -25 to -35.',
    '- Same symmetry for bigger/larger: neutral "a little bigger" -> +12; stressed "a liiiittle bigger" -> +2 to +4; "much bigger" -> +25 to +35.',
    '- If the speaker asks to reset / default / normal size -> direction "reset", delta_percent 0.',
    '- If speech is unrelated or silent -> direction "none", delta_percent 0.',
    'Return strict JSON matching the schema.'
  ].join(' ');

  const RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
      transcript: { type: 'STRING' },
      direction: { type: 'STRING', enum: ['bigger', 'smaller', 'reset', 'none'] },
      delta_percent: { type: 'INTEGER' },
      emphasized_word: { type: 'STRING' },
      prosody_note: { type: 'STRING' }
    },
    required: ['transcript', 'direction', 'delta_percent', 'emphasized_word', 'prosody_note']
  };

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onloadend = function () {
        const res = String(reader.result || '');
        const idx = res.indexOf(',');
        resolve(idx >= 0 ? res.slice(idx + 1) : res);
      };
      reader.onerror = function () {
        reject(new Error('Failed to read recorded audio.'));
      };
      reader.readAsDataURL(blob);
    });
  }

  function normalizeResult(result) {
    const dirRaw = String((result && result.direction) || 'none').toLowerCase();
    const direction = ['bigger', 'smaller', 'reset', 'none'].indexOf(dirRaw) >= 0 ? dirRaw : 'none';
    const rawDelta = Math.round(Number(result && result.delta_percent) || 0);
    const clampedMag = Math.min(40, Math.abs(rawDelta));
    let delta = 0;
    if (direction === 'smaller') delta = -clampedMag;
    else if (direction === 'bigger') delta = clampedMag;

    return {
      mode: 'live',
      transcript: String((result && result.transcript) || '').trim(),
      direction: direction,
      delta_percent: delta,
      emphasized_word: String((result && result.emphasized_word) || '').trim(),
      prosody_note: String((result && result.prosody_note) || '').trim()
    };
  }

  function analyzeAudioLive(audioBlob, apiKey, externalSignal) {
    const key = String(apiKey || '').trim();
    if (!key) {
      return Promise.reject(new Error('Missing Gemini API key.'));
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    function onExternalAbort() {
      controller.abort();
    }
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer);
        return Promise.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      }
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const mimeType = (audioBlob && audioBlob.type ? audioBlob.type.split(';')[0] : '') || 'audio/webm';

    return blobToBase64(audioBlob)
      .then(function (base64Data) {
        const payload = {
          systemInstruction: {
            parts: [{ text: SYSTEM_INSTRUCTION }]
          },
          contents: [
            {
              role: 'user',
              parts: [
                {
                  inlineData: {
                    mimeType: mimeType,
                    data: base64Data
                  }
                },
                {
                  text: 'Analyze the vocal emphasis and prosody in this audio command and output the button size adjustment JSON.'
                }
              ]
            }
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0.2
          }
        };

        return fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': key
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
      })
      .then(function (resp) {
        return resp.text().then(function (text) {
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch (_e) {
            parsed = null;
          }
          if (!resp.ok) {
            const msg = (parsed && parsed.error && parsed.error.message) || ('HTTP ' + resp.status);
            throw new Error(msg);
          }
          const blockReason = parsed && parsed.promptFeedback && parsed.promptFeedback.blockReason;
          if (blockReason) {
            throw new Error('Audio blocked by Gemini safety filter (' + blockReason + ').');
          }
          const candidate = parsed && parsed.candidates && parsed.candidates[0];
          const parts = (candidate && candidate.content && Array.isArray(candidate.content.parts)) ? candidate.content.parts : [];
          const textPart = parts.find(function (p) {
            return p && !p.thought && typeof p.text === 'string' && p.text.trim();
          });
          if (!textPart) {
            const finish = candidate && candidate.finishReason ? ' (' + candidate.finishReason + ')' : '';
            throw new Error('Empty response from Gemini audio model' + finish + '.');
          }
          let result;
          try {
            result = JSON.parse(textPart.text);
          } catch (_e) {
            throw new Error('Malformed JSON returned by Gemini audio model.');
          }
          return normalizeResult(result);
        });
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError' && timedOut) {
          throw new Error('Request timed out after 25s.');
        }
        throw err;
      })
      .finally(function () {
        clearTimeout(timer);
        if (externalSignal) {
          externalSignal.removeEventListener('abort', onExternalAbort);
        }
      });
  }

  // Preset prosody demos so the cell is immediately testable even without a live API key.
  const DEMO_PRESETS = [
    {
      id: 'neutral-small',
      label: '"a little smaller"',
      transcript: 'make this button a little smaller',
      direction: 'smaller',
      delta_percent: -12,
      emphasized_word: '',
      prosody_note: 'neutral delivery → standard step (-12%)'
    },
    {
      id: 'stressed-little',
      label: '"a LIIIITTLE smaller"',
      transcript: 'make this button a liiiittle smaller',
      direction: 'smaller',
      delta_percent: -3,
      emphasized_word: 'liiiittle',
      prosody_note: 'elongated "little" → micro-nudge (-3%)'
    },
    {
      id: 'stressed-much-bigger',
      label: '"MUCH bigger"',
      transcript: 'make it MUCH bigger',
      direction: 'bigger',
      delta_percent: 26,
      emphasized_word: 'MUCH',
      prosody_note: 'high vocal stress → bold jump (+26%)'
    }
  ];

  NS.Client = {
    MODEL: MODEL,
    KeyStore: KeyStore,
    DEMO_PRESETS: DEMO_PRESETS,
    analyzeAudioLive: analyzeAudioLive
  };
})(window);
