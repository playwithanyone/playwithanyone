import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Database, SqlResult, SqlStatement } from "../../../apps/edge/src/env.js";
import { requirePolicy } from "../../protocol/src/policy.js";
import { D1_GUARD_OVERHEAD, SafetyError, blockD1Safety, d1SafetyObservation, d1SafetyStatus, recoverD1Safety, resolveSafetyPolicy, withD1Safety, type D1SafetyIncident, type SafetyPolicy } from "../../../apps/edge/src/safety/index.js";

const at = 10_000;
function policy(writes = 10_000): SafetyPolicy {
  const binding = JSON.parse(readFileSync("configs/safety.dev.json", "utf8"));
  binding.values.data.maxD1RowsWrittenPerDay = writes;
  return requirePolicy(resolveSafetyPolicy(binding, "fixture")).value;
}
/** Real SQLite transaction/trigger/index component. Usage numbers are explicit
 * test fixtures (SQLite changed rows, not provider rows/index billing metadata). */
class SqliteD1 implements Database {
  readonly executed: string[] = [];
  usageOverride: ((sql: string, usage: { rows_read: number; rows_written: number }) => { rows_read: number; rows_written: number } | undefined) | undefined;
  failLatch = false;
  constructor(readonly sqlite = new DatabaseSync(":memory:")) {}
  prepare(sql: string): SqlStatement { return new RawStatement(this, sql); }
  execute(sql: string, values: readonly (string | number | null)[]): SqlResult {
    this.executed.push(sql);
    if (this.failLatch && sql.includes("VALUES (?,?,0,0,?,?,1,?,?)")) throw new Error("fixture database not writable");
    const before = Number(this.sqlite.prepare("SELECT total_changes() AS n").get()?.["n"] ?? 0);
    const statement = this.sqlite.prepare(sql);
    const results = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
    const writes = Number(this.sqlite.prepare("SELECT total_changes() AS n").get()?.["n"] ?? 0) - before;
    const usage = this.usageOverride ? this.usageOverride(sql, { rows_read: 0, rows_written: writes }) : { rows_read: 0, rows_written: writes };
    return { success: true, results, ...(usage ? { meta: usage } : {}) };
  }
  async batch(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]> {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { const result = statements.map(statement => { assert.ok(statement instanceof RawStatement); return this.execute(statement.sql, statement.values); }); this.sqlite.exec("COMMIT"); return result; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
}
class RawStatement implements SqlStatement {
  constructor(readonly database: SqliteD1, readonly sql: string, readonly values: readonly (string | number | null)[] = []) {}
  bind(...values: (string | number | null)[]): SqlStatement { return new RawStatement(this.database, this.sql, values); }
  async first<T>(): Promise<T | null> { return this.database.execute(this.sql, this.values).results?.[0] as T ?? null; }
  async all<T>(): Promise<{ results: T[]; success: boolean }> { const result = this.database.execute(this.sql, this.values); return { ...result, results: result.results as T[], success: true }; }
  async run(): Promise<SqlResult> { return this.database.execute(this.sql, this.values); }
}
function setup(writes?: number) {
  const raw = new SqliteD1();
  for (const file of ["0001_sessions_and_releases.sql", "0002_gameplay.sql", "0003_safety_usage.sql"]) raw.sqlite.exec(readFileSync(`apps/edge/migrations/${file}`, "utf8"));
  const value = policy(writes); const safe = withD1Safety(raw, value, { now: () => at });
  return { raw, safe, policy: value };
}
const insert = (database: Database, suffix: string) => database.prepare("INSERT INTO sessions (token_hash, session_id, player_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").bind(`token-${suffix}`, `session-${suffix}`, `player-${suffix}`, at, at + 60_000);
const select = (database: Database, suffix: string) => database.prepare("SELECT session_id, player_id, expires_at FROM sessions WHERE token_hash = ?").bind(`token-${suffix}`);
const blocked = (error: unknown) => error instanceof SafetyError && error.code === "SAFETY_BLOCKED";

test("COST-09 D1 wrapper covers prepare/bind/first/all/run and batch while preserving result indexes", async () => {
  const { raw, safe } = setup();
  await insert(safe, "one").run();
  assert.equal((await select(safe, "one").first<{ session_id: string }>())?.session_id, "session-one");
  assert.equal((await select(safe, "one").all<{ session_id: string }>()).results[0]?.session_id, "session-one");
  const results = await safe.batch!([insert(safe, "two"), select(safe, "two")]);
  assert.equal(results.length, 2); assert.equal((results[1]?.results?.[0] as { session_id: string }).session_id, "session-two");
  const usage = raw.sqlite.prepare("SELECT reads_reserved,writes_reserved FROM safety_d1_usage").get()!;
  assert.equal(Number(usage["writes_reserved"]), 16 + 16);
  const observed = d1SafetyObservation(safe)!;
  assert.equal(observed.queries, 2); assert.ok(observed.reservedReads >= D1_GUARD_OVERHEAD.readRows); assert.equal(observed.status, "PASS");
});

test("COST-09 D1 unknown SQL fails before provider execution; indexed approved scan bounds are explicit", () => {
  const { raw, safe } = setup();
  assert.throws(() => safe.prepare("SELECT * FROM sessions"), (error: unknown) => error instanceof SafetyError && error.code === "SAFETY_INVALID");
  assert.equal(raw.executed.length, 0);
  const catalogPlan = raw.sqlite.prepare("EXPLAIN QUERY PLAN SELECT catalog_entry FROM game_releases WHERE catalog_visible = 1 AND catalog_entry IS NOT NULL AND game_id <> ? LIMIT 64").all("fixture-loader");
  assert.ok(catalogPlan.some(row => String(row["detail"]).includes("game_releases_catalog")));
  const latestPlan = raw.sqlite.prepare("EXPLAIN QUERY PLAN SELECT game_build_id FROM game_releases WHERE game_id = ? AND catalog_visible = 0 ORDER BY created_at DESC, game_build_id DESC LIMIT 1").all("fixture-loader");
  assert.ok(latestPlan.some(row => String(row["detail"]).includes("game_releases_latest")));
});

test("COST-09/16 atomic daily guard rejects competing overspend before business SQL, latches across day/config", async () => {
  const { raw, safe } = setup(13);
  const results = await Promise.allSettled([insert(safe, "one").run(), insert(safe, "two").run()]);
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(Number(raw.sqlite.prepare("SELECT count(*) AS n FROM sessions").get()?.["n"]), 1);
  assert.equal(raw.sqlite.prepare("SELECT blocked FROM safety_d1_usage").get()?.["blocked"], 1);
  const cold = new SqliteD1(raw.sqlite), higher = withD1Safety(cold, policy(100_000), { now: () => at + 86_400_000 });
  await assert.rejects(() => insert(higher, "next-day").run(), blocked);
  assert.equal(Number(raw.sqlite.prepare("SELECT count(*) AS n FROM sessions").get()?.["n"]), 1);
});

test("COST-09 D1 actual rows beyond preapproved bound or absent metadata latch without claiming rollback", async () => {
  const { raw, safe } = setup();
  raw.usageOverride = (sql, usage) => sql.startsWith("SELECT session_id") ? { ...usage, rows_read: 9999 } : usage;
  await assert.rejects(() => select(safe, "absent").first(), blocked);
  assert.equal(raw.sqlite.prepare("SELECT blocked FROM safety_d1_usage").get()?.["blocked"], 1);
  assert.equal(d1SafetyObservation(safe)?.actualReads, 9999);
  const second = setup(); second.raw.usageOverride = () => undefined;
  await assert.rejects(() => insert(second.safe, "may-have-committed").run(), (error: unknown) => blocked(error) && (error as Error).message.includes("may already have committed"));
  assert.equal(Number(second.raw.sqlite.prepare("SELECT count(*) AS n FROM sessions").get()?.["n"]), 1);
  assert.equal(d1SafetyObservation(second.safe)?.status, "UNKNOWN");
});

test("COST-17 quota incident latch write failure stays explicitly unconfirmed and process fails closed", async () => {
  const { raw, safe } = setup(13); await insert(safe, "one").run(); raw.failLatch = true;
  await assert.rejects(() => insert(safe, "two").run(), (error: unknown) => blocked(error) && (error as Error).message.includes("unconfirmed"));
  const calls = raw.executed.length;
  await assert.rejects(() => select(safe, "one").first(), blocked);
  assert.equal(raw.executed.length, calls);
  assert.equal(d1SafetyObservation(safe)?.status, "UNKNOWN");
});

test("COST-20 D1 manual recovery keeps daily usage, requires auth record, and becomes observable across wrappers", async () => {
  const { raw, safe } = setup(13); await insert(safe, "one").run(); await assert.rejects(() => insert(safe, "two").run(), blocked);
  const good = { authenticated: true, actor: "fixture-admin", reason: "reviewed quota", configurationVersion: "fixture-v2", validationRecord: "fixture-acceptance" };
  await assert.rejects(() => recoverD1Safety(safe, policy(1000), { ...good, authenticated: false }, 1), (error: unknown) => error instanceof SafetyError && error.code === "RECOVERY_REQUIRED");
  const before = raw.sqlite.prepare("SELECT reads_reserved,writes_reserved FROM safety_d1_usage").get();
  await recoverD1Safety(safe, policy(1000), good, 1);
  assert.deepEqual(raw.sqlite.prepare("SELECT reads_reserved,writes_reserved FROM safety_d1_usage").get(), before);
  const updated = withD1Safety(raw, policy(1000), { now: () => at + 86_400_000 });
  await insert(updated, "after-recovery").run();
  assert.equal(Number(raw.sqlite.prepare("SELECT count(*) AS n FROM sessions").get()?.["n"]), 2);
  assert.equal(raw.sqlite.prepare("SELECT actor FROM safety_d1_recoveries").get()?.["actor"], "fixture-admin");
});

test("COST-09 wrapping the same binding does not recursively charge its own reservation query", () => {
  const { raw, policy: value } = setup(); const first = withD1Safety(raw, value), second = withD1Safety(first, value);
  assert.equal(first, second);
});

test("COST-09/15 D1 incident callback is once per durable recovery generation, bounded and contains no SQL/values", async () => {
  const { raw } = setup(); const events: D1SafetyIncident[] = [];
  const callback = (event: D1SafetyIncident, signal: AbortSignal) => { assert.equal(signal.aborted, false); events.push(event); };
  const first = withD1Safety(raw, policy(12), { now: () => at, onIncident: callback });
  // Last permitted operation commits, permanently latches, and signals immediately.
  await insert(first, "last-permitted").run();
  assert.equal(events.length, 1); assert.equal(events[0]?.persisted, true);
  assert.equal(events[0]?.reason, "D1_SAFETY_INCIDENT"); assert.equal(events[0]?.recoveryVersion, 0);
  await assert.rejects(() => select(first, "last-permitted").first(), blocked);
  await assert.rejects(() => select(withD1Safety(raw, policy(12), { now: () => at, onIncident: callback }), "last-permitted").first(), blocked);
  assert.equal(events.length, 1);
  assert.equal(JSON.stringify(events).includes("last-permitted"), false); assert.equal(JSON.stringify(events).includes("INSERT"), false);
  const recovery = { authenticated: true, actor: "fixture-admin", reason: "reviewed quota", configurationVersion: "fixture-v2", validationRecord: "fixture-proof" };
  await recoverD1Safety(first, policy(24), recovery, 1);
  const next = withD1Safety(raw, policy(24), { now: () => at, onIncident: callback });
  await insert(next, "next-generation").run();
  assert.equal(events.length, 2); assert.equal(events[1]?.recoveryVersion, 1);
});

test("COST-16 D1 stop replay cannot overwrite a more recent authenticated recovery", async () => {
  const { raw, safe, policy: value } = setup();
  await insert(safe, "one").run(); await blockD1Safety(safe, value, "fixture-stop", at, 3);
  assert.equal((await d1SafetyStatus(raw)).state, "BLOCKED");
  await recoverD1Safety(safe, value, { authenticated: true, actor: "fixture-admin", reason: "repair", configurationVersion: "fixture-v2", validationRecord: "fixture-proof" }, 4);
  await blockD1Safety(safe, value, "stale-stop", at + 1, 3);
  assert.equal((await d1SafetyStatus(raw)).state, "NORMAL");
  assert.equal((await d1SafetyStatus(raw)).recoveryVersion, 4);
});

function leaseSetup({ maxRows = 64, maxAgeMs = 60_000, reads = 100_000, writes = 10_000 } = {}) {
  const initial = setup(writes), value: SafetyPolicy = { ...initial.policy, data: { ...initial.policy.data, maxD1RowsReadPerDay: reads } };
  let now = at;
  const options = { now: () => now, readLease: { maxRows, maxAgeMs } };
  const safe = withD1Safety(initial.raw, value, options);
  return { raw: initial.raw, policy: value, safe, options, setNow: (value: number) => { now = value; } };
}
const reservations = (raw: SqliteD1) => raw.executed.filter(sql => sql.includes("RETURNING blocked,recovery_version")).length;

test("COST-09 read lease: ordinary reads share one prepaid block and write no per-request usage row", async () => {
  const { raw, safe } = leaseSetup(); await insert(raw, "existing").run();
  assert.equal((await select(safe, "existing").first<{ session_id: string }>())?.session_id, "session-existing");
  const afterFirst = raw.sqlite.prepare("SELECT reads_reserved,writes_reserved FROM safety_d1_usage").get();
  assert.equal((await select(safe, "existing").all<{ session_id: string }>()).results[0]?.session_id, "session-existing");
  assert.deepEqual(raw.sqlite.prepare("SELECT reads_reserved,writes_reserved FROM safety_d1_usage").get(), afterFirst);
  assert.equal(reservations(raw), 1); assert.equal(afterFirst?.["reads_reserved"], 64); assert.equal(afterFirst?.["writes_reserved"], 4);
  const observed = d1SafetyObservation(safe)!;
  assert.equal(observed.accounting, "READ_LEASE"); assert.equal(observed.leaseRowsDebited, 16); assert.equal(observed.reservedWrites, 0); assert.equal(observed.actualWrites, 0);
  // Mutating business batches retain the original atomic operation guard.
  await insert(safe, "written").run(); assert.equal(reservations(raw), 2);
  assert.equal(raw.sqlite.prepare("SELECT writes_reserved FROM safety_d1_usage").get()?.["writes_reserved"], 16);
});

test("COST-09 read lease: separate request wrappers share credits while retaining their own callbacks", async () => {
  const { raw, safe, policy: value, options } = leaseSetup({ maxRows: 56 });
  const oneEvents: D1SafetyIncident[] = [], twoEvents: D1SafetyIncident[] = [];
  const one = withD1Safety(raw, value, { ...options, onIncident: event => { oneEvents.push(event); } });
  const two = withD1Safety(raw, value, { ...options, onIncident: event => { twoEvents.push(event); } });
  assert.notEqual(one, two);
  await Promise.all([select(one, "absent").first(), select(two, "absent").first()]);
  assert.equal(reservations(raw), 1); assert.equal(raw.sqlite.prepare("SELECT reads_reserved FROM safety_d1_usage").get()?.["reads_reserved"], 56);
  assert.deepEqual(oneEvents, []); assert.deepEqual(twoEvents, []);
  // Exactly two 16-row debits fit after the 24-row renewal guard; the next
  // operation must buy a second block, never let concurrent credits go negative.
  await select(safe, "absent").first(); assert.equal(reservations(raw), 2);
  assert.equal(raw.sqlite.prepare("SELECT reads_reserved FROM safety_d1_usage").get()?.["reads_reserved"], 112);
});

test("COST-09 read lease: expiry, instance restart and UTC day change never refund unused credits", async () => {
  const { raw, safe, policy: value, options, setNow } = leaseSetup();
  await select(safe, "absent").first(); setNow(at + 60_000); await select(safe, "absent").first();
  assert.equal(reservations(raw), 2); assert.equal(raw.sqlite.prepare("SELECT reads_reserved FROM safety_d1_usage").get()?.["reads_reserved"], 128);
  // A different raw binding represents a cold isolate, with no reusable credits.
  const coldRaw = new SqliteD1(raw.sqlite), cold = withD1Safety(coldRaw, value, options);
  await select(cold, "absent").first(); assert.equal(reservations(coldRaw), 1);
  assert.equal(raw.sqlite.prepare("SELECT reads_reserved FROM safety_d1_usage").get()?.["reads_reserved"], 192);
  setNow(86_400_000 + at); await select(safe, "absent").first();
  assert.equal(raw.sqlite.prepare("SELECT reads_reserved FROM safety_d1_usage").get()?.["reads_reserved"], 64);
  assert.equal(raw.sqlite.prepare("SELECT utc_day FROM safety_d1_usage").get()?.["utc_day"], 1);
});

test("COST-16 read lease: persistent stop denies already prepaid reads without returning business rows", async () => {
  const { raw, safe, policy: value } = leaseSetup(); await insert(raw, "private").run(); await select(safe, "private").first();
  const before = reservations(raw); await blockD1Safety(raw, value, "operator-stop", at, 1);
  await assert.rejects(() => select(safe, "private").first(), blocked);
  assert.equal(reservations(raw), before); assert.equal(d1SafetyObservation(safe)?.status, "BLOCKED");
  assert.equal((await d1SafetyStatus(raw)).state, "BLOCKED");
});

test("COST-09 read lease: near-limit renewal buys only remaining credits and refuses overspend", async () => {
  const { raw, safe } = leaseSetup({ reads: 100, maxRows: 64 });
  await select(safe, "absent").first(); await select(safe, "absent").first();
  // First block has only eight unused credits; another normal read needs 16.
  // Remaining quota cannot fund renewal+read, so no extra business read occurs.
  const businessBefore = raw.executed.filter(sql => sql.startsWith("SELECT session_id")).length;
  await assert.rejects(() => select(safe, "absent").first(), blocked);
  assert.equal(raw.executed.filter(sql => sql.startsWith("SELECT session_id")).length, businessBefore);
  assert.equal(raw.sqlite.prepare("SELECT reads_reserved FROM safety_d1_usage").get()?.["reads_reserved"], 64);
  assert.equal(raw.sqlite.prepare("SELECT blocked FROM safety_d1_usage").get()?.["blocked"], 1);
  const clamped = leaseSetup({ reads: 130, maxRows: 80 });
  for (let index = 0; index < 4; index++) await select(clamped.safe, "absent").first();
  assert.equal(clamped.raw.sqlite.prepare("SELECT reads_reserved FROM safety_d1_usage").get()?.["reads_reserved"], 129);
  assert.equal(clamped.raw.sqlite.prepare("SELECT writes_reserved FROM safety_d1_usage").get()?.["writes_reserved"], 8);
});

test("COST-09 read lease: missing usage, unexpected writes and scan overflow latch before data escapes", async () => {
  for (const kind of ["missing", "write", "scan"] as const) {
    const { raw, safe } = leaseSetup(); await insert(raw, "secret").run();
    raw.usageOverride = (sql, usage) => sql.startsWith("SELECT session_id") ? kind === "missing" ? undefined : kind === "write" ? { ...usage, rows_written: 1 } : { ...usage, rows_read: 9 } : usage;
    await assert.rejects(() => select(safe, "secret").first(), blocked);
    assert.equal((await d1SafetyStatus(raw)).state, "BLOCKED");
  }
});
