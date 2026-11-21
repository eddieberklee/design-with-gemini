'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Engine = require('./engine.js');
const UI = require('./ui.js');

function createMockContext2D() {
  const calls = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineCap: 'butt',
    lineJoin: 'miter',
    lineWidth: 1,
    calls: calls,
    setTransform(a, b, c, d, e, f) {
      calls.push({ fn: 'setTransform', args: [a, b, c, d, e, f] });
    },
    clearRect(x, y, w, h) {
      calls.push({ fn: 'clearRect', args: [x, y, w, h] });
    },
    beginPath() {
      calls.push({ fn: 'beginPath' });
    },
    arc(x, y, r, sAngle, eAngle) {
      calls.push({
        fn: 'arc',
        args: [x, y, r, sAngle, eAngle],
        fillStyle: ctx.fillStyle,
        alpha: ctx.globalAlpha
      });
    },
    fill() {
      calls.push({ fn: 'fill', fillStyle: ctx.fillStyle, alpha: ctx.globalAlpha });
    },
    moveTo(x, y) {
      calls.push({ fn: 'moveTo', args: [x, y] });
    },
    lineTo(x, y) {
      calls.push({ fn: 'lineTo', args: [x, y], lineWidth: ctx.lineWidth });
    },
    quadraticCurveTo(cpx, cpy, x, y) {
      calls.push({
        fn: 'quadraticCurveTo',
        args: [cpx, cpy, x, y],
        lineWidth: ctx.lineWidth,
        strokeStyle: ctx.strokeStyle,
        alpha: ctx.globalAlpha
      });
    },
    stroke() {
      calls.push({
        fn: 'stroke',
        strokeStyle: ctx.strokeStyle,
        lineWidth: ctx.lineWidth,
        lineCap: ctx.lineCap,
        lineJoin: ctx.lineJoin,
        alpha: ctx.globalAlpha
      });
    }
  };
  return ctx;
}

