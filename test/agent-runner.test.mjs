// The reference runner's job discovery: schedule parsers, repo cron configs, filters, and the
// jobs field on runners.report (with the fallback for servers that do not take it yet); and remote
// (SSH) discovery of a Windows machine: Task Scheduler, Aside, Claude desktop and Codex, with
// synthetic samples in the shapes the remote scripts send.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {humaniseOnCalendar,humaniseMonotonic,humaniseDuration,humaniseCron,nextCron,parseCron,vercelJobs,railwayJobs,railwayConfig,
  workflowCrons,workflowJobs,crontabJobs,isDistroTimer,filterJobs,matches,redact,aiCommand,commandName,parseShow,parseTimerList,
  systemdJob,t3Schedule,dayPhrase,jobsTable,discoverJobs,parseRRule,rruleNext,humaniseRRule,isoDuration,humaniseWinTrigger,humaniseWinTriggers,
  isVendorTask,winStatus,windowsJobs,asideJobs,claudeTasks,claudeJobs,skillSummary,parseToml,codexJobs,remotePlan,remoteJobs,repoFileJobs,
  psScript,pyScript,wallOf,wallToMs} from '../tools/agent-runner.mjs';
import {spawnSync} from 'node:child_process';

const RUNNER=fileURLToPath(new URL('../tools/agent-runner.mjs',import.meta.url));
const NOW=new Date('2026-11-01T12:00:00Z');

test('OnCalendar expressions read as text',()=>{
  const cases={
    '*-*-* 22:30:00':'Daily 22:30',
    '*-*-* 22:30':'Daily 22:30',
    'Sat *-*-* 23:30:00':'Saturdays 23:30',
    'Sat *-*-01..07 20:00:00':'First Saturday monthly 20:00',
    'Mon *-*-15..21 09:00:00':'Third Monday monthly 09:00',
    'Mon..Fri *-*-* 09:00:00':'Weekdays 09:00',
    'Sat,Sun *-*-* 10:00:00':'Weekends 10:00',
    'Mon,Wed *-*-* 08:15:00':'Mon, Wed 08:15',
    'Tue..Thu *-*-* 07:00:00':'Tue-Thu 07:00',
    '*-*-01 03:00:00':'Monthly on day 1 03:00',
    '*-*-* 06,18:00:00':'Daily 06:00, 18:00',
    '*-*-* *:00:00':'Hourly',
    '*-*-* *:15:00':'Hourly at :15',
    '*-*-* *:0/15:00':'Every 15 min',
    '*-*-* *:00,15,30,45:00':'Every 15 min',
    '*-*-* *:*:00':'Every minute',
    '*-*-* 0/2:00:00':'Every 2 h',
    'Mon..Fri *-*-* *:0/30:00':'Weekdays, every 30 min',
    '*-*-* 22:30:00 UTC':'Daily 22:30 UTC',
    '*-*-* 05:00:00 America/Phoenix':'Daily 05:00 America/Phoenix',
    daily:'Daily 00:00',weekly:'Mondays 00:00',hourly:'Hourly',monthly:'Monthly on day 1 00:00',
  };
  for(const [spec,want] of Object.entries(cases))assert.equal(humaniseOnCalendar(spec),want,spec);
  // Anything it cannot say plainly comes back as written.
  for(const spec of ['2026-12-25 08:00:00','*-*-* 10:00:30','*-02-* 01:00:00','Mon *-*~01 04:00:00'])assert.equal(humaniseOnCalendar(spec),spec);
});

test('monotonic timers and durations',()=>{
  assert.equal(humaniseMonotonic([['OnUnitActiveUSec','5min'],['OnBootUSec','2min']]),'Every 5 min');
  assert.equal(humaniseMonotonic([['OnUnitActiveSec','5min']]),'Every 5 min');
  assert.equal(humaniseMonotonic([['OnUnitInactiveUSec','1h']]),'Every hour');
  assert.equal(humaniseMonotonic([['OnUnitActiveUSec','1d']]),'Every day');
  assert.equal(humaniseMonotonic([['OnUnitActiveUSec','1h 30min']]),'Every 1 h 30 min');
  assert.equal(humaniseMonotonic([['OnBootUSec','15min']]),'15 min after boot');
  assert.equal(humaniseDuration('2w'),'2 weeks');
});

test('cron expressions read as text',()=>{
  const cases={
    '*/5 * * * *':'Every 5 min',
    '* * * * *':'Every minute',
    '0 22 * * *':'Daily 22:00',
    '30 23 * * 6':'Saturdays 23:30',
    '0 9 * * 1-5':'Weekdays 09:00',
    '0 9 * * MON-FRI':'Weekdays 09:00',
    '0 10 * * 0,6':'Weekends 10:00',
    '0 10 * * 7':'Sundays 10:00',
    '0 8 * * 1,3':'Mon, Wed 08:00',
    '0 14 * * 2-5':'Tue-Fri 14:00',
    '0 * * * *':'Hourly',
    '15 * * * *':'Hourly at :15',
    '8,23,38,53 * * * *':'Hourly at :08, :23, :38, :53',
    '4-59/5 * * * *':'Every 5 min from :04',
    '0 */6 * * *':'Every 6 h',
    '23 */6 * * *':'Every 6 h at :23',
    '0 3 1 * *':'Monthly on day 1 03:00',
    '0 6,18 * * *':'Daily 06:00, 18:00',
    '@daily':'Daily 00:00',
    '@weekly':'Sundays 00:00',
    '@hourly':'Hourly',
    '@reboot':'At boot',
  };
  for(const [expr,want] of Object.entries(cases))assert.equal(humaniseCron(expr),want,expr);
  assert.equal(humaniseCron('0 22 * * *',{utc:true}),'Daily 22:00 UTC');
  assert.equal(humaniseCron('*/5 * * * *',{utc:true}),'Every 5 min');
  // Day of month and day of week together (either matches), months, and junk fall back to the expression.
  assert.equal(humaniseCron('0 20 1-7 * 6'),'cron 0 20 1-7 * 6');
  assert.equal(humaniseCron('0 0 1 1 *'),'cron 0 0 1 1 *');
  assert.equal(humaniseCron('not a cron'),'cron not a cron');
  assert.equal(parseCron('61 * * * *'),null);
  assert.equal(parseCron('* * * *'),null);
});

