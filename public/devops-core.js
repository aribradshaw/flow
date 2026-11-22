// DevOps board data: defaults, validation and pure helpers (no DOM, no storage), so verify.mjs
// can exercise them in Node. Label colours are designed to stay readable on white.
// db.devops = {columns:[{id,name}], cards:[card], nextNumber, labels:[{id,name,section,color}]}
// card = {id,number,title,description,column,project,labels[],points,actual,due,assignees[{node,role}],
//         checklist[{id,text,done}],links[{id,kind,url}],item,created,updated,moved,snoozedUntil?}  (moved: last column change)
// snoozedUntil: an ISO time; until then the board hides the card (shared by everyone on the board). Left out
// when not snoozed. A past time means nothing: the card is awake again (no server job clears it).
// Card order inside a column is the order of db.devops.cards.

// Working columns first; the two backlogs sit after Done. 'requests' is the merged Requests / Sprinted inbox.
export const COLUMNS=[['requests','Requests / Sprinted'],['doing','Doing'],['blocked','Blocked'],['uat','UAT'],['done','Done'],['must','Backlog: Must Have'],['nice','Backlog: Nice to Have']];
export const BACKLOG=['must','nice'];
// What each column means (shown on the column headers). Done = completed; UAT = needs testing first.
export const COLUMN_INFO={
  requests:'New requests and sprinted work, ready to be picked up.',
  doing:'Being built now. Each card here should have a developer.',
  blocked:'Started, but waiting on something outside the card.',
  uat:'Built and needs testing before it can go to Done. Approve moves a tested card to Done.',
  done:'Completed: built, tested in UAT and approved.',
  must:'Backlog: has to happen, not scheduled yet.',
  nice:'Backlog: worth doing when there is room.',
};
// Earlier layouts: 'sprinted' folded into 'requests'; default names that should pick up the new ones.
const MERGED={sprinted:'requests'},OLD_NAMES=new Set(['Backlog: Requests','Sprinted']);
export const NEW_COLUMN='requests';
export const ROLES=['developer','tester','requester'];
export const LINK_KINDS={pr:'Pull request',commit:'Commit',url:'Link'};
export const SECTIONS=[['priority','Priority'],['urgency','Urgency'],['area','Area'],['topic','Topic'],['other','Other']];
// Label tokens: background and text pairs readable on white.
export const COLORS={
  red:['#fdd5d2','#8e1f17'],orange:['#ffe2bd','#7a3d00'],yellow:['#fff0a8','#614b00'],green:['#cce9d7','#145c32'],blue:['#cfe4ff','#174f91'],
  sky:['#cdeef6','#145866'],purple:['#e6dcff','#513595'],pink:['#f8d6e9','#7a2854'],lime:['#e1efb5','#415c08'],black:['#d8dadd','#242629'],
  teal:['#c7ebe4','#0f5c52'],indigo:['#d7dbf7','#2f3d8f'],rose:['#fad4dc','#8a2340'],amber:['#fce8b8','#6b4a00'],brown:['#ead9c8','#5c3a1e'],slate:['#d7dde5','#2f3a4a'],
  'red-deep':['#f5b8b4','#6e120c'],
};
export const colorOf=key=>COLORS[key]||['#e8e9eb','#3f4247'];
const SEED_LABELS=[['l-urgent','Urgent','urgency','red-deep'],['l-high','High','priority','orange'],['l-medium','Medium','priority','yellow'],['l-low','Low','priority','slate'],
  ['l-frontend','Frontend','area','blue'],['l-backend','Backend','area','purple'],['l-design','Design','area','pink'],['l-infra','Infra','area','teal'],['l-marketing','Marketing','area','green']];

const DATE=/^\d{4}-\d{2}-\d{2}$/,str=(v,n)=>String(v??'').slice(0,n),id=()=>crypto.randomUUID();
export function seedDevops(){
  return {columns:COLUMNS.map(([id,name])=>({id,name})),cards:[],nextNumber:1,labels:SEED_LABELS.map(([id,name,section,color])=>({id,name,section,color}))};
}

