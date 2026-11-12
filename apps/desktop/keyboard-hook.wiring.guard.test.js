import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 形态护栏：Windows 键盘钩子的接线不能被静默删掉（2026-11-09）。
 *
 * 这些点删掉后代码照样能跑、单测也不一定红，但逃逸口会回来：
 *   1. 原生模块只能**按需**加载（`load:` 惰性 require），否则 mac/linux 启动就炸；
 *   2. 学生模式开关必须同时驱动钩子，且要在窗口判空之前（启动恢复到学生模式时窗口还没建好）；
 *   3. 窗口关闭 / 进程退出要摘钩子（钩子回调指向本模块代码）；
 *   4. 非 win32 必须在加载前就返回（`lib/keyboard-hook.js` 的 platform 守卫）。
 *
 * 单测覆盖的是封装模块的行为；这里钉 `main.js` 的接线与「只在 win32 下碰原生模块」。
 */
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const mainSrc = readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
const hookSrc = readFileSync(path.join(DESKTOP, 'lib', 'keyboard-hook.js'), 'utf8');

describe('Windows 键盘钩子接线护栏', () => {
  it('main.js 引入 lib/keyboard-hook.js', () => {
    expect(mainSrc).toMatch(/require\(\s*'\.\/lib\/keyboard-hook\.js'\s*\)/);
  });

  it('原生模块是惰性加载（load 里 require），不是顶层 require', () => {
    expect(mainSrc).toMatch(/load:\s*\(\)\s*=>\s*require\(\s*'\.\/native\/keyhook\.node'\s*\)/);
    // 顶层（模块作用域）不允许直接 require 那个 .node —— mac/linux 上根本没有这个文件
    const topLevel = mainSrc.split('app.whenReady()')[0];
    expect(topLevel).not.toMatch(/require\(\s*'\.\/native\/keyhook\.node'\s*\)/);
  });

  it('平台守卫在「碰原生模块」之前', () => {
    expect(hookSrc).toMatch(/if \(platform !== 'win32'\) return null;/);
    // ensureModule 里先判平台、再调 load()
    const fn = hookSrc.slice(hookSrc.indexOf('function ensureModule'));
    expect(fn.indexOf("platform !== 'win32'")).toBeGreaterThan(-1);
    expect(fn.indexOf("platform !== 'win32'")).toBeLessThan(fn.indexOf('load()'));
  });

  it('窗口锁定驱动钩子，且在窗口判空之前（否则开机恢复学生模式永远不装钩）', () => {
    const fn = mainSrc.slice(mainSrc.indexOf('function driveWindowLockdown'));
    const callAt = fn.indexOf('keyboardHook.setEnabled(windowLocked)');
    const earlyReturnAt = fn.indexOf('if (!win || win.isDestroyed()) {');
    expect(callAt).toBeGreaterThan(-1);
    expect(earlyReturnAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(earlyReturnAt);
    // 钩子跟随窗口实际锁定（2026-11-12）：首屏连不上放行时必须一起关，
    // 否则普通窗口还要被 Win 键钩子吞键。不能再按学生模式意图直接驱动。
    expect(mainSrc).not.toMatch(/keyboardHook\.setEnabled\(studentMode\)/);
  });

  it('窗口关闭 / 进程退出会摘钩子', () => {
    expect(mainSrc).toMatch(/keyboardHook\.setEnabled\(false\)/);
    expect(mainSrc).toMatch(/app\.on\(\s*'will-quit'/);
  });

  it('打包配置：.node 进 files 且进 asarUnpack（asar 里的动态库无法 dlopen）', () => {
    const yml = readFileSync(path.join(DESKTOP, 'electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/^\s*-\s*native\/keyhook\.node/m);
    expect(yml).toMatch(/asarUnpack:[\s\S]*native\/keyhook\.node/);
  });
});
