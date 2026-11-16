import { apiFailure,privateJson,requireSession } from '@/lib/server/session';
import { searchCatalog,seasons,seasonEpisodes } from '@/lib/server/catalog';
export async function GET(request:Request){try{
 const session=await requireSession(request),q=new URL(request.url).searchParams,action=q.get('action');
 if(action==='search'){const type=q.get('type');if(type!=='movie'&&type!=='show')throw new Error('INVALID_INPUT');return privateJson({items:await searchCatalog(session.ownerId,type,q.get('query')||'')});}
 if(action==='seasons')return privateJson({seasons:await seasons(session.ownerId,q.get('id')||'')});
 if(action==='episodes'){if(!/^\d+$/.test(q.get('season')||''))throw new Error('INVALID_INPUT');return privateJson({episodes:await seasonEpisodes(session.ownerId,q.get('id')||'',Number(q.get('season')))});}
 throw new Error('INVALID_INPUT');
}catch(error){return apiFailure(error);}}
