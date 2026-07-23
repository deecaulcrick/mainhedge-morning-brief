# Mainhedge Morning Brief — build guide

News-only v1: ingest RSS from a fixed source list, extract structured facts +
summaries with Claude, synthesize a daily brief, deliver to a dashboard (via
Postgres) and Discord (via webhook), plus a lightweight interrupt path for
threshold breaches.

Everything below assumes you're building and running this yourself,
step by step.

---

## 0. What you need before starting

- A Neon account (free tier is fine) — https://neon.tech
- An Anthropic API key — https://console.anthropic.com
- A Discord server where you can create a webhook (Server Settings →
  Integrations → Webhooks → New Webhook, on the channel you want the brief
  posted to)
- Node.js 20+ installed locally

---

## 1. Install dependencies

```bash
npm install
```

This pulls in: `@anthropic-ai/sdk`, `pg` (Postgres client), `rss-parser`,
`node-cron` (optional in-process scheduler), `dotenv`, plus TypeScript/tsx for
dev.

---

## 2. Set up the database

1. Create a Neon project, grab the connection string from the Neon dashboard
   (Dashboard → Connection Details).
2. Copy `.env.example` to `.env` and paste it in as `DATABASE_URL`.
3. Run the schema:

```bash
cp .env.example .env
# edit .env with your real values
npm run init-db
```

This creates 6 tables: `articles`, `extracted_facts`, `article_summaries`,
`briefs`, `insights`, `interrupt_alerts`. See `schema.sql` for the full
definitions — it's plain SQL, so you can also just paste it into Neon's SQL
editor in the web UI if you prefer not to run it from your machine.

---

## 3. Configure sources and thresholds

Open `src/config.ts`:

- `FEEDS` — the RSS sources. A starting list is filled in (Nairametrics,
  BusinessDay, TheCable, Proshare, OilPrice.com, Reuters, CoinDesk, The Block,
  Blockworks). **Verify each URL actually resolves** before relying on it —
  outlets change RSS paths without notice. If one 404s, check the site
  footer for its current feed link, or drop it from the list.
- Bloomberg has no API/RSS on your plan. Two options:
  - Skip it for automated ingestion entirely (simplest for v1)
  - Use `ingestManualArticle()` in `src/ingest.ts` to hand-log an article you
    read yourself — it'll flow through extraction/synthesis like any other
    source
- `THRESHOLDS` — the interrupt trigger levels (Brent > $95, etc). Edit values
  to match what your desk actually wants to be alerted on.
- `POLL_TIERS` — how often fast-moving (oil, crypto) vs. slower (FX/macro
  news) categories get polled for the interrupt path.

---

## 4. Set your API keys and webhook

