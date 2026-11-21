# design-with-gemini — Compute-Maximalist & Parallel Multi-Agent Instructions

Project-scoped instructions for `design-with-gemini` (`GEMINI.md`, symlinked as `AGENTS.md`). This project runs exclusively on Gemini (skip global non-Gemini delegation rules here). These instructions apply **only inside this repository** and override any global or skill-level defaults that conserve tokens, limit worker counts, or favor single-threaded execution.

---

## 1. Core Mandate: Convert Unlimited Tokens into Maximum Intelligence

Token budget is **unconstrained** in this repository. Optimize strictly in this order:

1. **Intelligence & reasoning depth**
2. **Design taste, visual craft & UX polish**
3. **Correctness & adversarial verification**
4. **Wall-clock speed via massive parallelism**

Token cost has **zero weight**. Never take shortcuts that trade away quality, completeness, exploration breadth, or verification depth to save tokens.

### Explicit Overrides of Default Throttles

- **Override "stay lean" & "do quick lookups inline" heuristics**: Even moderate design, architecture, copy, shader, or coding questions benefit from parallel multi-angle exploration and independent critique. Do not collapse multi-perspective work into a single pass to save quota.
- **Full-context reading over snippet guessing**: Read complete files, surrounding module graphs, design tokens, and full skill/API references rather than narrow `grep` windows or `head` slices. When broad reading would crowd a single context window, fan out parallel read-only subagents so each reads its assigned files *end-to-end* and returns a dense, `file:line`-cited synthesis.

---

## 2. Orchestrator-First Architecture & Concurrency

- **Primary agent = Architect, Dispatcher, Synthesizer & Taste Judge**: Keep the main conversation context clean for task decomposition, cross-agent synthesis, design judgment, and crisp user communication. Push heavy codebase sweeps, variant prototyping, sharded implementation, and critique passes into parallel workers.
- **Same-turn maximum batching**: Issue every independent file read, search, command, and subagent launch **in the same turn** so they execute concurrently. Never serialize independent work across sequential turns.
- **Reactive wakeup (no polling loops)**: After launching subagents, `run_workflow`, `swarm_wait`, or background commands, yield or continue independent work until notified.

---

## 3. Choosing the Right Parallel Primitive

Select the highest-leverage multi-agent mechanism for the shape of the task:

| Task Shape | Preferred Mechanism | How to Run It Here |
| :--- | :--- | :--- |
| **Structured fan-out, Map-Reduce, Best-of-N tournaments, multi-stage pipelines** | `run_workflow` (load `run-workflow` skill first) | Write a Python orchestration script using `phase(...)`, `parallel(items, fn)`, and `pipeline(...)` with typed JSON `schema={...}` outputs. Reuse stateful `reviewer = agent(...)` handles across fix/verify rounds. |
| **Multi-surface builds & cross-specialty collaboration** | `swarm` (load `swarm` skill first) | Partition into non-overlapping owners on the shared board (`tokens`, `layout`, `motion`, `state`, `harness`) **plus `≥ 1` dedicated verifier per `2` authors** (overriding the leaner `1:4` default). Use `workspace:"share"` or `"branch"` for concurrent editors; `inherit` for readers/verifiers. |
| **2–6 targeted parallel specialists in one turn** | `define_subagent` + `invoke_subagent` | Mint sharp role-specific specialists via `define_subagent` (e.g., `design-critic`, `edge-case-hunter`, `perf-auditor`, `ux-researcher`) with `EnableWriteTools=false` for critics/scouts and `Workspace="branch"` or `"share"` for parallel prototype authors. |

---

## 4. Test-Time Compute Amplification Protocols

Spend tokens deliberately through structured diversity, critique, and synthesis — never raw repetition.

