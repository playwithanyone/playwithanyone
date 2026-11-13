import {
  SdkError, SDK_CAPABILITIES, assertMatchScope, assertOrigin, hasKeys, isAssetPath, isBuild, isId, isObject,
  isPosition, makePublicPresentation, measureMessage, parseAssetReference, parseChallenge, randomHex128,
  sameChallenge, samePortIdentity, validateLimits, validateTransfer,
  type AssetReference, type BootChallenge, type BootPort, type PresentationBinding, type PresentationGrant,
  type PortIdentity, type RequestMessage, type ResponseMessage, type SdkErrorCode, type SdkLimits,
} from "./types.js";

export type HostStatus = "IDLE" | "CHALLENGING" | "AUTHORIZING" | "WAITING_ACK" | "CONNECTED" | "REVOKED" | "DISPOSED";
export interface AuthorizePresentation {
  readonly presentationInstanceId: string;
  readonly gameBuildId: string;
  readonly frameOrigin: string;
  readonly signal: AbortSignal;
}
export interface RequestContext {
  readonly binding: Readonly<PresentationBinding>;
  readonly requestId: number;
  readonly signal: AbortSignal;
}
export interface PresentationHostOptions<Command = unknown> {
  readonly iframe: HTMLIFrameElement;
  readonly frameOrigin: string;
  readonly gameBuildId: string;
  /** The Shell derives a grant from its existing authenticated platform context. */
  readonly authorize: (request: AuthorizePresentation) => PresentationGrant | Promise<PresentationGrant>;
  /** Current session/seat/authority records remain owned by the Shell and server. */
  readonly isBindingCurrent: (binding: Readonly<PresentationBinding>) => boolean;
  readonly assets?: ReadonlyMap<string, AssetReference>;
  readonly handlers?: {
    readonly ready?: (context: RequestContext) => void | Promise<void>;
    readonly parseCommand?: (command: unknown) => Command;
    readonly dispatch?: (command: Command, context: RequestContext) => unknown | Promise<unknown>;
  };
  readonly onStatus?: (status: HostStatus, reason?: string) => void;
  readonly limits?: Partial<SdkLimits>;
  readonly window?: Window;
  readonly now?: () => number;
  readonly createChannel?: () => MessageChannel;
  readonly randomId?: () => string;
}
interface RequestRecord { readonly signature: string; reply?: ResponseMessage; active: boolean }
const identityKeys = ["sdkProtocolVersion", "bindingId", "presentationInstanceId"] as const;

