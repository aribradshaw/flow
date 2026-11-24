import {closeSync, fstatSync, openSync, readSync} from 'node:fs';

// USD per million tokens: input, output, short cache write, cache read, long cache write (Claude only).
// Standard API rates, last checked 2026-11-22.
// https://platform.claude.com/docs/en/about-claude/pricing
// https://developers.openai.com/api/docs/pricing
// https://developers.openai.com/api/docs/models/gpt-5.2-codex
const prices = new Map([
  ['claude-fable-5-2', [8, 40, 10, 0.20, 16]],
  ['claude-opus-5-5', [4, 20, 5, 0.20, 8]],
  ['claude-sonnet-5-5', [2, 10, 2.50, 0.10, 4]],
  ['claude-opus-5', [5, 25, 6.25, 0.50, 10]],
  ['claude-opus-4-8', [5, 25, 6.25, 0.50, 10]],
  ['claude-opus-4-7', [5, 25, 6.25, 0.50, 10]],
  ['claude-opus-4-6', [5, 25, 6.25, 0.50, 10]],
  ['claude-opus-4-5', [5, 25, 6.25, 0.50, 10]],
  ['claude-sonnet-4-6', [3, 15, 3.75, 0.30, 6]],
  ['claude-sonnet-4-5', [3, 15, 3.75, 0.30, 6]],
  ['claude-haiku-4-5', [1, 5, 1.25, 0.10, 2]],
  ['gpt-6.2-astra', [8, 40, 10, 0.40]],
  ['gpt-6.2-sol', [2, 10, 2.50, 0.10]],
  ['gpt-6-astra', [10, 50, 12.50, 1]],
  ['gpt-6.1-sol', [2, 10, 2.50, 0.10]],
  ['gpt-6.1-terra', [1, 5, 1.25, 0.05]],
  ['gpt-5.4', [2.50, 15, 2.50, 0.25]],
  ['gpt-5.3-codex', [1.75, 14, 1.75, 0.175]],
  ['gpt-5.2-codex', [1.75, 14, 1.75, 0.175]],
  ['gpt-5.2', [1.75, 14, 1.75, 0.175]],
]);

export function localDay(now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {start: start.toISOString(), end: end.toISOString()};
}

function today(at, day) {
  const time = Date.parse(at);
  return time >= Date.parse(day.start) && time < Date.parse(day.end);
}

function isCount(value) {
  return Number.isFinite(value) && value >= 0;
}

function buckets(record, keys) {
  const counts = keys.map(key => record?.[key]);
  return counts.some(isCount) ? counts.map(count => isCount(count) ? count : 0) : null;
}

function estimate(model, counts) {
  const key = String(model ?? '').toLowerCase().split('/').at(-1)
    .replace(/\[[^\]]+\]$/, '').replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  const rates = prices.get(key.startsWith('claude-') ? key.replace(/\./g, '-') : key);
  const tokens = counts.reduce((sum, count) => sum + count, 0);
  const costUsd = rates && counts.reduce((sum, count, index) => sum + count * rates[index], 0) / 1e6;
  return {tokens, ...(isCount(costUsd) ? {costUsd} : {})};
}

export function sumUsage(entries) {
  let tokens = 0, costUsd = 0, found = false, priced = true;
  for (const entry of entries) {
    if (!entry) continue;
    found = true;
    tokens += entry.tokens;
    if (isCount(entry.costUsd)) costUsd += entry.costUsd;
    else priced = false;
  }
  if (found && isCount(tokens)) return {tokens, ...(priced && isCount(costUsd) ? {costUsd} : {})};
}

export function parseUsageJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Resume at the last newline, so a partially written row can be retried on the next scan.
export function createTranscriptUsage(kind) {
  const files = new Map();
  let currentDay;
  return {
    read(path, day) {
      if (day.start !== currentDay) {
        currentDay = day.start;
        files.clear();
      }
      const fd = openSync(path, 'r');
      try {
        const {dev, ino, size, mtimeMs} = fstatSync(fd);
        const identity = `${dev}:${ino}`;
        let state = files.get(path);
        if (!state || state.identity !== identity || size < state.size
          || (size === state.size && mtimeMs !== state.mtimeMs)) {
          state = {identity, offset: 0, size: 0, messages: new Map()};
          files.set(path, state);
        }
        if (size === state.size && mtimeMs === state.mtimeMs) return state;
        const buffer = Buffer.alloc(64 * 1024);
        let fragments = [];
        for (let position = state.offset; position < size;) {
          const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
          if (!bytes) break;
          let start = 0;
          for (let end; (end = buffer.indexOf(10, start)) >= 0 && end < bytes; start = end + 1) {
            const piece = buffer.subarray(start, end);
            const text = fragments.length ? Buffer.concat([...fragments, piece]).toString() : piece.toString();
            const candidate = kind === 'claude' ? text.includes('"usage"')
              : text.includes('"token_count"') || text.includes('"turn_context"')
                || text.includes('"session_meta"') || /"task_started"|"task_complete"|"turn_aborted"/.test(text);
            const row = candidate && parseUsageJson(text);
            if (row) {
              if (kind === 'claude') claudeUsage(state, row, day);
              else codexUsage(state, row, day);
            }
            fragments = [];
            state.offset = position + end + 1;
          }
          if (start < bytes) fragments.push(Buffer.from(buffer.subarray(start, bytes)));
          position += bytes;
        }
        Object.assign(state, {size, mtimeMs});
        state.usage = kind === 'claude'
          ? sumUsage([state.total, ...state.messages.values()]) : state.total;
        return state;
      } finally {
        closeSync(fd);
      }
    },
  };
}

