// Chat with OneProfileID friends (docs/concepts/11-chat.md): the pure rules, shared by the browser
// (chat.js) and the server (lib/chat.mjs). No DOM, no storage.
//
// Messages are plain text over OneProfileID. A Flow card travels as a readable title line followed by
// a deep link to the card on the sending Flow's origin:
//   Flow card #12: Fix the sign-in loop
//   https://flow.example.test/?env=<environment id>&card=<card id>
// Mind map cards use node=<id> instead of card=<id>. Flow shows such a message as a card bubble with
// details looked up for the person reading it; anywhere else it stays readable as text and a link.
import {COLUMNS,colorOf} from './devops-core.js';

export const USERNAME=/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const MESSAGE_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ENV_ID=/^[A-Za-z0-9-]{1,64}$/;
export const RECORD_ID=/^[A-Za-z0-9_-]{1,100}$/;
export const BODY_MAX=2000;
// OneProfileID counts characters (code points), not UTF-16 units.
export const bodyLength=s=>Array.from(String(s??'')).length;
export const validBody=s=>typeof s==='string'&&!!s.trim()&&bodyLength(s)<=BODY_MAX;
export const LIST_POLL=15000,THREAD_POLL=5000,BADGE_POLL=60000;
export const initials=name=>String(name||'?').split(/\s+/).filter(Boolean).slice(0,2).map(p=>Array.from(p)[0]).join('').toUpperCase()||'?';

// ---------- times (the same wording as OneProfileID's own Messages) ----------
// A centered time appears after an hour of silence or on a new day; one person's messages group
// while each follows within five minutes.
export const SEPARATOR_GAP=60*60*1000,GROUP_GAP=5*60*1000;
const zoneOf=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
const dayFormats=new Map();
// The calendar day in a time zone, as a count of days that can be subtracted.
export function calendarDay(time,timeZone=zoneOf()){
  if(!dayFormats.has(timeZone))dayFormats.set(timeZone,new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'numeric',day:'numeric'}));
  const p=Object.fromEntries(dayFormats.get(timeZone).formatToParts(time).map(x=>[x.type,Number(x.value)]));
  return Date.UTC(p.year,p.month-1,p.day)/864e5;
}
// The conversation list: "3:04 PM" today, "Mon" this week, "Nov 3" this year, "Nov 3, 2025" before.
export function listTime(value,{now=new Date(),locale,timeZone=zoneOf()}={}){
  const t=Date.parse(value);if(!Number.isFinite(t))return '';
  const days=calendarDay(now.getTime(),timeZone)-calendarDay(t,timeZone),year=at=>new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric'}).format(at);
  const o=days===0?{hour:'numeric',minute:'2-digit'}:days>0&&days<6?{weekday:'short'}:{month:'short',day:'numeric',...(year(t)===year(now)?{}:{year:'numeric'})};
  return new Intl.DateTimeFormat(locale,{timeZone,...o}).format(t);
}
// A separator: "12:09 AM" today, "Mon 12:09 AM" this week, "Nov 3, 12:09 AM" older, with the year when it isn't this one.
export function separatorLabel(value,{now=new Date(),locale,timeZone=zoneOf()}={}){
  const t=Date.parse(value);if(!Number.isFinite(t))return '';
  const days=calendarDay(now.getTime(),timeZone)-calendarDay(t,timeZone),year=at=>new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric'}).format(at);
  const clock={hour:new Intl.DateTimeFormat(locale,{hour:'numeric'}).resolvedOptions().hour12===false?'2-digit':'numeric',minute:'2-digit'};
  const o=days===0?clock:days>0&&days<7?{weekday:'short',...clock}:{month:'short',day:'numeric',...(year(t)===year(now)?{}:{year:'numeric'}),...clock};
  return new Intl.DateTimeFormat(locale,{timeZone,...o}).format(t);
}
// The exact moment, for hover, focus and screen readers.
export function fullTime(value,{locale,timeZone=zoneOf()}={}){
  const t=Date.parse(value);if(!Number.isFinite(t))return '';
  return new Intl.DateTimeFormat(locale,{timeZone,dateStyle:'full',timeStyle:'short'}).format(t);
}
// One entry per message, in order: whether a separator goes above it, and its place in its group
// (single, first, middle or last).
export function timeline(messages,{timeZone=zoneOf()}={}){
  const out=[];let prev=null;
  for(const message of messages){
    const time=Date.parse(message.createdAt),valid=Number.isFinite(time),day=valid?calendarDay(time,timeZone):null;
    const gap=prev?.valid&&valid?time-prev.time:null;
    const separator=valid&&(!prev||!prev.valid||gap>=SEPARATOR_GAP||day!==prev.day);
    const continues=!!prev&&!separator&&gap!==null&&gap<=GROUP_GAP&&!!prev.message.mine===!!message.mine;
    if(continues)out.at(-1).group=out.at(-1).group==='single'?'first':'middle';
    out.push({message,separator,group:continues?'last':'single'});
    prev={message,time,valid,day};
  }
  return out;
}

