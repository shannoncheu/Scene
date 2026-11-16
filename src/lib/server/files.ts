import { resolve } from 'node:path';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export const dataDir=()=>resolve(process.env.DATA_DIR || './data');
export async function boundedBody(request: Request|Response,limit:number){
 if(Number(request.headers.get('content-length'))>limit)throw new Error('FILE_TOO_LARGE');
 const reader=request.body?.getReader();if(!reader)throw new Error('FILE_INVALID');
 const chunks:Uint8Array[]=[];let count=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>limit)throw new Error('FILE_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 return Buffer.concat(chunks);
}
export async function atomicFile(folder:string,name:string,bytes:Buffer){
 const dir=resolve(dataDir(),folder);await mkdir(dir,{recursive:true,mode:0o700});
 const temp=resolve(dir,randomUUID()+'.tmp');await writeFile(temp,bytes,{mode:0o600});await rename(temp,resolve(dir,name));
}
