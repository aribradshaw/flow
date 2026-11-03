#!/usr/bin/env node
// Self-updating docs. Everything below is generated from these sources and nothing else:
//   lib/registry.mjs (operations: id, method, path, scope, tags, summary, description, input, output, examples)
//   docs/concepts/*.md (hand-written concepts, ordered by file name)
//   public/style.css (design tokens)
// No version is embedded: releases are recorded per production deploy, so the docs point to
// GET /api/devlog instead of a number that would go stale.
// Outputs: public/docs/ (index.html, one page per tag, docs.css, docs.js), public/llms.txt,
// public/llms-full.txt, skills/flygon-flow/SKILL.md and docs/generated/api.md.
//   node tools/docs.mjs            regenerate (public/docs/ is wholly generated: stray files there are removed)
//   node tools/docs.mjs --check    exit 1 and list the stale files if any output differs from its sources
//   --registry <module>  --root <dir>   another registry or tree (tests use a fixture)
// Output is deterministic: no clocks, no randomness, sources read in a fixed order.
import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync,unlinkSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

// How agents reach an operation. Keep these in step with the API, MCP server and CLI.
export const BASE='$FLOW_URL';
const sq=s=>`'${String(s).replace(/'/g,"'\\''")}'`;
export const mcpName=id=>id.replace(/[^A-Za-z0-9_-]/g,'_');
// The `flow` CLI (tools/flow.mjs): one command per operation, words from its id (cards.list -> flow cards list).
const kebab=s=>String(s).replace(/[A-Z]/g,c=>'-'+c.toLowerCase()).replace(/_/g,'-');
export const cliLine=(id,input)=>`flow ${id.split('.').map(kebab).join(' ')}${input&&Object.keys(input).length?' --input '+sq(JSON.stringify(input)):''}`;
const DOCS='public/docs';

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const slug=s=>String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'section';
const json=v=>JSON.stringify(v,null,2);
const firstSentence=s=>String(s||'').replace(/\s+/g,' ').trim().split(/(?<=[.!?])\s/)[0];
const TAG_NAMES={cards:'DevOps cards',agents:'AgentFlow agents',workflows:'AgentFlow workflows',devops:'DevOps',charts:'MindMap charts',chart:'MindMap',timeline:'Timeline',projects:'Projects',labels:'Labels',envs:'Environments',environments:'Environments',inbox:'Agent inbox',sharing:'Sharing',keys:'API keys',workspace:'Workspace',other:'Other'};
const tagName=t=>TAG_NAMES[t]||t.replace(/(^|[-_])(\w)/g,(_,s,c)=>(s?' ':'')+c.toUpperCase());

