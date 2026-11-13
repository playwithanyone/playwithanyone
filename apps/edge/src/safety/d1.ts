import type { Database, SqlResult, SqlStatement } from "../env.js";
import { SafetyError, type SafetyPolicy } from "./config.js";
import type { RecoveryAuthorization } from "./limits.js";

interface ApprovedQuery { readonly readRows: number; readonly writtenRows: number }
interface ActualResult extends SqlResult { readonly meta?: { readonly changes?: number; readonly rows_read?: number; readonly rows_written?: number } }
export interface D1SafetyObservation {
  readonly day: number;
  readonly queries: number;
  readonly reservedReads: number;
  readonly reservedWrites: number;
  readonly actualReads: number | null;
  readonly actualWrites: number | null;
  readonly status: "PASS" | "BLOCKED" | "UNKNOWN";
  readonly incidentNotification?: "DISPATCHED" | "ACKNOWLEDGED" | "FAILED" | "TIMEOUT";
  readonly accounting?: "READ_LEASE";
  readonly leaseRowsDebited?: number;
}
export interface D1SafetyIncident {
  readonly reason: "D1_SAFETY_INCIDENT";
  readonly category: "DAILY_QUOTA" | "USAGE_UNKNOWN" | "SCAN_BOUND";
  readonly scope: string;
  readonly persisted: boolean;
  readonly detectedAt: number;
  readonly recoveryVersion: number | null;
}
export interface D1SafetyOptions {
  readonly now?: () => number;
  readonly onIncident?: (incident: D1SafetyIncident, signal: AbortSignal) => void | Promise<void>;
  readonly incidentTimeoutMs?: number;
  /** Lazy, prepaid read credits. No callback, request context or timer is shared. */
  readonly readLease?: { readonly maxRows: number; readonly maxAgeMs: number };
}
const normalized = (sql: string): string => sql.trim().replace(/\s+/g, " ").replace(/\s*([(),=<>?])\s*/g, "$1").toLowerCase();
const approved = new Map<string, ApprovedQuery>();
function allow(sql: string, readRows: number, writtenRows = 0): void { approved.set(normalized(sql), { readRows, writtenRows }); }
// Closed project queries, not arbitrary SQL + LIMIT heuristics. Read bounds include
// index/table lookups; result writes include the two statistics triggers.
allow("SELECT session_id, player_id, expires_at FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?", 8);
allow("SELECT session_id, player_id, expires_at FROM sessions WHERE token_hash = ?", 8);
allow("SELECT session_id FROM sessions WHERE session_id=? AND revoked_at IS NULL AND expires_at>?", 8);
allow("INSERT INTO sessions (token_hash, session_id, player_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)", 8, 8);
allow("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL", 8, 8);
allow("SELECT game_id, game_build_id, frame_origin, browser_manifest FROM game_releases WHERE game_build_id = ?", 8);
allow("SELECT catalog_entry FROM game_releases WHERE catalog_visible = 1 AND catalog_entry IS NOT NULL AND game_id <> ? LIMIT 64", 128);
allow("SELECT game_build_id FROM game_releases WHERE game_id = ? AND catalog_visible = 0 ORDER BY created_at DESC, game_build_id DESC LIMIT 1", 32);
allow("SELECT room_id FROM game_rooms WHERE room_id=?", 8);
allow("INSERT INTO game_rooms (room_id,assignment_id,created_at) VALUES (?,?,?) ON CONFLICT(room_id) DO NOTHING", 8, 4);
allow("INSERT INTO session_rooms (session_id,room_id) VALUES (?,?) ON CONFLICT DO NOTHING", 8, 4);
allow("SELECT room_id FROM session_rooms WHERE session_id=? ORDER BY room_id LIMIT 12", 32);
allow("SELECT room_id FROM session_rooms WHERE session_id=? ORDER BY room_id LIMIT 8", 24);
allow("SELECT room_id FROM session_rooms WHERE session_id=? LIMIT 1", 8);
allow("DELETE FROM session_rooms WHERE session_id=? AND room_id=?", 8, 4);
allow("DELETE FROM session_rooms WHERE room_id=?", 16, 8);
allow("INSERT INTO game_results (match_id,room_id,game_build_id,digest,outcome,winner,red_player_id,yellow_player_id,evidence,created_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(match_id) DO NOTHING", 32, 8);
allow("SELECT digest FROM game_results WHERE match_id=?", 8);

