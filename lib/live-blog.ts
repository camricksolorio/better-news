// Live blogs change headline and topic all day, so they never become stories (v2 V7). Detection is per source
// because generic patterns hit false positives such as PBS "live-map-…" and Washington Examiner "live-grenade-…".
// To cover a new source, add one line to URL_RULES.

export type LiveBlogInput = { sourceId: string; link: string; title: string };

type UrlRule = { sources: RegExp; path: RegExp };

const URL_RULES: UrlRule[] = [
  { sources: /^guardian-/, path: /\/live\// },
  { sources: /^nyt-/, path: /^\/live\// },
  { sources: /^dw-/, path: /\/live-\d+$/ },
  { sources: /^aljazeera-/, path: /\/liveblog\// },
  { sources: /^the-hill$/, path: /\/\d+-live-updates-[^/]*\/?$/ },
  { sources: /^cbs-/, path: /\/live-updates\// },
  { sources: /^cnn-/, path: /\/live-news\// },
  { sources: /^bloomberg-/, path: /\/live-blog\// },
];

// "Live: …", "Live updates – …", "LIVE | …". "Live grenade …" and "LIVE MAP: …" do not match.
const TITLE_RULE = /^\s*(?:live|live updates)\s*[:|–-]/i;

export function isLiveBlog({ sourceId, link, title }: LiveBlogInput): boolean {
  if (TITLE_RULE.test(title)) return true;
  let path: string;
  try {
    path = new URL(link.trim()).pathname;
  } catch {
    return false;
  }
  return URL_RULES.some((rule) => rule.sources.test(sourceId) && rule.path.test(path));
}
