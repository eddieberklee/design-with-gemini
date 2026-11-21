'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Tip = require('./tooltip.js');

const VIEW = { width: 1000, height: 800 };
const TIP = { width: 200, height: 40 };

function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function overlaps(a, tipBox) {
  return !(tipBox.left + tipBox.width <= a.left || tipBox.left >= a.right ||
    tipBox.top + tipBox.height <= a.top || tipBox.top >= a.bottom);
}

test('placement: above and centred by default, with the offset', () => {
  const t = rect(400, 300, 100, 28);
  const p = Tip.computePlacement(t, TIP, VIEW);
  assert.equal(p.placement, 'top');
  assert.equal(p.top, 300 - 8 - 40);
  assert.equal(p.left, 450 - 100);
});

test('placement: flips below when there is no room above', () => {
  const t = rect(400, 20, 100, 28);
  const p = Tip.computePlacement(t, TIP, VIEW);
  assert.equal(p.placement, 'bottom');
  assert.equal(p.top, 48 + 8);
});

test('placement: prefer bottom stays below when it fits', () => {
  const p = Tip.computePlacement(rect(400, 300, 100, 28), TIP, VIEW, { prefer: 'bottom' });
  assert.equal(p.placement, 'bottom');
});

test('placement: clamps horizontally to the viewport margin', () => {
  const left = Tip.computePlacement(rect(0, 300, 20, 20), TIP, VIEW);
  assert.equal(left.left, 8);
  const right = Tip.computePlacement(rect(990, 300, 10, 20), TIP, VIEW);
  assert.equal(right.left, 1000 - 8 - 200);
});

test('placement: bubble wider than the viewport pins to the left margin', () => {
  const p = Tip.computePlacement(rect(100, 300, 20, 20), { width: 400, height: 40 }, { width: 300, height: 800 });
  assert.equal(p.left, 8);
});

test('placement: neither side fits -> the side with more room, never over the target', () => {
  const tall = { width: 200, height: 500 };
  const nearTop = rect(400, 200, 100, 40);          // 192 above, 552 below
  const a = Tip.computePlacement(nearTop, tall, VIEW);
  assert.equal(a.placement, 'bottom');
  assert.equal(overlaps(nearTop, { left: a.left, top: a.top, width: tall.width, height: tall.height }), false);

  const nearBottom = rect(400, 560, 100, 40);       // 552 above, 192 below
  const b = Tip.computePlacement(nearBottom, { width: 200, height: 600 }, VIEW);
  assert.equal(b.placement, 'top');
  assert.equal(overlaps(nearBottom, { left: b.left, top: b.top, width: 200, height: 600 }), false);
});

test('placement: never covers the target across a sweep of positions and sizes', () => {
  for (let y = 0; y <= 780; y += 13) {
    for (let x = -30; x <= 1010; x += 97) {
      for (const h of [16, 28, 60]) {
        for (const tip of [{ width: 120, height: 24 }, { width: 260, height: 90 }]) {
          const t = rect(x, y, 40, h);
          const p = Tip.computePlacement(t, tip, VIEW);
          const box = { left: p.left, top: p.top, width: tip.width, height: tip.height };
          assert.equal(overlaps(t, box), false, `overlap at x=${x} y=${y} h=${h} tip=${tip.height}`);
          assert.ok(p.left >= 8 && p.left + tip.width <= 992, `x clamp at x=${x}`);
          const fitsSomewhere = tip.height <= t.top - 16 || tip.height <= VIEW.height - t.bottom - 16;
          if (fitsSomewhere) {
            assert.ok(p.top >= 8 && p.top + tip.height <= 792, `y inside viewport at y=${y}`);
          }
        }
      }
    }
  }
});

test('adoption: a plain title becomes the tip and the title is removed', () => {
  const r = Tip.adoptTitle({ title: 'Reset grid size', dataTip: null, fromTitle: false, hasName: true });
  assert.deepEqual(r, { tip: 'Reset grid size', setDataTip: 'Reset grid size', fromTitle: true, removeTitle: true, ariaLabel: null });
});

test('adoption: an authored data-tip wins and the title is still removed', () => {
  const r = Tip.adoptTitle({ title: 'old native text', dataTip: 'Authored tip.', fromTitle: false, hasName: true });
  assert.equal(r.tip, 'Authored tip.');
  assert.equal(r.setDataTip, null);
  assert.equal(r.fromTitle, false);
  assert.equal(r.removeTitle, true);
});

