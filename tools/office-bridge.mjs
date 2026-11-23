import {execFile} from 'node:child_process';
import {homedir, hostname} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {existsSync, readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs, promisify} from 'node:util';
import {createCodexScanner} from './office-bridge-codex.mjs';
import {createT3Usage, sumUsage} from './office-bridge-usage.mjs';
import {createClaudeScanner} from './office-bridge-claude.mjs';
import {createT3PromptDetector, createT3Responder, createT3Session, defaultT3Db, loadSqlite, readT3, respondT3, short, stopT3} from './office-bridge-t3.mjs';
import {CONDUCTOR_AGENT, createConductor} from './office-bridge-conductor.mjs';
import {createLiveWatcher, liveFromTranscript, readRunningLive, readThreads} from './office-bridge-threads.mjs';
import {transcriptText} from '../lib/office-mask.mjs';

const exec = promisify(execFile);
const API = '/api/v1/office';
const backoff = [3000, 6000, 15000, 30000, 60000];
const validId = (id, limit = 200) => typeof id === 'string' && id.length > 0 && id.length <= limit
  && !/[\s\u0000-\u001f\u007f]/.test(id);
const titleCase = word => word[0].toUpperCase() + word.slice(1);
// The AgentFlow agent and card a thread works on, from the reference runner's title
// "[Flow] <Agent>: #<n> <card title>" (tools/agent-runner.mjs). The office seats it at that agent's
// desk (lib/office-seats.mjs reads the same pattern, and plain "#<n>" titles, on the server).
export function agentflowOf(title) {
  const match = /^\s*\[Flow\]\s+(.+?):\s+#(\d{1,9})\b/i.exec(String(title ?? ''));
  return match ? {agent: match[1].trim().slice(0, 200), card: Number(match[2])} : null;
}

function modelInfo(value, provider) {
  const raw = short(value);
  const model = raw.split('/').at(-1).replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  const claude = /(?:^|-)(opus|sonnet|haiku|fable)(?=-|\[|$)/i.exec(model);
  if (claude) {
    const version = model.match(/\b\d{1,2}(?:[.-]\d{1,2})*\b/)?.[0].replaceAll('-', '.');
    const tag = /\[([^\]]+)\]$/.exec(model)?.[1].toUpperCase();
    return {vendor: 'claude', model: short([titleCase(claude[1].toLowerCase()), version, tag].filter(Boolean).join(' '), 80)};
  }
  if (/^(gpt|codex|chatgpt|o\d)/i.test(model)) {
    return {vendor: 'codex', model: short(model.replace(/^gpt/i, 'GPT').replace(/-(?=[a-z])/gi, ' ')
      .replace(/ [a-z]/gi, word => word.toUpperCase()), 80)};
  }
  if (/^(gemini|gemma)/i.test(model)) return {vendor: 'gemini', model: short(titleCase(model), 80)};
  const driver = short(provider).toLowerCase();
  const vendor = /claude|anthropic/.test(driver) ? 'claude'
    : /codex|openai/.test(driver) ? 'codex' : /gemini|google/.test(driver) ? 'gemini' : 'other';
  return {vendor, model: short(model, 80) || 'Unknown'};
}

export function normalizeRemote(value) {
  const remote = value.trim();
  let url;
  try {
    const scp = !remote.includes('://') && /^(?:[^@/]+@)?([^:/\\\s]+):([^/\\].*)$/.exec(remote);
    if (scp && !/^[a-z]:/i.test(remote)) url = new URL('ssh://' + scp[1] + '/' + scp[2]);
    else url = new URL(remote);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname || url.pathname === '/') return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
  } catch { return null; }
  return url.href.length <= 500 ? url.href : null;
}

export function createRepoResolver() {
  const cache = new Map();
  return async cwd => {
    if (typeof cwd !== 'string' || !cwd.trim()) return null;
    const cached = cache.get(cwd);
    if (cached?.until > Date.now()) return cached.result;
    const result = (async () => {
      let remote;
      try {
        const {stdout} = await exec('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
          timeout: 1500, maxBuffer: 16384, windowsHide: true,
        });
        remote = normalizeRemote(stdout);
      } catch {
        remote = null;
      }
      const path = remote ? new URL(remote).pathname : cwd;
      const name = short(basename(path.replaceAll('\\', '/')).replace(/\.git$/i, ''), 120);
      return name ? {name, remote} : null;
    })();
    if (cache.size >= 512) cache.delete(cache.keys().next().value);
    cache.set(cwd, {until: Date.now() + 60_000, result});
    return result;
  };
}

