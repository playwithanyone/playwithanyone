import { PresentationHost, SdkError, type PresentationGrant, type PresentationBinding } from "../../../packages/sdk/src/index.js";
import { decodeFrame, encodeFrame, FULL_STATE, Opcode, type BinaryContext } from "../../../packages/protocol/src/frame.js";
import { parseControl, encodeControl, type LinkDescriptor, type ControlMessage } from "../../../packages/protocol/src/control.js";
import type { RoomView, QueueView } from "./game-contract.js";
import { getLocale, number, t, translate, type MessageKey } from "./i18n.js";

interface Session { id:string; playerId:string; expiresAt:number }
interface Grant { roomId:string; joinTicket:string; expiresAt:number; wsUrl:string; executionClass:"hibernated-turn"; syncPolicy:{profileId:string;profileVersion:number;protocolVersions:number[]} }
type Mode="choose"|"creating"|"matching"|"cancelling"|"expired"|"cancelled"|"matched"|"connecting"|"room"|"error";
class ApiFailure extends Error { constructor(readonly code:string, readonly status:number){super(code);} }
const object=(value:unknown):value is Record<string,unknown>=>typeof value==="object"&&value!==null&&!Array.isArray(value);
const id=():string=>crypto.randomUUID();
function roomValue(value:unknown):RoomView {
 if(!object(value)||!object(value.room))throw new Error("ROOM_SCHEMA");
 const room=value.room;
 if(typeof room.roomId!=="string"||!/^[A-Za-z0-9-]{4,64}$/.test(room.roomId)||typeof room.matchId!=="string"||!Number.isSafeInteger(room.revision)||!Number.isSafeInteger(room.stateSeq)||!Number.isSafeInteger(room.seatEpoch)||room.authorityEpoch!==1||typeof room.gameBuildId!=="string"||!/^[0-9a-f]{64}$/.test(room.gameBuildId)||typeof room.frameOrigin!=="string"||typeof room.entryUrl!=="string"||!["PREPARING","RUNNING","TERMINAL"].includes(String(room.phase))||!["red","yellow"].includes(String(room.yourSeat))||!["red","yellow",null].includes(room.turn as string|null)||!["red","yellow",null].includes(room.winner as string|null)||!Array.isArray(room.board)||room.board.length!==42||!room.board.every(cell=>cell===0||cell===1||cell===2)||!Array.isArray(room.members)||room.members.length>2)throw new Error("ROOM_SCHEMA");
 const frame=new URL(room.entryUrl);const origin=new URL(room.frameOrigin);
 if(origin.origin!==room.frameOrigin||frame.origin!==origin.origin||origin.origin===location.origin||origin.protocol!=="https:"||frame.username||frame.password||frame.search||frame.hash)throw new Error("ROOM_ORIGIN");
 return room as unknown as RoomView;
}
function queueValue(value:unknown):QueueView {
 if(!object(value)||typeof value.intentId!=="string"||!Number.isSafeInteger(value.revision)||typeof value.deadlineAt!=="number"||!["QUEUED","ASSIGNED","CANCELLED","EXPIRED"].includes(String(value.status))||(value.roomId!==undefined&&(typeof value.roomId!=="string"||!/^[A-Za-z0-9-]{4,64}$/.test(value.roomId))))throw new Error("QUEUE_SCHEMA");
 return value as unknown as QueueView;
}
function errorKey(error:unknown):MessageKey {
 const code=error instanceof ApiFailure?error.code:error instanceof Error?error.message:"";
 if(["AUTH_REQUIRED","AUTH_EXPIRED","SESSION_EXPIRED"].includes(code))return "authRequired";
 if(code==="SAFETY_LIMIT")return "capacity";
 if(code.startsWith("SAFETY_")||["BUDGET_EXHAUSTED","SERVICE_BLOCKED","RESOURCE_LIMIT","POLICY_REQUIRED"].includes(code))return "safetyBlocked";
 if(code==="REVOCATION_INCOMPLETE")return "sessionPaused";
 if(code==="CAPABILITY_UNAVAILABLE")return "unavailable";
 if(/CAPACITY|LIMIT_EXCEEDED|RATE_LIMIT/.test(code))return "capacity";
 if(code==="ROOM_FULL")return "roomFull";
 if(["ROOM_NOT_FOUND","NOT_FOUND"].includes(code))return "noRoom";
 if(/STALE|SEAT_REPLACED|CONNECTION_REPLACED/.test(code))return "oldPage";
 return "connectionFailed";
}

