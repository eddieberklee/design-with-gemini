/**
 * UI & Seamless Secondary-Grid Portal (`cells/left-grille/ui.js`)
 *
 * Mounts:
 * 1. Main Grid Cell (`#cell-left-grille`): Tactile Swiss/Braun specimen card with inline SVG
 *    MacBook Pro left speaker grille elevation (`8%–22%` CNC mic through-holes + blind dimples
 *    outside `8%–22%`).
 * 2. Secondary Page (`#left-grille-page`): Replaces `<main class="grid">` seamlessly in-page
 *    with a Back button (`← Grid`, `Escape`, and History `#left-grille` sync), a global
 *    `[● ARM ARRAY]` toggle in `.lg-nav-bar` wired to `window.LeftGrilleLab.bus`, and a
 *    secondary `.grid` of 9 `.cell` cards (`#lg-sec-cell-1` .. `#lg-sec-cell-9`) obeying
 *    the exact same sizing and layout rules as the main grid.
 * 3. Secondary Cell 1 (`#lg-sec-cell-1`): Live Left-Grille Acoustic Swipe Instrument displaying
 *    Direction (`UP` vs `DOWN`), Speed (`cm/s` + peak), Dual-Reference Relative Distance
 *    (`% FROM TOP` & `% FROM BTM` + `cm`), 1:1 vernier rail with `±1σ` uncertainty halo,
 *    rolling 2-trace trajectory/Doppler scope, 1-stroke calibration, and rail-drag/Sim fallbacks.
 * 4. Secondary Cells 2–9 (`#lg-sec-cell-2` .. `#lg-sec-cell-9`): Registered dynamically via
 *    `window.LeftGrilleLab.registerCell(slotNumber, spec)` and coordinated with Cell 1 so
 *    arming `LeftGrilleLab.bus` stops Cell 1's standalone mic (and vice versa), while closing
 *    the secondary view calls `LeftGrilleLab.bus.stopAll()`. Exposes
 *    `LeftGrilleLab.isSecondaryOpen()` and dispatches `CustomEvent('lg-secondary-open')`
 *    whenever `#left-grille-page` transitions from hidden to open.
 */
