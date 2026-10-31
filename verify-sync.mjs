// Server-as-source-of-truth checks for verify.mjs: merge rules, the workspace API on the file store
// and on a throwaway Postgres (embedded-postgres, dev dependency), the import CLI, and a local app
// relaying to another server. Everything runs on loopback with temp folders; no real database.
import {spawn,execFile} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {merge3,shrinks,size} from './public/sync-core.js';

const ROOT=fileURLToPath(new URL('.',import.meta.url)),TOKEN='verify-sync-token-0123456789abcdefghijklmnop';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const OFF={OPID_BASE_URL:'',OPID_APP_ID:'',OPID_APP_SECRET:'',OPID_APP_ORIGIN:'',FLOW_SYNC_URL:'',FLOW_SYNC_TOKEN:'',DATABASE_URL:''};
async function serve(port,env){
  const p=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,...OFF,PORT:String(port),ORG_CHART_VERIFY:'1',...env}});
  let err='';p.stderr.on('data',d=>err+=d);
  await new Promise((res,rej)=>{p.stdout.once('data',res);p.once('exit',()=>rej(Error('server did not start: '+err.slice(0,300))))});
  return p;
}
const call=(base,method,qs,body,token=TOKEN)=>fetch(`${base}/api/workspace${qs}`,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body?{'content-type':'application/json'}:{})},body:body&&JSON.stringify(body)}).then(async r=>({status:r.status,data:await r.json().catch(()=>({}))}));
const cli=(args,env={})=>new Promise(res=>execFile(process.execPath,['tools/env.mjs',...args],{cwd:ROOT,env:{...process.env,FLOW_SYNC_TOKEN:TOKEN,...env}},(e,out,err)=>res({code:e?e.code||1:0,out:out+err})));
const ws=(n,extra={})=>({active:'c1',charts:[{id:'c1',name:'Chart',nodes:Array.from({length:n},(_,i)=>({id:'n'+i,name:'Node '+i,type:'entity',x:i*16,y:0})),edges:[]}],projects:[],timeline:[],...extra});

