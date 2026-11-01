// AgentFlow data rules (public/agentflow-core.js): validation, the org tree, removal and briefs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cleanAgentflow,seedAgentflow,newAgent,newWorkflow,newStep,removeAgent,descendants,chainOf,canReportTo,workflowsFor,agentsForCard,
  workFor,openWork,full,LIMITS,treeLayout,positions,pin,unpin,placed,CARD,STEP,STACK,stacked,delegate,workQueue,filterAgents,filterWorkflows,agentBrief,workflowBrief,starterAgentflow,duplicateWorkflow,cleanRunners,runnerOf,runLine,modelLabel,liveProblem,modelChoices} from '../public/agentflow-core.js';
import {normalize} from '../lib/cleaners.mjs';
import {size,isSeed} from '../public/sync-core.js';
import {starterChart} from '../public/demo-seed.js';

const T='2026-10-30T12:00:00.000Z';
const base=()=>({charts:[{id:'c',name:'C',nodes:[{id:'pat',name:'Pat Lee',type:'person',x:0,y:0},{id:'acme',name:'Acme',type:'entity',x:0,y:0}],edges:[]}],
  projects:[{id:'p1',name:'Launch'}],timeline:[{id:'i1',title:'Go live',kind:'deadline',status:'planned',start:'2026-12-01',end:''}],
  devops:{columns:[{id:'doing',name:'Doing'},{id:'done',name:'Done'}],cards:[{id:'k1',number:1,title:'Write copy',column:'doing',project:'p1',due:'2026-11-20'},{id:'k2',number:2,title:'Old',column:'done',project:'p1'},{id:'k3',number:3,title:'Other',column:'doing',project:''}]}});

test('a missing or broken AgentFlow becomes an empty one',()=>{
  assert.deepEqual(cleanAgentflow(undefined,base()),seedAgentflow());
  assert.deepEqual(cleanAgentflow('nope',base()),{agents:[],workflows:[],runners:[]});
  assert.deepEqual(normalize({charts:[]}).agentflow,{agents:[],workflows:[],runners:[]},'the server normalizer adds it to older saves');
});

test('validation: defaults, limits, dangling links and duplicate ids',()=>{
  const db=base();
  const af=cleanAgentflow({agents:[
    {id:'a',name:'  Lead  ',kind:'robot',status:'busy',supervisor:'acme',projects:['p1','gone','p1'],cards:['k1','zz'],items:['i1','x'],inputs:[' In ','In','',5],created:'bad'},
    {id:'a',name:'Duplicate'},{name:'No id'},null,
    {id:'b',name:'B',reportsTo:'a',supervisor:'pat'},
  ],workflows:[{id:'w',name:'W',trigger:'cron',steps:[{id:'s',agent:'a',action:'Go'},{id:'s',agent:'ghost'},'junk'],cards:['k1','k9']}]},db);
  assert.equal(af.agents.length,2);
  const [a,b]=af.agents;
  assert.deepEqual([a.name,a.kind,a.status,a.supervisor,a.projects,a.cards,a.items,a.inputs],['Lead','agent','draft','',['p1'],['k1'],['i1'],['In']]);
  assert.ok(!Number.isNaN(Date.parse(a.created)));
  assert.deepEqual([b.reportsTo,b.supervisor],['a','pat'],'supervisors must be people; entities are dropped');
  const w=af.workflows[0];
  assert.equal(w.trigger,'manual');assert.equal(w.steps.length,2);
  assert.notEqual(w.steps[0].id,w.steps[1].id,'duplicate step ids are replaced');
  assert.deepEqual(w.steps.map(s=>s.agent),['a',''],'steps for unknown agents become unassigned');
  assert.deepEqual(w.cards,['k1']);
  assert.deepEqual(cleanAgentflow(JSON.parse(JSON.stringify(af)),db),af,'cleaning is idempotent');
});

test('links to records shared in from another workspace survive cleaning without them',()=>{
  // Stored data has shared (sh.*) records stripped; they are projected in on read.
  const af=cleanAgentflow({agents:[{id:'a',name:'A',supervisor:'sh.s1.bo',cards:['sh.s1.k9','gone'],projects:['sh.s1.p'],items:['sh.s1.i']}],workflows:[{id:'w',name:'W',cards:['sh.s1.k9']}]},base());
  const [a]=af.agents;
  assert.deepEqual([a.supervisor,a.cards,a.projects,a.items,af.workflows[0].cards],['sh.s1.bo',['sh.s1.k9'],['sh.s1.p'],['sh.s1.i'],['sh.s1.k9']]);
});

