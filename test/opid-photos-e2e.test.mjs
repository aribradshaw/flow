// OneProfileID photos end to end (docs/concepts/10-opid-photos.md): synthetic users on a real server in
// OneProfileID mode against a loopback mock. Linking through POST /api/opid/link (own cards and cards
// shared with you), the save guard, GET /api/opid/photos with its membership and access filter, and
// failing quietly when OneProfileID refuses. Temp folders only; DATABASE_URL and FLOW_SYNC_URL blanked.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const MOCK=4366,APP=4367,BASE=`http://127.0.0.1:${APP}`,APP_ID='flygon-flow-photo-fixture',SECRET='synthetic-photo-secret-0123456789abcdef',TOKEN='photo-e2e-token-0123456789abcdefghijklmnop';
const OWNER='owner@example.test',BO='bo@example.test',KIM='kim@example.test';
const USERS={[OWNER]:{id:'u-owner',name:'Example Owner',pw:'pw-owner',localId:'owner'},[BO]:{id:'u-bo',name:'Bo Marsh',pw:'pw-bo',localId:'u-bo'},[KIM]:{id:'u-kim',name:'Kim',pw:'pw-kim',localId:'u-kim'}};
const photo=id=>`data:image/png;base64,${Buffer.from('photo-of-'+id).toString('base64')}`;
let refuse=false;const asked=[];
function mockOpid(){
  const sessions=new Map();
  const cookie=req=>(String(req.headers.cookie||'').match(/(?:^|; )oneprofileid\.session_token=([^;]+)/)||[])[1];
  const identity=u=>({user:{id:u.id,email:Object.keys(USERS).find(k=>USERS[k]===u),name:u.name},session:{id:randomUUID()},memberships:[{localId:u.localId}]});
  return http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    const send=(code,obj,set=[])=>{res.writeHead(code,{'content-type':'application/json',...(set.length?{'set-cookie':set}:{})});res.end(JSON.stringify(obj))};
    const path=req.url.replace('/internal/v1/auth',''),b=body?JSON.parse(body):{};
    if(path==='/sign-in/email'){const u=USERS[b.email];if(!u||u.pw!==b.password)return send(401,{error:'Invalid'});const t=randomUUID();sessions.set(t,u);return send(200,identity(u),[`oneprofileid.session_token=${t}; Path=/; HttpOnly`])}
    if(path==='/get-session'){const u=sessions.get(cookie(req));return u?send(200,identity(u)):send(401,{error:'No session'})}
    if(path==='/profile/member-images'){
      if(!sessions.get(cookie(req)))return send(401,{error:'No session'});
      // Before the app's registration allows member photo reads, OneProfileID refuses.
      if(refuse)return send(403,{error:'Member images are not enabled for this app'});
      asked.push(b.userIds);
      return send(200,{images:Object.fromEntries(b.userIds.filter(id=>id!=='u-kim').map(id=>[id,photo(id)]))});
    }
    send(404,{error:'Not found'});
  })});
}
function agent(){
  const jar=new Map();
  return async(method,path,body,headers={})=>{
    const r=await fetch(BASE+path,{method,headers:{'content-type':'application/json',cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    for(const c of r.headers.getSetCookie()){const [pair]=c.split(';'),i=pair.indexOf('=');jar.set(pair.slice(0,i).trim(),pair.slice(i+1))}
    let data=null;try{data=await r.json()}catch{}
    return {status:r.status,data};
  };
}
const N=(id,name,type='entity',extra={})=>({id,name,type,x:0,y:0,...extra});
const fixture=()=>({active:'c1',environment:{id:'default-workspace',name:'Default workspace',ownerEmail:OWNER,visibility:'private',members:[]},
  charts:[{id:'c1',name:'Team',nodes:[{...N('me','Example Owner','person'),email:OWNER},{...N('bo','Bo Marsh','person'),email:BO},N('co','Marsh Holdings LLC'),{...N('kim','Kim','person'),email:KIM},N('pat','Pat','person')],
    edges:[{id:'e1',from:'bo',to:'co',type:'ownership',percent:''}]}],projects:[],timeline:[]});
const node=(d,id)=>d.charts.flatMap(c=>c.nodes).find(n=>n.id===id);
const ENV='default-workspace';

let dir,mock,app,owner,bo,kim,boEnv,shareId;
before(async()=>{
  dir=mkdtempSync(join(tmpdir(),'ff-photo-e2e-'));
  mock=mockOpid();await new Promise(r=>mock.listen(MOCK,'127.0.0.1',r));
  app=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,FLOW_SYNC_URL:'',DATABASE_URL:'',FLOW_SYNC_TOKEN:TOKEN,PORT:String(APP),ORG_CHART_VERIFY:'1',OWNER_EMAIL:OWNER,
    BACKUP_DIR:join(dir,'backups'),SAVES_DIR:join(dir,'saves'),INBOX_DIR:join(dir,'inbox'),OPID_BASE_URL:`http://127.0.0.1:${MOCK}`,OPID_APP_ID:APP_ID,OPID_APP_SECRET:SECRET,OPID_APP_ORIGIN:BASE}});
  let err='';app.stderr.on('data',d=>err+=d);
  await new Promise((res,rej)=>{app.stdout.once('data',res);app.once('exit',()=>rej(Error('server did not start: '+err)))});
  owner=agent();bo=agent();kim=agent();
  for(const [a,e,pw] of [[owner,OWNER,'pw-owner'],[bo,BO,'pw-bo'],[kim,KIM,'pw-kim']])assert.equal((await a('POST','/api/auth/sign-in',{email:e,password:pw})).status,200);
  assert.equal((await owner('PUT','/api/workspace?env='+ENV,{baseRev:0,data:fixture()})).status,200);
  assert.equal((await owner('GET','/api/workspace?env='+ENV)).status,200);
  boEnv=(await bo('GET','/api/workspace')).data.env;
  assert.ok(boEnv&&boEnv!==ENV);
});
after(()=>{app?.kill();mock?.close();setTimeout(()=>{try{rmSync(dir,{recursive:true,force:true})}catch{}},300)});

