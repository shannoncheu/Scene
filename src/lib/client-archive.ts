import type { ArchiveData } from './archive-data';
import type { WatchEvent, Work } from './archive';

export function indexWatches(events: WatchEvent[]) {
 const index=new Map<string,{count:number;uniqueEpisodes:number;events:WatchEvent[]}>(),episodes=new Map<string,Set<string>>();
 for(const event of events){let entry=index.get(event.workId);if(!entry){entry={count:0,uniqueEpisodes:0,events:[]};index.set(event.workId,entry);episodes.set(event.workId,new Set());}entry.count++;entry.events.push(event);const seen=episodes.get(event.workId)!;seen.add(`${event.season}:${event.episode}`);entry.uniqueEpisodes=seen.size;}
 return index;
}

function reuseEqual<T>(previous:T,next:T):T{return previous===next||JSON.stringify(previous)===JSON.stringify(next)?previous:next;}

export function reconcileArchive(previous:ArchiveData,next:ArchiveData):ArchiveData{
 const merged={...next,events:reuseEqual(previous.events,next.events),works:reuseEqual(previous.works,next.works),owner:reuseEqual(previous.owner,next.owner),sync:reuseEqual(previous.sync,next.sync)};
 const keys=Object.keys(merged) as (keyof ArchiveData)[];
 return keys.length===Object.keys(previous).length&&keys.every(key=>merged[key]===previous[key])?previous:merged;
}

/**
 * Filters timeline watch events while skipping any record whose Work metadata is absent
 * so an inconsistent snapshot can never crash UI rendering or search.
 */
export function filterTimelineEvents(
  yearEvents: WatchEvent[],
  lookup: Map<string, Work>,
  eventDayKeys: Map<string, string>,
  opts: { filter: string; query: string; fromDate: string; toDate: string; historyOrder: string }
): WatchEvent[] {
  const q = opts.query.toLowerCase();
  return yearEvents
    .filter(e => {
      const w = lookup.get(e.workId);
      if (!w) return false;
      const key = eventDayKeys.get(e.id) ?? 'unknown';
      return (
        ((!opts.fromDate && !opts.toDate) ||
          (key !== 'unknown' && (!opts.fromDate || key >= opts.fromDate) && (!opts.toDate || key <= opts.toDate))) &&
        (opts.filter === '全部' || (opts.filter === '电影' ? w.kind === 'movie' : w.kind === 'episode')) &&
        (!q || `${w.title} ${w.originalTitle}`.toLowerCase().includes(q))
      );
    })
    .sort((a, b) =>
      opts.historyOrder === 'asc'
        ? (a.watchedAt ?? '').localeCompare(b.watchedAt ?? '')
        : (b.watchedAt ?? '').localeCompare(a.watchedAt ?? '')
    );
}

/**
 * Filters and sorts distinct poster-wall works safely when any Work entry is missing from lookup.
 */
export function filterPosterEvents(
  recent: WatchEvent[],
  lookup: Map<string, Work>,
  watchIndex: Map<string, { count: number; uniqueEpisodes: number; events: WatchEvent[] }>,
  opts: { libraryKind: 'movie' | 'episode' | null; query: string; sort: string }
): WatchEvent[] {
  const q = opts.query.toLowerCase();
  return recent
    .filter(e => {
      const w = lookup.get(e.workId);
      if (!w) return false;
      return (!opts.libraryKind || w.kind === opts.libraryKind) && (!q || `${w.title} ${w.originalTitle}`.toLowerCase().includes(q));
    })
    .sort((a, b) =>
      opts.sort === 'year'
        ? (lookup.get(b.workId)?.year ?? 0) - (lookup.get(a.workId)?.year ?? 0)
        : opts.sort === 'count'
          ? (watchIndex.get(b.workId)?.count ?? 0) - (watchIndex.get(a.workId)?.count ?? 0)
          : 0
    );
}

export type ManualSyncPhase = 'idle' | 'submitting' | 'submitted' | 'unchanged' | 'complete' | 'failed';

export interface PendingSyncCheck {
  mode: 'latest' | 'full';
  baselineCheckedAt: string | null;
  baselineSuccessfulAt: string | null;
  sawActive: boolean;
}

export interface SyncStatusDisplay {
  active: boolean;
  tone: 'idle' | 'syncing' | 'failed';
  headline: string;
  detail: string;
  buttonLabel: string;
  toast: string;
}

/**
 * Resolves a queued (HTTP 202) manual sync check only after backend state advances beyond
 * the pre-request baseline, preventing stale complete status from reporting false success.
 */
