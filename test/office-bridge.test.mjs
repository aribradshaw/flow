import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {createReportWake, makePayload, normalizeRemote, runBridge, createRepoResolver, agentflowOf} from '../tools/office-bridge.mjs';
import {createClaudeScanner} from '../tools/office-bridge-claude.mjs';
import {createT3PromptDetector, createT3Responder, createT3Session, readT3} from '../tools/office-bridge-t3.mjs';

const exec = promisify(execFile);
const source = 'bridge:fixture';
const host = 'fixture';
const api = '/api/v1/office';
const key = 'flow_test_fixture';
const prefix = 'orchestration_v2_projection_';

function scratch(t) {
  const root = join(homedir(), 'scratch', 'flow-usage');
  mkdirSync(root, {recursive: true});
  const dir = mkdtempSync(join(root, 'flow-office-bridge-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function fixture(t) {
  const cwd = scratch(t);
  const path = join(cwd, 'statev2.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE projection_projects(project_id, workspace_root);
    CREATE TABLE ${prefix}threads(thread_id, project_id, title, deleted_at, payload_json);
    CREATE TABLE ${prefix}runs(run_id, thread_id, status, provider, ordinal, payload_json);
    CREATE TABLE ${prefix}turn_items(thread_id, run_id, type, status, ordinal, payload_json);
    CREATE TABLE ${prefix}runtime_requests(runtime_request_id, thread_id, kind, status, created_at, resolved_at, payload_json);
    CREATE TABLE ${prefix}provider_threads(thread_id, payload_json);
    CREATE TABLE provider_session_runtime(thread_id, resume_cursor_json);
  `);
  const insert = (table, ...values) => db.prepare(`INSERT INTO ${table} VALUES (${values.map(() => '?').join(',')})`).run(...values);
  insert('projection_projects', 'project', cwd);
  const modelSelection = {model: 'claude-opus-5-5-20261001'};
  const worktreePath = join(cwd, 'worktree');
  insert(prefix + 'threads', 'main', 'project', 'Fix login', null, JSON.stringify({worktreePath, modelSelection}));
  insert(prefix + 'threads', 'child', 'project', 'Review tests', null, JSON.stringify({lineage: {parentThreadId: 'main'}}));
  insert(prefix + 'threads', 'question', 'project', 'Choose an option', null, '{}');
  insert(prefix + 'threads', 'held', 'project', 'Held', null, '{}');
  insert(prefix + 'threads', 'closed', 'project', 'Deleted', 'deleted', '{}');
  insert(prefix + 'threads', 'bad', 'project', 42, null, '{malformed');
  insert(prefix + 'runs', 'old', 'main', 'running', 'codex', 1, '{}');
  insert(prefix + 'runs', 'live', 'main', 'running', 'claudeAgent', 2, '{}');
  insert(prefix + 'runs', 'delegate', 'child', 'starting', 'gemini', 3, '{"modelSelection":{"model":"gemini-3-pro"}}');
  insert(prefix + 'runs', 'held-run', 'held', 'queued', 'codex', 3, '{"queueHeld":true}');
  insert(prefix + 'runs', 'deleted-run', 'closed', 'running', 'codex', 4, '{}');
  insert(prefix + 'runs', 'bad-run', 'bad', 'running', 'codex', 5, 'null');
  const item = (threadId, runId, type, ordinal, payload) =>
    insert(prefix + 'turn_items', threadId, runId, type, 'running', ordinal, JSON.stringify(payload));
  item('main', 'live', 'subagent', 1, {subagentId: 'inline', title: 'Research'});
  item('main', 'live', 'subagent', 2, {subagentId: 'duplicate', childThreadId: 'child'});
  item('main', 'live', 'approval_request', 3, {requestId: 'r-1', prompt: 'Run: npm test'});
  item('main', 'live', 'approval_request', 4, {requestId: 'r-2', prompt: 'Run: npm run check'});
  item('question', 'previous', 'user_input_request', 5, {requestId: 'q-1', questions: [{question: 'Which option?'}]});
  item('child', 'delegate', 'command_execution', 7, {input: 'node --check tool.mjs'});
  item('child', 'delegate', 'checkpoint', 8, {});
  const request = (id, threadId, kind, time) =>
    insert(prefix + 'runtime_requests', id, threadId, kind, 'pending', time, null, '{}');
  request('r-1', 'main', 'command', '01');
  request('r-2', 'main', 'command', '02');
  request('q-1', 'question', 'user_input', '03');
  insert(prefix + 'provider_threads', 'main', '{"nativeThreadRef":{"nativeId":"t3-claude"}}');
  insert(prefix + 'provider_threads', 'held', '{"nativeThreadId":"held-is-not-active"}');
  insert('provider_session_runtime', 'child', '{"resume":"11111111-2222-3333-4444-555555555555"}');
  const settle = (id, status, decision) => db.prepare(
    `UPDATE ${prefix}runtime_requests SET status=?, resolved_at='now', payload_json=? WHERE runtime_request_id=?`,
  ).run(status, JSON.stringify({decision}), id);
  t.after(() => db.close());
  return {path, cwd, worktreePath, settle};
}

test('reads T3 worktrees, models, activity, lineage and exact pending requests from SQLite', async t => {
  const {path, cwd, worktreePath} = fixture(t);
  const {agents: t3, nativeIds} = readT3(DatabaseSync, path);
  assert.deepEqual([...t3.keys()], ['main', 'child', 'question', 'bad']);
  assert.deepEqual([...nativeIds], ['t3-claude', '11111111-2222-3333-4444-555555555555']);
  assert.equal(t3.get('main').cwd, worktreePath);
  assert.equal(t3.get('child').cwd, cwd);
  assert.equal(t3.get('child').activity, 'node --check tool.mjs');
  assert.deepEqual(t3.get('main').pending, {requestId: 'r-1', kind: 'approval', summary: 'Run: npm test', can: ['allow', 'deny']});
  assert.deepEqual(t3.get('question').pending, {requestId: 'q-1', kind: 'question', summary: 'Which option?', can: []});
  const payload = await makePayload({source, host, now: 0, t3, claude: [], resolveRepo: async () => null});
  assert.equal(payload.at, '1970-01-01T00:00:00.000Z');
  assert.equal(payload.source, source);
  const parent = payload.agents[0];
  assert.equal(parent.model, 'Opus 5.5');
  assert.equal(parent.vendor, 'claude');
  assert.equal(parent.hostLabel, 'fixture · T3');
  assert.equal(parent.children.length, 2);
  assert.deepEqual(parent.children[0], {id: 'child', title: 'Review tests', vendor: 'gemini', model: 'Gemini-3-pro', status: 'running'});
  assert.deepEqual(parent.children[1], {id: 'inline', title: 'Research', vendor: 'claude', model: 'Opus 5.5', status: 'running'});
});

test('prompt detector ignores unrelated commits and sees a new or edited prompt', t => {
  const {path, settle} = fixture(t);
  const writer = new DatabaseSync(path);
  writer.exec('PRAGMA journal_mode=WAL');
  const detector = createT3PromptDetector(DatabaseSync, path);
  t.after(() => { detector.close(); writer.close(); });
  assert.equal(detector.check(), true);
  assert.equal(detector.check(), false);
  writer.exec(`UPDATE ${prefix}threads SET title='Other title' WHERE thread_id='main'`);
  assert.equal(detector.check(), false);
  writer.prepare(`UPDATE ${prefix}turn_items SET payload_json=? WHERE ordinal=3`)
    .run(JSON.stringify({requestId: 'r-1', prompt: 'Run true?'}));
  assert.equal(detector.check(), true);
  settle('r-1', 'resolved', 'accept');
  assert.equal(detector.check(), true);
  assert.equal(detector.check(), false);
});

test('prompt notifications wake the report early and coalesce within the debounce', async () => {
  const report = createReportWake();
  const signal = AbortSignal.timeout(1000);
  const start = performance.now();
  const waiting = report.wait(3000, signal);
  report.notify();
  await delay(20);
  report.notify();
  await waiting;
  assert.ok(performance.now() - start >= 90);
  assert.equal(signal.aborted, false);
  const controller = new AbortController();
  const idle = report.wait(3000, controller.signal);
  const early = await Promise.race([idle.then(() => true), delay(150, false)]);
  controller.abort();
  await idle;
  assert.equal(early, false);
});

test('T3 session reuses the bearer and socket, reconnects and renews the token', async () => {
  class Socket extends EventTarget {
    readyState = WebSocket.OPEN;
    ids = [];
    send(frame) {
      const {id} = JSON.parse(frame);
      this.ids.push(id);
      this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({_tag: 'Exit', requestId: id, exit: {_tag: 'Success'}}),
      }));
    }
    close() {
      this.readyState = WebSocket.CLOSED;
      this.dispatchEvent(new Event('close'));
    }
  }
  const sockets = [];
  const tokens = [];
  const controller = new AbortController();
  let time = 0, issued = 0;
  const session = createT3Session('fixture', controller.signal, {
    now: () => time, portOf: () => 1234,
    issue: async () => 'token-' + ++issued,
    connect: async (_port, token) => {
      tokens.push(token);
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
  });
  try {
    await session.warm();
    await session.dispatch({}, () => true);
    await session.dispatch({}, () => true);
    await assert.rejects(session.dispatch({}, () => false), /no longer current/);
    assert.deepEqual(sockets[0].ids, ['1', '2']);
    assert.equal(issued, 1);
    sockets[0].close();
    await session.dispatch({}, () => true);
    assert.deepEqual(tokens, ['token-1', 'token-1']);
    time = 110000;
    await session.warm();
    assert.deepEqual(tokens, ['token-1', 'token-1', 'token-2']);
  } finally {
    controller.abort();
  }
  assert.equal(sockets.at(-1).readyState, WebSocket.CLOSED);
});

test('T3 session reads the model catalog and keeps its socket open after a catalog timeout', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  class Socket extends EventTarget {
    readyState = WebSocket.OPEN;
    respond = true;
    send(frame) {
      const {id, tag, payload} = JSON.parse(frame);
      assert.equal(tag, 'server.getConfig');
      assert.deepEqual(payload, {});
      if (!this.respond) return;
      const value = {providers: [{instanceId: 'work', driver: 'cursor', displayName: 'Work', enabled: true,
        models: [{slug: 'default', name: 'Auto'}, {slug: 'old', name: 'Old', isLegacy: true}]}]};
      this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify({_tag: 'Exit',
        requestId: id, exit: {_tag: 'Success', value}})}));
    }
    close() { this.readyState = WebSocket.CLOSED; }
  }
  const controller = new AbortController(), socket = new Socket();
  const session = createT3Session('fixture', controller.signal, {
    portOf: () => 1234, issue: async () => 'fixture-token', connect: async () => socket,
  });
  try {
    assert.deepEqual(await session.models(), [{id: 'work', driver: 'cursor', label: 'Work', enabled: true,
      models: [{slug: 'default', name: 'Auto'}]}]);
    socket.respond = false;
    const timeout = assert.rejects(session.models(), /did not answer in time/);
    await Promise.resolve();
    t.mock.timers.tick(5000);
    await timeout;
    assert.equal(socket.readyState, WebSocket.OPEN);
  } finally { controller.abort(); }
});

test('payload limits keep waiting agents, bound body size, and resolve safe Git remotes', async t => {
  const dir = scratch(t);
  const resolveRepo = createRepoResolver();
  await exec('git', ['-C', dir, 'init', '-q']);
  await exec('git', ['-C', dir, 'remote', 'add', 'origin', 'https://git:example-credential@example.test/team/demo.git?token=example']);
  assert.deepEqual(await resolveRepo(dir), {name: 'demo', remote: 'https://example.test/team/demo.git'});
  await exec('git', ['-C', dir, 'remote', 'remove', 'origin']);
  assert.equal((await resolveRepo(dir)).name, 'demo', 'uses the cached origin');
  assert.equal((await createRepoResolver()(dir)).remote, null);
  assert.equal(normalizeRemote('git@example.test:team/demo.git'), 'ssh://example.test/team/demo.git');
  assert.equal(normalizeRemote('C:\\local\\demo.git'), null);

  const long = '漢'.repeat(400);
  const t3 = new Map(Array.from({length: 210}, (_, n) => [
    'a' + n, {id: 'a' + n, title: long, activity: long,
      children: Array.from({length: 25}, (_, i) => ({id: 'c' + i, title: long}))},
  ]));
  t3.get('a209').pending = {requestId: 'req', kind: 'approval', summary: long, can: ['allow', 'deny']};
  t3.get('a209').status = 'waiting';
  const payload = await makePayload({source, host, now: 0, t3, claude: [], resolveRepo});
  assert.equal(payload.agents.length, 200);
  assert.equal(payload.agents[0].id, 'a209');
  assert.equal(payload.agents[0].title.length, 200);
  assert.equal(payload.agents[0].activity.length, 200);
  assert.equal(payload.agents[0].pending.summary.length, 200);
  assert.equal(payload.agents[0].children.length, 20);
  assert.ok(payload.agents.every(a => a.children.length <= 20));
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 1 << 20);
});

test('recent Claude transcripts provide titles and models and exclude T3 sessions', t => {
  const root = scratch(t);
  const project = join(root, 'projects', 'project');
  mkdirSync(project, {recursive: true});
  const now = Date.now();
  const write = (id, rows, mtime = now) => {
    const path = join(project, id + '.jsonl');
    writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n{broken');
    utimesSync(path, mtime / 1000, mtime / 1000);
  };
  const user = {type: 'user', cwd: root, message: {content: [{type: 'text', text: '  First\nprompt  '}]}};
  const assistant = {type: 'assistant', message: {model: 'claude-sonnet-4-5', content: []}};
  write('standalone', [null, {type: 'user', isMeta: true}, user, assistant]);
  write('t3-claude', [user, assistant]);
  write('tagged', [{...user, entrypoint: 'T3 Code'}, assistant]);
  write('old', [user, assistant], now - 360_000);
  write('waiting', [user, {type: 'assistant', message: {content: [{type: 'tool_use', id: 'q', name: 'AskUserQuestion',
    input: {questions: [{question: 'Which directory?'}]}}]}}]);
  const scan = createClaudeScanner(root);
  const rows = scan(new Set(['t3-claude']), now);
  assert.deepEqual(rows.map(a => a.id).sort(), ['claude:standalone', 'claude:waiting']);
  const [active, waiting] = rows.sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(active.title, 'First prompt');
  assert.equal(active.model, assistant.message.model);
  assert.equal(active.cwd, root);
  assert.equal(active.status, 'running');
  assert.equal(waiting.status, 'waiting');
  assert.deepEqual(waiting.pending, {requestId: 'q', kind: 'question', summary: 'Which directory?', can: []});
  assert.deepEqual(scan(new Set(), now + 360_000), []);
});

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return 'http://127.0.0.1:' + server.address().port;
}

const send = (res, status, body) => {
  res.writeHead(status, {'content-type': 'application/json'});
  res.end(JSON.stringify(body));
};

test('push and long poll deduplicate actions, verify T3, and retry failed acknowledgements', {timeout: 12000}, async t => {
  const {path, settle} = fixture(t);
  const controller = new AbortController();
  const calls = [];
  const results = new Map();
  const action = (id, agentId, requestId, decision = 'allow') => ({id, agentId, requestId, decision, source});
  const first = action('act-push', 'main', 'r-1');
  const second = action('act-poll', 'main', 'r-2', 'deny');
  let putCount = 0, polls = 0, ackAttempts = 0;
  let releasePut;
  const pushed = new Promise(resolve => { releasePut = resolve; });
  const respond = createT3Responder(DatabaseSync, path, async (dbPath, received, stillPending) => {
    assert.equal(dbPath, path);
    assert.equal(stillPending(), true);
    calls.push(received.id);
    settle(received.requestId, 'resolved', received.decision === 'allow' ? 'accept' : 'decline');
  });

  const url = await listen(t, async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/') return send(res, 404, {});
    if (req.headers.authorization !== 'Bearer ' + key) return send(res, 401, {});
    if (req.method === 'GET' && u.pathname === api + '/actions' && u.searchParams.get('source') === source
      && u.searchParams.get('wait') === '25') {
      await pushed;
      polls++;
      if (polls === 1) {
        return send(res, 200, {actions: [first, second, action('act-stale', 'main', 'r-1'),
          action('act-question', 'question', 'q-1'), action('act-claude', 'claude:session', 'tool')]});
      }
      await delay(100);
      return send(res, 200, {actions: []});
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    if (req.method === 'PUT' && u.pathname === api + '/agents' && body.source === source) {
      putCount++;
      send(res, 200, {actions: putCount === 1 ? [first] : []});
      return releasePut();
    }
    if (req.method === 'POST' && u.pathname.startsWith(api + '/actions/')) {
      const id = u.pathname.split('/').at(-1);
      if (id === first.id && ++ackAttempts === 1) return send(res, 503, {});
      results.set(id, body);
      send(res, 200, {});
      if (results.size === 5) controller.abort();
      return;
    }
    send(res, 404, {});
  });

  await runBridge({
    cfg: {url, key}, source, interval: 100, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    scan: () => makePayload({source, host, now: Date.now(), t3: readT3(DatabaseSync, path).agents,
      claude: [], resolveRepo: async () => null}),
    respond, log: () => {},
  });
  assert.ok(putCount > 1);
  assert.ok(polls > 0);
  assert.equal(ackAttempts, 2);
  assert.deepEqual(calls, ['act-push', 'act-poll']);
  assert.deepEqual(results.get(first.id), {ok: true, message: 'Approved in T3 Code.'});
  assert.deepEqual(results.get(second.id), {ok: true, message: 'Denied in T3 Code.'});
  for (const id of ['act-stale', 'act-question', 'act-claude']) assert.equal(results.get(id).ok, false);
});

test('a T3 cancellation or other decision is never acknowledged as success', async t => {
  const {path, settle} = fixture(t);
  const signal = new AbortController().signal;
  const action = {agentId: 'main', requestId: 'r-1', decision: 'allow'};
  const respond = createT3Responder(DatabaseSync, path, async () => settle('r-1', 'resolved', 'decline'));
  assert.equal((await respond(action, signal)).ok, false);
  const cancelled = createT3Responder(DatabaseSync, path, async () => settle('r-2', 'cancelled'));
  assert.equal((await cancelled({...action, requestId: 'r-2'}, signal)).ok, false);
});

test('CLI help and once/dry-run work with the regular Flow config', async t => {
  const {path, cwd} = fixture(t);
  let count = 0;
  const url = await listen(t, async (req, res) => {
    if (req.url === '/') return send(res, 404, {});
    if (req.method !== 'PUT' || req.url !== api + '/agents' || req.headers.authorization !== 'Bearer ' + key) {
      return send(res, 401, {});
    }
    for await (const chunk of req) void chunk;
    count++;
    send(res, 200, {actions: []});
  });
  mkdirSync(join(cwd, 'flygon-flow'));
  writeFileSync(join(cwd, 'flygon-flow', 'config.json'), JSON.stringify({url, key}));
  const env = {...process.env, XDG_CONFIG_HOME: cwd, CLAUDE_CONFIG_DIR: cwd, FLOW_URL: '', FLOW_API_KEY: ''};
  const run = (...flags) => exec(process.execPath, ['tools/flow.mjs', 'office', 'bridge', ...flags], {env, timeout: 10000});
  assert.match((await run('--help')).stdout, /--t3-db/);
  const flags = ['--once', '--t3-db', path, '--source', source];
  const dry = JSON.parse((await run(...flags, '--dry-run')).stdout);
  assert.equal(count, 0);
  const sent = JSON.parse((await run(...flags)).stdout);
  assert.equal(count, 1);
  assert.deepEqual(sent.agents, dry.agents);
  assert.equal(sent.source, source);
});

test('report errors back off and authorization errors wait longer', async t => {
  const controller = new AbortController();
  const waits = [];
  let calls = 0;
  const url = await listen(t, (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + key) return send(res, 401, {});
    if (req.method === 'GET' && req.url.startsWith(api + '/actions?')) return send(res, 200, {actions: []});
    if (req.url !== api + '/agents' || req.method !== 'PUT') return send(res, 404, {});
    req.resume();
    req.on('end', () => send(res, ++calls <= 2 ? 503 : 403, {}));
  });
  await runBridge({
    cfg: {url, key}, source, signal: controller.signal, log: () => {},
    scan: async () => ({source, agents: []}),
    sleep: async ms => {
      if (ms <= 500) return delay(1);
      waits.push(ms);
      if (waits.length === 3) controller.abort();
    },
  });
  assert.deepEqual(waits, [3000, 6000, 120000]);
});

test('agent runner threads are tagged with their AgentFlow agent and card', async () => {
  assert.deepEqual(agentflowOf('[Flow] Builder: #12 Fix the login bug'), {agent: 'Builder', card: 12});
  assert.deepEqual(agentflowOf('[Flow] Ops: Infra: #9 Rotate keys'), {agent: 'Ops: Infra', card: 9});
  for (const title of ['Fix #12', '[Flow] Pick a model for #12', '', undefined]) assert.equal(agentflowOf(title), null, String(title));
  const t3 = new Map([
    ['run', {id: 'run', title: '[Flow] Builder: #12 Fix the login bug', model: 'claude-opus-5-5', status: 'running'}],
    ['own', {id: 'own', title: 'Look at #12 myself', model: 'claude-opus-5-5', status: 'running'}],
  ]);
  const payload = await makePayload({source, host, now: 0, t3, claude: [], resolveRepo: async () => null});
  assert.deepEqual(payload.agents.map(a => a.agentflow), [{agent: 'Builder', card: 12}, undefined],
    'a plain "#12" is left for the server to read');
});
