// Sign in with your phone through the real server in OneProfileID mode, against a loopback mock of
// OneProfileID (internal API, device code and token endpoints). Synthetic users and temp folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const MOCK=4386,APP=4387,BASE=`http://127.0.0.1:${APP}`,APP_ID='flygon-flow-fixture',SECRET='synthetic-fixture-secret-0123456789abcdef';
const SSO_ID='flow-sso-fixture',SSO_SECRET='synthetic-sso-secret-0123456789abcdef-0123';

function mock(){
  const codes=new Map(),sessions=new Map();let n=0;
  const users={member:{id:'u-member',email:'member@example.test',name:'Member',member:true},stranger:{id:'u-stranger',email:'stranger@example.test',name:'Stranger',member:false}};
  const srv=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    const send=(code,obj,set=[])=>{res.writeHead(code,{'content-type':'application/json',...(set.length?{'set-cookie':set}:{})});res.end(JSON.stringify(obj))};
    const path=req.url.split('?')[0];
    if(path==='/api/auth/device/code'||path==='/api/auth/oauth2/token'){
      if(req.headers.authorization!=='Basic '+Buffer.from(`${SSO_ID}:${SSO_SECRET}`).toString('base64'))return send(401,{error:'invalid_client'});
      const f=Object.fromEntries(new URLSearchParams(body));
      if(path==='/api/auth/device/code'){const dc='dc-'+(++n),uc='CODE000'+n;codes.set(dc,{uc,status:'pending'});
        return send(200,{device_code:dc,user_code:uc,verification_uri:`http://127.0.0.1:${MOCK}/device`,verification_uri_complete:`http://127.0.0.1:${MOCK}/device?user_code=${uc}`,expires_in:900,interval:1})}
      const c=codes.get(f.device_code);if(!c)return send(400,{error:'invalid_grant'});
      if(c.status==='pending')return send(400,{error:'authorization_pending'});
      if(c.status==='denied')return send(400,{error:'access_denied'});
      codes.delete(f.device_code);return send(200,{access_token:'at-'+c.user,token_type:'Bearer',expires_in:120});
    }
    if(req.headers['x-opid-app']!==APP_ID||req.headers['x-opid-client-secret']!==SECRET)return send(401,{error:'Unknown application'});
    const route=path.replace('/internal/v1/auth',''),b=body?JSON.parse(body):{};
    const identity=u=>({user:{id:u.id,email:u.email,name:u.name,image:null},session:{id:'s'},memberships:u.member?[{localId:u.id}]:[]});
    if(route==='/sso/device-exchange'){
      if(b.clientId!==SSO_ID||!/^at-/.test(b.accessToken||''))return send(401,{error:'Device sign-in is unavailable'});
      const u=users[b.accessToken.slice(3)],t='tok-'+(++n);sessions.set(t,u);
      return send(200,identity(u),[`oneprofileid.session_token=${t}; Path=/; HttpOnly; SameSite=Lax`]);
    }
    if(route==='/get-session'){const t=(String(req.headers.cookie||'').match(/oneprofileid\.session_token=([^;]+)/)||[])[1],u=sessions.get(t);return u?send(200,identity(u)):send(401,{error:'No session'})}
    send(404,{error:'Not found'});
  })});
  const approve=(uc,user,status='approved')=>{for(const c of codes.values())if(c.uc===uc){c.status=status;c.user=user}};
  return {srv,approve};
}
function browser(){
  const jar=new Map();
  const call=async(method,path)=>{
    const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json',origin:BASE,cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; ')},body:method==='POST'?'{}':undefined});
    for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],name=pair.slice(0,pair.indexOf('=')),value=pair.slice(pair.indexOf('=')+1);if(/max-age=0/i.test(c)||!value)jar.delete(name);else jar.set(name,value)}
    let data=null;try{data=await r.json()}catch{}
    return {status:r.status,data};
  };
  return {call,jar};
}
const until=async(fn,ms=8000)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)return null;await new Promise(r=>setTimeout(r,300))}};

