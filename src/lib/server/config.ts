export function appUrl() {
  const value = new URL(process.env.APP_URL || 'http://127.0.0.1:4317');
  if (value.pathname !== '/' || value.search || value.hash || value.username || value.password) throw new Error('APP_URL_INVALID');
  return value;
}
export function secureConfigured() { return appUrl().protocol === 'https:'; }
export function authReady() { return secureConfigured() && !!process.env.TRAKT_CLIENT_ID && !!(process.env.TRAKT_ALLOWED_USER_ID || process.env.TRAKT_ALLOWED_USERNAME) && /^[a-f0-9]{64}$/i.test(process.env.TOKEN_ENCRYPTION_KEY || ''); }
export function assertAuthReady() { if (!authReady()) throw new Error('AUTH_CONFIGURATION_REQUIRED'); }
export const sessionCookie = 'cinema_session';
export const oauthCookie = 'cinema_oauth';
export function cookieOptions(maxAge: number) { return { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', maxAge }; }
export function safeError(error: unknown) {
 const message = error instanceof Error ? error.message : '';
 return /^[A-Z][A-Z0-9_]{2,60}$/.test(message) ? message : 'REQUEST_FAILED';
}
// Poster files are content-addressed (sha256 name), so the name prefix is a safe cache-busting version.
export function posterVersion(posterPath: string) { return posterPath.slice(0, 16); }
export function posterUrl(mediaId: string, posterPath: string | null | undefined) {
 return posterPath ? `/api/poster?id=${encodeURIComponent(mediaId)}&v=${posterVersion(posterPath)}` : '/poster-placeholder.svg';
}
// Avatar files get a fresh random name on every upload; the first segment identifies the current image.
export function avatarVersion(avatarPath: string | null | undefined) { return avatarPath ? avatarPath.slice(0, 8) : null; }
export const IMMUTABLE_PRIVATE = 'private, max-age=31536000, immutable';
export const REVALIDATE_PRIVATE = 'private, no-cache';
