// Your T3 threads in the 3D office (docs/concepts/12-office.md "Threads"): a sidebar in the top right, like T3's own
// (Working, Waiting, Woke, Done, then Snoozed and Settled), and a thread chat that slides down from the top when you
// click one: messages, reasoning ("Thinking"), tool steps, a pending approval, and a box to talk to it. Your Chief of
// Staff is pinned first. Only you get any of this: the server sends threads, live steps and history to your own page.
//
//   const th=createThreads({root, meKey(), live() -> Map(member -> agents), post(body) -> POST steer (message, stop,
//     history), toast(msg, bad), highlight(agentId|null), show(agentId), decide(agent, decision), answerOf(agentId)})
//   th.snapshot(list)     the snapshot's threads ([{source, items, counts, can}])
//   th.threads(one)       a threads event: one source's index (gone: true when the source left)
//   th.changed()          your live agents changed (an agents or live event): rows and the open thread follow
//   th.result(action)     a result event; true when it was a history page or a message sent from here
//   th.toggle() / th.isOpen() / th.openThread(id, source) / th.closeThread()
//   th.escape(target)     Esc: closes the thread, then the sidebar -> true when it did something
//   th.key(e)             Y toggles -> true when it took the key
//   th.dispose()
import {icon} from './icons.js';
import {esc} from './ui.js';
import {STATE_LABEL,blocksOf,liveLine,mergeItems,projectHue,relTime,sectionsOf} from './office-threads-core.js';

const OPEN_KEY='flow.office.threads',MESSAGE_MAX=2000,HISTORY_MS=15000,REFRESH_MS=8000;
const STATE_ICON={working:'<i class="of-th-spin" aria-hidden="true"></i>',waiting:icon('alert',12),woke:icon('bell',12),done:icon('check',12),snoozed:icon('clock',12),settled:icon('check',12)};
const time=at=>{const d=new Date(at);return Number.isFinite(d.getTime())?d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}):''};
const chip=p=>p?`<span class="of-th-proj"><i style="background:hsl(${projectHue(p)} 55% 48%)"></i>${esc(p)}</span>`:'';
const keyOf=(source,id)=>source+'\n'+id;

