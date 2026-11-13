/**
 * Platform server-turn adapter. Gravity and four-direction winner detection are
 * adapted from BattleBox games/connectfour.js (MIT), commit 072659ace68261e05ce0d7b8f3d4e2fc2c9970a7.
 * Copyright (c) 2026 BattleBox Contributors. See ../LICENSE and provenance.json.
 * This module has no network, storage, timers, platform identity or scoring side effects.
 */
export const ROWS = 6;
export const COLUMNS = 7;
export type Seat = "red" | "yellow";
export type Cell = 0 | 1 | 2;
export interface DropCommand { readonly type: "drop"; readonly column: number }
export interface LastMove { readonly row: number; readonly column: number; readonly seat: Seat }
export interface FourState {
  readonly schemaVersion: 1;
  readonly board: readonly Cell[];
  readonly currentPlayer: Seat;
  readonly moves: number;
  readonly winner: Seat | null;
  readonly draw: boolean;
  readonly lastMove: LastMove | null;
  readonly winningCells: readonly number[];
}
export interface FourView {
  readonly game: "connect-four";
  readonly board: readonly Cell[];
  readonly yourSeat: Seat | null;
  readonly turn: Seat;
  readonly winner: Seat | null;
  readonly draw: boolean;
  readonly moves: number;
  readonly lastMove: LastMove | null;
  readonly winningCells: readonly number[];
}
export class RuleError extends Error {
  constructor(readonly code: "COMMAND_INVALID" | "NOT_YOUR_TURN" | "COLUMN_FULL" | "GAME_OVER" | "STATE_INVALID") {
    super(code); this.name = "RuleError";
  }
}
function other(seat: Seat): Seat { return seat === "red" ? "yellow" : "red"; }
function token(seat: Seat): Cell { return seat === "red" ? 1 : 2; }
function freeze(state: FourState): FourState {
  return Object.freeze({ ...state, board: Object.freeze([...state.board]),
    lastMove: state.lastMove ? Object.freeze({ ...state.lastMove }) : null,
    winningCells: Object.freeze([...state.winningCells]) });
}
function line(board: readonly Cell[], row: number, column: number, seat: Seat): number[] {
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]] as const) {
    const cells = [row * COLUMNS + column];
    for (const direction of [-1, 1]) {
      let r = row + dr * direction, c = column + dc * direction;
      while (r >= 0 && r < ROWS && c >= 0 && c < COLUMNS && board[r * COLUMNS + c] === token(seat)) {
        if (direction < 0) cells.unshift(r * COLUMNS + c); else cells.push(r * COLUMNS + c);
        r += dr * direction; c += dc * direction;
      }
    }
    if (cells.length >= 4) return cells;
  }
  return [];
}
export function create(): FourState {
  return freeze({ schemaVersion: 1, board: Array<Cell>(ROWS * COLUMNS).fill(0), currentPlayer: "red",
    moves: 0, winner: null, draw: false, lastMove: null, winningCells: [] });
}
export function parseCommand(value: unknown): DropCommand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RuleError("COMMAND_INVALID");
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 2 || !Object.hasOwn(data, "type") || !Object.hasOwn(data, "column") ||
      data["type"] !== "drop" || !Number.isSafeInteger(data["column"]) || (data["column"] as number) < 0 || (data["column"] as number) >= COLUMNS) throw new RuleError("COMMAND_INVALID");
  return Object.freeze({ type: "drop", column: data["column"] as number });
}
export function applyCommand(state: FourState, seat: Seat, value: DropCommand): FourState {
  const command = parseCommand(value);
  if (state.winner !== null || state.draw) throw new RuleError("GAME_OVER");
  if ((seat !== "red" && seat !== "yellow") || seat !== state.currentPlayer) throw new RuleError("NOT_YOUR_TURN");
  let row = ROWS - 1;
  while (row >= 0 && state.board[row * COLUMNS + command.column] !== 0) row -= 1;
  if (row < 0) throw new RuleError("COLUMN_FULL");
  const board = [...state.board]; board[row * COLUMNS + command.column] = token(seat);
  const winningCells = line(board, row, command.column, seat), moves = state.moves + 1;
  const winner = winningCells.length ? seat : null, draw = winner === null && moves === ROWS * COLUMNS;
  return freeze({ schemaVersion: 1, board, currentPlayer: winner !== null || draw ? seat : other(seat),
    moves, winner, draw, lastMove: { row, column: command.column, seat }, winningCells });
}
export function project(state: FourState, seat: Seat | null): FourView {
  return Object.freeze({ game: "connect-four", board: Object.freeze([...state.board]), yourSeat: seat,
    turn: state.currentPlayer, winner: state.winner, draw: state.draw, moves: state.moves,
    lastMove: state.lastMove ? Object.freeze({ ...state.lastMove }) : null, winningCells: Object.freeze([...state.winningCells]) });
}
export function evaluateResult(state: FourState): { readonly kind: "WIN"; readonly winner: Seat } | { readonly kind: "DRAW" } | null {
  return state.winner !== null ? { kind: "WIN", winner: state.winner } : state.draw ? { kind: "DRAW" } : null;
}
export function save(state: FourState): string { return JSON.stringify(state); }
/** Corrupt checkpoints fail explicitly; none are treated as a fresh board. */
export function restore(serialized: string | unknown): FourState {
  let data: unknown;
  try { data = typeof serialized === "string" ? JSON.parse(serialized) as unknown : serialized; } catch { throw new RuleError("STATE_INVALID"); }
  const invalid = (): never => { throw new RuleError("STATE_INVALID"); };
  if (typeof data !== "object" || data === null || Array.isArray(data)) return invalid();
  const value = data as Record<string, unknown>;
  const keys = ["schemaVersion", "board", "currentPlayer", "moves", "winner", "draw", "lastMove", "winningCells"];
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) || value["schemaVersion"] !== 1 ||
      !Array.isArray(value["board"]) || value["board"].length !== ROWS * COLUMNS || value["board"].some(cell => ![0, 1, 2].includes(cell)) ||
      !["red", "yellow"].includes(String(value["currentPlayer"])) || ![null, "red", "yellow"].includes(value["winner"] as string | null) ||
      typeof value["draw"] !== "boolean" || !Array.isArray(value["winningCells"])) return invalid();
  const board = value["board"] as Cell[];
  const red = board.filter(cell => cell === 1).length, yellow = board.filter(cell => cell === 2).length;
  if (!(red === yellow || red === yellow + 1) || value["moves"] !== red + yellow) return invalid();
  for (let column = 0; column < COLUMNS; column++) {
    let emptySeen = false;
    for (let row = ROWS - 1; row >= 0; row--) {
      if (board[row * COLUMNS + column] === 0) emptySeen = true;
      else if (emptySeen) return invalid();
    }
  }
  const last = value["lastMove"];
  let lastMove: LastMove | null = null;
  if (red + yellow === 0) {
    if (last !== null) return invalid();
  } else {
    if (typeof last !== "object" || last === null || Array.isArray(last)) return invalid();
    const item = last as Record<string, unknown>;
    if (Object.keys(item).length !== 3 || !Number.isSafeInteger(item["row"]) || !Number.isSafeInteger(item["column"]) ||
        (item["row"] as number) < 0 || (item["row"] as number) >= ROWS || (item["column"] as number) < 0 || (item["column"] as number) >= COLUMNS ||
        item["seat"] !== (red > yellow ? "red" : "yellow")) return invalid();
    lastMove = { row: item["row"] as number, column: item["column"] as number, seat: item["seat"] as Seat };
    if (board[lastMove.row * COLUMNS + lastMove.column] !== token(lastMove.seat) ||
        (lastMove.row > 0 && board[(lastMove.row - 1) * COLUMNS + lastMove.column] !== 0)) return invalid();
  }
  const wins = lastMove ? line(board, lastMove.row, lastMove.column, lastMove.seat) : [];
  const expectedWinner = wins.length ? lastMove!.seat : null;
  // A winner elsewhere cannot be hidden by supplying a forged last move.
  for (let index = 0; index < board.length; index++) {
    if (board[index] !== 0 && line(board, Math.floor(index / COLUMNS), index % COLUMNS, board[index] === 1 ? "red" : "yellow").length &&
        (board[index] !== token(expectedWinner ?? "red") || expectedWinner === null)) return invalid();
  }
  const expectedDraw = expectedWinner === null && red + yellow === ROWS * COLUMNS;
  const expectedTurn = expectedWinner !== null || expectedDraw ? lastMove!.seat : red === yellow ? "red" : "yellow";
  if (value["winner"] !== expectedWinner || value["draw"] !== expectedDraw || value["currentPlayer"] !== expectedTurn ||
      JSON.stringify(value["winningCells"]) !== JSON.stringify(wins)) return invalid();
  return freeze({ schemaVersion: 1, board, currentPlayer: expectedTurn, moves: red + yellow,
    winner: expectedWinner, draw: expectedDraw, lastMove, winningCells: wins });
}
