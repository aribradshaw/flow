// Plain words for Settings › Sharing (no DOM, no store: test/share-words.test.mjs).
//
//   additionSentence(preview)   one sentence for everything a proposal adds, every record counted:
//                               "Added a mind map card “Crosslist” and a connection A → B."
//                               Past three records it counts by kind: "Added 5 DevOps cards and a project."
//   recordWords(r)              {kind, title, detail} for one preview row ("Mind map card", "Crosslist", "Entity").
//   addsHelp(adds, permission)  what "They can add" means for a share, in one line.
//   summaryWords(summary)       "73 mind map cards · 25 projects · 451 DevOps cards".

const KINDS={node:['mind map card','mind map cards'],edge:['connection','connections'],project:['project','projects'],item:['timeline item','timeline items'],card:['DevOps card','DevOps cards']};
const ORDER=['node','edge','project','item','card'];
const kindOf=k=>KINDS[k]||[String(k||'record'),String(k||'record')+'s'];
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
export const plural=(n,one,many=one+'s')=>`${n} ${n===1?one:many}`;
// "a, b and c"
export const joinAnd=list=>list.length<2?list.join(''):list.slice(0,-1).join(', ')+' and '+list[list.length-1];
const article=w=>/^[aeiou]/i.test(w)&&!/^(one|uni|use)/i.test(w)?'an':'a';

// The mind map's own names for card types (app.js KINDS) and plain words for a connection.
const NODE_TYPES={entity:'Entity',person:'Person',area:'Project area',note:'Note'};
function detailWords(r){
  const d=String(r?.detail||'');if(!d)return '';
  if(r.kind==='node')return NODE_TYPES[d]||d;
  if(r.kind==='edge'){const m=/^(\d+(?:\.\d+)?)% ownership$/.exec(d);return m?`owns ${m[1]}%`:d==='ownership'?'owns':d==='groups'?'groups':d}
  return d;
}
export function recordWords(r){return {kind:cap(kindOf(r?.kind)[0]),title:String(r?.title||'Untitled'),detail:detailWords(r)}}

export function additionSentence(preview){
  const rows=Array.isArray(preview)?preview:[];
  if(!rows.length)return 'Nothing left to add.';
  const named=r=>{const [one]=kindOf(r.kind),t=String(r.title||'Untitled');return `${article(one)} ${one} ${r.kind==='edge'?t:`“${t}”`}`};
  if(rows.length<=3)return `Added ${joinAnd(rows.map(named))}.`;
  const by=new Map();for(const r of rows)by.set(r.kind,(by.get(r.kind)||0)+1);
  const kinds=[...by.keys()].sort((a,b)=>(ORDER.indexOf(a)+1||99)-(ORDER.indexOf(b)+1||99));
  return `Added ${joinAnd(kinds.map(k=>{const n=by.get(k),[one,many]=kindOf(k);return n===1?`${article(one)} ${one}`:`${n} ${many}`}))}.`;
}

export const ADDS_HELP={
  off:'They can change what you shared but not add to it.',
  approve:'Cards and items they add wait at the top of this tab until you approve them.',
  direct:'Cards and items they add go straight into this environment.',
};
export const addsHelp=(adds,permission='edit')=>permission!=='edit'?'Only people who can edit can add things.':ADDS_HELP[adds]||ADDS_HELP.off;

export function summaryWords(u){
  if(!u)return '';
  return [plural(u.nodes||0,'mind map card'),plural(u.projects||0,'project'),plural(u.cards||0,'DevOps card'),...(u.stubs?[`names of ${plural(u.stubs,'co-owner')}`]:[])].join(' · ');
}
