import Anthropic from "@anthropic-ai/sdk";
import { pool, InsightInput } from "./db.js";
import { CLAUDE_MODEL } from "./config.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYNTHESIS_SYSTEM_PROMPT = `You are writing a morning brief for a Nigeria-focused FX & macro research desk
(Mainhedge). You will be given: (1) recently extracted numeric facts, each
tagged with its source article, and (2) recent article summaries. All figures
are "as-reported" — pulled from news text, not a live market feed — so do not
present them with false precision or claim real-time accuracy.

Produce 3-6 insight cards. Each should:
- Be genuinely useful to a desk tracking Nigerian FX, oil, US rates, and
  crypto/stablecoin conditions
- Assign a severity: "alert" (something that clearly demands attention now),
  "watch" (worth monitoring, not yet critical), or "info" (background/context,
  no action implied)
- Include a short bolded-style headline clause and a 1-2 sentence detail,
  similar in tone to: "Brent +4.45% to $86.82 after the US reinstated the
  Hormuz blockade. Below the $95 posture trigger, but a sustained move resets
  the inflation thesis."
- Reference which article ids support the claim

Also decide an overall "posture": "alert" if any insight is alert-level,
"watch" if the highest severity present is watch, else "normal".

Respond ONLY with valid JSON, no markdown fences:

{
  "posture": "normal" | "watch" | "alert",
  "insights": [
    { "severity": "alert" | "watch" | "info", "headline": "...", "detail": "...", "supporting_article_ids": [<int>, ...] }
  ]
}

If there isn't enough material for a full brief, return fewer insights rather
than padding with low-value content.`;

export async function synthesizeBrief(): Promise<{ posture: string; insights: InsightInput[] } | null> {
  // Pull the last 24h of facts + summaries as synthesis input.
  const factsResult = await pool.query(
    `SELECT ef.article_id, ef.metric, ef.value, ef.unit, ef.confidence, a.source, a.headline, a.url
     FROM extracted_facts ef
     JOIN articles a ON a.id = ef.article_id
     WHERE ef.extracted_at > now() - interval '24 hours'
     ORDER BY ef.extracted_at DESC`
  );

  const summariesResult = await pool.query(
    `SELECT s.article_id, s.topic, s.summary, s.direction, s.relevance, a.source, a.headline, a.url
     FROM article_summaries s
     JOIN articles a ON a.id = s.article_id
     WHERE a.fetched_at > now() - interval '24 hours'
     ORDER BY s.relevance DESC NULLS LAST`
  );

  if (factsResult.rowCount === 0 && summariesResult.rowCount === 0) {
    console.log("[synthesize] No material in the last 24h — skipping brief.");
    return null;
  }

  const inputPayload = {
    facts: factsResult.rows,
    summaries: summariesResult.rows,
  };

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    system: SYNTHESIS_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Here is the last 24h of extracted material:\n\n${JSON.stringify(inputPayload, null, 2)}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") return null;

  try {
    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return parsed;
  } catch (err) {
    console.error("[synthesize] Failed to parse synthesis output:", textBlock.text.slice(0, 300));
    return null;
  }
}
