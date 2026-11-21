(function (root) {
  'use strict';

  const NS = (root.MotionGrid = root.MotionGrid || {});
  const QR = NS.QR;
  const Physics = NS.Physics;
  const Transport = NS.Transport;

  const STORAGE_BASE_URL_KEY = 'mg_custom_https_base_v1';
  const STORAGE_SESSION_KEY = 'mg_session_id_v1';
  const LOCAL_BRIDGE_DEFAULT = 'http://127.0.0.1:8443';
  const MAX_QR_URL_BYTES = 213;

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'className') node.className = v;
        else if (k === 'textContent') node.textContent = String(v);
        else if (k === 'dataset') {
          Object.keys(v).forEach(function (dk) {
            if (v[dk] !== undefined && v[dk] !== null) node.dataset[dk] = String(v[dk]);
          });
        } else if (k === 'style' && typeof v === 'object') {
          Object.assign(node.style, v);
        } else if (k.startsWith('on') && typeof v === 'function') {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v === true) {
          node.setAttribute(k, '');
        } else {
          node.setAttribute(k, String(v));
        }
      });
    }
    if (children !== undefined && children !== null) {
      const list = Array.isArray(children) ? children : [children];
      list.forEach(function (c) {
        if (c === undefined || c === null || c === false) return;
        if (typeof c === 'string' || typeof c === 'number') {
          node.appendChild(document.createTextNode(String(c)));
        } else {
          node.appendChild(c);
        }
      });
    }
    return node;
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function safeStorageGet(storeName, key) {
    try {
      const store = root[storeName];
      return (store && store.getItem(key)) || '';
    } catch (_e) {
      return '';
    }
  }

  function safeStorageSet(storeName, key, val) {
    try {
      const store = root[storeName];
      if (!store) return;
      if (!val) store.removeItem(key);
      else store.setItem(key, val);
    } catch (_e) {}
  }

  function copyTextFallback(text, containerEl) {
    return new Promise(function (resolve, reject) {
      let ta = null;
      try {
        const host = (containerEl && containerEl.open ? containerEl : null) ||
          (typeof document.querySelector === 'function' ? document.querySelector('dialog[open]') : null) ||
          document.body;
        if (!host) {
          reject(new Error('No DOM container for clipboard fallback'));
          return;
        }
        ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
        host.appendChild(ta);
        ta.select();
        const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
        if (!ok) {
          reject(new Error('Clipboard copy command declined'));
          return;
        }
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        if (ta && ta.parentNode) {
          try { ta.parentNode.removeChild(ta); } catch (_e) {}
        }
      }
    });
  }

  function copyText(text, containerEl) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).catch(function () {
        return copyTextFallback(text, containerEl);
      });
    }
    return copyTextFallback(text, containerEl);
  }

  function prefersReducedMotion() {
    try {
      return Boolean(
        typeof root.matchMedia === 'function' &&
        root.matchMedia('(prefers-reduced-motion: reduce)').matches
      );
    } catch (_e) {
      return false;
    }
  }

  function isLocalhostHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h === '';
  }

  function utf8ByteLength(str) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(String(str)).length;
    }
    return String(str).length;
  }

  function normalizePhoneBaseUrl(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return '';
    try {
      const u = new URL(trimmed);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
      let p = u.pathname || '/';
      if (/\/index\.html?$/i.test(p)) {
        p = p.replace(/\/index\.html?$/i, '/cells/motion/phone.html');
      } else if (!/\/phone\.html?$/i.test(p)) {
        if (!p.endsWith('/')) p += '/';
        p += 'cells/motion/phone.html';
      }
      u.pathname = p;
      u.search = '';
      u.hash = '';
      return u.toString();
    } catch (_e) {
      return '';
    }
  }

  function buildQrTargetUrl(basePhoneUrl, sessionId, transportMode) {
    if (!basePhoneUrl) return '';
    const sep = basePhoneUrl.indexOf('?') >= 0 ? '&' : '?';
    return basePhoneUrl + sep + 's=' + encodeURIComponent(sessionId) + '&t=' + encodeURIComponent(transportMode || 'mqtt');
  }

  function mountMotionCell(rootEl) {
    if (!rootEl || !QR || !Physics || !Transport) return undefined;

    if (typeof rootEl._mgUnmount === 'function') {
      rootEl._mgUnmount();
    }

    const gridEl = (typeof rootEl.closest === 'function' && rootEl.closest('.grid')) || document.querySelector('.grid');
    if (!gridEl) return undefined;

    let sessionId = safeStorageGet('sessionStorage', STORAGE_SESSION_KEY);
    if (!Transport.isValidSessionId(sessionId)) {
      sessionId = Transport.generateSessionId(8);
      safeStorageSet('sessionStorage', STORAGE_SESSION_KEY, sessionId);
    }

    const state = {
      sessionId: sessionId,
      mode: 'all',          // 'all' | 'tilt' | 'lift' | 'pull'
      layout: 'reflow',     // 'reflow' | 'fixed3'
      scale: Physics.DEFAULT_SCALE,
      baseCellW: 420,
      maxCellW: Physics.MAX_CELL_W,
      currentCellW: 420,
      cols: 3,
      controlled: false,

      // Link & phone status
      linkState: 'connecting',
      linkTransport: 'mqtt',
      phoneConnected: false,
      lastPhoneMs: 0,
      rxCount: 0,
      rxHz: 0,
      lastHzTick: Date.now(),

      // Latest phone sensor vector
      roll: 0,
      pitch: 0,
      liftA: 0,
      pullA: 0,

      // Resolved HTTPS URL for QR code
      phoneBaseUrl: '',
      phoneUrlSource: 'none',
      phoneUrlIsHttps: false,
      qrUrl: '',
      qrError: '',
      customUrlInput: safeStorageGet('localStorage', STORAGE_BASE_URL_KEY),
      bridgeConfig: null
    };

    const spring = new Physics.SpringDamper(Physics.DEFAULT_SCALE, 190, 26);
    let rafId = 0;
    let lastRafTs = 0;
    let link = null;
    let hzTimer = 0;
    let feedbackTimer = 0;
    let bridgePollTimer = 0;
    let bridgePollAttempts = 0;
    let probeSeq = 0;
    let activeProbeController = null;
    let activeProbeTimer = 0;
    let copyFeedbackTimer = 0;
    let lastDialogTrigger = null;
    let unmounted = false;

    // Measure baseline 3-column cell width from original index.html geometry (never inflated by .is-motion-controlled)
    function measureBaseCellWidth() {
      const bodyStyle = window.getComputedStyle(document.body);
      const padX = (parseFloat(bodyStyle.paddingLeft) || 0) + (parseFloat(bodyStyle.paddingRight) || 0);
      const docW = document.documentElement.clientWidth || window.innerWidth;
      const contentW = Math.max(240, docW - padX);
      const baselineGridW = Math.min(contentW, docW * 0.92, 1600);
      const naturalCols = docW >= 768 ? 3 : 2;
      const gap = 4;
      const naturalW = Math.round((baselineGridW - gap * (naturalCols - 1)) / naturalCols);
      state.baseCellW = Physics.clamp(naturalW, 180, 560);
      if (!state.controlled) {
        state.currentCellW = state.baseCellW;
        state.cols = naturalCols;
      }
    }

    function computeMaxCellWidth() {
      const bodyStyle = window.getComputedStyle(document.body);
      const padX = (parseFloat(bodyStyle.paddingLeft) || 0) + (parseFloat(bodyStyle.paddingRight) || 0);
      const docW = document.documentElement.clientWidth || window.innerWidth;
      const avail = Math.max(240, Math.min(docW - padX, docW * 0.92, 1600));
      if (state.layout === 'fixed3') {
        const fixedCols = docW >= 768 ? 3 : 2;
        const gap = 4;
        return Math.max(Physics.MIN_CELL_W, Math.floor((avail - gap * (fixedCols - 1)) / fixedCols));
      }
      return Math.min(Physics.MAX_CELL_W, Math.floor(avail));
    }

    function applyGridSize(scaleVal, forceActive) {
      const clampedScale = Physics.clamp(scaleVal, Physics.MIN_SCALE, Physics.MAX_SCALE);
      state.scale = clampedScale;

      const docW = document.documentElement.clientWidth || window.innerWidth;
      const maxCellW = computeMaxCellWidth();
      state.maxCellW = maxCellW;
      const cellW = Physics.scaleToCellWidth(clampedScale, state.baseCellW, maxCellW);
      state.currentCellW = cellW;

      const isNearDefault = Math.abs(clampedScale - 1.0) < 0.008 && !forceActive && !state.phoneConnected;
      if (isNearDefault) {
        state.controlled = false;
        gridEl.classList.remove('is-motion-controlled');
        gridEl.style.removeProperty('--mg-cell-w');
        gridEl.removeAttribute('data-motion-layout');
        state.cols = docW >= 768 ? 3 : 2;
      } else {
        state.controlled = true;
        gridEl.classList.add('is-motion-controlled');
        gridEl.setAttribute('data-motion-layout', state.layout);
        gridEl.style.setProperty('--mg-cell-w', cellW + 'px');
        if (state.layout === 'fixed3') {
          state.cols = docW >= 768 ? 3 : 2;
        } else {
          const gridAvail = gridEl.clientWidth || maxCellW;
          state.cols = Math.max(1, Math.floor((gridAvail + 4) / (cellW + 4)));
        }
      }

      updateLiveDom();
    }

    function ensureSpringRunning() {
      if (unmounted || rafId) return;
      lastRafTs = performance.now();
      rafId = requestAnimationFrame(tickSpring);
    }

    function tickSpring(now) {
      if (unmounted) {
        rafId = 0;
        return;
      }
      const dt = Math.min(0.05, Math.max(0.001, (now - lastRafTs) / 1000));
      lastRafTs = now;
      const moving = spring.step(dt);
      applyGridSize(spring.value, state.phoneConnected || Math.abs(spring.target - 1.0) >= 0.008);
      if (moving && !unmounted) {
        rafId = requestAnimationFrame(tickSpring);
      } else {
        rafId = 0;
      }
    }

    function setTargetScale(target, immediate) {
      const clamped = Physics.clamp(target, Physics.MIN_SCALE, Physics.MAX_SCALE);
      if (immediate || prefersReducedMotion()) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        spring.snap(clamped);
        applyGridSize(clamped, Math.abs(clamped - 1.0) >= 0.008 || state.phoneConnected);
      } else {
        spring.setTarget(clamped);
        ensureSpringRunning();
      }
    }

    function resetToDefault() {
      state.roll = 0;
      state.pitch = 0;
      state.liftA = 0;
      state.pullA = 0;
      setTargetScale(Physics.DEFAULT_SCALE, false);
      sendToPhone({ t: 'cmd', cmd: 'reset' });
    }

    function sendToPhone(msg) {
      if (link) link.send(msg);
    }

    function sendFeedbackToPhone() {
      if (!state.phoneConnected) return;
      sendToPhone({
        t: 'state',
        cellW: state.currentCellW,
        scale: Number(state.scale.toFixed(3)),
        cols: state.cols,
        layout: state.layout,
        mode: state.mode,
        baseW: state.baseCellW,
        maxW: state.maxCellW
      });
    }

    // ---------- URL Resolution & Bridge Discovery ----------

    function recomputeQrUrl() {
      let base = '';
      let source = 'none';
      let transportParam = 'mqtt';
      state.qrError = '';

      // 1. User's explicit custom URL override always wins if configured
      if (state.customUrlInput) {
        const norm = normalizePhoneBaseUrl(state.customUrlInput);
        if (norm) {
          base = norm;
          source = 'custom';
          transportParam = 'mqtt';
        }
      }

      // 2. Live local bridge (server.mjs) when httpsReady is true
      if (!base && state.bridgeConfig && state.bridgeConfig.httpsReady && state.bridgeConfig.phoneBaseUrl) {
        base = state.bridgeConfig.phoneBaseUrl;
        source = 'local-bridge';
        transportParam = state.bridgeConfig.transport || 'dual';
      }

      // 3. Hosted HTTPS origin (GitHub Pages, ngrok, Tailscale, Vercel, Netlify)
      if (!base && window.location.protocol === 'https:' && !isLocalhostHost(window.location.hostname)) {
        const dir = window.location.pathname.replace(/[^/]*$/, '');
        base = window.location.origin + dir + 'cells/motion/phone.html';
        source = 'origin-https';
        transportParam = 'mqtt';
      }

      const candidateQr = base ? buildQrTargetUrl(base, state.sessionId, transportParam) : '';
      if (candidateQr && utf8ByteLength(candidateQr) > MAX_QR_URL_BYTES) {
        state.qrError = 'URL exceeds 213-byte QR limit; use a shorter HTTPS host.';
        state.phoneBaseUrl = '';
        state.phoneUrlSource = 'none';
        state.phoneUrlIsHttps = false;
        state.qrUrl = '';
      } else {
        state.phoneBaseUrl = base;
        state.phoneUrlSource = source;
        state.phoneUrlIsHttps = base.startsWith('https://');
        state.qrUrl = candidateQr;
      }

      renderQrTargets();
      updateLiveDom();
    }

    function probeLocalBridge() {
      if (unmounted) return;
      const mySeq = ++probeSeq;
      clearTimeout(bridgePollTimer);
      bridgePollTimer = 0;
      if (activeProbeTimer) {
        clearTimeout(activeProbeTimer);
        activeProbeTimer = 0;
      }
      if (activeProbeController) {
        try { activeProbeController.abort(); } catch (_e) {}
        activeProbeController = null;
      }

      const candidates = [];
      if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
        candidates.push(window.location.origin + '/api/motion-config');
      }
      if (candidates.indexOf(LOCAL_BRIDGE_DEFAULT + '/api/motion-config') < 0) {
        candidates.push(LOCAL_BRIDGE_DEFAULT + '/api/motion-config');
      }

      let idx = 0;
      function tryNext() {
        if (unmounted || mySeq !== probeSeq || idx >= candidates.length) return;
        const url = candidates[idx++];
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        activeProbeController = controller;
        const timer = setTimeout(function () {
          if (activeProbeTimer === timer) activeProbeTimer = 0;
          if (controller) {
            try { controller.abort(); } catch (_e) {}
          }
        }, 1800);
        activeProbeTimer = timer;

        fetch(url, {
          method: 'GET',
          signal: controller ? controller.signal : undefined,
          headers: { 'ngrok-skip-browser-warning': '1' }
        })
          .then(function (res) {
            clearTimeout(timer);
            if (activeProbeTimer === timer) activeProbeTimer = 0;
            if (activeProbeController === controller) activeProbeController = null;
            if (unmounted || mySeq !== probeSeq) return null;
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (cfg) {
            if (unmounted || mySeq !== probeSeq || !cfg) return;
            if (cfg.ok) {
              const prevUrl = state.bridgeConfig && state.bridgeConfig.phoneBaseUrl;
              const prevWs = state.bridgeConfig && state.bridgeConfig.desktopWsUrl;
              state.bridgeConfig = cfg;
              if (cfg.phoneBaseUrl !== prevUrl) {
                recomputeQrUrl();
              }
              if (cfg.desktopWsUrl !== prevWs) {
                connectTransport();
              }
              // If ngrok tunnel is still starting up, re-probe briefly to upgrade QR from LAN self-signed to ngrok
              if (cfg.tunnelPending && bridgePollAttempts < 6 && !unmounted) {
                bridgePollAttempts++;
                clearTimeout(bridgePollTimer);
                bridgePollTimer = setTimeout(probeLocalBridge, 1200);
              }
            } else {
              tryNext();
            }
          })
          .catch(function () {
            clearTimeout(timer);
            if (activeProbeTimer === timer) activeProbeTimer = 0;
            if (activeProbeController === controller) activeProbeController = null;
            if (unmounted || mySeq !== probeSeq) return;
            tryNext();
          });
      }
      tryNext();
    }

    // ---------- Transport Lifecycle ----------

    function connectTransport() {
      if (link) {
        link.close();
        link = null;
      }

      const hasBridge = Boolean(state.bridgeConfig && state.bridgeConfig.desktopWsUrl);
      const wsUrl = hasBridge
        ? state.bridgeConfig.desktopWsUrl + '?s=' + encodeURIComponent(state.sessionId) + '&role=desktop'
        : '';
      const httpBase = hasBridge ? state.bridgeConfig.desktopHttpBase : '';

      link = Transport.createLink({
        mode: hasBridge ? 'dual' : 'mqtt',
        sessionId: state.sessionId,
        role: 'desktop',
        wsUrl: wsUrl,
        httpBase: httpBase,
        onStatus: function (st, info) {
          state.linkState = st;
          state.linkTransport = (info && info.transport) || 'mqtt';
          updateLiveDom();
        },
        onMessage: handlePhoneMessage
      });
      link.start();
    }

    function handlePhoneMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      const now = Date.now();
      state.lastPhoneMs = now;
      if (!state.phoneConnected) {
        state.phoneConnected = true;
        closeStudio();
        sendFeedbackToPhone();
      }

      if (msg.t === 'hello') {
        sendFeedbackToPhone();
        updateLiveDom();
        return;
      }

      if (msg.t === 'act') {
        if (msg.cmd === 'reset') {
          resetToDefault();
        } else if (msg.cmd === 'layout' && (msg.val === 'reflow' || msg.val === 'fixed3')) {
          state.layout = msg.val;
          applyGridSize(state.scale, true);
          sendFeedbackToPhone();
        } else if (msg.cmd === 'mode' && ['all', 'tilt', 'lift', 'pull'].indexOf(msg.val) >= 0) {
          state.mode = msg.val;
          updateLiveDom();
        }
        return;
      }

      if (msg.t === 'm') {
        state.rxCount++;
        if (typeof msg.mode === 'string' && ['all', 'tilt', 'lift', 'pull'].indexOf(msg.mode) >= 0) {
          state.mode = msg.mode;
        }
        if (Number.isFinite(msg.roll)) state.roll = msg.roll;
        if (Number.isFinite(msg.pitch)) state.pitch = msg.pitch;
        if (Number.isFinite(msg.lift)) state.liftA = msg.lift;
        if (Number.isFinite(msg.pull)) state.pullA = msg.pull;
        if (Number.isFinite(msg.scale)) {
          setTargetScale(msg.scale, false);
        }
        updateLiveDom();
      }
    }

    hzTimer = setInterval(function () {
      const now = Date.now();
      const elapsed = Math.max(250, now - state.lastHzTick);
      state.rxHz = Math.round((state.rxCount * 1000) / elapsed);
      state.rxCount = 0;
      state.lastHzTick = now;

      if (state.phoneConnected && now - state.lastPhoneMs > 6500) {
        state.phoneConnected = false;
        applyGridSize(state.scale, false);
      } else if (state.phoneConnected) {
        updateLiveDom();
      }
    }, 1000);

    feedbackTimer = setInterval(function () {
      if (state.phoneConnected) sendFeedbackToPhone();
    }, 220);

    // ---------- Build DOM (Zero innerHTML interpolation) ----------

    const refs = {};

    function setAxisBar(barEl, valEl, value, maxRange, suffix) {
      if (!barEl || !valEl) return;
      const pct = Physics.clamp(value / maxRange, -1, 1);
      const half = Math.abs(pct) * 50;
      barEl.style.left = pct >= 0 ? '50%' : (50 - half) + '%';
      barEl.style.width = half + '%';
      valEl.textContent = (value >= 0 ? '+' : '−') + Math.abs(value).toFixed(1) + (suffix || '');
    }

    function renderQrTargets() {
      clearNode(refs.cardQrFrame);
      clearNode(refs.dlgQrBox);

      let cardSvg = null;
      let dlgSvg = null;
      if (state.qrUrl) {
        try {
          cardSvg = QR.renderSVGElement(state.qrUrl, {
            quiet: 4,
            fg: '#141413',
            bg: '#ffffff',
            label: 'Scan with iPhone camera to open Motion Grid Controller'
          }).svg;
          dlgSvg = QR.renderSVGElement(state.qrUrl, {
            quiet: 4,
            fg: '#141413',
            bg: '#ffffff',
            label: 'Large QR code for iPhone motion controller'
          }).svg;
        } catch (err) {
          state.qrError = String(err && err.message || 'QR encode failed');
          cardSvg = null;
          dlgSvg = null;
        }
      }

      if (cardSvg && dlgSvg) {
        refs.cardQrFrame.classList.remove('is-unconfigured');
        refs.cardQrFrame.title = 'Click to enlarge QR code for scanning';
        refs.cardQrFrame.appendChild(cardSvg);
        refs.cardQrCaption.textContent = state.phoneUrlIsHttps
          ? 'Scan with iPhone · HTTPS'
          : 'Scan · Needs HTTPS on iOS';

        refs.dlgQrBox.appendChild(dlgSvg);
        refs.dlgUrlText.textContent = state.qrUrl;
      } else {
        refs.cardQrFrame.classList.add('is-unconfigured');
        refs.cardQrFrame.title = 'Click to configure HTTPS QR bridge';
        refs.cardQrFrame.appendChild(
          el('div', { className: 'mg-qr-setup-box' }, [
            el('div', { className: 'mg-qr-setup-title', textContent: state.qrError ? 'QR URL Too Long' : 'HTTPS Bridge Needed' }),
            el('div', {
              className: 'mg-qr-setup-sub',
              textContent: state.qrError || 'iOS requires HTTPS for accelerometer. Click for 1-cmd setup.'
            })
          ])
        );
        refs.cardQrCaption.textContent = state.qrError ? 'Shorten HTTPS URL' : 'Run bridge or set HTTPS URL';

        refs.dlgQrBox.appendChild(
          el('div', { className: 'mg-qr-setup-box', style: { padding: '16px' } }, [
            el('div', { className: 'mg-qr-setup-title', textContent: state.qrError ? 'QR Limit Exceeded' : 'Waiting for HTTPS Host' }),
            el('div', {
              className: 'mg-qr-setup-sub',
              textContent: state.qrError || 'Run "node cells/motion/server.mjs" in this repo or paste any HTTPS URL on the right to generate a scannable iPhone QR code.'
            })
          ])
        );
        refs.dlgUrlText.textContent = state.qrError || 'No HTTPS phone URL detected yet.';
      }
      if (refs.dlgErr) {
        refs.dlgErr.textContent = state.qrError || '';
      }
    }

    function updateLiveDom() {
      if (state.phoneConnected) {
        refs.statusPill.dataset.state = 'live';
        refs.statusText.textContent = state.rxHz > 0 ? 'LIVE · ' + state.rxHz + 'Hz' : 'PHONE LIVE';
      } else if (!state.qrUrl) {
        refs.statusPill.dataset.state = 'warn';
        refs.statusText.textContent = 'SETUP';
      } else if (state.linkState === 'ready') {
        refs.statusPill.dataset.state = 'ready';
        refs.statusText.textContent = 'SCAN QR';
      } else {
        refs.statusPill.dataset.state = 'warn';
        refs.statusText.textContent = 'LINKING';
      }

      const scaleLabel = state.scale.toFixed(2) + '×';
      const pxLabel = state.currentCellW + ' px';
      refs.sizeBig.textContent = pxLabel;
      refs.scaleChip.textContent = scaleLabel;
      refs.gridMeta.textContent = state.cols + ' col · ' + (state.layout === 'reflow' ? 'Reflow' : '3×3');

      refs.microVal.textContent = pxLabel;
      refs.microSub.textContent = scaleLabel + ' · ' + state.cols + 'c';
      const pct = ((state.scale - Physics.MIN_SCALE) / (Physics.MAX_SCALE - Physics.MIN_SCALE)) * 100;
      refs.microFill.style.width = Physics.clamp(pct, 4, 100) + '%';

      if (document.activeElement !== refs.slider) {
        refs.slider.value = String(Math.round(state.scale * 100));
      }

      setAxisBar(refs.barTilt, refs.valTilt, state.roll, 55, '°');
      setAxisBar(refs.barLift, refs.valLift, state.liftA, 10, '');
      setAxisBar(refs.barPull, refs.valPull, state.pullA, 10, '');

      Object.keys(refs.modeBtns).forEach(function (m) {
        refs.modeBtns[m].setAttribute('aria-pressed', state.mode === m ? 'true' : 'false');
      });

      const isLocked3 = state.layout === 'fixed3';
      refs.layoutBtn.textContent = isLocked3 ? 'Lock 3×3' : 'Reflow';
      refs.layoutBtn.classList.toggle('is-active', isLocked3);
      refs.layoutBtn.setAttribute('aria-pressed', isLocked3 ? 'true' : 'false');

      const txName = state.linkTransport === 'local-ws'
        ? 'LOCAL WS'
        : state.linkTransport === 'local-http'
          ? 'LOCAL HTTPS'
          : 'MQTT WSS';
      refs.footerLink.textContent = txName + ' · ' + state.sessionId.slice(0, 4);

      const isOffset = Math.abs(state.scale - 1.0) >= 0.02;
      refs.resetBtn.classList.toggle('is-active', isOffset);

      const showHud = isOffset || state.phoneConnected;
      refs.hud.classList.toggle('is-visible', showHud);
      refs.hud.dataset.live = state.phoneConnected ? 'true' : 'false';
      refs.hudVal.textContent = (state.phoneConnected ? 'iPhone · ' : 'Grid · ') + pxLabel + ' (' + scaleLabel + ')';
      refs.hudZeroBtn.hidden = !state.phoneConnected;
    }

    // Build Cell #3 Card
    clearNode(rootEl);

    refs.statusText = el('span', { textContent: 'LINKING' });
    refs.statusPill = el('button', {
      type: 'button',
      className: 'mg-pill',
      title: 'Open Pairing Studio & QR code',
      onClick: function (ev) { openStudio(ev.currentTarget); }
    }, [
      el('span', { className: 'mg-dot', 'aria-hidden': 'true' }),
      refs.statusText
    ]);

    const header = el('header', { className: 'mg-header' }, [
      el('div', { className: 'mg-brand' }, [
        el('span', { className: 'mg-index', textContent: '03' }),
        el('span', { className: 'mg-title', textContent: 'Motion Grid' })
      ]),
      el('div', { className: 'mg-actions' }, [
        refs.statusPill,
        el('button', {
          type: 'button',
          className: 'mg-icon-btn',
          'aria-label': 'Open large QR & setup studio',
          title: 'Open large QR & setup studio',
          onClick: function (ev) { openStudio(ev.currentTarget); }
        }, [
          el('span', { className: 'mg-expand-label', textContent: 'QR ' }),
          '↗'
        ])
      ])
    ]);

    refs.cardQrFrame = el('button', {
      type: 'button',
      className: 'mg-qr-frame',
      'aria-label': 'Open iPhone QR Pairing Studio',
      onClick: function (ev) { openStudio(ev.currentTarget); }
    });
    refs.cardQrCaption = el('div', { className: 'mg-qr-caption', textContent: 'Loading QR…' });

    refs.sizeBig = el('span', { className: 'mg-size-big', textContent: '420 px' });
    refs.scaleChip = el('span', { className: 'mg-scale-chip', textContent: '1.00×' });
    refs.gridMeta = el('span', { textContent: '3 col · Reflow' });

    refs.valTilt = el('span', { textContent: '+0.0°' });
    refs.barTilt = el('span', { className: 'mg-axis-bar is-accent' });
    refs.valLift = el('span', { textContent: '+0.0' });
    refs.barLift = el('span', { className: 'mg-axis-bar' });
    refs.valPull = el('span', { textContent: '+0.0' });
    refs.barPull = el('span', { className: 'mg-axis-bar' });

    function makeAxis(label, valNode, barNode) {
      return el('div', { className: 'mg-axis' }, [
        el('div', { className: 'mg-axis-head' }, [
          el('span', { textContent: label }),
          valNode
        ]),
        el('div', { className: 'mg-axis-track' }, [
          el('span', { className: 'mg-axis-mid' }),
          barNode
        ])
      ]);
    }

    refs.modeBtns = {};
    const modeOrder = [
      { id: 'all', label: 'All' },
      { id: 'tilt', label: 'Tilt' },
      { id: 'lift', label: 'Lift' },
      { id: 'pull', label: 'Pull' }
    ];
    const modeSeg = el('div', { className: 'mg-seg', role: 'group', 'aria-label': 'Motion gesture mode' },
      modeOrder.map(function (m) {
        const b = el('button', {
          type: 'button',
          className: 'mg-seg-btn',
          'aria-pressed': state.mode === m.id ? 'true' : 'false',
          textContent: m.label,
          onClick: function () {
            state.mode = m.id;
            sendToPhone({ t: 'cmd', cmd: 'mode', val: m.id });
            updateLiveDom();
          }
        });
        refs.modeBtns[m.id] = b;
        return b;
      })
    );

    refs.slider = el('input', {
      type: 'range',
      className: 'mg-slider',
      min: String(Math.round(Physics.MIN_SCALE * 100)),
      max: String(Math.round(Physics.MAX_SCALE * 100)),
      value: '100',
      'aria-label': 'Simulate phone motion cell size',
      onInput: function (ev) {
        const nextScale = Number(ev.target.value) / 100;
        state.roll = (nextScale - 1.0) * 45;
        setTargetScale(nextScale, false);
        if (state.phoneConnected) {
          sendToPhone({ t: 'cmd', cmd: 'setScale', val: Number(nextScale.toFixed(3)) });
        }
      }
    });

    const body = el('div', { className: 'mg-body' }, [
      el('div', { className: 'mg-qr-col' }, [
        refs.cardQrFrame,
        refs.cardQrCaption
      ]),
      el('div', { className: 'mg-ctrl-col' }, [
        el('div', { className: 'mg-readout-card' }, [
          el('div', { className: 'mg-readout-top' }, [refs.sizeBig, refs.scaleChip]),
          el('div', { className: 'mg-readout-meta' }, [
            el('span', { className: 'mg-meta-label', textContent: 'CELL WIDTH' }),
            refs.gridMeta
          ])
        ]),
        el('div', { className: 'mg-axes' }, [
          makeAxis('TILT', refs.valTilt, refs.barTilt),
          makeAxis('LIFT', refs.valLift, refs.barLift),
          makeAxis('PULL', refs.valPull, refs.barPull)
        ]),
        el('div', { className: 'mg-seg-row' }, [modeSeg]),
        el('div', { className: 'mg-scrub-wrap' }, [
          el('div', { className: 'mg-scrub-label' }, [
            el('span', { textContent: 'TEST SIZE' }),
            el('span', { className: 'mg-scrub-hint', textContent: 'R = Reset' })
          ]),
          refs.slider
        ])
      ])
    ]);

    refs.microVal = el('div', { className: 'mg-micro-val', textContent: '160 px' });
    refs.microSub = el('div', { className: 'mg-micro-sub', textContent: '0.38×' });
    refs.microFill = el('div', { className: 'mg-micro-fill', style: { width: '40%' } });
    const micro = el('div', { className: 'mg-micro' }, [
      refs.microVal,
      refs.microSub,
      el('div', { className: 'mg-micro-bar' }, [refs.microFill]),
      el('button', {
        type: 'button',
        className: 'mg-chip-btn',
        textContent: 'Reset 100%',
        onClick: resetToDefault
      })
    ]);

    refs.footerLink = el('span', { textContent: 'MQTT WSS' });
    refs.layoutBtn = el('button', {
      type: 'button',
      className: 'mg-chip-btn',
      textContent: 'Reflow',
      'aria-pressed': 'false',
      title: 'Toggle between responsive column reflow and locked 3x3 grid',
      onClick: function () {
        state.layout = state.layout === 'reflow' ? 'fixed3' : 'reflow';
        applyGridSize(state.scale, state.controlled);
        sendFeedbackToPhone();
      }
    });
    refs.resetBtn = el('button', {
      type: 'button',
      className: 'mg-chip-btn',
      textContent: '100%',
      title: 'Reset grid cell size to default (R)',
      onClick: resetToDefault
    });

    const footer = el('footer', { className: 'mg-footer' }, [
      el('div', { className: 'mg-footer-group' }, [refs.footerLink]),
      el('div', { className: 'mg-footer-group' }, [refs.layoutBtn, refs.resetBtn])
    ]);

    rootEl.appendChild(header);
    rootEl.appendChild(body);
    rootEl.appendChild(micro);
    rootEl.appendChild(footer);

    refs.hudVal = el('span', { className: 'mg-hud-val', textContent: 'Grid · 420 px (1.00×)' });
    refs.hudZeroBtn = el('button', {
      type: 'button',
      className: 'mg-hud-btn',
      textContent: 'Zero',
      hidden: true,
      onClick: function () { sendToPhone({ t: 'cmd', cmd: 'zero' }); }
    });
    refs.hud = el('div', { className: 'mg-hud', role: 'status', 'aria-live': 'polite' }, [
      el('span', { className: 'mg-hud-dot', 'aria-hidden': 'true' }),
      refs.hudVal,
      refs.hudZeroBtn,
      el('button', {
        type: 'button',
        className: 'mg-hud-btn',
        textContent: 'Reset 100%',
        onClick: resetToDefault
      })
    ]);
    document.body.appendChild(refs.hud);

    function applyCustomUrl() {
      const val = refs.dlgUrlInput.value.trim();
      if (!val) {
        state.customUrlInput = '';
        safeStorageSet('localStorage', STORAGE_BASE_URL_KEY, '');
        recomputeQrUrl();
        return;
      }
      const norm = normalizePhoneBaseUrl(val);
      if (!norm) {
        refs.dlgErr.textContent = 'Enter a valid https:// URL.';
        return;
      }
      const testQr = buildQrTargetUrl(norm, state.sessionId, 'mqtt');
      if (utf8ByteLength(testQr) > MAX_QR_URL_BYTES) {
        refs.dlgErr.textContent = 'URL too long for QR (max 213 bytes).';
        return;
      }
      state.customUrlInput = val;
      safeStorageSet('localStorage', STORAGE_BASE_URL_KEY, val);
      recomputeQrUrl();
    }

    refs.dlgQrBox = el('div', { className: 'mg-dlg-qr-box' });
    refs.dlgUrlText = el('div', { className: 'mg-dlg-url', textContent: '' });
    refs.dlgErr = el('div', { className: 'mg-dlg-err', textContent: '' });
    refs.dlgUrlInput = el('input', {
      type: 'url',
      className: 'mg-input',
      'aria-label': 'Custom HTTPS phone controller URL',
      placeholder: 'https://your-host.example/cells/motion/phone.html',
      value: state.customUrlInput,
      onKeydown: function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          applyCustomUrl();
        }
      }
    });
    refs.dlgCopyBtn = el('button', {
      type: 'button',
      className: 'mg-btn mg-btn--sm',
      textContent: 'Copy',
      onClick: function () {
        copyText('node cells/motion/server.mjs', refs.dialog)
          .then(function () {
            if (unmounted) return;
            refs.dlgCopyBtn.textContent = 'Copied!';
            clearTimeout(copyFeedbackTimer);
            copyFeedbackTimer = setTimeout(function () {
              if (!unmounted) refs.dlgCopyBtn.textContent = 'Copy';
            }, 1500);
          })
          .catch(function () {
            if (unmounted) return;
            refs.dlgCopyBtn.textContent = 'Copy failed';
            clearTimeout(copyFeedbackTimer);
            copyFeedbackTimer = setTimeout(function () {
              if (!unmounted) refs.dlgCopyBtn.textContent = 'Copy';
            }, 1500);
          });
      }
    });

    refs.dialog = el('dialog', { className: 'mg-dialog', 'aria-label': 'iPhone Motion Grid Pairing Studio' }, [
      el('div', { className: 'mg-dlg-bar' }, [
        el('div', { className: 'mg-dlg-title', textContent: 'iPhone Motion Controller — QR & HTTPS Pairing' }),
        el('button', {
          type: 'button',
          className: 'mg-btn mg-btn--sm',
          textContent: 'Close',
          onClick: function () { closeStudio(); }
        })
      ]),
      el('div', { className: 'mg-dlg-body' }, [
        el('div', { className: 'mg-dlg-qr-panel' }, [
          refs.dlgQrBox,
          refs.dlgUrlText,
          el('div', { style: { display: 'flex', gap: '6px', width: '100%' } }, [
            el('button', {
              type: 'button',
              className: 'mg-btn mg-btn--sm',
              style: { flex: '1' },
              textContent: 'New Session',
              onClick: function () {
                state.sessionId = Transport.generateSessionId(8);
                safeStorageSet('sessionStorage', STORAGE_SESSION_KEY, state.sessionId);
                state.phoneConnected = false;
                applyGridSize(state.scale, false);
                recomputeQrUrl();
                connectTransport();
              }
            }),
            el('button', {
              type: 'button',
              className: 'mg-btn mg-btn--sm',
              style: { flex: '1' },
              textContent: 'Retry Bridge',
              onClick: function () {
                bridgePollAttempts = 0;
                probeLocalBridge();
              }
            })
          ])
        ]),
        el('div', { className: 'mg-dlg-side' }, [
          el('div', { className: 'mg-dlg-section' }, [
            el('div', { className: 'mg-dlg-label', textContent: '1. Instant Local HTTPS Bridge (Recommended)' }),
            el('p', {
              className: 'mg-dlg-note',
              textContent: 'iOS Safari strictly requires HTTPS to unlock the iPhone accelerometer. Run this zero-dependency command from the repo root — it auto-launches a trusted HTTPS tunnel (ngrok or LAN HTTPS) and populates the QR code automatically:'
            }),
            el('div', { className: 'mg-cmd-box' }, [
              el('code', { textContent: 'node cells/motion/server.mjs' }),
              refs.dlgCopyBtn
            ])
          ]),
          el('div', { className: 'mg-dlg-section' }, [
            el('div', { className: 'mg-dlg-label', textContent: '2. Or Use Any Hosted HTTPS URL' }),
            el('p', {
              className: 'mg-dlg-note',
              textContent: 'If this repo is served on GitHub Pages, Tailscale Serve, Vercel, or ngrok, paste the HTTPS URL below (clear to revert to auto-detected bridge). Phone telemetry relays securely over MQTT WSS with zero backend.'
            }),
            el('div', { className: 'mg-input-row' }, [
              refs.dlgUrlInput,
              el('button', {
                type: 'button',
                className: 'mg-btn mg-btn--dark',
                textContent: 'Set URL',
                onClick: applyCustomUrl
              })
            ]),
            refs.dlgErr
          ]),
          el('div', { className: 'mg-dlg-section' }, [
            el('div', { className: 'mg-dlg-label', textContent: '3. Gestures Supported on iPhone' }),
            el('p', {
              className: 'mg-dlg-note',
              textContent: 'Rotate/tilt the phone like a dial, raise it up or lower it down (gravity-compensated world-up accelerometer), or pull it toward you / push it away. Tap "Zero Pose" on the phone to re-anchor any grip.'
            })
          ])
        ])
      ])
    ]);

    function restoreDialogFocus() {
      const target = lastDialogTrigger;
      lastDialogTrigger = null;
      if (!unmounted && target && target.isConnected !== false && typeof target.focus === 'function') {
        try { target.focus(); } catch (_e) {}
      }
    }

    refs.dialog.addEventListener('close', restoreDialogFocus);
    refs.dialog.addEventListener('click', function (ev) {
      if (ev.target === refs.dialog) closeStudio();
    });
    document.body.appendChild(refs.dialog);

    function openStudio(triggerEl) {
      const candidate = triggerEl || document.activeElement;
      if (candidate && candidate !== document.body && typeof candidate.focus === 'function') {
        lastDialogTrigger = candidate;
      }
      bridgePollAttempts = 0;
      probeLocalBridge();
      if (typeof refs.dialog.showModal === 'function') {
        if (!refs.dialog.open) refs.dialog.showModal();
      } else {
        refs.dialog.setAttribute('open', '');
      }
    }

    function closeStudio() {
      if (!refs.dialog) return;
      if (typeof refs.dialog.close === 'function') {
        if (refs.dialog.open) refs.dialog.close();
      } else if (refs.dialog.hasAttribute('open')) {
        refs.dialog.removeAttribute('open');
        restoreDialogFocus();
      }
    }

    function onWindowKeydown(ev) {
      if (unmounted || ev.defaultPrevented) return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const target = ev.target;
      if (target && (target.isContentEditable || (typeof target.closest === 'function' && target.closest('[contenteditable=""], [contenteditable="true"]')))) {
        return;
      }
      const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (gridEl.hidden || (typeof gridEl.closest === 'function' && gridEl.closest('[hidden], [inert]'))) return;
      const mainGrid = typeof document.querySelector === 'function' ? document.querySelector('main.grid') : null;
      if (mainGrid && mainGrid.hidden) return;
      if (typeof document.querySelector === 'function' &&
          document.querySelector('dialog[open], [data-expanded="true"], .cell-acoustic.is-expanded, .lg-is-expanded')) {
        return;
      }
      if (ev.key === 'r' || ev.key === 'R') {
        resetToDefault();
      }
    }

    function onWindowResize() {
      if (unmounted) return;
      measureBaseCellWidth();
      if (state.controlled) applyGridSize(state.scale, true);
      else updateLiveDom();
    }

    function stopRuntime() {
      probeSeq++;
      clearInterval(hzTimer);
      hzTimer = 0;
      clearInterval(feedbackTimer);
      feedbackTimer = 0;
      clearTimeout(bridgePollTimer);
      bridgePollTimer = 0;
      clearTimeout(activeProbeTimer);
      activeProbeTimer = 0;
      clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = 0;
      if (activeProbeController) {
        try { activeProbeController.abort(); } catch (_e) {}
        activeProbeController = null;
      }
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      if (link) {
        link.close();
        link = null;
      }
    }

    function onBeforeUnload() {
      stopRuntime();
    }

    window.addEventListener('keydown', onWindowKeydown);
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('beforeunload', onBeforeUnload);

    function unmount() {
      if (unmounted) return;
      unmounted = true;
      stopRuntime();
      window.removeEventListener('keydown', onWindowKeydown);
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (refs.dialog) {
        try {
          if (refs.dialog.open && typeof refs.dialog.close === 'function') refs.dialog.close();
        } catch (_e) {}
        if (refs.dialog.parentNode) refs.dialog.parentNode.removeChild(refs.dialog);
      }
      if (refs.hud && refs.hud.parentNode) {
        refs.hud.parentNode.removeChild(refs.hud);
      }
      gridEl.classList.remove('is-motion-controlled');
      gridEl.style.removeProperty('--mg-cell-w');
      gridEl.removeAttribute('data-motion-layout');
      clearNode(rootEl);
      if (rootEl._mgUnmount === unmount) {
        delete rootEl._mgUnmount;
      }
    }
    unmount.unmount = unmount;
    rootEl._mgUnmount = unmount;

    measureBaseCellWidth();
    recomputeQrUrl();
    connectTransport();
    probeLocalBridge();

    return unmount;
  }

  NS.UI = {
    mountMotionCell: mountMotionCell,
    _internal: {
      normalizePhoneBaseUrl: normalizePhoneBaseUrl,
      buildQrTargetUrl: buildQrTargetUrl
    }
  };

  function autoMount() {
    const elRoot = document.getElementById('cell-motion');
    if (elRoot) mountMotionCell(elRoot);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount);
  } else {
    autoMount();
  }
})(window);