function fingerprint(value: unknown): string {
  if (value instanceof ArrayBuffer) return `bytes:${Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}:${value.byteOffset}:${value.byteLength}:${fingerprint(value.buffer)}`;
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${fingerprint(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** One controller owns one iframe. Reloads always create a fresh challenge and binding. */
export class PresentationHost<Command = unknown, View = unknown> {
  readonly #options: PresentationHostOptions<Command>;
  readonly #window: Window;
  readonly #limits: SdkLimits;
  readonly #now: () => number;
  readonly #assets = new Map<string, AssetReference>();
  readonly #seenBindings = new Set<string>();
  #status: HostStatus = "IDLE";
  #generation = 0;
  #challenge: BootChallenge | undefined;
  #binding: PresentationBinding | undefined;
  #frameWindow: Window | null = null;
  #port: MessagePort | undefined;
  #bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
  #abort = new AbortController();
  #requests = new Map<number, RequestRecord>();
  #nextRequest = 0;
  #inflight = 0;
  #windowStart = 0;
  #windowRequests = 0;
  #readyPromise: Promise<void> | undefined;
  #listening = false;

  constructor(options: PresentationHostOptions<Command>) {
    this.#options = options;
    this.#window = options.window ?? globalThis.window;
    if (!this.#window || !options.iframe || !isBuild(options.gameBuildId) || typeof options.authorize !== "function" || typeof options.isBindingCurrent !== "function") throw new SdkError("SDK_INVALID_CONFIG");
    assertOrigin(options.frameOrigin);
    if (options.frameOrigin === this.#window.location.origin) throw new SdkError("SDK_INVALID_CONFIG");
    this.#limits = validateLimits(options.limits);
    this.#now = options.now ?? Date.now;
    for (const [assetPath, asset] of options.assets ?? []) {
      const verified = parseAssetReference(asset);
      if (assetPath !== verified.path) throw new SdkError("SDK_INVALID_CONFIG");
      this.#assets.set(assetPath, verified);
    }
    options.iframe.addEventListener("load", this.#onLoad);
  }

  get status(): HostStatus { return this.#status; }
  get presentationInstanceId(): string | undefined { return this.#challenge?.presentationInstanceId; }

  /** Call for an already-loaded frame; ordinary iframe load events call this automatically. */
  challenge(): void {
    if (this.#status === "DISPOSED") throw new SdkError("PRESENTATION_REVOKED");
    this.#reset("FRAME_RELOADED");
    const frameWindow = this.#options.iframe.contentWindow;
    if (!frameWindow) { this.#setStatus("REVOKED", "FRAME_UNAVAILABLE"); return; }
    const random = this.#options.randomId ?? randomHex128;
    const instanceId = random(), nonce = random();
    if (!/^[0-9a-f]{32}$/.test(instanceId) || !/^[0-9a-f]{32}$/.test(nonce)) throw new SdkError("SDK_INVALID_CONFIG");
    const challenge: BootChallenge = Object.freeze({ type: "BOOT_CHALLENGE", sdkProtocolVersion: 1,
      presentationInstanceId: `p-${instanceId}`, nonce, gameBuildId: this.#options.gameBuildId });
    this.#challenge = challenge;
    this.#frameWindow = frameWindow;
    this.#setStatus("CHALLENGING");
    this.#listen();
    const generation = this.#generation;
    this.#bootstrapTimer = setTimeout(() => {
      if (this.#generation === generation && this.#status !== "CONNECTED") this.revoke("BOOT_TIMEOUT");
    }, this.#limits.bootstrapTimeoutMs);
    frameWindow.postMessage(challenge, this.#options.frameOrigin);
  }

  /** Only already projected, public state should be supplied by the trusted runtime. */
  publishState(view: View, revision: number, transfer: readonly ArrayBuffer[] = []): boolean {
    if (!isPosition(revision)) throw new SdkError("SDK_PROTOCOL");
    if (this.#status !== "CONNECTED" || !this.#binding || !this.#current(this.#binding)) return false;
    if (!this.#binding.capabilityIds.includes("state.subscribe")) return false;
    const message = { type: "STATE", ...this.#identity(), revision, view };
    validateTransfer(message, transfer, this.#limits.maxMessageBytes);
    this.#port!.postMessage(message, [...transfer]);
    return true;
  }

  /** Session logout, scope changes, authority changes and frame replacement all use this. */
  revoke(reason = "PRESENTATION_REVOKED"): void {
    if (this.#status === "DISPOSED") return;
    this.#reset(reason);
    this.#setStatus("REVOKED", reason);
  }

  dispose(): void {
    if (this.#status === "DISPOSED") return;
    this.#reset("DISPOSED");
    this.#options.iframe.removeEventListener("load", this.#onLoad);
    this.#setStatus("DISPOSED", "DISPOSED");
  }

  readonly #onLoad = (): void => { if (this.#status !== "DISPOSED") this.challenge(); };
  readonly #onWindowMessage = (event: MessageEvent<unknown>): void => {
    if (this.#status !== "CHALLENGING" || !this.#challenge || event.origin !== this.#options.frameOrigin || event.source !== this.#frameWindow ||
        this.#options.iframe.contentWindow !== this.#frameWindow) return;
    const hello = parseChallenge(event.data, "HELLO");
    if (!hello || !sameChallenge(hello, this.#challenge)) return;
    this.#setStatus("AUTHORIZING");
    const generation = this.#generation, challenge = this.#challenge;
    void this.#authorize(generation, challenge);
  };

  async #authorize(generation: number, challenge: BootChallenge): Promise<void> {
    try {
      const grant = await this.#options.authorize({ presentationInstanceId: challenge.presentationInstanceId,
        gameBuildId: challenge.gameBuildId, frameOrigin: this.#options.frameOrigin, signal: this.#abort.signal });
      if (!this.#alive(generation)) return;
      const binding = this.#validateGrant(grant, challenge);
      if (!this.#current(binding)) return;
      this.#binding = binding;
      const channel = (this.#options.createChannel ?? (() => new MessageChannel()))();
      this.#port = channel.port1;
      channel.port1.onmessage = event => { void this.#onPortMessage(event.data, generation); };
      channel.port1.onmessageerror = () => this.revoke("SDK_PROTOCOL");
      channel.port1.start();
      this.#setStatus("WAITING_ACK");
      const delivery: BootPort = { type: "BOOT_PORT", sdkProtocolVersion: 1, nonce: challenge.nonce,
        presentationInstanceId: challenge.presentationInstanceId, gameBuildId: challenge.gameBuildId, binding: makePublicPresentation(binding) };
      measureMessage(delivery, this.#limits.maxMessageBytes);
      this.#frameWindow!.postMessage(delivery, this.#options.frameOrigin, [channel.port2]);
    } catch (error) {
      if (this.#alive(generation)) this.revoke(error instanceof SdkError ? error.code : "AUTH_REQUIRED");
    }
  }

  #validateGrant(grant: PresentationGrant, challenge: BootChallenge): PresentationBinding {
    if (!isObject(grant) || !hasKeys(grant, ["bindingId", "sessionId", "expiresAt", "capabilityIds"], ["matchScope"]) ||
        !isId(grant.bindingId) || !isId(grant.sessionId) || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= this.#now() ||
        !Array.isArray(grant.capabilityIds) || grant.capabilityIds.length > SDK_CAPABILITIES.length ||
        new Set(grant.capabilityIds).size !== grant.capabilityIds.length || grant.capabilityIds.some(value => !SDK_CAPABILITIES.includes(value))) throw new SdkError("SDK_INVALID_CONFIG");
    if (this.#seenBindings.has(grant.bindingId)) throw new SdkError("STALE_BINDING");
    if (this.#seenBindings.size >= 256) throw new SdkError("SDK_LIMIT");
    if (grant.matchScope !== undefined) assertMatchScope(grant.matchScope, grant.sessionId);
    this.#seenBindings.add(grant.bindingId);
    const base = { bindingId: grant.bindingId, sessionId: grant.sessionId, expiresAt: grant.expiresAt,
      capabilityIds: Object.freeze([...grant.capabilityIds]), presentationInstanceId: challenge.presentationInstanceId,
      gameBuildId: challenge.gameBuildId, frameOrigin: this.#options.frameOrigin, sdkProtocolVersion: 1 as const };
    return Object.freeze(grant.matchScope === undefined ? base : { ...base, matchScope: Object.freeze({ ...grant.matchScope }) });
  }

  async #onPortMessage(value: unknown, generation: number): Promise<void> {
    if (!this.#alive(generation) || !this.#binding || !this.#current(this.#binding)) return;
    try {
      measureMessage(value, this.#limits.maxMessageBytes);
      if (!isObject(value) || !samePortIdentity(value, this.#identity())) throw new SdkError("STALE_BINDING");
      if (this.#status === "WAITING_ACK") {
        if (value["type"] !== "PORT_ACK" || !hasKeys(value, ["type", ...identityKeys])) throw new SdkError("SDK_PROTOCOL");
        this.#stopListening();
        if (this.#bootstrapTimer !== undefined) clearTimeout(this.#bootstrapTimer);
        this.#bootstrapTimer = undefined;
        this.#post({ type: "PORT_READY", ...this.#identity() });
        // A synchronous CONNECTED callback may immediately publish state. The
        // client must receive the handshake completion before any such message.
        this.#setStatus("CONNECTED");
        return;
      }
      if (this.#status !== "CONNECTED") return;
      if (value["type"] === "DISPOSE" && hasKeys(value, ["type", ...identityKeys])) { this.revoke("CLIENT_DISPOSED"); return; }
      if (value["type"] !== "REQUEST" || !hasKeys(value, ["type", ...identityKeys, "requestId", "method", "payload"]) || !isPosition(value["requestId"]) ||
          !["ready", "assets.resolve", "actions.dispatch"].includes(String(value["method"]))) throw new SdkError("SDK_PROTOCOL");
      await this.#request(value as unknown as RequestMessage, generation);
    } catch (error) {
      if (this.#alive(generation)) this.revoke(error instanceof SdkError ? error.code : "SDK_PROTOCOL");
    }
  }

  async #request(message: RequestMessage, generation: number): Promise<void> {
    const signature = fingerprint([message.method, message.payload]);
    const previous = this.#requests.get(message.requestId);
    if (previous) {
      if (previous.signature !== signature) { this.#postError(message.requestId, "REQUEST_ORDER"); return; }
      if (previous.reply) this.#post(previous.reply);
      return;
    }
    if (message.requestId !== this.#nextRequest) { this.#postError(message.requestId, "REQUEST_ORDER"); return; }
    const record: RequestRecord = { signature, active: true };
    this.#requests.set(message.requestId, record);
    this.#nextRequest += 1;
    let countedInflight = false;
    try {
      if (this.#inflight >= this.#limits.maxPendingRequests) throw new SdkError("BACKPRESSURE");
      const now = this.#now();
      if (!Number.isFinite(now)) throw new SdkError("SDK_INVALID_CONFIG");
      if (now < this.#windowStart || now - this.#windowStart >= this.#limits.requestWindowMs) { this.#windowStart = now; this.#windowRequests = 0; }
      this.#windowRequests += 1;
      if (this.#windowRequests > this.#limits.maxRequestsPerWindow) throw new SdkError("BACKPRESSURE");
      const binding = this.#binding!;
      if (!binding.capabilityIds.includes(message.method)) throw new SdkError("CAPABILITY_UNAVAILABLE");
      this.#inflight += 1; countedInflight = true;
      const context: RequestContext = { binding, requestId: message.requestId, signal: this.#abort.signal };
      let payload: unknown;
      switch (message.method) {
        case "ready":
          if (message.payload !== null) throw new SdkError("SDK_PROTOCOL");
          this.#readyPromise ??= Promise.resolve().then(() => this.#options.handlers?.ready?.(context));
          await this.#readyPromise;
          payload = null;
          break;
        case "assets.resolve": {
          if (!isObject(message.payload) || !hasKeys(message.payload, ["path"]) || !isAssetPath(message.payload["path"])) throw new SdkError("SDK_PROTOCOL");
          const asset = this.#assets.get(message.payload["path"]);
          if (!asset) throw new SdkError("ASSET_UNKNOWN");
          payload = asset;
          break;
        }
        case "actions.dispatch": {
          if (!binding.matchScope) throw new SdkError("MATCH_REQUIRED");
          if (binding.matchScope.role !== "PLAYER") throw new SdkError("AUTH_REQUIRED");
          const handlers = this.#options.handlers;
          if (!handlers?.parseCommand || !handlers.dispatch) throw new SdkError("CAPABILITY_UNAVAILABLE");
          let parsed: Command;
          try { parsed = handlers.parseCommand(message.payload); } catch { throw new SdkError("COMMAND_INVALID"); }
          payload = await handlers.dispatch(parsed, context);
          break;
        }
      }
      if (!this.#alive(generation) || !this.#current(binding)) return;
      this.#complete(message.requestId, record, { type: "RESPONSE", ...this.#identity(), requestId: message.requestId, ok: true, payload: payload ?? null });
    } catch (error) {
      if (!this.#alive(generation) || !this.#binding || !this.#current(this.#binding)) return;
      this.#complete(message.requestId, record, { type: "RESPONSE", ...this.#identity(), requestId: message.requestId,
        ok: false, error: error instanceof SdkError ? error.code : "INTERNAL_ERROR" });
    } finally {
      if (this.#alive(generation)) {
        if (countedInflight) this.#inflight -= 1;
        record.active = false;
        for (const [id, item] of this.#requests) {
          if (this.#requests.size <= this.#limits.maxPendingRequests * 2) break;
          if (!item.active) this.#requests.delete(id);
        }
      }
    }
  }

  #complete(id: number, record: RequestRecord, reply: ResponseMessage): void {
    try {
      measureMessage(reply, this.#limits.maxMessageBytes);
      record.reply = structuredClone(reply);
    } catch {
      record.reply = { type: "RESPONSE", ...this.#identity(), requestId: id, ok: false, error: "SDK_LIMIT" };
    }
    this.#post(record.reply);
  }
  #postError(requestId: number, error: SdkErrorCode): void { this.#post({ type: "RESPONSE", ...this.#identity(), requestId, ok: false, error }); }
  #post(value: unknown): void {
    measureMessage(value, this.#limits.maxMessageBytes);
    this.#port?.postMessage(value);
  }
  #identity(): PortIdentity {
    if (!this.#binding) throw new SdkError("STALE_BINDING");
    return { sdkProtocolVersion: 1, bindingId: this.#binding.bindingId, presentationInstanceId: this.#binding.presentationInstanceId };
  }
  #current(binding: PresentationBinding): boolean {
    if (!Number.isFinite(this.#now()) || this.#now() >= binding.expiresAt) { this.revoke("AUTH_EXPIRED"); return false; }
    let current = false;
    try { current = this.#options.isBindingCurrent(binding); } catch { current = false; }
    if (!current) this.revoke("AUTH_REQUIRED");
    return current;
  }
  #alive(generation: number): boolean { return this.#generation === generation && this.#status !== "REVOKED" && this.#status !== "DISPOSED"; }
  #listen(): void { if (!this.#listening) { this.#window.addEventListener("message", this.#onWindowMessage); this.#listening = true; } }
  #stopListening(): void { if (this.#listening) { this.#window.removeEventListener("message", this.#onWindowMessage); this.#listening = false; } }
  #setStatus(status: HostStatus, reason?: string): void { this.#status = status; this.#options.onStatus?.(status, reason); }
  #reset(reason: string): void {
    this.#generation += 1;
    this.#abort.abort(reason);
    this.#abort = new AbortController();
    if (this.#bootstrapTimer !== undefined) clearTimeout(this.#bootstrapTimer);
    this.#bootstrapTimer = undefined;
    this.#stopListening();
    if (this.#port && this.#binding) {
      try { this.#port.postMessage({ type: "REVOKED", ...this.#identity(), reason }); } catch { /* Already detached or closed. */ }
      this.#port.onmessage = null;
      this.#port.onmessageerror = null;
      this.#port.close();
    }
    this.#port = undefined;
    this.#binding = undefined;
    this.#challenge = undefined;
    this.#frameWindow = null;
    this.#requests.clear();
    this.#nextRequest = 0;
    this.#inflight = 0;
    this.#windowRequests = 0;
    this.#windowStart = this.#now();
    this.#readyPromise = undefined;
  }
}
