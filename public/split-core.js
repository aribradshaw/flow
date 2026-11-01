// Split view rules: two tabs side by side. Pure state (no DOM), shared by app.js and the tests.
// A layout is {tabs:[left,right]|null, focus:0|1}: tabs null is the single view; focus is the pane
// that keys, Escape and the side panel follow.
export const TABS=['chart','timeline','devops','agentflow'];
export const MIN_PANE=360,NARROW=900,DIVIDER=6;
const isTab=t=>TABS.includes(t);

// '#devops|agentflow' is a split (left|right); '#timeline', '#devops/card/4' and '' are single views.
export function parseHash(hash=''){
  const parts=String(hash).replace(/^#/,'').split('|'),head=p=>p.split('/')[0];
  if(parts.length===2){const [a,b]=parts.map(head);if(isTab(a)&&isTab(b)&&a!==b)return {tab:a,tabs:[a,b]}}
  const t=head(parts[0]);return {tab:isTab(t)?t:'chart',tabs:null};
}
// The hash for a layout: '' is the MindMap on its own (the app's bare URL).
export const hashFor=(tab,tabs)=>tabs?`#${tabs[0]}|${tabs[1]}`:tab==='chart'?'':'#'+tab;

// The left pane's share of the width, kept so each pane is at least MIN_PANE wide.
export function clampRatio(r,width,min=MIN_PANE){
  if(!Number.isFinite(r))r=.5;
  const avail=width-DIVIDER;if(!(avail>0))return Math.min(.8,Math.max(.2,r));
  const lo=Math.min(.5,min/avail);return Math.min(1-lo,Math.max(lo,r));
}

// The notch on a tab that is not showing: the current tab stays on the left, the new one opens on the right (focused).
export const openSplit=(tab,t)=>tab===t||!isTab(t)?null:{tabs:[tab,t],focus:1};
// The × on a pane's tab: the other pane fills the view.
export const closePane=(l,t)=>{const i=l.tabs?.indexOf(t);return i>=0?{tabs:null,focus:0,tab:l.tabs[1-i],closed:t}:null};
// A plain tab click. One of the two panes: focus it. Any other tab replaces the focused pane.
export function clickTab(l,t){
  if(!l.tabs)return {tabs:null,focus:0,tab:t};
  const i=l.tabs.indexOf(t);if(i>=0)return {tabs:l.tabs,focus:i,tab:t};
  const tabs=[...l.tabs];tabs[l.focus]=t;return {tabs,focus:l.focus,tab:t,replaced:l.tabs[l.focus]};
}
// A cross-link (Open DevOps cards, a card's agent…) from the focused pane: the target opens in the
// other pane so the source stays in view, and takes focus.
export function revealTab(l,t){
  if(!l.tabs)return {tabs:null,focus:0,tab:t};
  const i=l.tabs.indexOf(t);if(i>=0)return {tabs:l.tabs,focus:i,tab:t};
  const o=1-l.focus,tabs=[...l.tabs];tabs[o]=t;return {tabs,focus:o,tab:t,replaced:l.tabs[o]};
}
// Stored state (localStorage): {tabs:[a,b]|null, ratio}. Anything else falls back to the single view at 50/50.
export function cleanSplit(x){
  const tabs=Array.isArray(x?.tabs)&&x.tabs.length===2&&x.tabs.every(isTab)&&x.tabs[0]!==x.tabs[1]?[...x.tabs]:null;
  const ratio=Number.isFinite(x?.ratio)?Math.min(.9,Math.max(.1,x.ratio)):.5;
  return {tabs,ratio};
}