test('next run from a cron expression',()=>{
  assert.equal(nextCron('*/5 * * * *',new Date('2026-11-01T12:03:20Z'),{utc:true}),'2026-11-01T12:05:00.000Z');
  assert.equal(nextCron('*/5 * * * *',new Date('2026-11-01T12:05:00Z'),{utc:true}),'2026-11-01T12:10:00.000Z');
  assert.equal(nextCron('0 22 * * *',NOW,{utc:true}),'2026-11-01T22:00:00.000Z');
  assert.equal(nextCron('0 9 * * *',NOW,{utc:true}),'2026-11-02T09:00:00.000Z');
  assert.equal(nextCron('30 23 * * 6',NOW,{utc:true}),'2026-11-07T23:30:00.000Z');  // 1 Nov 2026 is a Sunday
  assert.equal(nextCron('0 9 * * 1-5',new Date('2026-11-06T10:00:00Z'),{utc:true}),'2026-11-09T09:00:00.000Z');
  assert.equal(nextCron('0 0 1 * *',NOW,{utc:true}),'2026-12-01T00:00:00.000Z');
  assert.equal(nextCron('0 0 29 2 *',NOW,{utc:true}),'2028-02-29T00:00:00.000Z');
  // Both day fields set: either one matches (the 15th, or any Monday).
  assert.equal(nextCron('0 12 15 * 1',NOW,{utc:true}),'2026-11-02T12:00:00.000Z');
  assert.equal(nextCron('0 0 31 2 *',NOW,{utc:true}),null);
  assert.equal(nextCron('@reboot',NOW),null);
});

test('vercel.json crons',()=>{
  const jobs=vercelJobs(JSON.stringify({crons:[{path:'/api/cron/digest',schedule:'0 14 * * *'},{path:'/api/sync',schedule:'*/5 * * * *'},{path:'/bad'}]}),{repo:'shop',now:NOW});
  assert.equal(jobs.length,2);
  assert.deepEqual(jobs[0],{id:'vercel:shop:/api/cron/digest',name:'/api/cron/digest',source:'vercel',group:'Vercel · shop',command:'GET /api/cron/digest',
    schedule:'Daily 14:00 UTC',cron:'0 14 * * *',ai:false,enabled:true,lastStatus:'unknown',nextRun:'2026-11-01T14:00:00.000Z'});
  assert.equal(jobs[1].schedule,'Every 5 min');
  assert.deepEqual(vercelJobs('{"framework":"nextjs"}',{repo:'x'}),[]);
  assert.deepEqual(vercelJobs('not json',{repo:'x'}),[]);
});

test('railway.json and railway.toml cronSchedule',()=>{
  const json=JSON.stringify({$schema:'https://railway.com/railway.schema.json',deploy:{startCommand:'node run.mjs',cronSchedule:'*/5 * * * *',restartPolicyType:'NEVER'}});
  const [j]=railwayJobs(json,{repo:'votes',service:'publisher',file:'services/publisher/railway.json',now:NOW});
  assert.equal(j.id,'railway:votes:services/publisher/railway.json');
  assert.equal(j.group,'Railway · publisher');assert.equal(j.schedule,'Every 5 min');assert.equal(j.command,'node run.mjs');assert.equal(j.cron,'*/5 * * * *');
  const toml=`[build]\nbuilder = "NIXPACKS"\n\n[deploy]\nstartCommand = "npm run nightly"  # the job\ncronSchedule = "0 22 * * *"\n`;
  assert.deepEqual(railwayConfig(toml,true),{startCommand:'npm run nightly',cronSchedule:'0 22 * * *'});
  assert.equal(railwayJobs(toml,{repo:'r',service:'r',file:'railway.toml',toml:true,now:NOW})[0].schedule,'Daily 22:00 UTC');
  assert.deepEqual(railwayJobs(JSON.stringify({deploy:{startCommand:'npm start'}}),{repo:'r',service:'r',file:'railway.json'}),[]);
  assert.deepEqual(railwayJobs('[deploy]\nstartCommand = "x"\n',{repo:'r',service:'r',file:'railway.toml',toml:true}),[]);
});

test('GitHub Actions schedules',()=>{
  const yml=`name: Nightly report
on:
  push:
    branches: [main]
  schedule:
    - cron: '0 6 * * 1-5'   # weekday mornings
    - cron: "30 23 * * 6"
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "cron: '* * * * *'"
`;
  assert.deepEqual(workflowCrons(yml),{name:'Nightly report',crons:['0 6 * * 1-5','30 23 * * 6']});
  const jobs=workflowJobs(yml,{repo:'site',file:'nightly.yml',now:NOW});
  assert.deepEqual(jobs.map(j=>[j.id,j.name,j.schedule,j.group]),[
    ['github:site:nightly.yml#1','Nightly report (1)','Weekdays 06:00 UTC','GitHub · site'],
    ['github:site:nightly.yml#2','Nightly report (2)','Saturdays 23:30 UTC','GitHub · site']]);
  assert.deepEqual(workflowCrons(`on:\n  schedule: [{cron: '*/15 * * * *'}]\n`).crons,['*/15 * * * *']);
  assert.deepEqual(workflowJobs('name: CI\non: [push, pull_request]\n',{repo:'x',file:'ci.yml'}),[]);
});

test('crontab lines',()=>{
  const text=`# m h dom mon dow command
MAILTO=someone
SHELL=/bin/bash
*/5 * * * * cd /srv/app && node scripts/poll.mjs --token abc123 >> /tmp/poll.log 2>&1
0 22 * * * /usr/local/bin/backup.sh
@reboot claude -p "tidy the inbox"
not a valid line
`;
  const jobs=crontabJobs(text,{group:'box',now:NOW});
  assert.equal(jobs.length,3);
  assert.equal(jobs[0].name,'poll.mjs --token ***');
  assert.equal(jobs[0].schedule,'Every 5 min');assert.equal(jobs[0].cron,'*/5 * * * *');assert.equal(jobs[0].source,'cron');
  assert.doesNotMatch(jobs[0].command,/abc123/);
  assert.match(jobs[0].id,/^cron:user:[0-9a-f]{12}$/);
  assert.equal(jobs[1].name,'backup.sh');assert.equal(jobs[1].schedule,'Daily 22:00');assert.equal(jobs[1].ai,false);
  assert.equal(jobs[2].schedule,'At boot');assert.equal(jobs[2].ai,true);assert.equal(jobs[2].nextRun,undefined);
  assert.deepEqual(crontabJobs(text,{group:'box',now:NOW}).map(j=>j.id),jobs.map(j=>j.id),'ids are stable');
});

test('stock distribution timers and include / exclude',()=>{
  for(const u of ['apt-daily.timer','apt-daily-upgrade.timer','fstrim.timer','logrotate.timer','sysstat-collect.timer','snapd.snap-repair.timer',
    'systemd-tmpfiles-clean.timer','e2scrub_all.timer','xfs_scrub_all.timer','launchpadlib-cache-clean.timer','motd-news.timer','ua-timer.timer','man-db.timer'])
    assert.ok(isDistroTimer(u),u);
  for(const u of ['backup.timer','flow-agent-runner.timer','nightly-scan.timer','certbot.timer'])assert.ok(!isDistroTimer(u),u);
  const jobs=[{id:'systemd:system:logrotate.timer',name:'Rotate log files',distro:true},{id:'systemd:user:backup.timer',name:'Backup'},
    {id:'cron:user:abc',name:'poll.mjs'},{id:'vercel:shop:/api/x',name:'/api/x'}];
  assert.deepEqual(filterJobs(jobs).map(j=>j.id),['systemd:user:backup.timer','cron:user:abc','vercel:shop:/api/x']);
  assert.deepEqual(filterJobs(jobs,{skipDistro:false}).length,4);
  assert.deepEqual(filterJobs(jobs,{exclude:['vercel:*','POLL']}).map(j=>j.id),['systemd:user:backup.timer']);
  assert.deepEqual(filterJobs(jobs,{include:['logrotate'],exclude:['*']}).map(j=>j.id),['systemd:system:logrotate.timer']);
  assert.ok(matches('systemd:*:backup.timer','systemd:user:backup.timer'));
  assert.ok(!matches('backup','cron:user:abc'));
});

