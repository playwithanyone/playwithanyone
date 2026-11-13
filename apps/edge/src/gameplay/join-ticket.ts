/** Offline room admission. These credentials never enter URLs, iframe state or logs.
 * Signature verification does not replace the host's persistent jti/seat-epoch
 * fencing, session expiry checks, or control-plane revocation notifications. */
export const EXECUTION_CLASSES = ["hibernated-turn", "p2p-signaling", "realtime-tick"] as const;
export type ExecutionClass = typeof EXECUTION_CLASSES[number];
export type TicketSeat = "red" | "yellow";
export interface JoinTicketIdentity {
  readonly roomId: string;
  readonly matchId: string;
  readonly gameId: string;
  readonly playerId: string;
  readonly sessionId: string;
  readonly seat: TicketSeat;
  readonly releaseHash: string;
  readonly executionClass: ExecutionClass;
  /** The seat's current epoch, before successful authentication rotates it. */
  readonly seatEpoch: number;
  readonly authorizationVersion: number;
  /** Exact configured WebSocket origin, e.g. wss://playwithanyone.com. */
  readonly aud: string;
}
export interface JoinTicketClaims extends JoinTicketIdentity {
  readonly v: 1;
  /** Integer Unix seconds; expiry limits admission, not the whole connection. */
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}
export interface JoinTicketKeys {
  readonly activeKid: string;
  readonly keys: Readonly<Record<string, string>>;
}
export interface IssueJoinTicketOptions {
  readonly nowMs?: number;
  readonly ttlSeconds?: number;
  readonly jti?: string;
}
export interface VerifyJoinTicketExpected {
  readonly aud: string;
  readonly roomId: string;
  readonly releaseHash: string;
  readonly executionClass: ExecutionClass;
  readonly gameId?: string;
  readonly matchId?: string;
  readonly nowMs?: number;
}
export type JoinTicketErrorCode = "ROOM_TICKET_KEYS_REQUIRED" | "ROOM_TICKET_KEYS_INVALID" | "ROOM_TICKET_INVALID" | "ROOM_TICKET_EXPIRED" | "ROOM_TICKET_SCOPE" | "ROOM_ROUTING_REQUIRED" | "ROOM_ROUTING_INVALID" | "ROOM_ROUTE_UNAVAILABLE";
export class JoinTicketError extends Error {
  constructor(readonly code: JoinTicketErrorCode) { super(code); this.name = "JoinTicketError"; }
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_TICKET_BYTES = 2048;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GAME_ID = /^[a-z][a-z0-9-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const KID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const identityFields = ["roomId", "matchId", "gameId", "playerId", "sessionId", "seat", "releaseHash", "executionClass", "seatEpoch", "authorizationVersion", "aud"] as const;
const claimFields = [...identityFields, "v", "iat", "exp", "jti"] as const;
function fail(code: JoinTicketErrorCode = "ROOM_TICKET_INVALID"): never { throw new JoinTicketError(code); }
function record(value: unknown, code: JoinTicketErrorCode): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value as Record<string, unknown>;
}
function closed(value: Record<string, unknown>, fields: readonly string[], code: JoinTicketErrorCode): void {
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) fail(code);
}
function integer(value: unknown, minimum = 1): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum; }
function id(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function executionClass(value: unknown): value is ExecutionClass { return typeof value === "string" && (EXECUTION_CLASSES as readonly string[]).includes(value); }
function websocketOrigin(value: unknown, fixture = false): value is string {
  if (typeof value !== "string" || value.length > 256) return false;
  try {
    const parsed = new URL(value);
    return parsed.origin === value && !parsed.username && !parsed.password &&
      (parsed.protocol === "wss:" || (fixture && parsed.protocol === "ws:" && ["127.0.0.1", "localhost"].includes(parsed.hostname)));
  } catch { return false; }
}
function clockSeconds(nowMs: number): number { if (!integer(nowMs)) fail(); return Math.floor(nowMs / 1000); }
function identity(value: unknown): JoinTicketIdentity {
  const input = record(value, "ROOM_TICKET_INVALID");
  for (const key of ["roomId", "matchId", "playerId", "sessionId"] as const) if (!id(input[key])) fail();
  if (typeof input["gameId"] !== "string" || !GAME_ID.test(input["gameId"]) || !["red", "yellow"].includes(String(input["seat"])) ||
      typeof input["releaseHash"] !== "string" || !HASH.test(input["releaseHash"]) || !executionClass(input["executionClass"]) ||
      !integer(input["seatEpoch"]) || !integer(input["authorizationVersion"]) || !websocketOrigin(input["aud"], true)) fail();
  return input as unknown as JoinTicketIdentity;
}
function validateClaims(value: unknown): JoinTicketClaims {
  const input = record(value, "ROOM_TICKET_INVALID"); closed(input, claimFields, "ROOM_TICKET_INVALID"); identity(input);
  if (input["v"] !== 1 || !integer(input["iat"]) || !integer(input["exp"]) || !id(input["jti"]) || input["exp"] - input["iat"] < 60 || input["exp"] - input["iat"] > 120) fail();
  return input as unknown as JoinTicketClaims;
}
function encode(bytes: Uint8Array): string {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(value: string, maximumBytes: number): Uint8Array<ArrayBuffer> {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(maximumBytes * 4 / 3) || value.length % 4 === 1) fail();
  let binary: string;
  try { binary = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4)); } catch { return fail(); }
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  if (bytes.byteLength > maximumBytes || encode(bytes) !== value) fail();
  return bytes;
}
function json(bytes: Uint8Array): unknown { try { return JSON.parse(DECODER.decode(bytes)); } catch { return fail(); } }

