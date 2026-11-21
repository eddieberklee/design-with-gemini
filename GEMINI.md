# design-with-gemini — Automatic Teamwork, Boost & Compute-Maximalist Instructions

Project-scoped instructions for `design-with-gemini` (`GEMINI.md`, symlinked as `AGENTS.md`). This project runs exclusively on Gemini: skip external model-routing skills and non-Gemini delegation rules here, override global "small diffs" caution whenever visual craft or architectural quality warrants bold changes, and treat these rules as standing user authorization for automatic multi-agent swarms, cross-Gemini verifier diversity, and immediate git pushes on authorized repository changes. These instructions apply **only inside this repository** and override any defaults that conserve tokens, limit worker counts, favor single-threaded execution, or wait for manual `/teamwork` or `/boost` slash commands.

---

## 1. Core Mandate: Unlimited Compute + Automatic Teamwork & Boost

Token budget is **unconstrained** in this repository. Optimize strictly in this order:

1. **Intelligence, reasoning depth & positive evidence**
2. **Design taste, visual craft & UX polish**
3. **Correctness & cross-Gemini adversarial verification**
4. **Fast non-blocking land followed by deep parallel follow-up**

Token cost has **zero weight**. Never take shortcuts that trade away quality, exploration breadth, or verification depth to save tokens, and **never ask the user to manually run `/teamwork` or `/boost`** — multi-agent teamwork and deep-effort boost behavior are **always on automatically** here.

### Explicit Overrides of Default Throttles

- **Override "stay lean" & single-pass heuristics**: Non-trivial design, architecture, copy, shader, debugging, and coding tasks get parallel multi-angle exploration and independent critique rather than a single inline pass. (Trivial factual lookups may still be answered directly without ceremonial overhead.)
- **Full-context reading over snippet guessing**: Read complete files, surrounding module graphs, design tokens, and full skill/API references rather than narrow `grep` windows or `head` slices. Fan out parallel read-only subagents when broad reading would crowd a single context window so each reads its assigned files *end-to-end* and returns `file:line`-cited syntheses.
- **Boost Evidence & Convergence Standard**:
  - Ruling out alternatives B and C **never** proves A — every conclusion requires **direct positive evidence** (`file:line`, build/test output, runtime log, or rendered output).
  - Hedging (`"likely"`, `"probably"`) means *Unverified*; keep investigating until converged on one proven root cause or design.
  - Err on the side of one more verification pass whenever requirements are dense, scope is open-ended, or any defect or untested path surfaces. Never weaken, skip, or special-case tests to pass.

---

## 2. Two-Stage Execution Lifecycle: Land First, Then Automatic Post-Land Teamwork & Boost

**Scope Guard**: Every authorized repository file change (code, design assets, docs, or config) follows the **Stage 1 → Stage 2** pipeline below unless the user explicitly asks not to commit or push. Pure read-only questions, audits, or explorations that modify no repository files run Section 1 & Section 4 parallel analysis/verification in-turn without git commits or Stage 2 swarms.

### Stage 1 — Parallel Build & Immediate Land (Never Block Commit/Push)

1. **Build with parallel leverage**: Use parallel grounding (`Protocol A`), divergent Best-of-N prototyping (`Protocol B`), and sharded isolated writers (`workspace:"share"` or `"branch"`) to produce the implementation rapidly.
2. **Fast pre-land sanity gate**: Review `git diff` and run **cheap local checks only** (syntax, typecheck, lint, fast smoke check — never land a knowingly broken or destructive change, and stage only task-owned paths so unrelated dirty files are never clobbered or discarded).
3. **Commit, rebase & push immediately**: Commit staged task files, rebase onto the active branch's upstream when clean (`git pull --rebase`, defaulting to `origin/main` on `main`), and push immediately (standing push authorization overriding `swarm` push-only-when-asked defaults) to establish `<landed-sha>`. **Never block landing** on long test suites, multi-round adversarial debates, or secondary polish passes.

### Stage 2 — Automatic Post-Land Teamwork & Boost Follow-Up (Mandatory, Same Session)

Immediately **after** an initial Stage 1 `<landed-sha>` is pushed — starting in the **same turn** without waiting for user prompting or manual `/teamwork` / `/boost` commands — run the **Post-Land Teamwork & Boost Gauntlet** against `<landed-sha>`:

1. **Launch Post-Land Teamwork Swarm (`swarm` tool — coordinator loads `swarm` skill if listed in `<skills>`)**:
   - Coordinate parallel specialist verifiers on the shared board (`swarm{action:"title", ...}` + `swarm{action:"add", ...}`). Use `run_workflow` alongside or inside follow-up work only for structured Python fan-outs/pipelines that do not require a shared board or named model pinning.
   - **Swarm Turn-1 Mechanics**: On the swarm-creation turn, call `swarm{action:"models", all:true}` first, then `title` and `add` all workers (plus `monitor` / `narrator` when their skills are listed in `<skills>`), include the exact `open_board` link when replying to the user, and end the turn (`post_message`, `read_board`, and `swarm_wait` become available on the next turn).
2. **Dynamic Cross-Gemini Adversarial Verifiers**:
   - From `swarm{action:"models", all:true}`, filter strictly to **Gemini** models with available quota/credits and pin adversarial verifier workers (`swarm{action:"add", model:"..."}`) to high-tier Gemini variants **distinct from the authoring coordinator's model** (standing user override of `swarm`'s same-model default; never hardcode model names so nothing goes stale). If no distinct in-quota Gemini variant is available, fall back to the coordinator's own Gemini model and note the single-model fallback.
   - Require **blind re-derivation**: verifiers trace the user request/spec and raw code *before* reading commit messages or author claims.
3. **4-Lens Parallel Boost Audit**:
   - **Correctness, Race & Edge-Case Breaker**: Hunts logic flaws, async races, null/boundary inputs, state-reset bugs, and missing regression tests.
   - **Design, UX & Visual Craft Critic** *(for UI/design work)*: Audits visual hierarchy, typography, spacing rhythm, alignment, color/contrast, dark/light parity, motion curves, and empty/loading/error/overflow/focus states.
   - **Architecture, Simplification & Security Reviewer**: Flags leaky abstractions, dead code, unnecessary coupling, and secret/input-handling risks.
   - **Full Live Execution Verifier**: Runs full builds, complete test suites, and rendered runtime/UI verification on `<landed-sha>`.
4. **Bounded Follow-Up Repairs & Incremental Re-Verification (No Infinite Swarm Recursion)**:
   - Fix every legitimate bug, red check, missed edge case, or high-value craft upgrade surfaced in Round 1 right away (using `workspace:"share"` / `"branch"` for concurrent writers), run local verification, and **commit + rebase + push follow-up commit(s)** to `<repair-sha>`.
   - Re-verify `<repair-sha>` via **incremental delta review on the existing Stage 2 verifiers** — **never** spawn a brand-new full Stage 2 swarm for a Stage 2 follow-up commit. Cap subjective craft polish to `1` follow-up round and total Stage 2 repair cycles to `≤ 2` rounds before escalating diagnosis, while ensuring `0` known objective bugs or red checks remain.
5. **Clean Closeout & Status Honesty**:
   - Report `"landed <sha>, post-land teamwork/boost follow-up running"` whenever Stage 2 workers are still in flight.
   - Once Stage 2 finishes green, post `[done] <summary>` (with no `@`) to quiet any swarm `monitor`, `kill` finished task workers (never `monitor` or `narrator`) after all isolated work is merged/landed, and report `"verified <final-sha>"`.

---

## 3. Orchestrator-First Architecture & Parallel Primitives

- **Primary agent = Architect, Dispatcher, Synthesizer & Taste Judge**: Keep the main conversation context clean for task decomposition, cross-agent synthesis, design judgment, and crisp user communication.
- **Same-turn maximum batching**: Issue every independent file read, search, command, and worker launch **in the same turn** so they execute concurrently.
- **Reactive wakeup (no polling loops)**: After launching subagents, `run_workflow`, `swarm_wait`, or background commands, yield or continue independent work until notified.

