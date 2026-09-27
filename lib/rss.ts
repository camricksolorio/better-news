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

export function parseRssFeed(xml: string): ParsedFeedItem[] {
  const parsed = parser.parse(xml);
  const channel = parsed?.rss?.channel;
  if (!channel) return [];

  const rawItems = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];

  return rawItems
    .map((item: Record<string, unknown>): ParsedFeedItem | null => {
      const link = firstString(item.link);
      const guid = firstString(item.guid) ?? link;
      const title = firstString(item.title);
      if (!guid || !link || !title) return null;

      const pubDateRaw = firstString(item.pubDate);
      const publishedAt = pubDateRaw ? new Date(pubDateRaw) : null;

      return {
        guid,
        title,
        link,
        summary: firstString(item.description),
        imageUrl: extractImage(item),
        publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
      };
    })
    .filter((item: ParsedFeedItem | null): item is ParsedFeedItem => item !== null);
}
