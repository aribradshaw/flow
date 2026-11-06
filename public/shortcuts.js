// Keyboard shortcuts: one registry for every key handler, tooltip and the Settings › Shortcuts tab.
// Combos are written "Mod+Shift+Z" (Mod = Ctrl on Windows/Linux, ⌘ on Mac). A shortcut can have
// several combos (keys); users can rebind editable ones (stored in prefs.shortcuts by id).
import {getPref,setPref} from './prefs.js';

export const SCOPES=[['global','Global'],['chart','MindMap'],['timeline','Timeline'],['devops','DevOps'],['agentflow','AgentFlow']];
export const SHORTCUTS=[
  {id:'global.save',scope:'global',keys:['Mod+S'],desc:'Save a snapshot to this computer and the cloud'},
  {id:'global.undo',scope:'global',keys:['Mod+Z'],desc:'Undo'},
  {id:'global.redo',scope:'global',keys:['Mod+Shift+Z','Mod+Y'],desc:'Redo'},
  {id:'global.escape',scope:'global',keys:['Escape'],desc:'Close, deselect or cancel',fixed:true},
  {id:'chart.addEntity',scope:'chart',keys:['E'],desc:'Add an entity'},
  {id:'chart.addPerson',scope:'chart',keys:['P'],desc:'Add a person'},
  {id:'chart.addArea',scope:'chart',keys:['A'],desc:'Add a project area'},
  {id:'chart.addNote',scope:'chart',keys:['N'],desc:'Add a note'},
  {id:'chart.connect',scope:'chart',keys:['C'],desc:'Connect two cards'},
  {id:'chart.fit',scope:'chart',keys:['F'],desc:'Fit the mind map to the window'},
  {id:'chart.zoomIn',scope:'chart',keys:['+','='],desc:'Zoom in'},
  {id:'chart.zoomOut',scope:'chart',keys:['-'],desc:'Zoom out'},
  {id:'chart.duplicate',scope:'chart',keys:['Mod+D'],desc:'Duplicate the selected card'},
  {id:'chart.delete',scope:'chart',keys:['Delete','Backspace'],desc:'Delete the selection'},
  {id:'chart.nudge',scope:'chart',keys:['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'],desc:'Nudge the selected card (Alt: 1px)',fixed:true},
  {id:'timeline.add',scope:'timeline',keys:['N'],desc:'New item'},
  {id:'timeline.today',scope:'timeline',keys:['T'],desc:'Jump to today'},
  {id:'timeline.view1',scope:'timeline',keys:['1'],desc:'Timeline view'},
  {id:'timeline.view2',scope:'timeline',keys:['2'],desc:'Calendar view'},
  {id:'timeline.view3',scope:'timeline',keys:['3'],desc:'List view'},
  {id:'timeline.view4',scope:'timeline',keys:['4'],desc:'Board view'},
  {id:'timeline.duplicate',scope:'timeline',keys:['Mod+D'],desc:'Duplicate the selected item'},
  {id:'timeline.delete',scope:'timeline',keys:['Delete','Backspace'],desc:'Delete the selected item'},
  {id:'devops.add',scope:'devops',keys:['N'],desc:'New card in Requests / Sprinted'},
  {id:'devops.search',scope:'devops',keys:['/'],desc:'Search cards'},
  {id:'devops.delete',scope:'devops',keys:['Delete','Backspace'],desc:'Delete the open card'},
  {id:'devops.prevCard',scope:'devops',keys:['ArrowLeft','K'],desc:'Previous card in the column (card open)'},
  {id:'devops.nextCard',scope:'devops',keys:['ArrowRight','J'],desc:'Next card in the column (card open)'},
  {id:'agentflow.addAgent',scope:'agentflow',keys:['N'],desc:'New agent (under the selected one)'},
  {id:'agentflow.addWorkflow',scope:'agentflow',keys:['W'],desc:'New workflow'},
  {id:'agentflow.search',scope:'agentflow',keys:['/'],desc:'Search agents and workflows'},
  {id:'agentflow.view1',scope:'agentflow',keys:['1'],desc:'Org chart view'},
  {id:'agentflow.view2',scope:'agentflow',keys:['2'],desc:'Workflows view'},
  {id:'agentflow.fit',scope:'agentflow',keys:['F'],desc:'Fit the org to the window'},
  {id:'agentflow.zoomIn',scope:'agentflow',keys:['+','='],desc:'Zoom in'},
  {id:'agentflow.zoomOut',scope:'agentflow',keys:['-'],desc:'Zoom out'},
  {id:'agentflow.nudge',scope:'agentflow',keys:['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'],desc:'Nudge the selected agent (Alt: 1px)',fixed:true},
  {id:'agentflow.delete',scope:'agentflow',keys:['Delete','Backspace'],desc:'Delete the selected agent or workflow'},
  {id:'agentflow.nextAgent',scope:'agentflow',keys:['Alt+J'],desc:'Next agent or workflow (side panel open; works inside fields)'},
  {id:'agentflow.prevAgent',scope:'agentflow',keys:['Alt+K'],desc:'Previous agent or workflow (side panel open; works inside fields)'},
  {id:'devops.drag',scope:'devops',keys:['Space'],desc:'Pick up a focused card; arrows move it, Space drops',fixed:true},
];
const byId=new Map(SHORTCUTS.map(s=>[s.id,s]));
// Combos the browser or OS needs; they can never be assigned.
export const RESERVED=['Mod+W','Mod+T','Mod+N','Mod+Tab','Mod+Shift+Tab','Mod+Shift+T','Mod+Shift+N','Mod+Shift+W','Mod+R','Mod+Shift+R','Mod+Q','Mod+L','Mod+P','Mod+F','Mod+Shift+I','Mod+Shift+J','Mod+H','Mod+J','Alt+F4','Alt+Tab','F1','F3','F5','F6','F7','F11','F12','Tab','Shift+Tab','Enter','Mod+C','Mod+V','Mod+X','Mod+A'];
export const isMac=/Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent);

