import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  connectGameClient, PresentationHost, SdkError, measureMessage, validateTransfer,
  type AssetReference, type BootChallenge, type GameClient, type PresentationGrant,
  type PresentationHostOptions,
} from "../../sdk/src/index.js";

// Window identity/event fixtures plus real MessageChannel/structured-clone semantics.
// These are L0 tests, not claims about actual DOM, HTTPS, cookies or browser sandboxing.
const SHELL = "https://playwithanyone.example";
const GAME = "https://b-fixture.pwa-games.example";
const BUILD = "a".repeat(64);
interface WindowEvent {
  data: unknown;
  origin: string;
  source: Window;
  ports: MessagePort[];
}
class WindowFixture {
  readonly location: { origin: string };
  parent!: Window;
  source!: Window;
  sourceOrigin!: string;
  hold = false;
  readonly held: WindowEvent[] = [];
  readonly sent: unknown[] = [];
  port: MessagePort | undefined;
  readonly listeners = new Set<EventListenerOrEventListenerObject>();
  constructor(origin: string) { this.location = { origin }; }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void { if (type === "message") this.listeners.add(listener); }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void { if (type === "message") this.listeners.delete(listener); }
  postMessage(data: unknown, targetOrigin: string, transfer: Transferable[] = []): void {
    assert.equal(targetOrigin, this.location.origin, "postMessage always uses an exact target origin");
    const ports = transfer.filter((value): value is MessagePort => value instanceof MessagePort);
    const copy = structuredClone({ data, ports }, { transfer });
    this.sent.push(copy.data);
    if (copy.ports.length) this.port = copy.ports[0];
    const event: WindowEvent = { data: copy.data, ports: copy.ports, origin: this.sourceOrigin, source: this.source };
    if (this.hold) this.held.push(event); else queueMicrotask(() => this.deliver(event));
  }
  deliver(event: WindowEvent): void {
    for (const listener of [...this.listeners]) {
      if (typeof listener === "function") listener(event as unknown as Event);
      else listener.handleEvent(event as unknown as Event);
    }
  }
  asWindow(): Window { return this as unknown as Window; }
}
class FrameFixture {
  constructor(readonly contentWindow: Window) {}
  readonly listeners = new Set<EventListenerOrEventListenerObject>();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void { if (type === "load") this.listeners.add(listener); }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void { if (type === "load") this.listeners.delete(listener); }
  load(): void {
    for (const listener of [...this.listeners]) {
      if (typeof listener === "function") listener(new Event("load")); else listener.handleEvent(new Event("load"));
    }
  }
}
interface SetupOptions {
  grant?: (index: number) => PresentationGrant;
  handlers?: PresentationHostOptions["handlers"];
  assets?: ReadonlyMap<string, AssetReference>;
  fetch?: typeof globalThis.fetch;
  shellHold?: boolean;
  gameHold?: boolean;
  onStatus?: PresentationHostOptions["onStatus"];
}
function setup(options: SetupOptions = {}) {
  const shell = new WindowFixture(SHELL), game = new WindowFixture(GAME);
  shell.source = game.asWindow(); shell.sourceOrigin = GAME; shell.parent = shell.asWindow();
  game.source = shell.asWindow(); game.sourceOrigin = SHELL; game.parent = shell.asWindow();
  shell.hold = options.shellHold ?? false; game.hold = options.gameHold ?? false;
  const frame = new FrameFixture(game.asWindow());
  let now = 1000, current = true, grants = 0;
  const host = new PresentationHost({
    iframe: frame as unknown as HTMLIFrameElement, window: shell.asWindow(), frameOrigin: GAME, gameBuildId: BUILD,
    now: () => now, isBindingCurrent: () => current,
    authorize: () => { grants += 1; return options.grant?.(grants) ?? { bindingId: `binding-${grants}`, sessionId: "PRIVATE-SESSION", expiresAt: 10_000, capabilityIds: ["ready", "state.subscribe", "assets.resolve"] }; },
    ...(options.handlers ? { handlers: options.handlers } : {}), ...(options.assets ? { assets: options.assets } : {}),
    ...(options.onStatus ? { onStatus: options.onStatus } : {}),
    limits: { bootstrapTimeoutMs: 1500, requestTimeoutMs: 1500 },
  });
  function connect(): Promise<GameClient> {
    return connectGameClient({ window: game.asWindow(), shellOrigin: SHELL, gameBuildId: BUILD,
      now: () => now, limits: { bootstrapTimeoutMs: 1500, requestTimeoutMs: 1500 }, ...(options.fetch ? { fetch: options.fetch } : {}) });
  }
  return { shell, game, frame, host, connect, setTime: (value: number) => { now = value; }, revokeSession: () => { current = false; }, grantCount: () => grants };
}
function code(expected: string) { return (error: unknown) => error instanceof SdkError && error.code === expected; }
async function started(options: SetupOptions = {}) {
  const fixture = setup(options), client = fixture.connect(); fixture.host.challenge();
  return { ...fixture, client: await client };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await nextTurn(); }
  assert.fail("Expected an observable MessageChannel event");
}
const activeGrant = (index: number): PresentationGrant => ({
  bindingId: `binding-${index}`, sessionId: "PRIVATE-SESSION", expiresAt: 10_000,
  capabilityIds: ["ready", "state.subscribe", "actions.dispatch"],
  matchScope: { matchId: "match-1", role: "PLAYER", seatId: "seat-1", seatEpoch: 1, inputSessionId: "PRIVATE-SESSION", authorityEpoch: 1 },
});

