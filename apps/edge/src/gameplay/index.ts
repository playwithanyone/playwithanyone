import type { BrowserReleaseManifest } from "../../../../packages/release/src/release.js";
import type { Principal, GameplayEnv, FixedGame, QueueView } from "./types.js";
import { POOL_ID } from "./types.js";
import { ApiError, jsonResponse, readObject } from "../security.js";
import { checkId, checkUuid, closed, internal, internalJson } from "./storage.js";
import { gameplayPolicy } from "./policy.js";
import { parseRoomRouting, selectRoomRoute, type RoomRoute } from "./join-ticket.js";

export { MatchPoolDO } from "./pool.js";
export { RoomDO } from "./room.js";
export type { DoNamespace } from "./types.js";

function route(env: GameplayEnv, roomId: string): RoomRoute | undefined {
  if (!env.ROOM_ROUTING_JSON && (env.APP_ENV === "fixture" || env.ROOM_LEGACY_GRANTS_ENABLED === "true")) return undefined;
  return selectRoomRoute(parseRoomRouting(env.ROOM_ROUTING_JSON, env.APP_ENV), { gameId: "connect-four", releaseHash: env.CONNECT_FOUR_BUILD_ID!, roomId });
}
function poolOwner(env: GameplayEnv): string { return route(env, "allocation")?.physicalOwner ?? POOL_ID; }
async function fixedGame(env: GameplayEnv, resolveRelease: (buildId: string) => Promise<BrowserReleaseManifest>): Promise<FixedGame> {
  if (!env.CONNECT_FOUR_BUILD_ID) throw new ApiError("CAPABILITY_UNAVAILABLE", 503, "gameplay");
  let candidate: unknown;
  try { candidate = env.GAMEPLAY_POLICY_JSON ? JSON.parse(env.GAMEPLAY_POLICY_JSON) : undefined; } catch { throw new ApiError("POLICY_INVALID", 503, "policy"); }
  const policy = gameplayPolicy(candidate), release = await resolveRelease(env.CONNECT_FOUR_BUILD_ID);
  if (release.gameId !== "connect-four" || release.profile.id !== "server-turn" || release.profile.version !== 1) throw new ApiError("RELEASE_INCOMPATIBLE", 409);
  const routing = route(env, "allocation");
  return { release, ...policy, ...(routing ? { poolOwnerId: routing.physicalOwner, poolId: routing.poolId, executionClass: routing.executionClass } : {}) };
}
async function admission(env: GameplayEnv, principal: Principal, roomId: string): Promise<Record<string, unknown>> {
  if (!env.ROOM_ROUTING_JSON) return {};
  return internalJson(env.ROOMS, roomId, { op: "grant", principal, requestId: crypto.randomUUID() });
}
async function queueResponse(env: GameplayEnv, principal: Principal, view: QueueView): Promise<Record<string, unknown>> {
  if (view.status === "ASSIGNED" && view.roomId) return { ...view, ...await admission(env, principal, view.roomId) };
  return { ...view, ...(view.status === "QUEUED" ? { watchUrl: `${env.SHELL_ORIGIN.replace(/^http/, "ws")}/api/play/queue/${encodeURIComponent(view.intentId)}/socket` } : {}) };
}
/** Signed room admission performs identity verification in the room host itself.
 * The edge registry lookup only prevents arbitrary names from instantiating DOs. */
