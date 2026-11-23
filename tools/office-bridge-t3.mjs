import {execFile} from 'node:child_process';
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
      agents.set(id, {
        id, title: thread.title, provider, model: selection?.model, pending,
        cwd: typeof state.worktreePath === 'string' && state.worktreePath.trim()
          ? state.worktreePath : projects.get(thread.project_id),
        parent: state.lineage?.parentThreadId, children,
        status: pending ? 'waiting' : 'running',
        activity: pending ? (pending.kind === 'question' ? 'Asked a question' : 'Waiting for approval') : activity(latest),
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
        if (!stillPending()) throw new Error('This approval is no longer pending in T3.');
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
      finish(true, reply.exit?._tag === 'Success' ? null : new Error('T3 rejected the approval response.'));
    });
  });
}

export async function respondT3(path, {agentId, requestId, decision}, stillPending, signal) {
  const userdata = dirname(path);
  const runtime = parseJson(readFileSync(join(userdata, 'server-runtime.json'), 'utf8'));
  if (!Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535) {
    throw new Error('T3 runtime port is unavailable.');
  }
  const args = ['auth', 'session', 'issue', '--scope', 'orchestration:read',
    '--scope', 'orchestration:operate', '--ttl', '2m', '--label', 'flow-office-bridge', '--token-only'];
  const env = {...process.env};
  delete env.FLOW_API_KEY;
  if (basename(userdata) === 'userdata') env.T3CODE_HOME = dirname(userdata);
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = [join(homedir(), '.local', 'bin'), env[pathKey]].filter(Boolean).join(delimiter);
  const options = {timeout: 15000, maxBuffer: 32768, windowsHide: true, signal, env};
  // Windows installations can expose T3 as a .cmd launcher. All shell arguments here are fixed.
  const {stdout} = await (process.platform === 'win32'
    ? exec(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 't3', ...args], options)
    : exec('t3', args, options));
  const token = stdout.trim().split(/\r?\n/).at(-1);
  if (!token) throw new Error('T3 did not issue a bearer token.');
  const host = '127.0.0.1:' + runtime.port;
  const command = {
    type: 'runtime-request.respond', commandId: randomUUID(), threadId: agentId, requestId,
    decision: decision === 'allow' ? 'accept' : 'decline',
  };

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
    if (await dispatch(url, command, stillPending, signal)) return;
  }
  throw new Error('T3 refused the WebSocket connection.');
}

export function createT3Responder(DatabaseSync, path, send = respondT3) {
  return async (action, signal) => {
    const failure = message => ({ok: false, message});
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