// Validate a saved board against the rest of the database. Missing or broken parts fall back to
// defaults; references to deleted projects, labels or timeline items are dropped.
export function cleanDevops(d,db={}){
  if(!d||typeof d!=='object')return seedDevops();
  const names=new Map((Array.isArray(d.columns)?d.columns:[]).filter(c=>c&&typeof c.id==='string'&&!MERGED[c.id]&&typeof c.name==='string'&&c.name.trim()&&(d.namesCustomized||!OLD_NAMES.has(c.name))).map(c=>[c.id,c.name.slice(0,80)]));
  const columns=COLUMNS.map(([id,name])=>({id,name:names.get(id)||name}));
  const seenL=new Set(),labels=(Array.isArray(d.labels)?d.labels:seedDevops().labels).filter(l=>l&&typeof l.id==='string'&&typeof l.name==='string'&&!seenL.has(l.id)&&seenL.add(l.id))
    .map(l=>({id:l.id,name:l.name.slice(0,40),section:SECTIONS.some(([s])=>s===l.section)?l.section:'other',color:COLORS[l.color]?l.color:'black'}));
  const projects=new Set((db.projects||[]).map(p=>p.id)),items=new Set((db.timeline||[]).map(i=>i.id)),labelIds=new Set(labels.map(l=>l.id));
  const seen=new Set(),numbers=new Set(),now=new Date().toISOString();
  const raw=(Array.isArray(d.cards)?d.cards:[]).filter(c=>c&&typeof c.id==='string'&&typeof c.title==='string'&&!seen.has(c.id)&&seen.add(c.id));
  let next=Math.max(1,Number.isInteger(d.nextNumber)?d.nextNumber:1,...raw.map(c=>Number.isInteger(c.number)?c.number+1:1));
  const cards=raw.map(c=>{
    let number=Number.isInteger(c.number)&&c.number>0&&!numbers.has(c.number)?c.number:next++;numbers.add(number);
    const iso=v=>typeof v==='string'&&!Number.isNaN(Date.parse(v))?v:now;
    return {id:c.id,number,title:c.title.slice(0,200),description:str(c.description,8000),column:COLUMNS.some(([k])=>k===c.column)?c.column:MERGED[c.column]||NEW_COLUMN,
      project:projects.has(c.project)?c.project:'',labels:Array.isArray(c.labels)?[...new Set(c.labels)].filter(l=>labelIds.has(l)):[],
      points:Number.isFinite(c.points)&&c.points>=0&&c.points<=1000?c.points:null,actual:Number.isFinite(c.actual)&&c.actual>=0&&c.actual<=1000?c.actual:null,due:DATE.test(c.due||'')?c.due:'',
      assignees:(Array.isArray(c.assignees)?c.assignees:[]).filter(a=>a&&typeof a.node==='string').map(a=>({node:a.node,role:ROLES.includes(a.role)?a.role:'developer'}))
        .filter((a,i,all)=>all.findIndex(b=>b.node===a.node&&b.role===a.role)===i).slice(0,20),
      checklist:(Array.isArray(c.checklist)?c.checklist:[]).filter(x=>x&&typeof x.text==='string').slice(0,200).map(x=>({id:typeof x.id==='string'?x.id:id(),text:x.text.slice(0,300),done:!!x.done})),
      links:(Array.isArray(c.links)?c.links:[]).filter(x=>x&&typeof x.url==='string'&&x.url.trim()).slice(0,50).map(x=>({id:typeof x.id==='string'?x.id:id(),kind:LINK_KINDS[x.kind]?x.kind:'url',url:x.url.slice(0,500)})),
      item:items.has(c.item)?c.item:'',created:iso(c.created),updated:iso(c.updated),moved:iso(c.moved||c.updated),
      // Set by the agent inbox: when it last wrote this card (see inbox-core.js).
      inbox:typeof c.inbox?.at==='string'?{at:c.inbox.at}:undefined,
      snoozedUntil:snoozeIso(c.snoozedUntil)||undefined};
  });
  return {columns,cards,nextNumber:Math.max(next,...cards.map(c=>c.number+1)),labels,...(d.namesCustomized?{namesCustomized:true}:{})};
}

