import { ApiError } from "../security.js";
import { withDataSafety } from "../data-safety.js";
import { requirePolicy } from "../../../../packages/protocol/src/policy.js";
import { canonicalize } from "../../../../packages/release/src/canonical.js";
import { SafetyLimits, SqlSafetyStore, resolveSafetyPolicy, d1SafetyStatus, D1_SAFETY_SCOPE, type D1SafetyIncident, type ProtectionState, type RecoveryAuthorization } from "../safety/index.js";
import { checkId, checkPrincipal, failure, hash, internalJson, reply, row } from "./storage.js";
import { POOL_ID, type DoState, type FixedGame, type GameplayEnv, type InstallAssignment, type Principal, type QueueView, type ServerSocket } from "./types.js";

interface IntentRow {
  intent_id: string; requester_id: string; request_id: string; digest: string; principal: string;
  game: string; state: QueueView["status"]; revision: number; owner_epoch: number;
  created_at: number; deadline_at: number; assignment_id: string | null;
}
interface AssignmentRow { assignment_id: string; room_id: string; payload: string; state: "COMMITTED" | "ROOM_INSTALLED" | "CLOSED"; attempts: number; retry_at: number | null }
interface IncidentPropagation { version: number; attempts: number; next_retry_at: number | null; complete: number; last_observation: string | null }
interface ProtectionJob { version: number; phase: "PROPAGATING" | "OBSERVING" | "COMPLETE" | "FAILED"; cursor: string; observationCursor: string | null; pass: number; failures: string[]; nextAt: number | null; authorization?: RecoveryAuthorization; lastObservation?: Record<string, unknown> }
interface QueueAttachment { readonly kind: "queue"; readonly intentId: string; readonly sessionId: string; readonly expiresAt: number; lastRevision?: number; lastStatus?: string; closing?: boolean }
interface ObservationScan { id: string; version: number; cursor: string; activeConnections: number; backgroundTasks: number; stopped: boolean; observedRooms: number; unknownRooms: number; lastInput: string | null; lastResult: Record<string, unknown> | null }
// Engineering admission limits for this preview, independent of any account-wide
// policy on how many simultaneous activities a player may have.
const MAX_PENDING_INTENTS = 24, MAX_SESSION_QUEUE_CREATES_MINUTE = 6;
const SAFETY_PAGE_SIZE = 8;

