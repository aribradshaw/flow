// The client's workspace cleaners for Node. public/store.js cannot be imported on the server (it
// touches the DOM and localStorage when it loads), so validChart, cleanProject and cleanItem are
// copied here verbatim; the DevOps board and AgentFlow use public/devops-core.js and public/agentflow-core.js directly. test/api-v1.test.mjs
// runs the copies against the originals in store.js and fails if they drift apart.
import {cleanDevops} from '../public/devops-core.js';
import {cleanWorkflow} from '../public/workflow.js';
import {cleanAgentflow} from '../public/agentflow-core.js';

const DATE=/^\d{4}-\d{2}-\d{2}$/,COLOR=/^#[0-9a-f]{6}$/i;
export const ITEM_KINDS=['feature','milestone','release','deadline','project','phase','event'];
export const ITEM_PRIORITY=['high','medium','low'];
export const ITEM_STATUS=['planned','active','risk','blocked','done','cancelled'];
export const PALETTE=['#7cb980','#a8524c','#2f7d62','#3d6fb6','#b0662f','#8a4fb3','#c0464f','#2f8a95','#9a8424','#5b6b7a','#c45f9a','#4f8a3d'];

const size=v=>v===undefined||(Number.isFinite(v)&&v>0&&v<=5000);
export function validChart(c){
  if(!c||typeof c.name!=='string'||!Array.isArray(c.nodes)||!Array.isArray(c.edges)||c.nodes.length>2000||c.edges.length>5000)return false;
  const nodes=new Set(),edges=new Set();
  for(const n of c.nodes){if(typeof n.id!=='string'||nodes.has(n.id)||typeof n.name!=='string'||!['entity','person','area','note'].includes(n.type)||!Number.isFinite(n.x)||!Number.isFinite(n.y)||!size(n.w)||!size(n.h))return false;nodes.add(n.id)}
  for(const e of c.edges){if(typeof e.id!=='string'||edges.has(e.id)||nodes.has(e.id)||!nodes.has(e.from)||!nodes.has(e.to)||e.from===e.to||!['ownership','group'].includes(e.type)||(e.percent!==''&&(!Number.isFinite(Number(e.percent))||Number(e.percent)<0||Number(e.percent)>100)))return false;edges.add(e.id)}
  return true;
}
export function cleanProject(p,i=0){return p&&typeof p.id==='string'&&typeof p.name==='string'?{id:p.id,name:p.name.slice(0,80),color:COLOR.test(p.color)?p.color:PALETTE[i%PALETTE.length],entity:typeof p.entity==='string'?p.entity:''}:null}
export function cleanItem(i,projects){
  if(!i||typeof i.id!=='string'||typeof i.title!=='string'||!(DATE.test(i.start)||i.start===''))return null;
  return {id:i.id,title:i.title.slice(0,200),kind:ITEM_KINDS.includes(i.kind)?i.kind:'milestone',status:ITEM_STATUS.includes(i.status)?i.status:'planned',start:i.start,end:i.start&&DATE.test(i.end||'')&&i.end>=i.start?i.end:'',
    priority:ITEM_PRIORITY.includes(i.priority)?i.priority:'',release:typeof i.release==='string'?i.release:'',
    projects:Array.isArray(i.projects)?[...new Set(i.projects)].filter(p=>projects.some(x=>x.id===p)):[],owner:String(i.owner??'').slice(0,120),link:String(i.link??'').slice(0,500),notes:String(i.notes??'').slice(0,4000),
    ...(typeof i.inbox?.sig==='string'?{inbox:{at:String(i.inbox.at||''),sig:i.inbox.sig.slice(0,8000)}}:{})};
}
// store.js normalize(), minus the environment record: the server stamps that on every write.
export function normalize(db){
  db.workflow=cleanWorkflow(db.workflow);
  db.projects=(Array.isArray(db.projects)?db.projects:[]).map(cleanProject).filter(Boolean);
  db.timeline=(Array.isArray(db.timeline)?db.timeline:[]).map(i=>cleanItem(i,db.projects)).filter(Boolean);
  db.devops=cleanDevops(db.devops,db);
  db.agentflow=cleanAgentflow(db.agentflow,db);
  return db;
}
