import { db } from './db';
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './files';
import { ownerRead } from './trakt';
import { object, string, integer, id } from './history';
import { cachePoster } from './metadata';
import { posterUrl } from './config';
import type { CatalogItem, EpisodeOption } from '../catalog-types';
export function numericId(value:unknown){const result=id(value);if(result==='0'||!Number.isSafeInteger(Number(result)))throw new Error('INVALID_INPUT');return result;}
export async function catalogItem(kind:'movie'|'show',raw:unknown):Promise<CatalogItem>{
 const item=object(raw),ids=object(item.ids),traktId=numericId(ids.trakt),key=`${kind}:${traktId}`;
 const cached=await db.media.findUnique({where:{id:key}});let posterPath=cached?.posterPath||null;
 // Refresh the file age so the artwork cleanup grace period restarts while this result may be drafted.
 if(posterPath&&/^[a-f0-9]{64}\.webp$/.test(posterPath)){const now=new Date();await utimes(join(dataDir(),'posters',posterPath),now,now).catch(()=>{});}
 const posters=object(item.images).poster;
 if(!posterPath&&Array.isArray(posters)&&typeof posters[0]==='string')try{posterPath=await cachePoster(posters[0]);}catch{}
 await db.media.upsert({where:{id:key},create:{id:key,kind:kind==='movie'?'movie':'episode',originalTitle:string(item.title)||'未知作品',year:integer(item.year),tmdbId:ids.tmdb==null?null:id(ids.tmdb),runtime:integer(item.runtime),description:string(item.overview)||null,posterPath},update:posterPath?{posterPath}:{}});
 return {kind,id:traktId,title:cached?.chineseTitle||string(item.title)||'未知作品',year:integer(item.year),poster:posterUrl(key,posterPath)};
}
export async function searchCatalog(ownerId:string,kind:'movie'|'show',query:string){
 if(query.trim().length<2||query.length>100)throw new Error('INVALID_INPUT');
 const data=(await ownerRead(ownerId,`/search/${kind}`,{query:query.trim(),extended:'full',limit:'8',page:'1'})).data;
 if(!Array.isArray(data))throw new Error('CATALOG_UNAVAILABLE');
 const matched=data.slice(0,8).map(value=>object(value)).filter(row=>row.type===kind);
 return Promise.all(matched.map(row=>catalogItem(kind,row[kind])));
}
export async function seasons(ownerId:string,showId:string){
 const data=(await ownerRead(ownerId,`/shows/${numericId(showId)}/seasons`)).data;
 if(!Array.isArray(data))throw new Error('CATALOG_UNAVAILABLE');
 return data.map(value=>{const s=object(value);return {number:integer(s.number),title:string(s.title)};}).filter(s=>s.number!==null&&s.number>=0);
}
export async function seasonEpisodes(ownerId:string,showId:string,season:number):Promise<EpisodeOption[]>{
 if(!Number.isInteger(season)||season<0||season>999)throw new Error('INVALID_INPUT');
 const data=(await ownerRead(ownerId,`/shows/${numericId(showId)}/seasons/${season}`,{extended:'full',translations:'zh'})).data;
 if(!Array.isArray(data))throw new Error('CATALOG_UNAVAILABLE');
 return data.map(value=>{const e=object(value);return {id:numericId(object(e.ids).trakt),season:integer(e.season)!,number:integer(e.number)!,title:string(e.title)||'未命名单集'};}).filter(e=>e.season===season&&e.number>=0);
}
