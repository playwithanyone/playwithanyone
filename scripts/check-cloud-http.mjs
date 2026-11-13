import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";

const resources = JSON.parse(await readFile("configs/cloud/resources.json", "utf8"));
const gameId = resources.activeGameId ?? "fixture-loader";
assert.ok(["fixture-loader", "connect-four"].includes(gameId));
const prepared = JSON.parse(await readFile(`.generated/${gameId === "fixture-loader" ? "loader" : "connect-four"}-release.json`, "utf8"));
const manifest = JSON.parse(await readFile(`.generated/releases/${prepared.gameBuildId}/public/browser-manifest.json`, "utf8"));
const sampleAsset = manifest.assets.find(item => item.path === "assets/sample.json") ?? manifest.assets.find(item => item.path === "client/style.css");
assert.ok(sampleAsset, "Prepared release lacks a cache verification resource.");
const shell = resources.shellOrigin;
const checks = [];
let requests = 0, credential;
// Node fetch does not automatically inherit the remote machine's HTTP proxy.
// Reuse its existing route without changing any system/network configuration.
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const dispatcher = proxy ? new (await import("undici")).ProxyAgent(proxy) : undefined;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function request(url, options = {}) {
  requests++;
  return fetch(url, { ...options, ...(dispatcher ? { dispatcher } : {}), redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "PlayWithAnyone-Verification/0.1 (+https://playwithanyone.com)", ...options.headers } });
}
async function check(name, action) {
  try { const details = await action(); checks.push({ name, status: "PASS", ...(details ? { details } : {}) }); }
  catch (error) { checks.push({ name, status: "FAIL", reason: error instanceof Error ? error.message : "Verification failed" }); throw error; }
}
const writeHeaders = { Origin: shell, "Content-Type": "application/json", "X-PWA-Request": "1" };
let failed = false;
try {
  await check("live HTTPS shell and isolation headers", async () => {
    const response = await request(shell);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
    assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
    assert.ok(response.headers.get("content-security-policy")?.includes(manifest.frameOrigin));
    assert.ok((await response.text()).includes("PlayWithAnyone"));
    const lab = await request(`${shell}/lab`);
    assert.equal(lab.status, 200); assert.equal(lab.headers.has("location"), false); await lab.arrayBuffer();
  });
  await check("formal catalog excludes internal fixtures", async () => {
    const response = await request(`${shell}/api/catalog`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.games) && body.games.every(game => game.id !== "fixture-loader"));
    if (gameId === "fixture-loader") assert.equal(body.games.length, 0);
    else assert.ok(body.games.some(game => game.id === gameId && game.gameBuildId === manifest.gameBuildId));
  });
  await check("registered release exposes only the public manifest", async () => {
    const response = await request(`${shell}/api/releases/${manifest.gameBuildId}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.release.gameBuildId, manifest.gameBuildId);
    assert.equal(body.release.frameOrigin, manifest.frameOrigin);
    assert.ok(body.release.assets.every(asset => asset.scope !== "server-private"));
    assert.ok(!JSON.stringify(body).includes("server-private/"));
  });
  await check("all registered public files match their SHA-256, length and MIME on actual R2 routes", async () => {
    let totalBytes = 0;
    for (const asset of manifest.assets) {
      const response = await request(asset.url);
      assert.equal(response.status, 200, `Public artifact unavailable: ${asset.path}`);
      assert.equal(response.headers.get("content-type")?.split(";")[0]?.trim(), asset.mime.split(";")[0]?.trim());
      const data = new Uint8Array(await response.arrayBuffer());
      assert.equal(data.byteLength, asset.bytes, `Wrong length: ${asset.path}`);
      assert.equal(hash(data), asset.sha256, `Wrong digest: ${asset.path}`);
      totalBytes += data.length;
    }
    return { files: manifest.assets.length, totalBytes };
  });
  await check("public resource cache, HEAD and conditional GET", async () => {
    const asset = sampleAsset;
    let cached;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await request(asset.url); await response.arrayBuffer();
      cached = response.headers.get("x-pwa-cache");
      if (cached === "HIT") break;
    }
    assert.equal(cached, "HIT");
    // Compare decoded artifact bytes without Cloudflare's negotiated br/gzip encoding.
    const head = await request(asset.url, { method: "HEAD", headers: { "Accept-Encoding": "identity" } });
    assert.equal(head.status, 200); assert.equal(Number(head.headers.get("content-length")), asset.bytes);
    const conditional = await request(asset.url, { headers: { "If-None-Match": `"sha256-${asset.sha256}"` } });
    assert.equal(conditional.status, 304); assert.equal((await conditional.arrayBuffer()).byteLength, 0);
    return { cached };
  });
  await check("private/unknown/query/write resource requests fail without public caching", async () => {
    const attempts = [
      [`${manifest.frameOrigin}/server-private/${gameId === "fixture-loader" ? "marker" : "rules"}.js`, "GET", 404],
      [`${resources.assetOrigin}/${manifest.gameId}/${manifest.gameBuildId}/server-private/${gameId === "fixture-loader" ? "marker" : "rules"}.js`, "GET", 404],
      [sampleAsset.url + "?unknown=1", "GET", 400],
      [sampleAsset.url, "POST", 405],
      [`${shell}/api/checkpoints/not-authorized`, "GET", 404],
    ];
    for (const [url, method, status] of attempts) {
      const response = await request(url, { method });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.ok(response.headers.get("content-security-policy"));
      await response.arrayBuffer();
    }
  });
  await check("real cross-origin API mutation is rejected before issuing a credential", async () => {
    const response = await request(`${shell}/api/session`, { method: "POST", headers: { ...writeHeaders, Origin: "https://other.example" }, body: "{}" });
    assert.equal(response.status, 403); assert.equal(response.headers.has("set-cookie"), false);
    await response.arrayBuffer();
  });
  await check("live session, least-privilege presentation grant and revocation", async () => {
    const response = await request(`${shell}/api/session`, { method: "POST", headers: writeHeaders, body: "{}" });
    assert.equal(response.status, 201);
    const cookie = response.headers.get("set-cookie");
    assert.ok(cookie?.startsWith("__Host-pwa_session=") && cookie.includes("Secure") && cookie.includes("HttpOnly") && cookie.includes("SameSite=Lax") && !cookie.includes("Domain="), "Session cookie attributes are incomplete");
    credential = cookie.split(";")[0];
    const body = await response.json();
    assert.ok(!JSON.stringify(body).includes(credential.split("=")[1]), "A credential reached the JSON body");
    const grant = await request(`${shell}/api/presentations`, { method: "POST", headers: { ...writeHeaders, Cookie: credential }, body: JSON.stringify({ gameBuildId: manifest.gameBuildId, frameOrigin: manifest.frameOrigin, presentationInstanceId: "p-cloud-verification" }) });
    assert.equal(grant.status, 200);
    const permissions = await grant.json();
    assert.ok(permissions.sessionId === body.session.id && permissions.matchScope === undefined && permissions.capabilityIds.length === 3 && !permissions.capabilityIds.includes("actions.dispatch"));
    const revoked = await request(`${shell}/api/session/revoke`, { method: "POST", headers: { ...writeHeaders, Cookie: credential }, body: "{}" });
    assert.equal(revoked.status, 200); await revoked.arrayBuffer();
    const old = await request(`${shell}/api/presentations`, { method: "POST", headers: { ...writeHeaders, Cookie: credential }, body: JSON.stringify({ gameBuildId: manifest.gameBuildId, frameOrigin: manifest.frameOrigin, presentationInstanceId: "p-old-verification" }) });
    assert.equal(old.status, 401); await old.arrayBuffer(); credential = undefined;
  });
} catch (error) { failed = true; console.error(error instanceof Error ? error.message : "Cloud verification failed"); }
finally {
  if (credential) {
    try { const response = await request(`${shell}/api/session/revoke`, { method: "POST", headers: { ...writeHeaders, Cookie: credential }, body: "{}" }); await response.arrayBuffer(); }
    catch { /* Preserve the test failure. An unreturned credential is still time-bounded. */ }
  }
  const report = { createdAt: new Date().toISOString(), environment: { level: "L3_HTTP", hostname: os.hostname(), node: process.version, shellOrigin: shell, existingProxyUsed: Boolean(dispatcher) }, gameBuildId: manifest.gameBuildId, status: failed ? "FAIL" : "PASS", requests, checks, limits: "HTTP/R2/identity boundary verification only. Browser isolation and SDK delivery are checked separately; no actual game rules, Godot or threads were tested." };
  await mkdir("artifacts/cloud", { recursive: true });
  const stamp = report.createdAt.replace(/[:.]/g, "-");
  await writeFile("artifacts/cloud/http.json", JSON.stringify(report, null, 2) + "\n");
  await writeFile(`artifacts/cloud/http-${stamp}.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, checks: checks.filter(item => item.status === "PASS").length, total: checks.length, requests }));
  await dispatcher?.close();
  process.exitCode = failed ? 1 : 0;
}
