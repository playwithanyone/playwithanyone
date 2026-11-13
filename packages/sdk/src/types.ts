/** Browser presentation protocol v1. Platform authentication never crosses this bridge. */
export const SDK_PROTOCOL_VERSION = 1;
export const SDK_CAPABILITIES = ["ready", "state.subscribe", "assets.resolve", "actions.dispatch"] as const;
export type SdkCapability = typeof SDK_CAPABILITIES[number];
export type SdkMethod = "ready" | "assets.resolve" | "actions.dispatch";
export type Unsubscribe = () => void;

export type SdkErrorCode =
  | "SDK_INVALID_CONFIG" | "SDK_PROTOCOL" | "SDK_LIMIT" | "SDK_TRANSFER"
  | "BUFFER_DETACHED" | "BOOT_TIMEOUT" | "REQUEST_TIMEOUT" | "PRESENTATION_REVOKED"
  | "CAPABILITY_UNAVAILABLE" | "MATCH_REQUIRED" | "STALE_BINDING" | "REQUEST_ORDER"
  | "BACKPRESSURE" | "COMMAND_INVALID" | "ASSET_UNKNOWN" | "ASSET_INTEGRITY"
  | "AUTH_EXPIRED" | "AUTH_REQUIRED" | "INTERNAL_ERROR";

export class SdkError extends Error {
  readonly scope = "presentation";
  readonly retryable: boolean;
  constructor(readonly code: SdkErrorCode) {
    super(code);
    this.name = "SdkError";
    this.retryable = code === "BACKPRESSURE";
  }
}

export interface SdkLimits {
  readonly maxMessageBytes: number;
  readonly maxRequestsPerWindow: number;
  readonly requestWindowMs: number;
  readonly maxPendingRequests: number;
  readonly bootstrapTimeoutMs: number;
  readonly requestTimeoutMs: number;
}
/** Engineering budgets only; none of these decide queue duration or game outcomes. */
export const DEFAULT_SDK_LIMITS: SdkLimits = Object.freeze({
  maxMessageBytes: 65_536,
  maxRequestsPerWindow: 60,
  requestWindowMs: 1_000,
  maxPendingRequests: 32,
  bootstrapTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
});

export interface MatchScope {
  readonly matchId: string;
  readonly role: "PLAYER" | "SPECTATOR";
  readonly seatId?: string;
  readonly seatEpoch?: number;
  readonly inputSessionId?: string;
  readonly authorityEpoch: number;
}
export interface PresentationGrant {
  readonly bindingId: string;
  readonly sessionId: string;
  readonly expiresAt: number;
  readonly capabilityIds: readonly SdkCapability[];
  readonly matchScope?: MatchScope;
}
/** Kept exclusively inside the trusted Shell. Never post this object to a game. */
export interface PresentationBinding extends PresentationGrant {
  readonly presentationInstanceId: string;
  readonly gameBuildId: string;
  readonly frameOrigin: string;
  readonly sdkProtocolVersion: 1;
}
export type PublicMatchScope = Omit<MatchScope, "inputSessionId">;
export interface PublicPresentation {
  readonly bindingId: string;
  readonly presentationInstanceId: string;
  readonly gameBuildId: string;
  readonly sdkProtocolVersion: 1;
  readonly capabilityIds: readonly SdkCapability[];
  readonly expiresAt: number;
  readonly matchScope?: PublicMatchScope;
}
export interface PublicSessionContext {
  readonly presentationInstanceId: string;
  readonly gameBuildId: string;
  readonly matchScope?: PublicMatchScope;
}
export interface AssetReference {
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mime: string;
}
export interface ViewEnvelope<View> {
  readonly revision: number;
  readonly view: View;
}
export interface LifecycleEvent {
  readonly type: "CONNECTED" | "REVOKED";
  readonly reason?: string;
}
export interface GameClient<Command = unknown, View = unknown> {
  readonly session: Readonly<PublicSessionContext>;
  readonly capabilities: readonly SdkCapability[];
  ready(): Promise<void>;
  readonly actions: { dispatch(command: Command, options?: { readonly transfer?: readonly ArrayBuffer[] }): Promise<unknown> };
  readonly state: { subscribe(listener: (view: ViewEnvelope<View>) => void): Unsubscribe };
  readonly lifecycle: { subscribe(listener: (event: LifecycleEvent) => void): Unsubscribe };
  readonly assets: {
    resolve(path: string): Promise<AssetReference>;
    fetch(path: string): Promise<ArrayBuffer>;
  };
  dispose(): void;
}

