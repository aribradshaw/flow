// Public REST API v1: every operation in the registry (lib/registry.mjs) at its method + path,
// plus GET /api/v1/openapi.json generated from the same registry (OpenAPI 3.1).
//
//   if(await apiV1(req,res,{authenticate,userFor,store,envCheck}))return;
//
// authenticate(req) -> {user:{id,email}, scopes:['read'|'write'|'admin',...]} | null   (Authorization: Bearer flow_…)
// userFor(req)      -> {id,email} | null   optional: the browser session, used only without an Authorization header
// store             lib/workspaces.mjs workspaceStore()
// envCheck(envId,user,'read'|'write') -> truthy when allowed (see envCheckFor below)
// rateLimit({req,user,operation}) -> optional hook; return {ok:false, retryAfter} to refuse with 429
// registry          optional {operations, invoke} (tests pass a fixture)
//
// Answers JSON only: errors are {error, code}. Returns false for paths outside /api/v1 so the
// caller can carry on routing. Nothing here depends on server.mjs.
import * as defaultRegistry from './registry.mjs';
import {coerce} from './json-schema.mjs';

const MAX_BODY=1<<20,RANK={read:1,write:2,admin:3};
const json=(res,status,body,headers={})=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end(JSON.stringify(body))};
const error=(res,status,code,message,headers)=>json(res,status,{error:message,code},headers);
const same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();

// "/api/v1/envs/{env}/cards/{card}" -> {re, names}
function compile(path){
  const names=[];
  const re=new RegExp('^'+path.split('/').map(s=>{const m=/^\{(\w+)\}$/.exec(s);if(!m)return s.replace(/[.*+?^$()|[\]\\]/g,'\\$&');names.push(m[1]);return '([^/]+)'}).join('/')+'/?$');
  return {re,names};
}
const routesFor=new WeakMap();
function routes(reg){
  if(!routesFor.has(reg))routesFor.set(reg,reg.operations.map(o=>({o,...compile(o.path)})));
  return routesFor.get(reg);
}

function readBody(req){
  return new Promise((ok,no)=>{
    let size=0;const chunks=[];
    req.on('data',c=>{size+=c.length;if(size>MAX_BODY){no(Object.assign(new Error('Body too large'),{status:413,code:'too_large'}));req.destroy()}else chunks.push(c)});
    req.on('end',()=>ok(Buffer.concat(chunks).toString('utf8')));req.on('error',no);
  });
}

export async function apiV1(req,res,{authenticate,userFor,store,envCheck,rateLimit,registry=defaultRegistry}={}){
  const u=new URL(req.url,'http://x');
  if(u.pathname!=='/api/v1'&&!u.pathname.startsWith('/api/v1/'))return false;
  try{
    if(u.pathname==='/api/v1/openapi.json'){
      if(req.method!=='GET'&&req.method!=='HEAD'){error(res,405,'method_not_allowed','Use GET',{allow:'GET'});return true}
      json(res,200,openapi(registry,{server:`${req.headers['x-forwarded-proto']==='https'?'https':'http'}://${req.headers.host||'localhost'}`}),{'access-control-allow-origin':'*'});return true;
    }
    const matches=routes(registry).map(r=>({...r,m:r.re.exec(u.pathname)})).filter(r=>r.m);
    if(!matches.length){error(res,404,'not_found','No such endpoint');return true}
    const hit=matches.find(r=>r.o.method===req.method);
    if(!hit){error(res,405,'method_not_allowed',`Use ${[...new Set(matches.map(r=>r.o.method))].join(', ')}`,{allow:[...new Set(matches.map(r=>r.o.method))].join(', ')});return true}
    const o=hit.o;

    // Who is calling: an API key, else (no Authorization header at all) the browser session.
    let user=null,scopes=[];
    if(req.headers.authorization){
      const a=authenticate?await authenticate(req):null,who=a?.user||(a?.email?a:null);
      if(!who){error(res,401,'invalid_token','Invalid or expired API key',{'www-authenticate':'Bearer'});return true}
      user=who;scopes=Array.isArray(a.scopes)?a.scopes:['read','write','admin'];
    }else if(userFor){
      user=await userFor(req);scopes=['read','write'];
    }
    if(!user?.email){error(res,401,'unauthorized','Send Authorization: Bearer flow_…',{'www-authenticate':'Bearer'});return true}
    if(!scopes.some(s=>RANK[s]>=RANK[o.scope])){error(res,403,'insufficient_scope',`This needs the ${o.scope} scope`);return true}
    if(rateLimit){
      const r=await rateLimit({req,user,operation:o});
      if(r&&r.ok===false){error(res,429,'rate_limited','Too many requests; slow down',r.retryAfter?{'retry-after':String(Math.ceil(r.retryAfter))}:{});return true}
    }

    // Input: query (GET/DELETE) or JSON body (POST/PATCH), then path parameters on top.
    let input={};
    if(req.method==='POST'||req.method==='PATCH'){
      const type=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase();
      if(type!=='application/json'){error(res,415,'unsupported_media_type','Send Content-Type: application/json');return true}
      if(Number(req.headers['content-length'])>MAX_BODY){error(res,413,'too_large','The body is over 1 MB',{connection:'close'});return true}
      const raw=await readBody(req);
      if(raw.trim()){try{input=JSON.parse(raw)}catch{error(res,400,'invalid_json','The body is not valid JSON');return true}}
      if(!input||typeof input!=='object'||Array.isArray(input)){error(res,400,'invalid_input','The body must be a JSON object');return true}
    }else{
      // Repeated keys join as a comma list: ?columns=a&columns=b is the same as ?columns=a,b.
      const q={};for(const [k,v] of u.searchParams)q[k]=k in q?q[k]+','+v:v;
      input=coerce(o.input,q);
    }
    const path={};hit.names.forEach((n,i)=>{try{path[n]=decodeURIComponent(hit.m[i+1])}catch{path[n]=hit.m[i+1]}});
    Object.assign(input,coerce(o.input,path));

    const out=await registry.invoke(o.id,input,{user,store,envCheck});
    json(res,o.method==='POST'&&/\.create$/.test(o.id)?201:200,out);
  }catch(e){
    const status=Number.isInteger(e?.status)&&e.status>=400&&e.status<600?e.status:500;
    if(status===500)console.error('api/v1:',e);
    if(!res.headersSent)json(res,status,{error:status===500?'Something went wrong':e.message,code:e.code||'internal',...(e.details?{details:e.details}:{}),...(e.gate?{gate:e.gate}:{})});
  }
  return true;
}

