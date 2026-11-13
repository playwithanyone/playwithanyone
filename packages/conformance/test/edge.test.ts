import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, deployment, enforceOrigin, readObject, responseHeaders } from "../../../apps/edge/src/security.js";
import type { Env, PublicResourceCache, SqlStatement } from "../../../apps/edge/src/env.js";
import worker from "../../../apps/edge/src/index.js";
import type { BrowserReleaseManifest } from "../../release/src/release.js";

const env = {
  APP_ENV: "fixture", WORKER_ROLE: "shell", SHELL_ORIGIN: "http://127.0.0.1:8787",
  GAME_ORIGINS: "http://localhost:8788", ASSET_ORIGINS: "", SESSION_TTL_SECONDS: "3600",
} as Env;
const errorCode = (code: string) => (error: unknown): boolean => error instanceof ApiError && error.code === code;

test("P2 security: missing origins fail closed; HTTPS is required outside fixture configuration", () => {
  assert.deepEqual(deployment(env).games, ["http://localhost:8788"]);
  assert.throws(() => deployment({ ...env, APP_ENV: "production" }), errorCode("CONFIG_INVALID"));
  assert.throws(() => deployment({ ...env, GAME_ORIGINS: env.SHELL_ORIGIN }), errorCode("CONFIG_INVALID"));
  assert.throws(() => deployment({ ...env, SHELL_ORIGIN: "https://example.com/path" }), errorCode("CONFIG_INVALID"));
});

