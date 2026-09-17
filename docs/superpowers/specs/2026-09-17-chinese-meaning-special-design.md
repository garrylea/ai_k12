# 古诗含义专项 · 设计

日期：2026-09-17
状态：**待实施**
相关：`docs/api/openapi.yaml`、`docs/API接口与数据流设计文档.md`、`apps/server/src/modules/training/`、`tools/data-refinery/src/interpretation_cli.py`

---

## 1. 定位与边界

训练轨「**训练 → 语文 → 专项 → 古诗含义**」是语文古诗文下的**第三个专项**，与**默写**、**解释（翻译）** 并列。

练的是「**这一句到底在说什么、作者借此表达什么情感**」——理解层，**不是**字面翻译层（那是解释专项）。
作答单位仍是**篇目**（一首诗），判题粒度是**逐句**。

**边界（勿泛化）**：复用 `chinese_passages` 表、自己的端点（`/api/training/meaning/*`）、自己的页面。
**不挂 `questions`、不进错题本、不参与主线清零门禁、不用「不再展示」/提示缓存/自评。**
与默写/解释同规矩，理由同《2026-09-15-chinese-interpretation-special-design.md》§1。

**只做诗词**：文言文没有「作者情感」这一层，本专项不为文言文篇目灌含义数据。
这由**数据有无**天然实现——不加体裁标记列（见 §3.3）。

---

## 2. 定案清单

用户逐项裁决过。改这里之前先确认不是把某个刻意的决定「统一」掉了。

| # | 议题 | 结论 |
|---|---|---|
| 1 | 与解释专项的关系 | **并列新专项**，独立入口。解释专项问「字面翻译」，本专项问「深层含义 + 作者情感」，是两种不同的训练 |
| 2 | 每句作答项 | **三个框**：① 该句重点字词释义 ② 本句深层含义 ③ 作者情感。三项各判对错 |
| 3 | 重点字词数据 | **复用现有 `key_terms`**（已带 `sentenceIndex`），不另建一套 |
| 4 | 每次出几句 | **一次只出一句**；答完提交后才推进下一句。**不是**解释专项那种整篇一次铺开 |
| 5 | 页面布局 | **B：作答区固定在上方，下方是结果栈**。顶部另有全诗原文条 |
| 6 | 结果排序 | **倒序——最新一次排在最前面** |
| 7 | 上下文 | **顶部给全诗原文条**（可折叠，当前句高亮、已答置灰）。可见全局，但不影响「一次只答一句」 |
| 8 | 判题方式 | **纯 LLM**：学生答案 + 库里标准答案一起交给 LLM 判。**不做**字符串归一化全等短路、**不做**长度比较 |
| 9 | 空答案 | 一个字没写 → `unanswered` 直接判错，**不调 LLM**（省一次调用，无歧义） |
| 10 | 内容来源 | **人工手写 Markdown**。`--export` 出带原文的空模板 → 人工填 → `--apply` 幂等入库 |
| 11 | 篇目范围 | **只做诗词**，文言文篇目该列留 `NULL` |
| 12 | 含义/情感存哪 | **`chinese_passages` 加一列**（不是新表、也不是塞进 `sentences` JSON） |
| 13 | 一个训练单元 | 配置页选 **1 / 2 / 3 首** |
| 14 | LLM 场景 | 新增 `chinese_meaning_judge`：primary=`local`、fallback=`deepseek-flash` |
| 15 | 后端代码组织 | **独立 `meaning.controller.ts` / `meaning.service.ts`**，仍挂在 `TrainingModule` 下（仿英语背单词的分法） |

### 2.1 与解释专项的**有意**差异（勿「统一」掉）

| 维度 | 解释专项 | 含义专项 |
|---|---|---|
| 标准答案来源 | `sentences[].translation`（管线生成） | `sentence_meanings[].meaning/emotion`（**人工手写**） |
| 判题短路 | 有：归一化全等 → `exact`，不进 LLM | **无**。只有空答案走 `unanswered` |
| `method` 枚举 | `exact` / `ai` / `unanswered` / `undetermined` | `ai` / `unanswered` / `undetermined` |
| 一次出几句 | 整篇全部铺开 | **一次一句** |
| 结果呈现 | 原地回填在每句下面 | **下方结果栈，倒序** |
| 抽题池 | `JSON_LENGTH(sentences) > 0` | 再加 `sentence_meanings IS NOT NULL` |