// Snooze: a card snoozed until a time stays off the board (unless its column shows snoozed cards) until then.
// snoozeIso(v) is v as a canonical ISO time, or '' when it is not one (null, '', unparseable, out of range).
export function snoozeIso(v){
  if(typeof v!=='string'||!v||v.length>40)return '';
  const t=Date.parse(v);return Number.isFinite(t)&&Math.abs(t)<=864e13?new Date(t).toISOString():'';
}
export const isSnoozed=(c,now=Date.now())=>!!c?.snoozedUntil&&Date.parse(c.snoozedUntil)>now;
// The soonest time a snoozed card wakes (ms), or null: the board re-renders then.
export function nextWake(cards,now=Date.now()){
  let t=null;for(const c of cards){const w=c.snoozedUntil?Date.parse(c.snoozedUntil):NaN;if(w>now&&(t===null||w<t))t=w}
  return t;
}
// The snooze menu's presets, resolved against `now` in local time: [key, label, Date].
// Tomorrow and Next week are 9:00 AM; Next week is the coming Monday (a week on, when today is Monday).
export function snoozePresets(now=new Date()){
  const at=(days,h)=>{const d=new Date(now);d.setDate(d.getDate()+days);d.setHours(h,0,0,0);return d};
  return [['hour','In 1 hour',new Date(+now+36e5)],['3hours','In 3 hours',new Date(+now+3*36e5)],['tomorrow','Tomorrow',at(1,9)],
    ['week','Next week',at(((8-now.getDay())%7)||7,9)]];
}

// A wake time as the board shows it, in local time: "11:27 PM" today, "Mon 9:00 AM" within the week,
// "Dec 2, 9:00 AM" later (with the year when it is not this one).
export function wakeText(at,now=new Date()){
  const d=new Date(at),time=d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
  const day=x=>new Date(x.getFullYear(),x.getMonth(),x.getDate()),days=Math.round((day(d)-day(now))/864e5);
  if(days===0)return time;
  if(days>0&&days<7)return `${d.toLocaleDateString([],{weekday:'short'})} ${time}`;
  return `${d.toLocaleDateString([],{month:'short',day:'numeric',...(d.getFullYear()!==now.getFullYear()?{year:'numeric'}:{})})}, ${time}`;
}

// A card's points as the tile shows them: the estimate, the actual, or "3 → 8 pts" when they differ.
export function ptsText({points:p,actual:a}){
  const has=v=>v!=null&&Number.isFinite(v);
  if(has(p)&&has(a))return p===a?`${p} pts`:`${p} → ${a} pts`;
  return has(a)?`${a} pts actual`:has(p)?`${p} pts`:'';
}

export function newCard(dv,over={}){
  const now=new Date().toISOString();
  const c={id:id(),number:dv.nextNumber++,title:'New card',description:'',column:NEW_COLUMN,project:'',labels:[],points:null,actual:null,due:'',assignees:[],checklist:[],links:[],item:'',created:now,updated:now,moved:now,...over};
  dv.cards.push(c);return c;
}

// Move a card to a column, before the card at `index` among that column's other cards (end if omitted).
export function moveCard(dv,cardId,column,index=Infinity){
  const c=dv.cards.find(x=>x.id===cardId);if(!c)return false;
  dv.cards.splice(dv.cards.indexOf(c),1);
  const peers=dv.cards.filter(x=>x.column===column),before=peers[Math.max(0,index)];
  c.column=column;c.updated=c.moved=new Date().toISOString();
  if(before)dv.cards.splice(dv.cards.indexOf(before),0,c);else{const last=peers.at(-1);dv.cards.splice(last?dv.cards.indexOf(last)+1:dv.cards.length,0,c)}
  return true;
}