test('secrets in commands are hidden and AI CLIs are spotted',()=>{
  assert.equal(redact('node run.mjs --api-key sk-abcdef0123456789 --verbose'),'node run.mjs --api-key *** --verbose');
  assert.equal(redact('TOKEN=hunter2 ./x'),'TOKEN=*** ./x');
  assert.equal(redact('curl -H "Authorization: Bearer abc.def" https://u:pw@example.com/x'),'curl -H "Authorization: Bearer *** https://u:***@example.com/x');
  assert.equal(redact('deploy flow_0123456789abcdef'),'deploy ***');
  assert.equal(redact('python3 scan.py D=/mnt/D'),'python3 scan.py D=/mnt/D');
  for(const c of ['/usr/bin/claude -p "x"','codex exec "y"','opencode run','grok -p hi','cursor-agent -p z','agy run','t3 thread start --wait .','node tools/agent-runner.mjs tick'])
    assert.ok(aiCommand(c),c);
  for(const c of ['/usr/bin/python3 backup.py','node ~/.claude/worktrees/x/server.mjs','echo claudette','rsync -a src dst'])assert.ok(!aiCommand(c),c);
  assert.equal(commandName('cd /srv && FOO=1 /usr/bin/python3 /srv/jobs/report.py --daily > /tmp/log 2>&1'),'report.py --daily');
});

test('systemctl output to jobs',()=>{
  const show=`Id=backup.timer
Description=Run the backup
TimersCalendar={ OnCalendar=*-*-* 22:30:00 ; next_elapse=@1793595000 }
Unit=backup.service
UnitFileState=enabled
ActiveState=active
LastTriggerUSec=@1793508600
NextElapseUSecRealtime=@1793595000

Id=poll.timer
Description=Poll
TimersMonotonic={ OnUnitActiveUSec=5min ; next_elapse=5d 2h }
TimersMonotonic={ OnBootUSec=2min ; next_elapse=2min }
Unit=poll.service
ActiveState=inactive
LastTriggerUSec=
`;
  const [b,p]=parseShow(show);
  assert.equal(b.Id,'backup.timer');assert.equal(p.TimersMonotonic.length,2);
  const svc={Id:'backup.service',Description:'Nightly backup',ExecStart:'{ path=/usr/bin/codex ; argv[]=/usr/bin/codex exec --token s3cret nightly ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }',Result:'exit-code',ActiveState:'failed'};
  const j=systemdJob({unit:'backup.timer',service:'backup.service'},b,svc,{scope:'system',group:'box · system'});
  assert.deepEqual(j,{id:'systemd:system:backup.timer',name:'Nightly backup',source:'systemd',group:'box · system',schedule:'Daily 22:30',
    command:'/usr/bin/codex exec --token *** nightly',ai:true,enabled:true,lastRun:new Date(1793508600e3).toISOString(),lastStatus:'failed',nextRun:new Date(1793595000e3).toISOString()});
  const q=systemdJob({unit:'poll.timer',service:'poll.service'},p,{Result:'success',ActiveState:'inactive'},{group:'box'});
  assert.equal(q.schedule,'Every 5 min');assert.equal(q.enabled,false);assert.equal(q.lastStatus,'unknown');assert.equal(q.lastRun,undefined);
  assert.equal(systemdJob({unit:'poll.timer',last:'2026-11-01T00:00:00.000Z'},p,{Result:'success',ActiveState:'activating'}).lastStatus,'running');
  assert.equal(systemdJob({unit:'poll.timer',last:'2026-11-01T00:00:00.000Z'},p,{Result:'success',ActiveState:'inactive'}).lastStatus,'ok');
  assert.ok(systemdJob({unit:'fstrim.timer'},{},{}).distro);
  assert.deepEqual(parseTimerList(`Sun 2026-11-01 16:40:00 MST 34s Sun 2026-11-01 16:30:05 MST 9min ago sysstat-collect.timer sysstat-collect.service
n/a n/a n/a n/a backup.timer backup.service`),[{unit:'sysstat-collect.timer',service:'sysstat-collect.service'},{unit:'backup.timer',service:'backup.service'}]);
});

test('T3 task schedules and the table',()=>{
  assert.equal(t3Schedule({type:'interval',everyMs:300000}),'Every 5 min');
  assert.equal(t3Schedule({type:'interval',everyMs:3600000}),'Hourly');
  assert.equal(t3Schedule({type:'interval',everyMs:7200000}),'Every 2 h');
  assert.equal(t3Schedule({type:'interval',everyMs:864e5}),'Every day');
  assert.equal(t3Schedule({type:'fixed_time',timeOfDay:'9:05'}),'Daily 09:05');
  assert.equal(t3Schedule({type:'fixed_time',timeOfDay:'22:30',weekdays:[6]}),'Saturdays 22:30');
  assert.equal(t3Schedule({type:'fixed_time',timeOfDay:'08:00',weekdays:[1,2,3,4,5]}),'Weekdays 08:00');
  assert.equal(t3Schedule({type:'webhook'}),'On webhook');
  assert.equal(t3Schedule(null),'Unknown');
  assert.equal(dayPhrase([0,1,2,3,4,5,6]),'Daily');
  assert.equal(jobsTable([]),'No scheduled jobs found.');
  const t=jobsTable([{id:'a',name:'Backup',source:'systemd',group:'box',schedule:'Daily 22:30',ai:false,enabled:true,lastStatus:'ok'}]).split('\n');
  assert.match(t[0],/^GROUP\s+SOURCE\s+NAME\s+SCHEDULE/);assert.match(t[1],/^box\s+systemd\s+Backup\s+Daily 22:30\s+on\s+ok$/);
});