function describe(agent) {
  return {
    id: agent.id, title: short(agent.title) || 'Coding agent', ...modelInfo(agent.model, agent.provider),
    status: ['running', 'waiting', 'idle'].includes(agent.status) ? agent.status : 'running',
  };
}

export async function makePayload({source, host, now, t3, claude, codex = [], resolveRepo, conductor = null, threads}) {
  // The conductor (office-bridge-conductor.mjs) is reported once, as itself, never as an ordinary T3 thread.
  if (conductor && t3.has(conductor.id)) { t3 = new Map(t3); t3.delete(conductor.id); }
  const childrenByParent = new Map();
  const top = [];
  for (const agent of t3.values()) {
    if (!validId(agent.id)) continue;
    const parent = t3.get(agent.parent);
    // The wire format carries prompts on top-level agents only.
    if (parent && parent.id !== agent.id && validId(parent.id) && !agent.pending
      && (!t3.has(parent.parent) || parent.pending || parent.parent === parent.id)) {
      if (!childrenByParent.has(parent.id)) childrenByParent.set(parent.id, []);
      childrenByParent.get(parent.id).push(agent);
    } else {
      top.push(agent);
    }
  }
  top.push(...[...claude, ...codex].filter(agent => validId(agent.id) && !t3.has(agent.id)));
  top.sort((a, b) => Number(Boolean(b.pending)) - Number(Boolean(a.pending)));
  const agents = [];
  if (conductor && validId(conductor.id)) {
    const transcript = (conductor.transcript ?? []).slice(-12).map(entry => ({...entry, text: transcriptText(entry.text, 400)})).filter(entry => entry.text);
    agents.push({...describe(conductor), role: 'conductor', activity: short(conductor.activity), activityKind: conductor.activityKind,
      host, hostLabel: short(host + ' · T3', 120), repo: null, children: [], pending: null,
      can: (conductor.can ?? ['message']).filter(k => k === 'message' || k === 'stop' || k === 'history'),
      ...(conductor.live && conductor.status !== 'idle' ? {live: conductor.live} : {}),
      ...(transcript.length ? {transcript} : {}),
      ...(conductor.reply ? {reply: {...conductor.reply, text: transcriptText(conductor.reply.text, 600)}} : {})});
  }
  const selected = top.slice(0, 200 - agents.length);
  for (let offset = 0; offset < selected.length; offset += 8) {
    agents.push(...await Promise.all(selected.slice(offset, offset + 8).map(async agent => {
      const isT3 = t3.has(agent.id);
      const children = new Map((childrenByParent.get(agent.id) ?? []).map(child => [child.id, describe(child)]));
      for (const child of agent.children ?? []) {
        const id = child.subagentId || child.id;
        if (!validId(id) || children.has(id) || t3.has(child.childThreadId)) continue;
        const provider = child.driver || child.providerInstanceId || agent.provider;
        const model = child.model ?? child.modelSelection?.model ?? (provider === agent.provider ? agent.model : undefined);
        children.set(id, describe({id, title: short(child.title) || 'Subagent', provider, model, status: 'running'}));
      }
      const pending = validId(agent.pending?.requestId, 300) ? {
        requestId: agent.pending.requestId, kind: agent.pending.kind,
        summary: short(agent.pending.summary), can: isT3 ? agent.pending.can : [],
      } : null;
      // Messages, stops and history: T3 threads only (Claude Code in a terminal cannot be reached from outside).
      const can = isT3 && Array.isArray(agent.can) ? agent.can.filter(k => k === 'message' || k === 'stop' || k === 'history') : [];
      // What it is doing right now: T3's turn items, else the transcript tail since its last prompt.
      const live = agent.live ?? (!isT3 && agent.status !== 'idle' ? liveFromTranscript(agent.transcript) : null);
      const agentflow = agentflowOf(agent.title);
      // The transcript tail, masked and cut here before it leaves the machine (Flow masks it again).
      const transcript = (Array.isArray(agent.transcript) ? agent.transcript : []).slice(-12)
        .map(entry => ({...entry, text: transcriptText(entry.text, 400)})).filter(entry => entry.text);
      const usage = sumUsage([agent.usage, ...[...(childrenByParent.get(agent.id) ?? [])].slice(0, 20)
        .filter(child => agent.cwd && child.cwd === agent.cwd).map(child => child.usage)]);
      const reporter = isT3 ? 'T3' : agent.provider === 'codex' ? 'Codex CLI' : 'Claude Code';
      return {
        ...describe(agent), ...(usage ? {usage} : {}), ...(agentflow ? {agentflow} : {}), activity: short(agent.activity), host, hostLabel: short(host + ' · ' + reporter, 120),
        repo: await resolveRepo(agent.cwd), children: [...children.values()].slice(0, 20), pending, can,
        ...(live ? {live} : {}), ...(transcript.length ? {transcript} : {}),
      };
    })));
  }
  // The REST API accepts a JSON body of at most 1 MiB. Keep top-level agents ahead of children.
  const payload = {source, at: new Date(now).toISOString(), agents: [], ...(threads !== undefined ? {threads} : {})};
  let room = (1 << 20) - Buffer.byteLength(JSON.stringify(payload));
  const children = [];
  for (const agent of agents) {
    const {children: nested, ...fields} = agent;
    const entry = {...fields, children: []};
    room -= Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (room < 0) break;
    payload.agents.push(entry);
    children.push(nested);
  }
  for (const [index, entry] of payload.agents.entries()) {
    for (const child of children[index]) {
      room -= Buffer.byteLength(JSON.stringify(child)) + 1;
      if (room < 0) return payload;
      entry.children.push(child);
    }
  }
  return payload;
}

