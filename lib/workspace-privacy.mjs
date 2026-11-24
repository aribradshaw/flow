// Structured references to owner-only records also stay in the owner's workspace.
export function privateRecords(db){
  const nodes=new Set((db?.charts||[]).flatMap(c=>(c.nodes||[]).filter(n=>n.onlyMe===true).map(n=>n.id)));
  const projects=new Set((db?.projects||[]).filter(p=>p.onlyMe===true||nodes.has(p.entity)).map(p=>p.id));
  const items=new Set((db?.timeline||[]).filter(i=>i.projects?.some(id=>projects.has(id))).map(i=>i.id));
  const cards=new Set((db?.devops?.cards||[]).filter(c=>projects.has(c.project)||items.has(c.item)).map(c=>c.id));
  const af=db?.agentflow||{};
  const linked=x=>x.projects?.some(id=>projects.has(id))||x.items?.some(id=>items.has(id))||x.cards?.some(id=>cards.has(id));
  const agents=new Set((af.agents||[]).filter(a=>nodes.has(a.supervisor)||linked(a)).map(a=>a.id));
  const workflows=new Set((af.workflows||[]).filter(w=>linked(w)||w.steps?.some(s=>agents.has(s.agent))).map(w=>w.id));
  return {nodes,projects,items,cards,agents,workflows};
}

export function withoutPrivateRecords(db){
  if(!db)return db;
  const hidden=privateRecords(db);
  if(!hidden.nodes.size&&!hidden.projects.size)return db;
  const visible=(list,ids)=>(list||[]).filter(x=>!ids.has(x.id));
  const jobKey=(runner,id)=>JSON.stringify([String(runner||'').toLowerCase(),id]);
  const hiddenJobs=new Set((db.agentflow?.agents||[]).filter(a=>hidden.agents.has(a.id)&&a.job).map(a=>jobKey(a.job.runner,a.job.id)));
  return {...db,charts:(db.charts||[]).map(c=>({...c,nodes:visible(c.nodes,hidden.nodes),
    edges:(c.edges||[]).filter(e=>!hidden.nodes.has(e.from)&&!hidden.nodes.has(e.to))})),
  projects:visible(db.projects,hidden.projects),
  timeline:visible(db.timeline,hidden.items).map(i=>hidden.items.has(i.release)?{...i,release:''}:i),
  ...(db.devops?{devops:{...db.devops,cards:visible(db.devops.cards,hidden.cards).map(c=>({...c,
    assignees:(c.assignees||[]).filter(a=>!hidden.nodes.has(a.node))}))}}:{}),
  ...(db.agentflow?{agentflow:{...db.agentflow,agents:visible(db.agentflow.agents,hidden.agents).map(a=>hidden.agents.has(a.reportsTo)?{...a,reportsTo:''}:a),
    workflows:visible(db.agentflow.workflows,hidden.workflows),
    ...(hiddenJobs.size?{runners:(db.agentflow.runners||[]).map(r=>({...r,
      jobs:(r.jobs||[]).filter(j=>!hiddenJobs.has(jobKey(r.name,j.id)))}))}:{})}}:{})};
}
