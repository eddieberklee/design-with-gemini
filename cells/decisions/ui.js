(function (global) {
  'use strict';

  const NS = (global.GeminiDecisions = global.GeminiDecisions || {});
  const Schema = NS.Schema;
  const Presets = NS.Presets;
  const Client = NS.Client;

  const CHOICE_SWATCHES = ['#141413', '#5c5c58', '#9e9e99', '#cfcfca', '#e3e3de'];

  // Tile 1 scenario tabs: what each preset in presets.js loads (input + its three questions).
  // Workbench question types (the API's names) in plain words.
  const TYPE_TIPS = {
    noul: 'Yes/no question (noul): answered as a probability of yes.',
    choice: 'Pick-one question (choice): a probability for each option.',
    score: 'Rubric question (score): a probability per level, averaged into one score.'
  };

  const PRESET_TIPS = {
    receipt: 'Receipt photo: breaks expense policy, which expense bucket, ready to auto-approve.',
    support: 'Support email: page on-call now, which team owns it, how severe.',
    ui_qa: 'Checkout screenshot: ready to ship, main visual flaw, overall polish.',
    release: 'Pull request: needs a migration guide, version bump, production blast radius.'
  };

  let nextCustomId = 1;

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
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function fmtProb(p) {
    const n = Number(p);
    return Number.isFinite(n) ? n.toFixed(2) : '0.00';
  }

  function fmtPct(p) {
    const n = Number(p);
    return Number.isFinite(n) ? Math.round(n * 100) + '%' : '0%';
  }

  function fmtSignedDelta(d) {
    const n = Number(d);
    if (!Number.isFinite(n) || Math.abs(n) < 0.005) return null;
    return (n > 0 ? '+' : '−') + Math.abs(n).toFixed(2);
  }

  function fmtSignedPts(d) {
    const n = Number(d);
    if (!Number.isFinite(n) || Math.abs(n) < 0.01) return null;
    const pts = Math.round(Math.abs(n) * 100);
    return (n > 0 ? '+' : '−') + pts + ' pts';
  }

  function humanizeKey(key) {
    const raw = String(key || '').trim();
    const cleaned = raw
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return raw || 'Option';
    return cleaned.replace(/\b\w/g, function (c) {
      return c.toUpperCase();
    });
  }

  function certaintyLabel(stdDev, min, max, sum) {
    if (!Number.isFinite(stdDev) || (Number.isFinite(sum) && sum <= 0)) return '';
    const maxPossible = Math.max(0.5, ((Number.isFinite(max) && Number.isFinite(min) ? max - min : 3) * 0.5));
    const rel = stdDev / maxPossible;
    if (rel < 0.36) return 'High certainty';
    if (rel < 0.62) return 'Moderate spread';
    return 'Mixed signals';
  }

  function shortLevelLabel(q, lvl, idx) {
    if (q && Array.isArray(q.levelLabels)) {
      if (lvl && Number.isInteger(lvl.index) && q.levelLabels[lvl.index]) {
        return q.levelLabels[lvl.index];
      }
      if (q.levelLabels[idx]) return q.levelLabels[idx];
    }
    const raw = String((lvl && lvl.description) || '').trim();
    const colon = raw.indexOf(':');
    if (colon > 0 && colon <= 18) {
      const prefix = raw.slice(0, colon).replace(/^[\s•—–\-:]+/, '').trim();
      if (prefix) return prefix;
    }
    const cleaned = raw.replace(/^[\s•—–\-:]+/, '').trim();
    const firstWord = cleaned.split(/\s+/)[0] || '';
    const trimmedWord = firstWord.replace(/^[^\w\u00C0-\u024F\u3000-\u9FFF]+|[^\w\u00C0-\u024F\u3000-\u9FFF-]+$/g, '');
    if (trimmedWord) return trimmedWord;
    return 'Level ' + (lvl ? lvl.index : idx);
  }

  function trimKey(val) {
    return typeof val === 'string' ? val.trim() : '';
  }

  function optionHumanLabel(q, key) {
    if (q && Array.isArray(q.options)) {
      const match = q.options.find(function (o) {
        return o && trimKey(o.key) === key;
      });
      if (match && typeof match.label === 'string' && match.label.trim()) return match.label.trim();
    }
    return humanizeKey(key);
  }

  function computeScorePointerPct(score, min, max, cols) {
    const span = Math.max(1, max - min);
    const normalized = Schema.clamp((score - min) / span, 0, 1);
    const colCount = Math.max(2, cols);
    return ((0.5 + normalized * (colCount - 1)) / colCount) * 100;
  }

  function nodeContains(root, target) {
    if (!root || !target) return false;
    if (typeof root.contains === 'function') {
      return root.contains(target);
    }
    let cur = target;
    while (cur) {
      if (cur === root) return true;
      cur = cur.parentNode || null;
    }
    return false;
  }

  function fallbackExecCopy(text, fallbackRoot) {
    return new Promise(function (resolve, reject) {
      const host = fallbackRoot || (typeof document !== 'undefined' ? document.body : null);
      if (!host) {
        reject(new Error('Clipboard unavailable.'));
        return;
      }
      let ta = null;
      try {
        ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
        host.appendChild(ta);
        if (typeof ta.select === 'function') ta.select();
        const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
        host.removeChild(ta);
        ta = null;
        if (ok === false) {
          reject(new Error('Clipboard copy command was rejected.'));
        } else {
          resolve();
        }
      } catch (err) {
        if (ta && ta.parentNode) {
          try {
            ta.parentNode.removeChild(ta);
          } catch (_e) {
            // ignore
          }
        }
        reject(err);
      }
    });
  }

  function copyToClipboard(text, fallbackRoot) {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return Promise.resolve()
        .then(function () {
          return navigator.clipboard.writeText(text);
        })
        .catch(function () {
          return fallbackExecCopy(text, fallbackRoot);
        });
    }
    return fallbackExecCopy(text, fallbackRoot);
  }

  // Errors the user fixes by changing the key (wrong/expired key arrives as HTTP 400, not 401).
  function isKeyError(err) {
    return Boolean(
      err && (err.keyProblem || err.httpStatus === 401 || err.code === 'MISSING_KEY' || err.code === 'API_KEY_INVALID')
    );
  }

  function cssEscape(val) {
    const s = String(val);
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') return CSS.escape(s);
    return s.replace(/[^A-Za-z0-9_-]/g, '\\$&');
  }

  function noulBand(p, threshold) {
    if (p >= threshold) {
      const margin = p - threshold;
      if (p >= 0.78 && margin >= 0.12) return 'YES · HIGH';
      if (margin < 0.12) return 'YES · MARGINAL';
      return 'LEAN YES';
    }
    const margin = threshold - p;
    if (p <= 0.22 && margin >= 0.12) return 'NO · HIGH';
    if (margin < 0.12) return 'NO · MARGINAL';
    return 'LEAN NO';
  }

  function snapshotStateForNormalization(state) {
    return {
      questions: ((state && state.questions) || [])
        .filter(function (q) {
          return q && typeof q === 'object';
        })
        .map(function (q) {
          return {
            id: q.id,
            enabled: q.enabled !== false,
            key: q.key,
            cardQuestion: q.cardQuestion,
            instructions: q.instructions,
            type: q.type,
            threshold: q.threshold,
            options: Array.isArray(q.options)
              ? q.options
                  .filter(function (o) {
                    return o && typeof o === 'object';
                  })
                  .map(function (o) {
                    return { key: o.key, label: o.label, description: o.description };
                  })
              : undefined,
            levels: Array.isArray(q.levels) ? q.levels.slice() : undefined,
            levelLabels: Array.isArray(q.levelLabels) ? q.levelLabels.slice() : undefined
          };
        })
    };
  }

  function mountDecisionsTriptych(inputEl, verdictEl, scoreEl) {
    const cells = [inputEl, verdictEl, scoreEl].filter(Boolean);
    if (!cells.length) {
      return function noopUnmount() {};
    }

    // Auto-dispose any prior instance mounted onto the same cell element(s)
    cells.forEach(function (c) {
      if (c && typeof c.__dcUnmount === 'function') {
        c.__dcUnmount();
      }
    });

    let disposed = false;
    let announceTimer = null;
    const copyTimers = [];
    const activeDragCleanups = [];
    let renderedFlipBtns = [];
    let renderedPresetBtns = [];
    let restoringInputFocus = false;

    const initialPreset = Presets.createPresetState('receipt', 0);
    const savedKey = Client.KeyStore.get();
    let lastKnownKey = savedKey;

    const app = {
      state: initialPreset,
      customTextEdited: false,
      mode: savedKey ? 'live' : 'simulated',
      isRunning: false,
      activeTab: 'results', // 'results' | 'request' | 'response'
      requestFormat: 'json', // 'json' | 'curl'
      includeBase64: false,
      mediaExpanded: false,
      showKeyPopover: false,
      keyVisible: false,
      runSeq: 0,
      uploadSeq: 0,
      abortController: null,
      result: null,
      prevResult: null,
      error: null,
      uploadNotice: '',
      returnFocusRole: 'expand-btn',
      // True after a Workbench edit that the shown result does not reflect yet (cleared when a run starts).
      dirty: false
    };

    const liveRegion = el('div', {
      className: 'ui-sr-only',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true'
    });

    const inputWrap = inputEl ? el('div', { className: 'dc-cell-inner' }) : null;
    const verdictWrap = verdictEl ? el('div', { className: 'dc-cell-inner' }) : null;
    const scoreWrap = scoreEl ? el('div', { className: 'dc-cell-inner' }) : null;

    cells.forEach(function (c) {
      clearNode(c);
      // Shared tile anatomy (ui/base.css): size container "ui-tile" for the compact/tiny steps.
      // index.html is not ours to edit, so the class is added here and removed in unmount().
      c.classList.add('ui-tile');
    });
    cells[0].appendChild(liveRegion);
    if (inputEl && inputWrap) inputEl.appendChild(inputWrap);
    if (verdictEl && verdictWrap) verdictEl.appendChild(verdictWrap);
    if (scoreEl && scoreWrap) scoreEl.appendChild(scoreWrap);

    function announce(msg) {
      if (disposed) return;
      liveRegion.textContent = '';
      if (announceTimer) clearTimeout(announceTimer);
      announceTimer = setTimeout(function () {
        announceTimer = null;
        if (!disposed) liveRegion.textContent = msg;
      }, 20);
    }

    const dialog = el('dialog', {
      className: 'ui-dialog dc-dialog',
      'aria-labelledby': 'dc-wb-heading'
    });
    document.body.appendChild(dialog);

    const wbRefs = {};

    // Workbench panes are rebuilt on most clicks. Every rebuilt control carries a stable data-fk
    // (built from question ids, indexes and keys, CSS-escaped on lookup); the focused control's key is captured
    // before a rebuild and focus is put back on its replacement (or data-fk-fallback when it is gone
    // or disabled) so keyboard users are not dropped onto <body>.
    function captureWorkbenchFocus() {
      const a = document.activeElement;
      if (!a || !dialog.open || !nodeContains(dialog, a) || !a.dataset || !a.dataset.fk) return null;
      const snap = { fk: a.dataset.fk, fallback: a.dataset.fkFallback || '', selStart: null, selEnd: null };
      try {
        if (typeof a.selectionStart === 'number') {
          snap.selStart = a.selectionStart;
          snap.selEnd = a.selectionEnd;
        }
      } catch (_e) {
        // selection is not readable on checkbox/button inputs
      }
      return snap;
    }

    function restoreWorkbenchFocus(snap) {
      if (!snap || !dialog.open) return;
      const cur = document.activeElement;
      if (cur && cur !== document.body && cur.isConnected !== false && nodeContains(dialog, cur)) return;
      let target = dialog.querySelector('[data-fk="' + cssEscape(snap.fk) + '"]');
      if ((!target || target.disabled) && snap.fallback) {
        target = dialog.querySelector('[data-fk="' + cssEscape(snap.fallback) + '"]');
      }
      if (!target || target.disabled || typeof target.focus !== 'function') return;
      try {
        target.focus({ preventScroll: true });
      } catch (_e) {
        target.focus();
      }
      if (snap.selStart !== null && typeof target.setSelectionRange === 'function') {
        try {
          target.setSelectionRange(snap.selStart, snap.selEnd);
        } catch (_e) {
          // ignore
        }
      }
    }

    function setPeerHighlight(active) {
      [verdictEl, scoreEl].forEach(function (c) {
        if (c) c.classList.toggle('is-peer-highlight', active);
      });
    }

    function triggerScanPulse() {
      cells.forEach(function (c, idx) {
        c.classList.remove('is-scanning');
        c.style.setProperty('--dc-scan-delay', idx * 70 + 'ms');
        void c.offsetWidth;
        c.classList.add('is-scanning');
      });
      dialog.classList.remove('is-scanning');
      void dialog.offsetWidth;
      if (dialog.open) dialog.classList.add('is-scanning');
    }

    function setLoadingState(loading) {
      app.isRunning = loading;
      cells.forEach(function (c) {
        c.classList.toggle('is-loading', loading);
      });
      [verdictEl, scoreEl].forEach(function (c) {
        if (c) c.classList.toggle('is-dimmed', loading);
      });
      dialog.classList.toggle('is-loading', loading);
      if (wbRefs.runBtn) {
        updateRunButton();
      }
    }

    function getValidation() {
      return Schema.validateState(app.state);
    }

    function renderAllCells() {
      if (inputEl) renderInputCell();
      if (verdictEl) renderVerdictCell();
      if (scoreEl) renderScoreCell();
    }

    function runEvaluation(opts) {
      if (app.abortController) {
        app.abortController.abort();
        app.abortController = null;
      }
      const seq = ++app.runSeq;
      const validation = getValidation();
      if (!validation.valid) {
        setLoadingState(false);
        renderWorkbenchValidation(validation);
        updateRunButton(validation);
        if (wbRefs.rightPane) renderWorkbenchWirePreview();
        renderAllCells();
        return;
      }

      const body = Schema.buildRequestBody(app.state);
      const keepGhost = !(opts && opts.resetGhost);
      const stateSnapshot = snapshotStateForNormalization(app.state);
      app.dirty = false;

      if (app.mode === 'simulated') {
        setLoadingState(false);
        app.error = null;
        if (keepGhost && app.result) {
          app.prevResult = app.result;
        } else if (!keepGhost) {
          app.prevResult = null;
        }
        const simRes = Client.runSimulated(app.state, body);
        app.result = {
          mode: 'simulated',
          httpStatus: null,
          latencyMs: null,
          normalized: Schema.normalizeResponse(simRes.raw, stateSnapshot),
          evaluatedQuestions: stateSnapshot.questions,
          raw: simRes.raw,
          evaluatedAt: simRes.evaluatedAt
        };
        triggerScanPulse();
        renderAllCells();
        if (dialog.open) {
          renderWorkbenchRight();
          renderWorkbenchHeaderControls();
        }
        announce('Demo preview updated: ' + validation.activeCount + ' answers, 0 output tokens.');
        return;
      }

      const apiKey = Client.KeyStore.get();
      if (!apiKey) {
        setLoadingState(false);
        app.error = {
          code: 'MISSING_KEY',
          httpStatus: 0,
          headline: 'No Gemini API key configured',
          detail: 'Paste your standard Gemini API key (same key as Google AI Studio) to run live gemini-decision-1 requests.',
          remediation: 'Add your key in the API Key popover or switch explicitly to Demo Data.'
        };
        renderAllCells();
        if (dialog.open) {
          app.showKeyPopover = true;
          renderWorkbenchHeaderControls();
          renderWorkbenchRight();
        }
        return;
      }

      const ac = new AbortController();
      app.abortController = ac;
      app.error = null;
      setLoadingState(true);
      renderAllCells();
      if (dialog.open) renderWorkbenchRight();

      Client.runLive(body, apiKey, ac.signal)
        .then(function (liveRes) {
          if (seq !== app.runSeq || app.mode !== 'live') return;
          app.abortController = null;
          setLoadingState(false);
          if (keepGhost && app.result) {
            app.prevResult = app.result;
          } else if (!keepGhost) {
            app.prevResult = null;
          }
          app.result = {
            mode: 'live',
            httpStatus: liveRes.httpStatus,
            latencyMs: liveRes.latencyMs,
            normalized: Schema.normalizeResponse(liveRes.raw, stateSnapshot),
            evaluatedQuestions: stateSnapshot.questions,
            raw: liveRes.raw,
            evaluatedAt: liveRes.evaluatedAt
          };
          app.error = null;
          triggerScanPulse();
          renderAllCells();
          if (dialog.open) {
            renderWorkbenchRight();
            renderWorkbenchHeaderControls();
          }
          announce(
            'Live Decisions API complete: ' +
              validation.activeCount +
              ' answers, 0 output tokens, ' +
              liveRes.latencyMs +
              ' milliseconds.'
          );
        })
        .catch(function (err) {
          if (seq !== app.runSeq || app.mode !== 'live') return;
          if (err && err.aborted) return;
          app.abortController = null;
          setLoadingState(false);
          app.error = err || {
            code: 'UNKNOWN',
            httpStatus: 0,
            headline: 'Live request failed',
            detail: 'Unexpected error calling Gemini Decisions API.',
            remediation: 'Retry or switch explicitly to Demo Data.'
          };
          renderAllCells();
          if (dialog.open) {
            renderWorkbenchRight();
            renderWorkbenchHeaderControls();
          }
          announce('Live request failed: ' + app.error.headline);
        });
    }

    function switchPreset(presetId, variantIndex) {
      setPeerHighlight(false);
      const samePreset = app.state.presetId === presetId;
      app.uploadSeq++;
      app.state = Presets.createPresetState(presetId, variantIndex);
      app.customTextEdited = false;
      app.mediaExpanded = false;
      app.uploadNotice = '';
      if (dialog.open) {
        renderWorkbenchLeft();
        renderWorkbenchHeaderControls();
      }
      runEvaluation({ resetGhost: !samePreset });
    }

    function switchVariant(variantIndex) {
      setPeerHighlight(false);
      const preset = Presets.getPreset(app.state.presetId);
      const variant = preset.variants[variantIndex];
      if (!variant) return;
      app.uploadSeq++;
      app.state.variantIndex = variantIndex;
      app.state.variantId = variant.id;
      app.state.inputText = variant.text;
      app.state.image = variant.imageKind ? Presets.generateSampleImage(variant.imageKind) : null;
      app.customTextEdited = false;
      app.uploadNotice = '';
      if (dialog.open) {
        renderWorkbenchLeft();
        renderWorkbenchHeaderControls();
      }
      runEvaluation({ resetGhost: false });
    }

    // In-place threshold drag & keyboard slider: never detaches active track/pin
    function bindThresholdDrag(surface, controls) {
      const trackEl = controls.trackEl;
      const pinEl = controls.pinEl;
      const fillEl = controls.fillEl;
      const questionObj = controls.questionObj;
      const prob = controls.prob;

      function applyInPlace(nextThreshold) {
        questionObj.threshold = nextThreshold;
        // Also mirror threshold onto matching live app.state question if questionObj came from evaluated snapshot
        const liveMatch = (app.state.questions || []).find(function (sq) {
          return sq && ((questionObj.id && sq.id === questionObj.id) || trimKey(sq.key) === trimKey(questionObj.key));
        });
        if (liveMatch) liveMatch.threshold = nextThreshold;

        const pct = Math.round(nextThreshold * 100) + '%';
        const isYes = prob >= nextThreshold;
        pinEl.style.left = pct;
        pinEl.setAttribute('aria-valuenow', fmtProb(nextThreshold));
        pinEl.setAttribute('aria-valuetext', pct + ' cutoff (' + (isYes ? 'YES' : 'NO') + ')');
        fillEl.classList.toggle('is-below', !isYes);

        if (controls.cutoffEl) {
          controls.cutoffEl.textContent = 'Cutoff ' + pct;
        }
        if (controls.pillEl) {
          controls.pillEl.textContent = (isYes ? 'YES' : 'NO') + ' · ' + fmtPct(prob);
          controls.pillEl.classList.toggle('is-no', !isYes);
        }
        if (controls.tickEl) {
          controls.tickEl.textContent = 'Cutoff ' + pct;
        }
        if (controls.verdictEl) {
          controls.verdictEl.textContent = noulBand(prob, nextThreshold);
          controls.verdictEl.classList.toggle('is-no', !isYes);
        }

        if (surface === 'card') {
          if (dialog.open && app.activeTab === 'results') {
            renderWorkbenchResultsOnly();
          }
        } else {
          if (verdictEl) renderVerdictCell();
        }
      }

      function updateFromClientX(clientX) {
        const rect = trackEl.getBoundingClientRect();
        if (!rect.width) return;
        const ratio = (clientX - rect.left) / rect.width;
        const clamped = Math.round(Schema.clamp(ratio, 0.05, 0.95) * 100) / 100;
        if (questionObj.threshold !== clamped) {
          applyInPlace(clamped);
        }
      }

      trackEl.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (typeof pinEl.focus === 'function') {
          try {
            pinEl.focus({ preventScroll: true });
          } catch (_err) {
            pinEl.focus();
          }
        }
        if (trackEl.setPointerCapture) {
          try {
            trackEl.setPointerCapture(e.pointerId);
          } catch (_err) {
            // ignore
          }
        }
        updateFromClientX(e.clientX);
        function onMove(ev) {
          updateFromClientX(ev.clientX);
        }
        function cleanupDrag() {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
          const idx = activeDragCleanups.indexOf(cleanupDrag);
          if (idx >= 0) activeDragCleanups.splice(idx, 1);
        }
        function onUp() {
          cleanupDrag();
        }
        activeDragCleanups.push(cleanupDrag);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });

      pinEl.addEventListener('keydown', function (e) {
        const cur = Number.isFinite(questionObj.threshold) ? questionObj.threshold : 0.5;
        const step = e.shiftKey ? 0.01 : 0.05;
        let next = null;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - step;
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + step;
        else if (e.key === 'Home') next = 0.05;
        else if (e.key === 'End') next = 0.95;
        if (next !== null) {
          e.preventDefault();
          const clamped = Math.round(Schema.clamp(next, 0.05, 0.95) * 100) / 100;
          if (questionObj.threshold !== clamped) {
            applyInPlace(clamped);
          }
        }
      });
    }

    // =========================================================================
    // CELL 1 (01A) — INPUT & A/B FLIPPER
    // =========================================================================
    function renderInputCell() {
      if (!inputEl || !inputWrap) return;

      const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
      const focusedFlipIdx = activeEl ? renderedFlipBtns.indexOf(activeEl) : -1;
      const focusedPresetIdx = activeEl ? renderedPresetBtns.indexOf(activeEl) : -1;
      const focusedRole =
        activeEl &&
        focusedFlipIdx < 0 &&
        focusedPresetIdx < 0 &&
        nodeContains(inputEl, activeEl) &&
        activeEl.dataset &&
        activeEl.dataset.focusRole
          ? activeEl.dataset.focusRole
          : null;

      const hasSavedKey = Boolean(Client.KeyStore.get());
      const verifiedLive = Boolean(
        !app.error &&
          !app.isRunning &&
          app.mode === 'live' &&
          hasSavedKey &&
          app.result &&
          app.result.mode === 'live'
      );
      const connecting = Boolean(!app.error && app.isRunning && app.mode === 'live');
      const modeKey = app.error ? 'error' : verifiedLive ? 'live' : 'simulated';
      // Pill states (ui/NOTES.md green rule): green only after a live call really returned;
      // a saved key that has not answered yet is idle "Key set"; error and an in-flight call are rust.
      const modeLabel = app.error
        ? 'API error'
        : verifiedLive
          ? 'Live'
          : connecting
            ? 'Connecting…'
            : hasSavedKey && app.mode === 'live'
              ? 'Key set'
              : 'Demo data';
      const modeTone = app.error || connecting ? 'attention' : verifiedLive ? 'ok' : 'idle';
      const modeTip = app.error
        ? 'The last live call failed. Click to see why and fix it.'
        : verifiedLive
          ? 'Answers come live from Gemini with your key. Click to manage the key.'
          : connecting
            ? 'Sending the request to Gemini now. Click to open the studio.'
            : hasSavedKey && app.mode === 'live'
              ? 'Key saved; no live answer yet. Click to manage the key.'
              : hasSavedKey
                ? 'Answers are simulated in this browser. Click to manage your saved key.'
                : 'Answers are simulated in this browser. Click to add a Gemini key.';

      const header = el('header', { className: 'ui-tile-head dc-head' }, [
        el('span', { className: 'ui-tile-step', textContent: '1 · Input' }),
        el('span', { className: 'ui-tile-title ui-hide-compact', textContent: 'Gemini Decisions' }),
        el('div', { className: 'ui-tile-actions' }, [
          el(
            'button',
            {
              type: 'button',
              className: 'ui-pill dc-mode-pill',
              dataset: { mode: modeKey, tone: modeTone, focusRole: 'mode-pill', tip: modeTip },
              'aria-label': 'Mode: ' + modeLabel,
              onClick: function () {
                openWorkbench('mode-pill', { openKeyPopover: true, initialTab: 'results' });
              }
            },
            [el('span', { className: 'ui-pill-label', textContent: modeLabel })]
          ),
          !scoreEl
            ? el('button', {
                type: 'button',
                className: 'ui-btn ui-btn--sm ui-hide-tiny',
                dataset: { focusRole: 'expand-btn', tip: 'Edit the questions, text and image, then run again.' },
                textContent: 'Customize ↗',
                onClick: function () {
                  openWorkbench('expand-btn', { openKeyPopover: false, initialTab: 'results' });
                }
              })
            : null
        ])
      ]);

      const activePreset = Presets.getPreset(app.state.presetId);
      const activeVariant = activePreset.variants[app.state.variantIndex] || activePreset.variants[0];

      // Specimen (the tile's hero): heading on the shared left edge, then the image with its
      // two-line description beside it, or the input text on its own.
      const specimenStage = el('div', { className: 'dc-specimen-stage' });
      if (app.state.image && app.state.image.dataUrl) {
        specimenStage.appendChild(
          el('div', {
            className: 'dc-specimen-heading',
            textContent: app.customTextEdited ? app.state.image.name : (activeVariant.title || activePreset.title)
          })
        );
        const copyCol = el('div', { className: 'dc-specimen-copy ui-hide-tiny' });
        if (!app.customTextEdited && Array.isArray(activeVariant.bullets)) {
          copyCol.appendChild(
            el(
              'ul',
              { className: 'dc-specimen-bullets' },
              activeVariant.bullets.map(function (b) {
                return el('li', { textContent: b });
              })
            )
          );
        } else {
          copyCol.appendChild(el('div', { className: 'dc-specimen-quote', textContent: app.state.inputText }));
        }
        specimenStage.appendChild(
          el('div', { className: 'dc-specimen-row' }, [
            el(
              'button',
              {
                type: 'button',
                className: 'dc-specimen-img-btn',
                dataset: { focusRole: 'specimen-img', tip: 'Open the studio to inspect or replace this image.' },
                'aria-label': 'Inspect or replace specimen image in Workbench',
                onClick: function () {
                  app.mediaExpanded = true;
                  openWorkbench('specimen-img', { openKeyPopover: false, initialTab: 'results' });
                }
              },
              [el('img', { src: app.state.image.dataUrl, alt: app.state.image.name })]
            ),
            copyCol
          ])
        );
      } else {
        specimenStage.appendChild(
          el('div', {
            className: 'dc-specimen-heading',
            textContent: app.customTextEdited ? 'Custom Text Input' : (activeVariant.title || activePreset.title)
          })
        );
        specimenStage.appendChild(
          el('div', { className: 'dc-specimen-quote dc-specimen-quote--solo', textContent: app.state.inputText })
        );
      }

      // A/B flip: same questions, the other input.
      const nextFlipBtns = activePreset.variants.map(function (v, idx) {
        return el('button', {
          type: 'button',
          className: 'dc-flip-btn',
          'aria-pressed': String(idx === app.state.variantIndex),
          textContent: v.buttonLabel || v.label,
          dataset: { tip: 'Run the same questions on: ' + v.summary + '.' },
          onClick: function () {
            switchVariant(idx);
          }
        });
      });
      const flipRow = el(
        'div',
        {
          className: 'ui-seg dc-flip-row ui-hide-tiny',
          role: 'group',
          'aria-label': 'Compare example inputs',
          onMouseenter: function () {
            setPeerHighlight(true);
          },
          onMouseleave: function () {
            setPeerHighlight(false);
          },
          onFocusin: function () {
            if (!restoringInputFocus) setPeerHighlight(true);
          },
          onFocusout: function (e) {
            if (!nodeContains(flipRow, e && e.relatedTarget)) {
              setPeerHighlight(false);
            }
          }
        },
        nextFlipBtns
      );

      const body = el('div', { className: 'ui-tile-body dc-cell-body dc-input-body' }, [specimenStage, flipRow]);

      const nextPresetBtns = Presets.LIST.map(function (p) {
        return el('button', {
          type: 'button',
          className: 'ui-btn ui-btn--sm ui-btn--quiet dc-preset-btn',
          'aria-pressed': String(p.id === app.state.presetId),
          textContent: p.shortLabel,
          dataset: { tip: PRESET_TIPS[p.id] || 'Switch all three tiles to the ' + p.title + ' example.' },
          onClick: function () {
            switchPreset(p.id, 0);
          }
        });
      });

      const footer = el('footer', { className: 'ui-tile-foot dc-input-foot' }, [
        el(
          'div',
          { className: 'dc-preset-tabs', role: 'group', 'aria-label': 'Example scenarios' },
          nextPresetBtns
        )
      ]);

      renderedFlipBtns = nextFlipBtns;
      renderedPresetBtns = nextPresetBtns;

      clearNode(inputWrap);
      inputWrap.appendChild(el('div', { className: 'dc-scanline', 'aria-hidden': 'true' }));
      inputWrap.appendChild(header);
      inputWrap.appendChild(body);
      inputWrap.appendChild(footer);

      if (!dialog.open) {
        let restoreTarget = null;
        if (focusedFlipIdx >= 0 && renderedFlipBtns.length) {
          restoreTarget = renderedFlipBtns[Math.min(focusedFlipIdx, renderedFlipBtns.length - 1)];
        } else if (focusedPresetIdx >= 0 && renderedPresetBtns.length) {
          restoreTarget = renderedPresetBtns[Math.min(focusedPresetIdx, renderedPresetBtns.length - 1)];
        } else if (focusedRole && typeof inputWrap.querySelector === 'function') {
          restoreTarget = inputWrap.querySelector('[data-focus-role="' + focusedRole + '"]');
        }
        if (restoreTarget && typeof restoreTarget.focus === 'function') {
          restoringInputFocus = true;
          try {
            restoreTarget.focus({ preventScroll: true });
          } catch (_e) {
            try {
              restoreTarget.focus();
            } catch (_e2) {
              // ignore
            }
          } finally {
            restoringInputFocus = false;
          }
        }
      }
    }

    // Provenance tag for tiles 2 and 3. It must stay visible at every tile size (unlike
    // the step-3 footer, which the < 320 px container step hides), and it follows the
    // result on screen, not app.mode: while a live call is "Connecting…" the old demo numbers are
    // still what is shown.
    function buildResultTag() {
      if (app.error || !app.result) return null;
      const isDemo = app.result.mode !== 'live';
      if (!isDemo && !app.dirty) return null;
      // Idle grey pill; rust when the tiles no longer match the edited input (it needs a Run).
      return el(
        'span',
        {
          className: 'ui-pill dc-result-tag' + (isDemo ? ' is-demo' : ''),
          dataset: {
            tone: app.dirty ? 'attention' : 'idle',
            tip: app.dirty
              ? 'These answers predate your studio edits. Open Customize and press Run.'
              : 'Simulated in this browser, not a Gemini answer. Add a key to go live.'
          }
        },
        // Below 320 px the label shortens ("Demo" keeps its word, "Live · edited" becomes "edited")
        // so the step label and Customize still fit; the tone and tip keep the full meaning.
        [
          el(
            'span',
            { className: 'ui-pill-label' },
            !app.dirty
              ? ['Demo']
              : isDemo
                ? ['Demo', el('span', { className: 'ui-hide-compact', textContent: ' · edited' })]
                : [el('span', { className: 'ui-hide-compact', textContent: 'Live · ' }), 'edited']
          )
        ]
      );
    }

    function emptyAnswerText(type, label, renderQuestions, hasPending) {
      const invalid = app.result && app.result.normalized && Array.isArray(app.result.normalized.invalid)
        ? app.result.normalized.invalid
        : [];
      const bad = invalid.find(function (item) {
        return renderQuestions.some(function (q) {
          return q.type === type && trimKey(q.key) === item.key;
        });
      });
      if (bad) return 'No valid ' + label + ' answer returned for "' + bad.key + '" — see Raw Response in JSON ↗';
      return hasPending
        ? label + ' question edited — click Run in Customize ↗'
        : 'No ' + label + ' question active — enable in Customize ↗';
    }

    // Empty / invalid answer slot. data-state: "invalid" (the API answered, but not usably: rust),
    // "pending" (edited, not run yet) or "off" (no such question enabled).
    function emptyAnswerEl(type, label, renderQuestions, hasPending) {
      const text = emptyAnswerText(type, label, renderQuestions, hasPending);
      const state = /^No valid /.test(text) ? 'invalid' : hasPending ? 'pending' : 'off';
      return el('div', { className: 'dc-empty-state', dataset: { state: state } }, [
        el('span', {
          className: 'ui-label',
          textContent: state === 'invalid' ? 'No answer' : state === 'pending' ? 'Not run yet' : 'Off'
        }),
        el('span', { className: 'dc-empty-text', textContent: text })
      ]);
    }

    // =========================================================================
    // CELL 2 (01B) — YES/NO CHECK (noul) + PICK A CATEGORY (choice)
    // =========================================================================
    function renderVerdictCell() {
      if (!verdictEl || !verdictWrap) return;
      // No "→" step arrow: when the strip wraps (phone, Motion reflow) tile 3 is not to the right.
      const header = el('header', { className: 'ui-tile-head dc-head' }, [
        el('span', { className: 'ui-tile-step' }, ['2 · Check', el('span', { className: 'ui-hide-tiny', textContent: ' & route' })]),
        el('span', {
          className: 'ui-tile-title ui-hide-compact',
          textContent: 'Yes/no + category',
          dataset: { tip: 'Two decision types in one call: a yes/no check (noul) and a pick-one category (choice).' }
        }),
        el('div', { className: 'ui-tile-actions' }, [buildResultTag()])
      ]);

      const body = el('div', { className: 'ui-tile-body dc-cell-body dc-verdict-body' });

      if (app.error) {
        body.appendChild(
          el('div', { className: 'dc-card-error', role: 'alert' }, [
            el('div', { className: 'dc-card-error-title', textContent: app.error.headline }),
            el('div', { className: 'dc-card-error-text', textContent: app.error.remediation }),
            el('div', { className: 'dc-card-error-actions' }, [
              // Retrying without a key repeats the same error, so the button is only offered when it can help.
              app.error.code !== 'MISSING_KEY'
                ? el('button', {
                    type: 'button',
                    className: 'ui-btn ui-btn--sm',
                    dataset: { focusRole: 'verdict-retry', tip: 'Send the same request to Gemini again.' },
                    textContent: 'Retry Live',
                    onClick: function () {
                      runEvaluation({ resetGhost: false });
                    }
                  })
                : null,
              isKeyError(app.error)
                ? el('button', {
                    type: 'button',
                    className: 'ui-btn ui-btn--sm',
                    dataset: { focusRole: 'verdict-key-btn', tip: 'Open the studio with the key form ready.' },
                    textContent: 'Update API Key',
                    onClick: function () {
                      openWorkbench('verdict-key-btn', { openKeyPopover: true, initialTab: 'results' });
                    }
                  })
                : null,
              el('button', {
                type: 'button',
                className: 'ui-btn ui-btn--sm',
                dataset: {
                  focusRole: 'verdict-demo',
                  tip: app.error.code === 'MISSING_KEY'
                    ? 'Show simulated answers instead; no key needed.'
                    : 'Show simulated answers instead; your key stays saved.'
                },
                textContent: 'Switch to Demo',
                onClick: function () {
                  app.mode = 'simulated';
                  app.error = null;
                  runEvaluation({ resetGhost: true });
                }
              })
            ])
          ])
        );
      } else if (app.result && app.result.normalized) {
        const answers = app.result.normalized.answers;
        const prevAnswers = app.prevResult && app.prevResult.normalized ? app.prevResult.normalized.answers : {};
        const renderQuestions = (Array.isArray(app.result.evaluatedQuestions) ? app.result.evaluatedQuestions : app.state.questions).filter(function (q) {
          return q && q.enabled !== false;
        });
        const liveEnabledQuestions = app.state.questions.filter(function (q) {
          return q && q.enabled !== false;
        });

        const noulQ = renderQuestions.find(function (q) {
          const qk = trimKey(q.key);
          return q.type === 'noul' && Boolean(answers[qk]);
        });
        const choiceQ = renderQuestions.find(function (q) {
          const qk = trimKey(q.key);
          return q.type === 'choice' && Boolean(answers[qk]);
        });
        const hasPendingNoul = !noulQ && liveEnabledQuestions.some(function (q) { return q.type === 'noul'; });
        const hasPendingChoice = !choiceQ && liveEnabledQuestions.some(function (q) { return q.type === 'choice'; });

        // Top Half: Yes/No Check (noul)
        if (noulQ) {
          const qk = trimKey(noulQ.key);
          const ans = answers[qk];
          const prev = prevAnswers[qk];
          const thresh = Number.isFinite(noulQ.threshold) ? noulQ.threshold : 0.5;
          const isYes = ans.noul >= thresh;
          const deltaPts = prev && prev.type === 'noul' ? fmtSignedPts(ans.noul - prev.noul) : null;

          const fillEl = el('div', {
            className: 'dc-noul-fill' + (isYes ? '' : ' is-below'),
            style: { width: Math.round(ans.noul * 100) + '%' }
          });
          const track = el('div', {
            className: 'dc-noul-track',
            dataset: { tip: 'Drag the marker to move the cutoff between NO and YES.' }
          });
          track.appendChild(fillEl);
          if (prev && prev.type === 'noul') {
            track.appendChild(
              el('div', {
                className: 'dc-noul-ghost',
                dataset: { tip: "Previous run's probability of yes: " + fmtPct(prev.noul) + '.' },
                style: { left: Math.round(prev.noul * 100) + '%' }
              })
            );
          }
          const pin = el('button', {
            type: 'button',
            className: 'dc-noul-pin',
            role: 'slider',
            dataset: { focusRole: 'cutoff-pin', tip: 'Cutoff between NO and YES. Drag it or use the arrow keys.' },
            'aria-label': 'Yes/No cutoff for ' + (noulQ.cardQuestion || qk),
            'aria-valuemin': '0.05',
            'aria-valuemax': '0.95',
            'aria-valuenow': fmtProb(thresh),
            'aria-valuetext': fmtPct(thresh) + ' cutoff (' + (isYes ? 'YES' : 'NO') + ')',
            style: { left: Math.round(thresh * 100) + '%' }
          });
          track.appendChild(pin);
          track.appendChild(
            el('div', {
              className: 'dc-noul-needle',
              style: { left: Math.round(ans.noul * 100) + '%' }
            })
          );

          const pillEl = el('span', {
            className: 'dc-verdict-pill' + (isYes ? '' : ' is-no'),
            dataset: { tip: "Gemini's probability of yes; the cutoff turns it into YES or NO." },
            textContent: (isYes ? 'YES' : 'NO') + ' · ' + fmtPct(ans.noul)
          });
          const cutoffEl = el('span', { className: 'dc-cutoff-label', textContent: 'Cutoff ' + fmtPct(thresh) });

          bindThresholdDrag('card', {
            trackEl: track,
            pinEl: pin,
            fillEl: fillEl,
            pillEl: pillEl,
            cutoffEl: cutoffEl,
            questionObj: noulQ,
            prob: ans.noul
          });

          body.appendChild(
            el('div', { className: 'dc-half dc-half--noul' }, [
              el('div', { className: 'dc-q-headline' }, [
                el('span', {
                  className: 'dc-plain-q',
                  textContent: noulQ.cardQuestion || noulQ.instructions || qk,
                  dataset: { tip: noulQ.instructions || null }
                }),
                deltaPts
                  ? el('span', {
                      className: 'dc-delta-chip ui-hide-compact',
                      dataset: { tip: 'Change since the previous run, in percentage points.' },
                      textContent: deltaPts
                    })
                  : null,
                pillEl
              ]),
              track,
              el('div', { className: 'dc-verdict-subrow ui-hide-tiny' }, [
                cutoffEl,
                el('span', {
                  className: 'ui-hide-compact',
                  dataset: { tip: 'Gemini reports yes between 1% and 99%, never a flat 0% or 100%.' },
                  textContent: '1–99% calibrated'
                })
              ])
            ])
          );
        } else {
          body.appendChild(
            el('div', { className: 'dc-half dc-half--noul' }, [
              emptyAnswerEl('noul', 'Yes/No', renderQuestions, hasPendingNoul)
            ])
          );
        }

        // Bottom Half: Pick a Category (choice)
        if (choiceQ) {
          const qk = trimKey(choiceQ.key);
          const ans = answers[qk];
          const top = ans.ranked[0] || { key: ans.choice || '—', prob: 0 };
          const winnerKey = ans.choice || top.key;
          const winnerLabel = optionHumanLabel(choiceQ, winnerKey);
          // Round across every option first, then cut to the top 3, so shown + hidden add up.
          const catPcts = Schema.toDisplayPercents(ans.ranked.map(function (r) { return r.prob; }));
          const SHOWN = 3;
          const hiddenCount = Math.max(0, ans.ranked.length - SHOWN);
          const hiddenPct = catPcts.slice(SHOWN).reduce(function (a, b) { return a + b; }, 0);
          const winnerIdx = ans.ranked.findIndex(function (r) { return r.key === winnerKey; });
          const winnerPct = winnerIdx >= 0 ? catPcts[winnerIdx] : Math.round((ans.winnerProb || 0) * 100);

          const bars = el('div', { className: 'dc-cat-bars' });
          ans.ranked.slice(0, SHOWN).forEach(function (r, idx) {
            const isWin = r.key === winnerKey;
            bars.appendChild(
              el('div', { className: 'dc-cat-row' + (isWin ? ' is-winner' : ''), dataset: { tip: r.description || r.key } }, [
                el('span', { className: 'dc-cat-name', textContent: optionHumanLabel(choiceQ, r.key) }),
                el('div', { className: 'dc-cat-track' }, [
                  el('div', {
                    className: 'dc-cat-fill',
                    style: { width: Math.max(2, Math.min(100, Math.round(r.prob * 100))) + '%' }
                  })
                ]),
                el('span', { className: 'dc-cat-pct', textContent: catPcts[idx] + '%' })
              ])
            );
          });

          body.appendChild(
            el('div', { className: 'dc-half dc-half--choice' }, [
              el('div', { className: 'dc-q-headline' }, [
                el('span', {
                  className: 'dc-plain-q',
                  textContent: choiceQ.cardQuestion || choiceQ.instructions || qk,
                  dataset: { tip: choiceQ.instructions || null }
                }),
                el('span', {
                  className: 'dc-cat-extra ui-hide-tiny',
                  textContent: hiddenCount
                    ? '+' + hiddenCount + ' more · ' + hiddenPct + '%'
                    : winnerLabel + ' ' + winnerPct + '%',
                  dataset: {
                    tip: hiddenCount
                      ? 'Not shown: ' + ans.ranked.slice(SHOWN).map(function (r, i) {
                          return optionHumanLabel(choiceQ, r.key) + ' ' + catPcts[SHOWN + i] + '%';
                        }).join(', ') + '.'
                      : 'Top category and its probability.'
                  }
                })
              ]),
              bars
            ])
          );
        } else {
          body.appendChild(
            el('div', { className: 'dc-half dc-half--choice' }, [
              emptyAnswerEl('choice', 'Category', renderQuestions, hasPendingChoice)
            ])
          );
        }
      }

      const focusRole = focusedRoleIn(verdictEl);
      clearNode(verdictWrap);
      verdictWrap.appendChild(el('div', { className: 'dc-scanline', 'aria-hidden': 'true' }));
      verdictWrap.appendChild(header);
      verdictWrap.appendChild(body);
      restoreTileFocus(verdictEl, focusRole);
    }

    // Tiles 2 and 3 are rebuilt on every result; keep keyboard focus on the same control
    // (data-focus-role), or on the mode pill when that control no longer exists (e.g. the error
    // buttons after "Switch to Demo").
    function focusedRoleIn(tileEl) {
      const a = document.activeElement;
      if (!a || dialog.open || !nodeContains(tileEl, a) || !a.dataset || !a.dataset.focusRole) return null;
      return a.dataset.focusRole;
    }

    function restoreTileFocus(tileEl, role) {
      if (!role || dialog.open) return;
      const target =
        tileEl.querySelector('[data-focus-role="' + cssEscape(role) + '"]') ||
        (inputEl ? inputEl.querySelector('[data-focus-role="mode-pill"]') : null);
      if (!target || typeof target.focus !== 'function') return;
      try {
        target.focus({ preventScroll: true });
      } catch (_e) {
        target.focus();
      }
    }

    // =========================================================================
    // CELL 3 (01C) — RUBRIC SCORE (score) + ZERO-OUTPUT-TOKEN PROOF
    // =========================================================================
    function renderScoreCell() {
      if (!scoreEl || !scoreWrap) return;
      // The result tag sits in the header too: the footer (with its "Demo · 0 words generated"
      // badge) is hidden below 320 px, and demo numbers must stay labelled at every size.
      const header = el('header', { className: 'ui-tile-head dc-head' }, [
        el('span', { className: 'ui-tile-step' }, ['3 · Rubric', el('span', { className: 'ui-hide-compact', textContent: ' & proof' })]),
        el('span', {
          className: 'ui-tile-title ui-hide-compact',
          textContent: 'Score',
          dataset: { tip: 'One rubric score (score): probabilities over ordered levels, averaged into one number.' }
        }),
        el('div', { className: 'ui-tile-actions' }, [
          buildResultTag(),
          el(
            'button',
            {
              type: 'button',
              className: 'ui-btn ui-btn--sm ui-hide-tiny',
              dataset: { focusRole: 'expand-btn', tip: 'Edit the questions, text and image, then run again.' },
              'aria-label': 'Customize: open the Decisions studio',
              onClick: function () {
                openWorkbench('expand-btn', { openKeyPopover: false, initialTab: 'results' });
              }
            },
            'Customize ↗'
          )
        ])
      ]);

      const body = el('div', { className: 'ui-tile-body dc-cell-body dc-score-body' });
      const mainArea = el('div', { className: 'dc-score-main' });

      if (app.error) {
        mainArea.appendChild(
          el('div', { className: 'dc-empty-state', dataset: { state: 'error' } }, [
            el('span', { className: 'ui-label', textContent: 'Paused' }),
            el('span', { className: 'dc-empty-text', textContent: 'No score while the live call is failing. Fix it in step 2 or the studio.' }),
            el('button', {
              type: 'button',
              className: 'ui-btn ui-btn--sm',
              dataset: { focusRole: 'score-open-wb', tip: 'Open the studio to see the error and fix it.' },
              textContent: 'Open Workbench',
              onClick: function () {
                openWorkbench('score-open-wb', { openKeyPopover: false, initialTab: 'results' });
              }
            })
          ])
        );
      } else if (app.result && app.result.normalized) {
        const answers = app.result.normalized.answers;
        const prevAnswers = app.prevResult && app.prevResult.normalized ? app.prevResult.normalized.answers : {};
        const renderQuestions = (Array.isArray(app.result.evaluatedQuestions) ? app.result.evaluatedQuestions : app.state.questions).filter(function (q) {
          return q && q.enabled !== false;
        });
        const liveEnabledQuestions = app.state.questions.filter(function (q) {
          return q && q.enabled !== false;
        });

        const scoreQ = renderQuestions.find(function (q) {
          const qk = trimKey(q.key);
          return q.type === 'score' && Boolean(answers[qk]);
        });
        const hasPendingScore = !scoreQ && liveEnabledQuestions.some(function (q) { return q.type === 'score'; });

        if (scoreQ) {
          const qk = trimKey(scoreQ.key);
          const ans = answers[qk];
          const prev = prevAnswers[qk];
          const cols = Math.max(2, ans.levels.length);
          const evPct = computeScorePointerPct(ans.score, ans.min, ans.max, cols);
          const deltaStr = prev && prev.type === 'score' ? fmtSignedDelta(ans.score - prev.score) : null;
          const peakLvl = ans.levels.find(function (l) {
            return l.index === ans.peakIndex;
          }) || ans.levels[0];
          const peakIdx = Math.max(0, ans.levels.indexOf(peakLvl));
          const peakName = peakLvl ? shortLevelLabel(scoreQ, peakLvl, peakIdx) : '';
          const cert = certaintyLabel(ans.stdDev, ans.min, ans.max, ans.sum);
          const levelPcts = Schema.toDisplayPercents(ans.levels.map(function (l) { return l.prob; }));

          mainArea.appendChild(
            el('div', { className: 'dc-q-headline' }, [
              el('span', {
                className: 'dc-plain-q',
                textContent: scoreQ.cardQuestion || scoreQ.instructions || qk,
                dataset: { tip: scoreQ.instructions || null }
              })
            ])
          );

          mainArea.appendChild(
            el('div', { className: 'dc-score-hero-row' }, [
              el('div', { className: 'dc-score-hero-left' }, [
                el('span', {
                  className: 'ui-readout ui-readout--hero dc-score-big',
                  textContent: ans.score.toFixed(1),
                  dataset: { tip: 'Weighted average level, from ' + ans.min + ' to ' + ans.max + '.' }
                }),
                el('span', { className: 'dc-score-denom', textContent: '/ ' + ans.max }),
                peakName ? el('span', { className: 'dc-score-tier', textContent: peakName }) : null
              ]),
              el('div', { className: 'dc-score-meta ui-hide-tiny' }, [
                deltaStr
                  ? el('span', {
                      className: 'dc-delta-chip',
                      dataset: { tip: 'Change in score since the previous run.' },
                      textContent: deltaStr
                    })
                  : null,
                cert
                  ? el('span', {
                      className: 'dc-certainty-tag ui-hide-compact',
                      textContent: cert,
                      dataset: {
                        tip: 'Spread of the level probabilities: σ = ' + ans.stdDev.toFixed(2) + ' levels; lower is surer.'
                      }
                    })
                  : null
              ])
            ])
          );

          const barsGrid = el('div', {
            className: 'dc-card-bars',
            style: { gridTemplateColumns: 'repeat(' + cols + ', 1fr)' }
          });
          ans.levels.forEach(function (lvl, idx) {
            const isPeak = lvl.index === ans.peakIndex;
            barsGrid.appendChild(
              el('div', { className: 'dc-card-bar-col', dataset: { tip: levelPcts[idx] + '% · ' + lvl.description } }, [
                el('span', { className: 'dc-card-bar-pct', textContent: levelPcts[idx] + '%' }),
                el('div', {
                  className: 'dc-card-bar' + (isPeak ? ' is-peak' : ''),
                  style: { height: Math.max(8, Math.round(Math.min(1, lvl.prob) * 72)) + '%' }
                })
              ])
            );
          });
          barsGrid.appendChild(
            el('div', {
              className: 'dc-card-ev-pointer',
              dataset: { tip: 'Weighted average score: ' + ans.score.toFixed(2) + ' of ' + ans.max + '.' },
              style: { left: evPct + '%' }
            })
          );

          const labelsGrid = el('div', {
            className: 'dc-card-bar-labels',
            style: { gridTemplateColumns: 'repeat(' + cols + ', 1fr)' }
          });
          ans.levels.forEach(function (lvl, idx) {
            const isPeak = lvl.index === ans.peakIndex;
            labelsGrid.appendChild(
              el('span', {
                className: 'dc-card-bar-lbl' + (isPeak ? ' is-peak' : ''),
                textContent: shortLevelLabel(scoreQ, lvl, idx),
                dataset: { tip: lvl.description }
              })
            );
          });

          mainArea.appendChild(el('div', { className: 'dc-card-chart' }, [barsGrid, labelsGrid]));
        } else {
          mainArea.appendChild(emptyAnswerEl('score', 'Rubric', renderQuestions, hasPendingScore));
        }
      }

      // Signature Zero-Output-Token Proof Strip
      const usage = !app.error && app.result && app.result.normalized ? app.result.normalized.usage : null;
      const outTok = usage ? usage.total_output_tokens : 0;
      const answerCount = !app.error && app.result && app.result.normalized
        ? Object.keys(app.result.normalized.answers || {}).length
        : 0;
      const resultIsLive = Boolean(!app.error && app.result && app.result.mode === 'live');
      const answersText = answerCount + ' answer' + (answerCount === 1 ? '' : 's');
      // Demo results come from the local simulator: no API call was made, so never claim "1 call".
      const timingText = app.isRunning
        ? 'running…'
        : resultIsLive
          ? app.result.latencyMs + 'ms · 1 call · ' + answersText
          : 'no API call · ' + answersText;
      // In Demo the badge itself carries the label (a separate tag wraps the strip onto two lines
      // in the 177px phone tile and squeezes the chart).
      // "0 words generated" is a claim about the result, not a connection: a plain readout, never green.
      const proofLeftChildren = app.error
        ? [el('span', { className: 'dc-proof-meta', textContent: 'Live error · no active result' })]
        : [
            el('span', {
              className: 'ui-readout dc-zero-badge' + (resultIsLive ? '' : ' is-demo'),
              textContent: (resultIsLive ? '' : 'Demo · ') + outTok + ' words generated',
              dataset: {
                tip:
                  (resultIsLive
                    ? 'Gemini returned only probabilities: total_output_tokens is ' + outTok + '.'
                    : 'Simulated in this browser: no request, so no tokens.') +
                  (app.dirty ? ' Studio edits are not run yet.' : '')
              }
            }),
            el('span', {
              className: 'dc-proof-meta',
              textContent: (app.dirty ? 'edited · ' : '') + timingText,
              dataset: {
                tip: app.isRunning
                  ? 'Waiting for the live response.'
                  : resultIsLive
                    ? 'Round-trip time; all ' + answersText + ' came from one API request.'
                    : 'Demo answers are computed locally; no API request was sent.'
              }
            })
          ];

      const proofStrip = el('footer', { className: 'ui-tile-foot dc-proof-strip' }, [
        el('div', { className: 'dc-proof-left' }, proofLeftChildren),
        el('button', {
          type: 'button',
          className: 'ui-btn ui-btn--sm ui-btn--quiet dc-link-btn',
          dataset: { focusRole: 'json-btn', tip: 'Open the exact request JSON and cURL command.' },
          textContent: 'JSON ↗',
          onClick: function () {
            openWorkbench('json-btn', { openKeyPopover: false, initialTab: 'request' });
          }
        })
      ]);

      body.appendChild(mainArea);

      const focusRole = focusedRoleIn(scoreEl);
      clearNode(scoreWrap);
      scoreWrap.appendChild(el('div', { className: 'dc-scanline', 'aria-hidden': 'true' }));
      scoreWrap.appendChild(header);
      scoreWrap.appendChild(body);
      scoreWrap.appendChild(proofStrip);
      restoreTileFocus(scoreEl, focusRole);
    }

    // =========================================================================
    // 2. EXPANDED WORKBENCH (<dialog>)
    // =========================================================================
    function buildWorkbenchShell() {
      clearNode(dialog);

      const scanline = el('div', { className: 'dc-scanline', 'aria-hidden': 'true' });

      const presetSelect = el('select', {
        className: 'dc-select',
        'aria-label': 'Choose preset scenario',
        dataset: { tip: 'Load an example: its input and three questions; the cutoff resets to 50%.' },
        onChange: function (e) {
          switchPreset(e.target.value, 0);
        }
      });
      Presets.LIST.forEach(function (p) {
        presetSelect.appendChild(el('option', { value: p.id, textContent: p.title }));
      });
      wbRefs.presetSelect = presetSelect;

      const variantSeg = el('div', { className: 'ui-seg dc-seg', role: 'group', 'aria-label': 'Input variant' });
      wbRefs.variantSeg = variantSeg;

      const modeSeg = el('div', { className: 'ui-seg dc-seg', role: 'group', 'aria-label': 'Execution mode' });
      wbRefs.modeSeg = modeSeg;

      const keyBtn = el('button', {
        type: 'button',
        className: 'ui-btn dc-key-btn',
        dataset: { tip: 'Add, replace or clear your Gemini API key.' },
        'aria-haspopup': 'dialog',
        'aria-controls': 'dc-key-popover',
        'aria-expanded': 'false',
        onClick: function () {
          app.showKeyPopover = !app.showKeyPopover;
          renderKeyPopover();
          if (app.showKeyPopover && wbRefs.keyInput) {
            wbRefs.keyInput.focus();
          }
        }
      });
      wbRefs.keyBtn = keyBtn;

      const keyPopover = el('div', {
        id: 'dc-key-popover',
        className: 'dc-key-popover',
        role: 'region',
        'aria-label': 'Gemini API Key configuration',
        hidden: true
      });
      wbRefs.keyPopover = keyPopover;

      const keyAnchor = el('div', { className: 'dc-key-anchor' }, [keyBtn, keyPopover]);
      wbRefs.keyAnchor = keyAnchor;

      const runBtn = el('button', {
        type: 'button',
        className: 'ui-btn ui-btn--primary dc-run-btn',
        dataset: { tipKey: '⌘↵' },
        onClick: function () {
          runEvaluation({ resetGhost: false });
        }
      });
      wbRefs.runBtn = runBtn;

      const closeBtn = el('button', {
        type: 'button',
        className: 'ui-btn',
        dataset: { tip: 'Back to the grid.', tipKey: 'Esc' },
        textContent: 'Close',
        onClick: closeWorkbench
      });

      // Studio bar: identity on the left, the input pickers, then mode, key, Run (the one black
      // button) and Close, always last on the right.
      const bar = el('header', { className: 'ui-studio-bar dc-wb-bar' }, [
        el('span', { className: 'ui-tile-index', textContent: '01' }),
        el('h2', { id: 'dc-wb-heading', className: 'ui-studio-title', textContent: 'Decisions API Studio' }),
        el('span', {
          className: 'ui-label dc-model-chip',
          textContent: Schema.MODEL,
          dataset: { tip: 'The Decisions model every request from this studio uses.' }
        }),
        el('div', { className: 'dc-wb-pickers' }, [presetSelect, variantSeg]),
        el('div', { className: 'ui-studio-actions' }, [modeSeg, keyAnchor, runBtn, closeBtn])
      ]);

      const leftPane = el('div', { className: 'dc-pane dc-pane--left' });
      const rightPane = el('div', { className: 'dc-pane dc-pane--right' });
      wbRefs.leftPane = leftPane;
      wbRefs.rightPane = rightPane;

      const body = el('div', { className: 'dc-wb-body' }, [leftPane, rightPane]);

      dialog.appendChild(scanline);
      dialog.appendChild(bar);
      dialog.appendChild(body);
    }

    function updateRunButton(validationOpt) {
      if (!wbRefs.runBtn) return;
      const validation = validationOpt || getValidation();
      wbRefs.runBtn.disabled = app.isRunning || !validation.valid;
      // Always the one black button; live vs demo is in its label and tip, not a second colour.
      wbRefs.runBtn.className = 'ui-btn ui-btn--primary dc-run-btn';
      clearNode(wbRefs.runBtn);
      const label = app.isRunning
        ? 'Running…'
        : !validation.valid
          ? validation.errors.length + ' Schema Issue' + (validation.errors.length === 1 ? '' : 's')
          : app.mode === 'live'
            ? 'Run Live'
            : 'Run Demo';
      wbRefs.runBtn.appendChild(document.createTextNode(label));
      wbRefs.runBtn.dataset.tip = app.isRunning
        ? 'A live request is in flight; wait for its answer.'
        : !validation.valid
          ? 'Fix the highlighted fields on the left to run.'
          : app.mode === 'live'
            ? 'Send every active question to Gemini in one request.'
            : 'Simulate every active question in this browser; no request is sent.';
    }

    function updateActiveQuestionsCountLabel() {
      if (!wbRefs.questionsCountLabel) return;
      const activeCount = app.state.questions.filter(function (q) {
        return q.enabled !== false;
      }).length;
      wbRefs.questionsCountLabel.textContent = 'Batched Questions (' + activeCount + ' active)';
    }

    function resetKeyPopoverHiddenState() {
      app.showKeyPopover = false;
      app.keyVisible = false;
      if (wbRefs.keyInput) {
        wbRefs.keyInput.type = 'password';
      }
      if (wbRefs.keyToggleVisBtn) {
        wbRefs.keyToggleVisBtn.textContent = 'Show';
      }
      if (wbRefs.keyPopover) {
        wbRefs.keyPopover.hidden = true;
      }
      if (wbRefs.keyBtn) {
        wbRefs.keyBtn.setAttribute('aria-expanded', 'false');
      }
    }

    function closeKeyPopover(restoreFocus) {
      const wasOpen = app.showKeyPopover || Boolean(wbRefs.keyPopover && !wbRefs.keyPopover.hidden);
      resetKeyPopoverHiddenState();
      if (!wasOpen) return;
      if (restoreFocus && wbRefs.keyBtn) {
        wbRefs.keyBtn.focus();
      }
    }

    function renderKeyPopover(forceRebuild) {
      const pop = wbRefs.keyPopover;
      if (!pop) return;
      if (!app.showKeyPopover) {
        resetKeyPopoverHiddenState();
        return;
      }
      if (wbRefs.keyBtn) {
        wbRefs.keyBtn.setAttribute('aria-expanded', 'true');
      }
      const wasOpen = !pop.hidden;
      pop.hidden = false;
      if (wasOpen && !forceRebuild && wbRefs.keyInput && document.activeElement === wbRefs.keyInput) {
        return;
      }

      clearNode(pop);
      const existing = Client.KeyStore.get();
      const storeType = Client.KeyStore.getStorageType();

      pop.appendChild(
        el('div', { className: 'dc-key-note' }, [
          'Uses your standard ',
          el('strong', { textContent: 'Gemini API key' }),
          ' (no separate Decisions API key required). Sent directly from your browser via ',
          el('code', { className: 'dc-code', textContent: 'x-goog-api-key' }),
          ' to ',
          el('code', { className: 'dc-code', textContent: 'generativelanguage.googleapis.com' }),
          '. ',
          el('a', {
            href: 'https://aistudio.google.com/apikey',
            target: '_blank',
            rel: 'noopener noreferrer',
            textContent: 'Get a key ↗'
          })
        ])
      );

      let saveAndGoLive;
      const input = el('input', {
        type: app.keyVisible ? 'text' : 'password',
        className: 'dc-input dc-input--mono',
        'aria-label': 'Gemini API Key',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: 'AIza...',
        value: existing,
        onKeydown: function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            if (saveAndGoLive) saveAndGoLive();
          }
        }
      });
      wbRefs.keyInput = input;

      const toggleVisBtn = el('button', {
        type: 'button',
        className: 'ui-btn dc-key-vis-btn',
        dataset: { tip: 'Show or hide the key while you check it.' },
        textContent: app.keyVisible ? 'Hide' : 'Show',
        onClick: function () {
          app.keyVisible = !app.keyVisible;
          input.type = app.keyVisible ? 'text' : 'password';
          toggleVisBtn.textContent = app.keyVisible ? 'Hide' : 'Show';
        }
      });
      wbRefs.keyToggleVisBtn = toggleVisBtn;

      pop.appendChild(
        el('div', { className: 'dc-field' }, [
          el('span', { className: 'ui-label', 'aria-hidden': 'true', textContent: 'Gemini API key' }),
          el('div', { className: 'dc-key-input-row' }, [input, toggleVisBtn])
        ])
      );

      const persistCheck = el('input', {
        type: 'checkbox',
        checked: storeType === 'local'
      });

      pop.appendChild(
        el('label', { className: 'dc-checkbox-row' }, [
          persistCheck,
          'Remember in this browser (off: this tab only)'
        ])
      );

      if (Client.KeyStore.isStorageRestricted()) {
        pop.appendChild(
          el('div', {
            className: 'dc-key-note',
            textContent: 'Browser storage is restricted on this origin; key is kept in page memory until reload.'
          })
        );
      }

      saveAndGoLive = function () {
        const val = input.value.trim();
        if (!val) {
          lastKnownKey = '';
          Client.KeyStore.clear();
          app.mode = 'simulated';
          app.error = null;
          closeKeyPopover(true);
          renderWorkbenchHeaderControls();
          runEvaluation({ resetGhost: true });
          return;
        }
        lastKnownKey = val;
        Client.KeyStore.set(val, persistCheck.checked);
        app.mode = 'live';
        app.error = null;
        // Focus goes back to the key button; leaving it on the now-hidden input drops it to <body>.
        closeKeyPopover(true);
        renderWorkbenchHeaderControls();
        runEvaluation({ resetGhost: true });
      };

      // Not black: Run in the studio bar is the one primary. The commit action gets an ink outline.
      const saveBtn = el('button', {
        type: 'button',
        className: 'ui-btn dc-key-save',
        dataset: { tip: 'Save the key and run all questions live now. Empty clears it.', tipKey: 'Enter' },
        textContent: 'Save & Go Live',
        onClick: saveAndGoLive
      });

      const clearBtn = el('button', {
        type: 'button',
        className: 'ui-btn ui-btn--quiet',
        dataset: { tip: existing ? 'Forget the key and switch to demo data.' : 'No key is saved yet.' },
        textContent: 'Clear Key',
        disabled: !existing,
        onClick: function () {
          lastKnownKey = '';
          Client.KeyStore.clear();
          app.mode = 'simulated';
          app.error = null;
          closeKeyPopover(true);
          renderWorkbenchHeaderControls();
          runEvaluation({ resetGhost: true });
        }
      });

      const closePopBtn = el('button', {
        type: 'button',
        className: 'ui-btn ui-btn--quiet',
        dataset: { tip: 'Close this form without saving.', tipKey: 'Esc' },
        textContent: 'Cancel',
        onClick: function () {
          closeKeyPopover(true);
        }
      });

      pop.appendChild(
        el('div', { className: 'dc-key-footer' }, [
          el('div', { className: 'dc-key-footer-left' }, [clearBtn, closePopBtn]),
          saveBtn
        ])
      );
    }

    function renderWorkbenchHeaderControls() {
      if (!wbRefs.presetSelect) return;
      const focusSnap = captureWorkbenchFocus();
      wbRefs.presetSelect.value = app.state.presetId;

      const preset = Presets.getPreset(app.state.presetId);
      clearNode(wbRefs.variantSeg);
      preset.variants.forEach(function (v, idx) {
        wbRefs.variantSeg.appendChild(
          el('button', {
            type: 'button',
            dataset: { fk: 'variant-' + idx, tip: 'Run the same questions on: ' + v.summary + '.' },
            'aria-pressed': String(idx === app.state.variantIndex),
            textContent: v.label,
            onClick: function () {
              switchVariant(idx);
            }
          })
        );
      });

      clearNode(wbRefs.modeSeg);
      ['simulated', 'live'].forEach(function (m) {
        wbRefs.modeSeg.appendChild(
          el('button', {
            type: 'button',
            dataset: {
              fk: 'mode-' + m,
              tip:
                m === 'simulated'
                  ? 'Simulate answers in this browser; nothing is sent.'
                  : Client.KeyStore.get()
                    ? 'Send requests to Gemini with your saved key.'
                    : 'Needs a Gemini API key; click to add one.'
            },
            'aria-pressed': String(app.mode === m),
            textContent: m === 'live' ? 'Live API' : 'Demo Data',
            onClick: function (e) {
              if (m === 'live' && !Client.KeyStore.get()) {
                e.stopPropagation();
                app.showKeyPopover = true;
                renderWorkbenchHeaderControls();
                if (wbRefs.keyInput) wbRefs.keyInput.focus();
                return;
              }
              app.mode = m;
              app.error = null;
              renderWorkbenchHeaderControls();
              runEvaluation({ resetGhost: true });
            }
          })
        );
      });

      const key = Client.KeyStore.get();
      const storeType = Client.KeyStore.getStorageType();
      const storeSuffix = storeType === 'local' ? ' (saved)' : storeType === 'memory' ? ' (mem)' : ' (tab)';
      wbRefs.keyBtn.textContent = key
        ? 'Key ' + Client.KeyStore.mask(key) + storeSuffix
        : '+ Gemini API Key';
      // The tip explains the storage suffix; it never contains the key or its mask.
      wbRefs.keyBtn.dataset.tip = !key
        ? 'Add your Gemini API key to run live.'
        : storeType === 'local'
          ? 'Key saved in this browser. Click to replace or clear it.'
          : storeType === 'memory'
            ? 'Key kept in page memory until reload. Click to replace or clear it.'
            : 'Key kept for this tab only. Click to replace or clear it.';

      renderKeyPopover();
      updateRunButton();
      restoreWorkbenchFocus(focusSnap);
    }

    // Errors are shown next to the field that causes them: the field gets aria-invalid (red
    // outline) and its question card lists the messages. The box above the cards keeps only
    // errors that belong to no single card (empty input, no active questions, >1,000 questions).
    function fieldKeyForError(err) {
      if (err.field === 'input') return 'input';
      if (!err.questionId) return null;
      const qid = err.questionId;
      if (err.field === 'question.key') return qid + '|key';
      if (err.field === 'question.instructions') return qid + '|instructions';
      if (err.field === 'question.option.key') return qid + '|opt-key|' + err.optionIndex;
      if (err.field === 'question.option.description') return qid + '|opt-desc|' + err.optionIndex;
      if (err.field === 'question.level') return qid + '|level|' + err.levelIndex;
      return null;
    }

    function renderWorkbenchValidation(validationOpt) {
      const box = wbRefs.validationBox;
      if (!box) return;
      const validation = validationOpt || getValidation();
      const fields = wbRefs.fields || Object.create(null);
      Object.keys(fields).forEach(function (k) {
        const node = fields[k];
        if (/\|errors$/.test(k)) {
          clearNode(node);
          node.hidden = true;
        } else if (/\|card$/.test(k)) {
          node.classList.remove('has-error');
        } else if (node && node.removeAttribute) {
          node.removeAttribute('aria-invalid');
        }
      });
      clearNode(box);
      const general = [];
      validation.errors.forEach(function (err) {
        const fk = fieldKeyForError(err);
        if (fk && fields[fk]) fields[fk].setAttribute('aria-invalid', 'true');
        const list = err.questionId ? fields[err.questionId + '|errors'] : null;
        if (list) {
          list.hidden = false;
          list.appendChild(el('div', { textContent: err.message }));
          const card = fields[err.questionId + '|card'];
          if (card) card.classList.add('has-error');
        } else {
          general.push(err.message);
        }
      });
      const inCards = validation.errors.length - general.length;
      if (inCards > 0) {
        general.push(inCards + ' issue' + (inCards === 1 ? '' : 's') + ' in the highlighted question card' + (inCards === 1 ? '' : 's') + ' below.');
      }
      box.hidden = general.length === 0;
      general.forEach(function (msg) {
        box.appendChild(el('div', { textContent: '• ' + msg }));
      });
    }

    function handleImageFile(file) {
      const token = ++app.uploadSeq;
      Presets.processUploadedImage(file)
        .then(function (imgRecord) {
          if (token !== app.uploadSeq) return;
          app.state.image = imgRecord;
          app.uploadNotice = imgRecord.resized
            ? 'Auto-resized to ' + imgRecord.width + '×' + imgRecord.height + ' (' + Schema.formatBytes(imgRecord.bytes) + ')'
            : '';
          renderWorkbenchLeft();
          runEvaluation({ resetGhost: false });
        })
        .catch(function (err) {
          if (token !== app.uploadSeq) return;
          app.uploadNotice = err && err.message ? err.message : 'Could not load image.';
          renderWorkbenchLeft();
        });
    }

    // A Workbench edit the shown result does not reflect yet: refresh the validation + wire preview
    // and mark the tiles stale (they are re-run on close in Demo mode, see finalizeDialogClose).
    function onWorkbenchEdit() {
      app.dirty = true;
      const v = getValidation();
      renderWorkbenchValidation(v);
      updateRunButton(v);
      renderWorkbenchWirePreview();
    }

    // Structural edit (add/remove question, option or level): rebuild the left pane, then as above.
    function onWorkbenchStructureEdit() {
      app.dirty = true;
      renderWorkbenchLeft();
      renderWorkbenchWirePreview();
      updateRunButton();
    }

    function renderWorkbenchLeft() {
      const left = wbRefs.leftPane;
      if (!left) return;
      const focusSnap = captureWorkbenchFocus();
      clearNode(left);
      // Field elements keyed for renderWorkbenchValidation: 'input', '<qid>|card', '<qid>|key',
      // '<qid>|instructions', '<qid>|opt-key|<i>', '<qid>|opt-desc|<i>', '<qid>|level|<i>', and
      // '<qid>|errors' (the per-card message list).
      const fields = Object.create(null);
      wbRefs.fields = fields;

      const fileInput = el('input', {
        type: 'file',
        accept: 'image/png,image/jpeg,image/webp,image/gif',
        hidden: true,
        onChange: function (e) {
          if (e.target.files && e.target.files[0]) {
            handleImageFile(e.target.files[0]);
            e.target.value = '';
          }
        }
      });

      const sampleSelect = el('select', {
        className: 'dc-select',
        dataset: { fk: 'sample', tip: 'Swap in one of the built-in receipt or checkout images.' },
        'aria-label': 'Load built-in sample image',
        onChange: function (e) {
          const val = e.target.value;
          if (!val) return;
          app.uploadSeq++;
          app.state.image = Presets.generateSampleImage(val);
          app.uploadNotice = '';
          e.target.value = '';
          renderWorkbenchLeft();
          runEvaluation({ resetGhost: false });
        }
      });
      sampleSelect.appendChild(el('option', { value: '', textContent: 'Sample image…' }));
      Presets.SAMPLE_IMAGES.forEach(function (s) {
        sampleSelect.appendChild(el('option', { value: s.kind, textContent: s.label }));
      });

      const mediaBox = el('div', {
        className: 'dc-media-box',
        onDragover: function (e) {
          e.preventDefault();
          mediaBox.classList.add('is-dragover');
        },
        onDragleave: function () {
          mediaBox.classList.remove('is-dragover');
        },
        onDrop: function (e) {
          e.preventDefault();
          mediaBox.classList.remove('is-dragover');
          const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
          if (file) handleImageFile(file);
        }
      });

      if (app.state.image && app.state.image.dataUrl) {
        mediaBox.appendChild(
          el('div', { className: 'dc-media-preview' + (app.mediaExpanded ? ' is-expanded' : '') }, [
            el(
              'button',
              {
                type: 'button',
                className: 'dc-media-thumb-btn',
                dataset: { fk: 'thumb', tip: app.mediaExpanded ? 'Shrink the preview.' : 'Enlarge the preview.' },
                'aria-label': app.mediaExpanded ? 'Shrink specimen preview' : 'Expand specimen preview',
                onClick: function () {
                  app.mediaExpanded = !app.mediaExpanded;
                  renderWorkbenchLeft();
                }
              },
              [
                el('img', {
                  className: 'dc-media-thumb',
                  src: app.state.image.dataUrl,
                  alt: app.state.image.name
                }),
                el('span', { className: 'dc-media-zoom-hint', 'aria-hidden': 'true', textContent: app.mediaExpanded ? '−' : '⤢' })
              ]
            ),
            el('div', { className: 'dc-media-meta' }, [
              el('div', { className: 'dc-media-name', textContent: app.state.image.name }),
              el('div', {
                className: 'dc-media-dims',
                textContent:
                  app.state.image.width +
                  '×' +
                  app.state.image.height +
                  ' · ' +
                  app.state.image.mimeType +
                  ' · ' +
                  Schema.formatBytes(app.state.image.bytes)
              }),
              app.uploadNotice
                ? el('div', { className: 'dc-media-notice', textContent: app.uploadNotice })
                : null
            ])
          ])
        );
      } else {
        mediaBox.appendChild(
          el('div', {
            className: 'dc-key-note' + (app.uploadNotice ? ' dc-media-notice' : ''),
            textContent: app.uploadNotice || 'Drop or paste (⌘V) an image for multimodal evaluation, or choose a built-in canvas sample.'
          })
        );
      }

      const resSeg = el('div', { className: 'ui-seg ui-seg--mono dc-seg', role: 'group', 'aria-label': 'Image resolution' });
      Schema.RESOLUTIONS.forEach(function (res) {
        resSeg.appendChild(
          el('button', {
            type: 'button',
            dataset: {
              fk: 'res-' + res,
              tip: app.state.image
                ? 'How finely Gemini reads the image: ' + res + ' (higher costs more input tokens).'
                : 'Add an image first; detail only applies to images.'
            },
            disabled: !app.state.image,
            'aria-pressed': String(app.state.resolution === res),
            textContent: res,
            onClick: function () {
              app.state.resolution = res;
              renderWorkbenchLeft();
              runEvaluation({ resetGhost: false });
            }
          })
        );
      });

      mediaBox.appendChild(
        el('div', { className: 'dc-media-controls' }, [
          el('div', { className: 'dc-row' }, [
            fileInput,
            el('button', {
              type: 'button',
              className: 'ui-btn ui-btn--sm',
              dataset: { fk: 'upload', tip: 'Choose a PNG, JPEG, WebP or GIF; large images are downscaled.' },
              textContent: app.state.image ? 'Replace Image' : 'Upload Image',
              onClick: function () {
                fileInput.click();
              }
            }),
            sampleSelect,
            app.state.image
              ? el('button', {
                  type: 'button',
                  className: 'ui-btn ui-btn--sm ui-btn--quiet',
                  dataset: { fk: 'rm-image', fkFallback: 'upload', tip: 'Drop the image and send text only.' },
                  textContent: 'Remove',
                  onClick: function () {
                    app.uploadSeq++;
                    app.state.image = null;
                    app.mediaExpanded = false;
                    app.uploadNotice = '';
                    renderWorkbenchLeft();
                    runEvaluation({ resetGhost: false });
                  }
                })
              : null
          ]),
          el('div', { className: 'dc-row' }, [
            el('span', { className: 'ui-label', textContent: 'Detail' }),
            resSeg
          ])
        ])
      );

      const inputArea = el('textarea', {
        className: 'dc-textarea',
        rows: '3',
        id: 'dc-wb-input-text',
        dataset: { fk: 'input-text' },
        'aria-label': 'Shared input text',
        placeholder: 'Shared text context evaluated against all active questions in one forward pass…',
        onInput: function (e) {
          app.state.inputText = e.target.value;
          app.customTextEdited = true;
          onWorkbenchEdit();
        }
      });
      inputArea.value = app.state.inputText;
      fields.input = inputArea;

      const inputSection = el('section', { className: 'dc-section' }, [
        el('div', { className: 'dc-section-head' }, [
          el('label', { className: 'dc-section-label', for: 'dc-wb-input-text', textContent: 'Shared input' }),
          el('span', {
            className: 'ui-label dc-quiet-meta',
            textContent: app.state.image ? 'image + text' : 'text only',
            dataset: { tip: 'What every question sees: the text below plus the image, if any.' }
          })
        ]),
        inputArea,
        mediaBox
      ]);

      const validationBox = el('div', { className: 'dc-validation-box', role: 'alert', hidden: true });
      wbRefs.validationBox = validationBox;

      const qList = el('div', { className: 'dc-q-list' });
      app.state.questions.forEach(function (q, qIdx) {
        // Focus/validation key: the question id (generated, never user text), else its index.
        const qid = typeof q.id === 'string' && q.id ? q.id : 'idx-' + qIdx;
        const card = el('div', { className: 'dc-q-card' + (q.enabled === false ? ' is-disabled' : '') });
        fields[qid + '|card'] = card;

        const enabledCheck = el('input', {
          type: 'checkbox',
          checked: q.enabled !== false,
          dataset: { fk: 'q-' + qid + '-enabled', tip: 'Include this question in the next run.' },
          'aria-label': 'Enable question ' + q.key,
          onChange: function (e) {
            q.enabled = e.target.checked;
            card.classList.toggle('is-disabled', !q.enabled);
            updateActiveQuestionsCountLabel();
            onWorkbenchEdit();
          }
        });

        const keyInput = el('input', {
          type: 'text',
          className: 'dc-input dc-input--mono dc-q-key-input',
          value: q.key,
          dataset: { fk: 'q-' + qid + '-key' },
          'aria-label': 'Question key',
          placeholder: 'question_key',
          onInput: function (e) {
            q.key = e.target.value;
            onWorkbenchEdit();
          }
        });
        fields[qid + '|key'] = keyInput;

        const removeQBtn = el('button', {
          type: 'button',
          className: 'ui-btn ui-btn--sm ui-btn--quiet ui-btn--icon',
          dataset: { fk: 'q-' + qid + '-rm', fkFallback: 'add-noul', tip: 'Remove this question.' },
          'aria-label': 'Remove question ' + q.key,
          textContent: '×',
          onClick: function () {
            app.state.questions.splice(qIdx, 1);
            onWorkbenchStructureEdit();
          }
        });

        card.appendChild(
          el('div', { className: 'dc-q-head' }, [
            enabledCheck,
            el('span', { className: 'dc-type-tag', textContent: q.type, dataset: { tip: TYPE_TIPS[q.type] || null } }),
            el('label', { className: 'dc-q-key' }, [el('span', { className: 'ui-label', textContent: 'Key' }), keyInput]),
            removeQBtn
          ])
        );

        const instInput = el('input', {
          type: 'text',
          className: 'dc-input',
          value: q.instructions || '',
          dataset: { fk: 'q-' + qid + '-inst' },
          placeholder: 'Question instructions',
          'aria-label': 'Instructions for ' + q.key,
          onInput: function (e) {
            q.instructions = e.target.value;
            q.cardQuestion = e.target.value;
            onWorkbenchEdit();
          }
        });
        fields[qid + '|instructions'] = instInput;
        card.appendChild(el('label', { className: 'dc-field' }, [el('span', { className: 'ui-label', textContent: 'Question' }), instInput]));

        if (q.type === 'noul') {
          const tdInput = el('input', {
            type: 'text',
            className: 'dc-input',
            value: q.trueDescription || '',
            dataset: { fk: 'q-' + qid + '-td' },
            'aria-label': 'When to answer Yes for ' + q.key,
            placeholder: 'Optional: when to answer Yes',
            onInput: function (e) {
              q.trueDescription = e.target.value;
              onWorkbenchEdit();
            }
          });
          const fdInput = el('input', {
            type: 'text',
            className: 'dc-input',
            value: q.falseDescription || '',
            dataset: { fk: 'q-' + qid + '-fd' },
            'aria-label': 'When to answer No for ' + q.key,
            placeholder: 'Optional: when to answer No',
            onInput: function (e) {
              q.falseDescription = e.target.value;
              onWorkbenchEdit();
            }
          });
          card.appendChild(
            el('div', { className: 'dc-q-subgrid' }, [
              el('label', { className: 'dc-field' }, [el('span', { className: 'ui-label', textContent: 'When yes', dataset: { tip: 'Sent as criteria.true_description.' } }), tdInput]),
              el('label', { className: 'dc-field' }, [el('span', { className: 'ui-label', textContent: 'When no', dataset: { tip: 'Sent as criteria.false_description.' } }), fdInput])
            ])
          );
        } else if (q.type === 'choice') {
          const optWrap = el('div', { className: 'dc-stack' }, [el('span', { className: 'ui-label', textContent: 'Options: key, when to pick it' })]);
          if (!Array.isArray(q.options)) q.options = [];
          q.options.forEach(function (opt, oIdx) {
            if (!opt || typeof opt !== 'object') return;
            const optKeyInput = el('input', {
              type: 'text',
              className: 'dc-input dc-input--mono',
              value: opt.key,
              dataset: { fk: 'q-' + qid + '-opt-' + oIdx + '-key' },
              'aria-label': 'Option ' + (oIdx + 1) + ' key',
              placeholder: 'option_key',
              onInput: function (e) {
                opt.key = e.target.value;
                opt.label = humanizeKey(e.target.value);
                onWorkbenchEdit();
              }
            });
            const optDescInput = el('input', {
              type: 'text',
              className: 'dc-input',
              value: opt.description,
              dataset: { fk: 'q-' + qid + '-opt-' + oIdx + '-desc' },
              'aria-label': 'Option ' + (oIdx + 1) + ' description',
              placeholder: 'Option criteria description',
              onInput: function (e) {
                opt.description = e.target.value;
                onWorkbenchEdit();
              }
            });
            fields[qid + '|opt-key|' + oIdx] = optKeyInput;
            fields[qid + '|opt-desc|' + oIdx] = optDescInput;
            optWrap.appendChild(
              el('div', { className: 'dc-opt-row' }, [
                optKeyInput,
                optDescInput,
                el('button', {
                  type: 'button',
                  className: 'ui-btn ui-btn--sm ui-btn--quiet ui-btn--icon',
                  dataset: {
                    fk: 'q-' + qid + '-opt-' + oIdx + '-rm',
                    fkFallback: 'q-' + qid + '-add-opt',
                    tip: q.options.length <= 2 ? 'A category question needs at least two options.' : 'Remove this option.'
                  },
                  textContent: '×',
                  disabled: q.options.length <= 2,
                  'aria-label': 'Remove option ' + (oIdx + 1),
                  onClick: function () {
                    q.options.splice(oIdx, 1);
                    onWorkbenchStructureEdit();
                  }
                })
              ])
            );
          });
          optWrap.appendChild(
            el('div', null, [
              el('button', {
                type: 'button',
                className: 'ui-btn ui-btn--sm',
                dataset: { fk: 'q-' + qid + '-add-opt' },
                textContent: '+ Add Option',
                onClick: function () {
                  let nextOptNum = (Array.isArray(q.options) ? q.options.length : 0) + 1;
                  const usedKeys = Object.create(null);
                  (q.options || []).forEach(function (existingOpt) {
                    const ek = existingOpt && typeof existingOpt.key === 'string' ? existingOpt.key.trim() : '';
                    if (ek) {
                      usedKeys[ek] = true;
                      const m = /^option_(\d+)$/.exec(ek);
                      if (m) {
                        const parsed = parseInt(m[1], 10);
                        if (parsed >= nextOptNum) nextOptNum = parsed + 1;
                      }
                    }
                  });
                  while (usedKeys['option_' + nextOptNum]) {
                    nextOptNum += 1;
                  }
                  q.options.push({
                    key: 'option_' + nextOptNum,
                    label: 'Option ' + nextOptNum,
                    description: 'Describe when to choose this option.'
                  });
                  onWorkbenchStructureEdit();
                }
              })
            ])
          );
          card.appendChild(optWrap);
        } else if (q.type === 'score') {
          const lvlWrap = el('div', { className: 'dc-stack' }, [el('span', { className: 'ui-label', textContent: 'Rubric levels, lowest first' })]);
          if (!Array.isArray(q.levels)) q.levels = [];
          q.levels.forEach(function (lvl, lIdx) {
            const lvlInput = el('input', {
              type: 'text',
              className: 'dc-input',
              value: lvl,
              dataset: { fk: 'q-' + qid + '-lvl-' + lIdx },
              'aria-label': 'Rubric level ' + lIdx,
              placeholder: 'Level ' + lIdx + ' rubric criterion',
              onInput: function (e) {
                q.levels[lIdx] = e.target.value;
                if (Array.isArray(q.levelLabels)) q.levelLabels[lIdx] = '';
                onWorkbenchEdit();
              }
            });
            fields[qid + '|level|' + lIdx] = lvlInput;
            lvlWrap.appendChild(
              el('div', { className: 'dc-level-row' }, [
                el('span', { className: 'dc-level-idx', textContent: String(lIdx) }),
                lvlInput,
                el('button', {
                  type: 'button',
                  className: 'ui-btn ui-btn--sm ui-btn--quiet ui-btn--icon',
                  dataset: {
                    fk: 'q-' + qid + '-lvl-' + lIdx + '-rm',
                    fkFallback: 'q-' + qid + '-add-lvl',
                    tip: q.levels.length <= 2 ? 'A rubric needs at least two levels.' : 'Remove this level.'
                  },
                  textContent: '×',
                  disabled: q.levels.length <= 2,
                  'aria-label': 'Remove level ' + lIdx,
                  onClick: function () {
                    q.levels.splice(lIdx, 1);
                    if (Array.isArray(q.levelLabels)) q.levelLabels.splice(lIdx, 1);
                    onWorkbenchStructureEdit();
                  }
                })
              ])
            );
          });
          lvlWrap.appendChild(
            el('div', null, [
              el('button', {
                type: 'button',
                className: 'ui-btn ui-btn--sm',
                dataset: { fk: 'q-' + qid + '-add-lvl' },
                textContent: '+ Add Rubric Level',
                onClick: function () {
                  q.levels.push('Level ' + q.levels.length + ': higher quality criteria.');
                  if (Array.isArray(q.levelLabels)) q.levelLabels.push('Level ' + (q.levels.length - 1));
                  onWorkbenchStructureEdit();
                }
              })
            ])
          );
          card.appendChild(lvlWrap);
        }

        // Per-card list of validation messages, filled by renderWorkbenchValidation.
        const cardErrors = el('div', { className: 'dc-q-errors', hidden: true });
        fields[qid + '|errors'] = cardErrors;
        card.appendChild(cardErrors);

        qList.appendChild(card);
      });

      function addQuestion(type) {
        const suffix = nextCustomId++;
        if (type === 'noul') {
          app.state.questions.push({
            id: 'q-custom-' + suffix,
            enabled: true,
            key: 'check_' + suffix,
            cardQuestion: 'Satisfies custom condition?',
            type: 'noul',
            instructions: 'Does the input satisfy this custom condition?',
            trueDescription: '',
            falseDescription: '',
            threshold: 0.5
          });
        } else if (type === 'choice') {
          app.state.questions.push({
            id: 'q-custom-' + suffix,
            enabled: true,
            key: 'route_' + suffix,
            cardQuestion: 'Best matching category?',
            type: 'choice',
            instructions: 'Which category best matches this input?',
            options: [
              { key: 'category_a', label: 'Category A', description: 'Primary category A.' },
              { key: 'category_b', label: 'Category B', description: 'Alternative category B.' }
            ]
          });
        } else {
          app.state.questions.push({
            id: 'q-custom-' + suffix,
            enabled: true,
            key: 'rubric_' + suffix,
            cardQuestion: 'Custom rubric rating?',
            type: 'score',
            instructions: 'Rate this input on an ordered rubric.',
            levelLabels: ['Low', 'Medium', 'High'],
            levels: [
              'Low: does not meet expectations.',
              'Medium: partially meets expectations.',
              'High: fully meets expectations.'
            ]
          });
        }
        onWorkbenchStructureEdit();
      }

      const activeCount = app.state.questions.filter(function (q) {
        return q.enabled !== false;
      }).length;
      const questionsCountLabel = el('span', {
        className: 'dc-section-label',
        textContent: 'Batched Questions (' + activeCount + ' active)'
      });
      wbRefs.questionsCountLabel = questionsCountLabel;

      const questionsSection = el('section', { className: 'dc-section' }, [
        el('div', { className: 'dc-section-head' }, [
          questionsCountLabel,
          el('div', { className: 'dc-row' }, [
            el('button', { type: 'button', className: 'ui-btn ui-btn--sm', dataset: { fk: 'add-noul', tip: 'Add a ' + TYPE_TIPS.noul.charAt(0).toLowerCase() + TYPE_TIPS.noul.slice(1) }, textContent: '+ Yes/No (noul)', onClick: function () { addQuestion('noul'); } }),
            el('button', { type: 'button', className: 'ui-btn ui-btn--sm', dataset: { fk: 'add-choice', tip: 'Add a ' + TYPE_TIPS.choice.charAt(0).toLowerCase() + TYPE_TIPS.choice.slice(1) }, textContent: '+ Category (choice)', onClick: function () { addQuestion('choice'); } }),
            el('button', { type: 'button', className: 'ui-btn ui-btn--sm', dataset: { fk: 'add-score', tip: 'Add a ' + TYPE_TIPS.score.charAt(0).toLowerCase() + TYPE_TIPS.score.slice(1) }, textContent: '+ Rubric (score)', onClick: function () { addQuestion('score'); } })
          ])
        ]),
        validationBox,
        qList
      ]);

      left.appendChild(inputSection);
      left.appendChild(questionsSection);
      renderWorkbenchValidation();
      restoreWorkbenchFocus(focusSnap);
    }

    function buildResultsStack() {
      const stack = el('div', { className: 'dc-results-stack' });

      if (app.error) {
        stack.appendChild(
          el('div', { className: 'dc-error-panel', role: 'alert' }, [
            el('h4', { textContent: app.error.headline }),
            el('p', { textContent: app.error.detail }),
            el('p', { className: 'dc-error-fix', textContent: app.error.remediation }),
            el('div', { className: 'dc-row' }, [
              app.error.code !== 'MISSING_KEY'
                ? el('button', {
                    type: 'button',
                    className: 'ui-btn ui-btn--sm',
                    dataset: { fk: 'err-retry', tip: 'Send the same request to Gemini again.' },
                    textContent: 'Retry Live',
                    onClick: function () {
                      runEvaluation({ resetGhost: false });
                    }
                  })
                : null,
              isKeyError(app.error)
                ? el('button', {
                    type: 'button',
                    className: 'ui-btn ui-btn--sm',
                    dataset: { fk: 'err-key', tip: 'Open the key form to paste a working key.' },
                    textContent: 'Update API Key',
                    onClick: function (e) {
                      e.stopPropagation();
                      app.showKeyPopover = true;
                      renderKeyPopover();
                      if (wbRefs.keyInput) wbRefs.keyInput.focus();
                    }
                  })
                : null,
              el('button', {
                type: 'button',
                className: 'ui-btn ui-btn--sm',
                dataset: {
                  fk: 'err-demo',
                  fkFallback: 'tab-results',
                  tip: app.error.code === 'MISSING_KEY'
                    ? 'Show simulated answers instead; no key needed.'
                    : 'Show simulated answers instead; your key stays saved.'
                },
                textContent: 'Switch to Demo Data',
                onClick: function () {
                  app.mode = 'simulated';
                  app.error = null;
                  renderWorkbenchHeaderControls();
                  runEvaluation({ resetGhost: true });
                }
              })
            ])
          ])
        );
        return stack;
      }

      if (!app.result || !app.result.normalized) {
        stack.appendChild(el('div', { className: 'dc-key-note', textContent: 'Run an evaluation to see calibrated probabilities.' }));
        return stack;
      }

      const answers = app.result.normalized.answers;
      const prevAnswers = app.prevResult && app.prevResult.normalized ? app.prevResult.normalized.answers : {};
      const activeQuestions = (Array.isArray(app.result.evaluatedQuestions) ? app.result.evaluatedQuestions : app.state.questions).filter(function (q) {
        return q && q.enabled !== false;
      });

      const invalidKeys = Object.create(null);
      (Array.isArray(app.result.normalized.invalid) ? app.result.normalized.invalid : []).forEach(function (item) {
        invalidKeys[item.key] = item.reason;
      });

      activeQuestions.forEach(function (q) {
        const qk = trimKey(q.key);
        const ans = answers[qk];
        const prev = prevAnswers[qk];
        if (!ans) {
          if (invalidKeys[qk]) {
            stack.appendChild(
              el('article', { className: 'dc-res-card' }, [
                el('div', { className: 'dc-res-key-row' }, [
                  el('span', { className: 'dc-type-tag', textContent: String(q.type) }),
                  el('span', { className: 'dc-res-key', textContent: qk })
                ]),
                el('div', { className: 'dc-key-note dc-invalid-note', textContent: 'No valid answer in the response (' + invalidKeys[qk] + '). See Raw Response.' })
              ])
            );
          }
          return;
        }

        if (ans.type === 'noul') {
          const thresh = Number.isFinite(q.threshold) ? q.threshold : 0.5;
          const isYes = ans.noul >= thresh;
          const deltaStr = prev && prev.type === 'noul' ? fmtSignedPts(ans.noul - prev.noul) : null;

          const fillEl = el('div', {
            className: 'dc-noul-fill' + (isYes ? '' : ' is-below'),
            style: { width: Math.round(ans.noul * 100) + '%' }
          });
          const track = el('div', {
            className: 'dc-noul-track dc-noul-wb-track',
            dataset: { tip: 'Drag the marker to move the cutoff between NO and YES.' }
          });
          track.appendChild(fillEl);
          if (prev && prev.type === 'noul') {
            track.appendChild(
              el('div', {
                className: 'dc-noul-ghost',
                dataset: { tip: "Previous run's probability of yes: " + fmtPct(prev.noul) + '.' },
                style: { left: Math.round(prev.noul * 100) + '%' }
              })
            );
          }
          const pin = el('button', {
            type: 'button',
            className: 'dc-noul-pin',
            role: 'slider',
            dataset: { fk: 'wb-pin-' + qk, tip: 'Cutoff between NO and YES. Drag it or use the arrow keys.' },
            'aria-label': 'Decision cutoff for ' + qk,
            'aria-valuemin': '0.05',
            'aria-valuemax': '0.95',
            'aria-valuenow': fmtProb(thresh),
            'aria-valuetext': fmtPct(thresh) + ' cutoff (' + (isYes ? 'YES' : 'NO') + ')',
            style: { left: Math.round(thresh * 100) + '%' }
          });
          track.appendChild(pin);
          track.appendChild(
            el('div', {
              className: 'dc-noul-needle',
              style: { left: Math.round(ans.noul * 100) + '%' }
            })
          );
          const tickEl = el('span', { textContent: 'Cutoff ' + fmtPct(thresh) });
          const verdictEl = el('span', {
            className: 'dc-verdict-badge' + (isYes ? '' : ' is-no'),
            dataset: { tip: 'Distance from the cutoff: MARGINAL within 12 points; HIGH past 78% or under 22%.' },
            textContent: noulBand(ans.noul, thresh)
          });

          bindThresholdDrag('workbench', {
            trackEl: track,
            pinEl: pin,
            fillEl: fillEl,
            tickEl: tickEl,
            verdictEl: verdictEl,
            questionObj: q,
            prob: ans.noul
          });

          stack.appendChild(
            el('article', { className: 'dc-res-card' }, [
              el('div', { className: 'dc-res-head' }, [
                el('div', { className: 'dc-res-title-group' }, [
                  el('div', { className: 'dc-res-key-row' }, [
                    el('span', { className: 'dc-type-tag', textContent: 'noul · Yes/No' }),
                    el('span', { className: 'dc-res-key', textContent: qk }),
                    deltaStr
                      ? el('span', {
                          className: 'dc-delta-chip',
                          dataset: { tip: 'Change since the previous run, in percentage points.' },
                          textContent: deltaStr
                        })
                      : null
                  ]),
                  el('div', { className: 'dc-res-inst', textContent: q.instructions })
                ]),
                el('div', { className: 'dc-res-hero' }, [
                  el('span', { className: 'dc-hero-num', textContent: fmtPct(ans.noul) }),
                  el('span', { className: 'dc-hero-sub', textContent: fmtPct(1 - ans.noul) + ' No' })
                ])
              ]),
              track,
              el('div', { className: 'dc-axis-ticks' }, [
                el('span', { textContent: '1% No' }),
                tickEl,
                el('span', { textContent: '99% Yes' })
              ]),
              el('div', { className: 'dc-verdict-row' }, [
                verdictEl,
                el('span', {
                  className: 'dc-mono',
                  dataset: { tip: "The API's own confidence field for this answer." },
                  textContent: 'confidence ' + fmtPct(ans.confidence)
                })
              ])
            ])
          );
        } else if (ans.type === 'choice') {
          const top = ans.ranked[0] || { key: ans.choice || '—', prob: 0 };
          const winnerKey = ans.choice || top.key;
          const ribbon = el('div', { className: 'dc-choice-ribbon' });
          ans.ranked.forEach(function (r, idx) {
            ribbon.appendChild(
              el('div', {
                className: 'dc-choice-seg',
                dataset: { tip: optionHumanLabel(q, r.key) + ': ' + fmtPct(r.prob) + '.' },
                style: {
                  width: Math.max(2, r.prob * 100) + '%',
                  background: CHOICE_SWATCHES[idx % CHOICE_SWATCHES.length]
                }
              })
            );
          });

          const rows = el('div', { className: 'dc-choice-rows' });
          ans.ranked.forEach(function (r, idx) {
            const prevP = prev && prev.type === 'choice' && prev.probabilities ? Number(prev.probabilities[r.key]) : NaN;
            const barTrack = el('div', { className: 'dc-bar-track' }, [
              el('div', {
                className: 'dc-bar-fill' + (r.key === winnerKey || (idx === 0 && !ans.choice) ? ' is-winner' : ''),
                style: { width: Math.max(1, r.prob * 100) + '%' }
              }),
              Number.isFinite(prevP)
                ? el('div', {
                    className: 'dc-bar-ghost',
                    dataset: { tip: "Previous run's probability: " + fmtPct(prevP) + '.' },
                    style: { left: Math.round(Schema.clamp(prevP, 0, 1) * 100) + '%' }
                  })
                : null
            ]);

            rows.appendChild(
              el('div', { className: 'dc-choice-item' }, [
                el('div', { className: 'dc-choice-label' }, [
                  el('span', { className: 'dc-choice-opt-key', textContent: optionHumanLabel(q, r.key), dataset: { tip: 'Option key: ' + r.key + '.' } }),
                  r.description ? el('span', { className: 'dc-choice-opt-desc', textContent: r.description, dataset: { tip: r.description } }) : null
                ]),
                barTrack,
                el('span', { className: 'dc-choice-prob', textContent: (r.prob * 100).toFixed(1) + '%' })
              ])
            );
          });

          stack.appendChild(
            el('article', { className: 'dc-res-card' }, [
              el('div', { className: 'dc-res-head' }, [
                el('div', { className: 'dc-res-title-group' }, [
                  el('div', { className: 'dc-res-key-row' }, [
                    el('span', { className: 'dc-type-tag', textContent: 'choice · Category' }),
                    el('span', { className: 'dc-res-key', textContent: qk })
                  ]),
                  el('div', { className: 'dc-res-inst', textContent: q.instructions })
                ]),
                el('div', { className: 'dc-res-hero' }, [
                  el('span', { className: 'dc-hero-num dc-hero-num--word', textContent: optionHumanLabel(q, winnerKey) }),
                  el('span', {
                    className: 'dc-hero-sub',
                    dataset: { tip: 'Σp: the probabilities added up. Lead: winner minus runner-up.' },
                    textContent: 'Σp ' + ans.sum.toFixed(3) + ' · lead +' + Math.round(ans.margin * 100) + ' pts'
                  })
                ])
              ]),
              ribbon,
              rows
            ])
          );
        } else if (ans.type === 'score') {
          const cols = Math.max(2, ans.levels.length);
          const evPct = computeScorePointerPct(ans.score, ans.min, ans.max, cols);
          const deltaStr = prev && prev.type === 'score' ? fmtSignedDelta(ans.score - prev.score) : null;

          const hist = el('div', {
            className: 'dc-hist-wrap',
            style: { gridTemplateColumns: 'repeat(' + cols + ', 1fr)' }
          });
          const levelPcts = Schema.toDisplayPercents(ans.levels.map(function (l) { return l.prob; }));
          ans.levels.forEach(function (lvl, idx) {
            hist.appendChild(
              el('div', { className: 'dc-hist-col', dataset: { tip: 'Level ' + lvl.index + ': ' + levelPcts[idx] + '% probability.' } }, [
                el('span', { className: 'dc-hist-pct', textContent: levelPcts[idx] + '%' }),
                el('div', {
                  className: 'dc-hist-bar' + (lvl.index === ans.peakIndex ? ' is-peak' : ''),
                  style: { height: Math.max(3, Math.round(Math.min(1, lvl.prob) * 72)) + 'px' }
                })
              ])
            );
          });

          const ruler = el('div', {
            className: 'dc-ev-ruler',
            style: { gridTemplateColumns: 'repeat(' + cols + ', 1fr)' }
          });
          ans.levels.forEach(function (lvl, idx) {
            ruler.appendChild(el('span', { className: 'dc-ev-tick', textContent: lvl.index + ' ' + shortLevelLabel(q, lvl, idx) }));
          });
          ruler.appendChild(
            el('div', {
              className: 'dc-ev-pointer',
              dataset: { tip: 'Weighted average score: ' + ans.score.toFixed(2) + ' of ' + ans.max + '.' },
              style: { left: evPct + '%' }
            })
          );

          const rubricTable = el('div', { className: 'dc-rubric-table' });
          ans.levels.forEach(function (lvl, idx) {
            rubricTable.appendChild(
              el('div', { className: 'dc-rubric-row' + (lvl.index === ans.peakIndex ? ' is-peak' : '') }, [
                el('span', { className: 'dc-mono', textContent: String(lvl.index) }),
                el('span', { textContent: lvl.description }),
                el('span', { className: 'dc-mono dc-num-right', textContent: levelPcts[idx] + '%' })
              ])
            );
          });

          stack.appendChild(
            el('article', { className: 'dc-res-card' }, [
              el('div', { className: 'dc-res-head' }, [
                el('div', { className: 'dc-res-title-group' }, [
                  el('div', { className: 'dc-res-key-row' }, [
                    el('span', { className: 'dc-type-tag', textContent: 'score · Rubric' }),
                    el('span', { className: 'dc-res-key', textContent: qk }),
                    deltaStr
                      ? el('span', {
                          className: 'dc-delta-chip',
                          dataset: { tip: 'Change in score since the previous run.' },
                          textContent: 'Δ ' + deltaStr
                        })
                      : null
                  ]),
                  el('div', { className: 'dc-res-inst', textContent: q.instructions })
                ]),
                el('div', { className: 'dc-res-hero' }, [
                  el('span', { className: 'dc-hero-num', textContent: ans.score.toFixed(2) }),
                  el('span', {
                    className: 'dc-hero-sub',
                    dataset: { tip: 'σ: spread of the level probabilities, in levels; lower is surer.' },
                    textContent: '/ ' + ans.max + (certaintyLabel(ans.stdDev, ans.min, ans.max, ans.sum) ? ' · ' + certaintyLabel(ans.stdDev, ans.min, ans.max, ans.sum) : '') + ' (σ ' + ans.stdDev.toFixed(2) + ')'
                  })
                ])
              ]),
              el('div', { className: 'dc-score-stage' }, [hist, ruler, rubricTable])
            ])
          );
        }
      });

      return stack;
    }

    function renderWorkbenchResultsOnly() {
      if (!wbRefs.tabContent) return;
      clearNode(wbRefs.tabContent);
      wbRefs.tabContent.appendChild(buildResultsStack());
    }

    function renderWorkbenchWirePreview() {
      if (!dialog.open || app.activeTab !== 'request' || !wbRefs.requestPre) return;
      const body = Schema.buildRequestBody(app.state);
      wbRefs.requestPre.textContent =
        app.requestFormat === 'curl'
          ? Schema.buildCurl(body, { includeBase64: app.includeBase64 })
          : Schema.formatRequestJson(body, { includeBase64: app.includeBase64 });
    }

    function renderWorkbenchRight() {
      const right = wbRefs.rightPane;
      if (!right) return;
      const focusSnap = captureWorkbenchFocus();
      clearNode(right);

      const provMode = app.error ? 'error' : app.result && app.result.mode === 'live' ? 'live' : 'simulated';
      const usage = !app.error && app.result && app.result.normalized ? app.result.normalized.usage : null;
      const modSummary = usage && usage.input_tokens_by_modality.length
        ? usage.input_tokens_by_modality
            .map(function (m) {
              return m.modality + ': ' + m.tokens;
            })
            .join(' + ')
        : null;

      const provLabel =
        provMode === 'live'
          ? 'LIVE · HTTP ' + app.result.httpStatus + ' · ' + app.result.latencyMs + ' ms'
          : provMode === 'error'
            ? 'LIVE ERROR · ' + (app.error.httpStatus ? 'HTTP ' + app.error.httpStatus : app.error.code)
            : 'DEMO DATA · Add a Gemini API key to call gemini-decision-1 live';

      // Provenance: idle grey for demo, green only for a live call that returned, rust for an error.
      const provBanner = el('div', {
        className: 'dc-provenance',
        dataset: { mode: provMode, tone: provMode === 'live' ? 'ok' : provMode === 'error' ? 'attention' : 'idle' }
      }, [
        el('div', { className: 'dc-provenance-left' }, [
          el('span', { className: 'dc-dot', 'aria-hidden': 'true' }),
          provLabel
        ]),
        usage
          ? el('div', { className: 'dc-telemetry-chips' }, [
              el('span', {
                className: 'dc-chip dc-chip--hero',
                dataset: { tip: 'Words the model generated for this request: none, only probabilities.' },
                textContent: 'output_tokens: ' + usage.total_output_tokens
              }),
              el('span', {
                className: 'dc-chip',
                dataset: {
                  tip: provMode === 'simulated'
                    ? 'Estimated input tokens (~): the demo does not call the API.'
                    : 'Input tokens billed for this request, by modality.'
                },
                textContent: (provMode === 'simulated' ? '~' : '') + 'in: ' + usage.total_input_tokens + (modSummary ? ' (' + modSummary + ')' : '')
              })
            ])
          : null
      ]);

      const tabSpecs = [
        ['results', 'Calibrated Results'],
        ['request', 'Request & cURL'],
        ['response', 'Raw Response']
      ];
      const tabs = el(
        'div',
        { className: 'ui-seg dc-tabs', role: 'tablist', 'aria-label': 'Output inspector' },
        tabSpecs.map(function (entry, idx) {
          const isSelected = app.activeTab === entry[0];
          return el('button', {
            id: 'dc-tab-' + entry[0],
            type: 'button',
            role: 'tab',
            dataset: { fk: 'tab-' + entry[0] },
            tabindex: isSelected ? '0' : '-1',
            'aria-selected': String(isSelected),
            'aria-controls': 'dc-tabpanel',
            textContent: entry[1],
            onClick: function () {
              app.activeTab = entry[0];
              renderWorkbenchRight();
            },
            onKeydown: function (e) {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const nextIdx = (idx + (e.key === 'ArrowRight' ? 1 : tabSpecs.length - 1)) % tabSpecs.length;
              app.activeTab = tabSpecs[nextIdx][0];
              renderWorkbenchRight();
              const nextTab = dialog.querySelector('#dc-tab-' + app.activeTab);
              if (nextTab) nextTab.focus();
            }
          });
        })
      );

      const tabContent = el('div', {
        id: 'dc-tabpanel',
        role: 'tabpanel',
        'aria-labelledby': 'dc-tab-' + app.activeTab,
        className: 'dc-tabpanel'
      });
      wbRefs.tabContent = tabContent;
      wbRefs.requestPre = null;

      if (app.activeTab === 'results') {
        tabContent.appendChild(buildResultsStack());
      } else if (app.activeTab === 'request') {
        const body = Schema.buildRequestBody(app.state);
        const contentStr =
          app.requestFormat === 'curl'
            ? Schema.buildCurl(body, { includeBase64: app.includeBase64 })
            : Schema.formatRequestJson(body, { includeBase64: app.includeBase64 });

        const copyBtn = el('button', {
          type: 'button',
          className: 'ui-btn ui-btn--sm dc-copy-btn',
          dataset: { fk: 'copy-req', tip: 'Copy exactly what is shown below; the key stays redacted.' },
          textContent: app.requestFormat === 'curl' ? 'Copy cURL' : 'Copy JSON',
          onClick: function () {
            const latestBody = Schema.buildRequestBody(app.state);
            const str =
              app.requestFormat === 'curl'
                ? Schema.buildCurl(latestBody, { includeBase64: app.includeBase64 })
                : Schema.formatRequestJson(latestBody, { includeBase64: app.includeBase64 });
            copyToClipboard(str, dialog.open ? dialog : document.body)
              .then(function () {
                if (disposed) return;
                copyBtn.textContent = 'Copied ✓';
                copyTimers.push(
                  setTimeout(function () {
                    if (!disposed) {
                      copyBtn.textContent = app.requestFormat === 'curl' ? 'Copy cURL' : 'Copy JSON';
                    }
                  }, 1500)
                );
              })
              .catch(function () {
                if (disposed) return;
                copyBtn.textContent = 'Copy failed';
                copyTimers.push(
                  setTimeout(function () {
                    if (!disposed) {
                      copyBtn.textContent = app.requestFormat === 'curl' ? 'Copy cURL' : 'Copy JSON';
                    }
                  }, 1500)
                );
              });
          }
        });

        const toolbar = el('div', { className: 'dc-code-toolbar' }, [
          el('div', { className: 'ui-seg dc-seg', role: 'group', 'aria-label': 'Request format' }, [
            el('button', {
              type: 'button',
              dataset: { fk: 'fmt-json', tip: 'The POST body sent to v1beta/decisions.' },
              'aria-pressed': String(app.requestFormat === 'json'),
              textContent: 'JSON Body',
              onClick: function () {
                app.requestFormat = 'json';
                renderWorkbenchRight();
              }
            }),
            el('button', {
              type: 'button',
              dataset: { fk: 'fmt-curl', tip: 'A terminal command; the key reads $GEMINI_API_KEY, never yours.' },
              'aria-pressed': String(app.requestFormat === 'curl'),
              textContent: 'cURL (redacted)',
              onClick: function () {
                app.requestFormat = 'curl';
                renderWorkbenchRight();
              }
            })
          ]),
          el('div', { className: 'dc-row' }, [
            app.state.image
              ? el('label', { className: 'dc-checkbox-row' }, [
                  el('input', {
                    type: 'checkbox',
                    dataset: { fk: 'b64', tip: 'Show the full image data instead of a shortened placeholder.' },
                    checked: app.includeBase64,
                    onChange: function (e) {
                      app.includeBase64 = e.target.checked;
                      renderWorkbenchWirePreview();
                    }
                  }),
                  'Include full base64'
                ])
              : null,
            copyBtn
          ])
        ]);

        const pre = el('pre', { className: 'dc-pre', textContent: contentStr });
        wbRefs.requestPre = pre;
        tabContent.appendChild(toolbar);
        tabContent.appendChild(
          el('div', {
            className: 'dc-key-note',
            textContent: 'POST ' + Schema.ENDPOINT + ' · API key is always redacted as $GEMINI_API_KEY in cURL exports.'
          })
        );
        tabContent.appendChild(pre);
      } else {
        const displayRaw = app.error
          ? { error: app.error }
          : app.result
            ? app.result.mode === 'simulated'
              ? Object.assign({ _simulated: true, _note: 'Local deterministic preview — not a live gemini-decision-1 response.' }, app.result.raw)
              : app.result.raw
            : {};
        const rawStr = JSON.stringify(displayRaw, null, 2);

        const copyRespBtn = el('button', {
          type: 'button',
          className: 'ui-btn ui-btn--sm dc-copy-btn',
          dataset: { fk: 'copy-resp', tip: 'Copy the response JSON shown below.' },
          textContent: 'Copy Response',
          onClick: function () {
            copyToClipboard(rawStr, dialog.open ? dialog : document.body)
              .then(function () {
                if (disposed) return;
                copyRespBtn.textContent = 'Copied ✓';
                copyTimers.push(
                  setTimeout(function () {
                    if (!disposed) copyRespBtn.textContent = 'Copy Response';
                  }, 1500)
                );
              })
              .catch(function () {
                if (disposed) return;
                copyRespBtn.textContent = 'Copy failed';
                copyTimers.push(
                  setTimeout(function () {
                    if (!disposed) copyRespBtn.textContent = 'Copy Response';
                  }, 1500)
                );
              });
          }
        });

        const rawToolbarNote = app.error
          ? 'Structured error details from the failed Live API attempt'
          : app.result && app.result.mode === 'live'
            ? 'Verbatim JSON returned by POST /v1beta/decisions'
            : 'Demo preview payload matching the v1beta/decisions response contract';

        tabContent.appendChild(
          el('div', { className: 'dc-code-toolbar' }, [
            el('span', {
              className: 'dc-key-note',
              textContent: rawToolbarNote
            }),
            copyRespBtn
          ])
        );
        tabContent.appendChild(el('pre', { className: 'dc-pre', textContent: rawStr }));
      }

      right.appendChild(provBanner);
      right.appendChild(tabs);
      right.appendChild(tabContent);
      restoreWorkbenchFocus(focusSnap);
    }

    function restoreCardTriggerFocus() {
      for (let i = 0; i < cells.length; i++) {
        const target = typeof cells[i].querySelector === 'function'
          ? cells[i].querySelector('[data-focus-role="' + app.returnFocusRole + '"]')
          : null;
        if (target && typeof target.focus === 'function') {
          target.focus();
          return;
        }
      }
      for (let j = 0; j < cells.length; j++) {
        const fallback = typeof cells[j].querySelector === 'function'
          ? (cells[j].querySelector('[data-focus-role="expand-btn"]') || cells[j].querySelector('[data-focus-role="mode-pill"]'))
          : null;
        if (fallback && typeof fallback.focus === 'function') {
          fallback.focus();
          return;
        }
      }
    }

    let dialogClosePending = false;

    function finalizeDialogClose() {
      resetKeyPopoverHiddenState();
      if (!dialogClosePending) return;
      dialogClosePending = false;
      // Workbench edits that were never run would leave tile 1 showing the edited input next to
      // tiles 2–3 answering the old one. Demo runs are free and local, so re-run them now; a live
      // call is never sent implicitly (the tiles keep a "Live · edited" tag until Run is pressed).
      if (app.dirty && app.mode === 'simulated' && getValidation().valid) {
        runEvaluation({ resetGhost: false });
      } else {
        renderAllCells();
      }
      restoreCardTriggerFocus();
    }

    function openWorkbench(focusRole, opts) {
      app.returnFocusRole = focusRole || 'expand-btn';
      app.showKeyPopover = Boolean(opts && opts.openKeyPopover);
      app.activeTab = (opts && opts.initialTab) || 'results';

      if (!wbRefs.leftPane) {
        buildWorkbenchShell();
      }
      renderWorkbenchHeaderControls();
      renderWorkbenchLeft();
      renderWorkbenchRight();

      dialogClosePending = true;
      if (!dialog.open) {
        dialog.showModal();
      }
      if (app.showKeyPopover && wbRefs.keyInput) {
        wbRefs.keyInput.focus();
      }
    }

    function closeWorkbench() {
      resetKeyPopoverHiddenState();
      if (dialog.open) dialog.close();
      finalizeDialogClose();
    }

    dialog.addEventListener('close', function () {
      // The close event is queued; if the Workbench was reopened before it fired, it is stale.
      if (disposed || dialog.open) return;
      finalizeDialogClose();
    });

    dialog.addEventListener('cancel', function (e) {
      if (app.showKeyPopover) {
        e.preventDefault();
        closeKeyPopover(true);
      }
    });

    let pointerDownOnBackdrop = false;
    let pointerDownOutsideKey = false;
    dialog.addEventListener('mousedown', function (e) {
      pointerDownOnBackdrop = e.target === dialog;
      pointerDownOutsideKey = Boolean(app.showKeyPopover && wbRefs.keyAnchor && !nodeContains(wbRefs.keyAnchor, e.target));
    });

    dialog.addEventListener('click', function (e) {
      if (e.target === dialog && pointerDownOnBackdrop) {
        closeWorkbench();
        return;
      }
      if (app.showKeyPopover && pointerDownOutsideKey && wbRefs.keyAnchor && !nodeContains(wbRefs.keyAnchor, e.target)) {
        closeKeyPopover(false);
      }
    });

    dialog.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && app.showKeyPopover) {
        e.preventDefault();
        e.stopPropagation();
        closeKeyPopover(true);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        runEvaluation({ resetGhost: false });
      }
    });

    dialog.addEventListener('paste', function (e) {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) {
            e.preventDefault();
            handleImageFile(file);
            break;
          }
        }
      }
    });

    function onExternalKeyChange(e) {
      if (disposed) return;
      if (
        e &&
        e.type === 'storage' &&
        e.key &&
        e.key !== 'dc_gemini_api_key_local' &&
        e.key !== 'dc_gemini_api_key_session'
      ) {
        return;
      }
      const currentKey = Client.KeyStore.get();
      if (currentKey === lastKnownKey) {
        if (dialog.open) renderWorkbenchHeaderControls();
        return;
      }
      lastKnownKey = currentKey;
      if (!currentKey) {
        if (app.mode === 'live' || app.error) {
          app.mode = 'simulated';
          app.error = null;
          if (dialog.open) renderWorkbenchHeaderControls();
          runEvaluation({ resetGhost: true });
          return;
        }
        renderAllCells();
        if (dialog.open) renderWorkbenchHeaderControls();
      } else {
        if (
          app.mode === 'simulated' ||
          (app.error && (app.error.code === 'MISSING_KEY' || app.error.httpStatus === 401))
        ) {
          app.mode = 'live';
          app.error = null;
          if (dialog.open) renderWorkbenchHeaderControls();
          runEvaluation({ resetGhost: true });
          return;
        }
        renderAllCells();
        if (dialog.open) renderWorkbenchHeaderControls();
      }
    }

    if (typeof global.addEventListener === 'function') {
      global.addEventListener('gemini-key-changed', onExternalKeyChange);
      global.addEventListener('storage', onExternalKeyChange);
    }

    function unmount() {
      if (disposed) return;
      disposed = true;
      dialogClosePending = false;
      app.runSeq += 1;
      app.uploadSeq += 1;
      if (app.abortController) {
        try {
          app.abortController.abort();
        } catch (_e) {
          // ignore
        }
        app.abortController = null;
      }
      if (announceTimer) {
        clearTimeout(announceTimer);
        announceTimer = null;
      }
      while (copyTimers.length) {
        clearTimeout(copyTimers.pop());
      }
      while (activeDragCleanups.length) {
        const fn = activeDragCleanups.pop();
        if (typeof fn === 'function') fn();
      }
      if (typeof global.removeEventListener === 'function') {
        global.removeEventListener('gemini-key-changed', onExternalKeyChange);
        global.removeEventListener('storage', onExternalKeyChange);
      }
      resetKeyPopoverHiddenState();
      if (dialog.open && typeof dialog.close === 'function') {
        try {
          dialog.close();
        } catch (_e) {
          // ignore
        }
      }
      if (dialog.parentNode) {
        dialog.parentNode.removeChild(dialog);
      }
      renderedFlipBtns = [];
      renderedPresetBtns = [];
      cells.forEach(function (c) {
        if (!c) return;
        c.classList.remove('is-scanning', 'is-loading', 'is-dimmed', 'is-peer-highlight', 'ui-tile');
        clearNode(c);
        if (c.__dcUnmount === unmount) {
          delete c.__dcUnmount;
        }
      });
    }

    cells.forEach(function (c) {
      if (c) c.__dcUnmount = unmount;
    });

    runEvaluation({ resetGhost: true });
    return unmount;
  }

  function bootstrap() {
    const inputEl = document.getElementById('cell-decisions-input');
    const verdictEl = document.getElementById('cell-decisions-verdict');
    const scoreEl = document.getElementById('cell-decisions-score');
    if (inputEl || verdictEl || scoreEl) {
      mountDecisionsTriptych(inputEl, verdictEl, scoreEl);
      return;
    }
    const legacy = document.getElementById('cell-decisions');
    if (legacy) {
      if (typeof legacy.__dcUnmount === 'function') {
        legacy.__dcUnmount();
      }
      clearNode(legacy);
      const sInput = el('div', { className: 'cell--decisions cell--decisions-input' });
      const sVerdict = el('div', { className: 'cell--decisions cell--decisions-verdict' });
      const sScore = el('div', { className: 'cell--decisions cell--decisions-score' });
      legacy.appendChild(sInput);
      legacy.appendChild(sVerdict);
      legacy.appendChild(sScore);
      const disposeInner = mountDecisionsTriptych(sInput, sVerdict, sScore);
      legacy.__dcUnmount = function unmountLegacy() {
        disposeInner();
        clearNode(legacy);
        delete legacy.__dcUnmount;
      };
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  NS.UI = {
    mount: mountDecisionsTriptych
  };
})(window);
