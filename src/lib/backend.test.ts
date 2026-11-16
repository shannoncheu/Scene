import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
const testRoot=mkdtempSync(join(tmpdir(),'cinema-integration-'));
process.env.DATABASE_URL='file:'+join(testRoot,'cinema.db');
process.env.TOKEN_ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.TRAKT_CLIENT_ID='test-client';process.env.TRAKT_ALLOWED_USERNAME='fixture-owner-name';process.env.APP_URL='https://cinema.test';process.env.DATA_DIR=testRoot;
let db:typeof import('./server/db').db;
const originalFetch=globalThis.fetch;
let ownerId='';
before(async()=>{
 const sqlite=new DatabaseSync(join(testRoot,'cinema.db'));
 for(const dir of readdirSync(join(process.cwd(),'prisma/migrations')).sort()){if(dir==='migration_lock.toml')continue;sqlite.exec(readFileSync(join(process.cwd(),'prisma/migrations',dir,'migration.sql'),'utf8'));}
 sqlite.close();db=(await import('./server/db')).db;
 const {encrypt}=await import('./server/crypto');
 const owner=await db.owner.create({data:{traktUserId:'fixture-uuid',username:'fixture-owner-name',encryptedAccessToken:encrypt('fixture-access'),encryptedRefreshToken:encrypt('fixture-refresh'),tokenExpiresAt:new Date(Date.now()+86400000)}});ownerId=owner.id;
});
after(async()=>{globalThis.fetch=originalFetch;await db.$disconnect();});
const movie=(id:string,watched_at:string|null)=>({id,watched_at,action:'scrobble',type:'movie',movie:{title:'Fixture Movie',year:2020,runtime:100,ids:{trakt:10,tmdb:20}}});
const episode={id:'9223372036854775806',watched_at:'2026-01-01T16:05:00Z',type:'episode',show:{title:'Fixture Show',ids:{trakt:11}},episode:{ids:{trakt:1001},season:1,number:1,runtime:42}};
let rows:unknown[]=[movie('9223372036854775804','2026-01-01T15:55:00Z'),movie('9223372036854775805','2026-01-01T14:00:00Z'),episode];
let stamp='2026-01-02T01:00:00Z',failPage=0,historyRequests=0,changeDuringRun=false;
function installHistoryMock(){globalThis.fetch=async(input,init)=>{
 const url=new URL(String(input));assert.equal(init?.method,'GET');assert.match(new Headers(init?.headers).get('User-Agent')||'',/^CinemaWorkshop\/0\.2/);assert.equal(new Headers(init?.headers).get('Accept'),'application/json');
 if(url.pathname==='/sync/last_activities')return Response.json({all:changeDuringRun?stamp+'changed':stamp});
 assert.equal(url.pathname,'/sync/history');historyRequests++;
 const page=Number(url.searchParams.get('page')),start=url.searchParams.get('start_at');
 let selected=rows;
 if(start)selected=rows.filter(v=>{const r=v as {watched_at:string|null};return r.watched_at&&r.watched_at>=start;});
 const limit=url.searchParams.get('limit')==='1'?1:2;
 if(page===failPage)return new Response(null,{status:403});
 const slice=selected.slice((page-1)*limit,page*limit);
 return Response.json(slice,{headers:{'X-Pagination-Page':String(page),'X-Pagination-Page-Count':String(Math.ceil(selected.length/limit)),'X-Pagination-Item-Count':String(selected.length)}});
};}
test('AES-GCM encryption authenticates ciphertext and PKCE matches RFC test vector',async()=>{
 const {encrypt,decrypt,challenge}=await import('./server/crypto');const encrypted=encrypt('secret-fixture');assert.notEqual(encrypted,'secret-fixture');assert.equal(decrypt(encrypted),'secret-fixture');assert.throws(()=>decrypt(encrypted.slice(0,-3)+'abc'));
 assert.equal(challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});
test('64-bit history IDs survive JSON parsing exactly and business writes are blocked',async()=>{
 const {parseTrakt,readTrakt}=await import('./server/trakt');assert.equal((parseTrakt('{"id":9223372036854775807}') as {id:string}).id,'9223372036854775807');
 await assert.rejects(readTrakt('/sync/history/remove','fixture'),/BLOCKED/);await assert.rejects(readTrakt('/sync/ratings','fixture'),/BLOCKED/);
});
test('OAuth token and revoke use the current official authentication host',async()=>{
 const {oauthPost}=await import('./server/trakt');const paths:string[]=[];
 globalThis.fetch=async(input,init)=>{const url=new URL(String(input));assert.equal(url.origin,'https://auth.trakt.tv');assert.equal(init?.method,'POST');assert.match(new Headers(init?.headers).get('User-Agent')||'',/^CinemaWorkshop\/0\.2/);assert.equal(new Headers(init?.headers).get('Accept'),'application/json');paths.push(url.pathname);return url.pathname==='/oauth/token'?Response.json({access_token:'host-fixture',refresh_token:'host-refresh',expires_in:3600,created_at:Math.floor(Date.now()/1000)}):new Response(null,{status:200});};
 await oauthPost('token',{grant_type:'authorization_code',client_id:'fixture',code:'fixture',code_verifier:'fixture',redirect_uri:'https://cinema.test/api/auth/callback'});await oauthPost('revoke',{client_id:'fixture',token:'fixture'});assert.deepEqual(paths,['/oauth/token','/oauth/revoke']);
});
test('OAuth callback rejects an invalid state before making any network request',async()=>{
 globalThis.fetch=async()=>{throw Error('NETWORK_MUST_NOT_RUN');};
 const callback=await import('../app/api/auth/callback/route');
 const response=await callback.GET(new Request('https://cinema.test/api/auth/callback?state=x&code=y',{headers:{cookie:'cinema_oauth=z'}}));
 assert.equal(response.status,307);assert.match(response.headers.get('location')!,/error=state/);assert.equal(await db.session.count(),0);
});
test('OAuth callback enforces fixed account ID even when another account uses the allowed username',async()=>{
 const {hash,encrypt}=await import('./server/crypto');await db.oAuthAttempt.create({data:{id:hash('fixture-state'),verifier:encrypt('fixture-verifier'),expiresAt:new Date(Date.now()+60000)}});
 const calls:string[]=[];
 globalThis.fetch=async(input)=>{const path=new URL(String(input)).pathname;calls.push(path);if(path==='/oauth/token')return Response.json({access_token:'bad-user-access',refresh_token:'bad-user-refresh',expires_in:86400,created_at:Math.floor(Date.now()/1000)});if(path==='/oauth/revoke')return new Response(null,{status:200});return Response.json({user:{username:'fixture-owner-name',ids:{uuid:'wrong-fixed-uuid'}}});};
 const response=await (await import('../app/api/auth/callback/route')).GET(new Request('https://cinema.test/api/auth/callback?state=fixture-state&code=code',{headers:{cookie:'cinema_oauth=fixture-state'}}));
 assert.match(response.headers.get('location')!,/error=account/);assert.ok(calls.includes('/oauth/revoke'));assert.equal(await db.session.count(),0);
});
test('OAuth success stores encrypted tokens, rotates state, and issues HttpOnly Secure session',async()=>{
 const {hash,encrypt}=await import('./server/crypto');await db.oAuthAttempt.create({data:{id:hash('good-state'),verifier:encrypt('good-verifier'),expiresAt:new Date(Date.now()+60000)}});
 globalThis.fetch=async(input,init)=>{const path=new URL(String(input)).pathname;if(path==='/oauth/token'){const body=JSON.parse(String(init?.body));assert.equal(body.code_verifier,'good-verifier');assert.ok(!body.client_secret);return Response.json({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:86400,created_at:Math.floor(Date.now()/1000)});}return Response.json({user:{username:'fixture-owner-name',ids:{uuid:'fixture-uuid'}}});};
 const response=await (await import('../app/api/auth/callback/route')).GET(new Request('https://cinema.test/api/auth/callback?state=good-state&code=code',{headers:{cookie:'cinema_oauth=good-state'}}));
 assert.equal(response.headers.get('location'),'https://cinema.test/');assert.match(response.headers.get('set-cookie')!,/HttpOnly/);assert.match(response.headers.get('set-cookie')!,/Secure/);assert.equal(await db.oAuthAttempt.count(),0);assert.equal(await db.session.count(),1);
 const owner=await db.owner.findUniqueOrThrow({where:{id:ownerId}});assert.notEqual(owner.encryptedAccessToken,'fixture-access');
});
test('session expires, CSRF rejects cross-origin writes, logout invalidates only current session',async()=>{
 const {createSession,sessionByToken,checkMutation}=await import('./server/session');const session=await createSession(ownerId),found=(await sessionByToken(session.token))!;assert.ok(found);
 assert.throws(()=>checkMutation(new Request('https://cinema.test/api/settings',{method:'POST',headers:{origin:'https://evil.test','x-csrf-token':session.csrf}}),found),/CSRF/);
 const response=await (await import('../app/api/auth/logout/route')).POST(new Request('https://cinema.test/api/auth/logout',{method:'POST',headers:{origin:'https://cinema.test','x-csrf-token':session.csrf,cookie:`cinema_session=${session.token}`}}));
 assert.equal(response.status,200);assert.equal(await sessionByToken(session.token),null);assert.equal(await db.session.count(),1);
 const expired=await createSession(ownerId);const {hash}=await import('./server/crypto');await db.session.update({where:{id:hash(expired.token)},data:{expiresAt:new Date(0)}});assert.equal(await sessionByToken(expired.token),null);await db.session.deleteMany({where:{expiresAt:{lt:new Date()}}});
});
test('full pagination imports repeated watches and episode-specific runtimes without duplicates',async()=>{
 installHistoryMock();const result=await (await import('./server/sync')).syncOwner(ownerId,true);assert.equal(result.complete,true);assert.equal(await db.watchEvent.count(),3);assert.equal(await db.media.count(),2);
 const repeated=await db.watchEvent.count({where:{mediaId:'movie:10'}});assert.equal(repeated,2);
 await (await import('./server/sync')).syncOwner(ownerId,true);assert.equal(await db.watchEvent.count(),3);
 const archive=await (await import('./server/archive')).loadArchive(ownerId,'fixture-csrf');const stats=(await import('./archive')).summarize(archive.events,archive.works);assert.equal(stats.total,3);assert.equal(stats.minutes,242);assert.equal(stats.movies,1);assert.equal(stats.shows,1);assert.equal(stats.activeDays,2);
});
test('failed page keeps prior records, checkpoints and resumes only a stable source snapshot',async()=>{
 rows.push(movie('9223372036854775807','2026-01-01T13:00:00Z'));stamp='2026-01-03';failPage=2;installHistoryMock();
 let result=await (await import('./server/sync')).syncOwner(ownerId,true);assert.ok(result.error);assert.equal(await db.watchEvent.count(),3);assert.equal((await db.syncState.findUniqueOrThrow({where:{ownerId}})).completedPage,1);
 failPage=0;await db.syncState.update({where:{ownerId},data:{retryAt:null}});result=await (await import('./server/sync')).syncOwner(ownerId);assert.equal(result.complete,true);assert.equal(await db.watchEvent.count(),4);
});
test('recent delta detects backdated insert by count mismatch and full reconcile includes unknown dates',async()=>{
 rows.push(movie('9223372036854775808','2020-01-01T00:00:00Z'));rows.push(movie('9223372036854775809',null));stamp='2026-02-01';installHistoryMock();
 const sync=await import('./server/sync');let result=await sync.syncOwner(ownerId);assert.equal(result.reconcileRequired,true);
 result=await sync.syncOwner(ownerId);assert.equal(result.complete,true);assert.equal(await db.watchEvent.count(),6);
 const data=await (await import('./server/archive')).loadArchive(ownerId,'fixture');const stats=(await import('./archive')).summarize(data.events,data.works);assert.equal(stats.unknownDate,1);assert.ok(!stats.days.has('unknown'));
});
test('full reconciliation reflects remote removal locally and does not issue any Trakt write',async()=>{
 rows=rows.slice(1);stamp='2026-02-02';installHistoryMock();await (await import('./server/sync')).syncOwner(ownerId,true);assert.equal(await db.watchEvent.count(),5);assert.ok(historyRequests>1);
});
test('source changes during pagination never cause local deletions or a false completed status',async()=>{
 installHistoryMock();const delegate=globalThis.fetch;let activityCalls=0;
 globalThis.fetch=async(input,init)=>{if(new URL(String(input)).pathname==='/sync/last_activities'){activityCalls++;return Response.json({all:activityCalls>1?'changed-after-pagination':stamp});}return delegate(input,init);};
 const result=await (await import('./server/sync')).syncOwner(ownerId,true);assert.equal(result.error,'HISTORY_CHANGED');assert.equal(await db.watchEvent.count(),5);assert.equal((await db.syncState.findUniqueOrThrow({where:{ownerId}})).status,'failed');
 installHistoryMock();await db.syncState.update({where:{ownerId},data:{retryAt:null}});assert.equal((await (await import('./server/sync')).syncOwner(ownerId,true)).complete,true);
});
test('persistent lease prevents two concurrent syncs',async()=>{
 await db.syncState.update({where:{ownerId},data:{leaseExpiresAt:new Date(Date.now()+60000)}});assert.equal((await (await import('./server/sync')).syncOwner(ownerId,true)).busy,true);await db.syncState.update({where:{ownerId},data:{leaseExpiresAt:null}});
});
test('rate limits honor long Retry-After without retrying in a loop',async()=>{
 let calls=0;const response=async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'300'}});};
 const {readTrakt,TraktError}=await import('./server/trakt');await assert.rejects(readTrakt('/sync/history','fixture',{},response),error=>error instanceof TraktError&&error.retryAfter===300);assert.equal(calls,1);
});
test('concurrent token refresh uses a single rotating refresh token',async()=>{
 await db.owner.update({where:{id:ownerId},data:{tokenExpiresAt:new Date(0)}});let calls=0;
 globalThis.fetch=async(input,init)=>{assert.equal(new URL(String(input)).pathname,'/oauth/token');const body=JSON.parse(String(init?.body));assert.equal(body.redirect_uri,'https://cinema.test/api/auth/callback');calls++;return Response.json({access_token:'refreshed-access',refresh_token:'rotated-refresh',expires_in:86400,created_at:Math.floor(Date.now()/1000)});};
 const {accessToken}=await import('./server/trakt');const tokens=await Promise.all([accessToken(ownerId),accessToken(ownerId)]);assert.deepEqual(tokens,['refreshed-access','refreshed-access']);assert.equal(calls,1);
});
test('avatar rejects disguised/oversize content and returns stripped 256px WebP',async()=>{
 const {avatarImage}=await import('./server/avatar');const input=await sharp({create:{width:400,height:300,channels:3,background:'#59738f'}}).png().toBuffer();
 const result=await avatarImage(input,'image/png',{x:.125,y:0,size:1});const info=await sharp(result).metadata();assert.equal(info.width,256);assert.equal(info.height,256);assert.equal(info.format,'webp');assert.equal(info.exif,undefined);
 await assert.rejects(avatarImage(Buffer.from('<svg/>'),'image/png',{x:0,y:0,size:1}),/FILE_INVALID/);await assert.rejects(avatarImage(input,'image/jpeg',{x:0,y:0,size:1}),/FILE_INVALID/);await assert.rejects(avatarImage(Buffer.alloc(6*1024*1024),'image/png',{x:0,y:0,size:1}),/TOO_LARGE/);
});
test('image URLs cannot target local or arbitrary network services',async()=>{
 const {allowedArtwork}=await import('./server/metadata');assert.equal(allowedArtwork('walter-r2.trakt.tv/images/poster.webp').hostname,'walter-r2.trakt.tv');assert.equal(allowedArtwork('media.trakt.tv/images/poster.webp').hostname,'media.trakt.tv');assert.throws(()=>allowedArtwork('http://127.0.0.1:8080/'));assert.throws(()=>allowedArtwork('https://evil.test/x'));assert.throws(()=>allowedArtwork('https://image.tmdb.org:444/x'));
});
test('backup has matching hashes, complete DB and avatar; tampering is detected',async()=>{
 const {createBackup,verifyBackup}=await import('./server/backup');const avatar='12345678-1234-1234-1234-123456789012.webp';mkdirSync(join(testRoot,'avatars'));writeFileSync(join(testRoot,'avatars',avatar),await sharp({create:{width:256,height:256,channels:3,background:'#456'}}).webp().toBuffer());await db.owner.update({where:{id:ownerId},data:{avatarPath:avatar}});
 const folder=await createBackup(join(testRoot,'cinema.db'),testRoot,join(testRoot,'backups'));await verifyBackup(folder);
 const snapshot=new DatabaseSync(join(folder,'cinema.db'),{readOnly:true});assert.equal(snapshot.prepare('SELECT COUNT(*) AS count FROM WatchEvent').get()?.count,5);snapshot.close();
 const target=join(testRoot,'restore-test');const restore=spawnSync(process.execPath,['--import','tsx','scripts/backup.ts','restore-copy',folder,target],{cwd:process.cwd(),env:process.env,encoding:'utf8'});assert.equal(restore.status,0,restore.stderr);const restored=new DatabaseSync(join(target,'cinema.db'),{readOnly:true});assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM WatchEvent').get()?.n,5);assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM Session').get()?.n,0);assert.equal(restored.prepare('SELECT avatarPath FROM Owner').get()?.avatarPath,avatar);restored.close();
 writeFileSync(join(folder,'avatars',avatar),'corrupt');await assert.rejects(verifyBackup(folder),/CHECKSUM/);
});
test('revoking this app removes tokens and all sessions without altering history',async()=>{
 const {createSession}=await import('./server/session');const session=await createSession(ownerId);
 globalThis.fetch=async(input,init)=>{assert.equal(new URL(String(input)).pathname,'/oauth/revoke');assert.equal(init?.method,'POST');return new Response(null,{status:200});};
 const response=await (await import('../app/api/auth/revoke/route')).POST(new Request('https://cinema.test/api/auth/revoke',{method:'POST',headers:{origin:'https://cinema.test','x-csrf-token':session.csrf,cookie:`cinema_session=${session.token}`}}));
 assert.equal(response.status,200);assert.equal(await db.session.count(),0);assert.equal((await db.owner.findUniqueOrThrow({where:{id:ownerId}})).encryptedAccessToken,null);assert.equal(await db.watchEvent.count(),5);
});

