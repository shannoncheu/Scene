import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/server/db';
import { apiFailure, requireSession, checkMutation, privateJson } from '@/lib/server/session';
import { atomicFile, boundedBody, dataDir } from '@/lib/server/files';
import { ensureTicketTable, rotateTicketBuffer, ticketImage, ticketMasterName } from '@/lib/server/ticket';
import { IMMUTABLE_PRIVATE, REVALIDATE_PRIVATE } from '@/lib/server/config';

export const runtime = 'nodejs';
const validFile = (s: string) => /^[a-f0-9-]{36}\.webp$/.test(s);
const validMediaId = (s: string) => /^movie:[0-9]+$/.test(s);

const isEnoent = (err: unknown) => !!err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT';

// Per-movie mutex so rapid clicks on "旋转 90°", upload, or delete serialize cleanly without dropping rotations.
const ticketLocks = ((globalThis as unknown as { cinemaTicketLocks?: Map<string, Promise<void>> }).cinemaTicketLocks ??= new Map());
async function withTicketLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = ticketLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(resolve => { release = resolve; });
  const tail = prev.then(() => next, () => next);
  ticketLocks.set(key, tail);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (ticketLocks.get(key) === tail) ticketLocks.delete(key);
  }
}

export async function GET(request: Request) {
  try {
    const { ownerId } = await requireSession(request);
    await ensureTicketTable();
    const url = new URL(request.url);
    const id = url.searchParams.get('id') || '';
    if (!validMediaId(id)) return new Response(null, { status: 404 });
    const row = await db.ticketStub.findUnique({
      where: { ownerId_mediaId: { ownerId, mediaId: id } },
      select: { filePath: true },
    });
    if (!row || !validFile(row.filePath)) return new Response(null, { status: 404 });
    const v = url.searchParams.get('v') || '';
    const cache = v && v === row.filePath.slice(0, 8) ? IMMUTABLE_PRIVATE : REVALIDATE_PRIVATE;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(dataDir(), 'tickets', row.filePath)));
    } catch (err) {
      if (isEnoent(err)) return new Response(null, { status: 404 });
      throw err;
    }
    return new Response(bytes as BodyInit, {
      headers: {
        'Content-Type': 'image/webp',
        'Cache-Control': cache,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return apiFailure(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    checkMutation(request, session);
    await ensureTicketTable();
    const url = new URL(request.url);
    const id = url.searchParams.get('id') || '';
    if (!validMediaId(id)) return privateJson({ error: 'ITEM_NOT_FOUND' }, 404);

    const media = await db.media.findUnique({ where: { id }, select: { id: true, kind: true } });
    if (!media || media.kind !== 'movie') return privateJson({ error: 'ITEM_NOT_FOUND' }, 404);

    const rotateParam = url.searchParams.get('rotate');
    let uploadedProcessed: { buffer: Buffer; masterBuffer: Buffer; autoCropped: boolean } | null = null;
    if (rotateParam !== '90' && rotateParam !== '-90' && rotateParam !== '180') {
      const body = await boundedBody(request, 10 * 1024 * 1024);
      const mime = request.headers.get('content-type') || '';
      uploadedProcessed = await ticketImage(body, mime);
    }

    return await withTicketLock(`${session.ownerId}:${id}`, async () => {
      const writtenFiles: string[] = [];
      try {
        let buffer: Buffer;
        let masterBuffer: Buffer;
        let autoCropped = false;
        if (rotateParam === '90' || rotateParam === '-90' || rotateParam === '180') {
          const existing = await db.ticketStub.findUnique({
            where: { ownerId_mediaId: { ownerId: session.ownerId, mediaId: id } },
            select: { filePath: true },
          });
          if (!existing || !validFile(existing.filePath)) return privateJson({ error: 'ITEM_NOT_FOUND' }, 404);
          let sourceBytes: Buffer;
          try {
            sourceBytes = await readFile(join(dataDir(), 'tickets', ticketMasterName(existing.filePath)));
          } catch (err) {
            if (!isEnoent(err)) throw err;
            try {
              sourceBytes = await readFile(join(dataDir(), 'tickets', existing.filePath));
            } catch (fallbackErr) {
              if (isEnoent(fallbackErr)) return privateJson({ error: 'ITEM_NOT_FOUND' }, 404);
              throw fallbackErr;
            }
          }
          const rotated = await rotateTicketBuffer(sourceBytes, Number(rotateParam) as 90 | -90 | 180);
          buffer = rotated.buffer;
          masterBuffer = rotated.masterBuffer;
        } else {
          buffer = uploadedProcessed!.buffer;
          masterBuffer = uploadedProcessed!.masterBuffer;
          autoCropped = uploadedProcessed!.autoCropped;
        }

        const name = `${randomUUID()}.webp`;
        const masterName = ticketMasterName(name);
        await atomicFile('tickets', masterName, masterBuffer);
        writtenFiles.push(masterName);
        await atomicFile('tickets', name, buffer);
        writtenFiles.push(name);

        const previousPath = await db.$transaction(async tx => {
          const prev = await tx.ticketStub.findUnique({
            where: { ownerId_mediaId: { ownerId: session.ownerId, mediaId: id } },
            select: { filePath: true },
          });
          await tx.ticketStub.upsert({
            where: { ownerId_mediaId: { ownerId: session.ownerId, mediaId: id } },
            create: { ownerId: session.ownerId, mediaId: id, filePath: name },
            update: { filePath: name },
          });
          return prev?.filePath ?? null;
        });
        writtenFiles.length = 0;

        if (previousPath && validFile(previousPath) && previousPath !== name) {
          await unlink(join(dataDir(), 'tickets', previousPath)).catch(() => {});
          await unlink(join(dataDir(), 'tickets', ticketMasterName(previousPath))).catch(() => {});
        }

        return privateJson({
          ok: true,
          autoCropped,
          ticketStub: `/api/ticket?id=${encodeURIComponent(id)}&v=${name.slice(0, 8)}`,
        });
      } catch (innerError) {
        for (const f of writtenFiles) {
          await unlink(join(dataDir(), 'tickets', f)).catch(() => {});
        }
        throw innerError;
      }
    });
  } catch (error) {
    return apiFailure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await requireSession(request);
    checkMutation(request, session);
    await ensureTicketTable();
    const id = new URL(request.url).searchParams.get('id') || '';
    if (!validMediaId(id)) return privateJson({ error: 'ITEM_NOT_FOUND' }, 404);

    return await withTicketLock(`${session.ownerId}:${id}`, async () => {
      const existing = await db.ticketStub.findUnique({
        where: { ownerId_mediaId: { ownerId: session.ownerId, mediaId: id } },
        select: { filePath: true },
      });
      if (existing) {
        await db.ticketStub.delete({ where: { ownerId_mediaId: { ownerId: session.ownerId, mediaId: id } } });
        if (validFile(existing.filePath)) {
          await unlink(join(dataDir(), 'tickets', existing.filePath)).catch(() => {});
          await unlink(join(dataDir(), 'tickets', ticketMasterName(existing.filePath))).catch(() => {});
        }
      }
      return privateJson({ ok: true });
    });
  } catch (error) {
    return apiFailure(error);
  }
}
