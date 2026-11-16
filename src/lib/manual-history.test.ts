import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { watchedUtc,minuteIso } from './manual-time';
const root=mkdtempSync(join(tmpdir(),'cinema-manual-test-'));
process.env.DATABASE_URL='file:'+join(root,'cinema.db');process.env.APP_URL='https://manual.test';process.env.TOKEN_ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.TRAKT_ALLOWED_USERNAME='fixture-owner';process.env.TRAKT_CLIENT_ID='fixture-client';
let db:typeof import('./server/db').db,ownerId:string;
const oldFetch=globalThis.fetch;
let remote:Record<string,unknown>[]=[],posts=0,mode='ok',lastPayload:Record<string,unknown>={};
const movie={title:'Fixture Cinema',year:2024,runtime:110,ids:{trakt:25},images:{poster:[]}},show={title:'Fixture Series',year:2020,ids:{trakt:26},images:{poster:[]}},ep={title:'Fixture Episode',season:2,number:3,runtime:45,ids:{trakt:999}};
function mock(){globalThis.fetch=async(input,options)=>{
 const url=new URL(String(input)),path=url.pathname;
 if(options?.method==='POST'){
  assert.equal(url.href,'https://api.trakt.tv/sync/history');posts++;lastPayload=JSON.parse(String(options.body));
  assert.ok(!('shows' in lastPayload)&&!('seasons' in lastPayload));
  if(mode==='reject')return new Response(null,{status:403});
  if(mode==='rate')return new Response(null,{status:429,headers:{'Retry-After':'120'}});
  const isMovie='movies' in lastPayload,list=(lastPayload.movies||lastPayload.episodes) as {ids:{trakt:number};watched_at:string}[],row=list[0];assert.equal(list.length,1);
  if(mode!=='timeout-absent'&&mode!=='server-error')remote.push({id:String(9000+posts),watched_at:row.watched_at,type:isMovie?'movie':'episode',...(isMovie?{movie}:{show,episode:ep})});
  if(mode==='timeout-added'||mode==='timeout-absent')throw new Error('simulated timeout');
  if(mode==='server-error')return new Response(null,{status:503});
  return Response.json({added:{movies:isMovie?1:0,episodes:isMovie?0:1},not_found:{movies:[],episodes:[]}});
 }
 assert.equal(options?.method,'GET');
 if(path==='/users/settings')return Response.json({user:{username:'fixture-owner',ids:{uuid:mode==='wrong-owner'?'other-uuid':'fixture-uuid'}}});
 if(path==='/sync/last_activities')return Response.json({all:'fixture-stable-activity'});
 if(path.startsWith('/sync/history/')){
  if(mode==='lookup-error')return new Response(null,{status:403});
  const movieFilter=path.includes('/movies/'),target=path.split('/').at(-1);
  const list=remote.filter(r=>r.type===(movieFilter?'movie':'episode')&&String(((r[movieFilter?'movie':'episode'] as {ids:{trakt:number}}).ids.trakt))===target);
  const page=Number(url.searchParams.get('page')||1),limit=1;
  return Response.json(list.slice((page-1)*limit,page*limit),{headers:{'X-Pagination-Page':String(page),'X-Pagination-Page-Count':String(Math.ceil(list.length/limit)),'X-Pagination-Item-Count':String(list.length)}});
 }
 if(path==='/movies/25')return Response.json(movie);
 if(path==='/shows/26')return Response.json(show);
 if(path==='/shows/26/seasons/2/episodes/3')return Response.json(ep);
 throw new Error('Unexpected fixture path '+path);
};}
before(async()=>{const sql=new DatabaseSync(join(root,'cinema.db'));for(const dir of readdirSync(join(process.cwd(),'prisma/migrations')).sort()){if(dir==='migration_lock.toml')continue;sql.exec(readFileSync(join(process.cwd(),'prisma/migrations',dir,'migration.sql'),'utf8'));}sql.close();db=(await import('./server/db')).db;const {encrypt}=await import('./server/crypto');const owner=await db.owner.create({data:{traktUserId:'fixture-uuid',username:'fixture-owner',encryptedAccessToken:encrypt('test-access'),encryptedRefreshToken:encrypt('test-refresh'),tokenExpiresAt:new Date(Date.now()+86400000)}});ownerId=owner.id;mock();});
after(async()=>{globalThis.fetch=oldFetch;await db.$disconnect();});
async function draft(time:string,series=false){return (await import('./server/manual-history')).prepareManual(ownerId,{kind:series?'show':'movie',id:series?'26':'25',...(series?{season:2,episode:3}:{}),localTime:time,timezone:'Asia/Shanghai'});}
test('local times convert across year boundaries and ambiguous or missing DST times are rejected',()=>{
 assert.equal(watchedUtc('2026-01-01T00:05','Asia/Shanghai',Date.UTC(2026,1,1)),'2025-12-31T16:05:00.000Z');
 assert.throws(()=>watchedUtc('2026-11-01T01:30','America/Los_Angeles',Date.UTC(2027,0,1)),/AMBIGUOUS/);
 assert.throws(()=>watchedUtc('2026-03-08T02:30','America/Los_Angeles',Date.UTC(2027,0,1)),/NONEXISTENT/);
 assert.throws(()=>watchedUtc('2026-02-30T10:00','UTC'),/INVALID/);assert.throws(()=>watchedUtc('2099-01-01T00:00','UTC'),/FUTURE/);
 assert.equal(minuteIso('2026-01-01T01:02:59Z'),'2026-01-01T01:02:00.000Z');
});
test('preparation is read-only, idempotent, and a whole show without season/episode is rejected',async()=>{
 const a=await draft('2026-01-01T20:00'),b=await draft('2026-01-01T20:00');assert.equal(a.id,b.id);assert.equal(posts,0);assert.equal(await db.watchEvent.count(),0);
 await assert.rejects((await import('./server/manual-history')).prepareManual(ownerId,{kind:'show',id:'26',localTime:'2026-01-01T20:00',timezone:'Asia/Shanghai'}),/EPISODE_REQUIRED/);
});
test('only explicit confirmation can POST; confirmed movie imports actual event and cannot repeat',async()=>{
 const {confirmManual}=await import('./server/manual-history'),intent=await draft('2026-01-01T20:00');
 await confirmManual(ownerId,intent.id,false);assert.equal(posts,0);
 const done=await confirmManual(ownerId,intent.id,true);assert.equal(done.status,'confirmed');assert.equal(posts,1);assert.equal(await db.watchEvent.count(),1);
 await confirmManual(ownerId,intent.id,true);assert.equal(posts,1);assert.equal((lastPayload.movies as {ids:{trakt:number}}[])[0].ids.trakt,25);
});
test('remote matching checks all pages and minute-normalized duplicates do not POST',async()=>{
 remote.push({id:'99001',watched_at:'2026-01-02T12:00:45Z',type:'movie',movie});
 const intent=await draft('2026-01-02T20:00'),before=posts;
 const result=await (await import('./server/manual-history')).confirmManual(ownerId,intent.id,true);assert.equal(result.status,'confirmed');assert.equal(result.errorCode,'ALREADY_EXISTS');assert.equal(posts,before);
});
test('episodes submit a single episode ID and never a series or season payload',async()=>{
 const intent=await draft('2026-01-03T20:00',true),before=posts;const result=await (await import('./server/manual-history')).confirmManual(ownerId,intent.id,true);
 assert.equal(result.status,'confirmed');assert.equal(posts,before+1);assert.deepEqual((lastPayload.episodes as {ids:unknown}[])[0].ids,{trakt:999});assert.ok(!lastPayload.movies&&!lastPayload.shows&&!lastPayload.seasons);
 const event=await db.watchEvent.findFirstOrThrow({where:{episodeId:'999'}});assert.equal(event.mediaId,'show:26');
});
test('a timed out POST that committed is resolved by GET without retransmission',async()=>{
 mode='timeout-added';const intent=await draft('2026-01-04T20:00'),before=posts;const result=await (await import('./server/manual-history')).confirmManual(ownerId,intent.id,true);assert.equal(result.status,'confirmed');assert.equal(posts,before+1);mode='ok';
});
test('an ambiguous timeout with no visible event remains pending even across new confirmations',async()=>{
 mode='timeout-absent';const intent=await draft('2026-01-05T20:00'),before=posts;const service=await import('./server/manual-history');let result=await service.confirmManual(ownerId,intent.id,true);assert.equal(result.status,'uncertain');assert.equal(posts,before+1);
 result=await service.confirmManual(ownerId,intent.id,true);assert.equal(result.status,'uncertain');assert.equal(posts,before+1);
 remote.push({id:'99002',watched_at:'2026-01-05T12:00:00Z',type:'movie',movie});result=await service.confirmManual(ownerId,intent.id,false);assert.equal(result.status,'confirmed');assert.equal(posts,before+1);mode='ok';
});
test('concurrent confirmations serialize and only one write is sent',async()=>{
 const intent=await draft('2026-01-06T20:00'),before=posts;const {confirmManual}=await import('./server/manual-history');await Promise.allSettled([confirmManual(ownerId,intent.id,true),confirmManual(ownerId,intent.id,true)]);assert.equal(posts,before+1);assert.equal((await db.manualHistoryIntent.findUniqueOrThrow({where:{id:intent.id}})).status,'confirmed');
});
test('a failed preflight or mismatched account never writes',async()=>{
 mode='lookup-error';const intent=await draft('2026-01-07T20:00'),before=posts;const {confirmManual}=await import('./server/manual-history');let result=await confirmManual(ownerId,intent.id,true);assert.equal(result.status,'retryable');assert.equal(posts,before);
 mode='wrong-owner';result=await confirmManual(ownerId,intent.id,true);assert.equal(result.errorCode,'ACCOUNT_NOT_ALLOWED');assert.equal(posts,before);mode='ok';
});
test('429 rejection honors Retry-After and requires a fresh confirmation after the delay',async()=>{
 mode='rate';const intent=await draft('2026-01-08T20:00'),before=posts;const {confirmManual}=await import('./server/manual-history');let result=await confirmManual(ownerId,intent.id,true);assert.equal(result.status,'retryable');assert.equal(posts,before+1);
 result=await confirmManual(ownerId,intent.id,true);assert.equal(posts,before+1);mode='ok';
});
test('manual endpoint rejects anonymous requests, missing CSRF and absent explicit confirmation',async()=>{
 const route=await import('../app/api/manual-history/route');let response=await route.POST(new Request('https://manual.test/api/manual-history',{method:'POST'}));assert.equal(response.status,401);
 const session=await (await import('./server/session')).createSession(ownerId),headers={origin:'https://manual.test',cookie:`cinema_session=${session.token}`,'Content-Type':'application/json'};
 response=await route.POST(new Request('https://manual.test/api/manual-history',{method:'POST',headers,body:'{}'}));assert.equal(response.status,403);
 const intent=await draft('2026-01-09T20:00'),before=posts;
 response=await route.POST(new Request('https://manual.test/api/manual-history',{method:'POST',headers:{...headers,'x-csrf-token':session.csrf},body:JSON.stringify({action:'confirm',id:intent.id})}));assert.equal(response.status,400);assert.equal(posts,before);
});

