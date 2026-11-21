/**
 * Primary Grid Cell & Seamless 9-Cell Secondary Workbench (`cells/hand-gesture/ui.js`)
 * SPDX-License-Identifier: MIT-0
 *
 * Mounts:
 * 1. Main Grid Cell (`#cell-hand-gesture`): Tactile Swiss/Linear specimen tile with live 21-joint
 *    hand preview, quick `Cam` (enables live webcam spatial cursor across the entire main page!) +
 *    `Sim` (figure-8 synthetic hand cursor) + `Studio ↗` portal button. Zero idle RAF when inactive.
 * 2. Secondary Page (`#hand-gesture-page`): Seamless in-page 3x3 `.grid` of 9 `.cell` instruments
 *    (`#hand-gesture` hash sync, `Close`, `Escape`, spatial View Transition `hg-stage-portal`)
 *    implementing all 5 webcam gesture primitives (hand raise recognition, cursor position, pinch,
 *    rotate, and up/down) plus live 60fps 1-Euro jitter oscilloscope & sensitivity tuners.
 * 3. Global Spatial Reticle Overlay (`#hg-spatial-overlay`): Renders primary + secondary hand
 *    reticles, elastic drag-origin tether, click-lock ring, and bimanual scale/angle pill across
 *    both the main grid (dispatching clicks & V-scroll to hovered page elements) and Studio.
 */
