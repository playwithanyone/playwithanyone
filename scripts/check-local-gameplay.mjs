import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";

assert.equal(process.argv.length, 2, "Usage: node scripts/check-local-gameplay.mjs (run on the remote host after build-cloud --game connect-four)");
const root = process.cwd(), origin = "http://127.0.0.1:18873";
for (const port of [18873, 18874]) await new Promise((resolve, reject) => {
  const server = net.createServer(); server.once("error", () => reject(new Error(`TASK_PORT_IN_USE:${port}`)));
  server.listen(port, "127.0.0.1", () => server.close(resolve));
});
const cloud = JSON.parse(await readFile(".generated/cloud/shell.json", "utf8"));
const safety = JSON.parse(cloud.vars.SAFETY_POLICY_JSON); safety.values.environment = "fixture";
const stop = randomBytes(32).toString("hex"), recovery = randomBytes(32).toString("hex"), ticketKey=randomBytes(32).toString("base64url");
const routing=JSON.parse(cloud.vars.ROOM_ROUTING_JSON);routing.environment="fixture";routing.allowedWebSocketOrigins=[origin.replace(/^http/,"ws")];for(const item of routing.games)item.wsOrigin=origin.replace(/^http/,"ws");
const config = { ...cloud, name: "playwithanyone-p3-local", account_id: undefined,
  main: path.join(root, ".generated/cloud/worker.js"), workers_dev: false, routes: [],
  assets: { ...cloud.assets, directory: path.join(root, ".generated/cloud/portal") },
  d1_databases: [{ binding: "DB", database_name: "playwithanyone-p3-local", database_id: "00000000-0000-0000-0000-000000000003" }],
  vars: { ...cloud.vars, APP_ENV: "fixture", SHELL_ORIGIN: origin, SAFETY_POLICY_JSON: JSON.stringify(safety), SAFETY_STOP_TOKEN: stop, SAFETY_RECOVERY_TOKEN: recovery, ROOM_ROUTING_JSON:JSON.stringify(routing), ROOM_TICKET_KEYS_JSON:JSON.stringify({activeKid:"fixture-v1",keys:{"fixture-v1":ticketKey}}) } };
await mkdir("artifacts/p3", { recursive: true });
await writeFile(".generated/p3-local.json", JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
const wrangler = path.join(root, "node_modules/wrangler/bin/wrangler.js");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const persistence = `.wrangler/p3/${stamp}`;
let log = "", server;
const partial = { out: "", err: "" };
const maximumLogBytes = safety.values.data.maxLogBytesPerRun;
const sanitize = chunk => String(chunk).replaceAll(stop, "[LOCAL_FIXTURE_SECRET]").replaceAll(recovery, "[LOCAL_FIXTURE_SECRET]").replaceAll(ticketKey,"[LOCAL_FIXTURE_SECRET]")
  .split("\n").filter(line => !/(SAFETY_(STOP|RECOVERY)_TOKEN|ROOM_TICKET_KEYS_JSON)/.test(line)).join("\n");
function appendLog(stream, chunk) {
  partial[stream] += String(chunk);
  const end = partial[stream].lastIndexOf("\n");
  if (end >= 0) { log += sanitize(partial[stream].slice(0, end + 1)); partial[stream] = partial[stream].slice(end + 1); }
  log = log.slice(-maximumLogBytes);
}
const environment = { ...process.env, GOMAXPROCS: "2", RAYON_NUM_THREADS: "2", WRANGLER_SEND_METRICS: "false", CI: "1" };
function command(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], { env: environment, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  log += sanitize(result.stdout ?? "") + sanitize(result.stderr ?? "");
  if (result.status !== 0) throw new Error("LOCAL_D1_SETUP_FAILED; inspect the task's sanitized workerd log");
}
try {
  const migrations = (await readdir("apps/edge/migrations")).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  for (const file of [...migrations.map(name => `apps/edge/migrations/${name}`), ".generated/cloud/register-release.sql"]) {
    command(["d1", "execute", "playwithanyone-p3-local", "--local", "--config", ".generated/p3-local.json", "--persist-to", persistence, "--file", file]);
  }
  server = spawn(process.execPath, [wrangler, "dev", "--local", "--config", ".generated/p3-local.json", "--ip", "127.0.0.1", "--port", "18873", "--inspector-port", "18874", "--persist-to", persistence],
    { env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", chunk => appendLog("out", chunk)); server.stderr.on("data", chunk => appendLog("err", chunk));
  let listening = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error("LOCAL_WORKERD_EXITED; inspect sanitized log");
    try { const response = await fetch(origin + "/api/health", { signal: AbortSignal.timeout(600) }); if (response.ok) { await response.arrayBuffer(); listening = true; break; } }
    catch { /* Bounded startup observation; no account calls. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(listening, "LOCAL_WORKERD_STARTUP_TIMEOUT");
  console.log(JSON.stringify({ status: "LOCAL_WORKERD_READY", origin, fixtureStorage: persistence }));
  const result = await new Promise(resolve => {
    const check = spawn(process.execPath, ["scripts/check-gameplay-http.mjs", "--origin", origin, "--exercise-safety"], {
      env: { ...environment, PWA_LOCAL_SAFETY_STOP: stop, PWA_LOCAL_SAFETY_RECOVERY: recovery }, stdio: ["ignore", "inherit", "inherit"] });
    check.on("close", resolve); check.on("error", () => resolve(1));
  });
  process.exitCode = result === 0 ? 0 : 1;
} catch (error) { process.exitCode = 1; console.error(error instanceof Error ? error.message : "Local gameplay verification failed"); }
finally {
  // Only the process group created by this script is eligible for cleanup.
  if (server && server.exitCode === null && server.pid) {
    try { process.kill(-server.pid, "SIGTERM"); } catch { /* This task's server already exited. */ }
    await new Promise(resolve => { server.once("close", resolve); setTimeout(resolve, 1500); });
  }
  log += sanitize(partial.out) + sanitize(partial.err);
  await writeFile(`artifacts/p3/workerd-${stamp}.log`, log.slice(-maximumLogBytes));
  await writeFile("artifacts/p3/workerd.log", log.slice(-maximumLogBytes));
  await writeFile("artifacts/p3/local-run.json", JSON.stringify({ createdAt: new Date().toISOString(), status: process.exitCode ? "FAIL" : "PASS",
    scope: "Isolated actual workerd/D1/SQLite DO and HTTP/WSS only", origin, persistence, fixtureServerStopped: !server || server.exitCode !== null || server.signalCode !== null,
    log: "artifacts/p3/workerd.log", noCloudMutations: true }, null, 2) + "\n");
  await writeFile(".generated/p3-local.json", JSON.stringify({ ...config, vars: { ...config.vars, SAFETY_STOP_TOKEN: "FIXTURE_SERVER_STOPPED", SAFETY_RECOVERY_TOKEN: "FIXTURE_SERVER_STOPPED", ROOM_TICKET_KEYS_JSON: "FIXTURE_SERVER_STOPPED" } }, null, 2) + "\n", { mode: 0o600 });
}
