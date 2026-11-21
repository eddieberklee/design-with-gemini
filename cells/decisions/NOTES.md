# Decisions API 3-Cell Triptych (`cells/decisions/`)

Interactive 3-cell Row-1 triptych prototype for the **Gemini Decisions API** (`POST https://generativelanguage.googleapis.com/v1beta/decisions`, model `gemini-decision-1`), mounted into `#cell-decisions-input`, `#cell-decisions-verdict`, and `#cell-decisions-score` in [index.html](../../index.html).

---

## 1. Intent & Architecture

The Decisions API evaluates a shared multimodal input (text and/or image) against 1 to 1,000 typed questions in **one single forward pass** with **zero output tokens** (`total_output_tokens: 0`), returning calibrated probabilities instead of generating prose.

To make that flow immediately understandable without cramping all controls and visualizations into one 4:3 box, the prototype spans **Row 1 (3 adjacent linked cells)** on desktop (`≥ 768px`, and stacks `1 · INPUT` full-width over side-by-side `2 · CHECK & ROUTE` + `3 · RUBRIC & PROOF` on `< 768px`):

1. **Step 1 (`#cell-decisions-input`, `1 · Input` / "Gemini Decisions")**: hero = the specimen: heading, then the procedural `<canvas>` receipt / checkout image with its two-line description (or the input text as a quoted slip for Ticket / PR Gate), then the A/B switch (`.ui-seg`, `Clean Lunch ($54)` ↔ `Bar Tab ($192)`, etc.). Footer: scenario tabs (`Receipt`, `Ticket`, `UI QA`, `PR Gate`). Header: the mode pill.
2. **Step 2 (`#cell-decisions-verdict`, `2 · Check & route` / "Yes/no + category")**: hero = the **yes/no** (`noul`) question, its verdict readout (`NO · 8%`, 24 px under the question on tiles ≥ 320 px, at the end of the question line below that) and the draggable cutoff track with the previous-run ghost dot; the **category** (`choice`) question and its top-3 bars sit on the tile's bottom edge.
3. **Step 3 (`#cell-decisions-score`, `3 · Rubric & proof` / "Score")**: hero = the **rubric score** (`score`, `2.7 / 3` + peak tier) and the histogram, which takes the rest of the height, with the weighted-average pointer (`▲`) and certainty label. Footer: the plain `0 words generated` readout (`Demo · 0 words generated` for simulated results), timing, and `JSON ↗`. Header: `Customize ↗`.

The Workbench has no JSON editor and no numeric cutoff or score fields: the cutoff is set only by the in-tile/in-Workbench drag handle (clamped to 5–95%), and the request JSON is generated read-only from the Question Builder.

### UI system (shared `ui/`)

The three tiles and the Workbench use `ui/base.css` (see `ui/NOTES.md`): `ui.js` adds `ui-tile` to the three `index.html` sections on mount and removes it in `unmount()`; headers are `.ui-tile-head` with a grey `.ui-tile-step` (no rust lead step) + `.ui-tile-title`; bodies `.ui-tile-body`; footers `.ui-tile-foot`; controls `.ui-btn`, `.ui-seg`, `.ui-pill`. There are no step arrows (`→`): when the strip wraps (phone, Motion reflow) step 3 is not to the right of step 2. Size steps come from the shared `ui-tile` container: `< 320px` hides footers, the tile titles and `.ui-hide-compact`; `< 240px` (phone, Motion minimum) shows header + hero (step 2 keeps its winning category row; step labels shorten to `2 · Check` / `3 · Rubric`).

- **Mode pill (step 1, `renderInputCell`)**: idle grey `Demo data`; idle `Key set` (key saved, live mode, no live answer yet); rust `Connecting…` (live call in flight); green `Live` only after a live call returned; rust `API error`. Its `data-tip` changes with the state. A click always opens the Workbench with the key form.
- **Result tag (`buildResultTag`, steps 2 and 3)**: an idle `.ui-pill` `Demo`, or a rust `Live · edited` / `Demo · edited` when the tiles predate Workbench edits. It is in both headers because the step-3 footer is hidden below 320 px, and `decisions.css` keeps its label (not a bare dot) at the tiny size.
- **Studio (`buildWorkbenchShell`)**: `<dialog class="ui-dialog dc-dialog">` with a `.ui-studio-bar` (index, title, model, scenario select + variant `.ui-seg`, mode `.ui-seg`, key button, **Run** as the one black `.ui-btn--primary`, then `Close` with an Esc keycap tip). The key form's dismiss button reads `Cancel` (Esc). Tabs are a `.ui-seg` with `role="tab"`; the code inspector is mono on the surface, scrolling inside its box. Below 880 px the two panes stack in one scrolling column.
- **Tooltips**: every control, pill, unit-less readout and disabled control carries a `data-tip` (no `title` left in the cell). Dynamic tips are rebuilt with the markup on every render (mode pill, result tag, Run, key button, mode segment, certainty, EV pointer, ghost markers, hidden categories, remove buttons when disabled). Scenario tab tips (`PRESET_TIPS`) name each preset's three questions; question-type tips are `TYPE_TIPS`. The API key and its mask never appear in a tip or attribute.
- **Colour**: only `--ui-` tokens; `--dc-needle` (= `--ui-accent`) marks the measured probability, the EV pointer, the scanline and previous-run bars; `--dc-bar` / `--dc-bar-below` are the quiet bar fills. `CHOICE_SWATCHES` in `ui.js` is the Workbench ribbon palette.

