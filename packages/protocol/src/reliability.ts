/** Pure protocol state. Callers must authenticate contexts and persist game receipts elsewhere. */
const MAX_POSITION = 0xfffffffe;
const EXHAUSTED_POSITION = 0xffffffff;

export class ReliabilityError extends Error {
  constructor(readonly code: string, message: string = code) {
    super(message);
    this.name = "ReliabilityError";
  }
}

export interface GapRange {
  readonly start: number;
  readonly endExclusive: number;
}

export interface AckWatermark {
  readonly nextExpected: number;
  readonly observedExclusive: number;
  readonly ranges: readonly GapRange[];
}

export interface HistoryRecord {
  readonly position: number;
  readonly bytes: Uint8Array;
}

export type HistoryKind = "COMMAND" | "INPUT" | "BULK";
export type WriteResult =
  | { readonly status: "STORED"; readonly position: number }
  | { readonly status: "BACKPRESSURE" | "HISTORY_EXHAUSTED" | "SEQ_EXHAUSTED" };

export type ResendPlan =
  | { readonly status: "RETRANSMIT"; readonly records: readonly HistoryRecord[] }
  | { readonly status: "IGNORED"; readonly records: readonly [] }
  | { readonly status: "RESYNC_REQUIRED"; readonly reason: "HISTORY_MISSING" | "RECOVERY_BUDGET" };

function boundary(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > EXHAUSTED_POSITION) {
    throw new ReliabilityError("POSITION_RANGE");
  }
}

function position(value: number): void {
  boundary(value);
  if (value === EXHAUSTED_POSITION) throw new ReliabilityError("SEQ_EXHAUSTED");
}

function positive(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new ReliabilityError("INVALID_BUDGET");
}

