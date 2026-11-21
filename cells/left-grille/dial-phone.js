/**
 * Standalone Mobile Rotary Encoder Controller (`cells/left-grille/dial-phone.js`)
 *
 * Runs on iPhone Safari (`dial-phone.html?s=<SID>`) and connects back to Secondary Cell 07
 * over `window.MotionGrid.Transport` (DualLink: Local WS + Zero-Server MQTT over WSS).
 *
 * Features:
 * - 1-tap `DeviceMotionEvent.requestPermission()` + `DeviceOrientationEvent.requestPermission()`
 *   directly inside the user click handler (iOS 13+ requirement).
 * - Gravity-projected desk spin tracking via `RotaryDialTracker` (`window.LeftGrilleDial`):
 *   works seamlessly when the iPhone lies flat on the desk face-up, face-down, or on an
 *   angled stand with 0.00 deg/min stationary drift.
 * - Counter-rotated `dp-center-hud` (`rotate(-angleDeg)`) so the digital angle and value
 *   readout stay upright relative to the user while the physical phone spins 360° on the desk!
 * - Subtle 24-detent (`every 15°`) Web Audio mechanical micro-tick synthesizer + haptics.
 * - Full circular Touch-Ring fallback with inertial momentum when opened without gyroscope.
 */
(function (root) {
  'use strict';

  if (typeof document === 'undefined' || !document.getElementById('dp-app')) {
    return;
  }

  const DialLib = root.LeftGrilleDial || {};
  const NS = root.MotionGrid || {};
  const Transport = NS.Transport;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const params = new URLSearchParams(root.location ? root.location.search : '');
  const rawSid = String(params.get('s') || '').trim().toUpperCase();
  // No valid `?s=` means nothing to pair with: no shared fallback room, no relay socket.
  const sessionId = Transport && typeof Transport.isValidSessionId === 'function'
    ? (Transport.isValidSessionId(rawSid) ? rawSid : '')
    : (/^[A-Z0-9]{6,12}$/.test(rawSid) ? rawSid : '');
  const transportParam = String(params.get('t') || 'mqtt').trim().toLowerCase();
  // Desktop presence: it answers `hello` with `state` and sends `hb` every 1.5 s while paired.
  const LINK_TICK_MS = 2500;
  const HELLO_MAX_TRIES = 8; // ~20 s of waiting for a desktop before releasing the relay
  const DESKTOP_SILENCE_MS = 6000;
  const SENSOR_PROBE_MS = 2500;
  const clientInstanceId = Transport && typeof Transport.generateSessionId === 'function'
    ? Transport.generateSessionId(6)
    : 'PH0001';

  const tracker = DialLib.RotaryDialTracker
    ? new DialLib.RotaryDialTracker({ initialValue: 50 })
    : null;

  const refs = {
    body: document.body,
    themeBtn: document.getElementById('dp-theme-btn'),
    status: document.getElementById('dp-status'),
    statusText: document.getElementById('dp-status-text'),
    wheelPad: document.getElementById('dp-wheel-pad'),
    arcActive: document.getElementById('dp-arc-active'),
    ticksGroup: document.getElementById('dp-ticks'),
    rotor: document.getElementById('dp-rotor'),
    centerHud: document.getElementById('dp-center-hud'),
    angleText: document.getElementById('dp-angle'),
    valText: document.getElementById('dp-value'),
    poseText: document.getElementById('dp-pose'),
    gate: document.getElementById('dp-gate'),
    enableBtn: document.getElementById('dp-enable-btn'),
    gateNote: document.getElementById('dp-gate-note'),
    touchOnlyBtn: document.getElementById('dp-touch-only-btn'),
    rpmText: document.getElementById('dp-rpm'),
    detentText: document.getElementById('dp-detent'),
    turnsText: document.getElementById('dp-turns'),
    zeroBtn: document.getElementById('dp-zero-btn'),
    fineBtn: document.getElementById('dp-fine-btn'),
    ticksBtn: document.getElementById('dp-ticks-btn'),
    resetBtn: document.getElementById('dp-reset-btn')
  };

  let link = null;
  let seq = 1;
  let lastSendMs = 0;
  let sensorsActive = false;
  let ticksEnabled = true;
  let audioCtx = null;
  let latestCompassHeading = null;
  let latestOrientationAlpha = null;
  let inertiaRaf = 0;
  let linkStatus = 'idle'; // 'idle' | 'connecting' | 'reconnecting' | 'ready' | 'failed'
  let linkTransport = 'mqtt';
  let desktopLive = false;
  let lastDesktopMs = 0;
  let helloTries = 0;
  let noDesktop = false;
  let linkTick = 0;
  let gotSensorSample = false;
  let sensorProbeTimer = 0;

  // Build 24 detent ticks in SVG
  const tickLines = [];
  for (let i = 0; i < 24; i++) {
    const deg = i * 15;
    const rad = ((deg - 90) * Math.PI) / 180;
    const isMajor = i % 6 === 0;
    const r1 = isMajor ? 102 : 105;
    const r2 = 112;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', (120 + r1 * Math.cos(rad)).toFixed(2));
    line.setAttribute('y1', (120 + r1 * Math.sin(rad)).toFixed(2));
    line.setAttribute('x2', (120 + r2 * Math.cos(rad)).toFixed(2));
    line.setAttribute('y2', (120 + r2 * Math.sin(rad)).toFixed(2));
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-opacity', isMajor ? '0.65' : '0.3');
    line.setAttribute('stroke-width', isMajor ? '2.2' : '1.4');
    line.setAttribute('stroke-linecap', 'round');
    refs.ticksGroup.appendChild(line);
    tickLines.push(line);
  }

  function describeArc(cx, cy, r, endDeg) {
    const span = Math.max(0, Math.min(359.5, endDeg));
    if (span < 0.8) return '';
    const sRad = -Math.PI / 2;
    const eRad = ((span - 90) * Math.PI) / 180;
    const sx = cx + r * Math.cos(sRad);
    const sy = cy + r * Math.sin(sRad);
    const ex = cx + r * Math.cos(eRad);
    const ey = cy + r * Math.sin(eRad);
    const largeArc = span > 180 ? 1 : 0;
    return (
      'M ' + sx.toFixed(2) + ' ' + sy.toFixed(2) +
      ' A ' + r + ' ' + r + ' 0 ' + largeArc + ' 1 ' +
      ex.toFixed(2) + ' ' + ey.toFixed(2)
    );
  }

  function playDetentMicroTick(isMajor) {
    if (!ticksEnabled) return;
    try {
      if (navigator.vibrate) navigator.vibrate(isMajor ? 6 : 3);
    } catch (_e) {}
    try {
      const Ctx = root.AudioContext || root.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx || audioCtx.state === 'closed') audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(function () {});
      }
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(isMajor ? 1520 : 1160, now);
      osc.frequency.exponentialRampToValueAtTime(280, now + 0.011);
      gain.gain.setValueAtTime(isMajor ? 0.08 : 0.045, now);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.012);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.013);
    } catch (_e) {}
  }

  function renderPhoneUi(st) {
    if (!st) return;
    refs.rotor.setAttribute('transform', 'rotate(' + st.angleDeg.toFixed(2) + ' 120 120)');
    // Counter-rotate center HUD when physical gyroscope is active so readout stays upright on desk
    if (sensorsActive) {
      refs.centerHud.style.transform = 'rotate(' + (-st.angleDeg).toFixed(2) + 'deg)';
    } else {
      refs.centerHud.style.transform = '';
    }

    const arcSpan = (st.dialValue / 100) * 359.5;
    refs.arcActive.setAttribute('d', describeArc(120, 120, 98, arcSpan));

    for (let i = 0; i < tickLines.length; i++) {
      if (i === st.detentSlot) {
        tickLines[i].setAttribute('stroke', '#e85d2a');
        tickLines[i].setAttribute('stroke-opacity', '1');
        tickLines[i].setAttribute('stroke-width', '3');
      } else {
        const isMajor = i % 6 === 0;
        tickLines[i].setAttribute('stroke', 'currentColor');
        tickLines[i].setAttribute('stroke-opacity', isMajor ? '0.65' : '0.3');
        tickLines[i].setAttribute('stroke-width', isMajor ? '2.2' : '1.4');
      }
    }

    refs.angleText.textContent = st.angleDeg.toFixed(1) + '°';
    refs.valText.textContent = 'VAL ' + st.dialValue.toFixed(1);
    const orientStr = st.faceUp ? 'FACE-UP' : 'FACE-DOWN';
    refs.poseText.textContent = orientStr + ' · TILT ' + st.tiltDeg.toFixed(1) + '°';

    refs.rpmText.textContent = Math.abs(st.rpm).toFixed(1) + ' RPM';
    refs.detentText.textContent =
      '#' + String(st.detentSlot).padStart(2, '0') + ' · ' + st.totalDetentTicks;
    const tSign = st.turns >= 0 ? '+' : '−';
    refs.turnsText.textContent = tSign + Math.abs(st.turns).toFixed(2) + 't';

    refs.fineBtn.setAttribute('aria-pressed', st.fineMode ? 'true' : 'false');
    refs.fineBtn.textContent = st.fineMode ? '0.25× Fine' : '1× Coarse';
  }

  function transmitDialState(st, force) {
    if (!link || !st) return;
    const now = performance.now();
    if (!force && now - lastSendMs < 24) return;
    lastSendMs = now;
    link.send({
      t: 'm',
      kind: 'rotary-dial',
      cid: clientInstanceId,
      seq: seq++,
      angleDeg: Number(st.angleDeg.toFixed(2)),
      cumulativeDeg: Number(st.cumulativeDeg.toFixed(2)),
      turns: Number(st.turns.toFixed(4)),
      degPerSec: Number(st.degPerSec.toFixed(2)),
      rpm: Number(st.rpm.toFixed(2)),
      detentIndex: st.detentIndex,
      detentSlot: st.detentSlot,
      totalDetentTicks: st.totalDetentTicks,
      dialValue: Number(st.dialValue.toFixed(2)),
      fineMode: st.fineMode,
      faceUp: st.faceUp,
      tiltDeg: Number(st.tiltDeg.toFixed(1))
    });
  }

  // =========================================================================
  // Transport Connection (`MotionGrid.Transport`)
  // =========================================================================

  function isPageHidden() {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
  }

  // `LIVE` only while the desktop is answering; a relay socket alone is `WAIT DESKTOP`.
  function renderStatus() {
    let st = 'connecting';
    let text = 'LINKING';
    const tag = linkTransport === 'local-ws' ? 'WS' : linkTransport === 'local-http' ? 'HTTPS' : 'MQTT';
    if (!sessionId) {
      st = 'warn';
      text = 'NO SESSION · RESCAN QR';
    } else if (!Transport || typeof Transport.createLink !== 'function') {
      st = 'warn';
      text = 'NO TRANSPORT';
    } else if (linkStatus === 'failed') {
      st = 'warn';
      text = 'OFFLINE · TAP';
    } else if (!link && noDesktop) {
      st = 'warn';
      text = 'NO DESKTOP · TAP';
    } else if (!link) {
      st = 'warn';
      text = 'PAUSED · TAP';
    } else if (linkStatus === 'ready' && desktopLive) {
      st = 'ready';
      text = 'LIVE · ' + tag;
    } else if (linkStatus === 'ready') {
      text = 'WAIT DESKTOP · ' + tag;
    }
    refs.status.dataset.state = st;
    refs.statusText.textContent = text;
  }

  function sendHello() {
    if (link) link.send({ t: 'hello', v: 1, cid: clientInstanceId, kind: 'rotary-dial' });
  }

  function markDesktopSeen() {
    lastDesktopMs = Date.now();
    helloTries = 0;
    if (!desktopLive) {
      desktopLive = true;
      renderStatus();
    }
  }

  // One interval while the link is open and the page visible: phone heartbeat when the desktop
  // answers, bounded hello retries when it does not, then the relay is released.
  function onLinkTick() {
    if (!link || linkStatus !== 'ready') return;
    if (desktopLive && Date.now() - lastDesktopMs > DESKTOP_SILENCE_MS) {
      desktopLive = false;
      helloTries = 0;
      renderStatus();
    }
    if (desktopLive) {
      link.send({ t: 'hb', cid: clientInstanceId });
      return;
    }
    if (helloTries >= HELLO_MAX_TRIES) {
      noDesktop = true;
      closeLink();
      renderStatus();
      return;
    }
    helloTries++;
    sendHello();
  }

  function syncLinkTick() {
    const want = Boolean(link) && linkStatus === 'ready' && !isPageHidden();
    if (want && !linkTick) {
      linkTick = setInterval(onLinkTick, LINK_TICK_MS);
    } else if (!want && linkTick) {
      clearInterval(linkTick);
      linkTick = 0;
    }
  }

  function closeLink() {
    if (link) {
      const old = link;
      link = null;
      try { old.close(); } catch (_e) {}
    }
    desktopLive = false;
    if (linkStatus !== 'failed') linkStatus = 'idle';
    syncLinkTick();
  }

  function connect() {
    closeLink();
    noDesktop = false;
    helloTries = 0;
    linkStatus = 'idle';
    if (!sessionId || !Transport || typeof Transport.createLink !== 'function' || isPageHidden()) {
      renderStatus();
      return;
    }
    const canLocal = transportParam === 'local' || transportParam === 'dual';
    const wsProto = root.location && root.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = canLocal && root.location
      ? wsProto + '//' + root.location.host + '/ws?s=' + encodeURIComponent(sessionId) + '&role=phone'
      : '';
    const httpBase = canLocal && root.location ? root.location.origin : '';

    linkStatus = 'connecting';
    const myLink = Transport.createLink({
      mode: canLocal ? 'dual' : 'mqtt',
      sessionId: sessionId,
      role: 'phone',
      wsUrl: wsUrl,
      httpBase: httpBase,
      onStatus: function (st, info) {
        if (link !== myLink) return;
        const prevStatus = linkStatus;
        const prevTransport = linkTransport;
        linkStatus = st;
        linkTransport = (info && info.transport) || 'mqtt';
        if (st === 'failed') {
          // Every sub-link hit its retry ceiling; a tap or a visible page retries.
          closeLink();
        } else if (st === 'ready' && (prevStatus !== 'ready' || prevTransport !== linkTransport)) {
          // Greet only when the usable path changes (the aggregate re-reports 'ready').
          sendHello();
        }
        syncLinkTick();
        renderStatus();
      },
      onMessage: function (msg) {
        if (link !== myLink) return;
        if (!msg || typeof msg !== 'object') return;
        if (msg.t === 'state' || msg.t === 'cmd' || msg.t === 'hb') markDesktopSeen();
        if (!tracker) return;
        if (msg.t === 'state') {
          if (Number.isFinite(msg.dialValue)) tracker.setValue(msg.dialValue);
          if (typeof msg.fineMode === 'boolean') tracker.setFineMode(msg.fineMode);
          renderPhoneUi(tracker.getState());
        } else if (msg.t === 'cmd') {
          if (msg.cmd === 'zero') {
            renderPhoneUi(tracker.zero());
          } else if (msg.cmd === 'reset') {
            renderPhoneUi(tracker.zero(50));
          } else if (msg.cmd === 'fine') {
            renderPhoneUi(tracker.setFineMode(Boolean(msg.val)));
          }
        }
      }
    });
    link = myLink;
    myLink.start();
    syncLinkTick();
    renderStatus();
  }

  // A link that hit the retry ceiling, timed out waiting for a desktop, or was paused by a
  // hidden page restarts only on a tap or when the page becomes visible again.
  refs.status.addEventListener('click', function () {
    if (!link) connect();
  });

  // =========================================================================
  // iOS 13+ Gyroscope & Orientation Permission Gate
  // =========================================================================

  function onDeviceOrientation(ev) {
    if (!ev) return;
    if (Number.isFinite(ev.webkitCompassHeading)) {
      latestCompassHeading = ev.webkitCompassHeading;
    }
    if (Number.isFinite(ev.alpha)) {
      latestOrientationAlpha = ev.alpha;
    }
  }

  // Permission granted (or not needed) does not mean a sensor exists: desktop browsers and
  // insecure pages never deliver usable samples. Re-open the gate instead of a dead dial.
  function onSensorProbeTimeout() {
    sensorProbeTimer = 0;
    if (gotSensorSample) return;
    stopSensors();
    refs.gate.hidden = false;
    refs.gateNote.textContent =
      'No gyroscope data from this browser. Use the touch ring, or open this page in iPhone Safari over HTTPS.';
  }

  function stopSensors() {
    sensorsActive = false;
    root.removeEventListener('deviceorientation', onDeviceOrientation);
    root.removeEventListener('devicemotion', onDeviceMotion);
    if (sensorProbeTimer) {
      clearTimeout(sensorProbeTimer);
      sensorProbeTimer = 0;
    }
    if (tracker) renderPhoneUi(tracker.getState());
  }

  function startSensors() {
    if (sensorsActive || !tracker) return;
    sensorsActive = true;
    refs.gate.hidden = true;
    root.addEventListener('deviceorientation', onDeviceOrientation);
    root.addEventListener('devicemotion', onDeviceMotion);
    if (!gotSensorSample) {
      if (sensorProbeTimer) clearTimeout(sensorProbeTimer);
      sensorProbeTimer = setTimeout(onSensorProbeTimeout, SENSOR_PROBE_MS);
    }
  }

  function onDeviceMotion(ev) {
    if (!ev) return;
    const rot = ev.rotationRate || {};
    const accG = ev.accelerationIncludingGravity || {};
    const acc = ev.acceleration || {};
    if (
      !gotSensorSample &&
      (Number.isFinite(rot.alpha) || Number.isFinite(rot.beta) || Number.isFinite(rot.gamma))
    ) {
      gotSensorSample = true;
    }
    const st = tracker.ingestMotion({
      alpha: rot.alpha,
      beta: rot.beta,
      gamma: rot.gamma,
      gx: accG.x,
      gy: accG.y,
      gz: accG.z,
      ax: acc.x,
      ay: acc.y,
      az: acc.z,
      webkitCompassHeading: latestCompassHeading,
      orientationAlpha: latestOrientationAlpha,
      ts: ev.timeStamp || Date.now()
    });
    if (st.detentDelta !== 0) {
      playDetentMicroTick(st.detentSlot % 6 === 0);
    }
    renderPhoneUi(st);
    transmitDialState(st, st.detentDelta !== 0);
  }

  refs.enableBtn.addEventListener('click', function () {
    // Unlock Web Audio context directly inside user gesture
    playDetentMicroTick(true);

    const needsMotionPerm = typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function';
    const needsOrientPerm = typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function';

    if (!needsMotionPerm && !needsOrientPerm) {
      startSensors();
      return;
    }

    const pMotion = needsMotionPerm
      ? DeviceMotionEvent.requestPermission()
      : Promise.resolve('granted');
    const pOrient = needsOrientPerm
      ? DeviceOrientationEvent.requestPermission().catch(function () { return 'denied'; })
      : Promise.resolve('granted');

    Promise.all([pMotion, pOrient])
      .then(function (results) {
        if (results[0] === 'granted') {
          startSensors();
        } else {
          refs.gateNote.textContent =
            'Gyroscope permission declined. Tap "Use Touch Ring Only" below to spin by touch.';
        }
      })
      .catch(function (err) {
        refs.gateNote.textContent =
          'HTTPS required on iOS for gyroscope (' + String((err && err.message) || err) + '). Use Touch Ring below.';
      });
  });

  refs.touchOnlyBtn.addEventListener('click', function () {
    playDetentMicroTick(true);
    refs.gate.hidden = true;
  });

  // =========================================================================
  // Direct Touch-Ring Scrubbing Fallback + Inertial Momentum
  // =========================================================================

  let dragState = null;

  function pointerDeg(clientX, clientY) {
    const rect = refs.wheelPad.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return DialLib.wrapAngle360((Math.atan2(clientY - cy, clientX - cx) * 180) / Math.PI + 90);
  }

  refs.wheelPad.addEventListener('pointerdown', function (e) {
    if (!refs.gate.hidden || !tracker) return;
    e.preventDefault();
    if (inertiaRaf) {
      cancelAnimationFrame(inertiaRaf);
      inertiaRaf = 0;
    }
    if (refs.wheelPad.setPointerCapture) {
      try { refs.wheelPad.setPointerCapture(e.pointerId); } catch (_err) {}
    }
    dragState = {
      pointerId: e.pointerId,
      lastAngle: pointerDeg(e.clientX, e.clientY),
      lastTime: performance.now(),
      vel: 0
    };
  });

  refs.wheelPad.addEventListener('pointermove', function (e) {
    if (!dragState || e.pointerId !== dragState.pointerId || !tracker) return;
    const now = performance.now();
    const dt = Math.max(0.004, Math.min(0.1, (now - dragState.lastTime) / 1000));
    const cur = pointerDeg(e.clientX, e.clientY);
    const delta = DialLib.wrapAngleDiffDeg(cur, dragState.lastAngle);
    dragState.lastAngle = cur;
    dragState.lastTime = now;
    dragState.vel = 0.65 * (delta / dt) + 0.35 * dragState.vel;

    const st = tracker.ingestDeltaAngle(delta, dt);
    if (st.detentDelta !== 0) playDetentMicroTick(st.detentSlot % 6 === 0);
    renderPhoneUi(st);
    transmitDialState(st, st.detentDelta !== 0);
  });

  function endTouchSpin(e, cancelled) {
    if (!dragState || (e && e.pointerId !== dragState.pointerId) || !tracker) return;
    const releaseVel = cancelled ? 0 : dragState.vel;
    dragState = null;
    if (Math.abs(releaseVel) > 30) {
      let vel = DialLib.clamp(releaseVel, -1080, 1080);
      let lastTs = performance.now();
      const tickInertia = function (now) {
        const dt = Math.max(0.004, Math.min(0.05, (now - lastTs) / 1000));
        lastTs = now;
        vel *= Math.exp(-dt / 0.55);
        if (Math.abs(vel) < 3) {
          const stFinal = settleVelocity();
          renderPhoneUi(stFinal);
          transmitDialState(stFinal, true);
          inertiaRaf = 0;
          return;
        }
        const st = tracker.ingestDeltaAngle(vel * dt, dt);
        if (st.detentDelta !== 0) playDetentMicroTick(st.detentSlot % 6 === 0);
        renderPhoneUi(st);
        transmitDialState(st, false);
        inertiaRaf = requestAnimationFrame(tickInertia);
      };
      inertiaRaf = requestAnimationFrame(tickInertia);
    } else {
      const st = settleVelocity();
      renderPhoneUi(st);
      transmitDialState(st, true);
    }
  }

  // Touch spin stopped: nothing else decays the velocity readout (gyro samples do, touch does not),
  // so a released ring would keep showing and sending its last RPM.
  function settleVelocity() {
    tracker.degPerSec = 0;
    tracker.rawDegPerSec = 0;
    tracker.rpm = 0;
    tracker.detentDelta = 0;
    tracker.stationary = true;
    return tracker.getState();
  }

  refs.wheelPad.addEventListener('pointerup', function (e) { endTouchSpin(e, false); });
  refs.wheelPad.addEventListener('pointercancel', function (e) { endTouchSpin(e, true); });

  // =========================================================================
  // Bottom Action Controls & Theme Switcher
  // =========================================================================

  refs.themeBtn.addEventListener('click', function () {
    const next = refs.body.dataset.theme === 'dark' ? 'light' : 'dark';
    refs.body.dataset.theme = next;
    refs.themeBtn.textContent = next === 'dark' ? '☀ Light' : '☾ Dark';
  });

  refs.zeroBtn.addEventListener('click', function () {
    if (!tracker) return;
    const st = tracker.zero();
    renderPhoneUi(st);
    transmitDialState(st, true);
    if (link) link.send({ t: 'act', cmd: 'zero' });
  });

  refs.fineBtn.addEventListener('click', function () {
    if (!tracker) return;
    const st = tracker.setFineMode(!tracker.fineMode);
    renderPhoneUi(st);
    if (link) link.send({ t: 'act', cmd: 'fine', val: st.fineMode });
  });

  refs.ticksBtn.addEventListener('click', function () {
    ticksEnabled = !ticksEnabled;
    refs.ticksBtn.setAttribute('aria-pressed', ticksEnabled ? 'true' : 'false');
    refs.ticksBtn.textContent = ticksEnabled ? 'Click Ticks: On' : 'Click Ticks: Off';
    if (ticksEnabled) playDetentMicroTick(true);
  });

  refs.resetBtn.addEventListener('click', function () {
    if (!tracker) return;
    const st = tracker.zero(50);
    renderPhoneUi(st);
    transmitDialState(st, true);
    if (link) link.send({ t: 'act', cmd: 'reset' });
  });

  function cleanupPhonePage() {
    if (inertiaRaf) {
      cancelAnimationFrame(inertiaRaf);
      inertiaRaf = 0;
    }
    closeLink();
    if (audioCtx) {
      try { audioCtx.close(); } catch (_e) {}
      audioCtx = null;
    }
  }

  if (typeof root.addEventListener === 'function') {
    root.addEventListener('pagehide', cleanupPhonePage);
    // Back/forward cache restore: pagehide closed the link, so reconnect.
    root.addEventListener('pageshow', function (ev) {
      if (ev && ev.persisted && !link) connect();
    });
  }

  // Hidden page (screen locked, app switched): no relay socket and no timers. Visible again:
  // reconnect, which is also the retry for a failed or timed-out link.
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', function () {
      if (isPageHidden()) {
        closeLink();
        renderStatus();
      } else if (!link) {
        connect();
      }
    });
  }

  if (tracker) {
    renderPhoneUi(tracker.getState());
  }
  connect();
})(typeof globalThis !== 'undefined' ? globalThis : window);
