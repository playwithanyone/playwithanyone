// Read-only provider snapshots for one already-completed, bounded workload.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadClient, readMetricCredential, discoverProjectNamespaces, collectOfficialResources } from './collect.mjs';
const input=process.argv[2];
if(!input||!/^artifacts\/resource-profile\/[a-zA-Z0-9_.-]+\.json$/.test(input))throw new Error('EXPLICIT_COMPLETED_RESOURCE_REPORT_REQUIRED');
const run=JSON.parse(await readFile(input,'utf8'));
const scenarios=run.scenarios??[run];
if(!scenarios.length||scenarios.some(s=>s.status!=='PASS'||!Number.isSafeInteger(s.startedAt)||!Number.isSafeInteger(s.endedAt)||s.endedAt>s.startedAt+900000))throw new Error('COMPLETED_BOUNDED_RUN_REQUIRED');
const cloud=JSON.parse(await readFile('configs/cloud/resources.json','utf8'));const gameBuildId=run.gameBuildId??scenarios[0].gameBuildId;const registered=cloud.registeredBuilds.find(item=>item.gameBuildId===gameBuildId);if(!registered)throw new Error('RESOURCE_BUILD_NOT_REGISTERED');const scriptNames=[cloud.shellWorkerName,new URL(registered.frameOrigin).hostname.split('.')[0],cloud.assetWorkerName];
const client=createReadClient({token:await readMetricCredential(),maxCalls:16}),namespaces=await discoverProjectNamespaces(client);
const windows=[{label:'all',start:Math.min(...scenarios.map(s=>s.startedAt))-15000,end:Math.max(...scenarios.map(s=>s.endedAt))+15000},...scenarios.map(s=>({label:s.scenario,start:s.startedAt,end:s.endedAt}))];
for(const s of scenarios)for(const obs of s.observations??[])if(obs.kind==='quiet-room')windows.push({label:'idle-quiet',start:obs.quietStartedAt,end:obs.quietEndedAt});
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),directory=input.replace(/\.json$/,'')+'-official';await mkdir(directory,{recursive:true});
const records=[];
for(const w of windows){if(w.end>Date.now())throw new Error('RESOURCE_WINDOW_NOT_FINISHED');const report=await collectOfficialResources(client,{...w,namespaces,scriptNames});const filename=`${directory}/${w.label}-${stamp}.json`;await writeFile(filename,JSON.stringify(report,null,2)+'\n');const totals={};for(const[k,v]of Object.entries(report.observations)){if(!v.rows?.length){totals[k]={quality:v.quality};continue;}const sum={};for(const row of v.rows)for(const[field,value]of Object.entries(row.sum??{}))sum[field]=(sum[field]??0)+value;totals[k]={quality:v.quality,rows:v.rows.length,sum,sampleMax:v.sampleIntervalMaximum};}records.push({label:w.label,window:report.window,filename,totals});}
const summary={createdAt:new Date().toISOString(),input,status:'OBSERVED_NOT_FINAL',apiCalls:client.calls,records,limitations:['Window snapshots may be sampled or delayed; empty means UNKNOWN, not zero.','Namespace and database activity can contain background traffic.','Per-object time groups are retained in raw reports; duration is DO periodic GB-s, never invocation wallTime.','all/scenario/quiet windows overlap: never sum them together.']};await writeFile(`${directory}/latest.json`,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
