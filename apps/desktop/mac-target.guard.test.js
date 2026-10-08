import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 形态护栏（只读仓库配置，不跑 Electron）：electron-builder.yml 的 `mac.target` **不得**
 * 含 `pkg` 或 `dmg` target，只能出 .app（dir）。
 *
 * 为什么（spec 2026-10-07 / docs/constraints/pc-app-学习管控.md「打包与分发」节）：
 * - **pkg**：electron-builder 26.15.3 的 pkg target 在「未签名 + 双架构单次构建」下，
 *   两个架构的并行任务共享同一中间产物（com.<bundleId>.pkg / distribution.xml，文件名不含架构）
 *   互踩竞态，**静默**产出装不上 Intel 机器的坏包（x64 包里是 arm64 主程序）。已判死刑 ——
 *   pkg 封装收口到 tools/app-build.sh 与 CI 的 pkgbuild 循环（封装前有 file 架构校验）。
 * - **dmg**：Installer 才不向产物传播 quarantine，dmg 拖拽后的 app 带 quarantine 属性，
 *   家长首次打开被 Gatekeeper 拦、还得手跑 xattr —— 这条路径已废止。
 *
 * 为什么是护栏而不是靠记性：target 写一行 `dmg` 就能把已判死刑的路径悄悄接回来，
 * 而它坏得**静默**（竞态坏包 / quarantine），出包流程不会报错。谁改了这里，测试必须红。
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILDER_YML = path.join(REPO_ROOT, 'apps/desktop', 'electron-builder.yml');
const BANNED = ['pkg', 'dmg'];

/**
 * 提取 `mac:` 块（到下一个顶层键为止）里出现的全部 target 名。
 * 兼容 `target: [{ target: dir, arch: [...] }]` 与 `target: dir` 两种写法；
 * 外层 `target: [{` 中 `[` 后不是字母，天然不命中，抓到的是内层的名字。
 */
function macTargets(text) {
  const section = [];
  let inMac = false;
  for (const line of text.split('\n')) {
    if (/^mac:/.test(line)) {
      inMac = true;
      continue;
    }
    if (inMac && /^\S/.test(line)) break; // 下一个顶层键（win/linux/…）
    if (inMac) section.push(line);
  }
  return [...section.join('\n').matchAll(/target:\s*\[?\s*['"]?([A-Za-z_][A-Za-z0-9_-]*)/g)].map(
    (m) => m[1],
  );
}

describe('electron-builder.yml 的 mac.target 形态护栏', () => {
  it('扫描器有牙齿：能在仿 yml 内容里认出被禁的 dmg / pkg target', () => {
    const bad = ['mac:', '  target: [{ target: dmg, arch: [x64] }]'].join('\n');
    expect(macTargets(bad)).toEqual(['dmg']);
    const bad2 = ['mac:', '  target:', '    - target: pkg', '      arch: [x64, arm64]'].join(
      '\n',
    );
    expect(macTargets(bad2)).toEqual(['pkg']);
  });

  it('确实读到了 mac 块且里面有 target（防"空扫导致假绿"）', () => {
    const targets = macTargets(readFileSync(BUILDER_YML, 'utf8'));
    expect(targets.length).toBeGreaterThanOrEqual(1);
  });

  it('mac.target 只出 .app（dir），不含 pkg / dmg', () => {
    const targets = macTargets(readFileSync(BUILDER_YML, 'utf8'));
    const banned = targets.filter((t) => BANNED.includes(t));
    expect(banned, `mac.target 出现了已判死刑的 target（${banned.join(', ')}）—— pkg 封装只能走 pkgbuild 收口，见文件头注释`).toEqual(
      [],
    );
    expect(targets).toContain('dir');
  });
});
