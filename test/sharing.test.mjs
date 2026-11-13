// Flow sharing core + storage. Run: node --test test/
// Fictional fixture for testing scoped sharing.
//   Bo -> Marsh -> Campfire Studio -> Campfire Studio Ads
//   Kestrel Group groups Marsh and Kestrel Services
//   Cleo owns 50% of Quill; Quill owns 50% of Campfire Studio and all of Quill Labs; Cleo also owns Cedar Ventures
import {test,describe,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveScope,projectForRecipient,applyProjection,applyRecipientEdit,applyOwnerPatch,revokeEffects,extractRecipientChanges,
  createShare,requestReshare,decideRequest,linkedId,parseLinkedId,walkDown,validScope,linkedShareIds,
  shareMembers,memberId,historyForRecipient,ownerChanges,overwritten,conflictView} from '../lib/sharing-core.mjs';
import {fieldBase,clashes,withHeld} from '../public/sync-core.js';
import {shareStore,SCHEMA,migrate} from '../lib/shares.mjs';

const OWNER='owner@example.test',BO='bo@example.test',KIM='kim@example.test';
const N=(id,name,type='entity',x=0,y=0)=>({id,name,type,x,y});
const owner=()=>({
  active:'c1',environment:{id:'default-workspace',name:"Default workspace",ownerEmail:OWNER,visibility:'private',members:[]},
  charts:[{id:'c1',name:'Flygon',nodes:[
    N('bo','Bo Marsh','person',656,144),N('marsh','Marsh Holdings LLC','entity',656,320),N('campaign','Campfire Studio','entity',496,544),N('ads','Campfire Studio Ads','area',496,700),
    N('flygon','Kestrel Group','entity',400,0),N('fms','Kestrel Services','entity',900,0),
    N('cleo','Cleo Park','person',320,144),N('quill','Quill Ventures LLC','entity',320,320),N('labs','Quill Labs','entity',100,500),N('cedar','Cedar Ventures','entity',100,144),
    {...N('memo','Private memo','note',0,900),notes:'Owner only'},
  ],edges:[
    {id:'o-bo',from:'bo',to:'marsh',type:'ownership',percent:''},
    {id:'o-marsh',from:'marsh',to:'campaign',type:'ownership',percent:'50'},
    {id:'g-ads',from:'campaign',to:'ads',type:'group',percent:''},
    {id:'g-marsh',from:'flygon',to:'marsh',type:'group',percent:''},
    {id:'g-fms',from:'flygon',to:'fms',type:'group',percent:''},
    {id:'o-sun',from:'quill',to:'campaign',type:'ownership',percent:'50'},
    {id:'o-cleo',from:'cleo',to:'quill',type:'ownership',percent:'50'},
    {id:'o-labs',from:'quill',to:'labs',type:'ownership',percent:'100'},
    {id:'o-delg',from:'cleo',to:'cedar',type:'ownership',percent:'100'},
  ]}],
  projects:[{id:'p-marsh',name:'Marsh ops',color:'#7cb980',entity:'marsh'},{id:'p-cb',name:'Studio launch',color:'#a8524c',entity:'campaign'},
    {id:'p-fms',name:'Service retainer',color:'#3d6fb6',entity:'fms'},{id:'p-sun',name:'Quill books',color:'#b0662f',entity:'quill'},{id:'p-free',name:'Loose',color:'#5b6b7a',entity:''}],
  timeline:[
    {id:'i-cb',title:'Launch',kind:'release',status:'planned',start:'2026-12-01',end:'',priority:'',release:'',projects:['p-cb'],owner:'',link:'',notes:''},
    {id:'i-mix',title:'Joint review',kind:'milestone',status:'planned',start:'2026-11-01',end:'',priority:'',projects:['p-marsh','p-fms'],owner:'',link:'',notes:'',release:'Service invoice'},
    {id:'i-fms',title:'Service invoice',kind:'deadline',status:'planned',start:'2026-11-15',end:'',priority:'',release:'',projects:['p-fms'],owner:'',link:'',notes:''},
    {id:'i-sun',title:'Quill audit',kind:'event',status:'planned',start:'2026-11-20',end:'',priority:'',release:'',projects:['p-sun'],owner:'',link:'',notes:''},
  ],
  devops:{columns:[],nextNumber:5,labels:[{id:'l-high',name:'High',section:'priority',color:'orange'},{id:'l-mkt',name:'Marketing',section:'area',color:'green'}],cards:[
    {id:'k-cb',number:1,title:'Ad copy',description:'',column:'requests',project:'p-cb',labels:['l-high'],points:2,due:'',assignees:[{node:'bo',role:'developer'},{node:'cleo',role:'tester'}],checklist:[],links:[],item:'i-cb',created:'2026-10-01T00:00:00.000Z',updated:'2026-10-01T00:00:00.000Z',moved:'2026-10-01T00:00:00.000Z'},
    {id:'k-marsh',number:2,title:'File taxes',description:'',column:'doing',project:'p-marsh',labels:[],points:null,due:'',assignees:[],checklist:[],links:[],item:'',created:'2026-10-01T00:00:00.000Z',updated:'2026-10-01T00:00:00.000Z',moved:'2026-10-01T00:00:00.000Z'},
    {id:'k-fms',number:3,title:'FMS deck',description:'',column:'requests',project:'p-fms',labels:['l-mkt'],points:null,due:'',assignees:[],checklist:[],links:[],item:'i-fms',created:'2026-10-01T00:00:00.000Z',updated:'2026-10-01T00:00:00.000Z',moved:'2026-10-01T00:00:00.000Z'},
    {id:'k-free',number:4,title:'Loose card',description:'',column:'nice',project:'',labels:['l-mkt'],points:null,due:'',assignees:[],checklist:[],links:[],item:'',created:'2026-10-01T00:00:00.000Z',updated:'2026-10-01T00:00:00.000Z',moved:'2026-10-01T00:00:00.000Z'},
  ]},
});
// Bo's own environment, with a private node and a private edge he will draw to a shared node.
const recipient=()=>({active:'j1',environment:{id:'bo-env',name:"Bo's",ownerEmail:BO,visibility:'private',members:[]},
  charts:[{id:'j1',name:'Mine',nodes:[N('bo-own','Bo Side LLC','entity',0,0),N('flygon','Bo’s unrelated node with a colliding id')],edges:[]}],projects:[],timeline:[],
  devops:{columns:[],cards:[],nextNumber:1,labels:[]}});