test("P2 security: mutating API requires exact origin, JSON and custom header", () => {
  const make = (origin: string, custom = "1", site = "same-origin") => new Request(`${env.SHELL_ORIGIN}/api/session`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-PWA-Request": custom, "Sec-Fetch-Site": site }, body: "{}" });
  enforceOrigin(make(env.SHELL_ORIGIN), env, true);
  assert.throws(() => enforceOrigin(make("https://attacker.example"), env, true), errorCode("ORIGIN_REJECTED"));
  assert.throws(() => enforceOrigin(make(env.SHELL_ORIGIN, ""), env, true), errorCode("CSRF_REJECTED"));
  assert.throws(() => enforceOrigin(make(env.SHELL_ORIGIN, "1", "cross-site"), env, true), errorCode("ORIGIN_REJECTED"));
});

test("P2 security: shell, game and assets each receive restrictive independent headers", () => {
  const shell = responseHeaders(env), game = responseHeaders(env, "game"), assets = responseHeaders(env, "assets");
  assert.match(shell.get("Content-Security-Policy")!, /frame-src http:\/\/localhost:8788/);
  assert.match(shell.get("Content-Security-Policy")!, /frame-ancestors 'none'/);
  assert.match(game.get("Content-Security-Policy")!, /frame-ancestors http:\/\/127.0.0.1:8787/);
  assert.match(game.get("Content-Security-Policy")!, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(game.get("Content-Security-Policy")!, /'unsafe-eval'/);
  assert.equal(game.get("Cross-Origin-Resource-Policy"), "cross-origin");
  assert.equal(assets.get("Access-Control-Allow-Origin"), "*");
  assert.equal(assets.has("Access-Control-Allow-Credentials"), false);
  assert.match(assets.get("Content-Security-Policy")!, /script-src 'none'/);
  assert.match(assets.get("Content-Security-Policy")!, /worker-src 'none'/);
  assert.match(assets.get("Content-Security-Policy")!, /frame-ancestors 'none'/);
  assert.equal(shell.get("Cache-Control"), "no-store");
  assert.match(shell.get("Permissions-Policy")!, /clipboard-write=\(self\)/);
  assert.match(game.get("Permissions-Policy")!, /clipboard-write=\(\)/);
  assert.match(assets.get("Permissions-Policy")!, /clipboard-write=\(\)/);
});

test("P2 security: request bodies have actual stream byte and UTF-8 bounds", async () => {
  assert.deepEqual(await readObject(new Request("https://example.test", { method: "POST", body: '{"ok":true}' })), { ok: true });
  await assert.rejects(readObject(new Request("https://example.test", { method: "POST", body: "[]" })), errorCode("INVALID_REQUEST"));
  await assert.rejects(readObject(new Request("https://example.test", { method: "POST", body: "x".repeat(513) }), 512), errorCode("REQUEST_TOO_LARGE"));
  await assert.rejects(readObject(new Request("https://example.test", { method: "POST", body: new Uint8Array([0xff]) })), errorCode("INVALID_REQUEST"));
});

test("shell routes use the canonical index document without forwarding an Assets redirect", async () => {
  const paths: string[] = [];
  const shellEnv: Env = { ...env, ASSETS: { async fetch(request) {
    const url = new URL(request.url); paths.push(url.pathname);
    return url.pathname === "/index.html" ? Response.redirect(`${env.SHELL_ORIGIN}/`, 307) : new Response("<html>preview</html>", { headers: { "Content-Type": "text/html" } });
  } } };
  for (const path of ["/lab", "/play/connect-four", "/room/11111111-1111-4111-8111-111111111111"]) {
    const response = await worker.fetch(new Request(`${env.SHELL_ORIGIN}${path}`), shellEnv);
    assert.equal(response.status, 200); assert.equal(response.headers.has("Location"), false);
    assert.match(await response.text(), /preview/);
  }
  assert.deepEqual(paths, ["/", "/", "/"]);
});

const BUILD = "0".repeat(64), BUILD_LABEL = `b-${"a".repeat(52)}`;
const SHELL = "https://playwithanyone.com", FRAME = `https://${BUILD_LABEL}.fixture-account.workers.dev`;
const ASSETS = "https://assets.fixture-account.workers.dev";
const browserManifest: BrowserReleaseManifest = {
  gameId: "fixture-loader", gameBuildId: BUILD, buildHostLabel: BUILD_LABEL,
  frameOrigin: FRAME, entryUrl: `${FRAME}/client/index.html`, sdk: { min: 1, max: 1 }, protocol: { min: 1, max: 1 },
  profile: { id: "server-turn", version: 1 }, browserCapabilities: [],
  budgets: { peakInputRateHz: 0, stateRateHz: 0, maxFrameBytes: 16384, historyBytes: 4096, rollbackWindowTicks: 0, maxStepCpuMs: 10, maxMemoryBytes: 65536, maxQueuedBytes: 16384, maxBulkBytes: 0, maxConcurrentBulk: 0 },
  recovery: { checkpoints: false, commandLog: false, inputHistory: false, spectating: false, midMatchJoin: false },
  requiredAssets: ["assets/sample.json"],
  assets: [
    { path: "client/index.html", scope: "client", sha256: "1".repeat(64), bytes: 2, mime: "text/html; charset=utf-8", url: `${FRAME}/client/index.html` },
    { path: "assets/sample.json", scope: "assets", sha256: "2".repeat(64), bytes: 2, mime: "application/json; charset=utf-8", url: `${ASSETS}/fixture-loader/${BUILD}/assets/sample.json` },
  ],
};

/** Database/R2 stand-ins exercise routing L0 only; actual storage is verified separately. */
function registeredEnvironment(manifest: unknown = browserManifest): { env: Env; queries: { sql: string; values: (string | number | null)[] }[]; reads: () => number; privateReads: () => number } {
  const queries: { sql: string; values: (string | number | null)[] }[] = [];
  let reads = 0, privateReads = 0;
  const value = manifest as BrowserReleaseManifest;
  const preview = {
    ...env, APP_ENV: "preview", SHELL_ORIGIN: SHELL, GAME_ORIGINS: value.frameOrigin, ASSET_ORIGINS: ASSETS,
    DB: {
      prepare(sql: string) {
        const query = { sql, values: [] as (string | number | null)[] }; queries.push(query);
        const statement: SqlStatement = {
          bind(...values) { query.values = values; return statement; },
          async first<T>() { return (sql.includes("WHERE game_id = ?") ? { game_build_id: BUILD } : { game_id: "fixture-loader", game_build_id: BUILD, frame_origin: value.frameOrigin, browser_manifest: JSON.stringify(manifest) }) as T; },
          async all<T>() { return { results: [] as T[], success: true }; },
          async run() { return { success: true }; },
        };
        return statement;
      },
    },
    ASSETS: { async fetch() { throw new Error("Static fallback must not handle a resource or API"); } },
    PUBLIC_BUILDS: { async get() { reads++; return { body: new Response("{}").body!, size: 2, httpEtag: '"stored"' }; } },
    PRIVATE_STORAGE: { async get() { privateReads++; throw new Error("Private storage is not public"); } },
  } satisfies Env;
  return { env: preview, queries, reads: () => reads, privateReads: () => privateReads };
}

test("P2 registry L0: fixture discovery is preview-only and never added to the formal catalog", async () => {
  const fixture = registeredEnvironment();
  const response = await worker.fetch(new Request(`${SHELL}/api/fixtures/loader`), fixture.env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { release: browserManifest });
  assert.match(fixture.queries[0]!.sql, /catalog_visible = 0/);
  assert.deepEqual(fixture.queries[0]!.values, ["fixture-loader"]);
  await worker.fetch(new Request(`${SHELL}/api/catalog`), fixture.env);
  assert.match(fixture.queries.at(-1)!.sql, /game_id <> \?/);
  assert.deepEqual(fixture.queries.at(-1)!.values, ["fixture-loader"]);
  const before = fixture.queries.length;
  const hidden = await worker.fetch(new Request(`${SHELL}/api/fixtures/loader`), { ...fixture.env, APP_ENV: "production" });
  assert.equal(hidden.status, 404);
  assert.equal(fixture.queries.length, before);
});

test("P2 registry L0: full-digest origins, public projections and artifact scope/path/URL must agree", async () => {
  const changed = (edit: (value: Record<string, unknown>) => void): Record<string, unknown> => {
    const value = JSON.parse(JSON.stringify(browserManifest)) as Record<string, unknown>; edit(value); return value;
  };
  const firstAsset = (value: Record<string, unknown>) => (value["assets"] as Record<string, unknown>[])[0]!;
  for (const manifest of [
    changed(value => { value["frameOrigin"] = "https://b-short.fixture-account.workers.dev"; }),
    changed(value => { value["serverPrivate"] = "must-not-leak"; }),
    changed(value => { (value["budgets"] as Record<string, unknown>)["privateState"] = "must-not-leak"; }),
    changed(value => { firstAsset(value)["path"] = "server-private/secret.js"; }),
    changed(value => { firstAsset(value)["path"] = "client/../server-private/secret.js"; }),
    changed(value => { firstAsset(value)["url"] = `${SHELL}/api/session`; }),
    changed(value => { firstAsset(value)["privateState"] = "must-not-leak"; }),
    changed(value => { (value["assets"] as Record<string, unknown>[])[1]!["mime"] = "text/html"; }),
  ]) {
    const fixture = registeredEnvironment(manifest);
    const response = await worker.fetch(new Request(`${SHELL}/api/releases/${BUILD}`), fixture.env);
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.match(body, /RELEASE_INTEGRITY/); assert.doesNotMatch(body, /must-not-leak/);
    assert.equal(fixture.reads(), 0); assert.equal(fixture.privateReads(), 0);
  }
});

test("P2 resources L0: only the registered public object is readable, with immutable uncredentialed headers", async () => {
  const fixture = registeredEnvironment();
  const publicEnv: Env = { ...fixture.env, WORKER_ROLE: "assets" };
  const assetUrl = browserManifest.assets[1]!.url;
  const response = await worker.fetch(new Request(assetUrl), publicEnv);
  assert.equal(response.status, 200); assert.equal(await response.text(), "{}");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(fixture.reads(), 1);
  for (const url of [assetUrl + "?token=anything", `${ASSETS}/fixture-loader/${BUILD}/server-private/secret.js`, `${ASSETS}/fixture-loader/${BUILD}/assets/unknown.json`]) {
    const rejected = await worker.fetch(new Request(url), publicEnv);
    assert.ok([400, 404].includes(rejected.status));
    assert.equal(rejected.headers.get("Cache-Control"), "no-store");
  }
  assert.equal(fixture.reads(), 1); assert.equal(fixture.privateReads(), 0);
});

async function withCache(cache: PublicResourceCache, run: () => Promise<void>): Promise<void> {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", { value: { default: cache }, configurable: true });
  try { await run(); } finally {
    if (prior) Object.defineProperty(globalThis, "caches", prior);
    else Reflect.deleteProperty(globalThis, "caches");
  }
}

test("P2 cache L0: only validated public GETs cache; clean keys, fresh policy, HEAD and conditional 304", async () => {
  const fixture = registeredEnvironment(), publicEnv: Env = { ...fixture.env, WORKER_ROLE: "assets" };
  const url = browserManifest.assets[1]!.url, saved = new Map<string, { body: ArrayBuffer; status: number; headers: Headers }>();
  const keys: Request[] = [], writes: Request[] = [], pending: Promise<unknown>[] = [];
  const context = { waitUntil(value: Promise<unknown>) { pending.push(value); } };
  const cache: PublicResourceCache = {
    async match(key) {
      keys.push(key);
      const stored = saved.get(key.url);
      return stored ? new Response(stored.body.slice(0), { status: stored.status, headers: stored.headers }) : undefined;
    },
    async put(key, value) {
      writes.push(key);
      saved.set(key.url, { body: await value.arrayBuffer(), status: value.status, headers: new Headers(value.headers) });
    },
  };
  await withCache(cache, async () => {
    const first = await worker.fetch(new Request(url, { headers: { Cookie: "private-session", Authorization: "Bearer private-grant" } }), publicEnv, context);
    assert.equal(first.status, 200); assert.equal(await first.text(), "{}"); await Promise.all(pending);
    assert.equal(first.headers.get("X-PWA-Cache"), "MISS");
    assert.equal(fixture.reads(), 1); assert.equal(writes.length, 1);
    assert.ok(keys.every(key => key.method === "GET" && key.url === url && [...key.headers].length === 0));
    assert.ok(writes.every(key => !key.headers.has("Cookie") && !key.headers.has("Authorization")));
    saved.get(url)!.headers.set("Content-Security-Policy", "script-src 'unsafe-eval'");
    const head = await worker.fetch(new Request(url, { method: "HEAD" }), publicEnv, context);
    assert.equal(head.status, 200); assert.equal(await head.text(), ""); assert.equal(head.headers.get("Content-Length"), "2");
    assert.equal(head.headers.get("X-PWA-Cache"), "HIT");
    assert.match(head.headers.get("Content-Security-Policy")!, /script-src 'none'/);
    assert.doesNotMatch(head.headers.get("Content-Security-Policy")!, /'unsafe-eval'/);
    const etag = head.headers.get("ETag")!;
    const conditional = await worker.fetch(new Request(url, { headers: { "If-None-Match": `"other", W/${etag}` } }), publicEnv, context);
    assert.equal(conditional.status, 304); assert.equal(await conditional.text(), ""); assert.equal(conditional.headers.has("Content-Length"), false);
    assert.equal(fixture.reads(), 1); assert.equal(writes.length, 1);
    const lookupsBefore = keys.length;
    const invalid = await worker.fetch(new Request(url + "?cookie=private"), publicEnv, context);
    assert.equal(invalid.status, 400);
    await worker.fetch(new Request(`${SHELL}/api/health`), fixture.env, context);
    await worker.fetch(new Request(`${SHELL}/api/checkpoints/private`), fixture.env, context);
    const bootstrap = await worker.fetch(new Request(`${FRAME}/bootstrap.json`), { ...fixture.env, WORKER_ROLE: "game", RELEASE_BUILD_ID: BUILD }, context);
    assert.equal(bootstrap.status, 200); assert.equal(bootstrap.headers.get("Cache-Control"), "no-store");
    assert.equal(keys.length, lookupsBefore); assert.equal(writes.length, 1); assert.equal(fixture.privateReads(), 0);
  });
});

test("P2 cache L0: unavailable edge cache falls back to R2 without failing a public read", async () => {
  const fixture = registeredEnvironment();
  await withCache({ async match() { throw new Error("cache unavailable"); }, async put() { throw new Error("cache unavailable"); } }, async () => {
    const response = await worker.fetch(new Request(browserManifest.assets[1]!.url), { ...fixture.env, WORKER_ROLE: "assets" });
    assert.equal(response.status, 200); assert.equal(await response.text(), "{}"); assert.equal(fixture.reads(), 1);
  });
});

test("R2 safety: a denied cache-miss reservation never touches object storage", async () => {
  const fixture = registeredEnvironment(); let reservations = 0;
  const guarded: Env = { ...fixture.env, APP_ENV: "fixture", WORKER_ROLE: "assets", RESOURCE_SAFETY_REQUIRED: "true",
    MATCH_POOL: { idFromName(name) { assert.equal(name, "connect-four-v1"); return name; }, get() { return { async fetch(request) {
      assert.equal(new URL(request.url).pathname, "/resources/r2-read"); assert.equal(request.method, "POST");
      assert.deepEqual(await request.json(), {}); reservations += 1;
      return new Response("{}", { status: 503 });
    } }; } } };
  await withCache({ async match() { return undefined; }, async put() { assert.fail("denied read cannot populate cache"); } }, async () => {
    const denied = await worker.fetch(new Request(browserManifest.assets[1]!.url), guarded);
    assert.equal(denied.status, 503); assert.equal(reservations, 1); assert.equal(fixture.reads(), 0);
    assert.equal(denied.headers.get("Cache-Control"), "no-store");
    const privatePath = await worker.fetch(new Request(`${ASSETS}/fixture-loader/${BUILD}/server-private/rules.js`), guarded);
    assert.equal(privatePath.status, 404); assert.equal(reservations, 1);
  });
});

test("R2 safety: successful reservation is debited only on cache miss", async () => {
  const fixture = registeredEnvironment(); let reservations = 0; let saved: { body: ArrayBuffer; headers: Headers } | undefined;
  const guarded: Env = { ...fixture.env, APP_ENV: "fixture", WORKER_ROLE: "assets", RESOURCE_SAFETY_REQUIRED: "true",
    MATCH_POOL: { idFromName(name) { return name; }, get() { return { async fetch() {
      reservations += 1; return new Response("{}", { status: 200 });
    } }; } } };
  await withCache({ async match() { return saved ? new Response(saved.body.slice(0), { headers: saved.headers }) : undefined; },
    async put(_request, response) { saved = { body: await response.arrayBuffer(), headers: new Headers(response.headers) }; } }, async () => {
    const first = await worker.fetch(new Request(browserManifest.assets[1]!.url), guarded); await first.arrayBuffer();
    const second = await worker.fetch(new Request(browserManifest.assets[1]!.url), guarded); await second.arrayBuffer();
    assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(second.headers.get("X-PWA-Cache"), "HIT");
    assert.equal(reservations, 1); assert.equal(fixture.reads(), 1);
  });
});
