// Chat with OneProfileID friends, bottom right (docs/concepts/11-chat.md). Modelled on OneProfileID's own
// Messages bubble: a launcher with an unread badge, the conversation list, a "new message" picker of
// friends, and a conversation with bubbles, times and a composer. The server (lib/chat.mjs) talks to
// OneProfileID with this browser's own session; this module only shows what it returns. Rules that need
// no DOM (times, merging, card links) live in chat-core.js.
//
// Flow cards: sendRecord(kind, id) (a card's "Send in chat", its menu, or dragging a DevOps card onto
// the chat) attaches the card to a message. It is sent as text with a deep link (chat-core cardMessage),
// and any message linking to a card on this Flow shows as a card bubble, looked up with the reader's own
// access: from the open workspace when it is there, otherwise POST /api/chat/cards. Without access only
// the title the message itself carries shows, with a note.
//
// Polls only while the tab is visible: the list every 15 s while it shows, an open conversation every
// 5 s, the badge every 60 s while the chat is closed. Hidden entirely in local mode and until OneProfileID
// enables messages for this app.
import {icon} from './icons.js';
import {personPhoto} from './ui.js';
import {store} from './store.js';
import {currentEnv} from './sync.js';
import {sessionUser,signInMode} from './account.js';
import {addDropTarget} from './drag.js';
import {memberColor} from './devops-core.js';
import * as core from './chat-core.js';

const API='/api/chat';
const UNREACHABLE="Can't reach your messages right now.";
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const visible=()=>document.visibilityState!=='hidden';
const narrow=()=>innerWidth<700;
const state={started:false,available:false,open:false,view:'list',person:null,conversations:[],listLoaded:false,friends:null,friendsAt:0,
  messages:[],more:false,threadToken:0,unread:0,sending:false,attach:null,pending:null,listTimer:0,threadTimer:0,badgeTimer:0,checking:null};
let hooks={openLink:async()=>{},toast:()=>{}};
let els=null;

export const chatAvailable=()=>state.available;

// ---------- requests ----------
async function request(path,body,{timeout=15000}={}){
  let r;
  try{r=await fetch(API+path,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(timeout),...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})})}
  catch{const e=new Error(UNREACHABLE);e.network=true;throw e}
  const data=await r.json().catch(()=>({}));
  if(data?.available===false&&data.code==='chat_unavailable'){setAvailable(false);const e=new Error('Chat is not available.');e.unavailable=true;throw e}
  if(r.status===401){setAvailable(false);const e=new Error('Sign in again to use chat.');e.status=401;throw e}
  if(!r.ok){const e=new Error(data.error||'Messages could not load. Try again.');e.status=r.status;e.code=data.code;e.retryAfter=data.retryAfter;throw e}
  return data;
}

// ---------- availability ----------
async function check(){
  if(signInMode()!=='opid'||!sessionUser()?.id){setAvailable(false);return}
  if(state.checking)return state.checking;
  const run=state.checking=request('/status').catch(e=>e.unavailable||e.status===401?null:{available:true,unread:null}).then(d=>{
    if(!d?.available){setAvailable(false);return}
    setAvailable(true);if(Number.isInteger(d.unread))setBadge(d.unread);
  }).finally(()=>{if(state.checking===run)state.checking=null});
  return run;
}
function setAvailable(on){
  if(state.available===on)return;
  state.available=on;
  if(!els)return;
  els.launcher.hidden=!on;document.body.classList.toggle('chat-on',on);
  if(!on){close({restoreFocus:false});clearTimers()}else badgeLoop();
  dispatchEvent(new Event('flow:chat'));
}
function clearTimers(){clearTimeout(state.listTimer);clearTimeout(state.threadTimer);clearTimeout(state.badgeTimer)}

// ---------- small DOM helpers ----------
const h=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e};
const say=t=>{els.status.textContent='';requestAnimationFrame(()=>{els.status.textContent=t})};
function show(el,on){
  if(el.hidden===!on)return;el.hidden=!on;
  if(on&&!reduced())el.animate?.([{opacity:0,transform:'translateY(3px)'},{opacity:1,transform:'none'}],{duration:180,easing:'cubic-bezier(.22,1,.36,1)'});
}
function avatar(person,cls='chat-av'){
  const a=h('span',cls);a.setAttribute('aria-hidden','true');
  const [bg,fg]=memberColor(person?.username||person?.id||person?.name||'');a.style.background=bg;a.style.color=fg;
  a.append(h('span','chat-av-t',core.initials(person?.name)));
  const src=person?.photo||person?.image;
  if(src){const img=h('img');img.alt='';img.decoding='async';img.referrerPolicy='no-referrer';img.src=src;img.addEventListener('error',()=>img.remove(),{once:true});a.append(img)}
  return a;
}
function setBadge(n){
  state.unread=n;const b=els.badge,on=n>0;
  if(on)b.textContent=n>99?'99+':String(n);
  show(b,on);
  els.launcher.setAttribute('aria-label',on?`Messages, ${n} unread`:'Messages');
}

