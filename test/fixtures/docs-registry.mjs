// A small registry in the shape lib/registry.mjs exports, for test/docs.test.mjs.
const env={type:'string',description:'Environment id.'};
const card={type:'object',properties:{number:{type:'integer'},title:{type:'string'},column:{type:'string',enum:['requests','doing','blocked','uat','done','must','nice']}},required:['number','title','column']};
export const operations=[
  {id:'cards.list',method:'GET',path:'/api/v1/envs/{env}/cards',scope:'read',tags:['cards'],summary:'List DevOps cards.',description:'Cards in board order. Filter with `column` or `q`.',
    input:{type:'object',properties:{env,column:{type:'string',description:'Only this column.'},q:{type:'string',description:'#number or title text.'}},required:['env']},
    output:{type:'object',properties:{cards:{type:'array',items:card}}},
    examples:[{title:'Open cards in Doing',input:{env:'demo',column:'doing'},output:{cards:[{number:12,title:'Build sign-up form',column:'doing'}]}}]},
  {id:'cards.create',method:'POST',path:'/api/v1/envs/{env}/cards',scope:'write',tags:['cards'],summary:'Create a card in Requests.',
    input:{type:'object',properties:{env,title:{type:'string'},labels:{type:'array',items:{type:'string'},description:'Label ids or names.'}},required:['env','title']},output:card,
    examples:[{title:'File a bug',input:{env:'demo',title:"Fix the login page's error text",labels:['High']},output:{number:13,title:"Fix the login page's error text",column:'requests'}}]},
  {id:'cards.move',method:'PATCH',path:'/api/v1/envs/{env}/cards/{number}',scope:'write',tags:['cards','devops'],summary:'Move a card, passing any gate it needs.',
    input:{type:'object',properties:{env,number:{type:'integer'},column:{type:'string'},confirm:{type:'boolean',description:'Required for the confirm-done and confirm-reopen gates.'}},required:['env','number','column']},output:card,examples:[]},
  {id:'envs.list',method:'GET',path:'/api/v1/envs',scope:'read',tags:['envs'],summary:'Environments you can see.',input:{type:'object',properties:{}},output:{type:'object',properties:{envs:{type:'array',items:{type:'object'}}}},examples:[{title:'Mine',input:{},output:{envs:[]}}]},
  {id:'keys.revoke',method:'DELETE',path:'/api/v1/keys/{id}',scope:'admin',summary:'Revoke an API key.',input:{type:'object',properties:{id:{type:'string'}},required:['id']},output:null,examples:[]},
];
export const getOperation=id=>operations.find(o=>o.id===id);
export async function invoke(){throw {status:501,code:'fixture',message:'The fixture registry does not run operations.'}}
