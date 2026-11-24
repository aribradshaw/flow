// How a coding agent's mascot answers Allow / Deny in the 3D office: Allow makes it nod and then work (a gentle
// bob and three small gold sparks circling above it, unlike any activity prop) until the reporter's result
// comes back or it is running again; Deny makes it shake its head once and settle.
//   const reactions=createReactions(THREE)
//   reactions.react(key, decision)   'allow' | 'deny': play the nod or the shake (and start working, for allow)
//   reactions.settle(key)            stop working (a result came back, it is running, or it failed)
//   reactions.apply(key, mascot, t)  once per frame after the mascot's own update: mascot = createMascot() handle
//   reactions.dispose()
// key: whatever names the agent for this viewer (owner key and agent id); the same agent always the same key.
export function createReactions(THREE){
  const state=new Map(),spark=new THREE.OctahedronGeometry(0.07,0),gold=new THREE.MeshBasicMaterial({color:'#ffd25a'});
  const WORK_MAX=30000;
  return {
    react(key,decision){
      const s=state.get(key)||{};
      // The same reaction again within a second (our own click, then the server's echo) plays once.
      if(s.kind===(decision==='allow'?'nod':'shake')&&performance.now()-s.at<1000)return;
      state.set(key,{kind:decision==='allow'?'nod':'shake',at:performance.now(),working:decision==='allow',workingSince:performance.now(),sparks:s.sparks});
    },
    settle(key){const s=state.get(key);if(s)s.working=false},
    working:key=>!!state.get(key)?.working,
    apply(key,m,t){
      const s=state.get(key);if(!s||!m?.body)return;
      const body=m.body,dt=(performance.now()-s.at)/1000;
      if(s.kind==='nod'&&dt<0.7)body.rotation.x=Math.sin(dt/0.7*Math.PI*2)*0.35*(1-dt/0.7);
      else if(s.kind==='shake'&&dt<0.8)body.rotation.y+=Math.sin(dt/0.8*Math.PI*3)*0.55*(1-dt/0.8);
      else body.rotation.x=0;
      if(s.working&&performance.now()-s.workingSince>WORK_MAX)s.working=false;
      if(s.working){
        body.position.y+=0.05*Math.sin(t*5);
        if(!s.sparks){s.sparks=new THREE.Group();for(let i=0;i<3;i++){const g=new THREE.Mesh(spark,gold);s.sparks.add(g)}m.group.add(s.sparks)}
        if(s.sparks.parent!==m.group)m.group.add(s.sparks);
        s.sparks.position.y=body.position.y+1.05;s.sparks.rotation.y=t*3.2;
        s.sparks.children.forEach((g,i)=>{const a=i/3*Math.PI*2;g.position.set(Math.cos(a)*0.42,Math.sin(t*6+i*2)*0.06,Math.sin(a)*0.42);g.rotation.y=t*4});
        s.sparks.visible=true;
      }else if(s.sparks){s.sparks.visible=false;if(dt>1.2&&!s.working){s.sparks.removeFromParent();state.delete(key)}}
      else if(dt>1.2)state.delete(key);
    },
    reset(){for(const s of state.values())s.sparks?.removeFromParent();state.clear()},
    dispose(){spark.dispose();gold.dispose();state.clear()},
  };
}