// The same API checks against any running server.
async function apiChecks(assert,base,label){
  let r=await call(base,'GET','?env=default-workspace');
  assert(r.status===200&&r.data.rev===0&&r.data.data===null,`sync/${label}: an empty environment reads as revision 0 with no data`);
  const file=join(mkdtempSync(join(tmpdir(),'ff-imp-')),'backup.json');writeFileSync(file,JSON.stringify(ws(60)));
  let c=await cli(['push','--env','default-workspace','--from',file,'--to',base]);
  assert(c.code===0&&/revision 1/.test(c.out),`sync/${label}: the import tool uploads a backup (revision 1)`);
  c=await cli(['push','--env','default-workspace','--from',file,'--to',base]);
  assert(c.code===0&&/Already imported/.test(c.out),`sync/${label}: importing the same file again changes nothing`);
  writeFileSync(file,JSON.stringify(ws(62)));
  c=await cli(['push','--env','default-workspace','--from',file,'--to',base]);
  assert(c.code!==0&&/Not overwriting/.test(c.out),`sync/${label}: the import refuses to overwrite a server that has data`);
  c=await cli(['push','--env','default-workspace','--from',file,'--to',base,'--merge']);
  r=await call(base,'GET','?env=default-workspace');
  assert(c.code===0&&r.data.rev===2&&r.data.data.charts[0].nodes.length===62,`sync/${label}: --merge combines the file with the server copy`);
  assert((await cli(['push','--env','default-workspace','--from',file,'--to',base],{FLOW_SYNC_TOKEN:'x'.repeat(40)})).code!==0,`sync/${label}: a wrong token is refused`);
  r=await call(base,'PUT','?env=default-workspace',{baseRev:1,data:ws(63)});
  assert(r.status===409&&r.data.rev===2&&r.data.data.charts[0].nodes.length===62,`sync/${label}: a save from an old revision gets 409 with the newer copy`);
  r=await call(base,'PUT','?env=default-workspace',{baseRev:2,data:ws(3)});
  assert(r.status===422&&(await call(base,'GET','?env=default-workspace')).data.rev===2,`sync/${label}: a save that would wipe most of the workspace is refused`);
  r=await call(base,'PUT','?env=default-workspace',{baseRev:2,data:ws(64)});
  assert(r.status===200&&r.data.rev===3,`sync/${label}: a save from the current revision is accepted`);
  r=await call(base,'GET','?env=default-workspace&since=3');
  assert(r.data.unchanged===true,`sync/${label}: polling with the current revision is cheap (unchanged)`);
  r=await call(base,'GET','');
  assert(r.data.env==='default-workspace'&&r.data.rev===3,`sync/${label}: the owner's default environment is Default workspace`);
  // Owner-token environments: list and archive (data kept).
  await call(base,'PUT','?env=junk-env',{baseRev:0,data:ws(2)});
  let ls=await cli(['environments','--to',base]);const ar=await cli(['archive','junk-env','--to',base]),ls2=await cli(['environments','--to',base]);
  assert(/junk-env/.test(ls.out)&&ar.code===0&&!/junk-env/.test(ls2.out)&&/default-workspace/.test(ls2.out)&&(await cli(['archive','default-workspace','--to',base])).code!==0,`sync/${label}: the owner token lists and archives environments (Default workspace cannot be archived)`);
  // Owner-token invites from the CLI (this server has no email configured).
  let iv=await cli(['invite','friend@example.test','--to',base]);
  const lst=await cli(['invites','--to',base]);
  const rv=await cli(['revoke','friend@example.test','--to',base]),lst2=await cli(['invites','--to',base]);
  const bad=await cli(['invites','--to',base],{FLOW_SYNC_TOKEN:'y'.repeat(40)});
  assert(iv.code===0&&/email not configured/.test(iv.out)&&/friend@example\.test\s+invited/.test(lst.out)&&rv.code===0&&/friend@example\.test\s+revoked/.test(lst2.out)&&bad.code!==0&&!iv.out.includes(TOKEN),`sync/${label}: the owner token can invite, list and revoke (wrong token refused, token never printed)`);
}