test("SDK L0: strict handshake connects after port ACK; public description has no session or input-session credential", async () => {
  let readyCalls = 0;
  const fixture = await started({ grant: activeGrant, handlers: { ready: () => { readyCalls += 1; } } });
  try {
    assert.equal(fixture.host.status, "CONNECTED");
    assert.equal(fixture.client.session.gameBuildId, BUILD);
    assert.equal(Object.hasOwn(fixture.client.session, "sessionId"), false);
    assert.equal(Object.hasOwn(fixture.client.session.matchScope!, "inputSessionId"), false);
    assert.equal(JSON.stringify(fixture.game.sent).includes("PRIVATE-SESSION"), false);
    const challenge = fixture.game.sent[0] as BootChallenge;
    assert.match(challenge.nonce, /^[0-9a-f]{32}$/);
    await Promise.all([fixture.client.ready(), fixture.client.ready()]);
    assert.equal(readyCalls, 1);
  } finally { fixture.client.dispose(); fixture.host.dispose(); }
});

test("SDK handshake sends PORT_READY before state published by a synchronous CONNECTED callback", async () => {
  let fixture: ReturnType<typeof setup>;
  fixture = setup({ grant: activeGrant, onStatus: status => {
    if (status === "CONNECTED") assert.equal(fixture.host.publishState({ board: "initial" }, 1), true);
  } });
  const connection = fixture.connect(); fixture.host.challenge();
  let client: GameClient | undefined;
  try {
    client = await connection;
    const states: unknown[] = [];
    client.state.subscribe(view => states.push(view.view));
    await until(() => states.length === 1);
    assert.deepEqual(states, [{ board: "initial" }]);
    await client.ready();
    assert.equal(fixture.host.status, "CONNECTED");
  } finally { client?.dispose(); fixture.host.dispose(); }
});

test("SEC-10 L0: client ignores wrong parent, origin, nonce/build/protocol shape before accepting the current challenge", async () => {
  const fixture = setup({ gameHold: true });
  const promise = fixture.connect(); fixture.host.challenge();
  const original = fixture.game.held[0]!;
  const challenge = original.data as BootChallenge;
  fixture.game.deliver({ ...original, origin: "https://attacker.example" });
  fixture.game.deliver({ ...original, source: fixture.game.asWindow() });
  fixture.game.deliver({ ...original, data: { ...challenge, nonce: "short" } });
  fixture.game.deliver({ ...original, data: { ...challenge, gameBuildId: "b".repeat(64) } });
  fixture.game.deliver({ ...original, data: { ...challenge, sdkProtocolVersion: 2 } });
  assert.equal(fixture.shell.sent.length, 0);
  fixture.game.hold = false; fixture.game.deliver(original);
  const client = await promise;
  try { assert.equal(fixture.host.status, "CONNECTED"); } finally { client.dispose(); fixture.host.dispose(); }
});