function createSimulatedDom(initialRect, initialInk) {
  let currentRect = Object.assign({ left: 10, top: 20, width: 400, height: 300 }, initialRect || {});
  let inkVar = initialInk || '#141413';
  let reducedMotion = false;
  let resizeCallback = null;
  let mutationCallback = null;
  let dprChangeHandlers = [];
  const dprQueries = [];
  const observedTargets = [];
  let computedStyleCalls = 0;
  let nextTimerId = 1;
  const activeTimers = new Map();
  const getContextArgs = [];
  const ctx2d = createMockContext2D();
  const winListeners = new Map();
  const docListeners = new Map();

  function notifyAttributeMutation(target, attrName) {
    if (!mutationCallback) return;
    for (const entry of observedTargets) {
      if (entry.target === target) {
        const filter = entry.opts && entry.opts.attributeFilter;
        if (!Array.isArray(filter) || filter.includes(attrName)) {
          mutationCallback([{ type: 'attributes', target: target, attributeName: attrName }]);
          return;
        }
      }
    }
  }

  function createClassList(ownerGetter) {
    const set = new Set();
    return {
      add() {
        let changed = false;
        for (let i = 0; i < arguments.length; i++) {
          const name = String(arguments[i]);
          if (!set.has(name)) {
            set.add(name);
            changed = true;
          }
        }
        if (changed) notifyAttributeMutation(ownerGetter(), 'class');
      },
      remove() {
        let changed = false;
        for (let i = 0; i < arguments.length; i++) {
          const name = String(arguments[i]);
          if (set.delete(name)) {
            changed = true;
          }
        }
        if (changed) notifyAttributeMutation(ownerGetter(), 'class');
      },
      toggle(name, force) {
        const key = String(name);
        if (force === undefined) {
          if (set.has(key)) {
            set.delete(key);
            notifyAttributeMutation(ownerGetter(), 'class');
            return false;
          }
          set.add(key);
          notifyAttributeMutation(ownerGetter(), 'class');
          return true;
        }
        const had = set.has(key);
        if (force) set.add(key);
        else set.delete(key);
        if (had !== Boolean(force)) {
          notifyAttributeMutation(ownerGetter(), 'class');
        }
        return Boolean(force);
      },
      contains(name) {
        return set.has(name);
      },
      toArray() {
        return Array.from(set);
      }
    };
  }

  function makeElement(tagName, namespaceURI) {
    const attrs = new Map();
    const listeners = new Map();
    let el = null;
    const classList = createClassList(() => el);
    const capturedPointers = new Set();

    el = {
      tagName: String(tagName).toUpperCase(),
      nodeType: 1,
      namespaceURI: namespaceURI || 'http://www.w3.org/1999/xhtml',
      children: [],
      parentNode: null,
      get parentElement() {
        return el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null;
      },
      ownerDocument: null,
      type: '',
      disabled: false,
      width: 0,
      height: 0,
      _text: '',
      classList: classList,
      listeners: listeners,
      get className() {
        return classList.toArray().join(' ');
      },
      set className(val) {
        const nextTokens = String(val || '')
          .split(/\s+/)
          .filter(Boolean);
        const prev = classList.toArray().join(' ');
        const existing = classList.toArray();
        for (const c of existing) {
          if (!nextTokens.includes(c)) classList.remove(c);
        }
        for (const c of nextTokens) {
          if (!classList.contains(c)) classList.add(c);
        }
        if (prev !== classList.toArray().join(' ')) {
          attrs.set('class', classList.toArray().join(' '));
        }
      },
      get textContent() {
        if (el.children.length === 0) return el._text;
        return el._text + el.children.map((c) => c.textContent).join('');
      },
      set textContent(v) {
        el.children.length = 0;
        el._text = String(v == null ? '' : v);
      },
      get firstChild() {
        return el.children.length > 0 ? el.children[0] : null;
      },
      setAttribute(k, v) {
        const str = String(v);
        const prev = attrs.get(k);
        attrs.set(k, str);
        if (k === 'class') {
          el.className = str;
          return;
        }
        if (prev !== str) {
          notifyAttributeMutation(el, k);
        }
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      appendChild(child) {
        if (child.parentNode) {
          child.parentNode.removeChild(child);
        }
        child.parentNode = el;
        el.children.push(child);
        return child;
      },
      removeChild(child) {
        const idx = el.children.indexOf(child);
        if (idx >= 0) {
          el.children.splice(idx, 1);
          child.parentNode = null;
        }
        return child;
      },
      addEventListener(type, fn, opts) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push({ fn, opts });
      },
      removeEventListener(type, fn) {
        if (!listeners.has(type)) return;
        listeners.set(
          type,
          listeners.get(type).filter((entry) => entry.fn !== fn)
        );
      },
      dispatchEvent(ev) {
        const eventObj = Object.assign(
          {
            target: el,
            currentTarget: el,
            bubbles: true,
            cancelable: true,
            defaultPrevented: false,
            propagationStopped: false,
            preventDefault() {
              if (this.cancelable !== false) this.defaultPrevented = true;
            },
            stopPropagation() {
              this.propagationStopped = true;
            }
          },
          ev
        );
        const list = (listeners.get(eventObj.type) || []).slice();
        for (const item of list) {
          item.fn.call(el, eventObj);
        }
        if (eventObj.bubbles && !eventObj.propagationStopped && el.parentNode) {
          el.parentNode.dispatchEvent(eventObj);
        }
        return eventObj;
      },
      click() {
        return el.dispatchEvent({ type: 'click' });
      },
      getBoundingClientRect() {
        return Object.assign({}, currentRect);
      },
      querySelectorAll(selector) {
        const matches = [];
        const sel = selector.trim();
        function walk(node) {
          for (const child of node.children) {
            if (sel.startsWith('.')) {
              if (child.classList.contains(sel.slice(1))) matches.push(child);
            } else if (child.tagName.toLowerCase() === sel.toLowerCase()) {
              matches.push(child);
            }
            walk(child);
          }
        }
        walk(el);
        return matches;
      },
      querySelector(selector) {
        const all = el.querySelectorAll(selector);
        return all.length > 0 ? all[0] : null;
      }
    };

    if (el.tagName === 'CANVAS') {
      el.getContext = (kind, opts) => {
        getContextArgs.push({ kind, opts });
        return kind === '2d' ? ctx2d : null;
      };
      el.setPointerCapture = (pid) => capturedPointers.add(pid);
      el.hasPointerCapture = (pid) => capturedPointers.has(pid);
      el.releasePointerCapture = (pid) => capturedPointers.delete(pid);
    }

    return el;
  }

  const doc = {
    nodeType: 9,
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    documentElement: null,
    body: null,
    defaultView: null,
    docListeners: docListeners,
    _byId: new Map(),
    createElement(tag) {
      const node = makeElement(tag);
      node.ownerDocument = doc;
      return node;
    },
    createElementNS(ns, tag) {
      const node = makeElement(tag, ns);
      node.ownerDocument = doc;
      return node;
    },
    getElementById(id) {
      return doc._byId.get(id) || null;
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      if (!docListeners.has(type)) return;
      docListeners.set(
        type,
        docListeners.get(type).filter((f) => f !== fn)
      );
    },
    dispatchEvent(ev) {
      const list = (docListeners.get(ev.type) || []).slice();
      for (const fn of list) fn(ev);
    }
  };

  doc.documentElement = doc.createElement('html');
  doc.body = doc.createElement('body');
  doc.documentElement.appendChild(doc.body);

  const mainGrid = doc.createElement('main');
  mainGrid.className = 'grid';
  doc.body.appendChild(mainGrid);

  const section = doc.createElement('section');
  section.setAttribute('id', 'cell-draw');
  section.className = 'cell cell--draw';
  section.setAttribute('aria-label', 'Freehand Drawing Sketchpad');
  mainGrid.appendChild(section);
  doc._byId.set('cell-draw', section);

  const win = {
    document: doc,
    devicePixelRatio: 2,
    performance: { now: () => 1000 },
    winListeners: winListeners,
    setTimeout(fn, delay) {
      const id = nextTimerId++;
      const handle = setTimeout(() => {
        activeTimers.delete(id);
        fn();
      }, delay);
      activeTimers.set(id, handle);
      return id;
    },
    clearTimeout(id) {
      if (activeTimers.has(id)) {
        clearTimeout(activeTimers.get(id));
        activeTimers.delete(id);
      }
    },
    matchMedia(query) {
      const q = String(query);
      if (q.includes('prefers-reduced-motion')) {
        return { matches: reducedMotion };
      }
      dprQueries.push(q);
      return {
        media: q,
        matches: true,
        addEventListener(type, fn) {
          if (type === 'change') dprChangeHandlers.push(fn);
        },
        removeEventListener(type, fn) {
          if (type === 'change') {
            dprChangeHandlers = dprChangeHandlers.filter((f) => f !== fn);
          }
        }
      };
    },
    getComputedStyle() {
      computedStyleCalls += 1;
      return {
        getPropertyValue(prop) {
          return prop === '--dw-ink' ? ' ' + inkVar + ' ' : '';
        }
      };
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      if (!winListeners.has(type)) return;
      winListeners.set(
        type,
        winListeners.get(type).filter((f) => f !== fn)
      );
    },
    dispatchEvent(ev) {
      const list = (winListeners.get(ev.type) || []).slice();
      for (const fn of list) fn(ev);
    },
    ResizeObserver: class MockResizeObserver {
      constructor(cb) {
        resizeCallback = cb;
      }
      observe() {}
      disconnect() {
        resizeCallback = null;
      }
    },
    MutationObserver: class MockMutationObserver {
      constructor(cb) {
        mutationCallback = cb;
      }
      observe(target, opts) {
        observedTargets.push({ target, opts });
      }
      disconnect() {
        mutationCallback = null;
        observedTargets.length = 0;
      }
    }
  };

  doc.defaultView = win;

  return {
    win,
    doc,
    mainGrid,
    section,
    ctx2d,
    getContextArgs,
    dprQueries,
    observedTargets,
    getComputedStyleCalls() {
      return computedStyleCalls;
    },
    getActiveTimerCount() {
      return activeTimers.size;
    },
    hasResizeObserver() {
      return resizeCallback !== null;
    },
    hasMutationObserver() {
      return mutationCallback !== null;
    },
    setRect(nextRect) {
      currentRect = Object.assign({}, currentRect, nextRect);
      if (resizeCallback) resizeCallback();
    },
    setRectSilently(nextRect) {
      currentRect = Object.assign({}, currentRect, nextRect);
    },
    setDpr(nextDpr) {
      win.devicePixelRatio = nextDpr;
      const list = dprChangeHandlers.slice();
      for (const fn of list) fn();
    },
    getDprHandlerCount() {
      return dprChangeHandlers.length;
    },
    setInk(nextInk) {
      inkVar = nextInk;
      if (mutationCallback) mutationCallback();
    },
    setReducedMotion(flag) {
      reducedMotion = Boolean(flag);
    }
  };
}

test('Stroke normalization & unclamped out-of-bounds loop coordinates', () => {
  const rect = { left: 100, top: 50, width: 400, height: 300 };

  const center = Engine.normalizePoint(300, 200, rect);
  assert.deepEqual(center, { u: 0.5, v: 0.5 });

  const outTopLeft = Engine.normalizePoint(20, -10, rect);
  assert.equal(outTopLeft.u, -0.2);
  assert.equal(outTopLeft.v, -0.2);

  const outBottomRight = Engine.normalizePoint(580, 410, rect);
  assert.equal(outBottomRight.u, 1.2);
  assert.equal(outBottomRight.v, 1.2);

  assert.equal(Engine.normalizePoint(100, 100, { left: 0, top: 0, width: 0, height: 200 }), null);
  assert.equal(Engine.normalizePoint(NaN, 100, rect), null);
});