// Workflow gates. Approve (UAT → Done) is a button and skips this; everything else asks first.
export function gateFor(card,to){
  if(!card||card.column===to)return null;
  if(to==='done')return 'confirm-done';
  if(card.column==='done')return 'confirm-reopen';
  if(to==='doing'&&!card.assignees.some(a=>a.role==='developer'))return 'pick-dev';
  return null;
}

// Projects that belong to a chart card: placed under it, or named after it (as the timeline strip does).
export function entityProjects(db,nodeId){
  const node=db.charts?.flatMap(c=>c.nodes).find(n=>n.id===nodeId),key=node?.name.trim().toLowerCase();
  return (db.projects||[]).filter(p=>p.entity===nodeId||(key&&p.name.trim().toLowerCase()===key));
}
export const isOpen=c=>c.column!=='done';

// f = {projects:[ids|'none'], entity, assignees[], agents[], labels[], q, hideDone, snoozed} (assignee / label: single-value forms).
// snoozed: true keeps only cards snoozed now, false only awake ones; left out, both.
// agents: AgentFlow agent ids; matches cards delegated to any of them. q matches "#12"/"12" or the title.
export function filterCards(db,f={}){
  const q=(f.q||'').trim().toLowerCase(),num=/^#?\d+$/.test(q)?Number(q.replace('#','')):null;
  const ent=f.entity?new Set(entityProjects(db,f.entity).map(p=>p.id)):null;
  const delegated=f.agents?.length?new Set((db.agentflow?.agents||[]).filter(a=>f.agents.includes(a.id)).flatMap(a=>a.cards)):null;
  return db.devops.cards.filter(c=>(!f.hideDone||isOpen(c))
    &&(!f.projects?.length||f.projects.some(p=>p==='none'?!c.project:c.project===p))
    &&(!ent||ent.has(c.project))
    &&(!f.assignee||c.assignees.some(a=>a.node===f.assignee))
    &&(!f.assignees?.length||c.assignees.some(a=>f.assignees.includes(a.node)))
    &&(!delegated||delegated.has(c.id))
    &&(!f.label||c.labels.includes(f.label))
    &&(!f.labels?.length||f.labels.some(l=>c.labels.includes(l)))
    &&(f.snoozed===undefined||isSnoozed(c)===f.snoozed)
    &&(!q||c.number===num||c.title.toLowerCase().includes(q)));
}

// Due tone: overdue (red) once past, soon (amber) within two days. Done cards are muted.
export function dueTone(card,today){
  if(!card.due||card.column==='done')return '';
  if(card.due<today)return 'overdue';
  return (Date.parse(card.due)-Date.parse(today))/864e5<=2?'soon':'';
}
export const cardsForItem=(db,itemId)=>db.devops.cards.filter(c=>c.item===itemId);
// A timeline item still open whose linked cards are all done. Flow only suggests closing it: an item can
// involve more than its cards. Returns how many cards it has, 0 when it is not ready.
export function readyToClose(db,item){
  if(item.status==='done'||item.status==='cancelled')return 0;
  const cards=cardsForItem(db,item.id);
  return cards.length&&!cards.some(isOpen)?cards.length:0;
}
export const openCardsFor=(db,{person,entity}={})=>filterCards(db,{assignee:person,entity,hideDone:true});
export const initials=name=>String(name||'?').split(/\s+/).filter(Boolean).slice(0,2).map(p=>p[0].toUpperCase()).join('')||'?';
const KEYS=Object.keys(COLORS);
export const memberColor=nodeId=>{let h=0;for(const ch of nodeId)h=(h*31+ch.charCodeAt(0))|0;return colorOf(KEYS[Math.abs(h)%KEYS.length])};