test('limits are checked before adding, never by silently dropping',()=>{
  const af=seedAgentflow();
  for(let i=0;i<LIMITS.agents;i++)newAgent(af,{name:'A'+i});
  assert.match(full(af,'agents'),/up to 500 agents/);assert.equal(full(af,'workflows'),'');
  const a=af.agents[0];a.inputs=Array.from({length:LIMITS.list},(_,i)=>'in'+i);
  assert.match(full(af,'list',a,'inputs'),/Up to 50 inputs/);assert.equal(full(af,'list',a,'outputs'),'');
  const w=newWorkflow(af,{steps:Array.from({length:LIMITS.steps},()=>newStep())});
  assert.match(full(af,'steps',w),/up to 100 steps/);
  a.cards=Array.from({length:LIMITS.refs},(_,i)=>'sh.k'+i);
  assert.match(full(af,'refs',a,'cards'),/Up to 100 linked cards/);assert.equal(full(af,'refs',a,'items'),'');
  assert.equal(cleanAgentflow(JSON.parse(JSON.stringify(af)),{}).agents.length,LIMITS.agents,'a full workspace keeps every agent');
});

test('reporting loops are broken and missing managers dropped',()=>{
  const af=cleanAgentflow({agents:[{id:'a',name:'A',reportsTo:'c'},{id:'b',name:'B',reportsTo:'a'},{id:'c',name:'C',reportsTo:'b'},{id:'d',name:'D',reportsTo:'d'},{id:'e',name:'E',reportsTo:'nobody'}]},base());
  assert.deepEqual(af.agents.map(a=>a.reportsTo),['','a','b','','']);
});

test('the org tree: descendants, chains and who may report to whom',()=>{
  const af=seedAgentflow();
  const a=newAgent(af,{name:'A'}),b=newAgent(af,{name:'B',reportsTo:a.id}),c=newAgent(af,{name:'C',reportsTo:b.id}),d=newAgent(af,{name:'D'});
  assert.deepEqual([...descendants(af,a.id)].sort(),[b.id,c.id].sort());
  assert.deepEqual(chainOf(af,c.id).map(x=>x.name),['B','A']);
  assert.equal(canReportTo(af,a.id,c.id),false);assert.equal(canReportTo(af,a.id,a.id),false);
  assert.equal(canReportTo(af,c.id,d.id),true);assert.equal(canReportTo(af,a.id,''),true);assert.equal(canReportTo(af,a.id,'ghost'),false);
});

test('removing an agent moves its reports up and unassigns its steps',()=>{
  const af=seedAgentflow();
  const a=newAgent(af,{name:'A'}),b=newAgent(af,{name:'B',reportsTo:a.id}),c=newAgent(af,{name:'C',reportsTo:b.id});
  const w=newWorkflow(af,{steps:[newStep({agent:b.id}),newStep({agent:c.id})]});
  assert.deepEqual(workflowsFor(af,b.id).map(x=>x.id),[w.id]);
  assert.equal(removeAgent(af,b.id),true);assert.equal(removeAgent(af,'ghost'),false);
  assert.equal(af.agents.find(x=>x.id===c.id).reportsTo,a.id);
  assert.deepEqual(w.steps.map(s=>s.agent),['',c.id]);
});

test('linked work: direct cards, then open cards in linked projects',()=>{
  const db=base();db.agentflow=seedAgentflow();
  const a=newAgent(db.agentflow,{cards:['k3'],projects:['p1'],items:['i1']});
  const w=workFor(db,a);
  assert.deepEqual(w.cards.map(c=>c.id),['k3','k1'],'done cards from projects are left out');
  assert.equal(openWork(db,a),2);
  assert.deepEqual(agentsForCard(db.agentflow,'k3').map(x=>x.id),[a.id]);
  assert.deepEqual(agentsForCard(undefined,'k3'),[]);
});

test('filters match text fields, status, kind and project',()=>{
  const af=seedAgentflow();
  newAgent(af,{name:'Writer',status:'active',tools:['Docs'],projects:['p1']});newAgent(af,{name:'Lead',kind:'human',purpose:'Approves docs'});
  assert.deepEqual(filterAgents(af,{q:'docs'}).map(a=>a.name),['Writer','Lead']);
  assert.deepEqual(filterAgents(af,{q:'docs',kind:'human'}).map(a=>a.name),['Lead']);
  assert.deepEqual(filterAgents(af,{status:'active',project:'p1'}).map(a=>a.name),['Writer']);
  const w=newWorkflow(af,{name:'Weekly',schedule:'Mondays',steps:[newStep({agent:af.agents[0].id,action:'Draft notes'})]});
  assert.deepEqual(filterWorkflows(af,{q:'notes'}).map(x=>x.id),[w.id]);
  assert.deepEqual(filterWorkflows(af,{agent:af.agents[1].id}),[]);
});