const env={id:'default-workspace',ownerEmail:OWNER};
const share=(scope,permission='edit')=>{const r=createShare(env,{email:OWNER},{recipientEmail:BO,scope,permission});assert.ok(r.ok,r.error);return r.share};
const sorted=a=>[...a].sort();

describe('scope',()=>{
  test("Bo's person scope walks down: Marsh, Campfire Studio (and below), never above or beside",()=>{
    const sc=resolveScope(owner(),share({kind:'person',nodeId:'bo'}));
    assert.deepEqual(sorted(sc.nodeIds),['ads','bo','campaign','marsh']);
    for(const id of ['fms','cleo','cedar','labs','flygon','quill','memo'])assert.ok(!sc.nodeIds.includes(id),id+' must not be in scope');
    assert.deepEqual(sorted(sc.edgeIds),['g-ads','o-bo','o-marsh']);
  });
  test('co-owner stubs: Kestrel Group on Marsh and Quill on Campfire Studio, nothing of theirs',()=>{
    const sc=resolveScope(owner(),share({kind:'person',nodeId:'bo'}));
    assert.deepEqual(sc.stubs.map(({nodeId,name,ownsNodeId,type,percent})=>({nodeId,name,ownsNodeId,type,percent})).sort((a,b)=>a.nodeId.localeCompare(b.nodeId)),[
      {nodeId:'flygon',name:'Kestrel Group',ownsNodeId:'marsh',type:'group',percent:''},
      {nodeId:'quill',name:'Quill Ventures LLC',ownsNodeId:'campaign',type:'ownership',percent:'50'},
    ]);
    const p=projectForRecipient(owner(),share({kind:'person',nodeId:'bo'}));
    const names=p.nodes.map(n=>n.name);
    for(const n of ['Kestrel Services','Cleo Park','Quill Labs','Cedar Ventures','Private memo'])assert.ok(!names.includes(n),n+' must not cross');
    assert.ok(!p.edges.some(e=>['g-fms','o-cleo','o-labs','o-delg'].includes(parseLinkedId(e.id).id)),'no stub-owner edges to their other children');
    const stubs=p.nodes.filter(n=>n.linked.stub).map(n=>n.name).sort();
    assert.deepEqual(stubs,['Kestrel Group','Quill Ventures LLC']);
    assert.ok(p.nodes.filter(n=>n.linked.stub).every(n=>n.notes===undefined),'stubs carry only name and type');
  });
  test('projects, items and cards follow the scope',()=>{
    const sc=resolveScope(owner(),share({kind:'person',nodeId:'bo'}));
    assert.deepEqual(sorted(sc.projectIds),['p-cb','p-marsh']);
    assert.deepEqual(sorted(sc.itemIds),['i-cb','i-mix']);
    assert.deepEqual(sorted(sc.cardIds),['k-cb','k-marsh']);
    const p=projectForRecipient(owner(),share({kind:'person',nodeId:'bo'}));
    const mix=p.timeline.find(i=>parseLinkedId(i.id).id==='i-mix');
    assert.equal(mix.projects.length,1,'out-of-scope project tags are stripped from a shared item');
    assert.equal(mix.release,'','a release outside the scope is not named');
    assert.equal(p.timeline.find(i=>parseLinkedId(i.id).id==='i-cb').release,'');
    const card=p.cards.find(c=>parseLinkedId(c.id).id==='k-cb');
    assert.deepEqual(card.assignees.map(a=>parseLinkedId(a.node).id),['bo'],'assignees outside the scope (Cleo) are dropped');
    assert.equal(parseLinkedId(card.project).id,'p-cb');assert.equal(parseLinkedId(card.item).id,'i-cb');
    assert.deepEqual(p.labels.map(l=>parseLinkedId(l.id).id),['l-high']);
  });
  test('person photos cross a share; person emails never do',()=>{
    const png='data:image/png;base64,iVBORw0KGgo=',o=owner();
    Object.assign(o.charts[0].nodes.find(n=>n.id==='bo'),{image:png,email:'bo.private@example.test'});
    Object.assign(o.charts[0].nodes.find(n=>n.id==='cleo'),{image:'https://example.test/cleo.jpg',email:'cleo.private@example.test'});
    o.charts[0].nodes.find(n=>n.id==='marsh').image='javascript:alert(1)';
    for(const scope of [{kind:'environment'},{kind:'person',nodeId:'bo'},{kind:'nodes',nodeIds:['bo','cleo']}]){
      const s=share(scope),p=projectForRecipient(o,s),db=applyProjection(recipient(),p),text=JSON.stringify([p,db]);
      assert.ok(!text.includes('private@example.test'),`${scope.kind}: no email in the projection or the recipient's workspace`);
      assert.ok(p.nodes.every(n=>!('email' in n)),scope.kind);
      assert.equal(p.nodes.find(n=>parseLinkedId(n.id).id==='bo').image,png,`${scope.kind}: the photo comes along`);
      assert.equal(p.nodes.find(n=>parseLinkedId(n.id).id==='marsh')?.image,undefined,'only valid photos on person cards');
      // A recipient adding an email to their copy sends nothing back.
      const sent=structuredClone(db);for(const n of sent.charts.flatMap(c=>c.nodes))if(n.id===linkedId(s.id,'bo'))n.email='guess@example.test';
      assert.deepEqual(extractRecipientChanges(p,sent).edits,[]);
    }
  });
  test('other scope kinds: environment, project, label, hand-picked nodes',()=>{
    const db=owner();
    const all=resolveScope(db,share({kind:'environment'}));
    assert.equal(all.nodeIds.length,11);assert.equal(all.stubs.length,0);assert.equal(all.cardIds.length,4);
    const pr=resolveScope(db,share({kind:'project',projectId:'p-fms'}));
    assert.deepEqual(pr.nodeIds,[]);assert.deepEqual(sorted(pr.itemIds),['i-fms','i-mix']);assert.deepEqual(pr.cardIds,['k-fms']);
    const lb=resolveScope(db,share({kind:'label',label:'l-mkt'}));
    assert.deepEqual(sorted(lb.cardIds),['k-fms','k-free']);assert.deepEqual(lb.itemIds,['i-fms']);assert.deepEqual(lb.projectIds,[]);
    const picked=resolveScope(db,share({kind:'nodes',nodeIds:['campaign','missing']}));
    assert.deepEqual(picked.nodeIds,['campaign']);assert.deepEqual(sorted(picked.stubs.map(s=>s.nodeId)),['marsh','quill']);
    assert.ok(!picked.nodeIds.includes('ads'),'hand-picked nodes do not walk');
    db.charts[0].edges.push({id:'loop',from:'ads',to:'bo',type:'group',percent:''});
    assert.deepEqual(sorted(walkDown(db.charts[0].edges,'bo')),['ads','bo','campaign','marsh'],'cycles terminate');
    assert.ok(!validScope({kind:'person'})&&!validScope({kind:'nope'})&&validScope({kind:'environment'}));
  });
  test('the scope is live: a new child under Campfire Studio appears, a moved one disappears',()=>{
    const db=owner(),s=share({kind:'person',nodeId:'bo'});
    db.charts[0].nodes.push(N('new','New Sub'));db.charts[0].edges.push({id:'o-new',from:'campaign',to:'new',type:'ownership',percent:'10'});
    assert.ok(resolveScope(db,s).nodeIds.includes('new'));
    db.charts[0].edges=db.charts[0].edges.filter(e=>e.id!=='o-marsh');
    assert.ok(!resolveScope(db,s).nodeIds.includes('campaign'));
  });
});

