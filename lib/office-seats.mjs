// Seats in the 3D office (docs/concepts/12-office.md "Seats", docs/concepts/09-agentflow.md "Seats in the 3D office"):
// AgentFlow agents are the permanent jobs; a live coding session working on one of an agent's cards is the
// one doing that job, and sits at that agent's desk in the common area instead of a temporary desk.
//
//   cleanSeatTag(v)                       a reporter's optional agentflow:{agent, card}, cleaned (or null)
//   parseRunnerTitle(title)               "[Flow] <Agent>: #<n> …" (tools/agent-runner.mjs) -> {agent, card} | null
//   seatIndex(ctx)                        lookups over one environment's AgentFlow agents and cards (cached per ctx)
//   resolveSeat(index, session)           -> {agent: AgentFlow agent id | '', card: card id | '', via} | null
//   canSeeAgent / canSeeCard(access, x)   the viewer's access (lib/office.mjs officeHub) to an agent or a card
//   seatFor(index, seat, access)          what of a seat one viewer may see: {agent, card:{number,title,column}}
//   deskOf(index, agentId, access)        an agent's queue (top 5) and recently finished cards, for one viewer
//
// Pure: no I/O. A session belongs to a person and shows in every environment they are a member of, so a seat
// is resolved per environment, against that environment's agents and cards; elsewhere it is no seat at all.
import {repoMatches} from './office.mjs';
import {QUEUE_ORDER} from '../public/agentflow-core.js';
import {isSnoozed} from '../public/devops-core.js';

export const QUEUE_SHOWN=5,DONE_SHOWN=5,DONE_DAYS=7;
const norm=s=>String(s??'').trim().replace(/\s+/g,' ').toLowerCase();
const str=(v,n)=>typeof v==='string'||typeof v==='number'?String(v).replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,n):'';