test('discoverJobs reads repo configs from the configured repos only',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'runner-jobs-'));
  try{
    const repo=join(dir,'shop');
    mkdirSync(join(repo,'.github','workflows'),{recursive:true});mkdirSync(join(repo,'services','worker'),{recursive:true});
    writeFileSync(join(repo,'vercel.json'),JSON.stringify({crons:[{path:'/api/a',schedule:'0 1 * * *'},{path:'/api/a',schedule:'0 1 * * *'}]}));
    writeFileSync(join(repo,'services','worker','railway.toml'),'[deploy]\ncronSchedule = "*/10 * * * *"\n');
    writeFileSync(join(repo,'railway.nightly.json'),JSON.stringify({deploy:{cronSchedule:'0 3 * * *'}}));
    writeFileSync(join(repo,'.github','workflows','w.yml'),"on:\n  schedule:\n    - cron: '0 6 * * 1'\n");
    const notes=[];
    const jobs=await discoverJobs({name:'box',jobs:{sources:['vercel','railway','github'],repos:[repo,join(dir,'missing')]}},{note:n=>notes.push(n)});
    assert.deepEqual(jobs.map(j=>j.id).sort(),['github:shop:w.yml','railway:shop:railway.nightly.json','railway:shop:services/worker/railway.toml','vercel:shop:/api/a']);
    assert.equal(jobs.find(j=>j.source==='railway'&&j.id.includes('nightly')).group,'Railway · shop (nightly)');
    assert.ok(jobs.every(j=>!('distro' in j)));
    assert.deepEqual(await discoverJobs({jobs:{sources:[]}}),[]);
  }finally{rmSync(dir,{recursive:true,force:true})}
});

// report against a stub Flow server: jobs go in the same POST; a server that rejects the field gets
// the models alone.
async function reportAgainst(handler,extra=()=>({})){
  const bodies=[],paths=[],srv=createServer((req,res)=>{let s='';req.on('data',d=>s+=d).on('end',()=>{bodies.push(JSON.parse(s||'null'));paths.push(req.url);const [code,body]=handler(bodies.length);res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(body))})});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const home=mkdtempSync(join(tmpdir(),'runner-report-'));
  try{
    mkdirSync(join(home,'.config','flygon-flow'),{recursive:true});mkdirSync(join(home,'repo'));
    writeFileSync(join(home,'repo','vercel.json'),JSON.stringify({crons:[{path:'/api/x',schedule:'*/5 * * * *'}]}));
    writeFileSync(join(home,'.config','flygon-flow','runner.json'),JSON.stringify({name:'box',env:'default-workspace',url:`http://127.0.0.1:${srv.address().port}`,key:'k',
      t3Home:join(home,'t3'),opencode:'',grok:'',jobs:{sources:['vercel'],repos:[join(home,'repo')]},...extra(home)}));
    const env={...process.env,HOME:home,XDG_CONFIG_HOME:join(home,'.config'),XDG_STATE_HOME:join(home,'.state')};
    for(const k of Object.keys(env))if(k.startsWith('FLOW_'))delete env[k];
    const out=await new Promise(r=>execFile(process.execPath,[RUNNER,'report'],{env,timeout:30000},(err,stdout,stderr)=>r({code:err?err.code??1:0,stdout,stderr})));
    const state=(()=>{try{return JSON.parse(readFileSync(join(home,'.state','flygon-flow','runner-state.json'),'utf8'))}catch{return null}})();
    return {...out,bodies,paths,state};
  }finally{srv.close();rmSync(home,{recursive:true,force:true})}
}
test('report sends jobs with the models',async()=>{
  const r=await reportAgainst(()=>[200,{changed:true}]);
  assert.equal(r.code,0,r.stderr);assert.equal(r.bodies.length,1);
  assert.deepEqual(r.bodies[0].jobs.map(j=>j.id),['vercel:repo:/api/x']);
  assert.ok(Array.isArray(r.bodies[0].models));
  assert.match(r.stdout,/reported \d+ models and 1 jobs as "box"/);
});
test('report falls back to models alone when the server rejects jobs',async()=>{
  const r=await reportAgainst(n=>n===1?[400,{error:{code:'validation_failed',message:'body: unknown property "jobs" (additionalProperties)'}}]:[200,{changed:false}]);
  assert.equal(r.code,0,r.stderr);assert.equal(r.bodies.length,2);
  assert.ok(r.bodies[0].jobs);assert.equal(r.bodies[1].jobs,undefined);
  assert.match(r.stdout,/server does not accept jobs yet/);
  assert.match(r.stdout,/reported \d+ models as "box" \(unchanged\)/);
});
test('report falls back on the error Flow itself answers with (an older server: jobs is not allowed)',async()=>{
  const r=await reportAgainst(n=>n===1?[400,{error:'input.jobs: is not allowed',code:'invalid_input',details:['input.jobs: is not allowed']}]:[200,{changed:true}]);
  assert.equal(r.code,0,r.stderr);assert.equal(r.bodies.length,2);assert.equal(r.bodies[1].jobs,undefined);
  assert.match(r.stdout,/server does not accept jobs yet \(POST \/runners\/box: 400 invalid_input input\.jobs: is not allowed\)/);
});
test('report does not retry other errors',async()=>{
  const r=await reportAgainst(()=>[400,{error:{code:'validation_failed',message:'models[0].id: too long'}}]);
  assert.notEqual(r.code,0);assert.equal(r.bodies.length,1);
});
test('jobs needs no settings or server',async()=>{
  const home=mkdtempSync(join(tmpdir(),'runner-jobs-cli-'));
  try{
    const env={...process.env,HOME:home,XDG_CONFIG_HOME:join(home,'.config')};
    writeFileSync(join(home,'r.json'),JSON.stringify({jobs:{sources:[]}}));
    const r=await new Promise(res=>execFile(process.execPath,[RUNNER,'jobs','--json','--config',join(home,'r.json')],{env,timeout:20000},(err,stdout,stderr)=>res({code:err?err.code??1:0,stdout,stderr})));
    assert.equal(r.code,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),[]);
  }finally{rmSync(home,{recursive:true,force:true})}
});