---

## 3. 数据模型

### 3.1 新列 `sentence_meanings`

挂在既有 `chinese_passages` 上，**与 `sentences` 下标对齐**的 JSON 数组：

```json
[
  {"meaning": "沉船旁千帆竞发，枯树前万木争春；比喻新事物必将取代旧事物。",
   "emotion": "豁达乐观、积极进取"}
]
```

- **下标即句序**。`sentence_meanings[i]` 对应 `sentences[i]`。
- 某一句没有含义数据时，该位置写 `null`（不是省略——省略会让后面整体错位）。
- 运行时**没有标准含义的句子不出题**，但仍在顶部原文条里显示（诗要完整）。

**为什么是独立新列，而不是塞进 `sentences` JSON**：
`interpretation_loader.py:80-135` 是全量 `UPDATE chinese_passages SET sentences=%s ...`。
若把 `meaning`/`emotion` 并进 `sentences`，**重跑一次解释管线就会把含义数据整列抹掉**。分列存是硬要求。

**为什么不是新表**：含义/情感是篇目的属性，篇目已在 `chinese_passages`；加一列即可，新表是过度设计。

### 3.2 迁移

新建 `tools/db/migrations/2026-09-17_chinese_sentence_meanings.sql`，并同步进 `tools/db/schema.sql`。
**幂等**：先查 `information_schema.COLUMNS` 再 `ADD`（照抄 `2026-09-16_chinese_interpretation_columns.sql:19-32` 的写法）。
**只有 `ADD COLUMN`，没有任何 `DELETE` / `DROP`**（2026-09-15 级联删题事故的教训）。

```sql
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

### 3.3 不加体裁列

「只做诗词」由**数据有无**实现：只给诗词篇目灌 `sentence_meanings`，文言文留 `NULL`。
抽题池加 `sentence_meanings IS NOT NULL` 即可，**无需 `genre` 标记列**。
好处：以后想让文言文也进这个专项，直接灌数据就行，代码一行不用动。

### 3.4 抽题池

```sql
-- 在解释专项 INTERPRETATION_GATE 基础上多一个「有含义数据」
dp.verified = 1
AND dp.is_active = 1
AND JSON_LENGTH(dp.sentences) > 0
AND dp.sentence_meanings IS NOT NULL
```

其余沿用 `chinese-passages.repo.ts:203-229`：随机 `ORDER BY RAND() LIMIT ?`（用 `pool.query`），
全部册次时按篇名去重取 `MIN(id)`，指定篇目走 `findVerifiedByIds*`。

---

## 4. 内容管线

新增 `tools/data-refinery/src/meaning_cli.py`，复用 `answer_importer` 的 **`--export` / `--apply`** 两步模式。

### 4.1 `--export`：出带原文的空模板

按篇目导出 Markdown，**每句原文已预填**，人工只需填两个空：

```md
# 酬乐天扬州初逢席上见赠

## 第1句
> 巴山楚水凄凉地，二十三年弃置身。
含义：
情感：

