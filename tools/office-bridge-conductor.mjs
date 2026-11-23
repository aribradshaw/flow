// The Chief of Staff conductor for flow office bridge (docs/office-bridge.md, docs/concepts/12-office.md):
// one long-lived T3 thread on this computer that takes your messages from the 3D office, turns work into cards,
// delegates it to AgentFlow agents and answers questions. The bridge makes sure the thread exists, reports it as
// your conductor (role: "conductor", always steerable) with its latest reply, and sends your office messages to it
// over the bridge's warm T3 session.
//
//   createConductor({DatabaseSync, path, stateFile, project, fetchBrief, runT3, dispatch, now, log})
//     .ensure(signal)        the thread id: the remembered one, else one with the conductor's title in the
//                            project, else a new thread whose first message is the brief (created at most once a minute)
//     .entry(host)           the office agent for the report, or null while there is no thread
//     .owns(agentId)         true for the conductor's thread
//     .send(text, signal)    a message as its next turn -> {ok, message}
//   parseReply(text)         -> {say, cards, tagged} from the "[[office]] {...}" line, or the start of plain prose
//   conductorBrief({...})    the thread's first message
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

import {transcriptText} from '../lib/office-mask.mjs';
import {parseModel} from '../lib/office.mjs';
import {parseJson, short, t3Env, transcriptEntry} from './office-bridge-t3.mjs';
import {readLive} from './office-bridge-threads.mjs';

export const CONDUCTOR_TITLE = '[Flow] Chief of Staff · conductor';
export const CONDUCTOR_AGENT = 'Chief of Staff';
const PLAIN_MAX = 200, SAY_MAX = 600, CREATE_EVERY = 60_000;
const threads = 'orchestration_v2_projection_threads';
const runs = 'orchestration_v2_projection_runs';
const items = 'orchestration_v2_projection_turn_items';
const requests = 'orchestration_v2_projection_runtime_requests';

// The rules a conductor follows when the environment has no Chief of Staff agent of its own.
export const DEFAULT_RULES = `- You may on your own: create cards, delegate them, and start small, reversible work: research, drafts, notes, internal docs, code on a branch, pull requests.
- Wait for the person (put the card in UAT with "Needs <name>: …" at the top of its description) for: anything public or customer-facing, anything legal or financial, production credentials or production data, and deleting anything.
- Never put secrets in cards, commits or logs.`;

