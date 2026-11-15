// Sotto — storage tests (memory backend) + synthesis input builder.

import test from 'node:test';
import assert from 'node:assert';
import { JournalStore, synthesisInput } from '../src/storage/db.ts';

test('saveEntry + listEntries roundtrip (memory backend)', async () => {
  const s = new JournalStore('memory');
  await s.open();
  const e = await s.saveEntry({ title: 'Day one', body: 'Hello', privacy: 'private', date: '2026-11-10' });
  const list = await s.listEntries();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, e.id);
  assert.equal(list[0].body, 'Hello');
});

test('update preserves createdAt but bumps updatedAt', async () => {
  const s = new JournalStore('memory');
  await s.open();
  const e1 = await s.saveEntry({ title: 't', body: 'b', privacy: 'standard', date: '2026-11-10' });
  await new Promise((r) => setTimeout(r, 5));
  const e2 = await s.saveEntry({ ...e1, body: 'updated' });
  assert.equal(e2.createdAt, e1.createdAt);
  assert.ok(e2.updatedAt > e1.updatedAt);
  assert.equal((await s.getEntry(e1.id))?.body, 'updated');
});

test('deleteEntry removes the entry', async () => {
  const s = new JournalStore('memory');
  await s.open();
  const e = await s.saveEntry({ title: '', body: 'x', privacy: 'private', date: '2026-11-10' });
  await s.deleteEntry(e.id);
  assert.equal((await s.listEntries()).length, 0);
});

test('receipts: newest first', async () => {
  const s = new JournalStore('memory');
  await s.open();
  await s.addReceipt({ task: 'entry-analysis', path: 'on-device', reasons: ['r1'], inputChars: 10, mode: 'real' });
  await new Promise((r) => setTimeout(r, 5));
  await s.addReceipt({ task: 'title-suggest', path: 'cloud', reasons: ['r2'], inputChars: 20, mode: 'real' });
  const rs = await s.listReceipts();
  assert.equal(rs.length, 2);
  assert.ok(rs[0].at >= rs[1].at);
});

test('synthesisInput: date range filter, oldest-first order, includes dates+titles', async () => {
  const s = new JournalStore('memory');
  await s.open();
  await s.saveEntry({ title: 'Second', body: 'B', privacy: 'standard', date: '2026-11-12' });
  await s.saveEntry({ title: 'First', body: 'A', privacy: 'standard', date: '2026-11-10' });
  await s.saveEntry({ title: 'Outside', body: 'C', privacy: 'standard', date: '2026-11-20' });
  const entries = await s.listEntries();
  const { text, count } = synthesisInput(entries, '2026-11-09', '2026-11-14');
  assert.equal(count, 2);
  assert.ok(text.indexOf('[2026-11-10] First') < text.indexOf('[2026-11-12] Second'));
  assert.ok(!text.includes('Outside'));
});