In `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

Leave `DASHBOARD_MODE=db` for now (see step 6) unless your dashboard already
has an API endpoint ready to receive briefs.

---

## 5. Run a full brief manually

```bash
npm run brief
```

This runs the whole pipeline once: ingest all feeds → extract facts/summaries
from anything new → synthesize a brief → save it to Postgres → post to
Discord → (no-op or push to dashboard, depending on `DASHBOARD_MODE`).

Check your Discord channel — you should see an embed with color-coded
insights. Check Postgres (`select * from briefs; select * from insights;`) to
confirm it's there too.

If nothing posts: check the console output first — every step logs what it
did (`[ingest]`, `[extract]`, `[synthesize]`, `[discord]`, `[dashboard]`), so
you can see exactly where it stopped.

---

## 6. Wire up the dashboard

This is the one piece that depends on how your dashboard is actually built —
worth deciding now:

**Option A — dashboard reads directly from Postgres.**
Keep `DASHBOARD_MODE=db`. Point your dashboard's backend at the same Neon
database and have it query:

```sql
select * from briefs order by generated_at desc limit 1;
select * from insights where brief_id = <that id> order by sort_order;
```

Nothing else to build on this side — `saveBrief()` in `src/db.ts` already
writes everything the dashboard needs.

**Option B — dashboard exposes its own API.**
Set `DASHBOARD_MODE=api` and `DASHBOARD_API_URL` in `.env`. This script will
`POST` a JSON payload (`{ brief_id, generated_at, posture, insights }`) to
that URL after every brief. Adjust the payload shape in
`src/dashboard.ts::deliverToDashboard()` to match whatever your dashboard
actually expects.

---

## 7. Run the interrupt checker

```bash
npm run interrupt
```

This ingests the fast + slow poll categories once, extracts anything new, and
checks the latest fact per metric against your thresholds in `config.ts`. If
a threshold is breached and hasn't already fired within the last 6 hours
(`COOLDOWN_HOURS` in `src/interrupt.ts`), it posts a standalone alert to
Discord and logs it in `interrupt_alerts` — it does **not** regenerate the
full brief.

---

## 8. Schedule it for real

You have two reasonable options — pick one:

### Option A: external cron (recommended — simpler, no always-on process)

Use your host's cron, a serverless cron (Vercel Cron, GitHub Actions
scheduled workflow, a cron-as-a-service like cron-job.org hitting a small
HTTP endpoint you stand up), or similar. Trigger:

- `npm run brief` once daily, around 08:00 WAT (adjust for your host's
  timezone — WAT is UTC+1, so that's roughly `0 7 * * *` in UTC cron syntax)
- `npm run interrupt` on your fast tier (every 15 min, per `POLL_TIERS.fast`)
  — note this currently polls *all* categories each call; if you want true
  tiered polling (fast categories more often than slow), call
  `runInterruptCycle(["oil","crypto"])` on a 15-min schedule and
  `runInterruptCycle(["fx_macro"])` separately on a 60-min schedule instead
  of using the CLI shortcut. See `src/index.ts` — the exported functions are
  there to call directly if you want finer control than the CLI gives you.

Example GitHub Actions workflow (`.github/workflows/brief.yml`):

```yaml
name: Morning Brief
on:
  schedule:
    - cron: "0 7 * * *"   # 08:00 WAT
  workflow_dispatch: {}
jobs:
  brief:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install
      - run: npm run brief
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}
```

(Duplicate with a `*/15 * * * *` schedule and `run: npm run interrupt` for
the interrupt path.)

### Option B: in-process scheduler (simpler to reason about, needs an always-on host)

```bash
npm run build
node dist/index.js schedule
```

This uses `node-cron` inside the process itself (see the `schedule` branch
in `src/index.ts`) to run the daily brief and both interrupt tiers on their
own intervals, correctly split by category. Needs a host that stays running
(a small VPS, a Fly.io/Railway always-on service, etc.) — not suited to
serverless platforms that spin down between requests.

---

## 9. What's deliberately deferred

- **Monierate API / CBN structured data** — not wired in. v1 is news-only;
  extracted "as-reported" figures are a soft stand-in for real thresholds.
  When you're ready to add a live feed, insert its numbers into
  `extracted_facts` the same way `extract.ts` does, just with
  `confidence: 1.0` and skip the LLM extraction step for that source.
- **A true deterministic rules engine** — right now, threshold checks run
  against LLM-extracted numbers, which can be stale or misparsed. Don't treat
  these as reliable enough for anything beyond "worth a look" alerts until a
  real data feed backs them.
- **Bloomberg dashboard scraping** — not attempted. Bloomberg is read-only/
  manual in this build (see step 3).

## Project structure

```
mainhedge-morning-brief/
  package.json
  tsconfig.json
  .env.example
  schema.sql
  src/
    config.ts       # sources, thresholds, poll tiers
    db.ts            # Postgres connection + all queries
    ingest.ts         # RSS fetching + dedup
    extract.ts         # Claude: article -> structured facts + summary
    synthesize.ts       # Claude: today's facts/summaries -> brief insights
    discord.ts           # full-brief embed + standalone interrupt alerts
    dashboard.ts          # db no-op or API push, depending on DASHBOARD_MODE
    interrupt.ts           # threshold checking against latest facts
    index.ts                # CLI entry points + optional in-process scheduler
```
