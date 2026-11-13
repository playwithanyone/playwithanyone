import { parseControl, type CommandOutcome, type ControlMessage, type LinkDescriptor } from "../../protocol/src/control.js";
import { decodeFrame, encodeFrame, FULL_STATE, Opcode, type BinaryContext } from "../../protocol/src/frame.js";
import type { RoomFinalReport, RoomRuntimeMetadata, RoomRuntimeOptions, RoomRuntimePorts, RuntimeAssignment, RuntimeConnectionMeta, RuntimeMember, RuntimePrincipal, RuntimeRoomRecord, Seat, VerifiedJoin } from "./ports.js";

const encoder = new TextEncoder();
const LINK_LIMITS = Object.freeze({ maxFrameBytes: 16384, maxControlBytes: 4096, maxBufferedBytes: 131072, historyBytes: 65536, maxBulkBytes: 0, maxConcurrentBulk: 0 });
export class RoomRuntimeError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); this.name = "RoomRuntimeError"; }
}
function fail(code: string, status = 400): never { throw new RoomRuntimeError(code, status); }
const clone = <T>(value: T): T => structuredClone(value);
async function digest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)), item => item.toString(16).padStart(2, "0")).join("");
}
function randomHex(bytes = 8): string { return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), item => item.toString(16).padStart(2, "0")).join(""); }
function context(descriptor: LinkDescriptor): BinaryContext {
  return { descriptorId: descriptor.descriptorId, contextTag: BigInt(`0x${descriptor.contextTag}`), endpoints: [descriptor.endpoints[0]!.endpointId, descriptor.endpoints[1]!.endpointId],
    validFromMs: descriptor.validFromMs, validUntilMs: descriptor.validUntilMs, maxFrameBytes: descriptor.limits.maxFrameBytes, maxBulkBytes: 0,
    streams: descriptor.streams.map(stream => ({ ...stream, maxAhead: 0xffff_fffe, ...(stream.kind === "STATE" ? { usesTick: false } : {}) })) };
}
function linkDescriptor(room: RuntimeRoomRecord, member: RuntimeMember, now: number): LinkDescriptor {
  const player = `player:${member.seatId}:${member.seatEpoch}`, runtime = `runtime:${room.matchId}`;
  return { descriptorId: crypto.randomUUID(), roomId: room.roomId, matchId: room.matchId, gameBuildId: room.game.release.gameBuildId,
    profileId: "server-turn", profileVersion: 1, protocolVersion: 1, authorityEpoch: 1, contextTag: randomHex(),
    endpoints: [{ endpointId: player, clockDomainId: crypto.randomUUID(), kind: "PLAYER", playerId: member.playerId, sessionId: member.sessionId,
      inputSessionId: member.sessionId, seatId: member.seatId, seatEpoch: member.seatEpoch }, { endpointId: runtime, clockDomainId: crypto.randomUUID(), kind: "RUNTIME", runtimeInstanceId: room.matchId }],
    streams: [{ streamId: 1, logicalStreamId: `command:${room.matchId}:${member.seatId}`, fromEndpointId: player, toEndpointId: runtime,
      kind: "COMMAND", codecId: "connect-four-command-json", codecVersion: 1, firstPosition: 0 },
    { streamId: 2, logicalStreamId: `state:${room.matchId}:${member.seatId}`, fromEndpointId: runtime, toEndpointId: player,
      kind: "STATE", codecId: "connect-four-view-json", codecVersion: 1, firstPosition: 0 }], permissions: ["COMMAND", "STATE"], validFromMs: now,
    validUntilMs: Math.min(member.sessionExpiresAt, now + 3_600_000), limits: { ...LINK_LIMITS } };
}