test("a save cannot link a card to someone else's account; the owner token cannot add links",async()=>{
  const w=(await owner('GET','/api/workspace?env='+ENV)).data,d=structuredClone(w.data);
  node(d,'bo').opidUser='u-bo';node(d,'kim').opidUser='u-kim';
  const r=await owner('PUT','/api/workspace?env='+ENV,{baseRev:w.rev,data:d});
  assert.equal(r.status,200);assert.deepEqual(r.data.opidRefused.sort(),['bo','kim']);
  let after=(await owner('GET','/api/workspace?env='+ENV)).data;
  assert.equal(node(after.data,'bo').opidUser,undefined);assert.equal(node(after.data,'kim').opidUser,undefined);
  const t=structuredClone(after.data);node(t,'me').opidUser='u-owner';
  const tok=await fetch(`${BASE}/api/workspace?env=${ENV}`,{method:'PUT',headers:{'content-type':'application/json',authorization:'Bearer '+TOKEN},body:JSON.stringify({baseRev:after.rev,data:t})});
  assert.equal(tok.status,200);assert.deepEqual((await tok.json()).opidRefused,['me']);
  after=(await owner('GET','/api/workspace?env='+ENV)).data;
  assert.equal(node(after.data,'me').opidUser,undefined);
});

test("nobody can claim a card that doesn't carry their email",async()=>{
  assert.equal((await owner('POST','/api/opid/link',{env:ENV,nodeId:'kim',link:true})).status,403,'another person\'s email');
  assert.equal((await owner('POST','/api/opid/link',{env:ENV,nodeId:'pat',link:true})).status,403,'no email on the card');
  const w=(await owner('GET','/api/workspace?env='+ENV)).data;
  assert.equal(node(w.data,'kim').opidUser,undefined);assert.equal(node(w.data,'pat').opidUser,undefined);
});