// ---- sources ----
export async function loadRegistry(file){
  if(!existsSync(file))return {operations:[],missing:true};
  const m=await import(pathToFileURL(file).href);
  return {operations:checkOps(m.operations)};
}
function checkOps(ops){
  if(!Array.isArray(ops))throw Error('registry: operations must be an array');
  const seen=new Set();
  for(const o of ops){
    const where=`registry operation ${o?.id||'(no id)'}`;
    if(!o||typeof o.id!=='string'||!o.id)throw Error(`${where}: id is required`);
    if(seen.has(o.id))throw Error(`${where}: duplicate id`);seen.add(o.id);
    if(!['GET','POST','PATCH','PUT','DELETE'].includes(o.method))throw Error(`${where}: method`);
    if(typeof o.path!=='string'||!o.path.startsWith('/'))throw Error(`${where}: path`);
    if(!['read','write','admin'].includes(o.scope))throw Error(`${where}: scope read|write|admin`);
  }
  return ops;
}
export function loadConcepts(dir){
  if(!existsSync(dir))return [];
  return readdirSync(dir).filter(f=>f.endsWith('.md')).sort().map(f=>{
    const md=readFileSync(join(dir,f),'utf8').replace(/\r\n/g,'\n').trim(),title=/^#\s+(.+)$/m.exec(md)?.[1]||f;
    return {file:f,title,slug:slug(title),md,body:md.replace(/^#\s+.+\n+/,'')};
  });
}
// The app's design tokens: the first :root block of public/style.css.
export function loadTokens(file){try{return /:root\{[^}]*\}/.exec(readFileSync(file,'utf8'))?.[0]||''}catch{return ''}}

// ---- operations ----
const tagsOf=o=>o.tags?.length?o.tags:['other'];
export function groupByTag(ops){
  const g=new Map();
  for(const o of ops)for(const t of tagsOf(o)){if(!g.has(t))g.set(t,[]);g.get(t).push(o)}
  return g;
}
const anchor=o=>'op-'+slug(o.id);
const pageOf=o=>`${slug(tagsOf(o)[0])}.html`;
const params=path=>[...path.matchAll(/\{(\w+)\}/g)].map(m=>m[1]);
// REST call for an example: path parameters come from the input, the rest is the query (GET/DELETE) or the JSON body.
export function restCall(o,input={}){
  const p=params(o.path),rest=Object.fromEntries(Object.entries(input||{}).filter(([k])=>!p.includes(k)));
  const url=BASE+o.path.replace(/\{(\w+)\}/g,(_,k)=>input?.[k]!==undefined?encodeURIComponent(input[k]):`{${k}}`);
  const query=['GET','DELETE'].includes(o.method)&&Object.keys(rest).length?'?'+new URLSearchParams(Object.entries(rest).map(([k,v])=>[k,typeof v==='string'?v:Array.isArray(v)?v.join(','):JSON.stringify(v)])):'';
  const body=!['GET','DELETE'].includes(o.method)&&Object.keys(rest).length?JSON.stringify(rest):'';
  return `curl -sS -X ${o.method} "${url}${query}" \\\n  -H "Authorization: Bearer $FLOW_API_KEY"${body?` \\\n  -H 'Content-Type: application/json' \\\n  -d ${sq(body)}`:''}`;
}
// A schema as rows of {name, type, required, description} (one level of nesting is shown with dots).
export function fields(schema,prefix=''){
  if(!schema||schema.type!=='object'||!schema.properties)return [];
  const req=new Set(schema.required||[]);
  return Object.entries(schema.properties).flatMap(([k,s])=>{
    const name=prefix+k,row={name,type:typeOf(s),required:req.has(k),description:[s.description,s.enum&&`One of ${s.enum.map(v=>'`'+v+'`').join(', ')}.`].filter(Boolean).join(' ')};
    return [row,...(prefix?[]:fields(s.type==='array'?s.items:s,name+(s.type==='array'?'[].':'.')))];
  });
}
const typeOf=s=>!s?'any':s.type==='array'?`${typeOf(s.items)}[]`:Array.isArray(s.type)?s.type.join(' | '):s.type||(s.oneOf||s.anyOf?'union':s.enum?'enum':'any');

// ---- markdown (the small subset the concepts use) ----
function inline(s){
  const code=[];
  s=s.replace(/`([^`]+)`/g,(_,c)=>`\u0000${code.push(c)-1}\u0000`);
  s=esc(s).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g,'$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,(_,t,u)=>`<a href="${/^(https?:|\/|#|[\w-]+\.html)/.test(u.replace(/&amp;/g,'&'))?u:'#'}">${t}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g,(_,i)=>`<code>${esc(code[i])}</code>`);
}
export function markdown(md){
  const out=[],lines=md.replace(/\r\n/g,'\n').split('\n');
  for(let i=0;i<lines.length;){
    const l=lines[i];
    if(/^```/.test(l)){const lang=l.slice(3).trim(),b=[];i++;while(i<lines.length&&!/^```/.test(lines[i]))b.push(lines[i++]);i++;out.push(`<pre${lang?` data-lang="${esc(lang)}"`:''}><code>${esc(b.join('\n'))}</code></pre>`);continue}
    const h=/^(#{1,4})\s+(.+)$/.exec(l);
    if(h){const n=Math.min(6,h[1].length+1);out.push(`<h${n} id="${slug(h[2])}">${inline(h[2])}</h${n}>`);i++;continue}
    if(/^\|/.test(l)){
      const rows=[];while(i<lines.length&&/^\|/.test(lines[i]))rows.push(lines[i++]);
      const cells=r=>r.replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
      const body=rows.slice(2).map(r=>`<tr>${cells(r).map(c=>`<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${cells(rows[0]).map(c=>`<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`);continue;
    }
    if(/^[-*]\s/.test(l)){
      const items=[];while(i<lines.length&&/^([-*]\s|\s+\S)/.test(lines[i])){if(/^[-*]\s/.test(lines[i]))items.push(lines[i].slice(2));else items[items.length-1]+=' '+lines[i].trim();i++}
      out.push(`<ul>${items.map(t=>`<li>${inline(t)}</li>`).join('')}</ul>`);continue;
    }
    if(!l.trim()){i++;continue}
    const p=[];while(i<lines.length&&lines[i].trim()&&!/^(```|#{1,4}\s|\||[-*]\s)/.test(lines[i]))p.push(lines[i++].trim());
    out.push(`<p>${inline(p.join(' '))}</p>`);
  }
  return out.join('\n');
}

// ---- outputs ----
const intro='Flygon Flow keeps a MindMap (people, entities and ideas; called charts in the API), a product timeline, a DevOps board and AgentFlow (agents and workflows) in one workspace per environment. People use the web app. Agents use the same operations through the REST API, the MCP server or the CLI, authenticated with a personal API key (`flow_…`).';
// Where the current version and release notes live (the deployed server, not these files).
const RELEASES='Releases: `GET /api/devlog` on your Flow server (one per production deploy), also in the app under Settings › DevLog';

function opMarkdown(o,h='###'){
  const lines=[`${h} \`${o.id}\``,'',o.summary||'','',`\`${o.method} ${o.path}\` · scope \`${o.scope}\` · MCP tool \`${mcpName(o.id)}\``,''];
  if(o.description)lines.push(o.description,'');
  for(const [label,schema] of [['Input',o.input],['Output',o.output]]){
    const f=fields(schema);
    lines.push(`**${label}**${f.length?'':(schema?': see schema':': none')}`,'');
    if(f.length)lines.push('| Field | Type | Required | Description |','| --- | --- | --- | --- |',...f.map(r=>`| \`${r.name}\` | ${r.type} | ${r.required?'yes':''} | ${r.description.replace(/\|/g,'\\|')} |`),'');
  }
  for(const ex of o.examples||[]){
    lines.push(`**Example: ${ex.title||'call'}**`,'','```sh',restCall(o,ex.input),'```','');
    if(ex.output!==undefined)lines.push('```json',json(ex.output),'```','');
  }
  return lines.join('\n');
}
export function apiMarkdown(ops,{h='##'}={}){
  if(!ops.length)return 'The operation registry (`lib/registry.mjs`) is not part of this build yet. Run `node tools/docs.mjs` once it is.\n';
  const out=[];
  for(const [tag,list] of groupByTag(ops)){
    out.push(`${h} ${tagName(tag)}`,'');
    for(const o of list)out.push(opMarkdown(o,h+'#'));
  }
  return out.join('\n');
}
const restIntro=['Every operation is an HTTP call under the base URL of your Flow server:','','```sh','curl -sS "$FLOW_URL/api/v1/envs/$FLOW_ENV/cards" -H "Authorization: Bearer $FLOW_API_KEY"','```','',
  'Keys look like `flow_…` and carry a scope: `read` (list and get), `write` (create, update and move) or `admin` (keys, sharing and environments). The OpenAPI document is at `/api/v1/openapi.json`. Errors come back with an HTTP status plus a `code` and a `message`. Path parameters such as `{env}` are filled from the input. Any other input is sent as the query string for GET and DELETE, or as the JSON body otherwise.'].join('\n');

export function apiMd({ops}){
  return `<!-- Generated by tools/docs.mjs from lib/registry.mjs. Do not edit. -->\n# Flygon Flow API reference\n\n${ops.length} operations · ${RELEASES}.\n\n${restIntro}\n\n${apiMarkdown(ops)}`;
}

export function llmsTxt({ops,concepts}){
  const out=[`# Flygon Flow`,'',`> ${intro}`,'',`Base URL: your Flow server. Auth: \`Authorization: Bearer flow_…\`. OpenAPI: /api/v1/openapi.json. ${RELEASES}.`,'','## Concepts',''];
  for(const c of concepts)out.push(`- [${c.title}](/docs/index.html#${c.slug}): ${firstSentence(c.body)}`);
  for(const [tag,list] of groupByTag(ops)){
    out.push('',`## API: ${tagName(tag)}`,'');
    for(const o of list)out.push(`- [${o.id}](/docs/${slug(tag)}.html#${anchor(o)}): \`${o.method} ${o.path}\` (${o.scope}). ${o.summary||''}`.trimEnd());
  }
  out.push('','## Optional','','- [Full text for LLMs](/llms-full.txt): every concept and the whole API reference in one file','- [OpenAPI](/api/v1/openapi.json): machine-readable schema','');
  return out.join('\n');
}
export function llmsFull({ops,concepts}){
  return [`# Flygon Flow`,'',`> ${intro}`,'',`${RELEASES}.`,'','# Concepts','',
    ...concepts.map(c=>c.md.replace(/^# /,'## ').replace(/\n(#{2,3}) /g,'\n#$1 ')+'\n'),
    '# Using the API','',restIntro,'',apiMarkdown(ops),''].join('\n');
}

export function skillMd({ops}){
  const g=groupByTag(ops);
  const catalog=[...g].flatMap(([tag,list])=>[`### ${tagName(tag)}`,'','| Operation | MCP tool | REST | Scope | What it does |','| --- | --- | --- | --- | --- |',
    ...list.map(o=>`| \`${o.id}\` | \`${mcpName(o.id)}\` | \`${o.method} ${o.path}\` | ${o.scope} | ${(o.summary||'').replace(/\|/g,'\\|')} |`),'']);
  const examples=ops.filter(o=>o.examples?.length).map(o=>{const e=o.examples[0];return [`### ${e.title||o.id}`,'',`MCP: call \`${mcpName(o.id)}\` with \`${JSON.stringify(e.input??{})}\``,'','```sh',cliLine(o.id,e.input),'',restCall(o,e.input),'```',''].join('\n')});
  return `---
name: flygon-flow
description: Read and change a Flygon Flow workspace (MindMap charts, timeline, DevOps board, AgentFlow agents and workflows) through its MCP server, CLI or REST API. Use when asked to file, move or update DevOps cards, plan timeline items, or look up who owns what in Flow.
---
<!-- Generated by tools/docs.mjs from lib/registry.mjs. Do not edit. -->

# Using Flygon Flow

${intro}

## Setup

You need a Flow server URL, an environment id and a personal API key (\`flow_…\`), which you create in the app under Settings. Treat the key as a secret: read it from the environment and never print it or write it to a file.

- **MCP** (preferred when it is connected): every operation below is a tool named in the MCP tool column. The tool's input is the operation's input.
- **CLI**: \`flow <group> <command> --input '<input json>'\` (e.g. \`flow cards list\`), after \`flow login --url <server> --key <flow_…>\` or with \`FLOW_URL\` and \`FLOW_API_KEY\` set.
- **REST**: \`METHOD $FLOW_URL<path>\` with \`Authorization: Bearer $FLOW_API_KEY\`. OpenAPI is at \`/api/v1/openapi.json\`.

## Rules for agents

1. **Read before you write.** List or get the cards or items you are about to change, and match on \`#number\` or id, not on a title you guessed.
2. **Stay in one environment.** Workspace operations take \`env\`. A \`404\` means the environment does not exist or you cannot see it. Do not retry it under another id.
3. **Respect the gates.** Moving a card into \`done\`, out of \`done\`, or into \`doing\` without a developer needs an explicit confirmation or a developer. Ask a human before you confirm.
4. **Use the smallest scope** the task needs: \`read\` for questions, \`write\` for edits. \`admin\` is for keys, sharing and environments only.
5. **On a conflict** (\`409\`), read again and reapply your change. Never overwrite a human's newer edit.
6. Errors carry \`status\`, \`code\` and \`message\`. Report the \`message\` to the user rather than guessing.

## Operations (${ops.length})

${ops.length?catalog.join('\n'):'The operation registry is not part of this build yet.\n'}
## Examples

${examples.join('\n')||'No examples yet.\n'}
## More

- Concepts and the full reference: \`/docs/index.html\`, \`/llms-full.txt\`
- Offline batch edits a human can undo in one step: the agent inbox (\`node tools/inbox.mjs add patch.json\`)
`;
}

// ---- HTML ----
function page({title,nav,body,search,tokens,current}){
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Flygon Flow docs</title><link rel="icon" href="../favicon.svg"><link rel="stylesheet" href="docs.css">
<!-- Generated by tools/docs.mjs. Do not edit. -->
</head><body>
<header class="top"><a class="brand" href="index.html">Flygon Flow <span>docs</span></a><span class="sp"></span>
<input id="q" type="search" placeholder="Search docs and operations" aria-label="Search docs and operations" autocomplete="off"><a class="txt" href="../llms.txt">llms.txt</a><a class="txt" href="../">Open app</a></header>
<div class="wrap"><nav class="side" aria-label="Docs">${nav(current)}</nav>
<main id="main"><ol id="results" hidden></ol><div id="content">${body}</div></main></div>
<script type="application/json" id="search-index">${search.replace(/</g,'\\u003c')}</script>
<script src="docs.js"></script>
</body></html>
`;
}
function opHtml(o){
  const schema=(label,s)=>{const f=fields(s);return `<h4>${label}</h4>${f.length?`<table class="fields"><thead><tr><th>Field</th><th>Type</th><th></th><th>Description</th></tr></thead><tbody>${f.map(r=>`<tr><td><code>${esc(r.name)}</code></td><td>${esc(r.type)}</td><td>${r.required?'<span class="req">required</span>':''}</td><td>${inline(r.description)}</td></tr>`).join('')}</tbody></table>`:`<p class="muted">${s?'See the schema.':'None.'}</p>`}${s?`<details><summary>JSON Schema</summary><pre><code>${esc(json(s))}</code></pre></details>`:''}`};
  const ex=(o.examples||[]).map(e=>`<h4>Example: ${esc(e.title||'call')}</h4><pre><code>${esc(restCall(o,e.input))}</code></pre>${e.output!==undefined?`<pre class="out"><code>${esc(json(e.output))}</code></pre>`:''}`).join('');
  return `<section class="op" id="${anchor(o)}"><h3><code>${esc(o.id)}</code> <span class="scope s-${esc(o.scope)}">${esc(o.scope)}</span></h3>
<p class="route"><span class="m m-${esc(o.method.toLowerCase())}">${esc(o.method)}</span> <code>${esc(o.path)}</code> <span class="muted">MCP <code>${esc(mcpName(o.id))}</code></span></p>
${o.summary?`<p class="summary">${inline(o.summary)}</p>`:''}${o.description?markdown(o.description):''}${schema('Input',o.input)}${schema('Output',o.output)}${ex}</section>`;
}
export function htmlPages({ops,concepts,tokens}){
  const g=groupByTag(ops),files={};
  const search=JSON.stringify([
    ...concepts.map(c=>({t:c.title,k:'Concept',u:`index.html#${c.slug}`,s:firstSentence(c.body)})),
    ...[...g].flatMap(([tag,list])=>list.map(o=>({t:o.id,k:`${o.method} ${o.path}`,u:`${slug(tag)}.html#${anchor(o)}`,s:o.summary||''}))),
  ]);
  const nav=current=>`<a href="index.html"${current==='index'?' aria-current="page"':''}>Overview</a><h2>Concepts</h2>${concepts.map(c=>`<a href="index.html#${c.slug}">${esc(c.title)}</a>`).join('')}`
    +`<h2>API</h2>${[...g].map(([tag,list])=>`<a href="${slug(tag)}.html"${current===tag?' aria-current="page"':''}>${esc(tagName(tag))} <span class="n">${list.length}</span></a>`).join('')||'<p class="muted">Registry not built yet.</p>'}`;
  const index=`<h1>Flygon Flow</h1><p class="lead">${inline(intro)}</p>
<h2 id="api">Using the API</h2>${markdown(restIntro)}
<div class="cards">${[...g].map(([tag,list])=>`<a class="tagcard" href="${slug(tag)}.html"><strong>${esc(tagName(tag))}</strong><span>${list.length} operation${list.length===1?'':'s'}</span></a>`).join('')}</div>
${concepts.map(c=>`<section class="concept" id="${c.slug}"><h2>${esc(c.title)}</h2>${markdown(c.body)}</section>`).join('\n')}
<h2 id="releases">Releases</h2><p>Each production deploy records one release, listing the commits it brought. Read them in the app under Settings › DevLog, or from <code>GET /api/devlog</code> on your Flow server.</p>`;
  files[`${DOCS}/index.html`]=page({title:'Overview',nav,body:index,search,tokens,current:'index'});
  for(const [tag,list] of g)files[`${DOCS}/${slug(tag)}.html`]=page({title:tagName(tag),nav,search,tokens,current:tag,
    body:`<h1>${esc(tagName(tag))}</h1><ul class="toc">${list.map(o=>`<li><a href="#${anchor(o)}"><code>${esc(o.id)}</code></a> ${esc(o.summary||'')}</li>`).join('')}</ul>${list.map(opHtml).join('\n')}`});
  files[`${DOCS}/docs.css`]=css(tokens);
  files[`${DOCS}/docs.js`]=SEARCH_JS;
  return files;
}
const css=tokens=>`/* Generated by tools/docs.mjs: the app's tokens (public/style.css :root) plus docs layout. */
${tokens||':root{--ink:#1d2725;--muted:#66726e;--line:#e3e7e5;--bg:#f6f7f6;--accent:#324b34;--accent-2:#eef7e6;--accent-line:#7cb980;--r:4px}'}
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 'Segoe UI',system-ui,sans-serif;color:var(--ink);background:var(--bg)}
a{color:var(--accent)}
code{font:12.5px/1.5 ui-monospace,Consolas,monospace;background:var(--hover,#eef1ef);padding:1px 4px;border-radius:3px}
pre{background:#1f2927;color:#eef3f1;padding:10px 12px;border-radius:var(--r);overflow:auto}
pre code{background:none;padding:0;color:inherit}
pre.out{background:#fff;color:var(--ink);border:1px solid var(--line)}
.top{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;height:48px;padding:0 16px;background:#fff;border-bottom:1px solid var(--line)}
.brand{font-weight:700;text-decoration:none;color:var(--ink)}.brand span{color:var(--accent-line)}
.sp{flex:1}
#q{width:min(320px,40vw);height:30px;padding:0 10px;border:1px solid var(--line2,#ccd4d1);border-radius:var(--r);font:inherit}
.txt{padding:4px 9px;border:1px solid var(--line2,#ccd4d1);border-radius:var(--r);font-size:12px;font-weight:600;text-decoration:none;color:var(--ink);background:#fff}
.wrap{display:flex;max-width:1180px;margin:0 auto}
.side{position:sticky;top:48px;align-self:flex-start;width:220px;max-height:calc(100vh - 48px);overflow:auto;padding:16px 12px;flex:none}
.side h2{margin:14px 0 4px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.side a{display:flex;justify-content:space-between;padding:3px 8px;border-radius:var(--r);text-decoration:none;color:var(--ink)}
.side a:hover{background:var(--hover,#eef1ef)}.side a[aria-current]{background:var(--accent-2);color:var(--accent);font-weight:600}
.n{color:var(--muted);font-size:12px}
main{flex:1;min-width:0;padding:16px 28px 64px;background:#fff;border-left:1px solid var(--line);border-right:1px solid var(--line);min-height:calc(100vh - 48px)}
h1{margin:.4em 0}h2{margin-top:1.8em;padding-bottom:4px;border-bottom:1px solid var(--line)}
.lead{font-size:15px;color:var(--muted)}.muted{color:var(--muted)}
table{border-collapse:collapse;margin:8px 0;width:100%}th,td{text-align:left;vertical-align:top;padding:5px 8px;border-bottom:1px solid var(--line)}th{font-size:12px;color:var(--muted)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;margin:12px 0}
.tagcard{display:flex;flex-direction:column;padding:10px 12px;border:1px solid var(--line);border-radius:var(--r);text-decoration:none;color:var(--ink)}
.tagcard:hover{border-color:var(--accent-line);background:var(--accent-2)}.tagcard span{font-size:12px;color:var(--muted)}
.op{margin:28px 0;padding-top:12px;border-top:1px solid var(--line)}.op h3{margin:0}
.route{margin:4px 0}.m{display:inline-block;min-width:54px;padding:0 6px;border-radius:3px;font:700 11px/20px ui-monospace,monospace;text-align:center;background:var(--accent-2);color:var(--accent)}
.m-post{background:#cfe4ff;color:#174f91}.m-patch{background:#fff0a8;color:#614b00}.m-delete{background:#fdd5d2;color:#8e1f17}
.scope{font:600 11px/18px 'Segoe UI',sans-serif;padding:0 6px;border-radius:9px;background:var(--hover,#eef1ef);color:var(--muted);vertical-align:middle}
.s-write{background:#ffe2bd;color:#7a3d00}.s-admin{background:#fdd5d2;color:#8e1f17}
.req{font-size:11px;color:var(--primary,#a8524c);font-weight:600}
details summary{cursor:pointer;color:var(--muted);font-size:12px}
#results{margin:0 0 16px;padding:0;list-style:none}#results li a{display:block;padding:8px 10px;border-bottom:1px solid var(--line);text-decoration:none;color:var(--ink)}
#results li a:hover,#results li a.on{background:var(--accent-2)}#results small{display:block;color:var(--muted)}
:target{scroll-margin-top:60px}
@media (max-width:760px){.side{display:none}main{padding:12px 16px}}
`;
const SEARCH_JS=`// Generated by tools/docs.mjs. Client-side search over the index embedded in each page.
(()=>{
  const index=JSON.parse(document.getElementById('search-index').textContent),q=document.getElementById('q'),list=document.getElementById('results'),content=document.getElementById('content');
  const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
  function run(){
    const terms=q.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    if(!terms.length){list.hidden=true;content.hidden=false;return}
    const hits=index.filter(e=>{const h=(e.t+' '+e.k+' '+e.s).toLowerCase();return terms.every(t=>h.includes(t))});
    list.innerHTML=hits.length?hits.map(e=>'<li><a href="'+esc(e.u)+'"><strong>'+esc(e.t)+'</strong> <span class="muted">'+esc(e.k)+'</span><small>'+esc(e.s)+'</small></a></li>').join(''):'<li class="muted">No matches.</li>';
    list.hidden=false;content.hidden=true;
  }
  q.addEventListener('input',run);
  q.addEventListener('keydown',e=>{if(e.key==='Enter'){const a=list.querySelector('a');if(a)location.href=a.href}if(e.key==='Escape'){q.value='';run()}});
  addEventListener('keydown',e=>{if(e.key==='/'&&document.activeElement!==q){e.preventDefault();q.focus()}});
  list.addEventListener('click',()=>{q.value='';run()});
})();
`;

// Every output, keyed by its path relative to the root.
export function build(src){
  const ops=src.operations||[],concepts=src.concepts||[],args={ops,concepts,tokens:src.tokens||''};
  return {...htmlPages(args),'public/llms.txt':llmsTxt(args),'public/llms-full.txt':llmsFull(args),'skills/flygon-flow/SKILL.md':skillMd(args),'docs/generated/api.md':apiMd(args)};
}
export async function sources(root,registry=join(root,'lib/registry.mjs')){
  const reg=await loadRegistry(resolve(root,registry));
  return {operations:reg.operations,missing:reg.missing,concepts:loadConcepts(join(root,'docs/concepts')),tokens:loadTokens(join(root,'public/style.css'))};
}
// Files that differ from what the sources produce, plus stray files in the generated docs folder.
export function stale(root,files){
  const out=Object.entries(files).filter(([f,body])=>{try{return readFileSync(join(root,f),'utf8')!==body}catch{return true}}).map(([f])=>f);
  try{for(const f of readdirSync(join(root,DOCS)).sort())if(!files[`${DOCS}/${f}`])out.push(`${DOCS}/${f}`)}catch{}
  return out;
}
export function write(root,files){
  for(const [f,body] of Object.entries(files)){mkdirSync(dirname(join(root,f)),{recursive:true});writeFileSync(join(root,f),body)}
  try{for(const f of readdirSync(join(root,DOCS)))if(!files[`${DOCS}/${f}`])unlinkSync(join(root,DOCS,f))}catch{}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const a=process.argv.slice(2),opt=k=>{const i=a.indexOf('--'+k);return i>=0?a[i+1]:undefined};
  const root=resolve(opt('root')||fileURLToPath(new URL('..',import.meta.url)));
  const src=await sources(root,opt('registry'));
  if(src.missing)console.warn('docs: lib/registry.mjs not found; the API sections say so until it exists.');
  const files=build(src),bad=stale(root,files);
  if(a.includes('--check')){
    if(bad.length){console.error(`Generated docs are stale. Run: node tools/docs.mjs\n- ${bad.join('\n- ')}`);process.exit(1)}
    console.log(`Docs are up to date (${Object.keys(files).length} files, ${src.operations.length} operations).`);
  }else{write(root,files);console.log(`Wrote ${Object.keys(files).length} files (${bad.length} changed, ${src.operations.length} operations).`)}
}
