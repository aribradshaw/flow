// Combined view, the pure rules (public/combined-core.js): projecting another environment into the open
// one, stripping it again before anything is stored, and turning a save into edits for its own environment.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectEnv,applyCombined,stripCombined,hasCombined,combinedEnvs,combinedEdits,carryCombined,cleanCombine,parseForeign,envOf} from '../public/combined-core.js';
import {cleanDevops} from '../public/devops-core.js';
import {fieldBase,linkedFields,noteEdits} from '../public/sync-core.js';
import {refFor,localTarget} from '../public/chat-core.js';

const card=(id,number,extra={})=>({id,number,title:'Card '+id,description:'',column:'requests',project:'',labels:[],points:null,actual:null,due:'',assignees:[],checklist:[],links:[],item:'',created:'2026-11-01T00:00:00.000Z',updated:'2026-11-01T00:00:00.000Z',moved:'2026-11-01T00:00:00.000Z',...extra});
const home=()=>({active:'h',charts:[{id:'h',name:'Home',nodes:[{id:'me',name:'Me',type:'person',x:0,y:0}],edges:[]}],projects:[{id:'hp',name:'Home project',color:'#7cb980',entity:''}],timeline:[],
  devops:{columns:[],cards:[card('h1',1),card('h2',2)],nextNumber:3,labels:[{id:'hl',name:'Mine',section:'area',color:'blue'}]},environment:{id:'home-env',name:'Home'}});
const side=()=>({active:'s',charts:[{id:'s',name:'Side',nodes:[{id:'cleo',name:'Cleo Park',type:'person',x:0,y:0,email:'cleo@example.test'},{id:'acme',name:'Acme',type:'entity',x:0,y:0}],edges:[]}],
  projects:[{id:'sp',name:'Side project',color:'#3d6fb6',entity:'acme'}],
  timeline:[{id:'si',title:'Side launch',kind:'release',status:'planned',start:'2026-12-01',end:'',priority:'',release:'',projects:['sp'],owner:'',link:'',notes:''},
    {id:'sj',title:'Side beta',kind:'milestone',status:'planned',start:'2026-11-20',end:'',priority:'',release:'si',projects:['sp'],owner:'',link:'',notes:''}],
  devops:{columns:[],cards:[card('s1',1,{project:'sp',labels:['sl'],assignees:[{node:'cleo',role:'developer'},{node:'@kim@example.test',role:'tester'}],item:'si'}),card('s2',7)],nextNumber:8,labels:[{id:'sl',name:'High',section:'priority',color:'red'},{id:'sl2',name:'Low',section:'priority',color:'green'}]},
  shares:[{id:'S1',permission:'edit',ownerEmail:'bo@example.test',ownerEnv:'bo-env',members:[{id:'@bo@example.test',email:'bo@example.test',name:'Bo'}]}],
  environment:{id:'side-env',name:'Side'}});

test('a combined environment comes in with prefixed ids, its references mapped, and its people in db.combined only',()=>{
  const d=applyCombined(home(),[projectEnv(side(),{env:'side-env',name:'Side',rev:4})]);
  const c=d.devops.cards.find(x=>x.id==='cx.side-env.s1');
  assert.ok(c,'the card is there under its combined id');
  assert.equal(c.project,'cx.side-env.sp');assert.equal(c.item,'cx.side-env.si');assert.deepEqual(c.labels,['cx.side-env.sl']);
  assert.deepEqual(c.assignees,[{node:'cx.side-env.cleo',role:'developer'},{node:'@kim@example.test',role:'tester'}],'share members keep their @email id');
  assert.equal(d.timeline.find(i=>i.id==='cx.side-env.sj').release,'cx.side-env.si');
  assert.equal(d.projects.find(p=>p.id==='cx.side-env.sp').entity,'cx.side-env.acme');
  assert.equal(d.charts.length,1,'the mind map stays the home environment\'s');
  assert.deepEqual(d.combined.map(m=>[m.env,m.name,m.rev]),[['side-env','Side',4]]);
  assert.deepEqual(d.combined[0].people.map(p=>[p.id,p.name]),[['cx.side-env.cleo','Cleo Park']]);
  assert.ok(!JSON.stringify(d.combined).includes('cleo@example.test'),'person emails do not come along');
  assert.equal(d.combined[0].shares[0].members[0].id,'@bo@example.test');
  assert.equal(d.devops.cards.filter(x=>!x.id.startsWith('cx.')).length,2,'home cards untouched');
  assert.deepEqual(combinedEnvs(d),['side-env']);assert.ok(hasCombined(d));assert.ok(!hasCombined(home()));
  // Applying again replaces, never duplicates.
  const again=applyCombined(d,[projectEnv(side(),{env:'side-env',name:'Side',rev:5})]);
  assert.equal(again.devops.cards.length,d.devops.cards.length);assert.equal(again.combined[0].rev,5);
});

