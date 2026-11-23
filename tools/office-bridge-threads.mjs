// Your T3 threads for the 3D office (docs/concepts/12-office.md "Live steps, threads and history"), read from T3's
// state database (read-only). Everything here goes to you only: Flow sends it to your own signed-in office pages.
//
//   stepOf(type, data)                 one turn item as a live step {kind, text} (or null)
//   readLive(db, threadId, runId)      what a running turn is doing: {phase, text, steps, at} (or null)
//   liveFromTranscript(lines)          the same from a transcript tail (Claude Code, Codex CLI)
//   readThreads(db, {now})             your recent top-level threads, as T3's sidebar groups them: {items, counts, can}
//   readHistory(db, threadId, before)  a page of a thread's conversation: {items, before, more}
//   threadAlive(db, threadId)          a top-level thread that is neither deleted nor archived
//   createLiveWatcher(DatabaseSync, path)   .check() -> true when T3 wrote anything since the last check
// The bridge masks every text before it leaves the machine (lib/office-mask.mjs); Flow masks it again.
import {statSync} from 'node:fs';
import {transcriptText} from '../lib/office-mask.mjs';
import {parseJson, short} from './office-bridge-t3.mjs';

const threads = 'orchestration_v2_projection_threads';
const runs = 'orchestration_v2_projection_runs';
const items = 'orchestration_v2_projection_turn_items';
const requests = 'orchestration_v2_projection_runtime_requests';
export const LIVE_STEPS = 8, THREADS_MAX = 150, HISTORY_ITEMS = 60, HISTORY_BUDGET = 56 * 1024;
const ACTIVE = ['running', 'queued', 'starting', 'preparing'];
const STEP_TYPES = ['reasoning', 'assistant_message', 'command_execution', 'file_change', 'dynamic_tool', 'file_search', 'web_search', 'subagent', 'todo_list'];
const HISTORY_TYPES = ['user_message', ...STEP_TYPES.filter(t => t !== 'todo_list')];

function optional(db, sql, ...args) {
  try { return db.prepare(sql).all(...args); }
  catch (err) {
    if (/no such (table|column)/.test(err.message)) return [];
    throw err;
  }
}
const firstLine = value => String(value ?? '').split('\n').find(line => line.trim())?.trim() ?? '';
const fileOf = value => short(String(value ?? '')).split(/[\\/]/).filter(Boolean).slice(-2).join('/');
const when = (...values) => values.find(v => typeof v === 'string' && Number.isFinite(Date.parse(v)));
// "mcp__flow__cards_list" -> "flow: cards_list"; "Read /home/x/code/app/lib/auth.mjs" -> "Read lib/auth.mjs".
function toolName(data) {
  const name = short(data.toolName, 120), title = short(data.title, 200);
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (title && /^(Read|Edit|Write|View)\s+\S/.test(title)) return title.split(' ')[0] + ' ' + fileOf(title.slice(title.indexOf(' ') + 1));
  if (title) return title;
  if (mcp) return mcp[1].replace(/[-_]+/g, ' ') + ': ' + mcp[2].replace(/_/g, ' ');
  return name || 'Used a tool';
}
// A reasoning item's summary: its title, else its first bold line or sentence.
function thought(data) {
  const title = short(data.title, 200).replace(/^\*+|\*+$/g, '');
  if (title) return title;
  const text = String(data.text ?? '').trim();
  const bold = /^\*\*(.+?)\*\*/.exec(text)?.[1];
  return short(bold || firstLine(text).replace(/\*\*/g, ''), 200);
}