test('Zero-movement tap-to-dot & 1.25px jitter deadband filtering', () => {
  const engine = Engine.createEngine();
  const rect = { left: 0, top: 0, width: 320, height: 240 };

  const downOp = engine.beginStroke({
    clientX: 160,
    clientY: 120,
    rect,
    pointerType: 'mouse',
    pressure: 0.5,
    timeMs: 100
  });
  assert.equal(downOp.type, 'dot');
  assert.equal(downOp.u, 0.5);
  assert.equal(downOp.v, 0.5);

  assert.equal(
    engine.appendPoint({ clientX: 160.6, clientY: 120.4, rect, pointerType: 'mouse', timeMs: 108 }),
    null
  );
  assert.equal(
    engine.appendPoint({ clientX: 160.9, clientY: 120.7, rect, pointerType: 'mouse', timeMs: 116 }),
    null
  );

  const endRes = engine.endStroke({
    clientX: 160.5,
    clientY: 120.5,
    rect,
    pointerType: 'mouse',
    timeMs: 124
  });
  assert.equal(endRes.stroke.isDot, true);
  assert.equal(endRes.stroke.points.length, 1);

  const ctx = createMockContext2D();
  Engine.renderStroke(ctx, endRes.stroke, 320, 240, '#141413');
  const arcCall = ctx.calls.find((c) => c.fn === 'arc');
  assert.ok(arcCall, 'Tap-to-dot must render crisp filled arc');
  assert.equal(arcCall.alpha, 1);
});

test('Felt-tip velocity modulation [0.82x..1.12x], true pen pressure, and iOS touch pressure===0 immunity', () => {
  const slowMouse = Engine.computeStrokeWidthFactor({
    pointerType: 'mouse',
    pressure: 0.5,
    velocityPxPerMs: 0.02,
    prevFactor: null
  });
  const fastMouse = Engine.computeStrokeWidthFactor({
    pointerType: 'mouse',
    pressure: 0.5,
    velocityPxPerMs: 2.5,
    prevFactor: null
  });
  assert.ok(Math.abs(slowMouse - 1.12) < 1e-6);
  assert.ok(Math.abs(fastMouse - 0.82) < 1e-6);
  assert.ok(slowMouse > fastMouse);

  const iosTouchZeroPressure = Engine.computeStrokeWidthFactor({
    pointerType: 'touch',
    pressure: 0,
    velocityPxPerMs: 0.45,
    prevFactor: null
  });
  assert.ok(iosTouchZeroPressure >= 0.82 && iosTouchZeroPressure <= 1.12);

  const lightPen = Engine.computeStrokeWidthFactor({
    pointerType: 'pen',
    pressure: 0.1,
    velocityPxPerMs: 0.8,
    prevFactor: null
  });
  const firmPen = Engine.computeStrokeWidthFactor({
    pointerType: 'pen',
    pressure: 0.95,
    velocityPxPerMs: 0.8,
    prevFactor: null
  });
  assert.ok(firmPen > lightPen + 0.5);

  const zeroPenFallback = Engine.computeStrokeWidthFactor({
    pointerType: 'pen',
    pressure: 0,
    velocityPxPerMs: 0.5,
    prevFactor: null
  });
  assert.ok(zeroPenFallback >= 0.82);
});

test('3D Ramer-Douglas-Peucker compaction & session vertex budget preserve all strokes without stack overflow', () => {
  const collinear = [];
  for (let i = 0; i < 60; i++) {
    const t = i / 59;
    collinear.push({ u: 0.1 + 0.8 * t, v: 0.2 + 0.6 * t, w: 1.0 });
  }
  const compactedLine = Engine.compactPointsRDP(collinear, 400, 300, 0.28);
  assert.equal(compactedLine.length, 2);

  const pressureSwell = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    pressureSwell.push({
      u: 0.1 + 0.8 * t,
      v: 0.5,
      w: 0.55 + Math.sin(t * Math.PI) * 0.95
    });
  }
  const compactedSwell = Engine.compactPointsRDP(pressureSwell, 400, 300, 0.28);
  assert.ok(compactedSwell.length >= 3);

  const huge = [];
  for (let i = 0; i < 8000; i++) {
    const t = i / 7999;
    huge.push({ u: t, v: 0.5 + 0.2 * Math.cos(t * 40), w: 1.0 });
  }
  const compactedHuge = Engine.compactPointsRDP(huge, 400, 300, 0.28);
  assert.ok(compactedHuge.length > 20 && compactedHuge.length < 2500);

  // Vertex budget compaction coarsens older dense strokes without deleting any stroke
  const budgeted = Engine.createEngine({ maxTotalVertices: 40, rdpEpsilonPx: 0.05 });
  const rect = { left: 0, top: 0, width: 400, height: 300 };
  for (let s = 0; s < 3; s++) {
    budgeted.beginStroke({ clientX: 20, clientY: 50 + s * 40, rect, pointerType: 'mouse', timeMs: 0 });
    for (let i = 1; i <= 30; i++) {
      budgeted.appendPoint({
        clientX: 20 + i * 10,
        clientY: 50 + s * 40 + Math.sin(i * 0.35) * 0.7,
        rect,
        pointerType: 'mouse',
        timeMs: i * 8
      });
    }
    budgeted.endStroke(null);
  }
  assert.equal(budgeted.getStrokeCount(), 3);
  assert.equal(budgeted.getStrokes()[0].budgetCompacted, true);
});

