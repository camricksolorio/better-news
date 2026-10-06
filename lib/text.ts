// Text normalization for the embed stage: cleaning RSS descriptions, building the
// embedding input, and canonicalizing links so one article in two feeds counts once.

// Bump whenever the cleaning rules or the prefix below change (stored per row, D29).
export const EMBEDDING_INPUT_VERSION = "v1";
export const EMBEDDING_PREFIX = "task: clustering | query: ";
export const SUMMARY_MAX_CHARS = 1000;
export const THIN_SUMMARY_CHARS = 40;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

// "Continue reading…", "Read more", "The post X appeared first on Y.", "[…]" teasers.
const BOILERPLATE: RegExp[] = [
  /\bThe post .{0,200}? appeared first on .{0,200}?(?:\.|$)/gi,
  /\bThe .{0,100}? appeared first on .{0,200}?(?:\.|$)/gi,
  /\b(?:continue reading|read more|read the full (?:story|article)|click here to read(?: more)?)\b[^.]{0,60}$/i,
  /\[\s*(?:…|\.{3})\s*\]/g,
];

export function cleanText(raw: string | null | undefined): string {
  if (!raw) return "";
  let text = raw.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<[^>]*>/g, " ");
  // Decode twice: feeds often double-encode ("&amp;nbsp;", escaped HTML inside CDATA).
  text = decodeEntities(decodeEntities(text));
  text = text.replace(/<[^>]*>/g, " ");
  for (const pattern of BOILERPLATE) text = text.replace(pattern, " ");
  return text.replace(/\s+/g, " ").trim();
}

export function isThin(summary: string | null | undefined): boolean {
  return cleanText(summary).length < THIN_SUMMARY_CHARS;
}

export function buildEmbeddingInput(title: string, summary: string | null | undefined): string {
  const cleanTitle = cleanText(title);
  const cleanSummary = cleanText(summary).slice(0, SUMMARY_MAX_CHARS);
  return `${EMBEDDING_PREFIX}${cleanTitle}\n\n${cleanSummary}`;
}

// Query and fragment dropped (utm_* and similar tracking), host lowercased,
// "www." and trailing slash removed. Unparseable links come back trimmed.
export function canonicalLink(link: string): string {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return link.trim();
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "");
  return `${host}${path}`;
}

export function dedupeByCanonicalLink<T extends { link: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = canonicalLink(item.link);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
