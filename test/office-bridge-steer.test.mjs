// flow office bridge: the transcript tail it reads from T3 and Claude Code (masked before it leaves the
// machine). Scratch folders under ~/scratch only.
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {makePayload} from '../tools/office-bridge.mjs';
import {createClaudeScanner} from '../tools/office-bridge-claude.mjs';
import {readT3} from '../tools/office-bridge-t3.mjs';

const prefix = 'orchestration_v2_projection_';
function scratch(t) {
  const root = join(homedir(), 'scratch');
  mkdirSync(root, {recursive: true});
  const dir = mkdtempSync(join(root, 'flow-office-steer-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

// One running T3 thread ("main", run "live") with a conversation, and a second one that is idle.
export function t3Fixture(t) {
  const cwd = scratch(t);
  const path = join(cwd, 'statev2.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE projection_projects(project_id, workspace_root);
    CREATE TABLE ${prefix}threads(thread_id, project_id, title, deleted_at, payload_json);
    CREATE TABLE ${prefix}runs(run_id, thread_id, status, provider, ordinal, payload_json);
    CREATE TABLE ${prefix}turn_items(thread_id, run_id, type, status, ordinal, updated_at, payload_json);
    CREATE TABLE ${prefix}runtime_requests(runtime_request_id, thread_id, kind, status, created_at, resolved_at, payload_json);
  `);
  const insert = (table, ...values) => db.prepare(`INSERT INTO ${table} VALUES (${values.map(() => '?').join(',')})`).run(...values);
  insert('projection_projects', 'project', cwd);
  insert(prefix + 'threads', 'main', 'project', 'Fix login', null, JSON.stringify({modelSelection: {model: 'claude-opus-5-5'}}));
  insert(prefix + 'threads', 'idle', 'project', 'Done already', null, '{}');
  insert(prefix + 'runs', 'live', 'main', 'running', 'claudeAgent', 2, '{}');
  insert(prefix + 'runs', 'over', 'idle', 'completed', 'claudeAgent', 1, '{}');
  let ordinal = 0;
  const item = (type, payload, at = '2026-11-22T10:00:0' + (ordinal % 10) + 'Z') =>
    insert(prefix + 'turn_items', 'main', 'live', type, 'completed', ++ordinal, at, JSON.stringify(payload));
  for (let i = 0; i < 6; i++) item('user_message', {text: 'old ' + i});
  item('user_message', {text: '  Fix the login loop.\nIt redirects back to /login.  ', startedAt: '2026-11-22T09:59:00Z'});
  item('reasoning', {text: 'thinking hard'});
  item('assistant_message', {text: 'Reading the middleware. Using Authorization: Bearer abcdefghijklmnopqrstuv for the call.'});
  item('command_execution', {input: 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx npm test\nsecond line'});
  item('file_change', {fileName: '/repo/lib/auth.mjs', diffStr: '+secret diff'});
  item('dynamic_tool', {toolName: 'mcp__x', title: 'Search the docs'});
  item('subagent', {title: 'Explore the tests'});
  item('checkpoint', {});
  item('assistant_message', {text: 'x'.repeat(900)});
  const run = (status, threadId = 'main') => db.prepare(`UPDATE ${prefix}runs SET status=? WHERE thread_id=?`).run(status, threadId);
  const rename = title => db.prepare(`UPDATE ${prefix}threads SET title=? WHERE thread_id='main'`).run(title);
  const remove = () => db.prepare(`UPDATE ${prefix}threads SET deleted_at='now' WHERE thread_id='main'`).run();
  t.after(() => db.close());
  return {path, cwd, run, rename, remove};
}

test('T3: the last 12 transcript lines, newest last, tools as one line, masked and cut before sending', async t => {
  const {path} = t3Fixture(t);
  const {agents} = readT3(DatabaseSync, path);
  const raw = agents.get('main').transcript;
  assert.equal(raw.length, 12);
  assert.deepEqual(raw.slice(-7).map(e => [e.role, e.text.slice(0, 40)]), [
    ['user', 'Fix the login loop.\nIt redirects back to'],
    ['assistant', 'Reading the middleware. Using Authorizat'],
    ['tool', 'Run: OPENAI_API_KEY=sk-proj-abcdefghijkl'],
    ['tool', 'Edit: auth.mjs'],
    ['tool', 'Search the docs'],
    ['tool', 'Subagent: Explore the tests'],
    ['assistant', 'x'.repeat(40)],
  ]);
  assert.equal(raw.at(-7).at, '2026-11-22T09:59:00Z');
  const payload = await makePayload({source: 's', host: 'h', now: 0, t3: agents, claude: [], resolveRepo: async () => null});
  const sent = payload.agents.find(a => a.id === 'main').transcript;
  assert.equal(sent.length, 12);
  const text = JSON.stringify(sent);
  for (const secret of ['abcdefghijklmnopqrstuv', 'sk-proj', '+secret diff', 'thinking hard', 'second line']) assert.ok(!text.includes(secret), secret);
  assert.ok(text.includes('Authorization: •••'));
  assert.equal(sent.at(-1).text.length, 400);
});

test('Claude Code: user prompts, assistant text and tool calls become the transcript', t => {
  const root = scratch(t);
  const project = join(root, 'projects', 'p');
  mkdirSync(project, {recursive: true});
  const now = Date.now();
  const rows = [
    {type: 'user', cwd: root, timestamp: '2026-11-22T10:00:00Z', message: {content: 'Add a test for the redirect'}},
    {type: 'assistant', timestamp: '2026-11-22T10:00:05Z', message: {model: 'claude-opus-5-5', content: [
      {type: 'text', text: 'Looking at it. password=hunter2hunter2'},
      {type: 'tool_use', id: 't1', name: 'Bash', input: {command: 'node --test test/auth.test.mjs\nrm -rf x'}},
      {type: 'tool_use', id: 't2', name: 'Edit', input: {file_path: '/repo/test/auth.test.mjs'}},
      {type: 'tool_use', id: 't3', name: 'Grep', input: {pattern: 'next='}}]}},
    {type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 't1', content: 'ok'}]}},
    {type: 'user', isMeta: true, message: {content: 'meta'}},
    {type: 'user', isSidechain: true, message: {content: 'sidechain'}},
  ];
  const path = join(project, 'sess.jsonl');
  writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  utimesSync(path, now / 1000, now / 1000);
  const [session] = createClaudeScanner(root)(new Set(), now);
  assert.deepEqual(session.transcript, [
    {role: 'user', text: 'Add a test for the redirect', at: '2026-11-22T10:00:00Z'},
    {role: 'assistant', text: 'Looking at it. password=hunter2hunter2', at: '2026-11-22T10:00:05Z'},
    {role: 'tool', text: 'Run: node --test test/auth.test.mjs', at: '2026-11-22T10:00:05Z'},
    {role: 'tool', text: 'Edit: auth.test.mjs', at: '2026-11-22T10:00:05Z'},
    {role: 'tool', text: 'Grep: next=', at: '2026-11-22T10:00:05Z'},
  ]);
  return makePayload({source: 's', host: 'h', now, t3: new Map(), claude: [session], resolveRepo: async () => null}).then(payload => {
    const [agent] = payload.agents;
    assert.equal(agent.transcript[1].text, 'Looking at it. password=•••', 'masked before sending');
    assert.equal(agent.transcript.length, 5);
  });
});