## 第2句
> 怀旧空吟闻笛赋，到乡翻似烂柯人。
含义：
情感：
```

### 4.2 `--apply`：按原文定位，幂等写入

- **按每句原文在 `sentences` 里定位下标**，不按行号、不做整体长度断言。
  人工漏填、跳填、调序都不会造成错位。
- 定位不到的句子：写进 `-review.md` 并**跳过**（不中断整批）。
- **只 `UPDATE` `sentence_meanings` 一列**，`verified` / `is_active` / `memorize_required`
  在语句里根本不出现（照 `interpretation_loader.py:80-135` 的规矩——管线重跑绝不刷掉人工标定）。
- 篇目按 `work_title` 归一定位；重复收录（九上/九下）时两册都写，与解释管线一致。
- 产出 `<name>-review.md`：每篇句数、填了哪几句、跳过了哪几句。

### 4.3 配置

沿用 refinery 专属的 `.env` 的 `LLM_BASE_URL` / `LLM_AUTH_TOKEN`。
**本管线不调 LLM**（纯解析 + 入库），所以这两个变量用不上；若以后加「LLM 预填草稿」再说。

---

## 5. 端点契约

三个端点，前缀 `/api/training/meaning`，独立 controller（`meaning.controller.ts` / `meaning.service.ts`，
注册进 `TrainingModule`，DTO 在 `dto/meaning.dto.ts`）。

> 契约同步：`docs/api/openapi.yaml` 与 `docs/API接口与数据流设计文档.md` 必须同步（项目硬规则）。
> 注意 Nest `@Post` 默认 **201**，新端点按实际记 `'201'`。

### 5.1 `GET /api/training/meaning/passages`

配置页「指定篇目」勾选清单。**只有名字，没有内容**。

```ts
{ passages: Array<{ passageId: number; workTitle: string; semester: string }> }
```

### 5.2 `POST /api/training/meaning/start`

入参 `{ semester: '上册' | '下册' | null; passageIds: number[] | null; count: 1 | 2 | 3 }`
（形状与解释专项 `start` 完全一致）。

出参：

```ts
{ passages: Array<{
    passageId: number;
    workTitle: string;
    semester: string;
    sentences: Array<{
      index: number;                              // 真实句下标，判题回传用
      text: string;                               // 该句原文
      terms: Array<{ term: string; plain: string }>; // term 带注音展示用；plain 去注音供高亮
      answerable: boolean;                        // false = 无标准含义，只显示不出题
    }>;
  }> }
```

要点：

- **整篇句子的 `text` 一次给全**——顶部全诗原文条要渲染完整的一首诗。
- **`answerable`** 区分「显示」与「出题」：没有 `sentence_meanings[i]` 的句子 `answerable:false`，
  前端仍显示在顶部原文条，但不进作答队列。
- **白名单序列化（防泄题）**：`meaning` / `emotion` / `translation` / `full_translation` /
  `author` / `dynasty` / `body` 一律**不下发**（照 `training.service.ts:266-280`）。
- 指定篇目多于 `count` 时截断（与 `startDictation` 同规矩）。
- 篇目没有任何 `answerable` 句子 → **不下发该篇**（避免空白卡）。

### 5.3 `POST /api/training/meaning/judge`

入参：

```ts
{ passageId: number; sentenceIndex: number;
  terms: Array<{ term: string; answer: string }>;
  meaning: string; emotion: string }
```

出参：

```ts
{ passageId: number; sentenceIndex: number;
  allCorrect: boolean;                            // 全部 correct === true 才 true；有 null 即 false
  terms:   Array<{ term: string; correct: boolean | null; method: Method; standard: string; comment: string | null }>;
  meaning: { correct: boolean | null; method: Method; standard: string; comment: string | null };
  emotion: { correct: boolean | null; method: Method; standard: string; comment: string | null } }

