# Handoff: story-clustering-v1, Phase 1 done, Phase 2 mid-way, tuning the embedding-only baseline

| | |
|---|---|
| **Date** | 2026-10-05 19:24 (local) |
| **Branch / HEAD** | `feat/story-clustering-v1` @ `b1249dd` plus this handoff and one small TDD edit (see Current state); not pushed, no PR |
| **Working tree** | Clean before this handoff; the new handoff file and a one-row `tdd.md` risk edit are uncommitted until the next commit |
| **Feature docs** | `docs/story-clustering-v1/` (`tdd.md`, `plan.md`; no `prd.md`) |
| **Supersedes** | `.claude/handoffs/2026-10-04-1347-story-clustering-phase-1-2.md` |

## Summary

Story clustering v1 is being built on `feat/story-clustering-v1`. Phase 1 (foundations) is complete and applied to production: schema, LLM client, embed stage, and all 7,544 articles embedded. Phase 2 has the assignment core, admin auth, replay harness, snapshot, and a new clustering explorer UI. What remains is labeling, silver labels, the spikes, and threshold tuning. The first baseline shows about 60% of articles landing in the LLM gray zone at the default thresholds, far above the planned 20–35%, so the user is tuning the embedding-only step before any LLM work.

## Current state

Status of record is `docs/story-clustering-v1/plan.md`. Summary against its phases:

1. [x] **Phase 1 foundations.** Vitest + local Postgres test DB; migrations `drizzle/0000`–`0005` (generated, with custom SQL for the `vector` extension and the invariant triggers); schema with CHECK constraints and triggers, tested; `lib/text.ts`; `lib/llm.ts` (retries, breaker, Gemini→OpenRouter fallback, verdict cache on `llm_calls`, price table in `lib/llm-config.ts`); `lib/pipeline/lease.ts`, `runs.ts`, `embed.ts`; `pnpm embed:backfill`.
2. [x] **Production migrated and embedded.** Migrations 0000–0005 applied to the production Supabase DB with the user's approval; all 7,544 `feed_items` rows have `gemini-embedding-2` vectors (cost about $0.13, 0 failed batches).
3. [x] **Gemini quota work (D30).** Free tier was too small (1,000 inputs/day; each input counts). The user moved to the paid tier with a $5 key cap. Built client-side pacing (off when `GEMINI_TIER=paid`), 429 quota parsing (per-day 429 ends a run cleanly), and a usage ledger (`lib/usage.ts`, `pnpm usage`, `embedQuotaCheck`).
4. [x] **Assignment core.** `lib/pipeline/assign.ts` (shared core), `store-db.ts`, `store-memory.ts`, `cluster.ts` (`runClusterStage`, close sweep). Candidate score is `min(max-member sim, centroid sim)`; exact ties break to the bigger story, then older, then id. Tested, including DB vs in-memory parity.
5. [x] **Admin auth.** `proxy.ts`, `/admin/login`, `lib/admin-auth.ts` (`requireAdmin` on every page, action, and route). `ADMIN_SECRET` is in local `.env` and the user added it on Vercel.
6. [x] **Eval tooling.** `lib/eval/metrics.ts`, `replay.ts`, `sim-cache.ts`, `pnpm eval:cluster`, `pnpm eval:snapshot`. Snapshot taken: `eval/snapshot-2026-10-05.jsonl` (6,301 articles from 2026-09-29, 28 sources, 287 thin); gitignored (~64 MB), rebuildable.
7. [x] **Clustering explorer** at `/admin/explore` (`lib/eval/explore.ts`, `app/admin/explore/*`): sliders for `T_low`/`T_high`/window, gray-zone handling switch (new vs join), score histogram, stories sorted most-suspicious-first, gray-zone articles with their best candidate story, title search. No API calls. First load about 10 s, a new config under 1 s, a cached one about 15 ms. Verified through the data route and page render with a session cookie; **not yet looked at in a browser by an agent**.
8. [~] **Label export/import** (`lib/labels.ts`, `pnpm labels:export|import`): done for `eval_pair_labels` and tested; `manual` assignments wait for the Phase 4 "doesn't belong" action.
9. [~] **Phase 1 leftovers:** Supabase backups (free plan has none; the periodic `feed_items` export is not built); `gemini-3.5-flash-lite` quota limits not looked up.
10. [ ] **Labeling UI** (`s`/`r`/`d`/`u`), **stratified pair generation**, **silver labels**, **human review**, **baseline P/R/related-leak**.
11. [ ] **Spikes:** `task: clustering | query: ` prefix vs none; window-filtered kNN at scale (`hnsw.iterative_scan`); promo/advertorial check; real LLM-band share (the first measurement is above).
12. [ ] **Phases 3 and 4** (adjudication, `/api/embed`, `/api/cluster`, `/api/health`, workflow, stories inspector, health panel). Not started.

Roughly 12 of 21 top-level plan items are done or partly done; all of Phases 3 and 4 are untouched.