// ---------- merging and paging ----------
// A poll's newest page into what is shown. When nothing overlaps and there is more, too much arrived
// for one page: start over from the newest page (reset). Sorted oldest to newest.
export function mergeMessages(current,latest){
  const incoming=latest?.messages||[];
  if(current.length&&latest?.more&&!incoming.some(m=>current.some(x=>x.id===m.id)))return {messages:[...incoming],reset:true};
  const byId=new Map(current.map(m=>[m.id,m]));
  for(const m of incoming)byId.set(m.id,m);
  return {messages:[...byId.values()].sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)||(a.id<b.id?-1:1)),reset:false};
}
// An earlier page ("Load earlier messages") goes in front; anything already shown is kept once.
export function prependOlder(current,older){
  const seen=new Set(current.map(m=>m.id));
  return [...(older||[]).filter(m=>!seen.has(m.id)),...current];
}
// The "new message" picker: people with a conversation first (newest first, as listed), then other
// friends by name, each once, filtered by a search on name or handle.
export function pickerPeople(conversations=[],friends=[],q=''){
  const seen=new Set(),out=[],want=String(q).trim().toLowerCase();
  const add=(p,recent)=>{if(!p||seen.has(p.username))return;seen.add(p.username);out.push({username:p.username,name:p.name||p.username,photo:p.photo||null,recent})};
  for(const c of conversations)add(c,true);
  for(const f of [...friends].sort((a,b)=>String(a.name||a.username).localeCompare(String(b.name||b.username))))add(f,false);
  return want?out.filter(p=>p.name.toLowerCase().includes(want)||p.username.includes(want)):out;
}

