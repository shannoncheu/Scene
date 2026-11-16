import { createBackup, verifyBackup } from '../src/lib/server/backup';
import { resolve, join } from 'node:path';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
async function main(){
 const [command,input,target]=process.argv.slice(2);
 const data=resolve(process.env.DATA_DIR||'data');
 if(command==='create'){const dir=await createBackup(join(data,'cinema.db'),data,join(data,'backups'));const info=await verifyBackup(dir);console.log(info.missing?.length?`BACKUP_COMPLETE_WITH_MISSING_ATTACHMENTS (${info.missing.length})`:'BACKUP_COMPLETE');}
 else if(command==='verify'&&input){const info=await verifyBackup(resolve(input));if(info.missing?.length){console.warn(`BACKUP_MISSING_ATTACHMENTS: ${info.missing.join(', ')}`);console.log('BACKUP_VERIFIED_INCOMPLETE');}else{console.log('BACKUP_VERIFIED');}}
 else if(command==='restore-copy'&&input&&target){
  // Always restore into a NEW directory. Never overwrite the running database.
  const manifest=await verifyBackup(resolve(input)),destination=resolve(target);
  await mkdir(destination,{mode:0o700});await mkdir(join(destination,'avatars'),{mode:0o700});
  if(Object.keys(manifest.hashes).some(name=>name.startsWith('tickets/')))await mkdir(join(destination,'tickets'),{mode:0o700});
  for(const name of Object.keys(manifest.hashes))await copyFile(join(resolve(input),name),join(destination,name));
  const restored=new DatabaseSync(join(destination,'cinema.db'));
  try{if(restored.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ManualHistoryIntent'").get())restored.exec("UPDATE ManualHistoryIntent SET status='uncertain',leaseExpiresAt=NULL WHERE status IN ('checking','sending');");restored.exec("DELETE FROM Session; DELETE FROM OAuthAttempt; UPDATE Owner SET refreshLeaseUntil=NULL; UPDATE Media SET posterPath=NULL, metadataAt=NULL; UPDATE SyncState SET leaseExpiresAt=NULL, status='pending', runId=NULL;");if(restored.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='HistoryDateEdit'").get())restored.exec("UPDATE HistoryDateEdit SET status='paused',errorCode='RESTORE_REVIEW_REQUIRED',retryAt=NULL WHERE activeOwnerKey IS NOT NULL;");}finally{restored.close();}
  await writeFile(join(destination,'RESTORED.txt'),'Restore verified. Sessions invalidated. Stop only the cinema service and preserve its current database before switching. Preserve TOKEN_ENCRYPTION_KEY separately.',{mode:0o600});
  console.log('RESTORE_COPY_COMPLETE');
 }else throw new Error('Use: create | verify BACKUP_DIR | restore-copy BACKUP_DIR NEW_DIRECTORY');
}
main().catch(()=>{console.error('BACKUP_OPERATION_FAILED: check command, permissions, free space and integrity');process.exitCode=1;});
