import crypto from 'crypto';
import { envString, isProduction } from '../config/env.js';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16; 

function getCipherKey() {
  const configured = envString('ENCRYPTION_KEY');
  const encryptionKey = configured || (
    isProduction()
      ? ''
      : 'syncly-local-dev-key-change-me'
  );
  if (!encryptionKey) {
    throw new Error('ENCRYPTION_KEY is required in production.');
  }

  const rawKey = Buffer.from(encryptionKey);
  if (rawKey.length === 32) return rawKey;
  return crypto.createHash('sha256').update(encryptionKey).digest();
}

export function encrypt(text: string): string {
  if (!text) return '';
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getCipherKey(), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

export function decrypt(text: string): string {
  if (!text) return '';
  const textParts = text.split(':');
  const ivStr = textParts.shift();
  if (!ivStr) return '';
  const iv = Buffer.from(ivStr, 'hex');
  const encryptedText = Buffer.from(textParts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getCipherKey(), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

export function isDecryptionError(error: unknown) {
  const message = String((error as Error)?.message || '');
  return (
    message.includes('bad decrypt') ||
    message.includes('wrong final block length') ||
    message.includes('Invalid initialization vector')
  );
}
