# Story Summary v1 — Implementation Plan

Design, decisions, schema, and cost live in [tdd.md](tdd.md). This document
is the ordered build sequence. It starts after
[story-clustering-v1](../story-clustering-v1/plan.md) is wired up and meets its
ship bar, since summaries are only as good as the stories under them.

## Readiness

Checked 2026-09-27 against the live environment, with models and prices re-checked 2026-10-24:

| Check | Status |
|---|---|
| Clustering v1 | ⏳ **Prerequisite.** Needs its Phase 4 exit met (clustering running unattended and meeting the ship bar) before Phase 2 here starts. Phase 1 (the model bake-off) only needs a set of verified stories, which the labeled clustering data can supply |
| `OPENAI_API_KEY` | ✅ Valid (used for clustering's `gpt-4o-mini` silver labels 2026-10-05). Covers both candidate summarizers: `gpt-4o-mini` and `gpt-6-luna` (confirm the direct-API model ID in Phase 1). Calls go directly to OpenAI; there is no fallback provider, so a failed call fails the run |
| `GOOGLE_GEMINI_API_KEY` | ✅ Valid, now on the **paid tier** (moved 2026-10-05, key capped at $5; see clustering plan). Gemini is no longer a summarizer candidate (see TDD D10) but stays the embedding provider |
| Model prices | ⚠️ List prices looked up 2026-10-24, not yet confirmed against OpenAI's own pricing page: `gpt-4o-mini` $0.15 / $0.60, `gpt-6-luna` $0.10 / $0.50 per 1M tokens, batch 50% off. Enter them in the config price table in Phase 1. `gpt-6-luna` is a reasoning model, so hidden reasoning tokens bill as output; Phase 1 measures real usage |
| Eval approach | ✅ Decided 2026-10-24: local agents (Claude or Gemini) compare generated titles and summaries to a small golden dataset (TDD D6, D11). No judge API spend |
| Golden dataset | ⏳ The owner is producing it and will deliver it later, with two fields per story: `title` and `summary` (bullet points). Phase 1's model comparison waits on it; the summarizer and harness can be built first |

## Phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **1. Bake-off** | Golden dataset; summarizer prompt + schema validation + citation checks; local-agent eval harness; `gpt-4o-mini` vs `gpt-6-luna` comparison | A model chosen on golden-set results; zero unsupported claims on ≥ 95% of the golden stories |
| **2. Wire it up** | Summary columns migration; `/api/summarize` + workflow step; summaries in the stories inspector | 3 days unattended, no failed runs, within budget |
| **3. Reader UI** | Home page shows story cards (headline, summary, outlet chips, count), with singletons alongside | Ship |

### Phase 1 — Bake-off

- [ ] Golden dataset: ~30–50 verified stories (≥ 2 outlets, spread across topics and outlet counts, including thin-snippet cases), each stored in `eval/` with its member snippets and two golden fields: `title` and `summary` (bullet points)
  - [ ] The owner writes the golden text and delivers it later; the owner also picks the stories
  - [x] File format defined and validated by the loader (`eval/golden-summaries.jsonl`, one story per line: `id`, `title`, `summary` as a list of bullets or a bulleted string, and either inline `articles` (`source`, `title`, `snippet`) or feed `guids` looked up in the database). The owner can change it if their dataset arrives in another shape
- [~] Look up the direct OpenAI model ID and price for `gpt-6-luna`; fill the config price table with both candidates' prices. Done 2026-10-24: `gpt-6-luna` and `gpt-4o-mini` both appear in the OpenAI model list for our key, and both are in `SUMMARY_MODELS` and the price table. Remaining: confirm the `gpt-6-luna` price on OpenAI's pricing page, and whether it accepts `reasoning_effort: low` and no custom temperature (first live call will show)
- [x] Summarizer in `lib/pipeline/summarize.ts` with schema-validated output, returning the summary as bullet points; drop uncited bullets; fail on nonexistent citations. Model ID read from config (D10). Calls OpenAI directly through the shared client, with no fallback provider
  - [x] Tests: uncited bullet dropped; out-of-range citation fails the summary; < 2 outlets is not summarized
- [~] Local-agent eval harness (`pnpm eval:summary generate | pack | score`): runs a model over the golden stories, then has local agents (Claude or Gemini) compare each generated title and summary bullets to the golden ones against the source snippets, scoring faithfulness, coverage, and neutrality and listing unsupported claims. Results saved under `eval/`. Built and unit-tested 2026-10-24, and smoke-tested end to end (pack, then score) on fake data with no API calls. `generate` has not made a live call yet; it prints a cost estimate and needs `--confirm`. Remaining: a real run once the golden dataset exists
  - [ ] Calibrate the agents: the owner spot-checks ~10 of their verdicts; if they disagree with the owner on more than ~2, tighten the rubric before comparing models
- [ ] Once the golden dataset lands, run `gpt-4o-mini` and `gpt-6-luna` on the golden set (same prompt, temperature 0 where supported, `gpt-6-luna` at its lowest reasoning effort first) and compare faithfulness, coverage, neutrality, citation validity, length, and real cost per summary from `llm_calls`
- [ ] Choose the model and record the result and the cost-per-day projection in the TDD
- [ ] Exit: zero unsupported claims on ≥ 95% of the golden stories

### Phase 2 — Wire it up

- [ ] Migration: summary columns on `stories` (`headline`, `summary_json`, `summary_model`, `summarized_at`, `summary_member_ids`)
- [ ] Staleness derived from `summary_member_ids`; new outlet or ≥ 30% growth triggers a re-summary, smaller changes don't; a closed story gets one final pass then is frozen
  - [ ] Tests: the rules above
- [ ] `/api/summarize`: idempotent, batched, returns `{ processed, remaining }`, auth like `/api/ingest`
- [ ] Update the GitHub Actions workflow to call it after `/api/cluster`, in a loop until `remaining = 0`
  - [ ] Tests: re-running a batch is a no-op; stopping mid-run and resuming gives the same result
- [ ] Stories inspector: summary with linked citations
- [ ] Decide whether a production judge is worth adding (TDD open question); if so, add the `summary_evals` table and show scores in the inspector
- [ ] Exit: 3 days unattended, no failed runs, within budget (combined < $0.50/day)

### Phase 3 — Reader UI

- [ ] Home page story cards: headline, summary with citations, outlet chips, article count; singletons alongside
- [ ] Exit: ship