test('adoption: a title rewritten later replaces a tip adopted from an earlier title', () => {
  const r = Tip.adoptTitle({ title: 'Drag to move cutoff (62%)', dataTip: 'Drag to move cutoff (50%)', fromTitle: true, hasName: true });
  assert.equal(r.tip, 'Drag to move cutoff (62%)');
  assert.equal(r.setDataTip, 'Drag to move cutoff (62%)');
  assert.equal(r.fromTitle, true);
});

test('adoption: with no new title an adopted tip keeps showing', () => {
  const r = Tip.adoptTitle({ title: null, dataTip: 'Adopted earlier', fromTitle: true, hasName: true });
  assert.equal(r.tip, 'Adopted earlier');
  assert.equal(r.setDataTip, null);
  assert.equal(r.removeTitle, false);
});

test('adoption: title that was the only accessible name moves to aria-label', () => {
  const r = Tip.adoptTitle({ title: 'Expand workbench', dataTip: null, fromTitle: false, hasName: false });
  assert.equal(r.ariaLabel, 'Expand workbench');
  const named = Tip.adoptTitle({ title: 'Expand workbench', dataTip: null, fromTitle: false, hasName: true });
  assert.equal(named.ariaLabel, null);
});

test('adoption: empty or whitespace title shows nothing but is still removed', () => {
  const r = Tip.adoptTitle({ title: '   ', dataTip: null, fromTitle: false, hasName: true });
  assert.equal(r.tip, '');
  assert.equal(r.removeTitle, true);
  assert.equal(r.ariaLabel, null);
});

test('adoption: an empty authored data-tip falls back to the title', () => {
  const r = Tip.adoptTitle({ title: 'From title', dataTip: '', fromTitle: false, hasName: true });
  assert.equal(r.tip, 'From title');
  assert.equal(r.setDataTip, 'From title');
});

test('adoption: clearing title="" after earlier adoption clears data-tip and auto aria-label', () => {
  const r = Tip.adoptTitle({ title: '', dataTip: 'Adopted earlier', fromTitle: true, hasName: false });
  assert.deepEqual(r, { tip: '', setDataTip: '', fromTitle: false, removeTitle: true, ariaLabel: '' });
});

test('keycap labels', () => {
  assert.equal(Tip.keyLabel('r'), 'R');
  assert.equal(Tip.keyLabel('Escape'), 'Esc');
  assert.equal(Tip.keyLabel(' '), 'Space');
  assert.equal(Tip.keyLabel('ArrowUp'), '↑');
  assert.equal(Tip.keyLabel('Shift+T'), 'Shift+T');
  assert.equal(Tip.keyLabel(''), '');
  assert.equal(Tip.keyLabel(undefined), '');
});

test('loads as a classic script without a DOM and without leaking bindings', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tooltip.js'), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx, { filename: 'tooltip.js' });
  // No document: nothing is installed and nothing throws.
  assert.equal(Object.keys(ctx).length, 0);
});

test('installs exactly one global and three always-on listeners when a document exists', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tooltip.js'), 'utf8');
  const docListeners = [];
  const winListeners = [];
  const fakeDoc = {
    addEventListener(type) { docListeners.push(type); },
    removeEventListener() {}
  };
  const win = {
    document: fakeDoc,
    addEventListener(type) { winListeners.push(type); },
    removeEventListener() {}
  };
  win.window = win;
  const ctx = vm.createContext(win);
  vm.runInContext(src, ctx, { filename: 'tooltip.js' });
  const added = Object.keys(win).filter((k) => !['document', 'addEventListener', 'removeEventListener', 'window'].includes(k));
  assert.deepEqual(added, ['UITooltip']);
  assert.deepEqual(docListeners.sort(), ['focusin', 'pointerdown', 'pointerover']);
  assert.deepEqual(winListeners, []);
  // A second load keeps the first instance.
  const first = win.UITooltip;
  vm.runInContext(src, ctx, { filename: 'tooltip.js' });
  assert.equal(win.UITooltip, first);
  assert.equal(docListeners.length, 3);
});

