// Modals for detail views and small confirmations, with motion.
//
//   const m=detailModal({cls, label, from, onClose, events:{click,input,change,keydown}})
//     m.body           where the caller renders (re-render it freely while open)
//     m.from(el)       the element it grows from / shrinks back into (e.g. the clicked card)
//     m.close()        animated close (promise); onClose runs after it is gone
//   ask(text,{ok,cancel,danger}) → Promise<boolean>   a small confirm dialog on top of anything
//
// Native <dialog> + showModal: the page behind is inert and focus stays inside. Opening grows from
// the source element's rect (FLIP, transform only) with a backdrop fade; closing shrinks back into
// it. Reduced motion: fade only. A second open or close cancels the animation in flight, so rapid
// toggling never leaves a ghost.
const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE='cubic-bezier(.2,.7,.2,1)';

function grow(d,from,dir){
  const box=d.getBoundingClientRect(),r=from?.isConnected?from.getBoundingClientRect():null;
  if(reduced()||!r||!r.width)return d.animate([{opacity:0},{opacity:1}],{duration:dir>0?120:60,easing:'ease-out',direction:dir>0?'normal':'reverse',fill:'both'});
  const t=`translate(${r.left-box.left}px,${r.top-box.top}px) scale(${r.width/box.width},${r.height/box.height})`;
  return d.animate([{transform:t,opacity:.4,borderRadius:'6px'},{transform:'none',opacity:1}],{duration:dir>0?200:150,easing:dir>0?EASE:'ease-in',direction:dir>0?'normal':'reverse',fill:'both'});
}
const fadeBackdrop=(d,dir)=>{try{return d.animate([{opacity:0},{opacity:1}],{duration:dir>0?200:150,pseudoElement:'::backdrop',direction:dir>0?'normal':'reverse',fill:'both'})}catch{return null}};

export function detailModal({cls='',label='Details',from=null,onClose,events={}}={}){
  const d=document.createElement('dialog');d.className='modal '+cls;d.setAttribute('aria-label',label);d.setAttribute('aria-modal','true');
  d.innerHTML='<div class="modal-body"></div>';
  document.body.append(d);
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
  const m={el:d,body:d.firstChild,from(el){src=el},
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