test('an invalid single-use refresh token requires reauthorization and invalidates sessions',async()=>{
 const {encrypt}=await import('./server/crypto');await db.owner.update({where:{id:ownerId},data:{encryptedAccessToken:encrypt('expired'),encryptedRefreshToken:encrypt('invalid-refresh'),tokenExpiresAt:new Date(0)}});
 await (await import('./server/session')).createSession(ownerId);
 globalThis.fetch=async()=>new Response(JSON.stringify({error:'invalid_grant'}),{status:400});
 await assert.rejects((await import('./server/trakt')).accessToken(ownerId),/REAUTHORIZE_REQUIRED/);assert.equal(await db.session.count(),0);assert.equal((await db.owner.findUniqueOrThrow({where:{id:ownerId}})).encryptedRefreshToken,null);
});

test('missing episode runtime does not starve later metadata and summaries supply canonical fields',async()=>{
 const {encrypt}=await import('./server/crypto');await db.owner.update({where:{id:ownerId},data:{encryptedAccessToken:encrypt('metadata-fixture'),encryptedRefreshToken:encrypt('metadata-refresh'),tokenExpiresAt:new Date(Date.now()+86400000)}});
 for(const number of [2,3]){await db.episode.create({data:{id:String(1000+number),showId:'show:11',season:1,number}});await db.watchEvent.create({data:{id:'metadata-fixture-'+number,ownerId,mediaId:'show:11',episodeId:String(1000+number),watchedAt:new Date()}});}
 const paths:string[]=[];globalThis.fetch=async(input,init)=>{assert.equal(init?.method,'GET');const path=new URL(String(input)).pathname;paths.push(path);if(path.endsWith('/translations/zh'))return Response.json([{title:'测试中文名'}]);if(path.endsWith('/episodes/3'))return Response.json({runtime:44});if(path.includes('/episodes/'))return Response.json({runtime:null});return Response.json({title:'Canonical summary',year:2021,ids:{tmdb:20},runtime:101,rating:8,votes:10});};
 const {hydrateMetadata}=await import('./server/metadata');await hydrateMetadata(ownerId,1);await hydrateMetadata(ownerId,1);assert.ok(paths.some(path=>path.endsWith('/episodes/3')));assert.equal((await db.episode.findUniqueOrThrow({where:{id:'1003'}})).runtime,44);assert.ok(await db.media.count({where:{originalTitle:'Canonical summary',year:2021}}));
});

