import { after } from 'next/server';
import { db } from '@/lib/server/db';
import { apiFailure, requireSession, checkMutation, privateJson } from '@/lib/server/session';
import { SYNC_STATE_SELECT, beginManualSyncQueue, executeManualSync, isOwnerSyncQueued, pendingManualKindForSync, serializeSyncState } from '@/lib/server/sync';
export const runtime='nodejs';
export async function GET(request:Request){try{
 const session=await requireSession(request);
 const sync=await db.syncState.findUnique({where:{ownerId:session.ownerId},select:SYNC_STATE_SELECT});
 const manualKind=await pendingManualKindForSync(db,session.ownerId,sync?.lastSuccessfulAt);
 return privateJson({sync:serializeSyncState(sync,manualKind)});
}catch(error){return apiFailure(error);}}
export async function POST(request:Request){try{
 const session=await requireSession(request);checkMutation(request,session);
 let mode:'latest'|'full'='latest';
 const raw=await request.text();
 if(raw.trim()){
  let parsed:unknown;
  try{parsed=JSON.parse(raw);}catch{return privateJson({error:'INVALID_INPUT'},400);}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return privateJson({error:'INVALID_INPUT'},400);
  const requestedMode=(parsed as Record<string,unknown>).mode;
  if(requestedMode!==undefined){
   if(requestedMode!=='latest'&&requestedMode!=='full')return privateJson({error:'INVALID_INPUT'},400);
   mode=requestedMode;
  }
 }
 if(await db.historyDateEdit.findFirst({where:{activeOwnerKey:session.ownerId}}))return privateJson({error:'DATE_EDIT_BUSY'},409);
 const state=await db.syncState.findUnique({where:{ownerId:session.ownerId},select:{...SYNC_STATE_SELECT,leaseExpiresAt:true}});
 const manualKind=await pendingManualKindForSync(db,session.ownerId,state?.lastSuccessfulAt);
 const snapshot=serializeSyncState(state,manualKind);
 if((state?.leaseExpiresAt&&state.leaseExpiresAt.getTime()>Date.now())||isOwnerSyncQueued(session.ownerId))return privateJson({busy:true,mode,sync:snapshot},202);
 if(state?.retryAt&&state.retryAt.getTime()>Date.now())return privateJson({error:state.errorCode||'RATE_LIMITED',retryAt:state.retryAt.toISOString(),sync:snapshot},429);
 beginManualSyncQueue(session.ownerId);
 try{
  after(()=>executeManualSync(session.ownerId,mode));
 }catch(error){
  if(error instanceof Error&&/outside a request scope/i.test(error.message)){
   void executeManualSync(session.ownerId,mode).catch(()=>{});
  }else{
   throw error;
  }
 }
 return privateJson({queued:true,mode,sync:snapshot},202);
}catch(error){return apiFailure(error);}}
