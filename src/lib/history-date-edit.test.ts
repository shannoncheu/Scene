import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
const root=mkdtempSync(join(tmpdir(),'date-edit-test-'));
process.env.DATABASE_URL='file:'+join(root,'cinema.db');process.env.APP_URL='https://cinema.test';process.env.TRAKT_CLIENT_ID='fixture-client';process.env.TRAKT_ALLOWED_USERNAME='fixture-owner-name';process.env.TOKEN_ENCRYPTION_KEY=randomBytes(32).toString('hex');
let db:typeof import('./server/db').db,api:typeof import('./server/history-date-edit'),ownerId='';
type Row={id:string;watched_at:string;type:'episode'|'movie';action:string;show?:Record<string,unknown>;episode?:Record<string,unknown>;movie?:Record<string,unknown>};
let remote:Row[]=[],stamp=0,next=9007199254741000n,posts:{path:string;body:string}[]=[],fault='',wrongOwner=false;
const clone=<T,>(v:T):T=>JSON.parse(JSON.stringify(v));
const episode=(n:number,id:string,date:string):Row=>({id,watched_at:date,type:'episode',action:'scrobble',show:{title:'Fixture Show',ids:{trakt:11}},episode:{ids:{trakt:1000+n},season:1,number:n,runtime:30,title:'Fixture episode'}});
const fixtures=()=>[episode(1,'9223372036854775801','2026-01-01T12:00:00.000Z'),episode(1,'9223372036854775802','2026-01-02T12:00:00.000Z'),episode(2,'9223372036854775803','2026-01-03T12:00:00.000Z')];
const realFetch=globalThis.fetch;
function installMock(){globalThis.fetch=async(input,init)=>{
 const url=new URL(String(input)),path=url.pathname;
 if(path==='/oauth/revoke')return new Response(null,{status:200});
 if(init?.method==='POST'){
  const body=String(init.body);posts.push({path,body});
  if(path==='/sync/history/remove'){
   const ids=body.match(/^\{"ids":\[(\d+)\]\}$/);assert.ok(ids,'Delete accepts only ONE exact numeric history ID');
   if(fault==='delete-429'){fault='';return Response.json({}, {status:429,headers:{'Retry-After':'120'}});}
   const index=remote.findIndex(r=>r.id===ids[1]);assert.ok(index>=0);remote.splice(index,1);stamp++;
   if(fault==='delete-timeout'){fault='';throw Error('network interrupted');}
   return Response.json({deleted:{movies:0,episodes:1}});
  }
  assert.equal(path,'/sync/history');const data=JSON.parse(body),kind=data.movies?'movies':'episodes';assert.deepEqual(Object.keys(data),[kind]);assert.equal(data[kind].length,1);const item=data[kind][0];
  if(fault==='add-before-timeout')throw Error('network interrupted');
  let row:Row;
  if(kind==='movies')row={id:String(next++),type:'movie',action:'watch',watched_at:item.watched_at,movie:{title:'Fixture Movie',ids:{trakt:item.ids.trakt}}};
  else row=episode(item.ids.trakt-1000,String(next++),item.watched_at);
  row.action='watch';remote.push(row);stamp++;
  if(fault==='add-after-timeout'){fault='';throw Error('response lost');}
  return Response.json({added:{[kind]:1},not_found:{movies:[],episodes:[]}});
 }
 assert.equal(init?.method,'GET');
 if(path==='/users/settings')return Response.json({user:{username:'fixture-owner-name',ids:{uuid:wrongOwner?'wrong-account':'fixture-owner'}}});
 if(path==='/sync/last_activities')return Response.json({all:'activity-'+stamp});
 if(path==='/shows/11/seasons/1')return Response.json([1,2,3].map(n=>({ids:{trakt:1000+n},season:1,number:n,first_aired:`2020-01-0${n}T00:00:00.000Z`,runtime:30})));
 const match=path.match(/^\/sync\/history\/(movies|episodes)\/(\d+)$/);assert.ok(match,path);
 const selected=remote.filter(r=>String((match[1]==='movies'?r.movie?.ids:r.episode?.ids as {trakt:number})&&((match[1]==='movies'?r.movie:r.episode)?.ids as {trakt:number}).trakt)===match[2]);
 const page=Number(url.searchParams.get('page')),size=2;
 return Response.json(selected.slice((page-1)*size,page*size),{headers:{'X-Pagination-Page':String(page),'X-Pagination-Page-Count':String(Math.ceil(selected.length/size)),'X-Pagination-Item-Count':String(selected.length)}});
};}
before(async()=>{
 const sqlite=new DatabaseSync(join(root,'cinema.db'));for(const dir of readdirSync('prisma/migrations').sort()){try{sqlite.exec(readFileSync(join('prisma/migrations',dir,'migration.sql'),'utf8'));}catch(e){if(dir!=='migration_lock.toml')throw e;}}sqlite.close();
 db=(await import('./server/db')).db;api=await import('./server/history-date-edit');
});
beforeEach(async()=>{
 await db.historyDateEdit.deleteMany();await db.syncState.deleteMany();await db.manualHistoryIntent.deleteMany();await db.session.deleteMany();await db.watchEvent.deleteMany();await db.owner.deleteMany();await db.episode.deleteMany();await db.media.deleteMany();
 const {encrypt}=await import('./server/crypto');const owner=await db.owner.create({data:{traktUserId:'fixture-owner',username:'fixture-owner-name',encryptedAccessToken:encrypt('fixture-access'),encryptedRefreshToken:encrypt('fixture-refresh'),tokenExpiresAt:new Date(Date.now()+86400000)}});ownerId=owner.id;
 remote=fixtures();posts=[];fault='';wrongOwner=false;stamp=0;next=9007199254741000n;
 await db.media.create({data:{id:'show:11',kind:'episode',originalTitle:'Fixture Show'}});
 for(const n of [1,2,3])await db.episode.create({data:{id:String(1000+n),showId:'show:11',season:1,number:n,runtime:30}});
 for(const r of remote)await db.watchEvent.create({data:{id:r.id,ownerId,mediaId:'show:11',episodeId:String((r.episode!.ids as {trakt:number}).trakt),watchedAt:new Date(r.watched_at),action:'scrobble'}});
 installMock();
});
after(async()=>{globalThis.fetch=realFetch;await db.$disconnect();});
async function prepare(scope:'event'|'season'='event',mode:'custom'|'released'='custom'){
 return api.prepareDateEdit(ownerId,{eventId:fixtures()[0].id,scope,mode,localTime:'2026-02-01T20:30',timezone:'Asia/Shanghai'});
}
async function finish(id:string){await api.confirmDateEdit(ownerId,id);await api.runDateEdit(ownerId);await api.runDateEdit(ownerId);return (await api.getDateEdit(ownerId,id))!;}
test('preview performs no writes and excludes unwatched episodes; release times are per episode',async()=>{
 const op=await prepare('season','released');assert.equal(posts.length,0);assert.equal(op.total,3);assert.equal(op.items.filter(i=>i.episode===1).length,2);assert.ok(op.items.every(i=>i.episode!==3));
 assert.equal(op.items.find(i=>i.episode===1)!.newWatchedAt,'2020-01-01T00:30:00.000Z');assert.equal(op.items.find(i=>i.episode===2)!.newWatchedAt,'2020-01-02T00:30:00.000Z');
 await api.runDateEdit(ownerId);assert.equal(posts.length,0);
});
test('one play changes without touching other episodes or repeated plays; 64-bit deletion stays exact',async()=>{
 const op=await prepare();assert.equal((await finish(op.id)).status,'confirmed');assert.equal(remote.length,3);assert.equal(await db.watchEvent.count(),3);
 assert.ok(remote.some(r=>r.id===fixtures()[1].id));assert.ok(remote.some(r=>r.id===fixtures()[2].id));assert.equal(posts[0].body,'{"ids":[9223372036854775801]}');
 assert.equal((await db.watchEvent.findMany({where:{watchedAt:new Date('2026-02-01T12:30:00Z')}})).length,1);
 const count=posts.length;await finish(op.id);assert.equal(posts.length,count);
});
test('whole-season release preserves duplicate watch count and never marks unseen episode watched',async()=>{
 const op=await prepare('season','released');assert.equal((await finish(op.id)).status,'confirmed');assert.equal(remote.length,3);assert.equal(await db.watchEvent.count(),3);
 assert.equal(remote.filter(r=>r.watched_at==='2020-01-01T00:30:00.000Z').length,2);assert.equal(remote.filter(r=>(r.episode!.ids as {trakt:number}).trakt===1003).length,0);
});
test('lost delete response resumes from persisted journal without deleting another play',async()=>{
 const op=await prepare();fault='delete-timeout';await api.confirmDateEdit(ownerId,op.id);await api.runDateEdit(ownerId);assert.equal(remote.length,2);assert.equal((await api.getDateEdit(ownerId,op.id))!.status,'paused');
 assert.ok((await db.historyDateEditItem.findFirstOrThrow({where:{operationId:op.id}})).deleteSentAt);
 assert.equal((await finish(op.id)).status,'confirmed');assert.equal(posts.filter(p=>p.path.endsWith('/remove')).length,1);assert.equal(remote.length,3);
});
test('lost add response that committed is recovered by GET and never submitted twice',async()=>{
 const op=await prepare();fault='add-after-timeout';assert.equal((await finish(op.id)).status,'confirmed');assert.equal(posts.filter(p=>p.path==='/sync/history').length,1);assert.equal(remote.length,3);
});
test('uncertain add with no visible result stays paused and normal sync is blocked',async()=>{
 const op=await prepare();fault='add-before-timeout';await api.confirmDateEdit(ownerId,op.id);await api.runDateEdit(ownerId);await api.confirmDateEdit(ownerId,op.id);await api.runDateEdit(ownerId);
 assert.equal(posts.filter(p=>p.path==='/sync/history').length,1);assert.equal((await api.getDateEdit(ownerId,op.id))!.status,'paused');assert.ok(await db.watchEvent.findUnique({where:{id:fixtures()[0].id}}));
 assert.equal((await (await import('./server/sync')).syncOwner(ownerId,true)).busy,true);
 assert.ok((await db.historyDateEditItem.findFirstOrThrow({where:{operationId:op.id}})).originalJson.includes(fixtures()[0].id));
});
test('account mismatch prevents all writes, and a different owner cannot prepare or confirm',async()=>{
 await assert.rejects(api.prepareDateEdit('another',{eventId:fixtures()[0].id,scope:'event',mode:'custom',timezone:'Asia/Shanghai',localTime:'2026-01-01T10:00'}));
 const op=await prepare();await assert.rejects(api.confirmDateEdit('another',op.id));wrongOwner=true;await finish(op.id);assert.equal(posts.length,0);assert.equal(remote.length,3);
});
test('429 honors persisted retry deadline and does not remove anything before retry',async()=>{
 const op=await prepare();fault='delete-429';await api.confirmDateEdit(ownerId,op.id);await api.runDateEdit(ownerId);assert.equal(remote.length,3);assert.equal((await api.getDateEdit(ownerId,op.id))!.status,'queued');
 await assert.rejects(api.confirmDateEdit(ownerId,op.id),/RATE_LIMITED/);await api.runDateEdit(ownerId);assert.equal(posts.length,1);
 await db.historyDateEdit.update({where:{id:op.id},data:{retryAt:new Date(0)}});await api.runDateEdit(ownerId);assert.equal((await api.getDateEdit(ownerId,op.id))!.status,'confirmed');
});
test('concurrent processors serialize and batches resume across calls',async()=>{
 const op=await prepare('season','released');await api.confirmDateEdit(ownerId,op.id);await Promise.all([api.runDateEdit(ownerId,1),api.runDateEdit(ownerId,1)]);assert.equal(posts.filter(p=>p.path==='/sync/history').length,1);
 await api.runDateEdit(ownerId,1);await api.runDateEdit(ownerId,1);assert.equal((await api.getDateEdit(ownerId,op.id))!.status,'confirmed');assert.equal(remote.length,3);
});
test('cancelling an untouched task is safe; a partially executed replacement cannot be abandoned',async()=>{
 const op=await prepare();await api.confirmDateEdit(ownerId,op.id);assert.equal((await api.cancelDateEdit(ownerId,op.id)).status,'cancelled');assert.equal(posts.length,0);
 const second=await prepare();fault='add-before-timeout';await api.confirmDateEdit(ownerId,second.id);await api.runDateEdit(ownerId);await assert.rejects(api.cancelDateEdit(ownerId,second.id),/DATE_EDIT_IN_PROGRESS/);
});
test('movies expose only a single-date replacement, never whole-season operations',async()=>{
 await db.media.create({data:{id:'movie:20',kind:'movie',originalTitle:'Fixture Movie'}});const row:Row={id:'8000000000000001',type:'movie',watched_at:'2026-01-01T00:00:00.000Z',action:'watch',movie:{title:'Fixture Movie',ids:{trakt:20}}};remote.push(row);await db.watchEvent.create({data:{id:row.id,ownerId,mediaId:'movie:20',watchedAt:new Date(row.watched_at)}});
 await assert.rejects(api.prepareDateEdit(ownerId,{eventId:row.id,scope:'season',mode:'released',timezone:'UTC'}));const op=await api.prepareDateEdit(ownerId,{eventId:row.id,scope:'event',mode:'custom',localTime:'2026-02-01T12:00',timezone:'UTC'});assert.equal((await finish(op.id)).status,'confirmed');assert.equal(remote.filter(r=>r.type==='movie').length,1);
});
test('HTTP endpoint enforces authentication, CSRF and explicit confirmation',async()=>{
 const route=await import('../app/api/history-date-edit/route');assert.equal((await route.POST(new Request('https://cinema.test/api/history-date-edit',{method:'POST',body:'{}'}))).status,401);
 const {createSession}=await import('./server/session');const session=await createSession(ownerId);const headers={'content-type':'application/json',cookie:'cinema_session='+session.token,origin:'https://cinema.test','x-csrf-token':session.csrf};
 const missing=await route.POST(new Request('https://cinema.test/api/history-date-edit',{method:'POST',headers,body:JSON.stringify({action:'confirm',id:'00000000-0000-0000-0000-000000000000'})}));assert.equal(missing.status,400);
 const csrf=await route.POST(new Request('https://cinema.test/api/history-date-edit',{method:'POST',headers:{...headers,'x-csrf-token':'bad'},body:'{}'}));assert.equal(csrf.status,403);assert.equal(posts.length,0);
});

