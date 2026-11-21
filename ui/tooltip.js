/*
 * ui/tooltip.js — one tooltip for the whole page (classic script, no modules).
 *
 * Any element with data-tip="…" (or a native title attribute) shows a styled
 * tooltip on hover (after HOVER_DELAY_MS, instantly when moving between tipped
 * elements) and on keyboard focus (immediately). Optional data-tip-key="R"
 * adds a keycap. Contract and copy rules: ui/NOTES.md.
 *
 * Cost model: three always-on listeners (pointerover, pointerdown, focusin) on
 * document that return after one closest() call when nothing is tipped. Every
 * other listener (pointerout, focusout, keydown, scroll, resize, close,
 * visibilitychange, pointerup/cancel/move for long-press) and one
 * MutationObserver are attached only while a tip is pending or shown.
 *
 * Exposes exactly one global: window.UITooltip.
 */
(function (global) {
  'use strict';

  var HOVER_DELAY_MS = 350;
  var SKIP_DELAY_MS = 400;     // a tip hidden less than this ago -> next one shows instantly
  var LONG_PRESS_MS = 500;
  var LONG_PRESS_SLOP_PX = 8;
  var TOUCH_LINGER_MS = 1800;  // a long-press tip stays this long after the finger lifts
  var OFFSET_PX = 8;           // gap between target and bubble
  var MARGIN_PX = 8;           // minimum gap between bubble and viewport edge
  var TIP_SELECTOR = '[data-tip],[title]';
  var SKIP_TAGS = { HTML: 1, BODY: 1, IFRAME: 1, FRAME: 1, LINK: 1, STYLE: 1, META: 1, SCRIPT: 1, TITLE: 1 };

  // ---------------------------------------------------------------------------
  // Pure helpers (exported for node:test)
  // ---------------------------------------------------------------------------

  function clamp(v, lo, hi) {
    if (hi < lo) return lo;
    return v < lo ? lo : v > hi ? hi : v;
  }

  /**
   * Place a bubble of size `tip` ({width,height}) next to `target` (a DOMRect-like
   * {left,top,right,bottom,width,height}) inside `viewport` ({width,height}).
   * Above by default; below when above does not fit; when neither fits, the side
   * with more room. Horizontally centred on the target and clamped to the
   * viewport. The vertical position is never clamped onto the target.
   * Returns {left, top, placement: 'top'|'bottom'}.
   */
  function computePlacement(target, tip, viewport, opts) {
    var offset = opts && Number.isFinite(opts.offset) ? opts.offset : OFFSET_PX;
    var margin = opts && Number.isFinite(opts.margin) ? opts.margin : MARGIN_PX;
    var prefer = opts && opts.prefer === 'bottom' ? 'bottom' : 'top';

    var roomAbove = target.top - offset - margin;
    var roomBelow = viewport.height - target.bottom - offset - margin;
    var fitsAbove = tip.height <= roomAbove;
    var fitsBelow = tip.height <= roomBelow;

    var placement;
    if (prefer === 'top') placement = fitsAbove ? 'top' : fitsBelow ? 'bottom' : roomAbove >= roomBelow ? 'top' : 'bottom';
    else placement = fitsBelow ? 'bottom' : fitsAbove ? 'top' : roomBelow >= roomAbove ? 'bottom' : 'top';

    var top;
    if (placement === 'top') {
      top = target.top - offset - tip.height;
      // Only push down to the margin if that still clears the target.
      if (top < margin) top = Math.min(margin, target.top - offset - tip.height);
    } else {
      top = target.bottom + offset;
      var maxTop = viewport.height - margin - tip.height;
      if (top > maxTop) top = Math.max(maxTop, target.bottom + offset);
    }

    var left = target.left + target.width / 2 - tip.width / 2;
    left = clamp(left, margin, viewport.width - margin - tip.width);

    return { left: Math.round(left), top: Math.round(top), placement: placement };
  }

  /**
   * Title adoption rule, decided once per show.
   *   input:  { title: string|null, dataTip: string|null, fromTitle: boolean, hasName: boolean }
   *     title     - current value of the title attribute (null when absent)
   *     dataTip   - current data-tip (null when absent)
   *     fromTitle - data-tip was itself copied from a title earlier (data-tip-from-title)
   *     hasName   - the element already has an accessible name without its title
   *   output: { tip, setDataTip, fromTitle, removeTitle, ariaLabel }
   *     tip        - text to show ('' = show nothing)
   *     setDataTip - new data-tip value, or null to leave it alone
   *     fromTitle  - value for data-tip-from-title after this show
   *     removeTitle- remove the title attribute so the native tooltip never doubles up
   *     ariaLabel  - aria-label to add (title was the only accessible name), or null
   * An authored data-tip always wins over a title; a title written later replaces
   * a tip that was adopted from an earlier title (cells rewrite title in place).
   */
  function adoptTitle(s) {
    var title = typeof s.title === 'string' ? s.title.trim() : '';
    var hasTitle = typeof s.title === 'string';
    var dataTip = typeof s.dataTip === 'string' ? s.dataTip.trim() : null;
    var authored = dataTip !== null && dataTip !== '' && !s.fromTitle;

    var out = { tip: '', setDataTip: null, fromTitle: Boolean(s.fromTitle), removeTitle: hasTitle, ariaLabel: null };
    if (authored) {
      out.tip = dataTip;
      out.fromTitle = false;
    } else if (title) {
      out.tip = title;
      out.setDataTip = title;
      out.fromTitle = true;
    } else {
      out.tip = dataTip || '';
    }
    if (hasTitle && title && !s.hasName) out.ariaLabel = title;
    return out;
  }

  /** Normalise a data-tip-key value to a short keycap label ('' when absent). */
  function keyLabel(raw) {
    if (typeof raw !== 'string') return '';
    if (raw === ' ') return 'Space';
    var k = raw.trim();
    if (!k) return '';
    var named = { ' ': 'Space', space: 'Space', escape: 'Esc', esc: 'Esc', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', enter: '↵' };
    var lower = k.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(named, lower)) return named[lower];
    return k.length === 1 ? k.toUpperCase() : k;
  }

  var api = {
    HOVER_DELAY_MS: HOVER_DELAY_MS,
    computePlacement: computePlacement,
    adoptTitle: adoptTitle,
    keyLabel: keyLabel,
    clamp: clamp,
    init: init,
    hide: function () { hide(true); },
    destroy: destroy
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!global || !global.document) return;
  if (global.UITooltip && global.UITooltip.__live) return; // loaded twice: keep the first
  global.UITooltip = api;

  // ---------------------------------------------------------------------------
  // DOM runtime
  // ---------------------------------------------------------------------------

  var doc = global.document;
  var bubble = null;
  var textEl = null;
  var keyEl = null;
  var usePopover = false;
  var current = null;        // element whose tip is shown
  var pending = null;        // element whose tip is scheduled
  var timer = 0;
  var lingerTimer = 0;
  var lastHideAt = -Infinity;
  var suppressed = null;     // Escape/pointerdown: no re-show until the pointer leaves it
  var armed = false;         // transient listeners attached
  var observer = null;
  var lp = null;             // long-press state {el, x, y, timer, id}
  var started = false;

  function now() {
    return global.performance && typeof global.performance.now === 'function' ? global.performance.now() : Date.now();
  }

  function findTarget(node) {
    if (!node || node.nodeType !== 1 || typeof node.closest !== 'function') return null;
    if (bubble && bubble.contains(node)) return null;
    var el = node.closest(TIP_SELECTOR);
    while (el) {
      if (!SKIP_TAGS[el.tagName] && !el.closest('[data-tip-off]') && hasTipText(el)) return el;
      el = el.parentElement ? el.parentElement.closest(TIP_SELECTOR) : null;
    }
    return null;
  }

  function hasTipText(el) {
    var t = el.getAttribute('data-tip');
    if (t && t.trim()) return true;
    t = el.getAttribute('title');
    return Boolean(t && t.trim());
  }

  // Only interactive elements need a name; aria-label on a plain div/span is not allowed.
  function isInteractive(el) {
    if (/^(BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName)) return true;
    var role = el.getAttribute('role');
    if (role && /^(button|link|slider|checkbox|radio|switch|tab|menuitem|option|application|spinbutton)$/.test(role)) return true;
    return el.hasAttribute('tabindex');
  }

  function hasAccessibleName(el) {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true;
    if (el.tagName === 'IMG' && el.getAttribute('alt')) return true;
    var txt = el.textContent;
    if (txt && txt.replace(/[\s↗↘⤢⤡→←↑↓↻×✕]+/g, '').length) return true;
    var img = el.querySelector && el.querySelector('img[alt]:not([alt=""])');
    return Boolean(img);
  }

  function ensureBubble() {
    if (bubble) return bubble;
    bubble = doc.createElement('div');
    bubble.id = 'ui-tip';
    bubble.className = 'ui-tip';
    bubble.setAttribute('role', 'tooltip');
    textEl = doc.createElement('span');
    textEl.className = 'ui-tip-text';
    keyEl = doc.createElement('kbd');
    keyEl.className = 'ui-tip-key';
    bubble.appendChild(textEl);
    bubble.appendChild(keyEl);
    usePopover = typeof bubble.showPopover === 'function' && typeof bubble.hidePopover === 'function';
    if (usePopover) bubble.setAttribute('popover', 'manual');
    return bubble;
  }

  function resolveText(el) {
    var res = adoptTitle({
      title: el.getAttribute('title'),
      dataTip: el.getAttribute('data-tip'),
      fromTitle: el.hasAttribute('data-tip-from-title'),
      hasName: !isInteractive(el) || hasAccessibleName(el)
    });
    // Write only real changes: the MutationObserver below watches these attributes.
    if (res.setDataTip !== null && el.getAttribute('data-tip') !== res.setDataTip) el.setAttribute('data-tip', res.setDataTip);
    if (res.fromTitle !== el.hasAttribute('data-tip-from-title')) {
      if (res.fromTitle) el.setAttribute('data-tip-from-title', '');
      else el.removeAttribute('data-tip-from-title');
    }
    if (res.ariaLabel && el.getAttribute('aria-label') !== res.ariaLabel) el.setAttribute('aria-label', res.ariaLabel);
    if (res.removeTitle && el.hasAttribute('title')) el.removeAttribute('title');
    return res.tip;
  }

  function isOpen() {
    return Boolean(current);
  }

  function addDescribedBy(el) {
    var ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (ids.indexOf('ui-tip') < 0) {
      ids.push('ui-tip');
      el.setAttribute('aria-describedby', ids.join(' '));
    }
  }

  function removeDescribedBy(el) {
    if (!el) return;
    var ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(function (id) {
      return id && id !== 'ui-tip';
    });
    if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
    else el.removeAttribute('aria-describedby');
  }

  function mountBubble(el) {
    ensureBubble();
    // Inside an open modal <dialog> the rest of the document is inert, so the
    // bubble goes into that dialog (still the top layer when shown as a popover).
    var host = el.closest('dialog[open]') || doc.body;
    if (bubble.parentNode !== host) host.appendChild(bubble);
    if (usePopover) {
      try {
        if (bubble.matches(':popover-open')) bubble.hidePopover();
        bubble.showPopover(); // re-show so it lands above any newer top-layer element
        return;
      } catch (_e) {
        usePopover = false;
        bubble.removeAttribute('popover');
      }
    }
    bubble.classList.add('is-open');
  }

  function position(el) {
    var r = el.getBoundingClientRect();
    bubble.style.left = '0px';
    bubble.style.top = '0px';
    var b = bubble.getBoundingClientRect();
    var vw = doc.documentElement.clientWidth || global.innerWidth;
    var vh = doc.documentElement.clientHeight || global.innerHeight;
    var p = computePlacement(r, { width: b.width, height: b.height }, { width: vw, height: vh });
    bubble.style.left = p.left + 'px';
    bubble.style.top = p.top + 'px';
    bubble.setAttribute('data-placement', p.placement);
  }

  function show(el) {
    clearTimeout(timer);
    pending = null;
    if (!el || !el.isConnected || !el.getClientRects().length) return;
    var text = resolveText(el);
    if (!text) return;
    var switching = Boolean(current);
    if (current && current !== el) removeDescribedBy(current);
    current = el;
    ensureBubble();
    // Moving between adjacent tips swaps the text in place: no second fade-in.
    if (switching) bubble.setAttribute('data-switch', '');
    else bubble.removeAttribute('data-switch');
    textEl.textContent = text;
    var key = keyLabel(el.getAttribute('data-tip-key'));
    keyEl.textContent = key;
    keyEl.hidden = !key;
    mountBubble(el);
    position(el);
    addDescribedBy(el);
    arm();
    watch(el);
  }

  function hide(recordTime) {
    clearTimeout(timer);
    clearTimeout(lingerTimer);
    pending = null;
    if (current) {
      removeDescribedBy(current);
      current = null;
      if (recordTime !== false) lastHideAt = now();
    }
    if (bubble) {
      if (usePopover) {
        try {
          if (bubble.matches(':popover-open')) bubble.hidePopover();
        } catch (_e) { /* already closed */ }
      }
      bubble.classList.remove('is-open');
    }
    if (observer) observer.disconnect();
    disarm();
  }

  function schedule(el, instant) {
    clearTimeout(timer);
    pending = el;
    arm();
    if (instant) {
      show(el);
      return;
    }
    timer = setTimeout(function () {
      if (pending === el) show(el);
    }, HOVER_DELAY_MS);
  }

  function watch(el) {
    if (typeof global.MutationObserver !== 'function') return;
    if (!observer) {
      observer = new global.MutationObserver(function (records) {
        if (!current) return;
        if (!current.isConnected || !current.getClientRects().length) {
          hide(true);
          return;
        }
        var attrChanged = false;
        for (var i = 0; i < records.length; i++) {
          if (records[i].type === 'attributes' && records[i].target === current) attrChanged = true;
        }
        if (!attrChanged) return;
        var text = resolveText(current);
        if (!text) {
          hide(true);
          return;
        }
        if (textEl.textContent !== text) {
          textEl.textContent = text;
          position(current);
        }
      });
    }
    observer.disconnect();
    observer.observe(el, { attributes: true, attributeFilter: ['data-tip', 'title', 'hidden', 'disabled'] });
    // Re-rendering cells replace whole subtrees; catch the target being detached.
    var root = el.closest('dialog[open], .cell') || doc.body;
    observer.observe(root, { childList: true, subtree: true });
  }

  // --- always-on listeners -----------------------------------------------------

  function onPointerOver(e) {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') return;
    // Leaving the element that was dismissed (Escape / click) re-enables it.
    if (suppressed && !suppressed.contains(e.target)) suppressed = null;
    var el = findTarget(e.target);
    if (!el) {
      if (current || pending) hide(true);
      return;
    }
    if (el === suppressed) return;
    if (el === current || el === pending) return;
    var instant = isOpen() || now() - lastHideAt < SKIP_DELAY_MS;
    if (current) removeDescribedBy(current);
    schedule(el, instant);
  }

  function onPointerDown(e) {
    if (current || pending) {
      suppressed = current || pending;
      hide(true);
    }
    if (e.pointerType === 'touch' || e.pointerType === 'pen') startLongPress(e);
  }

  function onFocusIn(e) {
    var el = findTarget(e.target);
    if (!el) return;
    var keyboard = true;
    try {
      keyboard = e.target.matches(':focus-visible');
    } catch (_e) { /* older engines: treat as keyboard */ }
    if (!keyboard) return;
    suppressed = null;
    schedule(el, true);
  }

  // --- transient listeners (only while pending/shown) ---------------------------

  function onPointerOut(e) {
    var el = current || pending;
    if (!el) return;
    if (suppressed && e.target && suppressed.contains(e.target) && !suppressed.contains(e.relatedTarget)) suppressed = null;
    if (el.contains(e.target) && !el.contains(e.relatedTarget)) {
      if (doc.activeElement === el && el.matches(':focus-visible')) return; // keep the keyboard tip
      hide(true);
    }
  }

  function onFocusOut(e) {
    if (current && (e.target === current || current.contains(e.target)) && !current.contains(e.relatedTarget)) {
      if (!current.matches(':hover')) hide(true);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' || e.key === 'Esc') {
      suppressed = current || pending;
      hide(true);
    }
  }

  function onDismiss() {
    hide(true);
  }

  function onVisibility() {
    if (doc.visibilityState === 'hidden') hide(false);
  }

  function arm() {
    if (armed) return;
    armed = true;
    doc.addEventListener('pointerout', onPointerOut, true);
    doc.addEventListener('focusout', onFocusOut, true);
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('scroll', onDismiss, { capture: true, passive: true });
    doc.addEventListener('close', onDismiss, true);
    doc.addEventListener('visibilitychange', onVisibility);
    global.addEventListener('resize', onDismiss, { passive: true });
    global.addEventListener('blur', onDismiss);
  }

  function disarm() {
    if (!armed || lp) return;
    armed = false;
    doc.removeEventListener('pointerout', onPointerOut, true);
    doc.removeEventListener('focusout', onFocusOut, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('scroll', onDismiss, { capture: true, passive: true });
    doc.removeEventListener('close', onDismiss, true);
    doc.removeEventListener('visibilitychange', onVisibility);
    global.removeEventListener('resize', onDismiss, { passive: true });
    global.removeEventListener('blur', onDismiss);
  }

  // --- touch long-press -------------------------------------------------------------
  // Never calls preventDefault: the tap, scroll and native long-press all proceed.

  function startLongPress(e) {
    cancelLongPress();
    var el = findTarget(e.target);
    if (!el) return;
    lp = { el: el, x: e.clientX, y: e.clientY, id: e.pointerId, timer: 0 };
    lp.timer = setTimeout(function () {
      if (!lp) return;
      var target = lp.el;
      show(target);
      clearTimeout(lingerTimer);
      lingerTimer = setTimeout(function () {
        if (current === target) hide(true);
      }, TOUCH_LINGER_MS + LONG_PRESS_MS);
    }, LONG_PRESS_MS);
    doc.addEventListener('pointermove', onLongPressMove, { capture: true, passive: true });
    doc.addEventListener('pointerup', onLongPressEnd, true);
    doc.addEventListener('pointercancel', onLongPressEnd, true);
  }

  function onLongPressMove(e) {
    if (!lp || e.pointerId !== lp.id) return;
    if (Math.abs(e.clientX - lp.x) > LONG_PRESS_SLOP_PX || Math.abs(e.clientY - lp.y) > LONG_PRESS_SLOP_PX) cancelLongPress();
  }

  function onLongPressEnd(e) {
    if (!lp || e.pointerId !== lp.id) return;
    cancelLongPress();
  }

  function cancelLongPress() {
    if (!lp) return;
    clearTimeout(lp.timer);
    lp = null;
    doc.removeEventListener('pointermove', onLongPressMove, { capture: true, passive: true });
    doc.removeEventListener('pointerup', onLongPressEnd, true);
    doc.removeEventListener('pointercancel', onLongPressEnd, true);
    if (!current && !pending) disarm();
  }

  // --- lifecycle ----------------------------------------------------------------------

  function init() {
    if (started) return;
    started = true;
    doc.addEventListener('pointerover', onPointerOver, { capture: true, passive: true });
    doc.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    doc.addEventListener('focusin', onFocusIn, true);
  }

  function destroy() {
    hide(false);
    cancelLongPress();
    if (!started) return;
    started = false;
    doc.removeEventListener('pointerover', onPointerOver, { capture: true, passive: true });
    doc.removeEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    doc.removeEventListener('focusin', onFocusIn, true);
    if (bubble && bubble.parentNode) bubble.parentNode.removeChild(bubble);
    bubble = null;
  }

  api.__live = true;
  api._state = function () {
    return { current: current, pending: pending, armed: armed, bubble: bubble, usePopover: usePopover };
  };
  init();
})(typeof window !== 'undefined' ? window : globalThis);
