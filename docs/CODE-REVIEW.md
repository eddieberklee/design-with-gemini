# Continuous Code Review & Multi-Agent Commit Handoff Protocol (`docs/CODE-REVIEW.md`)

## 1. Intent & Architecture

`design-with-gemini` has multiple autonomous Gemini agents building grid cells and platform modules concurrently on `main` alongside a standing **Continuous Code Reviewer** that watches every new commit, runs a 4-lens cross-Gemini review, and proactively lands fixes.

Because every authoring agent uses a **two-stage execution lifecycle** (`Stage 1` fast land → `Stage 2` post-land audit & polish) or multi-commit feature slices, a reviewer that immediately edits files from a freshly landed commit without knowing what the author is doing next risks merge conflicts or clobbered follow-up work.

This document defines:
1. The **mandatory commit message handoff trailers** every agent includes on every commit.
2. The **4-gate toe-avoidance protocol** the Continuous Code Reviewer enforces before modifying any file.
3. The **isolated `.worktrees/reviewer` workflow** and **4-lens review rubric** used for proactive fixes.

---

## 2. Mandatory Commit Message Handoff Trailers

Every commit in `design-with-gemini` must describe the change **and** include three structured git trailers at the end of the commit message stating what the committing agent will do immediately afterwards:

```text
<Imperative summary line>

<Optional concise context on what shipped and why>

Agent-Stage: <stage-1-land | stage-2-repair | stage-2-final | reviewer-fix>
Next-Work: <exact follow-up work this agent is running next, or "none — slice complete">
Active-Paths: <comma-separated paths/globs this agent will edit next, or "none">
```

### Stage Reference & Examples

1. **Stage 1 Initial Land (`stage-1-land`)** — Agent just pushed the initial implementation and is immediately launching its Stage 2 post-land audit or next slice:
   ```text
   Add Cell 04: Spatial Audio Canvas prototype

   Agent-Stage: stage-1-land
   Next-Work: Running Stage 2 4-lens audit and keyboard accessibility polish on cells/spatial-audio/
   Active-Paths: cells/spatial-audio/*
   ```
   *(Tip: Exclude shared root files like `index.html` and `README.md` from `Active-Paths` once initial `<link>`/`<script>`/table wiring is committed unless you actively plan to edit them again in Stage 2.)*

2. **Stage 2 Intermediate Repair (`stage-2-repair`)** — Agent landed Round 1 fixes and is running incremental delta verification or a second bounded fix:
   ```text
   Fix AudioContext teardown race and narrow container query in Cell 04

   Agent-Stage: stage-2-repair
   Next-Work: Re-verifying Web Audio teardown and Safari fallback on cells/spatial-audio/client.js
   Active-Paths: cells/spatial-audio/client.js, cells/spatial-audio/NOTES.md
   ```

3. **Stage 2 Final / Completed Slice (`stage-2-final`)** — Agent finished its work on those files and releases them immediately for proactive review/refinement:
   ```text
   Polish focus ring contrast and document AudioContext hazards in Cell 04

   Agent-Stage: stage-2-final
   Next-Work: none — slice complete
   Active-Paths: none
   ```
   *(Note: If Stage 2 finishes green with zero code changes after a `stage-1-land` commit, do **not** create an empty dummy commit — `Active-Paths` advisory leases automatically expire after `10` minutes of inactivity.)*

4. **Continuous Code Reviewer Fix (`reviewer-fix`)** — Proactive defect, edge-case, accessibility, or documentation fix landed by the Continuous Code Reviewer on idle paths:
   ```text
   Fix stale AbortController cleanup and ARIA live label in Cell 01

   Agent-Stage: reviewer-fix
   Next-Work: Standing continuous code review watch on main (no files held)
   Active-Paths: none
   ```

---

## 3. Reviewer Toe-Avoidance Protocol (4 Safety Gates)

Before the Continuous Code Reviewer writes or pushes a proactive fix to any file `P`, all four gates must pass:

1. **Gate 1 — Commit Trailer Lease Check**:
   - Inspect `git log` trailers on recent commits (`≤ 10 minutes` old).
   - If the latest commit touching or claiming `P` has `Agent-Stage: stage-1-land` or `stage-2-repair` and lists `P` (or a matching glob) in `Active-Paths:` within the `10`-minute lease window (and no newer `stage-2-final` / `Active-Paths: none` commit superseded it), **do not edit `P` yet**. Run the read-only 4-lens review immediately, queue findings, and apply unaddressed fixes once `stage-2-final` lands or the `10`-minute lease expires cleanly.
   - Pre-trailer legacy commits without `Active-Paths:` receive an implicit `10`-minute Stage 2 grace lease on their modified cell directory.
2. **Gate 2 — Working Copy & Worktree Dirty-File Check**:
   - Inspect `git status --porcelain` and file modification times (`mtime`) in the primary checkout and active git worktrees.
   - Never touch any file that is modified, staged, or untracked in the primary workspace, or whose sibling slice directory shows active edits within the last `3` minutes.
   - Hold off on shared root files (`index.html`, `README.md`) whenever an uncommitted prototype in the root workspace is actively preparing to wire into them, unless fixing an acute broken build/load bug atomically.
3. **Gate 3 — Isolated Worktree Execution (`.worktrees/reviewer`)**:
   - All reviewer checkouts, tests, edits, commits, and `git rebase origin/main` operations execute inside `.worktrees/reviewer` (or isolated worker `workspace:"share"` copies), never directly mutating uncommitted state in the root working tree.
   - After pushing `HEAD:main` from `.worktrees/reviewer`, fast-forward the root checkout (`git merge --ff-only origin/main`) **only** when zero changed paths overlap dirty or untracked files in the root checkout.
4. **Gate 4 — Pre-Push Upstream Re-Check & Non-Recursion**:
   - Run `git fetch origin main` immediately prior to `git rebase origin/main && git push origin HEAD:main`. If an author pushed a new commit touching overlapping paths while the reviewer fix was being verified, inspect the new upstream diff first and drop any superseded hunks.
   - Record verified `reviewer-fix` SHAs in `.worktrees/reviewer-state.json` so the watcher never enters a self-review loop.

---

## 4. 4-Lens Proactive Review Rubric & Verification

Every newly landed commit is audited across four orthogonal lenses before proactive fixes are synthesized:

1. **Correctness, Race & Edge-Case Breaker**: Async/timer/`AbortController`/`AudioContext` leaks, rapid-toggle races, null/NaN/empty boundaries, state-reset bugs, and `file://` + `http://localhost` dual-origin compatibility (classic `<script defer>`, untainted `<canvas>`, storage fallbacks).
2. **Design, UX & Visual Craft Critic**: Scoped CSS isolation (never leaking rules into `.grid` or sibling `.cell` tiles), `@container` / responsive 4:3 card ergonomics, keyboard focus & ARIA semantics, contrast, tabular numerals, and honest simulated vs live telemetry.
3. **Architecture, Living Docs & Security Reviewer**: Zero API key leakage (`x-goog-api-key` headers, redacted `cURL`, no `innerHTML` XSS with untrusted input), clean module boundaries, and zero drift between shipped symbols and co-located `NOTES.md` / `README.md`.
4. **Live Execution Verifier**:
   - JavaScript syntax gate: `node --check <file.js>` across all modified `.js` files
   - Unit/DSP suites where present: `timeout 60 node --test tests/*.test.js`
   - Headless DOM/CSS/runtime smoke verification where applicable
