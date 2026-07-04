-- =============================================================
-- NAWEC Customer App — Neon Postgres schema
-- Run once in the Neon SQL editor.
-- =============================================================

CREATE TABLE IF NOT EXISTS customers (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL,
  meter_number  TEXT NOT NULL UNIQUE,
  meter_type    TEXT NOT NULL DEFAULT 'prepaid',   -- prepaid | postpaid
  area          TEXT DEFAULT '',
  pin_hash      TEXT NOT NULL,
  pin_salt      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cash power purchases (token vending)
CREATE TABLE IF NOT EXISTS purchases (
  id            SERIAL PRIMARY KEY,
  customer_id   INT NOT NULL REFERENCES customers(id),
  amount_gmd    NUMERIC(10,2) NOT NULL,
  units_kwh     NUMERIC(10,2) NOT NULL,
  token         TEXT NOT NULL,                     -- 20-digit STS token
  provider      TEXT NOT NULL DEFAULT 'demo',      -- demo | qmoney | africell | wave
  payment_ref   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'completed', -- pending | completed | failed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Alerts published by NAWEC (planned maintenance, active outages)
CREATE TABLE IF NOT EXISTS outage_alerts (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  area          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  service       TEXT NOT NULL DEFAULT 'electricity', -- electricity | water
  status        TEXT NOT NULL DEFAULT 'active',      -- planned | active | resolved
  starts_at     TIMESTAMPTZ,
  ends_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outage reports submitted by customers
CREATE TABLE IF NOT EXISTS outage_reports (
  id            SERIAL PRIMARY KEY,
  customer_id   INT NOT NULL REFERENCES customers(id),
  service       TEXT NOT NULL DEFAULT 'electricity',
  area          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  status        TEXT NOT NULL DEFAULT 'open',        -- open | investigating | resolved
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Postpaid bills (also shows prepaid purchase history via purchases table)
CREATE TABLE IF NOT EXISTS bills (
  id            SERIAL PRIMARY KEY,
  customer_id   INT NOT NULL REFERENCES customers(id),
  period        TEXT NOT NULL,                       -- e.g. '2026-06'
  amount_gmd    NUMERIC(10,2) NOT NULL,
  due_date      DATE,
  status        TEXT NOT NULL DEFAULT 'unpaid',      -- unpaid | paid
  paid_at       TIMESTAMPTZ
);

-- Customer-submitted meter readings
CREATE TABLE IF NOT EXISTS meter_readings (
  id            SERIAL PRIMARY KEY,
  customer_id   INT NOT NULL REFERENCES customers(id),
  reading_kwh   NUMERIC(12,2) NOT NULL,
  note          TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchases_customer ON purchases(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status     ON outage_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_status      ON outage_alerts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_readings_customer  ON meter_readings(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bills_customer     ON bills(customer_id, period DESC);

-- Sample alert so the feed isn't empty on first demo
INSERT INTO outage_alerts (title, area, description, service, status, starts_at, ends_at)
VALUES ('Planned maintenance — Kotu Power Station',
        'Kotu, Manjai, Kololi',
        'Scheduled generator maintenance. Supply will be restored by 18:00.',
        'electricity', 'planned', now() + interval '1 day', now() + interval '1 day 6 hours');
