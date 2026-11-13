// One explicit connectivity test, with a durable receipt. Re-running the same
// state file never blindly resends a Bark/Cloudflare request of unknown outcome.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { notifyCostAlert } from "./notify.mjs";

const args = process.argv.slice(2), flags = {};
for (let index = 0; index < args.length; index++) {
  const key = args[index];
  if (!["--apply", "--config", "--channel", "--state"].includes(key) || Object.hasOwn(flags, key)) throw new Error("NOTIFICATION_ARGUMENT_INVALID");
  flags[key] = key === "--apply" ? true : args[++index];
}
const channel = flags["--channel"] ?? "bark";
if (!["bark", "email", "all"].includes(channel)) throw new Error("NOTIFICATION_CHANNEL_INVALID");
const config = JSON.parse(await readFile(flags["--config"] ?? "configs/safety.watchdog.preview.json", "utf8"));
const channels = structuredClone(config.notifications ?? {});
if (channel === "bark") channels.email = { ...channels.email, enabled: false };
if (channel === "email") channels.bark = { ...channels.bark, enabled: false };
const apply = flags["--apply"] === true;
const statePath = flags["--state"] ?? `artifacts/cost/notification-test-${channel}.json`;
const targets = createHash("sha256").update(JSON.stringify([
  channels.bark?.enabled ? process.env.PWA_BARK_DEVICE_KEY : null,
  channels.email?.enabled ? [channels.email.provider, channels.email.accountId, process.env.PWA_ALERT_EMAIL_FROM, process.env.PWA_ALERT_EMAIL_TO] : null
])).digest("hex");
await mkdir(path.dirname(statePath), { recursive: true }); let lock;
try {
  if (apply) lock = await open(`${statePath}.lock`, "wx", 0o600);
  let state;
  try { state = JSON.parse(await readFile(statePath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  state ??= { eventId: `notification-test-${randomUUID()}`, eventCreatedAt: Date.now(), targets, receipts: [] };
  if (state.targets !== targets) throw new Error("NOTIFICATION_TEST_TARGET_CHANGED_USE_NEW_STATE");
  let writes = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(state, null, 2) + "\n";
    const pending = writes.then(async () => {
      const temporary = `${statePath}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 }); await rename(temporary, statePath);
    });
    writes = pending.catch(() => {}); return pending;
  };
  if (apply) await save();
  let calls = 0;
  const receipts = await notifyCostAlert({ eventId: state.eventId, eventCreatedAt: state.eventCreatedAt,
    payload: { environment: config.environment, state: "NORMAL", reasons: ["CHANNEL_CONNECTIVITY_TEST_NO_INCIDENT"], observed: [], actions: [] },
    channels, previousReceipts: state.receipts, mode: apply ? "test" : "plan",
    requestTimeoutMs: Math.min(20_000, config.notificationRequestTimeoutMs ?? config.requestTimeoutMs), maxRunMs: 30_000,
    reserveCall: () => ++calls <= 3,
    ...(apply ? { onReceipt: async receipt => {
      state.receipts = [...state.receipts.filter(item => item.channel !== receipt.channel), receipt]; await save();
    } } : {}) });
  state.receipts = receipts; state.checkedAt = new Date().toISOString();
  if (apply) await save();
  console.log(JSON.stringify({ applied: apply, state: statePath, receipts, automatedWatchdogEnabled: config.enabled === true,
    deviceOrInboxDeliveryVerified: false }, null, 2));
  if (apply && receipts.some(item => !["ACKNOWLEDGED", "DISABLED"].includes(item.status))) process.exitCode = 2;
} finally { if (lock) { await lock.close(); await unlink(`${statePath}.lock`); } }