// ---------- markup ----------
const SVG_CHAT='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.1A8 8 0 1 1 20 12Z"/></svg>';
function build(){
  const root=document.createElement('div');root.className='chat-root';
  root.innerHTML=`<button type="button" class="chat-launcher" aria-label="Messages" aria-expanded="false" aria-controls="chatPanel" aria-haspopup="dialog" data-tip="Messages" hidden>${SVG_CHAT}<span class="chat-badge" hidden></span></button>
  <section id="chatPanel" class="chat-panel" role="dialog" aria-modal="false" aria-labelledby="chatTitle" data-view="list" hidden>
    <div class="chat-h">
      <button type="button" class="chat-ib" data-chat="back" aria-label="Back to conversations" hidden>${icon('chevL',16)}</button>
      <span class="chat-h-av" hidden></span>
      <h2 id="chatTitle" tabindex="-1">Messages</h2><span class="sp"></span>
      <button type="button" class="chat-ib" data-chat="new" aria-label="New message" data-tip="New message">${icon('pencil',15)}</button>
      <button type="button" class="chat-ib" data-chat="close" aria-label="Close messages" data-tip="Close · Esc">${icon('x',15)}</button>
    </div>
    <p class="sr-only" role="status" aria-live="polite" data-c="status"></p>
    <div class="chat-pending" data-c="pending" hidden></div>
    <div class="chat-view" data-v="list">
      <ul class="chat-skel" aria-hidden="true" hidden><li><span></span><span><i></i><i></i></span></li><li><span></span><span><i></i><i></i></span></li><li><span></span><span><i></i><i></i></span></li></ul>
      <ul class="chat-list" data-c="list" aria-label="Conversations"></ul>
      <p class="chat-note" data-c="listEmpty" hidden>No conversations yet. Press ${icon('pencil',11)} to message a friend: someone you follow on OneProfileID who follows you back.</p>
      <div class="chat-note chat-err" data-c="listErr" hidden><p></p><button type="button" class="txt" data-chat="retryList">Retry</button></div>
    </div>
    <div class="chat-view" data-v="pick" hidden>
      <div class="chat-search"><input type="search" data-c="q" placeholder="Search friends" aria-label="Search friends" autocomplete="off" spellcheck="false"></div>
      <ul class="chat-list" data-c="pickList" aria-label="Friends"></ul>
      <p class="chat-note" data-c="pickNote" hidden></p>
    </div>
    <div class="chat-view" data-v="thread" hidden>
      <div class="chat-scroll" data-c="scroll">
        <button type="button" class="chat-older" data-chat="older" hidden>Load earlier messages</button>
        <ol class="chat-msgs" data-c="msgs" aria-label="Conversation"></ol>
        <p class="chat-note" data-c="threadEmpty" hidden></p>
        <div class="chat-note chat-err" data-c="threadErr" hidden><p></p><button type="button" class="txt" data-chat="retryThread">Retry</button></div>
      </div>
      <div class="chat-attach" data-c="attach" hidden></div>
      <form class="chat-composer" data-c="composer">
        <label for="chatInput" class="sr-only">Message</label>
        <textarea id="chatInput" rows="1" placeholder="Message" autocomplete="off" aria-describedby="chatSendErr"></textarea>
        <button type="submit" class="chat-send" aria-label="Send message" data-tip="Send · Enter">${icon('send',16)}<span class="chat-spin" aria-hidden="true"></span></button>
      </form>
      <p id="chatSendErr" class="chat-send-err" role="alert" hidden></p>
    </div>
    <div class="chat-drop" aria-hidden="true" hidden><p>Drop to send this card</p></div>
  </section>`;
  document.body.append(root);
  const q=s=>root.querySelector(s),c=n=>q(`[data-c="${n}"]`);
  els={root,launcher:q('.chat-launcher'),badge:q('.chat-badge'),panel:q('.chat-panel'),title:q('#chatTitle'),back:q('[data-chat=back]'),newBtn:q('[data-chat=new]'),headAv:q('.chat-h-av'),
    status:c('status'),pending:c('pending'),skel:q('.chat-skel'),list:c('list'),listEmpty:c('listEmpty'),listErr:c('listErr'),q:c('q'),pickList:c('pickList'),pickNote:c('pickNote'),
    scroll:c('scroll'),older:q('[data-chat=older]'),msgs:c('msgs'),threadEmpty:c('threadEmpty'),threadErr:c('threadErr'),attach:c('attach'),composer:c('composer'),input:q('#chatInput'),
    send:q('.chat-send'),sendErr:q('#chatSendErr'),drop:q('.chat-drop'),views:Object.fromEntries([...root.querySelectorAll('[data-v]')].map(v=>[v.dataset.v,v]))};
  bind();
}