test('stripCombined removes every combined record and every reference to one, without touching the input',()=>{
  const d=applyCombined(home(),[projectEnv(side(),{env:'side-env',name:'Side'})]);
  // A home record that picked up references to combined ones (a stale browser): they go too.
  const h1=d.devops.cards.find(c=>c.id==='h1');Object.assign(h1,{project:'cx.side-env.sp',labels:['hl','cx.side-env.sl'],assignees:[{node:'me',role:'developer'},{node:'cx.side-env.cleo',role:'tester'}],item:'cx.side-env.si'});
  d.timeline.push({id:'hi',title:'Home item',kind:'milestone',status:'planned',start:'',end:'',priority:'',release:'cx.side-env.si',projects:['hp','cx.side-env.sp'],owner:'',link:'',notes:''});
  d.agentflow={agents:[{id:'a1',name:'Agent',cards:['h1','cx.side-env.s1'],projects:['cx.side-env.sp'],items:[]}],workflows:[]};
  const before=JSON.stringify(d),out=stripCombined(d);
  assert.equal(JSON.stringify(d),before,'input unchanged');
  assert.ok(!JSON.stringify(out).includes('cx.'),'nothing of the combined environment is left');
  assert.ok(!('combined' in out));
  const o1=out.devops.cards.find(c=>c.id==='h1');
  assert.deepEqual([o1.project,o1.item,o1.labels,o1.assignees],['','',['hl'],[{node:'me',role:'developer'}]]);
  assert.deepEqual(out.timeline.find(i=>i.id==='hi').projects,['hp']);assert.equal(out.agentflow.agents[0].cards.join(),'h1');
  assert.equal(out.devops.cards.length,2);assert.equal(out.devops.labels.length,1);assert.equal(out.projects.length,1);
});

test('combined cards keep their own numbers and never move the home environment\'s next number',()=>{
  const d=applyCombined(home(),[projectEnv(side(),{env:'side-env'})]);
  const dv=cleanDevops(d.devops,d);
  assert.equal(dv.cards.find(c=>c.id==='cx.side-env.s1').number,1,'#1 may repeat a home number');
  assert.equal(dv.cards.find(c=>c.id==='h1').number,1);
  assert.equal(dv.cards.find(c=>c.id==='cx.side-env.s2').number,7);
  assert.equal(dv.nextNumber,3,'the home next number ignores combined cards');
  assert.ok(dv.cards.find(c=>c.id==='cx.side-env.s1').labels.includes('cx.side-env.sl'),'the cleaner keeps combined labels');
});

test('a save becomes field edits for the record\'s own environment, only for fields the browser changed',()=>{
  const served=side(),shown=applyCombined(home(),[projectEnv(served,{env:'side-env'})]);
  const local=structuredClone(shown);
  const c=local.devops.cards.find(x=>x.id==='cx.side-env.s1');
  c.title='Renamed';c.column='doing';c.labels=['cx.side-env.sl2'];c.assignees=[{node:'cx.side-env.cleo',role:'developer'}];c.snoozedUntil='2026-12-01T16:00:00.000Z';
  c.project='';c.number=99; // not a shared field: never sent
  local.timeline.find(i=>i.id==='cx.side-env.sj').status='done';
  local.projects.find(p=>p.id==='cx.side-env.sp').color='#a8524c';
  local.devops.cards.find(x=>x.id==='h1').title='Home edit'; // the home's own: not this environment's business
  const base=fieldBase(shown,local);
  const out=combinedEdits(served,local,base,'side-env');
  const s1=out.data.devops.cards.find(x=>x.id==='s1');
  assert.equal(s1.title,'Renamed');assert.equal(s1.column,'doing');assert.deepEqual(s1.labels,['sl2']);
  assert.deepEqual(s1.assignees,[{node:'cleo',role:'developer'}]);assert.equal(s1.snoozedUntil,'2026-12-01T16:00:00.000Z');
  assert.equal(s1.project,'sp','re-filing stays in its own environment');assert.equal(s1.number,1);
  assert.equal(out.data.timeline.find(i=>i.id==='sj').status,'done');
  assert.equal(out.data.projects.find(p=>p.id==='sp').color,'#a8524c');
  assert.ok(!out.data.devops.cards.some(x=>x.id.startsWith('cx.')||x.id==='h1'),'nothing of the home environment goes there');
  assert.deepEqual(out.edits.map(e=>`${e.kind}:${e.id}:${e.field}`).sort(),['card:s1:assignees','card:s1:column','card:s1:labels','card:s1:snoozedUntil','card:s1:title','item:sj:status','project:sp:color']);
  assert.equal(out.base.card.s1.title,'Card s1','fieldBase in that environment\'s own ids');
  assert.deepEqual(out.base.card.s1.labels,['sl']);
  assert.equal(JSON.stringify(served),JSON.stringify(side()),'served is not changed in place');
});

