import test from "node:test";
import assert from "node:assert/strict";
import { ControlProtocolError, encodeControl, parseControl, type ControlBodies, type ControlMessage, type LinkDescriptor, type CheckpointManifest } from "../../protocol/src/control.js";

const tag = "0102030405060708";
const hash = "ab".repeat(32);
const descriptor: LinkDescriptor = {
  descriptorId: "desc-1", roomId: "room-1", matchId: "match-1", gameBuildId: hash,
  profileId: "server-turn", profileVersion: 1, protocolVersion: 1, authorityEpoch: 1,
  endpoints: [
    { endpointId: "player-1", clockDomainId: "clock-1", kind: "PLAYER", playerId: "p1", sessionId: "session-1", inputSessionId: "session-1", seatId: "seat-1", seatEpoch: 1 },
    { endpointId: "runtime-1", clockDomainId: "clock-2", kind: "RUNTIME", runtimeInstanceId: "worker-1" },
  ],
  contextTag: tag,
  streams: [
    { streamId: 1, logicalStreamId: "commands-1", fromEndpointId: "player-1", toEndpointId: "runtime-1", kind: "COMMAND", codecId: "command-codec", codecVersion: 1, firstPosition: 0 },
    { streamId: 2, logicalStreamId: "states-1", fromEndpointId: "runtime-1", toEndpointId: "player-1", kind: "STATE", codecId: "state-codec", codecVersion: 1, firstPosition: 0 },
  ],
  permissions: ["command:send"], validFromMs: 0, validUntilMs: 10000,
  limits: { maxFrameBytes: 16384, maxControlBytes: 65536, maxBufferedBytes: 32768, historyBytes: 65536, maxBulkBytes: 1048576, maxConcurrentBulk: 2 },
};
const checkpoint: CheckpointManifest = {
  matchId: "match-1", gameBuildId: hash, profileId: "server-turn", profileVersion: 1,
  stateSchemaVersion: 1, authorityEpoch: 1, simulationTick: null, stateSeq: 1,
  stateHash: hash, objectRef: "checkpoints/match-1/1", visibility: "PUBLIC_SIMULATION",
  commandWatermarks: [{ logicalStreamId: "commands-1", nextApplied: 1, nextCommitted: 1 }],
  inputWatermarks: [], evidenceKind: "PLATFORM_AUTHORITY", replayLogRef: "logs/match-1",
};
const cursor = { logicalStreamId: "commands-1", space: "COMMAND_SEQ" as const, initialPosition: 0, nextExpected: 1 };
const bodies: ControlBodies = {
  AUTH_JOIN: { joinGrant: "fixture-grant", protocolVersions: [1], profileId: "server-turn", profileVersion: 1 },
  AUTH_ACCEPTED: { endpointId: "player-1", protocolVersion: 1, descriptors: [descriptor] },
  LINK_DESCRIPTOR: { descriptor },
  RTC_SIGNAL: { descriptorId: "desc-1", pathInstanceId: "path-1", fromEndpointId: "player-1", toEndpointId: "runtime-1", signal: { kind: "SDP", sdpType: "offer", sdp: "v=0\r\n" } },
  PATH_AUTHORIZED: { authorization: { descriptorId: "desc-1", pathInstanceId: "path-1", transport: "RTC", fingerprints: [{ endpointId: "player-1", sha256: hash }, { endpointId: "runtime-1", sha256: "cd".repeat(32) }], validUntilMs: 9999 } },
  LINK_BIND: { descriptorId: "desc-1", contextTag: tag },
  LINK_BOUND: { descriptorId: "desc-1", contextTag: tag, acceptedStreams: [1, 2], limits: descriptor.limits, receiveCursors: [cursor] },
  PATH_BIND: { pathInstanceId: "path-1", nonce: "00112233445566778899aabbccddeeff", requiredChannels: ["RTC_RELIABLE", "RTC_FAST"] },
  PATH_READY: { pathInstanceId: "path-1", nonce: "00112233445566778899aabbccddeeff", readyChannels: ["RTC_RELIABLE", "RTC_FAST"] },
  ROUTE_PROPOSE: { pathInstanceId: "path-1", routeRequestId: "route-1", streamIds: [1] },
  ROUTE_READY: { pathInstanceId: "path-1", routeRequestId: "route-1", streamIds: [1] },
  STREAM_OPEN: { descriptorId: "desc-1", requestedStream: descriptor.streams[0]! },
  ACTION_RECEIPT: { logicalStreamId: "commands-1", commandSeq: 0, outcome: { status: "COMMITTED", commitRef: "commit-1", stateSeq: 1 } },
  STATE_BASELINE_REQUEST: { logicalStreamId: "states-1", missingBaseSeq: 1, lastAcceptedStateSeq: null },
  RESYNC_REQUIRED: { reason: "HISTORY_EXHAUSTED", logicalStreamId: "commands-1", space: "SEQ", missingRange: { start: 0, endExclusive: 1 }, availableRange: null, checkpointRef: null },
  RESUME_BASELINE: { descriptorId: "desc-1", authorityEpoch: 1, checkpoint, seats: [{ seatId: "seat-1", seatEpoch: 1, inputSessionId: "session-1" }], receiveCursors: [cursor], nextCommandSeq: [{ logicalStreamId: "commands-1", value: 1 }] },
  BULK_BEGIN: { logicalStreamId: "bulk-1", transferId: 0, kind: "CHECKPOINT", totalBytes: 10000, chunkBytes: 1000, contentHash: hash, stateMeta: { stateSeq: 1, tick: null, checkpointRef: "checkpoint-1" } },
  BULK_READY: { logicalStreamId: "bulk-1", transferId: 0 },
  BULK_COMPLETE: { logicalStreamId: "bulk-1", transferId: 0, contentHash: hash },
  BULK_ABORT: { logicalStreamId: "bulk-1", transferId: 0, code: "CANCELLED" },
  START_AT: { referenceClockId: "clock-1", referenceClockDomainId: "domain-1", startAtMs: 1000, startTick: 0, simulationHz: 60 },
  PROTOCOL_ERROR: { code: "FRAME_LENGTH", relatedRequestId: "req-0", streamId: 1, frameSeq: 0, retryable: false },
};

