// AgentFlow data rules (public/agentflow-core.js): validation, the org tree, removal and briefs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cleanAgentflow,seedAgentflow,newAgent,newWorkflow,newStep,removeAgent,descendants,chainOf,canReportTo,workflowsFor,agentsForCard,
  workFor,openWork,full,LIMITS,treeLayout,positions,pin,unpin,placed,CARD,STEP,STACK,stacked,reportLines,pathOf,delegate,workQueue,filterAgents,filterWorkflows,agentBrief,workflowBrief,starterAgentflow,duplicateWorkflow,cleanRunners,runnerOf,runLine,modelLabel,liveProblem,modelChoices,modelMaker,personNamed,isSessionPerson,sameName,normName,
  cleanJobs,reportRunner,JOBS_STALE,jobsOf,jobGroups,jobOf,promotedAgent,promoteJob,cardH,AGENT_KINDS} from '../public/agentflow-core.js';
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

// Straight segments of the drawn line pieces: [{x1,y1,x2,y2}] (corners are left out).
const segs=pieces=>pieces.filter(q=>q.pts).flatMap(q=>q.pts.slice(1).map((b,i)=>({a:q.pts[i],b}))).filter(({a,b})=>a.x!==b.x||a.y!==b.y);
// Two axis-aligned segments on one line that share more than a point.
const overlap=(s,t)=>{
  const h=s.a.y===s.b.y&&t.a.y===t.b.y&&s.a.y===t.a.y,v=s.a.x===s.b.x&&t.a.x===t.b.x&&s.a.x===t.a.x;
  if(!h&&!v)return false;
  const k=h?'x':'y',lo=Math.max(Math.min(s.a[k],s.b[k]),Math.min(t.a[k],t.b[k])),hi=Math.min(Math.max(s.a[k],s.b[k]),Math.max(t.a[k],t.b[k]));
  return hi-lo>.5;
};
const noRepeats=pieces=>{const ss=segs(pieces);for(let i=0;i<ss.length;i++)for(let j=i+1;j<ss.length;j++)assert.ok(!overlap(ss[i],ss[j]),`segment drawn twice: ${JSON.stringify([ss[i],ss[j]])}`)};

test('canvas: a manager\'s reporting lines are one trunk, one bus and a drop each, never drawn twice',()=>{
  const af=seedAgentflow(),top=newAgent(af,{name:'Top'});
  const leads=Array.from({length:4},(_,i)=>newAgent(af,{name:'L'+i,reportsTo:top.id}));
  for(const l of leads.slice(0,2))newAgent(af,{name:'Sub of '+l.name,reportsTo:l.id}); // keeps L0, L1 out of a stack
  const ics=Array.from({length:STACK.rows+3},(_,i)=>newAgent(af,{name:'IC'+i,reportsTo:leads[0].id}));
  const pos=treeLayout(af),{pieces,routes}=reportLines(af,pos);
  noRepeats(pieces);
  assert.equal(routes.size,af.agents.length-1,'every report has its own route (for hit areas and the chain highlight)');
  const T=pos.get(top.id),ym=T.y+CARD.h+(STEP.y-CARD.h)/2;
  const bus=segs(pieces).filter(s=>s.a.y===ym&&s.b.y===ym&&Math.abs(s.a.x-s.b.x)>8);
  assert.equal(bus.length,1,'one bus under the top manager');
  const xs=leads.map(l=>pos.get(l.id).x+CARD.w/2);
  assert.ok(Math.min(bus[0].a.x,bus[0].b.x)<=Math.min(...xs)+8&&Math.max(bus[0].a.x,bus[0].b.x)>=Math.max(...xs)-8,'the bus spans the reports (less the rounded corners)');
  // The stacked team: one spine per column, a stub per card, entering the card's side.
  const cols=new Set(ics.map(a=>pos.get(a.id).x));
  const spines=segs(pieces).filter(s=>s.a.x===s.b.x&&[...cols].some(x=>s.a.x===x-STACK.indent/2));
  assert.equal(spines.length,cols.size,'one spine per stacked column');
  for(const a of ics){const r=pos.get(a.id);assert.ok(routes.get(a.id).endsWith(`L${r.x} ${r.y+CARD.h/2}`),'a stacked report\'s route ends at its side')}
});

