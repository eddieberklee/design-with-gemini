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

  function statusSymbol(status) {
    if (status === 'pass') return '●';
    if (status === 'warn') return '◐';
    if (status === 'fail') return '×';
    if (status === 'probing') return '◌';
    return '○';
  }

  function mountApiMatrixCell(rootEl) {
    if (!rootEl || rootEl.dataset.amMounted === 'true') return;
    rootEl.dataset.amMounted = 'true';

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
      drawerReturnTarget: null, // { type: 'endpoint', id } | { type: 'models' }
      activeAudioEl: null
    };

    const liveRegion = el('div', {
      className: 'am-sr-only',
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
      className: 'am-dialog',
      id: 'am-dialog',
      'aria-labelledby': 'am-heading'
    });
    document.body.appendChild(dialog);

    const refs = {};

    function buildDialogShell() {
      clearNode(dialog);

      const scanline = el('div', { className: 'am-scanline', 'aria-hidden': 'true' });
      const topbar = el('header', { className: 'am-topbar' });
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

      dialog.appendChild(scanline);
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

    function renderPrimaryCell() {
      const hasKey = Boolean(KeyStore.get());
      const counts = getCounts();
      const anyProbed = counts.pass + counts.warn + counts.fail > 0;

      let pillTone = 'idle';
      let pillText = hasKey ? 'KEY SET' : 'NO KEY';
      if (counts.probing > 0) {
        pillTone = 'probing';
        pillText = 'PROBING ' + counts.probing;
      } else if (anyProbed) {
        if (counts.fail > 0) {
          pillTone = 'fail';
          pillText = counts.fail + ' FAIL';
        } else if (counts.warn > 0) {
          pillTone = 'warn';
          pillText = counts.warn + ' WARN';
        } else {
          pillTone = 'pass';
          pillText = counts.pass + '/' + counts.total + ' OK';
        }
      }

      const ariaSummary =
        '04 API Matrix: ' +
        (hasKey ? 'API key configured. ' : 'No API key set. ') +
        counts.pass +
        ' passed, ' +
        counts.warn +
        ' warnings, ' +
        counts.fail +
        ' failed, ' +
        counts.idle +
        ' idle. Open secondary API status grid.';

      const microGrid = el('div', { className: 'am-micro-grid', 'aria-hidden': 'true' });
      Probes.ENDPOINTS.forEach(function (ep) {
        const st = getEndpointStatus(ep.id);
        microGrid.appendChild(
          el('div', { className: 'am-micro-tile', dataset: { status: st } }, [
            el('span', { className: 'am-led', dataset: { status: st } }),
            el('span', { className: 'am-micro-code', textContent: ep.code })
          ])
        );
      });

      const baySummaryText = counts.probing > 0
        ? 'Testing live endpoints (' + app.batchCompleted + '/' + Math.max(app.batchTotal, counts.probing) + ')…'
        : anyProbed
          ? counts.pass + ' pass · ' + counts.warn + ' warn · ' + counts.fail + ' fail'
          : hasKey
            ? '18 Google APIs ready to probe'
            : 'Paste AI Studio key to probe 18 APIs';

      const trigger = el(
        'button',
        {
          type: 'button',
          className: 'am-cell-trigger',
          'aria-haspopup': 'dialog',
          'aria-controls': 'am-dialog',
          'aria-label': ariaSummary,
          onClick: function () {
            openSecondaryGrid({ fromDeepLink: false });
          }
        },
        [
          el('div', { className: 'am-card-header' }, [
            el('div', { className: 'am-card-brand' }, [
              el('span', { className: 'am-index', textContent: '04' }),
              el('span', { className: 'am-card-title', textContent: 'API Matrix' })
            ]),
            el('div', { className: 'am-card-right' }, [
              el('span', {
                className: 'am-status-pill',
                dataset: { tone: pillTone },
                textContent: statusSymbol(pillTone) + ' ' + pillText
              }),
              el('span', { className: 'am-open-cue', 'aria-hidden': 'true' }, [
                el('span', { className: 'am-open-label', textContent: 'Grid' }),
                '↗'
              ])
            ])
          ]),
          el('div', { className: 'am-card-bay' }, [
            el('div', { className: 'am-bay-meta' }, [
              el('span', { className: 'am-bay-sub', textContent: baySummaryText }),
              el('span', {
                className: 'am-mono',
                textContent: app.catalog.models.length ? app.catalog.models.length + ' models' : '6×3'
              })
            ]),
            microGrid
          ]),
          el('div', { className: 'am-card-footer' }, [
            el('div', { className: 'am-footer-group' }, [
              el('span', { className: 'am-footer-host', textContent: 'generativelanguage.googleapis.com' }),
              el('span', { className: 'am-footer-extra', textContent: '18 APIs' })
            ]),
            el('div', { className: 'am-footer-group' }, [
              el('span', { textContent: 'Tap →' })
            ])
          ])
        ]
      );

      clearNode(rootEl);
      rootEl.appendChild(liveRegion);
      rootEl.appendChild(el('div', { className: 'am-scanline', 'aria-hidden': 'true' }));
      rootEl.appendChild(trigger);
      syncRunningClass();
    }

    // =========================================================================
    // 2. RENDER SECONDARY GRID SECTIONS
    // =========================================================================

    function renderTopbar() {
      if (!refs.topbar) return;
      clearNode(refs.topbar);

      const hasKey = Boolean(KeyStore.get());
      const counts = getCounts();

      const backBtn = el('button', {
        type: 'button',
        className: 'am-btn',
        textContent: '← Back to Grid',
        onClick: function () {
          closeSecondaryGrid();
        }
      });

      const telemetry = el('div', { className: 'am-telemetry-strip', 'aria-label': 'Probe summary' }, [
        el('span', { className: 'am-t-pass', textContent: counts.pass + ' pass' }),
        '·',
        el('span', { className: 'am-t-warn', textContent: counts.warn + ' warn' }),
        '·',
        el('span', { className: 'am-t-fail', textContent: counts.fail + ' fail' }),
        '·',
        el('span', { textContent: counts.idle + ' idle' })
      ]);

      const modelsBtn = el('button', {
        type: 'button',
        className: 'am-btn',
        dataset: { action: 'models' },
        textContent: app.catalog.models.length ? app.catalog.models.length + ' Models' : 'Models (0)',
        title: 'Browse models discovered from GET /v1beta/models',
        onClick: function () {
          openModelsDrawer();
        }
      });

      const keyToggleBtn = el('button', {
        type: 'button',
        className: 'am-btn',
        textContent: hasKey ? 'Key: ' + KeyStore.mask(KeyStore.get()) : '+ API Key',
        onClick: function () {
          app.showKeyEditor = !app.showKeyEditor;
          app.keyPromptNotice = '';
          renderKeybar();
          if (app.showKeyEditor && refs.keyInput) refs.keyInput.focus();
        }
      });

      const runBtn = app.isBatchRunning
        ? el('button', {
            type: 'button',
            className: 'am-btn am-btn--stop',
            textContent: 'Stop (' + app.batchCompleted + '/' + app.batchTotal + ')',
            onClick: cancelAllRuns
          })
        : el('button', {
            type: 'button',
            className: 'am-btn am-btn--primary',
            textContent: 'Run All Probes',
            onClick: function () {
              startBatchRun();
            }
          });

      const copyMdBtn = el('button', {
        type: 'button',
        className: 'am-btn',
        textContent: 'Copy MD',
        title: 'Copy redacted Markdown status report',
        onClick: function () {
          const md = Probes.buildMarkdownSummary(app.results, app.catalog, KeyStore.get());
          copyToClipboard(md)
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
        className: 'am-btn',
        textContent: 'Export JSON',
        title: 'Download redacted JSON report',
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

      refs.topbar.appendChild(
        el('div', { className: 'am-topbar-left' }, [
          backBtn,
          el('div', { className: 'am-heading-group' }, [
            el('span', { className: 'am-index', textContent: '04' }),
            el('h1', { id: 'am-heading', className: 'am-heading', textContent: 'Google Gemini API Matrix' })
          ]),
          telemetry
        ])
      );

      refs.topbar.appendChild(
        el('div', { className: 'am-topbar-right' }, [
          modelsBtn,
          keyToggleBtn,
          copyMdBtn,
          exportJsonBtn,
          runBtn
        ])
      );
    }

    function renderKeybar() {
      if (!refs.keybar) return;
      clearNode(refs.keybar);
      refs.keyInput = null;

      const currentKey = KeyStore.get();
      const storageType = KeyStore.getStorageType();

      const inner = el('div', { className: 'am-keybar-inner' });

      if (currentKey && !app.showKeyEditor) {
        const storageLabel =
          storageType === 'local'
            ? 'Saved on this device (localStorage)'
            : storageType === 'session'
              ? 'Session only (sessionStorage)'
              : 'Memory only';

        inner.appendChild(
          el('div', { className: 'am-keybar-compact' }, [
            el('div', { className: 'am-keybar-status' }, [
              el('span', { className: 'am-status-pill', dataset: { tone: 'pass' }, textContent: '● KEY READY' }),
              el('span', { className: 'am-mono', textContent: KeyStore.mask(currentKey) }),
              el('span', { className: 'am-key-note', textContent: storageLabel + ' · Synced with Cell #1 (Decisions API)' })
            ]),
            el('div', { style: { display: 'flex', gap: '6px' } }, [
              el('button', {
                type: 'button',
                className: 'am-btn am-btn--sm',
                textContent: 'Change Key',
                onClick: function () {
                  app.showKeyEditor = true;
                  renderKeybar();
                  if (refs.keyInput) refs.keyInput.focus();
                }
              }),
              el('button', {
                type: 'button',
                className: 'am-btn am-btn--sm',
                textContent: 'Clear',
                onClick: function () {
                  cancelAllRuns();
                  KeyStore.clear();
                  app.showKeyEditor = true;
                  app.keyPromptNotice = 'Key cleared from browser storage.';
                  renderAll();
                }
              })
            ])
          ])
        );
      } else {
        const keyInput = el('input', {
          type: app.keyVisible ? 'text' : 'password',
          className: 'am-input',
          value: currentKey,
          placeholder: 'Paste Google AI Studio Gemini API key (AIza...)',
          autocomplete: 'off',
          spellcheck: 'false',
          'data-1p-ignore': 'true',
          'data-lpignore': 'true',
          'aria-label': 'Google AI Studio Gemini API key'
        });
        refs.keyInput = keyInput;

        const persistCb = el('input', {
          type: 'checkbox',
          checked: storageType === 'local'
        });

        function saveCurrentKey(andRun) {
          const val = keyInput.value.trim();
          if (!val) {
            app.keyPromptNotice = 'Paste a Gemini API key (AIza...) first.';
            renderKeybar();
            if (refs.keyInput) refs.keyInput.focus();
            return;
          }
          KeyStore.set(val, persistCb.checked);
          app.showKeyEditor = false;
          app.keyVisible = false;
          app.keyPromptNotice = '';
          renderAll();
          if (andRun) startBatchRun();
        }

        const showToggleBtn = el('button', {
          type: 'button',
          className: 'am-btn am-btn--sm',
          textContent: app.keyVisible ? 'Hide' : 'Show',
          onClick: function () {
            app.keyVisible = !app.keyVisible;
            keyInput.type = app.keyVisible ? 'text' : 'password';
            showToggleBtn.textContent = app.keyVisible ? 'Hide' : 'Show';
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
            keyInput,
            showToggleBtn,
            el('label', { className: 'am-checkbox-row' }, [persistCb, 'Remember on this device']),
            el('button', {
              type: 'button',
              className: 'am-btn',
              textContent: 'Save Key',
              onClick: function () {
                saveCurrentKey(false);
              }
            }),
            el('button', {
              type: 'submit',
              className: 'am-btn am-btn--live',
              textContent: 'Save & Run All'
            }),
            currentKey
              ? el('button', {
                  type: 'button',
                  className: 'am-btn am-btn--ghost am-btn--sm',
                  textContent: 'Cancel',
                  onClick: function () {
                    app.showKeyEditor = false;
                    app.keyPromptNotice = '';
                    renderKeybar();
                  }
                })
              : null
          ]
        );

        const note = el('p', { className: 'am-key-note' }, [
          'Browser requests go directly to ',
          el('code', { className: 'am-mono', textContent: 'generativelanguage.googleapis.com' }),
          ' via ',
          el('code', { className: 'am-mono', textContent: 'x-goog-api-key' }),
          ' (synced with Cell #1). Antigravity logins do not expose a raw API key — create one at ',
          el('a', {
            href: 'https://aistudio.google.com/apikey',
            target: '_blank',
            rel: 'noopener noreferrer',
            textContent: 'aistudio.google.com/apikey'
          }),
          '. Keys are redacted in all cURL/JSON exports.'
        ]);

        inner.appendChild(form);
        if (KeyStore.isStorageRestricted()) {
          inner.appendChild(
            el('div', {
              className: 'am-key-note',
              textContent: 'Browser storage is restricted on this origin — key will stay in memory for this page session only.'
            })
          );
        }
        if (app.keyPromptNotice) {
          inner.appendChild(el('div', { className: 'am-inline-alert', role: 'alert', textContent: app.keyPromptNotice }));
        }
        inner.appendChild(note);
      }

      refs.keybar.appendChild(inner);
    }

    function renderFilterBar() {
      if (!refs.filterBar) return;
      clearNode(refs.filterBar);

      const filterGroup = el('div', { className: 'am-filters', role: 'group', 'aria-label': 'Filter endpoints' });
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
              'aria-pressed': String(app.filter === f.id),
              onClick: function () {
                app.filter = f.id;
                renderFilterBar();
                renderSecondaryGridCards();
              }
            },
            [f.label, el('span', { className: 'am-filter-count', textContent: String(count) })]
          )
        );
      });

      const groundingCb = el('input', {
        type: 'checkbox',
        checked: app.includeGrounding,
        onChange: function (e) {
          app.includeGrounding = e.target.checked;
        }
      });

      const controls = el('div', { className: 'am-filter-controls' }, [
        el('label', {
          className: 'am-checkbox-row',
          title: 'Google Search Grounding may incur per-query search fees on paid API tiers.'
        }, [groundingCb, 'Include Search Grounding in Run All']),
        el('button', {
          type: 'button',
          className: 'am-btn am-btn--sm',
          textContent: 'Reset Results',
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

    function renderSecondaryGridCards() {
      if (!refs.gridContainer) return;
      clearNode(refs.gridContainer);

      const filtered = getFilteredEndpoints();
      if (!filtered.length) {
        refs.gridContainer.appendChild(
          el('div', { className: 'am-empty-filter' }, [
            el('div', { textContent: 'No endpoints match the "' + app.filter + '" filter.' }),
            el('button', {
              type: 'button',
              className: 'am-btn',
              textContent: 'Show All ' + Probes.ENDPOINTS.length,
              onClick: function () {
                app.filter = 'all';
                renderFilterBar();
                renderSecondaryGridCards();
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

        let pillText = hasKey ? 'IDLE' : 'KEY REQ';
        if (isProbing) pillText = 'PROBING';
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
                el('span', { className: 'am-tag', textContent: ep.protocol }),
                el('span', { className: 'am-tag', textContent: ep.code }),
                ep.costTier === 'opt-in'
                  ? el('span', { className: 'am-tag am-tag--cost-optin', textContent: 'OPT-IN GEN' })
                  : ep.costTier === 'metered'
                    ? el('span', { className: 'am-tag am-tag--cost-optin', textContent: 'METERED' })
                    : null
              ]),
              el('span', {
                className: 'am-status-pill',
                dataset: { tone: status },
                textContent: statusSymbol(status) + ' ' + pillText
              })
            ]),
            el('div', { className: 'am-api-mid' }, [
              el('div', { className: 'am-api-name', textContent: ep.name }),
              el('div', { className: 'am-api-model', textContent: modelLine, title: modelLine })
            ]),
            el('div', { className: 'am-api-summary', textContent: summaryLine, title: summaryLine }),
            el('div', { className: 'am-api-foot' }, [
              el('div', { className: 'am-latency-wrap' }, [
                el('span', { className: 'am-latency-val', textContent: latencyText }),
                barPct > 0
                  ? el('div', { className: 'am-latency-track', 'aria-hidden': 'true' }, [
                      el('div', { className: 'am-latency-fill', style: { width: barPct + '%' } })
                    ])
                  : null
              ]),
              el('div', { className: 'am-api-actions' }, [
                el('button', {
                  type: 'button',
                  className: 'am-btn am-btn--sm',
                  disabled: isProbing || app.isBatchRunning,
                  textContent: isProbing ? '…' : 'Test',
                  'aria-label': 'Test ' + ep.name,
                  onClick: function (e) {
                    e.stopPropagation();
                    runSingleEndpoint(ep.id, false);
                  }
                }),
                el('button', {
                  type: 'button',
                  className: 'am-btn am-btn--sm am-btn--ghost am-inspect-btn',
                  textContent: 'Inspect →',
                  'aria-label': 'Inspect ' + ep.name,
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
      stopActiveAudio();

      if (!app.drawerMode) {
        refs.scrim.hidden = true;
        if (refs.mainWrap) refs.mainWrap.inert = false;
        clearNode(refs.drawer);
        return;
      }

      refs.scrim.hidden = false;
      if (refs.mainWrap) refs.mainWrap.inert = true;
      clearNode(refs.drawer);

      if (app.drawerMode === 'models') {
        renderModelsDrawerContent();
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
        className: 'am-btn am-btn--sm',
        dataset: { nav: 'prev' },
        disabled: !prevEp,
        'aria-label': 'Previous endpoint',
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
        className: 'am-btn am-btn--sm',
        dataset: { nav: 'next' },
        disabled: !nextEp,
        'aria-label': 'Next endpoint',
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
          el('span', { className: 'am-tag', textContent: ep.code }),
          el('h2', { id: 'am-drawer-title', className: 'am-drawer-title', tabindex: '-1', textContent: ep.name })
        ]),
        el('div', { className: 'am-drawer-nav' }, [
          prevBtn,
          nextBtn,
          el('button', {
            type: 'button',
            className: 'am-btn am-btn--sm am-btn--primary',
            disabled: isProbing || app.isBatchRunning,
            textContent: isProbing ? 'Running…' : 'Re-test',
            onClick: function () {
              runSingleEndpoint(ep.id, false);
            }
          }),
          el('button', {
            type: 'button',
            className: 'am-btn am-btn--sm am-btn--ghost',
            'aria-label': 'Close Inspector',
            textContent: '×',
            onClick: closeDrawer
          })
        ])
      ]);

      const body = el('div', { className: 'am-drawer-body' });

      // Status & Remediation Callout
      const callout = el('div', { className: 'am-callout', dataset: { tone: status } }, [
        el('div', { className: 'am-callout-head' }, [
          el('span', { textContent: isProbing ? 'Probing live endpoint…' : res ? statusSymbol(status) + ' ' + res.badge : 'Not tested yet' }),
          el('span', {
            className: 'am-mono',
            textContent: res && res.httpStatus ? (ep.protocol === 'WSS' ? 'WS ' + res.httpStatus : 'HTTP ' + res.httpStatus) : ep.protocol
          })
        ]),
        el('div', { textContent: isProbing ? (app.statusNotes[ep.id] || 'Waiting for response…') : res ? res.summary : ep.description }),
        res && res.remediation
          ? el('div', { style: { fontWeight: '600' }, textContent: 'Next step: ' + res.remediation })
          : null
      ]);
      body.appendChild(callout);

      // Opt-in live Image Generation control
      if (ep.supportsLiveGen) {
        body.appendChild(
          el('div', { className: 'am-callout', dataset: { tone: 'warn' } }, [
            el('div', { className: 'am-callout-head' }, [
              el('span', { textContent: 'Opt-In Live Image Generation' }),
              el('button', {
                type: 'button',
                className: 'am-btn am-btn--sm am-btn--primary',
                disabled: isProbing || app.isBatchRunning,
                textContent: isProbing ? 'Generating…' : 'Run Live Image Gen',
                onClick: function () {
                  runSingleEndpoint(ep.id, true);
                }
              })
            ]),
            el('div', {
              textContent:
                'Batch Run All checks model metadata for $0. Click "Run Live Image Gen" to execute a real image render on ' +
                (res && res.modelUsed ? res.modelUsed : 'the discovered image model') +
                '.'
            })
          ])
        );
      }

      // Live TTS Audio Playback Stage
      if (res && res.audioMedia && app.objectUrls[ep.id]) {
        const audioUrl = app.objectUrls[ep.id];
        const audioEl = el('audio', { controls: true, preload: 'auto', src: audioUrl });
        app.activeAudioEl = audioEl;
        body.appendChild(
          el('div', { className: 'am-media-stage' }, [
            el('div', { className: 'am-code-bar' }, [
              el('span', { className: 'am-meta-label', textContent: 'Live Synthesized Audio (' + res.audioMedia.sourceMimeType + ' → WAV)' }),
              el('a', {
                className: 'am-btn am-btn--sm',
                href: audioUrl,
                download: 'gemini-tts-probe.wav',
                style: { textDecoration: 'none' },
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
            el('span', { className: 'am-meta-label', textContent: 'Opt-in live probe output (' + res.imageMedia.mimeType + ')' }),
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
            el('span', { className: 'am-meta-label', textContent: 'Model Tested' }),
            el('span', { className: 'am-meta-val', textContent: (res && res.modelUsed) || 'Auto-discovered / N/A' })
          ]),
          el('div', { className: 'am-meta-cell' }, [
            el('span', { className: 'am-meta-label', textContent: 'Latency' }),
            el('span', { className: 'am-meta-val', textContent: res && res.latencyMs ? res.latencyMs + ' ms' : '—' })
          ]),
          el('div', { className: 'am-meta-cell' }, [
            el('span', { className: 'am-meta-label', textContent: 'Cost Tier / Category' }),
            el('span', { className: 'am-meta-val', textContent: ep.costTier + ' · ' + ep.category })
          ])
        ])
      );

      // Matching Discovered Models
      if (res && Array.isArray(res.discoveredModels) && res.discoveredModels.length > 0) {
        body.appendChild(
          el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, [
            el('span', { className: 'am-meta-label', textContent: 'Matching Models on This Key' }),
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
      const codeSection = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });

      function renderDrawerCodeSection(focusTabId) {
        clearNode(codeSection);
        const tabs = el('div', { className: 'am-tabs', role: 'tablist' }, [
          ['curl', 'Redacted cURL'],
          ['raw', 'Raw Response']
        ].map(function (entry) {
          return el('button', {
            type: 'button',
            role: 'tab',
            className: 'am-tab-btn',
            dataset: { tabId: entry[0] },
            'aria-selected': String(app.drawerTab === entry[0]),
            textContent: entry[1],
            onClick: function () {
              app.drawerTab = entry[0];
              renderDrawerCodeSection(entry[0]);
            }
          });
        }));

        const codeText =
          app.drawerTab === 'curl'
            ? Probes.redactSecrets((res && res.curl) || '# Run this probe to generate the exact cURL command.', KeyStore.get())
            : Probes.redactSecrets(res && res.raw ? JSON.stringify(res.raw, null, 2) : '{}', KeyStore.get());

        const copyBtn = el('button', {
          type: 'button',
          className: 'am-btn am-btn--sm',
          textContent: app.drawerTab === 'curl' ? 'Copy cURL' : 'Copy JSON',
          onClick: function () {
            copyToClipboard(codeText)
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

        codeSection.appendChild(tabs);
        codeSection.appendChild(
          el('div', { className: 'am-code-bar' }, [
            el('span', {
              className: 'am-key-note',
              textContent: app.drawerTab === 'curl' ? 'API key always redacted as $GEMINI_API_KEY.' : 'Base64 media payloads truncated for responsiveness.'
            }),
            copyBtn
          ])
        );
        codeSection.appendChild(el('pre', { className: 'am-pre', textContent: codeText }));

        if (focusTabId) {
          const tabEl = codeSection.querySelector('[data-tab-id="' + focusTabId + '"]');
          if (tabEl) tabEl.focus();
        }
      }

      renderDrawerCodeSection(null);
      body.appendChild(codeSection);

      refs.drawer.appendChild(head);
      refs.drawer.appendChild(body);

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
          el('span', { className: 'am-tag', textContent: 'CATALOG' }),
          el('h2', {
            id: 'am-drawer-title',
            className: 'am-drawer-title',
            tabindex: '-1',
            textContent: 'Discovered Models (' + models.length + ')'
          })
        ]),
        el('div', { className: 'am-drawer-nav' }, [
          el('button', {
            type: 'button',
            className: 'am-btn am-btn--sm am-btn--primary',
            disabled: Boolean(app.probing.models) || app.isBatchRunning,
            textContent: app.probing.models ? 'Loading…' : 'Refresh',
            onClick: function () {
              runSingleEndpoint('models', false);
            }
          }),
          el('button', {
            type: 'button',
            className: 'am-btn am-btn--sm am-btn--ghost',
            'aria-label': 'Close Models Browser',
            textContent: '×',
            onClick: closeDrawer
          })
        ])
      ]);

      const body = el('div', { className: 'am-drawer-body' });
      const searchInput = el('input', {
        type: 'search',
        className: 'am-input',
        style: { maxWidth: 'none' },
        value: app.modelSearch,
        placeholder: 'Filter models by ID or method (e.g. tts, live, veo, embedContent)…',
        'aria-label': 'Filter discovered models'
      });

      const listWrap = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });

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
              el('div', { textContent: 'Run "Models Catalog" or "Run All Probes" to populate models enabled on this key.' })
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
                  ? el('span', { className: 'am-mono', style: { fontSize: '10px', color: 'var(--am-ink-3)' }, textContent: 'in ' + m.inputTokenLimit.toLocaleString() })
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
      renderPrimaryCell();
      if (dialog.open) {
        renderTopbar();
        renderFilterBar();
        renderSecondaryGridCards();
        if (app.drawerMode === 'endpoint' && (!changedId || app.selectedEndpointId === changedId)) {
          renderDrawer();
        } else if (app.drawerMode === 'models' && changedId === 'models') {
          const prevSearch = refs.drawer && refs.drawer.querySelector('input[type="search"]');
          const wasFocused = prevSearch && document.activeElement === prevSearch;
          const selStart = wasFocused ? prevSearch.selectionStart : null;
          renderDrawer();
          if (wasFocused) {
            const nextSearch = refs.drawer && refs.drawer.querySelector('input[type="search"]');
            if (nextSearch) {
              nextSearch.focus();
              if (typeof selStart === 'number') {
                try { nextSearch.setSelectionRange(selStart, selStart); } catch (_e) {}
              }
            }
          }
        }
      }
      syncRunningClass();
    }

    function renderAll() {
      renderPrimaryCell();
      if (dialog.open) {
        renderTopbar();
        renderKeybar();
        renderFilterBar();
        renderSecondaryGridCards();
        if (app.drawerMode) renderDrawer();
      }
      syncRunningClass();
    }

    // =========================================================================
    // 4. PROBE EXECUTION (SINGLE & STAGED BATCH)
    // =========================================================================

    function requireKeyOrPrompt() {
      const key = KeyStore.get();
      if (key) return key;
      app.showKeyEditor = true;
      app.keyPromptNotice = 'Paste your Google AI Studio Gemini API key first to run live tests.';
      renderKeybar();
      if (refs.keyInput) refs.keyInput.focus();
      announce('API key required before running probes.');
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
          if (dialog.open) {
            renderSecondaryGridCards();
            if (app.drawerMode === 'endpoint' && app.selectedEndpointId === endpointId) renderDrawer();
          }
        }
      })
        .then(function (result) {
          if (seq !== app.runSeq) return;
          delete app.probing[endpointId];
          delete app.singleAborts[endpointId];
          delete app.statusNotes[endpointId];
          storeProbeResult(endpointId, result);
          renderProgressUpdate(endpointId);
          announce(endpointId + ' probe finished: ' + result.badge + '.');
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
          if (dialog.open) {
            renderSecondaryGridCards();
            if (app.drawerMode === 'endpoint' && app.selectedEndpointId === id) renderDrawer();
          }
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
            app.keyPromptNotice = 'Key rejected by /v1beta/models — halted remaining probes to avoid redundant failures.';
            renderKeybar();
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
          renderKeybar();
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

    function closeDrawer() {
      const target = app.drawerReturnTarget;
      stopActiveAudio();
      app.drawerMode = null;
      app.drawerReturnTarget = null;
      renderSecondaryGridCards();
      renderDrawer();
      if (target && target.type === 'endpoint' && refs.gridContainer) {
        const cardBtn = refs.gridContainer.querySelector('[data-endpoint-id="' + target.id + '"] .am-inspect-btn');
        if (cardBtn) cardBtn.focus();
      } else if (target && target.type === 'models' && refs.topbar) {
        const modelsBtn = refs.topbar.querySelector('[data-action="models"]');
        if (modelsBtn) modelsBtn.focus();
      }
    }

    function openSecondaryGrid(opts) {
      const fromDeepLink = Boolean(opts && opts.fromDeepLink);
      app.openedFromGrid = !fromDeepLink && location.hash !== '#api-matrix';
      app.showKeyEditor = !KeyStore.get();
      app.keyPromptNotice = '';

      if (!refs.topbar) buildDialogShell();
      if (!dialog.open) dialog.showModal();

      if (!fromDeepLink && location.hash !== '#api-matrix' && history && typeof history.pushState === 'function') {
        try {
          history.pushState({ amView: true }, '', '#api-matrix');
        } catch (_e) {}
      }

      renderAll();
    }

    function closeSecondaryGridInternal() {
      stopActiveAudio();
      app.drawerMode = null;
      app.drawerReturnTarget = null;
      if (refs.mainWrap) refs.mainWrap.inert = false;
      if (dialog.open) dialog.close();
      renderPrimaryCell();
      const triggerEl = rootEl.querySelector('.am-cell-trigger');
      if (triggerEl && typeof triggerEl.focus === 'function') {
        triggerEl.focus();
      }
    }

    function closeSecondaryGrid() {
      if (app.openedFromGrid && location.hash === '#api-matrix' && history && typeof history.back === 'function') {
        app.openedFromGrid = false;
        history.back();
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
      e.preventDefault();
      if (app.drawerMode) {
        closeDrawer();
      } else {
        closeSecondaryGrid();
      }
    });

    // Fallback cleanup if browser closes <dialog> natively without firing cancel.
    dialog.addEventListener('close', function () {
      stopActiveAudio();
      app.drawerMode = null;
      if (refs.mainWrap) refs.mainWrap.inert = false;
      if (location.hash === '#api-matrix' && history && typeof history.replaceState === 'function') {
        try { history.replaceState(null, '', location.pathname + location.search); } catch (_e) {}
      }
      renderPrimaryCell();
    });

    dialog.addEventListener('keydown', function (e) {
      if (app.drawerMode !== 'endpoint') return;
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
      if (location.hash === '#api-matrix') {
        if (!dialog.open) openSecondaryGrid({ fromDeepLink: true });
      } else if (dialog.open) {
        closeSecondaryGridInternal();
      }
    }

    global.addEventListener('hashchange', syncHashState);
    global.addEventListener('popstate', syncHashState);
    global.addEventListener('gemini-key-changed', renderAll);
    global.addEventListener('storage', renderAll);
    global.addEventListener('focus', function () {
      if (!dialog.open) renderPrimaryCell();
    });
    global.addEventListener('beforeunload', revokeAllMediaUrls);

    renderPrimaryCell();
    if (location.hash === '#api-matrix') {
      openSecondaryGrid({ fromDeepLink: true });
    }
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
