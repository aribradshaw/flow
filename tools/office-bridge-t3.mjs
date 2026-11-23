import {execFile, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {basename, delimiter, dirname, join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const terminal = new Set(['resolved', 'cancelled', 'expired']);
const approvals = new Set(['command', 'file_change', 'approval', 'tool_approval']);
const threads = 'orchestration_v2_projection_threads';
const runs = 'orchestration_v2_projection_runs';
const items = 'orchestration_v2_projection_turn_items';
const requests = 'orchestration_v2_projection_runtime_requests';

export function defaultT3Db() {
  const home = process.platform === 'win32' ? process.env.USERPROFILE || homedir() : homedir();
  return join(process.env.T3CODE_HOME || join(home, '.t3'), 'userdata', 'statev2.sqlite');
}

export async function loadSqlite() {
  try {
    return (await import('node:sqlite')).DatabaseSync;
  } catch (err) {
    if (err.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw err;
    throw new Error('The office bridge needs node:sqlite. Use Node.js 24+ (or a Node.js 22 build with SQLite enabled).');
  }
}

export function parseJson(value) {
  try { return JSON.parse(value) ?? {}; }
  catch { return {}; }
}

export function short(value, limit = 200) {
  if (typeof value !== 'string') return '';
  const line = value.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  return line.length <= limit ? line : line.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

function optional(db, sql, ...args) {
  try { return db.prepare(sql).all(...args); }
  catch (err) {
    if (/no such (table|column)/.test(err.message)) return [];
    throw err;
  }
}

function open(DatabaseSync, path) {
  const db = new DatabaseSync(path, {readOnly: true});
  db.exec('PRAGMA busy_timeout=500');
  return db;
}

function activity(item) {
  const data = parseJson(item?.payload_json);
  switch (item?.type) {
    case 'command_execution': return short(data.input) || 'Running a command';
    case 'file_change': return 'Editing ' + (short(data.fileName).split(/[\\/]/).at(-1) || 'a file');
    case 'dynamic_tool': return short(data.title) || short(data.toolName) || 'Using a tool';
    case 'assistant_message': return short(data.text) || 'Responding';
    case 'reasoning': return 'Thinking';
    case 'subagent': return short(data.title) || 'Working with a subagent';
    case 'user_input_request': return 'Asked a question';
    case 'approval_request': return 'Requested approval';
    default: return short(item?.type).replaceAll('_', ' ') || 'Starting up';
  }
}

// The transcript tail (docs/concepts/12-office.md): what was said and what the tools did, newest last.
// The bridge masks and cuts each text before sending (lib/office-mask.mjs); Flow shows it to the owner only.
export const TRANSCRIPT_ITEMS = ['user_message', 'assistant_message', 'command_execution', 'file_change', 'dynamic_tool', 'subagent'];
const firstLine = value => String(value ?? '').split('\n').find(line => line.trim())?.trim() ?? '';
export function transcriptEntry(type, data, at) {
  const entry = (role, text) => text ? {role, text, ...(at ? {at} : {})} : null;
  switch (type) {
    case 'user_message': return entry('user', typeof data.text === 'string' ? data.text.trim() : '');
    case 'assistant_message': return entry('assistant', typeof data.text === 'string' ? data.text.trim() : '');
    case 'command_execution': return entry('tool', 'Run: ' + (firstLine(data.input) || 'a command'));
    case 'file_change': return entry('tool', 'Edit: ' + (short(data.fileName).split(/[\\/]/).at(-1) || 'a file'));
    case 'dynamic_tool': return entry('tool', short(data.title) || short(data.toolName) || 'Used a tool');
    case 'subagent': return entry('tool', 'Subagent: ' + (short(data.title) || 'started'));
    default: return null;
  }
}
function transcriptOf(db, threadId, limit = 12) {
  return optional(db, `SELECT * FROM ${items}
    WHERE thread_id=? AND type IN (${TRANSCRIPT_ITEMS.map(() => '?').join(',')}) ORDER BY ordinal DESC LIMIT ?`, threadId, ...TRANSCRIPT_ITEMS, limit)
    .reverse().map(row => {
      const data = parseJson(row.payload_json);
      const at = [data.startedAt, data.updatedAt, row.updated_at].find(value => typeof value === 'string' && Number.isFinite(Date.parse(value)));
      return transcriptEntry(row.type, data, at);
    }).filter(Boolean);
}

function pendingFor(row, item) {
  const question = row.kind === 'user_input';
  const detail = short(item?.prompt) || (Array.isArray(item?.questions)
    ? short(item.questions.map(q => short(q?.question)).join(' ')) : '');
  return {
    requestId: row.runtime_request_id,
    kind: question ? 'question' : 'approval',
    summary: detail || (question ? 'Answer a question in T3 Code' : 'Review the request in T3 Code'),
    // Keep requests without a reviewable summary local.
    can: approvals.has(row.kind) && detail ? ['allow', 'deny'] : [],
  };
}

export function readT3(DatabaseSync, path) {
  const agents = new Map();
  const nativeIds = new Set();
  if (!existsSync(path)) return {agents, nativeIds};

  const db = open(DatabaseSync, path);
  try {
    db.exec('BEGIN');
    const projects = new Map(optional(db, 'SELECT * FROM projection_projects')
      .map(row => [row.project_id, row.workspace_root]));
    const live = new Map();
    for (const row of db.prepare(`SELECT * FROM ${runs} WHERE status IN ('running','queued','starting') ORDER BY ordinal`).all()) {
      if (row.status !== 'queued' || !parseJson(row.payload_json).queueHeld) live.set(row.thread_id, row);
    }
    const waiting = new Map();
    for (const row of optional(db, `SELECT * FROM ${requests} WHERE resolved_at IS NULL
      AND status NOT IN ('resolved','cancelled','expired') ORDER BY created_at, runtime_request_id`)) {
      if (typeof row.runtime_request_id === 'string' && row.runtime_request_id && !waiting.has(row.thread_id)) {
        waiting.set(row.thread_id, row);
      }
    }

    for (const thread of db.prepare(`SELECT * FROM ${threads} WHERE deleted_at IS NULL`).all()) {
      const id = thread.thread_id;
      if (typeof id !== 'string' || !id) continue;
      const run = live.get(id);
      const request = waiting.get(id);
      if (!run && !request) continue;
      const state = parseJson(thread.payload_json);
      const selection = parseJson(run?.payload_json).modelSelection ?? state.modelSelection;
      const provider = run?.provider || state.providerInstanceId;
      let pending = null;
      if (request) {
        // Match the exact request rather than inferring it from the last turn item.
        const prompts = optional(db, `SELECT payload_json FROM ${items}
          WHERE thread_id=? AND type IN ('approval_request','user_input_request') ORDER BY ordinal DESC`, id);
        const prompt = prompts.map(row => parseJson(row.payload_json)).find(p => p.requestId === request.runtime_request_id);
        pending = pendingFor(request, prompt);
      }
      const latest = run && optional(db, `SELECT type, payload_json FROM ${items}
        WHERE thread_id=? AND run_id=? AND type NOT IN ('checkpoint','user_message')
        ORDER BY ordinal DESC LIMIT 1`, id, run.run_id)[0];
      const children = run ? optional(db, `SELECT payload_json FROM ${items}
        WHERE thread_id=? AND run_id=? AND type='subagent' AND status='running' ORDER BY ordinal`, id, run.run_id)
        .map(row => parseJson(row.payload_json)) : [];
      const delegated = typeof state.lineage?.parentThreadId === 'string' && state.lineage.parentThreadId !== '';
      agents.set(id, {
        id, title: thread.title, provider, model: selection?.model, pending, runId: run?.run_id,
        // Top-level threads take a message (a new user turn) and a stop from the office; delegated ones are
        // steered by the thread that delegated them.
        can: delegated ? [] : ['message', 'stop'],
        cwd: typeof state.worktreePath === 'string' && state.worktreePath.trim()
          ? state.worktreePath : projects.get(thread.project_id),
        parent: state.lineage?.parentThreadId, children,
        status: pending ? 'waiting' : 'running',
        activity: pending ? (pending.kind === 'question' ? 'Asked a question' : 'Waiting for approval') : activity(latest),
        transcript: transcriptOf(db, id),
      });
    }

    // Older builds stored the provider's native session ID only in a resume cursor.
    for (const [table, column] of [
      ['orchestration_v2_projection_provider_threads', 'payload_json'],
      ['orchestration_v2_projection_run_attempts', 'payload_json'],
      ['provider_session_runtime', 'resume_cursor_json'],
    ]) {
      const rows = optional(db, `SELECT thread_id, ${column} AS data FROM ${table} WHERE thread_id IN (
        SELECT thread_id FROM ${runs} WHERE status IN ('running','queued','starting')
        UNION SELECT thread_id FROM ${requests} WHERE resolved_at IS NULL AND status NOT IN ('resolved','cancelled','expired')
      )`);
      // Missing request projections occur on older builds.
      const candidates = rows.length ? rows : optional(db, `SELECT thread_id, ${column} AS data FROM ${table}
        WHERE thread_id IN (SELECT thread_id FROM ${runs} WHERE status IN ('running','queued','starting'))`);
      for (const row of candidates) {
        if (!agents.has(row.thread_id)) continue;
        const ref = parseJson(row.data);
        const id = ref.nativeThreadRef?.nativeId || ref.nativeThreadId;
        if (typeof id === 'string') nativeIds.add(id);
        if (column === 'resume_cursor_json' && typeof row.data === 'string') {
          for (const match of row.data.matchAll(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi)) nativeIds.add(match[0]);
        }
      }
    }
    return {agents, nativeIds};
  } finally {
    db.close();
  }
}

function readRequest(DatabaseSync, path, id) {
  const db = open(DatabaseSync, path);
  try {
    return db.prepare(`SELECT * FROM ${requests} WHERE runtime_request_id=?`).get(id);
  } finally {
    db.close();
  }
}

function dispatch(url, command, stillPending, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const ws = new WebSocket(url, {headers: {origin: 'http://' + url.host}});
    let opened = false;
    let settled = false;
    const onAbort = () => finish(false, signal.reason);
    const timer = setTimeout(() => finish(false, new Error('T3 did not answer in time.')), 20000);
    function finish(result, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      ws.close();
      if (error) reject(error);
      else resolve(result);
    }
    signal.addEventListener('abort', onAbort, {once: true});
    ws.addEventListener('open', () => {
      opened = true;
      try {
        if (!stillPending()) throw new Error('This request is no longer current in T3.');
        ws.send(JSON.stringify({_tag: 'Request', id: '1', tag: 'orchestration.dispatchCommand', payload: command, headers: []}));
      } catch (err) {
        finish(false, err);
      }
    }, {once: true});
    ws.addEventListener('close', () => {
      // Retry the handshake only if the socket never opened, so a command is dispatched at most once.
      finish(false, opened ? new Error('T3 closed the connection before confirming the response.') : null);
    }, {once: true});
    ws.addEventListener('message', event => {
      const data = parseJson(event.data);
      const messages = Array.isArray(data) ? data : [data];
      const reply = messages.find(message => message?._tag === 'Exit' && message.requestId === '1');
      if (!reply) return;
      finish(true, reply.exit?._tag === 'Success' ? null : new Error('T3 rejected the command.'));
    });
  });
}

// The environment for the t3 CLI: this database's T3 home, ~/.local/bin on PATH, and no Flow key.
function t3Env(path) {
  const userdata = dirname(path);
  const env = {...process.env};
  delete env.FLOW_API_KEY;
  if (basename(userdata) === 'userdata') env.T3CODE_HOME = dirname(userdata);
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = [join(homedir(), '.local', 'bin'), env[pathKey]].filter(Boolean).join(delimiter);
  return env;
}

// One orchestration command on the local T3 server, the way the T3 app sends it: a short-lived token from
// `t3 auth session issue`, a WebSocket ticket, then orchestration.dispatchCommand. stillValid() is checked
// right before it is sent.
export async function dispatchT3(path, command, stillValid, signal) {
  const userdata = dirname(path);
  const runtime = parseJson(readFileSync(join(userdata, 'server-runtime.json'), 'utf8'));
  if (!Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535) {
    throw new Error('T3 runtime port is unavailable.');
  }
  const args = ['auth', 'session', 'issue', '--scope', 'orchestration:read',
    '--scope', 'orchestration:operate', '--ttl', '2m', '--label', 'flow-office-bridge', '--token-only'];
  const options = {timeout: 15000, maxBuffer: 32768, windowsHide: true, signal, env: t3Env(path)};
  // Windows installations can expose T3 as a .cmd launcher. All shell arguments here are fixed.
  const {stdout} = await (process.platform === 'win32'
    ? exec(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 't3', ...args], options)
    : exec('t3', args, options));
  const token = stdout.trim().split(/\r?\n/).at(-1);
  if (!token) throw new Error('T3 did not issue a bearer token.');
  const host = '127.0.0.1:' + runtime.port;

  for (const protocol of ['2', '']) {
    const response = await fetch('http://' + host + '/api/auth/websocket-ticket/rpc', {
      method: 'POST', headers: {authorization: 'Bearer ' + token}, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    if (!response.ok) throw new Error('T3 refused to issue a WebSocket ticket.');
    const {ticket} = await response.json();
    if (typeof ticket !== 'string' || !ticket) throw new Error('T3 returned an invalid WebSocket ticket.');
    const url = new URL('ws://' + host + '/ws');
    url.searchParams.set('wsTicket', ticket);
    if (protocol) url.searchParams.set('orchestrationProtocol', protocol);
    if (await dispatch(url, command, stillValid, signal)) return;
  }
  throw new Error('T3 refused the WebSocket connection.');
}

export function respondT3(path, {agentId, requestId, decision}, stillPending, signal) {
  return dispatchT3(path, {
    type: 'runtime-request.respond', commandId: randomUUID(), threadId: agentId, requestId,
    decision: decision === 'allow' ? 'accept' : 'decline',
  }, stillPending, signal);
}

// Stop: interrupt the thread's running turn (run.interrupt, as T3's own stop button and t3_thread_interrupt do).
export function stopT3(path, {agentId, runId}, stillRunning, signal) {
  return dispatchT3(path, {type: 'run.interrupt', commandId: randomUUID(), threadId: agentId, runId,
    reason: 'Stopped from the Flow office'}, stillRunning, signal);
}

// A message: `t3 thread send <thread> -` with the text on stdin (never in the arguments). A busy thread gets it
// as its next turn; an idle one starts a turn. -> T3's JSON answer ({delivery: "queued" | …}).
export function sendT3(path, {agentId, text}, signal) {
  return new Promise((resolve, reject) => {
    const args = ['thread', 'send', '--json', agentId, '-'];
    const child = process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 't3', ...args], {env: t3Env(path), windowsHide: true, signal})
      : spawn('t3', args, {env: t3Env(path), windowsHide: true, signal});
    let out = '';
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.setEncoding('utf8').on('data', chunk => { if (out.length < 65536) out += chunk; });
    child.stderr.resume();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('t3 thread send failed.'));
      resolve(parseJson(out.trim().split(/\r?\n/).at(-1)));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}

function readRun(DatabaseSync, path, runId) {
  const db = open(DatabaseSync, path);
  try {
    return db.prepare(`SELECT * FROM ${runs} WHERE run_id=?`).get(runId);
  } finally {
    db.close();
  }
}

// Messages and stops for a T3 thread, after checking it is still a top-level thread of this T3 server that
// the bridge offers them for (can), and, for a stop, that the same turn is still running.
async function steerT3(DatabaseSync, path, action, signal, {message, stop}) {
  const failure = text => ({ok: false, message: text});
  const kind = action.kind;
  const current = () => readT3(DatabaseSync, path).agents.get(action.agentId);
  try {
    const agent = current();
    if (!agent) return failure('This T3 thread is not running here any more.');
    if (!agent.can?.includes(kind)) return failure(kind === 'stop' ? 'Stop it in T3 Code.' : 'Send it messages in T3 Code.');
    if (kind === 'message') {
      if (typeof action.text !== 'string' || !action.text.trim() || action.text.length > 2000) return failure('That message is empty or too long.');
      const sent = await message(path, {agentId: action.agentId, text: action.text}, signal);
      return {ok: true, message: sent?.delivery === 'queued' ? 'Queued in T3 Code: it is the next turn.' : 'Sent to T3 Code.'};
    }
    const runId = agent.runId;
    if (!runId) return failure('It has no running turn to stop.');
    await stop(path, {agentId: action.agentId, runId}, () => current()?.runId === runId, signal);
    for (let i = 0; i < 20; i++) {
      const run = readRun(DatabaseSync, path, runId);
      if (!run || !['running', 'starting', 'queued'].includes(run.status)) return {ok: true, message: 'Stopped in T3 Code.'};
      await delay(250, undefined, {signal});
    }
    return {ok: true, message: 'Asked T3 Code to stop; the turn is still finishing.'};
  } catch {
    // CLI errors can include local paths or authentication output.
    return failure(kind === 'stop' ? 'Could not stop it. Check T3 Code and the local bridge setup.' : 'Could not send the message. Check T3 Code and the local bridge setup.');
  }
}

export function createT3Responder(DatabaseSync, path, send = respondT3, {message = sendT3, stop = stopT3} = {}) {
  return async (action, signal) => {
    const failure = message => ({ok: false, message});
    if (action.kind === 'message' || action.kind === 'stop') return steerT3(DatabaseSync, path, action, signal, {message, stop});
    if (action.kind !== undefined && action.kind !== 'answer') return failure('Unknown action.');
    if (action.decision !== 'allow' && action.decision !== 'deny') return failure('Unknown decision.');
    const stillPending = () => {
      const agent = readT3(DatabaseSync, path).agents.get(action.agentId);
      return agent?.status === 'waiting' && agent.pending?.requestId === action.requestId
        && agent.pending.can.includes(action.decision);
    };

    try {
      if (!stillPending()) return failure('This approval is no longer pending or must be answered locally.');
      await send(path, action, stillPending, signal);
      for (let i = 0; i < 20; i++) {
        const row = readRequest(DatabaseSync, path, action.requestId);
        if (!row || row.thread_id !== action.agentId) return failure('T3 no longer has this request.');
        if (row.status === 'resolved') {
          const expected = action.decision === 'allow' ? 'accept' : 'decline';
          if (parseJson(row.payload_json).decision !== expected) return failure('T3 recorded a different decision.');
          return {ok: true, message: action.decision === 'allow' ? 'Approved in T3 Code.' : 'Denied in T3 Code.'};
        }
        if (terminal.has(row.status)) return failure('T3 closed this request before confirming the decision.');
        await delay(250, undefined, {signal});
      }
      return failure('T3 did not confirm the decision. Check the request in T3 Code.');
    } catch {
      // CLI errors can include local paths or authentication output.
      return failure('Could not confirm the approval response. Check T3 Code and the local bridge setup.');
    }
  };
}
