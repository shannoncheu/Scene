import { archiveEtag, loadArchiveSnapshot } from '@/lib/server/archive';
import { apiFailure, requireSession } from '@/lib/server/session';
// The dashboard polls this endpoint. A lightweight fingerprint ETag lets unchanged polls return 304
// before querying or serializing the full watch history and media descriptions.
export async function GET(request:Request){try{
 const session=await requireSession(request);
 const etag=await archiveEtag(session.ownerId,session.csrf);
 const baseHeaders={'Cache-Control':'private, no-cache','X-Content-Type-Options':'nosniff'};
 // Caddy's `encode` appends the content-encoding to strong ETags (e.g. "abc-zstd"); normalise before comparing.
 const match=(request.headers.get('if-none-match')||'').split(',').map(v=>v.trim().replace(/^W\//,'').replace(/-(zstd|gzip|br)"$/,'"'));
 if(match.includes(etag))return new Response(null,{status:304,headers:{...baseHeaders,ETag:etag}});
 const snapshot=await loadArchiveSnapshot(session.ownerId,session.csrf);
 const body=JSON.stringify(snapshot.data);
 return new Response(body,{status:200,headers:{...baseHeaders,ETag:snapshot.etag,'Content-Type':'application/json'}});
}catch(error){return apiFailure(error);}}