function requestFlow(cfg, signal) {
  return async (method, path, body) => {
    const response = await fetch(cfg.url + API + path, {
      method, redirect: 'error',
      headers: {authorization: 'Bearer ' + cfg.key, accept: 'application/json',
        ...(body !== undefined ? {'content-type': 'application/json'} : {})},
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error('HTTP ' + response.status);
      error.status = response.status;
      error.retryAfter = Number(response.headers.get('retry-after')) * 1000 || 0;
      throw error;
    }
    if (method === 'POST') return response.body?.cancel();
    const data = await response.json();
    if (!Array.isArray(data?.actions)) throw new Error('Invalid office server response');
    return data.actions;
  };
}

export function createReportWake() {
  let pending = false;
  let wake;
  return {
    notify() { pending = true; wake?.(); },
    async wait(ms, signal) {
      if (!pending && ms > 0 && !signal.aborted) {
        await new Promise(resolve => {
          const timer = setTimeout(done, ms);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            wake = undefined;
            resolve();
          }
          wake = done;
          signal.addEventListener('abort', done, {once: true});
        });
      }
      if (pending) {
        try { await delay(100, undefined, {signal}); }
        catch (error) { if (!signal.aborted) throw error; }
        pending = false;
      }
    },
  };
}

export async function runBridge({cfg, source, scan, respond, signal, interval = 3000, once = false, dryRun = false,
  print = console.log, log = console.error, sleep = delay, reportWake, onReported}) {
  const request = requestFlow(cfg, signal);
  const jobs = new Map();
  let respondQueue = Promise.resolve();
  let lastSnapshot;
  function enqueue(actions) {
    for (const action of actions) {
      if (!validId(action?.id) || jobs.has(action.id)) continue;
      const job = {action, failures: 0, next: 0};
      jobs.set(action.id, job);
      respondQueue = respondQueue.then(async () => {
        if (signal.aborted) return;
        let result = {ok: false, message: 'Invalid office action.'};
        // kind: answer (Allow / Deny; also when missing), message (text) or stop.
        const kind = action.kind ?? 'answer';
        const valid = kind === 'answer' ? validId(action.requestId, 300)
          : kind === 'message' ? typeof action.text === 'string' && action.text.trim() !== '' && action.text.length <= 2000
          : kind === 'history' ? action.before === undefined || (typeof action.before === 'string' && action.before.length <= 200)
          : kind === 'stop';
        if (validId(action.agentId) && valid && (action.source === undefined || action.source === source)) {
          try { result = await respond({...action, kind}, signal); }
          catch { result = {ok: false, message: 'Could not reach the local agent.'}; }
        }
        // Messages and stops are logged with the agent and the outcome, never the message's text.
        if (kind !== 'history' || !result.ok) log('office bridge: ' + (kind === 'answer' ? '' : `${kind} for ${short(action.agentId, 120)}: ${result.ok ? 'ok' : 'failed'}: `) + result.message);
        job.result = result;
        if (!once) {
          job.next = Infinity;  // The retry loop starts only if this POST fails.
          void ack(job);
        }
      });
    }
  }

  function retryMs(error, failures) {
    const min = error.status === 401 || error.status === 403 ? 120_000 : 0;
    return Math.max(min, Math.min(error.retryAfter ?? 0, 300_000), backoff[Math.min(failures, backoff.length - 1)]);
  }

  async function ack(job, result = job.result) {
    try {
      await request('POST', '/actions/' + encodeURIComponent(job.action.id), result);
      job.ackedAt = Date.now();
      if (job.failures) log('office bridge: action acknowledgement recovered');
    } catch (error) {
      if (once) throw error;
      if (signal.aborted) return;
      if (!job.failures) log('office bridge: could not acknowledge an action' + (error.status ? ' (HTTP ' + error.status + ')' : ''));
      if (error.status === 404) job.ackedAt = Date.now();
      else job.next = Date.now() + retryMs(error, job.failures++);
    }
  }

  async function report() {
    const payload = await scan();
    if (once || dryRun) print(JSON.stringify(payload, null, 2));
    if (!dryRun) {
      enqueue(await request('PUT', '/agents', payload));
      onReported?.(payload);
      const snapshot = JSON.stringify(payload.agents.map(agent => [agent.id, agent.status,
        agent.pending?.requestId, agent.children.map(child => [child.id, child.status]).sort()]).sort());
      if (!once && snapshot !== lastSnapshot) {
        log(`office bridge: reporting ${payload.agents.length} agents (${payload.agents.filter(a => a.status === 'waiting').length} waiting)`);
        lastSnapshot = snapshot;
      }
    }
  }

  if (once) {
    await report();
    await respondQueue;
    for (const job of jobs.values()) await ack(job);
    return;
  }

  async function loop(label, work, intervalMs) {
    let state;
    let failures = 0;
    while (!signal.aborted) {
      let wait = intervalMs;
      try {
        const started = Date.now();
        await work();
        wait = Math.max(intervalMs - (Date.now() - started), 0);
        if (state) log('office bridge: ' + label + ' recovered');
        state = undefined;
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        const reason = error.status ? 'HTTP ' + error.status : 'temporarily unavailable';
        if (reason !== state) log('office bridge: ' + label + ' failed (' + reason + ')');
        state = reason;
        wait = retryMs(error, failures++);
      }
      if (label === 'report' && reportWake && !failures) await reportWake.wait(wait, signal);
      else if (wait) await sleep(wait, undefined, {signal}).catch(error => { if (!signal.aborted) throw error; });
    }
  }

  if (dryRun) return loop('scan', report, interval);
  const query = new URLSearchParams({source, wait: '25'});
  const reports = loop('report', report, interval);
  const poll = loop('action poll', async () => enqueue(await request('GET', '/actions?' + query)), 25);
  const acknowledgements = loop('action acknowledgement', async () => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (signal.aborted) return;
      if (job.ackedAt) {
        if (job.ackedAt < now - 86_400_000) jobs.delete(id);
      } else if (job.result && job.next <= now) {
        await ack(job);
      }
    }
  }, 500);
  await Promise.all([reports, poll, acknowledgements]);
  await respondQueue;
}

