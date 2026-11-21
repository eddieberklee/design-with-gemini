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

  function initImageTo3DCell() {
    const root = document.getElementById('cell-image-to-3d');
    const NS = global.GeminiImageTo3D;
    if (!root || !NS || !NS.Client || !NS.Renderer) return;

    const Client = NS.Client;
    const Renderer = NS.Renderer;

    root.classList.add('ui-tile');
    root.innerHTML = [
      '<header class="ui-tile-head">',
      '  <span class="ui-tile-index">11</span>',
      '  <h2 class="ui-tile-title">Image → 3D (4×)</h2>',
      '  <div class="ui-tile-actions">',
      '    <button type="button" class="ui-btn ui-btn--sm i3d-sync-btn" aria-pressed="true" title="Sync camera orbit across all 4 viewers">Sync</button>',
      '    <button type="button" class="ui-btn ui-btn--sm i3d-expand-btn" title="Open 4-up studio">4-Up</button>',
      '    <button type="button" class="ui-pill i3d-key-btn" data-tone="attention" aria-expanded="false">',
      '      <span class="ui-pill-label">Key</span>',
      '    </button>',
      '  </div>',
      '</header>',
      '<div class="i3d-key-bar" hidden>',
      '  <input type="password" class="i3d-key-input" placeholder="Paste Gemini API key (AIza...)" autocomplete="off" spellcheck="false" aria-label="Gemini API key">',
      '  <label class="i3d-key-persist"><input type="checkbox" class="i3d-key-persist-cb" checked> Local</label>',
      '  <button type="button" class="ui-btn ui-btn--sm i3d-key-save">Save</button>',
      '  <button type="button" class="ui-btn ui-btn--sm ui-btn--quiet i3d-key-clear">Clear</button>',
      '</div>',
      '<div class="ui-tile-body i3d-body">',
      '  <div class="i3d-dropbar" role="button" tabindex="0" aria-label="Drop or choose an image">',
      '    <img class="i3d-thumb" alt="Dropped image" hidden>',
      '    <span class="i3d-drop-text">Drop an image here, paste, or click to pick — 4 Gemini models race to build 3D</span>',
      '    <input type="file" class="i3d-file-input" accept="image/*">',
      '    <button type="button" class="ui-btn ui-btn--sm ui-btn--primary i3d-run-btn" disabled>Run 4×</button>',
      '  </div>',
      '  <div class="i3d-arena"></div>',
      '</div>',
      '<footer class="ui-tile-foot">',
      '  <span class="i3d-status ui-truncate">Drop an image to compare 4 Gemini models</span>',
      '</footer>',
      '<dialog class="ui-dialog i3d-dialog" aria-label="4-Model 3D Comparison Studio">',
      '  <div class="ui-studio-bar">',
      '    <span class="ui-studio-title">Image → 3D · 4 Gemini Models Side by Side</span>',
      '    <div class="ui-studio-actions">',
      '      <button type="button" class="ui-btn ui-btn--sm i3d-dialog-rerun">Re-run 4×</button>',
      '      <button type="button" class="ui-btn ui-btn--sm i3d-dialog-close">Close</button>',
      '    </div>',
      '  </div>',
      '  <div class="i3d-dialog-arena"></div>',
      '</dialog>'
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

    let models = Client.DEFAULT_FOUR_MODELS.slice();
    let currentImage = null;
    let syncOrbit = true;
    let activeController = null;
    let discoveredKey = '';
    const slotStates = [null, null, null, null];

    function buildSlots(container) {
      container.innerHTML = '';
      return models.map(function (modelId, idx) {
        const slot = document.createElement('div');
        slot.className = 'i3d-slot';
        slot.innerHTML = [
          '<div class="i3d-slot-head">',
          '  <span class="i3d-model-name"></span>',
          '  <span class="i3d-slot-meta">idle</span>',
          '</div>',
          '<div class="i3d-canvas-wrap">',
          '  <canvas class="i3d-canvas"></canvas>',
          '  <div class="i3d-slot-overlay">',
          '    <div class="i3d-spinner" hidden></div>',
          '    <span class="i3d-slot-msg">Waiting</span>',
          '  </div>',
          '</div>',
          '<div class="i3d-slot-foot">',
          '  <span class="i3d-slot-title">—</span>',
          '  <button type="button" class="i3d-obj-btn" hidden>.OBJ</button>',
          '</div>'
        ].join('\n');
        container.appendChild(slot);

        const nameEl = slot.querySelector('.i3d-model-name');
        const metaEl = slot.querySelector('.i3d-slot-meta');
        const canvas = slot.querySelector('.i3d-canvas');
        const overlay = slot.querySelector('.i3d-slot-overlay');
        const spinner = slot.querySelector('.i3d-spinner');
        const msgEl = slot.querySelector('.i3d-slot-msg');
        const titleEl = slot.querySelector('.i3d-slot-title');
        const objBtn = slot.querySelector('.i3d-obj-btn');

        nameEl.textContent = modelId;
        nameEl.title = modelId;

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
          a.download = modelId.replace(/[^a-z0-9.-]/gi, '_') + '.obj';
          a.click();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        });

        return {
          idx: idx,
          nameEl: nameEl,
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

    function applyModelNames() {
      models.forEach(function (m, idx) {
        updateSlotPair(idx, function (s) {
          s.nameEl.textContent = m;
          s.nameEl.title = m;
        });
      });
    }

    function refreshKeyState() {
      const key = Client.KeyStore.get();
      const hasKey = Boolean(key);
      keyBtn.setAttribute('data-tone', hasKey ? 'ok' : 'attention');
      keyBtn.querySelector('.ui-pill-label').textContent = hasKey ? 'Key ✓' : 'Key';
      if (hasKey && key !== discoveredKey) {
        discoveredKey = key;
        Client.discoverFourModels(key).then(function (found) {
          if (found && found.length === 4) {
            models = found;
            applyModelNames();
          }
        });
      }
    }

    async function runAllFour() {
      if (activeController) {
        activeController.abort();
        activeController = null;
        runBtn.textContent = 'Run 4×';
        statusEl.textContent = 'Cancelled';
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
      if (!currentImage) {
        statusEl.textContent = 'Drop or pick an image first';
        return;
      }

      activeController = new AbortController();
      const signal = activeController.signal;
      runBtn.textContent = 'Stop';
      statusEl.textContent = 'Running 4 Gemini models in parallel...';

      let doneCount = 0;
      const jobs = models.map(function (modelId, idx) {
        slotStates[idx] = null;
        const t0 = Date.now();
        updateSlotPair(idx, function (s) {
          s.metaEl.textContent = '0.0s';
          s.overlay.hidden = false;
          s.spinner.hidden = false;
          s.msgEl.className = 'i3d-slot-msg';
          s.msgEl.textContent = 'Generating...';
          s.titleEl.textContent = '—';
          s.objBtn.hidden = true;
          s.viewer.setMesh(null);
        });

        const tickId = global.setInterval(function () {
          const sec = ((Date.now() - t0) / 1000).toFixed(1) + 's';
          updateSlotPair(idx, function (s) { s.metaEl.textContent = sec; });
        }, 100);

        return Client.generate3DForModel({
          apiKey: key,
          model: modelId,
          base64Data: currentImage.base64Data,
          mimeType: currentImage.mimeType,
          signal: signal
        }).then(function (res) {
          global.clearInterval(tickId);
          const mesh = Renderer.buildMeshFromScene(res.scene);
          slotStates[idx] = { scene: res.scene, mesh: mesh };
          const sec = (res.elapsedMs / 1000).toFixed(1) + 's';
          updateSlotPair(idx, function (s) {
            s.metaEl.textContent = sec + ' · ' + mesh.partCount + 'p';
            s.overlay.hidden = true;
            s.spinner.hidden = true;
            s.titleEl.textContent = res.scene.title;
            s.objBtn.hidden = false;
            s.viewer.setMesh(mesh);
          });
        }).catch(function (err) {
          global.clearInterval(tickId);
          const aborted = err && err.name === 'AbortError';
          const msg = aborted ? 'Cancelled' : ((err && err.message) || String(err));
          updateSlotPair(idx, function (s) {
            s.metaEl.textContent = aborted ? 'stop' : 'err';
            s.overlay.hidden = false;
            s.spinner.hidden = true;
            s.msgEl.className = aborted ? 'i3d-slot-msg' : 'i3d-slot-msg i3d-slot-msg--err';
            s.msgEl.textContent = msg;
          });
        }).finally(function () {
          doneCount += 1;
          statusEl.textContent = doneCount + '/4 models finished';
        });
      });

      await Promise.allSettled(jobs);
      activeController = null;
      runBtn.textContent = 'Run 4×';
    }

    async function handleImageFile(file) {
      if (!file || !file.type || file.type.indexOf('image/') !== 0) return;
      try {
        currentImage = await resizeImageFileToBase64(file, 768);
        thumbEl.src = currentImage.dataUrl;
        thumbEl.hidden = false;
        dropText.textContent = currentImage.name;
        runBtn.disabled = false;
        runAllFour();
      } catch (err) {
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
        root.classList.remove('i3d-dragover');
      });
    });
    root.addEventListener('drop', function (e) {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files[0]) handleImageFile(files[0]);
    });

    dropbar.addEventListener('click', function (e) {
      if (e.target === runBtn) return;
      fileInput.click();
    });
    dropbar.addEventListener('keydown', function (e) {
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
    });

    expandBtn.addEventListener('click', function () {
      if (typeof dialog.showModal === 'function') dialog.showModal();
    });
    dialogClose.addEventListener('click', function () { dialog.close(); });
    dialogRerun.addEventListener('click', function () { runAllFour(); });
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) dialog.close();
    });

    keyBtn.addEventListener('click', function () {
      const opening = keyBar.hidden;
      keyBar.hidden = !opening;
      keyBtn.setAttribute('aria-expanded', String(opening));
      if (opening) {
        keyInput.value = Client.KeyStore.get();
        keyInput.focus();
      }
    });
    keySaveBtn.addEventListener('click', function () {
      Client.KeyStore.set(keyInput.value, keyPersist.checked);
      refreshKeyState();
      keyBar.hidden = true;
      keyBtn.setAttribute('aria-expanded', 'false');
    });
    keyClearBtn.addEventListener('click', function () {
      Client.KeyStore.clear();
      keyInput.value = '';
      discoveredKey = '';
      models = Client.DEFAULT_FOUR_MODELS.slice();
      applyModelNames();
      refreshKeyState();
    });
    keyInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); keySaveBtn.click(); }
      else if (e.key === 'Escape') { keyBar.hidden = true; keyBtn.setAttribute('aria-expanded', 'false'); }
    });

    refreshKeyState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initImageTo3DCell);
  } else {
    initImageTo3DCell();
  }
})(window);
