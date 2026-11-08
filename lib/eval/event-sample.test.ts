import { describe, expect, it } from "vitest";
import { buildComponents, sampleEvents, splitOf, strataOf, type SampleArticle } from "./event-sample";

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 20, 0, 0);

// A unit vector in the first two dimensions at the given angle; articles at the same angle have cosine 1.
const at = (deg: number) => {
  const v = new Array(768).fill(0);
  v[0] = Math.cos((deg * Math.PI) / 180);
  v[1] = Math.sin((deg * Math.PI) / 180);
  return v;
};

let n = 0;
const art = (over: Partial<SampleArticle> & { hours: number; deg: number }): SampleArticle => {
  const { hours, deg, ...rest } = over;
  return { guid: `g${n++}`, sourceId: "src", time: new Date(T0 + hours * H).toISOString(), embedding: at(deg), ...rest };
};

// `outlets` articles about one event: distinct sources, close in time, same direction.
const event = (deg: number, outlets: number, startHours = 0) =>
  Array.from({ length: outlets }, (_, i) => art({ hours: startHours + i, deg, sourceId: `s${i}` }));

describe("buildComponents", () => {
  it("joins articles that are similar and close in time, and counts outlets", () => {
    const [c] = buildComponents(event(0, 4));
    expect(c.articles).toHaveLength(4);
    expect(c.outlets).toBe(4);
  });

  it("does not join articles more than the gap apart, or below the cosine floor", () => {
    const far = [art({ hours: 0, deg: 0, sourceId: "a" }), art({ hours: 40, deg: 0, sourceId: "b" })];
    expect(buildComponents(far).filter((c) => c.outlets >= 2)).toHaveLength(0);
    const different = [art({ hours: 0, deg: 0, sourceId: "a" }), art({ hours: 1, deg: 60, sourceId: "b" })];
    expect(buildComponents(different).filter((c) => c.outlets >= 2)).toHaveLength(0);
  });

  it("chains articles through a middle one, as the permissive definition intends", () => {
    const chain = [
      art({ hours: 0, deg: 0, sourceId: "a" }),
      art({ hours: 30, deg: 5, sourceId: "b" }),
      art({ hours: 60, deg: 10, sourceId: "c" }),
    ];
    const [c] = buildComponents(chain);
    expect(c.articles).toHaveLength(3);
  });

  it("skips excluded articles", () => {
    const items = [...event(0, 3), art({ hours: 1, deg: 0, sourceId: "live", excludedReason: "live_blog" })];
    const [c] = buildComponents(items);
    expect(c.articles).toHaveLength(3);
    expect(c.articles.some((a) => a.sourceId === "live")).toBe(false);
  });

  it("is independent of input order", () => {
    const items = [...event(0, 3), ...event(90, 2, 5)];
    const a = buildComponents(items).map((c) => c.articles.map((x) => x.guid).sort().join());
    const b = buildComponents([...items].reverse()).map((c) => c.articles.map((x) => x.guid).sort().join());
    expect(a.sort()).toEqual(b.sort());
  });
});

describe("strataOf", () => {
  it("puts 6+ outlets in large, 3–5 in mid, 2 in small, and 1 in none", () => {
    expect(strataOf(7)).toBe("large");
    expect(strataOf(6)).toBe("large");
    expect(strataOf(5)).toBe("mid");
    expect(strataOf(3)).toBe("mid");
    expect(strataOf(2)).toBe("small");
    expect(strataOf(1)).toBeNull();
  });
});

describe("sampleEvents", () => {
  // Many separated events: angles 10° apart are below the 0.85 floor against each other (cos 10° = 0.985, so use 40°+).
  const world = () => {
    n = 0;
    const items: SampleArticle[] = [];
    let k = 0;
    const add = (outlets: number, count: number) => {
      for (let i = 0; i < count; i++) {
        // Each event gets its own 3-day slot so no two events can connect through time.
        items.push(...event(0, outlets, k * 100).map((a, j) => ({ ...a, embedding: at(0), guid: `e${k}-${j}` })));
        k++;
      }
    };
    add(8, 4);
    add(4, 4);
    add(2, 4);
    add(1, 3);
    return items;
  };

  it("draws the requested count from each stratum, never from single-outlet components", () => {
    const picked = sampleEvents(buildComponents(world()), { perStratum: { large: 3, mid: 3, small: 3 }, seed: 1 });
    const counts = picked.reduce<Record<string, number>>((acc, p) => ({ ...acc, [p.stratum]: (acc[p.stratum] ?? 0) + 1 }), {});
    expect(counts).toEqual({ large: 3, mid: 3, small: 3 });
    expect(picked.every((p) => p.outlets >= 2)).toBe(true);
  });

  it("is deterministic for a seed and changes with the seed", () => {
    const comps = buildComponents(world());
    const run = (seed: number) => sampleEvents(comps, { perStratum: { large: 2, mid: 2, small: 2 }, seed }).map((p) => p.seed.guid);
    expect(run(1)).toEqual(run(1));
    expect(run(1)).not.toEqual(run(2));
  });

  it("takes fewer than requested when a stratum is short", () => {
    const picked = sampleEvents(buildComponents(world()), { perStratum: { large: 10, mid: 0, small: 0 }, seed: 1 });
    expect(picked).toHaveLength(4);
  });

  it("always includes the example events as dev, and does not sample them twice", () => {
    const items = world();
    const comps = buildComponents(items);
    const exampleSeed = items.find((a) => a.guid === "e0-0")!;
    const picked = sampleEvents(comps, {
      perStratum: { large: 4, mid: 0, small: 0 },
      seed: 3,
      examples: [{ title: "Example", seedGuid: exampleSeed.guid }],
    });
    const example = picked.find((p) => p.example);
    expect(example).toMatchObject({ split: "dev", title: "Example" });
    expect(picked.filter((p) => p.component.articles.some((a) => a.guid === "e0-0"))).toHaveLength(1);
    expect(picked).toHaveLength(4);
  });
});

describe("splitOf", () => {
  it("is stable per guid and roughly balanced", () => {
    expect(splitOf("abc")).toBe(splitOf("abc"));
    const splits = Array.from({ length: 400 }, (_, i) => splitOf(`guid-${i}`));
    const dev = splits.filter((s) => s === "dev").length;
    expect(dev).toBeGreaterThan(150);
    expect(dev).toBeLessThan(250);
  });
});