// Messages for the conductor go to its thread over the warm T3 session, whether or not a turn is running; a stop
// is T3's interrupt for the turn it reported. Everything else goes to the ordinary T3 responder.
export function conductorResponder(conductor, respond, {DatabaseSync, path, dispatch} = {}) {
  if (!conductor) return respond;
  return async (action, signal) => {
    if (!conductor.owns(action.agentId)) return respond(action, signal);
    if (action.kind === 'message') return conductor.send(action.text, signal);
    if (action.kind === 'stop') {
      const runId = conductor.entry('')?.runId;
      if (!runId) return {ok: false, message: 'It has no running turn to stop.'};
      try {
        await stopT3(path, {agentId: action.agentId, runId}, () => conductor.entry('')?.runId === runId, signal, dispatch);
        return {ok: true, message: 'Stopped in T3 Code.'};
      } catch { return {ok: false, message: 'Could not stop it. Check T3 Code.'}; }
    }
    return respond(action, signal);
  };
}

// Live steps between reports (docs/concepts/12-office.md "Live steps, threads and history"): every write to T3's
// database is noticed within pollMs; debounceMs after the last one (at most maxWaitMs while it keeps streaming, and
// never closer than gapMs) the running turns' live fields are read, and what changed since the last report or
// update goes to Flow (POST /live). A turn that started or ended, or a change to the thread index, asks for a full
// report instead (wake). read() -> {live: Map(id -> live), index?: signature}.
export function createLiveStream({read, post, wake, pollMs = 100, debounceMs = 150, maxWaitMs = 400, gapMs = 250, changed,
  now = () => Date.now(), log = () => {}}) {
  let sent = new Map(), reported = new Set(), index, timer, poll, first = 0, lastPost = 0, busy = false, again = false, failing = false;
  const sig = v => JSON.stringify(v ?? null);
  async function flush() {
    timer = undefined; first = 0;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const {live, index: nextIndex} = read();
      if (nextIndex !== undefined && index !== undefined && nextIndex !== index) { index = nextIndex; wake(); return; }
      if (nextIndex !== undefined) index = nextIndex;
      const running = new Set(live.keys());
      if ([...running].some(id => !reported.has(id)) || [...reported].some(id => !running.has(id))) { wake(); return; }
      const agents = [];
      for (const [id, value] of live) if (sig(value) !== sent.get(id)) agents.push({id, live: value ?? null});
      if (!agents.length) return;
      const wait = lastPost + gapMs - now();
      if (wait > 0) { again = true; await delay(wait); }
      lastPost = now();
      await post(agents);
      for (const a of agents) sent.set(a.id, sig(a.live));
      if (failing) log('office bridge: live updates recovered');
      failing = false;
    } catch (error) {
      if (!failing) log('office bridge: live updates failed' + (error?.status ? ' (HTTP ' + error.status + ')' : ''));
      failing = true;
    } finally {
      busy = false;
      if (again) { again = false; schedule(); }
    }
  }
  function schedule() {
    const t = now();
    if (!first) first = t;
    clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, Math.min(debounceMs, first + maxWaitMs - t)));
  }
  return {
    // After each full report: what Flow now holds (running agents' ids and their live fields).
    reported(agents) {
      reported = new Set(agents.filter(a => a.status !== 'idle').map(a => a.id));
      sent = new Map(agents.map(a => [a.id, sig(a.live)]));
    },
    start() { poll = setInterval(() => { if (changed()) schedule(); }, pollMs); },
    schedule,
    stop() { clearInterval(poll); clearTimeout(timer); },
  };
}

