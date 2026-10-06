# Handoff: story-clustering-v1, labeling session findings and what to do about them

| | |
|---|---|
| **Date** | 2026-10-05 20:54 (local; the labels file is named `2026-10-06` because that name uses UTC) |
| **Branch / HEAD** | `feat/story-clustering-v1` @ `4e1bed1` (not pushed; the user said not to push or open a PR until the feature is complete) |
| **Working tree** | Clean apart from this handoff file, which is uncommitted until the next commit |
| **Feature docs** | `docs/story-clustering-v1/` (`tdd.md`, `plan.md`; no `prd.md`) |
| **Supersedes** | `.claude/handoffs/2026-10-05-1924-story-clustering-threshold-tuning.md` (read it for Phase 1 and the earlier Phase 2 build; this one covers what happened after) |

## Summary

Phase 2 is finished: the user human-reviewed 94 article pairs, and baseline precision, recall and related-leak numbers are recorded. The labels show that embedding similarity cannot separate `same` from `related` pairs, so no embedding-only setup comes near the ship bar (precision ≥ 0.95, recall ≥ 0.80). The join decision has to come from an LLM, with embeddings reduced to candidate retrieval. The next agent should get the user's approval on a tightened "same story" definition and a new band design, then calibrate the LLM prompt against the human labels before building Phase 3.

## Current state

Status of record is `docs/story-clustering-v1/plan.md`. This session's work:

1. [x] **Silver labeling wired to OpenAI.** The user switched from OpenRouter to `gpt-4o-mini` (docs checked: strict structured outputs, $0.15 / $0.60 per 1M tokens, `refusal` field on safety refusals). `lib/llm.ts` has an `openai` provider (`OPENAI_API_KEY`, never a fallback), a `temperature` option, and non-retryable handling of refusals. Tested.
2. [x] **Silver labels generated** for all 300 pairs with `pnpm eval:silver --confirm`: 0 failures, cost $0.028 (the user approved this spend). Verdicts: 170 different, 72 same, 58 related. Stored in production `eval_pair_labels` as labeler `model:gpt-4o-mini`.
3. [x] **Human review done.** The user labeled all 94 pairs in the review queue (44 where silver and the baseline disagreed, plus 50 random): 42 related, 36 different, 16 same. Stored as labeler `human`.
4. [x] **Labels exported** to `eval/labels-2026-10-06.jsonl` (394 rows: 94 human + 300 silver), committed.
5. [x] **Phase 2 exit: baseline numbers recorded** in `plan.md` (see Findings below).
6. [x] **Prefix spike resolved:** no difference between prefixes, so the current prefix stays and no re-embed is needed.
7. [x] **Docs updated and committed:** `plan.md` (silver results, human review, prefix spike, baseline exit) and `tdd.md` (silver labeler is `gpt-4o-mini`; measured threshold results added to the risks and unknowns table). Nothing about the proposed band redesign is written into the TDD yet, because it reverses decision D6 and needs the user's approval.
8. [ ] **Tighten the "same story" definition** (wording needs user approval).
9. [ ] **Calibrate the prompt against the 94 human labels** (cents with `gpt-4o-mini`; testing `gemini-3.5-flash-lite` needs the user's approval first).
10. [ ] **Redesign the bands** (embeddings find candidates, the LLM decides every join).
11. [ ] **Remaining small items:** K control in the explorer, window sweep, the 8-pair window check, the periodic `feed_items` export, `gemini-3.5-flash-lite` limits.
12. [ ] **Phases 3 and 4** untouched.

Rough tally: Phases 1 and 2 done; 4 of 7 session follow-ups open; Phases 3 and 4 not started.

**Next action:** ask the user to approve the tightened "same story" wording (see Findings), then run the prompt calibration against the human labels.

### Findings from the labeling session

Human-vs-silver agreement:

| | silver related | silver same | silver different |
|---|---|---|---|
| human related (42) | 27 | **15** | 0 |
| human different (36) | 3 | 0 | 33 |
| human same (16) | 5 | 11 | 0 |

- Exact agreement 71 of 94; on the 50 random-check pairs it is 42 of 50 (84%), on the 44 baseline-disagreement pairs 29 of 44. Silver over-calls `same` (15 pairs the user called `related`), matching the user's note that the bar is high.
- **Embeddings do not separate same from related.** Human `same` pairs: similarity min 0.851, median 0.909, max 0.952. Human `related`: min 0.806, median 0.896, max 0.954. Human `different`: median 0.719, max 0.91. Everything below 0.8 is `different`.
- **Baseline auto-joins are mostly `related`.** Of the 48 baseline-merged pairs (similarity at or above 0.88) the user reviewed: 12 same, 33 related, 3 different.
- **Time gaps:** human `same` pairs are a median 14h apart (max 32.1h by feed `published_at`); 8 of 16 are more than 12h apart and 11 of 16 more than 3h apart. This **conflicts with the user's impression** that same-story articles are published within hours. The sample was drawn from the 36h window, so it cannot show whether a tighter window is better, and feed timestamps may be unreliable (reposts, timezone). Unresolved.

Baseline metrics on the 300 labeled pairs (human labels win over silver; `related` counts as a negative; stratified toward hard pairs, so precision is pessimistic; only 62 `same` pairs including silver):

| Config | Precision | Recall | Related-leak |
|---|---|---|---|
| `T_high` 0.88 / `T_low` 0.75 / 36h | 61.7% | 93.5% | 50.8% |
| `T_high` 0.92 / `T_low` 0.75 / 36h | 74.0% | 59.7% | 20.0% |
| `T_high` 0.95 / `T_low` 0.85 / 36h | 69.2% | 14.5% | 6.2% |
| single threshold 0.90 / 12h | 76.3% | 46.8% | 12.3% |
| single threshold 0.92 / 12h | 78.6% | 35.5% | 9.2% |
| single threshold 0.95 / 12h | 83.3% | 8.1% | 1.5% |
| single threshold 0.88 / 6h | 78.6% | 35.5% | 7.7% |

Other measurements: prefix AUC on 300 labeled pairs is 0.941 (none), 0.939 (clustering), 0.940 (similarity). LLM-band share with no auto-join (`T_high` 1.0): 87.2% at `T_low` 0.80/36h, 62.8% at 0.84/36h, 48.5% at 0.84/12h, 31.8% at 0.88/12h. Those shares are inflated because the conservative baseline turns every gray article into a new story. Even so, at roughly 450–570 LLM calls a day the adjudication cost is cents a day with `gpt-4o-mini` or flash-lite, so the $0.50/day bar is not what binds.

The user's verbal findings from labeling (not in any doc yet): the bar for `same` is really high, the articles must report the exact same event; `related` is the hardest and most ambiguous class because stories unfold progressively; `different` should be clear from attention and keywords alone.

## Key decisions and why

- **Silver labeler is OpenAI `gpt-4o-mini` called directly** (user, 2026-10-05), not OpenRouter. It is non-Gemini on purpose (D12, avoids sharing blind spots with the Gemini models in the pipeline). The OpenRouter route still works for model ids containing a slash.
- **Human labels win over silver labels** in the replay harness and in prefix evaluation.
- **No chat-LLM spend without the user's explicit go-ahead** (standing rule, saved in memory as `feedback_flash_lite_needs_approval`): say what will be called and the expected cost, then wait. The silver run was approved. Testing flash-lite on the labeled pairs would need a fresh yes. Unit tests use fakes and are fine.
- **Proposed, not yet approved:** (a) tighten the "same story" definition to the user's bar; (b) embeddings only retrieve candidates (`T_low` about 0.84, since nothing under 0.8 is same or related) and the LLM decides every join, with no embedding-only auto-join, because even at 0.95 similarity precision is only 69–83%; (c) use the 94 human-labeled pairs as the calibration set for the adjudication prompt. These reverse part of D6 and the definition in the TDD, so the TDD stays unchanged until the user approves.
- **Prefix stays as is** (`task: clustering | query: `): the three variants scored the same, so no re-embed.
- **Earlier decisions still stand** (see the superseded handoff): paid Gemini tier with a $5 key cap; embeddings approved; the usage ledger and pacing; `relaxed_order` iterative HNSW scans in `store-db.ts`; ties break to the bigger story; one assignment core shared by production and the replay harness.

## Open questions / issues

1. **Is the tightened "same story" wording approved?** Suggested content: same specific event, reported in a short span; follow-ups, reactions, consequences, other angles and background count as related. The user must approve the exact text, because it goes into the TDD and every LLM prompt. Resolver: the user.
2. **Window length.** The user believes same-story articles come within hours; the data (8 of 16 `same` pairs more than 12h apart) disagrees. Offered but not done: show those 8 pairs so the user can judge whether they are real same-event pairs or timestamp artifacts. Then sweep the window against labels. Resolver: the user, then a sweep.
3. **Silver reliability.** gpt-4o-mini over-calls `same`. The 206 pairs without a human label carry silver labels, so the baseline numbers above are noisy. Re-labeling them with the tightened prompt (about $0.03) and scoring it on the 94 human labels would fix and measure this. Needs the user's approval to spend.
4. **Small samples.** 62 `same` pairs total and 16 human `same` pairs make the metrics rough; decide whether to label more pairs (the labeling UI is at `/admin/label`; `pnpm eval:pairs --seed N` makes a new set).
5. **Candidate K = 10 slot dominance** (TDD risk row): one big story can fill the 10 neighbor slots. A K control for the explorer was proposed and the user has not answered.
6. **Cost-bar question** (carried over): the combined clustering plus summaries cost against the $0.50/day bar; the user has not decided whether to change it. Adjudication alone looks like cents a day.
7. **Backups:** Supabase free plan has none; the periodic `feed_items` export is not built.
8. **`gemini-3.5-flash-lite` limits** unread; check them through the usage ledger once the user approves a first call.
9. **Explorer and labeling UI** were verified through route/page renders and unit tests; an agent has not driven them in a browser (the user has used `/admin/label`). The explorer's title search matches raw titles, not cleaned ones (minor).
10. **MCP disconnects:** the Supabase and Notion MCP servers disconnected late in the session; production DB access from scripts still works through `DATABASE_URL`.

## Relevant docs

1. `docs/story-clustering-v1/plan.md`: status of record; Phase 2 items are all ticked, Phase 3 is next.
2. `docs/story-clustering-v1/tdd.md`: design, decisions D1–D30, the "What counts as the same story" definition (to be revised), and the measured threshold results in the unknowns table.
3. `eval/labels-2026-10-06.jsonl`: the 94 human and 300 silver labels (committed); `eval/pairs-2026-10-05.jsonl`: the 300 pairs with snippets; `eval/snapshot-2026-10-05.jsonl`: the frozen 6,301-article snapshot (gitignored, rebuild with `pnpm eval:snapshot`).
4. `lib/eval/silver.ts` (the current prompt, v1) and `scripts/silver-label.ts`: what to tighten and re-run; `lib/llm.ts`, `lib/llm-config.ts`: client, providers, prices.
5. `lib/pipeline/assign.ts`: the assignment core where the band logic lives; `lib/eval/explore.ts`, `app/admin/explore/*`: the threshold explorer; `app/admin/label/*`, `lib/labeling.ts`: the labeling UI.
6. Commands: `pnpm test` (157 tests), `pnpm eval:cluster --snapshot eval/snapshot-2026-10-05.jsonl --labels eval/labels-2026-10-06.jsonl --t-high 0.9 --t-low 0.9 --window-hours 12` (any flags; pass them as separate arguments), `pnpm eval:silver` (dry run; `--confirm` spends), `pnpm eval:prefix eval`, `pnpm usage`, `pnpm dev` then `/admin/explore` and `/admin/label`.
7. `AGENTS.md`, `docs/AGENTS.md`: repo rules; Next 16 differs from training data (read `node_modules/next/dist/docs/` before Next code); never commit to `main`; do not push until the feature is complete.
8. Memory folder: `feedback_flash_lite_needs_approval`, `story-clustering-v1-quota-findings`.