function message(type: keyof ControlBodies, body: unknown = bodies[type]): string {
  return JSON.stringify({ v: 1, type, requestId: `req-${type}`, contextTag: tag, body });
}
function rejects(input: string | Uint8Array, code = "CONTROL_SCHEMA"): void {
  assert.throws(() => parseControl(input), (error: unknown) => error instanceof ControlProtocolError && error.code === code);
}

for (const type of Object.keys(bodies) as (keyof ControlBodies)[]) {
  test(`control closed schema accepts and round-trips ${type}`, () => {
    const input = message(type);
    const parsed = parseControl(input);
    assert.equal(parsed.type, type);
    assert.deepEqual(JSON.parse(encodeControl(parsed)), JSON.parse(input));
    const body = { ...(bodies[type] as object), undeclared: "field" };
    rejects(message(type, body));
  });
}

test("control envelope rejects unknown types, fields, invalid IDs, versions and malformed UTF-8", () => {
  const valid = JSON.parse(message("PATH_BIND")) as Record<string, unknown>;
  for (const mutated of [
    { ...valid, type: "UNDECLARED" }, { ...valid, v: 2 }, { ...valid, requestId: "bad/id" },
    { ...valid, requestId: "x".repeat(129) }, { ...valid, unexpected: true },
    { ...valid, contextTag: tag.toUpperCase().replace("0", "A") },
  ]) rejects(JSON.stringify(mutated));
  rejects("{", "CONTROL_JSON");
  rejects(new Uint8Array([0xc0, 0xaf]), "CONTROL_JSON");
  assert.deepEqual(parseControl(new TextEncoder().encode(message("PATH_BIND"))), valid);
});

test("control JSON byte, tree, array and UTF-8 string bounds are enforced", () => {
  rejects(" ".repeat(65537), "CONTROL_LIMIT");
  rejects(message("AUTH_JOIN", { ...bodies.AUTH_JOIN, joinGrant: "界".repeat(1366) }), "CONTROL_LIMIT");
  assert.equal(parseControl(message("AUTH_JOIN", { ...bodies.AUTH_JOIN, joinGrant: "界".repeat(1365) + "a" })).type, "AUTH_JOIN");
  rejects(message("AUTH_ACCEPTED", { ...bodies.AUTH_ACCEPTED, descriptors: new Array(65).fill(descriptor) }), "CONTROL_LIMIT");
  let deeplyNested: unknown = 1;
  for (let i = 0; i < 9; i++) deeplyNested = { next: deeplyNested };
  rejects(message("PROTOCOL_ERROR", deeplyNested), "CONTROL_LIMIT");
  assert.throws(() => parseControl(message("PATH_BIND"), { maxControlBytes: 100 }), (error: unknown) => error instanceof ControlProtocolError && error.code === "CONTROL_LIMIT");
});

