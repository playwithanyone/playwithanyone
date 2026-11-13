/** Architecture v1.2 §8.1 and §9.1–9.4. Pure codec; trust is supplied by the runtime. */
export const MAGIC = 0x5750;
export const PROTOCOL_VERSION = 1;
export const HEADER_BYTES = 32;
export const MAX_FRAME_BYTES = 16_384;
export const MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES - HEADER_BYTES;
export const MAX_GAP_RANGES = 32;
export const MAX_POSITION = 0xffff_fffe;
export const EXCLUSIVE_END = 0xffff_ffff;
export const HAS_TICK = 1;
export const FULL_STATE = 2;

export const Opcode = {
  COMMAND: 0x01, INPUT_BATCH: 0x02, STATE: 0x03, BULK_CHUNK: 0x04,
  ACK: 0x10, GAP_REQUEST: 0x11, CLOCK_PING: 0x20, CLOCK_PONG: 0x21,
} as const;
export type Opcode = typeof Opcode[keyof typeof Opcode];
export type StreamKind = "COMMAND" | "INPUT" | "STATE" | "BULK";

export class FrameError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "FrameError";
  }
}
function fail(code: string, detail: string): never { throw new FrameError(code, detail); }
function integer(n: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(n) || n < min || n > max) fail("FRAME_FIELD", label);
}
function bytes(value: Uint8Array, label: string): void {
  if (!(value instanceof Uint8Array)) fail("FRAME_FIELD", label);
}
function finite(n: number): void {
  if (!Number.isFinite(n)) fail("CLOCK_SAMPLE", "timestamp must be finite");
}

export interface FrameHeader {
  readonly opcode: Opcode;
  readonly flags: number;
  readonly streamId: number;
  readonly contextTag: bigint;
  readonly seq: number;
  readonly tick: number;
}
export interface WireGapRange { readonly start: number; readonly endExclusive: number }
export type FramePayload =
  | { readonly kind: "COMMAND"; readonly data: Uint8Array }
  | { readonly kind: "INPUT_BATCH"; readonly firstTick: number; readonly inputBytes: number; readonly inputs: readonly Uint8Array[] }
  | { readonly kind: "STATE"; readonly baseSeq: number; readonly data: Uint8Array }
  | { readonly kind: "BULK_CHUNK"; readonly transferId: number; readonly offset: number; readonly data: Uint8Array }
  | { readonly kind: "ACK" | "GAP_REQUEST"; readonly ackSpace: 1 | 2 | 3; readonly nextExpected: number; readonly observedExclusive: number; readonly ranges: readonly WireGapRange[] }
  | { readonly kind: "CLOCK_PING"; readonly probeId: number; readonly t1: number }
  | { readonly kind: "CLOCK_PONG"; readonly probeId: number; readonly t1: number; readonly t2: number; readonly t3: number };
export interface BinaryFrame { readonly header: FrameHeader; readonly payload: FramePayload }

export interface BinaryStreamBinding {
  readonly streamId: number;
  readonly logicalStreamId: string;
  readonly fromEndpointId: string;
  readonly toEndpointId: string;
  readonly kind: StreamKind;
  readonly firstPosition: number;
  /** Explicit engineering receive budget, never a product timeout. */
  readonly maxAhead: number;
  readonly inputBytes?: number;
  readonly usesTick?: boolean;
}
export interface BinaryContext {
  readonly descriptorId: string;
  readonly contextTag: bigint;
  readonly endpoints: readonly [string, string];
  readonly validFromMs: number;
  readonly validUntilMs: number;
  readonly maxFrameBytes: number;
  readonly maxBulkBytes: number;
  readonly streams: readonly BinaryStreamBinding[];
}
export interface BulkTransfer {
  readonly totalBytes: number;
  readonly chunkBytes: number;
}
/** Runtime supplies already authenticated endpoint identities and installed state. */
export interface FrameAuthorization {
  readonly context: BinaryContext;
  readonly senderEndpointId: string;
  readonly receiverEndpointId: string;
  readonly nowMs: number;
  readonly revoked?: boolean;
  readonly maxTransportBytes?: number;
  readonly receivePositions?: ReadonlyMap<number, number>;
  readonly sentExclusive?: ReadonlyMap<number, number>;
  readonly stateBaselines?: ReadonlyMap<number, ReadonlySet<number>>;
  readonly bulkTransfers?: ReadonlyMap<number, ReadonlyMap<number, BulkTransfer>>;
}

