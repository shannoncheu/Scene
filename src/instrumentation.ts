export async function register(){
 if(process.env.NEXT_RUNTIME==='nodejs'&&process.env.NEXT_PHASE!=='phase-production-build'){
  // WAL lets page reads proceed while the background sync writes. The mode is persistent in the database file.
  try{const {db}=await import('./lib/server/db');await db.$queryRawUnsafe('PRAGMA journal_mode=WAL');}
  catch(error){console.error(`[startup] enabling SQLite WAL failed: ${error instanceof Error?error.name:'unknown'}`);}
  const {startWorker}=await import('./lib/server/worker');startWorker();
 }
}
