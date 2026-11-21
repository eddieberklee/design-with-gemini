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

  const REF_MAX_DIM = 1024;
  const THUMB_DIM = 256;

  // Reads a reference image through a short-lived object URL (no base64 copy of the original
  // file), downscales it to REF_MAX_DIM on a white canvas (JPEG has no alpha: a transparent
  // product PNG would otherwise turn black) and returns the JPEG base64 for the request plus a
  // small thumbnail. Rejects with a message the tile shows.
  function readImageFile(file, maxDim) {
    return new Promise(function (resolve, reject) {
      const problem = global.GeminiImageGen.checkReferenceFile(file);
      if (problem) {
        reject(new Error(problem));
        return;
      }
      const src = URL.createObjectURL(file);
      const img = new Image();
      img.onerror = function () {
        URL.revokeObjectURL(src);
        reject(new Error('Could not read ' + (file.name || 'that image') + '. Use a PNG, JPEG or WebP file.'));
      };
      img.onload = function () {
        URL.revokeObjectURL(src);
        const limit = maxDim || REF_MAX_DIM;
        const scale = Math.min(1, limit / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, w, h);
        g.drawImage(img, 0, 0, w, h);
        const data = c.toDataURL('image/jpeg', 0.88).split(',')[1] || '';
        const ts = Math.min(1, THUMB_DIM / Math.max(w, h));
        const t = document.createElement('canvas');
        t.width = Math.max(1, Math.round(w * ts));
        t.height = Math.max(1, Math.round(h * ts));
        t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
        c.width = 0;
        c.height = 0;
        resolve({
          data: data,
          mimeType: 'image/jpeg',
          name: file.name || 'image.jpg',
          width: w,
          height: h,
          thumbUrl: t.toDataURL('image/jpeg', 0.8)
        });
      };
      img.src = src;
    });
  }

  function firstImageFile(list) {
    if (!list) return null;
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].kind === 'file') {
        const f = list[i].getAsFile();
        if (f) return f;
      } else if (list[i] && typeof list[i].name === 'string') {
        return list[i];
      }
    }
    return null;
  }

  function wireRefSpot(spotEl, defaultLabel, onChange, onError) {
    const client = global.GeminiImageGen;
    const thumb = spotEl.querySelector('.ig-ref-thumb');
    const label = spotEl.querySelector('.ig-ref-label');
    const clearBtn = spotEl.querySelector('.ig-ref-clear');
    const input = spotEl.querySelector('.ig-ref-file');
    const guard = client.createLatestGuard();

    let current = null;

    function setFile(file) {
      const token = guard.next();
      readImageFile(file, REF_MAX_DIM).then(function (img) {
        if (!guard.isLatest(token)) return;
        current = img;
        thumb.src = img.thumbUrl;
        thumb.hidden = false;
        label.textContent = img.name;
        clearBtn.hidden = false;
        spotEl.classList.add('ig-ref-spot--filled');
        onChange(current);
      }).catch(function (err) {
        if (guard.isLatest(token)) onError(err && err.message ? err.message : String(err));
      });
    }

    function clear(e) {
      if (e) e.stopPropagation();
      guard.invalidate();
      current = null;
      thumb.hidden = true;
      thumb.removeAttribute('src');
      label.textContent = defaultLabel;
      clearBtn.hidden = true;
      spotEl.classList.remove('ig-ref-spot--filled');
      onChange(null);
    }

    spotEl.addEventListener('click', function (e) {
      // The hidden file input sits inside the spot: its own click bubbles back here.
      if (e.target === input || clearBtn.contains(e.target)) return;
      input.click();
    });
    spotEl.addEventListener('keydown', function (e) {
      if (e.target !== spotEl) return; // Enter on the clear button must clear, not open the picker
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
      const file = firstImageFile(e.dataTransfer && e.dataTransfer.files);
      if (file) setFile(file);
    });
    // Paste an image while the slot has focus.
    spotEl.addEventListener('paste', function (e) {
      const file = firstImageFile(e.clipboardData && e.clipboardData.items);
      if (file) {
        e.preventDefault();
        setFile(file);
      }
    });

    return {
      get: function () { return current; },
      clear: clear
    };
  }

  const GENERATE_TIP = 'Send the prompt to the selected model; each image is billed to your key.';
  const TRY_ON_TIP = 'Send both photos and the fixed prompt to the model; billed to your key.';

  function mountImageGenCell(root, cellIndex) {
    const client = global.GeminiImageGen;
    if (!root || !client) return;

    const isTryOn = root.getAttribute('data-mode') === 'try-on';
    const title = isTryOn ? 'Virtual Try-On' : 'Image Gen';
    const submitLabel = isTryOn ? 'Try On' : 'Generate';

    root.classList.add('ui-tile');
    const slot = function (cls, name, tip) {
      return [
        '    <div class="ig-ref-spot ' + cls + '" role="button" tabindex="0" aria-label="' + name + ' photo: pick, drop or paste an image" data-tip="' + tip + '">',
        '      <img class="ig-ref-thumb" alt="' + name + ' reference" hidden>',
        '      <span class="ig-ref-label">' + name + '</span>',
        '      <span class="ig-ref-hint">Drop, paste or click</span>',
        '      <button type="button" class="ui-btn ui-btn--sm ui-btn--icon ig-ref-clear" aria-label="Remove ' + name.toLowerCase() + ' photo" data-tip="Remove this photo." hidden>×</button>',
        '      <input type="file" class="ig-ref-file" accept="image/*" tabindex="-1">',
        '    </div>'
      ].join('\n');
    };

    const stageHtml = [
      '  <div class="ig-stage" style="--ig-ar: 1.3333">',
      '    <div class="ig-frame" aria-hidden="true"><span class="ig-frame-ratio">4:3</span></div>',
      '    <img class="ig-img" alt="Generated image preview" role="button" tabindex="0" data-tip="View full size with download." hidden>',
      '    <div class="ig-empty">',
      isTryOn
        ? '      <p class="ig-empty-copy">The try-on appears here.</p>'
        : '      <p class="ig-empty-copy">Write a prompt or pick an example.</p><div class="ig-presets"></div>',
      '    </div>',
      '    <div class="ig-loading" hidden>',
      '      <span class="ui-label">Generating</span>',
      '      <span class="ui-readout ui-readout--hero"><span class="ig-loading-label">0.0</span><span class="ui-readout-unit">s</span></span>',
      '    </div>',
      '    <div class="ig-error" role="alert" hidden></div>',
      '  </div>'
    ].join('\n');

    root.classList.add('ui-tile');
    root.innerHTML = [
      '<header class="ui-tile-head">',
      '  <span class="ui-tile-index">' + cellIndex + '</span>',
      '  <h2 class="ui-tile-title">' + title + '</h2>',
      '  <div class="ui-tile-actions">',
      '    <button type="button" class="ui-pill ig-key-btn" aria-expanded="false">',
      '      <span class="ui-pill-label">No key</span>',
      '    </button>',
      '    <select class="ig-select ig-model-select ui-hide-compact" aria-label="Image model"',
      '      data-tip="Gemini model that draws the image; the list updates from your key on first ' + submitLabel + '."></select>',
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
      isTryOn ? [
        '  <div class="ig-tryon">',
        '    <div class="ig-refs">',
        slot('ig-ref-person', 'Person', 'Photo of the person to dress: click to pick, or drop or paste an image.'),
        '      <span class="ig-join" aria-hidden="true">+</span>',
        slot('ig-ref-product', 'Product', 'Photo of the product to put on them: click to pick, or drop or paste an image.'),
        '    </div>',
        '    <span class="ig-join ig-join--arrow" aria-hidden="true">→</span>',
        stageHtml,
        '  </div>',
        '  <div class="ig-form ig-tryon-bar ui-hide-tiny">',
        '    <span class="ig-tryon-hint ui-label" data-tip="A built-in prompt: keep the person\'s face, body and pose; put the product on them.">Fixed prompt</span>',
        '    <select class="ig-select ig-aspect ui-hide-compact" aria-label="Aspect ratio"',
        '      data-tip="Requested width to height; a model that rejects it returns its default shape."></select>',
        '    <button type="button" class="ui-btn ui-btn--primary ig-submit">Try On</button>',
        '  </div>'
      ].join('\n') : [
        stageHtml,
        '  <form class="ig-form ui-hide-tiny">',
        '    <input type="file" class="ig-ref-file ig-single-ref-file" accept="image/*" tabindex="-1">',
        '    <button type="button" class="ui-btn ig-ref-pill-btn" aria-label="Reference image">',
        '      <img class="ig-ref-pill-thumb" alt="" hidden><span class="ig-ref-pill-label">+ Ref</span></button>',
        '    <input type="text" class="ig-prompt" placeholder="Describe an image…" aria-label="Image prompt">',
        '    <select class="ig-select ig-aspect ui-hide-compact" aria-label="Aspect ratio"',
        '      data-tip="Requested width to height; a model that rejects it returns its default shape."></select>',
        '    <button type="submit" class="ui-btn ui-btn--primary ig-submit">Generate</button>',
        '  </form>'
      ].join('\n'),
      '</div>',
      '<footer class="ui-tile-foot">',
      '  <span class="ig-status ui-truncate">No image yet</span>',
      '  <span class="ig-foot-actions" hidden>',
      '    <button type="button" class="ui-btn ui-btn--sm ui-btn--quiet ig-full-btn" data-tip="Open the image full size with download.">View</button>',
      '    <a class="ui-btn ui-btn--sm ui-btn--quiet ig-dl-btn" download="gemini-image.png">Download</a>',
      '  </span>',
      '</footer>',
      '<dialog class="ui-dialog ig-dialog" aria-labelledby="ig-dialog-title-' + cellIndex + '">',
      '  <header class="ui-studio-bar">',
      '    <span class="ui-tile-index">' + cellIndex + '</span>',
      '    <h2 class="ui-studio-title" id="ig-dialog-title-' + cellIndex + '">' + (isTryOn ? 'Try-on result' : 'Generated image') + '</h2>',
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
    const form = root.querySelector('form.ig-form');
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
    let busySince = 0;
    let lastResult = null;
    let imageUrl = '';
    let modelsDiscoveredForKey = '';
    let singleRef = null;
    let personRefSpot = null;
    let productRefSpot = null;

    function refError(msg) {
      showError(msg);
      statusEl.textContent = 'Reference not added';
    }

    if (isTryOn) {
      personRefSpot = wireRefSpot(root.querySelector('.ig-ref-person'), 'Person', function () {
        showError('');
      }, refError);
      productRefSpot = wireRefSpot(root.querySelector('.ig-ref-product'), 'Product', function () {
        showError('');
      }, refError);
      // A file dropped on the result area must not make the browser open it in place of the page.
      ['dragover', 'drop'].forEach(function (ev) {
        stage.addEventListener(ev, function (e) { e.preventDefault(); });
      });
    } else {
      const refBtn = root.querySelector('.ig-ref-pill-btn');
      const refFile = root.querySelector('.ig-single-ref-file');
      const refGuard = client.createLatestGuard();

      const refThumb = refBtn.querySelector('.ig-ref-pill-thumb');
      const refLabel = refBtn.querySelector('.ig-ref-pill-label');
      const REF_TIP_EMPTY = 'Add one image the model should use; you can also drop it here or paste it.';
      const setSingleRef = function (img) {
        singleRef = img;
        refLabel.textContent = img ? 'Ref' : '+ Ref';
        refThumb.hidden = !img;
        if (img) refThumb.src = img.thumbUrl;
        else refThumb.removeAttribute('src');
        refBtn.setAttribute('data-tip', img
          ? 'Sending ' + img.name + ' with each prompt. Click to remove it.'
          : REF_TIP_EMPTY);
        if (img) {
          refBtn.setAttribute('aria-pressed', 'true');
          statusEl.textContent = 'Reference attached: ' + img.name;
        } else {
          refBtn.removeAttribute('aria-pressed');
          statusEl.textContent = 'Reference removed';
        }
      };

      const attach = function (file) {
        const token = refGuard.next();
        readImageFile(file, REF_MAX_DIM).then(function (img) {
          if (!refGuard.isLatest(token)) return;
          showError('');
          setSingleRef(img);
        }).catch(function (err) {
          if (refGuard.isLatest(token)) refError(err && err.message ? err.message : String(err));
        });
      };

      refBtn.setAttribute('data-tip', REF_TIP_EMPTY);
      refBtn.addEventListener('click', function () {
        if (singleRef) {
          refGuard.invalidate();
          setSingleRef(null);
        } else {
          refFile.click();
        }
      });
      refFile.addEventListener('change', function () {
        if (refFile.files && refFile.files[0]) {
          attach(refFile.files[0]);
          refFile.value = '';
        }
      });
      ['dragenter', 'dragover'].forEach(function (ev) {
        stage.addEventListener(ev, function (e) { e.preventDefault(); });
      });
      stage.addEventListener('drop', function (e) {
        e.preventDefault();
        const f = firstImageFile(e.dataTransfer && e.dataTransfer.files);
        if (f) attach(f);
      });
      // Pasting an image into the prompt attaches it as the reference; pasted text is untouched.
      promptInput.addEventListener('paste', function (e) {
        const items = e.clipboardData && e.clipboardData.items;
        let file = null;
        for (let i = 0; items && i < items.length; i++) {
          if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
            file = items[i].getAsFile();
            break;
          }
        }
        if (file) {
          e.preventDefault();
          attach(file);
        }
      });
    }

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
    // once per key per tile, and is not awaited.
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

    // Status pill, one vocabulary with the other Gemini tiles (ui/NOTES.md section 0): No key /
    // Key set idle grey, Running / Error rust, Live green only after an image came back and decoded.
    // A click opens the key bar.
    let phase = 'idle'; // idle | busy | error | done
    const PILL = {
      nokey: { label: 'No key', tone: '', tip: 'No Gemini API key yet. Click to paste one; the Gemini tiles share it.' },
      idle: { label: 'Key set', tone: '', tip: 'Key saved; ' + submitLabel + ' is ready. Click to replace or clear the key.' },
      busy: { label: 'Running', tone: 'attention', tip: 'Waiting for the model; ' + submitLabel + ' is now Cancel. Click to manage the key.' },
      error: { label: 'Error', tone: 'attention', tip: 'The last request failed; the reason is shown on the image. Click to manage the key.' },
      done: { label: 'Live', tone: 'ok', tip: 'Your key works: the last image came back from Gemini and decoded. Click to manage the key.' }
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

    function syncAspectFrame() {
      const parts = String(aspectSelect.value || '4:3').split(':');
      const ar = Number(parts[0]) / Number(parts[1]);
      stage.style.setProperty('--ig-ar', Number.isFinite(ar) && ar > 0 ? ar.toFixed(4) : '1.3333');
      root.querySelector('.ig-frame-ratio').textContent = aspectSelect.value;
    }

    // Repaints only: no request is ever sent from here.
    function refreshKeyState() {
      const key = client.KeyStore.get();
      const hasKey = Boolean(key);
      renderPill();
      keyInput.placeholder = hasKey
        ? 'Saved ' + client.KeyStore.mask(key) + ' · paste a new key to replace'
        : 'Paste Gemini API key (AIza...)';
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
        submitBtn.textContent = submitLabel;
        submitBtn.removeAttribute('aria-pressed');
        submitBtn.setAttribute('data-tip', isTryOn ? TRY_ON_TIP : GENERATE_TIP);
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
      lastResult = { prompt: prompt, model: result.model, mimeType: result.mimeType };
      imgEl.src = url;
      imgEl.alt = isTryOn ? 'Virtual try-on result' : prompt;
      imgEl.hidden = false;
      emptyEl.hidden = true;
      stage.classList.add('ig-stage--has-image');

      const ext = result.mimeType === 'image/jpeg' ? 'jpg' : (result.mimeType === 'image/webp' ? 'webp' : 'png');
      const filename = (isTryOn ? 'gemini-tryon-' : 'gemini-') + Date.now() + '.' + ext;
      dlBtn.href = url;
      dlBtn.download = filename;
      dialogImg.src = url;
      dialogDl.href = url;
      dialogDl.download = filename;
      footActions.hidden = false;

      const sec = (result.elapsedMs / 1000).toFixed(1);
      statusEl.textContent = sec + 's · ' + dims + ' · ' + result.model;
      dialogMeta.querySelector('.ig-dialog-prompt').textContent =
        isTryOn ? 'Person and product photos with the fixed try-on prompt.' : prompt;
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

      let prompt = '';
      let referenceImages = [];
      if (isTryOn) {
        const pImg = personRefSpot.get();
        const prodImg = productRefSpot.get();
        if (!pImg || !prodImg) {
          showError(!pImg && !prodImg
            ? 'Add a person photo and a product photo first.'
            : (!pImg ? 'Add a person photo first.' : 'Add a product photo first.'));
          return;
        }
        prompt = TRY_ON_PROMPT;
        referenceImages = [pImg, prodImg];
      } else {
        prompt = String(promptInput.value || '').trim();
        if (!prompt) {
          statusEl.textContent = 'Enter a prompt first';
          promptInput.focus();
          return;
        }
        if (singleRef) referenceImages = [singleRef];
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
          referenceImages: referenceImages,
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
          showError((err && err.message) ? err.message : String(err));
          statusEl.textContent = 'Error';
          setPhase('error');
        }
      } finally {
        if (runSlot.finish(ctrl)) setBusy(false);
      }
    }

    // Preset chips only fill the prompt: generating costs money, so only Generate sends.
    if (presetsEl) {
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
    }

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

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        runGeneration();
      });
    } else {
      submitBtn.addEventListener('click', function () {
        runGeneration();
      });
    }

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
    // The footer button hides on compact tiles; the image itself is the keyboard path there.
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

    aspectSelect.addEventListener('change', syncAspectFrame);

    populateModels(client.DEFAULT_MODELS);
    populateAspects();
    syncAspectFrame();
    submitBtn.setAttribute('data-tip', isTryOn ? TRY_ON_TIP : GENERATE_TIP);
    if (!isTryOn) submitBtn.setAttribute('data-tip-key', 'Enter');
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
