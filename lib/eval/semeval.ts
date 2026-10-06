// Pure helpers for the SemEval-2022 Task 8 converter (scripts/semeval-fetch.ts).

export type SemevalRow = { pairId: string; link1: string; link2: string; iaLink1: string; iaLink2: string; overall: number };

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Keeps English-English pairs. Train and eval files differ in score column case.
export function englishRows(csv: string): SemevalRow[] {
  const [header, ...rows] = parseCsv(csv);
  const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name);
  const [l1, l2, id, a, b, ia, ib, ov] = ["url1_lang", "url2_lang", "pair_id", "link1", "link2", "ia_link1", "ia_link2", "overall"].map(col);
  return rows
    .filter((r) => r[l1] === "en" && r[l2] === "en")
    .map((r) => ({ pairId: r[id], link1: r[a], link2: r[b], iaLink1: r[ia], iaLink2: r[ib], overall: Number(r[ov]) }));
}

// Overall is 1 (very similar) .. 4 (dissimilar). Defaults are provisional until spot-checked against D31.
export function labelFor(overall: number, sameMax = 1.5, differentMin = 3.5): "same" | "different" | null {
  if (overall <= sameMax) return "same";
  if (overall >= differentMin) return "different";
  return null;
}

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

function meta(html: string, prop: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  const content = tag?.match(/content=(?:"([^"]*)"|'([^']*)')/i);
  return content ? decode(content[1] ?? content[2]) : null;
}

// Title plus a ~300 char snippet from the description, else the first long paragraphs.
export function extractArticle(html: string): { title: string; snippet: string } | null {
  const title = meta(html, "og:title") ?? decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  let snippet = meta(html, "og:description") ?? meta(html, "description") ?? "";
  if (snippet.length < 80) {
    const paras = [...html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => decode(m[1].replace(/<[^>]+>/g, "")))
      .filter((p) => p.length > 60);
    snippet = paras.join(" ");
  }
  if (!title || snippet.length < 40) return null;
  return { title, snippet: snippet.slice(0, 300) };
}
