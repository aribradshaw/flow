// Shared by the server and the packaged CLI. The model slug can include a provider prefix separated by a slash.
export const CHIEF_MODEL_LIMIT=600, CHIEF_ACCOUNT_MODEL_LIMIT=250;

export function parseModel(text){
  const s=typeof text==='string'?text.trim():'';
  const i=s.indexOf(':');
  if(i<1||i>80)return null;
  const instanceId=s.slice(0,i),model=s.slice(i+1);
  if(!model||model.length>120||/\s/.test(s)||!/^[\w.-]+$/.test(instanceId)||!/^[\w./-]+$/.test(model))return null;
  return {instanceId,model,id:`${instanceId}:${model}`};
}
