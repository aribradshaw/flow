#!/usr/bin/env node
// Copy a workspace into (or out of) a Flygon Flow server, as the owner, with FLOW_SYNC_TOKEN.
//   node tools/env.mjs push --env default-workspace --from data/<backup>.json --to https://flow.example.com [--merge | --replace]
//   node tools/env.mjs pull --env default-workspace --from https://flow.example.com --to backup.json
//   node tools/env.mjs status --env default-workspace --to https://flow.example.com
//   node tools/env.mjs environments --to <url>   |   archive <envId> --to <url>   (the owner's environments)
//   node tools/env.mjs invite <email> --to <url> [--resend] [--no-email]   |   invites --to <url>   |   revoke <email> --to <url>
//       app invites as the owner (same rules as Settings › Invite to Flow); the invite email is sent when
//       the server has email configured (--resend re-sends an existing invite, --no-email skips it)
//   node tools/env.mjs share --env default-workspace --person "Bo Marsh" --permission edit --email bo@… --to <url> [--dry-run]
//       share a person and everything below them (or exactly the cards given with repeated --node <name|id>,
//       --project <name|id>, --label <name|id>, --whole) with another Flow user; prints exactly what they
//       will see first (--dry-run stops there). Sharing the same thing again updates the permission.
//   node tools/env.mjs shares --env default-workspace --to <url>   |   unshare <share id> --to <url>
// push is idempotent: it does nothing when the server already holds the same data, uploads when the
// server is empty, and refuses to overwrite a server that has its own data unless --merge is given
// (then nothing is dropped: the file and the server copy are merged per entity and field) or
// --replace (the file wins; the server keeps the replaced revision in its history).
// The token is read from the environment or .env and never printed.
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {merge3,same,size} from '../public/sync-core.js';

