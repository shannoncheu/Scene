import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarDays, dateKey, monthBuckets, summarize, type WatchEvent } from './archive';
import { events, works, DEMO_AS_OF } from './demo';
test('Shanghai and US dates correctly cross year boundary',()=>{
 assert.equal(dateKey('2025-12-31T16:30:00Z'),'2026-01-01');
 assert.equal(dateKey('2026-01-01T03:30:00Z','America/Los_Angeles'),'2025-12-31');
});
test('calendar includes every day once, Monday first, with leap years',()=>{
 for(const year of [2024,2025,2026]){
  const c=calendarDays(year), dates=c.cells.filter(Boolean);
  assert.equal(dates.length,year===2024?366:365);
  assert.equal(new Set(dates).size,dates.length);
  assert.equal(c.cells.length%7,0);
  assert.equal(dates[0],`${year}-01-01`);
  assert.equal(dates.at(-1),`${year}-12-31`);
 }
 assert.equal(calendarDays(2024).offset,0);
 assert.equal(calendarDays(2026).offset,3);
});
test('repeat watches are separate events, works and episodes deduplicate separately',()=>{
 const fixtures: WatchEvent[]=[
  {id:'1',workId:'dune',watchedAt:'2026-01-01T14:00:00Z'},
  {id:'2',workId:'dune',watchedAt:'2026-01-01T15:00:00Z'},
  {id:'3',workId:'stranger',watchedAt:'2026-01-01T16:00:00Z',season:1,episode:1},
  {id:'4',workId:'stranger',watchedAt:'2026-01-01T17:00:00Z',season:1,episode:1},
  {id:'5',workId:'stranger',watchedAt:'2026-01-01T18:00:00Z',season:1,episode:2},
 ];
 const s=summarize(fixtures,works);
 assert.equal(s.total,5);assert.equal(s.movies,1);assert.equal(s.movieEvents,2);
 assert.equal(s.shows,1);assert.equal(s.episodeEvents,3);assert.equal(s.uniqueEpisodes,2);
 assert.equal(s.activeDays,2);assert.equal(s.minutes,166*2+55*3);
 assert.equal(s.days.get('2026-01-02')?.episodes,3);
});
test('monthly data reconciles with per-year totals and every demo event is valid',()=>{
 assert.equal(events.length,new Set(events.map(e=>e.id)).size);
 assert.ok(events.every(e=>works.some(w=>w.id===e.workId)&&!!e.watchedAt&&e.watchedAt<=DEMO_AS_OF));
 for(const year of [2024,2025,2026]){
 const list=events.filter(e=>dateKey(e.watchedAt).startsWith(`${year}-`));
 const s=summarize(list,works);
 assert.equal(monthBuckets(events,year).reduce((a,b)=>a+b,0),s.total);
 assert.equal([...s.days.values()].reduce((sum,d)=>sum+d.movies+d.episodes,0),s.total);
 }
});
