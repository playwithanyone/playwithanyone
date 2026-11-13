import type { FourView, Seat } from "../../../games/connect-four/src/rules.js";

/** Browser projection only: no storage, server environment, credentials or release tooling. */
export interface RoomView extends FourView {
  readonly roomId:string;
  readonly matchId:string;
  readonly phase:"PREPARING"|"RUNNING"|"TERMINAL";
  readonly revision:number;
  readonly stateSeq:number;
  readonly gameBuildId:string;
  readonly frameOrigin:string;
  readonly entryUrl:string;
  readonly authorityEpoch:1;
  readonly yourSeat:Seat;
  readonly seatId:Seat;
  readonly seatEpoch:number;
  readonly result:"WIN"|"DRAW"|"DISCONNECTED"|"SERVICE_INTERRUPTED"|null;
  readonly disconnectedUntil:number|null;
  readonly turnDeadlineAt?:number|null;
  readonly terminationReason?:string|null;
  readonly members:readonly {
    readonly seatId:Seat;
    readonly color:Seat;
    readonly connected:boolean;
    readonly prepared:boolean;
    readonly resourcesReady:boolean;
    readonly baselineReady:boolean;
  }[];
}
export interface QueueView {
  readonly intentId:string;
  readonly status:"QUEUED"|"ASSIGNED"|"CANCELLED"|"EXPIRED";
  readonly deadlineAt:number;
  readonly revision:number;
  readonly roomId?:string;
  readonly watchUrl?:string;
}