All three cells share a single controller (`ui.js:mountDecisionsTriptych`) and fire **one** API request per evaluation, with a cascading left-to-right scanline pulse (`0ms → 70ms → 140ms`) and hover cross-highlighting demonstrating single-pass causality.

### Module Graph (`window.GeminiDecisions`)

All scripts load via classic `<script defer>` (never `type="module"`) so the prototype works zero-build over both `file://` and `http://localhost`:

| File | Responsibility |
| :--- | :--- |
| [schema.js](schema.js) | Wire contract constants (`ENDPOINT`, `MODEL`, `KEY_REGEX`), real-time state validation (`RESERVED_KEYS`, `VALID_TYPES`), exact `POST /v1beta/decisions` request builder, redacted `cURL` exporter (`$GEMINI_API_KEY`), defensive response normalizer (`toFiniteNumber`, choice tie-break + `winnerProb`, 0-indexed `score` expected value + spread `σ`, rubric range taken from the question, unusable answers moved to `normalized.invalid`), and `toDisplayPercents` (largest-remainder whole percents). |
| [presets.js](presets.js) | Four curated single-pass multi-question scenarios (`receipt`, `support`, `ui_qa`, `release`) with plain-English card questions (`cardQuestion`), human choice option labels (`opt.label`), short rubric tier labels (`levelLabels`), concrete A/B button labels (`buttonLabel`, `title`, `bullets`), untainted procedural `<canvas>` PNG specimens, and alpha-preserving client-side image downscaling. |
| [client.js](client.js) | `SecurityError`-safe cross-cell API key storage (`sessionStorage` default, opt-in `localStorage`, in-memory fallback when restricted; storage-first read clearing `memoryKey` on external clears, re-entrancy-guarded sync with `GeminiProsody` / `GeminiApiMatrix`, and `'gemini-key-changed'` dispatch), `fetch()` live client with `AbortController` + 25s timeout + error classification (`classifyApiError`: safety codes, bad key as `API_KEY_INVALID` + `keyProblem`, HTTP status headlines; `runLive` adds `MALFORMED_RESPONSE`), and deterministic offline simulator (`runSimulated`) using argmax-preserving Hamilton largest-remainder rounding. |
| [ui.js](ui.js) | Mounts the 3-cell Row-1 triptych (`mountDecisionsTriptych`, returning an idempotent `unmount()` disposer and subscribing to `'gemini-key-changed'` + `'storage'`) and native `<dialog>` Workbench studio; handles in-place pointer + keyboard threshold dragging, Ghost Delta comparison, full Question Builder with field-level validation, expandable specimen preview, clipboard image paste (`⌘V`), ARIA tablist/tabpanel navigation, focus restore across re-renders, and persistent ARIA live announcements. |
| [decisions.test.js](decisions.test.js) | `node:test` suite for `schema.js`, `presets.js`, `client.js` loaded in a `vm` sandbox (stubbed storage, `fetch`, canvas): validation, request/cURL building, response normalisation incl. malformed/partial answers, display percents, preset integrity, simulator ranges, live error classification, `KeyStore`. `ui.js` is DOM-bound and verified in the browser. |
| [decisions.css](decisions.css) | Scoped under `.cell--decisions*`, `.dc-*`, and `.dc-dialog`; built on `ui/base.css` tokens and classes. Joined desktop strip radii (`≥ 768px`, excluded under Motion `reflow`), mobile full-width `16:10` Input banner (`< 768px`, excluded under `.is-motion-controlled`), `@container ui-tile` rules (`≥ 320px` hero verdict, `< 320px`, `< 240px`), the heroes (specimen, yes/no track, category bars, histogram) and the Studio editor/inspector. Text contrast ≥ 5.39:1 (measured). |