/** Keys are independent room-signing secrets, not stop/recovery credentials. */
export function parseJoinTicketKeys(binding: string | unknown): JoinTicketKeys {
  if (binding === undefined || binding === null || binding === "") fail("ROOM_TICKET_KEYS_REQUIRED");
  let input: Record<string, unknown>;
  try { input = record(typeof binding === "string" ? JSON.parse(binding) : binding, "ROOM_TICKET_KEYS_INVALID"); } catch { return fail("ROOM_TICKET_KEYS_INVALID"); }
  closed(input, ["activeKid", "keys"], "ROOM_TICKET_KEYS_INVALID");
  if (typeof input["activeKid"] !== "string" || !KID.test(input["activeKid"])) fail("ROOM_TICKET_KEYS_INVALID");
  const keys = record(input["keys"], "ROOM_TICKET_KEYS_INVALID"), entries = Object.entries(keys);
  if (entries.length < 1 || entries.length > 3 || !Object.hasOwn(keys, input["activeKid"]) ||
      entries.some(([kid, secret]) => !KID.test(kid) || typeof secret !== "string" || !/^[\x21-\x7e]{32,256}$/.test(secret))) fail("ROOM_TICKET_KEYS_INVALID");
  return Object.freeze({ activeKid: input["activeKid"], keys: Object.freeze(Object.fromEntries(entries) as Record<string, string>) });
}
async function keyFor(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", ENCODER.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function issueJoinTicket(value: JoinTicketIdentity, binding: JoinTicketKeys, options: IssueJoinTicketOptions = {}): Promise<string> {
  const keys = parseJoinTicketKeys(binding), input = record(value, "ROOM_TICKET_INVALID"); closed(input, identityFields, "ROOM_TICKET_INVALID"); identity(input);
  const iat = clockSeconds(options.nowMs ?? Date.now()), ttl = options.ttlSeconds ?? 90;
  if (!integer(ttl) || ttl < 60 || ttl > 120 || (options.jti !== undefined && !id(options.jti))) fail();
  const claims: JoinTicketClaims = { ...value, v: 1, iat, exp: iat + ttl, jti: options.jti ?? crypto.randomUUID() };
  validateClaims(claims);
  const header = encode(ENCODER.encode(JSON.stringify({ v: 1, alg: "HS256", typ: "PWA-JOIN", kid: keys.activeKid })));
  const payload = encode(ENCODER.encode(JSON.stringify(claims))), signingInput = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await keyFor(keys.keys[keys.activeKid]!), ENCODER.encode(signingInput)));
  const ticket = `${signingInput}.${encode(signature)}`; if (ticket.length > MAX_TICKET_BYTES) fail(); return ticket;
}