/** Portable authority. It owns no sockets, database handles, platform credentials or timers. */
export class RoomRuntimeCore<State = unknown> {
  private readonly now: () => number;
  constructor(readonly ports: RoomRuntimePorts<State>, readonly options: RoomRuntimeOptions) {
    this.now = options.clock ?? Date.now;
    if (!["hibernated-turn", "p2p-signaling", "realtime-tick"].includes(options.executionClass) ||
        !Number.isSafeInteger(options.cleanupGraceMs) || options.cleanupGraceMs < 1 ||
        !Number.isSafeInteger(options.maxSnapshotBytes) || options.maxSnapshotBytes < 1024 || options.maxSnapshotBytes > 2 * 1024 * 1024 ||
        !Number.isSafeInteger(options.maxReceipts) || options.maxReceipts < 42 || options.maxReceipts > 10000 ||
        [options.turnTimeoutMs, options.maxLifetimeMs].some(value => value !== null && (!Number.isSafeInteger(value) || value < 1))) fail("RUNTIME_POLICY_REQUIRED", 503);
    if (options.executionClass !== "hibernated-turn" && options.turnTimeoutMs !== null) fail("RUNTIME_POLICY_INVALID", 503);
  }
  private metadata(room: RuntimeRoomRecord<State>): RoomRuntimeMetadata {
    if (room.runtime) return room.runtime;
    const result = this.ports.rules.loadServerRules(room.game.release.gameBuildId, room.game.release.gameId).evaluateResult(room.rules);
    return room.runtime = { schemaVersion: 1, executionClass: this.options.executionClass,
      turnDeadlineAt: room.phase === "RUNNING" && this.options.turnTimeoutMs !== null ? this.now() + this.options.turnTimeoutMs : null,
      hardDeadlineAt: this.options.maxLifetimeMs === null ? null : room.createdAt + this.options.maxLifetimeMs,
      pausedTurnRemainingMs: null,
      winner: result?.kind === "WIN" ? result.winner : null, terminationReason: result?.kind === "WIN" ? "CONNECTED_FOUR" : result?.kind === "DRAW" ? "DRAW" : null,
      authorizationVersions: Object.fromEntries(room.members.map(member => [member.sessionId, 1])), consumedTickets: {}, receipts: [], httpReceipts: [], connectionMetrics: {} };
  }
  load(): RuntimeRoomRecord<State> {
    const room = this.ports.checkpoint.loadSnapshot(); if (!room) fail("ROOM_NOT_FOUND", 404);
    this.metadata(room); return room;
  }
  private collectMetrics(room: RuntimeRoomRecord<State>): void {
    const metrics = this.metadata(room).connectionMetrics;
    for (const id of new Set([...this.ports.transport.listConnections(), ...Object.keys(metrics)])) {
      const meta = this.ports.transport.getConnMeta(id); if (!meta) continue;
      const old = metrics[id] ?? { packets: 0, bytes: 0 };
      metrics[id] = { packets: Math.max(old.packets, meta.uplinkPackets ?? 0), bytes: Math.max(old.bytes, meta.uplinkBytes ?? 0) };
    }
    if (Object.keys(metrics).length > 128) fail("CONNECTION_HISTORY_LIMIT", 429);
  }
  private save(room: RuntimeRoomRecord<State>): void {
    this.collectMetrics(room);
    if (encoder.encode(JSON.stringify(room)).byteLength > this.options.maxSnapshotBytes) fail("CHECKPOINT_LIMIT", 429);
    this.ports.checkpoint.saveSnapshot(room);
  }
  private change<T>(action: (room: RuntimeRoomRecord<State>) => T): T {
    return this.ports.checkpoint.transaction(() => { const room = clone(this.load()); const value = action(room); this.save(room); return value; });
  }
  private member(room: RuntimeRoomRecord<State>, principal: RuntimePrincipal): RuntimeMember {
    return room.members.find(member => member.sessionId === principal.id && member.playerId === principal.playerId) ?? fail("FORBIDDEN", 403);
  }
  private current(connId: string, room = this.load()): { meta: RuntimeConnectionMeta; member: RuntimeMember; link: LinkDescriptor } {
    const meta = this.ports.transport.getConnMeta(connId);
    if (!meta?.authenticated || meta.closing || !meta.seatId || !meta.descriptorId) fail("AUTH_REQUIRED", 401);
    const member = this.member(room, meta.principal), link = member.descriptor;
    if (!member.connected || !link || link.descriptorId !== meta.descriptorId || link.validUntilMs <= this.now() || member.sessionExpiresAt <= this.now()) fail("AUTH_EXPIRED", 401);
    return { meta, member, link };
  }
  projection(principal: RuntimePrincipal): Record<string, unknown> { const room = this.load(); return this.view(room, this.member(room, principal).seatId); }
  private view(room: RuntimeRoomRecord<State>, seat: Seat): Record<string, unknown> {
    const member = room.members.find(item => item.seatId === seat)!;
    const rule = this.ports.rules.loadServerRules(room.game.release.gameBuildId, room.game.release.gameId), deadlines = room.members.flatMap(item => item.disconnectedUntil === null ? [] : [item.disconnectedUntil]);
    const meta = this.metadata(room);
    return { ...rule.project(room.rules, seat), winner: meta.winner, roomId: room.roomId, matchId: room.matchId, phase: room.phase, revision: room.revision,
      stateSeq: room.stateSeq, gameBuildId: room.game.release.gameBuildId, frameOrigin: room.game.release.frameOrigin, entryUrl: room.game.release.entryUrl,
      authorityEpoch: 1, seatId: seat, seatEpoch: member.seatEpoch, result: room.result, disconnectedUntil: deadlines.length ? Math.min(...deadlines) : null,
      turnDeadlineAt: meta.turnDeadlineAt, terminationReason: meta.terminationReason,
      members: room.members.map(item => ({ seatId: item.seatId, color: item.seatId, connected: item.connected, prepared: item.prepared, resourcesReady: item.resourcesReady, baselineReady: item.baselineReady })) };
  }
  async install(assignment: RuntimeAssignment): Promise<void> {
    const identity = await digest(JSON.stringify(assignment));
    this.ports.checkpoint.transaction(() => {
      const previous = this.ports.checkpoint.loadSnapshot();
      if (previous) { if (previous.assignmentId !== assignment.assignmentId || previous.installDigest !== identity) fail("IDEMPOTENCY_CONFLICT", 409); return; }
      if (assignment.members.length < 1 || assignment.members.length > 2) fail("INVALID_ASSIGNMENT", 400);
      const rules = this.ports.rules.loadServerRules(assignment.game.release.gameBuildId, assignment.game.release.gameId);
      const room: RuntimeRoomRecord<State> = { roomId: assignment.roomId, matchId: assignment.matchId, assignmentId: assignment.assignmentId,
        installDigest: identity, game: assignment.game, phase: "PREPARING", revision: 1, stateSeq: 0, rules: rules.create(), members: assignment.members.map((principal, index) => ({
          seatId: index === 0 ? "red" : "yellow", playerId: principal.playerId, sessionId: principal.id, sessionExpiresAt: principal.expiresAt,
          seatEpoch: 1, resourcesReady: false, baselineReady: false, prepared: false, connected: false, disconnectedUntil: null, nextCommandSeq: 0, descriptor: null })),
        createdAt: this.now(), result: null, resultPending: false, resultAttempts: 0, resultRetryAt: null, cleanupDeadlineAt: null, grantKey: randomHex(32), safetyStopped: false };
      this.metadata(room); this.save(room);
    }); await this.schedule();
  }
  async join(principal: RuntimePrincipal, requestId: string): Promise<Record<string, unknown>> {
    if (await this.expireLifetime()) fail("MATCH_TERMINAL", 409);
    const view = this.change(room => {
      const meta = this.metadata(room), old = meta.httpReceipts.find(item => item.kind === "join" && item.sessionId === principal.id && item.requestId === requestId);
      if (old) return this.view(room, this.member(room, principal).seatId);
      const existing = room.members.find(item => item.sessionId === principal.id); if (existing) return this.view(room, existing.seatId);
      if (room.phase !== "PREPARING") fail("MATCH_ALREADY_STARTED", 409);
      if (room.members.length >= 2) fail("ROOM_FULL", 409);
      if (room.members.some(item => item.playerId === principal.playerId)) fail("TAKEOVER_POLICY_REQUIRED", 409);
      room.members.push({ seatId: "yellow", playerId: principal.playerId, sessionId: principal.id, sessionExpiresAt: principal.expiresAt,
        seatEpoch: 1, resourcesReady: false, baselineReady: false, prepared: false, connected: false, disconnectedUntil: null, nextCommandSeq: 0, descriptor: null });
      meta.authorizationVersions[principal.id] = 1; room.revision++; room.stateSeq++;
      meta.httpReceipts.push({ sessionId: principal.id, requestId, kind: "join", digest: "join-room" }); this.boundReceipts(meta);
      return this.view(room, "yellow");
    }); this.broadcast(); await this.schedule(); return view;
  }
  private boundReceipts(meta: RoomRuntimeMetadata): void {
    if (meta.receipts.length > this.options.maxReceipts || meta.httpReceipts.length > this.options.maxReceipts || Object.keys(meta.consumedTickets).length > this.options.maxReceipts) fail("RECEIPT_LIMIT", 429);
  }
  ticketIdentity(principal: RuntimePrincipal): { seat: Seat; seatEpoch: number; authorizationVersion: number } {
    const room = this.load(), member = this.member(room, principal); if (room.phase === "TERMINAL" || (this.metadata(room).hardDeadlineAt !== null && this.metadata(room).hardDeadlineAt! <= this.now())) fail("MATCH_TERMINAL", 409);
    return { seat: member.seatId, seatEpoch: member.seatEpoch, authorizationVersion: this.metadata(room).authorizationVersions[principal.id] ?? 1 };
  }
  /** The host verifies a signed ticket first. Replayed tickets cannot install another connection. */
  async authenticateVerified(connId: string, verified: VerifiedJoin, requestId: string): Promise<void> {
    if (await this.expireLifetime()) fail("MATCH_TERMINAL", 409);
    const before = this.ports.transport.getConnMeta(connId); if (!before || before.closing) fail("AUTH_REQUIRED", 401);
    if (verified.expiresAtMs <= this.now() || verified.principal.expiresAt <= this.now()) fail("AUTH_EXPIRED", 401);
    const link = this.change(room => {
      const member = this.member(room, verified.principal), meta = this.metadata(room);
      if (room.phase === "TERMINAL" || member.seatId !== verified.seat || verified.authorizationVersion !== (meta.authorizationVersions[member.sessionId] ?? 1)) fail("JOIN_REJECTED", 403);
      const ticketKey = `${member.sessionId}:${verified.jti}`;
      const consumed = Object.hasOwn(meta.consumedTickets, ticketKey) ? meta.consumedTickets[ticketKey] : undefined;
      if (consumed) {
        const active = member.descriptor;
        if (consumed.connectionId === connId && consumed.sessionId === member.sessionId && before.authenticated && active !== null && active.descriptorId === before.descriptorId) return active;
        fail("STALE_BINDING", 409);
      }
      if (verified.seatEpoch !== member.seatEpoch) fail("STALE_BINDING", 409);
      member.seatEpoch++; member.connected = true; member.disconnectedUntil = null; member.resourcesReady = false; member.baselineReady = false; member.prepared = false;
      member.descriptor = linkDescriptor(room, member, this.now()); room.revision++; room.stateSeq++;
      meta.consumedTickets[ticketKey] = { connectionId: connId, sessionId: member.sessionId, expiresAt: verified.expiresAtMs }; this.boundReceipts(meta); return member.descriptor;
    });
    const attachment: RuntimeConnectionMeta = { ...before, principal: verified.principal, authenticated: true, bound: false, seatId: verified.seat, descriptorId: link.descriptorId };
    this.ports.transport.setConnMeta(connId, attachment);
    for (const id of this.ports.transport.listConnections()) { const old = this.ports.transport.getConnMeta(id); if (id !== connId && old?.seatId === attachment.seatId) this.close(id, 4001, "PRESENTATION_REPLACED"); }
    this.control(connId, { v: 1, type: "AUTH_ACCEPTED", requestId, body: { endpointId: link.endpoints[0]!.endpointId, protocolVersion: 1, descriptors: [link] } });
    this.broadcast(); await this.schedule();
  }
  async ready(principal: RuntimePrincipal, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (await this.expireLifetime()) fail("MATCH_TERMINAL", 409);
    const requestId = body["requestId"]; if (typeof requestId !== "string") fail("INVALID_REQUEST");
    const identity = await digest(JSON.stringify({ revision: body["expectedMatchRevision"], resources: body["resourcesReady"], baselineReady: body["baselineReady"], prepared: body["prepared"], baseline: body["baseline"] }));
    const view = this.change(room => {
      const member = this.member(room, principal), meta = this.metadata(room);
      const old = meta.httpReceipts.find(item => item.kind === "ready" && item.sessionId === principal.id && item.requestId === requestId);
      if (old) { if (old.digest !== identity) fail("IDEMPOTENCY_CONFLICT", 409); return this.view(room, member.seatId); }
      if (room.phase === "TERMINAL") fail("MATCH_TERMINAL", 409);
      if (body["expectedMatchRevision"] !== room.revision) fail("REVISION_CONFLICT", 409);
      if (typeof body["resourcesReady"] !== "boolean" || typeof body["baselineReady"] !== "boolean" || typeof body["prepared"] !== "boolean") fail("INVALID_REQUEST");
      const baseline = body["baseline"] as { descriptorId?: unknown; stateSeq?: unknown } | undefined;
      const bound = this.ports.transport.listConnections().some(id => { const attachment = this.ports.transport.getConnMeta(id); return attachment?.authenticated && attachment.bound && !attachment.closing && attachment.principal.id === principal.id && attachment.descriptorId === member.descriptor?.descriptorId && baseline?.descriptorId === attachment.descriptorId && Number.isSafeInteger(baseline?.stateSeq) && (baseline!.stateSeq as number) >= 0 && (baseline!.stateSeq as number) <= (attachment.lastSentStateSeq ?? -1); });
      if (!member.connected || !bound) fail("BASELINE_REQUIRED", 409);
      member.resourcesReady = body["resourcesReady"]; member.baselineReady = body["baselineReady"]; member.prepared = body["prepared"];
      if (member.prepared && (!member.resourcesReady || !member.baselineReady)) fail("NOT_READY", 409);
      if (room.phase === "PREPARING" && room.members.length === 2 && room.members.every(item => item.connected && item.resourcesReady && item.baselineReady && item.prepared)) {
        room.phase = "RUNNING"; meta.turnDeadlineAt = this.options.turnTimeoutMs === null ? null : this.now() + this.options.turnTimeoutMs; meta.pausedTurnRemainingMs = null;
      }
      else if (room.phase === "RUNNING" && meta.turnDeadlineAt === null && room.members.every(item => item.connected && item.resourcesReady && item.baselineReady)) {
        // Preserve this turn's consumed thinking time. Reconnecting must not
        // manufacture a fresh turn allowance without an actual legal move.
        const remainingMs = meta.pausedTurnRemainingMs ?? this.options.turnTimeoutMs;
        meta.turnDeadlineAt = remainingMs === null ? null : this.now() + remainingMs;
        meta.pausedTurnRemainingMs = null;
      }
      room.revision++; room.stateSeq++; meta.httpReceipts.push({ sessionId: principal.id, requestId, kind: "ready", digest: identity }); this.boundReceipts(meta); return this.view(room, member.seatId);
    }); this.broadcast(); await this.schedule(); return view;
  }
  private control(connId: string, message: ControlMessage): void { this.send(connId, encoder.encode(JSON.stringify(message)), "text"); }
  private send(connId: string, payload: Uint8Array, format: "text" | "binary"): void {
    const meta = this.ports.transport.getConnMeta(connId); if (!meta || meta.closing) fail("AUTH_REQUIRED", 401);
    const total = (meta.outboundBytes ?? 0) + payload.byteLength; if (total > LINK_LIMITS.maxBufferedBytes) fail("SEND_QUEUE_LIMIT", 429);
    this.ports.transport.setConnMeta(connId, { ...meta, outboundBytes: total }); this.ports.transport.send(connId, payload, format);
  }
  private sendState(connId: string, room = this.load()): void {
    const { meta, member, link } = this.current(connId, room); if (!meta.bound) return;
    const payload = encodeFrame({ header: { opcode: Opcode.STATE, flags: FULL_STATE, streamId: 2, contextTag: BigInt(`0x${link.contextTag}`), seq: room.stateSeq, tick: 0 },
      payload: { kind: "STATE", baseSeq: 0xffff_ffff, data: encoder.encode(JSON.stringify(this.view(room, member.seatId))) } },
    { context: context(link), senderEndpointId: link.endpoints[1]!.endpointId, receiverEndpointId: link.endpoints[0]!.endpointId, nowMs: this.now(), receivePositions: new Map([[2, room.stateSeq]]) });
    this.send(connId, payload, "binary"); this.ports.transport.setConnMeta(connId, { ...this.ports.transport.getConnMeta(connId)!, lastSentStateSeq: room.stateSeq });
  }
  broadcast(): void {
    const room = this.load(); for (const id of this.ports.transport.listConnections()) { try { this.sendState(id, room); } catch (error) { if ((error as { code?: string }).code === "SEND_QUEUE_LIMIT") this.close(id, 4006, "SEND_QUEUE_LIMIT"); } }
  }
  noteIncoming(connId: string, bytes: number): void {
    const meta = this.ports.transport.getConnMeta(connId); if (!meta) fail("AUTH_REQUIRED", 401);
    this.ports.transport.setConnMeta(connId, { ...meta, uplinkPackets: (meta.uplinkPackets ?? 0) + 1, uplinkBytes: (meta.uplinkBytes ?? 0) + bytes });
  }
  /** Authentication is intentionally host-owned; this accepts already-bound protocol traffic. */
  async receive(connId: string, message: string | Uint8Array): Promise<void> {
    if (await this.expireLifetime()) fail("MATCH_TERMINAL", 409);
    if (typeof message === "string") {
      const control = parseControl(message, { maxControlBytes: 4096, channel: "platform", allowedPermissions: ["COMMAND", "STATE"] });
      const { meta, member, link } = this.current(connId);
      if (control.type === "LINK_BIND") {
        if (control.body.descriptorId !== link.descriptorId || control.body.contextTag !== link.contextTag) fail("STALE_BINDING", 409);
        this.ports.transport.setConnMeta(connId, { ...meta, bound: true });
        this.control(connId, { v: 1, type: "LINK_BOUND", requestId: control.requestId, contextTag: link.contextTag, body: { descriptorId: link.descriptorId, contextTag: link.contextTag,
          acceptedStreams: [1, 2], limits: link.limits, receiveCursors: [{ logicalStreamId: link.streams[0]!.logicalStreamId, space: "COMMAND_SEQ", initialPosition: 0, nextExpected: member.nextCommandSeq }] } });
        this.sendState(connId); return;
      }
      if (control.type === "STATE_BASELINE_REQUEST" && control.body.logicalStreamId === link.streams[1]!.logicalStreamId) { this.sendState(connId); return; }
      fail("CAPABILITY_UNAVAILABLE");
    }
    const before = this.load(), { meta, link, member } = this.current(connId, before); if (!meta.bound) fail("LINK_UNBOUND", 409);
    const frame = decodeFrame(message, { context: context(link), senderEndpointId: link.endpoints[0]!.endpointId, receiverEndpointId: link.endpoints[1]!.endpointId, nowMs: this.now(), receivePositions: new Map([[1, member.nextCommandSeq]]) });
    if (frame.payload.kind !== "COMMAND" || frame.header.streamId !== 1) fail("FRAME_PERMISSION", 403);
    const data = frame.payload.data, identity = await digest(data), seq = frame.header.seq, logicalStreamId = link.streams[0]!.logicalStreamId;
    const outcome = this.change(room => {
      const member = this.current(connId, room).member, runtime = this.metadata(room);
      const old = runtime.receipts.find(item => item.seatId === member.seatId && item.logicalStreamId === logicalStreamId && item.seq === seq);
      if (old) { if (old.digest !== identity) fail("IDEMPOTENCY_CONFLICT", 409); return old.outcome; }
      if (seq !== member.nextCommandSeq) fail("RESYNC_REQUIRED", 409);
      if (room.phase !== "RUNNING" || !member.resourcesReady || !member.baselineReady) fail("NOT_READY", 409);
      if (runtime.turnDeadlineAt !== null && runtime.turnDeadlineAt <= this.now()) {
        this.turnTimeout(room);
        const outcome: CommandOutcome = { status: "REJECTED", code: "TURN_TIMEOUT", outcomeRef: `outcome:${room.matchId}:${member.seatId}:${seq}` };
        member.nextCommandSeq++; runtime.receipts.push({ seatId: member.seatId, logicalStreamId, seq, digest: identity, outcome }); this.boundReceipts(runtime);
        return outcome;
      }
      let outcome: CommandOutcome;
      try {
        const rules = this.ports.rules.loadServerRules(room.game.release.gameBuildId, room.game.release.gameId);
        const command = rules.parseCommand(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as unknown);
        room.rules = rules.applyCommand(room.rules, member.seatId, command); room.stateSeq++;
        const result = rules.evaluateResult(room.rules);
        if (result) { runtime.winner = result.kind === "WIN" ? result.winner : null; this.terminateRecord(room, result.kind, result.kind === "WIN" ? "CONNECTED_FOUR" : "DRAW"); }
        else {
          const paused = room.members.some(item => item.disconnectedUntil !== null);
          runtime.turnDeadlineAt = paused || this.options.turnTimeoutMs === null ? null : this.now() + this.options.turnTimeoutMs;
          runtime.pausedTurnRemainingMs = paused ? this.options.turnTimeoutMs : null;
        }
        outcome = { status: "COMMITTED", stateSeq: room.stateSeq, commitRef: `commit:${room.matchId}:${member.seatId}:${seq}` };
      } catch (error) {
        const code = typeof (error as { code?: unknown }).code === "string" && /^[A-Z0-9_]{1,64}$/.test((error as { code: string }).code) ? (error as { code: string }).code : "COMMAND_INVALID";
        outcome = { status: "REJECTED", code, outcomeRef: `outcome:${room.matchId}:${member.seatId}:${seq}` };
      }
      member.nextCommandSeq++; runtime.receipts.push({ seatId: member.seatId, logicalStreamId, seq, digest: identity, outcome }); this.boundReceipts(runtime); return outcome;
    });
    this.control(connId, { v: 1, type: "ACTION_RECEIPT", requestId: `command:${member.seatId}:${seq}`, contextTag: link.contextTag, body: { logicalStreamId, commandSeq: seq, outcome } });
    this.broadcast(); if (this.load().phase === "TERMINAL") this.closeAll("MATCH_TERMINAL"); await this.finishWork(); await this.schedule();
  }
  private async expireLifetime(): Promise<boolean> {
    const room = this.load(), deadline = this.metadata(room).hardDeadlineAt;
    if (room.phase !== "TERMINAL" && deadline !== null && deadline <= this.now()) { await this.terminate("SERVICE_INTERRUPTED", "ROOM_TTL"); return true; }
    return false;
  }
  private terminateRecord(room: RuntimeRoomRecord<State>, result: NonNullable<RuntimeRoomRecord["result"]>, reason: RoomRuntimeMetadata["terminationReason"]): void {
    if (room.phase === "TERMINAL") return;
    room.phase = "TERMINAL"; room.result = result; room.revision++; room.stateSeq++; room.resultPending = true; room.resultRetryAt = this.now(); room.cleanupDeadlineAt = this.now() + this.options.cleanupGraceMs;
    const runtime = this.metadata(room); runtime.turnDeadlineAt = null; runtime.pausedTurnRemainingMs = null; runtime.terminationReason = reason;
    for (const member of room.members) member.disconnectedUntil = null;
  }
  private turnTimeout(room: RuntimeRoomRecord<State>): void {
    const state = this.ports.rules.loadServerRules(room.game.release.gameBuildId, room.game.release.gameId).project(room.rules, null), turn = state["turn"];
    if (turn !== "red" && turn !== "yellow") fail("RULE_STATE_INVALID", 503);
    this.metadata(room).winner = turn === "red" ? "yellow" : "red"; this.terminateRecord(room, "WIN", "TURN_TIMEOUT");
  }
  async terminate(result: "DISCONNECTED" | "SERVICE_INTERRUPTED", reason: RoomRuntimeMetadata["terminationReason"] = result): Promise<void> {
    this.change(room => this.terminateRecord(room, result, reason)); this.broadcast(); this.closeAll(result); await this.finishWork(); await this.schedule();
  }
  close(connId: string, code: number, reason: string): void {
    const meta = this.ports.transport.getConnMeta(connId); if (meta?.closing) return;
    if (meta) this.ports.transport.setConnMeta(connId, { ...meta, closing: true }); this.ports.transport.close(connId, code, reason);
  }
  closeAll(reason: string): void { for (const id of this.ports.transport.listConnections()) this.close(id, 4004, reason); }
  async disconnect(seat: Seat, descriptorId: string | undefined, reason: string, includeUnconnected = false, revoke = false): Promise<void> {
    let expiredTurn = false;
    this.change(room => {
      const member = room.members.find(item => item.seatId === seat); if (!member || (descriptorId !== undefined && member.descriptor?.descriptorId !== descriptorId)) return;
      const runtime = this.metadata(room); if (revoke) runtime.authorizationVersions[member.sessionId] = (runtime.authorizationVersions[member.sessionId] ?? 1) + 1;
      if ((!member.connected && !includeUnconnected) || (!member.connected && member.descriptor === null && member.disconnectedUntil !== null)) return;
      // A valid close event arriving after thinking expiry cannot erase an
      // already-expired deadline merely because the Alarm has not run yet.
      if (room.phase === "RUNNING" && runtime.turnDeadlineAt !== null && runtime.turnDeadlineAt <= this.now()) {
        this.turnTimeout(room); expiredTurn = true;
      }
      member.connected = false; member.resourcesReady = false; member.baselineReady = false; member.prepared = false; member.descriptor = null;
      if (room.phase !== "TERMINAL") {
        member.disconnectedUntil ??= this.now() + room.game.policy.disconnectGraceMs;
        // Keep the no-result reconnect grace and the remaining thinking budget
        // separately; subsequent disconnects while paused do not reset either.
        if (runtime.turnDeadlineAt !== null) runtime.pausedTurnRemainingMs = Math.max(0, runtime.turnDeadlineAt - this.now());
        runtime.turnDeadlineAt = null;
      }
      room.revision++; room.stateSeq++;
    });
    for (const id of this.ports.transport.listConnections()) { const meta = this.ports.transport.getConnMeta(id); if (meta?.seatId === seat && (descriptorId === undefined || meta.descriptorId === descriptorId)) this.close(id, 4005, reason); }
    this.broadcast();
    if (expiredTurn) { this.closeAll("TURN_TIMEOUT"); await this.finishWork(); }
    await this.schedule();
  }
  async connectionClosed(connId: string): Promise<void> {
    const meta = this.ports.transport.getConnMeta(connId); if (meta?.seatId) await this.disconnect(meta.seatId, meta.descriptorId, "DISCONNECTED");
    else if (meta) { const room = this.load(), member = room.members.find(item => item.sessionId === meta.principal.id); if (room.members.length === 2 && member && !member.connected && member.descriptor === null) await this.disconnect(member.seatId, undefined, "DISCONNECTED", true); else await this.schedule(); }
    else await this.schedule();
  }
  async alarm(): Promise<void> {
    const now = this.now();
    for (const id of this.ports.transport.listConnections()) {
      const meta = this.ports.transport.getConnMeta(id); if (!meta || meta.closing) continue;
      if (!meta.authenticated && meta.openedAt + 10000 <= now) { this.close(id, 4003, "AUTH_TIMEOUT"); const room = this.load(), member = room.members.find(item => item.sessionId === meta.principal.id); if (room.members.length === 2 && member && !member.connected && member.descriptor === null) await this.disconnect(member.seatId, undefined, "DISCONNECTED", true); }
      else if (meta.authenticated && meta.seatId) { const member = this.load().members.find(item => item.seatId === meta.seatId); if (member?.descriptor && member.descriptor.validUntilMs <= now) await this.disconnect(meta.seatId, member.descriptor.descriptorId, "AUTH_EXPIRED"); }
    }
    const room = this.load(), runtime = this.metadata(room);
    if (room.phase !== "TERMINAL") {
      if (runtime.hardDeadlineAt !== null && now >= runtime.hardDeadlineAt) { await this.terminate("SERVICE_INTERRUPTED", "ROOM_TTL"); return; }
      if (room.members.some(member => member.disconnectedUntil !== null && member.disconnectedUntil <= now)) { await this.terminate("DISCONNECTED"); return; }
      if (runtime.turnDeadlineAt !== null && now >= runtime.turnDeadlineAt) { this.change(room => this.turnTimeout(room)); this.broadcast(); this.closeAll("TURN_TIMEOUT"); }
    }
    await this.finishWork(); await this.schedule();
  }
  finalReport(): RoomFinalReport<State> {
    const room = clone(this.load()); this.collectMetrics(room); const runtime = this.metadata(room); if (room.result === null) fail("RESULT_NOT_FINAL", 409);
    const metrics = Object.values(runtime.connectionMetrics), endedAt = room.cleanupDeadlineAt === null ? this.now() : room.cleanupDeadlineAt - this.options.cleanupGraceMs;
    return { schemaVersion: 1, roomId: room.roomId, matchId: room.matchId, assignmentId: room.assignmentId, gameId: room.game.release.gameId,
      releaseHash: room.game.release.gameBuildId, executionClass: runtime.executionClass, result: room.result, winner: runtime.winner, reason: runtime.terminationReason,
      createdAt: room.createdAt, endedAt, lifetimeMs: Math.max(0, endedAt - room.createdAt), uplinkPackets: metrics.reduce((sum, item) => sum + item.packets, 0),
      uplinkBytes: metrics.reduce((sum, item) => sum + item.bytes, 0), snapshot: room };
  }
  async finishWork(): Promise<void> {
    const room = this.load(); if (room.phase !== "TERMINAL" || !room.resultPending || (room.resultRetryAt !== null && room.resultRetryAt > this.now())) return;
    if (room.cleanupDeadlineAt !== null && room.cleanupDeadlineAt <= this.now()) { this.change(room => { room.resultRetryAt = null; }); return; }
    try { await this.ports.results.finalizeRoom(this.finalReport()); this.change(room => { room.resultPending = false; room.resultRetryAt = null; }); }
    catch { this.change(room => { room.resultAttempts++; room.resultRetryAt = room.resultAttempts < 6 ? Math.min(this.now() + [1000,5000,15000,60000,300000][Math.min(room.resultAttempts - 1, 4)]!, room.cleanupDeadlineAt ?? Infinity) : null; }); }
  }
  async schedule(): Promise<void> {
    const room = this.load(), deadlines: number[] = [], runtime = this.metadata(room);
    if (room.phase !== "TERMINAL") {
      if (runtime.hardDeadlineAt !== null) deadlines.push(runtime.hardDeadlineAt);
      if (runtime.turnDeadlineAt !== null) deadlines.push(runtime.turnDeadlineAt);
      if (this.options.protectionDeadline) deadlines.push(this.options.protectionDeadline());
      for (const member of room.members) { if (member.disconnectedUntil !== null) deadlines.push(member.disconnectedUntil); if (member.connected && member.descriptor) deadlines.push(member.descriptor.validUntilMs); }
    }
    if (room.resultPending && room.resultRetryAt !== null) deadlines.push(room.resultRetryAt);
    for (const id of this.ports.transport.listConnections()) { const meta = this.ports.transport.getConnMeta(id); if (meta && !meta.authenticated && !meta.closing) deadlines.push(meta.openedAt + 10000); }
    const finite = deadlines.filter(Number.isFinite); if (finite.length) await this.ports.scheduler.setWakeupDeadline(Math.max(this.now() + 1, Math.min(...finite))); else await this.ports.scheduler.clearWakeupDeadline();
  }
}