test('deleted records can be re-prepared and re-added at the same original timestamp',async()=>{
 const {confirmManual}=await import('./server/manual-history');
 const first=await draft('2026-01-10T20:00'),before=posts;
 const done=await confirmManual(ownerId,first.id,true);assert.equal(done.status,'confirmed');assert.equal(posts,before+1);
 const event=await db.watchEvent.findFirstOrThrow({where:{ownerId,mediaId:'movie:25',watchedAt:new Date('2026-01-10T12:00:00.000Z')}});
 remote=remote.filter(r=>r.id!==event.id);
 await db.watchEvent.delete({where:{id:event.id}});
 const rePrepared=await draft('2026-01-10T20:00');
 assert.equal(rePrepared.status,'draft');
 const reConfirmed=await confirmManual(ownerId,rePrepared.id,true);
 assert.equal(reConfirmed.status,'confirmed');assert.equal(posts,before+2);
});

test('drafts older than 30 minutes fail with DRAFT_EXPIRED instead of having lock acquisition refresh updatedAt',async()=>{
 const {confirmManual}=await import('./server/manual-history');
 const intent=await draft('2026-01-11T20:00'),before=posts;
 await db.$executeRawUnsafe(`UPDATE "ManualHistoryIntent" SET "updatedAt" = ${Date.now()-31*60000} WHERE "id" = '${intent.id}'`);
 await assert.rejects(confirmManual(ownerId,intent.id,true),/DRAFT_EXPIRED/);
 assert.equal(posts,before);
 // Repeating confirm should still reject with DRAFT_EXPIRED without silently renewing expiry.
 await assert.rejects(confirmManual(ownerId,intent.id,true),/DRAFT_EXPIRED/);
});

