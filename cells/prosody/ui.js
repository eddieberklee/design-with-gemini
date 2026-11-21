(function (global) {
  'use strict';

  const NS = (global.GeminiProsody = global.GeminiProsody || {});

  const BASE_WIDTH = 136;
  const BASE_HEIGHT = 44;
  const BASE_FONT = 14;
  const MIN_SCALE = 0.45;
  const MAX_SCALE = 1.85;
  const HOLD_THRESHOLD_MS = 300;
  const MAX_RECORD_MS = 15000;

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
      requestingMic: false,
      recording: false,
      processing: false,
      pointerDownAt: 0,
      startedByPointerDown: false,
      recordCapTimer: null,
      mediaRecorder: null,
      mediaStream: null,
      audioChunks: [],
      audioCtx: null,
      analyser: null,
      rafId: null,
      abortController: null
    };

    container.textContent = '';

    // --- Header ---
    const header = el('div', 'ps-header');
    const titleGroup = el('div', 'ps-title-group');
    titleGroup.appendChild(el('span', 'ps-index', '02'));
    titleGroup.appendChild(el('span', 'ps-title', 'Voice Prosody Sizer'));

    const headerActions = el('div', 'ps-header-actions');
    const modeBadge = el('button', 'ps-badge');
    modeBadge.type = 'button';
    modeBadge.setAttribute('aria-expanded', 'false');
    modeBadge.title = 'Configure Gemini API key for live native audio prosody';
    const badgeDot = el('span', 'ps-badge-dot');
    const badgeLabel = el('span', '', '+ KEY');
    modeBadge.appendChild(badgeDot);
    modeBadge.appendChild(badgeLabel);

    const resetBtn = el('button', 'ps-icon-btn', 'Reset');
    resetBtn.type = 'button';

    headerActions.appendChild(modeBadge);
    headerActions.appendChild(resetBtn);
    header.appendChild(titleGroup);
    header.appendChild(headerActions);

    // --- API Key Popover ---
    const keyPanel = el('div', 'ps-key-panel');
    keyPanel.setAttribute('role', 'dialog');
    keyPanel.setAttribute('aria-label', 'Gemini API Key');
    keyPanel.appendChild(el('div', 'ps-key-panel-title', 'Gemini API Key (Native Audio)'));
    keyPanel.appendChild(
      el(
        'div',
        'ps-key-panel-desc',
        'Sends raw mic audio to gemini-2.5-flash so vocal stress & elongation map to button size. Saved to sessionStorage (shared with Cell 01).'
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
    stage.appendChild(metricsCorner);
    stage.appendChild(deltaPill);
    stage.appendChild(buttonWrap);

    // --- Footer ---
    const footer = el('div', 'ps-footer');
    const controlsRow = el('div', 'ps-controls-row');

    const micBtn = el('button', 'ps-mic-btn');
    micBtn.type = 'button';
    const micDot = el('span', 'ps-mic-dot');
    const micLabel = el('span', '', 'Hold or Click to Speak');
    micBtn.appendChild(micDot);
    micBtn.appendChild(micLabel);

    const waveCanvas = el('canvas', 'ps-wave-canvas');
    waveCanvas.setAttribute('aria-hidden', 'true');

    controlsRow.appendChild(micBtn);
    controlsRow.appendChild(waveCanvas);

    const readout = el('div', 'ps-readout');
    const readoutText = el('div', 'ps-readout-text', 'Try stressing "liiiittle" vs. saying it flat.');
    readoutText.setAttribute('role', 'status');
    readoutText.setAttribute('aria-live', 'polite');
    readout.appendChild(readoutText);

    const demosRow = el('div', 'ps-demos');
    NS.Client.DEMO_PRESETS.forEach(function (preset) {
      const chip = el('button', 'ps-demo-chip', preset.label);
      chip.type = 'button';
      chip.addEventListener('click', function () {
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

    function computeButtonDims(scaleVal) {
      const maxW = stage.clientWidth > 60 ? stage.clientWidth - 24 : 252;
      const maxH = stage.clientHeight > 60 ? stage.clientHeight - 38 : 82;
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

    function renderReadout(transcript, emphasizedWord, note, isError) {
      readoutText.textContent = '';
      readoutText.classList.toggle('is-error', Boolean(isError));
      if (transcript) {
        readoutText.appendChild(document.createTextNode('"'));
        if (emphasizedWord) {
          const lower = transcript.toLowerCase();
          const target = emphasizedWord.toLowerCase();
          const idx = lower.indexOf(target);
          if (idx >= 0) {
            readoutText.appendChild(document.createTextNode(transcript.slice(0, idx)));
            readoutText.appendChild(el('span', 'ps-emphasis', transcript.slice(idx, idx + emphasizedWord.length)));
            readoutText.appendChild(document.createTextNode(transcript.slice(idx + emphasizedWord.length)));
          } else {
            readoutText.appendChild(document.createTextNode(transcript));
          }
        } else {
          readoutText.appendChild(document.createTextNode(transcript));
        }
        readoutText.appendChild(document.createTextNode('"'));
        if (note) {
          readoutText.appendChild(document.createTextNode(' · ' + note));
        }
      } else if (note) {
        readoutText.textContent = note;
      }
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
        if (!state.recording || !state.analyser) return;
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
      if (res.direction === 'reset') {
        state.prevScale = state.scale;
        state.scale = 1.0;
        deltaPill.textContent = 'RESET';
        deltaPill.classList.add('is-visible');
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
        }
      } else {
        state.prevScale = state.scale;
        deltaPill.textContent = '0%';
        deltaPill.classList.add('is-visible');
      }
      renderButtonSize();
      renderReadout(res.transcript, res.emphasized_word, res.prosody_note, false);
    }

    function stopMediaTracks() {
      if (state.recordCapTimer) {
        clearTimeout(state.recordCapTimer);
        state.recordCapTimer = null;
      }
      if (state.rafId) {
        global.cancelAnimationFrame(state.rafId);
        state.rafId = null;
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
      state.recording = false;
      state.mediaRecorder = null;
      micBtn.classList.remove('is-recording');
      drawIdleWave();
    }

    function startRecording() {
      if (state.requestingMic || state.recording || state.processing) return;
      syncBadge();
      const apiKey = NS.Client.KeyStore.get();
      if (!apiKey) {
        openKeyPanel();
        renderReadout('', '', 'Add a Gemini API key for live mic prosody, or tap a demo chip below.', false);
        return;
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        renderReadout('', '', 'Microphone capture is unavailable in this browser context.', true);
        return;
      }

      state.requestingMic = true;
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then(function (stream) {
          state.requestingMic = false;
          state.mediaStream = stream;
          state.audioChunks = [];

          const mime =
            global.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm')
              ? 'audio/webm'
              : global.MediaRecorder && MediaRecorder.isTypeSupported('audio/mp4')
              ? 'audio/mp4'
              : '';

          const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
          state.mediaRecorder = recorder;

          recorder.ondataavailable = function (ev) {
            if (ev.data && ev.data.size > 0) state.audioChunks.push(ev.data);
          };

          recorder.onstop = function () {
            const blob = new Blob(state.audioChunks, { type: recorder.mimeType || 'audio/webm' });
            stopMediaTracks();
            processRecordedAudio(blob);
          };

          recorder.start();
          state.recording = true;

          const AudioCtx = global.AudioContext || global.webkitAudioContext;
          if (AudioCtx) {
            state.audioCtx = new AudioCtx();
            if (state.audioCtx.state === 'suspended') {
              state.audioCtx.resume().catch(function () {});
            }
            const source = state.audioCtx.createMediaStreamSource(stream);
            state.analyser = state.audioCtx.createAnalyser();
            state.analyser.fftSize = 256;
            source.connect(state.analyser);
            startWaveLoop();
          }

          state.recordCapTimer = setTimeout(function () {
            stopRecording();
          }, MAX_RECORD_MS);

          micBtn.classList.add('is-recording');
          micLabel.textContent = 'Listening… Release or Click';
          renderReadout('', '', 'Speak naturally — try stressing "liiiittle" or "MUCH".', false);
        })
        .catch(function (err) {
          state.requestingMic = false;
          stopMediaTracks();
          micLabel.textContent = 'Hold or Click to Speak';
          renderReadout('', '', 'Mic error: ' + ((err && err.message) || 'check browser permissions.'), true);
        });
    }

    function stopRecording() {
      if (!state.recording) return;
      state.recording = false;
      micBtn.classList.remove('is-recording');
      if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
        state.mediaRecorder.stop();
      } else {
        stopMediaTracks();
      }
    }

    function cancelProcessing() {
      if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
      }
      state.processing = false;
      micBtn.classList.remove('is-processing');
      micLabel.textContent = 'Hold or Click to Speak';
    }

    function processRecordedAudio(blob) {
      if (!blob || blob.size < 400) {
        renderReadout('', '', 'Recording too short — speak a phrase and stop.', true);
        micLabel.textContent = 'Hold or Click to Speak';
        return;
      }

      if (state.abortController) state.abortController.abort();
      const controller = new AbortController();
      state.abortController = controller;
      state.processing = true;
      micBtn.classList.add('is-processing');
      micLabel.textContent = 'Analyzing… (Click to Cancel)';

      NS.Client.analyzeAudioLive(blob, NS.Client.KeyStore.get(), controller.signal)
        .then(function (res) {
          if (state.abortController !== controller) return;
          applyProsodyResult(res);
        })
        .catch(function (err) {
          if (state.abortController !== controller) return;
          if (err && err.name === 'AbortError') return;
          renderReadout('', '', 'Gemini audio error: ' + ((err && err.message) || 'request failed'), true);
        })
        .finally(function () {
          if (state.abortController !== controller) return;
          state.abortController = null;
          state.processing = false;
          micBtn.classList.remove('is-processing');
          micLabel.textContent = 'Hold or Click to Speak';
        });
    }

    // --- Event Wiring ---
    // Support both Press-and-Hold (>=300ms) and Click-to-Toggle.
    micBtn.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      if (state.processing) {
        cancelProcessing();
        renderReadout('', '', 'Canceled audio analysis.', false);
        return;
      }
      if (!state.recording && !state.requestingMic) {
        state.pointerDownAt = Date.now();
        state.startedByPointerDown = true;
        startRecording();
      } else {
        state.startedByPointerDown = false;
      }
    });

    micBtn.addEventListener('pointerup', function () {
      if (state.startedByPointerDown && state.recording) {
        const heldMs = Date.now() - state.pointerDownAt;
        if (heldMs >= HOLD_THRESHOLD_MS) {
          stopRecording();
        }
      }
      state.startedByPointerDown = false;
    });

    micBtn.addEventListener('pointercancel', function () {
      state.startedByPointerDown = false;
    });

    micBtn.addEventListener('click', function (ev) {
      // Ignore synthetic click immediately after pointerdown started recording
      if (ev.detail > 0 && state.pointerDownAt && Date.now() - state.pointerDownAt < HOLD_THRESHOLD_MS && state.recording) {
        return;
      }
      if (state.processing) {
        cancelProcessing();
        renderReadout('', '', 'Canceled audio analysis.', false);
        return;
      }
      if (state.recording) stopRecording();
      else startRecording();
    });

    resetBtn.addEventListener('click', function () {
      cancelProcessing();
      if (state.recording) stopRecording();
      state.prevScale = null;
      state.scale = 1.0;
      deltaPill.classList.remove('is-visible');
      renderButtonSize();
      renderReadout('', '', 'Reset to 100% (136×44px).', false);
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
        '',
        '',
        NS.Client.KeyStore.get() ? 'Live Gemini audio ready — hold or click mic to speak.' : 'Key cleared (Demo mode).',
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
      if (!state.recording) drawIdleWave();
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