// The thread index goes in a report when it changed, and at least once a minute (Flow keeps the last one).
export function createThreadsOut({read, everyMs = 60_000, now = () => Date.now()}) {
  let sentSig, sentAt = 0, pendingSig;
  return {
    take() {
      let data;
      try { data = read(); } catch { return undefined; }
      const sig = JSON.stringify(data);
      if (sig === sentSig && now() - sentAt < everyMs) return undefined;
      pendingSig = sig;
      return data;
    },
    sent(payload) { if (payload.threads !== undefined && pendingSig) { sentSig = pendingSig; sentAt = now(); pendingSig = undefined; } },
    signature() { try { return JSON.stringify(read()); } catch { return undefined; } },
  };
}

function configDir() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'flygon-flow');
}

// The T3 project the conductor runs in: the one it used before, else the project with the newest thread.
export function conductorProject(DatabaseSync, path, stateFile) {
  try {
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (typeof saved.project === 'string' && saved.project) return saved.project;
  } catch {}
  try {
    const db = new DatabaseSync(path, {readOnly: true});
    try {
      const row = db.prepare(`SELECT p.workspace_root AS root FROM orchestration_v2_projection_threads t
        JOIN projection_projects p ON p.project_id = t.project_id WHERE t.deleted_at IS NULL ORDER BY t.updated_at DESC LIMIT 1`).get();
      if (row?.root) return row.root;
    } finally { db.close(); }
  } catch {}
  return homedir();
}

