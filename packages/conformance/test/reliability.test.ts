import test from "node:test";
import assert from "node:assert/strict";
import {
  CommandJournal, PathReadyGate, ReceiveWindow, ReliabilityError, SendHistory,
  type AckWatermark, type CommandIdentity,
} from "../../protocol/src/reliability.js";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ack = (nextExpected: number, observedExclusive: number = nextExpected): AckWatermark => ({
  nextExpected, observedExclusive, ranges: [],
});
const code = (expected: string) => (error: unknown): boolean => error instanceof ReliabilityError && error.code === expected;
const identity: CommandIdentity = { matchId: "m1", seatId: "a", logicalStreamId: "moves", commandSeq: 0 };

test("N99-05 L0: duplicate WS/RTC command identity applies once and returns the original receipt", () => {
  const journal = new CommandJournal<{ total: number }>(8, 1024, "NEW");
  let applied = 0;
  const first = journal.execute(identity, bytes(7), () => ({ total: ++applied }));
  const duplicate = journal.execute(identity, bytes(7), () => ({ total: ++applied }));
  assert.deepEqual(first, { status: "APPLIED", result: { total: 1 } });
  assert.deepEqual(duplicate, { status: "DUPLICATE", result: { total: 1 } });
  assert.equal(applied, 1);
  assert.throws(() => journal.execute(identity, bytes(8), () => ({ total: ++applied })), code("IDEMPOTENCY_CONFLICT"));
  assert.equal(applied, 1);
});

test("N99-06 L0: seq100 remains a hole after 101..166; independent Set model agrees at each arrival", () => {
  const receiver = new ReceiveWindow({ contextId: "ctx", initialPosition: 100, capacity: 128, maxBytes: 1024, maxAhead: 128 });
  const expected = new Set<number>();
  const order = [...Array.from({ length: 66 }, (_, index) => index + 101), 100];
  for (const at of order) {
    expected.add(at);
    let contiguous = 100;
    while (expected.has(contiguous)) contiguous += 1;
    const result = receiver.receive("ctx", { position: at, bytes: bytes(at) });
    assert.equal(result.status, "ACCEPTED");
    assert.equal(receiver.acknowledgement().nextExpected, contiguous);
    if (result.status === "ACCEPTED") {
      assert.deepEqual(result.delivered.map((record) => record.position), at === 100 ? Array.from({ length: 67 }, (_, index) => index + 100) : []);
    }
  }
  assert.deepEqual(receiver.acknowledgement(), ack(167));
  assert.equal(receiver.receive("ctx", { position: 100, bytes: bytes(100) }).status, "DUPLICATE");
});

test("N99-07 L0: missing inputs outside redundant batches retransmit exact original tick records", () => {
  const sender = new SendHistory({ kind: "INPUT", initialPosition: 10, receiverContext: "ctx", capacity: 16, maxBytes: 64 });
  for (let at = 10; at < 18; at += 1) assert.equal(sender.append(bytes(at)).status, "STORED");
  const request: AckWatermark = { nextExpected: 12, observedExclusive: 18, ranges: [{ start: 12, endExclusive: 16 }] };
  const plan = sender.planRetransmission("ctx", request, 8);
  assert.equal(plan.status, "RETRANSMIT");
  if (plan.status === "RETRANSMIT") {
    assert.deepEqual(plan.records.map((record) => [record.position, [...record.bytes]]), [[12, [12]], [13, [13]], [14, [14]], [15, [15]]]);
  }
  assert.equal(sender.next, 18);
});

test("N99-08 L0: seeing105 preserves holes103/104 and cannot release their inputs", () => {
  const receiver = new ReceiveWindow({ contextId: "ctx", initialPosition: 103, capacity: 8, maxBytes: 64, maxAhead: 8 });
  receiver.receive("ctx", { position: 105, bytes: bytes(5) });
  assert.deepEqual(receiver.acknowledgement(), {
    nextExpected: 103, observedExclusive: 106, ranges: [{ start: 103, endExclusive: 105 }],
  });
  const sender = new SendHistory({ kind: "INPUT", initialPosition: 103, receiverContext: "ctx", capacity: 8, maxBytes: 64 });
  for (const at of [103, 104, 105]) sender.append(bytes(at));
  sender.setInputRetention({ rollbackFrom: 106, recoveryFrom: 106 });
  sender.acknowledge("ctx", receiver.acknowledgement());
  assert.deepEqual(sender.lookup(103)?.bytes, bytes(103));
  assert.deepEqual(sender.lookup(104)?.bytes, bytes(104));
  assert.equal(sender.retainedFrom, 103);
});

