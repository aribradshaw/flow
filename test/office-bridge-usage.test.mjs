import assert from 'node:assert/strict';
import {appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {makePayload} from '../tools/office-bridge.mjs';
import {createClaudeScanner} from '../tools/office-bridge-claude.mjs';
import {createCodexScanner} from '../tools/office-bridge-codex.mjs';
import {createT3Usage, createTranscriptUsage, localDay} from '../tools/office-bridge-usage.mjs';

const now = new Date(2026, 10, 14, 12).getTime();
const day = localDay(now);
const yesterday = new Date(Date.parse(day.start) - 1).toISOString();
const line = row => JSON.stringify(row) + '\n';

function scratch(t) {
  const base = join(homedir(), 'scratch', 'flow-usage');
  mkdirSync(base, {recursive: true});
  const dir = mkdtempSync(join(base, 'bridge-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function claude(id, timestamp, model = 'claude-opus-5-5') {
  return {type: 'assistant', timestamp, message: {id, model, usage: {
    input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 30, cache_read_input_tokens: 60,
    cache_creation: {ephemeral_1h_input_tokens: 20},
  }}};
}

test('Claude usage counts the local day once per message and resumes at the last complete line', t => {
  const root = scratch(t);
  const dir = join(root, 'projects', 'fixture');
  mkdirSync(dir, {recursive: true});
  const path = join(dir, 'session.jsonl');
  const current = line(claude('today', day.start));
  const added = line(claude('unknown', day.start, 'unpriced-model'));
  const prefix = line(claude('yesterday', yesterday)) + current + current + line(claude('tomorrow', day.end));
  writeFileSync(path, prefix + added.slice(0, 30));
  const transcript = createTranscriptUsage('claude');
  const first = transcript.read(path, day);
  assert.equal(first.offset, Buffer.byteLength(prefix));
  assert.deepEqual(first.usage, {tokens: 200, costUsd: 0.000822});
  const scan = createClaudeScanner(root);
  utimesSync(path, now / 1000, now / 1000);
  assert.deepEqual(scan(new Set(), now)[0].usage, first.usage);
  appendFileSync(path, added.slice(30));
  assert.deepEqual(transcript.read(path, day).usage, {tokens: 400});
  assert.deepEqual(scan(new Set(), now)[0].usage, {tokens: 400});
  assert.deepEqual(transcript.read(path, localDay(Date.parse(day.end))).usage, {tokens: 200, costUsd: 0.000822});
  writeFileSync(path, current);
  assert.deepEqual(transcript.read(path, day).usage, {tokens: 200, costUsd: 0.000822});
});

test('Codex reports cumulative deltas and excludes T3-managed sessions', async t => {
  const root = scratch(t);
  const date = new Date(now);
  const dir = join(root, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
  mkdirSync(dir, {recursive: true});
  const path = join(dir, 'rollout-fixture.jsonl');
  const count = (timestamp, input, cached, output) => line({timestamp, type: 'event_msg', payload: {type: 'token_count',
    info: {total_token_usage: {input_tokens: input, cached_input_tokens: cached, output_tokens: output}},
  }});
  const current = count(day.start, 200, 120, 30);
  const rows = line({type: 'turn_context', payload: {model: 'gpt-6.2-sol'}}) +
    count(yesterday, 100, 50, 20) + current + current;
  writeFileSync(path, line({type: 'session_meta', payload: {id: 'fixture', source: 'cli'}}) + rows);
  writeFileSync(join(dir, 'rollout-t3.jsonl'), line({type: 'session_meta', payload: {id: 'managed', source: 'cli', originator: 'T3 Code'}}) + rows);
  const scan = createCodexScanner(root, DatabaseSync);
  const codex = scan(new Set(), now);
  assert.equal(codex.length, 1);
  assert.deepEqual(codex[0].usage, {tokens: 110, costUsd: 0.000167});
  assert.deepEqual(scan(new Set(['fixture']), now), []);
  appendFileSync(path, count(day.start, 210, 120, 31));
  assert.equal(scan(new Set(), now)[0].usage.tokens, 121);
  const payload = await makePayload({source: 'fixture', host: 'fixture', now, t3: new Map(), claude: [], codex, resolveRepo: () => null});
  assert.deepEqual(payload.agents[0].usage, codex[0].usage);
});

test('T3 rechecks pending turns and counts complete rows only once', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT PRIMARY KEY, thread_id, run_attempt_id, started_at, payload_json);
    CREATE TABLE orchestration_v2_projection_run_attempts (attempt_id TEXT PRIMARY KEY, run_id);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, payload_json);
    INSERT INTO orchestration_v2_projection_run_attempts VALUES ('attempt', 'run');
    INSERT INTO orchestration_v2_projection_runs VALUES ('run', '{"modelSelection":{"model":"gpt-6.2-sol"}}');
  `);
  const insert = db.prepare('INSERT INTO orchestration_v2_projection_provider_turns VALUES (?, ?, ?, ?, ?)');
  const complete = JSON.stringify({turnTokenUsage: {usageStatus: 'complete', inputTokens: 100, outputTokens: 10,
    cachedInputTokens: 60, cacheCreationTokens: 10, reasoningTokens: 8}});
  insert.run('previous', 'thread', 'attempt', yesterday, complete);
  insert.run('today', 'thread', 'attempt', day.start, complete);
  insert.run('pending', 'thread', 'attempt', day.start, '{"tokenUsage":{"inputTokens":10000}}');
  insert.run('next', 'thread', 'attempt', day.end, complete);
  const usage = createT3Usage();
  assert.deepEqual(usage(db, 'db', 'thread', day), {tokens: 110, costUsd: 0.000191});
  db.prepare('UPDATE orchestration_v2_projection_provider_turns SET payload_json=? WHERE provider_turn_id=?').run(complete, 'pending');
  insert.run('unknown', 'thread', null, day.start, complete);
  assert.deepEqual(usage(db, 'db', 'thread', day), {tokens: 330});
  assert.deepEqual(usage(db, 'db', 'thread', day), {tokens: 330});
  assert.deepEqual(usage(db, 'db', 'thread', localDay(Date.parse(day.end))), {tokens: 110, costUsd: 0.000191});
});
