// Picks the events the owner labels (story-clustering-v2 TDD part 8): permissive clusters of the snapshot, sampled by
// size. "Permissive" means they deliberately over-merge (connected components of article pairs that are close in
// embedding space and time), so the labeller sees every candidate and decides what is really one event.
import { createHash } from "node:crypto";

export type SampleArticle = {
  guid: string;
  sourceId: string;
  time: string; // ISO, first_published_at
  embedding: number[];
  excludedReason?: string | null;
};

export type Component = { articles: SampleArticle[]; outlets: number };
export type Stratum = "large" | "mid" | "small";

export const MIN_COSINE = 0.85;
export const MAX_GAP_HOURS = 36;

export function strataOf(outlets: number): Stratum | null {
  if (outlets >= 6) return "large";
  if (outlets >= 3) return "mid";
  if (outlets === 2) return "small";
  return null;
}

// 'dev' or 'holdout', fixed by the seed article's guid so a re-run never moves an event between them.
export function splitOf(seedGuid: string): "dev" | "holdout" {
  return createHash("sha256").update(seedGuid).digest()[0] % 2 === 0 ? "dev" : "holdout";
}

export function buildComponents(articles: SampleArticle[], minCosine = MIN_COSINE): Component[] {
  const items = articles
    .filter((a) => !a.excludedReason)
    .map((a) => ({ a, t: new Date(a.time).getTime(), v: Float32Array.from(a.embedding) }))
    .sort((x, y) => x.t - y.t || x.a.guid.localeCompare(y.a.guid));

  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const gap = MAX_GAP_HOURS * 3_600_000;

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length && items[j].t - items[i].t <= gap; j++) {
      let dot = 0;
      let ni = 0;
      let nj = 0;
      const vi = items[i].v;
      const vj = items[j].v;
      for (let k = 0; k < vi.length; k++) {
        dot += vi[k] * vj[k];
        ni += vi[k] * vi[k];
        nj += vj[k] * vj[k];
      }
      if (dot / Math.sqrt(ni * nj) >= minCosine) parent[find(i)] = find(j);
    }
  }

  const groups = new Map<number, SampleArticle[]>();
  items.forEach((it, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), it.a]);
  });
  return [...groups.values()].map((articles) => ({
    articles,
    outlets: new Set(articles.map((a) => a.sourceId)).size,
  }));
}

export type PickedEvent = {
  component: Component;
  stratum: Stratum;
  outlets: number;
  seed: SampleArticle;
  split: "dev" | "holdout";
  example: boolean;
  title: string;
};

export type SampleOptions = {
  perStratum: Record<Stratum, number>;
  seed: number;
  // Events that must be included (the PRD examples): the component holding `seedGuid`, always in 'dev'.
  examples?: { title: string; seedGuid: string }[];
};

// mulberry32: a small seeded generator, so the same seed always draws the same events.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The seed article of an event is its earliest article (ties by guid).
const seedOf = (c: Component) =>
  [...c.articles].sort((x, y) => new Date(x.time).getTime() - new Date(y.time).getTime() || x.guid.localeCompare(y.guid))[0];

export function sampleEvents(components: Component[], opts: SampleOptions): PickedEvent[] {
  const picked: PickedEvent[] = [];
  const used = new Set<Component>();

  for (const ex of opts.examples ?? []) {
    const component = components.find((c) => c.articles.some((a) => a.guid === ex.seedGuid));
    if (!component) throw new Error(`example "${ex.title}": article ${ex.seedGuid} is not in any component`);
    const seed = component.articles.find((a) => a.guid === ex.seedGuid)!;
    picked.push({ component, stratum: strataOf(component.outlets) ?? "small", outlets: component.outlets, seed, split: "dev", example: true, title: ex.title });
    used.add(component);
  }

  const random = rng(opts.seed);
  for (const stratum of ["large", "mid", "small"] as Stratum[]) {
    // Sort first so the draw does not depend on the order components were built in.
    const pool = components
      .filter((c) => !used.has(c) && strataOf(c.outlets) === stratum)
      .sort((x, y) => seedOf(x).guid.localeCompare(seedOf(y).guid));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (const component of pool.slice(0, opts.perStratum[stratum])) {
      const seed = seedOf(component);
      picked.push({ component, stratum, outlets: component.outlets, seed, split: splitOf(seed.guid), example: false, title: seed.guid });
    }
  }
  return picked;
}
