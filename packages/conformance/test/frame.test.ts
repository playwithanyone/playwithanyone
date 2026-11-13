import test from "node:test";
import assert from "node:assert/strict";
import {
  BinaryContextRegistry, decodeFrame, encodeFrame, FrameError,
  Opcode, HAS_TICK, FULL_STATE, EXCLUSIVE_END, MAX_POSITION,
  type BinaryContext, type FrameAuthorization, type BinaryFrame, type FrameHeader,
} from "../../protocol/src/frame.js";

// Published bytes from architecture §9.8, independent of the implementation.
const fromHex = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex.replace(/\s/g, ""), "hex"));
const V1 = fromHex(`
50 57 01 01 00 00 01 00 08 07 06 05 04 03 02 01
07 00 00 00 00 00 00 00 04 00 00 00 00 00 00 00
de ad be ef`);
const V2 = fromHex(`
50 57 01 02 01 00 02 00 08 07 06 05 04 03 02 01
09 00 00 00 66 00 00 00 0b 00 00 00 00 00 00 00
64 00 00 00 03 00 01 00 10 11 12`);
const V3 = fromHex(`
50 57 01 10 00 00 02 00 08 07 06 05 04 03 02 01
00 00 00 00 00 00 00 00 14 00 00 00 00 00 00 00
02 00 01 00 67 00 00 00 6a 00 00 00
67 00 00 00 69 00 00 00`);
const TAG = 0x0102030405060708n;
const context: BinaryContext = {
  descriptorId: "descriptor-test-1", contextTag: TAG, endpoints: ["A", "B"],
  validFromMs: 100, validUntilMs: 1000, maxFrameBytes: 16384, maxBulkBytes: 65536,
  streams: [
    { streamId: 1, logicalStreamId: "command-A-B", fromEndpointId: "A", toEndpointId: "B", kind: "COMMAND", firstPosition: 0, maxAhead: 1024 },
    { streamId: 2, logicalStreamId: "input-A-B", fromEndpointId: "A", toEndpointId: "B", kind: "INPUT", firstPosition: 0, maxAhead: 1024, inputBytes: 1 },
    { streamId: 3, logicalStreamId: "state-A-B", fromEndpointId: "A", toEndpointId: "B", kind: "STATE", firstPosition: 0, maxAhead: 1024, usesTick: false },
    { streamId: 4, logicalStreamId: "bulk-A-B", fromEndpointId: "A", toEndpointId: "B", kind: "BULK", firstPosition: 0, maxAhead: 1024 },
  ],
};
const auth: FrameAuthorization = { context, senderEndpointId: "A", receiverEndpointId: "B", nowMs: 200 };
const ackAuth: FrameAuthorization = { ...auth, senderEndpointId: "B", receiverEndpointId: "A", sentExclusive: new Map([[1, 10], [2, 106], [4, 10]]) };
const header = (opcode: FrameHeader["opcode"], streamId: number, seq = 0, flags = 0, tick = 0): FrameHeader => ({ opcode, streamId, contextTag: TAG, seq, flags, tick });
function rejects(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof FrameError && error.code === code);
}
function altered(source: Uint8Array, offset: number, value: number, width: 1 | 2 | 4 = 1): Uint8Array {
  const copy = source.slice(), view = new DataView(copy.buffer);
  if (width === 1) view.setUint8(offset, value);
  if (width === 2) view.setUint16(offset, value, true);
  if (width === 4) view.setUint32(offset, value, true);
  return copy;
}

test("V1: exact 36-byte COMMAND and lossless u64 context", () => {
  const frame: BinaryFrame = { header: header(Opcode.COMMAND, 1, 7), payload: { kind: "COMMAND", data: fromHex("de ad be ef") } };
  assert.equal(V1.length, 36);
  assert.deepEqual(decodeFrame(V1, auth), frame);
  assert.deepEqual(encodeFrame(frame, auth), V1);
  // A nonzero byteOffset must not change endian or header interpretation.
  const padded = new Uint8Array(50); padded.set(V1, 7);
  assert.deepEqual(decodeFrame(padded.subarray(7, 43), auth), frame);
});

