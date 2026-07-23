import Parser from "rss-parser";
import { FEEDS, FeedSource } from "./config.js";
import { insertArticleIfNew, ArticleRow } from "./db.js";

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "MainhedgeMorningBrief/1.0" },
});

// Pull every configured feed, insert new articles, return the ones that were
// actually new (already-seen articles are skipped, not re-processed).
export async function ingestAllFeeds(): Promise<ArticleRow[]> {
  const newArticles: ArticleRow[] = [];
  for (const feed of FEEDS) {
    try {
      const items = await ingestFeed(feed);
      newArticles.push(...items);
    } catch (err) {
      // One bad feed shouldn't take down the whole ingestion run.
      console.error(`[ingest] Failed to fetch ${feed.name} (${feed.url}):`, (err as Error).message);
    }
  }
  return newArticles;
}

export async function ingestFeedsByCategory(categories: FeedSource["categories"]): Promise<ArticleRow[]> {
  const targeted = FEEDS.filter((f) => f.categories.some((c) => categories.includes(c)));
  const newArticles: ArticleRow[] = [];
  for (const feed of targeted) {
    try {
      const items = await ingestFeed(feed);
      newArticles.push(...items);
    } catch (err) {
      console.error(`[ingest] Failed to fetch ${feed.name} (${feed.url}):`, (err as Error).message);
    }
  }
  return newArticles;
}

async function ingestFeed(feed: FeedSource): Promise<ArticleRow[]> {
  const parsed = await parser.parseURL(feed.url);
  const inserted: ArticleRow[] = [];

  for (const item of parsed.items) {
    if (!item.link) continue;

    const raw = await insertArticleIfNew({
      source: feed.name,
      url: item.link,
      headline: item.title ?? "(untitled)",
      raw_text: item.contentSnippet ?? item.content ?? null,
      published_at: item.isoDate ? new Date(item.isoDate) : null,
    });

    if (raw) inserted.push(raw); // null means it was a dup, already in DB
  }

  console.log(`[ingest] ${feed.name}: ${inserted.length} new article(s)`);
  return inserted;
}

// For sources with no RSS/API (e.g. Bloomberg on a plan without feed access),
// use this to hand-log an article you read yourself so it still gets stored
// and flows through extraction/synthesis like any other source.
export async function ingestManualArticle(input: {
  source: string;
  url: string;
  headline: string;
  raw_text: string;
}): Promise<ArticleRow | null> {
  return insertArticleIfNew({
    source: input.source,
    url: input.url,
    headline: input.headline,
    raw_text: input.raw_text,
    published_at: new Date(),
  });
}
