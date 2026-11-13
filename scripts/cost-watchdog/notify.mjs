import { createHash } from "node:crypto";

const BARK_ENDPOINT = "https://api.day.app/push";
const EMAIL_ENDPOINT = "https://api.resend.com/emails";
const ids = ["bark", "email-1", "email-2"];
const statuses = ["PLANNED", "DISABLED", "UNVERIFIED", "ACKNOWLEDGED", "FAILED", "UNCONFIRMED", "DEFERRED"];
const reasons = new Set([
  "PLAN_ONLY", "CHANNEL_DISABLED", "CHANNEL_UNVERIFIED", "PROVIDER_ACCEPTED_NOT_DELIVERED",
  "ALREADY_ACKNOWLEDGED", "PREVIOUS_RESULT_UNCONFIRMED", "ATTEMPT_STARTED", "CONFIGURATION_MISSING",
  "CONFIGURATION_INVALID", "CALL_BUDGET_EXHAUSTED", "TIME_BUDGET_EXHAUSTED", "ATTEMPT_LIMIT",
  "PROVIDER_REJECTED", "NETWORK_RESULT_UNKNOWN", "RESPONSE_RESULT_UNKNOWN", "IDEMPOTENCY_WINDOW_UNKNOWN",
  "IDEMPOTENCY_WINDOW_EXPIRED", "LEDGER_UNAVAILABLE",
]);
const result = (channel, status, reason, attempts) => Object.freeze({ channel, status, reason, attempts });
const identifier = value => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,192}$/.test(value);
const key = value => typeof value === "string" && value.length >= 8 && value.length <= 1024 && !/[\s\x00-\x1f\x7f]/.test(value);
const email = value => typeof value === "string" && value.length <= 254 && /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,63}$/.test(value);

function sender(value) {
  if (email(value)) return value;
  if (typeof value !== "string" || value.length > 320 || /[\r\n\x00]/.test(value)) return undefined;
  const match = /^([a-zA-Z0-9 ._-]{1,60}) <([^<>]+)>$/.exec(value);
  return match && email(match[2]) ? value : undefined;
}
function emailConfiguration(env, config) {
  const provider = config?.provider ?? "cloudflare";
  if (!["cloudflare", "resend"].includes(provider)) return { reason: "CONFIGURATION_INVALID" };
  const token = provider === "cloudflare" ? env.PWA_CF_EMAIL_TOKEN : env.PWA_RESEND_API_KEY;
  if (!token || !env.PWA_ALERT_EMAIL_FROM || !env.PWA_ALERT_EMAIL_TO) return { reason: "CONFIGURATION_MISSING" };
  let recipients;
  try { recipients = JSON.parse(env.PWA_ALERT_EMAIL_TO); } catch { return { reason: "CONFIGURATION_INVALID" }; }
  if (!key(token) || !sender(env.PWA_ALERT_EMAIL_FROM) || !Array.isArray(recipients) || recipients.length !== 2 || recipients.some(item => !email(item)) || new Set(recipients.map(item => item.toLowerCase())).size !== 2 || (provider === "cloudflare" && !/^[0-9a-f]{32}$/.test(config?.accountId ?? ""))) return { reason: "CONFIGURATION_INVALID" };
  return { apiKey: token, from: env.PWA_ALERT_EMAIL_FROM, recipients, provider, accountId: config?.accountId };
}
function previousFor(receipts, channel) {
  const matches = receipts.filter(item => item && item.channel === channel);
  if (matches.length > 1) throw new Error("NOTIFICATION_PREVIOUS_RECEIPTS_INVALID");
  const previous = matches[0];
  if (!previous) return undefined;
  if (!statuses.includes(previous.status) || !reasons.has(previous.reason) || !Number.isSafeInteger(previous.attempts) || previous.attempts < 0 || previous.attempts > 3) throw new Error("NOTIFICATION_PREVIOUS_RECEIPTS_INVALID");
  return result(channel, previous.status, previous.reason, previous.attempts);
}
/** Only operational fields are rendered. Extra source fields (cookies, SDP,
 * provider errors, recipient addresses, arbitrary recovery URLs) are discarded. */