test('the owner links their own card; a save keeps it; photos come only for linked members',async()=>{
  assert.equal((await owner('POST','/api/opid/link',{env:ENV,nodeId:'me',link:true})).status,200);
  const w=(await owner('GET','/api/workspace?env='+ENV)).data;
  assert.equal(node(w.data,'me').opidUser,'u-owner');
  // An ordinary save from the browser (unchanged link) keeps it.
  const d=structuredClone(w.data);node(d,'co').name='Marsh Holdings';
  const r=await owner('PUT','/api/workspace?env='+ENV,{baseRev:w.rev,data:d});
  assert.equal(r.status,200);assert.equal(r.data.opidRefused,undefined);
  assert.equal(node((await owner('GET','/api/workspace?env='+ENV)).data.data,'me').opidUser,'u-owner');
  assert.deepEqual((await owner('GET','/api/opid/photos?env='+ENV)).data,{me:photo('u-owner')});
  // Bo has no access to the owner's workspace: he cannot link a card there.
  assert.equal((await bo('POST','/api/opid/link',{env:ENV,nodeId:'bo',link:true})).status,404);
  assert.deepEqual((await bo('GET','/api/opid/photos?env='+ENV)).data,{});
});

test('a share recipient links their card in the owner workspace; the owner sees their photo',async()=>{
  const s=await owner('POST','/api/shares',{env:ENV,recipientEmail:BO,scope:{kind:'person',nodeId:'bo'},permission:'view'});
  assert.equal(s.status,200,JSON.stringify(s.data));shareId=s.data.share.id;
  assert.equal((await bo('POST',`/api/shares/${shareId}/attach`,{env:boEnv})).status,200);
  const lid=`sh.${shareId}.bo`;
  let mine=(await bo('GET','/api/workspace?env='+boEnv)).data;
  assert.ok(node(mine.data,lid),'the shared card is in his workspace');
  assert.equal(node(mine.data,lid).linked.opidEmail,'match');
  assert.equal(node(mine.data,lid).email,undefined);
  // Only cards in the share's scope can be linked through it.
  assert.equal((await bo('POST','/api/opid/link',{env:boEnv,nodeId:`sh.${shareId}.kim`,link:true})).status,404);
  assert.equal((await bo('POST','/api/opid/link',{env:boEnv,nodeId:lid,link:true})).status,200);
  const o=(await owner('GET','/api/workspace?env='+ENV)).data;
  assert.equal(node(o.data,'bo').opidUser,'u-bo','the link is stored on the owner card');
  mine=(await bo('GET','/api/workspace?env='+boEnv)).data;
  assert.equal(node(mine.data,lid).opidUser,'u-bo','Bo sees his own link');
  assert.deepEqual((await owner('GET','/api/opid/photos?env='+ENV)).data,{me:photo('u-owner'),bo:photo('u-bo')});
  assert.deepEqual((await bo('GET','/api/opid/photos?env='+boEnv)).data,{[lid]:photo('u-bo'),['@'+OWNER]:photo('u-owner')},'Bo\'s card, and the owner\'s linked card outside the share on the member label');
  // Kim cannot claim Bo's card through the owner's workspace or anything else.
  assert.equal((await kim('POST','/api/opid/link',{env:boEnv,nodeId:lid,link:true})).status,404);
  // The photos are never stored with the workspace.
  assert.ok(!JSON.stringify((await owner('GET','/api/workspace?env='+ENV)).data).includes(photo('u-bo')));
});

