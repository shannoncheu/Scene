import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { safeError } from './config';
import { db } from './db';
import { ownerRead, TraktError, traktUserAgent } from './trakt';
import { object, string, integer, id } from './history';
import { atomicFile, boundedBody } from './files';
const mediaBackoff = ((globalThis as unknown as { cinemaMediaBackoff?: Map<string, number> }).cinemaMediaBackoff ??= new Map());
const episodeBackoff = ((globalThis as unknown as { cinemaEpisodeBackoff?: Map<string, number> }).cinemaEpisodeBackoff ??= new Map());
const activeMetadataOwners = ((globalThis as unknown as { cinemaActiveMetadataOwners?: Set<string> }).cinemaActiveMetadataOwners ??= new Set());
function activeBackoffIds(map: Map<string, number>, now: number): string[] {
 const blocked: string[] = [];
 for (const [entryId, until] of map) {
  if (until <= now) map.delete(entryId);
  else blocked.push(entryId);
 }
 return blocked.slice(-500);
}
export function allowedArtwork(raw:string){
 const url=new URL(raw.startsWith('https://')?raw:`https://${raw}`);
 if(url.protocol!=='https:'||!['walter-r2.trakt.tv','media.trakt.tv','image.tmdb.org'].includes(url.hostname)||url.port||url.username||url.password)throw new Error('ARTWORK_URL_BLOCKED');
 return url;
}
export async function cachePoster(raw:string){
 const url=allowedArtwork(raw);const response=await fetch(url,{headers:{'User-Agent':traktUserAgent()},redirect:'error',signal:AbortSignal.timeout(20000)});if(!response.ok)throw new Error('ARTWORK_UNAVAILABLE');
 const image=await sharp(await boundedBody(response,5*1024*1024),{limitInputPixels:20_000_000}).rotate().resize({width:400,withoutEnlargement:true}).webp({quality:80}).toBuffer();
 const name=createHash('sha256').update(raw).digest('hex')+'.webp';await atomicFile('posters',name,image);return name;
}
export async function hydrateMetadata(ownerId:string,limit=12,refreshShows=false){
 if(activeMetadataOwners.has(ownerId))return;
 activeMetadataOwners.add(ownerId);
 try{
 const movieStale=new Date(Date.now()-30*86400000);
 const showStale=new Date(Date.now()-86400000);
 const posterRetryBefore=new Date(Date.now()-60*60*1000);
 const showCondition=refreshShows?{kind:{not:'movie'}}:{kind:{not:'movie'},metadataAt:{lt:showStale}};
 const blockedIds=activeBackoffIds(mediaBackoff,Date.now());
 const media=await db.media.findMany({where:{...(blockedIds.length?{id:{notIn:blockedIds}}:{}),events:{some:{ownerId}},OR:[{metadataAt:null},{kind:'movie',metadataAt:{lt:movieStale}},showCondition,{posterPath:null,metadataAt:{lt:posterRetryBefore}}]},orderBy:{metadataAt:'asc'},take:limit});
 for(const work of media){
  try{
   const traktId=work.id.split(':')[1],path=`/${work.kind==='movie'?'movies':'shows'}/${traktId}`;
   const data=object((await ownerRead(ownerId,path,{extended:'full'})).data);
   const tmdbId=work.tmdbId || (object(data.ids).tmdb!=null?id(object(data.ids).tmdb):null);
   const images=object(data.images),posters=Array.isArray(images.poster)?images.poster:[];
   let chineseTitle:string|null=work.chineseTitle,description=work.description||string(data.overview)||null,poster=typeof posters[0]==='string'?posters[0]:'',runtime=typeof data.runtime==='number'&&data.runtime>0?data.runtime:null;
   if(!chineseTitle||!work.description){
    try{const translations=(await ownerRead(ownerId,`${path}/translations/zh`)).data;if(Array.isArray(translations)){const t=object(translations.find(t=>object(t).country==='cn')||translations[0]);chineseTitle=string(t.title)||chineseTitle;description=string(t.overview)||description;}}catch(error){if(error instanceof TraktError&&[401,429].includes(error.status))throw error;}
   }
   let airedEpisodes=integer(data.aired_episodes);
   if(process.env.TMDB_READ_ACCESS_TOKEN&&tmdbId&&(!chineseTitle||(!work.posterPath&&!poster)||!description||!runtime)){
    const response=await fetch(`https://api.themoviedb.org/3/${work.kind==='movie'?'movie':'tv'}/${encodeURIComponent(tmdbId)}?language=zh-CN`,{headers:{Authorization:`Bearer ${process.env.TMDB_READ_ACCESS_TOKEN}`},cache:'no-store',signal:AbortSignal.timeout(20000),redirect:'error'});
    if(response.ok){const tmdb=object(await response.json());chineseTitle=chineseTitle||string(tmdb.title)||string(tmdb.name)||null;description=description||string(tmdb.overview)||null;
     if(!work.posterPath&&!poster&&/^\/[a-zA-Z0-9_.-]+$/.test(string(tmdb.poster_path)))poster=`https://image.tmdb.org/t/p/w500${tmdb.poster_path}`;
     if(!runtime&&work.kind==='movie'&&typeof tmdb.runtime==='number'&&tmdb.runtime>0)runtime=tmdb.runtime;
     // Do not use total planned TMDB episode counts as an aired-progress denominator.
    }
   }
   let posterPath=work.posterPath;if(!posterPath&&poster)try{posterPath=await cachePoster(poster);}catch(err){console.warn(`[metadata] ${new Date().toISOString()} poster fetch: ${safeError(err)}`);}
   // A transient translation/TMDB failure must not erase values obtained by an earlier refresh.
   await db.media.update({where:{id:work.id},data:{originalTitle:string(data.title)||work.originalTitle,year:integer(data.year)??work.year,tmdbId,chineseTitle:chineseTitle??work.chineseTitle,description:description??work.description,runtime:runtime??work.runtime,rating:typeof data.rating==='number'&&Number(data.votes)>0?data.rating:work.rating,airedEpisodes:airedEpisodes??work.airedEpisodes,posterPath,metadataAt:new Date()}});
   mediaBackoff.delete(work.id);
  }catch(error){
   if(error instanceof TraktError&&[401,429].includes(error.status))break;
   const is404=error instanceof TraktError&&error.status===404;
   // Back off failing items so broken/404 works do not permanently occupy the head of the queue.
   mediaBackoff.set(work.id,Date.now()+(is404?24:1)*3600000);
   if(is404){await db.media.update({where:{id:work.id},data:{metadataAt:work.kind==='movie'?new Date(Date.now()-29*86400000):new Date()}}).catch(()=>{});}
   console.warn(`[metadata] ${new Date().toISOString()} item skipped: ${safeError(error)}`);
  }
 }
 // Episode-specific runtime takes priority over a show's average runtime.
 const state=await db.syncState.findUnique({where:{ownerId}});
 const blockedEpisodeIds=activeBackoffIds(episodeBackoff,Date.now());
 const baseWhere={runtime:null,events:{some:{ownerId}},...(blockedEpisodeIds.length?{id:{notIn:blockedEpisodeIds}}:{})};
 let episodes=await db.episode.findMany({where:{...baseWhere,...(state?.metadataCursor?{id:{gt:state.metadataCursor}}:{})},orderBy:{id:'asc'},take:limit});
 if(!episodes.length&&state?.metadataCursor)episodes=await db.episode.findMany({where:baseWhere,orderBy:{id:'asc'},take:limit});
 for(const episode of episodes){
  try{
   const data=object((await ownerRead(ownerId,`/shows/${episode.showId.split(':')[1]}/seasons/${episode.season}/episodes/${episode.number}`,{extended:'full'})).data);
   if(typeof data.runtime==='number'&&data.runtime>0)await db.episode.update({where:{id:episode.id},data:{runtime:data.runtime,title:string(data.title)||episode.title}});
   episodeBackoff.delete(episode.id);
  }catch(error){
   if(error instanceof TraktError&&[401,429].includes(error.status))break;
   const is404=error instanceof TraktError&&error.status===404;
   episodeBackoff.set(episode.id,Date.now()+(is404?24:1)*3600000);
   console.warn(`[metadata] ${new Date().toISOString()} episode skipped: ${safeError(error)}`);
  }
  // Advance even when an episode fails or has no runtime, so it cannot starve later episodes.
  await db.syncState.upsert({where:{ownerId},create:{ownerId,metadataCursor:episode.id},update:{metadataCursor:episode.id}});
 }
 }finally{
  activeMetadataOwners.delete(ownerId);
 }
}