// ---------- remote (SSH) discovery ----------
const PHX='America/Phoenix';
test('RFC 5545 rules read as text, in the rule\'s zone',()=>{
  const at=Date.parse('2026-09-12T16:00:00Z'),h=(r,o={})=>humaniseRRule(r,{tz:PHX,anchor:at,...o});
  assert.equal(h('DTSTART;TZID=America/Phoenix:20261101T180000\nRRULE:FREQ=DAILY;COUNT=1'),'Once Nov 1 18:00');
  assert.equal(h('DTSTART;TZID=America/Phoenix:20261027T090000\\nRRULE:FREQ=DAILY;COUNT=7'),'Daily 09:00, 7 times','an escaped \\n works too');
  assert.equal(h('DTSTART;TZID=America/Phoenix:20261013T090000\nRRULE:FREQ=DAILY;UNTIL=20261027T090000'),'Daily 09:00, until Oct 27');
  assert.equal(h('DTSTART;TZID=America/Chicago:20260819T090000\nRRULE:FREQ=WEEKLY;BYDAY=TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0'),'Tue-Fri 09:00 America/Chicago','another zone is named');
  assert.equal(h('DTSTART;TZID=America/Phoenix:20261006T090000\nRRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0'),'Daily 09:00');
  assert.equal(h('FREQ=DAILY;BYHOUR=9,16;BYMINUTE=15'),'Daily 09:15, 16:15');
  assert.equal(h('RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0'),'Daily 09:00');
  assert.equal(h('FREQ=MINUTELY;INTERVAL=15'),'Every 15 min');
  assert.equal(h('FREQ=HOURLY;INTERVAL=6'),'Every 6 h');
  assert.equal(h('FREQ=HOURLY;INTERVAL=1'),'Hourly');
  assert.equal(h('DTSTART;TZID=America/Phoenix:20261016T200000\nRRULE:FREQ=DAILY;BYHOUR=8,21;COUNT=34'),'Daily 08:00, 21:00, 34 times');
  assert.equal(h('FREQ=WEEKLY;BYDAY=SA;BYHOUR=10;BYMINUTE=30'),'Saturdays 10:30');
  assert.equal(h('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;BYHOUR=8'),'Every 2 weeks, Mon, Wed 08:00');
  assert.equal(h('DTSTART:20260930T040000Z\nRRULE:FREQ=DAILY;COUNT=1'),'Once Sep 29 21:00','a UTC start is shown in the machine\'s zone');
  assert.equal(h('FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=4;BYHOUR=9;BYMINUTE=0;BYSECOND=0;COUNT=1'),'Once Nov 4 09:00','a one-shot without DTSTART counts from the anchor');
  assert.equal(h('DTSTART;TZID=America/Phoenix:20261024T213000\nRRULE:FREQ=HOURLY;INTERVAL=12;COUNT=2'),'Every 12 h, 2 times');
  assert.equal(h('FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=6;BYMINUTE=0'),'Monthly on day 1 06:00');
  assert.equal(h('not a rule'),'not a rule');
  assert.equal(parseRRule('BYHOUR=9'),null,'no FREQ, no rule');
  assert.deepEqual(parseRRule('DTSTART;TZID=America/Phoenix:20261101T180000\nRRULE:FREQ=DAILY;COUNT=1;BYDAY=MO,1TU').by.nth,true);
});
test('the next occurrence of a rule',()=>{
  const now=Date.parse('2026-11-02T01:00:00Z');   // Nov 1 18:00 in Phoenix
  let x=rruleNext('DTSTART;TZID=America/Phoenix:20261027T090000\nRRULE:FREQ=DAILY;COUNT=7',{now});
  assert.deepEqual(x,{next:'2026-11-02T16:00:00.000Z',first:'2026-10-27T16:00:00.000Z',done:false});
  x=rruleNext('DTSTART;TZID=America/Phoenix:20261027T090000\nRRULE:FREQ=DAILY;COUNT=7',{now:Date.parse('2026-11-03T00:00:00Z')});
  assert.equal(x.done,true,'seven runs, all past: done');
  assert.equal(rruleNext('DTSTART;TZID=America/Phoenix:20261013T090000\nRRULE:FREQ=DAILY;UNTIL=20261027T090000',{now}).done,true,'until has passed');
  assert.equal(rruleNext('FREQ=DAILY;BYHOUR=9,16;BYMINUTE=15',{tz:PHX,anchor:Date.parse('2026-08-01T00:00:00Z'),now}).next,'2026-11-02T16:15:00.000Z');
  assert.equal(rruleNext('FREQ=MINUTELY;INTERVAL=15',{tz:PHX,anchor:Date.parse('2026-01-01T00:07:00Z'),now}).next,'2026-11-02T01:07:00.000Z','no COUNT: skips ahead');
  assert.equal(rruleNext('DTSTART;TZID=America/Chicago:20260819T090000\nRRULE:FREQ=WEEKLY;BYDAY=TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0',{now}).next,'2026-11-03T15:00:00.000Z','after the DST change, 09:00 CST');
  assert.equal(rruleNext('FREQ=DAILY;COUNT=1;BYMONTH=9;BYMONTHDAY=7;BYHOUR=14;BYMINUTE=18',{tz:PHX,anchor:Date.parse('2026-09-07T20:00:00Z'),now}).done,true,'a used-up one-shot');
  assert.equal(rruleNext('FREQ=MONTHLY;BYDAY=1MO',{now}),null,'BYDAY with a number is not followed');
});
test('time zones: wall clock and back, and cron in a zone',()=>{
  const t=Date.parse('2026-11-01T14:30:00Z');
  assert.equal(new Date(wallOf(t,PHX)).toISOString(),'2026-11-01T07:30:00.000Z');
  assert.equal(wallToMs(wallOf(t,PHX),PHX),t);
  assert.equal(nextCron('30 7 * * *',new Date('2026-11-01T15:00:00Z'),{tz:PHX}),'2026-11-02T14:30:00.000Z');
  assert.equal(nextCron('0 9,13,17,21 * * *',new Date('2026-11-02T00:10:00Z'),{tz:PHX}),'2026-11-02T04:00:00.000Z');
  assert.equal(nextCron('0 9 * * 1',new Date('2026-11-01T12:00:00Z'),{tz:'America/Chicago'}),'2026-11-02T15:00:00.000Z');
});
test('Windows triggers read as text',()=>{
  const T=(type,o={})=>humaniseWinTrigger({type:`MSFT_Task${type}Trigger`,...o});
  assert.equal(T('Daily',{start:'2026-01-01T18:00:00',days:1}),'Daily 18:00');
  assert.equal(T('Daily',{start:'2026-01-01T18:00:00-07:00',days:2}),'Every 2 days 18:00');
  assert.equal(T('Daily',{start:'2026-01-01T18:58:38',days:1,interval:'PT1H',duration:'P1D'}),'Hourly');
  assert.equal(T('Daily',{start:'2026-01-01T11:39:02',days:1,interval:'PT4H',duration:'PT23H'}),'Every 4 h');
  assert.equal(T('Daily',{start:'2026-01-01T08:00:00',days:1,interval:'PT2H',duration:'PT6H'}),'Daily 08:00, then every 2 h for 6 h');
  assert.equal(T('Weekly',{start:'2026-01-01T05:11:44',weeks:1,dow:32}),'Fridays 05:11');
  assert.equal(T('Weekly',{start:'2026-01-01T04:00:00',weeks:2,dow:1}),'Every 2 weeks, Sundays 04:00');
  assert.equal(T('Weekly',{start:'2026-01-01T09:00:00',weeks:1,dow:62}),'Weekdays 09:00');
  assert.equal(T('Time',{start:'2026-10-15T08:51:32-07:00',interval:'PT15M'}),'Every 15 min');
  assert.equal(T('Time',{start:'2026-10-13T19:00:00-07:00',interval:'PT3H'}),'Every 3 h');
  assert.equal(T('Time',{start:'2026-10-27T13:50:56',interval:'P1D'}),'Daily 13:50');
  assert.equal(T('Time',{start:`${new Date().getFullYear()}-11-26T14:04:25`}),'Once Nov 26 14:04');
  assert.equal(T('Time',{start:'2020-03-02T07:00:00'}),'Once Mar 2 2020 07:00');
  assert.equal(T('Monthly',{start:'2026-01-01T03:00:00',dom:1}),'Monthly on day 1 03:00');
  assert.equal(T('Monthly',{start:'2026-01-01T03:00:00',dom:1|(1<<14)}),'Monthly on day 1, 15 03:00');
  assert.equal(T('MonthlyDOW',{start:'2026-01-01T09:00:00',wom:1,dow:2}),'First Monday monthly 09:00');
  assert.equal(T('MonthlyDOW',{start:'2026-01-01T09:00:00',wom:16,dow:64}),'Last Saturday monthly 09:00');
  assert.equal(T('Logon'),'At logon');
  assert.equal(T('Logon',{interval:'PT3H30M'}),'At logon, then every 3 h 30 min');
  assert.deepEqual([T('Boot'),T('Event'),T('Idle'),T('Registration'),T('SessionStateChange'),humaniseWinTrigger({type:''})],
    ['At boot','On an event','When idle','When created','On lock or unlock','Custom trigger']);
  assert.equal(humaniseWinTriggers([]),'On demand');
  assert.equal(humaniseWinTriggers([{type:'MSFT_TaskEventTrigger'},{type:'MSFT_TaskEventTrigger'},{type:'MSFT_TaskLogonTrigger'}]),'On an event; At logon','repeats once');
  assert.equal(humaniseWinTriggers([{type:'MSFT_TaskLogonTrigger',enabled:false}]),'On demand (triggers off)');
  assert.deepEqual(isoDuration('PT3H30M'),{ms:3.5*36e5,text:'3 h 30 min'});
  assert.equal(isoDuration('P'),null);
});
test('Windows tasks to jobs: vendor tasks skipped, status from the last result',()=>{
  assert.deepEqual([winStatus('Ready',0,'x'),winStatus('Running',0,'x'),winStatus('Ready',267009,'x'),winStatus('Ready',267011,null),winStatus('Ready',1,'x'),winStatus('Ready',2147946720,'x')],
    ['ok','running','running','unknown','failed','failed']);
  for(const p of ['\\MicrosoftEdgeUpdateTaskMachineCore{X}','\\McAfee\\wps\\Updater','\\GoogleSystem\\GoogleUpdater\\Task','\\Opera scheduled Autoupdate 1','\\Adobe Acrobat Update Task',
    '\\OneDrive Reporting Task-S-1-5','\\ZoomUpdateTaskUser-S-1','\\BraveSoftwareUpdateTaskMachineUA{X}','\\Git for Windows Updater','\\AsideSystem\\AsideUpdater\\Task'])assert.ok(isVendorTask(p),p);
  for(const p of ['\\Nightly backup','\\Operations report','\\Photo sync'])assert.ok(!isVendorTask(p),p);
  const base={path:'\\',state:'Ready',result:0,last:'2026-11-01T10:00:00.0000000Z',next:'2026-11-02T10:00:00.0000000Z'};
  const tasks=[
    {...base,name:'Nightly backup',triggers:[{type:'MSFT_TaskDailyTrigger',start:'2026-01-01T02:00:00',days:1}],actions:[{type:'MSFT_TaskExecAction',exe:'powershell.exe',args:'-File C:\\Users\\Pat\\scripts\\backup.ps1 -Token abc123secret'}]},
    {...base,name:'Agent nudge',state:'Disabled',triggers:[{type:'MSFT_TaskTimeTrigger',start:'2026-01-01T00:00:00',interval:'PT30M'}],actions:[{exe:'C:\\Tools\\codex.exe',args:'exec "check"'}]},
    {...base,name:'MicrosoftEdgeUpdateTaskMachineCore',triggers:[],actions:[]},
    {...base,path:'\\McAfee\\wps\\',name:'McAfee Updater',triggers:[],actions:[{type:'MSFT_TaskComHandlerAction'}]}];
  const jobs=windowsJobs(tasks,{group:'Laptop',profile:'C:\\Users\\Pat'});
  assert.deepEqual(jobs.map(j=>j.id),['windows:\\Nightly backup','windows:\\Agent nudge']);
  assert.deepEqual(jobs[0],{id:'windows:\\Nightly backup',name:'Nightly backup',source:'windows',group:'Laptop',schedule:'Daily 02:00',
    command:'powershell.exe -File ~\\scripts\\backup.ps1 -Token ***',ai:false,enabled:true,lastRun:'2026-11-01T10:00:00.000Z',lastStatus:'ok',nextRun:'2026-11-02T10:00:00.000Z'});
  assert.deepEqual([jobs[1].enabled,jobs[1].ai,'nextRun' in jobs[1]],[false,true,false],'disabled: no next run');
  assert.deepEqual(windowsJobs(tasks,{include:['*McAfee Updater'],exclude:['Nightly*']}).map(j=>j.name),['Agent nudge','McAfee Updater'],'include keeps, exclude drops');
  assert.equal(windowsJobs(tasks,{skipVendor:false}).length,4);
  assert.equal(windowsJobs(tasks,{skipVendor:false})[3].command,'COM handler');
});
test('Aside routines to jobs',()=>{
  const now=Date.parse('2026-11-02T01:00:00Z'),rule='DTSTART;TZID=America/Phoenix:20261027T090000\nRRULE:FREQ=DAILY;COUNT=7';
  const r=(o={})=>({id:'r1',name:'Ad check',prompt:'\nCheck the ads.\nUse api_key=abc123 for it.',rrule:rule,status:'active',next_run_at:'2026-11-02T16:00:00.000Z',created_at:1792000000,
    model:{provider:'gateway',modelId:'vendor/model-1'},last:{status:'idle',started:1793552408,finished:1793552500,aborted:null},...o});
  const [a,b,c,d,e]=asideJobs([r(),r({id:'r2',status:'paused',next_run_at:null}),r({id:'r3',next_run_at:'2026-10-24T16:00:00.000Z'}),
    r({id:'r4',last:{status:'suspended',started:1793552408}}),r({id:'r5',last:{status:'errored',started:1793552408,finished:1793552410,aborted:1793552410}})],{group:'Laptop · Aside',tz:PHX,now});
  assert.deepEqual(a,{id:'aside:r1',name:'Ad check',source:'aside',group:'Laptop · Aside',schedule:'Daily 09:00, 7 times',command:'gateway/vendor/model-1 · Check the ads.',
    ai:true,enabled:true,lastRun:'2026-11-01T17:00:08.000Z',lastStatus:'ok',nextRun:'2026-11-02T16:00:00.000Z'});
  assert.deepEqual([b.enabled,'nextRun' in b],[false,false],'paused');
  assert.deepEqual([c.schedule,c.lastStatus,'nextRun' in c],['Daily 09:00, 7 times (stale)','unknown',false],'next_run_at in the past: stale');
  assert.deepEqual([d.lastStatus,d.command.startsWith('Waiting for approval · ')],['running',true],'suspended: waiting for approval');
  assert.equal(e.lastStatus,'failed');
  assert.equal(asideJobs([r({last:undefined})],{now})[0].lastStatus,'unknown','never ran');
  assert.match(asideJobs([r({prompt:'Use token=abc123secret'})],{now})[0].command,/token=\*\*\*/,'secrets hidden');
});
test('Claude desktop scheduled tasks to jobs',()=>{
  const json=JSON.stringify({scheduledTasks:[
    {id:'morning-digest',displayName:'Morning digest',cronExpression:'30 7 * * *',enabled:true,filePath:'X:\\tasks\\morning-digest\\SKILL.md',createdAt:1790000000000,lastRunAt:'2026-11-01T14:37:55.721Z',lastScheduledFor:'2026-11-01T14:30:00.000Z',approvedPermissions:[{toolName:'Read'}]},
    {id:'weekly-review',displayName:'Weekly review',cronExpression:'0 9 * * 1',enabled:false},{displayName:'no id'}],
    recordedSkips:{'morning-digest':[{at:1793000000000,reason:'per_task_limit'}]}});
  const tasks=claudeTasks(json);
  assert.deepEqual(tasks.map(t=>t.id),['morning-digest','weekly-review']);
  assert.deepEqual(claudeTasks('not json'),[]);
  const skills={'morning-digest':'---\nname: morning-digest\ndescription: "Summarise the inbox and calendar each morning"\n---\n\n# Morning digest\nRead the inbox.'};
  const [a,b]=claudeJobs(tasks,{group:'Laptop · Claude',tz:PHX,skills,now:new Date('2026-11-01T15:00:00Z')});
  assert.deepEqual(a,{id:'claude:morning-digest',name:'Morning digest',source:'claude',group:'Laptop · Claude',schedule:'Daily 07:30',cron:'30 7 * * *',
    command:'Summarise the inbox and calendar each morning',ai:true,enabled:true,lastRun:'2026-11-01T14:37:55.721Z',lastStatus:'unknown',nextRun:'2026-11-02T14:30:00.000Z'});
  assert.deepEqual([b.enabled,'nextRun' in b,'command' in b,b.schedule],[false,false,false,'Mondays 09:00']);
  assert.equal(skillSummary('# Check replies\nMore text'),'Check replies');
  assert.equal(skillSummary('---\nname: x\n---\n\nFirst line here.\n'),'First line here.');
});
test('Codex automation.toml and automations to jobs',()=>{
  const toml=['version = 1','id = "daily-brief"','kind = "cron"','name = "Daily brief"','prompt = "Line one with \\"quotes\\" and caf\\u00e9\\nline two"',
    'status = "ACTIVE"','rrule = "DTSTART;TZID=America/Phoenix:20260801T090000\\nRRULE:FREQ=DAILY;BYHOUR=9,16;BYMINUTE=15"','model = "gpt-x"','reasoning_effort = "medium"',
    'target = { type = "project", project_id = "p1" }','cwds = ["C:\\\\work", \'D:\\\\other\']','created_at = 1785000000000','[extra]','name = "ignored"'].join('\n');
  const a=parseToml(toml);
  assert.deepEqual([a.version,a.id,a.prompt,a.cwds,a.created_at,a.target,a.name],[1,'daily-brief','Line one with "quotes" and café\nline two',['C:\\work','D:\\\\other'],1785000000000,'{ type = "project", project_id = "p1" }','Daily brief']);
  assert.equal(parseToml('prompt = "cut short with no clo').prompt,'cut short with no clo','a string cut short');
  const now=Date.parse('2026-11-02T01:00:00Z'),created=Date.parse('2026-09-01T00:00:00Z');
  const autos=[{...a,id:'daily-brief'},
    {id:'nudge',kind:'heartbeat',name:'Nudge',status:'PAUSED',rrule:'FREQ=HOURLY;INTERVAL=6',created_at:created},
    {id:'once-done',kind:'heartbeat',name:'Once done',status:'ACTIVE',rrule:'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;COUNT=1',created_at:created},
    {id:'once-later',kind:'heartbeat',name:'Once later',status:'ACTIVE',rrule:'FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=4;BYHOUR=9;BYMINUTE=0;COUNT=1',created_at:created}];
  const jobs=codexJobs(autos,{group:'Laptop · Codex',tz:PHX,runs:{'daily-brief':[3,1793574773]},now});
  assert.deepEqual(jobs.map(j=>j.id),['codex:daily-brief','codex:nudge','codex:once-later'],'a used-up one-shot is skipped');
  assert.deepEqual(jobs[0],{id:'codex:daily-brief',name:'Daily brief',source:'codex',group:'Laptop · Codex',schedule:'Daily 09:15, 16:15',
    command:'codex:gpt-x (medium) · Line one with "quotes" and café',ai:true,enabled:true,lastRun:'2026-11-01T23:12:53.000Z',lastStatus:'unknown',nextRun:'2026-11-02T16:15:00.000Z'});
  assert.deepEqual([jobs[1].enabled,jobs[1].schedule,'nextRun' in jobs[1]],[false,'Every 6 h',false]);
  assert.deepEqual([jobs[2].schedule,jobs[2].nextRun],['Once Nov 4 09:00','2026-11-04T16:00:00.000Z']);
  assert.equal(codexJobs(autos,{tz:PHX,now,keepDone:true}).find(j=>j.id==='codex:once-done').schedule,'Once Sep 1 09:00 (done)','keepDone marks it');
  assert.equal(codexJobs([{id:'c',cron:'0 8 * * *'}],{tz:PHX,now})[0].nextRun,'2026-11-02T15:00:00.000Z');
});
test('remote plans, scripts and raw output to jobs',()=>{
  let p=remotePlan({name:'L',ssh:['ssh','h'],python:'C:\\py\\python.exe'});
  assert.deepEqual([p.psSources,p.pySources,p.repos,p.needsPython],[['windows'],['aside','claude-desktop','codex'],[],false]);
  p=remotePlan({name:'L',ssh:['ssh','h'],repos:['C:\\code\\shop'],sources:['windows','aside','claude-desktop','vercel']});
  assert.deepEqual([p.psSources,p.pySources,p.repos,p.needsPython],[['windows','claude-desktop'],[],['C:\\code\\shop'],true],'no python: PowerShell reads the Claude files; Aside needs python');
  const c={sources:['windows'],repos:[],asideStatuses:['active','paused']};
  for(const s of [psScript(c),pyScript(c)])assert.ok(/^[\x00-\x7f]*$/.test(s),'scripts are ASCII');
  assert.ok(psScript(c).startsWith("$CFG=@{sources=@(([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('d2luZG93cw=='))));repos=@();asideStatuses=@("),'settings as PowerShell literals');
  assert.ok(!/ConvertTo-Json|Get-ScheduledTask/.test(psScript(c)),'no slow cmdlets on the main path');
  const py=spawnSync('python3',['-c','import sys,ast;ast.parse(sys.stdin.read())'],{input:pyScript(c),encoding:'utf8'});
  if(!py.error)assert.equal(py.status,0,py.stderr);
  const files=[{dir:'',name:'vercel.json',text:JSON.stringify({crons:[{path:'/api/x',schedule:'0 5 * * *'}]})},{dir:'.github/workflows',name:'w.yml',text:"on:\n  schedule:\n    - cron: '0 6 * * 1'\n"},
    {dir:'services/api',name:'railway.json',text:JSON.stringify({deploy:{cronSchedule:'*/10 * * * *'}})}];
  assert.deepEqual(repoFileJobs('shop',files,{now:NOW}).map(j=>j.id),['vercel:shop:/api/x','github:shop:w.yml','railway:shop:services/api/railway.json']);
  const notes=[],now=Date.parse('2026-11-02T01:00:00Z');
  const raw={ps:{home:'C:\\Users\\Pat',errors:['claude: nope'],windows:[{path:'\\',name:'Backup',state:'Ready',result:0,triggers:[],actions:[]},{path:'\\',name:'GoogleUpdaterTask',state:'Ready',triggers:[]}],
    repos:[{repo:'shop',files}]},py:{aside:[{id:'r1',name:'Ads',rrule:'FREQ=DAILY;BYHOUR=9',status:'active',next_run_at:'2026-11-02T16:00:00.000Z'}],
    claude:{tasks:[{id:'t1',displayName:'T1',cronExpression:'0 9 * * *',enabled:true}],skills:{}},codex:{automations:[{dir:'auto-1',text:'name = "Auto"\nstatus = "ACTIVE"\nrrule = "FREQ=DAILY;BYHOUR=7;BYMINUTE=0"'}],runs:{}}}};
  const jobs=remoteJobs({name:'Laptop',ssh:['ssh'],python:'py',repos:['C:\\code\\shop'],timezone:PHX,exclude:['github:*']},raw,{now,note:n=>notes.push(n)});
  assert.deepEqual(jobs.map(j=>[j.id,j.group]),[['windows:\\Backup','Laptop'],['aside:r1','Laptop · Aside'],['claude:t1','Laptop · Claude'],['codex:auto-1','Laptop · Codex'],
    ['vercel:shop:/api/x','Vercel · shop'],['railway:shop:services/api/railway.json','Railway · api']]);
  assert.deepEqual(notes,['Laptop: claude: nope']);
  assert.equal(jobs.find(j=>j.id==='codex:auto-1').nextRun,'2026-11-02T14:00:00.000Z');
});

