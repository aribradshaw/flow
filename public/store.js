import {uid,clone} from './ui.js';
import {cleanDevops} from './devops-core.js';
import {starterChart} from './demo-seed.js';
import {cleanWorkflow} from './workflow.js';
// Persistence, validation and whole-database undo. Charts keep the original v1 schema;
// projects, timeline and devops are additive fields, so older saves load unchanged.
// The app is now "Flygon Flow", but the storage key keeps its original name on purpose:
// renaming it would orphan every chart already saved in this browser.
const KEY='org-chart-studio-v1',DATE=/^\d{4}-\d{2}-\d{2}$/,COLOR=/^#[0-9a-f]{6}$/i;
export const ITEM_KINDS=['feature','milestone','release','deadline','project','phase','event'];
export const ITEM_PRIORITY=['high','medium','low'];
export const ITEM_STATUS=['planned','active','risk','blocked','done','cancelled'];
// Flygon brand green and brick first, then the original palette.
export const PALETTE=['#7cb980','#a8524c','#2f7d62','#3d6fb6','#b0662f','#8a4fb3','#c0464f','#2f8a95','#9a8424','#5b6b7a','#c45f9a','#4f8a3d'];

function seed(){return starterChart(uid())}

const size=v=>v===undefined||(Number.isFinite(v)&&v>0&&v<=5000);
export function validChart(c){
  if(!c||typeof c.name!=='string'||!Array.isArray(c.nodes)||!Array.isArray(c.edges)||c.nodes.length>2000||c.edges.length>5000)return false;
  const nodes=new Set(),edges=new Set();
  for(const n of c.nodes){if(typeof n.id!=='string'||nodes.has(n.id)||typeof n.name!=='string'||!['entity','person','area','note'].includes(n.type)||!Number.isFinite(n.x)||!Number.isFinite(n.y)||!size(n.w)||!size(n.h))return false;nodes.add(n.id)}
  for(const e of c.edges){if(typeof e.id!=='string'||edges.has(e.id)||nodes.has(e.id)||!nodes.has(e.from)||!nodes.has(e.to)||e.from===e.to||!['ownership','group'].includes(e.type)||(e.percent!==''&&(!Number.isFinite(Number(e.percent))||Number(e.percent)<0||Number(e.percent)>100)))return false;edges.add(e.id)}
  return true;
}
// A project may sit under a chart card (entity or area) via its node id.
export function cleanProject(p,i=0){return p&&typeof p.id==='string'&&typeof p.name==='string'?{id:p.id,name:p.name.slice(0,80),color:COLOR.test(p.color)?p.color:PALETTE[i%PALETTE.length],entity:typeof p.entity==='string'?p.entity:''}:null}
export function cleanItem(i,projects){
  // start may be empty: an unscheduled (backlog) item that only shows on the Board and List.
  if(!i||typeof i.id!=='string'||typeof i.title!=='string'||!(DATE.test(i.start)||i.start===''))return null;
  return {id:i.id,title:i.title.slice(0,200),kind:ITEM_KINDS.includes(i.kind)?i.kind:'milestone',status:ITEM_STATUS.includes(i.status)?i.status:'planned',start:i.start,end:i.start&&DATE.test(i.end||'')&&i.end>=i.start?i.end:'',
    priority:ITEM_PRIORITY.includes(i.priority)?i.priority:'',release:typeof i.release==='string'?i.release:'',
    projects:Array.isArray(i.projects)?[...new Set(i.projects)].filter(p=>projects.some(x=>x.id===p)):[],owner:String(i.owner??'').slice(0,120),link:String(i.link??'').slice(0,500),notes:String(i.notes??'').slice(0,4000),
    // Agent inbox stamp: what it last wrote, so later patches never overwrite Owner's edits (inbox-core.js).
    ...(typeof i.inbox?.sig==='string'?{inbox:{at:String(i.inbox.at||''),sig:i.inbox.sig.slice(0,8000)}}:{})};
}
// The environment a workspace belongs to; the server decides who may read or write it.
// Data from before environments existed belongs to Default workspace.
export const DEFAULT_ENV={id:'default-workspace',name:"Default workspace",ownerEmail:'owner@example.test',visibility:'private',members:[]};
export function cleanEnvironment(e){
  if(!e||typeof e.id!=='string'||!/^[A-Za-z0-9-]{1,64}$/.test(e.id))return {...DEFAULT_ENV,members:[]};
  return {id:e.id,name:String(e.name||'Workspace').slice(0,80),ownerEmail:String(e.ownerEmail||'').toLowerCase().slice(0,254),visibility:e.visibility==='public'?'public':'private',members:Array.isArray(e.members)?e.members.filter(m=>typeof m==='string'):[]};
}
function normalize(db){
  db.environment=cleanEnvironment(db.environment);
  db.workflow=cleanWorkflow(db.workflow);
  db.projects=(Array.isArray(db.projects)?db.projects:[]).map(cleanProject).filter(Boolean);
  db.timeline=(Array.isArray(db.timeline)?db.timeline:[]).map(i=>cleanItem(i,db.projects)).filter(Boolean);
  // DevOps board: databases saved before it existed get the default columns and labels.
  db.devops=cleanDevops(db.devops,db);
  return db;
}

