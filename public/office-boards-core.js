// Boards use the viewer's workspace projection. Linked ids stay intact for store writes.
import {isSnoozed} from './devops-core.js';
import {parseForeign} from './combined-core.js';

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

export function cardsInOffice(db,env){
  const seen=new Set();
  return (db.devops?.cards||[]).flatMap(card=>{
    const source=sourceOf(db,card);
    if(source.env!==env||seen.has(source.id))return [];
    seen.add(source.id);
    return [{card,sourceId:source.id}];
  });
}

export function officeMemberRefs(db,member){
  const refs=new Set(member.personIds||[]);
  if(member.me&&db.environment?.ownerEmail)refs.add('@'+db.environment.ownerEmail);
  const contacts=[...(db.shareMembers||[]),...(db.shares||[]).flatMap(s=>s.members||[])];
  for(const contact of contacts)if(contact.officeKey===member.key&&contact.id.startsWith('@'))refs.add(contact.id);
  return [...refs];
}

export function cardsForOfficeBoard(cards,{member,delegated,now=Date.now()}){
  const columns=member?ROOM_COLUMNS:COMMON_COLUMNS;
  const refs=new Set(member?.personIds||[]);
  const result=new Map(columns.map(column=>[column,[]]));
  for(const {card,sourceId} of cards){
    const slot=result.get(card.column);
    if(!slot||slot.length>=BOARD_LIMIT||isSnoozed(card,now))continue;
    const show=member?card.assignees.some(a=>refs.has(a.node)):delegated.has(sourceId);
    if(show)slot.push(card);
  }
  return result;
}

export function workingCards(cards,agents,{now=Date.now()}={}){
  const doing=new Map(cards.filter(({card})=>card.column==='doing'&&!isSnoozed(card,now)).map(({card,sourceId})=>[sourceId,card]));
  return new Map(agents.flatMap(agent=>{
    if(agent.status==='paused'||agent.status==='retired')return [];
    const card=(agent.cards||[]).map(id=>doing.get(id)).find(Boolean);
    return card?[[agent.id,card]]:[];
  }));
}