// The runner's thread title. The agent's name may hold ": " itself, so the first ": #<digits>" ends it.
const RUNNER=/^\s*\[Flow\]\s+(.+?):\s+#(\d{1,9})\b/i;
// A card number anywhere in a title: "#12", not "&#12", "a#12" or "#12abc".
const CARD_REF=/(?:^|[^\w&#])#(\d{1,9})(?![\w])/;
export function parseRunnerTitle(title){
  const m=RUNNER.exec(String(title||''));return m?{agent:m[1].trim(),card:Number(m[2])}:null;
}
// agentflow:{agent:"<id or name>", card:<number, "#12", or a card id>} -> {agent, card} (card a number or an id
// string; either may be empty), or null when neither is there.
export function cleanSeatTag(v){
  if(!v||typeof v!=='object'||Array.isArray(v))return null;
  const agent=str(v.agent,200);let card='';
  if(Number.isInteger(v.card)&&v.card>0)card=v.card;
  else if(typeof v.card==='string'){const s=str(v.card,200),n=/^#?(\d{1,9})$/.exec(s);card=n?(Number(n[1])||''):s}
  return agent||card?{agent,card}:null;
}

// ctx: lib/office.mjs officeHub context.env(): agents [{id, name, projects, cards:[card ids]}], cards [{id, number,
// title, column, moved, project, snoozedUntil, due}], projects [{id, repos}].
const cache=new WeakMap();
export function seatIndex(ctx){
  let ix=cache.get(ctx);if(ix)return ix;
  const agents=ctx?.agents||[],cards=ctx?.cards||[],byId=new Map(agents.map(a=>[a.id,a])),byName=new Map();
  for(const a of agents){const k=norm(a.name);if(!k)continue;byName.set(k,byName.has(k)?null:a)} // null: two agents share it
  const cardById=new Map(cards.map(c=>[c.id,c])),cardByNumber=new Map();
  for(const c of cards)if(Number.isInteger(c.number)&&!cardByNumber.has(c.number))cardByNumber.set(c.number,c);
  const delegated=new Map();for(const a of agents)for(const id of a.cards||[])(delegated.get(id)||delegated.set(id,[]).get(id)).push(a.id);
  ix={ctx,agents:byId,byName,cards:cardById,cardByNumber,delegated,projects:new Map((ctx?.projects||[]).map(p=>[p.id,p]))};
  cache.set(ctx,ix);return ix;
}
const agentNamed=(ix,v)=>{if(!v)return null;return ix.agents.get(v)||ix.byName.get(norm(v))||null};
const cardFor=(ix,v)=>v===''||v==null?null:typeof v==='number'?ix.cardByNumber.get(v)||null:ix.cards.get(v)||ix.cardByNumber.get(Number(/^#?(\d+)$/.exec(v)?.[1]))||null;
// The runner cuts a name to 80 characters: such a cut name is the one agent whose name starts with it.
const longNamed=(ix,v)=>{const k=norm(v);if(k.length<75)return null;const hits=[...ix.agents.values()].filter(a=>norm(a.name).startsWith(k));return hits.length===1?hits[0]:null};
const soleAgent=(ix,card)=>{const list=ix.delegated.get(card.id)||[];return list.length===1?list[0]:''};

// Which agent and card a session works for, in this environment:
//  1. its reporter's agentflow tag: the agent by id or name; the card by number or id. With a card and no agent,
//     the card's agent when it is delegated to exactly one. An agent named here that this environment does not
//     have means the session works elsewhere: no seat.
//  2. else the runner's title "[Flow] <Agent>: #<n> …": that agent (by name) and its card #n. An agent this
//     environment does not have: no seat.
//  3. else a "#<n>" in the title: card #n, and its agent when it is delegated to exactly one (a seat);
//     to none or several, only the card (no seat). When both the session and the card's project have repos,
//     they must match, so a number from another environment's board is not taken for this one's.
export function resolveSeat(ix,s){
  const tag=s?.agentflow,title=s?.title||'';
  if(tag&&(tag.agent||tag.card!=='')){
    const card=cardFor(ix,tag.card);
    if(tag.agent){const a=agentNamed(ix,tag.agent);return a?{agent:a.id,card:card?.id||'',via:'report'}:null}
    return card?{agent:soleAgent(ix,card),card:card.id,via:'report'}:null;
  }
  const r=parseRunnerTitle(title);
  if(r){const a=agentNamed(ix,r.agent)||longNamed(ix,r.agent);if(!a)return null;return {agent:a.id,card:cardFor(ix,r.card)?.id||'',via:'runner'}}
  const m=CARD_REF.exec(title);if(!m)return null;
  const card=cardFor(ix,Number(m[1]));if(!card)return null;
  const repos=ix.projects.get(card.project)?.repos||[];
  if(s.repo&&repos.length&&!repoMatches(repos,s.repo))return null;
  return {agent:soleAgent(ix,card),card:card.id,via:'card'};
}

// access: {all, projectIds:Set, cardIds?:Set} (lib/office.mjs). cardIds is what a share's scope resolves to;
// without it, a card is visible when its project is.
export const canSeeAgent=(access,a)=>!!a&&!access?.hidden?.agents.has(a.id)&&(!!access?.all||(a.projects||[]).some(id=>access?.projectIds?.has(id)));
export const canSeeCard=(access,c)=>!!c&&!access?.hidden?.cards.has(c.id)&&(!!access?.all||(access?.cardIds?access.cardIds.has(c.id):!!c.project&&!!access?.projectIds?.has(c.project)));
const cardView=c=>({number:c.number,title:c.title,column:c.column});

// A seat as one viewer may see it: the agent when they can see it, the card when they can see it. null: nothing.
export function seatFor(ix,seat,access,{owner=false}={}){
  if(!seat)return null;
  const a=seat.agent&&ix.agents.get(seat.agent),c=seat.card&&ix.cards.get(seat.card);
  const agent=a&&(owner||canSeeAgent(access,a))?a.id:'',card=c&&(owner||canSeeCard(access,c))?cardView(c):null;
  return agent||card?{agent,card}:null;
}

// The panel of an agent's desk: its queue as AgentFlow orders it (agentflow-core.js workQueue: open, not snoozed),
// the first QUEUE_SHOWN, and the cards it finished (moved to UAT or Done) in the last DONE_DAYS days, newest first.
// Only the cards this viewer can see.
export function deskOf(ix,agentId,access,now=Date.now()){
  const a=ix.agents.get(agentId);if(!a)return {queue:[],done:[]};
  const mine=(a.cards||[]).map(id=>ix.cards.get(id)).filter(c=>c&&canSeeCard(access,c));
  const rank=c=>{const i=QUEUE_ORDER.indexOf(c.column);return i<0?QUEUE_ORDER.length:i};
  const queue=mine.filter(c=>c.column!=='done'&&!isSnoozed(c,now)).sort((x,y)=>rank(x)-rank(y)||(x.due||'9999').localeCompare(y.due||'9999')||x.number-y.number);
  const since=now-DONE_DAYS*864e5,done=mine.filter(c=>(c.column==='uat'||c.column==='done')&&Date.parse(c.moved)>=since).sort((x,y)=>Date.parse(y.moved)-Date.parse(x.moved));
  return {queue:queue.slice(0,QUEUE_SHOWN).map(cardView),queued:queue.length,done:done.slice(0,DONE_SHOWN).map(c=>({...cardView(c),moved:c.moved}))};
}