test("control SDP uses its explicit 32768-byte limit while ICE and ordinary strings remain bounded", () => {
  const body = { ...bodies.RTC_SIGNAL, signal: { kind: "SDP", sdpType: "offer", sdp: "s".repeat(32768) } };
  assert.equal(parseControl(message("RTC_SIGNAL", body)).type, "RTC_SIGNAL");
  rejects(message("RTC_SIGNAL", { ...body, signal: { ...body.signal, sdp: "s".repeat(32769) } }), "CONTROL_LIMIT");
  rejects(message("RTC_SIGNAL", { ...body, signal: { kind: "ICE", candidate: "s".repeat(4097), sdpMid: null, sdpMLineIndex: null, usernameFragment: null } }), "CONTROL_LIMIT");
  assert.equal(parseControl(message("RTC_SIGNAL", { ...body, signal: { kind: "ICE_COMPLETE" } })).type, "RTC_SIGNAL");
  rejects(message("RTC_SIGNAL", { ...body, signal: { kind: "ICE", candidate: "candidate", sdpMid: null, sdpMLineIndex: 1.5, usernameFragment: null } }));
});

test("control context tags must agree and bound business controls cannot omit them", () => {
  rejects(message("LINK_BIND", { ...bodies.LINK_BIND, contextTag: "ffffffffffffffff" }), "CONTEXT_MISMATCH");
  assert.throws(() => parseControl(message("PATH_READY"), { expectedContextTag: "ffffffffffffffff" }), (error: unknown) => error instanceof ControlProtocolError && error.code === "CONTEXT_MISMATCH");
  const ready = JSON.parse(message("PATH_READY")) as Record<string, unknown>;
  delete ready.contextTag;
  rejects(JSON.stringify(ready));
  const bind = JSON.parse(message("LINK_BIND")) as Record<string, unknown>;
  delete bind.contextTag;
  assert.equal(parseControl(JSON.stringify(bind), { expectedContextTag: tag }).type, "LINK_BIND");
});

test("control platform authorization messages and credentials are forbidden on peer channels", () => {
  for (const type of ["AUTH_JOIN", "AUTH_ACCEPTED", "LINK_DESCRIPTOR", "PATH_AUTHORIZED", "RESUME_BASELINE", "START_AT", "STREAM_OPEN", "RTC_SIGNAL"] as const) {
    assert.throws(() => parseControl(message(type), { channel: "peer" }), (error: unknown) => error instanceof ControlProtocolError && error.code === "AUTH_REQUIRED");
  }
  assert.equal(parseControl(message("PATH_READY"), { channel: "peer" }).type, "PATH_READY");
  const secret = "secret-join-grant";
  assert.throws(() => parseControl(message("LINK_BIND", { ...bodies.LINK_BIND, joinGrant: secret })), (error: unknown) => error instanceof ControlProtocolError && !error.message.includes(secret));
});

test("control descriptor enforces endpoint, stream, lifetime, version and permission structure", () => {
  for (const mutated of [
    { ...descriptor, authorityEpoch: 0 }, { ...descriptor, profileVersion: 1.5 },
    { ...descriptor, gameBuildId: hash.toUpperCase() }, { ...descriptor, validUntilMs: 0 },
    { ...descriptor, endpoints: [descriptor.endpoints[0], descriptor.endpoints[0]] },
    { ...descriptor, endpoints: [{ ...descriptor.endpoints[0], sessionId: "different-session" }, descriptor.endpoints[1]] },
    { ...descriptor, streams: [descriptor.streams[0], descriptor.streams[0]] },
    { ...descriptor, streams: [{ ...descriptor.streams[0], toEndpointId: "unknown" }] },
    { ...descriptor, streams: [{ ...descriptor.streams[0], streamId: 65535 }] },
    { ...descriptor, limits: { ...descriptor.limits, maxFrameBytes: 16385 } },
  ]) rejects(message("LINK_DESCRIPTOR", { descriptor: mutated }));
  assert.throws(() => parseControl(message("LINK_DESCRIPTOR"), { allowedPermissions: [] }), (error: unknown) => error instanceof ControlProtocolError && error.code === "CONTROL_SCHEMA");
  assert.equal(parseControl(message("LINK_DESCRIPTOR"), { allowedPermissions: ["command:send"] }).type, "LINK_DESCRIPTOR");
});

