// Talking to your own coding agent from the 3D office's agent panel (docs/concepts/12-office.md): its
// transcript tail, a message box ("Send to agent": Enter sends, Shift+Enter is a new line) and Stop, with
// a confirm. Only for the agent's owner: the server sends the transcript and can only to them.
//
//   createSteer({post, toast})   one per open office. post(body) -> POST /api/office/{env}/steer
//     .isSteer(action)           true for message / stop actions (the rest are Allow / Deny answers)
//     .track(action, state)      an action event from the stream: state 'sent' or 'done'
//     .before(panel)             call before the panel's HTML is replaced (keeps focus, the draft, the scroll)
//     .attach(slot, agent)       fill the panel's slot for this agent (the same element is reused per agent)
//
// The panel is redrawn whenever the agent reports (every few seconds), so the box is one element per agent
// that is moved into each new panel, never rebuilt: the draft and the caret survive the redraws.
import {icon} from './icons.js';
import {esc} from './ui.js';
import {liveLine} from './office-threads-core.js';

export const MESSAGE_MAX=2000;
const ROLE={user:'You',assistant:'Agent',tool:'Tool'};
const KEEP=3; // the latest messages and stops shown under the box
const time=at=>{const d=new Date(at);return Number.isFinite(d.getTime())?d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):''};

export function transcriptHtml(lines){
  if(!lines?.length)return '<p class="of-note">No transcript yet.</p>';
  return `<ol class="of-tx">${lines.map(l=>`<li class="of-tx-${esc(l.role)}"><span class="of-tx-who">${ROLE[l.role]||esc(l.role)}${l.at?` · ${esc(time(l.at))}`:''}</span><div class="of-tx-text">${esc(l.text)}</div></li>`).join('')}</ol>`;
}
// One message or stop as its owner sees it: pending (being sent) -> sent (waiting for the reporter) -> its result.
export function stepHtml(x,host){
  const what=x.kind==='stop'?'Stop':`“${esc(x.text.length>80?x.text.slice(0,79)+'…':x.text)}”`;
  const state=x.state==='pending'?'Sending…':x.state==='failed'?esc(x.error||'Not sent'):x.state==='sent'?`Sent. Waiting for ${esc(host||'the reporter')}…`:esc(x.result?.message||'Done');
  const cls=x.state==='done'?(x.result?.ok?'ok':'bad'):x.state==='failed'?'bad':'';
  return `<li class="of-step ${cls}" data-state="${esc(x.state)}"><span class="of-step-what">${what}</span><span class="of-step-state">${state}</span></li>`;
}

