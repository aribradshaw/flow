// REST API v1 and the operation registry against a temp file-store workspace (no Postgres, no
// network beyond a loopback server on a random port). Run: node --test test/
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {workspaceStore} from '../lib/workspaces.mjs';
import {apiV1,envCheckFor,memoryRateLimit,openapi} from '../lib/api-v1.mjs';
import {operations,getOperation,invoke} from '../lib/registry.mjs';
import {check} from '../lib/json-schema.mjs';
import * as cleaners from '../lib/cleaners.mjs';

const OWNER={id:'u-owner',email:'owner@example.test'},BOB={id:'u-bob',email:'bob@example.com'};
const KEYS={flow_rw:{user:OWNER,scopes:['read','write']},flow_ro:{user:OWNER,scopes:['read']},flow_bob:{user:BOB,scopes:['read','write']},flow_limited:{user:{id:'u-lim',email:'lim@example.com'},scopes:['read']}};
const ENV='test-env';
const seed=()=>({active:'c1',charts:[{id:'c1',name:'Brainstorm',nodes:[
  {id:'flygon',name:'Kestrel Group',type:'entity',x:400,y:0,notes:''},{id:'cleo',name:'Cleo Park',type:'person',x:320,y:144,notes:'Engineer'},
  {id:'bo',name:'Bo Marsh',type:'person',x:656,y:144},{id:'quill',name:'Quill Solutions',type:'entity',x:320,y:320}],
  edges:[{id:'g1',from:'flygon',to:'quill',type:'group',percent:''}]}],
  projects:[{id:'p1',name:'Lantern',color:'#7cb980',entity:'flygon'}],
  timeline:[{id:'i1',title:'Public beta',kind:'release',status:'planned',start:'2026-12-01',end:'',projects:['p1']}],
  environment:{id:ENV,name:'Test',ownerEmail:OWNER.email,visibility:'private',members:[]}});

let dir,store,server,base;
const called=new Set();
async function call(method,path,{key='flow_rw',body,headers={}}={}){
  const r=await fetch(base+path,{method,headers:{...(key?{authorization:'Bearer '+key}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});
  return {status:r.status,body:await r.json().catch(()=>null),headers:r.headers};
}
// Call an operation over HTTP by id: fills the path from input, sends the rest as query or body.
async function op(id,input,opts={}){
  const o=getOperation(id),rest={...input};called.add(id);
  const path=o.path.replace(/\{(\w+)\}/g,(_,k)=>{const v=rest[k];delete rest[k];return encodeURIComponent(v)});
  const q=o.method==='GET'||o.method==='DELETE';
  const r=await call(o.method,path+(q&&Object.keys(rest).length?'?'+new URLSearchParams(Object.entries(rest).map(([k,v])=>[k,String(v)])):''),{...opts,body:q?undefined:rest});
  if(r.status<300)assert.deepEqual(check(o.output,r.body,'output'),[],`${id} output matches its schema`);
  return r;
}

let limiter;
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'flow-api-'));
  store=workspaceStore({dir,db:async()=>null});
  await store.put(ENV,{baseRev:0,data:seed(),by:OWNER.email,owner:OWNER.email,name:'Test'});
  await store.put('bob-env',{baseRev:0,data:{...seed(),environment:{id:'bob-env',name:'Bob',ownerEmail:BOB.email,visibility:'private',members:[]}},by:BOB.email,owner:BOB.email,name:'Bob'});
  await store.put('bob-public',{baseRev:0,data:{...seed(),environment:{id:'bob-public',name:'Bob public',ownerEmail:BOB.email,visibility:'public',members:[]}},by:BOB.email,owner:BOB.email,name:'Bob public',visibility:'public'});
  const limit=memoryRateLimit({perMinute:3});
  limiter=({req,user,operation})=>user.email==='lim@example.com'?limit({req,user,operation}):{ok:true};
  server=http.createServer(async(req,res)=>{
    if(await apiV1(req,res,{authenticate:async r=>KEYS[/^Bearer\s+(\S+)$/.exec(r.headers.authorization||'')?.[1]]||null,userFor:async r=>r.headers.cookie==='session=owner'?OWNER:null,store,envCheck:envCheckFor(store),rateLimit:limiter}))return;
    res.writeHead(418);res.end();
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  base=`http://127.0.0.1:${server.address().port}`;
});
after(()=>{server?.close();rmSync(dir,{recursive:true,force:true})});

test('registry: every operation is documented, has examples and schemas, and the examples fit them',()=>{
  const ids=new Set(),routes=new Set();
  for(const o of operations){
    assert.ok(o.id&&!ids.has(o.id),`${o.id}: unique id`);ids.add(o.id);
    assert.ok(['GET','POST','PATCH','DELETE'].includes(o.method),`${o.id}: method`);
    assert.ok(o.path.startsWith('/api/v1/'),`${o.id}: path under /api/v1`);
    assert.ok(!routes.has(o.method+o.path),`${o.id}: unique route`);routes.add(o.method+o.path);
    assert.ok(['read','write','admin'].includes(o.scope),`${o.id}: scope`);
    assert.ok(Array.isArray(o.tags)&&o.tags.length,`${o.id}: tags`);
    assert.ok(typeof o.summary==='string'&&o.summary.trim(),`${o.id}: summary`);
    assert.ok(typeof o.description==='string'&&o.description.trim().length>=20,`${o.id}: description`);
    assert.equal(o.input?.type,'object',`${o.id}: input schema`);
    assert.equal(o.output?.type,'object',`${o.id}: output schema`);
    for(const p of o.path.match(/\{\w+\}/g)||[])assert.ok(o.input.required.includes(p.slice(1,-1)),`${o.id}: path parameter ${p} is a required input`);
    assert.ok(Array.isArray(o.examples)&&o.examples.length,`${o.id}: at least one example`);
    for(const x of o.examples){
      assert.ok(x.title,`${o.id}: example title`);
      assert.deepEqual(check(o.input,x.input),[],`${o.id}: example "${x.title}" input fits the schema`);
      assert.deepEqual(check(o.output,x.output,'output'),[],`${o.id}: example "${x.title}" output fits the schema`);
    }
    assert.doesNotThrow(()=>JSON.stringify(o),`${o.id}: plain data`);
  }
  const want=['envs.list','envs.get','charts.list','nodes.list','nodes.get','nodes.create','nodes.update','nodes.move','edges.list','edges.create','edges.delete',
    'projects.list','projects.create','projects.update','items.list','items.get','items.create','items.update','cards.list','cards.get','cards.create','cards.update','cards.move','labels.list','labels.create','search',
    'agents.list','agents.get','agents.work','agents.create','agents.update','agents.delete','runners.list','runners.report','workflows.list','workflows.get','workflows.create','workflows.update'];
  assert.deepEqual([...ids].sort(),want.sort());
  assert.equal(getOperation('nope'),null);
});

