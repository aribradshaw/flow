// Modals for detail views and small confirmations, with motion.
//
//   const m=detailModal({cls, label, from, onClose, events:{click,input,change,keydown}})
//     m.body           where the caller renders (re-render it freely while open)
//     m.from(el)       the element it grows from / shrinks back into (e.g. the clicked card)
//     m.close()        animated close (promise); onClose runs after it is gone
//   ask(text,{ok,cancel,danger}) → Promise<boolean>   a small confirm dialog on top of anything
//   askTime(text,{value,ok,future}) → Promise<Date|null>   the same, with a date and time field (local time);
//     value: a Date to start from; future: refuse a time that has already passed
//
// Native <dialog> + showModal: the page behind is inert and focus stays inside. Opening grows toward
// the source element (uniform scale, transform only) with a backdrop fade; closing shrinks back into
// it. Reduced motion: fade only. A second open or close cancels the animation in flight, so rapid
// toggling never leaves a ghost.
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE='cubic-bezier(.2,.7,.2,1)';

// Grows from the source with one uniform scale (never stretched): it starts slightly smaller and
// nudged toward the source's centre, then settles; closing runs the same path back, a bit faster.
const SETTLE='cubic-bezier(.16,1,.3,1)';
function grow(d,from,dir){
  const box=d.getBoundingClientRect(),r=from?.isConnected?from.getBoundingClientRect():null;
  const opts={duration:dir>0?240:160,easing:dir>0?SETTLE:'cubic-bezier(.4,0,1,1)',fill:'both'};
  if(reduced()||!r||!r.width||!box.width)return d.animate([{opacity:0},{opacity:1}],{...opts,duration:dir>0?120:80,easing:'ease-out',direction:dir>0?'normal':'reverse'});
  const dx=(r.left+r.width/2-(box.left+box.width/2))*.25,dy=(r.top+r.height/2-(box.top+box.height/2))*.25;
  const t=`translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px) scale(.94)`;
  const k=[{transform:t,opacity:0},{transform:'none',opacity:1}];
  return d.animate(dir>0?k:k.reverse(),opts);
}
const fadeBackdrop=(d,dir)=>{try{return d.animate([{opacity:0},{opacity:1}],{duration:dir>0?240:160,pseudoElement:'::backdrop',direction:dir>0?'normal':'reverse',fill:'both'})}catch{return null}};

let detailIdSequence=0;
export function detailModal({cls='',label='Details',from=null,host=document.body,scopeIds=false,onClose,events={}}={}){
  const d=document.createElement('dialog');d.className='modal '+cls;d.setAttribute('aria-label',label);d.setAttribute('aria-modal','true');
  d.innerHTML='<div class="modal-body"></div>';
  host.append(d);
  for(const [type,fn] of Object.entries(events))d.addEventListener(type,fn);
  d.addEventListener('submit',e=>e.preventDefault());
  // Keys inside stay inside (the app's shortcuts must not act behind the modal).
  d.addEventListener('keydown',e=>e.stopPropagation());
  let src=from,anims=[],closing=null;
  const stop=()=>{for(const a of anims)a.cancel();anims=[]};
  d.addEventListener('cancel',e=>{e.preventDefault();m.close()});
  // The browser may force-close a dialog on a repeated Esc: tidy up straight away then.
  let done=false;const finish=()=>{if(done)return;done=true;stop();if(d.open)d.close();d.remove();onClose?.()};
  d.addEventListener('close',()=>{if(!done){if(!closing)closing=Promise.resolve();finish()}});
  d.addEventListener('mousedown',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)m.close()}});
  const prefix=scopeIds?'detail-'+(++detailIdSequence)+'-':'';
  const m={el:d,body:d.firstChild,prefix,query(selector){return m.body.querySelector(detailSelector(selector,prefix))},from(el){src=el},
    open(){d.showModal();stop();anims=[grow(d,src,1),fadeBackdrop(d,1)].filter(Boolean);anims[0]?.finished.then(()=>{anims[0]?.cancel()},()=>{})},
    close(){
      if(closing)return closing;
      // Closing: stop accepting input at once so keys meant for the page do not land in the dialog.
      d.inert=true;if(d.contains(document.activeElement))document.activeElement.blur();
      // Its fields' ids may already belong to a newer modal opening in its place.
      for(const x of d.querySelectorAll('[id]'))x.removeAttribute('id');
      stop();const a=grow(d,src,-1),b=fadeBackdrop(d,-1);anims=[a,b].filter(Boolean);
      // Finish when the animation ends, or at the latest shortly after (never leave a ghost).
      closing=Promise.race([a.finished.catch(()=>{}),new Promise(r=>setTimeout(r,260))]).then(finish);
      return closing;
    },
    get closing(){return !!closing}};
  m.open();
  return m;
}

export const detailFieldId=el=>el.dataset.detailField||el.id;
const detailSelector=(selector,prefix)=>prefix&&selector.startsWith('#')?'#'+prefix+selector.slice(1):selector;

