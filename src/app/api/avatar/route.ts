import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/server/db';
import { apiFailure, requireSession, checkMutation, privateJson } from '@/lib/server/session';
import { atomicFile, boundedBody, dataDir } from '@/lib/server/files';
import { avatarImage } from '@/lib/server/avatar';
import { IMMUTABLE_PRIVATE, REVALIDATE_PRIVATE, avatarVersion } from '@/lib/server/config';
export const runtime='nodejs';
const valid=(s:string)=>/^[a-f0-9-]{36}\.webp$/.test(s);
export async function GET(request:Request){try{const {owner}=await requireSession(request);if(!owner.avatarPath||!valid(owner.avatarPath))return new Response(null,{status:404});const version=(new URL(request.url).searchParams.get('v')||'').split('-')[0];const cache=version&&version===avatarVersion(owner.avatarPath)?IMMUTABLE_PRIVATE:REVALIDATE_PRIVATE;try{const bytes=await readFile(join(dataDir(),'avatars',owner.avatarPath));return new Response(bytes,{headers:{'Content-Type':'image/webp','Cache-Control':cache,'X-Content-Type-Options':'nosniff'}});}catch(err){if(err&&typeof err==='object'&&'code' in err&&err.code==='ENOENT')return new Response(null,{status:404});throw err;}}catch(error){return apiFailure(error);}}
export async function POST(request:Request){
 try{
  const session=await requireSession(request);checkMutation(request,session);
  const url=new URL(request.url),x=Number(url.searchParams.get('x')),y=Number(url.searchParams.get('y')),size=Number(url.searchParams.get('size'));
  const image=await avatarImage(await boundedBody(request,5*1024*1024),request.headers.get('content-type')||'',{x,y,size});
  const name=randomUUID()+'.webp';await atomicFile('avatars',name,image);await db.owner.update({where:{id:session.ownerId},data:{avatarPath:name}});
  if(session.owner.avatarPath&&valid(session.owner.avatarPath))await unlink(join(dataDir(),'avatars',session.owner.avatarPath)).catch(()=>{});
  return privateJson({ok:true});
 }catch(error){return apiFailure(error);}
}
export async function DELETE(request:Request){try{const session=await requireSession(request);checkMutation(request,session);await db.owner.update({where:{id:session.ownerId},data:{avatarPath:null}});if(session.owner.avatarPath&&valid(session.owner.avatarPath))await unlink(join(dataDir(),'avatars',session.owner.avatarPath)).catch(()=>{});return privateJson({ok:true});}catch(error){return apiFailure(error);}}
