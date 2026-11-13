// Audit the actual staged Git blobs, not possibly different working-tree files.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { inspectPublicText } from "./publication-audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function git(args, maximum = 4 * 1024 * 1024) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: maximum });
  if (result.status !== 0 || result.error) throw new Error("PUBLICATION_GIT_READ_FAILED");
  return result.stdout;
}
const entries = git(["ls-files", "--stage", "-z"]).split("\0").filter(Boolean);
if (!entries.length) throw new Error("PUBLICATION_INDEX_EMPTY: stage the intended public files first");
const protectedValues = [];
try {
  const resources = JSON.parse(await readFile(path.join(root, "configs/cloud/resources.json"), "utf8"));
  for (const key of ["accountId", "zoneId", "databaseId", "workerSubdomain"]) {
    const value = resources[key];
    if (typeof value === "string" && value.length >= 16 && !/^[0-]+$/.test(value) && !value.includes("your-subdomain")) protectedValues.push(value);
  }
} catch (error) { if (error.code !== "ENOENT") throw new Error("PUBLICATION_LOCAL_CONFIG_INVALID"); }
const findings = [];
for (const entry of entries) {
  const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
  if (!match) throw new Error("PUBLICATION_INDEX_FORMAT_INVALID");
  const [, mode, objectId, stage, file] = match;
  if (!/^100(?:644|755)$/.test(mode) || stage !== "0") { findings.push({ file, code: "NON_REGULAR_OR_UNMERGED_FILE" }); continue; }
  const size = Number(git(["cat-file", "-s", objectId]).trim());
  if (!Number.isSafeInteger(size) || size > 2 * 1024 * 1024) { findings.push({ file, code: "REQUIRES_LARGE_FILE_REVIEW" }); continue; }
  const content = git(["cat-file", "blob", objectId]);
  if (content.includes("\0")) findings.push({ file, code: "REQUIRES_BINARY_REVIEW" });
  findings.push(...inspectPublicText(file, content, protectedValues));
}
console.log(JSON.stringify({ status: findings.length ? "FAIL" : "PASS", files: entries.length, scanned: "Git index blobs", findings }, null, 2));
if (findings.length) process.exitCode = 1;