test('history convenience snapshots cannot erase canonical titles or known single-episode runtime',async()=>{
 rows=rows.map(value=>{const row=value as Record<string,unknown>;return row.type==='episode'?{...row,episode:{...(row.episode as Record<string,unknown>),runtime:null}}:row;});
 installHistoryMock();assert.equal((await (await import('./server/sync')).syncOwner(ownerId,true)).complete,true);
 assert.equal((await db.episode.findUniqueOrThrow({where:{id:'1001'}})).runtime,42);
 assert.equal((await db.media.findUniqueOrThrow({where:{id:'movie:10'}})).originalTitle,'Canonical summary');
});

test('Cloudflare HTML failures have a distinct safe error classification',async()=>{
 const {readTrakt,TraktError}=await import('./server/trakt');
 await assert.rejects(readTrakt('/sync/history','fixture',{},async()=>new Response('<html>challenge</html>',{status:403,headers:{'Content-Type':'text/html'}})),error=>error instanceof TraktError&&error.blocked&&error.message==='TRAKT_SECURITY_CHECK');
});

test('sync recovery clears stale failed state even when remote activity matches',async()=>{
 installHistoryMock();
 const {syncOwner}=await import('./server/sync');
 assert.equal((await syncOwner(ownerId,true)).complete,true);
 await db.syncState.update({where:{ownerId},data:{status:'failed',errorCode:'REQUEST_FAILED',retryAt:new Date(0),runId:null}});
 const recovered=await syncOwner(ownerId);
 assert.equal(recovered.complete,true);
 const state=await db.syncState.findUniqueOrThrow({where:{ownerId}});
 assert.equal(state.status,'complete');
 assert.equal(state.errorCode,null);
 assert.equal(state.retryAt,null);
});

