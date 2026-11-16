import type { WatchEvent, Work } from './archive';
// Explicit preview fixtures. These never represent the owner's actual Trakt data.
export const DEMO_AS_OF = '2026-10-27T04:00:00Z';
export const works: Work[] = [
 { id:'dune', title:'沙丘2', originalTitle:'DUNE: PART TWO', year:2024, kind:'movie', poster:'/posters/dune.svg', runtime:166, rating:8.3, description:'沙海之上，命运与选择交织。保罗踏上新的旅程。此简介及海报仅用于界面演示。' },
 { id:'interstellar', title:'星际穿越', originalTitle:'INTERSTELLAR', year:2014, kind:'movie', poster:'/posters/interstellar.svg', runtime:169, rating:8.7, description:'穿越星际，追寻时间与爱的回响。此简介及海报仅用于界面演示。' },
 { id:'stranger', title:'怪奇物语', originalTitle:'STRANGER THINGS', year:2016, kind:'episode', poster:'/posters/stranger.svg', runtime:55, rating:8.6, season:4, episode:7, description:'平静小镇的另一面，藏着一个不可思议的世界。此简介及海报仅用于界面演示。' },
 { id:'breaking', title:'绝命毒师', originalTitle:'BREAKING BAD', year:2008, kind:'episode', poster:'/posters/breaking.svg', runtime:47, rating:9.5, season:5, episode:14, description:'当平凡生活驶入未知，一切开始改变。此简介及海报仅用于界面演示。' },
 { id:'last', title:'最后生还者', originalTitle:'THE LAST OF US', year:2023, kind:'episode', poster:'/posters/last.svg', runtime:52, rating:8.7, season:1, episode:3, description:'世界寂静之后，依然有人为彼此点亮微光。此简介及海报仅用于界面演示。' },
 { id:'arrival', title:'降临', originalTitle:'ARRIVAL', year:2016, kind:'movie', poster:'/posters/arrival.svg', runtime:116, rating:7.9, description:'与未知相遇，也与时间重新相识。此简介及海报仅用于界面演示。' },
];
// Reproducible fixture schedule, not random data. All displayed metrics derive from these events.
const schedule = [
 { weekday:2, hour:20, minute:30, workId:'stranger' },
 { weekday:4, hour:21, minute:15, workId:'breaking' },
 { weekday:6, hour:19, minute:40, workId:'interstellar' },
 { weekday:6, hour:22, minute:45, workId:'last' },
 { weekday:0, hour:20, minute:10, workId:'arrival' },
];
export const events: WatchEvent[] = [];
for (const year of [2024,2025,2026]) {
  for (let day=0;day<366;day++) {
    const d = new Date(Date.UTC(year,0,day+1));
    if(d.getUTCFullYear()!==year || d.getTime()>new Date(DEMO_AS_OF).getTime()) break;
    if ((d.getUTCMonth()+day)%11===0 || (year===2024 && d.getUTCMonth()<8)) continue;
    schedule.forEach((slot,i)=> {
      if(d.getUTCDay()!==slot.weekday || (d.getUTCMonth()+day+i)%7===0) return;
      const watchedAt = new Date(Date.UTC(year,d.getUTCMonth(),d.getUTCDate(),slot.hour-8,slot.minute)).toISOString();
      events.push({ id:`demo-${year}-${day}-${i}`, workId:slot.workId, watchedAt, season:slot.workId==='stranger'?4:slot.workId==='breaking'?5:1, episode:day%8+1 });
    });
  }
}
events.push(
 {id:'demo-latest-1',workId:'dune',watchedAt:'2026-10-26T13:14:00Z'},
 {id:'demo-latest-2',workId:'interstellar',watchedAt:'2026-10-25T11:30:00Z'},
 {id:'demo-latest-3',workId:'stranger',watchedAt:'2026-10-26T11:32:00Z',season:4,episode:7},
 {id:'demo-latest-4',workId:'breaking',watchedAt:'2026-10-24T12:18:00Z',season:5,episode:14},
 {id:'demo-latest-5',workId:'last',watchedAt:'2026-10-23T13:06:00Z',season:1,episode:3},
 {id:'demo-latest-6',workId:'arrival',watchedAt:'2026-10-22T11:00:00Z'},
);
events.sort((a,b)=>(b.watchedAt??'').localeCompare(a.watchedAt??''));
