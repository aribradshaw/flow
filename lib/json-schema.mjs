// A small JSON Schema checker for the subset the operation registry uses (lib/registry.mjs):
// type (one or a list, incl. 'null' and 'integer'), enum, const, properties, required,
// additionalProperties (false or a schema), items, minItems/maxItems, minLength/maxLength, pattern,
// minimum/maximum, anyOf and default. No $ref: registry schemas are inline so MCP, the CLI and the
// OpenAPI document can use them as they are.

const typeOf=v=>v===null?'null':Array.isArray(v)?'array':Number.isInteger(v)?'integer':typeof v;
const fits=(t,v)=>t===typeOf(v)||(t==='number'&&typeof v==='number'&&Number.isFinite(v));

// Returns a list of problems ("input.title: must be a string"); empty means valid.
export function check(schema,value,at='input'){
  const e=[];
  if(!schema||typeof schema!=='object')return e;
  if(schema.anyOf){if(!schema.anyOf.some(s=>!check(s,value,at).length))e.push(`${at}: does not match any allowed form`);return e}
  const types=schema.type===undefined?null:[].concat(schema.type);
  if(types&&!types.some(t=>fits(t,value))){e.push(`${at}: must be ${types.join(' or ')}`);return e}
  if(schema.const!==undefined&&value!==schema.const)e.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if(schema.enum&&!schema.enum.includes(value))e.push(`${at}: must be one of ${schema.enum.map(v=>JSON.stringify(v)).join(', ')}`);
  if(typeof value==='string'){
    if(schema.minLength!==undefined&&value.length<schema.minLength)e.push(`${at}: at least ${schema.minLength} characters`);
    if(schema.maxLength!==undefined&&value.length>schema.maxLength)e.push(`${at}: at most ${schema.maxLength} characters`);
    if(schema.pattern&&!new RegExp(schema.pattern).test(value))e.push(`${at}: must match ${schema.pattern}`);
  }
  if(typeof value==='number'){
    if(schema.minimum!==undefined&&value<schema.minimum)e.push(`${at}: at least ${schema.minimum}`);
    if(schema.maximum!==undefined&&value>schema.maximum)e.push(`${at}: at most ${schema.maximum}`);
  }
  if(Array.isArray(value)){
    if(schema.minItems!==undefined&&value.length<schema.minItems)e.push(`${at}: at least ${schema.minItems} items`);
    if(schema.maxItems!==undefined&&value.length>schema.maxItems)e.push(`${at}: at most ${schema.maxItems} items`);
    if(schema.items)value.forEach((v,i)=>e.push(...check(schema.items,v,`${at}[${i}]`)));
  }
  if(typeOf(value)==='object'){
    for(const k of schema.required||[])if(value[k]===undefined)e.push(`${at}.${k}: is required`);
    const props=schema.properties||{};
    for(const [k,v] of Object.entries(value)){
      if(v===undefined)continue;
      if(props[k])e.push(...check(props[k],v,`${at}.${k}`));
      else if(schema.additionalProperties===false)e.push(`${at}.${k}: is not allowed`);
      else if(typeof schema.additionalProperties==='object')e.push(...check(schema.additionalProperties,v,`${at}.${k}`));
    }
  }
  return e;
}

// Top-level defaults (e.g. limit) filled into a copy of the input.
export function withDefaults(schema,input){
  const out={...input};
  for(const [k,s] of Object.entries(schema?.properties||{}))if(out[k]===undefined&&s.default!==undefined)out[k]=structuredClone(s.default);
  return out;
}

// Query strings and path segments arrive as text: turn them into the types the schema asks for.
// Values that do not convert are left as text so check() reports them.
export function coerce(schema,raw){
  const out={};
  for(const [k,v] of Object.entries(raw)){
    const types=[].concat(schema?.properties?.[k]?.type||'string');
    if(types.includes('string')){out[k]=v;continue}
    if((types.includes('integer')||types.includes('number'))&&/^-?\d+(\.\d+)?$/.test(v)){out[k]=Number(v);continue}
    if(types.includes('boolean')&&(v==='true'||v==='false')){out[k]=v==='true';continue}
    if(types.includes('array')){out[k]=v.split(',').filter(Boolean);continue}
    out[k]=v;
  }
  return out;
}