export async function gameplaySocketRoute(request: Request, env: GameplayEnv): Promise<Response | undefined> {
  if (!env.ROOM_ROUTING_JSON) return undefined;
  const url = new URL(request.url), match = /^\/api\/play\/rooms\/([a-f0-9-]+)\/socket$/.exec(url.pathname);
  if (!match) return undefined;
  if (!env.ROOMS || env.GAMEPLAY_ENABLED !== "true") throw new ApiError("CAPABILITY_UNAVAILABLE", 503);
  checkUuid(match[1]);
  if (url.search || request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new ApiError("UPGRADE_REQUIRED", 426);
  if (request.headers.get("Origin") !== env.SHELL_ORIGIN) throw new ApiError("ORIGIN_REJECTED", 403);
  route(env, match[1]);
  const known = await env.DB.prepare("SELECT room_id FROM game_rooms WHERE room_id=?").bind(match[1]).first<{ room_id: string }>();
  if (!known) throw new ApiError("ROOM_NOT_FOUND", 404, "room");
  return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(new Request("https://room.internal/", { headers: { Upgrade: "websocket", Origin: env.SHELL_ORIGIN } }));
}
/** Control API authentication precedes this handler. There is no public DO proxy. */
export async function gameplayRoute(request: Request, env: GameplayEnv, principal: Principal,
  resolveRelease: (buildId: string) => Promise<BrowserReleaseManifest>): Promise<Response> {
  if (env.GAMEPLAY_ENABLED !== "true" || !env.MATCH_POOL || !env.ROOMS) throw new ApiError("CAPABILITY_UNAVAILABLE", 503, "gameplay");
  const url = new URL(request.url), rawPath = url.pathname;
  if (url.search || /%(?!3a)|\\/i.test(rawPath)) throw new ApiError("INVALID_REQUEST", 400);
  const path = rawPath.replace(/%3a/ig, ":");
  const owner = path === "/api/play/queue" || path === "/api/play/rooms" || path.startsWith("/api/play/queue/") ? poolOwner(env) : POOL_ID;
  if (path === "/api/play/queue" && request.method === "POST") {
    const body = await readObject(request); closed(body, ["requestId"]); checkId(body["requestId"]);
    const view = await internalJson<QueueView>(env.MATCH_POOL, owner, { op: "queue", principal, requestId: body["requestId"], game: await fixedGame(env, resolveRelease) });
    return jsonResponse(await queueResponse(env, principal, view), env);
  }
  if (path === "/api/play/rooms" && request.method === "POST") {
    const body = await readObject(request); closed(body, ["requestId"]); checkId(body["requestId"]);
    const created = await internalJson<{ roomId: string }>(env.MATCH_POOL, owner, { op: "create", principal, requestId: body["requestId"], game: await fixedGame(env, resolveRelease) });
    const status = await internalJson<Record<string, unknown>>(env.ROOMS, created.roomId, { op: "status", principal });
    return jsonResponse({ ...status, ...await admission(env, principal, created.roomId) }, env);
  }
  const queue = /^\/api\/play\/queue\/([A-Za-z0-9:._-]+)(\/(cancel|socket))?$/.exec(path);
  if (queue) {
    const intentId = queue[1]!; checkId(intentId);
    if (queue[3] === "socket" && request.method === "GET") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new ApiError("UPGRADE_REQUIRED", 426);
      if (request.headers.get("Origin") !== env.SHELL_ORIGIN) throw new ApiError("ORIGIN_REJECTED", 403);
      return env.MATCH_POOL.get(env.MATCH_POOL.idFromName(owner)).fetch(new Request(`https://pool.internal/queue/${encodeURIComponent(intentId)}/socket`, { headers: { Upgrade: "websocket", Origin: env.SHELL_ORIGIN, "X-PWA-Principal": JSON.stringify(principal) } }));
    }
    if (queue[3] === "cancel" && request.method === "POST") {
      const body = await readObject(request); closed(body, ["requestId", "expectedRevision"]); checkId(body["requestId"]);
      return jsonResponse(await internalJson(env.MATCH_POOL, owner, { op: "cancel", principal, intentId, ...body }), env);
    }
    if (!queue[2] && request.method === "GET") return jsonResponse(await queueResponse(env, principal, await internalJson<QueueView>(env.MATCH_POOL, owner, { op: "status", principal, intentId })), env);
    throw new ApiError("METHOD_NOT_ALLOWED", 405);
  }
  const room = /^\/api\/play\/rooms\/([a-f0-9-]+)\/(join|grant|presentation|status|ready|socket)$/.exec(path);
  if (!room) throw new ApiError("NOT_FOUND", 404);
  const roomId = room[1]!, op = room[2]!; checkUuid(roomId);
  const registered = await env.DB.prepare("SELECT room_id FROM game_rooms WHERE room_id=?").bind(roomId).first<{ room_id: string }>();
  if (!registered) throw new ApiError("ROOM_NOT_FOUND", 404, "room");
  if (op === "socket" && request.method === "GET") {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new ApiError("UPGRADE_REQUIRED", 426);
    if (request.headers.get("Origin") !== env.SHELL_ORIGIN) throw new ApiError("ORIGIN_REJECTED", 403);
    const headers = new Headers({ Upgrade: "websocket", Origin: env.SHELL_ORIGIN, "X-PWA-Principal": JSON.stringify(principal) });
    return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(new Request("https://room.internal/", { headers }));
  }
  if (op === "status" && request.method === "GET") return jsonResponse(await internalJson(env.ROOMS, roomId, { op, principal }), env);
  if (request.method !== "POST") throw new ApiError("METHOD_NOT_ALLOWED", 405);
  const body = await readObject(request);
  if (op === "ready") closed(body, ["requestId", "expectedMatchRevision", "resourcesReady", "baselineReady", "prepared", "baseline"]);
  else if (op === "presentation") closed(body, ["gameBuildId", "frameOrigin", "presentationInstanceId"]);
  else { closed(body, ["requestId"]); checkId(body["requestId"]); }
  const result = await internalJson<Record<string, unknown>>(env.ROOMS, roomId, { op, principal, ...body });
  if (op === "join") await env.DB.prepare("INSERT INTO session_rooms(session_id,room_id) VALUES (?,?) ON CONFLICT DO NOTHING").bind(principal.id, roomId).run();
  return jsonResponse(op === "join" ? { ...result, ...await admission(env, principal, roomId) } : result, env);
}
/** Revocation pages are bounded below Free's subrequest limit. The caller may
 * explicitly retry 503 after the session itself has already been revoked. */
export async function revokeGameplaySession(env: GameplayEnv, sessionId: string): Promise<void> {
  if (!env.ROOMS || env.GAMEPLAY_ENABLED !== "true") return;
  if (env.MATCH_POOL) await internalJson(env.MATCH_POOL, poolOwner(env), { op: "revoke-queue-session", sessionId });
  for (let page=0;page<2;page++) {
    const rooms = await env.DB.prepare("SELECT room_id FROM session_rooms WHERE session_id=? ORDER BY room_id LIMIT 8").bind(sessionId).all<{room_id:string}>();
    const failures:unknown[]=[];
    for(const room of rooms.results){try{const response=await internal(env.ROOMS,room.room_id,{op:"revoke-session",sessionId});if(!response.ok)failures.push(response.status);else await env.DB.prepare("DELETE FROM session_rooms WHERE session_id=? AND room_id=?").bind(sessionId,room.room_id).run();}catch(error){failures.push(error);}}
    if(failures.length)throw new ApiError("REVOCATION_INCOMPLETE",503,"auth",true);
    if(rooms.results.length<8)return;
  }
  if(await env.DB.prepare("SELECT room_id FROM session_rooms WHERE session_id=? LIMIT 1").bind(sessionId).first<{room_id:string}>())throw new ApiError("REVOCATION_INCOMPLETE",503,"auth",true);
}
