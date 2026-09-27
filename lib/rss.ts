import { XMLParser } from "fast-xml-parser";

export type ParsedFeedItem = {
  guid: string;
  title: string;
  link: string;
  summary: string | null;
  imageUrl: string | null;
  publishedAt: Date | null;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

function firstString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length > 0) return firstString(value[0]);
  if (value && typeof value === "object" && "#text" in (value as Record<string, unknown>)) {
    return firstString((value as Record<string, unknown>)["#text"]);
  }
  return null;
}

function extractImage(item: Record<string, unknown>): string | null {
  const enclosure = item.enclosure as Record<string, string> | undefined;
  if (enclosure?.["@_url"] && enclosure["@_type"]?.startsWith("image")) {
    return enclosure["@_url"];
  }
  const mediaContent = item["media:content"] as
    | Record<string, string>
    | Record<string, string>[]
    | undefined;
  if (mediaContent) {
    const first = Array.isArray(mediaContent) ? mediaContent[0] : mediaContent;
    if (first?.["@_url"]) return first["@_url"];
  }
  return null;
}

function toDate(raw: string | null): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseItems(rawItems: Record<string, unknown>[]): ParsedFeedItem[] {
  return rawItems
    .map((item): ParsedFeedItem | null => {
      const link = firstString(item.link);
      const guid = firstString(item.guid) ?? link;
      const title = firstString(item.title);
      if (!guid || !link || !title) return null;

      return {
        guid,
        title,
        link,
        summary: firstString(item.description),
        imageUrl: extractImage(item),
        publishedAt: toDate(firstString(item.pubDate)),
      };
    })
    .filter((item): item is ParsedFeedItem => item !== null);
}

// RSS 1.0/RDF: <rdf:RDF><channel>...</channel><item rdf:about="..."><title/>
// <link/><description/><dc:date/></item>...</rdf:RDF> — items are siblings
// of <channel>, not nested inside it, and dates use Dublin Core (dc:date).
function parseRdfFeed(rdf: Record<string, unknown>): ParsedFeedItem[] {
  const rawItems = Array.isArray(rdf.item) ? rdf.item : rdf.item ? [rdf.item] : [];

  return (rawItems as Record<string, unknown>[])
    .map((item): ParsedFeedItem | null => {
      const link = firstString(item.link);
      const guid = firstString(item["@_rdf:about"]) ?? link;
      const title = firstString(item.title);
      if (!guid || !link || !title) return null;

      return {
        guid,
        title,
        link,
        summary: firstString(item.description),
        imageUrl: extractImage(item),
        publishedAt: toDate(firstString(item["dc:date"])),
      };
    })
    .filter((item): item is ParsedFeedItem => item !== null);
}

// Atom: <feed><entry><title/><link href=".."/><id/><summary|content/>
// <published|updated/></entry></feed> — link is an attribute, not text.
function parseAtomFeed(feed: Record<string, unknown>): ParsedFeedItem[] {
  const rawEntries = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];

  return (rawEntries as Record<string, unknown>[])
    .map((entry): ParsedFeedItem | null => {
      const rawLink = entry.link as
        | Record<string, string>
        | Record<string, string>[]
        | undefined;
      const links = Array.isArray(rawLink) ? rawLink : rawLink ? [rawLink] : [];
      const link =
        links.find((l) => l["@_rel"] === "alternate")?.["@_href"] ?? links[0]?.["@_href"] ?? null;
      const guid = firstString(entry.id) ?? link;
      const title = firstString(entry.title);
      if (!guid || !link || !title) return null;

      return {
        guid,
        title,
        link,
        summary: firstString(entry.summary) ?? firstString(entry.content),
        imageUrl: extractImage(entry),
        publishedAt: toDate(firstString(entry.published) ?? firstString(entry.updated)),
      };
    })
    .filter((item): item is ParsedFeedItem => item !== null);
}

export function parseRssFeed(xml: string): ParsedFeedItem[] {
  const parsed = parser.parse(xml);

  const channel = parsed?.rss?.channel;
  if (channel) {
    const rawItems = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
    return parseItems(rawItems);
  }

  const rdf = parsed?.["rdf:RDF"];
  if (rdf) return parseRdfFeed(rdf);

  const feed = parsed?.feed;
  if (feed) return parseAtomFeed(feed);

  return [];
}
