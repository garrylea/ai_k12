import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 全仓形态护栏：`database/repositories/*.repo.ts` 里，**带 `LIMIT ?` 的内联 SQL 不得走
 * `pool.execute`**（服务端预处理语句），必须走 `pool.query`（客户端转义）。
 *
 * 为什么需要一条「扫源码」的护栏，而不是在某个仓储的用例里断言 SQL 字符串：
 * MySQL 对预处理语句的 `LIMIT ?` 直接报
 * `ER_WRONG_ARGUMENTS Incorrect arguments to mysqld_stmt_execute`，即 **SQL 字符串长得
 * 完全正确、参数顺序也对，MySQL 依然拒绝执行它**。仓储单测的 `mockPool` 从不真正执行 SQL，
 * 所以「字符串对」与「MySQL 肯执行」之间没有任何可推导关系 —— 2026-09-20 实测：
 * `safety-alerts.repo.ts` 的列表查询用 `execute` 时，`GET /api/parent/alerts` 对真库
 * **每调必 500**，而当时全部仓储用例绿。
 *
 * 这条护栏覆盖**内联模板字面量直接作为第一个参数**的写法（本仓 `LIMIT ?` 的绝大多数形态）。
 * 已知覆盖不到：把 SQL 先拼进变量、再 `execute(sql, params)` 的写法（如
 * `chinese-passages.repo.ts` 的 `sql += ' ... LIMIT ?'`）——静态上无法把变量与调用点关联。
 * 那种写法只有真库执行或 code review 能拦。
 *
 * 同源钉子（局部版）：`safety-alerts.repo.test.ts` 的「形态护栏」用例、
 * `parent-insights.repo.test.ts:349`、`point-ledger.repo.test.ts:151-157`。
 */

const REPO_DIR = dirname(fileURLToPath(import.meta.url));

interface InlineSqlCall {
  method: 'execute' | 'query';
  sql: string;
}

/**
 * 抽出「池方法调用的第一个参数是内联模板字面量」的那些调用。
 *
 * 正则**锚定 `pool.` 前缀**（`pool\.(execute|query)`），泛型实参用 `<[^>]*>` 跨过、
 * 允许 `(` 与换行（`\s*` 含 `\n`，本仓 148 处把模板字面量写在下一行）。
 *
 * 为什么要锚定 `pool.` 而不是从任意 `.execute`/`.query` 起匹配（2026-09-20 复核实测）：
 * 旧写法 `\.(execute|query)\s*[^(]{0,200}?\(` 有两个**假阴性**，都已被本用例的两条回归钉子钉住：
 * 1. **注释锚定**：注释里先出现 `pool.query（客户端转义）`（本仓注释惯例就是紧贴查询写这句），
 *    若它到后面某个真实 `execute(` 的距离在 200 字符内，正则就从注释的 `.query` 起锚、
 *    把这条 `execute + LIMIT ?` 记成 `method='query'` → 漏报。锚定 `pool.` + 要求 `(` 紧跟后，
 *    全角 `（` 与注释文本都不再可能起锚。
 * 2. **泛型含 `(`**：`[^(]` 不允许跨过 `(`，而本仓有 156 处泛型是
 *    `<(RowDataPacket & { n: number | string })[]>` 这类**内含圆括号**的形状 → 这些调用整类漏扫。
 *    `<[^>]*>` 只按 `>` 收口，能正确跨过它们（实测内联调用识别数 162 → 187、含 `LIMIT ?` 的 8 → 9）。
 *
 * 注释里的 `` `LIMIT ?` `` 不会被误收——它们不是紧跟在 `pool.execute(` / `pool.query(` 之后。
 */
