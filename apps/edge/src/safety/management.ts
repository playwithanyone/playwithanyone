import type { Env } from "../env.js";
import { ApiError, jsonResponse, readObject } from "../security.js";
import { authorizeSafetyManagement } from "./operations.js";
import type { ProtectionState, RecoveryAuthorization } from "./limits.js";
import { requirePolicy } from "../../../../packages/protocol/src/policy.js";
import { resolveSafetyPolicy, type SafetyPolicy } from "./config.js";
import { blockD1Safety, d1SafetyStatus, recoverD1Safety } from "./d1.js";

type ManagementEnv = Env & { readonly SAFETY_STOP_TOKEN?: string; readonly SAFETY_RECOVERY_TOKEN?: string };
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) throw new ApiError("INVALID_REQUEST", 400);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_REQUEST", 400);
  return value as Record<string, unknown>;
}
function auditText(value: unknown): string { if (typeof value !== "string" || value.length < 1 || value.length > 512 || /[\x00-\x1f]/.test(value)) throw new ApiError("INVALID_REQUEST", 400); return value; }
function protection(value: unknown, env: ManagementEnv): ProtectionState {
  const input = object(value);
  keys(input, ["version", "environment", "scope", "state", "reason", "issuedAt", "validUntil", "drainUntil", "operator", "incidentId"]);
  if (input["environment"] !== env.APP_ENV || input["scope"] !== "gameplay" || !["NORMAL", "WARNING", "DRAINING", "BLOCKED"].includes(String(input["state"])) || !Number.isSafeInteger(input["version"]) || (input["version"] as number) < 1 || !Number.isSafeInteger(input["issuedAt"]) || !Number.isSafeInteger(input["validUntil"]) || (input["drainUntil"] !== null && !Number.isSafeInteger(input["drainUntil"]))) throw new ApiError("INVALID_REQUEST", 400);
  auditText(input["reason"]); auditText(input["operator"]);
  if (input["incidentId"] !== null) auditText(input["incidentId"]);
  return input as unknown as ProtectionState;
}
function approvedPolicy(env: ManagementEnv): SafetyPolicy {
  let candidate: unknown;
  try { candidate = env.SAFETY_POLICY_JSON ? JSON.parse(env.SAFETY_POLICY_JSON) : undefined; return requirePolicy(resolveSafetyPolicy(candidate, env.APP_ENV)).value; }
  catch { throw new ApiError("POLICY_REQUIRED", 503, "management"); }
}
/** Fixed owner only. This is not a public generic Durable Object proxy or a cookie-authenticated admin route. */
export async function safetyManagementRoute(request: Request, env: ManagementEnv): Promise<Response | undefined> {
  const url = new URL(request.url), route = /^\/api\/ops\/safety(?:\/(protect|status|recover))?$/.exec(url.pathname);
  if (!route) return undefined;
  if (url.origin !== env.SHELL_ORIGIN || env.WORKER_ROLE !== "shell" || url.search) throw new ApiError("NOT_FOUND", 404);
  const secrets = { ...(env.SAFETY_STOP_TOKEN ? { stopToken: env.SAFETY_STOP_TOKEN } : {}), ...(env.SAFETY_RECOVERY_TOKEN ? { recoveryToken: env.SAFETY_RECOVERY_TOKEN } : {}) };
  // Authentication happens before JSON parsing, DO lookup, or reading protection/room state.
  const [stopAuthorized, recoveryAuthorized] = await Promise.all([authorizeSafetyManagement(request, "stop", secrets), authorizeSafetyManagement(request, "recover", secrets)]);
  if (!stopAuthorized && !recoveryAuthorized) throw new ApiError("AUTH_REQUIRED", 401, "management");
  const origin = request.headers.get("Origin");
  if ((origin !== null && origin !== env.SHELL_ORIGIN) || request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json") throw new ApiError("INVALID_REQUEST", 400);
  const body = await readObject(request, 4096), operation = body["operation"];
  if (!["protect", "status", "recover"].includes(String(operation)) || (route[1] !== undefined && route[1] !== operation)) throw new ApiError("INVALID_REQUEST", 400);
  let path: string, payload: Record<string, unknown>, blockDataReason: string | undefined;
  if (operation === "status") {
    keys(body, ["operation", ...(Object.hasOwn(body, "cursor") ? ["cursor"] : [])]);
    if (Object.hasOwn(body, "cursor") && (typeof body["cursor"] !== "string" || !/^[a-f0-9-]{36}:[a-f0-9-]{36}$/.test(body["cursor"]))) throw new ApiError("INVALID_REQUEST", 400);
    path = "/safety/status"; payload = body["cursor"] ? { cursor: body["cursor"] } : {};
  }
  else if (operation === "protect") {
    if (!stopAuthorized) throw new ApiError("AUTH_REQUIRED", 401, "management");
    keys(body, ["operation", "protection"]);
    const update = protection(body["protection"], env);
    // NORMAL may refresh an unexpired NORMAL heartbeat. The owner's persisted latch
    // rejects lowering WARNING/DRAINING/BLOCKED or reviving expired state on this path.
    if (update.state === "BLOCKED") blockDataReason = update.reason;
    path = "/safety/apply"; payload = { protection: update };
  } else {
    if (!recoveryAuthorized) throw new ApiError("AUTH_REQUIRED", 401, "management");
    keys(body, ["operation", "protection", "record"]);
    const update = protection(body["protection"], env), record = object(body["record"]);
    keys(record, ["actor", "reason", "configurationVersion", "validationRecord"]);
    const authorization: RecoveryAuthorization = { authenticated: true, actor: auditText(record["actor"]), reason: auditText(record["reason"]), configurationVersion: auditText(record["configurationVersion"]), validationRecord: auditText(record["validationRecord"]) };
    if (update.state !== "NORMAL" || update.operator !== authorization.actor) throw new ApiError("INVALID_REQUEST", 400);
    if (!env.MATCH_POOL) throw new ApiError("CAPABILITY_UNAVAILABLE", 503, "management");
    // Data unlock must succeed before matching/rooms can return to NORMAL.
    // A partial recovery leaves the pool stopped and reports failure.
    await recoverD1Safety(env.DB, approvedPolicy(env), authorization, update.version);
    path = "/safety/recover"; payload = { protection: update, authorization };
  }
  if (!env.MATCH_POOL) throw new ApiError("CAPABILITY_UNAVAILABLE", 503, "management");
  const stub = env.MATCH_POOL.get(env.MATCH_POOL.idFromName("connect-four-v1"));
  let result: Record<string, unknown>, status: number;
  try {
    const response = await stub.fetch(new Request(`https://internal${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) }));
    result = object(await response.json()); status = response.status;
  } catch { result = { state: "UNKNOWN", version: null, newAllocationsBlocked: true, error: { code: "POOL_PROTECTION_UNAVAILABLE" } }; status = 503; }
  // The room/pool stop and the data stop are independent: attempt both even if
  // one failed. Do not roll back an already successful protective action.
  if (blockDataReason !== undefined && (result["state"] === "BLOCKED" || result["state"] === "UNKNOWN")) {
    try { await blockD1Safety(env.DB, approvedPolicy(env), blockDataReason, Date.now(), (payload["protection"] as ProtectionState).version); }
    catch { result = { ...result, dataStopUnconfirmed: true }; status = 503; }
  }
  const d1 = await d1SafetyStatus(env.DB);
  const poolState = result["state"];
  const combinedState = d1.state === "NORMAL" ? poolState : d1.state;
  const propagationClear = result["propagationPending"] !== true && result["propagationFailed"] !== true && (result["propagationFailures"] === undefined || (Array.isArray(result["propagationFailures"]) && result["propagationFailures"].length === 0));
  result = { ...result, poolState, state: combinedState, d1, newAllocationsBlocked: result["newAllocationsBlocked"] === true || d1.state !== "NORMAL", fullRecoveryObserved: poolState === "NORMAL" && d1.state === "NORMAL" && result["newAllocationsBlocked"] === false && result["unobservedRooms"] === 0 && propagationClear && (operation !== "recover" || result["version"] === (payload["protection"] as ProtectionState).version) };
  // Do not forward internal headers, cookies or arbitrary response types to the management caller.
  return jsonResponse(result, env, status);
}
