(function (global) {
  'use strict';

  function resizeImageFileToBase64(file, maxDim) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read file')); };
      reader.onload = function () {
        const img = new Image();
        img.onerror = function () { reject(new Error('Invalid image file')); };
        img.onload = function () {
          const limit = maxDim || 768;
          const scale = Math.min(1, limit / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = c.toDataURL('image/jpeg', 0.86);
          const base64 = dataUrl.split(',')[1] || '';
          resolve({ dataUrl: dataUrl, base64Data: base64, mimeType: 'image/jpeg', name: file.name || 'image.jpg' });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Larger files are refused before FileReader loads them whole into memory.
  const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
  const DISCOVERY_TIMEOUT_MS = 10000;
  // Per-view state readout tips (ui.js setSlotState); done / failed tips carry the details.
  const META_TIPS = {
    waiting: 'No result yet; Run sends the image to this model.',
    running: 'Seconds since this request was sent.',
    stopped: 'This request was stopped before it answered.',
    failed: 'This model failed; the reason is shown in the view.',
    done: 'Seconds to answer and number of primitive parts (p).'
  };
  const KEY_STORAGE_NAMES =['dc_gemini_api_key_session', 'dc_gemini_api_key_local'];

  // Model-list discovery (GET /models, sends the key) is shared by every tile on the page and
  // runs at most once per key, only from an explicit Run click. It never runs on load, on key
  // sync or on image drop, and it only adds dropdown options: the models in the slots at click
  // time are the models that get billed.
  const discovery = { key: '', promise: null };
  function discoverModelsOnce(Client, key) {
    if (discovery.promise && discovery.key === key) return discovery.promise;
    discovery.key = key;
    // Bounded: a GET that never answers is aborted after DISCOVERY_TIMEOUT_MS and settles to
    // the defaults. A failed discovery is not retried for that key until reload.
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? global.setTimeout(function () { ctrl.abort(); }, DISCOVERY_TIMEOUT_MS) : null;
    const promise = Promise.resolve()
      .then(function () { return Client.discoverModels(key, ctrl && ctrl.signal); })
      .catch(function () { return null; })
      .then(function (info) {
        if (timer) global.clearTimeout(timer);
        return info;
      });
    discovery.promise = promise;
    return promise;
  }

  function mergeIds(base, extra) {
    const out = base.slice();
    (extra || []).forEach(function (id) {
      if (id && out.indexOf(id) < 0) out.push(id);
    });
    return out;
  }

  function mountImageTo3DCell(root, cellIndex) {
    const NS = global.GeminiImageTo3D;
    if (!root || !NS || !NS.Client || !NS.Renderer) return;

    const Client = NS.Client;
    const Renderer = NS.Renderer;

    root.classList.add('ui-tile');
    const SLOT_LABEL = Client.DEFAULT_MODELS.length;
    root.innerHTML = [
      '<header class="ui-tile-head">',
      '  <span class="ui-tile-index">' + cellIndex + '</span>',
      '  <h2 class="ui-tile-title">Image → 3D</h2>',
      '  <div class="ui-tile-actions">',
      '    <button type="button" class="ui-pill i3d-key-btn" aria-expanded="false">',
      '      <span class="ui-pill-label">No key</span>',
      '    </button>',
      '    <button type="button" class="ui-btn ui-btn--sm i3d-sync-btn ui-hide-tiny" aria-pressed="true">Sync</button>',
      '    <button type="button" class="ui-btn ui-btn--sm i3d-expand-btn ui-hide-tiny"',
      '      data-tip="Open the ' + SLOT_LABEL + ' views large, side by side, in a dialog.">' + SLOT_LABEL + '-Up</button>',
      '  </div>',
      '</header>',
      '<div class="i3d-key-bar" hidden>',
      '  <input type="password" class="i3d-key-input" placeholder="Paste Gemini API key (AIza...)" autocomplete="off" spellcheck="false" aria-label="Gemini API key">',
      '  <label class="i3d-key-persist ui-hide-tiny" data-tip="Keep the key after this tab closes, stored in this browser.">',
      '    <input type="checkbox" class="i3d-key-persist-cb" checked> Remember</label>',
      '  <button type="button" class="ui-btn ui-btn--sm i3d-key-save" data-tip="Use this key here and in the other Gemini tiles." data-tip-key="Enter">Save</button>',
      '  <button type="button" class="ui-btn ui-btn--sm ui-btn--quiet i3d-key-clear ui-hide-tiny" data-tip="Remove the saved key from every Gemini tile.">Clear</button>',
      '</div>',
      '<div class="ui-tile-body i3d-body">',
      '  <div class="i3d-arena"></div>',
      '</div>',
      '<div class="i3d-bar">',
      '  <div class="i3d-dropbar" role="button" tabindex="0" aria-label="Choose an image"',
      '    data-tip="Choose an image file; you can also drop one on the tile or paste it here.">',
      '    <img class="i3d-thumb" alt="" hidden>',
      '    <span class="i3d-drop-text">Drop, paste or choose an image</span>',
      '    <input type="file" class="i3d-file-input" accept="image/*" tabindex="-1" aria-hidden="true">',
      '  </div>',
      '  <span class="i3d-status ui-truncate ui-hide-compact" role="status">No image yet</span>',
      '  <button type="button" class="ui-btn ui-btn--sm ui-btn--primary i3d-run-btn" aria-disabled="true">Run ' + SLOT_LABEL + '×</button>',
      '</div>',
      '<dialog class="ui-dialog i3d-dialog" aria-label="Tile ' + cellIndex + ': ' + SLOT_LABEL + ' models side by side">',
      '  <header class="ui-studio-bar">',
      '    <span class="ui-tile-index">' + cellIndex + '</span>',
      '    <h2 class="ui-studio-title">Image → 3D</h2>',
      '    <div class="ui-studio-actions">',
      '      <button type="button" class="ui-btn i3d-dialog-rerun">Re-run ' + SLOT_LABEL + '×</button>',
      '      <button type="button" class="ui-btn i3d-dialog-close" data-tip="Back to the grid." data-tip-key="Esc">Close</button>',
      '    </div>',
      '  </header>',
      '  <div class="i3d-dialog-arena"></div>'
      + '</dialog>'
    ].join('\n');

    const syncBtn = root.querySelector('.i3d-sync-btn');
    const expandBtn = root.querySelector('.i3d-expand-btn');
    const keyBtn = root.querySelector('.i3d-key-btn');
    const keyBar = root.querySelector('.i3d-key-bar');
    const keyInput = root.querySelector('.i3d-key-input');
    const keyPersist = root.querySelector('.i3d-key-persist-cb');
    const keySaveBtn = root.querySelector('.i3d-key-save');
    const keyClearBtn = root.querySelector('.i3d-key-clear');
    const dropbar = root.querySelector('.i3d-dropbar');
    const thumbEl = root.querySelector('.i3d-thumb');
    const dropText = root.querySelector('.i3d-drop-text');
    const fileInput = root.querySelector('.i3d-file-input');
    const runBtn = root.querySelector('.i3d-run-btn');
    const arenaEl = root.querySelector('.i3d-arena');
    const statusEl = root.querySelector('.i3d-status');
    const dialog = root.querySelector('.i3d-dialog');
    const dialogArena = root.querySelector('.i3d-dialog-arena');
    const dialogRerun = root.querySelector('.i3d-dialog-rerun');
    const dialogClose = root.querySelector('.i3d-dialog-close');

    let models = Client.DEFAULT_MODELS.slice();
    const SLOT_COUNT = models.length;
    let availableModels = Client.DEFAULT_MODELS.slice();
    let currentImage = null;
    let imageSeq = 0;
    let syncOrbit = true;
    // One run per tile. A cancelled or replaced run must not write over the run after it.
    let activeRun = null;
    let tickerId = null;
    const slotStates = models.map(function () { return null; });

    function buildSlots(container) {
      container.innerHTML = '';
      return models.map(function (modelId, idx) {
        const slot = document.createElement('div');
        slot.className = 'i3d-slot';
        slot.setAttribute('data-state', 'waiting');
        // Model and state are laid over the well so the canvas gets all of it.
        slot.innerHTML = [
          '<div class="i3d-canvas-wrap" data-tip="Drag to orbit; pinch or Ctrl+scroll to zoom.">',
          '  <canvas class="i3d-canvas"></canvas>',
          '  <div class="i3d-slot-overlay" hidden>',
          '    <div class="i3d-spinner" hidden></div>',
          '    <span class="i3d-slot-msg"></span>',
          '  </div>',
          '</div>',
          '<div class="i3d-slot-head">',
          '  <select class="i3d-model-select" aria-label="Tile ' + cellIndex + ' view ' + (idx + 1) + ' model"></select>',
          '  <span class="i3d-slot-meta" data-tip="' + META_TIPS.waiting + '">waiting</span>',
          '  <button type="button" class="ui-btn ui-btn--sm ui-btn--quiet i3d-obj-btn" hidden',
          '    aria-label="Download view ' + (idx + 1) + ' mesh as OBJ" data-tip="Download this mesh as a Wavefront .obj file for 3D tools.">OBJ</button>',
          '</div>',
          '<span class="i3d-slot-title"></span>'
        ].join('\n');
        container.appendChild(slot);

        const selectEl = slot.querySelector('.i3d-model-select');
        const metaEl = slot.querySelector('.i3d-slot-meta');
        const canvas = slot.querySelector('.i3d-canvas');
        const overlay = slot.querySelector('.i3d-slot-overlay');
        const spinner = slot.querySelector('.i3d-spinner');
        const msgEl = slot.querySelector('.i3d-slot-msg');
        const titleEl = slot.querySelector('.i3d-slot-title');
        const objBtn = slot.querySelector('.i3d-obj-btn');

        selectEl.addEventListener('change', function () {
          models[idx] = selectEl.value;
          updateSlotPair(idx, function (s) { s.selectEl.value = models[idx]; });
          renderModelTips();
        });

        const viewer = Renderer.createViewer(canvas, {
          onOrbit: function (cam) {
            if (!syncOrbit) return;
            syncAllViewers(cam, viewer);
          }
        });

        objBtn.addEventListener('click', function () {
          const st = slotStates[idx];
          if (!st || !st.mesh) return;
          const objText = Renderer.exportMeshToOBJ(st.mesh, st.scene && st.scene.title);
          const blob = new Blob([objText], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = String(st.model || models[idx]).replace(/[^a-z0-9.-]/gi, '_') + '.obj';
          a.click();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        });

        return {
          idx: idx,
          slot: slot,
          selectEl: selectEl,
          metaEl: metaEl,
          overlay: overlay,
          spinner: spinner,
          msgEl: msgEl,
          titleEl: titleEl,
          objBtn: objBtn,
          viewer: viewer
        };
      });
    }

    let tileSlots = buildSlots(arenaEl);
    let dialogSlots = buildSlots(dialogArena);

    function syncAllViewers(cam, sourceViewer) {
      tileSlots.concat(dialogSlots).forEach(function (s) {
        if (s.viewer !== sourceViewer) s.viewer.setCamera(cam);
      });
    }

    function updateSlotPair(idx, fn) {
      if (tileSlots[idx]) fn(tileSlots[idx]);
      if (dialogSlots[idx]) fn(dialogSlots[idx]);
    }

    function applyModelOptions() {
      models.forEach(function (m, idx) {
        updateSlotPair(idx, function (s) {
          s.selectEl.innerHTML = '';
          // A list refresh never drops the model a slot is set to.
          const ids = availableModels.indexOf(m) >= 0 ? availableModels : [m].concat(availableModels);
          const shortCount = Object.create(null);
          ids.forEach(function (id) { const k = shortModelName(id); shortCount[k] = (shortCount[k] || 0) + 1; });
          ids.forEach(function (optId) {
            const opt = document.createElement('option');
            opt.value = optId;
            // Short name in the narrow well; the full id where two short names would collide.
            const short = shortModelName(optId);
            opt.textContent = shortCount[short] > 1 ? optId : short;
            s.selectEl.appendChild(opt);
          });
          s.selectEl.value = m;
        });
      });
      renderModelTips();
    }

    // "gemini-4-hydrogen" -> "Hydrogen", "gemini-3.1-flash-lite-preview" -> "3.1 Flash Lite".
    function shortModelName(id) {
      const core = String(id).replace(/^gemini-/, '').replace(/-preview$/, '');
      const gen4 = core.match(/^4-([a-z]+)$/i);
      const words = (gen4 ? gen4[1] : core).split('-');
      return words.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
    }

    // The select shows a short name; its tip carries the exact model id that will be billed.
    function renderModelTips() {
      models.forEach(function (m, idx) {
        updateSlotPair(idx, function (s) {
          s.selectEl.setAttribute('data-tip', m + ': the model this view sends to on the next Run.');
        });
      });
    }

    // Status pill: grey for no key / key set, rust while running or after a run with no
    // result, green only after a run returned at least one mesh. Click opens the key bar.
    let phase = 'idle'; // idle | busy | error | done
    const PILL = {
      nokey: { label: 'No key', tone: '', tip: 'No Gemini API key yet. Click to paste one; the Gemini tiles share it.' },
      idle: { label: 'Key set', tone: '', tip: 'Key saved; Run is ready once an image is in. Click to replace or clear it.' },
      busy: { label: 'Running', tone: 'attention', tip: 'Waiting for the models; Run is now Stop. Click to manage the key.' },
      error: { label: 'Error', tone: 'attention', tip: 'No model returned a mesh; each view shows why. Click to manage the key.' },
      done: { label: 'Done', tone: 'ok', tip: 'At least one model returned a mesh. Click to manage the key.' }
    };

    function refreshKeyState() {
      const hasKey = Boolean(Client.KeyStore.get());
      const state = phase === 'busy' ? PILL.busy : (!hasKey ? PILL.nokey : PILL[phase]);
      if (state.tone) keyBtn.setAttribute('data-tone', state.tone);
      else keyBtn.removeAttribute('data-tone');
      keyBtn.querySelector('.ui-pill-label').textContent = state.label;
      keyBtn.setAttribute('aria-label', 'API key, status ' + state.label);
      keyBtn.setAttribute('data-tip', state.tip);
    }

    function setPhase(next) {
      phase = next;
      refreshKeyState();
    }

    function renderSyncTip() {
      syncBtn.setAttribute('data-tip', syncOrbit
        ? 'On: orbiting one view turns all ' + SLOT_COUNT + ' here. Click to orbit each view alone.'
        : 'Off: each view orbits alone. Click to turn all ' + SLOT_COUNT + ' views together.');
    }

    function renderRunTips(running) {
      const runTip = running
        ? 'Stop waiting and abort the requests still open.'
        : (currentImage
          ? 'Send this image to all ' + SLOT_COUNT + ' models: ' + SLOT_COUNT + ' paid requests on your key.'
          : 'Add an image first; Run then sends it to all ' + SLOT_COUNT + ' models.');
      runBtn.setAttribute('data-tip', runTip);
      dialogRerun.setAttribute('data-tip', runTip);
      if (running || currentImage) runBtn.removeAttribute('aria-disabled');
      else runBtn.setAttribute('aria-disabled', 'true');
      runBtn.setAttribute('aria-pressed', String(Boolean(running)));
    }

    function setSlotState(s, state, metaText, metaTip) {
      s.slot.setAttribute('data-state', state);
      s.metaEl.textContent = metaText;
      s.metaEl.setAttribute('data-tip', metaTip || META_TIPS[state]);
    }

    // Adds discovered models to the dropdowns; never changes the model a slot is set to.
    function mergeDiscovered(info) {
      if (!info || !Array.isArray(info.available) || !info.available.length) return;
      availableModels = mergeIds(availableModels, info.available);
      applyModelOptions();
    }

    function setRunUi(running) {
      runBtn.textContent = running ? 'Stop' : 'Run ' + SLOT_COUNT + '×';
      dialogRerun.textContent = running ? 'Stop' : 'Re-run ' + SLOT_COUNT + '×';
      tileSlots.concat(dialogSlots).forEach(function (s) { s.selectEl.disabled = running; });
      renderRunTips(running);
    }

    // One elapsed-time ticker per tile, only while a run is in flight and the tab is visible.
    function paintElapsed() {
      const run = activeRun;
      if (!run) return;
      for (let idx = 0; idx < SLOT_COUNT; idx++) {
        if (run.done[idx]) continue;
        const sec = ((Date.now() - run.t0) / 1000).toFixed(1) + 's';
        updateSlotPair(idx, function (s) { s.metaEl.textContent = sec; });
      }
    }

    function stopTicker() {
      if (tickerId) global.clearInterval(tickerId);
      tickerId = null;
    }

    function startTicker() {
      stopTicker();
      if (!activeRun || document.visibilityState === 'hidden') return;
      paintElapsed();
      tickerId = global.setInterval(paintElapsed, 100);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') stopTicker();
      else if (activeRun) startTicker();
    });

    function paintSlotStopped(idx, msg) {
      updateSlotPair(idx, function (s) {
        setSlotState(s, 'stopped', 'stopped');
        s.overlay.className = 'i3d-slot-overlay';
        s.overlay.hidden = false;
        s.spinner.hidden = true;
        s.msgEl.className = 'i3d-slot-msg';
        s.msgEl.textContent = msg;
      });
    }

    function cancelRun(statusText, slotText) {
      const run = activeRun;
      if (!run) return;
      activeRun = null;
      stopTicker();
      run.controller.abort();
      for (let idx = 0; idx < SLOT_COUNT; idx++) {
        if (!run.done[idx]) paintSlotStopped(idx, slotText || 'Cancelled');
      }
      setRunUi(false);
      setPhase(run.ok > 0 ? 'done' : 'idle');
      statusEl.textContent = statusText;
    }

    async function runAllFour() {
      if (activeRun) {
        cancelRun('Cancelled');
        return;
      }

      const key = Client.KeyStore.get();
      if (!key) {
        keyBar.hidden = false;
        keyBtn.setAttribute('aria-expanded', 'true');
        keyInput.focus();
        statusEl.textContent = 'Add a Gemini API key first';
        return;
      }
      if (!Client.isHeaderSafeKey(key)) {
        statusEl.textContent = 'The saved key has spaces or non-ASCII characters; paste it again';
        return;
      }
      if (!currentImage) {
        statusEl.textContent = 'Drop or pick an image first';
        return;
      }

      const run = {
        controller: new AbortController(),
        t0: Date.now(),
        done: models.map(function () { return false; }),
        ok: 0,
        image: currentImage
      };
      activeRun = run;
      const signal = run.controller.signal;
      setRunUi(true);
      setPhase('busy');
      statusEl.textContent = 'Running ' + SLOT_COUNT + ' Gemini models in parallel...';
      discoverModelsOnce(Client, key).then(mergeDiscovered);

      let doneCount = 0;
      const jobs = models.map(function (modelId, idx) {
        slotStates[idx] = null;
        // Running: rust well edge and a live elapsed readout; no spinner loop.
        updateSlotPair(idx, function (s) {
          setSlotState(s, 'running', '0.0s');
          s.overlay.className = 'i3d-slot-overlay';
          s.overlay.hidden = true;
          s.spinner.hidden = true;
          s.msgEl.className = 'i3d-slot-msg';
          s.msgEl.textContent = '';
          s.titleEl.textContent = '';
          s.objBtn.hidden = true;
          s.viewer.setMesh(null);
        });

        return Client.generate3DForModel({
          apiKey: key,
          model: modelId,
          base64Data: run.image.base64Data,
          mimeType: run.image.mimeType,
          signal: signal
        }).then(function (res) {
          if (activeRun !== run) return;
          const mesh = Renderer.buildMeshFromScene(res.scene);
          slotStates[idx] = { scene: res.scene, mesh: mesh, model: modelId };
          run.ok += 1;
          const sec = (res.elapsedMs / 1000).toFixed(1) + 's';
          const doneTip = res.scene.title + ': ' + mesh.partCount + ' primitive parts (p), returned in ' + sec + '.';
          updateSlotPair(idx, function (s) {
            setSlotState(s, 'done', sec + ' · ' + mesh.partCount + 'p', doneTip);
            s.overlay.hidden = true;
            s.spinner.hidden = true;
            s.titleEl.textContent = res.scene.title;
            s.objBtn.hidden = false;
            s.viewer.setMesh(mesh);
          });
        }).catch(function (err) {
          if (activeRun !== run) return;
          const aborted = err && err.name === 'AbortError';
          const msg = aborted ? 'Cancelled' : ((err && err.message) || String(err));
          updateSlotPair(idx, function (s) {
            if (aborted) setSlotState(s, 'stopped', 'stopped');
            else setSlotState(s, 'failed', 'failed', 'This model failed: ' + msg.slice(0, 120));
            s.overlay.className = aborted ? 'i3d-slot-overlay' : 'i3d-slot-overlay i3d-slot-overlay--err';
            s.overlay.hidden = false;
            s.spinner.hidden = true;
            s.msgEl.className = aborted ? 'i3d-slot-msg' : 'i3d-slot-msg i3d-slot-msg--err';
            s.msgEl.textContent = msg;
          });
        }).finally(function () {
          if (activeRun !== run) return;
          run.done[idx] = true;
          doneCount += 1;
          statusEl.textContent = doneCount + '/' + SLOT_COUNT + ' models finished';
        });
      });
      startTicker();

      await Promise.allSettled(jobs);
      if (activeRun !== run) return;
      activeRun = null;
      stopTicker();
      setRunUi(false);
      setPhase(run.ok > 0 ? 'done' : 'error');
      statusEl.textContent = run.ok + ' of ' + SLOT_COUNT + ' models returned a mesh';
    }

    function isImageFile(file) {
      return Boolean(file && file.type && file.type.indexOf('image/') === 0);
    }

    // Loading an image never sends a request; only a Run click does. A newer image replaces
    // an older one still being read, and stops a run that was for the previous image.
    async function handleImageFile(file) {
      if (!file) return;
      if (!isImageFile(file)) {
        statusEl.textContent = 'Not an image: ' + (file.type || 'unknown type');
        return;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        statusEl.textContent = 'Image is over 40 MB; pick a smaller one';
        return;
      }
      const seq = ++imageSeq;
      try {
        const img = await resizeImageFileToBase64(file, 768);
        if (seq !== imageSeq) return;
        if (activeRun) cancelRun('Image changed; run stopped', 'Stopped: image changed');
        currentImage = img;
        thumbEl.src = currentImage.dataUrl;
        thumbEl.hidden = false;
        dropText.textContent = currentImage.name;
        dropbar.classList.add('i3d-dropbar--has-image');
        thumbEl.alt = currentImage.name;
        renderRunTips(Boolean(activeRun));
        statusEl.textContent = 'Image ready';
      } catch (err) {
        if (seq !== imageSeq) return;
        statusEl.textContent = (err && err.message) || 'Failed to read image';
      }
    }

    // Drag & drop across the entire cell
    ['dragenter', 'dragover'].forEach(function (evName) {
      root.addEventListener(evName, function (e) {
        e.preventDefault();
        root.classList.add('i3d-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (evName) {
      root.addEventListener(evName, function (e) {
        e.preventDefault();
        // Moving onto a child fires dragleave on the tile; only leaving the tile ends the hover.
        if (e.type === 'dragleave' && e.relatedTarget && root.contains(e.relatedTarget)) return;
        root.classList.remove('i3d-dragover');
      });
    });
    root.addEventListener('drop', function (e) {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files[0]) handleImageFile(files[0]);
    });
    // Paste reaches this tile only while focus is inside it, so one paste loads one tile.
    root.addEventListener('paste', function (e) {
      const items = (e.clipboardData && e.clipboardData.files) || [];
      for (let i = 0; i < items.length; i++) {
        if (isImageFile(items[i])) {
          e.preventDefault();
          handleImageFile(items[i]);
          return;
        }
      }
    });

    dropbar.addEventListener('click', function (e) {
      if (e.target === runBtn) return;
      fileInput.click();
    });
    dropbar.addEventListener('keydown', function (e) {
      // Enter/Space on the Run button inside the drop bar used to open the file picker.
      if (e.target !== dropbar) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files[0]) {
        handleImageFile(fileInput.files[0]);
        fileInput.value = '';
      }
    });

    runBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      runAllFour();
    });

    syncBtn.addEventListener('click', function () {
      syncOrbit = !syncOrbit;
      syncBtn.setAttribute('aria-pressed', String(syncOrbit));
      renderSyncTip();
    });

    expandBtn.addEventListener('click', function () {
      if (typeof dialog.showModal === 'function') dialog.showModal();
    });
    dialogClose.addEventListener('click', function () { dialog.close(); });
    dialogRerun.addEventListener('click', function () { runAllFour(); });
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) dialog.close();
    });

    function closeKeyBar() {
      keyBar.hidden = true;
      keyBtn.setAttribute('aria-expanded', 'false');
      keyInput.value = '';
      keyBtn.focus();
    }

    keyBtn.addEventListener('click', function () {
      if (!keyBar.hidden) {
        closeKeyBar();
        return;
      }
      // The saved key is never written back into the input; the placeholder shows a mask.
      const key = Client.KeyStore.get();
      keyInput.value = '';
      keyInput.placeholder = key
        ? 'Saved ' + Client.KeyStore.mask(key) + ' · paste a new key to replace'
        : 'Paste Gemini API key (AIza...)';
      keyBar.hidden = false;
      keyBtn.setAttribute('aria-expanded', 'true');
      keyInput.focus();
    });
    keySaveBtn.addEventListener('click', function () {
      // An empty Save must not clear the shared key for every tile; Clear does that.
      if (!keyInput.value.trim()) {
        keyInput.focus();
        return;
      }
      Client.KeyStore.set(keyInput.value, keyPersist.checked);
      refreshKeyState();
      closeKeyBar();
    });
    keyClearBtn.addEventListener('click', function () {
      Client.KeyStore.clear();
      keyInput.value = '';
      keyInput.placeholder = 'Paste Gemini API key (AIza...)';
      refreshKeyState();
      keyInput.focus();
    });
    keyInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); keySaveBtn.click(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeKeyBar(); }
    });

    // A key saved or cleared in another tile (gemini-key-changed) or tab (storage) only
    // repaints the pill: no request is sent.
    global.addEventListener('gemini-key-changed', refreshKeyState);
    global.addEventListener('storage', function (ev) {
      if (!ev || !ev.key || KEY_STORAGE_NAMES.indexOf(ev.key) >= 0) refreshKeyState();
    });

    applyModelOptions();
    renderSyncTip();
    renderRunTips(false);
    refreshKeyState();
  }

  function initAllImageTo3DCells() {
    const nodes = document.querySelectorAll('.cell--image-to-3d');
    for (let i = 0; i < nodes.length; i++) {
      const idx = nodes[i].getAttribute('data-cell-index') || String(11 + i);
      mountImageTo3DCell(nodes[i], idx);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAllImageTo3DCells);
  } else {
    initAllImageTo3DCells();
  }
})(window);
