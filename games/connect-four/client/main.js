import { connectGameClient } from "./sdk.js";

// Presentation code only. The platform owns authorization, turns and game results.
let earlyChallenge;
const rememberChallenge = event => {
  if (event.source === window.parent && event.ports.length === 0 && event.data?.type === "BOOT_CHALLENGE") earlyChallenge = event;
};
window.addEventListener("message", rememberChallenge);
const messages = {
  en: {kicker:"A little strategy. A new friend.",connecting:"Connecting your board…",loading:"Your board will appear when the connection is ready.",red:"You are coral",yellow:"You are gold",waiting:"Getting ready",waitingNote:"Get ready above. The game starts when you are both ready.",yourTurn:"Your move.",theirTurn:"Your opponent’s move.",turnNote:"Drop a disc. Connect four in any direction to win.",confirming:"Placing your disc…",timeoutWin:"Your opponent ran out of time. You win.",timeoutLose:"Your time ran out. Your opponent wins.",win:"You connected four!",lose:"A good game. They connected four.",draw:"A full board. It’s a draw.",disconnected:"This game has ended.",disconnectNote:"A player did not reconnect in time. No win or loss is recorded.",interrupted:"The game has paused.",interruptNote:"The service was interrupted. No win or loss is recorded.",paused:"Waiting for reconnection",pausedNote:"The game will continue if your opponent reconnects in time.",hint:"Choose a column, or use keys 1–7.",column:"Drop in column {column}",full:"Column {column} is full",board:"Connect Four board. {count} discs placed.",revoked:"Connection paused",revokedNote:"Your platform connection needs to be restored before you can play.",failure:"The board couldn’t connect",failureNote:"Try reconnecting from the game page.",rejected:"That move wasn’t accepted. The board shows the latest confirmed position.",retry:"The move could not be confirmed. Check the connection above before trying again."},
  "zh-CN": {kicker:"一点策略，一位新朋友。",connecting:"正在连接你的棋盘…",loading:"连接准备好后，棋盘就会出现。",red:"你执珊瑚红",yellow:"你执金黄色",waiting:"准备好，就一起开局",waitingNote:"在上方点击准备，双方都准备好后开始。",yourTurn:"轮到你了。",theirTurn:"等对方想一想。",turnNote:"选一列落子，横、竖或斜连成四子就赢。",confirming:"正在确认落子…",timeoutWin:"对方思考超时，你赢啦！",timeoutLose:"思考时间用完，这局对方获胜。",win:"四子连线，你赢啦！",lose:"对方连成四子，好棋！",draw:"棋盘满了，这局打成平手。",disconnected:"这一局已结束。",disconnectNote:"有玩家未及时重连，这局不计胜负。",interrupted:"这一局暂时中断。",interruptNote:"服务暂时中断，这局不计胜负。",paused:"等对方重新连接",pausedNote:"对方及时回来后，就能继续这一局。",hint:"点击一列落子，也可以按数字键 1–7。",column:"在第 {column} 列落子",full:"第 {column} 列已满",board:"四子棋棋盘，已落 {count} 子。",revoked:"连接暂时中断",revokedNote:"请先在游戏页面恢复平台连接，再继续落子。",failure:"棋盘暂时没连上",failureNote:"请在游戏页面重试连接。",rejected:"这步没有被接受，棋盘已显示最新确认的位置。",retry:"暂时未能确认落子，请先检查上方连接状态。"},
};
let locale = navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
const status = document.querySelector("#game-status");
const note = document.querySelector("#game-note");
const board = document.querySelector("#board");
const controls = document.querySelector("#column-controls");
const feedback = document.querySelector("#game-feedback");
const badge = document.querySelector("#your-seat");
let client, current, pending = false, revoked = false;
const buttons = Array.from({length:7},(_,column) => {
  const button = document.createElement("button"); button.type = "button"; button.dataset.column = String(column); button.disabled = true;
  button.addEventListener("click", () => { void drop(column); }); controls.append(button); return button;
});
const cells = Array.from({length:42},(_,index) => {
  const cell = document.createElement("div"); cell.className = "cell"; cell.dataset.column = String(index % 7); board.append(cell); return cell;
});
function t(key, values = {}) { return Object.entries(values).reduce((text,[name,value]) => text.replaceAll(`{${name}}`,String(value)),messages[locale][key]); }
function validView(view) {
  return view && Array.isArray(view.board) && view.board.length === 42 && view.board.every(value => value===0 || value===1 || value===2) && ["PREPARING","RUNNING","TERMINAL"].includes(view.phase) && ["red","yellow"].includes(view.yourSeat) && ["red","yellow",null].includes(view.turn) && ["red","yellow",null].includes(view.winner) && Array.isArray(view.members);
}
function canPlay() { const member=current?.members.find(item=>item.seatId===current.yourSeat); return !revoked && !pending && current?.phase === "RUNNING" && current.turn === current.yourSeat && !current.disconnectedUntil && member?.resourcesReady && member?.baselineReady; }
function render() {
  document.documentElement.lang = locale;
  document.title = `${locale==="zh-CN"?"四子棋":"Connect Four"} · PlayWithAnyone`;
  document.querySelector("#game-kicker").textContent = t("kicker");
  document.querySelector("#board-hint").textContent = t("hint");
  controls.setAttribute("aria-label", locale==="zh-CN"?"选择落子列":"Choose a column");
  const number = value => new Intl.NumberFormat(locale).format(value);
  buttons.forEach((button,column) => { const full = current?.board[column] !== undefined && current.board[column] !== 0; button.disabled = !canPlay() || full; button.textContent = number(column+1); button.setAttribute("aria-label",t(full?"full":"column",{column:number(column+1)})); });
  board.dataset.canPlay = String(canPlay());
  if (!current) { status.textContent=t("connecting"); note.textContent=t("loading"); return; }
  document.documentElement.dataset.gamePhase = current.phase;
  document.documentElement.dataset.turn = current.turn ?? "none";
  badge.dataset.seat = current.yourSeat; badge.textContent=t(current.yourSeat);
  board.setAttribute("aria-label",t("board",{count:number(current.board.filter(Boolean).length)}));
  cells.forEach((cell,index) => {
    const disc = current.board[index] === 1 ? "red" : current.board[index] === 2 ? "yellow" : "empty";
    const changed = cell.dataset.disc !== disc && disc !== "empty";
    cell.dataset.disc=disc;
    cell.classList.toggle("winning",Array.isArray(current.winningCells)&&current.winningCells.includes(index));
    cell.classList.toggle("just-played",changed);
  });
  if (current.phase === "TERMINAL") {
    status.textContent=t(current.result==="DISCONNECTED"?"disconnected":current.result==="SERVICE_INTERRUPTED"?"interrupted":current.terminationReason==="TURN_TIMEOUT"?(current.winner===current.yourSeat?"timeoutWin":"timeoutLose"):current.winner===current.yourSeat?"win":current.winner?"lose":"draw");
    note.textContent=t(current.result==="DISCONNECTED"?"disconnectNote":current.result==="SERVICE_INTERRUPTED"?"interruptNote":"turnNote");
  } else if (revoked) { status.textContent=t("revoked"); note.textContent=t("revokedNote"); } else if (current.disconnectedUntil) {status.textContent=t("paused");note.textContent=t("pausedNote");}
  else if (current.phase === "PREPARING") {status.textContent=t("waiting");note.textContent=t("waitingNote");}
  else {status.textContent=t(pending?"confirming":current.turn===current.yourSeat?"yourTurn":"theirTurn");note.textContent=t("turnNote");}
}
async function drop(column) {
  if (!canPlay() || !Number.isInteger(column) || column<0 || column>6 || current.board[column]!==0) return;
  pending=true; feedback.textContent="";render();
  try { const outcome=await client.actions.dispatch({type:"drop",column}); if(outcome?.status==="REJECTED") feedback.textContent=t("rejected"); }
  catch {feedback.textContent=t("retry");}
  finally {pending=false;render();}
}
board.addEventListener("click",event=>{const target=event.target.closest("[data-column]");if(target) void drop(Number(target.dataset.column));});
document.addEventListener("keydown",event=>{
 if(event.altKey||event.ctrlKey||event.metaKey||event.repeat) return;
 if(/^[1-7]$/.test(event.key)){event.preventDefault();void drop(Number(event.key)-1);}
 if(event.key==="ArrowLeft"||event.key==="ArrowRight") {const index=buttons.indexOf(document.activeElement);const direction=event.key==="ArrowLeft"?-1:1;for(let step=1;step<=7;step++){const button=buttons[(Math.max(0,index)+direction*step+14)%7];if(!button.disabled){event.preventDefault();button.focus();break;}}}
});
render();
async function boot() {
 const response=await fetch("/bootstrap.json",{credentials:"omit",mode:"cors"});if(!response.ok) throw new Error("BOOTSTRAP_UNAVAILABLE");
 const bootstrap=await response.json();
 if(typeof bootstrap.shellOrigin!=="string"||typeof bootstrap.gameBuildId!=="string"||!/^[0-9a-f]{64}$/.test(bootstrap.gameBuildId)) throw new Error("BOOTSTRAP_SCHEMA");
 const connection=connectGameClient({shellOrigin:bootstrap.shellOrigin,gameBuildId:bootstrap.gameBuildId});
 window.removeEventListener("message",rememberChallenge);
 if(earlyChallenge&&earlyChallenge.origin===bootstrap.shellOrigin&&earlyChallenge.source===window.parent&&earlyChallenge.data.gameBuildId===bootstrap.gameBuildId) window.dispatchEvent(new MessageEvent("message",{data:earlyChallenge.data,origin:earlyChallenge.origin,source:earlyChallenge.source}));
 earlyChallenge=undefined;client=await connection;document.documentElement.dataset.sdkState="connected";
 client.lifecycle.subscribe(event=>{if(event.type==="REVOKED"){revoked=true;document.documentElement.dataset.sdkState="revoked";render();}});
 client.state.subscribe(envelope=>{if(!validView(envelope.view)) return;current=envelope.view;if(current.locale==="en"||current.locale==="zh-CN")locale=current.locale;feedback.textContent="";render();});
 await client.ready();document.documentElement.dataset.sdkState="ready";
}
void boot().catch(()=>{revoked=true;document.documentElement.dataset.sdkState="failed";render();status.textContent=t("failure");note.textContent=t("failureNote");});
window.addEventListener("pagehide",()=>client?.dispose(),{once:true});
