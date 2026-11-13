// Read-only operator check. Credentials are loaded by Node's --env-file, never arguments.
import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../configs/cloud/resources.json", import.meta.url), "utf8"));
const token = process.env.PWA_SAFETY_STOP_TOKEN;
if (!token || token.length < 32) throw new Error("SAFETY_STOP_CREDENTIAL_REQUIRED");
const origin = new URL(config.shellOrigin);
if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/") throw new Error("SAFETY_ORIGIN_INVALID");
const deadline = Date.now() + 120_000;
const seen = new Set();
let cursor, status, scanId, pages = 0, complete = false;
while (pages < 64 && Date.now() < deadline) {
  const response = await fetch(new URL("/api/ops/safety/status", origin), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(Math.min(20_000, deadline - Date.now())),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ operation: "status", ...(cursor ? { cursor } : {}) })
  });
  const reader = response.body.getReader(); let bytes = 0; const chunks = [];
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    bytes += value.byteLength;
    if (bytes > 65_536) { await reader.cancel(); throw new Error("SAFETY_STATUS_RESPONSE_LIMIT"); }
    chunks.push(value);
  }
  if (response.status !== 200) throw new Error(`SAFETY_STATUS_HTTP_${response.status}`);
  status = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  pages += 1;
  // Old preview versions had no pagination; preserve their explicit counts.
  if (!status.observation) { complete = status.unobservedRooms === 0; break; }
  const observation = status.observation;
  if (scanId && observation.scanId !== scanId) throw new Error("SAFETY_STATUS_SCAN_CHANGED");
  scanId = observation.scanId;
  if (observation.complete === true && observation.nextCursor === null) { complete = true; break; }
  cursor = observation.nextCursor;
  if (typeof cursor !== "string" || !/^[a-f0-9-]{36}:[a-f0-9-]{36}$/.test(cursor) || seen.has(cursor)) throw new Error("SAFETY_STATUS_CURSOR_INVALID");
  seen.add(cursor);
}
const fields = ["state", "poolState", "version", "newAllocationsBlocked", "activeConnections", "backgroundTasks", "roomsObservedStopped", "unobservedRooms", "fullRecoveryObserved", "propagationPending", "propagationFailed", "observation", "d1"];
// Each page already contains cumulative counts. Never sum repeated snapshots.
console.log(JSON.stringify({ environment: config.environment, origin: origin.origin, checkedAt: new Date().toISOString(), scan: { pages, complete, bounded: true }, ...Object.fromEntries(fields.filter(key => Object.hasOwn(status, key)).map(key => [key, status[key]])) }, null, 2));
if (!complete) process.exitCode = 3;
else if (status.state !== "NORMAL" || status.newAllocationsBlocked !== false) process.exitCode = 2;
