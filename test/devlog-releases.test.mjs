// DevLog releases per production deploy (lib/devlog-releases.mjs, public/devlog-core.js): when a
// deploy records, the baseline from public/devlog.json, idempotency on restart, the /api/devlog
// merge of deploy releases and file history, and the file-only fallback without a database.
// GitHub is a fake fetch; Postgres is a throwaway embedded instance on a loopback port.
import {test,describe,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMemoryReleaseStore} from '@aribradshaw/devlog/automation';
import {TABLE,deployToRecord,readHistory,baselineOf,recordRelease,releaseStore,devlogResponse,describeResult} from '../lib/devlog-releases.mjs';
import {mergeReleases,devlogPage,compareVersions} from '../public/devlog-core.js';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const history=readHistory(join(ROOT,'public/devlog.json'));
const BASE_SHA=history.releases[0].commit;
const sha=c=>c.repeat(40);
const A=sha('a'),B=sha('b'),C=sha('c'),D=sha('d');
const RAILWAY={DATABASE_URL:'postgres://example.test/db',RAILWAY_ENVIRONMENT_NAME:'production',RAILWAY_GIT_COMMIT_SHA:C,RAILWAY_DEPLOYMENT_ID:'dep-1',
  RAILWAY_GIT_REPO_OWNER:'example-owner',RAILWAY_GIT_REPO_NAME:'flow',RAILWAY_GIT_COMMIT_MESSAGE:'Third change',RAILWAY_GIT_AUTHOR:'example-dev'};
const quiet=()=>{};

// A fake GitHub: a linear history BASE_SHA -> A -> B -> C -> D, served by the compare and commits endpoints.
function github(){
  const chain=[[A,'Add the first feature'],[B,'DevLog: 0.11.24-0.11.25'],[C,'Third change'],[D,'Fourth change']];
  const payload=([s,subject],i)=>({sha:s,parents:[{sha:i?chain[i-1][0]:BASE_SHA}],author:{login:'example-dev'},commit:{message:subject,author:{name:'Example Dev',date:'2026-11-03T10:00:00Z'},committer:{date:'2026-11-03T10:00:00Z'}}});
  const calls=[];
  const fetch=async url=>{
    calls.push(url);
    const ok=body=>({ok:true,status:200,json:async()=>body});
    let m=/\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)/.exec(url);
    if(m){const all=[[BASE_SHA,''],...chain],from=all.findIndex(c=>c[0]===m[1]),to=all.findIndex(c=>c[0]===m[2]);
      return ok({status:'ahead',commits:chain.slice(from,to).map((c,i)=>payload(c,from+i))})}
    m=/\/commits\/([0-9a-f]+)/.exec(url);
    if(m){const i=chain.findIndex(c=>c[0]===m[1]);return i<0?{ok:false,status:404,json:async()=>({})}:ok(payload(chain[i],i))}
    return {ok:false,status:404,json:async()=>({})};
  };
  return {fetch,calls};
}
const NOV='2026-11-03T19:00:00Z';

test('only a production deploy with a database and a full SHA records; verify and test runs never do',async()=>{
  const ctx=await deployToRecord(RAILWAY);
  assert.equal(ctx.commitSha,C);assert.equal(ctx.provider,'railway');assert.deepEqual(ctx.repository,{owner:'example-owner',repo:'flow'});
  assert.equal(await deployToRecord({...RAILWAY,DATABASE_URL:''}),null,'no database');
  assert.equal(await deployToRecord({...RAILWAY,RAILWAY_ENVIRONMENT_NAME:'staging'}),null,'not production');
  assert.equal(await deployToRecord({...RAILWAY,RAILWAY_GIT_COMMIT_SHA:'abc1234'}),null,'short SHA');
  assert.equal(await deployToRecord({...RAILWAY,RAILWAY_GIT_COMMIT_SHA:''}),null,'no commit');
  assert.equal(await deployToRecord({...RAILWAY,ORG_CHART_VERIFY:'1'}),null,'verify.mjs');
  assert.equal(await deployToRecord({...RAILWAY,NODE_TEST_CONTEXT:'child-v8'}),null,'node --test');
  assert.equal(await deployToRecord({...RAILWAY,DEVLOG_PRODUCTION:'false'}),null,'explicit opt-out');
  assert.equal((await deployToRecord({DATABASE_URL:'postgres://example.test/db',DEVLOG_PRODUCTION:'true',DEVLOG_COMMIT_SHA:D})).commitSha,D,'explicit DEVLOG_* deploy');
  assert.equal(await deployToRecord({DATABASE_URL:'postgres://example.test/db'}),null,'local mode');
});

