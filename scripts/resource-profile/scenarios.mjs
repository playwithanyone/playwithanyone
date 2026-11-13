// Scenario-specific workload; official resource metrics are supplied by the owner separately.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { MeasurementClients, createBudget, safeCode } from "./clients.mjs";

const requireValue = (value, code) => { if (!value) throw new Error(code); };
const immutableShape = room => ({ phase: room.phase, revision: room.revision, stateSeq: room.stateSeq, moves: room.moves, board: room.board, turn: room.turn, result: room.result });
const sha = value => createHash("sha256").update(value).digest("hex");
function validateSequence(columns, expectedResult) {
  requireValue(Array.isArray(columns) && columns.length > 0 && columns.length <= 42, "RESOURCE_SEQUENCE_INVALID");
  const board = Array(42).fill(0); let result = null;
  for (let index = 0; index < columns.length; index++) {
    const column = columns[index], player = index % 2 + 1;
    requireValue(Number.isSafeInteger(column) && column >= 0 && column < 7 && result === null, "RESOURCE_SEQUENCE_INVALID");
    let row = 5; while (row >= 0 && board[row * 7 + column]) row--;
    requireValue(row >= 0, "RESOURCE_SEQUENCE_FULL_COLUMN"); board[row * 7 + column] = player;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      let length = 1;
      for (const sign of [-1, 1]) {
        let r = row + sign * dr, c = column + sign * dc;
        while (r >= 0 && r < 6 && c >= 0 && c < 7 && board[r * 7 + c] === player) { length++; r += sign * dr; c += sign * dc; }
      }
      if (length >= 4) result = "WIN";
    }
    if (index === 41 && !result) result = "DRAW";
  }
  requireValue(result === expectedResult, "RESOURCE_SEQUENCE_OUTCOME_MISMATCH");
}
export function validateConfig(config) {
  requireValue(config.schemaVersion === 1 && config.gameId === "connect-four" && config.profile === "server-turn" && config.profileVersion === 1 && /^[a-f0-9]{64}$/.test(config.gameBuildId), "RESOURCE_GAME_CONFIG_INVALID");
  requireValue(config.normal.samples.length === 3, "RESOURCE_NORMAL_SAMPLE_BUDGET");
  requireValue(Number.isSafeInteger(config.normal.paceMs) && config.normal.paceMs >= 0 && config.normal.paceMs <= 15000, "RESOURCE_PACE_INVALID");
  for (const sample of config.normal.samples) {
    requireValue(/^[a-z0-9-]{1,64}$/.test(sample.name) && Number.isSafeInteger(sample.paceMs ?? config.normal.paceMs) && (sample.paceMs ?? config.normal.paceMs) >= 0 && (sample.paceMs ?? config.normal.paceMs) <= 15000 && sample.moves === sample.columns.length, "RESOURCE_SAMPLE_INVALID");
    validateSequence(sample.columns, sample.result);
  }
  requireValue(Number.isSafeInteger(config.idle.quietMs) && config.idle.quietMs >= 60_000 && config.idle.quietMs <= 180_000, "RESOURCE_IDLE_BUDGET");
  requireValue(Number.isSafeInteger(config.concurrent.rooms) && config.concurrent.rooms >= 1 && config.concurrent.rooms <= 4 && Number.isSafeInteger(config.concurrent.paceMs) && config.concurrent.paceMs >= 0 && config.concurrent.paceMs <= 15000, "RESOURCE_CONCURRENT_BUDGET");
  requireValue(config.normal.samples.length + 1 + config.concurrent.rooms <= config.hardBudget.maxRooms && 2 * (config.normal.samples.length + 1 + config.concurrent.rooms) <= config.hardBudget.maxGuests, "RESOURCE_ALL_SCENARIOS_BUDGET");
  validateSequence(config.idle.finishColumns, "WIN"); validateSequence(config.concurrent.columns, "WIN"); createBudget(config); return config;
}
export async function loadConfig(filename = "configs/resource-profiles/connect-four.json") { return validateConfig(JSON.parse(await readFile(filename, "utf8"))); }

/** onCheckpoint receives raw room IDs in memory only. It must not probe any server during idle-quiet-start/end.
 * It may collect aggregate provider metrics outside that quiet window. Reports never include raw IDs or credentials. */