test('lib/cleaners.mjs matches the client cleaners in public/store.js',()=>{
  // Evaluate store.js's pure section (constants through cleanEnvironment) without its DOM imports.
  const src=readFileSync(fileURLToPath(new URL('../public/store.js',import.meta.url)),'utf8');
  const body=src.slice(src.indexOf('const KEY='),src.indexOf('function normalize(')).replace(/^export /gm,'');
  const orig=new Function('uid',body+';return {validChart,cleanProject,cleanItem,cleanNode,ITEM_KINDS,ITEM_PRIORITY,ITEM_STATUS,PALETTE}')(()=>'x');
  for(const k of ['ITEM_KINDS','ITEM_PRIORITY','ITEM_STATUS','PALETTE'])assert.deepEqual(cleaners[k],orig[k],k);
  const charts=[seed().charts[0],{name:'x',nodes:[{id:'a',name:'A',type:'bad',x:0,y:0}],edges:[]},{name:'x',nodes:[{id:'a',name:'A',type:'note',x:0,y:0,w:0}],edges:[]},
    {name:'x',nodes:[{id:'a',name:'A',type:'note',x:0,y:0},{id:'b',name:'B',type:'note',x:1,y:1}],edges:[{id:'e',from:'a',to:'b',type:'ownership',percent:'150'}]},null];
  for(const c of charts)assert.equal(cleaners.validChart(c),orig.validChart(c));
  const projects=[{id:'p',name:'P'.repeat(100),color:'#zzz'},{id:'q',name:'Q',color:'#AABBCC',entity:5},{name:'none'},null];
  projects.forEach((p,i)=>assert.deepEqual(cleaners.cleanProject(p,i),orig.cleanProject(p,i)));
  const ps=[{id:'p'}],items=[{id:'i',title:'T',start:'2026-01-02',end:'2026-01-01',kind:'nope',status:'done',projects:['p','p','zz'],priority:'high',inbox:{at:'x',sig:'s'}},
    {id:'j',title:'U',start:'',end:'2026-01-01'},{id:'k',title:'V',start:'bad'},{id:'l',title:'W',start:'2026-02-01',end:'2026-03-01',owner:7,notes:null}];
  for(const it of items)assert.deepEqual(cleaners.cleanItem(it,ps),orig.cleanItem(it,ps));
  const nodes=[{id:'a',type:'person',image:'https://example.test/a.png',email:' A@Example.TEST '},{id:'b',type:'entity',image:'https://example.test/b.png',email:'b@example.test'},
    {id:'c',type:'person',image:'data:image/png;base64,'+'A'.repeat(cleaners.PERSON_IMAGE_MAX),email:'nope'},{id:'d',type:'person',image:'javascript:alert(1)',email:7}];
  for(const n of nodes)assert.deepEqual(cleaners.cleanNode(structuredClone(n)),orig.cleanNode(structuredClone(n)));
});

test('person photos and emails: valid ones are kept, anything else is dropped',()=>{
  const {cleanNode,PERSON_IMAGE_MAX}=cleaners,p=x=>cleanNode({id:'p',name:'P',type:'person',x:0,y:0,...x});
  const png='data:image/png;base64,iVBORw0KGgo=',webp='data:image/webp;base64,UklGRg==',jpeg='data:image/jpeg;base64,/9j/4AAQ';
  for(const image of ['https://example.test/me.jpg',png,webp,jpeg])assert.equal(p({image}).image,image,image.slice(0,30));
  assert.equal(p({email:'  Cleo@Example.TEST '}).email,'cleo@example.test','trimmed and lower-cased');
  const big='data:image/webp;base64,'+'A'.repeat(PERSON_IMAGE_MAX);
  const fits='data:image/webp;base64,'+'A'.repeat(PERSON_IMAGE_MAX-'data:image/webp;base64,'.length);
  assert.equal(p({image:fits}).image,fits,'exactly at the cap');
  for(const image of [big,'http://example.test/me.jpg','javascript:alert(1)','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,<script>','https://example.test/a b.png','https://x.test/"onerror="x','',42,null,{}])
    assert.equal('image' in p({image}),false,`drops ${String(image).slice(0,40)}`);
  for(const email of ['nope','a@b','a b@example.test','x'.repeat(190)+'@example.test','',12,null])assert.equal('email' in p({email}),false,`drops ${String(email).slice(0,30)}`);
  assert.deepEqual(cleanNode({id:'e',name:'E',type:'entity',x:0,y:0,image:png,email:'e@example.test'}),{id:'e',name:'E',type:'entity',x:0,y:0},'only person cards keep them');
  // normalize() cleans every chart's nodes and leaves shared (sh.*) ids alone.
  const db=cleaners.normalize({charts:[{id:'c',name:'C',nodes:[{id:'sh.s1.cleo',name:'Cleo',type:'person',x:0,y:0,image:png,email:'bad'}],edges:[]}]});
  assert.deepEqual(db.charts[0].nodes[0],{id:'sh.s1.cleo',name:'Cleo',type:'person',x:0,y:0,image:png});
});

test('envs, charts and search',async()=>{
  let r=await op('envs.list',{});
  assert.equal(r.status,200);assert.deepEqual(r.body.items.map(e=>e.id),[ENV]);
  r=await op('envs.get',{env:ENV});
  assert.equal(r.status,200);assert.equal(r.body.environment.owner,OWNER.email);assert.deepEqual(r.body.environment.counts,{charts:1,nodes:4,edges:1,projects:1,items:1,cards:0});
  r=await op('charts.list',{env:ENV});
  assert.deepEqual(r.body.items,[{id:'c1',name:'Brainstorm',active:true,nodes:4,edges:1}]);assert.equal(r.body.rev,1);
  r=await op('search',{env:ENV,q:'engineer'});
  assert.deepEqual(r.body.items,[{type:'node',id:'cleo',title:'Cleo Park',chart:'c1'}]);
  r=await op('search',{env:ENV,q:'public',types:'item,card'});
  assert.deepEqual(r.body.items.map(h=>h.type),['item']);
});

test('nodes: list, get, create, update, move',async()=>{
  let r=await op('nodes.list',{env:ENV,chart:'active',type:'person'});
  assert.deepEqual(r.body.items.map(n=>n.id),['cleo','bo']);
  r=await op('nodes.list',{env:ENV,chart:'c1',q:'quill'});
  assert.deepEqual(r.body.items.map(n=>n.id),['quill']);
  r=await op('nodes.get',{env:ENV,chart:'c1',node:'flygon'});
  assert.equal(r.body.node.name,'Kestrel Group');
  assert.equal((await op('nodes.get',{env:ENV,chart:'c1',node:'nope'})).body.code,'node_not_found');
  assert.equal((await op('nodes.get',{env:ENV,chart:'nope',node:'flygon'})).status,404);
  r=await op('nodes.create',{env:ENV,chart:'c1',type:'area',name:'Side projects'});
  assert.equal(r.status,201);const area=r.body.node;assert.deepEqual([area.x,area.y,area.type],[0,0,'area']);
  r=await op('nodes.create',{env:ENV,chart:'c1',type:'note',name:'Second'});
  assert.deepEqual([r.body.node.x,r.body.node.y],[32,32],'steps past an occupied spot');
  r=await op('nodes.update',{env:ENV,chart:'c1',node:area.id,name:'Personal',notes:'later',w:300,h:200});
  assert.deepEqual([r.body.node.name,r.body.node.notes,r.body.node.w],['Personal','later',300]);
  r=await op('nodes.move',{env:ENV,chart:'c1',node:area.id,x:-48,y:288});
  assert.deepEqual([r.body.node.x,r.body.node.y],[-48,288]);
  assert.equal((await op('nodes.update',{env:ENV,chart:'c1',node:area.id,type:'robot'})).body.code,'invalid_input');
  const w=await store.get(ENV);assert.equal(w.rev,r.body.rev);assert.equal(w.data.charts[0].nodes.find(n=>n.id===area.id).x,-48);
});