test("N99-09/T06 L0: occupied circular slot is never overwritten and rejection consumes no sequence", () => {
  const sender = new SendHistory({ kind: "INPUT", initialPosition: 0, receiverContext: "ctx", capacity: 2, maxBytes: 4 });
  assert.deepEqual(sender.append(bytes(1, 2)), { status: "STORED", position: 0 });
  sender.append(bytes(3, 4));
  assert.deepEqual(sender.append(bytes(9)), { status: "HISTORY_EXHAUSTED" });
  assert.equal(sender.next, 2);
  assert.equal(sender.retainedBytes, 4);
  assert.deepEqual(sender.lookup(0)?.bytes, bytes(1, 2));
  sender.acknowledge("ctx", ack(2));
  sender.setInputRetention({ rollbackFrom: 1, recoveryFrom: 2 });
  assert.deepEqual(sender.append(bytes(9)), { status: "STORED", position: 2 });
  assert.equal(sender.lookup(0), undefined);
  assert.deepEqual(sender.lookup(2)?.bytes, bytes(9));
});

test("N99-10 L0: conflicting redundant input rejects the whole batch without ACK or data changes", () => {
  const receiver = new ReceiveWindow({ contextId: "ctx", initialPosition: 10, capacity: 8, maxBytes: 32, maxAhead: 8 });
  receiver.receive("ctx", { position: 11, bytes: bytes(1) });
  const before = receiver.acknowledgement();
  assert.throws(() => receiver.receiveBatch("ctx", [
    { position: 10, bytes: bytes(0) }, { position: 11, bytes: bytes(8) },
  ]), code("INPUT_CONFLICT"));
  assert.deepEqual(receiver.acknowledgement(), before);
  assert.equal(receiver.lookup(10), undefined);
  assert.deepEqual(receiver.lookup(11)?.bytes, bytes(1));
  assert.throws(() => receiver.receiveBatch("ctx", [
    { position: 12, bytes: bytes(1) }, { position: 12, bytes: bytes(2) },
  ]), code("INPUT_CONFLICT"));
  assert.equal(receiver.lookup(12), undefined);
});

test("N99-11 L0: fast channel open cannot bypass delayed reliable PATH_READY", () => {
  const gate = new PathReadyGate(2);
  gate.install("rtc", "ctx", "nonce", ["pwa.reliable", "pwa.fast"]);
  gate.channelInstalled("rtc", "pwa.fast");
  assert.equal(gate.localReady("rtc"), false);
  assert.equal(gate.canSend("rtc"), false);
  gate.channelInstalled("rtc", "pwa.reliable");
  assert.equal(gate.localReady("rtc"), true);
  assert.equal(gate.canSend("rtc"), false);
  assert.throws(() => gate.acceptPeerReady("rtc", "ctx", "nonce", ["pwa.fast"]), code("PATH_NOT_READY"));
  assert.throws(() => gate.acceptPeerReady("rtc", "ctx", "wrong", ["pwa.reliable", "pwa.fast"]), code("PATH_BINDING_MISMATCH"));
  gate.acceptPeerReady("rtc", "ctx", "nonce", ["pwa.fast", "pwa.reliable"]);
  assert.equal(gate.canSend("rtc"), true);
  gate.revoke("rtc");
  assert.equal(gate.canSend("rtc"), false);
});

test("N99-12 L0: restored receipt journal keeps original command identity across authority/context changes", () => {
  let applications = 0;
  const before = new CommandJournal<number>(8, 32, "NEW");
  before.execute({ ...identity, commandSeq: 42 }, bytes(9), () => ++applications);
  const restored = new CommandJournal<number>(8, 32, "RECOVERING");
  restored.restore(before.snapshot());
  assert.deepEqual(restored.execute({ ...identity, commandSeq: 42 }, bytes(9), () => ++applications), { status: "DUPLICATE", result: 1 });
  assert.equal(applications, 1);
  // Context and authority are deliberately absent from the stable business identity.
  assert.equal(restored.snapshot()[0]?.identity.commandSeq, 42);
});

