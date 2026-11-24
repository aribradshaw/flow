// Reading a request body (card #1328). Chunks are kept as Buffers and decoded once, so a UTF-8 character
// split across two chunks is not broken. A body over `max` is read to the end and thrown away (up to `drain`
// more bytes), so the client finishes sending and then gets the 413, instead of a reset connection (EPIPE)
// mid-upload. Past that, the request is destroyed. It never rejects: a client that goes away gives aborted.
// -> Promise<{text} | {tooLarge:true} | {aborted:true}>
export function readRaw(req,max,{drain=max*8}={}){
  return new Promise(ok=>{
    const chunks=[];let size=0,over=false,done=false;
    const fin=v=>{if(!done){done=true;ok(v)}};
    req.on('data',c=>{
      size+=c.length;
      if(size<=max){chunks.push(c);return}
      if(!over){over=true;chunks.length=0}
      if(size>max+drain){fin({tooLarge:true,aborted:true});req.destroy()}
    });
    req.on('end',()=>fin(over?{tooLarge:true}:{text:Buffer.concat(chunks).toString('utf8')}));
    req.on('error',()=>fin({aborted:true}));
    req.on('close',()=>fin({aborted:true})); // after 'end' this does nothing
  });
}
