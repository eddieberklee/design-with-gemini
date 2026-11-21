# Shared UI system (`ui/`)

One visual language for every tile: a quiet bench of lab instruments. Near-white paper, hairline
borders, small-caps mono for labels and readouts, system sans for titles and prose, black for the
primary action, rust only for live or attention, green only for a real connection.

| File | What it is |
| :--- | :--- |
| `ui/base.css` | Tokens on `:root`, page rules (`body`, `.grid`, `.cell`), opt-in `ui-` classes, tooltip bubble. Loaded first in `index.html`. |
| `ui/tooltip.js` | One tooltip for the whole page. Classic script, global `window.UITooltip`. Loaded with `defer` before every cell script. |
| `ui/tooltip.test.js` | `node:test` for placement maths, title adoption, keycaps, classic-script loading. |

`base.css` never targets a cell class. Loading it changes no cell until the cell uses a `ui-` class
or a `--ui-` token. Measured: 19 computed properties (display, position, box-sizing, margin,
padding, background, border, radius, aspect-ratio, grid columns, gap, widths, font, colour,
line-height, min-height, overflow, rect) of `body`, every `.grid`, every `.cell` and every
body-level overlay, before and after the move, at 1600, 900 and 390 px, on the grid, with the
left-grille page, the hand-gesture page and the grille-swipe workbench open, and with Motion
driving the grid. Differences: the two intended colours (`--ui-paper`, `--ui-hairline`), and
`.ag-grid-placeholder` (grille-swipe, while expanded), whose own dashed `#f5f5f3` style now
applies because the inline `.cell` rule no longer comes after it. No page layout rule changed.

`body` also sets `font-family: var(--ui-sans)`, so text a cell leaves unstyled is no longer Times.
Measured with and without it on the grid and in all 7 secondary surfaces: 2,116 visible text
elements, 0 changed font (every visible text today has its own font-family).

## 0. Page-wide rules (decided by the coordinator, binding for every cell)

- **Numbering**: 01 Decisions (three tiles, steps 1–3), 02 Prosody, 03 Motion, 04 API Matrix,
  05 Left Grille, 06 Right Grille, 07 StickS3, 08 Hand Cursor, 09 Draw.
- **Green rule**: `data-tone="ok"` (green) only for a live connection or a call/probe that really
  passed. A saved API key is idle grey "Key set". Demo, ready, waiting: idle. Live, recording,
  armed, failing, needs setup: `attention` (rust).
- **One primary per tile**: at most one black `.ui-btn--primary`, and only for the tile's main
  action. Opening a studio is a quiet `.ui-btn--sm`. A secondary toggle that is running (mic
  recording, array armed) is a quiet button with `data-tone="attention"` (rust).
- **Close rule**: every secondary page or dialog has a `.ui-studio-bar`; its last item, top right,
  is `<button class="ui-btn" data-tip="Back to the grid." data-tip-key="Esc">Close</button>`, and
  Esc does the same. No "← Grid", "Done ✕" or "×".
- **Step labels**: the three Decisions step labels are all grey (`.ui-tile-step`), no rust lead.
- **Tips follow the code**: write a tip only after reading the handler; never from a label alone.

## 1. Tokens

