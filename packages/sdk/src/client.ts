import {
  SdkError, assertOrigin, hasKeys, isAssetPath, isBuild, isObject, isPosition,
  measureMessage, parseAssetReference, parseChallenge, parsePublicPresentation, sameChallenge,
  samePortIdentity, validateLimits, validateTransfer,
  type AssetReference, type BootChallenge, type GameClient, type LifecycleEvent, type PortIdentity,
  type PublicPresentation, type PublicSessionContext, type SdkErrorCode, type SdkLimits, type SdkMethod,
  type ViewEnvelope,
} from "./types.js";

export interface ConnectGameClientOptions {
  readonly shellOrigin: string;
  readonly gameBuildId: string;
  readonly window?: Window;
  readonly limits?: Partial<SdkLimits>;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
}
interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: SdkError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
const identityKeys = ["sdkProtocolVersion", "bindingId", "presentationInstanceId"] as const;

/** Connects a game presentation only; it creates no player, room, network link or match. */
export function connectGameClient<Command = unknown, View = unknown>(options: ConnectGameClientOptions): Promise<GameClient<Command, View>> {
  return new Promise((resolve, reject) => {
    let frame: Window, parent: Window, limits: SdkLimits;
    try {
      frame = options.window ?? globalThis.window;
      if (!frame || !isBuild(options.gameBuildId)) throw new SdkError("SDK_INVALID_CONFIG");
      assertOrigin(options.shellOrigin);
      parent = frame.parent;
      if (!parent || parent === frame || options.shellOrigin === frame.location.origin) throw new SdkError("SDK_INVALID_CONFIG");
      limits = validateLimits(options.limits);
    } catch (error) { reject(error); return; }
    const now = options.now ?? Date.now;
    const pending = new Map<number, PendingRequest>();
    const stateListeners = new Set<(value: ViewEnvelope<View>) => void>();
    const lifecycleListeners = new Set<(event: LifecycleEvent) => void>();
    let challenge: BootChallenge | undefined;
    let binding: PublicPresentation | undefined;
    let port: MessagePort | undefined;
    let connected = false, closed = false, nextRequest = 0;
    let latestState: ViewEnvelope<View> | undefined;
    const timer = setTimeout(() => close("BOOT_TIMEOUT"), limits.bootstrapTimeoutMs);

    function identity(): PortIdentity {
      if (!binding) throw new SdkError("STALE_BINDING");
      return { sdkProtocolVersion: 1, bindingId: binding.bindingId, presentationInstanceId: binding.presentationInstanceId };
    }
    function close(reason: SdkErrorCode | "CLIENT_DISPOSED" | string): void {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      frame.removeEventListener("message", onWindowMessage);
      if (port) { port.onmessage = null; port.onmessageerror = null; port.close(); }
      const code: SdkErrorCode = isErrorCode(reason) ? reason : "PRESENTATION_REVOKED";
      for (const record of pending.values()) { clearTimeout(record.timer); record.reject(new SdkError(code)); }
      pending.clear();
      if (!connected) reject(new SdkError(code));
      for (const listener of lifecycleListeners) { try { listener({ type: "REVOKED", reason }); } catch { /* Game callback has no effect on protocol state. */ } }
      stateListeners.clear(); lifecycleListeners.clear();
    }
    function alive(): void {
      if (closed || !connected || !binding || !port) throw new SdkError("PRESENTATION_REVOKED");
      const time = now();
      if (!Number.isFinite(time) || time >= binding.expiresAt) { close("AUTH_EXPIRED"); throw new SdkError("AUTH_EXPIRED"); }
    }
    async function request(method: SdkMethod, payload: unknown, transfer: readonly ArrayBuffer[] = []): Promise<unknown> {
      alive();
      if (!binding!.capabilityIds.includes(method)) throw new SdkError("CAPABILITY_UNAVAILABLE");
      if (method === "actions.dispatch") {
        if (!binding!.matchScope) throw new SdkError("MATCH_REQUIRED");
        if (binding!.matchScope.role !== "PLAYER") throw new SdkError("AUTH_REQUIRED");
      }
      if (pending.size >= limits.maxPendingRequests) throw new SdkError("BACKPRESSURE");
      if (!isPosition(nextRequest)) throw new SdkError("SDK_LIMIT");
      const requestId = nextRequest;
      const message = { type: "REQUEST", ...identity(), requestId, method, payload };
      validateTransfer(message, transfer, limits.maxMessageBytes);
      return new Promise((fulfill, fail) => {
        const requestTimer = setTimeout(() => close("REQUEST_TIMEOUT"), limits.requestTimeoutMs);
        pending.set(requestId, { resolve: fulfill, reject: fail, timer: requestTimer });
        try { port!.postMessage(message, [...transfer]); nextRequest += 1; }
        catch { clearTimeout(requestTimer); pending.delete(requestId); fail(new SdkError("SDK_TRANSFER")); }
      });
    }
    function deliverState(value: ViewEnvelope<View>): void {
      latestState = value;
      for (const listener of stateListeners) { try { listener(value); } catch { /* Isolate presentation callbacks. */ } }
    }
    function onPortMessage(value: unknown): void {
      if (closed || !binding) return;
      try {
        measureMessage(value, limits.maxMessageBytes);
        if (!isObject(value) || !samePortIdentity(value, identity())) throw new SdkError("STALE_BINDING");
        if (!connected) {
          if (value["type"] !== "PORT_READY" || !hasKeys(value, ["type", ...identityKeys])) throw new SdkError("SDK_PROTOCOL");
          const time = now();
          if (!Number.isFinite(time) || time >= binding.expiresAt) { close("AUTH_EXPIRED"); return; }
          connected = true;
          clearTimeout(timer);
          frame.removeEventListener("message", onWindowMessage);
          resolve(makeClient());
          return;
        }
        alive();
        if (value["type"] === "REVOKED" && hasKeys(value, ["type", ...identityKeys, "reason"]) && typeof value["reason"] === "string" && value["reason"].length <= 256) {
          close(value["reason"]); return;
        }
        if (value["type"] === "STATE" && hasKeys(value, ["type", ...identityKeys, "revision", "view"]) && isPosition(value["revision"]) && binding.capabilityIds.includes("state.subscribe")) {
          if (latestState && value["revision"] <= latestState.revision) return;
          deliverState(Object.freeze({ revision: value["revision"], view: value["view"] as View }));
          return;
        }
        if (value["type"] !== "RESPONSE" || !hasKeys(value, ["type", ...identityKeys, "requestId", "ok"], ["payload", "error"]) || !isPosition(value["requestId"]) || typeof value["ok"] !== "boolean") throw new SdkError("SDK_PROTOCOL");
        const record = pending.get(value["requestId"]);
        if (!record) throw new SdkError("REQUEST_ORDER");
        if ((value["ok"] && (!Object.hasOwn(value, "payload") || Object.hasOwn(value, "error"))) || (!value["ok"] && (Object.hasOwn(value, "payload") || !isErrorCode(value["error"])))) throw new SdkError("SDK_PROTOCOL");
        pending.delete(value["requestId"]); clearTimeout(record.timer);
        if (value["ok"]) record.resolve(value["payload"]);
        else record.reject(new SdkError(value["error"] as SdkErrorCode));
      } catch (error) { close(error instanceof SdkError ? error.code : "SDK_PROTOCOL"); }
    }
    function onWindowMessage(event: MessageEvent<unknown>): void {
      if (closed || connected || event.source !== parent || event.origin !== options.shellOrigin) return;
      const candidate = parseChallenge(event.data, "BOOT_CHALLENGE");
      if (candidate) {
        if (candidate.gameBuildId !== options.gameBuildId || challenge) return;
        challenge = candidate as BootChallenge;
        parent.postMessage({ ...candidate, type: "HELLO" }, options.shellOrigin);
        return;
      }
      if (!challenge || !isObject(event.data) || !hasKeys(event.data, ["type", "sdkProtocolVersion", "presentationInstanceId", "nonce", "gameBuildId", "binding"]) ||
          event.data["type"] !== "BOOT_PORT" || !sameChallenge(event.data as unknown as BootChallenge, challenge) || event.ports.length !== 1 || port) return;
      try {
        measureMessage(event.data, limits.maxMessageBytes);
        const publicBinding = parsePublicPresentation(event.data["binding"]);
        if (publicBinding.gameBuildId !== options.gameBuildId || publicBinding.presentationInstanceId !== challenge.presentationInstanceId || publicBinding.expiresAt <= now()) throw new SdkError("SDK_PROTOCOL");
        binding = publicBinding; port = event.ports[0]!;
        port.onmessage = message => onPortMessage(message.data);
        port.onmessageerror = () => close("SDK_PROTOCOL");
        port.start();
        port.postMessage({ type: "PORT_ACK", ...identity() });
      } catch (error) {
        for (const transferred of event.ports) transferred.close();
        close(error instanceof SdkError ? error.code : "SDK_PROTOCOL");
      }
    }
    async function fetchAsset(assetPath: string): Promise<ArrayBuffer> {
      const reference = await resolveAsset(assetPath);
      const fetcher = options.fetch ?? globalThis.fetch;
      const response = await fetcher(reference.url, { mode: "cors", credentials: "omit", redirect: "error" });
      if (!response.ok || response.type === "opaque" || !response.body) throw new SdkError("ASSET_INTEGRITY");
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) !== reference.bytes) { await response.body.cancel(); throw new SdkError("ASSET_INTEGRITY"); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > reference.bytes) { await reader.cancel(); throw new SdkError("ASSET_INTEGRITY"); }
        chunks.push(value);
      }
      if (length !== reference.bytes) throw new SdkError("ASSET_INTEGRITY");
      const content = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.byteLength; }
      const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", content));
      const hash = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== reference.sha256) throw new SdkError("ASSET_INTEGRITY");
      alive();
      return content.buffer;
    }
    async function resolveAsset(assetPath: string): Promise<AssetReference> {
      if (!isAssetPath(assetPath)) throw new SdkError("ASSET_UNKNOWN");
      const reference = parseAssetReference(await request("assets.resolve", { path: assetPath }));
      if (reference.path !== assetPath) throw new SdkError("SDK_PROTOCOL");
      return reference;
    }
    function makeClient(): GameClient<Command, View> {
      const b = binding!;
      const base = { presentationInstanceId: b.presentationInstanceId, gameBuildId: b.gameBuildId };
      const session: PublicSessionContext = Object.freeze(b.matchScope ? { ...base, matchScope: b.matchScope } : base);
      return Object.freeze({
        session, capabilities: b.capabilityIds,
        ready: async () => { await request("ready", null); },
        actions: Object.freeze({ dispatch: (command: Command, transferOptions?: { readonly transfer?: readonly ArrayBuffer[] }) => request("actions.dispatch", command, transferOptions?.transfer) }),
        state: Object.freeze({ subscribe(listener: (view: ViewEnvelope<View>) => void) {
          alive();
          if (!b.capabilityIds.includes("state.subscribe")) throw new SdkError("CAPABILITY_UNAVAILABLE");
          if (typeof listener !== "function" || stateListeners.size >= 256) throw new SdkError("SDK_LIMIT");
          stateListeners.add(listener); if (latestState) listener(latestState);
          return () => { stateListeners.delete(listener); };
        } }),
        lifecycle: Object.freeze({ subscribe(listener: (event: LifecycleEvent) => void) {
          if (typeof listener !== "function" || lifecycleListeners.size >= 256) throw new SdkError("SDK_LIMIT");
          if (closed) listener({ type: "REVOKED", reason: "PRESENTATION_REVOKED" });
          else { lifecycleListeners.add(listener); listener({ type: "CONNECTED" }); }
          return () => { lifecycleListeners.delete(listener); };
        } }),
        assets: Object.freeze({ resolve: resolveAsset, fetch: fetchAsset }),
        dispose() {
          if (!closed && port && binding) { try { port.postMessage({ type: "DISPOSE", ...identity() }); } catch { /* Port may already be closing. */ } }
          close("CLIENT_DISPOSED");
        },
      });
    }
    frame.addEventListener("message", onWindowMessage);
  });
}

function isErrorCode(value: unknown): value is SdkErrorCode {
  return typeof value === "string" && [
    "SDK_INVALID_CONFIG", "SDK_PROTOCOL", "SDK_LIMIT", "SDK_TRANSFER", "BUFFER_DETACHED", "BOOT_TIMEOUT", "REQUEST_TIMEOUT",
    "PRESENTATION_REVOKED", "CAPABILITY_UNAVAILABLE", "MATCH_REQUIRED", "STALE_BINDING", "REQUEST_ORDER", "BACKPRESSURE",
    "COMMAND_INVALID", "ASSET_UNKNOWN", "ASSET_INTEGRITY", "AUTH_EXPIRED", "AUTH_REQUIRED", "INTERNAL_ERROR",
  ].includes(value);
}
