(function (global) {
  'use strict';

  const NS = (global.GeminiProsody = global.GeminiProsody || {});

  const LIVE_MODELS = [
    'models/gemini-3.8-live',
    'models/gemini-live-2.5-flash-native-audio'
  ];
  const WS_BASE =
    'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
  const SETUP_TIMEOUT_MS = 12000;
  const MAX_BUFFERED_BYTES = 262144;

  // Share the same storage keys as Cell #1 & Cell #4 so a key entered once works across the grid.
  const SESSION_KEY = 'dc_gemini_api_key_session';
  const LOCAL_KEY = 'dc_gemini_api_key_local';
  let memoryKey = '';
  let storageRestricted = false;
  let syncingKey = false;

  function getStore(storeName) {
    try {
      const store = global[storeName];
      if (!store || typeof store.getItem !== 'function') {
        storageRestricted = true;
        return null;
      }
      return store;
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
      if (!store || typeof store.setItem !== 'function') {
        storageRestricted = true;
        return false;
      }
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
      if (!store || typeof store.removeItem !== 'function') {
        storageRestricted = true;
        return;
      }
      store.removeItem(key);
    } catch (_e) {
      storageRestricted = true;
    }
  }

  function syncSiblingsAndNotify(cleaned, persistLocal, mode) {
    if (syncingKey) return;
    syncingKey = true;
    try {
      ['GeminiDecisions', 'GeminiApiMatrix'].forEach(function (nsName) {
        const ns = global[nsName];
        const ks = ns && ((ns.Client && ns.Client.KeyStore) || ns.KeyStore);
        if (!ks || ks === KeyStore) return;
        try {
          const current = typeof ks.get === 'function' ? ks.get() : null;
          if (cleaned) {
            if (current !== cleaned && typeof ks.set === 'function') {
              ks.set(cleaned, Boolean(persistLocal));
            }
          } else if (current !== '' && typeof ks.clear === 'function') {
            ks.clear();
          }
        } catch (_e) {
          // Ignore sibling sync errors
        }
      });

      if (typeof global.dispatchEvent === 'function') {
        try {
          const detail = { hasKey: Boolean(cleaned), storage: mode };
          let ev = null;
          if (typeof global.CustomEvent === 'function') {
            ev = new global.CustomEvent('gemini-key-changed', { detail: detail });
          } else if (typeof CustomEvent === 'function') {
            ev = new CustomEvent('gemini-key-changed', { detail: detail });
          } else if (typeof Event === 'function') {
            ev = new Event('gemini-key-changed');
          }
          if (ev) global.dispatchEvent(ev);
        } catch (_e) {
          // Ignore CustomEvent construction errors in minimal mocks
        }
      }
    } finally {
      syncingKey = false;
    }
  }

  const KeyStore = {
    get: function () {
      storageRestricted = false;
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
      if (!storageRestricted) {
        memoryKey = '';
        return '';
      }
      if (!memoryKey) {
        const decisionsKs =
          global.GeminiDecisions &&
          global.GeminiDecisions.Client &&
          global.GeminiDecisions.Client.KeyStore;
        if (decisionsKs && typeof decisionsKs.get === 'function') {
          try {
            const fromDecisions = decisionsKs.get();
            if (fromDecisions) {
              memoryKey = fromDecisions;
              return fromDecisions;
            }
          } catch (_e) {
            // ignore
          }
        }
      }
      return memoryKey || '';
    },
    set: function (rawKey, persistLocal) {
      const cleaned = String(rawKey || '').trim();
      memoryKey = cleaned;
      safeRemove('sessionStorage', SESSION_KEY);
      safeRemove('localStorage', LOCAL_KEY);
      let mode = 'none';
      if (cleaned) {
        if (persistLocal) {
          mode = safeSet('localStorage', LOCAL_KEY, cleaned) ? 'local' : 'memory';
        } else {
          mode = safeSet('sessionStorage', SESSION_KEY, cleaned) ? 'session' : 'memory';
        }
      }
      syncSiblingsAndNotify(cleaned, persistLocal, mode);
      return cleaned;
    },
    clear: function () {
      memoryKey = '';
      safeRemove('sessionStorage', SESSION_KEY);
      safeRemove('localStorage', LOCAL_KEY);
      syncSiblingsAndNotify('', false, 'none');
    },
    isStorageRestricted: function () {
      return storageRestricted;
    }
  };

  // --- Synthesized Tactile Web Audio Sound Feedback ---
  const SoundFX = (function () {
    let ctx = null;
    let muted = false;

    function getCtx() {
      if (muted) return null;
      const AudioCtx = global.AudioContext || global.webkitAudioContext;
      if (typeof AudioCtx !== 'function') return null;
      if (ctx && ctx.state === 'closed') {
        ctx = null;
      }
      if (!ctx) {
        try {
          ctx = new AudioCtx();
        } catch (_e) {
          ctx = null;
          return null;
        }
      }
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        try {
          const p = ctx.resume();
          if (p && typeof p.catch === 'function') p.catch(function () {});
        } catch (_e) {
          // ignore
        }
      }
      return ctx;
    }

    function playTone(audioCtx, freq, startOffset, duration, type, peakGain, endFreq) {
      try {
        const now = audioCtx.currentTime + startOffset;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type || 'sine';
        osc.frequency.setValueAtTime(freq, now);
        if (endFreq) {
          osc.frequency.exponentialRampToValueAtTime(endFreq, now + duration);
        }
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(peakGain, now + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + duration + 0.02);
      } catch (_e) {
        // Never allow Web Audio synthesis limits/errors to interrupt UI handlers
      }
    }

    return {
      isMuted: function () {
        return muted;
      },
      toggleMute: function () {
        muted = !muted;
        return muted;
      },
      close: function () {
        if (ctx) {
          const prev = ctx;
          ctx = null;
          try {
            const p = prev.close && prev.close();
            if (p && typeof p.catch === 'function') p.catch(function () {});
          } catch (_e) {
            // ignore
          }
        }
      },
      playStreamToggle: function (starting) {
        const c = getCtx();
        if (!c) return;
        if (starting) {
          playTone(c, 520, 0, 0.08, 'sine', 0.06, 680);
        } else {
          playTone(c, 560, 0, 0.09, 'sine', 0.05, 380);
        }
      },
      playResize: function (direction, deltaPercent) {
        const c = getCtx();
        if (!c) return;
        if (direction === 'reset') {
          playTone(c, 440, 0, 0.14, 'triangle', 0.08);
          playTone(c, 659.25, 0.06, 0.18, 'sine', 0.07);
          return;
        }
        const mag = Math.abs(deltaPercent || 0);
        if (mag === 0) return;
        const growing = deltaPercent > 0;

        if (mag <= 6) {
          // Micro-nudge ("liiiittle"): crisp, delicate detented tick
          const base = growing ? 740 : 540;
          const end = growing ? 880 : 440;
          playTone(c, base, 0, 0.065, 'sine', 0.08, end);
          playTone(c, base * 2, 0, 0.035, 'triangle', 0.03);
        } else if (mag < 20) {
          // Standard step: warm marimba-like two-note interval
          const f1 = growing ? 440 : 493.88;
          const f2 = growing ? 554.37 : 392.0;
          playTone(c, f1, 0, 0.11, 'triangle', 0.09);
          playTone(c, f2, 0.055, 0.15, 'sine', 0.09);
        } else {
          // Bold jump ("MUCH"): resonant chord + subtle sub-thump
          const root = growing ? 330 : 392;
          const fifth = growing ? 495 : 261.63;
          const octave = growing ? 660 : 196;
          playTone(c, root, 0, 0.22, 'triangle', 0.11, fifth);
          playTone(c, fifth, 0.04, 0.24, 'sine', 0.09);
          playTone(c, octave, 0.07, 0.26, 'sine', 0.07);
        }
      }
    };
  })();

  // --- PCM 16kHz Helpers for Gemini Live API ---
  function downsampleTo16k(float32Buf, inputSampleRate) {
    if (!float32Buf || !float32Buf.length || !(inputSampleRate > 0) || !Number.isFinite(inputSampleRate)) {
      return new Float32Array(0);
    }
    if (inputSampleRate === 16000) {
      return float32Buf;
    }
    const ratio = inputSampleRate / 16000;
    const outLength = Math.max(1, Math.round(float32Buf.length / ratio));
    const result = new Float32Array(outLength);

    // Upsample via linear interpolation when inputSampleRate < 16000 (e.g. 8 kHz Bluetooth HFP)
    if (inputSampleRate < 16000) {
      const lastIdx = float32Buf.length - 1;
      for (let i = 0; i < outLength; i++) {
        const srcPos = i * ratio;
        const idx0 = Math.min(lastIdx, Math.floor(srcPos));
        const idx1 = Math.min(lastIdx, idx0 + 1);
        const frac = srcPos - idx0;
        const v0 = Number.isFinite(float32Buf[idx0]) ? float32Buf[idx0] : 0;
        const v1 = Number.isFinite(float32Buf[idx1]) ? float32Buf[idx1] : 0;
        result[i] = v0 + frac * (v1 - v0);
      }
      return result;
    }

    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < float32Buf.length; i++) {
        const sample = float32Buf[i];
        accum += Number.isFinite(sample) ? sample : 0;
        count++;
      }
      if (count > 0) {
        result[offsetResult] = accum / count;
      } else {
        const fallbackIdx = Math.min(offsetBuffer, float32Buf.length - 1);
        const fallback = float32Buf[fallbackIdx];
        result[offsetResult] = Number.isFinite(fallback) ? fallback : 0;
      }
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }

  function floatTo16BitPCMBase64(float32Buf) {
    if (!float32Buf || !float32Buf.length) return '';
    const buffer = new ArrayBuffer(float32Buf.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Buf.length; i++) {
      const raw = Number.isFinite(float32Buf[i]) ? float32Buf[i] : 0;
      const s = Math.max(-1, Math.min(1, raw));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    if (typeof global.btoa === 'function') {
      return global.btoa(binary);
    }
    if (typeof btoa === 'function') {
      return btoa(binary);
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes).toString('base64');
    }
    return '';
  }

  function normalizeToolArgs(args) {
    const dirRaw = String((args && args.direction) || 'none').toLowerCase();
    const direction = ['bigger', 'smaller', 'reset', 'none'].indexOf(dirRaw) >= 0 ? dirRaw : 'none';
    const rawDelta = Math.round(Number(args && args.delta_percent) || 0);
    const clampedMag = Math.min(40, Math.abs(rawDelta));
    let delta = 0;
    if (direction === 'smaller') delta = -clampedMag;
    else if (direction === 'bigger') delta = clampedMag;

    return {
      transcript: String((args && args.transcript) || '').trim(),
      direction: direction,
      delta_percent: delta,
      emphasized_word: String((args && args.emphasized_word) || '').trim(),
      prosody_note: String((args && args.prosody_note) || '').trim()
    };
  }

  const LIVE_SYSTEM_INSTRUCTION = [
    'You are a real-time vocal prosody controller listening to a continuous audio stream to resize a UI button.',
    'Whenever the user asks to make the button bigger, smaller, larger, tinier, or reset, immediately call the adjust_button_size tool.',
    'Pay close attention to HOW words are spoken: word stress, vowel elongation, pitch, and volume.',
    '- Neutral "a little smaller" -> direction: "smaller", delta_percent: -12.',
    '- Emphasized/elongated "a LIIIITTLE smaller" or "just a TINY bit smaller" -> micro-nudge, delta_percent: -3, emphasized_word: "little" (or the stressed word).',
    '- Emphasized "MUCH smaller" or sharp/loud "smaller!" -> delta_percent: -28.',
    '- Same symmetry for bigger/larger: neutral +12, stressed "liiiittle" +3, "MUCH" +28.',
    '- "reset" / "normal size" -> direction: "reset", delta_percent: 0.',
    'Keep spoken replies minimal or silent; prioritize calling adjust_button_size quickly.'
  ].join(' ');

  function createLiveSession(apiKey, callbacks) {
    const cb = callbacks || {};
    const WS = global.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    const openState = WS && WS.OPEN !== undefined ? WS.OPEN : 1;
    let ws = null;
    let closed = false;
    let setupDone = false;
    let modelIdx = 0;
    let setupTimer = null;

    function clearSetupTimer() {
      if (setupTimer !== null) {
        clearTimeout(setupTimer);
        setupTimer = null;
      }
    }

    function detachSocket(sock) {
      if (!sock) return;
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
    }

    function safeSend(sock, payload) {
      if (!sock || sock !== ws || closed || sock.readyState !== openState) return false;
      try {
        sock.send(payload);
        return true;
      } catch (_e) {
        return false;
      }
    }

    function failOrRetry(sock, reason, fireError) {
      clearSetupTimer();
      detachSocket(sock);
      if (sock) {
        try {
          sock.close();
        } catch (_e) {
          // ignore
        }
      }
      if (!setupDone && modelIdx + 1 < LIVE_MODELS.length) {
        modelIdx += 1;
        connect();
        return;
      }
      closed = true;
      ws = null;
      if (fireError && cb.onError) {
        cb.onError(reason);
      }
      if (cb.onClose) {
        cb.onClose(reason);
      }
    }

    function connect() {
      if (closed) return;
      clearSetupTimer();

      if (typeof WS !== 'function') {
        closed = true;
        Promise.resolve().then(function () {
          if (cb.onError) cb.onError('WebSocket is unavailable in this environment.');
          if (cb.onClose) cb.onClose('WebSocket is unavailable in this environment.');
        });
        return;
      }

      const modelName = LIVE_MODELS[modelIdx] || LIVE_MODELS[0];
      const url = WS_BASE + '?key=' + encodeURIComponent(apiKey);
      let sock = null;
      try {
        sock = new WS(url);
      } catch (_e) {
        failOrRetry(null, 'Failed to open Live WebSocket.', true);
        return;
      }
      ws = sock;

      setupTimer = setTimeout(function () {
        setupTimer = null;
        if (closed || sock !== ws || setupDone) return;
        failOrRetry(sock, 'Live WebSocket setup timed out.', true);
      }, SETUP_TIMEOUT_MS);

      sock.onopen = function () {
        if (closed || sock !== ws) {
          detachSocket(sock);
          try {
            sock.close();
          } catch (_e) {
            // ignore
          }
          return;
        }
        const setupMsg = {
          setup: {
            model: modelName,
            generationConfig: {
              responseModalities: ['AUDIO'],
              temperature: 0.2
            },
            inputAudioTranscription: {},
            systemInstruction: {
              parts: [{ text: LIVE_SYSTEM_INSTRUCTION }]
            },
            tools: [
              {
                functionDeclarations: [
                  {
                    name: 'adjust_button_size',
                    description: 'Adjust the centered UI button size based on spoken command and vocal emphasis/prosody.',
                    parameters: {
                      type: 'OBJECT',
                      properties: {
                        transcript: { type: 'STRING', description: 'Exact phrase spoken by the user' },
                        direction: { type: 'STRING', enum: ['bigger', 'smaller', 'reset'] },
                        delta_percent: { type: 'INTEGER', description: 'Signed percentage delta from -40 to +40' },
                        emphasized_word: { type: 'STRING', description: 'The word with strongest vocal stress, if any' },
                        prosody_note: { type: 'STRING', description: 'Short 4-8 word note on how it was spoken' }
                      },
                      required: ['transcript', 'direction', 'delta_percent', 'emphasized_word', 'prosody_note']
                    }
                  }
                ]
              }
            ]
          }
        };
        if (!safeSend(sock, JSON.stringify(setupMsg))) {
          failOrRetry(sock, 'Failed to send Live WebSocket setup.', true);
        }
      };

      sock.onmessage = function (event) {
        if (closed || sock !== ws) return;

        const handleText = function (rawText) {
          if (closed || sock !== ws || typeof rawText !== 'string') return;
          let msg = null;
          try {
            msg = JSON.parse(rawText);
          } catch (_e) {
            return;
          }
          if (!msg || typeof msg !== 'object') return;
          if (cb.onServerEvent) cb.onServerEvent(msg);
          if (typeof console !== 'undefined' && console.debug) {
            console.debug('[ProsodyLive]', Object.keys(msg), msg);
          }

          if (msg.error && (setupDone || modelIdx + 1 >= LIVE_MODELS.length)) {
            if (cb.onError) {
              cb.onError(String((msg.error && msg.error.message) || 'Live API error.'));
            }
          }

          if (msg.setupComplete && !setupDone) {
            setupDone = true;
            clearSetupTimer();
            if (cb.onReady) cb.onReady(modelName);
          }
          // Live input transcription (final or interim, top-level or inside serverContent)
          const finalTx =
            (msg.inputTranscription && msg.inputTranscription.text) ||
            (msg.serverContent && msg.serverContent.inputTranscription && msg.serverContent.inputTranscription.text);
          const interimTx =
            (msg.interimInputTranscription && msg.interimInputTranscription.text) ||
            (msg.serverContent && msg.serverContent.interimInputTranscription && msg.serverContent.interimInputTranscription.text);
          if (finalTx && cb.onTranscript) {
            cb.onTranscript(String(finalTx), false);
          } else if (interimTx && cb.onTranscript) {
            cb.onTranscript(String(interimTx), true);
          }
          // Live tool calls for button resize
          if (msg.toolCall && Array.isArray(msg.toolCall.functionCalls)) {
            const responses = [];
            msg.toolCall.functionCalls.forEach(function (call) {
              if (call && call.name === 'adjust_button_size') {
                const normalized = normalizeToolArgs(call.args || {});
                if (cb.onResize) cb.onResize(normalized);
                responses.push({
                  id: call.id,
                  name: call.name,
                  response: { output: { ok: true, applied: normalized.delta_percent } }
                });
              }
            });
            if (responses.length) {
              safeSend(sock, JSON.stringify({ toolResponse: { functionResponses: responses } }));
            }
          }
        };

        const data = event && event.data;
        if (typeof data === 'string') {
          handleText(data);
        } else if (data && typeof data.text === 'function') {
          data
            .text()
            .then(function (txt) {
              if (closed || sock !== ws) return;
              handleText(txt);
            })
            .catch(function () {});
        } else if (
          data &&
          (data instanceof ArrayBuffer ||
            ArrayBuffer.isView(data) ||
            Object.prototype.toString.call(data) === '[object ArrayBuffer]')
        ) {
          try {
            const TD = global.TextDecoder || (typeof TextDecoder !== 'undefined' ? TextDecoder : null);
            if (TD) {
              handleText(new TD('utf-8').decode(data));
            } else if (typeof Buffer !== 'undefined') {
              const u8 = ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data);
              handleText(Buffer.from(u8).toString('utf8'));
            }
          } catch (_e) {
            // ignore malformed binary frame
          }
        }
      };

      sock.onerror = function () {
        if (closed || sock !== ws) return;
        if (cb.onError && setupDone) {
          cb.onError('Live WebSocket connection error.');
        }
      };

      sock.onclose = function (ev) {
        if (closed || sock !== ws) return;
        const reason = (ev && ev.reason) || ('Closed (code ' + ((ev && ev.code) || 0) + ')');
        failOrRetry(sock, reason, false);
      };
    }

    connect();

    return {
      sendPCM: function (float32Samples, sampleRate) {
        if (closed || !setupDone || !ws || ws.readyState !== openState) return;
        if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          return;
        }
        const pcm16k = downsampleTo16k(float32Samples, sampleRate);
        if (!pcm16k || !pcm16k.length) return;
        const base64 = floatTo16BitPCMBase64(pcm16k);
        if (!base64) return;
        safeSend(
          ws,
          JSON.stringify({
            realtimeInput: {
              audio: {
                mimeType: 'audio/pcm;rate=16000',
                data: base64
              }
            }
          })
        );
      },
      close: function () {
        closed = true;
        clearSetupTimer();
        if (ws) {
          const sock = ws;
          ws = null;
          detachSocket(sock);
          try {
            sock.close();
          } catch (_e) {
            // ignore
          }
        }
      }
    };
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
    LIVE_MODELS: LIVE_MODELS,
    KeyStore: KeyStore,
    SoundFX: SoundFX,
    DEMO_PRESETS: DEMO_PRESETS,
    downsampleTo16k: downsampleTo16k,
    floatTo16BitPCMBase64: floatTo16BitPCMBase64,
    createLiveSession: createLiveSession
  };
})(window);