// ---------- open, close, views ----------
function open(){
  if(state.open||!state.available)return;state.open=true;
  els.panel.hidden=false;els.launcher.setAttribute('aria-expanded','true');
  if(!reduced())els.panel.animate?.([{opacity:0,transform:'translateY(8px) scale(.98)'},{opacity:1,transform:'none'}],{duration:200,easing:'cubic-bezier(.22,1,.36,1)'});
  els.title.focus({preventScroll:true});
  if(state.view==='thread'&&state.person)loadThread({quiet:true});else if(state.view==='pick'){openPick();return}else loadList();
  schedule();
}
function close({restoreFocus=true}={}){
  if(!state.open)return;state.open=false;
  els.launcher.setAttribute('aria-expanded','false');
  const p=els.panel;
  const done=()=>{if(!state.open)p.hidden=true};
  if(reduced()||!p.animate)done();else p.animate([{opacity:1,transform:'none'},{opacity:0,transform:'translateY(8px) scale(.98)'}],{duration:140,easing:'ease-in'}).finished.then(done,done);
  setDrop(false);schedule();
  if(restoreFocus&&!els.launcher.hidden)els.launcher.focus({preventScroll:true});
}
function setView(v,{dir=1}={}){
  state.view=v;els.panel.dataset.view=v;
  for(const [k,el] of Object.entries(els.views))el.hidden=k!==v;
  els.back.hidden=v==='list';els.newBtn.hidden=v!=='list';els.headAv.hidden=v!=='thread';
  els.back.setAttribute('aria-label',v==='thread'&&state.cameFrom==='pick'?'Back to friends':'Back to conversations');
  if(!reduced())els.views[v].animate?.([{opacity:0,transform:`translateX(${dir*14}px)`},{opacity:1,transform:'none'}],{duration:220,easing:'cubic-bezier(.22,1,.36,1)'});
  paintPending();
}
function showList(){
  const prev=state.person?.username;
  state.person=null;state.threadToken++;state.attach=null;state.cameFrom='';
  els.title.textContent='Messages';setView('list',{dir:-1});
  const row=[...els.list.querySelectorAll('[data-username]')].find(b=>b.dataset.username===prev);
  (row||els.title).focus({preventScroll:true});
  loadList({quiet:state.listLoaded});schedule();
}
// From a conversation opened in the picker, back goes to the picker (an attached card goes with it).
function back(){
  if(state.view==='thread'&&state.cameFrom==='pick'){state.person=null;state.threadToken++;if(state.attach)state.pending=state.attach;state.attach=null;openPick();return}
  state.pending=null;showList();
}

// ---------- conversation list ----------
function personRow(p,{onPick,meta=null,preview=''}){
  const li=h('li'),b=h('button','chat-row');b.type='button';b.dataset.username=p.username;
  const copy=h('span','chat-row-c');copy.append(h('strong','',p.name));
  if(preview!==null)copy.append(h('span','chat-prev',preview));
  b.append(avatar(p),copy);if(meta)b.append(meta);
  b.addEventListener('click',()=>onPick(p));
  li.append(b);return {li,b};
}
function renderList(){
  els.list.replaceChildren();
  for(const item of state.conversations){
    const meta=h('span','chat-meta');
    if(item.lastMessage?.createdAt){const t=h('time','',core.listTime(item.lastMessage.createdAt));t.dateTime=item.lastMessage.createdAt;meta.append(t)}
    if(item.unread)meta.append(h('span','chat-count',item.unread>99?'99+':String(item.unread)));
    const preview=core.previewText(item,location.origin),{li,b}=personRow(item,{onPick:openThread,meta,preview});
    if(item.unread)b.dataset.unread='true';
    b.setAttribute('aria-label',`${item.name}${item.unread?`, ${item.unread} unread`:''}. ${preview}`);
    els.list.append(li);
  }
}
async function loadList({quiet=false}={}){
  if(!state.listLoaded&&!quiet)show(els.skel,true);
  try{
    const d=await request('/conversations');
    state.conversations=d.conversations||[];state.listLoaded=true;setBadge(d.unread||0);
    if(state.view==='list'){renderList();show(els.listErr,false);show(els.listEmpty,!state.conversations.length)}
    if(!quiet)say(state.conversations.length?`${state.conversations.length} conversation${state.conversations.length===1?'':'s'}`:'No conversations yet.');
  }catch(e){
    if(e.unavailable)return;
    if(!state.listLoaded||!quiet){els.listErr.querySelector('p').textContent=e.message;show(els.listErr,true);if(!quiet)say(e.message)}
  }finally{show(els.skel,false)}
}