// Column sorts: a view only (per column, per user, kept in prefs); never rewrites the saved order.
// [key, menu label, short header label]. 'manual' is board order (the order of db.devops.cards).
export const SORTS=[['manual','Manual','Manual'],['newest','Newest first','Newest'],['oldest','Oldest first','Oldest'],['updated','Recently updated','Updated'],
  ['due','Due date: soonest first','Due soon'],['due-late','Due date: latest first','Due late'],['points-high','Points: most to least','Most pts'],['points-low','Points: least to most','Least pts'],
  ['actual-high','Actual: most to least','Most actual'],['actual-low','Actual: least to most','Least actual'],
  ['priority','Priority','Priority'],['number','Card number','Number'],['title','Title A to Z','A to Z']];
export const sortKey=k=>SORTS.some(([s])=>s===k)?k:'manual';
// Priority rank: Urgency labels outrank Priority labels; within a section, the order the labels are listed
// (the seeded Urgent, High, Medium, Low). Lower is higher priority; cards with neither sort last.
export function priorityRank(labels=[]){
  const rank=new Map();let i=0;
  for(const s of ['urgency','priority'])for(const l of labels)if(l.section===s)rank.set(l.id,i++);
  return c=>{let r=Infinity;for(const id of c.labels||[])if(rank.has(id))r=Math.min(r,rank.get(id));return r};
}
const nameCmp=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
// Sort a column's cards (given in board order) for display. Missing values (no due date, no points, no
// priority label) always go last; ties keep board order, so the sort is stable. Returns a new array.
export function sortCards(cards,sort,labels=[]){
  const k=sortKey(sort);if(k==='manual')return [...cards];
  const pr=k==='priority'?priorityRank(labels):null;
  // [value, direction]: direction 1 ascending, -1 descending; null/'' values are missing.
  const val={newest:c=>[c.created,-1],oldest:c=>[c.created,1],updated:c=>[c.updated,-1],due:c=>[c.due||null,1],'due-late':c=>[c.due||null,-1],
    'points-high':c=>[c.points??null,-1],'points-low':c=>[c.points??null,1],
    'actual-high':c=>[c.actual??null,-1],'actual-low':c=>[c.actual??null,1],priority:c=>{const r=pr(c);return [r===Infinity?null:r,1]},
    number:c=>[c.number,1],title:c=>[c.title,1]}[k];
  const cmp=(a,b)=>typeof a==='string'&&typeof b==='string'?(k==='title'?nameCmp.compare(a,b):a<b?-1:a>b?1:0):a-b;
  return cards.map((c,i)=>[c,i,...val(c)]).sort((x,y)=>{
    const a=x[2],b=y[2],ma=a==null,mb=b==null;
    if(ma||mb)return ma&&mb?x[1]-y[1]:ma?1:-1;
    return cmp(a,b)*x[3]||x[1]-y[1];
  }).map(x=>x[0]);
}

// Right-click menus (devops.js). Priority is the one Urgency or Priority label a card carries: the
// labels of those two sections, Urgency first, in the order they are listed.
export const priorityLabels=(labels=[])=>['urgency','priority'].flatMap(s=>labels.filter(l=>l.section===s));
// A card's labels with its priority set to `id` (or cleared with ''): every other Urgency and Priority
// label comes off, the rest stay in place. Returns a new array.
export function withPriority(cardLabels=[],labels=[],id=''){
  const pri=new Set(priorityLabels(labels).map(l=>l.id));
  const rest=cardLabels.filter(l=>!pri.has(l));
  return id&&pri.has(id)?[...rest,id]:rest;
}
// "Move to" targets: every column in board order, the card's own one checked (choosing it does nothing).
export const moveTargets=(columns,card)=>columns.map(c=>({id:c.id,name:c.name,current:c.id===card?.column}));
// A list too long for a submenu: the first `cap`, with the checked ones always included (in list order).
export function capList(list,isOn,cap=15){
  if(list.length<=cap)return {shown:list,more:false};
  const on=list.filter(isOn),room=Math.max(0,cap-on.length),keep=new Set([...on,...list.filter(x=>!isOn(x)).slice(0,room)]);
  return {shown:list.filter(x=>keep.has(x)),more:true};
}
