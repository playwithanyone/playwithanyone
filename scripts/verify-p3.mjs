import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";

const tests = ["connect-four", "gameplay", "edge", "sdk", "release", "join-ticket", "room-finalize"].map(name => `.build/packages/conformance/test/${name}.test.js`);
tests.push(".build/packages/room-runtime/test/runtime.test.js", ".build/packages/conformance/cost-safety/pool-budget.test.js", ".build/packages/conformance/cost-safety/limits.test.js", ".build/packages/conformance/cost-safety/d1.test.js", "packages/conformance/cost-safety/watchdog.test.mjs");
const command = ["--test", "--test-concurrency=1", "--test-reporter=tap", ...tests];
const result = spawnSync(process.execPath, command, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const tap = result.stdout ?? "";
const value = name => Number(new RegExp(`^# ${name} (\\d+)$`, "m").exec(tap)?.[1] ?? 0);
const total = value("tests"), passed = value("pass"), failed = value("fail"), skipped = value("skipped") + value("todo");
const sha = content => createHash("sha256").update(content).digest("hex");
const inputs = {};
for (const file of ["docs/PlayWithAnyone_Architecture_Spec_v1.2.md", "docs/OPERATIONS.md", "configs/gameplay.preview.json", "configs/safety.preview.json"]) inputs[file] = sha(await readFile(file));
const report = {
  phase: "FIRST_PLAYABLE_PREVIEW", phaseAcceptance: "INCOMPLETE",
  unitStatus: result.status === 0 && total > 0 && passed === total && !skipped ? "PASS" : "FAIL",
  createdAt: new Date().toISOString(), environment: { level: "L0_AND_SQLITE_COMPONENT", hostname: os.hostname(), node: process.version },
  summary: { total, passed, failed, skipped }, command: ["node", ...command], inputs,
  verifiedScope: "Rules, SDK/release/security regression, actual SQLite component transactions, resource protection and watchdog fixed-input tests. Cloudflare lifecycle/network, actual browser and delivered alerts are separate evidence.",
  notVerified: ["Full P2/P3 or later profile acceptance", "Cloudflare DO lifecycle and public WSS in this command", "Actual WAF, Spend Policies, TURN, notification delivery or scheduler health", "Production budget approval or an exact account monetary cap"],
  log: "artifacts/p3/unit.tap", stderr: result.stderr || null,
};
await mkdir("artifacts/p3", { recursive: true });
const stamp = report.createdAt.replace(/[:.]/g, "-");
await writeFile("artifacts/p3/unit.tap", tap);
await writeFile("artifacts/p3/unit.json", JSON.stringify(report, null, 2) + "\n");
await writeFile(`artifacts/p3/unit-${stamp}.json`, JSON.stringify(report, null, 2) + "\n");
if (report.unitStatus !== "PASS") { await writeFile(`artifacts/p3/failed-${stamp}.tap`, tap); process.stdout.write(tap); }
console.log(JSON.stringify({ status: report.unitStatus, passed, total, failed, skipped, scope: report.environment.level }));
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = report.unitStatus === "PASS" ? 0 : 1;