/** Guard itself is reserved too: PK UPSERT, latch trigger, index/table accesses.
 * These conservative allowances are checked against actual D1 metadata after
 * execution, not presented as an exact provider-cost formula. */
export const D1_GUARD_OVERHEAD = Object.freeze({ readRows: 16, writtenRows: 4 });
export const D1_SAFETY_SCOPE = "pwa-d1-v1";
const reservationSql = `INSERT INTO safety_d1_usage
 (scope,utc_day,reads_reserved,writes_reserved,reads_limit,writes_limit,blocked,lock_reason,updated_at)
 VALUES (?,?,?,?,?,?,CASE WHEN ? >= ? OR ? >= ? THEN 1 ELSE 0 END,NULL,?)
 ON CONFLICT(scope) DO UPDATE SET
 utc_day=excluded.utc_day,
 reads_reserved=CASE WHEN safety_d1_usage.utc_day=excluded.utc_day THEN safety_d1_usage.reads_reserved+excluded.reads_reserved ELSE excluded.reads_reserved END,
 writes_reserved=CASE WHEN safety_d1_usage.utc_day=excluded.utc_day THEN safety_d1_usage.writes_reserved+excluded.writes_reserved ELSE excluded.writes_reserved END,
 reads_limit=excluded.reads_limit,writes_limit=excluded.writes_limit,
 blocked=CASE WHEN safety_d1_usage.blocked=1 OR
  (CASE WHEN safety_d1_usage.utc_day=excluded.utc_day THEN safety_d1_usage.reads_reserved+excluded.reads_reserved ELSE excluded.reads_reserved END)>=excluded.reads_limit OR
  (CASE WHEN safety_d1_usage.utc_day=excluded.utc_day THEN safety_d1_usage.writes_reserved+excluded.writes_reserved ELSE excluded.writes_reserved END)>=excluded.writes_limit THEN 1 ELSE 0 END,
 lock_reason=safety_d1_usage.lock_reason,updated_at=excluded.updated_at
 RETURNING blocked,recovery_version`;
