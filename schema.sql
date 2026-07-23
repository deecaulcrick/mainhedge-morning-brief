-- Mainhedge Morning Brief schema
-- Run once via: npm run init-db (or paste directly into Neon's SQL editor)

CREATE TABLE IF NOT EXISTS articles (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL,
  url           TEXT NOT NULL UNIQUE,
  headline      TEXT NOT NULL,
  raw_text      TEXT,
  published_at  TIMESTAMPTZ,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_articles_fetched_at ON articles (fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_source ON articles (source);

CREATE TABLE IF NOT EXISTS extracted_facts (
  id            BIGSERIAL PRIMARY KEY,
  article_id    BIGINT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  metric        TEXT NOT NULL,        -- e.g. 'brent_usd', 'btc_usd', 'ngn_parallel_rate'
  value         NUMERIC,
  unit          TEXT,                 -- e.g. 'usd', 'pct', 'ngn'
  as_reported   BOOLEAN NOT NULL DEFAULT true,  -- always true for v1: approximate/lagged, not live data
  confidence    NUMERIC,              -- 0-1, model's confidence in the extraction
  extracted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_extracted_facts_metric ON extracted_facts (metric, extracted_at DESC);

CREATE TABLE IF NOT EXISTS article_summaries (
  article_id    BIGINT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  topic         TEXT,
  summary       TEXT,
  direction     TEXT,   -- 'up' | 'down' | 'neutral' | null
  relevance     NUMERIC -- 0-1, how relevant to the desk's mandate
);

CREATE TABLE IF NOT EXISTS briefs (
  id            BIGSERIAL PRIMARY KEY,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  posture       TEXT NOT NULL DEFAULT 'normal'  -- 'normal' | 'watch' | 'alert'
);

CREATE TABLE IF NOT EXISTS insights (
  id                    BIGSERIAL PRIMARY KEY,
  brief_id              BIGINT NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
  severity              TEXT NOT NULL,  -- 'alert' | 'watch' | 'info'
  headline              TEXT NOT NULL,
  detail                TEXT NOT NULL,
  supporting_article_ids BIGINT[] NOT NULL DEFAULT '{}',
  sort_order            INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS interrupt_alerts (
  id            BIGSERIAL PRIMARY KEY,
  metric        TEXT NOT NULL,
  value         NUMERIC NOT NULL,
  threshold     NUMERIC NOT NULL,
  direction     TEXT NOT NULL,  -- 'above' | 'below'
  article_id    BIGINT REFERENCES articles(id),
  triggered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered     BOOLEAN NOT NULL DEFAULT false
);
