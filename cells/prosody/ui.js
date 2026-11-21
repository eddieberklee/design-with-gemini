(function (global) {
  'use strict';

  const NS = (global.GeminiProsody = global.GeminiProsody || {});

  const BASE_WIDTH = 136;
  const BASE_HEIGHT = 44;
  const BASE_FONT = 14;
  const MIN_SCALE = 0.45;
  const MAX_SCALE = 1.85;
  const MAX_MARQUEE_WORDS = 28;
  const SPEECH_RESTART_BACKOFF_MS = 250;
  const MAX_SPEECH_RAPID_RESTARTS = 3;
  const FATAL_SPEECH_ERRORS = {
    'not-allowed': true,
    'service-not-allowed': true,
    'audio-capture': true,
    'language-not-supported': true,
    'network': true
  };
  const SESSION_KEY = 'dc_gemini_api_key_session';
  const LOCAL_KEY = 'dc_gemini_api_key_local';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function cleanWord(word) {
    return String(word || '').replace(/[^a-zA-Z0-9']/g, '').toLowerCase();
  }

  // An API key never contains whitespace; a pasted value with an inner space or newline is a paste
  // error and would otherwise be stored and sent verbatim (URL-encoded) in the Live socket URL.
  function keyInputProblem(raw) {
    const cleaned = String(raw || '').trim();
    if (!cleaned) return 'Paste a Gemini API key (AIza…) first. Use Clear to remove the saved key.';
    if (/\s/.test(cleaned)) return 'That key contains spaces or line breaks. Paste the key only.';
    return '';
  }

  const MARQUEE_PLACEHOLDER = 'Detected words stream here…';

  function mount(container) {
    if (!container) return function () {};

    if (typeof container.__prosodyUnmount === 'function') {
      container.__prosodyUnmount();
    }

    let unmounted = false;
    let sessionEpoch = 0;
    let stageObserver = null;

    const state = {
      scale: 1.0,
      prevScale: null,
      connecting: false,
      streaming: false,
      liveSession: null,
      sessionKey: '',
      mediaStream: null,
      audioCtx: null,
      source: null,
      analyser: null,
      processor: null,
      silentGain: null,
      speechRec: null,
      speechRestartTimer: null,
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
    badgeDot.setAttribute('aria-hidden', 'true');
    const badgeLabel = el('span', '', 'SIM · +KEY');
    modeBadge.appendChild(badgeDot);
    modeBadge.appendChild(badgeLabel);

    const initialMuted = Boolean(NS.Client.SoundFX.isMuted && NS.Client.SoundFX.isMuted());
    const sfxBtn = el('button', 'ps-icon-btn', initialMuted ? 'SFX Off' : 'SFX On');
    sfxBtn.type = 'button';
    sfxBtn.setAttribute('aria-pressed', initialMuted ? 'false' : 'true');
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

    const keyNotice = el('div', 'ps-key-notice', '');
    keyNotice.setAttribute('role', 'alert');

    keyActions.appendChild(keyClearBtn);
    keyActions.appendChild(keyCloseBtn);
    keyActions.appendChild(keySaveBtn);
    keyPanel.appendChild(keyInput);
    keyPanel.appendChild(keyNotice);
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
    const marqueeTrack = el('div', 'ps-marquee-track');
    marqueeTrack.appendChild(el('span', 'ps-marquee-placeholder', MARQUEE_PLACEHOLDER));
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
    micBtn.setAttribute('aria-pressed', 'false');
    const micDot = el('span', 'ps-mic-dot');
    micDot.setAttribute('aria-hidden', 'true');
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
    const txRxBadge = el('span', 'ps-tx-rx', '');
    txRxBadge.setAttribute('aria-hidden', 'true');
    readout.appendChild(readoutText);
    readout.appendChild(txRxBadge);

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
    // 'LIVE' only while a Gemini Live session is actually streaming; a saved key alone is 'KEY SET'
    // (the demo chips still simulate until the mic session is up).
    function syncBadge() {
      if (unmounted) return;
      const hasKey = Boolean(NS.Client.KeyStore.get());
      modeBadge.classList.toggle('ps-badge--live', hasKey);
      badgeLabel.textContent = state.streaming ? 'LIVE' : hasKey ? 'KEY SET' : 'SIM · +KEY';
    }

    function setKeyNotice(text) {
      keyNotice.textContent = text || '';
    }

    function openKeyPanel() {
      keyPanel.classList.add('is-open');
      modeBadge.setAttribute('aria-expanded', 'true');
      keyInput.value = NS.Client.KeyStore.get();
      setKeyNotice('');
      if (typeof keyInput.focus === 'function') keyInput.focus();
    }

    function closeKeyPanel(restoreFocus) {
      keyPanel.classList.remove('is-open');
      modeBadge.setAttribute('aria-expanded', 'false');
      setKeyNotice('');
      if (restoreFocus && typeof modeBadge.focus === 'function') modeBadge.focus();
    }

    function pushMarqueeWords(text, emphasizedWord) {
      const words = String(text || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (!words.length) return;

      const placeholder = marqueeTrack.querySelector('.ps-marquee-placeholder');
      if (placeholder) placeholder.remove();

      const empLower = cleanWord(emphasizedWord);
      words.forEach(function (word) {
        const clean = cleanWord(word);
        const isEmp = Boolean(empLower && clean && (clean === empLower || clean.indexOf(empLower) >= 0));
        const span = el('span', isEmp ? 'ps-marquee-word ps-marquee-word--em' : 'ps-marquee-word', word);
        marqueeTrack.appendChild(span);
      });

      while (marqueeTrack.children.length > MAX_MARQUEE_WORDS) {
        marqueeTrack.removeChild(marqueeTrack.firstChild);
      }

      marqueeWrap.scrollLeft = marqueeWrap.scrollWidth;
    }

    function clearMarquee() {
      marqueeTrack.textContent = '';
      marqueeTrack.appendChild(el('span', 'ps-marquee-placeholder', MARQUEE_PLACEHOLDER));
      marqueeWrap.scrollLeft = 0;
    }

    function highlightLastEmphasizedWord(emphasizedWord) {
      const empLower = cleanWord(emphasizedWord);
      if (!empLower) return;
      const children = marqueeTrack.children;
      for (let i = children.length - 1; i >= 0; i--) {
        const node = children[i];
        if (!node.classList.contains('ps-marquee-word')) continue;
        const clean = cleanWord(node.textContent);
        if (clean && (clean === empLower || clean.indexOf(empLower) >= 0)) {
          node.classList.add('ps-marquee-word--em');
          break;
        }
      }
    }

    // Free box inside the stage padding. The padding reserves the metrics corner / delta pill at the
    // top and the marquee at the bottom, and changes with the @container rules in prosody.css.
    function stageInnerBox() {
      const cw = stage.clientWidth;
      const ch = stage.clientHeight;
      if (!(cw > 0) || !(ch > 0)) return null;
      let pad = [28, 12, 34, 12];
      if (typeof global.getComputedStyle === 'function') {
        try {
          const cs = global.getComputedStyle(stage);
          const read = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat);
          if (read.every(Number.isFinite)) pad = read;
        } catch (_e) {
          // keep defaults
        }
      }
      return { w: cw - pad[1] - pad[3], h: ch - pad[0] - pad[2] };
    }

    // One fit ratio for the whole MIN..MAX range: if the 185% button does not fit the stage, every
    // scale shrinks by the same factor, so each step stays visible instead of saturating at the
    // stage edge while the % readout keeps climbing.
    function computeButtonDims(scaleVal) {
      const box = stageInnerBox();
      const rawW = BASE_WIDTH * scaleVal;
      const rawH = BASE_HEIGHT * scaleVal;
      let fit = 1;
      let floorW = 56;
      let floorH = 22;
      if (box) {
        fit = Math.min(1, box.w / (BASE_WIDTH * MAX_SCALE), box.h / (BASE_HEIGHT * MAX_SCALE));
        fit = Math.max(0, fit);
        floorW = Math.max(40, Math.min(56, box.w));
        floorH = Math.max(12, Math.min(22, box.h));
      }
      return {
        w: Math.max(floorW, Math.round(rawW * fit)),
        h: Math.max(floorH, Math.round(rawH * fit)),
        f: Math.max(9, Math.round(BASE_FONT * Math.pow(scaleVal * fit, 0.72) * 10) / 10)
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
      const nextText = note || '';
      if (readoutText.textContent !== nextText) {
        readoutText.textContent = nextText;
      }
      readoutText.classList.toggle('is-error', Boolean(isError));
      readoutText.title = nextText;
    }

    function renderTelemetry(tx, rx) {
      const next = 'TX ' + tx + ' · RX ' + rx;
      if (txRxBadge.textContent !== next) {
        txRxBadge.textContent = next;
      }
    }

    function clearTelemetry() {
      if (txRxBadge.textContent !== '') {
        txRxBadge.textContent = '';
      }
    }

    function formatActiveModel(modelName) {
      const raw = String(modelName || '').replace(/^models\//, '');
      return raw.length > 22
        ? raw.replace(/^gemini-(?:live-)?/, '').replace(/-preview.*$/, '')
        : raw;
    }

    function syncWaveCanvasSize() {
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      const cw = Math.max(48, waveCanvas.clientWidth || 120);
      const ch = Math.max(20, waveCanvas.clientHeight || 26);
      if (waveCanvas.width !== Math.round(cw * dpr) || waveCanvas.height !== Math.round(ch * dpr)) {
        waveCanvas.width = Math.round(cw * dpr);
        waveCanvas.height = Math.round(ch * dpr);
      }
    }

    function drawIdleWave() {
      syncWaveCanvasSize();
      const ctx = typeof waveCanvas.getContext === 'function' ? waveCanvas.getContext('2d') : null;
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
      const ctx = typeof waveCanvas.getContext === 'function' ? waveCanvas.getContext('2d') : null;
      if (!ctx || !state.analyser || typeof global.requestAnimationFrame !== 'function') return;
      const buf = new Uint8Array(state.analyser.fftSize);
      const dpr = Math.min(2, global.devicePixelRatio || 1);

      function frame() {
        if (unmounted || !state.streaming || !state.analyser) return;
        state.analyser.getByteTimeDomainData(buf);
        const w = waveCanvas.width;
        const h = waveCanvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = '#b43a10';
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
      const requested = Number(res.delta_percent);
      const delta = Number.isFinite(requested) ? requested : 0;
      let note = res.prosody_note || '';
      if (res.direction === 'reset') {
        state.prevScale = state.scale;
        state.scale = 1.0;
        deltaPill.textContent = 'RESET';
        NS.Client.SoundFX.playResize('reset', 0);
      } else if (delta !== 0) {
        const nextScale = clamp(state.scale * (1 + delta / 100), MIN_SCALE, MAX_SCALE);
        if (Math.abs(nextScale - state.scale) < 0.002) {
          // Already at a clamp: nothing changed, so no ghost and no claim that the step applied.
          const atMax = delta > 0;
          state.prevScale = state.scale;
          deltaPill.textContent = atMax ? 'MAX' : 'MIN';
          note = (atMax ? 'Already at max size (' : 'Already at min size (') + Math.round(state.scale * 100) + '%).';
        } else {
          // Show the change that was applied, which differs from the request at a clamp.
          const applied = Math.round((nextScale / state.scale - 1) * 100);
          const clamped = Math.abs(applied - delta) >= 1;
          state.prevScale = state.scale;
          state.scale = nextScale;
          deltaPill.textContent = (applied > 0 ? '+' : '') + applied + '%';
          if (clamped) {
            note =
              (note ? note + ' · ' : '') +
              'clamped to ' + (nextScale >= MAX_SCALE ? 'max ' : 'min ') + Math.round(nextScale * 100) + '%';
          }
          NS.Client.SoundFX.playResize(res.direction, applied);
        }
      } else {
        state.prevScale = state.scale;
        deltaPill.textContent = '0%';
      }
      deltaPill.classList.add('is-visible');
      renderButtonSize();
      renderReadout(note || 'Applied ' + deltaPill.textContent, false);
    }

    function stopLocalSpeechMirror() {
      if (state.speechRestartTimer !== null) {
        clearTimeout(state.speechRestartTimer);
        state.speechRestartTimer = null;
      }
      if (state.speechRec) {
        const rec = state.speechRec;
        state.speechRec = null;
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        try {
          if (rec.abort) {
            rec.abort();
          } else if (rec.stop) {
            rec.stop();
          }
        } catch (_e) {
          // ignore
        }
      }
    }

    function stopLiveStream(silent) {
      sessionEpoch += 1;
      const wasActive = state.streaming || state.connecting;
      state.connecting = false;
      state.streaming = false;

      if (state.rafId) {
        if (typeof global.cancelAnimationFrame === 'function') {
          global.cancelAnimationFrame(state.rafId);
        }
        state.rafId = null;
      }
      stopLocalSpeechMirror();
      if (state.liveSession) {
        const sess = state.liveSession;
        state.liveSession = null;
        sess.close();
      }
      if (state.processor) {
        state.processor.onaudioprocess = null;
        try {
          state.processor.disconnect();
        } catch (_e) {
          // ignore
        }
        state.processor = null;
      }
      if (state.silentGain) {
        try {
          state.silentGain.disconnect();
        } catch (_e) {
          // ignore
        }
        state.silentGain = null;
      }
      if (state.source) {
        try {
          state.source.disconnect();
        } catch (_e) {
          // ignore
        }
        state.source = null;
      }
      if (state.analyser) {
        try {
          state.analyser.disconnect();
        } catch (_e) {
          // ignore
        }
        state.analyser = null;
      }
      if (state.mediaStream) {
        const stream = state.mediaStream;
        state.mediaStream = null;
        stream.getTracks().forEach(function (t) {
          t.onended = null;
          try {
            t.stop();
          } catch (_e) {
            // ignore
          }
        });
      }
      if (state.audioCtx) {
        const ctx = state.audioCtx;
        state.audioCtx = null;
        try {
          const p = ctx.close && ctx.close();
          if (p && typeof p.catch === 'function') p.catch(function () {});
        } catch (_e) {
          // ignore
        }
      }

      state.sessionKey = '';
      micBtn.classList.remove('is-recording', 'is-processing');
      micBtn.setAttribute('aria-pressed', 'false');
      micLabel.textContent = 'Start Live Mic';
      if (!unmounted) {
        clearTelemetry();
        drawIdleWave();
        syncBadge();
      }
      if (wasActive && !silent && !unmounted) {
        NS.Client.SoundFX.playStreamToggle(false);
      }
    }

    function startLiveStream() {
      if (unmounted || state.connecting || state.streaming) return;
      syncBadge();
      const apiKey = NS.Client.KeyStore.get();
      if (!apiKey) {
        openKeyPanel();
        renderReadout('Add a Gemini API key for live streaming, or tap a demo chip below.', false);
        return;
      }

      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        renderReadout('Microphone capture is unavailable in this browser context.', true);
        return;
      }

      const AudioCtxInit = global.AudioContext || global.webkitAudioContext;
      if (typeof AudioCtxInit !== 'function') {
        renderReadout('Web Audio API is unavailable in this browser context.', true);
        return;
      }

      const myEpoch = ++sessionEpoch;
      state.connecting = true;
      state.sessionKey = apiKey;
      clearTelemetry();
      micBtn.classList.add('is-processing');
      micBtn.setAttribute('aria-pressed', 'true');
      micLabel.textContent = 'Connecting…';
      renderReadout('Requesting microphone access…', false);

      navigator.mediaDevices
        .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        .then(function (stream) {
          if (unmounted || myEpoch !== sessionEpoch || !state.connecting) {
            stream.getTracks().forEach(function (t) {
              try {
                t.stop();
              } catch (_e) {
                // ignore
              }
            });
            return;
          }
          state.mediaStream = stream;
          stream.getTracks().forEach(function (track) {
            track.onended = function () {
              if (unmounted || myEpoch !== sessionEpoch) return;
              const wasStreaming = state.streaming || state.connecting;
              stopLiveStream(true);
              if (wasStreaming) {
                renderReadout('Microphone disconnected.', true);
              }
            };
          });

          renderReadout('Opening Gemini Live WebSocket…', false);
          state.audioCtx = new AudioCtxInit();
          if (state.audioCtx.state === 'suspended' && typeof state.audioCtx.resume === 'function') {
            const p = state.audioCtx.resume();
            if (p && typeof p.catch === 'function') p.catch(function () {});
          }

          const source = state.audioCtx.createMediaStreamSource(stream);
          state.source = source;
          state.analyser = state.audioCtx.createAnalyser();
          state.analyser.fftSize = 256;
          source.connect(state.analyser);

          // Continuous PCM capture node (4096 samples ~85ms at 48kHz) into a silent sink (no speaker echo)
          const processor = state.audioCtx.createScriptProcessor(4096, 1, 1);
          const silentGain = state.audioCtx.createGain();
          silentGain.gain.value = 0;
          state.processor = processor;
          state.silentGain = silentGain;
          source.connect(processor);
          processor.connect(silentGain);
          silentGain.connect(state.audioCtx.destination);

          let hasGeminiTx = false;
          let txCount = 0;
          let rxCount = 0;
          let activeModel = '';
          let lastActivityAt = 0;

          function startLocalSpeechMirror() {
            stopLocalSpeechMirror();
            const SpeechRec = global.SpeechRecognition || global.webkitSpeechRecognition;
            if (typeof SpeechRec !== 'function') return;
            let restartsWithoutResult = 0;
            try {
              const rec = new SpeechRec();
              rec.continuous = true;
              rec.interimResults = true;
              rec.lang = 'en-US';
              rec.onresult = function (ev) {
                if (unmounted || myEpoch !== sessionEpoch || !state.streaming || hasGeminiTx) return;
                restartsWithoutResult = 0;
                let interim = '';
                for (let i = ev.resultIndex; i < ev.results.length; i++) {
                  const res = ev.results[i];
                  const text = res && res[0] ? String(res[0].transcript || '').trim() : '';
                  if (!text) continue;
                  if (res.isFinal) {
                    lastActivityAt = Date.now();
                    pushMarqueeWords(text, '');
                  } else {
                    interim += (interim ? ' ' : '') + text;
                  }
                }
                if (interim && !readoutText.classList.contains('is-error')) {
                  lastActivityAt = Date.now();
                  renderReadout('Hearing: "' + interim + '"', false);
                }
              };
              rec.onerror = function (ev) {
                const code = typeof ev === 'string' ? ev : String((ev && ev.error) || '');
                if (FATAL_SPEECH_ERRORS[code]) {
                  stopLocalSpeechMirror();
                }
              };
              rec.onend = function () {
                if (unmounted || myEpoch !== sessionEpoch || !state.streaming || hasGeminiTx || state.speechRec !== rec) {
                  return;
                }
                if (restartsWithoutResult >= MAX_SPEECH_RAPID_RESTARTS) {
                  stopLocalSpeechMirror();
                  return;
                }
                restartsWithoutResult += 1;
                if (state.speechRestartTimer !== null) {
                  clearTimeout(state.speechRestartTimer);
                }
                state.speechRestartTimer = setTimeout(function () {
                  state.speechRestartTimer = null;
                  if (unmounted || myEpoch !== sessionEpoch || !state.streaming || hasGeminiTx || state.speechRec !== rec) {
                    return;
                  }
                  try {
                    rec.start();
                  } catch (_e) {
                    stopLocalSpeechMirror();
                  }
                }, SPEECH_RESTART_BACKOFF_MS);
              };
              state.speechRec = rec;
              try {
                rec.start();
              } catch (_e) {
                stopLocalSpeechMirror();
              }
            } catch (_e) {
              stopLocalSpeechMirror();
            }
          }

          const session = NS.Client.createLiveSession(apiKey, {
            onReady: function (modelName) {
              if (unmounted || myEpoch !== sessionEpoch) return;
              state.connecting = false;
              state.streaming = true;
              activeModel = formatActiveModel(modelName);
              lastActivityAt = Date.now();
              micBtn.classList.remove('is-processing');
              micBtn.classList.add('is-recording');
              micBtn.setAttribute('aria-pressed', 'true');
              micLabel.textContent = 'Live · Click to Stop';
              syncBadge();
              NS.Client.SoundFX.playStreamToggle(true);
              renderTelemetry(txCount, rxCount);
              renderReadout('Live (' + activeModel + ') — speak naturally.', false);
              startWaveLoop();
              startLocalSpeechMirror();
            },
            onServerEvent: function () {
              if (unmounted || myEpoch !== sessionEpoch) return;
              rxCount += 1;
              if (state.streaming) {
                renderTelemetry(txCount, rxCount);
              }
            },
            onTranscript: function (chunk, isInterim) {
              if (unmounted || myEpoch !== sessionEpoch) return;
              if (!hasGeminiTx) {
                hasGeminiTx = true;
              }
              stopLocalSpeechMirror();
              lastActivityAt = Date.now();
              if (isInterim) {
                renderReadout('Hearing: "' + chunk.trim() + '"', false);
              } else {
                pushMarqueeWords(chunk, '');
              }
            },
            onResize: function (res) {
              if (unmounted || myEpoch !== sessionEpoch) return;
              lastActivityAt = Date.now();
              if (res && res.transcript && !hasGeminiTx && !state.speechRec) {
                pushMarqueeWords(res.transcript, res.emphasized_word);
              }
              applyProsodyResult(res);
            },
            onError: function (msg) {
              if (unmounted || myEpoch !== sessionEpoch) return;
              lastActivityAt = Date.now();
              renderReadout('Live stream error: ' + msg, true);
            },
            onClose: function (reason) {
              if (unmounted || myEpoch !== sessionEpoch) return;
              const wasStreaming = state.streaming || state.connecting;
              stopLiveStream(true);
              if (wasStreaming) {
                renderReadout('Live session ended: ' + reason, true);
              }
            }
          });
          // createLiveSession can fail synchronously (WebSocket constructor throws on both models),
          // which already ran onClose -> stopLiveStream and bumped the epoch: do not store a dead
          // session or arm the processor for a session that no longer exists.
          if (unmounted || myEpoch !== sessionEpoch) {
            session.close();
            return;
          }
          state.liveSession = session;

          processor.onaudioprocess = function (ev) {
            if (unmounted || myEpoch !== sessionEpoch || !state.streaming || !state.liveSession || !state.audioCtx) {
              return;
            }
            const input = ev.inputBuffer.getChannelData(0);
            if (state.liveSession.sendPCM(input, state.audioCtx.sampleRate)) {
              txCount += 1;
              if (txCount === 1 || txCount % 15 === 0) {
                renderTelemetry(txCount, rxCount);
                if (
                  Date.now() - lastActivityAt > 3500 &&
                  !readoutText.classList.contains('is-error')
                ) {
                  renderReadout('Live (' + activeModel + ') — listening…', false);
                }
              }
            }
          };
        })
        .catch(function (err) {
          if (unmounted || myEpoch !== sessionEpoch) return;
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
      sfxBtn.setAttribute('aria-pressed', muted ? 'false' : 'true');
    });

    resetBtn.addEventListener('click', function () {
      state.prevScale = null;
      state.scale = 1.0;
      deltaPill.classList.remove('is-visible');
      deltaPill.textContent = '';
      clearMarquee();
      renderButtonSize();
      NS.Client.SoundFX.playResize('reset', 0);
      const dims = computeButtonDims(1.0);
      renderReadout('Reset to 100% (' + dims.w + '×' + dims.h + 'px).', false);
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
      const problem = keyInputProblem(keyInput.value);
      if (problem) {
        setKeyNotice(problem);
        if (typeof keyInput.focus === 'function') keyInput.focus();
        return;
      }
      // Keep a key that another cell stored as "remember on this device" in localStorage.
      const keepLocal = NS.Client.KeyStore.getStorageType() === 'local';
      NS.Client.KeyStore.set(keyInput.value, keepLocal);
      closeKeyPanel(true);
      syncBadge();
      renderReadout('Gemini key saved — click Start Live Mic to stream.', false);
    }

    keySaveBtn.addEventListener('click', saveKeyFromInput);

    // Escape is handled once by the panel listener below (keydown bubbles from the input).
    keyInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        saveKeyFromInput();
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
      setKeyNotice('');
      syncBadge();
      renderReadout('Key cleared — demo chips only.', false);
    });

    // Fired by this cell, api-matrix, decisions (gemini-key-changed), other tabs (storage) and
    // window focus. An open session compares against the key it started with, so repeated events
    // for the same key are no-ops.
    function onKeySync() {
      if (unmounted) return;
      if ((state.streaming || state.connecting) && NS.Client.KeyStore.get() !== state.sessionKey) {
        stopLiveStream(false);
        renderReadout('Gemini key changed or removed — live stream stopped.', false);
      }
      syncBadge();
    }

    function onStorageSync(ev) {
      if (!ev || !ev.key || ev.key === SESSION_KEY || ev.key === LOCAL_KEY) {
        onKeySync();
      }
    }

    function onStageResize() {
      if (unmounted) return;
      renderButtonSize();
      if (state.streaming) {
        syncWaveCanvasSize();
      } else {
        drawIdleWave();
      }
    }

    function onPageHide() {
      stopLiveStream(true);
    }

    // Mic capture + socket stop while the tab is hidden; the user restarts explicitly (no silent
    // reconnect or background mic re-acquire).
    function onVisibilityChange() {
      if (unmounted || document.visibilityState !== 'hidden') return;
      if (state.streaming || state.connecting) {
        stopLiveStream(true);
        renderReadout('Live stream stopped while the tab was hidden — click Start Live Mic to resume.', false);
      }
    }

    const useResizeObserver = typeof global.ResizeObserver === 'function';
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('focus', onKeySync);
      global.addEventListener('gemini-key-changed', onKeySync);
      global.addEventListener('storage', onStorageSync);
      global.addEventListener('pagehide', onPageHide);
      global.addEventListener('resize', onStageResize);
    }
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    if (useResizeObserver) {
      stageObserver = new global.ResizeObserver(onStageResize);
      stageObserver.observe(stage);
    }

    function unmount() {
      if (unmounted) return;
      unmounted = true;
      stopLiveStream(true);
      if (NS.Client.SoundFX && typeof NS.Client.SoundFX.close === 'function') {
        NS.Client.SoundFX.close();
      }
      if (stageObserver) {
        stageObserver.disconnect();
        stageObserver = null;
      }
      if (typeof global.removeEventListener === 'function') {
        global.removeEventListener('focus', onKeySync);
        global.removeEventListener('gemini-key-changed', onKeySync);
        global.removeEventListener('storage', onStorageSync);
        global.removeEventListener('resize', onStageResize);
        global.removeEventListener('pagehide', onPageHide);
      }
      if (typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (container.__prosodyUnmount === unmount) {
        delete container.__prosodyUnmount;
      }
      container.textContent = '';
    }

    container.__prosodyUnmount = unmount;

    // Initial render
    syncBadge();
    renderButtonSize();
    drawIdleWave();

    return unmount;
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