test("V2: exact 43-byte batch with independently addressed input ticks", () => {
  const frame: BinaryFrame = {
    header: header(Opcode.INPUT_BATCH, 2, 9, HAS_TICK, 102),
    payload: { kind: "INPUT_BATCH", firstTick: 100, inputBytes: 1, inputs: [fromHex("10"), fromHex("11"), fromHex("12")] },
  };
  assert.equal(V2.length, 43);
  assert.deepEqual(decodeFrame(V2, auth), frame);
  assert.deepEqual(encodeFrame(frame, auth), V2);
});

test("V3: exact 52-byte input ACK preserves the 103/104 gap", () => {
  const frame: BinaryFrame = {
    header: header(Opcode.ACK, 2),
    payload: { kind: "ACK", ackSpace: 2, nextExpected: 103, observedExclusive: 106, ranges: [{ start: 103, endExclusive: 105 }] },
  };
  assert.equal(V3.length, 52);
  assert.deepEqual(decodeFrame(V3, ackAuth), frame);
  assert.deepEqual(encodeFrame(frame, ackAuth), V3);
});

test("N99-01: incorrect payload length and every truncated header reject without mutation", () => {
  const before = structuredClone(context);
  rejects(() => decodeFrame(altered(V1, 24, 5, 4), auth), "FRAME_LENGTH");
  for (let length = 0; length < 32; length++) rejects(() => decodeFrame(V1.subarray(0, length), auth), "FRAME_LENGTH");
  rejects(() => decodeFrame(new Uint8Array(16385), auth), "FRAME_LENGTH");
  assert.deepEqual(context, before);
});

test("N99-02: malformed input batches reject as a whole", () => {
  rejects(() => decodeFrame(altered(V2, 36, 4, 2), auth), "INPUT_BATCH_LENGTH");
  rejects(() => decodeFrame(altered(V2, 20, 101, 4), auth), "INPUT_BATCH_TICK");
  rejects(() => decodeFrame(altered(V2, 38, 0, 2), auth), "INPUT_BATCH_LENGTH");
  rejects(() => decodeFrame(altered(V2, 32, MAX_POSITION, 4), auth), "INPUT_BATCH_TICK");
  rejects(() => decodeFrame(V2, { ...auth, context: { ...context, streams: context.streams.map(stream => stream.streamId === 2 ? { ...stream, inputBytes: 2 } : stream) } }), "INPUT_BATCH_LENGTH");
  rejects(() => encodeFrame({ header: header(Opcode.INPUT_BATCH, 2, 9, HAS_TICK, 102), payload: { kind: "INPUT_BATCH", firstTick: 100, inputBytes: 1, inputs: Array<Uint8Array>(3) } }, auth), "INPUT_BATCH_LENGTH");
});

test("N99-03: unbound, revoked, expired and wrong-endpoint contexts never admit a frame (L0 fixture)", () => {
  const registry = new BinaryContextRegistry(3);
  rejects(() => registry.decode(altered(V1, 0, 0, 2), auth), "FRAME_MAGIC");
  rejects(() => registry.decode(V1, auth), "CONTEXT_UNBOUND");
  registry.installAuthenticated(context);
  assert.deepEqual(registry.decode(V1, auth), decodeFrame(V1, auth));
  rejects(() => registry.decode(V1, { ...auth, senderEndpointId: "B", receiverEndpointId: "A" }), "FRAME_PERMISSION");
  rejects(() => registry.decode(V1, { ...auth, senderEndpointId: "C" }), "FRAME_PERMISSION");
  rejects(() => registry.decode(V1, { ...auth, nowMs: 1000 }), "AUTH_EXPIRED");
  rejects(() => registry.decode(V1, { ...auth, nowMs: 99 }), "AUTH_EXPIRED");
  registry.revoke(TAG);
  rejects(() => registry.decode(V1, auth), "AUTH_EXPIRED");
  rejects(() => registry.installAuthenticated(context), "CONTEXT_REVOKED");
});

