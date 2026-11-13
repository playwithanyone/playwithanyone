CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  player_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS game_releases (
  game_build_id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  frame_origin TEXT NOT NULL UNIQUE,
  browser_manifest TEXT NOT NULL,
  catalog_visible INTEGER NOT NULL DEFAULT 0 CHECK (catalog_visible IN (0, 1)),
  catalog_entry TEXT,
  created_at INTEGER NOT NULL
);
