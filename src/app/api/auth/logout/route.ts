import { NextResponse } from 'next/server';
import { checkMutation, requireSession, apiFailure } from '@/lib/server/session';
import { cookieOptions, sessionCookie } from '@/lib/server/config';
import { db } from '@/lib/server/db';
export async function POST(request:Request){
 try{const session=await requireSession(request);checkMutation(request,session);await db.session.deleteMany({where:{id:session.id}});const response=NextResponse.json({ok:true},{headers:{'Cache-Control':'no-store'}});response.cookies.set(sessionCookie,'',cookieOptions(0));return response;}catch(error){return apiFailure(error);}
}
