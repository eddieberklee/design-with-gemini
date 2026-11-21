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
