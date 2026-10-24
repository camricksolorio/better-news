# Story Clustering v2 — Implementation Plan

Design, decisions, schema, contracts, and cost live in [tdd.md](tdd.md); requirements in [prd.md](prd.md). This
document is the ordered build sequence and the single place implementation status is tracked.

The order follows the PRD's process: **measure first, then change**. Phases 1–2 build the data and evaluation
foundations and record v1's baseline without changing clustering behavior. Phase 3 builds the consolidation and
measures it offline. It ends in a **go/no-go gate**: production clustering changes (Phase 4) and data repair
(Phase 5) happen only if the offline numbers meet the bars. Each paid classifier run needs the owner's go-ahead,
with its estimate taken from the TDD's [Cost](tdd.md#cost) section.

## Readiness

Checked 2026-10-24:

| Check | Status |
|---|---|
| PRD | ✅ Accepted 2026-10-24, including the targets in R1, R2 and R7 |
| TDD | ✅ Ready for review; Q1–Q5 answered by the owner 2026-10-24 |
| `JEV_API_KEY`, `GOOGLE_GEMINI_API_KEY` (paid tier) | ✅ In use in production (18k jev calls with 0 failures, Oct 6–24) |
| jev version pinning | ⚠️ Unknown. `jev-latest` moved from 1.13.0 to 1.14.0 on 2026-10-22. Checked in Phase 1 |
| Supabase backups | ⚠️ Free plan, no backups (v1 finding). Phase 1 exports `feed_items` before the migration |
| Drizzle migration journal | ⚠️ `drizzle.__drizzle_migrations` has 6 rows for 8 migrations (v1 plan, migration 0008). Phase 1 reconciles it before relying on `db:migrate` |
| Branch | ✅ `feat/story-clustering-v2` from `main` (2026-10-24), carrying the `docs/product/` restructure and the v2 docs |
| Local test database | ✅ Local Postgres 17 (`brew services start postgresql@17`), used by the existing test suite |
| Owner time | ⚠️ Needed for about 30 event labels (Phase 2) and a 150-item membership audit (Phase 3) |

## Phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **1. Data foundations** | One migration for all v2 schema changes; live-blog filter and exclusion; article versions at ingest; first publish time; re-embedding changed text; `placed_at` maintained by v1 | Migration applied to production after an export; ingest writes versions; live blogs excluded; v1 clustering still runs unchanged; tests pass |
| **2. Evaluation first** | New snapshot; event-labelling admin page; event sampler; 30 labelled events; `pnpm eval:events` harness; v1 baseline | v1's event recall, split counts, contamination, precision, related-leak and order spread recorded on all 30 events |
| **3. Consolidation (offline)** | Retrieve, judge, consolidate and reconcile cores; in-memory graph store; snapshot judged; sweep; holdout check; membership audit | **Go/no-go gate:** R2, R3, R7 and R10 bars met on the chosen config (details below) |
| **4. Production wiring** | `/api/cluster` phase driver; database graph store; health checks; admin article, story and run pages; "doesn't belong" as constraints | A dry-run repair of the last 72h matches the offline replay; then 3 scheduled runs commit cleanly |
| **5. Repair and handoff** | Repair of the three examples and then the snapshot range; revert verified; golden-set list for story-summary-v1 | PRD acceptance criteria pass in production; 3 days unattended; story-summary-v1 unblocked |

### Phase 1 — Data foundations

Design: TDD parts 1, 2 and the data model in part 9. Nothing here changes how articles are grouped.

**Readiness items**

