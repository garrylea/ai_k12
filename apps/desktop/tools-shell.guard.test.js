import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 形态护栏：`tools/` 下的 shell 脚本里，**未加花括号的 `$VAR` 后紧跟非 ASCII 字符**必须为 0。
 *
 * 为什么（2026-09-28 实测两次）：macOS 自带的是 **bash 3.2**，它会把紧跟的多字节 UTF-8 字符
 * 当成**变量名的一部分**。于是 `"需要 $need，本机没装"` 里的变量名被解析成 `need<首字节>`，
 * 在仓库统一的 `set -euo pipefail` 下直接抛 `unbound variable` 并**退出 1**（不是给出空值、
 * 也不是报个语法错），报错长这样：
 *
 *     tools/app-build.sh: line 177: need�: unbound variable
 *
 * 它最坑的地方是**只在执行到那一行时才炸** —— 该分支正好是「本机出不了 Windows 包」这条
 * 提示路径与若干 `warn`，而出包主路径完全看不出来；第二次踩时连「`--publish` 吞掉选项」的
 * 告警行都直接崩了。修法只有一种：写 `${need}`。**这件事靠记性不可靠，所以钉一条护栏。**
 *
 * 为什么这条护栏住在 `apps/desktop`（而不是 `tools/` 或仓库根）：仓库根没有 JS 测试 harness，
 * `tools/` 下只有 crawler 的 pytest；而本包已有先例 —— `gitignore.guard.test.js` 同样是
 * 「本地用例、扫仓库级配置」的形态。同源钉子：`issue #N/A`（本仓无 issue 跟踪）、
 * 说明写在 `docs/constraints/pc-app-学习管控.md` 与 `tools/app-build.sh` 头部注释。
 *
 * 覆盖范围（2026-10-08 扩）：不只 `tools` 树下的 shell 脚本，还有 `.github/workflows` 下的 yml 里
 * `shell: bash` 的**内嵌脚本** —— CI 同样跑在 macOS runner（bash 3.2）上，desktop-release.yml
 * 的报错输出里就溜进来过 `$want，`、`$actual」（`（与 `tools/*.sh` 是同一类事故，只是住址不同）。
 * 扫法：读 yml 全文、跳过 `#` 开头的 yml 注释行（yml 注释与内嵌 bash 注释里的例子都安全），
 * 其余行跑同一套 offender 正则。`${{ matrix.platform }}` 这类 GitHub 表达式与 `${VAR}`
 * 花括号形式天然不命中（`$` 后面紧跟的不是字母）。
 *
 * 已知**过度近似**（故意的，宁严勿松）：整行注释会被跳过（注释里写例子是安全的），
 * 但 `<<'USAGE'` 这类**引号定界 heredoc** 里的内容其实不会被展开、本可放行 —— 这里仍然报。
 * 撞上时把那个 `$VAR` 加上花括号即可，代价为零。
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOLS_DIR = path.join(REPO_ROOT, 'tools');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

/**
 * 只留会被 bash 当代码解释的行（剔掉整行注释；注释里的 `$VAR，` 不会被展开）。
 * ⚠️ 必须保留**原始行号**：报错要指到文件里真实那一行，否则在一份满是注释的脚本里会指错地方。
 */
function codeLines(src) {
  return src
    .split('\n')
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text }) => !text.trim().startsWith('#'));
}

/** 找出「未加花括号的 `$VAR` 紧跟非 ASCII」的位置。返回 [{ line, name, next }]。 */
function offenders(src) {
  const found = [];
  for (const { text, line } of codeLines(src)) {
    // 花括号形式 `${VAR}` 不会命中：`$` 后面紧跟的是 `{`，不匹配 [A-Za-z_]
    const re = /\$([A-Za-z_][A-Za-z0-9_]*)([^\x00-\x7F])/g;
    for (const m of text.matchAll(re)) {
      found.push({ line, name: m[1], next: m[2] });
    }
  }
  return found;
}

