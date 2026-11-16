import type { HistoryDateEdit,HistoryDateEditItem } from '@prisma/client';
import { db } from './db';
import { accessToken,ownerRead,parseRetryAfter,parseTrakt,traktUserAgent,TraktError } from './trakt';
import { id,object,string,normalizeHistory } from './history';
import { minuteIso,watchedUtc } from '../manual-time';
import type { DateEditView } from '../history-date-types';

const LEASE=10*60*1000;
type Loaded=HistoryDateEdit&{items:HistoryDateEditItem[]};
const load=(ownerId:string,operationId:string)=>db.historyDateEdit.findFirstOrThrow({where:{id:operationId,ownerId},include:{items:{orderBy:{oldEventId:'asc'}}}});
export function dateEditView(op:Loaded):DateEditView {
 return {id:op.id,scope:op.scope,mode:op.mode,timezone:op.timezone,status:op.status,errorCode:op.errorCode,canCancel:op.items.every(i=>!i.deleteSentAt),canRetryAdd:op.status==='paused'&&op.items.some(i=>i.status!=='confirmed'&&!!i.addSentAt),total:op.items.length,completed:op.items.filter(i=>i.status==='confirmed').length,items:op.items.map(i=>({id:i.id,title:i.title,season:i.season,episode:i.episode,oldWatchedAt:i.oldWatchedAt?.toISOString()??null,newWatchedAt:i.newWatchedAt.toISOString(),status:i.status,errorCode:i.errorCode}))};
}
export async function getDateEdit(ownerId:string,operationId?:string){
 let op=operationId?await load(ownerId,operationId):await db.historyDateEdit.findFirst({where:{ownerId,activeOwnerKey:ownerId},orderBy:{createdAt:'desc'},include:{items:{orderBy:{oldEventId:'asc'}}}});
 if(!op&&!operationId)op=await db.historyDateEdit.findFirst({where:{ownerId,confirmedAt:{not:null}},orderBy:{createdAt:'desc'},include:{items:{orderBy:{oldEventId:'asc'}}}});
 return op?dateEditView(op):null;
}
export async function prepareDateEdit(ownerId:string,input:Record<string,unknown>){
 if(input.scope!=='event'&&input.scope!=='season')throw Error('INVALID_INPUT');
 if(input.mode!=='custom'&&input.mode!=='released')throw Error('INVALID_INPUT');
 const timezone=string(input.timezone);
 try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format();}catch{throw Error('INVALID_TIMEZONE');}
 const event=await db.watchEvent.findFirst({where:{id:id(input.eventId),ownerId},include:{media:true,episode:true}});
 if(!event)throw Error('EVENT_NOT_FOUND');
 if(!event.episode&&(input.scope==='season'||input.mode==='released'))throw Error('INVALID_INPUT');
 if(await db.historyDateEdit.findFirst({where:{activeOwnerKey:ownerId}}))throw Error('DATE_EDIT_BUSY');
 const rows=input.scope==='season'?await db.watchEvent.findMany({where:{ownerId,episode:{showId:event.episode!.showId,season:event.episode!.season}},include:{media:true,episode:true},orderBy:[{watchedAt:'asc'},{id:'asc'}],take:2001}):[event];
 if(!rows.length||rows.length>2000)throw Error('TOO_MANY_RECORDS');
 const custom=input.mode==='custom'?new Date(watchedUtc(string(input.localTime),timezone)):null;
 const releases=new Map<string,Date>();
 if(input.mode==='released'){
  const data=(await ownerRead(ownerId,`/shows/${event.mediaId.split(':')[1]}/seasons/${event.episode!.season}`,{extended:'full'})).data;
  if(!Array.isArray(data))throw Error('RELEASE_DATE_UNAVAILABLE');
  for(const raw of data){const e=object(raw),runtime=Number(e.runtime),aired=Date.parse(string(e.first_aired));if(Number.isFinite(aired)&&Number.isFinite(runtime)&&runtime>0){const when=new Date(minuteIso(new Date(aired+runtime*60000).toISOString()));if(when.getTime()<=Date.now()+60000)releases.set(id(object(e.ids).trakt),when);}}
 }
 const items=rows.map(e=>{
  const newWatchedAt=custom??releases.get(e.episodeId!);if(!newWatchedAt)throw Error('RELEASE_DATE_UNAVAILABLE');
  return {oldEventId:e.id,mediaId:e.mediaId,episodeId:e.episodeId,targetId:e.episodeId??e.mediaId.split(':')[1],title:e.media.chineseTitle||e.media.originalTitle,season:e.episode?.season??null,episode:e.episode?.number??null,oldWatchedAt:e.watchedAt,newWatchedAt,originalJson:JSON.stringify({id:e.id,watchedAt:e.watchedAt,mediaId:e.mediaId,episodeId:e.episodeId,action:e.action})};
 });
 const op=await db.historyDateEdit.create({data:{ownerId,scope:input.scope,mode:input.mode,timezone,items:{create:items}},include:{items:true}});
 return dateEditView(op);
}
export async function confirmDateEdit(ownerId:string,operationId:string){
 const op=await load(ownerId,operationId);
 if(op.status==='confirmed')return dateEditView(op);
 if(op.status==='cancelled'||op.status==='failed')throw Error('INVALID_INPUT');
 if(op.retryAt&&op.retryAt.getTime()>Date.now())throw Error('RATE_LIMITED');
 if(op.confirmedAt&&['queued','running'].includes(op.status))return dateEditView(op);
 if(op.status==='draft'&&Date.now()-op.createdAt.getTime()>30*60000)throw Error('DRAFT_EXPIRED');
 if(process.env.DISABLE_MANUAL_WRITES==='true')throw Error('WRITES_DISABLED');
 const other=await db.historyDateEdit.findFirst({where:{activeOwnerKey:ownerId,id:{not:operationId}}});if(other)throw Error('DATE_EDIT_BUSY');
 let updatedCount=0;
 try{
  updatedCount=(await db.historyDateEdit.updateMany({where:{id:op.id,status:{in:['draft','paused']}},data:{confirmedAt:op.confirmedAt??new Date(),activeOwnerKey:ownerId,status:'queued',errorCode:null,retryAt:null}})).count;
 }catch{throw Error('DATE_EDIT_BUSY');}
 if(!updatedCount){
  const current=await load(ownerId,operationId);
  if(current.status==='confirmed'||(current.confirmedAt&&['queued','running'].includes(current.status)))return dateEditView(current);
  throw Error('INVALID_INPUT');
 }
 return dateEditView(await load(ownerId,operationId));
}
async function heartbeat(op:HistoryDateEdit){
 await db.syncState.update({where:{ownerId:op.ownerId},data:{leaseExpiresAt:new Date(Date.now()+LEASE)}});
}
// A complete stable per-item snapshot is required before inferring absence.
async function remoteHistory(op:HistoryDateEdit,item:HistoryDateEditItem){
 const before=string(object((await ownerRead(op.ownerId,'/sync/last_activities')).data).all);if(!before)throw Error('REMOTE_CHECK_FAILED');
 let pages=1,total:number|null=null;const rows:unknown[]=[],seen=new Set<string>();
 for(let page=1;page<=pages;page++){
  const r=await ownerRead(op.ownerId,`/sync/history/${item.episodeId?'episodes':'movies'}/${item.targetId}`,{page:String(page),limit:'100',extended:'full'});
  const count=Number(r.headers.get('X-Pagination-Item-Count')),n=Number(r.headers.get('X-Pagination-Page-Count'));
  if(!Array.isArray(r.data)||!r.headers.has('X-Pagination-Item-Count')||!Number.isSafeInteger(count)||count<0||!Number.isSafeInteger(n)||n<0||n>500||Number(r.headers.get('X-Pagination-Page'))!==page||(total!==null&&total!==count))throw Error('REMOTE_CHECK_FAILED');
  total=count;pages=Math.max(1,n);await heartbeat(op);
  for(const raw of r.data){const normalized=normalizeHistory(raw);if(normalized.event.mediaId!==item.mediaId||normalized.event.episodeId!==item.episodeId||seen.has(normalized.event.id))throw Error('REMOTE_CHECK_FAILED');seen.add(normalized.event.id);rows.push(raw);}
 }
 const after=string(object((await ownerRead(op.ownerId,'/sync/last_activities')).data).all);
 if(before!==after||seen.size!==total)throw Error('REMOTE_CHECK_FAILED');
 return rows;
}
function matchNew(item:HistoryDateEditItem,rows:unknown[]){
 const baseline=new Set<string>(JSON.parse(item.baselineIds||'[]'));
 const candidates=rows.filter(raw=>{const e=normalizeHistory(raw).event;return e.id!==item.oldEventId&&!baseline.has(e.id)&&e.watchedAt&&minuteIso(e.watchedAt.toISOString())===item.newWatchedAt.toISOString();});
 if(candidates.length>1)throw Error('AMBIGUOUS_REMOTE_RESULT');
 return candidates[0]??null;
}
async function commit(op:HistoryDateEdit,item:HistoryDateEditItem,raw:unknown){
 const row=normalizeHistory(raw);if(row.event.mediaId!==item.mediaId||row.event.episodeId!==item.episodeId||!row.event.watchedAt||minuteIso(row.event.watchedAt.toISOString())!==item.newWatchedAt.toISOString())throw Error('REMOTE_CHECK_FAILED');
 await db.$transaction(async tx=>{
  await tx.watchEvent.upsert({where:{id:row.event.id},create:{...row.event,ownerId:op.ownerId},update:row.event});
  if(row.event.id!==item.oldEventId){
   await tx.watchEvent.deleteMany({where:{id:item.oldEventId,ownerId:op.ownerId}});
   await tx.manualHistoryIntent.updateMany({where:{ownerId:op.ownerId,remoteEventId:item.oldEventId},data:{status:'superseded',errorCode:'DATE_CHANGED',remoteEventId:row.event.id}});
  }
  await tx.historyDateEditItem.update({where:{id:item.id},data:{status:'confirmed',newEventId:row.event.id,errorCode:null}});
 });
}
async function assertWriteConsent(op:HistoryDateEdit){
 const current=await db.historyDateEdit.findFirst({where:{id:op.id,ownerId:op.ownerId,activeOwnerKey:op.ownerId,status:'running',confirmedAt:{not:null}}});
 if(!current)throw Error('OPERATION_PAUSED');
}
// Only these two fixed POSTs are available, never a client-supplied URL/body.
async function writeOne(op:HistoryDateEdit,item:HistoryDateEditItem,remove:boolean,token:string){
 if(process.env.DISABLE_MANUAL_WRITES==='true')throw Error('WRITES_DISABLED');
 if(!/^\d+$/.test(item.oldEventId)||!/^\d+$/.test(item.targetId)||!Number.isSafeInteger(Number(item.targetId)))throw Error('INVALID_INPUT');
 // Raw numeric text preserves 64-bit history IDs exactly.
 const body=remove?`{"ids":[${item.oldEventId}]}`:JSON.stringify({[item.episodeId?'episodes':'movies']:[{ids:{trakt:Number(item.targetId)},watched_at:item.newWatchedAt.toISOString()}]});
 return fetch(`https://api.trakt.tv/sync/history${remove?'/remove':''}`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','User-Agent':traktUserAgent(),'trakt-api-version':'2','trakt-api-key':process.env.TRAKT_CLIENT_ID||'',Authorization:`Bearer ${token}`},body,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30000)});
}
async function processItem(op:HistoryDateEdit,initial:HistoryDateEditItem){
 let item=initial,rows=await remoteHistory(op,item),old=rows.find(raw=>id(object(raw).id)===item.oldEventId);
 if(old){
  const normalized=normalizeHistory(old).event;
  if((normalized.watchedAt?.getTime()??null)!==(item.oldWatchedAt?.getTime()??null))throw Error('ORIGINAL_RECORD_CHANGED');
  if(item.oldWatchedAt&&minuteIso(item.oldWatchedAt.toISOString())===item.newWatchedAt.toISOString()){await commit(op,item,old);return;}
  if(item.addSentAt)throw Error('AWAITING_REMOTE_CONFIRMATION');
  const raw=object(old);if(raw.notes||raw.note)throw Error('HISTORY_NOTE_PRESENT');
  item=await db.historyDateEditItem.update({where:{id:item.id},data:{baselineIds:JSON.stringify(rows.map(r=>id(object(r).id))),originalJson:JSON.stringify(old)}});
  const deleteToken=await accessToken(op.ownerId);await assertWriteConsent(op);
  await db.historyDateEditItem.update({where:{id:item.id},data:{status:'deleting',deleteSentAt:new Date()}});
  const r=await writeOne(op,item,true,deleteToken);
  if(!r.ok){if([400,401,403,404,420,429].includes(r.status))await db.historyDateEditItem.update({where:{id:item.id},data:{status:'pending',deleteSentAt:null}});throw new TraktError(r.status,parseRetryAfter(r.headers.get('Retry-After'),60));}
  rows=await remoteHistory(op,item);
  if(rows.some(raw=>id(object(raw).id)===item.oldEventId))throw Error('AWAITING_DELETE_CONFIRMATION');
 }else if(!item.deleteSentAt){throw Error('ORIGINAL_RECORD_MISSING');}
 // Never add before a GET confirms that this specific old event is absent.
 const already=matchNew(item,rows);
 if(already){
  const baseline=new Set<string>(JSON.parse(item.baselineIds||'[]'));baseline.delete(item.oldEventId);const otherIds=rows.map(r=>id(object(r).id)).filter(value=>value!==id(object(already).id));
  if(!item.addSentAt&&(otherIds.length!==baseline.size||otherIds.some(value=>!baseline.has(value))))throw Error('AMBIGUOUS_REMOTE_RESULT');
  await commit(op,item,already);return;
 }
 if(item.addSentAt)throw Error('AWAITING_REMOTE_CONFIRMATION');
 const addToken=await accessToken(op.ownerId);await assertWriteConsent(op);
 item=await db.historyDateEditItem.update({where:{id:item.id},data:{status:'adding',addSentAt:new Date(),errorCode:null}});
 const r=await writeOne(op,item,false,addToken);
 if(!r.ok){
  if([400,401,403,404,420,429].includes(r.status)){
   await db.historyDateEditItem.update({where:{id:item.id},data:{status:'deleted',addSentAt:null}});
   throw new TraktError(r.status,parseRetryAfter(r.headers.get('Retry-After'),60));
  }
  throw Error('AWAITING_REMOTE_CONFIRMATION');
 }
 const body=object(parseTrakt(await r.text()));
 if(object(body.added)[item.episodeId?'episodes':'movies']!==1)throw Error('AWAITING_REMOTE_CONFIRMATION');
 rows=await remoteHistory(op,item);const found=matchNew(item,rows);if(!found)throw Error('AWAITING_REMOTE_CONFIRMATION');await commit(op,item,found);
}
export async function runDateEdit(ownerId:string,maxItems=12){
 if(process.env.DISABLE_MANUAL_WRITES==='true')return;
 await db.syncState.upsert({where:{ownerId},create:{ownerId},update:{}});
 const locked=await db.syncState.updateMany({where:{ownerId,OR:[{leaseExpiresAt:null},{leaseExpiresAt:{lt:new Date()}}]},data:{leaseExpiresAt:new Date(Date.now()+LEASE)}});if(!locked.count)return;
 let current:HistoryDateEditItem|undefined,op:Loaded|null=null;
 try{
  // Read operation after acquiring the owner lease so a concurrent cancel/abandon cannot be resurrected.
  op=await db.historyDateEdit.findFirst({where:{ownerId,activeOwnerKey:ownerId},include:{items:{orderBy:{oldEventId:'asc'}}}});
  if(!op||!op.confirmedAt||!['queued','running'].includes(op.status)||(op.retryAt&&op.retryAt.getTime()>Date.now()))return;
  const profile=object(object((await ownerRead(ownerId,'/users/settings')).data).user),owner=await db.owner.findUniqueOrThrow({where:{id:ownerId}});
  if((string(object(profile.ids).uuid)||string(profile.uuid))!==owner.traktUserId)throw Error('ACCOUNT_NOT_ALLOWED');
  const claimed=await db.historyDateEdit.updateMany({where:{id:op.id,activeOwnerKey:ownerId,status:{in:['queued','running']}},data:{status:'running',errorCode:null,retryAt:null}});
  if(!claimed.count)return;
  for(const item of op.items.filter(i=>i.status!=='confirmed').slice(0,maxItems)){current=item;await heartbeat(op);await processItem(op,item);current=undefined;}
  const remaining=await db.historyDateEditItem.count({where:{operationId:op.id,status:{not:'confirmed'}}});
  await db.historyDateEdit.updateMany({where:{id:op.id,activeOwnerKey:ownerId,status:'running'},data:remaining?{status:'queued'}:{status:'confirmed',activeOwnerKey:null,errorCode:null}});
  if(!remaining)await db.syncState.update({where:{ownerId},data:{lastCheckedAt:null,lastReconciledAt:null,runId:null,status:'pending'}});
 }catch(error){
  if(!op)return;
  const raw=error instanceof Error?error.message:'DATE_EDIT_FAILED',code=/^[A-Z][A-Z0-9_]{2,60}$/.test(raw)?raw:'DATE_EDIT_FAILED';
  if(current){
   const fresh=await db.historyDateEditItem.findUniqueOrThrow({where:{id:current.id}});
   // Lost responses can be resolved by reading; an uncertain add is never resent.
   if(fresh.addSentAt){try{const rows=await remoteHistory(op,fresh);if(!rows.some(r=>id(object(r).id)===fresh.oldEventId)){const found=matchNew(fresh,rows);if(found){await commit(op,fresh,found);await db.historyDateEdit.updateMany({where:{id:op.id,activeOwnerKey:ownerId,status:{in:['queued','running']}},data:{status:'queued',errorCode:null}});return;}}}catch{}}
   await db.historyDateEditItem.update({where:{id:current.id},data:{errorCode:code}});
  }
  const touched=await db.historyDateEditItem.count({where:{operationId:op.id,deleteSentAt:{not:null}}});
  const permanent=['ORIGINAL_RECORD_CHANGED','ORIGINAL_RECORD_MISSING','HISTORY_NOTE_PRESENT','ACCOUNT_NOT_ALLOWED'].includes(code);
  const limited=error instanceof TraktError&&error.status===429;
  const retrySecs=limited?Math.min(86400,Math.max(60,Number.isFinite((error as TraktError).retryAfter)?(error as TraktError).retryAfter:60)):0;
  await db.historyDateEdit.updateMany({where:{id:op.id,activeOwnerKey:ownerId,status:{in:['queued','running']}},data:{status:permanent&&!touched?'failed':limited?'queued':'paused',activeOwnerKey:permanent&&!touched?null:ownerId,errorCode:code,retryAt:limited?new Date(Date.now()+retrySecs*1000):null}});
 }finally{await db.syncState.update({where:{ownerId},data:{leaseExpiresAt:null}});}
}

export async function cancelDateEdit(ownerId:string,operationId:string){
 await db.syncState.upsert({where:{ownerId},create:{ownerId},update:{}});
 const lock=await db.syncState.updateMany({where:{ownerId,OR:[{leaseExpiresAt:null},{leaseExpiresAt:{lt:new Date()}}]},data:{leaseExpiresAt:new Date(Date.now()+LEASE)}});if(!lock.count)throw Error('SYNC_BUSY');
 try{
  const op=await load(ownerId,operationId);
  if(op.status==='confirmed'||op.status==='cancelled')return dateEditView(op);
  if(await db.historyDateEditItem.count({where:{operationId,deleteSentAt:{not:null}}}))throw Error('DATE_EDIT_IN_PROGRESS');
  const updated=await db.historyDateEdit.updateMany({where:{id:operationId,ownerId,status:{in:['draft','queued','paused']}},data:{status:'cancelled',activeOwnerKey:null}});
  if(!updated.count){
   const latest=await load(ownerId,operationId);
   if(latest.status==='confirmed'||latest.status==='cancelled')return dateEditView(latest);
   throw Error('DATE_EDIT_IN_PROGRESS');
  }
  return dateEditView(await load(ownerId,operationId));
 }finally{await db.syncState.update({where:{ownerId},data:{leaseExpiresAt:null}});}
}

/**
 * Explicit user recovery for a paused date-edit whose add attempt had an uncertain outcome:
 * verifies remote history first, and only clears addSentAt when absent so the next run can resend.
 */
export async function retryUncertainDateEdit(ownerId:string,operationId:string){
 await db.syncState.upsert({where:{ownerId},create:{ownerId},update:{}});
 const lock=await db.syncState.updateMany({where:{ownerId,OR:[{leaseExpiresAt:null},{leaseExpiresAt:{lt:new Date()}}]},data:{leaseExpiresAt:new Date(Date.now()+LEASE)}});
 if(!lock.count)throw Error('SYNC_BUSY');
 try{
  // Validate state only after holding the lock so concurrent abandon/retry requests cannot overwrite stale state.
  const op=await load(ownerId,operationId);
  if(op.status==='confirmed')return dateEditView(op);
  if(op.status!=='paused'||op.activeOwnerKey!==ownerId)throw Error('INVALID_INPUT');
  const stuck=op.items.filter(i=>i.status!=='confirmed'&&!!i.addSentAt);
  if(!stuck.length)throw Error('INVALID_INPUT');
  const profile=object(object((await ownerRead(ownerId,'/users/settings')).data).user),owner=await db.owner.findUniqueOrThrow({where:{id:ownerId}});
  if((string(object(profile.ids).uuid)||string(profile.uuid))!==owner.traktUserId)throw Error('ACCOUNT_NOT_ALLOWED');
  for(const item of stuck){
   await heartbeat(op);
   const rows=await remoteHistory(op,item);
   const found=matchNew(item,rows);
   if(found){await commit(op,item,found);}
   else{await db.historyDateEditItem.update({where:{id:item.id},data:{addSentAt:null,errorCode:null,status:item.deleteSentAt?'deleted':'pending'}});}
  }
  const remaining=await db.historyDateEditItem.count({where:{operationId:op.id,status:{not:'confirmed'}}});
  await db.historyDateEdit.updateMany({where:{id:op.id,activeOwnerKey:ownerId,status:'paused'},data:remaining?{status:'queued',errorCode:null,retryAt:null}:{status:'confirmed',activeOwnerKey:null,errorCode:null,retryAt:null}});
  if(!remaining)await db.syncState.update({where:{ownerId},data:{lastCheckedAt:null,lastReconciledAt:null,runId:null,status:'pending'}});
  return dateEditView(await load(ownerId,operationId));
 }finally{await db.syncState.update({where:{ownerId},data:{leaseExpiresAt:null}});}
}

/**
 * Explicit user recovery to terminate a stuck paused/queued task (including partially executed ones),
 * releasing the owner lock and scheduling a fresh reconciliation sync from Trakt.
 */
export async function abandonDateEdit(ownerId:string,operationId:string){
 await db.syncState.upsert({where:{ownerId},create:{ownerId},update:{}});
 const lock=await db.syncState.updateMany({where:{ownerId,OR:[{leaseExpiresAt:null},{leaseExpiresAt:{lt:new Date()}}]},data:{leaseExpiresAt:new Date(Date.now()+LEASE)}});
 if(!lock.count)throw Error('SYNC_BUSY');
 try{
  const op=await load(ownerId,operationId);
  if(op.status==='confirmed'||op.status==='cancelled'||(op.status==='failed'&&!op.activeOwnerKey))return dateEditView(op);
  const updated=await db.historyDateEdit.updateMany({where:{id:operationId,ownerId,status:{in:['draft','queued','paused','running']}},data:{status:'failed',activeOwnerKey:null,errorCode:op.errorCode||'ABANDONED_BY_USER',retryAt:null}});
  if(updated.count)await db.syncState.update({where:{ownerId},data:{lastCheckedAt:null,lastReconciledAt:null,runId:null,status:'pending'}});
  return dateEditView(await load(ownerId,operationId));
 }finally{await db.syncState.update({where:{ownerId},data:{leaseExpiresAt:null}});}
}
