import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { rotateTicketBuffer, ticketImage } from './server/ticket';
import { createBackup, verifyBackup } from './server/backup';

test('ticketImage auto-crops and deskews a paper ticket on a vignetted orange desk', async () => {
  const width = 600;
  const height = 800;
  const buf = Buffer.alloc(width * height * 3);
  const rad = (5 * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = width / 2;
  const cy = height / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const dx = x - cx;
      const dy = y - cy;
      const rx = dx * cos + dy * sin;
      const ry = -dx * sin + dy * cos;
      const inTicket = Math.abs(rx) <= 105 && Math.abs(ry) <= 185;
      if (inTicket) {
        const isBlueStripe = (ry >= -125 && ry <= -115) || ry <= -178 || ry >= 178;
        if (isBlueStripe) {
          buf[idx] = 28;
          buf[idx + 1] = 108;
          buf[idx + 2] = 188;
        } else {
          buf[idx] = 225;
          buf[idx + 1] = 223;
          buf[idx + 2] = 218;
        }
      } else {
        // Simulated orange desk with strong lighting vignette (bright center, dark corners)
        const dist = Math.hypot(dx, dy) / 500;
        const shade = Math.max(0.45, 1 - dist * 0.55);
        buf[idx] = Math.round(195 * shade);
        buf[idx + 1] = Math.round(68 * shade);
        buf[idx + 2] = Math.round(24 * shade);
      }
    }
  }
  const jpg = await sharp(buf, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
  const { buffer, autoCropped } = await ticketImage(jpg, 'image/jpeg');
  assert.equal(autoCropped, true);

  const outMeta = await sharp(buffer).metadata();
  assert.equal(outMeta.format, 'webp');
  assert.ok((outMeta.width ?? 999) < 260, `expected cropped width < 260, got ${outMeta.width}`);
  assert.ok((outMeta.height ?? 0) >= 340 && (outMeta.height ?? 999) < 420, `expected cropped height in [340, 420), got ${outMeta.height}`);
});

test('ticketImage rejects extreme aspect ratios and backups include TicketStub files', async () => {
  const tall = await sharp({ create: { width: 12, height: 400, channels: 3, background: '#fff' } }).png().toBuffer();
  await assert.rejects(ticketImage(tall, 'image/png'), /FILE_INVALID/);

  const root = mkdtempSync(join(tmpdir(), 'ticket-backup-'));
  const ticketFile = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.webp';
  mkdirSync(join(root, 'tickets'));
  writeFileSync(
    join(root, 'tickets', ticketFile),
    await sharp({ create: { width: 120, height: 180, channels: 3, background: '#eee' } }).webp().toBuffer()
  );
  const live = new DatabaseSync(join(root, 'cinema.db'));
  live.exec(`CREATE TABLE Owner (avatarPath TEXT); CREATE TABLE TicketStub (filePath TEXT); INSERT INTO TicketStub VALUES ('${ticketFile}');`);
  live.close();

  const folder = await createBackup(join(root, 'cinema.db'), root, join(root, 'backups'));
  const manifest = await verifyBackup(folder);
  assert.ok(manifest.hashes[`tickets/${ticketFile}`], 'expected ticket file in backup manifest');
});

test('rotateTicketBuffer is bit-exact lossless across repeated 90-degree rotations and createBackup tolerates missing files', async () => {
  const raw = Buffer.alloc(80 * 120 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 37 + 19) & 0xff;
  const png = await sharp(raw, { raw: { width: 80, height: 120, channels: 3 } }).png().toBuffer();
  const { buffer: initialDisplay, masterBuffer: initialMaster } = await ticketImage(png, 'image/png');
  const origPixels = await sharp(initialMaster).raw().toBuffer();

  let curMaster = initialMaster;
  let curDisplay = initialDisplay;
  for (let i = 0; i < 4; i++) {
    const rotated = await rotateTicketBuffer(curMaster, 90);
    curMaster = rotated.masterBuffer;
    curDisplay = rotated.buffer;
  }
  const after4Pixels = await sharp(curMaster).raw().toBuffer();
  assert.equal(Buffer.compare(origPixels, after4Pixels), 0, 'expected zero pixel drift on master after four 90-degree rotations');
  const displayMeta = await sharp(curDisplay).metadata();
  assert.equal(displayMeta.format, 'webp');
  assert.equal(displayMeta.width, 80);
  assert.equal(displayMeta.height, 120);

  const root = mkdtempSync(join(tmpdir(), 'ticket-missing-backup-'));
  const existingTicket = '11111111-2222-3333-4444-555555555555.webp';
  const existingMaster = '11111111-2222-3333-4444-555555555555.orig.webp';
  const missingTicket = '66666666-7777-8888-9999-000000000000.webp';
  const missingAvatar = '99999999-8888-7777-6666-555555555555.webp';
  mkdirSync(join(root, 'tickets'));
  writeFileSync(join(root, 'tickets', existingTicket), curDisplay);
  writeFileSync(join(root, 'tickets', existingMaster), curMaster);
  const live = new DatabaseSync(join(root, 'cinema.db'));
  live.exec(`
    CREATE TABLE Owner (avatarPath TEXT);
    INSERT INTO Owner VALUES ('${missingAvatar}');
    CREATE TABLE TicketStub (filePath TEXT);
    INSERT INTO TicketStub VALUES ('${existingTicket}');
    INSERT INTO TicketStub VALUES ('${missingTicket}');
  `);
  live.close();

  const folder = await createBackup(join(root, 'cinema.db'), root, join(root, 'backups'));
  const manifest = await verifyBackup(folder);
  assert.ok(manifest.hashes[`tickets/${existingTicket}`]);
  assert.ok(manifest.hashes[`tickets/${existingMaster}`]);
  assert.equal(manifest.hashes[`tickets/${missingTicket}`], undefined);
  assert.equal(manifest.hashes[`avatars/${missingAvatar}`], undefined);
  assert.deepEqual(manifest.missing?.sort(), [`avatars/${missingAvatar}`, `tickets/${missingTicket}`].sort());
});
