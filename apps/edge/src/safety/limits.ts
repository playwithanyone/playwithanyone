import { SafetyError, type SafetyPolicy, type PoolQuota, type ExecutionClass } from "./config.js";

export interface SafetyStore {
  transaction<T>(callback: () => T): T;
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
}
export interface SafetySqlStorage {
  readonly sql: { exec(query: string, ...bindings: (string | number | null | ArrayBuffer)[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(callback: () => T): T;
}
/** Uses the existing owner's SQLite; no BudgetGuardDO or independent balance service. */
export class SqlSafetyStore implements SafetyStore {
  constructor(private readonly storage: SafetySqlStorage) {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS safety_records (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }
  transaction<T>(callback: () => T): T { return this.storage.transactionSync(callback); }
  get<T>(key: string): T | undefined {
    const row = this.storage.sql.exec("SELECT value FROM safety_records WHERE key = ?", key).toArray()[0];
    return row ? JSON.parse(String(row["value"])) as T : undefined;
  }
  put(key: string, value: unknown): void {
    this.storage.sql.exec("INSERT INTO safety_records (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, JSON.stringify(value));
  }
}
export type ProtectionLevel = "NORMAL" | "WARNING" | "DRAINING" | "BLOCKED";
export interface ProtectionState {
  readonly version: number;
  readonly environment: string;
  readonly scope: "gameplay";
  readonly state: ProtectionLevel;
  readonly reason: string;
  readonly issuedAt: number;
  readonly validUntil: number;
  readonly drainUntil: number | null;
  readonly operator: string;
  readonly incidentId: string | null;
}
export interface RecoveryAuthorization {
  readonly authenticated: boolean;
  readonly actor: string;
  readonly reason: string;
  readonly configurationVersion: string;
  readonly validationRecord: string;
}
const rank: Record<ProtectionLevel, number> = { NORMAL: 0, WARNING: 1, DRAINING: 2, BLOCKED: 3 };
function nonNegative(value: number, name: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new SafetyError("SAFETY_INVALID", name); }
function identifier(value: string): void { if (!/^[a-zA-Z0-9._:-]{1,192}$/.test(value)) throw new SafetyError("SAFETY_INVALID", "identifier"); }
function cycleNow(policy: SafetyPolicy, now: number): void {
  nonNegative(now, "time");
  if (now < policy.cycle.startsAt || now >= policy.cycle.endsAt) throw new SafetyError("SAFETY_EXPIRED", "policy cycle");
}
function defaultProtection(policy: SafetyPolicy): ProtectionState {
  return { version: 0, environment: policy.environment, scope: "gameplay", state: "NORMAL", reason: "EXPLICIT_PREVIEW_LIMITS", issuedAt: policy.cycle.startsAt, validUntil: policy.cycle.endsAt, drainUntil: null, operator: "configuration", incidentId: null };
}
class Protection {
  constructor(protected readonly policy: SafetyPolicy, protected readonly store: SafetyStore) {}
  protectionState(): ProtectionState { return this.store.get<ProtectionState>("protection") ?? defaultProtection(this.policy); }
  applyProtection(update: ProtectionState): boolean { return this.changeProtection(update); }
  recoverProtection(update: ProtectionState, authorization: RecoveryAuthorization): boolean {
    if (!authorization.authenticated || !authorization.actor || !authorization.reason || !authorization.configurationVersion || !authorization.validationRecord || update.operator !== authorization.actor || update.state !== "NORMAL") throw new SafetyError("RECOVERY_REQUIRED", "authenticated manual recovery record required");
    return this.changeProtection(update, authorization);
  }
  private changeProtection(update: ProtectionState, recovery?: RecoveryAuthorization): boolean {
    nonNegative(update.version, "state version"); nonNegative(update.issuedAt, "state issue time"); nonNegative(update.validUntil, "state expiry");
    if (!Object.hasOwn(rank, update.state) || update.environment !== this.policy.environment || update.scope !== "gameplay" || !update.reason || !update.operator || update.validUntil <= update.issuedAt || update.validUntil > this.policy.cycle.endsAt || (update.state === "DRAINING" && (update.drainUntil === null || update.drainUntil <= update.issuedAt || update.drainUntil > update.validUntil))) throw new SafetyError("SAFETY_INVALID", "protection state");
    return this.store.transaction(() => {
      const old = this.protectionState();
      if (update.version <= old.version) return false;
      if (!recovery && (rank[update.state] < rank[old.state] || (old.validUntil <= update.issuedAt && update.state === "NORMAL"))) throw new SafetyError("RECOVERY_REQUIRED", "state cannot be automatically lowered or unlocked after expiry");
      this.store.put("protection", update);
      if (recovery) this.store.put(`recovery:${update.version}`, { ...recovery, issuedAt: update.issuedAt });
      return true;
    });
  }
  protected assertProtection(now: number, existing = false): void {
    cycleNow(this.policy, now);
    const state = this.protectionState();
    if (state.validUntil <= now) throw new SafetyError("SAFETY_EXPIRED", "protection state is stale");
    if (state.state === "BLOCKED" || (state.state === "DRAINING" && (!existing || state.drainUntil === null || now >= state.drainUntil))) throw new SafetyError("SAFETY_BLOCKED", state.reason);
  }
}
interface Usage {
  cycleId: string; startsAt: number; endsAt: number; active: number; cycleCreates: number; cycleActivityMs: number;
  day: number; dayCreates: number; dayActivityMs: number; minute: number; minuteCreates: number;
}
interface Reservation { assignmentId: string; poolId: string; accountingKey?: string; executionClass?: ExecutionClass; activityMs: number; createdAt: number; cycleId?: string; terminal: "ACTIVE" | "CLOSED" | "REVOKED"; actualActivityMs?: number; finalizationId?: string }
export interface TrustedRoomSettlement { readonly actualActivityMs: number; readonly finalizationId: string }
export interface AssignmentRequest { readonly assignmentId: string; readonly poolId: string; readonly now: number; readonly activityMs: number }
/** Instantiate only inside the configured MatchPoolDO. Fixed pool shares sum to <= global limits. */
export class SafetyLimits extends Protection {
  constructor(policy: SafetyPolicy, store: SafetyStore) { super(policy, store); }
  assertCanStart(now: number): void { this.assertProtection(now); }
  /** Static pool shares are partitioned under execution/global limits. Each shard owns only its share. */
  poolQuota(poolId: string): PoolQuota {
    const quota = this.policy.pools.find(pool => pool.poolId === poolId || pool.legacyPoolIds.includes(poolId));
    if (!quota) throw new SafetyError("SAFETY_LIMIT", "unapproved pool");
    return quota;
  }
  private accountingKey(poolId: string): string { return this.poolQuota(poolId).accountingKey; }
  reserveAssignment(request: AssignmentRequest, commit?: () => void): { readonly duplicate: boolean; readonly assignmentId: string } {
    identifier(request.assignmentId); identifier(request.poolId); nonNegative(request.activityMs, "activity allowance");
    const quota = this.poolQuota(request.poolId), execution = this.policy.executionClasses.find(item => item.executionClass === quota.executionClass)!;
    if (!quota.enabled || !execution.enabled) throw new SafetyError("SAFETY_LIMIT", "execution class disabled");
    if (quota.executionClass === "realtime-tick" ? request.activityMs < 1 || request.activityMs > execution.maxRoomLifetimeMs : request.activityMs !== 0) throw new SafetyError("SAFETY_INVALID", "execution activity reservation");
    return this.store.transaction(() => {
      const key = `assignment:${request.assignmentId}`;
      const old = this.store.get<Reservation>(key);
      // Retries reveal their original reservation but never create fresh activity or capacity.
      if (old) {
        if (this.accountingKey(old.poolId) !== quota.accountingKey || old.activityMs !== request.activityMs) throw new SafetyError("SAFETY_INVALID", "reservation identity conflict");
        return { duplicate: true, assignmentId: old.assignmentId };
      }
      this.assertProtection(request.now);
      const usageKey = `usage:${quota.accountingKey}`;
      let usage = this.store.get<Usage>(usageKey);
      const day = Math.floor(request.now / 86_400_000), minute = Math.floor(request.now / 60_000);
      if (usage && (usage.cycleId !== this.policy.cycle.id || usage.startsAt !== this.policy.cycle.startsAt || usage.endsAt !== this.policy.cycle.endsAt)) {
        if (request.now < usage.endsAt || this.policy.cycle.startsAt < usage.endsAt) throw new SafetyError("SAFETY_INVALID", "overlapping or rolled-back quota cycle");
        usage = { ...usage, cycleId: this.policy.cycle.id, startsAt: this.policy.cycle.startsAt, endsAt: this.policy.cycle.endsAt, cycleCreates: 0, cycleActivityMs: 0 };
      }
      usage ??= { cycleId: this.policy.cycle.id, startsAt: this.policy.cycle.startsAt, endsAt: this.policy.cycle.endsAt, active: 0, cycleCreates: 0, cycleActivityMs: 0, day, dayCreates: 0, dayActivityMs: 0, minute, minuteCreates: 0 };
      if (day < usage.day || minute < usage.minute) throw new SafetyError("SAFETY_INVALID", "clock rollback");
      if (usage.day !== day) { usage.day = day; usage.dayCreates = 0; usage.dayActivityMs = 0; }
      if (usage.minute !== minute) { usage.minute = minute; usage.minuteCreates = 0; }
      if (usage.active + 1 > quota.maxActiveRooms || usage.minuteCreates + 1 > quota.maxCreatesPerMinute || usage.dayCreates + 1 > quota.maxCreatesPerDay || usage.cycleCreates + 1 > quota.maxCreatesPerCycle || usage.dayActivityMs + request.activityMs > quota.maxActivityMsPerDay || usage.cycleActivityMs + request.activityMs > quota.maxActivityMsPerCycle) throw new SafetyError("SAFETY_LIMIT", "pool capacity, creation or cumulative activity quota");
      usage.active += 1; usage.minuteCreates += 1; usage.dayCreates += 1; usage.cycleCreates += 1; usage.dayActivityMs += request.activityMs; usage.cycleActivityMs += request.activityMs;
      this.store.put(usageKey, usage);
      this.store.put(key, { assignmentId: request.assignmentId, poolId: quota.poolId, accountingKey: quota.accountingKey, executionClass: quota.executionClass, activityMs: request.activityMs, createdAt: request.now, cycleId: this.policy.cycle.id, terminal: "ACTIVE" } satisfies Reservation);
      commit?.();
      return { duplicate: false, assignmentId: request.assignmentId };
    });
  }
  releaseAssignment(request: { readonly assignmentId: string; readonly terminal: "CLOSED" | "REVOKED"; readonly now: number; readonly settlement?: TrustedRoomSettlement }): boolean {
    identifier(request.assignmentId); nonNegative(request.now, "time");
    if (!["CLOSED", "REVOKED"].includes(request.terminal)) throw new SafetyError("SAFETY_INVALID", "trusted terminal proof required");
    return this.store.transaction(() => {
      const key = `assignment:${request.assignmentId}`, item = this.store.get<Reservation>(key);
      if (!item) return false;
      if (request.settlement) { nonNegative(request.settlement.actualActivityMs, "actual room activity"); identifier(request.settlement.finalizationId);
        if (item.executionClass !== "realtime-tick" || request.settlement.actualActivityMs > item.activityMs) throw new SafetyError("SAFETY_INVALID", "room settlement exceeds reserved lifetime");
      }
      if (item.terminal !== "ACTIVE") {
        if (request.settlement && item.finalizationId && (item.finalizationId !== request.settlement.finalizationId || item.actualActivityMs !== request.settlement.actualActivityMs)) throw new SafetyError("SAFETY_INVALID", "conflicting room settlement");
        return false;
      }
      const accountingKey = item.accountingKey ?? this.accountingKey(item.poolId);
      const usage = this.store.get<Usage>(`usage:${accountingKey}`);
      if (!usage || usage.active < 1) throw new SafetyError("SAFETY_INVALID", "capacity accounting conflict");
      usage.active -= 1;
      // Only the server-side finalizer supplies a trusted exact settlement. Unknown
      // termination never refunds prepaid time. Creation/rate counts never refund.
      if (request.settlement) {
        const unused = item.activityMs - request.settlement.actualActivityMs;
        if (usage.cycleId === item.cycleId) usage.cycleActivityMs = Math.max(0, usage.cycleActivityMs - unused);
        if (usage.day === Math.floor(item.createdAt / 86_400_000)) usage.dayActivityMs = Math.max(0, usage.dayActivityMs - unused);
      }
      this.store.put(`usage:${accountingKey}`, usage);
      this.store.put(key, { ...item, terminal: request.terminal, closedAt: request.now, ...(request.settlement ? { actualActivityMs: request.settlement.actualActivityMs, finalizationId: request.settlement.finalizationId } : {}) });
      return true;
    });
  }
  usage(poolId: string): Readonly<Usage> | undefined { return this.store.get<Usage>(`usage:${this.accountingKey(poolId)}`); }
  roomMinutes(poolId: string): { readonly dayReserved: number; readonly cycleReserved: number } {
    const usage = this.usage(poolId); return { dayReserved: (usage?.dayActivityMs ?? 0) / 60_000, cycleReserved: (usage?.cycleActivityMs ?? 0) / 60_000 };
  }
  /** One registered owner for the current single-pool deployment. Debit before get; never refund failed reads. */
  consumeR2Read(now: number, count = 1): number {
    nonNegative(count, "R2 read count");
    if (count < 1 || this.policy.pools.length !== 1) throw new SafetyError("SAFETY_INVALID", "R2 meter requires the single registered resource owner");
    return this.store.transaction(() => {
      this.assertProtection(now);
      let usage = this.store.get<{ cycleId: string; startsAt: number; endsAt: number; reads: number }>("r2-read-usage");
      if (usage && (usage.cycleId !== this.policy.cycle.id || usage.startsAt !== this.policy.cycle.startsAt || usage.endsAt !== this.policy.cycle.endsAt)) {
        if (now < usage.endsAt || this.policy.cycle.startsAt < usage.endsAt) throw new SafetyError("SAFETY_INVALID", "R2 cycle overlaps previous accounting");
        usage = undefined;
      }
      usage ??= { cycleId: this.policy.cycle.id, startsAt: this.policy.cycle.startsAt, endsAt: this.policy.cycle.endsAt, reads: 0 };
      if (!Number.isSafeInteger(usage.reads + count) || usage.reads + count > this.policy.data.maxR2ReadsPerCycle) throw new SafetyError("SAFETY_LIMIT", "cumulative R2 reads");
      usage.reads += count; this.store.put("r2-read-usage", usage);
      return usage.reads;
    });
  }
}
interface RoomUsage { initializedAt: number; lifetimeDeadline: number; protectionDeadline: number; activityDeadline: number | null; messages: number; cleanupOperations: number }
interface ConnectionUsage { second: number; inSecond: number; total: number }
/** Hooks for messages and the owner's existing Alarm; creates no timers or polling. */
export class RoomSafety extends Protection {
  constructor(policy: SafetyPolicy, store: SafetyStore, private readonly roomId: string) { super(policy, store); identifier(roomId); }
  initialize(request: { readonly now: number; readonly activityMs: number }): void {
    nonNegative(request.activityMs, "activity allowance");
    this.store.transaction(() => {
      if (this.store.get<RoomUsage>(`room:${this.roomId}`)) return;
      this.assertProtection(request.now);
      if (request.activityMs > this.policy.global.maxActivityMsPerCycle) throw new SafetyError("SAFETY_LIMIT", "activity allowance");
      this.store.put(`room:${this.roomId}`, { initializedAt: request.now, lifetimeDeadline: Math.min(request.now + this.policy.room.maxLifetimeMs, this.policy.cycle.endsAt), protectionDeadline: Math.min(request.now + this.policy.room.protectionMaxAgeMs, this.policy.cycle.endsAt), activityDeadline: request.activityMs === 0 ? null : request.now + request.activityMs, messages: 0, cleanupOperations: 0 } satisfies RoomUsage);
    });
  }
  private room(): RoomUsage {
    const value = this.store.get<RoomUsage>(`room:${this.roomId}`);
    if (!value) throw new SafetyError("POLICY_REQUIRED", "room safety was not initialized");
    return value;
  }
  assertCanRun(now: number): void {
    this.assertProtection(now, true);
    const usage = this.room();
    if (now >= usage.lifetimeDeadline || now >= usage.protectionDeadline || (usage.activityDeadline !== null && now >= usage.activityDeadline)) throw new SafetyError("SAFETY_EXPIRED", "finite room or activity allowance expired");
  }
  nextDeadline(_now: number): number {
    const usage = this.room(), state = this.protectionState();
    return Math.min(usage.lifetimeDeadline, usage.protectionDeadline, usage.activityDeadline ?? Infinity, state.validUntil, state.state === "DRAINING" ? state.drainUntil ?? 0 : Infinity, state.state === "BLOCKED" ? 0 : Infinity);
  }
  admitMessage(request: { readonly connectionId: string; readonly bytes: number; readonly fanout: number; readonly queuedBytes: number; readonly now: number }): void {
    identifier(request.connectionId);
    for (const [key, value] of Object.entries({ bytes: request.bytes, fanout: request.fanout, queuedBytes: request.queuedBytes })) nonNegative(value, key);
    const max = this.policy.room;
    // Cheap size/queue checks happen before SQLite, protocol decoding and broadcasting.
    if (request.bytes > max.maxMessageBytes || request.fanout > max.maxBroadcastFanout || request.queuedBytes > max.maxQueuedBytes) throw new SafetyError("SAFETY_LIMIT", "message size, fanout or send queue");
    this.store.transaction(() => {
      this.assertCanRun(request.now);
      const room = this.room(), key = `connection:${request.connectionId}`, second = Math.floor(request.now / 1000);
      const connection = this.store.get<ConnectionUsage>(key) ?? { second, inSecond: 0, total: 0 };
      if (second < connection.second) throw new SafetyError("SAFETY_INVALID", "clock rollback");
      if (second !== connection.second) { connection.second = second; connection.inSecond = 0; }
      if (connection.inSecond + 1 > max.messagesPerSecond || connection.total + 1 > max.maxTotalMessages || room.messages + 1 > max.maxTotalMessages) throw new SafetyError("SAFETY_LIMIT", "message rate or cumulative room messages");
      connection.inSecond += 1; connection.total += 1; room.messages += 1;
      this.store.put(key, connection); this.store.put(`room:${this.roomId}`, room);
    });
  }
  consumeCleanupOperation(): void {
    this.store.transaction(() => { const usage = this.room(); if (usage.cleanupOperations >= this.policy.room.maxCleanupOperations) throw new SafetyError("SAFETY_LIMIT", "cleanup quota"); usage.cleanupOperations += 1; this.store.put(`room:${this.roomId}`, usage); });
  }
}

/** Check actual D1 metadata, not returned-result count or LIMIT. */
export function assertD1Usage(policy: SafetyPolicy, meta: { readonly rows_read?: number; readonly rows_written?: number }, approvedReadBound: number): void {
  nonNegative(approvedReadBound, "approved query scan bound");
  if (meta.rows_read === undefined || meta.rows_written === undefined) throw new SafetyError("SAFETY_INVALID", "D1 usage metadata unavailable");
  nonNegative(meta.rows_read, "D1 rows_read"); nonNegative(meta.rows_written, "D1 rows_written");
  if (meta.rows_read > Math.min(approvedReadBound, policy.data.maxD1RowsReadPerOperation) || meta.rows_written > policy.data.maxD1RowsWrittenPerOperation) throw new SafetyError("SAFETY_LIMIT", "D1 scanned or written rows exceed approved operation");
}
export function assertPublication(policy: SafetyPolicy, objects: readonly { readonly bytes: number }[], current: { readonly cycleWrites: number; readonly storedBytes: number }): void {
  const limits = policy.data;
  for (const value of [current.cycleWrites, current.storedBytes, ...objects.map(item => item.bytes)]) nonNegative(value, "publication amount");
  const bytes = objects.reduce((sum, object) => sum + object.bytes, 0);
  if (!Number.isSafeInteger(bytes) || objects.some(object => object.bytes > limits.maxR2ObjectBytes) || objects.length > limits.maxR2ObjectsPerPublication || bytes > limits.maxR2BytesPerPublication || current.cycleWrites + objects.length > limits.maxR2WritesPerCycle || current.storedBytes + bytes > limits.maxR2StoredBytes) throw new SafetyError("SAFETY_LIMIT", "R2 object, publication, cumulative write or storage quota");
}
