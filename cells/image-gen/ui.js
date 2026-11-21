(function (global) {
  'use strict';

  const PRESETS = [
    {
      label: 'Ceramic espresso',
      prompt: 'Overhead studio photograph of a handmade matte stoneware espresso cup on warm limestone, soft morning raking light, crisp editorial shadow'
    },
    {
      label: 'Brutalist greenhouse',
      prompt: 'Architectural photograph of a sunlit brutalist concrete greenhouse filled with monstera and ferns, misty morning glass, 35mm film grain'
    },
    {
      label: 'Risograph poster',
      prompt: 'Minimalist Swiss risograph poster of a geometric orange sun rising behind indigo mountains, subtle paper texture, clean typography reading SOLSTICE'
    },
    {
      label: 'Isometric studio',
      prompt: 'Clean isometric cutaway diorama of a tiny sunlit industrial design studio with a drafting table, 3D printer, and clay prototypes, soft clay render'
    }
  ];

  const GENERATE_TIP = 'Send the prompt to the selected model; each image is billed to your key.';

  function initImageGenCell() {
    const root = document.getElementById('cell-image-gen');
    const client = global.GeminiImageGen;
    if (!root || !client) return;

    root.classList.add('ui-tile');
    root.innerHTML = [
      '<header class="ui-tile-head">',
      '  <span class="ui-tile-index">10</span>',
      '  <h2 class="ui-tile-title">Image Gen</h2>',
      '  <div class="ui-tile-actions">',
      '    <button type="button" class="ui-pill ig-key-btn" aria-expanded="false">',
      '      <span class="ui-pill-label">No key</span>',
      '    </button>',
      '    <select class="ig-select ig-model-select ui-hide-compact" aria-label="Image model"',
      '      data-tip="Gemini model that draws the image; the list updates from your key on first Generate."></select>',
      '  </div>',
      '</header>',
      '<div class="ig-key-bar" hidden>',
      '  <input type="password" class="ig-key-input" placeholder="Paste Gemini API key (AIza...)" autocomplete="off" spellcheck="false" aria-label="Gemini API key">',
      '  <label class="ig-key-persist ui-hide-tiny" data-tip="Keep the key after this tab closes, stored in this browser.">',
      '    <input type="checkbox" class="ig-key-persist-cb" checked> Remember</label>',
      '  <button type="button" class="ui-btn ui-btn--sm ig-key-save" data-tip="Use this key here and in the other Gemini tiles." data-tip-key="Enter">Save</button>',
      '  <button type="button" class="ui-btn ui-btn--sm ui-btn--quiet ig-key-clear ui-hide-tiny" data-tip="Remove the saved key from every Gemini tile.">Clear</button>',
      '</div>',
      '<div class="ui-tile-body ig-body">',
      '  <div class="ig-stage" style="--ig-ar: 1.3333">',
      '    <div class="ig-frame" aria-hidden="true"><span class="ig-frame-ratio">4:3</span></div>',
      '    <img class="ig-img" alt="Generated image preview" role="button" tabindex="0" data-tip="View full size with its prompt and download." hidden>',
      '    <div class="ig-empty">',
      '      <p class="ig-empty-copy">Write a prompt or pick an example.</p>',
      '      <div class="ig-presets"></div>',
      '    </div>',
      '    <div class="ig-loading" hidden>',
      '      <span class="ui-label">Generating</span>',
      '      <span class="ui-readout ui-readout--hero"><span class="ig-loading-label">0.0</span><span class="ui-readout-unit">s</span></span>',
      '    </div>',
      '    <div class="ig-error" role="alert" hidden></div>',
      '  </div>',
      '  <form class="ig-form ui-hide-tiny">',
      '    <input type="text" class="ig-prompt" placeholder="Describe an image…" aria-label="Image prompt">',
      '    <select class="ig-select ig-aspect ui-hide-compact" aria-label="Aspect ratio"',
      '      data-tip="Requested width to height; a model that rejects it returns its default shape."></select>',
      '    <button type="submit" class="ui-btn ui-btn--primary ig-submit">Generate</button>',
      '  </form>',
      '</div>',
      '<footer class="ui-tile-foot">',
      '  <span class="ig-status ui-truncate">No image yet</span>',
      '  <span class="ig-foot-actions" hidden>',
      '    <button type="button" class="ui-btn ui-btn--sm ui-btn--quiet ig-full-btn" data-tip="Open the image full size with its prompt and download.">View</button>',
      '    <a class="ui-btn ui-btn--sm ui-btn--quiet ig-dl-btn" download="gemini-image.png">Download</a>',
      '  </span>',
      '</footer>',
      '<dialog class="ui-dialog ig-dialog" aria-labelledby="ig-dialog-title">',
      '  <header class="ui-studio-bar">',
      '    <span class="ui-tile-index">10</span>',
      '    <h2 class="ui-studio-title" id="ig-dialog-title">Generated image</h2>',
      '    <div class="ui-studio-actions">',
      '      <a class="ui-btn ui-btn--sm ig-dialog-dl" download="gemini-image.png">Download</a>',
      '      <button type="button" class="ui-btn ig-dialog-close" data-tip="Back to the grid." data-tip-key="Esc">Close</button>',
      '    </div>',
      '  </header>',
      '  <div class="ig-dialog-body">',
      '    <img class="ig-dialog-img" alt="Full resolution generated image">',
      '  </div>',
      '  <div class="ig-dialog-meta"><p class="ig-dialog-prompt"></p><p class="ig-dialog-facts"></p></div>',
      '</dialog>'
    ].join('\n');

    const modelSelect = root.querySelector('.ig-model-select');
    const keyBtn = root.querySelector('.ig-key-btn');
    const keyBar = root.querySelector('.ig-key-bar');
    const keyInput = root.querySelector('.ig-key-input');
    const keyPersist = root.querySelector('.ig-key-persist-cb');
    const keySaveBtn = root.querySelector('.ig-key-save');
    const keyClearBtn = root.querySelector('.ig-key-clear');
    const stage = root.querySelector('.ig-stage');
    const imgEl = root.querySelector('.ig-img');
    const emptyEl = root.querySelector('.ig-empty');
    const presetsEl = root.querySelector('.ig-presets');
    const loadingEl = root.querySelector('.ig-loading');
    const loadingLabel = root.querySelector('.ig-loading-label');
    const errorEl = root.querySelector('.ig-error');
    const form = root.querySelector('.ig-form');
    const promptInput = root.querySelector('.ig-prompt');
    const aspectSelect = root.querySelector('.ig-aspect');
    const submitBtn = root.querySelector('.ig-submit');
    const statusEl = root.querySelector('.ig-status');
    const footActions = root.querySelector('.ig-foot-actions');
    const fullBtn = root.querySelector('.ig-full-btn');
    const dlBtn = root.querySelector('.ig-dl-btn');
    const dialog = root.querySelector('.ig-dialog');
    const dialogImg = root.querySelector('.ig-dialog-img');
    const dialogDl = root.querySelector('.ig-dialog-dl');
    const dialogClose = root.querySelector('.ig-dialog-close');
    const dialogMeta = root.querySelector('.ig-dialog-meta');

    const runSlot = client.createRunSlot();
    let timerId = null;
    let lastResult = null;
    let imageUrl = '';
    let modelsDiscoveredForKey = '';

    function populateModels(models) {
      const current = modelSelect.value;
      const list = models.slice();
      // A list refresh must never change the model the next paid click uses.
      if (current && !list.some(function (m) { return m.id === current; })) {
        list.unshift({ id: current, label: current });
      }
      modelSelect.innerHTML = '';
      list.forEach(function (m) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label || m.id;
        modelSelect.appendChild(opt);
      });
      if (current) modelSelect.value = current;
    }

    // ListModels runs only from an explicit Generate click (never on load, Save or key sync),
    // once per key, and is not awaited.
    function discoverModelsOnce(key) {
      if (!key || key === modelsDiscoveredForKey) return;
      modelsDiscoveredForKey = key;
      client.discoverImageModels(key)
        .then(function (models) {
          if (models && models.length && client.KeyStore.get() === key) populateModels(models);
        })
        .catch(function () {});
    }

    function populateAspects() {
      client.ASPECT_RATIOS.forEach(function (ratio) {
        const opt = document.createElement('option');
        opt.value = ratio;
        opt.textContent = ratio;
        aspectSelect.appendChild(opt);
      });
    }

    // Status pill: grey for no key / key set, rust while generating or after an error,
    // green only after an image really came back and decoded. Click opens the key bar.
    let phase = 'idle'; // idle | busy | error | done
    const PILL = {
      nokey: { label: 'No key', tone: '', tip: 'No Gemini API key yet. Click to paste one; the Gemini tiles share it.' },
      idle: { label: 'Key set', tone: '', tip: 'Key saved; Generate is ready. Click to replace or clear the key.' },
      busy: { label: 'Running', tone: 'attention', tip: 'Waiting for the model; Generate is now Cancel. Click to manage the key.' },
      error: { label: 'Error', tone: 'attention', tip: 'The last request failed; the reason is shown on the image. Click to manage the key.' },
      done: { label: 'Done', tone: 'ok', tip: 'The last image came back and decoded. Click to manage the key.' }
    };

    function renderPill() {
      const hasKey = Boolean(client.KeyStore.get());
      const state = phase === 'busy' ? PILL.busy : (!hasKey ? PILL.nokey : PILL[phase]);
      if (state.tone) keyBtn.setAttribute('data-tone', state.tone);
      else keyBtn.removeAttribute('data-tone');
      keyBtn.querySelector('.ui-pill-label').textContent = state.label;
      keyBtn.setAttribute('aria-label', 'API key, status ' + state.label);
      keyBtn.setAttribute('data-tip', state.tip);
    }

    function setPhase(next) {
      phase = next;
      renderPill();
    }

    function refreshKeyState() {
      const key = client.KeyStore.get();
      const hasKey = Boolean(key);
      renderPill();
      keyInput.placeholder = hasKey
        ? 'Saved ' + client.KeyStore.mask(key) + ' · paste a new key to replace'
        : 'Paste Gemini API key (AIza...)';
    }

    function syncAspectFrame() {
      const parts = String(aspectSelect.value || '4:3').split(':');
      const ar = Number(parts[0]) / Number(parts[1]);
      stage.style.setProperty('--ig-ar', Number.isFinite(ar) && ar > 0 ? ar.toFixed(4) : '1.3333');
      root.querySelector('.ig-frame-ratio').textContent = aspectSelect.value;
    }

    function showError(msg) {
      if (!msg) {
        errorEl.hidden = true;
        errorEl.textContent = '';
        // The pill must not stay rust pointing at a message that is gone.
        if (phase === 'error') setPhase('idle');
        return;
      }
      errorEl.textContent = msg;
      errorEl.hidden = false;
    }

    // Elapsed-time ticker: runs only while a request is in flight and the tab is visible.
    let busySince = 0;

    function tick() {
      loadingLabel.textContent = ((Date.now() - busySince) / 1000).toFixed(1);
    }

    function stopTicker() {
      if (timerId) {
        global.clearInterval(timerId);
        timerId = null;
      }
    }

    function startTicker() {
      stopTicker();
      if (!busySince || document.visibilityState === 'hidden') return;
      tick();
      timerId = global.setInterval(tick, 100);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') stopTicker();
      else if (busySince) startTicker();
    });

    function setBusy(busy) {
      if (busy) {
        busySince = Date.now();
        loadingEl.hidden = false;
        stage.setAttribute('data-busy', '');
        loadingLabel.textContent = '0.0';
        submitBtn.textContent = 'Cancel';
        submitBtn.setAttribute('aria-pressed', 'true');
        submitBtn.setAttribute('data-tip', 'Stop waiting and abort this request.');
        statusEl.textContent = 'Generating with ' + modelSelect.value + '…';
        startTicker();
        setPhase('busy');
      } else {
        busySince = 0;
        stopTicker();
        loadingEl.hidden = true;
        stage.removeAttribute('data-busy');
        submitBtn.textContent = 'Generate';
        submitBtn.removeAttribute('aria-pressed');
        submitBtn.setAttribute('data-tip', GENERATE_TIP);
        if (phase === 'busy') setPhase('idle');
      }
    }

    // Resolves once the browser has decoded the image, so a corrupt payload is an error
    // and never a "successful" broken image.
    function loadImage(url) {
      return new Promise(function (resolve, reject) {
        const probe = new Image();
        probe.onload = function () { resolve(probe); };
        probe.onerror = function () {
          reject(new Error('The returned image could not be decoded.'));
        };
        probe.src = url;
      });
    }

    function showResult(result, url, dims, prompt) {
      const previousUrl = imageUrl;
      imageUrl = url;
      lastResult = Object.assign({ prompt: prompt, aspectRatio: result.aspectRatio }, result);
      imgEl.src = url;
      imgEl.alt = prompt;
      imgEl.hidden = false;
      emptyEl.hidden = true;
      stage.classList.add('ig-stage--has-image');

      const ext = result.mimeType === 'image/jpeg' ? 'jpg' : (result.mimeType === 'image/webp' ? 'webp' : 'png');
      const filename = 'gemini-' + Date.now() + '.' + ext;
      dlBtn.href = url;
      dlBtn.download = filename;
      dialogImg.src = url;
      dialogDl.href = url;
      dialogDl.download = filename;
      footActions.hidden = false;

      const sec = (result.elapsedMs / 1000).toFixed(1);
      statusEl.textContent = sec + 's · ' + dims + ' · ' + result.model;
      dialogMeta.querySelector('.ig-dialog-prompt').textContent = prompt;
      dialogMeta.querySelector('.ig-dialog-facts').textContent =
        result.model + ' · ' + dims + ' · ' + result.aspectRatio + ' requested · ' + sec + 's';
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      setPhase('done');
    }

    async function runGeneration() {
      if (runSlot.busy()) {
        runSlot.cancel();
        setBusy(false);
        statusEl.textContent = 'Cancelled';
        return;
      }

      const key = client.KeyStore.get();
      if (!key) {
        keyBar.hidden = false;
        keyBtn.setAttribute('aria-expanded', 'true');
        keyInput.focus();
        showError('Add a Gemini API key to generate images.');
        return;
      }

      const prompt = String(promptInput.value || '').trim();
      if (!prompt) {
        statusEl.textContent = 'Enter a prompt first';
        promptInput.focus();
        return;
      }

      showError('');
      const ctrl = runSlot.begin();
      const aspectRatio = aspectSelect.value;
      setBusy(true);
      discoverModelsOnce(key);

      let url = '';
      try {
        const result = await client.generateImage({
          apiKey: key,
          model: modelSelect.value,
          prompt: prompt,
          aspectRatio: aspectRatio,
          signal: ctrl.signal
        });
        if (!runSlot.isCurrent(ctrl)) return;
        url = URL.createObjectURL(result.blob);
        const probe = await loadImage(url);
        if (!runSlot.isCurrent(ctrl)) {
          URL.revokeObjectURL(url);
          return;
        }
        result.aspectRatio = aspectRatio;
        showResult(result, url, probe.naturalWidth + '×' + probe.naturalHeight, prompt);
        url = '';
      } catch (err) {
        if (url) URL.revokeObjectURL(url);
        // A cancelled or replaced run must not write over the state of the run that replaced it.
        if (!runSlot.isCurrent(ctrl)) return;
        if (err && err.name === 'AbortError') {
          statusEl.textContent = 'Cancelled';
        } else {
          const msg = (err && err.message) ? err.message : String(err);
          showError(msg);
          statusEl.textContent = 'Error';
          setPhase('error');
        }
      } finally {
        if (runSlot.finish(ctrl)) setBusy(false);
      }
    }

    // Preset chips only fill the prompt: generating costs money, so only Generate sends.
    PRESETS.forEach(function (preset) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ui-chip';
      btn.textContent = preset.label;
      btn.setAttribute('data-tip', 'Fill the prompt with this example; nothing is sent until Generate.');
      btn.addEventListener('click', function () {
        promptInput.value = preset.prompt;
        promptInput.focus();
      });
      presetsEl.appendChild(btn);
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
      keyBar.hidden = false;
      keyBtn.setAttribute('aria-expanded', 'true');
      refreshKeyState();
      keyInput.focus();
    });

    keySaveBtn.addEventListener('click', function () {
      // Empty Save must not clear the shared key for every cell; Clear does that.
      if (!keyInput.value.trim()) {
        keyInput.focus();
        return;
      }
      client.KeyStore.set(keyInput.value, keyPersist.checked);
      refreshKeyState();
      closeKeyBar();
      showError('');
    });

    keyClearBtn.addEventListener('click', function () {
      client.KeyStore.clear();
      keyInput.value = '';
      modelsDiscoveredForKey = '';
      populateModels(client.DEFAULT_MODELS);
      refreshKeyState();
      keyInput.focus();
    });

    keyInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        keySaveBtn.click();
      } else if (e.key === 'Escape') {
        closeKeyBar();
      }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      runGeneration();
    });

    aspectSelect.addEventListener('change', syncAspectFrame);

    // A key saved or removed in another cell (gemini-key-changed) or another tab (storage)
    // only repaints the key state: no request is sent.
    global.addEventListener('gemini-key-changed', refreshKeyState);
    global.addEventListener('storage', function (ev) {
      if (!ev || !ev.key || ev.key === 'dc_gemini_api_key_session' || ev.key === 'dc_gemini_api_key_local') {
        refreshKeyState();
      }
    });

    function openLightbox() {
      if (!lastResult || typeof dialog.showModal !== 'function') return;
      dialog.showModal();
    }

    imgEl.addEventListener('click', openLightbox);
    // The footer View button hides on compact tiles; the image itself is the keyboard path there.
    imgEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openLightbox();
      }
    });
    fullBtn.addEventListener('click', openLightbox);
    dialogClose.addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) dialog.close();
    });

    populateModels(client.DEFAULT_MODELS);
    populateAspects();
    syncAspectFrame();
    submitBtn.setAttribute('data-tip', GENERATE_TIP);
    submitBtn.setAttribute('data-tip-key', 'Enter');
    refreshKeyState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initImageGenCell);
  } else {
    initImageGenCell();
  }
})(window);