function validateContext(context: BinaryContext): void {
  if (typeof context.contextTag !== "bigint" || context.contextTag < 0n || context.contextTag > 0xffff_ffff_ffff_ffffn) {
    fail("FRAME_CONTEXT", "contextTag must be u64");
  }
  if (!context.descriptorId || context.endpoints.length !== 2 || !context.endpoints[0] || !context.endpoints[1] || context.endpoints[0] === context.endpoints[1]) {
    fail("FRAME_CONTEXT", "descriptor and two distinct endpoints required");
  }
  if (!Number.isFinite(context.validFromMs) || !Number.isFinite(context.validUntilMs) || context.validFromMs >= context.validUntilMs) {
    fail("FRAME_CONTEXT", "invalid authorization interval");
  }
  integer(context.maxFrameBytes, HEADER_BYTES, MAX_FRAME_BYTES, "maxFrameBytes");
  integer(context.maxBulkBytes, 0, Number.MAX_SAFE_INTEGER, "maxBulkBytes");
  if (context.streams.length > 64) fail("FRAME_CONTEXT", "too many streams");
  const aliases = new Set<number>();
  const logicalIds = new Set<string>();
  for (const stream of context.streams) {
    integer(stream.streamId, 1, 65534, "streamId");
    integer(stream.firstPosition, 0, MAX_POSITION, "firstPosition");
    integer(stream.maxAhead, 1, MAX_POSITION, "maxAhead");
    if (!stream.logicalStreamId || aliases.has(stream.streamId) || logicalIds.has(stream.logicalStreamId)) fail("FRAME_CONTEXT", "duplicate stream identity");
    aliases.add(stream.streamId);
    logicalIds.add(stream.logicalStreamId);
    if (!context.endpoints.includes(stream.fromEndpointId) || !context.endpoints.includes(stream.toEndpointId) || stream.fromEndpointId === stream.toEndpointId) {
      fail("FRAME_CONTEXT", "stream endpoints do not match link");
    }
    if (!["COMMAND", "INPUT", "STATE", "BULK"].includes(stream.kind)) fail("FRAME_CONTEXT", "unknown stream kind");
    if (stream.kind === "INPUT") integer(stream.inputBytes ?? 0, 1, 65535, "inputBytes");
    if (stream.kind === "STATE" && typeof stream.usesTick !== "boolean") fail("FRAME_CONTEXT", "state tick capability required");
  }
}

function validateHeader(header: FrameHeader): void {
  if (!Object.values(Opcode).includes(header.opcode)) fail("INVALID_OPCODE", "unknown opcode");
  integer(header.flags, 0, 3, "flags");
  integer(header.streamId, 0, 65534, "streamId");
  integer(header.seq, 0, EXCLUSIVE_END, "seq");
  integer(header.tick, 0, EXCLUSIVE_END, "tick");
  if (typeof header.contextTag !== "bigint" || header.contextTag < 0n || header.contextTag > 0xffff_ffff_ffff_ffffn) fail("FRAME_CONTEXT", "contextTag must be u64");
  const data = header.opcode <= Opcode.BULK_CHUNK;
  const clock = header.opcode === Opcode.CLOCK_PING || header.opcode === Opcode.CLOCK_PONG;
  if ((clock && header.streamId !== 0) || (!clock && header.streamId === 0)) fail("FRAME_STREAM", "wrong stream alias");
  if (data && header.seq === EXCLUSIVE_END) fail("SEQ_EXHAUSTED", "reserved data sequence");
  if (!data && header.seq !== 0) fail("FRAME_FLAGS", "auxiliary seq must be zero");
  if (header.opcode === Opcode.INPUT_BATCH && header.flags !== HAS_TICK) fail("FRAME_FLAGS", "input requires HAS_TICK only");
  if (header.opcode !== Opcode.INPUT_BATCH && header.opcode !== Opcode.STATE && header.flags !== 0) fail("FRAME_FLAGS", "flags not permitted for opcode");
  if (!(header.flags & HAS_TICK) && header.tick !== 0) fail("FRAME_FLAGS", "tick without HAS_TICK");
  if ((header.flags & HAS_TICK) && header.tick === EXCLUSIVE_END) fail("SEQ_EXHAUSTED", "reserved input tick");
}

