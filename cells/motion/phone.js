(function (root) {
  'use strict';

  const NS = (root.MotionGrid = root.MotionGrid || {});
  const Physics = NS.Physics;
  const Transport = NS.Transport;

  const MODE_HINTS = {
    all: 'Rotate, raise up/down, or pull phone to resize grid cells',
    tilt: 'Rotate wrist or tilt phone like a precision dial',
    lift: 'Raise phone up to enlarge cells · lower down to shrink',
    pull: 'Pull phone toward you to enlarge · push away to shrink'
  };

  const params = new URLSearchParams(window.location.search);
  const sessionId = (params.get('s') || '').trim().toUpperCase();
  const transportParam = (params.get('t') || 'mqtt').trim().toLowerCase();

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const processor = new Physics.MotionProcessor({ mode: 'all', sensitivity: 1.0 });

  const refs = {
    status: document.getElementById('ph-status'),
    statusText: document.getElementById('ph-status-text'),
    httpsBanner: document.getElementById('ph-https-banner'),
    dialPad: document.getElementById('ph-dial-pad'),
    arcActive: document.getElementById('ph-arc-active'),
    bubble: document.getElementById('ph-bubble'),
    needle: document.getElementById('ph-needle'),
    sizePx: document.getElementById('ph-size-px'),
    scaleVal: document.getElementById('ph-scale-val'),
    colsMeta: document.getElementById('ph-cols-meta'),
    gate: document.getElementById('ph-gate'),
    enableBtn: document.getElementById('ph-enable-btn'),
    gateNote: document.getElementById('ph-gate-note'),
    mTilt: document.getElementById('ph-m-tilt'),
    bTilt: document.getElementById('ph-b-tilt'),
    mLift: document.getElementById('ph-m-lift'),
    bLift: document.getElementById('ph-b-lift'),
    mPull: document.getElementById('ph-m-pull'),
    bPull: document.getElementById('ph-b-pull'),
    modeHint: document.getElementById('ph-mode-hint'),
    zeroBtn: document.getElementById('ph-zero-btn'),
    clutchBtn: document.getElementById('ph-clutch-btn'),
    layoutBtn: document.getElementById('ph-layout-btn'),
    resetBtn: document.getElementById('ph-reset-btn'),
    slider: document.getElementById('ph-slider'),
    sessionTag: document.getElementById('ph-session-tag'),
    modeBtns: Array.from(document.querySelectorAll('.ph-seg-btn'))
  };

  let link = null;
  let seq = 1;
  let sensorsActive = false;
  let lastSendMs = 0;
  let desktopState = { cellW: 420, cols: 3, layout: 'reflow', baseW: 420 };
  let wakeLock = null;
  let manualScrubbing = false;

  refs.sessionTag.textContent = sessionId ? 'SID ' + sessionId.slice(0, 4) : 'NO SESSION';

  if (!window.isSecureContext && isIOS) {
    refs.httpsBanner.hidden = false;
  }

  // ---------- Arc SVG Math (-135 deg to +135 deg) ----------

  function polarToCartesian(cx, cy, r, deg) {
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function describeArc(cx, cy, r, startDeg, endDeg) {
    const s = polarToCartesian(cx, cy, r, startDeg);
    const e = polarToCartesian(cx, cy, r, endDeg);
    const largeArc = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
    const sweep = endDeg >= startDeg ? 1 : 0;
    return 'M ' + s.x.toFixed(2) + ' ' + s.y.toFixed(2) +
      ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' ' + sweep + ' ' +
      e.x.toFixed(2) + ' ' + e.y.toFixed(2);
  }

  function setBar(barEl, textEl, val, maxVal, unit) {
    const pct = Physics.clamp(val / maxVal, -1, 1);
    const half = Math.abs(pct) * 50;
    barEl.style.left = pct >= 0 ? '50%' : (50 - half) + '%';
    barEl.style.width = half + '%';
    textEl.textContent = (val >= 0 ? '+' : '−') + Math.abs(val).toFixed(1) + (unit || '');
  }

  function renderDial(scale, roll, pitch, liftA, pullA) {
    const norm = (scale - Physics.MIN_SCALE) / (Physics.MAX_SCALE - Physics.MIN_SCALE);
    const angle = -135 + Physics.clamp(norm, 0, 1) * 270;
    refs.needle.setAttribute('transform', 'rotate(' + angle.toFixed(1) + ' 120 120)');
    if (Math.abs(angle + 135) > 1) {
      refs.arcActive.setAttribute('d', describeArc(120, 120, 106, -135, angle));
    }

    const bx = 120 + Physics.clamp(roll / 45, -1, 1) * 44;
    const by = 120 - Physics.clamp((pitch / 45) + (liftA / 12), -1, 1) * 44;
    refs.bubble.setAttribute('cx', bx.toFixed(1));
    refs.bubble.setAttribute('cy', by.toFixed(1));

    const estPx = desktopState.cellW || Math.round((desktopState.baseW || 420) * scale);
    refs.sizePx.textContent = estPx + ' px';
    refs.scaleVal.textContent = scale.toFixed(2) + '×';
    refs.colsMeta.textContent = desktopState.cols + ' col · ' + (desktopState.layout === 'reflow' ? 'Reflow' : '3×3');

    if (!manualScrubbing) {
      refs.slider.value = String(Math.round(scale * 100));
    }

    setBar(refs.bTilt, refs.mTilt, roll, 55, '°');
    setBar(refs.bLift, refs.mLift, liftA, 10, '');
    setBar(refs.bPull, refs.mPull, pullA, 10, '');
  }

  // ---------- Transport Connection ----------

  function connect() {
    if (!sessionId) {
      refs.status.dataset.state = 'warn';
      refs.statusText.textContent = 'NO SID';
      return;
    }

    const canLocal = transportParam === 'local' || transportParam === 'dual';
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = canLocal
      ? wsProto + '//' + window.location.host + '/ws?s=' + encodeURIComponent(sessionId) + '&role=phone'
      : '';
    const httpBase = canLocal ? window.location.origin : '';

    link = Transport.createLink({
      mode: canLocal ? 'dual' : 'mqtt',
      sessionId: sessionId,
      role: 'phone',
      wsUrl: wsUrl,
      httpBase: httpBase,
      onStatus: function (st, info) {
        refs.status.dataset.state = st === 'ready' ? 'ready' : 'connecting';
        if (st === 'ready') {
          const tag = info && info.transport === 'local-ws'
            ? 'LIVE · WS'
            : info && info.transport === 'local-http'
              ? 'LIVE · HTTPS'
              : 'LIVE · MQTT';
          refs.statusText.textContent = tag;
          link.send({ t: 'hello', v: 1, ua: isIOS ? 'ios' : 'web', secure: Boolean(window.isSecureContext) });
        } else {
          refs.statusText.textContent = 'LINKING';
        }
      },
      onMessage: function (msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'state') {
          if (Number.isFinite(msg.cellW)) desktopState.cellW = msg.cellW;
          if (Number.isFinite(msg.cols)) desktopState.cols = msg.cols;
          if (Number.isFinite(msg.baseW)) desktopState.baseW = msg.baseW;
          if (msg.layout === 'reflow' || msg.layout === 'fixed3') {
            desktopState.layout = msg.layout;
            refs.layoutBtn.textContent = msg.layout === 'reflow' ? 'Reflow' : 'Lock 3×3';
          }
          renderDial(processor.scale, processor.telemetry.roll, processor.telemetry.pitch, processor.telemetry.liftA, processor.telemetry.pullA);
        } else if (msg.t === 'cmd') {
          if (msg.cmd === 'reset') {
            processor.resetScale(Physics.DEFAULT_SCALE);
            renderDial(processor.scale, 0, 0, 0, 0);
          } else if (msg.cmd === 'zero') {
            processor.calibrate();
          } else if (msg.cmd === 'mode' && msg.val) {
            setMode(msg.val, false);
          }
        }
      }
    });
    link.start();
  }

  function transmitMotion(tel, force) {
    if (!link) return;
    const now = performance.now();
    // 30Hz cap balances silky smoothness and low radio overhead
    if (!force && now - lastSendMs < 32) return;
    lastSendMs = now;
    link.send({
      t: 'm',
      seq: seq++,
      ts: Math.round(now),
      scale: Number(tel.scale.toFixed(3)),
      mode: processor.mode,
      clutch: processor.clutchActive ? 1 : 0,
      roll: Number(tel.roll.toFixed(1)),
      pitch: Number(tel.pitch.toFixed(1)),
      lift: Number(tel.liftA.toFixed(2)),
      pull: Number(tel.pullA.toFixed(2))
    });
  }

  // ---------- iOS Accelerometer & Orientation Permission Gate ----------

  async function requestWakeLock() {
    try {
      if (navigator.wakeLock && typeof navigator.wakeLock.request === 'function') {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (_e) {}
  }

  function startSensors() {
    if (sensorsActive) return;
    sensorsActive = true;
    refs.gate.hidden = true;
    requestWakeLock();

    window.addEventListener('deviceorientation', function (ev) {
      if (ev && Number.isFinite(ev.beta) && Number.isFinite(ev.gamma)) {
        processor.ingestOrientation(ev.beta, ev.gamma);
      }
    });

    window.addEventListener('devicemotion', function (ev) {
      if (!ev || manualScrubbing) return;
      const acc = ev.acceleration || {};
      const accG = ev.accelerationIncludingGravity || {};
      const tel = processor.ingestMotion({
        ax: acc.x,
        ay: acc.y,
        az: acc.z,
        gx: accG.x,
        gy: accG.y,
        gz: accG.z,
        ts: ev.timeStamp || Date.now(),
        isIOS: isIOS
      });
      desktopState.cellW = Math.round((desktopState.baseW || 420) * tel.scale);
      renderDial(tel.scale, tel.roll, tel.pitch, tel.liftA, tel.pullA);
      transmitMotion(tel, false);
    });
  }

  // CRITICAL iOS Safari requirement: requestPermission() MUST run directly inside click handler
  refs.enableBtn.addEventListener('click', function () {
    if (!window.isSecureContext && isIOS) {
      refs.httpsBanner.hidden = false;
      refs.gateNote.textContent = 'Blocked: iOS Safari requires HTTPS to access motion sensors.';
      return;
    }

    const motionNeedsPerm = typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function';
    const orientNeedsPerm = typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function';

    if (!motionNeedsPerm && !orientNeedsPerm) {
      startSensors();
      return;
    }

    const promises = [];
    if (motionNeedsPerm) {
      try { promises.push(DeviceMotionEvent.requestPermission()); } catch (e) { promises.push(Promise.reject(e)); }
    }
    if (orientNeedsPerm) {
      try { promises.push(DeviceOrientationEvent.requestPermission()); } catch (_e) {}
    }

    Promise.all(promises)
      .then(function (results) {
        if (results.indexOf('granted') >= 0) {
          startSensors();
        } else {
          refs.gateNote.textContent = 'Permission denied. Reload Safari tab and tap Enable Motion again.';
        }
      })
      .catch(function (err) {
        refs.gateNote.textContent = 'Sensor error: ' + String(err && err.message || err);
      });
  });

  // ---------- Controls ----------

  function setMode(mode, notifyDesktop) {
    processor.setMode(mode);
    refs.modeHint.textContent = MODE_HINTS[mode] || MODE_HINTS.all;
    refs.modeBtns.forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.dataset.mode === mode ? 'true' : 'false');
    });
    if (notifyDesktop && link) {
      link.send({ t: 'act', cmd: 'mode', val: mode });
    }
  }

  refs.modeBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      setMode(btn.dataset.mode, true);
    });
  });

  refs.zeroBtn.addEventListener('click', function () {
    processor.calibrate();
    refs.zeroBtn.textContent = 'Zeroed ✓';
    setTimeout(function () { refs.zeroBtn.textContent = 'Zero Pose'; }, 900);
  });

  refs.clutchBtn.addEventListener('click', function () {
    const next = !processor.clutchRequired;
    processor.setClutchRequired(next);
    refs.clutchBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
    refs.clutchBtn.textContent = next ? 'Clutch: Hold' : 'Clutch: Off';
    refs.modeHint.textContent = next
      ? 'Press & hold the dial while tilting, lifting, or pulling'
      : MODE_HINTS[processor.mode];
  });

  // Touch clutch on dial pad
  function onClutchDown(ev) {
    if (!processor.clutchRequired || !refs.gate.hidden) return;
    ev.preventDefault();
    processor.setClutch(true);
    refs.dialPad.classList.add('is-clutched');
  }
  function onClutchUp() {
    if (!processor.clutchActive) return;
    processor.setClutch(false);
    refs.dialPad.classList.remove('is-clutched');
  }
  refs.dialPad.addEventListener('pointerdown', onClutchDown);
  window.addEventListener('pointerup', onClutchUp);
  window.addEventListener('pointercancel', onClutchUp);

  refs.layoutBtn.addEventListener('click', function () {
    const next = desktopState.layout === 'reflow' ? 'fixed3' : 'reflow';
    desktopState.layout = next;
    refs.layoutBtn.textContent = next === 'reflow' ? 'Reflow' : 'Lock 3×3';
    if (link) link.send({ t: 'act', cmd: 'layout', val: next });
    renderDial(processor.scale, processor.telemetry.roll, processor.telemetry.pitch, processor.telemetry.liftA, processor.telemetry.pullA);
  });

  refs.resetBtn.addEventListener('click', function () {
    processor.resetScale(Physics.DEFAULT_SCALE);
    desktopState.cellW = desktopState.baseW || 420;
    renderDial(Physics.DEFAULT_SCALE, 0, 0, 0, 0);
    if (link) link.send({ t: 'act', cmd: 'reset' });
  });

  // Manual touch slider fallback
  refs.slider.addEventListener('pointerdown', function () { manualScrubbing = true; });
  refs.slider.addEventListener('pointerup', function () { manualScrubbing = false; });
  refs.slider.addEventListener('change', function () { manualScrubbing = false; });
  refs.slider.addEventListener('input', function (ev) {
    const nextScale = Number(ev.target.value) / 100;
    processor.resetScale(nextScale);
    desktopState.cellW = Math.round((desktopState.baseW || 420) * nextScale);
    renderDial(nextScale, 0, 0, 0, 0);
    transmitMotion(processor.telemetry, true);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && sensorsActive && !wakeLock) {
      requestWakeLock();
    }
  });

  renderDial(Physics.DEFAULT_SCALE, 0, 0, 0, 0);
  connect();
})(window);
