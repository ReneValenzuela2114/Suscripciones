-- Esquema D1 para la app de Suscripciones y Pagos
-- Todos los datos viven en D1. R2 solo guarda logos subidos por el usuario.

-- Preferencias de la app (clave/valor)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Valores por defecto
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('display_currency', 'GTQ'),      -- moneda en la que se muestran los totales: GTQ | USD
  ('exchange_rate', '7.8'),          -- cuántos GTQ equivale 1 USD (editable)
  ('reminder_days', '3'),            -- días de anticipación por defecto para avisar
  ('notify_phone', ''),              -- número de celular para SMS (formato +502...)
  ('notify_channel', 'app');         -- 'app' (solo banner) | 'sms' (Twilio)

-- Suscripciones / servicios
CREATE TABLE IF NOT EXISTS subscriptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  icon_type     TEXT NOT NULL DEFAULT 'emoji', -- 'emoji' | 'logo' | 'letter'
  icon_value    TEXT,                          -- emoji, clave R2 del logo, o inicial
  color         TEXT NOT NULL DEFAULT '#6366f1',
  amount        REAL NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'GTQ',    -- GTQ | USD
  billing_type  TEXT NOT NULL DEFAULT 'recurring', -- 'recurring' | 'manual'
  interval_unit TEXT NOT NULL DEFAULT 'month',  -- 'week' | 'month' | 'year'
  interval_count INTEGER NOT NULL DEFAULT 1,
  anchor_date   TEXT,                            -- fecha en que tomaste la suscripción (ISO)
  next_due_date TEXT,                            -- próximo pago (ISO yyyy-mm-dd)
  reminder_days INTEGER,                         -- override; NULL usa el global
  sort_order    INTEGER NOT NULL DEFAULT 0,
  manual_sort   INTEGER NOT NULL DEFAULT 0,      -- 1 si el usuario fijó orden manual
  active        INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  last_reminded TEXT,                            -- evita avisos repetidos (due_date avisado)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Historial y pagos programados (sobre todo para tipo 'manual')
CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  due_date        TEXT NOT NULL,
  amount          REAL NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'GTQ',
  paid            INTEGER NOT NULL DEFAULT 0,
  paid_date       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pay_sub ON payments(subscription_id);
CREATE INDEX IF NOT EXISTS idx_pay_due ON payments(due_date);
CREATE INDEX IF NOT EXISTS idx_sub_due ON subscriptions(next_due_date);
