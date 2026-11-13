/** Reserved external-runtime boundary. This module never writes scores by itself.
 * A future host must atomically verify assignment ownership, claim a nonce and
 * persist a match-id/digest-idempotent result before this route can be enabled. */
import { ApiError, jsonResponse } from "../security.js";
import type { Env } from "../env.js";
import type { ExecutionClass } from "./join-ticket.js";

const ENDPOINT = "/internal/room-finalize";
const MAX_BODY_BYTES = 32768;
const MAX_AGE_MS = 60000;
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, HASH = /^[a-f0-9]{64}$/, NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const CLASSES: readonly ExecutionClass[] = ["hibernated-turn", "p2p-signaling", "realtime-tick"];
export interface FinalizeKey {
  readonly kid: string; readonly secret: string; readonly runtimeId: string;
  readonly executionClasses: readonly ExecutionClass[]; readonly releaseHashes: readonly string[];
}
export interface FinalizeKeys { readonly keys: readonly FinalizeKey[] }
export interface RoomFinalizationSummary {
  readonly schemaVersion: 1; readonly runtimeId: string; readonly roomId: string; readonly matchId: string; readonly assignmentId: string;
  readonly gameId: string; readonly releaseHash: string; readonly executionClass: ExecutionClass;
  readonly result: "WIN" | "DRAW" | "DISCONNECTED" | "SERVICE_INTERRUPTED"; readonly winner: "red" | "yellow" | null;
  readonly reason: string; readonly endedAt: number;
  readonly resourceUsage: { readonly lifetimeMs: number; readonly uplinkPackets: number; readonly uplinkBytes: number };
}
export interface VerifiedFinalization {
  readonly summary: RoomFinalizationSummary; readonly runtimeId: string; readonly kid: string;
  readonly nonce: string; readonly timestampMs: number; readonly bodySha256: string; readonly expiresAt: number;
}
export interface FinalizeReplayClaim { claim(request: Pick<VerifiedFinalization, "runtimeId" | "nonce" | "bodySha256" | "expiresAt">): Promise<boolean> }
export interface FinalizeResultHandler {
  /** Must independently verify persisted assignment/runtime/build authority and
   * match-id/digest idempotence. A valid HMAC is not proof that a reported win is true. */
  finalize(verified: VerifiedFinalization): Promise<{ accepted: true; matchId: string }>;
}
export interface FinalizeHostPorts { readonly replay: FinalizeReplayClaim; readonly handler: FinalizeResultHandler }
type FinalizeEnv = Env & { readonly ROOM_FINALIZE_ENABLED?: string; readonly ROOM_FINALIZE_KEYS_JSON?: string };
function fail(code = "FINALIZE_AUTH_REQUIRED", status = 401): never { throw new ApiError(code, status, "room-finalize"); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) fail("FINALIZE_INVALID", 400); return value as Record<string, unknown>; }
function closed(value: Record<string, unknown>, fields: readonly string[]): void { if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) fail("FINALIZE_INVALID", 400); }
function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export function parseFinalizeKeys(binding: unknown): FinalizeKeys {
  let value: Record<string, unknown>;
  try { value = object(typeof binding === "string" ? JSON.parse(binding) : binding); } catch { return fail("FINALIZE_KEYS_REQUIRED", 503); }
  closed(value, ["keys"]); const candidates = value["keys"];
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 8) fail("FINALIZE_KEYS_INVALID", 503);
  const keys: FinalizeKey[] = [], identifiers = new Set<string>(), secrets = new Set<string>();
  for (const candidate of candidates) {
    const key = object(candidate); closed(key, ["kid", "secret", "runtimeId", "executionClasses", "releaseHashes"]);
    if (typeof key["kid"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(key["kid"]) || identifiers.has(key["kid"]) ||
        typeof key["secret"] !== "string" || !/^[\x21-\x7e]{32,256}$/.test(key["secret"]) || secrets.has(key["secret"]) ||
        typeof key["runtimeId"] !== "string" || !ID.test(key["runtimeId"]) || !Array.isArray(key["executionClasses"]) || key["executionClasses"].length < 1 || key["executionClasses"].length > 3 ||
        key["executionClasses"].some(item => !CLASSES.includes(item as ExecutionClass)) || new Set(key["executionClasses"]).size !== key["executionClasses"].length ||
        !Array.isArray(key["releaseHashes"]) || key["releaseHashes"].length < 1 || key["releaseHashes"].length > 16 || key["releaseHashes"].some(item => typeof item !== "string" || !HASH.test(item)) || new Set(key["releaseHashes"]).size !== key["releaseHashes"].length) fail("FINALIZE_KEYS_INVALID", 503);
    identifiers.add(key["kid"]); secrets.add(key["secret"]);
    keys.push(Object.freeze({ kid: key["kid"], secret: key["secret"], runtimeId: key["runtimeId"], executionClasses: Object.freeze([...key["executionClasses"]]) as readonly ExecutionClass[], releaseHashes: Object.freeze([...key["releaseHashes"]]) as readonly string[] }));
  }
  return Object.freeze({ keys: Object.freeze(keys) });
}
function summary(value: unknown): RoomFinalizationSummary {
  const input = object(value); closed(input, ["schemaVersion", "runtimeId", "roomId", "matchId", "assignmentId", "gameId", "releaseHash", "executionClass", "result", "winner", "reason", "endedAt", "resourceUsage"]);
  if (input["schemaVersion"] !== 1 || ["runtimeId", "roomId", "matchId", "assignmentId"].some(key => typeof input[key] !== "string" || !ID.test(input[key])) ||
      typeof input["gameId"] !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(input["gameId"]) || typeof input["releaseHash"] !== "string" || !HASH.test(input["releaseHash"]) ||
      !CLASSES.includes(input["executionClass"] as ExecutionClass) || !["WIN", "DRAW", "DISCONNECTED", "SERVICE_INTERRUPTED"].includes(String(input["result"])) ||
      !["red", "yellow", null].includes(input["winner"] as string | null) || (input["result"] === "WIN") !== (input["winner"] !== null) ||
      typeof input["reason"] !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(input["reason"]) || !nonnegative(input["endedAt"])) fail("FINALIZE_INVALID", 400);
  const usage = object(input["resourceUsage"]); closed(usage, ["lifetimeMs", "uplinkPackets", "uplinkBytes"]);
  if (Object.values(usage).some(value => !nonnegative(value))) fail("FINALIZE_INVALID", 400);
  return Object.freeze({ ...input, resourceUsage: Object.freeze({ ...usage }) }) as unknown as RoomFinalizationSummary;
}
async function bodyBytes(request: Request): Promise<Uint8Array> {
  if (!request.body) fail("FINALIZE_INVALID", 400);
  const claimed = request.headers.get("Content-Length"); if (claimed !== null && (!/^\d+$/.test(claimed) || Number(claimed) > MAX_BODY_BYTES)) fail("FINALIZE_BODY_LIMIT", 413);
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.byteLength; if (length > MAX_BODY_BYTES) fail("FINALIZE_BODY_LIMIT", 413); chunks.push(item.value); } }
  finally { await reader.cancel().catch(() => {}); }
  const body = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; } return body;
}
async function bodyHash(bytes: Uint8Array): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)), value => value.toString(16).padStart(2, "0")).join(""); }
function signingInput(runtimeId: string, kid: string, timestamp: string, nonce: string, hash: string): ArrayBuffer { return Uint8Array.from(encoder.encode(["POST", ENDPOINT, runtimeId, kid, timestamp, nonce, hash].join("\n"))).buffer; }
async function hmacKey(secret: string): Promise<CryptoKey> { return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); }
/** Pure verifier: no database, Durable Object, replay store or handler access. */
export async function authenticateRoomFinalization(request: Request, keys: FinalizeKeys, now = Date.now()): Promise<VerifiedFinalization> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== ENDPOINT || url.search || request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json") fail("FINALIZE_INVALID", 400);
  const runtimeId = request.headers.get("X-PWA-Runtime-Id"), kid = request.headers.get("X-PWA-Key-Id"), timestamp = request.headers.get("X-PWA-Timestamp"), nonce = request.headers.get("X-PWA-Nonce"), signature = request.headers.get("X-PWA-Signature");
  if (!runtimeId || !kid || !timestamp || !/^\d{1,16}$/.test(timestamp) || !nonce || !NONCE.test(nonce) || !signature || !HASH.test(signature)) fail();
  const issued = Number(timestamp); if (!Number.isSafeInteger(now) || !Number.isSafeInteger(issued) || issued > now || now - issued > MAX_AGE_MS) fail("FINALIZE_EXPIRED");
  const key = keys.keys.find(key => key.kid === kid && key.runtimeId === runtimeId); if (!key) fail();
  const bytes = await bodyBytes(request), sha = await bodyHash(bytes), signatureBytes = Uint8Array.from(signature.match(/../g)!, value => Number.parseInt(value, 16));
  if (!await crypto.subtle.verify("HMAC", await hmacKey(key.secret), signatureBytes, signingInput(runtimeId, kid, timestamp, nonce, sha))) fail();
  let input: unknown; try { input = JSON.parse(decoder.decode(bytes)); } catch { return fail("FINALIZE_INVALID", 400); }
  const report = summary(input);
  if (report.runtimeId !== runtimeId || !key.executionClasses.includes(report.executionClass) || !key.releaseHashes.includes(report.releaseHash) || report.endedAt > now) fail("FINALIZE_SCOPE");
  return Object.freeze({ summary: report, runtimeId, kid, nonce, timestampMs: issued, bodySha256: sha, expiresAt: issued + MAX_AGE_MS });
}
/** Utility for a future trusted adapter; callers keep keys in server memory. */
export async function signRoomFinalizationHeaders(bytes: Uint8Array, key: FinalizeKey, timestampMs: number, nonce: string): Promise<Record<string, string>> {
  if (!Number.isSafeInteger(timestampMs) || !NONCE.test(nonce) || bytes.byteLength > MAX_BODY_BYTES) fail("FINALIZE_INVALID", 400);
  const timestamp = String(timestampMs), signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(key.secret), signingInput(key.runtimeId, key.kid, timestamp, nonce, await bodyHash(bytes))));
  return { "Content-Type": "application/json", "X-PWA-Runtime-Id": key.runtimeId, "X-PWA-Key-Id": key.kid, "X-PWA-Timestamp": timestamp,
    "X-PWA-Nonce": nonce, "X-PWA-Signature": Array.from(signature, value => value.toString(16).padStart(2, "0")).join("") };
}
/** Not wired to a live external execution class. Missing host ports remain unavailable even if an env flag is changed. */
export async function roomFinalizationRoute(request: Request, env: FinalizeEnv, ports?: FinalizeHostPorts, now = Date.now()): Promise<Response | undefined> {
  const url = new URL(request.url); if (url.pathname !== ENDPOINT) return undefined;
  if (url.origin !== env.SHELL_ORIGIN || env.WORKER_ROLE !== "shell" || !env.ROOM_FINALIZE_KEYS_JSON) throw new ApiError("NOT_FOUND", 404, "room-finalize");
  const verified = await authenticateRoomFinalization(request, parseFinalizeKeys(env.ROOM_FINALIZE_KEYS_JSON), now);
  if (env.ROOM_FINALIZE_ENABLED !== "true" || !ports) throw new ApiError("CAPABILITY_UNAVAILABLE", 503, "room-finalize");
  if (!await ports.replay.claim(verified)) throw new ApiError("FINALIZE_REPLAY", 409, "room-finalize");
  const result = await ports.handler.finalize(verified);
  if (result.accepted !== true || result.matchId !== verified.summary.matchId) throw new ApiError("FINALIZE_NOT_CONFIRMED", 503, "room-finalize");
  return jsonResponse(result, env);
}