// ---------- card links ----------
const KIND_PARAM={card:'card',node:'node'};
// ref: {env, kind:'card'|'node', id}
export const validRef=r=>!!r&&typeof r==='object'&&ENV_ID.test(String(r.env||''))&&!!KIND_PARAM[r.kind]&&RECORD_ID.test(String(r.id||''));
export const refKey=r=>`${r.env}|${r.kind}|${r.id}`;
export function linkFor(origin,ref){
  const q=new URLSearchParams({env:ref.env,[KIND_PARAM[ref.kind]]:ref.id});
  return `${String(origin).replace(/\/+$/,'')}/?${q}`;
}
// A deep link's query (location.search): {env, kind, id} or null.
export function refFromSearch(search){
  const q=new URLSearchParams(search),card=q.get('card'),node=q.get('node');
  if(!!card===!!node)return null;
  const r={env:q.get('env')||'',kind:card?'card':'node',id:card||node};
  return validRef(r)?r:null;
}
// A URL that links to a card on this Flow (same origin, path /): its ref, otherwise null.
export function refFromUrl(url,origin){
  let u;try{u=new URL(url)}catch{return null}
  if(u.origin!==new URL(origin).origin||u.pathname!=='/')return null;
  return refFromSearch(u.search);
}
const TYPE_LABEL={person:'person',entity:'entity',area:'project area',note:'note'};
// The readable line above the link: "Flow card #12: Title", "Flow person: Name".
export function cardLine(summary){
  const one=s=>String(s??'').replace(/\s+/g,' ').trim().slice(0,200);
  if(summary.kind==='card')return `Flow card${Number.isInteger(summary.number)?` #${summary.number}`:''}: ${one(summary.title)||'Untitled card'}`;
  return `Flow ${TYPE_LABEL[summary.type]||'card'}: ${one(summary.name)||'Untitled'}`;
}
// The message for a card, with an optional note above it.
export function cardMessage(note,summary,url){
  const n=String(note??'').trim();
  return `${n?n+'\n\n':''}${cardLine(summary)}\n${url}`;
}
const LINE=/^Flow (?:card(?: #\d+)?|person|entity|project area|note): (.+)$/;
const URLS=/https?:\/\/[^\s<>"']+/g;
// What a message says, as Flow shows it: its own text, and the Flow cards it links to (at most 5).
// A card's title line (as cardMessage writes it) is folded into its card; any other text stays.
// -> {text, cards:[{ref, url, title}]}  (title: from the message, null without a title line)
export function parseMessage(body,origin){
  const lines=String(body??'').split('\n'),keep=[],cards=[],seen=new Set();
  const add=(ref,url,title)=>{const k=refKey(ref);if(seen.has(k)||cards.length>=5)return false;seen.add(k);cards.push({ref,url,title});return true};
  for(let i=0;i<lines.length;i++){
    const line=lines[i].trim(),ref=/^https?:\/\/\S+$/.test(line)?refFromUrl(line,origin):null;
    if(ref){
      const above=keep.length?LINE.exec(keep.at(-1).trim()):null;
      if(add(ref,line,above?above[1]:null)){if(above)keep.pop();continue}
      continue;
    }
    keep.push(lines[i]);
    for(const m of lines[i].matchAll(URLS)){const r=refFromUrl(m[0].replace(/[).,;:!?]+$/,''),origin);if(r)add(r,m[0],null)}
  }
  return {text:keep.join('\n').replace(/\n{3,}/g,'\n\n').trim(),cards};
}
// The conversation list's preview line.
export function previewText(item,origin){
  const m=item?.lastMessage;if(!m)return 'Start a conversation';
  const p=parseMessage(m.body,origin),what=p.text||(p.cards.length?(p.cards[0].title?`Card: ${p.cards[0].title}`:'Sent a card'):m.body);
  return (m.mine?'You: ':'')+what.replace(/\s+/g,' ');
}

// ---------- what a card bubble shows ----------
const HEX=/^#[0-9a-f]{3,8}$/i;
const okImage=v=>typeof v==='string'&&v.length<=200000&&(/^https:\/\//.test(v)||/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v));
const short=(v,n)=>String(v??'').slice(0,n);
const nodesOf=db=>{const m=new Map();for(const c of db?.charts||[])for(const n of c?.nodes||[])if(n&&!m.has(n.id))m.set(n.id,n);return m};
// The details of one card (DevOps) or mind map card, from data the viewer may see. photo(node) gives a
// person's photo (the browser adds OneProfileID-linked photos); n.image otherwise. null: not there.
export function summarize(db,{kind,id},{photo=n=>n.image}={}){
  if(kind==='card'){
    const dv=db?.devops,c=(dv?.cards||[]).find(x=>x?.id===id);if(!c)return null;
    const labels=new Map((dv.labels||[]).map(l=>[l.id,l])),p=(db.projects||[]).find(x=>x.id===c.project&&c.project),nodes=nodesOf(db);
    const members=new Map([...(db.shares||[]).flatMap(s=>s?.members||[]),...(db.shareMembers||[])].filter(m=>m?.id).map(m=>[m.id,m]));
    const people=[...new Set((c.assignees||[]).map(a=>a?.node).filter(Boolean))].map(pid=>{const n=nodes.get(pid)||members.get(pid);if(!n)return null;const img=photo(n);return {id:pid,name:short(n.name||n.email,80),...(okImage(img)?{image:img}:{})}}).filter(Boolean);
    const col=(dv.columns||[]).find(x=>x.id===c.column)?.name||COLUMNS.find(([k])=>k===c.column)?.[1]||'';
    return {kind:'card',title:short(c.title,200),number:Number.isInteger(c.number)?c.number:null,column:{id:short(c.column,20),name:short(col,80)},
      labels:(c.labels||[]).map(l=>labels.get(l)).filter(Boolean).slice(0,4).map(l=>({name:short(l.name,40),color:colorOf(l.color)})),
      project:p?{name:short(p.name,80),color:HEX.test(p.color||'')?p.color:''}:null,assignees:people.slice(0,3),more:Math.max(0,people.length-3),
      due:/^\d{4}-\d{2}-\d{2}$/.test(c.due||'')?c.due:'',points:Number.isFinite(c.points)?c.points:null,actual:Number.isFinite(c.actual)?c.actual:null};
  }
  const n=nodesOf(db).get(id);if(!n||n.linked?.stub)return null;
  const img=n.type==='person'?photo(n):'';
  return {kind:'node',type:TYPE_LABEL[n.type]?n.type:'entity',name:short(n.name,160),...(okImage(img)?{image:img}:{})};
}
// Where a link opens in the workspace the browser holds (envId): the record's own id when the link
// is to this environment, or its linked copy (sh.<share>.<id>) when a share of the link's environment
// is placed here. null when it is not here.
export function localTarget(db,envId,ref){
  const has=id=>ref.kind==='card'?(db?.devops?.cards||[]).some(c=>c.id===id):[...nodesOf(db).values()].some(n=>n.id===id&&!n.linked?.stub);
  if(ref.env===envId&&has(ref.id))return ref.id;
  for(const s of db?.shares||[])if(s?.ownerEnv===ref.env&&has(`sh.${s.id}.${ref.id}`))return `sh.${s.id}.${ref.id}`;
  // An environment combined with this one (combined-core.js): its record, or a share placed there.
  for(const m of db?.combined||[]){
    if(m?.env===ref.env&&has(`cx.${m.env}.${ref.id}`))return `cx.${m.env}.${ref.id}`;
    for(const s of m?.shares||[])if(s?.ownerEnv===ref.env&&has(`cx.${m.env}.sh.${s.id}.${ref.id}`))return `cx.${m.env}.sh.${s.id}.${ref.id}`;
  }
  return null;
}
// The link for a record the browser shows: a linked copy points at the owner's record, so everyone
// it reaches resolves it with their own access.
export function refFor(db,envId,kind,id){
  // A combined environment's record points at that environment (or, for a share placed there, its owner's).
  const cx=/^cx\.([A-Za-z0-9-]{1,64})\.(.+)$/.exec(String(id||''));
  if(cx){const meta=(db?.combined||[]).find(x=>x?.env===cx[1]);return refFor(meta?{shares:meta.shares}:{},cx[1],kind,cx[2])}
  const m=/^sh\.([A-Za-z0-9_-]+)\.(.+)$/.exec(String(id||''));
  if(m){const s=(db?.shares||[]).find(x=>x.id===m[1]);const r={env:s?.ownerEnv||'',kind,id:m[2]};return validRef(r)?r:null}
  const r={env:envId||'',kind,id};return validRef(r)?r:null;
}