---

## 2. Verified Wire Contract & API Key Policy

- **No separate API key is required.** The Decisions API authenticates with a standard **Gemini API key** from Google AI Studio passed in the `x-goog-api-key` header (never in the query string).
- **Direct browser CORS verified**: `OPTIONS https://generativelanguage.googleapis.com/v1beta/decisions` returns `200` with `access-control-allow-headers: content-type,x-goog-api-key` for both `Origin: http://localhost:8000` and `Origin: null` (`file://`).
- **Exact REST request shape** (`schema.js:buildRequestBody`):
  - `model`: `"gemini-decision-1"`
  - `input`: plain `string` (text-only) or array of `{ type: "image", data, mime_type, resolution }` + `{ type: "text", text }` (multimodal)
  - `questions`: map keyed by `/^[A-Za-z0-9_-]{1,64}$/` (excluding `__proto__`, `constructor`, `prototype`):
    - `noul`: `{ type: "noul", instructions, criteria?: { true_description?, false_description? } }`
    - `choice`: `{ type: "choice", instructions, criteria: { [optionKey]: description } }`
    - `score`: `{ type: "score", instructions, criteria: [level0Desc, level1Desc, ...] }` (0-indexed ordered rubric)
- **Exact REST response shape** (`schema.js:normalizeResponse`):
  - `answers[key]` returns `noul` (`0.01..0.99` + `confidence`), `choice` (`choice`, `probabilities`, `confidence`), or `score` (`score` expected value $\sum i \cdot P(i)$, `legend`, `probabilities`, `confidence`).
  - `usage`: `total_input_tokens`, `input_tokens_by_modality`, `total_output_tokens: 0`, `total_tokens`.

---

## 3. Design Decisions & Protocol B Rationale

After user feedback that the original single-cell prototype felt cramped and unclear, three divergent designs were compared:
- **3-Cell Row-1 Triptych (Shipped)**: Fits `index.html`'s 3-column desktop grid edge-to-edge on Row 1 (`1 · INPUT → 2 · CHECK & ROUTE → 3 · RUBRIC & PROOF`) with zero row-wrap orphan, gives the visual specimen and rubric chart real room to breathe, and replaces internal jargon (`NOUL`, `τ`, `Σ`, `σ`, `policy_violation`, `SIM`) with plain English; the API type names (`noul`, `choice`, `score`) live in the step titles' tooltips and the Workbench type tags.
- **4-Cell Suite (Rejected)**: Slightly more spacious per primitive, but wraps Cell 4 awkwardly onto Row 2 next to unrelated prototypes on 3-column desktop screens.
- **Single-Cell Card (Superseded)**: Crushed input + 3 primitives into ~50px rows with unreadable thumbnails and opaque jargon.

---

## 4. Hazards & Invariants

