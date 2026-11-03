// DevLog list rules shared by the server (GET /api/devlog) and the browser's static-file fallback.
// No DOM and no imports, so Node can test it. Releases recorded per production deploy (Postgres)
// come first, then the frozen history in public/devlog.json, newest first and one row per commit.
export const DEVLOG_PAGE=10;
const COMPAT=['compatible','action-required','breaking'];
const parts=v=>String(v||'').split('.').map(n=>parseInt(n,10)||0);
// Newest first by YEAR.MONTH.UPDATE.
export function compareVersions(a,b){const x=parts(a),y=parts(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return (y[i]||0)-(x[i]||0);return 0}
const commitsOf=list=>Array.isArray(list)?list.filter(c=>c&&typeof c.sha==='string').map(c=>({sha:c.sha,subject:String(c.subject||'')})):[];
// One release in the shape the DevLog view renders. Deploy releases carry includedCommits; file entries do not.
export function devlogEntry(r){
  return {version:r.version,date:r.date,title:r.title,...(r.summary?{summary:r.summary}:{}),notes:Array.isArray(r.notes)?r.notes:[],commit:r.commit||null,
    compatibility:COMPAT.includes(r.compatibility)?r.compatibility:'compatible',...(r.action?{action:r.action}:{}),commits:commitsOf(r.includedCommits)};
}
// Deploy releases plus the file history, without a version or commit shown twice.
export function mergeReleases(deployed=[],history=[]){
  const shas=new Set(),versions=new Set(),out=[];
  for(const r of deployed){
    if(!r?.version||versions.has(r.version))continue;
    versions.add(r.version);if(r.commit)shas.add(r.commit);for(const c of r.includedCommits||[])if(c?.sha)shas.add(c.sha);
    out.push(devlogEntry(r));
  }
  for(const r of history){
    if(!r?.version||versions.has(r.version)||(r.commit&&shas.has(r.commit)))continue;
    versions.add(r.version);if(r.commit)shas.add(r.commit);
    out.push(devlogEntry(r));
  }
  return out.sort((a,b)=>compareVersions(a.version,b.version));
}
// One page of releases. Every search word must appear in the version, title, notes, commits or SHA.
export function devlogPage(all,{page=1,q='',repository='',scheme=null}={}){
  const query=String(q||'').trim().toLowerCase().slice(0,100);
  const hits=query?all.filter(e=>{const hay=[e.version,e.title,e.summary,...(e.notes||[]),e.commit,...(e.commits||[]).flatMap(c=>[c.sha,c.subject])].join(' ').toLowerCase();return query.split(/\s+/).every(w=>hay.includes(w))}):all;
  const pages=Math.max(1,Math.ceil(hits.length/DEVLOG_PAGE)),p=Math.min(pages,Math.max(1,parseInt(page)||1)),top=all[0];
  return {current:top?.version||'',latest:top?{version:top.version,date:top.date,title:top.title}:null,total:hits.length,page:p,pages,
    repository:repository||'',scheme,entries:hits.slice((p-1)*DEVLOG_PAGE,p*DEVLOG_PAGE)};
}
// The public parts of the registry's scheme.
export const schemeOf=s=>s?{name:s.name,yearMode:s.yearMode,originYear:s.originYear,timeZone:s.timeZone}:null;
