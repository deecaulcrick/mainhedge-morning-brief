// Central place to add/remove sources and tune thresholds.
// NOTE: Bloomberg has no public API/RSS on a "daily" plan — it's read here as a
// manual/news layer only. If you have a way to pull their RSS (some Bloomberg
// verticals expose one), add it below like any other feed. Otherwise, treat
// Bloomberg as a source you read yourself and paste into the DB via
// `ingestManualArticle()` in ingest.ts, or skip it in v1.

// Claude model used for extraction + synthesis. Switch here to change both.
// On Haiku for now to conserve credits; bump back to a Sonnet-class model when
// you want higher-quality synthesis. Override per-env with CLAUDE_MODEL.
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-haiku-4-5-20251001";

export type Category = "fx_macro" | "oil" | "crypto" | "equities" |"economy" | "energy" | "currencies" |"cryptos"; // used to filter feeds by desk

export interface FeedSource {
  name: string;
  url: string;              // RSS/Atom feed URL
  categories: Category[];   // a source can belong to several desks at once
}

export const FEEDS: FeedSource[] = [
  // --- FX / macro / Nigeria business ---
  { name: "Nairametrics", url: "https://nairametrics.com/feed/", categories: ["fx_macro", "crypto", "economy", "energy", "currencies", "cryptos"] },
  { name: "BusinessDay", url: "https://businessday.ng/feed/", categories: ["fx_macro"] },

  // --- Global macro / oil ---
  { name: "OilPrice.com", url: "https://oilprice.com/rss/main", categories: ["oil"] },
  { name: "Reuters Business", url: "https://news.google.com/rss/search?q=site%3Areuters.com&hl=en-US&gl=US&ceid=US%3Aen", categories: ["fx_macro", "oil"] },

  // --- Crypto / Bitcoin / stablecoin ---
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", categories: ["crypto"] },
  { name: "The Block", url: "https://www.theblock.co/rss.xml", categories: ["crypto"] },
  { name: "Blockworks", url: "https://blockworks.co/feed", categories: ["crypto"] },
];

// NOTE: verify each feed URL still resolves before relying on it — outlets
// change their RSS paths without notice. If a feed 404s, check the site's
// footer for a current RSS link.

export interface Threshold {
  metric: string;
  direction: "above" | "below";
  value: number;
  label: string; // human-readable, used in alert text
}

// Interrupt thresholds: checked every fast-poll cycle against freshly
// extracted facts. These are intentionally soft ("as-reported") since v1 has
// no live market-data feed — see extract.ts.
export const THRESHOLDS: Threshold[] = [
  { metric: "brent_usd", direction: "above", value: 95, label: "Brent crude > $95" },
  { metric: "ngn_parallel_premium_pct", direction: "above", value: 12, label: "Parallel/NFEM premium > 12%" },
  { metric: "us_2y_yield_pct", direction: "above", value: 4.5, label: "US 2Y yield > 4.5%" },
  { metric: "btc_usd", direction: "below", value: 50000, label: "BTC < $50,000" },
];

// Polling tiers (minutes). Wire these into your scheduler (cron, GitHub
// Actions schedule, etc.) — see README "Scheduling" section.
export const POLL_TIERS = {
  // Fast tier: markets that move intraday — oil/energy, crypto, equities.
  fast: { minutes: 15, categories: ["oil", "energy", "crypto", "cryptos", "equities"] as Category[] },
  // Slow tier: macro/structural desks — FX, broad economy, currencies.
  slow: { minutes: 60, categories: ["fx_macro", "economy", "currencies"] as Category[] },
};

export const DAILY_BRIEF_HOUR_WAT = 8; // 08:00 WAT
