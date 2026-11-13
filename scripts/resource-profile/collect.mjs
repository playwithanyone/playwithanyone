/** Read-only Cloudflare measurements. The fields below were verified by account
 * GraphQL introspection on 2026-11-12; durations are NOT invocation wall time. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENDPOINT = "https://api.cloudflare.com/client/v4";
async function deploymentResources() {
  let value;
  try { value = JSON.parse(await readFile(path.join(ROOT, "configs/cloud/resources.json"), "utf8")); }
  catch { throw new Error("METRICS_DEPLOYMENT_CONFIG_REQUIRED"); }
  if (value.schemaVersion !== 1 || value.environment !== "preview" || typeof value.accountId !== "string" || !/^[a-f0-9]{32}$/.test(value.accountId) || /^0+$/.test(value.accountId) ||
      typeof value.databaseId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.databaseId) || /^0+$/.test(value.databaseId.replaceAll("-", "")) ||
      typeof value.shellWorkerName !== "string" || !/^[A-Za-z0-9_-]{1,63}$/.test(value.shellWorkerName)) throw new Error("METRICS_DEPLOYMENT_CONFIG_INVALID");
  return value;
}
const HASH = value => createHash("sha256").update(value).digest("hex").slice(0, 24);
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ROWS = 2000;
const DOCS = {
  workers: "https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/",
  durableObjects: "https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/",
  d1: "https://developers.cloudflare.com/d1/observability/metrics-analytics/"
};

/** Never print this return value or put it in arguments or a report. */
export async function readMetricCredential() {
  const explicit = process.env.PWA_CF_METRICS_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (explicit) return explicit;
  const locations = [
    path.join(homedir(), "Library/Preferences/.wrangler/config/default.toml"),
    path.join(homedir(), ".config/.wrangler/config/default.toml"),
    path.join(homedir(), ".wrangler/config/default.toml")
  ];
  for (const file of locations) {
    let content;
    try { content = await readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") continue; throw new Error("METRICS_CREDENTIAL_READ_FAILED"); }
    const token = /^oauth_token\s*=\s*"([^"\r\n]+)"/m.exec(content)?.[1];
    const expires = /^expiration_time\s*=\s*"([^"\r\n]+)"/m.exec(content)?.[1];
    if (token && (!expires || Date.parse(expires) > Date.now() + 30_000)) return token;
  }
  throw new Error("METRICS_READ_CREDENTIAL_UNAVAILABLE");
}

export function createReadClient({ token, fetcher = fetch, maxCalls = 48, requestTimeoutMs = 15_000 } = {}) {
  if (!token || !Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 48) throw new Error("METRICS_CLIENT_ARGUMENT_INVALID");
  let calls = 0, pinnedAccount;
  return {
    get calls() { return calls; },
    async request(relativePath, query) {
      if (++calls > maxCalls) throw new Error("METRICS_CALL_LIMIT");
      const { accountId } = await deploymentResources();
      if (pinnedAccount !== undefined && pinnedAccount !== accountId) throw new Error("METRICS_DEPLOYMENT_CHANGED_DURING_COLLECTION");
      pinnedAccount = accountId;
      const namespacePath = new RegExp(`^/accounts/${accountId}/workers/durable_objects/namespaces(?:/[a-f0-9]{32}/objects\\?limit=1000)?$`);
      if (relativePath !== "/graphql" && !namespacePath.test(relativePath)) throw new Error("METRICS_TARGET_NOT_ALLOWED");
      if (relativePath === "/graphql" ? typeof query !== "string" || !/^\s*(?:query\b|\{)/.test(query) : query !== undefined) throw new Error("METRICS_READ_ONLY_OPERATION_REQUIRED");
      const response = await fetcher(ENDPOINT + relativePath, {
        method: query === undefined ? "GET" : "POST", redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(query === undefined ? {} : { "Content-Type": "application/json" }), "User-Agent": "PlayWithAnyone-ResourceProfile/1.0" },
        ...(query === undefined ? {} : { body: JSON.stringify({ query }) })
      });
      if (!response.body) throw new Error("METRICS_BODY_MISSING");
      const reader = response.body.getReader(); const chunks = []; let bytes = 0;
      try {
        for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > MAX_BYTES) throw new Error("METRICS_RESPONSE_LIMIT"); chunks.push(next.value); }
      } finally { await reader.cancel().catch(() => {}); }
      if (!response.ok) throw new Error(`METRICS_HTTP_${response.status}`);
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("METRICS_RESPONSE_NOT_JSON"); }
    }
  };
}