test('briefs describe the agent, its workflows and its Flow work',()=>{
  const db=base();db.agentflow=seedAgentflow();
  const lead=newAgent(db.agentflow,{name:'Lead',title:'Ops'});
  const a=newAgent(db.agentflow,{name:'Writer',kind:'agent',status:'active',title:'Content',reportsTo:lead.id,supervisor:'pat',purpose:'Writes copy.',inputs:['Brief'],outputs:['Draft'],
    tools:[],runtime:'Home server',instructions:'Be brief.',cards:['k1'],items:['i1']});
  newWorkflow(db.agentflow,{name:'Publish',trigger:'schedule',schedule:'Fridays',steps:[newStep({agent:lead.id,action:'Plan'}),newStep({agent:a.id,action:'Write',output:'Draft'})]});
  const brief=agentBrief(db,a.id);
  for(const s of ['# Writer','AI agent · Content · Active','Writes copy.','Reports to: Lead (Ops)','Supervised by: Pat Lee','## Inputs\n\n- Brief','## Tools\n\n- None','Runs on: Home server',
    'Publish: step 2: Write','#1 Write copy (Doing, due 2026-11-20)','Go live (deadline, 2026-12-01, planned)','## Instructions\n\nBe brief.'])assert.ok(brief.includes(s),`brief has "${s}"`);
  assert.ok(agentBrief(db,lead.id).includes('Direct reports: Writer (Content)'));
  assert.equal(agentBrief(db,'ghost'),'');
  const wb=workflowBrief(db,db.agentflow.workflows[0].id);
  assert.match(wb,/Workflow · Draft · Schedule: Fridays/);
  assert.match(wb,/1\. \*\*Lead\*\*: Plan\n2\. \*\*Writer\*\*: Write → Draft/);
});

test('the starter template is a small, valid org with a workflow',()=>{
  const db=base();db.agentflow=seedAgentflow();
  const lead=starterAgentflow(db.agentflow);
  assert.equal(db.agentflow.agents.length,4);
  assert.deepEqual(db.agentflow.agents.filter(a=>a.reportsTo===lead.id).length,3);
  assert.ok(db.agentflow.workflows[0].steps.every(s=>db.agentflow.agents.some(a=>a.id===s.agent)));
  assert.deepEqual(cleanAgentflow(JSON.parse(JSON.stringify(db.agentflow)),db),db.agentflow);
});

test('sync counts AgentFlow content, so a workspace with only agents is not mistaken for the sample',()=>{
  const d={charts:[starterChart('seed')],projects:[],timeline:[],devops:{cards:[]}};
  assert.equal(isSeed(d),true);
  const withAgents={...d,agentflow:{agents:[{id:'a',name:'A'}],workflows:[]}};
  assert.equal(isSeed(withAgents),false);
  assert.equal(size(withAgents),size(d)+1);
});

test('canvas: the automatic tree centres managers over their reports',()=>{
  const af=seedAgentflow();
  const a=newAgent(af,{name:'A'}),b=newAgent(af,{name:'B',reportsTo:a.id}),c=newAgent(af,{name:'C',reportsTo:a.id}),d=newAgent(af,{name:'D'});
  const p=treeLayout(af);
  assert.deepEqual([p.get(b.id),p.get(c.id)],[{x:0,y:STEP.y},{x:STEP.x,y:STEP.y}]);
  assert.deepEqual(p.get(a.id),{x:STEP.x/2,y:0});
  assert.deepEqual(p.get(d.id),{x:2*STEP.x,y:0},'a second root tree sits to the right');
  assert.deepEqual([...positions(af)],[...p],'no saved positions: the tree');
});

