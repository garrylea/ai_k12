# 训练 → 语文 → 专项：古诗文默写 实施计划（功能链路）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让学生能从 训练 → 语文 → 专项 → 古诗文默写 进入练习，按范围随机抽题或指定篇目，分「作者/朝代/正文」三字段作答，由程序判对错并高亮错处，LLM 补充错因文案。

**Architecture:** 语文走独立路由与专用页面，不动数学那套专项页。后端在 `JudgeCoreService` 上新增一条**纯程序化**的 `dictation` 判题分支（归一化比对 + LCS 差异定位），错题写入复用 `main_error_books`；LLM 只通过新增的 `DictationFeedbackCapability` 生成错因文案，失败不阻断判题。题库数据以 `questions` 行为锚点、`dictation_passages` 新表承载篇目结构化字段。

**Tech Stack:** 后端 Node.js + TypeScript ESM + NestJS + mysql2 + Vitest；前端 React 18 + TypeScript + Tailwind + React Router 6；配置用 Mustache 模板 + YAML 路由。

**关联文档：** `docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md`（设计依据）、`docs/superpowers/specs/2026-09-02-math-training-module-design.md`、`docs/superpowers/specs/2026-09-09-judging-rework-design.md`

---

## Global Constraints

- TS 严格模式、2 空格缩进；组件/类 PascalCase，函数/变量 camelCase。
- **UI 硬规则**（`CLAUDE.md`）：禁止 emoji；图标必须线性 SVG；禁止吉祥物/装饰元素；单一配色取自 `apps/web/style.md`，不得按学段变色。
- iPad 横屏（>=1024px）为主断点，PC（>=1280px）次之，移动端暂缓。
- 后端 API Key 用 `.env` 的 `KIMI_API_KEY` / `QWEN_API_KEY` / `DEEPSEEK_API_KEY` 及对应 `*_BASE_URL`，**不要用 `ANTHROPIC_*`**。
- 模型 ID 是字面量，**勿改**：`kimi-latest`、`qwen3.8-max`、`gemini-3.1-pro`、`deepseek-v4-flash`、`Qwen3.8-27B`（`local` provider）。
- **API 文档同步铁律**：`docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml` 必须同时更新（Task 16）。
- **测试与文档同步铁律**：若测试断言与 config/types/设计文档冲突，**测试错**——改测试，勿改 config/设计文档。
- 提交前：`apps/web/` 跑 `npm run lint`；`apps/server/` 跑 `npm test`。
- 后端测试文件与被测文件同目录，命名 `*.test.ts`；repo 测试用 mock pool（参照 `apps/server/src/database/repositories/questions.repo.test.ts`）。
- 语文学科 id 固定为 `2`（`subjects` seed：1=数学, 2=语文, 3=英语）。

## 范围说明（为什么拆成两个计划）

本计划只覆盖**功能链路**：数据库表、判题、接口、前端页面，用**开发假数据**（2 篇短诗，非生产内容）跑通端到端。

**内容管线另起一个计划**（`2026-09-13-chinese-dictation-content-pipeline.md`）：爬 smartedu 教材 → 图转 MD → 抽篇目 → 逐篇校验 → 全量入库。拆开的原因是管线细节依赖 Task 1 的版本闸门结果（平台上有哪些语文教材版本），现在无法写具体；管线计划在 Task 1 完成后编写。

**九年级必背篇目全量、长文言文逐字校验属于管线计划，不属于本计划。** 本计划的 dev 种子数据仅为链路验证，Task 5 会明确标注为开发假数据。

---

## File Structure

### 后端新增

| 文件 | 职责 |
|---|---|
| `apps/server/src/common/utils/normalize-chinese.util.ts` | 中文答案归一化 + LCS 差异定位（纯函数，无 IO） |
| `apps/server/src/database/repositories/dictation-passages.repo.ts` | `dictation_passages` 表读写（列表/随机抽/按 id 查/批量 upsert） |
| `apps/server/src/ai-core/capabilities/dictation-feedback.capability.ts` | 调 LLM 生成错因文案（文本输出） |
| `apps/server/src/ai-core/prompts/dictation/feedback.md` | 错因文案 prompt 模板 |
| `apps/server/src/scripts/seed-dictation-fixture.ts` | 写 2 篇开发假数据（幂等） |
| `apps/server/src/scripts/seed-dictation-feedback-route.ts` | 给已 seed 的库补 `dictation_feedback` 路由（幂等） |

### 后端修改

| 文件 | 改动 |
|---|---|
| `tools/db/schema.sql` | 折回 `dictation_passages` 建表 |
| `apps/server/src/common/utils/content-hash.util.ts` | 导出 `PREFIX_STRIP` 并补中文标点 |
| `apps/server/src/database/repositories/index.ts` | 导出新 repo |
| `apps/server/src/ai-core/types.ts` | `Scene` + `CapabilityType` 加值；新增 request/response 类型 |
| `apps/server/src/ai-core/infra/prompt-builder.ts` | `resolveTemplatePath` 支持 dictation 模板 |
| `apps/server/src/ai-core/model-routes.yaml` | 新增 `dictation_feedback` 路由 |
| `apps/server/src/ai-core/retry.yaml` | 新增 `dictation_feedback` 超时 |
| `apps/server/src/modules/practice/judge-core.service.ts` | 新增 `judgeDictation`（纯程序） |
| `apps/server/src/modules/training/training.service.ts` | 新增 `CHINESE_SUBJECT_ID` + 三个方法 + `renderBodyDiff` |
| `apps/server/src/modules/training/training.controller.ts` | 新增三个端点 |
| `apps/server/src/modules/training/training.module.ts` | provide 新 repo + 新 capability |
| `apps/server/src/modules/training/dto/dictation.dto.ts` | 新 DTO 类型 |

### 前端新增

| 文件 | 职责 |
|---|---|
| `apps/web/src/pages/student/training/chinese/ChineseSpecialPage.tsx` | 语文专项页（两卡） |
| `apps/web/src/pages/student/training/chinese/DictationConfigPage.tsx` | 默写配置页（范围/题量/指定篇目） |
| `apps/web/src/pages/student/training/chinese/DictationRunPage.tsx` | 默写答题页（串题、提交、结果） |
| `apps/web/src/components/business/dictation/DictationAnswerForm.tsx` | 三字段作答表单 |
| `apps/web/src/components/business/dictation/DictationDiffView.tsx` | 正文差异高亮展示 |

### 前端修改

| 文件 | 改动 |
|---|---|
| `apps/web/src/services/api.ts` | 三个接口函数 + 类型 |
| `apps/web/src/routes/index.tsx` | 三条新路由 |
| `apps/web/src/pages/student/TrainingSubjectPage.tsx` | 语文 enable + 按学科跳转 |

---

## Task 1: 平台语文教材版本闸门

**目的：** 确认国家中小学智慧教育平台上确实有九年级语文教材，并记录可用的出版社标签，供管线计划使用。这不是代码任务，是网络探查闸门。

**Files:**
- 无代码改动；若结果与 spec 不符，改 `docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md` §3 决策 3

**Interfaces:**
- Produces: 供管线计划使用的爬取参数——`--subject 语文`、`--publisher <实际标签>`、`--grade 九年级`、`--semester 上册|下册`。

- [ ] **Step 1: 安装爬虫依赖**

```bash
cd tools/crawler
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

- [ ] **Step 2: dry-run 列出所有语文教材**

```bash
python src/crawler_cli.py --site smartedu --subject 语文 --dry-run --output ./data
```

Expected: 逐行打印将要下载的教材（书名 + 分类维度），**不落盘**。若输出为空或参数校验失败，执行 Step 3。

- [ ] **Step 3: 按九年级收窄**

```bash
python src/crawler_cli.py --site smartedu --subject 语文 --level 初中 --grade 九年级 --dry-run --output ./data
```

Expected: 只列出九年级语文教材。记录每本的 `publisher` 标签与 `semester`。

- [ ] **Step 4: 向用户汇报并索要确认**

汇报必须含：平台上有哪几本九年级语文教材、出版社标签、上下册是否齐全、总页数量级。**用户确认后才可继续 Task 2。** 若平台上没有九年级语文教材，**停止本计划**。

- [ ] **Step 5: 若与 spec 不一致则更新 spec 并提交**

```bash
git add docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md
git commit -m "docs(specs): 按平台实测修正语文教材版本标签"
```

---

## Task 2: 建 `dictation_passages` 表并折回 schema.sql

**Files:**
- Modify: `tools/db/schema.sql`（追加在 `question_hints` 建表语句之后，约 296 行后）

**Interfaces:**
- Produces: 表 `dictation_passages`，列 `id / question_id / work_title / author / dynasty / body / grade_band / grade / semester / sort_order / source_ref / verified / created_at / updated_at`；唯一键 `uniq_dp_question(question_id)` 与 `uniq_dp_work(work_title, semester)`。

- [ ] **Step 1: 在 schema.sql 追加建表语句**

```sql
-- 语文古诗文默写篇目（2026-09-13）。questions 行作锚点（错题本/隐藏/提示都挂 question_id），
-- 本表承载篇目级结构化字段：篇名（稳定业务主键）/作者/朝代/正文/册次/排序/校验闸门。
-- 设计见 docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md §4
CREATE TABLE IF NOT EXISTS dictation_passages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  question_id BIGINT NOT NULL,
  work_title VARCHAR(100) NOT NULL,
  author VARCHAR(50) NOT NULL,
  dynasty VARCHAR(20) NOT NULL,
  body TEXT NOT NULL,
  grade_band VARCHAR(20) NOT NULL,
  grade VARCHAR(20) DEFAULT NULL,
  semester VARCHAR(20) NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  source_ref VARCHAR(200) DEFAULT NULL,
  verified TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_dp_question (question_id),
  UNIQUE KEY uniq_dp_work (work_title, semester),
  KEY idx_dp_filter (grade_band, semester, sort_order),
  CONSTRAINT fk_dp_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

> `uniq_dp_work (work_title, semester)` 是**业务主键**：导入脚本据此 upsert，正文修正后重跑仍幂等更新同一行（spec §4.1.1 问题 1 的解法）。
>
> **`semester` 必须是 `NOT NULL`**（2026-09-13 用户裁决）：MySQL 唯一索引把 NULL 当作互不相等，若 `semester` 可空，两条「同篇名 + NULL 册次」都能插入，业务主键就形同虚设。篇目必来自九上或九下，册次永远知道，故无需要可空。注意：查询侧的「全部」范围是 `WHERE semester = ?` 不加条件（传 null 不过滤），与本列 NOT NULL 不冲突。
>
> **若本地库已按旧的可空 DDL 建过表**：`CREATE TABLE IF NOT EXISTS` 不会修改已存在的表，必须先 `DROP TABLE dictation_passages`（该表此时无数据）再重跑 `schema.sql`。

- [ ] **Step 2: 在本地库执行建表**

```bash
MYSQL_PWD=ai_k12 mysql -u ai_k12 ai_k12 < tools/db/schema.sql
```

Expected: 无报错（`CREATE TABLE IF NOT EXISTS` 对既有表幂等）。

- [ ] **Step 3: 验证表结构**

```bash
MYSQL_PWD=ai_k12 mysql -u ai_k12 ai_k12 -E -e "SHOW CREATE TABLE dictation_passages;"
```

Expected: 输出含 `uniq_dp_question`、`uniq_dp_work`、`idx_dp_filter`，以及外键 `fk_dp_question` 指向 `questions(id)`。

- [ ] **Step 4: Commit**

```bash
git add tools/db/schema.sql
git commit -m "feat(db): 新增 dictation_passages 表（语文古诗文默写篇目）"
```

---

## Task 3: 中文答案归一化 + 差异定位工具

**Files:**
- Modify: `apps/server/src/common/utils/content-hash.util.ts:20`
- Create: `apps/server/src/common/utils/normalize-chinese.util.ts`
- Test: `apps/server/src/common/utils/normalize-chinese.util.test.ts`

**Interfaces:**
- Consumes: `PREFIX_STRIP`（来自 `content-hash.util.ts`）
- Produces:
  - `normalizeChineseAnswer(s: string): string`
  - `type DictationDiffOp = { type: 'equal'; text: string } | { type: 'wrong'; expected: string; actual: string } | { type: 'missing'; text: string } | { type: 'extra'; text: string }`
  - `diffChinese(expected: string, actual: string): DictationDiffOp[]`（入参须已归一化）

- [ ] **Step 1: 导出并扩展标点常量**

把 `apps/server/src/common/utils/content-hash.util.ts:20`：