- [x] Create `feat/story-clustering-v2` from `main`; move the v2 docs (`prd.md`, `tdd.md`, `plan.md`) and the `docs/AGENTS.md` table edit there (2026-10-24, with the `docs/product/` and `docs/research/` restructure as its own commit)
- [ ] Probe jev version pinning: one `classify()` call with `model: "jev-1.14.0"` (needs a go-ahead; a fraction of a cent). Record whether it is accepted and what `model` comes back. If pinning is refused, follow the TDD fallback (key verdicts on the resolved version and rely on the `adjudicator_version` health check), and update the TDD
- [ ] Re-run the v1 reference comparison on jev 1.14.0 (`pnpm eval:compare`, 86 human reference pairs; needs a go-ahead). Record precision versus τ next to the 1.13.0 numbers in the v1 plan
- [ ] Reconcile the Drizzle migration journal with what's applied in production, so `db:migrate` won't replay 0001–0008. Record what was done
- [ ] Export `feed_items` (plus `story_assignments` and the human-label tables) before the migration. Agree with the owner where the export is stored

**Schema** (one migration, `pnpm db:generate` then `pnpm db:migrate`)

- [ ] `feed_items`: `excluded_reason`, `content_hash`, `current_version_id`, `embedding_version_id`, `pairs_version_id`, `first_published_at` (not null after backfill), `placed_at`, and the partial index on `first_published_at`
- [ ] New tables `article_versions`, `candidate_pairs`, `pair_verdicts`, `consolidation_runs`, `eval_events`, `eval_event_articles`, with the TDD's keys, indexes and canonical-order checks (`a < b`)
- [ ] `stories`: `status` allows `merged`; `merged_into`; check that `merged_into IS NOT NULL` exactly when `status = 'merged'`; the status trigger allows `open→closed`, `open→merged` and `closed→merged`, and lets revert runs undo a `merged`
- [ ] `story_assignments`: new `method` values (`consolidate`, `repair`, `revert`, `exclude`), `from_story_id`, `run_id`, `article_version_id`, `evidence`; the append-only trigger stays
- [ ] Data backfill in the same migration: one `article_versions` row per existing article from its current text; `current_version_id = embedding_version_id` (existing vectors were built from the only text we have); `first_published_at = coalesce(published_at, created_at)`; `placed_at = clustered_at`
  - [ ] Tests (local database): constraints reject impossible states (merged with no target, a pair with `a ≥ b`, a duplicate version hash); the status trigger allows only the listed transitions; the backfill gives every row a version and a `first_published_at`

**Ingest**

- [ ] `lib/live-blog.ts`: `isLiveBlog({ sourceId, link, title })` with the per-source rule table from the TDD
  - [ ] Tests: every production example in the TDD table matches; the known false positives (PBS `live-map-…`, Washington Examiner `live-grenade-…`) don't match; the title rule handles "Live:" and "Live updates –"
- [ ] `/api/ingest`: skip live blogs before the upsert; set `excluded_reason` when an existing row starts matching; compute `content_hash`; never update `first_published_at`; insert new versions and move `current_version_id` (the TDD's SQL)
  - [ ] Tests: unchanged text creates no version; a changed title creates one and moves `current_version_id`; a `published_at`-only change creates none; `first_published_at` survives a republish; a live blog is never inserted
- [ ] `scripts/exclude-live-blogs.ts`: marks existing matches `excluded_reason = 'live_blog'`, with `--dry-run` listing them per source. Spot-check 20 with the owner before running it for real. It doesn't touch stories; Phase 5's repair moves them out

**Embed and v1 compatibility**

- [ ] `/api/embed`: select rows whose vector is missing or stale (`embedding_version_id IS DISTINCT FROM current_version_id`), skip excluded rows, and write `embedding_version_id`
  - [ ] Tests: a changed version is re-embedded and the old vector is kept until the new one lands; excluded rows are never selected
- [ ] v1 `/api/cluster` (still live until Phase 4): skip excluded rows in pending selection and in kNN candidates; set `placed_at` on first assignment; use `first_published_at` as the article time
  - [ ] Tests: existing `cluster.test.ts` and `assign.test.ts` still pass; an excluded article is neither clustered nor a candidate
- [ ] Deploy, then apply the migration to production after the export
- [ ] After one week: count `article_versions` created per day by source (version churn, a TDD unknown), and record it here

### Phase 2 — Evaluation first

Design: TDD part 8. Builds the measurement the PRD requires (R1) and records v1 against it, before any clustering changes.

**Snapshot**

- [ ] `pnpm eval:snapshot --from 2026-10-17 --to 2026-10-24` → `eval/snapshot-2026-10-24.jsonl`, with each article's version id, `first_published_at`, `created_at` (for the replay's ingest ticks) and `excluded_reason`. Check that the three PRD example events are in it

