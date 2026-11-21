(function (global) {
  'use strict';

  const NS = (global.GeminiApiMatrix = global.GeminiApiMatrix || {});
  const KeyStore = NS.KeyStore;
  const Probes = NS.Probes;

  const FILTER_DEFS = [
    { id: 'all', label: 'All' },
    { id: 'core', label: 'Core' },
    { id: 'audio', label: 'Audio & Live' },
    { id: 'media', label: 'Media' },
    { id: 'platform', label: 'Platform' },
    { id: 'passed', label: 'Passed' },
    { id: 'issues', label: 'Issues' }
  ];

  // Tooltip copy (ui/tooltip.js data-tip). One plain sentence per code; status is appended.
  const CODE_TIPS = {
    MOD: 'Models: lists every model your key can use.',
    GEN: 'Generate: one ordinary text request and reply.',
    SSE: 'Streaming: the reply arrives in chunks as it is written.',
    INT: 'Interactions API: multi-turn conversations kept on the server.',
    DEC: 'Decisions API: probabilities for yes/no, category and score questions.',
    SRH: 'Search grounding: answers backed by live Google Search; may cost per query.',
    WSS: 'Live API: real-time audio over a WebSocket connection.',
    TTS: 'Text to speech: Gemini reads text aloud.',
    AUD: 'Audio input: Gemini hears a short test tone and names the sound.',
    LYR: 'Lyria: checks access to the music generation models.',
    EMB: 'Embeddings: turns text into number vectors for search and similarity.',
    TOK: 'Token count: measures input size before you send it; free.',
    IMG: 'Image generation: checks access; making an image is opt-in.',
    VEO: 'Veo: checks video model access without rendering a video.',
    FIL: 'Files API: read-only check of uploaded file storage.',
    CAC: 'Context caching: read-only check of saved prompt caches.',
    BAT: 'Batch API: read-only check of queued bulk jobs.',
    OAI: 'OpenAI compatibility: your key used through OpenAI-style requests.'
  };

  const PROTOCOL_TIPS = {
    REST: 'Ordinary HTTPS request and reply.',
    SSE: 'The reply streams back in chunks.',
    WSS: 'A live two-way WebSocket connection.',
    AUDIO: 'Sends or receives audio inside an HTTPS request.',
    MEDIA: 'Checks a media model is listed; makes nothing by default.'
  };

  const COST_TIPS = {
    free: 'Free: only reads data, changes nothing.',
    micro: 'One very small request; billed only on paid tiers.',
    metered: 'Costs money per call on paid tiers.',
    'opt-in': 'Free check; real generation runs only if you ask, and costs money.'
  };

  // Status words for tooltips and the tile; never colour alone (see .am-led shapes).
  function statusTip(status, res) {
    if (status === 'probing') return 'Testing now.';
    if (status === 'pass') return res && res.latencyMs ? 'Passed in ' + res.latencyMs + ' ms.' : 'Passed.';
    if (status === 'warn') return 'Warning' + (res && res.badge ? ' (' + res.badge + ').' : '.');
    if (status === 'fail') return 'Failed' + (res && res.badge ? ' (' + res.badge + ').' : '.');
    return 'Not tested yet.';
  }

  function setAttr(node, name, value) {
    if (!node) return;
    if (value === null || value === undefined) {
      if (node.hasAttribute(name)) node.removeAttribute(name);
    } else if (node.getAttribute(name) !== String(value)) {
      node.setAttribute(name, String(value));
    }
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'className') node.className = v;
        else if (k === 'textContent') node.textContent = String(v);
        else if (k === 'value') node.value = String(v);
        else if (k === 'checked') node.checked = Boolean(v);
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
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function fallbackCopyText(text, containerEl) {
    return new Promise(function (resolve, reject) {
      const host = containerEl || document.body;
      if (!host) {
        reject(new Error('No DOM container available for clipboard copy.'));
        return;
      }
      const prevFocus = document.activeElement;
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      host.appendChild(ta);
      try {
        ta.focus();
        ta.select();
        const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
        if (!ok) {
          reject(new Error('Clipboard copy command was rejected.'));
          return;
        }
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        if (ta.parentNode) ta.parentNode.removeChild(ta);
        if (prevFocus && prevFocus !== ta && typeof prevFocus.focus === 'function') {
          try { prevFocus.focus(); } catch (_e) {}
        }
      }
    });
  }

  function copyToClipboard(text, containerEl) {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).catch(function () {
        return fallbackCopyText(text, containerEl);
      });
    }
    return fallbackCopyText(text, containerEl);
  }

  // ui-pill tone for a probe status: green only for a real pass (ui/NOTES.md section 0).
  function pillTone(status) {
    if (status === 'pass') return 'ok';
    if (status === 'warn' || status === 'fail' || status === 'probing') return 'attention';
    return null;
  }

  function mountApiMatrixCell(rootEl) {
    if (!rootEl) return undefined;
    if (typeof rootEl._amUnmount === 'function') {
      rootEl._amUnmount();
    }
    const priorDialog = document.getElementById('am-dialog');
    if (priorDialog && typeof priorDialog._amOwnerUnmount === 'function') {
      priorDialog._amOwnerUnmount();
    }
    rootEl.dataset.amMounted = 'true';
    rootEl.classList.add('ui-tile');

    let unmounted = false;
    let announceTimer = null;

    const app = {
      results: Object.create(null),
      probing: Object.create(null),
      batchProbing: Object.create(null),
      statusNotes: Object.create(null),
      objectUrls: Object.create(null), // endpointId -> objectURL
      catalog: Probes.createEmptyCatalog(),
      filter: 'all',
      includeGrounding: true,
      isBatchRunning: false,
      batchCompleted: 0,
      batchTotal: 0,
      batchAbort: null,
      singleAborts: Object.create(null),
      runSeq: 0,
      showKeyEditor: !KeyStore.get(),
      keyVisible: false,
      keyPromptNotice: '',
      drawerMode: null, // null | 'endpoint' | 'models'
      selectedEndpointId: null,
      drawerTab: 'curl', // 'curl' | 'raw'
      modelSearch: '',
      openedFromGrid: false,
      closingViaHistory: false,
      closingProgrammatically: false,
      drawerReturnTarget: null, // { type: 'endpoint', id } | { type: 'models' }
      activeAudioEl: null
    };

    // Storage keys shared with cells/decisions and cells/prosody (read-only here; see probes.js KeyStore).
    const SHARED_KEY_NAMES = ['dc_gemini_api_key_session', 'dc_gemini_api_key_local'];

    const liveRegion = el('div', {
      className: 'ui-sr-only',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true'
    });
    rootEl.appendChild(liveRegion);

    function announce(msg) {
      if (unmounted) return;
      if (announceTimer !== null) clearTimeout(announceTimer);
      liveRegion.textContent = '';
      announceTimer = setTimeout(function () {
        announceTimer = null;
        if (!unmounted) liveRegion.textContent = msg;
      }, 20);
    }

    function revokeMediaUrl(endpointId) {
      if (app.objectUrls[endpointId]) {
        try {
          URL.revokeObjectURL(app.objectUrls[endpointId]);
        } catch (_err) {}
        delete app.objectUrls[endpointId];
      }
    }

    function revokeAllMediaUrls() {
      Object.keys(app.objectUrls).forEach(revokeMediaUrl);
    }

    function stopActiveAudio() {
      if (app.activeAudioEl) {
        try {
          app.activeAudioEl.pause();
          app.activeAudioEl.currentTime = 0;
        } catch (_err) {}
        app.activeAudioEl = null;
      }
    }

    function getCounts() {
      let pass = 0;
      let warn = 0;
      let fail = 0;
      let probing = 0;
      let idle = 0;
      Probes.ENDPOINTS.forEach(function (ep) {
        if (app.probing[ep.id]) {
          probing += 1;
        } else {
          const r = app.results[ep.id];
          if (!r) idle += 1;
          else if (r.status === 'pass') pass += 1;
          else if (r.status === 'warn') warn += 1;
          else if (r.status === 'fail') fail += 1;
          else idle += 1;
        }
      });
      return { pass: pass, warn: warn, fail: fail, probing: probing, idle: idle, total: Probes.ENDPOINTS.length };
    }

    function getEndpointStatus(id) {
      if (app.probing[id]) return 'probing';
      const r = app.results[id];
      return r ? r.status : 'idle';
    }

    function matchesFilter(ep, filterId) {
      if (filterId === 'all') return true;
      if (filterId === 'core' || filterId === 'audio' || filterId === 'media' || filterId === 'platform') {
        return ep.category === filterId;
      }
      const st = getEndpointStatus(ep.id);
      if (filterId === 'passed') return st === 'pass';
      if (filterId === 'issues') return st === 'warn' || st === 'fail';
      return true;
    }

    function getFilteredEndpoints() {
      return Probes.ENDPOINTS.filter(function (ep) {
        return matchesFilter(ep, app.filter);
      });
    }

    function getEndpointDef(id) {
      for (let i = 0; i < Probes.ENDPOINTS.length; i++) {
        if (Probes.ENDPOINTS[i].id === id) return Probes.ENDPOINTS[i];
      }
      return null;
    }

    function storeProbeResult(id, result) {
      revokeMediaUrl(id);
      if (result && result.audioMedia && result.audioMedia.blob && typeof URL !== 'undefined' && URL.createObjectURL) {
        app.objectUrls[id] = URL.createObjectURL(result.audioMedia.blob);
      } else if (result && result.imageMedia && result.imageMedia.blob && typeof URL !== 'undefined' && URL.createObjectURL) {
        app.objectUrls[id] = URL.createObjectURL(result.imageMedia.blob);
      }
      app.results[id] = result;
      if (id === 'models' && result && result.catalog) {
        app.catalog = result.catalog;
      }
    }

    // =========================================================================
    // FULL-VIEWPORT SECONDARY GRID (<dialog>)
    // =========================================================================

    const existingDialog = document.getElementById('am-dialog');
    if (existingDialog && existingDialog.parentNode) {
      existingDialog.parentNode.removeChild(existingDialog);
    }
    const dialog = el('dialog', {
      className: 'ui-dialog am-dialog',
      id: 'am-dialog',
      'aria-labelledby': 'am-heading'
    });
    document.body.appendChild(dialog);

    const refs = {};

    // -------------------------------------------------------------------------
    // Focus preservation across re-renders. Every render function rebuilds its
    // controls, which used to drop keyboard focus to <body> on each probe update,
    // filter click, Stop, Save or window focus. Focusable controls carry a stable
    // data-am-focus key (and optional data-am-focus-fallback); after a render we
    // restore focus only when it fell to body/dialog, never over a deliberate move.
    // -------------------------------------------------------------------------
    let renderDepth = 0;

    function focusWasLost() {
      const a = document.activeElement;
      return !a || a === document.body || a === document.documentElement || a === dialog || !a.isConnected;
    }

    function snapshotFocus() {
      const a = document.activeElement;
      if (!a || !a.dataset || !a.dataset.amFocus) return null;
      if (!dialog.contains(a) && !rootEl.contains(a)) return null;
      return {
        key: a.dataset.amFocus,
        fallback: a.dataset.amFocusFallback || null,
        selStart: typeof a.selectionStart === 'number' ? a.selectionStart : null,
        selEnd: typeof a.selectionEnd === 'number' ? a.selectionEnd : null
      };
    }

    function findFocusable(key) {
      if (!key) return null;
      const scope = dialog.open ? dialog : rootEl;
      const nodes = scope.querySelectorAll('[data-am-focus]');
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.dataset.amFocus === key && !n.disabled && !n.closest('[inert]')) return n;
      }
      return null;
    }

    function restoreFocus(snap) {
      if (!snap || unmounted || !focusWasLost()) return;
      let target = findFocusable(snap.key) || findFocusable(snap.fallback);
      if (!target && app.drawerMode) target = findFocusable('drawer-title');
      if (!target) return;
      try {
        target.focus({ preventScroll: true });
      } catch (_e) {
        target.focus();
      }
      if (snap.selStart !== null && typeof target.setSelectionRange === 'function') {
        try { target.setSelectionRange(snap.selStart, snap.selEnd); } catch (_e) {}
      }
    }

    function preserveFocus(fn) {
      if (renderDepth > 0) return fn();
      const snap = snapshotFocus();
      renderDepth += 1;
      try {
        return fn();
      } finally {
        renderDepth -= 1;
        restoreFocus(snap);
      }
    }

    function buildDialogShell() {
      clearNode(dialog);

      const topbar = el('header', { className: 'ui-studio-bar am-topbar' });
      const keybar = el('section', { className: 'am-keybar', 'aria-label': 'Gemini API Key configuration' });
      const filterBar = el('nav', { className: 'am-filter-bar', 'aria-label': 'Filter API endpoints' });
      const gridScroll = el('div', { className: 'am-grid-scroll' });
      const gridContainer = el('div', { className: 'am-grid-container' });
      gridScroll.appendChild(gridContainer);

      const mainWrap = el('div', { className: 'am-shell' }, [
        topbar,
        keybar,
        filterBar,
        gridScroll
      ]);

      const scrim = el('div', {
        className: 'am-scrim',
        hidden: true,
        onClick: function (e) {
          if (e.target === scrim) closeDrawer();
        }
      });
      const drawer = el('aside', {
        className: 'am-drawer',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'am-drawer-title'
      });
      scrim.appendChild(drawer);

      refs.topbar = topbar;
      refs.keybar = keybar;
      refs.filterBar = filterBar;
      refs.gridContainer = gridContainer;
      refs.mainWrap = mainWrap;
      refs.scrim = scrim;
      refs.drawer = drawer;

      dialog.appendChild(mainWrap);
      dialog.appendChild(scrim);
    }

    function syncRunningClass() {
      const anyRunning = app.isBatchRunning || Object.keys(app.probing).length > 0;
      rootEl.classList.toggle('is-running', anyRunning);
      dialog.classList.toggle('is-running', anyRunning);
    }

    // =========================================================================
    // 1. RENDER PRIMARY CELL #4 (4:3 IN-GRID INSTRUMENT)
    // =========================================================================

    // Built once, then patched in place: a rebuild detached the hovered probe and closed its
    // tooltip on every probe update, and patching keeps focus on the trigger for free.
    const tile = { trigger: null, pill: null, pillLabel: null, probes: Object.create(null), tally: null };

    function buildPrimaryCell() {
      tile.pillLabel = el('span', { className: 'ui-pill-label am-pill-label' });
      tile.pill = el('span', { className: 'ui-pill am-tile-pill' }, [tile.pillLabel]);

      const matrix = el('span', { className: 'am-micro-grid' });
      tile.probes = Object.create(null);
      Probes.ENDPOINTS.forEach(function (ep) {
        const led = el('span', { className: 'am-led', 'aria-hidden': 'true' });
        const node = el('span', { className: 'am-micro-tile', dataset: { endpointCode: ep.code } }, [
          led,
          el('span', { className: 'am-micro-code', textContent: ep.code })
        ]);
        tile.probes[ep.id] = { node: node, led: led };
        matrix.appendChild(node);
      });

      tile.tally = el('span', { className: 'am-tally', 'data-tip': 'Probe results: passed, warned, failed, and not tested.' });

      tile.trigger = el(
        'button',
        {
          type: 'button',
          className: 'ui-tile-trigger am-cell-trigger',
          dataset: { amFocus: 'trigger' },
          'aria-haspopup': 'dialog',
          'aria-controls': 'am-dialog',
          onClick: function () {
            openSecondaryGrid({ fromDeepLink: false });
          }
        },
        [
          el('span', { className: 'ui-tile-head' }, [
            el('span', { className: 'ui-tile-index', textContent: '04' }),
            el('span', { className: 'ui-tile-title', textContent: 'API Matrix' }),
            el('span', { className: 'ui-tile-actions' }, [
              tile.pill,
              el('span', { className: 'ui-btn ui-btn--sm am-open-cue ui-hide-tiny', 'aria-hidden': 'true', textContent: 'Grid ↗' })
            ])
          ]),
          el('span', { className: 'ui-tile-body am-bay', 'aria-hidden': 'true' }, [matrix]),
          el('span', { className: 'ui-tile-foot', 'aria-hidden': 'true' }, [
            el('span', { className: 'ui-truncate am-host', textContent: 'generativelanguage.googleapis.com' }),
            tile.tally
          ])
        ]
      );

      let child = rootEl.firstChild;
      while (child) {
        const next = child.nextSibling;
        if (child !== liveRegion) rootEl.removeChild(child);
        child = next;
      }
      if (liveRegion.parentNode !== rootEl) {
        rootEl.insertBefore(liveRegion, rootEl.firstChild);
      }
      rootEl.appendChild(tile.trigger);
    }

    function renderTally(counts, anyProbed) {
      const parts = anyProbed || counts.probing > 0
        ? [['pass', counts.pass], ['warn', counts.warn], ['fail', counts.fail], ['idle', counts.idle + counts.probing]]
        : null;
      const key = parts ? parts.map(function (p) { return p[0] + p[1]; }).join(' ') : 'total';
      if (tile.tally.dataset.key === key) return;
      tile.tally.dataset.key = key;
      clearNode(tile.tally);
      if (!parts) {
        tile.tally.appendChild(document.createTextNode(counts.total + ' APIs'));
        return;
      }
      parts.forEach(function (p) {
        tile.tally.appendChild(
          el('span', { className: 'am-tally-item' }, [
            el('span', { className: 'am-led', dataset: { status: p[0] } }),
            el('span', { className: 'am-tally-n', textContent: String(p[1]) })
          ])
        );
      });
    }

    function renderPrimaryCell() {
      if (unmounted) return;
      const hasKey = Boolean(KeyStore.get());
      const counts = getCounts();
      const anyProbed = counts.pass + counts.warn + counts.fail > 0;

      let tone = null;
      let label = hasKey ? 'Key set' : 'No key';
      let tip = hasKey
        ? 'Key saved; nothing tested yet. Open the grid to run the probes.'
        : 'No API key yet. Open the grid to add one.';
      if (counts.probing > 0) {
        tone = 'attention';
        label = 'Running';
        tip = app.isBatchRunning
          ? 'Testing APIs: ' + app.batchCompleted + ' of ' + app.batchTotal + ' done. Open the grid to watch.'
          : 'A probe is running. Open the grid to watch or stop it.';
      } else if (anyProbed) {
        if (counts.fail > 0) {
          tone = 'attention';
          label = 'Error';
          tip = counts.fail + ' of ' + counts.total + ' APIs failed. Open the grid for the reason.';
        } else if (counts.warn > 0) {
          tone = 'attention';
          label = 'Error';
          tip = counts.warn + ' of ' + counts.total + ' APIs answered with a warning. Open the grid for details.';
        } else {
          tone = 'ok';
          label = 'Live';
          tip = 'Your key works: ' + counts.pass + ' of ' + counts.total + ' APIs passed. Open the grid for timings.';
        }
      }

      const ariaSummary =
        '04 API Matrix: ' +
        (hasKey ? 'API key configured. ' : 'No API key set. ') +
        (counts.probing > 0 ? counts.probing + ' testing, ' : '') +
        counts.pass +
        ' passed, ' +
        counts.warn +
        ' warnings, ' +
        counts.fail +
        ' failed, ' +
        counts.idle +
        ' not tested. Open the API status grid.';

      if (!tile.trigger || tile.trigger.parentNode !== rootEl) buildPrimaryCell();

      setAttr(tile.trigger, 'aria-label', ariaSummary);
      setAttr(tile.pill, 'data-tone', tone);
      setAttr(tile.pill, 'data-tip', tip);
      setText(tile.pillLabel, label);

      Probes.ENDPOINTS.forEach(function (ep) {
        const ref = tile.probes[ep.id];
        if (!ref) return;
        const st = getEndpointStatus(ep.id);
        setAttr(ref.node, 'data-status', st);
        setAttr(ref.led, 'data-status', st);
        setAttr(ref.node, 'data-tip', (CODE_TIPS[ep.code] || ep.name + '.') + ' ' + statusTip(st, app.results[ep.id]));
      });

      renderTally(counts, anyProbed);
      syncRunningClass();
    }

    // =========================================================================
    // 2. RENDER SECONDARY GRID SECTIONS
    // =========================================================================

    // Result summary for the studio bar: the same dot shapes as the tile, so it is also the legend.
    function buildSummary(counts) {
      const items = [
        ['pass', counts.pass, 'passed'],
        ['warn', counts.warn, 'warning'],
        ['fail', counts.fail, 'failed'],
        ['idle', counts.idle + counts.probing, 'not tested']
      ];
      return el(
        'div',
        {
          className: 'am-summary',
          role: 'group',
          'aria-label': 'Probe summary',
          'data-tip': 'Results of the probes so far; the dot shapes match the cards and the tile.'
        },
        items.map(function (it) {
          return el('span', { className: 'am-summary-item', dataset: { status: it[0] } }, [
            el('span', { className: 'am-led', dataset: { status: it[0] }, 'aria-hidden': 'true' }),
            el('span', { className: 'am-summary-n', textContent: String(it[1]) }),
            el('span', { className: 'am-summary-word', textContent: it[2] })
          ]);
        })
      );
    }

    function renderTopbar() {
      if (!refs.topbar) return;
      clearNode(refs.topbar);

      const hasKey = Boolean(KeyStore.get());
      const counts = getCounts();
      const modelCount = app.catalog.models.length;

      const backBtn = el('button', {
        type: 'button',
        className: 'ui-btn am-close',
        dataset: { amFocus: 'back' },
        'data-tip': 'Back to the grid.',
        'data-tip-key': 'Esc',
        textContent: 'Close',
        onClick: function () {
          closeSecondaryGrid();
        }
      });

      const modelsBtn = el('button', {
        type: 'button',
        className: 'ui-btn ui-btn--sm',
        dataset: { action: 'models', amFocus: 'models' },
        textContent: modelCount ? modelCount + ' models' : 'Models',
        'data-tip': modelCount
          ? 'Browse the models your key can use, from the last Models probe.'
          : 'No models listed yet; run Models or Run all to fill this list.',
        onClick: function () {
          openModelsDrawer();
        }
      });

      const keyToggleBtn = el('button', {
        type: 'button',
        className: 'ui-btn ui-btn--sm am-key-toggle',
        dataset: { amFocus: 'key-toggle' },
        'aria-expanded': hasKey ? String(app.showKeyEditor) : null, // kept in step by renderKeybar
        textContent: hasKey ? 'Key ' + KeyStore.mask(KeyStore.get()) : '+ API key',
        'data-tip': hasKey
          ? 'Show or hide the key editor; the key stays masked.'
          : 'Paste a Google AI Studio key; the other Gemini tiles share it.',
        onClick: function () {
          // With no key the editor is the only keybar state, so this control always opens it
          // (a plain toggle made the first click a no-op).
          app.showKeyEditor = KeyStore.get() ? !app.showKeyEditor : true;
          if (!app.showKeyEditor) app.keyVisible = false;
          app.keyPromptNotice = '';
          renderKeybar();
          if (app.showKeyEditor && refs.keyInput) refs.keyInput.focus();
        }
      });

      const runBtn = app.isBatchRunning
        ? el('button', {
            type: 'button',
            className: 'ui-btn ui-btn--sm am-run',
            'data-tone': 'attention',
            dataset: { amFocus: 'run' },
            'data-tip': 'Stop the run; results that already came back are kept.',
            textContent: 'Stop ' + app.batchCompleted + '/' + app.batchTotal,
            onClick: cancelAllRuns
          })
        : el('button', {
            type: 'button',
            className: 'ui-btn ui-btn--sm ui-btn--primary am-run',
            dataset: { amFocus: 'run' },
            'data-tip': 'Test every API in turn; some send tiny paid requests, image and video stay checks only.',
            textContent: 'Run all',
            onClick: function () {
              startBatchRun();
            }
          });

      const copyMdBtn = el('button', {
        type: 'button',
        className: 'ui-btn ui-btn--sm ui-btn--quiet am-copy',
        dataset: { amFocus: 'copy-md' },
        textContent: 'Copy MD',
        'data-tip': 'Copy the results as a Markdown table; the key is redacted.',
        onClick: function () {
          const md = Probes.buildMarkdownSummary(app.results, app.catalog, KeyStore.get());
          copyToClipboard(md, dialog.open ? dialog : document.body)
            .then(function () {
              copyMdBtn.textContent = 'Copied ✓';
              setTimeout(function () { copyMdBtn.textContent = 'Copy MD'; }, 1500);
            })
            .catch(function () {
              copyMdBtn.textContent = 'Copy failed';
              setTimeout(function () { copyMdBtn.textContent = 'Copy MD'; }, 1500);
            });
        }
      });

      const exportJsonBtn = el('button', {
        type: 'button',
        className: 'ui-btn ui-btn--sm ui-btn--quiet',
        dataset: { amFocus: 'export' },
        textContent: 'JSON ↓',
        'aria-label': 'Export JSON',
        'data-tip': 'Download the results as a JSON file; the key is redacted.',
        onClick: function () {
          const json = Probes.buildExportReport(app.results, app.catalog, KeyStore.get());
          const blob = new Blob([json], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'gemini-api-matrix-report.json';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        }
      });

      refs.topbar.appendChild(el('span', { className: 'ui-tile-index', textContent: '04' }));
      refs.topbar.appendChild(el('h1', { id: 'am-heading', className: 'ui-studio-title am-heading', textContent: 'Gemini API Matrix' }));
      refs.topbar.appendChild(buildSummary(counts));
      refs.topbar.appendChild(
        el('div', { className: 'ui-studio-actions am-actions' }, [
          copyMdBtn,
          exportJsonBtn,
          modelsBtn,
          keyToggleBtn,
          runBtn
        ])
      );
      refs.topbar.appendChild(backBtn);
    }

    function renderKeybar() {
      if (!refs.keybar) return;
      // Keep unsaved typing when the editor stays open across a re-render (another cell's
      // gemini-key-changed / storage event, a failed save, or a probe prompt).
      // Only text the user changed counts as a draft; an untouched field re-reads the store so an
      // external clear/change is not overwritten by the stale key that was rendered into it.
      const draft = refs.keyInput && app.showKeyEditor && refs.keyInput.value !== refs.keyInputRendered
        ? refs.keyInput.value
        : null;
      const draftPersist = draft !== null && refs.persistCb ? refs.persistCb.checked : null;
      clearNode(refs.keybar);
      refs.keyInput = null;
      refs.persistCb = null;

      const currentKey = KeyStore.get();
      const storageType = KeyStore.getStorageType();

      const inner = el('div', { className: 'am-keybar-inner' });

      if (currentKey && !app.showKeyEditor) {
        const storageLabel =
          storageType === 'local'
            ? 'Saved on this device'
            : storageType === 'session'
              ? 'Saved for this tab'
              : 'In memory only';
        const storageTip =
          storageType === 'local'
            ? 'Kept in this browser\'s localStorage after the tab closes.'
            : storageType === 'session'
              ? 'Kept in sessionStorage; forgotten when this tab closes.'
              : 'Browser storage is blocked; forgotten when this page reloads.';

        inner.appendChild(
          el('div', { className: 'am-keybar-compact' }, [
            el('span', {
              className: 'ui-pill',
              'data-tip': 'A key is saved. Probes show whether it works.'
            }, [el('span', { className: 'ui-pill-label', textContent: 'Key set' })]),
            el('span', { className: 'ui-readout am-key-mask', textContent: KeyStore.mask(currentKey) }),
            el('span', { className: 'am-key-note', 'data-tip': storageTip, textContent: storageLabel + ', shared with Decisions and Prosody' }),
            el('span', { className: 'am-keybar-actions' }, [
              el('button', {
                type: 'button',
                className: 'ui-btn ui-btn--sm',
                dataset: { amFocus: 'key-change' },
                textContent: 'Change key',
                onClick: function () {
                  app.showKeyEditor = true;
                  renderKeybar();
                  if (refs.keyInput) refs.keyInput.focus();
                }
              }),
              el('button', {
                type: 'button',
                className: 'ui-btn ui-btn--sm ui-btn--quiet',
                'data-tip': 'Forget the key in this browser for every Gemini tile; stops running probes.',
                textContent: 'Clear',
                onClick: function () {
                  cancelAllRuns();
                  KeyStore.clear();
                  app.showKeyEditor = true;
                  app.keyVisible = false;
                  app.keyPromptNotice = 'Key cleared from browser storage.';
                  renderAll();
                  if (refs.keyInput) refs.keyInput.focus();
                }
              })
            ])
          ])
        );
      } else {
        const keyInput = el('input', {
          type: app.keyVisible ? 'text' : 'password',
          className: 'am-input',
          dataset: { amFocus: 'key-input', amFocusFallback: 'key-change' },
          value: draft !== null ? draft : currentKey,
          placeholder: 'Paste a Google AI Studio key (AIza…)',
          autocomplete: 'off',
          spellcheck: 'false',
          'data-1p-ignore': 'true',
          'data-lpignore': 'true',
          'aria-label': 'Google AI Studio Gemini API key'
        });
        refs.keyInput = keyInput;
        refs.keyInputRendered = keyInput.value;

        const persistCb = el('input', {
          type: 'checkbox',
          dataset: { amFocus: 'key-persist' },
          checked: draftPersist !== null ? draftPersist : storageType === 'local'
        });
        refs.persistCb = persistCb;

        function saveCurrentKey(andRun) {
          const check = Probes.validateApiKey(keyInput.value);
          if (!check.ok) {
            app.keyPromptNotice = check.error;
            renderKeybar();
            if (refs.keyInput) refs.keyInput.focus();
            return;
          }
          KeyStore.set(check.key, persistCb.checked);
          app.showKeyEditor = false;
          app.keyVisible = false;
          app.keyPromptNotice = '';
          renderAll();
          if (andRun) startBatchRun();
        }

        const showToggleBtn = el('button', {
          type: 'button',
          className: 'ui-btn ui-btn--sm am-show',
          dataset: { amFocus: 'key-show' },
          'aria-pressed': String(app.keyVisible),
          'data-tip': 'Show or hide the key while you type.',
          textContent: app.keyVisible ? 'Hide' : 'Show',
          onClick: function () {
            app.keyVisible = !app.keyVisible;
            keyInput.type = app.keyVisible ? 'text' : 'password';
            showToggleBtn.textContent = app.keyVisible ? 'Hide' : 'Show';
            showToggleBtn.setAttribute('aria-pressed', String(app.keyVisible));
          }
        });

        const form = el(
          'form',
          {
            className: 'am-key-form',
            onSubmit: function (e) {
              e.preventDefault();
              saveCurrentKey(true);
            }
          },
          [
            el('span', { className: 'am-key-field' }, [keyInput, showToggleBtn]),
            el('label', {
              className: 'am-checkbox-row',
              'data-tip': 'Keep the key after this tab closes, stored in this browser.'
            }, [persistCb, 'Remember on this device']),
            el('span', { className: 'am-keybar-actions' }, [
              currentKey
                ? el('button', {
                    type: 'button',
                    className: 'ui-btn ui-btn--sm ui-btn--quiet',
                    dataset: { amFocus: 'key-cancel', amFocusFallback: 'key-change' },
                    textContent: 'Cancel',
                    onClick: function () {
                      app.showKeyEditor = false;
                      app.keyVisible = false;
                      app.keyPromptNotice = '';
                      preserveFocus(renderKeybar);
                    }
                  })
                : null,
              el('button', {
                type: 'button',
                className: 'ui-btn ui-btn--sm',
                dataset: { amFocus: 'key-save', amFocusFallback: 'key-change' },
                'data-tip': 'Save the key without running any probe.',
                textContent: 'Save key',
                onClick: function () {
                  saveCurrentKey(false);
                }
              }),
              el('button', {
                type: 'submit',
                className: 'ui-btn ui-btn--sm',
                dataset: { amFocus: 'key-saverun', amFocusFallback: 'key-change' },
                'data-tip': 'Save the key, then test every API in turn.',
                'data-tip-key': 'Enter',
                textContent: 'Save & run all'
              })
            ])
          ]
        );

        const note = el('p', { className: 'am-key-note' }, [
          'Requests go straight from this browser to ',
          el('code', { className: 'am-mono', textContent: 'generativelanguage.googleapis.com' }),
          ' in the ',
          el('code', { className: 'am-mono', textContent: 'x-goog-api-key' }),
          ' header, shared with Decisions and Prosody. Antigravity logins have no raw key; create one at ',
          el('a', {
            href: 'https://aistudio.google.com/apikey',
            target: '_blank',
            rel: 'noopener noreferrer',
            'data-tip': 'Opens Google AI Studio in a new tab.',
            textContent: 'aistudio.google.com/apikey'
          }),
          '. Exports always redact the key.'
        ]);

        inner.appendChild(form);
        if (KeyStore.isStorageRestricted()) {
          inner.appendChild(
            el('div', {
              className: 'am-key-note',
              textContent: 'Browser storage is blocked on this origin; the key stays in memory until the page reloads.'
            })
          );
        }
        if (app.keyPromptNotice) {
          inner.appendChild(el('div', { className: 'am-inline-alert', role: 'alert', textContent: app.keyPromptNotice }));
        }
        inner.appendChild(note);
      }

      refs.keybar.appendChild(inner);
      // Several paths re-render only the key row (Change key, Cancel, key prompt, halted batch);
      // keep the studio-bar key button's expanded state in step with it here.
      const keyToggle = refs.topbar && refs.topbar.querySelector('[data-am-focus="key-toggle"]');
      setAttr(keyToggle, 'aria-expanded', currentKey ? String(app.showKeyEditor) : null);
    }

    const FILTER_TIPS = {
      core: 'Models, text generation, streaming, interactions, decisions and search.',
      audio: 'Live WebSocket, text to speech, audio input and music.',
      media: 'Embeddings, token count, image and video.',
      platform: 'Files, context caching, batch jobs and OpenAI compatibility.',
      passed: 'Only the APIs whose last probe passed.',
      issues: 'Only the APIs whose last probe warned or failed.'
    };

    function renderFilterBar() {
      if (!refs.filterBar) return;
      clearNode(refs.filterBar);

      const filterGroup = el('div', { className: 'ui-seg am-filters', role: 'group', 'aria-label': 'Filter endpoints' });
      FILTER_DEFS.forEach(function (f) {
        const count = Probes.ENDPOINTS.filter(function (ep) {
          return matchesFilter(ep, f.id);
        }).length;
        filterGroup.appendChild(
          el(
            'button',
            {
              type: 'button',
              className: 'am-filter-pill',
              dataset: { amFocus: 'filter:' + f.id },
              'aria-pressed': String(app.filter === f.id),
              'data-tip': FILTER_TIPS[f.id] || null,
              onClick: function () {
                app.filter = f.id;
                preserveFocus(function () {
                  renderFilterBar();
                  renderSecondaryGridCards();
                });
              }
            },
            [f.label, el('span', { className: 'am-filter-count', textContent: String(count) })]
          )
        );
      });

      const groundingCb = el('input', {
        type: 'checkbox',
        dataset: { amFocus: 'grounding' },
        checked: app.includeGrounding,
        onChange: function (e) {
          app.includeGrounding = e.target.checked;
        }
      });

      const controls = el('div', { className: 'am-filter-controls' }, [
        el('label', {
          className: 'am-checkbox-row',
          'data-tip': 'Search grounding can charge per query on paid tiers; untick to skip it.'
        }, [groundingCb, 'Include Search in Run all']),
        el('button', {
          type: 'button',
          className: 'ui-btn ui-btn--sm ui-btn--quiet',
          dataset: { amFocus: 'reset' },
          'data-tip': 'Clear every result and stop running probes; the key stays.',
          textContent: 'Reset results',
          onClick: function () {
            cancelAllRuns();
            stopActiveAudio();
            revokeAllMediaUrls();
            app.results = Object.create(null);
            app.statusNotes = Object.create(null);
            app.catalog = Probes.createEmptyCatalog();
            renderAll();
          }
        })
      ]);

      refs.filterBar.appendChild(
        el('div', { className: 'am-filter-inner' }, [filterGroup, controls])
      );
    }

    function cardStatusTip(status, hasKey) {
      if (status === 'probing') return 'Probe running now.';
      if (status === 'pass') return 'Passed: the API answered correctly.';
      if (status === 'warn') return 'Answered with a warning; Inspect shows why.';
      if (status === 'fail') return 'Failed; Inspect shows the reason and next step.';
      return hasKey ? 'Not tested yet; Test runs this probe alone.' : 'Needs an API key before it can run.';
    }

    function renderSecondaryGridCards() {
      if (!refs.gridContainer) return;
      clearNode(refs.gridContainer);

      const filtered = getFilteredEndpoints();
      if (!filtered.length) {
        refs.gridContainer.appendChild(
          el('div', { className: 'am-empty-filter' }, [
            el('div', { textContent: 'No APIs match the ' + (FILTER_DEFS.find(function (f) { return f.id === app.filter; }) || { label: app.filter }).label + ' filter yet.' }),
            el('button', {
              type: 'button',
              className: 'ui-btn ui-btn--sm',
              dataset: { amFocus: 'show-all', amFocusFallback: 'filter:all' },
              textContent: 'Show all ' + Probes.ENDPOINTS.length,
              onClick: function () {
                app.filter = 'all';
                preserveFocus(function () {
                  renderFilterBar();
                  renderSecondaryGridCards();
                });
              }
            })
          ])
        );
        return;
      }

      const grid = el('div', { className: 'am-sec-grid' });
      const hasKey = Boolean(KeyStore.get());

      filtered.forEach(function (ep) {
        const isProbing = Boolean(app.probing[ep.id]);
        const res = app.results[ep.id];
        const status = getEndpointStatus(ep.id);
        const note = app.statusNotes[ep.id];

        let pillText = hasKey ? 'Not tested' : 'Key req';
        if (isProbing) pillText = 'Probing';
        else if (res) pillText = res.badge || status.toUpperCase();

        const modelLine = res && res.modelUsed
          ? res.modelUsed
          : ep.endpointTemplate;

        const summaryLine = isProbing
          ? (note || 'Sending live probe to generativelanguage.googleapis.com…')
          : res
            ? res.summary
            : ep.description;

        const latencyText = isProbing
          ? 'running…'
          : res && res.latencyMs
            ? res.latencyMs + ' ms'
            : ep.costTier === 'opt-in'
              ? '$0 meta · opt-in gen'
              : ep.costTier === 'free'
                ? '$0 read-only'
                : 'untested';
        const latencyTip = res && res.latencyMs && !isProbing
          ? 'Round-trip time of the last probe, in milliseconds.'
          : !isProbing && (ep.costTier === 'opt-in' || ep.costTier === 'free')
            ? COST_TIPS[ep.costTier]
            : null;

        const barPct = res && res.latencyMs
          ? Math.max(8, Math.min(100, Math.round((res.latencyMs / 2500) * 100)))
          : 0;

        const isSelected = app.drawerMode === 'endpoint' && app.selectedEndpointId === ep.id;

        const card = el(
          'article',
          {
            className: 'am-api-card',
            dataset: { status: status, endpointId: ep.id },
            'aria-current': isSelected ? 'true' : null,
            onClick: function (e) {
              if (e.target && e.target.closest('button')) return;
              openEndpointDrawer(ep.id);
            }
          },
          [
            el('div', { className: 'am-api-top' }, [
              el('div', { className: 'am-api-tags' }, [
                el('span', { className: 'am-tag am-tag--code', 'data-tip': CODE_TIPS[ep.code] || null, textContent: ep.code }),
                el('span', { className: 'am-tag', 'data-tip': PROTOCOL_TIPS[ep.protocol] || null, textContent: ep.protocol }),
                ep.costTier === 'opt-in'
                  ? el('span', { className: 'am-tag am-tag--cost', 'data-tip': 'Real generation runs only if you turn it on; it costs money.', textContent: 'OPT-IN GEN' })
                  : ep.costTier === 'metered'
                    ? el('span', { className: 'am-tag am-tag--cost', 'data-tip': COST_TIPS.metered, textContent: 'METERED' })
                    : null
              ]),
              el('span', {
                className: 'ui-pill am-card-pill',
                'data-tone': pillTone(status),
                'data-tip': cardStatusTip(status, hasKey)
              }, [el('span', { className: 'ui-pill-label', textContent: pillText })])
            ]),
            el('div', { className: 'am-api-mid' }, [
              el('div', { className: 'am-api-name', textContent: ep.name }),
              el('div', { className: 'am-api-model', textContent: modelLine, 'data-tip': modelLine })
            ]),
            el('div', { className: 'am-api-summary', textContent: summaryLine, 'data-tip': summaryLine }),
            el('div', { className: 'am-api-foot' }, [
              el('div', { className: 'am-latency-wrap' }, [
                el('span', { className: 'am-latency-val', 'data-tip': latencyTip, textContent: latencyText }),
                barPct > 0
                  ? el('div', { className: 'am-latency-track', 'aria-hidden': 'true' }, [
                      el('div', { className: 'am-latency-fill', style: { width: barPct + '%' } })
                    ])
                  : null
              ]),
              el('div', { className: 'am-api-actions' }, [
                el('button', {
                  type: 'button',
                  className: 'ui-btn ui-btn--sm',
                  dataset: { amFocus: 'test:' + ep.id, amFocusFallback: 'inspect:' + ep.id },
                  disabled: isProbing || app.isBatchRunning,
                  textContent: isProbing ? '…' : 'Test',
                  'aria-label': 'Test ' + ep.name,
                  'data-tip': isProbing
                    ? 'This probe is running now.'
                    : app.isBatchRunning
                      ? 'Run all is in progress; stop it to test one API.'
                      : 'Run this probe alone.',
                  onClick: function (e) {
                    e.stopPropagation();
                    runSingleEndpoint(ep.id, false);
                  }
                }),
                el('button', {
                  type: 'button',
                  className: 'ui-btn ui-btn--sm ui-btn--quiet am-inspect-btn',
                  dataset: { amFocus: 'inspect:' + ep.id },
                  textContent: 'Inspect',
                  'aria-label': 'Inspect ' + ep.name,
                  'data-tip': 'Open the request, response and timing for this API.',
                  onClick: function (e) {
                    e.stopPropagation();
                    openEndpointDrawer(ep.id);
                  }
                })
              ])
            ])
          ]
        );

        grid.appendChild(card);
      });

      refs.gridContainer.appendChild(grid);
    }

    // =========================================================================
    // 3. INSPECTOR DRAWER & DISCOVERED MODELS BROWSER
    // =========================================================================

    function renderDrawer(opts) {
      if (!refs.scrim || !refs.drawer) return;
      const focusNav = opts && opts.focusNav ? opts.focusNav : null;
      const viewKey = app.drawerMode === 'models'
        ? 'models'
        : app.drawerMode === 'endpoint'
          ? 'endpoint:' + app.selectedEndpointId
          : '';
      // A re-render of the same view (probe progress, key/storage events) keeps the reader's
      // scroll position and any playing TTS audio; switching views resets both.
      const sameView = Boolean(viewKey) && refs.drawer.dataset.amView === viewKey;
      const prevBody = refs.drawer.querySelector('.am-drawer-body');
      const keepScroll = sameView && prevBody ? prevBody.scrollTop : 0;
      if (!sameView) stopActiveAudio();
      refs.drawer.dataset.amView = viewKey;

      if (!app.drawerMode) {
        refs.scrim.hidden = true;
        if (refs.mainWrap) refs.mainWrap.inert = false;
        clearNode(refs.drawer);
        return;
      }

      refs.scrim.hidden = false;
      if (refs.mainWrap) refs.mainWrap.inert = true;
      clearNode(refs.drawer);

      function restoreDrawerScroll() {
        const nextBody = refs.drawer.querySelector('.am-drawer-body');
        if (nextBody && keepScroll > 0) nextBody.scrollTop = keepScroll;
      }

      if (app.drawerMode === 'models') {
        renderModelsDrawerContent();
        restoreDrawerScroll();
        return;
      }

      const ep = getEndpointDef(app.selectedEndpointId);
      if (!ep) {
        closeDrawer();
        return;
      }

      const filtered = getFilteredEndpoints();
      const idx = filtered.findIndex(function (x) { return x.id === ep.id; });
      const prevEp = idx > 0 ? filtered[idx - 1] : null;
      const nextEp = idx >= 0 && idx < filtered.length - 1 ? filtered[idx + 1] : null;

      const isProbing = Boolean(app.probing[ep.id]);
      const res = app.results[ep.id];
      const status = getEndpointStatus(ep.id);

      const prevBtn = el('button', {
        type: 'button',
        className: 'ui-btn ui-btn--sm ui-btn--icon',
        dataset: { nav: 'prev', amFocus: 'nav-prev', amFocusFallback: 'nav-next' },
        disabled: !prevEp,
        'aria-label': 'Previous endpoint',
        'data-tip': prevEp ? 'Previous API: ' + prevEp.name + '.' : 'This is the first API in the list.',
        'data-tip-key': prevEp ? 'ArrowLeft' : null,
        textContent: '←',
        onClick: function () {
          if (prevEp) {
            app.selectedEndpointId = prevEp.id;
            app.drawerReturnTarget = { type: 'endpoint', id: prevEp.id };
            renderSecondaryGridCards();
            renderDrawer({ focusNav: 'prev' });
          }
        }
      });

      const nextBtn = el('button', {
        type: 'button',
        className: 'ui-btn ui-btn--sm ui-btn--icon',
        dataset: { nav: 'next', amFocus: 'nav-next', amFocusFallback: 'nav-prev' },
        disabled: !nextEp,
        'aria-label': 'Next endpoint',
        'data-tip': nextEp ? 'Next API: ' + nextEp.name + '.' : 'This is the last API in the list.',
        'data-tip-key': nextEp ? 'ArrowRight' : null,
        textContent: '→',
        onClick: function () {
          if (nextEp) {
            app.selectedEndpointId = nextEp.id;
            app.drawerReturnTarget = { type: 'endpoint', id: nextEp.id };
            renderSecondaryGridCards();
            renderDrawer({ focusNav: 'next' });
          }
        }
      });

      const head = el('div', { className: 'am-drawer-head' }, [
        el('div', { className: 'am-drawer-title-group' }, [
          el('span', { className: 'am-tag am-tag--code', 'data-tip': CODE_TIPS[ep.code] || null, textContent: ep.code }),
          el('h2', { id: 'am-drawer-title', className: 'am-drawer-title', tabindex: '-1', dataset: { amFocus: 'drawer-title' }, textContent: ep.name })
        ]),
        el('div', { className: 'am-drawer-nav' }, [
          prevBtn,
          nextBtn,
          el('button', {
            type: 'button',
            className: 'ui-btn ui-btn--sm ui-btn--primary am-retest',
            dataset: { amFocus: 'retest' },
            disabled: isProbing || app.isBatchRunning,
            'data-tip': isProbing
              ? 'This probe is running now.'
              : app.isBatchRunning
                ? 'Run all is in progress; stop it to re-test one API.'
                : 'Run this probe again.',
            textContent: isProbing ? 'Running…' : 'Re-test',
            onClick: function () {
              runSingleEndpoint(ep.id, false);
            }
          }),
          el('button', {
            type: 'button',
            className: 'ui-btn ui-btn--sm',
            dataset: { amFocus: 'drawer-close' },
            'aria-label': 'Close inspector',
            'data-tip': 'Back to the API list.',
            'data-tip-key': 'Esc',
            textContent: 'Close',
            onClick: closeDrawer
          })
        ])
      ]);

      const body = el('div', { className: 'am-drawer-body' });

      // Status & Remediation Callout
      const callout = el('div', { className: 'am-callout', dataset: { tone: status } }, [
        el('div', { className: 'am-callout-head' }, [
          el('span', {
            className: 'ui-pill',
            'data-tone': pillTone(status),
            'data-tip': statusTip(status, res)
          }, [el('span', { className: 'ui-pill-label', textContent: isProbing ? 'Probing' : res ? res.badge : 'Not tested' })]),
          el('span', {
            className: 'ui-readout ui-readout--quiet',
            'data-tip': res && res.httpStatus
              ? 'Status code the server returned for the last probe.'
              : PROTOCOL_TIPS[ep.protocol] || null,
            textContent: res && res.httpStatus ? (ep.protocol === 'WSS' ? 'WS ' + res.httpStatus : 'HTTP ' + res.httpStatus) : ep.protocol
          })
        ]),
        el('div', { className: 'am-callout-text', textContent: isProbing ? (app.statusNotes[ep.id] || 'Waiting for response…') : res ? res.summary : ep.description }),
        res && res.remediation
          ? el('div', { className: 'am-callout-next', textContent: 'Next step: ' + res.remediation })
          : null
      ]);
      body.appendChild(callout);

      // Opt-in live Image Generation control
      if (ep.supportsLiveGen) {
        body.appendChild(
          el('div', { className: 'am-callout', dataset: { tone: 'optin' } }, [
            el('div', { className: 'am-callout-head' }, [
              el('span', { className: 'am-callout-title', textContent: 'Opt-in image generation' }),
              el('button', {
                type: 'button',
                className: 'ui-btn ui-btn--sm',
                dataset: { amFocus: 'livegen' },
                disabled: isProbing || app.isBatchRunning,
                'data-tip': isProbing || app.isBatchRunning
                  ? 'Wait for the running probe to finish.'
                  : 'Make one real image with this model; it costs money.',
                textContent: isProbing ? 'Generating…' : 'Generate image',
                onClick: function () {
                  runSingleEndpoint(ep.id, true);
                }
              })
            ]),
            el('div', {
              className: 'am-callout-text',
              textContent:
                'Run all only checks model metadata, for $0. Generate image makes one real image with ' +
                (res && res.modelUsed ? res.modelUsed : 'the discovered image model') +
                '.'
            })
          ])
        );
      }

      // Live TTS Audio Playback Stage
      if (res && res.audioMedia && app.objectUrls[ep.id]) {
        const audioUrl = app.objectUrls[ep.id];
        // Re-attach the same <audio> on a same-view re-render so playback is not cut off.
        let audioEl = app.activeAudioEl && app.activeAudioEl.getAttribute('src') === audioUrl
          ? app.activeAudioEl
          : null;
        if (!audioEl) {
          stopActiveAudio();
          audioEl = el('audio', { controls: true, preload: 'auto', src: audioUrl });
        }
        app.activeAudioEl = audioEl;
        body.appendChild(
          el('div', { className: 'am-media-stage' }, [
            el('div', { className: 'am-code-bar' }, [
              el('span', { className: 'ui-label', textContent: 'Synthesized speech (' + res.audioMedia.sourceMimeType + ' → WAV)' }),
              el('a', {
                className: 'ui-btn ui-btn--sm am-link-btn',
                dataset: { amFocus: 'download' },
                href: audioUrl,
                download: 'gemini-tts-probe.wav',
                'data-tip': 'Save the synthesized speech as a WAV file.',
                textContent: 'Download WAV'
              })
            ]),
            audioEl
          ])
        );
      }

      // Live Opt-in Generated Image Stage
      if (res && res.imageMedia && app.objectUrls[ep.id]) {
        body.appendChild(
          el('div', { className: 'am-media-stage' }, [
            el('span', { className: 'ui-label', textContent: 'Generated image (' + res.imageMedia.mimeType + ')' }),
            el('img', {
              className: 'am-media-img',
              src: app.objectUrls[ep.id],
              alt: 'Opt-in live image generated by ' + (res.modelUsed || 'Gemini Image')
            })
          ])
        );
      }

      // Metadata grid
      body.appendChild(
        el('div', { className: 'am-meta-grid' }, [
          el('div', { className: 'am-meta-cell' }, [
            el('span', { className: 'am-meta-label', textContent: 'Endpoint' }),
            el('span', { className: 'am-meta-val', textContent: ep.endpointTemplate })
          ]),
          el('div', { className: 'am-meta-cell' }, [
            el('span', { className: 'am-meta-label', textContent: 'Model tested' }),
            el('span', { className: 'am-meta-val', textContent: (res && res.modelUsed) || 'Auto-discovered / N/A' })
          ]),
          el('div', { className: 'am-meta-cell' }, [
            el('span', { className: 'am-meta-label', textContent: 'Latency' }),
            el('span', {
              className: 'am-meta-val',
              'data-tip': res && res.latencyMs ? 'Round-trip time of the last probe, in milliseconds.' : null,
              textContent: res && res.latencyMs ? res.latencyMs + ' ms' : '—'
            })
          ]),
          el('div', { className: 'am-meta-cell' }, [
            el('span', { className: 'am-meta-label', textContent: 'Cost · group' }),
            el('span', { className: 'am-meta-val', 'data-tip': COST_TIPS[ep.costTier] || null, textContent: ep.costTier + ' · ' + ep.category })
          ])
        ])
      );

      // Matching Discovered Models
      if (res && Array.isArray(res.discoveredModels) && res.discoveredModels.length > 0) {
        body.appendChild(
          el('div', { className: 'am-section' }, [
            el('span', { className: 'ui-label', textContent: 'Matching models on this key' }),
            el(
              'div',
              { className: 'am-chip-list' },
              res.discoveredModels.map(function (m) {
                return el('span', { className: 'am-model-chip', textContent: m });
              })
            )
          ])
        );
      }

      // Isolated Tab + Code Section (switching tabs never interrupts audio playback)
      const tabEntries = [
        ['curl', 'Redacted cURL'],
        ['raw', 'Raw Response']
      ];
      const codeWrap = el('div', { className: 'am-section' });
      const tabs = el('div', {
        className: 'ui-seg am-tabs',
        role: 'tablist',
        'aria-label': 'Inspector payload format',
        onKeydown: function (e) {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
          e.preventDefault();
          e.stopPropagation();
          const ids = tabEntries.map(function (entry) { return entry[0]; });
          const curIdx = Math.max(0, ids.indexOf(app.drawerTab));
          let nextIdx = curIdx;
          if (e.key === 'ArrowRight') nextIdx = (curIdx + 1) % ids.length;
          else if (e.key === 'ArrowLeft') nextIdx = (curIdx - 1 + ids.length) % ids.length;
          else if (e.key === 'Home') nextIdx = 0;
          else if (e.key === 'End') nextIdx = ids.length - 1;
          const nextTab = ids[nextIdx];
          app.drawerTab = nextTab;
          renderDrawerCodeSection(nextTab);
        }
      });
      const codeSection = el('div', {
        id: 'am-tabpanel-code',
        role: 'tabpanel',
        className: 'am-section'
      });
      codeWrap.appendChild(tabs);
      codeWrap.appendChild(codeSection);

      function renderDrawerCodeSection(focusTabId) {
        clearNode(tabs);
        clearNode(codeSection);
        codeSection.setAttribute('aria-labelledby', 'am-tab-' + app.drawerTab);

        tabEntries.forEach(function (entry) {
          const isActive = app.drawerTab === entry[0];
          tabs.appendChild(
            el('button', {
              type: 'button',
              id: 'am-tab-' + entry[0],
              role: 'tab',
              className: 'am-tab-btn',
              dataset: { tabId: entry[0], amFocus: 'tab:' + entry[0] },
              'aria-selected': String(isActive),
              'aria-controls': 'am-tabpanel-code',
              tabindex: isActive ? '0' : '-1',
              'data-tip': entry[0] === 'curl'
                ? 'The exact request as a cURL command, with the key redacted.'
                : 'The JSON the server sent back, with long media shortened.',
              textContent: entry[1],
              onClick: function () {
                app.drawerTab = entry[0];
                renderDrawerCodeSection(entry[0]);
              }
            })
          );
        });

        const codeText =
          app.drawerTab === 'curl'
            ? Probes.redactSecrets((res && res.curl) || '# Run this probe to generate the exact cURL command.', KeyStore.get())
            : Probes.redactSecrets(res && res.raw ? JSON.stringify(res.raw, null, 2) : '{}', KeyStore.get());

        const copyBtn = el('button', {
          type: 'button',
          className: 'ui-btn ui-btn--sm am-copy',
          dataset: { amFocus: 'copy-code' },
          'data-tip': app.drawerTab === 'curl'
            ? 'Copy the cURL command; the key shows as $GEMINI_API_KEY.'
            : 'Copy the raw JSON response; the key is redacted.',
          textContent: app.drawerTab === 'curl' ? 'Copy cURL' : 'Copy JSON',
          onClick: function () {
            copyToClipboard(codeText, dialog.open ? dialog : document.body)
              .then(function () {
                copyBtn.textContent = 'Copied ✓';
                setTimeout(function () {
                  copyBtn.textContent = app.drawerTab === 'curl' ? 'Copy cURL' : 'Copy JSON';
                }, 1500);
              })
              .catch(function () {
                copyBtn.textContent = 'Copy failed';
                setTimeout(function () {
                  copyBtn.textContent = app.drawerTab === 'curl' ? 'Copy cURL' : 'Copy JSON';
                }, 1500);
              });
          }
        });

        codeSection.appendChild(
          el('div', { className: 'am-code-bar' }, [
            el('span', {
              className: 'am-key-note',
              textContent: app.drawerTab === 'curl' ? 'The key is always shown as $GEMINI_API_KEY.' : 'Base64 media is shortened to keep this readable.'
            }),
            copyBtn
          ])
        );
        codeSection.appendChild(el('pre', { className: 'am-pre', textContent: codeText }));

        if (focusTabId) {
          const tabEl = tabs.querySelector('[data-tab-id="' + focusTabId + '"]');
          if (tabEl) tabEl.focus();
        }
      }

      renderDrawerCodeSection(null);
      body.appendChild(codeWrap);

      if (app.activeAudioEl && !body.contains(app.activeAudioEl)) stopActiveAudio();

      refs.drawer.appendChild(head);
      refs.drawer.appendChild(body);
      restoreDrawerScroll();

      if (focusNav === 'prev') {
        if (!prevBtn.disabled) prevBtn.focus();
        else {
          const t = refs.drawer.querySelector('#am-drawer-title');
          if (t) t.focus();
        }
      } else if (focusNav === 'next') {
        if (!nextBtn.disabled) nextBtn.focus();
        else {
          const t = refs.drawer.querySelector('#am-drawer-title');
          if (t) t.focus();
        }
      }
    }

    function renderModelsDrawerContent() {
      const models = app.catalog.models || [];
      const head = el('div', { className: 'am-drawer-head' }, [
        el('div', { className: 'am-drawer-title-group' }, [
          el('span', { className: 'am-tag', 'data-tip': 'Every model GET /v1beta/models lists for this key.', textContent: 'CATALOG' }),
          el('h2', {
            id: 'am-drawer-title',
            className: 'am-drawer-title',
            tabindex: '-1',
            dataset: { amFocus: 'drawer-title' },
            textContent: 'Discovered Models (' + models.length + ')'
          })
        ]),
        el('div', { className: 'am-drawer-nav' }, [
          el('button', {
            type: 'button',
            className: 'ui-btn ui-btn--sm ui-btn--primary',
            dataset: { amFocus: 'models-refresh' },
            disabled: Boolean(app.probing.models) || app.isBatchRunning,
            'data-tip': app.probing.models || app.isBatchRunning
              ? 'Wait for the running probes to finish.'
              : 'Run the Models probe again to refresh this list.',
            textContent: app.probing.models ? 'Loading…' : 'Refresh',
            onClick: function () {
              runSingleEndpoint('models', false);
            }
          }),
          el('button', {
            type: 'button',
            className: 'ui-btn ui-btn--sm',
            dataset: { amFocus: 'drawer-close' },
            'aria-label': 'Close models browser',
            'data-tip': 'Back to the API list.',
            'data-tip-key': 'Esc',
            textContent: 'Close',
            onClick: closeDrawer
          })
        ])
      ]);

      const body = el('div', { className: 'am-drawer-body' });
      const searchInput = el('input', {
        type: 'search',
        className: 'am-input',
        dataset: { amFocus: 'models-search' },
        value: app.modelSearch,
        placeholder: 'Filter by model or method: tts, live, veo, embedContent…',
        'aria-label': 'Filter discovered models'
      });

      const listWrap = el('div', { className: 'am-model-list' });

      function renderModelList() {
        clearNode(listWrap);
        const q = app.modelSearch.trim().toLowerCase();
        const visible = models.filter(function (m) {
          if (!q) return true;
          return (
            m.bare.toLowerCase().indexOf(q) >= 0 ||
            m.displayName.toLowerCase().indexOf(q) >= 0 ||
            m.supportedGenerationMethods.join(' ').toLowerCase().indexOf(q) >= 0
          );
        });

        if (!models.length) {
          listWrap.appendChild(
            el('div', { className: 'am-empty-filter' }, [
              el('div', { textContent: 'No models yet. Refresh, or Run all, to list the models enabled on this key.' })
            ])
          );
          return;
        }

        if (!visible.length) {
          listWrap.appendChild(el('div', { className: 'am-key-note', textContent: 'No discovered models match "' + app.modelSearch + '".' }));
          return;
        }

        visible.forEach(function (m) {
          listWrap.appendChild(
            el('div', { className: 'am-model-row' }, [
              el('div', { className: 'am-model-row-top' }, [
                el('span', { className: 'am-model-row-id', textContent: m.bare }),
                m.inputTokenLimit
                  ? el('span', {
                      className: 'ui-readout ui-readout--quiet am-model-limit',
                      'data-tip': 'Input token limit: the most tokens one request can hold.',
                      textContent: 'in ' + m.inputTokenLimit.toLocaleString()
                    })
                  : null
              ]),
              el(
                'div',
                { className: 'am-chip-list' },
                m.supportedGenerationMethods.map(function (method) {
                  return el('span', { className: 'am-tag', textContent: method });
                })
              )
            ])
          );
        });
      }

      searchInput.addEventListener('input', function (e) {
        app.modelSearch = e.target.value;
        renderModelList();
      });

      renderModelList();
      body.appendChild(searchInput);
      body.appendChild(listWrap);
      refs.drawer.appendChild(head);
      refs.drawer.appendChild(body);
    }

    function renderProgressUpdate(changedId) {
      preserveFocus(function () {
        renderPrimaryCell();
        if (dialog.open) {
          renderTopbar();
          renderFilterBar();
          renderSecondaryGridCards();
          // changedId null = batch start/stop/finish: both drawers must refresh their
          // disabled Re-test / Refresh buttons (Refresh used to stay disabled after a batch).
          if (app.drawerMode === 'endpoint' && (!changedId || app.selectedEndpointId === changedId)) {
            renderDrawer();
          } else if (app.drawerMode === 'models' && (!changedId || changedId === 'models')) {
            renderDrawer();
          }
        }
        syncRunningClass();
      });
    }

    function renderSecondarySections() {
      renderTopbar();
      renderKeybar();
      renderFilterBar();
      renderSecondaryGridCards();
      // Always: with drawerMode null this hides the scrim. A dialog closed with a drawer open
      // (browser Back, forced Escape) used to reopen with a stale drawer over an inert grid.
      renderDrawer();
    }

    function renderAll() {
      preserveFocus(function () {
        renderPrimaryCell();
        if (dialog.open) renderSecondarySections();
        syncRunningClass();
      });
    }

    function onStorage(e) {
      // file:// pages share one localStorage origin; only react to the shared Gemini key.
      if (!e || e.key === null || SHARED_KEY_NAMES.indexOf(e.key) >= 0) renderAll();
    }

    function endpointLabel(id) {
      const def = getEndpointDef(id);
      return def ? def.name : id;
    }

    function renderStatusNote(id) {
      if (!dialog.open) return;
      preserveFocus(function () {
        renderSecondaryGridCards();
        if (app.drawerMode === 'endpoint' && app.selectedEndpointId === id) renderDrawer();
      });
    }

    // =========================================================================
    // 4. PROBE EXECUTION (SINGLE & STAGED BATCH)
    // =========================================================================

    function requireKeyOrPrompt() {
      const stored = KeyStore.get();
      // Decisions/Prosody write the same store, so a stored key is re-validated here too.
      const check = Probes.validateApiKey(stored);
      if (check.ok) return check.key;
      // The key editor sits under the inert grid shell; with a drawer open the prompt was
      // invisible and the Re-test / Run Live Image Gen / Refresh buttons looked dead.
      if (app.drawerMode) closeDrawer({ restoreFocus: false });
      app.showKeyEditor = true;
      app.keyPromptNotice = stored
        ? check.error
        : 'Paste your Google AI Studio Gemini API key first to run live tests.';
      renderKeybar();
      if (refs.keyInput) refs.keyInput.focus();
      announce(stored ? check.error : 'API key required before running probes.');
      return '';
    }

    function cancelAllRuns() {
      app.runSeq += 1;
      if (app.batchAbort) {
        app.batchAbort.abort();
        app.batchAbort = null;
      }
      Object.keys(app.singleAborts).forEach(function (id) {
        try { app.singleAborts[id].abort(); } catch (_e) {}
      });
      app.singleAborts = Object.create(null);
      app.probing = Object.create(null);
      app.batchProbing = Object.create(null);
      app.statusNotes = Object.create(null);
      app.isBatchRunning = false;
      app.batchCompleted = 0;
      app.batchTotal = 0;
      renderProgressUpdate(null);
    }

    function runSingleEndpoint(endpointId, liveGen) {
      if (app.isBatchRunning || app.probing[endpointId]) return;
      const apiKey = requireKeyOrPrompt();
      if (!apiKey) return;

      const seq = app.runSeq;
      const ac = new AbortController();
      app.singleAborts[endpointId] = ac;
      app.probing[endpointId] = true;
      app.statusNotes[endpointId] = liveGen ? 'Running opt-in live image generation…' : '';
      renderProgressUpdate(endpointId);

      Probes.runSingleProbe(endpointId, {
        apiKey: apiKey,
        catalog: app.catalog,
        signal: ac.signal,
        liveGen: Boolean(liveGen),
        onStatusNote: function (note) {
          if (seq !== app.runSeq) return;
          app.statusNotes[endpointId] = note;
          renderStatusNote(endpointId);
        }
      })
        .then(function (result) {
          if (seq !== app.runSeq) return;
          delete app.probing[endpointId];
          delete app.singleAborts[endpointId];
          delete app.statusNotes[endpointId];
          storeProbeResult(endpointId, result);
          renderProgressUpdate(endpointId);
          announce(endpointLabel(endpointId) + ' probe finished: ' + result.badge + '.');
        })
        .catch(function (err) {
          if (seq !== app.runSeq) return;
          delete app.probing[endpointId];
          delete app.singleAborts[endpointId];
          delete app.statusNotes[endpointId];
          if (err && err.aborted) {
            renderProgressUpdate(endpointId);
            return;
          }
          storeProbeResult(endpointId, {
            id: endpointId,
            status: 'fail',
            badge: 'ERROR',
            httpStatus: 0,
            latencyMs: 0,
            modelUsed: null,
            summary: Probes.redactSecrets(err && err.message ? err.message : 'Unexpected probe error.', apiKey),
            remediation: 'Retry the probe.',
            curl: '',
            raw: { error: Probes.redactSecrets(String(err), apiKey) },
            probedAt: new Date().toISOString()
          });
          renderProgressUpdate(endpointId);
        });
    }

    function startBatchRun() {
      const apiKey = requireKeyOrPrompt();
      if (!apiKey) return;

      cancelAllRuns();
      stopActiveAudio();
      revokeAllMediaUrls();
      app.results = Object.create(null);
      app.catalog = Probes.createEmptyCatalog();
      const seq = ++app.runSeq;
      const ac = new AbortController();
      app.batchAbort = ac;
      app.isBatchRunning = true;
      app.batchCompleted = 0;
      app.batchTotal = Probes.ENDPOINTS.filter(function (e) {
        if (!e.runInBatch) return false;
        if (e.id === 'grounding' && !app.includeGrounding) return false;
        return true;
      }).length;
      renderProgressUpdate(null);
      announce('Probing ' + app.batchTotal + ' Google Gemini API endpoints.');

      Probes.runBatch({
        apiKey: apiKey,
        catalog: app.catalog,
        signal: ac.signal,
        includeGrounding: app.includeGrounding,
        onStart: function (id) {
          if (seq !== app.runSeq) return;
          app.probing[id] = true;
          app.batchProbing[id] = true;
          app.statusNotes[id] = '';
          renderProgressUpdate(id);
        },
        onStatusNote: function (id, note) {
          if (seq !== app.runSeq) return;
          app.statusNotes[id] = note;
          renderStatusNote(id);
        },
        onResult: function (id, result) {
          if (seq !== app.runSeq) return;
          delete app.probing[id];
          delete app.batchProbing[id];
          delete app.statusNotes[id];
          app.batchCompleted += 1;
          storeProbeResult(id, result);
          renderProgressUpdate(id);
        }
      })
        .then(function (outcome) {
          if (seq !== app.runSeq) return;
          app.isBatchRunning = false;
          app.batchAbort = null;
          Object.keys(app.batchProbing).forEach(function (id) {
            delete app.probing[id];
          });
          app.batchProbing = Object.create(null);
          if (outcome && outcome.haltedOnAuth) {
            app.showKeyEditor = true;
            app.keyPromptNotice = outcome.haltReason === 'network'
              ? 'Could not reach generativelanguage.googleapis.com (' +
                ((outcome.modelsResult && outcome.modelsResult.summary) || 'network error') +
                ') — halted remaining probes.'
              : 'Key rejected by /v1beta/models — halted remaining probes to avoid redundant failures.';
            preserveFocus(renderKeybar);
          }
          renderProgressUpdate(null);
          const c = getCounts();
          announce('Probe sweep complete: ' + c.pass + ' passed, ' + c.warn + ' warnings, ' + c.fail + ' failed.');
        })
        .catch(function (err) {
          if (seq !== app.runSeq) return;
          app.isBatchRunning = false;
          app.batchAbort = null;
          Object.keys(app.batchProbing).forEach(function (id) {
            delete app.probing[id];
          });
          app.batchProbing = Object.create(null);
          if (err && err.aborted) {
            renderProgressUpdate(null);
            announce('Probe sweep stopped.');
            return;
          }
          app.showKeyEditor = true;
          app.keyPromptNotice = 'Probe sweep failed unexpectedly: ' + Probes.redactSecrets(err && err.message ? err.message : String(err), apiKey);
          preserveFocus(renderKeybar);
          renderProgressUpdate(null);
          announce('Probe sweep failed unexpectedly.');
        });
    }

    // =========================================================================
    // 5. NAVIGATION, HASH SYNC & 2-STEP ESCAPE STACK
    // =========================================================================

    function openEndpointDrawer(endpointId) {
      app.drawerReturnTarget = { type: 'endpoint', id: endpointId };
      app.drawerMode = 'endpoint';
      app.selectedEndpointId = endpointId;
      renderSecondaryGridCards();
      renderDrawer();
      const titleEl = refs.drawer && refs.drawer.querySelector('#am-drawer-title');
      if (titleEl) titleEl.focus();
    }

    function openModelsDrawer() {
      app.drawerReturnTarget = { type: 'models' };
      app.drawerMode = 'models';
      renderDrawer();
      const titleEl = refs.drawer && refs.drawer.querySelector('#am-drawer-title');
      if (titleEl) titleEl.focus();
    }

    function closeDrawer(opts) {
      const restore = !(opts && opts.restoreFocus === false);
      const target = app.drawerReturnTarget;
      stopActiveAudio();
      app.drawerMode = null;
      app.drawerReturnTarget = null;
      if (refs.mainWrap) refs.mainWrap.inert = false;
      if (refs.scrim) refs.scrim.hidden = true;
      renderSecondaryGridCards();
      renderDrawer();
      function focusTarget() {
        if (target && target.type === 'endpoint' && refs.gridContainer) {
          const cardBtn = refs.gridContainer.querySelector('[data-endpoint-id="' + target.id + '"] .am-inspect-btn');
          if (cardBtn) cardBtn.focus();
        } else if (target && target.type === 'models' && refs.topbar) {
          const modelsBtn = refs.topbar.querySelector('[data-action="models"]');
          if (modelsBtn) modelsBtn.focus();
        }
      }
      if (!restore) return;
      focusTarget();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () {
          if (!unmounted && focusWasLost()) focusTarget();
        });
      }
    }

    function openSecondaryGrid(opts) {
      const fromDeepLink = Boolean(opts && opts.fromDeepLink);
      app.openedFromGrid = !fromDeepLink && location.hash !== '#api-matrix';
      app.closingViaHistory = false;
      app.closingProgrammatically = false;
      app.showKeyEditor = !KeyStore.get();
      app.keyVisible = false;
      app.keyPromptNotice = '';

      if (!refs.topbar) buildDialogShell();
      if (!dialog.open) {
        refs.keyInput = null; // never carry unsaved key text from a previous open into this one
        // Render before showModal so the dialog's initial focus lands on a real control
        // (it used to land on the empty dialog / <body>).
        renderSecondarySections();
        dialog.showModal();
      }

      if (!fromDeepLink && location.hash !== '#api-matrix' && history && typeof history.pushState === 'function') {
        try {
          history.pushState({ amView: true }, '', '#api-matrix');
        } catch (_e) {}
      }

      renderAll();
      // Explicit initial focus: below 640px .am-shell is a scroll container, which Chrome's
      // dialog focusing steps pick ahead of the Back button.
      const initialFocus = app.showKeyEditor && refs.keyInput ? refs.keyInput : findFocusable('back');
      if (initialFocus && !initialFocus.contains(document.activeElement)) {
        try { initialFocus.focus({ preventScroll: true }); } catch (_e) { initialFocus.focus(); }
      }
    }

    function closeSecondaryGridInternal() {
      stopActiveAudio();
      app.closingViaHistory = false;
      app.keyVisible = false;
      if (refs.keyInput) refs.keyInput.type = 'password';
      app.drawerMode = null;
      app.drawerReturnTarget = null;
      renderDrawer(); // hides the scrim and un-inerts the grid shell
      if (dialog.open) {
        app.closingProgrammatically = true;
        dialog.close();
      }
      renderPrimaryCell();
      const triggerEl = rootEl.querySelector('.am-cell-trigger');
      if (triggerEl && typeof triggerEl.focus === 'function') {
        triggerEl.focus();
      }
    }

    function closeSecondaryGrid(opts) {
      const immediate = Boolean(opts && opts.immediate);
      if (app.closingViaHistory && !immediate) return;
      if (app.openedFromGrid && location.hash === '#api-matrix' && history && typeof history.back === 'function') {
        app.openedFromGrid = false;
        app.closingViaHistory = true;
        history.back();
        // popstate -> syncHashState closes the dialog; when the browser is closing it right now
        // (non-cancelable cancel) run the close path here so focus and state are not left behind.
        if (immediate) closeSecondaryGridInternal();
        return;
      }
      app.openedFromGrid = false;
      if (location.hash === '#api-matrix' && history && typeof history.replaceState === 'function') {
        try {
          history.replaceState(null, '', location.pathname + location.search);
        } catch (_e) {}
      }
      closeSecondaryGridInternal();
    }

    // 2-step Escape stack: Drawer first, then Secondary Grid.
    dialog.addEventListener('cancel', function (e) {
      if (!e.cancelable) {
        // Chrome's close-watcher abuse guard: with no user activation since the last Escape the
        // cancel cannot be prevented and the dialog closes anyway. Only closing the drawer here
        // left #api-matrix in the URL and focus on <body>; run the full close path instead.
        closeSecondaryGrid({ immediate: true });
        return;
      }
      e.preventDefault();
      if (app.drawerMode) {
        closeDrawer();
      } else {
        closeSecondaryGrid();
      }
    });

    // Fallback cleanup if browser closes <dialog> natively without firing cancel.
    dialog.addEventListener('close', function () {
      if (app.closingProgrammatically) {
        app.closingProgrammatically = false;
        return;
      }
      if (unmounted) return;
      stopActiveAudio();
      app.closingViaHistory = false;
      app.keyVisible = false;
      if (refs.keyInput) refs.keyInput.type = 'password';
      app.drawerMode = null;
      app.drawerReturnTarget = null;
      renderDrawer();
      if (location.hash === '#api-matrix' && history && typeof history.replaceState === 'function') {
        try { history.replaceState(null, '', location.pathname + location.search); } catch (_e) {}
      }
      renderPrimaryCell();
      const triggerEl = rootEl.querySelector('.am-cell-trigger');
      if (triggerEl && typeof triggerEl.focus === 'function') {
        triggerEl.focus();
      }
    });

    dialog.addEventListener('keydown', function (e) {
      if (app.drawerMode !== 'endpoint') return;
      if (e.target && typeof e.target.closest === 'function' && e.target.closest('[role="tablist"]')) return;
      const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'audio' || tag === 'video') return;
      const filtered = getFilteredEndpoints();
      const idx = filtered.findIndex(function (x) { return x.id === app.selectedEndpointId; });
      if (e.key === 'ArrowLeft' && idx > 0) {
        e.preventDefault();
        app.selectedEndpointId = filtered[idx - 1].id;
        app.drawerReturnTarget = { type: 'endpoint', id: app.selectedEndpointId };
        renderSecondaryGridCards();
        renderDrawer({ focusNav: 'prev' });
      } else if (e.key === 'ArrowRight' && idx >= 0 && idx < filtered.length - 1) {
        e.preventDefault();
        app.selectedEndpointId = filtered[idx + 1].id;
        app.drawerReturnTarget = { type: 'endpoint', id: app.selectedEndpointId };
        renderSecondaryGridCards();
        renderDrawer({ focusNav: 'next' });
      }
    });

    function syncHashState() {
      if (unmounted) return;
      app.closingViaHistory = false;
      if (location.hash === '#api-matrix') {
        if (!dialog.open) openSecondaryGrid({ fromDeepLink: true });
      } else if (dialog.open) {
        closeSecondaryGridInternal();
      }
    }

    function onWindowFocus() {
      if (!unmounted && !dialog.open) preserveFocus(renderPrimaryCell);
    }

    global.addEventListener('hashchange', syncHashState);
    global.addEventListener('popstate', syncHashState);
    global.addEventListener('gemini-key-changed', renderAll);
    global.addEventListener('storage', onStorage);
    global.addEventListener('focus', onWindowFocus);
    global.addEventListener('beforeunload', revokeAllMediaUrls);

    function unmount() {
      if (unmounted) return;
      unmounted = true;
      app.runSeq += 1;
      if (announceTimer !== null) {
        clearTimeout(announceTimer);
        announceTimer = null;
      }
      if (app.batchAbort) {
        try { app.batchAbort.abort(); } catch (_e) {}
        app.batchAbort = null;
      }
      Object.keys(app.singleAborts).forEach(function (id) {
        try { app.singleAborts[id].abort(); } catch (_e) {}
      });
      app.singleAborts = Object.create(null);
      stopActiveAudio();
      revokeAllMediaUrls();
      global.removeEventListener('hashchange', syncHashState);
      global.removeEventListener('popstate', syncHashState);
      global.removeEventListener('gemini-key-changed', renderAll);
      global.removeEventListener('storage', onStorage);
      global.removeEventListener('focus', onWindowFocus);
      global.removeEventListener('beforeunload', revokeAllMediaUrls);
      if (dialog.open) {
        app.closingProgrammatically = true;
        try { dialog.close(); } catch (_e) {}
      }
      if (dialog.parentNode) {
        dialog.parentNode.removeChild(dialog);
      }
      clearNode(rootEl);
      rootEl.classList.remove('is-running');
      rootEl.classList.remove('ui-tile');
      delete rootEl.dataset.amMounted;
      delete rootEl._amUnmount;
      delete dialog._amOwnerUnmount;
    }

    rootEl._amUnmount = unmount;
    dialog._amOwnerUnmount = unmount;

    renderPrimaryCell();
    if (location.hash === '#api-matrix') {
      openSecondaryGrid({ fromDeepLink: true });
    }
    return unmount;
  }

  function bootstrap() {
    const mount = document.getElementById('cell-api-matrix');
    if (mount) {
      mountApiMatrixCell(mount);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  NS.UI = {
    mount: mountApiMatrixCell
  };
})(window);
