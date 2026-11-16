import { parse } from 'lossless-json';
import { db } from './db';
import { decrypt, encrypt } from './crypto';
import { appUrl } from './config';
export const traktUserAgent = () => `CinemaWorkshop/0.2 (+${appUrl().origin})`;
export class TraktError extends Error { constructor(public status: number, public retryAfter=0, public blocked=false) { super(blocked?'TRAKT_SECURITY_CHECK':status===401?'REAUTHORIZE_REQUIRED':status===429?'RATE_LIMITED':`TRAKT_HTTP_${status}`); } }
export function parseTrakt(text: string): unknown { return parse(text,undefined,(value: string)=>/^-?\d+$/.test(value)&&!Number.isSafeInteger(Number(value))?value:Number(value)); }
export function assertReadPath(path: string) {
 const allowed=[
  /^\/users\/settings$/,
  /^\/sync\/(last_activities|history(?:\/(movies|episodes)\/\d+)?)$/,
  /^\/search\/(movie|show)$/,
  /^\/movies\/\d+(?:\/translations\/zh)?$/,
  /^\/shows\/\d+(?:\/translations\/zh|\/seasons(?:\/\d+(?:\/episodes\/\d+)?)?)?$/,
 ];
 if(!allowed.some(pattern=>pattern.test(path)))throw new Error('TRAKT_PATH_BLOCKED');
}
const sleep=(ms: number)=>new Promise(resolve=>setTimeout(resolve,ms));
const MAX_RETRY_AFTER_SECONDS=86400;

/**
 * Parses an HTTP Retry-After header (non-negative seconds or HTTP-date), falling back
 * cleanly on invalid values and clamping to finite bounds.
 */
export function parseRetryAfter(
 header:string|null|undefined,
 fallbackSeconds=60,
 minSeconds=1,
 maxSeconds=MAX_RETRY_AFTER_SECONDS
){
 const clamp=(n:number)=>Math.min(maxSeconds,Math.max(minSeconds,Math.ceil(n)));
 const raw=header?.trim();
 if(!raw)return clamp(fallbackSeconds);
 if(/^\d+$/.test(raw)){
  const seconds=Number(raw);
  return Number.isFinite(seconds)?clamp(seconds):clamp(fallbackSeconds);
 }
 const timestamp=/[a-zA-Z]{3}/.test(raw)?Date.parse(raw):NaN;
 if(Number.isFinite(timestamp))return clamp((timestamp-Date.now())/1000);
 return clamp(fallbackSeconds);
}