export function createSteer({post,toast=()=>{}}){
  if(typeof document!=='undefined'&&!document.querySelector('link[data-office-steer]')){const l=document.createElement('link');l.rel='stylesheet';l.href='/office-steer.css';l.dataset.officeSteer='';document.head.append(l)}
  const boxes=new Map(),steps=new Map();let focus=null;
  const list=id=>steps.get(id)||(steps.set(id,[]),steps.get(id));
  const isSteer=a=>a?.kind==='message'||a?.kind==='stop';
  function track(a,state){
    if(!isSteer(a))return;
    const l=list(a.agentId);let x=l.find(s=>s.id===a.id)||l.find(s=>!s.id&&s.kind===a.kind&&(a.kind==='stop'||s.text===a.text));
    if(!x){x={kind:a.kind,text:a.text||''};l.push(x)}
    Object.assign(x,{id:a.id,state:a.result?'done':state,result:a.result||x.result,at:a.at});
    if(l.length>KEEP)l.splice(0,l.length-KEEP);
    for(const [id,b] of boxes)if(id===a.agentId)paint(b);
  }
  function paint(b){
    const a=b.agent,l=list(a.id);
    b.el.querySelector('.of-steps').innerHTML=l.map(x=>stepHtml(x,a.host)).join('');
    const tx=b.el.querySelector('.of-tx-wrap');
    if(tx){const sig=JSON.stringify(a.transcript||[]);if(sig!==b.sig){const end=tx.scrollHeight-tx.scrollTop-tx.clientHeight<24||!b.sig;b.sig=sig;tx.innerHTML=transcriptHtml(a.transcript);if(end)tx.scrollTop=tx.scrollHeight}}
    // What it is doing this moment (its live steps: owner only), like T3's thread view.
    const now=b.el.querySelector('.of-now'),live=a.status!=='idle'&&a.live;
    now.hidden=!live;
    if(live){const html=`<div class="of-pk">Now</div><div class="of-now-line">${esc(liveLine(live))}</div>${live.phase!=='tool'&&live.text?`<div class="of-now-text">${esc(live.text)}</div>`:''}${live.steps?.length>1?`<ol class="of-now-steps">${live.steps.slice(-5,-1).map(x=>`<li>${esc(x.text)}</li>`).join('')}</ol>`:''}`;if(now.innerHTML!==html)now.innerHTML=html}
    const can=a.can||[],stop=b.el.querySelector('.of-stop');
    b.el.querySelector('.of-msg').hidden=!can.includes('message');
    const stopping=l.some(x=>x.kind==='stop'&&(x.state==='pending'||x.state==='sent'));
    stop.hidden=!can.includes('stop')||a.status==='idle';
    stop.innerHTML=b.confirm?`<span>Stop this agent's turn?</span><button type="button" class="txt danger" data-steer="stopYes">Stop it</button><button type="button" class="txt" data-steer="stopNo">Keep going</button>`
      :`<button type="button" class="txt" data-steer="stop"${stopping?' disabled':''}>${icon('ban',13)}${stopping?'Stopping…':'Stop'}</button>`;
    const n=b.input.value.length;b.el.querySelector('.of-count').textContent=n>MESSAGE_MAX-200?`${n} / ${MESSAGE_MAX}`:'';
    b.el.querySelector('[data-steer="send"]').disabled=!b.input.value.trim()||n>MESSAGE_MAX;
  }
  async function send(b,kind){
    const a=b.agent,text=kind==='message'?b.input.value.trim():'';
    if(kind==='message'&&(!text||text.length>MESSAGE_MAX))return;
    const x={kind,text,state:'pending'};const l=list(a.id);l.push(x);if(l.length>KEEP)l.shift();
    if(kind==='message'){b.input.value='';}
    b.confirm=false;paint(b);
    try{const r=await post({kind,source:a.source,agentId:a.id,...kind==='message'?{text}:{}});if(!x.id){x.id=r.id;if(x.state==='pending')x.state=r.result?'done':'sent';x.result=r.result}}
    catch(e){x.state='failed';x.error=e.message;if(kind==='message'&&!b.input.value)b.input.value=text;toast(e.message,true)}
    paint(b);
  }
  function box(a){
    let b=boxes.get(a.id);if(b)return b;
    const el=document.createElement('div');el.className='of-steer';
    el.innerHTML=`<div class="of-now" hidden aria-live="polite"></div><div class="of-pk">Transcript</div><div class="of-tx-wrap" tabindex="0" aria-label="Transcript, newest last"></div>
      <form class="of-msg"><label class="of-pk" for="of-steer-${esc(a.id)}">Send to agent</label>
        <textarea id="of-steer-${esc(a.id)}" rows="2" maxlength="${MESSAGE_MAX}" placeholder="Message your agent… (Enter to send, Shift+Enter for a new line)" autocomplete="off"></textarea>
        <div class="of-msg-row"><span class="of-count" aria-live="polite"></span><button type="submit" class="txt primary" data-steer="send">${icon('send',13)}Send</button></div></form>
      <div class="of-stop"></div><ul class="of-steps" aria-live="polite"></ul>`;
    b={el,agent:a,input:el.querySelector('textarea'),confirm:false,sig:''};
    b.input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send(b,'message')}});
    b.input.addEventListener('input',()=>paint(b));
    el.querySelector('form').addEventListener('submit',e=>{e.preventDefault();send(b,'message')});
    el.addEventListener('click',e=>{const s=e.target.closest('[data-steer]')?.dataset.steer;
      if(s==='stop'){b.confirm=true;paint(b);el.querySelector('[data-steer="stopNo"]')?.focus()}
      else if(s==='stopNo'){b.confirm=false;paint(b);el.querySelector('[data-steer="stop"]')?.focus()}
      else if(s==='stopYes')send(b,'stop');});
    boxes.set(a.id,b);return b;
  }
  return {
    isSteer,track,
    before(panel){const el=document.activeElement;const b=[...boxes.values()].find(x=>x.el.contains(el));focus=b&&panel.contains(b.el)?{id:b.agent.id,input:el===b.input,start:b.input.selectionStart,end:b.input.selectionEnd,el}:null},
    attach(slot,a){
      if(!slot)return;
      if(!a.mine||(!a.transcript&&!a.can?.length&&!a.live)){slot.remove();return}
      const b=box(a);b.agent=a;slot.replaceWith(b.el);paint(b);
      if(focus?.id===a.id){if(focus.input){b.input.focus({preventScroll:true});b.input.setSelectionRange(focus.start,focus.end)}else if(b.el.contains(focus.el))focus.el.focus({preventScroll:true})}
      focus=null;
    },
  };
}
