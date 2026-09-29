import { createCipheriv, generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { randomNonce, rsaSha256Sign, rsaSha256Verify, wechatAesGcmDecrypt } from './pay-signing.js';

describe('rsaSha256Sign / rsaSha256Verify', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  it('签名 → 公钥验真（往返）', () => {
    const data = 'POST\n/v3/pay/transactions/native\n1730000000\n{"amount":1}\n';
    const sig = rsaSha256Sign(privatePem, data);
    expect(rsaSha256Verify(publicPem, data, sig)).toBe(true);
  });

  it('数据被篡改 → 验签 false', () => {
    const sig = rsaSha256Sign(privatePem, '原始报文');
    expect(rsaSha256Verify(publicPem, '被篡改的报文', sig)).toBe(false);
  });

  it('签名串不是合法签名 → false 而不是抛异常', () => {
    expect(rsaSha256Verify(publicPem, 'data', 'not-a-signature!!!')).toBe(false);
    expect(rsaSha256Verify(publicPem, 'data', '')).toBe(false);
  });
});

describe('wechatAesGcmDecrypt', () => {
  // APIv3 key 固定 32 字节；nonce 走 utf8 Buffer，两端一致即可
  const apiV3Key = '0123456789abcdef0123456789abcdef';
  const nonce = randomBytes(6).toString('hex'); // 12 个 ASCII 字符
  const aad = 'transaction';

  // 模拟微信侧加密：ciphertext || authTag(16B) 的 base64
  function encryptLikeWechat(plaintext: string, key = apiV3Key, aadOverride = aad): string {
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'utf8'), Buffer.from(nonce, 'utf8'));
    cipher.setAAD(Buffer.from(aadOverride, 'utf8'));
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([enc, cipher.getAuthTag()]).toString('base64');
  }

  it('APIv3 key 加解密往返（resource 解密）', () => {
    const resource = JSON.stringify({ out_trade_no: 'R20260929001', trade_state: 'SUCCESS' });
    expect(wechatAesGcmDecrypt(apiV3Key, nonce, aad, encryptLikeWechat(resource))).toBe(resource);
  });

  it('密文被篡改 → GCM 校验失败抛异常（绝不吐明文）', () => {
    const cipherB64 = encryptLikeWechat('{"amount":1}');
    const buf = Buffer.from(cipherB64, 'base64');
    buf[0] ^= 0xff;
    expect(() => wechatAesGcmDecrypt(apiV3Key, nonce, aad, buf.toString('base64'))).toThrow();
  });

  it('AAD（associated_data）不匹配 → 抛异常', () => {
    expect(() =>
      wechatAesGcmDecrypt(apiV3Key, nonce, 'refund', encryptLikeWechat('{"amount":1}', apiV3Key, 'transaction')),
    ).toThrow();
  });

  it('APIv3 key 不对 → 抛异常', () => {
    expect(() =>
      wechatAesGcmDecrypt('ffffffffffffffffffffffffffffffff', nonce, aad, encryptLikeWechat('{"amount":1}')),
    ).toThrow();
  });
});

describe('randomNonce', () => {
  it('非空字符串，两次调用互不相同', () => {
    const a = randomNonce();
    const b = randomNonce();
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });
});