test("N99-04: context tag collision cannot replace the original binding", () => {
  const registry = new BinaryContextRegistry(2);
  registry.installAuthenticated(context);
  registry.installAuthenticated(context);
  const reordered = Object.fromEntries(Object.entries(context).reverse()) as unknown as BinaryContext;
  registry.installAuthenticated(reordered);
  rejects(() => registry.installAuthenticated({ ...context, descriptorId: "forged-descriptor" }), "CONTEXT_TAG_COLLISION");
  assert.deepEqual(registry.decode(V1, auth), decodeFrame(V1, auth));
  const changed = { ...context, contextTag: TAG + 1n, descriptorId: "second" };
  registry.installAuthenticated(changed);
  rejects(() => registry.installAuthenticated({ ...changed, contextTag: TAG + 2n }), "BACKPRESSURE");
  assert.deepEqual(registry.decode(V1, auth), decodeFrame(V1, auth));
});

test("headers: reject magic/version/opcode, reserved flags/fields and illegal type combinations", () => {
  for (const [offset, value, width, code] of [
    [0, 0, 2, "FRAME_MAGIC"], [2, 2, 1, "PROTOCOL_VERSION"], [3, 0xff, 1, "INVALID_OPCODE"],
    [4, 4, 2, "FRAME_FIELD"], [4, 1, 2, "FRAME_FLAGS"], [6, 0, 2, "FRAME_STREAM"],
    [20, 1, 4, "FRAME_FLAGS"], [28, 1, 4, "FRAME_RESERVED"],
  ] as const) rejects(() => decodeFrame(altered(V1, offset, value, width), auth), code);
  rejects(() => decodeFrame(altered(V3, 16, 1, 4), ackAuth), "FRAME_FLAGS");
  rejects(() => decodeFrame(altered(V1, 6, 2, 2), auth), "FRAME_STREAM");
});

test("N99-13: reserved sequence/tick never wraps; maximum valid sequence remains encodable", () => {
  rejects(() => decodeFrame(altered(V1, 16, EXCLUSIVE_END, 4), auth), "SEQ_EXHAUSTED");
  rejects(() => decodeFrame(altered(V2, 20, EXCLUSIVE_END, 4), auth), "SEQ_EXHAUSTED");
  const nearEnd: FrameAuthorization = { ...auth, receivePositions: new Map([[1, MAX_POSITION]]) };
  const last = { header: header(Opcode.COMMAND, 1, MAX_POSITION), payload: { kind: "COMMAND", data: new Uint8Array() } } as const;
  assert.equal(decodeFrame(encodeFrame(last, nearEnd), nearEnd).header.seq, MAX_POSITION);
  rejects(() => encodeFrame({ ...last, header: { ...last.header, seq: EXCLUSIVE_END + 1 } }, nearEnd), "FRAME_FIELD");
});

test("ACK: enforce receiver direction, ack space, sent tail and ordered bounded gaps", () => {
  rejects(() => decodeFrame(V3, auth), "FRAME_PERMISSION");
  rejects(() => decodeFrame(altered(V3, 32, 1), ackAuth), "ACK_SPACE");
  rejects(() => decodeFrame(altered(V3, 33, 1), ackAuth), "FRAME_RESERVED");
  rejects(() => decodeFrame(altered(V3, 40, 107, 4), ackAuth), "ACK_WATERMARK");
  rejects(() => decodeFrame(altered(V3, 44, 102, 4), ackAuth), "ACK_RANGE");
  rejects(() => decodeFrame(altered(V3, 48, 103, 4), ackAuth), "ACK_RANGE");
  rejects(() => decodeFrame(altered(V3, 34, 33, 2), ackAuth), "ACK_LENGTH");
  const empty = { header: header(Opcode.GAP_REQUEST, 2), payload: { kind: "GAP_REQUEST", ackSpace: 2, nextExpected: 106, observedExclusive: 106, ranges: [] } } as const;
  rejects(() => encodeFrame(empty, ackAuth), "ACK_LENGTH");
});

