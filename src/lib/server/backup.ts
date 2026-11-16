import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readFile, writeFile, rename, copyFile, stat, chmod, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataDir } from './files';
const isEnoent=(err:unknown)=>!!err&&typeof err==='object'&&'code' in err&&err.code==='ENOENT';
export async function createBackup(databasePath:string,sourceData:string,destination:string){
 const name=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8),temp=join(destination,'.pending-'+name),final=join(destination,name);
 await mkdir(temp,{recursive:true,mode:0o700});
 try{
  const source=new DatabaseSync(databasePath,{readOnly:true});try{await backup(source,join(temp,'cinema.db'));}finally{source.close();}
  // The live database runs in WAL mode; store the snapshot as a single self-contained rollback-journal file
  // so it can be verified and restored read-only without -wal/-shm side files.
  {const writable=new DatabaseSync(join(temp,'cinema.db'));try{writable.exec('PRAGMA journal_mode=DELETE');}finally{writable.close();}}
  await chmod(join(temp,'cinema.db'),0o600);
  const snapshot=new DatabaseSync(join(temp,'cinema.db'),{readOnly:true});
  let avatars:string[]=[],tickets:string[]=[];
  try{
   if(snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('BACKUP_INTEGRITY_FAILED');
   avatars=[...new Set(snapshot.prepare('SELECT avatarPath FROM Owner WHERE avatarPath IS NOT NULL').all().map(row=>String(row.avatarPath)))];
   if(snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='TicketStub'").get()){
    tickets=[...new Set(snapshot.prepare('SELECT filePath FROM TicketStub WHERE filePath IS NOT NULL').all().map(row=>String(row.filePath)))];
   }
  }finally{snapshot.close();}
  await mkdir(join(temp,'avatars'),{mode:0o700});
  const files=['cinema.db'];
  const missing:string[]=[];
  for(const file of avatars){
   if(!/^[a-f0-9-]{36}\.webp$/.test(file))throw new Error('AVATAR_PATH_INVALID');
   try{await copyFile(join(sourceData,'avatars',file),join(temp,'avatars',file));}catch(err){if(isEnoent(err)){console.warn(`[backup] missing avatar skipped: ${file}`);missing.push('avatars/'+file);continue;}throw err;}
   await chmod(join(temp,'avatars',file),0o600);files.push('avatars/'+file);
  }
  let ticketDirReady=false;
  for(const file of tickets){
   if(!/^[a-f0-9-]{36}\.webp$/.test(file))throw new Error('TICKET_PATH_INVALID');
   const src=join(sourceData,'tickets',file);
   try{await stat(src);}catch(err){if(isEnoent(err)){console.warn(`[backup] missing ticket skipped: ${file}`);missing.push('tickets/'+file);continue;}throw err;}
   if(!ticketDirReady){await mkdir(join(temp,'tickets'),{mode:0o700});ticketDirReady=true;}
   try{await copyFile(src,join(temp,'tickets',file));}catch(err){if(isEnoent(err)){console.warn(`[backup] missing ticket skipped: ${file}`);missing.push('tickets/'+file);continue;}throw err;}
   await chmod(join(temp,'tickets',file),0o600);files.push('tickets/'+file);
   const masterFile=file.replace(/\.webp$/,'.orig.webp');
   const masterSrc=join(sourceData,'tickets',masterFile);
   try{
    await copyFile(masterSrc,join(temp,'tickets',masterFile));
    await chmod(join(temp,'tickets',masterFile),0o600);
    files.push('tickets/'+masterFile);
   }catch(err){if(!isEnoent(err))throw err;}
  }
  const hashes:Record<string,string>={};for(const file of files)hashes[file]=createHash('sha256').update(await readFile(join(temp,file))).digest('hex');
  await writeFile(join(temp,'manifest.json'),JSON.stringify({version:1,createdAt:new Date().toISOString(),hashes,...(missing.length?{missing}:{})},null,2),{mode:0o600});
  await rename(temp,final);return final;
 }catch(error){await rm(temp,{recursive:true,force:true});throw error;}
}
export async function verifyBackup(folder:string){
 const manifest=JSON.parse(await readFile(join(folder,'manifest.json'),'utf8')) as {version:number;hashes:Record<string,string>;missing?:string[]};
 if(manifest.version!==1||!manifest.hashes['cinema.db'])throw new Error('BACKUP_MANIFEST_INVALID');
 for(const [name,expected]of Object.entries(manifest.hashes)){
  if(name!=='cinema.db'&&!/^(avatars\/[a-f0-9-]{36}\.webp|tickets\/[a-f0-9-]{36}(?:\.orig)?\.webp)$/.test(name))throw new Error('BACKUP_PATH_INVALID');
  if(createHash('sha256').update(await readFile(join(folder,name))).digest('hex')!==expected)throw new Error('BACKUP_CHECKSUM_FAILED');
 }
 const snapshot=new DatabaseSync(join(folder,'cinema.db'),{readOnly:true});
 const missingSet=new Set<string>(Array.isArray(manifest.missing)?manifest.missing:[]);
 try{
  if(snapshot.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('BACKUP_INTEGRITY_FAILED');
  for(const row of snapshot.prepare('SELECT avatarPath FROM Owner WHERE avatarPath IS NOT NULL').all()){
   const key=`avatars/${String(row.avatarPath)}`;
   if(!manifest.hashes[key])missingSet.add(key);
  }
  if(snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='TicketStub'").get()){
   for(const row of snapshot.prepare('SELECT filePath FROM TicketStub WHERE filePath IS NOT NULL').all()){
    const key=`tickets/${String(row.filePath)}`;
    if(!manifest.hashes[key])missingSet.add(key);
   }
  }
 }finally{snapshot.close();}
 if(missingSet.size)manifest.missing=[...missingSet];
 return manifest;
}
export async function dailyBackup(){
 const root=dataDir(),stamp=join(root,'backups','.last-success');
 try{if(Date.now()-(await stat(stamp)).mtimeMs<86400000)return;}catch{}
 const url=process.env.DATABASE_URL;if(!url?.startsWith('file:/'))return;
 await createBackup(url.slice(5),root,join(root,'backups'));await writeFile(stamp,new Date().toISOString(),{mode:0o600});
 await pruneBackups(join(root,'backups'));
}
const BACKUP_NAME=/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/;
// Keep the newest N daily snapshots (default 14), plus 1 newest monthly snapshot for each older YYYY-MM month, and discard abandoned partial ones.
export async function pruneBackups(folder:string,keep=Math.max(1,Number(process.env.BACKUP_KEEP)||14)){
 const entries=await readdir(folder,{withFileTypes:true}).catch(()=>[]);
 const snapshots=entries.filter(e=>e.isDirectory()&&BACKUP_NAME.test(e.name)).map(e=>e.name).sort().reverse();
 const coveredMonths=new Set(snapshots.slice(0,keep).map(name=>name.slice(0,7)));
 const removed:string[]=[];
 for(const name of snapshots.slice(keep)){
  const month=name.slice(0,7);
  if(!coveredMonths.has(month)){coveredMonths.add(month);continue;}
  await rm(join(folder,name),{recursive:true,force:true});removed.push(name);
 }
 for(const e of entries)if(e.isDirectory()&&e.name.startsWith('.pending-')){
  const info=await stat(join(folder,e.name)).catch(()=>null);
  if(info&&Date.now()-info.mtimeMs>86400000){await rm(join(folder,e.name),{recursive:true,force:true});removed.push(e.name);}
 }
 return removed;
}
