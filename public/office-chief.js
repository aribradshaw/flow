// The Chief of Staff in the 3D office (docs/concepts/12-office.md "Chief of Staff"): your conductor (a long-lived
// T3 thread your reporter runs, role "conductor") as a companion that walks with you. Type /cos in the chat (the
// gold "Chief" channel) or press E on it to ask; it answers in a gold bubble and the log, with card numbers as
// links that open the card here. Only you see what you ask and what it says (the server sends a conductor's reply
// to its owner only); everyone else sees your Chief walking with you, and "…" while it works.
//
//   const chief=createChief({root, meKey(), members(), live() -> Map, af() -> AgentFlow agents, deskKey(member, a),
//     npc (office-npc.js), label(obj, html, opts), unlabel(l), interact, openPanel({type:'chief'}), post(body) ->
//     POST steer, toast(msg, bad), isQuiet(key), cardId(number) -> id|null, openCard(id), cards(), refs(), myName(),
//     afName(id), lines (the chat log element), showAgent(member, id)})
//   chief.update()             members, AgentFlow or live agents changed: who follows whom (office-npc.js setFollow)
//   chief.agents(member, list) a member's live agents arrived (yours: replies and "needs you" lines)
//   chief.send(text)           ask it (the /cos channel, the panel's Ask box) -> Promise (rejects with what went wrong)
//   o.models()                 reported runners ({models:[{id, label, provider, billing}]}), for the model picker
// The /cos channel is registered with officeChat (public/office-chat.js) while the office is open.
//   chief.frame()              once per frame: keeps bubbles and E on the figures as they are rebuilt
//   chief.panelHtml() / chief.before(panel) / chief.attach(panel)   the panel E opens (redrawn like the agent panel)
//   chief.dispose()
import {icon} from './icons.js';
import {officeChat} from './office-chat.js';
import {CHIEF_NAME,chiefChannel,chiefFigures,conductorOf,createMentions,esc,replyHtml,replySig,waitingOnYou} from './office-chief-core.js';
import {chiefBubble} from './office-threads-core.js';

const ON_IT='Chief is on it…',PENDING_MS=5*60e3,BUBBLE_MS=12000,MENTION_MS=8000;
const time=at=>{const d=new Date(at);return Number.isFinite(d.getTime())?d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):''};

