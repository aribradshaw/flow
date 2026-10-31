// A tiny loopback Flygon Flow for tests: the fixture registry over REST (/api/v1/…, OpenAPI at
// /api/v1/openapi.json) and over MCP (/mcp), with API keys. Each test gets its own store.
import http from 'node:http';
import {operations,invoke,board} from './registry.mjs';
import {mcpHandler,bearer} from '../../lib/mcp.mjs';
import {openapiFor} from '../../lib/api-spec.mjs';

export const KEY='flow_test_0123456789abcdef',OTHER_KEY='flow_test_other_user_key';
const users={[KEY]:{id:'u-owner',email:'owner@example.test'},[OTHER_KEY]:{id:'u-bo',email:'bo@example.com'}};
const json=(res,code,body)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(body))};
const match=(tpl,path)=>{const names=[],re=new RegExp('^'+tpl.replace(/\{([A-Za-z0-9_]+)\}/g,(_,n)=>{names.push(n);return '([^/]+)'})+'$'),m=re.exec(path);return m&&Object.fromEntries(names.map((n,i)=>[n,decodeURIComponent(m[i+1])]))};
const coerce=(v,s)=>s?.type==='integer'||s?.type==='number'?Number(v):s?.type==='boolean'?v==='true':v;

export async function start(){
  const store=board(),calls=[];
  const ctx=user=>({user,store,envCheck:(envId,u)=>store[envId]?.owner===u.email});
  const server=http.createServer(async(req,res)=>{
    const u=new URL(req.url,'http://x');
    if(u.pathname==='/mcp')return mcpHandler(req,res,{operations,invoke,authenticate:t=>users[t]||null,ctx});
    if(u.pathname==='/api/v1/openapi.json')return json(res,200,openapiFor(operations,{url:`http://${req.headers.host}`}));
    for(const op of operations){
      const p=req.method===op.method&&match(op.path,u.pathname);if(!p)continue;
      const user=users[bearer(req)];if(!user)return json(res,401,{error:{code:'unauthorized',message:'Invalid API key'}});
      let body='';for await(const c of req)body+=c;
      const props=op.input.properties,input={...p,...(body?JSON.parse(body):{})};
      for(const [k,v] of u.searchParams)input[k]=props[k]?.type==='array'?[...(input[k]||[]),v]:v;
      for(const k of Object.keys(input))if(typeof input[k]==='string')input[k]=coerce(input[k],props[k]);
      calls.push({id:op.id,input});
      try{return json(res,200,await invoke(op.id,input,ctx(user)))}catch(e){return json(res,e.status||500,{error:{code:e.code||'error',message:e.message}})}
    }
    json(res,404,{error:{code:'not_found',message:'No such route'}});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {url:`http://127.0.0.1:${server.address().port}`,store,calls,close:()=>new Promise(r=>{server.closeAllConnections();server.close(r)})};
}
