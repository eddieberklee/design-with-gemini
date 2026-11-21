/**
 * Freehand Drawing Stroke Engine (`cells/draw/engine.js`)
 *
 * Pure Zero-Chrome Sketchpad stroke geometry & felt-tip physics:
 *   - Unclamped normalized `(u, v)` coordinates relative to cell rect so
 *     continuous edge loops re-enter cleanly and 60fps `MotionGrid` resizes
 *     (`140x105px` -> `960x720px`) replay crisply at any DPR.
 *   - O(1) incremental `C1` midpoint quadratic Bezier spline with 100% opaque
 *     ink (zero alpha-doubling seams) and exact 1-to-1 replay parity.
 *   - Double-EMA + smoothstep velocity-modulated felt-tip width (`0.82x` fast
 *     flicks to `1.12x` slow deliberate curves) for mouse/trackpad/touch; true
 *     stylus pressure mapping strictly gated to `pointerType === 'pen' && pressure > 0`
 *     (immune to iOS `touch` `pressure === 0`).
 *   - Crisp zero-movement tap-to-dot (`1.25px` jitter deadband).
 *   - Iterative stack-safe 3D `(x, y, w)` Ramer-Douglas-Peucker compaction (`0.28px`
 *     tolerance) preserving mid-stroke pressure swells plus a `12,000`-vertex session
 *     compaction ceiling for bounded 60fps resize replay.
 *
 * Classic `<script defer>` IIFE on `window.GeminiDraw.Engine` + CommonJS UMD export.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (root && typeof root === 'object') {
    const ns = (root.GeminiDraw = root.GeminiDraw || {});
    ns.Engine = api;
    if (typeof globalThis === 'object' && globalThis && globalThis !== root) {
      globalThis.GeminiDraw = ns;
    }
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(
  typeof window !== 'undefined'
    ? window
    : typeof globalThis !== 'undefined'
      ? globalThis
      : this,
  function () {
    'use strict';

    const JITTER_DEADBAND_PX = 1.25;
    const VEL_WIDTH_MIN = 0.82;
    const VEL_WIDTH_MAX = 1.12;
    const PEN_WIDTH_MIN = 0.52;
    const PEN_WIDTH_MAX = 1.58;
    const TOUCHDOWN_WIDTH_FACTOR = 1.02;
    const DEFAULT_RDP_EPSILON_PX = 0.28;
    const BUDGET_RDP_EPSILON_PX = 0.85;
    const MAX_TOTAL_VERTICES = 12000;
    const DEFAULT_INK = '#141413';

    function clamp(v, lo, hi) {
      return v < lo ? lo : v > hi ? hi : v;
    }

    function normalizePoint(clientX, clientY, rect) {
      if (
        !rect ||
        !Number.isFinite(clientX) ||
        !Number.isFinite(clientY) ||
        !Number.isFinite(rect.left) ||
        !Number.isFinite(rect.top) ||
        !Number.isFinite(rect.width) ||
        !Number.isFinite(rect.height) ||
        rect.width <= 0 ||
        rect.height <= 0
      ) {
        return null;
      }
      return {
        u: (clientX - rect.left) / rect.width,
        v: (clientY - rect.top) / rect.height
      };
    }

    function computeBaseWidth(width, height) {
      const w = Number.isFinite(width) && width > 0 ? width : 320;
      const h = Number.isFinite(height) && height > 0 ? height : 240;
      const minDim = Math.min(w, h);
      return clamp(1.35 + minDim * 0.0044, 1.75, 5.0);
    }

    function computeStrokeWidthFactor(params) {
      const opts = params || {};
      const pointerType = opts.pointerType || 'mouse';
      const pressure = opts.pressure;
      const prev =
        typeof opts.prevFactor === 'number' && Number.isFinite(opts.prevFactor)
          ? opts.prevFactor
          : null;

      if (pointerType === 'pen') {
        if (typeof pressure === 'number' && Number.isFinite(pressure) && pressure > 0) {
          const p = clamp(pressure, 0.05, 1.0);
          const shaped = Math.pow(p, 0.68);
          const targetPen = PEN_WIDTH_MIN + (PEN_WIDTH_MAX - PEN_WIDTH_MIN) * shaped;
          return prev !== null ? prev * 0.45 + targetPen * 0.55 : targetPen;
        }
        if (prev !== null) {
          return Math.max(PEN_WIDTH_MIN, prev * 0.92);
        }
      }

      const vel =
        typeof opts.velocityPxPerMs === 'number' && Number.isFinite(opts.velocityPxPerMs)
          ? Math.max(0, opts.velocityPxPerMs)
          : 0;
      const normV = clamp((vel - 0.06) / (1.80 - 0.06), 0, 1);
      const smooth = normV * normV * (3 - 2 * normV);
      const targetVel = VEL_WIDTH_MAX - (VEL_WIDTH_MAX - VEL_WIDTH_MIN) * smooth;
      return prev !== null ? prev * 0.58 + targetVel * 0.42 : targetVel;
    }

    function compactPointsRDP(points, width, height, epsilonPx) {
      if (!Array.isArray(points)) return [];
      const n = points.length;
      if (n <= 2) {
        return points.map(function (p) {
          return { u: p.u, v: p.v, w: p.w };
        });
      }

      const wScale = Number.isFinite(width) && width > 0 ? width : 320;
      const hScale = Number.isFinite(height) && height > 0 ? height : 240;
      const eps =
        typeof epsilonPx === 'number' && Number.isFinite(epsilonPx) && epsilonPx >= 0
          ? epsilonPx
          : DEFAULT_RDP_EPSILON_PX;
      const epsSq = eps * eps;
      const widthWeight = 6.0;

      const keep = new Uint8Array(n);
      keep[0] = 1;
      keep[n - 1] = 1;

      const stack = [[0, n - 1]];
      while (stack.length > 0) {
        const pair = stack.pop();
        const start = pair[0];
        const end = pair[1];
        if (end - start <= 1) continue;

        const ax = points[start].u * wScale;
        const ay = points[start].v * hScale;
        const aw = points[start].w || 1;
        const bx = points[end].u * wScale;
        const by = points[end].v * hScale;
        const bw = points[end].w || 1;

        const dx = bx - ax;
        const dy = by - ay;
        const lenSq = dx * dx + dy * dy;

        let maxDistSq = -1;
        let splitIdx = -1;

        for (let i = start + 1; i < end; i++) {
          const px = points[i].u * wScale;
          const py = points[i].v * hScale;
          const pw = points[i].w || 1;

          let t = 0;
          if (lenSq > 1e-9) {
            t = clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1);
          }
          const projX = ax + t * dx;
          const projY = ay + t * dy;
          const projW = aw + t * (bw - aw);

          const ex = px - projX;
          const ey = py - projY;
          const ew = (pw - projW) * widthWeight;
          const dSq = ex * ex + ey * ey + ew * ew;

          if (dSq > maxDistSq) {
            maxDistSq = dSq;
            splitIdx = i;
          }
        }

        if (maxDistSq > epsSq && splitIdx !== -1) {
          keep[splitIdx] = 1;
          stack.push([start, splitIdx]);
          stack.push([splitIdx, end]);
        }
      }

      const compacted = [];
      for (let i = 0; i < n; i++) {
        if (keep[i]) {
          compacted.push({
            u: points[i].u,
            v: points[i].v,
            w: points[i].w
          });
        }
      }
      return compacted;
    }

    function drawOp(ctx, op, width, height, inkColor) {
      if (!ctx || !op || !(width > 0) || !(height > 0)) return;
      const baseWidth = computeBaseWidth(width, height);
      const color = inkColor || DEFAULT_INK;

      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (op.type === 'dot') {
        const x = op.u * width;
        const y = op.v * height;
        const radius = Math.max(0.95, baseWidth * (op.w || 1) * 0.5);
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
        return;
      }

      ctx.lineWidth = Math.max(1.0, baseWidth * (op.w || 1));
      ctx.beginPath();
      if (op.type === 'line') {
        ctx.moveTo(op.from.u * width, op.from.v * height);
        ctx.lineTo(op.to.u * width, op.to.v * height);
        ctx.stroke();
      } else if (op.type === 'quad') {
        ctx.moveTo(op.from.u * width, op.from.v * height);
        ctx.quadraticCurveTo(
          op.ctrl.u * width,
          op.ctrl.v * height,
          op.to.u * width,
          op.to.v * height
        );
        ctx.stroke();
      }
    }

    function renderStroke(ctx, stroke, width, height, inkColor) {
      if (!ctx || !stroke || !Array.isArray(stroke.points) || stroke.points.length === 0) return;
      if (!(width > 0) || !(height > 0)) return;

      const pts = stroke.points;
      if (pts.length === 1 || stroke.isDot) {
        drawOp(
          ctx,
          { type: 'dot', u: pts[0].u, v: pts[0].v, w: pts[0].w },
          width,
          height,
          inkColor
        );
        return;
      }

      drawOp(
        ctx,
        { type: 'dot', u: pts[0].u, v: pts[0].v, w: pts[0].w },
        width,
        height,
        inkColor
      );

      const m01 = {
        u: (pts[0].u + pts[1].u) * 0.5,
        v: (pts[0].v + pts[1].v) * 0.5
      };
      drawOp(
        ctx,
        { type: 'line', from: pts[0], to: m01, w: (pts[0].w + pts[1].w) * 0.5 },
        width,
        height,
        inkColor
      );

      let prevMid = m01;
      for (let i = 2; i < pts.length; i++) {
        const currMid = {
          u: (pts[i - 1].u + pts[i].u) * 0.5,
          v: (pts[i - 1].v + pts[i].v) * 0.5
        };
        drawOp(
          ctx,
          { type: 'quad', from: prevMid, ctrl: pts[i - 1], to: currMid, w: pts[i - 1].w },
          width,
          height,
          inkColor
        );
        prevMid = currMid;
      }

      if (!stroke.isActive) {
        const last = pts[pts.length - 1];
        drawOp(
          ctx,
          { type: 'line', from: prevMid, to: last, w: last.w },
          width,
          height,
          inkColor
        );
      }
    }

    function renderAllStrokes(ctx, strokes, activeStroke, width, height, inkColor) {
      if (!ctx || !(width > 0) || !(height > 0)) return;
      ctx.clearRect(0, 0, width + 1, height + 1);
      if (Array.isArray(strokes)) {
        for (let i = 0; i < strokes.length; i++) {
          renderStroke(ctx, strokes[i], width, height, inkColor);
        }
      }
      if (activeStroke) {
        renderStroke(ctx, activeStroke, width, height, inkColor);
      }
    }

    function createEngine(options) {
      const cfg = options || {};
      const jitterDeadbandPx =
        typeof cfg.jitterDeadbandPx === 'number' ? cfg.jitterDeadbandPx : JITTER_DEADBAND_PX;
      const rdpEpsilonPx =
        typeof cfg.rdpEpsilonPx === 'number' ? cfg.rdpEpsilonPx : DEFAULT_RDP_EPSILON_PX;
      const maxTotalVertices =
        typeof cfg.maxTotalVertices === 'number' && cfg.maxTotalVertices > 0
          ? cfg.maxTotalVertices
          : MAX_TOTAL_VERTICES;

      const strokes = [];
      let activeStroke = null;
      let totalVertices = 0;
      let compactCursor = 0;

      function enforceVertexBudget() {
        if (totalVertices <= maxTotalVertices) return;
        while (totalVertices > maxTotalVertices && compactCursor < strokes.length - 1) {
          const s = strokes[compactCursor];
          compactCursor += 1;
          if (!s || s.isDot || s.budgetCompacted || s.points.length <= 2) continue;
          const prevLen = s.points.length;
          s.points = compactPointsRDP(s.points, s.refW, s.refH, BUDGET_RDP_EPSILON_PX);
          s.budgetCompacted = true;
          totalVertices -= prevLen - s.points.length;
        }
      }

      function beginStroke(input) {
        if (!input || !input.rect) return null;
        if (activeStroke) {
          endStroke(null);
        }

        const norm = normalizePoint(input.clientX, input.clientY, input.rect);
        if (!norm) return null;

        const pointerType = input.pointerType || 'mouse';
        const initialW =
          pointerType === 'pen' &&
          typeof input.pressure === 'number' &&
          Number.isFinite(input.pressure) &&
          input.pressure > 0
            ? computeStrokeWidthFactor({
                pointerType: 'pen',
                pressure: input.pressure,
                velocityPxPerMs: 0,
                prevFactor: null
              })
            : TOUCHDOWN_WIDTH_FACTOR;

        const timeMs =
          typeof input.timeMs === 'number' && Number.isFinite(input.timeMs) && input.timeMs >= 0
            ? input.timeMs
            : 0;

        const pt = { u: norm.u, v: norm.v, w: initialW };
        activeStroke = {
          pointerType: pointerType,
          isDot: true,
          isActive: true,
          points: [pt],
          lastTimeMs: timeMs,
          velEma: 0,
          widthPx: input.rect.width,
          heightPx: input.rect.height
        };

        return {
          type: 'dot',
          u: pt.u,
          v: pt.v,
          w: pt.w
        };
      }

      function appendPoint(input) {
        if (!activeStroke || !input || !input.rect) return null;
        const norm = normalizePoint(input.clientX, input.clientY, input.rect);
        if (!norm) return null;

        activeStroke.widthPx = input.rect.width;
        activeStroke.heightPx = input.rect.height;

        const pts = activeStroke.points;
        const last = pts[pts.length - 1];
        const dxPx = (norm.u - last.u) * input.rect.width;
        const dyPx = (norm.v - last.v) * input.rect.height;
        const distPx = Math.hypot(dxPx, dyPx);

        if (distPx < jitterDeadbandPx) {
          return null;
        }

        const rawTimeMs =
          typeof input.timeMs === 'number' && Number.isFinite(input.timeMs)
            ? input.timeMs
            : activeStroke.lastTimeMs + 8;
        const timeMs = Math.max(activeStroke.lastTimeMs, rawTimeMs);
        const dtMs = Math.max(1, timeMs - activeStroke.lastTimeMs);
        const instVel = distPx / dtMs;
        activeStroke.velEma =
          pts.length === 1 ? instVel : activeStroke.velEma * 0.65 + instVel * 0.35;
        activeStroke.lastTimeMs = timeMs;

        const w = computeStrokeWidthFactor({
          pointerType: input.pointerType || activeStroke.pointerType,
          pressure: input.pressure,
          velocityPxPerMs: activeStroke.velEma,
          prevFactor: last.w
        });

        const nextPt = { u: norm.u, v: norm.v, w: w };
        pts.push(nextPt);
        activeStroke.isDot = false;

        if (pts.length === 2) {
          const mid01 = {
            u: (pts[0].u + pts[1].u) * 0.5,
            v: (pts[0].v + pts[1].v) * 0.5
          };
          return {
            type: 'line',
            from: pts[0],
            to: mid01,
            w: (pts[0].w + pts[1].w) * 0.5
          };
        }

        const pPrev2 = pts[pts.length - 3];
        const pPrev1 = pts[pts.length - 2];
        const prevMid = {
          u: (pPrev2.u + pPrev1.u) * 0.5,
          v: (pPrev2.v + pPrev1.v) * 0.5
        };
        const currMid = {
          u: (pPrev1.u + nextPt.u) * 0.5,
          v: (pPrev1.v + nextPt.v) * 0.5
        };
        return {
          type: 'quad',
          from: prevMid,
          ctrl: pPrev1,
          to: currMid,
          w: pPrev1.w
        };
      }

      function endStroke(finalInput) {
        if (!activeStroke) return null;

        const ops = [];
        if (finalInput && finalInput.rect) {
          const maybeOp = appendPoint(finalInput);
          if (maybeOp) ops.push(maybeOp);
        }

        const pts = activeStroke.points;
        if (pts.length >= 2 && !activeStroke.isDot) {
          const pPrev = pts[pts.length - 2];
          const pLast = pts[pts.length - 1];
          const lastMid = {
            u: (pPrev.u + pLast.u) * 0.5,
            v: (pPrev.v + pLast.v) * 0.5
          };
          ops.push({
            type: 'line',
            from: lastMid,
            to: pLast,
            w: pLast.w
          });
        }

        const refW = activeStroke.widthPx;
        const refH = activeStroke.heightPx;
        const compacted = activeStroke.isDot
          ? [{ u: pts[0].u, v: pts[0].v, w: pts[0].w }]
          : compactPointsRDP(pts, refW, refH, rdpEpsilonPx);

        const finalized = {
          pointerType: activeStroke.pointerType,
          isDot: activeStroke.isDot || compacted.length === 1,
          isActive: false,
          budgetCompacted: false,
          refW: refW,
          refH: refH,
          points: compacted
        };

        strokes.push(finalized);
        totalVertices += compacted.length;
        activeStroke = null;
        enforceVertexBudget();

        return {
          stroke: finalized,
          ops: ops
        };
      }

      function cancelStroke() {
        if (!activeStroke) return false;
        activeStroke = null;
        return true;
      }

      function clear() {
        strokes.length = 0;
        activeStroke = null;
        totalVertices = 0;
        compactCursor = 0;
      }

      function isEmpty() {
        return strokes.length === 0 && activeStroke === null;
      }

      function getStrokes() {
        return strokes;
      }

      function getStrokeCount() {
        return strokes.length;
      }

      function getVertexCount() {
        return totalVertices + (activeStroke ? activeStroke.points.length : 0);
      }

      function getActiveStroke() {
        return activeStroke;
      }

      return {
        beginStroke: beginStroke,
        appendPoint: appendPoint,
        endStroke: endStroke,
        cancelStroke: cancelStroke,
        clear: clear,
        isEmpty: isEmpty,
        getStrokes: getStrokes,
        getStrokeCount: getStrokeCount,
        getVertexCount: getVertexCount,
        getActiveStroke: getActiveStroke
      };
    }

    return {
      JITTER_DEADBAND_PX: JITTER_DEADBAND_PX,
      VEL_WIDTH_MIN: VEL_WIDTH_MIN,
      VEL_WIDTH_MAX: VEL_WIDTH_MAX,
      PEN_WIDTH_MIN: PEN_WIDTH_MIN,
      PEN_WIDTH_MAX: PEN_WIDTH_MAX,
      DEFAULT_RDP_EPSILON_PX: DEFAULT_RDP_EPSILON_PX,
      BUDGET_RDP_EPSILON_PX: BUDGET_RDP_EPSILON_PX,
      MAX_TOTAL_VERTICES: MAX_TOTAL_VERTICES,
      DEFAULT_INK: DEFAULT_INK,
      normalizePoint: normalizePoint,
      computeBaseWidth: computeBaseWidth,
      computeStrokeWidthFactor: computeStrokeWidthFactor,
      compactPointsRDP: compactPointsRDP,
      drawOp: drawOp,
      renderStroke: renderStroke,
      renderAllStrokes: renderAllStrokes,
      createEngine: createEngine
    };
  }
);
