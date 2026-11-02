// The reference runner's job discovery: schedule parsers, repo cron configs, filters, and the
// jobs field on runners.report (with the fallback for servers that do not take it yet).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {humaniseOnCalendar,humaniseMonotonic,humaniseDuration,humaniseCron,nextCron,parseCron,vercelJobs,railwayJobs,railwayConfig,
  workflowCrons,workflowJobs,crontabJobs,isDistroTimer,filterJobs,matches,redact,aiCommand,commandName,parseShow,parseTimerList,
  systemdJob,t3Schedule,dayPhrase,jobsTable,discoverJobs} from '../tools/agent-runner.mjs';

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
async function reportAgainst(handler){
  const bodies=[],srv=createServer((req,res)=>{let s='';req.on('data',d=>s+=d).on('end',()=>{bodies.push(JSON.parse(s||'null'));const [code,body]=handler(bodies.length);res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(body))})});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const home=mkdtempSync(join(tmpdir(),'runner-report-'));
  try{
    mkdirSync(join(home,'.config','flygon-flow'),{recursive:true});mkdirSync(join(home,'repo'));
    writeFileSync(join(home,'repo','vercel.json'),JSON.stringify({crons:[{path:'/api/x',schedule:'*/5 * * * *'}]}));
    writeFileSync(join(home,'.config','flygon-flow','runner.json'),JSON.stringify({name:'box',env:'default-workspace',url:`http://127.0.0.1:${srv.address().port}`,key:'k',
      t3Home:join(home,'t3'),opencode:'',grok:'',jobs:{sources:['vercel'],repos:[join(home,'repo')]}}));
    const env={...process.env,HOME:home,XDG_CONFIG_HOME:join(home,'.config'),XDG_STATE_HOME:join(home,'.state')};
    for(const k of Object.keys(env))if(k.startsWith('FLOW_'))delete env[k];
    const out=await new Promise(r=>execFile(process.execPath,[RUNNER,'report'],{env,timeout:20000},(err,stdout,stderr)=>r({code:err?err.code??1:0,stdout,stderr})));
    return {...out,bodies};
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
