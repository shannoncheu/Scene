import { cpSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (existsSync(new URL('../.env', import.meta.url))) process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
const root = fileURLToPath(new URL('../', import.meta.url));
if (!existsSync(new URL('../.next/standalone/server.js', import.meta.url))) {
  console.error('Build missing. Run npm run build first.'); process.exit(1);
}
cpSync(new URL('../public', import.meta.url), new URL('../.next/standalone/public', import.meta.url), {recursive:true});
cpSync(new URL('../.next/static', import.meta.url), new URL('../.next/standalone/.next/static', import.meta.url), {recursive:true});
// Prisma file URLs are resolved relative to the schema; use an absolute runtime URL.
if (process.env.DATABASE_URL?.startsWith('file:') && !process.env.DATABASE_URL.startsWith('file:/')) process.env.DATABASE_URL='file:'+fileURLToPath(new URL('../prisma/'+process.env.DATABASE_URL.slice(5), import.meta.url));
if (!process.env.DATA_DIR || !process.env.DATA_DIR.startsWith('/')) process.env.DATA_DIR=fileURLToPath(new URL('../'+(process.env.DATA_DIR || 'data'), import.meta.url));
const child = spawn(process.execPath, ['.next/standalone/server.js'], { cwd:root, stdio:'inherit', env:{...process.env,HOSTNAME:process.env.PREVIEW_HOST || '127.0.0.1',PORT:'4317',NEXT_TELEMETRY_DISABLED:'1'} });
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code??0));
