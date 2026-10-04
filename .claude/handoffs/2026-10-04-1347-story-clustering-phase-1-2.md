# Handoff: start implementing story-clustering-v1, Phases 1 and 2

| | |
|---|---|
| **Date** | 2026-10-04 13:47 (local); updated 14:22 |
| **Branch / HEAD** | `docs/story-clustering-tdd` @ `545522e` (not pushed, no PR) |
| **Working tree** | Clean apart from this file's update, which is uncommitted |
| **Feature docs** | `docs/story-clustering-v1/` (`tdd.md`, `plan.md`; no `prd.md`) |

## Summary

All design and planning for story clustering is done and committed, and no code has been written. The next agent implements Phase 1 (foundations) and Phase 2 (baseline clustering) of `docs/story-clustering-v1/plan.md`. The design has separate `/api/embed` and `/api/cluster` endpoints (D27–D29). Everything needed to start is below; two small decisions (test database, branch) can be settled in the first few minutes.

## Current state

1. [x] TDD for story-clustering-v1, written to the `writing-tdds` layout, plus a follow-on TDD and plan for `story-summary-v1`. Committed.
2. [x] `story-clustering-v1/plan.md` matches the TDD, including the embed/cluster split, failure policy, lease, health checks, constraints, and label export. Committed in `545522e`.
3. [x] Embedding model chosen: `gemini-embedding-2` (D21), from a spike on 300 real articles.
4. [x] Prices, volume (~1,000 articles/day), and eval-data availability checked 2026-10-03 and recorded in the plan's Readiness table.
5. [x] This handoff is tracked in git (`.claude/handoffs/` is tracked by decision).
6. [ ] Branch `docs/story-clustering-tdd` not pushed; no PR opened.
7. [ ] Phase 1 not started (all plan boxes unchecked).
8. [ ] Phase 2 not started.

**5 of 8 done, 3 not started.**

**Next action:** follow "Start here" below.

### Start here (suggested order)

