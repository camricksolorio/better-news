# Story clustering v2: TDD and plan written, ready to start Phase 1

- **Date:** 2026-10-24 15:58 (local)
- **Branch / HEAD:** `feat/story-clustering-v2` @ `cb3d1ab` (pushed, tracks `origin/feat/story-clustering-v2`; no PR)
- **Working tree:** clean apart from this handoff (uncommitted) and `.claude/launch.json` (untracked, not ours, leave it)
- **Feature docs:** `docs/product/story-clustering-v2/` (`prd.md`, `tdd.md`, `plan.md`)

## Summary

v1 clustering splits one news event across several stories (Alaska DOJ suit: 11 outlets in 5 stories). This session wrote the v2 TDD (windowed consolidation over cached pairwise classifier verdicts) and the implementation plan, and committed and pushed them on a new branch. No code has been written. The next step is Phase 1 of `plan.md`, once the owner approves the TDD and answers three readiness inputs.

## Current state

1. [x] Read PRD, SOTA research and v1 docs/code. Production checks (read-only): Alaska verdicts, pair volume, jev latency and cost, live-blog URL patterns. Findings are in the TDD
2. [x] Product questions answered by the owner (TDD Q1–Q5, decisions V7–V9, V12)
3. [x] TDD written: `docs/product/story-clustering-v2/tdd.md`, status **Ready for review** (not yet Approved). Also published as a private artifact: https://claude.ai/artifact/N75nK94KxS29iJkyMcQNpr (a rendering of the TDD; the repo file is the source of truth)
4. [x] Plan written: `docs/product/story-clustering-v2/plan.md` (5 phases, a go/no-go gate after Phase 3)
5. [x] Git: docs restructure (`docs/<feature>/` → `docs/product/<feature>/`, new `docs/research/`) committed as `e901695` and shared by both branches; v2 docs as `cb3d1ab`. `feat/story-summary-v1` was rebuilt on `e901695` (`a343529`, `fdbde36`; tree verified identical to before) and pushed. A trial merge of the two branches is clean
6. [ ] Owner approves the TDD → set its Status to `Approved` (first commit of Phase 1)
7. [ ] Phase 1 readiness items (plan.md): jev pin probe and 1.14.0 reference re-check (need spend go-ahead), Drizzle migration-journal reconcile, `feed_items` export (owner picks a location)
8. [ ] Phases 1–5 per `plan.md`

5 of 8 done. **Next action:** get the owner's TDD approval and their answers to the three Phase 1 inputs (see Open questions), then start Phase 1's readiness items.

## Key decisions and why

All are in the TDD's `#### Design decisions` (V1–V13); highlights the next agent must not relitigate:

- **Batch consolidation, not patching the incremental path (V1).** Root causes 1, 3 and order dependence come from deciding each article once, greedily, against one candidate. Measured cost made batch affordable: 1,209 articles on 2026-10-22 gave about 5.9k unique pairs at cosine ≥ 0.84 (±36h, k = 15); jev costs about $0.000027/call with p50 ~100ms.
- **Pairwise jev verdicts kept; thresholds recalibrated on events (V5).** In the Alaska traces, the splits had jev `same` at p 0.73–0.89, just under τ 0.93, and the right story was found by retrieval (0.91–0.95). So the problem is the decisions, not retrieval; embeddings are unchanged (V13).
- **Reader-safety merge rules (V8, owner decision).** A never-placed article may join any story; when two visible cards merge, the **newer** survives; articles may always move out. "Unseen" means never yet placed in any story. Reason: no reader accounts, and the owner said an unseen card must never disappear into one people have read. Owner is fine with stories changing after being viewed.
- **Live blogs dropped at ingest (V7, owner decision),** with per-source URL rules. Existing ones are marked `excluded_reason`, not deleted (FKs from `story_assignments`).
- **36h pair gap, 48h story span (V9, owner).** **Owner labels 30 events** with an admin tool (V12).
- **Cost accepted (2026-10-24):** steady state ≈ $0.13–0.37/day vs v1's ≈ $0.035/day; the owner accepts it if results improve, which the Phase 3 gate tests. Lazy judging and a daily call budget were discussed and deliberately left out of the plan ("Not in this plan").
- **Research report usage:** rolling-window batch, article graph and time windows were taken from `docs/research/story-clustering-sota.md`; HDBSCAN, Leiden, the NER penalty and LLM-summary embeddings were rejected or deferred (rationale in V3 and V13).
- **Git:** the restructure lives in one shared commit (`e901695`) on both branches. Cherry-picking it separately caused a `docs/AGENTS.md` conflict, which is why the summary branch was rebuilt.

## Open questions / issues

- **TDD approval.** Status is `Ready for review`. Building should wait for the owner to approve (the owner resolves it).
- **Phase 1 inputs, all owner:**
  1. Go-ahead for the jev `jev-1.14.0` pin probe (a fraction of a cent) and the 86-pair reference re-check (< $0.05). Standing rule: ask before any paid chat or classifier spend (see memory `feedback_flash_lite_needs_approval.md`).
  2. Where to store the pre-migration `feed_items` export (Supabase free plan has no backups).
  3. OK to reconcile `drizzle.__drizzle_migrations` (6 rows for 8 applied migrations) by marking the hand-applied ones applied. Show the exact rows before writing.
- **`jev-latest` drifted** from 1.13.0 to 1.14.0 on 2026-10-22. Production v1 τ 0.93 was calibrated on 1.13.0. Whether TypeSafe accepts a pinned version is unverified.
- **Unverified estimates:** pair volume per day (one day measured, cross-day double counting likely inflates it), the 20% densify/re-judge allowance, version churn, jev concurrency limits. These are listed in the TDD's `## Risks`.
- **Local branch `backup/story-summary-v1-pre-rebase`** (`5963acd`) still exists; the owner hasn't said to delete it.
- **No PRs** are open for either branch. `feat/story-summary-v1` is paused until v2 lands (see `.claude/handoffs/2026-10-24-1018-story-summary-bakeoff-paused.md`).

## Relevant docs

- `docs/product/story-clustering-v2/plan.md`: what to do next, phase by phase; the source of truth for status
- `docs/product/story-clustering-v2/tdd.md`: the design, config table and starting values, schema, decisions V1–V13, risks, cost
- `docs/product/story-clustering-v2/prd.md`: requirements R1–R11, the three example events, acceptance criteria
- `docs/product/story-clustering-v1/tdd.md` and `plan.md`: v1 design and measured results (D31–D37, join audit 150/150)
- `lib/pipeline/assign.ts`, `adjudicate.ts`, `store-db.ts`, `cluster.ts`: the v1 code that v2 replaces or extends; `app/api/ingest/route.ts` (the upsert that overwrites text)
- `docs/research/story-clustering-sota.md`: background only
- `docs/AGENTS.md`: docs conventions (statuses, no implementation status in a TDD, cost only in the TDD)
- Production DB, read-only: `psql "$DATABASE_URL"` after sourcing `.env`, with `set default_transaction_read_only=on`. Tables `story_assignments` (`llm_verdict`), `llm_calls` (jev cost and latency)
- Tests need local Postgres: `brew services start postgresql@17`
