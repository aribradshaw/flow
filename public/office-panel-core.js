// The live-agent side panel (docs/concepts/12-office.md): a status dot, the title, and a row of chips.
// What each chip is lives in its tooltip, not a label beside it.
import {icon} from './icons.js';

const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STATUS_COLOR={running:'#3cba6a',waiting:'#e0a100',idle:'#c5ccd3'};
const chip=(text,tip)=>text?`<span class="of-chip" data-tip="${esc(tip)}">${esc(text)}</span>`:'';

// o: {private, title, status, statusLabel, model, host, repo, project, desk, cardNumber, cardTitle, cardId,
//     subs, subsTip, owner, mine, prompt, result, steer}
export function agentGlance(o={}){
  const title=o.private?'Private project':(o.title||'Agent');
  const color=STATUS_COLOR[o.status]||STATUS_COLOR.idle;
  const head=`<div class="of-ph"><span class="of-dot" style="background:${color}" data-tip="${esc(o.statusLabel||'')}" aria-label="${esc(o.statusLabel||'')}"></span><b data-tip="${esc(title)}">${esc(title)}</b><span class="sp"></span><button type="button" class="ib" data-of="closePanel" aria-label="Close">${icon('x')}</button></div>`;
  if(o.private)return head+`<div class="of-pb"><div class="of-chips">${chip(o.model,'Agent')}${chip(o.owner,'Belongs to')}</div><p class="of-note">Private. It works in a repo you can't see here.</p></div>`;
  const card=o.cardNumber?(o.cardId
    ?`<button type="button" class="of-chip" data-tip="${esc(o.cardTitle||'Open the card')}" data-agent-card="${esc(o.cardId)}">#${esc(o.cardNumber)}</button>`
    :chip('#'+o.cardNumber,o.cardTitle||'Card')):'';
  const chips=`<div class="of-chips">${chip(o.model,'Model')}${chip(o.host,'Where it runs')}${chip(o.repo,'Repository')}${chip(o.project,'Project')}${chip(o.desk,'Desk')}${card}${chip(o.subs,o.subsTip||'Also running')}${o.mine?'':chip(o.owner,'Belongs to')}</div>`;
  return head+`<div class="of-pb">${chips}${o.prompt||''}${o.result||''}${o.steer?'<div class="of-steer-slot"></div>':''}</div>`;
}