| Token | Value | Use |
| :--- | :--- | :--- |
| `--ui-paper` | `#f5f5f3` | page background (was `#fafafa`) |
| `--ui-surface` | `#ffffff` | tile, dialog, control face |
| `--ui-well` | `#f7f7f5` | sunken stage inside a tile |
| `--ui-ink` / `-2` / `-3` | `#161615` / `#4f4f4b` / `#66665f` | text, strong to quiet. `-3` is the lightest text allowed (5.4:1 on well). |
| `--ui-hairline` | `#e5e5e2` | tile borders, dividers (was `#e5e5e5`) |
| `--ui-line` | `#d3d3ce` | control outlines |
| `--ui-accent` / `-tint` | `#b4441a` / `#fbeee8` | live, recording, needs attention |
| `--ui-positive` / `-tint` | `#087250` / `#e8f5ee` | really connected or passed. Never for "has a key" or "ready". |
| `--ui-focus`, `--ui-ring` | `#2f62d8`, `2px solid` | every `:focus-visible` |
| `--ui-sans`, `--ui-mono` | system stacks | no web fonts |
| `--ui-fs-1..5` | 10 / 11.5 / 13 / 16 / 24 px | mono labels / controls / titles + prose / studio titles / hero readouts |
| `--ui-1,2,3,4,6` | 4 / 8 / 12 / 16 / 24 px | spacing |
| `--ui-radius-sm`, `--ui-radius` | 5 / 8 px | controls + wells, tiles + dialogs. Pills use `999px`. |
| `--ui-head-h`, `--ui-foot-h` | 36 / 30 px | tile header and footer height |
| `--ui-ctl-h`, `--ui-ctl-h-sm` | 28 / 24 px | control height; `-sm` controls keep a 28 px hit area via `::after` |
| `--ui-grid-gap` | 4 px | `.grid` gap. `cells/motion/motion.css` `fixed3` maths assumes 4 px. |
| `--ui-dur`, `--ui-ease` | 150 ms, ease-out | every hover/press/open transition |
| `--ui-shadow-pop` | | tooltip, popovers, dialogs only. Tiles have no shadow. |

## 2. Tile anatomy

```html
<section class="cell cell--x ui-tile">            <!-- the existing .cell section -->
  <header class="ui-tile-head">
    <span class="ui-tile-index">03</span>          <!-- two digits, mono -->
    <span class="ui-tile-title">Motion Grid</span>
    <div class="ui-tile-actions">                  <!-- status pill first, then actions -->
      <button class="ui-pill" data-tone="attention" data-tip="No phone paired yet. Click to show the pairing QR code.">
        <span class="ui-pill-label">Setup</span></button>
      <button class="ui-btn ui-btn--sm ui-hide-tiny" data-tip="…">QR ↗</button>
    </div>
  </header>
  <div class="ui-tile-body">…one hero…</div>       <!-- .ui-tile-body--flush for full-bleed canvases -->
  <footer class="ui-tile-foot">…secondary readouts…</footer>   <!-- optional -->
</section>
```

- Decisions strip: replace the index with `<span class="ui-tile-step">1 · Input</span>`; the
  title stays. Numbering is fixed: 01 Decisions (steps 1–3), 02 Prosody, 03 Motion, 04 API Matrix,
  05 Left Grille, 06 Right Grille, 07 StickS3, 08 Hand Cursor, 09 Draw.
- Full-bleed tile (Draw): no header bar. Use `.ui-tile-head--overlay` inside the body: same
  index/title/actions markup, laid over the top-left with `pointer-events: none` (strokes can
  start under it), actions keep pointer events and sit on a surface background, same inset as a
  normal header action. Zero height cost.

  ```html
  <section class="cell cell--draw ui-tile">
    <div class="ui-tile-body ui-tile-body--flush">
      <canvas …></canvas>
      <header class="ui-tile-head ui-tile-head--overlay">
        <span class="ui-tile-index">09</span><span class="ui-tile-title">Draw</span>
        <div class="ui-tile-actions"><button class="ui-btn ui-btn--sm" aria-disabled="true" data-tip="Nothing to clear yet.">Clear</button></div>
      </header>
    </div>
  </section>
  ```
- A tile that is one big button (API Matrix, Left Grille portal) wraps head/body/foot in
  `<button class="ui-tile-trigger">`. Nothing interactive may sit inside it.
- `.ui-tile` makes the tile a size container named `ui-tile`. If your cell CSS sets
  `container`/`container-name` on the same element, it overrides this: write
  `container-name: <yours> ui-tile;` instead, or drop yours.
- Container steps (tile width): `< 320px` compact hides `.ui-tile-foot` and `.ui-hide-compact`;
  `< 240px` tiny (the 2-column phone grid, about 160–180 px, down to 140 px when Motion shrinks
  tiles) also hides `.ui-hide-tiny`, sets the header to 30 px and collapses `.ui-pill` to its dot.
  At tiny size a tile shows header + hero only.