test("SEC-10 L0: host requires exact HELLO origin, source, nonce, instance, build and version", async () => {
  const fixture = setup({ shellHold: true });
  const promise = fixture.connect(); fixture.host.challenge();
  await until(() => fixture.shell.held.length === 1);
  const original = fixture.shell.held[0]!, hello = original.data as Record<string, unknown>;
  fixture.shell.deliver({ ...original, origin: "https://attacker.example" });
  fixture.shell.deliver({ ...original, source: fixture.shell.asWindow() });
  for (const change of [{ nonce: "0".repeat(32) }, { presentationInstanceId: "other" }, { gameBuildId: "b".repeat(64) }, { sdkProtocolVersion: 2 }]) fixture.shell.deliver({ ...original, data: { ...hello, ...change } });
  assert.equal(fixture.grantCount(), 0);
  fixture.shell.hold = false; fixture.shell.deliver(original);
  const client = await promise;
  try { assert.equal(fixture.grantCount(), 1); } finally { client.dispose(); fixture.host.dispose(); }
});

test("SDK L0: preload capability cannot dispatch actions without match scope; server handler is not called", async () => {
  let applies = 0;
  const fixture = await started({ grant: index => ({ bindingId: `binding-${index}`, sessionId: "PRIVATE", expiresAt: 10_000, capabilityIds: ["ready", "actions.dispatch"] }),
    handlers: { parseCommand: value => value, dispatch: () => { applies += 1; return null; } } });
  try {
    await assert.rejects(fixture.client.actions.dispatch({ matchId: "forged", playerId: "other" }), code("MATCH_REQUIRED"));
    assert.equal(applies, 0);
  } finally { fixture.client.dispose(); fixture.host.dispose(); }
});

test("SEC-07 L0: transferred ArrayBuffer detaches the sender and reaches the receiver; detached/unowned transfer is rejected", async () => {
  const fixture = await started({ grant: activeGrant,
    handlers: { parseCommand: value => value, dispatch: value => {
      assert.ok(typeof value === "object" && value !== null && "data" in value && value.data instanceof ArrayBuffer);
      return [...new Uint8Array(value.data)];
    } } });
  try {
    const buffer = Uint8Array.from([3, 1, 4]).buffer;
    const result = fixture.client.actions.dispatch({ data: buffer }, { transfer: [buffer] });
    assert.equal(buffer.byteLength, 0);
    assert.deepEqual(await result, [3, 1, 4]);
    await assert.rejects(fixture.client.actions.dispatch({ data: buffer }, { transfer: [buffer] }), code("BUFFER_DETACHED"));
    await assert.rejects(fixture.client.actions.dispatch({ data: null }, { transfer: [new ArrayBuffer(2)] }), code("SDK_TRANSFER"));
    assert.deepEqual(await fixture.client.actions.dispatch({ data: Uint8Array.from([2]).buffer }), [2]);
  } finally { fixture.client.dispose(); fixture.host.dispose(); }
});

test("SEC-07 L0: public state transfer has one owner and subscriptions cannot receive a stale revision", async () => {
  const fixture = await started();
  try {
    const states: { revision: number; view: unknown }[] = [];
    const unsubscribe = fixture.client.state.subscribe(value => states.push(value));
    const buffer = Uint8Array.from([8, 9]).buffer;
    assert.equal(fixture.host.publishState({ data: buffer }, 2, [buffer]), true);
    assert.equal(buffer.byteLength, 0);
    await until(() => states.length === 1);
    assert.equal(states[0]!.revision, 2);
    assert.deepEqual([...new Uint8Array((states[0]!.view as { data: ArrayBuffer }).data)], [8, 9]);
    fixture.host.publishState({ ignored: true }, 1);
    await nextTurn(); assert.equal(states.length, 1);
    unsubscribe(); fixture.host.publishState({ ignored: true }, 3);
    await nextTurn(); assert.equal(states.length, 1);
  } finally { fixture.client.dispose(); fixture.host.dispose(); }
});

