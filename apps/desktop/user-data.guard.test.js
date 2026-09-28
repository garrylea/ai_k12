import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * 形态护栏：`userData` 必须被**显式钉死**，且钉死发生在所有读取之前（spec ③ §4.2）。
 *
 * 为什么需要（2026-09-27）：③ 给应用设了中文 `productName`（K12 智学），而
 * `app.getPath('userData')` 走的是 `app.getName()` → 打包后会变成「…/K12 智学/」（中文 + 空格），
 * 于是 README 里那三条**救火路径**（客户端连不上时唯一的自救手段，② spec §8-3）全部失效。
 * 一行 `app.setPath` 就是全部防线 —— 删掉它不会有任何测试变红，所以必须钉住。
 *
 * 次序同样承重：`setPath` 晚于读取就等于没钉（读到的已经是中文路径）。
 */
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const src = readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
const pkg = require('./package.json');

/**
 * 「代码行」视图：剔掉只由注释构成的行（`*` / `//` / `/*` 开头）。
 *
 * 为什么次序判据不能直接 `search` 整份源码（2026-09-27 实测）：钉死那行**自带一段注释**，
 * 而注释里**字面写着 `app.getPath('userData')` 两次**、位置还在 `setPath` 调用之前。
 * 直接在整份 src 上找第一处 `getPath` 会把注释里的「提及」当成一次「读取」，
 * 于是护栏对着次序完全正确的代码变红。注释里的提及不是读取 —— 判据只能看代码行。
 */
function codeLines(text) {
  return text
    .split('\n')
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => {
      const t = line.trim();
      return t !== '' && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    });
}

/** 第一个在**代码行**上命中 `pattern` 的行号；没命中返回 -1（保留「本用例才有意义」的牙齿）。 */
function firstCodeLine(text, pattern) {
  const hit = codeLines(text).find(({ line }) => pattern.test(line));
  return hit ? hit.i : -1;
}

describe('userData 钉死护栏（spec ③ §4.2）', () => {
  it('main.js 里有 app.setPath(\'userData\', …)', () => {
    expect(src).toMatch(/app\.setPath\(\s*'userData'/);
  });

  it('钉死的目录名与 package.json 的 name 一致（否则 dev 路径与打包后不一致）', () => {
    const m = src.match(/app\.setPath\(\s*'userData'\s*,\s*([^\n]+)\)/);
    expect(m, '没找到 setPath 调用的参数').not.toBeNull();
    // 本仓约定：目录名 = package.json 的 name（dev 下本就是这个值，故 dev 路径不变）
    expect(m[1]).toContain(`'${pkg.name}'`);
  });

  it('钉死发生在所有 app.getPath(\'userData\') 读取之前（否则等于没钉）', () => {
    const setAt = firstCodeLine(src, /app\.setPath\(\s*'userData'/);
    const getAt = firstCodeLine(src, /app\.getPath\(\s*'userData'/);
    // 两侧都必须真的在代码行上命中，否则 -1 会让本用例静默变绿（牙齿）。
    expect(setAt, '未在代码行上找到 setPath —— 否则本用例会假绿').toBeGreaterThanOrEqual(0);
    expect(getAt, 'main.js 应当有读取 userData 的代码，本用例才有意义').toBeGreaterThanOrEqual(0);
    expect(setAt, 'setPath 必须在第一处 getPath 之前').toBeLessThan(getAt);
  });
});
