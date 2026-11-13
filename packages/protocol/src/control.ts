/** Closed JSON wire schemas from architecture v1.2 §§8.1, 9.7, 10.2.
 * Parsing validates structure and budgets, never the provenance of an authorization.
 */
export type Id = string;
export type Hex64 = string;
export type Hash256 = string;
export type Nonce128 = string;
export type U32 = number;
export type ChannelId = "WS" | "RTC_RELIABLE" | "RTC_FAST";
export type PositionRange = { start: U32; endExclusive: U32 };
export type ReceiveCursor = {
  logicalStreamId: Id;
  space: "COMMAND_SEQ" | "INPUT_TICK" | "BULK_SEQ";
  initialPosition: U32;
  nextExpected: U32;
};
export type EndpointBinding = {
  endpointId: Id;
  clockDomainId: Id;
  kind: "PLAYER" | "RUNTIME" | "SPECTATOR";
  playerId?: Id;
  sessionId?: Id;
  inputSessionId?: Id;
  seatId?: Id;
  seatEpoch?: number;
  runtimeInstanceId?: Id;
};
export type StreamBinding = {
  streamId: number;
  logicalStreamId: Id;
  fromEndpointId: Id;
  toEndpointId: Id;
  kind: "COMMAND" | "INPUT" | "STATE" | "BULK";
  codecId: Id;
  codecVersion: number;
  firstPosition: number;
};
export type LinkLimits = {
  maxFrameBytes: number;
  maxControlBytes: number;
  maxBufferedBytes: number;
  historyBytes: number;
  maxBulkBytes: number;
  maxConcurrentBulk: number;
};
export type LinkDescriptor = {
  descriptorId: Id;
  roomId: Id;
  matchId: Id;
  gameBuildId: Hash256;
  profileId: Id;
  profileVersion: number;
  protocolVersion: 1;
  authorityEpoch: number;
  endpoints: [EndpointBinding, EndpointBinding];
  contextTag: Hex64;
  streams: StreamBinding[];
  permissions: string[];
  validFromMs: number;
  validUntilMs: number;
  limits: LinkLimits;
};
export type PathAuthorization = {
  descriptorId: Id;
  pathInstanceId: Id;
  transport: "RTC";
  fingerprints: [{ endpointId: Id; sha256: Hash256 }, { endpointId: Id; sha256: Hash256 }];
  validUntilMs: number;
};
export type CheckpointManifest = {
  matchId: Id;
  gameBuildId: Hash256;
  profileId: Id;
  profileVersion: number;
  stateSchemaVersion: number;
  authorityEpoch: number;
  simulationTick: number | null;
  stateSeq: number;
  stateHash: Hash256;
  objectRef: string;
  visibility: "SERVER_PRIVATE" | "PUBLIC_SIMULATION" | "VIEWER_PROJECTION";
  commandWatermarks: { logicalStreamId: Id; nextApplied: number; nextCommitted: number }[];
  inputWatermarks: { seatId: Id; nextConfirmedTick: number }[];
  replayLogRef?: string;
  evidenceKind: string;
};
export type CommandOutcome =
  | { status: "RECEIVED" }
  | { status: "APPLIED"; appliedTick?: U32; stateSeq: U32 }
  | { status: "COMMITTED"; commitRef: Id; stateSeq: U32 }
  | { status: "REJECTED"; code: Id; outcomeRef: Id };
export type RtcSignal =
  | { kind: "SDP"; sdpType: "offer" | "answer"; sdp: string }
  | { kind: "ICE"; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; usernameFragment: string | null }
  | { kind: "ICE_COMPLETE" };
