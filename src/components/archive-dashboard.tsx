'use client';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Film,
  Home,
  LogOut,
  Menu,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Ticket,
  Tv,
  X,
} from 'lucide-react';
import { calendarDays, dateKey, duration, monthBuckets, summarize, type WatchEvent, type Work } from '@/lib/archive';
import type { ArchiveData } from '@/lib/archive-data';
import {
  evaluatePendingSync,
  filterPosterEvents,
  filterTimelineEvents,
  formatSyncDisplay,
  indexWatches,
  reconcileArchive,
  type ManualSyncPhase,
  type PendingSyncCheck,
} from '@/lib/client-archive';
import { withFetchTimeout } from '@/lib/client-fetch';
import { AvatarEditor } from './avatar-editor';
import { AddHistoryDialog } from './add-history-dialog';
import { DatePickerButton } from './date-picker-button';
import { Dialog } from './dialog';
import { HistoryDateDialog } from './history-date-dialog';
import { TicketUploader } from './ticket-uploader';

const navigation = [
  { label: '首页', icon: Home },
  { label: '观影历史', icon: Clock3 },
  { label: '电影', icon: Film },
  { label: '剧集', icon: Tv },
  { label: '影院票根', icon: Ticket },
  { label: '统计', icon: ChartNoAxesCombined },
];

const pageCopy: Record<string, { title: string; subtitle: string }> = {
  观影历史: { title: '观影历史', subtitle: '按观看时间浏览记录，支持类型筛选与年份切换。' },
  电影: { title: '电影库', subtitle: '浏览看过的电影，按年份、观看次数或最近观看排序。' },
  剧集: { title: '剧集库', subtitle: '浏览看过的剧集，查看追剧进度与单集足迹。' },
  影院票根: { title: '影院票根', subtitle: '单独收录上传过影院票根的电影，留住每一次大银幕记忆。' },
  统计: { title: '观影统计', subtitle: '查看年度热力图、观看趋势、内容占比与估算时长。' },
  搜索: { title: '搜索结果', subtitle: '使用中文或英文名称查找观影记录。' },
};

const monthNames = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);

function readableDate(key: string) {
  return `${Number(key.slice(0, 4))}年${Number(key.slice(5, 7))}月${Number(key.slice(8, 10))}日`;
}

const uiFormatters = new Map<string, Intl.DateTimeFormat>();
function uiFormatter(timeZone: string, kind: 'time' | 'weekday') {
  const key = timeZone + ':' + kind;
  let formatter = uiFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(
      'zh-CN',
      kind === 'time' ? { timeZone, hour: '2-digit', minute: '2-digit', hour12: false } : { timeZone, weekday: 'long' }
    );
    if (uiFormatters.size >= 16) uiFormatters.delete(uiFormatters.keys().next().value!);
    uiFormatters.set(key, formatter);
  }
  return formatter;
}

function formattedTime(iso: string | null, timeZone: string) {
  if (!iso) return '时间未知';
  return uiFormatter(timeZone, 'time').format(new Date(iso));
}

function shortDate(iso: string | null, timeZone: string) {
  if (!iso) return '日期未知';
  const k = dateKey(iso, timeZone);
  if (k === 'unknown') return '日期未知';
  return `${Number(k.slice(5, 7))}月${Number(k.slice(8, 10))}日 ${formattedTime(iso, timeZone)}`;
}

function shortDay(iso: string | null, tz: string, refYear: number) {
  if (!iso) return '日期未知';
  const k = dateKey(iso, tz);
  if (k === 'unknown') return '日期未知';
  const y = Number(k.slice(0, 4));
  const m = Number(k.slice(5, 7));
  const d = Number(k.slice(8, 10));
  return y === refYear ? `${m}月${d}日` : `${y}年${m}月${d}日`;
}

function greetingFor(tz: string) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date())) % 24;
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function computeShowProgress(
  work: Work,
  entry?: { count: number; uniqueEpisodes: number; events: WatchEvent[] }
) {
  const watched = entry?.uniqueEpisodes ?? 0;
  const aired = work.airedEpisodes && work.airedEpisodes > 0 ? work.airedEpisodes : null;
  const total = aired !== null ? Math.max(aired, watched) : null;
  const unwatched = aired !== null && watched < aired ? aired - watched : 0;
  const percent = total
    ? unwatched > 0
      ? Math.min(96, Math.max(4, Math.round((watched / total) * 100)))
      : 100
    : watched > 0
      ? 100
      : 0;
  return {
    watched,
    aired,
    total,
    unwatched,
    percent,
    latest: entry?.events[0] ?? null,
    count: entry?.count ?? 0,
  };
}

