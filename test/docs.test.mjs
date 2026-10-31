// tools/docs.mjs against a fixture registry: every operation reaches every output, output is
// deterministic, and --check catches stale or stray files.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,mkdirSync,writeFileSync,readFileSync,rmSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {build,sources,stale,write,mcpName,markdown,restCall} from '../tools/docs.mjs';

const repo=fileURLToPath(new URL('..',import.meta.url)),tool=join(repo,'tools/docs.mjs'),fixture=join(repo,'test/fixtures/docs-registry.mjs');
const {operations}=await import('./fixtures/docs-registry.mjs');
// A throwaway tree with the real sources (devlog, concepts, tokens) and no registry of its own.
function tree(){
  const d=mkdtempSync(join(tmpdir(),'flow-docs-'));
  mkdirSync(join(d,'public'));cpSync(join(repo,'public/devlog.json'),join(d,'public/devlog.json'));cpSync(join(repo,'public/style.css'),join(d,'public/style.css'));
  cpSync(join(repo,'docs/concepts'),join(d,'docs/concepts'),{recursive:true});
  return d;
}
const run=(root,...a)=>spawnSync(process.execPath,[tool,'--root',root,'--registry',fixture,...a],{encoding:'utf8'});

test('every operation appears in every output',async()=>{
  const files=build(await sources(repo,fixture));
  const pages=Object.keys(files).filter(f=>f.endsWith('.html'));
  for(const o of operations){
    for(const f of ['public/llms.txt','public/llms-full.txt','skills/flygon-flow/SKILL.md','docs/generated/api.md'])assert.ok(files[f].includes(o.id),`${o.id} missing from ${f}`);
    assert.ok(pages.some(f=>files[f].includes(`id="op-${o.id.replace(/\./g,'-')}"`)),`${o.id} has no section in the HTML docs`);
    assert.ok(files['public/docs/index.html'].includes(JSON.stringify(o.id)),`${o.id} missing from the search index`);
    assert.ok(files['skills/flygon-flow/SKILL.md'].includes(mcpName(o.id)));
  }
  // One page per tag; an untagged operation lands on "other"; a second tag lists the op there too.
  assert.deepEqual(pages.sort(),['public/docs/cards.html','public/docs/devops.html','public/docs/envs.html','public/docs/index.html','public/docs/other.html']);
  assert.ok(files['public/docs/devops.html'].includes('cards.move'));
});

test('concepts and the devlog version reach the outputs',async()=>{
  const src=await sources(repo,fixture),files=build(src);
  assert.ok(src.concepts.length>=8);
  for(const c of src.concepts){assert.ok(files['public/docs/index.html'].includes(`id="${c.slug}"`));assert.ok(files['public/llms.txt'].includes(c.title));assert.ok(files['public/llms-full.txt'].includes(c.title))}
  assert.ok(files['public/llms.txt'].includes(`Version ${src.releases[0].version}`));
  assert.match(files['skills/flygon-flow/SKILL.md'],/^---\nname: flygon-flow\ndescription: .+\n---\n/);
  assert.match(files['public/docs/docs.css'],/--flygon-green:#7cb980/);
});

test('output is deterministic',async()=>{
  const a=build(await sources(repo,fixture)),b=build(await sources(repo,fixture));
  assert.deepEqual(a,b);
  // Registry order is kept, so the same registry always yields the same bytes.
  assert.ok(a['docs/generated/api.md'].indexOf('cards.list')<a['docs/generated/api.md'].indexOf('cards.create'));
});

test('--check passes when fresh and fails on stale, missing or stray files',()=>{
  const d=tree();
  try{
    assert.equal(run(d,'--check').status,1,'nothing generated yet');
    assert.equal(run(d).status,0);
    const ok=run(d,'--check');assert.equal(ok.status,0,ok.stderr);
    const first=readFileSync(join(d,'public/llms.txt'),'utf8');assert.equal(run(d).status,0);assert.equal(readFileSync(join(d,'public/llms.txt'),'utf8'),first);
    // A concept edit makes the outputs stale.
    appendFileSync(join(d,'docs/concepts/02-chart.md'),'\nOne more line.\n');
    let r=run(d,'--check');assert.equal(r.status,1);assert.match(r.stderr,/public\/docs\/index\.html/);assert.match(r.stderr,/llms-full\.txt/);
    run(d);assert.equal(run(d,'--check').status,0);
    // A hand edit to an output, a deleted output and a stray file in public/docs are all caught.
    appendFileSync(join(d,'skills/flygon-flow/SKILL.md'),'hand edit');rmSync(join(d,'docs/generated/api.md'));writeFileSync(join(d,'public/docs/old.html'),'x');
    r=run(d,'--check');assert.equal(r.status,1);for(const f of ['SKILL.md','api.md','old.html'])assert.ok(r.stderr.includes(f),f);
    // Regenerating repairs all of it and removes the stray page.
    run(d);assert.equal(run(d,'--check').status,0);
    // A new operation in the registry makes the docs stale.
    const reg=join(d,'registry.mjs');writeFileSync(reg,`export * from ${JSON.stringify(fixture)};`);
    assert.equal(spawnSync(process.execPath,[tool,'--root',d,'--registry',reg,'--check']).status,0);
    writeFileSync(reg,`import {operations as o} from ${JSON.stringify(fixture)};export const operations=[...o,{id:'labels.list',method:'GET',path:'/api/v1/envs/{env}/labels',scope:'read',tags:['labels'],summary:'List labels.',input:null,output:null,examples:[]}];`);
    r=spawnSync(process.execPath,[tool,'--root',d,'--registry',reg,'--check'],{encoding:'utf8'});assert.equal(r.status,1);assert.match(r.stderr,/labels\.html/);
  }finally{rmSync(d,{recursive:true,force:true})}
});

test('stale() and write() in process',async()=>{
  const d=tree();
  try{const files=build(await sources(d,fixture));assert.equal(stale(d,files).length,Object.keys(files).length);write(d,files);assert.deepEqual(stale(d,files),[])}
  finally{rmSync(d,{recursive:true,force:true})}
});

test('a broken registry fails loudly',async()=>{
  const d=tree();
  try{
    const reg=join(d,'bad.mjs');writeFileSync(reg,`export const operations=[{id:'x',method:'GET',path:'/x',scope:'root'}];`);
    const r=spawnSync(process.execPath,[tool,'--root',d,'--registry',reg],{encoding:'utf8'});
    assert.notEqual(r.status,0);assert.match(r.stderr,/scope/);
  }finally{rmSync(d,{recursive:true,force:true})}
});

test('markdown and REST helpers escape and map input',()=>{
  assert.equal(markdown('Use `<b>` and [x](javascript:alert)'),'<p>Use <code>&lt;b&gt;</code> and <a href="#">x</a></p>');
  const [list,create]=operations;
  assert.match(restCall(list,{env:'demo',column:'doing'}),/GET "\$FLOW_URL\/api\/v1\/envs\/demo\/cards\?column=doing"/);
  const post=restCall(create,{env:'demo',title:"it's"});
  assert.match(post,/-d '\{"title":"it'\\''s"\}'/);assert.ok(!post.includes('"env"'));
});

test('the committed outputs in this repo are fresh',()=>{
  const r=spawnSync(process.execPath,[tool,'--check'],{cwd:repo,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
});
