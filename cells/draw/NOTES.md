# Freehand Drawing Sketchpad (`cells/draw/`)

Interactive Cell #09 mounted into `#cell-draw` in [index.html](../../index.html). Provides a zero-chrome, full-bleed freehand drawing sheet for laptop trackpads, desktop mice, phone touchscreens, and styluses — paired with strictly **one** floating `Clear` button.

---

## 1. Intent & Architecture

Matches the repository's zero-build, zero-dependency `<script defer>` IIFE architecture so [index.html](../../index.html) runs identically over `file://`, `http://localhost`, and `https://`:

| File | Responsibility |
| :--- | :--- |
| [engine.js](engine.js) | `window.GeminiDraw.Engine` (plus CommonJS export for `node --test`): unclamped normalized `(u, v)` coordinate projection, `1.25px` tap-jitter deadband, zero-latency `dot` touchdown stamp, `O(1)` incremental $C^1$ midpoint quadratic Bezier spline (`drawOp` / `renderStroke`), double-EMA felt-tip velocity modulation (`[0.82×..1.12×]`), stylus-only pressure curve (`[0.52×..1.58×]`), and iterative stack-safe 3D `(x, y, w)` Ramer–Douglas–Peucker compaction (`compactPointsRDP`) with a `12,000`-vertex session ceiling. |
| [ui.js](ui.js) | `window.GeminiDraw.UI`: pure `createElement` / `createElementNS` DOM construction (`0` `innerHTML`), unified Pointer Events capture & 5-path termination matrix, `{ passive: false }` `touchstart`/`touchmove` shield strictly on `<canvas>`, fractional-grid exact-edge HiDPI `ResizeObserver` + cross-monitor DPR watcher, `[data-theme="dark"]` dynamic `--dw-ink` re-inking, and single focus-preserving `Clear` button (`aria-disabled`). |
| [draw.css](draw.css) | Strictly scoped under `.cell--draw` and `.dw-*`: `100%` full-bleed `<canvas>`, whisper-light centered pen-nib + `"Draw"` cue (`#6e6e6a`, `5.1:1` WCAG AA) that vanishes in `0ms` on first `pointerdown`, frosted translucent pill `Clear` button with `@media (pointer: coarse)` `42px+` touch target halo, `130ms` alternating-phase clear veil, `@container dw-card` micro adaptation (`≤ 220px`), `@media (forced-colors: active)`, and `@media (prefers-reduced-motion: reduce)`. |
| [draw.test.js](draw.test.js) | Headless `node:test` suite exercising normalization, unclamped edge loops, tap-to-dot, felt-tip & iOS `pressure === 0` physics, 3D RDP & vertex-budget compaction, simulated browser DOM/PointerEvent hazards, and `file://` `<script defer>` VM execution. |

---

## 2. Design & Technical Decisions (Protocol B Best-of-3 Synthesis)

Three divergent prototypes were built and tested in isolated branches before an independent critic scored them (`50`-point rubric):

1. **Candidate B — *Pure Zero-Chrome Sketchpad* (`46.5 / 50`, Winner)**:
   - **Why it won**: On `< 768px` mobile viewports, `.grid` renders 2 columns where each 4:3 `.cell` is only `~169×127 CSS px` to `~197×148 CSS px`. Eliminating header/footer bars gives the finger `100%` of the card area, while a centered whisper-quiet SVG pen-nib + `"Draw"` cue distinguishes the empty sheet from blank grid placeholders and vanishes instantaneously (`transition: none`) on first `pointerdown`. Emits `O(1)` incremental spline segments during `pointermove` whose midpoint decomposition matches `renderStroke` 1-to-1 on `ResizeObserver` replay.
