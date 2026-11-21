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
  const getContextArgs = [];
  const ctx2d = createMockContext2D();
  const winListeners = new Map();
  const docListeners = new Map();

  function createClassList() {
    const set = new Set();
    return {
      add() {
        for (let i = 0; i < arguments.length; i++) set.add(String(arguments[i]));
      },
      remove() {
        for (let i = 0; i < arguments.length; i++) set.delete(String(arguments[i]));
      },
      toggle(name, force) {
        if (force === undefined) {
          if (set.has(name)) {
            set.delete(name);
            return false;
          }
          set.add(name);
          return true;
        }
        if (force) set.add(name);
        else set.delete(name);
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
    const classList = createClassList();
    const capturedPointers = new Set();

    const el = {
      tagName: String(tagName).toUpperCase(),
      namespaceURI: namespaceURI || 'http://www.w3.org/1999/xhtml',
      children: [],
      parentNode: null,
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
        const existing = classList.toArray();
        for (const c of existing) classList.remove(c);
        String(val || '')
          .split(/\s+/)
          .filter(Boolean)
          .forEach((c) => classList.add(c));
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
        attrs.set(k, str);
        if (k === 'class') {
          el.className = str;
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
    readyState: 'complete',
    hidden: false,
    visibilityState: 'visible',
    documentElement: null,
    body: null,
    defaultView: null,
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

  const section = doc.createElement('section');
  section.setAttribute('id', 'cell-draw');
  section.className = 'cell cell--draw';
  section.setAttribute('aria-label', 'Freehand Drawing Sketchpad');
  doc.body.appendChild(section);
  doc._byId.set('cell-draw', section);

  const win = {
    document: doc,
    devicePixelRatio: 2,
    performance: { now: () => 1000 },
    winListeners: winListeners,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    matchMedia(query) {
      if (String(query).includes('prefers-reduced-motion')) {
        return { matches: reducedMotion };
      }
      return {
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
      observe() {}
      disconnect() {
        mutationCallback = null;
      }
    }
  };

  doc.defaultView = win;

  return {
    win,
    doc,
    section,
    ctx2d,
    getContextArgs,
    setRect(nextRect) {
      currentRect = Object.assign({}, currentRect, nextRect);
      if (resizeCallback) resizeCallback();
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
  assert.ok(cssSrc.includes('#6e6e6a'));
  assert.ok(cssSrc.includes('var(--dw-focus)'));
  assert.ok(cssSrc.includes('@media (pointer: coarse)'));
  assert.ok(cssSrc.includes('@media (forced-colors: active)'));
  assert.ok(cssSrc.includes('prefers-reduced-motion: reduce'));
});
