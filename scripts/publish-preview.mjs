// Publish only explicitly approved preview games; never upgrade billing or enable paid services.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const arguments_ = process.argv.slice(2);
let roles = ["shell", "assets", "game"], requestedGame;
const seen = new Set();
for (let index = 0; index < arguments_.length; index += 2) {
  const flag = arguments_[index], value = arguments_[index + 1];
  assert.ok(["--roles", "--game"].includes(flag) && value && !value.startsWith("--") && !seen.has(flag), "Usage: publish-preview.mjs [--game fixture-loader|connect-four] [--roles shell,game,assets]");
  seen.add(flag);
  if (flag === "--roles") roles = value.split(","); else requestedGame = value;
}
assert.ok(roles.length > 0 && new Set(roles).size === roles.length && roles.every(role => ["assets", "game", "shell"].includes(role)));
const resources = JSON.parse(await readFile("configs/cloud/resources.json", "utf8"));
const gameId = requestedGame ?? resources.activeGameId ?? "fixture-loader";
assert.ok(["fixture-loader", "connect-four"].includes(gameId), "Game is not approved for this preview.");
const prepared = JSON.parse(await readFile(`.generated/${gameId === "fixture-loader" ? "loader" : "connect-four"}-release.json`, "utf8"));
assert.equal(resources.environment, "preview");
assert.ok(typeof resources.accountId === "string" && /^[a-f0-9]{32}$/.test(resources.accountId) && !/^0+$/.test(resources.accountId), "Configure a non-placeholder account in ignored configs/cloud/resources.json.");
assert.ok(typeof resources.databaseId === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(resources.databaseId) && !/^0+$/.test(resources.databaseId.replaceAll("-", "")), "Configure an actual D1 database.");
if (resources.zoneId !== undefined) assert.ok(typeof resources.zoneId === "string" && /^[a-f0-9]{32}$/.test(resources.zoneId) && !/^0+$/.test(resources.zoneId), "Configure an actual zone ID.");
for (const origin of [resources.shellOrigin, resources.assetOrigin]) {
  const url = new URL(origin);
  assert.ok(url.origin === origin && url.protocol === "https:" && !/(?:^|\.)(?:example\.(?:com|org|net)|invalid|localhost)$/.test(url.hostname), "Example origins cannot be published.");
}
assert.ok(resources.schemaVersion === 1 && Array.isArray(resources.registeredBuilds), "Explicit deployment configuration required.");
assert.equal(resources.storageClass, "Standard");
assert.match(prepared.gameBuildId ?? "", /^[0-9a-f]{64}$/);
const directory = path.join(".generated/releases", prepared.gameBuildId);
const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
const { canonicalize } = await import("../.generated/cloud/canonical.mjs");
const sha256 = value => createHash("sha256").update(value).digest("hex");
assert.equal(sha256(canonicalize(manifest.identity)), prepared.gameBuildId);
assert.equal(manifest.identity.gameId, gameId);
assert.equal(manifest.gameBuildId, prepared.gameBuildId);
const cloudBuild = JSON.parse(await readFile(".generated/cloud/build.json", "utf8"));
assert.equal(cloudBuild.gameBuildId, manifest.gameBuildId);
assert.equal(cloudBuild.shellOrigin, resources.shellOrigin, "Prepared cloud output targets a different shell origin.");
const shellConfig = JSON.parse(await readFile(".generated/cloud/shell.json", "utf8"));
assert.equal(shellConfig.account_id, resources.accountId, "Prepared cloud output targets a different account.");
assert.ok(shellConfig.d1_databases?.some(item => item.binding === "DB" && item.database_id === resources.databaseId && item.database_name === resources.databaseName), "Prepared cloud output targets a different D1 database.");
assert.equal(shellConfig.name, resources.shellWorkerName, "Prepared cloud output targets a different Worker.");
for (const file of cloudBuild.files) {
  assert.ok(file.path.startsWith(".generated/cloud/") && !file.path.split("/").includes(".."));
  assert.equal(sha256(await readFile(file.path)), file.sha256, `Changed cloud artifact: ${file.path}`);
}
const objects = [];
for (const artifact of manifest.identity.artifacts) {
  const segments = artifact.path.split("/");
  assert.ok(["client", "assets", "public-simulation", "server-private"].includes(artifact.scope));
  assert.equal(segments[0], artifact.scope);
  assert.ok(segments.length > 1 && segments.every(item => item && item !== "." && item !== "..") && !/[\\%?#:\x00-\x20]/.test(artifact.path));
  const isPrivate = artifact.scope === "server-private";
  const file = path.join(directory, isPrivate ? "private" : "public", artifact.path);
  const content = await readFile(file);
  assert.equal(content.length, artifact.bytes); assert.equal(sha256(content), artifact.sha256);
  objects.push({ ...artifact, file, bucket: isPrivate ? resources.privateBucket : resources.publicBucket,
    key: `${isPrivate ? "private" : "public"}/${manifest.identity.gameId}/${manifest.gameBuildId}/${artifact.path}` });
}
// This guard belongs to these two small approved preview releases, not all future games.
assert.ok(objects.length <= 64 && objects.reduce((sum, item) => sum + item.bytes, 0) <= 5 * 1024 * 1024, "Preview publication budget exceeded.");
await mkdir("artifacts/cloud", { recursive: true });
const journalPath = `artifacts/cloud/publication-${manifest.gameBuildId}.json`;
let journal;
try { journal = JSON.parse(await readFile(journalPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
journal ??= { schemaVersion: 1, gameBuildId: manifest.gameBuildId, startedAt: new Date().toISOString(), accountId: resources.accountId, actions: {}, publishedObjectBytes: objects.reduce((sum, item) => sum + item.bytes, 0) };
assert.equal(journal.accountId, resources.accountId, "Publication history belongs to another account; reconcile it before proceeding.");
journal.objects ??= objects.map(({ path, scope, bytes }) => ({ path, scope, bytes }));
if (gameId === "connect-four") {
  const { resolveSafetyPolicy, assertPublication } = await import("../.generated/cloud/safety.mjs");
  const resolution = resolveSafetyPolicy(JSON.parse(await readFile(".generated/cloud/safety.preview.json", "utf8")), "preview");
  assert.equal(resolution.status, "BOUND", "Publication safety policy is incomplete.");
  const policy = resolution.value;
  assert.equal(policy.mode, "free-preview"); assert.equal(policy.accountId, resources.accountId);
  assert.ok(Date.now() >= policy.cycle.startsAt && Date.now() < policy.cycle.endsAt, "Preview application quota period expired.");
  let cycleWrites = 0, storedBytes = 0;
  for (const name of (await readdir("artifacts/cloud")).filter(name => /^publication-[0-9a-f]{64}\.json$/.test(name))) {
    const previous = JSON.parse(await readFile(`artifacts/cloud/${name}`, "utf8"));
    assert.equal(previous.accountId, resources.accountId);
    const uploads = Object.entries(previous.actions).filter(([id]) => id.startsWith("upload:"));
    for (const [id, upload] of uploads) {
      assert.equal(upload.status, "DONE", `R2 write requires cloud reconciliation before further publication: ${name}:${id}`);
      const time = Date.parse(upload.startedAt); assert.ok(Number.isFinite(time));
      if (time >= policy.cycle.startsAt && time < policy.cycle.endsAt) cycleWrites += 1;
    }
    if (previous.gameBuildId === manifest.gameBuildId) {
      storedBytes += objects.filter(item => previous.actions[`upload:${item.path}`]?.status === "DONE").reduce((sum, item) => sum + item.bytes, 0);
    } else if (Array.isArray(previous.objects)) {
      storedBytes += previous.objects.filter(item => previous.actions[`upload:${item.path}`]?.status === "DONE").reduce((sum, item) => sum + item.bytes, 0);
    } else if (uploads.length) {
      // Historical fixture records only have total publication bytes; reserve the
      // full amount conservatively rather than inventing a lower storage usage.
      assert.ok(Number.isSafeInteger(previous.publishedObjectBytes) && previous.publishedObjectBytes >= 0);
      storedBytes += previous.publishedObjectBytes;
    }
  }
  const pendingObjects = objects.filter(item => journal.actions[`upload:${item.path}`]?.status !== "DONE");
  assertPublication(policy, pendingObjects.map(item => ({ bytes: item.bytes })), { cycleWrites, storedBytes });
  journal.safety = { policyId: resolution.binding.policyId, policyVersion: resolution.binding.version, applicationCycle: policy.cycle.id, cycleWritesBefore: cycleWrites, storedBytesBefore: storedBytes, additionalWrites: pendingObjects.length, additionalBytes: pendingObjects.reduce((sum, item) => sum + item.bytes, 0), scope: "Project publication journals; not an account invoice or supplier monetary cap" };
}
async function save() { await writeFile(journalPath, JSON.stringify(journal, null, 2) + "\n"); }
async function action(id, args) {
  const previous = journal.actions[id];
  if (previous?.status === "DONE") return previous.stdout;
  if (previous) throw new Error(`ACTION_RECONCILIATION_REQUIRED: ${id}; inspect the actual Cloudflare result before retrying.`);
  journal.actions[id] = { status: "DISPATCHING", command: ["wrangler", ...args], startedAt: new Date().toISOString() }; await save();
  console.log(`Cloudflare preview: ${id}`);
  const result = spawnSync(process.env.PWA_WRANGLER_BIN || "wrangler", args, {
    cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: resources.accountId, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  journal.actions[id] = { ...journal.actions[id], status: result.status === 0 ? "DONE" : "NEEDS_RECONCILIATION", exitCode: result.status, stdout: result.stdout, stderr: result.stderr, finishedAt: new Date().toISOString() }; await save();
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? ""); process.stdout.write(result.stdout ?? "");
    throw new Error(`Cloudflare action stopped: ${id}. No automatic mutation retry was attempted.`);
  }
  return result.stdout;
}
for (const object of objects) {
  await action(`upload:${object.path}`, ["r2", "object", "put", `${object.bucket}/${object.key}`, "--file", object.file, "--remote", "--content-type", object.mime, "--storage-class", "Standard", "--cache-control", object.scope === "server-private" ? "no-store" : "public, max-age=31536000, immutable"]);
}
const migrationNames = (await readdir("apps/edge/migrations")).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
for (const name of migrationNames) {
  if (gameId === "fixture-loader" && name !== "0001_sessions_and_releases.sql") continue;
  const file = `apps/edge/migrations/${name}`, fingerprint = sha256(await readFile(file)).slice(0, 16);
  await action(`migrate-d1:${name}:${fingerprint}`, ["d1", "execute", resources.databaseName, "--remote", "--config", ".generated/cloud/shell.json", "--file", file, "--json"]);
}
const registeredText = await action("register-release", ["d1", "execute", resources.databaseName, "--remote", "--config", ".generated/cloud/shell.json", "--file", ".generated/cloud/register-release.sql", "--json"]);
function jsonResult(text) {
  // Wrangler 4.29 writes proxy/import progress before the final JSON array.
  for (const start of text.matchAll(/^\[/gm)) {
    try { const value = JSON.parse(text.slice(start.index)); if (Array.isArray(value)) return value; } catch { /* Try the actual final JSON document. */ }
  }
  throw new Error("Wrangler did not return one complete JSON result array.");
}
assert.ok(jsonResult(registeredText).every(item => item.success === true), "Release registration did not succeed.");
// D1's --file import returns execution totals, not SELECT rows. Read the row separately.
const verifiedText = await action("verify-release", ["d1", "execute", resources.databaseName, "--remote", "--config", ".generated/cloud/shell.json", "--command", `SELECT game_build_id, game_id, frame_origin, catalog_visible, browser_manifest FROM game_releases WHERE game_build_id = '${manifest.gameBuildId}'`, "--json"]);
const browserManifest = canonicalize(JSON.parse(await readFile(path.join(directory, "public/browser-manifest.json"), "utf8")));
assert.ok(jsonResult(verifiedText).flatMap(item => item.results ?? []).some(item => item.game_build_id === manifest.gameBuildId && item.game_id === gameId && item.frame_origin === manifest.frameOrigin && item.browser_manifest === browserManifest && (gameId !== "fixture-loader" || item.catalog_visible === 0)), "Immutable release registration conflict.");
for (const role of roles) {
  const fingerprint = sha256(Buffer.concat([
    await readFile(".generated/cloud/worker.js"), await readFile(`.generated/cloud/${role}.json`),
    Buffer.from(canonicalize(role === "shell" ? cloudBuild.files.filter(item => item.path.startsWith(".generated/cloud/portal/")) : [])),
  ])).slice(0, 20);
  await action(`deploy:${role}:${fingerprint}`, ["deploy", "--no-bundle", "--config", `.generated/cloud/${role}.json`]);
}
if (roles.includes("game")) for (const name of cloudBuild.legacyGameConfigs ?? []) {
  assert.match(name, /^legacy-[0-9a-f]{64}\.json$/);
  const fingerprint = sha256(Buffer.concat([await readFile(".generated/cloud/worker.js"), await readFile(`.generated/cloud/${name}`)])).slice(0, 20);
  await action(`deploy-legacy:${name}:${fingerprint}`, ["deploy", "--no-bundle", "--config", `.generated/cloud/${name}`]);
}
journal.status = ["assets", "game", "shell"].every(role => Object.entries(journal.actions).some(([id, value]) => id.startsWith(`deploy:${role}:`) && value.status === "DONE")) ? "DEPLOYED_PENDING_VERIFICATION" : "PARTIALLY_DEPLOYED";
if (gameId === "connect-four" && journal.status === "DEPLOYED_PENDING_VERIFICATION") {
  await action("activate-catalog", ["d1", "execute", resources.databaseName, "--remote", "--config", ".generated/cloud/shell.json", "--file", ".generated/cloud/activate-catalog.sql", "--json"]);
  const catalogText = await action("verify-catalog", ["d1", "execute", resources.databaseName, "--remote", "--config", ".generated/cloud/shell.json", "--command", "SELECT game_build_id FROM game_releases WHERE game_id = 'connect-four' AND catalog_visible = 1", "--json"]);
  const entries = jsonResult(catalogText).flatMap(item => item.results ?? []);
  assert.equal(entries.length, 1); assert.equal(entries[0].game_build_id, manifest.gameBuildId);
  resources.activeGameId = "connect-four";
}
journal.finishedAt = new Date().toISOString();
journal.shellOrigin = resources.shellOrigin; journal.frameOrigin = manifest.frameOrigin; await save();
if (!resources.registeredBuilds.some(item => item.gameBuildId === manifest.gameBuildId)) {
  resources.registeredBuilds.push({ gameBuildId: manifest.gameBuildId, frameOrigin: manifest.frameOrigin, gameId: manifest.identity.gameId });
}
await writeFile("configs/cloud/resources.json", JSON.stringify(resources, null, 2) + "\n");
await writeFile("artifacts/cloud/latest-publication.json", JSON.stringify(journal, null, 2) + "\n");
console.log(JSON.stringify({ status: journal.status, shellOrigin: resources.shellOrigin, frameOrigin: manifest.frameOrigin, publishedObjectBytes: journal.publishedObjectBytes, journal: journalPath }));