const wrapped = new WeakMap<object, GuardedDatabase>();
const cache = new WeakMap<object, Map<string, GuardedDatabase>>();
const localLatches = new WeakMap<object, Set<string>>();
const notifiedIncidents = new WeakMap<object, Set<string>>();
interface ReadLease { readonly day: number; readonly expiresAt: number; readonly recoveryVersion: number; remaining: number }
interface LeaseFunding { readonly reservedReads: number; readonly reservedWrites: number; readonly actualReads: number; readonly actualWrites: number }
interface SharedReadLease { lease: ReadLease | undefined; acquiring?: Promise<LeaseFunding> }
const readLeases = new WeakMap<object, Map<string, SharedReadLease>>();
const READ_CHECK_BOUND = 8;
// A renewal has one bounded PK check plus the existing atomic reservation.
const LEASE_RENEWAL_READ_BOUND = READ_CHECK_BOUND + D1_GUARD_OVERHEAD.readRows;
const readLeaseStateSql = "SELECT utc_day,reads_reserved,writes_reserved,blocked,recovery_version FROM safety_d1_usage WHERE scope=?";
interface ReadLeaseState { readonly utc_day: number; readonly reads_reserved: number; readonly writes_reserved: number; readonly blocked: number; readonly recovery_version: number }
function leaseState(value: unknown): ReadLeaseState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (["utc_day", "reads_reserved", "writes_reserved", "recovery_version"].some(key => !Number.isSafeInteger(item[key]) || (item[key] as number) < 0) || ![0, 1].includes(item["blocked"] as number)) return undefined;
  return item as unknown as ReadLeaseState;
}
function latchSet(raw: Database): Set<string> { let result = localLatches.get(raw); if (!result) { result = new Set(); localLatches.set(raw, result); } return result; }
function quotaError(error: unknown): boolean { return error instanceof Error && /SAFETY_D1_(DAILY_LIMIT|BLOCKED|CLOCK_ROLLBACK)/.test(error.message); }
function meta(result: SqlResult): { reads: number; writes: number } | undefined {
  const usage = (result as ActualResult).meta;
  if (!usage || !Number.isSafeInteger(usage.rows_read) || !Number.isSafeInteger(usage.rows_written) || usage.rows_read! < 0 || usage.rows_written! < 0) return undefined;
  return { reads: usage.rows_read!, writes: usage.rows_written! };
}
class GuardedStatement implements SqlStatement {
  constructor(readonly database: GuardedDatabase, readonly sql: string, readonly values: readonly (string | number | null)[] = []) {}
  bind(...values: (string | number | null)[]): SqlStatement { return new GuardedStatement(this.database, this.sql, values); }
  async first<T>(): Promise<T | null> { return (await this.database.execute([this]))[0]?.results?.[0] as T ?? null; }
  async all<T>(): Promise<{ results: T[]; success: boolean }> { const result = (await this.database.execute([this]))[0]!; return { ...result, results: (result.results ?? []) as T[], success: result.success }; }
  async run(): Promise<SqlResult> { return (await this.database.execute([this]))[0]!; }
}
class GuardedDatabase implements Database {
  readonly scope: string;
  observation: D1SafetyObservation | undefined;
  constructor(readonly raw: Database, readonly policy: SafetyPolicy, readonly clock: () => number, readonly options: D1SafetyOptions) { this.scope = D1_SAFETY_SCOPE; wrapped.set(this, this); }
  prepare(sql: string): SqlStatement {
    const approval = approved.get(normalized(sql));
    if (!approval || approval.readRows > this.policy.data.maxD1RowsReadPerOperation || approval.writtenRows > this.policy.data.maxD1RowsWrittenPerOperation) throw new SafetyError("SAFETY_INVALID", "D1 query lacks an approved indexed scan/write bound");
    return new GuardedStatement(this, sql);
  }
  async batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]> {
    if (statements.some(statement => !(statement instanceof GuardedStatement) || statement.database !== this)) throw new SafetyError("SAFETY_INVALID", "mixed or unguarded D1 batch");
    return this.execute(statements as readonly GuardedStatement[]);
  }
  private async persistLatch(reason: string): Promise<boolean> {
    latchSet(this.raw).add(this.scope);
    try {
      // A failed transaction rolls back its trigger writes. This separate bounded
      // attempt latches the incident without deleting data or resetting counters.
      await blockD1Safety(this.raw, this.policy, reason, this.clock());
      // The durable trigger now governs all isolates and can be manually recovered.
      // Only unconfirmed persistence retains a process-local fail-closed latch.
      latchSet(this.raw).delete(this.scope);
      return true;
    } catch { return false; }
  }
  private notifyIncident(category: D1SafetyIncident["category"], persisted: boolean, recoveryVersion: number | null): void {
    const callback = this.options.onIncident;
    if (!callback) return;
    let notified = notifiedIncidents.get(this.raw as object);
    if (!notified) { notified = new Set(); notifiedIncidents.set(this.raw as object, notified); }
    const identity = `${this.scope}:${recoveryVersion ?? "unknown"}`;
    if (notified.has(identity)) return;
    if (notified.size >= 16) notified.delete(notified.values().next().value!);
    notified.add(identity);
    const event: D1SafetyIncident = Object.freeze({ reason: "D1_SAFETY_INCIDENT", category, scope: this.scope, persisted, detectedAt: this.clock(), recoveryVersion });
    const timeout = this.options.incidentTimeoutMs ?? Math.min(this.policy.room.closeGraceMs, 5_000);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) throw new SafetyError("SAFETY_INVALID", "incident callback timeout");
    const signal = AbortSignal.timeout(timeout);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observation = { ...this.observation!, incidentNotification: "DISPATCHED" as const };
    try {
      this.observation = observation;
      const returned = callback(event, signal);
      if (returned && typeof returned.then === "function") {
        const timeoutPromise = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("INCIDENT_TIMEOUT")); }, timeout); });
        void Promise.race([returned, timeoutPromise]).then(() => { if (this.observation === observation) this.observation = { ...observation, incidentNotification: "ACKNOWLEDGED" }; }, error => { if (this.observation === observation) this.observation = { ...observation, incidentNotification: error instanceof Error && error.message === "INCIDENT_TIMEOUT" ? "TIMEOUT" : "FAILED" }; }).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      }
    } catch { if (this.observation === observation) this.observation = { ...observation, incidentNotification: "FAILED" }; }
  }
  private readLeaseBucket(day: number): SharedReadLease {
    let versions = readLeases.get(this.raw as object);
    if (!versions) { versions = new Map(); readLeases.set(this.raw as object, versions); }
    const key = JSON.stringify([D1_SAFETY_SCOPE, day, this.policy, this.options.readLease]);
    let bucket = versions.get(key);
    if (!bucket) {
      bucket = { lease: undefined };
      if (versions.size >= 8) versions.delete(versions.keys().next().value!);
      versions.set(key, bucket);
    }
    return bucket;
  }
  private async readFailure(category: D1SafetyIncident["category"], detail: string): Promise<never> {
    const persisted = await this.persistLatch(category === "DAILY_QUOTA" ? "DAILY_QUOTA_OR_EXISTING_LOCK" : category === "USAGE_UNKNOWN" ? "USAGE_METADATA_UNAVAILABLE" : "ACTUAL_USAGE_EXCEEDED_APPROVED_BOUND");
    const state = await d1SafetyStatus(this.raw);
    this.notifyIncident(category, persisted, state.recoveryVersion);
    throw new SafetyError("SAFETY_BLOCKED", `${detail}; durable latch ${persisted ? "persisted" : "unconfirmed"}`);
  }
  private async renewReadLease(bucket: SharedReadLease, day: number, needed: number): Promise<LeaseFunding> {
    const now = this.clock(), options = this.options.readLease!;
    const prefix = await this.raw.batch!([this.raw.prepare(readLeaseStateSql).bind(this.scope)]);
    const prefixUsage = prefix.length === 1 && prefix[0]?.success ? meta(prefix[0]) : undefined;
    this.observation = { day, queries: 0, reservedReads: 0, reservedWrites: 0, actualReads: prefixUsage?.reads ?? null, actualWrites: prefixUsage?.writes ?? null, status: "UNKNOWN", accounting: "READ_LEASE" };
    if (!prefixUsage) return this.readFailure("USAGE_UNKNOWN", "D1 lease status usage unknown");
    if (prefixUsage.reads > READ_CHECK_BOUND || prefixUsage.writes !== 0) return this.readFailure("SCAN_BOUND", "D1 lease PK status exceeded bound");
    const row = prefix[0]!.results?.[0], previous = row === undefined ? undefined : leaseState(row);
    if (row !== undefined && !previous) return this.readFailure("USAGE_UNKNOWN", "D1 lease status malformed");
    if (previous?.blocked === 1) {
      bucket.lease = undefined; this.observation = { ...this.observation, status: "BLOCKED" };
      throw new SafetyError("SAFETY_BLOCKED", "D1 incident is latched");
    }
    if (previous && previous.utc_day > day) return this.readFailure("DAILY_QUOTA", "D1 lease clock rollback");
    const usedReads = previous?.utc_day === day ? previous.reads_reserved : 0;
    const usedWrites = previous?.utc_day === day ? previous.writes_reserved : 0;
    // Leave one unit below the existing exact-limit incident latch. Otherwise
    // prepaying the last block would immediately invalidate that same block.
    const reads = Math.min(options.maxRows, this.policy.data.maxD1RowsReadPerDay - usedReads - 1), writes = D1_GUARD_OVERHEAD.writtenRows;
    if (reads < LEASE_RENEWAL_READ_BOUND + needed || this.policy.data.maxD1RowsWrittenPerDay - usedWrites <= writes) return this.readFailure("DAILY_QUOTA", "D1 read lease allowance exhausted");
    const limit = this.policy.data;
    const reservation = this.raw.prepare(reservationSql).bind(this.scope, day, reads, writes, limit.maxD1RowsReadPerDay, limit.maxD1RowsWrittenPerDay, reads, limit.maxD1RowsReadPerDay, writes, limit.maxD1RowsWrittenPerDay, now);
    let result: readonly SqlResult[];
    try { result = await this.raw.batch!([reservation]); }
    catch (error) {
      if (quotaError(error)) return this.readFailure("DAILY_QUOTA", "D1 competing read lease reservation rejected");
      throw error;
    }
    const usage = result.length === 1 && result[0]?.success ? meta(result[0]) : undefined;
    this.observation = { day, queries: 0, reservedReads: reads, reservedWrites: writes, actualReads: usage ? prefixUsage.reads + usage.reads : null, actualWrites: usage ? prefixUsage.writes + usage.writes : null, status: "UNKNOWN", accounting: "READ_LEASE" };
    if (!usage) return this.readFailure("USAGE_UNKNOWN", "D1 lease reservation usage unknown");
    if (usage.reads > D1_GUARD_OVERHEAD.readRows || usage.writes > writes) return this.readFailure("SCAN_BOUND", "D1 lease reservation exceeded bound");
    const state = result[0]?.results?.[0] as { blocked?: number; recovery_version?: number } | undefined;
    if (!state || ![0, 1].includes(state.blocked!) || !Number.isSafeInteger(state.recovery_version) || state.recovery_version! < 0) return this.readFailure("USAGE_UNKNOWN", "D1 lease reservation state unknown");
    if (state.blocked === 1) {
      bucket.lease = undefined; this.observation = { ...this.observation, status: "BLOCKED" };
      this.notifyIncident("DAILY_QUOTA", true, state.recovery_version!);
      throw new SafetyError("SAFETY_BLOCKED", "D1 lease reached incident threshold");
    }
    bucket.lease = { day, expiresAt: Math.min(now + options.maxAgeMs, (day + 1) * 86_400_000, this.policy.cycle.endsAt), recoveryVersion: state.recovery_version!, remaining: reads - LEASE_RENEWAL_READ_BOUND };
    return { reservedReads: reads, reservedWrites: writes, actualReads: prefixUsage.reads + usage.reads, actualWrites: prefixUsage.writes + usage.writes };
  }
  private async takeReadLease(needed: number): Promise<{ bucket: SharedReadLease; lease: ReadLease; funding?: LeaseFunding }> {
    if (needed + LEASE_RENEWAL_READ_BOUND > this.options.readLease!.maxRows) throw new SafetyError("SAFETY_INVALID", "read batch exceeds configured lease capacity");
    let funding: LeaseFunding | undefined;
    for (let attempt = 0; attempt < 32; attempt++) {
      const now = this.clock(), day = Math.floor(now / 86_400_000);
      if (!Number.isSafeInteger(now) || now < this.policy.cycle.startsAt || now >= this.policy.cycle.endsAt) throw new SafetyError("SAFETY_EXPIRED", "D1 policy cycle");
      const bucket = this.readLeaseBucket(day), current = bucket.lease;
      if (current && current.expiresAt > now && current.remaining >= needed) {
        // This synchronous debit precedes every await: concurrent wrappers cannot
        // both spend the same credits, even when their callbacks differ.
        current.remaining -= needed;
        return { bucket, lease: current, ...(funding ? { funding } : {}) };
      }
      if (bucket.acquiring) { await bucket.acquiring; continue; }
      bucket.lease = undefined;
      const promise = this.renewReadLease(bucket, day, needed); bucket.acquiring = promise;
      try {
        const added = await promise;
        funding = funding ? { reservedReads: funding.reservedReads + added.reservedReads, reservedWrites: funding.reservedWrites + added.reservedWrites,
          actualReads: funding.actualReads + added.actualReads, actualWrites: funding.actualWrites + added.actualWrites } : added;
      }
      finally { if (bucket.acquiring === promise) delete bucket.acquiring; }
    }
    throw new SafetyError("SAFETY_INVALID", "D1 read lease could not settle within its renewal bound");
  }
  private async executeRead(statements: readonly GuardedStatement[], bounds: readonly ApprovedQuery[]): Promise<readonly SqlResult[]> {
    const needed = READ_CHECK_BOUND + bounds.reduce((sum, bound) => sum + bound.readRows, 0);
    const { bucket, lease, funding } = await this.takeReadLease(needed), day = lease.day;
    const result = await this.raw.batch!([this.raw.prepare(readLeaseStateSql).bind(this.scope), ...statements.map(statement => this.raw.prepare(statement.sql).bind(...statement.values))]);
    const measurements = result.map(meta), guard = measurements[0];
    const unknown = result.length !== statements.length + 1 || result.some(item => !item.success) || measurements.some(item => item === undefined);
    const over = !unknown && (guard!.reads > READ_CHECK_BOUND || guard!.writes !== 0 || bounds.some((bound, index) => measurements[index + 1]!.reads > bound.readRows || measurements[index + 1]!.writes !== 0));
    this.observation = { day, queries: statements.length, reservedReads: funding?.reservedReads ?? 0, reservedWrites: funding?.reservedWrites ?? 0,
      actualReads: unknown ? null : (funding?.actualReads ?? 0) + measurements.reduce((sum, item) => sum + item!.reads, 0),
      actualWrites: unknown ? null : (funding?.actualWrites ?? 0) + measurements.reduce((sum, item) => sum + item!.writes, 0), status: unknown ? "UNKNOWN" : over ? "BLOCKED" : "PASS", accounting: "READ_LEASE", leaseRowsDebited: needed };
    if (unknown || over) {
      if (bucket.lease === lease) bucket.lease = undefined;
      return this.readFailure(unknown ? "USAGE_UNKNOWN" : "SCAN_BOUND", unknown ? "D1 read usage unknown" : "D1 read scan/write bound exceeded");
    }
    const state = leaseState(result[0]?.results?.[0]);
    if (!state) return this.readFailure("USAGE_UNKNOWN", "D1 read lease state unknown");
    if (state.blocked === 1 || state.utc_day !== day) {
      if (bucket.lease === lease) bucket.lease = undefined;
      this.observation = { ...this.observation, status: "BLOCKED" };
      // The business SELECTs may have run in this read-only batch; their rows
      // are never returned to the caller once the authoritative lock is seen.
      throw new SafetyError("SAFETY_BLOCKED", "D1 read lease invalidated by persistent protection");
    }
    if (state.recovery_version !== lease.recoveryVersion && bucket.lease === lease) bucket.lease = undefined;
    return result.slice(1);
  }
  async execute(statements: readonly GuardedStatement[]): Promise<readonly SqlResult[]> {
    const now = this.clock(), day = Math.floor(now / 86_400_000);
    if (!Number.isSafeInteger(now) || now < this.policy.cycle.startsAt || now >= this.policy.cycle.endsAt) throw new SafetyError("SAFETY_EXPIRED", "D1 policy cycle");
    if (latchSet(this.raw).has(this.scope)) throw new SafetyError("SAFETY_BLOCKED", "D1 incident is latched");
    if (!this.raw.batch || statements.length < 1 || statements.length > 16) throw new SafetyError("SAFETY_INVALID", "bounded native D1 batch required");
    const bounds = statements.map(statement => approved.get(normalized(statement.sql))!);
    if (bounds.some(bound => !bound)) throw new SafetyError("SAFETY_INVALID", "unapproved query");
    if (this.options.readLease && bounds.every(bound => bound.writtenRows === 0)) return this.executeRead(statements, bounds);
    const reads = D1_GUARD_OVERHEAD.readRows + bounds.reduce((sum, item) => sum + item.readRows, 0);
    const writes = D1_GUARD_OVERHEAD.writtenRows + bounds.reduce((sum, item) => sum + item.writtenRows, 0);
    const limit = this.policy.data;
    const reservation = this.raw.prepare(reservationSql).bind(this.scope, day, reads, writes, limit.maxD1RowsReadPerDay, limit.maxD1RowsWrittenPerDay, reads, limit.maxD1RowsReadPerDay, writes, limit.maxD1RowsWrittenPerDay, now);
    let result: readonly SqlResult[];
    try { result = await this.raw.batch([reservation, ...statements.map(statement => this.raw.prepare(statement.sql).bind(...statement.values))]); }
    catch (error) {
      if (quotaError(error)) {
        const persisted = await this.persistLatch("DAILY_QUOTA_OR_EXISTING_LOCK");
        this.observation = { day, queries: statements.length, reservedReads: reads, reservedWrites: writes, actualReads: null, actualWrites: null, status: persisted ? "BLOCKED" : "UNKNOWN" };
        if (!(error instanceof Error && /SAFETY_D1_BLOCKED/.test(error.message))) {
          const state = await d1SafetyStatus(this.raw);
          this.notifyIncident("DAILY_QUOTA", persisted, state.recoveryVersion);
        }
        throw new SafetyError("SAFETY_BLOCKED", persisted ? "D1 daily quota; incident latch persisted" : "D1 daily quota; durable latch unconfirmed, process refuses further work");
      }
      // No retry here. D1 batch failure must remain a failure; business command
      // retry identity belongs to its existing owner, not this accounting layer.
      throw error;
    }
    const measurements = result.map(meta), guard = measurements[0];
    const unknown = result.length !== statements.length + 1 || result.some(item => !item.success) || measurements.some(item => item === undefined);
    const over = !unknown && (guard!.reads > D1_GUARD_OVERHEAD.readRows || guard!.writes > D1_GUARD_OVERHEAD.writtenRows || bounds.some((bound, index) => measurements[index + 1]!.reads > bound.readRows || measurements[index + 1]!.writes > bound.writtenRows));
    this.observation = { day, queries: statements.length, reservedReads: reads, reservedWrites: writes, actualReads: unknown ? null : measurements.reduce((sum, item) => sum + item!.reads, 0), actualWrites: unknown ? null : measurements.reduce((sum, item) => sum + item!.writes, 0), status: unknown ? "UNKNOWN" : over ? "BLOCKED" : "PASS" };
    if (unknown || over) {
      const persisted = await this.persistLatch(unknown ? "USAGE_METADATA_UNAVAILABLE" : "ACTUAL_USAGE_EXCEEDED_APPROVED_BOUND");
      const state = await d1SafetyStatus(this.raw);
      this.notifyIncident(unknown ? "USAGE_UNKNOWN" : "SCAN_BOUND", persisted, state.recoveryVersion);
      throw new SafetyError("SAFETY_BLOCKED", `${unknown ? "D1 usage unknown" : "D1 actual scan/write bound exceeded"}; durable latch ${persisted ? "persisted" : "unconfirmed"}; business batch may already have committed`);
    }
    const guardState = result[0]?.results?.[0] as { blocked?: number; recovery_version?: number } | undefined;
    if (guardState?.blocked === 1) this.notifyIncident("DAILY_QUOTA", true, guardState.recovery_version ?? null);
    return result.slice(1);
  }
}

