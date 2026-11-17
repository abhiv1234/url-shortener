CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE urls
  ADD CONSTRAINT urls_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL;

-- Supports the hourly expired-link purge.
CREATE INDEX IF NOT EXISTS idx_urls_expires_at ON urls (expires_at) WHERE expires_at IS NOT NULL;
