/**
 * Freehand Drawing Sketchpad UI (`cells/draw/ui.js`)
 *
 * Pure Zero-Chrome Sketchpad (Apple Notes / Teenage Engineering Minimalism):
 *   - Mounts into `<section class="cell cell--draw" id="cell-draw">` using
 *     strictly `document.createElement` / `document.createElementNS` + `textContent`.
 *   - Strictly one `<button>` (`Clear`) with `aria-disabled="true"` when empty
 *     (never `disabled = true`, preserving keyboard focus), `stopPropagation()` on
 *     `pointerdown`, and `:focus-visible` `var(--dw-focus)` ring.
 *   - Standard synchronized 2D context (`canvas.getContext('2d')`) + exact-edge
 *     fractional-grid `ctx.setTransform(targetW / rect.width, 0, 0, targetH / rect.height, 0, 0)`
 *     + cross-monitor DPR media-query watcher.
 *   - Full-bleed `<canvas>` with `{ passive: false }` `touchstart`/`touchmove`
 *     `preventDefault()` ONLY on `<canvas>` so mobile `Clear` tap synthesis works.
 *   - Unified Pointer Events (`pointerdown`, `pointermove`, `pointerup`,
 *     `pointercancel`, `lostpointercapture`) + `window` `blur` + `document`
 *     `visibilitychange`, primary mouse button gate, single `activePointerId` lock,
 *     macOS Mission Control / 3-finger-drag dropped-release `(e.buttons & 1) === 0`
 *     guard, and `getCoalescedEvents()` empty-array fallback.
 *   - Zero global `window` keyboard shortcuts (coexists with `MotionGrid` `r`/`R`),
 *     60fps `ResizeObserver` vector replay across `140x105px`..`960x720px`, and
 *     live `--dw-ink` re-inking on `[data-theme="dark"]` changes.
 */
