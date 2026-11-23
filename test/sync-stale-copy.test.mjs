// The browser's sync (public/sync.js) with a copy that is only out of date: a reload where the stored
// workspace is older than the base it was synced from (a browser that could not store its latest copy,
// another tab's write). Nov 2026: such a copy, merged as if it were local edits, put old columns, points
// and due dates back on 43 cards shared with the user. The copy must never pass for edits; the user's own
// edits of shared cards must still be sent (sharedEdits). Browser code loads from a temp copy with a
// stubbed localStorage, document and fetch.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const pub=new URL('../public/',import.meta.url);
const SHARE='s1',L=id=>`sh.${SHARE}.${id}`,ENV='env-joe';
const card=(id,f={})=>({id,number:1,title:'Card '+id,description:'',column:'requests',project:'',labels:[],points:null,actual:null,due:'',assignees:[],checklist:[],links:[],item:'',created:'2026-11-01T00:00:00.000Z',updated:'2026-11-01T00:00:00.000Z',moved:'2026-11-01T00:00:00.000Z',...f});
const db=cards=>({active:'c1',charts:[{id:'c1',name:'Mine',nodes:[],edges:[]}],projects:[],timeline:[],devops:{cards},environment:{id:ENV,name:'My workspace',ownerEmail:'joe@example.test',visibility:'private',members:[]}});

async function browser({stored,sync,server}){
  const ls=new Map(Object.entries(stored).map(([k,v])=>[k,typeof v==='string'?v:JSON.stringify(v)]));
  globalThis.localStorage={getItem:k=>ls.has(k)?ls.get(k):null,setItem:(k,v)=>ls.set(k,String(v)),removeItem:k=>ls.delete(k)};
  globalThis.window={addEventListener(){}};globalThis.document={visibilityState:'hidden',addEventListener(){}};globalThis.addEventListener=()=>{};
  const puts=[];
  globalThis.fetch=async(url,opts={})=>{
    const u=new URL(url,'http://x'),ok=d=>({ok:true,status:200,json:async()=>structuredClone(d)});
    if(u.pathname==='/api/auth/session')return ok({user:{email:'joe@example.test'}});
    if(u.pathname!=='/api/workspace')return ok({});
    if(opts.method==='PUT'){const b=JSON.parse(opts.body);puts.push(b);server.rev++;return ok({env:ENV,rev:server.rev,shared:server.shared})}
    return ok({env:ENV,rev:server.rev,data:server.data,shared:server.shared,conflicts:[]});
  };
  ls.set('flygon-flow-sync-v1',JSON.stringify(sync));
  const dir=mkdtempSync(join(tmpdir(),'flow-sync-stale-'));
  try{
    let s=readFileSync(new URL('store.js',pub),'utf8').replace("import {uid,clone} from './ui.js';","const uid=()=>crypto.randomUUID(),clone=x=>structuredClone(x);");
    for(const f of ['devops-core.js','demo-seed.js','workflow.js','agentflow-core.js','sync-core.js'])s=s.replace(`from './${f}'`,`from ${JSON.stringify(new URL(f,pub).href)}`);
    writeFileSync(join(dir,'store.mjs'),s);
    writeFileSync(join(dir,'sync.mjs'),readFileSync(new URL('sync.js',pub),'utf8').replace("from './sync-core.js'",`from ${JSON.stringify(new URL('sync-core.js',pub).href)}`).replace("from './store.js'","from './store.mjs'"));
    const store=await import(pathToFileURL(join(dir,'store.mjs')).href),sync=await import(pathToFileURL(join(dir,'sync.mjs')).href);
    const realInterval=globalThis.setInterval;globalThis.setInterval=()=>0;
    try{sync.startSync()}finally{globalThis.setInterval=realInterval}
    await sync.synced();
    return {store,sync,puts,ls,settle:()=>new Promise(r=>setTimeout(r,1200))};
  }finally{rmSync(dir,{recursive:true,force:true})}
}

test('a reload with a stored copy older than its base never sends the old values of shared cards',async()=>{
  // Synced at rev 5 when the owner had the card in done, 3 points, due Dec 1. The stored workspace is
  // older (requests, no points, no due date): the browser could not store the newer one.
  const older=db([card(L('k1')),card(L('k2'),{title:'Old title'})]);
  const synced=db([card(L('k1'),{column:'done',points:3,due:'2026-12-01'}),card(L('k2'),{title:'New title'})]);
  // Since then the owner also changed k2's title again (the share's signature moved; this env's rev did not).
  const now=structuredClone(synced);now.devops.cards[1].title='Newest title';
  const server={rev:5,shared:'s1:edit:3091',data:now};
  const b=await browser({stored:{'org-chart-studio-v1':older},sync:{env:ENV,rev:5,base:synced,dirty:false,shared:'s1:edit:3090'},server});
  await b.settle();
  for(const p of b.puts){
    const sent=id=>p.data.devops.cards.find(x=>x.id===L(id));
    assert.ok(sent('k1').column==='done'&&sent('k2').title!=='Old title','the old values are never sent: '+JSON.stringify({k1:sent('k1').column,k2:sent('k2').title,fieldBase:p.fieldBase}));
    assert.deepEqual(p.sharedEdits,{},'no shared edits from a copy that is only out of date');
  }
  const c=id=>b.store.store.db.devops.cards.find(x=>x.id===L(id));
  assert.deepEqual([c('k1').column,c('k1').points,c('k1').due,c('k2').title],['done',3,'2026-12-01','Newest title'],"the browser shows the owner's values");
  // The sync state is kept small; the base sits on its own, stamped with its revision.
  assert.ok(!('base' in JSON.parse(b.ls.get('flygon-flow-sync-v1'))));
  assert.equal(JSON.parse(b.ls.get('flygon-flow-sync-v1-base')).rev,5);

  // A real edit in this browser is sent, with the value it started from.
  b.store.change(()=>{c('k1').column='uat'});
  await b.settle();
  const last=b.puts.at(-1);
  assert.deepEqual(last.sharedEdits,{card:{[L('k1')]:{column:'done'}}});
  assert.equal(last.data.devops.cards.find(x=>x.id===L('k2')).title,'Newest title');
});