// "[[office]] {"say": "...", "cards": [461]}" on the last line that has it. Without the tag, the start of the prose.
export function parseReply(text) {
  const raw = String(text ?? '');
  const at = raw.lastIndexOf('[[office]]');
  if (at >= 0) {
    const line = raw.slice(at + 10).split('\n')[0].trim();
    const data = parseJson(line);
    const say = typeof data.say === 'string' ? data.say.trim() : '';
    const cards = (Array.isArray(data.cards) ? data.cards : [])
      .map(n => typeof n === 'string' ? Number(n.replace(/^#/, '')) : n).filter(n => Number.isInteger(n) && n > 0).slice(0, 12);
    const prose = (raw.slice(0, at) + raw.slice(at + 10 + raw.slice(at + 10).split('\n')[0].length)).trim();
    if (say) return {say: say.slice(0, SAY_MAX), cards, tagged: true, prose};
    return {say: short(prose, PLAIN_MAX), cards, tagged: true, prose};
  }
  const prose = raw.trim();
  return {say: short(prose, PLAIN_MAX), cards: [], tagged: false, prose};
}

export function conductorBrief({name = 'you', env = '', agent = null, rules = '', gbrain = false} = {}) {
  const who = name && name !== 'you' ? name : 'the person';
  const instructions = (rules || '').trim() || DEFAULT_RULES.replaceAll('<name>', name && name !== 'you' ? name : 'you');
  return `You are ${name === 'you' ? 'my' : name + "'s"} Chief of Staff: the conductor in Flow's 3D office. This T3 thread is long-lived. Every later message in it comes from ${who} through the office (a chat line typed there, or a question). Keep each answer short: it shows as a speech bubble.

## What you do
- Questions ("what's blocked on the launch?", "what's in UAT?"): answer directly from Flow${env ? ` (environment \`${env}\`)` : ''}: cards_list and search for cards (columns requests, doing, blocked, uat, done), cards_get for one, agents_list and agents_work for who does what, items_list for the timeline.${gbrain ? ' Search GBrain (search or query) for background on people, companies and projects.' : ' If a GBrain MCP server is configured here, search it for background.'}
- Work: turn it into a card with cards_create (a clear title, a description with the ask and what done looks like, a project, column requests) and delegate it in the same call with \`agents: ["<agent id or name>"]\`. Pick the agent by purpose: agents_list, then agents_get for its brief. Several steps: one card each, or a checklist.
- Do not do long work in this thread: delegate it, so you stay free to answer. Quick lookups only.
- Report what you routed: the card number and the agent.
- cards_update with description replaces the whole description. Always cards_get first, prepend your note to what is there, and pass ifUpdated (a 409 means it changed: read it again).
- If the Flow MCP tools are not available here, use the flow CLI (flow cards list, flow cards create …), which is signed in on this computer.

## ${agent ? `Your brief and autonomy rules (the ${agent} agent's instructions in Flow)` : 'Autonomy'}
${instructions}
Anything that must wait: finish the card in UAT with "Needs ${name === 'you' ? 'you' : name}: …" at the top of the description, and say so.

## Reply contract
End every reply with exactly one line like this, the last line of the message:
[[office]] {"say":"Routed to Web Builder as #461 · starting now","cards":[461]}
- say: one sentence for the office bubble, under 140 characters, plain text.
- cards: the card numbers you created, changed or are talking about ([] for none).

Reply to this first message with a one-line hello and the [[office]] line.`;
}

function open(DatabaseSync, path) {
  const db = new DatabaseSync(path, {readOnly: true});
  db.exec('PRAGMA busy_timeout=500');
  return db;
}
function optional(db, sql, ...args) {
  try { return db.prepare(sql).all(...args); }
  catch (error) { if (/no such (table|column)/.test(error.message)) return []; throw error; }
}

function readState(file) {
  try { return parseJson(readFileSync(file, 'utf8')); }
  catch { return {}; }
}
function writeState(file, data) {
  mkdirSync(dirname(file), {recursive: true});
  const tmp = file + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', {mode: 0o600});
  renameSync(tmp, file);
}

// `t3 thread start --json --title <title> [--provider <id> --model <slug>] <project> -`, the brief on stdin.
// provider and model are the office's choice (parseModel); without them T3 uses the project's default model.
export function startThread({bin = 't3', path, project, title, message, signal, provider, model}) {
  return new Promise((resolve, reject) => {
    const args = ['thread', 'start', '--json', '--title', title];
    if (provider && model) args.push('--provider', provider, '--model', model);
    args.push(project, '-');
    const child = process.platform === 'win32' && bin === 't3'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 't3', ...args], {env: t3Env(path), windowsHide: true, signal})
      : spawn(bin, args, {env: t3Env(path), windowsHide: true, signal});
    let out = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.setEncoding('utf8').on('data', chunk => { if (out.length < 65536) out += chunk; });
    child.stderr.resume();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('t3 thread start failed.'));
      const data = parseJson(out.trim().split(/\r?\n/).at(-1));
      if (typeof data.threadId !== 'string' || !data.threadId) return reject(new Error('t3 thread start gave no thread id.'));
      resolve(data);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(message);
  });
}

export function createConductor({DatabaseSync, path, stateFile, project, fetchBrief = async () => ({}), runT3 = startThread,
  dispatch, now = () => Date.now(), log = () => {}, bin = 't3'}) {
  let state = readState(stateFile), creating = null, triedAt = 0;
  const threadRow = (db, id) => optional(db, `SELECT * FROM ${threads} WHERE thread_id=?`, id)[0];
  const alive = row => row && !row.deleted_at && !row.archived_at;
  // A thread with the conductor's title in this project (the state file was lost): the newest live one.
  function findByTitle(db) {
    const projectIds = optional(db, 'SELECT * FROM projection_projects').filter(p => p.workspace_root === project).map(p => p.project_id);
    return optional(db, `SELECT * FROM ${threads} WHERE title=?`, CONDUCTOR_TITLE)
      .filter(row => alive(row) && (!projectIds.length || projectIds.includes(row.project_id)))
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))[0];
  }
  function current() {
    if (!existsSync(path)) return null;
    const db = open(DatabaseSync, path);
    try {
      if (state.threadId && alive(threadRow(db, state.threadId))) return state.threadId;
      const found = findByTitle(db);
      if (found) {
        state = {...state, threadId: found.thread_id, project};
        writeState(stateFile, state);
        return found.thread_id;
      }
      return null;
    } finally { db.close(); }
  }
  async function create(signal) {
    triedAt = now();
    const brief = await fetchBrief().catch(() => ({}));
    const message = conductorBrief(brief);
    const had = state.threadId;
    const choice = state.model;
    const made = await runT3({bin, path, project, title: CONDUCTOR_TITLE, message, signal,
      ...(choice ? {provider: choice.instanceId, model: choice.model} : {})});
    state = {threadId: made.threadId, project, createdAt: new Date(now()).toISOString(), ...(brief.env ? {env: brief.env} : {}), ...(choice ? {model: choice} : {})};
    writeState(stateFile, state);
    log(had ? 'office bridge: conductor thread was gone; started a new one' : 'office bridge: started the conductor thread');
    return made.threadId;
  }
  return {
    get threadId() { return state.threadId || ''; },
    owns: agentId => !!agentId && agentId === state.threadId,
    async ensure(signal) {
      const id = current();
      if (id) return id;
      if (creating) return creating;
      if (now() - triedAt < CREATE_EVERY) return null;
      creating = create(signal).catch(() => { log('office bridge: could not start the conductor thread'); return null; })
        .finally(() => { creating = null; });
      return creating;
    },
    // The conductor as an office agent: idle, running or waiting; its transcript (without the [[office]] lines)
    // and its latest finished reply.
    entry(host) {
      const id = state.threadId;
      if (!id || !existsSync(path)) return null;
      const db = open(DatabaseSync, path);
      try {
        const row = threadRow(db, id);
        if (!alive(row)) return null;
        const live = optional(db, `SELECT * FROM ${runs} WHERE thread_id=? AND status IN ('running','queued','starting') ORDER BY ordinal DESC`, id)[0];
        const pending = optional(db, `SELECT * FROM ${requests} WHERE thread_id=? AND resolved_at IS NULL AND status NOT IN ('resolved','cancelled','expired')`, id)[0];
        const said = optional(db, `SELECT * FROM ${items} WHERE thread_id=? AND type IN ('user_message','assistant_message','command_execution','file_change','dynamic_tool','subagent')
          ORDER BY ordinal DESC LIMIT 40`, id);
        let reply = null;
        for (const item of said) {
          if (item.type === 'user_message') { if (reply) break; continue; }
          if (item.type !== 'assistant_message') continue;
          const data = parseJson(item.payload_json), parsed = parseReply(data.text);
          // A turn still running may say more: only a tagged message, or one from a finished turn, is the reply.
          if (!parsed.say || (!parsed.tagged && live && item.run_id === live.run_id)) continue;
          const at = [data.completedAt, data.updatedAt, data.startedAt, item.updated_at].find(v => typeof v === 'string' && Number.isFinite(Date.parse(v)));
          reply = {text: transcriptText(parsed.say, SAY_MAX), cards: parsed.cards, ...(at ? {at} : {})};
          break;
        }
        const transcript = said.slice(0, 12).reverse().map(item => {
          const data = parseJson(item.payload_json);
          const at = [data.startedAt, data.updatedAt, item.updated_at].find(v => typeof v === 'string' && Number.isFinite(Date.parse(v)));
          const text = item.type === 'assistant_message' ? parseReply(data.text).prose || parseReply(data.text).say : data.text;
          return transcriptEntry(item.type, {...data, text}, at);
        }).filter(Boolean).map(entry => ({...entry, text: transcriptText(entry.text, 400)})).filter(entry => entry.text);
        const selection = parseJson(row.payload_json).modelSelection || {};
        const slug = typeof selection.model === 'string' ? selection.model : '';
        const instance = (typeof selection.instanceId === 'string' && selection.instanceId) || row.provider_instance_id || live?.provider || '';
        const chosen = parseModel(instance && slug ? `${instance}:${slug}` : '');
        const model = chosen?.model || slug;
        const provider = chosen?.instanceId || instance;
        const status = pending ? 'waiting' : live ? 'running' : 'idle';
        return {
          id, title: 'Chief of Staff', role: 'conductor', model, provider, ...(chosen ? {modelId: chosen.id} : {}),
          status, activity: status === 'running' ? 'Working on your message' : status === 'waiting' ? 'Waiting for you in T3 Code' : 'Listening',
          activityKind: status === 'running' ? 'think' : 'idle', host, cwd: null,
          can: live ? ['message', 'stop', 'model', 'history'] : ['message', 'model', 'history'], runId: live?.run_id, transcript, ...(reply ? {reply} : {}),
          // What it is doing while it works: its reasoning and tool steps (owner only in Flow).
          ...(live ? {live: readLive(db, id, live.run_id)} : {}),
        };
      } finally { db.close(); }
    },
    // A message as the thread's next turn, over the warm T3 session (T3's own message.dispatch, queued after a
    // running turn). Never logged.
    async send(text, signal) {
      const id = state.threadId;
      if (!id) return {ok: false, message: 'The Chief of Staff thread is not ready yet.'};
      if (typeof text !== 'string' || !text.trim() || text.length > 2000) return {ok: false, message: 'That message is empty or too long.'};
      try {
        const commandId = randomUUID();
        await dispatch({type: 'message.dispatch', commandId, threadId: id, messageId: commandId, text, attachments: [],
          dispatchMode: {type: 'queue_after_active'}, createdBy: 'user', creationSource: 'web'}, () => current() === id, signal);
        return {ok: true, message: 'Chief of Staff has it.'};
      } catch {
        return {ok: false, message: 'Could not reach the Chief of Staff thread. Check T3 Code.'};
      }
    },
    // The next turn uses this model (T3's thread.model-selection.set). Remembered so a replacement thread starts on it.
    async setModel(id, signal) {
      const parsed = parseModel(id);
      if (!parsed) return {ok: false, message: 'Pick a model like cursor_personal:grok-4.7.'};
      const threadId = state.threadId;
      if (!threadId) return {ok: false, message: 'The Chief of Staff thread is not ready yet.'};
      try {
        const commandId = randomUUID();
        await dispatch({type: 'thread.model-selection.set', commandId, threadId,
          modelSelection: {instanceId: parsed.instanceId, model: parsed.model}}, () => current() === threadId, signal);
        state = {...state, model: {instanceId: parsed.instanceId, model: parsed.model}};
        writeState(stateFile, state);
        return {ok: true, message: `Next turn uses ${parsed.model}.`};
      } catch {
        return {ok: false, message: 'Could not switch its model. Check T3 Code.'};
      }
    },
  };
}