```ts
const PREFIX_STRIP = /[\s,，.。!！?？;；:：、·'"“”‘’`()（）\[\]【】{}<>《》\-—_/\\|]/g;
```

改为（`export` + 补 `「」『』〈〉…～`）：

```ts
export const PREFIX_STRIP = /[\s,，.。!！?？;；:：、·'"“”‘’`()（）\[\]【】{}<>《》「」『』〈〉…～\-—_/\\|]/g;
```

**为什么直接扩展而不另建一套**：写两套标点表迟早漂移（spec §5「归一化标点集」要求单一来源）。本改动让 `normalizeForPrefix` 更宽松（多剥几种中文标点），只影响 `findByContentPrefix` 模糊匹配，方向是「更能匹配上」，无破坏性。

- [ ] **Step 2: 写失败测试**

创建 `apps/server/src/common/utils/normalize-chinese.util.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { normalizeChineseAnswer, diffChinese } from './normalize-chinese.util.js';

describe('normalizeChineseAnswer', () => {
  it('去掉中文标点', () => {
    expect(normalizeChineseAnswer('床前明月光，疑是地上霜。')).toBe('床前明月光疑是地上霜');
  });

  it('去掉空白（含换行与全角空格）', () => {
    expect(normalizeChineseAnswer('床前 明月光\n疑是\t地上霜')).toBe('床前明月光疑是地上霜');
    expect(normalizeChineseAnswer('床前\u3000明月光')).toBe('床前明月光');
  });

  it('去掉书名号与引号', () => {
    expect(normalizeChineseAnswer('《岳阳楼记》「记」')).toBe('岳阳楼记记');
  });

  it('NFKC 全半角归一', () => {
    expect(normalizeChineseAnswer('Ａ１')).toBe('a1');
  });

  it('不做简繁转换', () => {
    expect(normalizeChineseAnswer('慶曆四年春')).toBe('慶曆四年春');
  });

  it('空值安全', () => {
    expect(normalizeChineseAnswer('')).toBe('');
    expect(normalizeChineseAnswer(undefined as unknown as string)).toBe('');
  });
});

describe('diffChinese', () => {
  it('完全相同 → 单个 equal', () => {
    expect(diffChinese('床前明月光', '床前明月光')).toEqual([{ type: 'equal', text: '床前明月光' }]);
  });

  it('错字 → equal + wrong', () => {
    expect(diffChinese('床前明月光', '床前明月先')).toEqual([
      { type: 'equal', text: '床前明月' },
      { type: 'wrong', expected: '光', actual: '先' },
    ]);
  });

  it('漏写 → missing', () => {
    expect(diffChinese('床前明月光', '床前明月')).toEqual([
      { type: 'equal', text: '床前明月' },
      { type: 'missing', text: '光' },
    ]);
  });

  it('多写 → extra', () => {
    expect(diffChinese('床前明月光', '床前明月光啊')).toEqual([
      { type: 'equal', text: '床前明月光' },
      { type: 'extra', text: '啊' },
    ]);
  });

  it('连续漏写合并成一段', () => {
    expect(diffChinese('床前明月光', '床前')).toEqual([
      { type: 'equal', text: '床前' },
      { type: 'missing', text: '明月光' },
    ]);
  });

  it('顺序颠倒不算全对', () => {
    const ops = diffChinese('明月', '月明');
    // 顺序颠倒时 LCS 仍会保留一个公共字（LCS('明月','月明') = 1），
    // 所以 diff 里出现 equal 是正常的；关键是它不能是「完全一致」那一种结果。
    expect(ops).not.toEqual([{ type: 'equal', text: '月明' }]);
    expect(ops.some((o) => o.type === 'wrong' || o.type === 'missing' || o.type === 'extra')).toBe(true);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd apps/server && npx vitest run src/common/utils/normalize-chinese.util.test.ts
```

Expected: FAIL —— `Failed to resolve import "./normalize-chinese.util.js"`。

- [ ] **Step 4: 实现工具**

创建 `apps/server/src/common/utils/normalize-chinese.util.ts`：

```ts
import { PREFIX_STRIP } from './content-hash.util.js';

/**
 * 语文默写答案归一化：NFKC 全半角归一 → 去所有空白 → 去中英文标点 → 转小写。
 * 等价于「判对错时不算标点符号和空格」（设计 spec §5）。
 * 刻意不做简繁转换：教材为简体，学生也写简体，转繁会掩盖真实错误。
 * 复用 content-hash.util 的 PREFIX_STRIP，保证全仓只有一套标点表。
 */
export function normalizeChineseAnswer(s: string): string {
  return (s ?? '').normalize('NFKC').toLowerCase().replace(PREFIX_STRIP, '');
}

export type DictationDiffOp =
  | { type: 'equal'; text: string }
  | { type: 'wrong'; expected: string; actual: string }
  | { type: 'missing'; text: string }
  | { type: 'extra'; text: string };

/**
 * 逐字差异定位（LCS 最长公共子序列回溯）。
 * 入参须已归一化（用 normalizeChineseAnswer），因此差异视图展示的是
 * 「忽略标点与空格后」的对比——与判对错口径一致。
 * 相邻的「漏写 + 多写」会合并为一个 wrong（即写错字）。
 */
export function diffChinese(expected: string, actual: string): DictationDiffOp[] {
  const n = expected.length;
  const m = actual.length;
  // lcs[i][j] = expected[i..] 与 actual[j..] 的最长公共子序列长度（从后往前填）
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = expected[i] === actual[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const raw: DictationDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (expected[i] === actual[j]) {
      raw.push({ type: 'equal', text: expected[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      raw.push({ type: 'missing', text: expected[i] }); // 学生漏写
      i++;
    } else {
      raw.push({ type: 'extra', text: actual[j] }); // 学生多写
      j++;
    }
  }
  while (i < n) {
    raw.push({ type: 'missing', text: expected[i] });
    i++;
  }
  while (j < m) {
    raw.push({ type: 'extra', text: actual[j] });
    j++;
  }

  // 合并：相邻 missing+extra → wrong（写错字）；同类连续项合并成一段
  const merged: DictationDiffOp[] = [];
  for (const op of raw) {
    const prev = merged[merged.length - 1];
    const prevIsOneSided = prev && (prev.type === 'missing' || prev.type === 'extra');
    const opIsOneSided = op.type === 'missing' || op.type === 'extra';
    if (prev && prevIsOneSided && opIsOneSided && prev.type !== op.type) {
      const p = prev as { type: 'missing' | 'extra'; text: string };
      const o = op as { type: 'missing' | 'extra'; text: string };
      merged[merged.length - 1] = p.type === 'missing'
        ? { type: 'wrong', expected: p.text, actual: o.text }
        : { type: 'wrong', expected: o.text, actual: p.text };
      continue;
    }
    if (prev && prev.type === op.type && (op.type === 'equal' || op.type === 'missing' || op.type === 'extra')) {
      (prev as { text: string }).text += op.text;
      continue;
    }
    merged.push(op);
  }
  return merged;
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd apps/server && npx vitest run src/common/utils/normalize-chinese.util.test.ts
```

Expected: PASS，12 个用例全绿。

- [ ] **Step 6: 跑全量测试确认没打破 prefix 匹配**

```bash
cd apps/server && npm test
```

Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/common/utils/content-hash.util.ts apps/server/src/common/utils/normalize-chinese.util.ts apps/server/src/common/utils/normalize-chinese.util.test.ts
git commit -m "feat(server): 新增语文答案归一化与逐字差异定位工具"
```

---

## Task 4: DictationPassagesRepository

**Files:**
- Create: `apps/server/src/database/repositories/dictation-passages.repo.ts`
- Modify: `apps/server/src/database/repositories/index.ts`
- Test: `apps/server/src/database/repositories/dictation-passages.repo.test.ts`

**Interfaces:**
- Produces:
  - `interface DictationPassageRow`（列同表；snake_case）
  - `interface DictationListRow extends DictationPassageRow { questionContent: string }`
  - `interface DictationUpsertInput`（camelCase）
  - `class DictationPassagesRepository`
    - `findByQuestionId(questionId): Promise<DictationPassageRow | null>`
    - `findVerifiedBySubject(subjectId): Promise<DictationListRow[]>`
    - `findRandomVerified(studentId, subjectId, semester | null, count): Promise<DictationListRow[]>`
    - `findVerifiedByQuestionIds(subjectId, questionIds): Promise<DictationListRow[]>`
    - `upsert(row: DictationUpsertInput): Promise<void>`

- [ ] **Step 1: 写失败测试**

创建 `apps/server/src/database/repositories/dictation-passages.repo.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { DictationPassagesRepository } from './dictation-passages.repo';

const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([rows, []]),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('DictationPassagesRepository', () => {
  it('findVerifiedBySubject：只出 verified=1 且题未停用，按 sort_order 排序', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    await repo.findVerifiedBySubject(2);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM dictation_passages dp');
    expect(sql).toContain('JOIN questions q ON q.id = dp.question_id');
    expect(sql).toContain('dp.verified = 1');
    expect(sql).toContain('q.is_active = 1');
    expect(sql).toContain('q.subject_id = ?');
    expect(sql).toContain('ORDER BY dp.sort_order');
    expect(params).toEqual([2]);
  });

  it('findRandomVerified：排除已标记不再展示的题，带 LIMIT 与册次过滤', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    await repo.findRandomVerified(7, 2, '上册', 5);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('LEFT JOIN student_hidden_questions shq');
    expect(sql).toContain('shq.question_id = dp.question_id AND shq.student_id = ?');
    expect(sql).toContain('shq.id IS NULL');
    expect(sql).toContain('dp.semester = ?');
    expect(sql).toContain('ORDER BY RAND()');
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual([7, 2, '上册', 5]);
  });

  it('findRandomVerified：semester=null 时不含册次过滤', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    await repo.findRandomVerified(7, 2, null, 5);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('dp.semester = ?');
    expect(params).toEqual([7, 2, 5]);
  });

  it('findVerifiedByQuestionIds：空数组直接返回空，不查库', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    const rows = await repo.findVerifiedByQuestionIds(2, []);
    expect(rows).toEqual([]);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('upsert：按 (work_title, semester) 业务主键 upsert', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    await repo.upsert({
      questionId: 100, workTitle: '静夜思', author: '李白', dynasty: '唐',
      body: '床前明月光', gradeBand: 'junior', grade: '九年级', semester: '上册',
      sortOrder: 1, sourceRef: 'DEV-FIXTURE', verified: 0,
    });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO dictation_passages');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('work_title');
    expect(params[0]).toBe(100);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd apps/server && npx vitest run src/database/repositories/dictation-passages.repo.test.ts
```

Expected: FAIL —— 找不到模块。

- [ ] **Step 3: 实现 repo**

创建 `apps/server/src/database/repositories/dictation-passages.repo.ts`：

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface DictationPassageRow extends RowDataPacket {
  id: number;
  question_id: number;
  work_title: string;
  author: string;
  dynasty: string;
  body: string;
  grade_band: string;
  grade: string | null;
  semester: string;
  sort_order: number;
  source_ref: string | null;
  verified: number;
}

export interface DictationListRow extends DictationPassageRow {
  questionContent: string;
}

export interface DictationUpsertInput {
  questionId: number;
  workTitle: string;
  author: string;
  dynasty: string;
  body: string;
  gradeBand: string;
  grade: string | null;
  semester: string;
  sortOrder: number;
  sourceRef: string | null;
  verified: number;
}

const SELECT_COLS = `dp.id, dp.question_id, dp.work_title, dp.author, dp.dynasty, dp.body,
  dp.grade_band, dp.grade, dp.semester, dp.sort_order, dp.source_ref, dp.verified,
  q.content AS questionContent`;

/**
 * 语文古诗文默写篇目 repo。
 * 只向抽题池暴露 verified=1 的篇目（校验闸门，spec §6）；导入侧用 upsert 写全量。
 */
@Injectable()
export class DictationPassagesRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async findByQuestionId(questionId: number): Promise<DictationPassageRow | null> {
    const [rows] = await this.pool.execute<DictationPassageRow[]>(
      `SELECT ${SELECT_COLS} FROM dictation_passages dp
       JOIN questions q ON q.id = dp.question_id
       WHERE dp.question_id = ? LIMIT 1`,
      [questionId],
    );
    return rows[0] ?? null;
  }

  async findVerifiedBySubject(subjectId: number): Promise<DictationListRow[]> {
    const [rows] = await this.pool.execute<DictationListRow[]>(
      `SELECT ${SELECT_COLS} FROM dictation_passages dp
       JOIN questions q ON q.id = dp.question_id
       WHERE q.subject_id = ? AND q.is_active = 1 AND dp.verified = 1
       ORDER BY dp.sort_order, dp.id`,
      [subjectId],
    );
    return rows;
  }

  async findRandomVerified(
    studentId: number,
    subjectId: number,
    semester: string | null,
    count: number,
  ): Promise<DictationListRow[]> {
    const params: unknown[] = [studentId, subjectId];
    let sql = `SELECT ${SELECT_COLS} FROM dictation_passages dp
       JOIN questions q ON q.id = dp.question_id
       LEFT JOIN student_hidden_questions shq
         ON shq.question_id = dp.question_id AND shq.student_id = ?
       WHERE q.subject_id = ? AND q.is_active = 1 AND dp.verified = 1
         AND shq.id IS NULL`;
    if (semester != null) {
      sql += ' AND dp.semester = ?';
      params.push(semester);
    }
    sql += ' ORDER BY RAND() LIMIT ?';
    params.push(count);
    // LIMIT ? 不能走 prepared statement（mysql2 execute 报 Incorrect arguments），用 query
    const [rows] = await this.pool.query<DictationListRow[]>(sql, params);
    return rows;
  }

  async findVerifiedByQuestionIds(subjectId: number, questionIds: number[]): Promise<DictationListRow[]> {
    if (questionIds.length === 0) return [];
    const placeholders = questionIds.map(() => '?').join(',');
    const [rows] = await this.pool.execute<DictationListRow[]>(
      `SELECT ${SELECT_COLS} FROM dictation_passages dp
       JOIN questions q ON q.id = dp.question_id
       WHERE q.subject_id = ? AND q.is_active = 1 AND dp.verified = 1
         AND dp.question_id IN (${placeholders})`,
      [subjectId, ...questionIds],
    );
    return rows;
  }

  /** 按 (work_title, semester) 业务主键 upsert：正文修正后重跑仍更新同一行（幂等）。 */
  async upsert(row: DictationUpsertInput): Promise<void> {
    await this.pool.execute(
      `INSERT INTO dictation_passages
         (question_id, work_title, author, dynasty, body, grade_band, grade, semester,
          sort_order, source_ref, verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         question_id = VALUES(question_id), author = VALUES(author), dynasty = VALUES(dynasty),
         body = VALUES(body), grade_band = VALUES(grade_band), grade = VALUES(grade),
         sort_order = VALUES(sort_order), source_ref = VALUES(source_ref), verified = VALUES(verified)`,
      [
        row.questionId, row.workTitle, row.author, row.dynasty, row.body,
        row.gradeBand, row.grade, row.semester, row.sortOrder, row.sourceRef, row.verified,
      ],
    );
  }
}
```

- [ ] **Step 4: 在 repositories/index.ts 导出**

```ts
export { DictationPassagesRepository } from './dictation-passages.repo.js';
export type { DictationPassageRow, DictationListRow, DictationUpsertInput } from './dictation-passages.repo.js';
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd apps/server && npx vitest run src/database/repositories/dictation-passages.repo.test.ts
```

Expected: PASS，5 个用例全绿。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/database/repositories/dictation-passages.repo.ts apps/server/src/database/repositories/dictation-passages.repo.test.ts apps/server/src/database/repositories/index.ts
git commit -m "feat(server): 新增 dictation_passages 仓储"
```

---

## Task 5: 开发假数据种子脚本

**目的：** 用 2 篇**开发假数据**（短诗，内容确定、非生产篇目）把链路跑通。生产内容由管线计划提供，**本任务数据不得当作正式题库**。

**Files:**
- Create: `apps/server/src/scripts/seed-dictation-fixture.ts`

**Interfaces:**
- Consumes: `DictationPassagesRepository.upsert`（Task 4）、`computeContentHash`（既有）
- Produces: 库中 2 行 `questions`（`type='poem_dictation'`, `subject_id=2`, `answer_verified=0`, `source='DEV-FIXTURE'`）+ 2 行 `dictation_passages`（`verified=1`）

- [ ] **Step 1: 写脚本**

创建 `apps/server/src/scripts/seed-dictation-fixture.ts`：

```ts
/**
 * 【开发假数据】语文默写链路验证种子。
 *
 * 警告：这里的数据**不是生产题库**，仅为打通「训练 → 语文 → 专项 → 默写」链路。
 * 生产篇目由内容管线（爬 smartedu 教材 + 逐篇校验）导入，见
 * docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md §6。
 * 两条记录以 source_ref = 'DEV-FIXTURE' 标记，便于后续清理。
 *
 * 幂等：questions 走 content_hash 去重，dictation_passages 走 (work_title, semester) upsert。
 * 运行：npx tsx src/scripts/seed-dictation-fixture.ts
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { computeContentHash } from '../common/utils/content-hash.util.js';
import { DictationPassagesRepository } from '../database/repositories/dictation-passages.repo.js';

const CHINESE_SUBJECT_ID = 2;

const FIXTURES = [
  {
    workTitle: '静夜思',
    author: '李白',
    dynasty: '唐',
    body: '床前明月光，疑是地上霜。举头望明月，低头思故乡。',
    semester: '上册',
    sortOrder: 9001,
  },
  {
    workTitle: '登鹳雀楼',
    author: '王之涣',
    dynasty: '唐',
    body: '白日依山尽，黄河入海流。欲穷千里目，更上一层楼。',
    semester: '上册',
    sortOrder: 9002,
  },
];

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });
  const repo = new DictationPassagesRepository(pool as never);

  for (const f of FIXTURES) {
    const content = `请默写《${f.workTitle}》（并写出作者与朝代）`;
    const answer = `作者：${f.author}\n朝代：${f.dynasty}\n正文：${f.body}`;
    const hash = computeContentHash(content);

    await pool.execute(
      `INSERT INTO questions
         (subject_id, type, difficulty, content, answer, grade_band, source, content_hash, answer_verified, is_active)
       VALUES (?, 'poem_dictation', 2, ?, ?, 'junior', 'DEV-FIXTURE', ?, 0, 1)
       ON DUPLICATE KEY UPDATE
         answer = VALUES(answer), source = VALUES(source), is_active = 1`,
      [CHINESE_SUBJECT_ID, content, answer, hash],
    );
    const [rows] = await pool.execute<any[]>(
      'SELECT id FROM questions WHERE content_hash = ? LIMIT 1',
      [hash],
    );
    const questionId = rows[0].id as number;

    await repo.upsert({
      questionId,
      workTitle: f.workTitle,
      author: f.author,
      dynasty: f.dynasty,
      body: f.body,
      gradeBand: 'junior',
      grade: '九年级',
      semester: f.semester,
      sortOrder: f.sortOrder,
      sourceRef: 'DEV-FIXTURE',
      verified: 1,
    });
    console.log(`seeded questionId=${questionId} 《${f.workTitle}》`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: 运行脚本**

```bash
cd apps/server && npx tsx src/scripts/seed-dictation-fixture.ts
```

Expected: 打印两行 `seeded questionId=... 《静夜思》` / `《登鹳雀楼》`。

- [ ] **Step 3: 重跑一次验证幂等**

```bash
cd apps/server && npx tsx src/scripts/seed-dictation-fixture.ts
MYSQL_PWD=ai_k12 mysql -u ai_k12 ai_k12 -e "SELECT COUNT(*) AS p FROM dictation_passages WHERE source_ref='DEV-FIXTURE'; SELECT COUNT(*) AS q FROM questions WHERE source='DEV-FIXTURE';"
```

Expected: 第二次打印的 questionId 与第一次相同；两个计数都是 `2`（不是 4）。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/scripts/seed-dictation-fixture.ts
git commit -m "chore(server): 新增语文默写开发假数据种子脚本（链路验证用）"
```

---

## Task 6: 错因文案能力（prompt + capability + 配置）

**Files:**
- Modify: `apps/server/src/ai-core/types.ts:15`（`Scene`）、`:52`（`CapabilityType`）、文件末尾
- Create: `apps/server/src/ai-core/prompts/dictation/feedback.md`
- Create: `apps/server/src/ai-core/capabilities/dictation-feedback.capability.ts`
- Test: `apps/server/src/ai-core/capabilities/dictation-feedback.capability.test.ts`
- Modify: `apps/server/src/ai-core/infra/prompt-builder.ts`（`resolveTemplatePath`）
- Modify: `apps/server/src/ai-core/model-routes.yaml`、`apps/server/src/ai-core/retry.yaml`
- Create: `apps/server/src/scripts/seed-dictation-feedback-route.ts`

**Interfaces:**
- Produces:
  - `Scene` 加 `'dictation_feedback'`；`CapabilityType` 加 `'dictation_feedback'`
  - `interface DictationFeedbackRequest { workTitle: string; expected: {author;dynasty;body}; student: {author;dynasty;body}; fieldMatch: {author: boolean;dynasty: boolean;body: boolean}; bodyDiffText: string }`
  - `interface DictationFeedbackResponse { content: string; reasoning?: string }`
  - `class DictationFeedbackCapability { generate(req): Promise<DictationFeedbackResponse> }`

- [ ] **Step 1: 写失败测试**

创建 `apps/server/src/ai-core/capabilities/dictation-feedback.capability.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { DictationFeedbackCapability } from './dictation-feedback.capability.js';

const baseRequest = {
  workTitle: '静夜思',
  expected: { author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。' },
  student: { author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。' },
  fieldMatch: { author: true, dynasty: true, body: false },
  bodyDiffText: '床前明月[光→先]，疑是地上霜。',
};

describe('DictationFeedbackCapability', () => {
  it('主模型成功 → 返回去除首尾空白的文本', async () => {
    const modelClient = { chat: vi.fn().mockResolvedValue({ content: '  你把「光」写成了「先」。  ' }) };
    const cap = new DictationFeedbackCapability({ modelClient: modelClient as never });
    const res = await cap.generate(baseRequest);
    expect(res.content).toBe('你把「光」写成了「先」。');
  });

  it('主模型失败 → 回退 fallback 模型', async () => {
    const chat = vi.fn()
      .mockRejectedValueOnce(new Error('local down'))
      .mockResolvedValueOnce({ content: '回退模型的错因' });
    const cap = new DictationFeedbackCapability({ modelClient: { chat } as never });
    const res = await cap.generate(baseRequest);
    expect(res.content).toBe('回退模型的错因');
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('两个模型都失败 → 抛出（调用方兜底为 feedback=null）', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('all down'));
    const cap = new DictationFeedbackCapability({ modelClient: { chat } as never });
    await expect(cap.generate(baseRequest)).rejects.toThrow();
  });

  it('模型返回空白 → content 为空串', async () => {
    const modelClient = { chat: vi.fn().mockResolvedValue({ content: '   ' }) };
    const cap = new DictationFeedbackCapability({ modelClient: modelClient as never });
    const res = await cap.generate(baseRequest);
    expect(res.content).toBe('');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd apps/server && npx vitest run src/ai-core/capabilities/dictation-feedback.capability.test.ts
```

Expected: FAIL —— 找不到模块。

- [ ] **Step 3: 扩展 types.ts**

`apps/server/src/ai-core/types.ts:15`：

```ts
export type Scene = 'tutoring' | 'grading' | 'judgment' | 'explanation' | 'variation' | 'analysis' | 'safety' | 'structuring' | 'hint' | 'title' | 'dictation_feedback';
```

`apps/server/src/ai-core/types.ts:52`：

```ts
export type CapabilityType = 'tutoring' | 'grading' | 'judgment' | 'explanation' | 'variation' | 'analysis' | 'fallback' | 'structuring' | 'hint' | 'dictation_feedback';
```

文件末尾追加：

```ts
// ========== Dictation Feedback Types（语文古诗文默写错因，2026-09-13） ==========

export interface DictationFeedbackRequest {
  workTitle: string;
  expected: { author: string; dynasty: string; body: string };
  student: { author: string; dynasty: string; body: string };
  /** 三字段各自是否匹配（程序已判好传入；模型只解释，不判对错） */
  fieldMatch: { author: boolean; dynasty: boolean; body: boolean };
  /** 已渲染成可读文本的正文差异，如 床前明月[光→先] */
  bodyDiffText: string;
}

export interface DictationFeedbackResponse {
  content: string;
  reasoning?: string;
}
```

- [ ] **Step 4: 写 prompt 模板**

创建 `apps/server/src/ai-core/prompts/dictation/feedback.md`：

```markdown
---
version: "1.0"
description: "语文古诗文默写 - 针对程序定位出的错处，写一段给学生看的错因提醒"
---

## System Prompt

你是一位初中语文老师，正在给学生批改古诗文默写。

**对错已经由系统判定完毕，你不需要再判对错**。你唯一的任务是：针对下面给出的错处，写一段简短的提醒，帮学生记住正确写法。

### 写作规则
1. 先点出**错在哪**：是作者错、朝代错，还是正文里的哪几个字写错了。
2. 再给**怎么记**：形近字/同音字辨析、易错笔顺、句意联想等，让学生下次不再错。
3. 只针对给出的错处讲，**不要重复整篇正确原文**，不要长篇大论。
4. 语气平和鼓励，用「注意」「试试这样记」，不要责备。
5. 篇幅 2-4 句话，不超过 120 字。
6. 不要输出 JSON，不要输出标题，直接给正文。

---

## User Message

**篇目**：《{{workTitle}}》

**正确答案**
- 作者：{{expected.author}}
- 朝代：{{expected.dynasty}}
- 正文：{{expected.body}}

**学生答案**
- 作者：{{student.author}}
- 朝代：{{student.dynasty}}
- 正文：{{student.body}}

**程序判定的错处**
- 作者是否正确：{{fieldMatch.author}}
- 朝代是否正确：{{fieldMatch.dynasty}}
- 正文是否正确：{{fieldMatch.body}}
- 正文逐字差异：{{bodyDiffText}}

请针对以上错处写一段错因提醒。
```

> `{{fieldMatch.author}}` 渲染为 `true` / `false`。HTML 转义已关闭（`prompt-builder.ts:46-48`），数学符号与中文标点原样保留。

- [ ] **Step 5: 扩展 PromptBuilder 模板路由**

在 `apps/server/src/ai-core/infra/prompt-builder.ts` 的 `resolveTemplatePath` 中，`structuring` 分支（约 93-95 行）之前插入：

```ts
    if (capability === 'dictation_feedback') {
      return `dictation/feedback.md`;
    }
```

- [ ] **Step 6: 实现 capability**

创建 `apps/server/src/ai-core/capabilities/dictation-feedback.capability.ts`：

```ts
import type { DictationFeedbackRequest, DictationFeedbackResponse } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient } from '../infra/model-client/index.js';
import { ResponseParser } from '../infra/response-parser.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DictationFeedbackCapabilityDeps {
  modelClient?: ModelClient;
}

/**
 * 语文默写「错因」能力。
 *
 * 与 JudgmentCapability 的区别：本能力**不判对错**——对错由 JudgeCoreService.judgeDictation
 * 程序化判定，这里只把程序定位出的错处翻译成学生看得懂的提醒（设计 spec §5 第 5 步）。
 * 场景 dictation_feedback：primary=local（Qwen3.8-27B），fallback=deepseek-v4-flash；
 * 两者都失败时抛错，由调用方（TrainingService）兜底为 feedback=null，不阻断判题。
 */
export class DictationFeedbackCapability {
  private modelRouter = new ModelRouter(getModelConfigRegistry());
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private responseParser = new ResponseParser();

  constructor(deps?: DictationFeedbackCapabilityDeps) {
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async generate(request: DictationFeedbackRequest): Promise<DictationFeedbackResponse> {
    const routeResult = this.modelRouter.route({ scene: 'dictation_feedback', subject: 'chinese' });
    const timeout = timeoutConfig.timeout.dictation_feedback ?? timeoutConfig.timeout.default;

    const promptResult = await this.promptBuilder.build({
      capability: 'dictation_feedback',
      subject: 'chinese',
      context: {
        workTitle: request.workTitle,
        expected: request.expected,
        student: request.student,
        fieldMatch: request.fieldMatch,
        bodyDiffText: request.bodyDiffText,
        userMessage: '请针对以上错处写一段错因提醒。',
      },
    });

    const callOnce = async (model: typeof routeResult.primary) => {
      const chatResponse = await this.modelClient.chat({
        model,
        messages: promptResult.messages,
        timeout,
      });
      const parsed = this.responseParser.parse({ rawContent: chatResponse.content, mode: 'text' });
      return {
        content: (parsed.rawText ?? chatResponse.content ?? '').trim(),
        reasoning: chatResponse.reasoningContent,
      };
    };

    try {
      return await callOnce(routeResult.primary);
    } catch (err) {
      if (!routeResult.fallback) throw err;
      return await callOnce(routeResult.fallback);
    }
  }
}
```

- [ ] **Step 7: 运行测试确认通过**

```bash
cd apps/server && npx vitest run src/ai-core/capabilities/dictation-feedback.capability.test.ts
```

Expected: PASS，4 个用例全绿。

- [ ] **Step 8: 加 model-routes.yaml 路由**

在 `apps/server/src/ai-core/model-routes.yaml` 的 `title:` 块之后、`default:` 之前插入：

```yaml
  # 语文古诗文默写错因文案：本地模型优先（与 judgment 同策略，不依赖外部余额），
  # 本地不可用回退 deepseek-v4-flash；两者都失败则无错因文案（不阻断判题）。
  dictation_feedback:
    - subject: "*"
      primary: local
      fallback: deepseek-v4-flash
```

- [ ] **Step 9: 加 retry.yaml 超时**

在 `apps/server/src/ai-core/retry.yaml` 的 `timeout:` 块内追加：

```yaml
  dictation_feedback: 30000
```

- [ ] **Step 10: 写补路由脚本（给已 seed 的库）**

先确认真实列名与唯一键：

```bash
grep -n "CREATE TABLE IF NOT EXISTS llm_routes" -A 15 tools/db/schema.sql
```

按实际 schema 创建 `apps/server/src/scripts/seed-dictation-feedback-route.ts`（下列代码按 `llm_routes(scene, subject, primary_model_id, fallback_model_id, is_active)` 与 `llm_models(model_key)` 编写；**若与实际不符，按实际改脚本，不要改 schema**）：

```ts
/**
 * 给已 seed llm_routes 的库补 dictation_feedback 路由（YAML 只服务新装 / DB 空时）。
 * 幂等：按 (scene, subject) upsert。先例：set-judging-local.ts / set-title-route.ts。
 * 运行：npx tsx src/scripts/seed-dictation-feedback-route.ts
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });

  const [models] = await pool.query<any[]>('SELECT id, model_key FROM llm_models');
  const idOf = new Map<string, number>(models.map((m) => [m.model_key as string, m.id as number]));
  const primaryId = idOf.get('local');
  const fallbackId = idOf.get('deepseek-v4-flash');
  if (!primaryId || !fallbackId) {
    throw new Error('llm_models 缺少 local 或 deepseek-v4-flash，请先跑 seed-llm-config');
  }

  await pool.execute(
    `INSERT INTO llm_routes (scene, subject, primary_model_id, fallback_model_id, is_active)
     VALUES ('dictation_feedback', '*', ?, ?, 1)
     ON DUPLICATE KEY UPDATE primary_model_id = VALUES(primary_model_id),
       fallback_model_id = VALUES(fallback_model_id), is_active = 1`,
    [primaryId, fallbackId],
  );
  console.log('dictation_feedback route upserted');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 11: 跑脚本并验证**

```bash
cd apps/server && npx tsx src/scripts/seed-dictation-feedback-route.ts
MYSQL_PWD=ai_k12 mysql -u ai_k12 ai_k12 -e "SELECT scene, subject, primary_model_id, fallback_model_id FROM llm_routes WHERE scene='dictation_feedback';"
```

Expected: 打印 `dictation_feedback route upserted`，并查到 1 行路由。

- [ ] **Step 12: 跑全量测试**

```bash
cd apps/server && npm test
```

Expected: 全绿。

- [ ] **Step 13: Commit**

```bash
git add apps/server/src/ai-core/types.ts apps/server/src/ai-core/prompts/dictation/feedback.md apps/server/src/ai-core/capabilities/dictation-feedback.capability.ts apps/server/src/ai-core/capabilities/dictation-feedback.capability.test.ts apps/server/src/ai-core/infra/prompt-builder.ts apps/server/src/ai-core/model-routes.yaml apps/server/src/ai-core/retry.yaml apps/server/src/scripts/seed-dictation-feedback-route.ts
git commit -m "feat(ai-core): 新增语文默写错因能力 dictation_feedback（本地优先，ds 兜底）"
```

---

## Task 7: JudgeCoreService.judgeDictation（纯程序判题）

**Files:**
- Modify: `apps/server/src/modules/practice/judge-core.service.ts`
- Test: `apps/server/src/modules/practice/judge-core.dictation.test.ts`

**Interfaces:**
- Consumes: `normalizeChineseAnswer`、`diffChinese`、`DictationDiffOp`（Task 3）；`QuestionsRepository`、私有 `writeErrorBookOrReuse`（既有）
- Produces:
  - `interface JudgeDictationInput { studentId; subjectId; questionId; expected: {author;dynasty;body}; student: {author;dynasty;body} }`
  - `interface JudgeDictationOutput { questionId: number; isCorrect: boolean; method: 'exact'; fields: { author: {match:boolean}; dynasty: {match:boolean}; body: {match:boolean} }; bodyDiff: DictationDiffOp[]; errorBookId?: number }`
  - `JudgeCoreService.judgeDictation(input: JudgeDictationInput): Promise<JudgeDictationOutput>`

- [ ] **Step 1: 确认 `writeErrorBookOrReuse` 的真实签名与它调用的 repo 方法名**

```bash
cd apps/server && grep -n "writeErrorBookOrReuse" -A 22 src/modules/practice/judge-core.service.ts
```

必须看清两件事，并据此调整下面 Step 2 测试里的 mock 与 Step 5 的调用：

1. **参数形状**：是否含 `sourceRefId`（下面代码假设为 `{ studentId, subjectId, questionId, source, sourceRefId }`）；
2. **它内部调用的仓储方法名**（下面测试 mock 的是 `mainErrorRepo.findOrCreate`）。若实际方法名不同（例如 `findOrCreateByStudentQuestion`），**把测试 mock 的方法名改成实际名**，否则 `errorBookId` 会是 `undefined`，Step 6 的断言会失败。

**不要改 `judge-core.service.ts` 里既有的 `writeErrorBookOrReuse` 与其调用方**——本任务只新增 `judgeDictation`。

- [ ] **Step 2: 写失败测试**

创建 `apps/server/src/modules/practice/judge-core.dictation.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { JudgeCoreService } from './judge-core.service';

const QUESTION = {
  id: 100, subject_id: 2, type: 'poem_dictation', difficulty: 2,
  content: '请默写《静夜思》（并写出作者与朝代）',
  options: null, answer: '作者：李白\n朝代：唐\n正文：床前明月光，疑是地上霜。',
  explanation: null, source: 'DEV-FIXTURE', content_hash: 'x', is_active: 1, created_at: new Date(),
};

function makeService() {
  const questionsRepo = { findById: vi.fn().mockResolvedValue(QUESTION) };
  const mainErrorRepo = {
    clearUnclearedByStudentQuestionId: vi.fn().mockResolvedValue(undefined),
    findOrCreate: vi.fn().mockResolvedValue({ id: 555 }),
  };
  const service = new JudgeCoreService(
    questionsRepo as never,
    mainErrorRepo as never,
    {} as never, // structuring
    {} as never, // judgment
    { ensureExplanation: vi.fn() } as never,
    {} as never, // selfAssessRepo
  );
  return { service, questionsRepo, mainErrorRepo };
}

const EXPECTED = { author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。' };

describe('JudgeCoreService.judgeDictation', () => {
  it('三项全对（忽略标点与空格）→ isCorrect=true，清错题', async () => {
    const { service, mainErrorRepo } = makeService();
    const res = await service.judgeDictation({
      studentId: 7, subjectId: 2, questionId: 100,
      expected: EXPECTED,
      student: { author: '李白', dynasty: '唐', body: '床前明月光疑是地上霜' },
    });
    expect(res.isCorrect).toBe(true);
    expect(res.fields).toEqual({ author: { match: true }, dynasty: { match: true }, body: { match: true } });
    expect(mainErrorRepo.clearUnclearedByStudentQuestionId).toHaveBeenCalledWith(7, 100);
  });

  it('仅正文错一个字 → isCorrect=false，入错题本，diff 标出该字', async () => {
    const { service, mainErrorRepo } = makeService();
    const res = await service.judgeDictation({
      studentId: 7, subjectId: 2, questionId: 100,
      expected: EXPECTED,
      student: { author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。' },
    });
    expect(res.isCorrect).toBe(false);
    expect(res.fields.body.match).toBe(false);
    expect(res.fields.author.match).toBe(true);
    expect(res.bodyDiff).toContainEqual({ type: 'wrong', expected: '光', actual: '先' });
    expect(mainErrorRepo.findOrCreate).toHaveBeenCalled();
    expect(res.errorBookId).toBe(555);
  });

  it('仅朝代错 → isCorrect=false', async () => {
    const { service } = makeService();
    const res = await service.judgeDictation({
      studentId: 7, subjectId: 2, questionId: 100,
      expected: EXPECTED,
      student: { author: '李白', dynasty: '宋', body: EXPECTED.body },
    });
    expect(res.isCorrect).toBe(false);
    expect(res.fields.dynasty.match).toBe(false);
  });

  it('三项全空 → isCorrect=false（不同于客观题的空答案守卫）', async () => {
    const { service } = makeService();
    const res = await service.judgeDictation({
      studentId: 7, subjectId: 2, questionId: 100,
      expected: EXPECTED, student: { author: '', dynasty: '', body: '' },
    });
    expect(res.isCorrect).toBe(false);
  });

  it('题目不存在 → 抛 4004', async () => {
    const { service, questionsRepo } = makeService();
    questionsRepo.findById.mockResolvedValue(null);
    await expect(
      service.judgeDictation({
        studentId: 7, subjectId: 2, questionId: 999, expected: EXPECTED, student: EXPECTED,
      }),
    ).rejects.toMatchObject({ response: { code: 4004 } });
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd apps/server && npx vitest run src/modules/practice/judge-core.dictation.test.ts
```

Expected: FAIL —— `service.judgeDictation is not a function`。

- [ ] **Step 4: 加导入与类型**

在 `judge-core.service.ts` 既有 import 之后追加：

```ts
import { normalizeChineseAnswer, diffChinese, type DictationDiffOp } from '../../common/utils/normalize-chinese.util.js';
```

在 `JudgeCoreQuestionInput` 定义之后插入：

```ts
export interface JudgeDictationInput {
  studentId: number;
  subjectId: number;
  questionId: number;
  expected: { author: string; dynasty: string; body: string };
  student: { author: string; dynasty: string; body: string };
}

export interface JudgeDictationOutput {
  questionId: number;
  isCorrect: boolean;
  method: 'exact';
  fields: { author: { match: boolean }; dynasty: { match: boolean }; body: { match: boolean } };
  bodyDiff: DictationDiffOp[];
  errorBookId?: number;
}
```

- [ ] **Step 5: 加方法实现**

在 `judgeQuestion` 方法结束（约 198 行 `}`）之后插入：

```ts
  /**
   * 语文古诗文默写判题（2026-09-13）：**纯程序化**，不调用任何 LLM。
   *
   * 对错完全由「归一化后逐字段全等」决定（三项全对才算对）；正文错处由 LCS 差异定位。
   * 错因文案由调用方（TrainingService）在判题之后单独调 DictationFeedbackCapability，
   * 失败不影响本方法返回值。
   *
   * 不调用 ExplanationCacheService.ensureExplanation：它的「answer >= 100 字直写解析」
   * 规则会让长文言文的解析变成「解析 = 正文」（设计 spec §5 第 6 步）。
   */
  async judgeDictation(input: JudgeDictationInput): Promise<JudgeDictationOutput> {
    const q = await this.questionsRepo.findById(input.questionId);
    if (!q) {
      throw new HttpException({ code: 4004, message: '题目不存在' }, 400);
    }

    const author = { match: normalizeChineseAnswer(input.student.author) === normalizeChineseAnswer(input.expected.author) };
    const dynasty = { match: normalizeChineseAnswer(input.student.dynasty) === normalizeChineseAnswer(input.expected.dynasty) };
    const expBody = normalizeChineseAnswer(input.expected.body);
    const stuBody = normalizeChineseAnswer(input.student.body);
    const body = { match: expBody === stuBody };
    const bodyDiff = body.match ? [] : diffChinese(expBody, stuBody);

    const isCorrect = author.match && dynasty.match && body.match;

    let errorBookId: number | undefined;
    if (!isCorrect) {
      errorBookId = await this.writeErrorBookOrReuse({
        studentId: input.studentId,
        subjectId: input.subjectId,
        questionId: input.questionId,
        source: 'dictation',
        sourceRefId: null,
      });
    } else {
      try {
        await this.mainErrorRepo.clearUnclearedByStudentQuestionId(input.studentId, input.questionId);
      } catch (err) {
        this.logger.error(`clearUnclearedByStudentQuestionId failed (student=${input.studentId}, question=${input.questionId}): ${err}`);
      }
    }

    return { questionId: q.id, isCorrect, method: 'exact', fields: { author, dynasty, body }, bodyDiff, errorBookId };
  }
```

- [ ] **Step 6: 运行测试确认通过**

```bash
cd apps/server && npx vitest run src/modules/practice/judge-core.dictation.test.ts
```

Expected: PASS，5 个用例全绿。

- [ ] **Step 7: 跑全量测试**

```bash
cd apps/server && npm test
```

Expected: 全绿。

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/modules/practice/judge-core.service.ts apps/server/src/modules/practice/judge-core.dictation.test.ts
git commit -m "feat(server): JudgeCore 新增语文默写纯程序判题分支"
```

---

## Task 8: TrainingService 三个方法与 DTO

**Files:**
- Create: `apps/server/src/modules/training/dto/dictation.dto.ts`
- Modify: `apps/server/src/modules/training/training.service.ts`
- Modify: `apps/server/src/modules/training/training.module.ts`
- Test: `apps/server/src/modules/training/training.dictation.test.ts`

**Interfaces:**
- Produces:
  - `export const CHINESE_SUBJECT_ID = 2;`
  - `TrainingService.listDictationPassages(): Promise<{ passages: DictationPassageListItem[] }>`
  - `TrainingService.startDictation(input: { studentId; semester: string | null; questionIds: number[] | null; count: number }): Promise<{ questions: DictationQuestionItem[] }>`
  - `TrainingService.judgeDictation(input: { studentId; questionId; author; dynasty; body }): Promise<DictationJudgeResult>`
  - `export function renderBodyDiff(ops: DictationDiffOp[]): string`

- [ ] **Step 1: 写失败测试**

创建 `apps/server/src/modules/training/training.dictation.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { TrainingService, CHINESE_SUBJECT_ID, renderBodyDiff } from './training.service';

const PASSAGE = {
  id: 1, question_id: 100, work_title: '静夜思', author: '李白', dynasty: '唐',
  body: '床前明月光，疑是地上霜。', grade_band: 'junior', grade: '九年级',
  semester: '上册', sort_order: 1, source_ref: 'DEV-FIXTURE', verified: 1,
  questionContent: '请默写《静夜思》（并写出作者与朝代）',
};

const WRONG_JUDGE = {
  questionId: 100, isCorrect: false, method: 'exact',
  fields: { author: { match: true }, dynasty: { match: true }, body: { match: false } },
  bodyDiff: [{ type: 'wrong', expected: '光', actual: '先' }],
  errorBookId: 555,
};

function makeService(overrides: { passage?: unknown; judgeResult?: unknown; feedback?: unknown } = {}) {
  const dictationRepo = {
    findByQuestionId: vi.fn().mockResolvedValue(overrides.passage === undefined ? PASSAGE : overrides.passage),
    findVerifiedBySubject: vi.fn().mockResolvedValue([PASSAGE]),
    findRandomVerified: vi.fn().mockResolvedValue([PASSAGE]),
    findVerifiedByQuestionIds: vi.fn().mockResolvedValue([PASSAGE]),
  };
  const judgeCore = { judgeDictation: vi.fn().mockResolvedValue(overrides.judgeResult ?? WRONG_JUDGE) };
  const dictationFeedback = {
    generate: vi.fn().mockImplementation(() => {
      if (overrides.feedback instanceof Error) return Promise.reject(overrides.feedback);
      return Promise.resolve({ content: overrides.feedback ?? '注意「月光」的「光」' });
    }),
  };
  const service = new TrainingService(
    {} as never, judgeCore as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never,
    dictationRepo as never, dictationFeedback as never,
  );
  return { service, dictationRepo, judgeCore, dictationFeedback };
}

describe('renderBodyDiff', () => {
  it('把 diff 渲染成可读文本', () => {
    expect(renderBodyDiff([
      { type: 'equal', text: '床前明月' },
      { type: 'wrong', expected: '光', actual: '先' },
      { type: 'missing', text: '疑' },
      { type: 'extra', text: '啊' },
    ])).toBe('床前明月[光→先][漏:疑][多:啊]');
  });
});

describe('TrainingService.listDictationPassages', () => {
  it('只返回白名单字段，不泄露正文', async () => {
    const { service } = makeService();
    const res = await service.listDictationPassages();
    expect(res.passages).toEqual([
      { questionId: 100, workTitle: '静夜思', author: '李白', dynasty: '唐', semester: '上册' },
    ]);
    expect(JSON.stringify(res)).not.toContain('床前明月光');
  });
});

describe('TrainingService.startDictation', () => {
  it('未指定篇目 → 随机抽，题项不含答案字段', async () => {
    const { service, dictationRepo } = makeService();
    const res = await service.startDictation({ studentId: 7, semester: '上册', questionIds: null, count: 5 });
    expect(dictationRepo.findRandomVerified).toHaveBeenCalledWith(7, CHINESE_SUBJECT_ID, '上册', 5);
    expect(res.questions).toEqual([
      { questionId: 100, prompt: '请默写《静夜思》（并写出作者与朝代）', workTitle: '静夜思', semester: '上册' },
    ]);
    expect(JSON.stringify(res)).not.toContain('李白');
    expect(JSON.stringify(res)).not.toContain('床前明月光');
  });

  it('指定篇目 → 走 findVerifiedByQuestionIds，并按 count 截断', async () => {
    const { service, dictationRepo } = makeService();
    const res = await service.startDictation({ studentId: 7, semester: null, questionIds: [100, 101], count: 1 });
    expect(dictationRepo.findVerifiedByQuestionIds).toHaveBeenCalledWith(CHINESE_SUBJECT_ID, [100, 101]);
    expect(res.questions).toHaveLength(1);
  });
});

describe('TrainingService.judgeDictation', () => {
  it('判错 → 附带 LLM 错因与参考答案', async () => {
    const { service, dictationFeedback } = makeService();
    const res = await service.judgeDictation({
      studentId: 7, questionId: 100, author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。',
    });
    expect(res.isCorrect).toBe(false);
    expect(res.feedback).toBe('注意「月光」的「光」');
    expect(res.reference).toEqual({ author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。' });
    expect(dictationFeedback.generate).toHaveBeenCalledOnce();
  });

  it('判对 → 不调用 LLM，feedback=null', async () => {
    const { service, dictationFeedback } = makeService({
      judgeResult: {
        questionId: 100, isCorrect: true, method: 'exact',
        fields: { author: { match: true }, dynasty: { match: true }, body: { match: true } },
        bodyDiff: [],
      },
    });
    const res = await service.judgeDictation({
      studentId: 7, questionId: 100, author: '李白', dynasty: '唐', body: '床前明月光，疑是地上霜。',
    });
    expect(res.isCorrect).toBe(true);
    expect(res.feedback).toBeNull();
    expect(dictationFeedback.generate).not.toHaveBeenCalled();
  });

  it('LLM 两个模型都失败 → 不阻断判题，feedback=null', async () => {
    const { service } = makeService({ feedback: new Error('all down') });
    const res = await service.judgeDictation({
      studentId: 7, questionId: 100, author: '李白', dynasty: '唐', body: '床前明月先，疑是地上霜。',
    });
    expect(res.isCorrect).toBe(false);
    expect(res.feedback).toBeNull();
  });

  it('篇目不存在 → 404', async () => {
    const { service } = makeService({ passage: null });
    await expect(
      service.judgeDictation({ studentId: 7, questionId: 999, author: '', dynasty: '', body: '' }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd apps/server && npx vitest run src/modules/training/training.dictation.test.ts
```

Expected: FAIL —— `service.listDictationPassages is not a function`。

- [ ] **Step 3: 写 DTO 文件**

创建 `apps/server/src/modules/training/dto/dictation.dto.ts`：

```ts
import type { DictationDiffOp } from '../../../common/utils/normalize-chinese.util.js';

/** 配置页篇目清单项（不含正文，防答案泄露）。 */
export interface DictationPassageListItem {
  questionId: number;
  workTitle: string;
  author: string;
  dynasty: string;
  semester: string;
}

/** 开练题项（不含作者/朝代/正文答案，防答案泄露）。 */
export interface DictationQuestionItem {
  questionId: number;
  prompt: string;
  workTitle: string;
  semester: string;
}

export interface DictationJudgeResult {
  questionId: number;
  isCorrect: boolean;
  fields: { author: { match: boolean }; dynasty: { match: boolean }; body: { match: boolean } };
  bodyDiff: DictationDiffOp[];
  reference: { author: string; dynasty: string; body: string };
  feedback: string | null;
  errorBookId?: number;
}
```

- [ ] **Step 4: 改 training.service.ts**

顶部追加导入：

```ts
import { DictationPassagesRepository } from '../../database/repositories/dictation-passages.repo.js';
import { DictationFeedbackCapability } from '../../ai-core/capabilities/dictation-feedback.capability.js';
import type { DictationDiffOp } from '../../common/utils/normalize-chinese.util.js';
import type {
  DictationPassageListItem,
  DictationQuestionItem,
  DictationJudgeResult,
} from './dto/dictation.dto.js';
```

class 之前加常量：

```ts
/** 语文学科 id（subjects seed：1=数学, 2=语文, 3=英语）。 */
export const CHINESE_SUBJECT_ID = 2;

/** 把 diff 渲染成一行可读文本，作为 LLM 错因输入：床前明月[光→先][漏:疑][多:啊]。 */
export function renderBodyDiff(ops: DictationDiffOp[]): string {
  return ops
    .map((op) => {
      if (op.type === 'equal') return op.text;
      if (op.type === 'wrong') return `[${op.expected}→${op.actual}]`;
      if (op.type === 'missing') return `[漏:${op.text}]`;
      return `[多:${op.text}]`;
    })
    .join('');
}
```

构造函数末尾追加两个依赖：

```ts
    private readonly dictationRepo: DictationPassagesRepository,
    private readonly dictationFeedback: DictationFeedbackCapability,
```

在 `judgeTraining` 之后插入三个方法：

```ts
  /** 语文默写：配置页篇目清单（只出 verified=1，已停用的题不出）。 */
  async listDictationPassages(): Promise<{ passages: DictationPassageListItem[] }> {
    const rows = await this.dictationRepo.findVerifiedBySubject(CHINESE_SUBJECT_ID);
    return {
      passages: rows.map((r) => ({
        questionId: r.question_id,
        workTitle: r.work_title,
        author: r.author,
        dynasty: r.dynasty,
        semester: r.semester,
      })),
    };
  }

  /**
   * 语文默写开练：指定篇目则按篇目出题（忽略册次），否则按册次（null=全部）随机抽。
   * 题项做白名单序列化——只出 questionId/prompt/workTitle/semester，作者/朝代/正文
   * 一律剥离（防答案泄露，与 startTargetedPractice 同规矩）。
   */
  async startDictation(input: {
    studentId: number;
    semester: string | null;
    questionIds: number[] | null;
    count: number;
  }): Promise<{ questions: DictationQuestionItem[] }> {
    const rows = input.questionIds && input.questionIds.length > 0
      ? await this.dictationRepo.findVerifiedByQuestionIds(CHINESE_SUBJECT_ID, input.questionIds)
      : await this.dictationRepo.findRandomVerified(
          input.studentId, CHINESE_SUBJECT_ID, input.semester, input.count,
        );
    return {
      questions: rows.slice(0, input.count).map((r) => ({
        questionId: r.question_id,
        prompt: r.questionContent,
        workTitle: r.work_title,
        semester: r.semester,
      })),
    };
  }

  /**
   * 语文默写判题：程序判对错（JudgeCore.judgeDictation）+ 错因文案（LLM，可选）。
   * LLM 失败只丢文案、不丢判题结果（设计 spec §5 第 5 步）。
   */
  async judgeDictation(input: {
    studentId: number;
    questionId: number;
    author: string;
    dynasty: string;
    body: string;
  }): Promise<DictationJudgeResult> {
    const passage = await this.dictationRepo.findByQuestionId(input.questionId);
    if (!passage) {
      throw new NotFoundException(`默写篇目不存在：${input.questionId}`);
    }

    const expected = { author: passage.author, dynasty: passage.dynasty, body: passage.body };
    const judged = await this.judgeCore.judgeDictation({
      studentId: input.studentId,
      subjectId: CHINESE_SUBJECT_ID,
      questionId: input.questionId,
      expected,
      student: { author: input.author, dynasty: input.dynasty, body: input.body },
    });

    let feedback: string | null = null;
    if (!judged.isCorrect) {
      try {
        const result = await this.dictationFeedback.generate({
          workTitle: passage.work_title,
          expected,
          student: { author: input.author, dynasty: input.dynasty, body: input.body },
          fieldMatch: {
            author: judged.fields.author.match,
            dynasty: judged.fields.dynasty.match,
            body: judged.fields.body.match,
          },
          bodyDiffText: renderBodyDiff(judged.bodyDiff),
        });
        feedback = result.content || null;
      } catch (err) {
        this.logger.warn(`dictationFeedback.generate failed (questionId=${input.questionId}): ${err}`);
      }
    }

    // 显式构造返回，不用 spread：judged 带 method 字段，spread 进对象字面量会触发
    // TS 多余属性检查（DictationJudgeResult 未声明 method）。
    return {
      questionId: judged.questionId,
      isCorrect: judged.isCorrect,
      fields: judged.fields,
      bodyDiff: judged.bodyDiff,
      errorBookId: judged.errorBookId,
      reference: expected,
      feedback,
    };
  }
```

- [ ] **Step 5: 改 training.module.ts**

追加导入：

```ts
import { DictationPassagesRepository } from '../../database/repositories/index.js';
import { DictationFeedbackCapability } from '../../ai-core/capabilities/dictation-feedback.capability.js';
```

`providers` 数组追加 `DictationPassagesRepository, DictationFeedbackCapability`。

- [ ] **Step 6: 运行测试确认通过**

```bash
cd apps/server && npx vitest run src/modules/training/training.dictation.test.ts
```

Expected: PASS，9 个用例全绿。

- [ ] **Step 7: 类型检查 + 全量测试**

```bash
cd apps/server && npm run build && npm test
```

Expected: 两者都通过。

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/modules/training/dto/dictation.dto.ts apps/server/src/modules/training/training.service.ts apps/server/src/modules/training/training.dictation.test.ts apps/server/src/modules/training/training.module.ts
git commit -m "feat(server): 语文默写 service（篇目清单/开练/判题+错因）"
```

---

## Task 9: TrainingController 三个端点

**Files:**
- Modify: `apps/server/src/modules/training/training.controller.ts`
- Test: `apps/server/src/modules/training/training.controller.dictation.test.ts`

**Interfaces:**
- Consumes: `TrainingService.listDictationPassages / startDictation / judgeDictation`（Task 8）
- Produces:
  - `GET /api/training/dictation/passages`
  - `POST /api/training/dictation/start`，body `{ semester: '上册'|'下册'|null, questionIds: number[]|null, count: 1..20 }`
  - `POST /api/training/dictation/judge`，body `{ questionId: number, author: string, dynasty: string, body: string }`

- [ ] **Step 1: 写失败测试**

创建 `apps/server/src/modules/training/training.controller.dictation.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { TrainingController } from './training.controller';

function makeController() {
  const service = {
    listDictationPassages: vi.fn().mockResolvedValue({ passages: [] }),
    startDictation: vi.fn().mockResolvedValue({ questions: [] }),
    judgeDictation: vi.fn().mockResolvedValue({ isCorrect: true, feedback: null }),
  };
  return { controller: new TrainingController(service as never), service };
}

const USER = { sub: 7, role: 'student' } as never;

describe('TrainingController dictation 端点', () => {
  it('GET dictation/passages → 透传 service', async () => {
    const { controller, service } = makeController();
    const res = await controller.listDictationPassages();
    expect(service.listDictationPassages).toHaveBeenCalledOnce();
    expect(res).toEqual({ passages: [] });
  });

  it('POST dictation/start：count 越界 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.startDictation({ semester: null, questionIds: null, count: 0 }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.startDictation({ semester: null, questionIds: null, count: 21 }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/start：semester 非法 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.startDictation({ semester: '上学期', questionIds: null, count: 5 }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/start：questionIds 含非法值 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.startDictation({ semester: null, questionIds: [0], count: 5 }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/start：合法入参 → 透传 studentId', async () => {
    const { controller, service } = makeController();
    await controller.startDictation({ semester: '上册', questionIds: null, count: 5 }, USER);
    expect(service.startDictation).toHaveBeenCalledWith({
      studentId: 7, semester: '上册', questionIds: null, count: 5,
    });
  });

  it('POST dictation/judge：questionId 非正整数 → 400', async () => {
    const { controller } = makeController();
    await expect(
      controller.judgeDictation({ questionId: 0, author: '', dynasty: '', body: '' }, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('POST dictation/judge：缺字段按空串处理并透传 studentId', async () => {
    const { controller, service } = makeController();
    await controller.judgeDictation({ questionId: 100 } as never, USER);
    expect(service.judgeDictation).toHaveBeenCalledWith({
      studentId: 7, questionId: 100, author: '', dynasty: '', body: '',
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd apps/server && npx vitest run src/modules/training/training.controller.dictation.test.ts
```

Expected: FAIL —— `controller.listDictationPassages is not a function`。

- [ ] **Step 3: 加端点**

在 `startTargetedPractice` 方法之后插入：

```ts
  // ==================== 语文古诗文默写（2026-09-13） ====================

  /** 语文默写篇目清单（配置页用；只出已校验篇目，不含正文）。 */
  @Get('dictation/passages')
  async listDictationPassages() {
    return this.trainingService.listDictationPassages();
  }

  /** 语文默写开练：count 限 1-20；semester 限 上册|下册|null；
   *  questionIds 非空时按指定篇目出题（忽略 semester）。 */
  @Post('dictation/start')
  async startDictation(
    @Body() dto: { semester: string | null; questionIds: number[] | null; count: number },
    @CurrentUser() user: JwtUser,
  ) {
    const { count } = dto;
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new BadRequestException('count 仅允许 1-20 的整数');
    }
    const semester = dto.semester ?? null;
    if (semester !== null && semester !== '上册' && semester !== '下册') {
      throw new BadRequestException('semester 仅允许 上册 | 下册 | null');
    }
    const questionIds = dto.questionIds ?? null;
    if (questionIds !== null &&
        (!Array.isArray(questionIds) || questionIds.some((id) => !Number.isInteger(id) || id < 1))) {
      throw new BadRequestException('questionIds 须为正整数数组或 null');
    }
    return this.trainingService.startDictation({
      studentId: user.sub,
      semester,
      questionIds,
      count,
    });
  }

  /** 语文默写判题：三字段作答；程序判对错 + LLM 写错因（LLM 失败不影响判题）。 */
  @Post('dictation/judge')
  async judgeDictation(
    @Body() dto: { questionId: number; author: string; dynasty: string; body: string },
    @CurrentUser() user: JwtUser,
  ) {
    if (!Number.isInteger(dto.questionId) || dto.questionId < 1) {
      throw new BadRequestException('questionId 须为正整数');
    }
    return this.trainingService.judgeDictation({
      studentId: user.sub,
      questionId: dto.questionId,
      author: dto.author ?? '',
      dynasty: dto.dynasty ?? '',
      body: dto.body ?? '',
    });
  }
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd apps/server && npx vitest run src/modules/training/training.controller.dictation.test.ts
```

Expected: PASS，7 个用例全绿。

- [ ] **Step 5: 跑全量测试 + 构建**

```bash
cd apps/server && npm test && npm run build
```

Expected: 都通过。

- [ ] **Step 6: 手动验证端点已挂载**

```bash
cd apps/server && (npx tsx src/main.ts &) && sleep 4
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/training/dictation/passages
pkill -f "tsx src/main.ts"
```

Expected: `401`（未带 JWT，说明路由存在且被鉴权守卫拦住；若 `404` 说明端点没挂上）。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/modules/training/training.controller.ts apps/server/src/modules/training/training.controller.dictation.test.ts
git commit -m "feat(server): 新增语文默写三端点（篇目清单/开练/判题）"
```

---

## Task 10: 前端 API 层

**Files:**
- Modify: `apps/web/src/services/api.ts`（在 hidden 清单函数之后追加，约 978 行后）

**Interfaces:**
- Produces:
  - `interface DictationPassageItem { questionId; workTitle; author; dynasty; semester: string }`
  - `interface DictationQuestionItem { questionId; prompt; workTitle; semester: string }`
  - `type DictationDiffOp`（与后端同形）
  - `interface DictationJudgeResult { questionId; isCorrect; fields; bodyDiff; reference; feedback: string | null; errorBookId? }`
  - `fetchDictationPassages()`
  - `startDictation(payload)`
  - `judgeDictation(payload)`

- [ ] **Step 1: 追加类型与函数**

```ts
// --- Training · 语文古诗文默写（2026-09-13） ---

export interface DictationPassageItem {
  questionId: number;
  workTitle: string;
  author: string;
  dynasty: string;
  semester: string;
}

export interface DictationQuestionItem {
  questionId: number;
  prompt: string;
  workTitle: string;
  semester: string;
}

export type DictationDiffOp =
  | { type: 'equal'; text: string }
  | { type: 'wrong'; expected: string; actual: string }
  | { type: 'missing'; text: string }
  | { type: 'extra'; text: string };

export interface DictationJudgeResult {
  questionId: number;
  isCorrect: boolean;
  fields: { author: { match: boolean }; dynasty: { match: boolean }; body: { match: boolean } };
  bodyDiff: DictationDiffOp[];
  reference: { author: string; dynasty: string; body: string };
  /** LLM 生成的错因文案；模型不可用时为 null（判题结果仍有效）。 */
  feedback: string | null;
  errorBookId?: number;
}

export function fetchDictationPassages(): Promise<{ passages: DictationPassageItem[] }> {
  return fetchApi<{ passages: DictationPassageItem[] }>('/training/dictation/passages');
}

export function startDictation(payload: {
  semester: string | null;
  questionIds: number[] | null;
  count: number;
}): Promise<{ questions: DictationQuestionItem[] }> {
  return fetchApi<{ questions: DictationQuestionItem[] }>('/training/dictation/start', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function judgeDictation(payload: {
  questionId: number;
  author: string;
  dynasty: string;
  body: string;
}): Promise<DictationJudgeResult> {
  return fetchApi<DictationJudgeResult>('/training/dictation/judge', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
```

- [ ] **Step 2: 类型检查**

```bash
cd apps/web && npx tsc -b --noEmit
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/services/api.ts
git commit -m "feat(web): 新增语文默写 API（篇目清单/开练/判题）"
```

---

## Task 11: 语文专项页（两卡）

**Files:**
- Create: `apps/web/src/pages/student/training/chinese/ChineseSpecialPage.tsx`
- Modify: `apps/web/src/routes/index.tsx`

**Interfaces:**
- Produces: 路由 `/student/training/chinese/special`；「古诗文默写」卡跳 `/student/training/chinese/dictation`；「古诗文解释」为禁用态

- [ ] **Step 1: 写页面**

创建 `apps/web/src/pages/student/training/chinese/ChineseSpecialPage.tsx`：

```tsx
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/base';

/** 默写：书卷（线性 SVG）。 */
const ScrollIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3Z" />
    <path d="M8 4v13a3 3 0 0 0 3 3" />
    <path d="M11 9h5M11 13h5" />
  </svg>
);

/** 解释：批注（线性 SVG）。 */
const AnnotateIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M4 5h16M4 10h10M4 15h7" />
    <path d="M14 19l5-5-2-2-5 5v2Z" />
  </svg>
);

const CARD_CLASS =
  'h-64 rounded-3xl bg-white p-8 flex flex-col items-center justify-center gap-4 transition-all duration-300';

/**
 * 语文专项页：两张卡并列，古诗文默写已开放，古诗文解释敬请期待。
 * 样式复刻 TrainingHomePage 的卡片语言（style.md §2.7）。
 */
export default function ChineseSpecialPage() {
  const navigate = useNavigate();

  return (
    <div
      data-theme="student-day"
      className="min-h-screen flex flex-col items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-4xl px-4 sm:px-8">
        <PageHeader
          to="/student/training"
          caption="返回选学科"
          title="语文 · 专项"
          titleClassName="text-4xl font-extrabold"
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-12">
          <button
            onClick={() => navigate('/student/training/chinese/dictation')}
            className={`${CARD_CLASS} hover:-translate-y-1 focus:outline-none focus:ring-4 focus:ring-[var(--brand-500)]/20`}
            style={{ border: '1px solid rgba(226, 232, 240, 0.8)', boxShadow: 'var(--shadow-card)' }}
            onMouseEnter={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-elevated)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-card)'; }}
            aria-label="进入古诗文默写"
          >
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center text-white shadow-sm"
              style={{ background: 'linear-gradient(to top right, #FF6B35, #FFB25A)' }}
              aria-hidden="true"
            >
              <ScrollIcon />
            </div>
            <span className="text-3xl font-black tracking-tight text-[var(--text-primary)]">古诗文默写</span>
            <span className="text-sm text-[var(--text-secondary)]">整篇默写 · 自动判对错</span>
          </button>

          <div
            className={`relative ${CARD_CLASS} opacity-50 cursor-not-allowed`}
            style={{ border: '1px solid rgb(241, 245, 249)', backgroundColor: 'rgba(248, 250, 252, 0.3)' }}
            aria-label="古诗文解释暂未开放"
          >
            <span className="absolute top-4 right-4 px-2.5 py-1 text-xs font-medium rounded-full text-[var(--text-secondary)] bg-[var(--bg-subtle)]">
              敬请期待
            </span>
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center text-slate-500 shadow-sm"
              style={{ background: 'linear-gradient(to top right, #f1f5f9, #e2e8f0)' }}
              aria-hidden="true"
            >
              <AnnotateIcon />
            </div>
            <span className="text-3xl font-black tracking-tight text-slate-500">古诗文解释</span>
            <span className="text-sm text-slate-400">字词释义 · 情感分析</span>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 加路由**

`apps/web/src/routes/index.tsx` 顶部 import 区加：

```tsx
import ChineseSpecialPage from '@/pages/student/training/chinese/ChineseSpecialPage';
```

在 `/student/training/targeted/hidden` 路由对象之后追加：

```tsx
  // 语文专项页（全屏沉浸层，独立于 StudentLayout；仅「古诗文默写」开放）
  {
    path: '/student/training/chinese/special',
    element: (
      <RequireRole role="student">
        <ChineseSpecialPage />
      </RequireRole>
    ),
  },
```

- [ ] **Step 3: 类型检查 + lint**

```bash
cd apps/web && npx tsc -b --noEmit && npm run lint
```

Expected: 无错误。

- [ ] **Step 4: 目视验证**

```bash
cd apps/web && npm run dev
```

打开 `http://localhost:5173/student/training/chinese/special`（需登录学生账号）。
Expected: 两卡并列；「古诗文默写」可点，「古诗文解释」灰化带「敬请期待」角标；无 emoji。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/student/training/chinese/ChineseSpecialPage.tsx apps/web/src/routes/index.tsx
git commit -m "feat(web): 新增语文专项页（默写/解释两卡）"
```

---

## Task 12: 默写配置页

**Files:**
- Create: `apps/web/src/pages/student/training/chinese/DictationConfigPage.tsx`
- Modify: `apps/web/src/routes/index.tsx`

**Interfaces:**
- Consumes: `fetchDictationPassages`、`startDictation`（Task 10）
- Produces: 路由 `/student/training/chinese/dictation`；开练成功后把题单写入 `sessionStorage['training:dictation']` 并跳 `/student/training/chinese/dictation/run`（镜像 `TargetedConfigPage`）

- [ ] **Step 1: 写页面**

创建 `apps/web/src/pages/student/training/chinese/DictationConfigPage.tsx`：

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/base';
import { fetchDictationPassages, startDictation, type DictationPassageItem } from '@/services/api';

/** 题量档（与数学专项一致）。 */
const COUNT_OPTIONS = [3, 5, 8, 10];

/** 范围档：value 即传给后端的 semester；'全部' 传 null。 */
const RANGE_OPTIONS: Array<{ label: string; value: string | null }> = [
  { label: '全部', value: null },
  { label: '上册', value: '上册' },
  { label: '下册', value: '下册' },
];

const PILL_BASE = 'px-5 py-2.5 rounded-full text-sm font-medium transition-colors';
const CARD_BORDER = { border: '1px solid rgba(226, 232, 240, 0.8)' } as const;

/**
 * 古诗文默写配置页：范围（上册/下册/全部）+ 题量 + 可选指定篇目。
 * 选题方式为「随机抽 + 可指定篇目」（设计 spec §3 决策 8）。
 */
export default function DictationConfigPage() {
  const navigate = useNavigate();
  const [passages, setPassages] = useState<DictationPassageItem[]>([]);
  const [range, setRange] = useState<string | null>(null);
  const [count, setCount] = useState<number>(5);
  const [picked, setPicked] = useState<number[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDictationPassages()
      .then((res) => { if (!cancelled) setPassages(res.passages); })
      .catch(() => { if (!cancelled) setError('篇目加载失败，请稍后重试'); });
    return () => { cancelled = true; };
  }, []);

  const visible = useMemo(
    () => (range == null ? passages : passages.filter((p) => p.semester === range)),
    [passages, range],
  );

  const togglePick = (questionId: number) => {
    setPicked((prev) =>
      prev.includes(questionId) ? prev.filter((x) => x !== questionId) : [...prev, questionId],
    );
  };

  const handleStart = async () => {
    setLoading(true);
    setError(null);
    try {
      const usePicked = picked.length > 0;
      const res = await startDictation({
        semester: usePicked ? null : range,
        questionIds: usePicked ? picked : null,
        count,
      });
      if (res.questions.length === 0) {
        setError('这个范围内暂时没有可练的篇目');
        setLoading(false);
        return;
      }
      sessionStorage.setItem('training:dictation', JSON.stringify(res.questions));
      navigate('/student/training/chinese/dictation/run');
    } catch {
      setError('开练失败，请稍后重试');
      setLoading(false);
    }
  };

  return (
    <div
      data-theme="student-day"
      className="min-h-screen flex flex-col items-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-3xl px-4 sm:px-8 py-10">
        <PageHeader
          to="/student/training/chinese/special"
          caption="返回语文专项"
          title="古诗文默写"
          titleClassName="text-4xl font-extrabold"
        />

        {/* 范围 */}
        <section className="mt-10">
          <h2 className="text-lg font-bold text-[var(--text-primary)]">选择范围</h2>
          <div className="flex flex-wrap gap-3 mt-3">
            {RANGE_OPTIONS.map((opt) => {
              const active = range === opt.value;
              return (
                <button
                  key={opt.label}
                  onClick={() => { setRange(opt.value); setPicked([]); }}
                  className={`${PILL_BASE} ${active ? 'text-white' : 'bg-white text-[var(--text-secondary)]'}`}
                  style={active ? { backgroundColor: 'var(--brand-500)' } : CARD_BORDER}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </section>

        {/* 题量 */}
        <section className="mt-8">
          <h2 className="text-lg font-bold text-[var(--text-primary)]">练几篇</h2>
          <div className="flex flex-wrap gap-3 mt-3">
            {COUNT_OPTIONS.map((n) => {
              const active = count === n;
              return (
                <button
                  key={n}
                  onClick={() => setCount(n)}
                  className={`w-16 h-11 rounded-xl text-sm font-medium transition-colors ${
                    active ? 'text-white' : 'bg-white text-[var(--text-secondary)]'
                  }`}
                  style={active ? { backgroundColor: 'var(--brand-500)' } : CARD_BORDER}
                >
                  {n} 篇
                </button>
              );
            })}
          </div>
        </section>

        {/* 指定篇目（可折叠） */}
        <section className="mt-8">
          <button
            onClick={() => setListOpen((v) => !v)}
            className="flex items-center gap-2 text-lg font-bold text-[var(--text-primary)]"
            aria-expanded={listOpen}
          >
            指定篇目（不选则随机抽）
            <span className="text-sm font-normal text-[var(--text-secondary)]">
              {listOpen ? '收起' : '展开'}
            </span>
          </button>

          {listOpen && (
            <div className="mt-3 rounded-2xl bg-white p-4" style={CARD_BORDER}>
              {visible.length === 0 ? (
                <p className="text-sm text-[var(--text-secondary)]">该范围内暂无篇目</p>
              ) : (
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {visible.map((p) => (
                    <li key={p.questionId}>
                      <label className="flex items-center gap-3 px-3 py-2 rounded-xl cursor-pointer hover:bg-[var(--bg-subtle)]">
                        <input
                          type="checkbox"
                          checked={picked.includes(p.questionId)}
                          onChange={() => togglePick(p.questionId)}
                          className="w-4 h-4"
                        />
                        <span className="text-sm text-[var(--text-primary)]">
                          《{p.workTitle}》
                          <span className="text-[var(--text-secondary)]">
                            {' '}{p.author} · {p.dynasty}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        {error && <p className="mt-6 text-sm text-red-500">{error}</p>}

        <button
          onClick={handleStart}
          disabled={loading}
          className="mt-10 w-full h-14 rounded-2xl text-white text-lg font-bold transition-opacity disabled:opacity-60"
          style={{ backgroundColor: 'var(--brand-500)' }}
        >
          {loading ? '正在抽题…' : picked.length > 0 ? `开始默写（指定 ${picked.length} 篇）` : `开始默写（随机 ${count} 篇）`}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 加路由**

`apps/web/src/routes/index.tsx` 顶部加 import：

```tsx
import DictationConfigPage from '@/pages/student/training/chinese/DictationConfigPage';
```

在 `/student/training/chinese/special` 路由对象之后追加：

```tsx
  // 语文默写配置页（全屏沉浸层；题单经 sessionStorage 交接）
  {
    path: '/student/training/chinese/dictation',
    element: (
      <RequireRole role="student">
        <DictationConfigPage />
      </RequireRole>
    ),
  },
```

- [ ] **Step 3: 类型检查 + lint**

```bash
cd apps/web && npx tsc -b --noEmit && npm run lint
```

Expected: 无错误。

- [ ] **Step 4: 目视验证**

```bash
cd apps/web && npm run dev
```

打开 `/student/training/chinese/dictation`。
Expected: 能选范围与题量；展开后列出《静夜思》《登鹳雀楼》（dev 假数据）；勾选后按钮文案变为「开始默写（指定 N 篇）」。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/student/training/chinese/DictationConfigPage.tsx apps/web/src/routes/index.tsx
git commit -m "feat(web): 新增语文默写配置页（范围/题量/指定篇目）"
```

---

## Task 13: 差异高亮组件

**Files:**
- Create: `apps/web/src/components/business/dictation/DictationDiffView.tsx`

**Interfaces:**
- Consumes: `DictationDiffOp`（Task 10）
- Produces: `<DictationDiffView ops={DictationDiffOp[]} />`——按 op 类型着色渲染逐字对比

- [ ] **Step 1: 写组件**

创建 `apps/web/src/components/business/dictation/DictationDiffView.tsx`：

```tsx
import type { DictationDiffOp } from '@/services/api';

interface Props {
  ops: DictationDiffOp[];
  className?: string;
}

/**
 * 正文逐字差异展示：正确字符为默认色，错字/漏字标红，多字标橙并带删除线。
 * 差异以「忽略标点与空格」后的文本对比（与判对错口径一致，设计 spec §5）。
 */
export default function DictationDiffView({ ops, className = '' }: Props) {
  return (
    <p className={`text-lg leading-loose tracking-wide text-[var(--text-primary)] ${className}`}>
      {ops.map((op, i) => {
        if (op.type === 'equal') {
          return <span key={i}>{op.text}</span>;
        }
        if (op.type === 'wrong') {
          return (
            <span key={i} className="inline-flex items-baseline">
              <span className="text-red-500 font-bold underline decoration-wavy">{op.actual}</span>
              <span className="mx-0.5 text-xs text-[var(--text-secondary)]">应为</span>
              <span className="text-green-600 font-bold">{op.expected}</span>
            </span>
          );
        }
        if (op.type === 'missing') {
          return (
            <span key={i} className="text-red-500 font-bold">
              <span className="text-xs text-[var(--text-secondary)] mr-0.5">漏</span>
              {op.text}
            </span>
          );
        }
        return (
          <span key={i} className="text-orange-500 line-through">
            <span className="text-xs text-[var(--text-secondary)] mr-0.5 no-underline">多</span>
            {op.text}
          </span>
        );
      })}
    </p>
  );
}
```

- [ ] **Step 2: 类型检查 + lint**

```bash
cd apps/web && npx tsc -b --noEmit && npm run lint
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/business/dictation/DictationDiffView.tsx
git commit -m "feat(web): 新增默写正文差异高亮组件"
```

---

## Task 14: 默写答题页（含三字段作答表单）

**Files:**
- Create: `apps/web/src/components/business/dictation/DictationAnswerForm.tsx`
- Create: `apps/web/src/pages/student/training/chinese/DictationRunPage.tsx`
- Modify: `apps/web/src/routes/index.tsx`

**Interfaces:**
- Consumes: `judgeDictation`、`DictationQuestionItem`、`DictationJudgeResult`（Task 10）；`DictationDiffView`（Task 13）
- Produces:
  - `<DictationAnswerForm value={{author,dynasty,body}} onChange={...} disabled={boolean} />`
  - 路由 `/student/training/chinese/dictation/run`；读 `sessionStorage['training:dictation']`，空题单踢回配置页

- [ ] **Step 1: 写作答表单组件**

创建 `apps/web/src/components/business/dictation/DictationAnswerForm.tsx`：

```tsx
export interface DictationAnswerValue {
  author: string;
  dynasty: string;
  body: string;
}

interface Props {
  value: DictationAnswerValue;
  onChange: (next: DictationAnswerValue) => void;
  /** 提交后锁定输入 */
  disabled?: boolean;
}

const FIELD_BORDER = { border: '1px solid rgba(226, 232, 240, 0.8)' } as const;

/** 三字段作答（作者 / 朝代 / 正文）——设计 spec §3 决策 5。 */
export default function DictationAnswerForm({ value, onChange, disabled = false }: Props) {
  const shortInputClass =
    'w-full h-12 px-4 rounded-xl bg-white text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30 disabled:opacity-70';

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-bold text-[var(--text-primary)]">作者</span>
          <input
            className={shortInputClass}
            style={FIELD_BORDER}
            value={value.author}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, author: e.target.value })}
            placeholder="例如：范仲淹"
          />
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm font-bold text-[var(--text-primary)]">朝代</span>
          <input
            className={shortInputClass}
            style={FIELD_BORDER}
            value={value.dynasty}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, dynasty: e.target.value })}
            placeholder="例如：宋"
          />
        </label>
      </div>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-bold text-[var(--text-primary)]">正文</span>
        <textarea
          className="w-full min-h-[220px] p-4 rounded-xl bg-white text-[var(--text-primary)] leading-loose outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30 disabled:opacity-70"
          style={FIELD_BORDER}
          value={value.body}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, body: e.target.value })}
          placeholder="默写整篇正文（标点与空格不计）"
        />
      </label>
    </div>
  );
}
```

- [ ] **Step 2: 写答题页**

创建 `apps/web/src/pages/student/training/chinese/DictationRunPage.tsx`：

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/base';
import {
  judgeDictation,
  type DictationJudgeResult,
  type DictationQuestionItem,
} from '@/services/api';
import DictationAnswerForm, { type DictationAnswerValue } from '@/components/business/dictation/DictationAnswerForm';
import DictationDiffView from '@/components/business/dictation/DictationDiffView';

const EMPTY: DictationAnswerValue = { author: '', dynasty: '', body: '' };

/**
 * 古诗文默写答题页。题单经 sessionStorage 交接（镜像 TargetedRunPage）；
 * 空题单直接踢回配置页。判题由后端程序比对，错因文案来自 LLM（可能为 null）。
 */
export default function DictationRunPage() {
  const navigate = useNavigate();
  const [questions, setQuestions] = useState<DictationQuestionItem[] | null>(null);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState<DictationAnswerValue>(EMPTY);
  const [result, setResult] = useState<DictationJudgeResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correctCount, setCorrectCount] = useState(0);

  // 读题单（StrictMode 下 effect 会跑两次，读后即删须防第二次读到空）
  useEffect(() => {
    const raw = sessionStorage.getItem('training:dictation');
    if (!raw) {
      navigate('/student/training/chinese/dictation', { replace: true });
      return;
    }
    try {
      const parsed = JSON.parse(raw) as DictationQuestionItem[];
      if (parsed.length === 0) {
        navigate('/student/training/chinese/dictation', { replace: true });
        return;
      }
      setQuestions(parsed);
    } catch {
      navigate('/student/training/chinese/dictation', { replace: true });
    }
  }, [navigate]);

  const current = questions?.[index] ?? null;
  const isLast = questions != null && index === questions.length - 1;

  const handleSubmit = async () => {
    if (!current) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await judgeDictation({ questionId: current.questionId, ...answer });
      setResult(res);
      if (res.isCorrect) setCorrectCount((n) => n + 1);
    } catch {
      setError('判题失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const handleNext = () => {
    if (!isLast) {
      setIndex((i) => i + 1);
      setAnswer(EMPTY);
      setResult(null);
      setError(null);
      return;
    }
    sessionStorage.removeItem('training:dictation');
    navigate('/student/training/chinese/special', { replace: true });
  };

  const progressText = useMemo(
    () => (questions ? `第 ${index + 1} / ${questions.length} 篇` : ''),
    [questions, index],
  );

  if (!current) return null;

  return (
    <div
      data-theme="student-day"
      className="min-h-screen flex flex-col items-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-3xl px-4 sm:px-8 py-10">
        <PageHeader
          to="/student/training/chinese/dictation"
          caption="退出本次练习"
          title="古诗文默写"
          titleClassName="text-4xl font-extrabold"
        />

        <p className="mt-6 text-sm text-[var(--text-secondary)]">
          {progressText}　已答对 {correctCount} 篇
        </p>

        <h2 className="mt-4 text-2xl font-black text-[var(--text-primary)]">{current.prompt}</h2>

        <div className="mt-6">
          <DictationAnswerForm value={answer} onChange={setAnswer} disabled={result != null} />
        </div>

        {error && <p className="mt-4 text-sm text-red-500">{error}</p>}

        {result == null ? (
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="mt-8 w-full h-14 rounded-2xl text-white text-lg font-bold disabled:opacity-60"
            style={{ backgroundColor: 'var(--brand-500)' }}
          >
            {submitting ? '正在判题…' : '提交'}
          </button>
        ) : (
          <div className="mt-8 rounded-2xl bg-white p-6" style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}>
            <p className={`text-xl font-black ${result.isCorrect ? 'text-green-600' : 'text-red-500'}`}>
              {result.isCorrect ? '全部正确' : '有错误'}
            </p>

            {!result.isCorrect && (
              <>
                <ul className="mt-4 flex flex-col gap-2 text-sm">
                  <li className="text-[var(--text-secondary)]">
                    作者：{result.fields.author.match ? '正确' : `错误，应为 ${result.reference.author}`}
                  </li>
                  <li className="text-[var(--text-secondary)]">
                    朝代：{result.fields.dynasty.match ? '正确' : `错误，应为 ${result.reference.dynasty}`}
                  </li>
                  <li className="text-[var(--text-secondary)]">
                    正文：{result.fields.body.match ? '正确' : '有出入（见下方对比）'}
                  </li>
                </ul>

                {!result.fields.body.match && (
                  <div className="mt-5">
                    <p className="text-sm font-bold text-[var(--text-primary)]">正文对比（忽略标点与空格）</p>
                    <div className="mt-2">
                      <DictationDiffView ops={result.bodyDiff} />
                    </div>
                    <p className="mt-3 text-sm text-[var(--text-secondary)]">
                      正确正文：{result.reference.body}
                    </p>
                  </div>
                )}

                <div className="mt-5 border-t border-slate-100 pt-4">
                  <p className="text-sm font-bold text-[var(--text-primary)]">错因提醒</p>
                  <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    {result.feedback ?? '暂时无法生成错因提醒，先对照上面的正文对比改一改。'}
                  </p>
                </div>
              </>
            )}

            <button
              onClick={handleNext}
              className="mt-6 w-full h-12 rounded-2xl text-white font-bold"
              style={{ backgroundColor: 'var(--brand-500)' }}
            >
              {isLast ? '完成' : '下一篇'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 加路由**

`apps/web/src/routes/index.tsx` 加 import：

```tsx
import DictationRunPage from '@/pages/student/training/chinese/DictationRunPage';
```

在 `/student/training/chinese/dictation` 路由对象之后追加：

```tsx
  // 语文默写答题页（全屏沉浸层；空题单自动踢回配置页）
  {
    path: '/student/training/chinese/dictation/run',
    element: (
      <RequireRole role="student">
        <DictationRunPage />
      </RequireRole>
    ),
  },
```

- [ ] **Step 4: 类型检查 + lint**

```bash
cd apps/web && npx tsc -b --noEmit && npm run lint
```

Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/business/dictation/DictationAnswerForm.tsx apps/web/src/pages/student/training/chinese/DictationRunPage.tsx apps/web/src/routes/index.tsx
git commit -m "feat(web): 新增语文默写答题页（三字段作答 + 差异高亮 + 错因）"
```

---

## Task 15: 训练学科选择页开放语文

**Files:**
- Modify: `apps/web/src/pages/student/TrainingSubjectPage.tsx`

**Interfaces:**
- Consumes: 路由 `/student/training/chinese/special`（Task 11）、原数学路由 `/student/training/home`（既有）
- Produces: `TrainingSubjectPage` 语文 `enabled:true`，`handleSelect` 按学科跳转

- [ ] **Step 1: 改学科表**

`apps/web/src/pages/student/TrainingSubjectPage.tsx:12-16` 改为：

```tsx
// id 对应 subjects 表 seed（1=数学, 2=语文, 3=英语）；语文已开放古诗文默写专项
const SUBJECTS: TrainingSubject[] = [
  { id: 1, name: '数学', enabled: true, desc: '考试 / 专项练习 / 错题练习' },
  { id: 2, name: '语文', enabled: true, desc: '古诗文默写' },
  { id: 3, name: '英语', enabled: false, desc: '敬请期待' },
];
```

- [ ] **Step 2: 改跳转**

`TrainingSubjectPage.tsx:35-39` 改为：

```tsx
  const handleSelect = (subject: TrainingSubject) => {
    if (!subject.enabled) return;
    // 数学 → 三卡选择页（专项/考试/错题，PRD §6.3）；语文 → 语文专项页
    if (subject.id === 2) {
      navigate('/student/training/chinese/special');
      return;
    }
    navigate('/student/training/home');
  };
```

- [ ] **Step 3: 类型检查 + lint**

```bash
cd apps/web && npx tsc -b --noEmit && npm run lint
```

Expected: 无错误。

- [ ] **Step 4: 目视验证**

```bash
cd apps/web && npm run dev
```

打开 `/student/training`。
Expected: 语文卡可点，副标题「古诗文默写」；英语卡仍灰化「敬请期待」；点语文进入语文专项页；点数学仍进入原三卡页。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/student/TrainingSubjectPage.tsx
git commit -m "feat(web): 训练学科页开放语文并接入语文专项入口"
```

---

## Task 16: 端到端手测 + 文档同步

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（§4 端点清单 + §6 数据流）
- Modify: `docs/api/openapi.yaml`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 三端点写入两份 API 文档；`docs/ai-core-changelog.md` 变更记录

- [ ] **Step 1: 端到端手测（含数学回归）**

启动后端与前端：

```bash
cd apps/server && npx tsx src/main.ts
```

```bash
cd apps/web && npm run dev
```

按顺序验证并记录结果：

1. 学生登录 → 训练 → 语文 → 语文专项页（两卡，解释灰化）
2. 进「古诗文默写」→ 范围「全部」+ 题量 3 → 开始默写
3. 第一篇：作者/朝代/正文**全对**（正文不带标点）→ 提交 → 显示「全部正确」
4. 第二篇：正文故意写错一个字 → 提交 → 显示「有错误」，正文对比高亮错字，错因提醒有文案（本地模型可用时）
5. 第三篇：**只填作者**，其余留空 → 提交 → 「有错误」，朝代为「错误，应为…」，正文大量「漏写」高亮
6. 走完 → 点「完成」→ 回语文专项页；再进错题相关页面确认语文错题**未**出现在数学错题练习（切到数学训练 → 错题练习，应看不到默写题）
7. 数学回归：训练 → 数学 → 专项练习 → 抽题 → 判题一次，行为与改动前一致

Expected: 7 条全部符合。**若第 4 条错因提醒为空**，确认本地 `LLM_BASE_URL`（`LOCAL_LLM_BASE_URL`）可用，或接受「暂时无法生成错因提醒」的兜底展示。

- [ ] **Step 2: 把三端点写入 API 设计文档**

在 `docs/API接口与数据流设计文档.md` 的 §4 端点清单中加入（格式对齐同文件中既有 training 端点条目）：

- `GET /api/training/dictation/passages` —— 语文默写篇目清单（仅已校验篇目，不含正文）
- `POST /api/training/dictation/start` —— 语文默写开练（`semester: 上册|下册|null`、`questionIds: number[]|null`、`count: 1-20`）
- `POST /api/training/dictation/judge` —— 语文默写判题（`questionId`、`author`、`dynasty`、`body`；返回 `isCorrect / fields / bodyDiff / reference / feedback`）

并在 §6 数据流补一条「语文默写练习」流程：配置页拉篇目 → 开练抽题 → 三字段提交 → 程序判对错 + 差异定位 → 错题入 `main_error_books(source='dictation')` → LLM 生成错因（失败不阻断）。

- [ ] **Step 3: 把三端点写入 openapi.yaml**

在 `docs/api/openapi.yaml` 的 training 相关 paths 下加入同样三个端点，schema 与 Step 2 一致；**路径、方法、参数名、响应字段必须与文档完全一致**。

- [ ] **Step 4: 交叉校验两份文档无遗漏**

```bash
grep -n "dictation" docs/API接口与数据流设计文档.md
grep -n "dictation" docs/api/openapi.yaml
```

Expected: 两处都能搜到三条 `dictation` 路径，且路径字符串完全一致。

- [ ] **Step 5: 记录变更日志**

在 `docs/ai-core-changelog.md` 追加一条日期条目（`2026-09-13`），记录：新增语文默写专项（`poem_dictation` 题型、`dictation_passages` 表、`judgeDictation` 纯程序判题、`dictation_feedback` 场景与本地优先路由、三端点），并写明「局限/待办：九年级必背篇目全量内容与逐字校验见内容管线计划；语文错题练习页未做」。

- [ ] **Step 6: 跑最终全量校验**

```bash
cd apps/server && npm test && npm run build
```

```bash
cd apps/web && npm run lint && npm run build
```

Expected: 全部通过。

- [ ] **Step 7: Commit**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml docs/ai-core-changelog.md
git commit -m "docs(api): 同步语文默写三端点与数据流，记录变更日志"
```

---

## 完成标准

1. `apps/server` 的 `npm test` 与 `npm run build` 全绿；
2. `apps/web` 的 `npm run lint` 与 `npm run build` 全绿；
3. Task 16 Step 1 的 7 条手测全部符合，含数学无回归；
4. 三端点已写入 `docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml`（两份一致）；
5. `docs/ai-core-changelog.md` 有本次变更条目与待办。

## 后续（不在本计划内）

- 内容管线计划：爬 smartedu 教材 → 抽九年级必背篇目 → 逐篇校验 → 全量入库（Task 1 完成后编写）；
- 古诗文解释专项（另起 spec）；
- 语文错题练习页 / 语文真题考试页；
- dev 假数据清理（`source_ref='DEV-FIXTURE'` 的 2 条记录）。
