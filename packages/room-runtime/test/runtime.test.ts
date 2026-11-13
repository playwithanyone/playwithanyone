import test from "node:test";
import assert from "node:assert/strict";
import { RoomRuntimeCore, type CheckpointPort, type RoomFinalReport, type RoomRuntimeOptions, type RuntimeConnectionMeta, type RuntimePrincipal, type RuntimeRoomRecord, type TransportPort } from "../src/index.js";
import * as four from "../../../games/connect-four/src/rules.js";
import { decodeFrame, encodeFrame, FULL_STATE, Opcode, type BinaryContext } from "../../protocol/src/frame.js";
import { parseControl, type ControlMessage, type LinkDescriptor } from "../../protocol/src/control.js";

class MemoryTransport implements TransportPort {
  readonly meta = new Map<string, RuntimeConnectionMeta>();
  readonly sent = new Map<string, { bytes: Uint8Array; format: "text" | "binary" }[]>();
  readonly closed = new Map<string, { code: number; reason: string }>();
  listConnections(): readonly string[] { return [...this.meta.keys()].filter(id => !this.closed.has(id)); }
  send(id: string, bytes: Uint8Array, format: "text" | "binary" = "binary"): void {
    if (this.closed.has(id)) throw new Error("CONNECTION_CLOSED");
    const messages = this.sent.get(id) ?? []; messages.push({ bytes: bytes.slice(), format }); this.sent.set(id, messages);
  }
  broadcast(bytes: Uint8Array, exclude?: string, format: "text" | "binary" = "binary"): void { for (const id of this.listConnections()) if (id !== exclude) this.send(id, bytes, format); }
  close(id: string, code: number, reason: string): void { this.closed.set(id, { code, reason }); }
  setConnMeta(id: string, meta: RuntimeConnectionMeta): void { this.meta.set(id, structuredClone(meta)); }
  getConnMeta(id: string): RuntimeConnectionMeta | undefined { const value = this.meta.get(id); return value ? structuredClone(value) : undefined; }
  controls(id: string): ControlMessage[] { return (this.sent.get(id) ?? []).filter(item => item.format === "text").map(item => parseControl(new TextDecoder().decode(item.bytes), { channel: "platform" })); }
}
function world(overrides: Partial<RoomRuntimeOptions> = {}) {
  let now = 1_800_000_000_000, snapshot: RuntimeRoomRecord<four.FourState> | undefined, deadline: number | null = null, saves = 0, failSave = false;
  const transport = new MemoryTransport(), results = new Map<string, RoomFinalReport<four.FourState>>();
  const checkpoint: CheckpointPort<four.FourState> = {
    loadSnapshot: () => snapshot ? structuredClone(snapshot) : undefined,
    saveSnapshot: value => { if (failSave) throw new Error("CHECKPOINT_WRITE_FAILED"); saves++; snapshot = structuredClone(value); },
    clear: () => { snapshot = undefined; },
    transaction: callback => { const previous = snapshot ? structuredClone(snapshot) : undefined; try { return callback(); } catch (error) { snapshot = previous; throw error; } },
  };
  const options: RoomRuntimeOptions = { executionClass: "hibernated-turn", turnTimeoutMs: 90000, maxLifetimeMs: 1800000,
    cleanupGraceMs: 3000, maxSnapshotBytes: 1048576, maxReceipts: 512, clock: () => now, ...overrides };
  let tickCalls = 0, wakeCalls = 0;
  const ports = { transport, checkpoint, scheduler: {
    setWakeupDeadline: (time: number) => { deadline = time; wakeCalls++; }, clearWakeupDeadline: () => { deadline = null; },
    startTickLoop: () => { tickCalls++; throw new Error("TURN_ROOM_CANNOT_TICK"); }, stopTickLoop: () => { tickCalls++; },
  }, rules: { loadServerRules: (hash: string, game: string) => {
    assert.equal(hash, "a".repeat(64)); assert.equal(game, "connect-four");
    return { create: four.create, parseCommand: four.parseCommand, applyCommand: (state: four.FourState, seat: four.Seat, command: unknown) => four.applyCommand(state, seat, four.parseCommand(command)),
      project: (state: four.FourState, seat: four.Seat | null) => ({ ...four.project(state, seat) }), evaluateResult: four.evaluateResult };
  } }, results: { finalizeRoom: async (summary: RoomFinalReport<four.FourState>) => { const previous = results.get(summary.matchId); if (previous) assert.deepEqual(summary.snapshot.rules, previous.snapshot.rules); else results.set(summary.matchId, summary); } } };
  const core = new RoomRuntimeCore(ports, options);
  const principal = (): RuntimePrincipal => ({ id: crypto.randomUUID(), playerId: crypto.randomUUID(), expiresAt: now + 3600000 });
  const red = principal(), yellow = principal();
  const assignment = { roomId: crypto.randomUUID(), matchId: crypto.randomUUID(), assignmentId: crypto.randomUUID(),
    game: { release: { gameId: "connect-four", gameBuildId: "a".repeat(64), frameOrigin: "https://game.example", entryUrl: "https://game.example/client/index.html", profile: { id: "server-turn", version: 1 } }, policyBinding: {}, policy: { disconnectGraceMs: 60000 } }, members: [red, yellow] };
  return { core, ports, options, checkpoint, transport, results, red, yellow, assignment,
    now: () => now, advance: (ms: number) => { now += ms; }, saved: () => saves, deadline: () => deadline,
    failSave: (value: boolean) => { failSave = value; }, tickCalls: () => tickCalls, wakeCalls: () => wakeCalls };
}
type World = ReturnType<typeof world>;
function binaryContext(link: LinkDescriptor): BinaryContext { return { descriptorId: link.descriptorId, contextTag: BigInt(`0x${link.contextTag}`), endpoints: [link.endpoints[0]!.endpointId, link.endpoints[1]!.endpointId], validFromMs: link.validFromMs,
  validUntilMs: link.validUntilMs, maxFrameBytes: link.limits.maxFrameBytes, maxBulkBytes: 0, streams: link.streams.map(stream => ({ ...stream, maxAhead: 0xffff_fffe, ...(stream.kind === "STATE" ? { usesTick: false } : {}) })) }; }