function message(payload, testMode) {
  const environments = ["fixture", "preview", "production"];
  const states = ["NORMAL", "WARNING", "DRAINING", "BLOCKED"];
  const environment = environments.includes(payload?.environment) ? payload.environment : "unknown";
  const state = states.includes(payload?.state) ? payload.state : "UNKNOWN";
  const safeReasons = Array.isArray(payload?.reasons) ? payload.reasons.filter(value => typeof value === "string" && /^[a-zA-Z0-9._:-]{1,160}$/.test(value)).slice(0, 16) : [];
  const observations = Array.isArray(payload?.observed) ? payload.observed.slice(0, 16).flatMap(item => {
    if (!identifier(item?.id) || !["VALID", "STALE", "UNAVAILABLE"].includes(item?.quality)) return [];
    const unit = ["requests", "rows", "bytes", "count", "milliseconds", "USD-minor"].includes(item.unit) ? item.unit : "unknown";
    const amount = Number.isFinite(item.value) && item.value >= 0 ? item.value : "unknown";
    const warn = Number.isFinite(item.warn) && item.warn >= 0 ? item.warn : "unknown";
    const stop = Number.isFinite(item.stop) && item.stop >= 0 ? item.stop : "unknown";
    const through = Number.isSafeInteger(item.dataThrough) && item.dataThrough >= 0 && item.dataThrough <= 8_640_000_000_000_000 ? new Date(item.dataThrough).toISOString() : "unknown";
    return [`${item.id}: ${amount} ${unit}; quality=${item.quality}; warn=${warn}; stop=${stop}; through=${through}`];
  }) : [];
  const actions = Array.isArray(payload?.actions) ? payload.actions.slice(0, 12).flatMap(item => {
    const action = item?.action;
    const status = item?.status;
    if (!identifier(action) || !["ACKNOWLEDGED", "OBSERVED_STOPPED", "UNCONFIRMED", "FAILED", "DISPATCHED"].includes(status)) return [];
    return [`${action}: ${status}`];
  }) : [];
  return {
    title: `${testMode ? "[TEST] " : ""}PlayWithAnyone ${environment}: ${state}`,
    body: [
      `Environment: ${environment}; protection: ${state}`,
      `Reasons: ${safeReasons.join(", ") || "unavailable"}`,
      ...observations, ...actions,
      "Management: https://playwithanyone.com/api/ops/safety (authenticated operator CLI)",
      "API acceptance is not proof of device or inbox delivery.",
    ].join("\n").slice(0, 7000),
  };
}
async function boundedJson(response, maximumBytes) {
  if (!response.body) throw new Error("RESPONSE_RESULT_UNKNOWN");
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength; if (length > maximumBytes) throw new Error("RESPONSE_RESULT_UNKNOWN"); chunks.push(part.value); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { void reader.cancel().catch(() => {}); }
}

/**
 * Returns only {channel,status,reason,attempts}; never URLs, recipient addresses,
 * email IDs, credentials or raw provider errors. ACKNOWLEDGED means API accepted.
 *
 * The caller owns an event-scoped durable ledger. eventId, eventCreatedAt,
 * payload, and ordered email destinations must stay fixed for that event. Pass
 * its prior receipts on later runs. A new severity/repeat slot is a new event.
 * Resend idempotency lasts 24h: uncertain cross-run retries stop after 23h.
 * Bark and Cloudflare Email have no assumed idempotency: uncertain results
 * never auto-retry. Email provider defaults to cloudflare and requires its fixed
 * accountId in channels.email; Resend remains an explicitly selected adapter.
 *
 * mode defaults to plan. Explicit test bypasses verified only, never enabled.
 * reserveCall(channel) must synchronously grant each shared API-call slot.
 * Optional onReceipt persists the ATTEMPT_STARTED receipt before dispatch and
 * final receipt after it; root should use it to make crash recovery conservative.
 */