test('Simulated DOM/Canvas mount invariants, single button rule, fractional DPR, pointer edge cases & cleanup', async () => {
  const dom = createSimulatedDom({ left: 10, top: 20, width: 175.33, height: 131.5 }, '#141413');
  const instance = UI.mount(dom.section, { engine: Engine });
  assert.ok(instance);

  // Standard synchronized 2D context (never { desynchronized: true })
  assert.equal(dom.getContextArgs.length, 1);
  assert.equal(dom.getContextArgs[0].kind, '2d');
  assert.equal(dom.getContextArgs[0].opts, undefined);

  // STRICTLY ONE BUTTON (`cell.querySelectorAll('button').length === 1`)
  const buttons = dom.section.querySelectorAll('button');
  assert.equal(buttons.length, 1, 'Cell must contain strictly ONE button (Clear)');
  assert.equal(buttons[0].textContent, 'Clear');
  assert.equal(buttons[0].disabled, false, 'Clear button must NEVER set disabled=true');
  assert.equal(buttons[0].getAttribute('aria-disabled'), 'true');

  // Fractional CSS grid width exact-edge setTransform(targetW / rect.width, ...)
  assert.equal(instance.canvas.width, 351);
  assert.equal(instance.canvas.height, 263);
  const lastTransform = dom.ctx2d.calls.filter((c) => c.fn === 'setTransform').pop();
  assert.ok(Math.abs(lastTransform.args[0] - 351 / 175.33) < 1e-9);
  assert.ok(Math.abs(lastTransform.args[3] - 263 / 131.5) < 1e-9);

  // Cross-monitor DPR watcher updates backing store when moving from 2x Retina to 1x external monitor
  assert.equal(dom.getDprHandlerCount(), 1);
  dom.setDpr(1);
  assert.equal(instance.canvas.width, 175);
  assert.equal(instance.canvas.height, 132);
  dom.setDpr(2);
  assert.equal(instance.canvas.width, 351);

  // Zero global window keyboard listeners (coexists with MotionGrid r/R)
  assert.equal(dom.win.winListeners.has('keydown'), false);

  // Touch scroll prevention & contextmenu suppression attached ONLY to <canvas>, NEVER to Clear button
  assert.equal(instance.canvas.dispatchEvent({ type: 'touchmove', cancelable: true }).defaultPrevented, true);
  assert.equal(instance.canvas.dispatchEvent({ type: 'contextmenu', cancelable: true }).defaultPrevented, true);
  assert.equal(instance.clearBtn.dispatchEvent({ type: 'touchstart', cancelable: true }).defaultPrevented, false);

  // Clear button pointerdown stops propagation and clicking Clear while empty is a no-op
  const clearDownEvt = instance.clearBtn.dispatchEvent({
    type: 'pointerdown',
    pointerId: 1,
    pointerType: 'touch',
    clientX: 170,
    clientY: 30
  });
  assert.equal(clearDownEvt.propagationStopped, true);
  instance.clearBtn.click();
  assert.equal(dom.section.classList.contains('is-clearing'), false);

  // Right-click ignored
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 1,
    pointerType: 'mouse',
    button: 2,
    buttons: 2,
    clientX: 60,
    clientY: 70,
    timeStamp: 10
  });
  assert.equal(instance.engine.isEmpty(), true);

  // Primary touch with iOS pressure===0 immediately hides empty cue & enables Clear
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 11,
    pointerType: 'touch',
    pressure: 0,
    clientX: 40,
    clientY: 50,
    timeStamp: 100
  });
  assert.equal(dom.section.classList.contains('is-drawing'), true);
  assert.equal(dom.section.classList.contains('has-ink'), true);
  assert.equal(instance.clearBtn.getAttribute('aria-disabled'), 'false');

  // Second concurrent finger ignored
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 22,
    pointerType: 'touch',
    clientX: 150,
    clientY: 100,
    timeStamp: 105
  });
  assert.equal(instance.engine.getActiveStroke().points.length, 1);

  // WebKit empty-array getCoalescedEvents() fallback + unclamped out-of-bounds drag
  instance.canvas.dispatchEvent({
    type: 'pointermove',
    pointerId: 11,
    pointerType: 'touch',
    pressure: 0,
    clientX: 5,
    clientY: 80,
    timeStamp: 116,
    getCoalescedEvents: () => []
  });
  assert.ok(instance.engine.getActiveStroke().points[1].u < 0);

  // Coalesced samples emit quadratic spline curves
  instance.canvas.dispatchEvent({
    type: 'pointermove',
    pointerId: 11,
    pointerType: 'touch',
    pressure: 0,
    clientX: 120,
    clientY: 110,
    timeStamp: 132,
    getCoalescedEvents: () => [
      { clientX: 60, clientY: 95, timeStamp: 124 },
      { clientX: 120, clientY: 110, timeStamp: 132 }
    ]
  });
  instance.canvas.dispatchEvent({
    type: 'pointerup',
    pointerId: 11,
    pointerType: 'touch',
    clientX: 125,
    clientY: 112,
    timeStamp: 140
  });
  assert.equal(dom.section.classList.contains('is-drawing'), false);
  assert.equal(instance.engine.getStrokeCount(), 1);
  assert.ok(dom.ctx2d.calls.some((c) => c.fn === 'quadraticCurveTo'));

  // macOS Mission Control dropped-release (buttons === 0 on mouse pointermove)
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 31,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: 50,
    clientY: 60,
    timeStamp: 200
  });
  instance.canvas.dispatchEvent({
    type: 'pointermove',
    pointerId: 31,
    pointerType: 'mouse',
    buttons: 0,
    clientX: 90,
    clientY: 95,
    timeStamp: 216
  });
  assert.equal(dom.section.classList.contains('is-drawing'), false);
  assert.equal(instance.engine.getStrokeCount(), 2);

  // Zero-size hidden-grid transition (e.g. main.grid[hidden]) finalizes active stroke & preserves strokes
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 35,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: 75,
    clientY: 75,
    timeStamp: 240
  });
  dom.setRect({ width: 0, height: 0 });
  assert.equal(dom.section.classList.contains('is-drawing'), false);
  assert.equal(instance.engine.getStrokeCount(), 3);

  // Restore MotionGrid 140x105px -> 960x720px and verify stroke retention + theme re-inking
  dom.setRect({ width: 140, height: 105 });
  assert.equal(instance.canvas.width, 280);
  dom.setRect({ width: 960, height: 720 });
  assert.equal(instance.canvas.width, 1920);

  dom.ctx2d.calls.length = 0;
  dom.setInk('#f5f5f3');
  assert.ok(dom.ctx2d.calls.some((c) => c.strokeStyle === '#f5f5f3' || c.fillStyle === '#f5f5f3'));

  // Clear wipes strokes, triggers 130ms veil, and announces politely after 16ms tick
  instance.clearBtn.click();
  assert.equal(instance.engine.isEmpty(), true);
  assert.equal(dom.section.classList.contains('is-clearing'), true);
  assert.equal(instance.clearBtn.getAttribute('aria-disabled'), 'true');
  assert.equal(instance.clearBtn.disabled, false);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(instance.liveStatus.textContent, 'Canvas cleared');

  // Reduced motion skips clear veil
  dom.setReducedMotion(true);
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 50,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: 60,
    clientY: 60,
    timeStamp: 400
  });
  instance.canvas.dispatchEvent({
    type: 'pointerup',
    pointerId: 50,
    pointerType: 'mouse',
    clientX: 60,
    clientY: 60,
    timeStamp: 410
  });
  instance.clearBtn.click();
  assert.equal(dom.section.classList.contains('is-clearing'), false);

  instance.destroy();
  assert.equal(dom.getDprHandlerCount(), 0);
});

test('Classic <script defer> IIFE execution over file:// with zero DOM string injection & CSS contract check', () => {
  const engineSrc = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(__dirname, 'draw.css'), 'utf8');

  const forbiddenMarkupApi = new RegExp('inner' + 'HTML|outer' + 'HTML|insertAdjacent' + 'HTML');
  assert.equal(forbiddenMarkupApi.test(engineSrc), false);
  assert.equal(forbiddenMarkupApi.test(uiSrc), false);

  const dom = createSimulatedDom({ left: 0, top: 0, width: 420, height: 315 }, '#141413');
  const sandbox = {
    window: dom.win,
    document: dom.doc,
    ResizeObserver: dom.win.ResizeObserver,
    MutationObserver: dom.win.MutationObserver,
    performance: dom.win.performance,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout
  };
  sandbox.globalThis = sandbox;
  dom.win.GeminiDraw = undefined;

  const ctx = vm.createContext(sandbox);
  vm.runInContext(engineSrc, ctx, { filename: 'engine.js' });
  vm.runInContext(uiSrc, ctx, { filename: 'ui.js' });

  assert.ok(dom.win.GeminiDraw && dom.win.GeminiDraw.Engine && dom.win.GeminiDraw.UI);
  assert.equal(sandbox.GeminiDraw, dom.win.GeminiDraw);
  assert.equal(dom.section.querySelectorAll('button').length, 1);
  assert.equal(dom.section.querySelectorAll('canvas').length, 1);

  assert.ok(cssSrc.includes('.cell--draw'));
  assert.ok(cssSrc.includes('.cell.cell--draw'));
  assert.ok(cssSrc.includes('#6e6e6a'));
  assert.ok(cssSrc.includes('var(--dw-focus)'));
  assert.ok(cssSrc.includes('@media (pointer: coarse)'));
  assert.ok(cssSrc.includes('@media (forced-colors: active)'));
  assert.ok(cssSrc.includes('prefers-reduced-motion: reduce'));
  assert.equal(Engine.denormalizePoint, undefined);
});

