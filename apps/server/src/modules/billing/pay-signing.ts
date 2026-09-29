import { createSign, createVerify, createDecipheriv } from 'node:crypto';

export function rsaSha256Sign(privateKeyPem: string, data: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(data);
  return signer.sign(privateKeyPem, 'base64');
}

export function rsaSha256Verify(publicKeyPem: string, data: string, signatureB64: string): boolean {
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(data);
    return verifier.verify(publicKeyPem, signatureB64, 'base64');
  } catch {
    return false;
  }
}

/** 微信回调 resource 解密：AES-256-GCM，key=APIv3 key(32B)，nonce，AAD=associated_data */
export function wechatAesGcmDecrypt(apiV3Key: string, nonce: string, aad: string, ciphertextB64: string): string {
  const buf = Buffer.from(ciphertextB64, 'base64');
  const data = buf.subarray(0, buf.length - 16);
  const authTag = buf.subarray(buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(nonce, 'utf8'));
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function randomNonce(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
