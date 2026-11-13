// Finite measurement clients. No credential or raw room view is returned in reports.
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Agent, ProxyAgent, WebSocket } from "undici";
import { decodeFrame, encodeFrame, FULL_STATE, Opcode } from "../../.build/packages/protocol/src/frame.js";
import { parseControl, encodeControl } from "../../.build/packages/protocol/src/control.js";

const text = new TextEncoder();
export const ABSOLUTE_BUDGET = Object.freeze({ maxRooms: 8, maxGuests: 16, maxHttpRequests: 300, maxSentMessages: 600,
  maxRunMs: 900_000, maxConcurrentRooms: 4, maxResponseBytes: 1_048_576, requestTimeoutMs: 12_000 });
const countTemplate = () => ({ httpRequests: 0, httpBodyBytesSent: 0, httpBodyBytesReceived: 0, websocketConnections: 0,
  messagesSent: 0, messagesReceived: 0, messageBytesSent: 0, messageBytesReceived: 0, commandsSent: 0,
  committedCommands: 0, protocolErrors: 0 });
const hash = value => createHash("sha256").update(value).digest("hex");
export function safeCode(error) { return error instanceof Error && /^[A-Z][A-Z0-9_]{1,95}$/.test(error.message) ? error.message : "RESOURCE_MEASUREMENT_FAILED"; }
function expect(condition, code) { if (!condition) throw new Error(code); }
export function percentile(values, fraction) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return Math.round(sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] * 100) / 100; }
export function latencySummary(values) { return { count: values.length, minMs: values.length ? Math.round(Math.min(...values) * 100) / 100 : null,
  p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), maxMs: values.length ? Math.round(Math.max(...values) * 100) / 100 : null }; }

export function createBudget(config) {
  const limits = config.hardBudget;
  for (const [key, maximum] of Object.entries(ABSOLUTE_BUDGET)) expect(Number.isSafeInteger(limits[key]) && limits[key] > 0 && limits[key] <= maximum, "RESOURCE_BUDGET_INVALID");
  expect(Number.isSafeInteger(limits.cleanupHttpReserve) && limits.cleanupHttpReserve >= limits.maxGuests && limits.cleanupHttpReserve < limits.maxHttpRequests, "RESOURCE_CLEANUP_RESERVE_INVALID");
  expect(Number.isSafeInteger(limits.cleanupTimeReserveMs) && limits.cleanupTimeReserveMs >= 30_000 && limits.cleanupTimeReserveMs < limits.maxRunMs, "RESOURCE_CLEANUP_RESERVE_INVALID");
  const startedAt = Date.now();
  return { limits, startedAt, deadline: startedAt + limits.maxRunMs, counts: { rooms: 0, guests: 0, httpRequests: 0, messagesSent: 0, concurrentRooms: 0 },
    check(cleanup = false) { const remaining = this.deadline - Date.now() - (cleanup ? 0 : limits.cleanupTimeReserveMs); expect(remaining > 0, "RESOURCE_RUNTIME_BUDGET"); return remaining; },
    room() { this.check(); expect(++this.counts.rooms <= limits.maxRooms && ++this.counts.concurrentRooms <= limits.maxConcurrentRooms, "RESOURCE_ROOM_BUDGET"); },
    guest() { this.check(); expect(++this.counts.guests <= limits.maxGuests, "RESOURCE_GUEST_BUDGET"); },
    request(cleanup = false) { this.check(cleanup); const maximum = limits.maxHttpRequests - (cleanup ? 0 : limits.cleanupHttpReserve); expect(++this.counts.httpRequests <= maximum, "RESOURCE_HTTP_BUDGET"); },
    message() { this.check(); expect(++this.counts.messagesSent <= limits.maxSentMessages, "RESOURCE_MESSAGE_BUDGET"); }
  };
}