export function stepOf(type, data) {
  switch (type) {
    case 'reasoning': { const t = thought(data); return t ? {kind: 'thinking', text: t} : {kind: 'thinking', text: 'Thinking'}; }
    case 'assistant_message': { const t = short(String(data.text ?? '').replace(/\[\[office\]\][^\n]*/g, ''), 200); return t ? {kind: 'writing', text: t} : null; }
    case 'command_execution': return {kind: 'tool', text: 'Run: ' + (short(firstLine(data.input), 180) || 'a command')};
    case 'file_change': return {kind: 'tool', text: 'Edit: ' + (fileOf(data.fileName) || 'a file')};
    case 'dynamic_tool': return {kind: 'tool', text: toolName(data)};
    case 'file_search': return {kind: 'tool', text: 'Search: ' + (short(data.pattern, 160) || short(data.title, 160) || 'files')};
    case 'web_search': return {kind: 'tool', text: 'Web search: ' + (short((Array.isArray(data.patterns) ? data.patterns : [])[0], 160) || 'the web')};
    case 'subagent': return {kind: 'tool', text: 'Subagent: ' + (short(data.title, 160) || 'started')};
    case 'todo_list': return {kind: 'tool', text: 'Updated the plan'};
    default: return null;
  }
}
const tail = (text, n) => { const t = String(text ?? '').trim(); return t.length <= n ? t : '…' + t.slice(-(n - 1)); };
// The live text for the newest step: the streamed reasoning or reply (its end, where it is being written), or the step.
function liveText(type, data, step) {
  if (type === 'reasoning') { const t = String(data.text ?? '').trim(); return t ? tail(t, 600) : step.text; }
  if (type === 'assistant_message') return tail(String(data.text ?? '').replace(/\[\[office\]\][^\n]*/g, ''), 600);
  return step.text;
}

function liveOf(rows) {
  const steps = [];
  let last = null;
  for (const row of rows) {
    const data = parseJson(row.payload_json), step = stepOf(row.type, data);
    if (!step) continue;
    const at = when(data.updatedAt, data.startedAt, row.updated_at);
    steps.push({kind: step.kind, text: transcriptText(step.text, 200).replace(/\s+/g, ' '), ...(at ? {at} : {})});
    last = {row, data, step, at};
  }
  if (!last) return null;
  return {phase: last.step.kind, text: transcriptText(liveText(last.row.type, last.data, last.step), 600),
    steps: steps.slice(-LIVE_STEPS).filter(s => s.text), ...(last.at ? {at: last.at} : {})};
}

export function readLive(db, threadId, runId) {
  if (!runId) return null;
  const rows = optional(db, `SELECT type, status, updated_at, payload_json FROM ${items}
    WHERE thread_id=? AND run_id=? AND type IN (${STEP_TYPES.map(() => '?').join(',')}) ORDER BY ordinal DESC LIMIT ?`, threadId, runId, ...STEP_TYPES, LIVE_STEPS + 4).reverse();
  return liveOf(rows);
}

// Claude Code and Codex CLI: the steps since its last prompt, from the transcript tail ({role, text, at}).
export function liveFromTranscript(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const start = list.findLastIndex(l => l?.role === 'user') + 1;
  const steps = list.slice(start).filter(l => l && (l.role === 'tool' || l.role === 'assistant') && typeof l.text === 'string' && l.text.trim())
    .map(l => ({kind: l.role === 'tool' ? 'tool' : 'writing', text: transcriptText(short(l.text, 200), 200), ...(l.at ? {at: l.at} : {})})).filter(s => s.text);
  if (!steps.length) return null;
  const last = list.slice(start).filter(l => l && (l.role === 'tool' || l.role === 'assistant')).at(-1);
  return {phase: steps.at(-1).kind, text: transcriptText(last.role === 'assistant' ? tail(last.text, 600) : last.text, 600),
    steps: steps.slice(-LIVE_STEPS), ...(last.at ? {at: last.at} : {})};
}

// ---------- the thread index ----------
const time = v => { const t = Date.parse(v ?? ''); return Number.isFinite(t) ? t : NaN; };
// T3's own sidebar rules: snoozed until a time still ahead; settled; then what the thread is doing: waiting on you
// (an open approval or question), working (a turn running), woke (back from a snooze you have not looked at since),
// else done, unread when its last turn finished after you last opened it.
export function threadState({payload, run, pending, now}) {
  const snoozedUntil = time(payload.snoozedUntil);
  const active = run && ACTIVE.includes(run.status) && !(run.status === 'queued' && parseJson(run.payload_json).queueHeld);
  if (pending) return {state: 'waiting'};
  if (active) return {state: 'working'};
  if (snoozedUntil > now) return {state: 'snoozed'};
  if (payload.settledOverride === 'settled') return {state: 'settled'};
  const visited = time(payload.lastVisitedAt), finished = time(run?.completed_at);
  const wokeAt = time(payload.lastSnoozeWakeAt ?? (snoozedUntil <= now ? payload.snoozedUntil : null));
  if (Number.isFinite(wokeAt) && [visited, finished].filter(Number.isFinite).every(t => t < wokeAt)) return {state: 'woke'};
  return {state: 'done', unread: Number.isFinite(finished) && Number.isFinite(visited) && finished > visited};
}

