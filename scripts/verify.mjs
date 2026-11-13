import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const catalog = JSON.parse(await readFile("packages/conformance/cases.json", "utf8"));
const specHash = digest(await readFile("docs/PlayWithAnyone_Architecture_Spec_v1.2.md"));
if (catalog.architectureSha256 !== specHash || catalog.cases.length !== 66 || new Set(catalog.cases.map(item => item.id)).size !== 66) {
  throw new Error("Architecture digest or complete 66-case catalog does not match the source plan.");
}
const testDirectory = ".build/packages/conformance/test";
const files = (await readdir(testDirectory)).filter(name => name.endsWith(".test.js")).sort().map(name => path.join(testDirectory, name));
if (files.length === 0) throw new Error("No compiled test files found.");
const command = ["--test", "--test-concurrency=1", "--test-reporter=tap", ...files];
const result = spawnSync(process.execPath, command, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const tap = result.stdout ?? "";
const records = [];
for (const line of tap.split("\n")) {
  const match = /^(not ok|ok)\s+(\d+)\s+-\s+(.*?)(?:\s+#\s+(SKIP|TODO)\b.*)?$/i.exec(line);
  if (!match) continue;
  records.push({ name: match[3], status: match[4] ? "NOT_RUN" : match[1] === "ok" ? "PASS" : "FAIL", skipped: Boolean(match[4]) });
}
const expectedIds = catalog.cases.filter(item => item.p1L0).map(item => item.id);
const caseResults = catalog.cases.map(item => {
  const pattern = new RegExp(`(?:^|[^A-Z0-9-])${item.id}(?=$|[^A-Z0-9-])`);
  const actual = records.filter(record => pattern.test(record.name));
  const status = actual.length === 0 ? "NOT_RUN" : actual.some(record => record.status === "FAIL") ? "FAIL" : actual.some(record => record.status === "NOT_RUN") ? "NOT_RUN" : "PASS";
  return { ...item, overall: "NOT_RUN", environments: {
    L0: { status, subtests: actual },
    L1: { status: "NOT_RUN", reason: "Actual identity, storage and component integration not implemented in P1." },
    L2: { status: "NOT_RUN", reason: "Actual HTTPS/browser/WS/RTC integration not implemented in P1." },
    L3: { status: "NOT_RUN", reason: "Cloud deployment, public networks and device validation not run." },
  }};
});
const missing = caseResults.filter(item => item.p1L0 && item.environments.L0.status !== "PASS").map(item => item.id);
const skipped = records.filter(record => record.skipped);
const passed = records.filter(record => record.status === "PASS").length;
const failed = records.filter(record => record.status === "FAIL").length;
const success = result.status === 0 && result.error === undefined && records.length > 0 && failed === 0 && skipped.length === 0 && missing.length === 0;
async function sourceFiles(directory) {
  const all = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) all.push(...await sourceFiles(name));
    else if (/\.(ts|json|mjs|sh)$/.test(name)) all.push(name);
  }
  return all;
}
const inputs = ["package.json", "package-lock.json", "tsconfig.json", ...await sourceFiles("packages"), ...await sourceFiles("scripts")].sort();
const hashes = await Promise.all(inputs.map(async name => ({ path: name, sha256: digest(await readFile(name)) })));
const revision = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const report = {
  schemaVersion: 1, phase: "P1", status: success ? "PASS" : "FAIL", createdAt: new Date().toISOString(),
  specification: { version: catalog.architectureVersion, sha256: specHash, planVersion: catalog.planVersion },
  revision: revision.status === 0 ? revision.stdout.trim() : null,
  sourceTreeSha256: digest(JSON.stringify(hashes)), inputs: hashes,
  environment: { level: "L0", execution: "remote source build and serial Node tests", hostname: os.hostname(), node: process.version, platform: process.platform, arch: process.arch, osRelease: os.release() },
  command: ["node", ...command], build: "npm run build (tsc, strict TypeScript)",
  tools: JSON.parse(await readFile("package.json", "utf8")).devDependencies,
  testData: { location: "packages/conformance/test", sha256: digest(JSON.stringify(hashes.filter(item => item.path.includes("/test/")))), productionPolicies: "UNSPECIFIED", models: ["L0 installed-context fixtures", "independent Set receiver oracle", "L0 receipt journal and readiness gate", "fixed published bytes", "explicit monotonic timestamp fixtures"] },
  summary: { total: records.length, passed, failed, skipped: skipped.length, sourceCases: 66, requiredP1L0Cases: expectedIds.length, passingP1L0Cases: expectedIds.length - missing.length, missingOrFailed: missing, retries: 0 },
  error: result.error?.message ?? (result.stderr || null),
  cases: caseResults,
  limits: ["P1 PASS only covers its L0 subtests; source cases with later integration checks remain overall NOT_RUN.", "No DOM, actual identity service, Cloudflare DO/D1/R2, WebRTC/TURN, game migration or production deployment was tested."],
  evidence: { tap: "artifacts/p1/latest.tap", report: "artifacts/p1/latest.json" },
};
const output = "artifacts/p1";
await mkdir(output, { recursive: true });
await writeFile(`${output}/latest.tap`, tap + (result.stderr ? `\n${result.stderr}` : ""));
await writeFile(`${output}/latest.json`, JSON.stringify(report, null, 2) + "\n");
// Preserve attempts so a later repair cannot erase an earlier failing result.
const stamp = report.createdAt.replace(/[:.]/g, "-");
await writeFile(`${output}/${stamp}.json`, JSON.stringify(report, null, 2) + "\n");
await writeFile(`${output}/${stamp}.tap`, tap);
if (!success) process.stdout.write(tap);
console.log(`P1 L0: ${passed}/${records.length} tests passed; ${expectedIds.length - missing.length}/${expectedIds.length} required source cases covered; ${skipped.length} skipped.`);
console.log(`Result: ${report.status}. Evidence: artifacts/p1/latest.json and latest.tap`);
if (missing.length) console.error(`Missing or failing required P1 cases: ${missing.join(", ")}`);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = success ? 0 : 1;
