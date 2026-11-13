import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeControl, parseControl } from "../../protocol/src/control.js";
import { issueJoinTicket, verifyJoinTicket, parseJoinTicketKeys, parseRoomRouting, selectRoomRoute, JoinTicketError,
  type JoinTicketIdentity, type VerifyJoinTicketExpected } from "../../../apps/edge/src/gameplay/join-ticket.js";

const now = 1_793_491_200_000;
const keys = parseJoinTicketKeys({ activeKid: "preview-1", keys: { "preview-1": "test-only-join-signing-key-32-characters-minimum" } });
const identity: JoinTicketIdentity = {
  roomId: "6ca15b47-8204-401c-9d06-1d746b75c8b1", matchId: "c4d231ab-2a09-40da-80fb-1733cc97b5d7", gameId: "connect-four",
  playerId: "player-red", sessionId: "session-red", seat: "red", releaseHash: "cd685350a6475b118f8928a023ff8281140a538fd668bbfc4ca3b35186d1d99d",
  executionClass: "hibernated-turn", seatEpoch: 3, authorizationVersion: 2, aud: "wss://playwithanyone.com"
};
const expected: VerifyJoinTicketExpected = { aud: identity.aud, roomId: identity.roomId, releaseHash: identity.releaseHash,
  executionClass: identity.executionClass, gameId: identity.gameId, matchId: identity.matchId, nowMs: now + 30_000 };
