import * as four from "../../../../games/connect-four/src/rules.js";
import { parseControl, type ControlMessage } from "../../../../packages/protocol/src/control.js";
import { requirePolicy } from "../../../../packages/protocol/src/policy.js";
import { RoomRuntimeCore, type CheckpointPort, type RoomRuntimeOptions, type RuntimeConnectionMeta, type RuntimeRoomRecord, type ServerRuleModule, type TransportPort } from "../../../../packages/room-runtime/src/index.js";
import { RoomSafety, SqlSafetyStore, resolveSafetyPolicy, type ProtectionState, type RecoveryAuthorization } from "../safety/index.js";
import { ApiError } from "../security.js";
import { withDataSafety } from "../data-safety.js";
import { checkId, checkPrincipal, failure, hash, internalJson, reply, row, token } from "./storage.js";
import { persistResult } from "./results.js";
import { parseJoinTicketKeys, issueJoinTicket, verifyJoinTicket, parseRoomRouting, selectRoomRoute } from "./join-ticket.js";
import { POOL_ID, type DoState, type GameplayEnv, type InstallAssignment, type Principal, type RoomRecord, type RoomView, type ServerSocket, type SocketAttachment } from "./types.js";

interface GrantRow { request_id: string; session_id: string; seat_id: four.Seat; seat_epoch: number; issued_at: number; expires_at: number; token_hash: string; used_connection: string | null }
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_ATTACHMENT_BYTES = 2048;
const STATIC_FOUR_RULES: ServerRuleModule<four.FourState> = {
  create: four.create, parseCommand: four.parseCommand,
  applyCommand: (state, seat, command) => four.applyCommand(state, seat, four.parseCommand(command)),
  project: (state, seat) => ({ ...four.project(state, seat) }), evaluateResult: four.evaluateResult,
};
/** Compatibility utility for readers; all live transitions use RoomRuntimeCore. */
export function roomProjection(room: RoomRecord, seat: four.Seat): RoomView {
  const member = room.members.find(item => item.seatId === seat)!;
  const deadlines = room.members.flatMap(item => item.disconnectedUntil === null ? [] : [item.disconnectedUntil]);
  return { ...four.project(room.rules, seat), winner: room.runtime?.winner ?? room.rules.winner,
    roomId: room.roomId, matchId: room.matchId, phase: room.phase, revision: room.revision, stateSeq: room.stateSeq,
    gameBuildId: room.game.release.gameBuildId, frameOrigin: room.game.release.frameOrigin, entryUrl: room.game.release.entryUrl,
    authorityEpoch: 1, seatId: seat, seatEpoch: member.seatEpoch, result: room.result,
    disconnectedUntil: deadlines.length ? Math.min(...deadlines) : null,
    ...(room.runtime ? { turnDeadlineAt: room.runtime.turnDeadlineAt, terminationReason: room.runtime.terminationReason } : {}),
    members: room.members.map(item => ({ seatId: item.seatId, color: item.seatId, connected: item.connected, prepared: item.prepared, resourcesReady: item.resourcesReady, baselineReady: item.baselineReady })) };
}