export function ArchiveDashboard({ initialData }: { initialData: ArchiveData }) {
  const [data, setData] = useState(initialData);
  const [actionStatus, setActionStatus] = useState('');
  const [manualSyncPhase, setManualSyncPhase] = useState<ManualSyncPhase>('idle');
  const [pendingSync, setPendingSync] = useState<PendingSyncCheck | null>(null);
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [addHistory, setAddHistory] = useState(false);
  const [dateEditOpen, setDateEditOpen] = useState(false);
  const [dateEditEvent, setDateEditEvent] = useState<WatchEvent | null>(null);
  const [section, setSection] = useState('首页');
  const [timeZone, setTimeZone] = useState(initialData.owner.timezone);
  const [year, setYear] = useState<number | 'all'>(() =>
    Number(dateKey(new Date().toISOString(), initialData.owner.timezone).slice(0, 4))
  );
  const [filter, setFilter] = useState('全部');
  const [query, setQuery] = useState('');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedWork, setSelectedWork] = useState<Work | null>(null);
  const [settings, setSettings] = useState(false);
  const [notice, setNotice] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [limit, setLimit] = useState(12);
  const [sort, setSort] = useState('recent');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [historyOrder, setHistoryOrder] = useState('desc');

  const { events, works } = data;
  const latestRefresh = useRef(0);
  const archiveEtag = useRef(initialData.etag || '');
  const syncPollTicks = useRef(0);
  const pollInFlight = useRef(false);
  const pendingSyncRef = useRef<PendingSyncCheck | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  function updatePendingSync(next: PendingSyncCheck | null) {
    pendingSyncRef.current = next;
    setPendingSync(next);
  }
  const lookup = useMemo(() => new Map(works.map(w => [w.id, w])), [works]);

  const [nowIso, setNowIso] = useState(() => new Date().toISOString());
  const todayKey = dateKey(nowIso, timeZone);
  const currentYear = Number(todayKey.slice(0, 4));
  const currentMonth = Number(todayKey.slice(5, 7)) - 1;

  useEffect(() => {
    const tick = () => setNowIso(new Date().toISOString());
    const timer = setInterval(tick, 60000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);

  useEffect(() => {
    if (!mobileNav) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileNav(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileNav]);

  async function refreshData() {
    const requestId = ++latestRefresh.current;
    await withFetchTimeout(
      '/api/archive',
      async response => {
        if (requestId !== latestRefresh.current) return;
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        if (response.status === 304) return;
        if (response.ok) {
          const next: ArchiveData = await response.json();
          if (requestId === latestRefresh.current) {
            archiveEtag.current = response.headers.get('ETag') || '';
            setData(previous => reconcileArchive(previous, next));
          }
        }
      },
      {
        cache: 'no-store',
        headers: archiveEtag.current ? { 'If-None-Match': archiveEtag.current } : {},
      }
    );
  }

  async function pollSyncStatus(periodicRefresh = false) {
    let sync: ArchiveData['sync'] | null = null;
    await withFetchTimeout(
      '/api/sync',
      async response => {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        if (!response.ok) return;
        sync = ((await response.json()) as { sync: ArchiveData['sync'] }).sync;
      },
      { cache: 'no-store' }
    );
    if (!sync) return;
    const latestSync: ArchiveData['sync'] = sync;
    setData(previous => (JSON.stringify(previous.sync) === JSON.stringify(latestSync) ? previous : { ...previous, sync: latestSync }));
    const pending = pendingSyncRef.current;
    if (pending) {
      const evaluated = evaluatePendingSync(pending, latestSync);
      if (!evaluated.done) {
        if (evaluated.nextPending !== pending) updatePendingSync(evaluated.nextPending);
        if (periodicRefresh && latestSync.status === 'running') await refreshData();
        return;
      }
      updatePendingSync(null);
      setManualSyncPhase(evaluated.outcome);
      await refreshData();
      return;
    }
    if (latestSync.status !== 'running' && latestSync.status !== 'pending') {
      await refreshData();
      return;
    }
    if (periodicRefresh) {
      await refreshData();
    }
  }

  // While syncing, poll the tiny sync-status endpoint every 3s (and refresh archive every ~30s via ETag so newly imported
  // pages appear progressively during long syncs); when idle, poll /api/archive every 60s with ETag.
  const syncActive =
    manualSyncPhase === 'submitting' ||
    pendingSync !== null ||
    data.sync.status === 'running' ||
    data.sync.status === 'pending';
  useEffect(() => {
    syncPollTicks.current = 0;
    const checkNow = () => {
      if (document.hidden || pollInFlight.current) return;
      pollInFlight.current = true;
      const run = syncActive
        ? (() => {
            syncPollTicks.current += 1;
            return pollSyncStatus(syncPollTicks.current % 10 === 0);
          })()
        : refreshData();
      void run.catch(() => {}).finally(() => {
        pollInFlight.current = false;
      });
    };
    const initialCheck = syncActive ? setTimeout(checkNow, 450) : null;
    const timer = setInterval(checkNow, syncActive ? 3000 : 60000);
    document.addEventListener('visibilitychange', checkNow);
    return () => {
      if (initialCheck) clearTimeout(initialCheck);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', checkNow);
    };
  }, [syncActive]);

  useEffect(() => {
    if (!actionStatus) return;
    const timer = setTimeout(() => setActionStatus(''), 6000);
    return () => clearTimeout(timer);
  }, [actionStatus]);

  useEffect(() => {
    if (manualSyncPhase !== 'unchanged' && manualSyncPhase !== 'complete' && manualSyncPhase !== 'failed') return;
    const timer = setTimeout(() => setManualSyncPhase('idle'), 6000);
    return () => clearTimeout(timer);
  }, [manualSyncPhase]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  async function mutate(path: string, body?: unknown) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': data.csrf },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401) {
      window.location.href = '/login';
      throw Error('请重新登录');
    }
    if (!response.ok) throw Error('操作未完成，请稍后重试或检查授权状态');
    return response;
  }

  async function syncNow(mode: 'latest' | 'full' = 'latest') {
    if (manualSyncPhase === 'submitting' || pendingSyncRef.current) return;
    setActionStatus('');
    setManualSyncPhase('submitting');
    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': data.csrf },
        body: JSON.stringify({ mode }),
      });
      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }
      let payload: { error?: string; sync?: ArchiveData['sync'] } = {};
      try {
        payload = (await response.json()) as { error?: string; sync?: ArchiveData['sync'] };
      } catch {
        // Ignore non-JSON error payloads and fall back to status-based error reporting.
      }
      if (payload.sync) {
        setData(previous => ({ ...previous, sync: payload.sync! }));
      }
      if (!response.ok) {
        updatePendingSync(null);
        if (response.status === 409 && payload.error === 'DATE_EDIT_BUSY') {
          setManualSyncPhase('idle');
          setActionStatus('已有日期修改任务进行中，请先查看处理进度');
          return;
        }
        setManualSyncPhase('failed');
        if (!payload.sync) {
          void pollSyncStatus().catch(() => {});
        }
        return;
      }
      const baseline = payload.sync ?? data.sync;
      updatePendingSync({
        mode,
        baselineCheckedAt: baseline.lastCheckedAt,
        baselineSuccessfulAt: baseline.lastSuccessfulAt,
        sawActive: baseline.status === 'running' || baseline.status === 'pending',
      });
      setManualSyncPhase('submitted');
    } catch {
      updatePendingSync(null);
      setManualSyncPhase('failed');
    }
  }

  async function signOut(revoke = false) {
    try {
      await mutate(revoke ? '/api/auth/revoke' : '/api/auth/logout');
      window.location.href = '/login';
    } catch {
      setActionStatus('退出或撤销失败，请稍后重试');
    }
  }

  async function saveTimezone(value: string) {
    try {
      await mutate('/api/settings', { timezone: value });
      setTimeZone(value);
      await refreshData();
    } catch {
      setActionStatus('时区保存失败');
    }
  }

  const avatar = data.owner.hasAvatar ? (
    <img
      decoding="async"
      className="avatar"
      src={`/api/avatar?v=${data.owner.avatarVersion ?? '0'}-${avatarVersion}`}
      width={34}
      height={34}
      alt="自定义头像"
    />
  ) : (
    <span className="avatar">{data.owner.username.slice(0, 1).toUpperCase()}</span>
  );

  const eventDayKeys = useMemo(() => new Map(events.map(e => [e.id, dateKey(e.watchedAt, timeZone)])), [events, timeZone]);
  const deferredQuery = useDeferredValue(query);

  const annualCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const event of events) {
      const key = eventDayKeys.get(event.id) ?? 'unknown';
      if (key === 'unknown') continue;
      const y = Number(key.slice(0, 4));
      counts.set(y, (counts.get(y) ?? 0) + 1);
    }
    return counts;
  }, [events, eventDayKeys]);

  const years = useMemo(() => [...new Set([currentYear, ...annualCounts.keys()])].sort((a, b) => b - a), [annualCounts, currentYear]);
  const maxAnnual = useMemo(() => Math.max(1, ...annualCounts.values()), [annualCounts]);
  const allStats = useMemo(() => summarize(events, works, timeZone, eventDayKeys), [events, works, timeZone, eventDayKeys]);
  const yearEvents = useMemo(
    () => events.filter(e => year === 'all' || (eventDayKeys.get(e.id) ?? 'unknown').startsWith(`${year}-`)),
    [events, year, eventDayKeys]
  );
  const stats = useMemo(() => summarize(yearEvents, works, timeZone, eventDayKeys), [yearEvents, works, timeZone, eventDayKeys]);
  const monthly = useMemo(() => monthBuckets(events, year === 'all' ? currentYear : year, timeZone, eventDayKeys), [events, year, currentYear, timeZone, eventDayKeys]);

  const thisYearMonthly = useMemo(() => monthBuckets(events, currentYear, timeZone, eventDayKeys), [events, currentYear, timeZone, eventDayKeys]);
  const prevYearMonthly = useMemo(() => monthBuckets(events, currentYear - 1, timeZone, eventDayKeys), [events, currentYear, timeZone, eventDayKeys]);
  const thisMonthCount = thisYearMonthly[currentMonth] ?? 0;
  const lastMonthCount = currentMonth > 0 ? thisYearMonthly[currentMonth - 1] : prevYearMonthly[11];
  const monthDelta = thisMonthCount - lastMonthCount;
  const monthDeltaText = monthDelta > 0 ? `较上月 +${monthDelta}` : monthDelta < 0 ? `较上月 ${monthDelta}` : '与上月持平';
  const thisYearStats = useMemo(
    () => summarize(events.filter(e => (eventDayKeys.get(e.id) ?? 'unknown').startsWith(`${currentYear}-`)), works, timeZone, eventDayKeys),
    [events, works, currentYear, timeZone, eventDayKeys]
  );

  const visibleEvents = useMemo(
    () =>
      filterTimelineEvents(yearEvents, lookup, eventDayKeys, {
        filter,
        query: deferredQuery,
        fromDate,
        toDate,
        historyOrder,
      }),
    [yearEvents, filter, deferredQuery, lookup, eventDayKeys, fromDate, toDate, historyOrder]
  );

  const recent = useMemo(() => {
    const ids = new Set<string>();
    return events.filter(e => {
      if (ids.has(e.workId)) return false;
      ids.add(e.workId);
      return true;
    });
  }, [events]);

  const go = (label: string) => {
    setSection(label);
    setYear(currentYear);
    setMobileNav(false);
    setQuery('');
    setFilter('全部');
    setFromDate('');
    setToDate('');
    setHistoryOrder('desc');
    setLimit(12);
  };

  const isHome = section === '首页';
  const isLibrary = section === '电影' || section === '剧集';
  const watchIndex = useMemo(() => indexWatches(events), [events]);
  const activeSelectedWork = selectedWork ? lookup.get(selectedWork.id) ?? selectedWork : null;
  const workEvents = activeSelectedWork ? watchIndex.get(activeSelectedWork.id)?.events ?? [] : [];
  const selectedWorkProgress =
    activeSelectedWork && activeSelectedWork.kind === 'episode'
      ? computeShowProgress(activeSelectedWork, watchIndex.get(activeSelectedWork.id))
      : null;
  const ticketMovies = useMemo(() => {
    const withStub: { work: Work; latest: string | null; count: number }[] = [];
    for (const w of works) {
      if (w.kind !== 'movie' || !w.ticketStub) continue;
      const entry = watchIndex.get(w.id);
      withStub.push({ work: w, latest: entry?.events[0]?.watchedAt ?? null, count: entry?.count ?? 0 });
    }
    return withStub.sort((a, b) => (b.latest || '').localeCompare(a.latest || ''));
  }, [works, watchIndex]);

  const trackedShows = useMemo(
    () =>
      works
        .filter(w => w.kind === 'episode')
        .map(work => ({ work, ...computeShowProgress(work, watchIndex.get(work.id)) }))
        .sort((a, b) => (b.latest?.watchedAt ?? '').localeCompare(a.latest?.watchedAt ?? '')),
    [works, watchIndex]
  );

  const posterEvents = useMemo(() => {
    if (!isHome && !isLibrary && section !== '搜索') return [];
    return filterPosterEvents(recent, lookup, watchIndex, {
      libraryKind: isLibrary ? (section === '电影' ? 'movie' : 'episode') : null,
      query: deferredQuery,
      sort,
    });
  }, [recent, isHome, isLibrary, section, deferredQuery, lookup, sort, watchIndex]);

  const syncDisplay = formatSyncDisplay(data.sync, manualSyncPhase, pendingSync, iso => shortDate(iso, timeZone));
  const syncDescription = syncDisplay.detail + (actionStatus ? ` · ${actionStatus}` : '');
  const visibleToast = actionStatus || syncDisplay.toast;

  const dayEvents = selectedDay ? allStats.days.get(selectedDay)?.events ?? [] : [];
  const maxMonthly = Math.max(...monthly, 1);
  const moviePercent = stats.total ? Math.round((stats.movieEvents / stats.total) * 100) : 0;

  const statCards = [
    {
      label: '累计观看记录',
      value: allStats.total,
      unit: '次',
      sub: `本月 ${thisMonthCount} 次`,
      icon: Play,
      caption: `${monthDeltaText} · 剧集 ${allStats.episodeEvents} 集次 · 电影 ${allStats.movieEvents} 次`,
      color: 'blue',
    },
    {
      label: '在追与已看剧集',
      value: allStats.shows,
      unit: '部',
      sub: `共 ${allStats.uniqueEpisodes} 集`,
      icon: Tv,
      caption: `${currentYear} 年观看 ${thisYearStats.episodeEvents} 集次`,
      color: 'cyan',
    },
    {
      label: '已观看电影',
      value: allStats.movies,
      unit: '部',
      sub: `${allStats.movieEvents} 次`,
      icon: Film,
      caption: `按作品去重 · ${currentYear} 年观看 ${thisYearStats.movieEvents} 次`,
      color: 'lavender',
    },
    {
      label: '活跃观影天数',
      value: allStats.activeDays,
      unit: '天',
      sub: `约 ${Math.floor(allStats.minutes / 60).toLocaleString('zh-CN')} 小时`,
      icon: CalendarDays,
      caption: `${currentYear} 年活跃 ${thisYearStats.activeDays} 天`,
      color: 'mint',
    },
  ];

  function eventRows(list: WatchEvent[], showYear = false) {
    let last = '';
    return list.map(event => {
      const w = lookup.get(event.workId);
      if (!w) return null;
      const key = dateKey(event.watchedAt, timeZone);
      const heading = last !== key;
      last = key;
      return (
        <div key={event.id}>
          {heading && (
            <div className="timeline-date">
              {key === 'unknown' ? '日期未知' : showYear ? readableDate(key) : `${Number(key.slice(5, 7))}月${Number(key.slice(8, 10))}日`}{' '}
              <span>{event.watchedAt ? uiFormatter(timeZone, 'weekday').format(new Date(event.watchedAt)) : '时间未提供'}</span>
              <span className="date-rule" />
            </div>
          )}
          <div className="timeline-item">
            <button className="timeline-row" onClick={() => setSelectedWork(w)}>
              <time>{formattedTime(event.watchedAt, timeZone)}</time>
              <span className="timeline-dot" />
              <img decoding="async" src={w.poster} width={42} height={58} alt={`${w.title}海报`} loading="lazy" />
              <span className="event-info">
                <strong>{w.title}</strong>
                <span>
                  {w.kind === 'movie'
                    ? `${w.year ?? '年份未知'} · 电影`
                    : `S${String(event.season ?? 1).padStart(2, '0')} E${String(event.episode ?? 1).padStart(2, '0')} · 剧集`}
                </span>
              </span>
              <span className="event-rating">{w.rating === null ? '暂无评分' : `★ ${w.rating.toFixed(1)}`}</span>
              <ChevronRight size={16} />
            </button>
            <button
              className="edit-date-button"
              aria-label="修改观看日期"
              title="修改观看日期"
              onClick={() => {
                setDateEditEvent(event);
                setSelectedWork(null);
                setSelectedDay(null);
                setDateEditOpen(true);
              }}
            >
              <CalendarDays size={16} />
            </button>
          </div>
        </div>
      );
    });
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'is-open' : ''}`}>
        <a
          href="#"
          className="brand"
          onClick={e => {
            e.preventDefault();
            go('首页');
          }}
        >
          <img decoding="async" src="/logo-bird.svg" alt="影视工坊 Logo" width={40} height={40} />
          <div>
            <strong>百变小克的影视工坊</strong>
            <span className="brand-connection" title="云端档案已连接">
              <i className="brand-connection-dot" aria-hidden="true" />
              云端已连接
            </span>
          </div>
        </a>
        <div className="sidebar-label">我的光影档案</div>
        <nav aria-label="主导航">
          {navigation.map(n => (
            <button
              key={n.label}
              className={`nav-item ${section === n.label ? 'active' : ''}`}
              onClick={() => go(n.label)}
            >
              <n.icon size={18} />
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-sync-card">
            <div className="sidebar-sync-head">
              <span
                className={`sync-status-dot ${syncActive ? 'is-syncing' : syncDisplay.tone === 'failed' ? 'is-failed' : ''}`}
              />
              <strong>{syncDisplay.headline}</strong>
              <button
                className="sidebar-sync-btn"
                aria-label="同步最新记录"
                title={syncDescription}
                disabled={syncActive}
                onClick={() => void syncNow('latest')}
              >
                <RefreshCw size={13} className={syncActive ? 'spin' : ''} />
              </button>
            </div>
            <small>{syncDisplay.detail}</small>
          </div>
          <button
            className="nav-item"
            onClick={() => {
              setSettings(true);
              setMobileNav(false);
            }}
          >
            <Settings2 size={18} />
            <span>设置</span>
          </button>
          <button className="nav-item" onClick={() => setNotice(true)}>
            <LogOut size={18} />
            <span>退出登录</span>
          </button>
        </div>
      </aside>
      {mobileNav && <button className="nav-backdrop" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}

      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button className="mobile-toggle icon-button" aria-label="展开导航" onClick={() => setMobileNav(!mobileNav)}>
              <Menu size={20} />
            </button>
            <div className="topbar-context">
              <strong>{isHome ? '光影概览' : pageCopy[section]?.title ?? section}</strong>
            </div>
          </div>
          <div className="header-actions">
            <label className="search-field">
              <Search size={15} />
              <span className="search-input-wrap">
                <input
                  ref={searchRef}
                  aria-label="搜索观影档案"
                  placeholder="搜索片名…"
                  value={query}
                  onChange={e => {
                    const v = e.target.value;
                    setQuery(v);
                    if (v) {
                      if (section !== '搜索') {
                        setSection('搜索');
                        setYear('all');
                        setLimit(12);
                      }
                    } else if (section === '搜索') {
                      setSection('首页');
                      setYear(currentYear);
                    }
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Escape' && query) {
                      setQuery('');
                      if (section === '搜索') {
                        setSection('首页');
                        setYear(currentYear);
                      }
                    }
                  }}
                />
              </span>
              {query ? (
                <button
                  type="button"
                  className="search-clear"
                  aria-label="清空搜索"
                  onClick={() => {
                    setQuery('');
                    if (section === '搜索') {
                      setSection('首页');
                      setYear(currentYear);
                    }
                  }}
                >
                  <X size={14} />
                </button>
              ) : (
                <kbd>/</kbd>
              )}
            </label>
            <button className="topbar-add-btn" onClick={() => setAddHistory(true)}>
              <Plus size={15} />
              <span>添加记录</span>
            </button>
            <span className="top-divider" />
            <button className="profile" onClick={() => setSettings(true)} aria-label="打开用户设置">
              {avatar}
              <span className="profile-name">
                {data.owner.username}
                <small>工坊设置</small>
              </span>
              <ChevronDown size={14} />
            </button>
          </div>
        </header>

        <main>
          {visibleToast && section !== '观影历史' && (
            <div className="action-toast" role="status">
              {visibleToast}
            </div>
          )}

          {isHome ? (
            <section className="home-header">
              <div className="home-greeting">
                <h1 suppressHydrationWarning>
                  {greetingFor(timeZone)}，{data.owner.username}
                </h1>
                <p>
                  记录每一段观影时光 · 本月已观看 <strong>{thisMonthCount}</strong> 次（{monthDeltaText}）
                </p>
              </div>
              <div className="home-quick-actions">
                <button
                  className="secondary-button"
                  disabled={syncActive}
                  onClick={() => void syncNow('latest')}
                  title={syncDescription}
                >
                  <RefreshCw size={14} className={syncActive ? 'spin' : ''} />
                  {syncDisplay.buttonLabel}
                </button>
              </div>
            </section>
          ) : (
            <section className="page-intro">
              <div className="hero-copy">
                <h1>{pageCopy[section]?.title ?? section}</h1>
                <p className="hero-subtitle">
                  {section === '搜索' && query
                    ? `关键词「${query}」匹配 ${posterEvents.length} 部作品 · ${visibleEvents.length} 条观看记录`
                    : pageCopy[section]?.subtitle}
                </p>
              </div>
              {section === '观影历史' && (
                <div className="history-actions">
                  <div className={`sync-control ${visibleToast ? 'has-feedback' : ''}`}>
                    <button
                      className="secondary-button sync-history-button"
                      title={syncDescription}
                      aria-describedby="history-sync-details"
                      disabled={syncActive}
                      onClick={() => void syncNow('latest')}
                    >
                      {syncDisplay.buttonLabel}
                    </button>
                    <span id="history-sync-details" className="sync-tooltip" role="status" aria-live="polite">
                      {syncDescription}
                    </span>
                  </div>
                  <button className="primary-button add-record-button" onClick={() => setAddHistory(true)}>
                    ＋ 添加记录
                  </button>
                </div>
              )}
            </section>
          )}

          {isHome && (
            <section className="stat-grid" aria-label="累计观影统计">
              {statCards.map(s => (
                <div className="stat-card" key={s.label}>
                  <div className="stat-top">
                    <span>{s.label}</span>
                    <s.icon className={`stat-icon ${s.color}`} size={18} />
                  </div>
                  <div className="stat-value-row">
                    <div className="stat-value">
                      {s.value.toLocaleString('zh-CN')}
                      <span>{s.unit}</span>
                    </div>
                    <span className="stat-subvalue">{s.sub}</span>
                  </div>
                  <div className="stat-caption">{s.caption}</div>
                </div>
              ))}
            </section>
          )}

          {isHome && trackedShows.length > 0 && (
            <section className="panel shows-progress-panel">
              <div className="panel-heading">
                <h2>
                  <Tv size={17} />
                  在追的剧 <span className="section-count">{trackedShows.length}</span>
                </h2>
                <button className="text-button" onClick={() => go('剧集')}>
                  全部剧集
                  <ArrowRight size={14} />
                </button>
              </div>
              <div className="shows-progress-grid">
                {trackedShows.slice(0, 6).map(item => (
                  <button className="show-progress-card" key={item.work.id} onClick={() => setSelectedWork(item.work)}>
                    <img
                      decoding="async"
                      src={item.work.poster}
                      width={52}
                      height={78}
                      alt={`${item.work.title}海报`}
                      loading="eager"
                    />
                    <span className="show-progress-body">
                      <span className="show-progress-top">
                        <strong>{item.work.title}</strong>
                        {item.unwatched > 0 ? (
                          <span className="progress-badge has-unwatched">待看 {item.unwatched} 集</span>
                        ) : item.total ? (
                          <span className="progress-badge caught-up">已追平</span>
                        ) : (
                          <span className="progress-badge">{item.work.year ?? '剧集'}</span>
                        )}
                      </span>
                      <span className="show-progress-latest">
                        {item.latest
                          ? `最新 S${String(item.latest.season ?? 1).padStart(2, '0')} · E${String(item.latest.episode ?? 1).padStart(2, '0')} · ${shortDay(item.latest.watchedAt, timeZone, currentYear)}`
                          : '暂无记录'}
                      </span>
                      <span className="progress-track" aria-hidden="true">
                        <i className={`progress-fill ${item.unwatched > 0 ? 'is-active' : ''}`} style={{ width: `${item.percent}%` }} />
                      </span>
                      <span className="show-progress-foot">
                        <span>{item.total ? `已看 ${item.watched} / ${item.total} 集` : `已看 ${item.watched} 集`}</span>
                        <span>{item.work.rating !== null ? `★ ${item.work.rating.toFixed(1)}` : `${item.count} 次观看`}</span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {(isHome || isLibrary || section === '搜索') && (
            <section className="panel recent-panel">
              <div className="panel-heading">
                <div>
                  <h2>
                    {isLibrary ? '已观看作品' : section === '搜索' ? '匹配作品' : '最近观看'}
                    <span className="section-count">{isLibrary || section === '搜索' ? posterEvents.length : `${Math.min(10, posterEvents.length)} / ${works.length}`}</span>
                  </h2>
                  {isLibrary && <p>按作品去重展示，保留每一次观看足迹</p>}
                </div>
                {isLibrary ? (
                  <select className="sort-select" aria-label="作品排序" value={sort} onChange={e => setSort(e.target.value)}>
                    <option value="recent">最近观看</option>
                    <option value="year">上映年份</option>
                    <option value="count">观看次数</option>
                  </select>
                ) : (
                  <button className="text-button" onClick={() => go('观影历史')}>
                    全部历史
                    <ArrowRight size={14} />
                  </button>
                )}
              </div>
              <div className={`poster-wall ${isLibrary || section === '搜索' ? 'library-wall' : ''}`}>
                {(isHome ? posterEvents.slice(0, 10) : posterEvents).map((e, idx) => {
                  const w = lookup.get(e.workId);
                  if (!w) return null;
                  const entry = watchIndex.get(w.id);
                  const prog = isLibrary && w.kind === 'episode' ? computeShowProgress(w, entry) : null;
                  return (
                    <button className="poster-card" key={e.id} onClick={() => setSelectedWork(w)}>
                      <div className="poster-image">
                        <img
                          decoding="async"
                          src={w.poster}
                          alt={`${w.title}海报`}
                          width={240}
                          height={360}
                          loading={isHome && idx < 6 ? 'eager' : 'lazy'}
                          fetchPriority={isHome && idx < 4 ? 'high' : undefined}
                        />
                        <span className="poster-rating">{w.rating === null ? '暂无评分' : `★ ${w.rating.toFixed(1)}`}</span>
                        <span className="poster-hover">
                          <Search size={20} />
                          查看档案
                        </span>
                        <span className="poster-type">
                          {w.kind === 'movie' ? (w.ticketStub ? '电影 · 有票根' : '电影') : `S${e.season ?? 1} · E${e.episode ?? 1}`}
                        </span>
                      </div>
                      <strong>{w.title}</strong>
                      <small>{shortDate(e.watchedAt, timeZone)}</small>
                      {isLibrary && (
                        <>
                          <span className="library-meta">
                            {w.year ?? '年份未知'} · {entry?.count ?? 0} 次观看
                            {prog && ` · 已看 ${prog.watched}${prog.total ? ` / ${prog.total}` : ''} 集`}
                          </span>
                          {prog && (
                            <span className="mini-progress" aria-hidden="true">
                              <i style={{ width: `${prog.percent}%` }} />
                            </span>
                          )}
                        </>
                      )}
                    </button>
                  );
                })}
                {!works.length && <div className="empty-state">暂无已同步作品，请先刷新历史。</div>}
                {query && !posterEvents.length && (
                  <div className="empty-state">
                    <Search />
                    <h3>没有找到相关作品</h3>
                    <p>试试中文或英文作品名称。</p>
                  </div>
                )}
              </div>
            </section>
          )}

          {(isHome || section === '统计') && (
            <section className="panel heatmap-panel">
              <div className="panel-heading heatmap-heading">
                <h2>
                  <CalendarDays size={17} />
                  {year === 'all' ? `累计观看 ${stats.total} 次` : `${year} 年共观看 ${stats.total} 次`}
                  <span className="section-count">活跃 {stats.activeDays} 天</span>
                </h2>
                <div className="heatmap-year-nav">
                  <button
                    type="button"
                    aria-label="上一年"
                    disabled={year === 'all' || years.indexOf(year) >= years.length - 1}
                    onClick={() => year !== 'all' && setYear(years[years.indexOf(year) + 1])}
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <select
                    className="year-select"
                    aria-label="热力图年份"
                    value={year}
                    onChange={e => setYear(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                  >
                    {years.map(y => (
                      <option key={y} value={y}>
                        {y} 年
                      </option>
                    ))}
                    <option value="all">全部年份</option>
                  </select>
                  <button
                    type="button"
                    aria-label="下一年"
                    disabled={year === 'all' || years.indexOf(year) <= 0}
                    onClick={() => year !== 'all' && setYear(years[years.indexOf(year) - 1])}
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              </div>
              <div className="heatmap-layout">
                <div className="heatmap-graph-box">
                  {(year === 'all' ? years : [year]).map(y => (
                    <Heatmap key={y} year={y} stats={allStats} showYear={year === 'all'} today={todayKey} onSelect={setSelectedDay} />
                  ))}
                  <div className="heatmap-footer">
                    <span>点击方格查看当日记录</span>
                    <span className="heatmap-legend">
                      少 {[0, 1, 2, 3, 4].map(n => <i key={n} className={`level-${n}`} />)} 多
                    </span>
                  </div>
                </div>
                <HeatmapInsights stats={stats} allStats={allStats} today={todayKey} />
              </div>
            </section>
          )}

          {section === '影院票根' && (
            <>
              <section className="panel ticket-panel">
                <div className="panel-heading">
                  <h2>
                    <Ticket size={17} />
                    已收录票根
                    <span className="section-count">{ticketMovies.length}</span>
                  </h2>
                </div>
                {ticketMovies.length ? (
                  <div className="poster-wall library-wall ticket-wall">
                    {ticketMovies.map(({ work, latest, count }) => (
                      <button className="poster-card ticket-poster-card" key={work.id} onClick={() => setSelectedWork(work)}>
                        <div className="poster-image ticket-poster-stage">
                          <img decoding="async" src={work.poster} width={240} height={360} alt={`${work.title} 海报`} loading="lazy" />
                          <span className="ticket-mini-stub" title="已收录影院票根">
                            <img decoding="async" src={work.ticketStub!} width={52} height={68} alt={`${work.title} 票根`} loading="lazy" />
                          </span>
                        </div>
                        <strong>{work.title}</strong>
                        <small>
                          {work.year ?? '电影'} · {latest ? shortDate(latest, timeZone) : '已看'} · {count} 次
                        </small>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="ticket-empty">
                    <Ticket size={26} />
                    <strong>还没有上传影院票根</strong>
                    <p>点击右上角「添加记录」添加电影后，或点开任意看过的电影详情即可上传票根。</p>
                  </div>
                )}
              </section>
            </>
          )}

          {(isHome || section === '观影历史' || section === '搜索' || section === '统计') && (
            <div className={`content-grid ${section === '统计' ? 'statistics-layout' : ''}`}>
              <div className="content-left">
                {(isHome || section === '观影历史' || section === '搜索') && (
                  <section className="panel timeline-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>
                          <Clock3 size={18} />
                          {isHome ? '最近观影时间线' : '播放记录'}
                        </h2>
                      </div>
                      <div className="segmented" role="group" aria-label="历史类型筛选">
                        {['全部', '电影', '剧集'].map(f => (
                          <button
                            key={f}
                            aria-pressed={filter === f}
                            className={filter === f ? 'selected' : ''}
                            onClick={() => {
                              setFilter(f);
                              setLimit(12);
                            }}
                          >
                            {f}
                          </button>
                        ))}
                      </div>
                    </div>
                    {!isHome && (
                      <div className="history-toolbar">
                        <label>
                          年份{' '}
                          <select
                            aria-label="历史年份"
                            value={year}
                            onChange={e => setYear(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                          >
                            <option value="all">全部年份</option>
                            {years.map(y => (
                              <option key={y}>{y}</option>
                            ))}
                          </select>
                        </label>
                        <DatePickerButton
                          prefix="从"
                          ariaLabel="历史开始日期"
                          value={fromDate}
                          onChange={setFromDate}
                          today={todayKey}
                          years={years}
                          rangeStart={fromDate || undefined}
                          rangeEnd={toDate || undefined}
                        />
                        <DatePickerButton
                          prefix="至"
                          ariaLabel="历史结束日期"
                          value={toDate}
                          onChange={setToDate}
                          today={todayKey}
                          years={years}
                          rangeStart={fromDate || undefined}
                          rangeEnd={toDate || undefined}
                        />
                        <select aria-label="历史时间排序" value={historyOrder} onChange={e => setHistoryOrder(e.target.value)}>
                          <option value="desc">最新在前</option>
                          <option value="asc">最早在前</option>
                        </select>
                        <span>{visibleEvents.length} 条观看事件 · 包含重温</span>
                        <button
                          className="text-button date-edit-tasks"
                          onClick={() => {
                            setDateEditEvent(null);
                            setDateEditOpen(true);
                          }}
                        >
                          日期修改任务
                        </button>
                      </div>
                    )}
                    <div className="timeline-list">{eventRows(visibleEvents.slice(0, isHome ? 6 : limit))}</div>
                    {!visibleEvents.length && <p className="empty-state">暂无匹配的观看记录</p>}
                    <button
                      className="timeline-more"
                      onClick={() => (isHome ? go('观影历史') : setLimit(limit + 20))}
                      disabled={!isHome && limit >= visibleEvents.length}
                    >
                      {isHome ? '展开全部观影记录' : limit >= visibleEvents.length ? '已显示全部记录' : '加载更多记录'}
                      <ArrowDown size={13} />
                    </button>
                  </section>
                )}

                {section === '统计' && (
                  <section className="panel yearly-panel">
                    <div className="panel-heading">
                      <h2>年度观看变化</h2>
                      <span className="muted">按观看事件计数</span>
                    </div>
                    <div className="yearly-list">
                      {years.map(y => {
                        const count = annualCounts.get(y) ?? 0;
                        return (
                          <div className="year-row" key={y}>
                            <span>{y}</span>
                            <div>
                              <i style={{ width: `${(count / maxAnnual) * 100}%` }} />
                            </div>
                            <strong>
                              {count}
                              <small> 次</small>
                            </strong>
                          </div>
                        );
                      })}
                    </div>
                    <p className="muted">{currentYear} 年为截至当前日期的数据，非完整年度。</p>
                  </section>
                )}
              </div>

              {(isHome || section === '统计') && (
                <aside className="content-right">
                  <section className="panel charts-panel">
                    <div className="panel-heading">
                      <h2>
                        <ChartNoAxesCombined size={18} />
                        观影统计
                      </h2>
                      <select
                        aria-label="统计年份"
                        value={year}
                        onChange={e => setYear(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                      >
                        {years.map(y => (
                          <option key={y}>{y}</option>
                        ))}
                        <option value="all">全部</option>
                      </select>
                    </div>
                    <div className="chart-subheading">
                      <span>月度观看趋势</span>
                      <span>
                        <i />
                        观看次数
                      </span>
                    </div>
                    <div
                      className="bar-chart"
                      role="region"
                      aria-label={`${year === 'all' ? currentYear : year}年每月观看次数：${monthly.join('、')}`}
                    >
                      <div className="chart-grid">
                        <span>{Math.ceil(maxMonthly)}</span>
                        <span>{Math.ceil(maxMonthly / 2)}</span>
                        <span>0</span>
                      </div>
                      <div className="bars">
                        {monthly.map((n, i) => (
                          <div className="bar-column" key={i}>
                            <div className="bar-track">
                              <div
                                className={`bar ${(year === 'all' || year === currentYear) && i === currentMonth ? 'bar-current' : ''}`}
                                style={{ height: `${(n / maxMonthly) * 100}%` }}
                                tabIndex={0}
                                aria-label={`${i + 1}月 ${n} 次观看`}
                              >
                                <span className="bar-tooltip">
                                  {i + 1}月 · {n} 次
                                </span>
                              </div>
                            </div>
                            <span>{i + 1}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="chart-x-label">月份{year === 'all' ? ` · 显示 ${currentYear} 年` : ''}</div>
                    <div className="chart-divider" />
                    <div className="composition-title">
                      内容类型<span>按观看事件</span>
                    </div>
                    <div className="composition">
                      <div
                        className="donut"
                        role="img"
                        aria-label={`电影 ${moviePercent}%，剧集 ${stats.total ? 100 - moviePercent : 0}%`}
                        style={{
                          background: stats.total
                            ? `conic-gradient(var(--chart-blue) 0% ${moviePercent}%, var(--chart-cyan) ${moviePercent}% 100%)`
                            : 'var(--heat-0)',
                        }}
                      >
                        <div>
                          <strong>{stats.total}</strong>
                          <span>总观看</span>
                        </div>
                      </div>
                      <div className="donut-legend">
                        <div>
                          <i className="movie-dot" />
                          <span>电影</span>
                          <strong>{moviePercent}%</strong>
                        </div>
                        <div>
                          <i className="episode-dot" />
                          <span>剧集</span>
                          <strong>{stats.total ? 100 - moviePercent : 0}%</strong>
                        </div>
                        <p>
                          {stats.movieEvents} 次电影 · {stats.episodeEvents} 集次
                        </p>
                      </div>
                    </div>
                    <button className="statistics-link" onClick={() => go(section === '统计' ? '首页' : '统计')}>
                      {section === '统计' ? '返回首页' : '探索完整观影统计'}
                      <ArrowRight size={14} />
                    </button>
                  </section>
                  {isHome && (
                    <section className="time-card">
                      <div className="time-card-icon">
                        <Clock3 size={21} />
                      </div>
                      <span>累计观影时长</span>
                      <div>
                        <strong>{stats.total > 0 && stats.missingRuntime === stats.total ? '—' : Math.floor(stats.minutes / 60).toLocaleString('zh-CN')}</strong>
                        <span>小时</span>
                        <small>{stats.total > 0 && stats.missingRuntime === stats.total ? '片长待补充' : `${stats.minutes % 60} 分钟`}</small>
                      </div>
                      <p>
                        <Sparkles size={13} />
                        根据片长估算 · 含重复观看 · {stats.missingRuntime} 条缺片长
                      </p>
                    </section>
                  )}
                </aside>
              )}
            </div>
          )}
        </main>
      </div>

      <HistoryDateDialog
        open={dateEditOpen}
        onOpenChange={setDateEditOpen}
        event={dateEditEvent}
        work={dateEditEvent ? lookup.get(dateEditEvent.workId) ?? null : null}
        csrf={data.csrf}
        timezone={timeZone}
        onUpdated={refreshData}
      />
      <AddHistoryDialog
        open={addHistory}
        onOpenChange={setAddHistory}
        csrf={data.csrf}
        timezone={timeZone}
        sync={data.sync}
        resolveTicketUrl={mediaId => lookup.get(mediaId)?.ticketStub ?? null}
        onUpdated={refreshData}
      />

      <Dialog open={!!selectedDay} onOpenChange={o => !o && setSelectedDay(null)} title={selectedDay ? readableDate(selectedDay) : '日期详情'}>
        <p className="modal-kicker">观看记录 · {timeZone}</p>
        <div className="day-summary">
          <span>
            电影 <strong>{selectedDay ? allStats.days.get(selectedDay)?.movies ?? 0 : 0}</strong> 次
          </span>
          <span>
            剧集 <strong>{selectedDay ? allStats.days.get(selectedDay)?.episodes ?? 0 : 0}</strong> 集次
          </span>
        </div>
        <p className="duration-summary">
          估算观看时长：{duration(selectedDay ? allStats.days.get(selectedDay)?.minutes ?? 0 : 0)} ·{' '}
          {selectedDay ? allStats.days.get(selectedDay)?.missingRuntime ?? 0 : 0} 条缺片长
        </p>
        {dayEvents.length ? (
          <div className="modal-events">{eventRows(dayEvents)}</div>
        ) : (
          <div className="empty-state">
            <CalendarDays />
            <p>这一天没有观看记录。</p>
          </div>
        )}
      </Dialog>

      <Dialog open={!!activeSelectedWork} onOpenChange={o => !o && setSelectedWork(null)} title={activeSelectedWork?.title ?? '作品详情'}>
        {activeSelectedWork && (
          <>
            <div className="work-detail">
              <img decoding="async" src={activeSelectedWork.poster} width={140} height={210} alt="作品海报" />
              <div>
                <p className="detail-original">{activeSelectedWork.originalTitle}</p>
                <p className="detail-meta">
                  {activeSelectedWork.year ?? '年份未知'} · {activeSelectedWork.kind === 'movie' ? '电影' : '剧集'} ·{' '}
                  {activeSelectedWork.rating === null ? '暂无评分' : `★ ${activeSelectedWork.rating.toFixed(1)}`}
                  {selectedWorkProgress &&
                    ` · 已看 ${selectedWorkProgress.watched}${selectedWorkProgress.total ? ` / ${selectedWorkProgress.total}` : ''} 集`}
                </p>
                <p>{activeSelectedWork.description}</p>
              </div>
            </div>
            {activeSelectedWork.kind === 'movie' && (
              <TicketUploader
                mediaId={activeSelectedWork.id}
                currentUrl={activeSelectedWork.ticketStub ?? null}
                csrf={data.csrf}
                onChanged={async nextUrl => {
                  const targetId = activeSelectedWork.id;
                  setData(prev => ({
                    ...prev,
                    works: prev.works.map(w => (w.id === targetId ? { ...w, ticketStub: nextUrl } : w)),
                  }));
                  setSelectedWork(prev => (prev && prev.id === targetId ? { ...prev, ticketStub: nextUrl } : prev));
                  await refreshData();
                }}
              />
            )}
            <h3 className="modal-subheading">
              观看足迹 <span>{workEvents.length} 次 · 含重复观看</span>
            </h3>
            <div className="modal-events">{eventRows(workEvents.slice(0, 12), true)}</div>
            <p className="muted">这里展示最近 12 条；完整记录可在观影历史中搜索。</p>
          </>
        )}
      </Dialog>

      <Dialog open={settings} onOpenChange={setSettings} title="工坊设置">
        <p className="modal-kicker">设置保存在本站，不修改 Trakt 账号</p>
        <div className="settings-profile">
          {avatar}
          <div>
            <strong>{data.owner.username}</strong>
            <p>独立的本站头像与统计时区</p>
          </div>
        </div>
        <AvatarEditor
          csrf={data.csrf}
          onSaved={() => {
            setAvatarVersion(v => v + 1);
            void refreshData();
          }}
        />
        <label className="settings-label">
          统计时区
          <select value={timeZone} onChange={e => void saveTimezone(e.target.value)}>
            {[...new Set([timeZone, 'Asia/Shanghai', 'Asia/Tokyo', 'America/Los_Angeles', 'Europe/London', 'UTC'])].map(t => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <p className="settings-help">更改时区会重新计算热力图、活跃天数和观看日期。</p>
        <div className="settings-sync-box">
          <div className="settings-sync-head">
            <div>
              <strong>观看历史校对</strong>
              <p className="settings-help">
                {data.sync.lastReconciledAt
                  ? `最近完整校对 ${shortDate(data.sync.lastReconciledAt, timeZone)}`
                  : '尚未完成首次完整校对'}
                {syncActive || syncDisplay.tone === 'failed' || manualSyncPhase !== 'idle'
                  ? ` · ${syncDisplay.detail}`
                  : ''}
              </p>
            </div>
            <button
              type="button"
              className="secondary-button"
              disabled={syncActive}
              onClick={() => void syncNow('full')}
            >
              <RefreshCw size={14} className={syncActive ? 'spin' : ''} />
              {syncActive ? syncDisplay.buttonLabel : '完整校对'}
            </button>
          </div>
          <p className="settings-help">
            平时点击页面上的「同步最新记录」只检查近期变化；怀疑 Trakt 有早期增删时可在此执行完整校对，有未完成校对时会优先续跑。
          </p>
        </div>
        <div className="settings-status">
          <Check size={17} />
          仅手动确认新增历史，其余接口只读，不影响 Emby 同步
        </div>
      </Dialog>

      <Dialog open={notice} onOpenChange={setNotice} title="退出登录">
        <p className="notice-copy">
          退出只结束当前浏览器会话，后台同步可继续。撤销授权会断开本站的 Trakt 连接并结束全部会话，已缓存的私人记录会保留在本站。不会修改 Trakt 观看记录。
        </p>
        <button className="primary-button" onClick={() => void signOut()}>
          退出当前会话
        </button>
        <button className="text-button" onClick={() => void signOut(true)}>
          撤销本站 Trakt 授权并退出
        </button>
        <p className="settings-help" role="status">
          {actionStatus}
        </p>
      </Dialog>
    </div>
  );
}

const Heatmap = memo(function Heatmap({
  year,
  stats,
  showYear,
  today,
  onSelect,
}: {
  year: number;
  stats: ReturnType<typeof summarize>;
  showYear: boolean;
  today: string;
  onSelect: (date: string) => void;
}) {
  const yearRef = useRef<HTMLDivElement>(null);
  const { cells } = useMemo(() => calendarDays(year), [year]);
  const weeks = Math.max(1, cells.length / 7);
  const monthCols = useMemo(() => {
    const items: { label: string; col: number }[] = [];
    let lastCol = -2;
    for (let m = 0; m < 12; m++) {
      const prefix = `${year}-${String(m + 1).padStart(2, '0')}-01`;
      const idx = cells.indexOf(prefix);
      if (idx === -1) continue;
      const col = Math.floor(idx / 7) + 1;
      if (col - lastCol >= 2) {
        items.push({ label: monthNames[m], col });
        lastCol = col;
      }
    }
    return items;
  }, [year, cells]);

  const [hover, setHover] = useState<{ date: string; x: number; y: number } | null>(null);
  const showTip = useCallback((date: string, el: HTMLElement) => {
    const box = yearRef.current?.getBoundingClientRect();
    if (!box) return;
    const rect = el.getBoundingClientRect();
    const rawX = rect.left - box.left + rect.width / 2;
    const minX = Math.min(115, box.width / 2);
    const x = Math.max(minX, Math.min(rawX, box.width - minX));
    const y = rect.top - box.top;
    setHover({ date, x, y });
  }, []);

  const count = hover ? stats.days.get(hover.date) : null;
  const totalWatches = (count?.movies ?? 0) + (count?.episodes ?? 0);
  const detailParts: string[] = [];
  if (count?.movies) detailParts.push(`电影 ${count.movies} 次`);
  if (count?.episodes) detailParts.push(`剧集 ${count.episodes} 集`);
  const hoverDetail = totalWatches
    ? `${detailParts.join(' · ')}（${duration(count?.minutes ?? 0)}）`
    : '暂无观影记录';

  const initialFocus = useMemo(() => {
    const t = cells.findIndex(d => d === today);
    if (t !== -1) return t;
    return Math.max(0, cells.findIndex(d => !!d && d <= today));
  }, [cells, today]);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const activeIdx = focusIdx !== null && cells[focusIdx] && cells[focusIdx]! <= today ? focusIdx : initialFocus;

  const moveFocus = useCallback(
    (from: number, delta: number) => {
      let next = from + delta;
      while (next >= 0 && next < cells.length && (!cells[next] || cells[next]! > today)) {
        next += delta;
      }
      if (next >= 0 && next < cells.length && cells[next] && cells[next]! <= today) {
        setFocusIdx(next);
        const btn = yearRef.current?.querySelector<HTMLButtonElement>(`button[data-cell="${next}"]`);
        btn?.focus();
      }
    },
    [cells, today]
  );

  const cellButtons = useMemo(
    () =>
      cells.map((date, i) => {
        const item = date ? stats.days.get(date) : null;
        const watches = item ? item.movies + item.episodes : 0;
        const level = Math.min(watches, 4);
        if (date && date > today) return <span key={date} className="heat-cell future" />;
        return date ? (
          <button
            type="button"
            key={date}
            data-cell={i}
            tabIndex={i === activeIdx ? 0 : -1}
            className={`heat-cell level-${level}`}
            aria-label={`${readableDate(date)}：电影 ${item?.movies ?? 0} 次，剧集 ${item?.episodes ?? 0} 集次，估算 ${duration(item?.minutes ?? 0)}`}
            onMouseEnter={e => showTip(date, e.currentTarget)}
            onFocus={e => {
              setFocusIdx(i);
              showTip(date, e.currentTarget);
            }}
            onBlur={() => setHover(null)}
            onKeyDown={e => {
              const deltas: Record<string, number> = { ArrowRight: 7, ArrowLeft: -7, ArrowDown: 1, ArrowUp: -1 };
              const d = deltas[e.key];
              if (d) {
                e.preventDefault();
                moveFocus(i, d);
              }
            }}
            onClick={() => {
              setHover(null);
              onSelect(date);
            }}
          />
        ) : (
          <span key={`blank-${i}`} className="heat-cell blank" />
        );
      }),
    [cells, stats, onSelect, showTip, today, activeIdx, moveFocus]
  );

  return (
    <div className="heatmap-year" ref={yearRef}>
      {showYear && <h3>{year} 年</h3>}
      <div className="heatmap-scroll" onScroll={() => setHover(null)}>
        <div className="heatmap-container">
          <div className="heatmap-body">
            <div className="weekday-spacer" aria-hidden="true" />
            <div
              className="heatmap-months"
              style={{ gridTemplateColumns: `repeat(${weeks}, var(--cell))` }}
            >
              {monthCols.map(m => (
                <span key={m.col} style={{ gridColumn: `${m.col} / span ${Math.min(3, weeks - m.col + 1)}` }}>
                  {m.label}
                </span>
              ))}
            </div>
            <div className="weekday-labels">
              {['周一', '', '周三', '', '周五', '', '周日'].map((label, i) => (
                <span key={i}>{label}</span>
              ))}
            </div>
            <div
              className="heatmap-cells"
              style={{ gridTemplateColumns: `repeat(${weeks}, var(--cell))` }}
              onMouseLeave={() => setHover(null)}
            >
              {cellButtons}
            </div>
          </div>
        </div>
      </div>
      {hover && (
        <div
          className="heatmap-tooltip"
          role="status"
          style={{ left: `${hover.x}px`, top: `${hover.y - 8}px` }}
        >
          <strong>{readableDate(hover.date)}</strong> · {hoverDetail}
        </div>
      )}
    </div>
  );
});

function shiftDay(key: string, delta: number) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function HeatmapInsights({
  stats,
  allStats,
  today,
}: {
  stats: ReturnType<typeof summarize>;
  allStats: ReturnType<typeof summarize>;
  today: string;
}) {
  const info = useMemo(() => {
    const keys = [...stats.days.keys()].sort();
    let longest = 0;
    let run = 0;
    let prev = '';
    let bestDay = '';
    let bestDayCount = 0;
    const months = new Map<string, number>();
    for (const k of keys) {
      run = prev && shiftDay(prev, 1) === k ? run + 1 : 1;
      longest = Math.max(longest, run);
      prev = k;
      const item = stats.days.get(k)!;
      const n = item.movies + item.episodes;
      if (n > bestDayCount) {
        bestDayCount = n;
        bestDay = k;
      }
      months.set(k.slice(0, 7), (months.get(k.slice(0, 7)) ?? 0) + n);
    }
    let bestMonth = '';
    let bestMonthCount = 0;
    for (const [m, n] of months) if (n > bestMonthCount) [bestMonth, bestMonthCount] = [m, n];
    let current = 0;
    let cursor = allStats.days.has(today) ? today : shiftDay(today, -1);
    while (allStats.days.has(cursor)) {
      current++;
      cursor = shiftDay(cursor, -1);
    }
    return { longest, current, bestDay, bestDayCount, bestMonth, bestMonthCount };
  }, [stats, allStats, today]);

  const items = [
    { label: '最长连续', value: `${info.longest} 天` },
    { label: '当前连续', value: `${info.current} 天` },
    { label: '单日最多', value: info.bestDay ? `${info.bestDayCount} 次` : '—', sub: info.bestDay ? readableDate(info.bestDay) : '' },
    {
      label: '最活跃月份',
      value: info.bestMonth ? `${Number(info.bestMonth.slice(5))} 月` : '—',
      sub: info.bestMonth ? `${info.bestMonth.slice(0, 4)} 年 · ${info.bestMonthCount} 次` : '',
    },
  ];
  return (
    <dl className="heatmap-insights">
      {items.map(item => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>
            {item.value}
            {item.sub && <small>{item.sub}</small>}
          </dd>
        </div>
      ))}
    </dl>
  );
}