export async function runScenario({ scenario, config, origin = config.origin, budget = createBudget(config), onCheckpoint, signal }) {
  validateConfig(config); requireValue(["normal", "idle", "concurrent"].includes(scenario), "RESOURCE_SCENARIO_INVALID");
  const clients = new MeasurementClients({ config, origin, budget, signal });
  const startedAt = Date.now(), observations = [], checkpoints = [];
  const checkpoint = async (point, sample = null, additional = {}) => {
    const at = Date.now(); checkpoints.push({ point, sample, at, ...additional });
    await onCheckpoint?.({ point, scenario, sample, at, rooms: clients.checkpointRooms(), rawRoomIds: clients.rawRoomIds, clientCounts: clients.snapshot(), ...additional });
  };
  let status = "PASS", failure = null, cleanup;
  try {
    await checkpoint("scenario-start");
    if (scenario === "normal") {
      for (const sample of config.normal.samples) {
        await checkpoint("sample-start", sample.name); clients.stage = `normal.${sample.name}.setup`;
        const room = await clients.startRoom(sample.name); await checkpoint("room-ready", sample.name);
        clients.stage = `normal.${sample.name}.play`; const before = clients.snapshot();
        const summary = await clients.play(room, sample.columns, sample.paceMs ?? config.normal.paceMs);
        requireValue(summary.phase === "TERMINAL" && summary.result === sample.result && summary.moves === sample.moves, "RESOURCE_NORMAL_OUTCOME_MISMATCH");
        observations.push({ kind: "completed-game", sample: sample.name, paceMs: sample.paceMs ?? config.normal.paceMs, moves: summary.moves, result: summary.result,
          clientPlayDelta: Object.fromEntries(Object.entries(clients.snapshot()).map(([key, value]) => [key, value - before[key]])),
          setupMs: summary.setupMs, commitLatency: summary.commitLatency, bothStatesLatency: summary.bothStatesLatency });
        await checkpoint("sample-end", sample.name);
      }
    } else if (scenario === "idle") {
      clients.stage = "idle.setup"; const room = await clients.startRoom("quiet-room");
      await checkpoint("room-ready", room.label); await clients.sleep(200);
      clients.stage = "idle.quiet";
      const shapeBefore = room.actors.map(actor => JSON.stringify(immutableShape(actor.room))), countersBefore = clients.snapshot();
      await checkpoint("idle-quiet-start", room.label, { serverProbesForbidden: true });
      const quietStartedAt = Date.now(); await clients.sleep(config.idle.quietMs); const quietEndedAt = Date.now();
      const countersAfter = clients.snapshot(), unchanged = room.actors.every((actor, index) => JSON.stringify(immutableShape(actor.room)) === shapeBefore[index]);
      const delta = Object.fromEntries(Object.entries(countersAfter).map(([key, value]) => [key, value - countersBefore[key]]));
      requireValue(unchanged && delta.httpRequests === 0 && delta.messagesSent === 0 && delta.messagesReceived === 0 && room.actors.every(actor => !actor.closed && !actor.fatal), "RESOURCE_IDLE_NOT_QUIET");
      await checkpoint("idle-quiet-end", room.label, { serverProbesForbidden: true });
      observations.push({ kind: "quiet-room", requestedQuietMs: config.idle.quietMs, actualQuietMs: quietEndedAt - quietStartedAt,
        quietStartedAt, quietEndedAt, clientCountsDelta: delta, unchangedState: unchanged, bothSocketsStayedOpen: true,
        limitation: "Zero client-observed events alone does not prove zero provider CPU, SQL or duration; join with official object/namespace metrics for this exact window." });
      clients.stage = "idle.resume-and-finish"; const resume = await clients.play(room, config.idle.finishColumns);
      requireValue(resume.phase === "TERMINAL" && resume.result === "WIN", "RESOURCE_IDLE_RESUME_FAILED");
      observations.push({ kind: "after-idle-resume", firstCommand: resume.commandSamples[0], moves: resume.moves, result: resume.result });
    } else {
      clients.stage = "concurrent.setup";
      const setup = await Promise.allSettled(Array.from({ length: config.concurrent.rooms }, (_, index) => clients.startRoom(`parallel-${index + 1}`)));
      if (setup.some(item => item.status === "rejected")) throw new Error("RESOURCE_CONCURRENT_SETUP_FAILED");
      const rooms = setup.map(item => item.value);
      await checkpoint("concurrent-ready", null, { concurrentRooms: rooms.length });
      clients.stage = "concurrent.play";
      const plays = await Promise.allSettled(rooms.map(room => clients.play(room, config.concurrent.columns, config.concurrent.paceMs)));
      if (plays.some(item => item.status === "rejected")) throw new Error("RESOURCE_CONCURRENT_PLAY_FAILED");
      const completed = plays.map(item => item.value);
      requireValue(completed.every(room => room.phase === "TERMINAL" && room.result === "WIN" && room.moves === config.concurrent.columns.length), "RESOURCE_CONCURRENT_OUTCOME_MISMATCH");
      observations.push({ kind: "small-concurrency", concurrentRooms: rooms.length, commandsPerRoom: config.concurrent.columns.length,
        paceMs: config.concurrent.paceMs, capacityTest: false, latency: clients.report().bothStatesLatency });
    }
    await checkpoint("workload-end");
  } catch (error) { status = "FAIL"; failure = safeCode(error); }
  finally {
    try { cleanup = await clients.close(); } catch (error) { cleanup = { failures: [safeCode(error)] }; }
    if (cleanup.failures.length) status = "FAIL";
    try { await checkpoint("scenario-end"); } catch { status = "FAIL"; failure ??= "RESOURCE_FINAL_OBSERVATION_FAILED"; }
  }
  return { schemaVersion: 1, gameId: config.gameId, gameBuildId: config.gameBuildId, scenario, status, failure, startedAt, endedAt: Date.now(),
    environment: { origin, node: process.version, level: origin.startsWith("http:") ? "ACTUAL_LOOPBACK_HTTP_WSS" : "ACTUAL_CLOUD_HTTP_WSS" },
    hardBudget: { ...budget.limits }, cumulativeBudgetUsed: { ...budget.counts }, checkpoints, observations, ...clients.report(), cleanup,
    metricUnits: { httpBodyBytes: "Decoded response/request body bytes; excludes headers and TLS", messageBytes: "Application WebSocket message payload bytes, including the 32-byte platform frame when binary; excludes WebSocket/TCP/TLS overhead", latency: "Client monotonic clock; commit acknowledgement and both clients' received states, not server CPU time" },
    limits: config.measurementScope };
}

