import type { Env } from "./env.js";
import { ApiError, enforceOrigin, jsonResponse } from "./security.js";

const COOKIE = "__Host-pwa_session";
interface SessionRow { session_id: string; player_id: string; expires_at: number }
export interface PlatformSession { readonly id: string; readonly playerId: string; readonly expiresAt: number }
function cookieToken(request: Request): string | undefined {
  const values = (request.headers.get("Cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return undefined;
  const token = values[0]!.slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}
async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}
function newToken(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function currentSession(request: Request, env: Env, required = true): Promise<PlatformSession | null> {
  const token = cookieToken(request);
  const row = token ? await env.DB.prepare("SELECT session_id, player_id, expires_at FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?").bind(await sha256(token), Date.now()).first<SessionRow>() : null;
  if (!row && required) throw new ApiError("AUTH_REQUIRED", 401, "auth");
  return row ? { id: row.session_id, playerId: row.player_id, expiresAt: row.expires_at } : null;
}
/** Cleanup identity only: permits retrying a partially delivered revocation.
 * This deliberately is not an authentication helper and must never admit work.
 */
export async function sessionRevocationTarget(request: Request, env: Env): Promise<PlatformSession | null> {
  const token = cookieToken(request);
  if (!token) return null;
  const row = await env.DB.prepare("SELECT session_id, player_id, expires_at FROM sessions WHERE token_hash = ?")
    .bind(await sha256(token)).first<SessionRow>();
  return row ? { id: row.session_id, playerId: row.player_id, expiresAt: row.expires_at } : null;
}
export async function sessionRoute(request: Request, env: Env, path: string): Promise<Response> {
  const mutating = request.method === "POST";
  enforceOrigin(request, env, mutating);
  if (path === "/api/session" && request.method === "GET") return jsonResponse({ session: await currentSession(request, env, false) }, env);
  if (path === "/api/session" && request.method === "POST") {
    const existing = await currentSession(request, env, false);
    if (existing) return jsonResponse({ session: existing }, env);
    const lifetime = Number(env.SESSION_TTL_SECONDS);
    if (!Number.isSafeInteger(lifetime) || lifetime < 60 || lifetime > 604800) throw new ApiError("CONFIG_REQUIRED", 503);
    const token = newToken(), now = Date.now(), id = crypto.randomUUID(), playerId = crypto.randomUUID();
    const expiresAt = now + lifetime * 1000;
    await env.DB.prepare("INSERT INTO sessions (token_hash, session_id, player_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(await sha256(token), id, playerId, now, expiresAt).run();
    const response = jsonResponse({ session: { id, playerId, expiresAt } }, env, 201);
    response.headers.set("Set-Cookie", `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${lifetime}`);
    return response;
  }
  if (path === "/api/session/revoke" && request.method === "POST") {
    const token = cookieToken(request);
    if (token) await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").bind(Date.now(), await sha256(token)).run();
    const response = jsonResponse({ revoked: true }, env);
    response.headers.set("Set-Cookie", `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`);
    return response;
  }
  throw new ApiError("METHOD_NOT_ALLOWED", 405);
}
