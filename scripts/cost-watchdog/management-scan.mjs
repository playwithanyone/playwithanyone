// A management page already contains cumulative counts. Keep only the final
// snapshot; never add per-page observations or retry a mutation here.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
function fail(code) { throw new Error(code); }

/** Pure state transition, exported separately so cursor validation needs no I/O. */
export function advanceManagementScan(previous, status) {
  if (!object(status) || !integer(status.version) || !object(status.observation)) fail("MANAGEMENT_OBSERVATION_INVALID");
  const page = status.observation;
  if (!UUID.test(page.scanId ?? "") || typeof page.complete !== "boolean" || !integer(page.observedRooms)) fail("MANAGEMENT_OBSERVATION_INVALID");
  if (previous && (page.scanId !== previous.scanId || status.version !== previous.version)) fail("MANAGEMENT_SCAN_CHANGED");
  if (previous?.complete) fail("MANAGEMENT_SCAN_ALREADY_COMPLETE");
  if (previous && page.observedRooms < previous.observedRooms) fail("MANAGEMENT_SCAN_REGRESSED");
  const pages = (previous?.pages ?? 0) + 1;
  if (page.complete) {
    if (page.nextCursor !== null) fail("MANAGEMENT_CURSOR_INVALID");
    return { scanId: page.scanId, version: status.version, observedRooms: page.observedRooms, pages, complete: true, nextCursor: null, seenCursors: previous?.seenCursors ?? [] };
  }
  const cursor = page.nextCursor;
  if (typeof cursor !== "string" || cursor.length !== 73 || cursor.slice(0, 36) !== page.scanId || cursor[36] !== ":" || !UUID.test(cursor.slice(37))) fail("MANAGEMENT_CURSOR_INVALID");
  if (previous && (page.observedRooms <= previous.observedRooms || cursor.slice(37) <= previous.nextCursor.slice(37))) fail("MANAGEMENT_CURSOR_NOT_ADVANCING");
  if (previous?.seenCursors.includes(cursor)) fail("MANAGEMENT_CURSOR_REPEATED");
  return { scanId: page.scanId, version: status.version, observedRooms: page.observedRooms, pages, complete: false, nextCursor: cursor, seenCursors: [...(previous?.seenCursors ?? []), cursor] };
}

/** requestPage is the CLI's existing bounded request function. Its shared API
 * counter and run deadline cover every page, including the first one. */
export async function readCompleteManagementStatus(requestPage, { maxPages = 16 } = {}) {
  if (typeof requestPage !== "function" || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 64) fail("MANAGEMENT_SCAN_BUDGET_INVALID");
  let scan;
  for (let page = 0; page < maxPages; page++) {
    const status = await requestPage({ operation: "status", ...(scan?.nextCursor ? { cursor: scan.nextCursor } : {}) });
    scan = advanceManagementScan(scan, status);
    if (scan.complete) return { status, pages: scan.pages, scanId: scan.scanId };
  }
  fail("MANAGEMENT_SCAN_INCOMPLETE");
}
