-- Projeto novo e isolado: nenhuma tabela de outros sistemas CR Jornada é alterada.
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  automation_enabled INTEGER NOT NULL DEFAULT 0,
  telegram_enabled INTEGER NOT NULL DEFAULT 0,
  channel_registered INTEGER NOT NULL DEFAULT 0,
  telegram_chat_id TEXT NOT NULL DEFAULT '@achadinhosmlcr',
  interval_minutes INTEGER NOT NULL DEFAULT 30,
  max_daily INTEGER NOT NULL DEFAULT 12,
  start_hour INTEGER NOT NULL DEFAULT 8,
  end_hour INTEGER NOT NULL DEFAULT 21,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
INSERT OR IGNORE INTO settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  affiliate_url TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'Geral',
  price_cents INTEGER,
  old_price_cents INTEGER,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'sending', 'published', 'needs_review')),
  published_at INTEGER,
  published_day TEXT,
  telegram_message_id INTEGER,
  last_error TEXT,
  verified_by_owner INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT price_positive CHECK (price_cents IS NULL OR price_cents > 0),
  CONSTRAINT old_price_positive CHECK (old_price_cents IS NULL OR old_price_cents > 0)
);
CREATE INDEX IF NOT EXISTS idx_offers_status_created ON offers(status, created_at);
CREATE INDEX IF NOT EXISTS idx_offers_published_day ON offers(published_day, status);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER,
  event TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (offer_id) REFERENCES offers(id)
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