// Keep a focused field and its caret when a detail body is refreshed.
export function paintDetail(m,html,first){
  const a=document.activeElement,keep=m.body.contains(a)&&a.id?{id:a.id,s:a.selectionStart,e:a.selectionEnd}:null;
  m.body.innerHTML=html;
  if(m.prefix){
    const ids=new Set();
    for(const el of m.body.querySelectorAll('[id]')){
      ids.add(el.id);el.dataset.detailField=el.id;el.id=m.prefix+el.id;
    }
    const refs=['for','list','aria-controls','aria-labelledby','aria-describedby'];
    for(const el of m.body.querySelectorAll(refs.map(attr=>'['+attr+']').join(','))){
      for(const attr of refs){
        const value=el.getAttribute(attr);
        if(value)el.setAttribute(attr,value.split(/\s+/).map(id=>ids.has(id)?m.prefix+id:id).join(' '));
      }
    }
  }
  const f=keep&&m.body.querySelector('#'+CSS.escape(keep.id));
  if(f){f.focus({preventScroll:true});try{if(keep.s!=null)f.setSelectionRange(keep.s,keep.e)}catch{}}
  else if(!m.el.contains(document.activeElement)||document.activeElement===m.el)m.query(first)?.focus({preventScroll:true});
}

// A small confirm on top of everything (gates). Enter confirms, Esc cancels.
export function ask(text,{ok='OK',cancel='Cancel',danger=false}={}){
  return new Promise(resolve=>{
    const d=document.createElement('dialog');d.className='modal ask-dlg';d.setAttribute('role','alertdialog');d.setAttribute('aria-modal','true');
    const [head,...rest]=String(text).split('\n');
    d.innerHTML=`<p class="ask-t"></p><p class="ask-m"></p><div class="ask-b"><button type="button" class="txt" data-ask="cancel"></button><button type="button" class="txt ${danger?'danger':'primary'}" data-ask="ok"></button></div>`;
    d.querySelector('.ask-t').textContent=head;d.querySelector('.ask-m').textContent=rest.join('\n');
    d.querySelector('[data-ask=ok]').textContent=ok;d.querySelector('[data-ask=cancel]').textContent=cancel;
    document.body.append(d);d.showModal();
    const inA=reduced()?d.animate([{opacity:0},{opacity:1}],{duration:120}):d.animate([{opacity:0,transform:'scale(.96)'},{opacity:1,transform:'none'}],{duration:140,easing:EASE});
    fadeBackdrop(d,1);
    d.querySelector('[data-ask=ok]').focus();
    let done=false;
    const finish=v=>{if(done)return;done=true;inA.cancel();fadeBackdrop(d,-1);
      d.animate([{opacity:1,transform:'none'},{opacity:0,transform:reduced()?'none':'scale(.97)'}],{duration:100,fill:'forwards'}).finished.catch(()=>{}).then(()=>{d.close();d.remove()});resolve(v)};
    d.addEventListener('click',e=>{const b=e.target.closest('[data-ask]');if(b)finish(b.dataset.ask==='ok')});
    d.addEventListener('cancel',e=>{e.preventDefault();finish(false)});
    d.addEventListener('keydown',e=>e.stopPropagation());
  });
}

// A date and time, in local time (a datetime-local field). Resolves null when cancelled.
export function askTime(text,{value=new Date(),ok='OK',cancel='Cancel',future=false}={}){
  const pad=n=>String(n).padStart(2,'0'),local=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return new Promise(resolve=>{
    const d=document.createElement('dialog');d.className='modal ask-dlg ask-time';d.setAttribute('aria-modal','true');
    const [head,...rest]=String(text).split('\n');
    d.innerHTML=`<form method="dialog"><p class="ask-t" id="ask-time-t"></p><p class="ask-m"></p><input type="datetime-local" class="ask-in" required aria-labelledby="ask-time-t"><p class="ask-err" role="alert"></p>
      <div class="ask-b"><button type="button" class="txt" data-ask="cancel"></button><button type="submit" class="txt primary" data-ask="ok"></button></div></form>`;
    d.querySelector('.ask-t').textContent=head;d.querySelector('.ask-m').textContent=rest.join('\n');
    d.querySelector('[data-ask=ok]').textContent=ok;d.querySelector('[data-ask=cancel]').textContent=cancel;
    const input=d.querySelector('.ask-in'),err=d.querySelector('.ask-err');input.value=local(value);
    if(future)input.min=local(new Date());
    document.body.append(d);d.showModal();fadeBackdrop(d,1);input.focus();
    let done=false;
    const finish=v=>{if(done)return;done=true;fadeBackdrop(d,-1);
      d.animate([{opacity:1},{opacity:0}],{duration:100,fill:'forwards'}).finished.catch(()=>{}).then(()=>{d.close();d.remove()});resolve(v)};
    d.querySelector('form').addEventListener('submit',e=>{e.preventDefault();
      const t=input.value?new Date(input.value):null;
      if(!t||Number.isNaN(+t)){err.textContent='Pick a date and a time.';return}
      if(future&&+t<=Date.now()){err.textContent='Pick a time that has not passed yet.';return}
      finish(t)});
    d.querySelector('[data-ask=cancel]').addEventListener('click',()=>finish(null));
    d.addEventListener('cancel',e=>{e.preventDefault();finish(null)});
    d.addEventListener('keydown',e=>e.stopPropagation());
  });
}
