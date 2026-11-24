import {readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {createTranscriptUsage, localDay} from './office-bridge-usage.mjs';

const recentMs = 5 * 60_000;

function names(path) {
  try { return readdirSync(path); } catch { return []; }
}

export function createCodexScanner(root, DatabaseSync) {
  const transcripts = createTranscriptUsage('codex');
  return (exclude, now) => {
    const paths = new Map();
    // The state index finds recent sessions resumed from an older directory.
    const database = names(root).filter(name => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
    if (database) {
      let db;
      try {
        db = new DatabaseSync(join(root, database), {readOnly: true});
        for (const row of db.prepare('SELECT id, rollout_path, title FROM threads WHERE archived=0 AND updated_at>=?')
          .all(Math.floor((now - recentMs) / 1000))) paths.set(row.rollout_path, row);
      } catch {
        // A missing or incompatible index still permits discovery of fresh session logs.
      } finally {
        db?.close();
      }
    }
    for (const offset of [0, -1]) {
      const date = new Date(now);
      date.setDate(date.getDate() + offset);
      const dir = join(root, 'sessions', String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
      for (const name of names(dir)) {
        const path = join(dir, name);
        if (name.startsWith('rollout-') && name.endsWith('.jsonl') && !paths.has(path)) paths.set(path, null);
      }
    }

    const day = localDay(now);
    const agents = new Map();
    for (const [path, indexed] of paths) {
      try {
        if (exclude.has(indexed?.id) || (!indexed && statSync(path).mtimeMs < now - recentMs)) continue;
        const {meta, usage, running, model} = transcripts.read(path, day);
        if (typeof meta?.id !== 'string' || exclude.has(meta.id) || !['cli', 'exec'].includes(meta.source)
          || /^t3(?:[ -]?code)?$/i.test(meta.originator || '') || !usage) continue;
        agents.set(meta.id, {
          id: 'codex:' + meta.id, provider: 'codex', title: indexed?.title || 'Codex CLI session', cwd: meta.cwd, model, usage,
          status: running ? 'running' : 'idle', activity: running ? 'Working in Codex CLI' : '',
        });
      } catch {
        // A session can be removed while being scanned.
      }
    }
    return [...agents.values()];
  };
}
