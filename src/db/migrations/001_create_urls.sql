CREATE TABLE IF NOT EXISTS urls (
  id BIGSERIAL PRIMARY KEY,
  short_code VARCHAR(16) UNIQUE NOT NULL,
  long_url TEXT NOT NULL,
  user_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_urls_user_created ON urls (user_id, created_at DESC);
