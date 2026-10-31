// The `flow` CLI against the fixture server, with a throwaway config dir: node --test test/
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {mkdtempSync,statSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {start,KEY} from './fixtures/server.mjs';
import {operations} from './fixtures/registry.mjs';
import {parseArgs,table} from '../tools/flow.mjs';

const FLOW=fileURLToPath(new URL('../tools/flow.mjs',import.meta.url));
let srv,home;
const env=()=>{const e={...process.env,HOME:home,XDG_CONFIG_HOME:join(home,'.config')};for(const k of Object.keys(e))if(k.startsWith('FLOW_'))delete e[k];return e};
const flow=(...args)=>new Promise(r=>execFile(process.execPath,[FLOW,...args],{env:env(),timeout:20000},(err,stdout,stderr)=>r({code:err?err.code??1:0,stdout,stderr})));
before(async()=>{srv=await start();home=mkdtempSync(join(tmpdir(),'flow-cli-'))});
after(async()=>{await srv.close();rmSync(home,{recursive:true,force:true})});

test('login writes a private config and caches the API',async()=>{
  const r=await flow('login','--url',srv.url+'/','--key',KEY);
  assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/Signed in to http:\/\/127\.0\.0\.1:\d+ \(6 commands\)/);
  assert.doesNotMatch(r.stdout+r.stderr,new RegExp(KEY));
  const file=join(home,'.config/flygon-flow/config.json');
  assert.equal(statSync(file).mode&0o777,0o600);
  assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{url:srv.url,key:KEY});
  assert.ok(JSON.parse(readFileSync(join(home,'.config/flygon-flow/openapi-cache.json'),'utf8')).doc.paths);
  const u=await flow('env','use','default-workspace');assert.equal(u.code,0);
  assert.equal(JSON.parse(readFileSync(file,'utf8')).env,'default-workspace');
  assert.equal((await flow('env')).stdout.trim(),'default-workspace');
  assert.notEqual((await flow('env','use','bad id!')).code,0);
});

test('commands are generated from the OpenAPI document',async()=>{
  const h=await flow('help');
  for(const o of operations)assert.match(h.stdout,new RegExp(`flow ${o.id.replace('.',' ')}\\s`));
  const g=await flow('cards');assert.equal(g.code,0);assert.match(g.stdout,/flow cards move/);assert.doesNotMatch(g.stdout,/envs list/);
  const help=await flow('cards','move','--help');
  assert.match(help.stdout,/POST \/api\/v1\/envs\/\{env\}\/cards\/\{number\}\/move/);assert.match(help.stdout,/--column/);
  const bad=await flow('cards','fly');assert.notEqual(bad.code,0);
});

test('table and --json output',async()=>{
  const t=await flow('cards','list','--env','default-workspace','--project','Lantern');
  assert.equal(t.code,0,t.stderr);
  const lines=t.stdout.trim().split('\n');
  assert.match(lines[0],/^NUMBER\s+TITLE\s+COLUMN\s+PROJECT\s+LABELS$/);
  assert.equal(lines.length,3);assert.match(lines[2],/^42\s+MCP server\s+\w+\s+Lantern\s+Backend, Infra$/);
  const j=await flow('cards','list','--project','Lantern','--json');
  assert.equal(j.code,0);const data=JSON.parse(j.stdout);assert.equal(data.total,2);
  assert.deepEqual(srv.calls.at(-1),{id:'cards.list',input:{project:'Lantern',env:'default-workspace'}});
});

