import { after } from 'next/server';
import { db } from '@/lib/server/db';
import { requireSession,checkMutation,privateJson,apiFailure } from '@/lib/server/session';
import { boundedBody } from '@/lib/server/files';
import { prepareManual,confirmManual,intentView } from '@/lib/server/manual-history';
import { object } from '@/lib/server/history';
import { hydrateMetadata } from '@/lib/server/metadata';
import { executeManualSync } from '@/lib/server/sync';
export const runtime='nodejs';
export async function GET(request:Request){try{
 const session=await requireSession(request),id=new URL(request.url).searchParams.get('id');
 if(id){const row=await db.manualHistoryIntent.findFirst({where:{id,ownerId:session.ownerId}});if(!row)throw new Error('INVALID_INPUT');return privateJson({intent:intentView(row)});}
 const rows=await db.manualHistoryIntent.findMany({where:{ownerId:session.ownerId,status:{in:['sending','checking','uncertain','retryable']}},orderBy:{createdAt:'desc'},take:10});return privateJson({pending:rows.map(intentView)});
}catch(error){return apiFailure(error);}}
export async function POST(request:Request){try{
 const session=await requireSession(request);checkMutation(request,session);
 const body=object(JSON.parse((await boundedBody(request,16384)).toString('utf8')));
 if(body.action==='prepare')return privateJson({intent:await prepareManual(session.ownerId,body)});
 if((body.action==='confirm'||body.action==='check')&&typeof body.id==='string'&&/^[a-f0-9-]{36}$/.test(body.id)){
  if(body.action==='confirm'&&body.confirmed!==true)throw new Error('CONFIRMATION_REQUIRED');
  const intent=await confirmManual(session.ownerId,body.id,body.action==='confirm');
  if(intent.status==='confirmed'){
   after(async()=>{
    const res=await executeManualSync(session.ownerId,'latest');
    if(res.error&&res.error!=='RATE_LIMITED'&&res.error!=='REAUTHORIZE_REQUIRED'){
     await hydrateMetadata(session.ownerId).catch(()=>{});
    }
   });
  }
  return privateJson({intent});
 }
 throw new Error('INVALID_INPUT');
}catch(error){
 const code=error instanceof Error?error.message:'';
 const known=['CONFIRMATION_REQUIRED','INVALID_TIME','INVALID_TIMEZONE','NONEXISTENT_LOCAL_TIME','AMBIGUOUS_LOCAL_TIME','FUTURE_TIME','EPISODE_REQUIRED','DRAFT_EXPIRED'];
 return known.includes(code)?privateJson({error:code},400):apiFailure(error);
}}