// ---------- new message picker (and "send this card to…") ----------
function openPick(){
  // Any conversation still loading must not take the panel back.
  if(state.person){state.person=null;state.threadToken++}
  state.cameFrom='';els.title.textContent=state.pending?'Send to…':'New message';
  setView('pick');els.q.value='';els.q.focus({preventScroll:true});
  loadPick();schedule();
}
async function loadPick(){
  renderPick();
  if(state.friends&&Date.now()-state.friendsAt<300e3)return;
  if(!state.friends){els.pickNote.textContent='Loading friends…';show(els.pickNote,true)}
  try{
    const [f]=await Promise.all([request('/friends'),state.listLoaded?null:loadList({quiet:true})]);
    state.friends=f.friends||[];state.friendsAt=Date.now();renderPick();
  }catch(e){if(!e.unavailable&&!state.friends){els.pickNote.textContent=e.message;show(els.pickNote,true)}}
}
function renderPick(){
  if(state.view!=='pick')return;
  const list=core.pickerPeople(state.conversations,state.friends||[],els.q.value);
  els.pickList.replaceChildren(...list.map(p=>{const {li,b}=personRow(p,{onPick:x=>{state.cameFrom='pick';openThread(x,{fromPick:true})},preview:'@'+p.username});b.setAttribute('aria-label',`${p.name}, @${p.username}`);return li}));
  if(state.friends){const none=!list.length;els.pickNote.textContent=els.q.value.trim()?'No friends match.':'No friends to message yet. When you and someone follow each other on OneProfileID, you can message them here.';show(els.pickNote,none)}
}
function paintPending(){
  const p=state.view==='pick'&&state.pending;
  els.pending.replaceChildren();
  if(p){
    const line=h('div','chat-pending-l');line.append(h('span','','Choose who gets this card'),cancelButton('Cancel sending this card',()=>{state.pending=null;showList()}));
    els.pending.append(line,cardBubble(p.ref,p.url,core.cardLine(p.summary),{result:{access:true,card:p.summary},static:true}));
  }
  els.pending.hidden=!p;
}
function cancelButton(label,run){const b=h('button','chat-ib sm');b.type='button';b.setAttribute('aria-label',label);b.dataset.tip=label;b.innerHTML=icon('x',12);b.addEventListener('click',run);return b}

