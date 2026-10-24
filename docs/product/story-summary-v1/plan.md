# Story Summary v1 — Implementation Plan

Design, decisions, schema, and cost live in [tdd.md](tdd.md). This document
is the ordered build sequence. It starts after
[story-clustering-v1](../story-clustering-v1/plan.md) is wired up and meets its
ship bar, since summaries are only as good as the stories under them.

## Readiness

Checked 2026-09-27 against the live environment:

| Check | Status |
|---|---|
| Clustering v1 | ⏳ **Prerequisite.** Needs its Phase 4 exit met (clustering running unattended and meeting the ship bar) before Phase 1 here starts |
| `GOOGLE_GEMINI_API_KEY` | ✅ Valid. `gemini-3.8-flash` answered via the OpenAI-compatible endpoint |
| `OPEN_ROUTER_API_KEY` | ✅ Valid. Accepted a paid-model request; key limit $100, $0 used. Used for the judge |
| Gemini billing tier | ✅ **Free tier** (confirmed). Expect per-minute and per-day request caps; the shared client treats 429 as normal (backoff, then OpenRouter fallback) |
| Model prices | ⚠️ `gemini-3.8-flash` looked up 2026-10-03 (see the TDD; the price doubles on 2027-01-01). The judge model's price is still to look up. Fill the config price table in Phase 1 |

## Phases

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **1. Summaries** | Summary columns + `summary_evals` migration; summarizer + citation validation; judge | Meets faithfulness bar on ~50 stories |
| **2. Wire it up** | `/api/summarize` + workflow step; summaries and judge scores in the stories inspector | 3 days unattended, no failed runs, within budget |
| **3. Reader UI** | Home page shows story cards (headline, summary, outlet chips, count), with singletons alongside | Ship |

### Phase 1 — Summaries

- [ ] Look up the judge model's price on OpenRouter; fill the config price table with it and the `gemini-3.8-flash` prices in the TDD
- [ ] Migration: summary columns on `stories` (`headline`, `summary_json`, `summary_model`, `summarized_at`, `summary_member_ids`) and the `summary_evals` table
- [ ] Summarizer with schema-validated output; staleness derived from `summary_member_ids`; drop uncited sentences; fail on nonexistent citations
  - [ ] Tests: uncited sentence dropped; out-of-range citation fails the summary; < 2 outlets is not summarized; new outlet or ≥ 30% growth triggers a re-summary, smaller changes don't; closed story gets one final pass then is frozen
- [ ] Automated judge (non-Gemini family) writing to `summary_evals`
- [ ] Human spot check of ~20 summaries
- [ ] Exit: zero unsupported claims on ≥ 95% of ~50 summaries

### Phase 2 — Wire it up

- [ ] `/api/summarize`: idempotent, batched, returns `{ processed, remaining }`, auth like `/api/ingest`
- [ ] Update the GitHub Actions workflow to call it after `/api/cluster`, in a loop until `remaining = 0`
  - [ ] Tests: re-running a batch is a no-op; stopping mid-run and resuming gives the same result
- [ ] Stories inspector: summary with linked citations, judge scores
- [ ] Exit: 3 days unattended, no failed runs, within budget (combined < $0.50/day)

### Phase 3 — Reader UI

- [ ] Home page story cards: headline, summary with citations, outlet chips, article count; singletons alongside
- [ ] Exit: ship
