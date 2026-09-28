import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const DESKTOP = path.resolve(HERE, '..');
const { REQUIRED, parseAsarList, checkEntries } = require('./verify-asar.js');

describe('parseAsarList', () => {
  it('去掉前导斜杠与反斜杠，统一成正斜杠', () => {
    const out = parseAsarList('/main.js\n\\lib\\config-file.js\n');
    expect([...out].sort()).toEqual(['lib/config-file.js', 'main.js']);
  });

  it('忽略空行与行尾空白', () => {
    expect([...parseAsarList('/pages/offline.html  \n\n\n')]).toEqual(['pages/offline.html']);
  });
});

describe('checkEntries', () => {
  const good = new Set(REQUIRED);

  it('齐全且无测试文件 → 没有问题', () => {
    expect(checkEntries(good)).toEqual([]);
  });

  it('缺一件必需资源 → 报出来（② spec §8-9：漏 pages/offline.html 会无节流紧循环）', () => {
    const bad = new Set(REQUIRED);
    bad.delete('pages/offline.html');
    const problems = checkEntries(bad);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('pages/offline.html');
  });

  it('混进任何 *.test.js → 报出来（files 白名单的否定规则失效时靠这条兜住）', () => {
    const bad = new Set([...REQUIRED, 'lib/shell-state.test.js', 'user-data.guard.test.js']);
    const problems = checkEntries(bad);
    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.includes('*.test.js 或测试文件') || p.includes('混进包'))).toBe(
      true,
    );
  });

  it('有牙齿：空集合必须被判为不合格（防"空扫导致假绿"）', () => {
    const problems = checkEntries(new Set());
    expect(problems.length).toBeGreaterThanOrEqual(REQUIRED.length);
  });
});

describe('REQUIRED 与本仓库的真实形态一致（防漂移）', () => {
  it('每一项都在磁盘上真实存在（防白名单写错名字）', () => {
    for (const f of REQUIRED) {
      expect(existsSync(path.join(DESKTOP, f)), `${f} 在 apps/desktop 下不存在`).toBe(true);
    }
  });

  it('覆盖 main.js 里所有 require(\'./…\') 的本地模块（改 main.js 加模块时这里会红）', () => {
    const src = readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
    const rel = [...src.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)].map((m) =>
      m[1].replace(/^\.\//, ''),
    );
    expect(rel.length, '没扫到本地 require，正则失效了').toBeGreaterThanOrEqual(4);
    for (const r of rel) {
      expect(REQUIRED, `main.js require 了 ${r}，但 asar 白名单没钉住它 → 打包后会缺件`).toContain(
        r,
      );
    }
  });
});
