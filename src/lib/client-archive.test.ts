import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as React from 'react';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {summarize} from './archive';
import {evaluatePendingSync,filterPosterEvents,filterTimelineEvents,formatSyncDisplay,indexWatches,reconcileArchive,type PendingSyncCheck} from './client-archive';
import {withFetchTimeout} from './client-fetch';
import {ArchiveDashboard} from '../components/archive-dashboard';
import type {ArchiveData} from './archive-data';
Object.assign(globalThis,{React});
function fixture():ArchiveData{return {owner:{username:'fixture',timezone:'Asia/Shanghai',hasAvatar:false},csrf:'fixture-csrf',sync:{status:'complete',mode:'recent',completedPage:0,completedCount:4,expectedCount:4,lastCheckedAt:'2026-01-01T00:00:00.000Z',lastSuccessfulAt:'2026-01-01T00:00:00.000Z',lastReconciledAt:'2026-01-01T00:00:00.000Z',errorCode:null,retryAt:null},works:[{id:'show:1',title:'测试',originalTitle:'Fixture',year:2024,kind:'episode',poster:'/poster-placeholder.svg',runtime:20,rating:null,description:'Fixture'}],events:[{id:'90071992547409931',workId:'show:1',watchedAt:'2025-12-31T16:30:00Z',season:1,episode:2},{id:'90071992547409932',workId:'show:1',watchedAt:null,season:1,episode:2},{id:'90071992547409933',workId:'show:1',watchedAt:'2025-12-30T12:00:00Z',season:1,episode:1},{id:'90071992547409934',workId:'movie:2',watchedAt:null}]};}
test('watch index keeps exact event IDs, input order, unknown dates and repeats',()=>{const d=fixture(),snapshot=JSON.stringify(d.events),i=indexWatches(d.events);assert.equal(i.get('show:1')!.count,3);assert.equal(i.get('show:1')!.uniqueEpisodes,2);assert.deepEqual(i.get('show:1')!.events,d.events.slice(0,3));assert.equal(i.get('movie:2')!.count,1);assert.equal(JSON.stringify(d.events),snapshot);});
test('unchanged polling retains the previous archive without mutating either payload',()=>{const old=fixture(),next=structuredClone(old);Object.freeze(old);Object.freeze(next);assert.equal(reconcileArchive(old,next),old);});
test('sync progress changes retain event and metadata references but update progress',()=>{const old=fixture(),next=structuredClone(old);next.sync.status='running';next.sync.completedCount=2;const result=reconcileArchive(old,next);assert.notEqual(result,old);assert.equal(result.events,old.events);assert.equal(result.works,old.works);assert.equal(result.owner,old.owner);assert.equal(result.sync,next.sync);assert.equal(result.sync.completedCount,2);});
test('date edits, new repeated events and deletion are never hidden by polling reuse',()=>{const old=fixture();for(const change of [(d:ArchiveData)=>{d.events[0].watchedAt='2024-01-02T12:00:00Z';},(d:ArchiveData)=>{d.events.push({...d.events[0],id:'90071992547409935'});},(d:ArchiveData)=>{d.events.pop();}]){const next=structuredClone(old);change(next);const result=reconcileArchive(old,next);assert.equal(result.events,next.events);assert.equal(result.works,old.works);assert.deepEqual(result,next);}});
test('metadata, timezone, avatar and session csrf changes remain observable',()=>{const old=fixture();for(const change of [(d:ArchiveData)=>{d.works[0].title='更新片名';d.works[0].poster='/api/poster?id=updated';d.works[0].runtime=25;},(d:ArchiveData)=>{d.owner.timezone='America/Los_Angeles';},(d:ArchiveData)=>{d.owner.hasAvatar=true;},(d:ArchiveData)=>{d.csrf='rotated-fixture';}]){const next=structuredClone(old);change(next);const result=reconcileArchive(old,next);assert.notEqual(result,old);assert.deepEqual(result,next);}});

test('withFetchTimeout aborts stalled response bodies instead of stopping timer after headers',async()=>{
 const realFetch=globalThis.fetch;
 globalThis.fetch=async(_input,init)=>{
  const signal=init?.signal;
  const stream=new ReadableStream({
   start(controller){
    const timer=setTimeout(()=>{try{controller.enqueue(new TextEncoder().encode('{}'));controller.close();}catch{}},1500);
    signal?.addEventListener('abort',()=>{clearTimeout(timer);controller.error(new DOMException('Aborted','AbortError'));},{once:true});
   }
  });
  return new Response(stream,{status:200,headers:{'Content-Type':'application/json'}});
 };
 try{
  const started=Date.now();
  await assert.rejects(withFetchTimeout('https://cinema.test/api/archive',r=>r.json(),{},20),(err:unknown)=>err instanceof Error&&err.name==='AbortError');
  assert.ok(Date.now()-started<1000,'stalled response body must abort well before 1500ms');
 }finally{
  globalThis.fetch=realFetch;
 }
});

