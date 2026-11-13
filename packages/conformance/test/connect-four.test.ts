import test from "node:test";
import assert from "node:assert/strict";
import { applyCommand, create, evaluateResult, parseCommand, project, restore, save, RuleError, type FourState } from "../../../games/connect-four/src/rules.js";

function moves(columns: readonly number[]): FourState {
  return columns.reduce((state, column) => applyCommand(state, state.currentPlayer, { type: "drop", column }), create());
}
function code(expected: string): (error: unknown) => boolean {
  return error => error instanceof RuleError && error.code === expected;
}
test("connect-four: gravity, turn ownership and immutable viewer projection", () => {
  const initial = create(), next = applyCommand(initial, "red", { type: "drop", column: 3 });
  assert.equal(initial.moves, 0); assert.equal(initial.board[38], 0);
  assert.equal(next.board[38], 1); assert.equal(next.currentPlayer, "yellow");
  assert.deepEqual(next.lastMove, { row: 5, column: 3, seat: "red" });
  assert.deepEqual(project(next, "yellow").yourSeat, "yellow");
  assert.throws(() => applyCommand(next, "red", { type: "drop", column: 2 }), code("NOT_YOUR_TURN"));
});
test("connect-four: closed command schema and full columns reject without changing state", () => {
  for (const value of [null, { type: "drop", column: 7 }, { type: "drop", column: -1 }, { type: "drop", column: 1.5 }, { type: "drop", column: 0, playerId: "someone-else" }]) {
    assert.throws(() => parseCommand(value), code("COMMAND_INVALID"));
  }
  const full = moves([0, 0, 0, 0, 0, 0]), before = save(full);
  assert.throws(() => applyCommand(full, "red", { type: "drop", column: 0 }), code("COLUMN_FULL"));
  assert.equal(save(full), before);
});
test("connect-four: vertical, horizontal and diagonal lines produce authoritative wins", () => {
  const examples = [
    { columns: [0, 1, 0, 1, 0, 1, 0], cells: [14, 21, 28, 35] },
    { columns: [0, 0, 1, 1, 2, 2, 3], cells: [35, 36, 37, 38] },
    { columns: [0, 1, 1, 2, 4, 2, 2, 3, 4, 3, 5, 3, 3], cells: [17, 23, 29, 35] },
  ];
  for (const item of examples) {
    const state = moves(item.columns);
    assert.deepEqual(evaluateResult(state), { kind: "WIN", winner: "red" });
    assert.deepEqual([...state.winningCells].sort((a, b) => a - b), item.cells);
    assert.deepEqual(restore(save(state)), state);
    assert.throws(() => applyCommand(state, "yellow", { type: "drop", column: 6 }), code("GAME_OVER"));
  }
});
test("connect-four: full board without a winning line is a draw", () => {
  const board = [
    1, 1, 0, 2, 1, 1, 2,
    2, 2, 1, 1, 2, 2, 1,
    1, 1, 2, 2, 1, 1, 2,
    2, 2, 1, 1, 2, 2, 1,
    1, 1, 2, 2, 1, 1, 2,
    2, 2, 1, 1, 2, 2, 1,
  ];
  const almost = restore({ schemaVersion: 1, board, currentPlayer: "yellow", moves: 41, winner: null,
    draw: false, lastMove: { row: 0, column: 1, seat: "red" }, winningCells: [] });
  const full = applyCommand(almost, "yellow", { type: "drop", column: 2 });
  assert.deepEqual(evaluateResult(full), { kind: "DRAW" });
  assert.equal(full.moves, 42); assert.deepEqual(restore(save(full)), full);
});
test("connect-four: saved rules restore exactly and corruption never resets a match", () => {
  const state = moves([3, 2, 3, 2, 1]);
  assert.deepEqual(restore(save(state)), state);
  const invalidCount = { ...state, moves: 0 };
  const floatingBoard = [...create().board]; floatingBoard[0] = 1;
  for (const value of ["{", invalidCount, { ...create(), board: floatingBoard, moves: 1, currentPlayer: "yellow", lastMove: { row: 0, column: 0, seat: "red" } }]) {
    assert.throws(() => restore(value), code("STATE_INVALID"));
  }
});