async function cli() {
  const args = process.argv.slice(2), flags = {};
  for (let index = 0; index < args.length; index += 2) { requireValue(["--scenario", "--config", "--origin", "--report"].includes(args[index]) && !Object.hasOwn(flags, args[index]) && args[index + 1] && !args[index + 1].startsWith("--"), "RESOURCE_ARGUMENT_INVALID"); flags[args[index]] = args[index + 1]; }
  const scenario = flags["--scenario"] ?? "normal"; requireValue(["normal", "idle", "concurrent", "all"].includes(scenario), "RESOURCE_SCENARIO_INVALID");
  const config = await loadConfig(flags["--config"]), budget = createBudget(config);
  const reportPath = flags["--report"] ?? `artifacts/resource-profile/${config.gameId}-${scenario}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const reports = [];
  for (const item of scenario === "all" ? ["normal", "idle", "concurrent"] : [scenario]) {
    const report = await runScenario({ scenario: item, config, origin: flags["--origin"] ?? config.origin, budget,
      onCheckpoint: async ({ point, sample, at }) => console.log(JSON.stringify({ scenario: item, point, sample, at })) });
    reports.push(report); if (report.status !== "PASS") break;
  }
  const report = scenario === "all" ? { schemaVersion: 1, gameId: config.gameId, gameBuildId: config.gameBuildId, status: reports.every(item => item.status === "PASS") && reports.length === 3 ? "PASS" : "FAIL", scenarios: reports, cumulativeBudgetUsed: budget.counts } : reports[0];
  await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, report: reportPath, cumulativeBudgetUsed: budget.counts, reportSha256: sha(JSON.stringify(report)) }));
  if (report.status !== "PASS") process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(error => { console.error(safeCode(error)); process.exitCode = 1; });
