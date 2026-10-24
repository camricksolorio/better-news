import { describe, expect, it } from "vitest";
import {
  buildPacket,
  normalizeBullets,
  parseGoldenFile,
  parseGoldenRecord,
  parseVerdictFile,
  scoreModels,
  type GoldenStory,
  type RunRow,
  type VerdictFile,
} from "./summary";

const art = [
  { source: "cnbc", title: "Fed raises rates", snippet: "25bp." },
  { source: "wsj", title: "Markets slide", snippet: "" },
];
const golden: GoldenStory[] = [
  { id: "s1", title: "Fed raises rates", summary: ["Fed hikes 25bp", "Stocks fall"], articles: art },
  { id: "s2", title: "Storm hits coast", summary: ["Storm makes landfall"], articles: art },
];
const summary = (headline: string) => ({
  headline,
  summary: [{ text: "A point.", citations: [1] }],
  coverageNotes: [],
});
const row = (storyId: string, model: string, over: Partial<RunRow> = {}): RunRow => ({
  storyId, model, ok: true, summary: summary(`Headline for ${storyId}`), dropped: 0, costUsd: 0.001, ...over,
});
const runs = (): Record<string, RunRow[]> => ({
  "gpt-4o-mini": [row("s1", "gpt-4o-mini"), row("s2", "gpt-4o-mini")],
  "gpt-6-luna": [row("s1", "gpt-6-luna"), row("s2", "gpt-6-luna", { ok: false, summary: undefined, error: "bad", costUsd: 0.002 })],
});

describe("golden file", () => {
  it("normalizes bullets from a list or a bulleted string", () => {
    expect(normalizeBullets(["- one", "• two", "3. three", "  "])).toEqual(["one", "two", "three"]);
    expect(normalizeBullets("- one\n* two\n\n1) three")).toEqual(["one", "two", "three"]);
  });

  it("accepts a record with inline articles or guids", () => {
    const inline = parseGoldenRecord({ id: "a", title: " T ", summary: "- x\n- y", articles: art }, 1);
    expect(inline).toMatchObject({ title: "T", summary: ["x", "y"] });
    expect(parseGoldenRecord({ id: "b", title: "T", summary: ["x"], guids: ["g1", "g2"] }, 2).guids).toEqual(["g1", "g2"]);
  });

  it("rejects missing or malformed fields with the line number", () => {
    expect(() => parseGoldenRecord({ id: "a", summary: ["x"], articles: art }, 3)).toThrow(/line 3: missing title/);
    expect(() => parseGoldenRecord({ id: "a", title: "T", summary: [], articles: art }, 4)).toThrow(/no bullets/);
    expect(() => parseGoldenRecord({ id: "a", title: "T", summary: ["x"] }, 5)).toThrow(/articles or guids/);
    expect(() => parseGoldenRecord({ id: "a", title: "T", summary: 5 }, 6)).toThrow(/bullet points/);
  });

  it("rejects duplicate ids", () => {
    const line = JSON.stringify({ id: "a", title: "T", summary: ["x"], guids: ["g"] });
    expect(() => parseGoldenFile(`${line}\n\n${line}\n`)).toThrow(/duplicate id a/);
    expect(parseGoldenFile(`${line}\n`)).toHaveLength(1);
  });
});

