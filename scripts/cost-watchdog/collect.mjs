/** Source-specific official datasets, not a universal realtime billing query. */
export const metricSources = Object.freeze({
  "workers-requests": { service: "workers", node: "workersInvocationsAdaptive", aggregate: "sum", field: "requests", unit: "requests", docs: "https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/", granularity: "adaptive", sampled: true },
  "durable-requests": { service: "durable-objects", node: "durableObjectsInvocationsAdaptiveGroups", aggregate: "sum", field: "requests", unit: "requests", docs: "https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/", granularity: "date", sampled: true },
  "d1-rows-read": { service: "d1", node: "d1AnalyticsAdaptiveGroups", aggregate: "sum", field: "rowsRead", unit: "rows", docs: "https://developers.cloudflare.com/d1/observability/metrics-analytics/", granularity: "date", sampled: true },
  "d1-rows-written": { service: "d1", node: "d1AnalyticsAdaptiveGroups", aggregate: "sum", field: "rowsWritten", unit: "rows", docs: "https://developers.cloudflare.com/d1/observability/metrics-analytics/", granularity: "date", sampled: true },
  "r2-operations": { service: "r2", node: "r2OperationsAdaptiveGroups", aggregate: "sum", field: "requests", unit: "requests", docs: "https://developers.cloudflare.com/r2/platform/metrics-analytics/", granularity: "adaptive", sampled: true },
  "r2-stored-bytes": { service: "r2", node: "r2StorageAdaptiveGroups", aggregate: "max", field: "payloadSize", extraField: "metadataSize", unit: "bytes", docs: "https://developers.cloudflare.com/r2/platform/metrics-analytics/", granularity: "snapshot", sampled: true },
  "r2-pending-uploads": { service: "r2", node: "r2StorageAdaptiveGroups", aggregate: "max", field: "uploadCount", unit: "count", docs: "https://developers.cloudflare.com/r2/platform/metrics-analytics/", granularity: "snapshot", sampled: true },
});
function literal(value) { return JSON.stringify(value); }
export function buildQuery(metric, accountId, start, end) {
  const source = metricSources[metric.kind];
  if (!source) throw new Error("METRIC_ADAPTER_UNAVAILABLE");
  if (!/^[0-9a-f]{32}$/.test(accountId) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end || end - start > 31 * 86_400_000) throw new Error("METRIC_WINDOW_INVALID");
  let filter;
  if (metric.kind === "workers-requests") {
    if (!/^[a-zA-Z0-9_-]{1,63}$/.test(metric.resource ?? "")) throw new Error("METRIC_RESOURCE_INVALID");
    filter = `scriptName:${literal(metric.resource)},datetime_geq:${literal(new Date(start).toISOString())},datetime_leq:${literal(new Date(end).toISOString())}`;
  } else if (metric.kind.startsWith("d1-")) {
    if (!/^[a-f0-9-]{36}$/.test(metric.resource ?? "")) throw new Error("METRIC_RESOURCE_INVALID");
    filter = `databaseId:${literal(metric.resource)},date_geq:${literal(new Date(start).toISOString().slice(0,10))},date_leq:${literal(new Date(end).toISOString().slice(0,10))}`;
  } else if (metric.kind.startsWith("r2-")) {
    if (!/^[a-z0-9_-]{3,128}$/.test(metric.resource ?? "")) throw new Error("METRIC_RESOURCE_INVALID");
    filter = `bucketName:${literal(metric.resource)},datetime_geq:${literal(new Date(start).toISOString())},datetime_leq:${literal(new Date(end).toISOString())}`;
  } else {
    // Official DO example exposes date_gt. This is conservatively account-wide, including unrelated DOs.
    filter = `date_gt:${literal(new Date(start - 86_400_000).toISOString().slice(0,10))}`;
  }
  return { query: `{viewer{accounts(filter:{accountTag:${literal(accountId)}}){${source.node}(limit:10000,filter:{${filter}}){${source.aggregate}{${source.field}${source.extraField ? ` ${source.extraField}` : ""}}}}}}`, source };
}
export async function boundedJson(response, maximumBytes) {
  if (!response.ok) throw new Error(`METRIC_HTTP_${response.status}`);
  if (!response.body) throw new Error("METRIC_BODY_MISSING");
  const reader = response.body.getReader(); const chunks = []; let length = 0;
  try { for (;;) { const {done,value}=await reader.read(); if(done) break; length+=value.byteLength; if(length>maximumBytes) throw new Error("METRIC_RESPONSE_TOO_LARGE"); chunks.push(value); } }
  finally { await reader.cancel().catch(()=>{}); }
  const bytes = new Uint8Array(length); let offset=0; for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function collectMetric(metric, config, window, { fetcher = fetch, token, now = Date.now() } = {}) {
  const base = { id: metric.id, service: metric.service, unit: metric.unit, windowId: window.id, windowStart: window.start, windowEnd: window.end, dataThrough: window.end, collectedAt: now, source: "UNAVAILABLE", granularity: "unknown", value: null, quality: "UNAVAILABLE" };
  try {
    if (!token) throw new Error("METRIC_READ_TOKEN_MISSING");
    const {query,source}=buildQuery(metric,config.accountId,window.start,window.end);
    base.source=`Cloudflare GraphQL:${source.node}`;base.granularity=source.granularity;base.documentation=source.docs;base.scope=metric.kind==='durable-requests'?'ACCOUNT_WIDE_CONSERVATIVE':metric.resource;
    const response=await fetcher("https://api.cloudflare.com/client/v4/graphql",{method:"POST",redirect:"error",signal:AbortSignal.timeout(config.requestTimeoutMs),headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Accept:"application/json","User-Agent":"PlayWithAnyone-CostWatchdog/0.1"},body:JSON.stringify({query})});
    const body=await boundedJson(response,config.maxResponseBytes);
    if(body.errors?.length) throw new Error("METRIC_GRAPHQL_ERROR");
    const accounts=body.data?.viewer?.accounts;if(!Array.isArray(accounts)||accounts.length!==1)throw new Error("METRIC_ACCOUNT_UNAVAILABLE");
    const rows=accounts[0][source.node];if(!Array.isArray(rows)||rows.length===0||rows.length>=10000)throw new Error("METRIC_EMPTY_OR_TRUNCATED");
    const values=rows.map(row=>{const value=row[source.aggregate]?.[source.field];const extra=source.extraField?row[source.aggregate]?.[source.extraField]:0;if(!Number.isFinite(value)||value<0||!Number.isFinite(extra)||extra<0)throw new Error("METRIC_VALUE_UNAVAILABLE");return value+extra;});
    base.value=source.aggregate==='max'?Math.max(...values):values.reduce((sum,value)=>sum+value,0);
    if(!Number.isFinite(base.value))throw new Error('METRIC_VALUE_UNAVAILABLE');
    base.sampled=source.sampled;
    // A successful query has no reliable realtime completeness watermark. Never invent one.
    if (!metric.coverageEvidence || !Number.isSafeInteger(metric.verifiedMaximumLagMs) || metric.verifiedMaximumLagMs < 0) { base.reason="COVERAGE_BOUND_UNVERIFIED"; return base; }
    base.dataThrough=Math.max(window.start,window.end-metric.verifiedMaximumLagMs);base.quality=now-base.dataThrough>config.maxMetricAgeMs?'STALE':'VALID';
    base.coverageEvidence=metric.coverageEvidence;
    return base;
  } catch(error) { return {...base,reason:error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'METRIC_UNAVAILABLE'}; }
}
export async function collectAll(config, window, options = {}) {
  if(config.metrics.length>config.maxApiCalls)throw new Error("WATCHDOG_API_CALL_LIMIT");
  const observations=[];const started=Date.now();
  for(const metric of config.metrics){const remaining=config.maxRunMs-(Date.now()-started);if(remaining<=0){observations.push({id:metric.id,service:metric.service,unit:metric.unit,quality:'UNAVAILABLE',value:null,reason:'WATCHDOG_RUNTIME_LIMIT',source:'UNAVAILABLE'});continue;}observations.push(await collectMetric(metric,{...config,requestTimeoutMs:Math.min(config.requestTimeoutMs,remaining)},window,options));}
  return observations;
}
