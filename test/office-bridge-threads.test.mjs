// flow office bridge: your T3 thread index, live steps and history pages, read from a fixture T3 database
// (tools/office-bridge-threads.mjs). Scratch folders under ~/scratch only.
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {liveFromTranscript, readHistory, readLive, readRunningLive, readThreads, stepOf, threadAlive, createLiveWatcher} from '../tools/office-bridge-threads.mjs';
import {createT3Responder, readT3} from '../tools/office-bridge-t3.mjs';
import {createLiveStream, createThreadsOut, makePayload} from '../tools/office-bridge.mjs';

const P = 'orchestration_v2_projection_';
const NOW = Date.parse('2026-11-22T12:00:00Z'), iso = min => new Date(NOW + min * 60e3).toISOString();
function scratch(t) {
  const root = join(homedir(), 'scratch', 'flow-threads');
  mkdirSync(root, {recursive: true});
  const dir = mkdtempSync(join(root, 'bridge-threads-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}
function fixture(t) {
  const path = join(scratch(t), 'statev2.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE projection_projects(project_id, title, workspace_root);
    CREATE TABLE ${P}threads(thread_id, project_id, title, updated_at, archived_at, deleted_at, provider_instance_id, payload_json);
    CREATE TABLE ${P}runs(run_id, thread_id, ordinal, status, provider, requested_at, completed_at, payload_json);
    CREATE TABLE ${P}turn_items(thread_id, run_id, type, status, ordinal, updated_at, payload_json);
    CREATE TABLE ${P}runtime_requests(runtime_request_id, thread_id, kind, status, created_at, resolved_at, payload_json);
  `);
  const insert = (table, ...values) => db.prepare(`INSERT INTO ${table} VALUES (${values.map(() => '?').join(',')})`).run(...values);
  insert('projection_projects', 'p1', 'Flow', '/w/flow');
  insert('projection_projects', 'p2', 'SongBrain', '/w/songbrain');
  const thread = (id, title, payload, {project = 'p1', updated = iso(-60), archived = null, deleted = null} = {}) =>
    insert(P + 'threads', id, project, title, updated, archived, deleted, 'claudeAgent', JSON.stringify({branch: 'main', ...payload}));
  const run = (id, threadId, ordinal, status, requested, completed = null, payload = {}) =>
    insert(P + 'runs', id, threadId, ordinal, status, 'claudeAgent', requested, completed, JSON.stringify(payload));
  let ordinal = 1000;
  const item = (threadId, runId, type, payload, status = 'completed') => insert(P + 'turn_items', threadId, runId, type, status, ++ordinal, iso(-1), JSON.stringify(payload));
  // working: a running turn, thinking now (streamed reasoning), after a command and a tool.
  thread('work', 'Add a Shared 3D Agent Office', {});
  run('w1', 'work', 1, 'running', iso(-2));
  item('work', 'w1', 'user_message', {text: 'Build the office'});
  item('work', 'w1', 'command_execution', {input: 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz && npm test\nsecond line', output: 'ok'});
  item('work', 'w1', 'dynamic_tool', {toolName: 'Read', title: 'Read /home/someone/code/app/lib/auth.mjs'});
  item('work', 'w1', 'dynamic_tool', {toolName: 'mcp__flow__cards_list', title: null});
  item('work', 'w1', 'reasoning', {title: null, text: '**Checking UAT cards**\n\nListing what is in UAT before answering', streaming: true}, 'running');
  // waiting: an open approval.
  thread('wait', 'Verify Card 306', {});
  run('a1', 'wait', 1, 'running', iso(-5));
  insert(P + 'runtime_requests', 'req-1', 'wait', 'command', 'pending', iso(-1), null, '{}');
  // woke: snoozed until 10 minutes ago, not visited since.
  thread('woke', 'Campaign Baby Maricopa', {snoozedUntil: iso(-10), snoozedAt: iso(-600), lastVisitedAt: iso(-700)}, {project: 'p2', updated: iso(-10)});
  run('k1', 'woke', 1, 'completed', iso(-800), iso(-790));
  // done, unread: finished after the last visit; done, read.
  thread('done', 'Chief of Staff', {lastVisitedAt: iso(-30)});
  run('d1', 'done', 1, 'completed', iso(-25), iso(-20));
  thread('seen', 'Old answer', {lastVisitedAt: iso(-1)}, {updated: iso(-300)});
  run('s1', 'seen', 1, 'completed', iso(-400), iso(-390));
  // snoozed (still ahead), settled, delegated (rolls up), archived and deleted (left out).
  thread('snz', 'Later', {snoozedUntil: iso(60)});
  thread('set1', 'Settled one', {settledOverride: 'settled', settledAt: iso(-100)}, {updated: iso(-100)});
  thread('set2', 'Settled two', {settledOverride: 'settled', settledAt: iso(-200)}, {updated: iso(-200)});
  thread('child', 'Delegated', {lineage: {parentThreadId: 'work'}});
  run('c1', 'child', 1, 'running', iso(-1));
  thread('arch', 'Archived', {}, {archived: iso(-5)});
  thread('gone', 'Deleted', {}, {deleted: iso(-5)});
  // A long conversation for history paging: 130 items in 'seen'.
  for (let i = 0; i < 130; i++) item('seen', 's1', ['user_message', 'assistant_message', 'reasoning', 'command_execution', 'checkpoint'][i % 5],
    {text: 'message ' + i, input: 'npm run step-' + i, title: i % 5 === 2 ? 'Thinking ' + i : null, output: 'output ' + i});
  t.after(() => db.close());
  return {path, db, item, insert};
}
const open = path => { const db = new DatabaseSync(path, {readOnly: true}); return db; };

test('thread index: T3 sidebar states, delegated, archived and deleted threads left out, counts and newest first', t => {
  const {path} = fixture(t);
  const db = open(path);
  try {
    const {items, counts, can} = readThreads(db, {now: NOW});
    const state = Object.fromEntries(items.map(x => [x.id, x.state]));
    assert.deepEqual(state, {work: 'working', wait: 'waiting', woke: 'woke', done: 'done', seen: 'done', snz: 'snoozed', set1: 'settled', set2: 'settled'});
    assert.equal(items.find(x => x.id === 'done').unread, true);
    assert.equal(items.find(x => x.id === 'seen').unread, undefined);
    assert.deepEqual(counts, {snoozed: 1, settled: 2});
    assert.deepEqual(can, ['message', 'history']);
    assert.deepEqual(items.find(x => x.id === 'woke'), {id: 'woke', title: 'Campaign Baby Maricopa', project: 'SongBrain', state: 'woke', updatedAt: iso(-10), branch: 'main'});
    assert.deepEqual(items.slice(0, 2).map(x => x.id), ['work', 'wait'], 'newest first');
    // Capped: the open ones first, then the newest snoozed and settled.
    const few = readThreads(db, {now: NOW, max: 6}).items.map(x => x.id);
    assert.equal(few.length, 6);assert.ok(!few.includes('set2'));
    assert.equal(threadAlive(db, 'seen'), true);
    for (const id of ['child', 'arch', 'gone', 'nope']) assert.equal(threadAlive(db, id), false, id);
  } finally { db.close(); }
});

test('live steps: the running turn\'s last steps, its streamed reasoning, tool names made short, masked', t => {
  const {path, item} = fixture(t);
  let db = open(path);
  try {
    const live = readLive(db, 'work', 'w1');
    assert.equal(live.phase, 'thinking');
    assert.equal(live.text, '**Checking UAT cards**\n\nListing what is in UAT before answering');
    assert.deepEqual(live.steps.map(s => [s.kind, s.text]), [
      ['tool', 'Run: export GITHUB_TOKEN=••• && npm test'], ['tool', 'Read lib/auth.mjs'], ['tool', 'flow: cards list'], ['thinking', 'Checking UAT cards']]);
    assert.ok(!JSON.stringify(live).includes('ghp_'), 'masked before it leaves');
    assert.deepEqual([...readRunningLive(db).keys()].sort(), ['wait', 'work'], 'top-level running turns only');
  } finally { db.close(); }
  // It writes its reply: the phase follows, and the live text is the end of what it is writing.
  item('work', 'w1', 'assistant_message', {text: 'There are 18 cards in UAT: ' + 'x'.repeat(900)}, 'running');
  db = open(path);
  try {
    const live = readLive(db, 'work', 'w1');
    assert.equal(live.phase, 'writing');assert.ok(live.text.startsWith('…') && live.text.length <= 600);
    assert.ok(live.steps.length <= 8);
    // readT3 carries it on the agent, and makePayload sends it.
    const {agents} = readT3(DatabaseSync, path);
    assert.equal(agents.get('work').live.phase, 'writing');
  } finally { db.close(); }
  assert.equal(stepOf('checkpoint', {}), null);
  assert.deepEqual(stepOf('file_change', {fileName: '/a/b/c/d.js'}), {kind: 'tool', text: 'Edit: c/d.js'});
});

test('Claude Code: live steps from the transcript tail since its last prompt', async () => {
  const live = liveFromTranscript([{role: 'user', text: 'old'}, {role: 'tool', text: 'Run: ls'}, {role: 'user', text: 'Fix it'},
    {role: 'tool', text: 'Read: auth.mjs', at: iso(0)}, {role: 'assistant', text: 'Found it: token=abcdefghijklmnop', at: iso(1)}]);
  assert.deepEqual(live.steps.map(s => s.text), ['Read: auth.mjs', 'Found it: token=•••']);
  assert.equal(live.phase, 'writing');
  assert.equal(liveFromTranscript([{role: 'user', text: 'x'}]), null);
  const payload = await makePayload({source: 's', host: 'h', now: 0, t3: new Map(), resolveRepo: async () => null,
    claude: [{id: 'claude:1', title: 'Terminal', status: 'running', provider: 'claudeAgent', transcript: [{role: 'user', text: 'Go'}, {role: 'tool', text: 'Run: npm test'}]}],
    threads: {items: [], counts: {snoozed: 0, settled: 0}, can: ['message', 'history']}});
  assert.equal(payload.agents[0].live.text, 'Run: npm test');
  assert.deepEqual(payload.threads.can, ['message', 'history']);
});

test('history: pages of 60, newest first in the thread, oldest first in a page, a cursor until the start', t => {
  const {path} = fixture(t);
  const db = open(path);
  try {
    const first = readHistory(db, 'seen');
    assert.equal(first.more, true);assert.match(first.before, /^o:\d+$/);
    // 130 items, every fifth a checkpoint (skipped): 104 kept.
    assert.equal(first.items.at(-1).title, 'Run: npm run step-128', 'the newest last');
    assert.equal(first.items.length, 60);
    const roles = new Set(first.items.map(x => x.role));
    assert.deepEqual([...roles].sort(), ['assistant', 'reasoning', 'tool', 'user']);
    const tool = first.items.find(x => x.role === 'tool');
    assert.match(tool.title, /^Run: npm run step-\d+$/);assert.match(tool.detail, /^output \d+$/);assert.equal(tool.status, 'completed');
    const second = readHistory(db, 'seen', first.before);
    const third = second.more ? readHistory(db, 'seen', second.before) : {items: [], more: false};
    const all = [...third.items, ...second.items, ...first.items];
    assert.equal(all.length, 104);
    assert.equal(third.more, false);assert.equal(third.before ?? null, null);
    const texts = all.filter(x => x.role === 'user').map(x => x.text);
    assert.deepEqual(texts.slice(0, 2), ['message 0', 'message 5'], 'nothing skipped or repeated across pages');
    assert.equal(new Set(all.map(x => (x.text ?? '') + (x.title ?? ''))).size, 104);
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 64 * 1024);
  } finally { db.close(); }
});

test('history pages stay within the byte budget, and continue where the budget cut them', t => {
  const {path, item} = fixture(t);
  for (let i = 0; i < 40; i++) item('done', 'd1', 'assistant_message', {text: 'y'.repeat(3000) + ' #' + i});
  const db = open(path);
  try {
    const first = readHistory(db, 'done');
    assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 56 * 1024 + 2000);
    assert.equal(first.more, true);assert.ok(first.items.length < 40);
    const second = readHistory(db, 'done', first.before);
    const nums = [...second.items, ...first.items].map(x => Number(/#(\d+)$/.exec(x.text)?.[1]));
    assert.deepEqual(nums.slice(-first.items.length - 3), Array.from({length: first.items.length + 3}, (_, i) => 40 - first.items.length - 3 + i));
  } finally { db.close(); }
});

test('the responder: history pages, and messages to idle threads that are still there', async t => {
  const {path} = fixture(t);
  const sent = [];
  const respond = createT3Responder(DatabaseSync, path, async () => {}, {message: async (_p, m) => { sent.push(m); return {delivery: 'started'}; }, stop: async () => {}});
  const h = await respond({id: 'a', agentId: 'seen', kind: 'history'}, AbortSignal.timeout(5000));
  assert.equal(h.ok, true);assert.match(h.message, /^\d+ items$/);assert.ok(h.data.items.length > 0);
  assert.equal((await respond({id: 'b', agentId: 'child', kind: 'history'}, AbortSignal.timeout(5000))).ok, false, 'a delegated thread');
  const m = await respond({id: 'c', agentId: 'done', kind: 'message', text: 'Pick this back up'}, AbortSignal.timeout(5000));
  assert.deepEqual([m.ok, sent.map(x => [x.agentId, x.text])], [true, [['done', 'Pick this back up']]]);
  for (const id of ['arch', 'gone', 'child', 'nope']) {
    const r = await respond({id: 'd', agentId: id, kind: 'message', text: 'hi'}, AbortSignal.timeout(5000));
    assert.equal(r.ok, false, id);
  }
  assert.equal(sent.length, 1);
  assert.equal((await respond({id: 'e', agentId: 'done', kind: 'stop'}, AbortSignal.timeout(5000))).ok, false, 'nothing to stop');
});

test('live stream: debounced, only what changed, a new or finished turn or index change asks for a report', async () => {
  let t = 0, live = new Map([['a', {phase: 'thinking', text: 'x', steps: []}]]), index = 'i1', changed = false;
  const posts = [], wakes = [];
  const stream = createLiveStream({read: () => ({live, index}), post: async agents => { posts.push(agents); }, wake: () => wakes.push(t),
    changed: () => { const c = changed; changed = false; return c; }, pollMs: 5, debounceMs: 30, maxWaitMs: 80, gapMs: 0});
  stream.reported([{id: 'a', status: 'running', live: {phase: 'thinking', text: 'x', steps: []}}]);
  stream.start();
  const settle = ms => new Promise(r => setTimeout(r, ms));
  try {
    changed = true; await settle(80);
    assert.deepEqual(posts, [], 'nothing new');
    assert.deepEqual(wakes, [], 'the first read only learns the index');
    live = new Map([['a', {phase: 'tool', text: 'Run: npm test', steps: []}]]);
    const started = Date.now();
    changed = true; await settle(10); changed = true; await settle(100);
    assert.equal(posts.length, 1, 'two changes, one update');
    assert.ok(Date.now() - started < 200);
    assert.deepEqual(posts[0], [{id: 'a', live: {phase: 'tool', text: 'Run: npm test', steps: []}}]);
    changed = true; await settle(80);
    assert.equal(posts.length, 1, 'sent once');
    live = new Map([...live, ['b', null]]);
    changed = true; await settle(80);
    assert.equal(wakes.length, 1, 'a new turn: a full report');
    live = new Map([['a', live.get('a')]]); index = 'i2';
    changed = true; await settle(80);
    assert.equal(wakes.length, 2, 'the index changed: a full report');
  } finally { stream.stop(); }
});

test('threads go in a report when they change, and once a minute', () => {
  let data = {items: [{id: 'a', state: 'done'}]}, t = 0;
  const out = createThreadsOut({read: () => data, now: () => t});
  const first = out.take();assert.deepEqual(first, data);
  assert.deepEqual(out.take(), data, 'not sent yet: again');
  out.sent({threads: first});
  assert.equal(out.take(), undefined);
  data = {items: [{id: 'a', state: 'working'}]};
  const changed = out.take();assert.equal(changed.items[0].state, 'working');out.sent({threads: changed});
  assert.equal(out.take(), undefined);
  t += 61e3;assert.ok(out.take(), 'once a minute');
});

test('the live watcher notices T3 writes', t => {
  const {path, item} = fixture(t);
  const w = createLiveWatcher(DatabaseSync, path);
  try {
    assert.equal(w.check(), false);
    assert.equal(w.check(), false);
    item('work', 'w1', 'command_execution', {input: 'ls'});
    assert.equal(w.check(), true);
    assert.equal(w.check(), false);
  } finally { w.close(); }
});
