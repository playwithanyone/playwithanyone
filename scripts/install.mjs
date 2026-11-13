import { createHash } from "node:crypto";
import { readFile, writeFile, access, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const hash = createHash("sha256");
const manifests = ["package.json", "package-lock.json"];
for (const directory of ["packages", "apps"]) {
  for (const name of await readdir(directory)) {
    const manifest = `${directory}/${name}/package.json`;
    try { await access(manifest); manifests.push(manifest); } catch { /* not a workspace */ }
  }
}
for (const file of manifests.sort()) hash.update(await readFile(file));
const expected = hash.digest("hex");
const marker = "node_modules/.pwa-install-sha256";
let ready = false;
try {
  ready = (await readFile(marker, "utf8")).trim() === expected;
  await access("node_modules/typescript/lib/tsc.js");
  await access("node_modules/@types/node/index.d.ts");
} catch { ready = false; }
if (ready) {
  console.log("Reusing matching project dependencies.");
} else {
  const result = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
  await writeFile(marker, expected + "\n");
}
