import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const origin = "http://127.0.0.1:18871";
const writeHeaders = { Origin: origin, "Content-Type": "application/json", "X-PWA-Request": "1" };
const checks = [];
async function check(name, action) { await action(); checks.push({ name, status: "PASS" }); }
await check("real local Worker and D1 return an empty formal catalog", async () => {
  const response = await fetch(`${origin}/api/catalog`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { games: [] });
});
await check("cross-origin mutation fails before creating a session", async () => {
  const response = await fetch(`${origin}/api/session`, { method: "POST", headers: { ...writeHeaders, Origin: "https://attacker.example" }, body: "{}" });
  assert.equal(response.status, 403);
  assert.equal(response.headers.has("Set-Cookie"), false);
});
let cookie, session;
await check("session persists in actual local D1 and opaque credential stays HttpOnly host-only", async () => {
  const response = await fetch(`${origin}/api/session`, { method: "POST", headers: writeHeaders, body: "{}" });
  assert.equal(response.status, 201);
  const header = response.headers.get("Set-Cookie"); assert.ok(header);
  assert.match(header, /^__Host-pwa_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax;/);
  assert.doesNotMatch(header, /Domain=/i);
  cookie = header.split(";")[0];
  const body = await response.json(); session = body.session;
  assert.ok(session.id); assert.ok(session.playerId);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(cookie.split("=")[1]));
  const read = await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } });
  assert.equal(read.headers.get("Cache-Control"), "no-store");
  assert.deepEqual((await read.json()).session, session);
  const reused = await fetch(`${origin}/api/session`, { method: "POST", headers: { ...writeHeaders, Cookie: cookie }, body: "{}" });
  assert.equal(reused.status, 200); assert.deepEqual((await reused.json()).session, session);
});
await check("revocation rejects the old credential and removes the cookie", async () => {
  const response = await fetch(`${origin}/api/session/revoke`, { method: "POST", headers: { ...writeHeaders, Cookie: cookie }, body: "{}" });
  assert.equal(response.status, 200); assert.match(response.headers.get("Set-Cookie"), /Max-Age=0/);
  const read = await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } });
  assert.equal((await read.json()).session, null);
});
await check("shell and API errors retain CSP/isolation; private objects never reach static fallback", async () => {
  const home = await fetch(origin);
  assert.equal(home.status, 200); assert.match(home.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.equal(home.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  for (const path of ["/api/checkpoints/test", "/private/test"]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 404); assert.ok(response.headers.get("Content-Security-Policy"));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
});
await mkdir("artifacts/p2", { recursive: true });
await writeFile("artifacts/p2/http.json", JSON.stringify({ level: "L1", environment: "actual local workerd + SQLite D1 through HTTP on remote Mac mini", checks, limitations: "No real Cloudflare deployment, no browser TLS/Cookie isolation validation, no actual private R2 test." }, null, 2) + "\n");
console.log(`P2 local Worker/D1: ${checks.length}/${checks.length} HTTP checks passed.`);