async function connect(w: World, principal: RuntimePrincipal, id = crypto.randomUUID()) {
  w.transport.setConnMeta(id, { connectionId: id, principal, openedAt: w.now(), authenticated: false, bound: false });
  const claim = w.core.ticketIdentity(principal), jti = crypto.randomUUID();
  w.core.noteIncoming(id, 500);
  await w.core.authenticateVerified(id, { principal, ...claim, jti, expiresAtMs: w.now() + 90000 }, crypto.randomUUID());
  const accepted = w.transport.controls(id).find(message => message.type === "AUTH_ACCEPTED"); assert.ok(accepted && accepted.type === "AUTH_ACCEPTED");
  const link = accepted.body.descriptors[0]!;
  w.core.noteIncoming(id, 200);
  await w.core.receive(id, JSON.stringify({ v: 1, type: "LINK_BIND", requestId: crypto.randomUUID(), contextTag: link.contextTag, body: { descriptorId: link.descriptorId, contextTag: link.contextTag } }));
  assert.ok(w.transport.controls(id).some(message => message.type === "LINK_BOUND"));
  const full = w.transport.sent.get(id)!.find(item => item.format === "binary")!;
  const frame = decodeFrame(full.bytes, { context: binaryContext(link), senderEndpointId: link.endpoints[1]!.endpointId, receiverEndpointId: link.endpoints[0]!.endpointId, nowMs: w.now() });
  assert.equal(frame.header.flags & FULL_STATE, FULL_STATE);
  return { id, principal, link, jti, claim };
}
async function ready(w: World, connection: Awaited<ReturnType<typeof connect>>) {
  const view = w.core.projection(connection.principal), meta = w.transport.getConnMeta(connection.id)!;
  return w.core.ready(connection.principal, { requestId: crypto.randomUUID(), expectedMatchRevision: view["revision"], resourcesReady: true, baselineReady: true, prepared: true,
    baseline: { descriptorId: connection.link.descriptorId, stateSeq: meta.lastSentStateSeq } });
}
async function running(w: World) {
  await w.core.install(w.assignment); const red = await connect(w, w.red), yellow = await connect(w, w.yellow);
  await ready(w, red); assert.equal(w.core.load().phase, "PREPARING"); await ready(w, yellow); assert.equal(w.core.load().phase, "RUNNING"); return { red, yellow };
}
function bytes(w: World, connection: Awaited<ReturnType<typeof connect>>, seq: number, column: number): Uint8Array {
  return encodeFrame({ header: { opcode: Opcode.COMMAND, flags: 0, streamId: 1, contextTag: BigInt(`0x${connection.link.contextTag}`), seq, tick: 0 },
    payload: { kind: "COMMAND", data: new TextEncoder().encode(JSON.stringify({ type: "drop", column })) } },
  { context: binaryContext(connection.link), senderEndpointId: connection.link.endpoints[0]!.endpointId, receiverEndpointId: connection.link.endpoints[1]!.endpointId, nowMs: w.now(), receivePositions: new Map([[1, seq]]) });
}
async function drop(w: World, connection: Awaited<ReturnType<typeof connect>>, seq: number, column: number) { const command = bytes(w, connection, seq, column); w.core.noteIncoming(connection.id, command.byteLength); await w.core.receive(connection.id, command); return command; }