test("state: explicit tick capability and accepted current-context baseline required", () => {
  const full: BinaryFrame = { header: header(Opcode.STATE, 3, 1, FULL_STATE), payload: { kind: "STATE", baseSeq: EXCLUSIVE_END, data: fromHex("12 34") } };
  assert.deepEqual(decodeFrame(encodeFrame(full, auth), auth), full);
  const delta: BinaryFrame = { header: header(Opcode.STATE, 3, 2), payload: { kind: "STATE", baseSeq: 1, data: fromHex("ab") } };
  rejects(() => encodeFrame(delta, auth), "STATE_BASELINE_REQUIRED");
  const installed = { ...auth, stateBaselines: new Map([[3, new Set([1])]]) };
  assert.deepEqual(decodeFrame(encodeFrame(delta, installed), installed), delta);
  rejects(() => encodeFrame({ ...full, header: { ...full.header, flags: FULL_STATE | HAS_TICK, tick: 5 } }, auth), "FRAME_FLAGS");
  rejects(() => encodeFrame({ ...full, payload: { kind: "STATE", baseSeq: 0, data: new Uint8Array() } }, auth), "STATE_BASELINE");
});

test("bulk: chunks require accepted BEGIN, exact offsets, fixed size and final remainder", () => {
  const bulkAuth: FrameAuthorization = { ...auth, bulkTransfers: new Map([[4, new Map([[5, { totalBytes: 5, chunkBytes: 3 }]])]]) };
  const chunk: BinaryFrame = { header: header(Opcode.BULK_CHUNK, 4), payload: { kind: "BULK_CHUNK", transferId: 5, offset: 0, data: fromHex("01 02 03") } };
  rejects(() => encodeFrame(chunk, auth), "BULK_NOT_READY");
  assert.deepEqual(decodeFrame(encodeFrame(chunk, bulkAuth), bulkAuth), chunk);
  const final: BinaryFrame = { ...chunk, payload: { kind: "BULK_CHUNK", transferId: 5, offset: 3, data: fromHex("04 05") } };
  assert.deepEqual(decodeFrame(encodeFrame(final, bulkAuth), bulkAuth), final);
  rejects(() => encodeFrame({ ...chunk, payload: { kind: "BULK_CHUNK", transferId: 5, offset: 1, data: fromHex("01 02 03") } }, bulkAuth), "BULK_CHUNK_RANGE");
});

test("clock: f64 payload lengths, finite values and explicit link auxiliary stream", () => {
  const ping: BinaryFrame = { header: header(Opcode.CLOCK_PING, 0), payload: { kind: "CLOCK_PING", probeId: 9, t1: 1000 } };
  assert.equal(encodeFrame(ping, auth).length, 44);
  assert.deepEqual(decodeFrame(encodeFrame(ping, auth), auth), ping);
  const pong: BinaryFrame = { header: header(Opcode.CLOCK_PONG, 0), payload: { kind: "CLOCK_PONG", probeId: 9, t1: 1000, t2: 1050, t3: 1052 } };
  assert.equal(encodeFrame(pong, auth).length, 60);
  assert.deepEqual(decodeFrame(encodeFrame(pong, auth), auth), pong);
  rejects(() => encodeFrame({ ...ping, payload: { kind: "CLOCK_PING", probeId: 9, t1: NaN } }, auth), "CLOCK_SAMPLE");
  rejects(() => encodeFrame({ ...pong, payload: { kind: "CLOCK_PONG", probeId: 9, t1: 1000, t2: 1050, t3: 1049 } }, auth), "CLOCK_SAMPLE");
});

test("budgets: respect protocol, descriptor and negotiated transport minimum; reject far future input", () => {
  rejects(() => decodeFrame(V1, { ...auth, maxTransportBytes: 35 }), "FRAME_LENGTH");
  rejects(() => decodeFrame(V2, { ...auth, context: { ...context, maxFrameBytes: 40 } }), "FRAME_LENGTH");
  const oversized: BinaryFrame = { header: header(Opcode.COMMAND, 1), payload: { kind: "COMMAND", data: new Uint8Array(16353) } };
  rejects(() => encodeFrame(oversized, auth), "FRAME_FIELD");
  rejects(() => decodeFrame(V2, { ...auth, context: { ...context, streams: context.streams.map(stream => ({ ...stream, maxAhead: 10 })) } }), "RESYNC_REQUIRED");
  const maxFrame: BinaryFrame = { ...oversized, payload: { kind: "COMMAND", data: new Uint8Array(16352) } };
  assert.equal(encodeFrame(maxFrame, auth).length, 16384);
});