/** Pure signature/scope verification; the host consumes jti in its room transaction. */
export async function verifyJoinTicket(ticket: string, binding: JoinTicketKeys, expected: VerifyJoinTicketExpected): Promise<JoinTicketClaims> {
  const keys = parseJoinTicketKeys(binding);
  if (typeof ticket !== "string" || ticket.length < 32 || ticket.length > MAX_TICKET_BYTES || !websocketOrigin(expected.aud, true) ||
      !id(expected.roomId) || !HASH.test(expected.releaseHash) || !executionClass(expected.executionClass) ||
      (expected.gameId !== undefined && !GAME_ID.test(expected.gameId)) || (expected.matchId !== undefined && !id(expected.matchId))) fail();
  const parts = ticket.split("."); if (parts.length !== 3) fail();
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = record(json(decode(headerPart, 256)), "ROOM_TICKET_INVALID"); closed(header, ["v", "alg", "typ", "kid"], "ROOM_TICKET_INVALID");
  if (header["v"] !== 1 || header["alg"] !== "HS256" || header["typ"] !== "PWA-JOIN" || typeof header["kid"] !== "string" || !KID.test(header["kid"]) || !Object.hasOwn(keys.keys, header["kid"])) fail();
  const signature = decode(signaturePart, 32); if (signature.byteLength !== 32) fail();
  if (!await crypto.subtle.verify("HMAC", await keyFor(keys.keys[header["kid"]]!), signature, ENCODER.encode(`${headerPart}.${payloadPart}`))) fail();
  const claims = validateClaims(json(decode(payloadPart, 1400))), now = clockSeconds(expected.nowMs ?? Date.now());
  if (claims.iat > now) fail(); if (claims.exp <= now) fail("ROOM_TICKET_EXPIRED");
  if (claims.aud !== expected.aud || claims.roomId !== expected.roomId || claims.releaseHash !== expected.releaseHash ||
      claims.executionClass !== expected.executionClass || (expected.gameId !== undefined && claims.gameId !== expected.gameId) ||
      (expected.matchId !== undefined && claims.matchId !== expected.matchId)) fail("ROOM_TICKET_SCOPE");
  return Object.freeze({ ...claims });
}

