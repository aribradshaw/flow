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
import net from 'node:net';
import {lockedChanges,resolveScope,projectForRecipient,applyProjection,applyRecipientEdit,applyOwnerPatch,revokeEffects,extractRecipientChanges,
  createShare,requestReshare,decideRequest,linkedId,parseLinkedId,walkDown,validScope,linkedShareIds,
  shareMembers,memberId,historyForRecipient,ownerChanges,overwritten,conflictView,
  ADDS,addsOf,planAdditions,takeAdditions,applyAdditions,applyPendingEdit,additionsInScope,decideProposal,proposalPreview,newLinkedId,shareChartId,
  openedProjection,openedDb,openedEnvId,parseOpenedEnv,canOpen,OWNER_ONLY} from '../lib/sharing-core.mjs';
import {fieldBase,clashes,withHeld,linkedFields,noteEdits,settleEdits} from '../public/sync-core.js';
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
  test('a recipient can record actual points without touching the estimate',()=>{
    const db=owner(),e=share({kind:'person',nodeId:'bo'},'edit');
    const r=applyRecipientEdit(db,e,{kind:'card',id:'k-cb',fields:{actual:6}},bo);
    assert.ok(r.ok);assert.deepEqual(r.ownerDbPatch,[{kind:'card',id:'k-cb',field:'actual',value:6}]);
    assert.deepEqual([r.history[0].old,r.history[0].new],[null,6]);
    const card=applyOwnerPatch(db,r.ownerDbPatch).devops.cards.find(x=>x.id==='k-cb');
    assert.deepEqual([card.points,card.actual],[2,6]);
    assert.equal(applyRecipientEdit(db,e,{kind:'card',id:'k-cb',fields:{actual:-1}},bo).error,'invalid');
    assert.equal(applyRecipientEdit(db,e,{kind:'card',id:'k-cb',fields:{actual:null}},bo).ownerDbPatch.length,0,'null over no value is no change');
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
  // Additions: every share starts 'off'; proposals are stored, updated while pending, decided once.
  assert.equal((await store.get(s.id)).adds,'off');
  assert.equal((await store.setAdds(s.id,'approve')).adds,'approve');assert.equal((await store.list({ownerEnv:'default-workspace'}))[0].adds,'approve');
  await assert.rejects(store.setAdds(s.id,'everything'));
  const prop={id:'prop-1',shareId:s.id,ownerEnv:'default-workspace',ownerEmail:OWNER.toUpperCase(),proposedBy:BO,envId:'bo-env',records:{node:[],edge:[],project:[],item:[],card:[{id:'k-new',title:'New'}]},status:'pending'};
  await store.addProposal(prop);
  assert.equal((await store.proposals({ownerEmail:OWNER,status:'pending'})).length,1);
  assert.equal((await store.proposals({shareId:s.id,proposedBy:BO.toUpperCase()}))[0].records.card[0].title,'New');
  assert.equal((await store.updateProposal({...prop,records:{...prop.records,card:[{id:'k-new',title:'Renamed'}]}})).records.card[0].title,'Renamed');
  assert.equal((await store.decideProposal({id:'prop-1',status:'denied',decidedBy:OWNER})).status,'denied');
  assert.equal(await store.decideProposal({id:'prop-1',status:'approved',decidedBy:OWNER}),null,'a decided proposal does not change again');
  assert.equal(await store.updateProposal({...prop,records:{}}),null,'nor do its records');
  assert.equal((await store.getProposal('prop-1')).decidedBy,OWNER);
  await store.setAdds(s.id,'off');
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
  test('a member outside the share still carries their photo and account link',()=>{
    const db=withMe(),s=share({kind:'person',nodeId:'bo'});
    const me=db.charts[0].nodes.find(n=>n.id==='me');
    me.image='data:image/png;base64,AAAA';me.opidUser='u-owner';
    db.charts[0].nodes.push({...N('kimc','Kim Person','person',1,1),email:KIM,opidUser:'u-kim',image:'https://cdn.example.test/kim.png'});
    const p=projectForRecipient(db,s,[],{members:[OWNER,BO,KIM],viewer:'u-owner'});
    const ownerM=p.share.members.find(m=>m.email===OWNER),kim=p.share.members.find(m=>m.email===KIM);
    assert.equal(ownerM.id,memberId(OWNER));assert.equal(ownerM.name,'Owner Person');
    assert.equal(ownerM.image,me.image);assert.equal(ownerM.opidUser,'u-owner');assert.equal(ownerM.opidLinked,undefined);
    assert.equal(kim.opidLinked,true);assert.equal(kim.opidUser,undefined);assert.equal(kim.image,'https://cdn.example.test/kim.png');
    assert.ok(!JSON.stringify(p).includes('u-kim'),"another person's account id never crosses");
    assert.ok(!p.nodes.some(n=>['me','kimc'].includes(parseLinkedId(n.id)?.id)),'the cards themselves stay outside the share');
    const asBo=projectForRecipient(db,s,[],{members:[OWNER,BO,KIM],viewer:'u-bo'}).share.members.find(m=>m.email===OWNER);
    assert.equal(asBo.opidLinked,true);assert.equal('opidUser' in asBo,false);
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
    const act=structuredClone(seen);card(act).actual=7;
    assert.deepEqual(fieldBase(seen,act).card,{[id]:{actual:null}},'sync records the actual points a save changed');
    assert.deepEqual(extractRecipientChanges(now,act,fieldBase(seen,act)).edits[0].fields,{actual:7},'actual points carry through a shared save');
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
  test('sync-core: noteEdits keeps the edits a user made to linked records, never what a copy merely holds',()=>{
    const k=(id,f={})=>({id,title:'T',column:'requests',points:null,...f}),db=cards=>({charts:[{id:'c',nodes:[],edges:[]}],devops:{cards}});
    const mine=db([k('k-own')]),stale=db([k('sh.s.k1'),k('sh.s.k2')]);
    assert.deepEqual(linkedFields(mine),{},'own records are not shared');
    const seen=linkedFields(stale);
    stale.devops.cards[0].column='doing';
    assert.deepEqual(seen.card['sh.s.k1'].column,'requests','a snapshot is a copy, not the records themselves');
    let e=noteEdits(null,seen,stale);
    assert.deepEqual(e,{card:{'sh.s.k1':{column:'requests'}}},'one edit, with the value it started from');
    const next=linkedFields(stale);stale.devops.cards[0].column='uat';stale.devops.cards[1].points=2;
    e=noteEdits(e,next,stale);
    assert.deepEqual(e,{card:{'sh.s.k1':{column:'requests'},'sh.s.k2':{points:null}}},'a second change keeps the first base');
    const back=linkedFields(stale);stale.devops.cards[0].column='requests';
    e=noteEdits(e,back,stale);
    assert.deepEqual(e,{card:{'sh.s.k2':{points:null}}},'changed back: no longer an edit');
    // After a save: an unchanged field is done; one edited again meanwhile starts from what was sent.
    const sent=structuredClone(stale);stale.devops.cards[1].points=5;
    assert.deepEqual(settleEdits({card:{'sh.s.k2':{points:null}}},{card:{'sh.s.k2':{points:null}}},sent,sent),{});
    assert.deepEqual(settleEdits({card:{'sh.s.k2':{points:null}}},{card:{'sh.s.k2':{points:null}}},sent,stale),{card:{'sh.s.k2':{points:2}}});
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
      // A port the OS says is free right now, so the test never collides with a local service.
      const port=await new Promise((ok,no)=>{const s=net.createServer().once('error',no);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>ok(p))})});
      pg=new EmbeddedPostgres({databaseDir:join(dir,'pg'),user:'flow',password:'flow-test',port,persistent:false,onLog:()=>{},onError:()=>{}});
      await pg.initialise();await pg.start();await pg.createDatabase('flow');
      const {default:PG}=await import('pg');
      pool=new PG.Pool({connectionString:`postgres://flow:flow-test@127.0.0.1:${port}/flow`,max:2});
    });
    after(async()=>{await pool?.end().catch(()=>{});await pg?.stop().catch(()=>{});rmSync(dir,{recursive:true,force:true})});
    test('migrations run twice, then the same checks pass',async()=>{
      await migrate(pool);await migrate(pool);
      const t=(await pool.query(`select table_name from information_schema.tables where table_name like 'flygon_flow_share%' order by 1`)).rows.map(r=>r.table_name);
      assert.deepEqual(t,['flygon_flow_share_history','flygon_flow_share_placements','flygon_flow_share_proposals','flygon_flow_share_requests','flygon_flow_shares']);
      assert.ok(SCHEMA.every(q=>/if not exists/.test(q)),'every statement is idempotent');
      await storageChecks(shareStore({dir,db:async()=>pool}));
    });
  });
});

