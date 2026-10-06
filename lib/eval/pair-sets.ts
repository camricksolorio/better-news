// Labeled pair sets for the adjudicator comparison (D35, D36). Each pair is two articles plus whether the
// dataset says they are the same story.
import { isThin } from "@/lib/text";
import type { AdjudicationArticle } from "@/lib/pipeline/adjudicate";
import type { PairLabelRecord } from "@/lib/labels";
import type { PairRecord } from "./pairs";
import { mulberry32 } from "./pairs";

export type LabeledPair = {
  set: "reference" | "wcep" | "semeval";
  key: string;
  a: AdjudicationArticle;
  b: AdjudicationArticle;
  truth: boolean;
  thin: boolean;
};

const keyOf = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// The user's human labels, with article text from the pair file. `unsure` pairs are dropped. These are the
// reference: they win on conflict and are never used as prompt examples.
export function referencePairs(labels: PairLabelRecord[], pairs: PairRecord[]): LabeledPair[] {
  const text = new Map(pairs.map((p) => [keyOf(p.a, p.b), p]));
  const out: LabeledPair[] = [];
  for (const l of labels) {
    if (l.labeler !== "human" || l.label === "unsure") continue;
    const p = text.get(keyOf(l.a, l.b));
    if (!p) continue;
    const side = (id: string, x: PairRecord["article"]["a"]): AdjudicationArticle => ({ id, title: x.title, source: x.source, time: x.time, snippet: x.snippet });
    out.push({
      set: "reference",
      key: keyOf(p.a, p.b),
      a: side(p.a, p.article.a),
      b: side(p.b, p.article.b),
      truth: l.label === "same",
      thin: isThin(p.article.a.snippet) || isThin(p.article.b.snippet),
    });
  }
  return out;
}

type PublicRecord = { a: string; b: string; label: string | null; article: { a: PublicSide; b: PublicSide } };
type PublicSide = { title: string; source: string; time: string; snippet: string };

// Public pairs (WCEP, SemEval) from eval/public/*.jsonl: `same` and `different` only, an equal number of each,
// drawn with a seeded shuffle so a re-run asks about the same pairs (and the verdict cache answers them).
export function publicPairs(set: "wcep" | "semeval", jsonl: string, sample: number, seed = 1): LabeledPair[] {
  const rows = jsonl.split("\n").filter(Boolean).map((l) => JSON.parse(l) as PublicRecord);
  const rand = mulberry32(seed);
  const shuffle = <T>(xs: T[]) => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const half = Math.floor(sample / 2);
  const chosen = [...shuffle(rows.filter((r) => r.label === "same")).slice(0, half), ...shuffle(rows.filter((r) => r.label === "different")).slice(0, half)];
  const side = (id: string, x: PublicSide): AdjudicationArticle => ({ id, title: x.title, source: x.source, time: x.time, snippet: x.snippet });
  return chosen.map((r) => ({
    set,
    key: keyOf(r.a, r.b),
    a: side(r.a, r.article.a),
    b: side(r.b, r.article.b),
    truth: r.label === "same",
    thin: isThin(r.article.a.snippet) || isThin(r.article.b.snippet),
  }));
}
