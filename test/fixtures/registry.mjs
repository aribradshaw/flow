// A small registry in the shape of lib/registry.mjs (operations, getOperation, invoke), over an
// in-memory DevOps board, for the MCP and CLI tests. Not the real registry.
const env={type:'string',description:'Environment id, e.g. default-workspace'};
const card={type:'object',properties:{number:{type:'integer'},title:{type:'string'},column:{type:'string'},project:{type:'string'},labels:{type:'array',items:{type:'string'}}}};
export const operations=[
  {id:'cards.list',method:'GET',path:'/api/v1/envs/{env}/cards',scope:'read',tags:['cards'],summary:'List DevOps cards',
    description:'Cards on the board, optionally filtered by project and column.',
    input:{type:'object',properties:{env,project:{type:'string',description:'Project name'},column:{type:'string',enum:['requests','doing','blocked','uat','done','must','nice']},limit:{type:'integer'}},required:['env']},
    output:{type:'object',properties:{cards:{type:'array',items:card},total:{type:'integer'}}},
    examples:[{title:'Open cards in Lantern',input:{env:'default-workspace',project:'Lantern'},output:{cards:[],total:0}}]},
  {id:'cards.get',method:'GET',path:'/api/v1/envs/{env}/cards/{number}',scope:'read',tags:['cards'],summary:'Get a card',description:'One card by its #number.',
    input:{type:'object',properties:{env,number:{type:'integer'}},required:['env','number']},output:card,examples:[]},
  {id:'cards.create',method:'POST',path:'/api/v1/envs/{env}/cards',scope:'write',tags:['cards'],summary:'Create a card',description:'Adds a card to Requests / Sprinted unless a column is given.',
    input:{type:'object',properties:{env,title:{type:'string'},project:{type:'string'},column:{type:'string'},labels:{type:'array',items:{type:'string'}},urgent:{type:'boolean'}},required:['env','title']},output:card,examples:[]},
  {id:'cards.move',method:'POST',path:'/api/v1/envs/{env}/cards/{number}/move',scope:'write',tags:['cards'],summary:'Move a card to another column',description:'',
    input:{type:'object',properties:{env,number:{type:'integer'},column:{type:'string'}},required:['env','number','column']},output:card,
    examples:[{title:'Start work on #42',input:{env:'default-workspace',number:42,column:'doing'},output:{number:42,column:'doing'}}]},
  {id:'cards.delete',method:'DELETE',path:'/api/v1/envs/{env}/cards/{number}',scope:'admin',tags:['cards'],summary:'Delete a card',description:'',
    input:{type:'object',properties:{env,number:{type:'integer'}},required:['env','number']},output:{type:'object',properties:{deleted:{type:'boolean'}}},examples:[]},
  {id:'envs.list',method:'GET',path:'/api/v1/envs',scope:'read',tags:['envs'],summary:'List environments',description:'',input:{type:'object',properties:{}},
    output:{type:'array',items:{type:'object'}},examples:[]},
];
export const getOperation=id=>operations.find(o=>o.id===id)||null;

export function board(){
  return {'default-workspace':{owner:'owner@example.test',cards:[
    {number:41,title:'Sign-up form',column:'requests',project:'Lantern',labels:['High']},
    {number:42,title:'MCP server',column:'requests',project:'Lantern',labels:['Backend','Infra']},
    {number:43,title:'Logo refresh',column:'done',project:'Flygon',labels:[]},
  ]}};
}
const err=(status,code,message)=>({status,code,message});
export async function invoke(id,input,ctx){
  const op=getOperation(id);if(!op)throw err(404,'unknown_operation',`No operation ${id}`);
  if(id==='envs.list')return Object.keys(ctx.store).map(k=>({id:k}));
  const b=ctx.store[input.env];
  if(!b||!ctx.envCheck(input.env,ctx.user,op.scope==='read'?'read':'write'))throw err(404,'not_found','Environment not found');
  const find=()=>b.cards.find(c=>c.number===input.number)||(()=>{throw err(404,'not_found',`No card #${input.number}`)})();
  if(id==='cards.list'){const cards=b.cards.filter(c=>(!input.project||c.project===input.project)&&(!input.column||c.column===input.column)).slice(0,input.limit||100);return {cards,total:cards.length}}
  if(id==='cards.get')return find();
  if(id==='cards.create'){const c={number:Math.max(0,...b.cards.map(c=>c.number))+1,title:input.title,column:input.column||'requests',project:input.project||'',labels:input.labels||[]};b.cards.push(c);return c}
  if(id==='cards.move'){const c=find();if(!['requests','doing','blocked','uat','done','must','nice'].includes(input.column))throw err(400,'bad_column',`Unknown column ${input.column}`);c.column=input.column;return c}
  if(id==='cards.delete'){const c=find();b.cards.splice(b.cards.indexOf(c),1);return {deleted:true}}
}
