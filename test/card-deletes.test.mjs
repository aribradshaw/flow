// Deleted cards: every write that removes a card records it (lib/workspaces.mjs), whatever made the
// write, and cards.restore brings it back. Unit checks, the file store, Postgres (embedded, loopback),
// and the browser's save path on a real server (OneProfileID mode against a loopback mock). Temp folders
// only; nothing here reaches production. Run: node --test 'test/**/*.test.mjs'
import {test,describe,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {workspaceStore,droppedCards,deleteEntries,RETAIN_DAYS,SCHEMA} from '../lib/workspaces.mjs';
import {invoke} from '../lib/registry.mjs';

const OWNER='owner@example.test',ENV='del-env';
const card=(id,number,extra={})=>({id,number,title:`Card ${number}`,description:'',column:'requests',project:'',labels:[],points:null,due:'',assignees:[],checklist:[],links:[],item:'',...extra});
const ws=(cards,agents=[])=>({active:'c1',charts:[{id:'c1',name:'Map',nodes:[{id:'n1',name:'Kestrel Group',type:'entity',x:0,y:0}],edges:[]}],projects:[],timeline:[],
  devops:{cards,nextNumber:Math.max(1,...cards.map(c=>c.number+1))},agentflow:{agents,workflows:[]},environment:{id:ENV,name:'Deletes',ownerEmail:OWNER,visibility:'private',members:[]}});

test('droppedCards and deleteEntries: what left, how, and the agents it was delegated to',()=>{
  const before=ws([card('a',1),card('b',2),card('sh.s1.c',3)],[{id:'ag',name:'Bot',cards:['b']}]),after=ws([card('a',1)]);
  assert.deepEqual(droppedCards(before,after).map(c=>c.id),['b'],'linked copies (sh.*) belong to their owner and are not recorded');
  assert.deepEqual(droppedCards(null,after),[]);assert.deepEqual(droppedCards(before,before),[]);
  const [e]=deleteEntries(ENV,before,after,{by:OWNER,source:{via:'undo',actor:'k'},fromRev:4,rev:5});
  assert.match(e.id,/^del_/);
  assert.deepEqual({...e,id:0,deletedAt:0},{id:0,env:ENV,cardId:'b',number:2,title:'Card 2',card:before.devops.cards[1],agents:['ag'],deletedAt:0,deletedBy:OWNER,via:'undo',actor:'k',fromRev:4,rev:5,restoredAt:null,restoredBy:'',restoredNumber:null});
  assert.equal(deleteEntries(ENV,before,after,{source:{via:'snapshot',board:['b']}})[0].via,'board','a card deleted on the board on purpose');
  assert.equal(deleteEntries(ENV,before,after)[0].via,'save','no source');
});

// The same checks on either store.
async function storeChecks(store,{age}){
  assert.ok((await store.put(ENV,{baseRev:0,data:ws([card('a',1),card('b',2)]),by:OWNER,owner:OWNER,name:'Deletes'})).ok);
  const r=await store.put(ENV,{baseRev:1,data:ws([card('a',1)]),by:OWNER,owner:OWNER,source:{via:'snapshot'}});
  assert.ok(r.ok);assert.equal(r.deleted.length,1);
  // It outlives the revision history (100 revisions are kept).
  for(let i=0;i<105;i++){const w=await store.get(ENV);assert.ok((await store.put(ENV,{baseRev:w.rev,data:ws([card('a',1,{description:'v'+i})]),by:OWNER,owner:OWNER})).ok)}
  assert.ok((await store.history(ENV)).every(h=>h.rev>2),'revision 1 has rolled off the history');
  let list=await store.deletedCards(ENV);
  assert.equal(list.length,1);
  const e=list[0];
  assert.equal(e.cardId,'b');assert.equal(e.number,2);assert.equal(e.via,'snapshot');assert.equal(e.fromRev,1);assert.equal(e.rev,2);assert.equal(e.env,ENV);
  assert.deepEqual(e.card,card('b',2));assert.equal(e.deletedBy,OWNER);
  assert.deepEqual(await store.deletedCard(ENV,e.id),e);
  assert.equal(await store.deletedCard('other-env',e.id),null,'entries are per environment');
  await store.markRestored(ENV,e.id,{by:OWNER,number:7});
  const m=await store.deletedCard(ENV,e.id);
  assert.ok(m.restoredAt);assert.equal(m.restoredBy,OWNER);assert.equal(m.restoredNumber,7);
  assert.deepEqual(await store.deletedCards(ENV,{pending:true}),[]);
  // Older than the retention window: hidden, and pruned by the next delete.
  await age(e.id,RETAIN_DAYS+1);
  assert.deepEqual(await store.deletedCards(ENV),[]);
  await age(e.id,RETAIN_DAYS-1);
  assert.equal((await store.deletedCards(ENV)).length,1,`kept for ${RETAIN_DAYS} days (at least 90)`);
  assert.ok(RETAIN_DAYS>=90);
}

describe('file store',()=>{
  let dir;
  before(()=>{dir=mkdtempSync(join(tmpdir(),'flow-del-'))});
  after(()=>rmSync(dir,{recursive:true,force:true}));
  test('records, lists, marks restored, survives the history limit, keeps 180 days',async()=>{
    const store=workspaceStore({dir,db:async()=>null}),f=join(dir,'workspaces','deleted',ENV+'.json');
    await storeChecks(store,{age:async(id,days)=>{const l=JSON.parse(readFileSync(f,'utf8'));for(const e of l)if(e.id===id)e.deletedAt=new Date(Date.now()-days*864e5).toISOString();writeFileSync(f,JSON.stringify(l))}});
  });
});

describe('Postgres store',()=>{
  let dir,pg,pool;
  before(async()=>{
    dir=mkdtempSync(join(tmpdir(),'flow-del-pg-'));
    const {default:EmbeddedPostgres}=await import('embedded-postgres');
    pg=new EmbeddedPostgres({databaseDir:join(dir,'pg'),user:'flow',password:'flow-test',port:54351,persistent:false,onLog:()=>{},onError:()=>{}});
    await pg.initialise();await pg.start();await pg.createDatabase('flow');
    const {default:PG}=await import('pg');
    pool=new PG.Pool({connectionString:'postgres://flow:flow-test@127.0.0.1:54351/flow',max:2});
    for(const q of [...SCHEMA,...SCHEMA])await pool.query(q);
  });
  after(async()=>{await pool?.end().catch(()=>{});await pg?.stop().catch(()=>{});rmSync(dir,{recursive:true,force:true})});
  test('the same checks, in the same transaction as the save',async()=>{
    assert.ok(SCHEMA.every(q=>/if not exists/.test(q)),'every statement is idempotent');
    const store=workspaceStore({dir,db:async()=>pool});
    await storeChecks(store,{age:(id,days)=>pool.query(`update flygon_flow_card_deletes set deleted_at=now()-interval '${days} days' where id=$1`,[id])});
    // A refused (stale) save records nothing.
    const w=await store.get(ENV);
    assert.equal((await store.put(ENV,{baseRev:w.rev-1,data:ws([]),by:OWNER})).conflict,true);
    assert.equal((await store.deletedCards(ENV)).length,1);
    // Restore through the registry on Postgres, then the next delete prunes entries past retention.
    await pool.query(`update flygon_flow_card_deletes set deleted_at=now() where env_id=$1`,[ENV]);
    await pool.query(`update flygon_flow_card_deletes set restored_at=null where env_id=$1`,[ENV]);
    const ctx={user:{id:'u',email:OWNER},store,envCheck:async()=>true};
    const r=await invoke('cards.restore',{env:ENV,entry:'#2'},ctx);
    assert.equal(r.card.number,2);assert.equal(r.renumbered,false);
    await pool.query(`update flygon_flow_card_deletes set deleted_at=now()-interval '${RETAIN_DAYS+5} days' where env_id=$1`,[ENV]);
    const w2=await store.get(ENV);
    await store.put(ENV,{baseRev:w2.rev,data:ws([]),by:OWNER});
    const rows=(await pool.query('select card_id from flygon_flow_card_deletes where env_id=$1 order by card_id',[ENV])).rows.map(x=>x.card_id);
    assert.deepEqual(rows,['a','b'],'the old entry is pruned; the two just removed are kept');
  });
});

// ---------- the browser's save path on a real server ----------
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const MOCK=4386,APP=4387,BASE=`http://127.0.0.1:${APP}`,TOKEN='deletes-e2e-token-0123456789abcdefghijklmno';
function mockOpid(){
  const sessions=new Map(),u={id:'u-owner',name:'Example Owner',localId:'owner'};
  const identity=()=>({user:{id:u.id,email:OWNER,name:u.name},session:{id:randomUUID()},memberships:[{localId:u.localId}]});
  return http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    const send=(code,obj,set=[])=>{res.writeHead(code,{'content-type':'application/json',...(set.length?{'set-cookie':set}:{})});res.end(JSON.stringify(obj))};
    const path=req.url.replace('/internal/v1/auth',''),b=body?JSON.parse(body):{},cookie=(String(req.headers.cookie||'').match(/(?:^|; )oneprofileid\.session_token=([^;]+)/)||[])[1];
    if(path==='/sign-in/email'){if(b.email!==OWNER||b.password!=='pw')return send(401,{error:'Invalid'});const t=randomUUID();sessions.set(t,u);return send(200,identity(),[`oneprofileid.session_token=${t}; Path=/; HttpOnly`])}
    if(path==='/get-session')return sessions.has(cookie)?send(200,identity()):send(401,{error:'No session'});
    if(path==='/sign-out')return send(200,{success:true});
    send(404,{error:'Not found'});
  })});
}
describe('browser saves on a real server',()=>{
  let dir,mock,app;const jar=new Map();
  const browser=async(method,path,body,headers={})=>{
    const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json',cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    for(const c of r.headers.getSetCookie()){const [pair]=c.split(';'),i=pair.indexOf('=');jar.set(pair.slice(0,i).trim(),pair.slice(i+1))}
    return {status:r.status,data:await r.json().catch(()=>null)};
  };
  const agentApi=(method,path,body)=>fetch(BASE+path,{method,headers:{authorization:'Bearer '+TOKEN,...(body?{'content-type':'application/json'}:{})},body:body&&JSON.stringify(body)}).then(async r=>({status:r.status,data:await r.json()}));
  const E='default-workspace',ws0=()=>({...ws([card('k-one',1,{title:'Mine'})]),environment:{id:E,name:'Default workspace',ownerEmail:OWNER,visibility:'private',members:[]}});
  const current=async()=>(await browser('GET','/api/workspace?env='+E)).data;
  before(async()=>{
    dir=mkdtempSync(join(tmpdir(),'flow-del-e2e-'));
    mock=mockOpid();await new Promise(r=>mock.listen(MOCK,'127.0.0.1',r));
    app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',FLOW_SYNC_TOKEN:TOKEN,PORT:String(APP),ORG_CHART_VERIFY:'1',
      BACKUP_DIR:join(dir,'backups'),SAVES_DIR:join(dir,'saves'),INBOX_DIR:join(dir,'inbox'),OPID_BASE_URL:`http://127.0.0.1:${MOCK}`,OPID_APP_ID:'flygon-flow-deletes-fixture',OPID_APP_SECRET:'synthetic-deletes-secret-0123456789abcdef',OPID_APP_ORIGIN:BASE}});
    let err='';app.stderr.on('data',d=>err+=d);
    await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('server did not start: '+err)))});
    assert.equal((await browser('POST','/api/auth/sign-in',{email:OWNER,password:'pw'})).status,200);
    assert.equal((await browser('PUT','/api/workspace?env='+E,{baseRev:0,data:ws0()})).status,200);
  });
  after(()=>{app?.kill();mock?.close();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},300)});

  test('an agent creates a card, a stale undo drops it, the save says so, and Recently deleted restores it',async()=>{
    const snap=(await current()).data;   // the browser's undo step, from before the agent's card
    const made=await agentApi('POST',`/api/v1/envs/${E}/cards`,{title:'From an agent',description:'Agent payload'});
    assert.equal(made.status,201);const num=made.data.card.number;
    // The browser pulled the card (so its revision is current), then undo sends the old snapshot.
    const rev=(await current()).rev;
    const stale=await browser('PUT','/api/workspace?env='+E,{baseRev:rev-1,data:snap,intent:{deleted:[],undo:true}});
    assert.equal(stale.status,409,'from an older revision: refused and merged in the browser, nothing dropped');
    const r=await browser('PUT','/api/workspace?env='+E,{baseRev:rev,data:snap,intent:{deleted:[],undo:true}});
    assert.equal(r.status,200);
    assert.deepEqual(r.data.removedCards.map(c=>[c.number,c.title]),[[num,'From an agent']],'the browser is told, to point at Recently deleted');
    // The browser's own session reads the list and restores (the DevOps Recently deleted view).
    const list=await browser('GET',`/api/v1/envs/${E}/deleted-cards?pending=true`);
    assert.equal(list.status,200);
    const e=list.data.items.find(x=>x.number===num);
    assert.equal(e.via,'undo');assert.equal(e.deletedBy,OWNER);assert.equal(e.fromRev,rev);assert.equal(e.card.description,'Agent payload');
    const back=await browser('POST',`/api/v1/envs/${E}/deleted-cards/${e.id}/restore`,{});
    assert.equal(back.status,200,JSON.stringify(back.data));
    assert.equal(back.data.card.number,num);assert.equal(back.data.card.id,made.data.card.id);
    assert.ok((await current()).data.devops.cards.some(c=>c.id===made.data.card.id),'back on the board');
    // The agent sees it too.
    assert.equal((await agentApi('GET',`/api/v1/envs/${E}/cards/${num}`)).data.card.title,'From an agent');
  });

  test('Delete on the board, a snapshot restore and an older tab are each recorded as such',async()=>{
    let w=await current();
    const d=structuredClone(w.data),gone=d.devops.cards.find(c=>c.title==='Mine');
    d.devops.cards=d.devops.cards.filter(c=>c.id!==gone.id);
    const r=await browser('PUT','/api/workspace?env='+E,{baseRev:w.rev,data:d,intent:{deleted:[gone.id],undo:false}});
    assert.equal(r.status,200);assert.equal(r.data.removedCards,undefined,'a deliberate Delete needs no notice');
    w=await current();
    const d2=structuredClone(w.data),agentCard=d2.devops.cards[0];d2.devops.cards=[];
    assert.equal((await browser('PUT','/api/workspace?env='+E,{baseRev:w.rev,data:d2,intent:{deleted:[],undo:false}})).status,200);
    // Restored, then dropped by a tab running older code (no intent).
    const again=await browser('POST',`/api/v1/envs/${E}/deleted-cards/${encodeURIComponent(agentCard.id)}/restore`,{});
    assert.equal(again.status,200,JSON.stringify(again.data));
    w=await current();const d3=structuredClone(w.data);d3.devops.cards=[];
    assert.equal((await browser('PUT','/api/workspace?env='+E,{baseRev:w.rev,data:d3})).status,200);
    const items=(await browser('GET',`/api/v1/envs/${E}/deleted-cards`)).data.items;
    assert.deepEqual(items.slice(0,3).map(e=>[e.title,e.via]),[['From an agent','save'],['From an agent','snapshot'],['Mine','board']]);
  });
});