try{process.loadEnvFile(fileURLToPath(new URL('../.env',import.meta.url)))}catch{}
const [cmd,...rest]=process.argv.slice(2);
const opt=k=>{const i=rest.indexOf('--'+k);return i>=0?rest[i+1]:undefined},flag=k=>rest.includes('--'+k);
const fail=m=>{console.error(m);process.exit(1)};
const token=process.env.FLOW_SYNC_TOKEN||'';
const env=opt('env')||'default-workspace';
if(!/^[A-Za-z0-9-]{1,64}$/.test(env))fail('--env: an environment id');
if(token.length<32)fail('Set FLOW_SYNC_TOKEN (at least 32 characters) in the environment or .env');
const base=(cmd==='pull'?opt('from'):opt('to'))?.replace(/\/+$/,'');
if(!base||!/^https?:\/\//.test(base))fail(`--${cmd==='pull'?'from':'to'} <server URL> is required`);
if(cmd==='environments'||cmd==='archive'){
  // environments: list the owner's environments. archive <envId>: hide one (its data is kept).
  const id=rest[0]&&!rest[0].startsWith('--')?rest[0]:'';
  if(cmd==='archive'&&!/^[A-Za-z0-9-]{1,64}$/.test(id))fail('Usage: node tools/env.mjs archive <envId> --to <url>');
  const r=await fetch(`${base}/api/environments${cmd==='archive'?'/'+id:''}`,{method:cmd==='archive'?'DELETE':'GET',headers:{authorization:'Bearer '+token}});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)fail(`The server answered ${r.status}: ${d.error||'no access'}`);
  if(cmd==='archive')console.log(`Archived ${id} (hidden; its data is kept on the server).`);
  else for(const e of d.environments)console.log(`${e.id}  ${e.name}  rev ${e.rev}  ${e.updatedAt}`);
  process.exit(0);
}
if(['invite','invites','revoke'].includes(cmd)){
  const email=rest[0]&&!rest[0].startsWith('--')?rest[0]:'';
  if(cmd!=='invites'&&!email)fail(`Usage: node tools/env.mjs ${cmd} <email> --to <url>`);
  const q=cmd==='revoke'?'?email='+encodeURIComponent(email):'';
  const r=await fetch(`${base}/api/invites${q}`,{method:cmd==='invite'?'POST':cmd==='revoke'?'DELETE':'GET',headers:{authorization:'Bearer '+token,...(cmd==='invite'?{'content-type':'application/json'}:{})},body:cmd==='invite'?JSON.stringify({email,...(flag('resend')?{resend:true}:{}),...(flag('no-email')?{send:false}:{})}):undefined});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)fail(`The server answered ${r.status}: ${d.error||'no access'}`);
  if(cmd==='invite')console.log(`${flag('resend')?'Re-sent the invite to':'Invited'} ${d.invite.email}: ${d.sent?'email sent':d.notConfigured?'email not configured on the server, nothing sent':flag('no-email')?'no email sent':'email NOT sent ('+d.emailError+')'}. They sign in at ${base} with OneProfileID using that address.`);
  else if(cmd==='revoke')console.log(`Revoked the invite for ${email}.`);
  else for(const i of d.invites)console.log(`${i.email}  ${i.revokedAt?'revoked':i.claimedAt?'joined '+i.claimedAt:'invited '+i.createdAt}`);
  process.exit(0);
}
if(['share','shares','unshare'].includes(cmd)){
  const call=(method,path,body)=>fetch(base+path,{method,headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body&&JSON.stringify(body)}).then(async r=>({status:r.status,data:await r.json().catch(()=>({}))}));
  const must=r=>{if(r.status!==200)fail(`The server answered ${r.status}: ${r.data.error||'no access'}`);return r.data};
  const show=(p,label)=>{
    console.log(`Shares: ${label}`);
    console.log(`  Cards (${p.nodes.length}): ${p.nodes.map(n=>n.name).join(', ')||'none'}`);
    console.log(`  Co-owner stubs, name only (${p.stubs.length}): ${p.stubs.map(t=>`${t.name} → ${t.owns}${t.percent?` ${t.percent}%`:t.edge==='group'?' (group)':''}`).join(', ')||'none'}`);
    console.log(`  Projects (${p.projects.length}): ${p.projects.map(x=>x.name).join(', ')||'none'}`);
    console.log(`  Timeline items: ${p.items.length} · DevOps cards: ${p.cards.length}`);
  };
  if(cmd==='unshare'){
    const id=rest[0]&&!rest[0].startsWith('--')?rest[0]:'';if(!/^[A-Za-z0-9-]{1,64}$/.test(id))fail('Usage: node tools/env.mjs unshare <share id> --to <url>');
    const d=must(await call('DELETE','/api/shares/'+id));console.log(`Revoked share ${id} (${d.share.recipientEmail}, ${d.share.scopeLabel}).`);process.exit(0);
  }
  if(cmd==='shares'){
    const d=must(await call('GET','/api/shares?env='+encodeURIComponent(env)));
    if(!d.shares.length)console.log(`${env}: not shared with anyone`);
    for(const s of d.shares)console.log(`${s.id}  ${s.recipientEmail}  ${s.permission}  ${s.scopeLabel}  (since ${s.createdAt})`);
    for(const r of d.requests)console.log(`request ${r.id}: ${r.requestedBy} asks to share with ${r.toEmail} (${r.permission})`);
    process.exit(0);
  }
  const email=opt('email'),permission=opt('permission')||'view';
  if(!email)fail('--email <recipient> is required');
  if(!['view','comment','edit'].includes(permission))fail('--permission view|comment|edit');
  const ws=must(await call('GET','/api/workspace?env='+encodeURIComponent(env))).data;
  if(!ws)fail(`${env} is empty on the server`);
  const nodes=ws.charts.flatMap(c=>c.nodes.map(n=>({...n,chart:c.name}))),lc=v=>String(v||'').trim().toLowerCase();
  const pick=(list,v,what)=>{const hits=list.filter(x=>x.id===v);const named=hits.length?hits:list.filter(x=>lc(x.name)===lc(v));
    if(!named.length)fail(`No ${what} called "${v}" in ${env}`);
    if(new Set(named.map(x=>x.id)).size>1)fail(`More than one ${what} is called "${v}":\n${named.map(x=>`  ${x.id}${x.chart?` (chart ${x.chart})`:''}`).join('\n')}\nPass its id instead.`);
    return named[0]};
  let scope;
  if(opt('person'))scope={kind:'person',nodeId:pick(nodes,opt('person'),'card').id};
  // --node may repeat: exactly those cards (no walk), e.g. when "everything below" a person reaches too far.
  else if(opt('node'))scope={kind:'nodes',nodeIds:[...new Set(rest.flatMap((a,i)=>a==='--node'&&rest[i+1]?[pick(nodes,rest[i+1],'card').id]:[]))]};
  else if(opt('project'))scope={kind:'project',projectId:pick(ws.projects||[],opt('project'),'project').id};
  else if(opt('label'))scope={kind:'label',label:pick(ws.devops?.labels||[],opt('label'),'label').id};
  else if(flag('whole'))scope={kind:'environment'};
  else fail('Say what to share: --person <name>, --node <name|id>, --project <name|id>, --label <name|id> or --whole');
  const pv=must(await call('POST','/api/shares/preview',{env,scope}));
  show(pv.preview,`${pv.label} → ${email} (${permission})`);
  if(flag('dry-run')){console.log('Dry run: nothing was shared.');process.exit(0)}
  const d=must(await call('POST','/api/shares',{env,recipientEmail:email,scope,permission}));
  console.log(`${d.existing?'Already shared; updated':'Shared'}: ${d.share.id} with ${d.share.recipientEmail} (${d.share.permission}). They add it from Settings › Sharing after signing in at ${base}.`);
  process.exit(0);
}
const api=(method,body)=>fetch(`${base}/api/workspace?env=${encodeURIComponent(env)}`,{method,headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},body:body&&JSON.stringify(body)})
  .then(async r=>({status:r.status,data:await r.json().catch(()=>({}))}));
