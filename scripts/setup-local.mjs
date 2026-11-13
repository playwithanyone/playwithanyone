// Create missing operator files. Never overwrite a deployment or contact a cloud API.
import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pairs = [
  ["configs/cloud/resources.example.json", "configs/cloud/resources.json"],
  ["configs/safety.preview.example.json", "configs/safety.preview.json"],
  ["configs/safety.watchdog.preview.example.json", "configs/safety.watchdog.preview.json"],
  ["configs/room-routing.preview.example.json", "configs/room-routing.preview.json"],
  ["configs/resource-profiles/connect-four.example.json", "configs/resource-profiles/connect-four.json"],
  ["configs/budget.example.json", "configs/budget.authorized.json"],
];
const created = [], preserved = [];
for (const [source, destination] of pairs) {
  await mkdir(path.dirname(path.join(root, destination)), { recursive: true });
  try { await copyFile(path.join(root, source), path.join(root, destination), constants.COPYFILE_EXCL); created.push(destination); }
  catch (error) { if (error.code !== "EEXIST") throw error; preserved.push(destination); }
}
console.log(JSON.stringify({ created, preserved, cloudActions: false, notice: "Examples support local checks. Configure your own resources before any deployment; placeholders are not deployable." }, null, 2));
