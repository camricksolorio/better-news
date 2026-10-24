# docs/ — feature and dev work

All development work in this repo follows a customized version of Anthropic's
[AI-Native SDLC Playbook](https://academy.claude.com/courses/ai-native-sdlc-playbook) explained below.

## Layout

Feature work lives under `docs/product/`, one folder per feature or piece of
dev work, named in kebab-case. A new version of a feature gets its own folder
(`story-clustering-v2/`), not edits to the old one.

```
docs/
  AGENTS.md                 # this file
  product/
    <feature-name>/
      prd.md                # what is wanted, why, and under which constraints
      tdd.md                # technical design doc: how we'll build it (implementation details, trade-offs)
      plan.md               # the ordered steps to implement it, including tests
  design/                   # standing design principles and system (not a feature)
  research/                 # background research reports that inform features
```

`docs/design/` is not a feature. It holds the standing design principles and
system; see [design/AGENTS.md](design/AGENTS.md). Read it before building or
changing any UI.

`docs/research/` holds standalone research reports (for example
[story-clustering-sota.md](research/story-clustering-sota.md)). They are
background, not requirements: a PRD or TDD links to the report it relies on
rather than copying it.

Playbook mapping: `prd.md` plays the role of the playbook's `intent.md`,
`tdd.md` the role of `spec.md`, and `plan.md` is unchanged.

## Workflow

1. **PRD** — write `prd.md` first. It captures the intent: the problem, the
   goal, constraints, and what is out of scope.
2. **TDD** — derive `tdd.md` from the PRD. It settles the design before any
   code is written.
3. **Plan** — derive `plan.md` from the TDD. Concrete, ordered, checkable steps.
4. **Build** — implement against the plan. If reality diverges from the
   documents, update them in the same change rather than letting them rot.

Not every piece of work needs all three. Small changes can skip straight to
a `plan.md` (or no docs at all); a doc that isn't needed shouldn't be written.

## Rules for agents

- Before starting work on a feature, read its folder's `prd.md`, `tdd.md`,
  and `plan.md` (whichever exist) in that order to gain context. When a
  feature builds on an earlier version (v2 on v1), read the earlier folder too.
- Don't start building from a feature that has no `plan.md` without asking.
- Keep documents in the feature's folder under `docs/product/`; don't scatter planning docs in the
  repo root.
- Never rename the three filenames above; tooling and humans rely on them.

## Writing guidelines

How to write each document lives in personal (global) skills, not in this
repo, so the conventions apply across projects. Use the matching skill when
creating, editing, or reviewing a document. Guidelines for the remaining
documents are still being developed.

### prd.md

Use the `writing-prds` skill (`~/.claude/skills/writing-prds/`). It defines
the required sections and runs a co-authoring conversation for new PRDs.

### tdd.md

The technical design doc. It houses implementation details: architecture,
schema, algorithms, models and libraries, evaluation approach, cost
estimates, and risks. (Guidelines for writing one are still being developed.)

Cost estimates always go in the TDD, never in the plan.

### plan.md

_TBD._

All implementation status (what's built, in progress, done, or locked) lives in
`plan.md` and nowhere else. Never record it in a PRD or TDD.

## Features

| Folder | Docs present | Status |
| ------ | ------------ | ------ |
| [`product/story-clustering-v1/`](product/story-clustering-v1/) | `tdd.md`, `plan.md` | Groups articles into stories. No `prd.md`; intent is at the top of the TDD. Superseded in part by v2 (fragmentation). |
| [`product/story-clustering-v2/`](product/story-clustering-v2/) | `prd.md`, `tdd.md`, `plan.md` | Accepted PRD; TDD ready for review (windowed consolidation); plan written, not started. Fixes one event being split across several stories; blocks story-summary-v1. |
| [`product/story-summary-v1/`](product/story-summary-v1/) | `tdd.md`, `plan.md` | AI summaries and story cards. Paused until clustering v2 lands. No `prd.md`. |