// fresh: this browser had no saved workspace (sync then takes the server's copy).
// onSaved: called after every local change (sync.js uploads it); adoptRemote() does not call it.
export const store={db:null,undo:[],redo:[],fresh:true,onChange(){},onStatus(){},onSaved(){}};
{
  // A fresh browser starts its own private workspace; the server assigns the owner on first save.
  const s=seed();store.db={active:s.id,charts:[s],environment:{id:uid(),name:'My workspace',ownerEmail:'',visibility:'private',members:[]}};
  try{const saved=JSON.parse(localStorage.getItem(KEY));if(saved?.charts?.length&&saved.charts.every(validChart)){store.db=saved;store.fresh=false;if(!saved.charts.some(c=>c.id===saved.active))saved.active=saved.charts[0].id}}catch{}
  normalize(store.db);
}
// A workspace without an owner yet: in local mode it is Default workspace; signed in with OneProfileID
// it belongs to whoever is signed in (the server stamps the same on its first save).
fetch('/api/auth/session').then(r=>r.json()).then(s=>{
  const e=store.db.environment;if(e.ownerEmail)return;
  if(s.mode==='local')store.db.environment={...DEFAULT_ENV,members:[]};
  else if(s.user?.email)e.ownerEmail=s.user.email;else return;
  saveLocal();store.onChange();
}).catch(()=>{});
export const chart=()=>store.db.charts.find(c=>c.id===store.db.active);

// Browser storage is immediate; the disk backup (data/<browser-id>.json) follows 400 ms later.
let backupId,backupTimer,backupBusy=false,backupPending=null;
try{backupId=localStorage.getItem(KEY+'-backup-id')||uid();localStorage.setItem(KEY+'-backup-id',backupId)}catch{backupId=uid()}
const time=()=>new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
async function flushBackup(){
  if(backupBusy||!backupPending)return;
  backupBusy=true;const body=backupPending;backupPending=null;
  try{const r=await fetch('/api/backups/'+backupId,{method:'PUT',headers:{'Content-Type':'application/json'},body});if(!r.ok)throw Error('Backup failed');if(!backupPending)store.onStatus('ok',`Saved in browser and on disk · ${time()}`)}
  catch{if(!backupPending)backupPending=body;store.onStatus('warn','Saved in browser · disk backup failed, retrying');clearTimeout(backupTimer);backupTimer=setTimeout(flushBackup,5000);backupBusy=false;return}
  backupBusy=false;if(backupPending)flushBackup();
}
export function save(opts){saveLocal();store.onSaved(opts)}
// Browser storage + disk backup only (no server upload): used when adopting the server's copy.
function saveLocal(){
  const body=JSON.stringify(store.db);
  try{localStorage.setItem(KEY,body);store.onStatus('saving','Saved in browser · backing up to disk…')}catch{store.onStatus('warn','Browser save failed · backing up to disk…')}
  backupPending=body;clearTimeout(backupTimer);backupTimer=setTimeout(flushBackup,400);
}
window.addEventListener('pagehide',()=>{if(backupPending)fetch('/api/backups/'+backupId,{method:'PUT',headers:{'Content-Type':'application/json'},body:backupPending,keepalive:true}).catch(()=>{})});

export function checkpoint(){store.undo.push(clone(store.db));if(store.undo.length>100)store.undo.shift();store.redo=[]}
// Record a snapshot taken before a drag, once the drag has actually changed something.
export function commit(before){store.undo.push(before);if(store.undo.length>100)store.undo.shift();store.redo=[];save()}
export const validDb=d=>Array.isArray(d?.charts)&&d.charts.length>0&&d.charts.every(validChart);
// Swap in a whole saved workspace; undoable like any other change.
export function replaceDb(d){
  checkpoint();d=clone(d);if(!d.charts.some(c=>c.id===d.active))d.active=d.charts[0].id;
  store.db=normalize(d);save({replace:true});store.onChange();
}
export function change(fn){checkpoint();fn();save();store.onChange()}
// Adopt a modified copy of the database (agent inbox) as one undoable, validated step.
// Take the server's (or a merged) copy: no undo step and no upload of it again.
export function adoptRemote(d){d=clone(d);if(!d.charts.some(c=>c.id===d.active))d.active=d.charts[0].id;store.db=normalize(d);store.fresh=false;saveLocal();store.onChange()}
export function applyDb(next){checkpoint();store.db=normalize(next);save();store.onChange()}
export function step(dir){
  const [from,to]=dir<0?[store.undo,store.redo]:[store.redo,store.undo];
  if(!from.length)return;
  to.push(clone(store.db));store.db=from.pop();save();store.onChange();
}
