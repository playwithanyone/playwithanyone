import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";

const tests = ["release", "sdk", "edge"].map(name => `.build/packages/conformance/test/${name}.test.js`);
const command = ["--test", "--test-concurrency=1", "--test-reporter=tap", ...tests];
const result = spawnSync(process.execPath, command, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const tap = result.stdout ?? "";
const value = name => Number(new RegExp(`^# ${name} (\\d+)$`, "m").exec(tap)?.[1] ?? 0);
const total = value("tests"), passed = value("pass"), failed = value("fail"), skipped = value("skipped") + value("todo");
const report = {
  phase: "P2_PREPARATION", overall: "INCOMPLETE", unitStatus: result.status === 0 && total > 0 && passed === total && !skipped ? "PASS" : "FAIL",
  createdAt: new Date().toISOString(), environment: { level: "L0", hostname: os.hostname(), node: process.version },
  summary: { total, passed, failed, skipped }, command: ["node", ...command],
  specificationSha256: createHash("sha256").update(await readFile("docs/PlayWithAnyone_Architecture_Spec_v1.2.md")).digest("hex"),
  verified: ["P2 release/SDK/security algorithm and API tests only", "Strict TypeScript and portal production build completed before this command"],
  notVerified: ["This command only checks L0; actual Cloudflare/R2 results are recorded separately", "Actual cloud DNS/TLS, cross-site browser session and SDK isolation", "Actual Godot/WASM and threaded engine exports", "P3 matching, rooms, game rules and recovery"],
  log: "artifacts/p2/unit.tap", stderr: result.stderr || null,
};
await mkdir("artifacts/p2", { recursive: true });
await writeFile("artifacts/p2/unit.tap", tap);
await writeFile("artifacts/p2/unit.json", JSON.stringify(report, null, 2) + "\n");
if (report.unitStatus !== "PASS") process.stdout.write(tap);
console.log(`P2 preparation: ${passed}/${total} unit tests passed; ${skipped} skipped. Phase remains incomplete.`);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = report.unitStatus === "PASS" ? 0 : 1;
