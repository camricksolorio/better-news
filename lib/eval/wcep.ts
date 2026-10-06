// Pure helpers for the WCEP converter (scripts/wcep-convert.ts). Only editor-cited articles (origin "WCEP")
// are used; the Common Crawl additions are auto-attached and noisy (D36).

export type WcepArticle = { url: string; title: string; text: string; time: string | null; origin: string };
export type WcepEvent = { id: number; date: string; category: string; articles: WcepArticle[] };

export type PublicArticle = { id: string; title: string; source: string; time: string; snippet: string };
export type PublicPair = {
  a: string;
  b: string;
  label: "same" | "different";
  kind: "event" | "same-day-category";
  eventA: number;
  eventB: number;
  article: { a: PublicArticle; b: PublicArticle };
};

// Category labels have typos and trailing spaces ("Armed conflict and attacks", "Art and culture"). The first three letters separate them.
export function normalizeCategory(raw: string): string {
  return raw.trim().toLowerCase().slice(0, 3);
}

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// WCEP's per-article `time` is unreliable (often crawl time, years off), so articles carry the event's WCEP day instead.
// This dataset cannot test the 12h window; it only tests same-event vs different-event judgment.
function toPublic(a: WcepArticle, date: string): PublicArticle {
  let source = a.url;
  try {
    source = new URL(a.url).hostname.replace(/^www\./, "");
  } catch {}
  return { id: a.url, title: a.title.trim(), source, time: `${date}T00:00:00.000Z`, snippet: a.text.replace(/\s+/g, " ").trim().slice(0, 300) };
}

const STOPWORDS = new Set("the of and to in a is that for on with as was by at from it his her he she they said has have be are this an after but not their will who were its been more than about over".split(" "));
const JUNK_HOSTS = /(^|\.)(twitter\.com|facebook\.com|youtube\.com|instagram\.com|nhc\.noaa\.gov|weather\.gov)$/;
const JUNK_TEXT = /are you a robot|enable javascript|access denied|just a moment|captcha|verify you are human|subscribe to (continue|read)|add this (tweet|video) to your (web)?site|this (tweet|video) is unavailable/i;

// A page that is not an English news article: boilerplate, a social embed, a data bulletin, a non-English page, or a truncated title.
export function isJunk(a: { url: string; title: string; text: string }): boolean {
  let host = "";
  try {
    host = new URL(a.url).hostname;
  } catch {}
  if (JUNK_HOSTS.test(host)) return true;
  const head = `${a.title} ${a.text.slice(0, 600)}`;
  if (JUNK_TEXT.test(head) || /(\.\.\.|…)$/.test(a.title.trim())) return true;
  const words = a.text.toLowerCase().match(/[a-z']+/g)?.slice(0, 80) ?? [];
  return words.length < 40 || words.filter((w) => STOPWORDS.has(w)).length / words.length < 0.2;
}

const usable = (a: WcepArticle) =>
  a.origin === "WCEP" && a.title?.trim().length > 0 && (a.text ?? "").trim().length >= 200 && !isJunk({ url: a.url, title: a.title, text: a.text });

export type BuildOptions = { maxPositivesPerEvent?: number; negativesPerPositive?: number; seed?: number };

// Positives: pairs of cited articles of one event. Negatives: articles of two different events listed on the same
// WCEP day in the same category, which is where an embedding model is most likely to confuse events.
export function buildPairs(events: WcepEvent[], opts: BuildOptions = {}): PublicPair[] {
  const { maxPositivesPerEvent = 3, negativesPerPositive = 1, seed = 1 } = opts;
  const rand = rng(seed);
  const seen = new Set<string>();
  const clean = events
    .map((e) => ({
      ...e,
      articles: e.articles.filter(usable).filter((a) => (seen.has(a.url) ? false : (seen.add(a.url), true))),
    }))
    .filter((e) => e.articles.length > 0);

  const make = (x: WcepArticle, y: WcepArticle, label: PublicPair["label"], kind: PublicPair["kind"], ex: WcepEvent, ey: WcepEvent): PublicPair => {
    const [a, b] = x.url < y.url ? [x, y] : [y, x];
    const [eA, eB] = x.url < y.url ? [ex, ey] : [ey, ex];
    return {
      a: a.url,
      b: b.url,
      label,
      kind,
      eventA: eA.id,
      eventB: eB.id,
      article: { a: toPublic(a, eA.date), b: toPublic(b, eB.date) },
    };
  };

  const pairs: PublicPair[] = [];
  for (const e of clean) {
    const all: [WcepArticle, WcepArticle][] = [];
    for (let i = 0; i < e.articles.length; i++) for (let j = i + 1; j < e.articles.length; j++) all.push([e.articles[i], e.articles[j]]);
    for (const [x, y] of shuffle(all, rand).slice(0, maxPositivesPerEvent)) pairs.push(make(x, y, "same", "event", e, e));
  }

  const buckets = new Map<string, WcepEvent[]>();
  for (const e of clean) {
    const key = `${e.date}|${normalizeCategory(e.category)}`;
    buckets.set(key, [...(buckets.get(key) ?? []), e]);
  }
  const eligible = [...buckets.values()].filter((b) => b.length >= 2);
  const wanted = pairs.length * negativesPerPositive;
  const used = new Set<string>();
  let attempts = 0;
  let made = 0;
  while (eligible.length && made < wanted && attempts++ < wanted * 20) {
    const bucket = eligible[Math.floor(rand() * eligible.length)];
    const [e1, e2] = shuffle(bucket, rand);
    const x = e1.articles[Math.floor(rand() * e1.articles.length)];
    const y = e2.articles[Math.floor(rand() * e2.articles.length)];
    const key = [x.url, y.url].sort().join("|");
    if (used.has(key)) continue;
    used.add(key);
    pairs.push(make(x, y, "different", "same-day-category", e1, e2));
    made++;
  }
  return pairs;
}