export async function notifyCostAlert({
  eventId, eventCreatedAt, payload, channels = {}, previousReceipts = [], mode = "plan",
  env = process.env, fetcher = fetch, now = Date.now, reserveCall,
  requestTimeoutMs = 3000, maxRunMs = 10000, maxResponseBytes = 8192, onReceipt,
} = {}) {
  if (!identifier(eventId) || !["plan", "send", "test"].includes(mode) || !Array.isArray(previousReceipts) || previousReceipts.length > 3 || typeof fetcher !== "function" || typeof now !== "function" || (onReceipt !== undefined && typeof onReceipt !== "function")) throw new Error("NOTIFICATION_CONFIG_INVALID");
  for (const [value, maximum] of [[requestTimeoutMs, 30_000], [maxRunMs, 60_000], [maxResponseBytes, 65_536]]) if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("NOTIFICATION_BOUNDS_INVALID");
  const started = now();
  if (!Number.isSafeInteger(started) || started < 0 || (eventCreatedAt !== undefined && (!Number.isSafeInteger(eventCreatedAt) || eventCreatedAt < 0 || eventCreatedAt > started))) throw new Error("NOTIFICATION_TIME_INVALID");
  for (const previous of previousReceipts) if (!ids.includes(previous?.channel)) throw new Error("NOTIFICATION_PREVIOUS_RECEIPTS_INVALID");
  for (const config of [channels.bark, channels.email]) if (config?.maxAttempts !== undefined && (!Number.isSafeInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 3)) throw new Error("NOTIFICATION_BOUNDS_INVALID");
  for (const id of ids) previousFor(previousReceipts, id);
  const content = message(payload, mode === "test"), emailConfig = emailConfiguration(env, channels.email);
  const remaining = () => { const current = now(); return Number.isSafeInteger(current) && current >= started ? Math.max(0, maxRunMs - (current - started)) : 0; };
  let localCalls = 0;
  const grant = reserveCall ?? (() => ++localCalls <= 5);
  if (typeof grant !== "function") throw new Error("NOTIFICATION_CONFIG_INVALID");
  async function checkpoint(receipt) {
    if (!onReceipt) return true;
    let timer;
    try {
      const time = remaining(); if (time < 1) return false;
      await Promise.race([Promise.resolve().then(() => onReceipt(receipt)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("LEDGER_TIMEOUT")), time); })]);
      return true;
    } catch { return false; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async function perform(channel, attempts, request) {
    if (remaining() < 1) return { receipt: result(channel, "DEFERRED", "TIME_BUDGET_EXHAUSTED", attempts), retryable: false };
    try { if (grant(channel) !== true) return { receipt: result(channel, "DEFERRED", "CALL_BUDGET_EXHAUSTED", attempts), retryable: false }; }
    catch { return { receipt: result(channel, "DEFERRED", "CALL_BUDGET_EXHAUSTED", attempts), retryable: false }; }
    const next = attempts + 1;
    if (!await checkpoint(result(channel, "UNCONFIRMED", "ATTEMPT_STARTED", next))) return { receipt: result(channel, "FAILED", "LEDGER_UNAVAILABLE", attempts), retryable: false };
    const time = Math.min(requestTimeoutMs, remaining());
    if (time < 1) return { receipt: result(channel, "DEFERRED", "TIME_BUDGET_EXHAUSTED", attempts), retryable: false };
    const controller = new AbortController(); let timer;
    try {
      const work = (async () => {
        const response = await fetcher(request.url, { ...request.options, redirect: "error", signal: controller.signal });
        // Reject redirects; fixed HTTPS endpoints never put a secret in a URL.
        if (response.status < 200 || response.status >= 300) {
          void response.body?.cancel().catch(() => {});
          const definite = response.status >= 400 && response.status < 500 && response.status !== 408;
          return { receipt: result(channel, definite ? "FAILED" : "UNCONFIRMED", definite ? "PROVIDER_REJECTED" : "RESPONSE_RESULT_UNKNOWN", next), retryable: request.idempotent && ([408, 425, 429].includes(response.status) || response.status >= 500) };
        }
        const body = await boundedJson(response, maxResponseBytes);
        if (channel === "bark") {
          if (body?.code === 200) return { receipt: result(channel, "ACKNOWLEDGED", "PROVIDER_ACCEPTED_NOT_DELIVERED", next), retryable: false };
          if (Number.isInteger(body?.code) && body.code >= 400 && body.code < 500) return { receipt: result(channel, "FAILED", "PROVIDER_REJECTED", next), retryable: false };
          return { receipt: result(channel, "UNCONFIRMED", "RESPONSE_RESULT_UNKNOWN", next), retryable: false };
        }
        if (request.provider === "cloudflare") {
          const delivered = body?.result?.delivered, queued = body?.result?.queued, bounced = body?.result?.permanent_bounces;
          if (body?.success === true && Array.isArray(delivered) && Array.isArray(queued) && Array.isArray(bounced)) {
            if (bounced.includes(request.recipient)) return { receipt: result(channel, "FAILED", "PROVIDER_REJECTED", next), retryable: false };
            if (delivered.includes(request.recipient) || queued.includes(request.recipient)) return { receipt: result(channel, "ACKNOWLEDGED", "PROVIDER_ACCEPTED_NOT_DELIVERED", next), retryable: false };
          }
          if (body?.success === false) return { receipt: result(channel, "FAILED", "PROVIDER_REJECTED", next), retryable: false };
          return { receipt: result(channel, "UNCONFIRMED", "RESPONSE_RESULT_UNKNOWN", next), retryable: false };
        }
        if (typeof body?.id === "string" && body.id.length > 0 && body.id.length <= 256) return { receipt: result(channel, "ACKNOWLEDGED", "PROVIDER_ACCEPTED_NOT_DELIVERED", next), retryable: false };
        return { receipt: result(channel, "UNCONFIRMED", "RESPONSE_RESULT_UNKNOWN", next), retryable: true };
      })();
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("NETWORK_RESULT_UNKNOWN")); }, time); });
      return await Promise.race([work, timeout]);
    } catch { return { receipt: result(channel, "UNCONFIRMED", "NETWORK_RESULT_UNKNOWN", next), retryable: request.idempotent }; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async function run(channel) {
    const previous = previousFor(previousReceipts, channel), attempts = previous?.attempts ?? 0;
    const config = channel === "bark" ? channels.bark : channels.email;
    const maxAttempts = config?.maxAttempts ?? (channel === "bark" ? 2 : 3);
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("NOTIFICATION_BOUNDS_INVALID");
    if (previous?.status === "ACKNOWLEDGED") return result(channel, "ACKNOWLEDGED", "ALREADY_ACKNOWLEDGED", attempts);
    const idempotent = channel !== "bark" && emailConfig.provider === "resend";
    if (!idempotent && previous?.status === "UNCONFIRMED") return result(channel, "UNCONFIRMED", "PREVIOUS_RESULT_UNCONFIRMED", attempts);
    if (!config || config.enabled !== true) return result(channel, "DISABLED", "CHANNEL_DISABLED", attempts);
    if (mode === "plan") return result(channel, "PLANNED", "PLAN_ONLY", attempts);
    if (config.verified !== true && mode !== "test") return result(channel, "UNVERIFIED", "CHANNEL_UNVERIFIED", attempts);
    if (attempts >= maxAttempts) return result(channel, previous?.status === "UNCONFIRMED" ? "UNCONFIRMED" : "FAILED", "ATTEMPT_LIMIT", attempts);
    if (idempotent && attempts > 0) {
      if (eventCreatedAt === undefined) return result(channel, "DEFERRED", "IDEMPOTENCY_WINDOW_UNKNOWN", attempts);
      if (started - eventCreatedAt >= 23 * 60 * 60 * 1000) return result(channel, "DEFERRED", "IDEMPOTENCY_WINDOW_EXPIRED", attempts);
    }
    let request;
    if (channel === "bark") {
      if (!env.PWA_BARK_DEVICE_KEY) return result(channel, "FAILED", "CONFIGURATION_MISSING", attempts);
      if (!key(env.PWA_BARK_DEVICE_KEY)) return result(channel, "FAILED", "CONFIGURATION_INVALID", attempts);
      request = { url: BARK_ENDPOINT, idempotent: false, options: { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", Accept: "application/json" }, body: JSON.stringify({ device_key: env.PWA_BARK_DEVICE_KEY, title: content.title, body: content.body, group: "PlayWithAnyone cost alerts" }) } };
    } else {
      if (emailConfig.reason) return result(channel, "FAILED", emailConfig.reason, attempts);
      const recipient = emailConfig.recipients[channel === "email-1" ? 0 : 1];
      if (emailConfig.provider === "cloudflare") {
        request = { url: `https://api.cloudflare.com/client/v4/accounts/${emailConfig.accountId}/email/sending/send`, provider: "cloudflare", recipient, idempotent: false, options: { method: "POST", headers: { Authorization: `Bearer ${emailConfig.apiKey}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ from: emailConfig.from, to: recipient, subject: content.title, text: content.body }) } };
      } else {
        const idempotency = `pwa-cost-${createHash("sha256").update(JSON.stringify([eventId, channel, emailConfig.from, recipient])).digest("hex")}`;
        request = { url: EMAIL_ENDPOINT, provider: "resend", recipient, idempotent: true, options: { method: "POST", headers: { Authorization: `Bearer ${emailConfig.apiKey}`, "Content-Type": "application/json", Accept: "application/json", "Idempotency-Key": idempotency }, body: JSON.stringify({ from: emailConfig.from, to: [recipient], subject: content.title, text: content.body }) } };
      }
    }
    let current = attempts;
    for (;;) {
      const attempted = await perform(channel, current, request);
      current = attempted.receipt.attempts;
      if (!await checkpoint(attempted.receipt)) {
        // Even if provider accepted, an absent durable receipt makes automatic
        // retransmission unsafe. Expose uncertainty, never raw checkpoint errors.
        return result(channel, "UNCONFIRMED", "LEDGER_UNAVAILABLE", current);
      }
      if (!request.idempotent || !attempted.retryable || current >= maxAttempts) return attempted.receipt;
    }
  }
  // Three independent targets start concurrently; one provider failure cannot
  // prevent the other provider/recipient from trying its reserved call slot.
  return Promise.all(ids.map(run));
}
