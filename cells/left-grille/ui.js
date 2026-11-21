/**
 * UI & Seamless Secondary-Grid Portal (`cells/left-grille/ui.js`)
 *
 * Mounts:
 * 1. Main Grid Cell (`#cell-left-grille`): Tactile Swiss/Braun specimen card with inline SVG
 *    MacBook Pro left speaker grille elevation (8–22% CNC mic through-holes + 28–96% blind dimples).
 * 2. Secondary Page (`#left-grille-page`): Replaces `<main class="grid">` seamlessly in-page
 *    with a Back button (`← Grid`, `Escape`, and History `#left-grille` sync) and a secondary
 *    `.grid` of 9 `.cell` cards obeying the exact same sizing and layout rules as the main grid.
 * 3. Secondary Cell 1 (`#lg-sec-cell-1`): Live Left-Grille Acoustic Swipe Instrument displaying
 *    Direction (`UP` vs `DOWN`), Speed (`cm/s` + peak), Dual-Reference Relative Distance
 *    (`% FROM TOP` & `% FROM BTM` + `cm`), 1:1 vernier rail with `±1σ` uncertainty halo,
 *    rolling 2-trace trajectory/Doppler scope, 1-stroke calibration, and rail-drag/Sim fallbacks.
 */
(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const GRILLE_CM = 11.0;

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
            fill: isMicPort ? '#1c1c1a' : '#c7c7c1',
            opacity: isMicPort ? '0.92' : '0.68'
          })
        );
      }
    }

    if (opts.withNeedle) {
      // Subtle mic bracket + animated vernier needle for the main grid portal card
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
    if (!portalCell || !mainGrid) return;

    const ControllerCls =
      global.LeftGrilleController && global.LeftGrilleController.LeftGrilleSensorController;
    if (!ControllerCls) return;

    let isSecondaryOpen = false;
    let enteredFromMainGrid = false;
    let calWizardActive = false;

    // Rolling 150-point scope history (`y` in 0..1, `unc` in 0..0.25, `asym` in -1..1)
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
          h('span', { className: 'lg-kicker', textContent: '05 · TG-L1' }),
          h('span', { className: 'lg-portal-arrow', 'aria-hidden': 'true', textContent: '↗' })
        ]),
        h('div', { className: 'lg-portal-graphic' }, [
          buildGrilleSvg({
            width: 48,
            height: 136,
            cols: 5,
            rows: 20,
            withNeedle: true,
            className: 'lg-portal-svg'
          })
        ]),
        h('div', { className: 'lg-portal-bottom' }, [
          h('div', { className: 'lg-portal-title-group' }, [
            h('div', { className: 'lg-portal-title', textContent: 'Left Grille Sonar' }),
            h('div', { className: 'lg-portal-sub', textContent: 'Speaker + 3-mic swipe array' })
          ]),
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

    const navBar = h('nav', { className: 'lg-nav-bar', 'aria-label': 'Secondary page navigation' }, [
      h('div', { className: 'lg-nav-left' }, [
        backBtn,
        h('span', { className: 'lg-breadcrumb', textContent: '05 / Left Grille Acoustic Sonar' })
      ]),
      h('span', { className: 'lg-kbd-hint' }, [h('kbd', { textContent: 'Esc' }), 'back'])
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
      textContent: 'READY · Drag rail or Arm'
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
        title: 'Calibrate top/bottom left-grille anchors or invert mic polarity',
        onClick: () => openCalibrationWizard()
      },
      ['CAL']
    );

    const bezel = h('div', { className: 'lg-bezel' }, [
      h('div', { className: 'lg-bezel-group' }, [armBtn, statusPill]),
      h('div', { className: 'lg-bezel-group' }, [sonarBtn, calBtn])
    ]);

    // Physical 11.0 cm Left-Grille Vernier Rail
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
        'aria-label': 'Left speaker grille position (drag vertically or use Up and Down arrow keys)',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': '50',
        title: 'Swipe physical left speaker grille when armed, or drag here to test'
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
    const cmSpanText = h('span', { className: 'lg-dist-tag', textContent: '5.5 cm top' });

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

    // Inline Calibration / Error Overlay inside Tier 3 (never stretches 4:3 cell!)
    const overlayMsg = h('div', { className: 'lg-overlay-text' });
    const overlayActions = h('div', { className: 'lg-overlay-row' });
    const inlineOverlay = h('div', { className: 'lg-inline-overlay', hidden: true }, [
      overlayMsg,
      overlayActions
    ]);

    const scopeBox = h('div', { className: 'lg-scope-box' }, [
      scopeCanvas,
      h('div', { className: 'lg-scope-caption' }, [scopeLeftNote, scopeRightNote]),
      inlineOverlay
    ]);

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
        h('div', { className: 'lg-sim-actions' }, [simUpBtn, simDownBtn, flipBtn])
      ]),
      scopeBox
    ]);

    const secCell1 = h(
      'section',
      {
        id: 'lg-sec-cell-1',
        className: 'cell lg-instrument-cell',
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

    const secondaryGrid = h(
      'section',
      {
        id: 'left-grille-secondary-grid',
        className: 'grid',
        'aria-label': 'Secondary grid'
      },
      [
        secCell1,
        h('div', { className: 'cell' }),
        h('div', { className: 'cell' }),
        h('div', { className: 'cell' }),
        h('div', { className: 'cell' }),
        h('div', { className: 'cell' }),
        h('div', { className: 'cell' }),
        h('div', { className: 'cell' }),
        h('div', { className: 'cell' })
      ]
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
    // 3. Acoustic Controller Wiring & Live UI Rendering
    // -------------------------------------------------------------------------
    const controller = new ControllerCls({
      onStateChange: handleControllerState,
      onTelemetry: handleTelemetry,
      onSwipe: handleCommittedSwipe,
      onCalibrationResult: handleCalibrationResult
    });

    function handleControllerState(st) {
      const armed = st.state === 'listening' || st.state === 'requesting';
      armBtn.dataset.armed = armed ? 'true' : 'false';
      armBtn.setAttribute('aria-pressed', armed ? 'true' : 'false');
      armLabel.textContent =
        st.state === 'requesting' ? 'ARMING…' : st.state === 'listening' ? 'LIVE' : 'ARM MIC';

      sonarBtn.setAttribute('aria-pressed', st.txEnabled ? 'true' : 'false');
      sonarBtn.textContent = st.txEnabled ? '19k L-CH' : 'PASSIVE';

      if (st.state === 'error' && st.error) {
        statusPill.textContent = 'SIM MODE';
        showErrorOverlay(st.error);
      } else if (st.state === 'listening') {
        if (!calWizardActive) inlineOverlay.hidden = true;
        const rateKhz = Math.round((st.sampleRate || 48000) / 100) / 10;
        const modeTag = st.txEnabled ? 'SONAR+MIC' : 'MIC ONLY';
        const polTag = st.polarity === -1 ? ' · INV' : '';
        statusPill.textContent = `${modeTag} · ${rateKhz}k${polTag}`;
      } else if (st.state === 'idle') {
        if (!calWizardActive) inlineOverlay.hidden = true;
        statusPill.textContent = st.calibrated ? 'CAL READY · Arm or drag' : 'READY · Arm or drag';
      }
    }

    function updateRailAndReadout(yFrac, uncPct, speedCms, liveDir) {
      const topPct = Math.round(clamp(yFrac * 100, 0, 100));
      const btmPct = 100 - topPct;
      const topCm = (Math.round(yFrac * GRILLE_CM * 10) / 10).toFixed(1);

      needle.style.top = `${yFrac * 100}%`;
      needle.dataset.dir = liveDir === 'up' || liveDir === 'down' ? liveDir : 'idle';
      sigmaBand.style.top = `${yFrac * 100}%`;
      sigmaBand.style.height = `${clamp((uncPct || 8) * 2, 7, 34)}%`;

      railWrap.setAttribute('aria-valuenow', String(topPct));
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
      } else if (statusPill.dataset.veto === 'true') {
        statusPill.dataset.veto = 'false';
        if (controller.state === 'listening') {
          statusPill.textContent = `${controller.txEnabled ? 'SONAR+MIC' : 'MIC'} · +${Math.max(0, Math.round(pkt.fricSnrDb))}dB`;
        }
      } else if (controller.state === 'listening' && pkt.active) {
        statusPill.textContent = `TRACKING · +${Math.max(0, Math.round(pkt.fricSnrDb))}dB`;
      }

      railTrack.dataset.pinholeLock = pkt.pinholeOcclusion > 0.32 ? 'true' : 'false';

      if (pkt.active) {
        updateRailAndReadout(pkt.y, pkt.uncertaintyPct, pkt.speedCmPerSec, pkt.liveDirection);
        if (pkt.liveDirection === 'up') {
          dirText.textContent = '↑ UP…';
          dirText.dataset.dir = 'up';
        } else if (pkt.liveDirection === 'down') {
          dirText.textContent = '↓ DOWN…';
          dirText.dataset.dir = 'down';
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
      const isUp = sw.direction === 'up';
      dirText.textContent = isUp ? '↑ SWIPE UP' : '↓ SWIPE DOWN';
      dirText.dataset.dir = sw.direction;
      confBadge.textContent = `${Math.round(sw.confidence * 100)}%`;

      speedNum.textContent = sw.speedCmPerSec.toFixed(1);
      speedPeakMeta.textContent = `pk ${sw.peakSpeedCmPerSec.toFixed(1)} cm/s · ${sw.durationMs}ms`;
      modeMeta.textContent = `${sw.startFromTopPct.toFixed(0)}% → ${sw.endFromTopPct.toFixed(0)}% top (${sw.sensingMode})`;

      const topEdge = Math.min(sw.startFromTopPct, sw.endFromTopPct);
      const heightPct = Math.max(3, Math.abs(sw.endFromTopPct - sw.startFromTopPct));
      spanRibbon.style.top = `${topEdge}%`;
      spanRibbon.style.height = `${heightPct}%`;
      spanRibbon.dataset.dir = sw.direction;
      spanRibbon.dataset.visible = 'true';

      updateRailAndReadout(sw.endFromTopPct / 100, 5.5, sw.speedCmPerSec, sw.direction);
      cmSpanText.textContent = `${sw.distanceFromTopCm.toFixed(1)}cm T · ${sw.distanceFromBottomCm.toFixed(1)}cm B`;

      announce(
        `Swipe ${sw.direction}, ${sw.speedCmPerSec.toFixed(1)} centimeters per second, ${Math.round(
          sw.distanceFromTopPct
        )} percent from top, ${Math.round(sw.distanceFromBottomPct)} percent from bottom.`
      );
      scheduleScopeDraw();
    }

    // -------------------------------------------------------------------------
    // 4. Calibration & Error Inline Overlays (Zero 4:3 Row Overflow)
    // -------------------------------------------------------------------------
    function clearChildren(node) {
      while (node.firstChild) node.removeChild(node.firstChild);
    }

    function showErrorOverlay(msg) {
      calWizardActive = false;
      overlayMsg.textContent = msg;
      clearChildren(overlayActions);
      overlayActions.appendChild(
        h(
          'button',
          {
            type: 'button',
            className: 'lg-mini-btn',
            onClick: () => {
              inlineOverlay.hidden = true;
            }
          },
          ['Dismiss']
        )
      );
      inlineOverlay.hidden = false;
    }

    async function openCalibrationWizard() {
      if (calWizardActive) {
        closeCalibrationWizard();
        return;
      }
      if (controller.state !== 'listening') {
        const ok = await controller.start();
        if (!ok) return;
      }
      calWizardActive = true;
      controller.startCalibrationStep('up');
      overlayMsg.textContent =
        'Calibrate: Slide finger steadily UP the left grille (Bottom Fn → Top Esc), then press Lock.';
      clearChildren(overlayActions);
      overlayActions.appendChild(
        h(
          'button',
          {
            type: 'button',
            className: 'lg-mini-btn',
            onClick: () => controller.finishCalibrationStep()
          },
          ['Lock Swipe']
        )
      );
      overlayActions.appendChild(
        h(
          'button',
          {
            type: 'button',
            className: 'lg-mini-btn',
            onClick: () => {
              controller.resetCalibration();
              closeCalibrationWizard();
            }
          },
          ['Reset']
        )
      );
      overlayActions.appendChild(
        h(
          'button',
          {
            type: 'button',
            className: 'lg-mini-btn',
            onClick: () => closeCalibrationWizard()
          },
          ['Cancel']
        )
      );
      inlineOverlay.hidden = false;
    }

    function closeCalibrationWizard() {
      calWizardActive = false;
      inlineOverlay.hidden = true;
    }

    function handleCalibrationResult(res) {
      calWizardActive = false;
      if (res && res.ok) {
        inlineOverlay.hidden = true;
        modeMeta.textContent = `Calibrated (${res.polarity === 1 ? 'Top-Mic' : 'Inverted'})`;
        announce('Left grille calibration locked.');
      } else {
        showErrorOverlay('Signal too quiet — rub firmly from bottom to top of the left grille.');
      }
    }

    async function toggleArm() {
      if (controller.state === 'listening' || controller.state === 'requesting') {
        await controller.stop();
      } else {
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
      e.preventDefault();
      railWrap.focus();
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

    function finishRailDrag(e) {
      if (!dragState || (e && e.pointerId !== dragState.pointerId)) return;
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
    }

    railWrap.addEventListener('pointerup', finishRailDrag);
    railWrap.addEventListener('pointercancel', finishRailDrag);

    railWrap.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        controller.runSimulatedSwipe('up');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        controller.runSimulatedSwipe('down');
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

      // Subtle 15% top-mic reference line & 50% midline
      const micLineY = padY + 0.15 * plotH;
      ctx.strokeStyle = 'rgba(0, 82, 204, 0.18)';
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(4, micLineY);
      ctx.lineTo(traceW, micLineY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Uncertainty band polygon
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

        // Main position trajectory y(t)
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

        // Highlight active segments in directional accent
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

      // Right mini Doppler spectrum column (-f bottom = DOWN, +f top = UP)
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
          // b = 0..15 negative Doppler (bottom half), b = 16..31 positive Doppler (top half)
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
    // 7. Seamless SPA View Swap, Spatial Homothety Transition & History Sync
    // -------------------------------------------------------------------------
    function swapDomToSecondary() {
      mainGrid.hidden = true;
      secondaryPage.hidden = false;
      isSecondaryOpen = true;
      syncCanvasSize();
      backBtn.focus({ preventScroll: true });
    }

    function swapDomToMain() {
      secondaryPage.hidden = true;
      mainGrid.hidden = false;
      isSecondaryOpen = false;
      calWizardActive = false;
      inlineOverlay.hidden = true;
      portalBtn.focus({ preventScroll: true });
    }

    function openSecondaryView(opts) {
      if (isSecondaryOpen) return;
      const fromUserTap = Boolean(opts && opts.fromUserTap);

      if (fromUserTap && location.hash !== '#left-grille') {
        enteredFromMainGrid = true;
        if (global.history && typeof global.history.pushState === 'function') {
          try {
            global.history.pushState({ lgSecondary: true }, '', '#left-grille');
          } catch (_) {}
        }
      }

      if (
        fromUserTap &&
        typeof document.startViewTransition === 'function' &&
        !prefersReducedMotion()
      ) {
        portalCell.style.viewTransitionName = 'lg-stage-portal';
        const vt = document.startViewTransition(() => {
          portalCell.style.viewTransitionName = '';
          secondaryGrid.style.viewTransitionName = 'lg-stage-portal';
          swapDomToSecondary();
        });
        vt.finished
          .catch(() => {})
          .finally(() => {
            secondaryGrid.style.viewTransitionName = '';
          });
      } else {
        swapDomToSecondary();
      }
    }

    function closeSecondaryViewInternal(animate) {
      if (!isSecondaryOpen) return;
      // Deterministically extinguish mic & ultrasonic speaker immediately on leaving secondary page
      controller.stop();

      if (
        animate &&
        typeof document.startViewTransition === 'function' &&
        !prefersReducedMotion()
      ) {
        secondaryGrid.style.viewTransitionName = 'lg-stage-portal';
        const vt = document.startViewTransition(() => {
          secondaryGrid.style.viewTransitionName = '';
          portalCell.style.viewTransitionName = 'lg-stage-portal';
          swapDomToMain();
        });
        vt.finished
          .catch(() => {})
          .finally(() => {
            portalCell.style.viewTransitionName = '';
          });
      } else {
        swapDomToMain();
      }
    }

    function requestCloseSecondaryView() {
      if (!isSecondaryOpen) return;
      if (
        enteredFromMainGrid &&
        location.hash === '#left-grille' &&
        global.history &&
        typeof global.history.back === 'function'
      ) {
        enteredFromMainGrid = false;
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
      closeSecondaryViewInternal(true);
    }

    function syncLocationHash() {
      if (location.hash === '#left-grille') {
        if (!isSecondaryOpen) openSecondaryView({ fromUserTap: false });
      } else if (isSecondaryOpen) {
        closeSecondaryViewInternal(true);
      }
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isSecondaryOpen) {
        e.preventDefault();
        if (calWizardActive || !inlineOverlay.hidden) {
          closeCalibrationWizard();
        } else {
          requestCloseSecondaryView();
        }
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!isSecondaryOpen || controller.state !== 'listening') return;
      if (document.hidden && controller.workletNode) {
        controller.workletNode.port.postMessage({ type: 'setTx', enabled: false, gain: 0 });
      } else if (!document.hidden && controller.txEnabled && controller.workletNode) {
        controller.workletNode.port.postMessage({
          type: 'setTx',
          enabled: true,
          gain: controller.txGain
        });
      }
    });

    global.addEventListener('popstate', syncLocationHash);
    global.addEventListener('hashchange', syncLocationHash);
    global.addEventListener('pagehide', () => controller.stop({ immediate: true, silent: true }));

    // Initial state render & deep-link support
    handleControllerState({
      state: 'idle',
      error: '',
      txEnabled: controller.txEnabled,
      polarity: controller.polarity,
      calibrated: Boolean(controller.calibration),
      sampleRate: 48000
    });

    if (location.hash === '#left-grille') {
      openSecondaryView({ fromUserTap: false });
    }
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