test("a view recipient cannot unlink someone else's link, but can unlink their own",async()=>{
  const lid=`sh.${shareId}.bo`;
  assert.equal((await bo('POST','/api/opid/link',{env:boEnv,nodeId:lid,link:false})).status,200);
  assert.equal(node((await owner('GET','/api/workspace?env='+ENV)).data.data,'bo').opidUser,undefined);
  assert.equal((await bo('POST','/api/opid/link',{env:boEnv,nodeId:lid,link:true})).status,200);
  // A card linked to Bo, shared at view with Kim: she sees it is linked, not to whom, and cannot unlink it.
  const k=await owner('POST','/api/shares',{env:ENV,recipientEmail:KIM,scope:{kind:'person',nodeId:'bo'},permission:'view'});
  const kimEnv=(await kim('GET','/api/workspace')).data.env;
  assert.equal((await kim('POST',`/api/shares/${k.data.share.id}/attach`,{env:kimEnv})).status,200);
  const kl=`sh.${k.data.share.id}.bo`,kd=(await kim('GET','/api/workspace?env='+kimEnv)).data;
  assert.equal(node(kd.data,kl).opidUser,undefined);assert.equal(node(kd.data,kl).opidLinked,true);
  assert.ok(!JSON.stringify(kd).includes('u-bo'),"Bo's account id never reaches Kim");
  assert.equal((await kim('POST','/api/opid/link',{env:kimEnv,nodeId:kl,link:false})).status,403);
  assert.equal((await kim('POST','/api/opid/link',{env:kimEnv,nodeId:kl,link:true})).status,409,'linked to someone else');
  assert.deepEqual((await kim('GET','/api/opid/photos?env='+kimEnv)).data,{[kl]:photo('u-bo'),['@'+OWNER]:photo('u-owner')},'anyone who sees the card sees the photo, including a member whose card is outside the share');
  // An edit share can unlink it.
  assert.equal((await owner('PATCH','/api/shares/'+k.data.share.id,{permission:'edit'})).status,200);
  assert.equal((await kim('POST','/api/opid/link',{env:kimEnv,nodeId:kl,link:false})).status,200);
  assert.equal(node((await owner('GET','/api/workspace?env='+ENV)).data.data,'bo').opidUser,undefined);
  assert.equal((await bo('POST','/api/opid/link',{env:boEnv,nodeId:`sh.${shareId}.bo`,link:true})).status,200);
  assert.equal((await owner('DELETE','/api/shares/'+k.data.share.id)).status,200);
});

test('revoking access removes the photo; OneProfileID refusing means no photos, quietly',async()=>{
  assert.equal((await owner('DELETE','/api/shares/'+shareId)).status,200);
  assert.deepEqual((await owner('GET','/api/opid/photos?env='+ENV)).data,{me:photo('u-owner')},'Bo no longer has access');
  refuse=true;
  try{
    // Unlink and relink so the lookup is not served from the per-viewer cache.
    await owner('POST','/api/opid/link',{env:ENV,nodeId:'me',link:false});
    await owner('POST','/api/opid/link',{env:ENV,nodeId:'me',link:true});
    const r=await owner('GET','/api/opid/photos?env='+ENV);
    assert.equal(r.status,200);assert.deepEqual(r.data,{});
  }finally{refuse=false}
  assert.ok(asked.every(ids=>!ids.includes('u-kim')),'Kim never linked anything, so she is never looked up');
  assert.equal((await agent()('GET','/api/opid/photos?env='+ENV)).status,401);
  assert.equal((await owner('GET','/api/opid/photos?env='+ENV,undefined,{origin:'https://evil.example.test'})).status,403);
});

test('a view recipient can link and see their photo in an opened shared environment',async()=>{
  const {data,status}=await owner('POST','/api/shares',{env:ENV,recipientEmail:BO,scope:{kind:'environment'},permission:'view'});
  assert.equal(status,200);
  const env=`share-${data.share.id}`,id=`sh.${data.share.id}.bo`;
  const opened=(await bo('GET','/api/workspace?env='+env)).data;
  assert.equal(node(opened.data,id).linked.opidEmail,'match');
  assert.equal(node(opened.data,id).email,undefined);
  assert.equal(node(opened.data,`sh.${data.share.id}.kim`).linked.opidEmail,undefined);
  assert.equal((await kim('POST','/api/opid/link',{env,nodeId:id,link:true})).status,404);
  assert.equal((await bo('POST','/api/opid/link',{env,nodeId:'bo',link:true})).status,404);
  assert.equal((await bo('POST','/api/opid/link',{env,nodeId:`sh.${data.share.id}.kim`,link:true})).status,403);
  assert.equal((await bo('POST','/api/opid/link',{env,nodeId:id,link:true})).status,200);
  assert.deepEqual((await bo('GET','/api/opid/photos?env='+env)).data,{[id]:photo('u-bo'),[`sh.${data.share.id}.me`]:photo('u-owner')});
  assert.deepEqual((await kim('GET','/api/opid/photos?env='+env)).data,{});
  assert.equal((await owner('DELETE','/api/shares/'+data.share.id)).status,200);
  assert.equal((await bo('POST','/api/opid/link',{env,nodeId:id,link:false})).status,404);
  assert.deepEqual((await bo('GET','/api/opid/photos?env='+env)).data,{});
});
