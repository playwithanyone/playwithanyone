import test from "node:test";
import assert from "node:assert/strict";
import { parseFinalizeKeys, authenticateRoomFinalization, roomFinalizationRoute, signRoomFinalizationHeaders,
  type FinalizeHostPorts, type RoomFinalizationSummary } from "../../../apps/edge/src/gameplay/finalize.js";
import type { Env } from "../../../apps/edge/src/env.js";

const now = 1_800_000_000_000;
const keyBinding = { keys: [{ kid: "runtime-test-1", secret: "test-only-independent-finalize-key-32-characters", runtimeId: "vps-test-1",
  executionClasses: ["realtime-tick"], releaseHashes: ["a".repeat(64)] }] };
const keys = parseFinalizeKeys(keyBinding), key = keys.keys[0]!;
const report: RoomFinalizationSummary = { schemaVersion: 1, runtimeId: "vps-test-1", roomId: "room-test-1", matchId: "match-test-1", assignmentId: "assignment-test-1",
  gameId: "connect-four", releaseHash: "a".repeat(64), executionClass: "realtime-tick", result: "WIN", winner: "red", reason: "CONNECTED_FOUR", endedAt: now - 1000,
  resourceUsage: { lifetimeMs: 120000, uplinkPackets: 42, uplinkBytes: 4096 } };
function env(enabled: "true" | "false" = "false") {
  let touched = 0;
  const value: Env & { ROOM_FINALIZE_ENABLED: "true" | "false"; ROOM_FINALIZE_KEYS_JSON: string } = { APP_ENV: "fixture", SHELL_ORIGIN: "https://shell.example", WORKER_ROLE: "shell",
    GAME_ORIGINS: "", ASSET_ORIGINS: "", SESSION_TTL_SECONDS: "3600", ROOM_FINALIZE_ENABLED: enabled, ROOM_FINALIZE_KEYS_JSON: JSON.stringify(keyBinding),
    ASSETS: { fetch: async () => { touched++; throw new Error("SHOULD_NOT_TOUCH_ASSETS"); } }, DB: { prepare: () => { touched++; throw new Error("SHOULD_NOT_TOUCH_DATABASE"); } } };
  return { value, touched: () => touched };
}
async function request(value: unknown = report, options: { timestamp?: number; nonce?: string; headers?: Record<string, string>; path?: string } = {}) {
  const body = new TextEncoder().encode(JSON.stringify(value)), headers = await signRoomFinalizationHeaders(body, key, options.timestamp ?? now, options.nonce ?? "nonce-test-00000001");
  return new Request("https://shell.example" + (options.path ?? "/internal/room-finalize"), { method: "POST", headers: { ...headers, ...options.headers }, body: Uint8Array.from(body).buffer });
}
function code(expected: string) { return (error: unknown) => (error as { code?: string }).code === expected; }