// A stand-in for ssh: answers the PowerShell script with Task Scheduler data and the Python one with
// an Aside routine; with a flag file it fails the first connection (exit 255) to test the retry.
const FAKE_SSH=`let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const fs=require('fs'),flag=process.argv[2];
  if(flag&&fs.existsSync(flag)){fs.unlinkSync(flag);process.stderr.write('kex_exchange_identification: Connection closed\\n');process.exit(255)}
  if(s.includes('Schedule.Service'))console.log(JSON.stringify({home:'C:\\\\Users\\\\Pat',errors:[],windows:[{path:'\\\\',name:'Backup',state:'Ready',result:0,last:'2026-11-01T10:00:00Z',triggers:[{type:'MSFT_TaskDailyTrigger',start:'2026-01-01T02:00:00',days:1}],actions:[]}]}));
  else if(s.includes('import json'))console.log('banner\\n'+JSON.stringify({home:'C:\\\\Users\\\\Pat',errors:[],aside:[{id:'r1',name:'Ads',rrule:'FREQ=DAILY;BYHOUR=9',status:'active'}],claude:{tasks:[],skills:{}},codex:{automations:[],runs:{}}}));
  else process.exit(3);
});`;
const fakeRemote=(home,o={})=>{writeFileSync(join(home,'fake-ssh.cjs'),FAKE_SSH);return {name:'Laptop',ssh:[process.execPath,join(home,'fake-ssh.cjs'),...(o.flag?[o.flag]:[])],python:'C:\\py\\python.exe',timezone:PHX,...o.extra}};
test('jobs --remote prints a remote machine\'s jobs over ssh, with one retry on a failed connection',async()=>{
  const home=mkdtempSync(join(tmpdir(),'runner-remote-'));
  try{
    const flag=join(home,'fail-once');writeFileSync(flag,'');
    writeFileSync(join(home,'r.json'),JSON.stringify({jobs:{sources:[]},remotes:[fakeRemote(home,{flag})]}));
    const run=a=>new Promise(res=>execFile(process.execPath,[RUNNER,'jobs',...a,'--config',join(home,'r.json')],{env:{...process.env,HOME:home},timeout:30000},(err,stdout,stderr)=>res({code:err?err.code??1:0,stdout,stderr})));
    let r=await run(['--remote','laptop','--json']);
    assert.equal(r.code,0,r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).map(j=>j.id).sort(),['aside:r1','windows:\\Backup']);
    r=await run(['--all']);
    assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/== Laptop \(America\/Phoenix\)/);assert.match(r.stdout,/Backup\s+Daily 02:00/);
    r=await run(['--remote','Desk']);
    assert.equal(r.code,1);assert.match(r.stderr,/No remote "Desk" in "remotes" \(Laptop\)/);
  }finally{rmSync(home,{recursive:true,force:true})}
});
test('report sends each remote as its own runner, jobs only, and notes when it ran',async()=>{
  const r=await reportAgainst(()=>[200,{changed:true}],home=>({remotes:[fakeRemote(home),{name:'box',ssh:['ssh']},{name:'Off',enabled:false,ssh:['ssh']}]}));
  assert.equal(r.code,0,r.stderr);
  assert.deepEqual(r.paths,['/api/v1/envs/default-workspace/runners/box','/api/v1/envs/default-workspace/runners/Laptop']);
  assert.ok(Array.isArray(r.bodies[0].models));
  assert.deepEqual(Object.keys(r.bodies[1]),['jobs'],'no models: the server keeps what it has');
  assert.deepEqual(r.bodies[1].jobs.map(j=>j.id).sort(),['aside:r1','windows:\\Backup']);
  assert.match(r.stdout,/remote "box" has this runner's name; skipped/);
  assert.match(r.stdout,/reported 2 jobs as "Laptop"/);
  assert.equal(r.state.remotes.Laptop.jobs,2);assert.ok(Date.parse(r.state.remotes.Laptop.at));
});
test('a remote that cannot be reached is logged and skipped',async()=>{
  const r=await reportAgainst(()=>[200,{changed:true}],()=>({remotes:[{name:'Gone',ssh:[process.execPath,'-e','process.exit(255)'],timeout:3}]}));
  assert.equal(r.code,0,r.stderr);assert.equal(r.bodies.length,1,'only the local report');
  assert.match(r.stdout,/remote "Gone": ssh exit 255/);assert.match(r.state.remotes.Gone.error,/ssh exit 255/);
});
test('an older server that needs models: the remote is skipped with a note',async()=>{
  const r=await reportAgainst(n=>n===1?[200,{changed:true}]:[400,{error:'input.models: is required',code:'invalid_input'}],home=>({remotes:[fakeRemote(home)]}));
  assert.equal(r.code,0,r.stderr);assert.match(r.stdout,/this Flow server needs models in runners\.report; update Flow/);
});