// ---------- a conversation ----------
const rows=new Map(),seps=new Map();let seenEl=null,tabStop=null;
function forget(){rows.clear();seps.clear();seenEl=null;tabStop=null;els.msgs.replaceChildren()}
function openThread(person,{fromPick=false}={}){
  state.person={...person};state.threadToken++;state.messages=[];state.more=false;forget();
  if(fromPick&&state.pending){state.attach=state.pending;state.pending=null}
  els.title.textContent=person.name;els.headAv.replaceChildren(avatar(person,'chat-av sm'));
  els.input.value='';resize();show(els.threadEmpty,false);els.threadErr.hidden=true;els.sendErr.hidden=true;els.older.hidden=true;setComposer(true);
  setView('thread');paintAttach();
  if(matchMedia('(pointer: fine)').matches||state.attach)els.input.focus({preventScroll:true});else els.title.focus({preventScroll:true});
  loadThread();schedule();
}
const nearBottom=()=>els.scroll.scrollHeight-els.scroll.scrollTop-els.scroll.clientHeight<80;
const toBottom=()=>{els.scroll.scrollTop=els.scroll.scrollHeight};
function setComposer(on){els.input.disabled=!on;els.send.disabled=!on||state.sending}
async function loadThread({quiet=false,older=false}={}){
  const person=state.person;if(!person)return;const token=state.threadToken;
  if(older){els.older.disabled=true;els.older.textContent='Loading earlier messages…'}
  else if(!quiet){els.scroll.classList.add('loading');say(`Loading your conversation with ${person.name}…`)}
  try{
    const d=await request('/thread',{username:person.username,...(older&&state.messages[0]&&core.MESSAGE_ID.test(state.messages[0].id)?{before:state.messages[0].id}:{})});
    if(token!==state.threadToken)return;
    show(els.threadErr,false);setComposer(true);
    if(d.person){Object.assign(person,d.person);els.title.textContent=person.name;els.headAv.replaceChildren(avatar(person,'chat-av sm'))}
    const stick=nearBottom(),fromBottom=els.scroll.scrollHeight-els.scroll.scrollTop;
    if(older){state.messages=core.prependOlder(state.messages,d.messages);state.more=d.more;renderMessages();els.scroll.scrollTop=els.scroll.scrollHeight-fromBottom}
    else if(!quiet){state.messages=d.messages;state.more=d.more;forget();renderMessages();toBottom();say(d.messages.length?`Conversation with ${person.name} loaded.`:`No messages with ${person.name} yet.`)}
    else{const m=core.mergeMessages(state.messages,d);if(m.reset){state.more=d.more;forget()}state.messages=m.messages;renderMessages({animate:true});if(stick)toBottom()}
    markRead();
  }catch(e){
    if(token!==state.threadToken||e.unavailable)return;
    if(e.code==='not_friends')threadClosed('You can only message friends who follow you back.');
    else if(!quiet){els.threadErr.querySelector('p').textContent=e.message;show(els.threadErr,true);say(e.message)}
  }finally{
    if(token===state.threadToken)els.scroll.classList.remove('loading');
    els.older.disabled=false;els.older.textContent='Load earlier messages';
  }
}
function threadClosed(text){
  state.messages=[];forget();els.older.hidden=true;show(els.threadEmpty,false);
  els.threadErr.querySelector('p').textContent=text;els.threadErr.querySelector('button').hidden=true;show(els.threadErr,true);
  setComposer(false);say(text);
}
async function markRead(){
  const last=state.messages.findLast(m=>!m.mine),person=state.person;
  if(!last||last.read||!person)return;
  try{
    await request('/read',{username:person.username,...(core.MESSAGE_ID.test(last.id)?{through:last.id}:{})});
    for(const m of state.messages)if(!m.mine&&Date.parse(m.createdAt)<=Date.parse(last.createdAt))m.read=true;
    const item=state.conversations.find(c=>c.username===person.username);
    if(item){setBadge(Math.max(0,state.unread-item.unread));item.unread=0}else refreshBadge();
  }catch{}
}
function messageRow(m){
  const li=h('li','chat-msg');if(m.mine)li.dataset.mine='true';li.tabIndex=-1;
  li.append(h('span','sr-only',m.mine?'You: ':`${state.person?.name||'Friend'}: `));
  const p=core.parseMessage(m.body,location.origin);
  if(p.text||!p.cards.length)li.append(h('p','chat-b',p.text||m.body||(m.photoCount?'[Photo]':'')));
  if(m.photoCount)li.append(h('span','chat-aside',`${m.photoCount} photo${m.photoCount===1?'':'s'} · open OneProfileID to see ${m.photoCount===1?'it':'them'}`));
  for(const c of p.cards)li.append(cardBubble(c.ref,c.url,c.title));
  const t=h('time','chat-time',core.fullTime(m.createdAt));t.dateTime=m.createdAt;li.append(t);
  return li;
}
function renderMessages({animate=false}={}){
  const ordered=[],now=new Date();
  for(const {message:m,separator,group} of core.timeline(state.messages)){
    if(separator){
      let s=seps.get(m.id);if(!s){s=h('li','chat-sep');s.append(h('time'));s.firstChild.dateTime=m.createdAt;seps.set(m.id,s)}
      const label=core.separatorLabel(m.createdAt,{now});if(s.firstChild.textContent!==label)s.firstChild.textContent=label;
      ordered.push(s);
    }else seps.delete(m.id);
    let r=rows.get(m.id);
    if(!r){r=messageRow(m);rows.set(m.id,r);if(animate&&!reduced())r.dataset.enter='true'}
    r.dataset.group=group;ordered.push(r);
  }
  // Move as little as possible, so a poll never drops focus.
  const keep=new Set(ordered);for(const ch of [...els.msgs.children])if(!keep.has(ch))ch.remove();
  let cur=els.msgs.firstElementChild;for(const r of ordered){if(r===cur)cur=cur.nextElementSibling;else els.msgs.insertBefore(r,cur)}
  const ids=new Set(state.messages.map(m=>m.id));for(const id of [...rows.keys()])if(!ids.has(id))rows.delete(id);
  // One tab stop for the conversation; arrow keys move between messages.
  if(!tabStop?.isConnected)tabStop=null;
  const stop=tabStop||rows.get(state.messages.at(-1)?.id);for(const r of rows.values())r.tabIndex=r===stop?0:-1;tabStop=stop||null;
  // "Seen" under the latest message you sent, once it has been read.
  const last=state.messages.findLast(m=>m.mine),seenId=last?.read?last.id:null;
  if(seenEl&&seenEl.dataset.for!==seenId){seenEl.remove();seenEl=null}
  if(seenId&&!seenEl){seenEl=h('span','chat-seen','Seen');seenEl.dataset.for=seenId;rows.get(seenId)?.append(seenEl)}
  els.older.hidden=!state.more;
  els.threadEmpty.textContent=state.attach?`Add a note if you like, then send the card to ${state.person?.name||'your friend'}.`:`Say hello to ${state.person?.name||'your friend'}.`;
  show(els.threadEmpty,!state.messages.length&&els.threadErr.hidden);
  fillCards(els.msgs);
}

