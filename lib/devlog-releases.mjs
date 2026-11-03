// DevLog releases recorded per production deploy (@aribradshaw/devlog deploy-time releases).
// At server start a production deploy records one release for its commit in Postgres, listing every
// commit the deploy brought (read from GitHub). Nothing is written to git. public/devlog.json is
// frozen history: its newest entry is the baseline the first recorded release continues from.
import {readFileSync} from 'node:fs';
import {mergeReleases,devlogPage,schemeOf} from '../public/devlog-core.js';

export const TABLE='flygon_flow_devlog_releases';
// Bradshaw Versioning: YEAR.MONTH.UPDATE, zero-based year from 2026, America/Phoenix months.
export const SCHEME={originYear:2026,yearMode:'zero',timeZone:'America/Phoenix'};
export const DEFAULT_REPOSITORY={owner:'aribradshaw',repo:'flow'};
const FULL_SHA=/^[0-9a-f]{40}$/;
// Loaded on first use, so a missing package can only cost the deploy releases, never startup or the file history.
const devlog=()=>import('@aribradshaw/devlog/automation');

// The frozen registry ({scheme, releases}, newest first); empty when it cannot be read.
export function readHistory(file){
  try{const r=JSON.parse(readFileSync(file,'utf8'));return {scheme:r.scheme||null,releases:Array.isArray(r.releases)?r.releases:[]}}
  catch{return {scheme:null,releases:[]}}
}
export const baselineOf=history=>{const top=history?.releases?.[0];return top?.version?{version:top.version,commitSha:top.commit||null}:null};

// The deploy to record, or null. Only a production deploy with a full commit SHA and a database
// records; verify.mjs and test runs never do. Production comes from DEVLOG_PRODUCTION when set,
// otherwise RAILWAY_ENVIRONMENT_NAME=production (both read by resolveDevLogDeployContext).
export async function deployToRecord(env=process.env){
  if(!env.DATABASE_URL||env.ORG_CHART_VERIFY||env.NODE_TEST_CONTEXT)return null;
  const ctx=(await devlog()).resolveDevLogDeployContext(env);
  return ctx.production&&FULL_SHA.test(ctx.commitSha)?ctx:null;
}

export const releaseStore=async query=>(await devlog()).createPostgresReleaseStore({query,table:TABLE});

// Records this deploy's release (idempotent per commit). `fetch` and `releasedAt` are for tests.
export async function recordRelease({store,ctx,history,token=process.env.GITHUB_TOKEN,fetch=globalThis.fetch,releasedAt,onWarning}){
  const {githubCommitRange,recordDeployRelease}=await devlog();
  if(store.ensureSchema)await store.ensureSchema();
  const repo=ctx.repository||DEFAULT_REPOSITORY;
  // GitHub reads time out so a slow API cannot keep the recorder waiting; the head commit is used then.
  const timed=(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(15000)});
  return recordDeployRelease({store,commitSha:ctx.commitSha,headCommit:ctx.headCommit,deployment:ctx.deployment,scheme:SCHEME,
    baseline:baselineOf(history),releasedAt,
    commitSource:range=>githubCommitRange({...repo,...range,token:token||null,fetch:timed}),
    onWarning:onWarning||((m,e)=>console.warn(`DevLog: ${m}${e?` (${e.message||e})`:''}`))});
}
export const describeResult=({status,release})=>{
  const n=release.includedCommits?.length||0;
  return `DevLog: ${status==='recorded'?'recorded':'already recorded'} ${release.version} for ${release.commit.slice(0,7)} (${n} commit${n===1?'':'s'})`;
};

// The GET /api/devlog payload: deploy releases (newest first), then the file history.
export function devlogResponse({deployed=[],history,page,q}){
  return devlogPage(mergeReleases(deployed,history?.releases||[]),{page,q,repository:history?.scheme?.repository||'',scheme:schemeOf(history?.scheme)});
}
