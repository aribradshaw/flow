// MCP over Streamable HTTP against the fixture registry: node --test test/
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {start,KEY,OTHER_KEY} from './fixtures/server.mjs';
import {operations} from './fixtures/registry.mjs';
import {createMcp,toolFor,PROTOCOL_VERSIONS} from '../lib/mcp.mjs';
import {openapiFor,operationsFrom,requestFor} from '../lib/api-spec.mjs';

let srv;
before(async()=>{srv=await start()});
after(()=>srv.close());
let n=0;
const post=(body,{key=KEY,headers={}}={})=>fetch(srv.url+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(key?{authorization:'Bearer '+key}:{}),...headers},body:typeof body==='string'?body:JSON.stringify(body)});
const rpc=async(method,params,opts)=>{const r=await post({jsonrpc:'2.0',id:++n,method,...(params?{params}:{})},opts);assert.equal(r.status,200);const b=await r.json();assert.equal(b.id,n);return b};

test('initialize negotiates the protocol and advertises tools and resources',async()=>{
  const {result}=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}});
  assert.equal(result.protocolVersion,'2025-06-18');
  assert.equal(result.serverInfo.name,'flygon-flow');
  assert.ok(result.capabilities.tools&&result.capabilities.resources);
  const {result:r2}=await rpc('initialize',{protocolVersion:'1999-01-01',capabilities:{}});
  assert.equal(r2.protocolVersion,PROTOCOL_VERSIONS[0]);
});

test('notifications get 202 and no body',async()=>{
  const r=await post({jsonrpc:'2.0',method:'notifications/initialized'});
  assert.equal(r.status,202);assert.equal(await r.text(),'');
});

test('tools/list has one tool per registry operation',async()=>{
  const {result}=await rpc('tools/list');
  assert.deepEqual(result.tools.map(t=>t.name),operations.map(o=>o.id.replace(/\./g,'_')));
  const list=result.tools.find(t=>t.name==='cards_list'),op=operations[0];
  assert.deepEqual(list.inputSchema,op.input);
  assert.deepEqual(list.outputSchema,op.output);
  assert.match(list.description,/^List DevOps cards\n\nCards on the board/);
  assert.match(list.description,/Example: Open cards in Lantern\nInput: \{"env":"default-workspace","project":"Lantern"\}/);
  assert.equal(list.annotations.readOnlyHint,true);
  assert.equal(result.tools.find(t=>t.name==='cards_delete').annotations.destructiveHint,true);
  // An array output gets no outputSchema (MCP output schemas are objects).
  assert.equal(result.tools.find(t=>t.name==='envs_list').outputSchema,undefined);
});

test('tools/call runs the operation as the key owner',async()=>{
  const {result}=await rpc('tools/call',{name:'cards_list',arguments:{env:'default-workspace',project:'Lantern'}});
  assert.equal(result.isError,undefined);
  assert.equal(result.structuredContent.total,2);
  assert.deepEqual(JSON.parse(result.content[0].text),result.structuredContent);
  const {result:moved}=await rpc('tools/call',{name:'cards_move',arguments:{env:'default-workspace',number:42,column:'doing'}});
  assert.equal(moved.structuredContent.column,'doing');
  assert.equal(srv.store['default-workspace'].cards.find(c=>c.number===42).column,'doing');
});

test('operation errors come back as isError results; unknown tools as JSON-RPC errors',async()=>{
  const {result}=await rpc('tools/call',{name:'cards_get',arguments:{env:'default-workspace',number:999}});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/404 not_found: No card #999/);
  const {result:bad}=await rpc('tools/call',{name:'cards_move',arguments:{env:'default-workspace',number:'x',column:'doing'}});
  assert.equal(bad.isError,true);assert.match(bad.content[0].text,/number must be integer/);
  const {result:missing}=await rpc('tools/call',{name:'cards_move',arguments:{env:'default-workspace'}});
  assert.match(missing.content[0].text,/missing required arguments: number, column/);
  const {error}=await rpc('tools/call',{name:'nope',arguments:{}});
  assert.equal(error.code,-32602);
  const {error:m}=await rpc('prompts/get');
  assert.equal(m.code,-32601);
});

test('another user cannot reach a private environment',async()=>{
  const {result}=await rpc('tools/call',{name:'cards_list',arguments:{env:'default-workspace'}},{key:OTHER_KEY});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/404/);
});

