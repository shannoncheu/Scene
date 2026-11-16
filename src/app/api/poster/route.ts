import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '@/lib/server/db';
import { apiFailure, requireSession } from '@/lib/server/session';
import { dataDir } from '@/lib/server/files';
import { IMMUTABLE_PRIVATE, REVALIDATE_PRIVATE, posterVersion } from '@/lib/server/config';
export async function GET(request:Request){try{
 await requireSession(request);const params=new URL(request.url).searchParams,id=params.get('id')||'',version=params.get('v')||'';
 const media=await db.media.findFirst({where:{id},select:{posterPath:true}});
 if(!media?.posterPath||!/^[a-f0-9]{64}\.webp$/.test(media.posterPath))return new Response(null,{status:404});
 // Versioned URLs point at a content-addressed file and can be cached by the browser for a year.
 const cache=version&&version===posterVersion(media.posterPath)?IMMUTABLE_PRIVATE:REVALIDATE_PRIVATE;
 try{const bytes=await readFile(join(dataDir(),'posters',media.posterPath));return new Response(bytes,{headers:{'Content-Type':'image/webp','Cache-Control':cache,'X-Content-Type-Options':'nosniff'}});}
 catch(err){if(err&&typeof err==='object'&&'code' in err&&err.code==='ENOENT')return new Response(null,{status:404});throw err;}
}catch(error){return apiFailure(error);}}