test('failing media metadata items back off instead of starving subsequent works',async()=>{
 await db.media.create({data:{id:'movie:991',kind:'movie',originalTitle:'Broken Movie'}});
 await db.media.create({data:{id:'movie:992',kind:'movie',originalTitle:'Healthy Movie'}});
 await db.watchEvent.create({data:{id:'meta-fail-1',ownerId,mediaId:'movie:991',watchedAt:new Date()}});
 await db.watchEvent.create({data:{id:'meta-fail-2',ownerId,mediaId:'movie:992',watchedAt:new Date()}});
 await db.media.updateMany({where:{id:{in:['movie:10','show:11']}},data:{metadataAt:new Date()}});
 globalThis.fetch=async(input)=>{
  const path=new URL(String(input)).pathname;
  if(path==='/movies/991')return new Response(null,{status:500});
  if(path==='/movies/992')return Response.json({title:'Healthy Canonical',year:2025,runtime:95,ids:{},images:{poster:[]}});
  if(path.endsWith('/translations/zh'))return Response.json([{country:'cn',title:'健康影片'}]);
  if(path.includes('/episodes/'))return Response.json({runtime:42});
  return Response.json({});
 };
 const {hydrateMetadata}=await import('./server/metadata');
 await hydrateMetadata(ownerId,1);
 await hydrateMetadata(ownerId,1);
 const healthy=await db.media.findUniqueOrThrow({where:{id:'movie:992'}});
 assert.equal(healthy.chineseTitle,'健康影片');
 assert.ok(healthy.metadataAt!==null);
});

test('cleanupArtwork reclaims unreferenced episodes, expired drafts, and their protected media',async()=>{
 const {cleanupArtwork}=await import('./server/artwork-cleanup');
 await db.media.create({data:{id:'show:777',kind:'episode',originalTitle:'Orphan Show'}});
 await db.episode.create({data:{id:'77701',showId:'show:777',season:1,number:1}});
 await db.media.create({data:{id:'movie:778',kind:'movie',originalTitle:'Draft Movie'}});
 await db.manualHistoryIntent.create({data:{ownerId,kind:'movie',targetTraktId:'778',watchedAt:new Date('2025-01-01T00:00:00Z'),timezone:'UTC',title:'Draft Movie',status:'draft',updatedAt:new Date(Date.now()-45*60000)}});
 await db.media.create({data:{id:'movie:779',kind:'movie',originalTitle:'Uncertain Movie'}});
 await db.manualHistoryIntent.create({data:{ownerId,kind:'movie',targetTraktId:'779',watchedAt:new Date('2025-01-02T00:00:00Z'),timezone:'UTC',title:'Uncertain Movie',status:'uncertain',sentAt:new Date()}});
 const expiredEdit=await db.historyDateEdit.create({data:{ownerId,scope:'event',mode:'custom',timezone:'UTC',status:'draft',createdAt:new Date(Date.now()-45*60000),items:{create:{oldEventId:'old-1',mediaId:'movie:10',targetId:'10',title:'Expired Edit',newWatchedAt:new Date('2025-01-01T00:00:00Z'),originalJson:'{}'}}}});
 const activeEdit=await db.historyDateEdit.create({data:{ownerId,activeOwnerKey:ownerId,scope:'event',mode:'custom',timezone:'UTC',status:'queued',confirmedAt:new Date(),createdAt:new Date(Date.now()-45*60000),items:{create:{oldEventId:'old-2',mediaId:'movie:10',targetId:'10',title:'Active Edit',newWatchedAt:new Date('2025-01-01T00:00:00Z'),originalJson:'{}'}}}});
 const r=await cleanupArtwork(0,Date.now());
 assert.ok(r.episodesRemoved>=1);
 assert.ok(r.intentsRemoved>=1);
 assert.ok(r.dateEditsRemoved>=1);
 assert.equal(await db.media.findUnique({where:{id:'show:777'}}),null);
 assert.equal(await db.media.findUnique({where:{id:'movie:778'}}),null);
 assert.ok(await db.media.findUnique({where:{id:'movie:779'}}),'active uncertain intent still protects media');
 assert.equal(await db.historyDateEdit.findUnique({where:{id:expiredEdit.id}}),null);
 assert.equal(await db.historyDateEditItem.count({where:{operationId:expiredEdit.id}}),0);
 assert.ok(await db.historyDateEdit.findUnique({where:{id:activeEdit.id}}),'active queued edit must be kept');
 await db.historyDateEdit.delete({where:{id:activeEdit.id}});
});

test('episode 500 error advances cursor and backs off instead of blocking subsequent episode runtimes',async()=>{
 await db.syncState.update({where:{ownerId},data:{metadataCursor:null}});
 await db.episode.create({data:{id:'2001',showId:'show:11',season:2,number:1}});
 await db.episode.create({data:{id:'2002',showId:'show:11',season:2,number:2}});
 await db.watchEvent.create({data:{id:'ep-err-1',ownerId,mediaId:'show:11',episodeId:'2001',watchedAt:new Date()}});
 await db.watchEvent.create({data:{id:'ep-err-2',ownerId,mediaId:'show:11',episodeId:'2002',watchedAt:new Date()}});
 await db.media.updateMany({where:{events:{some:{ownerId}}},data:{metadataAt:new Date()}});
 await db.episode.updateMany({where:{id:{notIn:['2001','2002']}},data:{runtime:42}});
 globalThis.fetch=async(input)=>{
  const path=new URL(String(input)).pathname;
  if(path.endsWith('/seasons/2/episodes/1'))return new Response(null,{status:500});
  if(path.endsWith('/seasons/2/episodes/2'))return Response.json({runtime:51,title:'Recovered Ep'});
  return Response.json({});
 };
 const {hydrateMetadata}=await import('./server/metadata');
 await hydrateMetadata(ownerId,1);
 await hydrateMetadata(ownerId,1);
 const ep2=await db.episode.findUniqueOrThrow({where:{id:'2002'}});
 assert.equal(ep2.runtime,51);
});