export interface RoomSyncPolicy { readonly profileId: string; readonly profileVersion: number; readonly protocolVersions: readonly number[] }
export interface RoomRoute {
  readonly roomId: string;
  readonly wsUrl: string;
  readonly audience: string;
  readonly executionClass: ExecutionClass;
  readonly syncPolicy: RoomSyncPolicy;
  readonly poolId: string;
  /** Explicit migration alias: preserves already-consumed counters in the existing DO. */
  readonly physicalOwner: string;
  readonly mode: string;
  readonly regionHint: string;
}
interface RegisteredRoute {
  readonly gameId: string;
  readonly releaseHash: string;
  readonly executionClass: ExecutionClass;
  readonly mode: string;
  readonly regionHint: string;
  readonly wsOrigin: string;
  readonly wsPathTemplate: string;
  readonly syncPolicy: RoomSyncPolicy;
  readonly legacyPhysicalOwner?: string;
}
export interface RoomRouting {
  readonly schemaVersion: 1;
  readonly environment: "fixture" | "preview" | "production";
  readonly allowedWebSocketOrigins: readonly string[];
  readonly defaultRegionHint: string;
  readonly regionHints: readonly string[];
  readonly executionClasses: Readonly<Record<ExecutionClass, { readonly enabled: boolean; readonly host: "durable-object" | "vps" }>>;
  readonly games: readonly RegisteredRoute[];
}
export function parseRoomRouting(binding: unknown, environment: RoomRouting["environment"]): RoomRouting {
  if (binding === undefined || binding === null || binding === "") fail("ROOM_ROUTING_REQUIRED");
  let input: Record<string, unknown>;
  try { input = record(typeof binding === "string" ? JSON.parse(binding) : binding, "ROOM_ROUTING_INVALID"); } catch { return fail("ROOM_ROUTING_INVALID"); }
  closed(input, ["schemaVersion", "environment", "allowedWebSocketOrigins", "defaultRegionHint", "regionHints", "executionClasses", "games"], "ROOM_ROUTING_INVALID");
  const origins = input["allowedWebSocketOrigins"], regions = input["regionHints"], classes = record(input["executionClasses"], "ROOM_ROUTING_INVALID"), games = input["games"];
  closed(classes, EXECUTION_CLASSES, "ROOM_ROUTING_INVALID");
  if (input["schemaVersion"] !== 1 || input["environment"] !== environment || !["fixture", "preview", "production"].includes(environment) ||
      !Array.isArray(origins) || origins.length < 1 || origins.length > 8 || origins.some(origin => !websocketOrigin(origin, environment === "fixture")) || new Set(origins).size !== origins.length ||
      !Array.isArray(regions) || regions.length < 1 || regions.length > 8 || regions.some(region => typeof region !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(region)) || new Set(regions).size !== regions.length ||
      typeof input["defaultRegionHint"] !== "string" || !regions.includes(input["defaultRegionHint"]) || !Array.isArray(games) || games.length < 1 || games.length > 64) fail("ROOM_ROUTING_INVALID");
  for (const name of EXECUTION_CLASSES) {
    const host = record(classes[name], "ROOM_ROUTING_INVALID"); closed(host, ["enabled", "host"], "ROOM_ROUTING_INVALID");
    if (typeof host["enabled"] !== "boolean" || !["durable-object", "vps"].includes(String(host["host"]))) fail("ROOM_ROUTING_INVALID");
  }
  const identities = new Set<string>();
  for (const item of games) {
    const route = record(item, "ROOM_ROUTING_INVALID");
    closed(route, ["gameId", "releaseHash", "executionClass", "mode", "regionHint", "wsOrigin", "wsPathTemplate", "syncPolicy", ...(Object.hasOwn(route, "legacyPhysicalOwner") ? ["legacyPhysicalOwner"] : [])], "ROOM_ROUTING_INVALID");
    if (Object.hasOwn(route, "legacyPhysicalOwner") && !id(route["legacyPhysicalOwner"])) fail("ROOM_ROUTING_INVALID");
    const policy = record(route["syncPolicy"], "ROOM_ROUTING_INVALID"); closed(policy, ["profileId", "profileVersion", "protocolVersions"], "ROOM_ROUTING_INVALID");
    if (typeof route["gameId"] !== "string" || !GAME_ID.test(route["gameId"]) || typeof route["releaseHash"] !== "string" || !HASH.test(route["releaseHash"]) ||
        !executionClass(route["executionClass"]) || typeof route["mode"] !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(route["mode"]) || !regions.includes(route["regionHint"]) || !origins.includes(route["wsOrigin"]) ||
        typeof route["wsPathTemplate"] !== "string" || !/^\/[A-Za-z0-9/_-]*\{roomId\}[A-Za-z0-9/_-]*$/.test(route["wsPathTemplate"]) ||
        !id(policy["profileId"]) || !integer(policy["profileVersion"]) || !Array.isArray(policy["protocolVersions"]) || policy["protocolVersions"].length < 1 || policy["protocolVersions"].length > 8 ||
        policy["protocolVersions"].some(version => !integer(version) || version > 255) || new Set(policy["protocolVersions"]).size !== policy["protocolVersions"].length) fail("ROOM_ROUTING_INVALID");
    const key = `${route["gameId"]}:${route["releaseHash"]}:${route["mode"]}:${route["regionHint"]}`;
    if (identities.has(key)) fail("ROOM_ROUTING_INVALID"); identities.add(key);
  }
  // Copy before freezing: callers cannot later mutate an already validated route.
  return deepFreeze(JSON.parse(JSON.stringify(input)) as RoomRouting);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}
/** Only registered game/mode/region combinations may select a namespace name. */
export function selectRoomRoute(routing: RoomRouting, input: { readonly gameId: string; readonly releaseHash: string; readonly roomId: string; readonly mode?: string; readonly regionHint?: string }): RoomRoute {
  if (!id(input.roomId) || !GAME_ID.test(input.gameId) || !HASH.test(input.releaseHash)) fail("ROOM_ROUTE_UNAVAILABLE");
  const mode = input.mode ?? "casual", region = input.regionHint ?? routing.defaultRegionHint;
  const registered = routing.games.find(route => route.gameId === input.gameId && route.releaseHash === input.releaseHash && route.mode === mode && route.regionHint === region);
  if (!registered || !routing.executionClasses[registered.executionClass].enabled) fail("ROOM_ROUTE_UNAVAILABLE");
  const wsUrl = `${registered.wsOrigin}${registered.wsPathTemplate.replace("{roomId}", encodeURIComponent(input.roomId))}`;
  return Object.freeze({ roomId: input.roomId, wsUrl, audience: registered.wsOrigin, executionClass: registered.executionClass, syncPolicy: registered.syncPolicy,
    poolId: `${registered.gameId}:${registered.mode}:${registered.regionHint}`,
    physicalOwner: registered.legacyPhysicalOwner ?? `${registered.gameId}:${registered.mode}:${registered.regionHint}`,
    mode: registered.mode, regionHint: registered.regionHint });
}