/** Wrap once per raw binding + effective limits. Changing config never clears the SQL incident latch. */
export function withD1Safety(rawDB: Database, policy: SafetyPolicy, options: D1SafetyOptions = {}): Database {
  if (options.incidentTimeoutMs !== undefined && (!Number.isSafeInteger(options.incidentTimeoutMs) || options.incidentTimeoutMs < 1 || options.incidentTimeoutMs > 30_000)) throw new SafetyError("SAFETY_INVALID", "incident callback timeout");
  if (options.readLease && (!Number.isSafeInteger(options.readLease.maxRows) || options.readLease.maxRows < LEASE_RENEWAL_READ_BOUND + READ_CHECK_BOUND + 1 || options.readLease.maxRows > 1_000_000 || !Number.isSafeInteger(options.readLease.maxAgeMs) || options.readLease.maxAgeMs < 1 || options.readLease.maxAgeMs > 60_000)) throw new SafetyError("SAFETY_INVALID", "bounded read lease required");
  const prior = wrapped.get(rawDB as object), raw = prior?.raw ?? rawDB;
  const key = JSON.stringify([policy.accountId, policy.environment, policy.cycle, policy.data.maxD1RowsReadPerOperation, policy.data.maxD1RowsWrittenPerOperation, policy.data.maxD1RowsReadPerDay, policy.data.maxD1RowsWrittenPerDay, options.readLease]);
  if (!options.now && !options.onIncident) {
    let versions = cache.get(raw as object); if (!versions) { versions = new Map(); cache.set(raw as object, versions); }
    const existing = versions.get(key); if (existing) return existing;
    const result = new GuardedDatabase(raw, policy, Date.now, options); if (versions.size >= 4) versions.delete(versions.keys().next().value!); versions.set(key, result); return result;
  }
  return new GuardedDatabase(raw, policy, options.now ?? Date.now, options);
}
export function d1SafetyObservation(database: Database): D1SafetyObservation | undefined { return wrapped.get(database as object)?.observation; }
export function rawD1Database(database: Database): Database { return wrapped.get(database as object)?.raw ?? database; }