// The Chief of Staff agent's brief from Flow: env given, else the first of your environments that has the agent.
export async function fetchBrief(cfg, env, {fetchImpl = fetch} = {}) {
  const get = async path => {
    const response = await fetchImpl(cfg.url + path, {headers: {authorization: 'Bearer ' + cfg.key, accept: 'application/json'},
      redirect: 'error', signal: AbortSignal.timeout(15000)});
    if (!response.ok) { await response.body?.cancel(); return null; }
    return response.json();
  };
  const envs = env ? [env] : ((await get('/api/v1/envs'))?.items ?? []).map(e => e.id).filter(Boolean).slice(0, 10);
  for (const id of envs) {
    const found = await get(`/api/v1/envs/${encodeURIComponent(id)}/agents/${encodeURIComponent(CONDUCTOR_AGENT)}`).catch(() => null);
    const text = found?.agent?.instructions;
    if (found?.agent) return {env: id, agent: found.agent.name, rules: typeof text === 'string' ? text : ''};
  }
  return {env: envs[0] || ''};
}

const help = `Usage: flow office bridge [options]
Report local T3 Code, Claude Code and Codex CLI agents to Flow's 3D office.
Uses the server URL and write-scope API key from flow login or FLOW_URL and FLOW_API_KEY.

  --once          Print one snapshot and send it, then exit
  --dry-run       Print snapshots without connecting to Flow
  --source <name> Override the source (default: bridge:<hostname>)
  --interval <s>  Seconds between reports (default: 3)
  --t3-db <path>  T3 state database (default: ~/.t3/userdata/statev2.sqlite or T3CODE_HOME)
  --conductor     Keep a Chief of Staff thread in T3 for the office (default when T3 is set up here)
  --no-conductor  Do not
  --conductor-project <path>  The T3 project it runs in (default: the last one used, else your newest project)
  --conductor-env <env>       The Flow environment whose "Chief of Staff" agent gives its brief (default: the first one that has it)
  --help          Show these options`;

