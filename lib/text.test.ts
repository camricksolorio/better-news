import { describe, expect, it } from "vitest";
import {
  buildEmbeddingInput,
  canonicalLink,
  cleanText,
  dedupeByCanonicalLink,
  isThin,
} from "./text";

describe("cleanText", () => {
  it("strips HTML tags and script/style blocks", () => {
    expect(cleanText('<p>Hello <b>world</b></p><script>alert(1)</script><style>p{}</style>')).toBe(
      "Hello world",
    );
  });

  it("decodes named and numeric entities, including double encoding", () => {
    expect(cleanText("Tom &amp; Jerry&#8217;s &#x2014; &quot;fun&quot;&nbsp;time")).toBe(
      "Tom & Jerry’s — \"fun\" time",
    );
    expect(cleanText("&lt;p&gt;escaped html&lt;/p&gt;")).toBe("escaped html");
    expect(cleanText("a &amp;amp; b")).toBe("a & b");
  });

  it("leaves unknown or invalid entities alone", () => {
    expect(cleanText("&bogus; &#99999999;")).toBe("&bogus; &#99999999;");
  });

  it("collapses whitespace", () => {
    expect(cleanText("  a\n\n b\t\tc  ")).toBe("a b c");
  });

  it("drops boilerplate", () => {
    expect(cleanText("Big news today. The post Big News appeared first on Example Daily.")).toBe(
      "Big news today.",
    );
    expect(cleanText("Officials said Monday… Continue reading…")).toBe("Officials said Monday…");
    expect(cleanText("Stuff happened [&#8230;] Read more")).toBe("Stuff happened");
  });

  it("keeps prose that merely contains those words", () => {
    expect(cleanText("Readers can read more than 100 pages of the filing. It is long.")).toBe(
      "Readers can read more than 100 pages of the filing. It is long.",
    );
  });

  it("handles null and empty", () => {
    expect(cleanText(null)).toBe("");
    expect(cleanText(undefined)).toBe("");
    expect(cleanText("   ")).toBe("");
  });
});

describe("isThin", () => {
  it("flags missing and short descriptions", () => {
    expect(isThin(null)).toBe(true);
    expect(isThin("<p>short</p>")).toBe(true);
    expect(isThin("x".repeat(40))).toBe(false);
  });
});

describe("buildEmbeddingInput", () => {
  it("uses the clustering prefix, title, blank line, and truncated summary", () => {
    const out = buildEmbeddingInput("Fed <b>hikes</b>", "y".repeat(2000));
    expect(out.startsWith("task: clustering | query: Fed hikes\n\n")).toBe(true);
    expect(out.length).toBe("task: clustering | query: Fed hikes\n\n".length + 1000);
  });

  it("works with no summary", () => {
    expect(buildEmbeddingInput("Title", null)).toBe("task: clustering | query: Title\n\n");
  });
});

describe("canonicalLink", () => {
  it("strips utm params, fragments, www, case, and trailing slashes", () => {
    expect(canonicalLink("https://WWW.Example.com/news/story-1/?utm_source=rss&utm_medium=feed#top")).toBe(
      "example.com/news/story-1",
    );
  });

  it("treats http and https as the same", () => {
    expect(canonicalLink("http://example.com/a")).toBe(canonicalLink("https://example.com/a"));
  });

  it("returns unparseable links trimmed", () => {
    expect(canonicalLink("  not a url ")).toBe("not a url");
  });
});

describe("dedupeByCanonicalLink", () => {
  it("collapses the same article published in two feeds", () => {
    const items = [
      { id: "nyt-us", link: "https://www.nytimes.com/2026/10/01/us/story.html?partner=rss" },
      { id: "nyt-business", link: "https://www.nytimes.com/2026/10/01/us/story.html?smid=feed" },
      { id: "other", link: "https://example.com/other" },
    ];
    expect(dedupeByCanonicalLink(items).map((i) => i.id)).toEqual(["nyt-us", "other"]);
  });
});
