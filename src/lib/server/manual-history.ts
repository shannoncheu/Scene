import type { ManualHistoryIntent } from '@prisma/client';
import type { ManualIntentView } from '../catalog-types';
import { watchedUtc,minuteIso } from '../manual-time';
import { db } from './db';
import { accessToken,ownerRead,parseRetryAfter,parseTrakt,traktUserAgent } from './trakt';
import { normalizeHistory,object,string,id } from './history';
import { catalogItem,numericId } from './catalog';
import { posterUrl } from './config';
const LEASE=10*60*1000;
export function intentView(row:ManualHistoryIntent):ManualIntentView{const mediaId=row.kind==='movie'?`movie:${row.targetTraktId}`:`show:${row.showTraktId}`;return {id:row.id,kind:row.kind,mediaId,title:row.title,year:row.year,season:row.season,episode:row.episode,watchedAt:row.watchedAt.toISOString(),timezone:row.timezone,status:row.status,errorCode:row.errorCode,sent:!!row.sentAt,poster:posterUrl(mediaId,row.posterPath)};}
export async function prepareManual(ownerId:string,input:Record<string,unknown>){
 if(input.kind!=='movie'&&input.kind!=='show')throw new Error('INVALID_INPUT');
 const kind=input.kind,target=numericId(input.id),timezone=string(input.timezone),watchedAt=new Date(watchedUtc(string(input.localTime),timezone));
 const summary=object((await ownerRead(ownerId,`/${kind==='movie'?'movies':'shows'}/${target}`,{extended:'full'})).data);
 if(numericId(object(summary.ids).trakt)!==target)throw new Error('INVALID_INPUT');
 const item=await catalogItem(kind,summary);let episodeId:string|null=null,season:number|null=null,episode:number|null=null;
 if(kind==='show'){
  if(!Number.isInteger(input.season)||!Number.isInteger(input.episode)||Number(input.season)<0||Number(input.season)>999||Number(input.episode)<0||Number(input.episode)>9999)throw new Error('EPISODE_REQUIRED');
  season=Number(input.season);episode=Number(input.episode);
  const ep=object((await ownerRead(ownerId,`/shows/${target}/seasons/${season}/episodes/${episode}`,{extended:'full'})).data);
  if(ep.season!==season||ep.number!==episode)throw new Error('EPISODE_REQUIRED');episodeId=numericId(object(ep.ids).trakt);
 }
 const media=await db.media.findUniqueOrThrow({where:{id:`${kind}:${target}`}});
 const key={ownerId,kind:kind==='movie'?'movie':'episode',targetTraktId:episodeId||target,watchedAt};
 const existing=await db.manualHistoryIntent.findUnique({where:{ownerId_kind_targetTraktId_watchedAt:key}});
 let canReset=!existing||['draft','superseded','rejected'].includes(existing.status)||(existing.status==='retryable'&&!existing.sentAt&&existing.updatedAt.getTime()<Date.now()-30*60000);
 if(existing?.status==='confirmed'){
  const stillExists=existing.remoteEventId?await db.watchEvent.findFirst({where:{id:existing.remoteEventId,ownerId},select:{id:true}}):null;
  canReset=!stillExists;
 }
 if(existing&&!canReset)return intentView(existing);
 const fields={...key,showTraktId:kind==='show'?target:null,season,episode,timezone,title:item.title,year:item.year,posterPath:media.posterPath};
 const row=await db.manualHistoryIntent.upsert({where:{ownerId_kind_targetTraktId_watchedAt:key},create:fields,update:existing&&canReset?{title:item.title,timezone,posterPath:media.posterPath,status:'draft',sentAt:null,remoteEventId:null,confirmedAt:null,errorCode:null}:{}});
 return intentView(row);
}
function historyPath(kind:string,targetTraktId:string){return `/sync/history/${kind==='movie'?'movies':'episodes'}/${numericId(targetTraktId)}`;}
async function findInItemHistory(
 ownerId:string,
 item:{kind:string;targetTraktId:string;watchedAt:Date},
 matchRow:(row:Record<string,unknown>,raw:unknown)=>boolean,
 onPage?:()=>Promise<void>,
){
 const date=item.watchedAt.getTime(),query={start_at:new Date(date-86400000).toISOString().slice(0,10),end_at:new Date(date+86400000).toISOString().slice(0,10),extended:'full'};
 let pages=1,total:number|null=null;const seen=new Set<string>();
 for(let page=1;page<=pages;page++){
  const response=await ownerRead(ownerId,historyPath(item.kind,item.targetTraktId),{...query,page:String(page),limit:'100'});
  const count=Number(response.headers.get('X-Pagination-Item-Count')),pageCount=Number(response.headers.get('X-Pagination-Page-Count'));
  if(!Array.isArray(response.data)||!response.headers.has('X-Pagination-Item-Count')||!Number.isSafeInteger(count)||count<0||!Number.isSafeInteger(pageCount)||pageCount<0||pageCount>500||Number(response.headers.get('X-Pagination-Page'))!==page||(total!==null&&total!==count))throw new Error('REMOTE_CHECK_FAILED');
  total=count;pages=Math.max(1,pageCount);
  if(onPage)await onPage();
  for(const value of response.data){
   const row=object(value);seen.add(id(row.id));
   if(matchRow(row,value))return value;
  }
 }
 if(seen.size!==total)throw new Error('REMOTE_CHECK_FAILED');
 return null;
}
function matchesTargetRow(row:Record<string,unknown>,item:{kind:string;targetTraktId:string}){
 const ids=object(object(item.kind==='movie'?row.movie:row.episode).ids);
 return row.type===item.kind&&String(ids.trakt)===item.targetTraktId;
}
/**
 * Verifies a confirmed manual history event ID still exists remotely for its specific work,
 * allowing incremental sync to validate backdated manual entries outside the recent window.
 */
