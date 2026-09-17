# 古诗含义专项 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在训练模块的语文专项里新增第三个专项「古诗含义」——逐句作答「重点字词 + 深层含义 + 作者情感」，判题纯 LLM（`chinese_meaning_judge`：local 主、deepseek-flash 兜底），一次只出一句、结果倒序堆叠在下方。

**Architecture:** 复用既有 `chinese_passages` 表并加一列 `sentence_meanings`（与 `sentences` 下标对齐）；后端走**独立的 `meaning.controller.ts` / `meaning.service.ts`** 挂在 `TrainingModule` 下（仿英语背单词的分法，不塞进已 566 行的 `training.service.ts`）；前端新增配置页 + 答题页（布局 B），组件放 `components/business/meaning/`；内容由人工手写 Markdown 经新 CLI `meaning_cli.py` 入库。

**Tech Stack:** NestJS 10 + TypeScript ESM、mysql2、Vitest、Zod、Mustache（ai-core）、React 18 + Vite + Tailwind、`@testing-library/react`、Python 3 + pymysql + pytest。

**Spec:** `docs/superpowers/specs/2026-09-17-chinese-meaning-special-design.md`

---

## Global Constraints

- UI 里**不用 emoji**；图标必须是线性 SVG。
- **配色只有一套**（`apps/web/style.md` §2），不引入第三种颜色。
- **不进错题本、不写任何学生进度、不参与主线清零门禁**；无提示缓存、无自评、无「不再展示」、无隐藏题。
- 训练轨内页面硬编码 `data-theme="student-day"`，无主题切换按钮；`data-school` 只调字号。
- 判题**纯 LLM**：不做字符串归一化全等短路、不做长度比较。唯一保留的程序判断是空答案 → `unanswered`。
- Nest `@Post` 默认返回 **201**（本仓无 `@HttpCode` 覆盖），以 `2xx` 判成功。
- 测试与文档同步铁律：测试断言与 config/types/设计文档冲突时**改测试**；改代码同步改设计文档与 `docs/api/openapi.yaml`。
- **组件改动必须补一条渲染测试**；`globals: false` 下每个用例文件自己写 `afterEach(() => cleanup())`。
- 迁移必须幂等、只有 `ADD COLUMN`、**没有任何 `DELETE` / `DROP`**，且同步进 `tools/db/schema.sql`。
- refinery 用 `.env` 的 `LLM_BASE_URL` / `LLM_AUTH_TOKEN`，**不要用 `ANTHROPIC_*`**。
- 起后端用 `node dist/main.js`（`npx tsx src/main.ts` 的 DI 是坏的）。

---

## File Structure

**后端（apps/server）**

| 文件 | 职责 |
|---|---|
| `src/database/repositories/chinese-passages.repo.ts` | 修改：加 `sentence_meanings` 列到 `SELECT_COLS`、`toSentenceMeanings()`、`MEANING_GATE`、三个抽题方法 |
| `src/modules/training/dto/meaning.dto.ts` | 新建：本专项全部出入参类型 |
| `src/modules/training/meaning.service.ts` | 新建：`listMeaningPassages` / `startMeaning` / `judgeMeaning` |
| `src/modules/training/meaning.controller.ts` | 新建：三个端点 + 入参校验 |
| `src/modules/training/training.module.ts` | 修改：注册 `MeaningController` / `MeaningService` / `ChineseMeaningJudgeCapability` |
| `src/ai-core/types.ts` | 修改：`Scene` 与 `CapabilityType` 两个 union 加 `chinese_meaning_judge`；加 Request/Response 接口 |
| `src/ai-core/model-routes.yaml` | 修改：加场景路由 |
| `src/ai-core/retry.yaml` | 修改：加超时 |
| `src/ai-core/prompts/meaning/judge.md` | 新建：判题 prompt |
| `src/ai-core/infra/prompt-builder.ts` | 修改：`resolveTemplatePath` 加分支 |
| `src/ai-core/capabilities/chinese-meaning-judge.capability.ts` | 新建：判题能力（**故意不写 `@Injectable()`**） |
| `src/scripts/seed-chinese-meaning-judge-route.ts` | 新建：幂等写 `llm_routes` |
| `src/modules/admin/admin-models.service.ts` | 修改：`SCENES` 白名单加一项 |

**前端（apps/web）**

| 文件 | 职责 |
|---|---|
| `src/routes/index.tsx` | 修改：注册两条路由 |
| `src/pages/student/training/chinese/ChineseSpecialPage.tsx` | 修改：加第三张卡 |
| `src/pages/student/training/chinese/MeaningConfigPage.tsx` | 新建：范围 + 篇数 + 指定篇目 |
| `src/pages/student/training/chinese/MeaningRunPage.tsx` | 新建：答题页（布局 B + 异步占位） |
| `src/services/api.ts` | 修改：加 `Meaning*` 类型与 `fetchMeaningPassages` / `startMeaning` / `judgeMeaning` |
| `src/components/business/meaning/types.ts` | 新建：`MeaningAnswerPayload` 与 `StackItem` |
| `src/components/business/meaning/PassageOverviewBar.tsx` | 新建：顶部全诗原文条 |
| `src/components/business/meaning/AnswerBlock.tsx` | 新建：当前句作答区 |
| `src/components/business/meaning/ResultStack.tsx` | 新建：倒序结果栈 |
| `src/components/business/meaning/ResultItem.tsx` | 新建：单条结果 + 标准答案对照 |

**数据管线（tools）**

| 文件 | 职责 |
|---|---|
| `tools/db/migrations/2026-09-17_chinese_sentence_meanings.sql` | 新建：幂等加列 |
| `tools/db/schema.sql` | 修改：同步列定义 |
| `tools/data-refinery/src/meaning_cli.py` | 新建：`--export` 出模板 / `--apply` 入库 |

---

## Task 1: 数据库迁移

**Files:**
- Create: `tools/db/migrations/2026-09-17_chinese_sentence_meanings.sql`
- Modify: `tools/db/schema.sql:309-335`（`chinese_passages` 建表语句）
- Modify: `apps/server/src/database/repositories/chinese-passages.repo.ts:4-22`（`ChinesePassageRow`）

- [ ] **Step 1: 写迁移文件**

创建 `tools/db/migrations/2026-09-17_chinese_sentence_meanings.sql`：

```sql
-- 2026-09-17 语文古诗文「含义」专项：chinese_passages 增加 sentence_meanings 列。
--
-- 承载每句的「深层含义」与「作者情感」，**与 sentences 下标对齐**的 JSON 数组：
--   [{"meaning": "…", "emotion": "…"}, …]
--   某一句没有含义数据时该位置写 null（不是省略——省略会让后面整体错位）。
--
-- 为什么是独立新列、而不是并进 sentences JSON：
--   interpretation_loader.py 是全量 `UPDATE chinese_passages SET sentences=%s …`，
--   并进去的话重跑一次解释管线就会把含义数据整列抹掉。分列存是硬要求。
--
-- 只给诗词篇目灌数据，文言文留 NULL —— 「只做诗词」由数据有无实现，不加体裁列。
--
-- 幂等：先查 information_schema.COLUMNS 再 ADD（照 2026-09-16_chinese_interpretation_columns.sql 写法）。
-- 本文件**只有 ADD COLUMN，没有任何 DELETE / DROP**。

SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'chinese_passages'
    AND COLUMN_NAME = 'sentence_meanings'
);
SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE chinese_passages ADD COLUMN sentence_meanings JSON DEFAULT NULL AFTER sentences',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
```

- [ ] **Step 2: 手工 apply 到本机库**

Run: `mysql -u ai_k12 -p ai_k12 < tools/db/migrations/2026-09-17_chinese_sentence_meanings.sql`
Expected: 无报错；再跑一次同样无报错（幂等）。

- [ ] **Step 3: 同步 schema.sql**

在 `tools/db/schema.sql` 的 `chinese_passages` 建表语句里，`sentences` 之后加一行：

```sql
  sentence_meanings JSON DEFAULT NULL,   -- [{"meaning":"…","emotion":"…"}]，与 sentences 下标对齐
```

- [ ] **Step 4: 类型定义同步**

`chinese-passages.repo.ts` 的 `ChinesePassageRow` 里，`sentences: unknown;` 之后加：

```ts
  /** mysql2 读 JSON 列已自动 parse——不要再 JSON.parse */
  sentence_meanings: unknown;
```

- [ ] **Step 5: 提交**

```bash
git add tools/db/migrations/2026-09-17_chinese_sentence_meanings.sql tools/db/schema.sql apps/server/src/database/repositories/chinese-passages.repo.ts
git commit -m "feat(db): chinese_passages 加 sentence_meanings 列（古诗含义专项）"
```

---

## Task 2: Repository 扩展

**Files:**
- Modify: `apps/server/src/database/repositories/chinese-passages.repo.ts:93-99`（`SELECT_COLS` / gate）、`:186-242` 之后追加

**Interfaces:**
- Consumes: Task 1 的 `sentence_meanings` 列与 `ChinesePassageRow.sentence_meanings`
- Produces: `toSentenceMeanings()`、`findVerifiedForMeaning()`、`findRandomVerifiedForMeaning()`、`findVerifiedByIdsForMeaning()`

- [ ] **Step 1: 加解析函数**

在 `chinese-passages.repo.ts` 的 `toSentences` 之后加：

```ts
/** 含义专项：一句的深层含义与作者情感。 */
export interface PassageSentenceMeaning {
  meaning: string;
  emotion: string;
}

/**
 * JSON 列 → 含义数组，**下标与 sentences 严格对齐**。
 * 位置上的 `null` 表示「这句没有含义数据」——**不能压缩掉**，否则后面整体错位。
 * 形状坏的项降级为 `null`（安全的降级方向：该句不出题，但仍在原文条里显示）。
 */
export function toSentenceMeanings(raw: unknown): Array<PassageSentenceMeaning | null> {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (item == null || typeof item !== 'object') return null;
    const { meaning, emotion } = item as Record<string, unknown>;
    if (typeof meaning !== 'string' || typeof emotion !== 'string') return null;
    if (meaning.trim() === '' && emotion.trim() === '') return null;
    return { meaning, emotion };
  });
}
```

- [ ] **Step 2: SELECT_COLS 加列**

把 `SELECT_COLS`（`:93-96`）的 `dp.key_terms, dp.sentences, dp.full_translation,` 改成：

```ts
const SELECT_COLS = `dp.id, dp.work_title, dp.author, dp.dynasty, dp.body,
  dp.key_terms, dp.sentences, dp.sentence_meanings, dp.full_translation,
  dp.grade_band, dp.grade, dp.semester, dp.sort_order, dp.source_ref, dp.verified,
  dp.memorize_required, dp.is_active`;
```

- [ ] **Step 3: 加 gate 与三个抽题方法**

在 `findVerifiedByIdsForInterpretation` 之后追加：

```ts
  // ==================== 含义专项（2026-09-17） ====================
  //
  // 抽题池在解释专项的基础上多一道闸门：**必须有 sentence_meanings**。
  // 只给诗词篇目灌数据，所以「只做诗词」由数据有无天然实现，不需要体裁标记列。

  /** 含义专项抽题池：已校验 + 未停用 + 内容就绪 + 有含义数据 */
  private static readonly MEANING_GATE_SQL =
    `dp.verified = 1 AND dp.is_active = 1 AND JSON_LENGTH(dp.sentences) > 0 AND dp.sentence_meanings IS NOT NULL`;

  /** 配置页清单：含义专项抽题池 */
  async findVerifiedForMeaning(): Promise<ChinesePassageRow[]> {
    const [rows] = await this.pool.execute<ChinesePassageRow[]>(
      `SELECT ${SELECT_COLS} FROM chinese_passages dp
       WHERE ${ChinesePassagesRepository.MEANING_GATE_SQL}
       ORDER BY dp.sort_order, dp.id`,
    );
    return rows;
  }

  /** 含义专项随机抽篇（semester=null 即「全部册次」） */
  async findRandomVerifiedForMeaning(
    semester: string | null,
    count: number,
  ): Promise<ChinesePassageRow[]> {
    const params: unknown[] = [];
    let sql = `SELECT ${SELECT_COLS} FROM chinese_passages dp
       WHERE ${ChinesePassagesRepository.MEANING_GATE_SQL}`;
    if (semester != null) {
      sql += ' AND dp.semester = ?';
      params.push(semester);
    } else {
      // 「全部册次」按**篇名**去重（同 findRandomVerifiedForInterpretation）：
      // 九上/九下有 9 篇重复收录，不过滤册次时同一篇会被抽到两次。
      // ⚠️ 只在无册次过滤时加：子查询跨册取 MIN(id)，外层若已按册过滤会把该册的行整体排除掉。
      sql += ` AND dp.id = (
        SELECT MIN(dp2.id) FROM chinese_passages dp2
          WHERE dp2.work_title = dp.work_title
            AND dp2.verified = 1 AND dp2.is_active = 1
            AND JSON_LENGTH(dp2.sentences) > 0
            AND dp2.sentence_meanings IS NOT NULL
      )`;
    }
    sql += ' ORDER BY RAND() LIMIT ?';
    params.push(count);
    // LIMIT ? 不能走 prepared statement（mysql2 execute 报 Incorrect arguments），用 query
    const [rows] = await this.pool.query<ChinesePassageRow[]>(sql, params);
    return rows;
  }

  /** 含义专项指定篇目出题（按 id 批量取，忽略册次） */
  async findVerifiedByIdsForMeaning(passageIds: number[]): Promise<ChinesePassageRow[]> {
    if (passageIds.length === 0) return [];
    const placeholders = passageIds.map(() => '?').join(',');
    const [rows] = await this.pool.execute<ChinesePassageRow[]>(
      `SELECT ${SELECT_COLS} FROM chinese_passages dp
       WHERE ${ChinesePassagesRepository.MEANING_GATE_SQL}
         AND dp.id IN (${placeholders})`,
      [...passageIds],
    );
    return rows;
  }
```

- [ ] **Step 4: 类型检查**

Run: `cd apps/server && npx tsc --noEmit -p tsconfig.json`
Expected: PASS（无输出）

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/database/repositories/chinese-passages.repo.ts
git commit -m "feat(repo): 含义专项抽题池与 sentence_meanings 解析"
```

---

## Task 3: DTO

**Files:**
- Create: `apps/server/src/modules/training/dto/meaning.dto.ts`

**Interfaces:** 后续 Task 5/6/10 全部依赖这里的类型名。

- [ ] **Step 1: 写 DTO**

```ts
/**
 * 语文古诗文「含义」专项 DTO。
 *
 * 三条铁律（与默写/解释同规矩）：
 *   1. `start` 只出**原文与字词名**，`meaning` / `emotion` / `translation` /
 *      `full_translation` / `author` / `dynasty` / `body` 一律不下发——它们就是答案。
 *   2. `judge` 是**逐句**判：一次请求判一句（该句的字词 + 深层含义 + 作者情感）。
 *   3. 判题不写任何学生状态（独立子系统，不入错题本）。
 */