describe("buildPacket", () => {
  it("hides model names, keeps a key, and skips stories no model summarized", () => {
    const r = runs();
    r["gpt-6-luna"][0] = row("s1", "gpt-6-luna", { ok: false, summary: undefined });
    r["gpt-4o-mini"][1] = row("s2", "gpt-4o-mini", { ok: false, summary: undefined });
    const { packet, key } = buildPacket(golden, r);
    expect(packet.stories.map((s) => s.storyId)).toEqual(["s1"]);
    expect(JSON.stringify(packet)).not.toMatch(/gpt-/);
    expect(key.s1).toEqual({ A: "gpt-4o-mini" });
  });

  it("labels both models' summaries, is deterministic for a seed, and varies the order across stories", () => {
    const a = buildPacket(golden, { "gpt-4o-mini": [row("s1", "gpt-4o-mini")], "gpt-6-luna": [row("s1", "gpt-6-luna")] }, 7);
    const b = buildPacket(golden, { "gpt-4o-mini": [row("s1", "gpt-4o-mini")], "gpt-6-luna": [row("s1", "gpt-6-luna")] }, 7);
    expect(a.key).toEqual(b.key);
    expect(Object.values(a.key.s1).sort()).toEqual(["gpt-4o-mini", "gpt-6-luna"]);
    const orders = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      orders.add(buildPacket(golden, { "gpt-4o-mini": [row("s1", "gpt-4o-mini")], "gpt-6-luna": [row("s1", "gpt-6-luna")] }, seed).key.s1.A);
    }
    expect(orders.size).toBe(2);
  });
});

describe("verdicts and scoring", () => {
  const setup = () => {
    const { packet, key } = buildPacket(golden, runs());
    const verdicts = (agent: string, unsupported: (model: string, storyId: string) => string[]): VerdictFile => ({
      agent,
      verdicts: packet.stories.flatMap((s) =>
        s.candidates.map((c) => {
          const model = key[s.storyId][c.label];
          return {
            storyId: s.storyId, candidate: c.label,
            faithfulness: model === "gpt-6-luna" ? 5 : 3, coverage: 4, neutrality: 5,
            unsupportedClaims: unsupported(model, s.storyId),
          };
        }),
      ),
    });
    return { packet, key, verdicts };
  };

  it("validates a verdict file against the packet", () => {
    const { packet, verdicts } = setup();
    const ok = verdicts("claude", () => []);
    expect(parseVerdictFile(ok, packet).agent).toBe("claude");
    expect(() => parseVerdictFile({ ...ok, verdicts: ok.verdicts.slice(1) }, packet)).toThrow(/missing verdicts/);
    expect(() => parseVerdictFile({ ...ok, verdicts: [...ok.verdicts, ok.verdicts[0]] }, packet)).toThrow(/duplicate/);
    expect(() => parseVerdictFile({ ...ok, verdicts: [{ ...ok.verdicts[0], candidate: "Z" }] }, packet)).toThrow(/unknown candidate/);
    expect(() => parseVerdictFile({ ...ok, verdicts: [{ ...ok.verdicts[0], coverage: 6 }, ...ok.verdicts.slice(1)] }, packet)).toThrow(/1 to 5/);
  });

  it("scores each model, counts failed generations against it, and sums cost", () => {
    const { key, verdicts } = setup();
    const out = scoreModels({ goldenIds: ["s1", "s2"], runs: runs(), key, verdictFiles: [verdicts("claude", () => [])] });
    const mini = out.models.find((m) => m.model === "gpt-4o-mini")!;
    const luna = out.models.find((m) => m.model === "gpt-6-luna")!;
    expect(mini).toMatchObject({ generated: 2, failed: 0, zeroUnsupportedRate: 1, meanFaithfulness: 3 });
    expect(luna).toMatchObject({ generated: 1, failed: 1, zeroUnsupportedRate: 0.5, meanFaithfulness: 5 });
    expect(luna.totalCostUsd).toBeCloseTo(0.003);
    expect(luna.costPerStoryUsd).toBeCloseTo(0.0015);
  });

  it("counts a summary as clean only when every agent finds no unsupported claims, and reports disagreements", () => {
    const { key, verdicts } = setup();
    const out = scoreModels({
      goldenIds: ["s1", "s2"],
      runs: runs(),
      key,
      verdictFiles: [verdicts("claude", () => []), verdicts("gemini", (m, s) => (m === "gpt-4o-mini" && s === "s1" ? ["invented figure"] : []))],
    });
    expect(out.models.find((m) => m.model === "gpt-4o-mini")!.zeroUnsupportedRate).toBe(0.5);
    expect(out.disagreements).toBe(1);
    expect(out.agents).toEqual(["claude", "gemini"]);
  });
});
