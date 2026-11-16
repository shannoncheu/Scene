import { NextResponse } from 'next/server';
import { appUrl, assertAuthReady, cookieOptions, oauthCookie, safeError } from '@/lib/server/config';
import { challenge, encrypt, hash, randomSecret } from '@/lib/server/crypto';
import { db } from '@/lib/server/db';
export const runtime='nodejs';
// Per-client throttle so a single source cannot exhaust the global attempt cap and lock the owner out.
const WINDOW_MS=10*60*1000,PER_CLIENT=10,GLOBAL_CAP=1000;
const attempts=(globalThis as unknown as {cinemaLoginAttempts?:Map<string,{count:number;reset:number}>});
const buckets=attempts.cinemaLoginAttempts??=new Map();
function normalizeIpKey(raw:string){
 const ip=raw.replace(/^::ffff:/i,'').split('%')[0].toLowerCase();
 if(!ip.includes(':'))return ip;
 // Collapse IPv6 addresses to their /64 prefix so rotating interface IDs cannot bypass throttling.
 const [head='',tail='']=ip.split('::');
 const h=head?head.split(':'):[];
 const t=tail?tail.split(':'):[];
 const missing=Math.max(0,8-h.length-t.length);
 const full=[...h,...Array<string>(missing).fill('0'),...t].slice(0,8).map(g=>g.padStart(4,'0'));
 return full.length>=4?`${full.slice(0,4).join(':')}::/64`:ip;
}
function clientKey(request:Request){
 // Caddy (the only ingress) replaces X-Forwarded-For with the real peer address.
 const forwarded=request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
 return normalizeIpKey(forwarded||request.headers.get('x-real-ip')||'unknown');
}
function throttled(key:string,now=Date.now()){
 if(buckets.size>5000)for(const [k,v] of buckets)if(v.reset<=now)buckets.delete(k);
 const bucket=buckets.get(key);
 if(!bucket||bucket.reset<=now){buckets.set(key,{count:1,reset:now+WINDOW_MS});return false;}
 bucket.count++;return bucket.count>PER_CLIENT;
}
export async function GET(request:Request) {
 try {
  assertAuthReady();
 } catch {
  return NextResponse.redirect(new URL('/login?error=configuration',appUrl()));
 }
 try {
  if(throttled(clientKey(request)))return NextResponse.redirect(new URL('/login?error=rate_limited',appUrl()));
  const state=randomSecret(),verifier=randomSecret();
  await db.oAuthAttempt.deleteMany({where:{expiresAt:{lt:new Date()}}});
  // Cap DB rows globally by evicting the oldest uncompleted attempts rather than locking out the owner,
  // and mirror the encrypted PKCE state in an HttpOnly cookie so an active login still completes even if evicted.
  const activeCount=await db.oAuthAttempt.count();
  if(activeCount>=GLOBAL_CAP){
   const oldest=await db.oAuthAttempt.findMany({orderBy:{expiresAt:'asc'},take:Math.max(1,activeCount-GLOBAL_CAP+50),select:{id:true}});
   if(oldest.length)await db.oAuthAttempt.deleteMany({where:{id:{in:oldest.map(r=>r.id)}}});
  }
  const exp=Date.now()+600000;
  await db.oAuthAttempt.create({data:{id:hash(state),verifier:encrypt(verifier),expiresAt:new Date(exp)}});
  const url=new URL('https://auth.trakt.tv/oauth/authorize');
  Object.entries({response_type:'code',client_id:process.env.TRAKT_CLIENT_ID!,redirect_uri:new URL('/api/auth/callback',appUrl()).href,state,code_challenge:challenge(verifier),code_challenge_method:'S256'}).forEach(([key,value])=>url.searchParams.set(key,value));
  const response=NextResponse.redirect(url);
  response.cookies.set(oauthCookie,state,cookieOptions(600));
  response.cookies.set(oauthCookie+'_pkce',encrypt(JSON.stringify({s:state,v:verifier,exp})),cookieOptions(600));
  return response;
 }catch(error){
  console.error(`[auth] ${new Date().toISOString()} login init failed: ${safeError(error)}`);
  return NextResponse.redirect(new URL('/login?error=storage',appUrl()));
 }
}