test('the first deploy continues from the newest file entry and lists every commit since it',async()=>{
  assert.deepEqual(baselineOf(history),{version:history.releases[0].version,commitSha:BASE_SHA});
  const store=createMemoryReleaseStore(),gh=github(),ctx=await deployToRecord(RAILWAY);
  const r=await recordRelease({store,ctx,history,fetch:gh.fetch,releasedAt:NOV,token:'',onWarning:quiet});
  assert.equal(r.status,'recorded');
  const [y,m,u]=history.releases[0].version.split('.').map(Number);
  assert.equal(r.release.version,y===0&&m===11?`0.11.${u+1}`:'0.11.1');
  assert.ok(gh.calls[0].includes(`/repos/example-owner/flow/compare/${BASE_SHA}...${C}`),gh.calls[0]);
  assert.deepEqual(r.release.includedCommits.map(c=>c.sha),[A,B,C],'oldest first, baseline excluded');
  assert.ok(!r.release.notes.some(n=>n.startsWith('DevLog:')),'old registry commits stay out of the notes');
  assert.deepEqual(r.release.deployment,{provider:'railway',id:'dep-1'});
  assert.match(describeResult(r),/^DevLog: recorded 0\.11\.\d+ for c{7} \(3 commits\)$/);
});

test('a restart on the same commit reuses the release; the next deploy continues from it',async()=>{
  const store=createMemoryReleaseStore(),gh=github(),ctx=await deployToRecord(RAILWAY);
  const first=await recordRelease({store,ctx,history,fetch:gh.fetch,releasedAt:NOV,onWarning:quiet});
  const again=await recordRelease({store,ctx,history,fetch:gh.fetch,releasedAt:'2026-11-03T20:00:00Z',onWarning:quiet});
  assert.equal(again.status,'existing');assert.equal(again.release.version,first.release.version);
  assert.equal((await store.list()).length,1);
  assert.match(describeResult(again),/already recorded/);
  const next=await recordRelease({store,ctx:await deployToRecord({...RAILWAY,RAILWAY_GIT_COMMIT_SHA:D}),history,fetch:gh.fetch,releasedAt:'2026-11-04T19:00:00Z',onWarning:quiet});
  assert.equal(compareVersions(next.release.version,first.release.version)<0,true,'newer version');
  assert.deepEqual(next.release.includedCommits.map(c=>c.sha),[D],'only what this deploy brought');
  // A new month starts UPDATE again at 1.
  const dec=await recordRelease({store,ctx:await deployToRecord({...RAILWAY,RAILWAY_GIT_COMMIT_SHA:sha('e')}),history,fetch:gh.fetch,releasedAt:'2026-12-01T19:00:00Z',onWarning:quiet});
  assert.equal(dec.release.version,'0.12.1');
});

test('/api/devlog lists deploy releases, then the file history, newest first, with no commit twice',async()=>{
  const store=createMemoryReleaseStore(),gh=github();
  await recordRelease({store,ctx:await deployToRecord(RAILWAY),history,fetch:gh.fetch,releasedAt:NOV,onWarning:quiet});
  await recordRelease({store,ctx:await deployToRecord({...RAILWAY,RAILWAY_GIT_COMMIT_SHA:D}),history,fetch:gh.fetch,releasedAt:'2026-11-04T19:00:00Z',onWarning:quiet});
  const deployed=await store.list();
  // A file entry for a commit a deploy already lists is not shown twice.
  const dup={...history.releases[0],version:'0.11.0',commit:A};
  const withDup={...history,releases:[...history.releases,dup]};
  const all=devlogResponse({deployed,history:withDup,page:1});
  assert.equal(all.current,deployed[0].version);
  assert.deepEqual(all.entries.slice(0,3).map(e=>e.version),[deployed[0].version,deployed[1].version,history.releases[0].version]);
  assert.equal(all.total,history.releases.length+2,'the duplicate commit is dropped');
  assert.deepEqual(all.entries[1].commits.map(c=>c.sha),[A,B,C]);
  assert.equal(all.entries[1].commits[2].subject,'Third change');
  assert.deepEqual(all.entries[2].commits,[],'file entries carry no commit list');
  assert.equal(all.entries.length,10);assert.equal(all.pages,Math.ceil(all.total/10));
  const merged=mergeReleases(deployed,withDup.releases);
  assert.deepEqual(merged.map(e=>e.version),[...merged.map(e=>e.version)].sort(compareVersions),'newest first');
  assert.equal(new Set(merged.map(e=>e.version)).size,merged.length);
  assert.equal(merged.filter(e=>e.commit===A||e.commits.some(c=>c.sha===A)).length,1);
  // Search reaches the commit subjects a deploy lists.
  const hit=devlogResponse({deployed,history,q:'fourth change'});
  assert.deepEqual(hit.entries.map(e=>e.version),[deployed[0].version]);
  // Without deploy releases it is the file alone.
  const fileOnly=devlogResponse({deployed:[],history,page:2});
  assert.equal(fileOnly.current,history.releases[0].version);assert.equal(fileOnly.page,2);
  assert.equal(fileOnly.entries[0].version,history.releases[10].version);
  assert.deepEqual(devlogPage([],{}).entries,[]);
});