function code(value: string) { return (error: unknown) => error instanceof JoinTicketError && error.code === value && error.message === value; }
function b64(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

test("join-ticket: offline verification returns a frozen, short-lived seat authority and fits AUTH_JOIN", async () => {
  const token = await issueJoinTicket(identity, keys, { nowMs: now, jti: "admission-1" });
  const claims = await verifyJoinTicket(token, keys, expected);
  assert.deepEqual(claims, { ...identity, v: 1, iat: now / 1000, exp: now / 1000 + 90, jti: "admission-1" });
  assert.equal(Object.isFrozen(claims), true); assert.ok(token.length < 2048);
  const message = { v: 1 as const, type: "AUTH_JOIN" as const, requestId: "authenticate-1", body: { joinGrant: token, protocolVersions: [1], profileId: "server-turn", profileVersion: 1 } };
  const wire = encodeControl(message, { maxControlBytes: 4096 });
  assert.equal(parseControl(wire).type, "AUTH_JOIN"); assert.ok(new TextEncoder().encode(wire).byteLength < 4096);
  // Verification is deliberately stateless. The room host, not cryptography,
  // must persistently consume this jti and compare its seat/auth epochs.
  assert.equal((await verifyJoinTicket(token, keys, expected)).jti, claims.jti);
});

test("join-ticket: altered payload, signature, algorithm, key id and malformed encodings fail closed", async () => {
  const token = await issueJoinTicket(identity, keys, { nowMs: now });
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const altered = [
    `${header}.${b64({ ...claims, seat: "yellow" })}.${signature}`,
    `${header}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`,
    `${b64({ v: 1, alg: "none", typ: "PWA-JOIN", kid: "preview-1" })}.${payload}.${signature}`,
    `${b64({ v: 1, alg: "HS256", typ: "PWA-JOIN", kid: "unknown" })}.${payload}.${signature}`,
    `${header}.${payload}.${signature}=`, `${header}..${signature}`, "x".repeat(2049)
  ];
  for (const value of altered) await assert.rejects(() => verifyJoinTicket(value, keys, expected), code("ROOM_TICKET_INVALID"));
  const wrongKeys = parseJoinTicketKeys({ activeKid: "preview-1", keys: { "preview-1": "different-test-only-signing-key-32-characters" } });
  await assert.rejects(() => verifyJoinTicket(token, wrongKeys, expected), code("ROOM_TICKET_INVALID"));
});

test("join-ticket: exact audience, room, release, execution class, game and match must agree", async () => {
  const token = await issueJoinTicket(identity, keys, { nowMs: now });
  for (const scope of [
    { aud: "wss://another.example" }, { roomId: "another-room" }, { releaseHash: "a".repeat(64) },
    { executionClass: "realtime-tick" as const }, { gameId: "another-game" }, { matchId: "another-match" }
  ]) await assert.rejects(() => verifyJoinTicket(token, keys, { ...expected, ...scope }), code("ROOM_TICKET_SCOPE"));
});

test("join-ticket: expiry, future issue time, unsupported TTL and unknown claims reject", async () => {
  const token = await issueJoinTicket(identity, keys, { nowMs: now, ttlSeconds: 60 });
  await assert.rejects(() => verifyJoinTicket(token, keys, { ...expected, nowMs: now + 60_000 }), code("ROOM_TICKET_EXPIRED"));
  await assert.rejects(() => verifyJoinTicket(token, keys, { ...expected, nowMs: now - 1000 }), code("ROOM_TICKET_INVALID"));
  for (const ttlSeconds of [0, 59, 121, 90.5, Infinity]) await assert.rejects(() => issueJoinTicket(identity, keys, { nowMs: now, ttlSeconds }), code("ROOM_TICKET_INVALID"));
  await assert.rejects(() => issueJoinTicket({ ...identity, undeclared: "value" } as JoinTicketIdentity, keys, { nowMs: now }), code("ROOM_TICKET_INVALID"));
  await assert.rejects(() => issueJoinTicket({ ...identity, authorizationVersion: 0 }, keys, { nowMs: now }), code("ROOM_TICKET_INVALID"));
});

test("join-ticket: missing keys never fall back and rotation verifies only registered key IDs", async () => {
  for (const value of [undefined, null, ""]) assert.throws(() => parseJoinTicketKeys(value), code("ROOM_TICKET_KEYS_REQUIRED"));
  for (const value of [{ activeKid: "one", keys: {} }, { activeKid: "one", keys: { one: "short" } }, { activeKid: "missing", keys: { one: "x".repeat(43) } }, { activeKid: "one", keys: { one: "x".repeat(43) }, fallback: true }]) {
    assert.throws(() => parseJoinTicketKeys(value), code("ROOM_TICKET_KEYS_INVALID"));
  }
  const token = await issueJoinTicket(identity, keys, { nowMs: now });
  const rotated = parseJoinTicketKeys({ activeKid: "preview-2", keys: { ...keys.keys, "preview-2": "test-only-second-independent-key-32-characters" } });
  assert.equal((await verifyJoinTicket(token, rotated, expected)).seatEpoch, 3);
  const removed = parseJoinTicketKeys({ activeKid: "preview-2", keys: { "preview-2": rotated.keys["preview-2"] } });
  await assert.rejects(() => verifyJoinTicket(token, removed, expected), code("ROOM_TICKET_INVALID"));
});

const routingFixture = () => { const value=JSON.parse(readFileSync("configs/room-routing.preview.example.json", "utf8")) as Record<string, unknown>; const first=(value["games"] as Record<string, unknown>[])[0]!; first["releaseHash"]=identity.releaseHash; first["wsOrigin"]=identity.aud; value["allowedWebSocketOrigins"]=[identity.aud]; value["games"]=[first]; return value; };
test("room routing: server registry selects exact build, class, endpoint and named game/mode/region pool", () => {
  const routing = parseRoomRouting(routingFixture(), "preview");
  const route = selectRoomRoute(routing, { gameId: identity.gameId, releaseHash: identity.releaseHash, roomId: identity.roomId });
  assert.deepEqual(route, { roomId: identity.roomId, wsUrl: `wss://playwithanyone.com/api/play/rooms/${identity.roomId}/socket`, audience: identity.aud,
    executionClass: "hibernated-turn", syncPolicy: { profileId: "server-turn", profileVersion: 1, protocolVersions: [1] },
    poolId: "connect-four:casual:global", physicalOwner: "connect-four-v1", mode: "casual", regionHint: "global" });
  assert.equal(Object.isFrozen(routing.games[0]?.syncPolicy), true);
  for (const changes of [{ regionHint: "arbitrary-region" }, { mode: "arbitrary-mode" }, { gameId: "unregistered-game" }, { releaseHash: "a".repeat(64) }]) {
    assert.throws(() => selectRoomRoute(routing, { gameId: identity.gameId, releaseHash: identity.releaseHash, roomId: identity.roomId, ...changes }), code("ROOM_ROUTE_UNAVAILABLE"));
  }
});

test("room routing: disabled execution classes, unregistered WebSocket origins and unsafe URL paths reject", () => {
  const disabled = routingFixture(); const games = disabled["games"] as Record<string, unknown>[]; games[0]!["executionClass"] = "realtime-tick";
  const routing = parseRoomRouting(disabled, "preview");
  assert.throws(() => selectRoomRoute(routing, { gameId: identity.gameId, releaseHash: identity.releaseHash, roomId: identity.roomId }), code("ROOM_ROUTE_UNAVAILABLE"));
  for (const changes of [{ wsOrigin: "wss://attacker.example" }, { wsOrigin: "ws://playwithanyone.com" }, { wsPathTemplate: "//attacker.example/{roomId}" }, { wsPathTemplate: "/ws/{roomId}?ticket=secret" }]) {
    const invalid = routingFixture(); Object.assign((invalid["games"] as Record<string, unknown>[])[0]!, changes);
    assert.throws(() => parseRoomRouting(invalid, "preview"), code("ROOM_ROUTING_INVALID"));
  }
  assert.throws(() => parseRoomRouting(routingFixture(), "production"), code("ROOM_ROUTING_INVALID"));
});

test("room routing: retained compatible builds keep the same physical pool and allow reconnect after a catalog update", () => {
  const routing = parseRoomRouting(JSON.parse(readFileSync("configs/room-routing.preview.example.json", "utf8")), "preview");
  assert.ok(routing.games.length >= 2);
  const routes = routing.games.filter(game => game.gameId === identity.gameId).map(game => selectRoomRoute(routing, { gameId: game.gameId, releaseHash: game.releaseHash, roomId: identity.roomId }));
  assert.equal(routes.length, routing.games.length);
  for (const route of routes) { assert.equal(route.physicalOwner, "connect-four-v1"); assert.equal(route.poolId, "connect-four:casual:global"); assert.equal(route.wsUrl, routes[0]!.wsUrl); }
});
