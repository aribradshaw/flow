// What a reporter streams about its owner's own threads (docs/concepts/12-office.md "Live steps, threads and
// history"): owner only, always. Cleaned and capped here, masked again (lib/office-mask.mjs) on the way in.
//
//   cleanLive(v)        an agent's live field: {phase, text, steps:[{kind, text, at}], at} or null
//   cleanThreads(v)     a source's thread index: {items:[…], counts:{snoozed, settled}, can, at} or null
//   cleanHistory(v)     a history action's result data: {items:[…], before, more} (413 when it cannot be made to fit)
//   historyBytes(v)     its JSON size in bytes
import {transcriptText} from './office-mask.mjs';

export const LIVE_PHASES=['thinking','tool','writing'],LIVE_TEXT=600,LIVE_STEPS=8,LIVE_STEP_TEXT=200;
export const THREAD_STATES=['working','waiting','woke','done','snoozed','settled'],THREADS_MAX=150,THREAD_TITLE=160,THREAD_PROJECT=80,THREAD_CAN=['message','history'];
export const HISTORY_ROLES=['user','assistant','reasoning','tool'],HISTORY_ITEMS=60,HISTORY_TEXT=4000,HISTORY_DETAIL=600,HISTORY_BYTES=64*1024;
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code})};
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v);
const line=(v,n)=>typeof v==='string'||typeof v==='number'?String(v).replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,n):'';
const iso=v=>{const t=Date.parse(v);return Number.isFinite(t)?new Date(t).toISOString():''};
const count=v=>Number.isInteger(v)&&v>=0&&v<1e7?v:0;
// One line of masked text (a tool step, a title): masked before it is folded and cut.
const masked=(v,n)=>transcriptText(typeof v==='string'?v:'',n*2).replace(/\s+/g,' ').trim().slice(0,n);

// The agent's latest reasoning snippet, tool call or partial reply, and its last LIVE_STEPS steps, oldest first.
export function cleanLive(v){
  if(!obj(v))return null;
  const phase=LIVE_PHASES.includes(v.phase)?v.phase:'';
  const text=transcriptText(v.text,LIVE_TEXT);
  const steps=[];
  for(const s of Array.isArray(v.steps)?v.steps.slice(-LIVE_STEPS*4):[]){
    if(!obj(s)||!LIVE_PHASES.includes(s.kind))continue;
    const t=masked(s.text,LIVE_STEP_TEXT);if(!t)continue;
    const at=iso(s.at);steps.push({kind:s.kind,text:t,...at?{at}:{}});
  }
  if(!phase&&!text&&!steps.length)return null;
  const at=iso(v.at);
  return {phase:phase||steps.at(-1)?.kind||'thinking',text,steps:steps.slice(-LIVE_STEPS),...at?{at}:{}};
}

// The person's recent threads on one source, as their T3 sidebar shows them. can: what the office may ask of any of
// them ("message": a new user turn, also on an idle thread; "history": a page of its conversation).
export function cleanThreads(v){
  if(v===null)return null;
  if(!obj(v))return undefined;
  const seen=new Set(),items=[];
  for(const t of Array.isArray(v.items)?v.items:[]){
    if(items.length>=THREADS_MAX)break;
    if(!obj(t))continue;
    const id=typeof t.id==='string'&&t.id.length<=500&&!/[\s\u0000-\u001f\u007f]/.test(t.id)?t.id:'';
    if(!id||seen.has(id)||!THREAD_STATES.includes(t.state))continue;
    seen.add(id);
    const updatedAt=iso(t.updatedAt),branch=line(t.branch,120),project=line(t.project,THREAD_PROJECT);
    items.push({id,title:masked(t.title,THREAD_TITLE)||'Untitled thread',state:t.state,...project?{project}:{},...updatedAt?{updatedAt}:{},
      ...branch?{branch}:{},...t.unread===true?{unread:true}:{},...t.agent===true?{agent:true}:{}});
  }
  const c=obj(v.counts)?v.counts:{};
  const can=Array.isArray(v.can)?THREAD_CAN.filter(k=>v.can.includes(k)):[];
  const at=iso(v.at);
  return {items,counts:{snoozed:count(c.snoozed),settled:count(c.settled)},can,...at?{at}:{}};
}

// A page of a thread's conversation, oldest first: what was said, reasoning summaries and tool calls with short
// results. before: the cursor for the page before this one (null at the start); more: there is one.
// Too big: long texts are cut harder (1000, then 300 characters) before it is refused.
export function cleanHistory(v){
  if(!obj(v))fail(400,'invalid_input','data must be an object');
  for(const n of [HISTORY_TEXT,1000,300]){const out=historyPage(v,n);if(historyBytes(out)<=HISTORY_BYTES)return out}
  fail(413,'too_large',`A history page can be up to ${HISTORY_BYTES/1024} KB`);
}
function historyPage(v,n){
  const items=[];
  for(const x of Array.isArray(v.items)?v.items.slice(-HISTORY_ITEMS*2):[]){
    if(!obj(x)||!HISTORY_ROLES.includes(x.role))continue;
    const text=transcriptText(x.text,n),title=masked(x.title,200),detail=transcriptText(x.detail,Math.min(n,HISTORY_DETAIL));
    if(!text&&!title)continue;
    const at=iso(x.at),status=line(x.status,20);
    const id=typeof x.id==='string'&&x.id.length<=80&&!/[\u0000-\u001f]/.test(x.id)?x.id:'';
    items.push({role:x.role,...id?{id}:{},...text?{text}:{},...title?{title}:{},...detail?{detail}:{},...status?{status}:{},...at?{at}:{},...x.turn!==undefined&&line(x.turn,80)?{turn:line(x.turn,80)}:{}});
  }
  const before=typeof v.before==='string'&&v.before.length<=200&&!/[\u0000-\u001f]/.test(v.before)?v.before:null;
  return {items:items.slice(-HISTORY_ITEMS),before,more:v.more===true&&!!before};
}
export const historyBytes=v=>Buffer.byteLength(JSON.stringify(v));
