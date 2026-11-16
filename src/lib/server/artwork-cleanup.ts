import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from './db';
import { dataDir } from './files';
import { ensureTicketTable } from './ticket';
const DAY=86400000;
const HOUR=3600000;
const POSTER_FILE=/^[a-f0-9]{64}\.webp$/;
const TICKET_FILE=/^[a-f0-9-]{36}(?:\.orig)?\.webp$/;
const posterlessSeen=((globalThis as unknown as {cinemaPosterlessSeen?:Map<string,number>}).cinemaPosterlessSeen??=new Map());
// Catalog searches cache Media rows and posters for every result, and artwork refreshes leave the
// previous poster file behind. Remove what is no longer referenced once it is older than the grace
// period, so an in-progress "add history" draft (search -> draft) is never affected, and never delete
// Media rows that have uploaded cinema ticket stubs.
export async function cleanupArtwork(graceMs=7*DAY,now=Date.now()){
 await ensureTicketTable();
 const folder=join(dataDir(),'posters');
 const ticketsFolder=join(dataDir(),'tickets');
 const age=async(dir:string,name:string)=>{const info=await stat(join(dir,name)).catch(()=>null);return info?now-info.mtimeMs:null;};
 const draftCutoff=new Date(now-(graceMs===0?0:Math.min(graceMs,30*60000)));
 const intentCutoff=new Date(now-graceMs);
 const expiredDrafts=await db.manualHistoryIntent.deleteMany({where:{status:{in:['draft','retryable']},sentAt:null,updatedAt:{lt:draftCutoff}}});
 const terminalIntents=await db.manualHistoryIntent.deleteMany({where:{status:{in:['confirmed','rejected','superseded']},updatedAt:{lt:intentCutoff}}});
 const intentsRemoved=expiredDrafts.count+terminalIntents.count;
 const expiredDateEditDrafts=await db.historyDateEdit.deleteMany({where:{status:'draft',activeOwnerKey:null,createdAt:{lt:draftCutoff}}});
 const terminalDateEdits=await db.historyDateEdit.deleteMany({where:{status:{in:['cancelled','failed','confirmed']},activeOwnerKey:null,updatedAt:{lt:intentCutoff}}});
 const dateEditsRemoved=expiredDateEditDrafts.count+terminalDateEdits.count;
 const intents=await db.manualHistoryIntent.findMany({where:{status:{in:['draft','retryable','sending','checking','uncertain']}},select:{kind:true,targetTraktId:true,showTraktId:true,posterPath:true}});
 const protectedMedia=new Set<string>(),protectedFiles=new Set<string>();
 for(const intent of intents){
  if(intent.kind==='movie')protectedMedia.add(`movie:${intent.targetTraktId}`);
  if(intent.showTraktId)protectedMedia.add(`show:${intent.showTraktId}`);
  if(intent.posterPath)protectedFiles.add(intent.posterPath);
 }
 let mediaRemoved=0,filesRemoved=0;
 // Remove unreferenced episodes first so orphan show Media rows can also be reclaimed.
 const episodesRemoved=(await db.episode.deleteMany({where:{events:{none:{}}}})).count;
 // Orphan Media rows: never watched, no episodes, no ticket stubs, not part of an active manual-history intent.
 const orphans=await db.media.findMany({where:{events:{none:{}},episodes:{none:{}},ticketStubs:{none:{}}},select:{id:true,posterPath:true}});
 const activePosterless=new Set<string>();
 for(const media of orphans){
  if(protectedMedia.has(media.id))continue;
  if(media.posterPath){
   if(!POSTER_FILE.test(media.posterPath))continue;
   const fileAge=await age(folder,media.posterPath);
   if(fileAge!==null&&fileAge<graceMs)continue;
  }else if(graceMs>0){
   activePosterless.add(media.id);
   const seenAt=posterlessSeen.get(media.id);
   if(seenAt===undefined){posterlessSeen.set(media.id,now);continue;}
   if(now-seenAt<Math.min(graceMs,DAY))continue;
  }
  const removed=await db.media.deleteMany({where:{id:media.id,events:{none:{}},episodes:{none:{}},ticketStubs:{none:{}}}}).catch(()=>({count:0}));
  if(removed.count)posterlessSeen.delete(media.id);
  mediaRemoved+=removed.count;
 }
 for(const id of posterlessSeen.keys())if(!activePosterless.has(id))posterlessSeen.delete(id);
 // Poster files no longer referenced by any Media row or intent.
 const referenced=new Set((await db.media.findMany({where:{posterPath:{not:null}},select:{posterPath:true}})).map(m=>m.posterPath!));
 const names=await readdir(folder).catch(()=>[] as string[]);
 for(const name of names){
  const stale=name.endsWith('.tmp')?DAY:POSTER_FILE.test(name)&&!referenced.has(name)&&!protectedFiles.has(name)?graceMs:null;
  if(stale===null)continue;
  const fileAge=await age(folder,name);
  if(fileAge!==null&&fileAge>=stale){await unlink(join(folder,name)).catch(()=>{});filesRemoved++;}
 }
 // Orphan ticket files left by concurrent uploads/rotations, failed DB swaps, or abandoned .tmp writes.
 const referencedTickets=new Set<string>();
 for(const t of await db.ticketStub.findMany({select:{filePath:true}})){
  referencedTickets.add(t.filePath);
  referencedTickets.add(t.filePath.replace(/\.webp$/,'.orig.webp'));
 }
 const ticketNames=await readdir(ticketsFolder).catch(()=>[] as string[]);
 for(const name of ticketNames){
  const stale=name.endsWith('.tmp')?HOUR:TICKET_FILE.test(name)&&!referencedTickets.has(name)?HOUR:null;
  if(stale===null)continue;
  const fileAge=await age(ticketsFolder,name);
  if(fileAge!==null&&fileAge>=stale){await unlink(join(ticketsFolder,name)).catch(()=>{});filesRemoved++;}
 }
 return {mediaRemoved,episodesRemoved,intentsRemoved,dateEditsRemoved,filesRemoved};
}
