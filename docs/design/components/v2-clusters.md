# v2 cluster viewer

Where: `/admin/v2` (`app/admin/v2/page.tsx`), reading `eval/v2-run-*.json` written by `pnpm eval:v2-dump`. An owner-only
evaluation tool (story-clustering-v2 plan, Phase 3), not a reader-facing page. Server-rendered; links and `<details>`
instead of client state.

## Current design

- **Header:** articles replayed, story counts, the settings the run used, and the file and time.
- **Labelled events (default):** a summary bar of every same-event (`in`×`in`) pair across the labelled events, split by why
  the pair is or is not in one story, then one collapsible card per event with the same bar. Opening a card lists the
  event's labelled articles grouped by the story they ended up in, and the unmerged pairs with cosine and `p_same`.
- **All stories:** every story with two or more articles, sortable by size, weakest link, sources or recency, paged.
  Each member shows its mean link strength to the others, and the owner's event label when it has one.
- **Colour:** green merged, blue judged same but not merged, amber judged low, grey unjudged, red never retrieved. The
  same colours in the bar and the legend, so a bar needs no reading of numbers.
- **No data:** a short message saying how to produce the file. Production has no `eval/` directory.

## Decisions and deviations

| Decision | Reason |
| --- | --- |
| Reads a file, not the database | The run is an offline replay of a snapshot; nothing about it exists in production tables yet |
| Cached verdicts only | Viewing must never spend; an uncached pair shows as unjudged |
| Cards content-sized and collapsible | An event has up to 24 articles and 200 pairs; the summary bar answers the question and the detail is one click away |