test("portable five-port host runs authenticated handshake, two-ready gate and a complete authority win", async () => {
  const w = world(), pair = await running(w);
  for (const [index, column] of [0,1,0,1,0,1,0].entries()) await drop(w, index % 2 === 0 ? pair.red : pair.yellow, Math.floor(index / 2), column);
  assert.equal(w.core.load().rules.moves, 7); assert.equal(w.core.load().phase, "TERMINAL"); assert.equal(w.core.projection(w.red)["winner"], "red");
  assert.equal(w.results.size, 1); const report = [...w.results.values()][0]!; assert.equal(report.result, "WIN"); assert.equal(report.winner, "red"); assert.ok(report.uplinkPackets >= 11);
  assert.equal(w.transport.closed.size, 2); assert.equal(w.deadline(), null); assert.equal(w.tickCalls(), 0);
  await w.core.alarm(); assert.equal(w.results.size, 1);
});
test("turn deadline survives recreation; a wrong-turn command cannot extend thinking time", async () => {
  const w = world(), pair = await running(w); const deadline = w.deadline(); assert.equal(deadline, w.now() + 90000);
  w.advance(45000); await drop(w, pair.yellow, 0, 1); assert.equal(w.deadline(), deadline); assert.equal(w.core.load().rules.moves, 0);
  const recovered = new RoomRuntimeCore(w.ports, w.options); w.advance(45001); await recovered.alarm();
  assert.equal(recovered.load().result, "WIN"); assert.equal(recovered.projection(w.red)["winner"], "yellow"); assert.equal(recovered.projection(w.red)["terminationReason"], "TURN_TIMEOUT");
  assert.equal(recovered.load().rules.winner, null); assert.equal(w.results.size, 1); assert.equal(w.tickCalls(), 0);
});
test("checkpoint write failure rolls back board, sequence and receipt; restored duplicate keeps the original commit", async () => {
  const w = world(), pair = await running(w), move = bytes(w, pair.red, 0, 0);
  w.failSave(true); await assert.rejects(w.core.receive(pair.red.id, move), /CHECKPOINT_WRITE_FAILED/); w.failSave(false);
  assert.equal(w.core.load().rules.moves, 0); assert.equal(w.core.load().runtime!.receipts.length, 0);
  await w.core.receive(pair.red.id, move); const recovered = new RoomRuntimeCore(w.ports, w.options); await recovered.receive(pair.red.id, move);
  assert.equal(recovered.load().rules.moves, 1); assert.equal(recovered.load().runtime!.receipts.length, 1);
  await assert.rejects(recovered.receive(pair.red.id, bytes(w, pair.red, 0, 1)), /IDEMPOTENCY_CONFLICT/);
});
test("offline admission fences jti replay, replacement connection and independently revoked sessions", async () => {
  const w = world(), pair = await running(w), replayId = crypto.randomUUID();
  w.transport.setConnMeta(replayId, { connectionId: replayId, principal: w.red, openedAt: w.now(), authenticated: false, bound: false });
  await assert.rejects(w.core.authenticateVerified(replayId, { principal: w.red, ...pair.red.claim, jti: pair.red.jti, expiresAtMs: w.now()+80000 }, "replay"), /STALE_BINDING/);
  const identity = w.core.ticketIdentity(w.red); await w.core.disconnect("red", pair.red.link.descriptorId, "SESSION_REVOKED", true, true);
  await assert.rejects(w.core.authenticateVerified(replayId, { principal: w.red, ...identity, jti: crypto.randomUUID(), expiresAtMs: w.now()+80000 }, "revoked"), /JOIN_REJECTED/);
  assert.ok(w.transport.closed.has(pair.red.id));
});
test("hibernatable idle advances neither writes nor tick loops; hard TTL is a bounded Alarm deadline", async () => {
  const w = world({ turnTimeoutMs: null, maxLifetimeMs: 1800000 }), pair = await running(w), saved = w.saved();
  w.advance(120000); assert.equal(w.saved(), saved); assert.equal(w.tickCalls(), 0); assert.equal(w.core.load().rules.moves, 0);
  await drop(w, pair.red, 0, 0); assert.equal(w.core.load().rules.moves, 1); w.advance(1800000); await w.core.alarm();
  assert.equal(w.core.load().result, "SERVICE_INTERRUPTED"); assert.equal(w.core.projection(w.red)["terminationReason"], "ROOM_TTL"); assert.equal(w.results.size, 1);
});