Docs changed this session: `plan.md` (status, readiness table, findings), `tdd.md` (D30, free-tier limits settled, verdict cache storage, candidate scoring and tie-break, and, in this handoff's commit, a new risk row on kNN slot dominance). The one-row `tdd.md` edit and this file are uncommitted.

**Next action:** answer the user's pending question about adding a K control to the explorer (see Open questions), then review what the explorer shows with them and decide whether to tune the embedding step further or move on to labeling and pair generation.

## Key decisions and why

- **No `gemini-3.5-flash-lite` (or any chat LLM) use without the user's explicit go-ahead** (user, 2026-10-05). Embeddings are approved. Say what will be called and the expected cost first. Saved in memory (`feedback_flash_lite_needs_approval`). Silver labeling and adjudication both fall under this.
- **Paid Gemini tier, $5 cap on the key**, used for embeddings and, once approved, flash-lite. `GEMINI_TIER=paid` disables client-side pacing; it is set locally but **not on Vercel** (needed when `/api/embed` ships).
- **Quotas count inputs, not HTTP calls** (measured via the ledger, D30). Why it matters: batching does not reduce the free-tier request count.
- **Candidate score is the lower of max-member and centroid similarity** (anti-chaining, D8). Ties break deterministically (bigger story, older story, id), because a flaky test showed row-order dependence.
- **One assignment core, two stores** (database and in-memory), so the replay harness and the explorer measure exactly what production does. Rejected: a separate replay implementation.
- **Baseline treats gray-zone articles conservatively (new story)** until the LLM exists; the explorer's "join" mode shows the optimistic bound.
- **Verdict cache lives on `llm_calls`** (`cache_key`, `response`), not a new table.
- **Snapshot and explorer are local-only**; the snapshot is gitignored, labels are committed (D26).
- **Prod DB changes need the user's go-ahead each time.** The user approved migrations 0000–0005 and the backfill; anything further (for example a new migration) should be asked first.
- **No push or PR until the feature is complete** (user, 2026-10-04).
- **Environment guard:** the permission classifier blocked reading `ADMIN_SECRET` out of `.env`; do not try to read or print secrets. The user set the Vercel value themselves.

## Open questions / issues

1. **K control for the explorer** (pending the user's yes/no): the candidate lookup takes the 10 nearest *member articles*, so one big story can crowd out a smaller correct one. Proposed fix: a K slider in the explorer and comparing K = 10 vs 30–50 on labeled pairs. The risk is recorded in the TDD. Resolver: the user.
2. **Gray zone is about 60% of articles** at `T_low` 0.75 / `T_high` 0.88 (73.6% at `T_high` 0.92), versus the planned 20–35%. Likely overstated by the conservative baseline, and the thresholds probably need tuning. Resolver: explorer review with the user, then the labeled sweep.
3. **Explorer not visually verified.** Endpoint and page render were checked via `curl` with a session cookie; no one has looked at the UI. Resolver: the user, or an agent using the browser pane after signing in (do not read the secret to do it).
4. **Labels and silver labeling:** pair generation, the OpenRouter silver-label model/cost, and the human review time are all undecided and need the user.
5. **`gemini-3.5-flash-lite` free/paid limits** unread; needed for Phase 3. Check through the usage ledger rather than the dashboard, after the user approves a first call.
6. **Backups:** Supabase free plan has none; the periodic `feed_items` export is not built. Resolver: the user decides where exports are stored.
7. **Cost bar vs reality** (unchanged): clustering plus summaries exceeds the $0.50/day bar if the gray zone stays large. The user has not decided whether to change the bar.
8. **Re-ingest overwrites `title`/`summary`** without invalidating the stored embedding (unchanged from the earlier handoff).
9. **Supabase and Notion MCP servers disconnected** at the end of this session (the Supabase `execute_sql`/`get_project` tools were used for read-only checks). Production access from scripts still works through `DATABASE_URL` in `.env`.
10. **Local Postgres:** `postgresql@17` was started with `brew services run` (not at login). If tests fail to connect, run `brew services run postgresql@17`; the test DB is `better_news_test`.

## Relevant docs

1. `docs/story-clustering-v1/plan.md`: the only place status lives; Phase 2 items are the live work.
2. `docs/story-clustering-v1/tdd.md`: design, decisions D1–D30, the new kNN risk row, and the Gemini quota findings.
3. `lib/pipeline/assign.ts`: the assignment core (`assignArticle`, `candidateScore`, `compareCandidates`, `fitsWindow`, config defaults including `k`).
4. `lib/eval/explore.ts` and `app/admin/explore/Explorer.tsx`: the explorer engine and UI; `lib/eval/replay.ts`, `sim-cache.ts` underneath.
5. `lib/llm.ts`, `lib/llm-config.ts`, `lib/usage.ts`: LLM client, limits and prices, usage ledger.
6. `AGENTS.md`, `docs/AGENTS.md`: repo conventions; Next 16 differs from training data (read `node_modules/next/dist/docs/` before Next code; admin gating is `proxy.ts`).
7. Commands: `pnpm test` (139 tests), `pnpm lint`, `pnpm dev` then `/admin/explore`, `pnpm usage`, `pnpm eval:snapshot`, `pnpm eval:cluster --snapshot eval/snapshot-2026-10-05.jsonl --t-high 0.88`.
8. Memory: `feedback_flash_lite_needs_approval`, `story-clustering-v1-quota-findings` (in the auto-memory folder).