test('canvas: a big team of individual contributors stacks in indented columns',()=>{
  const af=seedAgentflow();
  const top=newAgent(af,{name:'Top'}),lead=newAgent(af,{name:'Lead',reportsTo:top.id}),sub=newAgent(af,{name:'Sub',reportsTo:lead.id}),solo=newAgent(af,{name:'Solo',reportsTo:sub.id});
  const ics=Array.from({length:STACK.rows+2},(_,i)=>newAgent(af,{name:'IC'+i,reportsTo:lead.id}));
  const p=treeLayout(af),L=p.get(lead.id);
  assert.deepEqual(stacked(af),new Set(ics.map(a=>a.id)),'only reports without reports, and only once there are enough');
  ics.slice(0,STACK.rows).forEach((a,i)=>assert.deepEqual(p.get(a.id),{x:STACK.indent,y:2*STEP.y+i*STACK.y},'first column, one under another'));
  assert.equal(p.get(ics[STACK.rows].id).x,STEP.x+2*STACK.indent,'then a second column');
  assert.ok(p.get(sub.id).x>=p.get(ics.at(-1).id).x+CARD.w,'a report with its own team sits to the right of the columns');
  assert.equal(p.get(sub.id).y,L.y+STEP.y);
  const ps=[...p.values()];
  for(const q of ps)for(const r of ps)if(q!==r)assert.ok(Math.abs(q.x-r.x)>=CARD.w||Math.abs(q.y-r.y)>=CARD.h,'no two cards overlap');
  newAgent(af,{name:'Solo2',reportsTo:sub.id});
  assert.ok(!stacked(af).has(solo.id),'two reports stay side by side');
});

test('canvas: pinning saves what is drawn; agents without a position go under their manager',()=>{
  const af=seedAgentflow();
  const a=newAgent(af,{name:'A'}),b=newAgent(af,{name:'B',reportsTo:a.id});
  const drawn=positions(af);pin(af);
  assert.ok(placed(a)&&placed(b));assert.deepEqual({x:b.x,y:b.y},drawn.get(b.id));
  a.x=400;a.y=96;
  const c=newAgent(af,{name:'C',reportsTo:a.id}),d=newAgent(af,{name:'D',reportsTo:a.id}),e=newAgent(af,{name:'E'});
  const p=positions(af);
  assert.deepEqual(p.get(c.id),{x:400,y:96+STEP.y},'below the manager');
  assert.deepEqual(p.get(d.id),{x:400,y:96+STEP.y+STACK.y},'continues the column below the last sibling');
  assert.equal(p.get(e.id).y,Math.min(a.y,b.y),'a new root goes to the right, at the top');
  assert.ok(p.get(e.id).x>Math.max(a.x,b.x,p.get(d.id).x-1));
  const ps=[...p.values()];
  for(const q of ps)for(const r of ps)if(q!==r)assert.ok(Math.abs(q.x-r.x)>=CARD.w||Math.abs(q.y-r.y)>=CARD.h,'no two cards overlap');
  unpin(af);assert.ok(!af.agents.some(placed));
});

test('canvas: positions are kept through cleaning, clamped, and dropped when not numbers',()=>{
  const af=cleanAgentflow({agents:[{id:'a',name:'A',x:10.4,y:-3},{id:'b',name:'B',x:'5',y:1},{id:'c',name:'C',x:9e9,y:0}]},base());
  assert.deepEqual(af.agents.map(a=>[a.x,a.y]),[[10,-3],[undefined,undefined],[1e5,0]]);
});

test('delegating a card: replaces the set of agents, and changes nothing when an agent is full',()=>{
  const db=base();db.agentflow=seedAgentflow();
  const a=newAgent(db.agentflow,{name:'A'}),b=newAgent(db.agentflow,{name:'B'});
  assert.equal(delegate(db.agentflow,'k1',[a.id,b.id]),null);
  assert.deepEqual([a.cards,b.cards],[['k1'],['k1']]);
  assert.equal(delegate(db.agentflow,'k1',[b.id]),null);
  assert.deepEqual([a.cards,b.cards],[[],['k1']]);
  a.cards=Array.from({length:LIMITS.refs},(_,i)=>'sh.x'+i);
  assert.equal(delegate(db.agentflow,'k3',[a.id,b.id]),a,'a full agent is reported');
  assert.deepEqual(b.cards,['k1'],'and nothing else changed');
});

