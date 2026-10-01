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

  it('manifest 主题色 = parent 主题底色 #F5F7FA（与学生 day 底色区分）', () => {
    const m = JSON.parse(readFileSync(resolve(webRoot, 'public/manifest.webmanifest'), 'utf-8'));
    // 真源：apps/web/src/styles/global.css 的 parent 主题 --bg-page；与 MobileParentLayout 实际背景一致
    expect(m.theme_color).toBe('#F5F7FA');
    expect(m.background_color).toBe('#F5F7FA');
  });

  it('manifest icons 含 180x180 PNG（iOS apple-touch-icon）', () => {
    const m = JSON.parse(readFileSync(resolve(webRoot, 'public/manifest.webmanifest'), 'utf-8'));
    const png = m.icons.find((i: { src: string }) => i.src === '/icons/parent-touch-180.png');
    expect(png).toBeTruthy();
    expect(png.sizes).toBe('180x180');
    expect(png.type).toBe('image/png');
  });

  it('index.html 带 manifest link 与 apple 主屏 meta', () => {
    const html = readFileSync(resolve(webRoot, 'index.html'), 'utf-8');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('apple-mobile-web-app-capable');
    expect(html).toContain('apple-mobile-web-app-status-bar-style');
    expect(html).toContain('rel="apple-touch-icon"');
    expect(html).toContain('/icons/parent-touch-180.png');
  });
});