2. **Candidate A — *Swiss Drafting Sheet* (`41.0 / 50`, Rejected as base; key traits merged)**:
   - **Why it lost**: Cleared and replayed all historical strokes (`O(N_total)`) plus `getComputedStyle` on every 120Hz/240Hz `pointermove`; ran 2D-only RDP + full redraw on `pointerup` (erasing stylus pressure swells on straight lines and popping quadratic corners); produced thin `~1.1px` phone strokes over `2px` background dots; and rendered a permanent corner badge over top-left ink.
   - **Traits merged into winner**: Standard synchronized `canvas.getContext('2d')` (avoiding `desynchronized: true` compositing flicker under `.dw-clear`'s `backdrop-filter: blur(6px)` and 60fps `MotionGrid` resizes), exact-edge fractional-grid `ctx.setTransform(targetW / rect.width, 0, 0, targetH / rect.height, 0, 0)`, and `16ms` clear-then-set `aria-live="polite"` re-announcement.
3. **Candidate C — *High-Frequency Vector Ink Engine + Keyboard Reticle* (`40.4 / 50`, Rejected as base; key traits merged)**:
   - **Why it lost**: Added a nested `inset: 4px` inner frame inside `.cell`, a verbose `"Trackpad · Touch · Cursor"` hint that truncated on narrow cells, unsmoothed single-frame velocity swings vulnerable to `getCoalescedEvents()` timestamp quantization, and `<canvas tabindex="0">` Space/Arrow reticle controls that risked hijacking page scroll keys and departed from *"Just very simple drawing: one clear button"*.
   - **Traits merged into winner**: `12,000`-vertex session budget compaction (`engine.js:createEngine`) and `@media (forced-colors: active)` high-contrast rules (`draw.css`).

---

## 3. Hazards & Invariants

- **Strictly one `<button>` (`ui.js:mount`)**: `rootEl.querySelectorAll('button').length === 1` (`Clear`). Never add brush pickers, undo stacks, or header chrome.
- **No top-right dead zone on empty sheet or fine cursors (`draw.css:.dw-clear`)**: `.dw-clear[aria-disabled="true"]` and `.cell--draw.is-drawing .dw-clear` set `pointer-events: none` so strokes starting in or sweeping through the top-right corner of a compact phone tile draw ink unimpeded, while `<button aria-disabled="true">` stays keyboard-focusable via `Tab` (unlike `disabled = true`, which ejects focus to `<body>` after `Enter`/`Space` clear). The `::after` `inset: -10px` (`42px+`) touch halo is gated behind `@media (pointer: coarse)` so laptop mouse/trackpad users keep exact `crosshair` precision right up to the pill edge.
- **iOS Safari touch & Apple Pencil Scribble shield (`ui.js:mount`)**: `{ passive: false }` `touchstart` and `touchmove` `preventDefault()` listeners are bound **exclusively to `<canvas>`** (never to `clearBtn`, preserving native mobile tap-to-click synthesis on `Clear`). `clearBtn` stops `pointerdown` propagation so tapping `Clear` never stamps a dot underneath.
- **iOS `touch` `pressure === 0` & WebKit `getCoalescedEvents()` `[]` traps (`engine.js:computeStrokeWidthFactor`, `ui.js:onPointerMove`)**: Non-3D-Touch iPhones report `pressure: 0` on every finger touch; pressure scaling is gated to `pointerType === 'pen' && pressure > 0`, while `touch` and `mouse` use double-EMA velocity modulation. `getCoalescedEvents()` falls back to `[e]` whenever it returns an empty array.
- **Unclamped normalized `(u, v)` + lossless `MotionGrid` & secondary-grid survival (`engine.js:normalizePoint`, `ui.js:syncCanvasBackingStore`)**: Coordinates are stored normalized to `getBoundingClientRect()` without clamping to `[0, 1]` so edge loops re-enter smoothly. Zero-size `ResizeObserver` callbacks (such as when Cell #05 temporarily sets `main.grid[hidden]`) finalize any active stroke without clearing `canvas.width` or `strokes`, and 60fps Cell #03 `MotionGrid` resizes (`140×105px` ↔ `960×720px`) replay crisp vector ink rather than stretching bitmap pixels.
- **Sibling keyboard coexistence (`ui.js:mount`)**: Binds zero `window` `keydown` listeners so Cell #03's global `r`/`R` reset shortcut is never intercepted.

---

## 4. How to Run & Verify

1. **Syntax gate**:
   ```bash
   node --check cells/draw/engine.js && node --check cells/draw/ui.js && node --check cells/draw/draw.test.js
   ```
2. **Automated unit & DOM/pointer hazard suite**:
   ```bash
   timeout 60 node --test cells/draw/draw.test.js
   ```
3. **Interactive verification (`file://` or `python3 -m http.server 8000`)**:
   - Draw quick flicks, slow loops, edge-exiting curves, and zero-movement single taps/clicks on laptop trackpad, mouse cursor, and phone touchscreen; verify the `"Draw"` cue vanishes immediately on first touch and `Clear` activates.
   - Resize the browser or scrub Cell #03 (`MotionGrid`) from `140px` to `960px`; verify strokes scale proportionally with zero pixelation.
   - Click, tap, or `Tab` + `Enter`/`Space` on `Clear`; verify the sheet clears with a `130ms` paper fade (instant under `prefers-reduced-motion: reduce`) and keyboard focus remains on `Clear`.
