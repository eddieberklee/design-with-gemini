(function (root) {
  'use strict';

  const NS = (root.StickS3Color = root.StickS3Color || {});
  const ColorEngine = NS.ColorEngine;
  const Transport = NS.Transport;

  const SWATCH_STORAGE_KEY = 's3_captured_swatches_v1';
  const MAX_SWATCHES = 8;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const COMMAND_LEASE_MS = 450;

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

  function svgEl(tag, attrs, children) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v !== undefined && v !== null && v !== false) {
          node.setAttribute(k, String(v));
        }
      });
    }
    if (children) {
      const list = Array.isArray(children) ? children : [children];
      list.forEach(function (c) {
        if (c) node.appendChild(c);
      });
    }
    return node;
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function loadSavedSwatches() {
    try {
      const raw = root.localStorage ? root.localStorage.getItem(SWATCH_STORAGE_KEY) : null;
      if (!raw) return null;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      return arr
        .filter(function (s) { return s && typeof s.hex === 'string' && /^#[0-9A-F]{6}$/i.test(s.hex); })
        .slice(0, MAX_SWATCHES);
    } catch (_e) {
      return null;
    }
  }

  function saveSwatches(list) {
    try {
      if (root.localStorage) {
        root.localStorage.setItem(SWATCH_STORAGE_KEY, JSON.stringify(list.slice(0, MAX_SWATCHES)));
      }
    } catch (_e) {}
  }

  function fallbackExecCopy(text) {
    try {
      if (!document || !document.body || typeof document.execCommand !== 'function') {
        return false;
      }
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      if (typeof ta.select === 'function') ta.select();
      const copied = Boolean(document.execCommand('copy'));
      document.body.removeChild(ta);
      return copied;
    } catch (_e) {
      return false;
    }
  }

  function copyToClipboard(text) {
    if (
      root.navigator &&
      root.navigator.clipboard &&
      typeof root.navigator.clipboard.writeText === 'function'
    ) {
      try {
        return Promise.resolve(root.navigator.clipboard.writeText(text)).then(
          function () {
            return { ok: true };
          },
          function () {
            return { ok: fallbackExecCopy(text) };
          }
        );
      } catch (_err) {
        return Promise.resolve({ ok: fallbackExecCopy(text) });
      }
    }
    return Promise.resolve({ ok: fallbackExecCopy(text) });
  }

  function pad3(n) {
    const v = Math.round(ColorEngine.wrapHue(n));
    if (v < 10) return '00' + v;
    if (v < 100) return '0' + v;
    return String(v);
  }

  function formatSigned(val) {
    const n = ColorEngine.clamp(val, -9.99, 9.99);
    return (n >= 0 ? '+' : '') + n.toFixed(2);
  }

  function mountStickS3Cell(rootEl) {
    if (!rootEl || !ColorEngine || !Transport) return null;
    if (rootEl.__stickS3Instance && typeof rootEl.__stickS3Instance.destroy === 'function') {
      rootEl.__stickS3Instance.destroy();
    }

    const initialSwatches = loadSavedSwatches() || [
      { hex: '#D94F1E', mode: 'OKLCH', l: 61, c: 0.19, h: 36 },
      { hex: '#1F7A6E', mode: 'OKLCH', l: 53, c: 0.11, h: 186 },
      { hex: '#3B5BDB', mode: 'PRISM', l: 52, c: 0.21, h: 268 }
    ];

    const state = {
      // Live or simulated IMU state
      ax: 0.0,
      ay: 0.0,
      az: 1.0,
      tx: 0.0,
      ty: 0.0,
      roll: 0.0,
      pitch: 0.0,
      kin: 0.0,
      battery: -1,

      // Tare reference for manual drag / simulated pad
      localTareX: 0.0,
      localTareY: 0.0,

      // Instrument controls
      mode: 0,
      hold: false,
      pinnedCustomSwatch: false,
      simPreset: 'idle', // 'idle' | 'orbit' | 'flip' | 'shake'
      draggingPad: false,

      // Hardware link state
      hwConnected: false,
      linkSource: 'none',
      bridgeReachable: false,
      portName: '',
      packetHz: 0,
      bridgeProbe: 'probing', // transport: 'probing' | 'open' | 'paused' | 'stopped' | 'off'
      bridgePortOpen: false,
      linkPhase: '', // '' | 'connecting' | 'failed' (Web Serial / BLE button outcome)
      linkNote: '',
      linkFailTag: '',

      // Race-immunity leases & dedup
      pendingModeUntil: 0,
      pendingHoldUntil: 0,
      lastHandledEventSeq: -1,

      // Smoothed display color & contrast hysteresis
      targetColor: ColorEngine.mapImuToColor(0, 0, 1, 0, 0),
      displayColor: ColorEngine.mapImuToColor(0, 0, 1, 0, 0),
      heldColor: null,
      prevIsLightBg: true,

      // Swatches & scope ringbuffer
      swatches: initialSwatches,
      scopeHistory: []
    };

    // FPS / Packet rate counter & lifecycle state
    let pktCounter = 0;
    let lastRateTickMs = Date.now();
    let lastSimScopeMs = -Infinity;
    let toastTimer = null;
    let announceTimer = null;
    let lastFocusBeforeModal = null;
    let rafId = null;
    let destroyed = false;

    const reducedMotionQuery =
      typeof root.matchMedia === 'function'
        ? root.matchMedia('(prefers-reduced-motion: reduce)')
        : null;

    function isReducedMotion() {
      if (reducedMotionQuery) return Boolean(reducedMotionQuery.matches);
      if (typeof root.matchMedia === 'function') {
        const mq = root.matchMedia('(prefers-reduced-motion: reduce)');
        return Boolean(mq && mq.matches);
      }
      return false;
    }

    // ---------- Polite Screen Reader Live Region ----------
    const srLive = el('div', {
      className: 's3-sr-only',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true'
    });

    function announce(msg) {
      if (announceTimer) clearTimeout(announceTimer);
      srLive.textContent = '';
      announceTimer = setTimeout(function () {
        srLive.textContent = msg;
      }, 25);
    }

    // ---------- Toast Overlay ----------
    const toastEl = el('div', { className: 's3-toast s3-mono', 'aria-hidden': 'true' });
    function showToast(text) {
      toastEl.textContent = text;
      toastEl.classList.add('is-visible');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        toastEl.classList.remove('is-visible');
      }, 1050);
    }

    // ---------- 1. Top Obsidian Instrument Header ----------
    const modeBtns = ColorEngine.MODES.map(function (m) {
      return el('button', {
        type: 'button',
        className: 's3-mode-btn s3-mono',
        'aria-pressed': m.id === state.mode ? 'true' : 'false',
        title: m.label + ' — ' + m.axisHint,
        onClick: function () { setMode(m.id, true); }
      }, m.shortLabel);
    });

    const modeCycleBtn = el('button', {
      type: 'button',
      className: 's3-mode-cycle s3-mono',
      title: 'Cycle accelerometer color mode [M]',
      onClick: function () { setMode((state.mode + 1) % ColorEngine.MODES.length, true); }
    }, 'OKLCH ↻');

    const statusDot = el('span', { className: 's3-status-dot', 'aria-hidden': 'true' });
    const statusText = el('span', { textContent: 'TILT PAD' });
    const statusPill = el('span', { className: 's3-status-pill s3-mono' }, [statusDot, statusText]);

    const openBtn = el('button', {
      type: 'button',
      className: 's3-open-btn',
      'aria-label': 'Open M5StickS3 Color Studio and Hardware Twin',
      onClick: function () { openDialog(); }
    }, [
      el('span', { className: 's3-open-label', textContent: 'Studio' }),
      el('span', { 'aria-hidden': 'true', textContent: '↗' })
    ]);

    const hudTop = el('header', { className: 's3-hud-top' }, [
      el('div', { className: 's3-brand' }, [
        el('span', { className: 's3-index s3-mono', textContent: '07' }),
        el('span', { className: 's3-title s3-mono', textContent: 'STICK S3' })
      ]),
      el('div', { className: 's3-top-right' }, [
        el('div', { className: 's3-mode-group', role: 'group', 'aria-label': 'Accelerometer color mapping mode' }, modeBtns),
        modeCycleBtn,
        statusPill,
        openBtn
      ])
    ]);

    // ---------- 2. Dominant Hero Color Swatch Card (mirrors StickS3 LCD) ----------
    const swatchModeEl = el('span', { className: 's3-swatch-mode s3-mono', textContent: 'OKLCH' });
    const swatchLightnessEl = el('span', { className: 's3-swatch-lightness s3-mono', textContent: 'L84' });

    const domeRingHalo = svgEl('circle', { class: 's3-dome-halo', cx: '50', cy: '50', r: '42' });
    const domeRing = svgEl('circle', { class: 's3-dome-ring', cx: '50', cy: '50', r: '42' });
    const domeInnerRing = svgEl('circle', { class: 's3-dome-ring', cx: '50', cy: '50', r: '21', 'stroke-opacity': '0.35' });
    const crossH = svgEl('line', { class: 's3-dome-cross', x1: '43', y1: '50', x2: '57', y2: '50' });
    const crossV = svgEl('line', { class: 's3-dome-cross', x1: '50', y1: '43', x2: '50', y2: '57' });
    const kinArc = svgEl('circle', {
      class: 's3-dome-kin',
      cx: '50',
      cy: '50',
      r: '46.5',
      'stroke-dasharray': '0 300',
      transform: 'rotate(-90 50 50)'
    });
    const stemHalo = svgEl('line', { class: 's3-dome-stem-halo', x1: '50', y1: '50', x2: '50', y2: '50' });
    const stemLine = svgEl('line', { class: 's3-dome-stem', x1: '50', y1: '50', x2: '50', y2: '50' });
    const puckHalo = svgEl('circle', { class: 's3-dome-puck-halo', cx: '50', cy: '50', r: '7.2' });
    const puckDot = svgEl('circle', { class: 's3-dome-puck', cx: '50', cy: '50', r: '4.8' });

    const domeSvg = svgEl('svg', {
      class: 's3-dome-svg',
      viewBox: '0 0 100 100',
      'aria-hidden': 'true'
    }, [
      domeRingHalo,
      domeRing,
      domeInnerRing,
      crossH,
      crossV,
      kinArc,
      stemHalo,
      stemLine,
      puckHalo,
      puckDot
    ]);

    const domePad = el('div', {
      className: 's3-dome-pad',
      tabIndex: 0,
      role: 'application',
      'aria-label': 'M5StickS3 3-axis accelerometer tilt dome. Tilt physical StickS3 or drag/arrow-keys to steer cell color. Double-click to zero tare.'
    }, [domeSvg]);

    const hexTextEl = el('span', { textContent: '#D5C6CA' });
    const hexCopyBtn = el('button', {
      type: 'button',
      className: 's3-hex-copy s3-mono',
      title: 'Click to copy live hex color',
      onClick: function () {
        const hex = state.displayColor.hex;
        copyToClipboard(hex).then(function (res) {
          showToast((res && res.ok ? 'COPIED ' : 'HEX ') + hex);
          announce((res && res.ok ? 'Copied ' : 'Selected ') + hex);
        });
      }
    }, [hexTextEl]);

    const oklchSpecEl = el('span', { className: 's3-oklch-spec s3-mono', textContent: 'C.02 · H000°' });

    const centerStage = el('div', { className: 's3-stage' }, [
      el('div', { className: 's3-swatch-top' }, [swatchModeEl, swatchLightnessEl]),
      el('div', { className: 's3-swatch-center' }, [domePad]),
      el('div', { className: 's3-swatch-bottom' }, [hexCopyBtn, oklchSpecEl]),
      toastEl
    ]);

    // ---------- 3. Bottom Obsidian Telemetry & Key Strip (mirrors StickS3 X/Y/Z bars) ----------
    const axisBarX = el('span', { className: 's3-axis-fill s3-axis-fill--x' });
    const axisBarY = el('span', { className: 's3-axis-fill s3-axis-fill--y' });
    const axisBarZ = el('span', { className: 's3-axis-fill s3-axis-fill--z' });

    const xyzBarsEl = el('div', { className: 's3-xyz-bars s3-mono', 'aria-hidden': 'true' }, [
      el('span', { className: 's3-axis-mini' }, ['X', el('span', { className: 's3-axis-track' }, [axisBarX])]),
      el('span', { className: 's3-axis-mini' }, ['Y', el('span', { className: 's3-axis-track' }, [axisBarY])]),
      el('span', { className: 's3-axis-mini' }, ['Z', el('span', { className: 's3-axis-track' }, [axisBarZ])])
    ]);

    const axesInlineEl = el('span', { className: 's3-axes-inline s3-mono', textContent: 'X+0.00 Y+0.00 Z+1.00g' });

    const holdBtn = el('button', {
      type: 'button',
      className: 's3-chip-btn s3-mono',
      'aria-pressed': 'false',
      title: 'Freeze / Hold live color & capture swatch [Space or StickS3 BtnA]',
      onClick: function () { toggleHold(true, true); }
    }, 'Hold');

    const tareBtn = el('button', {
      type: 'button',
      className: 's3-chip-btn s3-tare-btn s3-mono',
      title: 'Zero / Tare current tilt angle [T or long-press StickS3 BtnA]',
      onClick: function () { triggerTare(true); }
    }, '0°');

    const zFlipBtn = el('button', {
      type: 'button',
      className: 's3-chip-btn s3-mono',
      'aria-pressed': 'false',
      title: 'Flip virtual Z hemisphere (Face-Up bright vs Face-Down deep pigment)',
      onClick: function () {
        if (state.hwConnected) {
          showToast('FLIP PHYSICAL STICK Z');
          return;
        }
        state.az = state.az >= 0 ? -0.78 : 0.92;
        recomputeLocalTarget();
        renderStaticControls();
      }
    }, 'Z+');

    const swatchStripEl = el('div', {
      className: 's3-swatch-strip',
      role: 'group',
      'aria-label': 'Captured color swatches'
    });

    const hudBottom = el('footer', { className: 's3-hud-bottom' }, [
      el('div', { className: 's3-readout-cluster' }, [
        xyzBarsEl,
        axesInlineEl
      ]),
      el('div', { className: 's3-controls-cluster' }, [
        holdBtn,
        tareBtn,
        zFlipBtn,
        swatchStripEl
      ])
    ]);

    // Micro badge when Cell 03 shrinks grid <= 235px
    const microHexEl = el('span', { className: 's3-micro-pill s3-mono', textContent: '#D5C6CA' });
    const microWrap = el('button', {
      type: 'button',
      className: 's3-micro',
      'aria-label': 'Open M5StickS3 Color Studio',
      onClick: function () { openDialog(); }
    }, [microHexEl]);

    clearNode(rootEl);
    rootEl.appendChild(hudTop);
    rootEl.appendChild(centerStage);
    rootEl.appendChild(microWrap);
    rootEl.appendChild(hudBottom);
    rootEl.appendChild(srLive);

    // ---------- 4. Expanded Studio Workbench (<dialog>) ----------
    const twinLcdCanvas = el('canvas', { className: 's3-twin-lcd', width: 135, height: 240 });
    const twinBtnA = el('button', {
      type: 'button',
      className: 's3-twin-btna s3-mono',
      title: 'M5StickS3 KEY1 (GPIO 11): Click to Hold/+Swatch, Shift+Click to Tare',
      onClick: function (ev) {
        if (ev.shiftKey) triggerTare(true);
        else toggleHold(true, true);
      }
    }, 'KEY1');

    const twinBtnB = el('button', {
      type: 'button',
      className: 's3-twin-btnb',
      title: 'M5StickS3 KEY2 (GPIO 12): Cycle Color Mode',
      'aria-label': 'M5StickS3 Side Button KEY2: Cycle Color Mode',
      onClick: function () { setMode((state.mode + 1) % ColorEngine.MODES.length, true); }
    });

    const twinRig = el('div', { className: 's3-twin-rig' }, [
      el('div', { className: 's3-twin-body' }, [
        twinLcdCanvas,
        twinBtnA,
        twinBtnB
      ]),
      el('div', { className: 's3-twin-back s3-mono' }, [
        el('strong', { textContent: 'M5StickS3' }),
        el('span', { textContent: 'ESP32-S3-PICO-1' }),
        el('span', { textContent: 'BMI270 6-Axis IMU' }),
        el('span', { textContent: 'Face-Down (Z < 0)' })
      ])
    ]);

    const scopeRateEl = el('span', { className: 's3-mono', textContent: '0 Hz' });
    const scopeCanvas = el('canvas', { className: 's3-scope-canvas', width: 268, height: 76 });

    const heroHexEl = el('span', { className: 's3-hero-hex s3-mono', textContent: '#D5C6CA' });
    const heroMetricsEl = el('span', { className: 's3-hero-metrics s3-mono', textContent: 'oklch(0.84 0.020 000deg)' });
    const heroContrastEl = el('span', { className: 's3-hero-metrics s3-mono', textContent: 'Contrast 15.9:1 AAA' });
    const heroSwatch = el('div', { className: 's3-hero-swatch' }, [
      el('div', { className: 's3-hero-pill' }, [heroHexEl, heroMetricsEl, heroContrastEl])
    ]);

    const connSummaryEl = el('span', { className: 's3-mono', style: { fontSize: '10.5px', color: '#525250' }, textContent: 'Probing ws://127.0.0.1:8791/ws…' });

    // Shared Web Serial / BLE button flow. The outcome is kept in state.linkPhase / state.linkNote
    // so renderStaticControls() shows it instead of overwriting it on the next status event.
    async function runLinkAction(kind) {
      const isSerial = kind === 'serial';
      const label = isSerial ? 'Web Serial' : 'Web Bluetooth';
      const tag = isSerial ? 'USB' : 'BLE';
      if (state.linkPhase === 'connecting') return; // ignore double clicks while a chooser is open
      if (state.linkSource !== kind && !(isSerial ? Transport.supportsWebSerial() : Transport.supportsWebBluetooth())) {
        state.linkPhase = '';
        state.linkNote = isSerial
          ? 'Web Serial is unavailable here (needs Chrome or Edge on localhost / HTTPS). Use the USB bridge instead.'
          : 'Web Bluetooth is unavailable here (needs Chrome or Edge on localhost / HTTPS).';
        showToast(isSerial ? 'WEB SERIAL UNSUPPORTED' : 'BLE UNSUPPORTED');
        renderStaticControls();
        return;
      }
      try {
        if (state.linkSource === kind) {
          await (isSerial ? link.disconnectWebSerial() : link.disconnectWebBluetooth());
          state.linkPhase = '';
          state.linkNote = '';
        } else {
          state.linkPhase = 'connecting';
          state.linkNote = '';
          state.linkFailTag = tag;
          renderStaticControls();
          await (isSerial ? link.connectWebSerial() : link.connectWebBluetooth());
          state.linkPhase = '';
          showToast(tag + ' LINK OPEN');
        }
      } catch (err) {
        const name = err && err.name ? String(err.name) : '';
        const msg = err && err.message ? String(err.message) : String(err || 'unknown error');
        if (name === 'NotFoundError') {
          // Chooser dismissed without picking a device: not a failure, nothing changed.
          state.linkPhase = '';
          state.linkNote = label + ' cancelled: no device chosen. Press the button again to retry.';
          showToast(tag + ' CANCELLED');
        } else {
          state.linkPhase = 'failed';
          state.linkFailTag = tag;
          state.linkNote = label + ' failed' + (name === 'SecurityError' ? ' (permission denied)' : '') + ': ' + msg;
          showToast(tag + ' FAILED');
        }
      }
      renderStaticControls();
    }

    const webSerialBtn = el('button', {
      type: 'button',
      className: 's3-btn s3-btn--primary',
      onClick: function () { return runLinkAction('serial'); }
    }, 'Connect USB Web Serial');

    const webBleBtn = el('button', {
      type: 'button',
      className: 's3-btn',
      onClick: function () { return runLinkAction('ble'); }
    }, 'Pair Wireless BLE');

    const retryBridgeBtn = el('button', {
      type: 'button',
      className: 's3-btn',
      hidden: true,
      onClick: function () {
        state.linkNote = '';
        if (state.linkPhase === 'failed') state.linkPhase = '';
        link.retryBridge();
        showToast('LOOKING FOR BRIDGE');
        renderStaticControls();
      }
    }, 'Retry bridge');

    const simPresetBtns = [
      { id: 'idle', label: 'Manual Pad' },
      { id: 'orbit', label: 'Auto Orbit' },
      { id: 'flip', label: 'Flip Z' },
      { id: 'shake', label: 'Shake Kinetic' }
    ].map(function (p) {
      return el('button', {
        type: 'button',
        className: 's3-btn',
        dataset: { preset: p.id },
        'aria-pressed': p.id === state.simPreset ? 'true' : 'false',
        onClick: function () {
          state.simPreset = p.id;
          state.hold = false;
          state.pinnedCustomSwatch = false;
          state.heldColor = null;
          if (!state.hwConnected) recomputeLocalTarget();
          renderStaticControls();
        }
      }, p.label);
    });

    const dlgModeBtns = ColorEngine.MODES.map(function (m) {
      return el('button', {
        type: 'button',
        className: 's3-btn',
        'aria-pressed': m.id === state.mode ? 'true' : 'false',
        onClick: function () { setMode(m.id, true); }
      }, m.shortLabel + ' · ' + m.label);
    });
    const modeHintEl = el('div', { style: { fontSize: '11px', color: '#525250' }, textContent: ColorEngine.MODES[0].axisHint });

    const deckGridEl = el('div', { className: 's3-deck-grid' });

    const exportPngBtn = el('button', {
      type: 'button',
      className: 's3-btn',
      onClick: function () { downloadSwatchTearSheet(); }
    }, 'Download PNG Tear-Sheet');

    const copyCssBtn = el('button', {
      type: 'button',
      className: 's3-btn',
      onClick: function () {
        const cssVars = state.swatches.map(function (s, idx) {
          return '  --stick-s3-swatch-' + (idx + 1) + ': ' + s.hex + ';';
        }).join('\n');
        copyToClipboard(':root {\n' + cssVars + '\n}').then(function (res) {
          showToast(res && res.ok ? 'COPIED CSS PALETTE' : 'CSS PALETTE READY');
        });
      }
    }, 'Copy CSS Tokens');

    const dlgCloseBtn = el('button', {
      type: 'button',
      className: 's3-dlg-close',
      onClick: function () { closeDialog(); }
    }, 'Done ✕');

    const dialog = el('dialog', {
      className: 's3-dialog',
      'aria-label': 'M5StickS3 Accelerometer Color Studio Workbench',
      onClick: function (ev) {
        if (ev.target === dialog) closeDialog();
      }
    }, [
      el('div', { className: 's3-dlg-header' }, [
        el('div', { className: 's3-dlg-title-wrap' }, [
          el('span', { className: 's3-index s3-mono', textContent: 'CELL 07' }),
          el('h2', { className: 's3-dlg-title', textContent: 'M5StickS3 Accelerometer Color Studio' }),
          el('span', { className: 's3-dlg-sub s3-mono', textContent: 'ESP32-S3-PICO-1 · BMI270 6-Axis IMU · 135×240 ST7789P3' })
        ]),
        dlgCloseBtn
      ]),
      el('div', { className: 's3-dlg-body' }, [
        el('div', { className: 's3-dlg-left' }, [
          el('div', { className: 's3-twin-stage' }, [twinRig]),
          el('div', { className: 's3-twin-caption' }, 'Live 3D M5StickS3 orientation twin. Click orange KEY1 to freeze/capture swatch; side KEY2 cycles color engine.'),
          el('div', { className: 's3-scope-card' }, [
            el('div', { className: 's3-scope-head' }, [
              el('span', { textContent: 'BMI270 X / Y / Z + Kinetic' }),
              scopeRateEl
            ]),
            scopeCanvas
          ])
        ]),
        el('div', { className: 's3-dlg-right' }, [
          heroSwatch,
          el('div', { className: 's3-section-box' }, [
            el('div', { className: 's3-section-title' }, [
              el('span', { textContent: 'Hardware Transport & Simulator' }),
              connSummaryEl
            ]),
            el('div', { className: 's3-btn-row' }, [webSerialBtn, webBleBtn, retryBridgeBtn].concat(simPresetBtns)),
            el('pre', { className: 's3-cmd-pre s3-mono' }, 'node cells/stick-s3/bridge.mjs   # Auto-streams /dev/cu.usbmodem* to file:// & localhost:8791')
          ]),
          el('div', { className: 's3-section-box' }, [
            el('div', { className: 's3-section-title' }, [
              el('span', { textContent: 'Synchronized Firmware Color Engine' })
            ]),
            el('div', { className: 's3-btn-row' }, dlgModeBtns),
            modeHintEl
          ]),
          el('div', { className: 's3-section-box' }, [
            el('div', { className: 's3-section-title' }, [
              el('span', { textContent: 'Captured Pantone Swatches (BtnA / Hold)' }),
              el('div', { className: 's3-btn-row' }, [copyCssBtn, exportPngBtn])
            ]),
            deckGridEl
          ])
        ])
      ])
    ]);

    document.body.appendChild(dialog);
    dialog.addEventListener('close', function () {
      if (lastFocusBeforeModal && typeof lastFocusBeforeModal.focus === 'function') {
        lastFocusBeforeModal.focus();
      }
    });

    function openDialog() {
      lastFocusBeforeModal = document.activeElement;
      if (typeof dialog.showModal === 'function' && !dialog.open) {
        dialog.showModal();
        renderSwatches();
      }
    }

    function closeDialog() {
      if (dialog.open) dialog.close();
    }

    // ---------- Core State Mutations & Hardware Sync ----------

    function pushCapturedSwatch(colorSpec) {
      if (!colorSpec || !colorSpec.hex) return;
      const modeName = ColorEngine.MODES[state.mode] ? ColorEngine.MODES[state.mode].shortLabel : 'OKLCH';
      const entry = {
        hex: colorSpec.hex,
        mode: modeName,
        l: Math.round(colorSpec.l * 100),
        c: Number(colorSpec.c.toFixed(2)),
        h: Math.round(colorSpec.h)
      };
      const deduped = [entry].concat(
        state.swatches.filter(function (s) { return s.hex.toUpperCase() !== entry.hex.toUpperCase(); })
      ).slice(0, MAX_SWATCHES);
      state.swatches = deduped;
      saveSwatches(deduped);
      renderSwatches();
    }

    function setMode(nextMode, sendToHw) {
      const m = ((Math.trunc(nextMode) % ColorEngine.MODES.length) + ColorEngine.MODES.length) % ColorEngine.MODES.length;
      state.mode = m;
      if (sendToHw) {
        state.pendingModeUntil = Date.now() + COMMAND_LEASE_MS;
        link.sendCommand({ cmd: 'mode', m: m });
      }
      if (!state.hwConnected) {
        recomputeLocalTarget();
      } else {
        state.targetColor = ColorEngine.mapImuToColor(state.tx, state.ty, state.az, state.kin, m);
      }
      const meta = ColorEngine.MODES[m];
      showToast('MODE · ' + meta.shortLabel);
      announce('Color mode ' + meta.label);
      renderStaticControls();
    }

    function applyColorToDom(col) {
      const theme = ColorEngine.pickAdaptiveTheme(col.r, col.g, col.b, state.prevIsLightBg);
      state.prevIsLightBg = theme.isLightBg;

      rootEl.style.setProperty('--s3-live-hex', col.hex);
      rootEl.style.setProperty('--s3-reticle-ink', theme.ink);
      rootEl.style.setProperty('--s3-reticle-halo', theme.reticleHalo);
      rootEl.style.setProperty('--s3-dome-well', theme.domeWell);
      centerStage.style.backgroundColor = col.hex;
      microWrap.style.backgroundColor = col.hex;

      hexTextEl.textContent = col.hex;
      microHexEl.textContent = col.hex;
      swatchLightnessEl.textContent = 'L' + String(Math.round(col.l * 100)).padStart(2, '0');
      oklchSpecEl.textContent =
        'C.' + String(Math.round(col.c * 100)).padStart(2, '0') +
        ' · H' + pad3(col.h) + '°';
      return theme;
    }

    function applyAxisBarsToDom() {
      [
        { bar: axisBarX, val: state.ax },
        { bar: axisBarY, val: state.ay },
        { bar: axisBarZ, val: state.az }
      ].forEach(function (item) {
        const norm = ColorEngine.clamp(item.val / 1.25, -1, 1);
        const halfPct = Math.abs(norm) * 50;
        item.bar.style.width = halfPct.toFixed(1) + '%';
        item.bar.style.left = (norm >= 0 ? 50 : (50 - halfPct)).toFixed(1) + '%';
      });
      axesInlineEl.textContent =
        'X' + formatSigned(state.ax) +
        ' Y' + formatSigned(state.ay) +
        ' Z' + formatSigned(state.az) + 'g';
    }

    function toggleHold(sendToHw, captureChip) {
      state.hold = !state.hold;
      state.pinnedCustomSwatch = false;
      if (state.hold) {
        state.heldColor = state.displayColor;
        if (captureChip) pushCapturedSwatch(state.displayColor);
        showToast('COLOR HELD · ' + state.displayColor.hex);
        announce('Held color ' + state.displayColor.hex);
      } else {
        state.heldColor = null;
        if (!state.hwConnected) {
          recomputeLocalTarget();
        } else {
          state.targetColor = ColorEngine.mapImuToColor(state.tx, state.ty, state.az, state.kin, state.mode);
        }
        showToast('LIVE IMU');
        announce('Live accelerometer tracking');
      }
      if (sendToHw) {
        state.pendingHoldUntil = Date.now() + COMMAND_LEASE_MS;
        link.sendCommand({ cmd: 'hold', h: state.hold });
      }
      renderStaticControls();
    }

    function triggerTare(sendToHw) {
      state.localTareX = state.ax;
      state.localTareY = state.ay;
      state.tx = 0;
      state.ty = 0;
      if (sendToHw) {
        link.sendCommand({ cmd: 'tare' });
      }
      if (!state.hwConnected) {
        recomputeLocalTarget();
      }
      showToast('ZERO TARED');
      announce('Zeroed accelerometer tilt reference');
    }

    function recomputeLocalTarget() {
      const tx = ColorEngine.clamp(state.ax - state.localTareX, -1.2, 1.2);
      const ty = ColorEngine.clamp(state.ay - state.localTareY, -1.2, 1.2);
      state.tx = tx;
      state.ty = ty;
      state.roll = Math.atan2(tx, Math.hypot(ty, state.az)) * (180 / Math.PI);
      state.pitch = Math.atan2(ty, Math.hypot(tx, state.az)) * (180 / Math.PI);
      state.targetColor = ColorEngine.mapImuToColor(tx, ty, state.az, state.kin, state.mode);
    }

    // ---------- Pointer & Keyboard Fallback on Gravity Dome ----------

    function applyDomePointer(ev, isInitialDown) {
      const rect = domePad.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      let nx = ColorEngine.clamp(((ev.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
      let ny = ColorEngine.clamp(1 - ((ev.clientY - rect.top) / rect.height) * 2, -1, 1);
      const radial = Math.hypot(nx, ny);
      if (radial > 1) {
        nx /= radial;
        ny /= radial;
      }
      const magSq = Math.min(0.96, nx * nx + ny * ny);
      const zSign = state.az >= 0 ? 1 : -1;
      state.simPreset = 'idle';
      state.localTareX = 0;
      state.localTareY = 0;
      state.ax = nx * 0.92;
      state.ay = ny * 0.92;
      state.az = zSign * Math.sqrt(Math.max(0.04, 1 - magSq));
      state.kin = isInitialDown
        ? 0
        : ColorEngine.clamp(Math.hypot(ev.movementX || 0, ev.movementY || 0) / 36, 0, 0.85);
      state.hold = false;
      state.pinnedCustomSwatch = false;
      state.heldColor = null;
      recomputeLocalTarget();
      renderStaticControls();
    }

    domePad.addEventListener('pointerdown', function (ev) {
      if (state.hwConnected) return;
      state.draggingPad = true;
      try { domePad.setPointerCapture(ev.pointerId); } catch (_e) {}
      applyDomePointer(ev, true);
    });

    domePad.addEventListener('pointermove', function (ev) {
      if (!state.draggingPad || state.hwConnected) return;
      applyDomePointer(ev, false);
    });

    function endDomeDrag() {
      if (!state.draggingPad && state.kin === 0) return;
      state.draggingPad = false;
      state.kin = 0;
      if (!state.hwConnected) {
        recomputeLocalTarget();
      }
    }
    domePad.addEventListener('pointerup', endDomeDrag);
    domePad.addEventListener('pointercancel', endDomeDrag);
    domePad.addEventListener('lostpointercapture', endDomeDrag);
    domePad.addEventListener('dblclick', function () {
      state.ax = 0;
      state.ay = 0;
      state.az = 1;
      triggerTare(state.hwConnected);
      renderStaticControls();
    });

    function onKeyDown(ev) {
      if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === 'm' || ev.key === 'M') {
        ev.preventDefault();
        setMode((state.mode + 1) % ColorEngine.MODES.length, true);
      } else if (ev.key === 't' || ev.key === 'T') {
        ev.preventDefault();
        triggerTare(true);
      } else if (ev.key === ' ' && ev.target === domePad) {
        ev.preventDefault();
        toggleHold(true, true);
      } else if (!state.hwConnected && ev.target === domePad) {
        const step = 0.12;
        let moved = false;
        if (ev.key === 'ArrowLeft') {
          ev.preventDefault();
          state.ax = ColorEngine.clamp(state.ax - step, -1, 1);
          moved = true;
        } else if (ev.key === 'ArrowRight') {
          ev.preventDefault();
          state.ax = ColorEngine.clamp(state.ax + step, -1, 1);
          moved = true;
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          state.ay = ColorEngine.clamp(state.ay + step, -1, 1);
          moved = true;
        } else if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          state.ay = ColorEngine.clamp(state.ay - step, -1, 1);
          moved = true;
        }
        if (moved) {
          const arrowRad = Math.hypot(state.ax, state.ay);
          if (arrowRad > 0.98) {
            state.ax = (state.ax / arrowRad) * 0.98;
            state.ay = (state.ay / arrowRad) * 0.98;
          }
          const magSq = Math.min(0.96, state.ax * state.ax + state.ay * state.ay);
          const zSign = state.az >= 0 ? 1 : -1;
          state.az = zSign * Math.sqrt(Math.max(0.04, 1 - magSq));
          state.simPreset = 'idle';
          state.hold = false;
          state.pinnedCustomSwatch = false;
          state.heldColor = null;
          recomputeLocalTarget();
          renderStaticControls();
        }
      }
    }
    rootEl.addEventListener('keydown', onKeyDown);

    // ---------- Swatch Strip & PNG Tear-Sheet Renderer ----------

    function renderSwatches() {
      clearNode(swatchStripEl);
      state.swatches.slice(0, 4).forEach(function (sw) {
        const dot = el('button', {
          type: 'button',
          className: 's3-swatch-dot',
          style: { backgroundColor: sw.hex },
          title: sw.hex + ' (' + sw.mode + ') — Click to preview & copy',
          'aria-label': 'Swatch ' + sw.hex,
          onClick: function () {
            const spec = ColorEngine.parseHexToSpec(sw.hex);
            if (spec) {
              state.hold = true;
              state.pinnedCustomSwatch = true;
              state.heldColor = spec;
              state.displayColor = spec;
              state.pendingHoldUntil = Date.now() + COMMAND_LEASE_MS;
              applyColorToDom(spec);
              link.sendCommand({ cmd: 'hold', h: 1 });
              copyToClipboard(sw.hex);
              showToast('PINNED ' + sw.hex);
              announce('Pinned swatch ' + sw.hex);
              renderStaticControls();
            }
          }
        });
        swatchStripEl.appendChild(dot);
      });

      clearNode(deckGridEl);
      state.swatches.forEach(function (sw) {
        const card = el('button', {
          type: 'button',
          className: 's3-deck-card',
          title: 'Click to copy ' + sw.hex,
          onClick: function () {
            copyToClipboard(sw.hex).then(function (res) {
              showToast((res && res.ok ? 'COPIED ' : 'HEX ') + sw.hex);
            });
          }
        }, [
          el('div', { className: 's3-deck-color', style: { backgroundColor: sw.hex } }),
          el('div', { className: 's3-deck-meta s3-mono' }, [
            el('strong', { textContent: sw.hex }),
            el('span', { textContent: sw.mode })
          ])
        ]);
        deckGridEl.appendChild(card);
      });
    }

    function downloadSwatchTearSheet() {
      const cols = Math.max(1, state.swatches.length);
      const cardW = 140;
      const cnv = document.createElement('canvas');
      cnv.width = cols * cardW + 32;
      cnv.height = 210;
      const ctx = cnv.getContext('2d');
      if (!ctx) return;

      ctx.fillStyle = '#fafafa';
      ctx.fillRect(0, 0, cnv.width, cnv.height);
      ctx.fillStyle = '#141413';
      ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText('M5StickS3 · Accelerometer Palette Tear-Sheet', 16, 26);

      state.swatches.forEach(function (sw, i) {
        const x = 16 + i * cardW;
        const y = 42;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x, y, cardW - 10, 148);
        ctx.fillStyle = sw.hex;
        ctx.fillRect(x + 6, y + 6, cardW - 22, 98);
        ctx.fillStyle = '#141413';
        ctx.font = '700 12px ui-monospace, Menlo, monospace';
        ctx.fillText(sw.hex, x + 8, y + 124);
        ctx.fillStyle = '#63635f';
        ctx.font = '500 10px ui-monospace, Menlo, monospace';
        ctx.fillText(sw.mode + ' · L' + sw.l, x + 8, y + 140);
      });

      const a = document.createElement('a');
      a.download = 'stick-s3-palette.png';
      a.href = cnv.toDataURL('image/png');
      a.click();
    }

    // ---------- Static Control Sync ----------

    function renderStaticControls() {
      const nowMode = state.mode;
      const modeInfo = ColorEngine.MODES[nowMode] || ColorEngine.MODES[0];

      modeBtns.forEach(function (btn, idx) {
        btn.setAttribute('aria-pressed', idx === nowMode ? 'true' : 'false');
      });
      dlgModeBtns.forEach(function (btn, idx) {
        btn.setAttribute('aria-pressed', idx === nowMode ? 'true' : 'false');
      });
      modeCycleBtn.textContent = modeInfo.shortLabel + ' ↻';
      swatchModeEl.textContent = modeInfo.shortLabel;
      modeHintEl.textContent = modeInfo.axisHint;

      holdBtn.setAttribute('aria-pressed', state.hold ? 'true' : 'false');
      holdBtn.textContent = state.hold ? 'Held' : 'Hold';

      zFlipBtn.textContent = state.az >= 0 ? 'Z+' : 'Z−';
      zFlipBtn.setAttribute('aria-pressed', state.az < 0 ? 'true' : 'false');

      simPresetBtns.forEach(function (btn) {
        btn.setAttribute('aria-pressed', btn.dataset.preset === state.simPreset && !state.hwConnected ? 'true' : 'false');
      });

      // Status Pill
      statusPill.classList.toggle('is-live', state.hwConnected && !state.hold);
      statusPill.classList.toggle('is-hold', state.hold);

      // Pill states (data-link for styling): held, connecting, live, demo, failed, waiting, manual.
      // Only `live` (fresh StickS3 telemetry) gets the green .is-live treatment.
      const directLinkOpen = state.linkSource === 'serial' || state.linkSource === 'ble';
      let pillState;
      if (state.hold) {
        pillState = 'held';
        statusText.textContent = 'HELD';
      } else if (state.linkPhase === 'connecting') {
        pillState = 'connecting';
        statusText.textContent = 'CONNECTING';
      } else if (state.hwConnected) {
        pillState = 'live';
        const srcBadge = state.linkSource === 'ble' ? 'S3 BLE' : (state.linkSource === 'serial' ? 'S3 USB' : 'STICK S3');
        statusText.textContent = state.battery >= 0 ? (srcBadge + ' · ' + state.battery + '%') : srcBadge;
      } else if (state.simPreset !== 'idle') {
        pillState = 'demo';
        statusText.textContent = 'DEMO ' + state.simPreset.toUpperCase();
      } else if (state.linkPhase === 'failed') {
        pillState = 'failed';
        statusText.textContent = (state.linkFailTag || 'LINK') + ' FAILED';
      } else if (directLinkOpen) {
        pillState = 'waiting';
        statusText.textContent = (state.linkSource === 'ble' ? 'BLE' : 'USB') + ' · NO DATA';
      } else {
        pillState = 'manual';
        statusText.textContent = 'TILT PAD';
      }
      statusPill.setAttribute('data-link', pillState);

      webSerialBtn.textContent = state.linkSource === 'serial' ? 'Disconnect Web Serial' : 'Connect USB Web Serial';
      webBleBtn.textContent = state.linkSource === 'ble' ? 'Disconnect BLE' : 'Pair Wireless BLE';
      webSerialBtn.disabled = state.linkPhase === 'connecting';
      webBleBtn.disabled = state.linkPhase === 'connecting';
      retryBridgeBtn.hidden = directLinkOpen || state.bridgeReachable || state.bridgeProbe === 'probing';

      let summary;
      if (state.hwConnected) {
        summary = 'LIVE (' + state.linkSource.toUpperCase() + (state.portName ? ' · ' + state.portName : '') + ')';
      } else if (state.linkPhase === 'connecting') {
        summary = 'Waiting for the ' + (state.linkFailTag === 'BLE' ? 'Bluetooth' : 'serial port') + ' chooser…';
      } else if (state.linkNote) {
        summary = state.linkNote;
      } else if (directLinkOpen) {
        summary = (state.linkSource === 'ble' ? 'BLE link' : 'Web Serial port') + ' open — no StickS3 telemetry yet';
      } else if (state.bridgeReachable) {
        summary = state.bridgePortOpen
          ? 'Local bridge has ' + (state.portName || 'a USB port') + ' open — no StickS3 telemetry yet'
          : 'Local bridge ready — plug in StickS3 USB-C or pair BLE';
      } else if (state.bridgeProbe === 'stopped') {
        summary = 'No local bridge on 127.0.0.1:8791 (stopped looking). Start bridge.mjs, then press Retry bridge.';
      } else if (state.bridgeProbe === 'probing') {
        summary = 'Looking for local bridge on 127.0.0.1:8791…';
      } else {
        summary = 'Interactive Tilt Pad active (run bridge.mjs or connect Web Serial / BLE)';
      }
      connSummaryEl.textContent = summary;
      statusPill.title = summary;
    }

    // ---------- Hardware Twin Canvas & Scope Renderers (Dialog Open Only) ----------

    function renderTwinAndScope(col) {
      const rotX = ColorEngine.clamp(state.pitch, -78, 78);
      const rollClamped = ColorEngine.clamp(state.roll, -78, 78);
      const rotY = state.az < 0 ? (180 - rollClamped) : rollClamped;
      twinRig.style.transform = 'rotateX(' + rotX.toFixed(1) + 'deg) rotateY(' + rotY.toFixed(1) + 'deg)';

      const ctx = twinLcdCanvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#101010';
        ctx.fillRect(0, 0, 135, 240);
        ctx.fillStyle = '#ffffff';
        ctx.font = '700 10px ui-monospace, Menlo, monospace';
        ctx.fillText('STICK S3', 8, 15);

        const lcdBadgeBg = state.hold ? '#b43a10' : (!state.hwConnected ? '#b45309' : '#047857');
        const lcdBadgeText = state.hold
          ? 'HOLD'
          : (!state.hwConnected ? 'SIM' : (state.linkSource === 'ble' ? 'BLE' : 'USB'));
        ctx.fillStyle = lcdBadgeBg;
        ctx.fillRect(72, 5, 32, 13);
        ctx.fillStyle = '#ffffff';
        ctx.font = '700 8.5px ui-monospace, Menlo, monospace';
        ctx.fillText(lcdBadgeText, 76, 14);

        ctx.fillStyle = col.hex;
        ctx.fillRect(8, 24, 119, 112);

        const twinTheme = ColorEngine.pickAdaptiveTheme(col.r, col.g, col.b);
        ctx.strokeStyle = twinTheme.ink;
        ctx.fillStyle = twinTheme.ink;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(67.5, 78, 25, 0, Math.PI * 2);
        ctx.stroke();

        const dx = 67.5 + ColorEngine.clamp(state.tx, -1, 1) * 20;
        const dy = 78 - ColorEngine.clamp(state.ty, -1, 1) * 20;
        ctx.beginPath();
        ctx.arc(dx, dy, 4.5, 0, Math.PI * 2);
        ctx.fill();

        const modeMeta = ColorEngine.MODES[state.mode] || ColorEngine.MODES[0];
        ctx.font = '700 10px ui-monospace, Menlo, monospace';
        ctx.fillText(col.hex, 14, 128);
        ctx.fillText(modeMeta.shortLabel, 14, 38);

        const bars = [
          { lbl: 'X', v: state.ax, c: '#f87171', y: 152 },
          { lbl: 'Y', v: state.ay, c: '#34d399', y: 168 },
          { lbl: 'Z', v: state.az, c: '#60a5fa', y: 184 }
        ];
        bars.forEach(function (b) {
          ctx.fillStyle = '#a3a3a0';
          ctx.font = '600 9px ui-monospace, Menlo, monospace';
          ctx.fillText(b.lbl, 8, b.y + 7);
          ctx.fillStyle = '#262624';
          ctx.fillRect(22, b.y, 64, 7);
          const w = Math.round(ColorEngine.clamp(Math.abs(b.v) / 1.25, 0, 1) * 30);
          ctx.fillStyle = b.c;
          ctx.fillRect(b.v >= 0 ? 54 : 54 - w, b.y + 1, w, 5);
          ctx.fillStyle = '#f5f5f3';
          ctx.fillText(formatSigned(b.v), 91, b.y + 7);
        });

        ctx.fillStyle = '#a3a3a0';
        ctx.fillText('[A] HOLD/TARE  [B] MODE', 8, 224);
      }

      const sctx = scopeCanvas.getContext('2d');
      if (sctx && state.scopeHistory.length > 1) {
        const W = scopeCanvas.width;
        const H = scopeCanvas.height;
        sctx.fillStyle = '#141413';
        sctx.fillRect(0, 0, W, H);
        sctx.strokeStyle = 'rgba(255,255,255,0.12)';
        sctx.beginPath();
        sctx.moveTo(0, H / 2);
        sctx.lineTo(W, H / 2);
        sctx.stroke();

        const series = [
          { key: 'ax', stroke: '#f87171' },
          { key: 'ay', stroke: '#34d399' },
          { key: 'az', stroke: '#60a5fa' }
        ];
        series.forEach(function (tr) {
          sctx.strokeStyle = tr.stroke;
          sctx.lineWidth = 1.5;
          sctx.beginPath();
          state.scopeHistory.forEach(function (pt, idx) {
            const x = (idx / 59) * W;
            const y = H / 2 - ColorEngine.clamp(pt[tr.key], -1.4, 1.4) * (H * 0.34);
            if (idx === 0) sctx.moveTo(x, y);
            else sctx.lineTo(x, y);
          });
          sctx.stroke();
        });
      }
    }

    // ---------- 60 FPS Animation & Perceptual OKLab Damper Loop ----------

    function renderFrame(nowMs) {
      if (destroyed) return;
      const frameMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();

      if (!state.hwConnected && state.simPreset !== 'idle' && !state.draggingPad && !state.hold) {
        const sim = ColorEngine.sampleDemoMotion(state.simPreset, frameMs * 0.001);
        state.ax = sim.ax;
        state.ay = sim.ay;
        state.az = sim.az;
        state.kin = sim.kin;
        recomputeLocalTarget();
      }

      if (!state.hwConnected && frameMs - lastSimScopeMs >= 33) {
        lastSimScopeMs = frameMs;
        state.scopeHistory.push({ ax: state.ax, ay: state.ay, az: state.az });
        if (state.scopeHistory.length > 60) state.scopeHistory.shift();
      }

      const reducedMotion = isReducedMotion();
      const lerpFactor = reducedMotion ? 1 : 0.28;
      const goal = state.hold && state.heldColor ? state.heldColor : state.targetColor;
      state.displayColor =
        lerpFactor >= 1 ||
        (state.displayColor &&
          goal &&
          state.displayColor.r === goal.r &&
          state.displayColor.g === goal.g &&
          state.displayColor.b === goal.b)
          ? goal
          : ColorEngine.lerpColorOklab(state.displayColor, goal, lerpFactor);
      const col = state.displayColor;

      const theme = applyColorToDom(col);

      // Update SVG Gravity Dome coordinates (clamped to unit disk so puck stays inside domeRing)
      let dx = ColorEngine.clamp(state.tx, -1, 1);
      let dy = ColorEngine.clamp(state.ty, -1, 1);
      const dMag = Math.hypot(dx, dy);
      if (dMag > 1) {
        dx /= dMag;
        dy /= dMag;
      }
      const px = 50 + dx * 34;
      const py = 50 - dy * 34;
      stemHalo.setAttribute('x2', px.toFixed(1));
      stemHalo.setAttribute('y2', py.toFixed(1));
      stemLine.setAttribute('x2', px.toFixed(1));
      stemLine.setAttribute('y2', py.toFixed(1));
      puckHalo.setAttribute('cx', px.toFixed(1));
      puckHalo.setAttribute('cy', py.toFixed(1));
      puckDot.setAttribute('cx', px.toFixed(1));
      puckDot.setAttribute('cy', py.toFixed(1));
      domeRing.classList.toggle('is-nadir', state.az < 0);

      const kinCircumference = 2 * Math.PI * 46.5;
      const kinArcLen = ColorEngine.clamp(state.kin, 0, 1) * kinCircumference;
      kinArc.setAttribute('stroke-dasharray', kinArcLen.toFixed(1) + ' 320');

      applyAxisBarsToDom();

      if (dialog.open) {
        heroSwatch.style.backgroundColor = col.hex;
        heroHexEl.textContent = col.hex;
        heroMetricsEl.textContent =
          'oklch(' + col.l.toFixed(2) + ' ' + col.c.toFixed(3) + ' ' + pad3(col.h) + 'deg)';
        heroContrastEl.textContent = 'Reticle ' + theme.contrastRatio.toFixed(1) + ':1 AA · Capsule AAA';
        scopeRateEl.textContent = state.hwConnected ? (state.packetHz + ' Hz live') : 'Simulated · 30 Hz';
        renderTwinAndScope(col);
      }

      if (!destroyed && typeof root.requestAnimationFrame === 'function') {
        rafId = root.requestAnimationFrame(renderFrame);
      }
    }

    // ---------- Hardware Link Wiring ----------

    const link = Transport.createStickLink({
      onTelemetry: function (pkt, src) {
        if (destroyed) return;
        const now = Date.now();
        pktCounter++;
        if (now - lastRateTickMs >= 1000) {
          state.packetHz = Math.round((pktCounter * 1000) / (now - lastRateTickMs));
          pktCounter = 0;
          lastRateTickMs = now;
        }

        const prevConnected = state.hwConnected;
        const prevBat = state.battery;
        const prevSrc = state.linkSource;
        const prevZSign = state.az >= 0;

        state.hwConnected = true;
        state.linkSource = src || state.linkSource;
        state.ax = pkt.ax;
        state.ay = pkt.ay;
        state.az = pkt.az;
        state.tx = pkt.tx;
        state.ty = pkt.ty;
        state.roll = pkt.roll;
        state.pitch = pkt.pitch;
        state.kin = pkt.kin;
        state.battery = pkt.battery;

        let needsStaticSync =
          prevConnected !== state.hwConnected ||
          prevBat !== state.battery ||
          prevSrc !== state.linkSource ||
          prevZSign !== (state.az >= 0);

        const safePktMode =
          Number.isFinite(Number(pkt.mode)) && ColorEngine.MODES[pkt.mode] ? pkt.mode : 0;

        if (pkt.event && pkt.seq !== state.lastHandledEventSeq) {
          state.lastHandledEventSeq = pkt.seq;
          if (pkt.event === 'swatch') {
            state.pinnedCustomSwatch = false;
            state.pendingHoldUntil = 0;
            state.hold = true;
            state.heldColor = pkt.color;
            needsStaticSync = true;
            pushCapturedSwatch(pkt.color);
            showToast('BTN-A SWATCH · ' + pkt.color.hex);
          } else if (pkt.event === 'live') {
            if (state.pinnedCustomSwatch || now > state.pendingHoldUntil) {
              state.pinnedCustomSwatch = false;
              state.pendingHoldUntil = 0;
              state.hold = false;
              state.heldColor = null;
              needsStaticSync = true;
            }
          } else if (pkt.event === 'hold') {
            if (now > state.pendingHoldUntil && !state.pinnedCustomSwatch) {
              state.hold = true;
              state.heldColor = pkt.color;
              needsStaticSync = true;
            }
          } else if (pkt.event === 'tare') {
            showToast('STICK S3 TARED');
          } else if (pkt.event === 'mode') {
            if (now > state.pendingModeUntil) {
              showToast('MODE · ' + ColorEngine.MODES[safePktMode].shortLabel);
            }
          }
        }

        if (now > state.pendingModeUntil && safePktMode !== state.mode) {
          state.mode = safePktMode;
          needsStaticSync = true;
        }

        if (now > state.pendingHoldUntil) {
          if (pkt.hold !== state.hold) {
            state.hold = pkt.hold;
            if (!state.hold) {
              state.pinnedCustomSwatch = false;
              state.heldColor = null;
            } else if (!state.pinnedCustomSwatch) {
              state.heldColor = pkt.color;
            }
            needsStaticSync = true;
          } else if (state.hold && !state.pinnedCustomSwatch && pkt.hold === true) {
            state.heldColor = pkt.color;
          }
        }

        if (now <= state.pendingModeUntil || (now <= state.pendingHoldUntil && !state.hold)) {
          state.targetColor = ColorEngine.mapImuToColor(pkt.tx, pkt.ty, pkt.az, pkt.kin, state.mode);
        } else {
          state.targetColor = pkt.color;
        }

        if (needsStaticSync) {
          renderStaticControls();
        }

        state.scopeHistory.push({ ax: pkt.ax, ay: pkt.ay, az: pkt.az });
        if (state.scopeHistory.length > 60) state.scopeHistory.shift();
      },
      onStatus: function (st) {
        if (destroyed) return;
        const prevConnected = state.hwConnected;
        const prevReachable = state.bridgeReachable;
        const prevSrc = state.linkSource;
        const prevPort = state.portName;
        const prevProbe = state.bridgeProbe;
        const prevPortOpen = state.bridgePortOpen;
        state.hwConnected = Boolean(st.connected);
        state.linkSource = st.source || 'none';
        state.bridgeReachable = Boolean(st.bridgeReachable);
        state.portName = st.portName || '';
        state.bridgeProbe = st.bridgeProbe || 'probing';
        state.bridgePortOpen = Boolean(st.bridgePortOpen);
        if (state.hwConnected && state.linkPhase !== 'connecting') {
          state.linkPhase = '';
          state.linkNote = '';
        }
        if (!state.hwConnected) {
          state.battery = -1;
          state.packetHz = 0;
          pktCounter = 0;
        }
        if (
          prevConnected !== state.hwConnected ||
          prevReachable !== state.bridgeReachable ||
          prevSrc !== state.linkSource ||
          prevPort !== state.portName ||
          prevProbe !== state.bridgeProbe ||
          prevPortOpen !== state.bridgePortOpen ||
          Boolean(st.detail)
        ) {
          renderStaticControls();
        }
      }
    });

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (rafId !== null && typeof root.cancelAnimationFrame === 'function') {
        root.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      if (announceTimer) {
        clearTimeout(announceTimer);
        announceTimer = null;
      }
      rootEl.removeEventListener('keydown', onKeyDown);
      try {
        if (dialog.open && typeof dialog.close === 'function') {
          dialog.close();
        }
      } catch (_e) {}
      if (dialog.parentNode) {
        dialog.parentNode.removeChild(dialog);
      }
      if (rootEl.__stickS3Instance === instance) {
        rootEl.__stickS3Instance = null;
      }
      link.destroy();
    }

    const instance = {
      destroy: destroy
    };
    rootEl.__stickS3Instance = instance;

    renderSwatches();
    recomputeLocalTarget();
    state.displayColor = state.targetColor;
    applyColorToDom(state.displayColor);
    applyAxisBarsToDom();
    renderStaticControls();
    link.start();
    if (typeof root.requestAnimationFrame === 'function') {
      rafId = root.requestAnimationFrame(renderFrame);
    }
    return instance;
  }

  function bootstrap() {
    const mount = document.getElementById('cell-stick-s3');
    if (mount) {
      mountStickS3Cell(mount);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  NS.UI = {
    mount: mountStickS3Cell
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