test('lockedChanges: deletes, stub edits and fields a share does not carry; layout and whitelisted fields are fine',()=>{
  const seen={charts:[{id:'c',nodes:[{id:'sh.s1.a',name:'A',type:'entity',x:0,y:0,notes:''},{id:'sh.s1.b',name:'B',type:'entity',x:0,y:0,linked:{stub:true}},{id:'own',name:'Mine',type:'entity',x:0,y:0}],
    edges:[{id:'sh.s1.e',from:'sh.s1.b',to:'sh.s1.a',type:'ownership',percent:'50'}]}],devops:{cards:[{id:'sh.s1.k',title:'K',column:'doing',project:'p',updated:'t1'}]}};
  const edit=f=>{const d=structuredClone(seen);f(d);return lockedChanges(seen,d)};
  assert.deepEqual(edit(d=>{const n=d.charts[0].nodes[0];n.name='A2';n.notes='x';n.x=500;d.charts[0].nodes[2].type='area';d.devops.cards[0].title='K2';d.devops.cards[0].updated='t2'}),[]);
  assert.deepEqual(edit(d=>{d.charts[0].nodes[0].type='area'}),[{kind:'node',id:'sh.s1.a',field:'type'}]);
  assert.deepEqual(edit(d=>{d.charts[0].nodes[1].name='Hacked'}),[{kind:'node',id:'sh.s1.b',field:'name',stub:true}]);
  assert.deepEqual(edit(d=>{d.charts[0].nodes[1].x=9}),[],'a stub can still be moved');
  assert.deepEqual(edit(d=>{d.charts[0].edges=[]}),[{kind:'edge',id:'sh.s1.e',field:'deleted'}]);
  assert.deepEqual(edit(d=>{d.devops.cards[0].project='mine'}),[{kind:'card',id:'sh.s1.k',field:'project'}]);
});

