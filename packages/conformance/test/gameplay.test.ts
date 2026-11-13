import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { MatchPoolDO, RoomDO, gameplayRoute } from "../../../apps/edge/src/gameplay/index.js";
import { gameplayPolicy } from "../../../apps/edge/src/gameplay/policy.js";
import { persistResult } from "../../../apps/edge/src/gameplay/results.js";
import { decodeFrame, encodeFrame, Opcode, type BinaryContext } from "../../protocol/src/frame.js";
import type { LinkDescriptor, ControlMessage } from "../../protocol/src/control.js";
import type { BrowserReleaseManifest } from "../../release/src/release.js";
import type { SqlStatement, SqlResult, Database } from "../../../apps/edge/src/env.js";
import { POOL_ID, type DoNamespace, type DoState, type DoStorage, type FixedGame, type GameplayEnv, type InstallAssignment, type Principal, type RoomRecord, type RoomView, type ServerSocket, type SocketAttachment, type SqlCursor, type SqlValue } from "../../../apps/edge/src/gameplay/types.js";
import { applyCommand, create } from "../../../games/connect-four/src/rules.js";
import { D1_SAFETY_SCOPE } from "../../../apps/edge/src/safety/d1.js";

class Storage implements DoStorage {
  readonly db = new DatabaseSync(":memory:");
  alarm: number | null = null;
  depth = 0;
  readonly sql = { exec: <T = Record<string, unknown>>(query: string, ...bindings: SqlValue[]): SqlCursor<T> => {
    const args = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value) as SQLInputValue[];
    const records = this.db.prepare(query).all(...args) as T[];
    return { toArray: () => records, [Symbol.iterator]: () => records[Symbol.iterator]() };
  } };
  transactionSync<T>(fn: () => T): T {
    const savepoint = `nested_${this.depth++}`; this.db.exec(`SAVEPOINT ${savepoint}`);
    try { const result = fn(); this.db.exec(`RELEASE ${savepoint}`); return result; }
    catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}`); this.db.exec(`RELEASE ${savepoint}`); throw error; }
    finally { this.depth -= 1; }
  }
  async setAlarm(time: number): Promise<void> { this.alarm = time; }
  async deleteAlarm(): Promise<void> { this.alarm = null; }
}
class Socket {
  readonly sent: (string | Uint8Array)[] = [];
  closed = false;
  closeReason: string | undefined;
  attachment: SocketAttachment;
  constructor(principal: Principal) { this.attachment = { connectionId: crypto.randomUUID(), principal, openedAt: Date.now(), authenticated: false, bound: false }; }
  send(value: string | Uint8Array): void { if (this.closed) throw new Error("closed"); this.sent.push(typeof value === "string" ? value : value.slice()); }
  close(_code?: number, reason?: string): void { this.closed = true; this.closeReason = reason; }
  serializeAttachment(value: SocketAttachment): void { this.attachment = structuredClone(value); }
  deserializeAttachment(): SocketAttachment { return structuredClone(this.attachment); }
  controls(): ControlMessage[] { return this.sent.filter((value): value is string => typeof value === "string").map(value => JSON.parse(value) as ControlMessage); }
}
class State implements DoState {
  readonly storage = new Storage();
  readonly sockets: Socket[] = [];
  readonly pending: Promise<unknown>[] = [];
  acceptWebSocket(socket: ServerSocket): void { this.sockets.push(socket as unknown as Socket); }
  getWebSockets(): ServerSocket[] { return this.sockets.filter(socket => !socket.closed) as unknown as ServerSocket[]; }
  waitUntil(promise: Promise<unknown>): void { this.pending.push(promise); }
  async settle(): Promise<void> { while (this.pending.length) await Promise.all(this.pending.splice(0)); }
}
class D1 implements Database {
  readonly db = new DatabaseSync(":memory:");
  failAfterFirst = false;
  constructor() {
    this.db.exec(readFileSync("apps/edge/migrations/0001_sessions_and_releases.sql", "utf8"));
    this.db.exec(readFileSync("apps/edge/migrations/0002_gameplay.sql", "utf8"));
    this.db.exec(readFileSync("apps/edge/migrations/0003_safety_usage.sql", "utf8"));
  }
  prepare(query: string): SqlStatement {
    let bindings: (string | number | null)[] = [];
    const execute = (): unknown[] => this.db.prepare(query).all(...bindings);
    const statement: SqlStatement & { execute: () => unknown[] } = {
      bind: (...values) => { bindings = values; return statement; },
      first: async <T>() => (execute()[0] ?? null) as T | null,
      all: async <T>() => ({ results: execute() as T[], success: true }),
      run: async () => { execute(); return { success: true }; }, execute,
    };
    return statement;
  }
  async batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]> {
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement, index) => {
        const rows = (statement as SqlStatement & { execute: () => unknown[] }).execute();
        if (index === 0 && this.failAfterFirst) throw new Error("Injected D1 batch failure");
        return { success: true, results: rows };
      });
      this.db.exec("COMMIT"); return results;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
const policy = { policyId: "connect-four-first-playable", version: 1, values: { guestAllowed: true, startCondition: "BOTH_PREPARED", queueWaitMs: 30_000, disconnectGraceMs: 60_000, disconnectOutcome: "ABORT_NO_RESULT" } };
const release = { gameId: "connect-four", gameBuildId: "a".repeat(64), frameOrigin: "https://game.example", entryUrl: "https://game.example/client/index.html", profile: { id: "server-turn", version: 1 } } as unknown as BrowserReleaseManifest;
const game: FixedGame = { release, ...gameplayPolicy(policy) };
function principal(): Principal { return { id: crypto.randomUUID(), playerId: crypto.randomUUID(), expiresAt: Date.now() + 3_600_000 }; }
function setup() {
  const database = new D1(), roomStates = new Map<string, State>(), rooms = new Map<string, RoomDO>(), poolState = new State();
  const safetyFixture = JSON.parse(readFileSync("configs/safety.dev.json", "utf8"));
  safetyFixture.values.environment = "preview";
  safetyFixture.values.cycle = { id: "gameplay-component-fixture", startsAt: Date.now() - 86_400_000, endsAt: Date.now() + 86_400_000 };
  let env: GameplayEnv;
  const roomNamespace: DoNamespace = { idFromName: name => name, get: id => ({ fetch: async request => {
    const key = String(id); if (!rooms.has(key)) { const state = new State(); roomStates.set(key, state); rooms.set(key, new RoomDO(state, env)); }
    return rooms.get(key)!.fetch(request);
  } }) };
  let pool: MatchPoolDO;
  const poolNamespace: DoNamespace = { idFromName: name => name, get: _id => ({ fetch: request => pool.fetch(request) }) };
  env = { DB: database, ASSETS: { fetch: async () => new Response("ok") }, SHELL_ORIGIN: "https://shell.example", GAME_ORIGINS: "https://game.example", ASSET_ORIGINS: "", APP_ENV: "preview", SESSION_TTL_SECONDS: "3600", WORKER_ROLE: "shell", GAMEPLAY_ENABLED: "true", CONNECT_FOUR_BUILD_ID: release.gameBuildId, GAMEPLAY_POLICY_JSON: JSON.stringify(policy),
    SAFETY_POLICY_JSON: JSON.stringify(safetyFixture), ROOM_LEGACY_GRANTS_ENABLED: "true", MATCH_POOL: poolNamespace, ROOMS: roomNamespace };
  pool = new MatchPoolDO(poolState, env);
  function addSession(value: Principal): void { database.db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,NULL)").run(crypto.randomUUID(), value.id, value.playerId, Date.now(), value.expiresAt); }
  async function poolCall(body: unknown) { const response = await pool.fetch(new Request("https://internal/", { method: "POST", body: JSON.stringify(body) })); return { status: response.status, body: await response.json() as Record<string, unknown> }; }
  async function roomCall(roomId: string, body: unknown) { const response = await rooms.get(roomId)!.fetch(new Request("https://internal/", { method: "POST", body: JSON.stringify(body) })); return { status: response.status, body: await response.json() as Record<string, unknown> }; }
  return { env, database, pool, poolState, roomStates, rooms, poolCall, roomCall, addSession };
}
async function installedPair() {
  const world = setup(), red = principal(), yellow = principal(); world.addSession(red); world.addSession(yellow);
  const created = await world.poolCall({ op: "create", principal: red, requestId: "create-1", game });
  assert.equal(created.status, 200); const roomId = created.body["roomId"] as string;
  assert.equal((await world.roomCall(roomId, { op: "join", principal: yellow, requestId: "join-1" })).status, 200);
  return { ...world, red, yellow, roomId, room: world.rooms.get(roomId)!, state: world.roomStates.get(roomId)! };
}
function binaryContext(link: LinkDescriptor): BinaryContext {
  return { descriptorId: link.descriptorId, contextTag: BigInt(`0x${link.contextTag}`), endpoints: [link.endpoints[0].endpointId, link.endpoints[1].endpointId], validFromMs: link.validFromMs, validUntilMs: link.validUntilMs, maxFrameBytes: 16384, maxBulkBytes: 0,
    streams: link.streams.map(stream => ({ ...stream, maxAhead: 0xffff_fffe, ...(stream.kind === "STATE" ? { usesTick: false } : {}) })) };
}
async function connect(world: Awaited<ReturnType<typeof installedPair>>, user: Principal, key: string) {
  const grant = await world.roomCall(world.roomId, { op: "grant", principal: user, requestId: key }); assert.equal(grant.status, 200);
  const socket = new Socket(user); world.state.sockets.push(socket);
  await world.room.webSocketMessage(socket as unknown as ServerSocket, JSON.stringify({ v: 1, type: "AUTH_JOIN", requestId: `auth-${key}`, body: { joinGrant: grant.body["joinGrant"], protocolVersions: [1], profileId: "server-turn", profileVersion: 1 } }));
  const accepted = socket.controls().find(message => message.type === "AUTH_ACCEPTED"); assert.ok(accepted && accepted.type === "AUTH_ACCEPTED");
  const link = accepted.body.descriptors[0]!;
  await world.room.webSocketMessage(socket as unknown as ServerSocket, JSON.stringify({ v: 1, type: "LINK_BIND", requestId: `bind-${key}`, contextTag: link.contextTag, body: { descriptorId: link.descriptorId, contextTag: link.contextTag } }));
  assert.ok(socket.controls().some(message => message.type === "LINK_BOUND"));
  return { socket, link };
}
async function ready(world: Awaited<ReturnType<typeof installedPair>>, user: Principal, socket: Socket, key: string) {
  const current = await world.roomCall(world.roomId, { op: "status", principal: user });
  const view = current.body["room"] as RoomView;
  const attachment = socket.deserializeAttachment();
  return world.roomCall(world.roomId, { op: "ready", principal: user, requestId: key, expectedMatchRevision: view.revision,
    resourcesReady: true, baselineReady: true, prepared: true, baseline: { descriptorId: attachment.descriptorId, stateSeq: attachment.lastSentStateSeq } });
}
function command(link: LinkDescriptor, seq: number, column: number): ArrayBuffer {
  const bytes = encodeFrame({ header: { opcode: Opcode.COMMAND, flags: 0, streamId: 1, contextTag: BigInt(`0x${link.contextTag}`), seq, tick: 0 }, payload: { kind: "COMMAND", data: new TextEncoder().encode(JSON.stringify({ type: "drop", column })) } }, {
    context: binaryContext(link), senderEndpointId: link.endpoints[0].endpointId, receiverEndpointId: link.endpoints[1].endpointId, nowMs: Date.now(), receivePositions: new Map([[1, seq]]),
  }); return Uint8Array.from(bytes).buffer;
}

test("P01: required game policies do not acquire silent defaults", () => {
  assert.throws(() => gameplayPolicy(undefined), /POLICY_REQUIRED/);
  assert.equal(game.policy.queueWaitMs, 30_000); assert.equal(game.policy.disconnectGraceMs, 60_000);
});
test("M01/M02: concurrent queue joins commit one assignment; retry returns the original installed room", async () => {
  const world = setup(), a = principal(), b = principal(); world.addSession(a); world.addSession(b);
  const responses = await Promise.all([world.poolCall({ op: "queue", principal: a, requestId: "a1", game }), world.poolCall({ op: "queue", principal: b, requestId: "b1", game })]);
  assert.ok(responses.every(response => response.status === 200));
  const retry = await world.poolCall({ op: "queue", principal: a, requestId: "a1", game });
  const other = await world.poolCall({ op: "queue", principal: b, requestId: "b1", game });
  assert.equal(retry.body["status"], "ASSIGNED"); assert.equal(retry.body["roomId"], other.body["roomId"]);
  assert.equal(world.poolState.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM assignments").toArray()[0]!.n, 1);
  assert.equal(world.poolState.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM assigned_intents").toArray()[0]!.n, 2);
});
test("M05: a durable close record prevents late installation from resurrecting a match", async () => {
  const world = setup(), state = new State(), room = new RoomDO(state, world.env);
  const assignment: InstallAssignment = { assignmentId: crypto.randomUUID(), roomId: crypto.randomUUID(), matchId: crypto.randomUUID(), game, members: [principal()] };
  const call = (body: unknown) => room.fetch(new Request("https://internal/", { method: "POST", body: JSON.stringify(body) }));
  assert.equal((await call({ op: "close-assignment", assignmentId: assignment.assignmentId })).status, 200);
  assert.equal((await call({ op: "install", assignment })).status, 409);
  assert.equal(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM room_state").toArray()[0]!.n, 0);
});
test("unknown room UUIDs never touch a Durable Object namespace", async () => {
  const world = setup(); let touched = false;
  const env = { ...world.env, ROOMS: { idFromName() { touched = true; throw new Error("must not get stub"); }, get() { throw new Error("must not get stub"); } } };
  await assert.rejects(gameplayRoute(new Request(`https://shell.example/api/play/rooms/${crypto.randomUUID()}/status`), env, principal(), async () => release), /ROOM_NOT_FOUND/);
  assert.equal(touched, false);
});
test("real SQLite room/receipt recovery rejects duplicate payload changes and stale socket authority", async () => {
  const world = await installedPair(), red = await connect(world, world.red, "red-grant"), yellow = await connect(world, world.yellow, "yellow-grant");
  assert.equal((await ready(world, world.red, red.socket, "ready-red")).status, 200);
  assert.equal((await ready(world, world.yellow, yellow.socket, "ready-yellow")).status, 200);
  const move = command(red.link, 0, 0); await world.room.webSocketMessage(red.socket as unknown as ServerSocket, move);
  await world.room.webSocketMessage(red.socket as unknown as ServerSocket, move);
  let current = await world.roomCall(world.roomId, { op: "status", principal: world.red });
  assert.equal((current.body["room"] as RoomView).moves, 1);
  assert.equal(world.state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM command_receipts").toArray()[0]!.n, 1);
  // Reinstantiate authority without copying any runtime object state.
  const recovered = new RoomDO(world.state, world.env);
  await recovered.webSocketMessage(red.socket as unknown as ServerSocket, move);
  assert.equal(red.socket.controls().filter(message => message.type === "ACTION_RECEIPT").at(-1)?.type, "ACTION_RECEIPT");
  await recovered.webSocketMessage(red.socket as unknown as ServerSocket, command(red.link, 0, 1));
  assert.ok(red.socket.controls().some(message => message.type === "PROTOCOL_ERROR" && message.body.code === "IDEMPOTENCY_CONFLICT"));
  const next = await connect(world, world.red, "new-page-grant"); assert.equal(red.socket.closed, true);
  await recovered.webSocketMessage(red.socket as unknown as ServerSocket, command(red.link, 1, 2));
  current = await world.roomCall(world.roomId, { op: "status", principal: world.red }); assert.equal((current.body["room"] as RoomView).moves, 1);
  assert.notEqual(next.link.contextTag, red.link.contextTag);
  const view = JSON.stringify(current.body); assert.ok(!view.includes("grantKey") && !view.includes("joinGrant") && !view.includes(world.red.id));
});
test("D01/D02: real SQLite D1 batch and statistics remain atomic and idempotent", async () => {
  const world = await installedPair();
  const stored = world.state.storage.sql.exec<{ body: string }>("SELECT body FROM room_state").toArray()[0]!;
  const room = JSON.parse(stored.body) as RoomRecord;
  let rules = create();
  for (const [index, column] of [0, 1, 0, 1, 0, 1, 0].entries()) rules = applyCommand(rules, index % 2 === 0 ? "red" : "yellow", { type: "drop", column });
  room.rules = rules; room.phase = "TERMINAL"; room.result = "WIN"; room.stateSeq += 7;
  world.database.failAfterFirst = true;
  await assert.rejects(persistResult(world.env, room), /Injected D1/);
  assert.equal(world.database.db.prepare("SELECT COUNT(*) n FROM game_results").get()!["n"], 0);
  assert.equal(world.database.db.prepare("SELECT COUNT(*) n FROM player_statistics").get()!["n"], 0);
  world.database.failAfterFirst = false;
  for (let n = 0; n < 10; n++) await persistResult(world.env, room);
  assert.equal(world.database.db.prepare("SELECT COUNT(*) n FROM game_results").get()!["n"], 1);
  assert.equal(world.database.db.prepare("SELECT matches FROM player_statistics WHERE player_id=?").get(world.red.playerId)!["matches"], 1);
  await assert.rejects(persistResult(world.env, { ...room, result: "DRAW" }), /RESULT_CONFLICT/);
});
test("disconnect deadlines survive reconstruction and repeated Alarms do not invent a winner", async () => {
  const world = await installedPair(), red = await connect(world, world.red, "red-grant"), yellow = await connect(world, world.yellow, "yellow-grant");
  await ready(world, world.red, red.socket, "rr"); await ready(world, world.yellow, yellow.socket, "ry");
  await world.room.webSocketClose(red.socket as unknown as ServerSocket);
  const stored = world.state.storage.sql.exec<{ body: string }>("SELECT body FROM room_state").toArray()[0]!;
  const room = JSON.parse(stored.body) as RoomRecord;
  assert.ok(room.members[0]!.disconnectedUntil! >= Date.now() + 59_000);
  room.members[0]!.disconnectedUntil = Date.now() - 1;
  world.state.storage.sql.exec("UPDATE room_state SET body=?", JSON.stringify(room));
  const recovered = new RoomDO(world.state, world.env); await recovered.alarm(); await recovered.alarm();
  const response = await recovered.fetch(new Request("https://internal/", { method: "POST", body: JSON.stringify({ op: "status", principal: world.yellow }) }));
  const final = (await response.json() as { room: RoomView }).room;
  assert.equal(final.phase, "TERMINAL"); assert.equal(final.result, "DISCONNECTED"); assert.equal(final.winner, null);
  assert.equal(world.database.db.prepare("SELECT COUNT(*) n FROM player_statistics").get()!["n"], 0);
});
test("a complete 42-move game stays within the conservative outbound budget and commits a draw once", async t => {
  const world = await installedPair(), red = await connect(world, world.red, "red-grant"), yellow = await connect(world, world.yellow, "yellow-grant");
  await ready(world, world.red, red.socket, "rr"); await ready(world, world.yellow, yellow.socket, "ry");
  const columns = [2,0,0,0,0,0,0,1,1,1,1,1,1,2,2,2,2,2,3,3,3,3,3,3,6,4,4,4,4,4,4,5,5,5,5,5,5,6,6,6,6,6];
  for (const [index, column] of columns.entries()) {
    const player = index % 2 === 0 ? red : yellow;
    await world.room.webSocketMessage(player.socket as unknown as ServerSocket, command(player.link, Math.floor(index / 2), column));
  }
  const response = await world.roomCall(world.roomId, { op: "status", principal: world.red });
  const final = response.body["room"] as RoomView;
  assert.equal(final.moves, 42); assert.equal(final.phase, "TERMINAL"); assert.equal(final.result, "DRAW");
  assert.equal(world.database.db.prepare("SELECT COUNT(*) n FROM game_results").get()!["n"], 1);
  assert.equal(red.socket.closeReason, "MATCH_TERMINAL"); assert.equal(yellow.socket.closeReason, "MATCH_TERMINAL");
  for (const player of [red, yellow]) {
    const bytes = player.socket.deserializeAttachment().outboundBytes!;
    assert.ok(bytes < 131072); t.diagnostic(`${player.link.endpoints[0].seatId} outbound cumulative bytes: ${bytes} / 131072`);
  }
});
test("persistent safety stop closes existing sockets, blocks queue writes and retains game data", async () => {
  const world = await installedPair(), red = await connect(world, world.red, "red-grant"), yellow = await connect(world, world.yellow, "yellow-grant");
  await ready(world, world.red, red.socket, "rr"); await ready(world, world.yellow, yellow.socket, "ry");
  const configured = JSON.parse(world.env.SAFETY_POLICY_JSON!) as { values: { cycle: { endsAt: number } } };
  const protection = { version: 1, environment: "preview", scope: "gameplay", state: "BLOCKED", reason: "COMPONENT_STOP_TEST", issuedAt: Date.now(), validUntil: configured.values.cycle.endsAt, drainUntil: null, operator: "component-test", incidentId: "test-incident" };
  const response = await world.pool.fetch(new Request("https://pool.internal/safety/apply", { method: "POST", body: JSON.stringify({ protection }) }));
  assert.equal(response.status, 200); const status = await response.json() as { newAllocationsBlocked: boolean; activeConnections: number; backgroundTasks: number };
  assert.equal(status.newAllocationsBlocked, true); assert.equal(status.activeConnections, 0); assert.equal(status.backgroundTasks, 0);
  assert.equal(red.socket.closed, true); assert.equal(yellow.socket.closed, true);
  const before = world.poolState.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM queue_intents").toArray()[0]!.n;
  const denied = await world.poolCall({ op: "queue", principal: principal(), requestId: "blocked-queue", game });
  assert.equal(denied.status, 503);
  assert.equal(world.poolState.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM queue_intents").toArray()[0]!.n, before);
  assert.equal(world.state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM room_state").toArray()[0]!.n, 1);
  const recovered = new MatchPoolDO(world.poolState, world.env);
  const observed = await recovered.fetch(new Request("https://pool.internal/safety/status", { method: "POST", body: "{}" }));
  assert.equal((await observed.json() as { state: string }).state, "BLOCKED");
});
test("D1 incident bridge closes old sockets once and a delayed incident cannot undo manual recovery", async () => {
  const world = await installedPair(), red = await connect(world, world.red, "red-grant"), yellow = await connect(world, world.yellow, "yellow-grant");
  await ready(world, world.red, red.socket, "rr"); await ready(world, world.yellow, yellow.socket, "ry");
  world.database.db.prepare(`INSERT INTO safety_d1_usage(scope,utc_day,reads_reserved,writes_reserved,reads_limit,writes_limit,blocked,lock_reason,updated_at)
    VALUES(?,?,0,0,100000,100000,1,'TEST_INCIDENT',?)`).run(D1_SAFETY_SCOPE, Math.floor(Date.now() / 86400000), Date.now());
  const incidentEvent = { reason: "D1_SAFETY_INCIDENT", category: "DAILY_QUOTA", scope: D1_SAFETY_SCOPE, persisted: true, detectedAt: Date.now(), recoveryVersion: 0 };
  const incident = () => world.pool.fetch(new Request("https://pool.internal/safety/incident", { method: "POST", body: JSON.stringify({ reason: "D1_SAFETY_INCIDENT", incident: incidentEvent }) }));
  const first = await incident(); assert.equal(first.status, 200);
  const initial = await first.json() as { version: number; state: string }; assert.equal(initial.state, "BLOCKED");
  await world.poolState.settle(); assert.equal(red.socket.closed, true); assert.equal(yellow.socket.closed, true);
  const repeated = await incident(); assert.equal((await repeated.json() as { version: number }).version, initial.version);
  await world.poolState.settle();
  assert.equal(world.poolState.storage.sql.exec<{ attempts: number }>("SELECT attempts FROM d1_incident_propagation").toArray()[0]!.attempts, 1);
  const version = initial.version + 1;
  world.database.db.prepare(`UPDATE safety_d1_usage SET blocked=0,recovery_version=?,recovery_actor='operator',recovery_reason='checked',recovery_configuration='config-1',recovery_validation='evidence-1' WHERE scope=?`).run(version, D1_SAFETY_SCOPE);
  const configured = JSON.parse(world.env.SAFETY_POLICY_JSON!) as { values: { cycle: { endsAt: number } } };
  const recovery = await world.pool.fetch(new Request("https://pool.internal/safety/recover", { method: "POST", body: JSON.stringify({
    protection: { version, environment: "preview", scope: "gameplay", state: "NORMAL", reason: "CHECKED", issuedAt: Date.now(), validUntil: configured.values.cycle.endsAt, drainUntil: null, operator: "operator", incidentId: null },
    authorization: { authenticated: true, actor: "operator", reason: "checked", configurationVersion: "config-1", validationRecord: "evidence-1" },
  }) }));
  assert.equal(recovery.status, 200);
  // Simulate an older in-flight observation persisting after recovery. Its
  // overdue Alarm must never become a millisecond rescheduling loop.
  world.poolState.storage.sql.exec("UPDATE d1_incident_propagation SET attempts=0,complete=0,next_retry_at=? WHERE version=?", Date.now() - 1, initial.version);
  await world.pool.alarm(); assert.equal(world.poolState.storage.alarm, null);
  const delayed = await incident(), delayedBody = await delayed.json() as { ignored: boolean; state: string; version: number };
  assert.equal(delayedBody.ignored, true); assert.equal(delayedBody.state, "NORMAL"); assert.equal(delayedBody.version, version);
  const unconfirmed = await world.pool.fetch(new Request("https://pool.internal/safety/incident", { method: "POST", body: JSON.stringify({
    reason: "D1_SAFETY_INCIDENT", incident: { ...incidentEvent, category: "USAGE_UNKNOWN", recoveryVersion: null, persisted: false },
  }) }));
  const unknown = await unconfirmed.json() as { state: string; version: number; incidentConfirmation: string };
  assert.equal(unknown.state, "BLOCKED"); assert.equal(unknown.version, version + 1);
  assert.equal(unknown.incidentConfirmation, "UNCONFIRMED_FAIL_CLOSED"); await world.poolState.settle();
  await world.pool.alarm(); assert.equal(world.poolState.storage.alarm, null);
});
test("unknown D1 incident fails closed and unobserved propagation has a persistent three-attempt bound", async () => {
  const world = await installedPair(), red = await connect(world, world.red, "red-grant"), yellow = await connect(world, world.yellow, "yellow-grant");
  await ready(world, world.red, red.socket, "rr"); await ready(world, world.yellow, yellow.socket, "ry");
  world.database.db.close();
  const result = await world.pool.fetch(new Request("https://pool.internal/safety/incident", { method: "POST", body: JSON.stringify({ reason: "D1_SAFETY_INCIDENT" }) }));
  const accepted = await result.json() as { state: string; dataState: string };
  assert.equal(accepted.state, "BLOCKED"); assert.equal(accepted.dataState, "UNKNOWN");
  await world.poolState.settle(); assert.equal(red.socket.closed, true); assert.equal(yellow.socket.closed, true);
  for (let retry = 0; retry < 2; retry++) {
    world.poolState.storage.sql.exec("UPDATE d1_incident_propagation SET next_retry_at=? WHERE complete=0", Date.now() - 1);
    await world.pool.alarm();
  }
  const persisted = world.poolState.storage.sql.exec<{ attempts: number; complete: number; next_retry_at: number | null }>("SELECT attempts,complete,next_retry_at FROM d1_incident_propagation").toArray()[0]!;
  assert.equal(persisted.attempts, 3); assert.equal(persisted.complete, 0); assert.equal(persisted.next_retry_at, null);
  assert.equal(world.state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM room_state").toArray()[0]!.n, 1);
});
