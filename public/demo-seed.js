// Fictional demo data. Every company, person and project below is made up (Kestrel Group and friends),
// so the open-source app ships no real people or business structure. Pure functions, no DOM or storage.
//   starterChart()           drop-in for store.js seed(): the chart a fresh browser starts with
//   demoWorkspace({today})   a whole workspace that shows every feature: charts (all card and edge
//                            types, an area holding cards, a note), projects under entities, every
//                            timeline kind and status, a release with features, an undated backlog item,
//                            and a DevOps board with cards in every column, labels, roles, checklists,
//                            links, points, overdue and due-soon dates and a linked timeline item.
// Dates are relative to `today` (YYYY-MM-DD) so "overdue" and "due soon" always mean something; the same
// `today` always gives the same workspace.

// The starter keeps the shape and the ids `flygon` and `campaign` of the original seed, because
// verify.mjs drives those cards: seven cards, three 50% ownership links, one unknown percentage.
export function starterChart(id=crypto.randomUUID()){
  return {id,name:'Kestrel · brainstorm',nodes:[
    {id:'flygon',name:'Kestrel Group',type:'entity',x:400,y:0},
    {id:'personal',name:'Side projects',type:'area',x:0,y:288,notes:'Empty for later'},
    {id:'ada',name:'Ada Quill',type:'person',x:320,y:144},
    {id:'bo',name:'Bo Marsh',type:'person',x:656,y:144},
    {id:'quill',name:'Quill Ventures LLC',type:'entity',x:320,y:320},
    {id:'marsh',name:'Marsh Holdings LLC',type:'entity',x:656,y:320},
    {id:'campaign',name:'Campfire Studio',type:'entity',x:496,y:544}],
  edges:[
    {id:'g1',from:'flygon',to:'personal',type:'group',percent:''},
    {id:'g2',from:'flygon',to:'quill',type:'group',percent:''},
    {id:'g3',from:'flygon',to:'marsh',type:'group',percent:''},
    {id:'o1',from:'ada',to:'quill',type:'ownership',percent:'50'},
    {id:'o2',from:'bo',to:'marsh',type:'ownership',percent:''},
    {id:'o3',from:'quill',to:'campaign',type:'ownership',percent:'50'},
    {id:'o4',from:'marsh',to:'campaign',type:'ownership',percent:'50'}]};
}