test('a restored stale journal recognizes an already replaced play without adding again',async()=>{
 const op=await prepare();await finish(op.id);const count=posts.length;
 await db.historyDateEditItem.updateMany({where:{operationId:op.id},data:{status:'deleted',addSentAt:null,newEventId:null}});
 await db.historyDateEdit.update({where:{id:op.id},data:{status:'queued',activeOwnerKey:ownerId}});
 await api.runDateEdit(ownerId);assert.equal(posts.length,count);assert.equal((await api.getDateEdit(ownerId,op.id))!.status,'confirmed');assert.equal(remote.length,3);
});

test('revoking authorization pauses queued edits even after the account is later reauthorized',async()=>{
 const op=await prepare();await api.confirmDateEdit(ownerId,op.id);
 const {createSession}=await import('./server/session');const session=await createSession(ownerId);
 const route=await import('../app/api/auth/revoke/route');const r=await route.POST(new Request('https://cinema.test/api/auth/revoke',{method:'POST',headers:{cookie:'cinema_session='+session.token,origin:'https://cinema.test','x-csrf-token':session.csrf}}));assert.equal(r.status,200);
 assert.equal((await api.getDateEdit(ownerId,op.id))!.status,'paused');
 const {encrypt}=await import('./server/crypto');await db.owner.update({where:{id:ownerId},data:{encryptedAccessToken:encrypt('new-fixture-access'),encryptedRefreshToken:encrypt('new-fixture-refresh'),tokenExpiresAt:new Date(Date.now()+86400000)}});
 await api.runDateEdit(ownerId);assert.equal(posts.length,0);assert.equal((await api.getDateEdit(ownerId,op.id))!.status,'paused');
});

