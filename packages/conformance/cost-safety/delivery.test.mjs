import assert from "node:assert/strict";
import test from "node:test";
import { deliverEvaluation } from "../../../scripts/cost-watchdog/delivery.mjs";

const accountId = "0".repeat(32);
const config = {
  notifications: { bark: { enabled: true, verified: true }, email: { enabled: true, verified: true, provider: "cloudflare", accountId } },
  notificationRepeatMs: 3_600_000, maxRunMs: 10_000, requestTimeoutMs: 1000, maxResponseBytes: 8192,
  environment: "fixture", accountId, management: null,
};
const env = { PWA_BARK_DEVICE_KEY: "fixture-device-only", PWA_CF_EMAIL_TOKEN: "fixture-token-only",
  PWA_ALERT_EMAIL_FROM: "alerts@example.com", PWA_ALERT_EMAIL_TO: '["first@example.com","second@example.com"]' };
function evaluation() { return { state: { incidentId: "fixture-incident", state: "WARNING", receipts: [{ action: "persist-and-propagate", status: "ACKNOWLEDGED" }] }, observations: [] }; }
function accepted(recipient) { return Response.json({ success: true, result: { delivered: [], queued: [recipient], permanent_bounces: [] } }); }

test("notification outbox persists dispatch first, serializes concurrent writes and retries only the failed email", async () => {
  let saved, writing = false, tick = 10000; const calls = [];
  const saveState = async snapshot => {
    assert.equal(writing, false); writing = true;
    await new Promise(resolve => setImmediate(resolve)); saved = snapshot; writing = false;
  };
  const value = evaluation();
  const fetcher = async (url, options) => {
    const body = JSON.parse(options.body), channel = url.includes("api.day.app") ? "bark" : body.to === "first@example.com" ? "email-1" : "email-2";
    assert.ok(saved.notificationOutbox.receipts.some(item => item.channel === channel && item.status === "UNCONFIRMED" && item.reason === "ATTEMPT_STARTED"));
    calls.push(channel);
    if (channel === "bark") return Response.json({ code: 200 });
    if (channel === "email-1" && tick === 10000) return Response.json({ success: false }, { status: 429 });
    return accepted(body.to);
  };
  const first = await deliverEvaluation({ evaluation: value, config, env, fetcher, now: () => tick, saveState });
  assert.equal(first.find(item => item.channel === "email-1").status, "FAILED");
  assert.equal(value.state.lastNotification, undefined);
  const eventId = saved.notificationOutbox.eventId;
  tick = 11000;
  // Simulate a fresh process reading the durable file after the failed recipient.
  const next = { ...evaluation(), state: structuredClone(saved) };
  const second = await deliverEvaluation({ evaluation: next, config, env, fetcher, now: () => tick, saveState });
  assert.deepEqual(calls.sort(), ["bark", "email-1", "email-1", "email-2"]);
  assert.ok(second.every(item => item.status === "ACKNOWLEDGED"));
  assert.equal(saved.notificationOutbox.eventId, eventId);
  assert.equal(next.state.lastNotification.incidentId, "fixture-incident");
  const report = JSON.stringify(saved);
  for (const secret of Object.values(env)) assert.equal(report.includes(secret), false);
});

test("unknown non-idempotent outcome survives restart and does not resend until the explicit repeat window", async () => {
  let saved, calls = 0, tick = 10000;
  const barkOnly = { ...config, notifications: { ...config.notifications, email: { enabled: false } } };
  const fetcher = async () => { calls++; throw new Error("fixture private provider error"); };
  const saveState = async snapshot => { saved = snapshot; };
  const first = evaluation();
  await deliverEvaluation({ evaluation: first, config: barkOnly, env, fetcher, now: () => tick, saveState });
  const eventId = saved.notificationOutbox.eventId;
  tick++;
  await deliverEvaluation({ evaluation: { ...evaluation(), state: structuredClone(saved) }, config: barkOnly, env, fetcher, now: () => tick, saveState });
  assert.equal(calls, 1);
  assert.equal(saved.notificationOutbox.eventId, eventId);
  tick += config.notificationRepeatMs;
  await deliverEvaluation({ evaluation: { ...evaluation(), state: structuredClone(saved) }, config: barkOnly, env, fetcher, now: () => tick, saveState });
  assert.equal(calls, 2);
  assert.notEqual(saved.notificationOutbox.eventId, eventId);
  assert.equal(JSON.stringify(saved).includes("private provider error"), false);
});