type Method = 'ai' | 'unanswered' | 'undetermined';   // 注意：没有 'exact'
```

处理顺序（照 `training.service.ts:296-400` 的三段式，但**去掉归一化短路**）：

1. **空答案短路**：`terms[].answer` / `meaning` / `emotion` 去掉空白后为空 →
   该项 `method:'unanswered'`、`correct:false`、`comment:null`，**不进 LLM**。
2. 其余项**打包成一次 LLM 调用**（该句的字词 + 含义 + 情感一次问完，省往返）。
3. 模型漏项 / 整次调用失败 → 该项 `method:'undetermined'`、`correct:null`；
   **已判项不清空、不抛错**（判题服务不可用不该让学生连「哪些已经对了」都看不到）。

学生答案配对：同名 `term` 取最后一条，多传的 `term` 忽略——服务端只认该句「应有」的字词。

错误码：篇目不存在 `404`；`sentenceIndex` 越界 `400`；该句无标准含义（`answerable:false`）`400`。

**纯读**：不写任何学生状态、不进错题本。

---

## 6. ai-core 场景 `chinese_meaning_judge`

新增场景要改 **8 处**（项目硬规则）：

1. `types.ts` 的 scene union（两处：请求与路由类型）
2. `model-routes.yaml`：`chinese_meaning_judge: [{subject:"*", primary: local, fallback: deepseek-flash}]`
3. `retry.yaml`：`chinese_meaning_judge: 30000`（与 `interpretation_judge` 同）
4. `prompts/meaning/judge.md` 新模板
5. `prompt-builder.ts` 的 `resolveTemplatePath` 分支
6. capability 类 `capabilities/chinese-meaning-judge.capability.ts`
7. seed 脚本 `src/scripts/seed-chinese-meaning-judge-route.ts`（幂等写 `llm_routes`）
8. `admin-models.service.ts` 的 `SCENES` 白名单（漏了后台下拉选不到；有漂移守卫用例钉着）

**capability 细节**（照 `interpretation-judge.capability.ts:79-91`）：

```ts
responseFormat: 'json_object',
...(model.provider === 'local' ? { extraBody: LLAMA_CPP_NO_THINKING_BODY } : {}),
```

只对本地端点下发关 thinking；云端 fallback 不传（留着思考，判题质量更稳）。

### 6.1 prompt 口径（`prompts/meaning/judge.md`）

承袭 `prompts/interpretation/judge.md` 的骨架（`## System Prompt` / `## User Message` 分段 + JSON 输出），
但判定对象换成含义与情感：

- **深层含义**：说对**核心意思**就算过——换个说法、语序不同、详略不同、比标准答案短，都算过。
  只有**关键意象理解错**、**意思偏离/说反了**才判错。
- **作者情感**：**方向对就算过**（「思乡」＝「思念故乡」，「豁达」＝「乐观旷达」）。
  只有**方向反了**（把豁达答成悲凉、把乐观答成愤懑）才判错。
- **字词释义**：说对核心义项就算过（与解释专项同口径）。
- **comment**：判错时给一句 ≤60 字的具体改进提示（指出错在哪、该怎么理解）；判对给 `null`。
- 输出：`{"terms":[{"term":"…","correct":false,"comment":"…"}],"meaning":{...},"emotion":{...}}`，
  硬性要求 `terms` 只能出现请求中给出的字词、项数与顺序一致。

---

## 7. 前端

### 7.1 入口

`ChineseSpecialPage.tsx` 加第三张卡「**古诗含义**」（副标题「深层含义 · 作者情感」），
线性 SVG 图标、**无 emoji**，路由 `/student/training/chinese/meaning`。

图标底色沿用 **brand 橙渐变 `#FF6B35 → #FFB25A`**，不引入第三种颜色。
（既有的解释卡用了蓝色 `#3B82F6`，与「配色只有一套」本身有出入，本次不动。）

### 7.2 `MeaningConfigPage.tsx`

沿用解释专项配置页：范围（全部 / 上册 / 下册）+ 篇数 **1 / 2 / 3 首** + 指定篇目（勾选上限 = 篇数）。
题单经 `sessionStorage['training:meaning']` 交接给答题页。

### 7.3 `MeaningRunPage.tsx`（布局 B）

```
┌ 顶部：全诗原文条（可折叠；当前句高亮、已答置灰）──────────┐
├ 中部：当前句作答区（位置固定）──────────────────────────┤
│   沉舟侧畔千帆过，病树前头万木春。                        │
│   重点字词   〔沉舟〕[____]   〔万木春〕[____]            │
│   本句深层含义  ┌────────────────────────────┐           │
│   作者情感      ┌────────────────────────────┐           │
│                                        [提交]            │
├ 下部：作答结果（最新在最前）─────────────────────────────┤
│  ▌第 2 句  怀旧空吟闻笛赋…   ✗ 1 项   ← 最新              │
│    第 1 句  巴山楚水凄凉地…   ✓ 全对                      │
└──────────────────────────────────────────────────────┘
```