1. Run `git switch -c feat/story-clustering-v1` from the current branch (see open question 2). Never commit to `main`. Follow the `using-git` skill: commit small, and tick the matching `plan.md` boxes in the same commit as the code.
2. Read `node_modules/next/dist/docs/` for anything Next-specific before writing it (`AGENTS.md` says Next 16 differs from what models know; admin gating uses `proxy.ts`, not `middleware.ts`).
3. Phase 1, "Test setup": add a test runner (Vitest suggested; none exists) and a `pnpm test` script, and a test database that is not production (open question 1).
4. Phase 1, "Migrations and schema": switch to `pnpm db:generate` + `pnpm db:migrate` (`drizzle.config.ts` already points `out` at `./drizzle`, which doesn't exist yet), add the `vector` extension migration, then the schema, constraints, and triggers from the TDD's Data model section.
5. Phase 1, text/LLM/plumbing/embedding groups, in the order the plan lists them.
6. Phase 2, assignment logic first (it has the subtlest tests), then admin auth, labeling, snapshot, replay harness, and the spikes.
7. Add the missing env names to `.env.example` as you go: `GOOGLE_GEMINI_API_KEY`, `OPEN_ROUTER_API_KEY`, `ADMIN_SECRET` (it currently lists only `DATABASE_URL` and `CRON_SECRET`).

### What exists in the code today

- `db/schema.ts`: only the `feed_items` table (`id` uuid, `source_id`, `guid` unique, `title`, `link`, `summary`, `image_url`, `published_at`, `created_at`).
- `db/index.ts`: `drizzle` over `postgres` with `prepare: false` (the Supabase pooler is in transaction mode, which is why the TDD uses a lease table instead of advisory locks).
- `app/api/ingest/route.ts`: GET handler, `export const maxDuration = 60`, `dynamic = "force-dynamic"`, Bearer `CRON_SECRET` auth. Model the new endpoints on it; use the same `maxDuration` unless you find a reason to change it. It upserts by `guid` and overwrites `title`/`summary` on conflict, so an article's text can change after it was embedded (see open question 8).
- `lib/rss.ts` (parser), `feeds.config.ts` (31 sources), `.github/workflows/ingest.yml` (cron `0 */6 * * *`, `curl -sfL`).
- Tooling: `pnpm`, `tsx` (for scripts), path alias `@/`. No test runner, no `drizzle/` folder yet.

## Key decisions and why

- **Clustering and summaries are two features.** Clustering ships and is measured first (D16); summaries are in `docs/story-summary-v1/` and out of scope here. The reader UI moved to summary-v1, so clustering v1 changes nothing readers see; quality is judged in the admin tools. LLM adjudication stays in clustering (my reading of "LLM inference part" as summaries only; not explicitly confirmed by the user).
- **Separate embed and cluster stages** (D27–D29): `/api/embed` and `/api/cluster` hand off through `feed_items`, with row states derived from columns (no status column). A throttled embedding API must not block clustering, and each stage has its own time budget. Cluster doesn't wait for older un-embedded articles (D28); the window-fit rule handles late arrivals. Embeddings stay on `feed_items`; changing the model is a manual cutover not built in v1. Rejected: one combined endpoint, strict-order hold-back, a separate embeddings table.
- **`gemini-embedding-2`, 768 dims, via the OpenAI-compatible endpoint with `dimensions: 768`** (D21). Rejected: `-001`. The task is set by the text prefix `task: clustering | query: ` (no `task_type`); the prefix format is unverified (Phase 2 spike).
- **Window-fit candidates, not open-only** (D18, D19): `last_article_at − 36h ≤ published_at ≤ first_article_at + 36h`, open or closed stories; an earlier-than-anchor article moves the anchor back only if every member still fits.
- **Lease table, not advisory locks** (D22), explicit timeouts/retry budget/circuit breaker (D23), DB `CHECK` constraints and an append-only decision log (D24), health endpoint plus loud workflow failure (D25), human data exported to the repo (D26).
- **Thresholds are starting values, not validated.** `T_low` ~0.75, `T_high` ~0.88, window 36h. The spike suggested 0.88 admits some different-event pairs (same-story pairs mostly ≥ 0.92), so the sweep includes `T_high` up to ~0.94.
- **Implementation status lives only in `plan.md`** (hard rule), never in a TDD or PRD.
- **Snapshot starts 2026-09-29**: 9/27 is partial and 9/28 is nearly empty.
- **Skills to follow** (`~/.claude/skills/`): `using-git`, `writing-tdds`, `writing-handoffs`.
- **Delegation guidance:** use a strong model for `lib/llm.ts` failure policy, the lease, DB triggers/constraints, and `lib/pipeline` assignment (window math, anchor shift, out-of-order arrival). A smaller model is fine for schema boilerplate, `lib/text.ts`, scripts (snapshot, export/import), and admin pages. The spikes, labeling review, and threshold sweep need the user.

## Open questions / issues

1. **Test database.** DB tests (constraints, triggers, lease, pipeline) need a Postgres with pgvector that is not production Supabase. Not chosen (local Postgres with pgvector vs a separate Supabase project/branch). Test runner also unchosen. User decision; ask in the first session.
2. **Implementation branch and docs PR.** `docs/story-clustering-tdd` is unpushed. Ask whether to push and open a PR for the docs, and whether to branch implementation from this branch or from `main` after merge.
3. **Supabase backups** for `feed_items` are unverified (Phase 1 task). Feeds can't re-supply history.
4. **Free-tier limits** for `gemini-embedding-2` and `gemini-3.5-flash-lite` are not looked up (Phase 1 task). In testing, batches of 50 hit 429s and an early script silently lost batches after 5 retries; batches of 25 worked. The client must never drop a batch.
5. **The 9/28 ingestion gap cause is inferred**, not verified in run logs. The plan states it as the cron redirect bug (fixed 2026-09-29, commit `3c57bee`).
6. **Cost bar vs reality** (not blocking Phases 1–2): at ~1,000 articles/day clustering is ~$0.16–0.33/day on the paid tier (free tier $0). The combined cost with summaries is far over the $0.50/day bar; the user hasn't decided whether to change the bar.
7. **Spike caveats:** the embedding-model comparison used rough hand labels from titles on ~300 articles, so D21 and the threshold observations are directional. The labeled eval is the real check.
8. **Re-ingest can change text after embedding.** The ingest upsert overwrites `title`/`summary` on conflict, but the stored embedding isn't invalidated. The TDD doesn't address it. Probably minor; raise with the user if it shows up in the data.
9. **Promo/advertorial articles** (sportsbook bonus codes) scored ~0.85–0.87 against each other and could form fake stories. Phase 2 task to check and filter.

## Relevant docs

1. `docs/story-clustering-v1/plan.md`: the ordered steps and checkboxes; the only place status is tracked. Phases 1 and 2 are the scope.
2. `docs/story-clustering-v1/tdd.md`: design, schema, endpoint contracts, failure policy, decisions D1–D29, risks, backfill runbook.
3. `AGENTS.md` and `docs/AGENTS.md`: repo conventions, PRD → TDD → plan workflow, pnpm, Vercel auto-deploys `main`.
4. `node_modules/next/dist/docs/`: Next 16 docs to read before writing Next code.
5. Existing code: `db/schema.ts`, `db/index.ts`, `drizzle.config.ts`, `app/api/ingest/route.ts`, `lib/rss.ts`, `feeds.config.ts`, `.github/workflows/ingest.yml`.
6. `docs/story-summary-v1/{tdd,plan}.md`: follow-on feature; read only to avoid designing against it (stories carry no summary columns).
7. Env variable names (values are in the gitignored `.env`; never print them): `DATABASE_URL`, `GOOGLE_GEMINI_API_KEY`, `OPEN_ROUTER_API_KEY`, `CRON_SECRET`. `ADMIN_SECRET` still has to be added (Phase 2).
8. Not in the repo: the embedding-spike scripts lived in a session scratchpad and are gone; their results are recorded in TDD decision D21.
