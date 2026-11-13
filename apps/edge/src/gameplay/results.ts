import { ApiError } from "../security.js";
import { hash } from "./storage.js";
import type { GameplayEnv, RoomRecord } from "./types.js";

/** The result insert and statistics triggers commit in one actual D1 transaction. */
export async function persistResult(env: GameplayEnv, room: RoomRecord): Promise<void> {
  if (room.phase !== "TERMINAL" || room.result === null) throw new ApiError("RESULT_NOT_FINAL", 409);
  if (!env.DB.batch) throw new ApiError("CAPABILITY_UNAVAILABLE", 503, "storage");
  const red = room.members.find(member => member.seatId === "red")?.playerId ?? null;
  const yellow = room.members.find(member => member.seatId === "yellow")?.playerId ?? null;
  const evidence = { matchId: room.matchId, roomId: room.roomId, gameBuildId: room.game.release.gameBuildId,
    result: room.result, winner: room.result === "WIN" ? (room.runtime?.winner ?? room.rules.winner) : null,
    // Connection/readiness metadata may still settle after a terminal board.
    // Freeze result identity to the immutable rule outcome, never those revisions.
    moves: room.rules.moves, board: room.rules.board, red, yellow };
  const digest = await hash(JSON.stringify(evidence));
  const insert = env.DB.prepare(`INSERT INTO game_results
    (match_id,room_id,game_build_id,digest,outcome,winner,red_player_id,yellow_player_id,evidence,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(match_id) DO NOTHING`).bind(room.matchId, room.roomId,
    room.game.release.gameBuildId, digest, room.result, evidence.winner, red, yellow, JSON.stringify(evidence), Date.now());
  const read = env.DB.prepare("SELECT digest FROM game_results WHERE match_id=?").bind(room.matchId);
  const results = await env.DB.batch([insert, read]);
  if (results.some(result => !result.success)) throw new ApiError("RESULT_WRITE_FAILED", 503);
  const stored = results[1]?.results?.[0] as { digest?: string } | undefined;
  if (!stored || stored.digest !== digest) throw new ApiError("RESULT_CONFLICT", 409);
}
