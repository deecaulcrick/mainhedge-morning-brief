import { InsightWithSources } from "./db.js";

// The dashboard's data contract isn't nailed down yet (see CLAUDE.md "Open
// questions"). Two modes are supported so you can wire this up either way
// without changing the rest of the pipeline:
//
//   DASHBOARD_MODE=db  -> the dashboard reads straight from the `briefs` /
//                         `insights` tables in Postgres. This function is a
//                         no-op in that case, since saveBrief() in db.ts
//                         already wrote everything the dashboard needs.
//
//   DASHBOARD_MODE=api -> this function POSTs the finished brief as JSON to
//                         DASHBOARD_API_URL. Adjust the payload shape below
//                         to match whatever the dashboard actually expects
//                         once that's confirmed.

export async function deliverToDashboard(briefId: number, posture: string, insights: InsightWithSources[]) {
  const mode = process.env.DASHBOARD_MODE ?? "db";

  if (mode === "db") {
    console.log("[dashboard] DASHBOARD_MODE=db — brief already in Postgres, nothing further to push.");
    return;
  }

  const apiUrl = process.env.DASHBOARD_API_URL;
  if (!apiUrl) {
    console.warn("[dashboard] DASHBOARD_MODE=api but DASHBOARD_API_URL is not set — skipping.");
    return;
  }

  const payload = {
    brief_id: briefId,
    generated_at: new Date().toISOString(),
    posture,
    insights,
  };

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.DASHBOARD_API_KEY ? { Authorization: `Bearer ${process.env.DASHBOARD_API_KEY}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error(`[dashboard] Push failed: ${res.status} ${await res.text()}`);
  } else {
    console.log("[dashboard] Brief pushed to dashboard API.");
  }
}
