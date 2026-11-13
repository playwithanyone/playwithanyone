import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { ProxyAgent, WebSocket } from "undici";
import { decodeFrame, encodeFrame, FULL_STATE, Opcode } from "../.build/packages/protocol/src/frame.js";
import { parseControl, encodeControl } from "../.build/packages/protocol/src/control.js";

const args = process.argv.slice(2);
let requestedOrigin, exerciseSafety = false, exerciseTimeout = false, exerciseReconnect = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--origin" && !requestedOrigin && args[index + 1]) requestedOrigin = args[++index];
  else if (args[index] === "--exercise-safety" && !exerciseSafety) exerciseSafety = true;
  else if (args[index] === "--exercise-timeout" && !exerciseTimeout) exerciseTimeout = true;
  else if (args[index] === "--exercise-reconnect" && !exerciseReconnect) exerciseReconnect = true;
  else throw new Error("Usage: check-gameplay-http.mjs [--origin http://127.0.0.1:18873] [--exercise-safety] [--exercise-timeout] [--exercise-reconnect]");
}
const resources = JSON.parse(await readFile("configs/cloud/resources.json", "utf8"));
const origin = requestedOrigin ?? resources.shellOrigin;
const local = new URL(origin).protocol === "http:" && ["127.0.0.1", "localhost"].includes(new URL(origin).hostname);
assert.ok(local || origin === resources.shellOrigin);
assert.ok(!exerciseSafety || local, "Stop/recovery drills are restricted to this task's isolated loopback fixture.");
const proxy = !local && (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy);
const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
const checks = [], actors = [], sockets = [];
let requests = 0, failed = false;
const userAgent = "PlayWithAnyone-Verification/0.1 (+https://playwithanyone.com)";
async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("GAMEPLAY_OBSERVATION_TIMEOUT");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function api(path, actor, body, expected = 200) {
  if (++requests > 100) throw new Error("VERIFICATION_REQUEST_BUDGET");
  const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", redirect: "manual",
    ...(dispatcher ? { dispatcher } : {}), signal: AbortSignal.timeout(12_000),
    headers: { "User-Agent": userAgent, Accept: "application/json", ...(actor ? { Cookie: actor.cookie } : {}),
      ...(body === undefined ? {} : { Origin: origin, "Content-Type": "application/json", "X-PWA-Request": "1" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let result;
  try { result = await response.json(); } catch { throw new Error(`NON_JSON_GAMEPLAY_RESPONSE:${response.status}`); }
  const code = typeof result.error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(result.error.code) ? result.error.code : "UNKNOWN";
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `Unexpected HTTP ${response.status} (${code}) for ${path}`);
  return { result, response };
}
async function guest() {
  const { result, response } = await api("/api/session", undefined, {}, 201);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie?.startsWith("__Host-pwa_session="));
  const actor = { cookie, session: result.session, room: undefined, link: undefined, context: undefined,
    ws: undefined, bound: false, nextSeq: 0, receipts: new Map(), errors: [], fatal: undefined, closed: false, bytesReceived: 0 };
  actors.push(actor); return actor;
}
function sendControl(actor, type, body) {
  actor.ws.send(encodeControl({ v: 1, type, requestId: randomUUID(), ...(actor.link ? { contextTag: actor.link.contextTag } : {}), body }));
}
async function connect(actor, roomId) {
  const { result: grant } = await api(`/api/play/rooms/${roomId}/grant`, actor, { requestId: randomUUID() });
  const credential=grant.joinTicket??grant.joinGrant;
  assert.ok(typeof credential === "string" && credential.length >=64 && credential.length <=2048);
  if (!local) { assert.equal(grant.roomId,roomId);assert.equal(grant.executionClass,"hibernated-turn");assert.equal(grant.syncPolicy.profileId,"server-turn"); }
  const target = new URL(grant.wsUrl??grant.socketUrl);
  assert.equal(target.origin, origin.replace(/^http/, "ws")); assert.equal(target.search, "");
  actor.bound = false; actor.closed = false;
  const ws = new WebSocket(target, { ...(dispatcher ? { dispatcher } : {}), headers: { Cookie: actor.cookie, Origin: origin, "User-Agent": userAgent } });
  actor.ws = ws; sockets.push(ws); ws.binaryType = "arraybuffer";
  ws.addEventListener("close", () => { actor.closed = true; });
  ws.addEventListener("error", () => { actor.fatal = "WEBSOCKET_ERROR"; });
  ws.addEventListener("message", event => {
    try {
      if (typeof event.data === "string") {
        actor.bytesReceived += new TextEncoder().encode(event.data).byteLength;
        const message = parseControl(event.data, { channel: "platform" });
        if (message.type === "AUTH_ACCEPTED") {
          const link = message.body.descriptors.find(item => item.roomId === roomId);
          assert.ok(link); assert.equal(link.endpoints[0].inputSessionId, actor.session.id);
          actor.link = link;
          actor.context = { descriptorId: link.descriptorId, contextTag: BigInt(`0x${link.contextTag}`),
            endpoints: link.endpoints.map(item => item.endpointId), validFromMs: link.validFromMs, validUntilMs: link.validUntilMs,
            maxFrameBytes: link.limits.maxFrameBytes, maxBulkBytes: 0,
            streams: link.streams.map(item => ({ ...item, maxAhead: 0xffff_fffe, ...(item.kind === "STATE" ? { usesTick: false } : {}) })) };
          sendControl(actor, "LINK_BIND", { descriptorId: link.descriptorId, contextTag: link.contextTag });
        } else if (message.type === "LINK_BOUND") {
          assert.equal(message.body.descriptorId, actor.link.descriptorId);
          actor.nextSeq = message.body.receiveCursors.find(item => item.space === "COMMAND_SEQ").nextExpected;
          actor.bound = true;
        } else if (message.type === "ACTION_RECEIPT") actor.receipts.set(message.body.commandSeq, message.body.outcome);
        else if (message.type === "PROTOCOL_ERROR") actor.errors.push(message.body.code);
      } else {
        assert.ok(actor.context && actor.bound);
        const bytes = new Uint8Array(event.data); actor.bytesReceived += bytes.byteLength;
        const frame = decodeFrame(bytes, { context: actor.context, senderEndpointId: actor.link.endpoints[1].endpointId,
          receiverEndpointId: actor.link.endpoints[0].endpointId, nowMs: Date.now() });
        assert.ok(frame.payload.kind === "STATE" && (frame.header.flags & FULL_STATE));
        const view = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload.data));
        assert.equal(view.roomId, roomId); assert.equal(view.stateSeq, frame.header.seq);
        assert.equal(view.seatEpoch, actor.link.endpoints[0].seatEpoch);
        assert.ok(!JSON.stringify(view).includes("joinGrant") && !JSON.stringify(view).includes("grantKey"));
        actor.room = view;
      }
    } catch (error) { actor.fatal = error instanceof Error ? error.message : "INVALID_SERVER_MESSAGE"; }
  });
  await waitFor(() => ws.readyState === WebSocket.OPEN || actor.fatal);
  if (actor.fatal) throw new Error(actor.fatal);
  sendControl(actor, "AUTH_JOIN", { joinGrant: credential, protocolVersions: [1], profileId: "server-turn", profileVersion: 1 });
  await waitFor(() => (actor.bound && actor.room) || actor.fatal || actor.closed);
  if (actor.fatal || !actor.bound || !actor.room) throw new Error(actor.fatal ?? "AUTHORIZATION_NOT_OBSERVED");
}
async function ready(actor, prepared) {
  // Only an actually received binary FULL_STATE may become a baseline proof.
  assert.ok(actor.room && actor.context && actor.bound);
  for (let attempt = 0; attempt < 3; attempt++) {
    const room = actor.room;
    const body = { requestId: randomUUID(), expectedMatchRevision: room.revision, resourcesReady: true,
      baselineReady: true, prepared, baseline: { descriptorId: actor.link.descriptorId, stateSeq: room.stateSeq } };
    const { result, response } = await api(`/api/play/rooms/${room.roomId}/ready`, actor, body, [200, 409]);
    if (response.status === 409) {
      assert.equal(result.error?.code, "REVISION_CONFLICT");
      await waitFor(() => actor.room.revision > room.revision || actor.fatal);
      if (actor.fatal) throw new Error(actor.fatal);
      continue;
    }
    assert.ok(result.room);
    await waitFor(() => actor.room.revision >= result.room.revision || actor.fatal);
    if (actor.fatal) throw new Error(actor.fatal);
    return;
  }
  throw new Error("READINESS_CONFLICT_RETRY_LIMIT");
}
function commandBytes(actor, column, seq) {
  return encodeFrame({ header: { opcode: Opcode.COMMAND, flags: 0, streamId: 1, contextTag: actor.context.contextTag, seq, tick: 0 },
    payload: { kind: "COMMAND", data: new TextEncoder().encode(JSON.stringify({ type: "drop", column })) } }, {
      context: actor.context, senderEndpointId: actor.link.endpoints[0].endpointId, receiverEndpointId: actor.link.endpoints[1].endpointId,
      nowMs: Date.now(), receivePositions: new Map([[1, seq]]) });
}
async function drop(actor, column, expected = "COMMITTED") {
  const seq = actor.nextSeq++, bytes = commandBytes(actor, column, seq); actor.ws.send(bytes);
  await waitFor(() => actor.receipts.has(seq) || actor.fatal);
  if (actor.fatal) throw new Error(actor.fatal);
  const receipt = actor.receipts.get(seq); assert.equal(receipt.status, expected);
  return { seq, bytes, receipt };
}
async function check(name, action) {
  try { const details = await action(); checks.push({ name, status: "PASS", ...(details ? { details } : {}) }); console.log(JSON.stringify({ check: name, status: "PASS" })); }
  catch (error) { checks.push({ name, status: "FAIL", reason: error instanceof Error ? error.message : "Verification failed" }); throw error; }
}
async function management(body, recovery = false, expected = 200) {
  assert.ok(local && exerciseSafety);
  const secret = process.env[recovery ? "PWA_LOCAL_SAFETY_RECOVERY" : "PWA_LOCAL_SAFETY_STOP"];
  assert.ok(secret && secret.length >= 32);
  if (++requests > 100) throw new Error("VERIFICATION_REQUEST_BUDGET");
  const response = await fetch(`${origin}/api/ops/safety`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(12_000),
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(response.status, expected, "Management action status");
  return response.json();
}
let red, yellow, roomId;
try {
  await check("guest invitation room creation is idempotent; unknown IDs reject", async () => {
    red = await guest(); yellow = await guest();
    const requestId = randomUUID();
    const first = await api("/api/play/rooms", red, { requestId });
    const retry = await api("/api/play/rooms", red, { requestId });
    roomId = first.result.room.roomId; assert.equal(retry.result.room.roomId, roomId);
    const joined = await api(`/api/play/rooms/${roomId}/join`, yellow, { requestId: randomUUID() });
    assert.equal(first.result.room.yourSeat, "red"); assert.equal(joined.result.room.yourSeat, "yellow");
    await api(`/api/play/rooms/${randomUUID()}/status`, red, undefined, 404);
    return { independentGuestSessions: 2 };
  });
  await check("real WSS AUTH_JOIN and LINK_BIND install authenticated independent contexts", async () => {
    await connect(red, roomId); await connect(yellow, roomId);
    await waitFor(() => red.room.members.length === 2 && red.room.members.every(item => item.connected));
    assert.notEqual(red.context.contextTag, yellow.context.contextTag);
  });
  await check("resources, binary baseline and both players prepared gate the start", async () => {
    await ready(red, false); await ready(yellow, false);
    assert.equal(red.room.phase, "PREPARING");
    await ready(red, true); assert.equal(red.room.phase, "PREPARING");
    await ready(yellow, true);
    await waitFor(() => red.room.phase === "RUNNING" && yellow.room.phase === "RUNNING");
  });
  if (exerciseReconnect) await check("reconnecting restores the remaining turn budget instead of resetting it", async () => {
    await new Promise(resolve => setTimeout(resolve, 2500));
    red.ws.close(1000, "BOUNDED_RECONNECT_CHECK");
    await waitFor(() => yellow.room.disconnectedUntil !== null && yellow.room.turnDeadlineAt === null);
    await connect(red, roomId); await ready(red, true);
    await waitFor(() => red.room.turnDeadlineAt !== null && yellow.room.disconnectedUntil === null);
    const remainingMs = red.room.turnDeadlineAt - Date.now();
    assert.ok(remainingMs > 75_000 && remainingMs < 88_500, "Reconnection manufactured a fresh thinking allowance");
    return { remainingMs, noNewTurnGranted: true };
  });
  await check("server-turn rejects wrong actor, deduplicates committed commands and completes a real win", async () => {
    const invalid = await drop(yellow, 6, "REJECTED"); assert.equal(invalid.receipt.code, "NOT_YOUR_TURN");
    const first = await drop(red, 0);
    await waitFor(() => red.room.moves === 1 && yellow.room.moves === 1);
    red.receipts.delete(first.seq); red.ws.send(first.bytes);
    await waitFor(() => red.receipts.has(first.seq));
    assert.equal(red.room.moves, 1); assert.deepEqual(red.receipts.get(first.seq), first.receipt);
    const beforeErrors = red.errors.length;
    red.ws.send(commandBytes(red, 2, first.seq));
    await waitFor(() => red.errors.length > beforeErrors);
    assert.equal(red.errors.at(-1), "IDEMPOTENCY_CONFLICT"); assert.equal(red.room.moves, 1);
    for (const [actor, column] of [[yellow, 1], [red, 0], [yellow, 1], [red, 0], [yellow, 1], [red, 0]]) await drop(actor, column);
    await waitFor(() => red.room.phase === "TERMINAL" && yellow.room.phase === "TERMINAL");
    assert.equal(red.room.winner, "red"); assert.equal(yellow.room.winner, "red"); assert.equal(red.room.moves, 7);
    assert.equal(red.room.winningCells.length, 4);
    return { moves: red.room.moves, redReceivedBytes: red.bytesReceived, yellowReceivedBytes: yellow.bytesReceived };
  });
  await check("terminal refresh grants only a read-only presentation and rejects new join credentials", async () => {
    const status = await api(`/api/play/rooms/${roomId}/status`, red);
    assert.equal(status.result.room.phase, "TERMINAL");
    const { result } = await api(`/api/play/rooms/${roomId}/presentation`, red, {
      gameBuildId: status.result.room.gameBuildId, frameOrigin: status.result.room.frameOrigin, presentationInstanceId: randomUUID() });
    assert.equal(result.matchScope, undefined); assert.ok(!result.capabilityIds.includes("actions.dispatch"));
    await api(`/api/play/rooms/${roomId}/grant`, red, { requestId: randomUUID() }, 409);
  });
  await check("single-pool matching assigns both intentions to one installed room; cancellation is persistent", async () => {
    const one = await guest(), two = await guest();
    const q1 = await api("/api/play/queue", one, { requestId: randomUUID() });
    const pushed = [];
    let watcher;
    if (q1.result.watchUrl) {
      const target = new URL(q1.result.watchUrl);
      assert.equal(target.origin, origin.replace(/^http/, "ws")); assert.equal(target.search, "");
      // Use the server URL verbatim, including percent-encoded intent colons.
      watcher = new WebSocket(target, { ...(dispatcher ? { dispatcher } : {}), headers: { Cookie: one.cookie, Origin: origin, "User-Agent": userAgent } });
      sockets.push(watcher);
      watcher.addEventListener("message", event => {
        try { const value = JSON.parse(event.data); if (value.type === "QUEUE_STATE" && value.body.intentId === q1.result.intentId) pushed.push(value.body); }
        catch { /* The bounded observation below reports a missing valid push. */ }
      });
      await waitFor(() => pushed.some(value => value.status === "QUEUED"));
    } else assert.ok(local, "Cloud matching must supply its WebSocket watcher URL");
    const q2 = await api("/api/play/queue", two, { requestId: randomUUID() });
    let assigned;
    if (watcher) { await waitFor(() => pushed.some(value => value.status === "ASSIGNED")); assigned = pushed.find(value => value.status === "ASSIGNED"); }
    else assigned = (await api(`/api/play/queue/${q1.result.intentId}`, one)).result;
    assert.equal(q2.result.status, "ASSIGNED"); assert.equal(assigned.status, "ASSIGNED");
    assert.equal(q2.result.roomId, assigned.roomId);
    const unmatched = await guest();
    const queued = await api("/api/play/queue", unmatched, { requestId: randomUUID() });
    const cancelled = await api(`/api/play/queue/${queued.result.intentId}/cancel`, unmatched, { requestId: randomUUID(), expectedRevision: queued.result.revision });
    assert.equal(cancelled.result.status, "CANCELLED");
    const stable = await api(`/api/play/queue/${queued.result.intentId}`, unmatched); assert.equal(stable.result.status, "CANCELLED");
    return { assignmentObservedByWebSocket: Boolean(watcher), matchingStatusPolls: watcher ? 0 : 1 };
  });
  if (exerciseTimeout) await check("a real persisted turn deadline awards the idle player's opponent after 90 seconds", async () => {
    const first = await guest(), second = await guest();
    const created = await api("/api/play/rooms", first, { requestId: randomUUID() });
    const id = created.result.room.roomId;
    await api(`/api/play/rooms/${id}/join`, second, { requestId: randomUUID() });
    await connect(first, id); await connect(second, id);
    await ready(first, true); await ready(second, true);
    await waitFor(() => first.room.phase === "RUNNING" && second.room.phase === "RUNNING");
    const deadline = first.room.turnDeadlineAt;
    assert.ok(Number.isSafeInteger(deadline) && deadline > Date.now() + 80_000 && deadline < Date.now() + 91_000);
    // No HTTP status probes, heartbeat or game command during the idle turn.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now()) + 500));
    await waitFor(() => first.room.phase === "TERMINAL" && second.room.phase === "TERMINAL", 15_000);
    assert.equal(first.room.result, "WIN"); assert.equal(first.room.winner, "yellow");
    assert.equal(first.room.terminationReason, "TURN_TIMEOUT"); assert.equal(first.room.moves, 0);
    assert.equal(second.room.winner, "yellow");
    const confirmed = await api(`/api/play/rooms/${id}/status`, first);
    assert.equal(confirmed.result.room.phase, "TERMINAL"); assert.equal(confirmed.result.room.terminationReason, "TURN_TIMEOUT");
    return { observedAfterDeadlineMs: Date.now() - deadline, moves: 0, winner: "yellow", reason: "TURN_TIMEOUT" };
  });
  if (exerciseSafety) await check("isolated workerd safety stop closes existing WSS and requires authenticated manual recovery", async () => {
    const first = await guest(), second = await guest();
    const created = await api("/api/play/rooms", first, { requestId: randomUUID() });
    const id = created.result.room.roomId;
    await api(`/api/play/rooms/${id}/join`, second, { requestId: randomUUID() });
    await connect(first, id); await connect(second, id);
    const status = await management({ operation: "status" });
    const version = status.version + 1, issuedAt = Date.now();
    const update = { version, environment: "fixture", scope: "gameplay", state: "BLOCKED", reason: "LOCAL_STOP_DRILL", issuedAt,
      validUntil: issuedAt + 60_000, drainUntil: null, operator: "local-verification", incidentId: randomUUID() };
    await management({ operation: "protect", protection: update });
    await waitFor(() => first.closed && second.closed);
    let observed;
    for (let attempt = 0; attempt < 6; attempt++) {
      observed = await management({ operation: "status" });
      if (observed.activeConnections === 0 && observed.backgroundTasks === 0 && observed.newAllocationsBlocked) break;
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    assert.equal(observed.state, "BLOCKED"); assert.equal(observed.activeConnections, 0);
    assert.equal(observed.backgroundTasks, 0); assert.equal(observed.newAllocationsBlocked, true);
    await api("/api/play/rooms", first, { requestId: randomUUID() }, 503);
    const record = { actor: "local-verification", reason: "Local stop verified; restore only the isolated test environment",
      configurationVersion: "1", validationRecord: "artifacts/p3/unit.json" };
    const recovery = { operation: "recover", protection: { ...update, version: version + 1, state: "NORMAL",
      issuedAt: Date.now(), validUntil: Date.now() + 60_000, reason: "LOCAL_STOP_DRILL_VERIFIED", incidentId: null }, record };
    await management(recovery, false, 401);
    await management(recovery, true);
    const recovered = await management({ operation: "status" }, true);
    assert.equal(recovered.state, "NORMAL"); assert.equal(recovered.newAllocationsBlocked, false);
    return { oldConnectionsObservedClosed: 2, unauthorizedRecoveryRejected: true, unobservedRooms: observed.unobservedRooms ?? null,
      unfinishedCleanup: observed.unfinishedCleanup ?? null, fullRecoveryObserved: recovered.fullRecoveryObserved ?? null };
  });
} catch (error) { failed = true; console.error(error instanceof Error ? error.message : "Gameplay verification failed"); }
finally {
  for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close(1000, "VERIFICATION_COMPLETE");
  const cleanupFailures = [];
  for (const actor of actors) {
    try { await api("/api/session/revoke", actor, {}); }
    catch { cleanupFailures.push("SESSION_REVOCATION_NOT_CONFIRMED"); }
    actor.cookie = "";
  }
  if (cleanupFailures.length) failed = true;
  const report = { createdAt: new Date().toISOString(), status: failed ? "FAIL" : "PASS", environment: {
    level: local ? "L1_WORKERD_HTTP_WSS" : "L3_CLOUDFLARE_HTTP_WSS", hostname: os.hostname(), node: process.version, origin, existingProxyUsed: Boolean(dispatcher) },
    requests, checks, cleanupFailures, limits: "Independent Node Shell clients exercise actual HTTP/WSS and protocol frames; this is not a two-browser UX, actual DO eviction, WAF, official billing or notification-delivery proof." };
  await mkdir("artifacts/p3", { recursive: true });
  const stamp = report.createdAt.replace(/[:.]/g, "-");
  await writeFile(`artifacts/p3/gameplay-${local ? "local" : "cloud"}.json`, JSON.stringify(report, null, 2) + "\n");
  await writeFile(`artifacts/p3/gameplay-${stamp}.json`, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, passed: checks.filter(item => item.status === "PASS").length, total: checks.length, requests, cleanupFailures: cleanupFailures.length }));
  await dispatcher?.close(); process.exitCode = failed ? 1 : 0;
}
