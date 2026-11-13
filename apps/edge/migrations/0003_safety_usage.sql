-- One aggregate per project/database, no per-message append log. UTC day is
-- explicit application accounting; the permanent lock never resets on day change.
CREATE TABLE IF NOT EXISTS safety_d1_usage (
  scope TEXT PRIMARY KEY,
  utc_day INTEGER NOT NULL,
  reads_reserved INTEGER NOT NULL CHECK(reads_reserved >= 0),
  writes_reserved INTEGER NOT NULL CHECK(writes_reserved >= 0),
  reads_limit INTEGER NOT NULL CHECK(reads_limit >= 0),
  writes_limit INTEGER NOT NULL CHECK(writes_limit >= 0),
  blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
  lock_reason TEXT,
  updated_at INTEGER NOT NULL,
  recovery_version INTEGER NOT NULL DEFAULT 0,
  recovery_actor TEXT,
  recovery_reason TEXT,
  recovery_configuration TEXT,
  recovery_validation TEXT
);
CREATE TABLE IF NOT EXISTS safety_d1_recoveries (
  scope TEXT NOT NULL,
  version INTEGER NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  configuration TEXT NOT NULL,
  validation TEXT NOT NULL,
  recovered_at INTEGER NOT NULL,
  PRIMARY KEY(scope,version)
);
CREATE TRIGGER IF NOT EXISTS safety_d1_reservation_insert BEFORE INSERT ON safety_d1_usage
WHEN NEW.reads_reserved > NEW.reads_limit OR NEW.writes_reserved > NEW.writes_limit
BEGIN SELECT RAISE(ABORT, 'SAFETY_D1_DAILY_LIMIT'); END;
CREATE TRIGGER IF NOT EXISTS safety_d1_reservation_update BEFORE UPDATE ON safety_d1_usage
WHEN NEW.reads_reserved > NEW.reads_limit OR NEW.writes_reserved > NEW.writes_limit
BEGIN SELECT RAISE(ABORT, 'SAFETY_D1_DAILY_LIMIT'); END;
CREATE TRIGGER IF NOT EXISTS safety_d1_clock_rollback BEFORE UPDATE ON safety_d1_usage
WHEN NEW.utc_day < OLD.utc_day
BEGIN SELECT RAISE(ABORT, 'SAFETY_D1_CLOCK_ROLLBACK'); END;
CREATE TRIGGER IF NOT EXISTS safety_d1_latched BEFORE UPDATE ON safety_d1_usage
WHEN OLD.blocked = 1 AND NOT (
  NEW.blocked = 0 AND NEW.recovery_version > OLD.recovery_version
  AND length(NEW.recovery_actor) > 0 AND length(NEW.recovery_reason) > 0
  AND length(NEW.recovery_configuration) > 0 AND length(NEW.recovery_validation) > 0
  AND NEW.utc_day = OLD.utc_day
  AND NEW.reads_reserved = OLD.reads_reserved
  AND NEW.writes_reserved = OLD.writes_reserved
)
BEGIN SELECT RAISE(ABORT, 'SAFETY_D1_BLOCKED'); END;
CREATE INDEX IF NOT EXISTS game_releases_catalog ON game_releases(catalog_visible,game_id);
CREATE INDEX IF NOT EXISTS game_releases_latest ON game_releases(game_id,created_at DESC,game_build_id DESC);
