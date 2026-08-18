import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * llm_models.api_key 的 AES-256-GCM 加解密。密钥来自 .env 的 LLM_CONFIG_ENC_KEY
 * （32 字节 hex，64 个 hex 字符）；未设置时用确定性 dev key（仅本机开发，生产必须设置）。
 * 密文格式：base64(iv[12] + authTag[16] + ciphertext)。
 */
const DEV_KEY_HEX = '6b31325f6465765f6b65795f666f725f6c6f63616c5f74657374735f6f6e6c79'; // dev only
const KEY = Buffer.from(process.env.LLM_CONFIG_ENC_KEY || DEV_KEY_HEX, 'hex');

if (KEY.length !== 32) {
  throw new Error('LLM_CONFIG_ENC_KEY 必须是 64 个 hex 字符（32 字节）');
}

export function encryptApiKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptApiKey(cipherText: string): string {
  const raw = Buffer.from(cipherText, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