export async function syncChecks(assert){
  // Merge rules.
  const base={x:1,devops:{nextNumber:5,cards:[{id:'a',title:'A',column:'requests'},{id:'b',title:'B',column:'doing'},{id:'c',title:'C',column:'uat'}]}};
  const local={x:1,devops:{nextNumber:6,cards:[{id:'a',title:'A local',column:'requests'},{id:'c',title:'C',column:'uat'},{id:'d',title:'D',column:'requests'}]}};
  const remote={x:2,devops:{nextNumber:7,cards:[{id:'a',title:'A',column:'done'},{id:'b',title:'B',column:'doing'},{id:'e',title:'E',column:'nice'}]}};
  const m=merge3(base,local,remote),ids=m.devops.cards.map(c=>c.id).join();
  assert(m.x===2&&m.devops.nextNumber===7&&m.devops.cards.find(c=>c.id==='a').title==='A local'&&m.devops.cards.find(c=>c.id==='a').column==='done','sync: merges per field (local title, remote column, remote counter)');
  assert(ids.includes('d')&&ids.includes('e')&&!ids.includes('b')&&!ids.includes('c'),'sync: additions from both sides survive; deletions of untouched entities apply');
  const nb=merge3(undefined,{cards:[{id:'a',t:1}]},{cards:[{id:'b',t:2}]});
  assert(nb.cards.length===2,'sync: with no base (first sync) nothing is dropped');
  assert(shrinks(ws(100),ws(10))&&!shrinks(ws(100),ws(60))&&!shrinks(ws(10),ws(0)),'sync: only a large drop counts as a wipe');

  const tmp=mkdtempSync(join(tmpdir(),'ff-sync-'));const procs=[];
  try{
    // Guard: under verify a server never relays to a non-loopback URL (a real FLOW_SYNC_URL in .env).
    {const g=await serve(4383,{BACKUP_DIR:join(tmp,'guard'),SAVES_DIR:join(tmp,'guard-saves'),FLOW_SYNC_URL:'https://flow.example.invalid',FLOW_SYNC_TOKEN:TOKEN});
      const r=await call('http://127.0.0.1:4383','GET','?env=default-workspace',null,'');g.kill();
      assert(r.status===200&&!r.data.relayed&&!r.data.offline,'sync/guard: test servers never relay to a non-loopback FLOW_SYNC_URL');}
    // File store.
    procs.push(await serve(4388,{BACKUP_DIR:join(tmp,'files'),SAVES_DIR:join(tmp,'saves'),FLOW_SYNC_TOKEN:TOKEN}));
    await apiChecks(assert,'http://127.0.0.1:4388','files');
    // A local app relaying to that server (Owner's :4317 syncing to production).
    procs.push(await serve(4387,{BACKUP_DIR:join(tmp,'relay'),SAVES_DIR:join(tmp,'relay-saves'),FLOW_SYNC_URL:'http://127.0.0.1:4388',FLOW_SYNC_TOKEN:TOKEN}));
    let r=await call('http://127.0.0.1:4387','GET','?env=default-workspace',null,'');
    assert(r.status===200&&r.data.rev===3&&r.data.relayed,'sync/relay: a local app reads the remote server copy');
    r=await call('http://127.0.0.1:4387','PUT','?env=default-workspace',{baseRev:3,data:ws(65)},'');
    assert(r.status===200&&(await call('http://127.0.0.1:4388','GET','?env=default-workspace')).data.rev===4,'sync/relay: its saves land on the remote server');
    procs.shift().kill();await sleep(300);
    r=await call('http://127.0.0.1:4387','GET','?env=default-workspace',null,'');
    assert(r.status===200&&r.data.offline&&r.data.data?.charts[0].nodes.length===65,'sync/relay: offline, the local app falls back to its own copy');
    // Postgres (throwaway embedded instance).
    let pg=null;
    try{
      const {default:EmbeddedPostgres}=await import('embedded-postgres');
      pg=new EmbeddedPostgres({databaseDir:join(tmp,'pg'),user:'flow',password:'flow-verify',port:54331,persistent:false,onLog:()=>{},onError:()=>{}});
      await pg.initialise();await pg.start();await pg.createDatabase('flow');
      const DB={DATABASE_URL:'postgres://flow:flow-verify@127.0.0.1:54331/flow',FLOW_ALLOW_DB_IN_VERIFY:'1',FLOW_SYNC_TOKEN:TOKEN};
      for(let i=0;i<2;i++){const s=await serve(4386,{...DB,BACKUP_DIR:join(tmp,'pgfiles'),SAVES_DIR:join(tmp,'pgsaves')});await call('http://127.0.0.1:4386','GET','?env=default-workspace');s.kill();await sleep(300)}
      procs.push(await serve(4386,{...DB,BACKUP_DIR:join(tmp,'pgfiles'),SAVES_DIR:join(tmp,'pgsaves')}));
      assert(true,'sync/postgres: migrations run twice without error (idempotent)');
      await apiChecks(assert,'http://127.0.0.1:4386','postgres');
      const c=pg.getPgClient('flow');await c.connect();
      const h=(await c.query(`select count(*)::int n from flygon_flow_workspace_history where env_id='default-workspace'`)).rows[0].n,w=(await c.query(`select rev,owner_email from flygon_flow_workspaces where env_id='default-workspace'`)).rows[0];
      await c.end();
      assert(h===2&&w.rev==3&&w.owner_email==='owner@example.test','sync/postgres: each write keeps the previous revision in history; Owner owns his MindMap');
    }finally{for(const p of procs)p.kill();await sleep(300);try{await pg?.stop()}catch{}}
  }finally{for(const p of procs)p.kill();setTimeout(()=>{try{rmSync(tmp,{recursive:true,force:true})}catch{}},1500)}
}
