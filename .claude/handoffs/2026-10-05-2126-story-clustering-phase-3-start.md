# Handoff: story-clustering-v1, Phase 3 implementation start

| | |
|---|---|
| **Date** | 2026-10-05 21:26 (local) |
| **Branch / HEAD** | `feat/story-clustering-v1` @ `77df778` (not pushed; the user said not to push or open a PR until the feature is complete) |
| **Working tree** | Clean apart from this handoff file (uncommitted) |
| **Feature docs** | `docs/story-clustering-v1/` (`tdd.md`, `plan.md`; no `prd.md`) |
| **Supersedes** | `.claude/handoffs/2026-10-05-2054-story-clustering-labeling-findings.md` (background on Phases 1–2 and the labeling results) |

## Summary

The goal is story clustering with **≥ 95% precision**. Wrongly merging two events breaks reader trust, and recall has no bar. This session turned the labeling findings into an approved design: embeddings only retrieve a candidate story, and a classifier model decides every join by comparing the article with the story's first article and its most similar member. The window is 12h, and the final precision comes from a human audit of ~150 joins. The TDD and plan are updated and committed. Phase 3 implementation has not started.

## Current state

Status of record is `docs/story-clustering-v1/plan.md`, section "Phase 3 — LLM adjudication". It has five groups:

1. [x] **Decisions and docs.** The user approved everything below; TDD D31–D37 added, D4 and D6 superseded; committed as `77df778`.
2. [ ] **Development data** (the user calls this "step 2a"):
   - Show the user the 8 human `same` pairs that are > 12h apart.
   - SemEval-2022 Task 8 download and convert script.
   - WCEP script.
   - Spot-check converted pairs against the D31 definition.
   - Re-silver the 206 silver-only pairs (needs a cost go-ahead).
3. [ ] **Adjudicator:**
   - Add the `jev` provider.
   - Write the `adjudicate()` wrapper and prompt v2.
   - Pairwise verdict cache.
   - Model comparison.
   - Pick the model and τ.
4. [ ] **Assignment:**
   - `lib/pipeline/assign.ts`: remove `tHigh`, set `tLow` 0.84 and `windowHours` 12, add the two-member classifier check.
   - Harness flags.
   - K control.
5. [ ] **Tuning and audit:** sweep, join-audit queue, exit.

Tally: 1 of 5 Phase 3 groups done; Phase 4 not started.

**Next action:** start "Development data". First show the user the 8 human `same` pairs more than 12h apart (from `eval/labels-2026-10-06.jsonl` joined with `eval/pairs-2026-10-05.jsonl`) and ask whether the timestamps look wrong. Then write the SemEval-2022 Task 8 fetch-and-convert script into `eval/public/` (gitignored).

These can be done in parallel with no spend:
- the `jev` provider, after reading TypeSafe's docs;
- the `adjudicate()` wrapper with fakes;
- the `assign.ts` changes and tests.

## Key decisions and why

All are in `tdd.md` `#### Design decisions`; summarized here so they aren't relitigated:

- **D31 Definition** (user-approved wording, used word for word in labels and prompts): only reports of the same specific event are `same`. Follow-ups, reactions, consequences, background, **analysis and opinion** are `related`. When in doubt, `related`. Reason: the user's labeling bar; the old looser definition made silver over-call `same`.
- **D32 No embedding-only joins.** Human `same` (0.851–0.952) and `related` (0.806–0.954) overlap in similarity. The best embedding-only precision was 78–83%. Embeddings give the candidate plus a floor `T_low` 0.84.
- **D33 Window 12h** from the first article (was 36h). Swept at 12/18/24/36h; keep 12h unless longer keeps precision ≥ 0.95. Known tension: 8 of 16 human `same` pairs are > 12h apart.
- **D34 Two-member check.** The article must be judged `same` vs the story's first article **and** its most similar member (one call if they're the same article), each with `p_same ≥ τ`. A call failure leaves the article unclustered (never a new story). No fallback to a different model, since τ is per model.
- **D35 Model choice by comparison:** `gpt-4o-mini` (prompt v2), `gemini-3.5-flash-lite`, jev (TypeSafe), and two-model agreement. τ = the lowest threshold giving ≥ 0.97 precision on development data.
- **D36 Public datasets for development only:** SemEval-2022 Task 8 (English pairs) and WCEP (editor-cited articles only; same-day, same-category different-event pairs as hard negatives). The user's 94 human labels are the reference, win on conflict, and are never used as prompt examples. `multi_news` was rejected: it has no negatives and its groups mix background and follow-ups. This replaces labeling ~200 more pairs.
- **D37 Ship-bar measurement:** a human audits ~150 random joins from a snapshot replay. Report precision with an exact 95% lower bound (≤ 2 errors in 150 for the bound to clear 0.95). Recall is reported but has no bar.
- **Spend rule (standing; memory `feedback_flash_lite_needs_approval`):** state the call and expected cost, then wait for a yes. Already approved: running the comparison candidates on the 94 human-labeled pairs. Still needs approval: re-silvering the 206 pairs (~$0.03) and runs on public development data (~$0.05 jev, ~$0.30 gpt-4o-mini, ~$0.75 flash-lite at ~2,000 pairs). Unit tests use fakes.
- **Git:** commit only when the user asks; update `plan.md` in the same commit as code; never push or open a PR until the feature is done.

