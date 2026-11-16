import { readdirSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
// Next standalone tracing can copy .env into the generated server folder.
// Runtime credentials must come from the original protected environment, never a packaged copy.
const standalone='.next/standalone';
if(existsSync(standalone))for(const name of readdirSync(standalone))if(name.startsWith('.env'))unlinkSync(join(standalone,name));
if(existsSync('.env'))process.loadEnvFile('.env');
const secretNames=['TOKEN_ENCRYPTION_KEY','TRAKT_CLIENT_SECRET','TMDB_READ_ACCESS_TOKEN'];
const secrets=secretNames.map(name=>process.env[name]).filter(value=>value&&value.length>=16);
function scan(path){for(const item of readdirSync(path,{withFileTypes:true})){const target=join(path,item.name);if(item.isDirectory())scan(target);else{const bytes=readFileSync(target);if(secrets.some(value=>bytes.includes(value)))throw new Error('CLIENT_SECRET_LEAK_DETECTED');}}}
if(existsSync('.next/static'))scan('.next/static');
console.log('Build privacy check passed; standalone environment copies removed.');
