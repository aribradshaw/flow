// Model Context Protocol server for Flygon Flow (no dependencies; docs/mcp-cli.md).
//   mcpHandler(req,res,{operations,invoke,authenticate,ctx?,origins?,openapi?})
//       Streamable HTTP at /mcp, stateless: POST one JSON-RPC message (or a batch) and get the JSON
//       answer; notifications get 202; GET/DELETE get 405 (no server-initiated stream, no sessions).
//       Authorization: Bearer flow_… is checked with authenticate(token,req) -> user|null before
//       anything else; tools run as that user through invoke(id,input,ctx) (ctx = ctx?.(user,req)
//       or {user}).
//   createMcp({operations,call,resources,instructions}) -> {handle(message)}
//       The transport-free core, also used by `flow mcp` (stdio) in tools/flow.mjs.
// One tool per registry operation: name = id with dots as underscores, inputSchema = input.
// Errors thrown by an operation ({status,code,message}) come back as tool results with isError, so
// the model can read and correct them; protocol mistakes are JSON-RPC errors.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {toolName,openapiFor} from './api-spec.mjs';

export const PROTOCOL_VERSIONS=['2025-11-25','2025-06-18','2025-03-26','2024-11-05'];
const VERSION=(()=>{try{return JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version}catch{return '0.0.0'}})();
const DOCS=fileURLToPath(new URL('../docs/mcp-cli.md',import.meta.url));
const INSTRUCTIONS='Flygon Flow: MindMap charts, timelines, the DevOps card board and AgentFlow (agents and workflows, with agents_get / workflows_get briefs for runners), per environment. Most tools take env (an environment id such as default-workspace). Read flow://docs/mcp-cli for setup and flow://openapi.json for the full API.';
export const ERR={parse:-32700,request:-32600,method:-32601,params:-32602,internal:-32603,auth:-32001};
const rpcError=(id,code,message,data)=>({jsonrpc:'2.0',id:id??null,error:{code,message,...(data!==undefined?{data}:{})}});
const plain=v=>!!v&&typeof v==='object'&&!Array.isArray(v);

export function describe(op){
  const ex=(op.examples||[]).map(e=>`Example: ${e.title||''}\nInput: ${JSON.stringify(e.input)}${e.output!==undefined?`\nOutput: ${JSON.stringify(e.output)}`:''}`);
  return [op.summary,op.description,...ex].filter(Boolean).join('\n\n');
}
export function toolFor(op){
  const input=plain(op.input)&&op.input.type==='object'?op.input:{type:'object',properties:{}};
  return {name:toolName(op.id),title:op.summary||op.id,description:describe(op),inputSchema:input,
    ...(op.output?.type==='object'?{outputSchema:op.output}:{}),
    annotations:{title:op.summary||op.id,readOnlyHint:op.method==='GET',destructiveHint:op.method==='DELETE',idempotentHint:op.method==='GET'||op.method==='DELETE',openWorldHint:false}};
}
// Enough checking for a helpful message before the operation validates for real.
function check(schema,args){
  if(!plain(args))return 'arguments must be an object';
  const missing=(schema?.required||[]).filter(k=>args[k]===undefined||args[k]===null);
  if(missing.length)return `missing required ${missing.length>1?'arguments':'argument'}: ${missing.join(', ')}`;
  for(const [k,v] of Object.entries(args)){
    const t=schema?.properties?.[k]?.type;if(!t||v===null)continue;
    const ok={string:typeof v==='string',integer:Number.isInteger(v),number:typeof v==='number',boolean:typeof v==='boolean',array:Array.isArray(v),object:plain(v)};
    if([].concat(t).every(x=>ok[x]===false))return `${k} must be ${[].concat(t).join(' or ')}`;
  }
  return '';
}
export const defaultResources=({openapi})=>[
  {uri:'flow://docs/mcp-cli',name:'mcp-cli',title:'Flygon Flow MCP and CLI guide',mimeType:'text/markdown',read:()=>readFileSync(DOCS,'utf8')},
  {uri:'flow://openapi.json',name:'openapi',title:'Flygon Flow OpenAPI document',mimeType:'application/json',read:async()=>JSON.stringify(await openapi(),null,2)},
];

