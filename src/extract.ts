import Anthropic from "@anthropic-ai/sdk";
import { ArticleRow, insertExtractedFact, insertArticleSummary } from "./db.js";
import { CLAUDE_MODEL } from "./config.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACTION_SYSTEM_PROMPT = `You are a financial news extraction assistant for a Nigeria-focused FX & macro
research desk. Given a news article, extract:

1. Any numeric figures relevant to: oil prices (Brent/WTI), USD/NGN exchange
   rates (official NFEM or parallel/black-market), Nigerian FX parallel-market
   premium, Nigerian external reserves, US Treasury yields, Fed rate-hike
   odds, Bitcoin/crypto/stablecoin prices. Only extract a figure if it is
   explicitly stated in the text — never estimate or infer a number that
   isn't there.
2. A short summary of the article's relevance to the desk (2-3 sentences max).

Respond ONLY with valid JSON, no markdown fences, no preamble, matching this shape:

{
  "facts": [
    { "metric": "brent_usd" | "wti_usd" | "ngn_official_rate" | "ngn_parallel_rate" | "ngn_parallel_premium_pct" | "ngn_reserves_usd_bn" | "us_2y_yield_pct" | "fed_hike_odds_pct" | "btc_usd" | "other_metric_name",
      "value": <number>,
      "unit": "usd" | "pct" | "ngn" | "usd_bn",
      "confidence": <0-1, how explicit/reliable this figure is in the text> }
  ],
  "summary": {
    "topic": "<short topic label>",
    "summary": "<2-3 sentence summary>",
    "direction": "up" | "down" | "neutral",
    "relevance": <0-1, how relevant this is to Nigeria FX/macro/crypto desk work>
  }
}

If there are no relevant numeric facts, return an empty "facts" array — do not
fabricate one. If the article isn't relevant to the desk at all, set
relevance close to 0 but still return the shape above.`;

interface ExtractionResult {
  facts: { metric: string; value: number; unit: string; confidence: number }[];
  summary: { topic: string; summary: string; direction: string; relevance: number };
}

export async function extractArticle(article: ArticleRow): Promise<ExtractionResult | null> {
  const text = article.raw_text ?? article.headline;

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1000,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Headline: ${article.headline}\nSource: ${article.source}\n\nArticle text:\n${text}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return null;

  let parsed: ExtractionResult;
  try {
    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error(`[extract] Failed to parse JSON for article ${article.id}:`, textBlock.text.slice(0, 200));
    return null;
  }

  return parsed;
}

// Run extraction for a batch of newly-ingested articles and persist results.
export async function extractAndStore(articles: ArticleRow[]): Promise<void> {
  for (const article of articles) {
    try {
      const result = await extractArticle(article);
      if (!result) continue;

      for (const fact of result.facts) {
        await insertExtractedFact({
          article_id: article.id,
          metric: fact.metric,
          value: fact.value,
          unit: fact.unit,
          confidence: fact.confidence,
        });
      }

      await insertArticleSummary({
        article_id: article.id,
        topic: result.summary.topic,
        summary: result.summary.summary,
        direction: result.summary.direction,
        relevance: result.summary.relevance,
      });
    } catch (err) {
      console.error(`[extract] Failed on article ${article.id} (${article.url}):`, (err as Error).message);
    }
  }
}