/** Cloudflare host: sockets, SQLite, protection, admission and control-plane result sink only. */
export class RoomDO {
  private readonly env: GameplayEnv;
  private readonly sockets = new Map<string, ServerSocket>();
  readonly core: RoomRuntimeCore<four.FourState>;
  private loadedReceiptCount = 0;
  private cleanupAcknowledged = false;
  constructor(private readonly ctx: DoState, env: GameplayEnv) {
    this.env = withDataSafety(env, { waitUntil: promise => ctx.waitUntil(promise) });
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS room_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS closed_assignments (assignment_id TEXT PRIMARY KEY)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS room_commands (session_id TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(session_id,request_id,kind))");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS join_grants (request_id TEXT NOT NULL,session_id TEXT NOT NULL,seat_id TEXT NOT NULL,seat_epoch INTEGER NOT NULL,issued_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,token_hash TEXT NOT NULL UNIQUE,used_connection TEXT,PRIMARY KEY(request_id,session_id))");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS command_receipts (match_id TEXT NOT NULL,seat_id TEXT NOT NULL,logical_stream_id TEXT NOT NULL,seq INTEGER NOT NULL,digest TEXT NOT NULL,outcome TEXT NOT NULL,PRIMARY KEY(match_id,seat_id,logical_stream_id,seq))");
    // Hibernation discards the previous JS Map. Attachments rebuild it on every wake.
    for (const socket of ctx.getWebSockets()) this.remember(socket);
    const options = this.options();
    // Each hash is explicitly registered by the publisher only after comparing
    // that release's private rule artifact with this adapter's approved module.
    // Game id alone can never authorize loading the current rules for an old build.
    const registeredRuleBuilds = this.ruleBuilds();
    const checkpoint: CheckpointPort<four.FourState> = {
      loadSnapshot: () => this.loadSnapshot(options),
      saveSnapshot: room => {
        const stored = room as RoomRecord;
        this.safety(stored).initialize({ now: stored.createdAt, activityMs: 0 });
        ctx.storage.sql.exec("INSERT INTO room_state VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", JSON.stringify(room));
        // Retain the existing receipt index for old rooms and external verification.
        // The authoritative checkpoint and every newly committed receipt are atomic.
        for (const receipt of (room.runtime?.receipts ?? []).slice(this.loadedReceiptCount)) ctx.storage.sql.exec("INSERT INTO command_receipts VALUES (?,?,?,?,?,?) ON CONFLICT(match_id,seat_id,logical_stream_id,seq) DO NOTHING",
          room.matchId, receipt.seatId, receipt.logicalStreamId, receipt.seq, receipt.digest, JSON.stringify(receipt.outcome));
        this.loadedReceiptCount = room.runtime?.receipts.length ?? 0;
      },
      clear: () => { throw new ApiError("EXPLICIT_RETENTION_POLICY_REQUIRED", 409); },
      transaction: callback => ctx.storage.transactionSync(callback),
    };
    const transport: TransportPort = {
      listConnections: () => ctx.getWebSockets().map(socket => this.remember(socket)),
      send: (id, bytes, format = "binary") => this.socket(id).send(format === "text" ? decoder.decode(bytes) : bytes),
      broadcast: (bytes, exclude, format = "binary") => { for (const socket of ctx.getWebSockets()) { const id = this.remember(socket); if (id !== exclude) socket.send(format === "text" ? decoder.decode(bytes) : bytes); } },
      close: (id, code, reason) => { try { this.socket(id).close(code, reason); } catch { /* Closing remains fenced in the attachment. */ } },
      setConnMeta: (id, meta) => { if (encoder.encode(JSON.stringify(meta)).byteLength >= MAX_ATTACHMENT_BYTES) throw new ApiError("ATTACHMENT_LIMIT", 429); this.socket(id).serializeAttachment(meta); },
      getConnMeta: id => this.sockets.get(id)?.deserializeAttachment() as RuntimeConnectionMeta | undefined,
    };
    this.core = new RoomRuntimeCore({ transport, checkpoint,
      scheduler: { setWakeupDeadline: time => ctx.storage.setAlarm(time), clearWakeupDeadline: () => ctx.storage.deleteAlarm(),
        startTickLoop: () => { throw new ApiError("EXECUTION_CLASS_UNAVAILABLE", 503); }, stopTickLoop: () => {} },
      rules: { loadServerRules: (releaseHash, gameId) => {
        if (gameId !== "connect-four" || !registeredRuleBuilds.has(releaseHash)) throw new ApiError("RULE_RELEASE_NOT_REGISTERED", 503);
        return STATIC_FOUR_RULES;
      } },
      results: { finalizeRoom: async summary => {
        const room = summary.snapshot as RoomRecord;
        this.safety(room).consumeCleanupOperation(); await persistResult(this.env, room);
        this.safety(room).consumeCleanupOperation(); await internalJson(this.env.MATCH_POOL, this.poolId(room), { op: "close", assignmentId: room.assignmentId });
        await this.env.DB.prepare("DELETE FROM session_rooms WHERE room_id=?").bind(room.roomId).run();
      } },
    }, { ...options, protectionDeadline: () => this.safety(this.core.load() as RoomRecord).nextDeadline(Date.now()) });
  }
  private ruleBuilds(): ReadonlySet<string> {
    const current = this.env.CONNECT_FOUR_BUILD_ID;
    if (typeof current !== "string" || !/^[a-f0-9]{64}$/.test(current)) throw new ApiError("RULE_RELEASE_NOT_REGISTERED", 503);
    if (!this.env.CONNECT_FOUR_RULE_BUILDS_JSON) return new Set([current]);
    let candidates: unknown; try { candidates = JSON.parse(this.env.CONNECT_FOUR_RULE_BUILDS_JSON); } catch { throw new ApiError("RULE_RELEASE_NOT_REGISTERED", 503); }
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 64 || candidates.some(item => typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item)) || new Set(candidates).size !== candidates.length || !candidates.includes(current)) throw new ApiError("RULE_RELEASE_NOT_REGISTERED", 503);
    return new Set(candidates as string[]);
  }
  private options(): RoomRuntimeOptions {
    const policy = JSON.parse(this.env.GAMEPLAY_POLICY_JSON ?? "null") as { values?: Record<string, unknown> } | null;
    const values = policy?.values ?? {}, safety = JSON.parse(this.env.SAFETY_POLICY_JSON ?? "null") as { values?: { room?: { closeGraceMs?: number } } } | null;
    const executionClass = values["executionClass"] ?? "hibernated-turn";
    if (executionClass !== "hibernated-turn") throw new ApiError("EXECUTION_CLASS_UNAVAILABLE", 503);
    return { executionClass, turnTimeoutMs: typeof values["turnTimeoutMs"] === "number" ? values["turnTimeoutMs"] : null,
      maxLifetimeMs: typeof values["maxRoomLifetimeMs"] === "number" ? values["maxRoomLifetimeMs"] : null,
      cleanupGraceMs: safety?.values?.room?.closeGraceMs ?? 3000, maxSnapshotBytes: 1048576, maxReceipts: 512 };
  }
  private loadSnapshot(options: RoomRuntimeOptions): RuntimeRoomRecord<four.FourState> | undefined {
    const stored = row<{ body: string }>(this.ctx.storage, "SELECT body FROM room_state WHERE id=1"); if (!stored) return undefined;
    const room = JSON.parse(stored.body) as RoomRecord;
    if (!room.runtime) {
      const result = four.evaluateResult(room.rules);
      room.runtime = { schemaVersion: 1, executionClass: options.executionClass, turnDeadlineAt: room.phase === "RUNNING" && options.turnTimeoutMs !== null ? Date.now() + options.turnTimeoutMs : null,
        hardDeadlineAt: options.maxLifetimeMs === null ? null : room.createdAt + options.maxLifetimeMs,
        winner: result?.kind === "WIN" ? result.winner : null, terminationReason: result?.kind === "WIN" ? "CONNECTED_FOUR" : result?.kind === "DRAW" ? "DRAW" : null,
        authorizationVersions: Object.fromEntries(room.members.map(member => [member.sessionId, 1])), consumedTickets: {},
        receipts: this.ctx.storage.sql.exec<{ seat_id: four.Seat; logical_stream_id: string; seq: number; digest: string; outcome: string }>("SELECT seat_id,logical_stream_id,seq,digest,outcome FROM command_receipts ORDER BY seq LIMIT 513").toArray().map(item => ({ seatId: item.seat_id, logicalStreamId: item.logical_stream_id, seq: item.seq, digest: item.digest, outcome: JSON.parse(item.outcome) })),
        httpReceipts: this.ctx.storage.sql.exec<{ session_id: string; request_id: string; kind: "join" | "ready"; digest: string }>("SELECT session_id,request_id,kind,digest FROM room_commands LIMIT 513").toArray().map(item => ({ sessionId: item.session_id, requestId: item.request_id, kind: item.kind, digest: item.digest })), connectionMetrics: {} };
      if (room.runtime.receipts.length > 512 || room.runtime.httpReceipts.length > 512) throw new ApiError("LEGACY_CHECKPOINT_LIMIT", 503);
    }
    this.loadedReceiptCount = room.runtime?.receipts.length ?? 0;
    return room;
  }
  private remember(socket: ServerSocket): string {
    const meta = socket.deserializeAttachment() as SocketAttachment | null;
    if (!meta?.connectionId) throw new ApiError("AUTH_REQUIRED", 401);
    this.sockets.set(meta.connectionId, socket); return meta.connectionId;
  }
  private socket(id: string): ServerSocket { const socket = this.sockets.get(id); if (!socket) throw new ApiError("CONNECTION_NOT_FOUND", 404); return socket; }
  private safety(room: RoomRecord): RoomSafety {
    let binding: unknown; try { binding = this.env.SAFETY_POLICY_JSON ? JSON.parse(this.env.SAFETY_POLICY_JSON) : undefined; } catch { throw new ApiError("POLICY_REQUIRED", 503); }
    return new RoomSafety(requirePolicy(resolveSafetyPolicy(binding, this.env.APP_ENV)).value, new SqlSafetyStore(this.ctx.storage), room.roomId);
  }
  private poolId(room: RoomRecord): string { return (room.game as RoomRecord["game"] & { poolOwnerId?: string }).poolOwnerId ?? POOL_ID; }
  private legacy(): boolean { return !this.env.ROOM_TICKET_KEYS_JSON && (this.env.APP_ENV === "fixture" || this.env.ROOM_LEGACY_GRANTS_ENABLED === "true"); }
  private async grant(principal: Principal, requestId: string): Promise<Record<string, unknown>> {
    const room = this.core.load() as RoomRecord; this.safety(room).assertCanRun(Date.now());
    const identity = this.core.ticketIdentity(principal);
    if (!this.legacy()) {
      const routing = parseRoomRouting(this.env.ROOM_ROUTING_JSON, this.env.APP_ENV), route = selectRoomRoute(routing, { gameId: room.game.release.gameId, releaseHash: room.game.release.gameBuildId, roomId: room.roomId });
      const nowMs = Date.now(), ttlSeconds = Math.min(90, Math.floor((principal.expiresAt - nowMs) / 1000));
      if (ttlSeconds < 60) throw new ApiError("AUTH_EXPIRED", 401);
      const joinTicket = await issueJoinTicket({ roomId: room.roomId, matchId: room.matchId, gameId: room.game.release.gameId, playerId: principal.playerId, sessionId: principal.id,
        ...identity, releaseHash: room.game.release.gameBuildId, executionClass: route.executionClass, aud: route.audience }, parseJoinTicketKeys(this.env.ROOM_TICKET_KEYS_JSON), { nowMs, ttlSeconds, jti: await hash(`${principal.id}:${requestId}`) });
      return { roomId: room.roomId, joinTicket, wsUrl: route.wsUrl, executionClass: route.executionClass, syncPolicy: route.syncPolicy, expiresAt: Math.min(nowMs + ttlSeconds * 1000, principal.expiresAt) };
    }
    const member = room.members.find(item => item.sessionId === principal.id)!;
    let record = row<GrantRow>(this.ctx.storage, "SELECT * FROM join_grants WHERE request_id=? AND session_id=?", requestId, principal.id);
    if (!record) {
      const issued = Date.now(), candidate = { request_id: requestId, session_id: principal.id, seat_id: member.seatId, seat_epoch: member.seatEpoch,
        issued_at: issued, expires_at: Math.min(issued + 120000, principal.expiresAt), token_hash: "", used_connection: null };
      const grant = await token(room.grantKey, JSON.stringify([room.roomId, room.matchId, candidate])); candidate.token_hash = await hash(grant);
      this.ctx.storage.transactionSync(() => { const fresh = this.core.load(), current = fresh.members.find(item => item.sessionId === principal.id)!; if (fresh.phase === "TERMINAL" || current.seatEpoch !== candidate.seat_epoch) throw new ApiError("STALE_BINDING", 409);
        this.ctx.storage.sql.exec("INSERT INTO join_grants VALUES (?,?,?,?,?,?,?,NULL) ON CONFLICT(request_id,session_id) DO NOTHING", requestId, principal.id, member.seatId, member.seatEpoch, issued, candidate.expires_at, candidate.token_hash); });
      record = row<GrantRow>(this.ctx.storage, "SELECT * FROM join_grants WHERE request_id=? AND session_id=?", requestId, principal.id)!;
    }
    if (record.expires_at <= Date.now()) throw new ApiError("AUTH_EXPIRED", 401);
    const raw = await token(room.grantKey, JSON.stringify([room.roomId, room.matchId, { ...record, token_hash: "", used_connection: null }]));
    if (await hash(raw) !== record.token_hash) throw new ApiError("GRANT_INTEGRITY", 503);
    return { joinGrant: raw, expiresAt: record.expires_at, socketUrl: `${this.env.SHELL_ORIGIN.replace(/^http/, "ws")}/api/play/rooms/${room.roomId}/socket` };
  }
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return await this.upgrade(request);
      if (request.method !== "POST") throw new ApiError("METHOD_NOT_ALLOWED", 405);
      const body = await request.json() as Record<string, unknown>, op = body["op"];
      if (op === "install") {
        const assignment = body["assignment"] as unknown as InstallAssignment;
        if (row(this.ctx.storage, "SELECT assignment_id FROM closed_assignments WHERE assignment_id=?", assignment.assignmentId)) throw new ApiError("ASSIGNMENT_CLOSED", 409);
        await this.core.install(assignment); return reply({ installed: true });
      }
      if (op === "safety-status") {
        if (!row(this.ctx.storage, "SELECT id FROM room_state WHERE id=1") && row(this.ctx.storage, "SELECT assignment_id FROM closed_assignments LIMIT 1")) return reply({ stopped: true, activeConnections: this.ctx.getWebSockets().length, backgroundTasks: 0, phase: "TERMINAL", unfinishedCleanup: false });
        const room = this.core.load(), activeConnections = this.ctx.getWebSockets().length;
        const backgroundTasks = (room.phase === "TERMINAL" ? 0 : 1) + (room.resultPending && room.resultRetryAt !== null ? 1 : 0);
        return reply({ stopped: room.phase === "TERMINAL" && activeConnections === 0 && backgroundTasks === 0, activeConnections, backgroundTasks, phase: room.phase, unfinishedCleanup: room.resultPending });
      }
      if (op === "safety-apply") {
        const room = this.core.load() as RoomRecord, safety = this.safety(room);
        if (body["authorization"]) safety.recoverProtection(body["protection"] as ProtectionState, body["authorization"] as RecoveryAuthorization); else safety.applyProtection(body["protection"] as ProtectionState);
        const accepted = safety.protectionState(); if (accepted.state === "BLOCKED") { this.ctx.storage.transactionSync(() => { const fresh = this.core.load(); fresh.safetyStopped = true; this.ctx.storage.sql.exec("UPDATE room_state SET body=? WHERE id=1", JSON.stringify(fresh)); }); await this.core.terminate("SERVICE_INTERRUPTED"); await this.acknowledgeCleanup(); }
        await this.core.schedule(); return reply({ acceptedVersion: accepted.version, state: accepted.state });
      }
      if (op === "terminal") {
        if (typeof body["assignmentId"] === "string" && row(this.ctx.storage, "SELECT assignment_id FROM closed_assignments WHERE assignment_id=?", body["assignmentId"])) return reply({ terminal: true });
        const room = this.core.load(); return reply({ terminal: room.assignmentId === body["assignmentId"] && room.phase === "TERMINAL" });
      }
      if (op === "close-assignment") {
        checkId(body["assignmentId"]); this.ctx.storage.transactionSync(() => this.ctx.storage.sql.exec("INSERT OR IGNORE INTO closed_assignments VALUES (?)", body["assignmentId"] as string));
        const room = this.portsSnapshot(); if (room && room.assignmentId === body["assignmentId"] && room.phase !== "TERMINAL") await this.core.terminate("SERVICE_INTERRUPTED");
        this.core.closeAll("ASSIGNMENT_CLOSED"); if (room) await this.core.finishWork(); return reply({ closed: true });
      }
      if (op === "revoke-session") {
        checkId(body["sessionId"]); const room = this.core.load(), member = room.members.find(item => item.sessionId === body["sessionId"]);
        if (member) await this.core.disconnect(member.seatId, member.descriptor?.descriptorId, "SESSION_REVOKED", true, true); return reply({ revoked: true });
      }
      checkPrincipal(body["principal"]); const principal = body["principal"];
      if (op === "join") { checkId(body["requestId"]); this.safety(this.core.load() as RoomRecord).assertCanRun(Date.now()); return reply({ room: await this.core.join(principal, body["requestId"]) }); }
      if (op === "grant") { checkId(body["requestId"]); return reply(await this.grant(principal, body["requestId"])); }
      if (op === "ready") { this.safety(this.core.load() as RoomRecord).assertCanRun(Date.now()); return reply({ room: await this.core.ready(principal, body) }); }
      const room = this.core.load(), member = room.members.find(item => item.sessionId === principal.id && item.playerId === principal.playerId); if (!member) throw new ApiError("FORBIDDEN", 403);
      if (op === "status") return reply({ room: this.core.projection(principal) });
      if (op === "presentation") {
        if (body["gameBuildId"] !== room.game.release.gameBuildId || body["frameOrigin"] !== room.game.release.frameOrigin) throw new ApiError("STALE_BINDING", 409); checkId(body["presentationInstanceId"]);
        if (room.phase === "TERMINAL") return reply({ bindingId: crypto.randomUUID(), sessionId: principal.id, expiresAt: principal.expiresAt, capabilityIds: ["ready", "state.subscribe", "assets.resolve"] });
        if (!member.connected || !member.descriptor || member.descriptor.validUntilMs <= Date.now()) throw new ApiError("MATCH_REQUIRED", 409);
        return reply({ bindingId: crypto.randomUUID(), sessionId: principal.id, expiresAt: Math.min(principal.expiresAt, member.descriptor.validUntilMs), capabilityIds: ["ready", "state.subscribe", "assets.resolve", "actions.dispatch"],
          matchScope: { matchId: room.matchId, role: "PLAYER", seatId: member.seatId, seatEpoch: member.seatEpoch, inputSessionId: principal.id, authorityEpoch: 1 } });
      }
      throw new ApiError("NOT_FOUND", 404);
    } catch (error) { return failure(error); }
  }
  private portsSnapshot(): RuntimeRoomRecord<four.FourState> | undefined { return this.core.ports.checkpoint.loadSnapshot(); }
  private async acknowledgeCleanup(): Promise<void> {
    if (this.cleanupAcknowledged) return;
    const room = this.core.load() as RoomRecord; if (room.phase !== "TERMINAL" || room.resultPending) return;
    this.cleanupAcknowledged = true;
    try { await internalJson(this.env.MATCH_POOL, this.poolId(room), { op: "cleanup-complete", assignmentId: room.assignmentId }); } catch { /* Conservative registry remains observable. */ }
  }
  private async upgrade(request: Request): Promise<Response> {
    if (request.headers.get("Origin") !== this.env.SHELL_ORIGIN) throw new ApiError("ORIGIN_REJECTED", 403);
    const room = this.core.load() as RoomRecord; this.safety(room).assertCanRun(Date.now()); if (room.phase === "TERMINAL") throw new ApiError("MATCH_TERMINAL", 409);
    let principal: Principal = { id: "pending", playerId: "pending", expiresAt: Date.now() + 10000 };
    if (this.legacy()) { let value: unknown; try { value = JSON.parse(request.headers.get("X-PWA-Principal") ?? "null"); } catch { throw new ApiError("AUTH_REQUIRED", 401); } checkPrincipal(value); this.core.projection(value); principal = value; }
    else parseJoinTicketKeys(this.env.ROOM_TICKET_KEYS_JSON);
    if (this.ctx.getWebSockets().length >= 6) throw new ApiError("SOCKET_LIMIT", 429);
    const Pair = (globalThis as unknown as { WebSocketPair: new () => { 0: ServerSocket; 1: ServerSocket } }).WebSocketPair, pair = new Pair();
    // Only the Hibernation API is used. There are no socket event listeners or JS timers.
    this.ctx.acceptWebSocket(pair[1]); pair[1].serializeAttachment({ connectionId: crypto.randomUUID(), principal, openedAt: Date.now(), authenticated: false, bound: false } satisfies SocketAttachment);
    this.remember(pair[1]); await this.core.schedule(); return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }
  private async authenticate(connId: string, message: Extract<ControlMessage, { type: "AUTH_JOIN" }>): Promise<void> {
    if (message.body.profileId !== "server-turn" || message.body.profileVersion !== 1 || !message.body.protocolVersions.includes(1)) throw new ApiError("PROTOCOL_VERSION", 409);
    const room = this.core.load(), attachment = this.core.ports.transport.getConnMeta(connId)!;
    if (!this.legacy()) {
      const route = selectRoomRoute(parseRoomRouting(this.env.ROOM_ROUTING_JSON, this.env.APP_ENV), { gameId: room.game.release.gameId, releaseHash: room.game.release.gameBuildId, roomId: room.roomId });
      const claims = await verifyJoinTicket(message.body.joinGrant, parseJoinTicketKeys(this.env.ROOM_TICKET_KEYS_JSON), { aud: route.audience, roomId: room.roomId, matchId: room.matchId, gameId: room.game.release.gameId, releaseHash: room.game.release.gameBuildId, executionClass: route.executionClass });
      const member = room.members.find(item => item.sessionId === claims.sessionId && item.playerId === claims.playerId); if (!member) throw new ApiError("JOIN_REJECTED", 403);
      await this.core.authenticateVerified(connId, { principal: { id: member.sessionId, playerId: member.playerId, expiresAt: member.sessionExpiresAt }, seat: claims.seat,
        seatEpoch: claims.seatEpoch, authorizationVersion: claims.authorizationVersion, jti: claims.jti, expiresAtMs: claims.exp * 1000 }, message.requestId); return;
    }
    const tokenHash = await hash(message.body.joinGrant), grant = row<GrantRow>(this.ctx.storage, "SELECT * FROM join_grants WHERE token_hash=?", tokenHash);
    const valid = await this.env.DB.prepare("SELECT session_id FROM sessions WHERE session_id=? AND revoked_at IS NULL AND expires_at>?").bind(attachment.principal.id, Date.now()).first<{ session_id: string }>();
    if (!valid) throw new ApiError("AUTH_REQUIRED", 401);
    const member = room.members.find(item => item.sessionId === attachment.principal.id);
    if (!grant || !member || grant.session_id !== member.sessionId || grant.seat_id !== member.seatId || grant.expires_at <= Date.now()) throw new ApiError("JOIN_REJECTED", 403);
    if (grant.used_connection !== null && grant.used_connection !== connId) throw new ApiError("STALE_BINDING", 409);
    await this.core.authenticateVerified(connId, { principal: attachment.principal, seat: member.seatId, seatEpoch: grant.seat_epoch,
      authorizationVersion: room.runtime?.authorizationVersions[member.sessionId] ?? 1, jti: `legacy:${tokenHash}`, expiresAtMs: grant.expires_at }, message.requestId);
    this.ctx.storage.sql.exec("UPDATE join_grants SET used_connection=? WHERE token_hash=?", connId, tokenHash);
  }
  async webSocketMessage(socket: ServerSocket, message: string | ArrayBuffer): Promise<void> {
    const id = this.remember(socket);
    try {
      const room = this.core.load() as RoomRecord, attachment = this.core.ports.transport.getConnMeta(id)!;
      this.safety(room).admitMessage({ connectionId: id, bytes: typeof message === "string" ? encoder.encode(message).length : message.byteLength,
        fanout: this.ctx.getWebSockets().filter(item => (item.deserializeAttachment() as SocketAttachment | null)?.authenticated).length, queuedBytes: attachment.outboundBytes ?? 0, now: Date.now() });
      this.core.noteIncoming(id, typeof message === "string" ? encoder.encode(message).byteLength : message.byteLength);
      if (typeof message === "string") { const control = parseControl(message, { maxControlBytes: 4096, channel: "platform", allowedPermissions: ["COMMAND", "STATE"] }); if (control.type === "AUTH_JOIN") { await this.authenticate(id, control); return; } }
      await this.core.receive(id, typeof message === "string" ? message : new Uint8Array(message));
      await this.acknowledgeCleanup();
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "INTERNAL_ERROR";
      try { const message: ControlMessage = { v: 1, type: "PROTOCOL_ERROR", requestId: crypto.randomUUID(), body: { code, retryable: false } }; this.core.ports.transport.send(id, encoder.encode(JSON.stringify(message)), "text"); } catch { /* Socket is already gone. */ }
      if (["AUTH_REQUIRED", "AUTH_EXPIRED", "JOIN_REJECTED", "STALE_BINDING", "ROOM_TICKET_INVALID", "ROOM_TICKET_EXPIRED", "ROOM_TICKET_SCOPE", "SEND_QUEUE_LIMIT", "SAFETY_LIMIT", "SAFETY_BLOCKED", "SAFETY_EXPIRED"].includes(code)) { this.core.close(id, 4003, code); if (code.startsWith("SAFETY_")) await this.core.terminate("SERVICE_INTERRUPTED"); }
    }
  }
  async webSocketClose(socket: ServerSocket): Promise<void> { await this.core.connectionClosed(this.remember(socket)); }
  async webSocketError(socket: ServerSocket): Promise<void> { await this.webSocketClose(socket); }
  async alarm(): Promise<void> {
    const room = this.core.load() as RoomRecord;
    if (room.phase !== "TERMINAL") { try { this.safety(room).assertCanRun(Date.now()); } catch { await this.core.terminate("SERVICE_INTERRUPTED"); return; } }
    await this.core.alarm(); await this.acknowledgeCleanup();
  }
}
