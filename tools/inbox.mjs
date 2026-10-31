#!/usr/bin/env node
// Agent inbox CLI: drop a patch for the open Flygon Flow app to merge (format: README › Agent inbox).
//   node tools/inbox.mjs add <patch.json>   validate, fill id/createdAt if missing, queue it
//   node tools/inbox.mjs list               pending and applied patches
//   node tools/inbox.mjs check <patch.json> validate only
//   node tools/inbox.mjs requeue <id>       move an applied patch back to pending (re-applying is safe)
// INBOX_DIR overrides the folder (default: beside BACKUP_DIR when set, else ./inbox next to server.mjs).
import {readFileSync,writeFileSync,mkdirSync,readdirSync,renameSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {validatePatch} from '../public/inbox-core.js';

const dir=process.env.INBOX_DIR||(process.env.BACKUP_DIR?resolve(process.env.BACKUP_DIR,'..','inbox'):fileURLToPath(new URL('../inbox/',import.meta.url))),applied=join(dir,'applied');
const [cmd,arg]=process.argv.slice(2);
const fail=m=>{console.error(m);process.exit(1)};
const read=f=>{try{return JSON.parse(readFileSync(f,'utf8'))}catch(e){fail(`Cannot read ${f}: ${e.message}`)}};

if(cmd==='add'||cmd==='check'){
  if(!arg)fail('Usage: node tools/inbox.mjs add <patch.json>');
  const p=read(arg);
  p.id??=`${new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}-${randomUUID().slice(0,8)}`;
  p.createdAt??=new Date().toISOString();
  const errors=validatePatch(p);
  if(errors.length)fail('Invalid patch:\n- '+errors.join('\n- '));
  if(cmd==='check'){console.log(`Valid: ${p.ops.length} operation${p.ops.length===1?'':'s'}`);process.exit(0)}
  mkdirSync(dir,{recursive:true});
  const file=join(dir,p.id+'.json');
  if(existsSync(file)||existsSync(join(applied,p.id+'.json')))fail(`A patch with id ${p.id} already exists`);
  writeFileSync(file+'.tmp',JSON.stringify(p,null,2));renameSync(file+'.tmp',file);
  console.log(`Queued ${p.id}: ${p.ops.length} operation${p.ops.length===1?'':'s'} from ${p.source}. The open app merges it within about 20 seconds.`);
}else if(cmd==='list'){
  const show=(d,label)=>{let fs=[];try{fs=readdirSync(d).filter(f=>f.endsWith('.json'))}catch{}
    console.log(`${label} (${fs.length})`);for(const f of fs){const p=read(join(d,f));console.log(`  ${p.id}  ${p.createdAt}  ${p.source}  ${p.ops?.length} ops${p.appliedAt?`  applied ${p.appliedAt}`:''}`)}};
  show(dir,'Pending');show(applied,'Applied');
}else if(cmd==='requeue'){
  if(!arg)fail('Usage: node tools/inbox.mjs requeue <id>');
  const from=join(applied,arg+'.json');if(!existsSync(from))fail(`No applied patch ${arg}`);
  const p=read(from);delete p.appliedAt;delete p.appliedBy;writeFileSync(join(dir,arg+'.json'),JSON.stringify(p,null,2));
  renameSync(from,join(applied,`${arg}.requeued-${Date.now()}.json.bak`));console.log(`Requeued ${arg}`);
}else fail('Usage: node tools/inbox.mjs add|check|list|requeue …');