test("N99-12 L0: an authoritative NOT_APPLIED proof allows one application under the original identity", () => {
  const restored = new CommandJournal<number>(8, 32, "RECOVERING");
  restored.restore([], { coverage: "PARTIAL", evidenceId: "checkpoint-with-command-log-gap" });
  let applications = 0;
  assert.throws(() => restored.execute(identity, bytes(9), () => ++applications), code("RECOVERY_UNAVAILABLE"));
  assert.equal(applications, 0);
  restored.installNotAppliedProof(identity, "authorized-owner-outcome-query-17-NOT_APPLIED");
  assert.deepEqual(restored.execute(identity, bytes(9), () => ++applications), { status: "APPLIED", result: 1 });
  assert.deepEqual(restored.execute(identity, bytes(9), () => ++applications), { status: "DUPLICATE", result: 1 });
  assert.equal(applications, 1);
});

test("N99-12 L0: absent receipts without completeness evidence cannot be mistaken for unprocessed commands", () => {
  const recovered = new CommandJournal<number>(8, 32, "RECOVERING");
  recovered.restore([]);
  let applications = 0;
  assert.throws(() => recovered.execute(identity, bytes(4), () => ++applications), code("RECOVERY_UNAVAILABLE"));
  assert.equal(applications, 0);
  assert.deepEqual(recovered.snapshot(), []);
  const complete = new CommandJournal<number>(8, 32, "RECOVERING");
  complete.restore([], { coverage: "COMPLETE", evidenceId: "full-committed-log-and-outcome-query-boundary" });
  assert.deepEqual(complete.execute(identity, bytes(4), () => ++applications), { status: "APPLIED", result: 1 });
  assert.equal(applications, 1);
});

test("N99-13 L0: final valid sequence reaches the sentinel and never wraps to zero", () => {
  const sender = new SendHistory({ kind: "COMMAND", initialPosition: 0xfffffffe, receiverContext: "ctx", capacity: 2, maxBytes: 8 });
  assert.deepEqual(sender.append(bytes(1)), { status: "STORED", position: 0xfffffffe });
  assert.deepEqual(sender.append(bytes(2)), { status: "SEQ_EXHAUSTED" });
  assert.equal(sender.next, 0xffffffff);
  assert.deepEqual(sender.lookup(0xfffffffe)?.bytes, bytes(1));
});

test("N99-15 L0: unrecoverable/recovery-budget gaps explicitly require resync with no outcome decision", () => {
  const sender = new SendHistory({ kind: "INPUT", initialPosition: 0, receiverContext: "old", capacity: 8, maxBytes: 32 });
  for (let at = 0; at < 8; at += 1) sender.append(bytes(at));
  sender.acknowledge("old", ack(8));
  sender.setInputRetention({ rollbackFrom: 8, recoveryFrom: 8 });
  sender.bindReceiverContext("recovered", 3);
  const request = { nextExpected: 3, observedExclusive: 8, ranges: [{ start: 3, endExclusive: 5 }] };
  assert.deepEqual(sender.planRetransmission("recovered", request, 8), { status: "RESYNC_REQUIRED", reason: "HISTORY_MISSING" });
  const receiver = new ReceiveWindow({ contextId: "new", initialPosition: 3, capacity: 2, maxBytes: 8, maxAhead: 4 });
  assert.deepEqual(receiver.receive("new", { position: 7, bytes: bytes(7) }), { status: "RESYNC_REQUIRED", reason: "RECEIVE_BUDGET" });
  assert.deepEqual(receiver.acknowledgement(), ack(3));
});

