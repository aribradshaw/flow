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
import {CHIEF_NAME,chiefChannel,chiefFigures,chiefModelItems,conductorOf,createMentions,esc,replyHtml,replySig,waitingOnYou} from './office-chief-core.js';
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
    const previous=figures;figures=next;
    for(const [member,key] of previous)if(next.get(member)!==key)o.npc?.setFollow(key,null);
    for(const [member,key] of next)o.npc?.setFollow(key,member);
    for(const member of new Set([...previous.keys(),...next.keys()])){
      if(!!previous.get(member)?.startsWith('af:')!==!!next.get(member)?.startsWith('af:'))o.figureChanged?.(member);
    }
    checkAt=0;
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
    if(switching)throw Error('Wait for T3 Code to finish switching models.');
    pending={at:Date.now(),sig:replySig(c.reply)};
    say(esc(ON_IT),{ms:0,kind:'pending'});log('You',t);paint();
    try{await o.post({kind:'message',source:c.source,agentId:c.id,text:t})}
    catch(e){pending=null;dropBubble();paint();throw Error(e.message||'Could not reach your Chief of Staff')}
  }
  // Keep the confirmed choice visible until the bridge reports it. Reconcile by action id even when SSE wins the race.
  let switching=null,timedOut=null,confirmed=null,modelNotice='',modelError=false,switchTimer;
  const modelItems=()=>chiefModelItems(mine()?.modelProviders,o.models?.());
  function currentModel(){
    const c=mine(),id=c?.modelId||'';
    if(confirmed?.agentId===c?.id&&confirmed?.source===c?.source&&confirmed?.previous===id&&Date.now()<confirmed.until)return confirmed.choice;
    confirmed=null;return id;
  }
  function finishSwitch(message,error=false){
    clearTimeout(switchTimer);
    switching=null;modelNotice=message;modelError=error;paint();
    o.toast?.(message,error);
  }
  function modelResult(a){
    const change=switching||timedOut;
    if(!change||a.kind!=='model'||a.agentId!==change.agentId||a.source!==change.source||a.text!==change.choice||!a.result)return false;
    if(!change.actionId){change.early.set(a.id,a);return true}
    if(a.id!==change.actionId)return false;
    timedOut=null;
    if(a.result.ok){
      const reported=mine()?.modelId||'';
      confirmed=reported===change.choice?null:{agentId:change.agentId,source:change.source,choice:change.choice,previous:reported,until:Date.now()+90000};
    }
    finishSwitch(a.result.ok?'Model updated for the next message.':a.result.message||'Could not switch models.',!a.result.ok);
    return true;
  }
  async function choose(id){
    const c=mine();
    if(!c?.can?.includes('model')){o.toast?.('Your Chief of Staff cannot change models from here yet.',true);return}
    if(switching||!id||id===currentModel())return;
    timedOut=null;
    const change=switching={source:c.source,agentId:c.id,choice:id,early:new Map()};
    modelNotice='Waiting for T3 Code to confirm…';modelError=false;paint();
    switchTimer=setTimeout(()=>{
      if(switching!==change)return;
      timedOut=change;
      finishSwitch('T3 Code hasn’t confirmed the switch yet. Check the selected model before sending.',true);
    },45000);
    try{
      const action=await o.post({kind:'model',source:c.source,agentId:c.id,text:id});
      if(switching!==change&&timedOut!==change)return;
      if(!action?.id)throw Error('Could not queue the model change.');
      change.actionId=action.id;
      if(action.result||change.early.has(action.id))modelResult(action.result?action:change.early.get(action.id));
    }catch(e){if(switching===change)finishSwitch(e.message||'Could not change the model',true)}
  }
  function agents(member,list){
    if(member!==o.meKey())return;
    const c=conductorOf(list),sig=replySig(c?.reply);
    if(switching&&(c?.id!==switching.agentId||c?.source!==switching.source)){
      finishSwitch('The Chief of Staff disconnected before confirming the model switch.',true);
    }
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
  let form=null,focus=null,scroll=null;
  function box(){
    if(form)return form;
    form=document.createElement('form');form.className='of-cos-ask';
    form.innerHTML=`<div class="of-cos-row"><textarea id="of-cos-q" rows="2" maxlength="2000" aria-label="Message Chief of Staff" placeholder="Ask a question or hand off work…"></textarea><button type="submit" class="txt primary" aria-label="Send message">${icon('send',14)} Send</button></div>`;
    const input=form.querySelector('textarea');
    input.addEventListener('keydown',e=>{
      if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();form.requestSubmit()}
    });
    form.addEventListener('submit',e=>{
      e.preventDefault();
      const text=input.value;if(!text.trim())return;
      input.value='';
      send(text).catch(err=>{if(!input.value)input.value=text;o.toast(err.message,true)});
    });
    return form;
  }
  function panelHtml(){
    const c=mine(),me=o.meKey();
    const head=`<div class="of-ph of-cos-head"><span class="of-cos-icon" aria-hidden="true">${icon('bot',17)}</span><b>${esc(CHIEF_NAME)}</b><span class="sp"></span><button type="button" class="ib" data-of="closePanel" aria-label="Close Chief of Staff">${icon('x')}</button></div>`;
    if(!c)return head+`<div class="of-pb of-cos-offline"><b>Chief of Staff is offline</b><p>Connect Flow to T3 Code to ask about your board, hand off work, and see what needs you.</p>
      <button type="button" class="txt primary" data-of="connect">Connect your agents</button><p class="of-note">Already connected? Start <code>flow office bridge --conductor</code> on the computer running T3 Code.</p></div>`;
    const state=c.status==='running'&&c.live?chiefBubble(c.live):pending?ON_IT:c.status==='running'?'Working…':c.status==='waiting'?'Waiting for you in T3 Code':'Ready';
    const waits=waitingOnYou({agents:o.live().get(me)||[],cards:o.cards(),refs:o.refs(),name:o.myName(),nameOf:o.afName});
    const waitHtml=waits.length?`<ul class="of-cos-wait">${waits.slice(0,8).map(w=>w.kind==='agent'
      ?`<li><button type="button" class="txt" data-cos-agent="${esc(w.id)}">${esc(w.title)}</button><span>${esc(w.detail)}</span></li>`
      :`<li>${o.cardId(w.number)?`<button type="button" class="txt" data-cos-card="${esc(w.id)}">#${w.number}</button>`:`#${w.number}`}<span>${esc(w.title)}</span></li>`).join('')}</ul>`
      :'';
    const said=(c.transcript||[]).filter(l=>l.role==='user'||l.role==='assistant').slice(-6);
    const history=c.can?.includes('history')?`<button type="button" class="txt of-cos-history" data-cos-history>Full thread ${icon('arrowR',12)}</button>`:'';
    const recent=said.length?`<ol class="of-cos-log">${said.map(l=>`<li class="${l.role}"><span class="of-tx-who">${l.role==='user'?'You':'Chief'}${l.at?` · ${esc(time(l.at))}`:''}</span><div>${linked(l.text)}</div></li>`).join('')}</ol>`:
      `<div class="of-cos-starters"><p>Ask about your board or hand off a task.</p><button type="button" class="txt" data-cos-starter="What’s waiting on me in UAT?">What’s in UAT?</button><button type="button" class="txt" data-cos-starter="What’s blocked right now?">What’s blocked?</button></div>`;
    const items=modelItems(),id=currentModel(),named=items.find(i=>i.value===id);
    const provider=named?.group||c.modelProviders?.find(p=>id.startsWith(p.id+':'))?.label||id.split(':')[0];
    const modelLabel=named?.label||(id&&id!==c.modelId?id.split(':').slice(1).join(':'):c.model)||'Project default';
    const modelValue=[provider,modelLabel].filter(Boolean).join(' · ');
    const modelRow=`<div class="of-cos-model"><span class="of-cos-k">Model for next message</span>${c.can?.includes('model')?
      `<button type="button" class="pk-btn on" data-picker="cos-model" aria-label="Change model for next message: ${esc(modelValue)}" aria-haspopup="listbox" aria-expanded="${!!o.modelPickerOpen?.()}" aria-disabled="${!!switching}"><span class="pk-t">${esc(modelValue)}</span>${icon('chevD',12)}</button>`:`<b>${esc(modelValue)}</b>`}
      ${modelNotice?`<small class="of-cos-model-note${modelError?' bad':''}" role="status">${esc(modelNotice)}</small>`:''}</div>`;
    return head+`<div class="of-cos-meta">${modelRow}<div class="of-cos-state" title="${esc(c.hostLabel||'')}" data-state="${c.status}"><i></i><span>${esc(state)}</span></div></div>
      <div class="of-cos-body">${waitHtml?`<section><h3>Waiting on you <span>${waits.length}</span></h3>${waitHtml}</section>`:''}
      <section><div class="of-cos-section"><h3>Conversation</h3>${history}</div>${recent}</section></div>
      <div class="of-cos-ask-slot"></div>`;
  }
  const focusable='[data-picker="cos-model"],[data-cos-history],[data-cos-starter],[data-cos-card],[data-cos-agent],[data-of="closePanel"],[data-of="connect"]';
  function before(panel){
    const el=document.activeElement,body=panel.querySelector('.of-cos-body');
    scroll=body?{top:body.scrollTop,end:body.scrollHeight-body.scrollTop-body.clientHeight<24}:null;
    focus=panel.contains(el)?el:null;
  }
  function attach(panel){
    const slot=panel.querySelector('.of-cos-ask-slot'),body=panel.querySelector('.of-cos-body');
    if(slot){
      const f=box();slot.replaceWith(f);
      f.querySelector('[type="submit"]').disabled=!!switching||!mine()?.can?.includes('message');
      body.scrollTop=!scroll||scroll.end?body.scrollHeight:scroll.top;
    }
    if(form?.contains(focus)&&focus.isConnected){focus.focus({preventScroll:true})}
    else if(focus?.matches(focusable)){
      const restored=[...panel.querySelectorAll(focusable)].find(el=>el.outerHTML===focus.outerHTML||
        el.matches('[data-picker="cos-model"]')&&focus.matches('[data-picker="cos-model"]'));
      (restored||panel.querySelector('[data-of="closePanel"]'))?.focus({preventScroll:true});
    }
    focus=null;
  }
  // The open panel is redrawn by office.js (refreshPanel); paint asks for that when something here changed.
  const launch=o.root?.querySelector('[data-of="chief"]');
  function paint(){
    if(launch){
      const c=mine(),state=c?.status==='running'?'Working':c?.status==='waiting'?'Waiting':c?'Ready':'Offline';
      const label=`Chief of Staff · ${state}`;
      if(launch.getAttribute('aria-label')!==label){launch.setAttribute('aria-label',label);launch.dataset.tip=label;launch.dataset.state=state.toLowerCase()}
    }
    o.repaint?.();
  }

  // Card links in bubbles, the log and the panel; your waiting agents in the panel.
  const onClick=e=>{
    const card=e.target.closest?.('[data-cos-card]');if(card){e.preventDefault();e.stopPropagation();o.openCard(card.dataset.cosCard);return}
    const agent=e.target.closest?.('[data-cos-agent]');if(agent){e.preventDefault();e.stopPropagation();o.showAgent(o.meKey(),agent.dataset.cosAgent);return}
    const starter=e.target.closest?.('[data-cos-starter]');if(starter){const input=box().querySelector('textarea');if(!input.value.trim())input.value=starter.dataset.cosStarter;input.focus();return}
    if(e.target.closest?.('[data-cos-history]')){const c=mine();if(c)o.history?.(c);return}
    const model=e.target.closest?.('[data-picker="cos-model"]');if(!model)return;
    e.preventDefault();e.stopPropagation();
    if(switching)return;
    const id=currentModel(),items=modelItems();
    if(id&&!items.some(i=>i.value===id))items.unshift({value:id,label:mine()?.model||id,group:'Current'});
    o.openPicker?.(model,{multi:false,items,selected:id?[id]:[],label:'Model',searchGroups:true,placeholder:'Search models or providers',empty:items.length?'No matches':'No models reported yet',
      onChange:([next])=>choose(next)});
  };
  o.root?.addEventListener('click',onClick,true);
  try{unregister=officeChat.registerChannel(chiefChannel(text=>send(text)))}catch(e){console.error('office chief: /cos channel',e)}
  paint();

  return {
    update,agents,send,panelHtml,before,attach,modelResult,figureFor:member=>figures.get(member),
    frame(){
      if(disposed)return;
      const t=performance.now();if(t<checkAt)return;checkAt=t+400;
      register();keepBubble();keepDots();
    },
    debug:()=>({figures:Object.fromEntries(figures),pending:!!pending,bubble:bubble?{kind:bubble.kind,html:bubble.html}:null,dots:[...dots.keys()]}),
    dispose(){disposed=true;clearTimeout(switchTimer);switching=timedOut=null;dropBubble();for(const d of dots.values())o.unlabel(d.l);dots.clear();o.interact?.unregister('chief');for(const key of figures.values())o.npc?.setFollow(key,null);o.root?.removeEventListener('click',onClick,true);unregister?.();unregister=null},
  };
}
