# Story Clustering v2 — PRD

| | |
|---|---|
| **Author** | Claude (Sonnet 5.5), with Camrick Solorio |
| **Created** | 2026-10-24 |
| **Status** | Accepted (2026-10-24), including the numeric targets marked *(proposed)* in R1, R2 and R7 |
| **References** | Builds on [story-clustering-v1](../story-clustering-v1/tdd.md) · Blocks [story-summary-v1](../story-summary-v1/tdd.md) · Research: [story-clustering-sota](../../research/story-clustering-sota.md) |

## Problem

Better News exists so a reader sees several editorial voices on **one** story. Clustering v1 groups articles with the same specific event, but it routinely splits a single event across several stories, so the reader sees the same event as three to six small cards, each with only one or two outlets. This defeats the product's purpose (the multi-outlet comparison is the whole value), and it blocks the next feature: the story summarizer cannot be evaluated or shipped on stories that are fragments of the real story.

**Who it affects.** Every reader of the feed, and the operator, who cannot build a trustworthy golden dataset for summaries because a "story" is not a stable unit. It was found while preparing that dataset, which is why [story-summary-v1](../story-summary-v1/tdd.md) is paused.

**How often.** Production data as of 2026-10-24 (read-only query):

- 26,787 articles clustered into 23,321 stories. Only 1,991 stories (8.5%) have two or more articles, and only 3,466 articles were joined to an existing story by the classifier. Most single-article stories are legitimately alone (one outlet's local or niche piece), but every one of the examples below that we traced by hand was a fragmented major story, not a lone story.
- Three of the three major stories of the past week that we traced were fragmented: Alaska DOJ suit (11 outlets, 5 stories), Canada tariff rollback (about 11 outlets, 6 stories), and the Starlink slowdown report (outlets split into at least 4 stories). See [Examples](#examples).
- We do not yet know the true rate. Measuring it is itself a requirement (R1), because v1 measured precision but explicitly set no bar and built no measurement for recall.

**How significant each time.** Two failures with different costs:

- **Split (low recall).** The reader sees the same event as several cards with 1–2 outlets each instead of one card with 7–11. The comparison the product promises is hidden, and summaries (which require at least two outlets) cannot be generated for most fragments.
- **Wrong join (low precision).** One article is attached to a story about a different event. In the Alaska example, a Guardian live blog now titled "Ramaswamy accuses Acton of 'lying' about attack ad" sits inside the Alaska DOJ story, and then vetoed the correct join of the Guardian's real Alaska article. One bad join damages trust more than a split does, and also causes further splits.

v1 deliberately favoured precision (v1 D5) and its threshold was provisional. v2 must keep the precision bar and raise recall to a level where major stories appear as one story.

### Root causes found so far

From tracing the Alaska clusters through the decision log (`story_assignments.llm_verdict`). Hypotheses are marked.

1. Only the single best-scoring candidate story is considered for each article, so early small fragments can outrank the main story for later articles.
2. The similarity cutoff (τ = 0.93) is provisional, tuned on 8 human-labelled `same` pairs, and sits just above real same-event scores (0.89, 0.84, 0.73).
3. A wrongly joined article becomes the "closest member" a later correct article is compared against, and vetoes the correct join. One error causes more.
4. **Hypothesis, unconfirmed:** ingest overwrites an article's title, description and publish time when the feed changes, and the text the classifier saw is not stored. A live blog retitled after clustering would look misclustered with no way to prove it.
5. By design, a story only accepts articles within 12 hours of its first article, so later arrivals about the same event start new stories (the Washington Examiner's Canada tariff article arrived 19 hours after the story's first article).
6. By design, analysis, explainers and reactions are `related`, not `same`. This is a good rule, but it makes "is this the same event?" a judgment the system gets wrong in both directions on the edges.

## Examples

All times UTC, 2026-10-23/24, taken from the production database. These are the cases v2 must fix, and the seed for the golden evaluation set.

### 1. Alaska DOJ lawsuit: one event, 11 outlets, 5 stories

Event: the Justice Department sues to block certification of Alaska's Senate result if the Republican loses; Trump says he ordered it.

| Story | Outlets | Notes |
|---|---|---|
| `78530a03` (main) | PBS, The Hill, Al Jazeera, Axios, CNBC, CBS, **Guardian live blog** | The Guardian entry (02:01, "Ramaswamy accuses Acton…") is a **wrong join** |
| `50d8bf4a` | BBC (18:49), NYT (02:15) | Should be in main |
| `59a81d86` | The Hill (19:23), Washington Examiner (20:57) | Should be in main (The Hill's other article is already there) |
| `2b287942` | Guardian (19:46), FT (23:06) | Should be in main; the Guardian's correct article was rejected |
| `dcfd61df` | PBS (22:55) | Second PBS article, a single-article story |

Expected: one story with the 11 outlets (the Guardian live blog excluded). Observed: the reader sees five cards, none showing more than 7 outlets, and one of those is wrong.

### 2. Canada tariff rollback for Maine's Susan Collins: one event, about 11 outlets, 6 stories

Event: Trump exempts some Canadian goods from tariffs ahead of the Maine race.

| Story | Articles |
|---|---|
| `7b0933a9` (main) | SCMP, NYT, DW, Guardian, FT (5 outlets) |
| `8f357868` | CNBC, "…but 'replacing' them with other products" |
| `588dc5a5` | The Hill, "Collins says certain Canadian goods now tariff-exempt" |
| `f46a7b2e` | PBS, "Seeking to help Collins in Maine, Trump exempts some Canadian imports…" |
| `b0b79549` | BBC, "White House lifts tariffs on some Canadian goods…" |
| `0741f578` | Washington Examiner, arrived 19h after the story's first article |

Expected: at least 9 outlets in one story. Observed: five outlets in the main story, and the rest scattered as one-article stories. CNBC's title mentions tariffs being "replaced", which is arguably a new angle, so the correct treatment is part of what the labelling should settle.

### 3. Starlink slowdown (WSJ report): one event, outlets split across at least four stories

Event: the WSJ reports Musk ordered a Starlink slowdown in Ukraine (2026-10-20/21).

| Story | Articles |
|---|---|
| `992bf9fd` (main) | The Hill, SCMP, CBS (two articles) |
| `4e1d7378` | DW, 03:00 |
| `81eee11b` | Ars Technica, 18:35 (22h after first article, outside the window) |
| `37e11ab8`, `8e427989` | The Hill pieces on Democrats and a GOP rep calling for an investigation (reactions, so correctly `related`) |

Expected: DW and Ars Technica join the main story; the investigation-call pieces stay separate (follow-ups, per the v1 definition). This example shows both halves of the problem: DW and Ars are missed joins, while the reaction pieces are correctly kept apart, so v2 must not fix recall by lumping follow-ups in.

### 4. Not yet characterised

The handoff notes the press-corps and bond-hearing stories had no cluster with two or more outlets from a quick title search. Whether those are clustering failures or ingestion gaps is unknown and is part of R1.

## Approach

**What changes for the reader.** A major news event appears as **one story card with all the outlets that covered it**, not as a handful of near-duplicates. Reaction pieces, analysis and later developments continue to appear as their own stories (the v1 definition of "same story" stands), but they do not hide the original reports. A story never contains an article about a different event.

**What changes for the operator.**

- A way to measure how often an event is split or wrongly joined, on a fixed set of real events, with a single number for each, so improvements are demonstrable instead of eyeballed.
- For any article, the operator can see what text the system judged it on, and why it was or wasn't grouped, including when the article later changed.
- A way to repair existing fragmented stories (merge the pieces of Alaska, Canada tariffs and Starlink), since stories already in the database were produced by the v1 behaviour and v1 never revisited them.
- The golden dataset for summaries can be built from stories that are complete.

**Process.** Work starts by assembling a labelled set of real multi-outlet events (the three examples above are the seed) and measuring v1 against it. Fixes are then judged against the measurement: a change is kept only if recall improves without precision dropping below the bar. The specific mechanisms (candidate selection, thresholds, windowing, re-clustering strategy) are decided in the TDD.

### Alternatives considered

- **Only lower the similarity threshold.** Rejected: v1 measured that same-event and related pairs overlap almost completely in similarity score, so lowering the cutoff trades splits for wrong joins, which hurt more.
- **Ship summaries on current stories and accept fragments.** Rejected: the summarizer cannot be evaluated against golden summaries when the story is a fragment, and the multi-outlet comparison is the product.
- **Widen the story time window only (for example 36h or longer).** Rejected as a sole fix: it addresses cause 5 only, and v1 chose 12h specifically to stop follow-ups from joining the original event. It may be part of the answer if measured to keep precision.
- **Replace the incremental design with batch re-clustering of a rolling window** (the SOTA report's micro-batch and graph approaches). Not decided. It directly addresses order dependence (causes 1 and 3) but is a larger change and must be weighed in the TDD against fixing the incremental path. This PRD does not prescribe the mechanism.
- **Cluster on full article text instead of title and description.** Rejected for v2: out of scope for v1 (D1) for cost and paywall reasons, and no evidence yet that thin text is the main cause. Revisit if measurement shows it is.
- **Fix it by hand per story in the admin tool.** Rejected as the plan, kept as a tool: it does not scale with 30+ outlets and cannot fix future stories.

## Requirements

Targets marked *(proposed)* are the author's suggestion and need the owner's approval before the TDD.

- **R1. Measurable fragmentation.** The operator can run one command that reports, over a frozen labelled set of multi-outlet events, (a) **event recall**: for each labelled event, the share of its labelled outlets/articles that sit in its single largest story, and (b) **split count**: how many stories each event is spread over. It also reports pairwise precision and related-leak as defined in v1. The labelled set contains at least the three events in [Examples](#examples) and grows to at least 30 events *(proposed)*.
- **R2. Major events appear as one story.** On the labelled set, mean event recall is at least 0.85 and at least 80% of events have all their labelled articles in at most 2 stories *(proposed)*.
- **R3. Precision does not regress.** Pairwise precision stays at or above 0.95 and related-leak at or below 10%, confirmed by a person checking a random sample of the system's joins (the v1 bar, unchanged).
- **R4. No error cascades.** An article that is wrongly joined to a story does not block later correct articles from joining the right story. Verified by the Alaska case: the Guardian's correct Alaska article joins the main Alaska story even when a wrong article is present.
- **R5. Follow-ups stay separate.** Reaction, analysis and consequence pieces about an event are still not merged into the event's story (v1 definition of "same story" unchanged). Verified by the Starlink investigation-call pieces staying outside the main Starlink story.
- **R6. Late arrivals.** An article about an event that arrives after the 12h story window, or from an outlet whose feed lags, can still join the story it belongs to, provided it reports the same event. Verified by the Washington Examiner (Canada tariffs) and Ars Technica (Starlink) articles.
- **R7. Order independence.** The same set of articles produces equivalent stories regardless of arrival order. Verified by clustering a labelled set in shuffled orders and reporting the spread of R1's metrics across them *(proposed: no more than 0.03 spread in event recall)*.
- **R8. Auditable decisions.** For any assignment, the operator can see the exact title and description the decision was made on, the candidates considered, and the verdict for each, even if the article was later edited by its feed. Verified on a re-clustered article after its title is changed in the database.
- **R9. Repair existing stories.** The three example events, and then the rest of the labelled set, can be corrected in the production data: fragments merged and wrong joins removed. The repair is logged and reversible, and does not discard human labels or manual corrections (v1 R7). Verified by the example events appearing as expected in the feed afterwards.
- **R10. Cost and runtime.** Total clustering running cost stays under $0.50/day (v1 bar), and a cluster run still completes within the existing six-hour cron cadence without manual intervention.
- **R11. Unblocks summaries.** After v2, the golden-dataset stories for story-summary-v1 can be taken from stories that pass R1's checks for their event, and the Phase 1 evaluation in that feature resumes.

### Acceptance Criteria

- **R2, R4, R6.** As the operator, when I run the evaluation against the Alaska DOJ event, I see one story containing BBC, NYT, FT, The Hill, Washington Examiner, Guardian (correct article), PBS, Al Jazeera, Axios, CNBC and CBS, and no Guardian live-blog article about Ramaswamy.
- **R2, R6.** As the operator, when I run the evaluation against the Canada tariff event, the main story contains at least 9 of the 11 outlets, including the Washington Examiner despite its late arrival.
- **R5.** As the operator, when I run the evaluation against the Starlink event, DW and Ars Technica are in the main WSJ-report story, and the two "investigation" reaction pieces are in separate stories.
- **R1, R3.** As the operator, I get a report that shows recall and precision together, so I cannot raise one without seeing the other.
- **R8.** As the operator inspecting a story, I can click any article to see the text it was judged on at the time and the other stories it was compared with.
- **R9.** As a reader, after the repair, the feed shows one Alaska DOJ card instead of five.
