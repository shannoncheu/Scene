import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackup, verifyBackup, pruneBackups } from './server/backup';

test('pruneBackups keeps only the newest snapshots and leaves unrelated files alone', async () => {
 const root = mkdtempSync(join(tmpdir(), 'prune-'));
 const names = Array.from({ length: 20 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}T05-30-43-705Z-${(0xa0000000 + i).toString(16)}`);
 for (const name of names) mkdirSync(join(root, name));
 mkdirSync(join(root, '.pending-old'));
 const old = new Date(Date.now() - 3 * 86400000);
 utimesSync(join(root, '.pending-old'), old, old);
 mkdirSync(join(root, '.pending-fresh'));
 writeFileSync(join(root, '.last-success'), 'x');
 writeFileSync(join(root, 'notes.txt'), 'keep');
 const removed = await pruneBackups(root, 14);
 assert.equal(removed.length, 7);
 const left = readdirSync(root).sort();
 assert.deepEqual(left.filter(n => /^2026-/.test(n)), names.slice(6).sort());
 assert.ok(left.includes('.pending-fresh') && !left.includes('.pending-old'));
 assert.ok(left.includes('.last-success') && left.includes('notes.txt'));
});

test('backups of a WAL-mode live database are self-contained and verifiable', async () => {
 const root = mkdtempSync(join(tmpdir(), 'walbackup-'));
 const live = new DatabaseSync(join(root, 'cinema.db'));
 live.exec('PRAGMA journal_mode=WAL; CREATE TABLE Owner (avatarPath TEXT); CREATE TABLE T (v INTEGER);');
 for (let i = 0; i < 50; i++) live.exec(`INSERT INTO T VALUES (${i})`);
 try {
  const folder = await createBackup(join(root, 'cinema.db'), root, join(root, 'backups'));
  await verifyBackup(folder);
  const snapshot = new DatabaseSync(join(folder, 'cinema.db'), { readOnly: true });
  try {
   assert.equal((snapshot.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'delete');
   assert.equal((snapshot.prepare('SELECT COUNT(*) AS n FROM T').get() as { n: number }).n, 50);
  } finally { snapshot.close(); }
  assert.deepEqual(readdirSync(folder).sort(), ['avatars', 'cinema.db', 'manifest.json']);
 } finally { live.close(); }
});

test('pruneBackups preserves one monthly snapshot for older months outside the daily keep window', async () => {
 const root = mkdtempSync(join(tmpdir(), 'prune-monthly-'));
 const oct = Array.from({ length: 16 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}T05-30-00-000Z-${(0xb0000000 + i).toString(16)}`);
 const sep = ['2026-09-10T05-30-00-000Z-a1111111', '2026-09-28T05-30-00-000Z-a2222222'];
 const aug = ['2026-08-31T05-30-00-000Z-a3333333'];
 for (const name of [...aug, ...sep, ...oct]) mkdirSync(join(root, name));
 const removed = await pruneBackups(root, 14);
 assert.equal(removed.length, 3);
 const left = readdirSync(root).sort();
 assert.ok(left.includes('2026-09-28T05-30-00-000Z-a2222222'), 'keeps newest Sep snapshot');
 assert.ok(!left.includes('2026-09-10T05-30-00-000Z-a1111111'), 'prunes older Sep snapshot');
 assert.ok(left.includes('2026-08-31T05-30-00-000Z-a3333333'), 'keeps Aug snapshot');
});
