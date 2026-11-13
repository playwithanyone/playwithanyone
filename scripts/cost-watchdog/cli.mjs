// Explicit operator CLI, never automatically installs a scheduler or sends a message.
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectAll, boundedJson } from "./collect.mjs";
import { evaluateMetrics, initialState, protectionCommand, recoverState, validateConfig } from "./core.mjs";
import { deliverEvaluation } from "./delivery.mjs";
import { readCompleteManagementStatus } from "./management-scan.mjs";

const args=process.argv.slice(2);const command=args.shift();const flags={};
for(let index=0;index<args.length;index+=1){const key=args[index];if(!key.startsWith('--')||Object.hasOwn(flags,key))throw new Error('WATCHDOG_ARGUMENT_INVALID');if(key==='--apply')flags[key]=true;else{const value=args[++index];if(!value||value.startsWith('--'))throw new Error('WATCHDOG_ARGUMENT_VALUE_REQUIRED');flags[key]=value;}}
if(!['collect','plan','run','recover'].includes(command)||!flags['--config'])throw new Error('Usage: cli.mjs collect|plan|run|recover --config FILE [--metrics FILE --state FILE --report FILE --start ISO --through ISO --apply --actor NAME --reason TEXT --validation-record FILE]');
const allowed=new Set(['--config','--metrics','--state','--report','--start','--through','--apply','--actor','--reason','--validation-record']);
if(Object.keys(flags).some(key=>!allowed.has(key)))throw new Error('WATCHDOG_UNKNOWN_ARGUMENT');
async function readJson(file,optional=false){try{const content=await readFile(file,'utf8');if(content.length>2*1024*1024)throw new Error('WATCHDOG_FILE_TOO_LARGE');return JSON.parse(content);}catch(error){if(optional&&error.code==='ENOENT')return undefined;throw error;}}
async function atomicJson(file,value,maximumBytes){const content=JSON.stringify(value,null,2)+'\n';if(Buffer.byteLength(content)>maximumBytes)throw new Error('WATCHDOG_OUTPUT_LIMIT');await mkdir(path.dirname(file),{recursive:true});const temporary=`${file}.${process.pid}.tmp`;await writeFile(temporary,content,{mode:0o600});await rename(temporary,file);}
const config=validateConfig(await readJson(flags['--config']));const now=Date.now();
const reportPath=flags['--report']??`artifacts/cost/watchdog-${new Date(now).toISOString().replaceAll(':','-')}.json`;
if(command==='collect'){
 if(!flags['--start']||!flags['--through'])throw new Error('EXPLICIT_METRIC_WINDOW_REQUIRED');
 const start=Date.parse(flags['--start']),end=Date.parse(flags['--through']);if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end>now||end<=start)throw new Error('METRIC_WINDOW_INVALID');
 const window={id:`${flags['--start']}/${flags['--through']}`,start,end};
 const observations=await collectAll(config,window,{token:process.env['PWA_CF_METRICS_TOKEN'],now});
 await atomicJson(reportPath,{schemaVersion:1,environment:config.environment,collectedAt:now,window,observations},config.maxLogBytes);
 console.log(JSON.stringify({report:reportPath,metrics:observations.map(item=>({id:item.id,quality:item.quality,reason:item.reason??null})),liveProtectionEnabled:false}));
}else{
 if(!flags['--state']||!flags['--metrics'])throw new Error('WATCHDOG_STATE_AND_METRICS_REQUIRED');
 const statePath=flags['--state'];await mkdir(path.dirname(statePath),{recursive:true});let lock;
 try{
  if(flags['--apply'])lock=await open(`${statePath}.lock`,'wx',0o600);
  const old=await readJson(statePath,true)??initialState(config.environment);const metrics=await readJson(flags['--metrics']);
  if(metrics.environment!==config.environment||!Array.isArray(metrics.observations))throw new Error('METRIC_ENVIRONMENT_MISMATCH');
  let evaluation=evaluateMetrics(config,old,metrics.observations,now);
  const apply=flags['--apply']===true;
  if(apply&&config.enabled!==true)throw new Error('POLICY_REQUIRED:watchdog configuration is deliberately disabled');
  const started=Date.now();let calls=0;
  async function request(url,token,body){
   const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||!config.allowedManagementOrigins.includes(parsed.origin)||!parsed.pathname.startsWith('/api/ops/'))throw new Error('MANAGEMENT_TARGET_NOT_ALLOWLISTED');
   if(!token||token.length<32||++calls>config.maxApiCalls)throw new Error('MANAGEMENT_CREDENTIAL_OR_CALL_LIMIT');
   const remaining=config.maxRunMs-(Date.now()-started);if(remaining<=0)throw new Error('WATCHDOG_RUNTIME_LIMIT');
   const response=await fetch(parsed,{method:'POST',redirect:'error',signal:AbortSignal.timeout(Math.min(remaining,config.requestTimeoutMs)),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body)});
   return boundedJson(response,config.maxResponseBytes);
  }
  const managementStatus=token=>readCompleteManagementStatus(body=>request(config.management.verifyUrl,token,body),{maxPages:Math.min(64,config.maxApiCalls)});
  if(command==='recover'){
   if(!apply||!flags['--actor']||!flags['--reason']||!flags['--validation-record']||!config.management?.recoveryUrl)throw new Error('RECOVERY_REQUIRES_EXPLICIT_APPLY_ACTOR_REASON_VALIDATION_AND_ENDPOINT');
   const record={authenticated:true,actor:flags['--actor'],reason:flags['--reason'],configurationVersion:String(config.configurationVersion),validationRecord:flags['--validation-record'],serverObservedRecovery:false};
   const validation=await readJson(flags['--validation-record']);if(validation.status!=='PASS'||validation.environment!==config.environment||validation.configurationVersion!==config.configurationVersion)throw new Error('RECOVERY_VALIDATION_INVALID');
   const candidate={...old,version:old.version+1,state:'NORMAL',reasons:[],incidentId:null};
   const commandBody={operation:'recover',protection:{...protectionCommand(candidate,config,now),operator:record.actor},record:{actor:record.actor,reason:record.reason,configurationVersion:record.configurationVersion,validationRecord:record.validationRecord}};
   await request(config.management.recoveryUrl,process.env['PWA_SAFETY_RECOVERY_TOKEN'],commandBody);
   const {status:observed}=await managementStatus(process.env['PWA_SAFETY_RECOVERY_TOKEN']);
   if(observed.state!=='NORMAL'||observed.version!==candidate.version||observed.fullRecoveryObserved!==true||observed.d1?.state!=='NORMAL')throw new Error('RECOVERY_NOT_OBSERVED');
   record.serverObservedRecovery=true;evaluation={...evaluation,state:recoverState(old,record,now),shouldStop:false,shouldNotify:false};
  }else if(apply&&command==='run'){
   // Persist the incident before contacting downstream systems; never clear it on a failure.
   await atomicJson(statePath,evaluation.state,config.maxLogBytes);
   const receipts=[];
   if(config.management?.stopUrl){
    try{
     await request(config.management.stopUrl,process.env['PWA_SAFETY_STOP_TOKEN'],{operation:'protect',protection:protectionCommand(evaluation.state,config,now)});
     receipts.push({action:'persist-and-propagate',status:'ACKNOWLEDGED'});
    }catch{receipts.push({action:'persist-and-propagate',status:'FAILED'});}
    if(evaluation.shouldStop){try{const {status:observed,pages}=await managementStatus(process.env['PWA_SAFETY_STOP_TOKEN']);const stopped=observed.state===evaluation.state.state&&observed.version===evaluation.state.version&&observed.newAllocationsBlocked===true&&observed.activeConnections===0&&observed.backgroundTasks===0&&observed.roomsObservedStopped===true&&observed.unobservedRooms===0&&observed.propagationPending!==true&&observed.propagationFailed!==true;receipts.push({action:'verify-stop',status:stopped?'OBSERVED_STOPPED':'UNCONFIRMED',pages});}catch{receipts.push({action:'verify-stop',status:'FAILED'});}}
   }else if(evaluation.shouldStop)receipts.push({action:'persist-and-propagate',status:'FAILED'});
   evaluation.state.receipts=receipts;
   // Both channels keep independent durable receipts. Provider acceptance is
   // recorded before a later tick can retry; notification failures never undo stop.
   if(evaluation.shouldNotify){
    try{
     const notifications=await deliverEvaluation({evaluation,config,env:process.env,
      saveState:snapshot=>atomicJson(statePath,snapshot,config.maxLogBytes),
      maxRunMs:Math.max(1,config.maxRunMs-(Date.now()-started)),
      reserveCall:()=>Date.now()-started<config.maxRunMs&&++calls<=config.maxApiCalls});
     for(const item of notifications)if(item.status!=='DISABLED')evaluation.state.receipts.push({action:`notify-${item.channel}`,status:item.status==='ACKNOWLEDGED'?'ACKNOWLEDGED':item.status==='UNCONFIRMED'?'UNCONFIRMED':'FAILED'});
    }catch{evaluation.state.receipts.push({action:'notify',status:'UNCONFIRMED'});}
   }
   if(evaluation.state.receipts.some(item=>item.status==='FAILED'||item.status==='UNCONFIRMED'))process.exitCode=2;
  }else if(apply)throw new Error('PLAN_NEVER_APPLIES_MUTATIONS');
  const report={schemaVersion:1,environment:config.environment,command,applied:apply,checkedAt:now,...evaluation,productionReady:false,notVerified:['Scheduler deployment and actual heartbeat loss','Actual notification delivery','Cloudflare WAF and Spend Policy block','TURN revocation','Official metrics account permissions/completeness unless separately evidenced']};
  if(apply)await atomicJson(statePath,evaluation.state,config.maxLogBytes);
  await atomicJson(reportPath,report,config.maxLogBytes);
  console.log(JSON.stringify({report:reportPath,state:evaluation.state.state,applied:apply,receipts:evaluation.state.receipts}));
 }finally{if(lock){await lock.close();await rm(`${statePath}.lock`);}}
}
