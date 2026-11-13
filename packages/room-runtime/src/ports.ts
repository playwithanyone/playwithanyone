import type { LinkDescriptor, CommandOutcome } from "../../protocol/src/control.js";
export type Seat = "red" | "yellow";
export type ExecutionClass = "hibernated-turn" | "p2p-signaling" | "realtime-tick";
export interface RuntimePrincipal { readonly id: string; readonly playerId: string; readonly expiresAt: number }
export interface RuntimeGame {
  readonly poolOwnerId?: string;
  readonly release: { readonly gameId: string; readonly gameBuildId: string; readonly frameOrigin: string; readonly entryUrl: string; readonly profile: { readonly id: string; readonly version: number } };
  readonly policyBinding: unknown;
  readonly policy: { readonly disconnectGraceMs: number; readonly [key: string]: unknown };
}
export interface RuntimeMember {
  seatId: Seat; playerId: string; sessionId: string; sessionExpiresAt: number; seatEpoch: number;
  resourcesReady: boolean; baselineReady: boolean; prepared: boolean; connected: boolean;
  disconnectedUntil: number | null; nextCommandSeq: number; descriptor: LinkDescriptor | null;
}
export interface RuntimeConnectionMeta {
  readonly connectionId: string; readonly principal: RuntimePrincipal; readonly openedAt: number;
  authenticated: boolean; bound: boolean; seatId?: Seat; descriptorId?: string; lastSentStateSeq?: number;
  outboundBytes?: number; closing?: boolean; uplinkPackets?: number; uplinkBytes?: number;
}
export interface RuntimeReceipt { seatId: Seat; logicalStreamId: string; seq: number; digest: string; outcome: CommandOutcome }
export interface RuntimeHttpReceipt { sessionId: string; requestId: string; kind: "join" | "ready"; digest: string }
export interface RoomRuntimeMetadata {
  schemaVersion: 1; executionClass: ExecutionClass;
  turnDeadlineAt: number | null; hardDeadlineAt: number | null; winner: Seat | null;
  /** Optional only for checkpoints produced before remaining-time preservation. */
  pausedTurnRemainingMs?: number | null;
  terminationReason: "CONNECTED_FOUR" | "DRAW" | "TURN_TIMEOUT" | "DISCONNECTED" | "SERVICE_INTERRUPTED" | "ROOM_TTL" | null;
  authorizationVersions: Record<string, number>;
  consumedTickets: Record<string, { connectionId: string; sessionId: string; expiresAt: number }>;
  receipts: RuntimeReceipt[]; httpReceipts: RuntimeHttpReceipt[];
  connectionMetrics: Record<string, { packets: number; bytes: number }>;
}
export interface RuntimeRoomRecord<State = unknown> {
  roomId: string; matchId: string; assignmentId: string; installDigest: string; game: RuntimeGame;
  phase: "PREPARING" | "RUNNING" | "TERMINAL"; revision: number; stateSeq: number; rules: State;
  members: RuntimeMember[]; createdAt: number; result: "WIN" | "DRAW" | "DISCONNECTED" | "SERVICE_INTERRUPTED" | null;
  resultPending: boolean; resultAttempts: number; resultRetryAt: number | null; cleanupDeadlineAt: number | null;
  grantKey: string; safetyStopped: boolean; runtime?: RoomRuntimeMetadata;
}
export interface RuntimeAssignment { roomId: string; matchId: string; assignmentId: string; game: RuntimeGame; members: readonly RuntimePrincipal[] }
export interface VerifiedJoin {
  readonly principal: RuntimePrincipal; readonly seat: Seat; readonly seatEpoch: number;
  readonly authorizationVersion: number; readonly jti: string; readonly expiresAtMs: number;
}
export interface TransportPort {
  listConnections(): readonly string[];
  send(connId: string, payload: Uint8Array, format?: "text" | "binary"): void;
  broadcast(payload: Uint8Array, excludeConnId?: string, format?: "text" | "binary"): void;
  close(connId: string, code: number, reason: string): void;
  setConnMeta(connId: string, meta: RuntimeConnectionMeta): void;
  getConnMeta(connId: string): RuntimeConnectionMeta | undefined;
}
export interface WakeupSchedulerPort {
  setWakeupDeadline(timestampMs: number): Promise<void> | void;
  clearWakeupDeadline(): Promise<void> | void;
}
export interface TickSchedulerPort {
  startTickLoop(hz: number, onTick: () => void): void;
  stopTickLoop(): void;
}
export interface SchedulerPort extends WakeupSchedulerPort, TickSchedulerPort {}
/** Save and all authority/receipt changes must be committed atomically by the host. */
export interface CheckpointPort<State = unknown> {
  loadSnapshot(): RuntimeRoomRecord<State> | undefined;
  saveSnapshot(data: RuntimeRoomRecord<State>): void;
  clear(): void;
  transaction<T>(callback: () => T): T;
}
export interface RoomFinalReport<State = unknown> {
  schemaVersion: 1; roomId: string; matchId: string; assignmentId: string; gameId: string; releaseHash: string;
  executionClass: ExecutionClass; result: NonNullable<RuntimeRoomRecord["result"]>; winner: Seat | null;
  reason: RoomRuntimeMetadata["terminationReason"]; createdAt: number; endedAt: number; lifetimeMs: number;
  uplinkPackets: number; uplinkBytes: number;
  /** Trusted host-only snapshot. It must never be forwarded directly to players. */
  snapshot: RuntimeRoomRecord<State>;
}
export interface ResultSinkPort<State = unknown> { finalizeRoom(summary: RoomFinalReport<State>): Promise<void> }
export interface ServerRuleModule<State = unknown, Command = unknown> {
  create(): State; parseCommand(value: unknown): Command; applyCommand(state: State, seat: Seat, command: Command): State;
  project(state: State, seat: Seat | null): Record<string, unknown>;
  evaluateResult(state: State): { kind: "WIN"; winner: Seat } | { kind: "DRAW" } | null;
}
export interface RuleLoaderPort<State = unknown> { loadServerRules(releaseHash: string, gameId: string): ServerRuleModule<State> }
export interface RoomRuntimePorts<State = unknown> {
  transport: TransportPort; scheduler: SchedulerPort; checkpoint: CheckpointPort<State>;
  results: ResultSinkPort<State>; rules: RuleLoaderPort<State>;
}
export interface RoomRuntimeOptions {
  executionClass: ExecutionClass;
  turnTimeoutMs: number | null;
  maxLifetimeMs: number | null;
  cleanupGraceMs: number;
  maxSnapshotBytes: number;
  maxReceipts: number;
  /** Additional host protection expiry, independent of product turn/lifetime. */
  protectionDeadline?: () => number;
  clock?: () => number;
}
