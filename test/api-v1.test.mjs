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
import {officeState} from '../lib/office.mjs';
import {shareStore} from '../lib/shares.mjs';
import {shareServices} from '../lib/share-service.mjs';
import {allows as keyAllows} from '../lib/apikeys.mjs';

const OWNER={id:'u-owner',email:'owner@example.test'},BOB={id:'u-bob',email:'bob@example.com'};
// flow_agent: a real-shaped API key of the owner's (user.key, as server.mjs apiAuth makes it), named like a connector.
const AGENT_KEY={user:OWNER,envs:['test-env'],scopes:['read','write'],name:'Laptop agent'},AGENT_RO={user:OWNER,envs:['test-env'],scopes:['read'],name:'Read-only agent'};
const KEYS={flow_agent:{user:{...OWNER,id:'key:a',key:AGENT_KEY},scopes:AGENT_KEY.scopes},flow_agent_ro:{user:{...OWNER,id:'key:r',key:AGENT_RO},scopes:AGENT_RO.scopes},flow_rw:{user:OWNER,scopes:['read','write']},flow_ro:{user:OWNER,scopes:['read']},flow_bob:{user:BOB,scopes:['read','write']},flow_limited:{user:{id:'u-lim',email:'lim@example.com'},scopes:['read']}};
const ENV='test-env';
const seed=()=>({active:'c1',charts:[{id:'c1',name:'Brainstorm',nodes:[
  {id:'flygon',name:'Kestrel Group',type:'entity',x:400,y:0,notes:''},{id:'cleo',name:'Cleo Park',type:'person',x:320,y:144,notes:'Engineer'},
  {id:'bo',name:'Bo Marsh',type:'person',x:656,y:144},{id:'quill',name:'Quill Solutions',type:'entity',x:320,y:320}],
  edges:[{id:'g1',from:'flygon',to:'quill',type:'group',percent:''}]}],
  projects:[{id:'p1',name:'Lantern',color:'#7cb980',entity:'flygon'}],
  timeline:[{id:'i1',title:'Public beta',kind:'release',status:'planned',start:'2026-12-01',end:'',projects:['p1']}],
  environment:{id:ENV,name:'Test',ownerEmail:OWNER.email,visibility:'private',members:[]}});

let dir,store,server,base,sharing;
const office=officeState();
// Share additions (server.mjs keeps them with the share store): one pending proposal of the owner's, decided once.
const PROP={id:'prop-1',shareId:'share-1',env:ENV,proposedBy:'kim@example.test',status:'pending',role:'owner',createdAt:'2026-11-22T00:00:00.000Z',updatedAt:'2026-11-22T00:00:00.000Z',decidedAt:null,decidedBy:null,
  preview:[{kind:'card',id:'k9',title:'Kim idea'}],records:{node:[],edge:[],project:[],item:[],card:[{id:'k9',title:'Kim idea'}]}};