function inlineSqlCalls(src: string): InlineSqlCall[] {
  const out: InlineSqlCall[] = [];
  const re = /pool\.(execute|query)\s*(?:<[^>]*>)?\s*\(\s*`([^`]*)`/g;
  for (const m of src.matchAll(re)) {
    out.push({ method: m[1] as InlineSqlCall['method'], sql: m[2] });
  }
  return out;
}

const repoFiles = readdirSync(REPO_DIR).filter((f) => f.endsWith('.repo.ts'));

describe('形态护栏：带 LIMIT ? 的内联 SQL 必须走 pool.query', () => {
  it('扫描器本身有牙齿（能认出「execute + LIMIT ?」这一形态）', () => {
    const fake =
      'const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT * FROM t LIMIT ? OFFSET ?`, [n, 0]);';
    expect(inlineSqlCalls(fake)).toEqual([
      { method: 'execute', sql: 'SELECT * FROM t LIMIT ? OFFSET ?' },
    ]);
  });

  it('回归钉子：注释里的 `pool.query` 不得把紧随其后的真实 `execute` 锚成 query（假阴性）', () => {
    // 旧正则 `\.(execute|query)\s*[^(]{0,200}?\(` 会被注释里的 `.query` 起锚 →
    // 把下面这条真实的 execute 记成 query → 护栏漏报。本仓注释惯例正是紧贴查询写这句。
    const fake = [
      '// 必须用 pool.query（客户端转义）',
      'const [r] = await this.pool.execute(`SELECT * FROM t LIMIT ? OFFSET ?`, [n, 0]);',
    ].join('\n');
    expect(inlineSqlCalls(fake)).toEqual([
      { method: 'execute', sql: 'SELECT * FROM t LIMIT ? OFFSET ?' },
    ]);
  });

  it('回归钉子：泛型实参内含 `(` 的调用不得整类漏扫（假阴性）', () => {
    // 本仓有 156 处泛型形如 `<(RowDataPacket & { n: number | string })[]>`，内含圆括号；
    // 旧正则的 `[^(]` 无法跨过它 → 这类调用全部扫不到。
    const fake = [
      'const [r] = await this.pool.execute<(RowDataPacket & { n: number | string })[]>(',
      '  `SELECT COUNT(*) AS n FROM t LIMIT ?`,',
      '  [n],',
      ');',
    ].join('\n');
    expect(inlineSqlCalls(fake)).toEqual([
      { method: 'execute', sql: 'SELECT COUNT(*) AS n FROM t LIMIT ?' },
    ]);
  });

  it('扫描器确实扫到了本仓的内联分页 SQL（不是空扫导致的假绿）', () => {
    const all = repoFiles.flatMap((f) =>
      inlineSqlCalls(readFileSync(join(REPO_DIR, f), 'utf8')),
    );
    const withLimit = all.filter((c) => /LIMIT\s*\?/i.test(c.sql));
    // 本仓有多个分页查询（parent-insights / point-ledger / point-redemptions /
    // chinese-passages / ai-dialogues / safety-alerts ...）；若这条为 0，说明扫描器失效了。
    // 注意：此阈值与仓库内容耦合——若将来确实不再有内联分页查询（例如合法改成变量拼接，
    // 那是本扫描器自述的盲区），请同步下调此阈值，而**不要**直接删掉这条守卫。
    expect(withLimit.length).toBeGreaterThanOrEqual(4);
    expect(withLimit.some((c) => c.method === 'query')).toBe(true);
  });

  it('没有任何 .repo.ts 用 execute 执行含 LIMIT ? 的 SQL', () => {
    const offenders: string[] = [];
    for (const file of repoFiles) {
      const src = readFileSync(join(REPO_DIR, file), 'utf8');
      for (const { method, sql } of inlineSqlCalls(src)) {
        if (method === 'execute' && /LIMIT\s*\?/i.test(sql)) {
          offenders.push(`${file}: ${sql.trim().split('\n').pop()?.trim() ?? sql}`);
        }
      }
    }
    // 修法：把该查询改成 `this.pool.query(...)`（客户端转义，值仍经 mysql2 转义，无注入风险）
    expect(offenders).toEqual([]);
  });
});