test('sign in with your phone, end to end through the server',async t=>{
  const m=mock();await new Promise(r=>m.srv.listen(MOCK,'127.0.0.1',r));
  const dir=mkdtempSync(join(tmpdir(),'flow-device-'));
  const app=spawn(process.execPath,['server.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,FLOW_SYNC_URL:'',FLOW_SYNC_TOKEN:'',DATABASE_URL:'',
    PORT:String(APP),ORG_CHART_VERIFY:'1',SAVES_DIR:join(dir,'saves'),BACKUP_DIR:join(dir,'backups'),OWNER_EMAIL:'owner@example.test',
    OPID_BASE_URL:`http://127.0.0.1:${MOCK}`,OPID_APP_ID:APP_ID,OPID_APP_SECRET:SECRET,OPID_APP_ORIGIN:BASE,
    OPID_SSO_CLIENT_ID:SSO_ID,OPID_SSO_CLIENT_SECRET:SSO_SECRET,OPID_SSO_ISSUER:`http://127.0.0.1:${MOCK}/api/auth`},stdio:['ignore','pipe','pipe']});
  let log='';app.stdout.on('data',d=>log+=d);app.stderr.on('data',d=>log+=d);
  t.after(()=>{app.kill();m.srv.close();rmSync(dir,{recursive:true,force:true})});
  assert.ok(await until(async()=>{try{return (await fetch(BASE+'/api/auth/session')).ok}catch{return false}}),'server started');

  const screen=browser(),phoneless=browser();
  assert.equal((await screen.call('GET','/api/auth/session')).data.device,true,'the sign-in screen offers it');
  // Cross-site requests are refused like every other auth route.
  assert.equal((await fetch(BASE+'/api/auth/device/start',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403);
  let r=await screen.call('POST','/api/auth/device/start');
  assert.equal(r.status,200);assert.match(r.data.qr,/^<svg/);assert.ok(screen.jar.has('flow_device'));
  const code=r.data.userCode;
  await new Promise(res=>setTimeout(res,1100));
  assert.equal((await screen.call('POST','/api/auth/device/poll')).data.status,'pending');
  m.approve(code,'member');
  // Another browser cannot take over the sign-in.
  assert.equal((await phoneless.call('POST','/api/auth/device/poll')).data.status,'missing');
  r=await until(async()=>{const x=await screen.call('POST','/api/auth/device/poll');return x.data?.status==='done'?x:null});
  assert.ok(r,'the screen finishes signing in');
  assert.equal(r.data.user.email,'member@example.test');
  assert.ok(screen.jar.has('flow_sid')&&screen.jar.has('oneprofileid.session_token')&&!screen.jar.has('flow_device'));
  assert.equal((await screen.call('GET','/api/auth/session')).data.user.email,'member@example.test','signed in to Flow');
  assert.equal((await phoneless.call('GET','/api/auth/session')).data.user,null);
  assert.ok(!log.includes('CODE000')&&!log.includes('at-member')&&!log.includes('tok-'),'nothing sensitive is logged');

  // An account without a Flow membership is refused.
  const stranger=browser();
  r=await stranger.call('POST','/api/auth/device/start');m.approve(r.data.userCode,'stranger');
  r=await until(async()=>{const x=await stranger.call('POST','/api/auth/device/poll');return x.data?.status&&x.data.status!=='pending'?x:null});
  assert.equal(r.status,403);assert.equal(r.data.status,'refused');assert.ok(!stranger.jar.has('flow_sid'));

  // Denied on the phone.
  const denied=browser();
  r=await denied.call('POST','/api/auth/device/start');m.approve(r.data.userCode,'member','denied');
  r=await until(async()=>{const x=await denied.call('POST','/api/auth/device/poll');return x.data?.status&&x.data.status!=='pending'?x:null});
  assert.equal(r.data.status,'denied');assert.ok(!denied.jar.has('flow_sid'));
});
