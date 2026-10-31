#!/usr/bin/env node
// DevLog registry for Bradshaw Versioning (public/devlog.json). Run by the release coordinator only,
// one at a time, after a push to main:
//   node tools/devlog.mjs status
//       commits on main (first parent) not yet recorded, with the version each would get
//   node tools/devlog.mjs record <sha> --at <ISO admission time> --compat compatible|action-required|breaking
//                                --note "what changed" [--note ...] [--action "what to do"]
//       records the next unrecorded commit (must be recorded in order). Then commit the registry:
//       that commit gets the next number itself and is recorded by the following update.
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url)),file=root+'public/devlog.json';
const git=(...a)=>execFileSync('git',a,{cwd:root,encoding:'utf8'}).trim();
const reg=JSON.parse(readFileSync(file,'utf8')),S=reg.scheme;
const fail=m=>{console.error(m);process.exit(1)};
// The public source starts from a clean root; earlier releases remain in the registry
// as private development history, without those commits in this repository.
const baseline=(()=>{try{git('merge-base','--is-ancestor',S.baselineCommit,'main');return S.baselineCommit}
  catch{return git('rev-list','--max-parents=0','main').split('\n')[0]}})();

// YEAR.MONTH.UPDATE: project year from the origin year (zero- or one-based per scheme.yearMode), calendar month, declared timezone.
function versionFor(atIso,last){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:S.timeZone,year:'numeric',month:'numeric'}).formatToParts(new Date(atIso));
  const y=+parts.find(p=>p.type==='year').value-S.originYear+(S.yearMode==='one-based'?1:0),m=+parts.find(p=>p.type==='month').value;
  const [ly,lm,lu]=(last||'0.0.0').split('.').map(Number);
  return `${y}.${m}.${ly===y&&lm===m?lu+1:1}`;
}
const recorded=new Set(reg.releases.map(r=>r.commit));
const pending=()=>git('rev-list','--reverse','--first-parent',`${baseline}..main`).split('\n').filter(c=>c&&!recorded.has(c));
const [cmd,sha,...rest]=process.argv.slice(2);
if(cmd==='status'){
  const p=pending();let last=reg.releases[0]?.version;
  if(!p.length)console.log('Every commit on main is recorded.');
  for(const c of p){last=versionFor(new Date().toISOString(),last);console.log(`${last}  ${c.slice(0,7)}  ${git('log','-1','--format=%s',c)}  (if admitted now)`)}
}else if(cmd==='record'){
  const opt=k=>{const v=[];for(let i=0;i<rest.length;i++)if(rest[i]===k)v.push(rest[++i]);return v};
  const full=git('rev-parse',sha||'');const next=pending()[0];
  if(full!==next)fail(`Record commits in order: the next unrecorded commit is ${next?.slice(0,7)||'(none)'}`);
  const at=opt('--at')[0],comp=opt('--compat')[0],notes=opt('--note'),action=opt('--action')[0];
  if(!at||Number.isNaN(Date.parse(at)))fail('--at <ISO admission time> is required (when the push reached main)');
  if(!['compatible','action-required','breaking'].includes(comp))fail('--compat compatible|action-required|breaking');
  if(!notes.length)fail('--note is required');
  if(comp!=='compatible'&&!action)fail('--action is required for action-required or breaking releases');
  const prev=reg.releases[0];
  if(prev&&Date.parse(at)<Date.parse(prev.admittedAt))fail('Admission is earlier than the last recorded release: reconcile explicitly instead of guessing.');
  const version=versionFor(at,prev?.version),subj=git('log','-1','--format=%s',full);
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:S.timeZone}).format(new Date(at));
  reg.releases.unshift({version,date,title:subj,notes,summary:notes[0],sourceSubject:subj,commit:full,author:{name:'Flow Contributors',githubLogin:null,avatarUrl:null,profileUrl:null},
    sequence:(prev?.sequence||0)+1,admittedAt:at,compatibility:comp,...(action?{action}:{}),deployments:[]});
  writeFileSync(file,JSON.stringify(reg,null,2));
  console.log(`Recorded ${full.slice(0,7)} as ${version}`);
}else if(cmd==='deploy'){
  // A deployment attempt for an already-recorded release (version identity stays separate).
  //   node tools/devlog.mjs deploy <sha> --id <provider deployment id> --status success|failed|removed --at <iso> [--env production] [--url ...]
  const opt=k=>{const i=rest.indexOf(k);return i>=0?rest[i+1]:undefined};
  const full=git('rev-parse',sha||''),e=reg.releases.find(r=>r.commit===full);
  if(!e)fail('Record the release first; deployments attach to a recorded version');
  const id=opt('--id'),status=opt('--status'),at=opt('--at');
  if(!id||!['success','failed','removed'].includes(status)||!at||Number.isNaN(Date.parse(at)))fail('--id, --status success|failed|removed and --at <iso> are required');
  if(e.deployments.some(x=>x.id===id))fail(`Deployment ${id} is already recorded for ${e.version}`);
  e.deployments.push({environment:opt('--env')||'production',provider:'railway',id,status,at,...(opt('--url')?{url:opt('--url')}:{}),evidence:'railway deployment list'});
  writeFileSync(file,JSON.stringify(reg,null,2));
  console.log(`Recorded deployment ${id} (${status}) for ${e.version}`);
}else fail('Usage: node tools/devlog.mjs status | record <sha> --at <iso> --compat <class> --note "..." | deploy <sha> --id <id> --status <s> --at <iso>');