test('balanced off-window insert plus deletion triggers full reconciliation instead of reporting complete',async()=>{
 installHistoryMock();
 const {syncOwner}=await import('./server/sync');
 assert.equal((await syncOwner(ownerId,true)).complete,true);
 const localBefore=await db.watchEvent.count({where:{ownerId}});
 // Replace one existing record with an off-window backdated record so total count remains identical.
 rows=rows.slice(1);
 rows.push(movie('9223372036854775999','2018-01-01T00:00:00Z'));
 stamp='2026-03-01';
 const delta=await syncOwner(ownerId);
 assert.equal(delta.reconcileRequired,true);
 assert.equal((await syncOwner(ownerId)).complete,true);
 assert.equal(await db.watchEvent.count({where:{ownerId}}),localBefore);
 assert.ok(await db.watchEvent.findUnique({where:{id:'9223372036854775999'}}));
});

test('resumed delta still detects balanced off-window swap and holds lease until exit',async()=>{
 installHistoryMock();
 const {syncOwner}=await import('./server/sync');
 assert.equal((await syncOwner(ownerId,true)).complete,true);
 // Swap an existing record with an off-window backdated record, then fail page 1 on the first recent run.
 rows=rows.slice(1);
 rows.push(movie('9223372036854776001','2017-01-01T00:00:00Z'));
 stamp='2026-03-02';
 failPage=1;
 const firstTry=await syncOwner(ownerId);
 assert.ok(firstTry.error);
 // Resume after recovery: must still detect off-window swap and require full reconciliation without releasing another caller lease.
 failPage=0;
 await db.syncState.update({where:{ownerId},data:{retryAt:null}});
 const resumed=await syncOwner(ownerId);
 assert.equal(resumed.reconcileRequired,true);
 // Verify lease ownership check: if another caller holds a newer lease when syncOwner exits (whether via reconcileRequired or normal exit), finally must NOT wipe it.
 rows=rows.slice(1);
 rows.push(movie('9223372036854776002','2016-01-01T00:00:00Z'));
 stamp='2026-03-03';
 assert.equal((await syncOwner(ownerId)).complete,true); // full sync from previous reconcileRequired
 rows=rows.slice(1);
 rows.push(movie('9223372036854776003','2015-01-01T00:00:00Z'));
 stamp='2026-03-04';
 const caller2Lease=new Date(Date.now()+999999);
 let tookOverLease=false;
 const delegate=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const u=new URL(String(input));
  const res=await delegate(input,init);
  // After the page-1 history check, simulate Caller 2 holding a different lease token before syncOwner's finally runs.
  if(!tookOverLease&&u.pathname==='/sync/history'&&u.searchParams.get('limit')==='1'){
   tookOverLease=true;
   await db.syncState.update({where:{ownerId},data:{leaseExpiresAt:caller2Lease}});
  }
  return res;
 };
 try{
  const req=await syncOwner(ownerId);
  assert.equal(req.reconcileRequired,true);
  const afterState=await db.syncState.findUniqueOrThrow({where:{ownerId}});
  assert.equal(afterState.leaseExpiresAt?.getTime(),caller2Lease.getTime(),'finally must not clear another caller lease');
  assert.deepEqual(await syncOwner(ownerId),{busy:true});
 }finally{
  globalThis.fetch=delegate;
  await db.syncState.update({where:{ownerId},data:{leaseExpiresAt:null}});
 }
 assert.equal((await syncOwner(ownerId)).complete,true);
 assert.ok(await db.watchEvent.findUnique({where:{id:'9223372036854776003'}}));
});

test('loadArchiveSnapshot and /api/archive read within one transaction and preserve 304 ETag consistency',async()=>{
 await db.media.create({data:{id:'movie:race-film',kind:'movie',originalTitle:'Race Film',chineseTitle:'并发测试电影'}});
 await db.watchEvent.create({data:{id:'race-ev-1',ownerId,mediaId:'movie:race-film',watchedAt:new Date('2026-04-01T10:00:00Z')}});
 const {loadArchiveSnapshot,archiveEtag}=await import('./server/archive');
 const session=await (await import('./server/session')).createSession(ownerId);
 const route=await import('../app/api/archive/route');
 const etag=await archiveEtag(ownerId,session.csrf);
 const notModified=await route.GET(new Request('https://cinema.test/api/archive',{headers:{cookie:`cinema_session=${session.token}`,'if-none-match':etag}}));
 assert.equal(notModified.status,304);
 // Race snapshot reads with deleting the movie's last WatchEvent + Media row; returned pairs must always stay internally consistent.
 const results=await Promise.all([
  loadArchiveSnapshot(ownerId,session.csrf),
  db.$transaction(async tx=>{
   await tx.watchEvent.deleteMany({where:{id:'race-ev-1',ownerId}});
   await tx.media.deleteMany({where:{id:'movie:race-film'}});
  }),
  loadArchiveSnapshot(ownerId,session.csrf),
 ]);
 for(const snap of [results[0],results[2]]){
  const workIds=new Set(snap.data.works.map(w=>w.id));
  for(const ev of snap.data.events){
   assert.ok(workIds.has(ev.workId),`event ${ev.id} references missing work ${ev.workId}`);
  }
 }
 const fresh=await route.GET(new Request('https://cinema.test/api/archive',{headers:{cookie:`cinema_session=${session.token}`}}));
 assert.equal(fresh.status,200);
 const body=await fresh.json() as {events:{workId:string}[];works:{id:string}[]};
 const bodyWorkIds=new Set(body.works.map(w=>w.id));
 assert.ok(body.events.every(ev=>bodyWorkIds.has(ev.workId)));
 assert.equal(bodyWorkIds.has('movie:race-film'),false);
});

test('loadArchive retains movies that have a ticketStub even after all watch events are removed',async()=>{
 await db.media.create({data:{id:'movie:888',kind:'movie',originalTitle:'Ticket Only Film',chineseTitle:'孤立票根电影'}});
 await db.ticketStub.create({data:{ownerId,mediaId:'movie:888',filePath:'aaaaaaaa-1111-2222-3333-444444444444.webp'}});
 const archive=await (await import('./server/archive')).loadArchive(ownerId,'csrf-token');
 const work=archive.works.find(w=>w.id==='movie:888');
 assert.ok(work,'movie with ticketStub must remain in works when watchEvent count is 0');
 assert.ok(work.ticketStub?.includes('movie%3A888'));
});

