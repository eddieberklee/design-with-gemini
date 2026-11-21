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

  const TRY_ON_PROMPT =
    'Photorealistic virtual try-on photograph. Place the exact product shown in the second reference image onto the person shown in the first reference image so they are naturally wearing or holding it. Preserve the person\'s exact face, identity, hair, skin tone, body proportions, pose, and environment from the first image, and preserve the product\'s exact design, color, material, logos, and proportions from the second image. Match lighting, shadows, and natural fit seamlessly.';

  function readImageFile(file, maxDim) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read image')); };
      reader.onload = function () {
        const img = new Image();
        img.onerror = function () { reject(new Error('Invalid image file')); };
        img.onload = function () {
          const limit = maxDim || 1024;
          const scale = Math.min(1, limit / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          const dataUrl = c.toDataURL('image/jpeg', 0.88);
          resolve({
            dataUrl: dataUrl,
            data: dataUrl.split(',')[1] || '',
            mimeType: 'image/jpeg',
            name: file.name || 'image.jpg'
          });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function wireRefSpot(spotEl, defaultLabel, onChange) {
    const thumb = spotEl.querySelector('.ig-ref-thumb');
    const label = spotEl.querySelector('.ig-ref-label');
    const clearBtn = spotEl.querySelector('.ig-ref-clear');
    const input = spotEl.querySelector('.ig-ref-file');

    let current = null;

    function setFile(file) {
      if (!file || !file.type || file.type.indexOf('image/') !== 0) return;
      readImageFile(file, 1024).then(function (img) {
        current = img;
        thumb.src = img.dataUrl;
        thumb.hidden = false;
        label.textContent = img.name;
        clearBtn.hidden = false;
        onChange(current);
      }).catch(function () {});
    }

    function clear(e) {
      if (e) e.stopPropagation();
      current = null;
      thumb.hidden = true;
      thumb.removeAttribute('src');
      label.textContent = defaultLabel;
      clearBtn.hidden = true;
      onChange(null);
    }

    spotEl.addEventListener('click', function () { input.click(); });
    spotEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) {
        setFile(input.files[0]);
        input.value = '';
      }
    });
    clearBtn.addEventListener('click', clear);

    ['dragenter', 'dragover'].forEach(function (ev) {
      spotEl.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        spotEl.classList.add('ig-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      spotEl.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        spotEl.classList.remove('ig-dragover');
      });
    });
    spotEl.addEventListener('drop', function (e) {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files[0]) setFile(files[0]);
    });

    return {
      get: function () { return current; },
      clear: clear
    };
  }

  function mountImageGenCell(root, cellIndex) {
    const client = global.GeminiImageGen;
    if (!root || !client) return;

    const isTryOn = root.getAttribute('data-mode') === 'try-on';
    const title = isTryOn ? 'Virtual Try-On' : 'Image Gen';

    root.classList.add('ui-tile');
    root.innerHTML = [
      '<header class="ui-tile-head">',
      '  <span class="ui-tile-index">' + cellIndex + '</span>',
      '  <h2 class="ui-tile-title">' + title + '</h2>',
      '  <div class="ui-tile-actions">',
      '    <button type="button" class="ui-pill ig-key-btn" aria-expanded="false">',
      '      <span class="ui-pill-label">No key</span>',
      '    </button>',
      '    <select class="ig-model-select ui-hide-compact" aria-label="Image generation model"',
      '      data-tip="Gemini model that draws the image; the list updates from your key."></select>',
      '  </div>',
      '</header>',
      '<div class="ig-key-bar" hidden>',
      '  <input type="password" class="ig-key-input" placeholder="Paste Gemini API key (AIza...)" autocomplete="off" spellcheck="false" aria-label="Gemini API key">',
      '  <label class="ig-key-persist" data-tip="Keep the key after this tab closes, stored in this browser."><input type="checkbox" class="ig-key-persist-cb" checked> Remember</label>',
      '  <button type="button" class="ui-btn ui-btn--sm ig-key-save" data-tip="Use this key here and in the other Gemini tiles." data-tip-key="Enter">Save</button>',
      '  <button type="button" class="ui-btn ui-btn--sm ui-btn--quiet ig-key-clear" data-tip="Remove the saved key from every Gemini tile.">Clear</button>',
      '</div>',
      '<div class="ui-tile-body ig-body">',
      isTryOn ? [
        '  <div class="ig-refs ui-hide-tiny">',
        '    <div class="ig-ref-spot ig-ref-person" role="button" tabindex="0" aria-label="Drop person reference image" data-tip="Drop, paste or click to add a photo of the person.">',
        '      <img class="ig-ref-thumb" alt="Person reference" hidden>',
        '      <span class="ig-ref-label">1 · Person</span>',
        '      <button type="button" class="ig-ref-clear" aria-label="Clear person" hidden>×</button>',
        '      <input type="file" class="ig-ref-file" accept="image/*">',
        '    </div>',
        '    <div class="ig-ref-spot ig-ref-product" role="button" tabindex="0" aria-label="Drop product reference image" data-tip="Drop, paste or click to add a photo of the product to wear.">',
        '      <img class="ig-ref-thumb" alt="Product reference" hidden>',
        '      <span class="ig-ref-label">2 · Product</span>',
        '      <button type="button" class="ig-ref-clear" aria-label="Clear product" hidden>×</button>',
        '      <input type="file" class="ig-ref-file" accept="image/*">',
        '    </div>',
        '  </div>'
      ].join('\n') : '',
      '  <div class="ig-stage">',
      '    <img class="ig-img" alt="Generated image preview" hidden>',
      '    <div class="ig-empty">',
      isTryOn
        ? '      <p class="ig-empty-copy">Drop a person (1) and a product (2), then click Try On.</p>'
        : '      <p class="ig-empty-copy">Write a prompt or pick an example.</p><div class="ig-presets ui-hide-compact"></div>',
      '    </div>',
      '    <div class="ig-loading" hidden>',
      '      <div class="ig-spinner" aria-hidden="true"></div>',
      '      <span class="ig-loading-label">Generating 0.0s</span>',
      '    </div>',
      '    <div class="ig-error" role="alert" hidden></div>',
      '  </div>',
      isTryOn ? [
        '  <div class="ig-tryon-bar ui-hide-tiny">',
        '    <span class="ig-tryon-hint" data-tip="Gemini gets a fixed prompt: dress the person in the product.">Fixed try-on prompt</span>',
        '    <select class="ig-aspect" aria-label="Aspect ratio" data-tip="Requested width to height; a model may return its default shape."></select>',
        '    <button type="button" class="ui-btn ui-btn--primary ig-submit" data-tip="Ask Gemini for one image of the person wearing the product.">Try On</button>',
        '  </div>'
      ].join('\n') : [
        '  <form class="ig-form ui-hide-tiny">',
        '    <input type="file" class="ig-ref-file ig-single-ref-file" accept="image/*">',
        '    <button type="button" class="ui-btn ui-btn--sm ig-ref-pill-btn ui-hide-compact" aria-label="Reference image" data-tip="Add an optional reference image (or drop one on the preview); click again to remove it.">+ Ref</button>',
        '    <input type="text" class="ig-prompt" placeholder="Describe an image…" aria-label="Image prompt">',
        '    <select class="ig-aspect ui-hide-compact" aria-label="Aspect ratio" data-tip="Requested width to height; a model may return its default shape."></select>',
        '    <button type="submit" class="ui-btn ui-btn--primary ig-submit" data-tip="Send the prompt to Gemini and draw one image." data-tip-key="Enter">Generate</button>',
        '  </form>'
      ].join('\n'),
      '</div>',
      '<footer class="ui-tile-foot">',
      '  <span class="ig-status ui-truncate">Ready</span>',
      '  <span class="ig-foot-actions" hidden>',
      '    <button type="button" class="ui-btn ui-btn--sm ui-btn--quiet ig-full-btn" data-tip="Open the image full size with its details.">View</button>',
      '    <a class="ui-btn ui-btn--sm ui-btn--quiet ig-dl-btn" download="gemini-image.png">Download</a>',
      '  </span>',
      '</footer>',
      '<dialog class="ui-dialog ig-dialog" aria-label="Generated image full view">',
      '  <header class="ui-studio-bar">',
      '    <span class="ui-tile-index">' + cellIndex + '</span>',
      '    <h2 class="ui-studio-title">' + title + '</h2>',
      '    <div class="ui-studio-actions">',
      '      <a class="ui-btn ig-dialog-dl" download="gemini-image.png">Download</a>',
      '      <button type="button" class="ui-btn ig-dialog-close" data-tip="Back to the grid." data-tip-key="Esc">Close</button>',
      '    </div>',
      '  </header>',
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
    let singleRef = null;
    let personRefSpot = null;
    let productRefSpot = null;

    if (isTryOn) {
      personRefSpot = wireRefSpot(root.querySelector('.ig-ref-person'), '1 · Person', function () {
        showError('');
      });
      productRefSpot = wireRefSpot(root.querySelector('.ig-ref-product'), '2 · Product', function () {
        showError('');
      });
    } else {
      const refBtn = root.querySelector('.ig-ref-pill-btn');
      const refFile = root.querySelector('.ig-single-ref-file');
      refBtn.addEventListener('click', function () {
        if (singleRef) {
          singleRef = null;
          refBtn.textContent = '+ Ref';
          refBtn.removeAttribute('aria-pressed');
        } else {
          refFile.click();
        }
      });
      refFile.addEventListener('change', function () {
        if (refFile.files && refFile.files[0]) {
          readImageFile(refFile.files[0], 1024).then(function (img) {
            singleRef = img;
            refBtn.textContent = 'Ref ✓';
            refBtn.setAttribute('aria-pressed', 'true');
          }).catch(function () {});
          refFile.value = '';
        }
      });
      ['dragenter', 'dragover'].forEach(function (ev) {
        stage.addEventListener(ev, function (e) { e.preventDefault(); });
      });
      stage.addEventListener('drop', function (e) {
        e.preventDefault();
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!f || f.type.indexOf('image/') !== 0) return;
        readImageFile(f, 1024).then(function (img) {
          singleRef = img;
          refBtn.textContent = 'Ref ✓';
          refBtn.setAttribute('aria-pressed', 'true');
          statusEl.textContent = 'Reference attached: ' + img.name;
        }).catch(function () {});
      });
    }

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

    // One vocabulary for the four Gemini tiles (ui/NOTES.md section 0):
    // No key / Key set (idle), Running / Error (rust), Live (green: a call really returned).
    let pillState = null;
    const PILL = {
      none: ['No key', null, 'No Gemini key yet. Click to add one.'],
      key: ['Key set', null, 'Key saved; nothing generated yet. Click to edit the key.'],
      running: ['Running', 'attention', 'Gemini is drawing the image now.'],
      error: ['Error', 'attention', 'The last request failed; the reason is shown on the preview.'],
      live: ['Live', 'ok', 'Your key works: the last image came back from Gemini.']
    };
    function renderPill(next) {
      if (next !== undefined) pillState = next;
      const hasKey = Boolean(client.KeyStore.get());
      if (!hasKey) pillState = null;
      const p = PILL[pillState || (hasKey ? 'key' : 'none')];
      keyBtn.querySelector('.ui-pill-label').textContent = p[0];
      if (p[1]) keyBtn.setAttribute('data-tone', p[1]);
      else keyBtn.removeAttribute('data-tone');
      keyBtn.setAttribute('data-tip', p[2]);
    }

    function refreshKeyState() {
      const hasKey = Boolean(client.KeyStore.get());
      renderPill();
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
        renderPill('running');
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
        submitBtn.textContent = isTryOn ? 'Try On' : 'Generate';
        submitBtn.removeAttribute('aria-pressed');
      }
    }

    async function runGeneration(promptText) {
      if (activeController) {
        activeController.abort();
        activeController = null;
        setBusy(false);
        statusEl.textContent = 'Cancelled';
        renderPill(null);
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

      let prompt = '';
      let referenceImages = [];
      if (isTryOn) {
        const pImg = personRefSpot.get();
        const prodImg = productRefSpot.get();
        if (!pImg || !prodImg) {
          showError('Drop both a Person image (1) and a Product image (2) first.');
          return;
        }
        prompt = TRY_ON_PROMPT;
        referenceImages = [pImg, prodImg];
      } else {
        prompt = String(promptText || (promptInput && promptInput.value) || '').trim();
        if (!prompt) {
          if (promptInput) promptInput.focus();
          return;
        }
        if (singleRef) referenceImages = [singleRef];
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
          referenceImages: referenceImages,
          signal: activeController.signal
        });

        const imgUrl = result.blob ? URL.createObjectURL(result.blob) : result.dataUrl;
        lastResult = Object.assign({ prompt: prompt, aspectRatio: aspectSelect.value, imgUrl: imgUrl }, result);
        imgEl.src = imgUrl;
        imgEl.alt = isTryOn ? 'Virtual try-on result' : prompt;
        imgEl.hidden = false;
        emptyEl.hidden = true;
        stage.classList.add('ig-stage--has-image');

        const ext = result.mimeType === 'image/jpeg' ? 'jpg' : (result.mimeType === 'image/webp' ? 'webp' : 'png');
        const filename = (isTryOn ? 'gemini-tryon-' : 'gemini-') + Date.now() + '.' + ext;
        dlBtn.href = imgUrl;
        dlBtn.download = filename;
        dialogImg.src = imgUrl;
        dialogDl.href = imgUrl;
        dialogDl.download = filename;
        footActions.hidden = false;

        const sec = (result.elapsedMs / 1000).toFixed(1);
        statusEl.textContent = sec + 's · ' + result.model;
        renderPill('live');

        imgEl.onload = function () {
          const dims = imgEl.naturalWidth + '×' + imgEl.naturalHeight;
          statusEl.textContent = sec + 's · ' + dims + ' · ' + result.model;
          dialogMeta.textContent = result.model + ' · ' + dims + ' · ' + sec + 's';
        };
      } catch (err) {
        if (err && err.name === 'AbortError') {
          statusEl.textContent = 'Cancelled';
          renderPill(null);
        } else {
          const msg = (err && err.message) ? err.message : String(err);
          showError(msg);
          statusEl.textContent = 'Error';
          renderPill('error');
        }
      } finally {
        activeController = null;
        setBusy(false);
      }
    }

    if (presetsEl) {
      PRESETS.forEach(function (preset) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ui-chip';
        btn.textContent = preset.label;
        btn.setAttribute('data-tip', 'Fill in this example prompt and generate it now.');
        btn.addEventListener('click', function () {
          promptInput.value = preset.prompt;
          runGeneration(preset.prompt);
        });
        presetsEl.appendChild(btn);
      });
    }

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

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        runGeneration(promptInput.value);
      });
    } else {
      submitBtn.addEventListener('click', function () {
        runGeneration(TRY_ON_PROMPT);
      });
    }

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

  function initAllImageGenCells() {
    const nodes = document.querySelectorAll('.cell--image-gen');
    for (let i = 0; i < nodes.length; i++) {
      const idx = nodes[i].getAttribute('data-cell-index') || String(10 + i);
      mountImageGenCell(nodes[i], idx);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAllImageGenCells);
  } else {
    initAllImageGenCells();
  }
})(window);
