import { NextResponse } from 'next/server';
import { appUrl, assertAuthReady, cookieOptions, oauthCookie, sessionCookie } from '@/lib/server/config';
import { decrypt, hash } from '@/lib/server/crypto';
import { db } from '@/lib/server/db';
import { cookieValue, createSession } from '@/lib/server/session';
import { oauthPost, readTrakt, saveTokens, TraktError } from '@/lib/server/trakt';
export const runtime='nodejs';
const pkceCookie=oauthCookie+'_pkce';
const consumedPkce=((globalThis as unknown as {cinemaConsumedPkce?:Map<string,number>}).cinemaConsumedPkce??=new Map());
function consumeCookieVerifier(request:Request,state:string):string|null{
 const raw=cookieValue(request,pkceCookie);if(!raw)return null;
 const now=Date.now();
 if(consumedPkce.size>2000)for(const [k,exp] of consumedPkce)if(exp<=now)consumedPkce.delete(k);
 const stateHash=hash(state);
 if(consumedPkce.has(stateHash))return null;
 try{
  const parsed=JSON.parse(decrypt(raw)) as {s?:string;v?:string;exp?:number};
  if(parsed.s!==state||typeof parsed.v!=='string'||typeof parsed.exp!=='number'||parsed.exp<now)return null;
  consumedPkce.set(stateHash,parsed.exp);
  return parsed.v;
 }catch{return null;}
}
export async function GET(request: Request) {
 let stage='configuration';
 const hadPkceCookie=!!cookieValue(request,pkceCookie);
 try {
  assertAuthReady();stage='state';const url=new URL(request.url),state=url.searchParams.get('state'),code=url.searchParams.get('code');
  if(!state||!code||state.length>128||code.length>2048||state!==cookieValue(request,oauthCookie))throw new Error('OAUTH_STATE_INVALID');
  const attempt=await db.oAuthAttempt.findUnique({where:{id:hash(state)}});
  let codeVerifier:string|null=null;
  if(attempt){
   if(attempt.expiresAt.getTime()<Date.now()){await db.oAuthAttempt.deleteMany({where:{id:hash(state)}});throw new Error('OAUTH_STATE_INVALID');}
   const consumed=await db.oAuthAttempt.deleteMany({where:{id:hash(state)}});if(!consumed.count)throw new Error('OAUTH_STATE_INVALID');
   consumedPkce.set(hash(state),attempt.expiresAt.getTime());
   codeVerifier=decrypt(attempt.verifier);
  }else{
   codeVerifier=consumeCookieVerifier(request,state);
   if(!codeVerifier)throw new Error('OAUTH_STATE_INVALID');
  }
  stage='token';
  const tokens=await oauthPost('token',{client_id:process.env.TRAKT_CLIENT_ID!,code,code_verifier:codeVerifier,grant_type:'authorization_code',redirect_uri:new URL('/api/auth/callback',appUrl()).href});
  stage='profile';
  const {data}=await readTrakt('/users/settings',tokens!.access_token);
  const profile=(data as {user?:{username?:string;ids?:{slug?:string;uuid?:string};uuid?:string}}).user;
  const username=profile?.username,identifier=profile?.ids?.uuid || profile?.uuid;
  const expectedName=(process.env.TRAKT_ALLOWED_USERNAME||'').toLowerCase();
  const bound=await db.owner.findFirst();
  const allowed=!!identifier&&!!username&&(bound?bound.traktUserId===identifier:process.env.TRAKT_ALLOWED_USER_ID?process.env.TRAKT_ALLOWED_USER_ID===identifier:username.toLowerCase()===expectedName);
  if(!allowed){await oauthPost('revoke',{token:tokens!.access_token,client_id:process.env.TRAKT_CLIENT_ID!}).catch(()=>{});throw new Error('ACCOUNT_NOT_ALLOWED');}
  stage='storage';
  const owner=await db.owner.upsert({where:{traktUserId:identifier!},create:{traktUserId:identifier!,username:username!,timezone:process.env.DEFAULT_TIMEZONE||'Asia/Shanghai'},update:{}});
  await saveTokens(owner.id,tokens!);
  // Keep the original configured username stable if the account later renames itself.
  stage='session';
  const session=await createSession(owner.id);
  const response=NextResponse.redirect(new URL('/',appUrl()));response.cookies.set(sessionCookie,session.token,cookieOptions(30*86400));response.cookies.set(oauthCookie,'',cookieOptions(0));if(hadPkceCookie)response.cookies.set(pkceCookie,'',cookieOptions(0));return response;
 }catch(error){
  const code=error instanceof TraktError&&error.blocked?'trakt_blocked':error instanceof Error&&error.message==='ACCOUNT_NOT_ALLOWED'?'account':stage;
  console.warn(JSON.stringify({event:'oauth_callback_failed',stage,code,...(error instanceof TraktError?{httpStatus:error.status}:{})}));
  const response=NextResponse.redirect(new URL('/login?error='+code,appUrl()));response.cookies.set(oauthCookie,'',cookieOptions(0));if(hadPkceCookie)response.cookies.set(pkceCookie,'',cookieOptions(0));return response;
 }
}