function authorize(header: FrameHeader, auth: FrameAuthorization): BinaryStreamBinding | undefined {
  const context = auth.context;
  validateContext(context);
  if (auth.revoked || !Number.isFinite(auth.nowMs) || auth.nowMs < context.validFromMs || auth.nowMs >= context.validUntilMs) fail("AUTH_EXPIRED", "context is revoked or outside validity");
  if (header.contextTag !== context.contextTag) fail("CONTEXT_UNBOUND", "frame cannot install its own context");
  if (!context.endpoints.includes(auth.senderEndpointId) || !context.endpoints.includes(auth.receiverEndpointId) || auth.senderEndpointId === auth.receiverEndpointId) fail("FRAME_PERMISSION", "endpoint not bound");
  if (header.streamId === 0) return undefined;
  const stream = context.streams.find(item => item.streamId === header.streamId);
  if (!stream) fail("FRAME_STREAM", "stream not registered");
  const backwards = header.opcode === Opcode.ACK || header.opcode === Opcode.GAP_REQUEST;
  const sender = backwards ? stream.toEndpointId : stream.fromEndpointId;
  const receiver = backwards ? stream.fromEndpointId : stream.toEndpointId;
  if (auth.senderEndpointId !== sender || auth.receiverEndpointId !== receiver) fail("FRAME_PERMISSION", "wrong authenticated direction");
  const kinds: Partial<Record<Opcode, StreamKind>> = { 1: "COMMAND", 2: "INPUT", 3: "STATE", 4: "BULK" };
  if (!backwards && kinds[header.opcode] !== stream.kind) fail("FRAME_STREAM", "opcode incompatible with stream");
  if (header.opcode === Opcode.STATE && Boolean(header.flags & HAS_TICK) !== stream.usesTick) fail("FRAME_FLAGS", "state tick capability mismatch");
  if (!backwards && header.opcode !== Opcode.INPUT_BATCH) {
    const position = auth.receivePositions?.get(stream.streamId) ?? stream.firstPosition;
    integer(position, stream.firstPosition, EXCLUSIVE_END, "receivePosition");
    if (header.seq < stream.firstPosition || header.seq >= position + stream.maxAhead) fail("RESYNC_REQUIRED", "data exceeds authorized receive window");
  }
  return stream;
}

function frameLimit(auth: FrameAuthorization): number {
  if (auth.maxTransportBytes !== undefined) integer(auth.maxTransportBytes, 1, Number.MAX_SAFE_INTEGER, "maxTransportBytes");
  return Math.min(MAX_FRAME_BYTES, auth.context.maxFrameBytes, auth.maxTransportBytes ?? MAX_FRAME_BYTES);
}
function dataView(value: Uint8Array): DataView { return new DataView(value.buffer, value.byteOffset, value.byteLength); }

function parseHeader(raw: Uint8Array, limit: number): FrameHeader {
  bytes(raw, "frame");
  if (raw.byteLength < HEADER_BYTES || raw.byteLength > limit) fail("FRAME_LENGTH", "outside frame budget");
  const view = dataView(raw);
  if (view.getUint16(0, true) !== MAGIC) fail("FRAME_MAGIC", "expected PW");
  if (view.getUint8(2) !== PROTOCOL_VERSION) fail("PROTOCOL_VERSION", "unsupported protocol");
  const header: FrameHeader = {
    opcode: view.getUint8(3) as Opcode, flags: view.getUint16(4, true), streamId: view.getUint16(6, true),
    contextTag: view.getBigUint64(8, true), seq: view.getUint32(16, true), tick: view.getUint32(20, true),
  };
  validateHeader(header);
  if (view.getUint32(28, true) !== 0) fail("FRAME_RESERVED", "reserved must be zero");
  if (view.getUint32(24, true) !== raw.byteLength - HEADER_BYTES) fail("FRAME_LENGTH", "payloadBytes mismatch");
  return header;
}

