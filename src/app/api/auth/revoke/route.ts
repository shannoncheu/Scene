import { NextResponse } from 'next/server';
import { checkMutation, requireSession, apiFailure } from '@/lib/server/session';
import { cookieOptions, sessionCookie } from '@/lib/server/config';
import { db } from '@/lib/server/db';
import { accessToken, oauthPost } from '@/lib/server/trakt';
export async function POST(request:Request){
 try{
  const session=await requireSession(request);checkMutation(request,session);
  const token=await accessToken(session.ownerId);await oauthPost('revoke',{token,client_id:process.env.TRAKT_CLIENT_ID!});
  await db.$transaction([db.historyDateEdit.updateMany({where:{ownerId:session.ownerId,activeOwnerKey:session.ownerId},data:{status:'paused',errorCode:'REAUTHORIZE_REQUIRED'}}),db.owner.update({where:{id:session.ownerId},data:{encryptedAccessToken:null,encryptedRefreshToken:null,tokenExpiresAt:null}}),db.session.deleteMany({where:{ownerId:session.ownerId}})]);
  const response=NextResponse.json({ok:true},{headers:{'Cache-Control':'no-store'}});response.cookies.set(sessionCookie,'',cookieOptions(0));return response;
 }catch(error){return apiFailure(error);}
}
