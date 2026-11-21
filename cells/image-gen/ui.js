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
      '    <select class="ig-model-select" aria-label="Image generation model"></select>',
      '    <button type="button" class="ui-pill ig-key-btn" data-tone="attention" aria-expanded="false">',
      '      <span class="ui-pill-label">Key</span>',
      '    </button>',
      '  </div>',
      '</header>',
      '<div class="ig-key-bar" hidden>',
      '  <input type="password" class="ig-key-input" placeholder="Paste Gemini API key (AIza...)" autocomplete="off" spellcheck="false" aria-label="Gemini API key">',
      '  <label class="ig-key-persist"><input type="checkbox" class="ig-key-persist-cb" checked> Local</label>',
      '  <button type="button" class="ui-btn ui-btn--sm ig-key-save">Save</button>',
      '  <button type="button" class="ui-btn ui-btn--sm ui-btn--quiet ig-key-clear">Clear</button>',
      '</div>',
      '<div class="ui-tile-body ig-body">',
      '  <div class="ig-stage">',
      '    <img class="ig-img" alt="Generated image preview" hidden>',
      '    <div class="ig-empty">',
      '      <p class="ig-empty-copy">Generate with Nano Banana Pro / Gemini native image API.</p>',
      '      <div class="ig-presets"></div>',
      '    </div>',
      '    <div class="ig-loading" hidden>',
      '      <div class="ig-spinner" aria-hidden="true"></div>',
      '      <span class="ig-loading-label">Generating 0.0s</span>',
      '    </div>',
      '    <div class="ig-error" role="alert" hidden></div>',
      '  </div>',
      '  <form class="ig-form">',
      '    <input type="text" class="ig-prompt" placeholder="Describe an image..." aria-label="Image prompt">',
      '    <select class="ig-aspect" aria-label="Aspect ratio"></select>',
      '    <button type="submit" class="ui-btn ui-btn--primary ig-submit">Generate</button>',
      '  </form>',
      '</div>',
      '<footer class="ui-tile-foot">',
      '  <span class="ig-status ui-truncate">Ready</span>',
      '  <span class="ig-foot-actions" hidden>',
      '    <button type="button" class="ui-btn ui-btn--sm ui-btn--quiet ig-full-btn">Full</button>',
      '    <a class="ui-btn ui-btn--sm ui-btn--quiet ig-dl-btn" download="gemini-image.png">Save</a>',
      '  </span>',
      '</footer>',
      '<dialog class="ui-dialog ig-dialog" aria-label="Generated image full view">',
      '  <div class="ui-studio-bar">',
      '    <span class="ui-studio-title">Generated Image</span>',
      '    <div class="ui-studio-actions">',
      '      <a class="ui-btn ui-btn--sm ig-dialog-dl" download="gemini-image.png">Download</a>',
      '      <button type="button" class="ui-btn ui-btn--sm ig-dialog-close">Close</button>',
      '    </div>',
      '  </div>',
      '  <div class="ig-dialog-body">',
      '    <img class="ig-dialog-img" alt="Full resolution generated image">',
      '  </div>',
      '  <div class="ig-dialog-meta"></div>',
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

    let activeController = null;
    let timerId = null;
    let lastResult = null;
    let modelsDiscoveredForKey = '';

    function populateModels(models) {
      const current = modelSelect.value;
      modelSelect.innerHTML = '';
      models.forEach(function (m) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label || m.id;
        modelSelect.appendChild(opt);
      });
      if (current && models.some(function (m) { return m.id === current; })) {
        modelSelect.value = current;
      }
    }

    function populateAspects() {
      client.ASPECT_RATIOS.forEach(function (ratio) {
        const opt = document.createElement('option');
        opt.value = ratio;
        opt.textContent = ratio;
        aspectSelect.appendChild(opt);
      });
    }

    function refreshKeyState() {
      const hasKey = Boolean(client.KeyStore.get());
      keyBtn.setAttribute('data-tone', hasKey ? 'ok' : 'attention');
      keyBtn.querySelector('.ui-pill-label').textContent = hasKey ? 'Key ✓' : 'Key';
      if (hasKey && client.KeyStore.get() !== modelsDiscoveredForKey) {
        modelsDiscoveredForKey = client.KeyStore.get();
        client.discoverImageModels(modelsDiscoveredForKey)
          .then(function (models) {
            if (models && models.length) populateModels(models);
          })
          .catch(function () {});
      }
    }

    function showError(msg) {
      if (!msg) {
        errorEl.hidden = true;
        errorEl.textContent = '';
        return;
      }
      errorEl.textContent = msg;
      errorEl.hidden = false;
    }

    function setBusy(busy) {
      if (busy) {
        const t0 = Date.now();
        loadingEl.hidden = false;
        loadingLabel.textContent = 'Generating 0.0s';
        submitBtn.textContent = 'Cancel';
        submitBtn.setAttribute('aria-pressed', 'true');
        statusEl.textContent = 'Generating with ' + modelSelect.value + '...';
        timerId = global.setInterval(function () {
          const sec = ((Date.now() - t0) / 1000).toFixed(1);
          loadingLabel.textContent = 'Generating ' + sec + 's';
        }, 100);
      } else {
        if (timerId) {
          global.clearInterval(timerId);
          timerId = null;
        }
        loadingEl.hidden = true;
        submitBtn.textContent = 'Generate';
        submitBtn.removeAttribute('aria-pressed');
      }
    }

    async function runGeneration(promptText) {
      if (activeController) {
        activeController.abort();
        activeController = null;
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

      const prompt = String(promptText || promptInput.value || '').trim();
      if (!prompt) {
        promptInput.focus();
        return;
      }

      showError('');
      activeController = new AbortController();
      setBusy(true);

      try {
        const result = await client.generateImage({
          apiKey: key,
          model: modelSelect.value,
          prompt: prompt,
          aspectRatio: aspectSelect.value,
          signal: activeController.signal
        });

        lastResult = Object.assign({ prompt: prompt, aspectRatio: aspectSelect.value }, result);
        imgEl.src = result.dataUrl;
        imgEl.alt = prompt;
        imgEl.hidden = false;
        emptyEl.hidden = true;
        stage.classList.add('ig-stage--has-image');

        const ext = result.mimeType === 'image/jpeg' ? 'jpg' : (result.mimeType === 'image/webp' ? 'webp' : 'png');
        const filename = 'gemini-' + Date.now() + '.' + ext;
        dlBtn.href = result.dataUrl;
        dlBtn.download = filename;
        dialogImg.src = result.dataUrl;
        dialogDl.href = result.dataUrl;
        dialogDl.download = filename;
        footActions.hidden = false;

        const sec = (result.elapsedMs / 1000).toFixed(1);
        statusEl.textContent = sec + 's · ' + result.model;

        imgEl.onload = function () {
          const dims = imgEl.naturalWidth + '×' + imgEl.naturalHeight;
          statusEl.textContent = sec + 's · ' + dims + ' · ' + result.model;
          dialogMeta.textContent = result.model + ' · ' + dims + ' · ' + sec + 's · "' + prompt + '"';
        };
      } catch (err) {
        if (err && err.name === 'AbortError') {
          statusEl.textContent = 'Cancelled';
        } else {
          const msg = (err && err.message) ? err.message : String(err);
          showError(msg);
          statusEl.textContent = 'Error';
        }
      } finally {
        activeController = null;
        setBusy(false);
      }
    }

    // Build preset chips
    PRESETS.forEach(function (preset) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ui-chip';
      btn.textContent = preset.label;
      btn.addEventListener('click', function () {
        promptInput.value = preset.prompt;
        runGeneration(preset.prompt);
      });
      presetsEl.appendChild(btn);
    });

    keyBtn.addEventListener('click', function () {
      const opening = keyBar.hidden;
      keyBar.hidden = !opening;
      keyBtn.setAttribute('aria-expanded', String(opening));
      if (opening) {
        keyInput.value = client.KeyStore.get();
        keyInput.focus();
      }
    });

    keySaveBtn.addEventListener('click', function () {
      client.KeyStore.set(keyInput.value, keyPersist.checked);
      refreshKeyState();
      keyBar.hidden = true;
      keyBtn.setAttribute('aria-expanded', 'false');
      showError('');
    });

    keyClearBtn.addEventListener('click', function () {
      client.KeyStore.clear();
      keyInput.value = '';
      modelsDiscoveredForKey = '';
      populateModels(client.DEFAULT_MODELS);
      refreshKeyState();
    });

    keyInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        keySaveBtn.click();
      } else if (e.key === 'Escape') {
        keyBar.hidden = true;
        keyBtn.setAttribute('aria-expanded', 'false');
      }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      runGeneration(promptInput.value);
    });

    function openLightbox() {
      if (!lastResult || typeof dialog.showModal !== 'function') return;
      dialog.showModal();
    }

    imgEl.addEventListener('click', openLightbox);
    fullBtn.addEventListener('click', openLightbox);
    dialogClose.addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) dialog.close();
    });

    populateModels(client.DEFAULT_MODELS);
    populateAspects();
    refreshKeyState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initImageGenCell);
  } else {
    initImageGenCell();
  }
})(window);
