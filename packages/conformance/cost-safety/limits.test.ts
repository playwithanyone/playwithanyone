import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { requirePolicy, PolicyError } from "../../protocol/src/policy.js";
import { SafetyLimits, RoomSafety, SqlSafetyStore, SafetyError, assertD1Usage, assertPublication, assertEntryInventory, assertPaidServiceEnabled, authorizeSafetyManagement, safetyManagementRoute, runStopActions, resolveSafetyPolicy, type ProtectionState, type SafetySqlStorage, type SafetyPolicy } from "../../../apps/edge/src/safety/index.js";
import type { Env, SqlStatement } from "../../../apps/edge/src/env.js";
import { ApiError } from "../../../apps/edge/src/security.js";

const source = JSON.parse(readFileSync("configs/safety.dev.json", "utf8")) as { policyId: string; version: number; values: Record<string, any> };
const at = 10_000;
function fixture(change?: (candidate: typeof source) => void): SafetyPolicy {
  const copy = structuredClone(source); change?.(copy);
  return requirePolicy(resolveSafetyPolicy(copy, "fixture")).value;
}
class SqlFixture implements SafetySqlStorage {
  readonly database = new DatabaseSync(":memory:");
  readonly sql = { exec: (query: string, ...bindings: (string | number | null | ArrayBuffer)[]) => {
    const values = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    const statement = this.database.prepare(query);
    const rows = query.trimStart().toUpperCase().startsWith("SELECT") ? statement.all(...values) : (statement.run(...values), []);
    return { toArray: () => rows };
  } };
  transactionSync<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = callback(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
}
function setup(policy = fixture()) { const database = new SqlFixture(); const store = new SqlSafetyStore(database); return { database, store, limits: new SafetyLimits(policy, store), policy }; }
function code(expected: SafetyError["code"]): (error: unknown) => boolean { return error => error instanceof SafetyError && error.code === expected; }
function state(level: ProtectionState["state"], version: number, policy: SafetyPolicy, issuedAt = at): ProtectionState {
  return { version, environment: policy.environment, scope: "gameplay", state: level, reason: "FIXTURE_INCIDENT", issuedAt, validUntil: policy.cycle.endsAt, drainUntil: level === "DRAINING" ? issuedAt + 500 : null, operator: "fixture-admin", incidentId: level === "NORMAL" ? null : "fixture-incident" };
}

test("COST-01 missing production budget is UNSPECIFIED; fixture values and TURN cannot silently become production", () => {
  const production = JSON.parse(readFileSync("configs/safety.production.json", "utf8"));
  assert.equal(resolveSafetyPolicy(production, "production").status, "UNSPECIFIED");
  assert.throws(() => requirePolicy(resolveSafetyPolicy(production, "production")), (error: unknown) => error instanceof PolicyError && error.code === "POLICY_REQUIRED");
  assert.throws(() => resolveSafetyPolicy(source, "production"), PolicyError);
  const paid = structuredClone(source); paid.values["mode"] = "paid";
  assert.equal(resolveSafetyPolicy(paid, "fixture").status, "UNSPECIFIED");
  assert.throws(() => fixture(candidate => { candidate.values["services"].turn = "enabled"; }), PolicyError);
  assert.throws(() => assertPaidServiceEnabled(fixture(), "turn"), code("POLICY_REQUIRED"));
});

test("COST-02 final pool capacity, idempotent retry and business assignment share real SQLite transaction", async () => {
  const policy = fixture(candidate => { candidate.values["global"].maxActiveRooms = 1; candidate.values["pools"][0].maxActiveRooms = 1; });
  const { database, store, limits } = setup(policy);
  database.sql.exec("CREATE TABLE assignments (id TEXT PRIMARY KEY)");
  const outcomes = await Promise.allSettled(["assignment-a", "assignment-b"].map(assignmentId => Promise.resolve().then(() => limits.reserveAssignment({ assignmentId, poolId: "connect-four-v1", now: at, activityMs: 0 }, () => { database.sql.exec("INSERT INTO assignments(id) VALUES (?)", assignmentId); }))));
  assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(database.sql.exec("SELECT id FROM assignments").toArray().length, 1);
  assert.equal(limits.reserveAssignment({ assignmentId: "assignment-a", poolId: "connect-four-v1", now: at, activityMs: 0 }).duplicate, true);
  assert.equal(limits.usage("connect-four-v1")?.cycleCreates, 1);
  limits.releaseAssignment({ assignmentId: "assignment-a", terminal: "CLOSED", now: at + 1 });
  assert.throws(() => limits.reserveAssignment({ assignmentId: "rollback", poolId: "connect-four-v1", now: at, activityMs: 0 }, () => { throw new Error("business insert failed"); }));
  assert.equal(store.get("assignment:rollback"), undefined);
  assert.equal(limits.usage("connect-four-v1")?.active, 0);
});

test("COST-03 pool copies and aggregate shares are rejected; config reload does not reset counts", () => {
  assert.throws(() => fixture(candidate => { candidate.values["pools"].push(structuredClone(candidate.values["pools"][0])); }), PolicyError);
  const { limits } = setup();
  assert.throws(() => limits.reserveAssignment({ assignmentId: "a", poolId: "unapproved-copy", now: at, activityMs: 0 }), code("SAFETY_LIMIT"));
});

test("COST-04 rotating and releasing rooms never refunds daily or cycle creation quotas", () => {
  const policy = fixture(candidate => { for (const q of [candidate.values["global"], candidate.values["pools"][0]]) Object.assign(q, { maxCreatesPerMinute: 1, maxCreatesPerDay: 2, maxCreatesPerCycle: 2 }); });
  const { limits } = setup(policy);
  for (let index = 0; index < 2; index += 1) {
    limits.reserveAssignment({ assignmentId: `a-${index}`, poolId: "connect-four-v1", now: at + index * 60_000, activityMs: 0 });
    assert.equal(limits.releaseAssignment({ assignmentId: `a-${index}`, terminal: "CLOSED", now: at + index * 60_000 + 1 }), true);
    assert.equal(limits.releaseAssignment({ assignmentId: `a-${index}`, terminal: "CLOSED", now: at + index * 60_000 + 2 }), false);
  }
  assert.throws(() => limits.reserveAssignment({ assignmentId: "next-day", poolId: "connect-four-v1", now: at + 86_400_000, activityMs: 0 }), code("SAFETY_LIMIT"));
  assert.equal(limits.usage("connect-four-v1")?.active, 0);
});

test("COST-05 SQLite reconstruction preserves pool capacity, cumulative quota and incident lock", () => {
  const { database, limits, policy } = setup();
  limits.reserveAssignment({ assignmentId: "active", poolId: "connect-four-v1", now: at, activityMs: 0 });
  limits.applyProtection(state("BLOCKED", 3, policy));
  const reloaded = new SafetyLimits(policy, new SqlSafetyStore(database));
  assert.equal(reloaded.usage("connect-four-v1")?.active, 1);
  assert.equal(reloaded.usage("connect-four-v1")?.cycleCreates, 1);
  assert.throws(() => reloaded.reserveAssignment({ assignmentId: "new", poolId: "connect-four-v1", now: at, activityMs: 0 }), code("SAFETY_BLOCKED"));
});

test("COST-06 finite activity allowance cannot be restarted by reconnect, message or Room reconstruction", () => {
  const policy = fixture(candidate => { candidate.values["global"].maxActivityMsPerCycle = 1000; });
  const { store } = setup(policy);
  const room = new RoomSafety(policy, store, "room-a"); room.initialize({ now: at, activityMs: 500 });
  room.admitMessage({ connectionId: "first", bytes: 10, fanout: 1, queuedBytes: 0, now: at + 1 });
  const reloaded = new RoomSafety(policy, store, "room-a"); reloaded.initialize({ now: at + 400, activityMs: 1000 });
  assert.equal(reloaded.nextDeadline(at + 400), at + 500);
  assert.throws(() => reloaded.admitMessage({ connectionId: "reconnect", bytes: 10, fanout: 1, queuedBytes: 0, now: at + 501 }), code("SAFETY_EXPIRED"));
});

test("COST-08 room limits cover oversized messages, fanout, queues, per-second rate and reconnect totals", () => {
  const policy = fixture(candidate => { Object.assign(candidate.values["room"], { messagesPerSecond: 1, maxTotalMessages: 2 }); });
  const { store } = setup(policy); const room = new RoomSafety(policy, store, "room"); room.initialize({ now: at, activityMs: 0 });
  const message = { connectionId: "first", bytes: 10, fanout: 1, queuedBytes: 0, now: at };
  assert.throws(() => room.admitMessage({ ...message, bytes: policy.room.maxMessageBytes + 1 }), code("SAFETY_LIMIT"));
  assert.throws(() => room.admitMessage({ ...message, fanout: policy.room.maxBroadcastFanout + 1 }), code("SAFETY_LIMIT"));
  assert.throws(() => room.admitMessage({ ...message, queuedBytes: policy.room.maxQueuedBytes + 1 }), code("SAFETY_LIMIT"));
  room.admitMessage(message);
  assert.throws(() => room.admitMessage(message), code("SAFETY_LIMIT"));
  room.admitMessage({ ...message, connectionId: "second" });
  assert.throws(() => room.admitMessage({ ...message, connectionId: "third", now: at + 1000 }), code("SAFETY_LIMIT"));
});

test("COST-09 actual D1 rows scanned exceed result count; missing usage metadata is unknown", () => {
  const policy = fixture();
  assertD1Usage(policy, { rows_read: 1, rows_written: 0 }, 1);
  assert.throws(() => assertD1Usage(policy, { rows_read: 100, rows_written: 0 }, 1), code("SAFETY_LIMIT"));
  assert.throws(() => assertD1Usage(policy, {}, 1), code("SAFETY_INVALID"));
});

test("COST-10 pre-upload object/write/storage bounds and pre-read durable R2 quota", () => {
  const policy = fixture(candidate => { candidate.values["data"].maxR2ReadsPerCycle = 2; });
  assertPublication(policy, [{ bytes: 100 }], { cycleWrites: 0, storedBytes: 0 });
  assert.throws(() => assertPublication(policy, [{ bytes: policy.data.maxR2ObjectBytes + 1 }], { cycleWrites: 0, storedBytes: 0 }), code("SAFETY_LIMIT"));
  assert.throws(() => assertPublication(policy, [{ bytes: 100 }], { cycleWrites: policy.data.maxR2WritesPerCycle, storedBytes: 0 }), code("SAFETY_LIMIT"));
  assert.throws(() => assertPublication(policy, [{ bytes: 100 }], { cycleWrites: 0, storedBytes: policy.data.maxR2StoredBytes }), code("SAFETY_LIMIT"));
  const { database, limits } = setup(policy);
  assert.equal(limits.consumeR2Read(at), 1);
  // A failed get does not refund the already admitted operation.
  assert.equal(new SafetyLimits(policy, new SqlSafetyStore(database)).consumeR2Read(at), 2);
  assert.throws(() => limits.consumeR2Read(at), code("SAFETY_LIMIT"));
});

test("COST-13/15 Room protection expires and cleanup is finite without any keepalive timer", () => {
  const { store, policy } = setup(); const room = new RoomSafety(policy, store, "room"); room.initialize({ now: at, activityMs: 0 });
  assert.equal(room.nextDeadline(at), at + policy.room.maxLifetimeMs);
  assert.throws(() => room.assertCanRun(at + policy.room.maxLifetimeMs), code("SAFETY_EXPIRED"));
  for (let index = 0; index < policy.room.maxCleanupOperations; index += 1) room.consumeCleanupOperation();
  assert.throws(() => room.consumeCleanupOperation(), code("SAFETY_LIMIT"));
});

test("COST-16/20 disorder, old config and cycle rollover do not automatically unlock protection", () => {
  const { policy, store, limits } = setup();
  assert.equal(limits.applyProtection(state("BLOCKED", 4, policy)), true);
  assert.equal(limits.applyProtection(state("NORMAL", 2, policy)), false);
  assert.throws(() => limits.applyProtection(state("NORMAL", 5, policy)), code("RECOVERY_REQUIRED"));
  assert.throws(() => limits.recoverProtection(state("NORMAL", 5, policy), { authenticated: false, actor: "fixture-admin", reason: "fixed", configurationVersion: "v2", validationRecord: "evidence" }), code("RECOVERY_REQUIRED"));
  assert.equal(limits.recoverProtection(state("NORMAL", 5, policy), { authenticated: true, actor: "fixture-admin", reason: "fixed", configurationVersion: "v2", validationRecord: "evidence" }), true);
  assert.ok(store.get("recovery:5"));
  limits.applyProtection(state("BLOCKED", 6, policy));
  const nextCycle = { ...policy, cycle: { id: "next", startsAt: policy.cycle.endsAt, endsAt: policy.cycle.endsAt + 100_000 } };
  assert.throws(() => new SafetyLimits(nextCycle, store).applyProtection(state("NORMAL", 7, nextCycle, nextCycle.cycle.startsAt)), code("RECOVERY_REQUIRED"));
});

test("COST-17/19 one failed stop/notification never prevents closing rooms and stopping tasks", async () => {
  const performed: string[] = [];
  const receipts = await runStopActions([
    { name: "persist-protection", stop: async () => { throw new Error("database not writable"); } },
    { name: "close-rooms", stop: async () => { performed.push("rooms"); }, observeStopped: async () => true },
    { name: "stop-background", stop: async () => { performed.push("tasks"); } },
    { name: "notify", stop: async () => { throw new Error("notification unavailable"); } },
  ], 1000);
  assert.deepEqual(performed.sort(), ["rooms", "tasks"]);
  assert.equal(receipts.find(item => item.action === "close-rooms")?.status, "OBSERVED_STOPPED");
  assert.equal(receipts.find(item => item.action === "stop-background")?.status, "ACKNOWLEDGED");
  assert.equal(receipts.filter(item => item.status === "FAILED").length, 2);
});

test("COST-18 inventory catches alternate entry gaps and a recovery route inside blocked prefixes", () => {
  const entries = [
    { id: "main", kind: "public-http" as const, enabled: true, address: "https://playwithanyone.com/", protection: "APPLICATION" as const },
    { id: "ops", kind: "management" as const, enabled: true, address: "https://playwithanyone.com/api/ops/safety", protection: "APPLICATION" as const },
  ];
  assertEntryInventory(entries, ["https://playwithanyone.com"], "/api/ops/", ["/api/match/", "/api/rooms/"]);
  assert.throws(() => assertEntryInventory(entries, ["https://alternate.workers.dev"], "/api/ops/", ["/api/rooms/"]), code("SAFETY_INVALID"));
  assert.throws(() => assertEntryInventory(entries, ["https://playwithanyone.com"], "/api/ops/", ["/api/"]), code("SAFETY_INVALID"));
});

test("COST-20 management stop and recovery use distinct server-only credentials", async () => {
  const secrets = { stopToken: "fixture-stop-".repeat(4), recoveryToken: "fixture-recovery-".repeat(4) };
  const request = new Request("https://playwithanyone.com/api/ops/safety", { method: "POST", headers: { Authorization: `Bearer ${secrets.stopToken}` } });
  assert.equal(await authorizeSafetyManagement(request, "stop", secrets), true);
  assert.equal(await authorizeSafetyManagement(request, "recover", secrets), false);
  assert.equal(await authorizeSafetyManagement(request, "stop", {}), false);
});

test("COST-22 component stop retains business rows while only recording protection", async () => {
  const { database, limits, policy } = setup(); database.sql.exec("CREATE TABLE business_data(id TEXT PRIMARY KEY)"); database.sql.exec("INSERT INTO business_data(id) VALUES ('retained')");
  await runStopActions([{ name: "persist-protection", stop: async () => { limits.applyProtection(state("BLOCKED", 1, policy)); } }], 1000);
  assert.equal(database.sql.exec("SELECT id FROM business_data").toArray()[0]?.["id"], "retained");
});

test("COST-18/20 management authentication precedes owner lookup; recovery authorization is server derived", async () => {
  const secrets = { SAFETY_STOP_TOKEN: "fixture-stop-key-".repeat(4), SAFETY_RECOVERY_TOKEN: "fixture-recovery-key-".repeat(4) };
  let lookups = 0, controlReads = 0; const forwarded: { path: string; body: Record<string, unknown> }[] = [];
  const managementStatement: SqlStatement = { bind() { return this; }, first: async <T>() => null as T | null, all: async <T>() => ({ results: [] as T[], success: true }), run: async () => ({ success: true }) };
  const env: Env & typeof secrets = { ...secrets, APP_ENV: "fixture", WORKER_ROLE: "shell", SHELL_ORIGIN: "https://playwithanyone.com", GAME_ORIGINS: "", ASSET_ORIGINS: "", SESSION_TTL_SECONDS: "3600", SAFETY_POLICY_JSON: JSON.stringify(source), ASSETS: { fetch: async () => new Response() }, DB: { prepare: () => { controlReads += 1; return managementStatement; }, batch: async () => [] }, MATCH_POOL: { idFromName(name) { assert.equal(name, "connect-four-v1"); lookups += 1; return name; }, get: () => ({ fetch: async request => { forwarded.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> }); return Response.json({ version: 2, state: "NORMAL" }); } }) } };
  const request = (token: string | undefined, body: unknown) => new Request("https://playwithanyone.com/api/ops/safety", { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  await assert.rejects(() => safetyManagementRoute(request(undefined, { operation: "status" }), env), (error: unknown) => error instanceof ApiError && error.status === 401);
  assert.equal(lookups, 0);
  assert.equal(controlReads, 0);
  await assert.rejects(() => safetyManagementRoute(request(secrets.SAFETY_STOP_TOKEN, { operation: "status", pool: "arbitrary" }), env), ApiError);
  assert.equal(lookups, 0);
  const record = { actor: "fixture-admin", reason: "validated repair", configurationVersion: "preview-v1", validationRecord: "fixture-evidence" };
  const recover = { operation: "recover", protection: state("NORMAL", 2, fixture()), record };
  await assert.rejects(() => safetyManagementRoute(request(secrets.SAFETY_STOP_TOKEN, recover), env), (error: unknown) => error instanceof ApiError && error.status === 401);
  await assert.rejects(() => safetyManagementRoute(request(secrets.SAFETY_RECOVERY_TOKEN, { ...recover, record: { ...record, authenticated: true } }), env), ApiError);
  const response = await safetyManagementRoute(request(secrets.SAFETY_RECOVERY_TOKEN, recover), env);
  assert.equal(response?.status, 200); assert.equal(response?.headers.get("Cache-Control"), "no-store");
  assert.equal(forwarded[0]?.path, "/safety/recover");
  assert.equal((forwarded[0]?.body["authorization"] as Record<string, unknown>)["authenticated"], true);
});
