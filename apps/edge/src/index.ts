import type { BrowserReleaseManifest } from "../../../packages/release/src/release.js";
import type { Env, PublicResourceCache, WorkerExecutionContext } from "./env.js";
import { ApiError, deployment, enforceOrigin, exactOrigin, jsonResponse, readObject, responseHeaders } from "./security.js";
import { currentSession, sessionRoute, sessionRevocationTarget } from "./session.js";
import { gameplayRoute, gameplaySocketRoute, revokeGameplaySession } from "./gameplay/index.js";
import { safetyManagementRoute } from "./safety/management.js";
import { withDataSafety } from "./data-safety.js";
import { rawD1Database } from "./safety/d1.js";
import { roomFinalizationRoute } from "./gameplay/finalize.js";
import { SafetyError } from "./safety/config.js";
import { PolicyError } from "../../../packages/protocol/src/policy.js";
export { MatchPoolDO, RoomDO } from "./gameplay/index.js";

interface ReleaseRow { game_id: string; game_build_id: string; frame_origin: string; browser_manifest: string }
const FIXTURE_GAME_ID = "fixture-loader";
function releaseIntegrity(): never { throw new ApiError("RELEASE_INTEGRITY", 503, "release"); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
}
function unsigned(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
function buildHostLabel(digest: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let accumulator = 0, bits = 0, label = "b-";
  for (let offset = 0; offset < digest.length; offset += 2) {
    accumulator = (accumulator << 8) | Number.parseInt(digest.slice(offset, offset + 2), 16); bits += 8;
    while (bits >= 5) { bits -= 5; label += alphabet[(accumulator >>> bits) & 31]; }
    accumulator &= (1 << bits) - 1;
  }
  if (bits) label += alphabet[(accumulator << (5 - bits)) & 31];
  return label;
}
function publicArtifactPath(value: unknown, scope: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || value !== value.normalize("NFC") || /[\\%?#:\x00-\x20\x7f]/.test(value)) return false;
  const parts = value.split("/");
  return typeof scope === "string" && ["client", "public-simulation", "assets"].includes(scope) && parts[0] === scope && parts.length >= 2 && parts.every(part => part !== "" && part !== "." && part !== ".." && !part.endsWith(".") && !part.endsWith(" "));
}
function registeredManifest(row: ReleaseRow, env: Env): BrowserReleaseManifest {
  if (row.browser_manifest.length > 1_048_576) releaseIntegrity();
  let value: unknown;
  try { value = JSON.parse(row.browser_manifest); } catch { return releaseIntegrity(); }
  if (!closed(value, ["gameId", "gameBuildId", "buildHostLabel", "frameOrigin", "entryUrl", "sdk", "protocol", "profile", "browserCapabilities", "budgets", "recovery", "assets", "requiredAssets"]) || !/^[a-z][a-z0-9-]{0,63}$/.test(row.game_id) || value["gameBuildId"] !== row.game_build_id || value["gameId"] !== row.game_id || value["frameOrigin"] !== row.frame_origin) releaseIntegrity();
  const origins = deployment(env);
  if (!origins.games.includes(row.frame_origin)) releaseIntegrity();
  try { exactOrigin(row.frame_origin, env.APP_ENV === "fixture"); } catch { return releaseIntegrity(); }
  const label = buildHostLabel(row.game_build_id), frame = new URL(row.frame_origin);
  const loopbackFixture = env.APP_ENV === "fixture" && ["127.0.0.1", "localhost"].includes(frame.hostname);
  if (value["buildHostLabel"] !== label || (!loopbackFixture && frame.hostname.split(".")[0] !== label)) releaseIntegrity();
  const protocol = value["protocol"], sdk = value["sdk"];
  if (!closed(protocol, ["min", "max"]) || protocol["min"] !== 1 || protocol["max"] !== 1 || !closed(sdk, ["min", "max"]) || sdk["min"] !== 1 || !unsigned(sdk["max"], 65535) || sdk["max"] < 1) releaseIntegrity();
  const profile = value["profile"], capabilities = value["browserCapabilities"], budgets = value["budgets"], recovery = value["recovery"];
  if (!closed(profile, ["id", "version"]) || typeof profile["id"] !== "string" || !["server-turn", "server-snapshot", "deterministic-lockstep", "duel-rollback", "peer-host-snapshot"].includes(profile["id"]) || !unsigned(profile["version"], 65535) || profile["version"] < 1) releaseIntegrity();
  if (!Array.isArray(capabilities) || capabilities.length > 6 || capabilities.some(cap => !["wasm", "threads", "audio", "fullscreen", "gamepad", "pointer-lock"].includes(cap)) || new Set(capabilities).size !== capabilities.length || (capabilities.includes("threads") && !capabilities.includes("wasm"))) releaseIntegrity();
  const budgetFields = ["peakInputRateHz", "stateRateHz", "maxFrameBytes", "historyBytes", "rollbackWindowTicks", "maxStepCpuMs", "maxMemoryBytes", "maxQueuedBytes", "maxBulkBytes", "maxConcurrentBulk"];
  if (!closed(budgets, budgetFields) || budgetFields.some(key => key !== "maxStepCpuMs" && !unsigned(budgets[key])) || typeof budgets["maxStepCpuMs"] !== "number" || !Number.isFinite(budgets["maxStepCpuMs"]) || budgets["maxStepCpuMs"] <= 0 || (budgets["maxFrameBytes"] as number) < 32 || (budgets["maxFrameBytes"] as number) > 16384 || (budgets["maxMemoryBytes"] as number) < 1 || (budgets["maxQueuedBytes"] as number) < 1) releaseIntegrity();
  if (!closed(recovery, ["checkpoints", "commandLog", "inputHistory", "spectating", "midMatchJoin"]) || Object.values(recovery).some(flag => typeof flag !== "boolean")) releaseIntegrity();
  const assets = value["assets"];
  if (!Array.isArray(assets) || assets.length === 0 || assets.length > 4096) releaseIntegrity();
  const paths = new Set<string>(), urls = new Set<string>();
  let clientEntryFound = false;
  for (const asset of assets) {
    if (!closed(asset, ["path", "scope", "sha256", "bytes", "mime", "url"]) || !publicArtifactPath(asset["path"], asset["scope"]) || typeof asset["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(asset["sha256"]) || !unsigned(asset["bytes"]) || typeof asset["mime"] !== "string" || asset["mime"].length === 0 || asset["mime"].length > 256 || /[\r\n]/.test(asset["mime"]) || typeof asset["url"] !== "string") releaseIntegrity();
    let url: URL;
    try { url = new URL(asset["url"]); } catch { return releaseIntegrity(); }
    if (url.search || url.hash || url.username || url.password) releaseIntegrity();
    const scope = asset["scope"], pathname = asset["path"];
    if (scope === "assets") {
      // Active documents/scripts belong to one build origin, not this shared read-only origin.
      const mime = asset["mime"].split(";")[0]!.trim().toLowerCase();
      if (["text/html", "application/xhtml+xml", "text/javascript", "application/javascript", "text/css"].includes(mime) || !origins.assets.includes(url.origin) || url.pathname !== new URL(`/${row.game_id}/${row.game_build_id}/${pathname}`, url.origin).pathname) releaseIntegrity();
    } else if (url.origin !== row.frame_origin || url.pathname !== new URL(`/${pathname}`, row.frame_origin).pathname) releaseIntegrity();
    if (paths.has(pathname) || urls.has(url.href)) releaseIntegrity();
    paths.add(pathname); urls.add(url.href);
    if (scope === "client" && /\.html$/.test(pathname) && asset["url"] === value["entryUrl"]) clientEntryFound = true;
  }
  const required = value["requiredAssets"];
  if (!clientEntryFound || !Array.isArray(required) || required.some(asset => typeof asset !== "string" || !paths.has(asset)) || new Set(required).size !== required.length) releaseIntegrity();
  return value as unknown as BrowserReleaseManifest;
}
// A validated release manifest is content-addressed and immutable. Bounded isolate
// memoization avoids a database lookup before every already-cached public asset.
const manifestMemos = new WeakMap<object, Map<string, BrowserReleaseManifest>>();
async function getRelease(env: Env, buildId: string): Promise<BrowserReleaseManifest> {
  if (!/^[0-9a-f]{64}$/.test(buildId)) throw new ApiError("RELEASE_NOT_FOUND", 404, "release");
  const owner=rawD1Database(env.DB);let manifestMemo=manifestMemos.get(owner);if(!manifestMemo){manifestMemo=new Map();manifestMemos.set(owner,manifestMemo);}
  const memoKey = `${env.APP_ENV}:${env.SHELL_ORIGIN}:${env.GAME_ORIGINS}:${env.ASSET_ORIGINS}:${buildId}`;
  if (env.APP_ENV !== "fixture" && manifestMemo.has(memoKey)) return manifestMemo.get(memoKey)!;
  const row = await env.DB.prepare("SELECT game_id, game_build_id, frame_origin, browser_manifest FROM game_releases WHERE game_build_id = ?").bind(buildId).first<ReleaseRow>();
  if (!row) throw new ApiError("RELEASE_NOT_FOUND", 404, "release");
  if (row.game_build_id !== buildId) releaseIntegrity();
  const manifest = registeredManifest(row, env);
  if (env.APP_ENV !== "fixture") { if (manifestMemo.size >= 8) manifestMemo.delete(manifestMemo.keys().next().value!); manifestMemo.set(memoKey, manifest); }
  return manifest;
}

function etagMatches(value: string | null, etag: string): boolean {
  return value !== null && value.split(",").some(item => item.trim() === "*" || item.trim().replace(/^W\//, "") === etag);
}
function discardBody(response: { readonly body: ReadableStream | null }): void {
  // A canceled tee branch may wait for its peer: cancellation must not block a HEAD/304/cache fallback.
  try { void response.body?.cancel().catch(() => undefined); } catch { /* Already consumed or closed. */ }
}
function publicResourceCache(): PublicResourceCache | undefined {
  return (globalThis as unknown as { caches?: { default?: PublicResourceCache } }).caches?.default;
}

async function publicFile(request: Request, env: Env, context?: WorkerExecutionContext): Promise<Response> {
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) throw new ApiError("METHOD_NOT_ALLOWED", 405);
  const url = new URL(request.url);
  if (url.search || url.hash || /%2e|%2f|%5c|\\/i.test(request.url)) throw new ApiError("RESOURCE_PATH", 400, "release");
  let manifest: BrowserReleaseManifest;
  if (env.WORKER_ROLE === "game") {
    manifest = await getRelease(env, env.RELEASE_BUILD_ID ?? "");
    if (url.origin !== manifest.frameOrigin) throw new ApiError("ORIGIN_REJECTED", 403);
    if (url.pathname === "/bootstrap.json" || url.pathname === "/manifest.json") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(env) });
      const value = url.pathname === "/bootstrap.json" ? { shellOrigin: env.SHELL_ORIGIN, gameBuildId: manifest.gameBuildId } : manifest;
      const headers = responseHeaders(env); headers.set("Content-Type", "application/json; charset=utf-8");
      return new Response(request.method === "HEAD" ? null : JSON.stringify(value), { headers });
    }
  } else {
    if (!deployment(env).assets.includes(url.origin)) throw new ApiError("ORIGIN_REJECTED", 403);
    const segments = url.pathname.split("/");
    manifest = await getRelease(env, segments[2] ?? "");
    if (segments[1] !== manifest.gameId) throw new ApiError("RESOURCE_NOT_FOUND", 404);
  }
  const artifact = manifest.assets.find(asset => {
    const registered = new URL(asset.url);
    return registered.origin === url.origin && registered.pathname === url.pathname;
  });
  if (!artifact || artifact.scope === "server-private") throw new ApiError("RESOURCE_NOT_FOUND", 404, "release");
  const headers = responseHeaders(env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  headers.set("Content-Type", artifact.mime);
  headers.set("Content-Length", String(artifact.bytes));
  headers.set("ETag", `"sha256-${artifact.sha256}"`);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  // The clean GET key contains no request headers, credentials, query or conditional state.
  const key = new Request(`${url.origin}${url.pathname}`, { method: "GET" }), cache = publicResourceCache();
  let cached: Response | undefined;
  try { cached = await cache?.match(key); } catch { /* Cache availability never grants access or replaces R2. */ }
  if (cached && cached.status === 200 && cached.headers.get("ETag") === headers.get("ETag") && cached.headers.get("Content-Type") === artifact.mime && cached.headers.get("Content-Length") === String(artifact.bytes)) {
    headers.set("X-PWA-Cache", "HIT");
    if (etagMatches(request.headers.get("If-None-Match"), headers.get("ETag")!)) {
      discardBody(cached); headers.delete("Content-Length");
      return new Response(null, { status: 304, headers });
    }
    if (request.method === "HEAD") discardBody(cached);
    // Regenerate current CSP/CORS/isolation headers instead of reusing an old cached policy.
    return new Response(request.method === "HEAD" ? null : cached.body, { headers });
  }
  if (cached) discardBody(cached);
  headers.set("X-PWA-Cache", cache ? "MISS" : "BYPASS");
  if (!env.PUBLIC_BUILDS) throw new ApiError("STORAGE_REQUIRED", 503, "release");
  if (env.RESOURCE_SAFETY_REQUIRED === "true" || env.APP_ENV === "production") {
    if (!env.MATCH_POOL) throw new ApiError("POLICY_REQUIRED", 503, "cost-safety");
    const pool = env.MATCH_POOL.get(env.MATCH_POOL.idFromName("connect-four-v1"));
    const allowance = await pool.fetch(new Request("https://pool.internal/resources/r2-read", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }));
    const allowed = allowance.ok; await allowance.arrayBuffer();
    if (!allowed) throw new ApiError("SAFETY_LIMIT", 503, "cost-safety");
  }
  const object = await env.PUBLIC_BUILDS.get(`public/${manifest.gameId}/${manifest.gameBuildId}/${artifact.path}`);
  if (!object) throw new ApiError("RESOURCE_NOT_FOUND", 404, "release");
  if (object.size !== artifact.bytes) { discardBody(object); throw new ApiError("RESOURCE_INTEGRITY", 503, "release"); }
  if (etagMatches(request.headers.get("If-None-Match"), headers.get("ETag")!)) {
    discardBody(object); headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") { discardBody(object); return new Response(null, { headers }); }
  const response = new Response(object.body, { headers });
  if (cache) {
    const copy = response.clone();
    const stored = Promise.resolve().then(() => cache.put(key, copy)).catch(() => discardBody(copy));
    if (context) context.waitUntil(stored); else await stored;
  }
  return response;
}

async function api(request: Request, env: Env, path: string): Promise<Response> {
  if (path.startsWith("/api/ops/")) {
    const response = await safetyManagementRoute(request, env);
    if (response) return response;
    throw new ApiError("NOT_FOUND", 404);
  }
  if (path === "/api/health" && request.method === "GET") return jsonResponse({ status: "ok", environment: env.APP_ENV, gameplayAvailable: env.GAMEPLAY_ENABLED === "true" && Boolean(env.MATCH_POOL && env.ROOMS && env.CONNECT_FOUR_BUILD_ID) }, env);
  if (path === "/api/catalog" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT catalog_entry FROM game_releases WHERE catalog_visible = 1 AND catalog_entry IS NOT NULL AND game_id <> ? LIMIT 64").bind(FIXTURE_GAME_ID).all<{ catalog_entry: string }>();
    return jsonResponse({ games: rows.results.map(row => JSON.parse(row.catalog_entry) as unknown) }, env);
  }
  if (path === "/api/fixtures/loader" && request.method === "GET") {
    if (env.APP_ENV === "production") throw new ApiError("NOT_FOUND", 404);
    const row = await env.DB.prepare("SELECT game_build_id FROM game_releases WHERE game_id = ? AND catalog_visible = 0 ORDER BY created_at DESC, game_build_id DESC LIMIT 1").bind(FIXTURE_GAME_ID).first<{ game_build_id: string }>();
    if (!row) throw new ApiError("RELEASE_NOT_FOUND", 404, "release");
    return jsonResponse({ release: await getRelease(env, row.game_build_id) }, env);
  }
  if (path === "/api/session" || path === "/api/session/revoke") {
    if (request.method === "POST") {
      enforceOrigin(request, env, true);
      const body = await readObject(request, 512);
      if (Object.keys(body).length) throw new ApiError("INVALID_REQUEST", 400);
    }
    const target = request.method === "POST" && path === "/api/session/revoke" && env.GAMEPLAY_ENABLED === "true"
      ? await sessionRevocationTarget(request, env) : null;
    const response = await sessionRoute(request, env, path);
    if (target && response.ok) await revokeGameplaySession(env, target.id);
    return response;
  }
  if (path.startsWith("/api/play/")) {
    if (env.GAMEPLAY_ENABLED !== "true") throw new ApiError("CAPABILITY_UNAVAILABLE", 503, "gameplay");
    enforceOrigin(request, env, request.method === "POST");
    const upgraded = await gameplaySocketRoute(request, env);
    if (upgraded) return upgraded;
    const session = (await currentSession(request, env))!;
    const response = await gameplayRoute(request, env, session, buildId => getRelease(env, buildId));
    if (response) return response;
    throw new ApiError("NOT_FOUND", 404);
  }
  if (path.startsWith("/api/releases/") && request.method === "GET") {
    const id = path.slice("/api/releases/".length);
    return jsonResponse({ release: await getRelease(env, id) }, env);
  }
  if (path === "/api/presentations" && request.method === "POST") {
    enforceOrigin(request, env, true);
    const session = (await currentSession(request, env))!;
    const body = await readObject(request);
    if (Object.keys(body).length !== 3 || Object.keys(body).some(key => !["gameBuildId", "frameOrigin", "presentationInstanceId"].includes(key)) || typeof body["gameBuildId"] !== "string" || typeof body["frameOrigin"] !== "string" || typeof body["presentationInstanceId"] !== "string" || !/^[A-Za-z0-9-]{8,128}$/.test(body["presentationInstanceId"])) throw new ApiError("INVALID_REQUEST", 400);
    const release = await getRelease(env, body["gameBuildId"]);
    if (body["frameOrigin"] !== release.frameOrigin) throw new ApiError("ORIGIN_REJECTED", 403);
    return jsonResponse({ bindingId: crypto.randomUUID(), sessionId: session.id, expiresAt: Math.min(session.expiresAt, Date.now() + 60_000), capabilityIds: ["ready", "state.subscribe", "assets.resolve"] }, env);
  }
  if (path.startsWith("/api/rooms") || path.startsWith("/api/match")) throw new ApiError("CAPABILITY_UNAVAILABLE", 503, "gameplay");
  // Private object storage is never a public path, proxy or static-assets fallback.
  throw new ApiError("NOT_FOUND", 404);
}

export default {
  async fetch(request: Request, env: Env, context?: WorkerExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      if (env.WORKER_ROLE === "shell" && env.APP_ENV === "production" && new URL(request.url).pathname.startsWith("/api/fixtures/")) throw new ApiError("NOT_FOUND", 404);
      const externalFinalization = await roomFinalizationRoute(request, env);
      if (externalFinalization) return externalFinalization;
      // Recovery has independent authentication and raw control access; business
      // data quotas must never lock out the management route itself.
      if (!new URL(request.url).pathname.startsWith("/api/ops/")) env = withDataSafety(env, context);
      const origins = deployment(env), url = new URL(request.url);
      if (env.WORKER_ROLE !== "shell") return await publicFile(request, env, context);
      if (url.origin !== origins.shell) throw new ApiError("ORIGIN_REJECTED", 403);
      if (url.pathname.startsWith("/api/")) return await api(request, env, url.pathname);
      if (!["GET", "HEAD"].includes(request.method)) throw new ApiError("METHOD_NOT_ALLOWED", 405);
      if (url.pathname.startsWith("/private/") || url.pathname.startsWith("/checkpoints/")) throw new ApiError("NOT_FOUND", 404);
      const assetUrl = new URL(request.url);
      // The Assets binding canonically redirects /index.html to /. Fetch that
      // canonical document internally so the browser keeps its requested /lab URL.
      if (url.pathname === "/lab" || url.pathname === "/lab/" || url.pathname === "/play/connect-four" || url.pathname === "/play/connect-four/" || /^\/room\/[a-zA-Z0-9-]+\/?$/.test(url.pathname)) assetUrl.pathname = "/";
      const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
      const headers = new Headers(asset.headers);
      for (const [name, value] of responseHeaders(env)) headers.set(name, value);
      if (asset.ok && !headers.get("Content-Type")?.includes("text/html")) headers.set("Cache-Control", url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600");
      headers.delete("Set-Cookie");
      return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
    } catch (error) {
      const safe = error instanceof ApiError ? error : error instanceof SafetyError ? new ApiError(error.code, 503, "cost-safety") : error instanceof PolicyError ? new ApiError(error.code, 503, "policy") : new ApiError("INTERNAL_ERROR", 500);
      const value = { error: { code: safe.code, scope: safe.scope, relatedRequestId: requestId, retryable: safe.retryable } };
      try { return jsonResponse(value, env, safe.status); } catch {
        return new Response(JSON.stringify(value), { status: safe.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff" } });
      }
    }
  },
};
