// Registry operations <-> OpenAPI 3.1, shared by the MCP server, the `flow` CLI and the tests.
//   openapiFor(operations,{url,version})  an OpenAPI document; each operation keeps its registry
//                                          entry in x-flow-operation, so the CLI rebuilds it exactly
//   operationsFrom(doc)                    the operations back from any OpenAPI document (x-flow-operation
//                                          when present, otherwise parameters + requestBody)
//   requestFor(op,input)                   {method,path,query,body} for one call
// REST convention: {name} placeholders in the path take the input field of that name; the remaining
// fields go in the query string for GET and DELETE and in a JSON body for POST and PATCH.
export const toolName=id=>id.replace(/\./g,'_');
const placeholders=path=>[...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(m=>m[1]);
const hasBody=method=>method==='POST'||method==='PATCH'||method==='PUT';

export function openapiFor(operations,{url='',version='1.0.0',title='Flygon Flow API'}={}){
  const paths={};
  for(const op of operations){
    const props=op.input?.properties||{},req=new Set(op.input?.required||[]),inPath=placeholders(op.path);
    const params=Object.entries(props).filter(([k])=>inPath.includes(k)||!hasBody(op.method))
      .map(([k,s])=>({name:k,in:inPath.includes(k)?'path':'query',required:inPath.includes(k)||req.has(k),schema:s,...(s.description?{description:s.description}:{})}));
    const rest=Object.fromEntries(Object.entries(props).filter(([k])=>!inPath.includes(k)));
    (paths[op.path]||={})[op.method.toLowerCase()]={
      operationId:op.id,summary:op.summary,description:op.description,tags:op.tags,security:[{bearer:[]}],
      parameters:params,
      ...(hasBody(op.method)?{requestBody:{required:[...req].some(k=>!inPath.includes(k)),content:{'application/json':{schema:{...op.input,properties:rest,required:[...req].filter(k=>!inPath.includes(k))}}}}}:{}),
      responses:{200:{description:'OK',content:{'application/json':{schema:op.output||{}}}},default:{description:'Error',content:{'application/json':{schema:{$ref:'#/components/schemas/Error'}}}}},
      'x-flow-operation':{id:op.id,scope:op.scope,input:op.input,output:op.output,examples:op.examples||[]},
    };
  }
  return {openapi:'3.1.0',info:{title,version},...(url?{servers:[{url}]}:{}),paths,
    components:{securitySchemes:{bearer:{type:'http',scheme:'bearer',description:'A Flygon Flow API key (flow_…)'}},
      schemas:{Error:{type:'object',properties:{error:{type:'object',properties:{code:{type:'string'},message:{type:'string'}}}}}}}};
}

export function operationsFrom(doc){
  const out=[];
  for(const [path,item] of Object.entries(doc?.paths||{}))for(const [m,o] of Object.entries(item||{})){
    if(!['get','post','patch','put','delete'].includes(m)||!o)continue;
    const x=o['x-flow-operation']||{},method=m.toUpperCase();
    let input=x.input;
    if(!input){
      const properties={},required=[];
      for(const p of o.parameters||[])if(p&&(p.in==='path'||p.in==='query')){properties[p.name]={...(p.schema||{type:'string'}),...(p.description?{description:p.description}:{})};if(p.required)required.push(p.name)}
      const b=o.requestBody?.content?.['application/json']?.schema;
      if(b?.properties){Object.assign(properties,b.properties);required.push(...(b.required||[]))}
      input={type:'object',properties,required:[...new Set(required)]};
    }
    const id=x.id||(o.operationId?String(o.operationId).replace(/_/g,'.'):`${m}.${path}`);
    out.push({id,method,path,scope:x.scope||o['x-flow-scope']||(method==='GET'?'read':'write'),tags:o.tags||[],summary:o.summary||'',description:o.description||'',
      input,output:x.output||o.responses?.[200]?.content?.['application/json']?.schema||o.responses?.[201]?.content?.['application/json']?.schema||{},examples:x.examples||[]});
  }
  return out;
}

export function requestFor(op,input={}){
  const rest={...input};
  const path=op.path.replace(/\{([A-Za-z0-9_]+)\}/g,(_,k)=>{
    if(rest[k]===undefined||rest[k]==='')throw {status:400,code:'missing_parameter',message:`${k} is required`};
    const v=rest[k];delete rest[k];return encodeURIComponent(String(v));
  });
  if(hasBody(op.method))return {method:op.method,path,query:'',body:rest};
  const q=new URLSearchParams();
  // Arrays go as one comma-separated value, the form the server's query parser reads.
  for(const [k,v] of Object.entries(rest))if(v!==undefined&&v!==null)q.append(k,Array.isArray(v)?v.map(String).join(','):typeof v==='object'?JSON.stringify(v):String(v));
  return {method:op.method,path,query:q.size?'?'+q:'',body:undefined};
}