export function createChief(o){
  if(typeof document!=='undefined'&&!document.querySelector('link[data-office-chief]')){const l=document.createElement('link');l.rel='stylesheet';l.href='/office-chief.css';l.dataset.officeChief='';document.head.append(l)}
  const mentions=createMentions();
  let figures=new Map(),unregister=null,pending=null,lastSig=null,bubble=null,dots=new Map(),registered=null,checkAt=0,disposed=false;
  const mine=()=>conductorOf(o.live().get(o.meKey()));
  const myFigure=()=>figures.get(o.meKey());
  const objOf=key=>key?o.npc?.figure(key)||null:null;
  // The bubble sits above the E prompt (promptOf), so both can show at once.
  const heightOf=key=>key?.startsWith('af:')?2.75:2.3,promptOf=key=>key?.startsWith('af:')?1.85:1.45;

  // ---------- who walks with whom ----------
  function update(){
    const next=chiefFigures({members:o.members(),live:o.live(),af:o.af(),deskKey:o.deskKey});
    for(const [member,key] of figures)if(next.get(member)!==key)o.npc?.setFollow(key,null);
    for(const [member,key] of next)o.npc?.setFollow(key,member);
    figures=next;checkAt=0;
  }

  // ---------- bubbles ----------
  function dropBubble(){if(bubble){o.unlabel(bubble.l);bubble=null}}
  function say(html,{ms=BUBBLE_MS,kind='reply'}={}){
    dropBubble();const key=myFigure(),obj=objOf(key);
    bubble={html,kind,key,until:ms?Date.now()+ms:Infinity,l:obj?o.label(obj,`<span class="of-cos-say${kind==='live'?' live':''}">${html}</span>`,{y:heightOf(key),cls:'cos-bubble'}):null};
  }
  // Labels go with their object: a figure that was rebuilt (the org laid out again) gets the bubble back.
  function keepBubble(){
    if(!bubble)return;
    if(Date.now()>bubble.until){dropBubble();return}
    const key=myFigure(),obj=objOf(key);
    if(bubble.l&&bubble.l.obj===obj&&o.labelAlive?.(bubble.l)!==false)return;
    if(bubble.l)o.unlabel(bubble.l);
    bubble.key=key;bubble.l=obj?o.label(obj,`<span class="of-cos-say${bubble.kind==='live'?' live':''}">${bubble.html}</span>`,{y:heightOf(key),cls:'cos-bubble'}):null;
  }
  // Everyone else's Chief: "…" while it works, never what it says.
  function keepDots(){
    const want=new Map();
    for(const [member,key] of figures){
      if(member===o.meKey())continue;
      const c=conductorOf(o.live().get(member));if(c?.status==='running')want.set(member,key);
    }
    for(const [member,d] of dots){const obj=objOf(want.get(member));if(!obj||d.obj!==obj){o.unlabel(d.l);dots.delete(member)}}
    for(const [member,key] of want){if(dots.has(member))continue;const obj=objOf(key);if(obj)dots.set(member,{obj,l:o.label(obj,'<span class="of-cos-say dots">…</span>',{y:heightOf(key),cls:'cos-bubble',near:18})})}
  }

  // ---------- the log ----------
  const linked=text=>replyHtml(text,o.cardId,esc);
  // A line in the chat log (officeChat.post: the gold Chief channel, only in this browser), then its card numbers
  // become links. The bubble is the Chief's own (say), so it can carry links too.
  function log(from,text){
    const lines=o.lines?.(),before=new Set(lines?.children||[]);
    // bubbleOn: a key no member has, so the chat draws no bubble of its own (over your avatar): the Chief's is say().
    try{officeChat.post({channel:'cos',from,text,bubbleOn:'chief-of-staff'})}catch(e){console.error('office chief',e)}
    for(const el of lines?.children||[]){
      if(before.has(el)||!/#\d/.test(text))continue;
      const name=el.querySelector('b');if(!name)continue;
      while(name.nextSibling)name.nextSibling.remove();
      name.insertAdjacentHTML('afterend',' '+linked(text));
    }
  }

  // ---------- asking ----------
  // The acknowledgement is at once ("Chief is on it…" over it); the reply comes with its next report.
  async function send(text){
    const t=String(text||'').trim();if(!t)return;
    const c=mine();
    if(!c)throw Error('No Chief of Staff is reporting for you yet: run flow office bridge on a computer with T3 Code.');
    if(!c.can?.includes('message'))throw Error('Your Chief of Staff cannot take messages from here right now.');
    pending={at:Date.now(),sig:replySig(c.reply)};
    say(esc(ON_IT),{ms:0,kind:'pending'});log('You',t);paint();
    try{await o.post({kind:'message',source:c.source,agentId:c.id,text:t})}
    catch(e){pending=null;dropBubble();paint();throw Error(e.message||'Could not reach your Chief of Staff')}
  }
  // The model its next turn uses (provider:model). A pick sticks until the next report says the same.
  let picked='';
  function modelItems(){
    const seen=new Set(),out=[];
    for(const r of o.models?.()||[])for(const m of r.models||[]){
      if(!m?.id||seen.has(m.id))continue;seen.add(m.id);
      out.push({value:m.id,label:m.label||m.id,group:m.provider||m.id.split(':')[0],sub:m.billing==='metered'?'Metered':m.billing==='included'?'Included':''});
    }
    out.sort((a,b)=>a.group.localeCompare(b.group)||a.label.localeCompare(b.label));
    return out;
  }
  function currentModel(){
    const c=mine(),reported=c?.modelId||'';
    if(picked&&picked!==reported)return picked;
    picked='';return reported;
  }
  async function choose(id){
    const c=mine();
    if(!c?.can?.includes('model')){o.toast?.('Your Chief of Staff cannot change models from here yet.',true);return}
    if(!id||id===currentModel())return;
    picked=id;paint();
    try{await o.post({kind:'model',source:c.source,agentId:c.id,text:id});o.toast?.('Next message uses that model.')}
    catch(e){if(picked===id)picked='';paint();o.toast?.(e.message||'Could not change the model',true)}
  }
  function agents(member,list){
    if(member!==o.meKey())return;
    const c=conductorOf(list),sig=replySig(c?.reply);
    if(lastSig===null){lastSig=sig}
    else if(c?.reply&&sig!==lastSig){
      lastSig=sig;pending=null;
      say(linked(c.reply.text));log('Chief',c.reply.text,{cards:c.reply.cards||[]});
    }
    if(pending&&Date.now()-pending.at>PENDING_MS){pending=null;if(bubble?.kind==='pending')dropBubble()}
    // While it works: what it is thinking or doing ("Thinking: checking UAT cards…"), over it in place of "on it", until
    // its reply. Its live steps come to you only (lib/office.mjs), like its reply.
    const now=c?.status==='running'&&c.live?chiefBubble(c.live):'';
    if(now&&(!bubble||bubble.kind==='pending'||bubble.kind==='live')){
      const html=esc(now);
      if(bubble?.kind==='live'&&bubble.l){if(bubble.html!==html){bubble.html=html;bubble.l.el.innerHTML=`<span class="of-cos-say live">${html}</span>`}}
      else say(html,{ms:0,kind:'live'});
    }else if(!now&&bubble?.kind==='live')dropBubble();
    // One line when one of your agents starts waiting on you, unless you are in Do not disturb.
    if(c){
      const line=mentions.observe(list,{quiet:o.isQuiet(o.meKey()),nameOf:o.afName});
      if(line&&!pending){say(esc(line),{ms:MENTION_MS,kind:'mention'});log('Chief',line)}
    }
    paint();
  }

  // ---------- E: the Chief's panel ----------
  function register(){
    const key=myFigure(),obj=objOf(key);
    if(registered?.obj===obj&&registered?.key===key)return;
    o.interact?.unregister('chief');registered=null;
    if(!obj)return;
    o.interact?.register({id:'chief',object3D:obj,radius:2.6,height:promptOf(key),priority:-1,anyAngle:true,label:`Talk to ${CHIEF_NAME}`,
      onInteract:()=>o.openPanel({type:'chief',id:'chief'})});
    registered={key,obj};
  }
  let form=null,focus=null;
  function box(){
    if(form)return form;
    form=document.createElement('form');form.className='of-cos-ask';
    form.innerHTML=`<label class="of-pk" for="of-cos-q">Ask</label><div class="of-cos-row"><input id="of-cos-q" maxlength="2000" autocomplete="off" placeholder="What's in UAT? Make a card for…"><button type="submit" class="txt primary">Ask</button></div>`;
    form.addEventListener('submit',e=>{e.preventDefault();const i=form.querySelector('input'),t=i.value;i.value='';send(t).catch(err=>{if(!i.value)i.value=t;o.toast(err.message,true)})});
    return form;
  }
  function panelHtml(){
    const c=mine(),me=o.meKey();
    const head=`<div class="of-ph"><span class="of-dot" style="background:#d4a017"></span><b>${esc(CHIEF_NAME)}</b><span class="sp"></span><button type="button" class="ib" data-of="closePanel" aria-label="Close">${icon('x')}</button></div>`;
    if(!c)return head+`<div class="of-pb"><p class="of-note">No Chief of Staff is reporting for you. Run <code>flow office bridge</code> on a computer with T3 Code: it keeps one Chief of Staff thread there for you.</p></div>`;
    const state=c.status==='running'&&c.live?chiefBubble(c.live):pending?ON_IT:c.status==='running'?'Working…':c.status==='waiting'?'Waiting for you in T3 Code':'Listening';
    const waits=waitingOnYou({agents:o.live().get(me)||[],cards:o.cards(),refs:o.refs(),name:o.myName(),nameOf:o.afName});
    const waitHtml=waits.length?`<ul class="of-cos-wait">${waits.slice(0,8).map(w=>w.kind==='agent'
      ?`<li><button type="button" class="txt" data-cos-agent="${esc(w.id)}">${esc(w.title)}</button><span>${esc(w.detail)}</span></li>`
      :`<li>${o.cardId(w.number)?`<button type="button" class="txt" data-cos-card="${esc(w.id)}">#${w.number}</button>`:`#${w.number}`}<span>${esc(w.title)}</span></li>`).join('')}</ul>`
      :'<p class="of-note">Nothing is waiting on you.</p>';
    const said=(c.transcript||[]).filter(l=>l.role==='user'||l.role==='assistant').slice(-6);
    const recent=said.length?`<ol class="of-cos-log">${said.map(l=>`<li class="${l.role}"><span class="of-tx-who">${l.role==='user'?'You':'Chief'}${l.at?` · ${esc(time(l.at))}`:''}</span><div>${linked(l.text)}</div></li>`).join('')}</ol>`:'<p class="of-note">Nothing asked yet.</p>';
    const items=c.can?.includes('model')?modelItems():[],id=currentModel();
    if(id&&!items.some(i=>i.value===id))items.unshift({value:id,label:c.model||id,group:'Current'});
    const named=items.find(i=>i.value===id);
    const modelLabel=named?.label||c.model||'Choose a model';
    const modelRow=c.can?.includes('model')?`<div class="of-row of-model"><span>Model</span><button type="button" class="pk-btn on" data-picker="cos-model" aria-haspopup="listbox" aria-expanded="false"><span class="pk-t">${esc(modelLabel)}</span></button></div>`:'';
    return head+`<div class="of-pb"><div class="of-row"><span>Status</span><b>${esc(state)}</b></div>${c.hostLabel?`<div class="of-row"><span>Where</span><b>${esc(c.hostLabel)}</b></div>`:''}${modelRow}
      <div class="of-cos-ask-slot"></div><div class="of-pk">Waiting on you</div>${waitHtml}<div class="of-pk">Recent</div>${recent}</div>`;
  }
  let panelEl=null;
  function before(panel){const el=document.activeElement;focus=form&&form.contains(el)?{start:el.selectionStart,end:el.selectionEnd}:null;panelEl=panel}
  function attach(panel){
    panelEl=panel;const slot=panel.querySelector('.of-cos-ask-slot');if(!slot)return;
    const f=box();slot.replaceWith(f);
    if(focus){const i=f.querySelector('input');i.focus({preventScroll:true});i.setSelectionRange(focus.start,focus.end)}
    focus=null;
  }
  // The open panel is redrawn by office.js (refreshPanel); paint asks for that when something here changed.
  const paint=()=>o.repaint?.();

  // Card links in bubbles, the log and the panel; your waiting agents in the panel.
  const onClick=async e=>{
    const card=e.target.closest?.('[data-cos-card]');if(card){e.preventDefault();e.stopPropagation();o.openCard(card.dataset.cosCard);return}
    const agent=e.target.closest?.('[data-cos-agent]');if(agent){e.preventDefault();e.stopPropagation();o.showAgent(o.meKey(),agent.dataset.cosAgent);return}
    const model=e.target.closest?.('[data-picker="cos-model"]');if(!model)return;
    e.preventDefault();e.stopPropagation();
    const id=currentModel(),items=modelItems();
    if(id&&!items.some(i=>i.value===id))items.unshift({value:id,label:mine()?.model||id,group:'Current'});
    const {openPicker}=await import('./ui.js');
    openPicker(model,{multi:false,items,selected:id?[id]:[],label:'Model',placeholder:'Search models',empty:items.length?'No matches':'No models reported yet',
      onChange:([next])=>choose(next)});
  };
  o.root?.addEventListener('click',onClick,true);
  try{unregister=officeChat.registerChannel(chiefChannel(text=>send(text)))}catch(e){console.error('office chief: /cos channel',e)}

  return {
    update,agents,send,panelHtml,before,attach,
    frame(){
      if(disposed)return;
      const t=performance.now();if(t<checkAt)return;checkAt=t+400;
      register();keepBubble();keepDots();
    },
    debug:()=>({figures:Object.fromEntries(figures),pending:!!pending,bubble:bubble?{kind:bubble.kind,html:bubble.html}:null,dots:[...dots.keys()]}),
    dispose(){disposed=true;dropBubble();for(const d of dots.values())o.unlabel(d.l);dots.clear();o.interact?.unregister('chief');for(const key of figures.values())o.npc?.setFollow(key,null);o.root?.removeEventListener('click',onClick,true);unregister?.();unregister=null},
  };
}
