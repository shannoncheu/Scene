import { authReady, safeError } from './config';
import { db } from './db';
import { syncOwner } from './sync';
import { hydrateMetadata } from './metadata';
import { dailyBackup } from './backup';
import { runDateEdit } from './history-date-edit';
import { cleanupArtwork } from './artwork-cleanup';
const state=globalThis as unknown as {cinemaWorker?:ReturnType<typeof setInterval>};
let active=false,lastArtworkCleanup=0;
// Log only stable error codes and timestamps: never credentials, response bodies or watch history.
function report(step:string,error:unknown){console.error(`[worker] ${new Date().toISOString()} ${step} failed: ${safeError(error)}${error instanceof Error&&safeError(error)==='REQUEST_FAILED'?` (${error.name})`:''}`);}

/**
 * Runs one background maintenance cycle: Trakt sync runs only when auth config is ready,
 * while daily backup and local housekeeping run independently whenever local data exists.
 */
export async function runWorkerTick(){
 if(active)return;active=true;
 try{
  if(authReady()){
   let owners:{id:string}[]=[];
   try{owners=await db.owner.findMany({where:{encryptedAccessToken:{not:null}},select:{id:true}});}catch(error){report('owner lookup',error);}
   for(const owner of owners){
    try{
     if(await db.historyDateEdit.findFirst({where:{activeOwnerKey:owner.id}})){await runDateEdit(owner.id);continue;}
     const sync=await db.syncState.findUnique({where:{ownerId:owner.id}});
     const retryDue=!sync?.retryAt||sync.retryAt.getTime()<=Date.now();
     if(!sync?.lastCheckedAt||Date.now()-sync.lastCheckedAt.getTime()>15*60*1000||sync.status==='pending'||(sync.status==='failed'&&retryDue)){
      const result=await syncOwner(owner.id);
      if(result.error)console.warn(`[worker] ${new Date().toISOString()} sync: ${result.error}`);
      if(!result.error&&!result.busy&&!result.deferred)await hydrateMetadata(owner.id);
     }
    }catch(error){report('sync',error);}
   }
  }
  try{
   if((await db.owner.count({take:1}))>0)await dailyBackup();
  }catch(error){report('backup',error);}
  if(Date.now()-lastArtworkCleanup>86400000){
   lastArtworkCleanup=Date.now();
   try{const r=await cleanupArtwork();if(r.mediaRemoved||r.episodesRemoved||r.intentsRemoved||r.dateEditsRemoved||r.filesRemoved)console.log(`[worker] ${new Date().toISOString()} artwork cleanup: ${r.mediaRemoved} media, ${r.episodesRemoved} episodes, ${r.intentsRemoved} intents, ${r.dateEditsRemoved} date edits, ${r.filesRemoved} files`);}catch(error){report('artwork cleanup',error);}
  }
  try{await db.session.deleteMany({where:{expiresAt:{lt:new Date()}}});await db.oAuthAttempt.deleteMany({where:{expiresAt:{lt:new Date()}}});}catch(error){report('session cleanup',error);}
 }finally{active=false;}
}

export function startWorker(){
 if(state.cinemaWorker||process.env.DISABLE_BACKGROUND_WORKER==='true')return;
 state.cinemaWorker=setInterval(()=>void runWorkerTick(),60000);state.cinemaWorker.unref();void runWorkerTick();
}
