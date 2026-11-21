(function (global) {
  'use strict';

  const NS = (global.GeminiProsody = global.GeminiProsody || {});

  const BASE_WIDTH = 136;
  const BASE_HEIGHT = 44;
  const BASE_FONT = 14;
  const MIN_SCALE = 0.45;
  const MAX_SCALE = 1.85;
  const MAX_MARQUEE_WORDS = 28;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function mount(container) {
    if (!container) return;

    const state = {
      scale: 1.0,
      prevScale: null,
      connecting: false,
      streaming: false,
      liveSession: null,
      mediaStream: null,
      audioCtx: null,
      analyser: null,
      processor: null,
      rafId: null
    };

    container.textContent = '';

    // --- Header ---
    const header = el('div', 'ps-header');
    const titleGroup = el('div', 'ps-title-group');
    titleGroup.appendChild(el('span', 'ps-index', '02'));
    titleGroup.appendChild(el('span', 'ps-title', 'Live Prosody Sizer'));

    const headerActions = el('div', 'ps-header-actions');
    const modeBadge = el('button', 'ps-badge');
    modeBadge.type = 'button';
    modeBadge.setAttribute('aria-expanded', 'false');
    modeBadge.title = 'Configure Gemini API key for continuous Live API audio streaming';
    const badgeDot = el('span', 'ps-badge-dot');
    const badgeLabel = el('span', '', 'SIM · +KEY');
    modeBadge.appendChild(badgeDot);
    modeBadge.appendChild(badgeLabel);

    const sfxBtn = el('button', 'ps-icon-btn', 'SFX On');
    sfxBtn.type = 'button';
    sfxBtn.title = 'Toggle synthesized resize sound effects';

    const resetBtn = el('button', 'ps-icon-btn', 'Reset');
    resetBtn.type = 'button';

    headerActions.appendChild(modeBadge);
    headerActions.appendChild(sfxBtn);
    headerActions.appendChild(resetBtn);
    header.appendChild(titleGroup);
    header.appendChild(headerActions);

    // --- API Key Popover ---
    const keyPanel = el('div', 'ps-key-panel');
    keyPanel.setAttribute('role', 'dialog');
    keyPanel.setAttribute('aria-label', 'Gemini API Key');
    keyPanel.appendChild(el('div', 'ps-key-panel-title', 'Gemini Live API Key'));
    keyPanel.appendChild(
      el(
        'div',
        'ps-key-panel-desc',
        'Streams live 16kHz mic audio over WebSocket to Gemini Live API so vocal stress resizes the button in real time. Shared with Cell 01.'
      )
    );
    const keyInput = el('input', 'ps-key-input');
    keyInput.type = 'password';
    keyInput.placeholder = 'AIza...';
    keyInput.autocomplete = 'off';
    keyInput.setAttribute('aria-label', 'Gemini API key');

    const keyActions = el('div', 'ps-key-actions');
    const keyClearBtn = el('button', 'ps-icon-btn', 'Clear');
    keyClearBtn.type = 'button';
    const keyCloseBtn = el('button', 'ps-icon-btn', 'Close');
    keyCloseBtn.type = 'button';
    const keySaveBtn = el('button', 'ps-btn-primary', 'Save');
    keySaveBtn.type = 'button';

    keyActions.appendChild(keyClearBtn);
    keyActions.appendChild(keyCloseBtn);
    keyActions.appendChild(keySaveBtn);
    keyPanel.appendChild(keyInput);
    keyPanel.appendChild(keyActions);

    // --- Center Stage ---
    const stage = el('div', 'ps-stage');
    const metricsCorner = el('div', 'ps-metrics-corner', '100% · 136×44px');
    const deltaPill = el('div', 'ps-delta-pill', '');

    const buttonWrap = el('div', 'ps-button-wrap');
    const targetBtn = el('button', 'ps-target-btn', 'Confirm');
    targetBtn.type = 'button';
    const ghostBtn = el('div', 'ps-ghost-btn');
    ghostBtn.setAttribute('aria-hidden', 'true');

    buttonWrap.appendChild(targetBtn);
    buttonWrap.appendChild(ghostBtn);

    // Live Word Marquee Ribbon at bottom of stage
    const marqueeWrap = el('div', 'ps-marquee');
    marqueeWrap.setAttribute('aria-live', 'polite');
    const marqueeTrack = el('div', 'ps-marquee-track');
    marqueeTrack.appendChild(el('span', 'ps-marquee-placeholder', 'Detected words stream here…'));
    marqueeWrap.appendChild(marqueeTrack);

    stage.appendChild(metricsCorner);
    stage.appendChild(deltaPill);
    stage.appendChild(buttonWrap);
    stage.appendChild(marqueeWrap);

    // --- Footer ---
    const footer = el('div', 'ps-footer');
    const controlsRow = el('div', 'ps-controls-row');

    const micBtn = el('button', 'ps-mic-btn');
    micBtn.type = 'button';
    const micDot = el('span', 'ps-mic-dot');
    const micLabel = el('span', '', 'Start Live Mic');
    micBtn.appendChild(micDot);
    micBtn.appendChild(micLabel);

    const waveCanvas = el('canvas', 'ps-wave-canvas');
    waveCanvas.setAttribute('aria-hidden', 'true');

    controlsRow.appendChild(micBtn);
    controlsRow.appendChild(waveCanvas);

    const readout = el('div', 'ps-readout');
    const readoutText = el('div', 'ps-readout-text', 'Stream live audio or tap a prosody demo chip.');
    readoutText.setAttribute('role', 'status');
    readoutText.setAttribute('aria-live', 'polite');
    readout.appendChild(readoutText);

    const demosRow = el('div', 'ps-demos');
    NS.Client.DEMO_PRESETS.forEach(function (preset) {
      const chip = el('button', 'ps-demo-chip', preset.label);
      chip.type = 'button';
      chip.addEventListener('click', function () {
        pushMarqueeWords(preset.transcript, preset.emphasized_word);
        applyProsodyResult(preset);
      });
      demosRow.appendChild(chip);
    });

    footer.appendChild(controlsRow);
    footer.appendChild(readout);
    footer.appendChild(demosRow);

    container.appendChild(header);
    container.appendChild(keyPanel);
    container.appendChild(stage);
    container.appendChild(footer);

    // --- Rendering helpers ---
    function syncBadge() {
      const hasKey = Boolean(NS.Client.KeyStore.get());
      modeBadge.classList.toggle('ps-badge--live', hasKey);
      badgeLabel.textContent = hasKey ? 'LIVE' : 'SIM · +KEY';
    }

    function openKeyPanel() {
      keyPanel.classList.add('is-open');
      modeBadge.setAttribute('aria-expanded', 'true');
      keyInput.value = NS.Client.KeyStore.get();
      keyInput.focus();
    }

    function closeKeyPanel(restoreFocus) {
      keyPanel.classList.remove('is-open');
      modeBadge.setAttribute('aria-expanded', 'false');
      if (restoreFocus) modeBadge.focus();
    }

    function pushMarqueeWords(text, emphasizedWord) {
      const words = String(text || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (!words.length) return;

      const placeholder = marqueeTrack.querySelector('.ps-marquee-placeholder');
      if (placeholder) placeholder.remove();

      const empLower = String(emphasizedWord || '').toLowerCase();
      words.forEach(function (word) {
        const clean = word.replace(/[^a-zA-Z0-9']/g, '').toLowerCase();
        const isEmp = Boolean(empLower && clean && (clean === empLower || clean.indexOf(empLower) >= 0));
        const span = el('span', isEmp ? 'ps-marquee-word ps-marquee-word--em' : 'ps-marquee-word', word);
        marqueeTrack.appendChild(span);
      });

      while (marqueeTrack.children.length > MAX_MARQUEE_WORDS) {
        marqueeTrack.removeChild(marqueeTrack.firstChild);
      }

      marqueeWrap.scrollLeft = marqueeWrap.scrollWidth;
    }

    function highlightLastEmphasizedWord(emphasizedWord) {
      if (!emphasizedWord) return;
      const empLower = emphasizedWord.toLowerCase();
      const children = marqueeTrack.children;
      for (let i = children.length - 1; i >= 0; i--) {
        const node = children[i];
        const clean = node.textContent.replace(/[^a-zA-Z0-9']/g, '').toLowerCase();
        if (clean && (clean === empLower || clean.indexOf(empLower) >= 0)) {
          node.classList.add('ps-marquee-word--em');
          break;
        }
      }
    }

    function computeButtonDims(scaleVal) {
      const maxW = stage.clientWidth > 60 ? stage.clientWidth - 24 : 252;
      const maxH = stage.clientHeight > 80 ? stage.clientHeight - 62 : 76;
      const rawW = BASE_WIDTH * scaleVal;
      const rawH = BASE_HEIGHT * scaleVal;
      const fitRatio = Math.min(1, maxW / rawW, maxH / rawH);
      return {
        w: Math.max(56, Math.round(rawW * fitRatio)),
        h: Math.max(22, Math.round(rawH * fitRatio)),
        f: Math.max(9, Math.round(BASE_FONT * Math.pow(scaleVal * fitRatio, 0.72) * 10) / 10)
      };
    }

    function renderButtonSize() {
      const dims = computeButtonDims(state.scale);
      targetBtn.style.width = dims.w + 'px';
      targetBtn.style.height = dims.h + 'px';
      targetBtn.style.fontSize = dims.f + 'px';

      if (state.prevScale !== null && Math.abs(state.prevScale - state.scale) > 0.005) {
        const prevDims = computeButtonDims(state.prevScale);
        ghostBtn.style.width = prevDims.w + 'px';
        ghostBtn.style.height = prevDims.h + 'px';
        ghostBtn.classList.toggle('is-growing', state.prevScale < state.scale);
        ghostBtn.classList.add('is-visible');
      } else {
        ghostBtn.classList.remove('is-visible', 'is-growing');
      }

      metricsCorner.textContent = Math.round(state.scale * 100) + '% · ' + dims.w + '×' + dims.h + 'px';
    }

    function renderReadout(note, isError) {
      readoutText.textContent = note || '';
      readoutText.classList.toggle('is-error', Boolean(isError));
      readoutText.title = readoutText.textContent;
    }

    function syncWaveCanvasSize() {
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      const cw = Math.max(80, waveCanvas.clientWidth || 120);
      const ch = Math.max(24, waveCanvas.clientHeight || 26);
      if (waveCanvas.width !== Math.round(cw * dpr) || waveCanvas.height !== Math.round(ch * dpr)) {
        waveCanvas.width = Math.round(cw * dpr);
        waveCanvas.height = Math.round(ch * dpr);
      }
    }

    function drawIdleWave() {
      syncWaveCanvasSize();
      const ctx = waveCanvas.getContext('2d');
      if (!ctx) return;
      const w = waveCanvas.width;
      const h = waveCanvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = '#e5e5e5';
      ctx.lineWidth = Math.max(1.5, Math.min(2, global.devicePixelRatio || 1));
      ctx.beginPath();
      ctx.moveTo(8, h / 2);
      ctx.lineTo(w - 8, h / 2);
      ctx.stroke();
    }

    function startWaveLoop() {
      syncWaveCanvasSize();
      const ctx = waveCanvas.getContext('2d');
      if (!ctx || !state.analyser) return;
      const buf = new Uint8Array(state.analyser.fftSize);
      const dpr = Math.min(2, global.devicePixelRatio || 1);

      function frame() {
        if (!state.streaming || !state.analyser) return;
        state.analyser.getByteTimeDomainData(buf);
        const w = waveCanvas.width;
        const h = waveCanvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = '#d94f1e';
        ctx.lineWidth = 1.6 * dpr;
        ctx.beginPath();
        const slice = w / buf.length;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          const y = h / 2 + v * (h * 0.44);
          if (i === 0) ctx.moveTo(0, y);
          else ctx.lineTo(i * slice, y);
        }
        ctx.stroke();
        state.rafId = global.requestAnimationFrame(frame);
      }

      state.rafId = global.requestAnimationFrame(frame);
    }

    function applyProsodyResult(res) {
      if (!res) return;
      if (res.emphasized_word) {
        highlightLastEmphasizedWord(res.emphasized_word);
      }
      if (res.direction === 'reset') {
        state.prevScale = state.scale;
        state.scale = 1.0;
        deltaPill.textContent = 'RESET';
        deltaPill.classList.add('is-visible');
        NS.Client.SoundFX.playResize('reset', 0);
      } else if (res.delta_percent !== 0) {
        const nextScale = clamp(state.scale * (1 + res.delta_percent / 100), MIN_SCALE, MAX_SCALE);
        if (Math.abs(nextScale - state.scale) < 0.002) {
          deltaPill.textContent = nextScale >= MAX_SCALE ? 'MAX' : 'MIN';
          deltaPill.classList.add('is-visible');
        } else {
          state.prevScale = state.scale;
          state.scale = nextScale;
          deltaPill.textContent = (res.delta_percent > 0 ? '+' : '') + res.delta_percent + '%';
          deltaPill.classList.add('is-visible');
          NS.Client.SoundFX.playResize(res.direction, res.delta_percent);
        }
      } else {
        state.prevScale = state.scale;
        deltaPill.textContent = '0%';
        deltaPill.classList.add('is-visible');
      }
      renderButtonSize();
      renderReadout(res.prosody_note || 'Applied ' + deltaPill.textContent, false);
    }

    function stopLiveStream(silent) {
      const wasActive = state.streaming || state.connecting;
      state.connecting = false;
      state.streaming = false;

      if (state.rafId) {
        global.cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }
      if (state.liveSession) {
        state.liveSession.close();
        state.liveSession = null;
      }
      if (state.processor) {
        try {
          state.processor.disconnect();
        } catch (_e) {
          // ignore
        }
        state.processor = null;
      }
      if (state.mediaStream) {
        state.mediaStream.getTracks().forEach(function (t) {
          t.stop();
        });
        state.mediaStream = null;
      }
      if (state.audioCtx) {
        try {
          state.audioCtx.close();
        } catch (_e) {
          // ignore
        }
        state.audioCtx = null;
        state.analyser = null;
      }

      micBtn.classList.remove('is-recording', 'is-processing');
      micLabel.textContent = 'Start Live Mic';
      drawIdleWave();
      if (wasActive && !silent) {
        NS.Client.SoundFX.playStreamToggle(false);
      }
    }

    function startLiveStream() {
      if (state.connecting || state.streaming) return;
      syncBadge();
      const apiKey = NS.Client.KeyStore.get();
      if (!apiKey) {
        openKeyPanel();
        renderReadout('Add a Gemini API key for live streaming, or tap a demo chip below.', false);
        return;
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        renderReadout('Microphone capture is unavailable in this browser context.', true);
        return;
      }

      state.connecting = true;
      micBtn.classList.add('is-processing');
      micLabel.textContent = 'Connecting…';
      renderReadout('Opening Gemini Live WebSocket…', false);

      navigator.mediaDevices
        .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        .then(function (stream) {
          if (!state.connecting) {
            stream.getTracks().forEach(function (t) {
              t.stop();
            });
            return;
          }
          state.mediaStream = stream;

          const AudioCtx = global.AudioContext || global.webkitAudioContext;
          state.audioCtx = new AudioCtx();
          if (state.audioCtx.state === 'suspended') {
            state.audioCtx.resume().catch(function () {});
          }

          const source = state.audioCtx.createMediaStreamSource(stream);
          state.analyser = state.audioCtx.createAnalyser();
          state.analyser.fftSize = 256;
          source.connect(state.analyser);

          // Continuous PCM capture node (4096 samples ~85ms at 48kHz) into a silent sink (no speaker echo)
          const processor = state.audioCtx.createScriptProcessor(4096, 1, 1);
          const silentGain = state.audioCtx.createGain();
          silentGain.gain.value = 0;
          state.processor = processor;
          source.connect(processor);
          processor.connect(silentGain);
          silentGain.connect(state.audioCtx.destination);

          state.liveSession = NS.Client.createLiveSession(apiKey, {
            onReady: function (modelName) {
              state.connecting = false;
              state.streaming = true;
              micBtn.classList.remove('is-processing');
              micBtn.classList.add('is-recording');
              micLabel.textContent = 'Live · Click to Stop';
              NS.Client.SoundFX.playStreamToggle(true);
              renderReadout('Live streaming (' + modelName.replace('models/', '') + ') — speak naturally.', false);
              startWaveLoop();
            },
            onTranscript: function (chunk, isInterim) {
              if (isInterim) {
                renderReadout('Hearing: "' + chunk.trim() + '"', false);
              } else {
                pushMarqueeWords(chunk, '');
              }
            },
            onResize: function (res) {
              applyProsodyResult(res);
            },
            onError: function (msg) {
              renderReadout('Live stream error: ' + msg, true);
            },
            onClose: function (reason) {
              const wasStreaming = state.streaming || state.connecting;
              stopLiveStream(true);
              if (wasStreaming) {
                renderReadout('Live session ended: ' + reason, true);
              }
            }
          });

          processor.onaudioprocess = function (ev) {
            if (!state.streaming || !state.liveSession) return;
            const input = ev.inputBuffer.getChannelData(0);
            state.liveSession.sendPCM(input, state.audioCtx.sampleRate);
          };
        })
        .catch(function (err) {
          stopLiveStream(true);
          renderReadout('Mic error: ' + ((err && err.message) || 'check browser permissions.'), true);
        });
    }

    // --- Event Wiring ---
    micBtn.addEventListener('click', function () {
      if (state.streaming || state.connecting) {
        stopLiveStream(false);
        renderReadout('Live stream stopped.', false);
      } else {
        startLiveStream();
      }
    });

    sfxBtn.addEventListener('click', function () {
      const muted = NS.Client.SoundFX.toggleMute();
      sfxBtn.textContent = muted ? 'SFX Off' : 'SFX On';
    });

    resetBtn.addEventListener('click', function () {
      state.prevScale = null;
      state.scale = 1.0;
      deltaPill.classList.remove('is-visible');
      renderButtonSize();
      NS.Client.SoundFX.playResize('reset', 0);
      renderReadout('Reset to 100% (136×44px).', false);
    });

    modeBadge.addEventListener('click', function () {
      if (keyPanel.classList.contains('is-open')) {
        closeKeyPanel(false);
      } else {
        openKeyPanel();
      }
    });

    keyCloseBtn.addEventListener('click', function () {
      closeKeyPanel(true);
    });

    function saveKeyFromInput() {
      NS.Client.KeyStore.set(keyInput.value);
      closeKeyPanel(true);
      syncBadge();
      renderReadout(
        NS.Client.KeyStore.get() ? 'Live Gemini key saved — click Start Live Mic.' : 'Key cleared (Demo mode).',
        false
      );
    }

    keySaveBtn.addEventListener('click', saveKeyFromInput);

    keyInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        saveKeyFromInput();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        closeKeyPanel(true);
      }
    });

    keyPanel.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        closeKeyPanel(true);
      }
    });

    keyClearBtn.addEventListener('click', function () {
      NS.Client.KeyStore.clear();
      keyInput.value = '';
      syncBadge();
    });

    global.addEventListener('focus', syncBadge);
    global.addEventListener('resize', function () {
      renderButtonSize();
      if (!state.streaming) drawIdleWave();
    });

    // Initial render
    syncBadge();
    renderButtonSize();
    drawIdleWave();
  }

  function boot() {
    mount(document.getElementById('cell-prosody'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  NS.UI = { mount: mount };
})(window);