test('nodes: a person\'s photo and email',async()=>{
  const png='data:image/png;base64,iVBORw0KGgo=';
  let r=await op('nodes.update',{env:ENV,chart:'c1',node:'bo',image:png,email:' Bo@Example.TEST '});
  assert.equal(r.status,200);assert.equal(r.body.node.image,png);assert.equal(r.body.node.email,'bo@example.test');
  r=await op('nodes.get',{env:ENV,chart:'c1',node:'bo'});assert.equal(r.body.node.image,png);
  r=await op('nodes.update',{env:ENV,chart:'c1',node:'bo',image:'https://example.test/bo.jpg'});
  assert.equal(r.body.node.image,'https://example.test/bo.jpg');assert.equal(r.body.node.email,'bo@example.test','left out, so kept');
  for(const [input,code] of [[{image:'http://example.test/bo.jpg'},'invalid_image'],[{image:'data:image/svg+xml;base64,PHN2Zz4='},'invalid_image'],[{email:'not-an-email'},'invalid_email'],
    [{image:'data:image/png;base64,'+'A'.repeat(cleaners.PERSON_IMAGE_MAX)},'invalid_input']]){
    r=await op('nodes.update',{env:ENV,chart:'c1',node:'bo',...input});assert.equal(r.status,400);assert.equal(r.body.code,code,JSON.stringify(input).slice(0,60));
  }
  assert.equal((await op('nodes.update',{env:ENV,chart:'c1',node:'flygon',image:png})).body.code,'invalid_image','only person cards');
  r=await op('nodes.create',{env:ENV,chart:'c1',type:'person',name:'Photo Person',image:png,email:'pp@example.test',x:900,y:900});
  assert.equal(r.status,201);assert.deepEqual([r.body.node.image,r.body.node.email],[png,'pp@example.test']);
  // Changing a person into another kind of card drops both; "" removes them.
  r=await op('nodes.update',{env:ENV,chart:'c1',node:r.body.node.id,type:'entity'});assert.equal(r.body.node.image,undefined);assert.equal(r.body.node.email,undefined);
  r=await op('nodes.update',{env:ENV,chart:'c1',node:'bo',image:'',email:''});
  assert.equal(r.body.node.image,undefined);assert.equal(r.body.node.email,undefined);
  const w=await store.get(ENV);assert.equal('image' in w.data.charts[0].nodes.find(n=>n.id==='bo'),false);
});

test('edges: list, create, delete',async()=>{
  let r=await op('edges.create',{env:ENV,chart:'c1',from:'cleo',to:'quill',percent:50});
  assert.equal(r.status,201);assert.equal(r.body.edge.percent,'50');const id=r.body.edge.id;
  assert.equal((await op('edges.create',{env:ENV,chart:'c1',from:'cleo',to:'quill'})).status,409);
  assert.equal((await op('edges.create',{env:ENV,chart:'c1',from:'cleo',to:'cleo'})).body.code,'invalid_edge');
  assert.equal((await op('edges.create',{env:ENV,chart:'c1',from:'bo',to:'quill',percent:'120'})).body.code,'invalid_percent');
  assert.equal((await op('edges.create',{env:ENV,chart:'c1',from:'bo',to:'ghost'})).status,404);
  r=await op('edges.list',{env:ENV,chart:'c1',node:'cleo'});
  assert.deepEqual(r.body.items.map(e=>e.id),[id]);
  r=await op('edges.delete',{env:ENV,chart:'c1',edge:id});
  assert.deepEqual(r.body.deleted,id);
  assert.equal((await op('edges.delete',{env:ENV,chart:'c1',edge:id})).status,404);
  assert.equal((await store.get(ENV)).data.charts[0].nodes.some(n=>n.id==='cleo'),true,'the nodes stay');
});

