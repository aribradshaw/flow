// tools/env.mjs push targets the environment it was told, or the one the file came from, never
// default-workspace by accident; and lib/opid-sso-client.cjs safeReturnTo stays on this site (card #678).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const ROOT=fileURLToPath(new URL('..',import.meta.url)),TOKEN='t'.repeat(40);

async function pushWith(args,fileEnv){
  const hits=[];
  const srv=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c).on('end',()=>{hits.push({method:req.method,env:new URL(req.url,'http://x').searchParams.get('env')});
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(req.method==='GET'?{rev:0,data:null}:{ok:true,rev:1}))})});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const dir=mkdtempSync(join(tmpdir(),'env-tool-')),file=join(dir,'w.json');
  writeFileSync(file,JSON.stringify({charts:[{id:'c',name:'C',nodes:[],edges:[]}],active:'c',...(fileEnv?{environment:{id:fileEnv}}:{})}));
  const out=await new Promise(r=>execFile(process.execPath,[ENV_TOOL,'push','--from',file,'--to',`http://127.0.0.1:${srv.address().port}`,...args],
    {cwd:dir,env:{...process.env,FLOW_SYNC_TOKEN:TOKEN}},(e,o,er)=>r({code:e?e.code||1:0,out:o+er})));
  srv.close();rmSync(dir,{recursive:true,force:true});return {...out,envs:[...new Set(hits.map(h=>h.env))]};
}
const ENV_TOOL=join(ROOT,'tools/env.mjs');

test('push without --env goes to the environment the file came from',async()=>{
  const r=await pushWith([],'team-a');assert.deepEqual(r.envs,['team-a'],r.out);
});
test('push with --env goes there, and says so when the file came from elsewhere',async()=>{
  const r=await pushWith(['--env','team-b'],'team-a');assert.deepEqual(r.envs,['team-b'],r.out);assert.match(r.out,/pulled from team-a; pushing it to team-b/);
});
test('a flag after --env is not taken as its value',async()=>{
  const r=await pushWith(['--env','--merge'],'team-a');assert.deepEqual(r.envs,['team-a'],r.out);
});
test('a file with no environment id still defaults to default-workspace',async()=>{
  const r=await pushWith([],'');assert.deepEqual(r.envs,['default-workspace'],r.out);
});
test('safeReturnTo never returns a path that leaves the site',()=>{
  const {safeReturnTo}=createRequire(import.meta.url)('../lib/opid-sso-client.cjs');
  for(const v of ['/..//evil.com','/.//evil.com','/%2e%2e//evil.com','//evil.com','https://evil.com','/\\evil.com'])assert.equal(safeReturnTo(v),'/',v);
  assert.equal(safeReturnTo('/board?x=1#k'),'/board?x=1#k');
});
