// flow office bridge: the Chief of Staff conductor (tools/office-bridge-conductor.mjs). Its T3 thread is made with a
// fake `t3` CLI, then reused, found again by its title, and made again once deleted; its [[office]] reply line is
// parsed; it is reported as role "conductor" and its messages go over the T3 session. Scratch under ~/scratch only.
import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {CONDUCTOR_TITLE, conductorBrief, createConductor, parseReply} from '../tools/office-bridge-conductor.mjs';
import {conductorResponder, fetchBrief, makePayload} from '../tools/office-bridge.mjs';

const prefix = 'orchestration_v2_projection_';
function scratch(t) {
  const root = join(homedir(), 'scratch', 'flow-cos');
  mkdirSync(root, {recursive: true});
  const dir = mkdtempSync(join(root, 'conductor-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}
function fixture(t) {
  const dir = scratch(t), path = join(dir, 'statev2.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE projection_projects(project_id, workspace_root);
    CREATE TABLE ${prefix}threads(thread_id, project_id, title, deleted_at, archived_at, created_at, updated_at, provider_instance_id, payload_json);
    CREATE TABLE ${prefix}runs(run_id, thread_id, status, provider, ordinal, payload_json);
    CREATE TABLE ${prefix}turn_items(thread_id, run_id, type, status, ordinal, updated_at, payload_json);
    CREATE TABLE ${prefix}runtime_requests(runtime_request_id, thread_id, kind, status, created_at, resolved_at, payload_json);
  `);
  db.prepare('INSERT INTO projection_projects VALUES (?, ?)').run('proj', dir);
  db.close();
  // The fake t3: `thread start --json --title <title> <project> -` records its arguments and stdin, adds the thread to
  // the database and prints {threadId}.
  const bin = join(dir, 't3');
  writeFileSync(bin, `#!${process.execPath}
const {DatabaseSync} = require('node:sqlite'), fs = require('node:fs');
const args = process.argv.slice(2), log = ${JSON.stringify(join(dir, 'calls.jsonl'))};
const n = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0;
const stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(log, JSON.stringify({args, stdin}) + '\\n');
const id = 'thread-cos-' + (n + 1), db = new DatabaseSync(${JSON.stringify(path)});
db.prepare('INSERT INTO ${prefix}threads VALUES (?,?,?,?,?,?,?,?,?)').run(id, 'proj', args[args.indexOf('--title') + 1], null, null, new Date().toISOString(), new Date().toISOString(), 'claudeAgent', JSON.stringify({modelSelection: {model: 'claude-opus-5-5'}}));
console.log(JSON.stringify({threadId: id, projectId: 'proj', runId: 'run-' + id}));
`);
  chmodSync(bin, 0o755);
  const calls = () => existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const exec = sql => { const d = new DatabaseSync(path); try { d.exec(sql); } finally { d.close(); } };
  const insert = (table, ...values) => { const d = new DatabaseSync(path); try { d.prepare(`INSERT INTO ${table} VALUES (${values.map(() => '?').join(',')})`).run(...values); } finally { d.close(); } };
  return {dir, path, bin, calls, exec, insert, stateFile: join(dir, 'config', 'office-conductor.json')};
}

test('the [[office]] line: its say and cards; plain prose shows its start; the tag never reaches the prose', () => {
  const r = parseReply('Made the card and gave it to Builder.\n\n[[office]] {"say":"Routed to Web Builder as #461 · starting now","cards":[461,"#12",0,"x"]}');
  assert.deepEqual([r.say, r.cards, r.tagged], ['Routed to Web Builder as #461 · starting now', [461, 12], true]);
  assert.equal(r.prose, 'Made the card and gave it to Builder.');
  const plain = parseReply('x'.repeat(500));
  assert.equal(plain.tagged, false);assert.ok(plain.say.length <= 200 && plain.say.endsWith('…'));
  const noSay = parseReply('Two cards are in UAT.\n[[office]] {"cards":[3]}');
  assert.deepEqual([noSay.say, noSay.cards], ['Two cards are in UAT.', [3]]);
  const broken = parseReply('Hello [[office]] {not json');
  assert.equal(broken.say, 'Hello');assert.deepEqual(broken.cards, []);
  assert.equal(parseReply('').say, '');
});

test('the brief: the agent\'s rules when the environment has them, sensible defaults otherwise, and the reply contract', () => {
  const own = conductorBrief({env: 'team', agent: 'Chief of Staff', rules: '## Your job\n- Route cards.'});
  assert.match(own, /Route cards\./);assert.match(own, /`team`/);assert.match(own, /\[\[office\]\] \{"say":/);
  assert.match(own, /cards_get first, prepend/);assert.match(own, /agents: \["<agent id or name>"\]/);
  const plain = conductorBrief({});
  assert.match(plain, /Wait for the person/);assert.match(plain, /deleting anything/);
});

test('the conductor thread is made once with the brief, reused, found by its title, and made again when deleted', async t => {
  const f = fixture(t);
  let clock = 1e6;
  const make = () => createConductor({DatabaseSync, path: f.path, stateFile: f.stateFile, project: f.dir, bin: f.bin, now: () => clock,
    fetchBrief: async () => ({env: 'team', agent: 'Chief of Staff', rules: '- Only small, reversible work alone.'})});
  const c = make();
  const id = await c.ensure();
  assert.equal(id, 'thread-cos-1');
  const [call] = f.calls();
  assert.deepEqual(call.args.slice(0, 4), ['thread', 'start', '--json', '--title']);
  assert.equal(call.args[4], CONDUCTOR_TITLE);assert.equal(call.args[5], f.dir);assert.equal(call.args[6], '-');
  assert.match(call.stdin, /Only small, reversible work alone\./, 'the brief goes on stdin, never in the arguments');
  assert.equal(JSON.parse(readFileSync(f.stateFile, 'utf8')).threadId, id);
  assert.equal(await c.ensure(), id);assert.equal(f.calls().length, 1, 'reused');
  // The state file is lost: the thread with the conductor's title in the project is found again.
  rmSync(f.stateFile);
  assert.equal(await make().ensure(), id);assert.equal(f.calls().length, 1);
  // Deleted in T3: a new one, but not more than once a minute.
  f.exec(`UPDATE ${prefix}threads SET deleted_at='2026-11-22T00:00:00Z' WHERE thread_id='${id}'`);
  clock += 61_000;
  assert.equal(await c.ensure(), 'thread-cos-2');assert.equal(f.calls().length, 2);
  f.exec(`UPDATE ${prefix}threads SET archived_at='2026-11-22T00:00:00Z' WHERE thread_id='thread-cos-2'`);
  clock += 1000;
  assert.equal(await c.ensure(), null, 'throttled');
  clock += 61_000;
  assert.equal(await c.ensure(), 'thread-cos-3');
});

test('its office entry: idle, the latest finished reply (never a running turn\'s chatter), a transcript without the tag', async t => {
  const f = fixture(t);
  const c = createConductor({DatabaseSync, path: f.path, stateFile: f.stateFile, project: f.dir, bin: f.bin});
  const id = await c.ensure();
  const item = (run, type, ordinal, text, at) => f.insert(prefix + 'turn_items', id, run, type, 'completed', ordinal, at, JSON.stringify({text, startedAt: at, completedAt: at}));
  item('r1', 'user_message', 1, 'What is in UAT?', '2026-11-22T10:00:00Z');
  item('r1', 'assistant_message', 2, 'Two cards: #12 and #40.\n[[office]] {"say":"Two in UAT: #12, #40","cards":[12,40]}', '2026-11-22T10:00:05Z');
  f.insert(prefix + 'runs', 'r1', id, 'completed', 'claudeAgent', 1, '{}');
  let e = c.entry('box');
  assert.deepEqual([e.role, e.status, e.title, e.can], ['conductor', 'idle', 'Chief of Staff', ['message', 'history']]);
  assert.deepEqual(e.reply, {text: 'Two in UAT: #12, #40', cards: [12, 40], at: '2026-11-22T10:00:05Z'});
  assert.ok(e.transcript.some(l => l.role === 'assistant' && l.text === 'Two cards: #12 and #40.'), 'the tag line is not in the transcript');
  // A new message is being answered: running, and the reply stays the last finished one until the tagged answer.
  item('r2', 'user_message', 3, 'Make a card for the logo', '2026-11-22T10:01:00Z');
  item('r2', 'assistant_message', 4, 'Let me check the agents first.', '2026-11-22T10:01:02Z');
  f.insert(prefix + 'runs', 'r2', id, 'running', 'claudeAgent', 2, '{}');
  e = c.entry('box');
  assert.deepEqual([e.status, e.can, e.runId], ['running', ['message', 'stop', 'history'], 'r2']);
  assert.equal(e.reply.text, 'Two in UAT: #12, #40', 'until the new answer, the last finished one stays (the office tells them apart)');
  item('r2', 'assistant_message', 5, 'Done.\n[[office]] {"say":"Routed to Builder as #461","cards":[461]}', '2026-11-22T10:01:09Z');
  assert.equal(c.entry('box').reply.text, 'Routed to Builder as #461');
});

test('the report carries the conductor once, as role conductor with no repo; its messages go to T3 over the session', async t => {
  const f = fixture(t);
  const sent = [];
  const c = createConductor({DatabaseSync, path: f.path, stateFile: f.stateFile, project: f.dir, bin: f.bin,
    dispatch: async (command, valid) => { assert.equal(valid(), true); sent.push(command); }});
  const id = await c.ensure();
  const conductor = c.entry('box');
  const t3 = new Map([[id, {id, title: CONDUCTOR_TITLE, status: 'running', can: ['message', 'stop'], cwd: f.dir}],
    ['other', {id: 'other', title: 'Fix login', status: 'running', can: ['message', 'stop'], cwd: f.dir}]]);
  const payload = await makePayload({source: 'bridge:box', host: 'box', now: Date.parse('2026-11-22T10:00:00Z'), t3, claude: [], resolveRepo: async () => ({name: 'flow', remote: null}), conductor});
  assert.deepEqual(payload.agents.map(a => [a.id, a.role]), [[id, 'conductor'], ['other', undefined]]);
  assert.equal(payload.agents[0].repo, null);assert.equal(payload.agents[0].title, 'Chief of Staff');
  const fallback = [];
  const respond = conductorResponder(c, async action => { fallback.push(action); return {ok: true, message: 'other'}; });
  assert.deepEqual(await respond({kind: 'message', agentId: id, text: 'What is blocked on the launch?'}), {ok: true, message: 'Chief of Staff has it.'});
  assert.equal(sent.length, 1);
  assert.deepEqual({...sent[0], commandId: 'x', messageId: 'x'}, {type: 'message.dispatch', commandId: 'x', threadId: id, messageId: 'x', text: 'What is blocked on the launch?',
    attachments: [], dispatchMode: {type: 'queue_after_active'}, createdBy: 'user', creationSource: 'web'});
  assert.equal((await respond({kind: 'message', agentId: id, text: ''})).ok, false);
  assert.equal((await respond({kind: 'stop', agentId: id})).ok, false, 'nothing running to stop');
  await respond({kind: 'message', agentId: 'other', text: 'hi'});
  assert.equal(fallback.length, 1, 'other agents keep the ordinary T3 path');
});

test('the brief comes from the first environment with a Chief of Staff agent', async () => {
  const seen = [];
  const fetchImpl = async url => {
    seen.push(url);
    const body = url.endsWith('/api/v1/envs') ? {items: [{id: 'a'}, {id: 'b'}]}
      : url.includes('/envs/b/agents/Chief%20of%20Staff') ? {agent: {name: 'Chief of Staff', instructions: '- Route.'}} : null;
    return body ? new Response(JSON.stringify(body), {status: 200}) : new Response('{}', {status: 404});
  };
  assert.deepEqual(await fetchBrief({url: 'https://flow.test', key: 'k'}, undefined, {fetchImpl}), {env: 'b', agent: 'Chief of Staff', rules: '- Route.'});
  assert.deepEqual(await fetchBrief({url: 'https://flow.test', key: 'k'}, 'zz', {fetchImpl}), {env: 'zz'});
});
