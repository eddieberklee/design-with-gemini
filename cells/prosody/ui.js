(function (global) {
  'use strict';

  const NS = (global.GeminiProsody = global.GeminiProsody || {});

  const BASE_WIDTH = 136;
  const BASE_HEIGHT = 44;
  const BASE_FONT = 14;
  const MIN_SCALE = 0.45;
  const MAX_SCALE = 1.85;

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
      recording: false,
      processing: false,
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
    modeBadge.title = 'Configure Gemini API key for live native audio prosody';
    const badgeDot = el('span', 'ps-badge-dot');
    const badgeLabel = el('span', '', 'DEMO');
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
    keyPanel.appendChild(el('div', 'ps-key-panel-title', 'Gemini API Key (Native Audio)'));
    keyPanel.appendChild(
      el(
        'div',
        'ps-key-panel-desc',
        'Sends raw mic audio to gemini-2.5-flash so vocal stress & elongation map to button size. Stored in sessionStorage only.'
      )
    );
    const keyInput = el('input', 'ps-key-input');
    keyInput.type = 'password';
    keyInput.placeholder = 'AIza...';
    keyInput.autocomplete = 'off';

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
    const ghostBtn = el('div', 'ps-ghost-btn');
    const targetBtn = el('button', 'ps-target-btn', 'Confirm');
    targetBtn.type = 'button';

    buttonWrap.appendChild(ghostBtn);
    buttonWrap.appendChild(targetBtn);
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
    waveCanvas.width = 240;
    waveCanvas.height = 52;

    controlsRow.appendChild(micBtn);
    controlsRow.appendChild(waveCanvas);

    const readout = el('div', 'ps-readout');
    const readoutText = el('div', 'ps-readout-text', 'Try stressing "liiiittle" vs. saying it flat.');
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
      badgeLabel.textContent = hasKey ? 'LIVE' : '+ KEY';
    }

    function renderButtonSize() {
      const w = Math.round(BASE_WIDTH * state.scale);
      const h = Math.round(BASE_HEIGHT * state.scale);
      const f = Math.max(9, Math.round(BASE_FONT * Math.pow(state.scale, 0.72) * 10) / 10);

      targetBtn.style.width = w + 'px';
      targetBtn.style.height = h + 'px';
      targetBtn.style.fontSize = f + 'px';

      if (state.prevScale !== null && Math.abs(state.prevScale - state.scale) > 0.005) {
        ghostBtn.style.width = Math.round(BASE_WIDTH * state.prevScale) + 'px';
        ghostBtn.style.height = Math.round(BASE_HEIGHT * state.prevScale) + 'px';
        ghostBtn.classList.add('is-visible');
      } else {
        ghostBtn.classList.remove('is-visible');
      }

      metricsCorner.textContent = Math.round(state.scale * 100) + '% · ' + w + '×' + h + 'px';
    }

    function renderReadout(transcript, emphasizedWord, note) {
      readoutText.textContent = '';
      if (transcript) {
        const quoted = '"' + transcript + '"';
        if (emphasizedWord) {
          const lower = quoted.toLowerCase();
          const target = emphasizedWord.toLowerCase();
          const idx = lower.indexOf(target);
          if (idx >= 0) {
            readoutText.appendChild(document.createTextNode(quoted.slice(0, idx)));
            readoutText.appendChild(el('span', 'ps-emphasis', quoted.slice(idx, idx + emphasizedWord.length)));
            readoutText.appendChild(document.createTextNode(quoted.slice(idx + emphasizedWord.length)));
          } else {
            readoutText.appendChild(document.createTextNode(quoted));
          }
        } else {
          readoutText.appendChild(document.createTextNode(quoted));
        }
        if (note) {
          readoutText.appendChild(document.createTextNode(' · ' + note));
        }
      } else if (note) {
        readoutText.textContent = note;
      }
    }

    function drawIdleWave() {
      const ctx = waveCanvas.getContext('2d');
      if (!ctx) return;
      const w = waveCanvas.width;
      const h = waveCanvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = '#e5e5e5';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(8, h / 2);
      ctx.lineTo(w - 8, h / 2);
      ctx.stroke();
    }

    function startWaveLoop() {
      const ctx = waveCanvas.getContext('2d');
      if (!ctx || !state.analyser) return;
      const buf = new Uint8Array(state.analyser.fftSize);

      function frame() {
        if (!state.recording || !state.analyser) return;
        state.analyser.getByteTimeDomainData(buf);
        const w = waveCanvas.width;
        const h = waveCanvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = '#d94f1e';
        ctx.lineWidth = 2.2;
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
        state.prevScale = state.scale;
        state.scale = clamp(state.scale * (1 + res.delta_percent / 100), MIN_SCALE, MAX_SCALE);
        deltaPill.textContent = (res.delta_percent > 0 ? '+' : '') + res.delta_percent + '%';
        deltaPill.classList.add('is-visible');
      } else {
        deltaPill.textContent = '0%';
        deltaPill.classList.add('is-visible');
      }
      renderButtonSize();
      renderReadout(res.transcript, res.emphasized_word, res.prosody_note);
    }

    function stopMediaTracks() {
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
      drawIdleWave();
    }

    function startRecording() {
      if (state.recording || state.processing) return;
      const apiKey = NS.Client.KeyStore.get();
      if (!apiKey) {
        keyPanel.classList.add('is-open');
        keyInput.focus();
        renderReadout('', '', 'Add a Gemini API key for live mic prosody, or tap a demo chip below.');
        return;
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        renderReadout('', '', 'Microphone capture is unavailable in this browser context.');
        return;
      }

      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then(function (stream) {
          state.mediaStream = stream;
          state.audioChunks = [];
          state.recording = true;

          const AudioCtx = global.AudioContext || global.webkitAudioContext;
          if (AudioCtx) {
            state.audioCtx = new AudioCtx();
            const source = state.audioCtx.createMediaStreamSource(stream);
            state.analyser = state.audioCtx.createAnalyser();
            state.analyser.fftSize = 256;
            source.connect(state.analyser);
            startWaveLoop();
          }

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
          micBtn.classList.add('is-recording');
          micLabel.textContent = 'Listening… Click to Stop';
          renderReadout('', '', 'Speak naturally — try stressing "liiiittle" or "MUCH".');
        })
        .catch(function (err) {
          stopMediaTracks();
          renderReadout('', '', 'Mic permission denied: ' + ((err && err.message) || 'check browser settings.'));
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

    function processRecordedAudio(blob) {
      if (!blob || blob.size < 400) {
        renderReadout('', '', 'Recording too short — speak a phrase and stop.');
        micLabel.textContent = 'Hold or Click to Speak';
        return;
      }

      if (state.abortController) state.abortController.abort();
      state.abortController = new AbortController();
      state.processing = true;
      micBtn.classList.add('is-processing');
      micLabel.textContent = 'Analyzing prosody…';

      NS.Client.analyzeAudioLive(blob, NS.Client.KeyStore.get(), state.abortController.signal)
        .then(function (res) {
          applyProsodyResult(res);
        })
        .catch(function (err) {
          if (err && err.name === 'AbortError') return;
          renderReadout('', '', 'Gemini audio error: ' + ((err && err.message) || 'request failed'));
        })
        .finally(function () {
          state.processing = false;
          micBtn.classList.remove('is-processing');
          micLabel.textContent = 'Hold or Click to Speak';
        });
    }

    // --- Event Wiring ---
    micBtn.addEventListener('click', function () {
      if (state.recording) stopRecording();
      else startRecording();
    });

    resetBtn.addEventListener('click', function () {
      state.prevScale = null;
      state.scale = 1.0;
      deltaPill.classList.remove('is-visible');
      renderButtonSize();
      renderReadout('', '', 'Reset to 100% (136×44px).');
    });

    modeBadge.addEventListener('click', function () {
      const isOpen = keyPanel.classList.toggle('is-open');
      if (isOpen) {
        keyInput.value = NS.Client.KeyStore.get();
        keyInput.focus();
      }
    });

    keyCloseBtn.addEventListener('click', function () {
      keyPanel.classList.remove('is-open');
    });

    keySaveBtn.addEventListener('click', function () {
      NS.Client.KeyStore.set(keyInput.value);
      keyPanel.classList.remove('is-open');
      syncBadge();
      renderReadout('', '', NS.Client.KeyStore.get() ? 'Live Gemini audio ready — click mic to speak.' : 'Key cleared (Demo mode).');
    });

    keyClearBtn.addEventListener('click', function () {
      NS.Client.KeyStore.clear();
      keyInput.value = '';
      syncBadge();
    });

    // Initial render
    syncBadge();
    renderButtonSize();
    drawIdleWave();
  }

  document.addEventListener('DOMContentLoaded', function () {
    mount(document.getElementById('cell-prosody'));
  });

  NS.UI = { mount: mount };
})(window);
