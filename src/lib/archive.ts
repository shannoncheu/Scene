export type MediaKind = 'movie' | 'episode';
export interface Work { id: string; title: string; originalTitle: string; year: number | null; kind: MediaKind; poster: string; runtime: number | null; rating: number | null; description: string; season?: number; episode?: number; airedEpisodes?: number | null; ticketStub?: string | null; }
export interface WatchEvent { id: string; workId: string; watchedAt: string | null; season?: number; episode?: number; runtime?: number | null; }
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
export function dateKey(iso: string | null, timeZone = DEFAULT_TIMEZONE) {
  if (!iso) return 'unknown';
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    if (dateFormatters.size >= 16) dateFormatters.delete(dateFormatters.keys().next().value!);
    dateFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(iso));
  const value = (key: string) => parts.find(p => p.type === key)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
export function summarize(events: WatchEvent[], works: Work[], timeZone = DEFAULT_TIMEZONE, dayKeys?: Map<string, string>) {
  const lookup = new Map(works.map(w => [w.id, w]));
  const days = new Map<string, { movies: number; episodes: number; minutes: number; missingRuntime: number; events: WatchEvent[] }>();
  const movieIds = new Set<string>(), showIds = new Set<string>(), episodeIds = new Set<string>();
  let minutes = 0, movieEvents = 0, episodeEvents = 0, missingRuntime = 0, unknownDate = 0;
  for (const event of events) {
    const work = lookup.get(event.workId);
    if (!work) continue;
    const day = dayKeys?.get(event.id) ?? dateKey(event.watchedAt, timeZone);
    const item = days.get(day) ?? { movies: 0, episodes: 0, minutes: 0, missingRuntime: 0, events: [] };
    if (work.kind === 'movie') { item.movies++; movieEvents++; movieIds.add(work.id); }
    else { item.episodes++; episodeEvents++; showIds.add(work.id); episodeIds.add(`${work.id}:${event.season}:${event.episode}`); }
    const runtime = event.runtime ?? work.runtime;
    if (runtime === null || runtime === undefined) { missingRuntime++; item.missingRuntime++; } else { minutes += runtime; item.minutes += runtime; }
    if (day === 'unknown') unknownDate++; else { item.events.push(event); days.set(day, item); }
  }
  return { total: movieEvents + episodeEvents, movieEvents, episodeEvents, movies: movieIds.size, shows: showIds.size, uniqueEpisodes: episodeIds.size, days, activeDays: days.size, minutes, missingRuntime, unknownDate };
}
export function duration(minutes: number) { return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`; }
export function monthBuckets(events: WatchEvent[], year: number, timeZone = DEFAULT_TIMEZONE, dayKeys?: Map<string, string>) {
  const values = Array<number>(12).fill(0);
  events.forEach(event => { const key = dayKeys?.get(event.id) ?? dateKey(event.watchedAt, timeZone); if (key.startsWith(`${year}-`)) values[Number(key.slice(5, 7)) - 1]++; });
  return values;
}
export function calendarDays(year: number) {
  const start = new Date(Date.UTC(year, 0, 1));
  const offset = (start.getUTCDay() + 6) % 7;
  const end = new Date(Date.UTC(year + 1, 0, 1));
  const count = Math.round((end.getTime() - start.getTime()) / 86400000);
  return { offset, count, cells: Array.from({ length: Math.ceil((offset + count) / 7) * 7 }, (_, index) => {
    const n = index - offset;
    return n < 0 || n >= count ? null : new Date(start.getTime() + n * 86400000).toISOString().slice(0, 10);
  }) };
}
