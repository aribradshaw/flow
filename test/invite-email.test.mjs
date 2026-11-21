// The invite email through OneMail with Flow's brand (lib/email-brand.mjs): brand rules, the
// plain text, escaping, and HTML/text render snapshots in test/snapshots/.
// After an intended template or brand change: UPDATE_SNAPSHOTS=1 node --test test/invite-email.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {inviteEmail} from '../lib/mailer.mjs';
import {flowBrand,LOGO_PATH,LOGO_DARK_PATH} from '../lib/email-brand.mjs';

const dir=fileURLToPath(new URL('./snapshots/',import.meta.url));
const pub=fileURLToPath(new URL('../public/',import.meta.url));
const update=process.env.UPDATE_SNAPSHOTS==='1';
const samples={
  'invite-https':{to:'casey@example.test',appUrl:'https://flow.example.test',link:'https://flow.example.test/join?invite=tok_example_0123456789&email=casey%40example.test',inviter:'Pat Example'},
  'invite-local':{to:'casey@example.test',appUrl:'http://127.0.0.1:4317',inviter:''},
};

test('the Flow brand: logo from the instance URL (https only), Flygon LC footer', ()=>{
  const b=flowBrand('https://flow.example.test/');
  assert.equal(b.name,'Flygon Flow');
  assert.equal(b.logoUrl,'https://flow.example.test'+LOGO_PATH);
  assert.equal(b.logoDarkUrl,'https://flow.example.test'+LOGO_DARK_PATH);
  assert.equal(b.footer.legalName,'Flygon LC');
  assert.deepEqual([...b.footer.address],['13236 N 7th St, Unit 4, PMB 811','Phoenix, AZ 85022']);
  for(const p of [LOGO_PATH,LOGO_DARK_PATH])assert.ok(existsSync(pub+p.slice(1)),p+' is served from public/');
  assert.equal(flowBrand('http://127.0.0.1:4317').logoUrl,undefined,'no logo over plain http');
});

test('the invite renders with logo, preheader, button and footer, and keeps its plain text', ()=>{
  const m=inviteEmail(samples['invite-https']);
  assert.equal(m.subject,"You're invited to Flygon Flow");
  assert.ok(m.html.includes('class="om-card'));
  assert.ok(m.html.includes('https://flow.example.test'+LOGO_PATH));
  assert.match(m.html,/<div style="display:none;[^"]*">Pat Example invited you/);
  assert.match(m.html,/<a href="https:\/\/flow\.example\.test\/join\?invite=tok_example_0123456789&amp;email=casey%40example\.test"[^>]*>Accept the invite<\/a>/);
  assert.ok(m.html.includes('13236 N 7th St, Unit 4, PMB 811<br>Phoenix, AZ 85022'));
  assert.doesNotMatch(m.html,/undefined|null|List-Unsubscribe/);
  assert.equal(m.text,`Pat Example invited you to Flygon Flow: mind maps, timelines and task boards. It is free, and your charts are private to you.

Accept the invite: https://flow.example.test/join?invite=tok_example_0123456789&email=casey%40example.test

Sign in with OneProfileID using this email address (casey@example.test).
New to OneProfileID? Open the link, continue, then choose "Make an account" with this address. It takes a minute: your date of birth, your name and a 6-digit code we email you.

If you were not expecting this, you can ignore this email.`);
  assert.match(inviteEmail(samples['invite-local']).text,/Accept the invite: http:\/\/127\.0\.0\.1:4317\n/,'without a link: the instance URL');
  assert.match(inviteEmail(samples['invite-local']).text,/^A Flygon Flow member invited you/);
});

test('an inviter name stays plain text, and never a link or an address', ()=>{
  const m=inviteEmail({to:'casey@example.test',appUrl:'https://flow.example.test',inviter:'<b>Pat & Co'});
  assert.ok(m.html.includes('bPat &amp; Co invited you'));
  assert.doesNotMatch(m.html,/<b>Pat/);
  for(const bad of ['<b>Pat</b>','Pat https://evil.example','Pat evil.example','pat@evil.example','www.evil','x'.repeat(61)]){
    const t=inviteEmail({to:'casey@example.test',appUrl:'https://flow.example.test',inviter:bad});
    assert.match(t.text,/^A Flygon Flow member invited you/,bad);
    assert.doesNotMatch(t.html,/evil/,bad);
  }
});

test('render snapshots (HTML and text)', ()=>{
  const expected=[];
  for(const [id,fields] of Object.entries(samples)){
    const m=inviteEmail(fields);
    for(const [ext,body] of [['html',m.html],['txt',`Subject: ${m.subject}\n\n${m.text}\n`]]){
      const name=`${id}.${ext}`,file=dir+name;expected.push(name);
      if(update){mkdirSync(dir,{recursive:true});writeFileSync(file,body)}
      assert.ok(existsSync(file),`missing snapshot ${name}; run with UPDATE_SNAPSHOTS=1`);
      assert.equal(body,readFileSync(file,'utf8'),`${name} changed; if intended, run with UPDATE_SNAPSHOTS=1`);
    }
  }
  assert.deepEqual(readdirSync(dir).filter(n=>!expected.includes(n)),[],'no stale snapshots');
});
