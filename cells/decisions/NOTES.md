# Decisions API Grid Cell (`cells/decisions/`)

Interactive Cell #1 prototype for the **Gemini Decisions API** (`POST https://generativelanguage.googleapis.com/v1beta/decisions`, model `gemini-decision-1`), mounted into `#cell-decisions` in [index.html](../../index.html).

---

## 1. Intent & Architecture

The Decisions API differs fundamentally from chat/text generation endpoints: in a **single forward pass** with **zero output tokens** (`total_output_tokens: 0`), `gemini-decision-1` evaluates a shared multimodal input (text and/or image) against 1 to 1,000 typed questions and returns calibrated probabilities.

### Module Graph (`window.GeminiDecisions`)

All scripts load via classic `<script defer>` (never `type="module"`) so the prototype works zero-build over both `file://` and `http://localhost`:

| File | Responsibility |
| :--- | :--- |
| [schema.js](schema.js) | Wire contract constants (`ENDPOINT`, `MODEL`, `KEY_REGEX`), real-time state validation, exact `POST /v1beta/decisions` request builder, redacted `cURL` exporter (`$GEMINI_API_KEY`), and defensive response normalizer (`noul`, `choice`, `score` expected value + spread `σ`). |
| [presets.js](presets.js) | Four curated single-pass multi-question scenarios (`receipt`, `support`, `ui_qa`, `release`) with instant A/B perturbation variants, untainted procedural `<canvas>` PNG specimen synthesis (zero external assets / zero `file://` taint), and client-side image downscaling for drag-drop / paste / file upload. |
| [client.js](client.js) | Safe API key storage (`sessionStorage` default, opt-in `localStorage`, in-memory fallback if storage is blocked), `fetch()` live client with `AbortController` + 25s timeout + structured HTTP/safety error diagnostics, and an honest deterministic offline simulator (`runSimulated`) that responds to text edits, custom questions, and image resolution. |
| [ui.js](ui.js) | Mounts the 4:3 in-grid instrument card and native `<dialog>` Workbench studio; handles in-place A/B perturbation, pointer + keyboard draggable `noul` threshold pin (`τ`), Ghost Delta comparison across consecutive runs, full Question Builder (`+ noul`, `+ choice`, `+ score`), clipboard image paste (`⌘V`), and ARIA live announcements. |
| [decisions.css](decisions.css) | Strictly scoped under `.cell--decisions`, `.dc-*`, and `.dc-dialog` so sibling grid cells remain unaffected. Uses `@container dc-card` breakpoints for generous desktop (`≥ 440px`), standard (`391–439px`), compact (`≤ 390px`), narrow (`≤ 340px`), and single-line micro (`≤ 265px`) 4:3 tiles. |

---

## 2. Verified Wire Contract & API Key Policy

- **No separate API key is required.** The Decisions API authenticates with a standard **Gemini API key** from Google AI Studio passed in the `x-goog-api-key` header (never in the query string).
- **Direct browser CORS verified**: `OPTIONS https://generativelanguage.googleapis.com/v1beta/decisions` returns `200` with `access-control-allow-headers: content-type,x-goog-api-key` for both `Origin: http://localhost:8000` and `Origin: null` (`file://`).
- **Exact REST request shape** (`schema.js:buildRequestBody`):
  - `model`: `"gemini-decision-1"`
  - `input`: plain `string` (text-only) or array of `{ type: "image", data, mime_type, resolution }` + `{ type: "text", text }` (multimodal)
  - `questions`: map keyed by `/^[A-Za-z0-9_-]{1,64}$/`:
    - `noul`: `{ type: "noul", instructions, criteria?: { true_description?, false_description? } }`
    - `choice`: `{ type: "choice", instructions, criteria: { [optionKey]: description } }`
    - `score`: `{ type: "score", instructions, criteria: [level0Desc, level1Desc, ...] }` (0-indexed ordered rubric)
