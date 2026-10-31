// Settings › API keys: the signed-in user's own keys (browser session only; a key cannot manage keys).
//   GET    /api/keys        -> {keys:[{id, name, prefix, env, scopes, mode, createdAt, expiresAt, lastUsedAt, lastUsedIp, revokedAt}], mode}
//   POST   /api/keys {name, env:'<id>'|'*', scopes:['read'|'write'|'admin'], expiresInDays?:1..365|null}
//          -> 201 {key, apiKey, warning}  (the full key, this once)
//   DELETE /api/keys/<id>   -> {revoked:true} | 404
// Same rules as the other API routes in server.mjs: only the trusted page may call it (same origin,
// no DNS rebinding), POST bodies must be application/json, everything is Cache-Control: no-store.
// Hashes never leave lib/apikeys.mjs; responses carry the display prefix only.
//
//   const keysApi=apiKeyRoutes({userFor:auth.userFor, store:apiKeys, readJson, trusted, envsFor});
//   if(await keysApi(req,res))return;
// envsFor(user) -> the environment ids the user may give a key to (omit it to allow any valid id).
import {validEnv,normScopes,clientIp} from './apikeys.mjs';

const json=(res,code,body)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body))};
const ID=/^key_[0-9a-f-]{36}$/;
// The same check as trusted() in server.mjs, for when the caller does not pass its own.
const loopbackOnly=req=>{const host=req.headers.host||'',o=req.headers.origin;return /^(127\.0\.0\.1|localhost):\d+$/.test(host)&&(!o||o===`http://${host}`)};

export function apiKeyRoutes({userFor,store,readJson,trusted=loopbackOnly,envsFor=null,maxDays=365}){
  return async function apiKeys(req,res){
    const u=new URL(req.url,'http://x');
    if(u.pathname!=='/api/keys'&&!u.pathname.startsWith('/api/keys/'))return false;
    if(!trusted(req)){res.writeHead(403);res.end();return true}
    const user=await userFor(req);
    if(!user){json(res,401,{error:'Sign in to continue'});return true}
    if(user.token){json(res,403,{error:'Manage API keys from Settings while signed in'});return true}
    const id=u.pathname.split('/')[3];
    try{
      if(!id&&req.method==='GET'){json(res,200,{keys:await store.list(user.email),mode:store.mode});return true}
      if(!id&&req.method==='POST'){
        readJson(req,res,async b=>{try{
          const name=String(b?.name??'').trim().slice(0,80),env=String(b?.env??''),scopes=normScopes(b?.scopes);
          if(!name){json(res,400,{error:'Give the key a name'});return}
          if(!validEnv(env)){json(res,400,{error:'Choose an environment'});return}
          if(env!=='*'&&envsFor&&!(await envsFor(user)).includes(env)){json(res,404,{error:'Environment not found'});return}
          if(!scopes.length||!(Array.isArray(b.scopes)?b.scopes:[b.scopes]).every(s=>normScopes([s]).length)){json(res,400,{error:'Choose read, write or admin'});return}
          const days=b?.expiresInDays;
          if(days!==undefined&&days!==null&&!(Number.isInteger(days)&&days>=1&&days<=maxDays)){json(res,400,{error:`Expiry must be 1 to ${maxDays} days, or never`});return}
          if(await store.activeCount(user.email)>=store.MAX_KEYS){json(res,400,{error:`You have ${store.MAX_KEYS} active keys; revoke one first`});return}
          const expiresAt=days?new Date((store.now||Date.now)()+days*864e5).toISOString():null;
          const out=await store.create({owner:user.email,name,env,scopes,expiresAt});
          await store.audit(out.apiKey.id,'create',clientIp(req)).catch(()=>{});
          json(res,201,{key:out.key,apiKey:out.apiKey,warning:'Copy this key now. You will not see it again.'});
        }catch{json(res,500,{error:'Could not create the key'})}});
        return true;
      }
      if(id&&req.method==='DELETE'){
        if(!ID.test(id)||!(await store.revoke(id,user.email,clientIp(req)))){json(res,404,{error:'Not found'});return true}
        json(res,200,{revoked:true});return true;
      }
      res.writeHead(405);res.end();return true;
    }catch{json(res,500,{error:'API keys are unavailable'});return true}
  };
}