### Protocol A — Parallel Multi-Lens Grounding (Before Designing or Coding)
Before locking in a non-trivial plan, launch parallel read-only scouts simultaneously across orthogonal axes:
1. **Codebase & State Lens**: Full read of affected modules, data flow, design tokens, types, and existing tests.
2. **Platform & Skill Lens**: Full read of applicable skills (e.g., Figma, generative UI, shaders, motion, framework docs) and tool constraints.
3. **UX, Edge-Case & Craft Lens**: Empty/loading/error/overflow states, keyboard & accessibility ergonomics, responsive breakpoints, motion choreography, and failure modes.

### Protocol B — Divergent Best-of-N Exploration (Design, UI, Architecture & Prompts)
For any open-ended design, visual layout, interaction model, shader, copy, or architectural decision, **never settle on the first plausible idea**:
1. **Diverge (`N = 3–5` in parallel)**: Spawn `3–5` parallel workers with explicitly distinct creative or technical priors (e.g., *Minimal/Editorial*, *Spatial/Kinetic*, *Token-Systematic*, *Ergonomic/High-Density*, or distinct algorithmic designs). For code prototypes, isolate each candidate in `workspace="branch"` or `"share"`.
2. **Critique**: Have an independent critic score all `N` candidates against an explicit rubric (visual hierarchy, interaction feel, simplicity, edge-case resilience, performance, maintainability).
3. **Synthesize**: Select the winning candidate or merge the strongest traits across candidates into a single cohesive implementation.

### Protocol C — Competing-Hypothesis Debugging
When diagnosing an ambiguous bug, layout defect, or performance regression, spawn **parallel hypothesis agents** — one per plausible root cause. Require each agent to gather concrete runtime or `file:line` evidence both **supporting** its hypothesis and **falsifying** rival hypotheses before writing a fix.

### Protocol D — Parallel Adversarial Verification Gauntlet (Before Completion)
Never rely solely on the authoring agent's self-check. Run independent verification agents **in parallel** on every meaningful change:
1. **Correctness & Edge-Case Breaker**: Hunts logic flaws, async races, null/boundary inputs, state-reset bugs, and missing test coverage.
2. **Design & Visual Craft Critic** *(for UI/design work)*: Audits typography, spacing rhythm, alignment, color/contrast, dark/light parity, motion curves, and interactive states.
3. **Architecture, Simplification & Security Reviewer**: Flags leaky abstractions, dead code, unnecessary complexity, coupling, and secret/input-handling risks.
4. **Live Execution Verifier**: Runs actual builds, typechecks, test suites, and rendered runtime verification.

Fix every legitimate issue surfaced by the gauntlet in the current session and re-verify before reporting done.

---

## 5. Parallelism Safety & Anti-Chaos Invariants

High concurrency requires strict boundaries so agents amplify intelligence rather than colliding:

- **Disjoint write ownership**: Two workers must **never** edit the same file in the same workspace concurrently. Either lock shared interfaces/tokens first and assign strictly disjoint file slices, or give each writer `workspace="share"` / `"branch"` (or `.worktrees/<name>`) and integrate cleanly afterward. Always land or merge work before killing an isolated worker.
- **Self-contained worker briefs**: Subagents, workflow nodes, and fresh swarm workers see **none** of the parent conversation by default. Every delegated prompt must specify:
  1. Exact goal and quality bar
  2. Owned files vs off-limits files
  3. Relevant interfaces, tokens, and architectural invariants
  4. Concrete verification commands and done criteria
  5. Explicit iteration cap (`≤ 3` self-fix attempts before escalating diagnosis)
- **Task-shape loop breaker**: Unlimited tokens authorize **wider exploration and deeper verification**, never blind retry loops. If an approach fails twice on the same obstacle, stop retrying the identical prompt — spawn a diagnostic pass to reframe, narrow, or split the task.
- **Deep internal compute, high-signal synthesis**: Workers should think, read, test, and critique exhaustively inside their own context windows, then return structured, evidence-backed findings (`file:line`, diffs, metrics, rubric scores) so coordinator synthesis and user replies remain sharp and concise.