describe('recipient view',()=>{
  test('the projection merges into the recipient env under linked ids, with per-env placement',()=>{
    const s=share({kind:'person',nodeId:'bo'});
    const p=projectForRecipient(owner(),s,[{recordId:'marsh',chartId:'j1',x:40,y:50,w:200,h:60}]);
    const db=applyProjection(recipient(),p);
    const mine=db.charts.find(c=>c.id==='j1'),shared=db.charts.find(c=>c.id===linkedId(s.id,'chart'));
    assert.ok(mine.nodes.some(n=>n.id==='flygon'&&n.name.startsWith('Bo')),'a colliding private id is untouched');
    const marsh=mine.nodes.find(n=>n.id===linkedId(s.id,'marsh'));
    assert.deepEqual([marsh.x,marsh.y,marsh.w,marsh.h],[40,50,200,60]);
    assert.ok(shared.nodes.some(n=>n.id===linkedId(s.id,'campaign')&&n.x===496));
    assert.equal(db.projects.length,2);assert.equal(db.timeline.length,2);assert.equal(db.devops.cards.length,2);
    // Re-applying is idempotent.
    assert.deepEqual(applyProjection(db,p),db);
  });
  test('layout changes become placements; field changes become edits; private data stays',()=>{
    const s=share({kind:'person',nodeId:'bo'}),p=projectForRecipient(owner(),s),db=applyProjection(recipient(),p);
    const c=db.charts.find(x=>x.id===linkedId(s.id,'chart'));
    c.nodes.find(n=>n.id===linkedId(s.id,'campaign')).x=999;
    c.nodes.find(n=>n.id===linkedId(s.id,'marsh')).name='Marsh Holdings';
    c.nodes.find(n=>n.id===linkedId(s.id,'flygon')).name='Hacked stub';
    db.devops.cards.find(x=>x.id===linkedId(s.id,'k-cb')).column='doing';
    const ch=extractRecipientChanges(p,db);
    assert.deepEqual(ch.placements.map(x=>[x.recordId,x.x]),[['campaign',999]]);
    assert.deepEqual(ch.edits,[{kind:'node',id:'marsh',fields:{name:'Marsh Holdings'}},{kind:'card',id:'k-cb',fields:{column:'doing'}}]);
  });
});