test('resuming sync after last page fails during final verification does not fetch past the last page',async()=>{
 installHistoryMock();
 const requestedPages:number[]=[];
 const delegate=globalThis.fetch;
 let failVerify=true;
 globalThis.fetch=async(input,init)=>{
  const u=new URL(String(input));
  if(u.pathname==='/sync/history'&&!u.searchParams.has('limit')||(u.pathname==='/sync/history'&&u.searchParams.get('limit')!=='1')){
   requestedPages.push(Number(u.searchParams.get('page')));
  }
  if(u.pathname==='/sync/last_activities'&&requestedPages.length>0&&failVerify){
   return new Response(null,{status:403});
  }
  return delegate(input,init);
 };
 try{
  const {syncOwner}=await import('./server/sync');
  stamp='2026-04-10';
  const first=await syncOwner(ownerId,true);
  assert.ok(first.error);
  failVerify=false;
  const pagesBeforeResume=[...requestedPages];
  await db.syncState.update({where:{ownerId},data:{retryAt:null}});
  const resumed=await syncOwner(ownerId);
  assert.equal(resumed.complete,true);
  assert.equal(requestedPages.length,pagesBeforeResume.length,'resume in verifying phase must not request page+1');
 }finally{
  globalThis.fetch=delegate;
 }
});

test('in-flight token refresh neither overwrites nor clears credentials from a concurrent re-login',async()=>{
 const {saveTokens,accessToken}=await import('./server/trakt');
 const {decrypt}=await import('./server/crypto');
 const {createSession}=await import('./server/session');
 // Case A: stale refresh succeeds AFTER re-login -> re-login tokens must stay intact.
 await db.owner.update({where:{id:ownerId},data:{encryptedAccessToken:'old-enc-a',encryptedRefreshToken:'old-enc-r',tokenExpiresAt:new Date(0)}});
 const {encrypt}=await import('./server/crypto');
 await saveTokens(ownerId,{access_token:'old-acc',refresh_token:'old-ref',expires_in:10,created_at:0,token_type:'bearer'});
 await db.owner.update({where:{id:ownerId},data:{tokenExpiresAt:new Date(0)}});
 globalThis.fetch=async(input)=>{
  const u=new URL(String(input));
  assert.equal(u.pathname,'/oauth/token');
  await saveTokens(ownerId,{access_token:'fresh-login-acc',refresh_token:'fresh-login-ref',expires_in:86400,created_at:Math.floor(Date.now()/1000),token_type:'bearer'});
  return Response.json({access_token:'stale-refresh-acc',refresh_token:'stale-refresh-ref',expires_in:3600,created_at:Math.floor(Date.now()/1000),token_type:'bearer'});
 };
 const tokA=await accessToken(ownerId);
 assert.equal(tokA,'fresh-login-acc');
 assert.equal(decrypt((await db.owner.findUniqueOrThrow({where:{id:ownerId}})).encryptedAccessToken!),'fresh-login-acc');

 // Case B: stale refresh fails with 400 invalid_grant AFTER re-login -> fresh tokens & session must NOT be wiped.
 await db.owner.update({where:{id:ownerId},data:{tokenExpiresAt:new Date(0)}});
 await createSession(ownerId);
 const sessionCountBefore=await db.session.count({where:{ownerId}});
 globalThis.fetch=async()=>{
  await saveTokens(ownerId,{access_token:'fresh-login-acc-2',refresh_token:'fresh-login-ref-2',expires_in:86400,created_at:Math.floor(Date.now()/1000),token_type:'bearer'});
  return new Response(JSON.stringify({error:'invalid_grant'}),{status:400});
 };
 const tokB=await accessToken(ownerId);
 assert.equal(tokB,'fresh-login-acc-2');
 assert.equal(decrypt((await db.owner.findUniqueOrThrow({where:{id:ownerId}})).encryptedAccessToken!),'fresh-login-acc-2');
 assert.equal(await db.session.count({where:{ownerId}}),sessionCountBefore);
 void encrypt;
});

test('malformed Retry-After headers fall back cleanly without breaking sync backoff or storing Invalid Date',async()=>{
 const {parseRetryAfter,readTrakt,TraktError}=await import('./server/trakt');
 assert.equal(parseRetryAfter('not-a-number',60),60);
 assert.equal(parseRetryAfter('-5',60),60);
 assert.equal(parseRetryAfter('Infinity',60),60);
 assert.equal(parseRetryAfter('99999999',60),86400);
 const futureHttp=new Date(Date.now()+120000).toUTCString();
 const parsedDate=parseRetryAfter(futureHttp,60);
 assert.ok(parsedDate>=115&&parsedDate<=125);
 await assert.rejects(
  readTrakt('/sync/history','fixture',{},async()=>new Response('',{status:429,headers:{'Retry-After':'garbage-header'}})),
  err=>err instanceof TraktError&&Number.isFinite(err.retryAfter)&&err.retryAfter>=1
 );
 globalThis.fetch=async()=>new Response('',{status:429,headers:{'Retry-After':'garbage-header'}});
 const res=await (await import('./server/sync')).syncOwner(ownerId,true);
 assert.equal(res.error,'RATE_LIMITED');
 const state=await db.syncState.findUniqueOrThrow({where:{ownerId}});
 assert.equal(state.errorCode,'RATE_LIMITED');
 assert.ok(state.retryAt instanceof Date&&Number.isFinite(state.retryAt.getTime()));
});

test('daily backup still runs when Trakt auth configuration is missing',async()=>{
 const oldClientId=process.env.TRAKT_CLIENT_ID;
 process.env.TRAKT_CLIENT_ID='';
 const {rmSync,existsSync}=await import('node:fs');
 rmSync(join(testRoot,'backups'),{recursive:true,force:true});
 try{
  const {runWorkerTick}=await import('./server/worker');
  await runWorkerTick();
  assert.ok(existsSync(join(testRoot,'backups','.last-success')));
 }finally{
  process.env.TRAKT_CLIENT_ID=oldClientId;
 }
});