(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CIRC_R16 = 2 * Math.PI * 16;

  const TAPE_SPEC_ITEMS = [
    ['01 ANCHOR_METACARPAL', '0.50·L5 + 0.30·L9 + 0.20·L0'],
    ['02 HEISENBERG_DIP', '0.00px (L8 decoupled)'],
    ['03 ROI_INTERIOR_BOX', 'x:[0.22..0.78] y:[0.22..0.78]'],
    ['04 PALM_SPAN_GATE', 's_palm >= 0.055 aspect-iso'],
    ['05 CHIRAL_3D_NORMAL', 'sign(hand)·(v5×v17)_z >= 0.22'],
    ['06 KEYBOARD_GUARD', 'palm_y < 0.86 bottom horizon'],
    ['07 ARMING_DWELL', '200ms steady open-palm ring'],
    ['08 DROPOUT_COASTING', '4 frames (~145ms) latch hold'],
    ['09 ONE_EURO_COUPLED', 'fc = 1.15 + 0.85·hypot(dx,dy)'],
    ['10 MONOTONIC_CLOCK', 'performance.now() / 1000 s'],
    ['11 SCHMITT_ENGAGE', 'd(L4,L8)/s_palm < 0.28'],
    ['12 SCHMITT_RELEASE', 'd(L4,L8)/s_palm > 0.40'],
    ['13 PRE_PINCH_DAMP', '0.08x cursor delta on close'],
    ['14 CLICK_LOCK_RADIUS', '14.0px zero-slip origin pin'],
    ['15 CLICK_MAX_DWELL', '< 280ms crisp tap dispatch'],
    ['16 DRAG_SOFT_OFFSET', 'subtracts 14px breakout vec'],
    ['17 FUSED_TWIST_VEC', '0.72·knuckle + 0.28·lever'],
    ['18 TWIST_DEADZONE', '±3.5° breakout suppression'],
    ['19 WRIST_GAIN_2X', '2.0x ergonomic roll multiplier'],
    ['20 RELATIVE_CLUTCH', 'closed-fist release + sigmoid'],
    ['21 BIMANUAL_SCALE', '||H1 - H0|| / span_0 zoom'],
    ['22 BIMANUAL_STEER', 'atan2(sin dPhi, cos dPhi)'],
    ['23 V_SCROLL_POSTURE', 'L8+L12 ext · L16+L20 curled'],
    ['24 INERTIA_DECAY', '0.94^(dt·60) + row detent'],
    ['25 FADER_OFF_AXIS', 'target-latched vertical scrub'],
    ['26 MAGNETIC_PUCKS', 'tap=bypass · >=14px=slot swap'],
    ['27 ZERO_GC_BUFFERS', 'Float64Array(63) + RingBuf(240)'],
    ['28 RUNTIME_CDN_123', '@mediapipe/tasks-vision@1.2.3'],
  ];

  const INITIAL_PUCKS = [
    { id: 'gate', code: 'GATE', name: 'Palm 3D Gate', sub: 'n_z≥.22 · y<.86', bypassed: false },
    { id: 'euro', code: '1€', name: '1-Euro 2D', sub: 'β=0.85 hypot(v)', bypassed: false },
    { id: 'pinch', code: 'PINCH', name: 'Schmitt Lock', sub: '.28/.40 · 14px', bypassed: false },
    { id: 'twist', code: 'TWIST', name: 'Fused 2.0×', sub: 'Bar+Lev · ±3.5°', bypassed: false },
  ];

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'className') el.className = v;
        else if (k === 'textContent') el.textContent = String(v);
        else if (k === 'value') el.value = String(v);
        else if (k === 'dataset') {
          Object.keys(v).forEach(function (dk) {
            if (v[dk] !== undefined && v[dk] !== null) el.dataset[dk] = String(v[dk]);
          });
        } else if (k.startsWith('on') && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v === true) {
          el.setAttribute(k, '');
        } else {
          el.setAttribute(k, String(v));
        }
      });
    }
    if (children !== undefined && children !== null) {
      const list = Array.isArray(children) ? children : [children];
      list.forEach(function (c) {
        if (c === undefined || c === null || c === false) return;
        if (typeof c === 'string' || typeof c === 'number') {
          el.appendChild(document.createTextNode(String(c)));
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
      Object.keys(attrs).forEach(function (k) {
        if (attrs[k] !== undefined && attrs[k] !== null) {
          // SVG elements have no `className` attribute; it must be written as `class` or the
          // `.hg-mini-svg` / `.hg-spatial-chord` rules never match.
          node.setAttribute(k === 'className' ? 'class' : k, String(attrs[k]));
        }
      });
    }
    if (children) {
      children.forEach(function (c) {
        if (c) node.appendChild(c);
      });
    }
    return node;
  }

  function setAttr(el, k, v) {
    if (el) el.setAttribute(k, String(v));
  }

  function safeSetPointerCapture(el, pointerId) {
    if (!el || typeof el.setPointerCapture !== 'function' || pointerId === undefined) return;
    try {
      el.setPointerCapture(pointerId);
    } catch (_) {}
  }

  function prefersReducedMotion() {
    return Boolean(
      global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  function mountHandGestureCell(portalCell) {
    const K = global.HandGestureKinematics;
    const T = global.HandGestureTracker;
    if (!portalCell || !K || !T) return;

    const mainGrid = portalCell.closest('main.grid') || document.querySelector('main.grid');
    if (!mainGrid) return;

    const {
      DEFAULT_CONFIG,
      HAND_BONES,
      HAND_STATE,
      MAPPING_MODE,
      PINCH_MODE,
      ROTATION_SOURCE,
      KinematicEngine,
      LM,
      SyntheticHandRig,
      clamp,
    } = K;
    const { CAMERA_STATUS, TRACKER_MODE, HandTrackerController } = T;

    const engine = new KinematicEngine();
    const synthRig = new SyntheticHandRig();
    synthRig.autoOrbit = !prefersReducedMotion();

    // Palette for SVG attributes and canvas drawing: read once from the shared `--ui-` tokens
    // (ui/base.css). Ink for the hand and instruments, the one accent for live or rejected states.
    const rootStyle = global.getComputedStyle ? global.getComputedStyle(document.documentElement) : null;
    function tok(name, fallback) {
      const v = rootStyle ? rootStyle.getPropertyValue(name).trim() : '';
      return v || fallback;
    }
    function withAlpha(hex, a) {
      const m = /^#([0-9a-f]{6})$/i.exec(hex);
      if (!m) return hex;
      const n = parseInt(m[1], 16);
      return 'rgba(' + ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255) + ', ' + a + ')';
    }
    const PAL = {
      ink: tok('--ui-ink', '#161615'),
      ink2: tok('--ui-ink-2', '#4f4f4b'),
      ink3: tok('--ui-ink-3', '#66665f'),
      line: tok('--ui-line', '#d3d3ce'),
      hairline: tok('--ui-hairline', '#e5e5e2'),
      well: tok('--ui-well', '#f7f7f5'),
      surface: tok('--ui-surface', '#ffffff'),
      accent: tok('--ui-accent', '#b4441a'),
    };
    const MONO = tok('--ui-mono', 'ui-monospace, monospace');
    // Canvas-only derived colours and fonts, built once (the draw loop runs every frame).
    const CAN = {
      accentA05: withAlpha(PAL.accent, 0.05),
      accentA10: withAlpha(PAL.accent, 0.1),
      accentA14: withAlpha(PAL.accent, 0.14),
      accentA45: withAlpha(PAL.accent, 0.45),
      accentA70: withAlpha(PAL.accent, 0.7),
      inkA06: withAlpha(PAL.ink, 0.06),
      inkA25: withAlpha(PAL.ink, 0.25),
      font: '500 10px ' + MONO,
      fontBold: '600 10px ' + MONO,
    };

    // -----------------------------------------------------------------------
    // 1. Primary 1x1 Grid Cell (`#cell-hand-gesture`)
    // -----------------------------------------------------------------------
    const miniVideo = h('video', { className: 'hg-mini-video', playsinline: true, muted: true });
    const miniBoneLines = [];
    for (let i = 0; i < HAND_BONES.length; i += 2) {
      miniBoneLines.push(
        svgEl('line', { x1: 60, y1: 60, x2: 60, y2: 60, stroke: PAL.ink2, 'stroke-width': '1.5', 'stroke-linecap': 'round' })
      );
    }
    const miniPinchLine = svgEl('line', {
      x1: 60, y1: 40, x2: 72, y2: 42,
      stroke: PAL.ink3, 'stroke-width': '1.25', 'stroke-dasharray': '3 3',
    });
    const miniAnchorDot = svgEl('circle', { cx: 60, cy: 52, r: '1.3', fill: PAL.accent });
    const miniAnchorRing = svgEl('circle', {
      cx: 60, cy: 52, r: '3.6', fill: 'none', stroke: PAL.accent, 'stroke-width': '1.5',
    });
    const miniRoiRect = svgEl('rect', {
      x: 26, y: 20, width: 68, height: 50, rx: '3',
      fill: 'none', stroke: PAL.line, 'stroke-width': '1', 'stroke-dasharray': '4 3',
    });
    const miniSvg = svgEl('svg', { className: 'hg-mini-svg', viewBox: '0 0 120 90', 'aria-hidden': 'true' }, [
      miniRoiRect,
      svgEl('g', {}, miniBoneLines),
      miniPinchLine,
      miniAnchorRing,
      miniAnchorDot,
    ]);

    // One quiet row of label + value pairs under the hero (hidden at compact size).
    function primPair(label, value, tip) {
      const val = h('span', { className: 'ui-readout hg-prim-val', textContent: value });
      const row = h('div', { className: 'hg-prim', 'data-tip': tip }, [
        h('span', { className: 'ui-label', textContent: label }),
        val,
      ]);
      return { row: row, val: val };
    }
    const primPos = primPair('Pos', '0.50, 0.50', 'Cursor position, 0 to 1 from the left and from the top.');
    const primPinch = primPair('Pinch', 'OPEN 0.72', 'Finger gap over palm width; LOCK means a pinch is held.');
    const primRot = primPair('Twist', '+0.0°', 'Hand twist since the gesture began, in degrees.');
    const primUpDn = primPair('Scroll', 'V-IDLE', 'Two-finger scroll speed in pixels per second, or idle.');
    const primPosVal = primPos.val;
    const primPinchVal = primPinch.val;
    const primRotVal = primRot.val;
    const primUpDnVal = primUpDn.val;
    const primPosRow = primPos.row;
    const primPinchRow = primPinch.row;
    const primRotRow = primRot.row;
    const primUpDnRow = primUpDn.row;

    const portalCamBtn = h('button', {
      type: 'button',
      className: 'ui-btn ui-btn--sm ui-hide-tiny',
      'aria-pressed': 'false',
      textContent: 'Cam',
    });
    const portalSimBtn = h('button', {
      type: 'button',
      className: 'ui-btn ui-btn--sm ui-hide-tiny',
      'aria-pressed': 'false',
      textContent: 'Sim',
    });
    const portalStudioBtn = h('button', {
      type: 'button',
      className: 'ui-btn ui-btn--sm ui-btn--quiet ui-hide-compact',
      'data-tip': 'Open the Studio: nine gesture instruments to try and tune.',
      textContent: 'Studio ↗',
    });

    const portalStatusText = h('span', { className: 'hg-portal-status ui-truncate', textContent: '' });
    const portalPillLabel = h('span', { className: 'ui-pill-label', textContent: 'STANDBY' });
    const portalStatePill = h('span', { className: 'ui-pill hg-portal-pill' }, [portalPillLabel]);

    const portalStage = h(
      'div',
      {
        className: 'hg-portal-stage',
        tabindex: '0',
        role: 'button',
        'aria-label': 'Open the Hand Cursor Studio',
        'data-tip': 'Open the Studio.',
      },
      [
        h('div', { className: 'hg-mini-cam-box' }, [
          h('div', { className: 'hg-mini-frame ui-well' }, [miniVideo, miniSvg]),
        ]),
        h('div', { className: 'hg-mini-primitives ui-hide-compact' }, [
          primPosRow,
          primPinchRow,
          primRotRow,
          primUpDnRow,
        ]),
      ]
    );

    portalCell.textContent = '';
    portalCell.classList.add('ui-tile');
    portalCell.appendChild(h('header', { className: 'ui-tile-head' }, [
      h('span', { className: 'ui-tile-index', textContent: '08' }),
      h('span', { className: 'ui-tile-title', textContent: 'Hand Cursor' }),
      h('div', { className: 'ui-tile-actions' }, [portalStatePill, portalCamBtn, portalSimBtn, portalStudioBtn]),
    ]));
    portalCell.appendChild(h('div', { className: 'ui-tile-body hg-portal-body' }, [portalStage]));
    portalCell.appendChild(h('footer', { className: 'ui-tile-foot' }, [portalStatusText]));

    // Status pill: label, tone and tip written only when they change (the frame loop calls this).
    let portalPillKey = '';
    function setPortalPill(label, tone, tip) {
      const key = label + '|' + tone + '|' + tip;
      if (key === portalPillKey) return;
      portalPillKey = key;
      portalPillLabel.textContent = label;
      if (tone) portalStatePill.setAttribute('data-tone', tone);
      else portalStatePill.removeAttribute('data-tone');
      portalStatePill.setAttribute('data-tip', tip);
    }
    const PILL_TIP_STANDBY = 'Hand cursor is off. Press Cam or Sim to start it.';
    setPortalPill('STANDBY', 'idle', PILL_TIP_STANDBY);

    function setPortalStatus(text, tip) {
      if (portalStatusText.textContent !== text) portalStatusText.textContent = text;
      if (tip) portalStatusText.setAttribute('data-tip', tip);
      else portalStatusText.removeAttribute('data-tip');
    }
    const PORTAL_HINT = 'Hold an open palm still to arm, then pinch, twist or two-finger scroll';
    setPortalStatus(PORTAL_HINT, '');

    // Cam / Sim: pressed state, running tone (rust) and a tip that says what the next click does.
    // `inStudio` is passed in (not read from `isSecondaryOpen`, which is declared later).
    function syncPortalToggles(mode, camPending, inStudio) {
      const camOn = mode === TRACKER_MODE.WEBCAM || (!inStudio && camPending);
      const simOn = !camPending && (mode === TRACKER_MODE.SYNTH || mode === TRACKER_MODE.TOUR);
      setAttr(portalCamBtn, 'aria-pressed', String(camOn));
      setAttr(portalSimBtn, 'aria-pressed', String(simOn));
      if (camOn || camPending) portalCamBtn.setAttribute('data-tone', 'attention');
      else portalCamBtn.removeAttribute('data-tone');
      if (simOn) portalSimBtn.setAttribute('data-tone', 'attention');
      else portalSimBtn.removeAttribute('data-tone');
      setAttr(portalCamBtn, 'data-tip',
        camPending ? 'Cancel the camera request.'
          : camOn ? 'Turn the webcam cursor off.'
            : 'Use your webcam to move a cursor across this page with your hand.');
      setAttr(portalSimBtn, 'data-tip',
        simOn ? 'Stop the simulated hand cursor.'
          : 'Move a simulated hand cursor across this page; no camera needed.');
      // Escape on the grid turns a running cursor off (document keydown handler below).
      [[portalCamBtn, camOn || camPending], [portalSimBtn, simOn]].forEach(function (pair) {
        if (pair[1]) pair[0].setAttribute('data-tip-key', 'Escape');
        else pair[0].removeAttribute('data-tip-key');
      });
    }
    syncPortalToggles(TRACKER_MODE.IDLE, false, false);

    // Paint static neutral skeleton in mini SVG before RAF ever runs
    function drawStaticMiniHand() {
      synthRig.stepAndPopulate(engine, 1 / 60, 4 / 3);
      const lm = synthRig.normBuf0;
      for (let i = 0; i < HAND_BONES.length; i += 2) {
        const a = HAND_BONES[i] * 3;
        const b = HAND_BONES[i + 1] * 3;
        const line = miniBoneLines[i >> 1];
        setAttr(line, 'x1', ((1 - lm[a]) * 120).toFixed(1));
        setAttr(line, 'y1', (lm[a + 1] * 90).toFixed(1));
        setAttr(line, 'x2', ((1 - lm[b]) * 120).toFixed(1));
        setAttr(line, 'y2', (lm[b + 1] * 90).toFixed(1));
        setAttr(line, 'stroke', PAL.ink2);
      }
      setAttr(miniPinchLine, 'x1', ((1 - lm[LM.THUMB_TIP * 3]) * 120).toFixed(1));
      setAttr(miniPinchLine, 'y1', (lm[LM.THUMB_TIP * 3 + 1] * 90).toFixed(1));
      setAttr(miniPinchLine, 'x2', ((1 - lm[LM.INDEX_TIP * 3]) * 120).toFixed(1));
      setAttr(miniPinchLine, 'y2', (lm[LM.INDEX_TIP * 3 + 1] * 90).toFixed(1));
      setAttr(miniPinchLine, 'stroke', PAL.ink3);
      setAttr(miniPinchLine, 'stroke-dasharray', '3 3');
      const ax = (1 - (0.5 * lm[LM.INDEX_MCP * 3] + 0.3 * lm[LM.MIDDLE_MCP * 3] + 0.2 * lm[0])) * 120;
      const ay = (0.5 * lm[LM.INDEX_MCP * 3 + 1] + 0.3 * lm[LM.MIDDLE_MCP * 3 + 1] + 0.2 * lm[1]) * 90;
      setAttr(miniAnchorDot, 'cx', ax.toFixed(1));
      setAttr(miniAnchorDot, 'cy', ay.toFixed(1));
      setAttr(miniAnchorRing, 'cx', ax.toFixed(1));
      setAttr(miniAnchorRing, 'cy', ay.toFixed(1));
      engine.resetAll();
    }
    drawStaticMiniHand();

    // -----------------------------------------------------------------------
    // 2. Secondary 9-Cell `.grid` Studio (`#hand-gesture-page`)
    // -----------------------------------------------------------------------
    const wbVideo = h('video', { className: 'hg-wb-video', playsinline: true, muted: true });
    const tracker = new HandTrackerController(engine, synthRig, miniVideo);

    const backBtn = h('button', {
      type: 'button', className: 'ui-btn', 'data-tip': 'Back to the grid.', 'data-tip-key': 'Esc', textContent: 'Close',
    });
    const modeSynthBtn = h('button', { type: 'button', 'aria-pressed': 'true', textContent: 'Synth', 'data-tip': 'A simulated hand you steer by dragging the rig or with its buttons.' });
    const modeTourBtn = h('button', { type: 'button', 'aria-pressed': 'false', textContent: 'Tour', 'data-tip': 'The simulated hand demonstrates every gesture by itself.' });
    const modeWebcamBtn = h('button', { type: 'button', 'aria-pressed': 'false', textContent: 'Webcam', 'data-tip': 'Track your real hand with the webcam.', 'data-tip-key': 'C' });
    const modePointerBtn = h('button', { type: 'button', 'aria-pressed': 'false', textContent: 'Pointer', 'data-tip': 'Feed your mouse position to the smoothing scope instead of a hand.' });
    const mapModeBtn = h('button', {
      type: 'button',
      className: 'ui-btn ui-btn--sm',
      'aria-pressed': 'false',
      textContent: 'Map: ROI',
    });

    // Gate pills: idle (no hand), pass (ink), fail or active (rust). Written only on change.
    function gatePill(label, tip) {
      const text = h('span', { className: 'ui-pill-label', textContent: label });
      const el = h('span', { className: 'ui-pill hg-gate', 'data-tip': tip }, [text]);
      return { el: el, text: text, key: '' };
    }
    function setGate(g, state, label) {
      const key = state + '|' + label;
      if (g.key === key) return;
      g.key = key;
      if (state === 'attention') { g.el.setAttribute('data-tone', 'attention'); g.el.removeAttribute('data-state'); }
      else if (state === 'pass') { g.el.removeAttribute('data-tone'); g.el.setAttribute('data-state', 'pass'); }
      else { g.el.removeAttribute('data-tone'); g.el.removeAttribute('data-state'); }
      if (label !== undefined && g.text.textContent !== label) g.text.textContent = label;
    }
    const gSpan = gatePill('SPAN', 'Close enough: palm width in the frame is above the minimum.');
    const gFacing = gatePill('FACING', 'Palm faces the camera, not edge-on or back of the hand.');
    const gKbd = gatePill('ABOVE KBD', 'Hand is above the keyboard zone at the bottom of the camera view.');
    const gArm = gatePill('IDLE', 'Arming: hold an open palm still for 0.2 s to take the cursor.');
    const gGesture = gatePill('OPEN', 'Current gesture: open hand, pinch lock or drag, two hands, scroll or clutch.');
    const gateSpan = gSpan.el;
    const gateFacing = gFacing.el;
    const gateKbd = gKbd.el;
    const gateArm = gArm.el;
    const gateGesture = gGesture.el;

    const btnToggleKeys = h('button', {
      type: 'button', className: 'ui-btn ui-btn--sm', 'aria-expanded': 'false', textContent: 'Keys',
      'data-tip': 'Show keyboard shortcuts.', 'data-tip-key': '?',
    });
    const fpsReadout = h('span', {
      className: 'ui-readout ui-readout--quiet hg-wb-fps', textContent: '60 FPS · 16.7ms',
      'data-tip': 'Tracking frames per second and time per frame.',
    });

    function kbdItem(keys, label) {
      const kids = [];
      keys.forEach(function (k, i) {
        if (i) kids.push(' ');
        kids.push(h('kbd', { className: 'ui-kbd', textContent: k }));
      });
      kids.push(h('span', { textContent: label }));
      return h('span', { className: 'hg-kbd-item' }, kids);
    }
    const keysDrawer = h('section', { className: 'hg-wb-drawer', hidden: true, 'aria-label': 'Keyboard shortcuts' }, [
      h('div', { className: 'hg-kbd-list' }, [
        kbdItem(['Esc'], 'Close'),
        kbdItem(['Space'], 'Show or hide hand'),
        kbdItem(['P'], 'Pinch (hold)'),
        kbdItem(['V'], 'Two-finger scroll'),
        kbdItem(['G'], 'Fist clutch'),
        kbdItem(['F'], 'Flip palm'),
        kbdItem(['D'], 'Second hand'),
        kbdItem(['O'], 'Orbit'),
        kbdItem(['[', ']'], 'Twist ±6°'),
        kbdItem(['C'], 'Webcam'),
      ]),
    ]);

    const camBannerMsg = h('span', { textContent: '' });
    const camBannerDismiss = h('button', { type: 'button', className: 'ui-btn ui-btn--sm', textContent: 'Dismiss' });
    const camBanner = h('div', { className: 'hg-cam-banner', hidden: true, role: 'status' }, [camBannerMsg, camBannerDismiss]);

    // Studio instrument: the shared tile anatomy (index, title, quiet meta readout, body, foot).
    // The foot is `.hg-cell-foot`, not `.ui-tile-foot`: instruments are ~273 px wide at a 900 px
    // page, and the shared compact step hides `.ui-tile-foot` below 320 px with their controls.
    function metric(text, tip) {
      return h('span', { className: 'ui-readout ui-readout--quiet hg-cell-metric', textContent: text, 'data-tip': tip });
    }
    function instrument(idx, title, ariaLabel, titleTip, metricEl, body, foot) {
      return h('section', { className: 'cell ui-tile hg-wb-cell', 'aria-label': ariaLabel }, [
        h('header', { className: 'ui-tile-head' }, [
          h('span', { className: 'ui-tile-index', textContent: idx }),
          h('span', { className: 'ui-tile-title', textContent: title, 'data-tip': titleTip || null }),
          metricEl,
        ]),
        body,
        foot || null,
      ]);
    }
    function foot(kids) {
      return h('div', { className: 'hg-cell-foot' }, kids);
    }
    function sm(text, attrs) {
      return h('button', Object.assign({ type: 'button', className: 'ui-btn ui-btn--sm', textContent: text }, attrs || {}));
    }

    // Build 9 Workbench Cells
    const c1Metric = metric('SYNTH · ROI', 'Input source and how hand position maps to the cursor.');
    const rigCanvas = h('canvas', { className: 'hg-rig-canvas' });
    const rigStage = h('div', {
      className: 'hg-rig-stage',
      tabindex: '0',
      role: 'application',
      'aria-label': 'Hand rig. Drag to move, Shift-drag or [ ] to twist the wrist, double-click to pinch.',
      'data-tip': 'Drag to move the hand; Shift-drag or the wheel twists; double-click pinches.',
    }, [wbVideo, rigCanvas]);
    const rigBtnPresent = sm('Hand', { 'aria-pressed': 'true', 'data-tip': 'Show or hide the simulated hand.', 'data-tip-key': ' ' });
    const rigBtnPinch = sm('Pinch', { 'aria-pressed': 'false', 'data-tip': 'Hold to pinch; a quick tap latches it, tap again to release.', 'data-tip-key': 'P' });
    const rigBtnVScroll = sm('Scroll', { 'aria-pressed': 'false', 'data-tip': 'Raise two fingers so the simulated hand scrolls.', 'data-tip-key': 'V' });
    const rigBtnDorsal = sm('Flip', { 'aria-pressed': 'false', 'data-tip': 'Turn the back of the hand to the camera; the facing gate rejects it.', 'data-tip-key': 'F' });
    const rigBtnDual = sm('2 Hands', { 'aria-pressed': 'false', 'data-tip': 'Add a second simulated hand for two-hand zoom and turn.', 'data-tip-key': 'D' });
    const rigBtnOrbit = sm('Orbit', { 'aria-pressed': String(synthRig.autoOrbit), 'data-tip': 'Let the simulated hand drift around on its own.', 'data-tip-key': 'O' });

    const wbCell01 = instrument('01', 'Hand Rig', '01 Hand rig', 'The tracked hand: 21 joints, the cursor area and the keyboard zone.', c1Metric,
      h('div', { className: 'ui-tile-body ui-tile-body--flush' }, [rigStage]),
      h('div', { className: 'hg-cell-foot hg-rig-controls', role: 'group', 'aria-label': 'Simulated hand pose' }, [
        rigBtnPresent, rigBtnPinch, rigBtnVScroll, rigBtnDorsal, rigBtnDual, rigBtnOrbit,
      ]));

    const c2Metric = metric('fc 1.15Hz · 0.0dB', 'Filter cutoff now, and how much jitter the filter removes, in dB.');
    const scopeCanvas = h('canvas', {
      className: 'hg-scope-canvas',
      tabindex: '0',
      role: 'img',
      'aria-label': 'Cursor path, and raw versus smoothed position over time',
      'data-tip': 'Left: cursor path, drag to set a target. Right: raw and smoothed traces.',
    });
    const c2XyReadout = h('span', { className: 'hg-foot-read', textContent: 'LOCUS 0.500, 0.500', 'data-tip': 'Smoothed cursor position, 0 to 1 across and down.' });
    const c2FreezeBtn = sm('Hold Trace', { 'aria-pressed': 'false', 'data-tip': 'Freeze the trace so you can study it.' });
    const wbCell02 = instrument('02', 'Smoothing Scope', '02 Smoothing scope', '1€ filter: smooths jitter when the hand is still, follows fast moves.', c2Metric,
      h('div', { className: 'ui-tile-body ui-tile-body--flush' }, [scopeCanvas]),
      foot([c2XyReadout, c2FreezeBtn]));

    const c3Metric = metric('d/s 0.72 · OPEN', 'Finger gap divided by palm width, and the pinch state.');
    const c3SchmittFill = h('div', { className: 'hg-schmitt-fill' });
    const c3MarkEngage = h('div', { className: 'hg-schmitt-mark', style: 'left: 35%' });
    const c3MarkRelease = h('div', { className: 'hg-schmitt-mark', style: 'left: 50%' });
    const c3LabelEngage = h('span', { textContent: 'ENG <.28' });
    const c3LabelRelease = h('span', { textContent: 'REL >.40' });
    const c3Pads = [];
    for (let i = 0; i < 9; i++) {
      const initOn = i === 1 || i === 4 || i === 8;
      c3Pads.push(
        h('button', { type: 'button', className: 'hg-matrix-pad', 'aria-pressed': String(initOn) }, [
          h('span', { className: 'hg-pad-led' }),
          h('span', { textContent: 'M' + (i + 1) }),
        ])
      );
    }
    const c3ClickStats = h('span', { className: 'hg-foot-read', textContent: 'CLICKS 0 · DWELL — · SLIP 0.0px', 'data-tip': 'Clicks so far, how long the last pinch was held, and cursor slip.' });
    const c3ClearBtn = sm('Clear', { 'data-tip': 'Turn every pad off and reset the click count.' });
    const wbCell03 = instrument('03', 'Pinch Pads', '03 Pinch pads', 'Schmitt trigger: separate pinch and release gaps stop clicks from flickering.', c3Metric,
      h('div', { className: 'ui-tile-body' }, [
        h('div', { className: 'hg-schmitt-meter', 'aria-hidden': 'true', 'data-tip': 'Finger gap: a pinch starts left of the first mark and ends right of the second.' }, [
          h('div', { className: 'hg-schmitt-track' }, [c3SchmittFill, c3MarkEngage, c3MarkRelease]),
          h('div', { className: 'hg-schmitt-labels' }, [
            h('span', { textContent: '0.00' }),
            c3LabelEngage,
            c3LabelRelease,
            h('span', { textContent: 'LOCK 14px' }),
          ]),
        ]),
        h('div', {
          className: 'hg-pinch-matrix', role: 'group', 'aria-label': 'Pinch practice pads',
          'data-tip': 'Practice targets: pinch or click a pad to toggle it; pinch-drag turns pads on.',
        }, c3Pads),
      ]),
      foot([c3ClickStats, c3ClearBtn]));

    const c4Metric = metric('+0.0° · 2.0×', 'Dial angle; your hand twist counts double.');
    const dialCanvas = h('canvas', { className: 'hg-dial-canvas' });
    const c4DialWrap = h('div', {
      className: 'hg-dial-wrap',
      tabindex: '0',
      role: 'slider',
      'aria-label': 'Twist dial, degrees',
      'aria-valuemin': '-720',
      'aria-valuemax': '720',
      'aria-valuenow': '0',
      'aria-valuetext': '+0.0° (0 turns)',
      'data-tip': 'Pinch here and twist, drag up or down, scroll, or use the arrow keys.',
    }, [dialCanvas]);
    const c4DzStatus = h('span', { className: 'hg-foot-read', textContent: 'DEAD ZONE ±3.5° · FUSED', 'data-tip': 'Twists under 3.5° are ignored so the dial does not drift.' });
    const c4VecBtn = sm('Angle: Fused', { 'data-tip': 'Which hand angle turns the dial: fused, knuckle line, or wrist lever.' });
    const c4ZeroBtn = sm('Zero', { 'data-tip': 'Set the dial back to 0°.' });
    const wbCell04 = instrument('04', 'Twist Dial', '04 Twist dial', 'Turns as far as two full turns either way, following your wrist.', c4Metric,
      h('div', { className: 'ui-tile-body ui-tile-body--flush' }, [c4DialWrap]),
      foot([c4DzStatus, h('div', { className: 'hg-foot-btns' }, [c4VecBtn, c4ZeroBtn])]));

    const c5Metric = metric('1.00× · +0.0°', 'Card zoom and rotation.');
    const c5CardXy = h('span', { textContent: '0, 0' });
    const c5CardSr = h('span', { textContent: '1.00×' });
    const c5Card = h('div', { className: 'hg-stage-card' }, [
      h('span', { className: 'hg-stage-handle hg-stage-handle--tl' }),
      h('span', { className: 'hg-stage-handle hg-stage-handle--tr' }),
      h('span', { className: 'hg-stage-handle hg-stage-handle--bl' }),
      h('span', { className: 'hg-stage-handle hg-stage-handle--br' }),
      h('div', { className: 'hg-stage-card-label', textContent: 'Card' }),
      h('div', { className: 'hg-stage-card-vec', 'aria-hidden': 'true' }, [
        svgEl('svg', { width: '38', height: '26', viewBox: '0 0 38 26', fill: 'none' }, [
          svgEl('rect', { x: '1', y: '1', width: '36', height: '24', rx: '3', stroke: PAL.line, 'stroke-dasharray': '2 2' }),
          svgEl('circle', { cx: '19', cy: '13', r: '6', stroke: PAL.accent, 'stroke-width': '1.5' }),
          svgEl('path', { d: 'M19 4V22M10 13H28', stroke: PAL.ink, 'stroke-width': '1' }),
        ]),
      ]),
      h('div', { className: 'hg-stage-card-coords' }, [c5CardXy, c5CardSr]),
    ]);
    const c5Viewport = h('div', {
      className: 'hg-stage-viewport show-guides',
      tabindex: '0',
      role: 'application',
      'aria-label': 'Transform stage. Pinch-drag or arrows to move, twist to rotate, two-hand pinch or plus and minus to zoom.',
      'data-tip': 'Pinch-drag or arrow keys move the card; twist turns it; two hands zoom.',
    }, [
      h('div', { className: 'hg-stage-guide-h' }),
      h('div', { className: 'hg-stage-guide-v' }),
      c5Card,
    ]);
    const c5ResetBtn = sm('Reset', { 'data-tip': 'Put the card back: centred, 1× zoom, no rotation.' });
    const wbCell05 = instrument('05', 'Transform Stage', '05 Transform stage', '', c5Metric,
      h('div', { className: 'ui-tile-body ui-tile-body--flush' }, [c5Viewport]),
      foot([c5ResetBtn]));

    const c6Metric = metric('68.0% · -0.9 dB', 'Fader level in percent and decibels; 75% is 0 dB.');
    const c6Fill = h('div', { className: 'hg-fader-fill' });
    const c6Peak = h('div', { className: 'hg-fader-peak', style: 'bottom: 68%' });
    const c6Thumb = h('div', { className: 'hg-fader-thumb' });
    const c6Track = h('div', {
      className: 'hg-fader-track-wrap',
      tabindex: '0',
      role: 'slider',
      'aria-label': 'Fader level, percent',
      'aria-orientation': 'vertical',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '68',
      'aria-valuetext': '68.0% (-0.9 dB)',
      'data-tip': 'Pinch anywhere in this panel and move up or down; drag or arrows also work.',
    }, [h('div', { className: 'hg-fader-rail' }, [c6Fill]), c6Peak, c6Thumb]);
    const c6BigPct = h('div', { className: 'ui-readout hg-fader-big-val', textContent: '68.0%' });
    const c6BigDb = h('div', { className: 'ui-readout ui-readout--quiet hg-fader-db-val', textContent: '-0.9 dB' });
    const c6LatchBadge = h('span', { className: 'ui-pill hg-fader-badge', textContent: 'READY', 'data-tip': 'Whether the fader is grabbed, by pointer or by pinch.' });
    const c6FaderArea = h('div', { className: 'hg-fader-layout' }, [
      h('div', { className: 'hg-fader-scale', 'aria-hidden': 'true' }, [
        h('span', { textContent: '+6 dB' }),
        h('span', { textContent: '0 dB' }),
        h('span', { textContent: '-6 dB' }),
        h('span', { textContent: '-18 dB' }),
        h('span', { textContent: '-∞' }),
      ]),
      c6Track,
      h('div', { className: 'hg-fader-readout-col' }, [c6BigPct, c6BigDb, c6LatchBadge]),
    ]);
    const c6UnityBtn = sm('0 dB', { 'data-tip': 'Set the fader to 0 dB, 75% of its travel.' });
    const wbCell06 = instrument('06', 'Pinch Fader', '06 Pinch fader', 'Grab with a pinch anywhere in the panel, then move up or down.', c6Metric,
      h('div', { className: 'ui-tile-body ui-tile-body--flush' }, [c6FaderArea]),
      foot([c6UnityBtn]));

    const c7Metric = metric('VEL 0 px/s', 'Scroll speed in pixels per second.');
    const c7Tape = h('div', {
      className: 'hg-tape-list', tabindex: '0', role: 'listbox', 'aria-label': 'Scroll tape of tracking settings',
      'aria-activedescendant': 'hg-tape-opt-0',
      'data-tip': 'Two raised fingers scroll it with momentum; slow scrolls snap to rows.',
    });
    const c7VelBar = h('div', { className: 'hg-tape-vel-bar' });
    const c7PosReadout = h('span', { className: 'hg-foot-read', textContent: 'ROW 01/28 · PIN #01', 'data-tip': 'Top visible row, and the row you pinned by clicking.' });
    const c7FlickDown = sm('Flick ↓', { 'aria-label': 'Flick down', 'data-tip': 'Throw the tape down, like a fast two-finger flick.' });
    const c7FlickUp = sm('Flick ↑', { 'aria-label': 'Flick up', 'data-tip': 'Throw the tape up, like a fast two-finger flick.' });
    const wbCell07 = instrument('07', 'Scroll Tape', '07 Scroll tape', '', c7Metric,
      h('div', { className: 'ui-tile-body ui-tile-body--flush hg-tape-wrap' }, [
        c7Tape,
        h('div', { className: 'hg-tape-vel-rail', 'aria-hidden': 'true' }, [c7VelBar]),
      ]),
      foot([c7PosReadout, h('div', { className: 'hg-foot-btns' }, [c7FlickDown, c7FlickUp])]));

    const c8Metric = metric('4/4 ON', 'Stages switched on. Demo only: tracking ignores this chain.');
    const c8Bay = h('div', {
      className: 'hg-puck-bay', role: 'list', 'aria-label': 'Signal chain stages',
      'data-tip': 'Tap a stage to bypass it; drag it 14 px or more to reorder.',
    });
    const c8OrderReadout = h('span', { className: 'hg-foot-read', textContent: 'CHAIN: GATE → 1€ → PINCH → TWIST', 'data-tip': 'Stage order; brackets mark bypassed stages.' });
    const c8ResetBtn = sm('Reset', { 'data-tip': 'Restore the default order and switch every stage on.' });
    const wbCell08 = instrument('08', 'Signal Chain', '08 Signal chain', 'Demo of the processing stages; reordering does not change tracking.', c8Metric,
      h('div', { className: 'ui-tile-body' }, [c8Bay]),
      foot([c8OrderReadout, c8ResetBtn]));

    const c9Metric = metric('detect 0.04ms', 'Hand-model time per frame; a fixed 0.04 ms in simulated modes.');
    const tuneMinCutoff = h('input', { type: 'range', className: 'ui-slider hg-tuner-range', min: '0.30', max: '3.50', step: '0.05', value: '1.15' });
    const valMinCutoff = h('span', { className: 'ui-readout hg-tuner-val', textContent: '1.15Hz' });
    const tuneBeta = h('input', { type: 'range', className: 'ui-slider hg-tuner-range', min: '0.00', max: '2.00', step: '0.05', value: '0.85' });
    const valBeta = h('span', { className: 'ui-readout hg-tuner-val', textContent: '0.85' });
    const tunePinch = h('input', { type: 'range', className: 'ui-slider hg-tuner-range', min: '0.18', max: '0.34', step: '0.01', value: '0.28' });
    const valPinch = h('span', { className: 'ui-readout hg-tuner-val', textContent: '0.28' });
    const tuneNoise = h('input', { type: 'range', className: 'ui-slider hg-tuner-range', min: '0.000', max: '0.014', step: '0.0005', value: '0.0032' });
    const valNoise = h('span', { className: 'ui-readout hg-tuner-val', textContent: '0.32%' });

    function tunerRow(label, tip, input, val) {
      return h('label', { className: 'hg-tuner-row', 'data-tip': tip }, [h('span', { className: 'ui-label hg-tuner-label', textContent: label }), input, val]);
    }
    const tunerRows = [
      tunerRow('Cutoff', '1€ filter at rest: lower is steadier, higher follows faster.', tuneMinCutoff, valMinCutoff),
      tunerRow('Beta', '1€ filter speed boost: higher drops smoothing sooner on fast moves.', tuneBeta, valBeta),
      tunerRow('Pinch at', 'Finger gap, as a share of palm width, that starts a pinch.', tunePinch, valPinch),
      tunerRow('Jitter', 'Random shake added to the simulated hand, to test the filter.', tuneNoise, valNoise),
    ];

    const teleSpan = h('span', { className: 'ui-readout', textContent: '0.14' });
    const teleNz = h('span', { className: 'ui-readout', textContent: '+0.94' });
    const teleY = h('span', { className: 'ui-readout', textContent: '0.50' });
    const c9ChiralBtn = sm('Chiral: Auto', { 'aria-pressed': 'false' });
    const c9DefaultsBtn = sm('Defaults', { 'data-tip': 'Reset sliders, mapping, dial angle and chirality to their defaults.' });

    function teleKv(label, tip, val) {
      return h('div', { className: 'hg-tele-kv', 'data-tip': tip }, [h('span', { className: 'ui-label', textContent: label }), val]);
    }
    const wbCell09 = instrument('09', 'Tuning', '09 Tuning and gate readings', '', c9Metric,
      h('div', { className: 'ui-tile-body' }, [
        h('div', { className: 'hg-tuner-list' }, tunerRows),
        h('div', { className: 'hg-telemetry-strip' }, [
          teleKv('Span', 'Palm width as a share of the frame; the span gate needs 0.055.', teleSpan),
          teleKv('Facing', 'How squarely the palm faces the camera, -1 to 1; needs 0.22.', teleNz),
          teleKv('Height', 'Palm height in the frame, 0 top to 1 bottom; under 0.86 passes.', teleY),
        ]),
      ]),
      foot([c9ChiralBtn, c9DefaultsBtn]));

    // Map and Chiral labels + tips: one place, called by their handlers and by Defaults.
    function syncMapChiralUi() {
      const isClutch = engine.config.mappingMode === MAPPING_MODE.RELATIVE_CLUTCH;
      setAttr(mapModeBtn, 'aria-pressed', String(isClutch));
      mapModeBtn.textContent = isClutch ? 'Map: Clutch' : 'Map: ROI';
      setAttr(mapModeBtn, 'data-tip', isClutch
        ? 'Clutch: moves like a trackpad, close your fist to lift. Click for ROI.'
        : 'ROI: the middle of the camera view maps to the whole screen. Click for Clutch.');
      const inv = Boolean(engine.config.invertChirality);
      setAttr(c9ChiralBtn, 'aria-pressed', String(inv));
      c9ChiralBtn.textContent = inv ? 'Chiral: Inv' : 'Chiral: Auto';
      setAttr(c9ChiralBtn, 'data-tip', inv
        ? 'Left and right hands are swapped for the facing check. Click for automatic.'
        : 'Swap left and right hands if the facing gate rejects your open palm.');
    }
    syncMapChiralUi();

    const wbCells = [
      wbCell01, wbCell02, wbCell03, wbCell04, wbCell05, wbCell06, wbCell07, wbCell08, wbCell09,
    ];
    const secondaryGrid = h('div', { className: 'grid hg-workbench-grid' }, wbCells);

    const secondaryPage = h('section', {
      id: 'hand-gesture-page',
      className: 'hg-secondary-page',
      hidden: true,
      'aria-label': 'Hand Cursor Studio',
    }, [
      h('header', { className: 'ui-studio-bar hg-studio-bar' }, [
        h('span', { className: 'ui-tile-index', textContent: '08' }),
        h('h2', { className: 'ui-studio-title', textContent: 'Hand Studio' }),
        h('div', { className: 'hg-studio-ctl' }, [
          h('div', { className: 'ui-seg', role: 'group', 'aria-label': 'Hand input' }, [
            modeSynthBtn, modeTourBtn, modeWebcamBtn, modePointerBtn,
          ]),
          mapModeBtn,
        ]),
        h('div', { className: 'hg-gates', role: 'group', 'aria-label': 'Tracking gates' }, [gateSpan, gateFacing, gateKbd, gateArm, gateGesture]),
        h('div', { className: 'ui-studio-actions' }, [fpsReadout, btnToggleKeys, backBtn]),
      ]),
      keysDrawer,
      camBanner,
      secondaryGrid,
    ]);

    mainGrid.parentNode.insertBefore(secondaryPage, mainGrid.nextSibling);

    // -----------------------------------------------------------------------
    // 3. Global Spatial Reticle Overlay (`#hg-spatial-overlay`)
    // -----------------------------------------------------------------------
    const chordLine = svgEl('line', {
      x1: 0, y1: 0, x2: 0, y2: 0,
      stroke: PAL.accent, 'stroke-width': '1.5', 'stroke-dasharray': '4 3', visibility: 'hidden',
    });
    const dragTetherLine = svgEl('line', {
      x1: 0, y1: 0, x2: 0, y2: 0,
      stroke: withAlpha(PAL.accent, 0.55), 'stroke-width': '1.25', 'stroke-dasharray': '2 2', visibility: 'hidden',
    });
    const lockOriginRing = svgEl('circle', {
      cx: 0, cy: 0, r: '14',
      fill: withAlpha(PAL.accent, 0.06), stroke: PAL.accent, 'stroke-width': '1', 'stroke-dasharray': '2 2', visibility: 'hidden',
    });
    const cursorDwellRing = svgEl('circle', {
      cx: '22', cy: '22', r: '16', stroke: PAL.ink, 'stroke-width': '2.2',
      'stroke-linecap': 'round', 'stroke-dasharray': '100.53', 'stroke-dashoffset': '100.53',
      transform: 'rotate(-90 22 22)',
    });
    const cursorCore = svgEl('circle', { cx: '22', cy: '22', r: '3.2', fill: PAL.ink });
    const cursorPrimaryTag = h('span', { className: 'hg-spatial-cursor-tag', textContent: 'ARMED' });
    const cursorPrimary = h('div', { className: 'hg-spatial-cursor' }, [
      svgEl('svg', { width: '44', height: '44', viewBox: '0 0 44 44', fill: 'none' }, [
        svgEl('circle', { cx: '22', cy: '22', r: '16', stroke: PAL.line, 'stroke-width': '1.5' }),
        cursorDwellRing,
        svgEl('path', { d: 'M22 11V17M22 27V33M11 22H17M27 22H33', stroke: PAL.ink, 'stroke-width': '1.4', 'stroke-linecap': 'round' }),
        cursorCore,
      ]),
      cursorPrimaryTag,
    ]);
    const cursorSecondary = h('div', { className: 'hg-spatial-cursor' }, [
      svgEl('svg', { width: '44', height: '44', viewBox: '0 0 44 44', fill: 'none' }, [
        svgEl('circle', { cx: '22', cy: '22', r: '13', stroke: PAL.ink2, 'stroke-width': '1.5', 'stroke-dasharray': '3 2' }),
        svgEl('circle', { cx: '22', cy: '22', r: '3', fill: PAL.ink2 }),
      ]),
      h('span', { className: 'hg-spatial-cursor-tag', textContent: 'H2' }),
    ]);
    const bimanualPill = h('span', { className: 'hg-bimanual-pill', hidden: true, textContent: '1.00× · 0°' });

    const spatialOverlay = h('div', { id: 'hg-spatial-overlay', className: 'hg-spatial-overlay', hidden: true, 'aria-hidden': 'true' }, [
      svgEl('svg', { className: 'hg-spatial-chord' }, [chordLine, dragTetherLine, lockOriginRing]),
      cursorPrimary,
      cursorSecondary,
      bimanualPill,
    ]);
    document.body.appendChild(spatialOverlay);

    // -----------------------------------------------------------------------
    // 4. Workbench State, Canvases & Zero-GC Layout Rect Cache
    // -----------------------------------------------------------------------
    const rigCtx = rigCanvas.getContext('2d', { alpha: true });
    const scopeCtx = scopeCanvas.getContext('2d', { alpha: false });
    const dialCtx = dialCanvas.getContext('2d', { alpha: true });
    const canvasSizes = { rigW: 320, rigH: 200, scopeW: 320, scopeH: 200, dialW: 200, dialH: 160 };

    const c2 = { waypointU: 0.5, waypointV: 0.5, frozen: false, trailU: new Float32Array(56), trailV: new Float32Array(56), trailHead: 0, trailCount: 0 };
    const c3 = { clickCount: 0, lastPadIdx: -1 };
    const c4 = { angleDeg: 0 };
    const c5 = { tx: 0, ty: 0, scale: 1.0, rotDeg: 0, baseScaleOn2H: 1.0, showGuides: true };
    const c6 = { value: 0.68, peak: 0.68, peakHoldFrames: 0 };
    const c7 = { pinnedRow: 0, subPixelScroll: 0, buttonVelPx: 0, displayVelPx: 0 };
    const c8 = { pucks: INITIAL_PUCKS.map(function (p) { return Object.assign({}, p); }) };
    const spatial = {
      hoveredCellIdx: -1, hoveredPadIdx: -1, hoveredPuckIdx: -1, hoveredTunerIdx: -1,
      latchedType: null, latchedCellIdx: -1, latchedSubIdx: -1, latchStartVal: 0,
      vScrollTarget: 'tape',
    };

    let isSecondaryOpen = false;
    let targetOpen = false;
    let vtSeq = 0;
    let savedMainScrollY = 0;
    let enteredFromMainGrid = false;
    let cameraSuspendedByVisibility = false;
    let rafId = 0;
    let lastUiFrameMs = 0;
    let uiFrameCounter = 0;
    let rectsDirty = true;
    let puckEls = [];

    const tapeRowEls = TAPE_SPEC_ITEMS.map(function (pair, i) {
      const row = h('div', {
        id: 'hg-tape-opt-' + i,
        className: 'hg-tape-row' + (i === 0 ? ' is-pinned' : ''),
        dataset: { row: i },
        role: 'option',
        'aria-selected': String(i === 0),
      }, [
        h('span', { className: 'hg-tape-row-key', textContent: pair[0] }),
        h('span', { textContent: pair[1] }),
      ]);
      c7Tape.appendChild(row);
      return row;
    });

    function buildPucksDom() {
      c8Bay.textContent = '';
      puckEls = c8.pucks.map(function (p, i) {
        const card = h('div', {
          className: 'hg-puck-card' + (p.bypassed ? ' is-bypassed' : ''),
          tabindex: '0',
          dataset: { slot: i },
          role: 'listitem',
          'aria-label': p.name + ', slot ' + (i + 1) + ', ' + (p.bypassed ? 'bypassed' : 'active'),
        }, [
          h('div', { className: 'hg-puck-top' }, [
            h('span', { className: 'hg-puck-slot-num', textContent: '0' + (i + 1) }),
            h('span', { className: 'hg-puck-state-dot', textContent: p.bypassed ? 'OFF' : 'ON' }),
          ]),
          h('div', { className: 'hg-puck-name', textContent: p.name }),
          h('div', { className: 'hg-puck-sub', textContent: p.sub }),
        ]);
        c8Bay.appendChild(card);
        return card;
      });
      const onCount = c8.pucks.filter(function (p) { return !p.bypassed; }).length;
      c8Metric.textContent = onCount + '/' + c8.pucks.length + ' ON';
      c8OrderReadout.textContent =
        'CHAIN: ' +
        c8.pucks
          .map(function (p) { return p.bypassed ? '[' + p.code + ']' : p.code; })
          .join(' → ');
      rectsDirty = true;
    }
    buildPucksDom();

    const cellRects = new Float32Array(36);
    const padRects = new Float32Array(36);
    const puckRects = new Float32Array(16);
    const tunerRects = new Float32Array(16);
    const faderRailRect = new Float32Array(4);
    const scopeRect = new Float32Array(4);

    function resizeCanvas(canvas, ctx, wKey, hKey) {
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      const cssW = Math.max(24, Math.round(r.width));
      const cssH = Math.max(24, Math.round(r.height));
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvasSizes[wKey] = cssW;
      canvasSizes[hKey] = cssH;
    }

    function resizeAllCanvases() {
      if (!isSecondaryOpen) return;
      resizeCanvas(rigCanvas, rigCtx, 'rigW', 'rigH');
      resizeCanvas(scopeCanvas, scopeCtx, 'scopeW', 'scopeH');
      resizeCanvas(dialCanvas, dialCtx, 'dialW', 'dialH');
      if (c2.frozen) drawCell02Scope(engine.slots[0], true);
    }

    function writeRect(arr, idx, el) {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const b = idx * 4;
      arr[b] = r.left;
      arr[b + 1] = r.top;
      arr[b + 2] = r.right;
      arr[b + 3] = r.bottom;
    }

    function refreshRectCache() {
      rectsDirty = false;
      if (!isSecondaryOpen) return;
      for (let i = 0; i < 9; i++) {
        writeRect(cellRects, i, wbCells[i]);
        writeRect(padRects, i, c3Pads[i]);
      }
      for (let i = 0; i < 4; i++) {
        writeRect(puckRects, i, puckEls[i]);
        writeRect(tunerRects, i, tunerRows[i]);
      }
      writeRect(faderRailRect, 0, c6Track);
      writeRect(scopeRect, 0, scopeCanvas);
    }

    function hitRectList(arr, count, x, y) {
      for (let i = 0; i < count; i++) {
        const b = i * 4;
        if (x >= arr[b] && x <= arr[b + 2] && y >= arr[b + 1] && y <= arr[b + 3]) return i;
      }
      return -1;
    }

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(function () {
        if (isSecondaryOpen) {
          resizeAllCanvases();
          refreshRectCache();
        }
      });
      ro.observe(secondaryPage);
      wbCells.forEach(function (c) { ro.observe(c); });
    } else {
      global.addEventListener('resize', function () {
        resizeAllCanvases();
        rectsDirty = true;
      });
    }
    global.addEventListener('scroll', function () { rectsDirty = true; }, { passive: true });

    // -----------------------------------------------------------------------
    // 5. RAF Lifecycle (Zero Idle CPU/GPU When Inactive on Main Grid)
    // -----------------------------------------------------------------------
    function shouldRunLoop() {
      if (document.hidden) return false;
      return isSecondaryOpen || tracker.mode === TRACKER_MODE.WEBCAM || tracker.mode === TRACKER_MODE.SYNTH || tracker.mode === TRACKER_MODE.TOUR;
    }

    function ensureLoopState() {
      const active = shouldRunLoop();
      spatialOverlay.hidden = !active;
      if (active && !rafId) {
        tracker.resetClock();
        rafId = requestAnimationFrame(onFrame);
      } else if (!active) {
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
        cursorPrimary.classList.remove('is-visible');
        cursorSecondary.classList.remove('is-visible');
      }
    }

    // Hidden tab: stop the camera (LED off) and the frame loop; resume only what this suspended.
    function suspendCameraForHide() {
      if (!tracker.isCameraActive()) return;
      cameraSuspendedByVisibility = true;
      tracker.setMode(isSecondaryOpen ? TRACKER_MODE.SYNTH : TRACKER_MODE.IDLE);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        suspendCameraForHide();
      } else if (cameraSuspendedByVisibility) {
        cameraSuspendedByVisibility = false;
        tracker.setVideoElement(isSecondaryOpen ? wbVideo : miniVideo);
        tracker.enableWebcam(isSecondaryOpen ? TRACKER_MODE.SYNTH : TRACKER_MODE.IDLE);
      }
      ensureLoopState();
    });

    function resetPortalPreview() {
      drawStaticMiniHand();
      primPosVal.textContent = '0.50, 0.50';
      primPinchVal.textContent = 'OPEN 0.72';
      primRotVal.textContent = '+0.0°';
      primUpDnVal.textContent = 'V-IDLE';
      primPosRow.classList.remove('is-lit');
      primPinchRow.classList.remove('is-lit');
      primRotRow.classList.remove('is-lit');
      primUpDnRow.classList.remove('is-lit');
      setPortalPill('STANDBY', 'idle', PILL_TIP_STANDBY);
    }

    // Any manual rig control while Auto Tour (or Pointer) is driving takes over as Synth Rig, so the
    // mode switch, metric text, and rig pose agree. Clears the tour's leftover pose first.
    function takeManualRigControl() {
      if (tracker.mode === TRACKER_MODE.TOUR || tracker.mode === TRACKER_MODE.POINTER) {
        const wasTour = tracker.mode === TRACKER_MODE.TOUR;
        if (wasTour) synthRig.resetPosture();
        synthRig.autoOrbit = false;
        tracker.setMode(TRACKER_MODE.SYNTH);
      }
      synthRig.autoTour = false;
    }

    // -----------------------------------------------------------------------
    // 6. Widget Helpers & Interactions
    // -----------------------------------------------------------------------
    function toggleMatrixPad(idx, dwellMs, slipPx) {
      if (idx < 0 || idx >= 9) return;
      const pad = c3Pads[idx];
      setAttr(pad, 'aria-pressed', String(pad.getAttribute('aria-pressed') !== 'true'));
      c3.clickCount += 1;
      c3ClickStats.textContent =
        'CLICKS ' + c3.clickCount + ' · DWELL ' + (dwellMs > 0 ? dwellMs + 'ms' : 'PTR') + ' · SLIP ' + slipPx.toFixed(1) + 'px';
    }

    function setDialAngle(deg) {
      c4.angleDeg = clamp(deg, -720, 720);
      const sign = c4.angleDeg >= 0 ? '+' : '';
      const turns = Math.trunc(c4.angleDeg / 360);
      c4Metric.textContent = sign + c4.angleDeg.toFixed(1) + '° · 2.0×';
      setAttr(c4DialWrap, 'aria-valuenow', String(Math.round(c4.angleDeg)));
      setAttr(
        c4DialWrap,
        'aria-valuetext',
        sign + c4.angleDeg.toFixed(1) + '° (' + turns + (Math.abs(turns) === 1 ? ' turn)' : ' turns)')
      );
    }

    function renderStageTransform() {
      c5Card.style.transform =
        'translate3d(' + c5.tx.toFixed(1) + 'px, ' + c5.ty.toFixed(1) + 'px, 0) scale(' + c5.scale.toFixed(3) + ') rotate(' + c5.rotDeg.toFixed(1) + 'deg)';
      c5Metric.textContent = c5.scale.toFixed(2) + '× · ' + (c5.rotDeg >= 0 ? '+' : '') + c5.rotDeg.toFixed(1) + '°';
      c5CardXy.textContent = Math.round(c5.tx) + ', ' + Math.round(c5.ty);
      c5CardSr.textContent = c5.scale.toFixed(2) + '×';
    }

    function resetStage() {
      c5.tx = 0;
      c5.ty = 0;
      c5.scale = 1.0;
      c5.rotDeg = 0;
      renderStageTransform();
    }

    function setFaderValue(val01) {
      const v = clamp(val01, 0, 1);
      c6.value = v;
      if (v >= c6.peak) {
        c6.peak = v;
        c6.peakHoldFrames = 75;
      }
      const pct = v * 100;
      const dbStr = v <= 0.005 ? '-∞ dB' : (20 * Math.log10(v / 0.75)).toFixed(1) + ' dB';
      c6Fill.style.height = pct.toFixed(1) + '%';
      c6Thumb.style.bottom = pct.toFixed(1) + '%';
      c6Peak.style.bottom = (c6.peak * 100).toFixed(1) + '%';
      c6BigPct.textContent = pct.toFixed(1) + '%';
      c6BigDb.textContent = dbStr;
      c6Metric.textContent = pct.toFixed(1) + '% · ' + dbStr;
      setAttr(c6Track, 'aria-valuenow', String(Math.round(pct)));
      setAttr(c6Track, 'aria-valuetext', pct.toFixed(1) + '% (' + dbStr + ')');
    }
    setFaderValue(0.68);

    function updateTapePosReadout() {
      const approxRow = clamp(Math.floor(c7Tape.scrollTop / 25) + 1, 1, TAPE_SPEC_ITEMS.length);
      c7PosReadout.textContent =
        'ROW ' +
        String(approxRow).padStart(2, '0') +
        '/' +
        TAPE_SPEC_ITEMS.length +
        ' · PIN #' +
        String(c7.pinnedRow + 1).padStart(2, '0');
    }

    function pinTapeRow(idx) {
      if (idx < 0 || idx >= tapeRowEls.length) return;
      tapeRowEls[c7.pinnedRow].classList.remove('is-pinned');
      setAttr(tapeRowEls[c7.pinnedRow], 'aria-selected', 'false');
      c7.pinnedRow = idx;
      tapeRowEls[idx].classList.add('is-pinned');
      setAttr(tapeRowEls[idx], 'aria-selected', 'true');
      setAttr(c7Tape, 'aria-activedescendant', 'hg-tape-opt-' + idx);
      updateTapePosReadout();
    }

    function togglePuckBypass(idx) {
      if (idx < 0 || idx >= 4) return;
      c8.pucks[idx].bypassed = !c8.pucks[idx].bypassed;
      buildPucksDom();
    }

    function swapPucks(a, b) {
      const tmp = c8.pucks[a];
      c8.pucks[a] = c8.pucks[b];
      c8.pucks[b] = tmp;
      buildPucksDom();
    }

    function syncRigButtons() {
      setAttr(rigBtnPresent, 'aria-pressed', String(synthRig.handPresent));
      setAttr(rigBtnPinch, 'aria-pressed', String(synthRig.targetPinch > 0.5));
      setAttr(rigBtnVScroll, 'aria-pressed', String(synthRig.targetVScroll > 0.5));
      setAttr(rigBtnDorsal, 'aria-pressed', String(synthRig.targetDorsal > 0.5));
      setAttr(rigBtnDual, 'aria-pressed', String(synthRig.dualHand));
      setAttr(rigBtnOrbit, 'aria-pressed', String(synthRig.autoOrbit));
    }

    tracker.onStatusChange(function (mode, camStatus, camError, delegate) {
      const isLive = mode === TRACKER_MODE.WEBCAM && camStatus === CAMERA_STATUS.STREAMING;
      const camPending = tracker.isWebcamStarting;
      miniVideo.classList.toggle('is-live', isLive && !isSecondaryOpen);
      wbVideo.classList.toggle('is-live', isLive && isSecondaryOpen);

      setAttr(modeSynthBtn, 'aria-pressed', String(!camPending && mode === TRACKER_MODE.SYNTH));
      setAttr(modeTourBtn, 'aria-pressed', String(!camPending && mode === TRACKER_MODE.TOUR));
      setAttr(modeWebcamBtn, 'aria-pressed', String(mode === TRACKER_MODE.WEBCAM || camPending));
      setAttr(modePointerBtn, 'aria-pressed', String(!camPending && mode === TRACKER_MODE.POINTER));

      const mapSuffix = engine.config.mappingMode === MAPPING_MODE.RELATIVE_CLUTCH ? 'CLUTCH' : 'ROI';
      if (camStatus === CAMERA_STATUS.LOADING_MODEL) c1Metric.textContent = 'LOADING MODEL…';
      else if (camStatus === CAMERA_STATUS.REQUESTING_CAM) c1Metric.textContent = 'REQUESTING CAM…';
      else if (isLive) c1Metric.textContent = 'CAM ' + delegate + ' · ' + mapSuffix;
      else if (mode === TRACKER_MODE.TOUR) c1Metric.textContent = 'SIM TOUR · ' + mapSuffix;
      else if (mode === TRACKER_MODE.POINTER) c1Metric.textContent = 'POINTER';
      else c1Metric.textContent = 'SIM · ' + mapSuffix;

      const camBusy = camPending && !camError;
      setAttr(portalCamBtn, 'aria-busy', String(camBusy));
      syncPortalToggles(mode, camBusy, isSecondaryOpen);
      if (camError) {
        camBannerMsg.textContent = camError;
        camBanner.hidden = false;
        setPortalStatus(camError, camError);
      } else if (camPending) {
        camBanner.hidden = true;
        setPortalStatus(camStatus === CAMERA_STATUS.REQUESTING_CAM ? 'Requesting camera…' : 'Loading hand model…', '');
      } else if (isLive) {
        camBanner.hidden = true;
        setPortalStatus('Live webcam (' + delegate + '): hold an open palm still to take the cursor', '');
      } else if (mode === TRACKER_MODE.SYNTH || mode === TRACKER_MODE.TOUR) {
        camBanner.hidden = true;
        setPortalStatus('Simulated hand is driving the cursor across this page', '');
      } else {
        camBanner.hidden = true;
        setPortalStatus(PORTAL_HINT, '');
      }
      if (mode === TRACKER_MODE.IDLE && !isSecondaryOpen) {
        resetPortalPreview();
        // Set after the reset: during a request and after a failure the mode is still IDLE.
        if (camBusy) {
          setPortalPill(
            camStatus === CAMERA_STATUS.REQUESTING_CAM ? 'WAITING' : 'LOADING',
            'attention',
            camStatus === CAMERA_STATUS.REQUESTING_CAM
              ? 'Waiting for camera permission. Press Cam again to cancel.'
              : 'Camera is on; loading the hand-tracking model. Press Cam to cancel.'
          );
        } else if (camError) {
          setPortalPill('NO CAM', 'attention', camError);
        }
      }
      rectsDirty = true;
      syncRigButtons();
      ensureLoopState();
    });

    // Main-grid quick controls
    portalCamBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      cameraSuspendedByVisibility = false;
      if (tracker.isCameraActive()) {
        // Also cancels a pending permission/model request (bumps the session epoch).
        tracker.setMode(TRACKER_MODE.IDLE);
      } else {
        tracker.setVideoElement(miniVideo);
        tracker.enableWebcam(TRACKER_MODE.IDLE);
      }
    });

    portalSimBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (tracker.mode === TRACKER_MODE.SYNTH || tracker.mode === TRACKER_MODE.TOUR) {
        tracker.setMode(TRACKER_MODE.IDLE);
      } else {
        synthRig.resetPosture();
        synthRig.autoOrbit = !prefersReducedMotion();
        tracker.setMode(TRACKER_MODE.SYNTH);
      }
    });

    portalStudioBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openSecondaryView({ fromUserTap: true });
    });

    portalStage.addEventListener('click', function () {
      openSecondaryView({ fromUserTap: true });
    });
    portalStage.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openSecondaryView({ fromUserTap: true });
      }
    });

    // Secondary toolbar & keyboard bindings
    backBtn.addEventListener('click', function () {
      requestCloseSecondaryView();
    });
    modeSynthBtn.addEventListener('click', function () {
      if (tracker.mode === TRACKER_MODE.TOUR) synthRig.resetPosture();
      synthRig.autoOrbit = false;
      tracker.setMode(TRACKER_MODE.SYNTH);
    });
    modeTourBtn.addEventListener('click', function () {
      tracker.setMode(TRACKER_MODE.TOUR);
    });
    modeWebcamBtn.addEventListener('click', function () {
      cameraSuspendedByVisibility = false;
      tracker.setFallbackMode(TRACKER_MODE.SYNTH);
      tracker.setVideoElement(wbVideo);
      tracker.setMode(TRACKER_MODE.WEBCAM);
    });
    modePointerBtn.addEventListener('click', function () {
      tracker.setMode(TRACKER_MODE.POINTER);
    });
    mapModeBtn.addEventListener('click', function () {
      const next =
        engine.config.mappingMode === MAPPING_MODE.ABSOLUTE_ROI
          ? MAPPING_MODE.RELATIVE_CLUTCH
          : MAPPING_MODE.ABSOLUTE_ROI;
      engine.updateConfig({ mappingMode: next });
      syncMapChiralUi();
      tracker.notifyStatus();
    });

    btnToggleKeys.addEventListener('click', function () {
      const open = keysDrawer.hidden;
      keysDrawer.hidden = !open;
      setAttr(btnToggleKeys, 'aria-expanded', String(open));
      rectsDirty = true;
    });
    camBannerDismiss.addEventListener('click', function () {
      camBanner.hidden = true;
      rectsDirty = true;
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (targetOpen) {
          e.preventDefault();
          requestCloseSecondaryView();
          return;
        }
        if (
          !mainGrid.hidden &&
          !document.querySelector('dialog[open]') &&
          (tracker.mode !== TRACKER_MODE.IDLE || tracker.isCameraActive())
        ) {
          e.preventDefault();
          cameraSuspendedByVisibility = false;
          tracker.setMode(TRACKER_MODE.IDLE);
        }
        return;
      }
      if (!isSecondaryOpen) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target && e.target.tagName ? e.target.tagName : '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const k = e.key;
      if (k === '?') { e.preventDefault(); btnToggleKeys.click(); return; }
      if (k === 'c' || k === 'C') {
        e.preventDefault();
        cameraSuspendedByVisibility = false;
        if (tracker.isCameraActive()) {
          tracker.setMode(TRACKER_MODE.SYNTH);
        } else {
          tracker.setFallbackMode(TRACKER_MODE.SYNTH);
          tracker.setVideoElement(wbVideo);
          tracker.enableWebcam(TRACKER_MODE.SYNTH);
        }
        return;
      }
      if ((k === 'p' || k === 'P') && !e.repeat) {
        takeManualRigControl();
        synthRig.targetVScroll = 0;
        synthRig.targetFist = 0;
        synthRig.targetPinch = 1;
        syncRigButtons();
      } else if ((k === 'v' || k === 'V') && !e.repeat) {
        takeManualRigControl();
        synthRig.targetPinch = 0;
        synthRig.targetFist = 0;
        synthRig.targetVScroll = synthRig.targetVScroll > 0.5 ? 0 : 1;
        syncRigButtons();
      } else if ((k === 'g' || k === 'G') && !e.repeat) {
        takeManualRigControl();
        synthRig.targetPinch = 0;
        synthRig.targetVScroll = 0;
        synthRig.targetFist = synthRig.targetFist > 0.5 ? 0 : 1;
      } else if ((k === 'f' || k === 'F') && !e.repeat) {
        takeManualRigControl();
        synthRig.targetDorsal = synthRig.targetDorsal > 0.5 ? 0 : 1;
        syncRigButtons();
      } else if ((k === 'd' || k === 'D') && !e.repeat) {
        takeManualRigControl();
        synthRig.dualHand = !synthRig.dualHand;
        if (!synthRig.dualHand) engine.resetSlot(1);
        syncRigButtons();
      } else if ((k === 'o' || k === 'O') && !e.repeat) {
        takeManualRigControl();
        synthRig.autoOrbit = !synthRig.autoOrbit;
        syncRigButtons();
      } else if (k === '[' || k === ']') {
        e.preventDefault();
        takeManualRigControl();
        const dir = k === ']' ? 1 : -1;
        synthRig.wristRollDeg = clamp(synthRig.wristRollDeg + dir * 6, -85, 85);
        if (synthRig.dualHand) synthRig.dualSteerDeg = clamp(synthRig.dualSteerDeg + dir * 5, -75, 75);
      } else if (k === ' ' && (e.target === document.body || e.target === rigStage)) {
        e.preventDefault();
        takeManualRigControl();
        synthRig.handPresent = !synthRig.handPresent;
        syncRigButtons();
      }
    });

    document.addEventListener('keyup', function (e) {
      if (e.key === 'p' || e.key === 'P') {
        if (synthRig.targetPinch !== 0) {
          synthRig.targetPinch = 0;
          syncRigButtons();
        }
      }
    });

    global.addEventListener('blur', function () {
      rigDrag = false;
      scopeDrag = false;
      dialDrag = false;
      stDrag = false;
      fdDrag = false;
      if (puckDragSlot >= 0) endPuck();
      c5Card.classList.remove('is-manipulating');
      c6Track.classList.remove('is-latched');
      c6LatchBadge.textContent = 'READY';
      c6LatchBadge.classList.remove('is-latched');
      if (synthRig.targetPinch !== 0) {
        synthRig.targetPinch = 0;
        syncRigButtons();
      }
    });

    // Cell 01 interactions
    let rigDrag = false;
    let rigStartRoll = 0;
    let rigStartX = 0;
    rigStage.addEventListener('pointerdown', function (e) {
      if (tracker.mode === TRACKER_MODE.WEBCAM) return;
      takeManualRigControl();
      rigDrag = true;
      safeSetPointerCapture(rigStage, e.pointerId);
      synthRig.autoOrbit = false;
      synthRig.handPresent = true;
      rigStartRoll = synthRig.wristRollDeg;
      rigStartX = e.clientX;
      if (!e.shiftKey && !e.altKey) {
        const r = rigStage.getBoundingClientRect();
        synthRig.mirrorX = clamp((e.clientX - r.left) / r.width, 0.05, 0.95);
        synthRig.camY = clamp((e.clientY - r.top) / r.height, 0.06, 0.95);
      }
      syncRigButtons();
    });
    rigStage.addEventListener('pointermove', function (e) {
      if (!rigDrag || tracker.mode !== TRACKER_MODE.SYNTH) return;
      if (e.shiftKey || e.altKey) {
        synthRig.wristRollDeg = clamp(rigStartRoll + (e.clientX - rigStartX) * 0.65, -85, 85);
      } else {
        const r = rigStage.getBoundingClientRect();
        synthRig.mirrorX = clamp((e.clientX - r.left) / r.width, 0.05, 0.95);
        synthRig.camY = clamp((e.clientY - r.top) / r.height, 0.06, 0.95);
      }
    });
    rigStage.addEventListener('pointerup', function () { rigDrag = false; });
    rigStage.addEventListener('pointercancel', function () { rigDrag = false; });
    rigStage.addEventListener('dblclick', function () {
      if (tracker.mode === TRACKER_MODE.WEBCAM) return;
      takeManualRigControl();
      synthRig.targetPinch = 1;
      syncRigButtons();
      setTimeout(function () {
        synthRig.targetPinch = 0;
        syncRigButtons();
      }, 170);
    });
    rigStage.addEventListener('wheel', function (e) {
      if (tracker.mode === TRACKER_MODE.WEBCAM) return;
      e.preventDefault();
      takeManualRigControl();
      if (synthRig.dualHand && !e.shiftKey) {
        synthRig.dualSpan = clamp(synthRig.dualSpan - e.deltaY * 0.0008, 0.12, 0.56);
      } else {
        synthRig.wristRollDeg = clamp(synthRig.wristRollDeg + e.deltaY * 0.18, -85, 85);
      }
    }, { passive: false });
    rigStage.addEventListener('keydown', function (e) {
      if (tracker.mode === TRACKER_MODE.WEBCAM) return;
      if (e.key.indexOf('Arrow') === 0) takeManualRigControl();
      const s = e.shiftKey ? 0.05 : 0.02;
      if (e.key === 'ArrowLeft') { e.preventDefault(); synthRig.autoOrbit = false; synthRig.mirrorX = clamp(synthRig.mirrorX - s, 0.05, 0.95); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); synthRig.autoOrbit = false; synthRig.mirrorX = clamp(synthRig.mirrorX + s, 0.05, 0.95); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); synthRig.autoOrbit = false; synthRig.camY = clamp(synthRig.camY - s, 0.05, 0.95); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); synthRig.autoOrbit = false; synthRig.camY = clamp(synthRig.camY + s, 0.05, 0.95); }
      else return;
      syncRigButtons();
    });

    rigBtnPresent.addEventListener('click', function () { takeManualRigControl(); synthRig.handPresent = !synthRig.handPresent; syncRigButtons(); });
    let pinchPressTs = 0;
    rigBtnPinch.addEventListener('pointerdown', function (e) {
      takeManualRigControl();
      pinchPressTs = performance.now();
      synthRig.targetVScroll = 0;
      safeSetPointerCapture(rigBtnPinch, e.pointerId);
      if (synthRig.targetPinch < 0.5) { synthRig.targetPinch = 1; syncRigButtons(); }
      else pinchPressTs = -1;
    });
    rigBtnPinch.addEventListener('pointerup', function () {
      if (pinchPressTs === -1 || performance.now() - pinchPressTs > 260) { synthRig.targetPinch = 0; syncRigButtons(); }
    });
    rigBtnPinch.addEventListener('pointercancel', function () {
      synthRig.targetPinch = 0;
      syncRigButtons();
    });
    rigBtnPinch.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); takeManualRigControl(); synthRig.targetPinch = synthRig.targetPinch > 0.5 ? 0 : 1; syncRigButtons(); }
    });
    rigBtnVScroll.addEventListener('click', function () { takeManualRigControl(); synthRig.targetPinch = 0; synthRig.targetVScroll = synthRig.targetVScroll > 0.5 ? 0 : 1; syncRigButtons(); });
    rigBtnDorsal.addEventListener('click', function () { takeManualRigControl(); synthRig.targetDorsal = synthRig.targetDorsal > 0.5 ? 0 : 1; syncRigButtons(); });
    rigBtnDual.addEventListener('click', function () {
      takeManualRigControl();
      synthRig.dualHand = !synthRig.dualHand;
      if (!synthRig.dualHand) engine.resetSlot(1);
      syncRigButtons();
    });
    rigBtnOrbit.addEventListener('click', function () { takeManualRigControl(); synthRig.autoOrbit = !synthRig.autoOrbit; syncRigButtons(); });

    // Cell 02 + Pointer-mode live scope feed
    let scopeDrag = false;
    function feedPointerToScope(u, v) {
      const nowSec = performance.now() * 0.001;
      const sig = synthRig.noiseSigma;
      const rx = clamp(u + (sig > 0 ? synthRig.sampleNoise() * sig * 2.2 : 0), 0, 1);
      const ry = clamp(v + (sig > 0 ? synthRig.sampleNoise() * sig * 2.2 : 0), 0, 1);
      engine.stepPointerSample(rx, ry, nowSec);
    }

    secondaryPage.addEventListener('pointermove', function (e) {
      if (tracker.mode !== TRACKER_MODE.POINTER) return;
      const u = clamp(e.clientX / Math.max(1, global.innerWidth), 0, 1);
      const v = clamp(e.clientY / Math.max(1, global.innerHeight), 0, 1);
      feedPointerToScope(u, v);
    });

    function setWp(e) {
      const r = scopeCanvas.getBoundingClientRect();
      const splitX = r.width * 0.47;
      const lx = e.clientX - r.left;
      if (lx <= splitX) {
        c2.waypointU = clamp((lx - 8) / Math.max(20, splitX - 16), 0, 1);
        c2.waypointV = clamp((e.clientY - r.top - 8) / Math.max(20, r.height - 16), 0, 1);
        if (tracker.mode === TRACKER_MODE.POINTER) {
          feedPointerToScope(c2.waypointU, c2.waypointV);
        }
      }
    }
    scopeCanvas.addEventListener('pointerdown', function (e) { scopeDrag = true; safeSetPointerCapture(scopeCanvas, e.pointerId); setWp(e); });
    scopeCanvas.addEventListener('pointermove', function (e) { if (scopeDrag) setWp(e); });
    scopeCanvas.addEventListener('pointerup', function () { scopeDrag = false; });
    scopeCanvas.addEventListener('pointercancel', function () { scopeDrag = false; });
    scopeCanvas.addEventListener('keydown', function (e) {
      if (e.key === ' ') { e.preventDefault(); c2FreezeBtn.click(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); c2.waypointU = clamp(c2.waypointU - 0.04, 0, 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); c2.waypointU = clamp(c2.waypointU + 0.04, 0, 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); c2.waypointV = clamp(c2.waypointV - 0.04, 0, 1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); c2.waypointV = clamp(c2.waypointV + 0.04, 0, 1); }
    });
    c2FreezeBtn.addEventListener('click', function () {
      c2.frozen = !c2.frozen;
      setAttr(c2FreezeBtn, 'aria-pressed', String(c2.frozen));
    });

    // Cell 03
    c3Pads.forEach(function (pad, idx) {
      pad.addEventListener('click', function () { toggleMatrixPad(idx, 0, 0); });
    });
    c3ClearBtn.addEventListener('click', function () {
      c3Pads.forEach(function (p) { setAttr(p, 'aria-pressed', 'false'); });
      c3.clickCount = 0;
      c3ClickStats.textContent = 'CLICKS 0 · DWELL — · SLIP 0.0px';
    });

    // Cell 04
    let dialDrag = false;
    let dialLastY = 0;
    c4DialWrap.addEventListener('pointerdown', function (e) { dialDrag = true; dialLastY = e.clientY; safeSetPointerCapture(c4DialWrap, e.pointerId); });
    c4DialWrap.addEventListener('pointermove', function (e) {
      if (!dialDrag) return;
      setDialAngle(c4.angleDeg + (dialLastY - e.clientY) * 1.4);
      dialLastY = e.clientY;
    });
    c4DialWrap.addEventListener('pointerup', function () { dialDrag = false; });
    c4DialWrap.addEventListener('pointercancel', function () { dialDrag = false; });
    c4DialWrap.addEventListener('wheel', function (e) { e.preventDefault(); setDialAngle(c4.angleDeg - e.deltaY * 0.35); }, { passive: false });
    c4DialWrap.addEventListener('keydown', function (e) {
      const s = e.shiftKey ? 15 : 5;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setDialAngle(c4.angleDeg + s); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setDialAngle(c4.angleDeg - s); }
      else if (e.key === 'Home' || e.key === '0') { e.preventDefault(); setDialAngle(0); }
    });
    c4VecBtn.addEventListener('click', function () {
      const cur = engine.config.rotationSource;
      const next =
        cur === ROTATION_SOURCE.FUSED
          ? ROTATION_SOURCE.KNUCKLE_BAR
          : cur === ROTATION_SOURCE.KNUCKLE_BAR
            ? ROTATION_SOURCE.WRIST_LEVER
            : ROTATION_SOURCE.FUSED;
      engine.updateConfig({ rotationSource: next });
      syncRotationSourceUi();
    });
    c4ZeroBtn.addEventListener('click', function () { setDialAngle(0); });

    // Cell 05
    let stDrag = false;
    let stX = 0;
    let stY = 0;
    c5Viewport.addEventListener('pointerdown', function (e) {
      stDrag = true;
      stX = e.clientX;
      stY = e.clientY;
      safeSetPointerCapture(c5Viewport, e.pointerId);
      c5Card.classList.add('is-manipulating');
    });
    c5Viewport.addEventListener('pointermove', function (e) {
      if (!stDrag) return;
      const dx = e.clientX - stX;
      const dy = e.clientY - stY;
      stX = e.clientX;
      stY = e.clientY;
      if (e.altKey || e.shiftKey) c5.rotDeg += dx * 0.7;
      else {
        c5.tx = clamp(c5.tx + dx, -110, 110);
        c5.ty = clamp(c5.ty + dy, -80, 80);
      }
      renderStageTransform();
    });
    const endSt = function () { stDrag = false; c5Card.classList.remove('is-manipulating'); };
    c5Viewport.addEventListener('pointerup', endSt);
    c5Viewport.addEventListener('pointercancel', endSt);
    c5Viewport.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (e.shiftKey) c5.rotDeg += e.deltaY * 0.25;
      else c5.scale = clamp(c5.scale * Math.exp(-e.deltaY * 0.002), 0.40, 2.80);
      renderStageTransform();
    }, { passive: false });
    c5Viewport.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); c5.tx = clamp(c5.tx - 6, -110, 110); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); c5.tx = clamp(c5.tx + 6, -110, 110); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); c5.ty = clamp(c5.ty - 6, -80, 80); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); c5.ty = clamp(c5.ty + 6, -80, 80); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); c5.scale = clamp(c5.scale + 0.08, 0.40, 2.80); }
      else if (e.key === '-') { e.preventDefault(); c5.scale = clamp(c5.scale - 0.08, 0.40, 2.80); }
      else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); resetStage(); return; }
      else return;
      renderStageTransform();
    });
    c5ResetBtn.addEventListener('click', resetStage);

    // Cell 06
    let fdDrag = false;
    function setFdY(cy) {
      const r = c6Track.getBoundingClientRect();
      setFaderValue(clamp(1 - (cy - (r.top + 8)) / Math.max(24, r.height - 16), 0, 1));
    }
    c6Track.addEventListener('pointerdown', function (e) {
      fdDrag = true;
      safeSetPointerCapture(c6Track, e.pointerId);
      c6Track.classList.add('is-latched');
      c6LatchBadge.textContent = 'PTR LATCH';
      c6LatchBadge.classList.add('is-latched');
      setFdY(e.clientY);
    });
    c6Track.addEventListener('pointermove', function (e) { if (fdDrag) setFdY(e.clientY); });
    const endFd = function () {
      fdDrag = false;
      c6Track.classList.remove('is-latched');
      c6LatchBadge.textContent = 'READY';
      c6LatchBadge.classList.remove('is-latched');
    };
    c6Track.addEventListener('pointerup', endFd);
    c6Track.addEventListener('pointercancel', endFd);
    c6FaderArea.addEventListener('wheel', function (e) { e.preventDefault(); setFaderValue(clamp(c6.value - e.deltaY * 0.0012, 0, 1)); }, { passive: false });
    c6Track.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp') { e.preventDefault(); setFaderValue(clamp(c6.value + 0.02, 0, 1)); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setFaderValue(clamp(c6.value - 0.02, 0, 1)); }
      else if (e.key === 'PageUp') { e.preventDefault(); setFaderValue(clamp(c6.value + 0.10, 0, 1)); }
      else if (e.key === 'PageDown') { e.preventDefault(); setFaderValue(clamp(c6.value - 0.10, 0, 1)); }
      else if (e.key === 'Home') { e.preventDefault(); setFaderValue(0); }
      else if (e.key === 'End') { e.preventDefault(); setFaderValue(1); }
    });
    c6UnityBtn.addEventListener('click', function () { setFaderValue(0.75); });

    // Cell 07
    c7Tape.addEventListener('click', function (e) {
      const row = e.target.closest('.hg-tape-row');
      if (row) pinTapeRow(Number(row.dataset.row));
    });
    c7Tape.addEventListener('scroll', updateTapePosReadout, { passive: true });
    c7Tape.addEventListener('keydown', function (e) {
      let next = c7.pinnedRow;
      if (e.key === 'ArrowDown') next = Math.min(tapeRowEls.length - 1, c7.pinnedRow + 1);
      else if (e.key === 'ArrowUp') next = Math.max(0, c7.pinnedRow - 1);
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tapeRowEls.length - 1;
      else return;
      e.preventDefault();
      pinTapeRow(next);
      if (tapeRowEls[next] && typeof tapeRowEls[next].scrollIntoView === 'function') {
        tapeRowEls[next].scrollIntoView({ block: 'nearest' });
      }
      updateTapePosReadout();
    });
    c7FlickDown.addEventListener('click', function () { c7.buttonVelPx += 620; });
    c7FlickUp.addEventListener('click', function () { c7.buttonVelPx -= 620; });

    // Cell 08
    let puckDragSlot = -1;
    let puckSx = 0;
    let puckSy = 0;
    let puckBroken = false;
    c8Bay.addEventListener('pointerdown', function (e) {
      const card = e.target.closest('.hg-puck-card');
      if (!card) return;
      puckDragSlot = Number(card.dataset.slot);
      puckSx = e.clientX;
      puckSy = e.clientY;
      puckBroken = false;
      safeSetPointerCapture(c8Bay, e.pointerId);
    });
    c8Bay.addEventListener('pointermove', function (e) {
      if (puckDragSlot < 0) return;
      const dx = e.clientX - puckSx;
      const dy = e.clientY - puckSy;
      if (!puckBroken && Math.hypot(dx, dy) >= 14) {
        puckBroken = true;
        puckEls[puckDragSlot].classList.add('is-dragging');
      }
      if (puckBroken) {
        puckEls[puckDragSlot].style.transform = 'translate3d(' + dx.toFixed(1) + 'px, ' + dy.toFixed(1) + 'px, 0) scale(1.03)';
        const over = hitRectList(puckRects, 4, e.clientX, e.clientY);
        if (over >= 0 && over !== puckDragSlot) {
          swapPucks(puckDragSlot, over);
          puckDragSlot = over;
          puckSx = e.clientX;
          puckSy = e.clientY;
          puckEls[puckDragSlot].classList.add('is-dragging');
        }
      }
    });
    const endPuck = function () {
      if (puckDragSlot < 0) return;
      if (!puckBroken) togglePuckBypass(puckDragSlot);
      else if (puckEls[puckDragSlot]) {
        puckEls[puckDragSlot].style.transform = '';
        puckEls[puckDragSlot].classList.remove('is-dragging');
      }
      puckDragSlot = -1;
      puckBroken = false;
    };
    c8Bay.addEventListener('pointerup', endPuck);
    c8Bay.addEventListener('pointercancel', endPuck);
    c8Bay.addEventListener('keydown', function (e) {
      const card = e.target.closest('.hg-puck-card');
      if (!card) return;
      const idx = Number(card.dataset.slot);
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePuckBypass(idx); puckEls[idx].focus(); }
      else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowDown')) { e.preventDefault(); const n = (idx + 1) % 4; swapPucks(idx, n); puckEls[n].focus(); }
      else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowUp')) { e.preventDefault(); const p = (idx + 3) % 4; swapPucks(idx, p); puckEls[p].focus(); }
    });
    c8ResetBtn.addEventListener('click', function () {
      c8.pucks = INITIAL_PUCKS.map(function (p) { return Object.assign({}, p); });
      buildPucksDom();
    });

    // Cell 09
    tuneMinCutoff.addEventListener('input', function () {
      const v = Number(tuneMinCutoff.value);
      engine.updateConfig({ minCutoff: v });
      valMinCutoff.textContent = v.toFixed(2) + 'Hz';
    });
    tuneBeta.addEventListener('input', function () {
      const v = Number(tuneBeta.value);
      engine.updateConfig({ beta: v });
      valBeta.textContent = v.toFixed(2);
    });
    function syncSchmittMarks() {
      const eng = engine.config.pinchEngage;
      const rel = engine.config.pinchRelease;
      c3MarkEngage.style.left = ((eng / 0.80) * 100).toFixed(2) + '%';
      c3MarkRelease.style.left = ((rel / 0.80) * 100).toFixed(2) + '%';
      c3LabelEngage.textContent = 'ENG <' + eng.toFixed(2).replace(/^0/, '');
      c3LabelRelease.textContent = 'REL >' + rel.toFixed(2).replace(/^0/, '');
    }

    function syncRotationSourceUi() {
      const src = engine.config.rotationSource;
      c4VecBtn.textContent = src === ROTATION_SOURCE.FUSED ? 'Angle: Fused' : src === ROTATION_SOURCE.KNUCKLE_BAR ? 'Angle: Knuckles' : 'Angle: Wrist';
      c4DzStatus.textContent = src === ROTATION_SOURCE.FUSED ? 'DEAD ZONE ±3.5° · FUSED' : src === ROTATION_SOURCE.KNUCKLE_BAR ? 'DEAD ZONE ±3.5° · KNUCKLES' : 'DEAD ZONE ±3.5° · WRIST';
    }

    tunePinch.addEventListener('input', function () {
      const v = Number(tunePinch.value);
      const rel = Number(Math.max(v + 0.10, 0.40).toFixed(2));
      engine.updateConfig({ pinchEngage: v, pinchRelease: rel });
      valPinch.textContent = v.toFixed(2);
      syncSchmittMarks();
    });
    tuneNoise.addEventListener('input', function () {
      const v = Number(tuneNoise.value);
      synthRig.noiseSigma = v;
      valNoise.textContent = (v * 100).toFixed(2) + '%';
    });
    c9ChiralBtn.addEventListener('click', function () {
      const next = !engine.config.invertChirality;
      engine.updateConfig({ invertChirality: next });
      syncMapChiralUi();
    });
    c9DefaultsBtn.addEventListener('click', function () {
      engine.updateConfig(DEFAULT_CONFIG);
      synthRig.noiseSigma = 0.0032;
      tuneMinCutoff.value = String(DEFAULT_CONFIG.minCutoff);
      valMinCutoff.textContent = DEFAULT_CONFIG.minCutoff.toFixed(2) + 'Hz';
      tuneBeta.value = String(DEFAULT_CONFIG.beta);
      valBeta.textContent = DEFAULT_CONFIG.beta.toFixed(2);
      tunePinch.value = String(DEFAULT_CONFIG.pinchEngage);
      valPinch.textContent = DEFAULT_CONFIG.pinchEngage.toFixed(2);
      tuneNoise.value = '0.0032';
      valNoise.textContent = '0.32%';
      syncMapChiralUi();
      syncSchmittMarks();
      syncRotationSourceUi();
      tracker.notifyStatus();
    });

    // -----------------------------------------------------------------------
    // 7. 60fps Render & Spatial Gesture Dispatch (Main Grid + Secondary Studio)
    // -----------------------------------------------------------------------
    function onFrame(nowMs) {
      rafId = 0;
      if (!shouldRunLoop()) {
        return;
      }
      if (rectsDirty) refreshRectCache();

      const safeNowMs = Number.isFinite(nowMs) ? nowMs : lastUiFrameMs + 16.67;
      let uiDtSec = lastUiFrameMs > 0 ? (safeNowMs - lastUiFrameMs) * 0.001 : 1 / 60;
      if (!Number.isFinite(uiDtSec) || uiDtSec <= 1e-5) uiDtSec = 1 / 120;
      else if (uiDtSec > 0.25) uiDtSec = 0.25;
      lastUiFrameMs = safeNowMs;

      const events = tracker.tick(safeNowMs, global.innerWidth, global.innerHeight);
      const s0 = engine.slots[0];
      const s1 = engine.slots[1];

      if (isSecondaryOpen) {
        if (c6.peakHoldFrames > 0) c6.peakHoldFrames--;
        else if (c6.peak > c6.value) {
          c6.peak = Math.max(c6.value, c6.peak - 0.004);
          c6Peak.style.bottom = (c6.peak * 100).toFixed(1) + '%';
        }
        dispatchSecondaryGestures(s0, s1, events, uiDtSec);
        drawCell01Rig(s0, s1);
        drawCell02Scope(s0);
        drawCell04Dial(s0);
      } else {
        dispatchMainGridGestures(s0, events);
        updatePortalPreview(s0, events);
      }

      updateSpatialReticle(s0, s1, events);

      uiFrameCounter = (uiFrameCounter + 1) & 1;
      if (uiFrameCounter === 0 && isSecondaryOpen) {
        updateSecondaryReadouts(s0, events);
      }

      if (shouldRunLoop() && !rafId) {
        rafId = requestAnimationFrame(onFrame);
      }
    }

    function dispatchMainGridGestures(s0, events) {
      if (mainGrid.hidden || document.querySelector('dialog[open]')) return;
      const isArmed = s0.state === HAND_STATE.ARMED || s0.state === HAND_STATE.COASTING;
      if (!isArmed) return;
      if (Math.abs(events.scrollDeltaPx) > 0.25) {
        global.scrollBy(0, events.scrollDeltaPx);
      }
      if (events.clickFired && Number.isFinite(events.clickX) && Number.isFinite(events.clickY)) {
        const maxX = Math.max(0, (global.innerWidth || 1) - 1);
        const maxY = Math.max(0, (global.innerHeight || 1) - 1);
        const cx = clamp(events.clickX, 0, maxX);
        const cy = clamp(events.clickY, 0, maxY);
        const el = document.elementFromPoint(cx, cy);
        if (el) {
          const btn = el.closest('button, a, [role="button"], input');
          if (
            btn &&
            btn !== portalStage &&
            !btn.disabled &&
            btn.getAttribute('aria-disabled') !== 'true'
          ) {
            btn.click();
          }
        }
      }
    }

    function updatePortalPreview(s0, events) {
      if (s0.visible) {
        const lm = s0.normLm;
        for (let i = 0; i < HAND_BONES.length; i += 2) {
          const a = HAND_BONES[i] * 3;
          const b = HAND_BONES[i + 1] * 3;
          const line = miniBoneLines[i >> 1];
          setAttr(line, 'x1', ((1 - lm[a]) * 120).toFixed(1));
          setAttr(line, 'y1', (lm[a + 1] * 90).toFixed(1));
          setAttr(line, 'x2', ((1 - lm[b]) * 120).toFixed(1));
          setAttr(line, 'y2', (lm[b + 1] * 90).toFixed(1));
          setAttr(line, 'stroke', s0.gateFacingOk ? PAL.ink2 : PAL.accent);
        }
        setAttr(miniPinchLine, 'x1', ((1 - lm[LM.THUMB_TIP * 3]) * 120).toFixed(1));
        setAttr(miniPinchLine, 'y1', (lm[LM.THUMB_TIP * 3 + 1] * 90).toFixed(1));
        setAttr(miniPinchLine, 'x2', ((1 - lm[LM.INDEX_TIP * 3]) * 120).toFixed(1));
        setAttr(miniPinchLine, 'y2', (lm[LM.INDEX_TIP * 3 + 1] * 90).toFixed(1));
        setAttr(miniPinchLine, 'stroke', s0.pinched ? PAL.accent : PAL.ink3);
        setAttr(miniPinchLine, 'stroke-dasharray', s0.pinched ? 'none' : '3 3');
        setAttr(miniAnchorDot, 'cx', ((1 - s0.anchorCamX) * 120).toFixed(1));
        setAttr(miniAnchorDot, 'cy', (s0.anchorCamY * 90).toFixed(1));
        setAttr(miniAnchorRing, 'cx', ((1 - s0.anchorCamX) * 120).toFixed(1));
        setAttr(miniAnchorRing, 'cy', (s0.anchorCamY * 90).toFixed(1));
      }

      primPosVal.textContent = s0.cursorU.toFixed(2) + ', ' + s0.cursorV.toFixed(2);
      primPinchVal.textContent = (s0.pinched ? 'LOCK ' : 'OPEN ') + s0.pinchRatio.toFixed(2);
      primRotVal.textContent = (s0.twistTotalDeg >= 0 ? '+' : '') + s0.twistTotalDeg.toFixed(1) + '°';
      primUpDnVal.textContent = s0.vScrollActive ? ('V ' + Math.round(events.scrollVelocityPx)) : 'V-IDLE';

      primPosRow.classList.toggle('is-lit', s0.state === HAND_STATE.ARMED);
      primPinchRow.classList.toggle('is-lit', s0.pinched);
      primRotRow.classList.toggle('is-lit', s0.twistBrokenOut);
      primUpDnRow.classList.toggle('is-lit', s0.vScrollActive);

      const sim = tracker.mode !== TRACKER_MODE.WEBCAM;
      if (s0.state === HAND_STATE.ARMED) {
        if (s0.pinched) setPortalPill('PINCHED', 'attention', 'Pinch held: a click or drag is in progress.');
        else setPortalPill('ARMED', 'attention', sim ? 'The simulated hand controls the cursor and can click.' : 'Your hand controls the cursor. Pinch to click.');
      } else if (s0.state === HAND_STATE.ARMING) {
        setPortalPill('ARMING', 'attention', 'Open palm seen; hold still for 0.2 s to take the cursor.');
      } else if (s0.state === HAND_STATE.COASTING) {
        setPortalPill('COAST', 'attention', 'Hand lost for a moment; the cursor holds for a few frames.');
      } else {
        setPortalPill('IDLE', 'idle', sim ? 'Simulated cursor is on but not armed yet.' : 'Camera is on. Hold an open palm still to take the cursor.');
      }
    }

    function setHighlightedCell(cellIdx, isLatched) {
      if (spatial.hoveredCellIdx !== cellIdx) {
        if (spatial.hoveredCellIdx >= 0) {
          wbCells[spatial.hoveredCellIdx].classList.remove('is-spatial-hover', 'is-spatial-latched');
        }
        spatial.hoveredCellIdx = cellIdx;
      }
      if (cellIdx >= 0) {
        wbCells[cellIdx].classList.toggle('is-spatial-hover', !isLatched);
        wbCells[cellIdx].classList.toggle('is-spatial-latched', isLatched);
      }
    }

    function dispatchSecondaryGestures(s0, s1, events, uiDtSec) {
      const isArmed = s0.state === HAND_STATE.ARMED || s0.state === HAND_STATE.COASTING;
      const cx = s0.interactiveX;
      const cy = s0.interactiveY;

      const decay = clamp(engine.config.vScrollDecay, 0, 0.999);
      c7.buttonVelPx *= Math.pow(decay, uiDtSec * 60);
      if (!Number.isFinite(c7.buttonVelPx) || Math.abs(c7.buttonVelPx) < 0.8) {
        c7.buttonVelPx = 0;
      }
      const buttonDeltaPx = c7.buttonVelPx * uiDtSec;

      if (events.twoHandJustEnded && spatial.latchedType !== 'c5-stage') {
        c5Card.classList.remove('is-manipulating');
      }

      if (events.twoHandActive) {
        if (events.twoHandJustStarted) {
          c5.baseScaleOn2H = c5.scale;
          c5Card.classList.add('is-manipulating');
        }
        c5.scale = clamp(c5.baseScaleOn2H * events.twoHandScaleRatio, 0.40, 2.80);
        c5.rotDeg += events.twoHandDeltaDeg;
        renderStageTransform();
        setHighlightedCell(4, true);
        if (Math.abs(c7.buttonVelPx) > 0) {
          c7.displayVelPx = c7.buttonVelPx;
          c7.subPixelScroll += buttonDeltaPx;
          const whole = Math.trunc(c7.subPixelScroll);
          if (whole !== 0) {
            c7Tape.scrollTop += whole;
            c7.subPixelScroll -= whole;
          }
        } else {
          c7.displayVelPx = 0;
        }
        return;
      }

      const hitCell = isArmed ? hitRectList(cellRects, 9, cx, cy) : -1;

      const nextPad = isArmed && hitCell === 2 ? hitRectList(padRects, 9, cx, cy) : -1;
      if (spatial.hoveredPadIdx !== nextPad) {
        if (spatial.hoveredPadIdx >= 0) c3Pads[spatial.hoveredPadIdx].classList.remove('is-spatial-target', 'is-locking');
        if (nextPad >= 0) c3Pads[nextPad].classList.add('is-spatial-target');
        spatial.hoveredPadIdx = nextPad;
      }
      if (nextPad >= 0) c3Pads[nextPad].classList.toggle('is-locking', s0.pinchMode === PINCH_MODE.CLICK_LOCK);

      const nextPuck = isArmed && hitCell === 7 && !spatial.latchedType ? hitRectList(puckRects, 4, cx, cy) : -1;
      if (spatial.hoveredPuckIdx !== nextPuck) {
        if (spatial.hoveredPuckIdx >= 0 && puckEls[spatial.hoveredPuckIdx]) puckEls[spatial.hoveredPuckIdx].classList.remove('is-spatial-target');
        if (nextPuck >= 0 && puckEls[nextPuck]) puckEls[nextPuck].classList.add('is-spatial-target');
        spatial.hoveredPuckIdx = nextPuck;
      }

      const nextTuner = isArmed && hitCell === 8 && !spatial.latchedType ? hitRectList(tunerRects, 4, cx, cy) : -1;
      if (spatial.hoveredTunerIdx !== nextTuner) {
        if (spatial.hoveredTunerIdx >= 0) tunerRows[spatial.hoveredTunerIdx].classList.remove('is-spatial-target');
        if (nextTuner >= 0) tunerRows[nextTuner].classList.add('is-spatial-target');
        spatial.hoveredTunerIdx = nextTuner;
      }

      // Separate hand V-Scroll target (`fader` when V-peace starts over Cell 06 vs `tape`) from Cell 07 button momentum
      if (s0.vScrollActive) {
        spatial.vScrollTarget = hitCell === 5 ? 'fader' : 'tape';
      } else if (Math.abs(events.scrollVelocityPx) < 0.8) {
        spatial.vScrollTarget = 'tape';
      }

      if (spatial.vScrollTarget === 'fader' && Math.abs(events.scrollDeltaPx) > 0.02) {
        setFaderValue(clamp(c6.value - events.scrollDeltaPx * 0.0018, 0, 1));
      }

      const handTapeVel = spatial.vScrollTarget === 'fader' ? 0 : events.scrollVelocityPx;
      const handTapeDelta = spatial.vScrollTarget === 'fader' ? 0 : events.scrollDeltaPx;
      const totalTapeVel = handTapeVel + c7.buttonVelPx;
      const totalTapeDelta = handTapeDelta + buttonDeltaPx;
      c7.displayVelPx = totalTapeVel;

      // Detent runs first below 18 px/s; momentum scroll runs above 18 px/s or during active V-Scroll
      if (!(s0.vScrollActive && spatial.vScrollTarget === 'tape') && Math.abs(totalTapeVel) > 0 && Math.abs(totalTapeVel) < 18) {
        const targetTop = Math.round(c7Tape.scrollTop / 25) * 25;
        const gap = targetTop - c7Tape.scrollTop;
        c7Tape.scrollTop += Math.abs(gap) <= 1.5 ? gap : gap * 0.22;
        c7.subPixelScroll = 0;
      } else if (Math.abs(totalTapeDelta) > 0.02) {
        c7.subPixelScroll += totalTapeDelta;
        const whole = Math.trunc(c7.subPixelScroll);
        if (whole !== 0) {
          c7Tape.scrollTop += whole;
          c7.subPixelScroll -= whole;
        }
      }

      if (events.pinchStart && isArmed) {
        spatial.latchedCellIdx = hitCell;
        if (hitCell === 1) spatial.latchedType = 'c2-locus';
        else if (hitCell === 2) { spatial.latchedType = 'c3-pad'; spatial.latchedSubIdx = nextPad; }
        else if (hitCell === 3) { spatial.latchedType = 'c4-dial'; spatial.latchStartVal = c4.angleDeg; }
        else if (hitCell === 4) { spatial.latchedType = 'c5-stage'; c5Card.classList.add('is-manipulating'); }
        else if (hitCell === 5) {
          spatial.latchedType = 'c6-fader';
          spatial.latchStartVal = c6.value;
          c6Track.classList.add('is-latched');
          c6LatchBadge.textContent = 'PINCH LATCH';
          c6LatchBadge.classList.add('is-latched');
        } else if (hitCell === 6) spatial.latchedType = 'c7-tape';
        else if (hitCell === 7 && nextPuck >= 0) { spatial.latchedType = 'c8-puck'; spatial.latchedSubIdx = nextPuck; }
        else if (hitCell === 8 && nextTuner >= 0) {
          spatial.latchedType = 'c9-tuner';
          spatial.latchedSubIdx = nextTuner;
          spatial.latchStartVal = Number(tunerRows[nextTuner].querySelector('input').value);
        } else spatial.latchedType = 'generic';
      }

      if (s0.pinched && spatial.latchedType) {
        const lt = spatial.latchedType;
        if (lt === 'c2-locus') {
          c2.waypointU = clamp((cx - scopeRect[0] - 8) / Math.max(20, (scopeRect[2] - scopeRect[0]) * 0.47 - 16), 0, 1);
          c2.waypointV = clamp((cy - scopeRect[1] - 8) / Math.max(20, scopeRect[3] - scopeRect[1] - 16), 0, 1);
        } else if (lt === 'c3-pad' && s0.pinchMode === PINCH_MODE.DRAG) {
          const overPad = hitRectList(padRects, 9, cx, cy);
          if (overPad >= 0 && overPad !== c3.lastPadIdx) {
            c3.lastPadIdx = overPad;
            setAttr(c3Pads[overPad], 'aria-pressed', 'true');
          }
        } else if (lt === 'c4-dial') {
          if (Math.abs(s0.twistDeltaDeg) > 0.001) setDialAngle(c4.angleDeg + s0.twistDeltaDeg);
          else if (s0.pinchMode === PINCH_MODE.DRAG) setDialAngle(c4.angleDeg - events.dragDeltaY * 1.1);
        } else if (lt === 'c5-stage') {
          if (s0.pinchMode === PINCH_MODE.DRAG) {
            c5.tx = clamp(c5.tx + events.dragDeltaX, -110, 110);
            c5.ty = clamp(c5.ty + events.dragDeltaY, -80, 80);
          }
          if (Math.abs(s0.twistDeltaDeg) > 0.001) c5.rotDeg += s0.twistDeltaDeg;
          renderStageTransform();
        } else if (lt === 'c6-fader') {
          const railH = Math.max(60, faderRailRect[3] - faderRailRect[1] - 16);
          setFaderValue(clamp(spatial.latchStartVal + (s0.lockOriginY - s0.screenY) / railH, 0, 1));
        } else if (lt === 'c7-tape' && s0.pinchMode === PINCH_MODE.DRAG) {
          c7Tape.scrollTop -= events.dragDeltaY * 1.3;
        } else if (lt === 'c8-puck') {
          const slot = spatial.latchedSubIdx;
          if (s0.pinchMode === PINCH_MODE.DRAG && slot >= 0 && puckEls[slot]) {
            if (events.pinchDragStart) puckEls[slot].classList.add('is-dragging');
            puckEls[slot].style.transform = 'translate3d(' + (cx - s0.lockOriginX).toFixed(1) + 'px, ' + (cy - s0.lockOriginY).toFixed(1) + 'px, 0) scale(1.03)';
            const overSlot = hitRectList(puckRects, 4, cx, cy);
            if (overSlot >= 0 && overSlot !== slot) {
              swapPucks(slot, overSlot);
              spatial.latchedSubIdx = overSlot;
              engine.reanchorLockOrigin(0, cx, cy);
              puckEls[overSlot].classList.add('is-dragging');
            }
          }
        } else if (lt === 'c9-tuner') {
          const idx = spatial.latchedSubIdx;
          const inp = tunerRows[idx].querySelector('input');
          const min = Number(inp.min);
          const max = Number(inp.max);
          const step = Number(inp.step);
          const rowW = Math.max(60, (tunerRects[idx * 4 + 2] - tunerRects[idx * 4]) * 0.6);
          const rawNext = clamp(spatial.latchStartVal + ((s0.screenX - s0.lockOriginX) / rowW) * (max - min), min, max);
          inp.value = String(Math.round(rawNext / step) * step);
          inp.dispatchEvent(new Event('input'));
        }
      }

      if (events.pinchRelease) {
        const lt = spatial.latchedType;
        if (lt === 'c5-stage') c5Card.classList.remove('is-manipulating');
        else if (lt === 'c6-fader') {
          c6Track.classList.remove('is-latched');
          c6LatchBadge.textContent = 'READY';
          c6LatchBadge.classList.remove('is-latched');
        } else if (lt === 'c8-puck' && spatial.latchedSubIdx >= 0 && puckEls[spatial.latchedSubIdx]) {
          puckEls[spatial.latchedSubIdx].style.transform = '';
          puckEls[spatial.latchedSubIdx].classList.remove('is-dragging');
        }
        c3.lastPadIdx = -1;
        if (events.clickFired && Number.isFinite(events.clickX) && Number.isFinite(events.clickY)) {
          handleSecondaryClick(events.clickX, events.clickY, events.clickDwellMs, events.clickSlipPx, lt, spatial.latchedSubIdx);
        }
        spatial.latchedType = null;
        spatial.latchedCellIdx = -1;
        spatial.latchedSubIdx = -1;
      }

      const activeCell = spatial.latchedCellIdx >= 0 ? spatial.latchedCellIdx : hitCell;
      setHighlightedCell(activeCell, spatial.latchedCellIdx >= 0);
    }

    function handleSecondaryClick(x, y, dwellMs, slipPx, lt, subIdx) {
      if (lt === 'c3-pad' && subIdx >= 0) { toggleMatrixPad(subIdx, dwellMs, Number.isFinite(slipPx) ? slipPx : 0); return; }
      if (lt === 'c8-puck' && subIdx >= 0) { togglePuckBypass(subIdx); return; }
      if (lt === 'c5-stage') {
        c5.showGuides = !c5.showGuides;
        c5Viewport.classList.toggle('show-guides', c5.showGuides);
        return;
      }
      const maxX = Math.max(0, (global.innerWidth || 1) - 1);
      const maxY = Math.max(0, (global.innerHeight || 1) - 1);
      const el = document.elementFromPoint(clamp(x, 0, maxX), clamp(y, 0, maxY));
      if (!el) return;
      const btn = el.closest('button');
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        btn.click();
        return;
      }
      const row = el.closest('.hg-tape-row');
      if (row) pinTapeRow(Number(row.dataset.row));
    }

    function updateSpatialReticle(s0, s1, events) {
      const mainObscured =
        !isSecondaryOpen &&
        (mainGrid.hidden || Boolean(document.querySelector('dialog[open]')));
      if (
        mainObscured ||
        tracker.mode === TRACKER_MODE.POINTER ||
        tracker.mode === TRACKER_MODE.IDLE ||
        (s0.state === HAND_STATE.IDLE && !s0.visible)
      ) {
        cursorPrimary.classList.remove('is-visible');
        cursorSecondary.classList.remove('is-visible');
        setAttr(chordLine, 'visibility', 'hidden');
        setAttr(dragTetherLine, 'visibility', 'hidden');
        setAttr(lockOriginRing, 'visibility', 'hidden');
        bimanualPill.hidden = true;
        return;
      }

      const armed = s0.state === HAND_STATE.ARMED || s0.state === HAND_STATE.COASTING;
      const px = armed ? s0.interactiveX : s0.euroFilter.x * global.innerWidth;
      const py = armed ? s0.interactiveY : s0.euroFilter.y * global.innerHeight;

      cursorPrimary.classList.add('is-visible');
      cursorPrimary.style.transform = 'translate3d(' + px.toFixed(1) + 'px, ' + py.toFixed(1) + 'px, 0)';
      setAttr(cursorDwellRing, 'stroke-dashoffset', (CIRC_R16 * (1 - s0.armProgress)).toFixed(2));

      // Ink and one accent: the tag text names the state; colour only says quiet, ready or active.
      let tag = 'IDLE';
      let color = PAL.ink3;
      if (s0.state === HAND_STATE.ARMING) { tag = 'ARM ' + Math.round(s0.armProgress * 200) + 'ms'; color = PAL.ink; }
      else if (s0.state === HAND_STATE.COASTING) { tag = 'COAST ' + s0.coastFrames + '/4'; color = PAL.ink3; }
      else if (s0.state === HAND_STATE.ARMED) {
        if (events.twoHandActive) { tag = '2H ' + events.twoHandScaleRatio.toFixed(2) + '×'; color = PAL.accent; }
        else if (s0.clutchReleased) { tag = 'CLUTCH FREE'; color = PAL.ink3; }
        else if (s0.pinchMode === PINCH_MODE.CLICK_LOCK) { tag = 'LOCK ' + s0.pinchSlipPx.toFixed(0) + '/14px'; color = PAL.accent; }
        else if (s0.pinchMode === PINCH_MODE.DRAG) { tag = s0.twistBrokenOut ? ('DRAG ' + s0.twistTotalDeg.toFixed(0) + '°') : 'DRAG'; color = PAL.accent; }
        else if (s0.vScrollActive) { tag = 'SCROLL'; color = PAL.accent; }
        else if (s0.velocityDamped) { tag = 'DAMP 0.08×'; color = PAL.ink; }
        else { tag = 'ARMED'; color = PAL.ink; }
      } else if (!s0.gateFacingOk) { tag = 'BACK OF HAND'; color = PAL.accent; }
      else if (!s0.gateKeyboardOk) { tag = 'KBD ZONE'; color = PAL.accent; }

      setAttr(cursorDwellRing, 'stroke', color);
      setAttr(cursorCore, 'fill', color);
      cursorPrimaryTag.textContent = tag;

      if (s0.pinched && s0.pinchMode === PINCH_MODE.CLICK_LOCK) {
        setAttr(lockOriginRing, 'cx', s0.lockOriginX.toFixed(1));
        setAttr(lockOriginRing, 'cy', s0.lockOriginY.toFixed(1));
        setAttr(lockOriginRing, 'visibility', 'visible');
        setAttr(dragTetherLine, 'visibility', 'hidden');
      } else if (s0.pinched && s0.pinchMode === PINCH_MODE.DRAG) {
        setAttr(lockOriginRing, 'cx', s0.lockOriginX.toFixed(1));
        setAttr(lockOriginRing, 'cy', s0.lockOriginY.toFixed(1));
        setAttr(lockOriginRing, 'visibility', 'visible');
        setAttr(dragTetherLine, 'x1', s0.lockOriginX.toFixed(1));
        setAttr(dragTetherLine, 'y1', s0.lockOriginY.toFixed(1));
        setAttr(dragTetherLine, 'x2', px.toFixed(1));
        setAttr(dragTetherLine, 'y2', py.toFixed(1));
        setAttr(dragTetherLine, 'visibility', 'visible');
      } else {
        setAttr(lockOriginRing, 'visibility', 'hidden');
        setAttr(dragTetherLine, 'visibility', 'hidden');
      }

      if (s1.state === HAND_STATE.ARMED || s1.state === HAND_STATE.COASTING) {
        cursorSecondary.classList.add('is-visible');
        cursorSecondary.style.transform = 'translate3d(' + s1.screenX.toFixed(1) + 'px, ' + s1.screenY.toFixed(1) + 'px, 0)';
        if (events.twoHandActive) {
          setAttr(chordLine, 'x1', px.toFixed(1));
          setAttr(chordLine, 'y1', py.toFixed(1));
          setAttr(chordLine, 'x2', s1.screenX.toFixed(1));
          setAttr(chordLine, 'y2', s1.screenY.toFixed(1));
          setAttr(chordLine, 'visibility', 'visible');
          bimanualPill.hidden = false;
          bimanualPill.style.left = events.twoHandMidX.toFixed(1) + 'px';
          bimanualPill.style.top = events.twoHandMidY.toFixed(1) + 'px';
          bimanualPill.textContent = events.twoHandScaleRatio.toFixed(2) + '× · ' + (events.twoHandTotalDeg >= 0 ? '+' : '') + Math.round(events.twoHandTotalDeg) + '°';
        } else {
          setAttr(chordLine, 'visibility', 'hidden');
          bimanualPill.hidden = true;
        }
      } else {
        cursorSecondary.classList.remove('is-visible');
        setAttr(chordLine, 'visibility', 'hidden');
        bimanualPill.hidden = true;
      }
    }

    function drawCell01Rig(s0, s1) {
      const ctx = rigCtx;
      const w = canvasSizes.rigW;
      const hPx = canvasSizes.rigH;
      const cfg = engine.config;
      ctx.clearRect(0, 0, w, hPx);

      if (tracker.mode !== TRACKER_MODE.WEBCAM) {
        ctx.fillStyle = PAL.hairline;
        for (let gx = 14; gx < w; gx += 16) {
          for (let gy = 14; gy < hPx; gy += 16) ctx.fillRect(gx, gy, 1.2, 1.2);
        }
      }

      const kbdY = cfg.keyboardExclusionY * hPx;
      ctx.fillStyle = CAN.accentA05;
      ctx.fillRect(0, kbdY, w, hPx - kbdY);
      ctx.strokeStyle = CAN.accentA45;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(0, kbdY);
      ctx.lineTo(w, kbdY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = PAL.accent;
      ctx.font = CAN.font;
      ctx.fillText('KEYBOARD ZONE', 6, hPx - 5);

      const rx = cfg.roiMinX * w;
      const ry = cfg.roiMinY * hPx;
      const rw = (cfg.roiMaxX - cfg.roiMinX) * w;
      const rh = (cfg.roiMaxY - cfg.roiMinY) * hPx;
      ctx.strokeStyle = PAL.line;
      ctx.strokeRect(rx, ry, rw, rh);
      const tk = 7;
      ctx.strokeStyle = PAL.ink3;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(rx, ry + tk); ctx.lineTo(rx, ry); ctx.lineTo(rx + tk, ry);
      ctx.moveTo(rx + rw - tk, ry); ctx.lineTo(rx + rw, ry); ctx.lineTo(rx + rw, ry + tk);
      ctx.moveTo(rx, ry + rh - tk); ctx.lineTo(rx, ry + rh); ctx.lineTo(rx + tk, ry + rh);
      ctx.moveTo(rx + rw - tk, ry + rh); ctx.lineTo(rx + rw, ry + rh); ctx.lineTo(rx + rw, ry + rh - tk);
      ctx.stroke();
      ctx.fillStyle = PAL.ink3;
      ctx.font = CAN.font;
      ctx.fillText(cfg.mappingMode === MAPPING_MODE.RELATIVE_CLUTCH ? 'CLUTCH: FIST LIFTS' : 'CURSOR AREA', rx + 4, ry + 12);

      if (s1.visible) drawSingleHandSkeleton(ctx, s1, w, hPx, false);
      if (s0.visible) drawSingleHandSkeleton(ctx, s0, w, hPx, true);
      else if (s0.state === HAND_STATE.COASTING) {
        const ax = (1 - s0.anchorCamX) * w;
        const ay = s0.anchorCamY * hPx;
        ctx.strokeStyle = PAL.ink3;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.arc(ax, ay, 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = PAL.ink3;
        ctx.font = CAN.font;
        ctx.fillText('COAST ' + s0.coastFrames + '/4', ax - 24, ay - 18);
      }
    }

    function drawSingleHandSkeleton(ctx, slot, w, hPx, isPrimary) {
      const lm = slot.normLm;
      const x0 = (1 - lm[0]) * w;
      const y0 = lm[1] * hPx;
      const x5 = (1 - lm[LM.INDEX_MCP * 3]) * w;
      const y5 = lm[LM.INDEX_MCP * 3 + 1] * hPx;
      const x9 = (1 - lm[LM.MIDDLE_MCP * 3]) * w;
      const y9 = lm[LM.MIDDLE_MCP * 3 + 1] * hPx;
      const x17 = (1 - lm[LM.PINKY_MCP * 3]) * w;
      const y17 = lm[LM.PINKY_MCP * 3 + 1] * hPx;

      ctx.fillStyle = slot.gateFacingOk ? CAN.inkA06 : CAN.accentA14;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x5, y5);
      ctx.lineTo(x9, y9);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = isPrimary ? PAL.ink : PAL.ink3;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(x5, y5);
      ctx.lineTo(x17, y17);
      ctx.stroke();

      ctx.strokeStyle = slot.gateFacingOk ? PAL.ink2 : PAL.accent;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      for (let i = 0; i < HAND_BONES.length; i += 2) {
        const a = HAND_BONES[i] * 3;
        const b = HAND_BONES[i + 1] * 3;
        ctx.moveTo((1 - lm[a]) * w, lm[a + 1] * hPx);
        ctx.lineTo((1 - lm[b]) * w, lm[b + 1] * hPx);
      }
      ctx.stroke();

      const x4 = (1 - lm[LM.THUMB_TIP * 3]) * w;
      const y4 = lm[LM.THUMB_TIP * 3 + 1] * hPx;
      const x8 = (1 - lm[LM.INDEX_TIP * 3]) * w;
      const y8 = lm[LM.INDEX_TIP * 3 + 1] * hPx;
      ctx.strokeStyle = slot.pinched ? PAL.accent : PAL.ink3;
      ctx.lineWidth = slot.pinched ? 2.2 : 1.2;
      ctx.setLineDash(slot.pinched ? [] : [2, 2]);
      ctx.beginPath();
      ctx.moveTo(x4, y4);
      ctx.lineTo(x8, y8);
      ctx.stroke();
      ctx.setLineDash([]);

      for (let j = 0; j < 21; j++) {
        const jb = j * 3;
        const jx = (1 - lm[jb]) * w;
        const jy = lm[jb + 1] * hPx;
        const isTip = j === 4 || j === 8 || j === 12 || j === 16 || j === 20;
        ctx.fillStyle = j === 8 ? PAL.accent : (isTip ? PAL.ink : PAL.surface);
        ctx.strokeStyle = PAL.ink;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(jx, jy, isTip ? 2.8 : 2.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      if (!isPrimary) return;
      const ax = (1 - slot.anchorCamX) * w;
      const ay = slot.anchorCamY * hPx;
      ctx.strokeStyle = slot.state === HAND_STATE.ARMED ? PAL.ink : PAL.ink3;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ax, ay, 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * slot.armProgress);
      ctx.stroke();
      ctx.fillStyle = PAL.accent;
      ctx.beginPath();
      ctx.arc(ax, ay, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    function drawCell02Scope(s0, force) {
      if (c2.frozen && !force) return;
      const ctx = scopeCtx;
      const w = canvasSizes.scopeW;
      const hPx = canvasSizes.scopeH;
      const scope = engine.scope;
      ctx.fillStyle = PAL.surface;
      ctx.fillRect(0, 0, w, hPx);

      const splitX = Math.floor(w * 0.47);
      const m = 8;
      const pw = Math.max(24, splitX - m * 2);
      const ph = Math.max(24, hPx - m * 2);

      ctx.fillStyle = PAL.well;
      ctx.fillRect(m, m, pw, ph);
      ctx.strokeStyle = PAL.hairline;
      ctx.lineWidth = 1;
      ctx.strokeRect(m, m, pw, ph);
      ctx.beginPath();
      ctx.moveTo(m + pw / 3, m); ctx.lineTo(m + pw / 3, m + ph);
      ctx.moveTo(m + (pw * 2) / 3, m); ctx.lineTo(m + (pw * 2) / 3, m + ph);
      ctx.moveTo(m, m + ph / 3); ctx.lineTo(m + pw, m + ph / 3);
      ctx.moveTo(m, m + (ph * 2) / 3); ctx.lineTo(m + pw, m + (ph * 2) / 3);
      ctx.stroke();

      const wx = m + c2.waypointU * pw;
      const wy = m + c2.waypointV * ph;
      ctx.strokeStyle = PAL.ink3;
      ctx.beginPath();
      ctx.moveTo(wx - 6, wy); ctx.lineTo(wx + 6, wy);
      ctx.moveTo(wx, wy - 6); ctx.lineTo(wx, wy + 6);
      ctx.stroke();

      const ti = c2.trailHead;
      c2.trailU[ti] = s0.cursorU;
      c2.trailV[ti] = s0.cursorV;
      c2.trailHead = (ti + 1) % 56;
      if (c2.trailCount < 56) c2.trailCount++;

      if (c2.trailCount > 2) {
        ctx.strokeStyle = CAN.inkA25;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let k = 0; k < c2.trailCount; k++) {
          const idx = (c2.trailHead - c2.trailCount + k + 56) % 56;
          const tx = m + c2.trailU[idx] * pw;
          const ty = m + c2.trailV[idx] * ph;
          if (k === 0) ctx.moveTo(tx, ty);
          else ctx.lineTo(tx, ty);
        }
        ctx.stroke();
      }

      ctx.strokeStyle = PAL.accent;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(m + s0.rawU * pw, m + s0.rawV * ph, 3.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = PAL.ink;
      ctx.beginPath();
      ctx.arc(m + s0.cursorU * pw, m + s0.cursorV * ph, 4, 0, Math.PI * 2);
      ctx.fill();

      const ox = splitX + 4;
      const ow = Math.max(30, w - ox - 8);
      const topH = Math.floor((hPx - 20) * 0.64);
      const topY = 8;
      const botY = topY + topH + 4;
      const botH = Math.max(18, hPx - botY - 8);
      ctx.fillStyle = PAL.well;
      ctx.fillRect(ox, topY, ow, topH);
      ctx.fillRect(ox, botY, ow, botH);
      ctx.strokeStyle = PAL.hairline;
      ctx.strokeRect(ox, topY, ow, topH);
      ctx.strokeRect(ox, botY, ow, botH);

      const n = scope.count;
      if (n >= 3) {
        const cap = scope.capacity;
        let minVal = 1e9;
        let maxVal = -1e9;
        for (let i = 0; i < n; i++) {
          const bi = (scope.head - n + i + cap) % cap;
          const rv = scope.rawX[bi];
          const sv = scope.smoothX[bi];
          if (rv < minVal) minVal = rv;
          if (sv < minVal) minVal = sv;
          if (rv > maxVal) maxVal = rv;
          if (sv > maxVal) maxVal = sv;
        }
        const mid = 0.5 * (minVal + maxVal);
        const halfSpan = Math.max(0.028, (maxVal - minVal) * 0.62);

        ctx.fillStyle = CAN.accentA10;
        for (let i = 0; i < n; i++) {
          const bi = (scope.head - n + i + cap) % cap;
          if (scope.damped[bi]) {
            ctx.fillRect(ox + (i / (cap - 1)) * ow, topY + 1, Math.max(1.5, ow / cap + 0.5), topH - 2);
          }
        }

        const drawTrace = function (arr, stroke, width, mapY, baseTop, baseH) {
          ctx.strokeStyle = stroke;
          ctx.lineWidth = width;
          ctx.beginPath();
          for (let i = 0; i < n; i++) {
            const bi = (scope.head - n + i + cap) % cap;
            const px = ox + (i / (cap - 1)) * ow;
            const py = baseTop + (1 - mapY(arr[bi])) * baseH;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        };

        const normOsc = function (v) { return clamp((v - mid) / (halfSpan * 2) + 0.5, 0.04, 0.96); };
        drawTrace(scope.rawX, CAN.accentA70, 1.05, normOsc, topY, topH);
        drawTrace(scope.smoothX, PAL.ink, 1.8, normOsc, topY, topH);
        drawTrace(scope.speed, PAL.ink3, 1.25, function (v) { return clamp(v / 2.2, 0.04, 0.95); }, botY, botH);
      }

      ctx.font = CAN.fontBold;
      ctx.fillStyle = PAL.accent;
      ctx.fillText('RAW', ox + 4, topY + 11);
      ctx.fillStyle = PAL.ink;
      ctx.fillText('SMOOTHED', ox + 30, topY + 11);
      ctx.fillStyle = PAL.ink3;
      ctx.fillText('SPEED', ox + 4, botY + 11);
    }

    function drawCell04Dial(s0) {
      const ctx = dialCtx;
      const w = canvasSizes.dialW;
      const hPx = canvasSizes.dialH;
      ctx.clearRect(0, 0, w, hPx);
      const cx = w * 0.5;
      const cy = hPx * 0.5;
      const r = Math.max(28, Math.min(w, hPx) * 0.41);

      ctx.fillStyle = PAL.well;
      ctx.strokeStyle = PAL.hairline;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      const dzRad = (engine.config.twistDeadzoneDeg * Math.PI) / 180;
      ctx.fillStyle = CAN.accentA14;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r + 4, -Math.PI / 2 - dzRad * 2.2, -Math.PI / 2 + dzRad * 2.2);
      ctx.closePath();
      ctx.fill();

      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2 - Math.PI / 2;
        const major = i % 3 === 0;
        const r0 = major ? r - 6 : r - 3;
        ctx.strokeStyle = major ? PAL.ink3 : PAL.line;
        ctx.lineWidth = major ? 1.3 : 1;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * (r + 1), cy + Math.sin(a) * (r + 1));
        ctx.stroke();
      }

      const curRad = (c4.angleDeg * Math.PI) / 180;
      if (Math.abs(curRad) > 0.01) {
        ctx.strokeStyle = PAL.accent;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, r - 9, -Math.PI / 2, -Math.PI / 2 + clamp(curRad, -Math.PI * 2, Math.PI * 2), curRad < 0);
        ctx.stroke();
      }

      const knobR = r * 0.66;
      ctx.fillStyle = PAL.surface;
      ctx.strokeStyle = s0.twistBrokenOut && spatial.latchedType === 'c4-dial' ? PAL.accent : PAL.ink;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(cx, cy, knobR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      const ptrAngle = -Math.PI / 2 + curRad;
      ctx.strokeStyle = PAL.accent;
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ptrAngle) * (knobR * 0.22), cy + Math.sin(ptrAngle) * (knobR * 0.22));
      ctx.lineTo(cx + Math.cos(ptrAngle) * (knobR - 4), cy + Math.sin(ptrAngle) * (knobR - 4));
      ctx.stroke();

      ctx.fillStyle = PAL.ink;
      ctx.font = CAN.fontBold;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const turns = Math.trunc(c4.angleDeg / 360);
      ctx.fillText(turns !== 0 ? turns + 'T' : '0T', cx, cy);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }

    function updateSecondaryReadouts(s0, events) {
      const st = tracker.stats;
      if (tracker.mode === TRACKER_MODE.TOUR) syncRigButtons();
      fpsReadout.textContent = Math.round(st.fps) + ' FPS · ' + st.frameMs.toFixed(1) + 'ms';
      setGate(gSpan, s0.visible && s0.gateSpanOk ? 'pass' : 'idle');
      setGate(gFacing, s0.visible ? (s0.gateFacingOk ? 'pass' : 'attention') : 'idle');
      setGate(gKbd, s0.visible ? (s0.gateKeyboardOk ? 'pass' : 'attention') : 'idle');

      if (s0.state === HAND_STATE.ARMED) setGate(gArm, 'pass', 'ARMED');
      else if (s0.state === HAND_STATE.COASTING) setGate(gArm, 'attention', 'COAST ' + s0.coastFrames + '/4');
      else if (s0.state === HAND_STATE.ARMING) setGate(gArm, 'attention', 'DWELL ' + String(Math.round(s0.armProgress * 100)).padStart(2, '0') + '%');
      else setGate(gArm, 'idle', 'IDLE');

      if (events.twoHandActive) setGate(gGesture, 'attention', '2H ' + events.twoHandScaleRatio.toFixed(2) + '×');
      else if (s0.pinched) setGate(gGesture, 'attention', s0.pinchMode === PINCH_MODE.CLICK_LOCK ? 'PINCH LOCK' : 'PINCH DRAG');
      else if (s0.vScrollActive) setGate(gGesture, 'attention', 'SCROLL');
      else if (s0.clutchReleased) setGate(gGesture, 'attention', 'CLUTCH FREE');
      else setGate(gGesture, 'idle', 'OPEN');

      c2Metric.textContent = 'fc ' + s0.euroFilter.cutoffHz.toFixed(2) + 'Hz · ' + engine.scope.attenuationDb.toFixed(1) + 'dB';
      c2XyReadout.textContent = 'LOCUS ' + s0.cursorU.toFixed(3) + ', ' + s0.cursorV.toFixed(3);

      const pr = s0.visible ? s0.pinchRatio : 0.75;
      c3SchmittFill.style.width = clamp((pr / 0.80) * 100, 2, 100).toFixed(1) + '%';
      c3SchmittFill.classList.toggle('is-pinched', s0.pinched);
      c3SchmittFill.classList.toggle('is-damped', s0.velocityDamped && !s0.pinched);
      c3Metric.textContent = 'd/s ' + pr.toFixed(2) + ' · ' + (s0.pinched ? (s0.pinchMode === PINCH_MODE.CLICK_LOCK ? 'LOCK' : 'DRAG') : (s0.velocityDamped ? 'DAMP' : 'OPEN'));

      const vel = c7.displayVelPx;
      c7Metric.textContent = 'VEL ' + Math.round(vel) + ' px/s';
      const barMag = clamp(Math.abs(vel) / 900, 0, 0.5) * 100;
      c7VelBar.style.top = vel >= 0 ? '50%' : (50 - barMag).toFixed(1) + '%';
      c7VelBar.style.height = barMag.toFixed(1) + '%';
      updateTapePosReadout();

      c9Metric.textContent = 'detect ' + st.detectMs.toFixed(2) + 'ms';
      teleSpan.textContent = s0.visible ? s0.palmSpan.toFixed(3) : '—';
      teleNz.textContent = s0.visible ? ((s0.palmFacingCos >= 0 ? '+' : '') + s0.palmFacingCos.toFixed(2)) : '—';
      teleY.textContent = s0.visible ? s0.palmY.toFixed(2) : '—';
    }

    // -----------------------------------------------------------------------
    // 8. Seamless SPA View Swap, Spatial Homothety Transition & History Sync
    // -----------------------------------------------------------------------
    function otherSecondaryPageVisible() {
      const kids = document.body ? document.body.children : [];
      for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        if (el === secondaryPage || el === mainGrid || el.hidden) continue;
        if (typeof el.className === 'string' && /(^|\s)[a-z0-9]+-secondary-page(\s|$)/.test(el.className)) return true;
      }
      return false;
    }

    function clearSpatialLatches() {
      if (spatial.hoveredPadIdx >= 0) {
        c3Pads[spatial.hoveredPadIdx].classList.remove('is-spatial-target', 'is-locking');
      }
      if (spatial.hoveredPuckIdx >= 0 && puckEls[spatial.hoveredPuckIdx]) {
        puckEls[spatial.hoveredPuckIdx].classList.remove('is-spatial-target');
      }
      if (spatial.hoveredTunerIdx >= 0) {
        tunerRows[spatial.hoveredTunerIdx].classList.remove('is-spatial-target');
      }
      if (spatial.latchedSubIdx >= 0 && puckEls[spatial.latchedSubIdx]) {
        puckEls[spatial.latchedSubIdx].style.transform = '';
        puckEls[spatial.latchedSubIdx].classList.remove('is-dragging');
      }
      setHighlightedCell(-1, false);
      c5Card.classList.remove('is-manipulating');
      c6Track.classList.remove('is-latched');
      c6LatchBadge.textContent = 'READY';
      c6LatchBadge.classList.remove('is-latched');
      spatial.hoveredPadIdx = -1;
      spatial.hoveredPuckIdx = -1;
      spatial.hoveredTunerIdx = -1;
      spatial.latchedType = null;
      spatial.latchedCellIdx = -1;
      spatial.latchedSubIdx = -1;
      spatial.vScrollTarget = 'tape';
      c7.buttonVelPx = 0;
      c7.displayVelPx = 0;
    }

    function swapDomToSecondary() {
      if (isSecondaryOpen) return;
      mainGrid.hidden = true;
      secondaryPage.hidden = false;
      isSecondaryOpen = true;
      if (tracker.mode === TRACKER_MODE.WEBCAM || tracker.isWebcamStarting) {
        tracker.setFallbackMode(TRACKER_MODE.SYNTH);
        tracker.setVideoElement(wbVideo);
        tracker.notifyStatus();
      } else if (tracker.mode === TRACKER_MODE.IDLE) {
        synthRig.resetPosture();
        synthRig.autoOrbit = !prefersReducedMotion();
        tracker.setMode(TRACKER_MODE.SYNTH);
      } else {
        tracker.notifyStatus();
      }
      resizeAllCanvases();
      refreshRectCache();
      ensureLoopState();
      if (typeof global.scrollTo === 'function') global.scrollTo(0, 0);
      backBtn.focus({ preventScroll: true });
    }

    function swapDomToMain(restoreFocus, crossCellHash) {
      if (!isSecondaryOpen) return;
      secondaryPage.hidden = true;
      if (!crossCellHash && !otherSecondaryPageVisible()) {
        mainGrid.hidden = false;
      }
      isSecondaryOpen = false;
      clearSpatialLatches();
      synthRig.resetPosture();
      engine.resetSlot(1);
      syncRigButtons();
      cameraSuspendedByVisibility = false;
      tracker.setVideoElement(miniVideo);
      tracker.setMode(TRACKER_MODE.IDLE);
      resetPortalPreview();
      ensureLoopState();
      if (restoreFocus && !crossCellHash && !mainGrid.hidden) {
        if (typeof global.scrollTo === 'function') global.scrollTo(0, savedMainScrollY);
        // `Studio ↗` is hidden at compact tile sizes; the stage opens the Studio too.
        (portalStudioBtn.getClientRects().length ? portalStudioBtn : portalStage).focus({ preventScroll: true });
      }
    }

    function clearTransitionNames() {
      portalCell.style.viewTransitionName = '';
      secondaryGrid.style.viewTransitionName = '';
    }

    function applyDomState(open, restoreFocus, crossCellHash) {
      if (open) swapDomToSecondary();
      else swapDomToMain(restoreFocus, crossCellHash);
    }

    // Race-free open/close: the latest request (targetOpen) wins even if an earlier View Transition
    // callback runs later. Both `vt.ready` and `vt.finished` are guarded with `.catch()`.
    function runPortalTransition(nextOpen, animate, restoreFocus, crossCellHash) {
      const isCross = Boolean(crossCellHash);
      if (nextOpen && !targetOpen && !isSecondaryOpen) savedMainScrollY = global.scrollY || 0;
      targetOpen = nextOpen;
      if (!nextOpen) enteredFromMainGrid = false;
      const mySeq = ++vtSeq;
      const canAnimate =
        animate &&
        !isCross &&
        !document.hidden &&
        typeof document.startViewTransition === 'function' &&
        !prefersReducedMotion();
      if (!canAnimate) {
        clearTransitionNames();
        applyDomState(nextOpen, restoreFocus && !isCross, isCross);
        return;
      }
      clearTransitionNames();
      if (nextOpen) portalCell.style.viewTransitionName = 'hg-stage-portal';
      else secondaryGrid.style.viewTransitionName = 'hg-stage-portal';
      let vt = null;
      try {
        vt = document.startViewTransition(function () {
          clearTransitionNames();
          const nowCross = Boolean(location.hash && location.hash !== '#hand-gesture');
          if (mySeq === vtSeq) {
            if (targetOpen) secondaryGrid.style.viewTransitionName = 'hg-stage-portal';
            else portalCell.style.viewTransitionName = 'hg-stage-portal';
            applyDomState(targetOpen, restoreFocus && !isCross, isCross);
          } else {
            applyDomState(targetOpen, !targetOpen && !nowCross, nowCross);
          }
        });
      } catch (_) {
        clearTransitionNames();
        applyDomState(nextOpen, restoreFocus && !isCross, isCross);
        return;
      }
      const noop = function () {};
      Promise.resolve(vt && vt.ready).catch(noop);
      Promise.resolve(vt && vt.updateCallbackDone).catch(noop);
      Promise.resolve(vt && vt.finished)
        .catch(noop)
        .finally(function () {
          if (mySeq === vtSeq) clearTransitionNames();
        });
    }

    function openSecondaryView(opts) {
      if (targetOpen) return;
      const fromUserTap = Boolean(opts && opts.fromUserTap);

      if (fromUserTap && location.hash !== '#hand-gesture') {
        enteredFromMainGrid = true;
        if (global.history && typeof global.history.pushState === 'function') {
          try {
            global.history.pushState({ hgSecondary: true }, '', '#hand-gesture');
          } catch (_) {}
        }
      }
      runPortalTransition(true, fromUserTap, false, false);
    }

    function requestCloseSecondaryView() {
      if (!targetOpen) return;
      if (
        enteredFromMainGrid &&
        location.hash === '#hand-gesture' &&
        global.history &&
        typeof global.history.back === 'function'
      ) {
        enteredFromMainGrid = false;
        global.history.back();
        return;
      }
      enteredFromMainGrid = false;
      if (
        location.hash === '#hand-gesture' &&
        global.history &&
        typeof global.history.replaceState === 'function'
      ) {
        try {
          global.history.replaceState(null, '', location.pathname + location.search);
        } catch (_) {}
      }
      const crossCellHash = Boolean(location.hash && location.hash !== '#hand-gesture');
      runPortalTransition(false, !crossCellHash, !crossCellHash, crossCellHash);
    }

    function syncLocationHash() {
      const wantOpen = location.hash === '#hand-gesture';
      if (wantOpen === targetOpen) {
        if (!wantOpen && !location.hash && mainGrid.hidden && !otherSecondaryPageVisible()) {
          mainGrid.hidden = false;
        }
        return;
      }
      if (wantOpen) {
        runPortalTransition(true, false, false, false);
      } else {
        // Another cell's hash took over: close instantly and do not unhide main.grid or steal focus.
        const crossCellHash = Boolean(location.hash && location.hash !== '#hand-gesture');
        enteredFromMainGrid = false;
        runPortalTransition(false, !crossCellHash, !crossCellHash, crossCellHash);
      }
    }

    global.addEventListener('popstate', syncLocationHash);
    global.addEventListener('hashchange', syncLocationHash);
    global.addEventListener('pagehide', function () {
      cameraSuspendedByVisibility = false;
      tracker.teardown();
      ensureLoopState();
    });

    if (location.hash === '#hand-gesture') {
      openSecondaryView({ fromUserTap: false });
    }
  }

  function bootstrap() {
    const mount = document.getElementById('cell-hand-gesture');
    if (mount) mountHandGestureCell(mount);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  global.HandGestureUI = { mount: mountHandGestureCell };
})(typeof window !== 'undefined' ? window : globalThis);
