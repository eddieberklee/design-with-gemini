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
  // index.html geometry: `.grid { gap: 4px }`, 2 columns below 768px, 3 columns from 768px.
  const GRID_GAP_PX = 4;
  const NATURAL_COLS_QUERY = '(min-width: 768px)';
  // Single neutral threshold: below it the grid is uncontrolled and the HUD/reset chip are idle.
  const NEUTRAL_SCALE_EPS = 0.005;
  const PHONE_TIMEOUT_MS = 6500;

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

      // Link & phone status ('idle' = no link open: no scannable QR URL, or tab hidden)
      linkState: 'idle',
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
    let linkKey = '';
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

    function isOffNeutral(scaleVal) {
      return Math.abs(scaleVal - Physics.DEFAULT_SCALE) >= NEUTRAL_SCALE_EPS;
    }

    // Column count index.html renders at 1.00x. Uses the same media query as the page CSS
    // (viewport width incl. scrollbar), not documentElement.clientWidth.
    function naturalColumnCount() {
      try {
        if (typeof root.matchMedia === 'function') {
          return root.matchMedia(NATURAL_COLS_QUERY).matches ? 3 : 2;
        }
      } catch (_e) {}
      const docW = document.documentElement.clientWidth || window.innerWidth;
      return docW >= 768 ? 3 : 2;
    }

    // Content width of the grid. `.grid.is-motion-controlled` keeps index.html's width/max-width,
    // so this is the same value in both modes. Falls back to the index.html formula when layout
    // is unavailable.
    function gridContentWidth() {
      // Fractional width: clientWidth rounds (1324.8px -> 1325) and a rounded-up track would not fit.
      const measured = typeof gridEl.getBoundingClientRect === 'function'
        ? gridEl.getBoundingClientRect().width
        : gridEl.clientWidth;
      if (Number.isFinite(measured) && measured > 0) return measured;
      const bodyStyle = window.getComputedStyle(document.body);
      const padX = (parseFloat(bodyStyle.paddingLeft) || 0) + (parseFloat(bodyStyle.paddingRight) || 0);
      const docW = document.documentElement.clientWidth || window.innerWidth;
      return Math.max(240, Math.min(docW - padX, docW * 0.92, 1600));
    }

    // Baseline 1.00x cell width: floor of the real track width, so reflow at 1.00x fits exactly
    // the natural column count (a 1px round-up would drop a column).
    function measureBaseCellWidth() {
      const naturalCols = naturalColumnCount();
      const naturalW = Math.floor((gridContentWidth() - GRID_GAP_PX * (naturalCols - 1)) / naturalCols);
      state.baseCellW = Physics.clamp(naturalW, Physics.MIN_CELL_W, Physics.MAX_CELL_W);
      if (!state.controlled) {
        state.currentCellW = state.baseCellW;
        state.cols = naturalCols;
      }
    }

    function computeMaxCellWidth() {
      const avail = gridContentWidth();
      if (state.layout === 'fixed3') {
        const fixedCols = naturalColumnCount();
        return Math.max(Physics.MIN_CELL_W, Math.floor((avail - GRID_GAP_PX * (fixedCols - 1)) / fixedCols));
      }
      return Math.min(Physics.MAX_CELL_W, Math.floor(avail));
    }

    function applyGridSize(scaleVal, forceActive) {
      const clampedScale = Physics.clamp(scaleVal, Physics.MIN_SCALE, Physics.MAX_SCALE);
      state.scale = clampedScale;

      const maxCellW = computeMaxCellWidth();
      state.maxCellW = maxCellW;
      const cellW = Physics.scaleToCellWidth(clampedScale, state.baseCellW, maxCellW);
      state.currentCellW = cellW;

      const isNearDefault = !isOffNeutral(clampedScale) && !forceActive && !state.phoneConnected;
      if (isNearDefault) {
        state.controlled = false;
        gridEl.classList.remove('is-motion-controlled');
        gridEl.style.removeProperty('--mg-cell-w');
        gridEl.removeAttribute('data-motion-layout');
        state.cols = naturalColumnCount();
      } else {
        state.controlled = true;
        gridEl.classList.add('is-motion-controlled');
        gridEl.setAttribute('data-motion-layout', state.layout);
        gridEl.style.setProperty('--mg-cell-w', cellW + 'px');
        if (state.layout === 'fixed3') {
          state.cols = naturalColumnCount();
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
      applyGridSize(spring.value, state.phoneConnected || isOffNeutral(spring.target));
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
        applyGridSize(clamped, isOffNeutral(clamped) || state.phoneConnected);
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
      // Opens the relay only once a phone can actually find this session (scannable QR URL).
      syncTransport(false);
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
                syncTransport(false);
              } else if (link && typeof link.subStatus === 'function' && link.subStatus('local') === 'failed') {
                // Bridge restarted at the same URL after the local sub-link hit its retry ceiling
                // (the aggregate may still be 'ready' on MQTT): relink so LOCAL WS comes back.
                syncTransport(true);
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

    function isPageHidden() {
      return typeof document !== 'undefined' && document.visibilityState === 'hidden';
    }

    function hasBridgeWs() {
      return Boolean(state.bridgeConfig && state.bridgeConfig.desktopWsUrl);
    }

    // Identity of the link we want right now; '' means no link (no scannable QR, hidden tab, unmounted).
    function desiredLinkKey() {
      if (unmounted || !state.qrUrl || isPageHidden()) return '';
      return [
        state.sessionId,
        hasBridgeWs() ? state.bridgeConfig.desktopWsUrl : '',
        hasBridgeWs() ? (state.bridgeConfig.desktopHttpBase || '') : ''
      ].join('|');
    }

    function closeLink() {
      if (link) {
        const old = link;
        link = null;
        try { old.close(); } catch (_e) {}
      }
      linkKey = '';
      state.linkState = 'idle';
    }

    function openLink(key) {
      const hasBridge = hasBridgeWs();
      const wsUrl = hasBridge
        ? state.bridgeConfig.desktopWsUrl + '?s=' + encodeURIComponent(state.sessionId) + '&role=desktop'
        : '';
      const httpBase = hasBridge ? state.bridgeConfig.desktopHttpBase : '';

      const myLink = Transport.createLink({
        mode: hasBridge ? 'dual' : 'mqtt',
        sessionId: state.sessionId,
        role: 'desktop',
        wsUrl: wsUrl,
        httpBase: httpBase,
        onStatus: function (st, info) {
          if (link !== myLink || unmounted) return;
          state.linkState = st;
          state.linkTransport = (info && info.transport) || 'mqtt';
          updateLiveDom();
        },
        onMessage: function (msg) {
          if (link !== myLink || unmounted) return;
          handlePhoneMessage(msg);
        }
      });
      link = myLink;
      linkKey = key;
      state.linkState = 'connecting';
      state.linkTransport = hasBridge ? 'local-ws' : 'mqtt';
      myLink.start();
    }

    // Reconcile the open link with desiredLinkKey(). force=true restarts a link that reached
    // the transport retry ceiling ('failed'); otherwise a failed link stays down until the user
    // asks (pill, QR, Retry Bridge) so nothing reconnects forever while the tile sits idle.
    function syncTransport(force) {
      const key = desiredLinkKey();
      if (!force && key === linkKey && (key === '' || link)) {
        updateLiveDom();
        return;
      }
      closeLink();
      if (key) openLink(key);
      updateLiveDom();
    }

    function onPhoneHzTick() {
      const now = Date.now();
      const elapsed = Math.max(250, now - state.lastHzTick);
      state.rxHz = Math.round((state.rxCount * 1000) / elapsed);
      state.rxCount = 0;
      state.lastHzTick = now;

      if (state.phoneConnected && now - state.lastPhoneMs > PHONE_TIMEOUT_MS) {
        setPhoneConnected(false);
      } else if (state.phoneConnected) {
        updateLiveDom();
      }
    }

    // Rate meter, phone liveness and desktop->phone feedback run only while a phone is paired
    // and the tab is visible.
    function syncPhoneTimers() {
      const want = state.phoneConnected && !unmounted && !isPageHidden();
      if (want && !hzTimer) {
        state.rxCount = 0;
        state.lastHzTick = Date.now();
        hzTimer = setInterval(onPhoneHzTick, 1000);
        feedbackTimer = setInterval(sendFeedbackToPhone, 220);
      } else if (!want && hzTimer) {
        clearInterval(hzTimer);
        hzTimer = 0;
        clearInterval(feedbackTimer);
        feedbackTimer = 0;
      }
    }

    function setPhoneConnected(next) {
      if (state.phoneConnected === next) return;
      state.phoneConnected = next;
      if (!next) {
        state.rxHz = 0;
        applyGridSize(state.scale, false);
      }
      syncPhoneTimers();
    }

    function handlePhoneMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      const now = Date.now();
      state.lastPhoneMs = now;
      if (!state.phoneConnected) {
        setPhoneConnected(true);
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
        // The tile shows the code only when it is scannable; without one the SETUP pill and the
        // QR ↗ button say the same thing, so the column is not repeated as a setup box.
        refs.qrCol.hidden = false;
        refs.cardQrFrame.classList.remove('is-unconfigured');
        setAttr(refs.cardQrFrame, 'data-tip', 'Click to open pairing with a larger QR code.');
        refs.cardQrFrame.appendChild(cardSvg);
        refs.cardQrCaption.textContent = state.phoneUrlIsHttps ? 'Scan with iPhone' : 'Needs HTTPS on iPhone';

        refs.dlgQrBox.classList.remove('is-empty');
        refs.dlgQrBox.appendChild(dlgSvg);
        refs.dlgUrlText.textContent = state.qrUrl;
      } else {
        refs.qrCol.hidden = true;
        refs.cardQrFrame.classList.add('is-unconfigured');
        setAttr(refs.cardQrFrame, 'data-tip', 'No QR code yet. Click for the HTTPS setup steps.');
        refs.cardQrCaption.textContent = '';

        refs.dlgQrBox.classList.add('is-empty');
        refs.dlgQrBox.appendChild(
          el('div', { className: 'mg-qr-setup-box' }, [
            el('div', { className: 'ui-label', textContent: state.qrError ? 'Link too long for a QR code' : 'No QR code yet' }),
            el('p', {
              className: 'mg-qr-setup-sub',
              textContent: state.qrError || 'Run the bridge or paste an HTTPS URL, and the code appears here.'
            })
          ])
        );
        refs.dlgUrlText.textContent = state.qrError || 'No HTTPS phone URL detected yet.';
      }
      if (refs.dlgErr) {
        refs.dlgErr.textContent = state.qrError || '';
      }
    }

    // Write an attribute only when it changes: updateLiveDom runs every spring frame, and the
    // shared tooltip watches data-tip on the element it is showing.
    function setAttr(node, name, value) {
      const cacheKey = '_mgAttr_' + name;
      if (node[cacheKey] === value) return;
      node[cacheKey] = value;
      node.setAttribute(name, value);
    }

    // Pill: label, ui-pill tone (green only while a phone really streams), tip and a spoken name
    // that survives the tiny tile, where base.css hides the label and leaves only the dot.
    function pillView() {
      if (state.phoneConnected) {
        return state.rxHz > 0
          ? { st: 'live', tone: 'ok', text: 'LIVE · ' + state.rxHz + 'Hz', tip: 'iPhone motion arrives ' + state.rxHz + ' times a second. Click to open pairing.' }
          : { st: 'live', tone: 'ok', text: 'PHONE LIVE', tip: 'An iPhone is paired and talking to this page. Click to open pairing.' };
      }
      if (!state.qrUrl) {
        return {
          st: 'warn',
          tone: 'attention',
          text: 'SETUP',
          tip: state.qrError
            ? 'The phone link is too long for a QR code. Click to set a shorter one.'
            : 'No HTTPS link for the phone yet. Click for setup steps.'
        };
      }
      if (state.linkState === 'ready') {
        return { st: 'ready', tone: 'idle', text: 'SCAN QR', tip: 'Relay ready and waiting for a phone. Click to show the QR code.' };
      }
      if (state.linkState === 'failed') {
        return { st: 'warn', tone: 'attention', text: 'OFFLINE', tip: 'The relay stopped after repeated failures. Click to retry and open pairing.' };
      }
      return { st: 'warn', tone: 'attention', text: 'LINKING', tip: 'Connecting to the relay. Click to open pairing.' };
    }

    function updateLiveDom() {
      const pill = pillView();
      refs.statusPill.dataset.state = pill.st;
      setAttr(refs.statusPill, 'data-tone', pill.tone);
      setAttr(refs.statusPill, 'data-tip', pill.tip);
      setAttr(refs.statusPill, 'aria-label', 'Phone link: ' + pill.text);
      refs.statusText.textContent = pill.text;

      const scaleLabel = state.scale.toFixed(2) + '×';
      const pxLabel = state.currentCellW + ' px';
      refs.sizeBig.textContent = String(state.currentCellW);
      refs.scaleChip.textContent = scaleLabel;
      const isReflow = state.layout === 'reflow';
      refs.gridMeta.textContent = state.cols + ' col · ' + (isReflow ? 'Reflow' : 'Locked');
      setAttr(refs.gridMeta, 'data-tip', isReflow
        ? 'Columns on the page now; Reflow lets the count follow tile size.'
        : 'Columns on the page now; Locked keeps the count fixed.');

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
      // fixed3 locks the natural column count: 3 from 768px, 2 below (motion.css media query).
      const naturalCols = naturalColumnCount();
      refs.layoutBtn.textContent = isLocked3 ? 'Lock ' + naturalCols + ' col' : 'Reflow';
      refs.layoutBtn.classList.toggle('is-active', isLocked3);
      refs.layoutBtn.setAttribute('aria-pressed', isLocked3 ? 'true' : 'false');
      setAttr(refs.layoutBtn, 'data-tip', isLocked3
        ? 'Keeping ' + naturalCols + ' columns at any tile size. Click to let columns follow tile size.'
        : 'Columns follow tile size. Click to keep ' + naturalCols + ' columns instead.');

      const txName = state.linkTransport === 'local-ws'
        ? 'LOCAL WS'
        : state.linkTransport === 'local-http'
          ? 'LOCAL HTTPS'
          : 'MQTT WSS';
      const txLong = state.linkTransport === 'local-ws'
        ? 'the local bridge WebSocket'
        : state.linkTransport === 'local-http'
          ? 'local bridge HTTPS'
          : 'a public MQTT relay (WSS)';
      const sid = state.sessionId.slice(0, 4);
      const linkLabel = !link
        ? 'NO LINK'
        : state.linkState === 'failed'
          ? txName + ' OFFLINE'
          : txName;
      refs.footerLink.textContent = linkLabel + ' · ' + sid;
      setAttr(refs.footerLink, 'data-tip', !link
        ? 'No relay is open until the phone has an HTTPS link; ' + sid + ' is the session code.'
        : state.linkState === 'failed'
          ? 'The link to ' + txLong + ' gave up after repeated failures; click the status pill to retry.'
          : 'Phone data travels over ' + txLong + '; ' + sid + ' is the session code.');

      const isOffset = isOffNeutral(state.scale);
      refs.resetBtn.classList.toggle('is-active', isOffset);

      const showHud = isOffset || state.phoneConnected;
      refs.hud.classList.toggle('is-visible', showHud);
      refs.hud.dataset.live = state.phoneConnected ? 'true' : 'false';
      refs.hudVal.textContent = (state.phoneConnected ? 'iPhone · ' : 'Grid · ') + pxLabel + ' (' + scaleLabel + ')';
      refs.hudZeroBtn.hidden = !state.phoneConnected;
    }

    // Build Cell #3 Card
    clearNode(rootEl);
    rootEl.classList.add('ui-tile');

    refs.statusText = el('span', { className: 'ui-pill-label', textContent: 'SETUP' });
    refs.statusPill = el('button', {
      type: 'button',
      className: 'ui-pill mg-pill',
      onClick: function (ev) { openStudio(ev.currentTarget); }
    }, [refs.statusText]);

    const header = el('header', { className: 'ui-tile-head' }, [
      el('span', { className: 'ui-tile-index', textContent: '03' }),
      el('span', { className: 'ui-tile-title', textContent: 'Motion Grid' }),
      el('div', { className: 'ui-tile-actions' }, [
        refs.statusPill,
        // Stays at every tile size: on the 177px phone tile the pill is a dot and this is the
        // labelled route to pairing. Only its "QR" word hides.
        el('button', {
          type: 'button',
          className: 'ui-btn ui-btn--sm mg-open-btn',
          'aria-label': 'Open pairing: QR code and HTTPS setup',
          'data-tip': 'Open pairing: a large QR code and the HTTPS setup steps.',
          onClick: function (ev) { openStudio(ev.currentTarget); }
        }, [
          el('span', { className: 'ui-hide-tiny', textContent: 'QR' }),
          el('span', { 'aria-hidden': 'true', textContent: '↗' })
        ])
      ])
    ]);

    refs.cardQrFrame = el('button', {
      type: 'button',
      className: 'mg-qr-frame',
      'aria-label': 'Open pairing with a larger QR code',
      onClick: function (ev) { openStudio(ev.currentTarget); }
    });
    refs.cardQrCaption = el('div', { className: 'ui-label mg-qr-caption', textContent: '' });

    refs.sizeBig = el('span', { textContent: '420' });
    refs.scaleChip = el('span', {
      className: 'ui-readout ui-readout--quiet mg-scale',
      tabindex: '0',
      'data-tip': 'Tile size against the default; 1.00× is the normal page.',
      textContent: '1.00×'
    });
    refs.gridMeta = el('span', {
      className: 'ui-label mg-meta ui-hide-tiny',
      tabindex: '0',
      textContent: '3 col · Reflow'
    });

    refs.valTilt = el('span', { className: 'ui-readout ui-readout--quiet', textContent: '+0.0°' });
    refs.barTilt = el('span', { className: 'mg-axis-bar' });
    refs.valLift = el('span', { className: 'ui-readout ui-readout--quiet', textContent: '+0.0' });
    refs.barLift = el('span', { className: 'mg-axis-bar' });
    refs.valPull = el('span', { className: 'ui-readout ui-readout--quiet', textContent: '+0.0' });
    refs.barPull = el('span', { className: 'mg-axis-bar' });

    function makeAxis(label, valNode, barNode) {
      return el('div', { className: 'mg-axis' }, [
        el('div', { className: 'mg-axis-head' }, [
          el('span', { className: 'ui-label', textContent: label }),
          valNode
        ]),
        el('div', { className: 'mg-axis-track' }, [
          el('span', { className: 'mg-axis-mid' }),
          barNode
        ])
      ]);
    }

    refs.modeBtns = {};
    // The phone computes the size; the mode tells it which gestures count (sent as cmd 'mode').
    const modeOrder = [
      { id: 'all', label: 'All', tip: 'Tilt, lift and pull on the phone all change the size.' },
      { id: 'tilt', label: 'Tilt', tip: 'Only tilting the phone changes the size.' },
      { id: 'lift', label: 'Lift', tip: 'Only raising or lowering the phone changes the size.' },
      { id: 'pull', label: 'Pull', tip: 'Only pulling or pushing the phone changes the size.' }
    ];
    const modeSeg = el('div', { className: 'ui-seg mg-seg', role: 'group', 'aria-label': 'Which phone gestures change the size' },
      modeOrder.map(function (m) {
        const b = el('button', {
          type: 'button',
          'aria-pressed': state.mode === m.id ? 'true' : 'false',
          'data-tip': m.tip,
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
      className: 'ui-slider mg-slider',
      min: String(Math.round(Physics.MIN_SCALE * 100)),
      max: String(Math.round(Physics.MAX_SCALE * 100)),
      value: '100',
      'aria-label': 'Test tile size without a phone',
      'data-tip': 'Drag to try tile sizes without a phone.',
      onInput: function (ev) {
        const nextScale = Number(ev.target.value) / 100;
        state.roll = (nextScale - 1.0) * 45;
        setTargetScale(nextScale, false);
        if (state.phoneConnected) {
          sendToPhone({ t: 'cmd', cmd: 'setScale', val: Number(nextScale.toFixed(3)) });
        }
      }
    });

    // Hero: the tile-width readout. Everything else is a quiet instrument row under it, and the
    // QR column (only when a scannable code exists) sits to the right from 320px tiles up.
    refs.qrCol = el('div', { className: 'mg-qr-col ui-hide-compact', hidden: true }, [
      refs.cardQrFrame,
      refs.cardQrCaption
    ]);
    const body = el('div', { className: 'ui-tile-body mg-body' }, [
      el('div', { className: 'mg-main' }, [
        el('div', { className: 'mg-hero' }, [
          el('span', {
            className: 'ui-readout ui-readout--hero mg-size',
            tabindex: '0',
            'data-tip': 'Width of each grid tile now; phone motion or the size slider changes it.'
          }, [refs.sizeBig, el('span', { className: 'ui-readout-unit', textContent: 'px' })]),
          refs.scaleChip,
          refs.gridMeta
        ]),
        el('div', { className: 'mg-lower' }, [
          el('div', { className: 'mg-controls ui-hide-compact' }, [
            el('div', {
              className: 'mg-axes',
              role: 'group',
              tabindex: '0',
              'aria-label': 'Phone motion: tilt, lift and pull',
              'data-tip': 'Phone motion: tilt in degrees, lift and pull in m/s². The slider moves tilt.'
            }, [
              makeAxis('Tilt', refs.valTilt, refs.barTilt),
              makeAxis('Lift', refs.valLift, refs.barLift),
              makeAxis('Pull', refs.valPull, refs.barPull)
            ]),
            modeSeg
          ]),
          el('label', { className: 'mg-size-row' }, [
            el('span', { className: 'ui-label', textContent: 'Size' }),
            refs.slider
          ])
        ])
      ]),
      refs.qrCol
    ]);

    refs.footerLink = el('span', { className: 'ui-truncate mg-link', tabindex: '0', textContent: 'NO LINK' });
    refs.layoutBtn = el('button', {
      type: 'button',
      className: 'ui-btn ui-btn--sm ui-btn--quiet mg-layout-btn',
      textContent: 'Reflow',
      'aria-pressed': 'false',
      onClick: function () {
        state.layout = state.layout === 'reflow' ? 'fixed3' : 'reflow';
        applyGridSize(state.scale, state.controlled);
        sendFeedbackToPhone();
      }
    });
    // R really resets: ui.js:onWindowKeydown calls resetToDefault (not while typing in an
    // input, a dialog is open, or another cell is expanded).
    refs.resetBtn = el('button', {
      type: 'button',
      className: 'ui-btn ui-btn--sm ui-btn--quiet mg-reset-btn',
      textContent: '100%',
      'data-tip': 'Reset tiles to the default size.',
      'data-tip-key': 'R',
      onClick: resetToDefault
    });

    const footer = el('footer', { className: 'ui-tile-foot mg-footer' }, [
      refs.footerLink,
      el('div', { className: 'mg-footer-group' }, [refs.layoutBtn, refs.resetBtn])
    ]);

    rootEl.appendChild(header);
    rootEl.appendChild(body);
    rootEl.appendChild(footer);

    refs.hudVal = el('span', { className: 'ui-readout mg-hud-val', textContent: 'Grid · 420 px (1.00×)' });
    refs.hudZeroBtn = el('button', {
      type: 'button',
      className: 'ui-btn ui-btn--sm mg-hud-btn',
      textContent: 'Zero',
      hidden: true,
      'data-tip': "Make the phone's current pose its new neutral grip.",
      onClick: function () { sendToPhone({ t: 'cmd', cmd: 'zero' }); }
    });
    refs.hud = el('div', { className: 'mg-hud', role: 'status', 'aria-live': 'polite' }, [
      el('span', { className: 'mg-hud-dot', 'aria-hidden': 'true' }),
      refs.hudVal,
      refs.hudZeroBtn,
      el('button', {
        type: 'button',
        className: 'ui-btn ui-btn--sm mg-hud-btn',
        textContent: 'Reset 100%',
        'data-tip': 'Reset tiles to the default size.',
        'data-tip-key': 'R',
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
      spellcheck: 'false',
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
      className: 'ui-btn ui-btn--sm mg-copy-btn',
      textContent: 'Copy',
      'data-tip': 'Copy the bridge command to the clipboard.',
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

    refs.dialog = el('dialog', { className: 'ui-dialog mg-dialog', 'aria-label': 'Pair an iPhone with Motion Grid' }, [
      el('header', { className: 'ui-studio-bar' }, [
        el('span', { className: 'ui-tile-index', textContent: '03' }),
        el('h2', { className: 'ui-studio-title', textContent: 'Pair an iPhone' }),
        el('div', { className: 'ui-studio-actions' }, [
          el('button', {
            type: 'button',
            className: 'ui-btn',
            textContent: 'Close',
            'data-tip': 'Back to the grid.',
            'data-tip-key': 'Esc',
            onClick: function () { closeStudio(); }
          })
        ])
      ]),
      el('div', { className: 'mg-dlg-body' }, [
        el('div', { className: 'mg-dlg-qr-panel' }, [
          refs.dlgQrBox,
          refs.dlgUrlText,
          el('div', { className: 'mg-dlg-actions' }, [
            el('button', {
              type: 'button',
              className: 'ui-btn ui-btn--sm',
              textContent: 'New Session',
              'data-tip': 'Make a new session code; a paired phone must scan again.',
              onClick: function () {
                state.sessionId = Transport.generateSessionId(8);
                safeStorageSet('sessionStorage', STORAGE_SESSION_KEY, state.sessionId);
                setPhoneConnected(false);
                recomputeQrUrl();
              }
            }),
            el('button', {
              type: 'button',
              className: 'ui-btn ui-btn--sm',
              textContent: 'Retry Bridge',
              'data-tip': 'Look again for the local bridge (node cells/motion/server.mjs) and retry the relay.',
              onClick: function () {
                bridgePollAttempts = 0;
                probeLocalBridge();
                retryFailedLink();
              }
            })
          ])
        ]),
        el('div', { className: 'mg-dlg-side' }, [
          el('section', { className: 'mg-dlg-section' }, [
            el('h3', { className: 'ui-label', textContent: 'Local bridge (recommended)' }),
            el('p', {
              className: 'mg-dlg-note',
              textContent: 'iPhone Safari shares motion only over HTTPS. Run this from the repo root: it opens an HTTPS tunnel (ngrok, or LAN HTTPS) and fills in the QR code.'
            }),
            el('div', { className: 'ui-well mg-cmd-box' }, [
              el('code', { textContent: 'node cells/motion/server.mjs' }),
              refs.dlgCopyBtn
            ])
          ]),
          el('section', { className: 'mg-dlg-section' }, [
            el('h3', { className: 'ui-label', textContent: 'Or a hosted HTTPS URL' }),
            el('p', {
              className: 'mg-dlg-note',
              textContent: 'Paste the HTTPS address where this repo is served (GitHub Pages, Tailscale Serve, Vercel, ngrok). Motion then travels through a public MQTT relay. Clear the field to go back to the bridge.'
            }),
            el('div', { className: 'mg-input-row' }, [
              refs.dlgUrlInput,
              el('button', {
                type: 'button',
                className: 'ui-btn',
                textContent: 'Set URL',
                'data-tip': 'Use this address in the QR code; an empty field goes back to the bridge.',
                onClick: applyCustomUrl
              })
            ]),
            refs.dlgErr
          ]),
          el('section', { className: 'mg-dlg-section' }, [
            el('h3', { className: 'ui-label', textContent: 'On the iPhone' }),
            el('p', {
              className: 'mg-dlg-note',
              textContent: 'Twist the phone like a dial, raise or lower it, or pull it toward you and push it away. Tap Zero Pose to make your current grip the neutral one.'
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
      retryFailedLink();
      if (typeof refs.dialog.showModal === 'function') {
        if (!refs.dialog.open) refs.dialog.showModal();
      } else {
        refs.dialog.setAttribute('open', '');
      }
    }

    // User-initiated restart of a link that hit the transport retry ceiling.
    function retryFailedLink() {
      if (state.linkState === 'failed') syncTransport(true);
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

    // Hidden tab: drop the relay link and every phone timer (a paused liveness timer could never
    // time the phone out, so the phone is marked disconnected). Visible again: reopen the link only
    // if one is wanted; a link that already hit its retry ceiling stays down until the user retries.
    function onVisibilityChange() {
      if (unmounted) return;
      if (isPageHidden()) {
        setPhoneConnected(false);
        if (state.linkState === 'failed') {
          updateLiveDom();
          return;
        }
      } else if (state.linkState === 'failed' && link) {
        updateLiveDom();
        return;
      }
      syncPhoneTimers();
      syncTransport(false);
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
      closeLink();
    }

    window.addEventListener('keydown', onWindowKeydown);
    window.addEventListener('resize', onWindowResize);
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    function unmount() {
      if (unmounted) return;
      unmounted = true;
      stopRuntime();
      window.removeEventListener('keydown', onWindowKeydown);
      window.removeEventListener('resize', onWindowResize);
      if (typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
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
      rootEl.classList.remove('ui-tile');
      if (rootEl._mgUnmount === unmount) {
        delete rootEl._mgUnmount;
      }
    }
    unmount.unmount = unmount;
    rootEl._mgUnmount = unmount;

    measureBaseCellWidth();
    recomputeQrUrl();
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
