import { createHash } from "node:crypto";

const levels = { NORMAL: 0, WARNING: 1, DRAINING: 2, BLOCKED: 3 };
export function validateConfig(config) {
  if (!config || config.schemaVersion !== 1 || !["fixture", "preview", "production"].includes(config.environment) || !/^[a-zA-Z0-9._:-]{1,128}$/.test(config.accountId ?? "") || !Number.isSafeInteger(config.configurationVersion) || config.configurationVersion < 1) throw new Error("WATCHDOG_CONFIG_INVALID");
  for (const key of ["intervalMs", "maxMetricAgeMs", "missingDataStopMs", "drainMs", "maxRunMs", "maxApiCalls", "requestTimeoutMs", "maxResponseBytes", "maxLogBytes", "notificationRepeatMs"]) if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`WATCHDOG_CONFIG_INVALID:${key}`);
  if (config.notificationRequestTimeoutMs !== undefined && (!Number.isSafeInteger(config.notificationRequestTimeoutMs) || config.notificationRequestTimeoutMs < 1 || config.notificationRequestTimeoutMs > Math.min(30_000, config.maxRunMs))) throw new Error("WATCHDOG_NOTIFICATION_TIMEOUT_INVALID");
  if (config.requestTimeoutMs > config.maxRunMs || config.maxRunMs > 60_000 || config.maxResponseBytes > 2 * 1024 * 1024 || !Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 2 || !Array.isArray(config.metrics) || config.metrics.length > 32 || new Set(config.metrics.map(item => item.id)).size !== config.metrics.length) throw new Error("WATCHDOG_BOUNDS_INVALID");
  for (const metric of config.metrics) {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(metric.id ?? "") || !["workers", "durable-objects", "d1", "r2", "turn", "simulation"].includes(metric.service) || !["requests", "rows", "bytes", "count", "milliseconds", "USD-minor"].includes(metric.unit) || !Number.isFinite(metric.warn) || !Number.isFinite(metric.stop) || metric.warn < 0 || metric.stop <= metric.warn || (metric.maxPerSecond !== null && (!Number.isFinite(metric.maxPerSecond) || metric.maxPerSecond <= 0))) throw new Error("WATCHDOG_METRIC_INVALID");
  }
  if (!Array.isArray(config.allowedManagementOrigins) || config.allowedManagementOrigins.some(origin => { try { const parsed = new URL(origin); return parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password; } catch { return true; } })) throw new Error("WATCHDOG_MANAGEMENT_ORIGINS_INVALID");
  if (config.management !== null && config.management !== undefined) {
    for (const key of ["stopUrl", "verifyUrl", "recoveryUrl"]) {
      try { const parsed = new URL(config.management[key]); if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || !config.allowedManagementOrigins.includes(parsed.origin) || !parsed.pathname.startsWith("/api/ops/")) throw new Error(); }
      catch { throw new Error("WATCHDOG_MANAGEMENT_TARGET_INVALID"); }
    }
  }
  if (config.environment === "production" && (!config.productionApproved || !config.notificationVerified || !config.recoveryVerified || !config.externalBlockingVerified)) throw new Error("POLICY_REQUIRED:production protection approvals");
  return config;
}
export function initialState(environment) {
  return { schemaVersion: 1, environment, version: 0, state: "NORMAL", incidentId: null, reasons: [], firstMissing: {}, lastMetrics: {}, drainUntil: null, lastNotification: null, receipts: [], recovered: null };
}
/** Cumulative observations replace the last same-window observation; never add successive snapshots. */
export function evaluateMetrics(config, previous, observations, now) {
  validateConfig(config);
  if (!Number.isSafeInteger(now) || now < 0 || previous.environment !== config.environment || previous.schemaVersion !== 1 || !Object.hasOwn(levels, previous.state)) throw new Error("WATCHDOG_STATE_INVALID");
  const state = structuredClone(previous);
  const observed = new Map();
  for (const item of observations) { if (observed.has(item.id)) throw new Error("DUPLICATE_METRIC_OBSERVATION"); observed.set(item.id, item); }
  let desired = "NORMAL"; const reasons = []; const values = [];
  for (const metric of config.metrics) {
    const item = observed.get(metric.id);
    const last = previous.lastMetrics[metric.id];
    const sourceValid = typeof item?.source === "string" && (/^Cloudflare GraphQL:[a-zA-Z0-9]{1,80}$/.test(item.source) || (config.environment === "fixture" && item.source === "FIXTURE_ONLY"));
    let quality = ["VALID", "STALE", "UNAVAILABLE"].includes(item?.quality) ? item.quality : "UNAVAILABLE";
    if (!item || !sourceValid || item.unit !== metric.unit || !Number.isFinite(item.value) || item.value < 0 || !Number.isSafeInteger(item.dataThrough) || !Number.isSafeInteger(item.collectedAt) || item.dataThrough > now || item.collectedAt > now || !Number.isSafeInteger(item.windowStart) || !Number.isSafeInteger(item.windowEnd) || item.windowStart >= item.windowEnd || item.dataThrough < item.windowStart || item.dataThrough > item.windowEnd || typeof item.windowId !== "string" || item.windowId.length > 160 || !item.windowId || /[\x00-\x1f]/.test(item.windowId)) quality = "UNAVAILABLE";
    else if (now - item.dataThrough > config.maxMetricAgeMs || now - item.collectedAt > config.maxMetricAgeMs) quality = "STALE";
    if (quality === "VALID" && last?.windowId === item.windowId && (item.value < last.value || item.dataThrough < last.dataThrough)) quality = "UNAVAILABLE";
    values.push({ id: metric.id, service: metric.service, quality, value: quality === "VALID" ? item.value : null, unit: metric.unit, warn: metric.warn, stop: metric.stop, dataThrough: Number.isSafeInteger(item?.dataThrough) ? item.dataThrough : null, source: sourceValid ? item.source : "UNAVAILABLE" });
    if (quality !== "VALID") {
      state.firstMissing[metric.id] ??= now;
      const limitExceeded = now - state.firstMissing[metric.id] >= config.missingDataStopMs;
      const level = limitExceeded ? "DRAINING" : "WARNING";
      if (levels[level] > levels[desired]) desired = level;
      reasons.push(`${metric.id}:METRIC_${quality}`);
      continue;
    }
    delete state.firstMissing[metric.id];
    let level = item.value >= metric.stop ? "DRAINING" : item.value >= metric.warn ? "WARNING" : "NORMAL";
    if (last?.windowId === item.windowId && item.dataThrough > last.dataThrough && metric.maxPerSecond !== null && (item.value - last.value) / ((item.dataThrough - last.dataThrough) / 1000) > metric.maxPerSecond) { level = "DRAINING"; reasons.push(`${metric.id}:GROWTH_RATE`); }
    if (item.value >= metric.warn) reasons.push(`${metric.id}:${item.value >= metric.stop ? "STOP_THRESHOLD" : "WARNING_THRESHOLD"}`);
    if (levels[level] > levels[desired]) desired = level;
    state.lastMetrics[metric.id] = { windowId: item.windowId, value: item.value, dataThrough: item.dataThrough, collectedAt: item.collectedAt, source: item.source, unit: item.unit };
  }
  // Once warned/stopped, no scheduler tick, free-quota reset or config change can lower the incident.
  if (levels[previous.state] > levels[desired]) desired = previous.state;
  if (desired === "DRAINING") {
    state.drainUntil ??= now + config.drainMs;
    if (now >= state.drainUntil) desired = "BLOCKED";
  }
  state.version += 1;
  state.state = desired;
  state.reasons = reasons.length ? reasons : previous.reasons;
  if (desired !== "NORMAL") state.incidentId ??= createHash("sha256").update(`${config.environment}:${now}:${state.version}`).digest("hex").slice(0, 24);
  state.checkedAt = now; state.configurationVersion = config.configurationVersion;
  return { state, observations: values, shouldStop: desired === "DRAINING" || desired === "BLOCKED", shouldNotify: desired !== "NORMAL" && (!previous.lastNotification || previous.lastNotification.incidentId !== state.incidentId || levels[desired] > levels[previous.lastNotification.level] || now - previous.lastNotification.at >= config.notificationRepeatMs || previous.receipts.some(item => item.status === "FAILED")) };
}
export function recoverState(previous, record, now) {
  if (!record.authenticated || typeof record.actor !== "string" || !record.actor || !record.reason || !record.configurationVersion || !record.validationRecord || !record.serverObservedRecovery) throw new Error("RECOVERY_REQUIRED");
  return { ...previous, version: previous.version + 1, state: "NORMAL", incidentId: null, reasons: [], firstMissing: {}, drainUntil: null, lastNotification: null, receipts: [], recovered: { actor: record.actor, reason: record.reason, configurationVersion: record.configurationVersion, validationRecord: record.validationRecord, at: now } };
}
export function protectionCommand(state, config, now) {
  return { version: state.version, environment: config.environment, scope: "gameplay", state: state.state, reason: state.reasons.join(",").slice(0, 512) || "MANUAL_RECOVERY", issuedAt: now, validUntil: now + config.maxMetricAgeMs + config.intervalMs + config.drainMs, drainUntil: state.state === "DRAINING" ? state.drainUntil : null, operator: "cost-watchdog", incidentId: state.incidentId };
}
export function notificationPayload(evaluation, config) {
  return { environment: config.environment, accountId: config.accountId, incidentId: evaluation.state.incidentId, state: evaluation.state.state, reasons: evaluation.state.reasons, observed: evaluation.observations, actions: evaluation.state.receipts, recoveryEntry: config.management?.recoveryUrl ?? "UNCONFIGURED" };
}
