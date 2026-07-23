import { InsightWithSources } from "./db.js";

const SEVERITY_COLOR: Record<string, number> = {
  alert: 0xdc2626, // red
  watch: 0xd97706, // amber
  info: 0x16a34a,  // green
};

const SEVERITY_LABEL: Record<string, string> = {
  alert: "🔴 ALERT",
  watch: "🟡 WATCH",
  info: "🟢 INFO",
};

const DISCORD_FIELD_LIMIT = 1024;
const DETAIL_MAX = 500; // leave room for source links within the 1024 field cap

// Compose an insight's field value: the detail text followed by a line of
// clickable source links. Source URLs (esp. Google News) can be very long, so
// links are added whole, one at a time, only while they still fit — a link is
// never truncated mid-URL, and any that don't fit collapse into a "+N more".
function buildFieldValue(insight: InsightWithSources): string {
  const detail = insight.detail.slice(0, DETAIL_MAX);
  if (!insight.sources.length) return detail;

  let line = "";
  let shown = 0;
  for (const s of insight.sources) {
    const item = `[${s.source}](${s.url})`;
    const candidate = line ? `${line} · ${item}` : item;
    // +6 headroom so a trailing " +N more" marker can't push us over the cap.
    if (`${detail}\n\n🔗 ${candidate}`.length + 6 > DISCORD_FIELD_LIMIT) break;
    line = candidate;
    shown++;
  }

  if (!line) return detail; // not even one link fit — show detail alone
  const more = insight.sources.length - shown;
  return `${detail}\n🔗 ${line}${more > 0 ? ` +${more} more\n` : ""}`;
}

export async function postBriefToDiscord(posture: string, insights: InsightWithSources[]) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("[discord] DISCORD_WEBHOOK_URL not set — skipping delivery.");
    return;
  }

  const postureColor = posture === "alert" ? SEVERITY_COLOR.alert : posture === "watch" ? SEVERITY_COLOR.watch : SEVERITY_COLOR.info;

  const embed = {
    title: "Morning Brief — Mainhedge FX & Macro Desk",
    description: `Posture: **${posture.toUpperCase()}**`,
    color: postureColor,
    timestamp: new Date().toISOString(),
    fields: insights.map((insight) => ({
      name: `${SEVERITY_LABEL[insight.severity]}: ${insight.headline}`,
      value: buildFieldValue(insight),
    })),
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!res.ok) {
    console.error(`[discord] Webhook post failed: ${res.status} ${await res.text()}`);
  } else {
    console.log("[discord] Brief posted.");
  }
}

// Standalone interrupt alert — separate, lighter-weight message. Does NOT
// touch the full brief; the next scheduled brief run will reconcile.
export async function postInterruptAlert(params: {
  metric: string;
  value: number;
  threshold: number;
  direction: "above" | "below";
  label: string;
  articleUrl?: string;
}) {
  const webhookUrl = process.env.DISCORD_INTERRUPT_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("[discord] No webhook configured for interrupt alerts.");
    return;
  }

  const embed = {
    title: `⚠️ Interrupt: ${params.label}`,
    description: [
      `**${params.metric}** is ${params.direction} threshold (${params.threshold}): as-reported value **${params.value}**.`,
      params.articleUrl ? `Source: ${params.articleUrl}` : null,
      `_This is a standalone alert. The full brief will reconcile at the next scheduled run._`,
    ]
      .filter(Boolean)
      .join("\n"),
    color: SEVERITY_COLOR.alert,
    timestamp: new Date().toISOString(),
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!res.ok) {
    console.error(`[discord] Interrupt webhook post failed: ${res.status} ${await res.text()}`);
  } else {
    console.log(`[discord] Interrupt alert posted: ${params.label}`);
  }
}