export async function discoverProjectNamespaces(client) {
  const resources = await deploymentResources();
  const body = await client.request(`/accounts/${resources.accountId}/workers/durable_objects/namespaces`);
  if (!body.success || !Array.isArray(body.result)) throw new Error("METRICS_NAMESPACE_DISCOVERY_FAILED");
  const project = body.result.filter(item => item.script === resources.shellWorkerName && ["RoomDO", "MatchPoolDO"].includes(item.class));
  if (project.length !== 2 || project.some(item => !/^[a-f0-9]{32}$/.test(item.id))) throw new Error("METRICS_NAMESPACE_SCOPE_UNAVAILABLE");
  return Object.fromEntries(project.map(item => [item.class, { id: item.id, script: item.script, className: item.class }]));
}

/** This API lists opaque IDs and hasStoredData only; it does not expose the
 * name supplied to idFromName. Caller keeps IDs in memory to identify new rooms. */
export async function listNamespaceObjects(client, namespaceId) {
  if (!/^[a-f0-9]{32}$/.test(namespaceId)) throw new Error("METRICS_NAMESPACE_INVALID");
  const resources = await deploymentResources();
  const body = await client.request(`/accounts/${resources.accountId}/workers/durable_objects/namespaces/${namespaceId}/objects?limit=1000`);
  if (!body.success || !Array.isArray(body.result) || body.result.length >= 1000) throw new Error("METRICS_OBJECT_LIST_UNAVAILABLE_OR_TRUNCATED");
  return body.result.map(item => { if (!/^[a-f0-9]{64}$/.test(item.id)) throw new Error("METRICS_OBJECT_ID_INVALID"); return { id: item.id, objectHash: HASH(item.id), hasStoredData: item.hasStoredData === true }; });
}

