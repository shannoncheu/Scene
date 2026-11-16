import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { ArchiveData } from '../archive-data';
import { db } from './db';
import { posterUrl, avatarVersion } from './config';
import { SYNC_STATE_SELECT, pendingManualKindForSync, serializeSyncState } from './sync';
import { ensureTicketTable } from './ticket';

async function computeEtag(tx: Prisma.TransactionClient, ownerId: string, csrf: string) {
  const [owner, eventAgg, mediaAgg, sync, ticketAgg, editAgg] = await Promise.all([
    tx.owner.findUniqueOrThrow({ where: { id: ownerId }, select: { timezone: true, avatarPath: true, updatedAt: true } }),
    tx.watchEvent.aggregate({ where: { ownerId }, _count: { _all: true }, _max: { importedAt: true, watchedAt: true } }),
    tx.media.aggregate({
      where: { OR: [{ events: { some: { ownerId } } }, { ticketStubs: { some: { ownerId } } }] },
      _count: { _all: true },
      _max: { metadataAt: true },
    }),
    tx.syncState.findUnique({
      where: { ownerId },
      select: { ...SYNC_STATE_SELECT, metadataCursor: true },
    }),
    tx.ticketStub.aggregate({ where: { ownerId }, _count: { _all: true }, _max: { updatedAt: true } }),
    tx.historyDateEdit.aggregate({ where: { ownerId }, _count: { _all: true }, _max: { updatedAt: true } }),
  ]);
  const manualKind = await pendingManualKindForSync(tx, ownerId, sync?.lastSuccessfulAt);
  const fp = JSON.stringify([
    csrf,
    owner.timezone,
    owner.avatarPath,
    owner.updatedAt.getTime(),
    eventAgg._count._all,
    eventAgg._max.importedAt?.getTime() ?? 0,
    eventAgg._max.watchedAt?.getTime() ?? 0,
    mediaAgg._count._all,
    mediaAgg._max.metadataAt?.getTime() ?? 0,
    sync?.status ?? 'pending',
    sync?.mode ?? '',
    sync?.completedPage ?? 0,
    sync?.completedCount ?? 0,
    sync?.expectedCount ?? null,
    sync?.lastCheckedAt?.getTime() ?? 0,
    sync?.lastSuccessfulAt?.getTime() ?? 0,
    sync?.lastReconciledAt?.getTime() ?? 0,
    sync?.errorCode ?? '',
    sync?.retryAt?.getTime() ?? 0,
    sync?.metadataCursor ?? '',
    manualKind ?? '',
    ticketAgg._count._all,
    ticketAgg._max.updatedAt?.getTime() ?? 0,
    editAgg._count._all,
    editAgg._max.updatedAt?.getTime() ?? 0,
  ]);
  return `"${createHash('sha1').update(fp).digest('base64url')}"`;
}

export async function archiveEtag(ownerId: string, csrf: string) {
  await ensureTicketTable();
  return db.$transaction(tx => computeEtag(tx, ownerId, csrf));
}

/**
 * Loads the complete archive payload and matching ETag within a single database
 * snapshot transaction so events, works, tickets, and sync status cannot tear across concurrent syncs.
 */
export async function loadArchiveSnapshot(ownerId: string, csrf: string): Promise<{ data: ArchiveData; etag: string }> {
  await ensureTicketTable();
  return db.$transaction(async tx => {
    const [owner, events, media, sync, tickets, etag] = await Promise.all([
      tx.owner.findUniqueOrThrow({ where: { id: ownerId }, select: { username: true, timezone: true, avatarPath: true } }),
      tx.watchEvent.findMany({
        where: { ownerId },
        orderBy: [{ watchedAt: 'desc' }, { id: 'desc' }],
        select: { id: true, mediaId: true, watchedAt: true, episode: { select: { season: true, number: true, runtime: true } } },
      }),
      tx.media.findMany({
        where: { OR: [{ events: { some: { ownerId } } }, { ticketStubs: { some: { ownerId } } }] },
        select: { id: true, chineseTitle: true, originalTitle: true, year: true, kind: true, posterPath: true, runtime: true, rating: true, description: true, airedEpisodes: true },
      }),
      tx.syncState.findUnique({
        where: { ownerId },
        select: SYNC_STATE_SELECT,
      }),
      tx.ticketStub.findMany({ where: { ownerId }, select: { mediaId: true, filePath: true } }),
      computeEtag(tx, ownerId, csrf),
    ]);
    const manualKind = await pendingManualKindForSync(tx, ownerId, sync?.lastSuccessfulAt);
    const ticketMap = new Map(tickets.map(t => [t.mediaId, `/api/ticket?id=${encodeURIComponent(t.mediaId)}&v=${t.filePath.slice(0, 8)}`]));
    return {
      etag,
      data: {
        owner: { username: owner.username, timezone: owner.timezone, hasAvatar: !!owner.avatarPath, avatarVersion: avatarVersion(owner.avatarPath) },
        csrf,
        events: events.map(e => ({
          id: e.id,
          workId: e.mediaId,
          watchedAt: e.watchedAt?.toISOString() ?? null,
          season: e.episode?.season,
          episode: e.episode?.number,
          runtime: e.episode?.runtime,
        })),
        works: media.map(m => ({
          id: m.id,
          title: m.chineseTitle || m.originalTitle,
          originalTitle: m.originalTitle,
          year: m.year,
          kind: m.kind === 'movie' ? 'movie' : 'episode',
          poster: posterUrl(m.id, m.posterPath),
          runtime: m.runtime,
          rating: m.rating,
          description: m.description || '暂无作品简介',
          airedEpisodes: m.airedEpisodes,
          ticketStub: ticketMap.get(m.id) ?? null,
        })),
        sync: serializeSyncState(sync, manualKind),
      },
    };
  });
}

export async function loadArchive(ownerId: string, csrf: string): Promise<ArchiveData> {
  return (await loadArchiveSnapshot(ownerId, csrf)).data;
}