test('confirmed manual addition preserves lastReconciledAt and schedules incremental recent check',async()=>{
 const {confirmManual}=await import('./server/manual-history');
 const reconciledAt=new Date('2026-11-16T10:00:00.000Z');
 await db.syncState.upsert({
  where:{ownerId},
  create:{ownerId,status:'failed',mode:'full',runId:'stale-run',completedPage:3,completedCount:300,expectedCount:885,lastReconciledAt:reconciledAt,lastCheckedAt:new Date(),errorCode:'TRAKT_HTTP_500'},
  update:{status:'failed',mode:'full',runId:'stale-run',completedPage:3,completedCount:300,expectedCount:885,lastReconciledAt:reconciledAt,lastCheckedAt:new Date(),errorCode:'TRAKT_HTTP_500'},
 });
 const intent=await draft('2026-01-12T20:00');
 const res=await confirmManual(ownerId,intent.id,true);
 assert.equal(res.status,'confirmed');
 const sync=await db.syncState.findUniqueOrThrow({where:{ownerId}});
 assert.equal(sync.lastReconciledAt?.getTime(),reconciledAt.getTime(),'lastReconciledAt must remain intact');
 assert.equal(sync.status,'pending');
 assert.equal(sync.mode,'recent');
 assert.equal(sync.runId,null);
 assert.equal(sync.completedPage,0);
 assert.equal(sync.completedCount,0);
 assert.equal(sync.expectedCount,null);
 assert.equal(sync.lastCheckedAt,null);
 assert.equal(sync.errorCode,null);
});
