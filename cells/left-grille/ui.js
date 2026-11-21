/**
 * UI & Seamless Secondary-Grid Portal (`cells/left-grille/ui.js`)
 *
 * Mounts:
 * 1. Main Grid Cell (`#cell-left-grille.ui-tile`): one `ui-tile-trigger` with the shared head /
 *    hero / foot; the hero is an SVG of the MacBook Pro left speaker grille (`8%–22%` mic
 *    through-holes + blind dimples) with a rust sweep line.
 * 2. Secondary Page (`#left-grille-page`): Replaces `<main class="grid">` in-page with a
 *    `ui-studio-bar` (05, title, bus readout, the ARM ARRAY toggle wired to
 *    `window.LeftGrilleLab.bus`, then Close / `Escape`, with History `#left-grille` sync) over a
 *    secondary `.grid` of `.cell.ui-tile` slots (`#lg-sec-cell-1` .. `#lg-sec-cell-9`; empty
 *    slots are hidden). Frame contract: NOTES.md "Sensor cell frame".
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
            class: isMicPort ? 'lg-hole lg-hole--port' : 'lg-hole',
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
          class: 'lg-mic-zone',
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
          class: 'lg-sweep',
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
          class: 'lg-grille-frame',
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
    // Shared tile anatomy (`ui/NOTES.md` section 2): one trigger wrapping head / hero / foot.
    // Only phrasing elements inside the button; nothing interactive.
    const portalBtn = h(
      'button',
      {
        type: 'button',
        className: 'ui-tile-trigger lg-portal-btn',
        'aria-label': 'Open Left Grille Acoustic Swipe Sonar secondary grid',
        onClick: () => openSecondaryView({ fromUserTap: true })
      },
      [
        h('span', { className: 'ui-tile-head lg-portal-top' }, [
          h('span', { className: 'ui-tile-index', textContent: '05' }),
          h('span', { className: 'ui-tile-title', textContent: 'Left Grille' }),
          h('span', { className: 'ui-tile-actions' }, [
            h('span', {
              className: 'ui-btn ui-btn--sm ui-btn--icon lg-portal-arrow ui-hide-tiny',
              'aria-hidden': 'true',
              textContent: '↗'
            })
          ])
        ]),
        h('span', { className: 'ui-tile-body lg-portal-graphic' }, [
          buildGrilleSvg({
            width: 48,
            height: 132,
            cols: 5,
            rows: 20,
            withNeedle: true,
            className: 'lg-portal-svg'
          })
        ]),
        h('span', { className: 'ui-tile-foot lg-portal-bottom' }, [
          h('span', { className: 'ui-prose ui-truncate lg-portal-sub', textContent: 'Speaker + 3-mic swipe array' }),
          h('span', {
            className: 'lg-portal-spec',
            'data-tip': 'Samples 48,000 times a second via the left speaker and mics.',
            textContent: '48 kHz · L'
          })
        ])
      ]
    );
    if (typeof portalCell.className === 'string' && !/(^|\s)ui-tile(\s|$)/.test(portalCell.className)) {
      portalCell.className = `${portalCell.className} ui-tile`.trim();
    }
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

    // Close rule (`ui/NOTES.md` section 0): last item on the right, Esc does the same.
    const backBtn = h(
      'button',
      {
        type: 'button',
        className: 'ui-btn lg-back-btn',
        'data-tip': 'Back to the grid.',
        'data-tip-key': 'Esc',
        onClick: () => requestCloseSecondaryView()
      },
      ['Close']
    );

    const BUS_TIP_IDLE = 'Sensors 02 to 06 share one mic stream; ARM ARRAY turns it on.';
    const busStatusMeta = h('span', {
      className: 'ui-readout ui-readout--quiet lg-bus-meta',
      dataset: { error: 'false' },
      'data-tip': BUS_TIP_IDLE,
      textContent: ''
    });

    const ARM_ARRAY_TIP_IDLE =
      'Turn on the shared mic and inaudible tone for sensors 02–06; stops sensor 01’s mic.';
    const armArrayLabel = h('span', { textContent: 'Arm array' });
    const armArrayBtn = h(
      'button',
      {
        type: 'button',
        id: 'lg-arm-array-btn',
        className: 'ui-btn ui-btn--primary lg-arm-array-btn',
        dataset: { armed: 'false', state: 'idle' },
        'aria-pressed': 'false',
        'data-tip': ARM_ARRAY_TIP_IDLE,
        onClick: () => toggleSharedArray()
      },
      [armArrayLabel]
    );

    const navBar = h('header', { className: 'ui-studio-bar lg-nav-bar' }, [
      h('span', { className: 'ui-tile-index', textContent: '05' }),
      h('h2', { className: 'ui-studio-title', textContent: 'Left Grille' }),
      h('div', { className: 'ui-studio-actions' }, [busStatusMeta, armArrayBtn, backBtn])
    ]);

    // Sensor cell 01 in the frame every secondary slot shares (NOTES.md "Sensor cell frame"):
    // head (01, title, status pill, Arm, 19k) / body (grille strip hero + readouts) / foot.
    const armLabel = h('span', { textContent: 'Arm' });
    const armBtn = h(
      'button',
      {
        type: 'button',
        className: 'ui-btn ui-btn--sm lg-btn--arm',
        dataset: { armed: 'false' },
        'aria-pressed': 'false',
        'data-tip': 'Turn on the mic for this sensor alone; stops the shared array.',
        onClick: () => toggleArm()
      },
      [armLabel]
    );

    const statusPillLabel = h('span', { className: 'ui-pill-label', textContent: 'Ready' });
    const statusPill = h(
      'span',
      {
        className: 'ui-pill lg-status-pill',
        role: 'note',
        tabindex: '0',
        'data-tip': 'Arm the mic, or drag the grille strip to try a simulated swipe.'
      },
      [statusPillLabel]
    );

    const SONAR_TIP_ON = 'Inaudible 18–21 kHz tone from the left speaker while armed. Click for mic only.';
    const SONAR_TIP_OFF = 'Mic only. Click to add the inaudible 18–21 kHz tone from the left speaker.';
    const SONAR_TIP_BLOCKED = 'The tone needs a mic running at 40 kHz or more; this one is slower.';
    const sonarBtn = h(
      'button',
      {
        type: 'button',
        className: 'ui-btn ui-btn--sm lg-btn--sonar ui-hide-compact',
        'aria-pressed': 'true',
        'aria-disabled': 'false',
        'data-tip': SONAR_TIP_ON,
        onClick: () => {
          if (sonarBtn.getAttribute('aria-disabled') === 'true') return;
          controller.setSonarEnabled(!controller.txEnabled);
        }
      },
      ['19k']
    );

    const calBtn = h(
      'button',
      {
        type: 'button',
        className: 'ui-btn ui-btn--sm ui-btn--quiet',
        'aria-expanded': 'false',
        'data-tip': 'Calibrate with 14 guided rubs and swipes; turns on the mic.',
        onClick: () => openCalibrationWizard(calBtn)
      },
      ['Calibrate']
    );

    const bezel = h('header', { className: 'ui-tile-head lg-bezel' }, [
      h('span', { className: 'ui-tile-index', textContent: '01' }),
      h('span', { className: 'ui-tile-title', textContent: 'Swipe sonar' }),
      h('div', { className: 'ui-tile-actions' }, [statusPill, armBtn, sonarBtn])
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
        'data-tip': 'The left grille, Esc to Fn. Drag to try a swipe; arrow keys simulate one.'
      },
      [
        h('div', { className: 'lg-rail-cap', 'aria-hidden': 'true' }, [
          h('span', { textContent: 'TOP' }),
          h('span', { textContent: 'ESC' })
        ]),
        railTrack,
        h('div', { className: 'lg-rail-cap', 'aria-hidden': 'true' }, [
          h('span', { textContent: 'BTM' }),
          h('span', { textContent: 'FN' })
        ])
      ]
    );

    // Telemetry Readouts
    const dirText = h('span', { className: 'lg-dir-text', textContent: '— IDLE' });
    const confBadge = h('span', {
      className: 'ui-readout ui-readout--quiet lg-conf-badge',
      'data-tip': 'How sure the detector is about the last swipe’s direction.',
      textContent: ''
    });
    const modeMeta = h('div', { className: 'lg-sub-meta', textContent: 'Swipe left speaker grille ↑/↓' });

    const speedNum = h('span', { textContent: '0.0' });
    const speedPeakMeta = h('div', {
      className: 'lg-sub-meta',
      'data-tip': 'Peak speed during the last swipe, and how long it took.',
      textContent: 'pk 0.0 cm/s'
    });

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
        className: 'ui-btn ui-btn--sm ui-btn--quiet',
        'data-tip': 'Simulate an upward swipe through the real detector; no mic needed.',
        onClick: () => playSimulatedSwipe('up')
      },
      ['Up']
    );
    const simDownBtn = h(
      'button',
      {
        type: 'button',
        className: 'ui-btn ui-btn--sm ui-btn--quiet',
        'data-tip': 'Simulate a downward swipe through the real detector; no mic needed.',
        onClick: () => playSimulatedSwipe('down')
      },
      ['Down']
    );
    const flipBtn = h(
      'button',
      {
        type: 'button',
        className: 'ui-btn ui-btn--sm ui-btn--quiet lg-mini-btn--flip',
        'data-tip': 'Swap which mic counts as top, for when up and down read reversed.',
        onClick: () => controller.togglePolarity()
      },
      ['Flip']
    );

    const scopeCanvas = h('canvas', { className: 'lg-scope-canvas', 'aria-hidden': 'true' });
    const scopeLeftNote = h('span', { textContent: 'Position y(t) · 11.0 cm left grille' });
    const scopeRightNote = h('span', { textContent: 'Doppler ±Δf' });

    const scopeBox = h(
      'div',
      {
        className: 'lg-scope-box',
        'data-tip': 'Finger position over time, blue moving up and rust down; bars at right are Doppler shift.'
      },
      [scopeCanvas, h('div', { className: 'lg-scope-caption' }, [scopeLeftNote, scopeRightNote])]
    );

    // Calibration / Error Overlay mounted directly on `.lg-telemetry` so the grille strip stays
    // visible beside it.
    const calStepPill = h('span', {
      className: 'ui-readout lg-cal-step-pill',
      textContent: '1 / 14'
    });
    const calCollectorLabel = h('span', { className: 'ui-pill-label', textContent: 'Local + JSON' });
    const calCollectorBadge = h(
      'span',
      {
        className: 'ui-pill lg-cal-disk-badge',
        dataset: { online: 'false' }
      },
      [calCollectorLabel]
    );
    const calMeterFill = h('div', {
      className: 'lg-cal-meter-fill',
      dataset: { hot: 'false' }
    });
    const calMeterText = h('span', {
      className: 'ui-readout ui-readout--quiet lg-cal-meter-db',
      textContent: '+0dB'
    });
    const calMeterWrap = h(
      'div',
      {
        className: 'lg-cal-meter',
        'data-tip': 'How far the rub or swipe stands above background noise, in dB.'
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
      h('span', { className: 'ui-label', textContent: 'Sim' }),
      simUpBtn,
      simDownBtn,
      h('span', { className: 'lg-foot-sep', 'aria-hidden': 'true' }),
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
          h('span', { className: 'ui-label', textContent: 'Direction' }),
          h('div', { className: 'lg-dir-readout' }, [dirText, confBadge]),
          modeMeta
        ]),
        h('div', { className: 'lg-card' }, [
          h('span', { className: 'ui-label', textContent: 'Speed' }),
          h('div', { className: 'lg-speed-val' }, [
            speedNum,
            h('span', { className: 'ui-readout-unit', textContent: 'cm/s' })
          ]),
          speedPeakMeta
        ])
      ]),
      h(
        'div',
        {
          className: 'lg-tier-dist',
          'data-tip': 'Finger position along the 11 cm grille: from the top, from the bottom, in cm.'
        },
        [
          h('span', { className: 'lg-dist-item' }, [
            topPctStrong,
            h('span', { className: 'lg-dist-tag', textContent: ' top' })
          ]),
          h('span', { className: 'lg-dist-item' }, [
            btmPctStrong,
            h('span', { className: 'lg-dist-tag', textContent: ' btm' })
          ]),
          cmSpanText
        ]
      ),
      scopeBox,
      inlineOverlay
    ]);

    const footReadout = h('span', {
      className: 'ui-readout ui-readout--quiet lg-foot-readout',
      'data-tip': 'Mic off. Readings come from dragging the strip or the Sim buttons.',
      textContent: 'Mic off'
    });

    const PILL_TIP_READY = 'Arm the mic, or drag the grille strip to try a simulated swipe.';
    const FOOT_TIP_LISTENING = 'Mic mode, sample rate in kHz, and INV when the mics are flipped.';
    let pillKey = '';
    let footText = '';

    const secCell1 = h(
      'section',
      {
        id: 'lg-sec-cell-1',
        className: 'cell lg-instrument-cell ui-tile',
        'aria-label': 'Left Grille Acoustic Swipe Detector'
      },
      [
        h('div', { className: 'lg-inst-stage lg-cell-stage' }, [
          bezel,
          h('div', { className: 'ui-tile-body lg-body' }, [
            railWrap,
            telemetryCol,
            h('p', {
              className: 'lg-compact-note',
              textContent: 'Sim, Flip and Calibrate need a wider tile.'
            })
          ]),
          h('footer', { className: 'ui-tile-foot lg-foot' }, [simActionsWrap, calBtn, footReadout])
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
        st.state === 'requesting' ? 'Arming…' : st.state === 'listening' ? 'Array live' : 'Arm array';

      if (st.state === 'listening') {
        const rateKhz = Math.round((st.sampleRate || 48000) / 100) / 10;
        const sonarAllowed = st.canUseSonar !== false && (st.sampleRate || 48000) >= 40000;
        const txTag =
          st.txMode && st.txMode !== 'off' && sonarAllowed
            ? st.txMode.toUpperCase()
            : 'PASSIVE';
        busStatusMeta.dataset.error = 'false';
        busStatusMeta.textContent = `${rateKhz}k · ${txTag}`;
        busStatusMeta.setAttribute(
          'data-tip',
          txTag === 'PASSIVE'
            ? `Mic sample rate in kHz; no tone is playing (listen only).`
            : `Mic sample rate in kHz, then the inaudible tone now playing (${txTag}).`
        );
        armArrayBtn.setAttribute(
          'data-tip',
          `Array live on ${st.micLabel || 'the mic'} at ${rateKhz} kHz. Click to turn it off.`
        );
      } else if (st.state === 'requesting') {
        busStatusMeta.dataset.error = 'false';
        busStatusMeta.textContent = 'Arming…';
        busStatusMeta.setAttribute('data-tip', 'Waiting for the browser to open the mic.');
        armArrayBtn.setAttribute('data-tip', 'Opening the mic. Click to cancel.');
      } else if (st.state === 'error' && st.error) {
        busStatusMeta.dataset.error = 'true';
        busStatusMeta.textContent = 'Sim only';
        busStatusMeta.setAttribute('data-tip', 'No mic: the sensors here run on simulated input only.');
        armArrayBtn.setAttribute('data-tip', `${st.error} Click to try again.`);
        announce(st.error);
      } else {
        busStatusMeta.dataset.error = 'false';
        busStatusMeta.textContent = '';
        busStatusMeta.setAttribute('data-tip', BUS_TIP_IDLE);
        armArrayBtn.setAttribute('data-tip', ARM_ARRAY_TIP_IDLE);
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

    // Status pill and foot readout: write only when the state really changes (telemetry runs
    // per audio block), so `data-tip` follows the state without per-frame DOM churn.

    function setStatus(key, label, tone, tip) {
      if (pillKey === key) return;
      pillKey = key;
      statusPillLabel.textContent = label;
      statusPill.dataset.tone = tone;
      statusPill.setAttribute('data-tip', tip);
    }

    function setLiveStatus() {
      const rateK = Math.round((controller.sampleRate || 48000) / 1000);
      setStatus(
        `live-${rateK}`,
        `Live · ${rateK}k`,
        'attention',
        `Listening for swipes at ${rateK} kHz. Click Live to stop.`
      );
    }

    // Sim ↑ / ↓ say so in the pill while the simulated swipe plays (mic not in use).
    let simPillTimer = null;

    function restorePillAfterSim() {
      simPillTimer = null;
      if (pillKey.indexOf('sim-') !== 0) return;
      if (controller.state === 'error') {
        setStatus('error', 'Sim only', 'attention', String(controller.errorMessage || PILL_TIP_READY));
      } else if (controller.state === 'idle') {
        setStatus('ready', 'Ready', 'idle', PILL_TIP_READY);
      }
    }

    function playSimulatedSwipe(dir) {
      if (controller.state !== 'listening' && controller.state !== 'requesting') {
        setStatus(
          `sim-${dir}`,
          dir === 'up' ? 'Sim · up' : 'Sim · down',
          'idle',
          `Playing a simulated ${dir === 'up' ? 'upward' : 'downward'} swipe; the mic is not used.`
        );
        if (simPillTimer) clearTimeout(simPillTimer);
        simPillTimer = setTimeout(restorePillAfterSim, 1500);
      }
      controller.runSimulatedSwipe(dir);
    }

    function setFoot(text, tip) {
      if (footText === text) return;
      footText = text;
      footReadout.textContent = text;
      footReadout.setAttribute('data-tip', tip);
    }

    function handleControllerState(st) {
      const armed = st.state === 'listening' || st.state === 'requesting';
      armBtn.dataset.armed = armed ? 'true' : 'false';
      armBtn.dataset.tone = armed ? 'attention' : '';
      armBtn.setAttribute('aria-pressed', armed ? 'true' : 'false');
      armLabel.textContent =
        st.state === 'requesting'
          ? 'Arming…'
          : st.state === 'listening'
            ? 'Live'
            : st.state === 'error'
              ? 'Retry'
              : 'Arm';
      armBtn.setAttribute(
        'data-tip',
        st.state === 'listening'
          ? 'Mic is on for this sensor. Click to turn it off.'
          : st.state === 'requesting'
            ? 'Opening the mic. Click to stop.'
            : st.state === 'error'
              ? 'The mic did not start. Click to try again.'
              : 'Turn on the mic for this sensor alone; stops the shared array.'
      );

      const sonarActive = Boolean(st.txEnabled && st.canUseSonar !== false);
      const sonarBlocked = st.state === 'listening' && st.canUseSonar === false;
      sonarBtn.setAttribute('aria-disabled', sonarBlocked ? 'true' : 'false');
      sonarBtn.setAttribute('aria-pressed', sonarActive ? 'true' : 'false');
      sonarBtn.setAttribute(
        'data-tip',
        sonarBlocked ? SONAR_TIP_BLOCKED : sonarActive ? SONAR_TIP_ON : SONAR_TIP_OFF
      );

      if (st.state === 'error' && st.error) {
        statusPill.dataset.veto = 'false';
        setStatus('error', 'Sim only', 'attention', String(st.error));
        setFoot('No mic', 'The mic could not start; readings are simulated.');
        showErrorOverlay(st.error, armBtn);
      } else if (st.state === 'requesting') {
        statusPill.dataset.veto = 'false';
        setStatus('arming', 'Arming…', 'attention', 'Waiting for the browser to open the mic.');
      } else if (st.state === 'listening') {
        if (!calWizardActive && !calOpening && !calSummaryActive) {
          inlineOverlay.hidden = true;
          syncBackgroundControlsInert();
        }
        statusPill.dataset.veto = 'false';
        setLiveStatus();
        setFoot(formatListeningStatus(), FOOT_TIP_LISTENING);
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
        setStatus(
          st.calibrated ? 'ready-cal' : 'ready',
          'Ready',
          'idle',
          st.calibrated ? 'Calibrated. Arm the mic, or drag the strip to try a swipe.' : PILL_TIP_READY
        );
        setFoot('Mic off', 'Mic off. Readings come from dragging the strip or the Sim buttons.');
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
        if (pkt.vetoReason === 'key') {
          setStatus('veto-key', 'Ignored', 'attention', 'Ignored a key click so it is not read as a swipe.');
        } else {
          setStatus('veto-voice', 'Ignored', 'attention', 'Ignored a voice so it is not read as a swipe.');
        }
      } else {
        statusPill.dataset.veto = 'false';
        if (controller.state === 'listening') {
          if (pkt.active) {
            setStatus('tracking', 'Tracking', 'attention', 'A finger is moving on the grille now.');
            setFoot(
              `+${Math.max(0, Math.round(pkt.fricSnrDb))} dB`,
              'How far the rub stands above background noise, in dB.'
            );
          } else {
            setLiveStatus();
            setFoot(formatListeningStatus(), FOOT_TIP_LISTENING);
          }
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
      calCollectorBadge.dataset.tone = calCollectorOnline ? 'ok' : 'idle';
      calCollectorLabel.textContent = calCollectorOnline ? 'Disk rec' : 'Local + JSON';
      calCollectorBadge.setAttribute(
        'data-tip',
        calCollectorOnline
          ? 'Each step is also saved to disk by cal-collector.mjs on 127.0.0.1:8792.'
          : 'Steps save in this browser; use JSON to download them. No disk collector found.'
      );
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
          className: 'ui-btn ui-btn--sm',
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
            className: 'ui-btn ui-btn--sm ui-btn--primary',
            onClick: () => closeCalibrationWizard({ restoreFocus: true })
          },
          ['Done']
        );
        const jsonBtn = h(
          'button',
          {
            type: 'button',
            className: 'ui-btn ui-btn--sm',
            'data-tip': 'Download the calibration and its recorded steps as JSON.',
            onClick: () => handleDownloadCalibrationJson()
          },
          ['JSON']
        );
        const resetBtn = h(
          'button',
          {
            type: 'button',
            className: 'ui-btn ui-btn--sm',
            'data-tip': 'Erase the saved calibration and go back to the defaults.',
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
          className: 'ui-btn ui-btn--sm ui-btn--primary',
          onClick: () => handleSaveAndNextStep()
        },
        [primaryCtaLabel]
      );
      const backStepBtn = h(
        'button',
        {
          type: 'button',
          className: 'ui-btn ui-btn--sm',
          'aria-disabled': calStepIndex === 0 ? 'true' : 'false',
          'data-tip': calStepIndex === 0 ? 'Already at the first step.' : 'Go back one step and record it again.',
          onClick: () => handlePrevStep()
        },
        ['Back']
      );
      const canFitEarly = hasEnoughSwipesForEarlyFit();
      const fitEarlyBtn = h(
        'button',
        {
          type: 'button',
          className: 'ui-btn ui-btn--sm lg-cal-secondary-btn',
          'aria-disabled': canFitEarly ? 'false' : 'true',
          'data-tip': canFitEarly
            ? 'Fit the calibration now from the steps recorded so far.'
            : 'Record at least 2 up and 2 down swipes before fitting early.',
          onClick: () => {
            if (!canFitEarly) return;
            handleFitCalibration();
          }
        },
        ['Fit Early']
      );
      const jsonBtn = h(
        'button',
        {
          type: 'button',
          className: 'ui-btn ui-btn--sm lg-cal-secondary-btn',
          'data-tip': 'Download the recorded steps as left-grille-calibration.json.',
          onClick: () => handleDownloadCalibrationJson()
        },
        ['JSON']
      );
      const resetBtn = h(
        'button',
        {
          type: 'button',
          className: 'ui-btn ui-btn--sm lg-cal-secondary-btn',
          'data-tip': 'Erase the saved calibration and go back to the defaults.',
          onClick: () => handleResetCalibration()
        },
        ['Reset']
      );
      const cancelBtn = h(
        'button',
        {
          type: 'button',
          className: 'ui-btn ui-btn--sm',
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
        if (mySeq !== calSessionSeq) return;
        if (!isSecondaryOpen) {
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
      if (mySeq !== calSessionSeq) return;
      if (!isSecondaryOpen || !ok || controller.state !== 'listening') {
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
    // Scope palette from the page tokens, read once (not per frame); literals are fallbacks.
    let scopePalette = null;

    function readScopePalette() {
      const pal = { ink: '#161615', up: '#0052cc', down: '#b4441a', line: '#d3d3ce' };
      try {
        const cs = global.getComputedStyle && global.getComputedStyle(scopeBox);
        if (cs) {
          const pick = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
          pal.ink = pick('--ui-ink', pal.ink);
          pal.up = pick('--lg-sig-up', pal.up);
          pal.down = pick('--lg-sig-down', pal.down);
          pal.line = pick('--ui-line', pal.line);
        }
      } catch (_) {}
      return pal;
    }

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
      if (!scopePalette) scopePalette = readScopePalette();
      const pal = scopePalette;
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
        ctx.strokeStyle = pal.ink;
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
          ctx.strokeStyle = y1 <= y0 ? pal.up : pal.down;
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
        ctx.strokeStyle = pal.line;
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
          ctx.fillStyle = isPos ? 'rgba(0, 82, 204, 0.72)' : 'rgba(180, 68, 26, 0.72)';
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

    // Close's own tip shows its Esc keycap, and it is the tip a keyboard user sees on open (focus
    // lands on Close). The shared tooltip swallows the Escape that hides a visible tip, which
    // would make that Esc a no-op; when the visible tip is Close's, Esc closes in one press.
    if (typeof global.addEventListener === 'function') {
      global.addEventListener(
        'keydown',
        (e) => {
          if (!e || e.key !== 'Escape' || !targetOpen) return;
          if (calWizardActive || calOpening || calSummaryActive || !inlineOverlay.hidden) return;
          if (backBtn.getAttribute('aria-describedby') !== 'ui-tip') return;
          e.preventDefault();
          if (typeof e.stopPropagation === 'function') e.stopPropagation();
          if (global.UITooltip && typeof global.UITooltip.hide === 'function') global.UITooltip.hide();
          requestCloseSecondaryView();
        },
        true
      );
    }

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
