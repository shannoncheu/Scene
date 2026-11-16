import { db } from '@/lib/server/db';
import { boundedBody } from '@/lib/server/files';
import { apiFailure, requireSession, checkMutation, privateJson } from '@/lib/server/session';
export async function POST(request:Request){try{const session=await requireSession(request);checkMutation(request,session);const body=JSON.parse((await boundedBody(request,4096)).toString('utf8')) as {timezone?:unknown};if(typeof body.timezone!=='string'||body.timezone.length>80)throw new Error('INVALID_INPUT');try{new Intl.DateTimeFormat('en',{timeZone:body.timezone}).format();}catch{throw new Error('INVALID_INPUT');}await db.owner.update({where:{id:session.ownerId},data:{timezone:body.timezone}});return privateJson({ok:true});}catch(error){return apiFailure(error);}}
