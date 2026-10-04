# Handoff: start implementing story-clustering-v1, Phases 1 and 2

| | |
|---|---|
| **Date** | 2026-10-04 13:47 (local) |
| **Branch / HEAD** | `docs/story-clustering-tdd` @ `140d625` (not pushed, no PR) |
| **Working tree** | Uncommitted edits to `docs/story-clustering-v1/tdd.md` and `plan.md`: the embed/cluster split (D27–D29) and a "Test setup" group in Phase 1 |
| **Feature docs** | `docs/story-clustering-v1/` (`tdd.md`, `plan.md`; no `prd.md`) |

## Summary

All design and planning for story clustering is done, and no code has been written. The next agent implements Phase 1 (foundations) and Phase 2 (baseline clustering) of `docs/story-clustering-v1/plan.md`. The design uses separate `/api/embed` and `/api/cluster` endpoints; that update, written after the first commit, is uncommitted. Before building, settle the two open items below (test database, implementation branch).

## Current state

1. [x] TDD for story-clustering-v1 written to the `writing-tdds` skill's layout, and a follow-on TDD + plan for `story-summary-v1` (committed in `140d625`).
2. [x] `story-clustering-v1/plan.md` rewritten to match the TDD (committed in `140d625`).
3. [x] Embedding model chosen: `gemini-embedding-2` (decision D21, from a spike on 300 real articles).
4. [x] Prices, ingestion volume (~1,000 articles/day), and eval data availability re-checked 2026-10-03 and recorded in the plan's Readiness table.
5. [~] Two doc updates made but **uncommitted**: (a) the embed/cluster split written into the TDD (D27–D29, new `/api/embed` contract, new `feed_items` columns, extra health checks) and the plan (Phase 1 embed logic, Phase 4 endpoint and workflow tasks); (b) a "Test setup" group in Phase 1 because no test runner or test database exists.
6. [ ] Branch not pushed and no PR opened for `docs/story-clustering-tdd`.
7. [ ] Phase 1 not started (all boxes in the plan are unchecked).
8. [ ] Phase 2 not started.

**4 of 8 done, 1 partial, 3 not started.**

**Next action:** commit the doc updates (stage by path), settle the test database and branch questions with the user, create an implementation branch (suggest `feat/story-clustering-v1`), then start Phase 1 with "Test setup" and the migration workflow switch (`db:push` to `db:generate` + `db:migrate`).

## Key decisions and why

- **Clustering and summaries are two features.** Clustering ships and is measured first (D16); summaries live in `docs/story-summary-v1/` and are out of scope here. Why: learn grouping accuracy before adding LLM summaries. The reader UI also moved to summary-v1, so clustering v1 changes nothing readers see; quality is judged through the admin tools.
- **LLM adjudication stays in clustering v1.** The user said "LLM inference part" moves to the summary feature; I read that as summaries only, because the gray-zone adjudication determines clustering accuracy. Not explicitly confirmed by the user.
- **`gemini-embedding-2`, 768 dims, through the OpenAI-compatible endpoint with `dimensions: 768`** (D21). It separated same-story from same-topic-different-event pairs better than `-001` (AUC 0.974 vs 0.957), is unit-normalized, takes 8,192-token input, and has no `task_type`: the task is set by the text prefix `task: clustering | query: `. The prefix format is unverified (Phase 2 spike). Rejected: `gemini-embedding-001`.
- **Separate embed and cluster stages** (D27–D29, 2026-10-04): `/api/embed` and `/api/cluster` hand off through `feed_items`, with row states derived from columns (no status column). Why: a throttled embedding API must not block clustering, and each stage gets its own time budget and can change independently. Cluster does not wait for older un-embedded articles (D28), because window-fit handles late arrivals. Embeddings stay on `feed_items`, and changing the embedding model is a manual cutover that is not built in v1 (D29). Rejected: one combined endpoint, a strict-order hold-back, and a separate embeddings table.
- **Window-fit candidates, not open-only** (D18, D19): `last_article_at − 36h ≤ published_at ≤ first_article_at + 36h`, open or closed stories, so late and backfilled articles join existing stories. An earlier-than-anchor article moves the anchor back only if every member still fits.
- **Lease table, not advisory locks** (D22): the Supabase pooler is in transaction mode, which doesn't hold session-level locks.
- **Starting thresholds are not validated.** `T_low` ~0.75, `T_high` ~0.88, window 36h. In the spike, 0.88 admitted a few different-event pairs while same-story pairs mostly scored at least 0.92, so the sweep includes `T_high` up to ~0.94.
- **Implementation status lives only in `plan.md`**, never in a TDD or PRD (hard rule, in `docs/AGENTS.md` and the `writing-tdds` skill).
- **Snapshot starts 2026-09-29.** 9/27 is partial and 9/28 is nearly empty.
- **Human data is durable and exported:** labels and `manual` assignments live in their own tables and are exported to `eval/labels-YYYY-MM-DD.jsonl` keyed by article `guid` (D26).
- **Skills to follow** (in `~/.claude/skills/`): `using-git` (feature branch, never commit to `main`, update `plan.md` in the same commit as code), `writing-tdds`, `writing-handoffs`.
- **Model delegation advice** (conversation only): use Sonnet for `lib/llm.ts` failure policy, the lease, DB triggers/constraints, and `lib/pipeline` assignment (window math, anchor shift). A smaller model like Haiku is fine for schema boilerplate, `lib/text.ts`, scripts (snapshot, export/import), and admin pages. The spikes, labeling review, and threshold sweep need the user.

