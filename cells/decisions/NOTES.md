# Decisions API 3-Cell Triptych (`cells/decisions/`)

Interactive 3-cell Row-1 triptych prototype for the **Gemini Decisions API** (`POST https://generativelanguage.googleapis.com/v1beta/decisions`, model `gemini-decision-1`), mounted into `#cell-decisions-input`, `#cell-decisions-verdict`, and `#cell-decisions-score` in [index.html](../../index.html).

---

## 1. Intent & Architecture

The Decisions API evaluates a shared multimodal input (text and/or image) against 1 to 1,000 typed questions in **one single forward pass** with **zero output tokens** (`total_output_tokens: 0`), returning calibrated probabilities instead of generating prose.

To make that flow immediately understandable without cramping all controls and visualizations into one 4:3 box, the prototype spans **Row 1 (3 adjacent linked cells)** on desktop (`≥ 768px`, and stacks `1 · INPUT` full-width over side-by-side `2 · CHECK & ROUTE` + `3 · RUBRIC & PROOF` on `< 768px`):

1. **Cell 1 (`#cell-decisions-input`, `1 · INPUT`)**: Readable visual specimen (procedural `<canvas>` thermal receipt / checkout UI or readable text quote), concrete 2-way A/B flip buttons (`Clean Lunch ($54)` ↔ `Bar Tab ($192)`, etc.), bottom scenario switcher (`Receipt`, `Ticket`, `UI QA`, `PR Gate`), and `Demo Data` / `Live API` key pill.
2. **Cell 2 (`#cell-decisions-verdict`, `2 · CHECK & ROUTE`)**: Two spacious halves showing plain-English **Yes / No Check** (`noul`) with an in-place draggable `Cutoff: 50%` handle + ghost previous-run marker, and **Pick One Category** (`choice`) with human-labeled horizontal probability bars.
3. **Cell 3 (`#cell-decisions-score`, `3 · RUBRIC & PROOF`)**: Plain-English **Rubric Score** (`score`) with labeled 4-column distribution histogram, continuous Braun-orange expected-value pointer (`▲`), certainty label (`High certainty` / `Moderate spread` / `Mixed signals`), signature **`0 words generated`** proof strip, **`Customize ↗`** button, and **`JSON ↗`** deep-link into the Workbench `<dialog>`.

All three cells share a single controller (`ui.js:mountDecisionsTriptych`) and fire **one** API request per evaluation, with a cascading left-to-right scanline pulse (`0ms → 70ms → 140ms`) and hover cross-highlighting demonstrating single-pass causality.

### Module Graph (`window.GeminiDecisions`)

All scripts load via classic `<script defer>` (never `type="module"`) so the prototype works zero-build over both `file://` and `http://localhost`:

| File | Responsibility |
| :--- | :--- |
| [schema.js](schema.js) | Wire contract constants (`ENDPOINT`, `MODEL`, `KEY_REGEX`), real-time state validation (`RESERVED_KEYS`, `VALID_TYPES`), exact `POST /v1beta/decisions` request builder, redacted `cURL` exporter (`$GEMINI_API_KEY`), and defensive response normalizer (`toFiniteNumber`, choice tie-break, 0-indexed `score` expected value + spread `σ`). |
| [presets.js](presets.js) | Four curated single-pass multi-question scenarios (`receipt`, `support`, `ui_qa`, `release`) with plain-English card questions (`cardQuestion`), human choice option labels (`opt.label`), short rubric tier labels (`levelLabels`), concrete A/B button labels (`buttonLabel`, `title`, `bullets`), untainted procedural `<canvas>` PNG specimens, and alpha-preserving client-side image downscaling. |
| [client.js](client.js) | `SecurityError`-safe cross-cell API key storage (`sessionStorage` default, opt-in `localStorage`, in-memory fallback when restricted; storage-first read clearing `memoryKey` on external clears, re-entrancy-guarded sync with `GeminiProsody` / `GeminiApiMatrix`, and `'gemini-key-changed'` dispatch), `fetch()` live client with `AbortController` + 25s timeout + Google RPC `code`/`status` safety classification, and deterministic offline simulator (`runSimulated`) using argmax-preserving Hamilton largest-remainder rounding. |
| [ui.js](ui.js) | Mounts the 3-cell Row-1 triptych (`mountDecisionsTriptych`, returning an idempotent `unmount()` disposer and subscribing to `'gemini-key-changed'` + `'storage'`) and native `<dialog>` Workbench studio; handles in-place pointer + keyboard threshold dragging, Ghost Delta comparison, full Question Builder, expandable specimen preview, clipboard image paste (`⌘V`), ARIA tablist/tabpanel navigation, and persistent ARIA live announcements. |
| [decisions.css](decisions.css) | Strictly scoped under `.cell--decisions*`, `.dc-*`, and `.dc-dialog`. Joined desktop triptych radii (`≥ 768px`, excluded under Cell 03 `reflow`), mobile full-width `16:10` Input banner (`< 768px`, excluded under `.is-motion-controlled`), `@container dc-card` compact/micro rules (`≤ 340px`, `≤ 285px`, `≤ 255px`, `≤ 195px`), tabular numeric alignment, and WCAG 2.1 AA contrast (`--dc-ink-3: #63635f`, `--dc-needle-ink: #b43a10`). |

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
- **3-Cell Row-1 Triptych (Shipped)**: Fits `index.html`'s 3-column desktop grid edge-to-edge on Row 1 (`1 · INPUT → 2 · CHECK & ROUTE → 3 · RUBRIC & PROOF`) with zero row-wrap orphan, gives the visual specimen and rubric chart real room to breathe, and replaces internal jargon (`NOUL`, `τ`, `Σ`, `σ`, `policy_violation`, `SIM`) with plain English while keeping quiet mono API whispers (`noul`, `choice`, `score`).
- **4-Cell Suite (Rejected)**: Slightly more spacious per primitive, but wraps Cell 4 awkwardly onto Row 2 next to unrelated prototypes on 3-column desktop screens.
- **Single-Cell Card (Superseded)**: Crushed input + 3 primitives into ~50px rows with unreadable thumbnails and opaque jargon.

---

## 4. Hazards & Invariants

- **In-place threshold dragging (`ui.js:bindThresholdDrag`)**: Updates `pinEl`, `fillEl`, `pillEl`, `cutoffEl`, `tickEl`, and `verdictEl` in place without detaching the active track/slider node; only the passive surface (`verdictEl` vs Workbench) re-renders.
- **Never re-render the Workbench Left Pane on keystroke (`ui.js:renderWorkbenchLeft`)**: Input handlers mutate `app.state` in place so text inputs never drop cursor focus.
- **Race safety (`ui.js:runEvaluation`, `handleImageFile`)**: Every run increments `app.runSeq`, aborts prior `AbortController`, resets `setLoadingState(false)` on non-live exits, snapshots state for normalization, and stamps `uploadSeq` on async image decodes.
- **Popover click-outside propagation**: Buttons outside `wbRefs.keyAnchor` that open `#dc-key-popover` (`Live API` with no saved key, `Update API Key` on 401) call `e.stopPropagation()` so `dialog`'s outside-click listener never dismisses the popover on the same click tick.
- **Zero key leakage & zero XSS**: `schema.js:buildCurl` always redacts to `$GEMINI_API_KEY`; `ui.js:el()` assigns `value`/`checked` via DOM properties rather than HTML attributes and constructs all DOM via `createElement` + `textContent`.

---

## 5. How to Run & Verify

1. **Zero-build local check**: Open `index.html` directly (`file://`) or serve with `python3 -m http.server 8000` and visit `http://localhost:8000`.
2. **Syntax check**:
   ```bash
   node --check cells/decisions/schema.js && node --check cells/decisions/presets.js && node --check cells/decisions/client.js && node --check cells/decisions/ui.js
   ```
3. **Interactive verification**:
   - Across Row 1 (`1 · INPUT → 2 · CHECK & ROUTE → 3 · RUBRIC & PROOF`), flip `Clean Lunch ($54)` ↔ `Bar Tab ($192)` and switch scenarios (`Receipt`, `Ticket`, `UI QA`, `PR Gate`) to watch all 3 cells update in one synchronized wave with `0 words generated`.
   - Drag the `Cutoff: 50%` slider in Cell 2 (`2 · CHECK & ROUTE`) to flip `YES`/`NO` in place without re-querying.
   - Click `Demo Data` (Cell 1), `Customize ↗` (Cell 3), or `JSON ↗` (Cell 3) to inspect/edit questions, upload/paste images, paste a standard Gemini API key, and inspect `Request & cURL` / `Raw Response`.