- One hero per tile. Secondary readouts get smaller and quieter (`.ui-readout--quiet`,
  `.ui-label`), not another box. No borders inside borders: use `.ui-well` or spacing.

## 3. Controls

| Class | Markup | Notes |
| :--- | :--- | :--- |
| `.ui-btn` | `<button class="ui-btn">Reset</button>` | quiet, hairline, 28 px. `--sm` 24 px visible / 28 hit. `--icon` square. `--quiet` text-only. `aria-pressed="true"` / `aria-expanded="true"` show the on state. |
| `.ui-btn--primary` | `<button class="ui-btn ui-btn--primary">Confirm</button>` | black pill, one per tile at most (section 0). `aria-pressed="true"` turns it rust. |
| `.ui-btn[data-tone="attention"]` | `<button class="ui-btn ui-btn--sm" aria-pressed="true" data-tone="attention">● Recording</button>` | quiet button in its running state (mic on, array armed): rust text, border and tint. Remove the attribute when it stops. |
| `.ui-seg` | `<div class="ui-seg" role="group" aria-label="…"><button aria-pressed="true">All</button>…</div>` | selected = `aria-pressed`, `aria-selected` or `aria-checked` true. `.ui-seg--mono` for codes (OKLCH, RGB). |
| `.ui-pill` | `<span class="ui-pill" data-tone="ok"><span class="ui-pill-label">Stick S3</span></span>` | dot + label. `data-tone`: none/`idle` grey, `attention` rust, `ok` green (green rule, section 0). Button pills allowed. Always give it a `data-tip` that says what the state means and what a click does. |
| `.ui-chip` | `<button class="ui-chip">"a little smaller"</button>` | 24 px pill, 28 hit, ellipsis. |
| `.ui-slider` | `<input type="range" class="ui-slider" aria-label="…">` | 2 px track, ink thumb, focus ring on the thumb. |
| `.ui-readout` | `<span class="ui-readout">+0.0°</span>` | mono, tabular numerals. `--hero` 24 px, `--quiet` grey, `.ui-readout-unit` for units. |
| `.ui-label` | `<span class="ui-label">Tilt</span>` | 10 px mono caps, ink-3. |
| `.ui-kbd` | `<kbd class="ui-kbd">R</kbd>` | keycap. Prefer `data-tip-key` on the control. |
| `.ui-well` | `<div class="ui-well">` | sunken stage. |
| `.ui-truncate`, `.ui-sr-only` | | utilities. |
| `.ui-studio-bar` | `<header class="ui-studio-bar"><span class="ui-tile-index">05</span><h2 class="ui-studio-title">…</h2><div class="ui-studio-actions">… <button class="ui-btn" data-tip="Back to the grid." data-tip-key="Esc">Close</button></div></header>` | top bar of every secondary page and dialog. Close is always last on the right and always closes on Esc. |
| `.ui-dialog` | `<dialog class="ui-dialog">` | border, radius, shadow, backdrop. |

Disabled: prefer `aria-disabled="true"` plus a guard in the handler. A native `disabled` button
gets no focus, and its tooltip then only shows on hover; put the reason in its `data-tip` anyway.

## 4. Tooltips

Contract (`ui/tooltip.js`, one delegated system for every cell):

- `data-tip="Text."` shows a tooltip after 350 ms of hover, instantly when another tip closed in the
  last 400 ms, and immediately on keyboard focus (`:focus-visible` only, not mouse focus).
- `data-tip-key="R"` adds a keycap (`Escape` → Esc, `ArrowUp` → ↑, `" "` → Space).
- Hides on pointer leave, blur, Escape, any scroll, pointer down, resize, window blur, dialog close,
  and when the target is removed or hidden. After Escape or a click it stays hidden until the
  pointer leaves that element.