export async function officeBridge(cfg, argv) {
  const {values} = parseArgs({args: argv, options: {
    once: {type: 'boolean'}, 'dry-run': {type: 'boolean'}, help: {type: 'boolean', short: 'h'},
    source: {type: 'string'}, interval: {type: 'string'}, 't3-db': {type: 'string'},
    conductor: {type: 'boolean'}, 'no-conductor': {type: 'boolean'}, 'conductor-project': {type: 'string'}, 'conductor-env': {type: 'string'},
  }});
  if (values.help) {
    console.log(help);
    return;
  }
  const host = short(hostname(), 80) || 'localhost';
  const source = values.source ?? 'bridge:' + short(host, 53);
  if (!validId(source, 60)) throw new Error('--source must be 1–60 characters without spaces or control characters.');
  const interval = Number(values.interval ?? '3') * 1000;
  if (!Number.isFinite(interval) || interval < 1000 || interval > 60000) throw new Error('--interval must be 1–60 seconds.');
  if (!values['dry-run'] && (!/^https?:\/\//.test(cfg.url) || !cfg.key)) {
    throw new Error('Run flow login with a server URL and a write-scope API key, or set FLOW_URL and FLOW_API_KEY.');
  }

  const DatabaseSync = await loadSqlite();
  const path = resolve(values['t3-db'] ?? defaultT3Db());
  const scanClaude = createClaudeScanner(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
  const scanCodex = createCodexScanner(process.env.CODEX_HOME || join(homedir(), '.codex'), DatabaseSync);
  const readUsage = createT3Usage();
  const resolveRepo = createRepoResolver();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const session = createT3Session(path, controller.signal);
  const dispatch = (_path, command, valid, signal) => session.dispatch(command, valid, signal);
  const reportWake = createReportWake();
  // The Chief of Staff conductor: on when T3 is set up here (its database and a running server), unless --no-conductor.
  const wantConductor = !values['no-conductor'] && !values['dry-run'] && (values.conductor || existsSync(join(dirname(path), 'server-runtime.json')));
  const conductor = wantConductor ? createConductor({
    DatabaseSync, path, stateFile: join(configDir(), 'office-conductor.json'),
    project: values['conductor-project'] ? resolve(values['conductor-project']) : conductorProject(DatabaseSync, path, join(configDir(), 'office-conductor.json')),
    fetchBrief: () => fetchBrief(cfg, values['conductor-env']),
    dispatch: (command, valid, signal) => session.dispatch(command, valid, signal),
    log: message => console.error(message),
  }) : null;
  // Your T3 thread index (owner only in Flow), from the same database.
  const withDb = fn => { const db = new DatabaseSync(path, {readOnly: true}); try { db.exec('PRAGMA busy_timeout=200'); return fn(db); } finally { db.close(); } };
  const threadsOut = existsSync(path) ? createThreadsOut({read: () => withDb(db => readThreads(db))}) : null;
  let detector, promptTimer, warmTimer, liveStream, liveWatcher;
  if (!values.once && !values['dry-run'] && existsSync(path)) {
    liveWatcher = createLiveWatcher(DatabaseSync, path);
    let indexAt = 0, indexSig;
    liveStream = createLiveStream({
      changed: () => liveWatcher.check(),
      read: () => withDb(db => {
        const live = readRunningLive(db);
        // Only top-level threads and the conductor are agents in the report; the rest are children.
        const chief = conductor?.entry(host);
        if (chief && chief.status !== 'idle') live.set(chief.id, chief.live ?? null);
        if (Date.now() - indexAt > 1000) { indexAt = Date.now(); indexSig = threadsOut?.signature(); }
        return {live, index: indexSig};
      }),
      post: agents => fetch(cfg.url + API + '/live', {method: 'POST', redirect: 'error',
        headers: {authorization: 'Bearer ' + cfg.key, 'content-type': 'application/json', accept: 'application/json'},
        body: JSON.stringify({source, agents}), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])})
        .then(async r => { await r.body?.cancel(); if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), {status: r.status}); }),
      wake: () => reportWake.notify(),
      log: message => console.error(message),
    });
  }
  if (!values.once && !values['dry-run']) {
    detector = createT3PromptDetector(DatabaseSync, path);
    detector.check();
    promptTimer = setInterval(() => { if (detector.check()) reportWake.notify(); }, 200);
    const warm = () => session.warm().catch(() => {});
    warm();
    warmTimer = setInterval(warm, 5000);
  }
  let t3Unavailable = false;
  liveStream?.start();
  try {
    await runBridge({
      cfg, source, interval, once: values.once, dryRun: values['dry-run'], signal: controller.signal, reportWake,
      onReported: payload => {
        threadsOut?.sent(payload);
        // The T3 agents in it (Claude Code and Codex CLI sessions get their live field with each report only).
        liveStream?.reported(payload.agents.filter(agent => / · T3$/.test(agent.hostLabel ?? '')));
      },
      respond: conductorResponder(conductor, createT3Responder(DatabaseSync, path, (...args) => respondT3(...args, dispatch), {
        stop: (...args) => stopT3(...args, dispatch),
      }), {DatabaseSync, path, dispatch}),
      scan: async () => {
        const now = Date.now();
        let data;
        try {
          data = readT3(DatabaseSync, path, readUsage, now);
          if (t3Unavailable) console.error('office bridge: T3 state recovered');
          t3Unavailable = false;
        } catch {
          if (!t3Unavailable) console.error('office bridge: could not read T3 state');
          t3Unavailable = true;
          data = {agents: new Map(), nativeIds: new Set()};
        }
        let chief = null;
        if (conductor) {
          try { await conductor.ensure(controller.signal); chief = conductor.entry(host); }
          catch { chief = null; }
        }
        return makePayload({source, host, now, t3: data.agents, claude: scanClaude(data.nativeIds, now),
          codex: scanCodex(data.nativeIds, now), resolveRepo, conductor: chief, threads: threadsOut?.take()});
      },
    });
  } finally {
    controller.abort();
    clearInterval(promptTimer);
    clearInterval(warmTimer);
    liveStream?.stop();
    liveWatcher?.close();
    detector?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