test('positional ids, flag coercion and errors',async()=>{
  const m=await flow('cards','move','42','--column','doing');
  assert.equal(m.code,0,m.stderr);assert.match(m.stdout,/^column\s+doing$/m);
  assert.equal(srv.store['default-workspace'].cards.find(c=>c.number===42).column,'doing');
  const c=await flow('cards','create','New card','--labels','A,B','--labels','C','--urgent','--json');
  assert.equal(c.code,0,c.stderr);assert.deepEqual(JSON.parse(c.stdout).labels,['A','B','C']);
  assert.deepEqual(srv.calls.at(-1).input,{title:'New card',labels:['A','B','C'],urgent:true,env:'default-workspace'});
  const e=await flow('cards','get','999');assert.equal(e.code,1);assert.match(e.stderr,/Error: 404 not_found: No card #999/);
  const nan=await flow('cards','move','x','--column','doing');assert.equal(nan.code,1);assert.match(nan.stderr,/--number must be an integer/);
  const unk=await flow('cards','list','--colour','red');assert.equal(unk.code,1);assert.match(unk.stderr,/Unknown option --colour/);
  const i=await flow('cards','move','--input','{"number":41,"column":"uat"}','--json');assert.equal(JSON.parse(i.stdout).column,'uat');
});

test('a bad key is refused with a hint',async()=>{
  const r=await new Promise(res=>execFile(process.execPath,[FLOW,'cards','list'],{env:{...env(),FLOW_API_KEY:'flow_nope'}},(err,stdout,stderr)=>res({code:err?.code||0,stderr})));
  assert.equal(r.code,1);assert.match(r.stderr,/401 unauthorized/);assert.match(r.stderr,/flow login/);
});

test('parseArgs and table helpers',()=>{
  const list=operations[0],move=operations.find(o=>o.id==='cards.move');
  assert.deepEqual(parseArgs(move,['7','--column=doing'],{env:'e'}).input,{number:7,column:'doing',env:'e'});
  assert.throws(()=>parseArgs(move,['7']),/Missing --env \(or flow env use <id>\), --column/);
  assert.throws(()=>parseArgs(list,['extra'],{env:'e'}),/Unexpected argument: extra/);
  assert.equal(parseArgs(list,['--limit','3','--json'],{env:'e'}).json,true);
  assert.equal(table({cards:[]}),'(none)');
  assert.equal(table([{a:1,b:'x'},{a:2,c:true}]),'A  B  C\n1  x\n2     true');
  assert.equal(table(undefined),'OK');
});

test('flow mcp: stdio handshake, tools/list and a proxied call',async()=>{
  const child=spawn(process.execPath,[FLOW,'mcp'],{env:env(),stdio:['pipe','pipe','pipe']});
  const replies=[];let buf='';const waiters=[];
  child.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);replies.push(m);waiters.splice(0).forEach(w=>w())}});
  const ask=async msg=>{child.stdin.write(JSON.stringify(msg)+'\n');while(!replies.some(r=>r.id===msg.id))await new Promise(r=>waiters.push(r));return replies.find(r=>r.id===msg.id)};
  try{
    const init=await ask({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'t',version:'1'}}});
    assert.equal(init.result.protocolVersion,'2025-06-18');
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const list=await ask({jsonrpc:'2.0',id:2,method:'tools/list'});
    assert.deepEqual(list.result.tools.map(t=>t.name).sort(),operations.map(o=>o.id.replace(/\./g,'_')).sort());
    // The default environment (flow env use) makes env optional.
    assert.deepEqual(list.result.tools[0].inputSchema.required,[]);
    const call=await ask({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'cards_list',arguments:{column:'done'}}});
    assert.equal(call.result.structuredContent.cards[0].title,'Logo refresh');
    assert.deepEqual(srv.calls.at(-1),{id:'cards.list',input:{env:'default-workspace',column:'done'}});
    const err=await ask({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'cards_get',arguments:{number:5}}});
    assert.equal(err.result.isError,true);assert.match(err.result.content[0].text,/404/);
    const res=await ask({jsonrpc:'2.0',id:5,method:'resources/read',params:{uri:'flow://openapi.json'}});
    assert.ok(JSON.parse(res.result.contents[0].text).paths);
    child.stdin.write('not json\n');
    while(!replies.some(r=>r.id===null))await new Promise(r=>waiters.push(r));
    assert.equal(replies.find(r=>r.id===null).error.code,-32700);
    assert.equal(replies.length,6,'notifications get no reply');
  }finally{child.stdin.end();await new Promise(r=>child.on('exit',r))}
});

test('wrapped tools run the existing scripts',async()=>{
  const r=await flow('inbox','check',fileURLToPath(new URL('./fixtures/patch.json',import.meta.url)));
  assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/Valid: 1 operation/);
  const w=await flow('workspace','status');assert.equal(w.code,1);assert.match(w.stderr,/FLOW_SYNC_TOKEN/);
});