test('canvas: one report is a single elbow; a report above or beside its manager gets its own curve',()=>{
  const af=seedAgentflow(),m=newAgent(af,{name:'M'}),r=newAgent(af,{name:'R',reportsTo:m.id}),up=newAgent(af,{name:'Up',reportsTo:m.id});
  const pos=new Map([[m.id,{x:0,y:200}],[r.id,{x:300,y:200+STEP.y}],[up.id,{x:400,y:0}]]);
  const {pieces,routes}=reportLines(af,pos,new Set());
  noRepeats(pieces);
  assert.ok(pieces.some(q=>q.d&&q.owners.join()===up.id)&&/C/.test(routes.get(up.id)),'the report above is a curve of its own');
  assert.ok(routes.get(r.id).startsWith(`M${CARD.w/2} ${200+CARD.h}`)&&routes.get(r.id).endsWith(`L${300+CARD.w/2} ${200+STEP.y}`)&&/Q/.test(routes.get(r.id)),'the one below is a rounded elbow from the manager to its top');
  // A report straight below its manager is one straight line.
  const pos2=new Map([[m.id,{x:0,y:0}],[r.id,{x:0,y:STEP.y}]]),one=reportLines({agents:[m,r]},pos2,new Set());
  assert.equal(one.routes.get(r.id),`M${CARD.w/2} ${CARD.h}L${CARD.w/2} ${STEP.y}`);
  noRepeats(one.pieces);
  assert.equal(pathOf([{x:0,y:0},{x:0,y:20},{x:20,y:20}],[0,8,0]),'M0 0L0 12Q0 20 8 20L20 20','corners are rounded');
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

test('model makers: the icon follows who made the model, not the harness that runs it',()=>{
  const k=(id,label)=>modelMaker(id,label).key;
  assert.equal(k('claudeAgent:claude-sonnet-5-5','Claude Sonnet 5.5'),'anthropic');
  assert.equal(k('cursor:claude-opus-5-5'),'anthropic','Cursor runs it, Anthropic made it');
  assert.equal(k('opencode:vercel/anthropic/claude-haiku-4.5'),'anthropic');
  assert.equal(k('claudeAgent:sonnet'),'anthropic');
  assert.equal(k('codex:gpt-6.1-sol'),'openai');assert.equal(k('opencode:orcarouter/openai/gpt-5.4-mini'),'openai');
  assert.equal(k('x:o3-mini'),'openai');assert.equal(k('codex:some-new-model'),'openai','a one-maker harness is the last hint');
  assert.equal(k('antigravity:gemini-3.8-flash-high'),'google');
  assert.equal(k('grok:grok-4.7'),'xai');assert.equal(k('cursor_cursor_pmd:grok-4.7'),'xai');
  assert.equal(k('opencode:meta-llama/llama-4-scout'),'meta');assert.equal(k('x:qwen3-coder'),'qwen');
  assert.equal(k('x:deepseek-v4'),'deepseek');assert.equal(k('x:mistralai/devstral-2'),'mistral');
  assert.equal(k('x:moonshotai/kimi-k3'),'moonshot');assert.equal(k('x:z-ai/glm-5'),'zhipu');
  assert.equal(k('opencode:abliteration/abliterated-model-large-v2'),'abliterated');
  assert.equal(k('cursor:composer-2'),'cursor');
  for(const id of ['cursor:default','opencode:openrouter/auto','x:auto-smart'])assert.equal(k(id),'auto',id);
  assert.equal(k('x:anything','Auto'),'auto','a router labelled Auto');
  assert.deepEqual(modelMaker('opencode:opencode/big-pickle'),{key:'other',name:'',letter:'B'},'unknown: a letter tile');
  assert.equal(modelMaker('opencode:opencode/big-pickle','Pickle').letter,'P','the label wins for the letter');
  assert.equal(modelMaker('','').letter,'?');assert.equal(modelMaker(null).key,'other');
});

test('matching the signed-in user to a person card: email first, then a unique name',()=>{
  const me={email:'ari@example.com',name:'Ari  Example'};
  const ari={id:'a',name:' ari example ',type:'person'},pat={id:'p',name:'Pat Lee',type:'person',email:'pat@example.com'};
  assert.equal(normName('  Ari \t Example '),'ari example');
  assert.ok(sameName('ARI EXAMPLE','ari  example'));assert.ok(!sameName('',''));
  assert.ok(isSessionPerson({id:'x',name:'Someone',email:' ARI@example.com '},[pat],me),'email match');
  assert.ok(!isSessionPerson(pat,[pat],me),'someone else\'s email');
  assert.ok(!isSessionPerson({id:'y',name:'Ari Example',email:'other@example.com'},[],me),'an email that is not theirs beats the name');
  assert.ok(isSessionPerson(ari,[ari,pat],me),'unique name, no email');
  const twin={id:'b',name:'Ari Example',type:'person'};
  assert.ok(!isSessionPerson(ari,[ari,twin,pat],me),'two people with that name: no match');
  assert.equal(personNamed([ari,twin],'ari example'),null);assert.equal(personNamed([ari,pat],'Ari Example'),ari);assert.equal(personNamed([ari],''),null);
  assert.ok(!isSessionPerson(ari,[ari,{id:'m',name:'Me',email:'ari@example.com'}],me),'a card with their email is them, not the namesake');
  assert.ok(!isSessionPerson(ari,[ari],null),'no session');
  assert.ok(!isSessionPerson(ari,[ari],{email:'ari@example.com',name:''}),'session without a name');
});

// ---------- scheduled jobs and automations ----------
const job=(id,o={})=>({id,name:id,source:'systemd',schedule:'Daily',...o});
test('runner jobs are cleaned: unique ids, trimmed text within limits, defaults, and up to 500',()=>{
  const js=cleanJobs([job(' a '),job('a',{name:'dup'}),{id:''},{name:'no id'},null,
    {id:'b',name:'  B  ',source:'s'.repeat(50),group:' ',schedule:'x'.repeat(300),cron:' 0 2 * * * ',command:'c'.repeat(400),ai:'yes',enabled:false,lastRun:'nope',lastStatus:'exploded',nextRun:'2026-11-02T00:00:00Z'},
    {id:'c'}]);
  assert.deepEqual(js.map(j=>j.id),['a','b','c'],'the first of an id wins; jobs need an id');
  const [a,b,c]=js;
  assert.deepEqual(a,{id:'a',name:'a',source:'systemd',schedule:'Daily',ai:false,enabled:true,lastStatus:'unknown'});
  assert.deepEqual([b.name,b.source.length,'group' in b,b.schedule.length,b.cron,b.command.length,b.ai,b.enabled,'lastRun' in b,b.lastStatus,b.nextRun],
    ['B',40,false,200,'0 2 * * *',300,false,false,false,'unknown','2026-11-02T00:00:00Z']);
  assert.deepEqual([c.name,c.source,c.schedule],['c','other',''],'name defaults to the id, source to other');
  assert.equal(cleanJobs(Array.from({length:600},(_,i)=>job('j'+i))).length,LIMITS.jobs);
  assert.equal(cleanJobs([job('x'.repeat(250))])[0].id.length,200);
  const af=cleanAgentflow({runners:[{name:'Home',jobs:[job('a'),job('a')],jobsReported:'bad'},{name:'Old'}]},{});
  assert.deepEqual([af.runners[0].jobs.length,'jobsReported' in af.runners[0],af.runners[1].jobs],[1,false,[]],'older runners get an empty job list');
});

test('reporting jobs: only real changes are saved; lastRun and nextRun alone wait six hours',()=>{
  const T0='2026-11-01T10:00:00.000Z',later=h=>new Date(Date.parse(T0)+h*3600e3).toISOString();
  const models=[{id:'x:m',label:'M'}],j=(o={})=>job('backup',{lastStatus:'ok',lastRun:T0,nextRun:later(24),...o});
  let r=reportRunner(null,'Home',{models,jobs:[j()]},T0);
  assert.ok(r.changed);assert.deepEqual([r.runner.jobsReported,r.runner.reported,r.runner.jobs.length],[T0,T0,1]);
  const had=r.runner;
  r=reportRunner(had,'home',{models,jobs:[j()]},later(1));
  assert.deepEqual([r.changed,r.runner],[false,had],'the same report saves nothing');
  r=reportRunner(had,'Home',{models,jobs:[j({lastRun:later(1),nextRun:later(25)})]},later(1));
  assert.equal(r.changed,false,'a moved lastRun / nextRun alone is not saved');
  r=reportRunner(had,'Home',{models,jobs:[j({lastRun:later(1),lastStatus:'failed'})]},later(1));
  assert.ok(r.changed,'a status flip is saved');assert.equal(r.runner.jobs[0].lastRun,later(1),'with the new times');
  r=reportRunner(had,'Home',{models,jobs:[j({schedule:'Hourly'})]},later(1));assert.ok(r.changed,'another field changed');
  r=reportRunner(had,'Home',{models,jobs:[j(),job('new')]},later(1));assert.ok(r.changed,'a new job');
  r=reportRunner(had,'Home',{models,jobs:[j({lastRun:later(7)})]},later(7));
  assert.deepEqual([r.changed,r.runner.jobsReported,r.runner.jobs[0].lastRun],[true,later(7),later(7)],'after six hours the times are refreshed');
  assert.equal(JOBS_STALE,6*3600e3);
  r=reportRunner(had,'Home',{models,jobs:[j()]},later(7));assert.equal(r.changed,false,'nothing to refresh: still nothing saved');
  r=reportRunner(had,'Home',{models},later(1));assert.equal(r.changed,false,'jobs left out: unchanged models save nothing');
  r=reportRunner(had,'Home',{models:[]},later(1));
  assert.deepEqual([r.changed,r.runner.jobs,r.runner.jobsReported],[true,had.jobs,T0],'jobs left out are kept, with their jobsReported');
  r=reportRunner(had,'Home',{models,jobs:[]},later(1));
  assert.deepEqual([r.changed,r.runner.jobs,r.runner.jobsReported],[true,[],later(1)],'[] clears them');
  r=reportRunner({...had,jobsReported:undefined},'Home',{models,jobs:[j({nextRun:later(30)})]},later(1));assert.ok(r.changed,'never saved before: saved');
  assert.equal(reportRunner(null,'X',{models}).runner.jobsReported,undefined,'no jobs, no jobsReported');
});

test('automations: never live, no model needed, their schedule on the card, shorter cards',()=>{
  const db=base();
  db.agentflow=cleanAgentflow({agents:[{id:'a',name:'Backup',kind:'automation',live:true,schedule:' Daily 22:30 ',models:['x:m'],job:{runner:' Home ',id:'systemd:backup.timer'}},
    {id:'b',name:'B',schedule:'s'.repeat(300),job:{runner:'',id:'x'}},{id:'c',name:'C',job:'nope'}]},db);
  const [a,b,c]=db.agentflow.agents;
  assert.equal(AGENT_KINDS.automation,'Automation');
  assert.deepEqual([a.kind,a.live,a.schedule,a.job],['automation',false,' Daily 22:30 ',{runner:'Home',id:'systemd:backup.timer'}],'automations are never live');
  assert.deepEqual([b.schedule.length,'job' in b,'job' in c,c.schedule],[200,false,false,''],'a job link needs a runner and an id');
  assert.equal(liveProblem(db.agentflow,a),'','automations need no runner or model');
  assert.equal(runLine(db.agentflow,a),'Daily 22:30','the card shows the schedule, not runner or model');
  assert.deepEqual([cardH(a),cardH(c)],[CARD.auto,CARD.h]);
  assert.ok(CARD.auto<CARD.h);
  const brief=agentBrief(db,'a');
  assert.match(brief,/^# Backup\n\nAutomation · Draft\n/,'no live state in the brief');
  assert.match(brief,/- Schedule: Daily 22:30\n- Promoted from: Home · systemd:backup\.timer \(no longer reported\)/);
  assert.doesNotMatch(brief,/Model/,'automations list no models');
  assert.deepEqual(filterAgents(db.agentflow,{q:'22:30'}).map(x=>x.id),['a'],'search matches the schedule');
  assert.deepEqual(filterAgents(db.agentflow,{kind:'automation'}).map(x=>x.id),['a']);
});

test('jobs across runners, grouped for display, and promoted into the org once',()=>{
  const db=base();
  db.agentflow=cleanAgentflow({agents:[{id:'lead',name:'Lead'}],runners:[
    {name:'Zeta',jobs:[job('z1',{name:'Zed'})]},
    {name:'Home',models:[{id:'x:m',label:'M'}],jobs:[job('t2',{name:'beta',group:'Timers'}),job('t1',{name:'Alpha',group:'Timers'}),job('loose',{name:'Loose'}),
      job('vercel:app:/api/cron/sync',{name:'Sync',source:'vercel',group:'Vercel · app',cron:'*/5 * * * *',schedule:'',command:'GET /api/cron/sync',enabled:false}),
      job('ai',{name:'Digest',source:'claude',ai:true,schedule:'Weekdays 08:00',command:'Write the digest'}),job('odd',{source:'Nomad'})]}]},db);
  const af=db.agentflow;
  assert.deepEqual(jobsOf(af).map(j=>`${j.runner}/${j.id}`),['Zeta/z1','Home/t2','Home/t1','Home/loose','Home/vercel:app:/api/cron/sync','Home/ai','Home/odd']);
  const gs=jobGroups(af);
  assert.deepEqual(gs.map(g=>[g.label,g.runner,g.jobs.length]),[['Home','Home',3],['Timers','Home',2],['Vercel · app','Home',1],['Zeta','Zeta',1]],'runner, then its ungrouped jobs, then groups by name');
  assert.deepEqual(gs[1].jobs.map(j=>j.name),['Alpha','beta'],'jobs by name');
  assert.equal(new Set(gs.map(g=>g.key)).size,gs.length,'keys are unique');
  assert.equal(jobOf(af,'home','t1').name,'Alpha');assert.equal(jobOf(af,'Home','nope'),null);assert.equal(jobOf(af,'Nobody','t1'),null);

  const n0=af.agents.length,auto=promoteJob(af,'home','vercel:app:/api/cron/sync',{reportsTo:'lead'});
  assert.deepEqual([auto.kind,auto.name,auto.title,auto.schedule,auto.runtime,auto.purpose,auto.status,auto.live,auto.reportsTo,auto.job,auto.models],
    ['automation','Sync','Vercel cron','*/5 * * * *','','GET /api/cron/sync','paused',false,'lead',{runner:'Home',id:'vercel:app:/api/cron/sync'},[]],
    'a job without AI becomes an automation: the cron line when it has no schedule text, paused when disabled');
  const ai=promoteJob(af,'Home','ai');
  assert.deepEqual([ai.kind,ai.title,ai.schedule,ai.runtime,ai.status,ai.live,ai.reportsTo],['agent','Claude schedule','Weekdays 08:00','Home','active',false,''],'an AI job becomes an AI agent on its runner, top level');
  assert.equal(promoteJob(af,'Home','odd',{reportsTo:'ghost'}).title,'Nomad job','unknown sources read as "<source> job"; unknown managers mean top level');
  assert.equal(promoteJob(af,'Home','odd').reportsTo,'');
  assert.equal(af.agents.length,n0+3);
  assert.equal(promoteJob(af,'HOME','ai'),ai,'a job is promoted once: again returns the agent it became');
  assert.equal(af.agents.length,n0+3,'and adds nothing');
  assert.equal(promotedAgent(af,'home','ai'),ai);assert.equal(promotedAgent(af,'Home','t1'),null);
  assert.equal(promoteJob(af,'Home','missing'),null,'unknown jobs are refused');
  const placedOne=promoteJob(af,'Home','t1',{x:999.6,y:-40});
  assert.deepEqual([placedOne.x,placedOne.y],[1000,-40]);assert.ok(af.agents.every(placed),'a drop position pins the rest where they were drawn');
  assert.match(agentBrief(db,ai.id),/- Runs on: Home\n- Schedule: Weekdays 08:00\n- Promoted from: Home · Digest \(Write the digest\)/);
  const cleaned=cleanAgentflow(structuredClone(af),db);
  assert.deepEqual(cleaned.agents.find(x=>x.id===auto.id).job,auto.job,'the link survives cleaning');
  while(af.agents.length<LIMITS.agents)newAgent(af);
  assert.equal(promoteJob(af,'Home','t2'),null,'refused at the agent limit');
});
