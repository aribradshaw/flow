// EventSource is recreated on failure, so the caller carries the cursor to the next URL.
export function officeStream({now=Date.now,random=Math.random}={}){
  let down=null,tries=0,cursor='';
  return {
    get cursor(){return cursor},
    get stale(){return down!==null},
    get phase(){
      if(down===null)return 'live';
      const elapsed=now()-down;
      return elapsed>=60000?'unreachable':elapsed>=8000?'reconnecting':'stale';
    },
    received(id){if(id)cursor=id},
    connected(){down=null;tries=0},
    disconnected({restart=false}={}){
      down??=now();
      if(restart)return 500;
      const base=[250,1000,2000,4000,8000][tries++]??10000;
      return Math.min(10000,Math.round(base*(0.8+random()*0.4)));
    },
  };
}

export function officeDiff(previous,next,key,equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b)){
  const old=new Map(previous.map(item=>[key(item),item]));
  const upsert=[];
  for(const item of next){
    const id=key(item);
    if(!old.has(id)||!equal(old.get(id),item))upsert.push(item);
    old.delete(id);
  }
  return {upsert,remove:[...old.keys()]};
}

export function mergeOfficeChat(previous,next){
  const lines=new Map([...previous,...next].map(line=>[line.id,line]));
  return [...lines.values()].sort((a,b)=>a.at.localeCompare(b.at)).slice(-50);
}
