// Spike: how many promo/advertorial articles (sportsbook bonus codes and similar) are in the
// snapshot, and do they form fake stories? Local only, no API calls.
import { readFileSync, readdirSync } from "node:fs";
import { DEFAULT_CLUSTER_CONFIG } from "@/lib/pipeline/assign";
import { replay, type SnapshotArticle } from "@/lib/eval/replay";
import { buildSimCache } from "@/lib/eval/sim-cache";
import { cleanText } from "@/lib/text";

const PROMO = [
  /\bpromo(?:tional)? code\b/i,
  /\bbonus code\b/i,
  /\bbetting (?:promo|offer|bonus)\b/i,
  /\b(?:sportsbook|casino) (?:promo|bonus|offer)\b/i,
  /\bsign[- ]?up (?:bonus|offer)\b/i,
  /\b(?:bet|wager) \$?\d+,? (?:get|win|and get)\b/i,
  /\bno[- ]?deposit\b/i,
  /\b(?:draftkings|fanduel|betmgm|caesars|fanatics) (?:promo|code|bonus|offer|sportsbook)\b/i,
  /\bbest (?:sportsbook|betting|casino) (?:promos?|bonus|offers?|apps?)\b/i,
  /\bcoupon\b|\bdiscount code\b|\bdeal alert\b/i,
];

async function main() {
  const file = `eval/${readdirSync("eval").filter((f) => /^snapshot-.*\.jsonl$/.test(f)).sort().at(-1)}`;
  const snapshot: SnapshotArticle[] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const isPromo = (a: SnapshotArticle) => PROMO.some((r) => r.test(cleanText(a.title)) || r.test(cleanText(a.summary)));
  const promo = snapshot.filter(isPromo);
  console.log(`${promo.length} of ${snapshot.length} articles match a promo pattern (${((promo.length / snapshot.length) * 100).toFixed(1)}%)`);
  const bySource = new Map<string, number>();
  for (const a of promo) bySource.set(a.sourceId, (bySource.get(a.sourceId) ?? 0) + 1);
  console.log("by source:", Object.fromEntries([...bySource].sort((x, y) => y[1] - x[1])));

  const cache = buildSimCache(snapshot);
  for (const tHigh of [0.88, 0.92]) {
    const r = await replay(cache.sorted, [], { ...DEFAULT_CLUSTER_CONFIG, tHigh }, { memberSim: cache.memberSim });
    const promoGuids = new Set(promo.map((a) => a.guid));
    const groups = new Map<string, string[]>();
    for (const [g, d] of r.decisions) groups.set(d.storyId, [...(groups.get(d.storyId) ?? []), g]);
    const fake = [...groups.values()].filter((g) => g.length >= 2 && g.filter((x) => promoGuids.has(x)).length >= 2);
    const mixed = fake.filter((g) => g.some((x) => !promoGuids.has(x))).length;
    console.log(`T_high ${tHigh}: ${fake.length} stories contain 2+ promo articles (${mixed} also contain non-promo articles)`);
    if (tHigh === 0.88) {
      const title = new Map(snapshot.map((a) => [a.guid, cleanText(a.title)]));
      for (const g of fake.slice(0, 6)) console.log("  e.g.", g.slice(0, 3).map((x) => `${promoGuids.has(x) ? "[promo] " : ""}${title.get(x)?.slice(0, 70)}`).join("  |  "));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
