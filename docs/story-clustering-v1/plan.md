# Story Clustering v1 — Implementation Plan

Design, decisions, schema, contracts, and cost live in [tdd.md](tdd.md). This
document is the ordered build sequence and the single place implementation
status is tracked. The feature ends when clustering is wired up, monitored, and
measured; AI summaries and reader-facing changes are a follow-on in
[story-summary-v1](../story-summary-v1/plan.md). Phases 1–3 carry most of the
risk and change nothing users see.

## Readiness

Checked 2026-09-27 against the live environment (eval data, volume, and prices re-checked 2026-10-03):

| Check | Status |
|---|---|
| pgvector on Supabase | ✅ Available (v0.8.2, Postgres 17.6). Not yet installed; Phase 1 installs it |
| `GOOGLE_GEMINI_API_KEY` | ✅ Valid. `gemini-embedding-2` returned 768-dim unit vectors on both the native and OpenAI-compatible endpoints (verified 2026-10-03); `gemini-3.5-flash-lite` answered via the OpenAI-compatible endpoint |
| `OPEN_ROUTER_API_KEY` | ✅ Valid. Accepted a paid-model request; key limit $100, $0 used |
| Next 16 conventions | ✅ Checked. Admin gating uses `proxy.ts` (not `middleware.ts`) |
| Product decisions | ✅ All locked (see TDD) |
| Eval data | ✅ 6,200 rows from all 31 sources, ingested 2026-09-27 to 2026-10-03. Full days: 2026-09-29 to 2026-10-02 (~950–1,240 articles/day, ~4,300 total), which meets the ≥ 4-day gate. 9/27 is partial and 9/28 is nearly empty (the cron's redirect bug, fixed 2026-09-29), so the snapshot starts at 2026-09-29. Volume is ~1,000 articles/day, not the 150–400 first assumed |
| Gemini billing tier | ✅ **Free tier** (confirmed). Expect per-minute and per-day request caps; the exact limits are looked up in Phase 1. Prompts may be used for training, which is fine for public news |
| Model prices | ✅ Looked up 2026-10-03 (see the TDD's LLM client section). Enter them in the config price table in Phase 1 |
| Supabase backups | ⚠️ Checked 2026-10-04: the org is on the **free plan**, which has no downloadable or point-in-time backups (paid plans add daily backups). `feed_items` can't be re-fetched from the feeds, so Phase 1 adds a periodic export |

**Verdict: ready to execute.** Confirmed 2026-09-27: free tier, defaults
approved (opinion/analysis = same story, 36h window, ship-bar numbers), and
label-review time committed. Nothing is gated on time: the ≥ 4 days of
ingestion needed for the Phase 2 snapshot exist as of 2026-10-02.

## Phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **1. Foundations** | Migration workflow + pgvector; full schema with constraints and triggers; `lib/text.ts`; `lib/llm.ts` with the failure policy; lease and run-record helpers; embed stage logic + backfill script | All rows embedded; costs visible in `llm_calls`; invalid states rejected by the database |
| **2. Baseline clustering** | Embedding-only assignment with window-fit candidates; snapshot; admin auth + labeling UI; label export/import; silver labels; replay harness; open-risk spikes (prefix, filtered kNN, promo filter) | Baseline P/R/related-leak recorded |
| **3. LLM adjudication** | Gray-zone step + verdict cache; sweep thresholds + window | Meets clustering ship bar on snapshot |
| **4. Wire it up** | `/api/embed`, `/api/cluster`, and `/api/health` per the TDD contracts; workflow with loud failure; stories inspector, cost panel, pipeline health panel | 3 days unattended, no failed runs, within budget, a stall is caught |

### Phase 1 — Foundations

**Test setup**

- [x] Add a test runner (for example Vitest) and a `pnpm test` script; the repo has none today (`tsx` is already a dev dependency)
- [x] Set up a test database for the constraint, trigger, lease, and pipeline tests, separate from the production Supabase database (for example local Postgres with pgvector, or a separate Supabase project or branch) (local Postgres 17 + pgvector via Homebrew, database `better_news_test`; `TEST_DATABASE_URL` overrides; tests refuse non-local hosts)

**Migrations and schema**

- [x] Switch from `db:push` to `db:generate` + `db:migrate`; add a custom SQL migration for `create extension if not exists vector` (baseline migration `0000` is idempotent so it is a no-op on the existing production table; not yet applied to production)
- [x] Add schema: new `feed_items` columns (`embedding vector(768)`, `embedding_model`, `embedding_input_version`, `embed_attempts`, `embed_error`, `embed_next_attempt_at`, `story_id`, `clustered_at`, `canonical_link`) + HNSW index (`vector_cosine_ops`); `stories` with btrees on `(status, window_ends_at)` (close sweep) and `(first_article_at, last_article_at)` (window fit), and no index on `centroid`; `story_assignments`; `llm_calls`; `eval_pair_labels`; `pipeline_locks`; `pipeline_runs`
- [x] Add database invariants (D24): `CHECK` constraints on `feed_items` (`clustered_at IS NULL OR (embedding IS NOT NULL AND story_id IS NOT NULL)`; `embedding IS NULL OR (embedding_model IS NOT NULL AND embedding_input_version IS NOT NULL)`) and `stories` (`status IN ('open','closed')`; `first_article_at <= last_article_at`; `window_ends_at >= last_article_at`); a trigger that rejects `closed` → `open`; a trigger that rejects `UPDATE` and `DELETE` on `story_assignments`
  - [x] Tests: each violating insert/update is rejected; a closed story can't be reopened; `story_assignments` rows can't be updated or deleted
- [~] Check what backups the Supabase plan provides for `feed_items`; if limited, add a periodic `feed_items` export Finding: free plan, no backups. Remaining: build the periodic `feed_items` export (not started; decide where it is stored)

**Text and LLM client**

- [x] `lib/text.ts`: HTML/entity stripping, whitespace collapse, boilerplate removal, canonical-link dedupe
  - [x] Tests: HTML/entities, boilerplate strings ("Continue reading…", "The post X appeared first on Y"), utm stripping, same article in two feeds dedupes
- [x] `lib/llm.ts`: `chat` + `embed` (embeddings via the OpenAI-compatible endpoint with `dimensions: 768`, up to 100 inputs per request, 25 by default), `llm_calls` row per call, OpenRouter fallback for chat, verdict cache (verdict cache is stored on `llm_calls` as `cache_key` + `response`)
- [x] `lib/llm.ts` failure policy (D23): timeouts (20s embedding, 30s chat), retries (up to 4 attempts, exponential backoff with jitter, bounded by the time left before the deadline), a per-provider, per-run circuit breaker (opens after 3 consecutive failures; chat falls back to OpenRouter; an embedding run ends early), and a batch is never dropped silently (retried, or its rows stay unprocessed for the next run)
  - [~] Tests: retry/backoff with jitter stays within bounds; the breaker opens after 3 consecutive failures and then fails fast; chat falls back and the fallback is logged; embedding ends the run early with rows left unprocessed (`embedding` null); no new batch starts after the deadline; cost computed from the price table; a cache hit makes no call (done except "embedding ends the run early with rows left unprocessed", which is covered in the embed stage tests)
- [~] Look up the AI Studio free-tier request limits for `gemini-embedding-2` and `gemini-3.5-flash-lite`; compare with ~1,000 embeds and ~200–350 adjudication calls/day Google no longer publishes the numbers in its docs; they are only shown in the AI Studio rate-limit dashboard, so the user needs to read them there
- [x] Fill the config price table with the prices in the TDD (`gemini-embedding-2`, `gemini-3.5-flash-lite`)

**Pipeline plumbing**

- [x] Single-flight lease helper (D22) on `pipeline_locks`: take, extend after each batch, release, expires on its own
  - [x] Tests: a second take while held is refused; an expired lease can be taken; the lease is extended per batch
- [x] `pipeline_runs` recorder: one row per run (stage, started/finished, processed, remaining, failed, error)

**Embedding (the `/api/embed` stage logic, D27)**

- [x] `lib/pipeline/embed.ts`: select ingested rows (`embedding IS NULL`, `embed_next_attempt_at` null or past, oldest first), build the input `"task: clustering | query: " + title + "\n\n" + cleanSummary.slice(0, 1000)`, embed in batches of 25 with `gemini-embedding-2`, and write `embedding`, `embedding_model`, and `embedding_input_version` in one `UPDATE` per batch; a batch that exhausts its retries sets `embed_attempts + 1`, `embed_error`, and `embed_next_attempt_at = now() + min(1h × 2^attempts, 12h)`; rows with 5 attempts are left out
  - [x] Tests: a successful batch writes all three columns; a failing batch increments attempts, records the error, and sets the next attempt without affecting other batches; a row with 5 attempts is not selected; a row whose next attempt is in the future is not selected; re-running is a no-op
- [~] Embed backfill script that runs this logic over all existing rows (`pnpm embed:backfill`, written and smoke-tested against the test database; not yet run against production, which first needs the migrations applied)
- [ ] Exit: all rows embedded; costs visible in `llm_calls`; invalid states rejected by the database

### Phase 2 — Baseline clustering

The snapshot uses full ingestion days from 2026-09-29 onward (earlier days are partial or have a gap; see Readiness).

**Assignment**

- [x] `lib/pipeline/*`: embedding-only assignment (reads only embedded rows whose `embedding_model` matches the configured model, and never calls the embedding API), window-fit candidates (`last_article_at − 36h ≤ published_at ≤ first_article_at + 36h`, open or closed stories), max-member + centroid scoring, earlier-than-anchor handling, close sweep
  - [x] Tests: a later article within 36h of `first_article_at` joins and one beyond it doesn't; a first-to-last span never exceeds 36h; chaining case (A~B, B~C, A≁C) does not merge; a late article that fits a closed story joins it; an article earlier than `first_article_at` joins and moves the anchor back only if every member still fits, otherwise starts a new story; centroid running mean; an older article that is embedded and clustered after newer ones still joins the right story (out-of-order arrival, D28); rows embedded with a different model are ignored

**Admin and labeling**

- [ ] `ADMIN_SECRET` in `.env.example`, local `.env`, Vercel; `proxy.ts` gate + sign-in page; re-check in every admin action and route
  - [ ] Tests: unauthenticated request to an admin route is rejected even when the proxy is bypassed
- [ ] Labeling UI (`s` / `r` / `d` / `u`, definition pinned)
- [ ] `scripts/export-labels.ts` and a matching import script (D26): export `eval_pair_labels` and `manual` assignments, keyed by article `guid`, to `eval/labels-YYYY-MM-DD.jsonl`
  - [ ] Tests: export then import into an empty database restores the same labels and manual assignments

**Evaluation**

- [ ] `scripts/snapshot.ts` → `eval/snapshot-YYYY-MM-DD.jsonl`
- [ ] Generate ~300 stratified pairs (oversample likely `related`); silver-label via OpenRouter; human review of disagreements + ~50 random; export the labels
- [ ] `pnpm eval:cluster` replay harness: pairwise P/R/F1, related-leak, LLM-band %, cost per 100 articles, worst merges/splits
  - [ ] Tests: metrics on a tiny hand-built labeled fixture, with `related` counted as negative

**Open-risk spikes**

- [ ] Compare embeddings with and without the `task: clustering | query: ` prefix on the labeled snapshot, and confirm the exact format against Google's docs
- [ ] Check whether the window-filtered kNN stays accurate and fast at scale using pgvector 0.8 iterative index scans (`hnsw.iterative_scan`) on a large sample
- [ ] Check how many promo/advertorial articles (e.g. sportsbook bonus-code posts) appear in the snapshot; add a noise filter or exclusion rule if they form fake stories
- [ ] Measure the real share of articles landing in the LLM band

- [ ] Exit: baseline P/R/related-leak recorded

### Phase 3 — LLM adjudication

- [ ] Adjudication prompt with the "same story" definition verbatim; JSON schema output; join only on `same` with confidence ≥ 0.7
- [ ] Thin-article rule: no embedding-only auto-join
- [ ] Verdict cache so sweeps don't pay twice
  - [ ] Tests: thin article above `T_low` always routes to the LLM; invalid JSON or low confidence yields a new story
- [ ] Sweep `T_low`, `T_high` (include values up to ~0.94, since 0.88 admitted some different-event pairs in early testing), and the window; pick the cheapest config that meets the bar
- [ ] Exit: precision ≥ 0.95, recall ≥ 0.80, related-leak ≤ 10%, < $0.50/day on the snapshot

### Phase 4 — Wire it up

**Endpoints**

- [ ] `/api/embed` per the TDD contract: runs the Phase 1 embed logic, takes the `embed` lease and returns `409 { status: "busy" }` if held, records a `pipeline_runs` row, stops starting batches at the deadline (`maxDuration` minus a 10s margin), and returns `{ processed, remaining, failed, durationMs }`; `400` on invalid params, `401` on a bad secret, `500 { error }` on failure
- [ ] `/api/cluster` per the TDD contract: same lease, run-record, deadline, and error behavior with the `cluster` lease, processing embedded rows oldest-first
- [ ] Optional scoping parameters on both endpoints: `source`, `from`/`to`, and `mode=backfill` (lower concurrency; for `/api/cluster`, close sweep deferred until `remaining = 0`)
  - [ ] Tests: re-running a batch is a no-op; stopping mid-run and resuming gives the same result; two overlapping runs of the same endpoint, the second gets `409`; `embed` and `cluster` can run at the same time; `source` and `from`/`to` limit which rows are processed; invalid params return `400`; backfill mode processes oldest-first and runs the close sweep only at the end; `/api/cluster` still clusters embedded rows while `/api/embed` is failing
- [ ] `/api/health` per the TDD contract: ingest freshness, embed freshness, cluster freshness, and backlog age (each under 12h), plus no stuck rows (`embed_attempts` below 5), as `{ ok, checks: [{ name, ok, detail }] }`; `503` when any check fails
  - [ ] Tests: each check fails independently when its threshold is exceeded; `401` without the secret

**Workflow**

- [ ] Update the GitHub Actions workflow: after ingest, call `/api/embed` and then `/api/cluster`, each in a loop until `remaining = 0` (cap 50 iterations), end a loop quietly on `409 busy`, fail the job on any other non-2xx but still run the cluster step if embed failed (`if: always()`), then call `/api/health` and fail the job on `503`; keep `curl -sfL`

**Admin tooling**

- [ ] Stories inspector, "doesn't belong" action (records a label and a `manual` assignment), cost panel
- [ ] Pipeline health panel: per-stage last run (time, status, processed, failed), row counts by state (ingested, embedded, clustered), age of the oldest unprocessed article, stuck-row count, open-story count, 429 and fallback counts
  - [ ] Tests: the "doesn't belong" action writes both the label and the `manual` assignment

**Verification**

- [ ] Verify a stall is caught: with thresholds temporarily lowered, confirm `/api/health` returns `503` and the workflow step fails
- [ ] Exit: 3 days unattended, no failed runs, within budget

## Not in this plan

- Running a backfill or adding sources. The runbook is in the [TDD](tdd.md#backfill-and-adding-sources); only the endpoint parameters it needs are built here.
- Re-clustering existing stories (for example after switching embedding models).
- AI summaries and any reader-facing change. These are in [story-summary-v1](../story-summary-v1/plan.md).
