import { NextRequest, NextResponse } from 'next/server';

// Migration fallback: serve cached personal data without contacting Trakt or
// accepting mutations. Enabled only on the retained source instance.
export function middleware(request: NextRequest) {
  if (process.env.SOURCE_ARCHIVE_MODE !== 'true') return NextResponse.next();
  const safeRead = request.method === 'GET' && ['/api/archive', '/api/avatar', '/api/poster'].includes(request.nextUrl.pathname);
  if (safeRead) return NextResponse.next();
  return NextResponse.json({ error: 'SOURCE_ARCHIVE_MODE' }, {
    status: 503,
    headers: { 'Cache-Control': 'no-store', 'Retry-After': '3600' },
  });
}
export const config = { matcher: ['/api/:path*'] };
