/**
 * Freehand Drawing Sketchpad UI (`cells/draw/ui.js`)
 *
 * Pure Zero-Chrome Sketchpad (Apple Notes / Teenage Engineering Minimalism):
 *   - Mounts into `<section class="cell cell--draw" id="cell-draw">` using
 *     strictly `document.createElement` / `document.createElementNS` + `textContent`,
 *     as a shared `.ui-tile`: flush body (sheet) + overlay header (09 · Draw · Clear).
 *   - Strictly one `<button>` (`Clear`, `.ui-btn--sm`) with `aria-disabled="true"` and
 *     `data-tip="Nothing to clear yet."` when empty (never `disabled = true`,
 *     preserving keyboard focus; the tip is removed once there is ink), and
 *     `stopPropagation()` on `pointerdown`.
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
 *     `ResizeObserver` vector replay across `140x105px`..`960x720px` (immediate
 *     below `RESIZE_COALESCE_VERTICES`, at most one per `RESIZE_SETTLE_MS` above it), and
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
    const CLEAR_FADE_MS = 150; // = --ui-dur, the veil animation in draw.css
    const CLEAR_EMPTY_TIP = 'Nothing to clear yet.';
    // Above this many stored vertices a full replay costs several ms per frame
    // (measured ~2.3 us/vertex on a 960x720 tile at DPR 2), so continuous
    // ResizeObserver / window-resize bursts (MotionGrid spring) are throttled
    // to one replay per RESIZE_SETTLE_MS. Between replays the old bitmap is stretched by
    // CSS; strokes are normalized to the rect, so they stay in place.
    const RESIZE_COALESCE_VERTICES = 4000;
    const RESIZE_SETTLE_MS = 120;

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
        sample.timeStamp > 0
      ) {
        return sample.timeStamp;
      }
      if (
        fallbackEvent &&
        typeof fallbackEvent.timeStamp === 'number' &&
        Number.isFinite(fallbackEvent.timeStamp) &&
        fallbackEvent.timeStamp > 0
      ) {
        return fallbackEvent.timeStamp;
      }
      if (win && win.performance && typeof win.performance.now === 'function') {
        const now = win.performance.now();
        if (typeof now === 'number' && Number.isFinite(now)) {
          return now;
        }
      }
      return Date.now();
    }

    function resolvePointerId(e) {
      return e && Number.isFinite(e.pointerId) ? e.pointerId : 1;
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
      rootEl.classList.add('cell--draw', 'ui-tile');
      rootEl.classList.remove('has-ink', 'is-drawing', 'is-clearing');

      // Shared tile anatomy (ui/NOTES.md): a flush body holding the sheet, with
      // the overlay header (index, title, Clear) laid over its top edge.
      const body = doc.createElement('div');
      body.className = 'ui-tile-body ui-tile-body--flush';

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
      emptyLabel.className = 'dw-empty-label ui-label';
      emptyLabel.textContent = 'Mouse · pen · touch';
      emptyCue.appendChild(emptyIcon);
      emptyCue.appendChild(emptyLabel);

      const head = doc.createElement('header');
      head.className = 'ui-tile-head ui-tile-head--overlay';
      const indexEl = doc.createElement('span');
      indexEl.className = 'ui-tile-index';
      indexEl.textContent = '09';
      const titleEl = doc.createElement('span');
      titleEl.className = 'ui-tile-title';
      titleEl.textContent = 'Draw';
      const actions = doc.createElement('div');
      actions.className = 'ui-tile-actions';

      const clearBtn = doc.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'dw-clear ui-btn ui-btn--sm';
      clearBtn.setAttribute('aria-disabled', 'true');
      clearBtn.setAttribute('aria-label', 'Clear canvas');
      clearBtn.setAttribute('data-tip', CLEAR_EMPTY_TIP);
      clearBtn.textContent = 'Clear';

      actions.appendChild(clearBtn);
      head.appendChild(indexEl);
      head.appendChild(titleEl);
      head.appendChild(actions);

      const liveStatus = doc.createElement('span');
      liveStatus.className = 'ui-sr-only';
      liveStatus.setAttribute('role', 'status');
      liveStatus.setAttribute('aria-live', 'polite');
      liveStatus.setAttribute('aria-atomic', 'true');

      body.appendChild(canvas);
      body.appendChild(paperVeil);
      body.appendChild(emptyCue);
      body.appendChild(head);
      body.appendChild(liveStatus);
      rootEl.appendChild(body);

      const engine = Engine.createEngine(customOptions && customOptions.engineOptions);
      const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;

      let destroyed = false;
      let activePointerId = null;
      let cssW = 0;
      let cssH = 0;
      let currentDpr = 1;
      let watchedRawDpr = 0;
      let currentInk = Engine.DEFAULT_INK;
      let clearTimerId = 0;
      let announceTimerId = 0;
      let clearPhaseToggle = false;
      let dprMediaQuery = null;
      let resizeSettleTimerId = 0;

      function prefersReducedMotion() {
        if (win && typeof win.matchMedia === 'function') {
          const mq = win.matchMedia('(prefers-reduced-motion: reduce)');
          return Boolean(mq && mq.matches);
        }
        return false;
      }

      function announcePolite(message) {
        if (destroyed) return;
        if (announceTimerId && win && typeof win.clearTimeout === 'function') {
          win.clearTimeout(announceTimerId);
          announceTimerId = 0;
        }
        liveStatus.textContent = '';
        if (!message) return;
        if (win && typeof win.setTimeout === 'function') {
          announceTimerId = win.setTimeout(function () {
            announceTimerId = 0;
            if (destroyed) return;
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
        let resolvedTheme = null;
        let cursor = rootEl;
        while (cursor && cursor !== doc) {
          if (typeof cursor.getAttribute === 'function') {
            const attr = cursor.getAttribute('data-theme');
            if (attr === 'dark' || attr === 'light') {
              resolvedTheme = attr;
              break;
            }
          }
          cursor = cursor.parentElement || cursor.parentNode;
        }
        if (!resolvedTheme) {
          if (doc.body && typeof doc.body.getAttribute === 'function' && doc.body.getAttribute('data-theme') === 'dark') {
            resolvedTheme = 'dark';
          } else if (
            doc.documentElement &&
            typeof doc.documentElement.getAttribute === 'function' &&
            doc.documentElement.getAttribute('data-theme') === 'dark'
          ) {
            resolvedTheme = 'dark';
          }
        }
        currentInk = resolvedTheme === 'dark' ? '#f5f5f3' : Engine.DEFAULT_INK;
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
        watchedRawDpr = 0;
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
        if (destroyed || !win || typeof win.matchMedia !== 'function') return;
        const safeDpr = Number.isFinite(rawDpr) && rawDpr > 0 ? rawDpr : 1;
        watchedRawDpr = safeDpr;
        const minDpr = Math.max(0.001, safeDpr - 0.001).toFixed(4);
        const maxDpr = (safeDpr + 0.001).toFixed(4);
        const mq = win.matchMedia(
          '(min-resolution: ' + minDpr + 'dppx) and (max-resolution: ' + maxDpr + 'dppx)'
        );
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
        if (destroyed) return;
        const rawDpr =
          win && typeof win.devicePixelRatio === 'number' && Number.isFinite(win.devicePixelRatio) && win.devicePixelRatio > 0
            ? win.devicePixelRatio
            : 1;
        bindDprMediaListener(rawDpr);
        syncCanvasBackingStore(false);
      }

      function syncCanvasBackingStore(forceReplay) {
        if (destroyed) return;
        const rect = measureRect();
        if (!(rect.width > 0) || !(rect.height > 0)) {
          if (activePointerId !== null) {
            finalizeActiveStroke(null);
          }
          return;
        }

        const rawDpr =
          win && typeof win.devicePixelRatio === 'number' && Number.isFinite(win.devicePixelRatio) && win.devicePixelRatio > 0
            ? win.devicePixelRatio
            : 1;
        const dpr = Math.min(Math.max(rawDpr, 1), 3);
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
        currentDpr = dpr;
        if (watchedRawDpr === 0 || Math.abs(rawDpr - watchedRawDpr) > 0.0005) {
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
        // The tip only explains the disabled state; an enabled Clear needs none.
        if (hasInk) {
          clearBtn.removeAttribute('data-tip');
        } else {
          clearBtn.setAttribute('data-tip', CLEAR_EMPTY_TIP);
        }
      }

      function cancelClearVeil() {
        if (clearTimerId && win && typeof win.clearTimeout === 'function') {
          win.clearTimeout(clearTimerId);
          clearTimerId = 0;
        }
        rootEl.classList.remove('is-clearing');
      }

      function tryReleasePointerCapture(pointerId) {
        if (!Number.isFinite(pointerId)) return;
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
        if (!destroyed) {
          const rect = measureRect();
          if (rect.width > 0 && rect.height > 0) {
            if (Math.abs(rect.width - cssW) > 0.05 || Math.abs(rect.height - cssH) > 0.05) {
              syncCanvasBackingStore(false);
            }
            if (
              finalEvent &&
              Number.isFinite(finalEvent.clientX) &&
              Number.isFinite(finalEvent.clientY)
            ) {
              finalInput = {
                clientX: finalEvent.clientX,
                clientY: finalEvent.clientY,
                rect: rect,
                pointerType: finalEvent.pointerType || 'mouse',
                pressure:
                  typeof finalEvent.pressure === 'number' && Number.isFinite(finalEvent.pressure)
                    ? finalEvent.pressure
                    : 0,
                timeMs: resolveEventTimeMs(finalEvent, null, win)
              };
            }
          }
        }

        const result = engine.endStroke(finalInput);
        if (!destroyed && result && ctx && cssW > 0 && cssH > 0) {
          for (let i = 0; i < result.ops.length; i++) {
            Engine.drawOp(ctx, result.ops[i], cssW, cssH, currentInk);
          }
        }

        tryReleasePointerCapture(endedPointerId);
        if (!destroyed) {
          syncUiState();
        }
      }

      function onPointerDown(e) {
        if (destroyed || !e) return;
        if (typeof e.button === 'number' && e.button !== 0) {
          return;
        }

        let preemptedPalm = false;
        if (activePointerId !== null) {
          const currentActive = engine.getActiveStroke();
          if (
            e.pointerType === 'pen' &&
            currentActive &&
            currentActive.pointerType === 'touch' &&
            currentActive.isDot
          ) {
            const palmPointerId = activePointerId;
            activePointerId = null;
            engine.cancelStroke();
            tryReleasePointerCapture(palmPointerId);
            preemptedPalm = true;
          } else {
            return;
          }
        }

        cancelClearVeil();
        syncCanvasBackingStore(preemptedPalm);
        const rect = measureRect();
        if (!(rect.width > 0) || !(rect.height > 0)) {
          if (preemptedPalm) syncUiState();
          return;
        }
        if (Math.abs(rect.width - cssW) > 0.05 || Math.abs(rect.height - cssH) > 0.05) {
          syncCanvasBackingStore(false);
        }

        readInkColor();

        const op = engine.beginStroke({
          clientX: e.clientX,
          clientY: e.clientY,
          rect: rect,
          pointerType: e.pointerType || 'mouse',
          pressure:
            typeof e.pressure === 'number' && Number.isFinite(e.pressure) ? e.pressure : 0,
          timeMs: resolveEventTimeMs(e, null, win)
        });

        if (!op) {
          if (preemptedPalm) syncUiState();
          return;
        }

        activePointerId = resolvePointerId(e);

        try {
          if (typeof canvas.setPointerCapture === 'function' && Number.isFinite(e.pointerId)) {
            canvas.setPointerCapture(e.pointerId);
          }
        } catch (_err) {
          // Ignore synthetic events without active browser pointer registry
        }

        announcePolite('');
        syncUiState();

        if (ctx && cssW > 0 && cssH > 0) {
          Engine.drawOp(ctx, op, cssW, cssH, currentInk);
        }
      }

      function onPointerMove(e) {
        if (destroyed || !e || activePointerId === null) return;
        const pid = resolvePointerId(e);
        if (pid !== activePointerId) return;

        if (
          (e.pointerType === 'mouse' || e.pointerType === 'pen') &&
          typeof e.buttons === 'number' &&
          (e.buttons & 1) === 0
        ) {
          finalizeActiveStroke(null);
          return;
        }

        const rect = measureRect();
        if (!(rect.width > 0) || !(rect.height > 0)) return;

        if (Math.abs(rect.width - cssW) > 0.05 || Math.abs(rect.height - cssH) > 0.05) {
          syncCanvasBackingStore(false);
        }
        if (!(cssW > 0) || !(cssH > 0)) return;

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
              typeof sample.pressure === 'number' && Number.isFinite(sample.pressure)
                ? sample.pressure
                : typeof e.pressure === 'number' && Number.isFinite(e.pressure)
                  ? e.pressure
                  : 0,
            timeMs: resolveEventTimeMs(sample, e, win)
          });
          if (op && ctx) {
            Engine.drawOp(ctx, op, cssW, cssH, currentInk);
          }
        }
      }

      function onPointerUp(e) {
        if (destroyed || !e || activePointerId === null) return;
        const pid = resolvePointerId(e);
        if (pid !== activePointerId) return;
        finalizeActiveStroke(e);
      }

      function onPointerCancel(e) {
        if (destroyed || !e || activePointerId === null) return;
        const pid = resolvePointerId(e);
        if (pid !== activePointerId) return;
        finalizeActiveStroke(null);
      }

      function onLostPointerCapture(e) {
        if (destroyed || !e || activePointerId === null) return;
        const pid = resolvePointerId(e);
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
        if (destroyed) return false;
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
            if (destroyed) return;
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
        if (destroyed) return;
        finalizeActiveStroke(null);
      }

      function onVisibilityChange() {
        if (destroyed) return;
        if (doc.hidden || doc.visibilityState === 'hidden') {
          finalizeActiveStroke(null);
        }
      }

      function cancelResizeSettle() {
        if (resizeSettleTimerId && win && typeof win.clearTimeout === 'function') {
          win.clearTimeout(resizeSettleTimerId);
        }
        resizeSettleTimerId = 0;
      }

      // Shared by ResizeObserver and window `resize`. Light drawings replay
      // immediately; heavy ones replay once the size settles. Zero-size (hidden
      // grid) always goes straight through so an active stroke finalizes now.
      function onResizeSignal() {
        if (destroyed) return;
        const rect = measureRect();
        const heavy =
          rect.width > 0 &&
          rect.height > 0 &&
          engine.getVertexCount() > RESIZE_COALESCE_VERTICES &&
          win &&
          typeof win.setTimeout === 'function';
        if (!heavy) {
          cancelResizeSettle();
          syncCanvasBackingStore(false);
          return;
        }
        // Throttle, not debounce: keep a pending timer so sustained motion
        // (long slider drag, window drag-resize) still replays every
        // RESIZE_SETTLE_MS; the replay measures the live rect when it runs.
        if (resizeSettleTimerId) return;
        resizeSettleTimerId = win.setTimeout(function () {
          resizeSettleTimerId = 0;
          if (destroyed) return;
          syncCanvasBackingStore(false);
        }, RESIZE_SETTLE_MS);
        if (resizeSettleTimerId && typeof resizeSettleTimerId.unref === 'function') {
          resizeSettleTimerId.unref();
        }
      }

      function onWindowResize() {
        onResizeSignal();
      }

      function onThemeMutation() {
        if (destroyed) return;
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
        resizeObserver = new ResizeObserverCtor(onResizeSignal);
        resizeObserver.observe(rootEl);
      }

      let themeObserver = null;
      const MutationObserverCtor =
        (win && win.MutationObserver) ||
        (typeof MutationObserver === 'function' ? MutationObserver : null);
      if (MutationObserverCtor) {
        themeObserver = new MutationObserverCtor(onThemeMutation);
        // Only `data-theme` can switch the ink (draw.css keys dark mode on it).
        // Ancestor `class`/`style` are excluded on purpose: MotionGrid writes
        // `--mg-cell-w` into `main.grid`'s style on every spring frame, which
        // would otherwise force a getComputedStyle per frame.
        const ancestorOpts = { attributes: true, attributeFilter: ['data-theme'] };
        const selfOpts = { attributes: true, attributeFilter: ['data-theme', 'style'] };
        if (doc.documentElement) themeObserver.observe(doc.documentElement, ancestorOpts);
        if (doc.body && doc.body !== doc.documentElement) {
          themeObserver.observe(doc.body, ancestorOpts);
        }
        const parentEl = rootEl.parentElement || rootEl.parentNode;
        if (
          parentEl &&
          parentEl !== rootEl &&
          parentEl !== doc &&
          parentEl !== doc.body &&
          parentEl !== doc.documentElement
        ) {
          themeObserver.observe(parentEl, ancestorOpts);
        }
        themeObserver.observe(rootEl, selfOpts);
      }

      syncCanvasBackingStore(true);
      if (watchedRawDpr === 0) {
        const initRawDpr =
          win && typeof win.devicePixelRatio === 'number' && Number.isFinite(win.devicePixelRatio) && win.devicePixelRatio > 0
            ? win.devicePixelRatio
            : 1;
        bindDprMediaListener(initRawDpr);
      }
      syncUiState();

      function destroy() {
        if (destroyed) return;
        finalizeActiveStroke(null);
        destroyed = true;
        cancelClearVeil();
        cancelResizeSettle();
        if (announceTimerId && win && typeof win.clearTimeout === 'function') {
          win.clearTimeout(announceTimerId);
          announceTimerId = 0;
        }
        unbindDprMediaListener();
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
          if (destroyed) return;
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
