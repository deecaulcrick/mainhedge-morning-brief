import { THRESHOLDS } from "./config.js";
import { getLatestFactPerMetric, insertInterruptAlert, alreadyAlertedRecently } from "./db.js";
import { postInterruptAlert } from "./discord.js";

// Checked on the fast-poll cycle after each ingest+extract pass. Fires a
// standalone alert (does NOT regenerate the brief) and rate-limits repeat
// alerts for the same metric within a cooldown window so a value sitting
// past a threshold doesn't spam the channel every cycle.
const COOLDOWN_HOURS = 6;

export async function checkInterrupts(): Promise<void> {
  const latestFacts = await getLatestFactPerMetric();
  const factsByMetric = new Map(latestFacts.map((f) => [f.metric, f]));

  for (const threshold of THRESHOLDS) {
    const fact = factsByMetric.get(threshold.metric);
    if (!fact) continue;

    const breached =
      threshold.direction === "above" ? fact.value > threshold.value : fact.value < threshold.value;

    if (!breached) continue;

    const alreadyAlerted = await alreadyAlertedRecently(threshold.metric, COOLDOWN_HOURS);
    if (alreadyAlerted) {
      console.log(`[interrupt] ${threshold.metric} still breached but within cooldown — skipping.`);
      continue;
    }

    await insertInterruptAlert({
      metric: threshold.metric,
      value: fact.value,
      threshold: threshold.value,
      direction: threshold.direction,
      article_id: fact.article_id,
    });

    await postInterruptAlert({
      metric: threshold.metric,
      value: fact.value,
      threshold: threshold.value,
      direction: threshold.direction,
      label: threshold.label,
    });
  }
}
