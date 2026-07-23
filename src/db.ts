import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requires SSL
});

export async function initDb() {
  const schemaPath = path.join(__dirname, "..", "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  await pool.query(schema);
  console.log("Schema applied.");
}

export interface ArticleRow {
  id: number;
  source: string;
  url: string;
  headline: string;
  raw_text: string | null;
  published_at: Date | null;
  fetched_at: Date;
}

// Insert an article, skipping if the URL already exists (dedup by URL).
// Returns the row (existing or newly inserted), or null if it was a dup.
export async function insertArticleIfNew(article: {
  source: string;
  url: string;
  headline: string;
  raw_text: string | null;
  published_at: Date | null;
}): Promise<ArticleRow | null> {
  const result = await pool.query<ArticleRow>(
    `INSERT INTO articles (source, url, headline, raw_text, published_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (url) DO NOTHING
     RETURNING *`,
    [article.source, article.url, article.headline, article.raw_text, article.published_at]
  );
  return result.rows[0] ?? null;
}

export async function getRecentArticles(hours: number): Promise<ArticleRow[]> {
  const result = await pool.query<ArticleRow>(
    `SELECT * FROM articles WHERE fetched_at > now() - ($1 || ' hours')::interval ORDER BY fetched_at DESC`,
    [hours]
  );
  return result.rows;
}

export async function insertExtractedFact(fact: {
  article_id: number;
  metric: string;
  value: number | null;
  unit: string | null;
  confidence: number | null;
}) {
  await pool.query(
    `INSERT INTO extracted_facts (article_id, metric, value, unit, as_reported, confidence)
     VALUES ($1, $2, $3, $4, true, $5)`,
    [fact.article_id, fact.metric, fact.value, fact.unit, fact.confidence]
  );
}

export async function insertArticleSummary(summary: {
  article_id: number;
  topic: string | null;
  summary: string | null;
  direction: string | null;
  relevance: number | null;
}) {
  await pool.query(
    `INSERT INTO article_summaries (article_id, topic, summary, direction, relevance)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (article_id) DO UPDATE SET
       topic = EXCLUDED.topic, summary = EXCLUDED.summary,
       direction = EXCLUDED.direction, relevance = EXCLUDED.relevance`,
    [summary.article_id, summary.topic, summary.summary, summary.direction, summary.relevance]
  );
}

export async function getLatestFactPerMetric(): Promise<
  { metric: string; value: number; article_id: number; extracted_at: Date }[]
> {
  const result = await pool.query(
    `SELECT DISTINCT ON (metric) metric, value, article_id, extracted_at
     FROM extracted_facts
     WHERE value IS NOT NULL
     ORDER BY metric, extracted_at DESC`
  );
  return result.rows;
}

export interface InsightInput {
  severity: "alert" | "watch" | "info";
  headline: string;
  detail: string;
  supporting_article_ids: number[];
}

export interface ArticleLink {
  id: number;
  source: string;
  headline: string;
  url: string;
}

// An insight plus its supporting articles resolved to clickable links.
export interface InsightWithSources extends InsightInput {
  sources: ArticleLink[];
}

// Resolve a list of article ids to {source, headline, url}, preserving the
// order the ids were given in and silently dropping any that no longer exist.
export async function getArticleLinksByIds(ids: number[]): Promise<ArticleLink[]> {
  if (!ids || ids.length === 0) return [];
  const result = await pool.query<ArticleLink>(
    `SELECT id, source, headline, url FROM articles WHERE id = ANY($1::bigint[])`,
    [ids]
  );
  // pg returns BIGINT columns as strings, but the ids handed in come from
  // Claude's JSON as numbers — normalize both sides so the lookup matches.
  const byId = new Map(result.rows.map((r) => [String(r.id), r]));
  return ids.map((id) => byId.get(String(id))).filter((r): r is ArticleLink => Boolean(r));
}

export async function saveBrief(posture: string, insights: InsightInput[]): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const briefResult = await client.query(
      `INSERT INTO briefs (posture) VALUES ($1) RETURNING id`,
      [posture]
    );
    const briefId = briefResult.rows[0].id;
    for (let i = 0; i < insights.length; i++) {
      const ins = insights[i];
      await client.query(
        `INSERT INTO insights (brief_id, severity, headline, detail, supporting_article_ids, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [briefId, ins.severity, ins.headline, ins.detail, ins.supporting_article_ids, i]
      );
    }
    await client.query("COMMIT");
    return briefId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function insertInterruptAlert(alert: {
  metric: string;
  value: number;
  threshold: number;
  direction: "above" | "below";
  article_id: number | null;
}) {
  await pool.query(
    `INSERT INTO interrupt_alerts (metric, value, threshold, direction, article_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [alert.metric, alert.value, alert.threshold, alert.direction, alert.article_id]
  );
}

// Has this exact threshold already fired in the last N hours? Prevents
// re-alerting every poll cycle while a value stays past the threshold.
export async function alreadyAlertedRecently(metric: string, hours: number): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM interrupt_alerts
     WHERE metric = $1 AND triggered_at > now() - ($2 || ' hours')::interval
     LIMIT 1`,
    [metric, hours]
  );
  return (result.rowCount ?? 0) > 0;
}