const shellFiles = readdirSync(TOOLS_DIR, { recursive: true })
  .map((f) => String(f))
  .filter((f) => f.endsWith('.sh'))
  .sort();

const workflowFiles = readdirSync(WORKFLOWS_DIR)
  .map((f) => String(f))
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();

describe('tools/*.sh 的「$VAR 后紧跟中文标点」护栏（macOS bash 3.2）', () => {
  it('扫描器本身有牙齿：能认出坏写法，且放行花括号写法', () => {
    expect(offenders('  log "需要 $need，本机没装"')).toEqual([
      { line: 1, name: 'need', next: '，' },
    ]);
    expect(offenders('  log "需要 ${need}，本机没装"')).toEqual([]);
  });

  it('扫描器忽略整行注释（注释里的例子不该被当成违规）', () => {
    expect(offenders('# 例：`$need，` 是坏写法')).toEqual([]);
  });

  it('报的是文件里的真实行号（不被前面的注释行带偏）', () => {
    // 本用例存在的理由：初版把行号算成「剔掉注释后的下标」，在一份满是注释的脚本里会指错行。
    const src = ['#!/usr/bin/env bash', '# 注释一', '# 注释二', '', 'echo "需要 $need，本机没装"'].join(
      '\n',
    );
    expect(offenders(src)).toEqual([{ line: 5, name: 'need', next: '，' }]);
  });

  it('确实扫到了脚本（防"空扫导致假绿"）', () => {
    expect(shellFiles.length).toBeGreaterThanOrEqual(3);
    const total = shellFiles
      .map((f) => readFileSync(path.join(TOOLS_DIR, f), 'utf8'))
      .join('\n');
    // 这些脚本里到处是中文，若一个字都读不到说明路径错了
    expect(total).toContain('bash');
    expect(total.length).toBeGreaterThan(1000);
  });

  it('没有任何 tools/**/*.sh 出现未加花括号的 $VAR + 非 ASCII', () => {
    const bad = [];
    for (const f of shellFiles) {
      const src = readFileSync(path.join(TOOLS_DIR, f), 'utf8');
      for (const o of offenders(src)) {
        bad.push(`${f}:${o.line} $${o.name}${o.next}`);
      }
    }
    // 修法：改成 ${NAME}（macOS bash 3.2 会把紧跟的 UTF-8 字节吃进变量名）
    expect(bad).toEqual([]);
  });
});

describe('.github/workflows/*.yml 内嵌 bash 的同一护栏（macOS runner 也是 bash 3.2）', () => {
  it('扫描器对 yml 形态有牙齿：内嵌脚本行能报、花括号与 ${{ }} 表达式不误报', () => {
    // 一段仿 workflow 内嵌脚本的内容：坏写法在 run 块里，注释与 GitHub 表达式都该放行
    const ymlish = [
      '      - name: 出包',
      '        shell: bash',
      '        run: |',
      '          set -euo pipefail',
      '          # 注释里的 $x， 是安全的例子',
      '          echo "::$TAG）与 $PKG）不一致"', // 坏写法：变量后紧跟全角括号
      '          echo "期望含 ${want}，实际「${actual}」"',
      '          ./bin ${{ matrix.platform }}', // GitHub 表达式，不是 shell 变量
    ].join('\n');
    expect(offenders(ymlish)).toEqual([
      { line: 6, name: 'TAG', next: '）' },
      { line: 6, name: 'PKG', next: '）' },
    ]);
  });

  it('确实扫到了 workflow 文件（防"空扫导致假绿"）', () => {
    expect(workflowFiles.length).toBeGreaterThanOrEqual(1);
    const total = workflowFiles
      .map((f) => readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8'))
      .join('\n');
    expect(total).toContain('shell: bash');
  });

  it('没有任何 workflow 内嵌脚本出现未加花括号的 $VAR + 非 ASCII', () => {
    const bad = [];
    for (const f of workflowFiles) {
      const src = readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8');
      for (const o of offenders(src)) {
        bad.push(`.github/workflows/${f}:${o.line} $${o.name}${o.next}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
