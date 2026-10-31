// Environments: who owns a workspace and who may see it.
// {id, name, ownerEmail, visibility:'private'|'public', members:[]}  (members: reserved for invites/teams)
// Every workspace payload carries db.environment. Data saved before environments existed (saves,
// backups, browser storage and Postgres rows without one) belongs to Default workspace.
// Rules: the owner (and, later, members) may read and write; anyone signed in may read a public
// environment; everyone else gets 404, so private environments are not even confirmed to exist.
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {OWNER_EMAIL} from './auth.mjs';

export const DEFAULT_ENV={id:'default-workspace',name:"Default workspace",ownerEmail:OWNER_EMAIL,visibility:'private',members:[]};
const ID=/^[A-Za-z0-9-]{1,64}$/,same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();

// The registry lives beside the disk backups as _environments.json (backup ids cannot contain "_").
export function registry(dir){
  const file=join(dir,'_environments.json');
  let envs=new Map([[DEFAULT_ENV.id,{...DEFAULT_ENV}]]);
  try{for(const e of JSON.parse(readFileSync(file,'utf8')))if(e&&ID.test(e.id))envs.set(e.id,clean(e))}catch{}
  envs.get(DEFAULT_ENV.id).ownerEmail=OWNER_EMAIL;
  const persist=()=>{mkdirSync(dir,{recursive:true});writeFileSync(file+'.tmp',JSON.stringify([...envs.values()],null,2));renameSync(file+'.tmp',file)};
  return {
    get:id=>envs.get(id&&ID.test(id)?id:DEFAULT_ENV.id)||null,
    // The environment a payload belongs to (registered or not yet).
    of(data){const e=data?.environment;return e&&ID.test(e?.id)?envs.get(e.id)||{...clean(e),ownerEmail:'',unregistered:true}:envs.get(DEFAULT_ENV.id)},
    // On a write by its owner: register a new environment (owned by the writer) or update name/visibility.
    claim(data,user){
      const e=this.of(data);
      if(e.unregistered){const n={...clean(data.environment),ownerEmail:user.email,members:[]};delete n.unregistered;envs.set(n.id,n);persist();return n}
      if(same(e.ownerEmail,user.email)&&data.environment&&(data.environment.name!==e.name||data.environment.visibility!==e.visibility)){Object.assign(e,{name:clean(data.environment).name,visibility:clean(data.environment).visibility});persist()}
      return e;
    },
    list:()=>[...envs.values()],
  };
}
export function clean(e){return {id:e.id,name:String(e.name||'Workspace').slice(0,80),ownerEmail:String(e.ownerEmail||'').toLowerCase().slice(0,254),visibility:e.visibility==='public'?'public':'private',members:Array.isArray(e.members)?e.members.filter(m=>typeof m==='string').slice(0,100):[]}}
export const canRead=(e,user)=>!!e&&!!user&&(e.visibility==='public'||same(e.ownerEmail,user.email)||e.members?.some(m=>same(m,user.email)));
export const canWrite=(e,user)=>!!e&&!!user&&(e.unregistered||same(e.ownerEmail,user.email));