export async function verifyRemoteHistoryEventId(ownerId:string,item:{kind:string;targetTraktId:string;watchedAt:Date;remoteEventId:string}){
 try{
  const found=await findInItemHistory(ownerId,item,row=>id(row.id)===item.remoteEventId&&matchesTargetRow(row,item));
  return !!found;
 }catch(error){
  if(error instanceof Error&&error.message==='REMOTE_CHECK_FAILED')return false;
  throw error;
 }
}
async function remoteMatch(ownerId:string,intent:ManualHistoryIntent){
 const before=string(object((await ownerRead(ownerId,'/sync/last_activities')).data).all);
 if(!before)throw new Error('REMOTE_CHECK_FAILED');
 const found=await findInItemHistory(
  ownerId,
  intent,
  row=>matchesTargetRow(row,intent)&&typeof row.watched_at==='string'&&minuteIso(row.watched_at)===intent.watchedAt.toISOString(),
  async()=>{
   // Renew during long per-item histories so the normal reader cannot race local reconciliation.
   await db.$transaction([db.syncState.update({where:{ownerId},data:{leaseExpiresAt:new Date(Date.now()+LEASE)}}),db.manualHistoryIntent.update({where:{id:intent.id},data:{leaseExpiresAt:new Date(Date.now()+LEASE)}})]);
  },
 );
 if(found)return found;
 const after=string(object((await ownerRead(ownerId,'/sync/last_activities')).data).all);
 if(before!==after)throw new Error('REMOTE_CHECK_FAILED');
 return null;
}
async function commitRemote(intent:ManualHistoryIntent,value:unknown){
 const row=normalizeHistory(value);
 if(row.event.episodeId!==null&&intent.kind==='movie')throw new Error('REMOTE_CHECK_FAILED');
 await db.$transaction(async tx=>{
  await tx.media.upsert({where:{id:row.media.id},create:row.media,update:{}});
  if(row.episode)await tx.episode.upsert({where:{id:row.episode.id},create:row.episode,update:{...row.episode,runtime:row.episode.runtime??undefined,title:row.episode.title??undefined}});
  await tx.watchEvent.upsert({where:{id:row.event.id},create:{...row.event,ownerId:intent.ownerId},update:row.event});
  await tx.manualHistoryIntent.update({where:{id:intent.id},data:{status:'confirmed',remoteEventId:row.event.id,confirmedAt:new Date(),errorCode:intent.sentAt?null:'ALREADY_EXISTS',leaseExpiresAt:null}});
  // Preserve lastReconciledAt; clear stale pagination checkpoints and schedule an incremental check.
  await tx.syncState.update({where:{ownerId:intent.ownerId},data:{lastCheckedAt:null,runId:null,completedPage:0,completedCount:0,expectedCount:null,mode:'recent',errorCode:null,status:'pending'}});
 });
}
// The only business POST. There is no caller-controlled URL, method, collection or arbitrary payload.
async function sendOne(intent:ManualHistoryIntent,token:string){
 const item={ids:{trakt:Number(numericId(intent.targetTraktId))},watched_at:intent.watchedAt.toISOString()};
 const payload=intent.kind==='movie'?{movies:[item]}:intent.kind==='episode'?{episodes:[item]}:null;
 if(!payload)throw new Error('INVALID_INPUT');
 return fetch('https://api.trakt.tv/sync/history',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','User-Agent':traktUserAgent(),'trakt-api-key':process.env.TRAKT_CLIENT_ID||'','trakt-api-version':'2',Authorization:`Bearer ${token}`},body:JSON.stringify(payload),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)});
}
export async function confirmManual(ownerId:string,intentId:string,allowSend:boolean){
 if(await db.historyDateEdit.findFirst({where:{activeOwnerKey:ownerId}}))throw new Error('SYNC_BUSY');
 let intent=await db.manualHistoryIntent.findFirst({where:{id:intentId,ownerId}});if(!intent)throw new Error('INVALID_INPUT');
 if(intent.status==='confirmed')return intentView(intent);
 if(intent.leaseExpiresAt&&intent.leaseExpiresAt.getTime()>Date.now())return intentView(intent);
 const preLockUpdatedAt=intent.updatedAt.getTime();
 if(allowSend&&!intent.sentAt&&['draft','retryable'].includes(intent.status)&&preLockUpdatedAt<Date.now()-30*60000)throw new Error('DRAFT_EXPIRED');
 await db.syncState.upsert({where:{ownerId},create:{ownerId},update:{}});
 const locked=await db.syncState.updateMany({where:{ownerId,OR:[{leaseExpiresAt:null},{leaseExpiresAt:{lt:new Date()}}]},data:{leaseExpiresAt:new Date(Date.now()+LEASE)}});
 if(!locked.count)throw new Error('SYNC_BUSY');
 let sent=!!intent.sentAt,intentLocked=false,retryDelay=0;
 try{
  const acquired=await db.manualHistoryIntent.updateMany({where:{id:intentId,OR:[{leaseExpiresAt:null},{leaseExpiresAt:{lt:new Date()}}]},data:{leaseExpiresAt:new Date(Date.now()+LEASE)}});
  if(!acquired.count)return intentView(await db.manualHistoryIntent.findUniqueOrThrow({where:{id:intentId}}));
  intentLocked=true;
  intent=await db.manualHistoryIntent.findUniqueOrThrow({where:{id:intentId}});
  const profile=object(object((await ownerRead(ownerId,'/users/settings')).data).user),owner=await db.owner.findUniqueOrThrow({where:{id:ownerId}});
  if(string(object(profile.ids).uuid)!==owner.traktUserId)throw new Error('ACCOUNT_NOT_ALLOWED');
  // Check the remote item even when a previous response was lost or a draft was opened twice.
  const found=await remoteMatch(ownerId,intent);
  if(found){await commitRemote(intent,found);return intentView(await db.manualHistoryIntent.findUniqueOrThrow({where:{id:intentId}}));}
  if(sent||['sending','uncertain','checking'].includes(intent.status)){
   await db.manualHistoryIntent.update({where:{id:intentId},data:{status:'uncertain',errorCode:'AWAITING_REMOTE_CONFIRMATION'}});
   return intentView(await db.manualHistoryIntent.findUniqueOrThrow({where:{id:intentId}}));
  }
  if(!allowSend)return intentView(intent);
  if(process.env.DISABLE_MANUAL_WRITES==='true')throw new Error('WRITES_DISABLED');
  if(!['draft','retryable'].includes(intent.status))throw new Error('MANUAL_REJECTED');
  if(preLockUpdatedAt<Date.now()-30*60000)throw new Error('DRAFT_EXPIRED');
  const token=await accessToken(ownerId);
  await db.manualHistoryIntent.update({where:{id:intentId},data:{status:'sending',sentAt:new Date(),errorCode:null}});sent=true;
  let response:Response;
  try{response=await sendOne(intent,token);}catch{throw new Error('WRITE_OUTCOME_UNKNOWN');}
  if(!response.ok){
   // Only explicit rejection responses can become retryable, and still require another user confirmation.
   if([400,401,403,404,420,429].includes(response.status)){
    const retryable=[401,403,429].includes(response.status);
    if(response.status===429)retryDelay=parseRetryAfter(response.headers.get('Retry-After'),60)*1000;
    await db.manualHistoryIntent.update({where:{id:intentId},data:{status:retryable?'retryable':'rejected',sentAt:null,errorCode:response.status===401?'REAUTHORIZE_REQUIRED':`TRAKT_HTTP_${response.status}`}});
    return intentView(await db.manualHistoryIntent.findUniqueOrThrow({where:{id:intentId}}));
   }
   throw new Error('WRITE_OUTCOME_UNKNOWN');
  }
  const body=object(parseTrakt(await response.text())),added=object(body.added),notFound=object(body.not_found);
  if((Array.isArray(notFound.movies)&&notFound.movies.length)||(Array.isArray(notFound.episodes)&&notFound.episodes.length)){
   await db.manualHistoryIntent.update({where:{id:intentId},data:{status:'rejected',sentAt:null,errorCode:'ITEM_NOT_FOUND'}});
   return intentView(await db.manualHistoryIntent.findUniqueOrThrow({where:{id:intentId}}));
  }
  if(added[intent.kind==='movie'?'movies':'episodes']!==1)throw new Error('WRITE_OUTCOME_UNKNOWN');
  // Acknowledgement alone is not enough for the local timeline: retrieve the actual event ID.
  intent=await db.manualHistoryIntent.findUniqueOrThrow({where:{id:intentId}});
  const confirmed=await remoteMatch(ownerId,intent);
  if(confirmed){await commitRemote(intent,confirmed);}else throw new Error('AWAITING_REMOTE_CONFIRMATION');
 }catch(error){
  if(error instanceof Error&&error.message==='DRAFT_EXPIRED')throw error;
  if(sent){try{const current=await db.manualHistoryIntent.findUniqueOrThrow({where:{id:intentId}});const found=await remoteMatch(ownerId,current);if(found){await commitRemote(current,found);return intentView(await db.manualHistoryIntent.findUniqueOrThrow({where:{id:intentId}}));}}catch{}}
  const raw=error instanceof Error?error.message:'MANUAL_FAILED';
  const safe=/^[A-Z][A-Z0-9_]{2,60}$/.test(raw)?raw:'MANUAL_FAILED';
  await db.manualHistoryIntent.update({where:{id:intentId},data:{status:sent?'uncertain':'retryable',errorCode:safe}});
 }finally{
  if(intentLocked)await db.manualHistoryIntent.update({where:{id:intentId},data:{leaseExpiresAt:retryDelay?new Date(Date.now()+retryDelay):null}});
  await db.syncState.update({where:{ownerId},data:{leaseExpiresAt:null}});
 }
 return intentView(await db.manualHistoryIntent.findUniqueOrThrow({where:{id:intentId}}));
}
