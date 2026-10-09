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
| Product decisions | ✅ All locked (see TDD). Revised 2026-10-05 after the labeling session: stricter definition with opinion and analysis as `related`, embeddings only retrieve candidates, 12h window, recall has no bar (TDD D31–D37) |
| `OPENAI_API_KEY` | ✅ Valid. Used for the `gpt-4o-mini` silver labels 2026-10-05 |
| `JEV_API_KEY` | ⚠️ Added to the local `.env` 2026-10-05; not yet verified with a call. TypeSafe's API shape and pricing page still to read |
| Eval data | ✅ 6,200 rows from all 31 sources, ingested 2026-09-27 to 2026-10-03. Full days: 2026-09-29 to 2026-10-02 (~950–1,240 articles/day, ~4,300 total), which meets the ≥ 4-day gate. 9/27 is partial and 9/28 is nearly empty (the cron's redirect bug, fixed 2026-09-29), so the snapshot starts at 2026-09-29. Volume is ~1,000 articles/day, not the 150–400 first assumed |
| Gemini billing tier | ✅ **Moved to the paid tier 2026-10-05** (API key capped at $5). The free tier was too small for embeddings: `gemini-embedding-2` allows 1,000 inputs/day (each input in a batch counts), about our whole daily volume, so the backlog would have taken ~7 days. `GEMINI_TIER=paid` is set locally (it turns off client-side pacing); it also has to be set on Vercel when `/api/embed` ships in Phase 4. Approved uses: embeddings now; `gemini-3.5-flash-lite` only with the user's go-ahead. Prompts may be used for training on the free tier, which is fine for public news |
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
| **3. LLM adjudication** | Public development data; adjudicator comparison (gpt-4o-mini, flash-lite, jev); classifier decides every join; verdict cache; sweep `T_low`, τ, window; join audit | Precision ≥ 0.95 on the join audit and the human reference pairs, related-leak ≤ 10%, < $0.50/day; recall reported |
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
- [x] Enable row level security on all 8 public tables (migration `0007_enable_rls`, `.enableRLS()` in `db/schema.ts`; applied to the shared database 2026-10-06 to clear the Supabase `rls_disabled_in_public` advisor). No policies: the app connects as `postgres` (bypasses RLS), so only the Supabase Data API (`anon`/`authenticated`) is locked out. Table grants to `anon`/`authenticated` were left as they were
- [~] Check what backups the Supabase plan provides for `feed_items`; if limited, add a periodic `feed_items` export Finding: free plan, no backups. Remaining: build the periodic `feed_items` export (not started; decide where it is stored)

**Text and LLM client**

- [x] `lib/text.ts`: HTML/entity stripping, whitespace collapse, boilerplate removal, canonical-link dedupe
  - [x] Tests: HTML/entities, boilerplate strings ("Continue reading…", "The post X appeared first on Y"), utm stripping, same article in two feeds dedupes
- [x] `lib/llm.ts`: `chat` + `embed` (embeddings via the OpenAI-compatible endpoint with `dimensions: 768`, up to 100 inputs per request, 25 by default), `llm_calls` row per call, OpenRouter fallback for chat, verdict cache (verdict cache is stored on `llm_calls` as `cache_key` + `response`)
- [x] `lib/llm.ts` failure policy (D23): timeouts (20s embedding, 30s chat), retries (up to 4 attempts, exponential backoff with jitter, bounded by the time left before the deadline), a per-provider, per-run circuit breaker (opens after 3 consecutive failures; chat falls back to OpenRouter; an embedding run ends early), and a batch is never dropped silently (retried, or its rows stay unprocessed for the next run)
  - [~] Tests: retry/backoff with jitter stays within bounds; the breaker opens after 3 consecutive failures and then fails fast; chat falls back and the fallback is logged; embedding ends the run early with rows left unprocessed (`embedding` null); no new batch starts after the deadline; cost computed from the price table; a cache hit makes no call (done except "embedding ends the run early with rows left unprocessed", which is covered in the embed stage tests)
- [x] Look up the AI Studio free-tier request limits for `gemini-embedding-2` (100 inputs/min, 30k tokens/min, 1,000 inputs/day; settled by the usage ledger 2026-10-05, see the TDD). Still to look up: `gemini-3.5-flash-lite` (needed for Phase 3)
- [x] Fill the config price table with the prices in the TDD (`gemini-embedding-2`, `gemini-3.5-flash-lite`)

**Pipeline plumbing**

- [x] Single-flight lease helper (D22) on `pipeline_locks`: take, extend after each batch, release, expires on its own
  - [x] Tests: a second take while held is refused; an expired lease can be taken; the lease is extended per batch
- [x] `pipeline_runs` recorder: one row per run (stage, started/finished, processed, remaining, failed, error)

**Embedding (the `/api/embed` stage logic, D27)**

- [x] `lib/pipeline/embed.ts`: select ingested rows (`embedding IS NULL`, `embed_next_attempt_at` null or past, oldest first), build the input `"task: clustering | query: " + title + "\n\n" + cleanSummary.slice(0, 1000)`, embed in batches of 25 with `gemini-embedding-2`, and write `embedding`, `embedding_model`, and `embedding_input_version` in one `UPDATE` per batch; a batch that exhausts its retries sets `embed_attempts + 1`, `embed_error`, and `embed_next_attempt_at = now() + min(1h × 2^attempts, 12h)`; rows with 5 attempts are left out
  - [x] Tests: a successful batch writes all three columns; a failing batch increments attempts, records the error, and sets the next attempt without affecting other batches; a row with 5 attempts is not selected; a row whose next attempt is in the future is not selected; re-running is a no-op
- [x] Embed backfill script that runs this logic over all existing rows (`pnpm embed:backfill`; run against production 2026-10-05 after moving to the paid tier: all 7,544 rows embedded, 0 failed batches, ~$0.13)
- [x] Exit: all rows embedded; costs visible in `llm_calls`; invalid states rejected by the database

### Phase 2 — Baseline clustering

The snapshot uses full ingestion days from 2026-09-29 onward (earlier days are partial or have a gap; see Readiness).

**Assignment**

- [x] `lib/pipeline/*`: embedding-only assignment (reads only embedded rows whose `embedding_model` matches the configured model, and never calls the embedding API), window-fit candidates (`last_article_at − 36h ≤ published_at ≤ first_article_at + 36h`, open or closed stories), max-member + centroid scoring, earlier-than-anchor handling, close sweep
  - [x] Tests: a later article within 36h of `first_article_at` joins and one beyond it doesn't; a first-to-last span never exceeds 36h; chaining case (A~B, B~C, A≁C) does not merge; a late article that fits a closed story joins it; an article earlier than `first_article_at` joins and moves the anchor back only if every member still fits, otherwise starts a new story; centroid running mean; an older article that is embedded and clustered after newer ones still joins the right story (out-of-order arrival, D28); rows embedded with a different model are ignored

**Admin and labeling**

- [~] `ADMIN_SECRET` in `.env.example`, local `.env`, Vercel; `proxy.ts` gate + sign-in page; re-check in every admin action and route (done: `.env.example`, local `.env`, `proxy.ts` gate, sign-in page, `requireAdmin()` on pages and actions; remaining: set `ADMIN_SECRET` on Vercel, which is the user's call)
  - [x] Tests: unauthenticated request to an admin route is rejected even when the proxy is bypassed
- [x] Labeling UI at `/admin/label` (`s` / `r` / `d` / `u`, definition pinned, `h` shows the model's call, modes: review / unlabeled / all; labels save to `eval_pair_labels` as labeler `human`). Verified through the page render and unit tests; not yet used by a person
- [x] Clustering explorer at `/admin/explore` (added 2026-10-05, not in the original plan): replays the snapshot at any `T_low`, `T_high`, window, and gray-zone handling with no API calls; shows summary stats, a score histogram, stories (most suspicious first), gray-zone articles with their best candidate story, and title search. Local-only: it reads the gitignored snapshot file
- [~] `scripts/export-labels.ts` and a matching import script (D26): export `eval_pair_labels` and `manual` assignments, keyed by article `guid`, to `eval/labels-YYYY-MM-DD.jsonl` Done for `eval_pair_labels` (`pnpm labels:export` / `pnpm labels:import`, tested). Remaining: `manual` assignments, which have no producer until the Phase 4 "doesn't belong" action
  - [~] Tests: export then import into an empty database restores the same labels and manual assignments (pair labels only)

**Evaluation**

- [x] `scripts/snapshot.ts` → `eval/snapshot-YYYY-MM-DD.jsonl` (run 2026-10-05: 6,301 articles from 2026-09-29, 28 sources, 287 thin; the ~64 MB file is gitignored and rebuildable)
- [~] Generate ~300 stratified pairs (oversample likely `related`); silver-label with OpenAI `gpt-4o-mini`; human review of disagreements + ~50 random; export the labels. Done: `pnpm eval:pairs` wrote `eval/pairs-2026-10-05.jsonl` (300 pairs: 60 merged, 60 related, 40/50/50/40 across the 0.6/0.7/0.8/0.9 buckets; cross-outlet pairs only). Silver labels done 2026-10-05 (`pnpm eval:silver`, prompt v1 with the verbatim definition, OpenAI `gpt-4o-mini` at temperature 0): 300 pairs, 0 failures, $0.028; verdicts 170 different / 72 same / 58 related. Per category: every pair below 0.8 similarity is `different`; the 60 baseline-merged pairs split 35 same / 25 related; sim90 is 30 same / 10 related; sim80 is 7 same / 23 related / 20 different. Review queue is 94 pairs (44 where silver and baseline disagree, plus 50 random). Human review done 2026-10-06: all 94 queued pairs labeled (42 related, 36 different, 16 same) and exported to `eval/labels-2026-10-06.jsonl` (94 human + 300 silver rows). Silver vs human: 71/94 exact, 84% on the 50 random checks; silver over-calls `same` (15 pairs the user judged `related`) Human review and export remain
- [x] `pnpm eval:cluster` replay harness: pairwise P/R/F1, related-leak, LLM-band %, cost per 100 articles, worst merges/splits (cost per 100 articles is added in Phase 3 with the adjudicator; the baseline makes no LLM calls)
  - [x] Tests: metrics on a tiny hand-built labeled fixture, with `related` counted as negative

**Open-risk spikes**

- [x] Compare embeddings with and without the `task: clustering | query: ` prefix on the labeled snapshot, and confirm the exact format against Google's docs. Format confirmed 2026-10-05 (docs: `task: clustering | query: {content}`; `task: sentence similarity | query: {content}` is the other symmetric option; no `task_type` field on this model). The 537 pair articles are embedded under three variants (none, clustering, similarity) into the gitignored `eval/prefix-spike-embeddings.json` (~$0.03); `pnpm eval:prefix eval` found no difference on the 300 labeled pairs: AUC 0.941 (none), 0.939 (clustering), 0.940 (similarity), so the current prefix stays and no re-embed is needed
- [x] Check whether the window-filtered kNN stays accurate and fast at scale using pgvector 0.8 iterative index scans (`hnsw.iterative_scan`) on a large sample. Done 2026-10-05 (`pnpm eval:knn`, 100k rows over 100 days in a scratch local database, 150 queries): default HNSW returns only 3.3 of 10 rows (recall@10 0.325); `relaxed_order` gives recall 0.987 at ~10 ms p50; `ef_search` 200 gives 1.000 at ~14 ms; exact search is ~20 ms. Fix applied in `lib/pipeline/store-db.ts` (`set_config('hnsw.iterative_scan', 'relaxed_order', true)` per candidate query, tested). Real-history timing beyond 100k rows is unmeasured
- [x] Check how many promo/advertorial articles (e.g. sportsbook bonus-code posts) appear in the snapshot; add a noise filter or exclusion rule if they form fake stories. Done 2026-10-05 (`pnpm eval:promo`): 36 of 6,301 articles (0.6%), 32 from `fox-latest` and 4 from `nypost`; they form 4 (at `T_high` 0.88) to 6 (0.92) stories that contain only promo articles. Low impact; no rule added. A title-pattern exclusion at the cluster stage is cheap if the user wants those out of stories
- [~] Measure the real share of articles landing in the LLM band. First measurement (conservative baseline, snapshot of 6,301): 59.5% at `T_low` 0.75 / `T_high` 0.88 and 73.6% at `T_high` 0.92, versus the 20–35% estimate. Re-measure after tuning and with the labeled sweep

- [x] Exit: baseline P/R/related-leak recorded 2026-10-06 on 300 pairs (human labels win over silver; precision is pessimistic because the pairs are stratified toward hard cases): `T_high` 0.88 / `T_low` 0.75 / 36h: P 61.7%, R 93.5%, related-leak 50.8%; `T_high` 0.92: P 74.0%, R 59.7%, leak 20.0%; single threshold 0.92 with a 12h window: P 78.6%, R 35.5%, leak 9.2%; 0.95: P 83.3%, R 8.1%. No embedding-only configuration reaches the bar (P ≥ 0.95, R ≥ 0.80), so the LLM decides joins in Phase 3

### Phase 3 — LLM adjudication

Design: TDD D31–D37 (2026-10-05). Embeddings only find a candidate story; a classifier decides every join by comparing the article with the story's first article and its most similar member; window 12h; precision is confirmed by a join audit.

**Decisions and docs**

- [x] User approved 2026-10-05: the stricter "same story" wording, opinion and analysis as `related`, no embedding-only joins, a 12h window, no recall bar, public datasets for development data, and the adjudicator comparison (including spend on the 94 human-labeled pairs). TDD updated (D4 and D6 superseded; D31–D37 added; risks, costs, and open questions revised)

**Development data**

- [x] Show the user the 8 human `same` pairs more than 12h apart. The timestamps are real (published times, gaps 14–32h); the pairs were follow-ups or reactions under D31, so the user removed those 8 human labels (file and database). Silver labels (3 `same`, 5 `related`) now apply to them
- [~] `pnpm eval:semeval` (`scripts/semeval-fetch.ts`, `lib/eval/semeval.ts`): downloads the Zenodo CSVs (2,036 English pairs), fetches pages from the Internet Archive links, writes `eval/public/semeval-pairs.jsonl`; resumable, 429s never cached. Built and unit-tested, but not run: the Internet Archive returned 429 to this IP after a 20-pair test. Left: retry later with `--concurrency 1` and record how many pairs survive dead links
- [x] `pnpm eval:wcep` (`scripts/wcep-convert.ts`, `lib/eval/wcep.ts`) from the user-supplied extract in `wcep-extracted-download/` (gitignored): editor-cited articles only, junk filter (non-English, boilerplate, social and bulletin hosts, truncated titles), within-event pairs as `same`, same-day same-category different-event pairs as `different`. 3,410 pairs (1,705 each). Per-article `time` is unreliable, so articles carry the WCEP event day and WCEP cannot test the 12h window
- [~] Spot-check against D31. WCEP done (2 samples of 20 `same` pairs): after the junk filter about 75% clean, 20% borderline (reactions and follow-ups), 5% wrong (bundled events). The user agreed to use WCEP `same` as a noisy positive set for development only; disagreements are reviewed by hand, not counted as adjudicator errors. Left: SemEval cut points (provisional: `same` ≤ 1.5, `different` ≥ 3.5, middle dropped)
- [ ] Re-make the silver labels for the 206 pairs without a human label using the D31 prompt (~$0.03; needs a cost go-ahead)

**Adjudicator**

- [x] Read TypeSafe's API docs; added the `jev` provider: `llm.classify({ state, questions })` posts typed questions to `POST https://api.typesafe.ai/v1/systemone` with `JEV_API_KEY`, records the resolved model (e.g. `jev-1.13.0`) and cost ($0.042 per 1M input tokens, output free), caches by key, retries 429/5xx/529, no fallback to another provider. Unit-tested with fakes; no live call made yet (needs a go-ahead, a fraction of a cent). `gpt-4o-mini` was already in the price table
- [ ] Look up the `gemini-3.5-flash-lite` rate limits (carried over from Phase 1)
- [x] `adjudicate({ article, member })` wrapper (`lib/pipeline/adjudicate.ts`) returning `{ relation, pSame, reason? }` for the configured adjudicator; prompt v2 with the D31 definition verbatim; chat models use strict JSON `{ relation, p_same, reason }`
- [x] Verdict cache keyed on the unordered article pair plus model and prompt version (`cacheKey()`, stored on the `llm_calls` row via the existing `cacheKey` support in `chat()` and `classify()`), so sweeps don't pay twice
  - [~] Tests (fakes, no spend), `lib/pipeline/adjudicate.test.ts`: invalid output is a rejection; the cache key is order-independent and tied to model and prompt version; a failed call propagates; jev and chat routing. A cache hit making no call is covered in `lib/llm.test.ts` for both `chat()` and `classify()`. Left: "a fallback never switches model" is already true by construction (chat falls back only to the same model ID through OpenRouter); add an explicit assertion when the assignment step is wired
- [x] Classifier comparison (`pnpm eval:compare`, run 2026-10-06 on the 86 human reference pairs and 400 WCEP pairs, prompt v2, $0.196 for 1,458 calls). Reference (8 `same`): `gpt-4o-mini` says `same` on 25 pairs, 17 wrong, and its `p_same` saturates at 0.9+ so τ cannot help (precision 32% at τ ≤ 0.90); flash-lite says `same` on 18, 11 wrong, with `p_same` ≥ 0.95 on all of them; jev's probabilities discriminate: precision 83% at τ 0.90 and 100% at τ ≥ 0.93 (4 joins, recall 50%). WCEP is not discriminative (every model 96–98% precision at any τ; its negatives are easy), so it cannot pick τ. The wrong `same` calls are mostly arcs of one big event (the Flydubai incident, Pike's execution) that the user labels `related`. The two-model agreement adds nothing over jev alone. Leading candidate: jev at τ ≈ 0.93, to be validated by replay and the join audit (the reference set is too small, 8 positives, to bound precision)
- [x] Pick the adjudicator and τ: jev at τ 0.93 (provisional). Snapshot replay 2026-10-06 (T_low 0.84, 12h, 6,301 articles): 3,123 articles (49.6%) reached the classifier, 3,355 calls, $0.092 ($0.001 per 100 articles), 0 failed or unreadable; 5,448 stories (853 articles joined). On the 300 labeled pairs: precision 100% on only 9 merged pairs (exact 95% lower bound 71.7%, not the ship number), recall 15.8%, related-leak 0%. Recall is low by design (no bar); the ship precision comes from the join audit. Original item: confirm on the reference pairs, where human labels win over public data

**Assignment**

- [x] `lib/pipeline/assign.ts`: remove the `tHigh` auto-join; `tLow` 0.84 and `windowHours` 12 as defaults; adjudicate the best candidate against its first article and its most similar member (one call when they are the same article); join only if both are `same` with `p_same ≥ τ`; otherwise a new story; a call that fails after retries leaves the article unclustered; log both verdicts in `story_assignments`
  - [x] Tests (`assign.test.ts`, `cluster.test.ts`): nothing joins without the classifier; one call when the first article is also the most similar member; a single `related` verdict blocks the join; `p_same` below τ starts a new story; a failure leaves the article unclustered; thin articles go through the same path; a 12h window blocks a join at 13h
- [x] Replay harness (`pnpm eval:cluster`): `--adjudicator <model>`, `--tau`, `--max-calls`, `--confirm`. Without `--confirm` it is a dry run that spends nothing and prints the calls and cost estimate (measured on the 2026-10-05 snapshot at T_low 0.84 and 12h: 3,162 of 6,301 articles reach the classifier, about 436 input tokens per call, so 3,162–6,324 calls, $0.32–0.64 for `gpt-4o-mini` and $0.06–0.12 for jev, before the verdict cache). With `--confirm` it reports the classifier share, calls, cache hits, unreadable and failed calls, cost per 100 articles, thin-article precision, and an exact 95% lower bound on precision (`lib/eval/stats.ts`, `lib/eval/adjudicator.ts`). A failed call leaves the article unclustered and the replay continues; an exhausted call budget stops it. `tHigh` and the explorer's T_high slider removed; `scripts/spike-promo.ts` deleted. Not run live yet (needs a go-ahead)
- [ ] K control in the explorer and harness (kNN slot dominance, TDD risk); compare K = 10 with 30–50 on recall

**Tuning and audit**

- [ ] Sweep `T_low` (0.80–0.88), τ, and the window (12, 18, 24, 36h); keep 12h unless a longer window keeps precision ≥ 0.95; re-measure the share of articles reaching the classifier
- [x] Join-audit queue: built as `/admin/audit` (database-backed, mobile-first, behind the admin gate; `lib/audit.ts`, `app/admin/audit/`) instead of a `/admin/label` queue, because `/admin/label` reads repo files that do not exist on Vercel. New table `join_audit_items` (migration `0006`, applied to the shared database 2026-10-06). `pnpm eval:audit` samples joins from a cached-verdict replay (no model calls): 150 of the 853 joins from jev τ 0.93, T_low 0.84, 12h, written as `join-audit-2026-10-06-jev-latest-t0.93-low0.84-12h`. Labels go to `eval_pair_labels` as human labels. Labeled 2026-10-08: 150/150 `same`, 0 errors. Precision 1.000, exact 95% lower bound 0.980 (`pnpm eval:audit-score`), so the join-precision bar clears.
- [ ] Exit: precision ≥ 0.95 on the join audit (lower bound reported; at most 2 errors in 150 for the bound to clear 0.95) and on the human reference pairs; related-leak ≤ 10%; < $0.50/day; recall reported

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