test('manual sync defaults to latest check-only, resumes interrupted full runs, deduplicates double clicks, and isolates metadata failures',async()=>{
 const {createSession}=await import('./server/session');
 const syncRoute=await import('../app/api/sync/route');
 const {executeManualSync}=await import('./server/sync');
 const {encrypt}=await import('./server/crypto');
 await db.owner.update({where:{id:ownerId},data:{encryptedAccessToken:encrypt('fixture-access'),encryptedRefreshToken:encrypt('fixture-refresh'),tokenExpiresAt:new Date(Date.now()+86400000)}});
 await db.syncState.update({where:{ownerId},data:{retryAt:null,leaseExpiresAt:null,errorCode:null,runId:null}});
 const session=await createSession(ownerId);
 const headers={origin:'https://cinema.test','x-csrf-token':session.csrf,cookie:`cinema_session=${session.token}`,'content-type':'application/json'};

 // Invalid mode rejected cleanly.
 const badReq=await syncRoute.POST(new Request('https://cinema.test/api/sync',{method:'POST',headers,body:JSON.stringify({mode:'bogus'})}));
 assert.equal(badReq.status,400);

 // Seed complete baseline via full sync, then check unchanged in 'latest' mode -> 0 history requests.
 stamp='2026-05-01';
 installHistoryMock();
 const baseRun=await executeManualSync(ownerId,'full');
 assert.equal(baseRun.complete,true);
 const beforeState=await db.syncState.findUniqueOrThrow({where:{ownerId}});
 const beforeSuccessful=beforeState.lastSuccessfulAt?.getTime();
 const beforeChecked=beforeState.lastCheckedAt?.getTime()??0;

 const seenPaths:string[]=[];
 const showRefreshPaths:string[]=[];
 const delegate=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  const u=new URL(String(input));
  seenPaths.push(u.pathname);
  if(u.pathname.startsWith('/shows/')&&!u.pathname.includes('/episodes/'))showRefreshPaths.push(u.pathname);
  // Force metadata fetch for missing work info to fail with 500 without marking sync failed.
  if(u.pathname.startsWith('/movies/')||u.pathname.startsWith('/shows/'))return new Response(null,{status:500});
  return delegate(input,init);
 };
 try{
  const unchanged=await executeManualSync(ownerId,'latest');
  assert.equal(unchanged.unchanged,true);
  assert.equal(seenPaths.filter(p=>p==='/sync/history').length,0,'unchanged latest sync must not query history pages');
  assert.equal(showRefreshPaths.length,0,'latest manual sync must not force-refresh non-stale shows');
  const afterUnchanged=await db.syncState.findUniqueOrThrow({where:{ownerId}});
  assert.equal(afterUnchanged.status,'complete');
  assert.equal(afterUnchanged.lastSuccessfulAt?.getTime(),beforeSuccessful);
  assert.ok((afterUnchanged.lastCheckedAt?.getTime()??0)>beforeChecked);

  // Recent addition (within incremental 7-day window) uses start_at window and survives metadata failure cleanly.
  rows.unshift(movie('9223372036854776555',new Date().toISOString()));
  stamp='2026-05-02';
  await db.media.updateMany({data:{metadataAt:new Date()}}); // mark existing works fresh
  const recentQueries:string[]=[];
  globalThis.fetch=async(input,init)=>{
   const u=new URL(String(input));
   if(u.pathname==='/sync/history')recentQueries.push(u.search);
   if(u.pathname.startsWith('/movies/')||u.pathname.startsWith('/shows/'))return new Response(null,{status:500});
   return delegate(input,init);
  };
  const recentRes=await executeManualSync(ownerId,'latest');
  assert.equal(recentRes.complete,true);
  assert.ok(recentQueries.some(q=>q.includes('start_at=')),'recent mode must request incremental start_at');
  const afterRecent=await db.syncState.findUniqueOrThrow({where:{ownerId}});
  assert.equal(afterRecent.status,'complete');
  assert.equal(afterRecent.errorCode,null);
  assert.equal(afterRecent.mode,'recent');

  // Interrupted full reconciliation is resumed when user triggers mode='full' again.
  rows.push(movie('9223372036854776556','2019-01-01T00:00:00Z'));
  stamp='2026-05-03';
  failPage=2;
  globalThis.fetch=delegate;
  const interruptedFull=await executeManualSync(ownerId,'full');
  assert.equal(interruptedFull.error,'TRAKT_HTTP_403');
  const midState=await db.syncState.findUniqueOrThrow({where:{ownerId}});
  assert.equal(midState.status,'failed');
  assert.equal(midState.mode,'full');
  assert.equal(midState.completedPage,1);
  assert.ok(midState.completedCount>0);

  failPage=0;
  await db.syncState.update({where:{ownerId},data:{retryAt:null}});
  const requestedPages:number[]=[];
  globalThis.fetch=async(input,init)=>{
   const u=new URL(String(input));
   if(u.pathname==='/sync/history')requestedPages.push(Number(u.searchParams.get('page')));
   if(u.pathname.startsWith('/movies/')||u.pathname.startsWith('/shows/'))return new Response(null,{status:500});
   return delegate(input,init);
  };
  const resumedFull=await executeManualSync(ownerId,'full');
  assert.equal(resumedFull.complete,true);
  assert.ok(!requestedPages.includes(1),'resumed full sync must continue from page 2 instead of resetting to 0');

  // Concurrent / double-click POST /api/sync returns 202 busy when lease is active.
  await db.syncState.update({where:{ownerId},data:{leaseExpiresAt:new Date(Date.now()+60000)}});
  const busyRes=await syncRoute.POST(new Request('https://cinema.test/api/sync',{method:'POST',headers,body:JSON.stringify({mode:'latest'})}));
  assert.equal(busyRes.status,202);
  const busyJson=await busyRes.json() as {busy?:boolean;sync?:{status:string}};
  assert.equal(busyJson.busy,true);
  assert.ok(busyJson.sync);
  await db.syncState.update({where:{ownerId},data:{leaseExpiresAt:null}});
 }finally{
  globalThis.fetch=delegate;
 }
});

test('lastCheckedAt transitions atomically with running state, and slow metadata hydration neither marks sync busy nor duplicates',async()=>{
 const {createSession}=await import('./server/session');
 const syncRoute=await import('../app/api/sync/route');
 const {executeManualSync,isOwnerSyncQueued}=await import('./server/sync');
 const {hydrateMetadata}=await import('./server/metadata');
 const session=await createSession(ownerId);
 const headers={origin:'https://cinema.test','x-csrf-token':session.csrf,cookie:`cinema_session=${session.token}`,'content-type':'application/json'};
 await db.syncState.update({where:{ownerId},data:{retryAt:null,leaseExpiresAt:null,errorCode:null,runId:null,status:'complete'}});
 const initial=await db.syncState.findUniqueOrThrow({where:{ownerId}});
 const baselineChecked=initial.lastCheckedAt?.getTime()??0;

 // Trigger activity change and assert SyncState never exposes new lastCheckedAt with stale complete status.
 rows.unshift(movie('9223372036854776600',new Date().toISOString()));
 stamp='2026-05-04';
 installHistoryMock();
 const delegate=globalThis.fetch;
 let checkedBeforeHistory:number|undefined;
 let statusAtHistory:string|undefined;
 let checkedAtHistory:number|undefined;
 globalThis.fetch=async(input,init)=>{
  const u=new URL(String(input));
  if(u.pathname==='/sync/last_activities'){
   const res=await delegate(input,init);
   if(checkedBeforeHistory===undefined){
    checkedBeforeHistory=(await db.syncState.findUniqueOrThrow({where:{ownerId}})).lastCheckedAt?.getTime();
   }
   return res;
  }
  if(u.pathname==='/sync/history'&&!statusAtHistory){
   const st=await db.syncState.findUniqueOrThrow({where:{ownerId}});
   statusAtHistory=st.status;
   checkedAtHistory=st.lastCheckedAt?.getTime();
   return delegate(input,init);
  }
  if(u.pathname.startsWith('/movies/')||u.pathname.startsWith('/shows/'))return new Response(null,{status:500});
  return delegate(input,init);
 };
 try{
  const res=await executeManualSync(ownerId,'latest');
  assert.equal(res.complete,true);
  assert.equal(checkedBeforeHistory,baselineChecked,'lastCheckedAt must not advance before running status transition');
  assert.equal(statusAtHistory,'running');
  assert.ok((checkedAtHistory??0)>baselineChecked);

  // Now stall metadata hydration and verify manual sync queue is already released while metadata deduplicates.
  await db.media.updateMany({where:{id:'movie:10'},data:{metadataAt:null}});
  let metadataFetchCount=0;
  let releaseMetadata!:()=>void;
  const metadataGate=new Promise<void>(resolve=>{releaseMetadata=resolve;});
  let enteredMetadata!:()=>void;
  const metadataStarted=new Promise<void>(resolve=>{enteredMetadata=resolve;});
  globalThis.fetch=async(input,init)=>{
   const u=new URL(String(input));
   if(u.pathname.startsWith('/movies/')){
    metadataFetchCount++;
    if(metadataFetchCount===1)enteredMetadata();
    await metadataGate;
    return new Response(null,{status:404});
   }
   return delegate(input,init);
  };
  const firstRun=executeManualSync(ownerId,'latest');
  await metadataStarted;
  assert.equal(isOwnerSyncQueued(ownerId),false,'sync queue must clear before metadata hydration finishes');
  // Concurrent hydrateMetadata must deduplicate, while POST /api/sync must queue instead of returning busy.
  const dupMetadata=hydrateMetadata(ownerId,12,false);
  const secondPost=await syncRoute.POST(new Request('https://cinema.test/api/sync',{method:'POST',headers,body:JSON.stringify({mode:'latest'})}));
  assert.equal(secondPost.status,202);
  const postJson=await secondPost.json() as {queued?:boolean;busy?:boolean};
  assert.equal(postJson.queued,true);
  assert.equal(postJson.busy,undefined);
  releaseMetadata();
  await Promise.all([firstRun,dupMetadata]);
  while(isOwnerSyncQueued(ownerId))await new Promise(r=>setTimeout(r,10));
  assert.equal(metadataFetchCount,1,'concurrent metadata hydration must deduplicate');
 }finally{
  globalThis.fetch=delegate;
 }
});