describe('edits',()=>{
  const bo={email:BO};
  test('permissions: view refuses everything, comment allows comments only, edit allows fields',()=>{
    const db=owner();
    assert.equal(applyRecipientEdit(db,share({kind:'person',nodeId:'bo'},'view'),{kind:'node',id:'marsh',fields:{name:'X'}},bo).error,'permission');
    assert.equal(applyRecipientEdit(db,share({kind:'person',nodeId:'bo'},'view'),{kind:'node',id:'marsh',comment:'hi'},bo).error,'permission');
    const c=share({kind:'person',nodeId:'bo'},'comment');
    assert.equal(applyRecipientEdit(db,c,{kind:'card',id:'k-cb',fields:{title:'X'}},bo).error,'permission');
    const r=applyRecipientEdit(db,c,{kind:'card',id:linkedId(c.id,'k-cb'),comment:'Looks good'},bo);
    assert.ok(r.ok);assert.deepEqual(r.ownerDbPatch,[]);assert.equal(r.history[0].field,'comment');assert.equal(r.history[0].new,'Looks good');
    const e=share({kind:'person',nodeId:'bo'},'edit');
    const ok=applyRecipientEdit(db,e,{kind:'card',id:'k-cb',fields:{title:'Ad copy v2',column:'uat'}},bo);
    assert.ok(ok.ok);assert.equal(ok.ownerDbPatch.length,2);
    const next=applyOwnerPatch(db,ok.ownerDbPatch),card=next.devops.cards.find(x=>x.id==='k-cb');
    assert.equal(card.title,'Ad copy v2');assert.equal(card.column,'uat');assert.notEqual(card.moved,'2026-10-01T00:00:00.000Z');
    assert.equal(db.devops.cards[0].title,'Ad copy','the owner db passed in is not mutated');
  });
  test('stubs are immutable; out-of-scope and private records are refused',()=>{
    const db=owner(),s=share({kind:'person',nodeId:'bo'}),bo={email:BO};
    assert.equal(applyRecipientEdit(db,s,{kind:'node',id:'flygon',fields:{name:'X'}},bo).error,'stub');
    assert.equal(applyRecipientEdit(db,s,{kind:'node',id:linkedId(s.id,'quill'),comment:'x'},bo).error,'stub');
    assert.equal(applyRecipientEdit(db,s,{kind:'edge',id:'o-sun',fields:{percent:'99'}},bo).error,'stub');
    assert.equal(applyRecipientEdit(db,s,{kind:'node',id:'fms',fields:{name:'X'}},bo).error,'out-of-scope');
    assert.equal(applyRecipientEdit(db,s,{kind:'node',id:'memo',fields:{notes:'X'}},bo).error,'out-of-scope');
    assert.equal(applyRecipientEdit(db,s,{kind:'card',id:'k-fms',fields:{title:'X'}},bo).error,'out-of-scope');
    assert.equal(applyRecipientEdit(db,s,{kind:'item',id:'i-sun',fields:{title:'X'}},bo).error,'out-of-scope');
    assert.equal(applyRecipientEdit(db,s,{kind:'card',id:'sh.other-share.k-cb',fields:{title:'X'}},bo).error,'invalid','another share\'s linked id is not accepted');
    assert.equal(applyRecipientEdit(db,s,{kind:'node',id:'marsh',fields:{x:5}},bo).error,'invalid','layout is not a field edit');
    assert.equal(applyRecipientEdit(db,s,{kind:'card',id:'k-cb',fields:{labels:['l-nope']}},bo).error,'invalid');
    assert.equal(applyRecipientEdit(db,s,{kind:'item',id:'i-cb',fields:{end:'2026-01-01'}},bo).error,'invalid');
    assert.equal(applyRecipientEdit(db,s,{kind:'node',id:'marsh',fields:{name:'X'}},{email:KIM}).error,'forbidden');
    assert.ok(applyRecipientEdit(db,s,{kind:'edge',id:'o-marsh',fields:{percent:60}},bo).ok,'an in-scope edge percent can be edited');
  });
  test('per-field history: who, when, old, new; unchanged fields are skipped',()=>{
    const s=share({kind:'person',nodeId:'bo'}),r=applyRecipientEdit(owner(),s,{kind:'item',id:linkedId(s.id,'i-cb'),fields:{title:'Launch v2',status:'planned',notes:'n'}},{email:BO});
    assert.ok(r.ok);
    assert.deepEqual(r.history.map(({field,old,new:nw,by,kind,recordId,envId,shareId})=>({field,old,nw,by,kind,recordId,envId,shareId})),[
      {field:'title',old:'Launch',nw:'Launch v2',by:BO,kind:'item',recordId:'i-cb',envId:'default-workspace',shareId:s.id},
      {field:'notes',old:'',nw:'n',by:BO,kind:'item',recordId:'i-cb',envId:'default-workspace',shareId:s.id},
    ]);
    assert.ok(!Number.isNaN(Date.parse(r.history[0].at)));
  });
});