function context(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new ReliabilityError("INVALID_CONTEXT");
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function copyRecord(record: HistoryRecord): HistoryRecord {
  return { position: record.position, bytes: record.bytes.slice() };
}

function checkAck(ack: AckWatermark, initial: number, tail: number): void {
  boundary(ack.nextExpected);
  boundary(ack.observedExclusive);
  if (ack.nextExpected < initial || ack.nextExpected > ack.observedExclusive || ack.observedExclusive > tail) {
    throw new ReliabilityError("ACK_RANGE");
  }
  if (!Array.isArray(ack.ranges) || ack.ranges.length > 32) throw new ReliabilityError("ACK_RANGE");
  let previousEnd = ack.nextExpected;
  for (const range of ack.ranges) {
    boundary(range.start);
    boundary(range.endExclusive);
    if (range.start < previousEnd || range.start >= range.endExclusive || range.endExclusive > ack.observedExclusive) {
      throw new ReliabilityError("ACK_RANGE");
    }
    previousEnd = range.endExclusive;
  }
}

export interface SendHistoryOptions {
  readonly kind: HistoryKind;
  readonly initialPosition: number;
  readonly receiverContext: string;
  readonly capacity: number;
  readonly maxBytes: number;
}

/** Absolute tags protect circular slots. RECEIVED and durable recovery boundaries stay separate. */
export class SendHistory {
  readonly kind: HistoryKind;
  private readonly slots: (HistoryRecord | undefined)[];
  private readonly maxBytes: number;
  private nextPosition: number;
  private floor: number;
  private bytesUsed = 0;
  private receiverContext: string;
  private receiverInitial: number;
  private receivedNext: number;
  private recoverableExclusive: number;
  private rollbackFrom: number;
  private recoveryFrom: number;

  constructor(options: SendHistoryOptions) {
    boundary(options.initialPosition);
    positive(options.capacity);
    positive(options.maxBytes);
    context(options.receiverContext);
    if (!["COMMAND", "INPUT", "BULK"].includes(options.kind)) throw new ReliabilityError("INVALID_KIND");
    this.kind = options.kind;
    this.slots = Array.from({ length: options.capacity });
    this.maxBytes = options.maxBytes;
    this.nextPosition = options.initialPosition;
    this.floor = options.initialPosition;
    this.receiverContext = options.receiverContext;
    this.receiverInitial = options.initialPosition;
    this.receivedNext = options.initialPosition;
    this.recoverableExclusive = options.initialPosition;
    this.rollbackFrom = options.initialPosition;
    this.recoveryFrom = options.initialPosition;
  }

  get next(): number { return this.nextPosition; }
  get retainedFrom(): number { return this.floor; }
  get acknowledgedThrough(): number { return this.receivedNext; }
  get retainedBytes(): number { return this.bytesUsed; }

  append(bytes: Uint8Array): WriteResult {
    if (this.nextPosition > MAX_POSITION) return { status: "SEQ_EXHAUSTED" };
    if (!(bytes instanceof Uint8Array)) throw new ReliabilityError("INVALID_BYTES");
    const slot = this.nextPosition % this.slots.length;
    if (this.slots[slot] !== undefined || bytes.byteLength > this.maxBytes - this.bytesUsed) {
      return { status: this.kind === "INPUT" ? "HISTORY_EXHAUSTED" : "BACKPRESSURE" };
    }
    const record = { position: this.nextPosition, bytes: bytes.slice() };
    this.slots[slot] = record;
    this.bytesUsed += bytes.byteLength;
    this.nextPosition += 1;
    return { status: "STORED", position: record.position };
  }

  lookup(absolutePosition: number): HistoryRecord | undefined {
    position(absolutePosition);
    const entry = this.slots[absolutePosition % this.slots.length];
    return entry?.position === absolutePosition ? copyRecord(entry) : undefined;
  }

  /** A trusted owner explicitly installs the actual recovered receiver baseline, including lower ones. */
  bindReceiverContext(receiverContext: string, initialPosition: number): void {
    context(receiverContext);
    boundary(initialPosition);
    if (initialPosition > this.nextPosition) throw new ReliabilityError("ACK_RANGE");
    if (receiverContext === this.receiverContext) {
      if (initialPosition !== this.receiverInitial) throw new ReliabilityError("CONTEXT_CONFLICT");
      return;
    }
    this.receiverContext = receiverContext;
    this.receiverInitial = initialPosition;
    this.receivedNext = initialPosition;
  }

  acknowledge(receiverContext: string, ack: AckWatermark): number {
    this.checkContext(receiverContext);
    checkAck(ack, this.receiverInitial, this.nextPosition);
    this.receivedNext = Math.max(this.receivedNext, ack.nextExpected);
    this.releaseEligible();
    return this.receivedNext;
  }

  /** Only a committed, queryable result or authorized recovery boundary may call this. */
  markRecoverable(exclusive: number): void {
    if (this.kind !== "COMMAND") throw new ReliabilityError("INVALID_KIND");
    boundary(exclusive);
    if (exclusive < this.recoverableExclusive || exclusive > this.nextPosition) throw new ReliabilityError("RETENTION_RANGE");
    this.recoverableExclusive = exclusive;
    this.releaseEligible();
  }

  setInputRetention(retention: { readonly rollbackFrom: number; readonly recoveryFrom: number }): void {
    if (this.kind !== "INPUT") throw new ReliabilityError("INVALID_KIND");
    boundary(retention.rollbackFrom);
    boundary(retention.recoveryFrom);
    if (Math.min(retention.rollbackFrom, retention.recoveryFrom) < this.floor ||
        Math.max(retention.rollbackFrom, retention.recoveryFrom) > this.nextPosition) {
      throw new ReliabilityError("RETENTION_RANGE");
    }
    this.rollbackFrom = retention.rollbackFrom;
    this.recoveryFrom = retention.recoveryFrom;
    this.releaseEligible();
  }

  planRetransmission(receiverContext: string, request: AckWatermark, maxRecords: number): ResendPlan {
    positive(maxRecords);
    if (request.ranges.length === 0) throw new ReliabilityError("GAP_REQUIRED");
    this.acknowledge(receiverContext, request);
    const ranges = request.ranges
      .map((range) => ({ start: Math.max(range.start, this.receivedNext), endExclusive: range.endExclusive }))
      .filter((range) => range.start < range.endExclusive);
    const count = ranges.reduce((sum, range) => sum + range.endExclusive - range.start, 0);
    if (count === 0) return { status: "IGNORED", records: [] };
    if (count > maxRecords) return { status: "RESYNC_REQUIRED", reason: "RECOVERY_BUDGET" };
    const records: HistoryRecord[] = [];
    for (const range of ranges) {
      for (let at = range.start; at < range.endExclusive; at += 1) {
        const record = this.lookup(at);
        if (!record) return { status: "RESYNC_REQUIRED", reason: "HISTORY_MISSING" };
        records.push(record);
      }
    }
    return { status: "RETRANSMIT", records };
  }

  private checkContext(receiverContext: string): void {
    if (receiverContext !== this.receiverContext) throw new ReliabilityError("STALE_CONTEXT");
  }

  private releaseEligible(): void {
    const limit = this.kind === "COMMAND"
      ? Math.min(this.receivedNext, this.recoverableExclusive)
      : this.kind === "INPUT"
        ? Math.min(this.receivedNext, this.rollbackFrom, this.recoveryFrom)
        : this.receivedNext;
    while (this.floor < limit) {
      const slot = this.floor % this.slots.length;
      const entry = this.slots[slot];
      if (entry?.position === this.floor) {
        this.bytesUsed -= entry.bytes.byteLength;
        this.slots[slot] = undefined;
      }
      this.floor += 1;
    }
  }
}

export interface ReceiveWindowOptions {
  readonly contextId: string;
  readonly initialPosition: number;
  readonly capacity: number;
  readonly maxBytes: number;
  readonly maxAhead: number;
}

export type ReceiveResult =
  | { readonly status: "ACCEPTED" | "DUPLICATE"; readonly delivered: readonly HistoryRecord[] }
  | { readonly status: "RESYNC_REQUIRED"; readonly reason: "HISTORY_RELEASED" | "RECEIVE_BUDGET" };

/** A bounded, atomic input ledger; batch packet sequence numbers never replace per-tick identity. */
export class ReceiveWindow {
  private readonly records = new Map<number, Uint8Array>();
  private readonly options: ReceiveWindowOptions;
  private nextPosition: number;
  private observed: number;
  private retainedFloor: number;
  private bytesUsed = 0;

  constructor(options: ReceiveWindowOptions) {
    boundary(options.initialPosition);
    context(options.contextId);
    positive(options.capacity);
    positive(options.maxBytes);
    positive(options.maxAhead);
    this.options = { ...options };
    this.nextPosition = options.initialPosition;
    this.observed = options.initialPosition;
    this.retainedFloor = options.initialPosition;
  }

  receive(contextId: string, record: HistoryRecord): ReceiveResult {
    return this.receiveBatch(contextId, [record]);
  }

  receiveBatch(contextId: string, batch: readonly HistoryRecord[]): ReceiveResult {
    if (contextId !== this.options.contextId) throw new ReliabilityError("STALE_CONTEXT");
    if (batch.length === 0 || batch.length > 256) throw new ReliabilityError("INPUT_BATCH_LENGTH");
    const additions = new Map<number, Uint8Array>();
    let newBytes = 0;
    for (const record of batch) {
      position(record.position);
      if (!(record.bytes instanceof Uint8Array)) throw new ReliabilityError("INVALID_BYTES");
      if (record.position < this.retainedFloor) return { status: "RESYNC_REQUIRED", reason: "HISTORY_RELEASED" };
      if (record.position - this.nextPosition >= this.options.maxAhead) {
        return { status: "RESYNC_REQUIRED", reason: "RECEIVE_BUDGET" };
      }
      const existing = this.records.get(record.position) ?? additions.get(record.position);
      if (existing !== undefined) {
        if (!equalBytes(existing, record.bytes)) throw new ReliabilityError("INPUT_CONFLICT");
      } else {
        additions.set(record.position, record.bytes.slice());
        newBytes += record.bytes.byteLength;
      }
    }
    if (additions.size + this.records.size > this.options.capacity || newBytes > this.options.maxBytes - this.bytesUsed) {
      return { status: "RESYNC_REQUIRED", reason: "RECEIVE_BUDGET" };
    }
    for (const [at, bytes] of additions) {
      this.records.set(at, bytes);
      this.observed = Math.max(this.observed, at + 1);
    }
    this.bytesUsed += newBytes;
    const delivered: HistoryRecord[] = [];
    while (this.nextPosition <= MAX_POSITION) {
      const bytes = this.records.get(this.nextPosition);
      if (bytes === undefined) break;
      delivered.push({ position: this.nextPosition, bytes: bytes.slice() });
      this.nextPosition += 1;
    }
    return { status: additions.size === 0 ? "DUPLICATE" : "ACCEPTED", delivered };
  }

  acknowledgement(): AckWatermark {
    const known = [...this.records.keys()].filter((at) => at >= this.nextPosition).sort((a, b) => a - b);
    const ranges: GapRange[] = [];
    let cursor = this.nextPosition;
    for (const at of known) {
      if (at > cursor && ranges.length < 32) ranges.push({ start: cursor, endExclusive: at });
      cursor = at + 1;
    }
    if (cursor < this.observed && ranges.length < 32) ranges.push({ start: cursor, endExclusive: this.observed });
    return { nextExpected: this.nextPosition, observedExclusive: this.observed, ranges };
  }

  lookup(at: number): HistoryRecord | undefined {
    position(at);
    const bytes = this.records.get(at);
    return bytes === undefined ? undefined : { position: at, bytes: bytes.slice() };
  }

  /** Owner explicitly states that rollback/recovery no longer needs positions below this watermark. */
  releaseBefore(exclusive: number): void {
    boundary(exclusive);
    if (exclusive < this.retainedFloor || exclusive > this.nextPosition) throw new ReliabilityError("RETENTION_RANGE");
    for (const [at, bytes] of this.records) {
      if (at < exclusive) {
        this.records.delete(at);
        this.bytesUsed -= bytes.byteLength;
      }
    }
    this.retainedFloor = exclusive;
  }
}

export interface CommandIdentity {
  readonly matchId: string;
  readonly seatId: string;
  readonly logicalStreamId: string;
  readonly commandSeq: number;
}

export interface CommandRecord<Result> {
  readonly identity: CommandIdentity;
  readonly bytes: Uint8Array;
  readonly result: Result;
}

export interface CommandReceipt<Result> {
  readonly status: "APPLIED" | "DUPLICATE";
  readonly result: Result;
}

export interface JournalRecoveryEvidence {
  readonly coverage: "COMPLETE" | "PARTIAL";
  readonly evidenceId: string;
}

function commandKey(identity: CommandIdentity): string {
  context(identity.matchId);
  context(identity.seatId);
  context(identity.logicalStreamId);
  position(identity.commandSeq);
  return JSON.stringify([identity.matchId, identity.seatId, identity.logicalStreamId, identity.commandSeq]);
}

/**
 * L0 receipt model, not a durable journal. NEW means an explicitly new logical history.
 * Recovery completeness/query proofs must come from the authorized owner, never the peer.
 * capacity bounds record count and maxPayloadBytes only bounds retained command bytes;
 * fixture results must themselves be bounded. This is not a production memory budget.
 * Production rule/result/receipt commits must be one durable owner transaction.
 */
export class CommandJournal<Result> {
  private readonly records = new Map<string, CommandRecord<Result>>();
  private readonly notAppliedProofs = new Set<string>();
  private bytesUsed = 0;
  private recoveryComplete: boolean;
  private restored: boolean;

  constructor(
    private readonly capacity: number,
    private readonly maxPayloadBytes: number,
    origin: "NEW" | "RECOVERING",
  ) {
    positive(capacity);
    positive(maxPayloadBytes);
    if (origin !== "NEW" && origin !== "RECOVERING") throw new ReliabilityError("INVALID_JOURNAL_ORIGIN");
    this.recoveryComplete = origin === "NEW";
    this.restored = origin === "NEW";
  }

  execute(identity: CommandIdentity, bytes: Uint8Array, apply: () => Result): CommandReceipt<Result> {
    const key = commandKey(identity);
    if (!(bytes instanceof Uint8Array)) throw new ReliabilityError("INVALID_BYTES");
    const existing = this.records.get(key);
    if (existing) {
      if (!equalBytes(existing.bytes, bytes)) throw new ReliabilityError("IDEMPOTENCY_CONFLICT");
      return { status: "DUPLICATE", result: structuredClone(existing.result) };
    }
    if (!this.recoveryComplete && !this.notAppliedProofs.has(key)) {
      throw new ReliabilityError("RECOVERY_UNAVAILABLE", "No complete history or authoritative NOT_APPLIED proof for this command");
    }
    const countAfterReservation = this.records.size + this.notAppliedProofs.size - (this.notAppliedProofs.has(key) ? 1 : 0);
    if (countAfterReservation >= this.capacity || bytes.byteLength > this.maxPayloadBytes - this.bytesUsed) {
      throw new ReliabilityError("BACKPRESSURE");
    }
    const stableIdentity: CommandIdentity = {
      matchId: identity.matchId, seatId: identity.seatId, logicalStreamId: identity.logicalStreamId, commandSeq: identity.commandSeq,
    };
    const stableBytes = bytes.slice();
    const result = structuredClone(apply());
    this.records.set(key, { identity: stableIdentity, bytes: stableBytes, result });
    this.notAppliedProofs.delete(key);
    this.bytesUsed += stableBytes.byteLength;
    return { status: "APPLIED", result: structuredClone(result) };
  }

  /** Models a successful authoritative outcome query, not a timeout or an absent checkpoint entry. */
  installNotAppliedProof(identity: CommandIdentity, evidenceId: string): void {
    const key = commandKey(identity);
    context(evidenceId);
    if (this.records.has(key)) throw new ReliabilityError("IDEMPOTENCY_CONFLICT");
    if (this.notAppliedProofs.size + this.records.size >= this.capacity && !this.notAppliedProofs.has(key)) {
      throw new ReliabilityError("BACKPRESSURE");
    }
    this.notAppliedProofs.add(key);
  }

  snapshot(): readonly CommandRecord<Result>[] {
    return [...this.records.values()].map((record) => ({
      identity: { ...record.identity }, bytes: record.bytes.slice(), result: structuredClone(record.result),
    }));
  }

  restore(records: readonly CommandRecord<Result>[], evidence?: JournalRecoveryEvidence): void {
    if (this.restored || this.records.size !== 0 || this.notAppliedProofs.size !== 0) throw new ReliabilityError("JOURNAL_NOT_EMPTY");
    if (evidence !== undefined) {
      context(evidence.evidenceId);
      if (evidence.coverage !== "COMPLETE" && evidence.coverage !== "PARTIAL") throw new ReliabilityError("INVALID_RECOVERY_EVIDENCE");
    }
    if (records.length > this.capacity) throw new ReliabilityError("BACKPRESSURE");
    const prepared = new Map<string, CommandRecord<Result>>();
    let bytesUsed = 0;
    for (const record of records) {
      const key = commandKey(record.identity);
      if (!(record.bytes instanceof Uint8Array) || prepared.has(key)) throw new ReliabilityError("INVALID_JOURNAL");
      bytesUsed += record.bytes.byteLength;
      if (bytesUsed > this.maxPayloadBytes) throw new ReliabilityError("BACKPRESSURE");
      prepared.set(key, { identity: { ...record.identity }, bytes: record.bytes.slice(), result: structuredClone(record.result) });
    }
    for (const [key, record] of prepared) this.records.set(key, record);
    this.bytesUsed = bytesUsed;
    this.recoveryComplete = evidence?.coverage === "COMPLETE";
    this.restored = true;
  }
}

interface PathState {
  readonly contextId: string;
  readonly nonce: string;
  readonly requiredChannels: readonly string[];
  readonly installed: Set<string>;
  readonly tails: Map<string, number>;
  peerReady: boolean;
  revoked: boolean;
}

/** Handshake/readiness bookkeeping only; installing a path is a trusted, already-authorized operation. */
export class PathReadyGate {
  private readonly paths = new Map<string, PathState>();

  constructor(private readonly maxPaths: number) { positive(maxPaths); }

  install(pathId: string, contextId: string, nonce: string, requiredChannels: readonly string[]): void {
    context(pathId);
    context(contextId);
    context(nonce);
    if (this.paths.has(pathId)) throw new ReliabilityError("PATH_ALREADY_BOUND");
    if (this.paths.size >= this.maxPaths) throw new ReliabilityError("PATH_BUDGET");
    if (requiredChannels.length < 1 || requiredChannels.length > 64 || new Set(requiredChannels).size !== requiredChannels.length) {
      throw new ReliabilityError("INVALID_CHANNELS");
    }
    for (const channel of requiredChannels) context(channel);
    this.paths.set(pathId, {
      contextId, nonce, requiredChannels: [...requiredChannels], installed: new Set(), tails: new Map(), peerReady: false, revoked: false,
    });
  }

  channelInstalled(pathId: string, channel: string): void {
    const path = this.path(pathId);
    if (!path.requiredChannels.includes(channel)) throw new ReliabilityError("INVALID_CHANNEL");
    path.installed.add(channel);
  }

  localReady(pathId: string): boolean {
    const path = this.paths.get(pathId);
    return path !== undefined && !path.revoked && path.requiredChannels.every((channel) => path.installed.has(channel));
  }

  acceptPeerReady(pathId: string, contextId: string, nonce: string, channels: readonly string[]): void {
    const path = this.path(pathId);
    if (contextId !== path.contextId || nonce !== path.nonce) throw new ReliabilityError("PATH_BINDING_MISMATCH");
    if (channels.length !== path.requiredChannels.length || new Set(channels).size !== channels.length ||
        !path.requiredChannels.every((channel) => channels.includes(channel))) throw new ReliabilityError("PATH_NOT_READY");
    path.peerReady = true;
  }

  canSend(pathId: string): boolean {
    return this.localReady(pathId) && this.paths.get(pathId)?.peerReady === true;
  }

  recordTail(pathId: string, logicalStreamId: string, exclusive: number): void {
    const path = this.path(pathId);
    context(logicalStreamId);
    boundary(exclusive);
    const previous = path.tails.get(logicalStreamId);
    if (previous !== undefined && exclusive < previous) throw new ReliabilityError("TAIL_REGRESSION");
    if (previous === undefined && path.tails.size >= 64) throw new ReliabilityError("PATH_BUDGET");
    path.tails.set(logicalStreamId, exclusive);
  }

  isDrained(pathId: string, acknowledged: ReadonlyMap<string, number>): boolean {
    const path = this.path(pathId);
    return [...path.tails].every(([stream, tail]) => {
      const received = acknowledged.get(stream);
      if (received === undefined) return false;
      boundary(received);
      return received >= tail;
    });
  }

  revoke(pathId: string): void { this.path(pathId).revoked = true; }

  private path(pathId: string): PathState {
    const path = this.paths.get(pathId);
    if (!path || path.revoked) throw new ReliabilityError("STALE_PATH");
    return path;
  }
}
