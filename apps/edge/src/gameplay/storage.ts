import { ApiError } from "../security.js";
import type { DoNamespace, DoStorage, Principal } from "./types.js";

export function row<T>(storage: DoStorage, sql: string, ...bindings: (string | number | null)[]): T | undefined {
  return storage.sql.exec<T>(sql, ...bindings).toArray()[0];
}
export function internal(namespace: DoNamespace | undefined, name: string, value: unknown): Promise<Response> {
  if (!namespace) throw new ApiError("CAPABILITY_UNAVAILABLE", 503, "gameplay");
  return namespace.get(namespace.idFromName(name)).fetch(new Request("https://platform.internal/", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
  }));
}
export async function internalJson<T>(namespace: DoNamespace | undefined, name: string, value: unknown): Promise<T> {
  const response = await internal(namespace, name, value);
  const body = await response.json() as { error?: { code?: string } };
  if (!response.ok) throw new ApiError(body.error?.code ?? "CONTROL_UNAVAILABLE", response.status, "gameplay");
  return body as T;
}
export function reply(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}
export function failure(error: unknown): Response {
  const candidate = error as { code?: unknown; status?: unknown; retryable?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : "INTERNAL_ERROR";
  const status = typeof candidate?.status === "number" ? candidate.status : code.startsWith("SAFETY_") || code === "POLICY_REQUIRED" ? 503 : 400;
  return reply({ error: { code, scope: "gameplay", retryable: candidate?.retryable === true } }, status);
}
export function checkId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new ApiError("INVALID_REQUEST", 400, "gameplay");
}
export function checkUuid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw new ApiError("INVALID_REQUEST", 400, "gameplay");
}
export function checkPrincipal(value: unknown): asserts value is Principal {
  if (!value || typeof value !== "object") throw new ApiError("AUTH_REQUIRED", 401);
  const principal = value as Principal;
  checkId(principal.id); checkId(principal.playerId);
  if (!Number.isSafeInteger(principal.expiresAt) || principal.expiresAt <= Date.now()) throw new ApiError("AUTH_EXPIRED", 401);
}
export function closed(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new ApiError("INVALID_REQUEST", 400, "gameplay");
}
export function randomHex(bytes = 32): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
}
export async function hash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function token(key: string, value: string): Promise<string> {
  const bytes = new Uint8Array(key.match(/../g)!.map(pair => Number.parseInt(pair, 16)));
  const cryptoKey = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