let propState='pending';
const proposals={list:async(env,user,{status})=>env===ENV&&user.email===OWNER.email&&status===propState?[{...PROP,status:propState}]:[],
  decide:async(id,user,approve,env)=>id!==PROP.id||env!==ENV||user.email!==OWNER.email?{status:404,body:{error:'Not found',code:'proposal_not_found'}}
    :propState!=='pending'?{status:409,body:{error:'Already decided',code:'proposal_decided'}}:(propState=approve?'approved':'denied',{status:200,body:{proposal:{...PROP,status:propState,decidedAt:'2026-11-22T01:00:00.000Z',decidedBy:OWNER.email}}})};
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
  sharing=shareServices({shares:shareStore({dir}),workspaces:store});
  await store.put(ENV,{baseRev:0,data:seed(),by:OWNER.email,owner:OWNER.email,name:'Test'});
  await store.put('bob-env',{baseRev:0,data:{...seed(),environment:{id:'bob-env',name:'Bob',ownerEmail:BOB.email,visibility:'private',members:[]}},by:BOB.email,owner:BOB.email,name:'Bob'});
  await store.put('bob-public',{baseRev:0,data:{...seed(),environment:{id:'bob-public',name:'Bob public',ownerEmail:BOB.email,visibility:'public',members:[]}},by:BOB.email,owner:BOB.email,name:'Bob public',visibility:'public'});
  const limit=memoryRateLimit({perMinute:3});
  limiter=({req,user,operation})=>user.email==='lim@example.com'?limit({req,user,operation}):{ok:true};
  server=http.createServer(async(req,res)=>{
    if(await apiV1(req,res,{authenticate:async r=>KEYS[/^Bearer\s+(\S+)$/.exec(r.headers.authorization||'')?.[1]]||null,userFor:async r=>r.headers.cookie==='session=owner'?OWNER:null,store,envCheck:envCheckFor(store),rateLimit:limiter,office,proposals,sharing:u=>sharing.forUser(u,keyAllows)}))return;
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
    assert.ok(['GET','POST','PATCH','PUT','DELETE'].includes(o.method),`${o.id}: method`);
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
  const want=['envs.list','envs.get','charts.list','nodes.list','nodes.get','nodes.create','nodes.update','nodes.move','edges.list','edges.create','edges.update','edges.delete',
    'projects.list','projects.create','projects.update','items.list','items.get','items.create','items.update','cards.list','cards.get','cards.create','cards.update','cards.move','cards.deleted','cards.restore','labels.list','labels.create','search',
    'agents.list','agents.get','agents.work','agents.create','agents.update','agents.delete','runners.list','runners.report','workflows.list','workflows.get','workflows.create','workflows.update','office.agents.report','office.agents.list','office.live.report','office.actions.wait','office.actions.result','proposals.list','proposals.approve','proposals.deny',
    'shares.list','shares.preview','shares.create','shares.update','shares.revoke','shares.incoming','shares.requests.list','shares.requests.create','shares.requests.decide'];
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
  const projects=[{id:'p',name:'P'.repeat(100),color:'#zzz'},{id:'q',name:'Q',color:'#AABBCC',entity:5},{name:'none'},null,{id:'r',name:'R',repos:['acme/flow',' flow ','acme/flow',7,'',...Array(30).fill(0).map((_,i)=>'r'+i)]},{id:'s',name:'S',repos:'flow'}];
  projects.forEach((p,i)=>assert.deepEqual(cleaners.cleanProject(p,i),orig.cleanProject(p,i)));
  const ps=[{id:'p'}],items=[{id:'i',title:'T',start:'2026-01-02',end:'2026-01-01',kind:'nope',status:'done',projects:['p','p','zz'],priority:'high',inbox:{at:'x',sig:'s'}},
    {id:'j',title:'U',start:'',end:'2026-01-01'},{id:'k',title:'V',start:'bad'},{id:'l',title:'W',start:'2026-02-01',end:'2026-03-01',owner:7,notes:null}];
  for(const it of items)assert.deepEqual(cleaners.cleanItem(it,ps),orig.cleanItem(it,ps));
  const nodes=[{id:'a',type:'person',image:'https://example.test/a.png',email:' A@Example.TEST '},{id:'b',type:'entity',image:'https://example.test/b.png',email:'b@example.test'},
    {id:'c',type:'person',image:'data:image/png;base64,'+'A'.repeat(cleaners.PERSON_IMAGE_MAX),email:'nope'},{id:'d',type:'person',image:'javascript:alert(1)',email:7},
    {id:'e',type:'person',opidUser:'u-e',opidLinked:true},{id:'f',type:'person',opidUser:'bad id',opidLinked:'yes'},{id:'g',type:'entity',opidUser:'u-g',opidLinked:true}];
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

test('edges: list, create, update, delete',async()=>{
  let r=await op('edges.create',{env:ENV,chart:'c1',from:'cleo',to:'quill',percent:50});
  assert.equal(r.status,201);assert.equal(r.body.edge.percent,'50');const id=r.body.edge.id;
  assert.equal((await op('edges.create',{env:ENV,chart:'c1',from:'cleo',to:'quill'})).status,409);
  assert.equal((await op('edges.create',{env:ENV,chart:'c1',from:'cleo',to:'cleo'})).body.code,'invalid_edge');
  assert.equal((await op('edges.create',{env:ENV,chart:'c1',from:'bo',to:'quill',percent:'120'})).body.code,'invalid_percent');
  assert.equal((await op('edges.create',{env:ENV,chart:'c1',from:'bo',to:'ghost'})).status,404);
  r=await op('edges.list',{env:ENV,chart:'c1',node:'cleo'});
  assert.deepEqual(r.body.items.map(e=>e.id),[id]);
  r=await op('edges.update',{env:ENV,chart:'c1',edge:id,percent:'100'});
  assert.equal(r.status,200);assert.equal(r.body.edge.percent,'100');assert.equal(r.body.edge.from,'cleo');
  assert.equal((await op('edges.update',{env:ENV,chart:'c1',edge:id,percent:101})).body.code,'invalid_percent');
  assert.equal((await op('edges.update',{env:ENV,chart:'c1',edge:'ghost',percent:'1'})).status,404);
  r=await op('edges.update',{env:ENV,chart:'c1',edge:id,type:'group'});
  assert.equal(r.body.edge.type,'group');assert.equal(r.body.edge.percent,'','a group edge carries no percent');
  r=await op('edges.update',{env:ENV,chart:'c1',edge:id,type:'ownership',percent:''});
  assert.equal(r.body.edge.type,'ownership');assert.equal(r.body.edge.percent,'');
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
  {const second=(await op('cards.create',{env:ENV,title:'Second',column:'must',actual:2})).body.card;assert.deepEqual([second.number,second.points,second.actual],[2,null,2])}
  r=await op('cards.get',{env:ENV,card:'#1'});assert.equal(r.body.card.id,c.id);
  r=await op('cards.get',{env:ENV,card:c.id});assert.equal(r.body.card.number,1);
  assert.equal((await op('cards.get',{env:ENV,card:99})).body.code,'card_not_found');
  r=await op('cards.update',{env:ENV,card:1,title:'Build the sign-up form',checklist:[{...c.checklist[0],done:true}],points:null});
  assert.deepEqual([r.body.card.title,r.body.card.checklist[0].done,r.body.card.points],['Build the sign-up form',true,null]);
  // actual (points the work took) is its own field: setting one never changes the other.
  assert.equal(c.actual,null,'actual defaults to null');
  r=await op('cards.update',{env:ENV,card:1,points:3});
  r=await op('cards.update',{env:ENV,card:1,actual:8});
  assert.deepEqual([r.body.card.points,r.body.card.actual],[3,8]);
  r=await op('cards.update',{env:ENV,card:1,points:5});
  assert.deepEqual([r.body.card.points,r.body.card.actual],[5,8]);
  assert.equal((await op('cards.get',{env:ENV,card:1})).body.card.actual,8);
  assert.equal((await op('cards.list',{env:ENV})).body.items.find(x=>x.number===1).actual,8);
  assert.equal((await op('cards.update',{env:ENV,card:1,actual:1001})).body.code,'invalid_input');
  r=await op('cards.update',{env:ENV,card:1,actual:null,points:null});
  assert.deepEqual([r.body.card.points,r.body.card.actual],[null,null]);
  assert.equal((await op('cards.update',{env:ENV,card:1,column:'done'})).body.code,'invalid_input','the column only moves through cards.move');
  // Snooze: an ISO time snoozes the card for everyone; "" or null wakes it; a broken time is refused.
  assert.equal((await op('cards.get',{env:ENV,card:1})).body.card.snoozedUntil,null,'null when awake');
  const until=new Date(Date.now()+864e5).toISOString().replace('.000Z','Z');
  r=await op('cards.update',{env:ENV,card:1,snoozedUntil:until});
  assert.equal(r.body.card.snoozedUntil,new Date(until).toISOString());
  assert.equal((await op('cards.get',{env:ENV,card:1})).body.card.snoozedUntil,new Date(until).toISOString(),'stored');
  assert.deepEqual((await op('cards.list',{env:ENV,snoozed:true})).body.items.map(x=>x.number),[1]);
  assert.ok(!(await op('cards.list',{env:ENV,snoozed:false})).body.items.some(x=>x.number===1));
  assert.equal((await op('cards.update',{env:ENV,card:1,snoozedUntil:'next tuesday'})).body.code,'invalid_snooze');
  r=await op('cards.update',{env:ENV,card:1,snoozedUntil:''});assert.equal(r.body.card.snoozedUntil,null);
  await op('cards.update',{env:ENV,card:1,snoozedUntil:until});
  r=await op('cards.update',{env:ENV,card:1,snoozedUntil:null});assert.equal(r.body.card.snoozedUntil,null);
  r=await op('cards.update',{env:ENV,card:1,snoozedUntil:new Date(Date.now()-6e4).toISOString()});assert.equal(r.body.card.snoozedUntil,null,'a past time wakes it');

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
  r=await op('cards.list',{env:ENV,assignee:'none'});
  assert.deepEqual(r.body.items.map(x=>x.number),[2]);
  r=await op('cards.list',{env:ENV,label:'Frontend'});
  assert.deepEqual(r.body.items.map(x=>x.number),[1]);
  // Exclude is the opposite of include, and the two combine.
  r=await op('cards.list',{env:ENV,notAssignee:'cleo'});
  assert.deepEqual(r.body.items.map(x=>x.number),[2]);
  r=await op('cards.list',{env:ENV,notAssignee:'none'});
  assert.deepEqual(r.body.items.map(x=>x.number),[1]);
  r=await op('cards.list',{env:ENV,project:'Lantern',notAssignee:'Bo Marsh'});
  assert.deepEqual(r.body.items.map(x=>x.number),[]);
  r=await op('cards.list',{env:ENV,notProject:'none'});
  assert.deepEqual(r.body.items.map(x=>x.number),[1]);
  r=await op('cards.list',{env:ENV,notLabel:'Frontend'});
  assert.deepEqual(r.body.items.map(x=>x.number),[2]);
  r=await op('cards.list',{env:ENV,notEntity:'Kestrel Group'});
  assert.deepEqual(r.body.items.map(x=>x.number),[2]);
  assert.equal((await op('cards.list',{env:ENV,notAssignee:'nobody'})).body.code,'unknown_person');
  assert.equal((await op('cards.list',{env:ENV,notEntity:'nope'})).body.code,'unknown_entity');
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
  // Snoozed: out of the queue (and its pages) until it wakes, still delegated; includeSnoozed keeps it.
  await op('cards.update',{env:ENV,card:1,snoozedUntil:new Date(Date.now()+36e5).toISOString()});
  r=await op('agents.work',{env:ENV,agent:'Runner bot'});
  assert.deepEqual([r.body.items.map(c=>c.number),r.body.nextCursor],[[sooner],null],'a snoozed card leaves the queue');
  assert.deepEqual((await op('agents.work',{env:ENV,agent:'Runner bot',limit:1})).body.items.map(c=>c.number),[sooner],'and is not the next card');
  r=await op('agents.work',{env:ENV,agent:'Runner bot',includeSnoozed:true});
  assert.deepEqual(r.body.items.map(c=>c.number),[1,sooner],'includeSnoozed keeps it');
  assert.equal(r.body.items[0].agents.includes(bot.id),true,'still delegated');
  assert.deepEqual((await call('GET',`/api/v1/envs/${ENV}/agents/${bot.id}/work?includeSnoozed=true`)).body.items.map(c=>c.number),[1,sooner],'includeSnoozed in a query string');
  await op('cards.update',{env:ENV,card:1,snoozedUntil:null});
  assert.deepEqual((await op('agents.work',{env:ENV,agent:'Runner bot'})).body.items.map(c=>c.number),[1,sooner],'awake again: back in the queue');
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

test('deleted cards: an agent creates a card, a stale snapshot drops it, and it is listed and restored with its number',async()=>{
  // A browser holds a snapshot of the workspace (an undo step) from before the agent's card.
  const snap=structuredClone((await store.get(ENV)).data);
  const made=await op('cards.create',{env:ENV,title:'Made by an agent',description:'Original payload',checklist:[{text:'Step one'}]});
  assert.equal(made.status,201);const num=made.body.card.number;
  // A stale save from an older revision is refused (409 in the browser path; here the store reports it).
  const old=(await store.get(ENV)).rev-1;
  assert.equal((await store.put(ENV,{baseRev:old,data:snap,by:OWNER.email,source:{via:'undo'}})).conflict,true);
  assert.equal((await op('cards.deleted',{env:ENV,q:'#'+num})).body.items.length,0,'a refused save records nothing');
  // Sent from the current revision it passes the check and drops the card: recorded, not lost.
  const w=await store.get(ENV);
  const put=await store.put(ENV,{baseRev:w.rev,data:snap,by:OWNER.email,owner:w.owner,name:w.name,source:{via:'undo'}});
  assert.ok(put.ok);assert.equal(put.deleted.length,1);
  assert.ok(!((await store.get(ENV)).data.devops?.cards||[]).some(c=>c.number===num),'the card is gone from the board');
  assert.equal((await op('cards.get',{env:ENV,card:num})).status,404);
  const list=await op('cards.deleted',{env:ENV,pending:true});
  assert.equal(list.status,200);
  const e=list.body.items.find(x=>x.number===num);
  assert.ok(e,'listed under recently deleted');
  assert.equal(e.via,'undo');assert.equal(e.deletedBy,OWNER.email);assert.equal(e.env,ENV);
  assert.equal(e.fromRev,w.rev);assert.equal(e.rev,w.rev+1);assert.equal(e.restoredAt,null);
  assert.equal(e.card.description,'Original payload');assert.equal(e.card.checklist[0].text,'Step one');
  assert.equal((await op('cards.deleted',{env:ENV,q:'made by'})).body.items[0].id,e.id,'title search');
  // Restore by number: same id and number, back on the board.
  const r=await op('cards.restore',{env:ENV,entry:'#'+num});
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(r.body.card.id,made.body.card.id);assert.equal(r.body.card.number,num);assert.equal(r.body.renumbered,false);assert.equal(r.body.message,`Restored #${num}.`);
  assert.equal((await op('cards.get',{env:ENV,card:num})).body.card.description,'Original payload');
  // Twice is refused; the entry says what it became.
  const again=await op('cards.restore',{env:ENV,entry:e.id});
  assert.equal(again.status,409);assert.equal(again.body.code,'already_restored');
  const done=(await op('cards.deleted',{env:ENV})).body.items.find(x=>x.id===e.id);
  assert.ok(done.restoredAt);assert.equal(done.restoredNumber,num);assert.equal(done.restoredBy,OWNER.email);
  assert.ok(!(await op('cards.deleted',{env:ENV,pending:true})).body.items.some(x=>x.id===e.id),'pending leaves restored ones out');
  assert.equal((await op('cards.restore',{env:ENV,entry:'del_nope'})).body.code,'deleted_card_not_found');
  // Read-only keys may list but not restore.
  assert.equal((await op('cards.deleted',{env:ENV},{key:'flow_ro'})).status,200);
  assert.equal((await op('cards.restore',{env:ENV,entry:e.id},{key:'flow_ro'})).status,403);
  assert.equal((await op('cards.deleted',{env:'bob-env'})).status,404,"someone else's environment");
});

test('deleted cards: a restored card whose number was taken gets the next number and says so',async()=>{
  const a=(await op('cards.create',{env:ENV,title:'Will be deleted'})).body.card;
  // Remove it with a plain save, then (as before the numbers fix) another card takes its number.
  let w=await store.get(ENV);
  const d=structuredClone(w.data);d.devops.cards=d.devops.cards.filter(c=>c.id!==a.id);
  d.devops.cards.push({...d.devops.cards[0],id:'k-reused',number:a.number,title:'Reused number'});
  assert.ok((await store.put(ENV,{baseRev:w.rev,data:d,by:OWNER.email,owner:w.owner,name:w.name})).ok);
  const e=(await op('cards.deleted',{env:ENV,q:'#'+a.number})).body.items.find(x=>x.cardId===a.id);
  assert.equal(e.via,'save','no source given');
  const r=await op('cards.restore',{env:ENV,entry:a.id});
  assert.equal(r.status,200);assert.equal(r.body.renumbered,true);assert.equal(r.body.previousNumber,a.number);
  assert.ok(r.body.card.number>a.number);assert.match(r.body.message,new RegExp(`Restored as #${r.body.card.number}: #${a.number} is now another card`));
  const cards=(await store.get(ENV)).data.devops.cards;
  assert.equal(cards.filter(c=>c.number===a.number).length,1,'numbers stay unique');
  assert.equal((await op('cards.create',{env:ENV,title:'After'})).body.card.number,r.body.card.number+1,'the next number moves on');
});

test('deleted cards: API and MCP writes name the key; agent links come back on restore',async()=>{
  const ctx={user:{...OWNER,key:{name:'Runner key'}},store,envCheck:envCheckFor(store),via:'mcp'};
  // An earlier test fills the workspace with agents: use one that has room for another card.
  const ag={agent:(await invoke('agents.list',{env:ENV,limit:200},ctx)).items.find(a=>a.cards.length<50)};assert.ok(ag.agent);
  const c=(await invoke('cards.create',{env:ENV,title:'Delegated',agents:[ag.agent.id]},ctx)).card;
  // An API write that drops a card (the registry has no card delete; a workspace-level change stands in).
  let w=await store.get(ENV);const d=structuredClone(w.data);d.devops.cards=d.devops.cards.filter(x=>x.id!==c.id);
  for(const a of d.agentflow.agents)a.cards=a.cards.filter(x=>x!==c.id);
  await store.put(ENV,{baseRev:w.rev,data:d,by:OWNER.email,owner:w.owner,name:w.name,source:{via:'mcp',actor:'Runner key'}});
  const e=(await invoke('cards.deleted',{env:ENV,q:'Delegated'},ctx)).items[0];
  assert.equal(e.via,'mcp');assert.equal(e.actor,'Runner key');assert.deepEqual(e.card.agents,[ag.agent.id]);
  const r=await invoke('cards.restore',{env:ENV,entry:e.id},ctx);
  assert.deepEqual(r.card.agents,[ag.agent.id],'delegated to the agent again');
  // The registry's own writes pass ctx.via and the key name on to the store.
  const real=store.put.bind(store);let seen=null;store.put=async(id,args)=>{seen=args.source;return real(id,args)};
  try{await invoke('cards.update',{env:ENV,card:r.card.number,description:'x'},ctx)}finally{store.put=real}
  assert.deepEqual(seen,{via:'mcp',actor:'Runner key'});
});

test('projects carry repos; the office operations report agents, long-poll answers and take results',async()=>{
  let r=await op('projects.update',{env:ENV,project:'Lantern',repos:['acme/lantern','https://github.com/acme/lantern-site.git']});
  assert.equal(r.status,200);assert.deepEqual(r.body.project.repos,['acme/lantern','https://github.com/acme/lantern-site.git']);
  r=await op('projects.create',{env:ENV,name:'Repo project',repos:['flow']});assert.deepEqual(r.body.project.repos,['flow']);
  r=await op('projects.update',{env:ENV,project:'Repo project',repos:[]});assert.equal(r.body.project.repos,undefined,'[] clears them');
  const agent={id:'t3:a',title:'Fix login',vendor:'anthropic',model:'Opus 5.5',status:'waiting',activity:'x'.repeat(900),repo:{name:'lantern',remote:'https://user:secret@github.com/acme/lantern.git'},
    pending:{requestId:'req-1',kind:'approval',summary:'Run: npm test',can:['allow','deny']}};
  r=await op('office.agents.report',{source:'bridge:test',agents:[agent]});
  assert.equal(r.status,200);assert.deepEqual(r.body,{actions:[],accepted:1});
  r=await op('office.agents.list',{});
  const got=r.body.agents[0];assert.equal(got.vendor,'claude');assert.equal(got.activity.length,300);assert.ok(!JSON.stringify(got).includes('secret'),'credentials in a remote are dropped');
  assert.equal((await op('office.agents.report',{source:'bridge:test',agents:[agent]},{key:'flow_ro'})).status,403,'reporting needs write');
  assert.equal((await op('office.agents.report',{agents:[]})).body.code,'invalid_input');
  // Bob cannot answer the owner's agent; the owner can, once.
  assert.throws(()=>office.answer({by:BOB.email,owner:OWNER.email,source:'bridge:test',agentId:'t3:a',requestId:'req-1',decision:'allow'}),{code:'not_owner'});
  assert.throws(()=>office.answer({by:OWNER.email,owner:OWNER.email,source:'bridge:test',agentId:'t3:a',requestId:'req-0',decision:'allow'}),{code:'not_waiting'});
  const waiting=op('office.actions.wait',{source:'bridge:test',wait:5});
  await new Promise(ok=>setTimeout(ok,50));
  const a=office.answer({by:OWNER.email,owner:OWNER.email,source:'bridge:test',agentId:'t3:a',requestId:'req-1',decision:'allow'});
  r=await waiting;assert.equal(r.status,200);assert.deepEqual(r.body.actions.map(x=>[x.id,x.decision,x.requestId]),[[a.id,'allow','req-1']]);
  assert.deepEqual((await op('office.actions.wait',{source:'bridge:test'})).body.actions,[],'delivered once');
  assert.equal((await op('office.actions.result',{id:a.id,ok:true,message:'Approved'},{key:'flow_bob'})).status,404,'only the owner reports a result');
  r=await op('office.actions.result',{id:a.id,ok:true,message:'Approved'});assert.equal(r.body.action.result.message,'Approved');
  assert.equal((await op('office.actions.wait',{source:'bridge:test',wait:31})).body.code,'invalid_input');
  // Live steps between reports, the thread index, and a history page carried back as a result's data.
  const running={...agent,id:'t3:b',status:'running',pending:null,can:['message','history']};
  r=await op('office.agents.report',{source:'bridge:test',agents:[running],threads:{items:[{id:'t3:b',title:'Fix login',project:'Lantern',state:'working'},{id:'t3:idle',title:'Plan',state:'done'}],counts:{snoozed:1,settled:4},can:['message','history']}});
  assert.equal(r.status,200);
  r=await op('office.live.report',{source:'bridge:test',agents:[{id:'t3:b',live:{phase:'tool',text:'Run: npm test',steps:[{kind:'tool',text:'Run: npm test'}]}}]});
  assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body,{accepted:1});
  r=await op('office.agents.list',{});
  assert.equal(r.body.agents[0].live.text,'Run: npm test');assert.deepEqual(r.body.threads.map(t=>[t.source,t.items.length,t.counts.settled]),[['bridge:test',2,4]]);
  assert.equal((await op('office.live.report',{source:'bridge:test',agents:[]},{key:'flow_ro'})).status,403,'streaming needs write');
  const h=office.history({by:OWNER.email,owner:OWNER.email,source:'bridge:test',agentId:'t3:idle'});
  assert.equal((await op('office.actions.wait',{source:'bridge:test'})).body.actions[0].kind,'history');
  r=await op('office.actions.result',{id:h.id,ok:true,message:'1 item',data:{items:[{role:'user',text:'Plan the launch'}],before:null,more:false}});
  assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.action.kind,'history');assert.equal(r.body.action.data,undefined);
});

test('share additions: owners list, approve and deny proposals; others cannot',async()=>{
  let r=await op('proposals.list',{env:ENV});assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body.items.map(p=>p.id),['prop-1']);
  assert.equal((await op('proposals.list',{env:ENV},{key:'flow_bob'})).status,404,"Bob cannot read the owner's environment");
  assert.equal((await op('proposals.approve',{env:ENV,proposal:'prop-1'},{key:'flow_ro'})).status,403,'a read key cannot decide');
  assert.equal((await op('proposals.approve',{env:ENV,proposal:'nope'})).body.code,'proposal_not_found');
  r=await op('proposals.approve',{env:ENV,proposal:'prop-1'});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.proposal.status,'approved');
  r=await op('proposals.deny',{env:ENV,proposal:'prop-1'});assert.equal(r.status,409);assert.equal(r.body.code,'proposal_decided');
  assert.deepEqual((await op('proposals.list',{env:ENV,status:'approved'})).body.items.map(p=>p.status),['approved']);
});