test('5-path stroke termination matrix: window pointerup outside canvas, pointercancel, lostpointercapture, blur & visibilitychange', () => {
  const dom = createSimulatedDom({ left: 10, top: 20, width: 400, height: 300 }, '#141413');
  const instance = UI.mount(dom.section, { engine: Engine });

  // 1. window pointerup outside canvas appends final out-of-bounds endpoint & releases capture
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 101,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: 100,
    clientY: 120,
    timeStamp: 10
  });
  assert.equal(instance.canvas.hasPointerCapture(101), true);
  instance.canvas.dispatchEvent({
    type: 'pointermove',
    pointerId: 101,
    pointerType: 'mouse',
    buttons: 1,
    clientX: 250,
    clientY: 180,
    timeStamp: 20
  });
  dom.win.dispatchEvent({
    type: 'pointerup',
    pointerId: 101,
    pointerType: 'mouse',
    clientX: 460,
    clientY: 360,
    timeStamp: 30
  });
  assert.equal(dom.section.classList.contains('is-drawing'), false);
  assert.equal(instance.canvas.hasPointerCapture(101), false);
  assert.equal(instance.engine.getStrokeCount(), 1);
  const s0 = instance.engine.getStrokes()[0];
  assert.ok(s0.points[s0.points.length - 1].u > 1, 'Outside window pointerup preserves unclamped u > 1');

  // 2a. canvas pointercancel
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 102,
    pointerType: 'touch',
    clientX: 80,
    clientY: 80,
    timeStamp: 40
  });
  instance.canvas.dispatchEvent({
    type: 'pointercancel',
    pointerId: 102,
    pointerType: 'touch',
    timeStamp: 50
  });
  assert.equal(dom.section.classList.contains('is-drawing'), false);
  assert.equal(instance.canvas.hasPointerCapture(102), false);
  assert.equal(instance.engine.getStrokeCount(), 2);

  // 2b. window pointercancel
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 103,
    pointerType: 'touch',
    clientX: 90,
    clientY: 90,
    timeStamp: 60
  });
  dom.win.dispatchEvent({
    type: 'pointercancel',
    pointerId: 103,
    pointerType: 'touch',
    timeStamp: 70
  });
  assert.equal(dom.section.classList.contains('is-drawing'), false);
  assert.equal(instance.canvas.hasPointerCapture(103), false);
  assert.equal(instance.engine.getStrokeCount(), 3);

  // 3. canvas lostpointercapture
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 104,
    pointerType: 'pen',
    button: 0,
    pressure: 0.5,
    clientX: 140,
    clientY: 140,
    timeStamp: 80
  });
  instance.canvas.dispatchEvent({
    type: 'lostpointercapture',
    pointerId: 104,
    pointerType: 'pen',
    timeStamp: 90
  });
  assert.equal(dom.section.classList.contains('is-drawing'), false);
  assert.equal(instance.engine.getStrokeCount(), 4);

  // 4. window blur
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 105,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: 160,
    clientY: 160,
    timeStamp: 100
  });
  dom.win.dispatchEvent({ type: 'blur' });
  assert.equal(dom.section.classList.contains('is-drawing'), false);
  assert.equal(instance.canvas.hasPointerCapture(105), false);
  assert.equal(instance.engine.getStrokeCount(), 5);

  // 5. document visibilitychange (ignores visible, finalizes on hidden)
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 106,
    pointerType: 'touch',
    clientX: 180,
    clientY: 180,
    timeStamp: 110
  });
  dom.doc.hidden = false;
  dom.doc.visibilityState = 'visible';
  dom.doc.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(dom.section.classList.contains('is-drawing'), true);

  dom.doc.hidden = true;
  dom.doc.visibilityState = 'hidden';
  dom.doc.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(dom.section.classList.contains('is-drawing'), false);
  assert.equal(instance.canvas.hasPointerCapture(106), false);
  assert.equal(instance.engine.getStrokeCount(), 6);

  instance.destroy();
});

test('Re-mount idempotency, full listener/observer/timer teardown & post-destroy() no-op guard', async () => {
  assert.equal(UI.mountDrawCell, UI.mount);

  const dom = createSimulatedDom({ left: 0, top: 0, width: 360, height: 270 }, '#141413');
  const first = UI.mount(dom.section, { engine: Engine });

  //Initial 2x mount binds DPR media query strictly ONCE using ±0.001dppx range syntax
  assert.equal(dom.dprQueries.length, 1);
  assert.equal(dom.dprQueries[0], '(min-resolution: 1.9990dppx) and (max-resolution: 2.0010dppx)');

  // Start stroke on first mount, then re-mount on same rootEl
  first.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 7,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: 40,
    clientY: 40,
    timeStamp: 10
  });
  assert.equal(first.canvas.hasPointerCapture(7), true);

  const second = UI.mountDrawCell(dom.section, { engine: Engine });
  assert.notEqual(second, first);
  assert.equal(first.canvas.hasPointerCapture(7), false);
  assert.equal(dom.section.querySelectorAll('canvas').length, 1);
  assert.equal(dom.section.querySelectorAll('button').length, 1);
  assert.equal(dom.getDprHandlerCount(), 1);
  assert.equal((dom.win.winListeners.get('pointerup') || []).length, 1);
  assert.equal((dom.win.winListeners.get('pointercancel') || []).length, 1);
  assert.equal((dom.win.winListeners.get('blur') || []).length, 1);
  assert.equal((dom.win.winListeners.get('resize') || []).length, 1);
  assert.equal((dom.doc.docListeners.get('visibilitychange') || []).length, 1);

  // Schedule both 130ms clear veil timer and 16ms aria-live timer, plus an active stroke
  second.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 8,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: 60,
    clientY: 60,
    timeStamp: 20
  });
  second.canvas.dispatchEvent({
    type: 'pointerup',
    pointerId: 8,
    pointerType: 'mouse',
    clientX: 60,
    clientY: 60,
    timeStamp: 30
  });
  second.clearBtn.click();
  assert.equal(dom.getActiveTimerCount(), 2, 'Both clear veil and polite announce timers active');

  second.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 9,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: 90,
    clientY: 90,
    timeStamp: 35
  });
  assert.equal(second.canvas.hasPointerCapture(9), true);

  second.destroy();

  // Verify 100% teardown of capture, timers, observers, and listeners
  assert.equal(second.canvas.hasPointerCapture(9), false);
  assert.equal(dom.getActiveTimerCount(), 0);
  assert.equal(dom.getDprHandlerCount(), 0);
  assert.equal(dom.hasResizeObserver(), false);
  assert.equal(dom.hasMutationObserver(), false);
  assert.equal(dom.section.__geminiDrawInstance, undefined);

  for (const [, handlers] of second.canvas.listeners) {
    assert.equal(handlers.length, 0);
  }
  for (const [, handlers] of second.clearBtn.listeners) {
    assert.equal(handlers.length, 0);
  }
  for (const [, handlers] of dom.win.winListeners) {
    assert.equal(handlers.length, 0);
  }
  for (const [, handlers] of dom.doc.docListeners) {
    assert.equal(handlers.length, 0);
  }

  // Post-destroy() public API calls must NOT resurrect DPR listeners, timers, or redraws
  dom.ctx2d.calls.length = 0;
  dom.win.devicePixelRatio = 2.200000047683716;
  assert.equal(second.clear(), false);
  second.resize();
  second.refreshTheme();
  second.destroy();

  assert.equal(dom.getDprHandlerCount(), 0);
  assert.equal(dom.getActiveTimerCount(), 0);
  assert.equal(dom.ctx2d.calls.length, 0);

  await new Promise((r) => setTimeout(r, 30));
  assert.equal(second.liveStatus.textContent, '');
});

