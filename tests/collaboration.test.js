const assert = require('node:assert/strict');
const test = require('node:test');

const { compactItems, isConfigured, mergeConcurrentItems } = require('../collaboration.js');

const base = [
  { id: 'a', start: '2026-08-07', end: '2026-08-10' },
  { id: 'b', start: '2026-08-11', end: '2026-08-14' }
];

test('compactItems strips display-only fields', () => {
  assert.deepEqual(compactItems([{ ...base[0], title: 'A' }]), [base[0]]);
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

test('configuration rejects placeholders and accepts a Supabase project', () => {
  assert.equal(isConfigured({ supabaseUrl: '', supabaseAnonKey: '' }), false);
  assert.equal(isConfigured({
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'x'.repeat(41)
  }), true);
});