export interface ControlBodies {
  AUTH_JOIN: { joinGrant: string; protocolVersions: number[]; profileId: Id; profileVersion: number };
  AUTH_ACCEPTED: { endpointId: Id; protocolVersion: 1; descriptors: LinkDescriptor[] };
  LINK_DESCRIPTOR: { descriptor: LinkDescriptor };
  RTC_SIGNAL: { descriptorId: Id; pathInstanceId: Id; fromEndpointId: Id; toEndpointId: Id; signal: RtcSignal };
  PATH_AUTHORIZED: { authorization: PathAuthorization };
  LINK_BIND: { descriptorId: Id; contextTag: Hex64 };
  LINK_BOUND: { descriptorId: Id; contextTag: Hex64; acceptedStreams: U32[]; limits: LinkLimits; receiveCursors: ReceiveCursor[] };
  PATH_BIND: { pathInstanceId: Id; nonce: Nonce128; requiredChannels: ChannelId[] };
  PATH_READY: { pathInstanceId: Id; nonce: Nonce128; readyChannels: ChannelId[] };
  ROUTE_PROPOSE: { pathInstanceId: Id; routeRequestId: Id; streamIds: U32[] };
  ROUTE_READY: { pathInstanceId: Id; routeRequestId: Id; streamIds: U32[] };
  STREAM_OPEN: { descriptorId: Id; requestedStream: StreamBinding };
  ACTION_RECEIPT: { logicalStreamId: Id; commandSeq: U32; outcome: CommandOutcome };
  STATE_BASELINE_REQUEST: { logicalStreamId: Id; missingBaseSeq: U32; lastAcceptedStateSeq: U32 | null };
  RESYNC_REQUIRED: { reason: Id; logicalStreamId: Id; space: "SEQ" | "TICK"; missingRange: PositionRange; availableRange: PositionRange | null; checkpointRef: Id | null };
  RESUME_BASELINE: { descriptorId: Id; authorityEpoch: number; checkpoint: CheckpointManifest; seats: { seatId: Id; seatEpoch: number; inputSessionId: Id | null }[]; receiveCursors: ReceiveCursor[]; nextCommandSeq: { logicalStreamId: Id; value: U32 }[] };
  BULK_BEGIN: { logicalStreamId: Id; transferId: U32; kind: "STATE_BASELINE" | "CHECKPOINT" | "REPLAY_SEGMENT"; totalBytes: U32; chunkBytes: U32; contentHash: Hash256; stateMeta?: { stateSeq: U32; tick: U32 | null; checkpointRef: Id } };
  BULK_READY: { logicalStreamId: Id; transferId: U32 };
  BULK_COMPLETE: { logicalStreamId: Id; transferId: U32; contentHash: Hash256 };
  BULK_ABORT: { logicalStreamId: Id; transferId: U32; code: Id };
  START_AT: { referenceClockId: Id; referenceClockDomainId: Id; startAtMs: number; startTick: U32; simulationHz: number };
  PROTOCOL_ERROR: { code: Id; relatedRequestId?: Id; streamId?: U32; frameSeq?: U32; retryable: boolean };
}
export type ControlMessage = {
  [K in keyof ControlBodies]: { v: 1; type: K; requestId: Id; contextTag?: Hex64; body: ControlBodies[K] }
}[keyof ControlBodies];

export type ControlErrorCode = "CONTROL_JSON" | "CONTROL_SCHEMA" | "CONTROL_LIMIT" | "CONTEXT_MISMATCH" | "AUTH_REQUIRED";
export class ControlProtocolError extends Error {
  constructor(readonly code: ControlErrorCode, readonly field: string) {
    // Report schema locations only: no JoinGrant, SDP or private payload is echoed.
    super(`${code}: ${field}`);
    this.name = "ControlProtocolError";
  }
}
export interface ControlOptions {
  maxControlBytes?: number;
  /** Negotiated minimum of protocol, descriptor and transport limits. */
  maxFrameBytes?: number;
  maxBulkBytes?: number;
  expectedContextTag?: Hex64;
  channel?: "platform" | "peer";
  /** The profile's closed permission enum, checked when parsing descriptors. */
  allowedPermissions?: readonly string[];
}

