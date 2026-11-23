import {closeSync, openSync, readFileSync, readSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {parseJson, short} from './office-bridge-t3.mjs';

const windowMs = 5 * 60_000;
const readLimit = 512 * 1024;

function entries(path) {
  try { return readdirSync(path, {withFileTypes: true}); }
  catch { return []; }
}

const blocks = row => Array.isArray(row.message?.content) ? row.message.content : [];
function userPrompt(row) {
  if (row.type !== 'user' || row.isMeta || row.isSidechain || blocks(row).some(b => b?.type === 'tool_result')) return '';
  const content = row.message?.content;
  const text = typeof content === 'string' ? content : blocks(row)
    .filter(b => b?.type === 'text').map(b => b.text).join(' ');
  return text.trimStart().startsWith('<') || text.startsWith('[Request interrupted') ? '' : short(text);
}

function readRows(fd, offset, size, total) {
  const buffer = Buffer.alloc(size);
  const bytes = readSync(fd, buffer, 0, size, offset);
  const lines = buffer.toString('utf8', 0, bytes).split('\n');
  if (offset > 0) lines.shift();
  if (offset + bytes < total) lines.pop();
  return lines.map(parseJson).filter(row => !row.isSidechain);
}

function readTranscript(path, size) {
  const fd = openSync(path, 'r');
  try {
    const head = readRows(fd, 0, size <= 2 * readLimit ? size : readLimit, size);
    const title = head.map(userPrompt).find(Boolean);
    const rows = size <= 2 * readLimit ? head : head.concat(readRows(fd, size - readLimit, readLimit, size));
    let cwd, model, lastTool, fromT3 = false;
    const outstanding = new Map();
    for (const row of rows) {
      if (typeof row.cwd === 'string') cwd = row.cwd;
      if ([row.entrypoint, row.originator].some(value => /^t3(?:[ -]?code)?$/i.test(short(value)))) fromT3 = true;
      if (row.type === 'user' && userPrompt(row)) {
        outstanding.clear();
        lastTool = null;
      }
      if (row.type === 'assistant' && row.message?.model && row.message.model !== '<synthetic>') model = row.message.model;
      for (const block of blocks(row)) {
        if (row.type === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string') {
          lastTool = block;
          outstanding.set(block.id, block);
        }
        if (row.type === 'user' && block?.type === 'tool_result') outstanding.delete(block.tool_use_id);
      }
    }
    if (!title && !model && !cwd) return null;
    return {title, model, cwd, fromT3, lastTool, outstanding};
  } finally {
    closeSync(fd);
  }
}

function sessionStates(root) {
  const dir = join(root, 'sessions');
  const states = new Map();
  for (const entry of entries(dir)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    let state;
    try { state = parseJson(readFileSync(join(dir, entry.name), 'utf8')); }
    catch { continue; }
    if (typeof state.sessionId !== 'string' || !Number.isSafeInteger(state.pid) || state.pid <= 0) continue;
    try { process.kill(state.pid, 0); }
    catch (err) { if (err.code !== 'EPERM') continue; }
    if (!states.has(state.sessionId) || state.updatedAt > states.get(state.sessionId).updatedAt) {
      states.set(state.sessionId, state);
    }
  }
  return states;
}

export function createClaudeScanner(root) {
  let cache = new Map();
  return (exclude, now) => {
    const states = sessionStates(root);
    const nextCache = new Map();
    const sessions = new Map();
    const projects = join(root, 'projects');
    for (const dir of entries(projects)) {
      if (!dir.isDirectory()) continue;
      for (const entry of entries(join(projects, dir.name))) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const id = entry.name.slice(0, -6);
        if (!id || exclude.has(id)) continue;
        const path = join(projects, dir.name, entry.name);
        try {
          const {size, mtimeMs} = statSync(path);
          if (mtimeMs < now - windowMs || mtimeMs <= (sessions.get(id)?.mtimeMs ?? 0)) continue;
          const old = cache.get(path);
          const data = old?.size === size && old.mtimeMs === mtimeMs ? old.data : readTranscript(path, size);
          if (!data || data.fromT3) continue;
          nextCache.set(path, {size, mtimeMs, data});
          const state = states.get(id);
          const tools = [...data.outstanding.values()];
          const question = tools.find(tool => ['AskUserQuestion', 'ExitPlanMode'].includes(tool.name));
          const waiting = state?.status === 'waiting' || Boolean(question);
          const tool = question || (waiting ? tools[0] : null);
          const kind = tool?.name === 'ExitPlanMode' || (!question && state?.waitingFor === 'permission prompt')
            ? 'approval' : 'question';
          const pending = tool ? {
            requestId: tool.id, kind, can: [],
            summary: short(tool.input?.command) || (Array.isArray(tool.input?.questions)
              ? short(tool.input.questions.map(q => short(q?.question)).join(' ')) : '') || 'Review the prompt in Claude Code',
          } : null;
          sessions.set(id, {
            id: 'claude:' + id, provider: 'claudeAgent', mtimeMs,
            title: data.title || 'Claude Code session', model: data.model, cwd: data.cwd || state?.cwd,
            status: waiting ? 'waiting' : 'running', pending,
            activity: waiting ? 'Waiting for input' : short(data.lastTool?.name) || 'Working in Claude Code',
          });
        } catch {
          // A session can disappear or be rewritten as it is being scanned.
        }
      }
    }
    cache = nextCache;
    return [...sessions.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  };
}