test('timeline, poster wall, and ArchiveDashboard skip orphan events missing Work metadata without crashing',()=>{
 const d=fixture();
 d.events.unshift({id:'orphan-event-1',workId:'movie:missing',watchedAt:'2025-12-31T18:00:00Z'});
 const lookup=new Map(d.works.map(w=>[w.id,w]));
 const dayKeys=new Map(d.events.map(e=>[e.id,'2025-12-31']));
 const index=indexWatches(d.events);
 const tl=filterTimelineEvents(d.events,lookup,dayKeys,{filter:'全部',query:'',fromDate:'',toDate:'',historyOrder:'desc'});
 assert.equal(tl.length,3,'show:1 events remain while orphan movie:missing event is skipped');
 const posters=filterPosterEvents(d.events,lookup,index,{libraryKind:null,query:'',sort:'recent'});
 assert.equal(posters.every(e=>e.workId!=='movie:missing'),true);
 const summary=summarize(d.events,d.works);
 assert.equal(summary.total,3);
 const html=renderToStaticMarkup(createElement(ArchiveDashboard,{initialData:d}));
 assert.ok(html.includes('测试'));
 assert.ok(!html.includes('movie:missing'));
 assert.ok(html.includes('同步最新记录'));
 assert.ok(!html.includes('同步历史'));
});

test('sync progress display and 202 completion gating reflect actual sync phase without premature completion',()=>{
 const d=fixture();
 const fmt=(iso:string)=>iso.slice(0,10);
 assert.equal(formatSyncDisplay(d.sync,'submitting',null,fmt).headline,'正在检查 Trakt');
 const pending:PendingSyncCheck={mode:'latest',baselineCheckedAt:d.sync.lastCheckedAt,baselineSuccessfulAt:d.sync.lastSuccessfulAt,sawActive:false};
 const submittedDisplay=formatSyncDisplay(d.sync,'submitted',pending,fmt);
 assert.equal(submittedDisplay.active,true);
 assert.equal(submittedDisplay.buttonLabel,'已提交');
 assert.ok(submittedDisplay.detail.includes('正在检查 Trakt'));
 // Stale DB complete with unchanged timestamps must NOT resolve as finished.
 assert.equal(evaluatePendingSync(pending,d.sync).done,false);
 // Unchanged check advances lastCheckedAt without changing lastSuccessfulAt -> 已是最新.
 const checkedOnly={...d.sync,lastCheckedAt:'2026-01-02T00:00:00.000Z'};
 assert.deepEqual(evaluatePendingSync(pending,checkedOnly),{done:true,nextPending:null,outcome:'unchanged'});
 assert.equal(formatSyncDisplay(checkedOnly,'unchanged',null,fmt).headline,'已是最新');
 // Incremental running state shows only incremental count.
 const recentDisplay=formatSyncDisplay({...d.sync,status:'running',mode:'recent',completedCount:20,expectedCount:35},'submitted',pending,fmt);
 assert.equal(recentDisplay.headline,'正在同步近期记录');
 assert.equal(recentDisplay.detail,'正在同步近期记录 · 20 / 35');
 assert.equal(recentDisplay.buttonLabel,'正在同步近期记录 · 20 / 35');
 // Resumed running state shows resume label.
 assert.equal(formatSyncDisplay({...d.sync,status:'running',mode:'recent:resumed',completedCount:20,expectedCount:35},'submitted',pending,fmt).headline,'正在继续上次同步');
 // Full running state shows full reconciliation progress.
 const fullDisplay=formatSyncDisplay({...d.sync,status:'running',mode:'full',completedCount:100,expectedCount:885},'submitted',pending,fmt);
 assert.equal(fullDisplay.headline,'正在完整校对');
 assert.equal(fullDisplay.detail,'正在完整校对 · 100 / 885');
 assert.equal(fullDisplay.buttonLabel,'正在完整校对 · 100 / 885');
 // Failure preserves errorCode and counts.
 const failed={...d.sync,status:'failed',errorCode:'RATE_LIMITED',completedCount:100,expectedCount:885,lastCheckedAt:'2026-01-02T00:00:00.000Z'};
 assert.deepEqual(evaluatePendingSync(pending,failed),{done:true,nextPending:null,outcome:'failed'});
 const failedDisplay=formatSyncDisplay(failed,'failed',null,fmt);
 assert.equal(failedDisplay.headline,'同步失败，稍后重试');
 assert.ok(failedDisplay.detail.includes('RATE_LIMITED'));
 assert.ok(failedDisplay.detail.includes('100 / 885'));
 // Manual add follow-up: pending incremental check does not show full reconcile, and HISTORY_CHANGED explains auto-retry clearly.
 const pendingManual=formatSyncDisplay({...d.sync,status:'pending',mode:'recent',pendingManualKind:'movie'},'idle',null,fmt);
 assert.equal(pendingManual.detail,'电影已添加，正在后台校对近期记录');
 assert.ok(!pendingManual.headline.includes('完整校对'));
 const historyChangedManual=formatSyncDisplay({...d.sync,status:'failed',errorCode:'HISTORY_CHANGED',pendingManualKind:'movie'},'failed',null,fmt);
 assert.equal(historyChangedManual.detail,'电影已添加，Trakt 历史正在变化，将自动重试校对');
});