describe('revoke',()=>{
  test('shared records vanish with the recipient\'s private edges to them; private data stays',()=>{
    const s=share({kind:'person',nodeId:'bo'});
    let db=applyProjection(recipient(),projectForRecipient(owner(),s,[{recordId:'marsh',chartId:'j1',x:300,y:0}]));
    const j1=db.charts.find(c=>c.id==='j1');
    j1.edges.push({id:'mine-1',from:'bo-own',to:linkedId(s.id,'marsh'),type:'ownership',percent:'5'},{id:'mine-2',from:'bo-own',to:'flygon',type:'group',percent:''});
    db.devops.cards.push({id:'own-card',number:9,title:'Mine',project:linkedId(s.id,'p-marsh'),item:'',labels:[linkedId(s.id,'l-high')],assignees:[]});
    const {db:after,removed}=revokeEffects(db,{...s,revokedAt:new Date().toISOString()});
    assert.ok(removed.edges.includes('mine-1'));assert.ok(!removed.edges.includes('mine-2'));
    assert.ok(after.charts.every(c=>c.nodes.every(n=>!n.id.startsWith('sh.'))));
    assert.ok(!after.charts.some(c=>c.id===linkedId(s.id,'chart')),'the empty share chart goes too');
    assert.deepEqual(after.charts[0].nodes.map(n=>n.id),['bo-own','flygon']);
    assert.deepEqual(after.charts[0].edges.map(e=>e.id),['mine-2']);
    assert.equal(after.projects.length,0);assert.equal(after.timeline.length,0);
    assert.deepEqual(after.devops.cards.map(c=>[c.id,c.project,c.labels.length]),[['own-card','',0]]);
    assert.deepEqual(linkedShareIds(db),[s.id]);assert.deepEqual(linkedShareIds(after),[]);
    assert.equal(projectForRecipient(owner(),{...s,revokedAt:'2026-10-29T00:00:00.000Z'}),null);
    assert.equal(applyRecipientEdit(owner(),{...s,revokedAt:'2026-10-29T00:00:00.000Z'},{kind:'node',id:'marsh',fields:{name:'X'}},{email:BO}).error,'revoked');
  });
  test('a record leaving the scope disappears on the next projection, private edges to it too',()=>{
    const s=share({kind:'person',nodeId:'bo'}),o=owner();
    let db=applyProjection(recipient(),projectForRecipient(o,s,[{recordId:'campaign',chartId:'j1',x:0,y:200}]));
    db.charts[0].edges.push({id:'mine-c',from:'bo-own',to:linkedId(s.id,'campaign'),type:'group',percent:''},{id:'mine-j',from:'bo-own',to:linkedId(s.id,'marsh'),type:'group',percent:''});
    db=applyProjection(db,projectForRecipient(o,s,[{recordId:'campaign',chartId:'j1',x:0,y:200},{recordId:'marsh',chartId:'j1',x:0,y:300}]));
    assert.ok(db.charts[0].edges.some(e=>e.id==='mine-j'),'a private edge to a still-shared node survives a refresh');
    o.charts[0].edges=o.charts[0].edges.filter(e=>e.id!=='o-marsh');
    db=applyProjection(db,projectForRecipient(o,s));
    assert.ok(!db.charts.flatMap(c=>c.nodes).some(n=>n.id===linkedId(s.id,'campaign')));
    assert.ok(!db.charts[0].edges.some(e=>e.id==='mine-c'));
  });
});

describe('re-share requests',()=>{
  test('recipients cannot share; they request, and the owner approves or denies',()=>{
    const s=share({kind:'person',nodeId:'bo'},'comment');
    assert.equal(createShare({id:'default-workspace',ownerEmail:OWNER},{email:BO},{recipientEmail:KIM,scope:{kind:'environment'}}).error,'forbidden');
    assert.equal(requestReshare(s,{email:KIM},{toEmail:'x@example.test'}).error,'forbidden');
    assert.equal(requestReshare(s,{email:BO},{toEmail:KIM,permission:'edit'}).error,'invalid','cannot ask for more than they have');
    const {request}=requestReshare(s,{email:BO},{toEmail:KIM,note:'My accountant'});
    assert.equal(request.status,'pending');assert.equal(request.permission,'comment');
    assert.equal(decideRequest(request,s,{email:BO},true).error,'forbidden','the recipient cannot approve their own request');
    const denied=decideRequest(request,s,{email:OWNER},false);
    assert.equal(denied.request.status,'denied');assert.equal(denied.share,undefined);
    assert.equal(decideRequest(denied.request,s,{email:OWNER},true).error,'decided');
    const ok=decideRequest(request,s,{email:OWNER},true,{permission:'view'});
    assert.equal(ok.request.status,'approved');assert.equal(ok.share.recipientEmail,KIM);assert.equal(ok.share.permission,'view');
    assert.deepEqual(ok.share.scope,s.scope);assert.equal(ok.share.via,request.id);assert.equal(ok.request.newShareId,ok.share.id);
  });
});