test('the work queue: open delegated cards, active work first, then due date and number',()=>{
  const db=base();
  db.devops.cards.push({id:'k4',number:4,title:'New, due soon',column:'requests',due:'2026-11-01'},{id:'k5',number:5,title:'New, no date',column:'requests',due:''},
    {id:'k6',number:6,title:'Waiting',column:'uat',due:'2026-10-01'},{id:'k7',number:7,title:'Later',column:'nice',due:''});
  db.agentflow=seedAgentflow();
  const a=newAgent(db.agentflow,{cards:['k7','k6','k5','k4','k2','k1'],projects:['p1']});
  assert.deepEqual(workQueue(db,a.id).map(c=>c.number),[1,4,5,6,7],'Done (#2) is left out; project cards are not queued');
  assert.deepEqual(workQueue(db,'ghost'),[]);
});

test('the DevOps board filters cards by delegated agent',async()=>{
  const {filterCards}=await import('../public/devops-core.js');
  const db=base();db.agentflow=seedAgentflow();
  const a=newAgent(db.agentflow,{cards:['k3']}),b=newAgent(db.agentflow,{cards:['k1']});
  assert.deepEqual(filterCards(db,{agents:[a.id]}).map(c=>c.id),['k3']);
  assert.deepEqual(filterCards(db,{agents:[a.id,b.id]}).map(c=>c.id),['k1','k3']);
  assert.equal(filterCards(db,{agents:[]}).length,3);
});

test('duplicating a workflow: a copy right after it, with new ids for it and its steps',()=>{
  const af=seedAgentflow(),a=newAgent(af,{name:'A'});
  const w=newWorkflow(af,{name:'Ship',status:'active',trigger:'event',schedule:'A card enters UAT',projects:['p1'],steps:[newStep({agent:a.id,action:'Build'}),newStep({action:'Review',output:'Notes'})]});
  const last=newWorkflow(af,{name:'Last'});
  const c=duplicateWorkflow(af,w.id);
  assert.deepEqual(af.workflows.map(x=>x.name),['Ship','Ship (copy)','Last']);
  assert.notEqual(c.id,w.id);
  assert.ok(c.steps.every((s,i)=>s.id!==w.steps[i].id&&s.agent===w.steps[i].agent&&s.action===w.steps[i].action&&s.output===w.steps[i].output),'steps copied with new ids');
  assert.deepEqual([c.status,c.trigger,c.schedule,c.projects],['active','event','A card enters UAT',['p1']]);
  c.projects.push('x');c.steps[0].action='Changed';
  assert.deepEqual([w.projects,w.steps[0].action],[['p1'],'Build'],'the copy shares nothing with the original');
  assert.equal(duplicateWorkflow(af,'ghost'),null);
  assert.ok(duplicateWorkflow(af,newWorkflow(af,{name:'x'.repeat(120)}).id).name.length<=120,'the name stays within its limit');
  assert.equal(last.name,'Last');
});