test('resources: the guide and the OpenAPI document',async()=>{
  const {result}=await rpc('resources/list');
  assert.deepEqual(result.resources.map(r=>r.uri),['flow://docs/mcp-cli','flow://openapi.json']);
  const {result:doc}=await rpc('resources/read',{uri:'flow://openapi.json'});
  const spec=JSON.parse(doc.contents[0].text);
  assert.equal(spec.openapi,'3.1.0');assert.equal(spec.paths['/api/v1/envs/{env}/cards'].get.operationId,'cards.list');
  const {result:guide}=await rpc('resources/read',{uri:'flow://docs/mcp-cli'});
  assert.match(guide.contents[0].text,/claude mcp add --transport http/);
  const {error}=await rpc('resources/read',{uri:'flow://nope'});assert.equal(error.code,-32002);
});

test('auth: no key, a wrong key and a throwing authenticate are all 401',async()=>{
  for(const key of ['', 'flow_wrong']){
    const r=await post({jsonrpc:'2.0',id:1,method:'tools/list'},{key});
    assert.equal(r.status,401);assert.match(r.headers.get('www-authenticate'),/^Bearer/);
    const b=await r.json();assert.equal(b.error.code,-32001);assert.equal(b.result,undefined);
  }
  const r=await fetch(srv.url+'/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:'Basic abc'},body:'{}'});
  assert.equal(r.status,401);
});

test('transport: GET 405, bad JSON, wrong content type, foreign origin, batches',async()=>{
  assert.equal((await fetch(srv.url+'/mcp',{headers:{authorization:'Bearer '+KEY}})).status,405);
  const bad=await post('{nope');assert.equal(bad.status,400);assert.equal((await bad.json()).error.code,-32700);
  assert.equal((await fetch(srv.url+'/mcp',{method:'POST',headers:{authorization:'Bearer '+KEY,'content-type':'text/plain'},body:'{}'})).status,415);
  assert.equal((await post({jsonrpc:'2.0',id:1,method:'ping'},{headers:{origin:'https://evil.example'}})).status,403);
  assert.equal((await post({jsonrpc:'2.0',id:1,method:'ping'},{headers:{'mcp-protocol-version':'2000-01-01'}})).status,400);
  const batch=await(await post([{jsonrpc:'2.0',id:'a',method:'ping'},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:'b',method:'tools/list'}])).json();
  assert.deepEqual(batch.map(b=>b.id),['a','b']);
  const inv=await(await post({id:3,method:'ping'})).json();assert.equal(inv.error.code,-32600);
});

test('createMcp core and the OpenAPI round trip',async()=>{
  const mcp=createMcp({operations,call:async(op,args)=>({op:op.id,args})});
  assert.equal((await mcp.handle({jsonrpc:'2.0',id:1,method:'tools/list'})).result.tools.length,operations.length);
  assert.equal(await mcp.handle({jsonrpc:'2.0',method:'notifications/cancelled'}),undefined);
  // x-flow-operation keeps every registry field; a plain OpenAPI document still yields usable operations.
  const byId=list=>[...list].sort((a,b)=>a.id.localeCompare(b.id));
  const back=byId(operationsFrom(openapiFor(operations))),ops=byId(operations);
  assert.deepEqual(back.map(o=>[o.id,o.method,o.path,o.scope]),ops.map(o=>[o.id,o.method,o.path,o.scope]));
  assert.deepEqual(back.map(toolFor),ops.map(toolFor));
  const plain=JSON.parse(JSON.stringify(openapiFor(operations),(k,v)=>k==='x-flow-operation'?undefined:v));
  const move=operationsFrom(plain).find(o=>o.id==='cards.move');
  assert.deepEqual(Object.keys(move.input.properties).sort(),['column','env','number']);
  assert.deepEqual(move.input.required.sort(),['column','env','number']);
  assert.deepEqual(requestFor(move,{env:'a b',number:4,column:'doing'}),{method:'POST',path:'/api/v1/envs/a%20b/cards/4/move',query:'',body:{column:'doing'}});
  assert.deepEqual(requestFor(operations[0],{env:'e',project:'X',limit:2}),{method:'GET',path:'/api/v1/envs/e/cards',query:'?project=X&limit=2',body:undefined});
  assert.throws(()=>requestFor(move,{number:1}),e=>e.status===400);
});
