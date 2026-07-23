---
name: ccpm-fabro
status: approved
created: 2026-07-23T16:38:42Z
updated: 2026-07-23T16:38:42Z
---

# ccpm-fabro — Design

## Purpose

Bridge **ccpm** (Claude Code PM — PRDs/epics/tasks tracked as GitHub issues) and
**Fabro** (Graphviz-graph workflow engine). A single Claude Code skill scans the
ccpm-managed GitHub backlog, selects issues with no unmet dependencies, and hands
each to a Fabro workflow that implements a PR using TDD — then writes progress back
to the issue and keeps the GitHub board and Fabro state in sync.

Coordinator/worker split:
- **Skill = coordinator** — scan, ready-check, confirm, sync/reconcile.
- **Fabro = worker** — TDD implement → open PR.

## Scope

In scope:
- Select ready ccpm task issues from GitHub and drive Fabro to implement them.
- TDD-gated implementation workflow that opens a PR closing the issue.
- Write-backs: progress comment + PR link, status labels, close-on-merge.
- A local manifest for idempotency and GH↔Fabro drift reconciliation.
- Validation against `inkan-tech/proclaw-reloaded`.

Out of scope (YAGNI):
- Creating PRDs/epics/tasks — ccpm's `/pm:*` commands own that.
- Parallel Fabro runs (local sandbox shares one workspace → sequential only).
- Auto-merge. Humans review/merge PRs; the skill only auto-**closes** issues whose
  PR is *already merged*.

## Architecture

### Components

1. **Skill** `~/.claude/skills/ccpm-fabro/` — global (works for any ccpm repo, not
   just proclaw-reloaded). Contains:
   - `SKILL.md` — the coordinator procedure (the loop below).
   - `references/ready-check.md` — how to parse `depends_on` and compute readiness.
   - `workflows/ccpm-tdd-issue/` — the bundled Fabro workflow (`workflow.fabro` +
     `workflow.toml`), copied into the target repo's `.fabro/workflows/` at runtime
     if absent.

2. **Fabro workflow** `ccpm-tdd-issue` — TDD graph, invoked as
   `fabro run ccpm-tdd-issue <issue#>` with the issue number as `$goal`.

3. **Manifest** `.ccpm-fabro/manifest.json` in the target repo (gitignored) — the
   idempotency + reconciliation source of truth.

### The loop (per skill invocation)

1. **Preflight**
   - `fabro auth login` state OK (currently failing — hard stop with instructions
     if not) and `gh auth status` OK.
   - Ensure a local clone of the target repo exists; `git clone` it if not (this is
     the "clone proclaw-reloaded" step). Runs use the **local** sandbox against
     this clone.
   - Copy `ccpm-tdd-issue` into the clone's `.fabro/workflows/` if missing.

2. **Reconcile** (keep-in-sync pass)
   - Read the manifest; for each tracked entry, `gh pr view` its PR state.
   - PR merged & issue still open → close the issue (write-back).
   - Detect drift (issue closed out-of-band, PR closed unmerged, run vanished) and
     report it; update manifest.

3. **Scan & ready-check**
   - `gh issue list --state open --label task --json number,title,body,labels`.
   - Parse ccpm body `depends_on:` (see `references/ready-check.md`). An issue is
     **ready** when every listed dependency issue is `closed`. No `depends_on`
     (or empty) ⇒ ready. Skip issues already `in-progress`/`in-review` in manifest.
   - Rank ready issues by epic grouping then issue number.

4. **Confirm**
   - Present the ranked ready list; user approves the whole batch or selects a
     subset. (Single approval gate, then hands-off.)

5. **Process sequentially** (local sandbox = one shared workspace)
   For each selected issue:
   - Add label `in-progress`, post a start comment, write manifest entry.
   - `fabro run ccpm-tdd-issue <issue#>` in the clone.
   - Success → post progress comment **+ PR URL + change summary**, swap label
     `in-progress` → `in-review`, update manifest with run id / branch / PR.
   - Failure (tests never green) → label `blocked`, comment the failure, update
     manifest.

### `ccpm-tdd-issue` workflow (TDD gate)

Graphviz nodes, model set via `model_stylesheet` like existing workflows:

```
start → plan → red → green → verify → pr → exit
```

- **plan** — `gh issue view $goal --json title,body,labels,comments`; write `plan.md`
  (summary, files, approach, acceptance-criteria → test cases).
- **red** — write failing tests covering the acceptance criteria; confirm they fail.
- **green** — implement until the new tests pass (manager cycles, house/child as
  needed).
- **verify** — run the full project test suite. On failure, loop back to green (bounded
  cycles); if still failing, emit a blocked signal the skill reads.
- **pr** — open a PR whose body includes `Closes #<issue>` and a change summary.

## Data & interfaces

### Manifest schema (`.ccpm-fabro/manifest.json`)

```json
[
  {
    "issue": 31,
    "epic": "dashboard-mvp",
    "fabro_run_id": "…",
    "branch": "ccpm/issue-31",
    "pr_url": "https://github.com/…/pull/…",
    "status": "in-review",
    "updated": "2026-07-23T16:38:42Z"
  }
]
```

`status` ∈ `in-progress | in-review | blocked | done`. The manifest makes
re-invocation idempotent (skip non-terminal tracked issues) and drives Reconcile.

### Ready-check (`references/ready-check.md`)

- Extract dependency ids from the issue body: match ccpm frontmatter/section forms
  (`depends_on: [1, 2]`, `depends_on: none`, "Blocked by #N"). Documented regex +
  fallback ("no dependency marker found ⇒ ready").
- For each dep id, `gh issue view <id> --json state`; ready ⇔ all deps `CLOSED`.
- Pure-GitHub; needs no local ccpm epic files (proclaw-reloaded has none locally).

## Error handling

- Preflight failures (Fabro auth, gh auth) → stop with the exact remediation command.
- A single issue's Fabro run failing does **not** abort the batch; it is marked
  `blocked` and the loop continues.
- Reconcile is defensive: unknown/removed runs and out-of-band issue state are
  reported, never silently "fixed" beyond close-on-merge.
- All GitHub writes go through `gh`; on failure, report and continue (don't retry
  blindly).

## Testing / validation plan

Target: `inkan-tech/proclaw-reloaded` (already ccpm-managed: epics + `task` issues).

1. **Dry-run** — scan + ready-check + ranked confirm list against the real backlog,
   **no** Fabro runs. Validates dependency parsing and selection.
2. **Live single issue** — pick one small `task`, run the full path
   (label → `fabro run ccpm-tdd-issue` → PR → comment → manifest), gated on
   `fabro auth login` succeeding. Confirms TDD→PR→sync end to end.
3. **Reconcile** — re-invoke; confirm the processed issue is skipped and PR-state
   reconciliation behaves (close-on-merge once its PR is merged).

## Open decisions already made

- Skill is **global**, not repo-local.
- Processing is **sequential** (local sandbox shares one workspace).
- `depends_on` is read from **GitHub issue bodies**, not local ccpm files.
- No auto-merge; auto-close only for already-merged PRs.
