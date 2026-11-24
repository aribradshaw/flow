// First run: someone signed in to a brand-new, empty workspace picks how to start, once per environment
// (in this browser): "Start with an example" (demoWorkspace() from demo-seed.js, every feature filled
// in with fictional data) or "Start blank". An empty MindMap chart shows a hint on the canvas.
//
//   firstRun({store, replaceDb, envId, signedIn})   call after each render; shows the picker when due
//   canvasHint(chart)                             the hint markup for an empty chart ('' otherwise)
import {demoWorkspace} from './demo-seed.js';

const KEY='flow.firstrun.';
const seen=id=>{try{return !!localStorage.getItem(KEY+id)}catch{return true}};
const mark=id=>{try{localStorage.setItem(KEY+id,'1')}catch{}};
// The workspace the server makes for a new person: one empty chart and nothing else.
export const untouched=db=>!!db&&db.charts?.length===1&&!db.charts[0].nodes?.length&&!(db.timeline||[]).length&&!(db.projects||[]).length&&!(db.devops?.cards||[]).length&&!(db.agentflow?.agents||[]).length;

let open=false,shown=null;
export function firstRun({store,replaceDb,envId,signedIn}){
  // Another environment was opened meanwhile (one shared with you, say): the picker was for the one before.
  if(open&&shown&&shown.env!==store.db?.environment?.id){shown.el.remove();open=false;shown=null}
  // An environment shared with you (docs/sharing.md) is its owner's, empty or not.
  if(open||store.db?.opened||!signedIn||!envId||envId!==store.db?.environment?.id||seen(envId)||!untouched(store.db))return;
  open=true;
  const o=document.createElement('div');
  o.className='first-run';o.setAttribute('role','dialog');o.setAttribute('aria-modal','true');o.setAttribute('aria-labelledby','firstRunT');o.dataset.firstrun='';
  o.innerHTML=`<div class="first-run-card">
    <h2 id="firstRunT">Welcome to Flygon Flow</h2>
    <p>This is your own workspace. Only you can see it until you share something.</p>
    <div class="first-run-choices">
      <button type="button" class="first-run-choice" data-firstrun-choice="example"><strong>Start with an example</strong><span>A made-up company with a mind map, a timeline and a task board, to look around and change.</span></button>
      <button type="button" class="first-run-choice" data-firstrun-choice="blank"><strong>Start blank</strong><span>An empty mind map. Add your first card with Add entity, or press E.</span></button>
    </div></div>`;
  document.body.append(o);shown={env:envId,el:o};
  o.querySelector('[data-firstrun-choice="blank"]').focus();
  o.addEventListener('click',e=>{
    const b=e.target.closest('[data-firstrun-choice]');if(!b)return;
    o.remove();open=false;shown=null;
    // Never into an environment it was not shown for (an example in someone else's shared environment).
    if(store.db?.environment?.id!==envId)return;
    mark(envId);
    if(b.dataset.firstrunChoice==='example'){
      const d=demoWorkspace();
      replaceDb({...d,environment:{...store.db.environment}});
    }
  });
}
export function canvasHint(chart){
  if(!chart||chart.nodes?.length)return '';
  return `<div class="canvas-hint" data-canvas-hint role="note">Your chart is empty. Click <strong>Add entity</strong> on the toolbar or press <kbd>E</kbd> to add your first card.</div>`;
}