export function evaluatePendingSync(
  pending: PendingSyncCheck,
  latestSync: ArchiveData['sync']
): { done: false; nextPending: PendingSyncCheck; outcome: null } | { done: true; nextPending: null; outcome: 'unchanged' | 'complete' | 'failed' } {
  if (latestSync.status === 'running' || latestSync.status === 'pending') {
    return {
      done: false,
      nextPending: pending.sawActive ? pending : { ...pending, sawActive: true },
      outcome: null,
    };
  }
  const checkedAdvanced = !!latestSync.lastCheckedAt && latestSync.lastCheckedAt !== pending.baselineCheckedAt;
  const successfulAdvanced = !!latestSync.lastSuccessfulAt && latestSync.lastSuccessfulAt !== pending.baselineSuccessfulAt;
  if (!pending.sawActive && !checkedAdvanced && !successfulAdvanced) {
    return { done: false, nextPending: pending, outcome: null };
  }
  if (latestSync.status === 'failed') {
    return { done: true, nextPending: null, outcome: 'failed' };
  }
  if (successfulAdvanced) {
    return { done: true, nextPending: null, outcome: 'complete' };
  }
  return { done: true, nextPending: null, outcome: 'unchanged' };
}

function formatSyncCounts(sync: ArchiveData['sync']) {
  if (sync.expectedCount !== null && sync.expectedCount !== undefined) {
    return `${sync.completedCount} / ${sync.expectedCount}`;
  }
  return sync.completedCount > 0 ? `${sync.completedCount} 条` : '';
}

/**
 * Formats live sync progress and outcome labels consistently across sidebar, actions, and settings.
 */
export function formatSyncDisplay(
  sync: ArchiveData['sync'],
  phase: ManualSyncPhase,
  pending: PendingSyncCheck | null,
  formatDate: (iso: string) => string
): SyncStatusDisplay {
  if (phase === 'submitting') {
    return {
      active: true,
      tone: 'syncing',
      headline: '正在检查 Trakt',
      detail: '正在检查 Trakt',
      buttonLabel: '正在检查 Trakt',
      toast: '正在检查 Trakt',
    };
  }
  if (pending !== null && sync.status !== 'running' && (!pending.sawActive || sync.status !== 'pending')) {
    return {
      active: true,
      tone: 'syncing',
      headline: '正在检查 Trakt',
      detail: '已提交，正在检查 Trakt',
      buttonLabel: '已提交',
      toast: '已提交，正在检查 Trakt',
    };
  }
  if (sync.status === 'running') {
    const counts = formatSyncCounts(sync);
    const isResumed = !!sync.mode?.includes(':resumed');
    const isFull = sync.mode === 'full' || !!sync.mode?.startsWith('full:');
    const base = isResumed ? '正在继续上次同步' : isFull ? '正在完整校对' : '正在同步近期记录';
    const text = counts ? `${base} · ${counts}` : base;
    return {
      active: true,
      tone: 'syncing',
      headline: base,
      detail: text,
      buttonLabel: text,
      toast: '',
    };
  }
  if (sync.status === 'pending') {
    if (sync.mode === 'recent') {
      const manualDetail = sync.pendingManualKind
        ? `${sync.pendingManualKind === 'episode' ? '记录' : '电影'}已添加，正在后台校对近期记录`
        : '准备同步近期记录';
      return {
        active: true,
        tone: 'syncing',
        headline: '正在检查 Trakt',
        detail: manualDetail,
        buttonLabel: '正在同步近期记录',
        toast: '',
      };
    }
    return {
      active: true,
      tone: 'syncing',
      headline: '正在完整校对',
      detail: '准备完整校对全部历史',
      buttonLabel: '正在完整校对',
      toast: '',
    };
  }
  if (sync.status === 'failed') {
    if (sync.errorCode === 'HISTORY_CHANGED') {
      const detail = sync.pendingManualKind
        ? `${sync.pendingManualKind === 'episode' ? '记录' : '电影'}已添加，Trakt 历史正在变化，将自动重试校对`
        : 'Trakt 历史正在变化，将自动重试校对';
      return {
        active: false,
        tone: 'failed',
        headline: '等待自动重试校对',
        detail,
        buttonLabel: '同步最新记录',
        toast: phase === 'failed' ? detail : '',
      };
    }
    const counts = formatSyncCounts(sync);
    const meta = [sync.errorCode, counts].filter(Boolean).join(' · ');
    const detail = meta ? `同步失败，稍后重试 · ${meta}` : '同步失败，稍后重试';
    return {
      active: false,
      tone: 'failed',
      headline: '同步失败，稍后重试',
      detail,
      buttonLabel: '同步最新记录',
      toast: phase === 'failed' ? detail : '',
    };
  }
  if (phase === 'unchanged') {
    return {
      active: false,
      tone: 'idle',
      headline: '已是最新',
      detail: sync.lastCheckedAt ? `已是最新 · ${formatDate(sync.lastCheckedAt)}` : '已是最新',
      buttonLabel: '同步最新记录',
      toast: '已是最新',
    };
  }
  return {
    active: false,
    tone: 'idle',
    headline: '云端已同步',
    detail: sync.lastSuccessfulAt ? `最近 ${formatDate(sync.lastSuccessfulAt)}` : '等待首次完整同步',
    buttonLabel: '同步最新记录',
    toast: phase === 'complete' ? '同步完成' : '',
  };
}
