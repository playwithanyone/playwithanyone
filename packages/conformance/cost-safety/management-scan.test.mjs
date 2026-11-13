import assert from "node:assert/strict";
import test from "node:test";
import { advanceManagementScan, readCompleteManagementStatus } from "../../../scripts/cost-watchdog/management-scan.mjs";

const SCAN = "10000000-0000-4000-8000-000000000000";
const OTHER_SCAN = "20000000-0000-4000-8000-000000000000";
const room = index => `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`;
const cursor = index => `${SCAN}:${room(index)}`;
function page({ index = 1, complete = false, connections = index * 2, scanId = SCAN, version = 3, ...changes } = {}) {
  return { state: "BLOCKED", version, activeConnections: connections, backgroundTasks: 0, unobservedRooms: complete ? 0 : 8,
    observation: { scanId, complete, observedRooms: index * 8, nextCursor: complete ? null : cursor(index), ...changes } };
}

test("management follows one scan through every page and keeps only the final cumulative snapshot", async () => {
  const inputs = [], responses = [page({ connections: 2 }), page({ index: 2, connections: 6 }), page({ index: 3, complete: true, connections: 8 })];
  const result = await readCompleteManagementStatus(async body => { inputs.push(body); return responses[inputs.length - 1]; }, { maxPages: 4 });
  assert.deepEqual(inputs, [{ operation: "status" }, { operation: "status", cursor: cursor(1) }, { operation: "status", cursor: cursor(2) }]);
  assert.equal(result.pages, 3); assert.equal(result.scanId, SCAN);
  assert.equal(result.status, responses[2]); assert.equal(result.status.activeConnections, 8, "2 + 6 + 8 must never be summed");
});

test("a single complete page needs no follow-up request", async () => {
  let calls = 0;
  const final = page({ complete: true, connections: 0 });
  const result = await readCompleteManagementStatus(async () => { calls++; return final; });
  assert.equal(calls, 1); assert.equal(result.status, final); assert.equal(result.pages, 1);
});

test("partial, malformed and contradictory observations never count as a completed scan", async () => {
  for (const response of [
    { state: "BLOCKED", version: 3, unobservedRooms: 0 },
    page({ nextCursor: null }),
    page({ complete: true, nextCursor: cursor(1) }),
    page({ scanId: "not-a-scan" }),
    page({ nextCursor: `${OTHER_SCAN}:${room(1)}` }),
    page({ observedRooms: -1 }),
  ]) {
    let calls = 0;
    await assert.rejects(() => readCompleteManagementStatus(async () => { calls++; return response; }), /MANAGEMENT_(?:OBSERVATION|CURSOR)_INVALID/);
    assert.equal(calls, 1);
  }
});

test("scan identity or protection-version changes abort instead of merging observations", async () => {
  for (const second of [page({ index: 2, scanId: OTHER_SCAN }), page({ index: 2, version: 4 })]) {
    let calls = 0;
    await assert.rejects(() => readCompleteManagementStatus(async () => ++calls === 1 ? page() : second), /MANAGEMENT_SCAN_CHANGED/);
    assert.equal(calls, 2);
  }
});

test("repeated/backward cursors and non-advancing room totals cannot create a scan loop", async () => {
  for (const second of [page({ index: 2, nextCursor: cursor(1) }), page({ index: 2, nextCursor: cursor(0) }), page({ index: 2, observedRooms: 8 }), page({ index: 2, observedRooms: 7 })]) {
    let calls = 0;
    await assert.rejects(() => readCompleteManagementStatus(async () => ++calls === 1 ? page() : second), /MANAGEMENT_(?:CURSOR_NOT_ADVANCING|SCAN_REGRESSED)/);
    assert.equal(calls, 2);
  }
});

test("page exhaustion fails closed and the injected shared request budget is never reset or retried", async () => {
  let calls = 0;
  await assert.rejects(() => readCompleteManagementStatus(async () => page({ index: ++calls }), { maxPages: 3 }), /MANAGEMENT_SCAN_INCOMPLETE/);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(() => readCompleteManagementStatus(async () => {
    if (++calls === 2) throw new Error("WATCHDOG_RUNTIME_LIMIT");
    return page();
  }, { maxPages: 16 }), /WATCHDOG_RUNTIME_LIMIT/);
  assert.equal(calls, 2);
  for (const maxPages of [0, 65, Infinity]) await assert.rejects(() => readCompleteManagementStatus(async () => page(), { maxPages }), /MANAGEMENT_SCAN_BUDGET_INVALID/);
});

test("the pure cursor transition leaves earlier observations unchanged", () => {
  const first = advanceManagementScan(undefined, page());
  const before = JSON.stringify(first); Object.freeze(first.seenCursors); Object.freeze(first);
  const next = advanceManagementScan(first, page({ index: 2 }));
  assert.equal(JSON.stringify(first), before); assert.equal(next.pages, 2); assert.equal(next.seenCursors.length, 2);
});
