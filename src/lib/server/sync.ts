import { randomUUID } from 'node:crypto';
import { db } from './db';
import { ownerRead, TraktError } from './trakt';
import { normalizeHistory, object, string } from './history';
import { safeError } from './config';
import { hydrateMetadata } from './metadata';
import { verifyRemoteHistoryEventId } from './manual-history';
const DAY=86400000;
const queuedSyncOwners=((globalThis as unknown as {cinemaQueuedSyncOwners?:Set<string>}).cinemaQueuedSyncOwners??=new Set());
export function isOwnerSyncQueued(ownerId:string){return queuedSyncOwners.has(ownerId);}
export function beginManualSyncQueue(ownerId:string){queuedSyncOwners.add(ownerId);}
export async function executeManualSync(ownerId:string,mode:'latest'|'full'='latest'){
 queuedSyncOwners.add(ownerId);
 let result:Awaited<ReturnType<typeof syncOwner>>;
 try{
  result=await syncOwner(ownerId,mode==='full');
  if(result.reconcileRequired)result=await syncOwner(ownerId);
 }finally{queuedSyncOwners.delete(ownerId);}
 if(!result.error&&!result.busy&&!result.deferred){
  try{await hydrateMetadata(ownerId,12,mode==='full');}
  catch(error){console.warn(`[sync] ${new Date().toISOString()} metadata hydration failed: ${safeError(error)}`);}
 }
 return result;
}
// Cover the worst-case bounded network retries and token refresh before a page heartbeat.
const SYNC_LEASE_MS=10*60*1000;
function activityStamp(data:unknown){const v=object(data),mw=string(object(v.movies).watched_at),ew=string(object(v.episodes).watched_at),all=string(v.all);if(mw||ew)return `${all}|${mw}|${ew}`;return all||JSON.stringify(v);}
function historyPart(stamp:string|null|undefined){if(!stamp)return null;const idx=stamp.indexOf('|');return idx>=0?stamp.slice(idx+1):stamp;}
function isFullMode(mode:string|null|undefined){return mode==='full'||(!!mode&&mode.startsWith('full:'));}
function isVerifyingMode(mode:string|null|undefined){return mode==='full:verifying'||mode==='recent:verifying'||mode==='full:verifying:resumed'||mode==='recent:verifying:resumed';}
function toResumedMode(mode:string|null|undefined){return `${isFullMode(mode)?'full':'recent'}${isVerifyingMode(mode)?':verifying':''}:resumed`;}
export const SYNC_STATE_SELECT={status:true,mode:true,completedPage:true,completedCount:true,expectedCount:true,lastCheckedAt:true,lastSuccessfulAt:true,lastReconciledAt:true,errorCode:true,retryAt:true} as const;
export async function pendingManualKindForSync(
 queryDb:{manualHistoryIntent:{findFirst:typeof db.manualHistoryIntent.findFirst}},
 ownerId:string,
 lastSuccessfulAt:Date|null|undefined,
):Promise<'movie'|'episode'|null>{
 const row=await queryDb.manualHistoryIntent.findFirst({
  where:{ownerId,status:'confirmed',...(lastSuccessfulAt?{confirmedAt:{gte:lastSuccessfulAt}}:{})},
  orderBy:{confirmedAt:'desc'},
  select:{kind:true},
 });
 return row?.kind==='episode'?'episode':row?.kind==='movie'?'movie':null;
}
export function serializeSyncState(
 sync:{status:string;mode:string|null;completedPage:number;completedCount:number;expectedCount:number|null;lastCheckedAt:Date|null;lastSuccessfulAt:Date|null;lastReconciledAt:Date|null;errorCode:string|null;retryAt:Date|null}|null,
 pendingManualKind:'movie'|'episode'|null=null,
){
 return {
  status:sync?.status||'pending',
  mode:sync?.mode??null,
  completedPage:sync?.completedPage??0,
  completedCount:sync?.completedCount||0,
  expectedCount:sync?.expectedCount??null,
  lastCheckedAt:sync?.lastCheckedAt?.toISOString()??null,
  lastSuccessfulAt:sync?.lastSuccessfulAt?.toISOString()??null,
  lastReconciledAt:sync?.lastReconciledAt?.toISOString()??null,
  errorCode:sync?.errorCode||null,
  retryAt:sync?.retryAt?.toISOString()??null,
  pendingManualKind,
 };
}
export async function syncOwner(ownerId:string,forceFull=false){
 if(await db.historyDateEdit.findFirst({where:{activeOwnerKey:ownerId}}))return {busy:true};
 await db.syncState.upsert({where:{ownerId},create:{ownerId},update:{}});
 let leaseToken=new Date(Date.now()+SYNC_LEASE_MS+Math.floor(Math.random()*1000));
 const acquired=await db.syncState.updateMany({where:{ownerId,OR:[{leaseExpiresAt:null},{leaseExpiresAt:{lt:new Date()}}]},data:{leaseExpiresAt:leaseToken}});
 if(!acquired.count)return {busy:true};
 let runId='';
 let prevCheckedMs=0;
 try {
  let state=await db.syncState.findUniqueOrThrow({where:{ownerId}});
  prevCheckedMs=state.lastCheckedAt?.getTime()??0;
  if(!forceFull&&state.retryAt&&state.retryAt.getTime()>Date.now())return {deferred:true};
  const activity=activityStamp((await ownerRead(ownerId,'/sync/last_activities')).data);
  const checkedAt=new Date(Math.max(Date.now(),prevCheckedMs+1));
  const prevCapturedActivity=state.capturedActivity;
  const resume=!!state.runId&&state.capturedActivity===activity&&state.status!=='complete'&&(!forceFull||isFullMode(state.mode));
  if(!resume){
   const full=forceFull||!state.lastSuccessfulAt||!state.lastReconciledAt||Date.now()-state.lastReconciledAt.getTime()>DAY;
   if(!full&&state.status==='complete'&&state.capturedActivity===activity){
    await db.syncState.update({where:{ownerId},data:{lastCheckedAt:checkedAt,...(state.errorCode||state.retryAt?{errorCode:null,retryAt:null}:{})}});
    prevCheckedMs=checkedAt.getTime();
    return {unchanged:true};
   }
   runId=randomUUID();
   const runSnapshotAt=new Date(Math.max(Date.now(),(state.lastSuccessfulAt?.getTime()??0)+1));
   const historyChanged=historyPart(prevCapturedActivity)!==historyPart(activity);
   state=await db.syncState.update({where:{ownerId},data:{status:'running',lastCheckedAt:checkedAt,runId,completedPage:0,completedCount:0,expectedCount:null,mode:full?'full':'recent',rangeStart:full?null:new Date(state.lastSuccessfulAt!.getTime()-7*DAY).toISOString().slice(0,10),snapshotAt:runSnapshotAt,lastActivityAt:historyChanged?runSnapshotAt:null,capturedActivity:activity,errorCode:null,retryAt:null}});
   prevCheckedMs=checkedAt.getTime();
  }else{
   runId=state.runId!;
   state=await db.syncState.update({where:{ownerId},data:{status:'running',lastCheckedAt:checkedAt,errorCode:null,mode:toResumedMode(state.mode)}});
   prevCheckedMs=checkedAt.getTime();
  }
  const full=isFullMode(state.mode);
  const verifying=isVerifyingMode(state.mode);
  const wasResumed=!!state.mode?.endsWith(':resumed');
  let page=state.completedPage+1,total=state.expectedCount??0,pages=1,newInWindow=0;
  // Skip fetching pages when all pages were already stored and only final verification failed.
  if(!verifying){
   // Each transaction commits one page. A crash resumes only if the activity stamp is unchanged.
   do {
    const query:Record<string,string>={page:String(page),limit:'100',extended:'full'};
    if(!full&&state.rangeStart)query.start_at=state.rangeStart;
    const response=await ownerRead(ownerId,'/sync/history',query);
    const current=Number(response.headers.get('X-Pagination-Page')),pageCount=Number(response.headers.get('X-Pagination-Page-Count')),itemCount=Number(response.headers.get('X-Pagination-Item-Count'));
    if(!Array.isArray(response.data)||!Number.isSafeInteger(itemCount)||itemCount<0||!response.headers.has('X-Pagination-Item-Count')||!Number.isSafeInteger(pageCount)||pageCount<0||current!==page)throw new Error('PAGINATION_INVALID');
    if(page>1&&state.expectedCount!==null&&state.expectedCount!==itemCount)throw new Error('HISTORY_CHANGED');
    total=itemCount;pages=Math.max(pageCount,1);
    const rows=response.data.map(normalizeHistory);
    if(!rows.length&&total>0)throw new Error('PAGINATION_INCOMPLETE');
    const nextLease=new Date(Date.now()+SYNC_LEASE_MS+Math.floor(Math.random()*1000));
    await db.$transaction(async tx=>{
     const existingIds=full?null:new Set((await tx.watchEvent.findMany({where:{ownerId,id:{in:rows.map(r=>r.event.id)}},select:{id:true}})).map(r=>r.id));
     for(const row of rows){
      if(existingIds&&!existingIds.has(row.event.id))newInWindow++;
      // History snapshots must not overwrite hydrated translations, artwork or current metadata.
      await tx.media.upsert({where:{id:row.media.id},create:row.media,update:{}});
      if(row.episode)await tx.episode.upsert({where:{id:row.episode.id},create:row.episode,update:{...row.episode,runtime:row.episode.runtime??undefined,title:row.episode.title??undefined}});
      await tx.watchEvent.upsert({where:{id:row.event.id},create:{...row.event,ownerId,seenRun:runId,...(state.snapshotAt?{importedAt:state.snapshotAt}:{})},update:{...row.event,seenRun:runId}});
     }
     await tx.syncState.update({where:{ownerId},data:{completedPage:page,expectedCount:total,completedCount:{increment:rows.length},leaseExpiresAt:nextLease}});
    },{timeout:30000});
    leaseToken=nextLease;
    state=await db.syncState.findUniqueOrThrow({where:{ownerId}});page++;
   }while(page<=pages);
   await db.syncState.update({where:{ownerId},data:{mode:`${full?'full':'recent'}:verifying${wasResumed?':resumed':''}`}});
  }
  const after=activityStamp((await ownerRead(ownerId,'/sync/last_activities')).data);
  if(after!==activity)throw new Error('HISTORY_CHANGED');
  const seen=await db.watchEvent.count({where:{ownerId,seenRun:runId}});
  if(seen!==total)throw new Error('PAGINATION_INCOMPLETE');
  if(full){
   await db.$transaction([db.watchEvent.deleteMany({where:{ownerId,OR:[{seenRun:null},{seenRun:{not:runId}}]}}),db.syncState.update({where:{ownerId},data:{lastReconciledAt:new Date()}})]);
  }else{
   const check=await ownerRead(ownerId,'/sync/history',{limit:'1',page:'1'});
   const serverCount=Number(check.headers.get('X-Pagination-Item-Count'));
   if(!check.headers.has('X-Pagination-Item-Count')||!Number.isSafeInteger(serverCount))throw new Error('PAGINATION_INVALID');
   const countMismatch=serverCount!==await db.watchEvent.count({where:{ownerId}});
   const windowCutoff=state.rangeStart?new Date(Date.parse(`${state.rangeStart}T00:00:00.000Z`)+DAY):null;
   const deletedInWindow=windowCutoff?await db.watchEvent.count({where:{ownerId,watchedAt:{gte:windowCutoff},OR:[{seenRun:null},{seenRun:{not:runId}}]}}):0;
   // Evaluate across the entire run (including resumed attempts) so crashed deltas still detect off-window balanced swaps.
   const newInRun=state.snapshotAt?await db.watchEvent.count({where:{ownerId,importedAt:{gte:state.snapshotAt}}}):newInWindow;
   const offWindowSuspicious=!!state.lastActivityAt&&newInRun===0;
   let explainedByManual=false;
   if(!countMismatch&&deletedInWindow===0&&offWindowSuspicious&&state.lastSuccessfulAt){
    const confirmedManuals=await db.manualHistoryIntent.findMany({
     where:{ownerId,status:'confirmed',remoteEventId:{not:null},confirmedAt:{gte:state.lastSuccessfulAt}},
     select:{kind:true,targetTraktId:true,watchedAt:true,remoteEventId:true},
    });
    if(confirmedManuals.length>0){
     let allVerified=true,usedRemoteLookup=false;
     for(const manual of confirmedManuals){
      const event=await db.watchEvent.findFirst({where:{id:manual.remoteEventId!,ownerId},select:{id:true,seenRun:true}});
      if(!event){allVerified=false;break;}
      if(event.seenRun===runId)continue;
      usedRemoteLookup=true;
      const remoteExists=await verifyRemoteHistoryEventId(ownerId,{
       kind:manual.kind,
       targetTraktId:manual.targetTraktId,
       watchedAt:manual.watchedAt,
       remoteEventId:manual.remoteEventId!,
      });
      if(!remoteExists){allVerified=false;break;}
     }
     if(allVerified&&usedRemoteLookup){
      const afterManualCheck=activityStamp((await ownerRead(ownerId,'/sync/last_activities')).data);
      if(afterManualCheck!==activity)throw new Error('HISTORY_CHANGED');
     }
     explainedByManual=allVerified;
    }
   }
   if(countMismatch||deletedInWindow>0||(offWindowSuspicious&&!explainedByManual)){
    // Force a full reconciliation on the next tick; lease stays held until finally so overlapping callers cannot enter early.
    await db.syncState.update({where:{ownerId},data:{status:'pending',runId:null,lastReconciledAt:null,mode:'full',completedCount:0,expectedCount:null}});
    return {reconcileRequired:true};
   }
  }
  await db.syncState.update({where:{ownerId},data:{status:'complete',mode:full?'full':'recent',runId:null,lastSuccessfulAt:new Date(Math.max(Date.now(),state.snapshotAt?.getTime()??0,(state.lastSuccessfulAt?.getTime()??0)+1)),errorCode:null,retryAt:null}});
  return {complete:true,total};
 }catch(error){
  const code=safeError(error);
  const rawRetry=error instanceof TraktError&&Number.isFinite(error.retryAfter)?error.retryAfter:60;
  const retry=Math.min(86400,Math.max(60,Math.ceil(rawRetry)));
  await db.syncState.update({where:{ownerId},data:{status:'failed',lastCheckedAt:new Date(Math.max(Date.now(),prevCheckedMs+1)),errorCode:code,retryAt:new Date(Date.now()+retry*1000),...(['HISTORY_CHANGED','PAGINATION_INCOMPLETE'].includes(code)?{runId:null}: {})}});
  return {error:code};
 }finally{await db.syncState.updateMany({where:{ownerId,leaseExpiresAt:leaseToken},data:{leaseExpiresAt:null}});}
}
