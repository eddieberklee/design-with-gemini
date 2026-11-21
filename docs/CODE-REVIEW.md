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

Every commit in `design-with-gemini` must describe the change **and** include structured git trailers at the end of the commit message stating what the committing agent will do immediately afterwards (`Agent-Stage`, `Next-Work`, and `Active-Paths` are mandatory; `Agent-Slice` is optional when a single feature directory already identifies the slice):

```text
<Imperative summary line>

<Optional concise context on what shipped and why>

Agent-Stage: <stage-1-land | stage-2-repair | stage-2-final | reviewer-fix>
Agent-Slice: <optional slice id, e.g. cells/spatial-audio/** — defaults to modified cells/<slug>/** or docs/**>
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

2. **Stage 2 Intermediate Repair (`stage-2-repair`)** — Agent landed Round 1 fixes and is running incremental delta verification or a second bounded fix (narrowing `Active-Paths` within the slice):
   ```text
   Fix AudioContext teardown race and narrow container query in Cell 04

   Agent-Stage: stage-2-repair
   Next-Work: Re-verifying Web Audio teardown and Safari fallback on cells/spatial-audio/client.js
   Active-Paths: cells/spatial-audio/client.js, cells/spatial-audio/NOTES.md
   ```

3. **Stage 2 Final / Completed Slice (`stage-2-final`)** — Agent finished its work on that slice and releases the entire slice immediately for proactive review/refinement:
   ```text
   Polish focus ring contrast and document AudioContext hazards in Cell 04

   Agent-Stage: stage-2-final
   Next-Work: none — slice complete
   Active-Paths: none
   ```
   *(Note: If Stage 2 finishes green with zero code changes after a `stage-1-land` commit, do **not** create an empty dummy commit — `Active-Paths` advisory leases automatically expire `10` minutes after `CommitterDate`.)*

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

1. **Gate 1 — Slice-Scoped Commit Trailer Lease & Clock Check**:
   - **Slice Identity (`Agent-Slice`)**: Resolve each commit's slice from its optional `Agent-Slice: <slice>` trailer; when omitted, default to the modified feature directory (`cells/<slug>/**` when touching a cell subtree, ignoring incidental root wiring in `index.html`/`README.md`, or `docs/**` when touching `docs/`; root-only commits default to their modified root paths unless grouped via `Agent-Slice:`).
   - **Lease Clock (`CommitterDate`)**: Measure the `10`-minute (`600s`) lease window strictly from `CommitterDate` (`git log --format=%ct`), **never** `AuthorDate` (`%at`), which `git pull --rebase` preserves across rebases.
   - **Slice-Scoped Narrowing & Release**: Evaluate recent commits (`CommitterDate` within `10` minutes) per slice `S`:
     - `stage-1-land` sets slice `S`'s active lease to its `Active-Paths:` globs.
     - A newer `stage-2-repair` in slice `S` **replaces (narrows/updates)** `S`'s lease to only the paths/globs listed in that `stage-2-repair` commit's `Active-Paths:`, immediately releasing earlier `S` paths omitted from the narrowed list.
     - A newer `stage-2-final` (`Active-Paths: none`) in slice `S` **immediately releases the entire slice directory `S`** (even if the final commit only edited a subset such as `NOTES.md`), without canceling or affecting any concurrent agent's lease on another slice `S' ≠ S`.
     - If `P` matches an unreleased, unexpired (`< 10m` from `CommitterDate`) lease in any slice, **do not edit `P` yet** — run the read-only 4-lens review immediately, queue findings, and apply unaddressed fixes once `stage-2-final` lands for that slice or its `10`-minute `CommitterDate` lease expires.
   - **Glob Semantics & Legacy Pre-Trailer Commits**: Trailing `/*` globs in `Active-Paths:` (e.g., `cells/foo/*`, `docs/*`) match **recursively** across nested subdirectories (`cells/foo/**`, `docs/**`). Legacy pre-trailer commits lacking `Agent-Stage:` / `Active-Paths:` automatically lease **all modified paths in that commit plus any parent `cells/<slug>/**` directory** for `10` minutes from `CommitterDate`.
2. **Gate 2 — Primary Workspace & Sibling Worktree Dirty-File Check**:
   - Enumerate worktrees (`git worktree list`) and inspect `git status --porcelain` plus file modification times (`mtime`) across **both the primary workspace (`/Users/edlee/Coding/design-with-gemini`) and every active non-reviewer git worktree** (excluding `.worktrees/reviewer` and read-only reviewer snapshot worktrees).
   - Never touch any file `P` that is modified, staged, or untracked in **the primary workspace or any active non-reviewer git worktree**, or whose sibling slice directory shows active file edits (`mtime`) within the last `3` minutes in any of those workspaces.
   - Hold off on shared root files (`index.html`, `README.md`) whenever an uncommitted prototype in the primary workspace or any active non-reviewer worktree is actively preparing to wire into them, unless fixing an acute broken build/load bug atomically.
3. **Gate 3 — Isolated Worktree Execution & Guarded Root Fast-Forward**:
   - All reviewer checkouts, tests, edits, commits, and `git rebase origin/main` operations execute inside `.worktrees/reviewer` (or isolated worker `workspace:"share"` copies), never directly mutating uncommitted state in `/Users/edlee/Coding/design-with-gemini`.
   - After pushing `HEAD:main`, fast-forward `/Users/edlee/Coding/design-with-gemini` (`git merge --ff-only origin/main`) **only** when **all** pre-flight guards hold simultaneously on `/Users/edlee/Coding/design-with-gemini`:
     1. Root is on branch `main` (`git symbolic-ref -q HEAD` is `refs/heads/main`).
     2. Root has zero staged changes (`git diff --cached --quiet` exits `0`).
     3. None of `.git/index.lock`, `.git/rebase-merge`, `.git/rebase-apply`, or `.git/MERGE_HEAD` (nor `.git/refs/heads/main.lock`) exist.
     4. Zero paths in `git diff --name-only HEAD..origin/main` overlap dirty or untracked root files (`git status --porcelain`).
   - If any guard fails, skip the root fast-forward cleanly; sibling agents pick up `origin/main` via their mandatory `git pull --rebase`.
4. **Gate 4 — Pre-Push Upstream Re-Check & Rebase-Safe Non-Recursion**:
   - Run `git fetch origin main` immediately prior to `git rebase origin/main && git push origin HEAD:main`. If an author pushed a new commit touching overlapping paths while the reviewer fix was being verified, inspect the new upstream diff first, re-apply Gate 1 against newly arrived trailers, and drop any superseded or leased hunks.
   - Enforce **rebase-safe non-recursion** via two invariants:
     1. Always skip self-review on any commit whose `Agent-Stage:` trailer is `reviewer-fix` (immune to rebase SHA rewriting and state resets).
     2. Record **post-push** SHAs (`git rev-parse HEAD` captured *after* `git rebase origin/main && git push origin HEAD:main`) in `.worktrees/reviewer-state.json` so the watcher never enters a self-review loop.

---

## 4. 4-Lens Proactive Review Rubric & Verification

Every newly landed commit is audited across four orthogonal lenses before proactive fixes are synthesized:

1. **Correctness, Race & Edge-Case Breaker**: Async/timer/`AbortController`/`AudioContext` leaks, rapid-toggle races, null/NaN/empty boundaries, state-reset bugs, and `file://` + `http://localhost` dual-origin compatibility (classic `<script defer>`, untainted `<canvas>`, storage fallbacks).
2. **Design, UX & Visual Craft Critic**: Scoped CSS isolation (never leaking rules into `.grid` or sibling `.cell` tiles), `@container` / responsive 4:3 card ergonomics, keyboard focus & ARIA semantics, contrast, tabular numerals, and honest simulated vs live telemetry.
3. **Architecture, Living Docs & Security Reviewer**: Zero API key leakage (`x-goog-api-key` headers, redacted `cURL`, no `innerHTML` XSS with untrusted input), clean module boundaries, and zero drift between shipped symbols and co-located `NOTES.md` / `README.md`.
4. **Live Execution Verifier**:
   - Whole-repo gate: `bash scripts/check.sh` (page wiring, `node --check` on every `.js` / `.mjs`, the `index.html` scripts parsed as one shared-global-scope program, and every Node suite; see `README.md` § Verify)
   - One cell's suites while iterating: `timeout 120 node --test "cells/<slug>/*.test.*"` (a bare directory argument fails on Node 22; suites are co-located as `cells/<slug>/*.test.js` / `*.test.mjs`; there is no top-level `tests/` directory)
   - Headless DOM/CSS/runtime smoke verification where applicable