// ---------- composer ----------
function resize(){const i=els.input;i.style.height='auto';i.style.height=Math.min(i.scrollHeight||0,120)+'px'}
function draftBody(){
  const note=els.input.value.trim(),a=state.attach;
  return a?core.cardMessage(note,a.summary,a.url):note;
}
function sendError(text){els.sendErr.textContent=text;show(els.sendErr,!!text);if(text)say(text)}
async function sendNow(){
  const body=draftBody(),person=state.person,token=state.threadToken,draft=els.input.value,had=state.attach;
  if(!body||state.sending||!person)return;
  if(core.bodyLength(body)>core.BODY_MAX){sendError(`Messages can be up to ${core.BODY_MAX.toLocaleString()} characters${had?' including the card link':''}. Shorten it by ${(core.bodyLength(body)-core.BODY_MAX).toLocaleString()}.`);return}
  state.sending=true;els.send.disabled=true;els.composer.dataset.sending='true';els.send.setAttribute('aria-busy','true');sendError('');say(had?'Sending the card…':'Sending message…');
  try{
    const d=await request('/send',{username:person.username,body},{timeout:20000});
    if(token!==state.threadToken)return;
    if(els.input.value===draft)els.input.value='';resize();if(state.attach===had){state.attach=null;paintAttach()}
    state.messages=core.mergeMessages(state.messages,{messages:[d.message],more:false}).messages;renderMessages({animate:true});toBottom();
    const item=state.conversations.find(c=>c.username===person.username);
    if(item){item.lastMessage={body:d.message.body,createdAt:d.message.createdAt,mine:true};state.conversations=[item,...state.conversations.filter(c=>c!==item)]}
    else state.listLoaded&&loadList({quiet:true});
    say(had?'Card sent.':'Message sent.');
  }catch(e){
    if(token!==state.threadToken||e.unavailable)return;
    if(e.code==='not_friends')threadClosed('You can only message friends who follow you back.');
    else if(e.status===429)sendError(`You are sending messages too quickly. Try again in ${e.retryAfter>=120?Math.ceil(e.retryAfter/60)+' minutes':(e.retryAfter||60)+' seconds'}.`);
    else sendError(e.message);
  }finally{state.sending=false;delete els.composer.dataset.sending;els.send.removeAttribute('aria-busy');if(!els.input.disabled)els.send.disabled=false}
}
function paintAttach(){
  const a=state.attach;els.attach.replaceChildren();
  if(a){els.attach.append(cardBubble(a.ref,a.url,core.cardLine(a.summary),{result:{access:true,card:a.summary},static:true}),cancelButton('Remove the card',()=>{state.attach=null;paintAttach();renderMessages();els.input.focus()}))}
  show(els.attach,!!a);
  els.input.placeholder=a?'Add a note (optional)':'Message';
}