- **In-place threshold dragging (`ui.js:bindThresholdDrag`)**: Updates `pinEl`, `fillEl`, `pillEl`, `cutoffEl`, `tickEl`, and `verdictEl` in place without detaching the active track/slider node; only the passive surface (`verdictEl` vs Workbench) re-renders.
- **Never re-render the Workbench Left Pane on keystroke (`ui.js:renderWorkbenchLeft`)**: Input handlers mutate `app.state` in place so text inputs never drop cursor focus.
- **Race safety (`ui.js:runEvaluation`, `handleImageFile`)**: Every run increments `app.runSeq`, aborts prior `AbortController`, resets `setLoadingState(false)` on non-live exits, snapshots state for normalization, and stamps `uploadSeq` on async image decodes.
- **Popover click-outside propagation**: Buttons outside `wbRefs.keyAnchor` that open `#dc-key-popover` (`Live API` with no saved key, `Update API Key` on 401) call `e.stopPropagation()` so `dialog`'s outside-click listener never dismisses the popover on the same click tick.
- **Zero key leakage & zero XSS**: `schema.js:buildCurl` always redacts to `$GEMINI_API_KEY`; `ui.js:el()` assigns `value`/`checked` via DOM properties rather than HTML attributes and constructs all DOM via `createElement` + `textContent` (no `innerHTML` anywhere in the cell). The key is sent only in the `x-goog-api-key` header; the key input is reset to `type=password` whenever the popover closes.
- **Cutoff persistence (stated design)**: the Yes/No cutoff lives on the question object, so it survives an A/B specimen flip (`switchVariant` keeps `app.state.questions`) and resets to the preset's `0.5` on a scenario change (`switchPreset` clones fresh questions).
- **Demo labelling (`ui.js:buildResultTag`, `renderScoreCell`)**: every simulated result is labelled where it is shown: step 1 `Demo data` pill, steps 2 and 3 `Demo` pill in the header, step 3 `Demo · 0 words generated` footer readout, Workbench provenance banner, Raw Response `_simulated`. Labels follow `app.result.mode` (what is on screen), not `app.mode`, and must not live only in `.ui-tile-foot` / `.ui-hide-compact` / `.ui-hide-tiny`, which hide below 320 / 240 px (steps 2–3 are 177px at 390px, 233px at 768px and 273–311px from 900 to 1024px). Demo results never claim "1 call".
- **Stale tiles (`app.dirty`, `ui.js:finalizeDialogClose`)**: any Workbench edit sets `app.dirty`; a run clears it. On close, a dirty Demo state that validates is re-run so all three tiles describe the same input; a Live state is never re-sent implicitly and shows `Live · edited` (Cell 2 tag) until Run.
- **Unusable answers**: `schema.js:normalizeResponse` drops a non-numeric `noul`, or a `choice`/`score` with no positive probability mass, into `normalized.invalid`; tiles and Workbench say "No valid … answer returned" instead of rendering a fabricated 50% / 0%. A `score` always spans the question's rubric levels (missing levels show 0%).
- **Display percents (`schema.js:toDisplayPercents`)**: bars that show a full distribution add up to exactly 100% (rounded across all options before Cell 2 cuts to the top 3; the rest is summarised as `+N more · X%`). Partial distributions are rounded per value and never forced to 100.
- **Focus**: Workbench rebuilds keep focus via `data-fk` keys (`captureWorkbenchFocus` / `restoreWorkbenchFocus`, with `data-fk-fallback` when the control is gone or disabled); Tiles 2–3 keep it via `data-focus-role` (`focusedRoleIn` / `restoreTileFocus`, falling back to the mode pill). Closing the Workbench returns focus to the opener's `data-focus-role`.
- **Wrong key = HTTP 400**: Google rejects an invalid key with `400 INVALID_ARGUMENT` + `ErrorInfo.reason: API_KEY_INVALID` (verified 2026-11-21), which `client.js:classifyApiError` maps to `API_KEY_INVALID` so the UI offers **Update API Key**, not "inspect the Request JSON".

---

## 5. How to Run & Verify

1. **Zero-build local check**: Open `index.html` directly (`file://`) or serve with `python3 -m http.server 8000` and visit `http://localhost:8000`.
2. **Syntax check + logic tests** (Node 22 needs the file path, not the directory):
   ```bash
   for f in cells/decisions/*.js; do node --check "$f"; done
   node --test cells/decisions/decisions.test.js
   ```
   `cells/api-matrix/probes.test.js` also loads `client.js`; run it after any `KeyStore` change.
3. **Interactive verification**:
   - Across Row 1 (`1 · Input`, `2 · Check & route`, `3 · Rubric & proof`), flip `Clean Lunch ($54)` ↔ `Bar Tab ($192)` and switch scenarios (`Receipt`, `Ticket`, `UI QA`, `PR Gate`) to watch all 3 cells update in one synchronized wave with `0 words generated`.
   - Drag the cutoff marker in step 2 (`Cutoff 50%`) to flip `YES`/`NO` in place without re-querying.
   - Click `Demo data` (step 1), the specimen image (Cell 1), `Customize ↗` (Cell 3), or `JSON ↗` (Cell 3) to inspect/edit questions, upload/paste images, paste a standard Gemini API key, and inspect `Request & cURL` / `Raw Response`. Close by `Close`, Escape (first Escape closes an open key form) or backdrop; focus returns to the opener.
   - Live path without a real key: put a fake key in `sessionStorage['dc_gemini_api_key_session']` (not via Save, which syncs the sibling cells' stores), stub `window.fetch` to return delayed / 400 / 429 / malformed bodies, and dispatch `gemini-key-changed` on `window`. Expect the mode pill to go `Connecting…` (rust) → `Live` (green) or `API error` (rust); remove the key afterwards.
   - UI: at 1600, 900, 390 and 360 px and with the Motion size slider at minimum and maximum, no element of the three tiles leaves its tile; every `[data-tip]` shows its bubble on hover, and on keyboard focus for focusable ones. A late response for an old specimen must not overwrite the current one (`app.runSeq`), and the old request must be aborted.
