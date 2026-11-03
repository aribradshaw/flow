// tools/devlog-auto.mjs: admission times, timezone offsets and release fields from commit trailers.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localIso,admissionFor,releaseFields} from '../tools/devlog-auto.mjs';

test('admission is the earliest push whose head contains the commit',()=>{
  const heads={b:['a','b'],c:['a','b','c'],x:['a','x']};
  const contains=(c,after)=>heads[after]?.includes(c)??false;
  const pushes=[{at:'2026-11-02T03:00:00Z',after:'c'},{at:'2026-11-02T01:00:00Z',after:'x'},{at:'2026-11-02T02:00:00Z',after:'b'}];
  assert.equal(admissionFor('a',pushes,contains),'2026-11-02T01:00:00Z');
  assert.equal(admissionFor('b',pushes,contains),'2026-11-02T02:00:00Z');
  assert.equal(admissionFor('c',pushes,contains),'2026-11-02T03:00:00Z');
  assert.equal(admissionFor('z',pushes,contains),null);
});

test('admission times carry the scheme timezone offset',()=>{
  assert.equal(localIso('2026-11-02T23:57:13Z','America/Phoenix'),'2026-11-02T16:57:13-07:00');
  assert.equal(localIso('2026-11-01T06:59:59Z','America/Phoenix'),'2026-10-31T23:59:59-07:00');
  assert.equal(localIso('2026-11-02T12:00:00Z','UTC'),'2026-11-02T12:00:00+00:00');
});

test('notes come from DevLog-Note trailers, else the subject',()=>{
  assert.deepEqual(releaseFields('Fix the board',[]),{notes:['Fix the board.'],compat:'compatible',action:undefined});
  assert.deepEqual(releaseFields('Fix it!',[{key:'Co-Authored-By',value:'Someone'}]).notes,['Fix it!']);
  const f=releaseFields('Rename storage',[{key:'DevLog-Note',value:'Cards keep their labels'},{key:'devlog-note',value:'Boards load faster.'},{key:'DevLog-Compat',value:'Breaking'},{key:'DevLog-Action',value:'Re-import old backups.'}]);
  assert.deepEqual(f,{notes:['Cards keep their labels.','Boards load faster.'],compat:'breaking',action:'Re-import old backups.'});
  assert.equal(releaseFields('x',[{key:'DevLog-Compat',value:'maybe'}]).compat,'compatible');
});
