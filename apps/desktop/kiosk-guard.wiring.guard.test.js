import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 形态护栏：kiosk 守护的**关键接线**不能被静默删掉（2026-11-04）。
 *
 * 这些点删掉后代码照样能跑、单测也不一定红，但逃逸口会回来 —— 所以钉在源码上：
 *   1. macOS 抢回前台必须走 `app.focus({ steal: true })`，`win.focus()` 抢不回来；
 *   2. 必须监听 `leave-full-screen` / `did-become-active`（系统把窗口踢出全屏 / 切回前台）；
 *   3. 被踢出全屏必须 `setKiosk(false) → setKiosk(true)` 完整重进（2026-11-05 实测）；
 *   4. 角色开关必须真的启动/停止守护（否则学生模式退出后家长窗口还会被拽回全屏）。
 *
 * 单测覆盖的是守护模块的行为；这里只钉 `main.js` 的接线，两者互补。
 */
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const mainSrc = readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
const guardSrc = readFileSync(path.join(DESKTOP, 'lib', 'kiosk-guard.js'), 'utf8');

describe('kiosk 守护接线护栏', () => {
  it('main.js 引入 lib/kiosk-guard.js', () => {
    expect(mainSrc).toMatch(/require\(\s*'\.\/lib\/kiosk-guard\.js'\s*\)/);
  });

  it('macOS 抢回前台用 app.focus({ steal: true })', () => {
    expect(mainSrc).toMatch(/app\.focus\(\s*\{\s*steal:\s*true\s*\}\s*\)/);
  });

  it('监听 leave-full-screen 并交给守护层调度', () => {
    expect(mainSrc).toMatch(
      /win\.on\(\s*'leave-full-screen'\s*,\s*\(\)\s*=>\s*kioskGuard\.schedule\(/,
    );
  });

  it('失焦也交给守护层，而不是自己调 win.focus()', () => {
    expect(mainSrc).toMatch(/win\.on\(\s*'blur'\s*,\s*\(\)\s*=>\s*kioskGuard\.schedule\(/);
  });

  it('App 切回前台也交给守护层（Siri 顶到后台后重回前台的关键路径）', () => {
    expect(mainSrc).toMatch(/app\.on\(\s*'did-become-active'/);
  });

  it('学生模式开关启动/停止守护', () => {
    expect(mainSrc).toMatch(/if \(studentMode\) kioskGuard\.start\(\);/);
    expect(mainSrc).toMatch(/else kioskGuard\.stop\(\);/);
  });

  it('被踢出全屏必须完整重进 kiosk：setKiosk(false) 再 setKiosk(true)', () => {
    expect(guardSrc).toMatch(/win\.setKiosk\(false\);\s*\n\s*win\.setKiosk\(true\);/);
    expect(guardSrc).toMatch(/win\.setFullScreen\(true\)/); // 异步退出动画的兜底
  });

  it('看门狗间隔是 1 秒（改大等于把逃逸窗口拉长）', () => {
    expect(guardSrc).toMatch(/DEFAULT_WATCHDOG_MS\s*=\s*1000/);
  });
});
