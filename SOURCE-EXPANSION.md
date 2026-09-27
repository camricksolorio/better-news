# Source expansion recommendations

Context for whoever picks this up: the MVP ingests from `feeds.config.ts` via
`app/api/ingest/route.ts` (generic RSS fetch + parse + upsert-by-guid into
`feedItems`). As of this writing `FEED_SOURCES` has 5 entries — 4 NYT verticals
(US, Business, Economy, Technology) plus Yahoo Finance News. That's
effectively one editorial voice plus a finance aggregator.

Two project goals this doesn't serve yet:
1. Match "The Daily News" (NYT's own app)-level breadth across categories and
   US + key international coverage.
2. Long-term: cluster similar articles across outlets (Ground News-style).
   Clustering needs multiple *independently-owned* newsrooms covering the
   same story — one publisher's verticals give the model nothing to cluster.

## Key constraint found during research

Reuters and AP do **not** have official public RSS feeds anymore (Reuters
killed theirs around 2020; AP never had reliable official ones). Feeds
labeled "Reuters RSS" / "AP RSS" on aggregator sites are unofficial
scrapers — don't build ingestion on them. Recommendation below leans on
outlets with stable, official RSS instead of chasing wire-service feeds.

Some paywalled outlets (WSJ, Bloomberg, CNBC, Washington Post) return 403 to
a naive fetch and need a real User-Agent/header set — same pattern the
ingest route already uses for NYT (`User-Agent: better-news-ingest/1.0`
worked there; these may need a browser-like UA instead). Flagged as
"needs live fetch test," not confirmed working, in the table below.

## Confirmed live via direct fetch during research

| Source | URL | Notes |
|---|---|---|
| NPR — World | `https://feeds.npr.org/1004/rss.xml` | valid RSS 2.0, confirmed |
| Al Jazeera English — All | `https://www.aljazeera.com/xml/rss/all.xml` | valid RSS 2.0, confirmed |
| Fox News — Latest | `https://moxie.foxnews.com/google-publisher/latest.xml` | valid RSS 2.0, confirmed |
| CBS News — Main | `https://www.cbsnews.com/latest/rss/main` | valid RSS 2.0, confirmed |

(BBC and Guardian feed URLs were blocked by this session's fetch tool for
policy reasons, not because the feeds are dead — they're extremely
well-established, stable feed URLs. Worth testing directly from the app's
own server-side fetch rather than assuming they don't work.)

## Full recommended list, by category

### Neutral / wire-adjacent baseline
- NPR — Top stories: `https://feeds.npr.org/1001/rss.xml`
- NPR — Politics: `https://feeds.npr.org/1014/rss.xml`
- NPR — World: `https://feeds.npr.org/1004/rss.xml` (confirmed)
- PBS NewsHour: `https://www.pbs.org/newshour/feeds/rss/headlines`
- CBS News — Main: `https://www.cbsnews.com/latest/rss/main` (confirmed)
- Axios: `https://api.axios.com/feed/`

### Left-of-center (pairs against existing NYT sources, not a duplicate)
- The Guardian — US: `https://www.theguardian.com/us-news/rss`
- The Guardian — World: `https://www.theguardian.com/world/rss`
- Washington Post — World: `https://feeds.washingtonpost.com/rss/world` (needs live fetch test — 403 on naive fetch)
- CNN — Top Stories: `http://rss.cnn.com/rss/cnn_topstories.rss`

### Center-right / right (currently zero representation — biggest gap)
- Wall Street Journal — World News: `https://feeds.a.dj.com/rss/RSSWorldNews.xml` (headlines free even though articles paywall; needs live fetch test)
- Fox News — Latest: `https://moxie.foxnews.com/google-publisher/latest.xml` (confirmed)
- New York Post: `https://nypost.com/feed/`
- Washington Examiner: `https://www.washingtonexaminer.com/feed`
- The Hill: `https://thehill.com/feed/` (leans center; useful connective tissue between left/right coverage of the same DC story)

### International (currently zero — explicit project scope)
- BBC — World: `https://feeds.bbci.co.uk/news/world/rss.xml` (needs live fetch test in this repo's environment)
- Al Jazeera English — All: `https://www.aljazeera.com/xml/rss/all.xml` (confirmed)
- Deutsche Welle — All: `https://rss.dw.com/rdf/rss-en-all` (Germany/EU vantage)
- France 24 — English: `https://www.france24.com/en/rss` (France/EU vantage)
- Nikkei Asia: `https://asia.nikkei.com/rss/feed` (Asia vantage)
- South China Morning Post — China: `https://www.scmp.com/rss/91/feed` (Asia vantage, alt to Nikkei)
- The Hindu — National: `https://www.thehindu.com/news/national/feeder/default.rss` (South Asia vantage)

### Business/tech depth (existing: NYT Business/Economy/Tech, Yahoo Finance)
- CNBC — World: `https://www.cnbc.com/id/100003114/device/rss/rss.html` (needs live fetch test — 403 on naive fetch)
- Bloomberg — Markets: RSS mostly retired; needs verification, may require alt source
- TechCrunch: `https://techcrunch.com/feed/`
- Ars Technica: `https://feeds.arstechnica.com/arstechnica/index`
- The Verge: `https://www.theverge.com/rss/index.xml`
- Financial Times — Home (headlines): `https://www.ft.com/rss/home` (needs live fetch test)

## Suggested target composition

~20-24 sources total (up from 5). Prioritize spread over raw count: enough
left/center/right coverage of US politics and enough distinct national
vantage points on international stories that two articles about the same
event are meaningfully different inputs for future clustering — not 20 feeds
that all reprint the same syndicated copy.

## Next steps for whoever picks this up

1. Test the "needs live fetch test" URLs directly from this app's server
   (or a similar environment/UA) — some paywalled sites 403 generic fetchers
   but allow a browser-like User-Agent.
2. Add confirmed-working entries to `feeds.config.ts` (same `{id, label, url}`
   shape already used).
3. Consider whether `feedItems` / ingest route need a `lean` or `category`
   column now, before volume grows — retrofitting source metadata after
   ingesting thousands of rows is more painful than adding it now, and the
   clustering work will eventually want it (e.g. to show "here's the
   left/center/right coverage of this story").