test('sharing: preview first, confirm to share, names resolve, owner only, re-share requests and revoke',async()=>{
  const A={key:'flow_agent'},share={env:ENV,recipientEmail:BOB.email,scope:{kind:'project',project:'lantern'},permission:'edit'};
  // Without confirm: the preview, and nothing is stored.
  let r=await op('shares.create',share,A);
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.deepEqual([r.body.created,r.body.confirmed,r.body.existing,r.body.share.id],[false,false,false,null]);
  assert.deepEqual(r.body.preview.projects.map(p=>p.name),['Lantern']);assert.equal(r.body.label,'Project Lantern');
  assert.deepEqual((await op('shares.list',{env:ENV},A)).body.shares,[],'a preview stores nothing');
  r=await op('shares.preview',{env:ENV,scope:{kind:'person',node:'kestrel group'}},A);
  assert.equal(r.status,200);assert.deepEqual(r.body.preview.nodes.map(n=>n.name).sort(),['Kestrel Group','Quill Solutions']);
  assert.equal((await op('shares.preview',{env:ENV,scope:{kind:'nodes',nodes:['Cleo Park','bo'],chart:'Brainstorm'}},A)).body.preview.summary.nodes,2);
  assert.equal((await op('shares.preview',{env:ENV,scope:{kind:'project',project:'Nope'}},A)).body.code,'unknown_project');
  assert.equal((await op('shares.preview',{env:ENV,scope:{kind:'project'}},A)).body.code,'invalid_scope');
  // A read-only key previews and lists but cannot share, change or revoke.
  const RO={key:'flow_agent_ro'};
  assert.equal((await op('shares.preview',{env:ENV,scope:{kind:'environment'}},RO)).status,200);
  r=await op('shares.create',{...share,confirm:true},RO);assert.deepEqual([r.status,r.body.code],[403,'insufficient_scope']);
  // The registry checks a key's scopes too (MCP calls it without /api/v1's check).
  await assert.rejects(invoke('shares.create',{...share,confirm:true},{user:KEYS.flow_agent_ro.user,store,envCheck:envCheckFor(store),sharing:sharing.forUser(KEYS.flow_agent_ro.user,keyAllows)}),{status:403,code:'insufficient_scope'});
  // confirm: true shares it, with the key's name; the same again changes nothing.
  r=await op('shares.create',{...share,confirm:true},A);
  assert.equal(r.status,201,JSON.stringify(r.body));
  const s=r.body.share;assert.deepEqual([r.body.created,s.actor,s.createdBy,s.recipientEmail,s.permission],[true,'Laptop agent',OWNER.email,BOB.email,'edit']);
  assert.deepEqual(s.scope,{kind:'project',projectId:'p1'});
  r=await op('shares.create',{...share,confirm:true},A);assert.deepEqual([r.status,r.body.created,r.body.existing,r.body.share.id],[200,false,true,s.id]);
  assert.deepEqual((await op('shares.list',{env:ENV},RO)).body.shares.map(x=>x.id),[s.id]);
  assert.equal((await op('shares.update',{share:s.id,permission:'view'},RO)).status,403);
  assert.equal((await op('shares.revoke',{share:s.id},RO)).status,403);
  // Nobody else can see or share the owner's environment.
  assert.equal((await op('shares.list',{env:ENV},{key:'flow_bob'})).status,404);
  assert.equal((await op('shares.create',{...share,recipientEmail:'kim@example.com',confirm:true},{key:'flow_bob'})).status,404);
  assert.equal((await op('shares.update',{share:s.id,permission:'view'},{key:'flow_bob'})).status,404);
  // Bob sees it and asks the owner to share it with Kim; the owner approves at view, by key.
  r=await op('shares.incoming',{},{key:'flow_bob'});assert.deepEqual(r.body.shares.map(x=>[x.id,x.ownerEmail,x.ownerEnvName]),[[s.id,OWNER.email,'Test']]);
  assert.deepEqual((await op('shares.incoming',{},A)).body.shares,[]);
  assert.equal((await op('shares.requests.create',{share:s.id,toEmail:OWNER.email},{key:'flow_bob'})).body.code,'invalid_toEmail');
  assert.equal((await op('shares.requests.create',{share:s.id,toEmail:'kim@example.com'},A)).status,404,'the owner is not a recipient');
  r=await op('shares.requests.create',{share:s.id,toEmail:'kim@example.com',note:'Kim helps'},{key:'flow_bob'});
  assert.equal(r.status,201,JSON.stringify(r.body));const rq=r.body.request;assert.deepEqual([rq.status,rq.permission],['pending','edit']);
  assert.deepEqual((await op('shares.requests.list',{},A)).body.requests.map(x=>x.id),[rq.id]);
  assert.deepEqual((await op('shares.requests.list',{},{key:'flow_bob'})).body.mine.map(x=>x.id),[rq.id]);
  assert.deepEqual((await op('shares.list',{env:ENV},A)).body.requests.map(x=>x.id),[rq.id]);
  assert.equal((await op('shares.requests.decide',{request:rq.id,approve:true},{key:'flow_bob'})).status,404);
  assert.equal((await op('shares.requests.decide',{request:rq.id,approve:true},RO)).status,403);
  r=await op('shares.requests.decide',{request:rq.id,approve:true,permission:'view'},A);
  assert.equal(r.status,200,JSON.stringify(r.body));
  assert.deepEqual([r.body.request.status,r.body.share.recipientEmail,r.body.share.permission,r.body.share.via,r.body.share.actor],['approved','kim@example.com','view',rq.id,'Laptop agent']);
  assert.equal((await op('shares.requests.decide',{request:rq.id,approve:false},A)).body.code,'already_decided');
  // Change and revoke.
  assert.equal((await op('shares.update',{share:s.id,adds:'approve'},A)).body.share.adds,'approve','an edit share can let them add');
  assert.equal((await op('shares.update',{share:s.id},A)).body.code,'invalid_input');
  r=await op('shares.update',{share:s.id,permission:'comment'},A);assert.deepEqual([r.body.share.permission,r.body.share.adds],['comment','off'],'a comment share adds nothing');
  r=await op('shares.revoke',{share:s.id},A);assert.ok(r.body.revoked&&r.body.share.revokedAt);
  assert.equal((await op('shares.update',{share:s.id,permission:'edit'},A)).body.code,'share_revoked');
  assert.deepEqual((await op('shares.incoming',{},{key:'flow_bob'})).body.shares,[]);
  await op('shares.revoke',{share:r.body.share.id},A);
  for(const x of (await op('shares.list',{env:ENV},A)).body.shares)await op('shares.revoke',{share:x.id},A);
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

test('20 parallel creates and a concurrent edit all persist, each with its own number',async()=>{
  const first=await op('cards.create',{env:ENV,title:'Edited meanwhile'});assert.equal(first.status,201);
  // The file store answers at once; a pause makes these reads overlap the way Postgres reads do.
  const get=store.get.bind(store);store.get=async id=>{const w=await get(id);await new Promise(r=>setTimeout(r,2));return w};
  try{
  const creates=Array.from({length:20},(_,i)=>op('cards.create',{env:ENV,title:`Parallel ${i}`}));
  const edit=op('cards.update',{env:ENV,card:first.body.card.number,description:'Kept'});
  const out=await Promise.all(creates);
  assert.equal((await edit).status,200);
  assert.deepEqual(out.map(r=>r.status),Array(20).fill(201));
  const cards=(await store.get(ENV)).data.devops.cards;
  for(const r of out)assert.ok(cards.some(c=>c.id===r.body.card.id),`${r.body.card.title} is saved`);
  assert.equal(cards.find(c=>c.id===first.body.card.id).description,'Kept');
  assert.equal(new Set(out.map(r=>r.body.card.number)).size,20,'no number is handed out twice');
  }finally{store.get=get}
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
    if(o.method==='POST'||o.method==='PATCH'||o.method==='PUT'){
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