// ---------- card bubbles ----------
const lookups=new Map(),TTL=60e3;
// {access, card?, open?} for each ref, with the reader's own access. The open workspace first (it holds
// exactly what this person may see); the server for anything else, cached a minute.
async function resolve(refs){
  const out=new Map(),ask=[];
  for(const r of refs){
    const k=core.refKey(r),id=core.localTarget(store.db,currentEnv(),r);
    if(id){const card=core.summarize(store.db,{kind:r.kind,id},{photo:personPhoto});if(card){out.set(k,{access:true,card,open:{env:currentEnv(),id}});continue}}
    const hit=lookups.get(k);if(hit&&Date.now()-hit.at<TTL){out.set(k,hit.r);continue}
    if(!ask.some(x=>core.refKey(x)===k))ask.push(r);
  }
  for(let i=0;i<ask.length;i+=25){
    const part=ask.slice(i,i+25);
    try{const d=await request('/cards',{links:part});part.forEach((r,j)=>{const v=d.cards?.[j]||{access:false};lookups.set(core.refKey(r),{at:Date.now(),r:v});out.set(core.refKey(r),v)})}
    catch{for(const r of part)out.set(core.refKey(r),null)}
  }
  if(lookups.size>300)for(const [k,v] of lookups)if(Date.now()-v.at>TTL)lookups.delete(k);
  return out;
}
const dueText=d=>{const [y,m,day]=d.split('-').map(Number);return new Date(y,m-1,day).toLocaleDateString([],{month:'short',day:'numeric',...(y!==new Date().getFullYear()?{year:'numeric'}:{})})};
const TYPE_NAME={person:'Person',entity:'Entity',area:'Project area',note:'Note'};
// One card bubble: a link to the card (so modified clicks and assistive tech treat it as one), filled in
// once its details are known. title: what the message says the card is called.
function cardBubble(ref,url,title,{result,static:fixed=false}={}){
  const a=h(fixed?'div':'a','chat-card');a.dataset.ref=core.refKey(ref);a._ref=ref;a._title=title;
  // The canonical link (same origin, path /), never the raw text the message carried.
  if(!fixed){a.href=core.linkFor(location.origin,ref);a.addEventListener('click',e=>{if(e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();openCard(ref,a._result)})}
  paintCard(a,result||null);
  return a;
}
function paintCard(a,r){
  a._result=r;const c=r?.access?r.card:null,ref=a._ref;
  a.replaceChildren();a.classList.toggle('denied',r?.access===false);a.classList.toggle('loading',!r);
  a.style.removeProperty('--pc');
  const body=h('span','cc-b');
  if(c?.kind==='card'){
    if(c.project?.color)a.style.setProperty('--pc',c.project.color);
    if(c.labels.length){const ls=h('span','cc-labels');for(const l of c.labels){const p=h('span','pill',l.name);p.style.background=l.color[0];p.style.color=l.color[1];ls.append(p)}body.append(ls)}
    body.append(h('strong','cc-t',c.title||'Untitled card'));
    const meta=h('span','cc-m');
    if(c.number!=null)meta.append(h('span','cc-num','#'+c.number));
    if(c.column?.name)meta.append(h('span','cc-col'+(c.column.id==='done'?' done':''),c.column.name));
    if(c.due)meta.append(h('span','cc-due',dueText(c.due)));
    if(c.points!=null)meta.append(h('span','cc-pts',`${c.points} pts`));
    body.append(meta);
    a.append(icon2('branch'),body);
    if(c.assignees.length){const ppl=h('span','cc-ppl');for(const p of c.assignees)ppl.append(avatar({...p,username:p.id},'chat-av xs'));if(c.more)ppl.append(h('span','cc-more','+'+c.more));a.append(ppl)}
    a.setAttribute('aria-label',`DevOps card${c.number!=null?' #'+c.number:''}: ${c.title}${c.column?.name?', '+c.column.name:''}. Open in Flow`);
  }else if(c?.kind==='node'){
    a.classList.add('node');
    a.append(c.type==='person'?avatar({name:c.name,image:c.image,username:ref.id},'chat-av'):icon2({entity:'building',area:'area',note:'note'}[c.type]||'building'));
    body.append(h('strong','cc-t',c.name||'Untitled'),h('span','cc-m',`${TYPE_NAME[c.type]||'Card'} · mind map`));a.append(body);
    a.setAttribute('aria-label',`${TYPE_NAME[c.type]||'Card'}: ${c.name}. Open in Flow`);
  }else{
    a.append(icon2(ref.kind==='card'?'branch':'network'));
    body.append(h('strong','cc-t',a._title||(ref.kind==='card'?'Flow card':'Flow mind map card')));
    body.append(h('span','cc-m',r?.access===false?"You don't have access to this card":r===null&&a._failed?"Couldn't load this card":'Loading card…'));
    a.append(body);
    a.setAttribute('aria-label',`${a._title||'Flow card'}. ${r?.access===false?"You don't have access to this card.":'Open in Flow'}`);
  }
}
const icon2=name=>{const s=h('span','cc-k');s.innerHTML=icon(name,14);s.setAttribute('aria-hidden','true');return s};
async function fillCards(root){
  const list=[...root.querySelectorAll('a.chat-card')];if(!list.length)return;
  const got=await resolve(list.map(a=>a._ref));
  for(const a of list){
    if(!a.isConnected)continue;const v=got.get(a.dataset.ref);
    if(v===null){a._failed=true;paintCard(a,null);continue}
    if(JSON.stringify(v)!==JSON.stringify(a._result))paintCard(a,v);
  }
}
async function openCard(ref,r){
  if(r?.access===false){hooks.toast("You don't have access to this card.",true);return}
  if(r?.access&&!r.open){hooks.toast('This card is shared with you. Add its share to one of your environments (Settings › Sharing) to open it.',true);return}
  if(narrow())close({restoreFocus:false});
  await hooks.openLink(ref,r?.open||null);
}

// ---------- sending a card from the board, a mind map or a drag ----------
// kind 'card' (DevOps) or 'node' (mind map), id as the open workspace has it.
export function sendRecord(kind,id){
  if(!state.available){hooks.toast('Chat is not available.',true);return}
  const ref=core.refFor(store.db,currentEnv(),kind,id),summary=core.summarize(store.db,{kind,id},{photo:personPhoto});
  if(!ref||!summary){hooks.toast('This card cannot be sent.',true);return}
  const item={ref,summary,url:core.linkFor(location.origin,ref)};
  if(state.open&&state.view==='thread'&&state.person&&!els.input.disabled){
    state.attach=item;paintAttach();renderMessages();els.input.focus({preventScroll:true});say(`Card attached. Add a note or press Send to send it to ${state.person.name}.`);return;
  }
  state.pending=item;state.attach=null;state.person=null;state.threadToken++;state.view='pick';
  if(state.open)openPick();else open();
  say('Choose who to send the card to.');
}
function setDrop(on){if(!els)return;els.drop.hidden=!on;els.panel.classList.toggle('drop-on',on);els.launcher.classList.toggle('drop-on',on)}

// ---------- polling ----------
function schedule(){
  clearTimeout(state.listTimer);clearTimeout(state.threadTimer);
  if(!state.open||!visible()||!state.available)return;
  if(state.view==='thread'&&state.person)state.threadTimer=setTimeout(async()=>{await loadThread({quiet:true});schedule()},core.THREAD_POLL);
  else if(state.view==='list')state.listTimer=setTimeout(async()=>{await loadList({quiet:true});schedule()},core.LIST_POLL);
}
async function refreshBadge(){
  if(!visible()||!state.available)return;
  try{const d=await request('/status');if(Number.isInteger(d.unread))setBadge(d.unread)}catch{}
}
function badgeLoop(){clearTimeout(state.badgeTimer);if(!state.available)return;state.badgeTimer=setTimeout(async()=>{if(!state.open)await refreshBadge();badgeLoop()},core.BADGE_POLL)}

// ---------- events ----------
function bind(){
  els.launcher.addEventListener('click',()=>state.open?close():open());
  els.root.addEventListener('click',e=>{
    const b=e.target.closest('[data-chat]');if(!b)return;
    ({close:()=>close(),back,new:()=>{state.pending=null;openPick()},retryList:()=>loadList(),retryThread:()=>loadThread(),older:()=>loadThread({older:true})})[b.dataset.chat]?.();
  });
  els.q.addEventListener('input',renderPick);
  els.q.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();els.pickList.querySelector('button')?.click()}else if(e.key==='ArrowDown'){e.preventDefault();els.pickList.querySelector('button')?.focus()}});
  els.composer.addEventListener('submit',e=>{e.preventDefault();sendNow()});
  els.input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendNow()}});
  els.input.addEventListener('input',()=>{resize();if(!els.sendErr.hidden)sendError('')});
  // Keys inside the chat stay inside (the app's shortcuts must not act on the board behind it). Esc closes.
  els.panel.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&!e.isComposing){e.preventDefault();close()}
    else if(e.target.closest('.chat-msg')===e.target&&['ArrowUp','ArrowDown','Home','End'].includes(e.key)){
      const list=state.messages.map(m=>rows.get(m.id)).filter(Boolean),at=list.indexOf(e.target);
      const next=list[{ArrowUp:Math.max(0,at-1),ArrowDown:Math.min(list.length-1,at+1),Home:0,End:list.length-1}[e.key]];
      e.preventDefault();if(next){tabStop.tabIndex=-1;tabStop=next;next.tabIndex=0;next.focus()}
    }
    e.stopPropagation();
  });
  els.launcher.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.open){e.preventDefault();e.stopPropagation();close()}});
  els.msgs.addEventListener('focusin',e=>{const r=e.target.closest('.chat-msg');if(r&&tabStop!==r){if(tabStop)tabStop.tabIndex=-1;tabStop=r;r.tabIndex=0}});
  els.msgs.addEventListener('animationend',e=>{if(e.target.dataset?.enter)delete e.target.dataset.enter});
  document.addEventListener('visibilitychange',()=>{if(visible()){if(state.open){if(state.view==='thread')loadThread({quiet:true});else if(state.view==='list')loadList({quiet:true})}else refreshBadge()}schedule()});
  // Drag a DevOps card onto the chat (or its closed launcher) to send it.
  const accept=kind=>kind==='devops-card'&&state.available;
  addDropTarget(els.panel,{accept,over:setDrop,drop:(_,id)=>{setDrop(false);sendRecord('card',id)}});
  addDropTarget(els.launcher,{accept,over:setDrop,drop:(_,id)=>{setDrop(false);sendRecord('card',id)}});
}

// hooks: openLink(ref, open|null) opens a card (open: where the server says it opens for this person);
// toast(text, warn).
export function startChat(h={}){
  hooks={...hooks,...h};
  if(state.started)return;state.started=true;
  build();
  addEventListener('flow:session',()=>{state.listLoaded=false;state.conversations=[];state.friends=null;check()});
  check();
}
// The app re-rendered (an edit, an environment switch): card bubbles may show changed details.
let refillTimer=0;
export function chatRendered(){
  if(!els||!state.open||state.view!=='thread')return;
  clearTimeout(refillTimer);refillTimer=setTimeout(()=>{if(state.open&&state.view==='thread')fillCards(els.msgs)},400);
}
