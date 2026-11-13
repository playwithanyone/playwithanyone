import { PolicyError, requirePolicy, resolvePolicy, type PolicyBinding } from "../../../../packages/protocol/src/policy.js";
import type { GameplayPolicy } from "./types.js";

function exact<T extends string | boolean>(expected: T): (value: unknown) => T {
  return value => { if (value !== expected) throw new PolicyError("POLICY_INVALID"); return expected; };
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 604_800_000) throw new PolicyError("POLICY_INVALID");
  return value as number;
}
export function gameplayPolicy(candidate: unknown): { policyBinding: PolicyBinding; policy: GameplayPolicy } {
  const version = (candidate as { version?: unknown } | null)?.version === 1 ? 1 : 2;
  const resolution = resolvePolicy<GameplayPolicy>(candidate, {
    policyId: "connect-four-first-playable", version,
    fields: { guestAllowed: exact(true), startCondition: exact("BOTH_PREPARED"), queueWaitMs: positive,
      disconnectGraceMs: positive, disconnectOutcome: exact("ABORT_NO_RESULT"),
      ...(version === 2 ? { executionClass: exact("hibernated-turn"), turnTimeoutMs: positive, maxRoomLifetimeMs: positive } : {}) },
  });
  const value = requirePolicy(resolution);
  return { policyBinding: value.binding, policy: value.value as GameplayPolicy };
}
