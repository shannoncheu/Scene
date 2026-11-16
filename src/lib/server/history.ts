export type JsonObject=Record<string,unknown>;
export const object=(v:unknown):JsonObject=>v&&typeof v==='object'&&!Array.isArray(v)?v as JsonObject:{};
export const string=(v:unknown)=>typeof v==='string'?v:'';
export const integer=(v:unknown)=>typeof v==='number'&&Number.isInteger(v)?v:null;
export function id(v:unknown){if((typeof v==='string'&&/^\d+$/.test(v))||(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0))return String(v);throw new Error('HISTORY_ID_INVALID');}
export function normalizeHistory(value:unknown){
 const row=object(value),type=string(row.type);if(type!=='movie'&&type!=='episode')throw new Error('HISTORY_TYPE_INVALID');
 const media=object(type==='movie'?row.movie:row.show),ids=object(media.ids),episode=object(row.episode),episodeIds=object(episode.ids);
 const traktId=id(ids.trakt),mediaId=`${type==='movie'?'movie':'show'}:${traktId}`;
 const watched=typeof row.watched_at==='string'&&row.watched_at!=='unknown'?new Date(row.watched_at):null;
 if(watched&&!Number.isFinite(watched.getTime()))throw new Error('HISTORY_DATE_INVALID');
 const season=integer(episode.season),number=integer(episode.number);
 if(type==='episode'&&(season===null||number===null))throw new Error('EPISODE_NUMBER_INVALID');
 const runtime=typeof media.runtime==='number'&&media.runtime>0?media.runtime:null;
 return {
  event:{id:id(row.id),mediaId,episodeId:type==='episode'?id(episodeIds.trakt):null,watchedAt:watched,action:string(row.action)||null},
  media:{id:mediaId,kind:type==='movie'?'movie':'episode',originalTitle:string(media.title)||'未知作品',year:integer(media.year),tmdbId:ids.tmdb==null?null:id(ids.tmdb),runtime,description:string(media.overview)||null,rating:typeof media.rating==='number'?media.rating:null},
  episode:type==='episode'?{id:id(episodeIds.trakt),showId:mediaId,season:season!,number:number!,title:string(episode.title)||null,runtime:typeof episode.runtime==='number'&&episode.runtime>0?episode.runtime:null}:null,
 };
}