// ---- Additions: recipients adding records inside a share (share.adds) ----
describe('additions',()=>{
  const plan=(sh,sent,stored,opts={})=>planAdditions(owner(),sh,sent,stored,opts);
  // Bo's copy as the browser has it: his own data with the share's projection merged in.
  const copy=(sh,pending=[])=>applyProjection(recipient(),projectForRecipient(owner(),sh,[],{pending}));
  const L=(sh,id)=>linkedId(sh.id,id);
  const newCard=(sh,extra)=>({id:'k-bo1',number:7,title:'Bo’s idea',description:'',column:'requests',project:L(sh,'p-cb'),labels:[L(sh,'l-high')],points:null,due:'',assignees:[{node:L(sh,'bo'),role:'developer'},{node:'bo-own',role:'tester'}],checklist:[],links:[],item:'',...extra});
  test('adds: off by default, only edit shares add; view and comment shares are always off',()=>{
    assert.deepEqual(ADDS,['off','approve','direct']);
    assert.equal(share({kind:'environment'}).adds,'off');
    const r=createShare(env,{email:OWNER},{recipientEmail:BO,scope:{kind:'environment'},permission:'view',adds:'direct'});assert.equal(r.share.adds,'off');
    assert.equal(createShare(env,{email:OWNER},{recipientEmail:BO,scope:{kind:'environment'},permission:'edit',adds:'sometimes'}).field,'adds');
    assert.equal(addsOf({permission:'edit',adds:'approve'}),'approve');assert.equal(addsOf({permission:'comment',adds:'approve'}),'off');
    assert.equal(addsOf({permission:'edit',adds:'direct',revokedAt:'x'}),'off');assert.equal(addsOf({permission:'edit'}),'off');
  });
  test('a new card in a shared project is an addition; its private references are dropped',()=>{
    const sh={...share({kind:'person',nodeId:'bo'}),adds:'approve'},before=copy(sh),sent=structuredClone(before);
    sent.devops.cards.push(newCard(sh));
    const p=plan(sh,sent,recipient(),{members:[OWNER,BO]});
    assert.deepEqual(p.taken,[{kind:'card',id:'k-bo1'}]);assert.equal(p.map['k-bo1'],'k-bo1');
    const c=p.records.card[0];
    assert.equal(c.project,'p-cb');assert.deepEqual(c.labels,['l-high']);assert.deepEqual(c.assignees,[{node:'bo',role:'developer'}],"Bo's private person never reaches the owner");
    assert.equal(c.localNumber,7);
    // What Bo stores: the card left; it comes back as a linked (pending) copy.
    const kept=takeAdditions(sent,sh.id,p);assert.ok(!kept.devops.cards.some(x=>x.id==='k-bo1'));
    // A card Bo had before is his own; editing it is not an addition.
    const stored=structuredClone(recipient());stored.devops.cards.push(newCard(sh));
    assert.equal(plan(sh,sent,stored).taken.length,0);
    // A card in his own project, or in no project, stays his.
    const mine=structuredClone(before);mine.projects.push({id:'p-mine',name:'Mine',color:'#7cb980',entity:''});mine.devops.cards.push(newCard(sh,{project:'p-mine'}),newCard(sh,{id:'k-bo2',project:'',labels:[]}));
    assert.equal(plan(sh,mine,recipient()).taken.length,0);
  });
  test('scope limits: only what the scope can hold once added',()=>{
    const base=s=>({...share(s),adds:'direct'});
    const node=(sh,id='n-bo',name='Bo’s new node')=>({id,name,type:'entity',x:10,y:20});
    // Whole environment: a node on the share's chart, an edge between shared nodes, a project under a shared node.
    let sh=base({kind:'environment'}),d=copy(sh);
    d.charts.find(c=>c.id===shareChartId(sh.id)).nodes.push(node(sh));
    d.charts.find(c=>c.id===shareChartId(sh.id)).edges.push({id:'e-bo',from:L(sh,'marsh'),to:'n-bo',type:'ownership',percent:'20'},{id:'e-x',from:L(sh,'cleo'),to:L(sh,'labs'),type:'group',percent:''});
    d.projects.push({id:'p-bo',name:'Bo project',color:'#7cb980',entity:'n-bo'});
    d.timeline.push({id:'i-bo',title:'Bo date',kind:'milestone',status:'planned',start:'2026-12-02',end:'',priority:'',release:'',projects:['p-bo'],owner:'',link:'',notes:''});
    let p=plan(sh,d,recipient());
    assert.deepEqual(sorted(p.taken.map(t=>t.kind+':'+t.id)),['edge:e-bo','edge:e-x','item:i-bo','node:n-bo','project:p-bo']);
    assert.equal(p.records.node[0].chart,'c1','placed on the chart of the node it is joined to');
    // Person scope: a lone node is not in scope (it stays Bo's); joined under Marsh by ownership it is.
    sh=base({kind:'person',nodeId:'bo'});d=copy(sh);const sc=d.charts.find(c=>c.id===shareChartId(sh.id));
    sc.nodes.push(node(sh));
    assert.equal(plan(sh,d,recipient()).taken.length,0,'a lone node is outside a person scope');
    sc.edges.push({id:'e-bo',from:L(sh,'marsh'),to:'n-bo',type:'ownership',percent:''});
    assert.deepEqual(sorted(plan(sh,d,recipient()).taken.map(t=>t.id)),['e-bo','n-bo']);
    // ... and a node Bo already had on the share's chart is promoted when he joins it under Marsh.
    const had=structuredClone(recipient());had.charts.push({id:shareChartId(sh.id),name:'x',nodes:[node(sh)],edges:[]});
    assert.deepEqual(sorted(plan(sh,d,had).taken.map(t=>t.id)),['e-bo','n-bo']);
    assert.equal(plan(sh,d,had,{promote:false}).taken.length,0,'never when additions are off');
    // An edge pointing up at Kestrel Group (a stub, outside the scope) is not in scope.
    const up=copy(sh);up.charts.find(c=>c.id===shareChartId(sh.id)).edges.push({id:'e-up',from:L(sh,'marsh'),to:L(sh,'flygon'),type:'group',percent:''});
    assert.equal(plan(sh,up,recipient()).taken.length,0);
    // Hand-picked nodes: edges between them yes, new nodes no.
    sh=base({kind:'nodes',nodeIds:['marsh','campaign','bo']});d=copy(sh);
    d.charts.find(c=>c.id===shareChartId(sh.id)).nodes.push(node(sh));
    d.charts.find(c=>c.id===shareChartId(sh.id)).edges.push({id:'e-nb',from:L(sh,'bo'),to:L(sh,'campaign'),type:'ownership',percent:'5'},{id:'e-nn',from:L(sh,'bo'),to:'n-bo',type:'ownership',percent:''});
    assert.deepEqual(plan(sh,d,recipient()).taken.map(t=>t.id),['e-nb']);
    // Project scope: items and cards in the project; no projects or nodes.
    sh=base({kind:'project',projectId:'p-cb'});d=copy(sh);
    d.devops.cards.push(newCard(sh));d.timeline.push({id:'i-bo',title:'Bo date',kind:'milestone',status:'planned',start:'2026-12-02',end:'',priority:'',release:'',projects:[L(sh,'p-cb')],owner:'',link:'',notes:''});
    assert.deepEqual(sorted(plan(sh,d,recipient()).taken.map(t=>t.id)),['i-bo','k-bo1']);
    // Label scope: a card with the label; one without it is not in scope.
    sh=base({kind:'label',label:'l-mkt'});d=copy(sh);
    d.devops.cards.push(newCard(sh,{project:'',labels:[L(sh,'l-mkt')]}),newCard(sh,{id:'k-bo2',project:'',labels:[L(sh,'l-high')]}));
    assert.deepEqual(plan(sh,d,recipient()).taken.map(t=>t.id),['k-bo1']);
    // A chart-limited share puts new nodes on that chart.
    sh=base({kind:'environment',chartId:'c1'});d=copy(sh);d.charts.find(c=>c.id===shareChartId(sh.id)).nodes.push(node(sh));
    assert.equal(plan(sh,d,recipient()).records.node[0].chart,'c1');
  });
  test('explicitly marked records (sh.<share>.new-<id>): kept when the scope holds them, refused when not',()=>{
    let sh={...share({kind:'environment'}),adds:'approve'},d=copy(sh);
    d.devops.cards.push({...newCard(sh,{project:'',labels:[]}),id:newLinkedId(sh.id,'x1')});
    let p=plan(sh,d,recipient());assert.equal(p.records.card[0].id,'x1');assert.equal(p.records.card[0].localId,newLinkedId(sh.id,'x1'));
    sh={...share({kind:'project',projectId:'p-cb'}),adds:'approve'};d=copy(sh);
    d.projects.push({id:newLinkedId(sh.id,'p9'),name:'Not here',color:'#7cb980',entity:''});
    p=plan(sh,d,recipient());assert.equal(p.taken.length,0);assert.deepEqual(p.refused.map(r=>[r.kind,r.reason]),[['project','out-of-scope']]);
  });
  test('pending records: shown as linked copies marked pending; edits change the proposal; stale copies are not added twice',()=>{
    const sh={...share({kind:'person',nodeId:'bo'}),adds:'approve'},d=copy(sh);d.devops.cards.push(newCard(sh));
    const p=plan(sh,d,recipient(),{members:[OWNER,BO]});
    const prop={id:'q1',shareId:sh.id,ownerEnv:sh.ownerEnv,ownerEmail:OWNER,proposedBy:BO,records:p.records,status:'pending',createdAt:'2026-11-22T00:00:00.000Z'};
    const proj=projectForRecipient(owner(),sh,[],{pending:[prop],members:[OWNER,BO]});
    const c=proj.cards.find(x=>x.id===L(sh,'k-bo1'));
    assert.equal(c.linked.pending,'q1');assert.equal(c.project,L(sh,'p-cb'));assert.deepEqual(c.labels,[L(sh,'l-high')]);assert.deepEqual(proj.share.pending,[L(sh,'k-bo1')]);
    // Bo renames it in his copy: a pending edit, not an edit of the owner's data.
    const mine=applyProjection(recipient(),proj),sent=structuredClone(mine);sent.devops.cards.find(x=>x.id===L(sh,'k-bo1')).title='Better idea';
    const ch=extractRecipientChanges(proj,sent);
    assert.deepEqual(ch.edits,[]);assert.deepEqual(ch.pending,[{proposal:'q1',kind:'card',id:'k-bo1',fields:{title:'Better idea'}}]);
    const next=applyPendingEdit(owner(),sh,prop,ch.pending[0],{email:BO},{members:[OWNER,BO]});
    assert.equal(next.records.card[0].title,'Better idea');
    assert.equal(applyPendingEdit(owner(),sh,{...prop,status:'denied'},ch.pending[0],{email:BO}),null);
    // A stale copy still holding k-bo1 under its own id: taken out again, its fields update the proposal.
    const stale=structuredClone(d);stale.devops.cards.find(x=>x.id==='k-bo1').title='Typed late';
    const again=plan(sh,stale,recipient(),{pending:[prop],known:[prop]});
    assert.deepEqual(again.taken,[{kind:'card',id:'k-bo1'}]);assert.equal(again.records.card.length,0);assert.equal(again.resent[0].proposal,'q1');
    assert.equal(plan(sh,stale,recipient(),{known:[{...prop,status:'denied'}]}).resent.length,0,'a denied one is just dropped');
    // A new card in a pending project joins that proposal.
    const p2={...prop,records:{node:[],edge:[],project:[{id:'p-new',name:'New',color:'',entity:'marsh'}],item:[],card:[]}};
    const withP=applyProjection(recipient(),projectForRecipient(owner(),sh,[],{pending:[p2]}));withP.devops.cards.push(newCard(sh,{project:L(sh,'p-new'),labels:[]}));
    const j=plan(sh,withP,recipient(),{pending:[p2],known:[p2]});assert.deepEqual(j.joins,['q1']);assert.equal(j.records.card[0].project,'p-new');
  });
  test('approve adds the records to the owner, owned by the owner; deny adds nothing; both decide once',()=>{
    const sh={...share({kind:'person',nodeId:'bo'}),adds:'approve'},d=copy(sh);d.devops.cards.push(newCard(sh));
    const prop={id:'q1',shareId:sh.id,ownerEnv:sh.ownerEnv,ownerEmail:OWNER,proposedBy:BO,records:plan(sh,d,recipient(),{members:[OWNER,BO]}).records,status:'pending'};
    assert.equal(decideProposal(owner(),sh,prop,{email:BO},true).error,'forbidden','only the owner decides');
    const yes=decideProposal(owner(),sh,prop,{email:OWNER},true);
    assert.equal(yes.proposal.status,'approved');
    const c=yes.db.devops.cards.find(x=>x.id==='k-bo1');
    assert.equal(c.number,5,"the owner's next number");assert.equal(c.project,'p-cb');assert.equal(yes.db.devops.nextNumber,6);
    assert.ok(!('localNumber' in c)&&!('localId' in c));
    assert.ok(resolveScope(yes.db,sh).cardIds.includes('k-bo1'),'it flows back as a normal linked copy');
    assert.equal(decideProposal(owner(),sh,yes.proposal,{email:OWNER},true).error,'decided');
    const no=decideProposal(owner(),sh,prop,{email:OWNER},false);assert.equal(no.proposal.status,'denied');assert.equal(no.db,undefined);
    // Its project is gone by the time the owner decides: approving is refused.
    const gone=owner();gone.projects=gone.projects.filter(x=>x.id!=='p-cb');
    assert.equal(decideProposal(gone,sh,prop,{email:OWNER},true).error,'out-of-scope');
    // An id taken in the meantime gets a new one.
    const taken=owner();taken.devops.cards.push({...taken.devops.cards[0],id:'k-bo1',number:9});
    const r=applyAdditions(taken,prop.records);assert.notEqual(r.map['k-bo1'],'k-bo1');assert.equal(r.db.devops.cards.filter(x=>x.id==='k-bo1').length,1);
    assert.deepEqual(proposalPreview(owner(),prop),[{kind:'card',id:'k-bo1',title:'Bo’s idea',detail:'Studio launch'}]);
  });
  test('a card of theirs moved into a shared project is an addition (made first, project picked after); not when off',()=>{
    const sh={...share({kind:'person',nodeId:'bo'}),adds:'approve'},stored=structuredClone(recipient());stored.devops.cards.push(newCard(sh,{project:'',labels:[]}));
    const sent=applyProjection(stored,projectForRecipient(owner(),sh));sent.devops.cards.find(c=>c.id==='k-bo1').project=L(sh,'p-cb');
    assert.deepEqual(plan(sh,sent,stored).taken,[{kind:'card',id:'k-bo1'}]);
    assert.equal(plan(sh,sent,stored,{promote:false}).taken.length,0);
    // One that was in the shared project already (made while additions were off) stays his.
    const old=structuredClone(recipient());old.devops.cards.push(newCard(sh));
    assert.equal(plan(sh,applyProjection(old,projectForRecipient(owner(),sh)),old).taken.length,0);
  });
  test('additionsInScope drops dependents of what falls out',()=>{
    const sh=share({kind:'person',nodeId:'bo'});
    const r=additionsInScope(owner(),sh,{node:[{id:'n1',name:'Lone',type:'entity',x:0,y:0,chart:'c1'}],edge:[],project:[{id:'p1',name:'P',color:'',entity:'n1'}],item:[],card:[{id:'k1',title:'K',project:'p1',labels:[],assignees:[]}]});
    assert.deepEqual(r.dropped.map(x=>x.id).sort(),['k1','n1','p1']);
  });
});

