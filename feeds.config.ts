export type FeedSource = {
  id: string;
  label: string;
  url: string;
};

// Add/remove sources here — ingestion picks this list up automatically.
export const FEED_SOURCES: FeedSource[] = [
  { id: "nyt-us", label: "NYT — U.S.", url: "https://rss.nytimes.com/services/xml/rss/nyt/US.xml" },
  { id: "nyt-business", label: "NYT — Business", url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml" },
  { id: "nyt-economy", label: "NYT — Economy", url: "https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml" },
  { id: "nyt-technology", label: "NYT — Technology", url: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml" },
  { id: "yahoo-finance-news", label: "Yahoo Finance — News", url: "https://finance.yahoo.com/news/rssindex" },
];
