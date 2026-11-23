// The 3D office's threads sidebar and thread chat, without the DOM (public/office-threads.js draws them):
// docs/concepts/12-office.md "Threads". Pure functions, also used by the tests.
//
//   SECTIONS                                  Working, Waiting, Woke, Done, then Snoozed and Settled (collapsed)
//   sectionsOf(sources, {query, hide})        [{key, label, items:[{…thread, source}], count, collapsible}]
//   relTime(at, now)                          "now", "4m", "2h", "3d", "5w"
//   liveLine(live)                            one line for a working row: "Thinking: checking UAT cards", "Run: npm test"
//   chiefBubble(live)                         the Chief's bubble while it works: "Thinking: checking UAT cards…"
//   workSummary(items)                        "Ran 2 commands and used 1 tool", "Thought for a moment"
//   blocksOf(items)                           history items as chat blocks: user, assistant, and work (reasoning + tools)
//   mergeItems(older, newer)                  two pages of one thread joined, by item id
//   projectHue(name)                          a stable hue for a project chip
export const SECTIONS=[
  {key:'working',label:'Working'},{key:'waiting',label:'Waiting'},{key:'woke',label:'Woke'},{key:'done',label:'Done'},
  {key:'snoozed',label:'Snoozed',collapsible:true},{key:'settled',label:'Settled',collapsible:true}];
export const STATE_LABEL={working:'Working',waiting:'Needs you',woke:'Woke',done:'Done',snoozed:'Snoozed',settled:'Settled'};
const lc=s=>String(s??'').toLowerCase();

// sources: [{source, items, counts}] (the server's threads list). hide: ids not to list (the pinned Chief of Staff).
export function sectionsOf(sources,{query='',hide=new Set()}={}){
  const q=lc(query).trim(),all=[];
  for(const s of sources||[])for(const t of s.items||[])if(!hide.has(t.id)&&(!q||lc(t.title).includes(q)||lc(t.project).includes(q)||lc(t.branch).includes(q)))all.push({...t,source:s.source});
  const totals={snoozed:0,settled:0};
  for(const s of sources||[]){totals.snoozed+=s.counts?.snoozed||0;totals.settled+=s.counts?.settled||0}
  return SECTIONS.map(sec=>{
    const items=all.filter(t=>t.state===sec.key).sort((a,b)=>(Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0));
    // Snoozed and Settled say how many there are in all (the index lists only the recent ones), unless filtering.
    const count=sec.collapsible&&!q?Math.max(totals[sec.key],items.length):items.length;
    return {...sec,items,count};
  }).filter(sec=>sec.items.length||(sec.collapsible&&sec.count));
}

export function relTime(at,now=Date.now()){
  const t=Date.parse(at);if(!Number.isFinite(t))return '';
  const s=Math.max(0,(now-t)/1000);
  if(s<45)return 'now';
  if(s<3600)return Math.round(s/60)+'m';
  if(s<86400)return Math.round(s/3600)+'h';
  if(s<86400*14)return Math.round(s/86400)+'d';
  return Math.round(s/(86400*7))+'w';
}

const cap=s=>s?s[0].toUpperCase()+s.slice(1):s;
const lastStep=(live,kind)=>[...(live?.steps||[])].reverse().find(s=>!kind||s.kind===kind);
export function liveLine(live){
  if(!live)return '';
  if(live.phase==='thinking'){const s=lastStep(live,'thinking')?.text;return s&&s!=='Thinking'?'Thinking: '+s:'Thinking…'}
  if(live.phase==='writing')return 'Writing a reply…';
  return lastStep(live,'tool')?.text||String(live.text||'').split('\n')[0]||'Working…';
}
export function chiefBubble(live){
  if(!live)return '';
  if(live.phase==='thinking'){const s=lastStep(live,'thinking')?.text;return s&&s!=='Thinking'?`Thinking: ${s.replace(/[.…]+$/,'')[0].toLowerCase()+s.replace(/[.…]+$/,'').slice(1)}…`:'Thinking…'}
  if(live.phase==='writing')return 'Writing it up…';
  const t=lastStep(live,'tool')?.text||'';
  return t?t.replace(/[.…]+$/,'')+'…':'Working…';
}

// "Ran 2 commands, edited 1 file and used 3 tools"; reasoning alone is "Thought for a moment".
export function workSummary(items){
  let run=0,edit=0,search=0,tool=0,thought=0;
  for(const x of items||[]){
    if(x.role==='reasoning'){thought++;continue}
    const t=String(x.title||'');
    if(/^Run:/.test(t))run++;else if(/^Edit:/.test(t))edit++;else if(/^(Search|Web search|Read)\b/.test(t))search++;else tool++;
  }
  const n=(k,one,many)=>k?`${k} ${k===1?one:many}`:'';
  const parts=[run&&'ran '+n(run,'command','commands'),edit&&'edited '+n(edit,'file','files'),search&&'looked at '+n(search,'thing','things'),tool&&'used '+n(tool,'tool','tools')].filter(Boolean);
  if(!parts.length)return thought?'Thought for a moment':'Worked';
  return cap(parts.length>1?parts.slice(0,-1).join(', ')+' and '+parts.at(-1):parts[0]);
}

// Chat blocks: each user or assistant message is its own block; the reasoning and tool calls between them are one
// work block ("Ran 2 commands and used 1 tool", opened for each step).
export function blocksOf(items){
  const out=[];let work=null;
  for(const x of items||[]){
    if(x.role==='user'||x.role==='assistant'){work=null;out.push({type:x.role,item:x});continue}
    if(!work){work={type:'work',items:[]};out.push(work)}
    work.items.push(x);
  }
  for(const b of out)if(b.type==='work')b.summary=workSummary(b.items);
  return out;
}

const keyOf=x=>x.id??JSON.stringify([x.role,x.at,x.title,x.text]);
// older and newer: oldest first. Items in both (by id) are taken from newer.
export function mergeItems(older,newer){
  const seen=new Set((newer||[]).map(keyOf));
  return [...(older||[]).filter(x=>!seen.has(keyOf(x))),...(newer||[])];
}

export function projectHue(name){let h=0;for(const c of String(name||''))h=(h*31+c.charCodeAt(0))>>>0;return h%360}