/** Decoding is atomic: it mutates no authorization, history, game state or ACK. */
export function decodeFrame(raw: Uint8Array, auth: FrameAuthorization): BinaryFrame {
  const header = parseHeader(raw, frameLimit(auth));
  const stream = authorize(header, auth);
  const payload = raw.subarray(HEADER_BYTES);
  const p = dataView(payload);
  let decoded: FramePayload;
  switch (header.opcode) {
    case Opcode.COMMAND:
      decoded = { kind: "COMMAND", data: payload.slice() };
      break;
    case Opcode.INPUT_BATCH: {
      if (payload.length < 8) fail("INPUT_BATCH_LENGTH", "short input batch");
      const firstTick = p.getUint32(0, true), count = p.getUint16(4, true), inputBytes = p.getUint16(6, true);
      if (count < 1 || count > 256 || inputBytes === 0 || inputBytes !== stream?.inputBytes || payload.length !== 8 + count * inputBytes) fail("INPUT_BATCH_LENGTH", "input codec/count/length mismatch");
      const lastTick = firstTick + count - 1;
      if (firstTick > MAX_POSITION || lastTick > MAX_POSITION || header.tick !== lastTick) fail("INPUT_BATCH_TICK", "invalid batch tick range");
      const firstPosition = stream!.firstPosition;
      const receivePosition = auth.receivePositions?.get(header.streamId) ?? firstPosition;
      integer(receivePosition, firstPosition, EXCLUSIVE_END, "receivePosition");
      if (firstTick < firstPosition || lastTick >= receivePosition + stream!.maxAhead) fail("RESYNC_REQUIRED", "input exceeds receive window");
      const inputs = Array.from({ length: count }, (_, i) => payload.slice(8 + i * inputBytes, 8 + (i + 1) * inputBytes));
      decoded = { kind: "INPUT_BATCH", firstTick, inputBytes, inputs };
      break;
    }
    case Opcode.STATE: {
      if (payload.length < 4) fail("FRAME_LENGTH", "state requires baseSeq");
      const baseSeq = p.getUint32(0, true);
      if (header.flags & FULL_STATE) {
        if (baseSeq !== EXCLUSIVE_END) fail("STATE_BASELINE", "full state requires sentinel");
      } else if (baseSeq === EXCLUSIVE_END || !auth.stateBaselines?.get(header.streamId)?.has(baseSeq)) {
        fail("STATE_BASELINE_REQUIRED", "delta has no accepted baseline in current context");
      }
      decoded = { kind: "STATE", baseSeq, data: payload.slice(4) };
      break;
    }
    case Opcode.BULK_CHUNK: {
      if (payload.length <= 8) fail("FRAME_LENGTH", "empty bulk chunk");
      const transferId = p.getUint32(0, true), offset = p.getUint32(4, true);
      const transfer = auth.bulkTransfers?.get(header.streamId)?.get(transferId);
      if (!transfer) fail("BULK_NOT_READY", "BEGIN must be accepted before chunks");
      integer(transfer.totalBytes, 1, Math.min(EXCLUSIVE_END, auth.context.maxBulkBytes), "totalBytes");
      integer(transfer.chunkBytes, 1, frameLimit(auth) - 40, "chunkBytes");
      const expectedLength = Math.min(transfer.chunkBytes, transfer.totalBytes - offset);
      if (offset >= transfer.totalBytes || offset % transfer.chunkBytes !== 0 || payload.length - 8 !== expectedLength) fail("BULK_CHUNK_RANGE", "chunk does not match accepted transfer");
      decoded = { kind: "BULK_CHUNK", transferId, offset, data: payload.slice(8) };
      break;
    }
    case Opcode.ACK:
    case Opcode.GAP_REQUEST: {
      if (payload.length < 12) fail("ACK_LENGTH", "short ACK");
      const ackSpace = p.getUint8(0), count = p.getUint16(2, true);
      const expectedSpace = stream?.kind === "COMMAND" ? 1 : stream?.kind === "INPUT" ? 2 : stream?.kind === "BULK" ? 3 : 0;
      if (ackSpace !== expectedSpace || expectedSpace === 0) fail("ACK_SPACE", "ACK targets wrong stream kind");
      if (p.getUint8(1) !== 0) fail("FRAME_RESERVED", "ACK reserved must be zero");
      if (count > MAX_GAP_RANGES || payload.length !== 12 + count * 8 || (header.opcode === Opcode.GAP_REQUEST && count === 0)) fail("ACK_LENGTH", "invalid gap count/length");
      const nextExpected = p.getUint32(4, true), observedExclusive = p.getUint32(8, true);
      const sentExclusive = auth.sentExclusive?.get(header.streamId);
      if (sentExclusive === undefined) fail("ACK_WATERMARK", "known sent tail required");
      integer(sentExclusive, stream!.firstPosition, EXCLUSIVE_END, "sentExclusive");
      if (nextExpected < stream!.firstPosition || nextExpected > observedExclusive || observedExclusive > sentExclusive) fail("ACK_WATERMARK", "ACK exceeds initial position or sent tail");
      const ranges: WireGapRange[] = [];
      let previousEnd = nextExpected;
      for (let i = 0; i < count; i++) {
        const start = p.getUint32(12 + i * 8, true), endExclusive = p.getUint32(16 + i * 8, true);
        if (start < previousEnd || start >= endExclusive || endExclusive > observedExclusive) fail("ACK_RANGE", "gaps must be ordered, nonempty and inside watermarks");
        ranges.push({ start, endExclusive });
        previousEnd = endExclusive;
      }
      decoded = { kind: header.opcode === Opcode.ACK ? "ACK" : "GAP_REQUEST", ackSpace: ackSpace as 1 | 2 | 3, nextExpected, observedExclusive, ranges };
      break;
    }
    case Opcode.CLOCK_PING:
    case Opcode.CLOCK_PONG: {
      const isPong = header.opcode === Opcode.CLOCK_PONG;
      if (payload.length !== (isPong ? 28 : 12)) fail("FRAME_LENGTH", "invalid clock payload");
      const probeId = p.getUint32(0, true), t1 = p.getFloat64(4, true);
      finite(t1);
      if (isPong) {
        const t2 = p.getFloat64(12, true), t3 = p.getFloat64(20, true);
        finite(t2); finite(t3);
        if (t3 < t2) fail("CLOCK_SAMPLE", "remote time goes backwards");
        decoded = { kind: "CLOCK_PONG", probeId, t1, t2, t3 };
      } else decoded = { kind: "CLOCK_PING", probeId, t1 };
      break;
    }
  }
  return { header, payload: decoded };
}