// Opening a shared environment (docs/sharing.md): the owner's environment through a whole-environment share.
describe('opened environments',()=>{
  const withAf=()=>{const d=owner();d.charts.push({id:'c2',name:'Private chart',nodes:[{...N('secret','Secret Holdings'),notes:'Chart two only'}],edges:[]});
    d.charts[0].nodes[0].email='bo.private@example.test';
    d.agentflow={agents:[{id:'bot',name:'Builder',kind:'agent',title:'',status:'active',live:true,reportsTo:'',supervisor:'bo',purpose:'Builds',instructions:'Secret sauce',runtime:'homebox',models:['claude:opus'],model:'claude:opus',auto:false,schedule:'daily',inputs:[],outputs:[],tools:['git'],projects:['p-cb'],cards:['k-cb','sh.other.k9'],items:[]},
      {id:'boss',name:'Boss',kind:'team',title:'',status:'active',live:false,reportsTo:'',supervisor:'',purpose:'',instructions:'',runtime:'',models:[],model:'',auto:false,schedule:'',inputs:[],outputs:[],tools:[],projects:[],cards:[],items:[]}],
      workflows:[{id:'wf',name:'Ship',description:'',status:'active',trigger:'manual',schedule:'',steps:[{id:'s1',agent:'bot',action:'Build',output:''}],projects:[],cards:[],items:[]}],
      runners:[{name:'homebox',models:[{id:'claude:opus',label:'Opus'}],jobs:[{id:'j',name:'Nightly',source:'cron',schedule:'',command:'secret-cmd --key x',ai:false,enabled:true,lastStatus:'ok'}],reported:'2026-11-01T00:00:00.000Z'}]};
    return d};
  test('ids: share-<shareId>; only active whole-environment shares open',()=>{
    const s=share({kind:'environment'});
    assert.equal(parseOpenedEnv(openedEnvId(s.id)),s.id);assert.equal(parseOpenedEnv('default-workspace'),null);assert.equal(parseOpenedEnv('share-'),null);
    assert.ok(canOpen(s));assert.ok(!canOpen({...s,revokedAt:'2026-11-01'}));assert.ok(!canOpen(share({kind:'person',nodeId:'bo'})));
    assert.equal(openedProjection(owner(),share({kind:'project',projectId:'p-cb'})),null);
  });
  test('every chart of the scope, AgentFlow with references in the share’s ids, nothing private',()=>{
    const db=withAf(),s=share({kind:'environment',chartId:'c1'}),L=id=>linkedId(s.id,id);
    const p=openedProjection(db,s,[{recordId:'bo',chartId:'elsewhere',x:5,y:6}]),d=openedDb(p,{name:'Harbor'}),text=JSON.stringify(d);
    assert.deepEqual(d.charts.map(c=>c.id),[L('c1')]);assert.equal(d.active,L('c1'));assert.equal(d.environment.id,openedEnvId(s.id));assert.equal(d.environment.name,'Harbor');
    const bo=d.charts[0].nodes.find(n=>n.id===L('bo'));assert.deepEqual([bo.x,bo.y],[5,6],'layout is the recipient’s; the chart stays the owner’s');
    assert.equal(d.charts[0].edges.length,db.charts[0].edges.length);
    for(const x of ['Secret Holdings','Chart two only','bo.private@example.test','secret-cmd','sh.other.'])assert.ok(!text.includes(x),x);
    const bot=d.agentflow.agents.find(a=>a.id===L('bot'));
    assert.deepEqual([bot.supervisor,bot.projects,bot.cards,bot.live,bot.runtime],[L('bo'),[L('p-cb')],[L('k-cb')],true,'homebox']);
    assert.equal(d.agentflow.workflows[0].steps[0].agent,L('bot'));
    assert.deepEqual(d.devops.labels.map(l=>l.id).sort(),[L('l-high'),L('l-mkt')]);
    // A placed (non-opened) projection carries no AgentFlow.
    assert.equal(projectForRecipient(db,s).agents,undefined);
  });
  test('agent edits: whitelisted fields only; live, runtime, models and the rest of what runs stay the owner’s',()=>{
    const db=withAf(),s=share({kind:'environment'}),L=id=>linkedId(s.id,id),me={email:BO};
    for(const f of OWNER_ONLY.agent){const r=applyRecipientEdit(db,s,{kind:'agent',id:L('bot'),fields:{[f]:f==='live'||f==='auto'?false:f==='models'||f==='tools'?['x']:'x'}},me);assert.deepEqual([r.ok,r.error,r.field],[false,'owner-only',f],f)}
    const r=applyRecipientEdit(db,s,{kind:'agent',id:L('bot'),fields:{purpose:'Tests too',cards:[L('k-cb'),L('k-marsh')],reportsTo:L('boss'),supervisor:'',status:'paused'}},me);
    assert.ok(r.ok,JSON.stringify(r));const o=applyOwnerPatch(db,r.ownerDbPatch).agentflow.agents.find(a=>a.id==='bot');
    assert.deepEqual([o.purpose,o.cards,o.reportsTo,o.supervisor,o.status,o.live],['Tests too',['sh.other.k9','k-cb','k-marsh'],'boss','','paused',true],'hidden references stay');
    assert.equal(applyRecipientEdit(db,s,{kind:'agent',id:L('bot'),fields:{cards:['k-nope']}},me).error,'invalid');
    assert.equal(applyRecipientEdit(db,s,{kind:'agent',id:L('bot'),fields:{reportsTo:L('bot')}},me).error,'invalid','not its own boss');
    assert.equal(applyRecipientEdit(db,s,{kind:'agent',id:L('bot'),fields:{supervisor:L('marsh')}},me).error,'invalid','a supervisor is a person');
    assert.equal(applyRecipientEdit(db,{...s,permission:'view'},{kind:'agent',id:L('bot'),fields:{purpose:'x'}},me).error,'permission');
    const w=applyRecipientEdit(db,s,{kind:'workflow',id:L('wf'),fields:{steps:[{id:'s1',agent:L('boss'),action:'Plan'}],description:'New'}},me);
    assert.ok(w.ok);assert.deepEqual(applyOwnerPatch(db,w.ownerDbPatch).agentflow.workflows[0].steps,[{id:'s1',agent:'boss',action:'Plan',output:''}]);
    // Other scopes do not carry AgentFlow.
    assert.equal(applyRecipientEdit(db,share({kind:'person',nodeId:'bo'}),{kind:'agent',id:'bot',fields:{purpose:'x'}},me).error,'out-of-scope');
  });
  test('a save of an opened environment: only the edits made, on any chart; new records are additions on their chart',()=>{
    const db=withAf(),s=share({kind:'environment'}),L=id=>linkedId(s.id,id);
    const p=openedProjection(db,s),d=openedDb(p),sub=structuredClone(d);
    sub.agentflow.agents[0].purpose='Changed';sub.agentflow.agents[0].live=false;sub.charts.find(c=>c.id===L('c2')).nodes[0].name='Renamed';
    const x=extractRecipientChanges(p,sub,{agent:{[L('bot')]:{purpose:'Builds',live:true}},node:{[L('secret')]:{name:'Secret Holdings'}}});
    assert.deepEqual(x.edits.map(e=>[e.kind,e.id,Object.keys(e.fields)]),[['node','secret',['name']],['agent','bot',['purpose']]],'live is not a field a save carries');
    assert.deepEqual(x.placements,[],'nothing moved');
    sub.charts.find(c=>c.id===L('c2')).nodes.push(N('fresh','New card on c2'));
    const plan=planAdditions(db,{...s,adds:'direct'},sub,{},{opened:true});
    assert.deepEqual(plan.records.node.map(n=>[n.name,n.chart]),[['New card on c2','c2']]);
    assert.equal(planAdditions(db,{...s,adds:'direct'},sub,{}).records.node.length,0,'without opened it is not for the share');
  });
});
