import assert from "node:assert/strict";
import test from "node:test";
import { notifyCostAlert } from "../../../scripts/cost-watchdog/notify.mjs";

const accountId = "0".repeat(32);
const env = Object.freeze({
  PWA_BARK_DEVICE_KEY: "fixture-bark-device-key-only",
  PWA_CF_EMAIL_TOKEN: "fixture-cloudflare-email-token-only",
  PWA_RESEND_API_KEY: "fixture-resend-key-only",
  PWA_ALERT_EMAIL_FROM: "PlayWithAnyone <alerts@example.test>",
  PWA_ALERT_EMAIL_TO: JSON.stringify(["alert-a@example.test", "alert-b@example.test"]),
});
const channels = Object.freeze({ bark: { enabled: true, verified: true }, email: { enabled: true, verified: true, provider: "cloudflare", accountId } });
const payload = Object.freeze({ environment: "preview", state: "WARNING", reasons: ["shell-requests:WARNING_THRESHOLD"], observed: [{ id: "shell-requests", quality: "VALID", value: 12, warn: 10, stop: 20, unit: "requests", dataThrough: 10_000 }], actions: [{ action: "persist-and-propagate", status: "ACKNOWLEDGED" }] });
function options(change = {}) { return { eventId: "fixture-incident:WARNING:1", eventCreatedAt: 9000, payload, channels, mode: "send", env, now: () => 10_000, ...change }; }
function accepted(url, request) {
  const body = JSON.parse(request.body);
  return url === "https://api.day.app/push" ? Response.json({ code: 200, message: "success" }) : Response.json({ success: true, errors: [], result: { delivered: [], queued: [body.to], permanent_bounces: [] } });
}
const byChannel = (receipts, id) => receipts.find(item => item.channel === id);
function safeReceipts(receipts) {
  for (const receipt of receipts) assert.deepEqual(Object.keys(receipt).sort(), ["attempts", "channel", "reason", "status"]);
  const rendered = JSON.stringify(receipts);
  for (const value of [env.PWA_BARK_DEVICE_KEY, env.PWA_CF_EMAIL_TOKEN, env.PWA_RESEND_API_KEY, "alert-a@example.test", "alert-b@example.test", "provider-private-error", "provider-email-id"]) assert.equal(rendered.includes(value), false);
}

test("COST-19 notification defaults to plan; test bypasses verified only and never disabled", async () => {
  let calls = 0;
  const fetcher = async (url, request) => { calls += 1; assert.ok(JSON.parse(request.body).title?.startsWith("[TEST]") ?? JSON.parse(request.body).subject.startsWith("[TEST]")); return accepted(url, request); };
  const planned = await notifyCostAlert({ eventId: "fixture-plan", payload, channels, env, fetcher });
  assert.ok(planned.every(item => item.status === "PLANNED")); assert.equal(calls, 0);
  const unverifiedChannels = { bark: { enabled: true, verified: false }, email: { enabled: false, verified: false, accountId } };
  const blocked = await notifyCostAlert(options({ channels: unverifiedChannels, fetcher }));
  assert.equal(byChannel(blocked, "bark").status, "UNVERIFIED"); assert.equal(calls, 0);
  const tested = await notifyCostAlert(options({ mode: "test", channels: unverifiedChannels, fetcher }));
  assert.equal(byChannel(tested, "bark").status, "ACKNOWLEDGED"); assert.equal(byChannel(tested, "email-1").status, "DISABLED"); assert.equal(calls, 1);
});

test("COST-19 fixed HTTPS JSON endpoints keep keys out of URL and send two recipients independently", async () => {
  const sent = [];
  const receipts = await notifyCostAlert(options({ fetcher: async (url, request) => { sent.push({ url, request, body: JSON.parse(request.body) }); return accepted(url, request); } }));
  assert.equal(sent.length, 3); assert.ok(receipts.every(item => item.status === "ACKNOWLEDGED"));
  const bark = sent.find(item => item.url === "https://api.day.app/push");
  assert.equal(bark.body.device_key, env.PWA_BARK_DEVICE_KEY); assert.equal(bark.request.headers.Authorization, undefined); assert.equal(bark.request.redirect, "error");
  const emails = sent.filter(item => item !== bark);
  assert.ok(emails.every(item => item.url === `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`));
  assert.deepEqual(emails.map(item => item.body.to).sort(), ["alert-a@example.test", "alert-b@example.test"]);
  assert.ok(emails.every(item => typeof item.body.to === "string" && !item.body.text.includes("alert-a@example.test") && !item.body.text.includes("alert-b@example.test")));
  safeReceipts(receipts);
});

