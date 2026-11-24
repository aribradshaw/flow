// Apple Push Notification service (APNs) sender for the Flow app on iPhone and iPad (apps/ios).
// HTTP/2 with token authentication (a .p8 key), using only node:http2 and node:crypto.
//
// Off unless all four are set:
//   APNS_KEY      the .p8 key's contents (PEM; literal "\n" sequences are accepted), or APNS_KEY_FILE: its path
//   APNS_KEY_ID   the key's id (10 characters)
//   APNS_TEAM_ID  the Apple developer team id (10 characters)
//   APNS_TOPIC    the app's bundle id, e.g. com.flygonlc.flow
// APNS_URL overrides both hosts (tests point it at a local h2c server). Each device says whether it is a
// production or a sandbox (development build) device, and goes to that host.
//
// send() resolves to {ok, status, reason, gone}. gone: Apple says the token is no longer valid
// (410, BadDeviceToken, Unregistered), so the caller forgets that device. Never logs tokens or payloads.
import http2 from 'node:http2';
import {createSign,createPrivateKey} from 'node:crypto';
import {readFileSync} from 'node:fs';

const HOSTS={production:'https://api.push.apple.com',sandbox:'https://api.sandbox.push.apple.com'};
const TOKEN_TTL=50*60e3,ID=/^[A-Z0-9]{10}$/,TOPIC=/^[A-Za-z0-9.-]{1,155}$/,DEVICE=/^[0-9a-f]{64,200}$/;
const b64u=v=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url');

export function apnsConfig(env=process.env){
  let pem=env.APNS_KEY||'';
  if(!pem&&env.APNS_KEY_FILE)try{pem=readFileSync(env.APNS_KEY_FILE,'utf8')}catch{throw Error('APNS_KEY_FILE cannot be read')}
  const set=[pem,env.APNS_KEY_ID,env.APNS_TEAM_ID,env.APNS_TOPIC].filter(Boolean).length;
  if(!set)return null;
  if(set<4)throw Error('APNs is partly configured: set APNS_KEY (or APNS_KEY_FILE), APNS_KEY_ID, APNS_TEAM_ID and APNS_TOPIC together, or none of them');
  if(!ID.test(env.APNS_KEY_ID)||!ID.test(env.APNS_TEAM_ID))throw Error('APNS_KEY_ID and APNS_TEAM_ID are 10 letters or digits');
  if(!TOPIC.test(env.APNS_TOPIC))throw Error('APNS_TOPIC is the app\'s bundle id');
  let key;try{key=createPrivateKey(pem.replace(/\\n/g,'\n'))}catch{throw Error('APNS_KEY is not a valid .p8 key')}
  return {key,keyId:env.APNS_KEY_ID,teamId:env.APNS_TEAM_ID,topic:env.APNS_TOPIC,url:env.APNS_URL||''};
}

export const validDeviceToken=t=>typeof t==='string'&&DEVICE.test(t);

export function apnsSender(cfg,{now=()=>Date.now(),connect=http2.connect}={}){
  let jwt=null,jwtAt=0;
  const sessions=new Map();
  function token(){
    if(jwt&&now()-jwtAt<TOKEN_TTL)return jwt;
    const head=b64u({alg:'ES256',kid:cfg.keyId}),claims=b64u({iss:cfg.teamId,iat:Math.floor(now()/1000)});
    const sig=createSign('SHA256').update(`${head}.${claims}`).sign({key:cfg.key,dsaEncoding:'ieee-p1363'}).toString('base64url');
    jwt=`${head}.${claims}.${sig}`;jwtAt=now();return jwt;
  }
  function session(origin){
    let s=sessions.get(origin);
    if(s&&!s.closed&&!s.destroyed)return s;
    s=connect(origin);s.on('error',()=>{});s.on('goaway',()=>s.close());s.on('close',()=>{if(sessions.get(origin)===s)sessions.delete(origin)});
    s.setTimeout(10*60e3,()=>s.close());
    sessions.set(origin,s);return s;
  }
  return {
    topic:cfg.topic,
    // device: {token, environment:'production'|'sandbox'}. payload: the APNs JSON ({aps, ...}).
    // opts: {pushType:'alert'|'background', collapseId, priority, expiration (unix seconds)}
    send(device,payload,{pushType='alert',collapseId,priority,expiration}={}){
      if(!validDeviceToken(device?.token))return Promise.resolve({ok:false,status:0,reason:'BadDeviceToken',gone:true});
      const origin=cfg.url||HOSTS[device.environment==='sandbox'?'sandbox':'production'];
      const body=JSON.stringify(payload);
      if(Buffer.byteLength(body)>4096)return Promise.resolve({ok:false,status:0,reason:'PayloadTooLarge',gone:false});
      return new Promise(resolve=>{
        let req;
        try{
          req=session(origin).request({':method':'POST',':path':`/3/device/${device.token}`,authorization:`bearer ${token()}`,
            'apns-topic':cfg.topic,'apns-push-type':pushType,'apns-priority':String(priority??(pushType==='background'?5:10)),
            ...(collapseId?{'apns-collapse-id':String(collapseId).slice(0,64)}:{}),...(expiration!==undefined?{'apns-expiration':String(expiration)}:{}),
            'content-type':'application/json'});
        }catch{return resolve({ok:false,status:0,reason:'Unreachable',gone:false})}
        let status=0,text='';
        req.setTimeout(10e3,()=>req.close(http2.constants.NGHTTP2_CANCEL));
        req.on('response',h=>{status=h[':status']});
        req.setEncoding('utf8');req.on('data',c=>{if(text.length<2000)text+=c});
        req.on('error',()=>resolve({ok:false,status,reason:'Unreachable',gone:false}));
        req.on('close',()=>{
          let reason='';try{reason=JSON.parse(text).reason||''}catch{}
          resolve({ok:status===200,status,reason,gone:status===410||reason==='BadDeviceToken'||reason==='Unregistered'||reason==='DeviceTokenNotForTopic'});
        });
        req.end(body);
      });
    },
    close(){for(const s of sessions.values())s.close();sessions.clear()},
  };
}