test('paused uncertain date edits support explicit retry_add and abandon recovery to unblock sync',async()=>{
 const op=await prepare();fault='add-before-timeout';
 await api.confirmDateEdit(ownerId,op.id);await api.runDateEdit(ownerId);
 const paused=(await api.getDateEdit(ownerId,op.id))!;
 assert.equal(paused.status,'paused');assert.equal(paused.canCancel,false);assert.equal(paused.canRetryAdd,true);
 // Explicit retry_add clears addSentAt after confirming remote absence, letting the next run complete.
 fault='';
 const queued=await api.retryUncertainDateEdit(ownerId,op.id);assert.equal(queued.status,'queued');
 await api.runDateEdit(ownerId);
 assert.equal((await api.getDateEdit(ownerId,op.id))!.status,'confirmed');assert.equal(remote.length,3);
 // Explicit abandon releases activeOwnerKey even on partially executed paused tasks so normal sync unblocks.
 const op2=await api.prepareDateEdit(ownerId,{eventId:fixtures()[1].id,scope:'event',mode:'custom',localTime:'2026-02-02T20:30',timezone:'Asia/Shanghai'});fault='add-before-timeout';
 await api.confirmDateEdit(ownerId,op2.id);await api.runDateEdit(ownerId);
 const abandoned=await api.abandonDateEdit(ownerId,op2.id);
 assert.equal(abandoned.status,'failed');
 assert.equal(await db.historyDateEdit.count({where:{activeOwnerKey:ownerId}}),0);
 const sync=await db.syncState.findUniqueOrThrow({where:{ownerId}});
 assert.equal(sync.status,'pending');assert.equal(sync.lastReconciledAt,null);
 // Abandoned/failed operations cannot be re-queued via late confirmDateEdit calls.
 await assert.rejects(api.confirmDateEdit(ownerId,op2.id),/INVALID_INPUT/);
 assert.equal((await api.getDateEdit(ownerId,op2.id))!.status,'failed');
});

