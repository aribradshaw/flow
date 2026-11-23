// Request bodies (lib/body.mjs, card #1328): split UTF-8, oversize bodies answered with 413 (not a reset
// connection), and a client that goes away never rejects.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readRaw} from '../lib/body.mjs';
import {mcpHandler} from '../lib/mcp.mjs';

async function serve(handler){
  const server=http.createServer(handler);await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  return {port:server.address().port,close:()=>new Promise(ok=>{server.closeAllConnections();server.close(ok)})};
}
// Sends the given Buffers as separate writes, a tick apart, so the server sees them as separate chunks.
function post(port,parts,{path='/',headers={},abortAfter}={}){
  return new Promise((ok,no)=>{
    const req=http.request({host:'127.0.0.1',port,path,method:'POST',headers:{'content-type':'application/json',...headers}},res=>{let b='';res.setEncoding('utf8');res.on('data',c=>b+=c);res.on('end',()=>ok({status:res.statusCode,body:b}))});
    req.on('error',no);
    (async()=>{for(const [i,p] of parts.entries()){req.write(p);await new Promise(r=>setTimeout(r,5));if(abortAfter===i){req.destroy();return}}req.end()})();
  });
}

test('a UTF-8 character split across two chunks arrives whole',async()=>{
  const s=await serve(async(req,res)=>{const r=await readRaw(req,1000);res.end(JSON.stringify(r))});
  const e=Buffer.from('"café ☕"');const cut=e.indexOf(0xa9); // the second byte of é
  const r=await post(s.port,[e.subarray(0,cut),e.subarray(cut)]);
  assert.deepEqual(JSON.parse(r.body),{text:'"café ☕"'});
  await s.close();
});

test('an oversize body gets a 413, every time, not a reset connection',async()=>{
  const s=await serve(async(req,res)=>{const r=await readRaw(req,64*1024);res.writeHead(r.tooLarge?413:200,{connection:'close'});res.end()});
  const big=Buffer.alloc(300*1024,120);
  for(let i=0;i<10;i++)assert.equal((await post(s.port,[big.subarray(0,150*1024),big.subarray(150*1024)])).status,413);
  await s.close();
});

test('far past the limit the request is cut off instead of read',async()=>{
  let seen;const s=await serve(async(req,res)=>{seen=await readRaw(req,1024,{drain:1024});res.end()});
  await post(s.port,[Buffer.alloc(8*1024,120),Buffer.alloc(8*1024,120)]).catch(()=>{});
  assert.equal(seen.tooLarge,true);
  await s.close();
});

test('a client that goes away mid-body resolves as aborted, and /mcp does not throw',async()=>{
  let raw,mcp;
  const s=await serve(async(req,res)=>{
    if(req.url==='/mcp'){mcp=await mcpHandler(req,res,{operations:[],invoke:async()=>({}),authenticate:async()=>({email:'a@example.test'})}).then(()=>'ok',e=>'threw: '+e.message);return}
    raw=await readRaw(req,1<<20);
  });
  await post(s.port,[Buffer.from('{"a":'),Buffer.from('1')],{abortAfter:0}).catch(()=>{});
  await post(s.port,[Buffer.from('{"jsonrpc":'),Buffer.from('"2.0"}')],{path:'/mcp',headers:{authorization:'Bearer flow_x'},abortAfter:0}).catch(()=>{});
  for(let i=0;i<50&&(!raw||!mcp);i++)await new Promise(r=>setTimeout(r,10));
  assert.deepEqual(raw,{aborted:true});assert.equal(mcp,'ok');
  await s.close();
});