test("disconnect near a turn deadline retains the full no-result reconnect grace", async () => {
  const w = world(), pair = await running(w); w.advance(80000);
  await w.core.disconnect("red", pair.red.link.descriptorId, "DISCONNECTED");
  assert.equal(w.core.load().runtime!.turnDeadlineAt, null); assert.equal(w.deadline(), w.now()+60000);
  w.advance(20000); await w.core.alarm(); assert.equal(w.core.load().phase, "RUNNING");
  w.advance(40001); await w.core.alarm(); assert.equal(w.core.load().result, "DISCONNECTED"); assert.equal(w.core.projection(w.yellow)["winner"], null);
});


test("a command arriving after thinking expiry atomically saves the rejection receipt and command cursor", async () => {
  const w = world(), pair = await running(w); w.advance(90001);
  await drop(w, pair.red, 0, 0);
  const snapshot = w.core.load(), receipt = snapshot.runtime!.receipts[0]!;
  assert.equal(snapshot.rules.moves, 0); assert.equal(snapshot.phase, "TERMINAL"); assert.equal(snapshot.members[0]!.nextCommandSeq, 1);
  assert.equal(snapshot.runtime!.terminationReason, "TURN_TIMEOUT"); assert.equal(snapshot.runtime!.winner, "yellow");
  assert.equal(receipt.seq, 0); assert.equal(receipt.outcome.status, "REJECTED");
  if (receipt.outcome.status === "REJECTED") assert.equal(receipt.outcome.code, "TURN_TIMEOUT");
  assert.equal(new RoomRuntimeCore(w.ports, w.options).load().runtime!.receipts[0]!.digest, receipt.digest);
  assert.equal(w.results.size, 1);
});


test("reconnection resumes only remaining thinking time and a late disconnect cannot erase expiry", async () => {
  const w = world(), pair = await running(w); w.advance(80000);
  await w.core.disconnect("red", pair.red.link.descriptorId, "DISCONNECTED");
  assert.equal(w.core.load().runtime!.pausedTurnRemainingMs, 10000);
  w.advance(20000); const reconnected = await connect(w, w.red); await ready(w, reconnected);
  assert.equal(w.core.load().phase, "RUNNING"); assert.equal(w.core.load().runtime!.pausedTurnRemainingMs, null);
  assert.equal(w.deadline(), w.now() + 10000);
  w.advance(9999); await w.core.alarm(); assert.equal(w.core.load().phase, "RUNNING");
  w.advance(2); await w.core.alarm(); assert.equal(w.core.load().runtime!.winner, "yellow"); assert.equal(w.core.load().runtime!.terminationReason, "TURN_TIMEOUT");
  const late = world(), latePair = await running(late); late.advance(90001);
  await late.core.disconnect("red", latePair.red.link.descriptorId, "DISCONNECTED");
  assert.equal(late.core.load().phase, "TERMINAL"); assert.equal(late.core.load().runtime!.winner, "yellow");
  assert.equal(late.core.load().runtime!.terminationReason, "TURN_TIMEOUT"); assert.equal(late.results.size, 1);
  assert.ok(late.core.load().members.every(member => member.disconnectedUntil === null));
});
