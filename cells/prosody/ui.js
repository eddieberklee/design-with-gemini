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
  const IDLE_HINT = 'Tap a phrase, or start the mic.';

  // Status pill states (ui/NOTES.md green rule: green only while really streaming; a saved key is
  // idle grey). Labels are sentence case; .ui-pill shows them in mono caps.
  const BADGE_STATES = {
    demo: {
      label: 'No key',
      tone: 'idle',
      tip: 'Demo: phrases simulate speech. Click to add a Gemini key for the live mic.'
    },
    key: {
      label: 'Key set',
      tone: 'idle',
      tip: 'Key saved, not streaming. Start the mic to go live, or click to edit the key.'
    },
    connecting: {
      label: 'Running',
      tone: 'attention',
      tip: 'Starting: asking for the mic and opening a Gemini Live session. Click to edit the key.'
    },
    live: {
      label: 'Live',
      tone: 'ok',
      tip: 'Streaming your voice to Gemini now. Click to edit the key.'
    }
  };

  // Demo chip tips by DEMO_PRESETS id (client.js). Chips push the preset transcript and apply its
  // step through the same path as a live tool call; nothing is spoken or recorded.
  const CHIP_TIPS = {
    'neutral-small': 'Simulates a plainly spoken request: one standard step smaller (−12%).',
    'stressed-little': 'Simulates a stretched “little”: only a tiny step smaller (−3%).',
    'stressed-much-bigger': 'Simulates a stressed “MUCH”: a big step bigger (+26%).'
  };

  let wavePalette = null;

  // Canvas stroke colours from the shared tokens, read once (not per frame).
  function readWavePalette() {
    if (wavePalette) return wavePalette;
    const pal = { idle: '#d3d3ce', live: '#b4441a' };
    try {
      const root = document.documentElement;
      if (root && typeof global.getComputedStyle === 'function') {
        const cs = global.getComputedStyle(root);
        const idle = cs && typeof cs.getPropertyValue === 'function' ? cs.getPropertyValue('--ui-line').trim() : '';
        const live = cs && typeof cs.getPropertyValue === 'function' ? cs.getPropertyValue('--ui-accent').trim() : '';
        if (idle) pal.idle = idle;
        if (live) pal.live = live;
      }
    } catch (_e) {
      // keep fallbacks
    }
    wavePalette = pal;
    return pal;
  }

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
    // Shared tile anatomy (ui/base.css): head 36 / stage / controls / foot 30, and the ui-tile
    // container that the compact (< 320 px) and tiny (< 240 px) steps query.
    if (container.classList) container.classList.add('ui-tile');

    // --- Header: index + title + status pill + actions ---
    const header = el('header', 'ui-tile-head ps-header');
    header.appendChild(el('span', 'ui-tile-index ps-index', '02'));
    header.appendChild(el('span', 'ui-tile-title ps-title', 'Live Prosody Sizer'));

    const headerActions = el('div', 'ui-tile-actions ps-header-actions');
    const modeBadge = el('button', 'ui-pill ps-badge');
    modeBadge.type = 'button';
    modeBadge.setAttribute('aria-haspopup', 'dialog');
    modeBadge.setAttribute('aria-expanded', 'false');
    const badgeLabel = el('span', 'ui-pill-label', BADGE_STATES.demo.label);
    modeBadge.appendChild(badgeLabel);

    const initialMuted = Boolean(NS.Client.SoundFX.isMuted && NS.Client.SoundFX.isMuted());
    const sfxBtn = el('button', 'ui-btn ui-btn--sm ui-hide-compact ps-icon-btn', 'SFX');
    sfxBtn.type = 'button';

    const resetBtn = el('button', 'ui-btn ui-btn--sm ui-hide-compact ps-icon-btn ps-reset-btn', 'Reset');
    resetBtn.type = 'button';
    resetBtn.setAttribute('data-tip', 'Back to 100% and clear the heard words.');

    headerActions.appendChild(modeBadge);
    headerActions.appendChild(sfxBtn);
    headerActions.appendChild(resetBtn);
    header.appendChild(headerActions);

    // --- API Key Popover ---
    const keyPanel = el('div', 'ps-key-panel');
    keyPanel.setAttribute('role', 'dialog');
    keyPanel.setAttribute('aria-label', 'Gemini API key');
    const keyHead = el('div', 'ps-key-head');
    keyHead.appendChild(el('div', 'ps-key-panel-title', 'Gemini API key'));
    const keyCloseBtn = el('button', 'ui-btn ui-btn--sm ps-icon-btn', 'Close');
    keyCloseBtn.type = 'button';
    keyCloseBtn.setAttribute('data-tip', 'Close the key panel without saving.');
    keyCloseBtn.setAttribute('data-tip-key', 'Escape');
    keyHead.appendChild(keyCloseBtn);
    keyPanel.appendChild(keyHead);
    keyPanel.appendChild(
      el(
        'div',
        'ps-key-panel-desc',
        'Streams your mic to Gemini Live; how you stress a size word resizes the button. Shared with cells 01 and 04.'
      )
    );
    const keyInput = el('input', 'ps-key-input');
    keyInput.type = 'password';
    keyInput.placeholder = 'AIza...';
    keyInput.autocomplete = 'off';
    keyInput.setAttribute('aria-label', 'Gemini API key');

    const keyActions = el('div', 'ps-key-actions');
    const keyClearBtn = el('button', 'ui-btn ui-btn--sm ui-btn--quiet ps-icon-btn', 'Clear');
    keyClearBtn.type = 'button';
    keyClearBtn.setAttribute('data-tip', 'Remove the saved key; Decisions and API Matrix use it too.');
    const keySaveBtn = el('button', 'ui-btn ui-btn--sm ui-btn--primary ps-btn-primary', 'Save');
    keySaveBtn.type = 'button';
    keySaveBtn.setAttribute('data-tip', 'Save the key in this browser; cells 01 and 04 share it.');
    keySaveBtn.setAttribute('data-tip-key', 'Enter');

    const keyNotice = el('div', 'ps-key-notice', '');
    keyNotice.setAttribute('role', 'alert');

    keyActions.appendChild(keyClearBtn);
    keyActions.appendChild(keySaveBtn);
    keyPanel.appendChild(keyInput);
    keyPanel.appendChild(keyNotice);
    keyPanel.appendChild(keyActions);

    // --- Stage: the hero button on a faint dot-grid scale ---
    const stage = el('div', 'ui-tile-body ui-tile-body--flush ps-stage');
    const metricsCorner = el('div', 'ui-readout ui-readout--quiet ps-metrics-corner', '100% · 136×44px');
    metricsCorner.setAttribute('data-tip', 'Button size now: scale, then width × height in pixels.');
    const deltaPill = el('div', 'ui-readout ps-delta-pill', '');
    deltaPill.setAttribute('data-tip', 'Size change the last phrase applied; MAX or MIN means a size limit.');

    const buttonWrap = el('div', 'ps-button-wrap');
    const targetBtn = el('button', 'ps-target-btn', 'Confirm');
    targetBtn.type = 'button';
    targetBtn.setAttribute('data-tip', 'Demo target: spoken size commands or the demo phrases resize it.');
    const ghostBtn = el('div', 'ps-ghost-btn');
    ghostBtn.setAttribute('aria-hidden', 'true');

    buttonWrap.appendChild(targetBtn);
    buttonWrap.appendChild(ghostBtn);

    // Live Word Marquee Ribbon at bottom of stage
    const marqueeWrap = el('div', 'ps-marquee ui-hide-compact');
    marqueeWrap.setAttribute('data-tip', 'Words heard from you or the tapped phrase; the stressed word is highlighted.');
    const marqueeTrack = el('div', 'ps-marquee-track');
    marqueeTrack.appendChild(el('span', 'ps-marquee-placeholder', MARQUEE_PLACEHOLDER));
    marqueeWrap.appendChild(marqueeTrack);

    stage.appendChild(metricsCorner);
    stage.appendChild(deltaPill);
    stage.appendChild(buttonWrap);
    stage.appendChild(marqueeWrap);

    // --- Controls: mic + level, then demo phrases. Compact (< 320 px): mic only. Tiny: none. ---
    const controlsRow = el('div', 'ps-controls ui-hide-tiny');

    const micBtn = el('button', 'ui-btn ui-btn--sm ps-mic-btn');
    micBtn.type = 'button';
    micBtn.setAttribute('aria-pressed', 'false');
    const micDot = el('span', 'ps-mic-dot');
    micDot.setAttribute('aria-hidden', 'true');
    const micLabel = el('span', '', 'Start mic');
    micBtn.appendChild(micDot);
    micBtn.appendChild(micLabel);

    const waveCanvas = el('canvas', 'ps-wave-canvas ui-hide-compact');
    waveCanvas.setAttribute('aria-hidden', 'true');
    waveCanvas.setAttribute('data-tip', 'Mic level; a flat line until the live mic is on.');

    const demosRow = el('div', 'ps-demos');
    demosRow.setAttribute('role', 'group');
    demosRow.setAttribute('aria-label', 'Demo phrases');
    NS.Client.DEMO_PRESETS.forEach(function (preset) {
      const chip = el('button', 'ui-chip ps-demo-chip', preset.label);
      chip.type = 'button';
      if (CHIP_TIPS[preset.id]) chip.setAttribute('data-tip', CHIP_TIPS[preset.id]);
      chip.addEventListener('click', function () {
        pushMarqueeWords(preset.transcript, preset.emphasized_word);
        applyProsodyResult(preset);
      });
      demosRow.appendChild(chip);
    });

    // Compact tiles hide the foot; this line under the mic and phrases carries the same status
    // there (only one of the two is ever rendered, so screen readers hear it once). Both exist only
    // where the phrases are shown, so the idle hint may name them.
    const compactStatus = el('div', 'ui-truncate ps-compact-status', IDLE_HINT);
    compactStatus.setAttribute('role', 'status');
    compactStatus.setAttribute('aria-live', 'polite');

    controlsRow.appendChild(micBtn);
    controlsRow.appendChild(waveCanvas);
    controlsRow.appendChild(compactStatus);
    controlsRow.appendChild(demosRow);

    // --- Footer: status line + TX/RX counters ---
    const footer = el('footer', 'ui-tile-foot ps-footer');
    const readoutText = el('div', 'ui-prose ui-truncate ps-readout-text', IDLE_HINT);
    readoutText.setAttribute('role', 'status');
    readoutText.setAttribute('aria-live', 'polite');
    const txRxBadge = el('span', 'ps-tx-rx', '');
    txRxBadge.setAttribute('aria-hidden', 'true');
    txRxBadge.setAttribute('data-tip', 'Audio chunks sent to Gemini (TX) and messages received back (RX).');
    footer.appendChild(readoutText);
    footer.appendChild(txRxBadge);

    container.appendChild(header);
    container.appendChild(keyPanel);
    container.appendChild(stage);
    container.appendChild(controlsRow);
    container.appendChild(footer);

    // --- Rendering helpers ---
    // Pill: 'Live' (green) only while a Gemini Live session is actually streaming; 'Connecting'
    // (rust) while the mic/socket open; a saved key alone is idle 'Key set'; no key is 'Demo'
    // (the phrases simulate). Also keeps the state-dependent tips and names in step: every key
    // and stream change (onKeySync, save, clear, start, ready, stop) calls this.
    function syncBadge() {
      if (unmounted) return;
      const hasKey = Boolean(NS.Client.KeyStore.get());
      const mode = state.streaming ? 'live' : state.connecting ? 'connecting' : hasKey ? 'key' : 'demo';
      const b = BADGE_STATES[mode];
      if (badgeLabel.textContent !== b.label) badgeLabel.textContent = b.label;
      modeBadge.setAttribute('data-tone', b.tone);
      modeBadge.setAttribute('data-tip', b.tip);
      modeBadge.setAttribute('aria-label', b.label + ' · Gemini key settings');
      micBtn.setAttribute(
        'data-tip',
        state.streaming
          ? 'Streaming your voice to Gemini. Click to stop the mic.'
          : state.connecting
            ? 'Connecting to Gemini. Click to cancel.'
            : hasKey
              ? 'Stream your voice to Gemini; how you say size words resizes the button.'
              : 'Needs a Gemini key; opens the key panel first.'
      );
    }

    function syncSfx(muted) {
      sfxBtn.setAttribute('aria-pressed', muted ? 'false' : 'true');
      sfxBtn.setAttribute(
        'data-tip',
        muted
          ? 'Sound effects off. Click to hear a short tone on each resize.'
          : 'Sound effects on: a short tone on each resize and mic start. Click to mute.'
      );
    }
    syncSfx(initialMuted);

    // Phrase row scrolls sideways when the tile is too narrow for all three; the fade marks it.
    function syncDemosOverflow() {
      const over = demosRow.scrollWidth > demosRow.clientWidth + 1;
      demosRow.classList.toggle('is-overflowing', over);
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
      let pad = [28, 12, 32, 12];
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
      if (compactStatus.textContent !== nextText) compactStatus.textContent = nextText;
      compactStatus.classList.toggle('is-error', Boolean(isError));
      if (nextText) compactStatus.setAttribute('data-tip', nextText);
      else compactStatus.removeAttribute('data-tip');
      // The status line truncates; its tip carries the full text only when it is cut off.
      if (nextText && readoutText.scrollWidth > readoutText.clientWidth + 1) {
        readoutText.setAttribute('data-tip', nextText);
      } else {
        readoutText.removeAttribute('data-tip');
      }
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
      ctx.strokeStyle = readWavePalette().idle;
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
      const liveStroke = readWavePalette().live;

      function frame() {
        if (unmounted || !state.streaming || !state.analyser) return;
        state.analyser.getByteTimeDomainData(buf);
        const w = waveCanvas.width;
        const h = waveCanvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = liveStroke;
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
      micBtn.removeAttribute('data-tone');
      micLabel.textContent = 'Start mic';
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
        renderReadout('Add a Gemini key to stream, or tap a phrase.', false);
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
      syncBadge();
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
              micBtn.setAttribute('data-tone', 'attention');
              micLabel.textContent = 'Stop mic';
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
      syncSfx(NS.Client.SoundFX.toggleMute());
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
      renderReadout('Gemini key saved — click Start mic to stream.', false);
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
      renderReadout('Key cleared — demo phrases only.', false);
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
      syncDemosOverflow();
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
        renderReadout('Live stream stopped while the tab was hidden — click Start mic to resume.', false);
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
    syncDemosOverflow();
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
