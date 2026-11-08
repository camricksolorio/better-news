import { describe, expect, it } from "vitest";
import { DEFAULT_CLUSTER_CONFIG, type Adjudicator } from "@/lib/pipeline/assign";
import type { SnapshotArticle } from "./replay";
import { planTicks, runStrategy } from "./ticks";
import { createV1Strategy } from "./v1-strategy";

const H = 3_600_000;
const T = Date.UTC(2026, 9, 20, 0, 0);
const at = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
const art = (guid: string, hours: number, deg: number, sourceId = guid): SnapshotArticle => ({
  guid,
  sourceId,
  title: guid,
  summary: "a reasonably long description, well over forty characters in all",
  time: new Date(T + hours * H).toISOString(),
  createdAt: new Date(T + hours * H).toISOString(),
  thin: false,
  embedding: at(deg),
});

const yes: Adjudicator = async () => ({ same: true });
const no: Adjudicator = async () => ({ same: false });
const cfg = { ...DEFAULT_CLUSTER_CONFIG, tLow: 0.8 };

describe("v1 strategy", () => {
  const items = [art("a", 1, 0), art("b", 2, 5), art("c", 3, 90)];

  it("joins articles the classifier says are the same and keeps others apart", async () => {
    const result = await runStrategy(planTicks(items, {}), createV1Strategy({ cfg, adjudicate: yes }));
    const c = result.clusterOf;
    expect(c.get("a")).toBe(c.get("b"));
    expect(c.get("c")).not.toBe(c.get("a"));
    expect(result.candidatePairs).toBeNull();
  });

  it("joins nothing when the classifier says no", async () => {
    const c = (await runStrategy(planTicks(items, {}), createV1Strategy({ cfg, adjudicate: no }))).clusterOf;
    expect(new Set(c.values()).size).toBe(3);
  });

  it("clusters articles that arrive in later ticks against earlier ones", async () => {
    const later = [art("a", 1, 0), art("b", 8, 5)];
    const c = (await runStrategy(planTicks(later, {}), createV1Strategy({ cfg, adjudicate: yes }))).clusterOf;
    expect(c.get("a")).toBe(c.get("b"));
  });

  it("leaves an article unclustered when the classifier call fails, and reports it", async () => {
    const failed: string[] = [];
    const boom: Adjudicator = async (article) => {
      if (article.id === "b") throw new Error("llm down");
      return { same: true };
    };
    const c = (await runStrategy(planTicks(items, {}), createV1Strategy({ cfg, adjudicate: boom, onFailure: (g) => failed.push(g) }))).clusterOf;
    expect(failed).toEqual(["b"]);
    expect(c.has("b")).toBe(false);
  });

  it("stops the whole run on an error the caller names as fatal", async () => {
    const fatal = new Error("budget");
    const boom: Adjudicator = async () => {
      throw fatal;
    };
    await expect(runStrategy(planTicks(items, {}), createV1Strategy({ cfg, adjudicate: boom, abortOn: (e) => e === fatal }))).rejects.toBe(fatal);
  });
});