// envCheck from the workspace store alone, mirroring the server's rules (lib/environments.mjs):
// read = owner, a member, or a public environment; write = owner. Archived ones are not found.
export function envCheckFor(store){
  return async(envId,user,mode)=>{
    const w=await store.get(envId);
    if(!w||w.archivedAt||!user?.email)return false;
    const owner=same(w.owner,user.email),member=(w.data?.environment?.members||[]).some(m=>same(m,user.email));
    return mode==='write'?owner:owner||member||w.visibility==='public';
  };
}

// A simple in-memory limiter for the rateLimit hook: `perMinute` calls per user (writes count double).
export function memoryRateLimit({perMinute=120}={}){
  const buckets=new Map();
  return ({user,operation})=>{
    const t=Date.now(),k=user.id||user.email,b=buckets.get(k)||{tokens:perMinute,at:t};
    b.tokens=Math.min(perMinute,b.tokens+(t-b.at)*perMinute/60000);b.at=t;
    const cost=operation.scope==='read'?1:2;
    if(buckets.size>10000)buckets.clear();
    buckets.set(k,b);
    if(b.tokens<cost)return {ok:false,retryAfter:(cost-b.tokens)*60/perMinute};
    b.tokens-=cost;return {ok:true};
  };
}

// ---------- OpenAPI 3.1 ----------
const ERROR={type:'object',required:['error','code'],properties:{error:{type:'string'},code:{type:'string'},details:{type:'array',items:{type:'string'}}}};
const ERRORS={400:'Invalid input',401:'Missing or invalid API key',403:'The key lacks the scope',404:'Not found (also for environments you cannot see)',409:'Conflict, or a board gate needs confirmation',429:'Rate limited'};
export function openapi(reg=defaultRegistry,{server=''}={}){
  const paths={};
  for(const o of reg.operations){
    const names=[...o.path.matchAll(/\{(\w+)\}/g)].map(m=>m[1]),props=o.input?.properties||{},req=new Set(o.input?.required||[]);
    const param=(k,where)=>{const {description,...schema}=props[k]||{};return {name:k,in:where,required:where==='path'||req.has(k),...(description?{description}:{}),schema,
      ...(where==='query'&&schema.type==='array'?{style:'form',explode:false}:{})}};
    const parameters=names.map(k=>param(k,'path'));
    let requestBody;
    const rest=Object.fromEntries(Object.entries(props).filter(([k])=>!names.includes(k)));
    if(o.method==='GET'||o.method==='DELETE')parameters.push(...Object.keys(rest).map(k=>param(k,'query')));
    else{
      const strip=x=>Object.fromEntries(Object.entries(x).filter(([k])=>!names.includes(k)));
      requestBody={required:true,content:{'application/json':{schema:{...o.input,properties:rest,required:[...req].filter(k=>!names.includes(k))},
        examples:Object.fromEntries(o.examples.map((x,i)=>['example'+(i+1),{summary:x.title,value:strip(x.input)}]))}}};
    }
    const ok=o.method==='POST'&&/\.create$/.test(o.id)?'201':'200';
    (paths[o.path]||={})[o.method.toLowerCase()]={
      operationId:o.id,summary:o.summary,description:o.description,tags:o.tags,'x-scope':o.scope,
      security:[{bearer:[]}],parameters,...(requestBody?{requestBody}:{}),
      responses:{[ok]:{description:o.summary,content:{'application/json':{schema:o.output,examples:Object.fromEntries(o.examples.map((x,i)=>['example'+(i+1),{summary:x.title,value:x.output}]))}}},
        ...Object.fromEntries(Object.entries(ERRORS).map(([s,d])=>[s,{$ref:'#/components/responses/E'+s}]))},
    };
  }
  return {
    openapi:'3.1.0',
    info:{title:'Flygon Flow API',version:'1.0.0',description:'Org charts, timeline and DevOps board of a Flygon Flow environment. Authenticate with `Authorization: Bearer flow_…`. Lists take `limit` and `cursor` and return `nextCursor`. Errors are `{error, code}`.'},
    ...(server?{servers:[{url:server}]}:{}),
    tags:[...new Set(reg.operations.flatMap(o=>o.tags))].map(name=>({name})),
    paths,
    components:{
      securitySchemes:{bearer:{type:'http',scheme:'bearer',description:'An API key: flow_…'}},
      schemas:{Error:ERROR},
      responses:Object.fromEntries(Object.entries(ERRORS).map(([s,d])=>['E'+s,{description:d,content:{'application/json':{schema:{$ref:'#/components/schemas/Error'}}}}])),
    },
  };
}
