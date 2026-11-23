// Live meters for the 3D office (docs/concepts/12-office.md "Meters").
//
// Pure counting and the in-memory sparkline. No DOM, no Three.js. The browser
// (public/office-meters.js) and the server (lib/office.mjs) both use this.
//
// Today and this week use a timezone: the browser's, when the page draws the
// meter. The week starts on Monday. A shipped card is one currently in UAT or
// Done whose last move (`moved`) falls in that window. Points are `actual`
// when that is a number, otherwise `points`.
//
// Visibility matches lib/office-seats.mjs canSeeCard: pass `access` and cards
// the viewer cannot see are dropped. Omit `access` only when the list is
// already the viewer's (the office page's workspace). Private agents still
// count as running or waiting. Their model use does not.

export const SPARK_SLOTS=24*60,SPARK_STEP_MS=60_000;
export const SHIPPED_COLUMNS=['uat','done'];
const SHIPPED=new Set(SHIPPED_COLUMNS);
const WEEK={mon:0,tue:1,wed:2,thu:3,fri:4,sat:5,sun:6};
const TOKEN_MAX=1e15,COST_MAX=1e9;

export function browserTimeZone(){
  try{const z=Intl.DateTimeFormat().resolvedOptions().timeZone;return z||'UTC'}catch{return 'UTC'}
}

// en-US parts for one instant. hourCycle h23 can report hour "24" at midnight; that is 00:00 next calendar day.
export function zonedParts(ms,timeZone='UTC'){
  const fmt=new Intl.DateTimeFormat('en-US',{timeZone,hourCycle:'h23',weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const o={};
  for(const p of fmt.formatToParts(new Date(ms)))if(p.type!=='literal')o[p.type]=p.value;
  if(o.hour==='24'){
    o.hour='00';
    const next=new Date(Date.UTC(+o.year,+o.month-1,+o.day,12)+86400000);
    const utc=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'short',year:'numeric',month:'2-digit',day:'2-digit'});
    for(const p of utc.formatToParts(next))if(p.type!=='literal')o[p.type]=p.value;
  }
  return o;
}
const ymd=p=>`${p.year}-${p.month}-${p.day}`;
const weekMonday=p=>{
  const wd=WEEK[String(p.weekday||'').slice(0,3).toLowerCase()];
  const utc=new Date(Date.UTC(+p.year,+p.month-1,+p.day));
  utc.setUTCDate(utc.getUTCDate()-(wd??0));
  return utc.toISOString().slice(0,10);
};
const stamp=v=>{const t=Date.parse(v);return Number.isFinite(t)?t:NaN};
export function sameLocalDay(iso,now,timeZone='UTC'){
  const t=stamp(iso);if(!Number.isFinite(t))return false;
  return ymd(zonedParts(t,timeZone))===ymd(zonedParts(now,timeZone));
}
export function sameLocalWeek(iso,now,timeZone='UTC'){
  const t=stamp(iso);if(!Number.isFinite(t))return false;
  return weekMonday(zonedParts(t,timeZone))===weekMonday(zonedParts(now,timeZone));
}

export const isShipped=c=>!!c&&SHIPPED.has(c.column);
// actual when it is a real non-negative number (0 counts), else points, else 0.
export function cardPoints(card){
  const a=card?.actual,p=card?.points;
  if(typeof a==='number'&&Number.isFinite(a)&&a>=0)return a;
  if(typeof p==='number'&&Number.isFinite(p)&&p>=0)return p;
  return 0;
}

// access: {all, projectIds:Set, cardIds?:Set} as lib/office.mjs gives the office. No access: the caller already filtered.
export function cardVisible(card,access){
  if(!card)return false;
  if(!access)return true;
  if(access.all)return true;
  if(access.cardIds)return access.cardIds.has(card.id);
  return !!card.project&&!!access.projectIds?.has(card.project);
}
const assigneeId=a=>typeof a==='string'?a:a?.node;
// Cards assigned to this member (person ids, or "@email" contact ids). A card assigned to two people counts in both rooms.
export function cardsForMember(cards,refs){
  const set=refs instanceof Set?refs:new Set(refs||[]);
  if(!set.size)return [];
  return (cards||[]).filter(c=>(c?.assignees||[]).some(a=>set.has(assigneeId(a))));
}

// Reporter field usage:{tokens, costUsd} for today. Invalid fields are dropped; a useless object is null
// (the report still succeeds). Strings and negatives are not accepted.
export function cleanUsage(v){
  if(!v||typeof v!=='object'||Array.isArray(v))return null;
  const tokens=usageNum(v.tokens,TOKEN_MAX),costUsd=usageNum(v.costUsd,COST_MAX);
  if(tokens==null&&costUsd==null)return null;
  return {tokens,costUsd};
}
function usageNum(v,max){
  if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>max)return null;
  return v;
}

export function tallyAgents(agents){
  let running=0,waiting=0;
  for(const a of agents||[]){
    if(a?.status==='running')running++;
    else if(a?.status==='waiting')waiting++;
  }
  return {running,waiting};
}
// Sum use on agents the viewer can see. A private agent never contributes, even if a usage object is still on it.
export function usageTotals(agents){
  let tokens=0,costUsd=0,n=0,anyTokens=false,anyCost=false;
  for(const a of agents||[]){
    if(!a||a.private||!a.usage)continue;
    const t=usageNum(a.usage.tokens,TOKEN_MAX),c=usageNum(a.usage.costUsd,COST_MAX);
    if(t==null&&c==null)continue;
    if(t!=null){tokens+=t;anyTokens=true}
    if(c!=null){costUsd+=c;anyCost=true}
    n++;
  }
  return n?{tokens:anyTokens?tokens:null,costUsd:anyCost?costUsd:null}:null;
}

