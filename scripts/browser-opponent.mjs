// A finite QA peer controlled over stdin. It is never a catalog bot or deployed service.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { ProxyAgent, WebSocket } from "undici";
import { decodeFrame, encodeFrame, FULL_STATE, Opcode } from "../.build/packages/protocol/src/frame.js";
import { parseControl, encodeControl } from "../.build/packages/protocol/src/control.js";

const roomId = process.argv[2]; assert.match(roomId ?? "", /^[a-f0-9-]{36}$/);
const { shellOrigin: origin } = JSON.parse(await readFile("configs/cloud/resources.json", "utf8"));
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
const headers = { Origin: origin, Accept: "application/json", "Content-Type": "application/json", "X-PWA-Request": "1", "User-Agent": "PlayWithAnyone-QA/0.1 (+https://playwithanyone.com)" };
let cookie = "", session, room, socket, descriptor, context, endpoint, nextSeq = 0;
let readyInFlight = false, readyAttempts = 0, preparedConfirmed = false, resourcesVerified = false, requestCount = 0, closed = false;
const pending = new Map();
async function request(path, body, expected = 200) {
  if (++requestCount > 40) throw new Error("QA_REQUEST_LIMIT");
  const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(12_000),
    ...(dispatcher ? { dispatcher } : {}), headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (response.status !== expected) { const error = new Error(typeof data.error?.code === "string" ? data.error.code : "QA_API_FAILED"); error.status = response.status; throw error; }
  if (path === "/api/session") cookie = response.headers.get("set-cookie").split(";")[0];
  return data;
}
function send(type, body) { socket.send(encodeControl({ v: 1, type, requestId: randomUUID(), ...(descriptor ? { contextTag: descriptor.contextTag } : {}), body })); }
function status() { return { roomId, phase: room?.phase ?? "CONNECTING", seat: room?.yourSeat, turn: room?.turn, moves: room?.moves, prepared: room?.members.find(item => item.seatId === room.yourSeat)?.prepared ?? false }; }
async function prepare() {
  const member = room?.members.find(item => item.seatId === room.yourSeat);
  if (!resourcesVerified || !descriptor || !room || readyInFlight || readyAttempts >= 3 || preparedConfirmed || room.phase !== "PREPARING" || member?.prepared) return;
  const attemptedRevision = room.revision;
  readyInFlight = true; readyAttempts += 1;
  try {
    await request(`/api/play/rooms/${roomId}/ready`, { requestId: randomUUID(), expectedMatchRevision: room.revision,
      resourcesReady: true, baselineReady: true, prepared: true, baseline: { descriptorId: descriptor.descriptorId, stateSeq: room.stateSeq } });
    preparedConfirmed = true;
    console.log(JSON.stringify({ status: "QA_PEER_PREPARED", ...status() }));
  } catch (error) { if (error.status !== 409) throw error; }
  finally {
    readyInFlight = false;
    if (!preparedConfirmed && room?.revision > attemptedRevision && readyAttempts < 3) queueMicrotask(() => { void prepare().catch(() => console.log(JSON.stringify({ status: "QA_PREPARE_FAILED" }))); });
  }
}
async function drop(column) {
  assert.ok(room?.phase === "RUNNING" && room.turn === room.yourSeat && !pending.size, "QA_PEER_NOT_CURRENT_TURN");
  assert.ok(Number.isSafeInteger(column) && column >= 0 && column < 7);
  const seq = nextSeq++;
  const bytes = encodeFrame({ header: { opcode: Opcode.COMMAND, flags: 0, streamId: 1, contextTag: context.contextTag, seq, tick: 0 },
    payload: { kind: "COMMAND", data: new TextEncoder().encode(JSON.stringify({ type: "drop", column })) } }, {
      context, senderEndpointId: endpoint, receiverEndpointId: descriptor.endpoints.find(item => item.endpointId !== endpoint).endpointId,
      nowMs: Date.now(), receivePositions: new Map([[1, seq]]) });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(seq); reject(new Error("QA_COMMAND_OUTCOME_UNKNOWN")); }, 10_000);
    pending.set(seq, { resolve, reject, timer }); socket.send(bytes);
  });
}
const expiry = setTimeout(() => { closed = true; input.close(); }, 600_000);
const input = createInterface({ input: process.stdin });
try {
  session = (await request("/api/session", {}, 201)).session;
  room = (await request(`/api/play/rooms/${roomId}/join`, { requestId: randomUUID() })).room;
  const { release } = await request(`/api/releases/${room.gameBuildId}`);
  for (const asset of release.assets.filter(item => release.requiredAssets.includes(item.path))) {
    const response = await fetch(asset.url, { ...(dispatcher ? { dispatcher } : {}), credentials: "omit", signal: AbortSignal.timeout(12_000), headers: { "User-Agent": headers["User-Agent"] } });
    assert.equal(response.status, 200); const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(bytes.byteLength, asset.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), asset.sha256);
  }
  resourcesVerified = true;
  const grant = await request(`/api/play/rooms/${roomId}/grant`, { requestId: randomUUID() });
  const credential=grant.joinTicket??grant.joinGrant, socketUrl=grant.wsUrl??grant.socketUrl;
  assert.equal(new URL(socketUrl).origin, origin.replace(/^http/, "ws"));
  socket = new WebSocket(socketUrl, { ...(dispatcher ? { dispatcher } : {}), headers: { Cookie: cookie, Origin: origin, "User-Agent": headers["User-Agent"] } });
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => send("AUTH_JOIN", { joinGrant: credential, profileId: "server-turn", profileVersion: 1, protocolVersions: [1] }));
  socket.addEventListener("message", event => {
    try {
      if (typeof event.data === "string") {
        const message = parseControl(event.data, { channel: "platform" });
        if (message.type === "AUTH_ACCEPTED") {
          descriptor = message.body.descriptors.find(item => item.roomId === roomId); endpoint = message.body.endpointId;
          assert.equal(descriptor.endpoints.find(item => item.endpointId === endpoint).inputSessionId, session.id);
          context = { descriptorId: descriptor.descriptorId, contextTag: BigInt(`0x${descriptor.contextTag}`), endpoints: descriptor.endpoints.map(item => item.endpointId),
            validFromMs: descriptor.validFromMs, validUntilMs: descriptor.validUntilMs, maxFrameBytes: descriptor.limits.maxFrameBytes, maxBulkBytes: 0,
            streams: descriptor.streams.map(item => ({ ...item, maxAhead: 0xffff_fffe, ...(item.kind === "STATE" ? { usesTick: false } : {}) })) };
          send("LINK_BIND", { descriptorId: descriptor.descriptorId, contextTag: descriptor.contextTag });
        } else if (message.type === "LINK_BOUND") nextSeq = message.body.receiveCursors.find(item => item.space === "COMMAND_SEQ").nextExpected;
        else if (message.type === "ACTION_RECEIPT") {
          const item = pending.get(message.body.commandSeq);
          if (item) { clearTimeout(item.timer); pending.delete(message.body.commandSeq); message.body.outcome.status === "COMMITTED" ? item.resolve() : item.reject(new Error("QA_ACTION_REJECTED")); }
        } else if (message.type === "PROTOCOL_ERROR") console.log(JSON.stringify({ status: "QA_PROTOCOL_ERROR", code: message.body.code }));
      } else {
        const frame = decodeFrame(new Uint8Array(event.data), { context, senderEndpointId: descriptor.endpoints.find(item => item.endpointId !== endpoint).endpointId, receiverEndpointId: endpoint, nowMs: Date.now() });
        assert.ok(frame.payload.kind === "STATE" && (frame.header.flags & FULL_STATE));
        room = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload.data));
        console.log(JSON.stringify({ status: "QA_STATE", ...status() }));
        void prepare().catch(() => console.log(JSON.stringify({ status: "QA_PREPARE_FAILED" })));
      }
    } catch { console.log(JSON.stringify({ status: "QA_MESSAGE_FAILED" })); }
  });
  socket.addEventListener("close", event => console.log(JSON.stringify({ status: "QA_SOCKET_CLOSED", code: event.code, phase: room?.phase })));
  socket.addEventListener("error", () => console.log(JSON.stringify({ status: "QA_SOCKET_ERROR" })));
  for await (const line of input) {
    if (closed || line.trim() === "quit") break;
    const match = /^drop ([0-6])$/.exec(line.trim());
    if (match) { try { await drop(Number(match[1])); console.log(JSON.stringify({ status: "QA_DROP_COMMITTED", ...status() })); } catch { console.log(JSON.stringify({ status: "QA_DROP_NOT_COMMITTED", ...status() })); } }
    else if (line.trim() === "status") console.log(JSON.stringify({ status: "QA_PEER_STATUS", ...status() }));
  }
} catch (error) { process.exitCode = 1; console.error(error instanceof Error && /^[A-Z0-9_: -]{1,96}$/.test(error.message) ? error.message : "QA_PEER_FAILED"); }
finally {
  closed = true; clearTimeout(expiry); input.close();
  if (socket?.readyState === WebSocket.OPEN) socket.close(1000, "QA_COMPLETE");
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("QA_PEER_CLOSED")); }
  if (cookie) { try { await request("/api/session/revoke", {}); } catch { console.error("QA_SESSION_REVOCATION_UNCONFIRMED"); process.exitCode = 1; } cookie = ""; }
  await dispatcher?.close();
  console.log(JSON.stringify({ status: "QA_PEER_STOPPED", requests: requestCount }));
}