export function createThreads(o){
  if(typeof document!=='undefined'&&!document.querySelector('link[data-office-threads]')){const l=document.createElement('link');l.rel='stylesheet';l.href='/office-threads.css';l.dataset.officeThreads='';document.head.append(l)}
  const sources=new Map(),pages=new Map(),waits=new Map(),early=new Map(),sent=new Map(),seen=new Set(),expanded=new Set();
  const collapsed={snoozed:true,settled:true};
  let open=false,query='',current=null,raf=0,disposed=false,lastPaint='',refreshAt=0,wasWorking=false;
  try{open=localStorage.getItem(OPEN_KEY)==='1'}catch{}

  // ---------- the DOM: a header button, the sidebar and the sheet ----------
  const button=document.createElement('button');
  button.type='button';button.className='ib of-th-toggle';button.setAttribute('aria-label','Threads (Y)');button.dataset.tip='Threads (Y)';
  const top=o.root.querySelector('.of-top');top?.insertBefore(button,top.querySelector('[data-of="controls"]')||null);
  const side=document.createElement('aside');side.className='of-th';side.setAttribute('aria-label','Threads');
  side.innerHTML=`<div class="of-th-head"><b>Threads</b><span class="sp"></span><button type="button" class="ib" data-th-act="close" aria-label="Hide threads (Y)">${icon('x',14)}</button></div>
    <label class="of-th-search">${icon('filter',13)}<input type="search" placeholder="Search threads" aria-label="Search threads" autocomplete="off"></label>
    <div class="of-th-list" role="list"></div>`;
  const sheet=document.createElement('section');sheet.className='of-ts';sheet.setAttribute('aria-label','Thread');sheet.setAttribute('aria-hidden','true');
  sheet.innerHTML=`<header class="of-ts-head"></header><div class="of-ts-body" tabindex="0" aria-live="polite"></div>
    <form class="of-ts-compose"><textarea rows="1" maxlength="${MESSAGE_MAX}" placeholder="Message this thread… (Enter to send, Shift+Enter for a new line)" aria-label="Message" autocomplete="off"></textarea>
      <button type="button" class="txt of-ts-stop" data-th-act="stop" hidden>${icon('ban',13)}Stop</button><button type="submit" class="txt primary" data-th-act="send">${icon('send',13)}Send</button></form>`;
  o.root.append(side,sheet);
  const list=side.querySelector('.of-th-list'),search=side.querySelector('input'),head=sheet.querySelector('.of-ts-head'),body=sheet.querySelector('.of-ts-body');
  const form=sheet.querySelector('form'),input=form.querySelector('textarea');

  // ---------- what we know ----------
  const mine=()=>o.live().get(o.meKey())||[];
  const chief=()=>mine().find(a=>a.role==='conductor')||null;
  const agentOf=(source,id)=>mine().find(a=>a.id===id&&a.source===source)||null;
  const threadOf=(source,id)=>sources.get(source)?.items?.find(t=>t.id===id)||null;
  // A row's state: the live agent wins (it reports every few seconds; the index only when it changes).
  function stateOf(source,id){
    const a=agentOf(source,id),t=threadOf(source,id);
    if(a?.status==='waiting')return 'waiting';
    if(a?.status==='running')return 'working';
    return t?.state||'done';
  }
  const canOf=(source,id)=>{const a=agentOf(source,id),c=new Set(a?.can||[]);for(const k of sources.get(source)?.can||[])if(threadOf(source,id))c.add(k);return c};

  // ---------- the sidebar ----------
  function row(t,{pinned=false}={}){
    const st=pinned?(t.status==='running'?'working':t.status==='waiting'?'waiting':'done'):stateOf(t.source,t.id);
    const a=agentOf(t.source,t.id),live=st==='working'||st==='waiting'?a?.live:null;
    const when=relTime(t.updatedAt||a?.live?.at,Date.now());
    const unread=!pinned&&t.unread&&!seen.has(keyOf(t.source,t.id)+t.updatedAt);
    const sel=current&&current.id===t.id&&current.source===t.source;
    const inOffice=!!a;
    return `<li class="of-th-li${sel?' sel':''}${pinned?' pin':''}" role="listitem"><button type="button" class="of-th-row" data-th-open="${esc(t.id)}" data-th-src="${esc(t.source)}"${inOffice?` data-th-agent="${esc(t.id)}"`:''}>
      <span class="of-th-line">${pinned?`<span class="of-th-proj cos"><i></i>Chief of Staff</span>`:chip(t.project)}<span class="sp"></span>
        <span class="of-th-badge ${st}">${STATE_ICON[st]||''}${esc(STATE_LABEL[st]||st)}${when&&st!=='done'?` ${esc(when)}`:''}</span>${st==='done'&&when?`<span class="of-th-when">${esc(when)}</span>`:''}</span>
      <span class="of-th-title">${unread?'<i class="of-th-unread" aria-label="Unread"></i>':''}${esc(pinned?(t.title&&t.title!=='Chief of Staff'?t.title:'Your Chief of Staff'):t.title)}</span>
      ${live?`<span class="of-th-live">${esc(liveLine(live))}</span>`:t.branch&&!pinned?`<span class="of-th-sub">${icon('branch',11)}${esc(t.branch)}</span>`:''}
    </button>${inOffice?`<button type="button" class="of-th-show" data-th-show="${esc(t.id)}" aria-label="Show in office">${icon('cube3d',12)}<span>Show in office</span></button>`:''}</li>`;
  }
  function paintList(){
    const cos=chief(),hide=new Set(cos?[cos.id]:[]);
    const secs=sectionsOf([...sources.values()],{query,hide});
    let html='';
    if(cos&&(!query||'chief of staff'.includes(query.toLowerCase())))html+=`<ul class="of-th-sec pin">${row({id:cos.id,source:cos.source,title:cos.title,status:cos.status,updatedAt:cos.live?.at||cos.reply?.at},{pinned:true})}</ul>`;
    for(const s of secs){
      const shut=s.collapsible&&collapsed[s.key]&&!query;
      html+=s.collapsible?`<button type="button" class="of-th-fold" data-th-fold="${s.key}" aria-expanded="${!shut}">${esc(s.label)}<span class="sp"></span><span class="of-th-n">${s.count}</span>${icon(shut?'chevR':'chevD',12)}</button>`
        :`<div class="of-th-sh">${esc(s.label)}<span class="of-th-n">${s.items.length}</span></div>`;
      if(!shut)html+=`<ul class="of-th-sec">${s.items.map(t=>row(t)).join('')}${s.collapsible&&s.count>s.items.length?`<li class="of-th-more">${s.count-s.items.length} older in T3 Code</li>`:''}</ul>`;
    }
    if(!html)html=sources.size?`<p class="of-th-empty">${query?'No threads match.':'No threads yet.'}</p>`
      :`<p class="of-th-empty">Your T3 threads show here when your reporter sends them. <button type="button" class="txt" data-of="connect">Connect your agents</button></p>`;
    if(html!==lastPaint){const y=list.scrollTop;list.innerHTML=html;list.scrollTop=y;lastPaint=html}
    const working=secs.find(s=>s.key==='working')?.items.length||0,waiting=secs.find(s=>s.key==='waiting')?.items.length||0;
    button.innerHTML=`${icon('list',15)}${working+waiting?`<span class="of-th-dot ${waiting?'wait':''}">${working+waiting}</span>`:''}`;
    button.setAttribute('aria-pressed',String(open));
  }

  // ---------- the sheet: one thread ----------
  const pageOf=()=>current&&pages.get(keyOf(current.source,current.id));
  function headHtml(){
    const {source,id}=current,t=threadOf(source,id),a=agentOf(source,id),cos=a?.role==='conductor';
    const st=cos?(a.status==='running'?'working':a.status==='waiting'?'waiting':'done'):stateOf(source,id);
    return `${cos?'<span class="of-th-proj cos"><i></i>Chief of Staff</span>':chip(t?.project)}<b class="of-ts-title">${esc(cos?'Chief of Staff':t?.title||a?.title||'Thread')}</b>
      <span class="of-th-badge ${st}">${STATE_ICON[st]||''}${esc(STATE_LABEL[st]||st)}</span><span class="sp"></span>
      ${a?`<button type="button" class="txt" data-th-show="${esc(id)}">${icon('cube3d',13)}Show in office</button>`:''}
      <button type="button" class="ib" data-th-act="closeThread" aria-label="Close (Esc)">${icon('x')}</button>`;
  }
  const text=s=>esc(s).replace(/\n/g,'<br>');
  function workHtml(b,key,{live=false}={}){
    const open=live||expanded.has(key);
    return `<div class="of-ts-work${live?' live':''}"><button type="button" class="of-ts-sum" data-th-expand="${esc(key)}" aria-expanded="${open}">${live?'<i class="of-th-spin" aria-hidden="true"></i>':icon(open?'chevD':'chevR',12)}${esc(b.summary)}</button>
      ${open?`<ol class="of-ts-steps">${b.items.map((x,i)=>x.role==='reasoning'
        ?`<li class="th"><details${live&&i===b.items.length-1?' open':''}><summary>${icon('sparkle',12)}<span>Thinking${x.title&&x.title!=='Thinking'?': '+esc(x.title):''}</span></summary>${x.text?`<div class="of-ts-think">${text(x.text)}</div>`:''}</details></li>`
        :`<li class="tool${x.status==='failed'?' bad':''}">${x.detail?`<details><summary>${icon('terminal',12)}<span>${esc(x.title||'Tool')}</span></summary><pre>${esc(x.detail)}</pre></details>`:`<span class="of-ts-tool">${icon('terminal',12)}<span>${esc(x.title||'Tool')}</span></span>`}</li>`).join('')}</ol>`:''}</div>`;
  }
  function bodyHtml(){
    const {source,id}=current,pg=pageOf(),a=agentOf(source,id);
    let html='';
    if(pg?.more)html+=`<button type="button" class="txt of-ts-older" data-th-act="older"${pg.loading?' disabled':''}>${pg.loading==='older'?'Loading older…':'Load older messages'}</button>`;
    if(!pg||pg.loading==='first')html+='<p class="of-note">Loading the thread…</p>';
    if(pg?.error&&!pg.items?.length)html+=`<p class="of-note bad">${esc(pg.error)}</p>`;
    const blocks=blocksOf(pg?.items||[]);
    blocks.forEach((b,i)=>{
      if(b.type==='user')html+=`<div class="of-ts-msg user"><div class="of-ts-bubble">${text(b.item.text)}</div>${b.item.at?`<span class="of-ts-at">${esc(time(b.item.at))}</span>`:''}</div>`;
      else if(b.type==='assistant')html+=`<div class="of-ts-msg asst"><div class="of-ts-say">${text(b.item.text)}</div></div>`;
      else html+=workHtml(b,(b.items[0]?.id||'w'+i)+'');
    });
    for(const m of sent.get(keyOf(source,id))||[])html+=`<div class="of-ts-msg user ${m.state}"><div class="of-ts-bubble">${text(m.text)}</div><span class="of-ts-at">${m.state==='failed'?esc(m.error||'Not sent'):m.state==='done'?esc(m.result||'Sent'):'Sending…'}</span></div>`;
    // While it works: its live steps since the last page, and what it is thinking or writing right now.
    const live=(a?.status==='running'||a?.status==='waiting')&&a.live;
    if(live){
      const lastAt=Date.parse((pg?.items||[]).at(-1)?.at)||0;
      const steps=(live.steps||[]).filter(s=>!lastAt||!(Date.parse(s.at)<=lastAt));
      const items=steps.map((s,i)=>s.kind==='thinking'?{role:'reasoning',title:s.text,...(i===steps.length-1&&live.phase==='thinking'?{text:live.text}:{})}:s.kind==='tool'?{role:'tool',title:s.text}:null).filter(Boolean);
      if(live.phase==='thinking'&&!items.length)items.push({role:'reasoning',title:'Thinking',text:live.text});
      if(items.length)html+=workHtml({items,summary:live.phase==='thinking'?'Thinking…':live.phase==='tool'?(steps.at(-1)?.text||'Working…'):'Working…'},'live',{live:true});
      if(live.phase==='writing'&&live.text)html+=`<div class="of-ts-msg asst streaming"><div class="of-ts-say">${text(live.text)}<i class="of-ts-caret"></i></div></div>`;
    }else if(a?.status==='running')html+=`<div class="of-ts-work live"><span class="of-ts-sum"><i class="of-th-spin"></i>Working…</span></div>`;
    // A prompt you can answer here.
    if(a?.pending){
      const ans=o.answerOf?.(a.id),can=a.pending.can||[],asked=ans&&ans.requestId===a.pending.requestId&&ans.state!=='failed';
      html+=`<div class="of-ts-ask"><b>${a.pending.kind==='question'?'It asks you':'Approval needed'}</b><p>${esc(a.pending.summary||'')}</p>
        ${can.length&&!asked?`<div class="of-btns">${can.includes('allow')?`<button type="button" class="txt primary" data-th-decide="allow">${icon('check',13)}Allow</button>`:''}${can.includes('deny')?`<button type="button" class="txt" data-th-decide="deny">${icon('ban',13)}Deny</button>`:''}</div>`
          :asked?`<p class="of-note">${ans.decision==='allow'?'Allowing':'Denying'}…</p>`:'<p class="of-note">Answer it in T3 Code.</p>'}</div>`;
    }
    if(!html)html='<p class="of-note">No messages yet. Say something below.</p>';
    return html;
  }
  let bodySig='';
  function paintSheet({toBottom=false}={}){
    if(!current){sheet.classList.remove('open');sheet.setAttribute('aria-hidden','true');return}
    sheet.classList.add('open');sheet.setAttribute('aria-hidden','false');
    const h=headHtml();if(head.innerHTML!==h)head.innerHTML=h;
    const html=bodyHtml();
    if(html!==bodySig){
      const end=body.scrollHeight-body.scrollTop-body.clientHeight<40,fromBottom=body.scrollHeight-body.scrollTop;
      body.innerHTML=html;bodySig=html;
      // At the bottom: stay there as it streams; scrolled up reading: keep your place (older pages grow the top).
      if(toBottom||end)body.scrollTop=body.scrollHeight;else body.scrollTop=body.scrollHeight-fromBottom;
    }
    const {source,id}=current,a=agentOf(source,id),can=canOf(source,id);
    form.querySelector('.of-ts-stop').hidden=!(a?.status==='running'&&a.can?.includes('stop'));
    input.disabled=!can.has('message');
    input.placeholder=can.has('message')?(a?.status==='running'?'Message it… it gets this as its next turn (Enter to send)':'Message this thread… (Enter to send, Shift+Enter for a new line)'):'This thread cannot take messages from Flow';
    form.querySelector('[data-th-act="send"]').disabled=!can.has('message')||!input.value.trim();
  }
  function paint(){
    if(disposed)return;
    o.root.classList.toggle('of-th-open',open);
    side.hidden=!open;
    paintList();paintSheet();
  }
  const schedule=()=>{if(!raf)raf=requestAnimationFrame(()=>{raf=0;paint()})};

  // ---------- history pages ----------
  function history(source,id,before){
    return o.post({kind:'history',source,agentId:id,...before?{before}:{}}).then(action=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{waits.delete(action.id);reject(Error('Your reporter did not answer. Is it running?'))},HISTORY_MS);
      waits.set(action.id,{resolve,reject,timer});
      // The page can arrive on the stream before this request returns.
      const got=early.get(action.id);if(got){early.delete(action.id);take(got)}
    }));
  }
  function take(a){
    const w=waits.get(a.id);
    if(!w){if(a.data||a.result){early.set(a.id,a);setTimeout(()=>early.delete(a.id),HISTORY_MS)}return false}
    waits.delete(a.id);clearTimeout(w.timer);
    if(a.result?.ok&&a.data)w.resolve(a.data);else w.reject(Error(a.result?.message||'Could not read that thread'));
    return true;
  }
  async function loadNewest(source,id){
    const k=keyOf(source,id),pg=pages.get(k)||{items:[],more:false,before:null};
    if(pg.loading)return;
    pg.loading=pg.items.length?'refresh':'first';pages.set(k,pg);schedule();
    try{
      const d=await history(source,id);
      const had=pg.items.length;
      pg.items=mergeItems(pg.items,d.items);if(!had){pg.more=d.more;pg.before=d.before}
      pg.error='';
      // What you sent here is in the thread now.
      const mine=sent.get(k);if(mine)sent.set(k,mine.filter(m=>m.state!=='done'||!d.items.some(x=>x.role==='user'&&x.text===m.text)));
    }catch(e){pg.error=e.message}
    finally{pg.loading=false;schedule()}
  }
  async function loadOlder(){
    if(!current)return;
    const {source,id}=current,pg=pageOf();if(!pg?.more||pg.loading)return;
    pg.loading='older';schedule();
    try{const d=await history(source,id,pg.before);pg.items=mergeItems(d.items,pg.items);pg.more=d.more;pg.before=d.before}
    catch(e){o.toast?.(e.message,true)}
    finally{pg.loading=false;schedule()}
  }

  // ---------- acting ----------
  async function send(){
    if(!current)return;
    const {source,id}=current,t=input.value.trim();if(!t||t.length>MESSAGE_MAX)return;
    const k=keyOf(source,id),m={text:t,state:'pending'};
    sent.set(k,[...(sent.get(k)||[]),m].slice(-5));input.value='';fit();paintSheet({toBottom:true});
    try{const a=await o.post({kind:'message',source,agentId:id,text:t});m.id=a.id;m.state=a.result?(a.result.ok?'done':'failed'):'sent';if(a.result)m.result=a.result.message}
    catch(e){m.state='failed';m.error=e.message;if(!input.value){input.value=t;fit()}o.toast?.(e.message,true)}
    schedule();
  }
  async function stop(){
    if(!current)return;const {source,id}=current;
    try{await o.post({kind:'stop',source,agentId:id});o.toast?.('Stopping it…')}catch(e){o.toast?.(e.message,true)}
  }
  function openThread(id,source){
    current={id,source};wasWorking=stateOf(source,id)==='working';
    const t=threadOf(source,id);if(t?.unread)seen.add(keyOf(source,id)+t.updatedAt);
    bodySig='';body.innerHTML='';paint();paintSheet({toBottom:true});
    const pg=pages.get(keyOf(source,id));
    if(!pg||!pg.items.length||Date.now()-(pg.at||0)>2000){refreshAt=Date.now();loadNewest(source,id).then(()=>{const p=pages.get(keyOf(source,id));if(p)p.at=Date.now();if(current?.id===id)paintSheet({toBottom:true})})}
    requestAnimationFrame(()=>{if(!input.disabled)input.focus({preventScroll:true})});
  }
  function closeThread(){if(!current)return false;current=null;o.highlight?.(null);paint();return true}
  function toggle(force){
    open=force===undefined?!open:!!force;
    try{localStorage.setItem(OPEN_KEY,open?'1':'0')}catch{}
    if(!open)closeThread();
    paint();
  }
  const fit=()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,140)+'px'};

  // ---------- events ----------
  side.addEventListener('click',e=>{
    const show=e.target.closest('[data-th-show]');if(show){e.stopPropagation();o.show?.(show.dataset.thShow);return}
    const row=e.target.closest('[data-th-open]');if(row){const id=row.dataset.thOpen,src=row.dataset.thSrc;if(current?.id===id&&current.source===src)closeThread();else openThread(id,src);return}
    const fold=e.target.closest('[data-th-fold]');if(fold){collapsed[fold.dataset.thFold]=!collapsed[fold.dataset.thFold];paint();return}
    if(e.target.closest('[data-th-act="close"]'))toggle(false);
  });
  side.addEventListener('pointerover',e=>{const r=e.target.closest('[data-th-agent]');o.highlight?.(r?r.dataset.thAgent:null)});
  side.addEventListener('pointerleave',()=>o.highlight?.(current&&agentOf(current.source,current.id)?current.id:null));
  search.addEventListener('input',()=>{query=search.value;paint()});
  sheet.addEventListener('click',e=>{
    const ex=e.target.closest('[data-th-expand]');if(ex){const k=ex.dataset.thExpand;if(k!=='live'){if(expanded.has(k))expanded.delete(k);else expanded.add(k);paintSheet()}return}
    const show=e.target.closest('[data-th-show]');if(show){o.show?.(show.dataset.thShow);return}
    const d=e.target.closest('[data-th-decide]');if(d&&current){const a=agentOf(current.source,current.id);if(a?.pending){o.decide?.(a,d.dataset.thDecide);schedule()}return}
    const act=e.target.closest('[data-th-act]')?.dataset.thAct;
    if(act==='closeThread')closeThread();else if(act==='older')loadOlder();else if(act==='stop')stop();
  });
  body.addEventListener('scroll',()=>{if(body.scrollTop<30&&pageOf()?.more&&!pageOf()?.loading)loadOlder()},{passive:true});
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send()}});
  input.addEventListener('input',()=>{fit();form.querySelector('[data-th-act="send"]').disabled=input.disabled||!input.value.trim()});
  form.addEventListener('submit',e=>{e.preventDefault();send()});
  button.addEventListener('click',e=>{e.stopPropagation();toggle()});
  const tick=setInterval(()=>{if(open)schedule()},30000); // relative times

  paint();
  return {
    snapshot(list){sources.clear();for(const s of list||[])sources.set(s.source,s);schedule()},
    threads(one){if(!one?.source)return;if(one.gone)sources.delete(one.source);else sources.set(one.source,one);schedule()},
    changed(){
      if(current){
        // A turn that just finished (or a new one): the newest page again, so its reply shows in full. While it works,
        // every few seconds as its steps complete.
        const working=stateOf(current.source,current.id)==='working';
        if((wasWorking&&!working)||(working&&Date.now()-refreshAt>REFRESH_MS)){refreshAt=Date.now();loadNewest(current.source,current.id)}
        wasWorking=working;
      }
      schedule();
    },
    result(a){
      if(a?.kind==='history')return take(a);
      if(a?.kind==='message')for(const l of sent.values())for(const m of l)if(m.id===a.id){m.state=a.result?.ok?'done':'failed';m.result=a.result?.message;m.error=a.result?.message;schedule();return true}
      return false;
    },
    toggle,isOpen:()=>open,openThread,closeThread,
    escape(target){
      if(current&&(sheet.contains(target)||!target?.closest?.('input,textarea'))){closeThread();o.root.focus({preventScroll:true});return true}
      if(side.contains(target)&&target!==document.body){if(query&&target===search){search.value='';query='';paint();return true}toggle(false);o.root.focus({preventScroll:true});return true}
      return false;
    },
    key(e){if(e.key.toLowerCase()!=='y'||e.repeat)return false;e.preventDefault();toggle();return true},
    debug:()=>({open,current,sources:[...sources.keys()],pages:[...pages.entries()].map(([k,p])=>[k,p.items.length,p.more])}),
    dispose(){disposed=true;clearInterval(tick);cancelAnimationFrame(raf);for(const w of waits.values())clearTimeout(w.timer);button.remove();side.remove();sheet.remove();o.root.classList.remove('of-th-open')},
  };
}