## Open questions / issues

1. **jev API shape and pricing are unverified.** The only source so far is TypeSafe's launch post: $0.042/1M input tokens, output free, typed schemas, calibrated probabilities, 70–500ms. Read their API docs before writing the provider. `JEV_API_KEY` is in the local `.env` but untested. Resolver: the docs, then one approved test call.
2. **SemEval-2022 Task 8 is distributed as URLs**; many may be dead, and the HF/GitHub distribution format is unchecked. WCEP ships summaries plus fetch scripts only (`github.com/fighting41love/wcep-mds-dataset` was found by search; the canonical repo may differ). Verify before building. Fetching thousands of public news pages is expected and acceptable.
3. **The SemEval score cut points** for `same` / `related` / `different` aren't set; decide after spot-checking converted pairs against D31.
4. **The 12h window vs the data:** the 8 > 12h `same` pairs. The user hasn't seen them yet.
5. **Not built yet:** the periodic `feed_items` export (free Supabase plan has no backups), and `ADMIN_SECRET` on Vercel (the user's call).
6. **The `docs/AGENTS.md` features table** still says clustering is "not yet built", which is stale. A minor fix; ask before editing.

## Relevant docs

1. `docs/story-clustering-v1/plan.md`: Phase 3 checklist (status of record).
2. `docs/story-clustering-v1/tdd.md`, in this order: the definition (top), D31–D37, part 3 "Assign to a story", part 4 (provider table, `adjudicate()`, verdict cache), part 6 (public datasets, data splits, comparison, audit), Risks.
3. `lib/pipeline/assign.ts` (config `tLow` / `tHigh` / `windowHours`; the band logic around line 163), `lib/pipeline/store-db.ts`, `lib/pipeline/cluster.ts`.
4. `lib/llm.ts`, `lib/llm-config.ts` (providers, prices), `lib/eval/silver.ts` (prompt v1 to evolve into v2), `scripts/silver-label.ts`.
5. `eval/labels-2026-10-06.jsonl` (94 human + 300 silver), `eval/pairs-2026-10-05.jsonl` (pairs with snippets), `eval/snapshot-2026-10-05.jsonl` (gitignored; `pnpm eval:snapshot` rebuilds it).
6. Commands:
   - `pnpm test` (157 tests);
   - `pnpm eval:cluster --snapshot eval/snapshot-2026-10-05.jsonl --labels eval/labels-2026-10-06.jsonl --t-low 0.84 --window-hours 12`;
   - `pnpm eval:silver` (dry run; `--confirm` spends);
   - `pnpm usage`;
   - `pnpm dev`, then `/admin/explore` and `/admin/label`.
7. External:
   - SemEval-2022 Task 8 paper: https://aclweb.org/anthology/2022.semeval-1.155.pdf
   - WCEP paper: https://arxiv.org/pdf/2005.10070
   - jev post: https://typesafe.ai/blog/introducing-system-one-models-and-jev
8. `AGENTS.md`, `docs/AGENTS.md`: repo rules. Next 16 differs from training data; read `node_modules/next/dist/docs/` before Next code.
