// Team tables for the 3D office (docs/concepts/12-office.md "Yacht"): the AgentFlow org seated densely at a few
// tables in a fixed space, instead of spread out like the org chart. Plain math, no Three.js, so node can
// test it; a world that seats its org (the yacht) lays the tables out with this and draws them.
//
//   orgTeams(list, {loose, maxSeats})  -> [{name, node, head, members}]
//       One table per team. A team is someone with reports: they sit at the head, and their reports who have
//       no reports of their own sit along the sides. Reports who lead a team have their own table. A team node
//       (kind 'team') is a table itself, not a seat: its reports sit at it, and when its only report leads
//       people, that lead is the head and their reports fill the table under the team's name. A lead whose
//       reports all lead teams of their own has nobody to sit with: they take the head of their first report's
//       table, with that report at their side. People who report to nobody and lead nobody share a table named
//       `loose`. The top of the org comes first.
//   seatTables(teams, zone)            -> {pos: Map(id -> seat), tables, rows, rev, radius, unseated}
//       Tables stand across the beam in two columns, port and starboard of a centre aisle, in rows from the
//       front of the zone back; small teams share a column. zone: {aisle (half the centre aisle), reach (the
//       outboard end of a column), front (z of the first row), back (z the last row may not pass), forward
//       (-1: rows run towards +z)}. seat: {x, z, yaw (facing the table), out: {x, z} (the unit vector away from
//       the table, where a live session's desk stands), table (index), role: 'head'|'side'|'table'}.
//       table: {index, name, node, head, x, z, width, depth, seats, side (-1 port, 1 starboard), sign: {x, z}}.
//       rev changes when anything that stops a walker moved; unseated lists ids that did not fit.
export const TABLE={depth:1,height:0.74,seatOff:0.86,pitch:0.82,minPitch:0.56,headRoom:0.74,gap:0.5,minLength:1,rowPitch:3.5,tightRow:2.7,maxRows:4,maxSeats:15};

export function orgTeams(list,{loose='Crew',maxSeats=TABLE.maxSeats}={}){
  const byId=new Map(list.map(a=>[a.id,a])),parent=new Map(),kids=new Map();
  for(const a of list){
    let p=a.reportsTo&&byId.has(a.reportsTo)&&a.reportsTo!==a.id?a.reportsTo:'';
    for(let x=p,n=0;x&&n<500;x=parent.get(x),n++)if(x===a.id){p='';break} // no loops
    parent.set(a.id,p);if(p)(kids.get(p)||kids.set(p,[]).get(p)).push(a.id);
  }
  const kidsOf=id=>kids.get(id)||[],leads=id=>kidsOf(id).length>0,isTeam=id=>byId.get(id).kind==='team';
  const teams=[],absorbed=new Set(),lone=[];
  const table=(name,node,head,members)=>{
    // A team too big for one table carries on at the next.
    const first=maxSeats-(head?1:0);
    teams.push({name,node,head,members:members.slice(0,first)});
    for(let i=first,k=2;i<members.length;i+=maxSeats,k++)teams.push({name:`${name} (${k})`,node:'',head:'',members:members.slice(i,i+maxSeats)});
  };
  const sits=c=>!leads(c)&&!isTeam(c);
  // above: leads on the way down who had nobody to sit with; the first table below seats them, the topmost at its head.
  const visit=(id,above=[])=>{
    const a=byId.get(id),own=kidsOf(id);let pass=[];
    const seat=(name,node,head,members)=>{const line=[...above,...(head?[head]:[])];above=[];table(name,node,line[0]||'',[...line.slice(1),...members])};
    if(isTeam(id)){
      const only=own.length===1&&leads(own[0])&&!isTeam(own[0])?own[0]:'';
      if(only){absorbed.add(only);seat(a.name,id,only,kidsOf(only).filter(sits))}
      else seat(a.name,id,'',own.filter(sits));
    }else if(own.length&&!absorbed.has(id)){
      const mine=own.filter(sits);
      if(mine.length||!own.some(c=>leads(c)||isTeam(c)))seat(a.name,'',id,mine);
      else{pass=[...above,id];above=[]}
    }
    // Whoever is still waiting for a table goes down the first branch that has one.
    let wait=above.length?above:pass;
    for(const c of own)if(leads(c)||isTeam(c)){visit(c,wait);wait=[]}else visit(c);
  };
  for(const a of list){
    if(parent.get(a.id))continue;
    if(leads(a.id)||isTeam(a.id))visit(a.id);else lone.push(a.id);
  }
  if(lone.length)table(loose,'','',lone);
  return teams;
}

const sideSeats=t=>Math.ceil(t.members.length/2);
// How much of a column a table takes at a seat pitch: room for the head's seat, then the table itself.
const lengthAt=(t,pitch)=>t.members.length?Math.max(TABLE.minLength,sideSeats(t)*pitch):TABLE.minLength/2;

export function seatTables(teams,{aisle=1.1,reach=5.95,front=-3.5,back=5.2,forward=1}={}){
  const span=reach-aisle,most=span-TABLE.headRoom;
  // Fill the columns in order, each table at the widest seat pitch that fits; a tighter pitch when the rows run out.
  const pack=pitch=>{
    const slots=[];let used=Infinity;
    for(const t of teams){
      const p=Math.max(TABLE.minPitch,Math.min(pitch,most/Math.max(1,sideSeats(t)))),length=Math.min(most,lengthAt(t,p)),need=TABLE.headRoom+length;
      if(used+TABLE.gap+need>span+1e-9){slots.push([]);used=0}else used+=TABLE.gap;
      slots.at(-1).push({t,at:used,length,pitch:length/Math.max(1,sideSeats(t))});used+=need;
    }
    return slots;
  };
  let slots=pack(TABLE.pitch);
  if(slots.length>TABLE.maxRows*2)slots=pack(TABLE.minPitch);
  const unseated=[];
  for(const slot of slots.splice(TABLE.maxRows*2))for(const {t} of slot)unseated.push(...(t.head?[t.head]:[]),...t.members,...(t.node?[t.node]:[]));
  const rows=Math.ceil(slots.length/2),room=Math.abs(back-front);
  const rowPitch=rows<=1?0:Math.min(TABLE.rowPitch,room/(rows-1));
  const pos=new Map(),tables=[];
  slots.forEach((slot,k)=>{
    const side=k%2?1:-1,z=front+forward*Math.floor(k/2)*rowPitch;
    for(const {t,at,length,pitch} of slot){
      const x0=aisle+at+TABLE.headRoom,index=tables.length,x=side*(x0+length/2);
      if(t.head)pos.set(t.head,{x:side*(x0-0.34),z,yaw:side*Math.PI/2,out:{x:-side,z:0},table:index,role:'head'});
      t.members.forEach((id,i)=>{
        const far=i%2?1:-1;
        pos.set(id,{x:side*(x0+(Math.floor(i/2)+0.5)*pitch),z:z+far*TABLE.seatOff,yaw:far>0?Math.PI:0,out:{x:0,z:far},table:index,role:'side'});
      });
      if(t.node)pos.set(t.node,{x,z,yaw:0,out:{x:0,z:1},table:index,role:'table'});
      tables.push({index,name:t.name,node:t.node,head:t.head,x,z,width:length,depth:TABLE.depth,seats:t.members.length+(t.head?1:0),side,sign:{x,z}});
    }
  });
  const rev=tables.map(t=>[t.x,t.z,t.width].map(n=>n.toFixed(2)).join(',')).join(';');
  return {pos,tables,rows,rowPitch,rev,radius:Math.max(aisle+span,room)+1,unseated};
}
