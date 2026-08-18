import { describe, it, expect } from 'vitest';
import { encryptApiKey, decryptApiKey } from './api-key-crypto';

describe('api-key-crypto', () => {
  it('加解密往返一致，密文不含明文', () => {
    const plain = 'sk-test-1234567890';
    const enc = encryptApiKey(plain);
    expect(enc).not.toContain(plain);
    expect(decryptApiKey(enc)).toBe(plain);
  });

  it('相同明文两次加密产生不同密文（随机 IV）', () => {
    expect(encryptApiKey('sk-x')).not.toBe(encryptApiKey('sk-x'));
  });

  it('篡改密文解密失败抛错', () => {
    const enc = encryptApiKey('sk-x');
    expect(() => decryptApiKey(enc.slice(0, -4) + 'AAAA')).toThrow();
  });
});