export interface BootChallenge {
  readonly type: "BOOT_CHALLENGE";
  readonly sdkProtocolVersion: 1;
  readonly presentationInstanceId: string;
  readonly nonce: string;
  readonly gameBuildId: string;
}
export type BootHello = Omit<BootChallenge, "type"> & { readonly type: "HELLO" };
export type BootPort = Omit<BootChallenge, "type"> & { readonly type: "BOOT_PORT"; readonly binding: PublicPresentation };
export interface PortIdentity {
  readonly sdkProtocolVersion: 1;
  readonly bindingId: string;
  readonly presentationInstanceId: string;
}
export type PortAck = PortIdentity & { readonly type: "PORT_ACK" };
export type PortReady = PortIdentity & { readonly type: "PORT_READY" };
export type RequestMessage = PortIdentity & {
  readonly type: "REQUEST";
  readonly requestId: number;
  readonly method: SdkMethod;
  readonly payload: unknown;
};
export type ResponseMessage = PortIdentity & {
  readonly type: "RESPONSE";
  readonly requestId: number;
  readonly ok: boolean;
  readonly payload?: unknown;
  readonly error?: SdkErrorCode;
};
export type StateMessage = PortIdentity & { readonly type: "STATE"; readonly revision: number; readonly view: unknown };
export type RevokedMessage = PortIdentity & { readonly type: "REVOKED"; readonly reason: string };
export type DisposeMessage = PortIdentity & { readonly type: "DISPOSE" };

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function hasKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
export function isId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256; }
export function isBuild(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
export function isPosition(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_fffe; }
export function isNonce(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{32}$/.test(value); }
export function assertOrigin(origin: string): void {
  let url: URL;
  try { url = new URL(origin); } catch { throw new SdkError("SDK_INVALID_CONFIG"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== origin || url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new SdkError("SDK_INVALID_CONFIG");
  }
}
export function validateLimits(partial: Partial<SdkLimits> = {}): SdkLimits {
  const limits = Object.freeze({ ...DEFAULT_SDK_LIMITS, ...partial });
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new SdkError("SDK_INVALID_CONFIG");
  if (limits.maxMessageBytes > 65_536 || limits.maxPendingRequests > 256 || limits.maxRequestsPerWindow > 65_536) throw new SdkError("SDK_INVALID_CONFIG");
  return limits;
}
export function randomHex128(cryptoSource: Pick<Crypto, "getRandomValues"> = globalThis.crypto): string {
  const data = cryptoSource.getRandomValues(new Uint8Array(16));
  return Array.from(data, byte => byte.toString(16).padStart(2, "0")).join("");
}
export function parseChallenge(value: unknown, type: "BOOT_CHALLENGE" | "HELLO"): BootChallenge | BootHello | undefined {
  if (!isObject(value) || !hasKeys(value, ["type", "sdkProtocolVersion", "presentationInstanceId", "nonce", "gameBuildId"]) ||
      value["type"] !== type || value["sdkProtocolVersion"] !== 1 || !isId(value["presentationInstanceId"]) ||
      !isNonce(value["nonce"]) || !isBuild(value["gameBuildId"])) return undefined;
  return value as unknown as BootChallenge | BootHello;
}
export function sameChallenge(left: Pick<BootChallenge, "sdkProtocolVersion" | "presentationInstanceId" | "nonce" | "gameBuildId">,
  right: Pick<BootChallenge, "sdkProtocolVersion" | "presentationInstanceId" | "nonce" | "gameBuildId">): boolean {
  return left.sdkProtocolVersion === right.sdkProtocolVersion && left.presentationInstanceId === right.presentationInstanceId &&
    left.nonce === right.nonce && left.gameBuildId === right.gameBuildId;
}
export function assertMatchScope(scope: unknown, sessionId?: string): asserts scope is MatchScope {
  if (!isObject(scope) || !hasKeys(scope, ["matchId", "role", "authorityEpoch"], ["seatId", "seatEpoch", "inputSessionId"]) ||
      !isId(scope["matchId"]) || !["PLAYER", "SPECTATOR"].includes(String(scope["role"])) || !isPosition(scope["authorityEpoch"])) throw new SdkError("SDK_INVALID_CONFIG");
  if (scope["seatId"] !== undefined && !isId(scope["seatId"])) throw new SdkError("SDK_INVALID_CONFIG");
  if (scope["seatEpoch"] !== undefined && !isPosition(scope["seatEpoch"])) throw new SdkError("SDK_INVALID_CONFIG");
  if (scope["inputSessionId"] !== undefined && !isId(scope["inputSessionId"])) throw new SdkError("SDK_INVALID_CONFIG");
  if (scope["role"] === "PLAYER" && (!isId(scope["seatId"]) || !isPosition(scope["seatEpoch"]) ||
      (sessionId !== undefined && scope["inputSessionId"] !== sessionId))) throw new SdkError("SDK_INVALID_CONFIG");
}
export function makePublicPresentation(binding: PresentationBinding): PublicPresentation {
  const publicValue = {
    bindingId: binding.bindingId, presentationInstanceId: binding.presentationInstanceId, gameBuildId: binding.gameBuildId,
    sdkProtocolVersion: 1 as const, capabilityIds: Object.freeze([...binding.capabilityIds]), expiresAt: binding.expiresAt,
  };
  if (!binding.matchScope) return Object.freeze(publicValue);
  const { inputSessionId: _privateInputSession, ...scope } = binding.matchScope;
  return Object.freeze({ ...publicValue, matchScope: Object.freeze(scope) });
}
export function parsePublicPresentation(value: unknown): PublicPresentation {
  if (!isObject(value) || !hasKeys(value, ["bindingId", "presentationInstanceId", "gameBuildId", "sdkProtocolVersion", "capabilityIds", "expiresAt"], ["matchScope"]) ||
      !isId(value["bindingId"]) || !isId(value["presentationInstanceId"]) || !isBuild(value["gameBuildId"]) || value["sdkProtocolVersion"] !== 1 ||
      !Number.isFinite(value["expiresAt"]) || !Array.isArray(value["capabilityIds"]) || value["capabilityIds"].length > SDK_CAPABILITIES.length ||
      new Set(value["capabilityIds"]).size !== value["capabilityIds"].length ||
      value["capabilityIds"].some(capability => !SDK_CAPABILITIES.includes(capability as SdkCapability))) throw new SdkError("SDK_PROTOCOL");
  const capabilities = Object.freeze([...value["capabilityIds"]]) as readonly SdkCapability[];
  const base = { bindingId: value["bindingId"], presentationInstanceId: value["presentationInstanceId"], gameBuildId: value["gameBuildId"],
    sdkProtocolVersion: 1 as const, capabilityIds: capabilities, expiresAt: value["expiresAt"] as number };
  if (value["matchScope"] === undefined) return Object.freeze(base);
  assertMatchScope(value["matchScope"]);
  if (Object.hasOwn(value["matchScope"], "inputSessionId")) throw new SdkError("SDK_PROTOCOL");
  return Object.freeze({ ...base, matchScope: Object.freeze({ ...value["matchScope"] }) });
}
export function samePortIdentity(value: Record<string, unknown>, identity: PortIdentity): boolean {
  return value["sdkProtocolVersion"] === 1 && value["bindingId"] === identity.bindingId &&
    value["presentationInstanceId"] === identity.presentationInstanceId;
}
export function isAssetPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 1024 && !/[\\?#%\u0000-\u001f]/.test(path) &&
    !path.startsWith("/") && path.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}
export function parseAssetReference(value: unknown): AssetReference {
  if (!isObject(value) || !hasKeys(value, ["path", "url", "sha256", "bytes", "mime"]) || !isAssetPath(value["path"]) ||
      typeof value["url"] !== "string" || !isBuild(value["sha256"]) || !Number.isSafeInteger(value["bytes"]) || (value["bytes"] as number) < 0 ||
      typeof value["mime"] !== "string" || value["mime"].length > 256 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;\s*charset=utf-8)?$/i.test(value["mime"])) throw new SdkError("SDK_PROTOCOL");
  let url: URL;
  try { url = new URL(value["url"]); } catch { throw new SdkError("SDK_PROTOCOL"); }
  try { assertOrigin(url.origin); } catch { throw new SdkError("SDK_PROTOCOL"); }
  if (url.username || url.password || url.search || url.hash) throw new SdkError("SDK_PROTOCOL");
  return Object.freeze({ path: value["path"], url: value["url"], sha256: value["sha256"], bytes: value["bytes"] as number, mime: value["mime"] });
}

/** Measure a closed structured-clone subset before sending or handling any message. */
export function measureMessage(value: unknown, maxBytes: number): ReadonlySet<ArrayBuffer> {
  let size = 0;
  const ancestors = new Set<object>(), buffers = new Set<ArrayBuffer>();
  const encoder = new TextEncoder();
  function charge(amount: number): void { size += amount; if (size > maxBytes) throw new SdkError("SDK_LIMIT"); }
  function visit(item: unknown, depth: number): void {
    if (depth > 8) throw new SdkError("SDK_LIMIT");
    if (item === null || typeof item === "boolean") { charge(5); return; }
    if (typeof item === "string") { charge(encoder.encode(item).byteLength + 2); return; }
    if (typeof item === "number" && Number.isFinite(item)) { charge(24); return; }
    if (item instanceof ArrayBuffer) {
      try { new Uint8Array(item); } catch { throw new SdkError("BUFFER_DETACHED"); }
      if (!buffers.has(item)) { buffers.add(item); charge(item.byteLength + 8); }
      return;
    }
    if (ArrayBuffer.isView(item)) {
      if (!(item.buffer instanceof ArrayBuffer)) throw new SdkError("SDK_TRANSFER");
      visit(item.buffer, depth + 1); charge(16); return;
    }
    if (typeof item !== "object" || item === null || ancestors.has(item)) throw new SdkError("SDK_PROTOCOL");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (item.length > 256) throw new SdkError("SDK_LIMIT");
        charge(2);
        for (let index = 0; index < item.length; index++) {
          const property = Object.getOwnPropertyDescriptor(item, index);
          if (!property || !("value" in property)) throw new SdkError("SDK_PROTOCOL");
          visit(property.value, depth + 1); charge(1);
        }
        return;
      }
      if (!isObject(item)) throw new SdkError("SDK_PROTOCOL");
      const keys = Object.keys(item);
      if (keys.length > 64) throw new SdkError("SDK_LIMIT");
      charge(2);
      for (const key of keys) {
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (!property || !("value" in property)) throw new SdkError("SDK_PROTOCOL");
        charge(encoder.encode(key).byteLength + 4); visit(property.value, depth + 1);
      }
    } finally { ancestors.delete(item); }
  }
  visit(value, 0);
  return buffers;
}
export function validateTransfer(value: unknown, transfer: readonly ArrayBuffer[], maxBytes: number): void {
  if (transfer.length > 16 || new Set(transfer).size !== transfer.length) throw new SdkError("SDK_TRANSFER");
  const owned = measureMessage(value, maxBytes);
  for (const buffer of transfer) {
    if (!(buffer instanceof ArrayBuffer) || !owned.has(buffer)) throw new SdkError("SDK_TRANSFER");
    try { new Uint8Array(buffer); } catch { throw new SdkError("BUFFER_DETACHED"); }
  }
}