test("SEC-11/SEC-12 L0: reload revokes the old port and late asynchronous replies cannot enter a new binding", async () => {
  let finish: ((value: unknown) => void) | undefined;
  let applied = 0;
  const fixture = await started({ grant: activeGrant, handlers: { parseCommand: value => value, dispatch: () => {
    applied += 1; return new Promise(resolve => { finish = resolve; });
  } } });
  try {
    const result = fixture.client.actions.dispatch({ action: "before-reload" });
    const rejection = assert.rejects(result, code("PRESENTATION_REVOKED"));
    await until(() => applied === 1);
    const nextClientPromise = fixture.connect();
    fixture.frame.load();
    const nextClient = await nextClientPromise;
    try {
      await rejection;
      finish?.("old reply");
      await nextTurn();
      assert.equal(applied, 1);
      assert.notEqual(nextClient.session.presentationInstanceId, fixture.client.session.presentationInstanceId);
      assert.equal(fixture.host.status, "CONNECTED");
      await assert.rejects(fixture.client.ready(), code("PRESENTATION_REVOKED"));
      await nextClient.ready();
    } finally { nextClient.dispose(); }
  } finally { fixture.client.dispose(); fixture.host.dispose(); }
});

test("SEC-11 L0: revoked session or expired authorization prevents subsequent commands", async () => {
  let applied = 0;
  const expired = await started({ grant: activeGrant, handlers: { parseCommand: value => value, dispatch: () => { applied += 1; return null; } } });
  try {
    expired.setTime(10_000);
    await assert.rejects(expired.client.actions.dispatch({}), code("AUTH_EXPIRED"));
    assert.equal(applied, 0);
  } finally { expired.client.dispose(); expired.host.dispose(); }
  const revoked = await started({ grant: activeGrant, handlers: { parseCommand: value => value, dispatch: () => { applied += 1; return null; } } });
  try {
    revoked.revokeSession();
    await assert.rejects(revoked.client.actions.dispatch({}), code("AUTH_REQUIRED"));
    assert.equal(applied, 0);
    assert.equal(revoked.host.status, "REVOKED");
  } finally { revoked.client.dispose(); revoked.host.dispose(); }
});

test("SDK L0: asset fetch uses credential-free CORS and verifies declared byte count and SHA-256", async () => {
  const content = new TextEncoder().encode('{"fixture":true}');
  const reference: AssetReference = { path: "assets/sample.json", url: "https://assets.pwa-content.example/immutable/sample.json",
    sha256: createHash("sha256").update(content).digest("hex"), bytes: content.byteLength, mime: "application/json; charset=utf-8" };
  let corrupt = false;
  const fixture = await started({ assets: new Map([[reference.path, reference]]), fetch: async (input, init) => {
    assert.equal(input, reference.url); assert.equal(init?.mode, "cors"); assert.equal(init?.credentials, "omit"); assert.equal(init?.redirect, "error");
    return new Response(corrupt ? new Uint8Array(content.byteLength) : content);
  } });
  try {
    assert.deepEqual(new Uint8Array(await fixture.client.assets.fetch(reference.path)), content);
    corrupt = true;
    await assert.rejects(fixture.client.assets.fetch(reference.path), code("ASSET_INTEGRITY"));
    await assert.rejects(fixture.client.assets.resolve("../private"), code("ASSET_UNKNOWN"));
    assert.equal(fixture.host.status, "CONNECTED");
  } finally { fixture.client.dispose(); fixture.host.dispose(); }
});

test("SDK L0: clone schemas reject SharedArrayBuffer, executable getters, excessive depth and detached buffers", () => {
  assert.throws(() => measureMessage(new SharedArrayBuffer(4), 65536), code("SDK_PROTOCOL"));
  let invoked = false;
  assert.throws(() => measureMessage({ get secret() { invoked = true; return "secret"; } }, 65536), code("SDK_PROTOCOL"));
  assert.equal(invoked, false);
  let deep: unknown = null; for (let i = 0; i < 10; i++) deep = { next: deep };
  assert.throws(() => measureMessage(deep, 65536), code("SDK_LIMIT"));
  const buffer = new ArrayBuffer(2); structuredClone(buffer, { transfer: [buffer] });
  assert.throws(() => validateTransfer({ buffer }, [buffer], 65536), code("BUFFER_DETACHED"));
});