type Validator = (value: unknown, path: string) => void;
type Fields = Readonly<Record<string, Validator>>;
type JsonObject = Record<string, unknown>;
const UTF8 = new TextEncoder();
const U32_MAX = 0xffffffff;
const DATA_MAX = 0xfffffffe;
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
function fail(path: string, code: ControlErrorCode = "CONTROL_SCHEMA"): never { throw new ControlProtocolError(code, path); }
function record(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path);
  return value as JsonObject;
}
function shape(required: Fields, optional: Fields = {}): Validator {
  return (value, path) => {
    const object = record(value, path);
    for (const key of Object.keys(object)) if (!own(required, key) && !own(optional, key)) fail(path);
    for (const [key, validator] of Object.entries(required)) {
      if (!own(object, key)) fail(`${path}.${key}`);
      validator(object[key], `${path}.${key}`);
    }
    for (const [key, validator] of Object.entries(optional)) if (own(object, key)) validator(object[key], `${path}.${key}`);
  };
}
const finite: Validator = (value, path) => { if (typeof value !== "number" || !Number.isFinite(value)) fail(path); };
function integer(min: number, max: number): Validator {
  return (value, path) => { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(path); };
}
const u32 = integer(0, U32_MAX);
const position = integer(0, DATA_MAX);
const epoch = integer(1, Number.MAX_SAFE_INTEGER);
const streamId = integer(1, 65534);
const boolean: Validator = (value, path) => { if (typeof value !== "boolean") fail(path); };
const string: Validator = (value, path) => { if (typeof value !== "string") fail(path); };
function pattern(expression: RegExp): Validator { return (value, path) => { if (typeof value !== "string" || !expression.test(value)) fail(path); }; }
const id = pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const hex64 = pattern(/^[a-f0-9]{16}$/);
const hash = pattern(/^[a-f0-9]{64}$/);
const nonce = pattern(/^[a-f0-9]{32}$/);
function enumeration(...values: readonly (string | number)[]): Validator { return (value, path) => { if (!values.includes(value as string | number)) fail(path); }; }
function nullable(validator: Validator): Validator { return (value, path) => { if (value !== null) validator(value, path); }; }
function array(validator: Validator, min = 0, max = 64): Validator {
  return (value, path) => {
    if (!Array.isArray(value) || value.length < min || value.length > max) fail(path);
    for (let i = 0; i < value.length; i++) validator(value[i], `${path}[${i}]`);
  };
}
function uniqueBy(value: unknown, path: string, key?: string): void {
  const seen = new Set<unknown>();
  for (const item of value as unknown[]) {
    const identity = key === undefined ? item : (item as JsonObject)[key];
    if (seen.has(identity)) fail(path);
    seen.add(identity);
  }
}
function uniqueArray(validator: Validator, min = 0, max = 64): Validator {
  const validate = array(validator, min, max);
  return (value, path) => { validate(value, path); uniqueBy(value, path); };
}
const range: Validator = (value, path) => {
  shape({ start: u32, endExclusive: u32 })(value, path);
  const object = value as PositionRange;
  if (object.start >= object.endExclusive) fail(path);
};
const cursor: Validator = (value, path) => {
  shape({ logicalStreamId: id, space: enumeration("COMMAND_SEQ", "INPUT_TICK", "BULK_SEQ"), initialPosition: u32, nextExpected: u32 })(value, path);
  const object = value as ReceiveCursor;
  if (object.nextExpected < object.initialPosition) fail(path);
};
const endpoint: Validator = (value, path) => {
  shape({ endpointId: id, clockDomainId: id, kind: enumeration("PLAYER", "RUNTIME", "SPECTATOR") }, { playerId: id, sessionId: id, inputSessionId: id, seatId: id, seatEpoch: epoch, runtimeInstanceId: id })(value, path);
  const object = value as EndpointBinding;
  if (object.kind === "RUNTIME") {
    if (!object.runtimeInstanceId || object.playerId !== undefined || object.sessionId !== undefined || object.inputSessionId !== undefined) fail(path);
  } else {
    if (!object.sessionId || object.runtimeInstanceId !== undefined) fail(path);
    if (object.kind === "SPECTATOR" && (object.inputSessionId !== undefined || object.seatId !== undefined || object.seatEpoch !== undefined)) fail(path);
  }
  if ((object.seatId === undefined) !== (object.seatEpoch === undefined)) fail(path);
  if (object.inputSessionId !== undefined && (object.kind !== "PLAYER" || object.inputSessionId !== object.sessionId || object.seatId === undefined)) fail(path);
};
const stream: Validator = (value, path) => {
  shape({ streamId, logicalStreamId: id, fromEndpointId: id, toEndpointId: id, kind: enumeration("COMMAND", "INPUT", "STATE", "BULK"), codecId: id, codecVersion: epoch, firstPosition: position })(value, path);
  const object = value as StreamBinding;
  if (object.fromEndpointId === object.toEndpointId) fail(path);
};
const limits: Validator = shape({ maxFrameBytes: integer(32, 16384), maxControlBytes: integer(1, 65536), maxBufferedBytes: integer(0, Number.MAX_SAFE_INTEGER), historyBytes: integer(0, Number.MAX_SAFE_INTEGER), maxBulkBytes: integer(0, U32_MAX), maxConcurrentBulk: integer(0, Number.MAX_SAFE_INTEGER) });
const descriptor: Validator = (value, path) => {
  shape({ descriptorId: id, roomId: id, matchId: id, gameBuildId: hash, profileId: id, profileVersion: epoch, protocolVersion: enumeration(1), authorityEpoch: epoch, endpoints: array(endpoint, 2, 2), contextTag: hex64, streams: array(stream), permissions: uniqueArray(id), validFromMs: finite, validUntilMs: finite, limits })(value, path);
  const object = value as LinkDescriptor;
  if (object.validUntilMs <= object.validFromMs) fail(path);
  uniqueBy(object.endpoints, `${path}.endpoints`, "endpointId");
  uniqueBy(object.streams, `${path}.streams`, "streamId");
  uniqueBy(object.streams, `${path}.streams`, "logicalStreamId");
  const endpoints = new Set(object.endpoints.map(item => item.endpointId));
  for (const item of object.streams) if (!endpoints.has(item.fromEndpointId) || !endpoints.has(item.toEndpointId)) fail(`${path}.streams`);
};
const pathAuthorization: Validator = (value, path) => {
  shape({ descriptorId: id, pathInstanceId: id, transport: enumeration("RTC"), fingerprints: array(shape({ endpointId: id, sha256: hash }), 2, 2), validUntilMs: finite })(value, path);
  uniqueBy((value as PathAuthorization).fingerprints, `${path}.fingerprints`, "endpointId");
};
const checkpoint: Validator = (value, path) => {
  shape({ matchId: id, gameBuildId: hash, profileId: id, profileVersion: epoch, stateSchemaVersion: epoch, authorityEpoch: epoch, simulationTick: nullable(position), stateSeq: position, stateHash: hash, objectRef: string, visibility: enumeration("SERVER_PRIVATE", "PUBLIC_SIMULATION", "VIEWER_PROJECTION"), commandWatermarks: array(shape({ logicalStreamId: id, nextApplied: u32, nextCommitted: u32 })), inputWatermarks: array(shape({ seatId: id, nextConfirmedTick: u32 })), evidenceKind: string }, { replayLogRef: string })(value, path);
  const object = value as CheckpointManifest;
  uniqueBy(object.commandWatermarks, `${path}.commandWatermarks`, "logicalStreamId");
  uniqueBy(object.inputWatermarks, `${path}.inputWatermarks`, "seatId");
  for (const item of object.commandWatermarks) if (item.nextCommitted > item.nextApplied) fail(`${path}.commandWatermarks`);
};
const outcome: Validator = (value, path) => {
  const object = record(value, path);
  switch (object.status) {
    case "RECEIVED": shape({ status: enumeration("RECEIVED") })(value, path); break;
    case "APPLIED": shape({ status: enumeration("APPLIED"), stateSeq: position }, { appliedTick: position })(value, path); break;
    case "COMMITTED": shape({ status: enumeration("COMMITTED"), stateSeq: position, commitRef: id })(value, path); break;
    case "REJECTED": shape({ status: enumeration("REJECTED"), code: id, outcomeRef: id })(value, path); break;
    default: fail(`${path}.status`);
  }
};
const rtcSignal: Validator = (value, path) => {
  const object = record(value, path);
  switch (object.kind) {
    case "SDP": shape({ kind: enumeration("SDP"), sdpType: enumeration("offer", "answer"), sdp: string })(value, path); break;
    case "ICE": shape({ kind: enumeration("ICE"), candidate: string, sdpMid: nullable(string), sdpMLineIndex: nullable(integer(0, 65535)), usernameFragment: nullable(string) })(value, path); break;
    case "ICE_COMPLETE": shape({ kind: enumeration("ICE_COMPLETE") })(value, path); break;
    default: fail(`${path}.kind`);
  }
};
const channels = uniqueArray(enumeration("WS", "RTC_RELIABLE", "RTC_FAST"), 1, 3);
const streamIds = uniqueArray(streamId);
const cursors = array(cursor);
const schemas: Readonly<Record<keyof ControlBodies, Validator>> = {
  AUTH_JOIN: shape({ joinGrant: string, protocolVersions: uniqueArray(integer(1, 255), 1), profileId: id, profileVersion: epoch }),
  AUTH_ACCEPTED: shape({ endpointId: id, protocolVersion: enumeration(1), descriptors: array(descriptor) }),
  LINK_DESCRIPTOR: shape({ descriptor }),
  RTC_SIGNAL: shape({ descriptorId: id, pathInstanceId: id, fromEndpointId: id, toEndpointId: id, signal: rtcSignal }),
  PATH_AUTHORIZED: shape({ authorization: pathAuthorization }),
  LINK_BIND: shape({ descriptorId: id, contextTag: hex64 }),
  LINK_BOUND: shape({ descriptorId: id, contextTag: hex64, acceptedStreams: streamIds, limits, receiveCursors: cursors }),
  PATH_BIND: shape({ pathInstanceId: id, nonce, requiredChannels: channels }),
  PATH_READY: shape({ pathInstanceId: id, nonce, readyChannels: channels }),
  ROUTE_PROPOSE: shape({ pathInstanceId: id, routeRequestId: id, streamIds }),
  ROUTE_READY: shape({ pathInstanceId: id, routeRequestId: id, streamIds }),
  STREAM_OPEN: shape({ descriptorId: id, requestedStream: stream }),
  ACTION_RECEIPT: shape({ logicalStreamId: id, commandSeq: position, outcome }),
  STATE_BASELINE_REQUEST: shape({ logicalStreamId: id, missingBaseSeq: position, lastAcceptedStateSeq: nullable(position) }),
  RESYNC_REQUIRED: shape({ reason: id, logicalStreamId: id, space: enumeration("SEQ", "TICK"), missingRange: range, availableRange: nullable(range), checkpointRef: nullable(id) }),
  RESUME_BASELINE: shape({ descriptorId: id, authorityEpoch: epoch, checkpoint, seats: array(shape({ seatId: id, seatEpoch: epoch, inputSessionId: nullable(id) })), receiveCursors: cursors, nextCommandSeq: array(shape({ logicalStreamId: id, value: u32 })) }),
  BULK_BEGIN: shape({ logicalStreamId: id, transferId: u32, kind: enumeration("STATE_BASELINE", "CHECKPOINT", "REPLAY_SEGMENT"), totalBytes: u32, chunkBytes: integer(1, 16344), contentHash: hash }, { stateMeta: shape({ stateSeq: position, tick: nullable(position), checkpointRef: id }) }),
  BULK_READY: shape({ logicalStreamId: id, transferId: u32 }),
  BULK_COMPLETE: shape({ logicalStreamId: id, transferId: u32, contentHash: hash }),
  BULK_ABORT: shape({ logicalStreamId: id, transferId: u32, code: id }),
  START_AT: shape({ referenceClockId: id, referenceClockDomainId: id, startAtMs: finite, startTick: position, simulationHz: (value, path) => { finite(value, path); if ((value as number) <= 0) fail(path); } }),
  PROTOCOL_ERROR: shape({ code: id, retryable: boolean }, { relatedRequestId: id, streamId: u32, frameSeq: u32 }),
};
const PLATFORM_ONLY = new Set<keyof ControlBodies>(["AUTH_JOIN", "AUTH_ACCEPTED", "LINK_DESCRIPTOR", "PATH_AUTHORIZED", "RTC_SIGNAL", "STREAM_OPEN", "RESUME_BASELINE", "START_AT"]);
const PREBIND = new Set<keyof ControlBodies>(["AUTH_JOIN", "AUTH_ACCEPTED", "LINK_DESCRIPTOR", "RTC_SIGNAL", "PATH_AUTHORIZED", "LINK_BIND", "PROTOCOL_ERROR"]);

