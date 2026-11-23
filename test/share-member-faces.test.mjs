// How a @email share member is drawn (public/ui.js personPhoto): the viewer's own person card
// with that email, then the member's linked account photo or uploaded photo.
import {test} from 'node:test';
import assert from 'node:assert/strict';

globalThis.document={addEventListener(){},createElement(){return {style:{},setAttribute(){},classList:{add(){},remove(){},contains(){return false}}}}};
const {personPhoto,setPeopleSource,setMemberPhotos,setSessionUser}=await import('../public/ui.js');

const member={id:'@joe@example.test',email:'joe@example.test',name:'Joseph Basrawi',opidLinked:true,image:'https://cdn.example.test/owner.png'};

const tick=()=>new Promise(r=>setTimeout(r,0));
test('a share member shows the viewer\'s card photo, then its own account photo',async()=>{
  setSessionUser(null);
  setPeopleSource(()=>[
    {id:'joe',type:'person',name:'Joe Basrawi',email:'joe@example.test',image:'data:image/png;base64,QQQQ'},
    {id:'sh.s1.x',type:'person',name:'Joseph Basrawi',email:'joe@example.test',image:'data:image/png;base64,XXXX'},
  ]);
  assert.equal(personPhoto(member),'data:image/png;base64,QQQQ','the viewer\'s own card wins over a shared copy and over the member');

  await tick();
  const linked={id:'joe',type:'person',name:'Joe Basrawi',email:'joe@example.test',opidLinked:true};
  setPeopleSource(()=>[linked]);
  setMemberPhotos({joe:'data:image/png;base64,AAAA','@joe@example.test':'data:image/png;base64,BBBB'});
  assert.equal(personPhoto(member),personPhoto(linked),'a linked card of the viewer\'s is that member\'s photo');

  await tick();
  setPeopleSource(()=>[{id:'joe',type:'person',name:'Joe Basrawi',email:'joe@example.test'}]);
  assert.equal(personPhoto(member),personPhoto({id:'@joe@example.test',opidLinked:true}),'with no photo on the card, the member\'s account photo shows');

  setMemberPhotos({});
  assert.equal(personPhoto(member),'https://cdn.example.test/owner.png');
  await tick();
  setPeopleSource(()=>[]);
  assert.equal(personPhoto({id:'@ann@example.test',email:'ann@example.test',name:'Ann'}),'');
});