/** Only authenticated management should use these raw, bounded control operations. */
export async function blockD1Safety(database: Database, policy: SafetyPolicy, reason: string, now = Date.now(), protectionVersion?: number): Promise<void> {
  if (!reason || reason.length > 512 || !Number.isSafeInteger(now) || now < 0 || (protectionVersion !== undefined && (!Number.isSafeInteger(protectionVersion) || protectionVersion < 1))) throw new SafetyError("SAFETY_INVALID", "D1 block record");
  const raw = rawD1Database(database);
  await raw.prepare(`INSERT INTO safety_d1_usage
   (scope,utc_day,reads_reserved,writes_reserved,reads_limit,writes_limit,blocked,lock_reason,updated_at)
   VALUES (?,?,0,0,?,?,1,?,?)
   ON CONFLICT(scope) DO UPDATE SET blocked=1,lock_reason=excluded.lock_reason,updated_at=excluded.updated_at
   WHERE safety_d1_usage.blocked=0 AND (? IS NULL OR ?>safety_d1_usage.recovery_version)`).bind(D1_SAFETY_SCOPE, Math.floor(now / 86_400_000), policy.data.maxD1RowsReadPerDay, policy.data.maxD1RowsWrittenPerDay, reason, now, protectionVersion ?? null, protectionVersion ?? null).run();
}
export interface D1SafetyStatus {
  readonly state: "NORMAL" | "BLOCKED" | "UNKNOWN";
  readonly blocked: boolean | null;
  readonly accountingInitialized: boolean;
  readonly day: number | null;
  readonly readsReserved: number | null;
  readonly writesReserved: number | null;
  readonly readsLimit: number | null;
  readonly writesLimit: number | null;
  readonly lockReason: string | null;
  readonly recoveryVersion: number | null;
}
export async function d1SafetyStatus(database: Database): Promise<D1SafetyStatus> {
  try {
    const row = await rawD1Database(database).prepare("SELECT utc_day,reads_reserved,writes_reserved,reads_limit,writes_limit,blocked,lock_reason,recovery_version FROM safety_d1_usage WHERE scope=?").bind(D1_SAFETY_SCOPE).first<{ utc_day: number; reads_reserved: number; writes_reserved: number; reads_limit: number; writes_limit: number; blocked: number; lock_reason: string | null; recovery_version: number }>();
    if (!row) return { state: "NORMAL", blocked: false, accountingInitialized: false, day: null, readsReserved: 0, writesReserved: 0, readsLimit: null, writesLimit: null, lockReason: null, recoveryVersion: 0 };
    return { state: row.blocked === 1 ? "BLOCKED" : "NORMAL", blocked: row.blocked === 1, accountingInitialized: true, day: row.utc_day, readsReserved: row.reads_reserved, writesReserved: row.writes_reserved, readsLimit: row.reads_limit, writesLimit: row.writes_limit, lockReason: row.lock_reason, recoveryVersion: row.recovery_version };
  } catch { return { state: "UNKNOWN", blocked: null, accountingInitialized: false, day: null, readsReserved: null, writesReserved: null, readsLimit: null, writesLimit: null, lockReason: "CONTROL_READ_UNAVAILABLE", recoveryVersion: null }; }
}

