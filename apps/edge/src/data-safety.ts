import type { Env } from "./env.js";
import { requirePolicy } from "../../../packages/protocol/src/policy.js";
import { resolveSafetyPolicy, SafetyError } from "./safety/config.js";
import { withD1Safety, type D1SafetyIncident } from "./safety/d1.js";

export interface DataSafetyContext {
  readonly waitUntil?: (task: Promise<unknown>) => void;
  readonly onIncident?: (incident: D1SafetyIncident, signal: AbortSignal) => void | Promise<void>;
}

/** All D1 consumers share a durable daily ledger in the existing database.
 * Pure fixtures without this explicit binding retain their original test adapters.
 */
export function withDataSafety<E extends Env>(env: E, context: DataSafetyContext = {}): E {
  // Explicit L0 fixtures can exercise one boundary with a small Database stand-in.
  // Actual workerd fixtures provide the policy and run the native D1 guard.
  if (env.APP_ENV === "fixture" && env.SAFETY_POLICY_JSON === undefined) return env;
  if (env.RESOURCE_SAFETY_REQUIRED !== "true" && env.APP_ENV !== "production") return env;
  let binding: unknown;
  try { binding = env.SAFETY_POLICY_JSON ? JSON.parse(env.SAFETY_POLICY_JSON) : undefined; }
  catch { throw new SafetyError("POLICY_REQUIRED", "D1 safety configuration required"); }
  const policy = requirePolicy(resolveSafetyPolicy(binding, env.APP_ENV)).value;
  const onIncident = (incident: D1SafetyIncident, signal: AbortSignal): void | Promise<void> => {
    const task = context.onIncident ? Promise.resolve(context.onIncident(incident, signal)) : (async () => {
      if (!env.MATCH_POOL) throw new SafetyError("SAFETY_BLOCKED", "Existing-room stop owner is unavailable");
      const owner = env.MATCH_POOL.get(env.MATCH_POOL.idFromName("connect-four-v1"));
      const response = await owner.fetch(new Request("https://pool.internal/safety/incident", {
        method: "POST", signal: AbortSignal.timeout(5_000), headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "D1_SAFETY_INCIDENT", incident }),
      }));
      const accepted = response.ok; await response.arrayBuffer();
      if (!accepted) throw new SafetyError("SAFETY_BLOCKED", "Existing-room stop propagation was not acknowledged");
    })();
    if (context.waitUntil) {
      context.waitUntil(task.catch(() => { console.error("COST_SAFETY_EXISTING_ROOM_STOP_UNCONFIRMED"); }));
      return;
    }
    return task;
  };
  return { ...env, DB: withD1Safety(env.DB, policy, { onIncident, readLease: { maxRows: 512, maxAgeMs: 60_000 } }) };
}