test('projects: list, create, update',async()=>{
  let r=await op('projects.create',{env:ENV,name:'Campaign',entity:'Quill Solutions'});
  assert.equal(r.status,201);assert.equal(r.body.project.entity,'quill');assert.match(r.body.project.color,/^#[0-9a-f]{6}$/i,'palette colour');
  assert.equal((await op('projects.create',{env:ENV,name:'campaign'})).body.code,'project_exists');
  assert.equal((await op('projects.create',{env:ENV,name:'X',entity:'Cleo Park'})).body.code,'unknown_entity','people cannot hold projects');
  r=await op('projects.update',{env:ENV,project:'Campaign',color:'#3d6fb6',entity:''});
  assert.deepEqual([r.body.project.color,r.body.project.entity],['#3d6fb6','']);
  assert.equal((await op('projects.update',{env:ENV,project:'Campaign',name:'LANTERN'})).status,409);
  r=await op('projects.list',{env:ENV,entity:'flygon'});
  assert.deepEqual(r.body.items.map(p=>p.name),['Lantern']);
});

test('timeline items: list, get, create, update',async()=>{
  let r=await op('items.create',{env:ENV,title:'Sign-up flow',priority:'high',release:'Public beta',projects:['Lantern']});
  assert.equal(r.status,201);const it=r.body.item;
  assert.deepEqual([it.kind,it.start,it.release,it.projects],['feature','','i1',['p1']]);
  assert.equal((await op('items.create',{env:ENV,title:'Bad',start:'2026-02-02',end:'2026-01-01'})).body.code,'invalid_dates');
  assert.equal((await op('items.create',{env:ENV,title:'Bad',start:'02/02/2026'})).body.code,'invalid_input');
  assert.equal((await op('items.create',{env:ENV,title:'Bad',projects:['ghost']})).body.code,'unknown_project');
  r=await op('items.update',{env:ENV,item:it.id,status:'active',start:'2026-11-01',end:'2026-11-20'});
  assert.deepEqual([r.body.item.status,r.body.item.end],['active','2026-11-20']);
  r=await op('items.get',{env:ENV,item:'Sign-up flow'});
  assert.equal(r.body.item.id,it.id);
  r=await op('items.list',{env:ENV,project:'Lantern',kind:'feature'});
  assert.deepEqual(r.body.items.map(i=>i.title),['Sign-up flow']);
});

test('labels: list, create',async()=>{
  let r=await op('labels.list',{env:ENV,section:'priority'});
  assert.deepEqual(r.body.items.map(l=>l.id),['l-high','l-medium','l-low']);
  r=await op('labels.create',{env:ENV,name:'Research Ops',section:'area',color:'teal'});
  assert.equal(r.status,201);assert.equal(r.body.label.id,'l-research-ops');
  assert.equal((await op('labels.create',{env:ENV,name:'research ops'})).status,409);
  assert.equal((await op('labels.create',{env:ENV,name:'X',color:'plaid'})).status,400);
});

test('cards: create, get, update, list, and move through the board gates',async()=>{
  let r=await op('cards.create',{env:ENV,title:'Build sign-up form',project:'Lantern',labels:['High','l-frontend'],points:3,due:'2026-11-15',
    assignees:[{node:'Bo Marsh',role:'tester'}],checklist:[{text:'Email field'}],links:[{kind:'pr',url:'https://example.com/pr/1'}],item:'Public beta'});
  assert.equal(r.status,201);const c=r.body.card;
  assert.deepEqual([c.number,c.column,c.project,c.labels,c.item,c.assignees],[1,'requests','p1',['l-high','l-frontend'],'i1',[{node:'bo',role:'tester'}]]);
  assert.ok(c.checklist[0].id&&c.links[0].id);
  assert.equal((await op('cards.create',{env:ENV,title:'X',labels:['ghost']})).body.code,'unknown_label');
  assert.equal((await op('cards.create',{env:ENV,title:'X',assignees:[{node:'Kestrel Group'}]})).body.code,'unknown_person','only people can be assigned');
  assert.equal((await op('cards.create',{env:ENV,title:'Second',column:'must'})).body.card.number,2);
  r=await op('cards.get',{env:ENV,card:'#1'});assert.equal(r.body.card.id,c.id);
  r=await op('cards.get',{env:ENV,card:c.id});assert.equal(r.body.card.number,1);
  assert.equal((await op('cards.get',{env:ENV,card:99})).body.code,'card_not_found');
  r=await op('cards.update',{env:ENV,card:1,title:'Build the sign-up form',checklist:[{...c.checklist[0],done:true}],points:null});
  assert.deepEqual([r.body.card.title,r.body.card.checklist[0].done,r.body.card.points],['Build the sign-up form',true,null]);
  assert.equal((await op('cards.update',{env:ENV,card:1,column:'done'})).body.code,'invalid_input','the column only moves through cards.move');

  // Doing needs a developer (or an explicit confirm to leave it unassigned).
  r=await op('cards.move',{env:ENV,card:1,column:'doing'});
  assert.deepEqual([r.status,r.body.code],[409,'pick_developer']);
  r=await op('cards.move',{env:ENV,card:1,column:'doing',developer:'Cleo Park'});
  assert.equal(r.body.card.column,'doing');assert.ok(r.body.card.assignees.some(a=>a.node==='cleo'&&a.role==='developer'));
  r=await op('cards.move',{env:ENV,card:2,column:'doing',confirm:true});
  assert.equal(r.body.card.column,'doing');
  // Done asks first; Approve works only from UAT.
  assert.equal((await op('cards.move',{env:ENV,card:1,column:'done'})).body.code,'confirm_done');
  assert.equal((await op('cards.move',{env:ENV,card:1,column:'done',approve:true})).body.code,'approve_only_from_uat');
  await op('cards.move',{env:ENV,card:1,column:'uat'});
  r=await op('cards.move',{env:ENV,card:1,column:'done',approve:true});assert.equal(r.body.card.column,'done');
  // Reopening asks too.
  assert.equal((await op('cards.move',{env:ENV,card:1,column:'requests'})).body.code,'confirm_reopen');
  r=await op('cards.move',{env:ENV,card:1,column:'doing',confirm:true});assert.equal(r.body.card.column,'doing');
  // Order within a column.
  r=await op('cards.move',{env:ENV,card:1,column:'doing',index:0});
  const order=(await store.get(ENV)).data.devops.cards.filter(x=>x.column==='doing').map(x=>x.number);
  assert.deepEqual(order,[1,2]);

  r=await op('cards.list',{env:ENV,assignee:'cleo',hideDone:true});
  assert.deepEqual(r.body.items.map(x=>x.number),[1]);
  r=await op('cards.list',{env:ENV,column:'doing',q:'#2'});
  assert.deepEqual(r.body.items.map(x=>x.number),[2]);
  r=await op('cards.list',{env:ENV,project:'none'});
  assert.deepEqual(r.body.items.map(x=>x.number),[2]);
  r=await op('cards.list',{env:ENV,label:'Frontend'});
  assert.deepEqual(r.body.items.map(x=>x.number),[1]);
});

test('AgentFlow: agents and workflows, with briefs for runners',async()=>{
  let r=await op('agents.create',{env:ENV,name:'Chief of staff',title:'Orchestrator',status:'active',supervisor:'Cleo Park',projects:['Lantern']});
  assert.equal(r.status,201);const lead=r.body.agent;
  assert.deepEqual([lead.kind,lead.reportsTo,lead.supervisor,lead.projects],['agent','','cleo',['p1']]);
  r=await op('agents.create',{env:ENV,name:'Researcher',reportsTo:'chief of staff',inputs:['A card',' A card '],outputs:['Notes'],cards:['#2'],items:['Public beta']});
  assert.equal(r.status,201);const res=r.body.agent;
  assert.deepEqual([res.reportsTo,res.inputs,res.cards,res.items],[lead.id,['A card'],[(await store.get(ENV)).data.devops.cards.find(c=>c.number===2).id],['i1']],'references resolve by name or number; text lists are trimmed and unique');
  assert.equal((await op('agents.create',{env:ENV,name:'X',supervisor:'Kestrel Group'})).body.code,'unknown_person','supervisors are people');
  assert.equal((await op('agents.create',{env:ENV,name:'X',cards:[99]})).body.code,'unknown_card');
  assert.equal((await op('agents.create',{env:ENV,name:'X',kind:'robot'})).status,400);
  // No loops in the org.
  assert.equal((await op('agents.update',{env:ENV,agent:lead.id,reportsTo:'Researcher'})).body.code,'reports_loop');
  assert.equal((await op('agents.update',{env:ENV,agent:'Researcher',reportsTo:'Researcher'})).body.code,'reports_loop');
  assert.equal((await op('agents.update',{env:ENV,agent:'Researcher',x:10})).body.code,'invalid_position');
  r=await op('agents.update',{env:ENV,agent:'Researcher',x:480,y:320});
  assert.deepEqual([r.body.agent.x,r.body.agent.y],[480,320]);
  assert.ok(Number.isFinite((await op('agents.get',{env:ENV,agent:lead.id})).body.agent.x),'placing one agent pins the rest where they were drawn');
  r=await op('agents.update',{env:ENV,agent:'Researcher',kind:'agent',status:'active',tools:['Web search'],runtime:'T3'});
  assert.deepEqual([r.body.agent.status,r.body.agent.tools,r.body.agent.runtime],['active',['Web search'],'T3']);
  assert.equal(r.body.agent.live,false,'new agents are not live');
  r=await op('runners.report',{env:ENV,runner:'Home server',models:[{id:'claudeAgent:claude-sonnet-5-5',label:'Claude · Sonnet 5.5'},{id:'codex:gpt-6.1-terra'}]});
  assert.deepEqual([r.status,r.body.changed,r.body.runner.models.length],[200,true,2]);const rev1=r.body.rev;
  r=await op('runners.report',{env:ENV,runner:'home server',models:[{id:'claudeAgent:claude-sonnet-5-5',label:'Claude · Sonnet 5.5'},{id:'codex:gpt-6.1-terra'}]});
  assert.deepEqual([r.body.changed,r.body.rev,r.body.runner.name],[false,rev1,'Home server'],'an unchanged report saves nothing');
  r=await op('runners.list',{env:ENV});
  assert.deepEqual(r.body.items.map(x=>x.name),['Home server']);
  r=await op('agents.update',{env:ENV,agent:'Researcher',live:true,runtime:'Home server',model:'claudeAgent:claude-sonnet-5-5'});
  assert.equal(r.body.agent.live,true);
  assert.deepEqual((await op('agents.list',{env:ENV,live:true})).body.items.map(a=>a.name),['Researcher']);
  assert.match((await op('agents.get',{env:ENV,agent:'Researcher'})).body.brief,/Model: Claude · Sonnet 5\.5 \(claudeAgent:claude-sonnet-5-5\)/);
  assert.deepEqual([r.body.agent.models,r.body.agent.model,r.body.agent.auto],[['claudeAgent:claude-sonnet-5-5'],'claudeAgent:claude-sonnet-5-5',false],'model alone sets models to it');
  r=await op('agents.update',{env:ENV,agent:'Researcher',models:[' codex:gpt-6.1-terra','claudeAgent:claude-sonnet-5-5','codex:gpt-6.1-terra'],model:'ignored:x',auto:true});
  assert.deepEqual([r.body.agent.models,r.body.agent.model,r.body.agent.auto],[['codex:gpt-6.1-terra','claudeAgent:claude-sonnet-5-5'],'codex:gpt-6.1-terra',true],'models wins over model, cleaned');
  assert.match((await op('agents.get',{env:ENV,agent:'Researcher'})).body.brief,/- Auto from: codex:gpt-6\.1-terra, Claude · Sonnet 5\.5 \(claudeAgent:claude-sonnet-5-5\)/);
  assert.equal((await op('agents.update',{env:ENV,agent:'Researcher',models:Array.from({length:11},(_,i)=>'x:'+i)})).status,400,'up to 10 models');
  r=await op('runners.report',{env:ENV,runner:'Home server',models:[{id:'claudeAgent:claude-sonnet-5-5',label:'Claude · Sonnet 5.5',provider:'Claude',billing:'included'},{id:'opencode:openai/gpt-6',provider:'OpenCode',billing:'metered'}]});
  assert.deepEqual([r.body.changed,r.body.runner.models],[true,[{id:'claudeAgent:claude-sonnet-5-5',label:'Claude · Sonnet 5.5',provider:'Claude',billing:'included'},{id:'opencode:openai/gpt-6',label:'',provider:'OpenCode',billing:'metered'}]]);
  assert.equal((await op('runners.report',{env:ENV,runner:'Home server',models:[{id:'a:b',billing:'free'}]})).status,400,'billing is included or metered');
  r=await op('agents.update',{env:ENV,agent:'Researcher',model:'',auto:false});
  assert.deepEqual([r.body.agent.models,r.body.agent.model],[[],''],'an empty model clears models');
  r=await op('agents.update',{env:ENV,agent:'Researcher',live:false,runtime:'T3',model:''});
  r=await op('agents.list',{env:ENV,status:'active',q:'research'});
  assert.deepEqual(r.body.items.map(a=>a.name),['Researcher']);
  r=await op('agents.list',{env:ENV,project:'Lantern'});
  assert.deepEqual(r.body.items.map(a=>a.name),['Chief of staff']);

  r=await op('workflows.create',{env:ENV,name:'Ship a card',trigger:'event',schedule:'A card enters Doing',status:'active',steps:[{agent:'Chief of staff',action:'Plan'},{agent:'Researcher',action:'Research',output:'Notes'},{action:'Review'}]});
  assert.equal(r.status,201);const wf=r.body.workflow;
  assert.deepEqual(wf.steps.map(s=>s.agent),[lead.id,res.id,'']);assert.ok(wf.steps.every(s=>s.id));
  assert.equal((await op('workflows.create',{env:ENV,name:'X',steps:[{agent:'Nobody'}]})).body.code,'unknown_agent');
  r=await op('workflows.update',{env:ENV,workflow:'ship a card',steps:[wf.steps[1],wf.steps[0]],cards:[1]});
  assert.deepEqual(r.body.workflow.steps.map(s=>s.id),[wf.steps[1].id,wf.steps[0].id],'steps keep their ids when sent back');
  r=await op('workflows.list',{env:ENV,agent:'Researcher'});
  assert.deepEqual(r.body.items.map(w=>w.name),['Ship a card']);
  assert.equal((await op('workflows.get',{env:ENV,workflow:'nope'})).body.code,'workflow_not_found');

  // Briefs: everything a runner needs, including linked Flow work.
  r=await op('agents.get',{env:ENV,agent:'Researcher'});
  assert.equal(r.body.agent.id,res.id);
  for(const part of ['# Researcher','Reports to: Chief of staff (Orchestrator)','- A card','- Notes','- Web search','Runs on: T3','Ship a card: step 1: Research','#2 Second','Public beta (release, 2026-12-01'])
    assert.ok(r.body.brief.includes(part),`agent brief has "${part}"`);
  r=await op('agents.get',{env:ENV,agent:lead.id});
  assert.match(r.body.brief,/#1 Build the sign-up form \(Doing/,'open cards in linked projects are in the brief');
  assert.match(r.body.brief,/Supervised by: Cleo Park/);
  r=await op('workflows.get',{env:ENV,workflow:wf.id});
  assert.match(r.body.brief,/1\. \*\*Researcher\*\*: Research → Notes\n2\. \*\*Chief of staff\*\*: Plan/);
  r=await op('search',{env:ENV,q:'ship',types:'workflow,agent'});
  assert.deepEqual(r.body.items.map(h=>[h.type,h.title]),[['workflow','Ship a card']]);

  // Links to shared-in records (absent from stored data) survive unrelated API writes.
  {const w=await store.get(ENV);w.data.agentflow.agents.find(x=>x.id===res.id).cards.push('sh.s1.k9');
    assert.ok((await store.put(ENV,{baseRev:w.rev,data:w.data,by:OWNER.email,owner:OWNER.email,name:w.name})).ok);}
  await op('projects.update',{env:ENV,project:'Lantern',color:'#3d6fb6'});
  assert.ok((await store.get(ENV)).data.agentflow.agents.find(x=>x.id===res.id).cards.includes('sh.s1.k9'),'shared card links are kept');

  // Deleting an agent moves its reports up and unassigns its steps.
  r=await op('agents.delete',{env:ENV,agent:'Chief of staff'});
  assert.deepEqual([r.status,r.body.deleted],[200,lead.id]);
  const af=(await store.get(ENV)).data.agentflow;
  assert.deepEqual([af.agents.map(a=>[a.name,a.reportsTo]),af.workflows[0].steps.map(s=>s.agent)],[[['Researcher','']],[res.id,'']]);
  assert.equal((await op('agents.get',{env:ENV,agent:'Chief of staff'})).body.code,'unknown_agent');
});

test('AgentFlow: runners report scheduled jobs; agents carry a schedule and the job they came from',async()=>{
  const at=h=>new Date(Date.now()+h*3600e3).toISOString(),models=[{id:'claudeAgent:claude-sonnet-5-5',label:'Claude · Sonnet 5.5'}];
  const backup=(o={})=>({id:'systemd:backup.timer',name:'Nightly backup',source:'systemd',group:'Jobs box',schedule:'Daily 22:30',cron:'30 22 * * *',command:'restic backup /srv',lastRun:at(-1),lastStatus:'ok',nextRun:at(20),...o});
  let r=await op('runners.report',{env:ENV,runner:'Jobs box',models,jobs:[backup(),{id:'vercel:app:/api/cron/sync',name:'Sync',source:'vercel',schedule:'Every 5 min',ai:false},{id:'claude:triage',name:'Triage',source:'claude',schedule:'Weekdays 08:00',ai:true}]});
  assert.deepEqual([r.status,r.body.changed,r.body.runner.jobs.length],[200,true,3]);
  assert.ok(r.body.runner.jobsReported,'jobsReported is set when jobs are saved');
  assert.deepEqual(r.body.runner.jobs[1],{id:'vercel:app:/api/cron/sync',name:'Sync',source:'vercel',schedule:'Every 5 min',ai:false,enabled:true,lastStatus:'unknown'});
  const rev=r.body.rev,jobs=r.body.runner.jobs;
  r=await op('runners.report',{env:ENV,runner:'jobs box',models,jobs:[backup({lastRun:at(-.5),nextRun:at(21)}),jobs[1],jobs[2]]});
  assert.deepEqual([r.body.changed,r.body.rev],[false,rev],'only lastRun and nextRun moved: nothing saved');
  r=await op('runners.report',{env:ENV,runner:'Jobs box',models});
  assert.deepEqual([r.body.changed,r.body.runner.jobs.length],[false,3],'leaving jobs out keeps them');
  r=await op('runners.report',{env:ENV,runner:'Jobs box',models,jobs:[backup({lastStatus:'failed'}),jobs[1],jobs[2]]});
  assert.deepEqual([r.body.changed,r.body.runner.jobs[0].lastStatus],[true,'failed'],'a status flip is saved');
  // Six hours on, the volatile times are refreshed too.
  {const w=await store.get(ENV);w.data.agentflow.runners.find(x=>x.name==='Jobs box').jobsReported=at(-7);
    assert.ok((await store.put(ENV,{baseRev:w.rev,data:w.data,by:OWNER.email,owner:OWNER.email,name:w.name})).ok);}
  r=await op('runners.report',{env:ENV,runner:'Jobs box',models,jobs:[backup({lastStatus:'failed',lastRun:at(-.2)}),jobs[1],jobs[2]]});
  assert.equal(r.body.changed,true,'jobs last saved over six hours ago: the new times are saved');
  assert.equal((await op('runners.report',{env:ENV,runner:'Jobs box',models,jobs:Array.from({length:501},(_,i)=>({id:'j'+i}))})).status,400,'up to 500 jobs');
  assert.equal((await op('runners.report',{env:ENV,runner:'Jobs box',models,jobs:[{id:'x',lastStatus:'exploded'}]})).status,400,'lastStatus is ok, failed, running or unknown');
  assert.equal((await op('runners.report',{env:ENV,runner:'Jobs box',models,jobs:[{id:'x',source:'s'.repeat(41)}]})).status,400,'source is up to 40 characters');
  assert.equal((await op('runners.report',{env:ENV,runner:'Jobs box',models,jobs:[{name:'no id'}]})).status,400,'jobs need an id');
  // The full schedule: zone, triggers with raw expressions, where it was read, drift and a note.
  const rail={id:'railway:votes:services/pub/railway.json',name:'pub',source:'railway',schedule:'Every 5 min',cron:'*/5 * * * *',timezone:'UTC',
    triggers:[{kind:'cron',expr:'*/5 * * * *',text:'Every 5 min'}],origin:'platform',file:'services/pub/railway.json',drift:'Railway runs */10 * * * *; railway.json has */5 * * * *',note:'Exits early when nothing changed.'};
  r=await op('runners.report',{env:ENV,runner:'Jobs box',models,jobs:[rail],timezone:'America/Phoenix'});
  assert.deepEqual([r.status,r.body.changed,r.body.runner.timezone],[200,true,'America/Phoenix']);
  assert.deepEqual(r.body.runner.jobs[0],{...rail,ai:false,enabled:true,lastStatus:'unknown'});
  r=await op('runners.report',{env:ENV,runner:'Jobs box',models,jobs:[{...rail,note:'Only on weekdays.'}]});
  assert.deepEqual([r.body.changed,r.body.runner.timezone,r.body.runner.jobs[0].note],[true,'America/Phoenix','Only on weekdays.'],'a new note is saved; the zone stays');
  for(const [bad,why] of [[{timezone:'x'.repeat(65)},'timezone up to 64'],[{origin:'moon'},'origin is repo, platform or machine'],[{triggers:[{kind:'hourly'}]},'trigger kinds'],
    [{triggers:Array.from({length:11},()=>({kind:'cron'}))},'up to 10 triggers'],[{triggers:[{kind:'cron',expr:'x'.repeat(201)}]},'expr up to 200'],[{note:'n'.repeat(501)},'note up to 500'],
    [{drift:'d'.repeat(201)},'drift up to 200'],[{file:'f'.repeat(201)},'file up to 200']])
    assert.equal((await op('runners.report',{env:ENV,runner:'Jobs box',models,jobs:[{...rail,...bad}]})).status,400,why);
  r=await op('runners.report',{env:ENV,runner:'Jobs box',models,jobs:[backup(),jobs[1],jobs[2]]});assert.equal(r.status,200);

  // Agents: schedule, the job link, and automations.
  r=await op('agents.create',{env:ENV,name:'Nightly backup',kind:'automation',live:true,schedule:'Daily 22:30',job:{runner:'Jobs box',id:'systemd:backup.timer'}});
  assert.equal(r.status,201);const auto=r.body.agent;
  assert.deepEqual([auto.kind,auto.live,auto.schedule,auto.job],['automation',false,'Daily 22:30',{runner:'Jobs box',id:'systemd:backup.timer'}],'automations are never live');
  r=await op('agents.get',{env:ENV,agent:auto.id});
  assert.match(r.body.brief,/^# Nightly backup\n\nAutomation · Draft\n/);
  assert.match(r.body.brief,/- Schedule: Daily 22:30\n- Promoted from: Jobs box · Nightly backup \(restic backup \/srv\)/);
  r=await op('agents.update',{env:ENV,agent:auto.id,job:null,schedule:''});
  assert.deepEqual(['job' in r.body.agent,r.body.agent.schedule],[false,''],'null clears the link');
  r=await op('agents.update',{env:ENV,agent:auto.id,job:{runner:'Jobs box',id:'claude:triage'},kind:'agent',schedule:'Weekdays 08:00'});
  assert.deepEqual([r.body.agent.kind,r.body.agent.job.id,r.body.agent.schedule],['agent','claude:triage','Weekdays 08:00']);
  r=await op('agents.update',{env:ENV,agent:auto.id,job:''});assert.equal('job' in r.body.agent,false,'"" clears it too');
  assert.equal((await op('agents.update',{env:ENV,agent:auto.id,job:{runner:'Jobs box'}})).status,400,'a link needs a runner and an id');
  assert.equal((await op('agents.update',{env:ENV,agent:auto.id,schedule:'x'.repeat(201)})).status,400,'schedule is up to 200 characters');
  assert.deepEqual((await op('agents.list',{env:ENV,kind:'automation'})).body.items.map(a=>a.name),[]);
  await op('agents.delete',{env:ENV,agent:auto.id});
  r=await op('runners.report',{env:ENV,runner:'Jobs box',models,jobs:[]});
  assert.deepEqual([r.body.changed,r.body.runner.jobs],[true,[]],'[] clears the jobs');

  // A runner reporting another machine (over SSH) sends jobs alone: models are kept.
  r=await op('runners.report',{env:ENV,runner:'Jobs box',jobs:[backup()]});
  assert.deepEqual([r.status,r.body.changed,r.body.runner.models.map(m=>m.id),r.body.runner.jobs.length],[200,true,[models[0].id],1],'models left out are kept');
  r=await op('runners.report',{env:ENV,runner:'Laptop',jobs:[{id:'windows:\\Backup',source:'windows'},{id:'codex:brief',source:'codex',ai:true}]});
  assert.deepEqual([r.status,r.body.runner.name,r.body.runner.models,r.body.runner.jobs.map(j=>j.source)],[200,'Laptop',[],['windows','codex']],'a new runner with jobs only');
  r=await op('runners.report',{env:ENV,runner:'Laptop'});
  assert.deepEqual([r.status,r.body.changed,r.body.runner.jobs.length],[200,false,2],'neither: nothing changes');
});

test('AgentFlow: delegating cards to agents and the work queue a runner reads',async()=>{
  const bot=(await op('agents.create',{env:ENV,name:'Runner bot'})).body.agent;
  let r=await op('cards.create',{env:ENV,title:'Queue me',column:'requests',due:'2026-11-20',agents:['Runner bot']});
  assert.deepEqual(r.body.card.agents,[bot.id]);const later=r.body.card.number;
  const sooner=(await op('cards.create',{env:ENV,title:'Do me first',column:'requests',due:'2026-11-10',agents:[bot.id]})).body.card.number;
  r=await op('cards.update',{env:ENV,card:1,agents:['Runner bot','Researcher']});
  assert.equal(r.body.card.agents.length,2);assert.ok(r.body.card.agents.includes(bot.id));
  assert.equal((await op('cards.update',{env:ENV,card:1,agents:['Nobody']})).body.code,'unknown_agent');
  r=await op('agents.work',{env:ENV,agent:'Runner bot'});
  assert.deepEqual(r.body.items.map(c=>c.number),[1,sooner,later],'work in progress first, then by due date');
  assert.equal(r.body.agent.id,bot.id);assert.match(r.body.brief,/^# Runner bot/);
  r=await op('agents.work',{env:ENV,agent:bot.id,columns:['requests']});
  assert.deepEqual(r.body.items.map(c=>c.number),[sooner,later]);
  r=await op('cards.list',{env:ENV,agent:'Runner bot'});
  assert.deepEqual(r.body.items.map(c=>c.number).sort((x,y)=>x-y),[1,later,sooner].sort((x,y)=>x-y));
  await op('cards.update',{env:ENV,card:later,agents:[]});
  r=await op('agents.work',{env:ENV,agent:'Runner bot',limit:1});
  assert.deepEqual([r.body.items.map(c=>c.number),!!r.body.nextCursor],[[1],true],'the queue pages like other lists');
  assert.equal((await op('agents.work',{env:ENV,agent:'Nobody'})).body.code,'unknown_agent');
  // Query arrays: repeated keys, a comma list, and what the CLI (requestFor) and the docs' curl lines send all agree.
  const want=(await op('agents.work',{env:ENV,agent:'Runner bot',columns:['doing','requests']})).body.items.map(c=>c.number);
  assert.deepEqual(want,[1,sooner]);
  const path=`/api/v1/envs/${ENV}/agents/${encodeURIComponent('Runner bot')}/work`;
  assert.deepEqual((await call('GET',path+'?columns=doing&columns=requests')).body.items.map(c=>c.number),want,'repeated keys');
  const {requestFor}=await import('../lib/api-spec.mjs'),{restCall}=await import('../tools/docs.mjs');
  const rq=requestFor(getOperation('agents.work'),{env:ENV,agent:'Runner bot',columns:['doing','requests']});
  assert.deepEqual((await call('GET',rq.path+rq.query)).body.items.map(c=>c.number),want,'the CLI request');
  const curl=restCall(getOperation('agents.work'),{env:ENV,agent:'Runner bot',columns:['doing','requests']}),url=/"\$FLOW_URL([^"]+)"/.exec(curl)[1];
  assert.deepEqual((await call('GET',url)).body.items.map(c=>c.number),want,'the docs curl line');
});

test('AgentFlow: a full workspace refuses new agents and workflows instead of dropping them',async()=>{
  const w=await store.get(ENV),now='2026-10-30T00:00:00.000Z';
  w.data.agentflow.agents=Array.from({length:500},(_,i)=>({id:'cap'+i,name:'Cap '+i,created:now,updated:now}));
  w.data.agentflow.workflows=Array.from({length:500},(_,i)=>({id:'wcap'+i,name:'W '+i,created:now,updated:now}));
  assert.ok((await store.put(ENV,{baseRev:w.rev,data:w.data,by:OWNER.email,owner:OWNER.email,name:w.name})).ok);
  let r=await op('agents.create',{env:ENV,name:'One too many'});
  assert.deepEqual([r.status,r.body.code],[409,'too_many_agents']);
  r=await op('workflows.create',{env:ENV,name:'One too many'});
  assert.deepEqual([r.status,r.body.code],[409,'too_many_workflows']);
  assert.equal((await store.get(ENV)).data.agentflow.agents.length,500);
});

test('every operation was exercised over HTTP',()=>{
  assert.deepEqual(operations.map(o=>o.id).filter(id=>!called.has(id)),[]);
});

test('pagination: limit and cursor',async()=>{
  for(let i=0;i<5;i++)await op('cards.create',{env:ENV,title:'Page '+i,column:'nice'});
  const seen=[];let cursor;
  do{const r=await op('cards.list',{env:ENV,column:'nice',limit:2,...(cursor?{cursor}:{})});assert.ok(r.body.items.length<=2);seen.push(...r.body.items.map(c=>c.title));cursor=r.body.nextCursor}while(cursor);
  assert.deepEqual(seen,['Page 0','Page 1','Page 2','Page 3','Page 4']);
  assert.equal((await op('cards.list',{env:ENV,cursor:'!!'})).body.code,'bad_cursor');
  assert.equal((await op('cards.list',{env:ENV,limit:500})).body.code,'invalid_input');
});

test('access: keys, scopes, sessions and other people\'s environments',async()=>{
  let r=await call('GET','/api/v1/envs',{key:null});
  assert.deepEqual([r.status,r.body.code],[401,'unauthorized']);assert.equal(r.headers.get('www-authenticate'),'Bearer');
  r=await call('GET','/api/v1/envs',{key:'flow_wrong'});assert.deepEqual([r.status,r.body.code],[401,'invalid_token']);
  r=await call('GET','/api/v1/envs',{key:'flow_wrong',headers:{cookie:'session=owner'}});assert.equal(r.status,401,'a bad key never falls back to the session');
  r=await call('GET','/api/v1/envs',{key:null,headers:{cookie:'session=owner'}});assert.equal(r.status,200,'the browser session works without a key');
  r=await op('nodes.create',{env:ENV,chart:'c1',type:'note',name:'x'},{key:'flow_ro'});assert.deepEqual([r.status,r.body.code],[403,'insufficient_scope']);
  assert.equal((await op('cards.list',{env:ENV},{key:'flow_ro'})).status,200);
  // Bob cannot see Owner's environment, and Owner cannot see Bob's private one: both are 404.
  assert.equal((await op('envs.get',{env:ENV},{key:'flow_bob'})).status,404);
  assert.equal((await op('cards.list',{env:'bob-env'})).status,404);
  assert.equal((await op('cards.create',{env:'bob-env',title:'x'})).status,404);
  // A public environment is readable but not writable.
  assert.equal((await op('cards.list',{env:'bob-public'})).status,200);
  assert.equal((await op('cards.create',{env:'bob-public',title:'x'})).status,404);
  assert.equal((await op('envs.get',{env:'no-such-env'})).status,404);
  await store.archive('bob-env');assert.equal((await op('envs.get',{env:'bob-env'},{key:'flow_bob'})).status,404,'archived');
});

test('HTTP details: errors, JSON only, routing, rate limit',async()=>{
  let r=await call('POST',`/api/v1/envs/${ENV}/cards`,{body:'title=x',headers:{'content-type':'application/x-www-form-urlencoded'}});
  assert.deepEqual([r.status,r.body.code],[415,'unsupported_media_type']);
  r=await call('POST',`/api/v1/envs/${ENV}/cards`,{body:'{nope'});assert.deepEqual([r.status,r.body.code],[400,'invalid_json']);
  r=await call('POST',`/api/v1/envs/${ENV}/cards`,{body:'[1]'});assert.equal(r.body.code,'invalid_input');
  r=await call('POST',`/api/v1/envs/${ENV}/cards`,{body:{title:'x',bogus:1}});assert.equal(r.status,400);assert.match(r.body.error,/bogus/);assert.ok(r.body.details.length);
  r=await call('POST',`/api/v1/envs/${ENV}/cards`,{body:'x'.repeat(1.1*(1<<20))});assert.equal(r.status,413);
  r=await call('PUT',`/api/v1/envs/${ENV}/cards`);assert.deepEqual([r.status,r.body.code],[405,'method_not_allowed']);assert.match(r.headers.get('allow'),/GET/);
  r=await call('GET','/api/v1/nope');assert.deepEqual([r.status,r.body.code],[404,'not_found']);
  r=await call('GET',`/api/v1/envs/${ENV}/cards/`);assert.equal(r.status,200,'a trailing slash is fine');
  assert.equal(r.headers.get('content-type'),'application/json; charset=utf-8');
  r=await call('GET','/api/elsewhere');assert.equal(r.status,418,'other paths are left to the caller');
  r=await call('GET','/api/v1x');assert.equal(r.status,418);
  const codes=[];for(let i=0;i<5;i++)codes.push((await call('GET','/api/v1/envs',{key:'flow_limited'})).status);
  assert.deepEqual(codes,[200,200,200,429,429]);
  r=await call('GET','/api/v1/envs',{key:'flow_limited'});assert.equal(r.body.code,'rate_limited');assert.ok(Number(r.headers.get('retry-after'))>=1);
});

test('writes are revision-checked: a concurrent save is merged, not overwritten',async()=>{
  const real=store.put.bind(store);let raced=false;
  store.put=async(id,args)=>{
    if(!raced){raced=true;const w=await store.get(id);await real(id,{baseRev:w.rev,data:{...w.data,projects:[...w.data.projects,{id:'p-race',name:'Raced',color:'#7cb980',entity:''}]},by:'someone',owner:w.owner,visibility:w.visibility,name:w.name})}
    return real(id,args);
  };
  try{
    const before=(await store.get(ENV)).rev;
    const r=await op('labels.create',{env:ENV,name:'After race'});
    assert.equal(r.status,201);assert.equal(r.body.rev,before+2);
    const d=(await store.get(ENV)).data;
    assert.ok(d.projects.some(p=>p.id==='p-race'),'the other save is kept');
    assert.ok(d.devops.labels.some(l=>l.name==='After race'),'and this change is applied on top');
  }finally{store.put=real}
  // Name and visibility are kept on API writes.
  const w=await store.get('bob-public');
  await invoke('labels.create',{env:'bob-public',name:'Z'},{user:BOB,store,envCheck:envCheckFor(store)});
  assert.equal((await store.get('bob-public')).visibility,'public');assert.equal((await store.get('bob-public')).name,w.name);
});

test('invoke() works without HTTP (MCP / CLI path)',async()=>{
  const ctx={user:OWNER,store,envCheck:envCheckFor(store)};
  const r=await invoke('cards.get',{env:ENV,card:1},ctx);assert.equal(r.card.number,1);
  await assert.rejects(invoke('cards.get',{env:ENV},ctx),e=>e.status===400&&e.code==='invalid_input');
  await assert.rejects(invoke('nope',{},ctx),e=>e.status===404&&e.code==='unknown_operation');
  await assert.rejects(invoke('envs.list',{},{...ctx,user:null}),e=>e.status===401);
  await assert.rejects(invoke('envs.get',{env:ENV},{...ctx,envCheck:async()=>false}),e=>e.status===404);
  const lim=await invoke('envs.list',{},ctx);assert.equal(lim.nextCursor,null,'defaults (limit) are applied');
});

test('OpenAPI 3.1 document from the registry',async()=>{
  const r=await call('GET','/api/v1/openapi.json',{key:null});
  assert.equal(r.status,200,'public, no key needed');
  const doc=r.body;
  assert.equal(doc.openapi,'3.1.0');assert.equal(doc.servers[0].url,base);
  assert.equal(doc.components.securitySchemes.bearer.scheme,'bearer');
  const ops=Object.entries(doc.paths).flatMap(([p,m])=>Object.entries(m).map(([k,v])=>({path:p,method:k.toUpperCase(),...v})));
  assert.deepEqual(ops.map(o=>o.operationId).sort(),operations.map(o=>o.id).sort());
  for(const o of operations){
    const d=ops.find(x=>x.operationId===o.id);
    assert.equal(d.path,o.path);assert.equal(d.method,o.method);assert.equal(d['x-scope'],o.scope);assert.equal(d.description,o.description);
    const names=(o.path.match(/\{(\w+)\}/g)||[]).map(s=>s.slice(1,-1));
    assert.deepEqual(d.parameters.filter(p=>p.in==='path').map(p=>p.name),names);
    if(o.method==='POST'||o.method==='PATCH'){
      const s=d.requestBody.content['application/json'].schema;
      for(const n of names)assert.ok(!(n in s.properties),`${o.id}: path parameter ${n} is not in the body`);
      assert.ok(Object.keys(d.requestBody.content['application/json'].examples).length);
    }else assert.equal(d.requestBody,undefined);
    const ok=d.responses['200']||d.responses['201'];assert.deepEqual(ok.content['application/json'].schema,o.output);
  }
  assert.deepEqual(openapi().paths,doc.paths,'same document without HTTP');
  assert.equal((await call('POST','/api/v1/openapi.json',{key:null,body:{}})).status,405);
});

test('apiV1 drives any registry (fixture)',async()=>{
  const seen=[];
  const fixture={
    operations:[
      {id:'things.get',method:'GET',path:'/api/v1/things/{thing}',scope:'read',tags:['things'],summary:'Get',description:'Get a thing by id.',input:{type:'object',properties:{thing:{type:'string'},n:{type:'integer'},on:{type:'boolean'}},required:['thing'],additionalProperties:false},output:{type:'object'},examples:[{title:'x',input:{thing:'a'},output:{}}]},
      {id:'things.create',method:'POST',path:'/api/v1/things',scope:'admin',tags:['things'],summary:'Create',description:'Create a thing.',input:{type:'object'},output:{type:'object'},examples:[{title:'x',input:{},output:{}}]},
      {id:'things.boom',method:'DELETE',path:'/api/v1/things/{thing}',scope:'write',tags:['things'],summary:'Boom',description:'Throws.',input:{type:'object'},output:{type:'object'},examples:[{title:'x',input:{},output:{}}]},
    ],
    async invoke(id,input,ctx){
      seen.push({id,input,user:ctx.user.email,hasStore:!!ctx.store});
      if(id==='things.boom')throw input.thing==='teapot'?{status:418,code:'teapot',message:'I am a teapot'}:new Error('secret internals');
      return {ok:id};
    },
  };
  const s=http.createServer(async(req,res)=>{if(!await apiV1(req,res,{authenticate:async r=>KEYS[r.headers.authorization?.slice(7)]||null,store:{},envCheck:()=>true,registry:fixture})){res.writeHead(418);res.end()}});
  await new Promise(ok=>s.listen(0,'127.0.0.1',ok));
  const b=`http://127.0.0.1:${s.address().port}`,f=(m,p,body,key='flow_rw')=>fetch(b+p,{method:m,headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:body&&JSON.stringify(body)}).then(async r=>({status:r.status,body:await r.json()}));
  const orig=console.error;console.error=()=>{};
  try{
    let r=await f('GET','/api/v1/things/a%20b?n=3&on=true');
    assert.equal(r.status,200);assert.deepEqual(seen.at(-1),{id:'things.get',input:{thing:'a b',n:3,on:true},user:OWNER.email,hasStore:true});
    r=await f('POST','/api/v1/things',{x:1});assert.equal(r.status,403,'admin scope needed');
    r=await f('DELETE','/api/v1/things/teapot');assert.deepEqual([r.status,r.body],[418,{error:'I am a teapot',code:'teapot'}]);
    r=await f('DELETE','/api/v1/things/other');assert.deepEqual([r.status,r.body],[500,{error:'Something went wrong',code:'internal'}],'internal errors are not leaked');
    r=await f('GET','/api/v1/openapi.json');assert.deepEqual(Object.keys(r.body.paths).sort(),['/api/v1/things','/api/v1/things/{thing}']);
    assert.deepEqual(r.body.paths['/api/v1/things/{thing}'].get.parameters.map(p=>[p.name,p.in]),[['thing','path'],['n','query'],['on','query']]);
  }finally{console.error=orig;s.close()}
});