// One meter's numbers. `cards` may be pre-filtered; pass `access` to drop the rest here.
export function meterCounts({agents=[],cards=[],access=null,now=Date.now(),timeZone='UTC'}={}){
  const seen=new Set(),visible=[];
  for(const c of cards||[]){
    if(!c||(c.id&&seen.has(c.id)))continue;
    if(!cardVisible(c,access))continue;
    if(c.id)seen.add(c.id);
    visible.push(c);
  }
  let shippedToday=0,pointsWeek=0;
  for(const c of visible){
    if(!isShipped(c))continue;
    if(sameLocalDay(c.moved,now,timeZone))shippedToday++;
    if(sameLocalWeek(c.moved,now,timeZone))pointsWeek+=cardPoints(c);
  }
  return {...tallyAgents(agents),shippedToday,pointsWeek,usage:usageTotals(agents)};
}

export function formatTokens(n){
  if(typeof n!=='number'||!Number.isFinite(n))return '';
  const r=Math.round(n);
  if(r<1000)return String(r);
  if(r<1e6)return (r/1000).toFixed(r<10000?1:0).replace(/\.0$/,'')+'k';
  if(r<1e9)return (r/1e6).toFixed(r<1e7?1:0).replace(/\.0$/,'')+'M';
  return (r/1e9).toFixed(1).replace(/\.0$/,'')+'B';
}
export function formatUsd(n){
  if(typeof n!=='number'||!Number.isFinite(n))return '';
  if(n>=100)return '$'+Math.round(n).toLocaleString('en-US');
  return '$'+n.toFixed(2);
}
// "—" when nobody the viewer can see sent use today.
export function formatUsage(usage){
  if(!usage)return '—';
  const parts=[];
  const tokens=formatTokens(usage.tokens),cost=formatUsd(usage.costUsd);
  if(tokens)parts.push(tokens+' tok');
  if(cost)parts.push(cost);
  return parts.length?parts.join(' · '):'—';
}
export function formatPoints(n){
  if(typeof n!=='number'||!Number.isFinite(n))return '0';
  return Number.isInteger(n)?String(n):String(Math.round(n*10)/10);
}

// Fallback mounts when the world layout has no meterAnchors(). Room: inside the front
// wall, on the side opposite the name sign (the sign is at local +x), above the walkway.
// Office: to the right of the common board.
// A PlaneGeometry faces local +z. The room's +z points out the door, so ry = π − 0.42 turns
// the face into the room (cos(ry) < 0) and toward the doorway (sin(ry) > 0, since the screen
// sits at −x). The office screen sits on the far side of the common area and faces +z,
// toward the middle. w/h are metres. The screen stays out of the door (|x| < 1.5).
export function meterAnchors({roomD=9,commonRadius=10}={}){
  return {
    room:{x:-2.5,y:2.15,z:roomD/2-0.55,ry:Math.PI-0.42,w:1.62,h:0.9},
    office:{x:5.6,y:2.08,z:-commonRadius+0.55,ry:0,w:1.98,h:1.1},
  };
}

// Add series element-wise. Newest sample is the last entry. Missing series count as zeros.
export function sumSeries(list){
  let n=0;
  for(const s of list||[])if(s)n=Math.max(n,s.length);
  const out=Array(n).fill(0);
  for(const s of list||[])if(s)for(let i=0;i<s.length;i++)out[i]+=s[i]||0;
  return out;
}

// One running-count per minute, for 24 hours, in memory. sample(key, count) writes the
// current minute (a second call in the same minute overwrites it). Minutes with no sample
// read as 0. Older than `slots` minutes falls off.
export function createSparkline({now=()=>Date.now(),slots=SPARK_SLOTS,stepMs=SPARK_STEP_MS}={}){
  const map=new Map();
  const bucket=t=>Math.floor(t/stepMs);
  const blank=()=>Array(slots).fill(0);
  function viewOf(s,minute){
    if(!s)return blank();
    const gap=minute-s.minute;
    if(gap<=0)return s.values.slice();
    if(gap>=slots)return blank();
    const out=s.values.slice(gap);
    while(out.length<slots)out.push(0);
    return out;
  }
  return {
    slots,
    sample(key,count){
      const minute=bucket(now()),n=Math.max(0,Math.round(Number(count))||0);
      let s=map.get(key);
      if(!s){s={minute,values:blank()};map.set(key,s);s.values[slots-1]=n;return}
      const gap=minute-s.minute;
      if(gap<0)return;
      if(gap>=slots)s.values=blank();
      else if(gap>0){s.values=s.values.slice(gap);while(s.values.length<slots)s.values.push(0)}
      s.minute=minute;s.values[slots-1]=n;
    },
    series(key){return viewOf(map.get(key),bucket(now()))},
    dump(){
      const series={};
      for(const [k,s] of map)series[k]={minute:s.minute,values:s.values.slice()};
      return {slots,stepMs,series};
    },
    // Restore samples. A key already sampled in this process is left as it is.
    load(data){
      if(!data?.series||typeof data.series!=='object')return;
      for(const [k,s] of Object.entries(data.series)){
        if(map.has(k)||!s||!Array.isArray(s.values)||s.values.length!==slots)continue;
        if(!Number.isFinite(s.minute))continue;
        map.set(k,{minute:s.minute,values:s.values.map(n=>Number.isFinite(n)&&n>=0?n:0)});
      }
    },
  };
}
