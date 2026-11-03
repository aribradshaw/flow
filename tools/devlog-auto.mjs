#!/usr/bin/env node
// Records every unrecorded commit on main in public/devlog.json, in order, with its real admission time.
// Run by .github/workflows/devlog.yml after each push to main; people do not run it or edit the registry.
//   GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo node tools/devlog-auto.mjs
// Admission time is when a push first brought the commit to main, read from GitHub's branch activity
// log (pushes, force pushes and PR merges). Commits in one push share it and are numbered parent first.
// If the log has not caught up yet, PUSHED_AT (the triggering push) or the current time is used.
// Release notes come from the commit: `DevLog-Note:` trailers (repeatable) or else the subject.
// `DevLog-Compat: action-required|breaking` with a `DevLog-Action:` trailer marks a non-compatible release.
// Prints the recorded versions; prints nothing when every commit is already recorded.
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const git=(...a)=>execFileSync('git',a,{cwd:root,encoding:'utf8'}).trim();
const ok=(...a)=>{try{execFileSync('git',a,{cwd:root,stdio:'ignore'});return true}catch{return false}};

// ISO time in the scheme's timezone with its numeric offset, e.g. 2026-11-02T16:57:13-07:00.
export function localIso(at,timeZone){
  const d=new Date(at),p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'longOffset'}).formatToParts(d).map(x=>[x.type,x.value]));
  const off=p.timeZoneName==='GMT'?'+00:00':p.timeZoneName.replace('GMT','');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}
// The earliest push whose resulting head contains the commit. pushes: [{at, after}] in any order.
export function admissionFor(commit,pushes,contains){
  for(const p of [...pushes].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)))if(contains(commit,p.after))return p.at;
  return null;
}
// Release fields from a commit's subject and trailers.
export function releaseFields(subject,trailers){
  const all=k=>trailers.filter(t=>t.key.toLowerCase()===k.toLowerCase()).map(t=>t.value.trim()).filter(Boolean);
  const notes=all('DevLog-Note'),compat=(all('DevLog-Compat')[0]||'compatible').toLowerCase(),action=all('DevLog-Action')[0];
  const note=s=>/[.!?]$/.test(s)?s:s+'.';
  return {notes:(notes.length?notes:[subject]).map(note),compat:['compatible','action-required','breaking'].includes(compat)?compat:'compatible',action};
}

async function pushes(repo,token){
  const out=[];let url=`https://api.github.com/repos/${repo}/activity?ref=refs/heads/main&per_page=100`;
  for(let page=0;url&&page<5;page++){
    const r=await fetch(url,{headers:{accept:'application/vnd.github+json',...(token?{authorization:`Bearer ${token}`}:{}),'x-github-api-version':'2022-11-28'}});
    if(!r.ok)throw Error(`GitHub activity log: HTTP ${r.status}`);
    for(const a of await r.json())if(a.after&&a.timestamp)out.push({at:a.timestamp,after:a.after});
    url=/<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link')||'')?.[1];
  }
  return out;
}

async function main(){
  const reg=()=>JSON.parse(readFileSync(root+'public/devlog.json','utf8'));
  const {scheme}=reg(),recorded=new Set(reg().releases.map(r=>r.commit));
  const pending=git('rev-list','--reverse','--first-parent',`${scheme.baselineCommit}..HEAD`).split('\n').filter(c=>c&&!recorded.has(c));
  if(!pending.length)return;
  const log=await pushes(process.env.GITHUB_REPOSITORY||'aribradshaw/flow',process.env.GITHUB_TOKEN);
  const contains=(c,after)=>ok('cat-file','-e',after+'^{commit}')&&ok('merge-base','--is-ancestor',c,after);
  const fallback=process.env.PUSHED_AT?new Date(/^\d+$/.test(process.env.PUSHED_AT)?+process.env.PUSHED_AT*1000:process.env.PUSHED_AT).toISOString():new Date().toISOString();
  for(const c of pending){
    const last=reg().releases[0]?.admittedAt;
    let at=admissionFor(c,log,contains)||fallback;
    if(last&&Date.parse(at)<Date.parse(last))at=last; // never earlier than the release before it
    const subject=git('log','-1','--format=%s',c);
    const trailers=git('log','-1','--format=%(trailers:only,unfold)',c).split('\n').map(l=>/^([\w-]+):\s*(.*)$/.exec(l)).filter(Boolean).map(m=>({key:m[1],value:m[2]}));
    const f=releaseFields(subject,trailers);
    const args=['tools/devlog.mjs','record',c,'--at',localIso(at,scheme.timeZone),'--compat',f.compat,...f.notes.flatMap(n=>['--note',n])];
    if(f.compat!=='compatible')args.push('--action',f.action||'See the release notes.');
    console.log(execFileSync(process.execPath,args,{cwd:root,encoding:'utf8'}).trim());
  }
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exit(1)});
