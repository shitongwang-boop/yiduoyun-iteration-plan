const assert = require('node:assert/strict');
const test = require('node:test');

const { compactItems, findConcurrentConflicts, isConfigured, mergeConcurrentItems, parsePayload } = require('../collaboration.js');

const base = [
  { id: 'a', start: '2026-08-07', end: '2026-08-10' },
  { id: 'b', start: '2026-08-11', end: '2026-08-14' }
];

test('compactItems strips display-only fields', () => {
  assert.deepEqual(compactItems([{ ...base[0], title: 'A' }]), [base[0]]);
});

test('compactItems retains row update attribution', () => {
  assert.deepEqual(compactItems([{ ...base[0], updatedBy: '小云', updatedAt: '2026-08-11T10:00:00.000Z' }]), [
    { ...base[0], updatedBy: '小云', updatedAt: '2026-08-11T10:00:00.000Z' }
  ]);
});

test('remote changes survive when the local client edits another field', () => {
  const local = [{ ...base[0], end: '2026-08-12' }, base[1]];
  const remote = [base[0], { ...base[1], start: '2026-08-12' }];
  assert.deepEqual(mergeConcurrentItems(base, local, remote), [
    { ...base[0], end: '2026-08-12' },
    { ...base[1], start: '2026-08-12' }
  ]);
});

test('local reordering combines with remote date changes', () => {
  const local = [base[1], base[0]];
  const remote = [{ ...base[0], start: '2026-08-08' }, base[1]];
  assert.deepEqual(mergeConcurrentItems(base, local, remote), [
    base[1],
    { ...base[0], start: '2026-08-08' }
  ]);
});

test('a cross-field date conflict keeps the latest valid local range', () => {
  const local = [{ ...base[0], end: '2026-08-08' }, base[1]];
  const remote = [{ ...base[0], start: '2026-08-09' }, base[1]];
  assert.deepEqual(mergeConcurrentItems(base, local, remote), local);
});

test('same date field changed by two people requires an explicit choice', () => {
  const local = [{ ...base[0], start: '2026-08-08' }, base[1]];
  const remote = [{ ...base[0], start: '2026-08-09' }, base[1]];
  assert.deepEqual(findConcurrentConflicts(base, local, remote), [
    { id: 'a', field: 'start', local: '2026-08-08', remote: '2026-08-09' }
  ]);
});

test('independent date changes are merged without a conflict', () => {
  const local = [{ ...base[0], end: '2026-08-12' }, base[1]];
  const remote = [base[0], { ...base[1], start: '2026-08-12' }];
  assert.deepEqual(findConcurrentConflicts(base, local, remote), []);
});

test('configuration accepts a GitHub repository data file', () => {
  assert.equal(isConfigured({ owner: '', repo: '', path: '' }), false);
  assert.equal(isConfigured({
    owner: 'shitongwang-boop',
    repo: 'yiduoyun-iteration-plan',
    path: 'data/iteration-plan.json'
  }), true);
});

test('shared data accepts the GitHub file schema', () => {
  assert.deepEqual(parsePayload({ items: base }), base);
  assert.deepEqual(parsePayload({ iterationThemes: base }), base);
  assert.throws(() => parsePayload({}), /items/);
});
