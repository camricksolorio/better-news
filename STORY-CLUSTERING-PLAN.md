# Story Clustering + AI Summaries — MVP Plan

Goal: group articles from different outlets about the **same event, at one
point in time** into a single `story`, and put an AI-written, source-cited
summary on top. Optimize for **accuracy you can measure** and **near-zero
running cost**.

## Decisions (locked 2026-09-27)

| # | Question | Decision |
|---|---|---|
| 1 | Summary source text | **RSS title + description only.** No full-text fetching. |
| 2 | Minimum outlets for a summarized story | **2 distinct outlets.** |
| 3 | Left/center/right lean labels | **Out of scope.** |
| 4 | Follow-ups ("markets react to X") | **Separate story.** A later layer will link related stories into an evolving event; a story stays scoped to one event at one point in time. |
| 5 | Admin auth | **New `ADMIN_SECRET`.** |

## Where we're starting from

- One table, `feed_items` (~1,065 rows, ~150–400 new/day across 31 feeds).
  All rows were ingested on 2026-09-27, so there's only **one day of pipeline
  history** so far (see Readiness).
- Per article we have only **title + RSS description** (avg ~680 chars; ~9%
  empty or < 40 chars).
- Ingest runs every 6h via GitHub Actions → `/api/ingest` on Vercel Hobby.

## Design principles

1. **Precision over recall.** Grouping two different events together hurts
   trust more than showing one event as two cards. It would also corrupt the
   future event layer, which will be built on top of stories.
2. **Cheap signal first, LLM only for the hard cases.** Embeddings decide
   the clear matches and clear non-matches. An LLM sees only the ambiguous
   middle.
3. **Log every decision**: score, method, and LLM reasoning, so a bad cluster
   can be explained.
4. **Eval before tuning.** Build the labeled set and replay harness first, so
   every change produces a number.
5. **Stories are closed, point-in-time objects.** A story has a fixed time
   window and then stops accepting articles. That keeps each story to one
   event and gives the future event layer clean, stable units to link.

## Definition of "same story"

This goes into the LLM prompt and the labeling UI word for word:

> Two articles are the **same story** if their main subject is the **same
> specific development**: the same announcement, incident, ruling, vote,
> release, or statement, reported around the same time.
>
> - **Same:** different outlets' news reports on that development, and
>   analysis or opinion pieces whose main subject is that development.
> - **Related, not same:** reactions, consequences, and new developments that
>   follow from it ("markets slide after Fed hike", "White House responds to
>   ruling", "suspect charged" after "shooting at X").
> - **Different:** same topic, different development ("Fed hikes" vs "ECB
>   holds"; two separate storms).

Approved: analysis/opinion pieces *about* the
development count as the same story. They add framing diversity and don't
report a new development.

**Labels are three-way: `same` / `related` / `different`.** `related` counts
as "should not merge" in every metric. We still record it separately because
those pairs are free training and eval data for the future event layer.

## Architecture

```
GH Actions cron (every 6h)
  └─ /api/ingest     (existing)  → feed_items
  └─ /api/cluster    (new)       → embed new items, assign to stories, close expired stories
  └─ /api/summarize  (new)       → (re)summarize stories that changed
```

Each step is **idempotent, batched, and resumable**. It processes rows not
yet handled (`clustered_at IS NULL`, `summary_stale = true`), caps its work
per call to stay under the function time limit, and returns
`{ processed, remaining }`. The workflow calls each endpoint in a loop until
`remaining = 0`. The core logic lives in `lib/pipeline/*` so local scripts
(backfill, eval replay) reuse it without HTTP.

### 1. Normalize + embed

- `lib/text.ts`: strip HTML/entities from `summary`, collapse whitespace,
  and drop boilerplate ("Continue reading…", "The post X appeared first on Y").
- Dedupe by canonical link (strip query/utm params), so one outlet's article
  in two feeds (e.g. `nyt-us` + `nyt-business`) counts once.
- Embedding input: `title + "\n\n" + cleanSummary.slice(0, 1000)`.
- Model: **`gemini-embedding-001`** at 768 dims, task type `CLUSTERING`
  (verified working with our key). `gemini-embedding-2` is also available.
  Compare the two in the Phase 2 baseline and **pick one before
  production**, since switching later means re-embedding everything.
- Batch calls (≤ 100 inputs/request). ~300 articles/day × ~250 tokens ≈ 75k
  tokens/day.

### 2. Assign to a story

**Story time window:** a story accepts articles whose `published_at` is
within **36h of the story's `first_article_at`**. The window is anchored to
the *first* article, not the latest, so a story can't keep extending itself
with follow-ups. After the window it's `closed` and permanent. Tune 36h in
eval: long enough for slow outlets (international, weeklies), short enough
that coverage the next day falls outside.

For each unclustered article, in `published_at` order:

1. **Candidates:** pgvector kNN (top 10 by cosine similarity) over clustered
   articles whose story is `open` and whose window covers this article's
   `published_at`.
2. **Score each candidate story** by (a) the article's max similarity to
   the story's members and (b) its similarity to the story centroid. It must
   pass on **both** to join. Requiring both prevents chaining, where
   unrelated articles get pulled in one small step at a time.
3. **Decide by band** (starting thresholds, tuned in eval):
   | Best score | Action |
   |---|---|
   | ≥ `T_high` (~0.88) | auto-join, `method = "embedding"` |
   | `T_low`–`T_high` (~0.75–0.88) | **LLM adjudication** |
   | < `T_low` | new story |

   **Thin articles** (description < 40 chars) never auto-join on embedding
   score alone. Anything above `T_low` goes to the LLM.
4. **LLM adjudication:** send the new article's title + snippet and the
   story's 3 members closest to the centroid, along with the definition
   above. The prompt calls out the related-vs-same line explicitly, since
   our stricter definition makes that the main failure mode. Structured JSON
   output: `{ "relation": "same"|"related"|"different", "confidence": 0-1,
   "reason": string }`. Join only on `same` with `confidence ≥ 0.7`. Model:
   **`gemini-3.5-flash-lite`** (verified working). Expect ~20–35% of articles
   to land here, ~100 short calls/day. The strict definition may push this
   higher; eval will show.
5. On join, update the story: centroid (running mean), `last_article_at`,
   `source_count`, and set `summary_stale = true` if a new outlet was added.
6. **Close** stories whose window has passed (same endpoint, cheap
   `UPDATE`).

Not in the MVP: a **story-merge pass** for when two outlets break an event
at the same moment and create two stories. This lowers recall and gets
logged as a known gap. v1.1 adds a pass that compares open stories' centroids
and reuses the adjudication step.

Not in the MVP, but designed for: the **event layer**. Stories get no
`event_id` column now, since that belongs to that future design. But closed,
point-in-time stories and the `related` labels + `story_assignments` log give
it clean inputs.

### 3. Summarize

- **When:** a story has **≥ 2 distinct outlets** and `summary_stale = true`.
  Debounce: re-summarize only when a new outlet joins or article count has
  grown ≥ 30% since the last summary. When a story closes, one final pass
  runs if it's stale, and then the summary is frozen.
- **Model:** **`gemini-3.8-flash`** via AI Studio (verified working), with
  OpenRouter as fallback/comparison. Model IDs live in config so eval can A/B
  them without code changes.
- **Input:** per article, `[n] Outlet — Title — cleaned snippet`.
- **Output (structured JSON, schema-validated):**
  ```json
  {
    "headline": "neutral, ≤ 90 chars",
    "summary": [{ "text": "one sentence", "citations": [1, 3] }],
    "coverage_notes": [{ "text": "how outlets' framing or emphasis differs", "citations": [2] }]
  }
  ```
  Every sentence must cite articles. Uncited sentences are dropped, and the
  whole summary fails if it cites a nonexistent article.
- **Prompt rules:** use only the provided text; no outside facts; attribute
  contested claims ("Fox reports…"); neutral headline; 3–5 sentences. The
  inputs are snippets, so the summary must stay short and not pad.
- `coverage_notes` compares specific outlets by name. We don't use lean
  labels (out of scope).

### 4. Shared LLM client: `lib/llm.ts`

Both providers expose **OpenAI-compatible** endpoints (OpenRouter natively;
Gemini at `generativelanguage.googleapis.com/v1beta/openai/`, verified). A
~100-line `fetch` wrapper covers chat + embeddings, with no SDK.

- `chat({ provider, model, messages, jsonSchema, purpose })`,
  `embed({ inputs, purpose })`
- Retries with backoff on 429/5xx, per-call timeout, concurrency cap (~5).
- **Every call writes a row to `llm_calls`**: purpose, provider, model,
  tokens in/out, estimated cost (from a price table in config), latency,
  ok/error, related story/article id.
- A **verdict cache** keyed on `(article_id, story_member_ids, model,
  prompt_version)` means eval sweeps and re-runs don't pay twice.

## Schema changes (`db/schema.ts`)

`vector` 0.8.2 is available on our Supabase instance but **not installed**.
It needs `create extension if not exists vector;` once. Drizzle has a
`vector()` column type and a `cosineDistance()` helper.

```
feed_items  (+ columns)
  embedding        vector(768)
  embedding_model  text
  story_id         uuid → stories.id (nullable)
  clustered_at     timestamptz
  canonical_link   text
  HNSW index on embedding (vector_cosine_ops)

stories
  id, created_at, first_article_at, last_article_at
  status               'open' | 'closed'
  window_ends_at       timestamptz        -- first_article_at + window
  centroid             vector(768)
  article_count, source_count
  headline, summary_json (jsonb), summary_model, summarized_at
  summary_stale        boolean
  summary_member_ids   uuid[]             -- membership at summary time

story_assignments      -- append-only decision log
  id, article_id, story_id, created_at
  method        'embedding' | 'llm' | 'new_story' | 'manual'
  top_score, centroid_score
  llm_call_id   → llm_calls.id (nullable)
  llm_verdict   jsonb
  pipeline_version text   -- hash of thresholds + model IDs + prompt versions

llm_calls
  id, created_at, purpose, provider, model,
  input_tokens, output_tokens, cost_usd, latency_ms, ok, error,
  story_id, article_id

eval_pair_labels
  article_a, article_b,
  label 'same' | 'related' | 'different' | 'unsure',
  labeler 'human' | 'model:<id>', note, created_at

summary_evals
  story_id, summarized_at, judge_model,
  faithfulness, coverage, neutrality (1–5), unsupported_claims jsonb
```

**No index on `stories.centroid` (decided 2026-10-03).** Candidate lookup is
a kNN over *articles* (`feed_items.embedding`, HNSW), and the centroid is only
used to score the handful of candidate stories that come back, which is an
exact cosine calculation with no index involved. Open stories are bounded by
the 36h window (a few hundred rows), so even a scan would be milliseconds, and
centroids are rewritten on every join, so an index would add write cost for no
read benefit. Instead, add a btree on `stories (status, window_ends_at)` for
the open-story filter. Revisit only if the v1.1 merge pass or a
centroid-first candidate lookup ends up searching centroids by nearest
neighbor.

**Migrations:** the repo currently uses `db:push` with no `drizzle/`
migrations folder. `push` can't create the extension, and handles an HNSW
index awkwardly. Switch to `db:generate` + `db:migrate`, with a custom SQL
migration for `create extension vector`.

## Evaluation + observability

### Clustering eval

1. **Freeze a snapshot.** `scripts/snapshot.ts` exports ≥ 4 days of
   `feed_items` + embeddings to `eval/snapshot-YYYY-MM-DD.jsonl`. All
   tuning runs against a fixed snapshot.
2. **Label pairs, stratified by similarity:** ~300 pairs across buckets
   (0.6–0.7, 0.7–0.8, 0.8–0.9, 0.9+), plus pairs the pipeline merged.
   **Deliberately oversample likely `related` pairs**: same-topic pairs
   published 12–48h apart, which the strict definition makes the hardest
   case. Random pairs would be ~99% "different" and tell us nothing.
3. **Silver labels, then human verification.** A strong model via
   OpenRouter (not the Gemini family used in the pipeline, to avoid sharing
   blind spots) labels all pairs, which costs about $1–3 once. Then you
   review every silver-vs-pipeline disagreement plus a random ~50 others, to
   measure how reliable the silver labeler is. Human labels always win.
   Budget **~1–2 hours** of your time.
4. **Replay harness:** `pnpm eval:cluster --snapshot … --t-high … --t-low …
   --window-hours …` reports:
   - **Pairwise precision / recall / F1** (headline), with `related` counted
     as a negative
   - **Related-leak rate:** % of `related` pairs wrongly merged (the
     definition-specific failure mode)
   - % of articles reaching the LLM band, LLM calls, and $ per 100 articles
   - The worst false merges and false splits, with titles
5. **Sweep** thresholds + window, and pick the cheapest config that meets
   the bar.

**MVP ship bar (proposed):** pairwise **precision ≥ 0.95**, **recall ≥
0.80**, **related-leak ≤ 10%**, **< $0.50/day** all-in.

### Summary eval

- **Automated judge** (OpenRouter, non-Gemini family): checks each
  sentence against its cited snippets and scores faithfulness, coverage, and
  neutrality. Unsupported claims are listed. It runs on every new summary
  during the MVP and writes to `summary_evals`.
- **Human spot check:** ~20 summaries per model/prompt change.
- **Ship bar:** zero unsupported claims on ≥ 95% of summaries.

### Admin UI (`/admin`, gated by `ADMIN_SECRET`)

- Auth: a `proxy.ts` check (Next 16 renamed Middleware → Proxy) redirects
  to a sign-in page that sets an httpOnly cookie. The Next docs say Proxy
  shouldn't be the only authorization layer, so **every admin server action
  and API route re-checks the secret** too. Add `ADMIN_SECRET` to
  `.env.example`, the local `.env`, and Vercel project env.
- **Stories inspector:** open and closed stories with members, per-member
  score and method, LLM reasoning, summary with linked citations, and judge
  scores. A "doesn't belong" action records a label (`related` or
  `different`) and a `manual` reassignment, so production mistakes become
  eval data.
- **Labeling queue:** side-by-side pairs, keyboard shortcuts `s` / `r` /
  `d` / `u`, with the definition pinned at the top.
- **Cost panel:** `llm_calls` by day × purpose × model.

## Phased rollout

| Phase | Deliverable | Exit criteria |
|---|---|---|
| **1. Foundations** | pgvector + schema + migration workflow; `lib/text.ts`; `lib/llm.ts` + `llm_calls`; embed backfill script (both embedding models on a sample) | All rows embedded; costs visible in `llm_calls` |
| **2. Baseline clustering** | Embedding-only assignment with story windows; snapshot; admin auth + labeling UI; silver labels; replay harness | Baseline P/R/related-leak; embedding model chosen |
| **3. LLM adjudication** | Gray-zone step + verdict cache; sweep thresholds + window | Meets clustering ship bar on snapshot |
| **4. Summaries** | Summarizer + citation validation + judge | Meets faithfulness bar on ~50 stories |
| **5. Wire it up** | `/api/cluster`, `/api/summarize`, workflow steps; stories inspector + cost panel | 3 days unattended, no failed runs, within budget |
| **6. Reader UI** | Home page shows story cards (headline, summary, outlet chips, count), with singletons alongside | Ship |

Phases 1–3 carry most of the risk and change nothing users see.

## Cost estimate (steady state, ~300 articles/day)

| Step | Volume/day | Est. cost/day |
|---|---|---|
| Embeddings | ~75k tokens | ~$0.01 (free tier: $0) |
| Gray-zone adjudication | ~100–150 calls × ~1k tokens | ~$0.01–0.03 |
| Summaries | ~40 stories × ~2 regens × ~3k tokens | ~$0.05–0.10 |
| Summary judge | ~80 calls × ~3k tokens | ~$0.05–0.15 |
| **Total** | | **≈ $0.15–0.30/day** |
| One-time silver labeling | ~300 pairs | ~$1–3 |

These are order-of-magnitude figures. Phase 1 replaces them with real
per-model prices in the config price table.

## Risks

- **Stricter definition = harder problem.** Separating "same" from "related"
  is the hardest judgment for both embeddings and LLMs, since related articles
  have similar vocabulary. Mitigations: anchored time window, three-way LLM
  output, the related-leak metric, and oversampling related pairs in the
  eval set.
- **Snippet quality.** ~9% of articles are thin. Mitigation: they always go
  to the LLM.
- **Split-at-birth stories** (no merge pass in the MVP). Measured by
  recall; v1.1 fixes it if needed.
- **Free-tier rate limits** on AI Studio. Backoff, small batches, OpenRouter
  fallback.
- **Function time limit.** Handled by batched, resumable endpoints.

## Readiness assessment

Checked 2026-09-27 against the live environment:

| Check | Status |
|---|---|
| pgvector on Supabase | ✅ Available (v0.8.2, Postgres 17.6). Not yet installed; Phase 1 installs it |
| `GOOGLE_GEMINI_API_KEY` | ✅ Valid. `gemini-embedding-001` returned a 768-dim vector; `gemini-3.5-flash-lite` and `gemini-3.8-flash` answered via the OpenAI-compatible endpoint |
| `OPEN_ROUTER_API_KEY` | ✅ Valid. Accepted a paid-model request; key limit $100, $0 used |
| Next 16 conventions | ✅ Checked. Admin gating uses `proxy.ts` (not `middleware.ts`) |
| Product decisions | ✅ All 5 locked (above) |
| Eval data | ⚠️ **Only ~1 day of ingestion history.** Feeds only expose their latest N items, so older days are sparse. Need **≥ 4 days of cron ingestion** before freezing the Phase 2 snapshot |
| Gemini billing tier | ✅ **Free tier** (confirmed). Expect per-minute and per-day request caps; `lib/llm.ts` must treat 429 as normal (backoff, then fall back to OpenRouter) and log fallbacks in `llm_calls`. Prompts may be used for training, which is fine for public news |
| Model prices | ❓ Newer models than my reference data (3.5/3.8 Flash). Look up current prices for the config table in Phase 1 |

**Verdict: ready to execute.** Confirmed 2026-09-27: free tier, defaults
approved (opinion/analysis = same story, 36h window, ship-bar numbers), and
label-review time committed. The only remaining gate is time: **Phase 2's
eval snapshot needs ≥ 4 days of ingestion** (earliest ~2026-10-01), and Phase
1 runs in parallel with that.
