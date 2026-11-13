import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { requirePolicy } from "../../protocol/src/policy.js";
import { SafetyLimits, SqlSafetyStore, resolveSafetyPolicy, type SafetyPolicy } from "../../../apps/edge/src/safety/index.js";
import { MatchPoolDO } from "../../../apps/edge/src/gameplay/pool.js";
import { POOL_ID, type DoState, type DoStorage, type GameplayEnv, type Principal, type ServerSocket, type SqlCursor, type SqlValue } from "../../../apps/edge/src/gameplay/types.js";

const source = JSON.parse(readFileSync("configs/safety.dev.json", "utf8")) as { policyId: string; version: number; values: Record<string, any> };
function binding(change?: (values: Record<string, any>) => void) {
  const candidate = structuredClone(source); candidate.values.cycle = { id: "pool-budget-fixture", startsAt: Date.now() - 60_000, endsAt: Date.now() + 86_400_000 };
  change?.(candidate.values); return candidate;
}
function policy(change?: (values: Record<string, any>) => void): SafetyPolicy { return requirePolicy(resolveSafetyPolicy(binding(change), "fixture")).value; }
class Storage implements DoStorage {
  readonly db = new DatabaseSync(":memory:"); alarm: number | null = null; depth = 0;
  readonly sql = { exec: <T = Record<string, unknown>>(query: string, ...values: SqlValue[]): SqlCursor<T> => {
    const args = values.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value) as SQLInputValue[];
    const rows = this.db.prepare(query).all(...args) as T[]; return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  transactionSync<T>(action: () => T): T { const name = `transaction_${this.depth++}`; this.db.exec(`SAVEPOINT ${name}`);
    try { const value = action(); this.db.exec(`RELEASE ${name}`); return value; } catch (error) { this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; } finally { this.depth--; }
  }
  async setAlarm(at: number) { this.alarm = at; } async deleteAlarm() { this.alarm = null; }
}
class Socket {
  sent: string[] = []; closed = false; attachment: Record<string, unknown>;
  constructor(attachment: Record<string, unknown>) { this.attachment = structuredClone(attachment); }
  send(value: string) { if (this.closed) throw new Error("closed"); this.sent.push(value); }
  close() { this.closed = true; }
  serializeAttachment(value: Record<string, unknown>) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
}
class State implements DoState {
  readonly storage = new Storage(); readonly sockets: Socket[] = []; readonly pending: Promise<unknown>[] = [];
  acceptWebSocket(socket: ServerSocket) { this.sockets.push(socket as unknown as Socket); }
  getWebSockets() { return this.sockets.filter(item => !item.closed) as unknown as ServerSocket[]; }
  waitUntil(task: Promise<unknown>) { this.pending.push(task); }
}
function poolFixture(change?: (values: Record<string, any>) => void) {
  const state = new State(), configured = binding(change), calls: { kind: string; roomId: string }[] = [], stopped = new Set<string>();
  const env = { APP_ENV: "fixture", WORKER_ROLE: "shell", SHELL_ORIGIN: "https://shell.example", GAME_ORIGINS: "https://game.example", ASSET_ORIGINS: "", SESSION_TTL_SECONDS: "3600", SAFETY_POLICY_JSON: JSON.stringify(configured),
    DB: { prepare() { throw new Error("Unexpected D1 call"); } }, ASSETS: { async fetch() { return new Response("ok"); } },
    ROOMS: { idFromName: (name: string) => name, get: (id: unknown) => ({ fetch: async (request: Request) => {
      const body = await request.json() as { op: string; protection?: { state: string } }; const roomId = String(id); calls.push({ kind: body.op, roomId });
      if (body.op === "safety-apply" && body.protection?.state === "BLOCKED") { stopped.add(roomId); state.storage.sql.exec("UPDATE assignments SET state='CLOSED' WHERE room_id=?", roomId); }
      return new Response(JSON.stringify({ stopped: stopped.has(roomId), activeConnections: stopped.has(roomId) ? 0 : 2, backgroundTasks: stopped.has(roomId) ? 0 : 1, unfinishedCleanup: false }));
    } }) } } as unknown as GameplayEnv;
  const pool = new MatchPoolDO(state, env);
  const invoke = async (path: string, body: unknown) => { const response = await pool.fetch(new Request(`https://pool.internal${path}`, { method: "POST", body: JSON.stringify(body) })); return { status: response.status, body: await response.json() as Record<string, any> }; };
  function seedRooms(count: number, allStopped = false) { for (let index = 0; index < count; index++) {
    const assignmentId = `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`, roomId = crypto.randomUUID();
    state.storage.sql.exec("INSERT INTO assignments VALUES (?,?,?,?, 'ROOM_INSTALLED',0,NULL)", assignmentId, roomId, crypto.randomUUID(), "{}");
    state.storage.sql.exec("INSERT INTO room_cleanup_registry VALUES (?,?,0)", assignmentId, roomId); if (allStopped) stopped.add(roomId);
  } }
  return { state, pool, calls, invoke, configured, seedRooms };
}

test("execution shares stay explicit; legacy logical aliases retain the original durable accounting key", () => {
  const configured = policy(), storage = new Storage(), store = new SqlSafetyStore(storage), limits = new SafetyLimits(configured, store), now = Date.now();
  limits.reserveAssignment({ assignmentId: "legacy-assignment", poolId: "connect-four-v1", now, activityMs: 0 });
  assert.equal(store.get<{ active: number }>("usage:connect-four-v1")?.active, 1);
  assert.equal(limits.usage("connect-four:casual:global")?.active, 1);
  assert.equal(limits.reserveAssignment({ assignmentId: "legacy-assignment", poolId: "connect-four:casual:global", now, activityMs: 0 }).duplicate, true);
  assert.throws(() => limits.reserveAssignment({ assignmentId: "turn-with-tick-time", poolId: "connect-four-v1", now, activityMs: 1 }), /SAFETY_INVALID/);
  assert.throws(() => policy(values => { values.executionClasses[0].maxActiveRooms = 1; }), /POLICY_INVALID/);
  assert.throws(() => policy(values => { values.executionClasses[2].maxActiveRooms = 1; }), /POLICY_INVALID/);
});

test("realtime room-minutes reserve before admission and refund only a trusted bounded terminal settlement", () => {
  const configured = policy(values => {
    const quota = { maxActiveRooms: 2, maxCreatesPerMinute: 4, maxCreatesPerDay: 8, maxCreatesPerCycle: 16, maxActivityMsPerDay: 120_000, maxActivityMsPerCycle: 180_000 };
    values.global = { ...quota };
    for (const execution of values.executionClasses) Object.assign(execution, { enabled: execution.executionClass === "realtime-tick", maxRoomLifetimeMs: execution.executionClass === "realtime-tick" ? 60_000 : 0 }, execution.executionClass === "realtime-tick" ? quota : Object.fromEntries(Object.keys(quota).map(key => [key, 0])));
    values.pools = [{ poolId: "test:casual:global", accountingKey: "test-realtime", legacyPoolIds: [], executionClass: "realtime-tick", enabled: true, ...quota }];
  });
  const storage = new Storage(), store = new SqlSafetyStore(storage), limits = new SafetyLimits(configured, store), now = Date.now(), poolId = "test:casual:global";
  for (const assignmentId of ["a", "b"]) limits.reserveAssignment({ assignmentId, poolId, now, activityMs: 60_000 });
  assert.equal(limits.roomMinutes(poolId).dayReserved, 2);
  assert.throws(() => limits.reserveAssignment({ assignmentId: "c", poolId, now, activityMs: 60_000 }), /SAFETY_LIMIT/);
  assert.throws(() => limits.releaseAssignment({ assignmentId: "a", terminal: "CLOSED", now: now + 1, settlement: { actualActivityMs: 60_001, finalizationId: "summary-a" } }), /SAFETY_INVALID/);
  limits.releaseAssignment({ assignmentId: "a", terminal: "CLOSED", now: now + 1, settlement: { actualActivityMs: 0, finalizationId: "summary-a" } });
  assert.equal(limits.roomMinutes(poolId).dayReserved, 1);
  assert.equal(limits.releaseAssignment({ assignmentId: "a", terminal: "CLOSED", now: now + 2, settlement: { actualActivityMs: 0, finalizationId: "summary-a" } }), false);
  assert.throws(() => limits.releaseAssignment({ assignmentId: "a", terminal: "CLOSED", now: now + 2, settlement: { actualActivityMs: 1, finalizationId: "different" } }), /SAFETY_INVALID/);
  limits.reserveAssignment({ assignmentId: "c", poolId, now: now + 3, activityMs: 60_000 });
  limits.releaseAssignment({ assignmentId: "b", terminal: "REVOKED", now: now + 4 });
  assert.equal(limits.roomMinutes(poolId).dayReserved, 2, "unconfirmed termination retains its full prepaid budget");
});

test("management scans more than twelve rooms through idempotent bounded pages", async () => {
  const fixture = poolFixture(); fixture.seedRooms(17, true);
  const first = await fixture.invoke("/safety/status", {}); assert.equal(first.status, 200); assert.equal(first.body.observation.complete, false); assert.equal(first.body.rooms.length, 8); assert.equal(first.body.unobservedRooms, 9);
  const nextCursor = first.body.observation.nextCursor;
  const second = await fixture.invoke("/safety/status", { cursor: nextCursor }); assert.equal(second.body.observation.observedRooms, 16); assert.equal(second.body.unobservedRooms, 1);
  const retry = await fixture.invoke("/safety/status", { cursor: nextCursor }); assert.deepEqual(retry.body, second.body);
  const final = await fixture.invoke("/safety/status", { cursor: second.body.observation.nextCursor }); assert.equal(final.body.observation.complete, true); assert.equal(final.body.observation.observedRooms, 17); assert.equal(final.body.unobservedRooms, 0); assert.equal(final.body.roomsObservedStopped, true);
});

test("a safety stop persists progress and closes every room beyond the first page", async () => {
  const fixture = poolFixture(); fixture.seedRooms(17);
  const now = Date.now(), protection = { version: 1, environment: "fixture", scope: "gameplay", state: "BLOCKED", reason: "PAGED_STOP_TEST", issuedAt: now, validUntil: fixture.configured.values.cycle.endsAt, drainUntil: null, operator: "fixture", incidentId: "test" };
  const initial = await fixture.invoke("/safety/apply", { protection }); assert.equal(initial.status, 200); assert.equal(initial.body.propagationPending, true);
  assert.equal(fixture.calls.filter(call => call.kind === "safety-apply").length, 8);
  const store = new SqlSafetyStore(fixture.state.storage);
  for (let attempt = 0; attempt < 10; attempt++) {
    const job = store.get<{ phase: string; nextAt: number | null }>("protection-job:1")!; if (job.phase === "COMPLETE" || job.phase === "FAILED") break;
    store.put("protection-job:1", { ...job, nextAt: Date.now() - 1 }); const before = fixture.calls.filter(call => call.kind === "safety-apply").length;
    await fixture.pool.alarm(); assert.ok(fixture.calls.filter(call => call.kind === "safety-apply").length - before <= 8);
  }
  assert.equal(store.get<{ phase: string }>("protection-job:1")?.phase, "COMPLETE");
  assert.equal(new Set(fixture.calls.filter(call => call.kind === "safety-apply").map(call => call.roomId)).size, 17);
  assert.equal(fixture.state.storage.alarm, null);
});

test("queue sockets push only installed assignments, expire by Alarm and reject client input", async () => {
  const fixture = poolFixture(), now = Date.now(), principal: Principal = { id: crypto.randomUUID(), playerId: crypto.randomUUID(), expiresAt: now + 60_000 }, intentId = `qi:${POOL_ID}:${crypto.randomUUID()}`;
  fixture.state.storage.sql.exec("INSERT INTO queue_intents VALUES (?,?,?,?,?,?, 'QUEUED',1,1,?,?,NULL)", intentId, principal.id, "create", "digest", JSON.stringify(principal), "{}", now, now + 30_000);
  const watcher = new Socket({ kind: "queue", intentId, sessionId: principal.id, expiresAt: now + 30_000 }); fixture.state.sockets.push(watcher);
  const status = { op: "status", principal, intentId };
  assert.equal((await fixture.invoke("/", status)).status, 200); assert.equal(JSON.parse(watcher.sent[0]!).type, "QUEUE_STATE"); assert.equal(watcher.closed, false);
  await fixture.invoke("/", status); assert.equal(watcher.sent.length, 1, "unchanged state is not repeated");
  const assignmentId = crypto.randomUUID(), roomId = crypto.randomUUID();
  fixture.state.storage.sql.exec("INSERT INTO assignments VALUES (?,?,?,?, 'COMMITTED',0,NULL)", assignmentId, roomId, crypto.randomUUID(), "{}");
  fixture.state.storage.sql.exec("UPDATE queue_intents SET state='ASSIGNED',revision=2,assignment_id=? WHERE intent_id=?", assignmentId, intentId);
  // A pending installation is still QUEUED and never exposes the room.
  await fixture.invoke("/", status); assert.equal(JSON.parse(watcher.sent.at(-1)!).body.status, "QUEUED"); assert.equal(watcher.closed, false);
  fixture.state.storage.sql.exec("UPDATE assignments SET state='ROOM_INSTALLED' WHERE assignment_id=?", assignmentId);
  await fixture.invoke("/", status); assert.equal(JSON.parse(watcher.sent.at(-1)!).body.status, "ASSIGNED"); assert.equal(watcher.closed, true);
  const expiredId = `qi:${POOL_ID}:${crypto.randomUUID()}`;
  fixture.state.storage.sql.exec("INSERT INTO queue_intents VALUES (?,?,?,?,?,?, 'QUEUED',1,1,?,?,NULL)", expiredId, principal.id, "expired", "digest", JSON.stringify(principal), "{}", now - 31_000, now - 1);
  const expired = new Socket({ kind: "queue", intentId: expiredId, sessionId: principal.id, expiresAt: now - 1 }); fixture.state.sockets.push(expired);
  await fixture.pool.alarm(); assert.equal(JSON.parse(expired.sent.at(-1)!).body.status, "EXPIRED"); assert.equal(expired.closed, true);
  const inbound = new Socket({ kind: "queue", intentId, sessionId: principal.id, expiresAt: now + 30_000 }); fixture.state.sockets.push(inbound);
  await fixture.pool.webSocketMessage(inbound as unknown as ServerSocket); assert.equal(inbound.closed, true);
});


test("revoking a queued session cancels pending intents and closes its watcher without changing an assigned room", async () => {
  const fixture = poolFixture(), now = Date.now(), sessionId = crypto.randomUUID(), principal = { id: sessionId, playerId: crypto.randomUUID(), expiresAt: now + 60_000 };
  const pendingId = `qi:${POOL_ID}:${crypto.randomUUID()}`, assignedId = `qi:${POOL_ID}:${crypto.randomUUID()}`;
  for (const [id, state] of [[pendingId, "QUEUED"], [assignedId, "ASSIGNED"]]) fixture.state.storage.sql.exec("INSERT INTO queue_intents VALUES (?,?,?,?,?,?, ?,1,1,?,?,NULL)", id!, sessionId, id!, "digest", JSON.stringify(principal), "{}", state!, now, now + 30_000);
  const watcher = new Socket({ kind: "queue", intentId: pendingId, sessionId, expiresAt: now + 30_000 }); fixture.state.sockets.push(watcher);
  const cancelled = await fixture.invoke("/", { op: "revoke-queue-session", sessionId }); assert.equal(cancelled.status, 200); assert.equal(watcher.closed, true); assert.equal(JSON.parse(watcher.sent.at(-1)!).body.status, "CANCELLED");
  const rows = fixture.state.storage.sql.exec<{ intent_id: string; state: string }>("SELECT intent_id,state FROM queue_intents").toArray();
  assert.equal(rows.find(item => item.intent_id === pendingId)?.state, "CANCELLED"); assert.equal(rows.find(item => item.intent_id === assignedId)?.state, "ASSIGNED");
});