// ---- storage: JSON files and an embedded Postgres --------------------------------------------------
async function storageChecks(store){
  const s=share({kind:'person',nodeId:'bo'},'comment');
  await store.create(s);
  assert.equal((await store.get(s.id)).recipientEmail,BO);
  assert.deepEqual((await store.get(s.id)).scope,{kind:'person',nodeId:'bo'});
  assert.equal((await store.list({recipientEmail:BO.toUpperCase()})).length,1);
  assert.equal((await store.list({ownerEnv:'default-workspace'})).length,1);
  assert.equal((await store.setPermission(s.id,'edit')).permission,'edit');
  const {request}=requestReshare(await store.get(s.id),{email:BO},{toEmail:KIM});
  await store.addRequest(request);
  assert.equal((await store.requests({ownerEmail:OWNER,status:'pending'})).length,1);
  const d=decideRequest(await store.getRequest(request.id),await store.get(s.id),{email:OWNER},true);
  await store.create(d.share);
  assert.equal((await store.decide(d.request)).status,'approved');
  assert.equal(await store.decide(d.request),null,'a decided request does not change again');
  assert.equal((await store.list({recipientEmail:KIM}))[0].via,request.id);
  await store.place(s.id,'bo-env',[{recordId:'marsh',chartId:'j1',x:1,y:2,w:3,h:4},{recordId:'campaign',chartId:'',x:5,y:6}]);
  await store.place(s.id,'bo-env',[{recordId:'marsh',chartId:'j1',x:10,y:20,w:30,h:40}]);
  await store.attach(s.id,'bo-env');await store.attach(s.id,'bo-env');await store.attach(s.id,'bo-env2');
  assert.deepEqual(await store.attachedTo('bo-env'),[s.id]);assert.deepEqual((await store.envsFor(s.id)).sort(),['bo-env','bo-env2']);
  await store.detach(s.id,'bo-env2');assert.deepEqual(await store.envsFor(s.id),['bo-env']);
  const pl=(await store.placements(s.id,'bo-env')).sort((a,b)=>a.recordId.localeCompare(b.recordId));
  assert.deepEqual(pl.map(p=>[p.recordId,p.chartId,p.x,p.y,p.w,p.h]),[['campaign','',5,6,undefined,undefined],['marsh','j1',10,20,30,40]]);
  const r=applyRecipientEdit(owner(),await store.get(s.id),{kind:'node',id:'marsh',fields:{name:'Marsh 2',notes:'x'}},{email:BO});
  await store.record(r.history);
  await store.record(applyRecipientEdit(owner(),await store.get(s.id),{kind:'node',id:'marsh',comment:'ok'},{email:BO}).history);
  const h=await store.history({envId:'default-workspace',kind:'node',recordId:'marsh'});
  assert.deepEqual(h.map(x=>[x.field,x.old,x.new,x.by]),[['comment',null,'ok',BO],['notes','','x',BO],['name','Marsh Holdings LLC','Marsh 2',BO]]);
  // A conflict: the person whose value an edit overwrote, found by email and time.
  await store.record([{shareId:s.id,envId:'default-workspace',kind:'node',recordId:'marsh',field:'name',old:'Marsh 2',new:'Marsh 3',by:OWNER,at:new Date().toISOString(),over:BO.toUpperCase(),clash:true}]);
  const lost=await store.history({envId:'default-workspace',over:BO,since:new Date(Date.now()-60000).toISOString()});
  assert.deepEqual(lost.map(x=>[x.field,x.old,x.new,x.by,x.over]),[['name','Marsh 2','Marsh 3',OWNER,BO]]);
  assert.equal(lost[0].clash,undefined,'the clash flag is not stored');
  assert.equal((await store.history({over:BO,since:new Date(Date.now()+60000).toISOString()})).length,0);
  assert.equal((await store.history({over:OWNER})).length,0);
  assert.equal(h.find(x=>x.field==='name').over,undefined,'ordinary entries have no over');
  await store.revoke(s.id);
  assert.ok((await store.get(s.id)).revokedAt);
  assert.equal((await store.list({recipientEmail:BO})).length,0);
  assert.equal((await store.list({recipientEmail:BO,includeRevoked:true})).length,1);
  assert.deepEqual(await store.placements(s.id,'bo-env'),[]);
  assert.deepEqual(await store.attachedTo('bo-env'),[],'a revoked share is detached everywhere');
  assert.equal((await store.history({shareId:s.id})).length,4,'history outlives the revoke');
}

