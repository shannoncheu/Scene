import { after } from 'next/server';
import { requireSession,checkMutation,privateJson,apiFailure } from '@/lib/server/session';
import { boundedBody } from '@/lib/server/files';
import { object } from '@/lib/server/history';
import { getDateEdit,prepareDateEdit,confirmDateEdit,runDateEdit,cancelDateEdit,retryUncertainDateEdit,abandonDateEdit } from '@/lib/server/history-date-edit';
export const runtime='nodejs';
export async function GET(request:Request){try{
 const session=await requireSession(request),id=new URL(request.url).searchParams.get('id')||undefined;
 if(id&&!/^[a-f0-9-]{36}$/.test(id))throw Error('INVALID_INPUT');
 return privateJson({operation:await getDateEdit(session.ownerId,id)});
}catch(e){return apiFailure(e);}}
export async function POST(request:Request){try{
 const session=await requireSession(request);checkMutation(request,session);
 const body=object(JSON.parse((await boundedBody(request,16384)).toString('utf8')));
 if(body.action==='prepare')return privateJson({operation:await prepareDateEdit(session.ownerId,body)});
 if(body.action==='cancel'&&typeof body.id==='string'&&/^[a-f0-9-]{36}$/.test(body.id))return privateJson({operation:await cancelDateEdit(session.ownerId,body.id)});
 if(body.action==='retry_add'&&body.confirmed===true&&typeof body.id==='string'&&/^[a-f0-9-]{36}$/.test(body.id)){
  const operation=await retryUncertainDateEdit(session.ownerId,body.id);
  if(operation.status==='queued')after(()=>runDateEdit(session.ownerId));
  return privateJson({operation},operation.status==='queued'?202:200);
 }
 if(body.action==='abandon'&&body.confirmed===true&&typeof body.id==='string'&&/^[a-f0-9-]{36}$/.test(body.id)){
  return privateJson({operation:await abandonDateEdit(session.ownerId,body.id)});
 }
 if(body.action==='confirm'&&body.confirmed===true&&typeof body.id==='string'&&/^[a-f0-9-]{36}$/.test(body.id)){
  const operation=await confirmDateEdit(session.ownerId,body.id);after(()=>runDateEdit(session.ownerId));return privateJson({operation},202);
 }
 throw Error('CONFIRMATION_REQUIRED');
}catch(e){
 const code=e instanceof Error?e.message:'';
 const known=['INVALID_INPUT','EVENT_NOT_FOUND','DATE_EDIT_BUSY','TOO_MANY_RECORDS','RELEASE_DATE_UNAVAILABLE','INVALID_TIMEZONE','INVALID_TIME','FUTURE_TIME','NONEXISTENT_LOCAL_TIME','AMBIGUOUS_LOCAL_TIME','DRAFT_EXPIRED','WRITES_DISABLED','CONFIRMATION_REQUIRED','DATE_EDIT_IN_PROGRESS'];
 return known.includes(code)?privateJson({error:code},400):apiFailure(e);
}}