test('agents are not live until switched on, and runners list what they can run',()=>{
  const db=base();
  db.agentflow=cleanAgentflow({agents:[{id:'a',name:'A'},{id:'b',name:'B',live:'yes'},{id:'c',name:'C',live:true}],
    runners:[{name:' Home ',models:[{id:'x:m1',label:'M1'},{id:'x:m1'},{id:''},{label:'no id'}]},{name:'home'},{name:''},{nope:1}]},db);
  assert.deepEqual(db.agentflow.agents.map(a=>a.live),[false,false,true],'only true is live');
  assert.deepEqual(db.agentflow.runners.map(r=>[r.name,r.models]),[['Home',[{id:'x:m1',label:'M1'}]]],'runner names are unique (any case), model ids too');
  assert.equal(runnerOf(db.agentflow,'HOME').name,'Home');assert.equal(runnerOf(db.agentflow,''),null);
  assert.equal(cleanRunners(Array.from({length:30},(_,i)=>({name:'r'+i}))).length,LIMITS.runners);
  const [a,,c]=db.agentflow.agents;
  assert.deepEqual(filterAgents(db.agentflow,{live:true}).map(x=>x.id),['c']);
  assert.equal(runLine(db.agentflow,a),'');
  assert.equal(liveProblem(db.agentflow,c),'Pick where it runs');
  c.runtime='home';assert.equal(liveProblem(db.agentflow,c),'Pick a model');
  c.model='x:other';assert.equal(liveProblem(db.agentflow,c),'Home did not report x:other');
  c.model='x:m1';assert.equal(liveProblem(db.agentflow,c),'');
  assert.equal(modelLabel(db.agentflow,c),'M1');assert.equal(runLine(db.agentflow,c),'home · M1');
  c.runtime='Elsewhere';c.model='y:z';assert.equal(liveProblem(db.agentflow,c),'','an unreported runner is taken at its word');assert.equal(runLine(db.agentflow,c),'Elsewhere · y:z');
  c.kind='team';assert.equal(liveProblem(db.agentflow,c),'Only AI agents run');
  assert.match(agentBrief(db,'c'),/^# C\n\nTeam · Draft\n/,'teams have no live state in the brief');
  assert.match(agentBrief(db,'a'),/AI agent · Draft · Not live/);
});

test('models: primary then fallbacks, model mirrors the first, older saves keep their model, and auto pools',()=>{
  const db=base(),long='m'.repeat(130);
  db.agentflow=cleanAgentflow({agents:[
    {id:'old',name:'Old',model:'x:m1'},
    {id:'both',name:'Both',model:'x:ignored',models:[' x:m2 ','x:m1','x:m2','',7,long,...Array.from({length:12},(_,i)=>'y:'+i)],auto:'yes'},
    {id:'none',name:'None'},
    {id:'pool',name:'Pool',runtime:'Home',models:['x:m2','x:m1'],auto:true},
  ],runners:[{name:'Home',models:[{id:'x:m1',label:'M1',provider:' Claude ',billing:'included'},{id:'x:m2',label:'M2',provider:'p'.repeat(90),billing:'free'},{id:'x:m3'}]}]},db);
  const [old,both,none,pool]=db.agentflow.agents;
  assert.deepEqual([old.models,old.model,old.auto],[['x:m1'],'x:m1',false],'an older save with only model gets models=[model]');
  assert.equal(both.models.length,LIMITS.agentModels);assert.equal(LIMITS.agentModels,10);
  assert.deepEqual(both.models.slice(0,3),['x:m2','x:m1','m'.repeat(120)],'models win over model: trimmed, unique, non-empty, 120 chars at most');
  assert.equal(both.model,'x:m2','model is always the first of models');assert.equal(both.auto,false,'only true turns auto on');
  assert.deepEqual([none.models,none.model,none.auto],[[],'',false]);
  {const n=newAgent(seedAgentflow());assert.deepEqual([n.models,n.model,n.auto],[[],'',false])}
  assert.deepEqual(db.agentflow.runners[0].models,[{id:'x:m1',label:'M1',provider:'Claude',billing:'included'},{id:'x:m2',label:'M2',provider:'p'.repeat(80)},{id:'x:m3',label:''}],
    'runners keep provider (80 chars) and billing (included or metered only)');
  assert.deepEqual(cleanAgentflow(JSON.parse(JSON.stringify(db.agentflow)),db),db.agentflow,'cleaning is idempotent');

  assert.deepEqual(modelChoices(db.agentflow,pool),[{id:'x:m2',label:'M2',provider:'p'.repeat(80),billing:''},{id:'x:m1',label:'M1',provider:'Claude',billing:'included'}]);
  assert.deepEqual(modelChoices(db.agentflow,old),[{id:'x:m1',label:'x:m1',provider:'',billing:''}],'no runner: the id stands in for the label');
  assert.equal(runLine(db.agentflow,pool),'Home · Auto (2 models)');
  pool.auto=false;assert.equal(runLine(db.agentflow,pool),'Home · M2 +1');assert.equal(modelLabel(db.agentflow,pool),'M2');
  pool.models=['x:m1'];assert.equal(runLine(db.agentflow,pool),'Home · M1');
  pool.live=true;assert.equal(liveProblem(db.agentflow,pool),'');
  pool.models=['x:m1','x:gone'];assert.equal(liveProblem(db.agentflow,pool),'Home did not report x:gone','every listed model must be reported');
  pool.models=[];pool.model='';assert.equal(liveProblem(db.agentflow,pool),'Pick a model');assert.equal(runLine(db.agentflow,pool),'Home');

  pool.models=['x:m1','x:m2'];
  assert.match(agentBrief(db,'pool'),/## Runtime\n\n- Runs on: Home\n- Model 1: M1 \(x:m1\) \(primary\)\n- Model 2: M2 \(x:m2\) \(fallback\)\n/);
  pool.auto=true;
  assert.match(agentBrief(db,'pool'),/- Auto from: M1 \(x:m1\), M2 \(x:m2\) \(the runner picks one per card\)/);
  pool.models=['x:m1'];pool.auto=false;
  assert.match(agentBrief(db,'pool'),/- Model: M1 \(x:m1\)\n/);
  assert.match(agentBrief(db,'old'),/## Runtime\n\n- Model: x:m1\n/);
  assert.doesNotMatch(agentBrief(db,'none'),/## Runtime/);
});