**Event labelling**

- [ ] `pnpm eval:event-sample`: builds permissive clusters on the snapshot (connected components, cosine ≥ 0.85, within 36h) and draws 27 events at random, stratified 9 large (6+ outlets), 9 mid (3–5) and 9 small (2). Adds the 3 PRD examples, assigns `dev`/`holdout` by id hash (examples are `dev`), and writes the seeds into `eval_events` and `eval_event_articles` (the seed article as `in`)
- [ ] `/admin/events` list and `/admin/events/[id]` labelling page, behind `ADMIN_SECRET`: candidates within ±48h and cosine ≥ 0.70 of any `in` article, most similar first; `i` / `r` / `o` shortcuts; the definition pinned at the top; candidates widen as `in` articles are added; mobile-friendly like `/admin/audit` (follow [docs/design/](../../design/AGENTS.md))
  - [ ] Tests: candidate proposals widen after an `in`; labels write `eval_event_articles` with `labeler = 'human'`; unauthenticated requests are refused
- [ ] Extend `labels:export` / `labels:import` with `eval/events-YYYY-MM-DD.jsonl` (keyed by article `guid`)
  - [ ] Tests: export then import round-trips events and labels
- [ ] **Owner labels the 30 events**, including the call on CNBC's "tariffs 'replaced'" article. Export and commit the labels after each session

**Harness and baseline**

- [ ] `lib/eval/events.ts`: the metrics in the TDD's table (event recall per article and per outlet, split count, contamination split into `related`/`out`/unlabelled, pairwise precision/recall on v1 pairs plus derived event pairs, related-leak, retrieval recall), reported separately for `dev` and `holdout`
  - [ ] Tests on hand-built fixtures: a perfectly clustered event gives recall 1 and split 1; a 3-way split gives the expected recall; a `related` member counts as leak; derived pairs follow `in×in = same` and `in×related = related`
- [ ] `pnpm eval:events`: cron-tick simulation over the snapshot (6h ticks from `created_at`), `--orders N` with within-tick shuffle and ±1 tick jitter, and a dry run by default that prints unjudged calls and cost. A pluggable clustering strategy so v1's `assignArticle` and v2's consolidation run through the same harness
- [ ] v1 baseline: replay v1 (T_low 0.84, 12h, jev τ 0.93) on the new snapshot. Most verdicts aren't cached for this snapshot, so this needs a go-ahead. Record every metric, including order spread over 5 orders, in this plan

### Phase 3 — Consolidation (offline)

Design: TDD parts 3–6. Everything here is pure logic plus the in-memory store, measured on the snapshot. Production is unchanged.

**Cores**

- [ ] `lib/pipeline/consolidate-config.ts`: the config table from the TDD, and `pipelineVersion()` over it
- [ ] `lib/pipeline/retrieve.ts`: candidate pairs above `tLow` within `maxGapHours`, capped at `kMax`, canonical order, using `first_published_at`; a store interface for the database and in-memory versions
  - [ ] Tests: pairs are symmetric and deduplicated; the time gap and floor are respected; the cap keeps the most similar; excluded articles are never returned
- [ ] `lib/pipeline/judge.ts`: unjudged in-scope pairs → `adjudicate()` on `article_versions` text, `judgeConcurrency` parallelism, deadline-aware, writes `pair_verdicts`; human labels override (`same` → w = 1, `related`/`different` → cannot-link); stops before commit on a version mismatch
  - [ ] Tests (fakes): a cached verdict makes no call; a new version makes a new call; a human label wins over the model; a failed call leaves the pair unjudged; a resolved-version mismatch stops the run