test('Stylus buttons, pen hover drop, lift-off tail taper, palm-before-pen preemption, pointerId===0, NaN safety, clear races & mid-stroke resize', () => {
  // Pen lift-off tail taper: pressure===0 with prev!==null tapers by 0.92x instead of flaring to [0.82x..1.12x]
  const hairlineLift = Engine.computeStrokeWidthFactor({
    pointerType: 'pen',
    pressure: 0,
    velocityPxPerMs: 0.02,
    prevFactor: 0.58
  });
  assert.ok(Math.abs(hairlineLift - Math.max(Engine.PEN_WIDTH_MIN, 0.58 * 0.92)) < 1e-9);
  assert.ok(hairlineLift < 0.58, 'Hairline pen lift-off must taper thinner, never flare up');

  const dom = createSimulatedDom({ left: 10, top: 20, width: 400, height: 300 }, '#141413');
  const instance = UI.mount(dom.section, { engine: Engine });

  // Verify MutationObserver observes html, body, and main.grid with class, but rootEl WITHOUT class
  const rootObs = dom.observedTargets.find((o) => o.target === dom.section);
  const gridObs = dom.observedTargets.find((o) => o.target === dom.mainGrid);
  assert.ok(rootObs && gridObs);
  assert.deepEqual(rootObs.opts.attributeFilter, ['data-theme', 'style']);
  assert.deepEqual(gridObs.opts.attributeFilter, ['data-theme', 'class', 'style']);

  // Fractional zoom DPR range query (e.g. 110% Retina zoom = 2.200000047683716)
  dom.setDpr(2.200000047683716);
  assert.equal(
    dom.dprQueries[dom.dprQueries.length - 1],
    '(min-resolution: 2.1990dppx) and (max-resolution: 2.2010dppx)'
  );
  dom.setDpr(2);

  // Reject middle-click (button: 1), pen barrel (button: 2), and pen eraser (button: 5)
  for (const rejected of [
    { pointerId: 1, pointerType: 'mouse', button: 1, buttons: 4 },
    { pointerId: 2, pointerType: 'pen', button: 2, buttons: 2, pressure: 0.6 },
    { pointerId: 3, pointerType: 'pen', button: 5, buttons: 32, pressure: 0.6 }
  ]) {
    instance.canvas.dispatchEvent(
      Object.assign({ type: 'pointerdown', clientX: 80, clientY: 80, timeStamp: 10 }, rejected)
    );
  }
  assert.equal(instance.engine.isEmpty(), true);

  // NaN clientX fails beginStroke BEFORE setPointerCapture (zero capture leak)
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 77,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: NaN,
    clientY: 100,
    timeStamp: 12
  });
  assert.equal(instance.canvas.hasPointerCapture(77), false);
  assert.equal(dom.section.classList.contains('is-drawing'), false);

  // pointerId: NaN normalizes safely without locking activePointerId to NaN
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: NaN,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: 50,
    clientY: 50,
    timeStamp: 14
  });
  instance.canvas.dispatchEvent({
    type: 'pointerup',
    pointerId: NaN,
    pointerType: 'mouse',
    clientX: 50,
    clientY: 50,
    timeStamp: 16
  });
  assert.equal(dom.section.classList.contains('is-drawing'), false);
  assert.equal(instance.engine.getStrokeCount(), 1);
  instance.clear();

  // pointerId === 0 (falsy valid pointer ID) + monotonic timestamps + timeStamp===0 fallback
  const stylesBeforeZeroStroke = dom.getComputedStyleCalls();
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 0,
    pointerType: 'touch',
    button: 0,
    clientX: 60,
    clientY: 70,
    timeStamp: 0 // 0 falls back to win.performance.now() (1000)
  });
  assert.equal(instance.canvas.hasPointerCapture(0), true);
  assert.equal(instance.engine.getActiveStroke().lastTimeMs, 1000);
  // Toggling is-drawing / has-ink on rootEl triggered only the single explicit readInkColor() call, zero observer self-triggers
  assert.equal(dom.getComputedStyleCalls() - stylesBeforeZeroStroke, 1);

  // Concurrent pointerId: 1 ignored while pointerId: 0 owns active stroke
  instance.canvas.dispatchEvent({
    type: 'pointermove',
    pointerId: 1,
    pointerType: 'touch',
    clientX: 200,
    clientY: 200,
    timeStamp: 1010
  });
  assert.equal(instance.engine.getActiveStroke().points.length, 1);

  // Coalesced samples with timeStamp: 0 (uses parent 1020) and out-of-order 1012 (clamped monotonically to 1020)
  instance.canvas.dispatchEvent({
    type: 'pointermove',
    pointerId: 0,
    pointerType: 'touch',
    clientX: 130,
    clientY: 110,
    timeStamp: 1020,
    getCoalescedEvents: () => [
      { clientX: 90, clientY: 90, timeStamp: 0 },
      { clientX: 110, clientY: 100, timeStamp: 1012 },
      { clientX: 130, clientY: 110, timeStamp: 1028 }
    ]
  });
  assert.equal(instance.engine.getActiveStroke().lastTimeMs, 1028);
  assert.equal(instance.engine.getVertexCount(), 4);

  instance.canvas.dispatchEvent({
    type: 'pointerup',
    pointerId: 0,
    pointerType: 'touch',
    clientX: 140,
    clientY: 115,
    timeStamp: 1036
  });
  assert.equal(instance.canvas.hasPointerCapture(0), false);
  assert.equal(instance.engine.getStrokeCount(), 1);

  // iPad palm-before-pen preemption: accidental palm touch dot (< 1.25px) is discarded when pen arrives
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 41,
    pointerType: 'touch',
    button: 0,
    clientX: 300,
    clientY: 240,
    timeStamp: 1100
  });
  assert.equal(instance.canvas.hasPointerCapture(41), true);
  assert.equal(instance.engine.getActiveStroke().isDot, true);

  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 42,
    pointerType: 'pen',
    button: 0,
    buttons: 1,
    pressure: 0.2,
    clientX: 120,
    clientY: 140,
    timeStamp: 1104
  });
  assert.equal(instance.canvas.hasPointerCapture(41), false, 'Palm pointer capture released');
  assert.equal(instance.canvas.hasPointerCapture(42), true, 'Stylus pointer capture acquired');
  assert.equal(instance.engine.getActiveStroke().pointerType, 'pen');
  assert.equal(instance.engine.getStrokeCount(), 1, 'Palm dot discarded, prior stroke preserved');

  // Trailing palm move/up ignored while pen draws and tapers on lift-off
  instance.canvas.dispatchEvent({
    type: 'pointermove',
    pointerId: 41,
    pointerType: 'touch',
    clientX: 340,
    clientY: 260,
    timeStamp: 1110
  });
  instance.canvas.dispatchEvent({
    type: 'pointermove',
    pointerId: 42,
    pointerType: 'pen',
    buttons: 1,
    pressure: 0.15,
    clientX: 160,
    clientY: 155,
    timeStamp: 1112
  });
  const penMidW = instance.engine.getActiveStroke().points[1].w;
  instance.canvas.dispatchEvent({
    type: 'pointerup',
    pointerId: 42,
    pointerType: 'pen',
    pressure: 0,
    clientX: 175,
    clientY: 160,
    timeStamp: 1120
  });
  assert.equal(instance.engine.getStrokeCount(), 2);
  const penPts = instance.engine.getStrokes()[1].points;
  assert.ok(penPts[penPts.length - 1].w <= penMidW, 'Pen lift-off pressure:0 tapers without flaring');

  // Active finger curve beyond 1.25px (isDot === false) is NOT cancelled by stray pen contact
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 45,
    pointerType: 'touch',
    button: 0,
    clientX: 50,
    clientY: 50,
    timeStamp: 1150
  });
  instance.canvas.dispatchEvent({
    type: 'pointermove',
    pointerId: 45,
    pointerType: 'touch',
    clientX: 80,
    clientY: 70,
    timeStamp: 1160
  });
  assert.equal(instance.engine.getActiveStroke().isDot, false);
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 46,
    pointerType: 'pen',
    button: 0,
    buttons: 1,
    pressure: 0.5,
    clientX: 200,
    clientY: 200,
    timeStamp: 1165
  });
  assert.equal(instance.engine.getActiveStroke().pointerType, 'touch');
  instance.canvas.dispatchEvent({
    type: 'pointerup',
    pointerId: 45,
    pointerType: 'touch',
    clientX: 85,
    clientY: 75,
    timeStamp: 1170
  });
  assert.equal(instance.engine.getStrokeCount(), 3);

  // Pen hover dropped-release (buttons === 0 on pen pointermove) terminates immediately
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 48,
    pointerType: 'pen',
    button: 0,
    buttons: 1,
    pressure: 0.5,
    clientX: 90,
    clientY: 90,
    timeStamp: 1200
  });
  instance.canvas.dispatchEvent({
    type: 'pointermove',
    pointerId: 48,
    pointerType: 'pen',
    buttons: 0,
    pressure: 0,
    clientX: 150,
    clientY: 150,
    timeStamp: 1216
  });
  assert.equal(dom.section.classList.contains('is-drawing'), false);
  assert.equal(instance.engine.getStrokeCount(), 4);

  // Mid-stroke clearCanvas() + rapid clear -> draw -> clear phase alternation within 130ms
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 60,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: 100,
    clientY: 100,
    timeStamp: 1300
  });
  assert.equal(instance.canvas.hasPointerCapture(60), true);
  const phaseBeforeFirstRapidClear = dom.section.getAttribute('data-clear-phase');
  assert.equal(instance.clear(), true);
  assert.equal(instance.canvas.hasPointerCapture(60), false);
  assert.equal(dom.section.classList.contains('is-drawing'), false);
  assert.equal(dom.section.classList.contains('is-clearing'), true);
  const phaseFirstRapidClear = dom.section.getAttribute('data-clear-phase');
  assert.notEqual(phaseFirstRapidClear, phaseBeforeFirstRapidClear);

  // Trailing move from cleared stroke ignored
  instance.canvas.dispatchEvent({
    type: 'pointermove',
    pointerId: 60,
    pointerType: 'mouse',
    buttons: 1,
    clientX: 180,
    clientY: 180,
    timeStamp: 1310
  });
  assert.equal(instance.engine.isEmpty(), true);

  // Immediate new stroke during 130ms veil cancels is-clearing, then second clear flips phase again
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 61,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: 110,
    clientY: 110,
    timeStamp: 1320
  });
  assert.equal(dom.section.classList.contains('is-clearing'), false);

  // Mid-stroke resize BEFORE ResizeObserver fires syncs backing store & transform on pointermove and pointerup
  dom.setRectSilently({ width: 600, height: 450 });
  instance.canvas.dispatchEvent({
    type: 'pointermove',
    pointerId: 61,
    pointerType: 'mouse',
    buttons: 1,
    clientX: 310,
    clientY: 245,
    timeStamp: 1336
  });
  assert.equal(instance.canvas.width, 1200);
  assert.equal(instance.canvas.height, 900);

  dom.setRectSilently({ width: 500, height: 375 });
  instance.canvas.dispatchEvent({
    type: 'pointerup',
    pointerId: 61,
    pointerType: 'mouse',
    clientX: 260,
    clientY: 207.5,
    timeStamp: 1352
  });
  assert.equal(instance.canvas.width, 1000);
  assert.equal(instance.canvas.height, 750);

  assert.equal(instance.clear(), true);
  assert.equal(dom.section.classList.contains('is-clearing'), true);
  assert.notEqual(dom.section.getAttribute('data-clear-phase'), phaseFirstRapidClear);

  // Ancestor main.grid [data-theme="dark"] triggers observer & attribute fallback when CSS var absent
  dom.setInk('');
  dom.mainGrid.setAttribute('data-theme', 'dark');
  instance.canvas.dispatchEvent({
    type: 'pointerdown',
    pointerId: 62,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: 70,
    clientY: 70,
    timeStamp: 1400
  });
  assert.ok(dom.ctx2d.calls.some((c) => c.fillStyle === '#f5f5f3'));

  instance.destroy();
});

