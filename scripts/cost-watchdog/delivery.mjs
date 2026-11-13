import { createHash } from "node:crypto";
import { notificationPayload } from "./core.mjs";
import { notifyCostAlert } from "./notify.mjs";

/** One bounded, persisted outbox. A failed recipient never resends accepted peers.
 * saveState must atomically persist the supplied snapshot before resolving. */
export async function deliverEvaluation({ evaluation, config, saveState, env = process.env, fetcher = fetch,
  now = Date.now, reserveCall, maxRunMs = config.maxRunMs, mode = "send" }) {
  const timestamp = now(), channels = config.notifications ?? {};
  const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const targets = digest([channels.bark?.enabled === true ? env.PWA_BARK_DEVICE_KEY : null,
    channels.email?.enabled === true ? [channels.email.provider, channels.email.accountId, env.PWA_ALERT_EMAIL_FROM, env.PWA_ALERT_EMAIL_TO] : null]);
  const stopFailures = evaluation.state.receipts.filter(item => item.status === "FAILED" || item.status === "UNCONFIRMED")
    .map(item => item.action).filter(action => !action.startsWith("notify")).sort();
  const key = digest([evaluation.state.incidentId, evaluation.state.state, targets, stopFailures]);
  let outbox = evaluation.state.notificationOutbox;
  if (outbox && (!Number.isSafeInteger(outbox.createdAt) || outbox.createdAt > timestamp || !Array.isArray(outbox.receipts))) throw new Error("NOTIFICATION_OUTBOX_INVALID");
  if (!outbox || outbox.key !== key || timestamp - outbox.createdAt >= config.notificationRepeatMs) {
    outbox = { key, eventId: `cost-${key.slice(0, 24)}-${timestamp}`, createdAt: timestamp,
      payload: notificationPayload(evaluation, config), receipts: [] };
    evaluation.state.notificationOutbox = outbox;
  }
  // Notify targets run concurrently; serialize their file checkpoints so that
  // atomic rename cannot race and all in-flight outcomes survive a crash.
  let writes = Promise.resolve();
  const persist = () => {
    const snapshot = structuredClone(evaluation.state);
    const pending = writes.then(() => saveState(snapshot));
    writes = pending.catch(() => {});
    return pending;
  };
  if (mode !== "plan") await persist();
  const receipts = await notifyCostAlert({ eventId: outbox.eventId, eventCreatedAt: outbox.createdAt, payload: outbox.payload,
    channels, previousReceipts: outbox.receipts, mode, env, fetcher, now, reserveCall,
    requestTimeoutMs: config.notificationRequestTimeoutMs ?? config.requestTimeoutMs, maxRunMs: Math.min(60_000, Math.max(1, maxRunMs)), maxResponseBytes: Math.min(65_536, config.maxResponseBytes),
    ...(mode === "plan" ? {} : { onReceipt: async receipt => {
      outbox.receipts = [...outbox.receipts.filter(item => item.channel !== receipt.channel), receipt];
      await persist();
    } }) });
  outbox.receipts = receipts;
  const required = [...(channels.bark?.enabled ? ["bark"] : []), ...(channels.email?.enabled ? ["email-1", "email-2"] : [])];
  const allAccepted = required.length > 0 && required.every(channel => receipts.some(item => item.channel === channel && item.status === "ACKNOWLEDGED"));
  if (allAccepted) evaluation.state.lastNotification = { incidentId: evaluation.state.incidentId, level: evaluation.state.state, at: outbox.createdAt };
  if (mode !== "plan") await persist();
  return receipts;
}