function allocatePayload(length: number): Uint8Array {
  integer(length, 0, MAX_PAYLOAD_BYTES, "payload length");
  return new Uint8Array(length);
}
function encodePayload(payload: FramePayload): Uint8Array {
  let result: Uint8Array;
  switch (payload.kind) {
    case "COMMAND":
      bytes(payload.data, "command"); result = allocatePayload(payload.data.length); result.set(payload.data); return result;
    case "INPUT_BATCH": {
      integer(payload.firstTick, 0, MAX_POSITION, "firstTick");
      integer(payload.inputBytes, 1, 65535, "inputBytes");
      integer(payload.inputs.length, 1, 256, "input count");
      result = allocatePayload(8 + payload.inputs.length * payload.inputBytes);
      const view = dataView(result);
      view.setUint32(0, payload.firstTick, true); view.setUint16(4, payload.inputs.length, true); view.setUint16(6, payload.inputBytes, true);
      for (let index = 0; index < payload.inputs.length; index++) {
        const input = payload.inputs[index];
        if (input === undefined) fail("INPUT_BATCH_LENGTH", "missing input record");
        bytes(input, "input");
        if (input.length !== payload.inputBytes) fail("INPUT_BATCH_LENGTH", "input record length");
        result.set(input, 8 + index * payload.inputBytes);
      }
      return result;
    }
    case "STATE": {
      bytes(payload.data, "state"); integer(payload.baseSeq, 0, EXCLUSIVE_END, "baseSeq");
      result = allocatePayload(4 + payload.data.length); dataView(result).setUint32(0, payload.baseSeq, true); result.set(payload.data, 4); return result;
    }
    case "BULK_CHUNK": {
      bytes(payload.data, "chunk"); integer(payload.transferId, 0, EXCLUSIVE_END, "transferId"); integer(payload.offset, 0, EXCLUSIVE_END, "offset");
      result = allocatePayload(8 + payload.data.length); const view = dataView(result);
      view.setUint32(0, payload.transferId, true); view.setUint32(4, payload.offset, true); result.set(payload.data, 8); return result;
    }
    case "ACK":
    case "GAP_REQUEST": {
      integer(payload.ackSpace, 1, 3, "ackSpace"); integer(payload.nextExpected, 0, EXCLUSIVE_END, "nextExpected"); integer(payload.observedExclusive, 0, EXCLUSIVE_END, "observedExclusive");
      integer(payload.ranges.length, 0, MAX_GAP_RANGES, "range count");
      result = allocatePayload(12 + payload.ranges.length * 8); const view = dataView(result);
      view.setUint8(0, payload.ackSpace); view.setUint16(2, payload.ranges.length, true);
      view.setUint32(4, payload.nextExpected, true); view.setUint32(8, payload.observedExclusive, true);
      payload.ranges.forEach((range, index) => {
        integer(range.start, 0, EXCLUSIVE_END, "gap start"); integer(range.endExclusive, 0, EXCLUSIVE_END, "gap end");
        view.setUint32(12 + index * 8, range.start, true); view.setUint32(16 + index * 8, range.endExclusive, true);
      });
      return result;
    }
    case "CLOCK_PING":
    case "CLOCK_PONG": {
      integer(payload.probeId, 0, EXCLUSIVE_END, "probeId"); finite(payload.t1);
      result = allocatePayload(payload.kind === "CLOCK_PING" ? 12 : 28); const view = dataView(result);
      view.setUint32(0, payload.probeId, true); view.setFloat64(4, payload.t1, true);
      if (payload.kind === "CLOCK_PONG") {
        finite(payload.t2); finite(payload.t3);
        view.setFloat64(12, payload.t2, true); view.setFloat64(20, payload.t3, true);
      }
      return result;
    }
  }
}

