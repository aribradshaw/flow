// The Chief of Staff in the 3D office (docs/concepts/12-office.md "Chief of Staff"): the parts with no DOM and no
// Three.js, so node can test them. office-chief.js puts them on screen.
//
//   chiefAgent(af)                 the environment's AgentFlow agent named "Chief of Staff" (an AI agent), or null
//   conductorOf(agents)            a member's live conductor (role "conductor"), or null
//   chiefFigures({members, live, af, deskKey})
//                                  Map(member key -> npc key): who walks with whom. The Chief of Staff robot goes with the
//                                  environment's owner when they have a conductor (else the first member who has one);
//                                  everyone else's conductor is their own mascot.
//   replySig(reply)                tells one reply from the next
//   replyHtml(text, cardId, esc)   the reply with #123 as buttons for the cards this viewer can open
//   createMentions({now, gapMs, againMs})
//     .observe(agents, {quiet, name})  -> a line to say ("Web Builder needs you") or ''. The first look is how
//                                  things are; a new wait (or a new prompt) is said once, at most one line per gapMs,
//                                  several at once in one line. While quiet (Do not disturb) nothing is said: what is
//                                  still waiting when it ends is said then.
//   waitingOnYou({agents, cards, refs, name, nameOf})  your agents that wait, then UAT cards that need you
//   chiefChannel(send)             the /cos channel for officeChat.registerChannel (public/office-chat.js)
export const CHIEF_NAME='Chief of Staff',CHIEF_COLOR='#d4a017';
const norm=s=>String(s||'').trim().toLowerCase();
export const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function chiefAgent(af){
  return (af||[]).find(a=>a&&a.kind==='agent'&&norm(a.name)===norm(CHIEF_NAME)&&a.status!=='retired')||null;
}
export const conductorOf=agents=>(agents||[]).find(a=>a&&a.role==='conductor')||null;

export function chiefModelItems(providers,runners=[]){
  const scoped=Array.isArray(providers),accounts=new Map((providers||[]).map(p=>[p.id,p]));
  const items=new Map();
  const add=(m,account)=>{
    if(!m?.id||items.has(m.id))return;
    const group=account?.label||m.provider||m.id.split(':')[0];
    const prefix=group+' · ',name=m.label||m.id.split(':').slice(1).join(':');
    items.set(m.id,{value:m.id,label:name.startsWith(prefix)?name.slice(prefix.length):name,group,
      sub:m.billing==='metered'?'Metered':m.billing==='included'?'Included':''});
  };
  for(const r of runners)for(const m of r.models||[]){
    const account=accounts.get(m?.id?.split(':')[0]);
    if(!scoped||account)add(m,account);
  }
  for(const p of accounts.values())for(const m of p.models||[])add(m,p);
  return [...items.values()].sort((a,b)=>a.group.localeCompare(b.group)||a.label.localeCompare(b.label));
}

export function chiefFigures({members=[],live=new Map(),af=[],deskKey=(m,a)=>JSON.stringify([m,a.source,a.id])}){
  const out=new Map(),robot=chiefAgent(af);
  const withOne=members.filter(m=>conductorOf(live.get(m.key)));
  const lead=robot&&(withOne.find(m=>m.owner)||withOne[0]);
  for(const m of withOne){
    if(lead&&m.key===lead.key)out.set(m.key,'af:'+robot.id);
    else out.set(m.key,deskKey(m.key,conductorOf(live.get(m.key))));
  }
  return out;
}

export const replySig=r=>r?`${r.at||''}\n${r.text||''}`:'';

export function replyHtml(text,cardId,esc){
  return esc(text).replace(/(^|[^\w&])#(\d{1,9})\b/g,(m,pre,num)=>{
    const id=cardId(Number(num));
    return id?`${pre}<button type="button" class="of-cos-card" data-cos-card="${esc(id)}">#${num}</button>`:m;
  });
}

// Who an agent is in a line: the AgentFlow agent whose desk it sits at, else its title.
const whoOf=(a,nameOf)=>(a.seat?.agent&&nameOf?.(a.seat.agent))||a.title||'An agent';
export function createMentions({now=()=>Date.now(),gapMs=20000,againMs=300000}={}){
  let seen=null,lastAt=-Infinity;const said=new Map(),queue=new Map();
  const keyOf=a=>`${a.source}|${a.id}|${a.pending?.requestId||''}`;
  return {
    observe(agents,{quiet=false,nameOf}={}){
      const waiting=(agents||[]).filter(a=>a&&a.status==='waiting'&&a.role!=='conductor');
      const keys=new Set(waiting.map(keyOf));
      if(!seen){seen=keys;return ''}
      for(const a of waiting){const k=keyOf(a);if(!seen.has(k)&&!queue.has(k))queue.set(k,a)}
      seen=keys;
      for(const k of [...queue.keys()])if(!keys.has(k))queue.delete(k); // answered meanwhile
      const t=now();
      for(const [k,at] of said)if(t-at>againMs)said.delete(k);
      if(quiet||!queue.size||t-lastAt<gapMs)return '';
      const list=[...queue].filter(([k])=>!said.has(k));queue.clear();
      if(!list.length)return '';
      lastAt=t;for(const [k] of list)said.set(k,t);
      const names=[...new Set(list.map(([,a])=>whoOf(a,nameOf)))];
      return names.length===1?`${names[0]} needs you`:names.length===2?`${names[0]} and ${names[1]} need you`:`${names[0]} and ${names.length-1} others need you`;
    },
  };
}

// UAT cards that need you: assigned to you, or "Needs <your first name>:" / "Needs you:" in the description.
export function waitingOnYou({agents=[],cards=[],refs=[],name='',nameOf}={}){
  const first=norm(name).split(/\s+/)[0];
  const asks=new RegExp(`\\bneeds\\s+(?:you${first?'|'+first.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'):''})\\b`,'i');
  const mine=new Set(refs);
  const out=(agents||[]).filter(a=>a.status==='waiting'&&a.role!=='conductor').map(a=>({kind:'agent',id:a.id,source:a.source,title:whoOf(a,nameOf),
    detail:a.pending?.summary||'Waiting for you'}));
  for(const c of cards||[]){
    if(c.column!=='uat')continue;
    if((c.assignees||[]).some(x=>mine.has(x.node))||asks.test(c.description||''))out.push({kind:'card',id:c.id,number:c.number,title:c.title||''});
  }
  return out;
}

export function chiefChannel(send){
  return {id:'cos',label:'Chief',color:CHIEF_COLOR,prefix:'/cos',icon:'sparkle',placeholder:'Ask your Chief of Staff… (/cos)',send};
}
