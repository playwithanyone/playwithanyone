import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const resources = JSON.parse(await readFile("configs/cloud/resources.json", "utf8"));
const configuredId = value => typeof value === "string" && /^[a-f0-9]{32}$/.test(value) && !/^0+$/.test(value);
const configuredDatabase = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) && !/^0+$/.test(value.replaceAll("-", ""));
const configuredOrigin = value => {
  try { const url = new URL(value); return url.origin === value && url.protocol === "https:" && !/(?:^|\.)(?:example\.(?:com|org|net)|invalid|localhost)$/.test(url.hostname); }
  catch { return false; }
};
if (resources.schemaVersion !== 1 || resources.environment !== "preview" || !configuredId(resources.accountId) ||
    (resources.zoneId !== undefined && !configuredId(resources.zoneId)) || !configuredDatabase(resources.databaseId) ||
    !configuredOrigin(resources.shellOrigin) || !configuredOrigin(resources.assetOrigin) || resources.shellOrigin === resources.assetOrigin ||
    !/^[a-z0-9][a-z0-9-]{0,62}\.workers\.dev$/.test(resources.workerSubdomain ?? "") || resources.storageClass !== "Standard" ||
    [resources.shellWorkerName, resources.assetWorkerName, resources.databaseName].some(value => typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(value)) ||
    [resources.publicBucket, resources.privateBucket].some(value => typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)) ||
    resources.publicBucket === resources.privateBucket || !Number.isSafeInteger(resources.sessionTtlSeconds) || resources.sessionTtlSeconds < 60 || !Array.isArray(resources.registeredBuilds)) {
  throw new Error("Configure a real preview deployment in ignored configs/cloud/resources.json; placeholders are not deployable.");
}
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--game")) throw new Error("Usage: build-cloud.mjs [--game fixture-loader|connect-four]");
const gameId = args[1] ?? resources.activeGameId ?? "fixture-loader";
if (!["fixture-loader", "connect-four"].includes(gameId)) throw new Error("Game release is not approved for this preview.");
const prepared = JSON.parse(await readFile(`.generated/${gameId === "fixture-loader" ? "loader" : "connect-four"}-release.json`, "utf8"));
if (!/^[0-9a-f]{64}$/.test(prepared.gameBuildId ?? "")) throw new Error("Invalid prepared release.");
const directory = path.join(".generated/releases", prepared.gameBuildId);
const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
const browserManifest = JSON.parse(await readFile(path.join(directory, "public/browser-manifest.json"), "utf8"));
if (manifest.identity.gameId !== gameId || manifest.gameBuildId !== prepared.gameBuildId || browserManifest.gameBuildId !== manifest.gameBuildId) throw new Error("Prepared release does not match the explicitly selected game.");
const { digestToBase32, canonicalize } = await import("../.build/packages/release/src/release.js");
if (createHash("sha256").update(canonicalize(manifest.identity)).digest("hex") !== manifest.gameBuildId) throw new Error("Release identity digest mismatch.");
const buildHostLabel = `b-${digestToBase32(manifest.gameBuildId)}`;
if (manifest.frameOrigin !== `https://${buildHostLabel}.${resources.workerSubdomain}` || manifest.buildHostLabel !== buildHostLabel) throw new Error("Release hostname is not derived from its complete digest.");
const gameOrigins = [...new Set([...(resources.registeredBuilds ?? []).map(item => item.frameOrigin), manifest.frameOrigin])];
const destination = ".generated/cloud";
// Rebuild only this task-owned output; retain releases, dependencies and test evidence.
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp("apps/portal/dist", path.join(destination, "portal"), { recursive: true });
await cp(".build/packages/release/src/canonical.js", path.join(destination, "canonical.mjs"));
if (gameId === "connect-four") {
  await cp("configs/safety.preview.json", path.join(destination, "safety.preview.json"));
  await build({ entryPoints: ["apps/edge/src/safety/index.ts"], bundle: true, format: "esm", platform: "node", target: "es2022", outfile: path.join(destination, "safety.mjs"), sourcemap: false, logLevel: "warning" });
}
const bundle = await build({ entryPoints: ["apps/edge/src/index.ts"], bundle: true, format: "esm", platform: "browser", target: "es2022", outfile: path.join(destination, "worker.js"), minify: false, sourcemap: false, metafile: true });
const d1 = [{ binding: "DB", database_name: resources.databaseName, database_id: resources.databaseId }];
const variables = { APP_ENV: "preview", SHELL_ORIGIN: resources.shellOrigin, GAME_ORIGINS: gameOrigins.join(","), ASSET_ORIGINS: resources.assetOrigin, SESSION_TTL_SECONDS: String(resources.sessionTtlSeconds), RESOURCE_SAFETY_REQUIRED: gameId === "connect-four" ? "true" : "false" };
let gameplay = {};
if (gameId === "connect-four") {
  const policy = JSON.parse(await readFile("configs/gameplay.preview.json", "utf8"));
  const safety = JSON.parse(await readFile("configs/safety.preview.json", "utf8"));
  variables.SAFETY_POLICY_JSON = JSON.stringify(safety);
  const rules = manifest.identity.artifacts.find(item => item.path === "server-private/rules.js");
  if (!rules) throw new Error("Private rule identity is missing.");
  const compatibleRules = [manifest.gameBuildId];
  for (const previous of resources.registeredBuilds ?? []) {
    if (previous.gameId !== "connect-four" || previous.gameBuildId === manifest.gameBuildId) continue;
    const priorManifest = JSON.parse(await readFile(path.join(".generated/releases", previous.gameBuildId, "manifest.json"), "utf8"));
    const priorRules = priorManifest.identity.artifacts.find(item => item.path === "server-private/rules.js");
    if (priorRules?.sha256 === rules.sha256) compatibleRules.push(previous.gameBuildId);
    else throw new Error("Historical private rules need an explicit versioned RuleLoader before release.");
  }
  const { parseRoomRouting, selectRoomRoute } = await import("../.build/apps/edge/src/gameplay/join-ticket.js");
  const routing = parseRoomRouting(await readFile("configs/room-routing.preview.json", "utf8"), "preview");
  for (const releaseHash of compatibleRules) selectRoomRoute(routing, { gameId: "connect-four", releaseHash, roomId: "release-route-check" });
  variables.CONNECT_FOUR_RULE_BUILDS_JSON = JSON.stringify([...new Set(compatibleRules)]);
  gameplay = { GAMEPLAY_ENABLED: "true", CONNECT_FOUR_BUILD_ID: manifest.gameBuildId,
    GAMEPLAY_POLICY_JSON: JSON.stringify(policy), ROOM_ROUTING_JSON: await readFile("configs/room-routing.preview.json", "utf8"), ROOM_FINALIZE_ENABLED: "false" };
}
// Workers Free already enforces 10 ms CPU; explicit cpu_ms is a Paid-only setting.
const shared = { account_id: resources.accountId, main: "./worker.js", compatibility_date: "2025-08-01", d1_databases: d1, observability: { enabled: false } };
const resourceSafety = gameId === "connect-four" ? { durable_objects: { bindings: [{ name: "MATCH_POOL", class_name: "MatchPoolDO", script_name: resources.shellWorkerName }] } } : {};
const configurations = {
  "shell.json": { ...shared, name: resources.shellWorkerName, workers_dev: false, routes: [{ pattern: new URL(resources.shellOrigin).hostname, custom_domain: true }], assets: { directory: "./portal", binding: "ASSETS", run_worker_first: true }, vars: { ...variables, ...gameplay, WORKER_ROLE: "shell" },
    ...(gameId === "connect-four" ? { durable_objects: { bindings: [{ name: "MATCH_POOL", class_name: "MatchPoolDO" }, { name: "ROOMS", class_name: "RoomDO" }] }, migrations: [{ tag: "p3-connect-four-v1", new_sqlite_classes: ["MatchPoolDO", "RoomDO"] }] } : {}) },
  "assets.json": { ...shared, ...resourceSafety, name: resources.assetWorkerName, workers_dev: true, r2_buckets: [{ binding: "PUBLIC_BUILDS", bucket_name: resources.publicBucket }], vars: { ...variables, WORKER_ROLE: "assets" } },
  "game.json": { ...shared, ...resourceSafety, name: buildHostLabel, workers_dev: true, r2_buckets: [{ binding: "PUBLIC_BUILDS", bucket_name: resources.publicBucket }], vars: { ...variables, WORKER_ROLE: "game", RELEASE_BUILD_ID: manifest.gameBuildId } },
};
const legacyGameConfigs = [];
if (gameId === "connect-four") for (const item of resources.registeredBuilds ?? []) {
  if (item.gameBuildId === manifest.gameBuildId) continue;
  if (!/^[0-9a-f]{64}$/.test(item.gameBuildId) || item.frameOrigin !== `https://b-${digestToBase32(item.gameBuildId)}.${resources.workerSubdomain}`) throw new Error("Invalid registered legacy game origin.");
  const name = `legacy-${item.gameBuildId}.json`;
  configurations[name] = { ...configurations["game.json"], name: `b-${digestToBase32(item.gameBuildId)}`, vars: { ...variables, WORKER_ROLE: "game", RELEASE_BUILD_ID: item.gameBuildId } };
  legacyGameConfigs.push(name);
}
for (const [name, config] of Object.entries(configurations)) await writeFile(path.join(destination, name), JSON.stringify(config, null, 2) + "\n");
const sqlString = value => `'${String(value).replaceAll("'", "''")}'`;
const existingBuild = `(SELECT browser_manifest FROM game_releases WHERE game_build_id = ${sqlString(manifest.gameBuildId)})`;
const catalogVisible = gameId === "connect-four" ? 1 : 0;
const catalogEntry = catalogVisible ? { id: "connect-four", title: "Connect Four", description: "Take turns dropping discs. Connect four to win.", gameBuildId: manifest.gameBuildId, minPlayers: 2, maxPlayers: 2, categories: ["duel"], profile: "server-turn" } : null;
const registerSql = [
  "-- Register immutable bytes first; activate the approved catalog entry only after deployment.",
  `INSERT INTO game_releases (game_build_id, game_id, frame_origin, browser_manifest, catalog_visible, catalog_entry, created_at) VALUES (${sqlString(manifest.gameBuildId)}, ${sqlString(manifest.identity.gameId)}, ${sqlString(manifest.frameOrigin)}, ${sqlString(canonicalize(browserManifest))}, 0, NULL, ${Date.now()}) ON CONFLICT(game_build_id) DO NOTHING;`,
  `SELECT game_build_id, game_id, frame_origin, catalog_visible, CASE WHEN ${existingBuild} = ${sqlString(canonicalize(browserManifest))} THEN 1 ELSE 0 END AS manifest_matches FROM game_releases WHERE game_build_id = ${sqlString(manifest.gameBuildId)};`,
].join("\n");
await writeFile(path.join(destination, "register-release.sql"), registerSql + "\n");
if (catalogEntry) await writeFile(path.join(destination, "activate-catalog.sql"),
  `-- One atomic statement changes the current catalog pointer, retaining old immutable releases.\nUPDATE game_releases SET catalog_visible = CASE WHEN game_build_id = ${sqlString(manifest.gameBuildId)} THEN 1 ELSE 0 END, catalog_entry = CASE WHEN game_build_id = ${sqlString(manifest.gameBuildId)} THEN ${sqlString(canonicalize(catalogEntry))} ELSE NULL END WHERE game_id = ${sqlString(gameId)} AND EXISTS (SELECT 1 FROM game_releases WHERE game_build_id = ${sqlString(manifest.gameBuildId)});\n`);
const sha = value => createHash("sha256").update(value).digest("hex");
async function filesAt(directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...await filesAt(name)); else files.push({ path: name, sha256: sha(await readFile(name)) });
  }
  return files;
}
const records = await filesAt(destination);
await writeFile(path.join(destination, "build.json"), JSON.stringify({ createdAt: new Date().toISOString(), gameId, gameBuildId: manifest.gameBuildId, catalogVisible, legacyGameConfigs, frameOrigin: manifest.frameOrigin, entryUrl: manifest.entryUrl, shellOrigin: resources.shellOrigin, assetsOrigin: resources.assetOrigin, workerInputs: bundle.metafile.inputs, files: records, cloudResourcesCreatedByBuild: false }, null, 2) + "\n");
console.log(JSON.stringify({ status: "PREPARED_NOT_DEPLOYED", gameBuildId: manifest.gameBuildId, shellOrigin: resources.shellOrigin, frameOrigin: manifest.frameOrigin, directory: destination }));