test('Per-stroke authoring (refW, refH) budget compaction & 1-to-1 live incremental vs renderStroke parity', () => {
  // 1. Older 960x720 stroke retains fine 2px waves when budget triggers later at 140x105
  const budgeted = Engine.createEngine({ maxTotalVertices: 25, rdpEpsilonPx: 0.01 });
  const largeRect = { left: 0, top: 0, width: 960, height: 720 };
  const microRect = { left: 0, top: 0, width: 140, height: 105 };

  budgeted.beginStroke({ clientX: 40, clientY: 360, rect: largeRect, pointerType: 'mouse', timeMs: 0 });
  for (let i = 1; i <= 20; i++) {
    budgeted.appendPoint({
      clientX: 40 + i * 40,
      clientY: 360 + (i % 2 === 0 ? 2.4 : -2.4), // 2.4px > 0.85px at 960x720, but only 0.35px (< 0.85px) if mis-scaled at 140x105!
      rect: largeRect,
      pointerType: 'mouse',
      timeMs: i * 8
    });
  }
  budgeted.endStroke(null);
  assert.equal(budgeted.getStrokes()[0].refW, 960);
  assert.equal(budgeted.getStrokes()[0].refH, 720);

  budgeted.beginStroke({ clientX: 10, clientY: 50, rect: microRect, pointerType: 'mouse', timeMs: 300 });
  for (let i = 1; i <= 15; i++) {
    budgeted.appendPoint({
      clientX: 10 + i * 8,
      clientY: 50 + (i % 2 === 0 ? 3 : -3),
      rect: microRect,
      pointerType: 'mouse',
      timeMs: 300 + i * 8
    });
  }
  budgeted.endStroke(null);
  assert.equal(budgeted.getStrokes()[0].budgetCompacted, true);
  assert.ok(
    budgeted.getStrokes()[0].points.length >= 18,
    '960x720 stroke compacted at its own (960, 720) scale preserves 2.4px detail'
  );

  // 2. Exact 1-to-1 draw call parity between live incremental ops and renderStroke (active & finalized)
  const rect = { left: 0, top: 0, width: 400, height: 300 };
  const samples = [
    [{ x: 100, y: 100, t: 10 }],
    [
      { x: 50, y: 60, t: 10 },
      { x: 110, y: 90, t: 22 }
    ],
    [
      { x: 40, y: 50, t: 10 },
      { x: 75, y: 85, t: 18 },
      { x: 130, y: 70, t: 28 },
      { x: 190, y: 130, t: 40 },
      { x: 245, y: 115, t: 50 },
      { x: 300, y: 165, t: 62 }
    ]
  ];

  for (const seq of samples) {
    const eng = Engine.createEngine({ rdpEpsilonPx: 0 });
    const liveCtx = createMockContext2D();

    const op0 = eng.beginStroke({
      clientX: seq[0].x,
      clientY: seq[0].y,
      rect,
      pointerType: 'mouse',
      timeMs: seq[0].t
    });
    Engine.drawOp(liveCtx, op0, rect.width, rect.height, '#141413');

    for (let i = 1; i < seq.length; i++) {
      const op = eng.appendPoint({
        clientX: seq[i].x,
        clientY: seq[i].y,
        rect,
        pointerType: 'mouse',
        timeMs: seq[i].t
      });
      if (op) Engine.drawOp(liveCtx, op, rect.width, rect.height, '#141413');
    }

    // Active mid-stroke parity check (before endStroke)
    const activeReplayCtx = createMockContext2D();
    Engine.renderStroke(activeReplayCtx, eng.getActiveStroke(), rect.width, rect.height, '#141413');
    assert.deepEqual(liveCtx.calls, activeReplayCtx.calls);

    // Finalized stroke parity check (after endStroke)
    const ended = eng.endStroke(null);
    for (const op of ended.ops) {
      Engine.drawOp(liveCtx, op, rect.width, rect.height, '#141413');
    }
    const finalReplayCtx = createMockContext2D();
    Engine.renderStroke(finalReplayCtx, ended.stroke, rect.width, rect.height, '#141413');
    assert.deepEqual(liveCtx.calls, finalReplayCtx.calls);
  }
});