export function encodeFrame(frame: BinaryFrame, auth: FrameAuthorization): Uint8Array {
  validateHeader(frame.header);
  if (Opcode[frame.payload.kind] !== frame.header.opcode) fail("INVALID_OPCODE", "header/payload kind mismatch");
  const payload = encodePayload(frame.payload);
  const raw = new Uint8Array(HEADER_BYTES + payload.length), view = dataView(raw), h = frame.header;
  view.setUint16(0, MAGIC, true); view.setUint8(2, PROTOCOL_VERSION); view.setUint8(3, h.opcode);
  view.setUint16(4, h.flags, true); view.setUint16(6, h.streamId, true); view.setBigUint64(8, h.contextTag, true);
  view.setUint32(16, h.seq, true); view.setUint32(20, h.tick, true); view.setUint32(24, payload.length, true);
  raw.set(payload, HEADER_BYTES);
  decodeFrame(raw, auth);
  return raw;
}

/** Pure installed-context table; obtaining an authenticated descriptor is P2/P3 work. */
export class BinaryContextRegistry {
  private readonly contexts = new Map<bigint, { context: BinaryContext; signature: string; revoked: boolean }>();
  constructor(private readonly maxContexts: number) { integer(maxContexts, 1, 65536, "maxContexts"); }
  installAuthenticated(context: BinaryContext): void {
    validateContext(context);
    const signature = JSON.stringify(context, (_, value: unknown) => {
      if (typeof value === "bigint") return value.toString(16);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
      }
      return value;
    });
    const existing = this.contexts.get(context.contextTag);
    if (existing) {
      if (existing.signature !== signature) fail("CONTEXT_TAG_COLLISION", "tag already has another meaning");
      if (existing.revoked) fail("CONTEXT_REVOKED", "tag cannot be reused within session");
      return;
    }
    if (this.contexts.size >= this.maxContexts) fail("BACKPRESSURE", "context table full; existing tags retained");
    const copy: BinaryContext = Object.freeze({ ...context,
      endpoints: Object.freeze([...context.endpoints]) as unknown as readonly [string, string],
      streams: Object.freeze(context.streams.map(stream => Object.freeze({ ...stream }))),
    });
    this.contexts.set(context.contextTag, { context: copy, signature, revoked: false });
  }
  revoke(tag: bigint): void { const existing = this.contexts.get(tag); if (existing) existing.revoked = true; }
  decode(raw: Uint8Array, request: Omit<FrameAuthorization, "context" | "revoked">): BinaryFrame {
    const header = parseHeader(raw, MAX_FRAME_BYTES), installed = this.contexts.get(header.contextTag);
    if (!installed) fail("CONTEXT_UNBOUND", "no authenticated installed context");
    return decodeFrame(raw, { ...request, context: installed.context, revoked: installed.revoked });
  }
}