/** All credentials and network state remain in the trusted Shell. */
export function mountGameplay(root:HTMLElement, invitationRoomId?:string):()=>void {
 root.innerHTML=`<div class="play-wrap wrap"><a class="text-link play-back" href="/">← <span data-i18n="backLobby"></span></a><div class="play-heading"><div><p class="eyebrow" data-i18n="earlyGame"></p><h1 data-i18n="cfTitle"></h1><p class="play-rules" data-i18n="cfRules"></p><p class="play-small-rules" data-i18n="cfSmallRules"></p></div><div class="play-heading-symbol" aria-hidden="true"><i></i><i></i><i></i><i></i></div></div><section class="play-choice" id="play-choice" aria-labelledby="play-choice-title"><p class="eyebrow" data-i18n="choosePlay"></p><h2 id="play-choice-title" data-i18n="chooseDescription"></h2><div class="play-options"><button class="play-option" id="play-match" type="button"><span class="play-option-icon" aria-hidden="true">↗</span><strong data-i18n="findStranger"></strong><span data-i18n="findStrangerNote"></span><span class="option-arrow" aria-hidden="true">→</span></button><button class="play-option" id="play-invite" type="button"><span class="play-option-icon invite-icon" aria-hidden="true">＋</span><strong data-i18n="inviteFriend"></strong><span data-i18n="inviteFriendNote"></span><span class="option-arrow" aria-hidden="true">→</span></button></div></section><section class="play-progress" id="play-progress" hidden aria-live="polite"><span class="play-pulse" aria-hidden="true"></span><h2 id="play-progress-title"></h2><p id="play-progress-note"></p><div class="play-progress-actions"><button class="button button-outline button-small" id="play-cancel" type="button" hidden></button><button class="button button-primary" id="play-retry" type="button" hidden></button><button class="button button-outline" id="play-invite-alternative" type="button" hidden data-i18n="inviteFriend"></button></div></section><section class="room-stage" id="room-stage" hidden data-i18n-label="roomTitle"><div class="room-topbar"><div><p class="eyebrow" data-i18n="roomTitle"></p><p class="room-connection" id="room-connection" role="status"></p></div><button class="button button-outline button-small" id="copy-invite" type="button" data-i18n="copyInvite"></button></div><div class="room-invitation" id="room-invitation"><label for="room-invite-url" data-i18n="inviteLink"></label><input id="room-invite-url" type="text" readonly aria-label="Invitation link"><p id="room-invite-feedback" role="status"></p></div><div class="room-players" id="room-players"></div><div class="room-status"><p id="room-status-title" role="status" aria-live="polite"></p><button class="button button-primary button-small" id="room-ready" type="button" disabled></button><button class="button button-outline button-small" id="room-reconnect" type="button" hidden data-i18n="reconnect"></button></div><p class="room-feedback" id="room-feedback" role="status" aria-live="polite"></p><div class="game-frame-wrap" id="game-frame-wrap"><div class="game-frame-error" id="game-frame-error" hidden role="status" aria-live="polite"><div><strong data-i18n="boardLoadFailed"></strong><p id="game-frame-error-note"></p></div><button class="button button-outline button-small" id="game-frame-reload" type="button" data-i18n="reloadBoard"></button></div><div class="game-frame-loading" id="game-frame-loading"><span class="loading-dot" aria-hidden="true"></span><p data-i18n="loadingBoard"></p></div></div><div class="room-ended" id="room-ended" hidden><p data-i18n="endDescription"></p><a class="button button-outline button-small" href="/" data-i18n="backLobby"></a></div><p class="room-exit-note" data-i18n="exitNote"></p></section></div>`;
 const query=<T extends HTMLElement>(selector:string):T=>root.querySelector<T>(selector)!;
 const choice=query("#play-choice"),progress=query("#play-progress"),stage=query("#room-stage"),frameWrap=query("#game-frame-wrap");
 const readyButton=query<HTMLButtonElement>("#room-ready"),reconnectButton=query<HTMLButtonElement>("#room-reconnect"),cancelButton=query<HTMLButtonElement>("#play-cancel"),retryButton=query<HTMLButtonElement>("#play-retry");
 const lifetime=new AbortController();let disposed=false;let mode:Mode="choose";let failure:MessageKey="connectionFailed";
 let session:Session|undefined;let room:RoomView|undefined;let queue:QueueView|undefined;let queueGeneration=0;let queueTimer:ReturnType<typeof setTimeout>|undefined;let queueSocket:WebSocket|undefined;
 let socket:WebSocket|undefined;let socketGeneration=0;let socketOpen=false;let reconnectAttempts=0;let reconnectTimer:ReturnType<typeof setTimeout>|undefined;
 let host:PresentationHost<{type:"drop";column:number},RoomView&{locale:string}>|undefined;let iframe:HTMLIFrameElement|undefined;let sdkReady=false;let baselineSeq:number|undefined;let descriptor:LinkDescriptor|undefined;let context:BinaryContext|undefined;let endpointId:string|undefined;let runtimeId:string|undefined;let commandSeq=0;let presentationRevision=0;
 let frameFailure=false;let frameGeneration=0;let frameTimer:ReturnType<typeof setTimeout>|undefined;
 let readyInFlight=false;let autoReadyFailures=0;let readyDesired:boolean|undefined;let connectedFrameEpoch:number|undefined;let frameBuild:string|undefined;let lastFeedback:MessageKey|undefined;
 let lastOperation:"match"|"invite"|"join"="match";let matchingRequestId:string|undefined;let creatingRequestId:string|undefined;let copyFeedback:MessageKey|undefined;
 const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(reason:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
 async function api(path:string,body?:unknown,signal?:AbortSignal):Promise<unknown>{
  const response=await fetch(path,{method:body===undefined?"GET":"POST",credentials:"same-origin",headers:body===undefined?{Accept:"application/json"}:{Accept:"application/json","Content-Type":"application/json","X-PWA-Request":"1"},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.any([lifetime.signal,AbortSignal.timeout(12000),...(signal?[signal]:[])])});
  const data:unknown=await response.json();if(!response.ok){const code=object(data)&&object(data.error)&&typeof data.error.code==="string"?data.error.code:`HTTP_${response.status}`;throw new ApiFailure(code,response.status);}return data;
 }
 async function ensureSession():Promise<Session>{if(session&&session.expiresAt>Date.now())return session;const data=await api("/api/session",{});if(!object(data)||!object(data.session)||typeof data.session.id!=="string"||typeof data.session.playerId!=="string"||typeof data.session.expiresAt!=="number")throw new Error("SESSION_SCHEMA");session=data.session as unknown as Session;return session;}
 function ownMember(){return room?.members.find(member=>member.seatId===room!.yourSeat);}
 function finished():boolean{return room?.phase==="TERMINAL";}
 function showFailure(error:unknown):void {if(disposed)return;failure=errorKey(error);mode="error";render();}
 function publish():void{if(room&&host?.status==="CONNECTED")host.publishState({...room,locale:getLocale()},++presentationRevision);}
 function render():void{
  if(disposed)return;translate(root);root.dataset.playState=mode;
  choice.hidden=mode!=="choose"&&mode!=="cancelled";progress.hidden=["choose","cancelled","room"].includes(mode);stage.hidden=!room;
  query("#play-progress-title").textContent=t(mode==="matching"?"matching":mode==="cancelling"?"cancelling":mode==="creating"?"creating":mode==="expired"?"queueExpired":mode==="matched"?"matchFound":mode==="connecting"?"enteringRoom":"errorTitle");
  const seconds=queue?Math.max(0,Math.ceil((queue.deadlineAt-Date.now())/1000)):30;
  query("#play-progress-note").textContent=mode==="matching"?t("waitSeconds",{seconds:number(seconds)}):mode==="expired"?t("queueExpiredDescription"):mode==="matched"?t("cancelRace"):mode==="error"?t(failure):"";
  cancelButton.hidden=mode!=="matching"&&mode!=="cancelling";cancelButton.disabled=mode==="cancelling";cancelButton.textContent=t(mode==="cancelling"?"cancelling":"cancelMatch");
  retryButton.hidden=!["expired","error","matched"].includes(mode);retryButton.textContent=t(mode==="matched"?"enterRoom":mode==="error"&&queue?.status==="QUEUED"?"cancelMatch":mode==="expired"?"matchAgain":"retry");query("#play-invite-alternative").hidden=mode!=="expired";
  if(mode==="cancelled")query("#play-choice-title").textContent=t("cancelled");
  if(!room)return;
  root.dataset.roomPhase=room.phase;root.dataset.roomId=room.roomId;root.dataset.seat=room.yourSeat??"";
  const inviteUrl=new URL(`/room/${encodeURIComponent(room.roomId)}`,location.origin).href;query<HTMLInputElement>("#room-invite-url").value=inviteUrl;query<HTMLInputElement>("#room-invite-url").setAttribute("aria-label",t("inviteLink"));
  query("#room-invitation").hidden=room.members.length===2||room.phase==="TERMINAL";
  query("#room-invite-feedback").textContent=copyFeedback?t(copyFeedback):"";
  query("#room-connection").textContent=t(room.phase==="TERMINAL"?"gameEnded":socketOpen?"connectionReady":reconnectAttempts>0?"reconnecting":"connecting");query("#room-connection").classList.toggle("is-connected",socketOpen);
  const players=query("#room-players");players.replaceChildren();
  for(const seat of ["red","yellow"] as const){const member=room.members.find(item=>item.seatId===seat);const player=document.createElement("div");player.className=`room-player ${seat} ${seat===room.yourSeat?"is-you":""}`;const disc=document.createElement("span");disc.className="room-player-disc";disc.setAttribute("aria-hidden","true");const label=document.createElement("strong");label.textContent=t(seat===room.yourSeat?(seat==="red"?"youRed":"youYellow"):"opponent");const state=document.createElement("span");state.hidden=room.phase==="TERMINAL";state.textContent=t(!member?"opponentWaiting":member.prepared?"ready":"notReady");player.append(disc,label,state);players.append(player);}
  const member=ownMember();const disconnected=room.disconnectedUntil!==null&&room.disconnectedUntil>Date.now();
  const statusKey:MessageKey=room.phase==="TERMINAL"?room.result==="DISCONNECTED"?"finishedDisconnected":room.result==="SERVICE_INTERRUPTED"?"finishedInterrupted":room.winner===room.yourSeat?"finishedWin":room.winner?"finishedLose":"finishedDraw":disconnected?"disconnectedCountdown":room.phase==="PREPARING"?"preparing":room.turn===room.yourSeat?"yourMove":"theirMove";
  query("#room-status-title").textContent=t(statusKey,{seconds:number(Math.max(0,Math.ceil(((room.disconnectedUntil??Date.now())-Date.now())/1000)))});
  if(room.phase==="RUNNING"&&room.turnDeadlineAt&&!disconnected)query("#room-status-title").textContent+=" · "+t("turnRemaining",{seconds:number(Math.max(0,Math.ceil((room.turnDeadlineAt-Date.now())/1000)))});
  if(room.phase==="TERMINAL"&&room.terminationReason==="TURN_TIMEOUT")query("#room-status-title").textContent=t(room.winner===room.yourSeat?"timeoutWin":"timeoutLose");
  readyButton.hidden=room.phase!=="PREPARING";readyButton.disabled=!socketOpen||!sdkReady||baselineSeq===undefined||readyInFlight;readyButton.textContent=t(member?.prepared?"cancelReady":"prepare");
  reconnectButton.hidden=socketOpen||room.phase==="TERMINAL"||mode==="connecting";
  query("#room-ended").hidden=room.phase!=="TERMINAL";
  query("#room-feedback").textContent=lastFeedback?t(lastFeedback):room.phase==="PREPARING"&&room.members.length===1?t("waitingFriend"):"";
  const canReloadFrame=room.phase==="TERMINAL"||socketOpen&&descriptor!==undefined;
  frameWrap.dataset.frameState=frameFailure?"error":sdkReady?"ready":"loading";
  query("#game-frame-loading").hidden=sdkReady||frameFailure;
  query("#game-frame-error").hidden=!frameFailure;
  query("#game-frame-error-note").textContent=t(room.phase==="TERMINAL"?"boardReadOnlyRetryNote":canReloadFrame?"boardLoadRetryNote":"boardNeedsConnection");
  query<HTMLButtonElement>("#game-frame-reload").hidden=!canReloadFrame;
 }
 function closeFrame(reason:string):void{frameGeneration++;if(frameTimer)clearTimeout(frameTimer);frameTimer=undefined;host?.revoke(reason);host?.dispose();host=undefined;iframe?.remove();iframe=undefined;sdkReady=false;frameFailure=false;frameBuild=undefined;connectedFrameEpoch=undefined;}
 function closeSocket(reason:string):void{
  socketGeneration++;socketOpen=false;descriptor=undefined;context=undefined;baselineSeq=undefined;endpointId=undefined;runtimeId=undefined;
  const previous=socket;socket=undefined;if(previous&&previous.readyState<2)previous.close(1000,reason);
  for(const item of pending.values()){clearTimeout(item.timer);item.reject(new SdkError("AUTH_REQUIRED"));}pending.clear();closeFrame(reason);
 }
 function setRoom(next:RoomView,fromBinary=false):void{
  if(room&&next.roomId!==room.roomId)throw new Error("ROOM_MISMATCH");
  if(room&&next.revision<room.revision)return;room=next;
  if(fromBinary&&socketOpen&&descriptor){baselineSeq=next.stateSeq;if(!iframe||frameBuild!==next.gameBuildId||connectedFrameEpoch!==next.seatEpoch)attachGame();publish();if(sdkReady&&!readyInFlight&&!ownMember()?.baselineReady&&autoReadyFailures<3)void sendReady(ownMember()?.prepared??false,true);}
  if(next.phase==="TERMINAL")lastFeedback=undefined;render();
 }
 function attachGame():void{
  if(!room||!session)return;
  const readOnly=room.phase==="TERMINAL";
  if(!readOnly&&(!descriptor||!socketOpen))return;closeFrame("FRAME_REPLACED");
  const currentRoom=room;const currentSession=session;const epoch=currentRoom.seatEpoch;const socketVersion=socketGeneration;const frameVersion=frameGeneration;
  iframe=document.createElement("iframe");iframe.id="game-frame";iframe.title=t("cfTitle");iframe.setAttribute("sandbox","allow-scripts allow-same-origin");iframe.setAttribute("allow","cross-origin-isolated 'src'");iframe.referrerPolicy="no-referrer";iframe.src=currentRoom.entryUrl;
  frameBuild=currentRoom.gameBuildId;connectedFrameEpoch=epoch;
  host=new PresentationHost<{type:"drop";column:number},RoomView&{locale:string}>({iframe,frameOrigin:currentRoom.frameOrigin,gameBuildId:currentRoom.gameBuildId,
   authorize:async request=>{const value=await api(`/api/play/rooms/${currentRoom.roomId}/presentation`,{gameBuildId:request.gameBuildId,frameOrigin:request.frameOrigin,presentationInstanceId:request.presentationInstanceId},request.signal);if(!object(value)||typeof value.bindingId!=="string"||value.sessionId!==currentSession.id||typeof value.expiresAt!=="number"||!Array.isArray(value.capabilityIds))throw new SdkError("AUTH_REQUIRED");if(readOnly){if(Object.hasOwn(value,"matchScope")||value.capabilityIds.some(capability=>!["ready","state.subscribe","assets.resolve"].includes(String(capability))))throw new SdkError("AUTH_REQUIRED");}else if(!object(value.matchScope)||value.matchScope.matchId!==currentRoom.matchId||value.matchScope.seatEpoch!==epoch)throw new SdkError("AUTH_REQUIRED");return value as unknown as PresentationGrant;},
   isBindingCurrent:(binding:Readonly<PresentationBinding>)=>!disposed&&socketVersion===socketGeneration&&binding.sessionId===session?.id&&binding.expiresAt>Date.now()&&(readOnly?room?.phase==="TERMINAL"&&binding.matchScope===undefined:(socketOpen||room?.phase==="TERMINAL")&&binding.matchScope?.matchId===room?.matchId&&binding.matchScope?.seatEpoch===room?.seatEpoch),
   handlers:{ready:async()=>{if(frameVersion!==frameGeneration)return;if(frameTimer)clearTimeout(frameTimer);frameTimer=undefined;sdkReady=true;frameFailure=false;render();publish();if(!readOnly)await sendReady(ownMember()?.prepared??false,true);},parseCommand:command=>{if(!object(command)||Object.keys(command).length!==2||command.type!=="drop"||!Number.isInteger(command.column)||typeof command.column!=="number"||command.column<0||command.column>6)throw new SdkError("COMMAND_INVALID");return {type:"drop" as const,column:command.column};},dispatch:command=>dispatch(command)},
   onStatus:(status)=>{if(frameVersion!==frameGeneration)return;if(status==="CONNECTED")publish();if(status==="REVOKED"){if(frameTimer)clearTimeout(frameTimer);frameTimer=undefined;sdkReady=false;frameFailure=true;render();}},
  });
  frameWrap.append(iframe);
  // A browser loading deadline only: it never closes a room or changes a result.
  frameTimer=setTimeout(()=>{if(!disposed&&frameVersion===frameGeneration&&!sdkReady)host?.revoke("BOARD_LOAD_TIMEOUT");},20000);
  render();
 }
 async function sendReady(prepared:boolean,automatic=false):Promise<void>{
  if(!room||!descriptor||baselineSeq===undefined||!sdkReady||!socketOpen||readyInFlight||room.phase==="TERMINAL")return;
  readyInFlight=true;readyDesired=prepared;const current=room;const baseline={descriptorId:descriptor.descriptorId,stateSeq:baselineSeq};let retryAutomatic=false;render();
  try{const response=await api(`/api/play/rooms/${current.roomId}/ready`,{requestId:id(),expectedMatchRevision:current.revision,resourcesReady:true,baselineReady:true,prepared,baseline});setRoom(roomValue(response));autoReadyFailures=0;lastFeedback=undefined;}
  catch(error){if(automatic)autoReadyFailures++;lastFeedback=error instanceof ApiFailure&&error.status===409?"actionFailed":errorKey(error);if(error instanceof ApiFailure&&error.status===409&&automatic&&autoReadyFailures<3){try{const refreshed=roomValue(await api(`/api/play/rooms/${current.roomId}/status`));setRoom(refreshed);retryAutomatic=true;}catch{/* A failed refresh cannot turn a failed READY into success. */}}}
  finally{readyInFlight=false;readyDesired=undefined;render();}
  if(retryAutomatic&&!disposed&&socketOpen&&!finished()&&!ownMember()?.baselineReady)await sendReady(ownMember()?.prepared??false,true);
 }
 function dispatch(command:{type:"drop";column:number}):Promise<unknown>{
  if(!room||!socket||socket.readyState!==WebSocket.OPEN||!context||!descriptor||!endpointId||!runtimeId||room.phase!=="RUNNING"||!ownMember()?.baselineReady||!ownMember()?.resourcesReady)throw new SdkError("AUTH_REQUIRED");
  if(pending.size||socket.bufferedAmount>32768)throw new SdkError("BACKPRESSURE");
  const stream=descriptor.streams.find(item=>item.kind==="COMMAND"&&item.fromEndpointId===endpointId&&item.toEndpointId===runtimeId);if(!stream)throw new SdkError("CAPABILITY_UNAVAILABLE");
  const seq=commandSeq++;const raw=encodeFrame({header:{opcode:Opcode.COMMAND,flags:0,streamId:stream.streamId,contextTag:context.contextTag,seq,tick:0},payload:{kind:"COMMAND",data:new TextEncoder().encode(JSON.stringify(command))}},{context,senderEndpointId:endpointId,receiverEndpointId:runtimeId,nowMs:Date.now(),receivePositions:new Map([[stream.streamId,seq]])});
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(seq);lastFeedback="actionFailed";reject(new SdkError("REQUEST_TIMEOUT"));closeSocket("COMMAND_STATUS_UNKNOWN");render();},9000);pending.set(seq,{resolve,reject,timer});socket!.send(raw);});
 }
 function sendControl(message:ControlMessage):void{if(!socket||socket.readyState!==WebSocket.OPEN)throw new Error("SOCKET_CLOSED");socket.send(encodeControl(message));}
 async function handleSocket(data:string|ArrayBuffer,generation:number):Promise<void>{
  if(generation!==socketGeneration||!room)return;
  if(typeof data==="string"){
   const message=parseControl(data,{channel:"platform"});
   if(descriptor&&message.type!=="PROTOCOL_ERROR"&&(message.contextTag??(message.type==="LINK_BOUND"?message.body.contextTag:undefined))!==descriptor.contextTag)throw new Error("CONTEXT_MISMATCH");
   if(message.type==="AUTH_ACCEPTED"){
    const ownEndpoint=message.body.endpointId;
    const accepted=message.body.descriptors.find(item=>item.roomId===room!.roomId&&item.matchId===room!.matchId&&item.gameBuildId===room!.gameBuildId&&item.profileId==="server-turn"&&item.profileVersion===1&&item.authorityEpoch===room!.authorityEpoch);if(!accepted||accepted.endpoints.find(item=>item.endpointId===ownEndpoint)?.inputSessionId!==session?.id)throw new Error("DESCRIPTOR_SCOPE");
    descriptor=accepted;endpointId=message.body.endpointId;runtimeId=accepted.endpoints.find(item=>item.endpointId!==endpointId)?.endpointId;if(!runtimeId)throw new Error("DESCRIPTOR_SCOPE");
    context={descriptorId:accepted.descriptorId,contextTag:BigInt(`0x${accepted.contextTag}`),endpoints:[endpointId,runtimeId],validFromMs:accepted.validFromMs,validUntilMs:accepted.validUntilMs,maxFrameBytes:accepted.limits.maxFrameBytes,maxBulkBytes:accepted.limits.maxBulkBytes,streams:accepted.streams.map(stream=>({...stream,maxAhead:0xffff_fffe,...(stream.kind==="STATE"?{usesTick:false}:{})}))};
    sendControl({v:1,type:"LINK_BIND",requestId:id(),body:{descriptorId:accepted.descriptorId,contextTag:accepted.contextTag}});
   }else if(message.type==="LINK_BOUND"){
    if(!descriptor||message.body.descriptorId!==descriptor.descriptorId)throw new Error("DESCRIPTOR_SCOPE");const command=descriptor.streams.find(item=>item.kind==="COMMAND"&&item.fromEndpointId===endpointId);if(!command||!message.body.acceptedStreams.includes(command.streamId))throw new Error("STREAM_UNBOUND");commandSeq=message.body.receiveCursors.find(cursor=>cursor.logicalStreamId===command.logicalStreamId)?.nextExpected??command.firstPosition;socketOpen=true;reconnectAttempts=0;mode="room";render();
   }else if(message.type==="ACTION_RECEIPT"){
    const command=descriptor?.streams.find(item=>item.kind==="COMMAND"&&item.fromEndpointId===endpointId);if(!command||message.body.logicalStreamId!==command.logicalStreamId)return;const item=pending.get(message.body.commandSeq);if(item&&(message.body.outcome.status==="COMMITTED"||message.body.outcome.status==="REJECTED")){clearTimeout(item.timer);pending.delete(message.body.commandSeq);item.resolve(message.body.outcome);}
   }else if(message.type==="PROTOCOL_ERROR"){throw new ApiFailure(message.body.code,400);}
  }else{
   if(!context||!descriptor||!endpointId||!runtimeId||!socketOpen)throw new Error("CONTEXT_UNBOUND");
   const frame=decodeFrame(new Uint8Array(data),{context,senderEndpointId:runtimeId,receiverEndpointId:endpointId,nowMs:Date.now()});
   if(frame.payload.kind!=="STATE"||!(frame.header.flags&FULL_STATE))throw new Error("STATE_REQUIRED");const view=roomValue({room:JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(frame.payload.data))});if(view.stateSeq!==frame.header.seq||view.matchId!==room.matchId||view.seatEpoch!==descriptor.endpoints.find(item=>item.endpointId===endpointId)?.seatEpoch)throw new Error("STATE_SCOPE");setRoom(view,true);
  }
 }
 async function connect():Promise<void>{
  if(!room||disposed)return;
  if(room.phase==="TERMINAL"){mode="room";attachGame();render();return;}
  closeSocket("RECONNECTING");if(reconnectTimer)clearTimeout(reconnectTimer);mode="connecting";lastFeedback=undefined;render();const target=room.roomId;const generation=socketGeneration;
  try{
   await ensureSession();const response=await api(`/api/play/rooms/${target}/grant`,{requestId:id()});if(!object(response)||response.roomId!==target||typeof response.joinTicket!=="string"||response.joinTicket.length>2048||typeof response.wsUrl!=="string"||typeof response.expiresAt!=="number"||response.executionClass!=="hibernated-turn"||!object(response.syncPolicy)||response.syncPolicy.profileId!=="server-turn"||response.syncPolicy.profileVersion!==1||!Array.isArray(response.syncPolicy.protocolVersions)||!response.syncPolicy.protocolVersions.includes(1))throw new Error("GRANT_SCHEMA");const grant=response as unknown as Grant;const url=new URL(grant.wsUrl);if((url.protocol!=="wss:"&&!(location.hostname==="127.0.0.1"&&url.protocol==="ws:"&&url.hostname==="127.0.0.1"))||url.search||url.hash||url.username||url.password)throw new Error("SOCKET_ORIGIN");if(disposed||generation!==socketGeneration)return;
   const ws=new WebSocket(url.href);ws.binaryType="arraybuffer";socket=ws;let joined=false;let chain=Promise.resolve();
   const timer=setTimeout(()=>{if(!joined&&generation===socketGeneration){lastFeedback="connectionFailed";ws.close(1000,"HANDSHAKE_TIMEOUT");}},12000);
   ws.addEventListener("open",()=>{if(generation!==socketGeneration)return;sendControl({v:1,type:"AUTH_JOIN",requestId:id(),body:{joinGrant:grant.joinTicket,protocolVersions:grant.syncPolicy.protocolVersions,profileId:grant.syncPolicy.profileId,profileVersion:grant.syncPolicy.profileVersion}});grant.joinTicket="";});
   ws.addEventListener("message",event=>{chain=chain.then(async()=>{await handleSocket(event.data as string|ArrayBuffer,generation);if(socketOpen){joined=true;clearTimeout(timer);}}).catch(error=>{if(generation===socketGeneration){lastFeedback=errorKey(error);ws.close(1000,"PROTOCOL_REJECTED");render();}});});
   ws.addEventListener("close",event=>{clearTimeout(timer);if(disposed||generation!==socketGeneration)return;socketOpen=false;if(room?.phase!=="TERMINAL"){host?.revoke("CONNECTION_LOST");sdkReady=false;}for(const item of pending.values()){clearTimeout(item.timer);item.reject(new SdkError("AUTH_REQUIRED"));}pending.clear();mode="room";
    const replaced=event.code===4001||event.reason==="PRESENTATION_REPLACED";
    const stopped=event.reason.startsWith("SAFETY_")||event.reason==="SESSION_REVOKED";
    if(replaced)lastFeedback="oldPage";else if(stopped)lastFeedback=event.reason.startsWith("SAFETY_")?"safetyBlocked":"authRequired";
    render();if(room?.phase!=="TERMINAL"&&!replaced&&!stopped&&reconnectAttempts<3){reconnectAttempts++;reconnectTimer=setTimeout(()=>{void connect();},[1000,2500,5000][reconnectAttempts-1]??5000);}else if(room?.phase!=="TERMINAL"&&!replaced&&!stopped){lastFeedback="reconnectFailed";render();}});
   ws.addEventListener("error",()=>{/* close carries the bounded recovery path. */});
  }catch(error){if(disposed||generation!==socketGeneration)return;if(error instanceof ApiFailure&&error.code==="MATCH_TERMINAL"){try{const latest=roomValue(await api(`/api/play/rooms/${target}/status`));if(latest.phase==="TERMINAL"){setRoom(latest);mode="room";attachGame();render();return;}}catch{/* Preserve the original failure if status is unavailable. */}}mode="room";lastFeedback=errorKey(error);render();}
 }
 async function enterRoom(roomId:string,join=true):Promise<void>{
  lastOperation="join";mode="connecting";render();try{await ensureSession();const response=await api(`/api/play/rooms/${encodeURIComponent(roomId)}${join?"/join":"/status"}`,join?{requestId:id()}:undefined);room=roomValue(response);history.replaceState(null,"",`/room/${room.roomId}`);mode="room";render();await connect();}catch(error){showFailure(error);}
 }
 async function createRoom():Promise<void>{if(disposed||mode==="creating")return;lastOperation="invite";creatingRequestId??=id();queueGeneration++;stopQueue();mode="creating";render();try{await ensureSession();room=roomValue(await api("/api/play/rooms",{requestId:creatingRequestId}));creatingRequestId=undefined;history.replaceState(null,"",`/room/${room.roomId}`);mode="room";render();await connect();}catch(error){showFailure(error);}}
 function acceptQueue(next:QueueView,generation:number):void{
  if(disposed||generation!==queueGeneration)return;queue=next;
  if(next.status==="ASSIGNED"&&next.roomId){matchingRequestId=undefined;mode="matched";render();void enterRoom(next.roomId,false);return;}
  if(next.status==="EXPIRED"){matchingRequestId=undefined;mode="expired";render();return;}if(next.status==="CANCELLED"){matchingRequestId=undefined;mode="cancelled";render();return;}
  mode="matching";render();if(!queueSocket)watchQueue(next,generation);
 }
 function stopQueue():void{const previous=queueSocket;queueSocket=undefined;if(queueTimer)clearTimeout(queueTimer);queueTimer=undefined;if(previous&&previous.readyState<2)previous.close(1000,"QUEUE_FINISHED");}
 function watchQueue(next:QueueView,generation:number):void{
  if(!next.watchUrl){mode="error";failure="connectionFailed";render();return;}
  const url=new URL(next.watchUrl);if(url.origin!==location.origin.replace(/^http/,"ws")||url.search||url.hash||url.username||url.password){mode="error";failure="connectionFailed";render();return;}
  const ws=new WebSocket(url.href);queueSocket=ws;
  const reconcile=():void=>{void api(`/api/play/queue/${encodeURIComponent(next.intentId)}`).then(value=>{if(generation!==queueGeneration||disposed)return;const latest=queueValue(value);if(latest.status==="QUEUED"){mode="error";failure="connectionFailed";render();}else acceptQueue(latest,generation);}).catch(()=>{if(generation===queueGeneration){mode="error";failure="connectionFailed";render();}});};
  ws.addEventListener("message",event=>{if(disposed||generation!==queueGeneration||queueSocket!==ws)return;try{if(typeof event.data!=="string"||event.data.length>4096)throw new Error("QUEUE_MESSAGE");const message:unknown=JSON.parse(event.data);if(!object(message)||message.type!=="QUEUE_STATE"||!object(message.body))throw new Error("QUEUE_MESSAGE");const view=queueValue(message.body);if(view.intentId!==next.intentId)throw new Error("QUEUE_SCOPE");if(view.status!=="QUEUED")stopQueue();acceptQueue(view,generation);}catch{stopQueue();mode="error";failure="connectionFailed";render();}});
  ws.addEventListener("close",()=>{if(disposed||generation!==queueGeneration||queueSocket!==ws)return;queueSocket=undefined;if(queue?.status==="QUEUED"&&mode==="matching")reconcile();});
  ws.addEventListener("error",()=>{/* A close reconciles once; no periodic HTTP polling. */});
  queueTimer=setTimeout(()=>{if(disposed||generation!==queueGeneration||queue?.status!=="QUEUED")return;stopQueue();reconcile();},Math.max(0,next.deadlineAt-Date.now())+1500);
 }

 async function match():Promise<void>{if(disposed||mode==="matching"||mode==="creating")return;lastOperation="match";matchingRequestId??=id();const generation=++queueGeneration;stopQueue();mode="matching";queue=undefined;render();try{await ensureSession();acceptQueue(queueValue(await api("/api/play/queue",{requestId:matchingRequestId})),generation);}catch(error){if(generation===queueGeneration)showFailure(error);}}
 function cancellationResult(next:QueueView):void{queue=next;if(next.status==="QUEUED"){mode="error";failure="actionFailed";}else{matchingRequestId=undefined;mode=next.status==="ASSIGNED"?"matched":next.status==="EXPIRED"?"expired":"cancelled";}render();}
 async function cancel():Promise<void>{if(!queue||(mode!=="matching"&&mode!=="error"))return;queueGeneration++;stopQueue();mode="cancelling";render();try{cancellationResult(queueValue(await api(`/api/play/queue/${queue.intentId}/cancel`,{requestId:id(),expectedRevision:queue.revision})));}catch(error){if(error instanceof ApiFailure&&error.status===409){try{cancellationResult(queueValue(await api(`/api/play/queue/${queue.intentId}`)));return;}catch{/* Report the actual failure below. */}}showFailure(error);}}
 query<HTMLButtonElement>("#play-match").addEventListener("click",()=>{void match();});query<HTMLButtonElement>("#play-invite").addEventListener("click",()=>{void createRoom();});query<HTMLButtonElement>("#play-invite-alternative").addEventListener("click",()=>{void createRoom();});cancelButton.addEventListener("click",()=>{void cancel();});retryButton.addEventListener("click",()=>{if(mode==="matched"&&queue?.roomId)void enterRoom(queue.roomId,false);else if(mode==="error"&&queue?.status==="QUEUED")void cancel();else if(lastOperation==="invite")void createRoom();else if(invitationRoomId)void enterRoom(invitationRoomId);else void match();});
 readyButton.addEventListener("click",()=>{void sendReady(!(ownMember()?.prepared??false));});reconnectButton.addEventListener("click",()=>{reconnectAttempts=0;void connect();});
 query<HTMLButtonElement>("#game-frame-reload").addEventListener("click",()=>{if(disposed||!frameFailure||!room||(room.phase!=="TERMINAL"&&(!socketOpen||!descriptor)))return;attachGame();});
 query<HTMLButtonElement>("#copy-invite").addEventListener("click",()=>{const input=query<HTMLInputElement>("#room-invite-url");const fallback=()=>{query("#room-invitation").hidden=false;input.focus();input.select();copyFeedback="copyFailed";query("#room-invite-feedback").textContent=t(copyFeedback);};if(!navigator.clipboard){fallback();return;}void navigator.clipboard.writeText(input.value).then(()=>{copyFeedback="copied";query("#room-invite-feedback").textContent=t(copyFeedback);}).catch(fallback);});
 const localeChanged=()=>{if(iframe)iframe.title=t("cfTitle");render();publish();};window.addEventListener("pwa:locale",localeChanged);
 const countdown=setInterval(()=>{if(mode==="matching"||room?.disconnectedUntil||room?.turnDeadlineAt)render();},1000);
 const dispose=():void=>{if(disposed)return;disposed=true;lifetime.abort();queueGeneration++;stopQueue();if(reconnectTimer)clearTimeout(reconnectTimer);clearInterval(countdown);window.removeEventListener("pwa:locale",localeChanged);closeSocket("PAGE_UNLOADED");};window.addEventListener("pagehide",dispose,{once:true});
 render();if(invitationRoomId)void enterRoom(invitationRoomId);else{const initialMode=new URL(location.href).searchParams.get("mode");if(initialMode==="match")void match();if(initialMode==="invite")void createRoom();}
 return dispose;
}