export function readThreads(db, {now = Date.now(), max = THREADS_MAX} = {}) {
  const projects = new Map(optional(db, 'SELECT project_id, title FROM projection_projects').map(r => [r.project_id, r.title]));
  const latest = new Map(optional(db, `SELECT r.* FROM ${runs} r JOIN (SELECT thread_id, MAX(ordinal) AS o FROM ${runs} GROUP BY thread_id) m
    ON m.thread_id = r.thread_id AND m.o = r.ordinal`).map(r => [r.thread_id, r]));
  // A newer run that is still queued behind a held one does not hide the running one.
  for (const r of optional(db, `SELECT * FROM ${runs} WHERE status IN ('running','starting','preparing')`)) latest.set(r.thread_id, r);
  const waiting = new Set(optional(db, `SELECT thread_id FROM ${requests} WHERE resolved_at IS NULL AND status NOT IN ('resolved','cancelled','expired')
    AND kind IN ('command','file_change','approval','tool_approval','user_input')`).map(r => r.thread_id));
  const all = [];
  for (const row of optional(db, `SELECT thread_id, project_id, title, updated_at, payload_json FROM ${threads} WHERE deleted_at IS NULL AND archived_at IS NULL`)) {
    const payload = parseJson(row.payload_json);
    if (payload.lineage?.parentThreadId) continue;  // delegated threads and subagents roll up into their parent
    const run = latest.get(row.thread_id);
    const {state, unread} = threadState({payload, run, pending: waiting.has(row.thread_id), now});
    const updated = Math.max(...[row.updated_at, run?.requested_at, run?.completed_at, payload.unsettledAt].map(time).filter(Number.isFinite), 0);
    all.push({id: row.thread_id, title: short(row.title, 160) || 'Untitled thread', project: short(projects.get(row.project_id), 80) || undefined, state,
      updatedAt: updated ? new Date(updated).toISOString() : undefined, branch: short(payload.branch, 120) || undefined, ...(unread ? {unread: true} : {}), _t: updated});
  }
  all.sort((a, b) => b._t - a._t || a.id.localeCompare(b.id));
  const counts = {snoozed: all.filter(t => t.state === 'snoozed').length, settled: all.filter(t => t.state === 'settled').length};
  // Everything that is not snoozed or settled first, then the newest snoozed and settled ones, up to max.
  const open = all.filter(t => t.state !== 'snoozed' && t.state !== 'settled');
  const rest = all.filter(t => t.state === 'snoozed' || t.state === 'settled');
  const picked = [...open.slice(0, max), ...rest.slice(0, Math.max(0, max - open.length))].sort((a, b) => b._t - a._t || a.id.localeCompare(b.id));
  return {items: picked.map(({_t, ...t}) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined))), counts, can: ['message', 'history']};
}

export function threadAlive(db, threadId) {
  const row = optional(db, `SELECT payload_json, archived_at FROM ${threads} WHERE thread_id=? AND deleted_at IS NULL`, threadId)[0];
  return !!row && !row.archived_at && !parseJson(row.payload_json).lineage?.parentThreadId;
}