/**
 * 判定方式。**没有 `exact`** —— 本专项不做字符串归一化全等短路（理解性作答
 * 拿字符串相等去判不成立），全部交给 LLM。
 * `undetermined` 的 `correct` 为 `null`（模型没判出来，前端显示「未判定」）。
 */
export type MeaningMethod = 'ai' | 'unanswered' | 'undetermined';

/** 配置页篇目清单项（供「指定篇目」勾选）。只有名字，没有内容。 */
export interface MeaningPassageListItem {
  passageId: number;
  workTitle: string;
  semester: string;
}

/**
 * 答题页的一个关键字词。**两个形式并存**（不要合并）：
 *   `term`  —— 原样，**带注音**（`谪（zhé）守`）：展示用
 *   `plain` —— 去注音（`谪守`）：前端在原文里高亮用
 */
export interface MeaningTermItem {
  term: string;
  plain: string;
}

/** 答题页的一句骨架。 */
export interface MeaningSentenceItem {
  /** 真实句下标（在 sentences 里的位置），判题回传用 */
  index: number;
  text: string;
  terms: MeaningTermItem[];
  /**
   * false = 该句没有标准含义（人工没填），**只显示在顶部原文条里、不出题**。
   * 诗要完整显示，所以 answerable:false 的句子也要下发 text。
   */
  answerable: boolean;
}

/** 开练下发的一篇：整篇句子一次给全（顶部原文条要渲染完整一首诗）。 */
export interface MeaningPassageItem {
  passageId: number;
  workTitle: string;
  semester: string;
  sentences: MeaningSentenceItem[];
}

/** 单块（含义 / 情感）的判定结果。`standard` 只在判题响应里下发。 */
export interface MeaningPartJudge {
  /** `null` = 未判定 */
  correct: boolean | null;
  method: MeaningMethod;
  standard: string;
  comment: string | null;
}

export interface MeaningTermJudgeItem {
  term: string;
  /** `null` = 未判定 */
  correct: boolean | null;
  method: MeaningMethod;
  standard: string;
  comment: string | null;
}

export interface MeaningJudgeResult {
  passageId: number;
  sentenceIndex: number;
  /** 该句所有项（字词 + 含义 + 情感）全 `correct === true` 才是 true；有 `null` 即 false。 */
  allCorrect: boolean;
  /** 顺序与「该句应有的字词」一致。 */
  terms: MeaningTermJudgeItem[];
  meaning: MeaningPartJudge;
  emotion: MeaningPartJudge;
}
```

- [ ] **Step 2: 类型检查并提交**

Run: `cd apps/server && npx tsc --noEmit -p tsconfig.json` → PASS

```bash
git add apps/server/src/modules/training/dto/meaning.dto.ts
git commit -m "feat(dto): 古诗含义专项出入参类型"
```

---

## Task 4: ai-core 新场景 `chinese_meaning_judge`（8 处）

**Files:**
- Modify: `apps/server/src/ai-core/types.ts:15`（`Scene`）、`:52`（`CapabilityType`）、`:670` 之后（新增类型）
- Modify: `apps/server/src/ai-core/model-routes.yaml:156` 之后
- Modify: `apps/server/src/ai-core/retry.yaml:17` 附近
- Create: `apps/server/src/ai-core/prompts/meaning/judge.md`
- Modify: `apps/server/src/ai-core/infra/prompt-builder.ts:96` 之后
- Create: `apps/server/src/ai-core/capabilities/chinese-meaning-judge.capability.ts`
- Create: `apps/server/src/scripts/seed-chinese-meaning-judge-route.ts`
- Modify: `apps/server/src/modules/admin/admin-models.service.ts:13`（`SCENES`）
- Test: `apps/server/src/ai-core/capabilities/chinese-meaning-judge.capability.test.ts`

**Interfaces:**
- Produces: `ChineseMeaningJudgeCapability.generate(request: ChineseMeaningJudgeRequest): Promise<ChineseMeaningJudgeResponse>`

- [ ] **Step 1: types.ts 两个 union 加场景**

```ts
// types.ts:15 —— Scene
export type Scene = 'tutoring' | 'grading' | 'judgment' | 'explanation' | 'variation' | 'analysis' | 'safety' | 'structuring' | 'hint' | 'title' | 'dictation_feedback' | 'interpretation_judge' | 'english_word_judge' | 'chinese_meaning_judge';

// types.ts:52 —— CapabilityType
export type CapabilityType = 'tutoring' | 'grading' | 'judgment' | 'explanation' | 'variation' | 'analysis' | 'fallback' | 'structuring' | 'hint' | 'dictation_feedback' | 'interpretation_judge' | 'english_word_judge' | 'chinese_meaning_judge';
```

- [ ] **Step 2: types.ts 加 Request/Response**

在 `InterpretationJudgeResponse`（`:665-670`）之后追加：

```ts
// ========== Chinese Meaning Judge Types（古诗含义判题，2026-09-17） ==========

/** 含义专项待判的一个字词。 */
export interface ChineseMeaningJudgeTermInput {
  term: string;
  /** 标准释义（服务端从 key_terms 取，不下发给前端） */
  gloss: string;
  /** 学生作答 */
  answer: string;
}

export interface ChineseMeaningJudgeRequest {
  workTitle: string;
  /** 该句原文 */
  sentence: string;
  /** 该句字面译文——只作判「深层含义」的参考上下文，服务端内部用，不下发前端 */
  standardTranslation: string;
  standardMeaning: string;
  standardEmotion: string;
  /** 学生没作答时为 null（该项不判） */
  studentMeaning: string | null;
  studentEmotion: string | null;
  terms: ChineseMeaningJudgeTermInput[];
}

export interface ChineseMeaningJudgePartResult {
  correct: boolean;
  /** 判错时的改进提示；判对可不给 */
  comment?: string | null;
}

export interface ChineseMeaningJudgeTermResult {
  term: string;
  correct: boolean;
  comment?: string | null;
}

/** 模型输出。`terms` 允许少于请求项数（漏项由调用方标 undetermined）。 */
export interface ChineseMeaningJudgeResponse {
  terms: ChineseMeaningJudgeTermResult[];
  /** 请求未含该项时为 null/缺省 */
  meaning?: ChineseMeaningJudgePartResult | null;
  emotion?: ChineseMeaningJudgePartResult | null;
  reasoning?: string;
}
```

- [ ] **Step 3: model-routes.yaml 加路由**

在 `english_word_judge:` 块（`:164-167`）之后、`default:` 之前插入：

```yaml
  # 语文古诗文「含义」判题：判定每句的深层含义与作者情感是否到位。
  # 与 interpretation_judge 同策略（本地优先、云端兜底）；两者都失败 → 逐项 undetermined，
  # 不阻断学生看到已判的项。
  chinese_meaning_judge:
    - subject: "*"
      primary: local
      fallback: deepseek-flash
```

- [ ] **Step 4: retry.yaml 加超时**

在 `interpretation_judge: 30000`（`:17`）之后加一行：

```yaml
  chinese_meaning_judge: 30000
```

- [ ] **Step 5: 写 prompt 模板**

创建 `apps/server/src/ai-core/prompts/meaning/judge.md`：

```md
---
version: "1.0"
description: "语文古诗文「含义」- 逐句判定深层含义、作者情感与重点字词释义是否到位"
---

## System Prompt

你是一位初中语文老师，正在批改古诗文的「含义理解」。学生逐句作答，你逐句判。

**你要判的是「理解是否到位」，不是「措辞是否一致」。**

### 判定口径

- **深层含义**：学生说对了**核心意思**就算过——换个说法、语序不同、详略不同、比标准答案短，都算过。
  只有当**关键意象理解错**（把比喻当写实、把典故的指向搞错）、或**整体意思偏离/说反了**时才判错。
- **作者情感**：**方向对就算过**。「思乡」＝「思念故乡」，「豁达」＝「乐观旷达」，同义表述一律接受。
  只有当**方向反了**（把豁达答成悲凉、把乐观答成愤懑、把豪迈答成哀婉）时才判错。
- **字词释义**：说对了**核心义项**就算过。用词不同、顺序不同、详略不同都不算错。
  只有当**说错了意思**、**说到了别的义项且与语境不符**、或**明显没说清**时才判错。
- 学生写错别字但意思清楚 → 算过（这是理解题，不是默写题）。
- **不要**因为「没有逐字对应标准答案」而判错。

### comment 怎么写

- **判错时**给一句具体的改进提示（不超过 60 字）：指出错在哪、该怎么理解。
- **判对时**给 `null`，不要写「很好」「正确」这类废话。

### 输出格式

只输出一个 JSON 对象，不要输出任何其它文字、不要用 markdown 代码围栏：

```json
{"terms":[{"term":"沉舟","correct":false,"comment":"…"}],"meaning":{"correct":true,"comment":null},"emotion":{"correct":true,"comment":null}}
```

**硬性要求**：

1. `terms` 里**只能出现请求中给出的字词**，项数与顺序与请求一致，**不得增删**。
2. 请求里没有字词时，`terms` 输出 `[]`。
3. 请求里没有让学生答「深层含义」时，`meaning` 输出 `null`；「作者情感」同理。
4. `correct` 必须是布尔值（`true` / `false`），不要写字符串。

---

## User Message

**篇目**：《{{workTitle}}》

**当前句原文**

{{sentence}}

**该句字面译文（仅供参考，不是学生要答的东西）**

{{standardTranslation}}

**标准答案**

- 深层含义：{{standardMeaning}}
- 作者情感：{{standardEmotion}}

