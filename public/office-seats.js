// Seats in the 3D office (docs/concepts/12-office.md "Seats"): a live session working on an AgentFlow agent's card
// sits at that agent's desk in the common area instead of a desk in its owner's room. The server decides the
// seat (lib/office-seats.mjs) and sends it on the session as seat:{agent, card:{number,title,column}|null}, only
// to viewers who may see it. This module is the page's side: who sits where, the tag and the desk panel. No Three.js.
import {COLUMNS} from './devops-core.js';

const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); // as ui.js, without the DOM

const COLUMN=Object.fromEntries(COLUMNS);
const columnName=k=>COLUMN[k]||k||'';

// live: Map(member key -> sessions as the server sent them); placed: the AgentFlow agent ids drawn in the
// common area. -> Map(agent id -> [{member, agent: session}]), in report order.
export function seatsByAgent(live,placed){
  const out=new Map();
  for(const [member,list] of live||[])for(const a of list||[]){
    const id=a?.seat?.agent;if(!id||!placed?.has(id))continue;
    (out.get(id)||out.set(id,[]).get(id)).push({member,agent:a});
  }
  return out;
}
// Is this session drawn at an AgentFlow desk (so not in its owner's room)?
export const isSeated=(a,placed)=>!!a?.seat?.agent&&!!placed?.has(a.seat.agent);
// The tag over a session: at a desk "<Agent> · #12"; elsewhere its own name, with " · #12" when it is linked to a
// card its name does not already mention.
export function seatTag(a,agentName,name){
  const n=a?.seat?.card?.number,ref=n?`#${n}`:'';
  if(agentName)return ref?`${agentName} · ${ref}`:agentName;
  return ref&&!new RegExp(`#${n}(?!\\d)`).test(name||'')?`${name} · ${ref}`:name;
}
// The desk part of an AgentFlow agent's panel: who is there now (buttons that open each session), its queue and
// what it finished this week. desk: the server's {queue, queued, done} (absent: an older server, nothing shown).
// nameOf(member key) -> the owner's name; vendorName(vendor) -> e.g. "Claude".
export function deskPanel(af,sitting,{desk,nameOf=()=>'',vendorName=v=>v,me=''}={}){
  const card=c=>`<li><b>#${esc(c.number)}</b> ${esc(c.title)}<span>${esc(columnName(c.column))}</span></li>`;
  const who=sitting.map(({member,agent:a})=>{
    const what=a.private?'Private project':a.seat?.card?`#${a.seat.card.number} ${a.seat.card.title}`:a.title||vendorName(a.vendor);
    return `<li><button type="button" class="of-seat ${esc(a.status)}" data-seat-agent="${esc(a.id)}" data-seat-member="${esc(member)}"><i class="of-sd"></i>${esc(what)}<span>${esc(vendorName(a.vendor))} · ${esc(member===me?'You':nameOf(member))}</span></button></li>`;
  }).join('');
  let html=`<div class="of-desk"><div class="of-dh">At the desk now</div>${who?`<ul>${who}</ul>`:`<p class="of-note">Nobody: no live session is working on ${esc(af.name)}'s cards.</p>`}`;
  if(desk){
    const more=desk.queued>desk.queue.length?` <span>(${esc(desk.queued)} in all)</span>`:'';
    html+=`<div class="of-dh">Queue${more}</div>${desk.queue.length?`<ul>${desk.queue.map(card).join('')}</ul>`:'<p class="of-note">Nothing delegated that you can see.</p>'}`;
    if(desk.done?.length)html+=`<div class="of-dh">Finished this week</div><ul>${desk.done.map(card).join('')}</ul>`;
  }
  return html+'</div>';
}