describe('server without a database',()=>{
  let dir,app,base;
  before(async()=>{
    dir=mkdtempSync(join(tmpdir(),'ff-devlog-'));
    app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,...RAILWAY,DATABASE_URL:'',FLOW_SYNC_URL:'',FLOW_SYNC_TOKEN:'',PORT:'0',ORG_CHART_VERIFY:'1',
      OPID_BASE_URL:'',OPID_APP_ID:'',OPID_APP_SECRET:'',OPID_APP_ORIGIN:'',BACKUP_DIR:join(dir,'backups'),SAVES_DIR:join(dir,'saves'),INBOX_DIR:join(dir,'inbox')}});
    let err='';app.stderr.on('data',d=>err+=d);
    base=await new Promise((res,rej)=>{let out='';app.stdout.on('data',d=>{out+=d;const m=/(http:\/\/127\.0\.0\.1:\d+)/.exec(out);if(m)res(m[1])});app.once('exit',()=>rej(Error('server did not start: '+err)))});
  });
  after(()=>{app?.kill();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},300)});
  test('GET /api/devlog serves the file history, signed out, same origin only',async()=>{
    const r=await fetch(base+'/api/devlog');assert.equal(r.status,200);
    const d=await r.json();
    assert.equal(d.current,history.releases[0].version);assert.equal(d.entries.length,10);assert.equal(d.total,history.releases.length);
    assert.equal(d.scheme.timeZone,'America/Phoenix');assert.deepEqual(d.entries[0].commits,[]);
    assert.equal((await fetch(base+'/api/devlog',{headers:{origin:'https://evil.example'}})).status,403);
    assert.equal((await fetch(base+'/api/devlog',{method:'POST'})).status,403);
    assert.equal((await fetch(base+'/devlog.json')).status,200,'the static file still works');
  });
});

let EmbeddedPostgres=null;try{({default:EmbeddedPostgres}=await import('embedded-postgres'))}catch{}
describe('postgres',{skip:!EmbeddedPostgres&&'embedded-postgres is not installed'},()=>{
  let pg,pool,dir;
  const port=55900+Math.floor(Math.random()*400);
  before(async()=>{
    dir=mkdtempSync(join(tmpdir(),'ff-devlog-pg-'));
    pg=new EmbeddedPostgres({databaseDir:join(dir,'pg'),user:'flow',password:'flow-test',port,persistent:false,onLog:()=>{},onError:()=>{}});
    await pg.initialise();await pg.start();await pg.createDatabase('flow');
    const {default:pgLib}=await import('pg');
    pool=new pgLib.Pool({connectionString:`postgres://flow:flow-test@127.0.0.1:${port}/flow`,max:2});
  });
  after(async()=>{await pool?.end().catch(()=>{});await pg?.stop().catch(()=>{});rmSync(dir,{recursive:true,force:true})});
  test('records once per commit in the Flow table and lists newest first',async()=>{
    const store=await releaseStore((q,p)=>pool.query(q,p)),gh=github(),ctx=await deployToRecord(RAILWAY);
    const first=await recordRelease({store,ctx,history,fetch:gh.fetch,releasedAt:NOV,onWarning:quiet});
    const again=await recordRelease({store:await releaseStore((q,p)=>pool.query(q,p)),ctx,history,fetch:gh.fetch,releasedAt:NOV,onWarning:quiet});
    assert.equal(first.status,'recorded');assert.equal(again.status,'existing');
    const rows=(await pool.query(`select version,commit_sha,deployment_provider from ${TABLE}`)).rows;
    assert.deepEqual(rows,[{version:first.release.version,commit_sha:C,deployment_provider:'railway'}]);
    await recordRelease({store,ctx:await deployToRecord({...RAILWAY,RAILWAY_GIT_COMMIT_SHA:D}),history,fetch:gh.fetch,releasedAt:'2026-11-04T19:00:00Z',onWarning:quiet});
    const listed=await store.list({limit:1000});
    assert.equal(listed.length,2);assert.ok(compareVersions(listed[0].version,listed[1].version)<0);
    const d=devlogResponse({deployed:listed,history});
    assert.equal(d.current,listed[0].version);assert.deepEqual(d.entries[1].commits.map(c=>c.sha),[A,B,C]);
  });
});
