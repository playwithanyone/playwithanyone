import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { evaluateMetrics, initialState, notificationPayload, recoverState, validateConfig } from "../../../scripts/cost-watchdog/core.mjs";
import { collectMetric, collectAll } from "../../../scripts/cost-watchdog/collect.mjs";

function config() {
  const value=JSON.parse(readFileSync('configs/safety.watchdog.preview.example.json','utf8'));
  return {...value,environment:'fixture',accountId:'0'.repeat(32),configurationVersion:1,maxMetricAgeMs:1000,missingDataStopMs:2000,drainMs:500,metrics:[{id:'requests',service:'workers',kind:'workers-requests',resource:'fixture-worker',unit:'requests',warn:10,stop:20,maxPerSecond:null,coverageEvidence:'fixture-only',verifiedMaximumLagMs:0}]};
}
function metric(value,now=10000,windowId='fixture-window') { return {id:'requests',service:'workers',unit:'requests',windowId,windowStart:0,windowEnd:1_000_000,dataThrough:now,collectedAt:now,value,quality:'VALID',source:'FIXTURE_ONLY'}; }

test('COST-12 failures remain unknown and stale data reaches a bounded drain/block instead of zero',()=>{
 const c=config();let value=evaluateMetrics(c,initialState('fixture'),[],10000);
 assert.equal(value.state.state,'WARNING');assert.equal(value.observations[0].quality,'UNAVAILABLE');assert.equal(value.observations[0].value,null);
 value=evaluateMetrics(c,value.state,[],12001);assert.equal(value.state.state,'DRAINING');assert.equal(value.shouldStop,true);
 value=evaluateMetrics(c,value.state,[],12502);assert.equal(value.state.state,'BLOCKED');
 const regained=evaluateMetrics(c,value.state,[metric(0,12503)],12503);assert.equal(regained.state.state,'BLOCKED');
 const stale=evaluateMetrics(c,initialState('fixture'),[metric(0,10000)],13000);assert.equal(stale.observations[0].quality,'STALE');assert.equal(stale.observations[0].value,null);
});

test('COST-16 cumulative observations replace snapshots; a new billing window does not unlock incident',()=>{
 const c=config();const first=evaluateMetrics(c,initialState('fixture'),[metric(9,10000)],10000);
 const second=evaluateMetrics(c,first.state,[metric(11,11000)],11000);
 assert.equal(second.state.lastMetrics.requests.value,11);assert.equal(second.state.state,'WARNING');
 const third=evaluateMetrics(c,second.state,[metric(1,12000,'next-window')],12000);
 assert.equal(third.state.state,'WARNING');assert.equal(third.state.lastMetrics.requests.value,1);
 const regressed=evaluateMetrics(c,first.state,[metric(8,11000)],11000);assert.equal(regressed.observations[0].quality,'UNAVAILABLE');
});

test('COST-12 recent growth can trigger stop before the cumulative stop threshold',()=>{
 const c=config();c.metrics[0].maxPerSecond=1;
 const first=evaluateMetrics(c,initialState('fixture'),[metric(1,10000)],10000);
 const second=evaluateMetrics(c,first.state,[metric(3,11000)],11000);
 assert.equal(second.state.state,'DRAINING');assert.ok(second.state.reasons.includes('requests:GROWTH_RATE'));
});

test('COST-19 notification data is bounded operational metadata and does not copy arbitrary source secrets',()=>{
 const c=config();const item={...metric(25),Cookie:'must-never-leave',sdp:'private',token:'private'};
 const value=evaluateMetrics(c,initialState('fixture'),[item],10000);
 const payload=JSON.stringify(notificationPayload(value,c));assert.equal(payload.includes('must-never-leave'),false);assert.equal(payload.includes('private'),false);
 const notified={...value.state,lastNotification:{incidentId:value.state.incidentId,level:value.state.state,at:10000}};
 assert.equal(evaluateMetrics(c,notified,[metric(25,10400)],10400).shouldNotify,false);
 notified.receipts=[{action:'close-rooms',status:'FAILED'}];assert.equal(evaluateMetrics(c,notified,[metric(25,10400)],10400).shouldNotify,true);
});

test('COST-20 recovery needs an authenticated manual record and observed server recovery',()=>{
 const old=initialState('fixture');old.state='BLOCKED';
 assert.throws(()=>recoverState(old,{authenticated:true,actor:'admin',reason:'repair',configurationVersion:'1',validationRecord:'proof',serverObservedRecovery:false},10000),/RECOVERY_REQUIRED/);
 const next=recoverState(old,{authenticated:true,actor:'admin',reason:'repair',configurationVersion:'1',validationRecord:'proof',serverObservedRecovery:true},10000);
 assert.equal(next.state,'NORMAL');assert.equal(next.recovered.validationRecord,'proof');
});

test('COST-12/21 official GraphQL errors/permissions and absent completeness evidence never produce a valid zero',async()=>{
 const c=config();const m=c.metrics[0];const window={id:'fixture',start:0,end:10000};
 const forbidden=await collectMetric(m,c,window,{token:'fixture-only',now:10000,fetcher:async()=>new Response('unavailable',{status:403})});
 assert.equal(forbidden.quality,'UNAVAILABLE');assert.equal(forbidden.value,null);assert.equal(forbidden.reason,'METRIC_HTTP_403');
 const json={data:{viewer:{accounts:[{workersInvocationsAdaptive:[{sum:{requests:5}}]}]}}};
 const collected=await collectMetric({...m,coverageEvidence:null},c,window,{token:'fixture-only',now:10000,fetcher:async()=>Response.json(json)});
 assert.equal(collected.value,5);assert.equal(collected.quality,'UNAVAILABLE');assert.equal(collected.reason,'COVERAGE_BOUND_UNVERIFIED');
 const valid=await collectMetric(m,c,window,{token:'fixture-only',now:10000,fetcher:async()=>Response.json(json)});assert.equal(valid.quality,'VALID');
 const leak=await collectMetric(m,c,window,{token:'secret-must-not-print',now:10000,fetcher:async()=>Response.json({errors:[{message:'secret-must-not-print'}]})});assert.equal(JSON.stringify(leak).includes('secret-must-not-print'),false);
});

test('COST-11/21 disabled TURN has no pretend metrics or pretend usage_block guarantee',async()=>{
 const c=config();const value=await collectMetric({...c.metrics[0],kind:'turn-bandwidth',service:'turn'},c,{id:'fixture',start:0,end:10000},{token:'fixture-only',now:10000,fetcher:async()=>{throw new Error('must not call');}});
 assert.equal(value.quality,'UNAVAILABLE');assert.equal(value.reason,'METRIC_ADAPTER_UNAVAILABLE');assert.equal(value.value,null);
 const production={...c,environment:'production'};assert.throws(()=>validateConfig(production),/POLICY_REQUIRED/);
});

test('COST-13 collector has an explicit independent execution and API-call bound',async()=>{
 const c=config();c.maxApiCalls=0;let calls=0;
 await assert.rejects(()=>collectAll(c,{id:'fixture',start:0,end:10000},{token:'fixture',fetcher:async()=>{calls+=1;return Response.json({});}}),/API_CALL_LIMIT/);
 assert.equal(calls,0);
});
