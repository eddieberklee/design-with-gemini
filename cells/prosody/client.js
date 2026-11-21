(function (global) {
  'use strict';

  const NS = (global.GeminiProsody = global.GeminiProsody || {});

  const LIVE_MODELS = [
    'models/gemini-3.8-live',
    'models/gemini-live-2.5-flash-native-audio'
  ];
  const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

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

  // --- Synthesized Tactile Web Audio Sound Feedback ---
  const SoundFX = (function () {
    let ctx = null;
    let muted = false;

    function getCtx() {
      if (muted) return null;
      const AudioCtx = global.AudioContext || global.webkitAudioContext;
      if (!AudioCtx) return null;
      if (!ctx) ctx = new AudioCtx();
      if (ctx.state === 'suspended') {
        ctx.resume().catch(function () {});
      }
      return ctx;
    }

    function playTone(audioCtx, freq, startOffset, duration, type, peakGain, endFreq) {
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
    }

    return {
      isMuted: function () {
        return muted;
      },
      toggleMute: function () {
        muted = !muted;
        return muted;
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
    if (inputSampleRate === 16000) {
      return float32Buf;
    }
    const ratio = inputSampleRate / 16000;
    const outLength = Math.max(1, Math.round(float32Buf.length / ratio));
    const result = new Float32Array(outLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < float32Buf.length; i++) {
        accum += float32Buf[i];
        count++;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }

  function floatTo16BitPCMBase64(float32Buf) {
    const buffer = new ArrayBuffer(float32Buf.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < float32Buf.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Buf[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return global.btoa(binary);
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
      direction: direction,
      delta_percent: delta,
      emphasized_word: String((args && args.emphasized_word) || '').trim(),
      prosody_note: String((args && args.prosody_note) || '').trim()
    };
  }

  const LIVE_SYSTEM_INSTRUCTION = [
    'You are a real-time vocal prosody controller listening to a continuous audio stream to resize a UI button.',
    'Do NOT speak back or converse. ONLY call the adjust_button_size tool whenever the user asks to make the button bigger, smaller, or reset.',
    'Pay close attention to HOW words are spoken: word stress, vowel elongation, pitch, and volume.',
    '- Neutral "a little smaller" -> direction: "smaller", delta_percent: -12.',
    '- Emphasized/elongated "a LIIIITTLE smaller" or "just a TINY bit smaller" -> micro-nudge, delta_percent: -3, emphasized_word: "little" (or the stressed word).',
    '- Emphasized "MUCH smaller" or sharp/loud "smaller!" -> delta_percent: -28.',
    '- Same symmetry for bigger/larger: neutral +12, stressed "liiiittle" +3, "MUCH" +28.',
    '- "reset" / "normal size" -> direction: "reset", delta_percent: 0.',
    'React quickly as soon as a sizing phrase is heard.'
  ].join(' ');

  function createLiveSession(apiKey, callbacks) {
    const cb = callbacks || {};
    let ws = null;
    let closed = false;
    let setupDone = false;
    let modelIdx = 0;

    function connect() {
      if (closed) return;
      const modelName = LIVE_MODELS[modelIdx] || LIVE_MODELS[0];
      const url = WS_BASE + '?key=' + encodeURIComponent(apiKey);
      ws = new WebSocket(url);

      ws.onopen = function () {
        if (closed) {
          ws.close();
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
                        direction: { type: 'STRING', enum: ['bigger', 'smaller', 'reset'] },
                        delta_percent: { type: 'INTEGER', description: 'Signed percentage delta from -40 to +40' },
                        emphasized_word: { type: 'STRING', description: 'The word with strongest vocal stress, if any' },
                        prosody_note: { type: 'STRING', description: 'Short 4-8 word note on how it was spoken' }
                      },
                      required: ['direction', 'delta_percent', 'emphasized_word', 'prosody_note']
                    }
                  }
                ]
              }
            ]
          }
        };
        ws.send(JSON.stringify(setupMsg));
      };

      ws.onmessage = function (event) {
        if (closed) return;
        const handleText = function (rawText) {
          let msg = null;
          try {
            msg = JSON.parse(rawText);
          } catch (_e) {
            return;
          }
          if (msg.setupComplete) {
            setupDone = true;
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
            if (responses.length && ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
            }
          }
        };

        if (event.data instanceof Blob) {
          event.data.text().then(handleText).catch(function () {});
        } else if (typeof event.data === 'string') {
          handleText(event.data);
        }
      };

      ws.onerror = function () {
        if (!closed && cb.onError && setupDone) {
          cb.onError('Live WebSocket connection error.');
        }
      };

      ws.onclose = function (ev) {
        if (closed) return;
        // If server rejected the first model before setupComplete, try fallback model
        if (!setupDone && modelIdx + 1 < LIVE_MODELS.length) {
          modelIdx += 1;
          connect();
          return;
        }
        closed = true;
        if (cb.onClose) {
          cb.onClose(ev.reason || ('Closed (code ' + ev.code + ')'));
        }
      };
    }

    connect();

    return {
      sendPCM: function (float32Samples, sampleRate) {
        if (closed || !setupDone || !ws || ws.readyState !== WebSocket.OPEN) return;
        const pcm16k = downsampleTo16k(float32Samples, sampleRate);
        const base64 = floatTo16BitPCMBase64(pcm16k);
        ws.send(
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
        if (ws) {
          try {
            ws.close();
          } catch (_e) {
            // ignore
          }
          ws = null;
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
    createLiveSession: createLiveSession
  };
})(window);