export function createMcp({operations,call,resources=[],instructions=INSTRUCTIONS,name='flygon-flow',title='Flygon Flow'}){
  const ops=()=>typeof operations==='function'?operations():operations;
  const byName=async n=>(await ops()).find(o=>toolName(o.id)===n);
  const methods={
    initialize:p=>({protocolVersion:PROTOCOL_VERSIONS.includes(p?.protocolVersion)?p.protocolVersion:PROTOCOL_VERSIONS[0],
      capabilities:{tools:{listChanged:false},resources:{listChanged:false}},serverInfo:{name,title,version:VERSION},instructions}),
    ping:()=>({}),
    'tools/list':async()=>({tools:(await ops()).map(toolFor)}),
    'tools/call':async p=>{
      if(typeof p?.name!=='string')throw {rpc:ERR.params,message:'name is required'};
      const op=await byName(p.name);if(!op)throw {rpc:ERR.params,message:`Unknown tool: ${p.name}`};
      const args=p.arguments??{},bad=check(op.input,args);
      if(bad)return {isError:true,content:[{type:'text',text:`Invalid arguments for ${p.name}: ${bad}`}]};
      try{
        const out=await call(op,args);
        return {content:[{type:'text',text:out===undefined?'OK':JSON.stringify(out,null,2)}],...(op.output?.type==='object'&&plain(out)?{structuredContent:out}:{})};
      }catch(e){
        if(e?.rpc)throw e;
        const code=e?.code||(e?.status?`http_${e.status}`:'error');
        return {isError:true,content:[{type:'text',text:`${e?.status?e.status+' ':''}${code}: ${e?.message||String(e)}`}],structuredContent:{error:{status:e?.status||500,code,message:e?.message||String(e)}}};
      }
    },
    'resources/list':()=>({resources:resources.map(({read,...r})=>r)}),
    'resources/templates/list':()=>({resourceTemplates:[]}),
    'resources/read':async p=>{
      const r=resources.find(x=>x.uri===p?.uri);if(!r)throw {rpc:-32002,message:'Resource not found',data:{uri:p?.uri}};
      return {contents:[{uri:r.uri,mimeType:r.mimeType,text:await r.read()}]};
    },
  };
  async function one(m){
    if(!plain(m)||m.jsonrpc!=='2.0')return rpcError(m?.id,ERR.request,'Invalid Request');
    if(m.method===undefined)return 'result' in m||'error' in m?undefined:rpcError(m.id,ERR.request,'Invalid Request'); // a response to us: nothing to do
    const isNote=!('id' in m);
    if(typeof m.method!=='string')return isNote?undefined:rpcError(m.id,ERR.request,'Invalid Request');
    if(isNote)return; // notifications/initialized, cancelled, ...: stateless, nothing to track
    const f=methods[m.method];if(!f)return rpcError(m.id,ERR.method,`Method not found: ${m.method}`);
    try{return {jsonrpc:'2.0',id:m.id,result:await f(m.params)}}
    catch(e){return e?.rpc?rpcError(m.id,e.rpc,e.message,e.data):rpcError(m.id,ERR.internal,'Internal error')}
  }
  return {
    // A parsed message or batch -> the reply (undefined when nothing needs an answer).
    async handle(msg){
      if(Array.isArray(msg)){
        if(!msg.length)return rpcError(null,ERR.request,'Invalid Request');
        const out=(await Promise.all(msg.map(one))).filter(Boolean);return out.length?out:undefined;
      }
      return one(msg);
    },
  };
}

const send=(res,code,body,headers={})=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});res.end(body===undefined?undefined:JSON.stringify(body))};
export const bearer=req=>/^Bearer\s+(\S+)$/i.exec(req.headers.authorization||'')?.[1]||'';

export async function mcpHandler(req,res,{operations,invoke,authenticate,ctx,origins=[],openapi,maxBytes=1000000}){
  // Browsers may only call from an allowed origin (DNS rebinding); MCP clients send no Origin.
  const o=req.headers.origin;
  if(o){let host='';try{host=new URL(o).host}catch{}if(!origins.includes(o)&&host!==req.headers.host){send(res,403,rpcError(null,ERR.request,'Origin not allowed'));return true}}
  const v=req.headers['mcp-protocol-version'];
  if(v&&!PROTOCOL_VERSIONS.includes(v)){send(res,400,rpcError(null,ERR.request,`Unsupported MCP-Protocol-Version ${v}`));return true}
  const token=bearer(req);
  let user=null;try{user=token?await authenticate(token,req):null}catch{}
  if(!user){send(res,401,rpcError(null,ERR.auth,token?'Invalid or revoked API key':'Send Authorization: Bearer <Flygon Flow API key>'),{'WWW-Authenticate':`Bearer realm="flygon-flow"${token?', error="invalid_token"':''}`});return true}
  if(req.method!=='POST'){send(res,405,rpcError(null,ERR.request,'Use POST: this server is stateless and opens no event stream'),{Allow:'POST'});return true}
  if(!String(req.headers['content-type']||'').startsWith('application/json')){send(res,415,rpcError(null,ERR.request,'Expected application/json'));return true}
  let body='',bytes=0,big=false;
  for await(const chunk of req){bytes+=chunk.length;if(bytes>maxBytes){big=true;break}body+=chunk}
  if(big){send(res,413,rpcError(null,ERR.request,'Request too large'));return true}
  let msg;try{msg=JSON.parse(body)}catch{send(res,400,rpcError(null,ERR.parse,'Parse error'));return true}
  const doc=async()=>typeof openapi==='function'?openapi():openapi||openapiFor(typeof operations==='function'?await operations():operations);
  const mcp=createMcp({operations,resources:defaultResources({openapi:doc}),call:async(op,args)=>invoke(op.id,args,ctx?await ctx(user,req):{user})});
  const out=await mcp.handle(msg);
  if(out===undefined){res.writeHead(202);res.end();return true}
  send(res,200,out);return true;
}