function effectiveLimit(value: number | undefined, ceiling: number, field: string, minimum = 1): number {
  if (value === undefined) return ceiling;
  integer(minimum, Number.MAX_SAFE_INTEGER)(value, field);
  return Math.min(value, ceiling);
}
function checkTree(value: unknown, path: string, depth: number): void {
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    const maximum = path === "$.body.signal.sdp" ? 32768 : 4096;
    if (UTF8.encode(value).byteLength > maximum) fail(path, "CONTROL_LIMIT");
    return;
  }
  if (typeof value !== "object") fail(path);
  if (depth > 8) fail(path, "CONTROL_LIMIT");
  if (Array.isArray(value)) {
    if (value.length > 64) fail(path, "CONTROL_LIMIT");
    for (let i = 0; i < value.length; i++) checkTree(value[i], `${path}[${i}]`, depth + 1);
  } else {
    for (const [key, child] of Object.entries(record(value, path))) {
      if (UTF8.encode(key).byteLength > 4096) fail(path, "CONTROL_LIMIT");
      // Arbitrary attacker-controlled property names never enter diagnostics.
      const childPath = path === "$" && key === "body" ? "$.body"
        : path === "$.body" && key === "signal" ? "$.body.signal"
        : path === "$.body.signal" && key === "sdp" ? "$.body.signal.sdp"
        : `${path}.*`;
      checkTree(child, childPath, depth + 1);
    }
  }
}
function validateMessage(value: unknown, options: ControlOptions): ControlMessage {
  checkTree(value, "$", 1);
  shape({ v: enumeration(1), type: string, requestId: id, body: (_value, _path) => {} }, { contextTag: hex64 })(value, "$");
  const object = value as JsonObject;
  if (!own(schemas, object.type as string)) fail("$.type");
  const type = object.type as keyof ControlBodies;
  schemas[type](object.body, "$.body");
  const message = value as ControlMessage;
  if (!PREBIND.has(type) && message.contextTag === undefined) fail("$.contextTag");
  if (options.expectedContextTag !== undefined) {
    hex64(options.expectedContextTag, "options.expectedContextTag");
    const bodyTag = type === "LINK_BIND" || type === "LINK_BOUND" ? (object.body as JsonObject).contextTag : undefined;
    if ((message.contextTag ?? bodyTag) !== options.expectedContextTag) fail("$.contextTag", "CONTEXT_MISMATCH");
  }
  if (type === "LINK_BIND" || type === "LINK_BOUND") {
    if (message.contextTag !== undefined && message.contextTag !== (object.body as JsonObject).contextTag) fail("$.body.contextTag", "CONTEXT_MISMATCH");
  }
  if (type === "LINK_DESCRIPTOR" && message.contextTag !== undefined && message.contextTag !== (message as Extract<ControlMessage, { type: "LINK_DESCRIPTOR" }>).body.descriptor.contextTag) fail("$.body.descriptor.contextTag", "CONTEXT_MISMATCH");
  if (options.channel === "peer" && PLATFORM_ONLY.has(type)) fail("$.type", "AUTH_REQUIRED");
  if (message.type === "BULK_BEGIN") {
    const frameLimit = effectiveLimit(options.maxFrameBytes, 16384, "options.maxFrameBytes", 32);
    if (message.body.chunkBytes > frameLimit - 40 || message.body.totalBytes > effectiveLimit(options.maxBulkBytes, U32_MAX, "options.maxBulkBytes", 0)) fail("$.body", "CONTROL_LIMIT");
  }
  if (message.type === "LINK_BOUND") uniqueBy(message.body.receiveCursors, "$.body.receiveCursors", "logicalStreamId");
  if (message.type === "AUTH_JOIN" && message.body.joinGrant.length === 0) fail("$.body.joinGrant");
  if (message.type === "RTC_SIGNAL" && message.body.fromEndpointId === message.body.toEndpointId) fail("$.body.toEndpointId");
  if (message.type === "RESUME_BASELINE") {
    uniqueBy(message.body.seats, "$.body.seats", "seatId");
    uniqueBy(message.body.receiveCursors, "$.body.receiveCursors", "logicalStreamId");
    uniqueBy(message.body.nextCommandSeq, "$.body.nextCommandSeq", "logicalStreamId");
    if (message.body.checkpoint.authorityEpoch > message.body.authorityEpoch) fail("$.body.checkpoint.authorityEpoch");
  }
  if (options.allowedPermissions !== undefined) {
    const descriptors = message.type === "AUTH_ACCEPTED" ? message.body.descriptors : message.type === "LINK_DESCRIPTOR" ? [message.body.descriptor] : [];
    for (const item of descriptors) for (const permission of item.permissions) if (!options.allowedPermissions.includes(permission)) fail("$.body.descriptor.permissions");
  }
  return message;
}

export function parseControl(input: string | Uint8Array, options: ControlOptions = {}): ControlMessage {
  const limit = effectiveLimit(options.maxControlBytes, 65536, "options.maxControlBytes");
  let text: string;
  if (typeof input === "string") {
    if (input.length > limit || UTF8.encode(input).byteLength > limit) fail("$", "CONTROL_LIMIT");
    text = input;
  } else {
    if (!(input instanceof Uint8Array)) fail("$", "CONTROL_JSON");
    if (input.byteLength > limit) fail("$", "CONTROL_LIMIT");
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(input); } catch { fail("$", "CONTROL_JSON"); }
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { fail("$", "CONTROL_JSON"); }
  return validateMessage(value, options);
}

export function encodeControl(message: ControlMessage, options: ControlOptions = {}): string {
  validateMessage(message, options);
  let text: string;
  try { text = JSON.stringify(message); } catch { fail("$", "CONTROL_JSON"); }
  const limit = effectiveLimit(options.maxControlBytes, 65536, "options.maxControlBytes");
  if (UTF8.encode(text).byteLength > limit) fail("$", "CONTROL_LIMIT");
  return text;
}
