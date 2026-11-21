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

  function fmtSignedDelta(d) {
    const n = Number(d);
    if (!Number.isFinite(n) || Math.abs(n) < 0.005) return null;
    return (n > 0 ? '+' : '−') + Math.abs(n).toFixed(2);
  }

  function computeScorePointerPct(score, min, max, cols) {
    const span = Math.max(1, max - min);
    const normalized = Schema.clamp((score - min) / span, 0, 1);
    const colCount = Math.max(2, cols);
    return ((0.5 + normalized * (colCount - 1)) / colCount) * 100;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  function noulBand(p, threshold) {
    if (p >= Math.max(threshold, 0.78)) return 'YES · HIGH';
    if (p >= threshold) return p - threshold < 0.12 ? 'YES · MARGINAL' : 'LEAN YES';
    if (p <= Math.min(threshold, 0.22)) return 'NO · HIGH';
    return threshold - p < 0.12 ? 'NO · MARGINAL' : 'LEAN NO';
  }

  function snapshotStateForNormalization(state) {
    return {
      questions: (state.questions || []).map(function (q) {
        return {
          key: q.key,
          type: q.type,
          options: Array.isArray(q.options)
            ? q.options.map(function (o) {
                return { key: o.key, description: o.description };
              })
            : undefined,
          levels: Array.isArray(q.levels) ? q.levels.slice() : undefined
        };
      })
    };
  }

  function mountDecisionsCell(rootEl) {
    if (!rootEl) return;

    const initialPreset = Presets.createPresetState('receipt', 0);
    const savedKey = Client.KeyStore.get();

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
      result: null, // { mode, httpStatus, latencyMs, normalized, raw, evaluatedAt }
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
    rootEl.appendChild(liveRegion);

    function announce(msg) {
      liveRegion.textContent = '';
      setTimeout(function () {
        liveRegion.textContent = msg;
      }, 20);
    }

    const dialog = el('dialog', {
      className: 'dc-dialog',
      'aria-labelledby': 'dc-wb-heading'
    });
    document.body.appendChild(dialog);

    const wbRefs = {};

    function triggerScanPulse() {
      rootEl.classList.remove('is-scanning');
      dialog.classList.remove('is-scanning');
      void rootEl.offsetWidth;
      rootEl.classList.add('is-scanning');
      if (dialog.open) dialog.classList.add('is-scanning');
    }

    function setLoadingState(loading) {
      app.isRunning = loading;
      rootEl.classList.toggle('is-loading', loading);
      dialog.classList.toggle('is-loading', loading);
      if (wbRefs.runBtn) {
        updateRunButton();
      }
    }

    function getValidation() {
      return Schema.validateState(app.state);
    }

    function runEvaluation(opts) {
      const validation = getValidation();
      if (!validation.valid) {
        renderWorkbenchValidation(validation);
        updateRunButton(validation);
        if (wbRefs.rightPane) renderWorkbenchWirePreview();
        renderCard();
        return;
      }

      if (app.abortController) {
        app.abortController.abort();
        app.abortController = null;
      }

      const seq = ++app.runSeq;
      const body = Schema.buildRequestBody(app.state);
      const keepGhost = !(opts && opts.resetGhost);

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
          normalized: Schema.normalizeResponse(simRes.raw, app.state),
          raw: simRes.raw,
          evaluatedAt: simRes.evaluatedAt
        };
        triggerScanPulse();
        renderCard();
        if (dialog.open) {
          renderWorkbenchRight();
          renderWorkbenchHeaderControls();
        }
        announce('Simulated preview updated: ' + validation.activeCount + ' decisions, 0 output tokens.');
        return;
      }

      // Live mode — never silently fall back to simulated!
      const apiKey = Client.KeyStore.get();
      if (!apiKey) {
        setLoadingState(false);
        app.error = {
          code: 'MISSING_KEY',
          httpStatus: 0,
          headline: 'No Gemini API key configured',
          detail: 'Paste your standard Gemini API key (same key as Google AI Studio) to run live gemini-decision-1 requests.',
          remediation: 'Add your key in the API Key popover or switch explicitly to Simulated mode.'
        };
        renderCard();
        if (dialog.open) {
          app.showKeyPopover = true;
          renderWorkbenchHeaderControls();
          renderWorkbenchRight();
        }
        return;
      }

      const stateSnapshot = snapshotStateForNormalization(app.state);
      const ac = new AbortController();
      app.abortController = ac;
      app.error = null;
      setLoadingState(true);
      renderCard();
      if (dialog.open) renderWorkbenchRight();

      Client.runLive(body, apiKey, ac.signal)
        .then(function (liveRes) {
          if (seq !== app.runSeq) return;
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
            raw: liveRes.raw,
            evaluatedAt: liveRes.evaluatedAt
          };
          app.error = null;
          triggerScanPulse();
          renderCard();
          if (dialog.open) {
            renderWorkbenchRight();
            renderWorkbenchHeaderControls();
          }
          announce(
            'Live Decisions API evaluation complete: ' +
              validation.activeCount +
              ' decisions, 0 output tokens, ' +
              liveRes.latencyMs +
              ' milliseconds.'
          );
        })
        .catch(function (err) {
          if (seq !== app.runSeq) return;
          if (err && err.aborted) return;
          app.abortController = null;
          setLoadingState(false);
          app.error = err || {
            code: 'UNKNOWN',
            httpStatus: 0,
            headline: 'Live request failed',
            detail: 'Unexpected error calling Gemini Decisions API.',
            remediation: 'Retry or switch explicitly to Simulated mode.'
          };
          renderCard();
          if (dialog.open) {
            renderWorkbenchRight();
            renderWorkbenchHeaderControls();
          }
          announce('Live request failed: ' + app.error.headline);
        });
    }

    function switchPreset(presetId, variantIndex) {
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

    // In-place threshold drag & keyboard slider: never detaches the active track/pin
    function bindThresholdDrag(surface, controls) {
      const trackEl = controls.trackEl;
      const pinEl = controls.pinEl;
      const fillEl = controls.fillEl;
      const questionObj = controls.questionObj;
      const prob = controls.prob;

      function applyInPlace(nextThreshold) {
        questionObj.threshold = nextThreshold;
        const pct = Math.round(nextThreshold * 100) + '%';
        const isYes = prob >= nextThreshold;
        pinEl.style.left = pct;
        pinEl.setAttribute('aria-valuenow', fmtProb(nextThreshold));
        fillEl.classList.toggle('is-below', !isYes);
        trackEl.title = 'Drag to adjust YES/NO threshold (τ = ' + fmtProb(nextThreshold) + ')';

        if (controls.subEl) {
          controls.subEl.textContent = (isYes ? 'YES' : 'NO') + ' · τ ' + fmtProb(nextThreshold);
        }
        if (controls.tickEl) {
          controls.tickEl.textContent = 'τ = ' + fmtProb(nextThreshold) + ' (drag)';
        }
        if (controls.verdictEl) {
          controls.verdictEl.textContent = noulBand(prob, nextThreshold);
          controls.verdictEl.classList.toggle('is-no', !isYes);
        }

        // Sync only the passive surface without touching the actively dragged/focused DOM node
        if (surface === 'card') {
          if (dialog.open && app.activeTab === 'results') {
            renderWorkbenchResultsOnly();
          }
        } else {
          renderCard();
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
        e.preventDefault();
        e.stopPropagation();
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
        function onUp() {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
        }
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
      });

      pinEl.addEventListener('keydown', function (e) {
        const step = e.shiftKey ? 0.01 : 0.05;
        let next = null;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = questionObj.threshold - step;
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = questionObj.threshold + step;
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
    // 1. IN-GRID 4:3 INSTRUMENT CARD RENDERER
    // =========================================================================
    function renderCard() {
      const scanline = el('div', { className: 'dc-scanline', 'aria-hidden': 'true' });

      const effectiveLive = app.mode === 'live' && Boolean(Client.KeyStore.get());
      const modeKey = app.error ? 'error' : effectiveLive ? 'live' : 'simulated';
      const modeLabel = app.error ? 'LIVE ERR' : effectiveLive ? 'LIVE' : 'SIM';

      const header = el('header', { className: 'dc-card-header' }, [
        el('div', { className: 'dc-card-brand' }, [
          el('span', { className: 'dc-index', textContent: '01' }),
          el('span', { className: 'dc-card-title', textContent: 'Decisions API' })
        ]),
        el('div', { className: 'dc-card-actions' }, [
          el(
            'button',
            {
              type: 'button',
              className: 'dc-mode-pill',
              dataset: { mode: modeKey, focusRole: 'mode-pill' },
              title: effectiveLive ? 'Live Gemini Decisions API — click to manage key' : 'Simulated preview — click to add Gemini API key',
              onClick: function () {
                openWorkbench('mode-pill', { openKeyPopover: true });
              }
            },
            [el('span', { className: 'dc-dot', 'aria-hidden': 'true' }), modeLabel]
          ),
          el(
            'button',
            {
              type: 'button',
              className: 'dc-icon-btn',
              dataset: { focusRole: 'expand-btn' },
              'aria-label': 'Open Decisions API Workbench',
              onClick: function () {
                openWorkbench('expand-btn', { openKeyPopover: false });
              }
            },
            [el('span', { className: 'dc-expand-label', textContent: 'Lab' }), '↗']
          )
        ])
      ]);

      const activePreset = Presets.getPreset(app.state.presetId);
      const activeVariant = activePreset.variants[app.state.variantIndex] || activePreset.variants[0];

      const presetButtons = Presets.LIST.map(function (p) {
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

      const perturbButtons = activePreset.variants.map(function (v, idx) {
        return el('button', {
          type: 'button',
          className: 'dc-perturb-btn',
          'aria-pressed': String(idx === app.state.variantIndex),
          textContent: v.label,
          title: 'Perturb input: ' + v.summary,
          onClick: function () {
            switchVariant(idx);
          }
        });
      });

      const specimenChildren = [];
      if (app.state.image && app.state.image.dataUrl) {
        specimenChildren.push(
          el('div', { className: 'dc-thumb-wrap' }, [
            el('img', { src: app.state.image.dataUrl, alt: app.state.image.name }),
            el('span', { className: 'dc-thumb-tag', textContent: app.state.resolution.slice(0, 3) })
          ])
        );
      }
      const specimenSummary = app.customTextEdited
        ? (app.state.inputText.trim() || (app.state.image ? app.state.image.name : ''))
        : (activeVariant ? activeVariant.summary : app.state.inputText);
      specimenChildren.push(
        el('div', {
          className: 'dc-specimen-text',
          textContent: specimenSummary,
          title: app.state.inputText
        })
      );

      const dock = el('div', { className: 'dc-dock' }, [
        el('div', { className: 'dc-dock-top' }, [
          el('div', { className: 'dc-preset-tabs', role: 'group', 'aria-label': 'Scenarios' }, presetButtons),
          el('div', { className: 'dc-perturb-group', role: 'group', 'aria-label': 'Input variant' }, perturbButtons)
        ]),
        el('div', { className: 'dc-specimen-row' }, specimenChildren)
      ]);

      const rack = el('div', { className: 'dc-rack' });

      if (app.error) {
        rack.appendChild(
          el('div', { className: 'dc-card-error', role: 'alert' }, [
            el('div', { className: 'dc-card-error-title', textContent: app.error.headline }),
            el('div', { className: 'dc-card-error-detail', textContent: app.error.remediation }),
            el('div', { className: 'dc-card-error-actions' }, [
              el('button', {
                type: 'button',
                className: 'dc-btn dc-btn--sm',
                textContent: 'Retry Live',
                onClick: function () {
                  runEvaluation({ resetGhost: false });
                }
              }),
              el('button', {
                type: 'button',
                className: 'dc-btn dc-btn--sm',
                textContent: 'Switch to Simulated',
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
        const activeQuestions = app.state.questions.filter(function (q) {
          return q.enabled !== false;
        });

        const picks = [];
        ['noul', 'choice', 'score'].forEach(function (t) {
          const found = activeQuestions.find(function (q) {
            const qk = (q.key || '').trim();
            return q.type === t && Boolean(answers[qk]);
          });
          if (found) picks.push(found);
        });
        activeQuestions.forEach(function (q) {
          const qk = (q.key || '').trim();
          if (picks.length < 3 && picks.indexOf(q) < 0 && answers[qk]) {
            picks.push(q);
          }
        });

        picks.forEach(function (q) {
          const qk = (q.key || '').trim();
          const ans = answers[qk];
          const prev = prevAnswers[qk];
          if (!ans) return;

          if (ans.type === 'noul') {
            const thresh = Number.isFinite(q.threshold) ? q.threshold : 0.5;
            const isYes = ans.noul >= thresh;
            const fillEl = el('div', {
              className: 'dc-noul-fill' + (isYes ? '' : ' is-below'),
              style: { width: Math.round(ans.noul * 100) + '%' }
            });
            const track = el('div', {
              className: 'dc-noul-track',
              title: 'Drag to adjust YES/NO threshold (τ = ' + fmtProb(thresh) + ')'
            });
            track.appendChild(fillEl);
            if (prev && prev.type === 'noul') {
              track.appendChild(
                el('div', {
                  className: 'dc-noul-ghost',
                  style: { left: Math.round(prev.noul * 100) + '%' }
                })
              );
            }
            const pin = el('button', {
              type: 'button',
              className: 'dc-noul-pin',
              role: 'slider',
              'aria-label': 'Threshold for ' + qk,
              'aria-valuemin': '0.05',
              'aria-valuemax': '0.95',
              'aria-valuenow': fmtProb(thresh),
              style: { left: Math.round(thresh * 100) + '%' }
            });
            track.appendChild(pin);
            track.appendChild(
              el('div', {
                className: 'dc-noul-needle',
                style: { left: Math.round(ans.noul * 100) + '%' }
              })
            );
            const subEl = el('span', {
              className: 'dc-gauge-sub',
              textContent: (isYes ? 'YES' : 'NO') + ' · τ ' + fmtProb(thresh)
            });

            bindThresholdDrag('card', {
              trackEl: track,
              pinEl: pin,
              fillEl: fillEl,
              subEl: subEl,
              questionObj: q,
              prob: ans.noul
            });

            rack.appendChild(
              el('div', { className: 'dc-gauge-row' }, [
                el('span', { className: 'dc-type-tag', textContent: 'NOUL' }),
                el('div', { className: 'dc-gauge-mid' }, [
                  el('div', { className: 'dc-gauge-caption' }, [
                    el('span', { className: 'dc-gauge-key', textContent: qk }),
                    subEl
                  ]),
                  track
                ]),
                el('span', { className: 'dc-gauge-val', textContent: fmtProb(ans.noul) })
              ])
            );
          } else if (ans.type === 'choice') {
            const top = ans.ranked[0] || { key: ans.choice || '—', prob: 0 };
            const winnerKey = ans.choice || top.key;
            const ribbon = el('div', {
              className: 'dc-choice-ribbon',
              title: ans.ranked
                .map(function (r) {
                  return r.key + ': ' + fmtProb(r.prob);
                })
                .join(' · ')
            });
            ans.ranked.forEach(function (r, idx) {
              ribbon.appendChild(
                el('div', {
                  className: 'dc-choice-seg',
                  title: r.key + ': ' + Math.round(r.prob * 100) + '%',
                  style: {
                    width: Math.max(2, r.prob * 100) + '%',
                    background: CHOICE_SWATCHES[idx % CHOICE_SWATCHES.length]
                  }
                })
              );
            });

            rack.appendChild(
              el('div', { className: 'dc-gauge-row' }, [
                el('span', { className: 'dc-type-tag', textContent: 'CHOICE' }),
                el('div', { className: 'dc-gauge-mid' }, [
                  el('div', { className: 'dc-gauge-caption' }, [
                    el('span', { className: 'dc-gauge-key', textContent: winnerKey }),
                    el('span', { className: 'dc-gauge-sub', textContent: 'Σ ' + ans.sum.toFixed(2) })
                  ]),
                  ribbon
                ]),
                el('span', { className: 'dc-gauge-val', textContent: fmtProb(top.prob) })
              ])
            );
          } else if (ans.type === 'score') {
            const cols = Math.max(2, ans.levels.length);
            const evPct = computeScorePointerPct(ans.score, ans.min, ans.max, cols);
            const mini = el('div', {
              className: 'dc-score-mini',
              style: { gridTemplateColumns: 'repeat(' + cols + ', 1fr)' },
              title: 'Expected score ' + ans.score.toFixed(2) + ' / ' + ans.max + ' (σ = ' + ans.stdDev.toFixed(2) + ')'
            });
            ans.levels.forEach(function (lvl) {
              mini.appendChild(
                el('div', {
                  className: 'dc-score-mini-bar' + (lvl.index === ans.peakIndex ? ' is-peak' : ''),
                  style: { height: Math.max(14, Math.round(lvl.prob * 100)) + '%' }
                })
              );
            });
            mini.appendChild(
              el('div', {
                className: 'dc-score-ev-dot',
                style: { left: evPct + '%' }
              })
            );

            rack.appendChild(
              el('div', { className: 'dc-gauge-row' }, [
                el('span', { className: 'dc-type-tag', textContent: 'SCORE' }),
                el('div', { className: 'dc-gauge-mid' }, [
                  el('div', { className: 'dc-gauge-caption' }, [
                    el('span', { className: 'dc-gauge-key', textContent: qk }),
                    el('span', { className: 'dc-gauge-sub', textContent: 'σ ' + ans.stdDev.toFixed(2) })
                  ]),
                  mini
                ]),
                el('span', { className: 'dc-gauge-val', textContent: ans.score.toFixed(2) + '/' + ans.max })
              ])
            );
          }
        });
      }

      const usage = app.result && app.result.normalized ? app.result.normalized.usage : null;
      const outTok = usage ? usage.total_output_tokens : 0;
      const inTok = usage ? usage.total_input_tokens : 0;
      const qCount = app.state.questions.filter(function (q) {
        return q.enabled !== false;
      }).length;
      const resultIsLive = Boolean(app.result && app.result.mode === 'live');
      const latencyLabel = app.isRunning
        ? 'running…'
        : resultIsLive
          ? app.result.latencyMs + 'ms'
          : 'sim';

      const footer = el('footer', { className: 'dc-card-footer' }, [
        el('div', { className: 'dc-footer-left' }, [
          el('span', { className: 'dc-model-stamp', textContent: Schema.MODEL }),
          el('span', { className: 'dc-footer-meta', textContent: '1 pass · ' + qCount + ' Qs' })
        ]),
        el('div', { className: 'dc-footer-right' }, [
          el('span', { className: 'dc-zero-chip', textContent: outTok + ' out tok' }),
          el('span', { className: 'dc-footer-meta', textContent: (resultIsLive ? '' : '~') + inTok + ' in' }),
          el('span', { textContent: latencyLabel })
        ])
      ]);

      while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
      rootEl.appendChild(liveRegion);
      rootEl.appendChild(scanline);
      rootEl.appendChild(header);
      rootEl.appendChild(dock);
      rootEl.appendChild(rack);
      rootEl.appendChild(footer);
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
            : 'Run Simulated';
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

    function closeKeyPopover(restoreFocus) {
      if (!app.showKeyPopover) return;
      app.showKeyPopover = false;
      app.keyVisible = false;
      renderKeyPopover();
      if (restoreFocus && wbRefs.keyBtn) {
        wbRefs.keyBtn.focus();
      }
    }

    function renderKeyPopover() {
      const pop = wbRefs.keyPopover;
      if (!pop) return;
      if (wbRefs.keyBtn) {
        wbRefs.keyBtn.setAttribute('aria-expanded', String(app.showKeyPopover));
      }
      pop.hidden = !app.showKeyPopover;
      if (!app.showKeyPopover) return;

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

      const input = el('input', {
        type: app.keyVisible ? 'text' : 'password',
        className: 'dc-input dc-input--mono',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: 'AIza...',
        value: existing
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

      const saveBtn = el('button', {
        type: 'button',
        className: 'dc-btn dc-btn--live dc-btn--sm',
        textContent: 'Save & Go Live',
        onClick: function () {
          const val = input.value.trim();
          if (!val) {
            Client.KeyStore.clear();
            app.mode = 'simulated';
            app.error = null;
            closeKeyPopover(false);
            renderWorkbenchHeaderControls();
            runEvaluation({ resetGhost: true });
            return;
          }
          Client.KeyStore.set(val, persistCheck.checked);
          app.mode = 'live';
          app.error = null;
          closeKeyPopover(false);
          renderWorkbenchHeaderControls();
          runEvaluation({ resetGhost: true });
        }
      });

      const clearBtn = el('button', {
        type: 'button',
        className: 'dc-btn dc-btn--sm',
        textContent: 'Clear Key',
        disabled: !existing,
        onClick: function () {
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
            textContent: m === 'live' ? 'Live API' : 'Simulated',
            onClick: function (e) {
              if (m === 'live' && !Client.KeyStore.get()) {
                e.stopPropagation();
                // Keep app.mode honest ('simulated') until the user saves a key
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
            el('span', { className: 'dc-section-label', textContent: 'Res' }),
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
            el('span', { className: 'dc-type-tag', textContent: q.type.toUpperCase() }),
            keyInput,
            removeQBtn
          ])
        );

        const instInput = el('input', {
          type: 'text',
          className: 'dc-input',
          value: q.instructions || '',
          placeholder: 'Instructions / question prompt',
          'aria-label': 'Instructions for ' + q.key,
          onInput: function (e) {
            q.instructions = e.target.value;
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
            placeholder: 'Optional true_description',
            onInput: function (e) {
              q.trueDescription = e.target.value;
              renderWorkbenchWirePreview();
            }
          });
          const fdInput = el('input', {
            type: 'text',
            className: 'dc-input',
            value: q.falseDescription || '',
            placeholder: 'Optional false_description',
            onInput: function (e) {
              q.falseDescription = e.target.value;
              renderWorkbenchWirePreview();
            }
          });
          card.appendChild(
            el('div', { className: 'dc-q-subgrid' }, [
              el('div', null, [el('span', { className: 'dc-field-label', textContent: 'true_description (opt)' }), tdInput]),
              el('div', null, [el('span', { className: 'dc-field-label', textContent: 'false_description (opt)' }), fdInput])
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
                  q.options.push({ key: 'option_' + (q.options.length + 1), description: 'Describe when to choose this option.' });
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
            type: 'choice',
            instructions: 'Which category best matches this input?',
            options: [
              { key: 'category_a', description: 'Primary category A.' },
              { key: 'category_b', description: 'Alternative category B.' }
            ]
          });
        } else {
          app.state.questions.push({
            id: 'q-custom-' + suffix,
            enabled: true,
            key: 'rubric_' + suffix,
            type: 'score',
            instructions: 'Rate this input on an ordered rubric.',
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
            el('button', { type: 'button', className: 'dc-btn dc-btn--sm', textContent: '+ noul', onClick: function () { addQuestion('noul'); } }),
            el('button', { type: 'button', className: 'dc-btn dc-btn--sm', textContent: '+ choice', onClick: function () { addQuestion('choice'); } }),
            el('button', { type: 'button', className: 'dc-btn dc-btn--sm', textContent: '+ score', onClick: function () { addQuestion('score'); } })
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
                textContent: 'Switch to Simulated Preview',
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
      const activeQuestions = app.state.questions.filter(function (q) {
        return q.enabled !== false;
      });

      activeQuestions.forEach(function (q) {
        const qk = (q.key || '').trim();
        const ans = answers[qk];
        const prev = prevAnswers[qk];
        if (!ans) return;

        if (ans.type === 'noul') {
          const thresh = Number.isFinite(q.threshold) ? q.threshold : 0.5;
          const isYes = ans.noul >= thresh;
          const deltaStr = prev && prev.type === 'noul' ? fmtSignedDelta(ans.noul - prev.noul) : null;

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
                title: 'Previous run: ' + fmtProb(prev.noul),
                style: { left: Math.round(prev.noul * 100) + '%' }
              })
            );
          }
          const pin = el('button', {
            type: 'button',
            className: 'dc-noul-pin',
            role: 'slider',
            'aria-label': 'Decision threshold for ' + qk,
            'aria-valuemin': '0.05',
            'aria-valuemax': '0.95',
            'aria-valuenow': fmtProb(thresh),
            style: { left: Math.round(thresh * 100) + '%' }
          });
          track.appendChild(pin);
          track.appendChild(
            el('div', {
              className: 'dc-noul-needle',
              style: { left: Math.round(ans.noul * 100) + '%' }
            })
          );
          const tickEl = el('span', { textContent: 'τ = ' + fmtProb(thresh) + ' (drag)' });
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
                    el('span', { className: 'dc-type-tag', textContent: 'NOUL' }),
                    el('span', { className: 'dc-res-key', textContent: qk }),
                    deltaStr ? el('span', { className: 'dc-delta-chip', textContent: 'Δ ' + deltaStr }) : null
                  ]),
                  el('div', { className: 'dc-res-inst', textContent: q.instructions })
                ]),
                el('div', { className: 'dc-res-hero' }, [
                  el('span', { className: 'dc-hero-num', textContent: fmtProb(ans.noul) }),
                  el('span', { className: 'dc-hero-sub', textContent: '1−p = ' + fmtProb(1 - ans.noul) })
                ])
              ]),
              track,
              el('div', { className: 'dc-axis-ticks' }, [
                el('span', { textContent: '0.01' }),
                tickEl,
                el('span', { textContent: '0.99' })
              ]),
              el('div', { className: 'dc-verdict-row' }, [
                verdictEl,
                el('span', { className: 'dc-mono', textContent: 'confidence ' + fmtProb(ans.confidence) })
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
                title: r.key + ': ' + fmtProb(r.prob),
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
                    title: 'Previous: ' + fmtProb(prevP),
                    style: { left: Math.round(Schema.clamp(prevP, 0, 1) * 100) + '%' }
                  })
                : null
            ]);

            rows.appendChild(
              el('div', { className: 'dc-choice-item' }, [
                el('div', { className: 'dc-choice-label' }, [
                  el('span', { className: 'dc-choice-opt-key', textContent: r.key, title: r.key }),
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
                    el('span', { className: 'dc-type-tag', textContent: 'CHOICE' }),
                    el('span', { className: 'dc-res-key', textContent: qk })
                  ]),
                  el('div', { className: 'dc-res-inst', textContent: q.instructions })
                ]),
                el('div', { className: 'dc-res-hero' }, [
                  el('span', { className: 'dc-hero-num', style: { fontSize: '16px' }, textContent: winnerKey }),
                  el('span', {
                    className: 'dc-hero-sub',
                    textContent: 'Σp ' + ans.sum.toFixed(3) + ' · margin +' + ans.margin.toFixed(2)
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
              el('div', { className: 'dc-hist-col', title: 'Level ' + lvl.index + ': ' + Math.round(lvl.prob * 100) + '%' }, [
                el('span', { className: 'dc-hist-pct', textContent: Math.round(lvl.prob * 100) + '%' }),
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
          ans.levels.forEach(function (lvl) {
            ruler.appendChild(el('span', { className: 'dc-ev-tick', textContent: String(lvl.index) }));
          });
          ruler.appendChild(
            el('div', {
              className: 'dc-ev-pointer',
              title: 'Expected score E[s] = ' + ans.score.toFixed(2),
              style: { left: evPct + '%' }
            })
          );

          const rubricTable = el('div', { className: 'dc-rubric-table' });
          ans.levels.forEach(function (lvl) {
            rubricTable.appendChild(
              el('div', { className: 'dc-rubric-row' + (lvl.index === ans.peakIndex ? ' is-peak' : '') }, [
                el('span', { className: 'dc-mono', textContent: String(lvl.index) }),
                el('span', { textContent: lvl.description }),
                el('span', { className: 'dc-mono', style: { textAlign: 'right' }, textContent: fmtProb(lvl.prob) })
              ])
            );
          });

          stack.appendChild(
            el('article', { className: 'dc-res-card' }, [
              el('div', { className: 'dc-res-head' }, [
                el('div', { className: 'dc-res-title-group' }, [
                  el('div', { className: 'dc-res-key-row' }, [
                    el('span', { className: 'dc-type-tag', textContent: 'SCORE' }),
                    el('span', { className: 'dc-res-key', textContent: qk }),
                    deltaStr ? el('span', { className: 'dc-delta-chip', textContent: 'ΔE ' + deltaStr }) : null
                  ]),
                  el('div', { className: 'dc-res-inst', textContent: q.instructions })
                ]),
                el('div', { className: 'dc-res-hero' }, [
                  el('span', { className: 'dc-hero-num', textContent: ans.score.toFixed(2) }),
                  el('span', {
                    className: 'dc-hero-sub',
                    textContent: '/ ' + ans.max + ' · peak ' + ans.peakIndex + ' · σ ' + ans.stdDev.toFixed(2)
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
      const usage = app.result && app.result.normalized ? app.result.normalized.usage : null;
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
            : 'SIMULATED PREVIEW · Add a Gemini API key to call gemini-decision-1';

      const provBanner = el('div', { className: 'dc-provenance', dataset: { mode: provMode } }, [
        el('div', { className: 'dc-provenance-left' }, [
          el('span', { className: 'dc-dot', 'aria-hidden': 'true' }),
          provLabel
        ]),
        el('div', { className: 'dc-telemetry-chips' }, [
          el('span', {
            className: 'dc-chip dc-chip--hero',
            textContent: 'output_tokens: ' + (usage ? usage.total_output_tokens : 0)
          }),
          usage
            ? el('span', {
                className: 'dc-chip',
                textContent: (provMode === 'simulated' ? '~' : '') + 'in: ' + usage.total_input_tokens + (modSummary ? ' (' + modSummary + ')' : '')
              })
            : null
        ])
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
            copyToClipboard(str).then(function () {
              copyBtn.textContent = 'Copied ✓';
              setTimeout(function () {
                copyBtn.textContent = app.requestFormat === 'curl' ? 'Copy cURL' : 'Copy JSON';
              }, 1500);
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
        const displayRaw = app.result
          ? app.result.mode === 'simulated'
            ? Object.assign({ _simulated: true, _note: 'Local deterministic preview — not a live gemini-decision-1 response.' }, app.result.raw)
            : app.result.raw
          : app.error
            ? { error: app.error }
            : {};
        const rawStr = JSON.stringify(displayRaw, null, 2);

        const copyRespBtn = el('button', {
          type: 'button',
          className: 'dc-btn dc-btn--sm',
          textContent: 'Copy Response',
          onClick: function () {
            copyToClipboard(rawStr).then(function () {
              copyRespBtn.textContent = 'Copied ✓';
              setTimeout(function () {
                copyRespBtn.textContent = 'Copy Response';
              }, 1500);
            });
          }
        });

        tabContent.appendChild(
          el('div', { className: 'dc-code-toolbar' }, [
            el('span', {
              className: 'dc-key-note',
              textContent: app.result && app.result.mode === 'live'
                ? 'Verbatim JSON returned by POST /v1beta/decisions'
                : 'Simulated preview payload matching the v1beta/decisions response contract'
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
      const target = rootEl.querySelector('[data-focus-role="' + app.returnFocusRole + '"]') ||
        rootEl.querySelector('[data-focus-role="expand-btn"]');
      if (target && typeof target.focus === 'function') {
        target.focus();
      }
    }

    function openWorkbench(focusRole, opts) {
      app.returnFocusRole = focusRole || 'expand-btn';
      app.showKeyPopover = Boolean(opts && opts.openKeyPopover);

      if (!wbRefs.leftPane) {
        buildWorkbenchShell();
      }
      renderWorkbenchHeaderControls();
      renderWorkbenchLeft();
      renderWorkbenchRight();

      if (!dialog.open) {
        dialog.showModal();
      }
      if (app.showKeyPopover && wbRefs.keyInput) {
        wbRefs.keyInput.focus();
      }
    }

    function closeWorkbench() {
      app.showKeyPopover = false;
      app.keyVisible = false;
      if (dialog.open) dialog.close();
      renderCard();
      restoreCardTriggerFocus();
    }

    dialog.addEventListener('cancel', function (e) {
      if (app.showKeyPopover) {
        e.preventDefault();
        closeKeyPopover(true);
        return;
      }
      setTimeout(function () {
        renderCard();
        restoreCardTriggerFocus();
      }, 0);
    });

    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) {
        closeWorkbench();
        return;
      }
      if (app.showKeyPopover && wbRefs.keyAnchor && !wbRefs.keyAnchor.contains(e.target)) {
        closeKeyPopover(false);
      }
    });

    dialog.addEventListener('keydown', function (e) {
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

    runEvaluation({ resetGhost: true });
  }

  function bootstrap() {
    const mount = document.getElementById('cell-decisions');
    if (mount) {
      mountDecisionsCell(mount);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  NS.UI = {
    mount: mountDecisionsCell
  };
})(window);
