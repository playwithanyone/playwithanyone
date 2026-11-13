import type { RoomRuntimeMetadata } from "../../../../packages/room-runtime/src/ports.js";
import type { Env } from "../env.js";
import type { PlatformSession } from "../session.js";
import type { BrowserReleaseManifest } from "../../../../packages/release/src/release.js";
import type { FourState, FourView, Seat } from "../../../../games/connect-four/src/rules.js";
import type { PolicyBinding } from "../../../../packages/protocol/src/policy.js";
import type { LinkDescriptor } from "../../../../packages/protocol/src/control.js";

/** Structural Cloudflare interfaces keep the DO implementation importable in Node tests. */
export type SqlValue = string | number | null | ArrayBuffer;
export interface SqlCursor<T> extends Iterable<T> { toArray(): T[]; rowsRead?: number; rowsWritten?: number }
export interface DoStorage {
  readonly sql: { exec<T = Record<string, unknown>>(query: string, ...bindings: SqlValue[]): SqlCursor<T> };
  transactionSync<T>(callback: () => T): T;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
export interface ServerSocket extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
export interface DoState {
  readonly storage: DoStorage;
  acceptWebSocket(socket: ServerSocket, tags?: string[]): void;
  getWebSockets(tag?: string): ServerSocket[];
  waitUntil(promise: Promise<unknown>): void;
}
export interface DoStub { fetch(request: Request): Promise<Response> }
export interface DoNamespace { idFromName(name: string): unknown; get(id: unknown): DoStub }
export interface GameplayEnv extends Env {
  readonly MATCH_POOL?: DoNamespace;
  readonly ROOMS?: DoNamespace;
  readonly CONNECT_FOUR_BUILD_ID?: string;
  readonly GAMEPLAY_POLICY_JSON?: string;
  readonly SAFETY_POLICY_JSON?: string;
  readonly ROOM_ROUTING_JSON?: string;
  readonly ROOM_TICKET_KEYS_JSON?: string;
  readonly ROOM_LEGACY_GRANTS_ENABLED?: string;
  readonly CONNECT_FOUR_RULE_BUILDS_JSON?: string;
}
export type Principal = PlatformSession;
// The first named pool retains its legacy physical owner and durable usage ledger.
export const POOL_ID = "connect-four-v1";
export interface GameplayPolicy extends Record<string, unknown> {
  guestAllowed: true;
  startCondition: "BOTH_PREPARED";
  queueWaitMs: number;
  disconnectGraceMs: number;
  disconnectOutcome: "ABORT_NO_RESULT";
}
export interface FixedGame {
  readonly poolId?: string;
  readonly poolOwnerId?: string;
  readonly executionClass?: "hibernated-turn" | "p2p-signaling" | "realtime-tick";
  readonly release: BrowserReleaseManifest;
  readonly policyBinding: PolicyBinding;
  readonly policy: GameplayPolicy;
}
export type RoomPhase = "PREPARING" | "RUNNING" | "TERMINAL";
export interface RoomMember {
  seatId: Seat; playerId: string; sessionId: string; sessionExpiresAt: number;
  seatEpoch: number; resourcesReady: boolean; baselineReady: boolean; prepared: boolean;
  connected: boolean; disconnectedUntil: number | null; nextCommandSeq: number;
  descriptor: LinkDescriptor | null;
}
export interface RoomRecord {
  roomId: string; matchId: string; assignmentId: string; installDigest: string;
  game: FixedGame; phase: RoomPhase; revision: number; stateSeq: number;
  rules: FourState; members: RoomMember[]; createdAt: number;
  result: "WIN" | "DRAW" | "DISCONNECTED" | "SERVICE_INTERRUPTED" | null;
  resultPending: boolean; resultAttempts: number; resultRetryAt: number | null;
  cleanupDeadlineAt: number | null;
  grantKey: string; safetyStopped: boolean; runtime?: RoomRuntimeMetadata;
}
export interface RoomView extends FourView {
  readonly roomId: string; readonly matchId: string; readonly phase: RoomPhase;
  readonly revision: number; readonly stateSeq: number; readonly gameBuildId: string;
  readonly frameOrigin: string; readonly entryUrl: string; readonly authorityEpoch: 1;
  readonly seatId: Seat; readonly seatEpoch: number;
  readonly result: RoomRecord["result"];
  readonly turnDeadlineAt?: number | null;
  readonly terminationReason?: RoomRuntimeMetadata["terminationReason"];
  readonly disconnectedUntil: number | null;
  readonly members: readonly {
    seatId: Seat; color: Seat; connected: boolean; prepared: boolean;
    resourcesReady: boolean; baselineReady: boolean;
  }[];
}
export interface QueueView {
  readonly intentId: string; readonly status: "QUEUED" | "ASSIGNED" | "CANCELLED" | "EXPIRED";
  readonly deadlineAt: number; readonly revision: number; readonly roomId?: string;
}
export interface InstallAssignment {
  readonly assignmentId: string; readonly roomId: string; readonly matchId: string;
  readonly game: FixedGame; readonly members: readonly Principal[];
}
export interface SocketAttachment {
  readonly connectionId: string; readonly principal: Principal; readonly openedAt: number;
  authenticated: boolean; bound: boolean; seatId?: Seat; descriptorId?: string;
  lastSentStateSeq?: number;
  /** Conservative total sent bytes, an upper bound on outstanding server send bytes. */
  outboundBytes?: number;
  closing?: boolean;
}