test('incremental sync recognizes recent and backdated confirmed manual additions without full rescan, while still catching real discrepancies',async()=>{
 const {createSession}=await import('./server/session');
 const syncRoute=await import('../app/api/sync/route');
 const {syncOwner}=await import('./server/sync');
 const session=await createSession(ownerId);
 const cookie={cookie:`cinema_session=${session.token}`};
 await db.syncState.update({where:{ownerId},data:{retryAt:null,leaseExpiresAt:null,errorCode:null,runId:null}});
 stamp='2026-06-01';
 installHistoryMock();
 assert.equal((await syncOwner(ownerId,true)).complete,true);
 const reconciledBefore=(await db.syncState.findUniqueOrThrow({where:{ownerId}})).lastReconciledAt!.getTime();

 const delegate=globalThis.fetch;
 const itemRows=new Map<string,unknown[]>();
 globalThis.fetch=async(input,init)=>{
  const u=new URL(String(input));
  if(u.pathname.startsWith('/sync/history/movies/')){
   const list=itemRows.get(u.pathname.split('/').at(-1)!)||[];
   return Response.json(list,{headers:{'X-Pagination-Page':'1','X-Pagination-Page-Count':String(Math.max(1,Math.ceil(list.length/100))),'X-Pagination-Item-Count':String(list.length)}});
  }
  return delegate(input,init);
 };
 try{
  // 1) Recent manual addition already written locally via commitRemote semantics.
  const recentAt=new Date();
  const recentEvent={id:'9223372036854777101',watched_at:recentAt.toISOString(),action:'scrobble',type:'movie',movie:{title:'Manual Recent',year:2025,runtime:110,ids:{trakt:77,tmdb:770}}};
  rows.unshift(recentEvent);
  await db.media.create({data:{id:'movie:77',kind:'movie',originalTitle:'Manual Recent',year:2025,tmdbId:'770',runtime:110}});
  await db.watchEvent.create({data:{id:recentEvent.id,ownerId,mediaId:'movie:77',watchedAt:recentAt,action:'scrobble'}});
  await db.manualHistoryIntent.create({
   data:{ownerId,kind:'movie',targetTraktId:'77',watchedAt:recentAt,timezone:'Asia/Shanghai',title:'Manual Recent',status:'confirmed',remoteEventId:recentEvent.id,confirmedAt:new Date(Date.now()+10)},
  });
  await db.syncState.update({where:{ownerId},data:{lastCheckedAt:null,runId:null,completedPage:0,completedCount:0,expectedCount:null,mode:'recent',status:'pending'}});
  stamp='2026-06-02';

  const getBefore=await (await syncRoute.GET(new Request('https://cinema.test/api/sync',{headers:cookie}))).json() as {sync:{pendingManualKind:string|null}};
  assert.equal(getBefore.sync.pendingManualKind,'movie');

  const resRecent=await syncOwner(ownerId);
  assert.equal(resRecent.complete,true,'recent confirmed manual addition must complete without full reconcile');
  assert.equal((await db.syncState.findUniqueOrThrow({where:{ownerId}})).lastReconciledAt?.getTime(),reconciledBefore);
  const getAfter=await (await syncRoute.GET(new Request('https://cinema.test/api/sync',{headers:cookie}))).json() as {sync:{pendingManualKind:string|null;mode:string|null}};
  assert.equal(getAfter.sync.pendingManualKind,null);
  assert.equal(getAfter.sync.mode,'recent');

  // 2) Backdated manual addition (outside incremental window) verified via per-item history lookup.
  const oldAt=new Date('2018-01-01T12:00:00.000Z');
  const oldEvent={id:'9223372036854777102',watched_at:oldAt.toISOString(),action:'scrobble',type:'movie',movie:{title:'Manual Backdated',year:2018,runtime:100,ids:{trakt:88,tmdb:880}}};
  rows.push(oldEvent);
  itemRows.set('88',[oldEvent]);
  await db.media.create({data:{id:'movie:88',kind:'movie',originalTitle:'Manual Backdated',year:2018,tmdbId:'880',runtime:100}});
  await db.watchEvent.create({data:{id:oldEvent.id,ownerId,mediaId:'movie:88',watchedAt:oldAt,action:'scrobble'}});
  await db.manualHistoryIntent.create({
   data:{ownerId,kind:'movie',targetTraktId:'88',watchedAt:oldAt,timezone:'Asia/Shanghai',title:'Manual Backdated',status:'confirmed',remoteEventId:oldEvent.id,confirmedAt:new Date(Date.now()+20)},
  });
  await db.syncState.update({where:{ownerId},data:{lastCheckedAt:null,runId:null,completedPage:0,completedCount:0,expectedCount:null,mode:'recent',status:'pending'}});
  stamp='2026-06-03';

  const resOld=await syncOwner(ownerId);
  assert.equal(resOld.complete,true,'backdated confirmed manual addition must verify per-item and avoid full reconcile');
  assert.equal((await db.syncState.findUniqueOrThrow({where:{ownerId}})).mode,'recent');

  // 3) Real remote discrepancy alongside or after manual add still triggers full reconcile.
  rows.pop(); // remove an old item remotely so server count mismatches local count
  stamp='2026-06-04';
  const resMismatch=await syncOwner(ownerId);
  assert.equal(resMismatch.reconcileRequired,true,'real remote count mismatch must still trigger full reconciliation');
 }finally{
  globalThis.fetch=delegate;
 }
});
