import { cookies } from 'next/headers';
import { db } from './db';
import { hash, randomSecret } from './crypto';
import { appUrl, authReady, sessionCookie } from './config';
export function cookieValue(request: Request, name: string) {
 return request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1) || '';
}
export async function sessionByToken(token: string) {
 if(!authReady() || !token)return null;
 const session=await db.session.findUnique({where:{id:hash(token)},include:{owner:true}});
 if(!session || session.expiresAt.getTime()<Date.now() || !session.owner.encryptedAccessToken)return null;
 if(process.env.TRAKT_ALLOWED_USER_ID && session.owner.traktUserId!==process.env.TRAKT_ALLOWED_USER_ID)return null;
 if(!process.env.TRAKT_ALLOWED_USER_ID && session.owner.username.toLowerCase()!==(process.env.TRAKT_ALLOWED_USERNAME||'').toLowerCase())return null;
 return session;
}
export async function pageSession(){ return sessionByToken((await cookies()).get(sessionCookie)?.value || ''); }
export async function requireSession(request: Request) {
 const session=await sessionByToken(cookieValue(request,sessionCookie));
 if(!session)throw new Error('UNAUTHORIZED');return session;
}
export function checkMutation(request: Request, session: {csrf: string}) {
 if(request.headers.get('origin')!==appUrl().origin || request.headers.get('x-csrf-token')!==session.csrf)throw new Error('CSRF_REJECTED');
}
export async function createSession(ownerId: string) {
 const token=randomSecret(),csrf=randomSecret();
 await db.session.create({data:{id:hash(token),ownerId,csrf,expiresAt:new Date(Date.now()+30*86400000)}});
 await db.session.deleteMany({where:{expiresAt:{lt:new Date()}}});
 return {token,csrf};
}
export function privateJson(value: unknown, status=200) { return Response.json(value,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}}); }
export function apiFailure(error: unknown) {
 const message=error instanceof Error?error.message:'';
 const allowed=['UNAUTHORIZED','CSRF_REJECTED','RATE_LIMITED','REAUTHORIZE_REQUIRED','SYNC_BUSY','INVALID_INPUT','FILE_INVALID','FILE_TOO_LARGE','AUTH_CONFIGURATION_REQUIRED','ITEM_NOT_FOUND','WRITES_DISABLED','TRAKT_HTTP_403','TRAKT_HTTP_420','TRAKT_HTTP_429'];
 const upstream=['TRAKT_NETWORK_FAILED','TRAKT_SECURITY_CHECK','CATALOG_UNAVAILABLE','ARTWORK_UNAVAILABLE'].includes(message)||/^TRAKT_HTTP_5\d\d$/.test(message);
 const busy=['TOKEN_REFRESH_BUSY'].includes(message);
 // Domain errors use UPPER_SNAKE codes (client problems -> 4xx). Upstream/transient faults -> 502/503; unexpected faults -> 500.
 const domain=/^[A-Z][A-Z0-9_]{2,60}$/.test(message)||error instanceof SyntaxError;
 if(!domain||upstream)console.error(`[api] ${new Date().toISOString()} error: ${domain?message:(error instanceof Error?error.name:'unknown')}`);
 const status=message==='UNAUTHORIZED'?401:(message==='CSRF_REJECTED'||message==='WRITES_DISABLED'||message==='TRAKT_HTTP_403')?403:message==='ITEM_NOT_FOUND'?404:message==='SYNC_BUSY'?409:message==='FILE_TOO_LARGE'?413:message==='TRAKT_HTTP_420'?422:(message==='RATE_LIMITED'||message==='TRAKT_HTTP_429')?429:upstream?502:busy?503:domain?400:500;
 return privateJson({error:allowed.includes(message)?message:upstream||busy?message:'REQUEST_FAILED'},status);
}