export class MeasurementClients {
  constructor({ config, origin = config.origin, budget = createBudget(config), signal }) {
    const target = new URL(origin), allowed = new URL(config.origin);
    const local = target.protocol === "http:" && ["127.0.0.1", "localhost"].includes(target.hostname);
    expect((local || target.origin === allowed.origin) && target.pathname === "/" && !target.username && !target.password && !target.search && !target.hash, "RESOURCE_ORIGIN_NOT_ALLOWED");
    this.config = config; this.origin = target.origin; this.budget = budget; this.signal = signal;
    const proxy = !local && (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
    this.dispatcher = proxy ? new ProxyAgent(proxy) : new Agent(); this.proxyUsed = Boolean(proxy);
    this.actors = []; this.rooms = []; this.stage = "setup"; this.counts = countTemplate(); this.byStage = {}; this.byEndpoint = {};
    this.commitLatencies = []; this.stateLatencies = []; this.httpLatencies = []; this.cleanupFailures = []; this.assetResponses = [];
    this.userAgent = "PlayWithAnyone-ResourceProfile/1.0 (+https://playwithanyone.com)";
  }
  bump(key, amount = 1) { this.counts[key] += amount; (this.byStage[this.stage] ??= countTemplate())[key] += amount; }
  snapshot() { return structuredClone(this.counts); }
  async waitFor(predicate, actors = [], timeoutMs = 12_000, cleanup = false) {
    const deadline = Date.now() + Math.min(timeoutMs, this.budget.check(cleanup));
    for (;;) {
      if (!cleanup) this.signal?.throwIfAborted();
      if (actors.some(actor => actor.fatal)) throw new Error(actors.find(actor => actor.fatal).fatal);
      if (predicate()) return;
      expect(!actors.some(actor => actor.closed && actor.room?.phase !== "TERMINAL"), "RESOURCE_UNEXPECTED_SOCKET_CLOSE");
      expect(Date.now() < deadline, "RESOURCE_OBSERVATION_TIMEOUT");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  async sleep(ms) {
    const until = Date.now() + ms; expect(Number.isSafeInteger(ms) && ms >= 0 && until < this.budget.deadline - this.budget.limits.cleanupTimeReserveMs, "RESOURCE_SLEEP_BUDGET");
    while (Date.now() < until) { this.signal?.throwIfAborted(); this.budget.check(); await new Promise(resolve => setTimeout(resolve, Math.min(1000, until - Date.now()))); }
  }
  async responseBody(response) {
    expect(!!response.body, "RESOURCE_RESPONSE_BODY_MISSING"); const chunks = []; let bytes = 0; const reader = response.body.getReader();
    for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > this.budget.limits.maxResponseBytes) { await reader.cancel(); throw new Error("RESOURCE_RESPONSE_BYTES_BUDGET"); } chunks.push(part.value); }
    const body = Buffer.concat(chunks); this.bump("httpBodyBytesReceived", body.byteLength); return body;
  }
  async api(path, actor, body, expected = 200, cleanup = false) {
    this.budget.request(cleanup); if (!cleanup) this.signal?.throwIfAborted(); this.bump("httpRequests");
    const endpoint = path === "/api/session" ? "session.create" : path === "/api/session/revoke" ? "session.revoke" : path === "/api/play/rooms" ? "room.create" : path.includes("/api/releases/") ? "release.get" : `room.${path.split("/").at(-1)}`;
    this.byEndpoint[endpoint] = (this.byEndpoint[endpoint] ?? 0) + 1;
    const serialized = body === undefined ? undefined : JSON.stringify(body); if (serialized) this.bump("httpBodyBytesSent", Buffer.byteLength(serialized));
    const start = performance.now();
    const response = await fetch(this.origin + path, { method: body === undefined ? "GET" : "POST", redirect: "error",
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}), signal: AbortSignal.any([AbortSignal.timeout(Math.min(this.budget.limits.requestTimeoutMs, this.budget.check(cleanup))), ...(!cleanup && this.signal ? [this.signal] : [])]),
      headers: { "User-Agent": this.userAgent, Accept: "application/json", ...(actor?.cookie ? { Cookie: actor.cookie } : {}), ...(body === undefined ? {} : { Origin: this.origin, "Content-Type": "application/json", "X-PWA-Request": "1" }) },
      ...(serialized === undefined ? {} : { body: serialized }) });
    const raw = await this.responseBody(response); this.httpLatencies.push(performance.now() - start);
    let result; try { result = JSON.parse(raw.toString("utf8")); } catch { throw new Error("RESOURCE_NON_JSON_RESPONSE"); }
    if (!(Array.isArray(expected) ? expected : [expected]).includes(response.status)) { const code = result?.error?.code; throw new Error(typeof code === "string" && /^[A-Z0-9_]{1,60}$/.test(code) ? `RESOURCE_API_${code}` : "RESOURCE_UNEXPECTED_HTTP_STATUS"); }
    return { result, response };
  }
  async guest() {
    this.budget.guest(); const { result, response } = await this.api("/api/session", undefined, {}, 201);
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    expect(cookie?.startsWith("__Host-pwa_session=") && typeof result.session?.id === "string", "RESOURCE_SESSION_RESPONSE_INVALID");
    const actor = { cookie, session: result.session, room: undefined, link: undefined, context: undefined, ws: undefined, bound: false,
      nextSeq: 0, receipts: new Map(), fatal: undefined, closed: false, lastStateReceivedAt: 0, closeCode: null };
    this.actors.push(actor); return actor;
  }
  send(actor, payload, command = false) {
    this.budget.message(); this.signal?.throwIfAborted(); expect(actor.ws?.readyState === WebSocket.OPEN, "RESOURCE_SOCKET_NOT_OPEN");
    this.bump("messagesSent"); this.bump("messageBytesSent", typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength); if (command) this.bump("commandsSent"); actor.ws.send(payload);
  }
  control(actor, type, body) { this.send(actor, encodeControl({ v: 1, type, requestId: randomUUID(), ...(actor.link ? { contextTag: actor.link.contextTag } : {}), body })); }
  async loadResources(actor, room) {
    const { result } = await this.api(`/api/releases/${room.gameBuildId}`, actor);
    const release = result.release; expect(release?.gameBuildId === this.config.gameBuildId && Array.isArray(release.assets) && Array.isArray(release.requiredAssets), "RESOURCE_RELEASE_MISMATCH");
    const assets = release.assets.filter(item => release.requiredAssets.includes(item.path)); expect(assets.length === release.requiredAssets.length && assets.length <= 8, "RESOURCE_REQUIRED_ASSET_INVALID");
    for (const asset of assets) {
      const url = new URL(asset.url); expect(url.protocol === "https:" && url.origin === room.frameOrigin && !url.search && !url.hash && !url.username && !url.password, "RESOURCE_ASSET_ORIGIN_INVALID");
      this.budget.request(); this.bump("httpRequests"); this.byEndpoint["asset.get"] = (this.byEndpoint["asset.get"] ?? 0) + 1;
      const response = await fetch(url, { redirect: "error", credentials: "omit", ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
        signal: AbortSignal.any([AbortSignal.timeout(Math.min(this.budget.limits.requestTimeoutMs, this.budget.check())), ...(this.signal ? [this.signal] : [])]), headers: { "User-Agent": this.userAgent } });
      expect(response.status === 200, "RESOURCE_ASSET_UNAVAILABLE"); const raw = await this.responseBody(response);
      expect(raw.byteLength === asset.bytes && hash(raw) === asset.sha256, "RESOURCE_ASSET_HASH_MISMATCH");
      this.assetResponses.push({ path: asset.path, bytes: raw.byteLength, cache: response.headers.get("x-pwa-cache") ?? response.headers.get("cf-cache-status") ?? null });
    }
  }
  async connect(actor, roomId) {
    const { result: grant } = await this.api(`/api/play/rooms/${roomId}/grant`, actor, { requestId: randomUUID() });
    const credential=grant.joinTicket??grant.joinGrant; const target = new URL(grant.wsUrl??grant.socketUrl); expect(target.origin === this.origin.replace(/^http/, "ws") && !target.search && !target.hash && typeof credential === "string", "RESOURCE_GRANT_INVALID");
    this.bump("websocketConnections");
    const ws = new WebSocket(target, { ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}), headers: { Cookie: actor.cookie, Origin: this.origin, "User-Agent": this.userAgent } });
    actor.ws = ws; ws.binaryType = "arraybuffer";
    ws.addEventListener("close", event => { actor.closed = true; actor.closeCode = event.code; });
    ws.addEventListener("error", () => { actor.fatal = "RESOURCE_WEBSOCKET_ERROR"; });
    ws.addEventListener("message", event => {
      try {
        const size = typeof event.data === "string" ? Buffer.byteLength(event.data) : event.data.byteLength;
        expect(size <= 16384, "RESOURCE_SERVER_FRAME_BUDGET"); this.bump("messagesReceived"); this.bump("messageBytesReceived", size);
        if (typeof event.data === "string") {
          const message = parseControl(event.data, { channel: "platform" });
          if (message.type === "AUTH_ACCEPTED") {
            const link = message.body.descriptors.find(item => item.roomId === roomId);
            expect(link && link.endpoints[0].inputSessionId === actor.session.id, "RESOURCE_CONTEXT_MISMATCH"); actor.link = link;
            actor.context = { descriptorId: link.descriptorId, contextTag: BigInt(`0x${link.contextTag}`), endpoints: link.endpoints.map(item => item.endpointId), validFromMs: link.validFromMs, validUntilMs: link.validUntilMs,
              maxFrameBytes: link.limits.maxFrameBytes, maxBulkBytes: 0, streams: link.streams.map(item => ({ ...item, maxAhead: 0xffff_fffe, ...(item.kind === "STATE" ? { usesTick: false } : {}) })) };
            this.control(actor, "LINK_BIND", { descriptorId: link.descriptorId, contextTag: link.contextTag });
          } else if (message.type === "LINK_BOUND") {
            expect(message.body.descriptorId === actor.link.descriptorId, "RESOURCE_LINK_MISMATCH");
            actor.nextSeq = message.body.receiveCursors.find(item => item.space === "COMMAND_SEQ").nextExpected; actor.bound = true;
          } else if (message.type === "ACTION_RECEIPT") { expect(actor.receipts.size < 64, "RESOURCE_RECEIPT_LIMIT"); actor.receipts.set(message.body.commandSeq, { outcome: message.body.outcome, receivedAt: performance.now() }); }
          else if (message.type === "PROTOCOL_ERROR") { this.bump("protocolErrors"); actor.fatal = "RESOURCE_SERVER_PROTOCOL_ERROR"; }
        } else {
          expect(actor.context && actor.bound, "RESOURCE_STATE_BEFORE_CONTEXT");
          const frame = decodeFrame(new Uint8Array(event.data), { context: actor.context, senderEndpointId: actor.link.endpoints[1].endpointId, receiverEndpointId: actor.link.endpoints[0].endpointId, nowMs: Date.now() });
          expect(frame.payload.kind === "STATE" && (frame.header.flags & FULL_STATE), "RESOURCE_STATE_FORMAT_INVALID");
          const view = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload.data));
          expect(view.roomId === roomId && view.gameBuildId === this.config.gameBuildId && view.stateSeq === frame.header.seq && view.seatEpoch === actor.link.endpoints[0].seatEpoch, "RESOURCE_STATE_BINDING_INVALID");
          actor.room = view; actor.lastStateReceivedAt = performance.now();
        }
      } catch { actor.fatal = "RESOURCE_SERVER_MESSAGE_INVALID"; }
    });
    await this.waitFor(() => ws.readyState === WebSocket.OPEN, [actor]);
    this.control(actor, "AUTH_JOIN", { joinGrant: credential, protocolVersions: [1], profileId: this.config.profile, profileVersion: this.config.profileVersion });
    await this.waitFor(() => actor.bound && !!actor.room, [actor]);
  }
  async ready(actor, prepared) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const room = actor.room; expect(room && actor.bound && actor.link, "RESOURCE_READY_BEFORE_BASELINE");
      const { result, response } = await this.api(`/api/play/rooms/${room.roomId}/ready`, actor, { requestId: randomUUID(), expectedMatchRevision: room.revision,
        resourcesReady: true, baselineReady: true, prepared, baseline: { descriptorId: actor.link.descriptorId, stateSeq: room.stateSeq } }, [200, 409]);
      if (response.status === 409) { expect(result.error?.code === "REVISION_CONFLICT", "RESOURCE_READY_REJECTED"); await this.waitFor(() => actor.room.revision > room.revision, [actor]); continue; }
      expect(!!result.room, "RESOURCE_READY_RESPONSE_INVALID"); await this.waitFor(() => actor.room.revision >= result.room.revision, [actor]); return;
    }
    throw new Error("RESOURCE_READY_RETRY_LIMIT");
  }
  async startRoom(label) {
    this.budget.room(); const start = performance.now();
    const red = await this.guest(), yellow = await this.guest();
    const { result } = await this.api("/api/play/rooms", red, { requestId: randomUUID() });
    const view = result.room; expect(view?.gameBuildId === this.config.gameBuildId && /^[a-f0-9-]{36}$/.test(view.roomId), "RESOURCE_ROOM_BUILD_MISMATCH");
    const room = { id: view.roomId, hash: hash(view.roomId), label, actors: [red, yellow], countedActive: true, startedAt: Date.now(), setupMs: 0, commandSamples: [] }; this.rooms.push(room);
    await this.api(`/api/play/rooms/${room.id}/join`, yellow, { requestId: randomUUID() });
    await this.loadResources(red, view); await this.loadResources(yellow, view);
    await this.connect(red, room.id); await this.connect(yellow, room.id);
    await this.waitFor(() => room.actors.every(actor => actor.room.members.length === 2 && actor.room.members.every(member => member.connected)), room.actors);
    await this.ready(red, false); await this.ready(yellow, false); await this.ready(red, true); await this.ready(yellow, true);
    await this.waitFor(() => room.actors.every(actor => actor.room.phase === "RUNNING" && actor.room.moves === 0), room.actors);
    room.setupMs = performance.now() - start; return room;
  }
  async drop(room, column) {
    expect(Number.isSafeInteger(column) && column >= 0 && column < 7, "RESOURCE_COLUMN_INVALID");
    const [red, yellow] = room.actors; expect(red.room.phase === "RUNNING" && yellow.room.phase === "RUNNING" && red.room.moves === yellow.room.moves, "RESOURCE_ROOM_NOT_RUNNING");
    const actor = red.room.turn === "red" ? red : yellow, moves = actor.room.moves, seq = actor.nextSeq++;
    const payload = encodeFrame({ header: { opcode: Opcode.COMMAND, flags: 0, streamId: 1, contextTag: actor.context.contextTag, seq, tick: 0 },
      payload: { kind: "COMMAND", data: text.encode(JSON.stringify({ type: "drop", column })) } }, { context: actor.context, senderEndpointId: actor.link.endpoints[0].endpointId,
      receiverEndpointId: actor.link.endpoints[1].endpointId, nowMs: Date.now(), receivePositions: new Map([[1, seq]]) });
    const start = performance.now(); this.send(actor, payload, true);
    await this.waitFor(() => actor.receipts.has(seq), room.actors); const receipt = actor.receipts.get(seq);
    expect(receipt.outcome.status === "COMMITTED", "RESOURCE_LEGAL_COMMAND_NOT_COMMITTED"); this.bump("committedCommands");
    await this.waitFor(() => room.actors.every(item => item.room.moves === moves + 1 && item.room.stateSeq >= receipt.outcome.stateSeq), room.actors);
    const sample = { move: moves + 1, commitMs: receipt.receivedAt - start, bothStatesMs: Math.max(red.lastStateReceivedAt, yellow.lastStateReceivedAt) - start };
    this.commitLatencies.push(sample.commitMs); this.stateLatencies.push(sample.bothStatesMs); room.commandSamples.push(sample);
    if (room.actors.every(item => item.room.phase === "TERMINAL") && room.countedActive) { room.countedActive = false; this.budget.counts.concurrentRooms--; }
    return sample;
  }
  async play(room, columns, paceMs = 0) {
    for (let index = 0; index < columns.length; index++) { if (index && paceMs) await this.sleep(paceMs); await this.drop(room, columns[index]); }
    return this.roomSummary(room);
  }
  roomSummary(room) { const view = room.actors[0].room; return { label: room.label, roomHash: room.hash, phase: view?.phase ?? "UNKNOWN", result: view?.result ?? null,
    moves: view?.moves ?? null, setupMs: Math.round(room.setupMs * 100) / 100, commitLatency: latencySummary(room.commandSamples.map(item => item.commitMs)), bothStatesLatency: latencySummary(room.commandSamples.map(item => item.bothStatesMs)),
    commandSamples: room.commandSamples.map(item => ({ move: item.move, commitMs: Math.round(item.commitMs * 100) / 100, bothStatesMs: Math.round(item.bothStatesMs * 100) / 100 })) }; }
  get rawRoomIds() { return this.rooms.map(room => room.id); }
  checkpointRooms() { return this.rooms.map(room => ({ roomId: room.id, roomHash: room.hash, phase: room.actors[0].room?.phase ?? "UNKNOWN" })); }
  async close() {
    this.stage = "cleanup";
    for (const room of this.rooms) if (!room.actors.every(actor => actor.room?.phase === "TERMINAL")) this.cleanupFailures.push("RESOURCE_ROOM_TERMINAL_UNCONFIRMED");
    for (const actor of this.actors) if (actor.ws?.readyState === WebSocket.OPEN) actor.ws.close(1000, "RESOURCE_MEASUREMENT_COMPLETE");
    // Cleanup calls have their own reserved HTTP/time allowance and ignore cancellation.
    for (let index = 0; index < this.actors.length; index += 4) await Promise.all(this.actors.slice(index, index + 4).map(async actor => {
      try { await this.api("/api/session/revoke", actor, {}, 200, true); actor.revoked = true; }
      catch { this.cleanupFailures.push("RESOURCE_SESSION_REVOCATION_UNCONFIRMED"); }
      finally { actor.cookie = ""; actor.session = undefined; actor.link = undefined; actor.context = undefined; actor.receipts.clear(); }
    }));
    let closeTimer;
    const closed = await Promise.race([
      this.dispatcher.close().then(() => true, () => false),
      new Promise(resolve => { closeTimer = setTimeout(() => resolve(false), Math.max(1, Math.min(3000, this.budget.deadline - Date.now()))); })
    ]);
    if (closeTimer) clearTimeout(closeTimer);
    if (!closed) await this.dispatcher.destroy();
    return { sessions: this.actors.length, sessionsRevoked: this.actors.filter(actor => actor.revoked).length, rooms: this.rooms.length,
      terminalRoomsObserved: this.rooms.filter(room => room.actors.every(actor => actor.room?.phase === "TERMINAL")).length, failures: [...this.cleanupFailures] };
  }
  report() { return { counts: this.snapshot(), byStage: structuredClone(this.byStage), byEndpoint: { ...this.byEndpoint }, commitLatency: latencySummary(this.commitLatencies),
    bothStatesLatency: latencySummary(this.stateLatencies), httpLatency: latencySummary(this.httpLatencies), assetResponses: [...this.assetResponses], rooms: this.rooms.map(room => this.roomSummary(room)), existingProxyUsed: this.proxyUsed }; }
}