describe('members (card #63): owner and recipients can be assigned to shared cards',()=>{
  // Owner has a person card with their email, outside Bo's scope; Kim got the same records by re-share.
  const withMe=()=>{const d=owner();d.charts[0].nodes.push({...N('me','Owner Person','person',900,900),email:OWNER});return d};
  test('members: the owner and the recipients of the same records, nobody else',()=>{
    const s=share({kind:'person',nodeId:'bo'}),kim={...s,id:'s-kim',recipientEmail:KIM},other={...s,id:'s-x',recipientEmail:'x@example.test',scope:{kind:'project',projectId:'p-fms'}},gone={...s,id:'s-y',recipientEmail:'y@example.test',revokedAt:'2026-11-01T00:00:00.000Z'};
    assert.deepEqual(shareMembers(s,[s,kim,other,gone]),[OWNER,BO,KIM]);
    assert.deepEqual(shareMembers(s),[OWNER,BO]);
  });
  test('the projection shows in-scope people and members, never other people of the owner',()=>{
    const db=withMe(),s=share({kind:'person',nodeId:'bo'});
    db.devops.cards[0].assignees.push({node:'me',role:'requester'},{node:'@kim@example.test',role:'tester'},{node:'@x@example.test',role:'tester'});
    const p=projectForRecipient(db,s,[],{members:[OWNER,BO,KIM]}),c=p.cards.find(x=>parseLinkedId(x.id).id==='k-cb');
    assert.deepEqual(c.assignees,[{node:linkedId(s.id,'bo'),role:'developer'},{node:memberId(OWNER),role:'requester'},{node:memberId(KIM),role:'tester'}],'Cleo and non-members stay hidden');
    assert.deepEqual(p.share.members.map(m=>[m.id,m.name,m.owner]),[[memberId(OWNER),'Owner Person',true],[memberId(BO),BO,false],[memberId(KIM),KIM,false]]);
    assert.ok(!p.nodes.some(n=>parseLinkedId(n.id).id==='me'),"the owner's person card is not projected as a card");
    assert.ok(!JSON.stringify(p).includes('Cleo'));
  });
  test('assignee edits: in-scope people and members only; hidden people stay on the owner\'s card',()=>{
    const db=withMe(),s=share({kind:'person',nodeId:'bo'}),bo={email:BO},m={members:[OWNER,BO,KIM]};
    const r=applyRecipientEdit(db,s,{kind:'card',id:linkedId(s.id,'k-cb'),fields:{assignees:[{node:linkedId(s.id,'bo'),role:'tester'},{node:memberId(OWNER),role:'requester'},{node:memberId(KIM)}]}},bo,m);
    assert.ok(r.ok,r.error);
    assert.deepEqual(applyOwnerPatch(db,r.ownerDbPatch).devops.cards[0].assignees,[{node:'cleo',role:'tester'},{node:'bo',role:'tester'},{node:'me',role:'requester'},{node:'@kim@example.test',role:'developer'}],
      "Cleo (hidden) stays; the owner is stored as their person card, Kim as @email");
    assert.ok(!JSON.stringify(r.history).includes('cleo'),'history holds only what Bo can see');
    for(const node of [linkedId(s.id,'cleo'),'cleo','@stranger@example.test',linkedId('other','bo'),linkedId(s.id,'marsh')])
      assert.equal(applyRecipientEdit(db,s,{kind:'card',id:'k-cb',fields:{assignees:[{node}]}},bo,m).error,'invalid',node);
    assert.equal(applyRecipientEdit(db,s,{kind:'card',id:'k-cb',fields:{assignees:[{node:memberId(KIM)}]}},bo).error,'invalid','without Kim\'s share she is not a member');
    assert.equal(applyRecipientEdit(db,s,{kind:'card',id:'k-cb',fields:{assignees:[{node:linkedId(s.id,'bo'),role:'developer'}]}},bo,m).ownerDbPatch.length,0,'unchanged');
    assert.equal(applyRecipientEdit(db,share({kind:'person',nodeId:'bo'},'comment'),{kind:'card',id:'k-cb',fields:{assignees:[]}},bo,m).error,'permission');
  });
  test('history as the recipient sees it: their ids, hidden people left out',()=>{
    const db=owner(),s=share({kind:'person',nodeId:'bo'});
    const e={kind:'card',recordId:'k-cb',field:'assignees',old:[{node:'cleo',role:'tester'},{node:'bo',role:'developer'}],new:[{node:'bo',role:'developer'}]};
    assert.deepEqual(historyForRecipient(db,s,e).old,[{node:linkedId(s.id,'bo'),role:'developer'}]);
    assert.deepEqual(historyForRecipient(db,s,{kind:'card',recordId:'k-cb',field:'labels',old:[],new:['l-high']}).new,[linkedId(s.id,'l-high')]);
  });
});

describe('timeline release references',()=>{
  test('a release is kept as its linked id when shared, and edits map it back',()=>{
    const db=owner(),s=share({kind:'person',nodeId:'bo'});
    db.timeline.push({id:'i-late',title:'Late task',kind:'feature',status:'planned',start:'',end:'',priority:'',release:'i-cb',projects:['p-cb'],owner:'',link:'',notes:''});
    db.timeline.push({id:'i-out',title:'Elsewhere',kind:'feature',status:'planned',start:'',end:'',priority:'',release:'i-fms',projects:['p-cb'],owner:'',link:'',notes:''});
    const p=projectForRecipient(db,s),get=id=>p.timeline.find(i=>parseLinkedId(i.id).id===id);
    assert.equal(get('i-late').release,linkedId(s.id,'i-cb'));
    assert.equal(get('i-out').release,'','a release outside the scope is not named');
    const r=applyRecipientEdit(db,s,{kind:'item',id:'i-out',fields:{release:linkedId(s.id,'i-cb')}},{email:BO});
    assert.deepEqual(r.ownerDbPatch,[{kind:'item',id:'i-out',field:'release',value:'i-cb'}]);
    assert.equal(applyRecipientEdit(db,s,{kind:'item',id:'i-late',fields:{release:'i-fms'}},{email:BO}).error,'invalid','an out-of-scope release is refused');
    assert.ok(applyRecipientEdit(db,s,{kind:'item',id:'i-late',fields:{release:''}},{email:BO}).ok);
  });
});