/** Single explicitly configured pool: candidate selection and assignment share SQLite ownership. */
export class MatchPoolDO {
  private readonly env: GameplayEnv;
  private incidentPropagation: Promise<void> | undefined;
  private protectionWork: Promise<ProtectionJob> | undefined;
  constructor(private readonly ctx: DoState, env: GameplayEnv) {
    this.env = withDataSafety(env, { waitUntil: promise => ctx.waitUntil(promise), onIncident: incident => this.handleD1Incident(incident).then(() => undefined) });
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS queue_intents (
      intent_id TEXT PRIMARY KEY, requester_id TEXT NOT NULL, request_id TEXT NOT NULL,
      digest TEXT NOT NULL, principal TEXT NOT NULL, game TEXT NOT NULL,
      state TEXT NOT NULL, revision INTEGER NOT NULL, owner_epoch INTEGER NOT NULL,
      created_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL, assignment_id TEXT,
      UNIQUE(requester_id, request_id))`);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS queue_candidates ON queue_intents(state,created_at)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS queue_requester_state ON queue_intents(requester_id,state)");
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS assignments (
      assignment_id TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, match_id TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER)`);
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS assignments_state_retry ON assignments(state,retry_at,assignment_id)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS assignments_active ON assignments(assignment_id) WHERE state<>'CLOSED'");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS queue_deadlines ON queue_intents(state,deadline_at)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS assigned_intents (intent_id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pool_commands (scope TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(scope,request_id))");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS queue_resource_usage (scope TEXT PRIMARY KEY,minute INTEGER NOT NULL,minute_count INTEGER NOT NULL,day INTEGER NOT NULL,day_count INTEGER NOT NULL,cycle_id TEXT NOT NULL,cycle_count INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS queue_cycle_identity (id INTEGER PRIMARY KEY CHECK(id=1),cycle_id TEXT NOT NULL,starts_at INTEGER NOT NULL,ends_at INTEGER NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS room_cleanup_registry (assignment_id TEXT PRIMARY KEY,room_id TEXT NOT NULL UNIQUE,cleanup_complete INTEGER NOT NULL DEFAULT 0)");
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS outstanding_room_cleanup ON room_cleanup_registry(cleanup_complete,assignment_id)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS d1_incident_propagation (version INTEGER PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,next_retry_at INTEGER,complete INTEGER NOT NULL DEFAULT 0,last_observation TEXT)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pool_manual_recovery (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,recovered_at INTEGER NOT NULL)");
  }
  private limits(): SafetyLimits {
    let binding: unknown;
    try { binding = this.env.SAFETY_POLICY_JSON ? JSON.parse(this.env.SAFETY_POLICY_JSON) : undefined; } catch { throw new ApiError("POLICY_REQUIRED", 503, "safety"); }
    const policy = requirePolicy(resolveSafetyPolicy(binding, this.env.APP_ENV)).value;
    return new SafetyLimits(policy, new SqlSafetyStore(this.ctx.storage));
  }
  private intent(id: string): IntentRow {
    const value = row<IntentRow>(this.ctx.storage, "SELECT * FROM queue_intents WHERE intent_id = ?", id);
    if (!value) throw new ApiError("INTENT_NOT_FOUND", 404, "matchmaking");
    return value;
  }
  private view(intent: IntentRow): QueueView {
    const assignment = intent.assignment_id ? row<AssignmentRow>(this.ctx.storage, "SELECT * FROM assignments WHERE assignment_id = ?", intent.assignment_id) : undefined;
    // An uninstalled outbox never grants entry. Preserve the committed assignment while retrying.
    return { intentId: intent.intent_id, status: assignment?.state === "COMMITTED" ? "QUEUED" : intent.state,
      deadlineAt: intent.deadline_at, revision: intent.revision,
      ...(assignment && assignment.state !== "COMMITTED" ? { roomId: assignment.room_id } : {}) };
  }
  private expire(now: number): void {
    this.ctx.storage.sql.exec("UPDATE queue_intents SET state = 'EXPIRED', revision = revision + 1 WHERE state = 'QUEUED' AND deadline_at <= ?", now);
  }
  private async schedule(): Promise<void> {
    const limits = this.limits(), protection = limits.protectionState();
    let businessAllowed = true;
    try { limits.assertCanStart(Date.now()); } catch { businessAllowed = false; }
    const deadline = businessAllowed ? row<{ time: number | null }>(this.ctx.storage, "SELECT MIN(deadline_at) AS time FROM queue_intents WHERE state = 'QUEUED'")?.time : null;
    const retry = businessAllowed ? row<{ time: number | null }>(this.ctx.storage, "SELECT MIN(retry_at) AS time FROM assignments WHERE state = 'COMMITTED' AND retry_at IS NOT NULL")?.time : null;
    const incidentRetry = protection.state === "BLOCKED" ? row<{ time: number | null }>(this.ctx.storage, "SELECT MIN(next_retry_at) AS time FROM d1_incident_propagation WHERE complete=0 AND attempts<3 AND version=?", protection.version)?.time : null;
    const job = new SqlSafetyStore(this.ctx.storage).get<ProtectionJob>(`protection-job:${protection.version}`);
    const connectionDeadline = this.ctx.getWebSockets().reduce<number | undefined>((nearest, socket) => {
      const attachment = socket.deserializeAttachment() as QueueAttachment | null;
      return attachment?.kind === "queue" && !attachment.closing ? Math.min(nearest ?? Infinity, attachment.expiresAt) : nearest;
    }, undefined);
    const candidates = [deadline, retry, incidentRetry, job?.nextAt, connectionDeadline].filter((value): value is number => typeof value === "number");
    if (candidates.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...candidates)));
    else await this.ctx.storage.deleteAlarm();
  }
  private async register(assignment: InstallAssignment): Promise<void> {
    if (!this.env.DB.batch) throw new ApiError("CAPABILITY_UNAVAILABLE", 503, "storage");
    const statements = [this.env.DB.prepare("INSERT INTO game_rooms (room_id,assignment_id,created_at) VALUES (?,?,?) ON CONFLICT(room_id) DO NOTHING").bind(assignment.roomId, assignment.assignmentId, Date.now())];
    for (const principal of assignment.members) statements.push(this.env.DB.prepare("INSERT INTO session_rooms (session_id,room_id) VALUES (?,?) ON CONFLICT DO NOTHING").bind(principal.id, assignment.roomId));
    await this.env.DB.batch(statements);
  }
  private async deliver(id: string): Promise<boolean> {
    const current = row<AssignmentRow>(this.ctx.storage, "SELECT * FROM assignments WHERE assignment_id = ?", id);
    if (!current || current.state === "CLOSED") return false;
    if (current.state === "ROOM_INSTALLED") return true;
    this.limits().assertCanStart(Date.now());
    if (current.attempts >= 6) throw new ApiError("INSTALLATION_UNAVAILABLE", 503, "matchmaking");
    const payload = JSON.parse(current.payload) as InstallAssignment;
    try {
      await internalJson(this.env.ROOMS, payload.roomId, { op: "install", assignment: payload });
      await this.register(payload);
      this.ctx.storage.sql.exec("UPDATE assignments SET state='ROOM_INSTALLED',retry_at=NULL WHERE assignment_id=? AND state='COMMITTED'", id);
      return true;
    } catch (error) {
      const attempts = current.attempts + 1;
      const retryAt = attempts < 6 ? Date.now() + [1_000, 5_000, 15_000, 60_000, 300_000][Math.min(attempts - 1, 4)]! : null;
      this.ctx.storage.sql.exec("UPDATE assignments SET attempts=?,retry_at=? WHERE assignment_id=? AND state='COMMITTED'", attempts, retryAt, id);
      throw error;
    } finally { await this.schedule(); }
  }
  private gamePool(game: FixedGame): string {
    const quota=this.limits().poolQuota(game.poolId ?? POOL_ID);
    if(game.executionClass && game.executionClass!==quota.executionClass)throw new ApiError("EXECUTION_CLASS_MISMATCH",409);
    return quota.poolId;
  }
  private async queue(principal: Principal, requestId: string, game: FixedGame): Promise<QueueView> {
    const now = Date.now(), requestDigest = await hash(`queue:${game.release.gameId}`), fixedGame = canonicalize(game);
    let intentId = "";
    this.ctx.storage.transactionSync(() => {
      this.expire(now);
      const previous = row<IntentRow>(this.ctx.storage, "SELECT * FROM queue_intents WHERE requester_id=? AND request_id=?", principal.id, requestId);
      if (previous) {
        if (previous.digest !== requestDigest) throw new ApiError("IDEMPOTENCY_CONFLICT", 409);
        intentId = previous.intent_id; return;
      }
      this.limits().assertCanStart(now);
      const pending = row<{ n: number }>(this.ctx.storage, "SELECT COUNT(*) n FROM queue_intents WHERE state='QUEUED'")!.n;
      const quota = this.limits().poolQuota(this.gamePool(game));
      if (pending >= MAX_PENDING_INTENTS) throw new ApiError("QUEUE_CAPACITY", 429);
      const minute = Math.floor(now / 60_000), day = Math.floor(now / 86_400_000);
      const cycle = (JSON.parse(this.env.SAFETY_POLICY_JSON!) as { values: { cycle: { id: string; startsAt: number; endsAt: number } } }).values.cycle;
      const cycleId = cycle.id;
      const oldCycle = row<{ cycle_id: string; starts_at: number; ends_at: number }>(this.ctx.storage, "SELECT * FROM queue_cycle_identity WHERE id=1");
      if (oldCycle && (oldCycle.cycle_id !== cycleId || oldCycle.starts_at !== cycle.startsAt || oldCycle.ends_at !== cycle.endsAt) &&
          (now < oldCycle.ends_at || cycle.startsAt < oldCycle.ends_at)) throw new ApiError("SAFETY_INVALID", 503);
      this.ctx.storage.sql.exec("INSERT INTO queue_cycle_identity VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET cycle_id=excluded.cycle_id,starts_at=excluded.starts_at,ends_at=excluded.ends_at", cycleId, cycle.startsAt, cycle.endsAt);
      for (const scope of ["global", principal.id]) {
        const usage = row<{ minute: number; minute_count: number; day: number; day_count: number; cycle_id: string; cycle_count: number }>(this.ctx.storage, "SELECT * FROM queue_resource_usage WHERE scope=?", scope);
        const minuteCount = usage?.minute === minute ? usage.minute_count : 0;
        const dayCount = usage?.day === day ? usage.day_count : 0;
        const cycleCount = usage?.cycle_id === cycleId ? usage.cycle_count : 0;
        if ((scope !== "global" && minuteCount >= MAX_SESSION_QUEUE_CREATES_MINUTE) || (scope === "global" && (minuteCount >= quota.maxCreatesPerMinute || dayCount >= quota.maxCreatesPerDay || cycleCount >= quota.maxCreatesPerCycle))) throw new ApiError("QUEUE_RATE_LIMIT", 429);
        this.ctx.storage.sql.exec("INSERT INTO queue_resource_usage VALUES (?,?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET minute=excluded.minute,minute_count=excluded.minute_count,day=excluded.day,day_count=excluded.day_count,cycle_id=excluded.cycle_id,cycle_count=excluded.cycle_count", scope, minute, minuteCount + 1, day, dayCount + 1, cycleId, cycleCount + 1);
      }
      intentId = `qi:${this.gamePool(game)}:${crypto.randomUUID()}`;
      this.ctx.storage.sql.exec("INSERT INTO queue_intents VALUES (?,?,?,?,?,?, 'QUEUED',1,1,?,?,NULL)", intentId, principal.id, requestId, requestDigest, JSON.stringify(principal), fixedGame, now, now + game.policy.queueWaitMs);
      const other = row<IntentRow>(this.ctx.storage, "SELECT * FROM queue_intents WHERE state='QUEUED' AND requester_id<>? AND deadline_at>? AND game=? ORDER BY created_at,intent_id LIMIT 1", principal.id, now, fixedGame);
      if (!other) return;
      const own = this.intent(intentId);
      // The assignment payload is immutable; one intention can only occur in one assignment.
      if (own.state !== "QUEUED" || own.owner_epoch !== 1 || other.owner_epoch !== 1) throw new ApiError("REVISION_CONFLICT", 409);
      const assignment: InstallAssignment = { assignmentId: crypto.randomUUID(), roomId: crypto.randomUUID(), matchId: crypto.randomUUID(), game, members: [JSON.parse(other.principal) as Principal, principal] };
      this.limits().reserveAssignment({ assignmentId: assignment.assignmentId, poolId: this.gamePool(game), now, activityMs: 0 }, () => {
        this.ctx.storage.sql.exec("INSERT INTO assignments VALUES (?,?,?,?, 'COMMITTED',0,?)", assignment.assignmentId, assignment.roomId, assignment.matchId, JSON.stringify(assignment), now);
        this.ctx.storage.sql.exec("INSERT INTO room_cleanup_registry VALUES (?,?,0)", assignment.assignmentId, assignment.roomId);
        for (const intent of [other, own]) {
          this.ctx.storage.sql.exec("INSERT INTO assigned_intents VALUES (?,?)", intent.intent_id, assignment.assignmentId);
          this.ctx.storage.sql.exec("UPDATE queue_intents SET state='ASSIGNED', revision=revision+1, assignment_id=? WHERE intent_id=? AND state='QUEUED' AND revision=? AND owner_epoch=?", assignment.assignmentId, intent.intent_id, intent.revision, intent.owner_epoch);
        }
      });
    });
    const current = this.intent(intentId);
    if (current.assignment_id) await this.deliver(current.assignment_id);
    await this.schedule();
    this.notifyQueueSockets();
    return this.view(this.intent(intentId));
  }
  private async create(principal: Principal, requestId: string, game: FixedGame): Promise<{ roomId: string }> {
    const scope = `create:${principal.id}`, digest = await hash(`create:${game.release.gameId}`);
    let assignmentId = "";
    this.ctx.storage.transactionSync(() => {
      const previous = row<{ digest: string; response: string }>(this.ctx.storage, "SELECT digest,response FROM pool_commands WHERE scope=? AND request_id=?", scope, requestId);
      if (previous) {
        if (previous.digest !== digest) throw new ApiError("IDEMPOTENCY_CONFLICT", 409);
        assignmentId = (JSON.parse(previous.response) as { assignmentId: string }).assignmentId; return;
      }
      const assignment: InstallAssignment = { assignmentId: crypto.randomUUID(), roomId: crypto.randomUUID(), matchId: crypto.randomUUID(), game, members: [principal] };
      assignmentId = assignment.assignmentId;
      this.limits().reserveAssignment({ assignmentId, poolId: this.gamePool(game), now: Date.now(), activityMs: 0 }, () => {
        this.ctx.storage.sql.exec("INSERT INTO assignments VALUES (?,?,?,?, 'COMMITTED',0,?)", assignmentId, assignment.roomId, assignment.matchId, JSON.stringify(assignment), Date.now());
        this.ctx.storage.sql.exec("INSERT INTO room_cleanup_registry VALUES (?,?,0)", assignmentId, assignment.roomId);
        this.ctx.storage.sql.exec("INSERT INTO pool_commands VALUES (?,?,?,?)", scope, requestId, digest, JSON.stringify({ assignmentId }));
      });
    });
    await this.deliver(assignmentId);
    return { roomId: row<AssignmentRow>(this.ctx.storage, "SELECT * FROM assignments WHERE assignment_id=?", assignmentId)!.room_id };
  }
  async fetch(request: Request): Promise<Response> {
    try {
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return this.watchQueue(request);
      if (request.method !== "POST") throw new ApiError("METHOD_NOT_ALLOWED", 405);
      if (new URL(request.url).pathname === "/resources/r2-read") {
        const body = await request.json() as Record<string, unknown>;
        if (!body || Object.keys(body).length) throw new ApiError("INVALID_REQUEST", 400);
        return reply({ reads: this.limits().consumeR2Read(Date.now()) });
      }
      if (new URL(request.url).pathname.startsWith("/safety/")) return await this.manageSafety(request);
      const body = await request.json() as Record<string, unknown>;
      if (body["op"] === "cleanup-complete") {
        checkId(body["assignmentId"]);
        const assignment = row<AssignmentRow>(this.ctx.storage, "SELECT * FROM assignments WHERE assignment_id=?", body["assignmentId"]);
        if (!assignment || assignment.state !== "CLOSED") throw new ApiError("ASSIGNMENT_ACTIVE", 409);
        const observed = await internalJson<{ stopped: boolean; unfinishedCleanup: boolean }>(this.env.ROOMS, assignment.room_id, { op: "safety-status" });
        if (observed.stopped && !observed.unfinishedCleanup) this.ctx.storage.sql.exec("UPDATE room_cleanup_registry SET cleanup_complete=1 WHERE assignment_id=?", assignment.assignment_id);
        return reply({ cleaned: observed.stopped && !observed.unfinishedCleanup });
      }
      if (body["op"] === "close") {
        const assignmentId = body["assignmentId"]; checkId(assignmentId);
        const assignment = row<AssignmentRow>(this.ctx.storage, "SELECT * FROM assignments WHERE assignment_id=?", assignmentId);
        if (!assignment) throw new ApiError("ASSIGNMENT_NOT_FOUND", 404);
        const installed = JSON.parse(assignment.payload) as InstallAssignment;
        // Never free capacity because a client or heartbeat merely claims the room ended.
        const confirmation = await internalJson<{ terminal: boolean }>(this.env.ROOMS, installed.roomId, { op: "terminal", assignmentId });
        if (!confirmation.terminal) throw new ApiError("ROOM_ACTIVE", 409);
        this.ctx.storage.transactionSync(() => {
          this.limits().releaseAssignment({ assignmentId, terminal: "CLOSED", now: Date.now() });
          this.ctx.storage.sql.exec("UPDATE assignments SET state='CLOSED',retry_at=NULL WHERE assignment_id=?", assignmentId);
        });
        return reply({ closed: true });
      }
      if (body["op"] === "revoke-queue-session") {
        if (Object.keys(body).some(key => key !== "op" && key !== "sessionId")) throw new ApiError("INVALID_REQUEST", 400);
        checkId(body["sessionId"]);
        this.ctx.storage.transactionSync(() => { this.ctx.storage.sql.exec("UPDATE queue_intents SET state='CANCELLED',revision=revision+1 WHERE requester_id=? AND state='QUEUED'", body["sessionId"] as string); });
        this.notifyQueueSockets(); await this.schedule(); return reply({ cancelled: true });
      }
      checkPrincipal(body["principal"]); const principal = body["principal"];
      const op = body["op"];
      if (op === "create" || op === "queue") {
        checkId(body["requestId"]);
        const game = body["game"] as FixedGame;
        if (!game?.release || game.release.gameId !== "connect-four" || game.release.profile.id !== "server-turn") throw new ApiError("RELEASE_INCOMPATIBLE", 409);
        return reply(op === "create" ? await this.create(principal, body["requestId"], game) : await this.queue(principal, body["requestId"], game));
      }
      checkId(body["intentId"]); let intent = this.intent(body["intentId"]);
      if (intent.requester_id !== principal.id) throw new ApiError("FORBIDDEN", 403);
      if (op === "cancel") {
        checkId(body["requestId"]); const scope = `cancel:${intent.intent_id}`, digest = await hash(JSON.stringify({ expectedRevision: body["expectedRevision"] }));
        this.ctx.storage.transactionSync(() => {
          const previous = row<{ digest: string; response: string }>(this.ctx.storage, "SELECT digest,response FROM pool_commands WHERE scope=? AND request_id=?", scope, body["requestId"] as string);
          if (previous) { if (previous.digest !== digest) throw new ApiError("IDEMPOTENCY_CONFLICT", 409); return; }
          intent = this.intent(intent.intent_id);
          if (intent.state === "QUEUED") {
            if (body["expectedRevision"] !== intent.revision) throw new ApiError("REVISION_CONFLICT", 409);
            this.ctx.storage.sql.exec("UPDATE queue_intents SET state='CANCELLED',revision=revision+1 WHERE intent_id=?", intent.intent_id);
          }
          this.ctx.storage.sql.exec("INSERT INTO pool_commands VALUES (?,?,?,?)", scope, body["requestId"] as string, digest, JSON.stringify(this.view(this.intent(intent.intent_id))));
        });
      } else if (op !== "status") throw new ApiError("NOT_FOUND", 404);
      this.expire(Date.now()); intent = this.intent(intent.intent_id);
      if (intent.assignment_id) await this.deliver(intent.assignment_id);
      this.notifyQueueSockets(); await this.schedule(); return reply(this.view(this.intent(intent.intent_id)));
    } catch (error) { return failure(error); }
  }
  private async safetyRoomCall<T>(roomId: string, value: unknown): Promise<T> {
    if (!this.env.ROOMS) throw new ApiError("CAPABILITY_UNAVAILABLE", 503);
    const response = await this.env.ROOMS.get(this.env.ROOMS.idFromName(roomId)).fetch(new Request("https://platform.internal/", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value), signal: AbortSignal.timeout(750),
    }));
    const body = await response.json() as T & { error?: { code?: string } };
    if (!response.ok) throw new ApiError(body.error?.code ?? "CONTROL_UNAVAILABLE", response.status);
    return body;
  }
  private queueSocketCount(): number {
    return this.ctx.getWebSockets().filter(socket => { const meta = socket.deserializeAttachment() as QueueAttachment | null; return meta?.kind === "queue" && !meta.closing; }).length;
  }
  private closeQueueSocket(socket: ServerSocket, code: number, reason: string): void {
    const meta = socket.deserializeAttachment() as QueueAttachment | null;
    if (meta?.closing) return;
    if (meta) { meta.closing = true; socket.serializeAttachment(meta); }
    try { socket.close(code, reason); } catch { /* Exact connection only. */ }
  }
  private watchQueue(request: Request): Response {
    const match = /^\/queue\/([^/]+)\/socket$/.exec(new URL(request.url).pathname);
    if (!match || request.headers.get("Origin") !== this.env.SHELL_ORIGIN) throw new ApiError("ORIGIN_REJECTED", 403);
    let principal: unknown;
    try { principal = JSON.parse(request.headers.get("X-PWA-Principal") ?? "null"); } catch { throw new ApiError("AUTH_REQUIRED", 401); }
    checkPrincipal(principal);
    let intentId: string; try { intentId = decodeURIComponent(match[1]!); } catch { throw new ApiError("INVALID_REQUEST", 400); }
    checkId(intentId); const intent = this.intent(intentId);
    if (intent.requester_id !== principal.id) throw new ApiError("FORBIDDEN", 403);
    if (this.queueSocketCount() >= MAX_PENDING_INTENTS) throw new ApiError("SOCKET_LIMIT", 429);
    const Pair = (globalThis as unknown as { WebSocketPair: new () => { 0: ServerSocket; 1: ServerSocket } }).WebSocketPair;
    const pair = new Pair(); this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ kind: "queue", intentId, sessionId: principal.id, expiresAt: Math.min(principal.expiresAt, intent.deadline_at) } satisfies QueueAttachment);
    for (const old of this.ctx.getWebSockets()) { const meta = old.deserializeAttachment() as QueueAttachment | null; if (old !== pair[1] && meta?.kind === "queue" && meta.intentId === intentId) this.closeQueueSocket(old, 4001, "WATCH_REPLACED"); }
    this.expire(Date.now()); this.notifyQueueSockets(); this.ctx.waitUntil(this.schedule());
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }
  /** Only revisions/status changes are pushed; no polling, heartbeats or timers. */
  private notifyQueueSockets(): void {
    for (const socket of this.ctx.getWebSockets()) {
      const meta = socket.deserializeAttachment() as QueueAttachment | null;
      if (meta?.kind !== "queue" || meta.closing) continue;
      try {
        const intent = this.intent(meta.intentId);
        if (intent.requester_id !== meta.sessionId || meta.expiresAt <= Date.now() && intent.state === "QUEUED" && intent.deadline_at > Date.now()) { this.closeQueueSocket(socket, 4003, "AUTH_EXPIRED"); continue; }
        const view = this.view(intent);
        if (meta.lastRevision !== view.revision || meta.lastStatus !== view.status) {
          socket.send(JSON.stringify({ type: "QUEUE_STATE", body: view })); meta.lastRevision = view.revision; meta.lastStatus = view.status; socket.serializeAttachment(meta);
        }
        if (view.status !== "QUEUED") this.closeQueueSocket(socket, 1000, "QUEUE_FINISHED");
      } catch { this.closeQueueSocket(socket, 4004, "QUEUE_UNAVAILABLE"); }
    }
  }
  async webSocketMessage(socket: ServerSocket): Promise<void> { this.closeQueueSocket(socket, 4003, "QUEUE_CLIENT_MESSAGE_REJECTED"); await this.schedule(); }
  async webSocketClose(_socket: ServerSocket): Promise<void> { await this.schedule(); }
  async webSocketError(socket: ServerSocket): Promise<void> { this.closeQueueSocket(socket, 4003, "QUEUE_CONNECTION_ERROR"); await this.schedule(); }
  async alarm(): Promise<void> {
    const protection = this.limits().protectionState();
    const job = new SqlSafetyStore(this.ctx.storage).get<ProtectionJob>(`protection-job:${protection.version}`);
    const pendingIncident = protection.state === "BLOCKED" ? row<IncidentPropagation>(this.ctx.storage, "SELECT * FROM d1_incident_propagation WHERE complete=0 AND next_retry_at<=? AND version=? LIMIT 1", Date.now(), protection.version) : undefined;
    if (pendingIncident) await this.propagateD1Incident(pendingIncident.version);
    else if (job?.nextAt !== null && job?.nextAt !== undefined && job.nextAt <= Date.now()) await this.advanceProtectionJob(protection);
    try { this.limits().assertCanStart(Date.now()); } catch { await this.schedule(); return; }
    this.expire(Date.now()); this.notifyQueueSockets();
    const pending = this.ctx.storage.sql.exec<AssignmentRow>("SELECT * FROM assignments WHERE state='COMMITTED' AND retry_at<=? ORDER BY retry_at LIMIT 4", Date.now()).toArray();
    for (const assignment of pending) {
      try { await this.deliver(assignment.assignment_id); } catch { /* Persistent attempt budget and next deadline are already recorded. */ }
    }
    this.notifyQueueSockets(); await this.schedule();
  }
  private async observeSafety(cursor?: string, channel = "management"): Promise<Record<string, unknown>> {
    const protection = this.limits().protectionState(), store = new SqlSafetyStore(this.ctx.storage), scanKey = `observation:${channel}`;
    let scan = store.get<ObservationScan>(scanKey);
    if (cursor !== undefined) {
      if (!scan || scan.version !== protection.version || !/^[a-f0-9-]{36}:[a-f0-9-]{36}$/.test(cursor)) throw new ApiError("OBSERVATION_CURSOR_INVALID", 409);
      if (scan.lastInput === cursor && scan.lastResult) return scan.lastResult;
      if (cursor !== `${scan.id}:${scan.cursor}`) throw new ApiError("OBSERVATION_CURSOR_STALE", 409);
    } else {
      scan = { id: crypto.randomUUID(), version: protection.version, cursor: "", activeConnections: 0, backgroundTasks: 0, stopped: true, observedRooms: 0, unknownRooms: 0, lastInput: null, lastResult: null };
    }
    const current = scan!;
    const assignments = this.ctx.storage.sql.exec<AssignmentRow>(`SELECT a.* FROM assignments a JOIN room_cleanup_registry r ON r.assignment_id=a.assignment_id
      WHERE r.cleanup_complete=0 AND a.assignment_id>? ORDER BY a.assignment_id LIMIT ?`, current.cursor, SAFETY_PAGE_SIZE + 1).toArray();
    const page = assignments.slice(0, SAFETY_PAGE_SIZE), rooms: Record<string, unknown>[] = [];
    for (const assignment of page) {
      try {
        const observed = await this.safetyRoomCall<{ activeConnections: number; backgroundTasks: number; stopped: boolean; unfinishedCleanup: boolean }>(assignment.room_id, { op: "safety-status" });
        rooms.push({ roomId: assignment.room_id, observed: observed.stopped ? "STOPPED" : "ACTIVE", ...observed });
        current.activeConnections += observed.activeConnections; current.backgroundTasks += observed.backgroundTasks; current.stopped &&= observed.stopped && !observed.unfinishedCleanup;
        if (assignment.state === "CLOSED" && observed.stopped && !observed.unfinishedCleanup) this.ctx.storage.sql.exec("UPDATE room_cleanup_registry SET cleanup_complete=1 WHERE assignment_id=?", assignment.assignment_id);
      } catch (error) { current.unknownRooms += 1; current.stopped = false; rooms.push({ roomId: assignment.room_id, observed: "UNKNOWN", error: (error as { code?: string }).code ?? "CONTROL_UNAVAILABLE" }); }
      current.observedRooms += 1; current.cursor = assignment.assignment_id;
    }
    const pending = row<{ n: number }>(this.ctx.storage, "SELECT COUNT(*) n FROM assignments WHERE state='COMMITTED' AND retry_at IS NOT NULL")!.n;
    const remaining = row<{ n: number }>(this.ctx.storage, `SELECT COUNT(*) n FROM room_cleanup_registry WHERE cleanup_complete=0 AND assignment_id>?`, current.cursor)!.n;
    const complete = remaining === 0 && assignments.length <= SAFETY_PAGE_SIZE;
    const job = store.get<ProtectionJob>(`protection-job:${protection.version}`);
    const result: Record<string, unknown> = { version: protection.version, state: protection.state,
      newAllocationsBlocked: protection.state === "BLOCKED" || protection.state === "DRAINING" || protection.validUntil <= Date.now(),
      activeConnections: current.activeConnections + this.queueSocketCount(), backgroundTasks: pending + current.backgroundTasks,
      roomsObservedStopped: complete && current.unknownRooms === 0 && current.stopped,
      unobservedRooms: remaining + current.unknownRooms, rooms,
      observation: { scanId: current.id, nextCursor: complete ? null : `${current.id}:${current.cursor}`, complete, pageSize: SAFETY_PAGE_SIZE, observedRooms: current.observedRooms, scope: "Sequential bounded scan; counts are conservative observations, not an atomic global snapshot" },
      propagationPending: job !== undefined && job.phase !== "COMPLETE" && job.phase !== "FAILED",
      propagationFailed: job?.phase === "FAILED",
      incidentPropagation: row<IncidentPropagation>(this.ctx.storage, "SELECT * FROM d1_incident_propagation ORDER BY version DESC LIMIT 1") ?? null,
      incidentSource: store.get(`d1-incident-source:${protection.version}`) ?? null };
    current.lastInput = cursor ?? null; current.lastResult = result; store.put(scanKey, current);
    return result;
  }
  private async manageSafety(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname, body = await request.json() as Record<string, unknown>;
    if (path === "/safety/status") {
      if (Object.keys(body).some(key => key !== "cursor") || (body["cursor"] !== undefined && typeof body["cursor"] !== "string")) throw new ApiError("INVALID_REQUEST", 400);
      return reply(await this.observeSafety(body["cursor"] as string | undefined));
    }
    if (path === "/safety/incident") {
      if (Object.keys(body).some(key => key !== "reason" && key !== "incident") || body["reason"] !== "D1_SAFETY_INCIDENT") throw new ApiError("INVALID_REQUEST", 400);
      let incident: D1SafetyIncident | undefined;
      if (body["incident"] !== undefined) {
        const candidate = body["incident"] as Record<string, unknown>;
        const keys = ["reason", "category", "scope", "persisted", "detectedAt", "recoveryVersion"];
        if (!candidate || typeof candidate !== "object" || Object.keys(candidate).length !== keys.length || keys.some(key => !Object.hasOwn(candidate, key)) ||
            candidate["reason"] !== "D1_SAFETY_INCIDENT" || !["DAILY_QUOTA", "USAGE_UNKNOWN", "SCAN_BOUND"].includes(String(candidate["category"])) || candidate["scope"] !== D1_SAFETY_SCOPE ||
            typeof candidate["persisted"] !== "boolean" || !Number.isSafeInteger(candidate["detectedAt"]) || (candidate["detectedAt"] as number) < 0 ||
            (candidate["recoveryVersion"] !== null && (!Number.isSafeInteger(candidate["recoveryVersion"]) || (candidate["recoveryVersion"] as number) < 0))) throw new ApiError("INVALID_REQUEST", 400);
        incident = candidate as unknown as D1SafetyIncident;
      }
      return reply(await this.handleD1Incident(incident));
    }
    if (path !== "/safety/apply" && path !== "/safety/recover") throw new ApiError("NOT_FOUND", 404);
    const protection = body["protection"] as ProtectionState;
    if (path === "/safety/recover") {
      this.ctx.storage.transactionSync(() => {
        this.limits().recoverProtection(protection, body["authorization"] as RecoveryAuthorization);
        if (this.limits().protectionState().version === protection.version) this.ctx.storage.sql.exec("INSERT INTO pool_manual_recovery VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,recovered_at=excluded.recovered_at WHERE excluded.version>pool_manual_recovery.version", protection.version, Date.now());
        this.ctx.storage.sql.exec("UPDATE d1_incident_propagation SET next_retry_at=NULL WHERE version<?", protection.version);
      });
    }
    else this.limits().applyProtection(protection);
    const accepted = this.limits().protectionState();
    this.ensureProtectionJob(accepted, path === "/safety/recover" ? body["authorization"] as RecoveryAuthorization : undefined);
    const job = await this.advanceProtectionJob(accepted);
    await this.schedule();
    return reply({ ...await this.observeSafety(), propagationFailures: job.failures, propagationPending: job.phase !== "COMPLETE" && job.phase !== "FAILED" });
  }
  private ensureProtectionJob(accepted: ProtectionState, authorization?: RecoveryAuthorization): ProtectionJob {
    const store = new SqlSafetyStore(this.ctx.storage), key = `protection-job:${accepted.version}`, existing = store.get<ProtectionJob>(key);
    if (existing) return existing;
    if (accepted.state === "BLOCKED" || accepted.state === "DRAINING") {
      this.ctx.storage.sql.exec("UPDATE queue_intents SET state='CANCELLED',revision=revision+1 WHERE state='QUEUED'");
      this.ctx.storage.sql.exec("UPDATE assignments SET retry_at=NULL WHERE state='COMMITTED'");
      this.notifyQueueSockets();
    }
    const job: ProtectionJob = { version: accepted.version, phase: "PROPAGATING", cursor: "", observationCursor: null, pass: 1, failures: [], nextAt: Date.now(), ...(authorization ? { authorization } : {}) };
    store.put(key, job); return job;
  }
  /** One invocation fans out to at most eight rooms. Persistent progress survives
   * eviction; three complete passes bound retries rather than truncating at 24 rooms. */
  private async advanceProtectionJob(accepted: ProtectionState): Promise<ProtectionJob> {
    if (this.protectionWork) {
      const previous = await this.protectionWork;
      return previous.version === accepted.version ? previous : this.advanceProtectionJob(accepted);
    }
    const work = this.performProtectionJob(accepted); this.protectionWork = work;
    try { return await work; } finally { if (this.protectionWork === work) this.protectionWork = undefined; }
  }
  private async performProtectionJob(accepted: ProtectionState): Promise<ProtectionJob> {
    const store = new SqlSafetyStore(this.ctx.storage), key = `protection-job:${accepted.version}`;
    const job = store.get<ProtectionJob>(key) ?? this.ensureProtectionJob(accepted);
    if (job.phase === "COMPLETE" || job.phase === "FAILED") return job;
    if (job.version !== this.limits().protectionState().version) { job.phase = "FAILED"; job.nextAt = null; store.put(key, job); return job; }
    if (job.phase === "PROPAGATING") {
      const assignments = this.ctx.storage.sql.exec<AssignmentRow>("SELECT * FROM assignments WHERE state<>'CLOSED' AND assignment_id>? ORDER BY assignment_id LIMIT ?", job.cursor, SAFETY_PAGE_SIZE + 1).toArray();
      for (const assignment of assignments.slice(0, SAFETY_PAGE_SIZE)) {
        try {
          if (accepted.state === "BLOCKED" && assignment.state === "COMMITTED") {
            await this.safetyRoomCall(assignment.room_id, { op: "close-assignment", assignmentId: assignment.assignment_id });
            this.ctx.storage.transactionSync(() => { this.limits().releaseAssignment({ assignmentId: assignment.assignment_id, terminal: "REVOKED", now: Date.now() }); this.ctx.storage.sql.exec("UPDATE assignments SET state='CLOSED' WHERE assignment_id=?", assignment.assignment_id); });
          } else await this.safetyRoomCall(assignment.room_id, { op: "safety-apply", protection: accepted, ...(job.authorization ? { authorization: job.authorization } : {}) });
        } catch { job.failures.push(assignment.room_id); }
        job.cursor = assignment.assignment_id;
      }
      if (assignments.length > SAFETY_PAGE_SIZE) job.nextAt = Date.now() + 100;
      else { job.phase = "OBSERVING"; job.nextAt = Date.now(); }
    }
    if (job.phase === "OBSERVING") {
      const observed = await this.observeSafety(job.observationCursor ?? undefined, `job:${accepted.version}`);
      job.lastObservation = observed;
      const page = observed["observation"] as { nextCursor: string | null; complete: boolean };
      job.observationCursor = page.nextCursor;
      if (!page.complete) job.nextAt = Date.now() + 100;
      else if (accepted.state === "BLOCKED" ? observed["roomsObservedStopped"] === true && observed["activeConnections"] === 0 && observed["backgroundTasks"] === 0 && job.failures.length === 0 : observed["unobservedRooms"] === 0 && job.failures.length === 0) { job.phase = "COMPLETE"; job.nextAt = null; }
      else if (job.pass < 3) { job.pass += 1; job.phase = "PROPAGATING"; job.cursor = ""; job.observationCursor = null; job.failures = []; job.nextAt = Date.now() + [1_000, 5_000][job.pass - 2]!; }
      else { job.phase = "FAILED"; job.nextAt = null; }
    }
    store.put(key, job); return job;
  }
  /** Incident work never calls this pool through RPC or waits on the reporting Room. */
  private async handleD1Incident(incident?: D1SafetyIncident): Promise<Record<string, unknown>> {
    const data = await d1SafetyStatus(this.env.DB);
    const recovered = row<{ version: number }>(this.ctx.storage, "SELECT version FROM pool_manual_recovery WHERE id=1");
    const current = this.limits().protectionState();
    // Recovery first unlocks the durable D1 ledger, then advances this owner's
    // version. An old provider read/notification cannot undo that manual action.
    if (incident?.recoveryVersion !== null && incident?.recoveryVersion !== undefined && data.state === "NORMAL" && data.recoveryVersion !== null &&
        data.recoveryVersion > incident.recoveryVersion && current.state === "NORMAL" && recovered && recovered.version >= data.recoveryVersion) {
      return { ignored: true, reason: "D1_RECOVERY_ALREADY_OBSERVED", version: current.version, state: current.state };
    }
    if (incident?.recoveryVersion !== null && incident?.recoveryVersion !== undefined && data.recoveryVersion !== null && recovered &&
        recovered.version > data.recoveryVersion && recovered.version > incident.recoveryVersion && current.state === "NORMAL") return { ignored: true, reason: "STALE_D1_INCIDENT", version: current.version, state: current.state };
    let accepted: ProtectionState;
    this.ctx.storage.transactionSync(() => {
      const limits = this.limits(), protection = limits.protectionState();
      if (protection.state !== "BLOCKED") {
        const configuration = JSON.parse(this.env.SAFETY_POLICY_JSON!) as { values: { cycle: { endsAt: number } } };
        const now = Date.now();
        limits.applyProtection({ version: protection.version + 1, environment: this.env.APP_ENV, scope: "gameplay", state: "BLOCKED", reason: "D1_SAFETY_INCIDENT",
          issuedAt: Math.min(now, configuration.values.cycle.endsAt - 1), validUntil: configuration.values.cycle.endsAt,
          drainUntil: null, operator: "d1-safety-bridge", incidentId: `d1:${protection.version + 1}` });
      }
      accepted = limits.protectionState();
      this.ctx.storage.sql.exec("INSERT INTO d1_incident_propagation(version,attempts,next_retry_at,complete,last_observation) VALUES (?,0,?,0,NULL) ON CONFLICT(version) DO NOTHING", accepted.version, Date.now());
      new SqlSafetyStore(this.ctx.storage).put(`d1-incident-source:${accepted.version}`, { incident: incident ?? null, dataState: data.state,
        confirmation: data.state === "BLOCKED" && incident?.persisted === true ? "DURABLE_DATA_LOCK" : "UNCONFIRMED_FAIL_CLOSED" });
    });
    // Return the private acknowledgement after durable lock, before fanout. This
    // breaks Room -> pool -> Room reentrancy and keeps guard callbacks bounded.
    this.ctx.waitUntil(this.propagateD1Incident(accepted!.version));
    return { ignored: false, version: accepted!.version, state: "BLOCKED", propagationScheduled: true, dataState: data.state,
      incidentConfirmation: data.state === "BLOCKED" && incident?.persisted === true ? "DURABLE_DATA_LOCK" : "UNCONFIRMED_FAIL_CLOSED" };
  }
  private async propagateD1Incident(version: number): Promise<void> {
    if (this.incidentPropagation) { await this.incidentPropagation; return this.propagateD1Incident(version); }
    const work = async (): Promise<void> => {
      const record = row<IncidentPropagation>(this.ctx.storage, "SELECT * FROM d1_incident_propagation WHERE version=?", version);
      const accepted = this.limits().protectionState();
      if (!record || record.complete) return;
      if (accepted.version !== version || accepted.state !== "BLOCKED") {
        this.ctx.storage.sql.exec("UPDATE d1_incident_propagation SET next_retry_at=NULL WHERE version=?", version); return;
      }
      this.ensureProtectionJob(accepted);
      const job = await this.advanceProtectionJob(accepted);
      const observation = job.lastObservation ?? {};
      const complete = job.phase === "COMPLETE";
      this.ctx.storage.sql.exec("UPDATE d1_incident_propagation SET attempts=?,complete=?,next_retry_at=?,last_observation=? WHERE version=?", (job.phase === "PROPAGATING" && job.cursor === "" ? job.pass - 1 : job.pass), complete ? 1 : 0,
        job.phase !== "FAILED" && !complete ? job.nextAt : null,
        JSON.stringify({ failures: job.failures, roomsObservedStopped: observation["roomsObservedStopped"], unobservedRooms: observation["unobservedRooms"], activeConnections: observation["activeConnections"], backgroundTasks: observation["backgroundTasks"] }), version);
      await this.schedule();
    };
    const promise = work(); this.incidentPropagation = promise;
    try { await promise; } finally { this.incidentPropagation = undefined; }
  }
}