- **异步**：点提交 → **立即**在结果栈顶部插一条「判定中…」占位 → 作答区马上推进到下一句 →
  LLM 返回后**原地替换**该占位。这样「最新在最前」始终成立，学生不用等。
- 每句一个在途 token，防旧响应覆盖新结果（复用 `InterpretationRunPage.tsx:87,124-138` 的写法）。
- 结果项内容：字词 / 含义 / 情感 各自 ✓✗；判错的在下面并列「你的」与「标准」+ comment；
  `undetermined` 显示「未判定」+ 「重新判题」按钮。
- 该句无重点字词时**不渲染**字词行。
- **多首**：按篇依次推进，**结果栈每首清空重来**（小结卡即该首的收尾）。
  一首答完给该首小结卡（字词 x/y · 含义 x/y · 情感 x/y）→ 「下一首」；全部答完给总结。
- 主题：训练轨内硬编码 `data-theme="student-day"`（无切换按钮），`data-school` 只调字号。

### 7.4 组件落点

`src/components/business/meaning/`：`AnswerBlock.tsx`（当前句作答区）、
`ResultStack.tsx`（倒序结果栈）、`ResultItem.tsx`（单条结果 + 标准答案对照）、
`PassageOverviewBar.tsx`（顶部全诗原文条）。
路由在 `src/routes/index.tsx` 注册，与解释专项平行。

---

## 8. 测试

### 8.1 后端（vitest）

- `judge` 三条路径：空答案 → `unanswered` **且确未调 LLM**；LLM 成功 → `ai`；
  LLM 漏项/整次失败 → `undetermined`，**已判项不清空、不抛错**。
- `judge` 只填部分项（只填含义、情感留空）→ 情感 `unanswered`，含义照判。
- `start` **防泄题钉子**：响应序列化后**不得出现** `meaning` / `emotion` / `translation` /
  `full_translation` / `author` / `dynasty` / `body`。
- 抽题池：只出 `sentence_meanings IS NOT NULL` 的篇目；指定篇目多于 `count` 时截断。
- 边界：篇目不存在 `404`；`sentenceIndex` 越界 `400`；`answerable:false` 的句子 `400`。
- 类型守卫：`method` 枚举**不含** `exact`（钉住「不做程序短路」这个决定）。

### 8.2 前端

- `ResultStack` **渲染钉子：结果倒序、最新一条在最前**（用户明确要的行为，防回归）。
- `AnswerBlock` 渲染：无字词时不渲染字词行；pending 占位态。
- `ResultItem` 渲染：判错时「你的」与「标准」并列；`undetermined` 显示「未判定」。
- `globals: false` → 每个用例文件自己写 `afterEach(() => cleanup())`。

### 8.3 ai-core

- 新场景 8 处改动：沿用现有 `SCENES` 白名单漂移守卫用例。
- capability：local 传 `extraBody` 关 thinking，云端 fallback 不传。

### 8.4 CLI（pytest）

- `--export` 模板每句带原文。
- `--apply` **按原文定位下标**（不是按行号）；漏填跳过并进 `-review.md`。
- `--apply` 只 UPDATE `sentence_meanings`，不断言/不触碰 `verified` / `is_active`。

---

## 9. 明确不做（YAGNI + 硬规则）

- 不进错题本、不写任何学生进度、不参与主线清零门禁。
- 无提示缓存、无自评、无「不再展示」、无隐藏题。
- 不加体裁标记列、不做音标、不做全文主旨卡（无数据）。
- 不做「LLM 预填含义草稿」（用户选了人工手写）。
- 不改 `ChineseSpecialPage` 现有的蓝色解释卡配色。
- 不做小程序（项目硬规则）。

---

## 10. 验收口径

端到端跑通一次：配置页选 1 首诗 → 答题页逐句作答 3 个框 → 提交后结果栈顶部出现「判定中…」
并立即推进下一句 → 结果回填、倒序排列 → 整首答完出小结卡 → 全程**无**含义/情感/译文提前泄露。