- Touch and pen: no hover tips. A 500 ms still long-press shows one for about 2 s. Nothing calls
  `preventDefault`, so taps, scrolls and the native long-press still work.
- One bubble `#ui-tip` (`role="tooltip"`), created on first use, shown with the Popover API
  (`popover="manual"`, top layer). Inside an open `<dialog>` it is moved into that dialog first, so
  it is not inert. Without the Popover API it is a fixed element in the dialog or `body`.
- Placement: above, centred; below when above does not fit; when neither fits, the side with more
  room. Clamped 8 px from the viewport edges. It never covers the target.
- `aria-describedby="ui-tip"` is added to the target while shown and removed after.
- `title` adoption: on every show, an element's `title` is copied to `data-tip`
  (marked `data-tip-from-title`) and removed, so the native tooltip never doubles up. A later
  `title` written by the cell replaces an adopted tip; an authored `data-tip` always wins. If the
  title was the only name of a button/link/input/role-widget, it becomes its `aria-label`.
  Adoption applies to every element with `title`, not only interactive ones, because several
  cells put `title` on spans and divs. Any element can opt out with `data-tip-off` on it or an
  ancestor.
- Cost: three always-on capture listeners on `document` (`pointerover`, `pointerdown`, `focusin`)
  that do one `closest()` and return. All other listeners and one MutationObserver exist only while a
  tip is pending or shown. No timers, rAF or polling when idle.
- API: `UITooltip.hide()`, `UITooltip.destroy()`, plus the pure `computePlacement`, `adoptTitle`,
  `keyLabel` (also `module.exports` for tests).

Copy rules:

- Say what the control does or what the reading means, in plain words. One sentence, about 14
  words or fewer, ending with a period.
- Explain jargon; do not repeat it. `MTI` → "Moving-target filter: hides still echoes so only your
  moving hand shows."
- A status pill says what the state means and what clicking does.
- A disabled control says why it is disabled and how to enable it.
- A numeric readout says what is measured and in what unit, when the screen does not.
- No tips on plainly labelled controls (`Clear`, `Reset`) unless there is a side effect.
- Read the handler before writing a tip. If you cannot tell what it does, leave it out and say so.

## 5. How a cell adopts this

1. Add `ui-tile` to the cell's `.cell` section (or its single root) and build the head/body/foot
   markup above. Keep every id, `data-` hook and public global.
2. Swap the cell's buttons, pills, segments and sliders to the `ui-` classes. Delete the cell CSS
   those make redundant. Keep only what is specific to the hero.
3. Replace colour, size, radius and font literals with `--ui-` tokens. Keep a cell token only if it
   is a hero-specific colour (e.g. a canvas palette).
4. Add `data-tip` to every control in section 4's coverage list. Rewrite existing `title` text
   into `data-tip` to the copy rules.
5. Check 1600, 900, 390 and 360 px, and a 140 px tile (Motion slider at minimum): nothing clips or
   overflows.

## 6. Hazards

- Cascade: `body`, `.grid`, `.cell` now load before the cells (they were inline after them). The
  computed-style diff was empty; a new single-class cell rule on `.cell` properties will now win.
- `.grid` is also used inside `#left-grille-page`, and `.cell` inside both secondary pages.
- Do not put a `display` value on a closed `.ui-tip`: author `display` beats the browser's closed
  `[popover]` rule.
- Hidden tabs (the test browser) throttle timers to about 1 s and may freeze animations, so a
  screenshot can show the bubble at opacity 0. Emulate `prefers-reduced-motion: reduce` before
  screenshots; assert on DOM state, not on timing.
- Tooltips do not run on `phone.html` or `dial-phone.html` (not loaded there).

## 7. Verify

```bash
node --check ui/tooltip.js
timeout 120 node --test ui/tooltip.test.js
bash scripts/check.sh
```

In the browser: hover a `title` element (tip after about 350 ms, `title` gone, `aria-describedby`
set), Tab onto it (tip at once), press Escape (hidden), open a dialog and hover inside it (bubble
inside the dialog, `:popover-open`).
