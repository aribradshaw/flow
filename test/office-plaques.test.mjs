import {test} from 'node:test';
import assert from 'node:assert/strict';
import {plaqueCopy} from '../public/office-plaques-core.js';

test('plaque copy: online available room with agents', () => {
  const c = plaqueCopy({name: 'Ari Bradshaw', me: true, online: true, presence: {status: 'available'}, extra: '8 agents'});
  assert.equal(c.title, 'Ari Bradshaw');
  assert.equal(c.subtitle, 'Your room');
  assert.deepEqual(c.lines, ['8 agents']);
  assert.equal(c.online, true);
  assert.equal(c.status.id, 'available');
});

test('plaque copy: offline leads with last seen, then agent note', () => {
  const c = plaqueCopy({name: 'Joseph Basrawi', online: false, seen: '11 min ago', extra: '2 agents'});
  assert.equal(c.subtitle, '');
  assert.deepEqual(c.lines, ['Offline · last seen 11 min ago', '2 agents']);
  assert.equal(c.status.id, 'offline');
  assert.equal(c.online, false);
});

test('plaque copy: focus status and a custom note', () => {
  const c = plaqueCopy({name: 'Sam', online: true, presence: {status: 'focus', text: 'on a call'}});
  assert.deepEqual(c.lines, ['on a call']);
  assert.equal(c.status.id, 'focus');
  assert.equal(c.status.color, '#d08900');
});

test('plaque copy: empty name falls back', () => {
  assert.equal(plaqueCopy({name: '  '}).title, 'Room');
});
