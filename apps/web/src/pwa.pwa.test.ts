import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 直读文件而非 jsdom：manifest/meta 是静态资产，护栏只关心「在且字段对」。
const webRoot = resolve(__dirname, '..');

describe('PWA 静态资产护栏', () => {
  it('manifest.webmanifest 存在且 standalone + 引用 favicon.svg', () => {
    const m = JSON.parse(readFileSync(resolve(webRoot, 'public/manifest.webmanifest'), 'utf-8'));
    expect(m.display).toBe('standalone');
    expect(m.icons.some((i: { src: string }) => i.src === '/favicon.svg')).toBe(true);
    expect(typeof m.theme_color).toBe('string');
  });

  it('index.html 带 manifest link 与 apple 主屏 meta', () => {
    const html = readFileSync(resolve(webRoot, 'index.html'), 'utf-8');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('apple-mobile-web-app-capable');
    expect(html).toContain('apple-mobile-web-app-status-bar-style');
  });
});