test("finalize boundary: exact HMAC verifies raw bytes and returns scoped immutable summary without IO", async () => {
  const verified = await authenticateRoomFinalization(await request(), keys, now);
  assert.equal(verified.runtimeId, "vps-test-1"); assert.equal(verified.summary.matchId, report.matchId); assert.match(verified.bodySha256, /^[a-f0-9]{64}$/);
  assert.equal(verified.expiresAt, now + 60000); assert.equal(Object.isFrozen(verified.summary), true); assert.equal(Object.isFrozen(verified.summary.resourceUsage), true);
});
test("finalize boundary: disabled deployment and absent trusted ports cannot accept even a valid signed win", async () => {
  const world = env(); let claimed = 0, finalized = 0;
  const ports: FinalizeHostPorts = { replay: { claim: async () => { claimed++; return true; } }, handler: { finalize: async value => { finalized++; return { accepted: true, matchId: value.summary.matchId }; } } };
  await assert.rejects(roomFinalizationRoute(await request(), world.value, ports, now), code("CAPABILITY_UNAVAILABLE"));
  await assert.rejects(roomFinalizationRoute(await request(), { ...world.value, ROOM_FINALIZE_ENABLED: "true" }, undefined, now), code("CAPABILITY_UNAVAILABLE"));
  assert.equal(world.touched(), 0); assert.equal(claimed, 0); assert.equal(finalized, 0);
});
test("finalize boundary: anonymous cookie and altered signature cannot call replay or result host ports", async () => {
  const world = env("true"); let called = 0;
  const ports: FinalizeHostPorts = { replay: { claim: async () => { called++; return true; } }, handler: { finalize: async value => { called++; return { accepted: true, matchId: value.summary.matchId }; } } };
  const cookie = new Request("https://shell.example/internal/room-finalize", { method: "POST", headers: { "Content-Type": "application/json", Cookie: "__Host-pwa_session=irrelevant" }, body: JSON.stringify(report) });
  await assert.rejects(roomFinalizationRoute(cookie, world.value, ports, now), code("FINALIZE_AUTH_REQUIRED"));
  await assert.rejects(roomFinalizationRoute(await request(report, { headers: { "X-PWA-Signature": "0".repeat(64) } }), world.value, ports, now), code("FINALIZE_AUTH_REQUIRED"));
  assert.equal(world.touched(), 0); assert.equal(called, 0);
});
test("finalize boundary: stale/future timestamps and mismatched runtime, release or execution class reject", async () => {
  for (const timestamp of [now - 60001, now + 1]) await assert.rejects(authenticateRoomFinalization(await request(report, { timestamp }), keys, now), code("FINALIZE_EXPIRED"));
  for (const value of [{ ...report, runtimeId: "another-runtime" }, { ...report, releaseHash: "b".repeat(64) }, { ...report, executionClass: "hibernated-turn" }]) {
    await assert.rejects(authenticateRoomFinalization(await request(value), keys, now), code("FINALIZE_SCOPE"));
  }
  await assert.rejects(authenticateRoomFinalization(await request(report, { path: "/internal/room-finalize?bypass=1" }), keys, now), code("FINALIZE_INVALID"));
});
test("finalize boundary: raw body tampering, overlong bodies and unknown result fields fail closed", async () => {
  const signed = await request(), headers = Object.fromEntries(signed.headers);
  const changed = new Request(signed.url, { method: "POST", headers, body: JSON.stringify({ ...report, winner: "yellow" }) });
  await assert.rejects(authenticateRoomFinalization(changed, keys, now), code("FINALIZE_AUTH_REQUIRED"));
  const oversized = new Request(signed.url, { method: "POST", headers, body: "x".repeat(32769) });
  await assert.rejects(authenticateRoomFinalization(oversized, keys, now), code("FINALIZE_BODY_LIMIT"));
  await assert.rejects(authenticateRoomFinalization(await request({ ...report, playerId: "not-trusted" }), keys, now), code("FINALIZE_INVALID"));
  await assert.rejects(authenticateRoomFinalization(await request({ ...report, result: "DRAW" }), keys, now), code("FINALIZE_INVALID"));
});
test("finalize boundary: a host replay claim prevents a signed request from finalizing twice", async () => {
  const world = env("true"), seen = new Set<string>(); let commits = 0;
  const ports: FinalizeHostPorts = { replay: { claim: async input => { const key = `${input.runtimeId}:${input.nonce}`; if (seen.has(key)) return false; seen.add(key); return true; } },
    handler: { finalize: async value => { commits++; return { accepted: true, matchId: value.summary.matchId }; } } };
  const response = await roomFinalizationRoute(await request(), world.value, ports, now); assert.equal(response?.status, 200);
  await assert.rejects(roomFinalizationRoute(await request(), world.value, ports, now), code("FINALIZE_REPLAY"));
  assert.equal(commits, 1); assert.equal(world.touched(), 0);
});