test("control path fingerprints, channel sets and receive cursors reject ambiguity", () => {
  rejects(message("PATH_AUTHORIZED", { authorization: { ...bodies.PATH_AUTHORIZED.authorization, fingerprints: [{ endpointId: "p1", sha256: hash }, { endpointId: "p1", sha256: hash }] } }));
  rejects(message("PATH_BIND", { ...bodies.PATH_BIND, requiredChannels: ["RTC_FAST", "RTC_FAST"] }));
  rejects(message("PATH_BIND", { ...bodies.PATH_BIND, nonce: "too-short" }));
  rejects(message("LINK_BOUND", { ...bodies.LINK_BOUND, receiveCursors: [{ ...cursor, initialPosition: 2 }] }));
  rejects(message("LINK_BOUND", { ...bodies.LINK_BOUND, receiveCursors: [cursor, cursor] }));
});

test("control receipt variants require their defined durable or rejection references", () => {
  for (const outcome of [
    { status: "RECEIVED" }, { status: "APPLIED", appliedTick: 0, stateSeq: 1 },
    { status: "COMMITTED", stateSeq: 1, commitRef: "commit-1" },
    { status: "REJECTED", code: "INVALID_MOVE", outcomeRef: "outcome-1" },
  ]) assert.equal(parseControl(message("ACTION_RECEIPT", { ...bodies.ACTION_RECEIPT, outcome })).type, "ACTION_RECEIPT");
  for (const outcome of [{ status: "COMMITTED", stateSeq: 1 }, { status: "REJECTED", code: "INVALID_MOVE" }, { status: "RECEIVED", commitRef: "invented" }]) rejects(message("ACTION_RECEIPT", { ...bodies.ACTION_RECEIPT, outcome }));
});

test("control checkpoint and recovery data reject invalid ranges, duplicate identities and impossible watermarks", () => {
  rejects(message("RESYNC_REQUIRED", { ...bodies.RESYNC_REQUIRED, missingRange: { start: 1, endExclusive: 1 } }));
  rejects(message("RESUME_BASELINE", { ...bodies.RESUME_BASELINE, checkpoint: { ...checkpoint, commandWatermarks: [{ logicalStreamId: "commands-1", nextApplied: 1, nextCommitted: 2 }] } }));
  rejects(message("RESUME_BASELINE", { ...bodies.RESUME_BASELINE, checkpoint: { ...checkpoint, authorityEpoch: 2 } }));
  rejects(message("RESUME_BASELINE", { ...bodies.RESUME_BASELINE, seats: [bodies.RESUME_BASELINE.seats[0], bodies.RESUME_BASELINE.seats[0]] }));
  rejects(message("RESUME_BASELINE", { ...bodies.RESUME_BASELINE, checkpoint: { ...checkpoint, privateUnknownField: "secret" } }));
});

test("control bulk budgets use the negotiated frame minimum and object budget", () => {
  assert.equal(parseControl(message("BULK_BEGIN", { ...bodies.BULK_BEGIN, chunkBytes: 16344 })).type, "BULK_BEGIN");
  assert.throws(() => parseControl(message("BULK_BEGIN"), { maxFrameBytes: 1000 }), (error: unknown) => error instanceof ControlProtocolError && error.code === "CONTROL_LIMIT");
  assert.throws(() => parseControl(message("BULK_BEGIN"), { maxBulkBytes: 9999 }), (error: unknown) => error instanceof ControlProtocolError && error.code === "CONTROL_LIMIT");
  rejects(message("BULK_BEGIN", { ...bodies.BULK_BEGIN, chunkBytes: 0 }));
  rejects(message("BULK_BEGIN", { ...bodies.BULK_BEGIN, totalBytes: 1.5 }));
});

test("control finite clock values and exhausted numeric bounds cannot be smuggled through encode", () => {
  const start = JSON.parse(message("START_AT")) as Extract<ControlMessage, { type: "START_AT" }>;
  for (const startAtMs of [NaN, Infinity, -Infinity]) assert.throws(() => encodeControl({ ...start, body: { ...start.body, startAtMs } }), ControlProtocolError);
  rejects(message("START_AT", { ...bodies.START_AT, simulationHz: 0 }));
  rejects(message("START_AT", { ...bodies.START_AT, startTick: 0xffffffff }));
  rejects(message("ACTION_RECEIPT", { ...bodies.ACTION_RECEIPT, commandSeq: 0xffffffff }));
  assert.throws(() => encodeControl(start, { maxControlBytes: 1 }), (error: unknown) => error instanceof ControlProtocolError && error.code === "CONTROL_LIMIT");
});