function iso(value) { const number = typeof value === "number" ? value : Date.parse(value); if (!Number.isSafeInteger(number)) throw new Error("METRICS_WINDOW_INVALID"); return new Date(number).toISOString(); }
function literal(value) { return JSON.stringify(value); }
function objectFilter(ids) {
  if (ids === undefined || ids.length === 0) return "";
  if (ids.length > 32 || ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error("METRICS_OBJECT_SCOPE_INVALID");
  return `,objectId_in:${literal(ids)}`;
}
function safeRows(rows) {
  return rows.map(row => ({ ...row, ...(row.dimensions ? { dimensions: Object.fromEntries(Object.entries(row.dimensions).map(([key, value]) => key === "objectId" ? ["objectHash", HASH(value)] : [key, value])) } : {}) }));
}
function observation(dataset, rows, collectedAt, window, details) {
  if (!Array.isArray(rows)) return { dataset, quality: "UNAVAILABLE", reason: "DATASET_RESULT_MISSING", rows: null, ...details };
  if (rows.length === 0) return { dataset, quality: "UNKNOWN", reason: "NO_REPORTED_ROWS_IS_NOT_PROOF_OF_ZERO", rows: [], ...details };
  const timestamps = rows.map(row => Date.parse(row.dimensions?.datetime ?? row.dimensions?.datetimeMinute)).filter(Number.isFinite);
  const samples = rows.map(row => row.avg?.sampleInterval).filter(Number.isFinite);
  return {
    dataset, quality: rows.length >= MAX_ROWS ? "UNKNOWN" : "OBSERVED", reason: rows.length >= MAX_ROWS ? "ROW_LIMIT_POSSIBLY_TRUNCATED" : "OFFICIAL_WINDOW_SNAPSHOT_NOT_COMPLETENESS_PROOF",
    rows: safeRows(rows), rowCount: rows.length,
    observedMinimumTimestamp: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
    observedMaximumTimestamp: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    newestReportedTimestampAgeMs: timestamps.length ? collectedAt - Math.max(...timestamps) : null,
    sampleIntervalMinimum: samples.length ? Math.min(...samples) : null,
    sampleIntervalMaximum: samples.length ? Math.max(...samples) : null,
    completenessVerified: false, dataThrough: null,
    window, ...details
  };
}

/** One collection is one read-only GraphQL call. Repeat the same fixed window
 * later to inspect reporting delay; do not add overlapping snapshots together. */
export async function collectOfficialResources(client, {
  start, end, namespaces, roomObjectIds, poolObjectIds,
  scriptNames, label = "resource-window"
} = {}) {
  const resources = await deploymentResources();
  scriptNames ??= [resources.shellWorkerName];
  const startsAt = iso(start), endsAt = iso(end), collectedAt = Date.now();
  if (Date.parse(startsAt) >= Date.parse(endsAt) || Date.parse(endsAt) > collectedAt || Date.parse(endsAt) - Date.parse(startsAt) > 3_600_000) throw new Error("METRICS_WINDOW_INVALID");
  if (!namespaces?.RoomDO?.id || !namespaces?.MatchPoolDO?.id || scriptNames.length > 8 || scriptNames.some(name => !/^[A-Za-z0-9_-]{1,63}$/.test(name))) throw new Error("METRICS_SCOPE_INVALID");

  const time = `datetime_geq:${literal(startsAt)},datetime_lt:${literal(endsAt)}`;
  const room = `namespaceId:${literal(namespaces.RoomDO.id)},${time}`;
  const pool = `namespaceId:${literal(namespaces.MatchPoolDO.id)},${time}`;
  const periodic = filter => `durableObjectsPeriodicGroups(limit:${MAX_ROWS},filter:{${filter}}){dimensions{datetime objectId namespaceId}sum{activeTime cpuTime duration rowsRead rowsWritten subrequests exceededCpuErrors exceededMemoryErrors fatalInternalErrors}max{activeWebsocketConnections memoryUsageBytes}avg{sampleInterval}count}`;
  const invocations = filter => `durableObjectsInvocationsAdaptiveGroups(limit:${MAX_ROWS},filter:{${filter}}){dimensions{datetimeMinute objectId namespaceId status}sum{requests errors wallTime}avg{sampleInterval}quantiles{cpuTimeP50 cpuTimeP95 wallTimeP50 wallTimeP95}}`;
  const storage = filter => `durableObjectsSqlStorageGroups(limit:${MAX_ROWS},filter:{${filter}}){dimensions{datetime namespaceId}max{storedBytes}}`;
  const query = `{viewer{accounts(filter:{accountTag:${literal(resources.accountId)}}){
    workers:workersInvocationsAdaptive(limit:${MAX_ROWS},filter:{scriptName_in:${literal(scriptNames)},${time}}){dimensions{datetimeMinute scriptName eventType status}sum{requests errors subrequests cpuTimeUs wallTime requestDuration}avg{sampleInterval}quantiles{cpuTimeP50 cpuTimeP95 wallTimeP50 wallTimeP95}}
    roomInvocations:${invocations(room + objectFilter(roomObjectIds))}
    roomPeriodic:${periodic(room + objectFilter(roomObjectIds))}
    poolInvocations:${invocations(pool + objectFilter(poolObjectIds))}
    poolPeriodic:${periodic(pool + objectFilter(poolObjectIds))}
    roomStorage:${storage(room)}
    poolStorage:${storage(pool)}
    d1:d1AnalyticsAdaptiveGroups(limit:${MAX_ROWS},filter:{databaseId:${literal(resources.databaseId)},${time}}){dimensions{datetime databaseId}sum{rowsRead rowsWritten readQueries writeQueries}avg{sampleInterval queryBatchTimeMs}count}
  }}}`;
  const body = await client.request("/graphql", query);
  const account = body.data?.viewer?.accounts?.[0];
  const errors = Array.isArray(body.errors) ? body.errors.map(error => ({ path: error.path ?? null, message: typeof error.message === "string" ? error.message.slice(0, 500) : "GRAPHQL_ERROR" })) : [];
  const window = { start: startsAt, endExclusive: endsAt };
  const inputs = [
    ["workers", "workersInvocationsAdaptive", { scope: { scripts: scriptNames }, units: { cpuTimeUs: "microseconds", wallTime: "microseconds", requestDuration: "microseconds", requests: "reported invocations" }, attribution: "Selected scripts include background traffic, not only this test", documentation: DOCS.workers }],
    ["roomInvocations", "durableObjectsInvocationsAdaptiveGroups", { scope: { namespaceId: namespaces.RoomDO.id, objectHashes: roomObjectIds?.map(HASH) ?? null }, units: { wallTime: "microseconds, NOT billable duration" }, documentation: DOCS.durableObjects }],
    ["roomPeriodic", "durableObjectsPeriodicGroups", { scope: { namespaceId: namespaces.RoomDO.id, objectHashes: roomObjectIds?.map(HASH) ?? null }, units: { activeTime: "microseconds", cpuTime: "microseconds", duration: "GB-seconds weighted by configured memory", rowsRead: "SQLite rows", rowsWritten: "SQLite rows", memoryUsageBytes: "whole isolate bytes, NOT per-room memory" }, documentation: DOCS.durableObjects }],
    ["poolInvocations", "durableObjectsInvocationsAdaptiveGroups", { scope: { namespaceId: namespaces.MatchPoolDO.id, objectHashes: poolObjectIds?.map(HASH) ?? null }, units: { wallTime: "microseconds, NOT billable duration" }, documentation: DOCS.durableObjects }],
    ["poolPeriodic", "durableObjectsPeriodicGroups", { scope: { namespaceId: namespaces.MatchPoolDO.id, objectHashes: poolObjectIds?.map(HASH) ?? null }, units: { activeTime: "microseconds", cpuTime: "microseconds", duration: "GB-seconds", rowsRead: "SQLite rows", rowsWritten: "SQLite rows" }, documentation: DOCS.durableObjects }],
    ["roomStorage", "durableObjectsSqlStorageGroups", { scope: { namespaceId: namespaces.RoomDO.id }, aggregation: "Namespace storage snapshots; max must not be summed over time", documentation: DOCS.durableObjects }],
    ["poolStorage", "durableObjectsSqlStorageGroups", { scope: { namespaceId: namespaces.MatchPoolDO.id }, aggregation: "Namespace storage snapshots; max must not be summed over time", documentation: DOCS.durableObjects }],
    ["d1", "d1AnalyticsAdaptiveGroups", { scope: { databaseId: resources.databaseId }, units: { rowsRead: "official rows scanned", rowsWritten: "official rows written", queryBatchTimeMs: "SQL execution milliseconds only" }, attribution: "Whole project database includes background and control queries", documentation: DOCS.d1 }]
  ];
  return {
    schemaVersion: 1, label, collectedAt: new Date(collectedAt).toISOString(), window,
    status: errors.length ? "PARTIAL_OR_UNAVAILABLE" : "OBSERVED_NOT_FINAL",
    apiCallsUsed: client.calls, querySha256: createHash("sha256").update(query).digest("hex"), graphqlErrors: errors,
    observations: Object.fromEntries(inputs.map(([alias, dataset, details]) => [alias, observation(dataset, account?.[alias], collectedAt, window, details)])),
    methodology: [
      "GraphQL fields and units verified by live account introspection; no guessed billing conversions.",
      "Filter uses exact UTC timestamps and half-open windows. Periodic datetime is period START, not necessarily all work inside that second.",
      "Reported timestamps are preserved. Bucket/publish delay and cross-boundary work require quiet guard intervals and later fixed-window requery.",
      "Newest reported timestamp age measures the age of a returned event, NOT a guaranteed ingestion-lag bound.",
      "A successful or stable requery does not establish a completeness watermark. Empty data is UNKNOWN, never assumed zero.",
      "sum.duration in DO periodic is the reported GB-seconds metric; invocation wallTime may include long-lived WebSocket time and is not used for cost.",
      "Adaptive data may be sampled; reported sampleInterval is retained. Percentiles from separate groups must not be averaged into a global percentile.",
      "Workers rows retain eventType: they are reported invocation analytics, not an independently reconciled billable-request counter. Do not blindly add Workers and DO invocations as unique operations.",
      "Do not add overlapping windows or repeated snapshots. Object hashes correlate the same opaque object across windows without storing raw IDs.",
      "No observation here is an invoice or proof of an account-wide monetary cap."
    ]
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const flags = {};
  for (let index = 0; index < args.length; index += 2) { const key = args[index], value = args[index + 1]; if (!["--start", "--end", "--output", "--label"].includes(key) || !value || Object.hasOwn(flags, key)) throw new Error("Usage: collect.mjs --start ISO --end ISO --output FILE [--label NAME]"); flags[key] = value; }
  if (!flags["--start"] || !flags["--end"] || !flags["--output"]) throw new Error("METRICS_WINDOW_AND_OUTPUT_REQUIRED");
  const client = createReadClient({ token: await readMetricCredential() });
  const namespaces = await discoverProjectNamespaces(client);
  const report = await collectOfficialResources(client, { start: flags["--start"], end: flags["--end"], namespaces, label: flags["--label"] });
  await mkdir(path.dirname(flags["--output"]), { recursive: true }); await writeFile(flags["--output"], JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, report: flags["--output"], apiCalls: client.calls, datasets: Object.fromEntries(Object.entries(report.observations).map(([key, value]) => [key, { quality: value.quality, rows: value.rowCount ?? 0, reason: value.reason }])) }));
}
