import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
export const randomSecret = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const challenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
function key() { const value=process.env.TOKEN_ENCRYPTION_KEY || ''; if(!/^[a-f0-9]{64}$/i.test(value))throw new Error('ENCRYPTION_KEY_REQUIRED');return Buffer.from(value,'hex'); }
export function encrypt(value: string) {
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv);
 cipher.setAAD(Buffer.from('cinema-workshop:v1'));
 return ['v1',iv.toString('base64url'),Buffer.concat([cipher.update(value,'utf8'),cipher.final()]).toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');
}
export function decrypt(value: string) {
 const [version,iv,data,tag]=value.split('.');if(version!=='v1')throw new Error('CIPHERTEXT_INVALID');
 const decipher=createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'base64url'));decipher.setAAD(Buffer.from('cinema-workshop:v1'));decipher.setAuthTag(Buffer.from(tag,'base64url'));
 return Buffer.concat([decipher.update(Buffer.from(data,'base64url')),decipher.final()]).toString('utf8');
}
