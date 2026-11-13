import { SafetyError, type SafetyPolicy } from "./config.js";

export interface StopAction {
  readonly name: "persist-protection" | "block-entry" | "stop-matching" | "close-rooms" | "stop-background" | "revoke-turn" | "stop-instances" | "notify";
  readonly stop: (signal: AbortSignal) => Promise<void>;
  readonly observeStopped?: (signal: AbortSignal) => Promise<boolean>;
}
export interface StopReceipt { readonly action: StopAction["name"]; readonly status: "ACKNOWLEDGED" | "OBSERVED_STOPPED" | "UNCONFIRMED" | "FAILED" }
async function bounded<T>(callback: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([callback(controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("STOP_TIMEOUT")); }, timeoutMs); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
/** No deletion operation exists. Persistence/notification failures never prevent the other stop attempts. */
export async function runStopActions(actions: readonly StopAction[], timeoutMs: number): Promise<readonly StopReceipt[]> {
  if (actions.length > 8 || new Set(actions.map(action => action.name)).size !== actions.length || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new SafetyError("SAFETY_INVALID", "bounded unique stop actions required");
  return Promise.all(actions.map(async (action): Promise<StopReceipt> => {
    try {
      await bounded(signal => action.stop(signal), timeoutMs);
      if (!action.observeStopped) return { action: action.name, status: "ACKNOWLEDGED" };
      const observed = await bounded(signal => action.observeStopped!(signal), timeoutMs);
      return { action: action.name, status: observed ? "OBSERVED_STOPPED" : "UNCONFIRMED" };
    } catch { return { action: action.name, status: "FAILED" }; }
  }));
}

export interface EntryInventoryItem {
  readonly id: string;
  readonly kind: "public-http" | "management" | "r2-direct" | "alarm" | "cron" | "turn" | "instance";
  readonly enabled: boolean;
  readonly address: string;
  readonly protection: "APPLICATION" | "EXTERNAL_VERIFIED" | "DISABLED" | "NOT_VERIFIED";
}
/** Deployment review input, not a substitute for probing actual WAF or alternate routes. */
export function assertEntryInventory(entries: readonly EntryInventoryItem[], requiredPublicOrigins: readonly string[], managementPrefix: string, blockedPrefixes: readonly string[]): void {
  if (!entries.length || new Set(entries.map(item => item.id)).size !== entries.length) throw new SafetyError("SAFETY_INVALID", "unique entry inventory required");
  for (const origin of requiredPublicOrigins) {
    if (!entries.some(entry => entry.enabled && entry.kind === "public-http" && new URL(entry.address).origin === origin && entry.protection !== "NOT_VERIFIED")) throw new SafetyError("SAFETY_INVALID", "public origin is absent or has unverified protection");
  }
  if (blockedPrefixes.some(prefix => managementPrefix.startsWith(prefix))) throw new SafetyError("SAFETY_INVALID", "entry stop rule covers recovery path");
  if (!entries.some(entry => entry.enabled && entry.kind === "management" && new URL(entry.address).pathname.startsWith(managementPrefix))) throw new SafetyError("SAFETY_INVALID", "independent authenticated management entry required");
  if (entries.some(entry => entry.kind === "r2-direct" && entry.enabled)) throw new SafetyError("SAFETY_INVALID", "uncontrolled R2 direct entry");
}
/** The endpoint must call this before reading operational state or accepting a stop/recovery body. */
export async function authorizeSafetyManagement(request: Request, operation: "stop" | "recover", secrets: { readonly stopToken?: string; readonly recoveryToken?: string }): Promise<boolean> {
  if (request.method !== "POST" || !secrets.stopToken || !secrets.recoveryToken || secrets.stopToken === secrets.recoveryToken || secrets.stopToken.length < 32 || secrets.recoveryToken.length < 32) return false;
  const expected = operation === "stop" ? secrets.stopToken : secrets.recoveryToken;
  const actual = request.headers.get("Authorization");
  if (!actual || actual.length > 512 || !actual.startsWith("Bearer ")) return false;
  const encoder = new TextEncoder();
  const hashes = await Promise.all([expected, actual.slice(7)].map(value => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  const left = new Uint8Array(hashes[0]!), right = new Uint8Array(hashes[1]!);
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}

export function assertPaidServiceEnabled(policy: SafetyPolicy, service: "turn" | "simulation"): void {
  if (policy.services[service] !== "enabled" || policy.mode !== "paid" || !policy.paid || !policy.watchdog) throw new SafetyError("POLICY_REQUIRED", `${service} is disabled or lacks approved paid protection`);
}
