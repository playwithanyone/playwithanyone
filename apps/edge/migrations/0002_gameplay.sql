-- Explicit owner/entry registry: a random URL may never instantiate an arbitrary RoomDO.
CREATE TABLE IF NOT EXISTS game_rooms (
  room_id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_rooms (
  session_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  PRIMARY KEY(session_id,room_id)
);
CREATE INDEX IF NOT EXISTS session_rooms_by_room ON session_rooms(room_id);
CREATE TABLE IF NOT EXISTS game_results (
  match_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  game_build_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('WIN','DRAW','DISCONNECTED','SERVICE_INTERRUPTED')),
  winner TEXT CHECK(winner IS NULL OR winner IN ('red','yellow')),
  red_player_id TEXT,
  yellow_player_id TEXT,
  evidence TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS player_statistics (
  player_id TEXT NOT NULL,
  game_build_id TEXT NOT NULL,
  matches INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(player_id,game_build_id)
);
-- Only insertion of a new genuine WIN/DRAW result changes statistics. Repeated
-- outbox deliveries and interruption results never produce duplicate scores.
CREATE TRIGGER IF NOT EXISTS game_result_red_stats AFTER INSERT ON game_results
WHEN NEW.outcome IN ('WIN','DRAW') AND NEW.red_player_id IS NOT NULL
BEGIN
  INSERT INTO player_statistics VALUES(NEW.red_player_id,NEW.game_build_id,1,
    CASE WHEN NEW.winner='red' THEN 1 ELSE 0 END,CASE WHEN NEW.outcome='DRAW' THEN 1 ELSE 0 END)
  ON CONFLICT(player_id,game_build_id) DO UPDATE SET matches=matches+1,wins=wins+excluded.wins,draws=draws+excluded.draws;
END;
CREATE TRIGGER IF NOT EXISTS game_result_yellow_stats AFTER INSERT ON game_results
WHEN NEW.outcome IN ('WIN','DRAW') AND NEW.yellow_player_id IS NOT NULL
BEGIN
  INSERT INTO player_statistics VALUES(NEW.yellow_player_id,NEW.game_build_id,1,
    CASE WHEN NEW.winner='yellow' THEN 1 ELSE 0 END,CASE WHEN NEW.outcome='DRAW' THEN 1 ELSE 0 END)
  ON CONFLICT(player_id,game_build_id) DO UPDATE SET matches=matches+1,wins=wins+excluded.wins,draws=draws+excluded.draws;
END;