function claudeUsage(state, row, day) {
  const message = row.message;
  if (!message || row.isSidechain || message.model === '<synthetic>' || !today(row.timestamp, day)) return;
  const usage = message.usage;
  const counts = buckets(usage, ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']);
  if (!counts) return;
  const longWrite = Math.min(counts[2], isCount(usage.cache_creation?.ephemeral_1h_input_tokens)
    ? usage.cache_creation.ephemeral_1h_input_tokens : 0);
  counts[2] -= longWrite;
  const value = estimate(message.model, [...counts, longWrite]);
  // Claude writes one row per message block, repeating the request's usage.
  const id = message.id || row.requestId || row.uuid;
  if (id) state.messages.set(id, value);
  else state.total = sumUsage([state.total, value]);
}

function codexUsage(state, row, day) {
  const payload = row.payload;
  if (row.type === 'session_meta') state.meta = {id: payload?.id, cwd: payload?.cwd, source: payload?.source, originator: payload?.originator};
  if (row.type === 'turn_context' && payload?.model) state.model = payload.model;
  if (row.type !== 'event_msg') return;
  if (payload?.type === 'task_started') state.running = true;
  if (['task_complete', 'turn_aborted'].includes(payload?.type)) state.running = false;
  if (payload?.type !== 'token_count') return;
  const keys = ['input_tokens', 'output_tokens', 'cache_write_input_tokens', 'cached_input_tokens'];
  const current = buckets(payload.info?.total_token_usage, keys);
  if (!current) return;
  const previous = state.cumulative;
  state.cumulative = current;
  if (!today(row.timestamp, day)) return;
  // Counters include earlier turns, and rate-limit-only events can repeat the same totals.
  const counts = previous && current.every((count, i) => count >= previous[i])
    ? current.map((count, i) => count - previous[i]) : current;
  if (counts.some(Boolean)) state.total = sumUsage([state.total, estimate(state.model, splitInput(counts))]);
}

function splitInput([input, output, write, read]) {
  // T3 and Codex include cache tokens in input and reasoning tokens in output.
  write = Math.min(write, input);
  read = Math.min(read, input - write);
  return [input - write - read, output, write, read];
}

// T3's provider-turn projections have an index on thread_id. The context-window tokenUsage
// snapshot is a separate field and only represents the last request, not total turn usage.
const t3Rows = `SELECT t.rowid AS position, t.provider_turn_id AS id,
    json_extract(t.payload_json, '$.turnTokenUsage') AS usage,
    json_extract(r.payload_json, '$.modelSelection.model') AS model
  FROM orchestration_v2_projection_provider_turns t
  LEFT JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id=t.run_attempt_id
  LEFT JOIN orchestration_v2_projection_runs r ON r.run_id=a.run_id`;

export function createT3Usage() {
  let key;
  const threads = new Map();
  return (db, identity, thread, day) => {
    const nextKey = `${identity}:${day.start}`;
    if (key !== nextKey) {
      key = nextKey;
      threads.clear();
    }
    const state = threads.get(thread) ?? {position: 0, pending: new Set()};
    try {
      const rows = db.prepare(t3Rows + ' WHERE t.thread_id=? AND t.rowid>? AND t.started_at>=? AND t.started_at<?')
        .all(thread, state.position, day.start.slice(0, 19), day.end.slice(0, 19));
      for (const id of state.pending) {
        const row = db.prepare(t3Rows + ' WHERE t.provider_turn_id=?').get(id);
        if (row) rows.push(row);
        else state.pending.delete(id);
      }
      for (const row of rows) {
        state.position = Math.max(state.position, row.position);
        const usage = parseUsageJson(row.usage);
        if (usage?.usageStatus !== 'complete') {
          state.pending.add(row.id);
          continue;
        }
        state.pending.delete(row.id);
        const counts = buckets(usage, ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cachedInputTokens']);
        if (counts) state.total = sumUsage([state.total, estimate(row.model, splitInput(counts))]);
      }
      threads.set(thread, state);
      return state.total;
    } catch {
      // Older T3 databases may lack the projections. Keep the agent visible.
    }
  };
}
