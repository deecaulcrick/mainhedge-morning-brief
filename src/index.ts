import "dotenv/config";
import cron from "node-cron";
import { initDb, saveBrief, getArticleLinksByIds, InsightWithSources } from "./db.js";
import { ingestAllFeeds, ingestFeedsByCategory } from "./ingest.js";
import { extractAndStore } from "./extract.js";
import { synthesizeBrief } from "./synthesize.js";
import { postBriefToDiscord } from "./discord.js";
import { deliverToDashboard } from "./dashboard.js";
import { checkInterrupts } from "./interrupt.js";
import { POLL_TIERS, DAILY_BRIEF_HOUR_WAT, Category } from "./config.js";

// --- Full daily brief: ingest everything, extract, synthesize, deliver ---
// dryRun: skip DB save + Discord + dashboard and just print the brief (with its
// resolved source links) to the console — useful for testing without spending
// on delivery or polluting the briefs table.
export async function runFullBrief(opts: { dryRun?: boolean } = {}) {
  const { dryRun = false } = opts;
  console.log(`=== Running full morning brief${dryRun ? " (DRY RUN — nothing posted)" : ""} ===`);

  const newArticles = await ingestAllFeeds();
  console.log(`[brief] ${newArticles.length} new article(s) ingested.`);

  if (newArticles.length > 0) {
    await extractAndStore(newArticles);
  }

  const result = await synthesizeBrief();
  if (!result) {
    console.log("[brief] Nothing to synthesize — no brief generated.");
    return;
  }

  // Resolve each insight's supporting article ids into clickable source links
  // once, then reuse for storage + Discord + dashboard.
  const insights: InsightWithSources[] = await Promise.all(
    result.insights.map(async (ins) => ({
      ...ins,
      sources: await getArticleLinksByIds(ins.supporting_article_ids ?? []),
    }))
  );

  if (dryRun) {
    printBriefToConsole(result.posture, insights);
    console.log("=== Dry run complete — not saved, not posted ===");
    return;
  }

  const briefId = await saveBrief(result.posture, insights);
  console.log(`[brief] Saved brief #${briefId} with posture=${result.posture}, ${insights.length} insight(s).`);

  await postBriefToDiscord(result.posture, insights);
  await deliverToDashboard(briefId, result.posture, insights);

  console.log("=== Full brief complete ===");
}

// Human-readable brief dump for the console (dry-run testing). Shows each
// insight's resolved sources so you can confirm links are being attached.
function printBriefToConsole(posture: string, insights: InsightWithSources[]) {
  const sev: Record<string, string> = { alert: "🔴 ALERT", watch: "🟡 WATCH", info: "🟢 INFO" };
  console.log("\n──────────────────────────────────────────────");
  console.log(`  MORNING BRIEF — Posture: ${posture.toUpperCase()}`);
  console.log("──────────────────────────────────────────────");
  for (const ins of insights) {
    console.log(`\n${sev[ins.severity] ?? ins.severity}: ${ins.headline}`);
    console.log(`  ${ins.detail}`);
    if (ins.sources.length === 0) {
      console.log(`  Sources: (none resolved) ids=${JSON.stringify(ins.supporting_article_ids ?? [])}`);
    } else {
      console.log(`  Sources (${ins.sources.length}):`);
      for (const s of ins.sources) {
        console.log(`    • ${s.source} — ${s.headline}`);
        console.log(`      ${s.url}`);
      }
    }
  }
  console.log("\n──────────────────────────────────────────────\n");
}

// --- Interrupt cycle: fast-poll categories, extract, check thresholds ---
export async function runInterruptCycle(categories: Category[]) {
  console.log(`=== Running interrupt cycle for [${categories.join(", ")}] ===`);

  const newArticles = await ingestFeedsByCategory(categories);
  if (newArticles.length > 0) {
    await extractAndStore(newArticles);
  }

  await checkInterrupts();
  console.log("=== Interrupt cycle complete ===");
}

// --- CLI entry points, for manual runs or use inside a cron/CI job ---
const command = process.argv[2];

if (command === "init-db") {
  initDb().then(() => process.exit(0));
} else if (command === "brief") {
  const dryRun = process.argv.includes("--dry") || process.argv.includes("--dry-run");
  runFullBrief({ dryRun }).then(() => process.exit(0));
} else if (command === "interrupt") {
  // Runs both tiers once — call this from your own cron/GitHub Actions
  // schedule at whatever cadence you choose per tier (see README).
  const allCategories = [...POLL_TIERS.fast.categories, ...POLL_TIERS.slow.categories];
  runInterruptCycle(allCategories).then(() => process.exit(0));
} else if (command === "schedule") {
  // Optional: run this file as a long-lived process with built-in scheduling
  // instead of external cron. Useful for a single always-on server; skip
  // this if you're using serverless cron (Vercel/GitHub Actions) instead.
  console.log("[schedule] Starting in-process scheduler...");

  cron.schedule(`0 ${DAILY_BRIEF_HOUR_WAT} * * *`, () => {
    runFullBrief().catch((err) => console.error("[schedule] Full brief failed:", err));
  });

  cron.schedule(`*/${POLL_TIERS.fast.minutes} * * * *`, () => {
    runInterruptCycle(POLL_TIERS.fast.categories).catch((err) =>
      console.error("[schedule] Fast interrupt cycle failed:", err)
    );
  });

  cron.schedule(`*/${POLL_TIERS.slow.minutes} * * * *`, () => {
    runInterruptCycle(POLL_TIERS.slow.categories).catch((err) =>
      console.error("[schedule] Slow interrupt cycle failed:", err)
    );
  });

  console.log("[schedule] Cron jobs registered. Process will stay alive.");
} else {
  console.log("Usage: tsx src/index.ts <init-db|brief|interrupt|schedule>");
  process.exit(1);
}
