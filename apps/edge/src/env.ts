export interface SqlResult { success: boolean; results?: unknown[]; meta?: { changes?: number; rows_read?: number; rows_written?: number } }
export interface SqlStatement {
  bind(...values: (string | number | null)[]): SqlStatement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[]; success: boolean }>;
  run(): Promise<SqlResult>;
}
export interface Database {
  prepare(sql: string): SqlStatement;
  batch?(statements: readonly SqlStatement[]): Promise<readonly SqlResult[]>;
}
export interface StoredObject {
  readonly body: ReadableStream;
  readonly size: number;
  readonly httpEtag: string;
  readonly httpMetadata?: { contentType?: string };
}
export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
}
export interface PublicResourceCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
export interface WorkerExecutionContext { waitUntil(promise: Promise<unknown>): void }
export interface Env {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  readonly DB: Database;
  readonly PUBLIC_BUILDS?: ObjectStore;
  readonly PRIVATE_STORAGE?: ObjectStore;
  readonly SHELL_ORIGIN: string;
  readonly GAME_ORIGINS: string;
  readonly ASSET_ORIGINS: string;
  readonly APP_ENV: "fixture" | "preview" | "production";
  readonly SESSION_TTL_SECONDS: string;
  readonly WORKER_ROLE: "shell" | "game" | "assets";
  readonly RELEASE_BUILD_ID?: string;
  readonly GAMEPLAY_ENABLED?: "true" | "false";
  readonly CONNECT_FOUR_BUILD_ID?: string;
  readonly GAMEPLAY_POLICY_JSON?: string;
  readonly ROOM_ROUTING_JSON?: string;
  readonly ROOM_TICKET_KEYS_JSON?: string;
  readonly ROOM_FINALIZE_ENABLED?: "true" | "false";
  readonly ROOM_FINALIZE_KEYS_JSON?: string;
  readonly SAFETY_POLICY_JSON?: string;
  readonly RESOURCE_SAFETY_REQUIRED?: "true" | "false";
  readonly SAFETY_STOP_TOKEN?: string;
  readonly SAFETY_RECOVERY_TOKEN?: string;
  readonly MATCH_POOL?: DoNamespace;
  readonly ROOMS?: DoNamespace;
}
import type { DoNamespace } from "./gameplay/types.js";