(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const GRILLE_CM = 11.0;

  const DEFAULT_CALIBRATION_PROTOCOL = [
    { id: 'zone-0', kind: 'zone', targetY: 0.02, label: '1/14 · Rub VERY TOP (beside Esc)', short: 'Top 0%' },
    { id: 'zone-20', kind: 'zone', targetY: 0.18, label: '2/14 · Rub UPPER-LEFT (beside ~ / Tab mics)', short: 'Mics 18%' },
    { id: 'zone-50', kind: 'zone', targetY: 0.50, label: '3/14 · Rub MIDDLE (beside Caps Lock)', short: 'Mid 50%' },
    { id: 'zone-75', kind: 'zone', targetY: 0.75, label: '4/14 · Rub LOWER-MID (beside Shift)', short: 'Low 75%' },
    { id: 'zone-100', kind: 'zone', targetY: 0.96, label: '5/14 · Rub BOTTOM (beside Fn / Ctrl)', short: 'Btm 100%' },
    { id: 'down-slow', kind: 'swipe', direction: 'down', startY: 0.04, endY: 0.96, label: '6/14 · Swipe DOWN Slowly (Esc → Fn, ~0.8s)', short: 'Slow ↓' },
    { id: 'down-fast', kind: 'swipe', direction: 'down', startY: 0.04, endY: 0.96, label: '7/14 · Swipe DOWN Fast (Esc → Fn flick)', short: 'Fast ↓' },
    { id: 'up-slow', kind: 'swipe', direction: 'up', startY: 0.96, endY: 0.04, label: '8/14 · Swipe UP Slowly (Fn → Esc, ~0.8s)', short: 'Slow ↑' },
    { id: 'up-fast', kind: 'swipe', direction: 'up', startY: 0.96, endY: 0.04, label: '9/14 · Swipe UP Fast (Fn → Esc flick)', short: 'Fast ↑' },
    { id: 'top-down', kind: 'swipe', direction: 'down', startY: 0.04, endY: 0.50, label: '10/14 · Top-Half Swipe DOWN (Esc → Caps)', short: 'Top ↓' },
    { id: 'top-up', kind: 'swipe', direction: 'up', startY: 0.50, endY: 0.04, label: '11/14 · Top-Half Swipe UP (Caps → Esc)', short: 'Top ↑' },
    { id: 'btm-down', kind: 'swipe', direction: 'down', startY: 0.50, endY: 0.96, label: '12/14 · Bottom-Half Swipe DOWN (Caps → Fn)', short: 'Btm ↓' },
    { id: 'btm-up', kind: 'swipe', direction: 'up', startY: 0.96, endY: 0.50, label: '13/14 · Bottom-Half Swipe UP (Fn → Caps)', short: 'Btm ↑' },
    { id: 'veto-keys', kind: 'negative', label: '14/14 · Tap ~, Caps & Shift once, then press Fit & Lock', prompt: 'Tap ~, Caps & Shift once, then press Fit & Lock', short: 'Keys Veto' }
  ];

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'className') el.className = v;
        else if (k === 'textContent') el.textContent = String(v);
        else if (k === 'dataset') {
          Object.keys(v).forEach((dk) => {
            if (v[dk] !== undefined && v[dk] !== null) el.dataset[dk] = String(v[dk]);
          });
        } else if (k.startsWith('on') && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v === true) {
          if (k === 'disabled' || k === 'hidden') el[k] = true;
          el.setAttribute(k, '');
        } else {
          el.setAttribute(k, String(v));
        }
      });
    }
    if (children !== undefined && children !== null) {
      const list = Array.isArray(children) ? children : [children];
      list.forEach((c) => {
        if (c === undefined || c === null || c === false) return;
        if (typeof c === 'string' || typeof c === 'number') {
          el.appendChild(document.createTextNode(String(c)));
          if (!el.textContent) el.textContent = String(c);
        } else {
          el.appendChild(c);
        }
      });
    }
    return el;
  }

  function svgEl(tag, attrs, children) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        if (attrs[k] !== undefined && attrs[k] !== null) {
          node.setAttribute(k, String(attrs[k]));
        }
      });
    }
    if (children) {
      children.forEach((c) => {
        if (c) node.appendChild(c);
      });
    }
    return node;
  }

  function clamp(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  function buildGrilleSvg(opts) {
    const width = opts.width || 44;
    const height = opts.height || 140;
    const cols = opts.cols || 5;
    const rows = opts.rows || 22;
    const dots = [];

    for (let r = 0; r < rows; r++) {
      const yFrac = (r + 0.5) / rows;
      const isMicPort = yFrac >= 0.08 && yFrac <= 0.22;
      const cy = Math.round(yFrac * (height - 12) + 6);
      for (let c = 0; c < cols; c++) {
        const cx = Math.round(((c + 0.5) / cols) * (width - 12) + 6);
        dots.push(
          svgEl('circle', {
            cx,
            cy,
            r: isMicPort ? 1.55 : 1.15,
            fill: isMicPort ? '#1c1c1a' : '#c0c0ba',
            opacity: isMicPort ? '0.92' : '0.72'
          })
        );
      }
    }

    if (opts.withNeedle) {
      dots.push(
        svgEl('rect', {
          x: 2,
          y: Math.round(0.08 * (height - 12) + 4),
          width: width - 4,
          height: Math.round(0.15 * (height - 12) + 4),
          rx: 3,
          fill: 'none',
          stroke: '#0052cc',
          'stroke-width': '1',
          'stroke-dasharray': '2 2',
          opacity: '0.55'
        })
      );
      const needleGroup = svgEl('g', { class: 'lg-portal-needle' }, [
        svgEl('rect', {
          x: -3,
          y: Math.round(height * 0.68) - 1,
          width: width + 6,
          height: 2.5,
          rx: 1.2,
          fill: '#c93700'
        })
      ]);
      dots.push(needleGroup);
    }

    return svgEl(
      'svg',
      {
        viewBox: `0 0 ${width} ${height}`,
        class: opts.className || '',
        'aria-hidden': 'true',
        preserveAspectRatio: 'none'
      },
      [
        svgEl('rect', {
          x: 0.5,
          y: 0.5,
          width: width - 1,
          height: height - 1,
          rx: opts.frameRadius !== undefined ? opts.frameRadius : 6,
          fill: opts.bgFill || '#f4f4f1',
          stroke: opts.stroke || '#e2e2dd'
        }),
        ...dots
      ]
    );
  }

  function prefersReducedMotion() {
    return Boolean(
      global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  function mountLeftGrillePortal(portalCell) {
    const mainGrid = document.querySelector('main.grid');
    if (!portalCell || !mainGrid) return null;

    const ControllerCls =
      global.LeftGrilleController && global.LeftGrilleController.LeftGrilleSensorController;
    if (!ControllerCls) return null;

    const lab = (global.LeftGrilleLab =
      global.LeftGrilleLab && typeof global.LeftGrilleLab === 'object'
        ? global.LeftGrilleLab
        : { _pending: [] });

    // Synchronous navigation intent state (`targetOpen`) + monotonic VT guard (`vtSeq`)
    let targetOpen = false;
    let isSecondaryOpen = false;
    let enteredFromMainGrid = false;
    let vtSeq = 0;
    // `history.back()` is async: until its popstate lands, `location.hash` and `history.state`
    // still describe our entry, so a second close request would step back twice.
    let backPendingUntil = 0;

    lab.isSecondaryOpen = () => isSecondaryOpen;

    let calWizardActive = false;
    let calAutoArmedMic = false;
    let calOpening = false;
    let calSummaryActive = false;
    let calSessionSeq = 0;
    let overlayReturnFocusEl = null;
    let wasStrokeActive = false;
    let lastCommittedSwipe = null;

    const SCOPE_LEN = 140;
    const scopeHist = [];
    for (let i = 0; i < SCOPE_LEN; i++) {
      scopeHist.push({ y: 0.5, unc: 0.1, asym: 0, active: false });
    }
    let lastDopplerBins = new Array(32).fill(0);
    let rafPending = false;

    // -------------------------------------------------------------------------
    // 1. Render Main Grid Portal Cell (`#cell-left-grille`)
    // -------------------------------------------------------------------------
    const portalBtn = h(
      'button',
      {
        type: 'button',
        className: 'lg-portal-btn',
        'aria-label': 'Open Left Grille Acoustic Swipe Sonar secondary grid',
        onClick: () => openSecondaryView({ fromUserTap: true })
      },
      [
        h('div', { className: 'lg-portal-top' }, [
          h('div', { className: 'lg-portal-head-left' }, [
            h('span', { className: 'lg-kicker', textContent: '05' }),
            h('span', { className: 'lg-portal-title', textContent: 'Left Grille Sonar' })
          ]),
          h('span', { className: 'lg-portal-arrow', 'aria-hidden': 'true', textContent: '↗' })
        ]),
        h('div', { className: 'lg-portal-graphic' }, [
          buildGrilleSvg({
            width: 48,
            height: 132,
            cols: 5,
            rows: 20,
            withNeedle: true,
            className: 'lg-portal-svg'
          })
        ]),
        h('div', { className: 'lg-portal-bottom' }, [
          h('span', { className: 'lg-portal-sub', textContent: 'Speaker + 3-mic swipe array' }),
          h('span', { className: 'lg-portal-spec', textContent: '48 kHz · L' })
        ])
      ]
    );
    portalCell.appendChild(portalBtn);

    // -------------------------------------------------------------------------
    // 2. Build Secondary Page (`#left-grille-page`) with Exact `.grid` Parity
    // -------------------------------------------------------------------------
    const srLive = h('div', {
      className: 'lg-sr-only',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true'
    });

    function announce(text) {
      srLive.textContent = '';
      setTimeout(() => {
        srLive.textContent = text;
      }, 20);
    }

    const backBtn = h(
      'button',
      {
        type: 'button',
        className: 'lg-back-btn',
        'aria-label': 'Back to main grid',
        onClick: () => requestCloseSecondaryView()
      },
      ['← Grid']
    );

    const busStatusMeta = h('span', {
      className: 'lg-bus-meta',
      dataset: { error: 'false' },
      textContent: 'Cells 02–06'
    });

    const armArrayDot = h('span', { className: 'lg-dot', 'aria-hidden': 'true' });
    const armArrayLabel = h('span', { textContent: 'ARM ARRAY' });
    const armArrayBtn = h(
      'button',
      {
        type: 'button',
        id: 'lg-arm-array-btn',
        className: 'lg-arm-array-btn',
        dataset: { armed: 'false', state: 'idle' },
        'aria-pressed': 'false',
        title: 'Arm or disarm shared 48 kHz microphone and stereo sonar bus for Cells 02–06',
        onClick: () => toggleSharedArray()
      },
      [armArrayDot, armArrayLabel]
    );

    const navBar = h('nav', { className: 'lg-nav-bar', 'aria-label': 'Secondary page navigation' }, [
      h('div', { className: 'lg-nav-left' }, [
        backBtn,
        h('span', { className: 'lg-breadcrumb', textContent: '05 / Left Grille Acoustic Sonar' })
      ]),
      h('div', { className: 'lg-nav-right' }, [
        busStatusMeta,
        armArrayBtn,
        h('span', { className: 'lg-kbd-hint' }, [h('kbd', { textContent: 'Esc' }), 'back'])
      ])
    ]);

    // Build Instrument UI inside Secondary Cell 1
    const armDot = h('span', { className: 'lg-dot', 'aria-hidden': 'true' });
    const armLabel = h('span', { textContent: 'ARM MIC' });
    const armBtn = h(
      'button',
      {
        type: 'button',
        className: 'lg-btn lg-btn--arm',
        dataset: { armed: 'false' },
        'aria-pressed': 'false',
        title: 'Start or stop 48 kHz Left-Speaker Sonar + Built-in Mic Array',
        onClick: () => toggleArm()
      },
      [armDot, armLabel]
    );

    const statusPill = h('span', {
      className: 'lg-status-pill',
      textContent: 'READY · Arm or drag'
    });

    const sonarBtn = h(
      'button',
      {
        type: 'button',
        className: 'lg-btn lg-btn--sonar',
        'aria-pressed': 'true',
        title: 'Toggle 18.4–21.4 kHz Left-Speaker ultrasonic pilot comb',
        onClick: () => controller.setSonarEnabled(!controller.txEnabled)
      },
      ['19k L-CH']
    );

    const calBtn = h(
      'button',
      {
        type: 'button',
        className: 'lg-btn',
        'aria-expanded': 'false',
        title: 'Calibrate top/bottom left-grille anchors or invert mic polarity',
        onClick: () => openCalibrationWizard(calBtn)
      },
      ['CAL']
    );

    const bezel = h('div', { className: 'lg-bezel' }, [
      h('div', { className: 'lg-bezel-group' }, [armBtn, statusPill]),
      h('div', { className: 'lg-bezel-group' }, [sonarBtn, calBtn])
    ]);

    // Physical 11.0 cm Left-Grille Vernier Rail (`aria-valuenow` = % from bottom so ArrowUp increases!)
    const spanRibbon = h('div', { className: 'lg-span-ribbon' });
    const sigmaBand = h('div', { className: 'lg-sigma-band' });
    const needle = h('div', { className: 'lg-needle' });
    const micZoneBadge = h('span', { className: 'lg-mic-zone-badge', textContent: 'MIC' });

    const railTrack = h('div', { className: 'lg-rail-track' }, [
      buildGrilleSvg({
        width: 48,
        height: 180,
        cols: 5,
        rows: 26,
        withNeedle: false,
        frameRadius: 0,
        bgFill: '#ecece8',
        stroke: 'none',
        className: 'lg-rail-holes'
      }),
      micZoneBadge,
      spanRibbon,
      sigmaBand,
      needle
    ]);

    const railWrap = h(
      'div',
      {
        className: 'lg-rail-wrap',
        tabIndex: 0,
        role: 'slider',
        'aria-orientation': 'vertical',
        'aria-label': 'Left speaker grille vertical position',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': '50',
        'aria-valuetext': '50% from top, 50% from bottom',
        title: 'Swipe physical left speaker grille when armed, or drag vertically here'
      },
      [
        h('div', { className: 'lg-rail-cap' }, [
          h('span', { textContent: 'TOP' }),
          h('span', { textContent: 'ESC' })
        ]),
        railTrack,
        h('div', { className: 'lg-rail-cap' }, [
          h('span', { textContent: 'BTM' }),
          h('span', { textContent: 'FN' })
        ])
      ]
    );

    // Telemetry Readouts
    const dirText = h('span', { className: 'lg-dir-text', textContent: '— IDLE' });
    const confBadge = h('span', { className: 'lg-conf-badge', textContent: '' });
    const modeMeta = h('div', { className: 'lg-sub-meta', textContent: 'Swipe left speaker grille ↑/↓' });

    const speedNum = h('span', { textContent: '0.0' });
    const speedPeakMeta = h('div', { className: 'lg-sub-meta', textContent: 'pk 0.0 cm/s' });

    const topPctStrong = h('strong', { textContent: '50%' });
    const btmPctStrong = h('strong', { textContent: '50%' });
    const cmSpanText = h('span', {
      className: 'lg-dist-tag lg-dist-tag--cm',
      textContent: '5.5 cm top'
    });

    const simUpBtn = h(
      'button',
      {
        type: 'button',
        className: 'lg-mini-btn',
        title: 'Inject synthetic 48 kHz Swipe Up through DSP engine',
        onClick: () => controller.runSimulatedSwipe('up')
      },
      ['Sim ↑']
    );
    const simDownBtn = h(
      'button',
      {
        type: 'button',
        className: 'lg-mini-btn',
        title: 'Inject synthetic 48 kHz Swipe Down through DSP engine',
        onClick: () => controller.runSimulatedSwipe('down')
      },
      ['Sim ↓']
    );
    const flipBtn = h(
      'button',
      {
        type: 'button',
        className: 'lg-mini-btn lg-mini-btn--flip',
        title: 'Invert top/bottom microphone polarity',
        onClick: () => controller.togglePolarity()
      },
      ['Flip']
    );

    const scopeCanvas = h('canvas', { className: 'lg-scope-canvas', 'aria-hidden': 'true' });
    const scopeLeftNote = h('span', { textContent: 'Position y(t) · 11.0 cm left grille' });
    const scopeRightNote = h('span', { textContent: 'Doppler ±Δf' });

    const scopeBox = h('div', { className: 'lg-scope-box' }, [
      scopeCanvas,
      h('div', { className: 'lg-scope-caption' }, [scopeLeftNote, scopeRightNote])
    ]);

    // Calibration / Error Overlay mounted directly on `.lg-telemetry` so it stays visible at <= 245px!
    const calStepPill = h('span', {
      className: 'lg-cal-step-pill',
      textContent: '1 / 14'
    });
    const calCollectorBadge = h('span', {
      className: 'lg-cal-disk-badge',
      dataset: { online: 'false' },
      textContent: '○ LOCAL + JSON'
    });
    const calMeterFill = h('div', {
      className: 'lg-cal-meter-fill',
      dataset: { hot: 'false' }
    });
    const calMeterText = h('span', {
      className: 'lg-cal-meter-db',
      textContent: '+0dB'
    });
    const calMeterWrap = h(
      'div',
      {
        className: 'lg-cal-meter',
        title: 'Live acoustic signal-to-noise ratio (dB)'
      },
      [h('div', { className: 'lg-cal-meter-track' }, [calMeterFill]), calMeterText]
    );
    const calHeadRow = h('div', { className: 'lg-cal-head', hidden: true }, [
      h('div', { className: 'lg-cal-head-left' }, [calStepPill, calCollectorBadge]),
      calMeterWrap
    ]);
    const overlayMsg = h('div', { className: 'lg-overlay-text' });
    const calSubHint = h('div', {
      className: 'lg-cal-subhint',
      dataset: { warn: 'false' },
      hidden: true
    });
    const overlayActions = h('div', { className: 'lg-overlay-row' });
    const inlineOverlay = h(
      'div',
      {
        className: 'lg-inline-overlay',
        hidden: true,
        role: 'region',
        'aria-label': 'Left grille calibration suite'
      },
      [calHeadRow, overlayMsg, calSubHint, overlayActions]
    );

    const simActionsWrap = h('div', { className: 'lg-sim-actions' }, [
      simUpBtn,
      simDownBtn,
      flipBtn
    ]);

    function syncBackgroundControlsInert() {
      const overlayShown = !inlineOverlay.hidden;
      simActionsWrap.inert = overlayShown;
      if (overlayShown) {
        simActionsWrap.setAttribute('inert', '');
      } else if (typeof simActionsWrap.removeAttribute === 'function') {
        simActionsWrap.removeAttribute('inert');
      }
      const bgBtns = [simUpBtn, simDownBtn, flipBtn];
      for (let i = 0; i < bgBtns.length; i++) {
        const btn = bgBtns[i];
        btn.tabIndex = overlayShown ? -1 : 0;
        btn.inert = overlayShown;
        if (overlayShown) {
          btn.setAttribute('tabindex', '-1');
        } else if (typeof btn.removeAttribute === 'function') {
          btn.removeAttribute('tabindex');
        } else {
          btn.setAttribute('tabindex', '0');
        }
      }
    }

    const telemetryCol = h('div', { className: 'lg-telemetry' }, [
      h('div', { className: 'lg-tier-hero' }, [
        h('div', { className: 'lg-card' }, [
          h('span', { className: 'lg-label', textContent: 'Direction' }),
          h('div', { className: 'lg-dir-readout' }, [dirText, confBadge]),
          modeMeta
        ]),
        h('div', { className: 'lg-card' }, [
          h('span', { className: 'lg-label', textContent: 'Speed' }),
          h('div', { className: 'lg-speed-val' }, [
            speedNum,
            h('span', { className: 'lg-speed-unit', textContent: ' cm/s' })
          ]),
          speedPeakMeta
        ])
      ]),
      h('div', { className: 'lg-tier-dist' }, [
        h('div', { className: 'lg-dist-pair' }, [
          h('span', { className: 'lg-dist-item' }, [
            topPctStrong,
            h('span', { className: 'lg-dist-tag', textContent: ' TOP' })
          ]),
          h('span', { className: 'lg-dist-item' }, [
            btmPctStrong,
            h('span', { className: 'lg-dist-tag', textContent: ' BTM' })
          ]),
          cmSpanText
        ]),
        simActionsWrap
      ]),
      scopeBox,
      inlineOverlay
    ]);

    const secCell1 = h(
      'section',
      {
        id: 'lg-sec-cell-1',
        className: 'cell lg-instrument-cell ui-tile',
        'aria-label': 'Left Grille Acoustic Swipe Detector'
      },
      [
        h('div', { className: 'lg-inst-stage' }, [
          bezel,
          h('div', { className: 'lg-body' }, [railWrap, telemetryCol])
        ]),
        srLive
      ]
    );

    const secondarySlotMap = {};
    const secondarySlotEls = [];
    for (let slot = 2; slot <= 9; slot++) {
      const slotEl = h('section', {
        id: `lg-sec-cell-${slot}`,
        className: 'cell lg-sec-slot ui-tile',
        dataset: { slot: String(slot) }
      });
      secondarySlotMap[slot] = slotEl;
      secondarySlotEls.push(slotEl);
    }

    const secondaryGrid = h(
      'section',
      {
        id: 'left-grille-secondary-grid',
        className: 'grid',
        'aria-label': 'Secondary grid'
      },
      [secCell1, ...secondarySlotEls]
    );

    const secondaryPage = h(
      'div',
      {
        id: 'left-grille-page',
        className: 'lg-secondary-page',
        hidden: true
      },
      [navBar, secondaryGrid]
    );

    mainGrid.insertAdjacentElement('afterend', secondaryPage);

    // -------------------------------------------------------------------------
    // 3. Acoustic Controller + Shared Acoustic Bus Coordination
    // -------------------------------------------------------------------------
    const controller = new ControllerCls({
      onStateChange: handleControllerState,
      onTelemetry: handleTelemetry,
      onSwipe: handleCommittedSwipe,
      onCalibrationResult: handleCalibrationResult
    });

    let boundBus = null;

    function handleSharedBusState(st) {
      if (!st) return;
      const armed = st.state === 'listening' || st.state === 'requesting';
      armArrayBtn.dataset.armed = armed ? 'true' : 'false';
      armArrayBtn.dataset.state = st.state || 'idle';
      armArrayBtn.setAttribute('aria-pressed', armed ? 'true' : 'false');
      armArrayLabel.textContent =
        st.state === 'requesting' ? 'ARMING…' : st.state === 'listening' ? 'ARRAY LIVE' : 'ARM ARRAY';

      if (st.state === 'listening') {
        const rateKhz = Math.round((st.sampleRate || 48000) / 100) / 10;
        const sonarAllowed = st.canUseSonar !== false && (st.sampleRate || 48000) >= 40000;
        const txTag =
          st.txMode && st.txMode !== 'off' && sonarAllowed
            ? st.txMode.toUpperCase()
            : 'PASSIVE';
        busStatusMeta.dataset.error = 'false';
        busStatusMeta.textContent = `${rateKhz}k · ${txTag}`;
        armArrayBtn.setAttribute(
          'title',
          `Shared array live (${st.micLabel || 'Mic'} · ${rateKhz} kHz · ${txTag}) — click to disarm`
        );
      } else if (st.state === 'requesting') {
        busStatusMeta.dataset.error = 'false';
        busStatusMeta.textContent = 'ARMING…';
      } else if (st.state === 'error' && st.error) {
        busStatusMeta.dataset.error = 'true';
        busStatusMeta.textContent = 'SIM ONLY';
        armArrayBtn.setAttribute('title', st.error);
        announce(st.error);
      } else {
        busStatusMeta.dataset.error = 'false';
        busStatusMeta.textContent = 'Cells 02–06';
        armArrayBtn.setAttribute(
          'title',
          'Arm or disarm shared 48 kHz microphone and stereo sonar bus for Cells 02–06'
        );
      }
    }

    function bindSharedLab(labObj) {
      if (!labObj || typeof labObj !== 'object') return;
      labObj.isSecondaryOpen = () => isSecondaryOpen;
      labObj._slotElements = secondarySlotMap;
      if (typeof labObj.attachSecondarySlots === 'function') {
        labObj.attachSecondarySlots(secondarySlotMap);
      }
      if (labObj.bus && labObj.bus !== boundBus) {
        boundBus = labObj.bus;
        if (typeof boundBus.setBeforeArmHook === 'function') {
          boundBus.setBeforeArmHook(async () => {
            if (controller.state === 'listening' || controller.state === 'requesting') {
              await controller.stop({ immediate: true });
            }
          });
        }
        if (typeof boundBus.onStateChange === 'function') {
          boundBus.onStateChange((st) => {
            if (
              (st.state === 'requesting' || st.state === 'listening') &&
              (controller.state === 'listening' || controller.state === 'requesting')
            ) {
              controller.stop({ immediate: true });
            }
            handleSharedBusState(st);
          });
        }
      }
    }

    bindSharedLab(lab);
    if (!boundBus) {
      lab._onReady = (readyLab) => bindSharedLab(readyLab);
    }

    async function disarmSharedBusForCell1() {
      const bus = (lab && lab.bus) || boundBus;
      if (bus && (bus.state === 'listening' || bus.state === 'requesting')) {
        await bus.stopAll({ immediate: true, dispatchClose: false });
      }
    }

    async function toggleSharedArray() {
      const bus = (lab && lab.bus) || boundBus;
      if (!bus) return;
      if (bus.state === 'listening' || bus.state === 'requesting') {
        await bus.stopAll({ dispatchClose: false });
        announce('Shared acoustic array disarmed.');
        return;
      }
      if (controller.state === 'listening' || controller.state === 'requesting') {
        await controller.stop({ immediate: true });
      }
      let preferredTx;
      if (typeof bus.getTxMode === 'function' && bus.getTxMode() === 'off') {
        if (typeof bus.hasTxGenerator === 'function' && bus.hasTxGenerator('chirp')) {
          preferredTx = 'chirp';
        } else if (typeof bus.hasTxGenerator === 'function' && bus.hasTxGenerator('lid-ping')) {
          preferredTx = 'lid-ping';
        }
      }
      const ok = await bus.requestArm(preferredTx);
      if (ok) {
        announce('Shared 48 kilohertz acoustic array armed for secondary cells.');
      }
    }

    function formatListeningStatus() {
      const rateKhz = Math.round((controller.sampleRate || 48000) / 100) / 10;
      const sonarOn = controller.txEnabled && controller.sampleRate >= 40000;
      const modeTag = sonarOn ? 'SONAR+MIC' : 'MIC ONLY';
      const polTag = controller.polarity === -1 ? ' · INV' : '';
      return `${modeTag} · ${rateKhz}k${polTag}`;
    }

    function restoreIdleDirDisplay() {
      if (lastCommittedSwipe) {
        dirText.textContent =
          lastCommittedSwipe.direction === 'up' ? '↑ SWIPE UP' : '↓ SWIPE DOWN';
        dirText.dataset.dir = lastCommittedSwipe.direction;
      } else {
        dirText.textContent = '— IDLE';
        dirText.dataset.dir = 'idle';
      }
    }

    function handleControllerState(st) {
      const armed = st.state === 'listening' || st.state === 'requesting';
      armBtn.dataset.armed = armed ? 'true' : 'false';
      armBtn.setAttribute('aria-pressed', armed ? 'true' : 'false');
      armLabel.textContent =
        st.state === 'requesting' ? 'ARMING…' : st.state === 'listening' ? 'LIVE' : 'ARM MIC';

      const sonarActive = Boolean(st.txEnabled && st.canUseSonar !== false);
      sonarBtn.disabled = st.state === 'listening' && st.canUseSonar === false;
      sonarBtn.setAttribute('aria-pressed', sonarActive ? 'true' : 'false');
      sonarBtn.textContent = sonarActive ? '19k L-CH' : 'PASSIVE';

      if (st.state === 'error' && st.error) {
        statusPill.dataset.veto = 'false';
        statusPill.textContent = 'SIM MODE';
        showErrorOverlay(st.error, armBtn);
      } else if (st.state === 'listening') {
        if (!calWizardActive && !calOpening && !calSummaryActive) {
          inlineOverlay.hidden = true;
          syncBackgroundControlsInert();
        }
        statusPill.dataset.veto = 'false';
        statusPill.textContent = formatListeningStatus();
      } else if (st.state === 'idle') {
        if (calWizardActive || calOpening || calSummaryActive) {
          closeCalibrationWizard({ restoreFocus: false, keepMicArmed: true });
        } else {
          inlineOverlay.hidden = true;
          syncBackgroundControlsInert();
        }
        wasStrokeActive = false;
        restoreIdleDirDisplay();
        statusPill.dataset.veto = 'false';
        statusPill.textContent = st.calibrated ? 'CAL READY · Arm or drag' : 'READY · Arm or drag';
      }
    }

    function updateRailAndReadout(yFrac, uncPct, speedCms, liveDir) {
      const clampedY = clamp(yFrac, 0, 1);
      const topPct = Math.round(clampedY * 100);
      const btmPct = 100 - topPct;
      const topCm = (Math.round(clampedY * GRILLE_CM * 10) / 10).toFixed(1);

      needle.style.top = `${clampedY * 100}%`;
      needle.dataset.dir = liveDir === 'up' || liveDir === 'down' ? liveDir : 'idle';
      sigmaBand.style.top = `${clampedY * 100}%`;
      sigmaBand.style.height = `${clamp((uncPct || 8) * 2, 7, 34)}%`;

      // Vertical slider: 0 = Bottom (Fn), 100 = Top (Esc) so ArrowUp increases aria-valuenow!
      railWrap.setAttribute('aria-valuenow', String(btmPct));
      railWrap.setAttribute('aria-valuetext', `${topPct}% from top, ${btmPct}% from bottom`);
      topPctStrong.textContent = `${topPct}%`;
      btmPctStrong.textContent = `${btmPct}%`;
      cmSpanText.textContent = `${topCm} cm top`;

      if (speedCms > 0.4) {
        speedNum.textContent = speedCms.toFixed(1);
      }
    }

    function handleTelemetry(pkt) {
      if (pkt.vetoReason) {
        statusPill.dataset.veto = 'true';
        statusPill.textContent = pkt.vetoReason === 'key' ? 'KEY CLICK IGNORED' : 'VOICE IGNORED';
      } else {
        statusPill.dataset.veto = 'false';
        if (controller.state === 'listening') {
          statusPill.textContent = pkt.active
            ? `TRACKING · +${Math.max(0, Math.round(pkt.fricSnrDb))}dB`
            : formatListeningStatus();
        }
      }

      if (calWizardActive) {
        const snrDb = Math.max(
          0,
          Math.round(
            Math.max(
              pkt.fricSnrDb || 0,
              (pkt.dopplerSnrDb || 0) * 0.55,
              (pkt.pinholeOcclusion || 0) * 20
            )
          )
        );
        const meterPct = clamp((snrDb / 24) * 100, 4, 100);
        calMeterFill.style.width = `${meterPct}%`;
        calMeterFill.dataset.hot = pkt.active || snrDb >= 3 ? 'true' : 'false';
        calMeterText.textContent = `+${snrDb}dB`;
      }

      railTrack.dataset.pinholeLock = pkt.pinholeOcclusion > 0.32 ? 'true' : 'false';

      if (pkt.active && !calWizardActive) {
        wasStrokeActive = true;
        updateRailAndReadout(pkt.y, pkt.uncertaintyPct, pkt.speedCmPerSec, pkt.liveDirection);
        if (pkt.liveDirection === 'up') {
          dirText.textContent = '↑ UP…';
          dirText.dataset.dir = 'up';
        } else if (pkt.liveDirection === 'down') {
          dirText.textContent = '↓ DOWN…';
          dirText.dataset.dir = 'down';
        }
      } else if (wasStrokeActive && !calWizardActive) {
        wasStrokeActive = false;
        if (!pkt.swipe) {
          restoreIdleDirDisplay();
        }
      }

      if (pkt.dopplerSpectrum && pkt.dopplerSpectrum.length === 32) {
        lastDopplerBins = pkt.dopplerSpectrum;
      }

      scopeHist.push({
        y: pkt.y,
        unc: (pkt.uncertaintyPct || 9) / 100,
        asym: pkt.dopplerAsym || 0,
        active: pkt.active
      });
      if (scopeHist.length > SCOPE_LEN) scopeHist.shift();
      scheduleScopeDraw();
    }

    function handleCommittedSwipe(sw) {
      lastCommittedSwipe = sw;
      wasStrokeActive = false;
      const isUp = sw.direction === 'up';
      dirText.textContent = isUp ? '↑ SWIPE UP' : '↓ SWIPE DOWN';
      dirText.dataset.dir = sw.direction;
      confBadge.textContent = `${Math.round(sw.confidence * 100)}%`;

      speedNum.textContent = sw.speedCmPerSec.toFixed(1);
      speedPeakMeta.textContent = `pk ${sw.peakSpeedCmPerSec.toFixed(1)} cm/s · ${sw.durationMs}ms`;
      modeMeta.textContent = `${sw.startFromTopPct.toFixed(0)}% → ${sw.endFromTopPct.toFixed(0)}% top (${sw.sensingMode})`;

      if (!calWizardActive) {
        const topEdge = Math.min(sw.startFromTopPct, sw.endFromTopPct);
        const heightPct = Math.max(3, Math.abs(sw.endFromTopPct - sw.startFromTopPct));
        spanRibbon.style.top = `${topEdge}%`;
        spanRibbon.style.height = `${heightPct}%`;
        spanRibbon.dataset.dir = sw.direction;
        spanRibbon.dataset.visible = 'true';

        updateRailAndReadout(sw.endFromTopPct / 100, 5.5, sw.speedCmPerSec, sw.direction);
      }
      cmSpanText.textContent = `${sw.distanceFromTopCm.toFixed(1)}cm T · ${sw.distanceFromBottomCm.toFixed(1)}cm B`;

      announce(
        `Swipe ${sw.direction}, ${sw.speedCmPerSec.toFixed(1)} centimeters per second, ${Math.round(
          sw.distanceFromTopPct
        )} percent from top, ${Math.round(sw.distanceFromBottomPct)} percent from bottom.`
      );
      scheduleScopeDraw();
    }

    // -------------------------------------------------------------------------
    // 4. Guided 14-Step Calibration Suite & Error Overlays
    // -------------------------------------------------------------------------
    let calProtocol = DEFAULT_CALIBRATION_PROTOCOL;
    let calStepIndex = 0;
    let calCapturedSteps = new Set();
    let calCollectorOnline = false;
    let calBusy = false;

    function clearChildren(node) {
      while (node.firstChild) node.removeChild(node.firstChild);
    }

    function updateCollectorBadge() {
      calCollectorBadge.dataset.online = calCollectorOnline ? 'true' : 'false';
      calCollectorBadge.textContent = calCollectorOnline ? '● DISK REC' : '○ LOCAL + JSON';
      calCollectorBadge.title = calCollectorOnline
        ? 'Local disk collector active (127.0.0.1:8792 -> .worktrees/cal-data/latest-session.json)'
        : 'Collector offline — saving in browser & JSON export';
    }

    function highlightCalibrationStepOnRail(step) {
      if (!step) return;
      if (step.kind === 'zone') {
        const targetY = clamp(step.targetY ?? 0.5, 0, 1);
        const bandTop = clamp(targetY * 100 - 6, 0, 88);
        spanRibbon.style.top = `${bandTop}%`;
        spanRibbon.style.height = '12%';
        spanRibbon.dataset.dir = 'idle';
        spanRibbon.dataset.visible = 'true';
        needle.style.top = `${targetY * 100}%`;
        needle.dataset.dir = 'idle';
        sigmaBand.style.top = `${targetY * 100}%`;
        sigmaBand.style.height = '14%';
      } else if (step.kind === 'swipe') {
        const sY = clamp(step.startY ?? (step.direction === 'up' ? 0.96 : 0.04), 0, 1);
        const eY = clamp(step.endY ?? (step.direction === 'up' ? 0.04 : 0.96), 0, 1);
        const topEdge = Math.min(sY, eY) * 100;
        const heightPct = Math.max(6, Math.abs(eY - sY) * 100);
        const dir = step.direction === 'down' ? 'down' : 'up';
        spanRibbon.style.top = `${topEdge}%`;
        spanRibbon.style.height = `${heightPct}%`;
        spanRibbon.dataset.dir = dir;
        spanRibbon.dataset.visible = 'true';
        needle.style.top = `${eY * 100}%`;
        needle.dataset.dir = dir;
        sigmaBand.style.top = `${sY * 100}%`;
        sigmaBand.style.height = '12%';
      } else {
        spanRibbon.dataset.visible = 'false';
        spanRibbon.dataset.dir = 'idle';
        needle.style.top = '50%';
        needle.dataset.dir = 'idle';
        sigmaBand.style.top = '50%';
        sigmaBand.style.height = '10%';
      }
    }

    function restoreRailAfterCalibration() {
      if (lastCommittedSwipe) {
        const topEdge = Math.min(lastCommittedSwipe.startFromTopPct, lastCommittedSwipe.endFromTopPct);
        const heightPct = Math.max(
          3,
          Math.abs(lastCommittedSwipe.endFromTopPct - lastCommittedSwipe.startFromTopPct)
        );
        spanRibbon.style.top = `${topEdge}%`;
        spanRibbon.style.height = `${heightPct}%`;
        spanRibbon.dataset.dir = lastCommittedSwipe.direction;
        spanRibbon.dataset.visible = 'true';
        updateRailAndReadout(
          lastCommittedSwipe.endFromTopPct / 100,
          5.5,
          0,
          lastCommittedSwipe.direction
        );
        if (
          Number.isFinite(lastCommittedSwipe.distanceFromTopCm) &&
          Number.isFinite(lastCommittedSwipe.distanceFromBottomCm)
        ) {
          cmSpanText.textContent = `${lastCommittedSwipe.distanceFromTopCm.toFixed(1)}cm T · ${lastCommittedSwipe.distanceFromBottomCm.toFixed(1)}cm B`;
        }
      } else {
        spanRibbon.dataset.visible = 'false';
        spanRibbon.dataset.dir = 'idle';
        updateRailAndReadout(0.5, 5.5, 0, 'idle');
      }
    }

    function hasEnoughSwipesForEarlyFit() {
      let upCount = 0;
      let downCount = 0;
      const seenIds = new Set();
      for (let i = 0; i < calProtocol.length; i++) {
        const st = calProtocol[i];
        if (!st || st.kind !== 'swipe') continue;
        const key = st.id || String(i);
        if (calCapturedSteps.has(key)) {
          seenIds.add(key);
          if (st.direction === 'up') upCount++;
          else if (st.direction === 'down') downCount++;
        }
      }
      if (Array.isArray(controller.recordedEvents)) {
        for (let i = 0; i < controller.recordedEvents.length; i++) {
          const ev = controller.recordedEvents[i];
          if (!ev || ev.kind !== 'swipe') continue;
          const key = ev.stepId || ev.id;
          if (key && seenIds.has(key)) continue;
          if (key) seenIds.add(key);
          if (ev.direction === 'up') upCount++;
          else if (ev.direction === 'down') downCount++;
        }
      }
      return upCount >= 2 && downCount >= 2;
    }

    function beginStepCapture(step) {
      if (!step) return;
      if (typeof controller.beginCalibrationRecord === 'function') {
        controller.beginCalibrationRecord(step);
      } else if (typeof controller.startCalibrationStep === 'function') {
        controller.startCalibrationStep(step.direction || 'up');
      }
    }

    function dismissOverlay(opts = {}) {
      const shouldRestore = opts.restoreFocus !== false;
      inlineOverlay.hidden = true;
      calHeadRow.hidden = true;
      calSubHint.hidden = true;
      calBtn.setAttribute('aria-expanded', 'false');
      syncBackgroundControlsInert();
      restoreRailAfterCalibration();
      const target = overlayReturnFocusEl;
      overlayReturnFocusEl = null;
      if (shouldRestore && target && typeof target.focus === 'function') {
        target.focus({ preventScroll: true });
      }
    }

    function showErrorOverlay(msg, triggerEl) {
      calSessionSeq++;
      calOpening = false;
      calSummaryActive = false;
      calBusy = false;
      calAutoArmedMic = false;
      dragState = null;
      if (calWizardActive) {
        if (typeof controller.cancelCalibrationStep === 'function') {
          controller.cancelCalibrationStep();
        }
        calWizardActive = false;
      }
      restoreRailAfterCalibration();
      overlayReturnFocusEl = triggerEl || document.activeElement || armBtn;
      calBtn.setAttribute('aria-expanded', 'false');
      calHeadRow.hidden = true;
      calSubHint.hidden = true;
      overlayMsg.textContent = msg;
      clearChildren(overlayActions);
      const dismissBtn = h(
        'button',
        {
          type: 'button',
          className: 'lg-mini-btn',
          onClick: () => dismissOverlay({ restoreFocus: true })
        },
        ['Dismiss']
      );
      overlayActions.appendChild(dismissBtn);
      inlineOverlay.hidden = false;
      syncBackgroundControlsInert();
      announce(msg);
      dismissBtn.focus({ preventScroll: true });
    }

    function handleDownloadCalibrationJson() {
      let jsonStr = '';
      if (typeof controller.exportCalibrationBundle === 'function') {
        try {
          jsonStr = controller.exportCalibrationBundle();
        } catch (_) {
          jsonStr = '';
        }
      }
      if (!jsonStr) {
        jsonStr = JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            polarity: controller.polarity || 1,
            calibration: controller.calibration || null
          },
          null,
          2
        );
      }
      try {
        if (typeof Blob === 'function' && global.URL && typeof global.URL.createObjectURL === 'function') {
          const blob = new Blob([jsonStr], { type: 'application/json' });
          const url = global.URL.createObjectURL(blob);
          const link = h('a', {
            href: url,
            download: 'left-grille-calibration.json',
            hidden: true
          });
          document.body?.appendChild?.(link);
          if (typeof link.click === 'function') link.click();
          else if (typeof link.dispatch === 'function') link.dispatch('click');
          document.body?.removeChild?.(link);
          setTimeout(() => {
            try {
              global.URL.revokeObjectURL(url);
            } catch (_) {}
          }, 250);
        }
      } catch (_) {}
      calSubHint.hidden = false;
      calSubHint.dataset.warn = 'false';
      calSubHint.textContent = 'Exported left-grille-calibration.json';
      announce('Downloaded left grille calibration JSON bundle.');
    }

    function handleResetCalibration() {
      if (typeof controller.cancelCalibrationStep === 'function') {
        controller.cancelCalibrationStep();
      }
      if (typeof controller.clearRecordedCalibration === 'function') {
        controller.clearRecordedCalibration();
      }
      if (typeof controller.resetCalibration === 'function') {
        controller.resetCalibration();
      }
      calCapturedSteps.clear();
      modeMeta.textContent = 'Swipe left speaker grille ↑/↓';
      announce('Left grille calibration reset to factory defaults.');
      closeCalibrationWizard({ restoreFocus: true });
    }

    async function handleSaveAndNextStep() {
      if (!calWizardActive || calBusy) return;
      const mySeq = calSessionSeq;
      const step = calProtocol[calStepIndex] || calProtocol[0];
      if (typeof controller.completeCalibrationRecord === 'function') {
        calBusy = true;
        let res = null;
        try {
          res = await controller.completeCalibrationRecord();
        } catch (_) {
          res = { ok: false };
        } finally {
          if (mySeq === calSessionSeq) {
            calBusy = false;
          }
        }
        if (mySeq !== calSessionSeq || !calWizardActive) return;
        if (res && typeof res.collectorSaved === 'boolean' && res.collectorSaved) {
          calCollectorOnline = true;
          updateCollectorBadge();
        }
        const activeCount = Number.isFinite(res && res.activeFrameCount) ? res.activeFrameCount : 0;
        const tooQuiet = !res || !res.ok || (activeCount < 4 && step.kind !== 'negative');
        if (tooQuiet) {
          const isFinal = calStepIndex === calProtocol.length - 1;
          const ctaText = isFinal ? 'Fit & Lock' : 'Save & Next';
          calSubHint.hidden = false;
          calSubHint.dataset.warn = 'true';
          calSubHint.textContent = `Too quiet — rub/swipe firmly, then press ${ctaText}`;
          announce(
            `Too quiet. Rub or swipe firmly, then press ${isFinal ? 'Fit and Lock' : 'Save and Next'}.`
          );
          beginStepCapture(step);
          return;
        }
        calCapturedSteps.add(step.id || String(calStepIndex));
        if (calStepIndex + 1 < calProtocol.length) {
          loadCalibrationStep(calStepIndex + 1, { focusPrimary: true });
        } else {
          await handleFitCalibration();
        }
        return;
      }

      if (typeof controller.finishCalibrationStep === 'function') {
        controller.finishCalibrationStep();
      }
    }

    function handlePrevStep() {
      if (!calWizardActive || calBusy || calStepIndex <= 0) return;
      loadCalibrationStep(calStepIndex - 1, { focusPrimary: true });
    }

    async function handleFitCalibration() {
      if (!calWizardActive || calBusy) return;
      const mySeq = calSessionSeq;
      if (typeof controller.fitRecordedCalibration !== 'function') {
        if (typeof controller.finishCalibrationStep === 'function') {
          controller.finishCalibrationStep();
        }
        return;
      }
      calBusy = true;
      let res = null;
      try {
        res = await controller.fitRecordedCalibration();
      } catch (_) {
        res = { ok: false };
      } finally {
        if (mySeq === calSessionSeq) {
          calBusy = false;
        }
      }
      if (mySeq !== calSessionSeq || !calWizardActive) return;

      if (res && res.ok) {
        calWizardActive = false;
        calSummaryActive = true;
        calAutoArmedMic = false;
        if (typeof res.collectorSaved === 'boolean') {
          calCollectorOnline = res.collectorSaved;
          updateCollectorBadge();
        }
        const evCount = res.eventCount ?? calCapturedSteps.size;
        const looPct = res.looAccuracyPct ?? 100;
        const metricLabel = res.looFolds === 0 ? `Fit ${looPct}%` : `LOO ${looPct}%`;
        const savedLabel = res.collectorSaved ? 'Saved to disk' : 'Saved locally';
        const summary = `Calibrated (${evCount} events · ${metricLabel}) · ${savedLabel}`;
        calStepPill.textContent = `FIT · ${evCount} EV`;
        overlayMsg.textContent = summary;
        calSubHint.hidden = false;
        calSubHint.dataset.warn = 'false';
        const hasRbf = Boolean(res.model && res.model.rbf);
        const modelDesc = hasRbf ? '5-zone RBF active' : 'Shrinkage LDA active';
        calSubHint.textContent = Number.isFinite(res.dPrime)
          ? `Fisher LDA d' = ${Number(res.dPrime).toFixed(2)} · ${modelDesc}`
          : `Empirical ${modelDesc}`;
        modeMeta.textContent = `Calibrated · ${metricLabel} (${evCount} ev)`;
        announce(summary);

        clearChildren(overlayActions);
        const doneBtn = h(
          'button',
          {
            type: 'button',
            className: 'lg-mini-btn lg-mini-btn--primary',
            onClick: () => closeCalibrationWizard({ restoreFocus: true })
          },
          ['Done']
        );
        const jsonBtn = h(
          'button',
          {
            type: 'button',
            className: 'lg-mini-btn',
            onClick: () => handleDownloadCalibrationJson()
          },
          ['JSON']
        );
        const resetBtn = h(
          'button',
          {
            type: 'button',
            className: 'lg-mini-btn',
            onClick: () => handleResetCalibration()
          },
          ['Reset']
        );
        overlayActions.appendChild(doneBtn);
        overlayActions.appendChild(jsonBtn);
        overlayActions.appendChild(resetBtn);
        doneBtn.focus({ preventScroll: true });
      } else {
        const rawReason = (res && typeof res.reason === 'string' && res.reason) || '';
        const friendlyReason =
          rawReason && !/^[a-z0-9_]+$/i.test(rawReason)
            ? rawReason
            : 'Record at least 2 UP and 2 DOWN swipes before fitting calibration';
        calSubHint.hidden = false;
        calSubHint.dataset.warn = 'true';
        calSubHint.textContent = friendlyReason;
        announce(friendlyReason);
      }
    }

    function loadCalibrationStep(index, opts = {}) {
      calStepIndex = clamp(index, 0, Math.max(0, calProtocol.length - 1));
      const step = calProtocol[calStepIndex] || DEFAULT_CALIBRATION_PROTOCOL[0];
      const total = calProtocol.length || 14;
      const isFinalStep = calStepIndex === total - 1;
      const primaryCtaLabel = isFinalStep ? 'Fit & Lock' : 'Save & Next';

      calHeadRow.hidden = false;
      calStepPill.textContent = `${calStepIndex + 1} / ${total}`;
      updateCollectorBadge();
      calMeterFill.style.width = '4%';
      calMeterFill.dataset.hot = 'false';
      calMeterText.textContent = '+0dB';

      const stepPrompt =
        step.kind === 'negative' && /Esc|Tab/i.test(step.label || '')
          ? `${calStepIndex + 1}/${total} · Tap ~, Caps & Shift once, then press Fit & Lock`
          : step.label || step.prompt || `${calStepIndex + 1}/${total} · Calibrate step`;
      overlayMsg.textContent = stepPrompt;
      calSubHint.hidden = false;
      calSubHint.dataset.warn = 'false';
      calSubHint.textContent =
        step.kind === 'negative'
          ? 'Tap ~, Caps & Shift once, then press Fit & Lock'
          : step.kind === 'zone'
            ? `Rub ${step.short || 'target zone'} steadily (~1s), then press ${primaryCtaLabel}`
            : `Perform ${step.short || 'swipe'} along highlighted rail, then press ${primaryCtaLabel}`;

      highlightCalibrationStepOnRail(step);
      beginStepCapture(step);
      announce(step.prompt || stepPrompt);

      clearChildren(overlayActions);
      const saveNextBtn = h(
        'button',
        {
          type: 'button',
          className: 'lg-mini-btn lg-mini-btn--primary',
          onClick: () => handleSaveAndNextStep()
        },
        [primaryCtaLabel]
      );
      const backStepBtn = h(
        'button',
        {
          type: 'button',
          className: 'lg-mini-btn',
          disabled: calStepIndex === 0,
          onClick: () => handlePrevStep()
        },
        ['Back']
      );
      const canFitEarly = hasEnoughSwipesForEarlyFit();
      const fitEarlyBtn = h(
        'button',
        {
          type: 'button',
          className: 'lg-mini-btn lg-cal-secondary-btn',
          disabled: !canFitEarly,
          title: 'Fit empirical calibration model early (enabled once >= 2 UP and >= 2 DOWN swipes are captured)',
          onClick: () => handleFitCalibration()
        },
        ['Fit Early']
      );
      const jsonBtn = h(
        'button',
        {
          type: 'button',
          className: 'lg-mini-btn lg-cal-secondary-btn',
          title: 'Download recorded left-grille-calibration.json bundle',
          onClick: () => handleDownloadCalibrationJson()
        },
        ['JSON']
      );
      const resetBtn = h(
        'button',
        {
          type: 'button',
          className: 'lg-mini-btn lg-cal-secondary-btn',
          onClick: () => handleResetCalibration()
        },
        ['Reset']
      );
      const cancelBtn = h(
        'button',
        {
          type: 'button',
          className: 'lg-mini-btn',
          onClick: () => closeCalibrationWizard({ restoreFocus: true })
        },
        ['Cancel']
      );

      overlayActions.appendChild(saveNextBtn);
      overlayActions.appendChild(backStepBtn);
      if (!isFinalStep) {
        overlayActions.appendChild(fitEarlyBtn);
      }
      overlayActions.appendChild(jsonBtn);
      overlayActions.appendChild(resetBtn);
      overlayActions.appendChild(cancelBtn);

      inlineOverlay.hidden = false;
      syncBackgroundControlsInert();
      if (opts.focusPrimary !== false) {
        saveNextBtn.focus({ preventScroll: true });
      }
    }

    async function openCalibrationWizard(triggerEl) {
      if (calWizardActive || calOpening || calSummaryActive) {
        closeCalibrationWizard({ restoreFocus: true });
        return;
      }
      overlayReturnFocusEl = triggerEl || calBtn;
      dragState = null;
      calOpening = true;
      const mySeq = ++calSessionSeq;
      const autoArmed = controller.state !== 'listening';
      calAutoArmedMic = autoArmed;
      calBtn.setAttribute('aria-expanded', 'true');

      let ok = true;
      if (autoArmed) {
        await disarmSharedBusForCell1();
        if (mySeq !== calSessionSeq || !isSecondaryOpen) {
          calOpening = false;
          calBtn.setAttribute('aria-expanded', 'false');
          if (calAutoArmedMic) {
            calAutoArmedMic = false;
            if (controller.state === 'listening' || controller.state === 'requesting') {
              controller.stop();
            }
          }
          return;
        }
        ok = await controller.start();
      }
      if (mySeq !== calSessionSeq || !isSecondaryOpen || !ok || controller.state !== 'listening') {
        calOpening = false;
        calBtn.setAttribute('aria-expanded', 'false');
        if (autoArmed) {
          calAutoArmedMic = false;
          if (controller.state === 'listening' || controller.state === 'requesting') {
            controller.stop();
          }
        }
        return;
      }

      if (typeof controller.clearRecordedCalibration === 'function') {
        controller.clearRecordedCalibration();
      }
      const proto =
        typeof controller.getCalibrationProtocol === 'function'
          ? controller.getCalibrationProtocol()
          : null;
      calProtocol =
        Array.isArray(proto) && proto.length > 0 ? proto : DEFAULT_CALIBRATION_PROTOCOL;
      calCapturedSteps = new Set();
      calBusy = false;
      calOpening = false;
      calSummaryActive = false;
      calWizardActive = true;
      calBtn.setAttribute('aria-expanded', 'true');

      loadCalibrationStep(0, { focusPrimary: true });

      if (typeof controller.probeCollector === 'function') {
        Promise.resolve(controller.probeCollector())
          .then((online) => {
            if (mySeq !== calSessionSeq) return;
            calCollectorOnline = Boolean(online);
            if (calWizardActive || calSummaryActive) updateCollectorBadge();
          })
          .catch(() => {
            if (mySeq !== calSessionSeq) return;
            calCollectorOnline = false;
            if (calWizardActive || calSummaryActive) updateCollectorBadge();
          });
      } else {
        calCollectorOnline = false;
        updateCollectorBadge();
      }
    }

    function closeCalibrationWizard(opts = {}) {
      calSessionSeq++;
      calOpening = false;
      calSummaryActive = false;
      calBusy = false;
      if (calWizardActive) {
        if (typeof controller.cancelCalibrationStep === 'function') {
          controller.cancelCalibrationStep();
        }
        calWizardActive = false;
      }
      const shouldStopAutoMic = calAutoArmedMic && opts.keepMicArmed !== true;
      calAutoArmedMic = false;
      dismissOverlay(opts);
      if (shouldStopAutoMic && (controller.state === 'listening' || controller.state === 'requesting')) {
        controller.stop();
      }
    }

    function handleCalibrationResult(res) {
      if (res && res.ok) {
        calWizardActive = false;
        calOpening = false;
        calSummaryActive = false;
        calAutoArmedMic = false;
        dismissOverlay({ restoreFocus: true });
        if (res.looAccuracyPct !== undefined) {
          const metricLabel = res.looFolds === 0 ? `Fit ${res.looAccuracyPct}%` : `LOO ${res.looAccuracyPct}%`;
          modeMeta.textContent = `Calibrated · ${metricLabel}`;
        } else {
          modeMeta.textContent = `Calibrated (${res.polarity === 1 ? 'Top-Mic' : 'Inverted'})`;
        }
        announce('Left grille calibration locked.');
      } else if (calWizardActive) {
        const isFinal = calStepIndex === calProtocol.length - 1;
        calSubHint.hidden = false;
        calSubHint.dataset.warn = 'true';
        calSubHint.textContent = `Too quiet — rub/swipe firmly, then press ${isFinal ? 'Fit & Lock' : 'Save & Next'}`;
        announce(
          `Too quiet. Rub or swipe firmly, then press ${isFinal ? 'Fit and Lock' : 'Save and Next'}.`
        );
        beginStepCapture(calProtocol[calStepIndex] || calProtocol[0]);
      } else {
        showErrorOverlay(
          'Signal too quiet — rub firmly from bottom to top of the left grille.',
          calBtn
        );
      }
    }

    async function toggleArm() {
      if (controller.state === 'listening' || controller.state === 'requesting') {
        await controller.stop();
      } else {
        await disarmSharedBusForCell1();
        await controller.start();
      }
    }

    // -------------------------------------------------------------------------
    // 5. Interactive Pointer-Drag & Keyboard Scrub on Physical Grille Rail
    // -------------------------------------------------------------------------
    let dragState = null;

    function clientYToFrac(clientY) {
      const rect = railTrack.getBoundingClientRect();
      if (!rect.height) return 0.5;
      return clamp((clientY - rect.top) / rect.height, 0.02, 0.98);
    }

    railWrap.addEventListener('pointerdown', (e) => {
      if (calWizardActive || calOpening || !inlineOverlay.hidden) return;
      e.preventDefault();
      railWrap.focus({ preventScroll: true });
      if (railWrap.setPointerCapture) {
        try {
          railWrap.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
      const y0 = clientYToFrac(e.clientY);
      const now = performance.now();
      dragState = {
        pointerId: e.pointerId,
        startY: y0,
        lastY: y0,
        startTime: now,
        lastTime: now,
        peakCms: 0
      };
      updateRailAndReadout(y0, 5.0, 0, 'idle');
    });

    railWrap.addEventListener('pointermove', (e) => {
      if (calWizardActive || calOpening || !inlineOverlay.hidden) return;
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      const now = performance.now();
      const yNow = clientYToFrac(e.clientY);
      const dtSec = Math.max(0.008, (now - dragState.lastTime) / 1000);
      const dy = yNow - dragState.lastY;
      const instCms = (Math.abs(dy) * GRILLE_CM) / dtSec;
      const smoothCms = Math.min(130, instCms);
      if (smoothCms > dragState.peakCms) dragState.peakCms = smoothCms;
      const liveDir = Math.abs(dy) < 0.005 ? 'idle' : dy < 0 ? 'up' : 'down';

      dragState.lastY = yNow;
      dragState.lastTime = now;

      updateRailAndReadout(yNow, 5.0, smoothCms, liveDir);
      scopeHist.push({
        y: yNow,
        unc: 0.05,
        asym: dy < 0 ? 0.65 : dy > 0 ? -0.65 : 0,
        active: true
      });
      if (scopeHist.length > SCOPE_LEN) scopeHist.shift();
      scheduleScopeDraw();
    });

    railWrap.addEventListener('pointerup', (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      const st = dragState;
      dragState = null;
      const durMs = Math.max(60, performance.now() - st.startTime);
      const spanFrac = Math.abs(st.lastY - st.startY);
      if (spanFrac < 0.07) return;
      const dir = st.lastY < st.startY ? 'up' : 'down';
      const distCm = spanFrac * GRILLE_CM;
      const avgCms = Math.min(130, distCm / (durMs / 1000));
      handleCommittedSwipe({
        id: Date.now(),
        direction: dir,
        confidence: 0.96,
        sensingMode: 'rail-scrub',
        speedCmPerSec: Math.round(avgCms * 10) / 10,
        peakSpeedCmPerSec: Math.round(Math.max(avgCms, st.peakCms) * 10) / 10,
        durationMs: Math.round(durMs),
        startFromTopPct: Math.round(st.startY * 1000) / 10,
        endFromTopPct: Math.round(st.lastY * 1000) / 10,
        distanceFromTopPct: Math.round(st.lastY * 1000) / 10,
        distanceFromBottomPct: Math.round((1 - st.lastY) * 1000) / 10,
        distanceFromTopCm: Math.round(st.lastY * GRILLE_CM * 10) / 10,
        distanceFromBottomCm: Math.round((1 - st.lastY) * GRILLE_CM * 10) / 10,
        spanPct: Math.round(spanFrac * 1000) / 10,
        spanCm: Math.round(distCm * 10) / 10
      });
    });

    railWrap.addEventListener('pointercancel', (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      dragState = null;
      restoreIdleDirDisplay();
    });

    railWrap.addEventListener('keydown', (e) => {
      if (calWizardActive || calOpening || !inlineOverlay.hidden) return;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        controller.runSimulatedSwipe('up');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        controller.runSimulatedSwipe('down');
      } else if (e.key === 'Home') {
        e.preventDefault();
        updateRailAndReadout(0.05, 5.0, 0, 'up');
      } else if (e.key === 'End') {
        e.preventDefault();
        updateRailAndReadout(0.95, 5.0, 0, 'down');
      }
    });

    // -------------------------------------------------------------------------
    // 6. DPR-Aware 2-Trace Rolling Trajectory & Doppler Canvas Scope
    // -------------------------------------------------------------------------
    let canvasCssW = 0;
    let canvasCssH = 0;

    function syncCanvasSize() {
      const rect = scopeBox.getBoundingClientRect();
      const w = Math.max(0, Math.floor(rect.width));
      const hPx = Math.max(0, Math.floor(rect.height));
      if (!w || !hPx) return;
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      if (w !== canvasCssW || hPx !== canvasCssH) {
        canvasCssW = w;
        canvasCssH = hPx;
        scopeCanvas.width = Math.round(w * dpr);
        scopeCanvas.height = Math.round(hPx * dpr);
      }
      drawScope();
    }

    function scheduleScopeDraw() {
      if (rafPending || !isSecondaryOpen) return;
      rafPending = true;
      global.requestAnimationFrame(() => {
        rafPending = false;
        drawScope();
      });
    }

    function drawScope() {
      if (!canvasCssW || !canvasCssH) return;
      const ctx = scopeCanvas.getContext('2d');
      if (!ctx) return;
      const dpr = scopeCanvas.width / canvasCssW;
      ctx.save();
      ctx.scale(dpr, dpr);

      const w = canvasCssW;
      const hPx = canvasCssH;
      ctx.clearRect(0, 0, w, hPx);

      const traceW = Math.floor(w * 0.78);
      const dopW = w - traceW - 6;
      const padY = 6;
      const plotH = Math.max(12, hPx - padY * 2 - 10);

      const micLineY = padY + 0.15 * plotH;
      ctx.strokeStyle = 'rgba(0, 82, 204, 0.18)';
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(4, micLineY);
      ctx.lineTo(traceW, micLineY);
      ctx.stroke();
      ctx.setLineDash([]);

      if (scopeHist.length > 1) {
        ctx.fillStyle = 'rgba(20, 20, 19, 0.06)';
        ctx.beginPath();
        for (let i = 0; i < scopeHist.length; i++) {
          const x = 4 + (i / (SCOPE_LEN - 1)) * (traceW - 6);
          const yTop = padY + clamp(scopeHist[i].y - scopeHist[i].unc, 0, 1) * plotH;
          if (i === 0) ctx.moveTo(x, yTop);
          else ctx.lineTo(x, yTop);
        }
        for (let i = scopeHist.length - 1; i >= 0; i--) {
          const x = 4 + (i / (SCOPE_LEN - 1)) * (traceW - 6);
          const yBot = padY + clamp(scopeHist[i].y + scopeHist[i].unc, 0, 1) * plotH;
          ctx.lineTo(x, yBot);
        }
        ctx.closePath();
        ctx.fill();

        ctx.lineWidth = 1.75;
        ctx.strokeStyle = '#141413';
        ctx.beginPath();
        for (let i = 0; i < scopeHist.length; i++) {
          const x = 4 + (i / (SCOPE_LEN - 1)) * (traceW - 6);
          const y = padY + clamp(scopeHist[i].y, 0, 1) * plotH;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();

        for (let i = 1; i < scopeHist.length; i++) {
          if (!scopeHist[i].active) continue;
          const x0 = 4 + ((i - 1) / (SCOPE_LEN - 1)) * (traceW - 6);
          const y0 = padY + clamp(scopeHist[i - 1].y, 0, 1) * plotH;
          const x1 = 4 + (i / (SCOPE_LEN - 1)) * (traceW - 6);
          const y1 = padY + clamp(scopeHist[i].y, 0, 1) * plotH;
          ctx.strokeStyle = y1 <= y0 ? '#0052cc' : '#c93700';
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }
      }

      if (dopW >= 18) {
        const xBase = traceW + 4;
        const midY = padY + plotH * 0.5;
        ctx.strokeStyle = '#dcdcd6';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(xBase, midY);
        ctx.lineTo(xBase + dopW - 2, midY);
        ctx.stroke();

        const bins = lastDopplerBins;
        const binStep = plotH / 32;
        for (let b = 0; b < 32; b++) {
          const isPos = b >= 16;
          const rowIdx = isPos ? 31 - b : 15 - b + 16;
          const mag = clamp((bins[b] || 0) / 3.5, 0, 1);
          const barW = Math.max(1, mag * (dopW - 4));
          ctx.fillStyle = isPos ? 'rgba(0, 82, 204, 0.72)' : 'rgba(201, 55, 0, 0.72)';
          ctx.fillRect(xBase + 1, padY + rowIdx * binStep, barW, Math.max(1, binStep - 0.6));
        }
      }

      ctx.restore();
    }

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => syncCanvasSize());
      ro.observe(scopeBox);
    } else {
      global.addEventListener('resize', syncCanvasSize);
    }

    // -------------------------------------------------------------------------
    // 7. Race-Free SPA View Swap, Spatial Homothety Transition & History Sync
    // -------------------------------------------------------------------------
    function clearTransitionNames() {
      portalCell.style.viewTransitionName = '';
      secondaryGrid.style.viewTransitionName = '';
    }

    // Another cell's page (e.g. `.hg-secondary-page` for `#hand-gesture`) may own the hidden main
    // grid after a cross-cell hash jump; never unhide the grid underneath it (two pages at once).
    function otherSecondaryPageVisible() {
      const kids = document.body ? document.body.children : [];
      for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        if (el === secondaryPage || el === mainGrid || el.hidden) continue;
        if (typeof el.className === 'string' && /(^|\s)[a-z0-9]+-secondary-page(\s|$)/.test(el.className)) {
          return true;
        }
      }
      return false;
    }

    let savedMainScrollY = 0;

    function applyDomState(openNow, restorePortalFocus) {
      const wasOpen = isSecondaryOpen;
      if (openNow) {
        mainGrid.hidden = true;
        secondaryPage.hidden = false;
        isSecondaryOpen = true;
        syncCanvasSize();
        if (!wasOpen && typeof global.scrollTo === 'function') global.scrollTo(0, 0);
        backBtn.focus({ preventScroll: true });
        if (!wasOpen) {
          const CustomEvt =
            (global && typeof global.CustomEvent === 'function' && global.CustomEvent) ||
            (typeof CustomEvent === 'function' ? CustomEvent : null);
          if (CustomEvt && global && typeof global.dispatchEvent === 'function') {
            try {
              global.dispatchEvent(new CustomEvt('lg-secondary-open'));
            } catch (_) {}
          }
        }
      } else {
        secondaryPage.hidden = true;
        if (!otherSecondaryPageVisible()) mainGrid.hidden = false;
        isSecondaryOpen = false;
        closeCalibrationWizard({ restoreFocus: false, keepMicArmed: true });
        overlayReturnFocusEl = null;
        if (restorePortalFocus && wasOpen && !mainGrid.hidden) {
          if (savedMainScrollY === null) {
            // Opened from another cell's page: the grid offset is unknown, bring the tile into view
            portalBtn.focus();
          } else {
            if (typeof global.scrollTo === 'function') global.scrollTo(0, savedMainScrollY);
            portalBtn.focus({ preventScroll: true });
          }
        }
      }
    }

    function runPortalTransition(nextOpen, opts = {}) {
      const animate = Boolean(opts.animate);
      const restoreFocus = opts.restoreFocus !== false;
      if (nextOpen && !targetOpen && !isSecondaryOpen) {
        // Only the visible main grid's offset is ours to restore (not another cell page's)
        savedMainScrollY = mainGrid.hidden ? null : global.scrollY || 0;
      }
      targetOpen = nextOpen;
      const mySeq = ++vtSeq;

      if (!nextOpen) {
        enteredFromMainGrid = false;
        controller.stop();
        const bus = (lab && lab.bus) || boundBus;
        if (bus && typeof bus.stopAll === 'function') {
          bus.stopAll();
        }
      }

      if (
        animate &&
        !document.hidden &&
        typeof document.startViewTransition === 'function' &&
        !prefersReducedMotion()
      ) {
        clearTransitionNames();
        if (nextOpen) {
          portalCell.style.viewTransitionName = 'lg-stage-portal';
        } else {
          secondaryGrid.style.viewTransitionName = 'lg-stage-portal';
        }

        let vt = null;
        try {
          vt = document.startViewTransition(() => {
            if (mySeq !== vtSeq) {
              // Superseded mid-flight: reconcile DOM directly to latest targetOpen
              clearTransitionNames();
              applyDomState(targetOpen, restoreFocus);
              return;
            }
            if (targetOpen) {
              portalCell.style.viewTransitionName = '';
              secondaryGrid.style.viewTransitionName = 'lg-stage-portal';
            } else {
              secondaryGrid.style.viewTransitionName = '';
              portalCell.style.viewTransitionName = 'lg-stage-portal';
            }
            applyDomState(targetOpen, restoreFocus);
          });
        } catch (_) {
          vt = null;
        }
        if (!vt) {
          clearTransitionNames();
          applyDomState(nextOpen, restoreFocus);
          return;
        }

        // A skipped/aborted transition (hidden tab, a newer transition, a cross-cell swap) rejects
        // `ready`, `updateCallbackDone` and `finished`; handle all three so none surfaces as an
        // unhandled rejection. The update callback still runs, so DOM state stays reconciled.
        const noop = () => {};
        if (vt.ready) Promise.resolve(vt.ready).catch(noop);
        if (vt.updateCallbackDone) Promise.resolve(vt.updateCallbackDone).catch(noop);
        Promise.resolve(vt.finished)
          .catch(noop)
          .then(() => {
            if (mySeq === vtSeq) {
              clearTransitionNames();
            }
          });
      } else {
        clearTransitionNames();
        applyDomState(nextOpen, restoreFocus);
      }
    }

    function openSecondaryView(opts) {
      if (targetOpen) return;
      const fromUserTap = Boolean(opts && opts.fromUserTap);

      if (fromUserTap && location.hash !== '#left-grille') {
        enteredFromMainGrid = true;
        if (global.history && typeof global.history.pushState === 'function') {
          try {
            global.history.pushState({ lgSecondary: true }, '', '#left-grille');
          } catch (_) {}
        }
      }

      runPortalTransition(true, { animate: fromUserTap, restoreFocus: false });
    }

    function requestCloseSecondaryView() {
      if (!targetOpen || Date.now() < backPendingUntil) return;
      // The current entry is ours (pushed by a tile tap, or reached again with Forward): step back
      // so Back/Forward stay symmetric instead of rewriting the entry in place.
      const ownEntry =
        enteredFromMainGrid ||
        Boolean(global.history && global.history.state && global.history.state.lgSecondary);
      if (
        ownEntry &&
        location.hash === '#left-grille' &&
        global.history &&
        typeof global.history.back === 'function'
      ) {
        enteredFromMainGrid = false;
        backPendingUntil = Date.now() + 1000;
        global.history.back();
        return;
      }
      enteredFromMainGrid = false;
      if (
        location.hash === '#left-grille' &&
        global.history &&
        typeof global.history.replaceState === 'function'
      ) {
        try {
          global.history.replaceState(null, '', location.pathname + location.search);
        } catch (_) {}
      }
      runPortalTransition(false, { animate: true, restoreFocus: true });
    }

    function syncLocationHash() {
      backPendingUntil = 0;
      const wantOpen = location.hash === '#left-grille';
      if (wantOpen === targetOpen) return;
      if (wantOpen) {
        runPortalTransition(true, { animate: false, restoreFocus: false });
      } else {
        // If another cell's hash (e.g. `#api-matrix`) took over, close instantly without stealing focus
        const crossCellHash = Boolean(location.hash && location.hash !== '#left-grille');
        runPortalTransition(false, {
          animate: !crossCellHash,
          restoreFocus: !crossCellHash
        });
      }
    }

    inlineOverlay.addEventListener('keydown', (e) => {
      if (!e || (!calWizardActive && !calSummaryActive)) return;
      if (e.key === 'ArrowLeft' && calWizardActive) {
        e.preventDefault();
        handlePrevStep();
      } else if (
        (e.key === 'Enter' || e.key === ' ') &&
        (!e.target || e.target === inlineOverlay)
      ) {
        e.preventDefault();
        const primaryBtn = overlayActions.firstChild;
        if (primaryBtn && typeof primaryBtn.dispatch === 'function') {
          primaryBtn.dispatch('click');
        } else if (primaryBtn && typeof primaryBtn.click === 'function') {
          primaryBtn.click();
        } else if (calWizardActive) {
          handleSaveAndNextStep();
        }
      }
    });

    document.addEventListener('keydown', (e) => {
      if (!e || e.defaultPrevented) return;
      if (e.key === 'Escape' && targetOpen) {
        e.preventDefault();
        const activeStep = calWizardActive ? calProtocol[calStepIndex] : null;
        if (calWizardActive && activeStep && activeStep.kind === 'negative') {
          return;
        }
        if (calWizardActive || calOpening || calSummaryActive || !inlineOverlay.hidden) {
          closeCalibrationWizard({ restoreFocus: true });
        } else {
          requestCloseSecondaryView();
        }
      }
    });

    document.addEventListener('visibilitychange', () => {
      const hidden = Boolean(document.hidden);
      if (targetOpen) {
        controller.setHiddenMuted(hidden);
      }
      const bus = (lab && lab.bus) || boundBus;
      if (bus && typeof bus.setHiddenMuted === 'function') {
        bus.setHiddenMuted(hidden);
      }
    });

    global.addEventListener('popstate', syncLocationHash);
    global.addEventListener('hashchange', syncLocationHash);
    global.addEventListener('pagehide', () => {
      controller.stop({ immediate: true, silent: true });
      const bus = (lab && lab.bus) || boundBus;
      if (bus && typeof bus.stopAll === 'function') {
        bus.stopAll({ immediate: true });
      }
    });

    handleControllerState({
      state: 'idle',
      error: '',
      txEnabled: controller.txEnabled,
      canUseSonar: true,
      polarity: controller.polarity,
      calibrated: Boolean(controller.calibration || controller.empiricalModel),
      sampleRate: 48000
    });

    if (location.hash === '#left-grille') {
      openSecondaryView({ fromUserTap: false });
    }

    return { controller };
  }

  function bootstrap() {
    const mount = document.getElementById('cell-left-grille');
    if (mount) mountLeftGrillePortal(mount);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  global.LeftGrilleUI = { mount: mountLeftGrillePortal };
})(typeof window !== 'undefined' ? window : globalThis);