- [ ] `lib/pipeline/consolidate.ts`: the pure `consolidate(graph, cfg)` with initial clusters (frozen, pinned, singletons), eligibility rules, anchors, `needPairs`, deterministic merge order, and `trace`
  - [ ] Tests: **R4 Alaska fixture** (a wrong member with low `w` to the rest doesn't block a correct article whose other pairs are high); **R5 Starlink fixture** (reaction pieces with `related` verdicts stay out); a cannot-link blocks a merge; the span cap blocks chaining across 48h; frozen clusters absorb but never merge with each other or lose members; pinned articles don't move; missing anchor pairs come back as `needPairs`; the same graph in a shuffled input order gives identical clusters
- [ ] `lib/pipeline/reconcile.ts`: the pure `reconcile(clusters, current)` with the three reader-safety rules, survivor choice, retired stories with `merged_into`, and per-move evidence
  - [ ] Tests: never-placed-only cluster → new story; old story plus unseen article → old story id (rule 1); two visible stories → the newer survives, the older is retired into it (rule 2); an evicted member gets its own story (rule 3); no story id is used twice; untouched articles produce no log rows
- [ ] `lib/pipeline/store-memory.ts` graph store and harness strategy wiring for v2 (densify rounds call the judge, then rerun `consolidate` from scratch)

**Measurement**

- [ ] Judge the snapshot at `tLow` 0.80, a superset of every swept floor (`pnpm eval:events --strategy v2 --t-low 0.80 --confirm`; needs a go-ahead). Verdicts land in `pair_verdicts` in the shared database and are reused by later sweeps and by the production repair
- [ ] Sweep on `dev`: `tLow`, `kMax`, `maxGapHours`, `maxSpanHours`, `tauLink`, `minJudged`, `maxDissent` over the TDD's ranges, all from cached verdicts. Record the grid's best configs with their metrics and cost per day
- [ ] Check the chosen config on `holdout`: holdout mean event recall within 0.05 of dev
- [ ] Order spread: `--orders 5` on the chosen config; max − min mean event recall ≤ 0.03
- [ ] Membership audit: `pnpm eval:audit --mode membership` samples 150 (member, anchor) pairs from the chosen replay into `/admin/audit` (new mode in `scripts/audit-sample.ts`); **owner labels them**; `pnpm eval:audit-score` reports precision and the exact 95% lower bound
- [ ] **Go/no-go gate.** Go only if every one of these holds on the chosen config:
  - Mean event recall ≥ 0.85 and ≥ 80% of events in ≤ 2 stories (R2), on the full set, and holdout within 0.05 of dev
  - The three PRD acceptance cases pass in the replay (Alaska: 11 outlets, no live blog; Canada: ≥ 9 outlets including the Washington Examiner; Starlink: DW and Ars in the main story, investigation pieces outside)
  - Membership-audit precision ≥ 0.95 with at most 2 errors in 150, and related-leak ≤ 10% (R3)
  - Order spread ≤ 0.03 (R7)
  - Estimated steady-state cost < $0.50/day including embeddings (R10)

  If the gate fails, stop and report the gap to the owner before changing the design. The levers already named in the TDD are retrieval recall (V13), `tLow`, `kMax` and the linkage thresholds; a TDD change comes before any further building.

### Phase 4 — Production wiring

Design: TDD part 9. Starts only after a "go" at the Phase 3 gate.

**Endpoint and stores**

- [ ] Database graph store (`lib/pipeline/store-db.ts`): load scope (active, context, frozen, pinned), load the judged-pair graph without embeddings, persist `candidate_pairs` and `pair_verdicts`, and apply reconcile changes in one transaction (moves, log rows with run id and evidence, retired stories, recomputed aggregates and centroids, `placed_at`, freeze sweep)
  - [ ] Tests (local database): a commit is all-or-nothing (a failure mid-commit leaves no partial moves); aggregates match the members afterwards; the log rows carry `from_story_id`, `run_id` and `article_version_id`
- [ ] `lib/pipeline/run.ts` phase driver: resume the newest uncommitted `consolidation_runs` row or start one; `retrieve → judge → consolidate (↔ judge for densify) → committed`; abandon after 6h; `processed`/`remaining` as in the TDD
  - [ ] Tests: a run split across several calls commits once; a deadline mid-judge resumes; an abandoned run is replaced and its verdicts reused; `remaining` reaches 0 only after commit
- [ ] `/api/cluster` switched to the phase driver behind the existing contract (lease, `400`/`401`/`409`/`500`, scoping params; `mode=backfill` = repair over the range)
  - [ ] Tests: existing `endpoint.test.ts` cases still pass against the new driver
- [ ] Health checks `consolidation_commit` and `adjudicator_version`; v1's cluster freshness reads committed runs
  - [ ] Tests: each new check fails on its own

**Admin (R8)**

- [ ] `/admin/articles/[id]`: versions, which version the vector and pairs came from, every judged pair per version with the other article's story at the time, and the assignment history with runs and evidence
- [ ] `/admin/stories/[id]`: per-member version and linkage evidence; "retired into" link for merged stories; run links
- [ ] `/admin/runs`: recent consolidation runs with stats and the revert command
- [ ] "Doesn't belong": label against the evidence's cross pairs, `manual` assignment as a pin
  - [ ] Tests: the action's labels become cannot-links and the article stays pinned in the next consolidation; R8 check: retitle an article in the test database, re-cluster, and confirm the page shows both versions and the text each decision used

**Cutover**

- [ ] `pnpm cluster:repair --from <now − 72h> --to <now> --dry-run` against production. Compare the planned stories with the Phase 3 replay for the overlapping days and review the planned moves with the owner
- [ ] Deploy; watch the first 3 scheduled runs (commit, moves per run, cost in `/admin/costs`, health). Record the results here

### Phase 5 — Repair and handoff

Design: TDD part 7.

- [ ] `scripts/cluster-repair.ts` and `scripts/cluster-revert.ts` per the TDD (dry run by default, shared `cluster` lease, live blogs moved out with `method = 'exclude'`)
  - [ ] Tests (local database): repair then revert restores memberships and story statuses exactly; revert refuses when a later run moved the same articles; human labels and manual rows are never written
- [ ] Revert rehearsal on a local copy of production data (from the Phase 1 export): repair the example range, revert, and diff memberships against the copy
- [ ] Repair the three example events (2026-10-20 to 2026-10-24): `--dry-run`, review the per-event preview with the owner, then `--confirm` (mostly cached verdicts; confirm spend if the dry run shows new calls)
- [ ] Verify the PRD acceptance criteria in production through `pnpm eval:events` against the database and in `/admin/stories`
- [ ] Repair the rest of the snapshot range (2026-10-17 to 2026-10-24), the same way
- [ ] `pnpm eval:events --golden`: list complete event stories for the story-summary-v1 golden set. Update [story-summary-v1 plan](../story-summary-v1/plan.md) to unpause and point at it, and add the card sort contract (sort by `stories.created_at`) to its TDD
- [ ] Exit: 3 days unattended with no failed runs, within budget; moves per run below 20% of active articles; record cost per day from `llm_calls`

## Not in this plan

- Lazy judging and a daily classifier call budget. These are cost levers discussed 2026-10-24, considered only if measured cost turns out to matter.
- Changing embeddings or embedding input (event-summary embeddings, entity weighting). Considered only if Phase 3's retrieval recall is the bottleneck (TDD V13).
- Repairing history before 2026-10-17.
- Reader-facing story cards and summaries ([story-summary-v1](../story-summary-v1/plan.md)).
