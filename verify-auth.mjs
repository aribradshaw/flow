// Sign-in and environment checks for verify.mjs. Runs a second app server in OneProfileID mode
// against a loopback mock of OneProfileID's internal API, with synthetic users and temp folders.
// Nothing here talks to the real OneProfileID service or any real database.
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const MOCK=4396,APP=4397,BASE=`http://127.0.0.1:${APP}`,APP_ID='flygon-flow-fixture',SECRET='synthetic-fixture-secret-0123456789abcdef';
const USERS={
  // The owner starts without a membership: the first sign-in bootstraps it.
  'owner@example.test':{id:'u-owner',name:'Example Owner',pw:'synthetic-pass-owner',member:false},
  'other@example.test':{id:'u-other',name:'Other Person',pw:'synthetic-pass-other',member:true},
  'mfa@example.test':{id:'u-mfa',name:'Mfa Person',pw:'synthetic-pass-mfa',member:true,mfa:true},
  'nomember@example.test':{id:'u-none',name:'No Member',pw:'synthetic-pass-none',member:false},
  // Invitees: an existing OneProfileID user with two-factor, and a brand-new account.
  'casey@example.test':{id:'u-casey',name:'Casey Sample',pw:'synthetic-pass-casey',member:false,mfa:true},
  'newbie@example.test':{id:'u-newbie',name:'New Person',pw:'synthetic-pass-newbie',member:false},
  'revoked@example.test':{id:'u-revoked',name:'Revoked Person',pw:'synthetic-pass-revoked',member:false},
  // One central person with a verified alias (like two addresses belonging to the same person).
  'alias.primary@example.test':{id:'u-alias',name:'Alias Person',pw:'synthetic-pass-alias',member:false,mfa:true,aliases:['alias.second@example.test']},
};
// Mock OneProfileID internal API (only what Flygon Flow calls).
function mockOpid(){
  const sessions=new Map(),challenges=new Map(),claims=[];
  const cookie=(req,name)=>(String(req.headers.cookie||'').match(new RegExp(`(?:^|; )oneprofileid\\.${name}=([^;]+)`))||[])[1];
  const identity=u=>({user:{id:u.id,email:Object.keys(USERS).find(k=>USERS[k]===u),name:u.name,image:u.image||null},session:{id:randomUUID()},memberships:u.member?[{localId:u.localId||u.id}]:[]});
  const srv=http.createServer((req,res)=>{
    let body='';req.on('data',c=>body+=c);req.on('end',()=>{
      const send=(code,obj,set=[])=>{res.writeHead(code,{'content-type':'application/json',...(set.length?{'set-cookie':set}:{})});res.end(JSON.stringify(obj))};
      if(req.headers['x-opid-app']!==APP_ID||req.headers['x-opid-client-secret']!==SECRET||req.headers.origin!==BASE)return send(401,{error:'Unknown application'});
      const path=req.url.replace('/internal/v1/auth',''),b=body?JSON.parse(body):{};
      if(path==='/sign-in/email'){
        const u=USERS[b.email];if(!u||u.pw!==b.password)return send(401,{error:'Invalid email or password'});
        if(u.mfa){const t=randomUUID();challenges.set(t,u);return send(200,{twoFactorRedirect:true},[`oneprofileid.two_factor=${t}; Path=/; HttpOnly; SameSite=Lax; Domain=127.0.0.1`])}
        const t=randomUUID();sessions.set(t,u);return send(200,identity(u),[`oneprofileid.session_token=${t}; Path=/; HttpOnly; SameSite=Lax`]);
      }
      if(path==='/two-factor/verify-totp'){
        const u=challenges.get(cookie(req,'two_factor'));if(!u||b.code!=='123456')return send(401,{error:'Invalid code'});
        const t=randomUUID();sessions.set(t,u);return send(200,identity(u),[`oneprofileid.session_token=${t}; Path=/; HttpOnly; SameSite=Lax`,'oneprofileid.two_factor=; Path=/; Max-Age=0']);
      }
      if(path==='/get-session'){const u=sessions.get(cookie(req,'session_token'));return u?send(200,identity(u)):send(401,{error:'No session'})}
      if(path==='/profile/image'){
        const u=sessions.get(cookie(req,'session_token'));if(!u||!u.member)return send(403,{error:'Membership required'});
        u.image=b.image;return send(200,{image:u.image});
      }
      if(path==='/membership/claim'){const u=sessions.get(cookie(req,'session_token'));if(!u)return send(401,{error:'Complete sign-in first'});
        const mail=Object.keys(USERS).find(k=>USERS[k]===u),resolved=Object.keys(USERS).find(k=>k===b.claimedEmail||USERS[k].aliases?.includes(b.claimedEmail));
        if(resolved!==mail||!/^[A-Za-z0-9_-]{1,128}$/.test(b.localId||'')||(b.localId==='owner'&&mail!=='owner@example.test'))return send(403,{error:'Sign in with the email used for this registration'});
        u.member=true;u.localId=b.localId;claims.push({...b,email:mail});return send(200,{membership:{localId:b.localId}})}
      if(path==='/sign-out'){sessions.delete(cookie(req,'session_token'));return send(200,{success:true},['oneprofileid.session_token=; Path=/; Max-Age=0'])}
      send(404,{error:'Not found'});
    });
  });
  return {srv,claims,revoke:email=>{for(const [t,u] of sessions)if(USERS[email]===u)sessions.delete(t)}};
}
// A tiny cookie jar per browser.
function agent(){
  const jar=new Map();
  const call=async(method,path,body)=>{
    const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json',cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')},body:body===undefined?undefined:JSON.stringify(body)});
    const set=r.headers.getSetCookie();
    for(const c of set){const [pair,...attrs]=c.split(';'),name=pair.slice(0,pair.indexOf('=')).trim(),value=pair.slice(pair.indexOf('=')+1);if(/max-age=0/i.test(attrs.join(';'))||!value)jar.delete(name);else jar.set(name,value)}
    let data=null;try{data=await r.json()}catch{}
    return {status:r.status,data,set};
  };
  return {call,jar};
}
const workspace=env=>({active:'c1',charts:[{id:'c1',name:'Fixture chart',nodes:[],edges:[]}],...(env?{environment:env}:{})});
const start=(env)=>{const p=spawn(process.execPath,['server.mjs'],{cwd:fileURLToPath(new URL('.',import.meta.url)),env:{...process.env,FLOW_SYNC_URL:'',FLOW_SYNC_TOKEN:'',DATABASE_URL:'',...env}});return p};