describe('conflicts (card #61): last write wins, the loser is told',()=>{
  const renamed=(db,title)=>{db.devops.cards[0].title=title;return db};
  test('with a base, a stale copy is not an edit; a change over an unseen value is a clash',()=>{
    const s=share({kind:'person',nodeId:'bo'}),seen=applyProjection(recipient(),projectForRecipient(owner(),s));
    const id=linkedId(s.id,'k-cb'),card=d=>d.devops.cards.find(c=>c.id===id);
    // Owner renames meanwhile: the projection Bo is checked against has the new title.
    const now=projectForRecipient(renamed(owner(),'Owner title'),s);
    const stale=structuredClone(seen);stale.charts[0].nodes[0].name='Bo renames his own card';
    assert.deepEqual(extractRecipientChanges(now,stale,fieldBase(seen,stale)).edits,[],'an out-of-date copy never overwrites the owner');
    assert.equal(extractRecipientChanges(now,stale).edits[0]?.fields.title,'Ad copy','without a base (older clients) it would');
    const mine=structuredClone(seen);card(mine).title='Bo title';card(mine).points=5;
    const e=extractRecipientChanges(now,mine,fieldBase(seen,mine)).edits[0];
    assert.deepEqual(e.fields,{title:'Bo title',points:5});assert.deepEqual(e.clash,['title'],'points did not change on the owner side');
    const fresh=applyProjection(recipient(),now),mine2=structuredClone(fresh);card(mine2).title='Bo title';
    assert.equal(extractRecipientChanges(now,mine2,fieldBase(fresh,mine2)).edits[0].clash,undefined,'an edit over the value Bo saw is no conflict');
    const same=structuredClone(seen);card(same).title='Owner title';
    assert.deepEqual(extractRecipientChanges(now,same,fieldBase(seen,same)).edits,[],'both made the same change');
  });
  test('owner saves become history for every share that covers the record; unseen overwrites are clashes',()=>{
    const s=share({kind:'person',nodeId:'bo'}),k={...s,id:'s-kim',recipientEmail:KIM},gone={...s,id:'s-gone',revokedAt:'2026-11-01T00:00:00.000Z'},other=share({kind:'project',projectId:'p-fms'});
    const before=owner(),after=renamed(owner(),'Owner title');after.devops.cards[2].title='FMS v2';after.charts[0].nodes.find(n=>n.id==='memo').notes='changed';
    const h=ownerChanges(before,after,[s,k,gone,other],{email:OWNER});
    assert.deepEqual(h.map(e=>[e.shareId,e.kind,e.recordId,e.field,e.old,e.new,e.by,!!e.clash]),[[s.id,'card','k-cb','title','Ad copy','Owner title',OWNER,false],['s-kim','card','k-cb','title','Ad copy','Owner title',OWNER,false],[other.id,'card','k-fms','title','FMS deck','FMS v2',OWNER,false]],
      'private and revoked records are not recorded');
    const c=ownerChanges(before,after,[s],{email:OWNER},{card:{'k-cb':{title:'Bo title'}}});
    assert.equal(c[0].clash,true,'the owner\'s copy held another value: it overwrote a change they never saw');
    assert.equal(ownerChanges(before,after,[s],{email:OWNER},{card:{'k-cb':{title:'Ad copy'}}})[0].clash,undefined);
  });
  test('the loser is whoever wrote the replaced value; never the writer',()=>{
    const hist=[{field:'title',new:'Bo title',by:BO},{field:'title',new:'Old',by:OWNER}];
    assert.equal(overwritten(hist,'title','Bo title',OWNER),BO);
    assert.equal(overwritten(hist,'title','Bo title',BO),null);
    assert.equal(overwritten(hist,'title','Something else',BO,OWNER),OWNER,'a value from before any shared edit is the owner\'s');
    assert.equal(overwritten([],'title','x',OWNER,''),null);
  });
  test('conflicts are shown in the loser\'s ids',()=>{
    const s=share({kind:'person',nodeId:'bo'}),e={kind:'card',recordId:'k-cb',field:'labels',old:['l-high'],new:[],by:OWNER,at:'2026-11-13T00:00:00.000Z'};
    assert.deepEqual(conflictView(e),{kind:'card',id:'k-cb',field:'labels',by:OWNER,at:e.at,previous:['l-high'],value:[]});
    assert.deepEqual(conflictView(e,{ownerDb:owner(),share:s}),{kind:'card',id:linkedId(s.id,'k-cb'),field:'labels',by:OWNER,at:e.at,previous:[linkedId(s.id,'l-high')],value:[]});
  });
  test('sync-core: fieldBase lists what a save changed; clashes what a merge kept over a remote change',()=>{
    const base=owner(),local=renamed(owner(),'Mine'),remote=renamed(owner(),'Theirs');
    local.charts[0].nodes[0].x=1;local.timeline[0].notes='n';
    assert.deepEqual(fieldBase(base,local),{card:{'k-cb':{title:'Ad copy'}},item:{'i-cb':{notes:''}}},'layout is not a shared field');
    assert.deepEqual(clashes(base,local,remote),{card:{'k-cb':{title:'Ad copy'}}});
    assert.deepEqual(clashes(base,local,renamed(owner(),'Mine')),{},'the same change is no clash');
    assert.deepEqual(withHeld({card:{'k-cb':{title:'Theirs'}}},{card:{'k-cb':{title:'Ad copy'}}}),{card:{'k-cb':{title:'Ad copy'}}},'a held field keeps its older base');
  });
});

describe('storage',()=>{
  test('JSON files',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'flow-shares-'));
    try{await storageChecks(shareStore({dir}))}finally{rmSync(dir,{recursive:true,force:true})}
  });
  describe('embedded Postgres',()=>{
    let pg,pool,dir;
    before(async()=>{
      dir=mkdtempSync(join(tmpdir(),'flow-shares-pg-'));
      const {default:EmbeddedPostgres}=await import('embedded-postgres');
      pg=new EmbeddedPostgres({databaseDir:join(dir,'pg'),user:'flow',password:'flow-test',port:54341,persistent:false,onLog:()=>{},onError:()=>{}});
      await pg.initialise();await pg.start();await pg.createDatabase('flow');
      const {default:PG}=await import('pg');
      pool=new PG.Pool({connectionString:'postgres://flow:flow-test@127.0.0.1:54341/flow',max:2});
    });
    after(async()=>{await pool?.end().catch(()=>{});await pg?.stop().catch(()=>{});rmSync(dir,{recursive:true,force:true})});
    test('migrations run twice, then the same checks pass',async()=>{
      await migrate(pool);await migrate(pool);
      const t=(await pool.query(`select table_name from information_schema.tables where table_name like 'flygon_flow_share%' order by 1`)).rows.map(r=>r.table_name);
      assert.deepEqual(t,['flygon_flow_share_history','flygon_flow_share_placements','flygon_flow_share_requests','flygon_flow_shares']);
      assert.ok(SCHEMA.every(q=>/if not exists/.test(q)),'every statement is idempotent');
      await storageChecks(shareStore({dir,db:async()=>pool}));
    });
  });
});
