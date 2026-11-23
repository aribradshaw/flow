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
  const root = join(homedir(), 'scratch', 'flow-usage');
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

// ---------- steering: can, and messages and stops against a fake T3 (its CLI and its WebSocket API) ----------
import {createHash} from 'node:crypto';
import {chmodSync, readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createT3Responder} from '../tools/office-bridge-t3.mjs';
import {runBridge} from '../tools/office-bridge.mjs';

test('can: top-level T3 threads take messages and stops; delegated threads and Claude Code do not', async t => {
  const {path} = t3Fixture(t);
  const {agents} = readT3(DatabaseSync, path);
  agents.get('main').children = [];
  agents.set('delegate', {...agents.get('main'), id: 'delegate', parent: 'elsewhere', can: []});
  const claude = [{id: 'claude:1', title: 'Terminal session', status: 'running', provider: 'claudeAgent'}];
  const payload = await makePayload({source: 's', host: 'h', now: 0, t3: agents, claude, resolveRepo: async () => null});
  const can = Object.fromEntries(payload.agents.map(a => [a.id, a.can]));
  assert.deepEqual(can, {main: ['message', 'stop'], delegate: [], 'claude:1': []});
});

// A fake T3: the `t3` CLI (auth session issue, thread send) on PATH, and its HTTP + WebSocket API.
async function fakeT3(t, path, cwd, onCommand) {
  const bin = join(cwd, 'home', '.local', 'bin');
  mkdirSync(bin, {recursive: true});
  const log = join(cwd, 't3-cli.json');
  writeFileSync(join(bin, 't3'), `#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2);
if (args[0] === 'auth') { console.log('t3-token'); process.exit(0); }
if (args[0] === 'thread' && args[1] === 'send') {
  let input = ''; process.stdin.on('data', d => input += d).on('end', () => {
    fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({args, input, home: process.env.T3CODE_HOME || null}));
    console.log(JSON.stringify({delivery: 'queued', runId: 'run-2'}));
  });
} else process.exit(2);
`);
  chmodSync(join(bin, 't3'), 0o755);
  const commands = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname === '/api/auth/websocket-ticket/rpc' && req.headers.authorization === 'Bearer t3-token') {
      res.writeHead(200, {'content-type': 'application/json'});
      return res.end(JSON.stringify({ticket: 'ticket-1'}));
    }
    res.writeHead(404); res.end();
  });
  server.on('upgrade', (req, socket) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/ws' || u.searchParams.get('wsTicket') !== 'ticket-1') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        let len = buf[1] & 127, off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i % 4]);
        const op = buf[0] & 15;
        buf = buf.subarray(off + 4 + len);
        if (op === 8) { socket.end(); return; }
        if (op !== 1) continue;
        const message = JSON.parse(data.toString());
        commands.push(message.payload);
        onCommand(message.payload);
        const reply = Buffer.from(JSON.stringify({_tag: 'Exit', requestId: message.id, exit: {_tag: 'Success'}}));
        socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
      }
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(cwd, 'server-runtime.json'), JSON.stringify({port: server.address().port}));
  const env = {HOME: process.env.HOME, PATH: process.env.PATH};
  process.env.HOME = join(cwd, 'home');
  t.after(() => {
    Object.assign(process.env, env);
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return {commands, sent: () => JSON.parse(readFileSync(log, 'utf8'))};
}

test('message and stop reach T3 through its API, after checking the thread, and report back', async t => {
  const {path, cwd, run, remove} = t3Fixture(t);
  const t3 = await fakeT3(t, path, cwd, command => { if (command.type === 'run.interrupt') run('interrupted'); });
  const respond = createT3Responder(DatabaseSync, path);
  const signal = AbortSignal.timeout(20000);
  const text = 'Also add a test for ?next=/login\nand keep it small';
  assert.deepEqual(await respond({kind: 'message', agentId: 'main', text}, signal), {ok: true, message: 'Queued in T3 Code: it is the next turn.'});
  const sent = t3.sent();
  assert.deepEqual(sent.args, ['thread', 'send', '--json', 'main', '-'], 'the text goes on stdin, never in the arguments');
  assert.equal(sent.input, text);
  assert.deepEqual(await respond({kind: 'stop', agentId: 'main'}, signal), {ok: true, message: 'Stopped in T3 Code.'});
  assert.deepEqual(t3.commands.map(c => [c.type, c.threadId, c.runId]), [['run.interrupt', 'main', 'live']]);
  // Checked first: not running any more, not a thread it offers them for, or gone.
  assert.equal((await respond({kind: 'stop', agentId: 'main'}, signal)).ok, false, 'no running turn');
  assert.equal((await respond({kind: 'message', agentId: 'nope', text: 'hi'}, signal)).ok, false);
  assert.equal((await respond({kind: 'message', agentId: 'idle', text: 'hi'}, signal)).ok, false, 'a thread it did not report');
  assert.equal((await respond({kind: 'message', agentId: 'main', text: ''}, signal)).ok, false);
  run('running');remove();
  assert.equal((await respond({kind: 'message', agentId: 'main', text: 'hi'}, signal)).ok, false, 'a deleted thread');
  assert.equal(t3.commands.length, 1);
});

test('runBridge carries out messages and stops, logs them without their text, and acknowledges each', async t => {
  const calls = [], logs = [], results = new Map();
  const controller = new AbortController();
  const actions = [
    {id: 'a-msg', kind: 'message', agentId: 'main', text: 'secret plan: ship it', source: 's'},
    {id: 'a-stop', kind: 'stop', agentId: 'main', source: 's'},
    {id: 'a-bad', kind: 'message', agentId: 'main', text: '', source: 's'},
    {id: 'a-odd', kind: 'dance', agentId: 'main', source: 's'},
    {id: 'a-old', agentId: 'main', requestId: 'r-1', decision: 'allow', source: 's'},
  ];
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.writeHead(200, {'content-type': 'application/json'});
    if (req.method === 'PUT' && u.pathname === '/api/v1/office/agents') return res.end(JSON.stringify({actions}));
    if (req.method === 'GET' && u.pathname === '/api/v1/office/actions') { await new Promise(r => setTimeout(r, 50)); return res.end('{"actions":[]}'); }
    if (req.method === 'POST' && u.pathname.startsWith('/api/v1/office/actions/')) {
      results.set(decodeURIComponent(u.pathname.split('/').at(-1)), JSON.parse(raw));
      if (results.size === actions.length) controller.abort();
      return res.end('{}');
    }
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await runBridge({cfg: {url: 'http://127.0.0.1:' + server.address().port, key: 'k'}, source: 's', interval: 100,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    scan: async () => ({source: 's', at: new Date().toISOString(), agents: []}),
    respond: async action => { calls.push([action.kind, action.text]); return {ok: true, message: action.kind === 'stop' ? 'Stopped in T3 Code.' : 'Done.'}; },
    log: line => logs.push(line)});
  assert.deepEqual(calls, [['message', 'secret plan: ship it'], ['stop', undefined], ['answer', undefined]]);
  assert.deepEqual([...results].map(([id, r]) => [id, r.ok]).sort(), [['a-bad', false], ['a-msg', true], ['a-odd', false], ['a-old', true], ['a-stop', true]]);
  assert.ok(logs.includes('office bridge: message for main: ok: Done.'));
  assert.ok(logs.includes('office bridge: stop for main: ok: Stopped in T3 Code.'));
  assert.ok(!logs.join('\n').includes('secret plan'), 'never the text');
});