// Generic business requests remain GET-only. The sole history-add POST is private to the confirmed manual workflow.
export async function readTrakt(path: string, token: string, query: Record<string,string>={}, transport: typeof fetch=fetch) {
 assertReadPath(path);const url=new URL(path,'https://api.trakt.tv');Object.entries(query).forEach(([k,v])=>url.searchParams.set(k,v));
 for(let attempt=0;attempt<4;attempt++) {
  let response: Response;
  try { response=await transport(url,{method:'GET',headers:{'User-Agent':traktUserAgent(),Accept:'application/json','trakt-api-version':'2','trakt-api-key':process.env.TRAKT_CLIENT_ID || '',Authorization:`Bearer ${token}`},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30000)}); }
  catch { if(attempt===3)throw new Error('TRAKT_NETWORK_FAILED');await sleep(500*2**attempt);continue; }
  const retry=parseRetryAfter(response.headers.get('Retry-After'),2**attempt+Math.random());
  if(response.status===429 || response.status>=500) {
   if(attempt===3 || retry>15)throw new TraktError(response.status,retry);
   await sleep(retry*1000);continue;
  }
  if(!response.ok)throw new TraktError(response.status,0,response.status===403&&(response.headers.get('content-type')||'').includes('text/html'));
  return {data:parseTrakt(await response.text()),headers:response.headers};
 }
 throw new Error('TRAKT_NETWORK_FAILED');
}
export async function oauthPost(path: 'token'|'revoke', body: Record<string,string>) {
 const response=await fetch(`https://auth.trakt.tv/oauth/${path}`,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json','User-Agent':traktUserAgent()},body:JSON.stringify(body),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new TraktError(response.status,parseRetryAfter(response.headers.get('Retry-After'),60),response.status===403&&(response.headers.get('content-type')||'').includes('text/html'));
 if(path==='revoke')return null;
 return await response.json() as {access_token:string;refresh_token:string;expires_in:number;created_at:number;token_type:string};
}
export async function saveTokens(
 ownerId:string,
 tokens:NonNullable<Awaited<ReturnType<typeof oauthPost>>>,
 expected?:{encryptedAccessToken:string|null;encryptedRefreshToken:string|null}
) {
 if(!tokens.access_token||!tokens.refresh_token||!Number.isFinite(tokens.expires_in))throw new Error('TOKEN_RESPONSE_INVALID');
 const data={
  encryptedAccessToken:encrypt(tokens.access_token),
  encryptedRefreshToken:encrypt(tokens.refresh_token),
  tokenExpiresAt:new Date(((tokens.created_at || Math.floor(Date.now()/1000))+tokens.expires_in)*1000),
  ...(!expected?{refreshLeaseUntil:null}:{}),
 };
 if(expected){
  const res=await db.owner.updateMany({where:{id:ownerId,encryptedAccessToken:expected.encryptedAccessToken,encryptedRefreshToken:expected.encryptedRefreshToken},data});
  return res.count>0;
 }
 await db.owner.update({where:{id:ownerId},data});
 return true;
}
export async function accessToken(ownerId:string, force=false) {
 for(let attempt=0;attempt<30;attempt++) {
  const owner=await db.owner.findUniqueOrThrow({where:{id:ownerId}});
  if(!owner.encryptedAccessToken||!owner.encryptedRefreshToken)throw new Error('REAUTHORIZE_REQUIRED');
  if(!force&&owner.tokenExpiresAt && owner.tokenExpiresAt.getTime()>Date.now()+120000)return decrypt(owner.encryptedAccessToken);
  const leaseUntil=new Date(Date.now()+60000+Math.floor(Math.random()*1000));
  const lock=await db.owner.updateMany({where:{id:ownerId,OR:[{refreshLeaseUntil:null},{refreshLeaseUntil:{lt:new Date()}}]},data:{refreshLeaseUntil:leaseUntil}});
  if(!lock.count){await sleep(1000);force=false;continue;}
  try {
   // Re-read after acquiring the persistent lease: refresh tokens are single-use.
   const current=await db.owner.findUniqueOrThrow({where:{id:ownerId}});
   if(!current.encryptedAccessToken||!current.encryptedRefreshToken)throw new Error('REAUTHORIZE_REQUIRED');
   if(!force&&current.tokenExpiresAt&&current.tokenExpiresAt.getTime()>Date.now()+120000)return decrypt(current.encryptedAccessToken);
   const expected={encryptedAccessToken:current.encryptedAccessToken,encryptedRefreshToken:current.encryptedRefreshToken};
   let tokens:Awaited<ReturnType<typeof oauthPost>>;
   try{
    tokens=await oauthPost('token',{redirect_uri:new URL('/api/auth/callback',appUrl()).href,grant_type:'refresh_token',refresh_token:decrypt(current.encryptedRefreshToken),client_id:process.env.TRAKT_CLIENT_ID!});
   }catch(error){
    if(error instanceof TraktError && [400,401].includes(error.status)){
     // Only revoke stored credentials if the owner did not already re-authorize during the in-flight request.
     const cleared=await db.$transaction(async tx=>{
      const updated=await tx.owner.updateMany({where:{id:ownerId,...expected},data:{encryptedAccessToken:null,encryptedRefreshToken:null,tokenExpiresAt:null}});
      if(updated.count>0)await tx.session.deleteMany({where:{ownerId}});
      return updated.count>0;
     });
     if(!cleared){
      const latest=await db.owner.findUniqueOrThrow({where:{id:ownerId}});
      if(latest.encryptedAccessToken&&latest.encryptedRefreshToken)return decrypt(latest.encryptedAccessToken);
     }
     throw new Error('REAUTHORIZE_REQUIRED');
    }
    throw error;
   }
   const saved=await saveTokens(ownerId,tokens!,expected);
   if(saved)return tokens!.access_token;
   const latest=await db.owner.findUniqueOrThrow({where:{id:ownerId}});
   if(latest.encryptedAccessToken&&latest.encryptedRefreshToken)return decrypt(latest.encryptedAccessToken);
   throw new Error('REAUTHORIZE_REQUIRED');
  }finally{await db.owner.updateMany({where:{id:ownerId,refreshLeaseUntil:leaseUntil},data:{refreshLeaseUntil:null}});}
 }
 throw new Error('TOKEN_REFRESH_BUSY');
}
export async function ownerRead(ownerId:string,path:string,query:Record<string,string>={}){
 try{return await readTrakt(path,await accessToken(ownerId),query);}catch(error){if(error instanceof TraktError&&error.status===401)return readTrakt(path,await accessToken(ownerId,true),query);throw error;}
}