export async function authChecks(assert){
  const dir=mkdtempSync(join(tmpdir(),'ocs-auth-'));
  const mock=mockOpid();await new Promise(r=>mock.srv.listen(MOCK,'127.0.0.1',r));
  // A save made before environments existed (no environment field) belongs to Default workspace.
  const legacy=randomUUID();mkdirSync(join(dir,'saves'),{recursive:true});
  writeFileSync(join(dir,'saves',`2026-01-01T00-00-00-000Z_${legacy}.json`),JSON.stringify({id:legacy,at:'2026-01-01T00:00:00.000Z',label:'Legacy',charts:1,items:0,data:workspace()}));
  const mailLog=join(dir,'mail.jsonl');
  const env={FLOW_EMAIL_TRANSPORT:'file:'+mailLog,FLOW_EMAIL_FROM:'Flow <noreply@example.test>',PORT:String(APP),ORG_CHART_VERIFY:'1',SAVES_DIR:join(dir,'saves'),BACKUP_DIR:join(dir,'backups'),OPID_BASE_URL:`http://127.0.0.1:${MOCK}`,OPID_APP_ID:APP_ID,OPID_APP_SECRET:SECRET,OPID_APP_ORIGIN:BASE};
  // Binding: local mode refuses a public HOST; OPID mode listens on 0.0.0.0 by default.
  const pub=start({...env,PORT:'4394',HOST:'0.0.0.0',OPID_BASE_URL:'',OPID_APP_ID:'',OPID_APP_SECRET:'',OPID_APP_ORIGIN:''});let pubErr='';pub.stderr.on('data',d=>pubErr+=d);
  assert(await new Promise(r=>{pub.once('exit',c=>r(c!==0&&/Refusing to listen/.test(pubErr)));setTimeout(()=>{pub.kill();r(false)},4000)}),'deploy: local mode refuses to listen on a public address');
  const half=start({...env,PORT:'4395',OPID_APP_SECRET:''});
  assert(await new Promise(r=>{half.once('exit',c=>r(c!==0));setTimeout(()=>{half.kill();r(false)},4000)}),'auth: a partial OPID_* configuration refuses to start');
  const app=start(env);let log='';app.stdout.on('data',d=>log+=d);
  try{
    await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('OPID-mode server did not start')))});
    assert(/OneProfileID sign-in/.test(log)&&/listening on 0\.0\.0\.0:4397/.test(log),'auth/deploy: with OPID_* set the server reports OneProfileID mode and listens on 0.0.0.0');
    let owner=agent();const other=agent(),anon=agent();
    let r=await anon.call('GET','/api/auth/session');
    assert(r.data?.mode==='opid'&&r.data.user===null,'auth: session is empty before sign-in');
    assert((await anon.call('GET','/api/saves')).status===401&&(await anon.call('PUT','/api/backups/fixture',workspace())).status===401,'auth: saves and backups need a signed-in user');
    r=await owner.call('POST','/api/auth/sign-in',{email:'owner@example.test',password:'wrong'});
    assert(r.status===401&&r.data?.error==='Incorrect email or password.','auth: a wrong password is refused with an inline error');
    r=await owner.call('POST','/api/auth/sign-in',{email:'owner@example.test',password:'synthetic-pass-owner'});
    const sid=r.set.find(c=>c.startsWith('flow_sid='))||'';
    assert(mock.claims.length===1&&mock.claims[0].localId==='owner'&&mock.claims[0].claimedEmail==='owner@example.test','auth: the owner\'s first sign-in claims the owner membership');
    assert(r.status===200&&r.data?.user?.email==='owner@example.test'&&/HttpOnly/i.test(sid)&&/SameSite=Lax/i.test(sid)&&!/Secure/i.test(sid)&&owner.jar.has('oneprofileid.session_token'),'auth: sign-in sets an httpOnly SameSite=Lax session and forwards the central cookie');
    assert(!JSON.stringify(r.data).includes(SECRET)&&!JSON.stringify(r.data).includes(owner.jar.get('oneprofileid.session_token')),'auth: no secret or central token reaches the browser body');
    const portrait='data:image/webp;base64,YWNjb3VudA==';
    assert((await anon.call('POST','/api/auth/profile/image',{image:portrait})).status===401,'photo: anonymous writes refused');
    assert((await owner.call('POST','/api/auth/profile/image',{image:portrait,userId:'u-other'})).status===400,'photo: target identity injection refused');
    assert((await owner.call('POST','/api/auth/profile/image',{image:'data:image/svg+xml;base64,PHN2Zz4='})).status===400,'photo: SVG refused');
    assert((await owner.call('POST','/api/auth/profile/image',{image:portrait})).data?.image===portrait,'photo: photo writes through to central account');
    assert((await owner.call('GET','/api/auth/session')).data?.user?.image===portrait,'photo: central raster data URI appears in current session');
    const largePortrait='data:image/webp;base64,'+'A'.repeat(749976);
    assert((await owner.call('POST','/api/auth/profile/image',{image:largePortrait})).data?.image===largePortrait,'photo: near-limit raster image passes real Flow HTTP body parser');
    USERS['owner@example.test'].image='data:image/png;base64,Y2hhbmdlZA==';
    assert((await owner.call('GET','/api/auth/session')).data?.user?.image===USERS['owner@example.test'].image,'photo: changes in other apps refresh without signing in again');
    assert((await owner.call('POST','/api/auth/profile/image',{image:null})).status===200&&!(await owner.call('GET','/api/auth/session')).data?.user?.image,'photo: removal clears shared photo');
    r=await owner.call('GET','/api/saves');
    assert(r.status===200&&r.data.saves.some(s=>s.id===legacy&&s.env.id==='default-workspace'),"auth: a save from before environments is listed for Owner as Default workspace");
    r=await owner.call('POST','/api/saves',workspace());const ownerSave=r.data?.id;
    assert(r.status===200&&r.data.env.id==='default-workspace'&&r.data.env.visibility==='private'&&r.data.env.owner==='owner@example.test',"auth: Owner saves into Default workspace (private)");
    assert((await owner.call('PUT','/api/backups/owner-browser',workspace())).status===200,'auth: Owner can back up his environment');
    await other.call('POST','/api/auth/sign-in',{email:'other@example.test',password:'synthetic-pass-other'});
    r=await other.call('GET','/api/saves');
    assert(r.status===200&&!r.data.saves.some(s=>s.id===ownerSave||s.id===legacy),"auth: another user does not see Owner's private saves");
    assert((await other.call('GET','/api/saves/'+ownerSave)).status===404&&(await other.call('GET','/api/saves/'+legacy)).status===404,'auth: loading a private save of someone else is 404');
    assert((await other.call('PUT','/api/backups/x',workspace())).status===404&&(await other.call('POST','/api/saves',workspace({id:'default-workspace',name:'Mine now',visibility:'public'}))).status===404,"auth: writing into Owner's private environment is 404, even claiming it is public");
    const theirs={id:'other-env',name:'Other space',visibility:'private'};
    r=await other.call('POST','/api/saves',workspace(theirs));const otherSave=r.data?.id;
    assert(r.status===200&&r.data.env.owner==='other@example.test'&&(await other.call('GET','/api/saves/'+otherSave)).data.data.environment.ownerEmail==='other@example.test','auth: a new environment is owned by whoever first saves it, and the stored copy records that owner');
    assert(!(await owner.call('GET','/api/saves')).data.saves.some(s=>s.id===otherSave)&&(await owner.call('GET','/api/saves/'+otherSave)).status===404,"auth: the owner's private environment is hidden from Owner too");
    await other.call('POST','/api/saves',workspace({...theirs,visibility:'public'}));
    assert((await owner.call('GET','/api/saves')).data.saves.some(s=>s.id===otherSave)&&(await owner.call('GET','/api/saves/'+otherSave)).status===200,'auth: a public environment is readable by other signed-in users');
    assert((await owner.call('POST','/api/saves',workspace({...theirs,visibility:'public'}))).status===403,'auth: a public environment is read-only for non-owners (403)');
    const mfa=agent();r=await mfa.call('POST','/api/auth/sign-in',{email:'mfa@example.test',password:'synthetic-pass-mfa'});
    assert(r.status===200&&r.data.step==='verify'&&!mfa.jar.has('flow_sid'),'auth: two-factor accounts get a verify step and no session yet');
    assert((await mfa.call('POST','/api/auth/two-factor',{code:'000000'})).status===401,'auth: a wrong two-factor code is refused');
    r=await mfa.call('POST','/api/auth/two-factor',{code:'123456'});
    assert(r.status===200&&r.data.user.email==='mfa@example.test'&&mfa.jar.has('flow_sid'),'auth: the right two-factor code completes sign-in');
    r=await agent().call('POST','/api/auth/sign-in',{email:'nomember@example.test',password:'synthetic-pass-none'});
    assert(r.status===403&&/access/.test(r.data.error)&&mock.claims.length===1,'auth: an account without Flygon Flow membership is refused (no bootstrap for non-owners)');
    mock.revoke('other@example.test');
    assert((await other.call('GET','/api/saves')).status===401,'auth: a central sign-out or revocation ends the app session on the next request');
    r=await owner.call('POST','/api/auth/sign-out',{});
    assert(r.status===200&&r.set.some(c=>/^flow_sid=;.*Max-Age=0/i.test(c))&&(await owner.call('GET','/api/auth/session')).data.user===null&&(await owner.call('GET','/api/saves')).status===401,'auth: sign-out clears the session');
    assert((await fetch(BASE+'/api/auth/sign-in',{method:'POST',headers:{'content-type':'application/json',origin:'http://evil.example'},body:'{}'})).status===403,'auth: sign-in rejects other origins');
    // App invites + own environments (#277): invitees claim their own membership and get a private workspace.
    owner=agent();await owner.call('POST','/api/auth/sign-in',{email:'owner@example.test',password:'synthetic-pass-owner'});
    const casey=agent();
    r=await casey.call('POST','/api/auth/sign-in',{email:'casey@example.test',password:'synthetic-pass-casey'});
    r=await casey.call('POST','/api/auth/two-factor',{code:'123456'});
    assert(r.status===403,'invites: without an invite an existing OneProfileID user has no access');
    const otherAgent=agent();await otherAgent.call('POST','/api/auth/sign-in',{email:'mfa@example.test',password:'synthetic-pass-mfa'});await otherAgent.call('POST','/api/auth/two-factor',{code:'123456'});
    assert((await otherAgent.call('POST','/api/invites',{email:'x@example.test'})).status===403,'invites: only the owner can invite');
    r=await owner.call('POST','/api/invites',{email:'Casey@Example.test'});
    const mails=()=>{try{return readFileSync(mailLog,'utf8').trim().split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l))}catch{return []}};
    const m1=mails().at(-1);
    assert(r.status===200&&r.data.invite.email==='casey@example.test'&&r.data.sent===true&&m1?.to==='casey@example.test'&&m1.subject==="You're invited to Flygon Flow"&&m1.html.includes('Sign in to Flow')&&m1.html.includes(BASE)&&m1.text.includes('OneProfileID')&&m1.from==='Flow <noreply@example.test>','invites: inviting sends a branded email (test transport, nothing leaves the machine)');
    r=await owner.call('POST','/api/invites',{email:'casey@example.test',resend:true});
    const r2=await owner.call('POST','/api/invites',{email:'casey@example.test',resend:true}),r3=await owner.call('POST','/api/invites',{email:'casey@example.test',resend:true});
    assert(r.data.sent===true&&r2.data.sent===true&&r3.data.sent===false&&/several times/.test(r3.data.emailError)&&mails().filter(m=>m.to==='casey@example.test').length===3,'invites: resend works and sends to one person are rate-limited');
    assert((await owner.call('POST','/api/invites',{email:'nobody@example.test',resend:true})).status===404,'invites: resend needs an open invite');
    for(const e of ['newbie@example.test','revoked@example.test'])await owner.call('POST','/api/invites',{email:e});
    await owner.call('DELETE','/api/invites?email=revoked@example.test');
    r=await casey.call('POST','/api/auth/sign-in',{email:'casey@example.test',password:'synthetic-pass-casey'});
    assert(r.data.step==='verify','invites: an existing user still completes two-factor first');
    r=await casey.call('POST','/api/auth/two-factor',{code:'123456'});
    const jc=mock.claims.find(c=>c.email==='casey@example.test');
    assert(r.status===200&&jc&&jc.localId!=='owner'&&jc.localId.startsWith('u-')&&jc.claimedEmail==='casey@example.test','invites: an existing user claims their own membership (not owner), matched to the signed-in email');
    r=await casey.call('GET','/api/workspace');const jEnv=r.data.env;
    assert(r.status===200&&jEnv&&jEnv!=='default-workspace'&&r.data.data.charts.length===1&&!r.data.data.charts[0].nodes.length,'environments: an invitee starts in their own empty private environment');
    assert((await casey.call('GET','/api/workspace?env=default-workspace')).status===404&&(await casey.call('PUT','/api/workspace?env=default-workspace',{baseRev:0,data:workspace()})).status===404,"environments: an invitee cannot read or write Default workspace");
    assert((await owner.call('GET','/api/workspace?env='+jEnv)).status===404&&!(await owner.call('GET','/api/environments')).data.environments.some(e=>e.id===jEnv),"environments: Owner cannot see the invitee's environment");
    r=await casey.call('POST','/api/environments',{name:'Second'});const second=r.data.id;
    await casey.call('PATCH','/api/environments/'+second,{name:'Renamed'});
    let list=(await casey.call('GET','/api/environments')).data.environments;
    assert(list.length===2&&list.some(e=>e.id===second&&e.name==='Renamed')&&list.every(e=>e.id!=='default-workspace'),'environments: create, rename and list your own');
    r=await casey.call('DELETE','/api/environments/'+second);
    list=(await casey.call('GET','/api/environments')).data.environments;
    assert(r.status===200&&list.length===1&&(await casey.call('GET','/api/workspace?env='+second)).status===404&&(await casey.call('DELETE','/api/environments/'+jEnv)).status===400,'environments: archive hides one (data kept); the last one cannot be removed');
    assert((await owner.call('DELETE','/api/environments/default-workspace')).status===400&&(await casey.call('PATCH','/api/environments/default-workspace',{name:'x'})).status===404,"environments: Default workspace cannot be archived, and nobody else can rename it");
    const newbie=agent();r=await newbie.call('POST','/api/auth/sign-in',{email:'newbie@example.test',password:'synthetic-pass-newbie'});
    const nEnv=(await newbie.call('GET','/api/workspace')).data.env;
    assert(r.status===200&&nEnv&&nEnv!==jEnv&&nEnv!=='default-workspace'&&(await newbie.call('GET','/api/workspace?env='+jEnv)).status===404,'invites: a brand-new account also gets its own isolated environment');
    r=await agent().call('POST','/api/auth/sign-in',{email:'revoked@example.test',password:'synthetic-pass-revoked'});
    assert(r.status===403,'invites: a revoked invite gives no access');
    // An invite to a verified alias works: the person signs in (with 2FA) and the alias invite is claimed.
    await owner.call('POST','/api/invites',{email:'alias.second@example.test'});
    const ali=agent();await ali.call('POST','/api/auth/sign-in',{email:'alias.primary@example.test',password:'synthetic-pass-alias'});
    r=await ali.call('POST','/api/auth/two-factor',{code:'123456'});
    const ac=mock.claims.find(c=>c.email==='alias.primary@example.test');
    assert(r.status===200&&ac?.claimedEmail==='alias.second@example.test'&&(await ali.call('GET','/api/workspace')).data.env!=='default-workspace','invites: an invite to a verified alias of the person is accepted');
    assert(!mock.claims.some(c=>c.email!=='alias.primary@example.test'&&c.claimedEmail==='alias.second@example.test'),'invites: nobody else can claim an alias invite');
    list=(await owner.call('GET','/api/invites')).data.invites;
    assert(list.find(i=>i.email==='casey@example.test')?.claimedAt&&list.find(i=>i.email==='revoked@example.test')?.revokedAt,'invites: the owner sees who joined and who was revoked');
    // Persistent sessions: with Postgres, a sign-in survives a server restart (a deploy).
    app.kill();await new Promise(r=>setTimeout(r,400));
    let pg=null;const pgProcs=[];
    try{
      const {default:EmbeddedPostgres}=await import('embedded-postgres');
      pg=new EmbeddedPostgres({databaseDir:join(dir,'pg'),user:'flow',password:'flow-verify',port:54332,persistent:false,onLog:()=>{},onError:()=>{}});
      await pg.initialise();await pg.start();await pg.createDatabase('flow');
      const dbEnv={...env,DATABASE_URL:'postgres://flow:flow-verify@127.0.0.1:54332/flow',FLOW_ALLOW_DB_IN_VERIFY:'1'};
      const up=async()=>{const p=start(dbEnv);pgProcs.push(p);await new Promise((res,rej)=>{p.stdout.once('data',res);p.once('exit',()=>rej(Error('server did not start')))});return p};
      let srv=await up();
      const keep=agent();r=await keep.call('POST','/api/auth/sign-in',{email:'owner@example.test',password:'synthetic-pass-owner'});
      const raw=keep.jar.get('flow_sid');
      srv.kill();await new Promise(r=>setTimeout(r,400));srv=await up();
      assert(r.status===200&&(await keep.call('GET','/api/auth/session')).data.user?.email==='owner@example.test','sessions: a sign-in survives a server restart when Postgres is configured');
      const c=pg.getPgClient('flow');await c.connect();
      const rows=(await c.query('select id_hash from flygon_flow_sessions')).rows;
      assert(rows.length===1&&rows[0].id_hash!==raw&&!JSON.stringify(rows).includes(raw),'sessions: only a hash of the session id is stored');
      await keep.call('POST','/api/auth/sign-out',{});
      assert((await c.query('select count(*)::int n from flygon_flow_sessions')).rows[0].n===0,'sessions: sign-out deletes the stored session');
      await c.end();
    }finally{for(const p of pgProcs)p.kill();await new Promise(r=>setTimeout(r,300));try{await pg?.stop()}catch{}}
  }finally{app.kill();half.kill();mock.srv.close();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},500)}
}