- **Exact REST response shape** (`schema.js:normalizeResponse`):
  - `answers[key]` returns `noul` (`0.01..0.99` + `confidence`), `choice` (`choice`, `probabilities`, `confidence`), or `score` (`score` expected value $\sum i \cdot P(i)$, `legend`, `probabilities`, `confidence`).
  - `usage`: `total_input_tokens`, `input_tokens_by_modality`, `total_output_tokens: 0`, `total_tokens`.

---

## 3. Design Decisions & Protocol B Synthesis

Three divergent creative priors were explored before implementation:

1. **Swiss Instrument (Dieter Rams / Braun)** — Won the visual grammar: hairline dividers (`#efefef`), matte neutral surfaces harmonized with `index.html`, tabular numerals, Braun signal orange (`#d94f1e`) calibrated needles, and honest `sim` telemetry (never fabricated network latency).
2. **Kinetic Probability Lab** — Won the 3-second in-grid "aha" interaction: rendering all 3 primitives (`noul`, `choice`, `score`) simultaneously inside the 4:3 card, 1-click A/B input perturbation (`Clean` ↔ `Flagged`), procedural `<canvas>` multimodal specimens, draggable `noul` threshold pin (`τ`), Ghost Delta comparison markers, and `score` spread (`σ`).
3. **Developer Workbench** — Won the expanded studio architecture: full Question Builder with real-time schema validation, live-synced Request JSON & redacted `cURL`, zero-silent-fallback Live error diagnostics, and `file://`-safe key storage.

Rejected single-prior trade-offs:
- *Single-primitive card switcher*: Hid the batched multi-question single-pass superpower inside the grid cell.
- *ESM `<script type="module">`*: Blocked by browser CORS when opening `index.html` directly from `file://`.
- *Silent fallback on Live API errors*: Misleading; failed Live calls stay explicitly in `LIVE ERR` with `Retry Live` and `Switch to Simulated` on the card (and `Retry Live`, conditional `Update API Key` on `401`/`MISSING_KEY`, and `Switch to Simulated Preview` in the Workbench).

---

## 4. Hazards & Invariants

- **Never re-render the Workbench Left Pane on keystroke (`ui.js:renderWorkbenchLeft`)**: Input handlers mutate `app.state` in place and refresh only validation, Run button state, and the live wire preview so text inputs never drop cursor focus.
- **Race safety (`ui.js:runEvaluation`)**: Every live call increments `app.runSeq` and aborts any prior in-flight `AbortController` so rapid preset/variant clicks cannot clobber newer responses.
- **Zero key leakage**: `schema.js:buildCurl` always emits `-H "x-goog-api-key: $GEMINI_API_KEY"`; `client.js:runLive` never logs or interpolates keys into URLs or DOM error messages.
- **No untrusted HTML injection**: All DOM nodes in `ui.js` are constructed via `document.createElement` + `textContent` (`el()`), never string-interpolated `innerHTML`.

---

## 5. How to Run & Verify

1. **Zero-build local check**: Open `index.html` directly (`file://`) or serve with `python3 -m http.server 8000` and visit `http://localhost:8000`.
2. **Syntax check**:
   ```bash
   node --check cells/decisions/schema.js && node --check cells/decisions/presets.js && node --check cells/decisions/client.js && node --check cells/decisions/ui.js
   ```
3. **Interactive verification**:
   - In Cell #1, switch scenarios (`Receipt`, `Ticket`, `UI QA`, `PR Gate`) and flip the A/B perturb toggle (`Clean` ↔ `Flagged`, etc.) to verify all 3 primitives update in a single pass with `0 out tok`.
   - Drag the `noul` threshold pin (`τ`) on the card and inside the Workbench to verify live `YES`/`NO` flipping without re-querying.
   - Click `Lab ↗`, drop or paste (`⌘V`) an image, toggle `Res` (`low | medium | high`), add/edit questions, and inspect `Request & cURL` + `Raw Response`.
   - Click `+ Gemini API Key`, paste a standard Gemini API key, and click `Save & Go Live` to test live `gemini-decision-1` responses.
