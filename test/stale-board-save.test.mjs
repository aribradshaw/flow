// Card #447: a whole-board save from an out-of-date copy must never put old values back on cards that
// someone else (an agent through the API or MCP, another tab) changed meanwhile. Nov 2026: saves like
// that reverted descriptions, columns and due dates on dozens of cards, twice in one evening.
// The board sends only the card edits it made (sync-core cardEditsOf) and the server writes only those;
// a tab running older code that would change cards is asked to reload. Pure checks, then the server
// endpoint the board uses, the browser's sync (public/sync.js, loaded from a temp copy with stubbed
// browser globals) against a real server, and cards.update / cards_update with ifUpdated.
// Temp folders and loopback only. Run: npm test
import {test,describe,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {applyCardEdits,rebaseCards,noteCardEdits,cardSnapshot,cardEditsOf} from '../public/sync-core.js';

const OWNER='owner@example.test';
const T0='2026-11-22T20:00:00.000Z';
const card=(id,number,f={})=>({id,number,title:`Card ${number}`,description:'',column:'requests',project:'',labels:[],points:null,actual:null,due:'',assignees:[],checklist:[],links:[],item:'',created:T0,updated:T0,moved:T0,...f});
const ws=(env,cards)=>({active:'c1',charts:[{id:'c1',name:'Map',nodes:[{id:'n1',name:'Kestrel Group',type:'entity',x:0,y:0}],edges:[]}],projects:[],timeline:[],
  devops:{cards,nextNumber:Math.max(1,...cards.map(c=>c.number+1))},agentflow:{agents:[],workflows:[]},environment:{id:env,name:'Board',ownerEmail:OWNER,visibility:'private',members:[]}});
const edits=(from,to)=>cardEditsOf(noteCardEdits(null,cardSnapshot(from),to),to);
const byId=(cards,id)=>cards.find(c=>c.id===id);

describe('card edits (sync-core)',()=>{
  test('the journal holds what the server had before each local change; changing a card back drops it',()=>{
    const d=ws('e',[card('a',1),card('b',2)]);let seen=cardSnapshot(d),j=null;
    d.devops.cards[0].title='Mine';j=noteCardEdits(j,seen,d);seen=cardSnapshot(d);
    assert.deepEqual(j,{a:card('a',1)});
    d.devops.cards[0].title='Mine again';j=noteCardEdits(j,seen,d);seen=cardSnapshot(d);
    assert.equal(j.a.title,'Card 1','the first base is kept');
    d.devops.cards.push(card('c',3));d.devops.cards.splice(1,1);j=noteCardEdits(j,seen,d);seen=cardSnapshot(d);
    assert.deepEqual(edits(ws('e',[card('a',1),card('b',2)]),d),cardEditsOf(j,d));
    assert.deepEqual(cardEditsOf(j,d),{changed:{a:{title:'Card 1'}},added:['c'],removed:{b:card('b',2)}});
    d.devops.cards[0].title='Card 1';j=noteCardEdits(j,seen,d);
    assert.ok(!('a' in j),'back to how the server had it');
    // Linked copies of shared cards are the owner's (sharedEdits), never in this journal.
    const s=ws('e',[card('sh.s1.x',4)]);const s0=cardSnapshot(s);s.devops.cards[0].title='Edited';
    assert.deepEqual(noteCardEdits(null,s0,s),{});
  });

  test('only the cards and fields a copy changed are written; the rest stay as the server has them',()=>{
    const base=[card('a',1,{description:'Old'}),card('b',2),card('c',3)];
    // Since then an agent changed a's description and c's due date; the copy is out of date on both.
    const server=[card('a',1,{description:'Agent notes'}),card('b',2),card('c',3,{due:'2026-12-01'})];
    const local=structuredClone(base);local[1].title='Mine';
    const r=applyCardEdits(server,local,edits(ws('e',base),ws('e',local)));
    assert.deepEqual(r.clashes,[]);
    assert.equal(byId(r.cards,'a').description,'Agent notes');
    assert.equal(byId(r.cards,'c').due,'2026-12-01');
    assert.equal(byId(r.cards,'b').title,'Mine');
    assert.equal(r.ignored,2,'two cards differed without being changed here');
    // The same out-of-date copy without any edit of its own changes nothing.
    assert.deepEqual(applyCardEdits(server,base,{changed:{},added:[],removed:{}}).cards,server);
  });

  test('an edit over a change the copy never saw is a clash; removals and moves follow the copy',()=>{
    const base=[card('a',1),card('b',2),card('c',3),card('d',4)];
    const server=[card('a',1,{title:'Theirs'}),card('b',2,{description:'Changed'}),card('c',3),card('n',5)];  // d removed elsewhere, n added
    const local=structuredClone(base);local[0].title='Mine';
    local.splice(1,1);                                       // removed b, which someone changed meanwhile
    local[1].column='doing';local[1].moved='2026-11-22T21:00:00.000Z';   // moved c
    local[2].points=3;                                       // edited d, removed meanwhile
    const r=applyCardEdits(server,local,edits(ws('e',base),ws('e',local)));
    assert.deepEqual(r.clashes.map(c=>[c.id,c.fields]).sort(),[['a',['title']],['b',['removed']],['d',['deleted']]]);
    assert.equal(byId(r.cards,'a').title,'Mine','the edit itself wins (the server answers 409 instead)');
    assert.equal(byId(r.cards,'b').description,'Changed','a card changed elsewhere is not removed');
    assert.equal(byId(r.cards,'c').column,'doing');
    assert.ok(byId(r.cards,'n'),'a card added elsewhere stays');
    assert.equal(byId(r.cards,'d').points,3,'an edited card removed elsewhere comes back with the edit');
    // A clean removal and a new card.
    const r2=applyCardEdits(base,[card('a',1),card('z',9),card('c',3),card('d',4)],{changed:{},added:['z'],removed:{b:card('b',2)}});
    assert.deepEqual(r2.cards.map(c=>c.id),['a','z','c','d'],'a new card goes after the card before it in the copy');
    // The card before it in the copy has since moved to another column: it goes by its column's cards.
    const srv=[card('b',2),card('c',3),card('B',1,{column:'done'})],cl=[card('B',1),card('x',4),card('c',3),card('b',2)];
    assert.deepEqual(applyCardEdits(srv,cl,{changed:{},added:['x'],removed:{}}).cards.map(c=>c.id),['b','x','c','B']);
    // Several moves in one save keep the copy's order.
    const abc=[card('A',1),card('B',2),card('C',3)],moved={moved:'2026-11-22T21:00:00.000Z'};
    assert.deepEqual(applyCardEdits(abc,[card('B',2,moved),card('C',3,moved),card('A',1)],{changed:{B:{moved:T0},C:{moved:T0}},added:[],removed:{}}).cards.map(c=>c.id),['B','C','A']);
    // A card only re-stamped here (text typed and changed back) and deleted elsewhere stays deleted.
    const r3=applyCardEdits([card('A',1)],[card('A',1),card('B',2,{updated:'2026-11-22T21:00:00.000Z'})],{changed:{B:{updated:T0}},added:[],removed:{}});
    assert.deepEqual([r3.cards.map(c=>c.id),r3.clashes],[['A'],[]]);
    // A removal over a card the server only re-stamped is not a clash.
    assert.deepEqual(applyCardEdits([card('A',1,{updated:'2026-11-22T22:00:00.000Z'})],[],{changed:{},added:[],removed:{A:card('A',1)}}),{cards:[],clashes:[],ignored:0});
  });

  test('checklist items changed on both sides merge item by item',()=>{
    const items=[{id:'x1',text:'One',done:false},{id:'x2',text:'Two',done:false}],base=[card('a',1,{checklist:items})];
    const server=[card('a',1,{checklist:[items[0],{...items[1],done:true}]})],local=[card('a',1,{checklist:[{...items[0],done:true},items[1]]})];
    const r=applyCardEdits(server,local,edits(ws('e',base),ws('e',local)));
    assert.deepEqual([r.clashes,r.cards[0].checklist.map(x=>x.done)],[[],[true,true]]);
  });

  test('edits of different fields of one card are not a clash, although both stamp updated',()=>{
    const base=[card('a',1)],server=[card('a',1,{due:'2026-12-01',updated:'2026-11-22T21:00:00.000Z'})];
    const local=[card('a',1,{title:'Mine',updated:'2026-11-22T21:05:00.000Z'})];
    const r=applyCardEdits(server,local,edits(ws('e',base),ws('e',local)));
    assert.deepEqual(r.clashes,[]);
    assert.deepEqual([r.cards[0].title,r.cards[0].due,r.cards[0].updated],['Mine','2026-12-01','2026-11-22T21:05:00.000Z'],'the later stamp is kept');
  });

  test('rebasing a browser\'s edits onto the server\'s cards: its journal then starts from the server',()=>{
    const base=[card('a',1),card('b',2)],server=[card('a',1,{description:'Agent'}),card('b',2,{title:'Theirs'})];
    const local=structuredClone(base);local[0].title='Mine';local[1].title='Also mine';
    const j=noteCardEdits(null,cardSnapshot(ws('e',base)),ws('e',local));
    const r=rebaseCards(server,local,j);
    assert.deepEqual(r.cards.map(c=>[c.title,c.description]),[['Mine','Agent'],['Also mine','']]);
    assert.deepEqual(r.clashes.map(c=>c.id),['b']);
    assert.deepEqual(r.journal,{a:server[0],b:server[1]});
    assert.deepEqual(applyCardEdits(server,r.cards,cardEditsOf(r.journal,ws('e',r.cards))).clashes,[],'the retry is accepted');
  });
});

// ---------- the board's save path on a real server ----------
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const MOCK=4416,APP=4417,BASE=`http://127.0.0.1:${APP}`,TOKEN='stale-board-e2e-token-0123456789abcdefghij';
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

describe('a stale board on a real server',()=>{
  let dir,mock,app;const jar=new Map();
  const cookie=()=>[...jar].map(([k,v])=>`${k}=${v}`).join('; ');
  const browser=async(method,path,body)=>{
    const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json',cookie:cookie()},body:body===undefined?undefined:JSON.stringify(body)});
    for(const c of r.headers.getSetCookie()){const [pair]=c.split(';'),i=pair.indexOf('=');jar.set(pair.slice(0,i).trim(),pair.slice(i+1))}
    return {status:r.status,data:await r.json().catch(()=>null)};
  };
  const agent=(method,path,body)=>fetch(BASE+path,{method,headers:{authorization:'Bearer '+TOKEN,...(body?{'content-type':'application/json'}:{})},body:body&&JSON.stringify(body)}).then(async r=>({status:r.status,data:await r.json()}));
  let mcpId=0;
  const mcp=async(name,args)=>{
    const r=await fetch(BASE+'/mcp',{method:'POST',headers:{authorization:'Bearer '+TOKEN,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++mcpId,method:'tools/call',params:{name,arguments:args}})});
    return (await r.json()).result;
  };
  const E='default-workspace';
  const fresh=()=>{const d=ws(E,[card('k1',1,{description:'First draft'}),card('k2',2),card('k3',3)]);d.environment.name='Default workspace';return d};
  const current=async()=>(await browser('GET','/api/workspace?env='+E)).data;
  const reset=async()=>{const w=await current();assert.equal((await browser('PUT','/api/workspace?env='+E,{baseRev:w.rev,data:fresh()})).status,200);return current()};
  before(async()=>{
    dir=mkdtempSync(join(tmpdir(),'flow-stale-board-'));
    mock=mockOpid();await new Promise(r=>mock.listen(MOCK,'127.0.0.1',r));
    app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',FLOW_SYNC_TOKEN:TOKEN,PORT:String(APP),ORG_CHART_VERIFY:'1',
      BACKUP_DIR:join(dir,'backups'),SAVES_DIR:join(dir,'saves'),INBOX_DIR:join(dir,'inbox'),OPID_BASE_URL:`http://127.0.0.1:${MOCK}`,OPID_APP_ID:'flygon-flow-stale-fixture',OPID_APP_SECRET:'synthetic-stale-secret-0123456789abcdef',OPID_APP_ORIGIN:BASE}});
    let err='';app.stderr.on('data',d=>err+=d);
    await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('server did not start: '+err)))});
    assert.equal((await browser('POST','/api/auth/sign-in',{email:OWNER,password:'pw'})).status,200);
    assert.equal((await browser('PUT','/api/workspace?env='+E,{baseRev:0,data:fresh()})).status,200);
  });
  after(()=>{app?.kill();mock?.close();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},300)});

  test('two clients: an agent edits a card through the API, then a stale board saves; the agent\'s edit stays',async()=>{
    const read=await reset();                                    // the board reads the workspace
    const upd=await agent('PATCH',`/api/v1/envs/${E}/cards/1`,{description:'Agent: done, see PR'});
    assert.equal(upd.status,200);
    const mv=await agent('POST',`/api/v1/envs/${E}/cards/3/move`,{column:'doing',confirm:true});
    assert.equal(mv.status,200);
    // The board edits card 2 on its out-of-date copy. It merged without the right base (the way an old
    // copy got through in Nov 2026), so it saves at the current revision with cards 1 and 3 as it read them.
    const now=await current(),stale=structuredClone(read.data);
    byId(stale.devops.cards,'k2').title='Edited on the board';
    // A tab running older code sends its whole copy (intent, no cardEdits): refused, nothing written.
    const old=await browser('PUT','/api/workspace?env='+E,{baseRev:now.rev,data:stale,intent:{deleted:[],undo:false}});
    assert.equal(old.status,428,'an old tab must reload: '+JSON.stringify(old.data));
    assert.equal(old.data.code,'reload_required');
    assert.equal(byId((await current()).data.devops.cards,'k1').description,'Agent: done, see PR','the agent\'s description is still there');
    // The board's save path: only its own edit is written.
    const r=await browser('PUT','/api/workspace?env='+E,{baseRev:now.rev,data:stale,intent:{deleted:[],undo:false},cardEdits:edits(read.data,stale)});
    assert.equal(r.status,200,JSON.stringify(r.data));
    assert.equal(r.data.cardsKept,true,'the board is told to read the cards it was out of date on');
    const after=(await current()).data.devops.cards;
    assert.equal(byId(after,'k1').description,'Agent: done, see PR');
    assert.equal(byId(after,'k3').column,'doing');
    assert.equal(byId(after,'k2').title,'Edited on the board');
  });

  test('an edit over a change the board never saw is 409 card_conflict with the newer copy',async()=>{
    const read=await reset();
    assert.equal((await agent('PATCH',`/api/v1/envs/${E}/cards/1`,{description:'Agent wrote this'})).status,200);
    const now=await current(),mine=structuredClone(read.data);
    byId(mine.devops.cards,'k1').description='First draft, edited on the board';
    const r=await browser('PUT','/api/workspace?env='+E,{baseRev:now.rev,data:mine,intent:{deleted:[],undo:false},cardEdits:edits(read.data,mine)});
    assert.equal(r.status,409);assert.equal(r.data.code,'card_conflict');
    assert.deepEqual(r.data.clashes.map(c=>[c.number,c.fields]),[[1,['description']]]);
    assert.equal(byId(r.data.data.devops.cards,'k1').description,'Agent wrote this','the board gets the newer copy to merge');
    assert.equal(byId((await current()).data.devops.cards,'k1').description,'Agent wrote this','nothing was written');
  });

  test('the browser\'s sync: a reload whose stored copy is older than the server never sends the old cards',async()=>{
    const read=await reset();
    // The user edited card 2 in this browser; the save had not gone out. The stored base was lost (too big
    // for the browser's storage), so the browser's copy cannot tell its own edits from old values.
    const local=structuredClone(read.data);byId(local.devops.cards,'k2').title='Typed before the reload';
    const journal=noteCardEdits(null,cardSnapshot(read.data),local);
    // Meanwhile an agent rewrote card 1 and moved card 3.
    assert.equal((await agent('PATCH',`/api/v1/envs/${E}/cards/1`,{description:'Agent rewrote this'})).status,200);
    assert.equal((await agent('POST',`/api/v1/envs/${E}/cards/3/move`,{column:'doing',confirm:true})).status,200);
    const b=await loadBrowser({stored:{'org-chart-studio-v1':local},sync:{env:E,rev:read.rev,dirty:true,shared:'',cards:journal}});
    await b.settle();
    assert.ok(b.puts.length>=1,'the edit is saved');
    const after=(await current()).data.devops.cards;
    assert.equal(byId(after,'k1').description,'Agent rewrote this','the agent\'s description is not reverted');
    assert.equal(byId(after,'k3').column,'doing','nor its move');
    assert.equal(byId(after,'k2').title,'Typed before the reload','the user\'s edit is saved');
    const shown=b.store.store.db.devops.cards;
    assert.equal(byId(shown,'k1').description,'Agent rewrote this','the browser shows the newer card');
    // A later edit in the same browser, after another agent change, still leaves the agent's change.
    assert.equal((await agent('PATCH',`/api/v1/envs/${E}/cards/3`,{title:'Agent title'})).status,200);
    b.store.change(()=>{byId(b.store.store.db.devops.cards,'k2').points=5});
    await b.settle();
    const last=(await current()).data.devops.cards;
    assert.deepEqual([byId(last,'k3').title,byId(last,'k2').points,byId(last,'k1').description],['Agent title',5,'Agent rewrote this']);
    // A clash: the user and an agent change the same description at once. The user's edit is kept (and
    // they are told); undoing it brings back the agent's text, not the one both started from.
    const clashes=[];b.store.store.onCardClash=l=>clashes.push(...l);
    b.store.change(()=>{byId(b.store.store.db.devops.cards,'k1').description='Mine'});
    assert.equal((await agent('PATCH',`/api/v1/envs/${E}/cards/1`,{description:'Agent again'})).status,200);
    await b.settle();
    assert.deepEqual(clashes.map(c=>[c.number,c.fields]),[[1,['description']]]);
    assert.equal(byId((await current()).data.devops.cards,'k1').description,'Mine');
    b.store.step(-1);
    await b.settle();
    assert.equal(byId((await current()).data.devops.cards,'k1').description,'Agent again','undo restores the agent\'s text');
  });

  test('cards.update and cards_update (MCP) with ifUpdated refuse to overwrite a change made since the read',async()=>{
    await reset();
    const read=(await agent('GET',`/api/v1/envs/${E}/cards/1`)).data.card;
    assert.equal((await browser('PATCH',`/api/v1/envs/${E}/cards/1`,{description:'The board changed it'})).status,200);
    const r=await agent('PATCH',`/api/v1/envs/${E}/cards/1`,{description:read.description+'\nAppended',ifUpdated:read.updated});
    assert.equal(r.status,409);assert.equal(r.data.code,'card_changed');
    assert.equal(r.data.details.card.description,'The board changed it');
    const m=await mcp('cards_update',{env:E,card:1,description:'Overwrite',ifUpdated:read.updated});
    assert.equal(m.isError,true,JSON.stringify(m));
    assert.match(JSON.stringify(m.content),/changed since you read it/);
    assert.equal((await agent('POST',`/api/v1/envs/${E}/cards/1/move`,{column:'doing',confirm:true,ifUpdated:read.updated})).data.code,'card_changed');
    assert.equal(byId((await current()).data.devops.cards,'k1').description,'The board changed it');
    // With the current updated it goes through.
    const fresh=(await agent('GET',`/api/v1/envs/${E}/cards/1`)).data.card;
    const ok=await mcp('cards_update',{env:E,card:1,description:fresh.description+'\nAppended',ifUpdated:fresh.updated});
    assert.ok(!ok.isError,JSON.stringify(ok));
    assert.equal(byId((await current()).data.devops.cards,'k1').description,'The board changed it\nAppended');
  });

  // public/sync.js in this process, its fetch going to the real server with the browser's session.
  async function loadBrowser({stored,sync}){
    const ls=new Map(Object.entries(stored).map(([k,v])=>[k,typeof v==='string'?v:JSON.stringify(v)]));
    ls.set('flygon-flow-sync-v1',JSON.stringify(sync));
    globalThis.localStorage={getItem:k=>ls.has(k)?ls.get(k):null,setItem:(k,v)=>ls.set(k,String(v)),removeItem:k=>ls.delete(k)};
    globalThis.window={addEventListener(){}};globalThis.document={visibilityState:'hidden',addEventListener(){}};globalThis.addEventListener=()=>{};
    const puts=[];
    globalThis.fetch=(f=>async(url,opts={})=>{
      const u=new URL(url,BASE);
      if(u.pathname.startsWith('/api/backups/'))return {ok:true,status:200,json:async()=>({})};
      if(u.pathname==='/api/workspace'&&opts.method==='PUT')puts.push(JSON.parse(opts.body));
      return f(BASE+u.pathname+u.search,{...opts,headers:{...(opts.headers||{}),cookie:cookie()}});
    })(realFetch);
    const tmp=mkdtempSync(join(tmpdir(),'flow-stale-sync-')),pub=new URL('../public/',import.meta.url);
    try{
      let s=readFileSync(new URL('store.js',pub),'utf8').replace("import {uid,clone} from './ui.js';","const uid=()=>crypto.randomUUID(),clone=x=>structuredClone(x);");
      for(const f of ['devops-core.js','demo-seed.js','workflow.js','agentflow-core.js','sync-core.js'])s=s.replace(`from './${f}'`,`from ${JSON.stringify(new URL(f,pub).href)}`);
      writeFileSync(join(tmp,'store.mjs'),s);
      writeFileSync(join(tmp,'sync.mjs'),readFileSync(new URL('sync.js',pub),'utf8').replace("from './sync-core.js'",`from ${JSON.stringify(new URL('sync-core.js',pub).href)}`).replace("from './combined-core.js'",`from ${JSON.stringify(new URL('combined-core.js',pub).href)}`).replace("from './prefs.js'",`from ${JSON.stringify(new URL('prefs.js',pub).href)}`).replace("from './store.js'","from './store.mjs'"));
      const store=await import(pathToFileURL(join(tmp,'store.mjs')).href),sync=await import(pathToFileURL(join(tmp,'sync.mjs')).href);
      const realInterval=globalThis.setInterval;globalThis.setInterval=()=>0;
      try{sync.startSync()}finally{globalThis.setInterval=realInterval}
      await sync.synced();
      return {store,sync,puts,settle:()=>new Promise(r=>setTimeout(r,1500))};
    }finally{rmSync(tmp,{recursive:true,force:true})}
  }
});
const realFetch=globalThis.fetch;