// The combo for a keyboard event, or '' for a lone modifier.
const NAMES={' ':'Space',Esc:'Escape',Del:'Delete'};
export function comboOf(e){
  if(['Control','Shift','Alt','Meta'].includes(e.key))return '';
  let k=NAMES[e.key]||e.key;
  // Letters by physical letter, so Shift/Alt variants stay readable; other printable keys as typed.
  if(/^Key[A-Z]$/.test(e.code||''))k=e.code.slice(3);else if(k.length===1)k=k.toUpperCase();
  const printable=k.length===1&&!/[A-Z0-9]/.test(k);
  return [(e.ctrlKey||e.metaKey)&&'Mod',e.altKey&&'Alt',e.shiftKey&&!printable&&'Shift',k].filter(Boolean).join('+');
}
export const keysFor=id=>{const s=byId.get(id);if(!s)return [];const o=!s.fixed&&getPref('shortcuts')?.[id];return Array.isArray(o)&&o.length?o:s.keys};
export const matches=(e,id)=>{const c=comboOf(e);return !!c&&keysFor(id).includes(c)};
const SHOW={Mod:isMac?'⌘':'Ctrl',Shift:isMac?'⇧':'Shift',Alt:isMac?'⌥':'Alt',Escape:'Esc',Delete:'Del',Backspace:'⌫',ArrowUp:'↑',ArrowDown:'↓',ArrowLeft:'←',ArrowRight:'→','-':'−'};
export const showCombo=c=>c.split('+').filter(Boolean).map(p=>SHOW[p]||p).join(isMac?'':' ')||(c==='+'?'+':'');
// The first combo, formatted for tooltips (data-key).
export const keyLabel=id=>{const k=keysFor(id)[0];return k?(k==='+'?'+':showCombo(k)):''};

// Rebinding. Returns {ok} or {error} or {conflict:{id,desc}} (call again with swap:true to swap).
export function rebind(id,combo,{swap=false}={}){
  const s=byId.get(id);if(!s||s.fixed)return {error:'This shortcut cannot be changed.'};
  if(!combo)return {error:'Press a key.'};
  if(RESERVED.includes(combo))return {error:`${showCombo(combo)} is reserved by the browser.`};
  const clash=SHORTCUTS.find(x=>x.id!==id&&(x.scope===s.scope||x.scope==='global'||s.scope==='global')&&keysFor(x.id).includes(combo));
  if(clash&&!swap)return {conflict:{id:clash.id,desc:clash.desc,fixed:!!clash.fixed}};
  if(clash&&clash.fixed)return {error:`${showCombo(combo)} is used by "${clash.desc}", which cannot change.`};
  const over={...(getPref('shortcuts')||{})},mine=keysFor(id);
  if(clash){const theirs=keysFor(clash.id).map(k=>k===combo?mine[0]:k);over[clash.id]=[...new Set(theirs)]}
  over[id]=[combo,...mine.slice(1).filter(k=>k!==combo)];
  setPref('shortcuts',over);return {ok:true};
}
export function resetShortcut(id){const over={...(getPref('shortcuts')||{})};delete over[id];setPref('shortcuts',over)}
export const resetAll=()=>setPref('shortcuts',{});
export const isCustom=id=>Array.isArray(getPref('shortcuts')?.[id]);
