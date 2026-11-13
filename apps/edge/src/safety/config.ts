import { PolicyError, resolvePolicy, type PolicyResolution } from "../../../../packages/protocol/src/policy.js";

export type SafetyEnvironment = "fixture" | "preview" | "production";
export interface Quota {
  readonly maxActiveRooms: number;
  readonly maxCreatesPerMinute: number;
  readonly maxCreatesPerDay: number;
  readonly maxCreatesPerCycle: number;
  readonly maxActivityMsPerDay: number;
  readonly maxActivityMsPerCycle: number;
}
export type ExecutionClass = "hibernated-turn" | "p2p-signaling" | "realtime-tick";
export interface ExecutionQuota extends Quota { readonly executionClass: ExecutionClass; readonly enabled: boolean; readonly maxRoomLifetimeMs: number }
export interface PoolQuota extends Quota {
  readonly poolId: string;
  readonly accountingKey: string;
  readonly legacyPoolIds: readonly string[];
  readonly executionClass: ExecutionClass;
  readonly enabled: boolean;
}
export interface SafetyPolicy extends Record<string, unknown> {
  readonly environment: SafetyEnvironment;
  readonly mode: "free-preview" | "paid";
  readonly accountId: string;
  readonly cycle: { readonly id: string; readonly startsAt: number; readonly endsAt: number };
  readonly services: { readonly workers: "Free" | "Paid"; readonly durableObjects: "Free" | "Paid"; readonly d1: "Free" | "Paid"; readonly r2: "disabled" | "Standard-existing"; readonly turn: "disabled" | "enabled"; readonly simulation: "disabled" | "enabled" };
  readonly global: Quota;
  readonly pools: readonly PoolQuota[];
  readonly executionClasses: readonly ExecutionQuota[];
  readonly room: { readonly maxMessageBytes: number; readonly messagesPerSecond: number; readonly maxTotalMessages: number; readonly maxBroadcastFanout: number; readonly maxQueuedBytes: number; readonly maxLifetimeMs: number; readonly protectionMaxAgeMs: number; readonly closeGraceMs: number; readonly maxCleanupOperations: number };
  readonly data: { readonly maxD1RowsReadPerOperation: number; readonly maxD1RowsWrittenPerOperation: number; readonly maxD1RowsReadPerDay: number; readonly maxD1RowsWrittenPerDay: number; readonly maxR2ObjectBytes: number; readonly maxR2ObjectsPerPublication: number; readonly maxR2BytesPerPublication: number; readonly maxR2WritesPerCycle: number; readonly maxR2ReadsPerCycle: number; readonly maxR2StoredBytes: number; readonly maxLogBytesPerRun: number; readonly maxRetries: number };
  readonly watchdog: { readonly maxMetricAgeMs: number; readonly maxRunMs: number; readonly maxApiCalls: number; readonly maxRetries: number; readonly notificationRepeatMs: number } | null;
  readonly paid: { readonly currency: "USD"; readonly targetMinor: number; readonly fixedMinor: number; readonly otherMinor: number; readonly reserveMinor: number; readonly warnMinor: number; readonly stopMinor: number; readonly allowUncappedUsage: boolean; readonly notificationVerified: boolean; readonly recoveryEntryVerified: boolean } | null;
}
export class SafetyError extends Error {
  constructor(readonly code: "SAFETY_LIMIT" | "SAFETY_BLOCKED" | "SAFETY_EXPIRED" | "SAFETY_INVALID" | "POLICY_REQUIRED" | "RECOVERY_REQUIRED", readonly detail: string) { super(`${code}: ${detail}`); this.name = "SafetyError"; }
}
const quotaKeys = ["maxActiveRooms", "maxCreatesPerMinute", "maxCreatesPerDay", "maxCreatesPerCycle", "maxActivityMsPerDay", "maxActivityMsPerCycle"] as const;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("object required");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some(key => !Object.hasOwn(object, key))) throw new Error("closed fields required");
  return object;
}
function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error("bounded non-negative integer required");
  return value as number;
}
function text(value: unknown): string { if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) throw new Error("identifier required"); return value; }
function choice<T extends string>(value: unknown, values: readonly T[]): T { if (!values.includes(value as T)) throw new Error("unsupported value"); return value as T; }
function boole(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("boolean required"); return value; }
function numericObject<T>(value: unknown, keys: readonly string[]): T {
  const object = record(value, keys);
  return Object.fromEntries(keys.map(key => [key, integer(object[key])])) as T;
}
function quota(value: unknown, enabled = true): Quota {
  const q = numericObject<Quota>(value, quotaKeys);
  if ((!enabled && quotaKeys.some(key => q[key] !== 0)) || (enabled && (q.maxActiveRooms < 1 || q.maxCreatesPerMinute < 1)) || q.maxCreatesPerDay < q.maxCreatesPerMinute || q.maxCreatesPerCycle < q.maxCreatesPerDay || q.maxActivityMsPerCycle < q.maxActivityMsPerDay) throw new Error("quota ordering");
  return q;
}
/** A production template remains UNSPECIFIED. No example dollar amount becomes a default. */
export function resolveSafetyPolicy(candidate: unknown, expectedEnvironment: SafetyEnvironment): PolicyResolution<SafetyPolicy> {
  const resolution = resolvePolicy<SafetyPolicy>(candidate, { policyId: "pwa-cost-safety", version: 1, fields: {
    environment: value => choice(value, ["fixture", "preview", "production"]),
    mode: value => choice(value, ["free-preview", "paid"]),
    accountId: text,
    cycle: value => { const object = record(value, ["id", "startsAt", "endsAt"]); const start = integer(object["startsAt"]), end = integer(object["endsAt"]); if (start >= end) throw new Error("empty cycle"); return { id: text(object["id"]), startsAt: start, endsAt: end }; },
    services: value => { const object = record(value, ["workers", "durableObjects", "d1", "r2", "turn", "simulation"]); return { workers: choice(object["workers"], ["Free", "Paid"]), durableObjects: choice(object["durableObjects"], ["Free", "Paid"]), d1: choice(object["d1"], ["Free", "Paid"]), r2: choice(object["r2"], ["disabled", "Standard-existing"]), turn: choice(object["turn"], ["disabled", "enabled"]), simulation: choice(object["simulation"], ["disabled", "enabled"]) }; },
    global: quota,
    executionClasses: value => {
      if (!Array.isArray(value) || value.length !== 3) throw new Error("explicit execution classes required");
      return value.map(item => { const object = record(item, ["executionClass", "enabled", "maxRoomLifetimeMs", ...quotaKeys]); const enabled = boole(object["enabled"]); const maxRoomLifetimeMs = integer(object["maxRoomLifetimeMs"]);
        if ((enabled && (maxRoomLifetimeMs < 1 || maxRoomLifetimeMs > 86_400_000)) || (!enabled && maxRoomLifetimeMs !== 0)) throw new Error("execution lifetime");
        return { executionClass: choice(object["executionClass"], ["hibernated-turn", "p2p-signaling", "realtime-tick"]), enabled, maxRoomLifetimeMs, ...quota(Object.fromEntries(quotaKeys.map(key => [key, object[key]])), enabled) };
      });
    },
    pools: value => { if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new Error("pool list required"); return value.map(item => {
      const object = record(item, ["poolId", "accountingKey", "legacyPoolIds", "executionClass", "enabled", ...quotaKeys]); const enabled = boole(object["enabled"]);
      if (!Array.isArray(object["legacyPoolIds"]) || object["legacyPoolIds"].length > 8) throw new Error("bounded legacy pool aliases required");
      return { poolId: text(object["poolId"]), accountingKey: text(object["accountingKey"]), legacyPoolIds: object["legacyPoolIds"].map(text), executionClass: choice(object["executionClass"], ["hibernated-turn", "p2p-signaling", "realtime-tick"]), enabled,
        ...quota(Object.fromEntries(quotaKeys.map(key => [key, object[key]])), enabled) };
    }); },
    room: value => { const result = numericObject<SafetyPolicy["room"]>(value, ["maxMessageBytes", "messagesPerSecond", "maxTotalMessages", "maxBroadcastFanout", "maxQueuedBytes", "maxLifetimeMs", "protectionMaxAgeMs", "closeGraceMs", "maxCleanupOperations"]); if (Object.values(result).some(item => item < 1) || result.maxMessageBytes > 1024 * 1024 || result.maxLifetimeMs > 86_400_000 || result.protectionMaxAgeMs > 86_400_000) throw new Error("room bounds"); return result; },
    data: value => numericObject<SafetyPolicy["data"]>(value, ["maxD1RowsReadPerOperation", "maxD1RowsWrittenPerOperation", "maxD1RowsReadPerDay", "maxD1RowsWrittenPerDay", "maxR2ObjectBytes", "maxR2ObjectsPerPublication", "maxR2BytesPerPublication", "maxR2WritesPerCycle", "maxR2ReadsPerCycle", "maxR2StoredBytes", "maxLogBytesPerRun", "maxRetries"]),
    watchdog: value => value === null ? null : numericObject<NonNullable<SafetyPolicy["watchdog"]>>(value, ["maxMetricAgeMs", "maxRunMs", "maxApiCalls", "maxRetries", "notificationRepeatMs"]),
    paid: value => {
      if (value === null) return null;
      const object = record(value, ["currency", "targetMinor", "fixedMinor", "otherMinor", "reserveMinor", "warnMinor", "stopMinor", "allowUncappedUsage", "notificationVerified", "recoveryEntryVerified"]);
      return { currency: choice(object["currency"], ["USD"]), targetMinor: integer(object["targetMinor"]), fixedMinor: integer(object["fixedMinor"]), otherMinor: integer(object["otherMinor"]), reserveMinor: integer(object["reserveMinor"]), warnMinor: integer(object["warnMinor"]), stopMinor: integer(object["stopMinor"]), allowUncappedUsage: boole(object["allowUncappedUsage"]), notificationVerified: boole(object["notificationVerified"]), recoveryEntryVerified: boole(object["recoveryEntryVerified"]) };
    },
  } });
  if (resolution.status !== "BOUND") return resolution;
  const policy = resolution.value;
  if (policy.environment !== expectedEnvironment) throw new PolicyError("POLICY_INVALID");
  const ids = new Set(policy.pools.map(pool => pool.poolId));
  const accountingKeys = new Set(policy.pools.map(pool => pool.accountingKey));
  const aliases = policy.pools.flatMap(pool => [pool.poolId, ...pool.legacyPoolIds]);
  const classes = new Set(policy.executionClasses.map(item => item.executionClass));
  if (ids.size !== policy.pools.length || accountingKeys.size !== policy.pools.length || new Set(aliases).size !== aliases.length || classes.size !== 3 || quotaKeys.some(key => policy.pools.reduce((sum, pool) => sum + pool[key], 0) > policy.global[key])) throw new PolicyError("POLICY_INVALID");
  for (const execution of policy.executionClasses) {
    const pools = policy.pools.filter(pool => pool.executionClass === execution.executionClass);
    if (pools.some(pool => pool.enabled && !execution.enabled) || quotaKeys.some(key => pools.reduce((sum, pool) => sum + pool[key], 0) > execution[key]) ||
        (execution.executionClass !== "realtime-tick" && (execution.maxActivityMsPerDay !== 0 || execution.maxActivityMsPerCycle !== 0))) throw new PolicyError("POLICY_INVALID");
  }
  if (policy.mode === "free-preview") {
    if (policy.environment === "production" || policy.services.workers !== "Free" || policy.services.durableObjects !== "Free" || policy.services.d1 !== "Free" || policy.services.turn !== "disabled" || policy.services.simulation !== "disabled" || policy.paid !== null) throw new PolicyError("POLICY_INVALID");
  } else {
    const budget = policy.paid;
    const required: string[] = [];
    if (budget === null) required.push("paid");
    if (policy.watchdog === null) required.push("watchdog");
    if (budget && (!budget.notificationVerified || !budget.recoveryEntryVerified)) required.push("paid.notificationVerified", "paid.recoveryEntryVerified");
    if (required.length) return { status: "UNSPECIFIED", requiredKeys: required };
    if (!budget || budget.warnMinor >= budget.stopMinor || budget.stopMinor + budget.reserveMinor + budget.fixedMinor + budget.otherMinor > budget.targetMinor || budget.stopMinor < 1 || !budget.allowUncappedUsage) throw new PolicyError("POLICY_INVALID");
  }
  return resolution;
}
