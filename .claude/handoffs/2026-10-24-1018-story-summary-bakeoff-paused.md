# Story summary v1: summarizer and eval harness built, paused for clustering fixes

- **Date:** 2026-10-24 10:18 (local)
- **Branch / HEAD:** `feat/story-summary-v1` @ `6b83d5e` (not pushed, no PR)
- **Working tree:** `docs/story-summary-v1/plan.md` has one uncommitted edit (golden-dataset status note, written for this handoff); `.claude/launch.json` is untracked and not ours
- **Feature docs:** `docs/story-summary-v1/` (`tdd.md`, `plan.md`; no `prd.md`)

## Summary

The bullet-point summarizer and the `pnpm eval:summary` harness are built, tested and committed. No live model call has been made. Work on this feature is paused: while preparing the golden dataset we found the clustering splits one event across several stories, so the next session addresses clustering first, then returns here.

## Current state

1. [x] Plan/TDD revised: models are `gpt-4o-mini` vs `gpt-6-luna` (direct OpenAI, no fallback, no OpenRouter), bullet-point output, local-agent evals against a golden dataset instead of a paid judge. Cost estimate about $0.13–0.18/day for summaries.
2. [x] Branch `feat/story-summary-v1` created; summarizer, harness and docs committed in `6b83d5e`.
3. [x] Summarizer: `lib/pipeline/summarize.ts` (+ test). Drops uncited bullets, fails on out-of-range citations, rejects stories with < 2 outlets.
4. [x] Shared client: `lib/llm.ts` `chat` takes `reasoningEffort` and returns `usage`/`costUsd`; `lib/llm-config.ts` has `SUMMARY_MODELS` and the `gpt-6-luna` price.
5. [x] Harness: `scripts/eval-summary.ts` (`generate` needs `--confirm` to spend; `pack` builds a blinded packet; `score` aggregates agents' `verdicts-<agent>.json`) with `lib/eval/summary.ts`. Smoke-tested on fake data only.
6. [~] Golden dataset: 8 of ~30–50 stories received (two files in `~/Downloads`, 8 unique), not yet converted to `eval/golden-summaries.jsonl`.
7. [ ] Merge golden files into the JSONL with ids and article sets.
8. [ ] Run the bake-off, calibrate the agents, choose a model (Phase 1 exit: zero unsupported claims on ≥ 95% of golden stories).
9. [ ] Phase 2 (migration, `/api/summarize`, workflow, inspector) and Phase 3 (story cards).

3 of 9 done (6 partly, 6 not started). **Next action:** a new session fixes the clustering weaknesses below; after that, finish step 7.

## Key decisions and why

- **Keep golden bullets as written** even where snippets can't support them (e.g. the $27.6B retaliatory duties). Models are compared relative to each other; ingest sources will expand later. Rejected: trimming the golden text to snippets.
- **Direct OpenAI only, no fallback (D12).** User decision: calls succeed or the run fails and retries on the next batch. OpenRouter is removed from the summary docs; the shared client and clustering code still reference it, untouched.
- **Bullet-point summaries (D13)** to match the golden format. `coverage_notes` has no golden counterpart, so it is not scored.
- **Local agents (Claude or Gemini) evaluate, not a paid judge (D6);** the owner spot-checks ~10 verdicts to calibrate. Production judge deferred.
- **Not committing to the Alaska golden-set article set yet.** The question (curated set vs the main cluster as production produced it) was left open when work paused.

## Open questions / issues

- **Clustering splits one event across clusters (the reason for the pause).** Traced for the Alaska DOJ suit (clusters `78530a03` main with 7 outlets, `2b287942`, `50d8bf4a`, `59a81d86`, `dcfd61df`) via `story_assignments.llm_verdict`:
  1. Only the single best-scoring candidate story is adjudicated, so early fragments outrank the main story for later articles (TDD lists the second-best candidate as a lever "left for later").
  2. τ = 0.93 is provisional (tuned on 8 human `same` pairs) and sits just above real same-event scores of 0.89, 0.84, 0.73.
  3. A wrongly joined article (Guardian live blog, now titled "Ramaswamy accuses Acton…") is the "closest member" that vetoed the Guardian's correct join (p = 0.15 against it).
  4. Ingest (`app/api/ingest/route.ts`, `onConflictDoUpdate`) overwrites title, summary and `published_at` on change, and the classifier's input is not stored, so the live blog was probably clustered under an earlier headline. This is a hypothesis; it can't be confirmed from stored data.
  5. By design, analysis/explainers/reactions are `related`, and the 12h window cuts off later arrivals.
- Canada tariffs (main cluster `7b0933a9`, 5 outlets, others split off) and Starlink (`992bf9fd` plus several follow-ups) look fragmented too; not verified in detail. The press-corps and bond-hearing stories had no cluster with ≥ 2 outlets from a quick title search.
- `gpt-6-luna` price ($0.10 / $0.50) is a third-party list price, not confirmed on OpenAI's page. Whether it accepts `reasoning_effort: low` with no temperature is unverified until the first live call. Its reasoning tokens bill as output and are not in the cost estimate.
- Golden snippets vs golden text mismatch (accepted above) means a coverage ceiling below 5 for every model.

## Relevant docs

- `docs/story-summary-v1/plan.md`, `docs/story-summary-v1/tdd.md` (D6, D10–D13, Evaluation part 4)
- `docs/story-clustering-v1/tdd.md`: D31–D37, "Assign to a story" (candidate selection, join rule, window); `plan.md` for status
- `lib/pipeline/adjudicate.ts`, `lib/pipeline/assign.ts`, `lib/pipeline/cluster.ts`: the join logic to change
- `lib/pipeline/summarize.ts`, `lib/eval/summary.ts`, `scripts/eval-summary.ts`: what was built
- `~/Downloads/news_summaries_1_to_5.md`, `news_summaries_6_to_8.md`: the 8 golden stories received
- Database tables `story_assignments` (`method`, `llm_verdict`), `stories`, `feed_items` for tracing splits. `psql "$DATABASE_URL"` after sourcing `.env`; treat as production, read-only.
- Tests need local Postgres: `brew services start postgresql@17` (it was started this session and may still be running).
