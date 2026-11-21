(function (global) {
  'use strict';

  const NS = (global.GeminiDecisions = global.GeminiDecisions || {});
  const Schema = NS.Schema;
  const Presets = NS.Presets;
  const Client = NS.Client;

  const CHOICE_SWATCHES = ['#141413', '#5c5c58', '#9e9e99', '#cfcfca', '#e3e3de'];

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
      returnFocusRole: 'expand-btn'
    };

    const liveRegion = el('div', {
      className: 'dc-sr-only',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true'
    });

    const inputWrap = inputEl ? el('div', { className: 'dc-cell-inner' }) : null;
    const verdictWrap = verdictEl ? el('div', { className: 'dc-cell-inner' }) : null;
    const scoreWrap = scoreEl ? el('div', { className: 'dc-cell-inner' }) : null;

    cells.forEach(function (c) {
      clearNode(c);
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
      className: 'dc-dialog',
      'aria-labelledby': 'dc-wb-heading'
    });
    document.body.appendChild(dialog);

    const wbRefs = {};

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
        trackEl.title = 'Drag to move Yes/No cutoff (' + pct + ')';

        if (controls.cutoffEl) {
          controls.cutoffEl.textContent = 'Cutoff: ' + pct + ' (drag)';
        }
        if (controls.pillEl) {
          controls.pillEl.textContent = (isYes ? 'YES' : 'NO') + ' · ' + fmtPct(prob);
          controls.pillEl.classList.toggle('is-no', !isYes);
        }
        if (controls.tickEl) {
          controls.tickEl.textContent = 'Cutoff ' + pct + ' (drag)';
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
      const modeKey = app.error ? 'error' : verifiedLive ? 'live' : 'simulated';
      const modeLabel = app.error
        ? 'API Error'
        : verifiedLive
          ? 'Live API'
          : app.isRunning && app.mode === 'live'
            ? 'Connecting…'
            : 'Demo Data';

      const header = el('header', { className: 'dc-card-header' }, [
        el('div', { className: 'dc-card-brand' }, [
          el('span', { className: 'dc-step-pill dc-step-pill--lead', textContent: '1 · INPUT' }),
          el('span', { className: 'dc-card-title', textContent: 'Gemini Decisions' })
        ]),
        el('div', { className: 'dc-card-actions' }, [
          el(
            'button',
            {
              type: 'button',
              className: 'dc-mode-pill',
              dataset: { mode: modeKey, focusRole: 'mode-pill' },
              title:
                hasSavedKey && app.mode === 'live'
                  ? 'Using your Gemini API key — click to manage'
                  : 'Local preview — click to add your Gemini API key',
              onClick: function () {
                openWorkbench('mode-pill', { openKeyPopover: true, initialTab: 'results' });
              }
            },
            [el('span', { className: 'dc-dot', 'aria-hidden': 'true' }), modeLabel]
          ),
          !scoreEl
            ? el('button', {
                type: 'button',
                className: 'dc-icon-btn',
                dataset: { focusRole: 'expand-btn' },
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

      // Readable Specimen Stage
      const specimenStage = el('div', { className: 'dc-specimen-stage' });
      if (app.state.image && app.state.image.dataUrl) {
        specimenStage.appendChild(
          el(
            'button',
            {
              type: 'button',
              className: 'dc-specimen-img-btn',
              dataset: { focusRole: 'specimen-img' },
              'aria-label': 'Inspect or replace specimen image in Workbench',
              onClick: function () {
                app.mediaExpanded = true;
                openWorkbench('specimen-img', { openKeyPopover: false, initialTab: 'results' });
              }
            },
            [el('img', { src: app.state.image.dataUrl, alt: app.state.image.name })]
          )
        );
        const copyCol = el('div', { className: 'dc-specimen-copy' }, [
          el('div', {
            className: 'dc-specimen-heading',
            textContent: app.customTextEdited ? app.state.image.name : (activeVariant.title || activePreset.title)
          })
        ]);
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
        specimenStage.appendChild(copyCol);
      } else {
        specimenStage.appendChild(
          el('div', { className: 'dc-specimen-copy' }, [
            el('div', {
              className: 'dc-specimen-heading',
              textContent: app.customTextEdited ? 'Custom Text Input' : (activeVariant.title || activePreset.title)
            }),
            el('div', {
              className: 'dc-specimen-quote',
              textContent: app.state.inputText,
              title: app.state.inputText
            })
          ])
        );
      }

      // Giant A/B Flip Switch
      const nextFlipBtns = activePreset.variants.map(function (v, idx) {
        return el('button', {
          type: 'button',
          className: 'dc-flip-btn',
          'aria-pressed': String(idx === app.state.variantIndex),
          textContent: v.buttonLabel || v.label,
          title: 'Test: ' + v.summary,
          onClick: function () {
            switchVariant(idx);
          }
        });
      });
      const flipRow = el(
        'div',
        {
          className: 'dc-flip-row',
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

      const body = el('div', { className: 'dc-cell-body dc-input-body' }, [
        el('div', {
          className: 'dc-explainer',
          textContent: 'Pick an input below — Gemini answers all 3 rules in 1 call.'
        }),
        specimenStage,
        flipRow
      ]);

      const nextPresetBtns = Presets.LIST.map(function (p) {
        return el('button', {
          type: 'button',
          className: 'dc-preset-btn',
          'aria-pressed': String(p.id === app.state.presetId),
          textContent: p.shortLabel,
          onClick: function () {
            switchPreset(p.id, 0);
          }
        });
      });

      const footer = el('footer', { className: 'dc-card-footer' }, [
        el(
          'div',
          { className: 'dc-preset-tabs', role: 'group', 'aria-label': 'Example scenarios' },
          nextPresetBtns
        ),
        verdictEl || scoreEl
          ? el('span', { className: 'dc-step-arrow', 'aria-hidden': 'true', textContent: 'Outputs →' })
          : null
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

    // =========================================================================
    // CELL 2 (01B) — YES/NO CHECK (noul) + PICK A CATEGORY (choice)
    // =========================================================================
    function renderVerdictCell() {
      if (!verdictEl || !verdictWrap) return;
      const header = el('header', { className: 'dc-card-header' }, [
        el('div', { className: 'dc-card-brand' }, [
          el('span', { className: 'dc-step-pill', textContent: '2 · CHECK & ROUTE' }),
          el('span', { className: 'dc-step-arrow', 'aria-hidden': 'true', textContent: '→' })
        ]),
        el('div', { className: 'dc-card-actions' }, [
          el('span', { className: 'dc-api-whisper', textContent: 'noul · choice', title: 'Gemini Decisions API primitives: noul (Yes/No) and choice (Category)' })
        ])
      ]);

      const body = el('div', { className: 'dc-cell-body dc-verdict-body' });

      if (app.error) {
        body.appendChild(
          el('div', { className: 'dc-card-error', role: 'alert' }, [
            el('div', { className: 'dc-card-error-title', textContent: app.error.headline }),
            el('div', { textContent: app.error.remediation }),
            el('div', { className: 'dc-card-error-actions' }, [
              el('button', {
                type: 'button',
                className: 'dc-btn dc-btn--sm',
                textContent: 'Retry Live',
                onClick: function () {
                  runEvaluation({ resetGhost: false });
                }
              }),
              app.error.httpStatus === 401 || app.error.code === 'MISSING_KEY'
                ? el('button', {
                    type: 'button',
                    className: 'dc-btn dc-btn--sm',
                    textContent: 'Update API Key',
                    onClick: function () {
                      openWorkbench('mode-pill', { openKeyPopover: true, initialTab: 'results' });
                    }
                  })
                : null,
              el('button', {
                type: 'button',
                className: 'dc-btn dc-btn--sm',
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
            title: 'Drag to move Yes/No cutoff (' + fmtPct(thresh) + ')'
          });
          track.appendChild(fillEl);
          if (prev && prev.type === 'noul') {
            track.appendChild(
              el('div', {
                className: 'dc-noul-ghost',
                title: 'Previous: ' + fmtPct(prev.noul),
                style: { left: Math.round(prev.noul * 100) + '%' }
              })
            );
          }
          const pin = el('button', {
            type: 'button',
            className: 'dc-noul-pin',
            role: 'slider',
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
            textContent: (isYes ? 'YES' : 'NO') + ' · ' + fmtPct(ans.noul)
          });
          const cutoffEl = el('span', { textContent: 'Cutoff: ' + fmtPct(thresh) + ' (drag)' });

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
            el('div', { className: 'dc-half' }, [
              el('div', { className: 'dc-eyebrow-row' }, [
                el('span', { className: 'dc-eyebrow', textContent: 'Yes / No Check' }),
                deltaPts ? el('span', { className: 'dc-delta-chip', textContent: deltaPts }) : null
              ]),
              el('div', { className: 'dc-q-headline' }, [
                el('span', {
                  className: 'dc-plain-q',
                  textContent: noulQ.cardQuestion || noulQ.instructions || qk,
                  title: noulQ.instructions
                }),
                pillEl
              ]),
              track,
              el('div', { className: 'dc-verdict-subrow' }, [
                cutoffEl,
                el('span', { className: 'dc-mono', textContent: '1%–99% calibrated' })
              ])
            ])
          );
        } else {
          body.appendChild(
            el('div', { className: 'dc-half' }, [
              el('div', {
                className: 'dc-empty-state',
                textContent: hasPendingNoul
                  ? 'Yes/No question edited — click Run in Customize ↗'
                  : 'No Yes/No question active — enable in Customize ↗'
              })
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

          const bars = el('div', { className: 'dc-cat-bars' });
          ans.ranked.slice(0, 3).forEach(function (r) {
            const isWin = r.key === winnerKey;
            bars.appendChild(
              el('div', { className: 'dc-cat-row' + (isWin ? ' is-winner' : ''), title: r.description || r.key }, [
                el('span', { className: 'dc-cat-name', textContent: optionHumanLabel(choiceQ, r.key) }),
                el('div', { className: 'dc-cat-track' }, [
                  el('div', {
                    className: 'dc-cat-fill',
                    style: { width: Math.max(2, Math.round(r.prob * 100)) + '%' }
                  })
                ]),
                el('span', { className: 'dc-cat-pct', textContent: fmtPct(r.prob) })
              ])
            );
          });

          body.appendChild(
            el('div', { className: 'dc-half' }, [
              el('div', { className: 'dc-eyebrow-row' }, [
                el('span', { className: 'dc-eyebrow', textContent: 'Pick One Category' }),
                el('span', { className: 'dc-mono', style: { fontSize: '9.5px', color: 'var(--dc-ink-3)' }, textContent: winnerLabel + ' ' + fmtPct(top.prob) })
              ]),
              el('div', { className: 'dc-q-headline' }, [
                el('span', {
                  className: 'dc-plain-q',
                  textContent: choiceQ.cardQuestion || choiceQ.instructions || qk,
                  title: choiceQ.instructions
                })
              ]),
              bars
            ])
          );
        } else {
          body.appendChild(
            el('div', { className: 'dc-half' }, [
              el('div', {
                className: 'dc-empty-state',
                textContent: hasPendingChoice
                  ? 'Category question edited — click Run in Customize ↗'
                  : 'No Category question active — enable in Customize ↗'
              })
            ])
          );
        }
      }

      clearNode(verdictWrap);
      verdictWrap.appendChild(el('div', { className: 'dc-scanline', 'aria-hidden': 'true' }));
      verdictWrap.appendChild(header);
      verdictWrap.appendChild(body);
    }

    // =========================================================================
    // CELL 3 (01C) — RUBRIC SCORE (score) + ZERO-OUTPUT-TOKEN PROOF
    // =========================================================================
    function renderScoreCell() {
      if (!scoreEl || !scoreWrap) return;
      const header = el('header', { className: 'dc-card-header' }, [
        el('div', { className: 'dc-card-brand' }, [
          el('span', { className: 'dc-step-pill', textContent: '3 · RUBRIC & PROOF' })
        ]),
        el('div', { className: 'dc-card-actions' }, [
          el('span', { className: 'dc-api-whisper', textContent: 'score', title: 'Gemini Decisions API primitive: ordered rubric score' }),
          el(
            'button',
            {
              type: 'button',
              className: 'dc-icon-btn',
              dataset: { focusRole: 'expand-btn' },
              'aria-label': 'Open Decisions API Workbench to customize questions, upload images, or view JSON',
              onClick: function () {
                openWorkbench('expand-btn', { openKeyPopover: false, initialTab: 'results' });
              }
            },
            'Customize ↗'
          )
        ])
      ]);

      const body = el('div', { className: 'dc-cell-body dc-score-body' });
      const mainArea = el('div', { className: 'dc-score-main' });

      if (app.error) {
        mainArea.appendChild(
          el('div', { className: 'dc-empty-state' }, [
            el('div', { textContent: 'Live evaluation paused — resolve API error in Cell 2 or Customize.' }),
            el('button', {
              type: 'button',
              className: 'dc-btn dc-btn--sm',
              textContent: 'Open Workbench',
              onClick: function () {
                openWorkbench('expand-btn', { openKeyPopover: false, initialTab: 'results' });
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

          mainArea.appendChild(
            el('div', { className: 'dc-eyebrow-row' }, [
              el('span', { className: 'dc-eyebrow', textContent: 'Rubric Score (' + ans.min + '–' + ans.max + ')' }),
              el('div', { style: { display: 'flex', alignItems: 'center', gap: '5px' } }, [
                deltaStr ? el('span', { className: 'dc-delta-chip', textContent: deltaStr }) : null,
                cert
                  ? el('span', {
                      className: 'dc-certainty-tag',
                      textContent: cert,
                      title: 'Distribution spread σ = ' + ans.stdDev.toFixed(2)
                    })
                  : null
              ])
            ])
          );

          mainArea.appendChild(
            el('div', { className: 'dc-plain-q', textContent: scoreQ.cardQuestion || scoreQ.instructions || qk, title: scoreQ.instructions })
          );

          mainArea.appendChild(
            el('div', { className: 'dc-score-hero-row' }, [
              el('div', { className: 'dc-score-hero-left' }, [
                el('span', { className: 'dc-score-big', textContent: ans.score.toFixed(1) }),
                el('span', { className: 'dc-score-denom', textContent: '/ ' + ans.max }),
                peakName ? el('span', { className: 'dc-score-tier', textContent: '· ' + peakName }) : null
              ])
            ])
          );

          const barsGrid = el('div', {
            className: 'dc-card-bars',
            style: { gridTemplateColumns: 'repeat(' + cols + ', 1fr)' }
          });
          ans.levels.forEach(function (lvl) {
            const isPeak = lvl.index === ans.peakIndex;
            barsGrid.appendChild(
              el('div', { className: 'dc-card-bar-col', title: lvl.index + ': ' + lvl.description + ' (' + fmtPct(lvl.prob) + ')' }, [
                el('span', { className: 'dc-card-bar-pct', textContent: fmtPct(lvl.prob) }),
                el('div', {
                  className: 'dc-card-bar' + (isPeak ? ' is-peak' : ''),
                  style: { height: Math.max(8, Math.round(lvl.prob * 72)) + '%' }
                })
              ])
            );
          });
          barsGrid.appendChild(
            el('div', {
              className: 'dc-card-ev-pointer',
              title: 'Weighted average: ' + ans.score.toFixed(2) + ' / ' + ans.max,
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
                title: lvl.description
              })
            );
          });

          mainArea.appendChild(el('div', { className: 'dc-card-chart' }, [barsGrid, labelsGrid]));
        } else {
          mainArea.appendChild(
            el('div', {
              className: 'dc-empty-state',
              textContent: hasPendingScore
                ? 'Rubric question edited — click Run in Customize ↗'
                : 'No Rubric question active — enable in Customize ↗'
            })
          );
        }
      }

      // Signature Zero-Output-Token Proof Strip
      const usage = !app.error && app.result && app.result.normalized ? app.result.normalized.usage : null;
      const outTok = usage ? usage.total_output_tokens : 0;
      const answerCount = !app.error && app.result && app.result.normalized
        ? Object.keys(app.result.normalized.answers || {}).length
        : 0;
      const resultIsLive = Boolean(!app.error && app.result && app.result.mode === 'live');
      const timingText = app.isRunning
        ? 'running…'
        : resultIsLive
          ? app.result.latencyMs + 'ms · Live'
          : '1 call · ' + answerCount + ' answer' + (answerCount === 1 ? '' : 's');

      const proofLeftChildren = app.error
        ? [el('span', { className: 'dc-proof-meta', textContent: 'Live error · no active result' })]
        : [
            el('span', {
              className: 'dc-zero-badge',
              textContent: outTok + ' words generated',
              title: 'total_output_tokens: ' + outTok + ' — Decisions API scores directly without generating text'
            }),
            el('span', { className: 'dc-proof-meta', textContent: timingText })
          ];

      const proofStrip = el('footer', { className: 'dc-proof-strip' }, [
        el('div', { className: 'dc-proof-left' }, proofLeftChildren),
        el('button', {
          type: 'button',
          className: 'dc-link-btn',
          dataset: { focusRole: 'json-btn' },
          textContent: 'JSON ↗',
          title: 'Inspect exact v1beta/decisions Request JSON and cURL',
          onClick: function () {
            openWorkbench('json-btn', { openKeyPopover: false, initialTab: 'request' });
          }
        })
      ]);

      body.appendChild(mainArea);
      body.appendChild(proofStrip);

      clearNode(scoreWrap);
      scoreWrap.appendChild(el('div', { className: 'dc-scanline', 'aria-hidden': 'true' }));
      scoreWrap.appendChild(header);
      scoreWrap.appendChild(body);
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
        onChange: function (e) {
          switchPreset(e.target.value, 0);
        }
      });
      Presets.LIST.forEach(function (p) {
        presetSelect.appendChild(el('option', { value: p.id, textContent: p.title }));
      });
      wbRefs.presetSelect = presetSelect;

      const variantSeg = el('div', { className: 'dc-seg', role: 'group', 'aria-label': 'Input variant' });
      wbRefs.variantSeg = variantSeg;

      const modeSeg = el('div', { className: 'dc-seg', role: 'group', 'aria-label': 'Execution mode' });
      wbRefs.modeSeg = modeSeg;

      const keyBtn = el('button', {
        type: 'button',
        className: 'dc-btn',
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
        className: 'dc-btn dc-btn--primary',
        onClick: function () {
          runEvaluation({ resetGhost: false });
        }
      });
      wbRefs.runBtn = runBtn;

      const closeBtn = el('button', {
        type: 'button',
        className: 'dc-btn dc-btn--ghost',
        'aria-label': 'Close Workbench',
        textContent: '×',
        onClick: closeWorkbench
      });

      const bar = el('div', { className: 'dc-wb-bar' }, [
        el('div', { className: 'dc-wb-bar-left' }, [
          el('span', { className: 'dc-index', textContent: '01' }),
          el('h2', { id: 'dc-wb-heading', className: 'dc-wb-title', textContent: 'Decisions API Studio' }),
          el('span', { className: 'dc-model-chip', textContent: Schema.MODEL }),
          presetSelect,
          variantSeg
        ]),
        el('div', { className: 'dc-wb-bar-right' }, [
          modeSeg,
          keyAnchor,
          runBtn,
          closeBtn
        ])
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
      wbRefs.runBtn.className = 'dc-btn ' + (app.mode === 'live' ? 'dc-btn--live' : 'dc-btn--primary');
      clearNode(wbRefs.runBtn);
      const label = app.isRunning
        ? 'Running…'
        : !validation.valid
          ? validation.errors.length + ' Schema Issue' + (validation.errors.length === 1 ? '' : 's')
          : app.mode === 'live'
            ? 'Run Live'
            : 'Run Demo';
      wbRefs.runBtn.appendChild(document.createTextNode(label));
      if (!app.isRunning && validation.valid) {
        wbRefs.runBtn.appendChild(el('span', { className: 'dc-kbd', textContent: '⌘↵' }));
      }
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
          el('code', { className: 'dc-mono', textContent: 'x-goog-api-key' }),
          ' to ',
          el('code', { className: 'dc-mono', textContent: 'generativelanguage.googleapis.com' }),
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
        className: 'dc-btn dc-btn--sm',
        textContent: app.keyVisible ? 'Hide' : 'Show',
        onClick: function () {
          app.keyVisible = !app.keyVisible;
          input.type = app.keyVisible ? 'text' : 'password';
          toggleVisBtn.textContent = app.keyVisible ? 'Hide' : 'Show';
        }
      });
      wbRefs.keyToggleVisBtn = toggleVisBtn;

      pop.appendChild(el('div', { className: 'dc-key-input-row' }, [input, toggleVisBtn]));

      const persistCheck = el('input', {
        type: 'checkbox',
        checked: storeType === 'local'
      });

      pop.appendChild(
        el('label', { className: 'dc-checkbox-row' }, [
          persistCheck,
          'Remember in this browser (localStorage); off = tab session only'
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
          closeKeyPopover(false);
          renderWorkbenchHeaderControls();
          runEvaluation({ resetGhost: true });
          return;
        }
        lastKnownKey = val;
        Client.KeyStore.set(val, persistCheck.checked);
        app.mode = 'live';
        app.error = null;
        closeKeyPopover(false);
        renderWorkbenchHeaderControls();
        runEvaluation({ resetGhost: true });
      };

      const saveBtn = el('button', {
        type: 'button',
        className: 'dc-btn dc-btn--live dc-btn--sm',
        textContent: 'Save & Go Live',
        onClick: saveAndGoLive
      });

      const clearBtn = el('button', {
        type: 'button',
        className: 'dc-btn dc-btn--sm',
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
        className: 'dc-btn dc-btn--ghost dc-btn--sm',
        textContent: 'Close',
        onClick: function () {
          closeKeyPopover(true);
        }
      });

      pop.appendChild(
        el('div', { className: 'dc-key-footer' }, [
          el('div', { style: { display: 'flex', gap: '6px' } }, [clearBtn, closePopBtn]),
          saveBtn
        ])
      );
    }

    function renderWorkbenchHeaderControls() {
      if (!wbRefs.presetSelect) return;
      wbRefs.presetSelect.value = app.state.presetId;

      const preset = Presets.getPreset(app.state.presetId);
      clearNode(wbRefs.variantSeg);
      preset.variants.forEach(function (v, idx) {
        wbRefs.variantSeg.appendChild(
          el('button', {
            type: 'button',
            className: 'dc-seg-btn',
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
            className: 'dc-seg-btn',
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

      renderKeyPopover();
      updateRunButton();
    }

    function renderWorkbenchValidation(validationOpt) {
      const box = wbRefs.validationBox;
      if (!box) return;
      const validation = validationOpt || getValidation();
      clearNode(box);
      box.hidden = validation.valid;
      if (!validation.valid) {
        validation.errors.slice(0, 4).forEach(function (err) {
          box.appendChild(el('div', { textContent: '• ' + err.message }));
        });
      }
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

    function renderWorkbenchLeft() {
      const left = wbRefs.leftPane;
      if (!left) return;
      clearNode(left);

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
                el('span', { className: 'dc-media-zoom-hint', textContent: app.mediaExpanded ? '−' : '⤢' })
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
            className: 'dc-key-note',
            textContent: app.uploadNotice || 'Drop or paste (⌘V) an image for multimodal evaluation, or choose a built-in canvas sample.'
          })
        );
      }

      const resSeg = el('div', { className: 'dc-seg', role: 'group', 'aria-label': 'Image resolution' });
      Schema.RESOLUTIONS.forEach(function (res) {
        resSeg.appendChild(
          el('button', {
            type: 'button',
            className: 'dc-seg-btn',
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
          el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
            fileInput,
            el('button', {
              type: 'button',
              className: 'dc-btn dc-btn--sm',
              textContent: app.state.image ? 'Replace Image' : 'Upload Image',
              onClick: function () {
                fileInput.click();
              }
            }),
            sampleSelect,
            app.state.image
              ? el('button', {
                  type: 'button',
                  className: 'dc-btn dc-btn--ghost dc-btn--sm',
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
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, [
            el('span', { className: 'dc-section-label', textContent: 'Detail' }),
            resSeg
          ])
        ])
      );

      const inputArea = el('textarea', {
        className: 'dc-textarea',
        rows: '3',
        placeholder: 'Shared text context evaluated against all active questions in one forward pass…',
        onInput: function (e) {
          app.state.inputText = e.target.value;
          app.customTextEdited = true;
          const v = getValidation();
          renderWorkbenchValidation(v);
          updateRunButton(v);
          renderWorkbenchWirePreview();
        }
      });
      inputArea.value = app.state.inputText;

      const inputSection = el('section', { className: 'dc-section' }, [
        el('div', { className: 'dc-section-head' }, [
          el('span', { className: 'dc-section-label', textContent: 'Shared Multimodal Input' }),
          el('span', {
            className: 'dc-mono',
            style: { fontSize: '10.5px', color: 'var(--dc-ink-3)' },
            textContent: app.state.image ? 'image + text' : 'text only'
          })
        ]),
        inputArea,
        mediaBox
      ]);

      const validationBox = el('div', { className: 'dc-validation-box', role: 'alert', hidden: true });
      wbRefs.validationBox = validationBox;

      const qList = el('div', { className: 'dc-q-list' });
      app.state.questions.forEach(function (q, qIdx) {
        const card = el('div', { className: 'dc-q-card' + (q.enabled === false ? ' is-disabled' : '') });

        const enabledCheck = el('input', {
          type: 'checkbox',
          checked: q.enabled !== false,
          'aria-label': 'Enable question ' + q.key,
          onChange: function (e) {
            q.enabled = e.target.checked;
            card.classList.toggle('is-disabled', !q.enabled);
            updateActiveQuestionsCountLabel();
            const v = getValidation();
            renderWorkbenchValidation(v);
            updateRunButton(v);
            renderWorkbenchWirePreview();
          }
        });

        const keyInput = el('input', {
          type: 'text',
          className: 'dc-input dc-input--mono dc-q-key-input',
          value: q.key,
          'aria-label': 'Question key',
          placeholder: 'question_key',
          onInput: function (e) {
            q.key = e.target.value;
            const v = getValidation();
            renderWorkbenchValidation(v);
            updateRunButton(v);
            renderWorkbenchWirePreview();
          }
        });

        const removeQBtn = el('button', {
          type: 'button',
          className: 'dc-btn dc-btn--ghost dc-btn--sm',
          'aria-label': 'Remove question ' + q.key,
          textContent: '×',
          onClick: function () {
            app.state.questions.splice(qIdx, 1);
            renderWorkbenchLeft();
            renderWorkbenchWirePreview();
            updateRunButton();
          }
        });

        card.appendChild(
          el('div', { className: 'dc-q-head' }, [
            enabledCheck,
            el('span', { className: 'dc-type-tag', textContent: q.type }),
            keyInput,
            removeQBtn
          ])
        );

        const instInput = el('input', {
          type: 'text',
          className: 'dc-input',
          value: q.instructions || '',
          placeholder: 'Question instructions',
          'aria-label': 'Instructions for ' + q.key,
          onInput: function (e) {
            q.instructions = e.target.value;
            q.cardQuestion = e.target.value;
            const v = getValidation();
            renderWorkbenchValidation(v);
            updateRunButton(v);
            renderWorkbenchWirePreview();
          }
        });
        card.appendChild(instInput);

        if (q.type === 'noul') {
          const tdInput = el('input', {
            type: 'text',
            className: 'dc-input',
            value: q.trueDescription || '',
            placeholder: 'Optional: when to answer Yes',
            onInput: function (e) {
              q.trueDescription = e.target.value;
              renderWorkbenchWirePreview();
            }
          });
          const fdInput = el('input', {
            type: 'text',
            className: 'dc-input',
            value: q.falseDescription || '',
            placeholder: 'Optional: when to answer No',
            onInput: function (e) {
              q.falseDescription = e.target.value;
              renderWorkbenchWirePreview();
            }
          });
          card.appendChild(
            el('div', { className: 'dc-q-subgrid' }, [
              el('div', null, [el('span', { className: 'dc-field-label', textContent: 'When Yes (true_description)' }), tdInput]),
              el('div', null, [el('span', { className: 'dc-field-label', textContent: 'When No (false_description)' }), fdInput])
            ])
          );
        } else if (q.type === 'choice') {
          const optWrap = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } });
          (q.options || []).forEach(function (opt, oIdx) {
            optWrap.appendChild(
              el('div', { className: 'dc-opt-row' }, [
                el('input', {
                  type: 'text',
                  className: 'dc-input dc-input--mono',
                  value: opt.key,
                  placeholder: 'option_key',
                  onInput: function (e) {
                    opt.key = e.target.value;
                    opt.label = humanizeKey(e.target.value);
                    const v = getValidation();
                    renderWorkbenchValidation(v);
                    updateRunButton(v);
                    renderWorkbenchWirePreview();
                  }
                }),
                el('input', {
                  type: 'text',
                  className: 'dc-input',
                  value: opt.description,
                  placeholder: 'Option criteria description',
                  onInput: function (e) {
                    opt.description = e.target.value;
                    const v = getValidation();
                    renderWorkbenchValidation(v);
                    updateRunButton(v);
                    renderWorkbenchWirePreview();
                  }
                }),
                el('button', {
                  type: 'button',
                  className: 'dc-btn dc-btn--ghost dc-btn--sm',
                  textContent: '×',
                  disabled: q.options.length <= 2,
                  'aria-label': 'Remove option',
                  onClick: function () {
                    q.options.splice(oIdx, 1);
                    renderWorkbenchLeft();
                    renderWorkbenchWirePreview();
                    updateRunButton();
                  }
                })
              ])
            );
          });
          optWrap.appendChild(
            el('div', null, [
              el('button', {
                type: 'button',
                className: 'dc-btn dc-btn--sm',
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
                  renderWorkbenchLeft();
                  renderWorkbenchWirePreview();
                  updateRunButton();
                }
              })
            ])
          );
          card.appendChild(optWrap);
        } else if (q.type === 'score') {
          const lvlWrap = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } });
          (q.levels || []).forEach(function (lvl, lIdx) {
            lvlWrap.appendChild(
              el('div', { className: 'dc-level-row' }, [
                el('span', { className: 'dc-level-idx', textContent: String(lIdx) }),
                el('input', {
                  type: 'text',
                  className: 'dc-input',
                  value: lvl,
                  placeholder: 'Level ' + lIdx + ' rubric criterion',
                  onInput: function (e) {
                    q.levels[lIdx] = e.target.value;
                    if (Array.isArray(q.levelLabels)) q.levelLabels[lIdx] = '';
                    const v = getValidation();
                    renderWorkbenchValidation(v);
                    updateRunButton(v);
                    renderWorkbenchWirePreview();
                  }
                }),
                el('button', {
                  type: 'button',
                  className: 'dc-btn dc-btn--ghost dc-btn--sm',
                  textContent: '×',
                  disabled: q.levels.length <= 2,
                  'aria-label': 'Remove level ' + lIdx,
                  onClick: function () {
                    q.levels.splice(lIdx, 1);
                    if (Array.isArray(q.levelLabels)) q.levelLabels.splice(lIdx, 1);
                    renderWorkbenchLeft();
                    renderWorkbenchWirePreview();
                    updateRunButton();
                  }
                })
              ])
            );
          });
          lvlWrap.appendChild(
            el('div', null, [
              el('button', {
                type: 'button',
                className: 'dc-btn dc-btn--sm',
                textContent: '+ Add Rubric Level',
                onClick: function () {
                  q.levels.push('Level ' + q.levels.length + ': higher quality criteria.');
                  if (Array.isArray(q.levelLabels)) q.levelLabels.push('Level ' + (q.levels.length - 1));
                  renderWorkbenchLeft();
                  renderWorkbenchWirePreview();
                  updateRunButton();
                }
              })
            ])
          );
          card.appendChild(lvlWrap);
        }

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
        renderWorkbenchLeft();
        renderWorkbenchWirePreview();
        updateRunButton();
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
          el('div', { style: { display: 'flex', gap: '5px' } }, [
            el('button', { type: 'button', className: 'dc-btn dc-btn--sm', textContent: '+ Yes/No (noul)', onClick: function () { addQuestion('noul'); } }),
            el('button', { type: 'button', className: 'dc-btn dc-btn--sm', textContent: '+ Category (choice)', onClick: function () { addQuestion('choice'); } }),
            el('button', { type: 'button', className: 'dc-btn dc-btn--sm', textContent: '+ Rubric (score)', onClick: function () { addQuestion('score'); } })
          ])
        ]),
        validationBox,
        qList
      ]);

      left.appendChild(inputSection);
      left.appendChild(questionsSection);
      renderWorkbenchValidation();
    }

    function buildResultsStack() {
      const stack = el('div', { className: 'dc-results-stack' });

      if (app.error) {
        stack.appendChild(
          el('div', { className: 'dc-error-panel', role: 'alert' }, [
            el('h4', { textContent: app.error.headline }),
            el('p', { textContent: app.error.detail }),
            el('p', { style: { fontWeight: '600' }, textContent: app.error.remediation }),
            el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
              el('button', {
                type: 'button',
                className: 'dc-btn dc-btn--sm',
                textContent: 'Retry Live',
                onClick: function () {
                  runEvaluation({ resetGhost: false });
                }
              }),
              app.error.httpStatus === 401 || app.error.code === 'MISSING_KEY'
                ? el('button', {
                    type: 'button',
                    className: 'dc-btn dc-btn--sm',
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
                className: 'dc-btn dc-btn--sm',
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

      activeQuestions.forEach(function (q) {
        const qk = trimKey(q.key);
        const ans = answers[qk];
        const prev = prevAnswers[qk];
        if (!ans) return;

        if (ans.type === 'noul') {
          const thresh = Number.isFinite(q.threshold) ? q.threshold : 0.5;
          const isYes = ans.noul >= thresh;
          const deltaStr = prev && prev.type === 'noul' ? fmtSignedPts(ans.noul - prev.noul) : null;

          const fillEl = el('div', {
            className: 'dc-noul-fill' + (isYes ? '' : ' is-below'),
            style: { width: Math.round(ans.noul * 100) + '%' }
          });
          const track = el('div', { className: 'dc-noul-track dc-noul-wb-track' });
          track.appendChild(fillEl);
          if (prev && prev.type === 'noul') {
            track.appendChild(
              el('div', {
                className: 'dc-noul-ghost',
                title: 'Previous run: ' + fmtPct(prev.noul),
                style: { left: Math.round(prev.noul * 100) + '%' }
              })
            );
          }
          const pin = el('button', {
            type: 'button',
            className: 'dc-noul-pin',
            role: 'slider',
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
          const tickEl = el('span', { textContent: 'Cutoff ' + fmtPct(thresh) + ' (drag)' });
          const verdictEl = el('span', {
            className: 'dc-verdict-badge' + (isYes ? '' : ' is-no'),
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
                    deltaStr ? el('span', { className: 'dc-delta-chip', textContent: deltaStr }) : null
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
                el('span', { className: 'dc-mono', textContent: 'confidence ' + fmtPct(ans.confidence) })
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
                title: optionHumanLabel(q, r.key) + ': ' + fmtPct(r.prob),
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
                    title: 'Previous: ' + fmtPct(prevP),
                    style: { left: Math.round(Schema.clamp(prevP, 0, 1) * 100) + '%' }
                  })
                : null
            ]);

            rows.appendChild(
              el('div', { className: 'dc-choice-item' }, [
                el('div', { className: 'dc-choice-label' }, [
                  el('span', { className: 'dc-choice-opt-key', textContent: optionHumanLabel(q, r.key), title: r.key }),
                  r.description ? el('span', { className: 'dc-choice-opt-desc', textContent: r.description, title: r.description }) : null
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
                  el('span', { className: 'dc-hero-num', style: { fontSize: '16px' }, textContent: optionHumanLabel(q, winnerKey) }),
                  el('span', {
                    className: 'dc-hero-sub',
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
          ans.levels.forEach(function (lvl) {
            hist.appendChild(
              el('div', { className: 'dc-hist-col', title: 'Level ' + lvl.index + ': ' + fmtPct(lvl.prob) }, [
                el('span', { className: 'dc-hist-pct', textContent: fmtPct(lvl.prob) }),
                el('div', {
                  className: 'dc-hist-bar' + (lvl.index === ans.peakIndex ? ' is-peak' : ''),
                  style: { height: Math.max(3, Math.round(lvl.prob * 72)) + 'px' }
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
              title: 'Expected score = ' + ans.score.toFixed(2),
              style: { left: evPct + '%' }
            })
          );

          const rubricTable = el('div', { className: 'dc-rubric-table' });
          ans.levels.forEach(function (lvl) {
            rubricTable.appendChild(
              el('div', { className: 'dc-rubric-row' + (lvl.index === ans.peakIndex ? ' is-peak' : '') }, [
                el('span', { className: 'dc-mono', textContent: String(lvl.index) }),
                el('span', { textContent: lvl.description }),
                el('span', { className: 'dc-mono', style: { textAlign: 'right' }, textContent: fmtPct(lvl.prob) })
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
                    deltaStr ? el('span', { className: 'dc-delta-chip', textContent: 'Δ ' + deltaStr }) : null
                  ]),
                  el('div', { className: 'dc-res-inst', textContent: q.instructions })
                ]),
                el('div', { className: 'dc-res-hero' }, [
                  el('span', { className: 'dc-hero-num', textContent: ans.score.toFixed(2) }),
                  el('span', {
                    className: 'dc-hero-sub',
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

      const provBanner = el('div', { className: 'dc-provenance', dataset: { mode: provMode } }, [
        el('div', { className: 'dc-provenance-left' }, [
          el('span', { className: 'dc-dot', 'aria-hidden': 'true' }),
          provLabel
        ]),
        usage
          ? el('div', { className: 'dc-telemetry-chips' }, [
              el('span', {
                className: 'dc-chip dc-chip--hero',
                textContent: 'output_tokens: ' + usage.total_output_tokens
              }),
              el('span', {
                className: 'dc-chip',
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
        { className: 'dc-tabs', role: 'tablist', 'aria-label': 'Output inspector' },
        tabSpecs.map(function (entry, idx) {
          const isSelected = app.activeTab === entry[0];
          return el('button', {
            id: 'dc-tab-' + entry[0],
            type: 'button',
            role: 'tab',
            className: 'dc-tab-btn',
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
        style: { display: 'flex', flexDirection: 'column', gap: '10px' }
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
          className: 'dc-btn dc-btn--sm',
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
          el('div', { className: 'dc-seg' }, [
            el('button', {
              type: 'button',
              className: 'dc-seg-btn',
              'aria-pressed': String(app.requestFormat === 'json'),
              textContent: 'JSON Body',
              onClick: function () {
                app.requestFormat = 'json';
                renderWorkbenchRight();
              }
            }),
            el('button', {
              type: 'button',
              className: 'dc-seg-btn',
              'aria-pressed': String(app.requestFormat === 'curl'),
              textContent: 'cURL (redacted)',
              onClick: function () {
                app.requestFormat = 'curl';
                renderWorkbenchRight();
              }
            })
          ]),
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
            app.state.image
              ? el('label', { className: 'dc-checkbox-row' }, [
                  el('input', {
                    type: 'checkbox',
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
          className: 'dc-btn dc-btn--sm',
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
      renderAllCells();
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
      if (disposed) return;
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
        c.classList.remove('is-scanning', 'is-loading', 'is-dimmed', 'is-peer-highlight');
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