test("COST-19 a Bark network ambiguity does not prevent email and cannot blindly retry next run", async () => {
  let barkCalls = 0, emailCalls = 0;
  const fetcher = async (url, request) => { if (url === "https://api.day.app/push") { barkCalls += 1; throw new Error(`provider-private-error ${env.PWA_BARK_DEVICE_KEY}`); } emailCalls += 1; return accepted(url, request); };
  const first = await notifyCostAlert(options({ fetcher }));
  assert.equal(byChannel(first, "bark").status, "UNCONFIRMED"); assert.equal(emailCalls, 2);
  const second = await notifyCostAlert(options({ previousReceipts: first, fetcher }));
  assert.equal(barkCalls, 1); assert.equal(emailCalls, 2);
  assert.equal(byChannel(second, "bark").reason, "PREVIOUS_RESULT_UNCONFIRMED"); assert.equal(byChannel(second, "email-1").reason, "ALREADY_ACKNOWLEDGED");
  safeReceipts(second);
});

test("COST-19 CF acceptance requires this recipient; queued differs from inbox receipt and bounces are independent", async () => {
  let calls = 0;
  const first = await notifyCostAlert(options({ fetcher: async (url, request) => {
    calls += 1; const body = JSON.parse(request.body);
    if (url === "https://api.day.app/push") return Response.json({ code: 200 });
    return body.to === "alert-a@example.test" ? Response.json({ success: true, result: { delivered: [], queued: [], permanent_bounces: [body.to] } }) : accepted(url, request);
  } }));
  assert.equal(byChannel(first, "email-1").status, "FAILED"); assert.equal(byChannel(first, "email-2").reason, "PROVIDER_ACCEPTED_NOT_DELIVERED");
  const second = await notifyCostAlert(options({ previousReceipts: first, fetcher: async (url, request) => { calls += 1; return accepted(url, request); } }));
  assert.equal(calls, 4); assert.equal(byChannel(second, "email-1").attempts, 2); assert.equal(byChannel(second, "email-2").attempts, 1);
  const wrongRecipient = await notifyCostAlert(options({ channels: { email: channels.email }, fetcher: async () => Response.json({ success: true, result: { delivered: ["different@example.test"], queued: [], permanent_bounces: [] } }) }));
  assert.equal(byChannel(wrongRecipient, "email-1").status, "UNCONFIRMED");
});

test("COST-19 CF uncertain response and missing credentials never fall back to Resend or retry blindly", async () => {
  let calls = 0;
  const uncertain = await notifyCostAlert(options({ channels: { email: channels.email }, fetcher: async () => { calls += 1; return new Response("provider-private-error", { status: 503 }); } }));
  assert.equal(calls, 2); assert.equal(byChannel(uncertain, "email-1").status, "UNCONFIRMED");
  await notifyCostAlert(options({ channels: { email: channels.email }, previousReceipts: uncertain, fetcher: async () => { throw new Error("must not send"); } }));
  const missing = await notifyCostAlert(options({ env: { ...env, PWA_CF_EMAIL_TOKEN: undefined }, fetcher: async (url, request) => { calls += 1; return accepted(url, request); } }));
  assert.equal(byChannel(missing, "email-1").reason, "CONFIGURATION_MISSING"); assert.equal(calls, 3);
  safeReceipts(uncertain); safeReceipts(missing);
});

test("COST-19 Resend uses fixed per-event recipient idempotency keys and cumulative attempt bounds", async () => {
  const keys = new Map(); let attempts = 0;
  const resendChannels = { email: { enabled: true, verified: true, provider: "resend", maxAttempts: 3 } };
  const receipts = await notifyCostAlert(options({ channels: resendChannels, fetcher: async (url, request) => {
    assert.equal(url, "https://api.resend.com/emails"); const body = JSON.parse(request.body); assert.equal(body.to.length, 1);
    const recipient = body.to[0]; const id = request.headers["Idempotency-Key"];
    assert.match(id, /^pwa-cost-[a-f0-9]{64}$/); assert.equal(id.includes(recipient), false);
    if (keys.has(recipient)) assert.equal(keys.get(recipient), id); else keys.set(recipient, id);
    attempts += 1;
    if (attempts <= 2) throw new Error("provider-private-error");
    return Response.json({ id: "provider-email-id" });
  } }));
  assert.equal(keys.size, 2); assert.equal(new Set(keys.values()).size, 2); assert.ok(receipts.filter(item => item.channel !== "bark").every(item => item.status === "ACKNOWLEDGED" && item.attempts === 2));
  safeReceipts(receipts);
});