const count=d=>`${size(d)} things (${(d?.charts||[]).reduce((s,c)=>s+c.nodes.length,0)} chart cards, ${d?.timeline?.length||0} timeline items, ${d?.devops?.cards?.length||0} DevOps cards)`;

const cur=await api('GET');
if(cur.status!==200)fail(`The server answered ${cur.status}: ${cur.data.error||'no access'}`);
if(cmd==='status'){console.log(cur.data.data?`${env}: revision ${cur.data.rev}, ${count(cur.data.data)}, updated ${cur.data.updatedAt}`:`${env}: empty on the server`);process.exit(0)}
if(cmd==='pull'){
  if(!cur.data.data)fail('The server has no data for this environment');
  const to=opt('to');if(!to)fail('--to <file> is required');
  writeFileSync(to,JSON.stringify(cur.data.data,null,2));console.log(`Saved revision ${cur.data.rev} (${count(cur.data.data)}) to ${to}`);process.exit(0);
}
if(cmd!=='push')fail('Usage: node tools/env.mjs push|pull|status --env <id> ...');
const from=opt('from');if(!from)fail('--from <workspace .json> is required');
let data;try{data=JSON.parse(readFileSync(from,'utf8'))}catch(e){fail(`Cannot read ${from}: ${e.message}`)}
if(!Array.isArray(data?.charts)||!data.charts.length)fail(`${from} is not a Flygon Flow workspace`);
data.environment={...(data.environment||{}),id:env};
const server=cur.data.data;
if(server&&same({...server,environment:undefined},{...data,environment:undefined})){console.log(`Already imported: the server's revision ${cur.data.rev} holds the same data. Nothing to do.`);process.exit(0)}
let body=data;
if(server){
  if(!flag('merge')&&!flag('replace'))fail(`The server already has ${env} at revision ${cur.data.rev} (${count(server)}). Not overwriting it.\nUse --merge to combine the file with it (nothing is dropped), --replace to replace it (the server keeps it in its history), or pull it first.`);
  if(flag('merge'))body=merge3(undefined,data,server);
}
const r=await api('PUT',{baseRev:cur.data.rev||0,data:body,...(flag('replace')?{allowShrink:true}:{})});
if(r.status!==200)fail(`The server refused the upload (${r.status}): ${r.data.error||''}`);
console.log(`Uploaded ${env} as revision ${r.data.rev}: ${count(body)}${server?flag('merge')?' (merged with the server copy)':' (replaced the server copy; the old one stays in the server history)':''}.`);