test('Dark-mode CSS specificity & forced-colors contract beat index.html .cell rule', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const drawCss = fs.readFileSync(path.join(__dirname, 'draw.css'), 'utf8');

  const linkIdx = indexHtml.indexOf('cells/draw/draw.css');
  const styleIdx = indexHtml.indexOf('<style>');
  assert.ok(linkIdx > 0 && styleIdx > linkIdx, 'index.html inline <style> appears after draw.css link');
  assert.match(indexHtml, /\.cell\s*\{[^}]*background:\s*#ffffff/s);

  function selectorSpecificity(sel) {
    const clean = sel.replace(/:not\(([^)]*)\)/g, ' $1 ');
    const ids = (clean.match(/#[a-zA-Z0-9_-]+/g) || []).length;
    const classesAndAttrs =
      (clean.match(/\.[a-zA-Z0-9_-]+/g) || []).length +
      (clean.match(/\[[^\]]+\]/g) || []).length +
      (clean.match(/:(?!:)[a-zA-Z0-9_-]+/g) || []).length;
    return [ids, classesAndAttrs];
  }

  const indexCellSpec = selectorSpecificity('.cell');
  const lightDrawSpec = selectorSpecificity('.cell.cell--draw');
  const darkAncestorSpec = selectorSpecificity('[data-theme="dark"] .cell.cell--draw');
  const darkSelfSpec = selectorSpecificity('.cell.cell--draw[data-theme="dark"]');

  assert.deepEqual(indexCellSpec, [0, 1]);
  assert.deepEqual(lightDrawSpec, [0, 2]);
  assert.deepEqual(darkAncestorSpec, [0, 3]);
  assert.deepEqual(darkSelfSpec, [0, 3]);

  // Verify light rule includes .cell.cell--draw with background & border-color
  assert.match(
    drawCss,
    /\.cell--draw,\s*\.cell\.cell--draw\s*\{[^}]*background:\s*var\(--dw-paper\);[^}]*border-color:\s*var\(--dw-border\);/s
  );

  // Verify dark rule includes .cell.cell--draw specificity, #4a4a45 strong border, background & border-color
  assert.match(
    drawCss,
    /\[data-theme="dark"\]\s*\.cell\.cell--draw,\s*\.cell--draw\[data-theme="dark"\],\s*\.cell\.cell--draw\[data-theme="dark"\]\s*\{[^}]*--dw-paper:\s*#141413;[^}]*--dw-ink:\s*#f5f5f3;[^}]*--dw-border:\s*#2a2a28;[^}]*--dw-border-strong:\s*#4a4a45;[^}]*background:\s*var\(--dw-paper\);[^}]*border-color:\s*var\(--dw-border\);/s
  );

  // Verify @media (forced-colors: active) locks paper surface while preserving native system Clear button colors
  const forcedMatch = drawCss.match(/@media\s*\(forced-colors:\s*active\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(forcedMatch, '@media (forced-colors: active) block exists');
  assert.match(
    forcedMatch[1],
    /\.cell--draw,\s*\.cell\.cell--draw\s*\{\s*forced-color-adjust:\s*none;\s*\}/
  );
  assert.match(forcedMatch[1], /\.dw-clear\s*\{[^}]*forced-color-adjust:\s*auto;/s);
});
