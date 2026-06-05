-- Madame Fafi — Full Database Schema
-- Run this once on a fresh Neon database to create all tables.

-- ─── users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                    SERIAL PRIMARY KEY,
  username              VARCHAR(100) NOT NULL,
  email                 VARCHAR(255) NOT NULL UNIQUE,
  password_hash         TEXT NOT NULL,
  credits               INTEGER NOT NULL DEFAULT 1,
  is_unlimited          BOOLEAN NOT NULL DEFAULT FALSE,
  is_admin              BOOLEAN NOT NULL DEFAULT FALSE,
  signup_source         VARCHAR(100) DEFAULT 'direct',
  referral_code         VARCHAR(20) UNIQUE,
  daily_credit_used_at  TIMESTAMPTZ,
  dice_roll_used_at     TIMESTAMPTZ,
  dice_roll_result      INTEGER,
  dice_draws_remaining  INTEGER DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── readings ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS readings (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode       VARCHAR(50) NOT NULL DEFAULT 'oracle',
  cards      JSONB,
  fortune    TEXT,
  question   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_readings_user_id ON readings(user_id);

-- ─── purchases ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS purchases (
  id                        SERIAL PRIMARY KEY,
  user_id                   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_session_id         VARCHAR(255) UNIQUE,
  stripe_payment_intent_id  VARCHAR(255) UNIQUE,
  pack_id                   VARCHAR(20),
  credits                   INTEGER NOT NULL,
  amount_cents              INTEGER NOT NULL DEFAULT 0,
  currency                  VARCHAR(10) NOT NULL DEFAULT 'eur',
  status                    VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_purchases_user_id ON purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status);

-- ─── reviews ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username   VARCHAR(100) NOT NULL,
  comment    TEXT NOT NULL,
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── promo_codes ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_codes (
  id         SERIAL PRIMARY KEY,
  code       VARCHAR(50) NOT NULL UNIQUE,
  credits    INTEGER NOT NULL,
  max_uses   INTEGER,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── promo_code_uses ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promo_code_uses (
  id             SERIAL PRIMARY KEY,
  promo_code_id  INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credits        INTEGER NOT NULL,
  used_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (promo_code_id, user_id)
);

-- ─── pending_payments ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_payments (
  id             SERIAL PRIMARY KEY,
  email          VARCHAR(255) NOT NULL,
  pack_id        VARCHAR(20),
  credits        INTEGER NOT NULL,
  amount         NUMERIC(10,2) DEFAULT 0,
  description    TEXT,
  transaction_id VARCHAR(255) UNIQUE,
  credited_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── sent_emails ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sent_emails (
  id                  SERIAL PRIMARY KEY,
  recipient_email     VARCHAR(255) NOT NULL,
  recipient_username  VARCHAR(100),
  subject             TEXT,
  message             TEXT,
  status              VARCHAR(20) DEFAULT 'sent',
  sent_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── referrals ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id          SERIAL PRIMARY KEY,
  referrer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code        VARCHAR(20) NOT NULL,
  status      VARCHAR(30) NOT NULL DEFAULT 'pending',
  credited    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (referred_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);

-- Done!
SELECT 'Schema created successfully' AS result;
