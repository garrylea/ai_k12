import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 形态护栏（只读仓库配置，不跑 Electron）：**本该入库的 YAML 必须真的能被 git 跟踪**。
 *
 * 为什么值得一条这么"外围"的用例（spec ③ §4.0 / §8-8，2026-09-27 实测）：
 * 根 `.gitignore` 有一条**文件级全局规则** `*.yml`（为 Playwright 快照加的），它会连
 * electron-builder 配置与 GitHub Actions workflow 一起吃掉。失效模式是**静默**的 ——
 * `git add` 不报错、CI 不报错、本地看不出来，只有学生装出来的包**缺资源、缺标识**
 * （`files` 白名单失效 → 直接复现 ② spec §8-9 的「漏 pages/offline.html → loadFile 失败
 * → 无节流紧循环、屏幕无 UI」）时才暴露。
 *
 * 实测行为（git 2.50.1，本用例的判据就是这么定的）：
 *   git check-ignore -v <path>  命中普通规则 → status 0，stdout = `文件:行:规则\t路径`
 *                               命中**反选规则（!开头）** → **status 仍是 0**，stdout 把
 *                                 反选规则本身原样打印（`文件:行:!规则\t路径`）——所以带 -v 时
 *                                 **exit status 不代表「被忽略」**，必须再看命中的是不是反选规则。
 *                               （只有**不带 -v** 时 status 才纯粹表示「是否被忽略」：
 *                                 被忽略 → 0，未忽略 → 1。）
 *                               不在 git 仓库 → status 128
 *                               没装 git → spawnSync 的 error 有值
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 探针：这个必须**被忽略**，用来证明探针真的在读 .gitignore（不是空跑导致假绿）。 */
const IGNORED_PROBE = 'foo.log';
/** 必须**能被跟踪**（相对仓库根）—— spec §4.0 那两个文件。 */
const MUST_BE_TRACKABLE = [
  'apps/desktop/electron-builder.yml',
  '.github/workflows/desktop-release.yml',
];
/** 必须**被忽略**（安装包上百 MB，绝不能入库）—— spec §4.4。 */
const MUST_BE_IGNORED = ['apps/web/public/download/k12-desktop-0.1.0-x64.dmg'];

function checkIgnore(relPath) {
  const r = spawnSync('git', ['check-ignore', '-v', relPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (r.error) return null; // 没装 git
  if (r.status === 128) return null; // 不在 git 仓库里（例如导出的 tarball）
  const rule = (r.stdout ?? '').trim();
  // 见文件头「实测行为」：带 -v 时，命中反选规则也会 status 0，所以「被忽略」不能只看
  // status，还要排除「命中的是反选规则」。只取 tab 前的 `文件:行:规则` 部分判断，避免
  // 路径名里恰好含 `:数字:!` 造成误判。
  const ignored = r.status === 0 && !/:\d+:!/.test(rule.split('\t')[0]);
  return { ignored, rule };
}

const probe = checkIgnore(IGNORED_PROBE);
const usable = probe !== null;

describe('.gitignore 的 *.yml 陷阱（spec ③ §4.0）', () => {
  it('探针有牙齿：能观察到仓库里真实存在的忽略规则', () => {
    // 这条挂了说明 checkIgnore 没在工作（没装 git / 不在仓库里）。此时下面两条会 skip ——
    // 护栏会**静默变绿**，那比红更糟。所以宁可在这里红。
    expect(probe, `无法在 ${REPO_ROOT} 用 git check-ignore 观察忽略规则，护栏失效`).not.toBeNull();
    expect(probe.ignored).toBe(true);
    expect(probe.rule).toContain('*.log');
  });

  it.skipIf(!usable)('新增的两个 YAML 不得被 .gitignore 忽略', () => {
    for (const p of MUST_BE_TRACKABLE) {
      const r = checkIgnore(p);
      expect(r.ignored, `${p} 被「${r.rule}」吃掉（spec §4.0）—— 须在 .gitignore 加反选`).toBe(
        false,
      );
    }
  });

  it.skipIf(!usable)('安装包目录必须被忽略', () => {
    for (const p of MUST_BE_IGNORED) {
      const r = checkIgnore(p);
      expect(r.ignored, `${p} 未被忽略 —— 一把 \`git add -A\` 就会把上百 MB 装进仓库`).toBe(true);
    }
  });
});