test("T07 L0: delayed GAP[103,105) after ACK106 is ignored even when released", () => {
  const sender = new SendHistory({ kind: "BULK", initialPosition: 100, receiverContext: "ctx", capacity: 8, maxBytes: 32 });
  for (let at = 100; at < 106; at += 1) sender.append(bytes(at));
  sender.acknowledge("ctx", ack(106));
  assert.equal(sender.retainedFrom, 106);
  assert.deepEqual(sender.planRetransmission("ctx", {
    nextExpected: 103, observedExclusive: 106, ranges: [{ start: 103, endExclusive: 105 }],
  }, 8), { status: "IGNORED", records: [] });
  assert.equal(sender.acknowledgedThrough, 106);
});

test("history retention: COMMAND RECEIVED cannot discard replayable payload before durable result", () => {
  const sender = new SendHistory({ kind: "COMMAND", initialPosition: 0, receiverContext: "ctx", capacity: 1, maxBytes: 8 });
  sender.append(bytes(7));
  sender.acknowledge("ctx", ack(1));
  assert.equal(sender.retainedFrom, 0);
  assert.deepEqual(sender.append(bytes(8)), { status: "BACKPRESSURE" });
  assert.equal(sender.next, 1);
  sender.markRecoverable(1);
  assert.deepEqual(sender.append(bytes(8)), { status: "STORED", position: 1 });
});

test("history retention: INPUT release uses minimum of ACK, rollback and recovery bounds", () => {
  const sender = new SendHistory({ kind: "INPUT", initialPosition: 10, receiverContext: "ctx", capacity: 8, maxBytes: 32 });
  for (let at = 10; at < 16; at += 1) sender.append(bytes(at));
  sender.setInputRetention({ rollbackFrom: 14, recoveryFrom: 12 });
  sender.acknowledge("ctx", ack(15, 16));
  assert.equal(sender.retainedFrom, 12);
  assert.equal(sender.lookup(11), undefined);
  assert.deepEqual(sender.lookup(12)?.bytes, bytes(12));
});

test("new receiver context may restore a lower ACK; old context cannot acknowledge it", () => {
  const sender = new SendHistory({ kind: "COMMAND", initialPosition: 0, receiverContext: "old", capacity: 8, maxBytes: 32 });
  for (let at = 0; at < 8; at += 1) sender.append(bytes(at));
  sender.acknowledge("old", ack(8));
  sender.bindReceiverContext("new", 3);
  assert.equal(sender.acknowledgedThrough, 3);
  assert.throws(() => sender.acknowledge("old", ack(8)), code("STALE_CONTEXT"));
  const plan = sender.planRetransmission("new", { nextExpected: 3, observedExclusive: 8, ranges: [{ start: 3, endExclusive: 5 }] }, 8);
  assert.equal(plan.status, "RETRANSMIT");
  if (plan.status === "RETRANSMIT") assert.deepEqual(plan.records.map((record) => record.position), [3, 4]);
  assert.throws(() => sender.acknowledge("new", ack(9)), code("ACK_RANGE"));
});

test("path drain depends on continuous ACK tails rather than elapsed time or highest observed", () => {
  const gate = new PathReadyGate(1);
  gate.install("old-ws", "ctx", "n", ["ws"]);
  gate.recordTail("old-ws", "command", 106);
  gate.recordTail("old-ws", "input", 200);
  assert.equal(gate.isDrained("old-ws", new Map([["command", 103], ["input", 200]])), false);
  assert.equal(gate.isDrained("old-ws", new Map([["command", 106], ["input", 200]])), true);
});

test("bounded recovery and ownership: rejects excessive resend plan and protects internal buffers", () => {
  const sender = new SendHistory({ kind: "COMMAND", initialPosition: 0, receiverContext: "ctx", capacity: 4, maxBytes: 4 });
  const original = bytes(1);
  sender.append(original);
  original[0] = 9;
  const copy = sender.lookup(0);
  if (copy) copy.bytes[0] = 8;
  assert.deepEqual(sender.lookup(0)?.bytes, bytes(1));
  sender.append(bytes(2));
  sender.append(bytes(3));
  assert.deepEqual(sender.planRetransmission("ctx", { nextExpected: 0, observedExclusive: 3, ranges: [{ start: 0, endExclusive: 3 }] }, 2), {
    status: "RESYNC_REQUIRED", reason: "RECOVERY_BUDGET",
  });
});
