export type FeedSource = {
  id: string;
  label: string;
  url: string;
};

// Add/remove sources here — ingestion picks this list up automatically.
export const FEED_SOURCES: FeedSource[] = [
  // Existing
  { id: "nyt-us", label: "NYT — U.S.", url: "https://rss.nytimes.com/services/xml/rss/nyt/US.xml" },
  { id: "nyt-business", label: "NYT — Business", url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml" },
  { id: "nyt-economy", label: "NYT — Economy", url: "https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml" },
  { id: "nyt-technology", label: "NYT — Technology", url: "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml" },
  { id: "yahoo-finance-news", label: "Yahoo Finance — News", url: "https://finance.yahoo.com/news/rssindex" },

  // Neutral / wire-adjacent baseline
  { id: "npr-top", label: "NPR — Top Stories", url: "https://feeds.npr.org/1001/rss.xml" },
  { id: "npr-politics", label: "NPR — Politics", url: "https://feeds.npr.org/1014/rss.xml" },
  { id: "npr-world", label: "NPR — World", url: "https://feeds.npr.org/1004/rss.xml" },
  { id: "pbs-newshour", label: "PBS NewsHour", url: "https://www.pbs.org/newshour/feeds/rss/headlines" },
  { id: "cbs-main", label: "CBS News — Main", url: "https://www.cbsnews.com/latest/rss/main" },
  { id: "axios", label: "Axios", url: "https://api.axios.com/feed/" },

  // Left-of-center
  { id: "guardian-us", label: "The Guardian — U.S.", url: "https://www.theguardian.com/us-news/rss" },
  { id: "guardian-world", label: "The Guardian — World", url: "https://www.theguardian.com/world/rss" },
  { id: "wapo-world", label: "Washington Post — World", url: "https://feeds.washingtonpost.com/rss/world" },
  { id: "cnn-top", label: "CNN — Top Stories", url: "http://rss.cnn.com/rss/cnn_topstories.rss" },

  // Center-right / right
  { id: "wsj-world", label: "Wall Street Journal — World News", url: "https://feeds.a.dj.com/rss/RSSWorldNews.xml" },
  { id: "fox-latest", label: "Fox News — Latest", url: "https://moxie.foxnews.com/google-publisher/latest.xml" },
  { id: "nypost", label: "New York Post", url: "https://nypost.com/feed/" },
  { id: "washington-examiner", label: "Washington Examiner", url: "https://www.washingtonexaminer.com/feed" },
  { id: "the-hill", label: "The Hill", url: "https://thehill.com/feed/" },

  // International
  { id: "bbc-world", label: "BBC — World", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { id: "aljazeera-all", label: "Al Jazeera English — All", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { id: "dw-all", label: "Deutsche Welle — All", url: "https://rss.dw.com/rdf/rss-en-all" },
  { id: "scmp-china", label: "South China Morning Post — China", url: "https://www.scmp.com/rss/91/feed" },
  { id: "hindu-national", label: "The Hindu — National", url: "https://www.thehindu.com/news/national/feeder/default.rss" },

  // Business/tech depth
  { id: "techcrunch", label: "TechCrunch", url: "https://techcrunch.com/feed/" },
  { id: "arstechnica", label: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { id: "the-verge", label: "The Verge", url: "https://www.theverge.com/rss/index.xml" },
  { id: "cnbc-world", label: "CNBC — World", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
  {
    id: "bloomberg-markets",
    label: "Bloomberg — Markets",
    // The doc's URL is retired; this one was found live during testing.
    url: "https://feeds.bloomberg.com/markets/news.rss",
  },
  { id: "ft-home", label: "Financial Times — Home", url: "https://www.ft.com/rss/home" },

  // Not added yet:
  // - Nikkei Asia: the doc's URL 404s, needs a working URL.
  // - France 24: server response isn't decoding as UTF-8 XML, needs investigation.
];