## Open questions / issues

1. **Embed/cluster split** is now written into the TDD and plan (see Key decisions). Nothing blocks on it.
2. **Test database.** DB tests (constraints, triggers, lease, pipeline) need a Postgres with pgvector that is not the production Supabase DB. Choice not made (local Postgres vs a separate Supabase project/branch). Test runner not chosen either (Vitest suggested). User decision.
3. **Implementation branch / PR.** `docs/story-clustering-tdd` is unpushed and has uncommitted doc edits. Ask whether to commit them, push, and open a PR for the docs, and whether to branch implementation from it or from `main` after merge. Do not commit to `main`.
4. **Supabase backups** for `feed_items` are unverified (Phase 1 task). Feeds can't re-supply history.
5. **Free-tier limits** for `gemini-embedding-2` and `gemini-3.5-flash-lite` are not looked up (Phase 1 task). In testing, batches of 50 hit 429s and an early script lost batches after 5 retries; batches of 25 worked. The client must never drop a batch.
6. **The 9/28 ingestion gap cause is inferred, not verified.** The plan states it as the cron redirect bug (fixed 2026-09-29, commit `3c57bee`); the run logs weren't checked.
7. **Cost bar vs reality** (not blocking Phases 1–2): at ~1,000 articles/day clustering is ~$0.16–0.33/day on the paid tier (free tier $0), and the combined cost with summaries is far over the $0.50/day bar. The user has not decided whether to change the bar.
8. **Spike caveats:** my embedding-model comparison used hand labels made from titles on ~300 articles, so treat D21 and the threshold observations as directional. The labeled eval is the real check.
9. **Next.js 16 differs from what models know.** `AGENTS.md` requires reading `node_modules/next/dist/docs/` before writing Next code (`proxy.ts` instead of middleware, server actions).
10. **Promo/advertorial articles** (sportsbook bonus codes) scored ~0.85–0.87 against each other and could form fake stories; Phase 2 task to check and filter.
11. **Handoffs and git.** `.claude/` isn't gitignored, so this file would be committed with `git add -A`. Stage by path and decide whether handoffs should be tracked.

## Relevant docs

1. `docs/story-clustering-v1/plan.md`: the ordered steps and checkboxes; the only place status is tracked. Phase 1 and 2 are the scope.
2. `docs/story-clustering-v1/tdd.md`: full design, schema, endpoint contracts, failure policy, decisions D1–D26, risks, backfill runbook.
3. `AGENTS.md` and `docs/AGENTS.md`: repo conventions, PRD → TDD → plan workflow, pnpm, Vercel auto-deploys `main`.
4. `node_modules/next/dist/docs/`: Next 16 docs to read before writing Next code.
5. Existing code to extend: `db/schema.ts` (only `feed_items` today), `db/index.ts`, `drizzle.config.ts` (out: `./drizzle`, no migrations folder yet), `app/api/ingest/route.ts`, `lib/rss.ts`, `feeds.config.ts`, `.github/workflows/ingest.yml` (cron every 6h, `curl -sfL`).
6. `docs/story-summary-v1/{tdd,plan}.md`: follow-on feature; read only to avoid designing against it (stories carry no summary columns).
7. Env variable names (values are in the gitignored `.env`; never print them): `DATABASE_URL`, `GOOGLE_GEMINI_API_KEY`, `OPEN_ROUTER_API_KEY`, `CRON_SECRET`. `ADMIN_SECRET` still has to be added (Phase 2).
8. Not in the repo: my embedding-spike scripts were in a session scratchpad and are gone; their results are recorded in TDD decision D21.
