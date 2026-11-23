import {execFile} from 'node:child_process';
import {homedir, hostname} from 'node:os';
import {basename, join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs, promisify} from 'node:util';
import {createClaudeScanner} from './office-bridge-claude.mjs';
import {createT3PromptDetector, createT3Responder, createT3Session, defaultT3Db, loadSqlite, readT3, respondT3, short, stopT3} from './office-bridge-t3.mjs';
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

export async function makePayload({source, host, now, t3, claude, resolveRepo}) {
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
  top.push(...claude.filter(agent => validId(agent.id) && !t3.has(agent.id)));
  top.sort((a, b) => Number(Boolean(b.pending)) - Number(Boolean(a.pending)));
  const agents = [];
  const selected = top.slice(0, 200);
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
      // Messages and stops: T3 threads only (Claude Code in a terminal cannot be reached from outside).
      const can = isT3 && Array.isArray(agent.can) ? agent.can.filter(k => k === 'message' || k === 'stop') : [];
      const agentflow = agentflowOf(agent.title);
      // The transcript tail, masked and cut here before it leaves the machine (Flow masks it again).
      const transcript = (Array.isArray(agent.transcript) ? agent.transcript : []).slice(-12)
        .map(entry => ({...entry, text: transcriptText(entry.text, 400)})).filter(entry => entry.text);
      return {
        ...describe(agent), ...(agentflow ? {agentflow} : {}), activity: short(agent.activity), host, hostLabel: short(host + (isT3 ? ' · T3' : ' · Claude Code'), 120),
        repo: await resolveRepo(agent.cwd), children: [...children.values()].slice(0, 20), pending, can,
        ...(transcript.length ? {transcript} : {}),
      };
    })));
  }
  // The REST API accepts a JSON body of at most 1 MiB. Keep top-level agents ahead of children.
  const payload = {source, at: new Date(now).toISOString(), agents: []};
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
  print = console.log, log = console.error, sleep = delay, reportWake}) {
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
          : kind === 'stop';
        if (validId(action.agentId) && valid && (action.source === undefined || action.source === source)) {
          try { result = await respond({...action, kind}, signal); }
          catch { result = {ok: false, message: 'Could not reach the local agent.'}; }
        }
        // Messages and stops are logged with the agent and the outcome, never the message's text.
        log('office bridge: ' + (kind === 'answer' ? '' : `${kind} for ${short(action.agentId, 120)}: ${result.ok ? 'ok' : 'failed'}: `) + result.message);
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

const help = `Usage: flow office bridge [options]
Report local T3 Code and Claude Code agents to Flow's 3D office.
Uses the server URL and write-scope API key from flow login or FLOW_URL and FLOW_API_KEY.

  --once          Print one snapshot and send it, then exit
  --dry-run       Print snapshots without connecting to Flow
  --source <name> Override the source (default: bridge:<hostname>)
  --interval <s>  Seconds between reports (default: 3)
  --t3-db <path>  T3 state database (default: ~/.t3/userdata/statev2.sqlite or T3CODE_HOME)
  --help          Show these options`;

export async function officeBridge(cfg, argv) {
  const {values} = parseArgs({args: argv, options: {
    once: {type: 'boolean'}, 'dry-run': {type: 'boolean'}, help: {type: 'boolean', short: 'h'},
    source: {type: 'string'}, interval: {type: 'string'}, 't3-db': {type: 'string'},
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
  const resolveRepo = createRepoResolver();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const session = createT3Session(path, controller.signal);
  const dispatch = (_path, command, valid, signal) => session.dispatch(command, valid, signal);
  const reportWake = createReportWake();
  let detector, promptTimer, warmTimer;
  if (!values.once && !values['dry-run']) {
    detector = createT3PromptDetector(DatabaseSync, path);
    detector.check();
    promptTimer = setInterval(() => { if (detector.check()) reportWake.notify(); }, 200);
    const warm = () => session.warm().catch(() => {});
    warm();
    warmTimer = setInterval(warm, 5000);
  }
  let t3Unavailable = false;
  try {
    await runBridge({
      cfg, source, interval, once: values.once, dryRun: values['dry-run'], signal: controller.signal, reportWake,
      respond: createT3Responder(DatabaseSync, path, (...args) => respondT3(...args, dispatch), {
        stop: (...args) => stopT3(...args, dispatch),
      }),
      scan: async () => {
        const now = Date.now();
        let data;
        try {
          data = readT3(DatabaseSync, path);
          if (t3Unavailable) console.error('office bridge: T3 state recovered');
          t3Unavailable = false;
        } catch {
          if (!t3Unavailable) console.error('office bridge: could not read T3 state');
          t3Unavailable = true;
          data = {agents: new Map(), nativeIds: new Set()};
        }
        return makePayload({source, host, now, t3: data.agents, claude: scanClaude(data.nativeIds, now), resolveRepo});
      },
    });
  } finally {
    controller.abort();
    clearInterval(promptTimer);
    clearInterval(warmTimer);
    detector?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