test("COST-19 same-event Resend retry requires a known unexpired idempotency window", async () => {
  const resendChannels = { email: { enabled: true, verified: true, provider: "resend", maxAttempts: 2 } };
  const prior = [{ channel: "email-1", status: "UNCONFIRMED", reason: "NETWORK_RESULT_UNKNOWN", attempts: 1 }]; let calls = 0;
  const fetcher = async () => { calls += 1; return Response.json({ id: "provider-email-id" }); };
  const expired = await notifyCostAlert(options({ channels: resendChannels, previousReceipts: prior, eventCreatedAt: 0, now: () => 24 * 60 * 60 * 1000, fetcher }));
  assert.equal(byChannel(expired, "email-1").reason, "IDEMPOTENCY_WINDOW_EXPIRED"); assert.equal(calls, 1);
  const unknown = await notifyCostAlert(options({ channels: resendChannels, previousReceipts: prior, eventCreatedAt: undefined, fetcher }));
  assert.equal(byChannel(unknown, "email-1").reason, "IDEMPOTENCY_WINDOW_UNKNOWN");
});

test("COST-19 shared call/time budget and bounded response protect every notification target", async () => {
  let slots = 0, calls = 0;
  const limited = await notifyCostAlert(options({ reserveCall: () => ++slots <= 2, fetcher: async (url, request) => { calls += 1; return accepted(url, request); } }));
  assert.equal(calls, 2); assert.equal(byChannel(limited, "email-2").reason, "CALL_BUDGET_EXHAUSTED");
  const oversized = await notifyCostAlert(options({ channels: { bark: channels.bark }, maxResponseBytes: 8, fetcher: async () => Response.json({ code: 200, message: "too large" }) }));
  assert.equal(byChannel(oversized, "bark").status, "UNCONFIRMED");
  let clockCalls = 0;
  const expired = await notifyCostAlert(options({ now: () => ++clockCalls === 1 ? 10_000 : 100_000, fetcher: async () => { throw new Error("must not call"); } }));
  assert.ok(expired.every(item => item.reason === "TIME_BUDGET_EXHAUSTED"));
});

test("COST-19 an ignored AbortSignal still returns a bounded unknown outcome without retry", async () => {
  let calls = 0;
  const receipt = await notifyCostAlert(options({ channels: { bark: channels.bark }, requestTimeoutMs: 10, maxRunMs: 25, fetcher: async () => { calls += 1; return new Promise(() => {}); } }));
  assert.equal(calls, 1); assert.equal(byChannel(receipt, "bark").status, "UNCONFIRMED");
});

test("COST-19 durable outbox checkpoint precedes dispatch; ledger failure never resends known acceptance", async () => {
  const checkpoints = []; let calls = 0;
  const first = await notifyCostAlert(options({ channels: { bark: channels.bark }, onReceipt: async receipt => { checkpoints.push(receipt); }, fetcher: async (url, request) => { assert.equal(checkpoints[0].status, "UNCONFIRMED"); assert.equal(checkpoints[0].reason, "ATTEMPT_STARTED"); calls += 1; return accepted(url, request); } }));
  assert.equal(calls, 1); assert.equal(checkpoints.length, 2); assert.equal(byChannel(first, "bark").status, "ACKNOWLEDGED");
  const blocked = await notifyCostAlert(options({ channels: { bark: channels.bark }, onReceipt: async () => { throw new Error("fixture disk unavailable"); }, fetcher: async () => { throw new Error("must not send"); } }));
  assert.equal(byChannel(blocked, "bark").reason, "LEDGER_UNAVAILABLE"); assert.equal(byChannel(blocked, "bark").attempts, 0);
  let checkpointsCount = 0;
  const lostReceipt = await notifyCostAlert(options({ channels: { bark: channels.bark }, onReceipt: async () => { if (++checkpointsCount > 1) throw new Error("fixture disk unavailable"); }, fetcher: accepted }));
  assert.equal(byChannel(lostReceipt, "bark").status, "UNCONFIRMED");
  await notifyCostAlert(options({ channels: { bark: channels.bark }, previousReceipts: lostReceipt, fetcher: async () => { throw new Error("must not resend"); } }));
});

test("COST-19 receipts and outgoing content exclude private source fields and raw provider response details", async () => {
  const extra = { ...payload, Cookie: "private-cookie-value", token: env.PWA_RESEND_API_KEY, recoveryEntry: `https://example.test/${env.PWA_BARK_DEVICE_KEY}`, actions: [...payload.actions, { action: "bad email@example.test", status: "provider-private-error" }] };
  const receipts = await notifyCostAlert(options({ payload: extra, fetcher: async (url, request) => {
    for (const value of ["private-cookie-value", env.PWA_RESEND_API_KEY, "provider-private-error"]) assert.equal(request.body.includes(value), false);
    return url === "https://api.day.app/push" ? Response.json({ code: 403, message: "provider-private-error" }) : new Response("provider-private-error", { status: 403 });
  } }));
  assert.ok(receipts.every(item => item.status === "FAILED")); safeReceipts(receipts);
});