test('stale copies, deletions and references to elsewhere never reach the combined environment',()=>{
  const served=side(),shown=applyCombined(home(),[projectEnv(served,{env:'side-env'})]);
  const local=structuredClone(shown);
  // Changed with no fieldBase (a copy that is only out of date): ignored.
  local.devops.cards.find(x=>x.id==='cx.side-env.s1').title='Stale';
  assert.equal(combinedEdits(served,local,{},'side-env').edits.length,0);
  // Removed from the save: nothing is deleted there.
  const gone=structuredClone(shown);gone.devops.cards=gone.devops.cards.filter(x=>x.id!=='cx.side-env.s2');
  const out=combinedEdits(served,gone,fieldBase(shown,gone),'side-env');
  assert.equal(out.edits.length,0);assert.ok(out.data.devops.cards.some(x=>x.id==='s2'));
  // A label or person of the home (or another environment) on a combined card: that field is not sent.
  const mixed=structuredClone(shown),m=mixed.devops.cards.find(x=>x.id==='cx.side-env.s1');
  m.labels=['hl'];m.assignees=[{node:'me',role:'developer'}];m.column='nowhere';
  assert.equal(combinedEdits(served,mixed,fieldBase(shown,mixed),'side-env').edits.length,0);
  // Waking a snoozed card.
  const snz=side();snz.devops.cards[0].snoozedUntil='2026-12-01T16:00:00.000Z';
  const shown2=applyCombined(home(),[projectEnv(snz,{env:'side-env'})]),woke=structuredClone(shown2);delete woke.devops.cards.find(x=>x.id==='cx.side-env.s1').snoozedUntil;
  const w=combinedEdits(snz,woke,fieldBase(shown2,woke),'side-env');
  assert.equal(w.edits.length,1);assert.equal(w.data.devops.cards[0].snoozedUntil,undefined);
});

test('carryCombined keeps what is shown around work on the home records only (the agent inbox)',()=>{
  const shown=applyCombined(home(),[projectEnv(side(),{env:'side-env'})]),own=stripCombined(shown);
  own.devops.cards.push(card('h3',3));
  const next=carryCombined(own,shown);
  assert.ok(next.devops.cards.some(c=>c.id==='h3')&&next.devops.cards.some(c=>c.id==='cx.side-env.s1'));
  assert.equal(next.combined[0].env,'side-env');
});

test('ids, env lists and chat links',()=>{
  assert.deepEqual(parseForeign('cx.side-env.sh.S1.c9'),{env:'side-env',id:'sh.S1.c9'});
  assert.equal(parseForeign('sh.S1.c9'),null);assert.equal(envOf({id:'cx.a.b'}),'a');assert.equal(envOf({id:'b'}),'');
  assert.deepEqual(cleanCombine(['a','a','home','bad id','b'],'home'),['a','b']);
  assert.deepEqual(cleanCombine('a,b,c,d,e,f,g,h,i,j'),['a','b','c','d','e','f','g','h']);
  const d=applyCombined(home(),[projectEnv(side(),{env:'side-env'})]);
  assert.deepEqual(refFor(d,'home-env','card','cx.side-env.s1'),{env:'side-env',kind:'card',id:'s1'});
  assert.equal(localTarget(d,'home-env',{env:'side-env',kind:'card',id:'s1'}),'cx.side-env.s1');
  assert.equal(localTarget(d,'home-env',{env:'home-env',kind:'card',id:'h1'}),'h1');
});

test("the browser's record of its user's edits covers combined records, and only what changed",()=>{
  const shown=applyCombined(home(),[projectEnv(side(),{env:'side-env'})]),local=structuredClone(shown);
  local.devops.cards.find(x=>x.id==='cx.side-env.s1').title='Edited';local.devops.cards.find(x=>x.id==='h1').title='Home';
  const edits=noteEdits(null,linkedFields(shown),local);
  assert.deepEqual(edits,{card:{'cx.side-env.s1':{title:'Card s1'}}});
  assert.equal(combinedEdits(side(),local,edits,'side-env').data.devops.cards.find(x=>x.id==='s1').title,'Edited');
});