{{#terms}}
**需要判定的字词**

- 〔{{term}}〕 学生释义：{{answer}} ｜ 标准释义：{{gloss}}
{{/terms}}
{{^terms}}
（本句没有需要判定的字词）
{{/terms}}

{{#studentMeaning}}
**学生的「深层含义」作答**

{{studentMeaning}}
{{/studentMeaning}}
{{^studentMeaning}}
（本句的深层含义无需判定）
{{/studentMeaning}}

{{#studentEmotion}}
**学生的「作者情感」作答**

{{studentEmotion}}
{{/studentEmotion}}
{{^studentEmotion}}
（本句的作者情感无需判定）
{{/studentEmotion}}

请按上述口径判定，并只输出规定的 JSON。
```

- [ ] **Step 6: prompt-builder 加分支**

在 `prompt-builder.ts:96-98` 的 `interpretation_judge` 分支之后插入：

```ts
    if (capability === 'chinese_meaning_judge') {
      return `meaning/judge.md`;
    }
```

- [ ] **Step 7: 写 capability**

创建 `apps/server/src/ai-core/capabilities/chinese-meaning-judge.capability.ts`：

```ts
import { z } from 'zod';
import type { ChineseMeaningJudgeRequest, ChineseMeaningJudgeResponse } from '../types.js';
import { timeoutConfig } from '../config.js';
import { ModelRouter } from '../infra/model-router.js';
import { getModelConfigRegistry } from '../infra/model-config-registry.js';
import { PromptBuilder } from '../infra/prompt-builder.js';
import { ModelClient, LLAMA_CPP_NO_THINKING_BODY } from '../infra/model-client/index.js';
import { ResponseParser } from '../infra/response-parser.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * `terms` 用 `.default([])`、`meaning` / `emotion` 用 `.nullable().optional()`：
 * **模型漏项不视为解析失败**——漏的那些项由调用方标 `undetermined`，
 * 已判的项照常返回。全漏也只是解析成功。
 */
const ChineseMeaningJudgeResultSchema = z.object({
  terms: z.array(z.object({
    term: z.string(),
    correct: z.boolean(),
    comment: z.string().nullable().optional(),
  })).default([]),
  meaning: z.object({
    correct: z.boolean(),
    comment: z.string().nullable().optional(),
  }).nullable().optional(),
  emotion: z.object({
    correct: z.boolean(),
    comment: z.string().nullable().optional(),
  }).nullable().optional(),
});

export interface ChineseMeaningJudgeCapabilityDeps {
  modelClient?: ModelClient;
}

/**
 * 语文古诗文「含义」判题能力。
 *
 * 与 InterpretationJudgeCapability 的差别：调用方**没有**程序短路（本专项不做
 * 归一化全等短路），所以送进来的项全部是真正需要语义判断的。
 *
 * 场景 `chinese_meaning_judge`：primary=local（Qwen3.8-27B），fallback=deepseek-flash。
 * 两个模型都失败（或 JSON 解析失败）→ **抛错**，由调用方兜底为逐项 `undetermined`，
 * 不阻断学生看到「已判的项」。
 *
 * ⚠️ 本类**故意不写 `@Injectable()`** —— 与 ai-core/capabilities/* 其它类一致
 * （零参实例化，避开 Nest 对接口类型可选参数发 design:paramtypes 的 DI 坑）。
 */
export class ChineseMeaningJudgeCapability {
  private modelRouter = new ModelRouter(getModelConfigRegistry());
  private promptBuilder: PromptBuilder;
  private modelClient: ModelClient;
  private responseParser = new ResponseParser();

  constructor(deps?: ChineseMeaningJudgeCapabilityDeps) {
    this.promptBuilder = new PromptBuilder(resolve(__dirname, '../prompts'));
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async generate(request: ChineseMeaningJudgeRequest): Promise<ChineseMeaningJudgeResponse> {
    const routeResult = this.modelRouter.route({ scene: 'chinese_meaning_judge', subject: 'chinese' });
    const timeout = timeoutConfig.timeout.chinese_meaning_judge ?? timeoutConfig.timeout.default;

    const promptResult = await this.promptBuilder.build({
      capability: 'chinese_meaning_judge',
      subject: 'chinese',
      context: {
        student: { grade: '', gradeLevel: '' },
        userMessage: '请判定以上作答。',
        customVariables: {
          workTitle: request.workTitle,
          sentence: request.sentence,
          standardTranslation: request.standardTranslation,
          standardMeaning: request.standardMeaning,
          standardEmotion: request.standardEmotion,
          studentMeaning: request.studentMeaning,
          studentEmotion: request.studentEmotion,
          terms: request.terms.map((t) => ({ term: t.term, gloss: t.gloss, answer: t.answer })),
        },
      },
    });

    const callOnce = async (model: typeof routeResult.primary): Promise<ChineseMeaningJudgeResponse> => {
      const chatResponse = await this.modelClient.chat({
        model,
        messages: promptResult.messages,
        responseFormat: 'json_object',
        timeout,
        // 判题是短判定任务，不需要 thinking。本地端点只认 chat_template_kwargs
        // （`thinking: false` 对 llama.cpp 无效），实测关掉后 13–16s -> 1–2s。
        // 只对本地 provider 下发：fallback 是云端 deepseek，收到未知字段可能直接 400。
        ...(model.provider === 'local' ? { extraBody: LLAMA_CPP_NO_THINKING_BODY } : {}),
      });

      const parsed = this.responseParser.parse<ChineseMeaningJudgeResponse>({
        rawContent: chatResponse.content,
        mode: 'json',
        schema: ChineseMeaningJudgeResultSchema,
      });
      if (!parsed.success || !parsed.data) {
        throw new Error(`Chinese meaning judge parse failed: ${parsed.errors?.join(', ')}`);
      }
      return { ...parsed.data, reasoning: chatResponse.reasoningContent };
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

- [ ] **Step 8: seed 脚本**

创建 `apps/server/src/scripts/seed-chinese-meaning-judge-route.ts`（镜像 `seed-interpretation-judge-route.ts`，
只改 `SCENE` 常量与注释；`llm_routes` 存的是 `model_key` 字符串，不是模型 id）：

```ts
/**
 * 语文古诗文含义专项判题路由：`chinese_meaning_judge` 场景 = 本地模型优先、deepseek-flash 兜底。
 * 读 YAML routes.chinese_meaning_judge，幂等写进 llm_routes（已 seed 的库靠本脚本补路由；
 * seed-llm-config.ts 是 skip-if-exists，不会更新既有行）。
 * 镜像 seed-interpretation-judge-route.ts。
 *
 * 运行：cd apps/server && npx tsx src/scripts/seed-chinese-meaning-judge-route.ts
 * 生效：脚本不改内存 registry —— 重启后端，或后台保存一次路由触发 reload。
 */
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import mysql from 'mysql2/promise';
import { routeConfig } from '../ai-core/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

const SCENE = 'chinese_meaning_judge';

async function main() {
  const rule = routeConfig.routes.chinese_meaning_judge?.find((r) => r.subject === '*')
    ?? routeConfig.routes.chinese_meaning_judge?.[0];
  if (!rule) throw new Error('YAML 缺少 routes.chinese_meaning_judge');

  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });

  // 主模型缺失时降级用 fallback 顶上，避免选到不存在的模型
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT model_key FROM llm_models WHERE is_enabled = 1 AND model_key IN (?, ?)',
    [rule.primary, rule.fallback ?? ''],
  );
  const present = new Set(rows.map((r) => r.model_key as string));
  let primary = rule.primary;
  let fallback: string | null = rule.fallback ?? null;
  if (!present.has(primary)) {
    if (fallback && present.has(fallback)) {
      console.warn(`[${SCENE}] 主模型 ${primary} 不在库中，降级用 ${fallback} 作 primary`);
      primary = fallback;
      fallback = null;
    } else {
      throw new Error(`[${SCENE}] 主模型 ${primary} 与 fallback 都不在库中，先 seed 模型`);
    }
  }

  const [routeRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT id FROM llm_routes WHERE scene = ? AND subject = ?', [SCENE, '*']);
  if (routeRows.length > 0) {
    await pool.execute(
      `UPDATE llm_routes
         SET primary_model_key = ?, fallback_model_key = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE scene = ? AND subject = ?`,
      [primary, fallback, SCENE, '*']);
    console.log(`[${SCENE}] 路由 ${SCENE}/* 已更新 -> ${primary} / ${fallback ?? '-'}`);
  } else {
    await pool.execute(
      'INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key) VALUES (?, ?, ?, ?)',
      [SCENE, '*', primary, fallback]);
    console.log(`[${SCENE}] 路由 ${SCENE}/* 已插入 -> ${primary} / ${fallback ?? '-'}`);
  }

  console.log(`[${SCENE}] 完成。重启后端（或后台保存路由）后生效。`);
  await pool.end();
}

main().catch((e) => { console.error(`[${SCENE}] 失败:`, e); process.exit(1); });
```

Run: `cd apps/server && npx tsx src/scripts/seed-chinese-meaning-judge-route.ts`
Expected: 输出 `路由 chinese_meaning_judge/* 已插入 -> local / deepseek-flash`

- [ ] **Step 9: SCENES 白名单**

`admin-models.service.ts:13` 的数组末尾 `... 'english_word_judge',` 之后加 `'chinese_meaning_judge'`：

```ts
export const SCENES = ['tutoring', 'grading', 'judgment', 'hint', 'explanation', 'variation', 'structuring', 'title', 'dictation_feedback', 'interpretation_judge', 'english_word_judge', 'chinese_meaning_judge', 'analysis', 'safety'] as const;
```

- [ ] **Step 10: 写 capability 单测**

创建 `apps/server/src/ai-core/capabilities/chinese-meaning-judge.capability.test.ts`，
照 `interpretation-judge.capability.test.ts` 的结构写三条：

```ts
import { describe, it, expect, vi } from 'vitest';
import { ChineseMeaningJudgeCapability } from './chinese-meaning-judge.capability.js';

const REQ = {
  workTitle: '酬乐天扬州初逢席上见赠',
  sentence: '沉舟侧畔千帆过，病树前头万木春。',
  standardTranslation: '沉船旁边千帆竞发，枯树前面万木争春。',
  standardMeaning: '比喻新事物必将取代旧事物。',
  standardEmotion: '豁达乐观、积极进取',
  studentMeaning: '新事物会代替旧事物',
  studentEmotion: '乐观',
  terms: [{ term: '沉舟', gloss: '沉没的船', answer: '沉了的船' }],
};

/** 模型客户端桩：第 n 次调用可给不同返回（用来测 primary 失败 → fallback 顶上）。 */
function makeClient(impl: (call: number) => Promise<{ content: string; reasoningContent?: string }>) {
  let n = 0;
  return { chat: vi.fn().mockImplementation(() => impl(++n)) } as never;
}

describe('ChineseMeaningJudgeCapability', () => {
  it('模型成功时返回三项判定', async () => {
    const client = makeClient(async () => ({
      content: JSON.stringify({
        terms: [{ term: '沉舟', correct: true, comment: null }],
        meaning: { correct: true, comment: null },
        emotion: { correct: true, comment: null },
      }),
    }));
    const cap = new ChineseMeaningJudgeCapability({ modelClient: client });
    const res = await cap.generate(REQ);
    expect(res.terms[0]?.correct).toBe(true);
    expect(res.meaning?.correct).toBe(true);
    expect(res.emotion?.correct).toBe(true);
  });

  it('primary 失败时走 fallback（第二次调用返回成功）', async () => {
    const ok = JSON.stringify({
      terms: [], meaning: { correct: false, comment: '偏了' }, emotion: { correct: true, comment: null },
    });
    const client = makeClient(async (call) => {
      if (call === 1) throw new Error('local down');
      return { content: ok };
    });
    const cap = new ChineseMeaningJudgeCapability({ modelClient: client });
    const res = await cap.generate(REQ);
    expect(res.meaning?.correct).toBe(false);
    expect(res.meaning?.comment).toBe('偏了');
  });

  it('解析失败时抛错（不静默返回空）', async () => {
    const client = makeClient(async () => ({ content: '不是 JSON' }));
    const cap = new ChineseMeaningJudgeCapability({ modelClient: client });
    await expect(cap.generate(REQ)).rejects.toThrow(/parse failed/);
  });
});
```

- [ ] **Step 11: 跑测试**

Run: `cd apps/server && npx vitest run src/ai-core/capabilities/chinese-meaning-judge.capability.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 12: 全量回归 + 提交**

Run: `cd apps/server && npx vitest run` → 全部 PASS（含既有 `SCENES` 漂移守卫用例）

```bash
git add apps/server/src/ai-core apps/server/src/scripts/seed-chinese-meaning-judge-route.ts apps/server/src/modules/admin/admin-models.service.ts
git commit -m "feat(ai-core): 新增 chinese_meaning_judge 判题场景（local 主 / ds-flash 兜底）"
```

---

## Task 5: MeaningService

**Files:**
- Create: `apps/server/src/modules/training/meaning.service.ts`
- Test: `apps/server/src/modules/training/meaning.service.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `findVerifiedForMeaning` / `findRandomVerifiedForMeaning` / `findVerifiedByIdsForMeaning` / `findById` / `toSentences` / `toKeyTerms` / `toSentenceMeanings`；Task 4 的 `ChineseMeaningJudgeCapability.generate`；`stripPinyinAnnotation`（`src/common/utils/normalize-chinese.util.ts`）
- Produces: `listMeaningPassages()` / `startMeaning(input)` / `judgeMeaning(input)`

### 端点级行为约定（三个方法都要照此实现）

**`judgeMeaning` 逐步逻辑**

1. `findById(passageId)` 返回 `null` → `NotFoundException('含义篇目不存在：${passageId}')`
2. `sentences = toSentences(passage.sentences)`；`meanings = toSentenceMeanings(passage.sentence_meanings)`
3. `std = sentences[sentenceIndex]` 为 `undefined` → `BadRequestException('sentenceIndex 越界：${sentenceIndex}')`
4. `stdMeaning = meanings[sentenceIndex]`，为 `null` / `undefined` → `BadRequestException('该句无标准含义：${sentenceIndex}')`
5. `stdTerms = toKeyTerms(passage.key_terms).filter(t => t.sentenceIndex === sentenceIndex)`
6. 学生答案配对：`Map<term.trim(), answer>`，同名取最后一条，多传的 term 忽略
7. **空答案短路**（唯一保留的程序判断）：`terms[].answer` / `meaning` / `emotion` 去空白后为空串 →
   该项 `{ correct: false, method: 'unanswered', standard, comment: null }`，**不进 LLM**
8. 剩余 pending 项**打包成一次** `meaningJudge.generate({...})`：
   `workTitle` / `sentence` / `standardTranslation: std.translation` / `standardMeaning: stdMeaning.meaning` /
   `standardEmotion: stdMeaning.emotion` / `studentMeaning`(未答为 null) / `studentEmotion`(未答为 null) /
   `terms: pendingTerms.map(s => ({term, gloss: s.standard, answer}))`
9. 回填：命中 → `{correct, method:'ai', comment}`；漏项 → 保持 `{correct:null, method:'undetermined', comment:null}`
10. `generate` 整次抛错 → **所有 pending 项**保持 `undetermined`，**不抛错**
11. `allCorrect = terms.every(c => c.correct === true) && meaning.correct === true && emotion.correct === true`
12. **不写任何学生状态**（不注入错题本 / 隐藏题 / 提示缓存 repo）

**`startMeaning` 逐步逻辑**

1. `passageIds` 非空 → `findVerifiedByIdsForMeaning(passageIds)`；否则 `findRandomVerifiedForMeaning(semester, count)`
2. 每篇：`sentences = toSentences(...)`，`meanings = toSentenceMeanings(...)`
3. 组装 `sentences` 数组：`index` 用**数组下标**，
   `terms: toKeyTerms(key_terms).filter(t => t.sentenceIndex === index).map(t => ({term: t.term, plain: stripPinyinAnnotation(t.term)}))`，
   `answerable: meanings[index] != null`
4. **整篇没有任何 `answerable` 句子的篇目跳过**（不下发空白卡）
5. `passages.slice(0, count)`
6. 白名单：响应里**只允许** `passageId` / `workTitle` / `semester` / `sentences[].{index,text,terms,answerable}`

- [ ] **Step 1: 写失败测试**

创建 `apps/server/src/modules/training/meaning.service.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { MeaningService } from './meaning.service.js';

const PASSAGE = {
  id: 12,
  work_title: '酬乐天扬州初逢席上见赠',
  author: '刘禹锡',
  dynasty: '唐',
  body: '巴山楚水凄凉地，二十三年弃置身。沉舟侧畔千帆过，病树前头万木春。',
  key_terms: [
    { term: '沉（chén）舟', gloss: '沉没的船', src: 'textbook', sentenceIndex: 1 },
  ],
  sentences: [
    { text: '巴山楚水凄凉地，二十三年弃置身。', translation: '巴山楚水一片凄凉。' },
    { text: '沉舟侧畔千帆过，病树前头万木春。', translation: '沉船旁边千帆竞发。' },
  ],
  sentence_meanings: [
    { meaning: '写被贬之地的荒凉与岁月的漫长。', emotion: '辛酸、愤懑' },
    { meaning: '比喻新事物必将取代旧事物。', emotion: '豁达乐观、积极进取' },
  ],
  full_translation: '巴山楚水一片凄凉。沉船旁边千帆竞发。',
  grade_band: 'junior', grade: '九年级', semester: '上册', sort_order: 3,
  source_ref: 'DEV-FIXTURE', verified: 1, memorize_required: 1, is_active: 1,
};

const OK_JUDGE = {
  terms: [{ term: '沉（chén）舟', correct: true, comment: null }],
  meaning: { correct: false, comment: '这是比喻，不是写景' },
  emotion: { correct: true, comment: null },
};

function makeService(overrides: {
  passage?: unknown; list?: unknown; random?: unknown; byIds?: unknown;
  judged?: unknown; judgeThrows?: Error;
} = {}) {
  const repo = {
    findById: vi.fn().mockResolvedValue(overrides.passage === undefined ? PASSAGE : overrides.passage),
    findVerifiedForMeaning: vi.fn().mockResolvedValue(overrides.list ?? [PASSAGE]),
    findRandomVerifiedForMeaning: vi.fn().mockResolvedValue(overrides.random ?? [PASSAGE]),
    findVerifiedByIdsForMeaning: vi.fn().mockResolvedValue(overrides.byIds ?? [PASSAGE]),
  };
  const judge = {
    generate: vi.fn().mockImplementation(() => {
      if (overrides.judgeThrows) return Promise.reject(overrides.judgeThrows);
      return Promise.resolve(overrides.judged ?? OK_JUDGE);
    }),
  };
  return { service: new MeaningService(repo as never, judge as never), repo, judge };
}

describe('MeaningService.listMeaningPassages', () => {
  it('只出 passageId/workTitle/semester，含义与情感一律不下发', async () => {
    const { service } = makeService();
    const res = await service.listMeaningPassages();
    expect(res.passages).toEqual([{ passageId: 12, workTitle: '酬乐天扬州初逢席上见赠', semester: '上册' }]);
    const json = JSON.stringify(res);
    expect(json).not.toContain('新事物');
    expect(json).not.toContain('豁达乐观');
    expect(json).not.toContain('刘禹锡');
  });
});

describe('MeaningService.startMeaning', () => {
  it('下发整篇句子 text，answerable 标记有标准含义的句子，且不泄露答案', async () => {
    const { service } = makeService();
    const res = await service.startMeaning({ semester: null, passageIds: null, count: 1 });
    expect(res.passages[0]?.sentences).toEqual([
      { index: 0, text: '巴山楚水凄凉地，二十三年弃置身。', terms: [], answerable: true },
      { index: 1, text: '沉舟侧畔千帆过，病树前头万木春。',
        terms: [{ term: '沉（chén）舟', plain: '沉舟' }], answerable: true },
    ]);
    const json = JSON.stringify(res);
    expect(json).not.toContain('新事物');
    expect(json).not.toContain('豁达乐观');
    expect(json).not.toContain('沉没的船');
    expect(json).not.toContain('刘禹锡');
  });

  it('某句没有标准含义时 answerable=false，但 text 仍下发（诗要完整显示）', async () => {
    const partial = { ...PASSAGE, sentence_meanings: [{ meaning: '写凄凉。', emotion: '辛酸' }, null] };
    const { service } = makeService({ random: [partial] });
    const res = await service.startMeaning({ semester: null, passageIds: null, count: 1 });
    expect(res.passages[0]?.sentences[1]?.answerable).toBe(false);
    expect(res.passages[0]?.sentences[1]?.text).toBe('沉舟侧畔千帆过，病树前头万木春。');
  });
});

describe('MeaningService.judgeMeaning', () => {
  it('LLM 成功时按项回填，method 为 ai', async () => {
    const { service, judge } = makeService();
    const res = await service.judgeMeaning({
      passageId: 12, sentenceIndex: 1,
      terms: [{ term: '沉（chén）舟', answer: '沉了的船' }],
      meaning: '旧事物会被新事物取代', emotion: '乐观',
    });
    expect(judge.generate).toHaveBeenCalledTimes(1);
    expect(res.terms[0]).toMatchObject({ correct: true, method: 'ai', standard: '沉没的船' });
    expect(res.meaning).toMatchObject({ correct: false, method: 'ai', standard: '比喻新事物必将取代旧事物。' });
    expect(res.emotion).toMatchObject({ correct: true, method: 'ai' });
    expect(res.allCorrect).toBe(false);
  });

  it('空答案不进 LLM，直接 unanswered 判错', async () => {
    const { service, judge } = makeService();
    const res = await service.judgeMeaning({
      passageId: 12, sentenceIndex: 1, terms: [], meaning: '', emotion: '',
    });
    expect(judge.generate).not.toHaveBeenCalled();
    expect(res.meaning).toMatchObject({ correct: false, method: 'unanswered' });
    expect(res.emotion).toMatchObject({ correct: false, method: 'unanswered' });
  });

  it('只填了含义、情感留空 → 情感 unanswered，含义照判', async () => {
    const { service, judge } = makeService();
    const res = await service.judgeMeaning({
      passageId: 12, sentenceIndex: 1, terms: [], meaning: '旧事物会被取代', emotion: '',
    });
    expect(judge.generate).toHaveBeenCalledTimes(1);
    expect(res.meaning.method).toBe('ai');
    expect(res.emotion).toMatchObject({ correct: false, method: 'unanswered' });
  });

  it('模型整次失败 → 待判项 undetermined、correct 为 null，不抛错', async () => {
    const { service } = makeService({ judgeThrows: new Error('boom') });
    const res = await service.judgeMeaning({
      passageId: 12, sentenceIndex: 1,
      terms: [{ term: '沉（chén）舟', answer: '沉了的船' }],
      meaning: '旧事物会被取代', emotion: '乐观',
    });
    expect(res.terms[0]).toMatchObject({ correct: null, method: 'undetermined' });
    expect(res.meaning).toMatchObject({ correct: null, method: 'undetermined' });
    expect(res.allCorrect).toBe(false);
  });

  it('模型漏判某项 → 只有漏的那项 undetermined，已判项不清空', async () => {
    const { service } = makeService({
      judged: { terms: [], meaning: { correct: true, comment: null } }, // emotion 漏了
    });
    const res = await service.judgeMeaning({
      passageId: 12, sentenceIndex: 1, terms: [], meaning: '旧事物会被取代', emotion: '乐观',
    });
    expect(res.meaning).toMatchObject({ correct: true, method: 'ai' });
    expect(res.emotion).toMatchObject({ correct: null, method: 'undetermined' });
  });

  it('method 枚举不含 exact（钉住「不做程序短路」这个决定）', async () => {
    const { service } = makeService();
    const res = await service.judgeMeaning({
      passageId: 12, sentenceIndex: 1, terms: [],
      meaning: '比喻新事物必将取代旧事物。', // 与标准答案逐字相同
      emotion: '豁达乐观、积极进取',
    });
    expect(res.meaning.method).toBe('ai'); // 不是 'exact'
  });

  it('篇目不存在 → 404；sentenceIndex 越界 → 400；该句无标准含义 → 400', async () => {
    const { service } = makeService({ passage: null });
    await expect(service.judgeMeaning({ passageId: 999, sentenceIndex: 0, terms: [], meaning: 'a', emotion: 'b' }))
      .rejects.toThrow(/不存在/);
    const s2 = makeService().service;
    await expect(s2.judgeMeaning({ passageId: 12, sentenceIndex: 9, terms: [], meaning: 'a', emotion: 'b' }))
      .rejects.toThrow(/越界/);
    const s3 = makeService({
      passage: { ...PASSAGE, sentence_meanings: [null, null] },
    }).service;
    await expect(s3.judgeMeaning({ passageId: 12, sentenceIndex: 1, terms: [], meaning: 'a', emotion: 'b' }))
      .rejects.toThrow(/无标准含义/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/meaning.service.test.ts`
Expected: FAIL —— `Cannot find module './meaning.service.js'`

- [ ] **Step 3: 实现 service**

创建 `apps/server/src/modules/training/meaning.service.ts`：

```ts
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ChinesePassagesRepository, toSentences, toKeyTerms, toSentenceMeanings } from '../../database/repositories/chinese-passages.repo.js';
import { ChineseMeaningJudgeCapability } from '../../ai-core/capabilities/chinese-meaning-judge.capability.js';
import { stripPinyinAnnotation } from '../../common/utils/normalize-chinese.util.js';
import type {
  MeaningPassageListItem, MeaningPassageItem, MeaningJudgeResult,
  MeaningTermJudgeItem, MeaningPartJudge, MeaningMethod,
} from './dto/meaning.dto.js';

/**
 * 语文古诗文「含义」专项服务（2026-09-17）。
 *
 * 独立子系统：不挂 `questions`、不进错题本、不参与主线清零门禁、
 * 不用「不再展示」/提示缓存/自评 —— 所以本服务**只注入篇目 repo 与判题能力**，
 * 不注入任何学生状态 repo。
 *
 * 与解释专项最关键的差别：**没有程序短路**。含义与情感是理解性作答，
 * 拿字符串归一化全等去判不成立，一律交给 LLM。唯二保留的程序判断是
 * 「空答案 → unanswered」与「该句有没有标准含义」。
 */
@Injectable()
export class MeaningService {
  constructor(
    private readonly passageRepo: ChinesePassagesRepository,
    private readonly meaningJudge: ChineseMeaningJudgeCapability,
  ) {}

  /** 配置页篇目清单：只出篇名与册次。 */
  async listMeaningPassages(): Promise<{ passages: MeaningPassageListItem[] }> {
    const rows = await this.passageRepo.findVerifiedForMeaning();
    return {
      passages: rows.map((r) => ({ passageId: r.id, workTitle: r.work_title, semester: r.semester })),
    };
  }

  /**
   * 开练：整篇句子的 `text` 一次给全（顶部全诗原文条要渲染完整一首诗），
   * 但 `answerable:false` 的句子只显示、不出题。
   *
   * 白名单序列化：`meaning` / `emotion` / `translation` / `full_translation` /
   * `author` / `dynasty` / `body` 一律不下发。
   */
  async startMeaning(input: {
    semester: string | null;
    passageIds: number[] | null;
    count: number;
  }): Promise<{ passages: MeaningPassageItem[] }> {
    const rows = input.passageIds && input.passageIds.length > 0
      ? await this.passageRepo.findVerifiedByIdsForMeaning(input.passageIds)
      : await this.passageRepo.findRandomVerifiedForMeaning(input.semester, input.count);

    const passages: MeaningPassageItem[] = [];
    for (const r of rows) {
      const sentences = toSentences(r.sentences);
      if (sentences.length === 0) continue;
      const meanings = toSentenceMeanings(r.sentence_meanings);
      const terms = toKeyTerms(r.key_terms);
      const items = sentences.map((s, index) => ({
        index, // 真实句下标，判题回传用
        text: s.text,
        terms: terms
          .filter((t) => t.sentenceIndex === index)
          .map((t) => ({ term: t.term, plain: stripPinyinAnnotation(t.term) })),
        answerable: meanings[index] != null,
      }));
      // 整篇没有任何可作答的句子 → 不下发（避免前端渲染空白卡）
      if (!items.some((i) => i.answerable)) continue;
      passages.push({
        passageId: r.id,
        workTitle: r.work_title,
        semester: r.semester,
        sentences: items,
      });
    }
    return { passages: passages.slice(0, input.count) };
  }

  /**
   * 判题：**逐句**判（该句的字词 + 深层含义 + 作者情感打包成一次 LLM 调用），
   * **纯读**、不写任何学生状态。
   */
  async judgeMeaning(input: {
    passageId: number;
    sentenceIndex: number;
    terms: Array<{ term: string; answer: string }>;
    meaning: string;
    emotion: string;
  }): Promise<MeaningJudgeResult> {
    const passage = await this.passageRepo.findById(input.passageId);
    if (!passage) {
      throw new NotFoundException(`含义篇目不存在：${input.passageId}`);
    }

    const sentences = toSentences(passage.sentences);
    const std = sentences[input.sentenceIndex];
    if (!std) {
      throw new BadRequestException(`sentenceIndex 越界：${input.sentenceIndex}`);
    }
    const meanings = toSentenceMeanings(passage.sentence_meanings);
    const stdMeaning = meanings[input.sentenceIndex];
    if (!stdMeaning) {
      throw new BadRequestException(`该句无标准含义：${input.sentenceIndex}`);
    }
    const stdTerms = toKeyTerms(passage.key_terms).filter((t) => t.sentenceIndex === input.sentenceIndex);

    const answerByTerm = new Map<string, string>();
    for (const t of input.terms) answerByTerm.set(t.term.trim(), t.answer);
    const answerOf = (term: string) => answerByTerm.get(term.trim()) ?? '';

    // ---- 1. 空答案短路（本专项唯一的程序判断） ----
    type TermSlot = MeaningTermJudgeItem & { pending: boolean };
    const slots: TermSlot[] = stdTerms.map((t) => {
      const stu = answerOf(t.term);
      if (stu.trim() === '') {
        return { term: t.term, correct: false, method: 'unanswered', standard: t.gloss, comment: null, pending: false };
      }
      return { term: t.term, correct: null, method: 'undetermined', standard: t.gloss, comment: null, pending: true };
    });

    const partOf = (student: string, standard: string): MeaningPartJudge & { pending: boolean } =>
      student.trim() === ''
        ? { correct: false, method: 'unanswered', standard, comment: null, pending: false }
        : { correct: null, method: 'undetermined', standard, comment: null, pending: true };

    const meaningSlot = partOf(input.meaning, stdMeaning.meaning);
    const emotionSlot = partOf(input.emotion, stdMeaning.emotion);

    // ---- 2. 待判项打包一次调用 ----
    const pendingTerms = slots.filter((s) => s.pending);
    if (pendingTerms.length > 0 || meaningSlot.pending || emotionSlot.pending) {
      try {
        const judged = await this.meaningJudge.generate({
          workTitle: passage.work_title,
          sentence: std.text,
          standardTranslation: std.translation,
          standardMeaning: stdMeaning.meaning,
          standardEmotion: stdMeaning.emotion,
          studentMeaning: meaningSlot.pending ? input.meaning : null,
          studentEmotion: emotionSlot.pending ? input.emotion : null,
          terms: pendingTerms.map((s) => ({ term: s.term, gloss: s.standard, answer: answerOf(s.term) })),
        });

        for (const s of pendingTerms) {
          const hit = judged.terms.find((r) => r.term.trim() === s.term.trim());
          if (hit) {
            s.correct = hit.correct;
            s.method = 'ai';
            s.comment = hit.comment ?? null;
          }
        }
        for (const [slot, hit] of [[meaningSlot, judged.meaning], [emotionSlot, judged.emotion]] as const) {
          if (slot.pending && hit) {
            slot.correct = hit.correct;
            slot.method = 'ai';
            slot.comment = hit.comment ?? null;
          }
        }
      } catch {
        // 整次失败：pending 项保持 undetermined（correct: null），已判项不清空、不抛错
      }
    }

    const stripPending = <T extends { pending: boolean }>(s: T): Omit<T, 'pending'> => {
      const { pending: _pending, ...rest } = s;
      return rest;
    };

    const termsOut = slots.map(stripPending);
    const meaningOut = stripPending(meaningSlot);
    const emotionOut = stripPending(emotionSlot);

    return {
      passageId: passage.id,
      sentenceIndex: input.sentenceIndex,
      allCorrect:
        termsOut.every((t) => t.correct === true) &&
        meaningOut.correct === true &&
        emotionOut.correct === true,
      terms: termsOut,
      meaning: meaningOut,
      emotion: emotionOut,
    };
  }
}
```

> 注意 `MeaningMethod` 若在上面未被直接引用，从 import 里删掉（避免 lint 报未使用）。

- [ ] **Step 4: 跑测试通过**

Run: `cd apps/server && npx vitest run src/modules/training/meaning.service.test.ts`
Expected: PASS（9 tests）

- [ ] **Step 5: lint + 提交**

Run: `cd apps/server && npx eslint src/modules/training/meaning.service.ts src/modules/training/meaning.service.test.ts` → 无 error

```bash
git add apps/server/src/modules/training/meaning.service.ts apps/server/src/modules/training/meaning.service.test.ts
git commit -m "feat(meaning): 含义专项 service（纯 LLM 判题，无归一化短路）"
```

---

## Task 6: Controller 与模块注册

**Files:**
- Create: `apps/server/src/modules/training/meaning.controller.ts`
- Modify: `apps/server/src/modules/training/training.module.ts:26-30`
- Test: `apps/server/src/modules/training/meaning.controller.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `MeaningService`
- Produces: `GET /api/training/meaning/passages`、`POST /api/training/meaning/start`、`POST /api/training/meaning/judge`

### 端点级行为约定

| 端点 | 校验（不合法 → 400） | 返回 |
|---|---|---|
| `GET passages` | — | `{passages:[{passageId,workTitle,semester}]}` |
| `POST start` | `count` 必须是 1–3 整数；`semester` 只能是 `上册`/`下册`/`null`；`passageIds` 必须是正整数数组或 `null` | `{passages:[MeaningPassageItem]}` |
| `POST judge` | `passageId` 正整数；`sentenceIndex` 非负整数；`terms` 非数组时降级 `[]`，其中 `term` 非字符串丢弃、`answer` 非字符串降级 `''`；`meaning`/`emotion` 非字符串降级 `''` | `MeaningJudgeResult` |

- [ ] **Step 1: 写失败测试**

创建 `apps/server/src/modules/training/meaning.controller.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { MeaningController } from './meaning.controller.js';

function makeController() {
  const service = {
    listMeaningPassages: vi.fn().mockResolvedValue({ passages: [] }),
    startMeaning: vi.fn().mockResolvedValue({ passages: [] }),
    judgeMeaning: vi.fn().mockResolvedValue({ allCorrect: true }),
  };
  return { controller: new MeaningController(service as never), service };
}

describe('MeaningController.start', () => {
  it('count 越界 → 400', async () => {
    const { controller } = makeController();
    await expect(controller.startMeaning({ semester: null, passageIds: null, count: 4 }))
      .rejects.toThrow(BadRequestException);
    await expect(controller.startMeaning({ semester: null, passageIds: null, count: 0 }))
      .rejects.toThrow(BadRequestException);
  });

  it('semester 非法 → 400', async () => {
    const { controller } = makeController();
    await expect(controller.startMeaning({ semester: '中部', passageIds: null, count: 1 }))
      .rejects.toThrow(BadRequestException);
  });

  it('passageIds 非正整数 → 400', async () => {
    const { controller } = makeController();
    await expect(controller.startMeaning({ semester: null, passageIds: [0], count: 1 }))
      .rejects.toThrow(BadRequestException);
  });

  it('合法入参透传给 service', async () => {
    const { controller, service } = makeController();
    await controller.startMeaning({ semester: '上册', passageIds: [3], count: 2 });
    expect(service.startMeaning).toHaveBeenCalledWith({ semester: '上册', passageIds: [3], count: 2 });
  });
});

describe('MeaningController.judge', () => {
  it('非法入参 → 400', async () => {
    const { controller } = makeController();
    await expect(controller.judgeMeaning({ passageId: 0, sentenceIndex: 0, terms: [], meaning: '', emotion: '' }))
      .rejects.toThrow(BadRequestException);
    await expect(controller.judgeMeaning({ passageId: 1, sentenceIndex: -1, terms: [], meaning: '', emotion: '' }))
      .rejects.toThrow(BadRequestException);
  });

  it('脏入参静默规范化，不 500', async () => {
    const { controller, service } = makeController();
    await controller.judgeMeaning({
      passageId: 12, sentenceIndex: 1,
      terms: [{ term: '沉舟', answer: 123 as never }, null as never, { term: 5 as never, answer: 'x' }],
      meaning: 42 as never, emotion: null as never,
    });
    expect(service.judgeMeaning).toHaveBeenCalledWith({
      passageId: 12, sentenceIndex: 1,
      terms: [{ term: '沉舟', answer: '' }],
      meaning: '', emotion: '',
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/meaning.controller.test.ts`
Expected: FAIL —— `Cannot find module './meaning.controller.js'`

- [ ] **Step 3: 实现 controller**

```ts
import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { MeaningService } from './meaning.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import type { MeaningJudgeResult, MeaningPassageItem, MeaningPassageListItem } from './dto/meaning.dto.js';

/**
 * 语文古诗文「含义」专项（2026-09-17）。
 *
 * 独立 controller，不塞进已被撑大的 TrainingController（与英语背单词同分法）。
 * 端点前缀 `/api/training/meaning`，仍属训练模块。
 *
 * 入参一律手工校验 + 静默规范化：客户端可能混进 number/null，
 * 不规范化会让它们在归一化函数里 TypeError 变 500（见 training.controller.ts 的 dictation/judge）。
 */
@Controller('api/training/meaning')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class MeaningController {
  constructor(private readonly meaningService: MeaningService) {}

  /** 篇目清单（配置页「指定篇目」用；只出篇名 + 册次，没有内容）。 */
  @Get('passages')
  async listPassages(): Promise<{ passages: MeaningPassageListItem[] }> {
    return this.meaningService.listMeaningPassages();
  }

  /**
   * 开练：count 限 1-3（每篇逐句判，3 篇已是长会话）；
   * semester 限 上册|下册|null；passageIds 非空时按指定篇目出题（忽略 semester）。
   */
  @Post('start')
  async startMeaning(
    @Body() dto: { semester: string | null; passageIds: number[] | null; count: number },
  ): Promise<{ passages: MeaningPassageItem[] }> {
    const { count } = dto;
    if (!Number.isInteger(count) || count < 1 || count > 3) {
      throw new BadRequestException('count 仅允许 1-3 的整数');
    }
    const semester = dto.semester ?? null;
    if (semester !== null && semester !== '上册' && semester !== '下册') {
      throw new BadRequestException('semester 仅允许 上册 | 下册 | null');
    }
    const passageIds = dto.passageIds ?? null;
    if (passageIds !== null &&
        (!Array.isArray(passageIds) || passageIds.some((id) => !Number.isInteger(id) || id < 1))) {
      throw new BadRequestException('passageIds 须为正整数数组或 null');
    }
    return this.meaningService.startMeaning({ semester, passageIds, count });
  }

  /**
   * 判题：**逐句**判（该句的字词 + 深层含义 + 作者情感），**不写任何学生状态**。
   * 模型漏项/不可用时那些项回 `correct: null` + `method: 'undetermined'`（不报错）。
   */
  @Post('judge')
  async judgeMeaning(
    @Body() dto: {
      passageId: number;
      sentenceIndex: number;
      terms?: Array<{ term: string; answer: string }>;
      meaning?: string;
      emotion?: string;
    },
  ): Promise<MeaningJudgeResult> {
    if (!Number.isInteger(dto.passageId) || dto.passageId < 1) {
      throw new BadRequestException('passageId 须为正整数');
    }
    if (!Number.isInteger(dto.sentenceIndex) || dto.sentenceIndex < 0) {
      throw new BadRequestException('sentenceIndex 须为非负整数');
    }
    const terms: Array<{ term: string; answer: string }> = [];
    for (const raw of Array.isArray(dto.terms) ? dto.terms : []) {
      if (raw == null || typeof raw !== 'object') continue;
      const { term, answer } = raw as { term?: unknown; answer?: unknown };
      if (typeof term !== 'string') continue;
      terms.push({ term, answer: typeof answer === 'string' ? answer : '' });
    }
    return this.meaningService.judgeMeaning({
      passageId: dto.passageId,
      sentenceIndex: dto.sentenceIndex,
      terms,
      meaning: typeof dto.meaning === 'string' ? dto.meaning : '',
      emotion: typeof dto.emotion === 'string' ? dto.emotion : '',
    });
  }
}
```

- [ ] **Step 4: 注册进模块**

`training.module.ts` 三处修改：

```ts
// import 区加两行
import { MeaningController } from './meaning.controller.js';
import { MeaningService } from './meaning.service.js';
import { ChineseMeaningJudgeCapability } from '../../ai-core/capabilities/chinese-meaning-judge.capability.js';

// controllers
controllers: [TrainingController, VocabularyController, MeaningController],

// providers 末尾加 MeaningService 与 ChineseMeaningJudgeCapability
providers: [..., EnglishWordJudgeCapability, MeaningService, ChineseMeaningJudgeCapability],
```

- [ ] **Step 5: 跑测试 + 全量回归**

Run: `cd apps/server && npx vitest run src/modules/training/meaning.controller.test.ts` → PASS（6 tests）
Run: `cd apps/server && npx vitest run` → 全部 PASS

- [ ] **Step 6: 构建 + 提交**

Run: `cd apps/server && npm run build` → PASS（`copy-assets.mjs` 会把 `prompts/meaning/judge.md` 复制进 dist）

```bash
git add apps/server/src/modules/training/meaning.controller.ts apps/server/src/modules/training/meaning.controller.test.ts apps/server/src/modules/training/training.module.ts
git commit -m "feat(meaning): 含义专项三个端点与模块注册"
```

---

## Task 7: API 文档同步

**Files:**
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/API接口与数据流设计文档.md`

- [ ] **Step 1: openapi.yaml 加三个路径**

在语文专项相关端点（`interpretation/*`）附近追加：

```yaml
  /api/training/meaning/passages:
    get:
      summary: 古诗含义专项篇目清单
      tags: [训练]
      security: [{ bearerAuth: [] }]
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  code: { type: integer, example: 0 }
                  data:
                    type: object
                    properties:
                      passages:
                        type: array
                        items:
                          type: object
                          properties:
                            passageId: { type: integer, example: 12 }
                            workTitle: { type: string, example: 酬乐天扬州初逢席上见赠 }
                            semester: { type: string, example: 上册 }

  /api/training/meaning/start:
    post:
      summary: 古诗含义专项开练
      tags: [训练]
      security: [{ bearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                semester: { type: string, nullable: true, enum: [上册, 下册], example: null }
                passageIds: { type: array, nullable: true, items: { type: integer }, example: null }
                count: { type: integer, minimum: 1, maximum: 3, example: 2 }
      responses:
        '201':
          description: Created（Nest @Post 默认 201）
          content:
            application/json:
              schema:
                type: object
                properties:
                  code: { type: integer, example: 0 }
                  data:
                    type: object
                    properties:
                      passages:
                        type: array
                        items:
                          type: object
                          properties:
                            passageId: { type: integer }
                            workTitle: { type: string }
                            semester: { type: string }
                            sentences:
                              type: array
                              items:
                                type: object
                                properties:
                                  index: { type: integer, description: 真实句下标，判题回传用 }
                                  text: { type: string }
                                  answerable:
                                    type: boolean
                                    description: false = 无标准含义，只显示不出题
                                  terms:
                                    type: array
                                    items:
                                      type: object
                                      properties:
                                        term: { type: string, description: 原样，带注音，展示用 }
                                        plain: { type: string, description: 去注音，前端高亮用 }

  /api/training/meaning/judge:
    post:
      summary: 古诗含义专项逐句判题
      description: |
        一次请求判一句（该句字词 + 深层含义 + 作者情感打包成一次 LLM 调用）。
        method 只有 ai / unanswered / undetermined 三种——**没有 exact**，本专项不做程序短路。
        模型漏项或整次失败时对应项为 `correct: null` + `method: 'undetermined'`，不报错。
      tags: [训练]
      security: [{ bearerAuth: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                passageId: { type: integer }
                sentenceIndex: { type: integer, minimum: 0 }
                terms:
                  type: array
                  items:
                    type: object
                    properties:
                      term: { type: string }
                      answer: { type: string }
                meaning: { type: string }
                emotion: { type: string }
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                type: object
                properties:
                  code: { type: integer, example: 0 }
                  data:
                    type: object
                    properties:
                      passageId: { type: integer }
                      sentenceIndex: { type: integer }
                      allCorrect: { type: boolean }
                      terms:
                        type: array
                        items:
                          type: object
                          properties:
                            term: { type: string }
                            correct: { type: boolean, nullable: true }
                            method: { type: string, enum: [ai, unanswered, undetermined] }
                            standard: { type: string }
                            comment: { type: string, nullable: true }
                      meaning:
                        type: object
                        properties:
                          correct: { type: boolean, nullable: true }
                          method: { type: string, enum: [ai, unanswered, undetermined] }
                          standard: { type: string }
                          comment: { type: string, nullable: true }
                      emotion:
                        type: object
                        properties:
                          correct: { type: boolean, nullable: true }
                          method: { type: string, enum: [ai, unanswered, undetermined] }
                          standard: { type: string }
                          comment: { type: string, nullable: true }
        '400': { description: passageId / sentenceIndex 非法，或该句无标准含义 }
        '404': { description: 篇目不存在 }
```

- [ ] **Step 2: API 设计文档同步**

在 `docs/API接口与数据流设计文档.md` §4 端点清单补三行（与解释专项并列），
在 §6 数据流补一段说明：**逐句判题、纯 LLM、无程序短路、`undetermined` 语义**。

- [ ] **Step 3: 提交**

```bash
git add docs/api/openapi.yaml docs/API接口与数据流设计文档.md
git commit -m "docs(api): 同步古诗含义专项三个端点契约"
```

---

## Task 8: 前端入口与路由

**Files:**
- Modify: `apps/web/src/routes/index.tsx:236-253` 之后
- Modify: `apps/web/src/pages/student/training/chinese/ChineseSpecialPage.tsx:23-86`

- [ ] **Step 1: 加两个 import 与两条路由**

`routes/index.tsx` 顶部加：

```tsx
import MeaningConfigPage from '@/pages/student/training/chinese/MeaningConfigPage';
import MeaningRunPage from '@/pages/student/training/chinese/MeaningRunPage';
```

在解释答题页路由（`:245-253`）之后插入：

```tsx
  // 语文含义配置页（全屏沉浸层；题单经 sessionStorage 交接）
  {
    path: '/student/training/chinese/meaning',
    element: (
      <RequireRole role="student">
        <MeaningConfigPage />
      </RequireRole>
    ),
  },
  // 语文含义答题页（全屏沉浸层；一次一句，结果倒序堆叠，空题单自动踢回配置页）
  {
    path: '/student/training/chinese/meaning/run',
    element: (
      <RequireRole role="student">
        <MeaningRunPage />
      </RequireRole>
    ),
  },
```

- [ ] **Step 2: 专项页加第三张卡**

`ChineseSpecialPage.tsx`：在文件顶部加一个线性 SVG 图标（**无 emoji**）：

```tsx
/** 含义：镜/心意（线性 SVG）。 */
const MeaningIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M12 20.5s-7-4.35-7-9.5a4 4 0 0 1 7-2.6 4 4 0 0 1 7 2.6c0 5.15-7 9.5-7 9.5Z" />
    <path d="M9 11h6" />
  </svg>
);
```

把 `grid-cols-1 md:grid-cols-2`（`:48`）改成 `grid-cols-1 md:grid-cols-3`，
并在解释卡之后插入第三张（**图标底色沿用 brand 橙渐变，不引入第三种颜色**）：

```tsx
          <button
            onClick={() => navigate('/student/training/chinese/meaning')}
            className={`${CARD_CLASS} hover:-translate-y-1 focus:outline-none focus:ring-4 focus:ring-[var(--brand-500)]/20`}
            style={{ border: '1px solid rgba(226, 232, 240, 0.8)', boxShadow: 'var(--shadow-card)' }}
            onMouseEnter={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-elevated)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-card)'; }}
            aria-label="进入古诗含义"
          >
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center text-white shadow-sm"
              style={{ background: 'linear-gradient(to top right, #FF6B35, #FFB25A)' }}
              aria-hidden="true"
            >
              <MeaningIcon />
            </div>
            <span className="text-3xl font-black tracking-tight text-[var(--text-primary)]">古诗含义</span>
            <span className="text-sm text-[var(--text-secondary)]">深层含义 · 作者情感</span>
          </button>
```

- [ ] **Step 3: 类型检查**

Run: `cd apps/web && npx tsc -b --noEmit` → 会因为两个新页面不存在而报错，Task 9/10 解决

- [ ] **Step 4: 提交（与 Task 9 一起提，避免中间态编译不过）**

留到 Task 9 提交。

---

## Task 9: 前端配置页

**Files:**
- Create: `apps/web/src/pages/student/training/chinese/MeaningConfigPage.tsx`

**Interfaces:**
- Consumes: `GET /api/training/meaning/passages`、`POST /api/training/meaning/start`
- Produces: `sessionStorage['training:meaning']` 存题单，然后 `navigate('/student/training/chinese/meaning/run')`

**状态机**

```
idle ──(点「开始」)──> submitting ──(成功)──> 写 sessionStorage 并 navigate
                              └──(失败)──> error（显示「拉取失败，重试」）
semester: 'all' | '上册' | '下册'（默认 'all'）
count: 1 | 2 | 3（默认 1）
selectedIds: number[]（勾选上限 = count，超出时禁勾并提示）
```

- [ ] **Step 1: api.ts 加类型与三个函数**

在 `apps/web/src/services/api.ts` 的 `judgeInterpretation`（`:1138-1148`）之后追加：

```ts
// --- Training · 语文古诗文「含义」专项（2026-09-17） ---
//
// 与解释专项的关键差别：`MeaningMethod` **没有 `exact`** —— 本专项不做归一化全等短路，
// 判题一律交给 LLM。另一个差别是 `sentence.answerable`：没有标准含义的句子只显示、不出题。

export interface MeaningTermItem { term: string; plain: string }

export interface MeaningSentenceItem {
  index: number;
  text: string;
  terms: MeaningTermItem[];
  /** false = 无标准含义，只在顶部原文条里显示，不进作答队列 */
  answerable: boolean;
}

export interface MeaningPassageItem { passageId: number; workTitle: string; semester: string }

export interface MeaningPassageDetail {
  passageId: number;
  workTitle: string;
  semester: string;
  sentences: MeaningSentenceItem[];
}

/** 判定方式。**没有 `exact`**（理解性作答不做字符串全等短路）。 */
export type MeaningMethod = 'ai' | 'unanswered' | 'undetermined';

export interface MeaningPartResult {
  correct: boolean | null;
  method: MeaningMethod;
  standard: string;
  comment: string | null;
}

export interface MeaningTermResultItem {
  term: string;
  correct: boolean | null;
  method: MeaningMethod;
  standard: string;
  comment: string | null;
}

export interface MeaningJudgeResult {
  passageId: number;
  sentenceIndex: number;
  allCorrect: boolean;
  terms: MeaningTermResultItem[];
  meaning: MeaningPartResult;
  emotion: MeaningPartResult;
}

export function fetchMeaningPassages(): Promise<{ passages: MeaningPassageItem[] }> {
  return fetchApi<{ passages: MeaningPassageItem[] }>('/training/meaning/passages');
}

export function startMeaning(payload: {
  semester: string | null;
  passageIds: number[] | null;
  count: number;
}): Promise<{ passages: MeaningPassageDetail[] }> {
  return fetchApi<{ passages: MeaningPassageDetail[] }>('/training/meaning/start', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** 判**一句**（该句的字词 + 深层含义 + 作者情感）。模型不可用时相关项回 correct=null。 */
export function judgeMeaning(payload: {
  passageId: number;
  sentenceIndex: number;
  terms: Array<{ term: string; answer: string }>;
  meaning: string;
  emotion: string;
}): Promise<MeaningJudgeResult> {
  return fetchApi<MeaningJudgeResult>('/training/meaning/judge', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
```

- [ ] **Step 2: 写配置页**

创建 `apps/web/src/pages/student/training/chinese/MeaningConfigPage.tsx`
（结构与 `InterpretationConfigPage.tsx` 一致，只换端点、文案与 sessionStorage key）：

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/base';
import {
  fetchMeaningPassages,
  startMeaning,
  type MeaningPassageItem,
} from '@/services/api';

/** 篇数档：含义专项每篇逐句判，3 篇已是长会话。 */
const COUNT_OPTIONS = [1, 2, 3];

/** 范围档：value 即传给后端的 semester；'全部' 传 null。 */
const RANGE_OPTIONS: Array<{ label: string; value: string | null }> = [
  { label: '全部', value: null },
  { label: '上册', value: '上册' },
  { label: '下册', value: '下册' },
];

const PILL_BASE = 'px-5 py-2.5 rounded-full text-sm font-medium transition-colors';
const CARD_BORDER = { border: '1px solid rgba(226, 232, 240, 0.8)' } as const;

/**
 * 古诗含义配置页：范围（全部/上册/下册）+ 篇数（1/2/3）+ 可选指定篇目。
 *
 * 勾选上限 = 篇数：勾选数超过篇数会让后端不得不截断，语义含糊
 * （到底是随机还是指定？），所以在 UI 上就挡住。
 */
export default function MeaningConfigPage() {
  const navigate = useNavigate();
  const [passages, setPassages] = useState<MeaningPassageItem[]>([]);
  const [range, setRange] = useState<string | null>(null);
  const [count, setCount] = useState<number>(1);
  const [picked, setPicked] = useState<number[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMeaningPassages()
      .then((res) => { if (!cancelled) setPassages(res.passages); })
      .catch(() => { if (!cancelled) setError('篇目加载失败，请稍后重试'); });
    return () => { cancelled = true; };
  }, []);

  const visible = useMemo(
    () => (range == null ? passages : passages.filter((p) => p.semester === range)),
    [passages, range],
  );

  const atLimit = picked.length >= count;

  const togglePick = (passageId: number) => {
    setPicked((prev) => {
      if (prev.includes(passageId)) return prev.filter((x) => x !== passageId);
      if (prev.length >= count) return prev;   // 上限即篇数，超了不勾
      return [...prev, passageId];
    });
  };

  const handleStart = async () => {
    setLoading(true);
    setError(null);
    try {
      const usePicked = picked.length > 0;
      const res = await startMeaning({
        semester: usePicked ? null : range,
        passageIds: usePicked ? picked : null,
        count,
      });
      if (res.passages.length === 0) {
        setError('这个范围内暂时没有可练的篇目');
        setLoading(false);
        return;
      }
      sessionStorage.setItem('training:meaning', JSON.stringify(res.passages));
      navigate('/student/training/chinese/meaning/run');
    } catch {
      setError('开练失败，请稍后重试');
      setLoading(false);
    }
  };

  return (
    <div
      data-theme="student-day"
      data-school="junior"
      className="student-theme-container min-h-screen flex flex-col items-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-3xl px-4 sm:px-8 py-10">
        <PageHeader
          to="/student/training/chinese/special"
          caption="返回"
          title="古诗含义"
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

        {/* 篇数 */}
        <section className="mt-8">
          <h2 className="text-lg font-bold text-[var(--text-primary)]">练几首</h2>
          <div className="flex flex-wrap gap-3 mt-3">
            {COUNT_OPTIONS.map((n) => {
              const active = count === n;
              return (
                <button
                  key={n}
                  onClick={() => {
                    setCount(n);
                    setPicked((prev) => prev.slice(0, n));  // 调小后截断，比静默失效清楚
                  }}
                  className={`w-16 h-11 rounded-xl text-sm font-medium transition-colors ${
                    active ? 'text-white' : 'bg-white text-[var(--text-secondary)]'
                  }`}
                  style={active ? { backgroundColor: 'var(--brand-500)' } : CARD_BORDER}
                >
                  {n} 首
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
                <>
                  <p className="mb-2 text-xs text-[var(--text-secondary)]">
                    最多选 {count} 首（已选 {picked.length} 首）
                  </p>
                  <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {visible.map((p) => {
                      const checked = picked.includes(p.passageId);
                      return (
                        <li key={p.passageId}>
                          <label
                            className={`flex items-center gap-3 px-3 py-2 rounded-xl ${
                              !checked && atLimit
                                ? 'opacity-40 cursor-not-allowed'
                                : 'cursor-pointer hover:bg-[var(--bg-subtle)]'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!checked && atLimit}
                              onChange={() => togglePick(p.passageId)}
                              className="w-4 h-4"
                            />
                            <span className="text-sm text-[var(--text-primary)]">
                              《{p.workTitle}》
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          )}
        </section>

        {error && <p className="mt-6 text-sm text-[var(--error)]">{error}</p>}

        <button
          onClick={handleStart}
          disabled={loading}
          className="mt-10 w-full h-14 rounded-2xl text-white text-lg font-bold transition-opacity disabled:opacity-60"
          style={{ backgroundColor: 'var(--brand-500)' }}
        >
          {loading
            ? '正在抽题…'
            : picked.length > 0
              ? `开始练习（指定 ${picked.length} 首）`
              : `开始练习（随机 ${count} 首）`}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 类型检查 + 提交**

Run: `cd apps/web && npx tsc -b --noEmit`（会因 MeaningRunPage 缺失报错，Task 10 补）
Run: `cd apps/web && npm run lint` → 无 error

```bash
git add apps/web/src/routes/index.tsx apps/web/src/pages/student/training/chinese/ChineseSpecialPage.tsx apps/web/src/pages/student/training/chinese/MeaningConfigPage.tsx
git commit -m "feat(web): 古诗含义入口卡、路由与配置页"
```

> 若 Task 10 还没做导致 `tsc -b` 失败，先只 `git add` 本页面并在 Task 10 一并提交。

---

## Task 10: 前端答题页（布局 B）

**Files:**
- Create: `apps/web/src/components/business/meaning/PassageOverviewBar.tsx`
- Create: `apps/web/src/components/business/meaning/AnswerBlock.tsx`
- Create: `apps/web/src/components/business/meaning/ResultStack.tsx`
- Create: `apps/web/src/components/business/meaning/ResultItem.tsx`
- Create: `apps/web/src/pages/student/training/chinese/MeaningRunPage.tsx`
- Test: `apps/web/src/components/business/meaning/ResultStack.test.tsx`
- Test: `apps/web/src/components/business/meaning/AnswerBlock.test.tsx`

**Interfaces:**
- Consumes: `sessionStorage['training:meaning']`（`MeaningPassageItem[]`）、`POST /api/training/meaning/judge`
- 与 `InterpretationRunPage.tsx:87,124-138` 的「在途 token 防旧响应覆盖」写法保持一致

### 页面状态机（必须照此实现）

```
// 派生值，不是额外 state
cursor                       // 在「可作答句子」列表里的位置（answerable:false 的句子直接跳过）
currentIndex = answerableIdx[cursor] ?? -1
finished     = answerableIdx.length > 0 && cursor >= answerableIdx.length

type StackItem =
  | { kind: 'pending'; key; sentenceIndex; text; answer }   // 已提交，等模型
  | { kind: 'failed';  key; sentenceIndex; text; answer }   // 请求失败，可重试
  | { kind: 'judged';  key; sentenceIndex; text; answer; result }
```

转移：

| 当前 | 事件 | 下一状态 | 副作用 |
|---|---|---|---|
| `!finished` | 点「提交」 | `cursor + 1`（可能变 `finished`） | 结果栈 **unshift** 一个 `pending`；`judge` 带 `token = ++tokens.current[idx]` |
| 任意 | `judge` 成功且 token 最新 | 不变 | 对应 `pending` **原地替换**成 `judged` |
| 任意 | `judge` 成功但 token 已过期 | 不变 | **丢弃**该响应 |
| 任意 | `judge` 失败 | 不变 | 对应 `pending` 换成 `failed` |
| 任意 | 点「重新判题」 | 不变 | 同一个 `sentenceIndex` **替换**（不是新增）一条 `pending`，token 自增 |
| `finished`，还有下一首 | 点「下一首」 | `cursor = 0` | **清空结果栈**，`tokens` 重置 |
| `finished`，已最后一首 | 点「完成」 | 离开页面 | 清 `sessionStorage` 后回专项页 |

关键点：

- **一次只渲染一个 `AnswerBlock`**（当前句），不把整篇铺开。
- `sentenceIndex` 只在 `answerable === true` 的句子间推进，`answerable === false` 的句子跳过。
- `PassageOverviewBar` 渲染**全部**句子（含 `answerable:false`），当前句高亮、已答置灰，可折叠。
- `ResultStack` 渲染顺序 = 数组顺序，新项 `unshift` → **最新在最前**。

- [ ] **Step 1: 写 ResultStack 的失败测试（倒序钉子）**

创建 `apps/web/src/components/business/meaning/ResultStack.test.tsx`：

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import ResultStack from './ResultStack';
import type { StackItem } from './types';

// globals: false —— @testing-library/react 不会自动注册 cleanup，必须自己写
afterEach(() => cleanup());

const EMPTY_ANSWER = { terms: [], meaning: '', emotion: '' };

const JUDGED = (n: number): StackItem => ({
  kind: 'judged',
  key: `k${n}`,
  sentenceIndex: n,
  text: `第${n}句原文`,
  answer: EMPTY_ANSWER,
  result: {
    passageId: 12, sentenceIndex: n, allCorrect: true,
    terms: [], meaning: { correct: true, method: 'ai', standard: 'std', comment: null },
    emotion: { correct: true, method: 'ai', standard: 'std', comment: null },
  },
});

describe('ResultStack', () => {
  it('倒序渲染——最新一条排在最前面', () => {
    render(<ResultStack items={[JUDGED(1), JUDGED(2)]} onRetry={() => {}} />);
    // 数组里 index 0 是最新（新项 unshift 到头部），所以它必须先出现在 DOM 里
    const texts = screen.getAllByText(/第\d句原文/).map((el) => el.textContent);
    expect(texts[0]).toBe('第2句原文');
    expect(texts[1]).toBe('第1句原文');
  });

  it('pending 项显示「判定中…」', () => {
    render(
      <ResultStack
        items={[{ kind: 'pending', key: 'p1', sentenceIndex: 3, text: '沉舟侧畔千帆过', answer: EMPTY_ANSWER }]}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText(/判定中/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/business/meaning/ResultStack.test.tsx`
Expected: FAIL —— `Cannot find module './ResultStack'`

- [ ] **Step 3: 实现 types.ts / ResultItem.tsx / ResultStack.tsx**

创建 `apps/web/src/components/business/meaning/types.ts`：

```ts
import type { MeaningJudgeResult } from '@/services/api';

/** 学生一句的完整作答。结果栈要留着它——答完就推进下一句，输入框已经不在了。 */
export interface MeaningAnswerPayload {
  terms: Array<{ term: string; answer: string }>;
  meaning: string;
  emotion: string;
}

/**
 * 结果栈里的一条。新项一律 **unshift 进数组头部** —— 最新的一条排在最前。
 *   pending —— 已提交、等模型回来（页面显示「判定中…」）
 *   failed  —— 请求失败，可重试
 *   judged  —— 有结果
 */
export type StackItem =
  | { kind: 'pending'; key: string; sentenceIndex: number; text: string; answer: MeaningAnswerPayload }
  | { kind: 'failed';  key: string; sentenceIndex: number; text: string; answer: MeaningAnswerPayload }
  | { kind: 'judged';  key: string; sentenceIndex: number; text: string; answer: MeaningAnswerPayload; result: MeaningJudgeResult };
```

创建 `apps/web/src/components/business/meaning/ResultItem.tsx`：

```tsx
import type { MeaningPartResult, MeaningTermResultItem } from '@/services/api';
import type { StackItem } from './types';

interface Props {
  item: StackItem;
  /** 是否是栈里最新的一条（由 ResultStack 按 index === 0 传入） */
  isNewest: boolean;
  onRetry: (sentenceIndex: number) => void;
}

/** 线性 SVG（无 emoji，符合 style.md）。 */
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0" aria-hidden="true">
    <path d="M4 12.5 9.5 18 20 6.5" />
  </svg>
);

const CrossIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const DashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    strokeLinecap="round" className="w-4 h-4 shrink-0" aria-hidden="true">
    <path d="M6 12h12" />
  </svg>
);

/** 单块（含义 / 情感）的结果行：✓ 正确 / ✗ 错误（附你的 vs 标准）/ — 未判定。 */
function PartLine({ label, part, mine }: { label: string; part: MeaningPartResult; mine: string }) {
  if (part.correct === true) {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-sm text-[var(--success)]">
        <CheckIcon />{label}：正确
      </p>
    );
  }
  if (part.correct === null) {
    return (
      <p className="mt-1 flex items-start gap-1.5 text-sm text-[var(--text-secondary)]">
        <span className="mt-0.5"><DashIcon /></span>
        <span>{label}：未判定（AI 暂时没判出来，可点「重新判题」）</span>
      </p>
    );
  }
  return (
    <div className="mt-1">
      <p className="flex items-start gap-1.5 text-sm text-[var(--error)]">
        <span className="mt-0.5"><CrossIcon /></span>
        <span>{label}：{part.method === 'unanswered' ? '未作答，应为：' : '错误，应为：'}{part.standard}</span>
      </p>
      {mine.trim() !== '' && (
        <p className="mt-1 pl-[22px] text-sm text-[var(--text-secondary)]">你的：{mine}</p>
      )}
      {part.comment && (
        <p className="mt-1 pl-[22px] text-sm text-[var(--text-secondary)]">{part.comment}</p>
      )}
    </div>
  );
}

/** 字词项的结果行——多个字词各一行。 */
function TermLines({ items }: { items: MeaningTermResultItem[] }) {
  if (items.length === 0) return null;   // 该句无重点字词 → 整行不渲染
  return (
    <div className="mt-1">
      {items.map((t) => (
        <div key={t.term}>
          {t.correct === true && (
            <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
              <CheckIcon />〔{t.term}〕正确
            </p>
          )}
          {t.correct === null && (
            <p className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
              <DashIcon />〔{t.term}〕未判定
            </p>
          )}
          {t.correct === false && (
            <div>
              <p className="flex items-start gap-1.5 text-sm text-[var(--error)]">
                <span className="mt-0.5"><CrossIcon /></span>
                <span>〔{t.term}〕{t.method === 'unanswered' ? '未作答，应为：' : '应为：'}{t.standard}</span>
              </p>
              {t.comment && (
                <p className="mt-1 pl-[22px] text-sm text-[var(--text-secondary)]">{t.comment}</p>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** 结果栈里的单条。**最新的一条**（数组 index 0）左侧有 brand 色竖条。 */
export default function ResultItem({ item, isNewest, onRetry }: Props) {
  return (
    <div
      className="rounded-2xl bg-white p-4"
      style={{
        border: '1px solid rgba(226, 232, 240, 0.8)',
        borderLeft: isNewest ? '3px solid var(--brand-500)' : undefined,
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-[var(--text-secondary)]">第 {item.sentenceIndex + 1} 句</span>
        <button
          onClick={() => onRetry(item.sentenceIndex)}
          className="text-xs text-[var(--brand-500)] underline"
        >
          重新判题
        </button>
      </div>
      <p className="mt-1 text-sm text-[var(--text-primary)]">{item.text}</p>

      {item.kind === 'pending' && (
        <p className="mt-2 text-sm text-[var(--text-secondary)]">判定中…</p>
      )}

      {item.kind === 'failed' && (
        <p className="mt-2 text-sm text-[var(--error)]">判定失败，请点「重新判题」重试</p>
      )}

      {item.kind === 'judged' && (
        <div className="mt-2">
          <TermLines items={item.result.terms} />
          <PartLine label="深层含义" part={item.result.meaning} mine={item.answer.meaning} />
          <PartLine label="作者情感" part={item.result.emotion} mine={item.answer.emotion} />
        </div>
      )}
    </div>
  );
}
```

创建 `apps/web/src/components/business/meaning/ResultStack.tsx`：

```tsx
import type { StackItem } from './types';
import ResultItem from './ResultItem';

interface Props {
  items: StackItem[];
  onRetry: (sentenceIndex: number) => void;
}

/**
 * 作答结果栈。**按数组顺序渲染** —— 新项由调用方 unshift 进头部，
 * 所以数组头部（最新一次）自然渲染在最前面（设计 spec §7.3「倒序」）。
 */
export default function ResultStack({ items, onRetry }: Props) {
  if (items.length === 0) {
    return <p className="text-sm text-[var(--text-secondary)]">还没有作答记录</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {items.map((item, i) => (
        <ResultItem key={item.key} item={item} isNewest={i === 0} onRetry={onRetry} />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 跑 ResultStack 测试通过**

Run: `cd apps/web && npx vitest run src/components/business/meaning/ResultStack.test.tsx` → PASS（2 tests）

- [ ] **Step 5: 写 AnswerBlock 的失败测试**

创建 `apps/web/src/components/business/meaning/AnswerBlock.test.tsx`：

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AnswerBlock } from './AnswerBlock';

afterEach(() => cleanup());

const SENTENCE = { index: 1, text: '沉舟侧畔千帆过，病树前头万木春。', terms: [], answerable: true };

describe('AnswerBlock', () => {
  it('该句无重点字词时不渲染「重点字词」行', () => {
    render(<AnswerBlock sentence={SENTENCE} onSubmit={vi.fn()} />);
    expect(screen.queryByText('重点字词')).toBeNull();
    expect(screen.getByText('本句深层含义')).toBeTruthy();
    expect(screen.getByText('作者情感')).toBeTruthy();
  });

  it('有重点字词时每个词一个输入框', () => {
    const withTerms = { ...SENTENCE, terms: [{ term: '沉（chén）舟', plain: '沉舟' }] };
    render(<AnswerBlock sentence={withTerms} onSubmit={vi.fn()} />);
    expect(screen.getByText('重点字词')).toBeTruthy();
    expect(screen.getByLabelText('沉（chén）舟 释义')).toBeTruthy();
  });
});
```

- [ ] **Step 6: 跑测试确认失败 → 实现 AnswerBlock → 通过**

创建 `apps/web/src/components/business/meaning/AnswerBlock.tsx`：

```tsx
import { useState } from 'react';
import type { MeaningSentenceItem } from '@/services/api';
import type { MeaningAnswerPayload } from './types';

interface Props {
  sentence: MeaningSentenceItem;
  onSubmit: (payload: MeaningAnswerPayload) => void;
}

/**
 * 当前这一句的作答区。三个输入区：重点字词（该句没有则整行不渲染）、
 * 本句深层含义、作者情感。
 *
 * 父组件用 `key={sentence.index}` 挂载 —— 换句时状态自然重置，不用 useEffect 清。
 */
export function AnswerBlock({ sentence, onSubmit }: Props) {
  const [terms, setTerms] = useState<Record<string, string>>({});
  const [meaning, setMeaning] = useState('');
  const [emotion, setEmotion] = useState('');
  const empty = meaning.trim() === '' && emotion.trim() === ''
    && sentence.terms.every((t) => (terms[t.term] ?? '').trim() === '');

  return (
    <div
      className="rounded-2xl bg-white p-5"
      style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}
    >
      <p className="text-lg leading-relaxed text-[var(--text-primary)]">{sentence.text}</p>

      {sentence.terms.length > 0 && (
        <div className="mt-4">
          <p className="text-sm font-bold text-[var(--text-primary)]">重点字词</p>
          <div className="mt-2 flex flex-wrap gap-3">
            {sentence.terms.map((t) => (
              <label key={t.term} className="flex items-center gap-2">
                <span className="text-sm text-[var(--text-secondary)]">〔{t.term}〕</span>
                <input
                  aria-label={`${t.term} 释义`}
                  value={terms[t.term] ?? ''}
                  onChange={(e) => setTerms((prev) => ({ ...prev, [t.term]: e.target.value }))}
                  className="h-9 w-40 rounded-xl px-3 text-sm"
                  style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}
                />
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4">
        <p className="text-sm font-bold text-[var(--text-primary)]">本句深层含义</p>
        <textarea
          aria-label="本句深层含义"
          value={meaning}
          onChange={(e) => setMeaning(e.target.value)}
          rows={3}
          className="mt-2 w-full rounded-xl p-3 text-sm"
          style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}
        />
      </div>

      <div className="mt-4">
        <p className="text-sm font-bold text-[var(--text-primary)]">作者情感</p>
        <textarea
          aria-label="作者情感"
          value={emotion}
          onChange={(e) => setEmotion(e.target.value)}
          rows={2}
          className="mt-2 w-full rounded-xl p-3 text-sm"
          style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}
        />
      </div>

      <button
        onClick={() => onSubmit({
          terms: sentence.terms.map((t) => ({ term: t.term, answer: terms[t.term] ?? '' })),
          meaning,
          emotion,
        })}
        disabled={empty}
        className="mt-5 w-full h-12 rounded-2xl text-white font-bold transition-opacity disabled:opacity-50"
        style={{ backgroundColor: 'var(--brand-500)' }}
      >
        提交
      </button>
    </div>
  );
}
```

Run: `cd apps/web && npx vitest run src/components/business/meaning/AnswerBlock.test.tsx` → PASS（2 tests）

- [ ] **Step 7: 实现 PassageOverviewBar**

创建 `apps/web/src/components/business/meaning/PassageOverviewBar.tsx`：

```tsx
import { useState } from 'react';
import type { MeaningSentenceItem } from '@/services/api';

interface Props {
  /** 全部句子（含 answerable:false 的——诗要完整显示） */
  sentences: MeaningSentenceItem[];
  currentIndex: number;
  judgedIndexes: Set<number>;
}

/**
 * 顶部全诗原文条。**渲染全部句子**：含义常常依赖上下文（如《行路难》末句的情感
 * 要看前面「心茫然」才知道是转振作），所以未答的句子也要看得见。
 * 当前句高亮、已答的置灰；可折叠。
 */
export default function PassageOverviewBar({ sentences, currentIndex, judgedIndexes }: Props) {
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-2xl bg-white p-4" style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]"
        aria-expanded={open}
      >
        全诗原文
        <span className="text-xs font-normal text-[var(--text-secondary)]">{open ? '收起' : '展开'}</span>
      </button>

      {open && (
        <ol className="mt-3 flex flex-col gap-1.5">
          {sentences.map((s) => {
            const isCurrent = s.index === currentIndex;
            const judged = judgedIndexes.has(s.index);
            const color = isCurrent
              ? 'var(--text-primary)'
              : judged ? 'var(--text-tertiary, var(--text-secondary))' : 'var(--text-secondary)';
            return (
              <li
                key={s.index}
                className={`text-sm leading-relaxed ${isCurrent ? 'font-bold' : ''} ${judged ? 'opacity-50' : ''}`}
                style={{ color }}
              >
                {s.text}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
```

- [ ] **Step 8: 实现 MeaningRunPage**

创建 `apps/web/src/pages/student/training/chinese/MeaningRunPage.tsx`：

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/base';
import { RunExitGuard } from '@/components/business/answer/RunExitGuard';
import { judgeMeaning, type MeaningPassageDetail } from '@/services/api';
import { AnswerBlock } from '@/components/business/meaning/AnswerBlock';
import ResultStack from '@/components/business/meaning/ResultStack';
import PassageOverviewBar from '@/components/business/meaning/PassageOverviewBar';
import type { MeaningAnswerPayload, StackItem } from '@/components/business/meaning/types';

/**
 * 古诗含义答题页：**一次只出一句**，上方是固定位置的作答区，下方是倒序结果栈。
 *
 * 判题异步不阻塞：点「提交」立刻在结果栈 unshift 一条 pending、作答区马上推进到
 * 下一句，模型回来再原地替换。所以学生不会卡着等，连点快速划过也没问题
 * （空答案由服务端短路成 unanswered，不花 LLM 调用）。
 *
 * 每句各自一个在途令牌（`tokens`）——响应回来时令牌不匹配就丢弃，
 * 防「重新判题」连点导致旧响应覆盖新结果。
 */
export default function MeaningRunPage() {
  const navigate = useNavigate();
  const [passages, setPassages] = useState<MeaningPassageDetail[] | null>(null);
  const [pIdx, setPIdx] = useState(0);
  /** 在「可作答句子」列表里的位置——answerable:false 的句子直接跳过 */
  const [cursor, setCursor] = useState(0);
  const [stack, setStack] = useState<StackItem[]>([]);
  const tokens = useRef<Record<number, number>>({});
  const guardRef = useRef(true);

  useEffect(() => {
    const raw = sessionStorage.getItem('training:meaning');
    if (!raw) { navigate('/student/training/chinese/meaning', { replace: true }); return; }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        navigate('/student/training/chinese/meaning', { replace: true });
        return;
      }
      setPassages(parsed as MeaningPassageDetail[]);
    } catch {
      navigate('/student/training/chinese/meaning', { replace: true });
    }
  }, [navigate]);

  const passage = passages?.[pIdx] ?? null;
  const answerableIdx = useMemo(
    () => (passage ? passage.sentences.filter((s) => s.answerable).map((s) => s.index) : []),
    [passage],
  );
  const currentIndex = answerableIdx[cursor] ?? -1;
  const currentSentence = passage?.sentences.find((s) => s.index === currentIndex) ?? null;
  const finished = answerableIdx.length > 0 && cursor >= answerableIdx.length;

  const runJudge = async (sentenceIndex: number, answer: MeaningAnswerPayload, replace: boolean) => {
    const passageId = passage!.passageId;
    const token = (tokens.current[sentenceIndex] ?? 0) + 1;
    tokens.current[sentenceIndex] = token;
    const key = `${sentenceIndex}-${token}`;
    const text = passage!.sentences.find((s) => s.index === sentenceIndex)?.text ?? '';

    // 新项 unshift 到头部 → 最新的一次排在最前（设计 spec §7.3「倒序」）
    setStack((prev) => {
      const base = replace ? prev.filter((it) => it.sentenceIndex !== sentenceIndex) : prev;
      return [{ kind: 'pending', key, sentenceIndex, text, answer }, ...base];
    });

    try {
      const res = await judgeMeaning({ passageId, sentenceIndex, ...answer });
      if (tokens.current[sentenceIndex] !== token) return;   // 过期响应丢弃
      setStack((prev) => prev.map((it) => (
        it.key === key ? { kind: 'judged', key, sentenceIndex, text, answer, result: res } : it
      )));
    } catch {
      if (tokens.current[sentenceIndex] !== token) return;
      setStack((prev) => prev.map((it) => (
        it.key === key ? { kind: 'failed', key, sentenceIndex, text, answer } : it
      )));
    }
  };

  const handleSubmit = (answer: MeaningAnswerPayload) => {
    if (currentIndex < 0) return;
    void runJudge(currentIndex, answer, false);
    setCursor((c) => c + 1);          // 送判但**不等它回来**，立刻推进
  };

  const handleRetry = (sentenceIndex: number) => {
    const item = stack.find((it) => it.sentenceIndex === sentenceIndex);
    if (!item) return;
    void runJudge(sentenceIndex, item.answer, true);
  };

  const resetForNextPassage = () => {
    tokens.current = {};
    setCursor(0);
    setStack([]);                      // 结果栈每首清空重来（设计 spec §7.3）
  };

  const handlePassageDone = () => {
    if (passages && pIdx < passages.length - 1) {
      setPIdx(pIdx + 1);
      resetForNextPassage();
      return;
    }
    guardRef.current = false;
    sessionStorage.removeItem('training:meaning');
    navigate('/student/training/chinese/special', { replace: true });
  };

  const judgedIndexes = useMemo(
    () => new Set(stack.filter((it) => it.kind === 'judged').map((it) => it.sentenceIndex)),
    [stack],
  );

  const stats = useMemo(() => {
    const s = { termRight: 0, termWrong: 0, termUndet: 0,
                meanRight: 0, meanWrong: 0, meanUndet: 0,
                emoRight: 0, emoWrong: 0, emoUndet: 0 };
    const bump = (c: boolean | null, p: 'term' | 'mean' | 'emo') => {
      if (c === true) s[`${p}Right`]++;
      else if (c === false) s[`${p}Wrong`]++;
      else s[`${p}Undet`]++;
    };
    for (const it of stack) {
      if (it.kind !== 'judged') continue;
      for (const t of it.result.terms) bump(t.correct, 'term');
      bump(it.result.meaning.correct, 'mean');
      bump(it.result.emotion.correct, 'emo');
    }
    return s;
  }, [stack]);

  const anyPending = stack.some((it) => it.kind === 'pending');

  if (!passage) return null;

  return (
    <div
      data-theme="student-day"
      data-school="junior"
      className="student-theme-container min-h-screen flex flex-col items-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <RunExitGuard
        guardRef={guardRef}
        title="确认离开？"
        message="离开后本篇已作答的内容不会保留。"
        confirmLabel="确认离开"
        cancelLabel="继续答题"
      />

      <div className="w-full max-w-3xl px-4 sm:px-8 py-10">
        <PageHeader
          to="/student/training/chinese/meaning"
          caption="退出"
          title="古诗含义"
          titleClassName="text-4xl font-extrabold"
        />

        <p className="mt-6 text-sm text-[var(--text-secondary)]">
          《{passage.workTitle}》{'\u3000'}
          {passages && passages.length > 1 ? `第 ${pIdx + 1} / ${passages.length} 首 · ` : ''}
          第 {Math.min(cursor + 1, answerableIdx.length)} / {answerableIdx.length} 句
        </p>

        <div className="mt-4">
          <PassageOverviewBar
            sentences={passage.sentences}
            currentIndex={currentIndex}
            judgedIndexes={judgedIndexes}
          />
        </div>

        <div className="mt-5">
          {!finished && currentSentence ? (
            <AnswerBlock key={currentSentence.index} sentence={currentSentence} onSubmit={handleSubmit} />
          ) : (
            <div className="rounded-2xl bg-white p-6" style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}>
              <h3 className="text-lg font-bold text-[var(--text-primary)]">本篇完成</h3>
              {anyPending && (
                <p className="mt-2 text-sm text-[var(--text-secondary)]">还有句子在判题中，结果会自动补上。</p>
              )}
              <ul className="mt-3 flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
                <li>重点字词：对 {stats.termRight} · 错 {stats.termWrong}{stats.termUndet > 0 ? ` · 未判定 ${stats.termUndet}` : ''}</li>
                <li>深层含义：对 {stats.meanRight} · 错 {stats.meanWrong}{stats.meanUndet > 0 ? ` · 未判定 ${stats.meanUndet}` : ''}</li>
                <li>作者情感：对 {stats.emoRight} · 错 {stats.emoWrong}{stats.emoUndet > 0 ? ` · 未判定 ${stats.emoUndet}` : ''}</li>
              </ul>
              <button
                onClick={handlePassageDone}
                className="mt-6 w-full h-12 rounded-2xl text-white font-bold"
                style={{ backgroundColor: 'var(--brand-500)' }}
              >
                {passages && pIdx < passages.length - 1 ? '下一首' : '完成'}
              </button>
            </div>
          )}
        </div>

        <h3 className="mt-8 text-lg font-bold text-[var(--text-primary)]">作答结果（最新在最前）</h3>
        <div className="mt-3">
          <ResultStack items={stack} onRetry={handleRetry} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 9: 全量前端回归**

Run: `cd apps/web && npm test` → 全部 PASS（含新增 4 条渲染测试）
Run: `cd apps/web && npm run build` → PASS

- [ ] **Step 10: 提交**

```bash
git add apps/web/src/components/business/meaning apps/web/src/pages/student/training/chinese/MeaningRunPage.tsx
git commit -m "feat(web): 古诗含义答题页（一次一句 + 倒序结果栈 + 异步占位）"
```

---

## Task 11: 内容管线 meaning_cli.py

**Files:**
- Create: `tools/data-refinery/src/meaning_cli.py`
- Test: `tools/data-refinery/tests/test_meaning_cli.py`

**Interfaces:**
- Consumes: `chinese_passages` 的 `id` / `work_title` / `sentences`
- Produces: `UPDATE chinese_passages SET sentence_meanings = %s WHERE id = %s`（**只这一列**）

### 行为约定

```
python src/meaning_cli.py --export --input inputs/meaning/诗词含义.md   # 出带原文的空模板
python src/meaning_cli.py --apply  --input inputs/meaning/诗词含义.md   # 幂等入库
```

模板格式：

```md
# 酬乐天扬州初逢席上见赠

## 第1句
> 巴山楚水凄凉地，二十三年弃置身。
含义：
情感：
```

`--apply` 逐步逻辑：

1. 连库，取全部 `(id, work_title, sentences)`
2. 解析模板 → `{篇名归一: [(原文, 含义, 情感), ...]}`
3. 每篇：把库里 `sentences` 的 `text` 归一（去空白）建索引
4. **按原文定位下标** —— 不按行号、不做整体长度断言。定位到就写，定位不到写进 `-review.md` 并跳过
5. 组装长度 `= len(sentences)` 的数组，没填的位置写 `null`
6. `UPDATE chinese_passages SET sentence_meanings = %s WHERE id = %s`（**只这一列**，
   `verified` / `is_active` / `memorize_required` 在语句里根本不出现）
7. 写 `-review.md`：每篇句数、填了几句、跳过了哪几句

- [ ] **Step 1: 写失败测试**

创建 `tools/data-refinery/tests/test_meaning_cli.py`：

```python
from src.meaning_cli import build_meanings_array, parse_template


TEMPLATE = """# 酬乐天扬州初逢席上见赠

## 第1句
> 巴山楚水凄凉地，二十三年弃置身。
含义：写被贬之地的荒凉。
情感：辛酸

## 第2句
> 沉舟侧畔千帆过，病树前头万木春。
含义：比喻新事物必将取代旧事物。
情感：豁达乐观
"""


def test_parse_template():
    got = parse_template(TEMPLATE)
    assert list(got) == ["酬乐天扬州初逢席上见赠"]
    entries = got["酬乐天扬州初逢席上见赠"]
    assert entries[0] == ("巴山楚水凄凉地，二十三年弃置身。", "写被贬之地的荒凉。", "辛酸")


def test_build_meanings_array_按原文定位下标():
    sentences = [
        {"text": "巴山楚水凄凉地，二十三年弃置身。"},
        {"text": "沉舟侧畔千帆过，病树前头万木春。"},
        {"text": "今日听君歌一曲，暂凭杯酒长精神。"},  # 人工没填这句
    ]
    entries = parse_template(TEMPLATE)["酬乐天扬州初逢席上见赠"]
    arr, skipped = build_meanings_array(sentences, entries)
    # 长度与 sentences 对齐；第 3 句没填 → null（不是压缩掉，否则整体错位）
    assert arr == [
        {"meaning": "写被贬之地的荒凉。", "emotion": "辛酸"},
        {"meaning": "比喻新事物必将取代旧事物。", "emotion": "豁达乐观"},
        None,
    ]
    assert skipped == []


def test_build_meanings_array_调序也不会错位():
    sentences = [
        {"text": "沉舟侧畔千帆过，病树前头万木春。"},
        {"text": "巴山楚水凄凉地，二十三年弃置身。"},
    ]
    entries = parse_template(TEMPLATE)["酬乐天扬州初逢席上见赠"]
    arr, _ = build_meanings_array(sentences, entries)
    assert arr[0]["emotion"] == "豁达乐观"   # 跟着原文走，不是跟着行号走
    assert arr[1]["emotion"] == "辛酸"


def test_build_meanings_array_对不上的原文进 skipped():
    sentences = [{"text": "今日听君歌一曲，暂凭杯酒长精神。"}]
    entries = parse_template(TEMPLATE)["酬乐天扬州初逢席上见赠"]
    arr, skipped = build_meanings_array(sentences, entries)
    assert arr == [None]
    assert len(skipped) == 2
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python -m pytest tests/test_meaning_cli.py -v`
Expected: FAIL —— `ModuleNotFoundError: src.meaning_cli`

- [ ] **Step 3: 实现**

创建 `tools/data-refinery/src/meaning_cli.py`，至少包含：

```python
def parse_template(text: str) -> dict[str, list[tuple[str, str, str]]]:
    """解析人工填写的模板 → {篇名归一: [(原文, 含义, 情感), …]}。"""


def _norm(s: str) -> str:
    """原文归一：去所有空白（全角/半角），用于按原文定位下标。"""
    return "".join(s.split())


def build_meanings_array(
    sentences: list[dict], entries: list[tuple[str, str, str]]
) -> tuple[list[dict | None], list[str]]:
    """按**原文**定位下标，产出与 sentences 等长的数组；对不上的原文进 skipped。"""
```

再加 `parse_args` / `--export` / `--apply` / `_connect` / `_fetch_passages` / `_write_review`，
以及 `--apply` 里唯一的写库语句：

```python
cur.execute("UPDATE chinese_passages SET sentence_meanings = %s WHERE id = %s",
            (json.dumps(arr, ensure_ascii=False), row_id))
```

> 配置读取沿用 `from config import RefineryConfig`；本管线**不调 LLM**。

- [ ] **Step 4: 跑测试通过**

Run: `cd tools/data-refinery && python -m pytest tests/test_meaning_cli.py -v` → PASS（4 tests）

- [ ] **Step 5: 全量回归 + 提交**

Run: `cd tools/data-refinery && python -m pytest` → 全部 PASS

```bash
git add tools/data-refinery/src/meaning_cli.py tools/data-refinery/tests/test_meaning_cli.py
git commit -m "feat(refinery): 古诗含义内容管线 meaning_cli（--export / --apply）"
```

---

## Task 12: 端到端手工验收

**Files:** 无（验证；发现问题就地修）

- [ ] **Step 1: 灌一篇诗的含义数据**

手工在库里挑一首已 `verified=1` 的诗（如《酬乐天扬州初逢席上见赠》），
`--export` 出模板 → 填 2–3 句 → `--apply` 入库。
Run: `mysql -u ai_k12 -p ai_k12 -e "SELECT work_title, JSON_LENGTH(sentence_meanings) FROM chinese_passages WHERE sentence_meanings IS NOT NULL;"`
Expected: 能看到该篇与条数。

- [ ] **Step 2: 起后端并跑一遍接口**

Run: `cd apps/server && npm run build && node dist/main.js`

```bash
# 清单应只含刚灌的那一篇
curl -s localhost:3000/api/training/meaning/passages -H "Authorization: Bearer $TOKEN"
# start 的响应里不得出现含义/情感/译文/作者
curl -s -X POST localhost:3000/api/training/meaning/start \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"semester":null,"passageIds":null,"count":1}'
```

- [ ] **Step 3: 前端跑一遍完整流程**

Run: `cd apps/web && npm run dev`

验收清单（spec §10）：
1. 语文专项页有三张卡，「古诗含义」可点进
2. 配置页选 1 首 → 开始
3. 答题页顶部有全诗原文条、当前句高亮
4. **一次只有一句**作答区，三个框（字词 / 深层含义 / 作者情感）
5. 点提交 → 结果栈顶部出现「判定中…」，作答区**立即**推进到下一句
6. 结果回填，**最新一条在最前**
7. 整首答完出小结卡
8. 全程响应里**无**含义/情感/译文提前泄露（Network 面板核 `start` 的响应）

- [ ] **Step 4: 把验收发现的问题就地修掉并提交**

---

## 自检清单（写完后自查）

- Spec §2 的 15 条裁决，逐条能指到任务：1→Task 8/9、2→Task 3/10、3→Task 5、4/5/6→Task 10、7→Task 10（`PassageOverviewBar`）、8/9→Task 5、10→Task 11、11→Task 1/2、12→Task 1、13→Task 6/9、14→Task 4、15→Task 6
- Spec §5 三个端点的校验/逐步逻辑/边界/错误码/返回形状：Task 5 与 Task 6 的「端点级行为约定」已逐条写明
- Spec §7 前端：Task 8/9/10 覆盖，UI 状态机写在 Task 10
- Spec §8 测试：Task 4（capability）、Task 5（service 9 条含防泄题与「无 exact」钉子）、Task 6（controller 6 条）、Task 10（4 条渲染测试，含倒序钉子）、Task 11（CLI 4 条）
- Spec §3 数据模型、§4 内容管线、§6 ai-core 8 处：Task 1、Task 11、Task 4
- 无 TBD / TODO / 「类似 Task N」/ 只描述不展示代码的步骤
