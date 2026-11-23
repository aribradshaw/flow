// Boards use the viewer's workspace projection. Linked ids stay intact for store writes.
import {COLUMNS,isSnoozed} from './devops-core.js';
import {parseForeign} from './combined-core.js';
import {agentsForCard,LIMITS} from './agentflow-core.js';

export const ROOM_COLUMNS=['doing','uat','blocked'];
export const COMMON_COLUMNS=['requests','doing'];
export const BOARD_LIMIT=3;

function sourceOf(db,card){
  const foreign=parseForeign(card.id),id=foreign?.id||card.id;
  const share=/^sh\.([^.]+)\.(.+)$/.exec(id);
  const shares=foreign?db.combined?.find(m=>m.env===foreign.env)?.shares:db.shares;
  if(share)return {env:shares?.find(s=>s.id===share[1])?.ownerEnv, id:share[2]};
  return {env:foreign?.env||db.environment?.id,id};
}

export function cardsInOffice(db,env,editable=()=>false){
  const bySource=new Map();
  for(const card of db.devops?.cards||[]){
    const {env:home,id}=sourceOf(db,card);
    if(home!==env)continue;
    const previous=bySource.get(id);
    if(!previous||!editable(previous)&&editable(card))bySource.set(id,card);
  }
  return [...bySource.values()];
}

export function officeMemberRefs(db,member){
  const refs=new Set(member.personIds||[]);
  if(member.me&&db.environment?.ownerEmail){
    const email=db.environment.ownerEmail.toLowerCase();
    for(const chart of db.charts||[])for(const node of chart.nodes||[]){
      if(node.type==='person'&&node.email?.toLowerCase()===email&&!node.id.startsWith('sh.'))refs.add(node.id);
    }
    refs.add('@'+email);
  }
  const contacts=[...(db.shareMembers||[]),...(db.shares||[]).flatMap(s=>s.members||[])];
  for(const contact of contacts)if(contact.officeKey===member.key&&contact.id.startsWith('@'))refs.add(contact.id);
  return [...refs];
}

export function cardsForOfficeBoard(cards,{member,delegated,now=Date.now()}){
  const columns=member?ROOM_COLUMNS:COMMON_COLUMNS;
  const refs=new Set(member?.personIds||[]);
  const result=new Map(columns.map(column=>[column,[]]));
  for(const card of cards){
    const slot=result.get(card.column);
    if(!slot||slot.length>=BOARD_LIMIT||isSnoozed(card,now))continue;
    const show=member?card.assignees.some(a=>refs.has(a.node)):delegated.has(card.id);
    if(show)slot.push(card);
  }
  return result;
}

export function workingCards(cards,agents,{now=Date.now()}={}){
  const doing=new Map(cards.filter(card=>card.column==='doing'&&!isSnoozed(card,now)).map(card=>[card.id,card]));
  return new Map(agents.flatMap(agent=>{
    if(agent.status==='paused'||agent.status==='retired')return [];
    const card=(agent.cards||agent.boardCards||[]).map(id=>doing.get(id)).find(Boolean);
    return card?[[agent.id,card]]:[];
  }));
}

// Pass the same edit permission and allowed people used in the DevOps card editor.
export function planOfficeDrop(db,card,target,{editable,personIds=[],local=false,replace=false}={}){
  if(!card||!target||!editable)return null;
  if(target.type==='column'){
    return target.id!==card.column&&COLUMNS.some(([id])=>id===target.id)?{type:'move',column:target.id}:null;
  }
  if(target.type==='person'){
    const node=target.refs.find(id=>personIds.includes(id));
    return node&&card.assignees.length<20&&!card.assignees.some(a=>target.refs.includes(a.node)&&a.role==='developer')
      ?{type:'assign',node,role:'developer'}:null;
  }
  if(target.type!=='agent'||!local||parseForeign(card.id))return null;
  const agent=db.agentflow?.agents.find(a=>a.id===target.id);
  if(!agent)return null;
  const before=agentsForCard(db.agentflow,card.id).map(a=>a.id);
  const has=before.includes(agent.id);
  if(has&&(!replace||before.length===1))return null;
  if(!has&&agent.cards.length>=LIMITS.refs)return null;
  return {type:'delegate',agents:replace?[agent.id]:[...before,agent.id]};
}
