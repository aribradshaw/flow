#!/usr/bin/env node
// `flow`: the Flow command line, currently run from a checkout. Guide: docs/mcp-cli.md.
//   flow login --url <server> --key <flow_…>   (or --key-stdin, or FLOW_API_KEY)  save the server and key
//   flow env use <id> | flow env                choose (or show) the default environment
//   flow <group> <command> [args] [--flags]     generated from the server's OpenAPI, e.g.
//       flow cards list --env default-workspace --project Lantern
//       flow cards move 42 --column doing
//     --json prints the raw answer (default: a table); --input '<json>' or --input @file.json gives the
//     whole input; <command> --help lists its flags.
//   flow refresh                                refetch the OpenAPI document (cached for an hour)
//   flow mcp                                    a local stdio MCP server that proxies to the REST API
//   flow inbox|devlog|workspace …              tools/inbox.mjs, tools/devlog.mjs, tools/env.mjs
// Config: $XDG_CONFIG_HOME/flygon-flow/config.json (default ~/.config), written 0600; FLOW_URL,
// FLOW_API_KEY and FLOW_ENV override it. The key is never printed.
import {readFileSync,writeFileSync,mkdirSync,renameSync,chmodSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {operationsFrom,requestFor} from '../lib/api-spec.mjs';
import {createMcp,defaultResources} from '../lib/mcp.mjs';

const dir=join(process.env.XDG_CONFIG_HOME||join(homedir(),'.config'),'flygon-flow'),CONFIG=join(dir,'config.json'),CACHE=join(dir,'openapi-cache.json');
const TTL=Number(process.env.FLOW_SPEC_TTL||3600)*1000,ENV_ID=/^[A-Za-z0-9-]{1,64}$/;
const WRAPPED={inbox:'inbox.mjs',devlog:'devlog.mjs',workspace:'env.mjs'};
const fail=(m,code=1)=>{console.error(m);process.exit(code)};
const readJson=f=>{try{return JSON.parse(readFileSync(f,'utf8'))}catch{return null}};
const writePrivate=(f,v)=>{mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(f+'.tmp',JSON.stringify(v,null,2),{mode:0o600});chmodSync(f+'.tmp',0o600);renameSync(f+'.tmp',f)};
const saved=()=>readJson(CONFIG)||{};
const config=()=>{const c=saved();return {url:(process.env.FLOW_URL||c.url||'').replace(/\/+$/,''),key:process.env.FLOW_API_KEY||c.key||'',env:process.env.FLOW_ENV||c.env||''}};
const kebab=s=>s.replace(/[A-Z]/g,c=>'-'+c.toLowerCase()).replace(/_/g,'-'),camel=s=>s.replace(/-([a-z0-9])/g,(_,c)=>c.toUpperCase());

// ---------- REST ----------
async function http(cfg,method,path,body){
  if(!cfg.url)throw {status:0,code:'not_logged_in',message:'No server: run flow login --url <server> --key <key>'};
  let r;
  try{r=await fetch(cfg.url+path,{method,headers:{accept:'application/json',...(cfg.key?{authorization:'Bearer '+cfg.key}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)})}
  catch(e){throw {status:0,code:'unreachable',message:`Cannot reach ${cfg.url}: ${e.cause?.code||e.message}`}}
  const text=await r.text();let data;try{data=text?JSON.parse(text):undefined}catch{data=text}
  if(!r.ok){const e=data?.error;throw {status:r.status,code:e?.code||data?.code||`http_${r.status}`,message:e?.message||(typeof e==='string'?e:'')||data?.message||r.statusText}}
  return data;
}
export const call=(cfg,op,input)=>{const q=requestFor(op,input);return http(cfg,q.method,q.path+q.query,q.body)};

// The OpenAPI document, cached per server URL for an hour; a stale copy is used when offline.
async function spec(cfg,{refresh=false}={}){
  const c=readJson(CACHE);
  if(!refresh&&c?.url===cfg.url&&Date.now()-Date.parse(c.fetchedAt)<TTL)return c.doc;
  try{const doc=await http(cfg,'GET','/api/v1/openapi.json');if(!doc?.paths)throw {message:'not an OpenAPI document'};writePrivate(CACHE,{url:cfg.url,fetchedAt:new Date().toISOString(),doc});return doc}
  catch(e){if(c?.url===cfg.url&&!refresh){console.error(`(using the cached API description: ${e.message})`);return c.doc}throw e}
}

// ---------- commands generated from operations ----------
const words=op=>op.id.split('.').map(kebab);
const reserved=new Set(['json','table','input','help']);
function coerce(v,s={},name){
  const t=[].concat(s.type||'string')[0];
  if(t==='integer'||t==='number'){const n=Number(v);if(v===''||!Number.isFinite(n)||(t==='integer'&&!Number.isInteger(n)))throw `--${kebab(name)} must be ${t==='integer'?'an integer':'a number'}`;return n}
  if(t==='boolean'){if(v===true||/^(true|1|yes)$/i.test(v))return true;if(v===false||/^(false|0|no)$/i.test(v))return false;throw `--${kebab(name)} must be true or false`}
  if(t==='array')return (Array.isArray(v)?v:String(v).split(',')).flatMap(x=>Array.isArray(x)?x:String(x).split(',')).filter(x=>x!=='').map(x=>coerce(x,s.items,name));
  if(t==='object'){try{return JSON.parse(v)}catch{throw `--${kebab(name)} must be JSON`}}
  return String(v);
}
// argv after the command words -> input, plus output options.
export function parseArgs(op,argv,cfg={}){
  const props=op.input?.properties||{},find=k=>props[k]?k:props[camel(k)]?camel(k):Object.keys(props).find(p=>kebab(p)===k);
  const raw={},pos=[],opts={json:false,help:false};let input={};
  for(let i=0;i<argv.length;i++){
    const a=argv[i];
    if(a==='--'){pos.push(...argv.slice(i+1));break}
    if(!a.startsWith('--')||a==='-'){pos.push(a);continue}
    let [k,v]=a.slice(2).split(/=(.*)/s);
    if(k==='json'||k==='table'){opts.json=k==='json';continue}
    if(k==='help'){opts.help=true;continue}
    if(k==='input'){v??=argv[++i];try{input={...input,...JSON.parse(v?.startsWith('@')?readFileSync(v.slice(1),'utf8'):v)}}catch(e){throw `--input: ${e.message}`}continue}
    let name=find(k),neg=false;
    if(!name&&k.startsWith('no-')&&find(k.slice(3))){name=find(k.slice(3));neg=true}
    if(!name)throw `Unknown option --${k} for ${words(op).join(' ')} (see --help)`;
    const boolean=[].concat(props[name].type)[0]==='boolean';
    if(neg)v=false;else if(v===undefined)v=boolean&&(argv[i+1]===undefined||argv[i+1].startsWith('--')||!/^(true|false|1|0|yes|no)$/i.test(argv[i+1]))?true:argv[++i];
    if(v===undefined)throw `--${k} needs a value`;
    (raw[name]||=[]).push(v);
  }
  for(const [k,vs] of Object.entries(raw)){const t=[].concat(props[k].type)[0];input[k]=t==='array'?coerce(vs,props[k],k):coerce(vs.at(-1),props[k],k)}
  // Positionals fill path parameters and then required fields, in order (env is always --env).
  const slots=[...[...op.path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(m=>m[1]),...(op.input?.required||[])].filter((k,i,a)=>k!=='env'&&a.indexOf(k)===i&&props[k]&&input[k]===undefined);
  if(pos.length>slots.length)throw `Unexpected argument${pos.length-slots.length>1?'s':''}: ${pos.slice(slots.length).join(' ')}`;
  pos.forEach((v,i)=>{input[slots[i]]=coerce(v,props[slots[i]],slots[i])});
  if(props.env&&input.env===undefined&&cfg.env)input.env=cfg.env;
  if(!opts.help){const missing=(op.input?.required||[]).filter(k=>input[k]===undefined);if(missing.length)throw `Missing ${missing.map(k=>k==='env'?'--env (or flow env use <id>)':'--'+kebab(k)).join(', ')}`}
  return {input,...opts};
}
function opHelp(op){
  const props=op.input?.properties||{},req=new Set(op.input?.required||[]);
  const lines=[`flow ${words(op).join(' ')}  (${op.method} ${op.path}, ${op.scope||'read'})`,'',[op.summary,op.description].filter(Boolean).join('\n\n'),'','Options:'];
  for(const [k,s] of Object.entries(props)){const t=[].concat(s.type||'string').join('|');lines.push(`  --${kebab(k).padEnd(16)} ${(s.enum?s.enum.join('|'):t).padEnd(14)} ${req.has(k)?'required ':''}${s.description||''}`.trimEnd())}
  lines.push('  --json                            print the raw JSON answer','  --input <json|@file>              the whole input as JSON');
  for(const e of op.examples||[])lines.push('',`Example: ${e.title||''}`,`  ${JSON.stringify(e.input)}`);
  return lines.join('\n');
}
function groupHelp(ops,prefix=[]){
  const list=ops.filter(o=>prefix.every((w,i)=>words(o)[i]===w));
  return (prefix.length?`flow ${prefix.join(' ')} commands:`:'Commands from the server:')+'\n'+list.map(o=>`  flow ${words(o).join(' ').padEnd(28)} ${o.summary||''}`).join('\n');
}

// ---------- output ----------
const scalar=v=>v===null||['string','number','boolean'].includes(typeof v);
const cell=v=>{const s=v==null?'':Array.isArray(v)?v.map(x=>scalar(x)?x:x?.name||x?.title||x?.id||JSON.stringify(x)).join(', '):typeof v==='object'?JSON.stringify(v):String(v);const one=s.replace(/\s+/g,' ');return one.length>48?one.slice(0,47)+'…':one};
export function table(data){
  if(data===undefined||data===null||data==='')return 'OK';
  if(scalar(data))return String(data);
  if(!Array.isArray(data)){
    const arrays=Object.entries(data).filter(([,v])=>Array.isArray(v)&&v.every(x=>x&&typeof x==='object'));
    if(arrays.length===1&&Object.values(data).every(v=>v===arrays[0][1]||scalar(v)))return table(arrays[0][1]);
    const w=Math.max(...Object.keys(data).map(k=>k.length));
    return Object.entries(data).map(([k,v])=>`${k.padEnd(w)}  ${cell(v)}`).join('\n')||'OK';
  }
  if(!data.length)return '(none)';
  if(data.every(scalar))return data.join('\n');
  const keys=[];for(const r of data)for(const [k,v] of Object.entries(r||{}))if(!keys.includes(k)&&(scalar(v)||Array.isArray(v)))keys.push(k);
  const cols=keys.filter(k=>!/^(id|description|created|updated|checklist|links)$/.test(k)||keys.length<=4).slice(0,8);
  const rows=[cols.map(k=>k.toUpperCase()),...data.map(r=>cols.map(k=>cell(r?.[k])))],w=cols.map((_,i)=>Math.max(...rows.map(r=>r[i].length)));
  return rows.map(r=>r.map((c,i)=>i===r.length-1?c:c.padEnd(w[i])).join('  ').trimEnd()).join('\n');
}

// ---------- stdio MCP server (proxying to REST) ----------
async function mcp(){
  const cfg=config();
  const ops=async()=>operationsFrom(await spec(cfg)).map(op=>{
    if(!cfg.env||!op.input?.properties?.env)return op;
    const input={...op.input,properties:{...op.input.properties,env:{...op.input.properties.env,description:`${op.input.properties.env.description||'Environment id'} (default ${cfg.env})`}},required:(op.input.required||[]).filter(k=>k!=='env')};
    return {...op,input};
  });
  const server=createMcp({operations:ops,resources:defaultResources({openapi:()=>spec(cfg)}),
    call:(op,args)=>call(cfg,op,{...(cfg.env&&op.input?.properties?.env?{env:cfg.env}:{}),...args})});
  const out=v=>v!==undefined&&process.stdout.write(JSON.stringify(v)+'\n');
  const rl=createInterface({input:process.stdin,crlfDelay:Infinity}),pending=new Set();
  rl.on('line',line=>{
    if(!line.trim())return;
    let msg;try{msg=JSON.parse(line)}catch{out({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});return}
    const p=server.handle(msg).then(out,e=>console.error(e)).finally(()=>pending.delete(p));pending.add(p);
  });
  rl.on('close',async()=>{await Promise.all(pending);process.exit(0)});
  console.error(`flow mcp: proxying to ${cfg.url||'(no server: run flow login)'}`);
}

// ---------- main ----------
async function main(argv){
  const [cmd,...rest]=argv;
  if(WRAPPED[cmd]){
    const child=spawn(process.execPath,[fileURLToPath(new URL(WRAPPED[cmd],import.meta.url)),...rest],{stdio:'inherit'});
    child.on('exit',(code,sig)=>process.exit(sig?1:code??1));return;
  }
  if(cmd==='login'){
    const opt=k=>{const i=rest.indexOf('--'+k);return i>=0?rest[i+1]:undefined};
    let url=opt('url')||saved().url,key=opt('key')||process.env.FLOW_API_KEY||'';
    if(rest.includes('--key-stdin'))key=readFileSync(0,'utf8').trim();
    if(!url||!/^https?:\/\/[^/]+/.test(url))fail('Usage: flow login --url <server URL> --key <flow_… API key>  (or --key-stdin)');
    if(!key)fail('An API key is required: --key <key>, --key-stdin or FLOW_API_KEY');
    if(!key.startsWith('flow_'))console.error('Warning: Flygon Flow API keys start with flow_');
    url=url.replace(/\/+$/,'');
    writePrivate(CONFIG,{...saved(),url,key});
    try{const ops=operationsFrom(await spec({url,key},{refresh:true}));console.log(`Signed in to ${url} (${ops.length} commands). Config: ${CONFIG}`)}
    catch(e){console.log(`Saved ${url} to ${CONFIG}, but could not load its API yet: ${e.message}`)}
    return;
  }
  if(cmd==='logout'){const c=saved();delete c.key;writePrivate(CONFIG,c);console.log('Removed the API key');return}
  if(cmd==='env'){
    if(rest[0]==='use'){if(!ENV_ID.test(rest[1]||''))fail('Usage: flow env use <environment id>');writePrivate(CONFIG,{...saved(),env:rest[1]});console.log(`Default environment: ${rest[1]}`);return}
    if(!rest.length){const c=config();console.log(c.env||'(none: flow env use <id>)');return}
    fail('Usage: flow env use <id> | flow env');
  }
  if(cmd==='mcp')return mcp();
  const cfg=config();
  if(cmd==='refresh'){const ops=operationsFrom(await spec(cfg,{refresh:true}));console.log(`${ops.length} commands from ${cfg.url}`);return}
  const usage=`Usage: flow <command> …\n  flow login --url <server> --key <key>   flow env use <id>   flow refresh   flow mcp\n  flow inbox …   flow devlog …   flow workspace …`;
  if(!cmd||cmd==='help'||cmd==='--help'||cmd==='-h'){
    console.log(usage);
    if(cfg.url)try{console.log('\n'+groupHelp(operationsFrom(await spec(cfg))))}catch(e){console.log(`\n(${e.message})`)}
    return;
  }
  const ops=operationsFrom(await spec(cfg));
  // The longest operation id matching the leading words.
  const lead=[];for(const a of argv){if(a.startsWith('-'))break;lead.push(a)}
  let op=null,n=0;
  for(const o of ops){const w=words(o);if(w.length>n&&w.length<=lead.length&&w.every((x,i)=>x===lead[i])){op=o;n=w.length}}
  if(!op){
    const prefix=[];for(const w of lead){if(!ops.some(o=>[...prefix,w].every((x,i)=>words(o)[i]===x)))break;prefix.push(w)}
    if(prefix.length){console.log(groupHelp(ops,prefix));process.exit(prefix.length===lead.length?0:1)}
    fail(`Unknown command: ${cmd}\n${usage}\n\n${groupHelp(ops)}`);
  }
  let a;try{a=parseArgs(op,argv.slice(n),cfg)}catch(e){fail(typeof e==='string'?`${e}\n\n${opHelp(op)}`:e.message)}
  if(a.help){console.log(opHelp(op));return}
  const data=await call(cfg,op,a.input);
  console.log(a.json?JSON.stringify(data??null,null,2):table(data));
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===realpathSync(process.argv[1]))
  main(process.argv.slice(2)).catch(e=>fail(e?.status!==undefined||e?.code?`Error: ${e.status?e.status+' ':''}${e.code}: ${e.message}${e.status===401?'\nCheck your key: flow login --url <server> --key <key>':''}`:String(e?.stack||e)));