(function (root, factory) {
  'use strict';
  const uiApi = factory(root);
  if (root && typeof root === 'object') {
    const ns = (root.GeminiDraw = root.GeminiDraw || {});
    ns.UI = uiApi;
    ns.mount = uiApi.mount;
    if (typeof globalThis === 'object' && globalThis && globalThis !== root) {
      globalThis.GeminiDraw = ns;
    }
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = uiApi;
  }
})(
  typeof window !== 'undefined'
    ? window
    : typeof globalThis !== 'undefined'
      ? globalThis
      : this,
  function (root) {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const CLEAR_FADE_MS = 130;

    function resolveEngine() {
      if (root && root.GeminiDraw && root.GeminiDraw.Engine) {
        return root.GeminiDraw.Engine;
      }
      if (typeof require === 'function') {
        try {
          return require('./engine.js');
        } catch (_err) {
          return null;
        }
      }
      return null;
    }

    function clearChildren(node) {
      while (node.firstChild) {
        node.removeChild(node.firstChild);
      }
    }

    function resolveEventTimeMs(sample, fallbackEvent, win) {
      if (
        sample &&
        typeof sample.timeStamp === 'number' &&
        Number.isFinite(sample.timeStamp) &&
        sample.timeStamp >= 0
      ) {
        if (sample.timeStamp > 0 || !fallbackEvent || !(fallbackEvent.timeStamp > 0)) {
          return sample.timeStamp;
        }
      }
      if (
        fallbackEvent &&
        typeof fallbackEvent.timeStamp === 'number' &&
        Number.isFinite(fallbackEvent.timeStamp) &&
        fallbackEvent.timeStamp >= 0
      ) {
        return fallbackEvent.timeStamp;
      }
      if (win && win.performance && typeof win.performance.now === 'function') {
        return win.performance.now();
      }
      return Date.now();
    }

    function buildPenNibSvg(doc) {
      const svg = doc.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'dw-empty-icon');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.35');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');

      const bodyPath = doc.createElementNS(SVG_NS, 'path');
      bodyPath.setAttribute('d', 'M11.3 2.3a1.4 1.4 0 0 1 2 2L5.6 12l-2.9.7.7-2.9 7.9-7.5Z');

      const collarPath = doc.createElementNS(SVG_NS, 'path');
      collarPath.setAttribute('d', 'M9.8 3.8l2 2');

      svg.appendChild(bodyPath);
      svg.appendChild(collarPath);
      return svg;
    }

    function mount(rootEl, customOptions) {
      const Engine = (customOptions && customOptions.engine) || resolveEngine();
      if (!rootEl || !Engine) return null;

      if (rootEl.__geminiDrawInstance && typeof rootEl.__geminiDrawInstance.destroy === 'function') {
        rootEl.__geminiDrawInstance.destroy();
      }

      const doc = rootEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
      if (!doc) return null;
      const win = doc.defaultView || (typeof window !== 'undefined' ? window : root);

      clearChildren(rootEl);
      rootEl.classList.add('cell--draw');
      rootEl.classList.remove('has-ink', 'is-drawing', 'is-clearing');

      const canvas = doc.createElement('canvas');
      canvas.className = 'dw-canvas';
      canvas.setAttribute('aria-label', 'Drawing surface');

      const paperVeil = doc.createElement('div');
      paperVeil.className = 'dw-paper-veil';
      paperVeil.setAttribute('aria-hidden', 'true');

      const emptyCue = doc.createElement('div');
      emptyCue.className = 'dw-empty';
      emptyCue.setAttribute('aria-hidden', 'true');
      const emptyIcon = buildPenNibSvg(doc);
      const emptyLabel = doc.createElement('span');
      emptyLabel.className = 'dw-empty-label';
      emptyLabel.textContent = 'Draw';
      emptyCue.appendChild(emptyIcon);
      emptyCue.appendChild(emptyLabel);

      const clearBtn = doc.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'dw-clear';
      clearBtn.setAttribute('aria-disabled', 'true');
      clearBtn.setAttribute('aria-label', 'Clear canvas');
      clearBtn.textContent = 'Clear';

      const liveStatus = doc.createElement('span');
      liveStatus.className = 'dw-sr-only';
      liveStatus.setAttribute('role', 'status');
      liveStatus.setAttribute('aria-live', 'polite');
      liveStatus.setAttribute('aria-atomic', 'true');

      rootEl.appendChild(canvas);
      rootEl.appendChild(paperVeil);
      rootEl.appendChild(emptyCue);
      rootEl.appendChild(clearBtn);
      rootEl.appendChild(liveStatus);

      const engine = Engine.createEngine(customOptions && customOptions.engineOptions);
      const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;

      let activePointerId = null;
      let cssW = 0;
      let cssH = 0;
      let currentDpr = 1;
      let currentInk = Engine.DEFAULT_INK;
      let clearTimerId = 0;
      let announceTimerId = 0;
      let clearPhaseToggle = false;
      let dprMediaQuery = null;

      function prefersReducedMotion() {
        if (win && typeof win.matchMedia === 'function') {
          const mq = win.matchMedia('(prefers-reduced-motion: reduce)');
          return Boolean(mq && mq.matches);
        }
        return false;
      }

      function announcePolite(message) {
        if (announceTimerId && win && typeof win.clearTimeout === 'function') {
          win.clearTimeout(announceTimerId);
          announceTimerId = 0;
        }
        liveStatus.textContent = '';
        if (!message) return;
        if (win && typeof win.setTimeout === 'function') {
          announceTimerId = win.setTimeout(function () {
            announceTimerId = 0;
            liveStatus.textContent = message;
          }, 16);
          if (announceTimerId && typeof announceTimerId.unref === 'function') {
            announceTimerId.unref();
          }
        } else {
          liveStatus.textContent = message;
        }
      }

      function readInkColor() {
        if (win && typeof win.getComputedStyle === 'function') {
          const computed = win.getComputedStyle(rootEl);
          if (computed && typeof computed.getPropertyValue === 'function') {
            const val = computed.getPropertyValue('--dw-ink').trim();
            if (val) {
              currentInk = val;
              return currentInk;
            }
          }
        }
        const isDark =
          (typeof rootEl.getAttribute === 'function' && rootEl.getAttribute('data-theme') === 'dark') ||
          (doc.body && typeof doc.body.getAttribute === 'function' && doc.body.getAttribute('data-theme') === 'dark') ||
          (doc.documentElement &&
            typeof doc.documentElement.getAttribute === 'function' &&
            doc.documentElement.getAttribute('data-theme') === 'dark');
        currentInk = isDark ? '#f5f5f3' : Engine.DEFAULT_INK;
        return currentInk;
      }

      function measureRect() {
        const rect = typeof canvas.getBoundingClientRect === 'function'
          ? canvas.getBoundingClientRect()
          : null;
        if (rect && rect.width > 0 && rect.height > 0) {
          return rect;
        }
        const rootRect = typeof rootEl.getBoundingClientRect === 'function'
          ? rootEl.getBoundingClientRect()
          : null;
        if (rootRect && rootRect.width > 0 && rootRect.height > 0) {
          return rootRect;
        }
        const fallbackW = canvas.clientWidth || rootEl.clientWidth || 0;
        const fallbackH = canvas.clientHeight || rootEl.clientHeight || 0;
        return {
          left: 0,
          top: 0,
          width: fallbackW,
          height: fallbackH
        };
      }

      function unbindDprMediaListener() {
        if (!dprMediaQuery) return;
        if (typeof dprMediaQuery.removeEventListener === 'function') {
          dprMediaQuery.removeEventListener('change', onDprMediaChange);
        } else if (typeof dprMediaQuery.removeListener === 'function') {
          dprMediaQuery.removeListener(onDprMediaChange);
        }
        dprMediaQuery = null;
      }

      function bindDprMediaListener(rawDpr) {
        unbindDprMediaListener();
        if (!win || typeof win.matchMedia !== 'function') return;
        const safeDpr = Number.isFinite(rawDpr) && rawDpr > 0 ? rawDpr : 1;
        const mq = win.matchMedia('(resolution: ' + safeDpr + 'dppx)');
        if (!mq) return;
        if (typeof mq.addEventListener === 'function') {
          mq.addEventListener('change', onDprMediaChange);
          dprMediaQuery = mq;
        } else if (typeof mq.addListener === 'function') {
          mq.addListener(onDprMediaChange);
          dprMediaQuery = mq;
        }
      }

      function onDprMediaChange() {
        const rawDpr = win && typeof win.devicePixelRatio === 'number' ? win.devicePixelRatio : 1;
        bindDprMediaListener(rawDpr);
        syncCanvasBackingStore(false);
      }

      function syncCanvasBackingStore(forceReplay) {
        const rect = measureRect();
        if (!(rect.width > 0) || !(rect.height > 0)) {
          if (activePointerId !== null) {
            finalizeActiveStroke(null);
          }
          return;
        }

        const rawDpr = win && typeof win.devicePixelRatio === 'number' ? win.devicePixelRatio : 1;
        const dpr = Math.min(Math.max(rawDpr || 1, 1), 3);
        const targetW = Math.max(1, Math.round(rect.width * dpr));
        const targetH = Math.max(1, Math.round(rect.height * dpr));

        const sizeChanged =
          canvas.width !== targetW ||
          canvas.height !== targetH ||
          Math.abs(rect.width - cssW) > 0.05 ||
          Math.abs(rect.height - cssH) > 0.05 ||
          dpr !== currentDpr;

        if (!sizeChanged && !forceReplay) return;

        cssW = rect.width;
        cssH = rect.height;
        if (dpr !== currentDpr) {
          currentDpr = dpr;
          bindDprMediaListener(rawDpr);
        }

        if (canvas.width !== targetW) canvas.width = targetW;
        if (canvas.height !== targetH) canvas.height = targetH;

        readInkColor();
        if (ctx) {
          if (typeof ctx.setTransform === 'function') {
            ctx.setTransform(targetW / rect.width, 0, 0, targetH / rect.height, 0, 0);
          }
          Engine.renderAllStrokes(
            ctx,
            engine.getStrokes(),
            engine.getActiveStroke(),
            cssW,
            cssH,
            currentInk
          );
        }
      }

      function syncUiState() {
        const hasInk = !engine.isEmpty();
        const isDrawing = activePointerId !== null;
        rootEl.classList.toggle('has-ink', hasInk);
        rootEl.classList.toggle('is-drawing', isDrawing);
        clearBtn.setAttribute('aria-disabled', hasInk ? 'false' : 'true');
      }

      function cancelClearVeil() {
        if (clearTimerId && win && typeof win.clearTimeout === 'function') {
          win.clearTimeout(clearTimerId);
          clearTimerId = 0;
        }
        rootEl.classList.remove('is-clearing');
      }

      function tryReleasePointerCapture(pointerId) {
        try {
          if (
            typeof canvas.hasPointerCapture === 'function' &&
            typeof canvas.releasePointerCapture === 'function' &&
            canvas.hasPointerCapture(pointerId)
          ) {
            canvas.releasePointerCapture(pointerId);
          }
        } catch (_err) {
          // Ignore synthetic/non-captured pointer release errors
        }
      }

      function finalizeActiveStroke(finalEvent) {
        if (activePointerId === null) return;
        const endedPointerId = activePointerId;
        activePointerId = null;

        let finalInput = null;
        if (finalEvent && Number.isFinite(finalEvent.clientX) && Number.isFinite(finalEvent.clientY)) {
          const rect = measureRect();
          if (rect.width > 0 && rect.height > 0) {
            finalInput = {
              clientX: finalEvent.clientX,
              clientY: finalEvent.clientY,
              rect: rect,
              pointerType: finalEvent.pointerType || 'mouse',
              pressure: typeof finalEvent.pressure === 'number' ? finalEvent.pressure : 0,
              timeMs: resolveEventTimeMs(finalEvent, null, win)
            };
          }
        }

        const result = engine.endStroke(finalInput);
        if (result && ctx && cssW > 0 && cssH > 0) {
          for (let i = 0; i < result.ops.length; i++) {
            Engine.drawOp(ctx, result.ops[i], cssW, cssH, currentInk);
          }
        }

        tryReleasePointerCapture(endedPointerId);
        syncUiState();
      }

      function onPointerDown(e) {
        if (!e) return;
        if (e.pointerType === 'mouse' && typeof e.button === 'number' && e.button !== 0) {
          return;
        }
        if (activePointerId !== null) {
          return;
        }

        cancelClearVeil();
        syncCanvasBackingStore(false);
        const rect = measureRect();
        if (!(rect.width > 0) || !(rect.height > 0)) return;

        readInkColor();
        activePointerId = typeof e.pointerId === 'number' ? e.pointerId : 1;

        try {
          if (typeof canvas.setPointerCapture === 'function' && typeof e.pointerId === 'number') {
            canvas.setPointerCapture(e.pointerId);
          }
        } catch (_err) {
          // Ignore synthetic events without active browser pointer registry
        }

        const op = engine.beginStroke({
          clientX: e.clientX,
          clientY: e.clientY,
          rect: rect,
          pointerType: e.pointerType || 'mouse',
          pressure: typeof e.pressure === 'number' ? e.pressure : 0,
          timeMs: resolveEventTimeMs(e, null, win)
        });

        if (!op) {
          activePointerId = null;
          return;
        }

        announcePolite('');
        syncUiState();

        if (ctx) {
          Engine.drawOp(ctx, op, rect.width, rect.height, currentInk);
        }
      }

      function onPointerMove(e) {
        if (!e || activePointerId === null) return;
        const pid = typeof e.pointerId === 'number' ? e.pointerId : 1;
        if (pid !== activePointerId) return;

        if (e.pointerType === 'mouse' && typeof e.buttons === 'number' && (e.buttons & 1) === 0) {
          finalizeActiveStroke(null);
          return;
        }

        const rect = measureRect();
        if (!(rect.width > 0) || !(rect.height > 0)) return;

        const coalesced =
          typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
        const samples = coalesced && coalesced.length > 0 ? coalesced : [e];

        for (let i = 0; i < samples.length; i++) {
          const sample = samples[i] || e;
          const op = engine.appendPoint({
            clientX: sample.clientX,
            clientY: sample.clientY,
            rect: rect,
            pointerType: sample.pointerType || e.pointerType || 'mouse',
            pressure:
              typeof sample.pressure === 'number'
                ? sample.pressure
                : typeof e.pressure === 'number'
                  ? e.pressure
                  : 0,
            timeMs: resolveEventTimeMs(sample, e, win)
          });
          if (op && ctx) {
            Engine.drawOp(ctx, op, rect.width, rect.height, currentInk);
          }
        }
      }

      function onPointerUp(e) {
        if (!e || activePointerId === null) return;
        const pid = typeof e.pointerId === 'number' ? e.pointerId : 1;
        if (pid !== activePointerId) return;
        finalizeActiveStroke(e);
      }

      function onPointerCancel(e) {
        if (!e || activePointerId === null) return;
        const pid = typeof e.pointerId === 'number' ? e.pointerId : 1;
        if (pid !== activePointerId) return;
        finalizeActiveStroke(null);
      }

      function onLostPointerCapture(e) {
        if (!e || activePointerId === null) return;
        const pid = typeof e.pointerId === 'number' ? e.pointerId : 1;
        if (pid !== activePointerId) return;
        finalizeActiveStroke(null);
      }

      function onCanvasTouchPreventDefault(e) {
        if (e && e.cancelable !== false && typeof e.preventDefault === 'function') {
          e.preventDefault();
        }
      }

      function onCanvasContextMenu(e) {
        if (e && typeof e.preventDefault === 'function') {
          e.preventDefault();
        }
      }

      function onClearPointerDown(e) {
        if (e && typeof e.stopPropagation === 'function') {
          e.stopPropagation();
        }
      }

      function clearCanvas() {
        if (clearBtn.getAttribute('aria-disabled') === 'true' || engine.isEmpty()) {
          return false;
        }
        if (activePointerId !== null) {
          const prevPid = activePointerId;
          activePointerId = null;
          tryReleasePointerCapture(prevPid);
        }
        engine.clear();

        if (ctx && cssW > 0 && cssH > 0) {
          ctx.clearRect(0, 0, cssW + 1, cssH + 1);
        }

        syncUiState();
        announcePolite('Canvas cleared');

        cancelClearVeil();
        if (!prefersReducedMotion() && win && typeof win.setTimeout === 'function') {
          clearPhaseToggle = !clearPhaseToggle;
          rootEl.setAttribute('data-clear-phase', clearPhaseToggle ? 'a' : 'b');
          rootEl.classList.add('is-clearing');
          clearTimerId = win.setTimeout(function () {
            clearTimerId = 0;
            rootEl.classList.remove('is-clearing');
          }, CLEAR_FADE_MS);
          if (clearTimerId && typeof clearTimerId.unref === 'function') {
            clearTimerId.unref();
          }
        }
        return true;
      }

      function onClearClick() {
        clearCanvas();
      }

      function onWindowBlur() {
        finalizeActiveStroke(null);
      }

      function onVisibilityChange() {
        if (doc.hidden || doc.visibilityState === 'hidden') {
          finalizeActiveStroke(null);
        }
      }

      function onWindowResize() {
        syncCanvasBackingStore(false);
      }

      function onThemeMutation() {
        const prevInk = currentInk;
        const nextInk = readInkColor();
        if (nextInk !== prevInk && ctx && cssW > 0 && cssH > 0) {
          Engine.renderAllStrokes(
            ctx,
            engine.getStrokes(),
            engine.getActiveStroke(),
            cssW,
            cssH,
            currentInk
          );
        }
      }

      canvas.addEventListener('pointerdown', onPointerDown);
      canvas.addEventListener('pointermove', onPointerMove);
      canvas.addEventListener('pointerup', onPointerUp);
      canvas.addEventListener('pointercancel', onPointerCancel);
      canvas.addEventListener('lostpointercapture', onLostPointerCapture);
      canvas.addEventListener('touchstart', onCanvasTouchPreventDefault, { passive: false });
      canvas.addEventListener('touchmove', onCanvasTouchPreventDefault, { passive: false });
      canvas.addEventListener('contextmenu', onCanvasContextMenu);

      clearBtn.addEventListener('pointerdown', onClearPointerDown);
      clearBtn.addEventListener('click', onClearClick);

      if (win && typeof win.addEventListener === 'function') {
        win.addEventListener('pointerup', onPointerUp);
        win.addEventListener('pointercancel', onPointerCancel);
        win.addEventListener('blur', onWindowBlur);
        win.addEventListener('resize', onWindowResize);
      }
      if (typeof doc.addEventListener === 'function') {
        doc.addEventListener('visibilitychange', onVisibilityChange);
      }

      let resizeObserver = null;
      const ResizeObserverCtor =
        (win && win.ResizeObserver) ||
        (typeof ResizeObserver === 'function' ? ResizeObserver : null);
      if (ResizeObserverCtor) {
        resizeObserver = new ResizeObserverCtor(function () {
          syncCanvasBackingStore(false);
        });
        resizeObserver.observe(rootEl);
      }

      let themeObserver = null;
      const MutationObserverCtor =
        (win && win.MutationObserver) ||
        (typeof MutationObserver === 'function' ? MutationObserver : null);
      if (MutationObserverCtor) {
        themeObserver = new MutationObserverCtor(onThemeMutation);
        const obsOpts = { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] };
        if (doc.documentElement) themeObserver.observe(doc.documentElement, obsOpts);
        if (doc.body) themeObserver.observe(doc.body, obsOpts);
        themeObserver.observe(rootEl, obsOpts);
      }

      const initRawDpr = win && typeof win.devicePixelRatio === 'number' ? win.devicePixelRatio : 1;
      bindDprMediaListener(initRawDpr);
      syncCanvasBackingStore(true);
      syncUiState();

      function destroy() {
        cancelClearVeil();
        if (announceTimerId && win && typeof win.clearTimeout === 'function') {
          win.clearTimeout(announceTimerId);
          announceTimerId = 0;
        }
        unbindDprMediaListener();
        finalizeActiveStroke(null);
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerCancel);
        canvas.removeEventListener('lostpointercapture', onLostPointerCapture);
        canvas.removeEventListener('touchstart', onCanvasTouchPreventDefault);
        canvas.removeEventListener('touchmove', onCanvasTouchPreventDefault);
        canvas.removeEventListener('contextmenu', onCanvasContextMenu);
        clearBtn.removeEventListener('pointerdown', onClearPointerDown);
        clearBtn.removeEventListener('click', onClearClick);
        if (win && typeof win.removeEventListener === 'function') {
          win.removeEventListener('pointerup', onPointerUp);
          win.removeEventListener('pointercancel', onPointerCancel);
          win.removeEventListener('blur', onWindowBlur);
          win.removeEventListener('resize', onWindowResize);
        }
        if (typeof doc.removeEventListener === 'function') {
          doc.removeEventListener('visibilitychange', onVisibilityChange);
        }
        if (resizeObserver && typeof resizeObserver.disconnect === 'function') {
          resizeObserver.disconnect();
        }
        if (themeObserver && typeof themeObserver.disconnect === 'function') {
          themeObserver.disconnect();
        }
        if (rootEl.__geminiDrawInstance === instance) {
          delete rootEl.__geminiDrawInstance;
        }
      }

      const instance = {
        rootEl: rootEl,
        canvas: canvas,
        clearBtn: clearBtn,
        emptyCue: emptyCue,
        liveStatus: liveStatus,
        engine: engine,
        clear: clearCanvas,
        resize: function () {
          syncCanvasBackingStore(true);
        },
        refreshTheme: onThemeMutation,
        destroy: destroy
      };

      rootEl.__geminiDrawInstance = instance;
      return instance;
    }

    function autoMount() {
      if (typeof document === 'undefined' || !document || typeof document.getElementById !== 'function') {
        return;
      }
      const target = document.getElementById('cell-draw');
      if (target) {
        mount(target);
      }
    }

    if (typeof document !== 'undefined' && document) {
      if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
        document.addEventListener('DOMContentLoaded', autoMount);
      } else {
        autoMount();
      }
    }

    return {
      mount: mount,
      mountDrawCell: mount
    };
  }
);