function createHarness() {
  const src = fs.readFileSync(path.join(__dirname, 'tooltip.js'), 'utf8');
  let clock = 1000;
  let nextTimerId = 1;
  const timers = new Map();
  const observers = new Set();

  function makeEventTarget() {
    const map = new Map();
    return {
      _listeners: map,
      addEventListener(type, fn, opts) {
        if (!map.has(type)) map.set(type, []);
        const list = map.get(type);
        const once = Boolean(opts && typeof opts === 'object' && opts.once);
        if (!list.some((e) => e.fn === fn)) list.push({ fn, once });
      },
      removeEventListener(type, fn) {
        const list = map.get(type);
        if (!list) return;
        const idx = list.findIndex((e) => e.fn === fn);
        if (idx >= 0) list.splice(idx, 1);
      },
      dispatch(type, init) {
        const ev = Object.assign({
          type,
          defaultPrevented: false,
          propagationStopped: false,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() { this.propagationStopped = true; }
        }, init || {});
        const list = (map.get(type) || []).slice();
        for (const entry of list) {
          if (entry.once) this.removeEventListener(type, entry.fn);
          entry.fn(ev);
        }
        return ev;
      },
      listenerCount() {
        let n = 0;
        for (const list of map.values()) n += list.length;
        return n;
      }
    };
  }

  function notifyMutation(record) {
    for (const obs of observers) {
      for (const reg of obs.targets) {
        if (record.type === 'attributes' && reg.el === record.target && reg.opts.attributes) {
          if (!reg.opts.attributeFilter || reg.opts.attributeFilter.includes(record.attributeName)) {
            obs.cb([record]);
            break;
          }
        } else if (record.type === 'childList' && reg.opts.childList) {
          if (reg.el === record.target || (reg.opts.subtree && reg.el.contains(record.target))) {
            obs.cb([record]);
            break;
          }
        }
      }
    }
  }

  function createElement(tagName) {
    const attrs = new Map();
    const classes = new Set();
    const et = makeEventTarget();
    const el = Object.assign(et, {
      nodeType: 1,
      tagName,
      parentNode: null,
      parentElement: null,
      children: [],
      textContent: '',
      style: {},
      hidden: false,
      disabled: false,
      focusVisible: true,
      hovered: false,
      rects: [rect(200, 200, 80, 28)],
      classList: {
        add(c) { classes.add(c); },
        remove(c) { classes.delete(c); },
        contains(c) { return classes.has(c); }
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        notifyMutation({ type: 'attributes', target: this, attributeName: k });
      },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      hasAttribute(k) { return attrs.has(k); },
      removeAttribute(k) {
        if (!attrs.has(k)) return;
        attrs.delete(k);
        notifyMutation({ type: 'attributes', target: this, attributeName: k });
      },
      appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        child.parentElement = this;
        this.children.push(child);
        notifyMutation({ type: 'childList', target: this });
        return child;
      },
      removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) this.children.splice(i, 1);
        child.parentNode = null;
        child.parentElement = null;
        notifyMutation({ type: 'childList', target: this });
        return child;
      },
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
      },
      contains(other) {
        let p = other;
        while (p) {
          if (p === this) return true;
          p = p.parentNode;
        }
        return false;
      },
      matches(sel) {
        if (sel === '[data-tip],[title]') return attrs.has('data-tip') || attrs.has('title');
        if (sel === '[data-tip-off]') return attrs.has('data-tip-off');
        if (sel === 'dialog') return String(this.tagName).toUpperCase() === 'DIALOG';
        if (sel === 'dialog[open]') return String(this.tagName).toUpperCase() === 'DIALOG' && (attrs.has('open') || this.open === true);
        if (sel === 'dialog[open], .cell') return (String(this.tagName).toUpperCase() === 'DIALOG' && (attrs.has('open') || this.open === true)) || classes.has('cell');
        if (sel === '.cell') return classes.has('cell');
        if (sel === ':focus-visible') {
          if (this.throwFocusVisible) throw new SyntaxError('unsupported :focus-visible');
          return Boolean(this.focusVisible);
        }
        if (sel === ':hover') return Boolean(this.hovered);
        if (sel === ':popover-open') return Boolean(this.popoverOpen);
        return false;
      },
      closest(sel) {
        let p = this;
        while (p && p.nodeType === 1) {
          if (p.matches(sel)) return p;
          p = p.parentElement;
        }
        return null;
      },
      getClientRects() { return this.rects; },
      getBoundingClientRect() { return this.rects[0] || rect(0, 0, 120, 28); }
    });
    Object.defineProperty(el, 'isConnected', {
      get() {
        let p = this;
        while (p) {
          if (p === doc.body) return true;
          p = p.parentNode;
        }
        return false;
      }
    });
    return el;
  }

  class FakeMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.targets = [];
    }
    observe(el, opts) {
      this.targets.push({ el, opts });
      observers.add(this);
    }
    disconnect() {
      this.targets = [];
      observers.delete(this);
    }
  }

  const doc = Object.assign(makeEventTarget(), {
    nodeType: 9,
    visibilityState: 'visible',
    activeElement: null,
    documentElement: { clientWidth: 1000, clientHeight: 800 },
    body: null,
    createElement
  });
  doc.body = createElement('BODY');

  const win = Object.assign(makeEventTarget(), {
    document: doc,
    innerWidth: 1000,
    innerHeight: 800,
    performance: { now: () => clock },
    MutationObserver: FakeMutationObserver,
    setTimeout(fn, ms) {
      const id = nextTimerId++;
      timers.set(id, { fn, due: clock + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  win.window = win;

  vm.runInContext(src, vm.createContext(win), { filename: 'tooltip.js' });

  function advance(ms) {
    const end = clock + ms;
    while (true) {
      let nextId = 0;
      let nextEntry = null;
      for (const [id, entry] of timers) {
        if (entry.due <= end && (!nextEntry || entry.due < nextEntry.due)) {
          nextId = id;
          nextEntry = entry;
        }
      }
      if (!nextEntry) break;
      timers.delete(nextId);
      clock = nextEntry.due;
      nextEntry.fn();
    }
    clock = end;
  }

  return { win, doc, createElement, advance, timers };
}

test('runtime: dynamic title update/clear, screen-reader dedup, keycap update, and SVG <a>', () => {
  const { win, doc, createElement } = createHarness();
  const btn = createElement('BUTTON');
  btn.textContent = '×';
  btn.setAttribute('title', 'Mute');
  doc.body.appendChild(btn);

  doc.dispatch('focusin', { target: btn });
  assert.equal(win.UITooltip._state().current, btn);
  assert.equal(btn.getAttribute('aria-label'), 'Mute');
  assert.equal(btn.hasAttribute('data-tip-aria-from-title'), true);
  assert.equal(btn.getAttribute('aria-describedby'), null); // deduped when text === aria-label and no key

  // Dynamic title rewrite + keycap addition updates aria-label, bubble, keyEl, and aria-describedby.
  btn.setAttribute('title', 'Unmute');
  btn.setAttribute('data-tip-key', 'm');
  const bubble = win.UITooltip._state().bubble;
  assert.equal(bubble.children[0].textContent, 'Unmute');
  assert.equal(bubble.children[1].textContent, 'M');
  assert.equal(bubble.children[1].hidden, false);
  assert.equal(btn.getAttribute('aria-label'), 'Unmute');
  assert.equal(btn.getAttribute('aria-describedby'), 'ui-tip');

  // Clearing title="" hides the tip and strips data-tip + auto-adopted aria-label.
  btn.setAttribute('title', '');
  assert.equal(win.UITooltip._state().current, null);
  assert.equal(btn.getAttribute('data-tip'), null);
  assert.equal(btn.getAttribute('aria-label'), null);
  assert.equal(btn.hasAttribute('data-tip-aria-from-title'), false);

  // SVG lowercase <a> adopts title into aria-label.
  const svgLink = createElement('a');
  svgLink.setAttribute('title', 'Open schematic');
  doc.body.appendChild(svgLink);
  doc.dispatch('focusin', { target: svgLink });
  assert.equal(svgLink.getAttribute('aria-label'), 'Open schematic');
});

test('runtime: Escape stops propagation only when open, pointerleave clears suppressed, and transient showPopover recovers', () => {
  const { win, doc, createElement, advance } = createHarness();
  const btn = createElement('BUTTON');
  btn.textContent = 'Run';
  btn.setAttribute('data-tip', 'Runs the calibration pass.');
  doc.body.appendChild(btn);

  // Escape during pending hover delay cancels pending without swallowing Escape.
  doc.dispatch('pointerover', { target: btn, pointerType: 'mouse' });
  assert.equal(win.UITooltip._state().pending, btn);
  const pendingEsc = doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(pendingEsc.defaultPrevented, false);
  assert.equal(pendingEsc.propagationStopped, false);
  assert.equal(win.UITooltip._state().suppressed, btn);

  // Exiting btn via pointerleave while disarmed clears suppressed so re-hover works.
  btn.dispatch('pointerleave', { target: btn });
  assert.equal(win.UITooltip._state().suppressed, null);

  advance(500);
  doc.dispatch('pointerover', { target: btn, pointerType: 'mouse' });
  advance(350);
  assert.equal(win.UITooltip._state().current, btn);

  // Escape while open calls preventDefault + stopPropagation.
  const openEsc = doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(openEsc.defaultPrevented, true);
  assert.equal(openEsc.propagationStopped, true);
  assert.equal(win.UITooltip._state().current, null);

  // Unsupported :focus-visible on pointerout does not throw and hides cleanly.
  btn.dispatch('pointerleave', { target: btn });
  btn.throwFocusVisible = true;
  doc.activeElement = btn;
  advance(500);
  doc.dispatch('pointerover', { target: btn, pointerType: 'mouse' });
  advance(350);
  assert.doesNotThrow(() => doc.dispatch('pointerout', { target: btn, relatedTarget: null, pointerType: 'mouse' }));
  assert.equal(win.UITooltip._state().current, null);

  // Transient showPopover throw falls back to .is-open without disabling usePopover permanently.
  win.UITooltip.destroy();
  assert.equal(win.UITooltip._state().suppressed, null);
  win.UITooltip.init();
  let failOnce = true;
  const origCreate = doc.createElement;
  doc.createElement = function (tag) {
    const el = origCreate(tag);
    if (tag === 'div') {
      el.showPopover = function () {
        if (failOnce) {
          failOnce = false;
          throw new Error('InvalidStateError');
        }
        this.popoverOpen = true;
      };
      el.hidePopover = function () { this.popoverOpen = false; };
    }
    return el;
  };
  doc.dispatch('focusin', { target: btn });
  assert.equal(win.UITooltip._state().usePopover, true);
  assert.equal(win.UITooltip._state().bubble.classList.contains('is-open'), true);
  win.UITooltip.hide();
  doc.dispatch('focusin', { target: btn });
  assert.equal(win.UITooltip._state().bubble.popoverOpen, true);
  assert.equal(win.UITooltip._state().bubble.classList.contains('is-open'), false);
});

test('runtime: touch long-press stays open while held and lingers after pointerup without closing on touch pointerout', () => {
  const { win, doc, createElement, advance } = createHarness();
  const btn = createElement('BUTTON');
  btn.textContent = 'Hold';
  btn.setAttribute('data-tip', 'Press and hold to inspect.');
  doc.body.appendChild(btn);

  doc.dispatch('pointerdown', { target: btn, pointerType: 'touch', pointerId: 3, clientX: 10, clientY: 10 });
  advance(499);
  assert.equal(win.UITooltip._state().current, null);
  advance(1);
  assert.equal(win.UITooltip._state().current, btn);

  // Still holding finger down well past 2300ms: tip stays visible.
  advance(2500);
  assert.equal(win.UITooltip._state().current, btn);

  // Finger lifts: browser fires pointerup then touch pointerout; tip lingers for 1800ms.
  doc.dispatch('pointerup', { target: btn, pointerType: 'touch', pointerId: 3 });
  doc.dispatch('pointerout', { target: btn, relatedTarget: null, pointerType: 'touch' });
  assert.equal(win.UITooltip._state().current, btn);
  advance(1799);
  assert.equal(win.UITooltip._state().current, btn);
  advance(1);
  assert.equal(win.UITooltip._state().current, null);
  assert.equal(win.UITooltip._state().armed, false);
});

test('runtime: detaching target during hover delay disarms transient listeners and 0-rect switch cleans up', () => {
  const { win, doc, createElement, advance } = createHarness();
  const btn = createElement('BUTTON');
  btn.textContent = 'Arm';
  btn.setAttribute('data-tip', 'Arms the acoustic array.');
  doc.body.appendChild(btn);

  doc.dispatch('pointerover', { target: btn, pointerType: 'mouse' });
  assert.equal(win.UITooltip._state().armed, true);
  advance(100);
  btn.remove();
  advance(250);
  assert.equal(win.UITooltip._state().current, null);
  assert.equal(win.UITooltip._state().pending, null);
  assert.equal(win.UITooltip._state().armed, false);
  assert.equal(doc.listenerCount(), 3);
  assert.equal(win.listenerCount(), 0);

  // Switching from open btnA to zero-rect btnB closes cleanly without orphaned state.
  const btnA = createElement('BUTTON');
  btnA.textContent = 'Run';
  btnA.setAttribute('data-tip', 'Runs the probe.');
  const btnB = createElement('BUTTON');
  btnB.textContent = 'Hidden';
  btnB.setAttribute('data-tip', 'Zero rect.');
  btnB.rects = [];
  doc.body.appendChild(btnA);
  doc.body.appendChild(btnB);

  doc.dispatch('focusin', { target: btnA });
  assert.equal(btnA.getAttribute('aria-describedby'), 'ui-tip');
  doc.dispatch('pointerover', { target: btnB, pointerType: 'mouse' });
  assert.equal(win.UITooltip._state().current, null);
  assert.equal(btnA.getAttribute('aria-describedby'), null);
  assert.equal(win.UITooltip._state().armed, false);
});