// ---------- history ----------
const resultText = v => typeof v === 'string' ? v : v && typeof v === 'object' ? JSON.stringify(v) : '';
function historyItem(row) {
  const data = parseJson(row.payload_json), at = when(data.startedAt, data.updatedAt, row.updated_at);
  const base = {...(at ? {at} : {}), ...(row.run_id ? {turn: String(row.run_id).slice(0, 80)} : {})};
  switch (row.type) {
    case 'user_message': { const text = String(data.text ?? '').trim(); return text ? {role: 'user', text: transcriptText(text, 4000), ...base} : null; }
    case 'assistant_message': { const text = String(data.text ?? '').trim(); return text ? {role: 'assistant', text: transcriptText(text, 4000), ...base} : null; }
    case 'reasoning': return {role: 'reasoning', title: transcriptText(thought(data), 200), text: transcriptText(String(data.text ?? ''), 2000), ...base};
    default: {
      const step = stepOf(row.type, data);
      if (!step) return null;
      const out = row.type === 'command_execution' ? tail(resultText(data.output), 400)
        : row.type === 'dynamic_tool' ? short(resultText(data.output), 300) : row.type === 'subagent' ? short(resultText(data.result), 300) : '';
      return {role: 'tool', title: transcriptText(step.text, 200), ...(out ? {detail: transcriptText(out, 400)} : {}),
        ...(row.status ? {status: String(row.status).slice(0, 20)} : {}), ...base};
    }
  }
}
// The newest HISTORY_ITEMS items before the cursor ("o:<ordinal>", from the last page), oldest first, within
// HISTORY_BUDGET bytes. before: the cursor for the page before this one.
export function readHistory(db, threadId, before) {
  const cursor = /^o:(-?\d{1,15})$/.exec(String(before ?? ''))?.[1];
  const rows = optional(db, `SELECT ordinal, type, status, run_id, updated_at, payload_json FROM ${items}
    WHERE thread_id=? AND type IN (${HISTORY_TYPES.map(() => '?').join(',')}) ${cursor !== undefined ? 'AND ordinal < ?' : ''}
    ORDER BY ordinal DESC LIMIT ?`, threadId, ...HISTORY_TYPES, ...(cursor !== undefined ? [Number(cursor)] : []), HISTORY_ITEMS + 1);
  const page = [];
  let bytes = 0, oldest = null;
  for (const row of rows.slice(0, HISTORY_ITEMS)) {
    const item = historyItem(row);
    oldest = row.ordinal;
    if (!item) continue;
    const size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > HISTORY_BUDGET) { oldest = row.ordinal + 1; break; }
    bytes += size;
    page.unshift(item);
  }
  const more = rows.length > HISTORY_ITEMS || (oldest !== null && rows.some(r => r.ordinal < oldest));
  return {items: page, before: more && oldest !== null ? 'o:' + oldest : null, more};
}

// ---------- watching T3 ----------
// Any write to T3's database (a streamed reasoning delta, a new tool call, a finished turn) bumps data_version.
export function createLiveWatcher(DatabaseSync, path) {
  let db, identity, version;
  function close() { db?.close(); db = undefined; version = undefined; }
  return {
    check() {
      try {
        const stat = statSync(path), key = stat.dev + ':' + stat.ino;
        if (!db || key !== identity) {
          close();
          db = new DatabaseSync(path, {readOnly: true});
          db.exec('PRAGMA busy_timeout=50');
          identity = key;
        }
        const next = db.prepare('PRAGMA data_version').get().data_version;
        const changed = version !== undefined && next !== version;
        version = next;
        return changed;
      } catch { close(); return false; }
    },
    close,
  };
}

// Every running top-level turn's live field, cheaply (for the watcher between reports): Map(threadId -> live). The
// same runs readT3 reports (running, queued unless held, starting); delegated threads are children there, so not here.
export function readRunningLive(db) {
  const out = new Map();
  for (const run of optional(db, `SELECT r.thread_id, r.run_id, r.status, r.payload_json, t.payload_json AS thread FROM ${runs} r
    JOIN ${threads} t ON t.thread_id = r.thread_id AND t.deleted_at IS NULL
    WHERE r.status IN ('running','queued','starting') ORDER BY r.ordinal`)) {
    if (run.status === 'queued' && parseJson(run.payload_json).queueHeld) continue;
    if (parseJson(run.thread).lineage?.parentThreadId) continue;
    out.set(run.thread_id, readLive(db, run.thread_id, run.run_id));
  }
  return out;
}
