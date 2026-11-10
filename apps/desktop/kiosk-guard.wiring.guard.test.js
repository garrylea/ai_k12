import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 形态护栏：kiosk 守护的**关键接线**不能被静默删掉（2026-11-04）。
 *
 * 这些点删掉后代码照样能跑、单测也不一定红，但逃逸口会回来 —— 所以钉在源码上：
 *   1. macOS 抢回前台必须走 `app.focus({ steal: true })`，`win.focus()` 抢不回来；
 *   2. 必须监听 `leave-full-screen` / `did-become-active` / `did-resign-active`
 *      （系统把窗口踢出全屏 / 切走前台 / 切回前台）；
 *   3. 被踢出全屏必须 `setKiosk(false) → 等退出全屏动画 → setKiosk(true)` 完整重进，
 *      **且不能 back-to-back**（2026-11-09 实测：连着调时第二次进入会直接 return，
 *      presentation options 不会被重新设置 → 看着全屏、Cmd+Tab 却能切走）；
 *   4. 「从后台回到前台」必须走 `scheduleReassert`（不看四项状态，无条件重进）；
 *   5. 角色开关必须真的启动/停止守护（否则学生模式退出后家长窗口还会被拽回全屏）。
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
    expect(mainSrc).toMatch(/win\.on\(\s*'blur'\s*,\s*\(\)\s*=>\s*\{[\s\S]*?kioskGuard\.schedule\(/);
  });

  it('App 切回前台也交给守护层（Siri 顶到后台后重回前台的关键路径）', () => {
    expect(mainSrc).toMatch(/app\.on\(\s*'did-become-active'/);
  });

  it('离开前台要记下来，回到前台必须走「无条件重进」而不是只做健康检查', () => {
    // 失活会收回 app 级 presentation options，而四项状态仍全是 true ——
    // 只调 schedule() 会被 healthy() 判定挡掉，Siri 之后 Cmd+Tab 就一直可用。
    expect(mainSrc).toMatch(/app\.on\(\s*'did-resign-active'/);
    expect(mainSrc).toMatch(/kioskGuard\.scheduleReassert\(/);
  });

  it('学生模式开关启动/停止守护', () => {
    expect(mainSrc).toMatch(/if \(studentMode\) kioskGuard\.start\(\);/);
    expect(mainSrc).toMatch(/else kioskGuard\.stop\(\);/);
  });

  it('重进 kiosk：setKiosk(false) → 等退出全屏 → setKiosk(true)，且禁止 back-to-back', () => {
    expect(guardSrc).toMatch(/win\.setKiosk\(false\)/);
    expect(guardSrc).toMatch(/win\.setKiosk\(true\)/);
    expect(guardSrc).toMatch(/win\.setFullScreen\(true\)/); // 进入全屏的兜底
    // 关键顺序：两者之间必须读取 isFullScreen() 等动画结束，否则选项不会被重新设置。
    expect(guardSrc).toMatch(/win\.setKiosk\(false\);[\s\S]*?win\.isFullScreen\(\)[\s\S]*?win\.setKiosk\(true\);/);
    expect(guardSrc).not.toMatch(/win\.setKiosk\(false\);\s*\n\s*win\.setKiosk\(true\);/);
  });

  it('看门狗间隔是 1 秒（改大等于把逃逸窗口拉长）', () => {
    expect(guardSrc).toMatch(/DEFAULT_WATCHDOG_MS\s*=\s*1000/);
  });

  it('渲染进程崩溃要自动恢复（60 秒内二次崩溃则重建窗口）', () => {
    expect(mainSrc).toMatch(/webContents\.on\(\s*'render-process-gone'/);
    expect(mainSrc).toMatch(/rendererCrashAt/);
    // 恢复块里必须真的调 createWindow（单独匹配 createWindow() 会被文件里原有的调用骗过）
    expect(mainSrc).toMatch(/render-process-gone[\s\S]{0,1200}?createWindow\(\)/);
  });

  it('子进程崩溃只记日志，不重建窗口', () => {
    expect(mainSrc).toMatch(/webContents\.on\(\s*'child-process-gone'/);
  });

  it('首启安装看护进程（不再直管 App 的 KeepAlive）', () => {
    expect(mainSrc).toMatch(/installWatchdog\(/);
    expect(mainSrc).not.toMatch(/installLaunchAgent\(/);
  });
});