| Task Shape | Preferred Mechanism | How to Run It Here |
| :--- | :--- | :--- |
| **Structured fan-out, Map-Reduce, Best-of-N tournaments, multi-stage pipelines** | `run_workflow` (load `run-workflow` skill first) | Write a Python orchestration script using `phase(...)`, `parallel(items, fn)`, and `pipeline(...)` with typed JSON `schema={...}` outputs. Reuse stateful `reviewer = agent(...)` handles across fix/verify rounds. |
| **Multi-surface builds & post-land cross-Gemini teamwork/review** | `swarm` (coordinator loads `swarm` skill if in `<skills>`) | Partition into non-overlapping owners on the shared board (`tokens`, `layout`, `motion`, `state`, `harness`) **plus `≥ 1` dedicated cross-Gemini verifier per `2` authors** (via `swarm{action:"models", all:true}`). Use `workspace:"share"` or `"branch"` for concurrent editors; `inherit` for readers/verifiers. |
| **2–6 targeted parallel specialists in one turn** | `define_subagent` + `invoke_subagent` | Mint sharp role-specific specialists via `define_subagent` (e.g., `design-critic`, `edge-case-hunter`, `perf-auditor`, `ux-researcher`) with `EnableWriteTools=false` for critics/scouts and `Workspace="branch"` or `"share"` for parallel prototype authors. |

---

## 4. Pre-Land Intelligence Amplification Protocols

### Protocol A — Parallel Multi-Lens Grounding (Before Designing or Coding)
Before locking in a non-trivial plan, launch parallel read-only scouts simultaneously across orthogonal axes:
1. **Codebase & State Lens**: Full read of affected modules, data flow, design tokens, types, and existing tests.
2. **Platform & Skill Lens**: Full read of applicable skills (e.g., Figma, generative UI, shaders, motion, framework docs) and tool constraints.
3. **UX, Edge-Case & Craft Lens**: Empty/loading/error/overflow states, keyboard & accessibility ergonomics, responsive breakpoints, motion choreography, and failure modes.

### Protocol B — Divergent Best-of-N Exploration (Design, UI, Architecture & Prompts)
For any open-ended design, visual layout, interaction model, shader, copy, or architectural decision, **never settle on the first plausible idea**:
1. **Diverge (`N = 3–5` in parallel)**: Spawn `3–5` parallel workers with explicitly distinct creative or technical priors (e.g., *Minimal/Editorial*, *Spatial/Kinetic*, *Token-Systematic*, *Ergonomic/High-Density*, or distinct algorithmic designs) in isolated `workspace="branch"` or `"share"` copies.
2. **Critique**: Have an independent critic score all `N` candidates against an explicit rubric (visual hierarchy, interaction feel, simplicity, edge-case resilience, performance, maintainability).
3. **Synthesize**: Land the winning candidate or merge the strongest traits across candidates into a single cohesive implementation for Stage 1 landing, followed by Stage 2 post-land polish.

### Protocol C — Competing-Hypothesis Debugging
When diagnosing an ambiguous bug, layout defect, or performance regression, spawn **parallel hypothesis agents** — one per plausible root cause. Require each agent to gather concrete runtime or `file:line` evidence both **supporting** its hypothesis and **falsifying** rival hypotheses before writing a fix.

---

## 5. Parallelism Safety & Anti-Chaos Invariants

- **Disjoint write ownership**: Two workers must **never** edit the same file in the same workspace concurrently. Lock shared interfaces/tokens first and assign strictly disjoint file slices, or isolate each writer in `workspace="share"` / `"branch"` (or `.worktrees/<name>`) and integrate cleanly afterward. Always land or merge work before killing an isolated worker.
- **Self-contained worker briefs & wakeup `@mentions`**: Subagents, workflow nodes, and fresh swarm workers see **none** of the parent conversation by default, and parked swarm members wake **only** when `@mentioned`. Every delegated prompt must specify:
  1. Exact goal and quality bar
  2. Owned files vs off-limits files
  3. Relevant interfaces, tokens, and architectural invariants
  4. Concrete verification commands, done criteria, and — for swarm workers — ending the final report with `@coordinator [done]` (or the next peer's `@name`)
  5. Explicit iteration cap (`≤ 3` self-fix attempts before escalating diagnosis)
- **Task-shape loop breaker**: Unlimited tokens authorize **wider exploration and deeper verification**, never blind retry loops. If an approach fails twice on the same obstacle, stop retrying the identical prompt — spawn a diagnostic pass to reframe, narrow, or split the task.
- **Deep internal compute, high-signal synthesis**: Workers think, read, test, and critique exhaustively inside their own context windows, then return structured, evidence-backed findings (`file:line`, diffs, metrics, rubric scores) so coordinator synthesis and user replies remain sharp and concise.