test('cancelled date edits cannot be re-queued by a late confirmDateEdit request',async()=>{
 const op=await prepare();
 await api.confirmDateEdit(ownerId,op.id);
 assert.equal((await api.cancelDateEdit(ownerId,op.id)).status,'cancelled');
 await assert.rejects(api.confirmDateEdit(ownerId,op.id),/INVALID_INPUT/);
 const reloaded=(await api.getDateEdit(ownerId,op.id))!;
 assert.equal(reloaded.status,'cancelled');
 assert.equal(await db.historyDateEdit.count({where:{activeOwnerKey:ownerId}}),0);
 await api.runDateEdit(ownerId);
 assert.equal(posts.length,0);
});

test('concurrent cancel/abandon cannot be resurrected by runDateEdit or stale retryUncertainDateEdit',async()=>{
 const op=await prepare();
 await api.confirmDateEdit(ownerId,op.id);
 // Simulate cancellation arriving right after runDateEdit acquires lease and awaits /users/settings.
 const baseFetch=globalThis.fetch;
 let intercepted=false;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));
  if(url.pathname==='/users/settings'&&!intercepted){
   intercepted=true;
   await db.historyDateEdit.update({where:{id:op.id},data:{status:'cancelled',activeOwnerKey:null}});
  }
  return baseFetch(input,init);
 };
 try{
  await api.runDateEdit(ownerId);
 }finally{
  globalThis.fetch=baseFetch;
 }
 assert.equal((await api.getDateEdit(ownerId,op.id))!.status,'cancelled');
 assert.equal(await db.historyDateEdit.count({where:{activeOwnerKey:ownerId}}),0);
 assert.equal(posts.length,0);

 // Simulate error in catch block after concurrent cancel: catch must not mark cancelled op as paused.
 const opFail=await api.prepareDateEdit(ownerId,{eventId:fixtures()[0].id,scope:'event',mode:'custom',localTime:'2026-02-02T20:30',timezone:'Asia/Shanghai'});
 await api.confirmDateEdit(ownerId,opFail.id);
 let failIntercepted=false;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));
  if(url.pathname==='/users/settings'&&!failIntercepted){
   failIntercepted=true;
   await db.historyDateEdit.update({where:{id:opFail.id},data:{status:'cancelled',activeOwnerKey:null}});
   return new Response(null,{status:500});
  }
  return baseFetch(input,init);
 };
 try{
  await api.runDateEdit(ownerId);
 }finally{
  globalThis.fetch=baseFetch;
 }
 assert.equal((await api.getDateEdit(ownerId,opFail.id))!.status,'cancelled');
 assert.equal(await db.historyDateEdit.count({where:{activeOwnerKey:ownerId}}),0);

 // Once abandoned/failed, a late retryUncertainDateEdit call must reject without altering terminal status.
 const op2=await api.prepareDateEdit(ownerId,{eventId:fixtures()[1].id,scope:'event',mode:'custom',localTime:'2026-02-03T20:30',timezone:'Asia/Shanghai'});
 fault='add-before-timeout';
 await api.confirmDateEdit(ownerId,op2.id);await api.runDateEdit(ownerId);
 fault='';
 assert.equal((await api.abandonDateEdit(ownerId,op2.id)).status,'failed');
 await assert.rejects(api.retryUncertainDateEdit(ownerId,op2.id),/INVALID_INPUT/);
 assert.equal((await api.getDateEdit(ownerId,op2.id))!.status,'failed');
 assert.equal(await db.historyDateEdit.count({where:{activeOwnerKey:ownerId}}),0);
});