/** Separately authenticated management recovery; never resets usage counters. */
export async function recoverD1Safety(database: Database, policy: SafetyPolicy, authorization: RecoveryAuthorization, version: number): Promise<void> {
  if (!authorization.authenticated || !authorization.actor || !authorization.reason || !authorization.configurationVersion || !authorization.validationRecord || !Number.isSafeInteger(version) || version < 1) throw new SafetyError("RECOVERY_REQUIRED", "D1 authenticated recovery record required");
  const raw = rawD1Database(database), scope = D1_SAFETY_SCOPE;
  if (!raw.batch) throw new SafetyError("SAFETY_INVALID", "native recovery batch required");
  const prior = await raw.prepare("SELECT actor,reason,configuration,validation FROM safety_d1_recoveries WHERE scope=? AND version=?").bind(scope, version).first<{ actor: string; reason: string; configuration: string; validation: string }>();
  if (prior && (prior.actor !== authorization.actor || prior.reason !== authorization.reason || prior.configuration !== authorization.configurationVersion || prior.validation !== authorization.validationRecord)) throw new SafetyError("RECOVERY_REQUIRED", "D1 recovery identity conflict");
  await raw.batch([
    raw.prepare(`UPDATE safety_d1_usage SET blocked=0,lock_reason=NULL,recovery_version=?,recovery_actor=?,recovery_reason=?,recovery_configuration=?,recovery_validation=?,updated_at=? WHERE scope=? AND recovery_version<?`).bind(version, authorization.actor, authorization.reason, authorization.configurationVersion, authorization.validationRecord, Date.now(), scope, version),
    raw.prepare("INSERT INTO safety_d1_recoveries(scope,version,actor,reason,configuration,validation,recovered_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(scope,version) DO NOTHING").bind(scope, version, authorization.actor, authorization.reason, authorization.configurationVersion, authorization.validationRecord, Date.now()),
  ]);
  const observed = await raw.prepare("SELECT blocked,recovery_version FROM safety_d1_usage WHERE scope=?").bind(scope).first<{ blocked: number; recovery_version: number }>();
  if (observed && (observed.blocked !== 0 || observed.recovery_version !== version)) throw new SafetyError("RECOVERY_REQUIRED", "D1 unlock was not observed");
  latchSet(raw).delete(scope);
  notifiedIncidents.get(raw as object)?.clear();
}