const day=(today,n)=>{const d=new Date(today+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const at=(today,n)=>day(today,n)+'T16:00:00.000Z';

export function demoWorkspace({today=new Date().toISOString().slice(0,10)}={}){
  const D=n=>day(today,n),T=n=>at(today,n);
  const structure={id:'demo-structure',name:'Kestrel · structure',nodes:[
    {id:'kestrel',name:'Kestrel Group',type:'entity',x:528,y:0,notes:'Fictional holding company for the demo.'},
    {id:'ada',name:'Ada Quill',type:'person',x:288,y:144},
    {id:'bo',name:'Bo Marsh',type:'person',x:784,y:144},
    {id:'quill',name:'Quill Ventures LLC',type:'entity',x:288,y:320},
    {id:'marsh',name:'Marsh Holdings LLC',type:'entity',x:784,y:320},
    {id:'campfire',name:'Campfire Studio',type:'entity',x:528,y:496},
    {id:'rnd',name:'R&D',type:'area',x:0,y:640,w:464,h:224,notes:'Moving this area moves the cards inside it.'},
    {id:'lantern',name:'Lantern Apps',type:'entity',x:32,y:704},
    {id:'cleo',name:'Cleo Park',type:'person',x:240,y:784},
    {id:'dev',name:'Dev Okafor',type:'person',x:32,y:784},
    {id:'mina',name:'Mina Torres',type:'person',x:784,y:704},
    {id:'note',name:'Percentages are made up: this is demo data.',type:'note',x:784,y:832,w:240,h:64}],
  edges:[
    {id:'e1',from:'kestrel',to:'quill',type:'group',percent:''},
    {id:'e2',from:'kestrel',to:'marsh',type:'group',percent:''},
    {id:'e3',from:'ada',to:'quill',type:'ownership',percent:'60'},
    {id:'e4',from:'bo',to:'marsh',type:'ownership',percent:''},
    {id:'e5',from:'quill',to:'campfire',type:'ownership',percent:'50'},
    {id:'e6',from:'marsh',to:'campfire',type:'ownership',percent:'50'},
    {id:'e7',from:'campfire',to:'lantern',type:'ownership',percent:'100'},
    {id:'e8',from:'kestrel',to:'rnd',type:'group',percent:''},
    {id:'e9',from:'mina',to:'campfire',type:'group',percent:''}]};
  const team={id:'demo-team',name:'Campfire · team',nodes:[
    {id:'t-lead',name:'Mina Torres',type:'person',x:320,y:0,notes:'Product lead'},
    {id:'t-eng',name:'Engineering',type:'area',x:0,y:144,w:400,h:176},
    {id:'t-cleo',name:'Cleo Park',type:'person',x:32,y:208},
    {id:'t-dev',name:'Dev Okafor',type:'person',x:208,y:208},
    {id:'t-ops',name:'Support desk',type:'entity',x:528,y:208}],
  edges:[{id:'t1',from:'t-lead',to:'t-eng',type:'group',percent:''},{id:'t2',from:'t-lead',to:'t-ops',type:'group',percent:''}]};

  const projects=[
    {id:'p-lantern',name:'Lantern',color:'#7cb980',entity:'lantern'},
    {id:'p-site',name:'Campfire site',color:'#a8524c',entity:'campfire'},
    {id:'p-ops',name:'Ops',color:'#2f8a95',entity:'rnd'},
    {id:'p-brand',name:'Brand',color:'#8a4fb3',entity:''}];
  const item=(id,title,kind,status,start,o={})=>({id,title,kind,status,start,end:'',priority:'',release:'',projects:[],owner:'',link:'',notes:'',...o});
  const timeline=[
    item('i-release','Lantern 1.0','release','planned',D(45),{projects:['p-lantern'],owner:'Mina Torres',notes:'Features below target this release.'}),
    item('i-signup','Sign-up flow','feature','active',D(-10),{end:D(20),priority:'high',release:'Lantern 1.0',projects:['p-lantern'],owner:'Cleo Park'}),
    item('i-offline','Offline mode','feature','risk',D(5),{end:D(40),priority:'medium',release:'Lantern 1.0',projects:['p-lantern'],owner:'Dev Okafor',notes:'At risk: depends on the sync rewrite.'}),
    item('i-themes','Dark theme','feature','planned','',{priority:'low',release:'Lantern 1.0',projects:['p-lantern','p-brand'],notes:'Undated: a backlog item that shows on the Board and List only.'}),
    item('i-beta','Private beta','milestone','planned',D(21),{projects:['p-lantern']}),
    item('i-launch','Site launch','deadline','blocked',D(-3),{projects:['p-site'],owner:'Mina Torres',notes:'Overdue and blocked on copy review.'}),
    item('i-redesign','Site redesign','project','active',D(-30),{end:D(30),projects:['p-site','p-brand']}),
    item('i-sprint','Sprint 14','phase','active',D(-4),{end:D(10),projects:['p-lantern','p-ops']}),
    item('i-expo','Maker Expo booth','event','planned',D(60),{end:D(62),projects:['p-brand'],link:'https://example.com/expo'}),
    item('i-audit','Security review','milestone','done',D(-20),{projects:['p-ops'],owner:'Dev Okafor'}),
    item('i-print','Print catalogue','project','cancelled',D(-60),{end:D(-40),projects:['p-brand']})];

  const labels=[['l-urgent','Urgent','urgency','red-deep'],['l-high','High','priority','orange'],['l-medium','Medium','priority','yellow'],['l-low','Low','priority','slate'],
    ['l-frontend','Frontend','area','blue'],['l-backend','Backend','area','purple'],['l-design','Design','area','pink'],['l-infra','Infra','area','teal'],['l-marketing','Marketing','area','green'],
    ['l-research','Research','topic','indigo'],['l-customer','Customer ask','other','amber']].map(([id,name,section,color])=>({id,name,section,color}));
  let n=0;
  const card=(id,title,column,o={})=>({id,number:++n,title,description:'',column,project:'',labels:[],points:null,due:'',assignees:[],checklist:[],links:[],item:'',created:T(-14+n),updated:T(-7+n),moved:T(-7+n),...o});
  const dev=node=>({node,role:'developer'}),tester=node=>({node,role:'tester'}),req=node=>({node,role:'requester'});
  const cards=[
    card('c-form','Build the sign-up form','doing',{project:'p-lantern',labels:['l-high','l-frontend'],points:3,due:D(1),item:'i-signup',assignees:[dev('cleo'),req('mina')],
      description:'Email and password with inline validation. Due tomorrow, so it shows amber.',checklist:[{id:'k1',text:'Email field',done:true},{id:'k2',text:'Validation',done:false},{id:'k3',text:'Error states',done:false}],
      links:[{id:'L1',kind:'pr',url:'https://github.com/example/lantern/pull/42'}]}),
    card('c-verify','Email verification','uat',{project:'p-lantern',labels:['l-backend'],points:2,item:'i-signup',assignees:[dev('dev'),tester('cleo')],
      description:'Built and waiting for testing. Approve moves it to Done.',links:[{id:'L2',kind:'commit',url:'https://github.com/example/lantern/commit/0000000'}]}),
    card('c-sync','Sync rewrite','blocked',{project:'p-lantern',labels:['l-urgent','l-backend'],points:8,due:D(-2),item:'i-offline',assignees:[dev('dev')],
      description:'Overdue (red) and blocked on the storage decision.'}),
    card('c-copy','Launch copy review','requests',{project:'p-site',labels:['l-marketing','l-customer'],due:D(6),assignees:[req('mina')],
      description:'No developer yet: dragging it into Doing asks who develops it.'}),
    card('c-logo','Refresh the logo lockup','requests',{project:'p-brand',labels:['l-design','l-medium']}),
    card('c-audit','Fix the review findings','done',{project:'p-ops',labels:['l-infra'],points:5,item:'i-audit',assignees:[dev('dev'),tester('cleo')],
      checklist:[{id:'k4',text:'Rotate test keys',done:true},{id:'k5',text:'Tighten headers',done:true}],links:[{id:'L3',kind:'url',url:'https://example.com/review'}]}),
    card('c-dark','Dark theme tokens','must',{project:'p-lantern',labels:['l-design','l-low'],item:'i-themes'}),
    card('c-research','Interview five beta users','nice',{project:'p-lantern',labels:['l-research'],points:1}),
    card('c-alerts','Uptime alerts','must',{project:'p-ops',labels:['l-infra','l-high'],points:2})];

  return {active:structure.id,charts:[structure,team],projects,timeline,
    devops:{columns:[['requests','Requests / Sprinted'],['doing','Doing'],['blocked','Blocked'],['uat','UAT'],['done','Done'],['must','Backlog: Must Have'],['nice','Backlog: Nice to Have']].map(([id,name])=>({id,name})),cards,nextNumber:n+1,labels},
    environment:{id:'kestrel-demo',name:'Kestrel demo',ownerEmail:'',visibility:'private',members:[]}};
}
