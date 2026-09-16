# 古诗文解释（翻译）专项 — 实施计划

- 日期：2026-09-16
- 依据：`docs/superpowers/specs/2026-09-15-chinese-interpretation-special-design.md`
  （该 spec 的「独立化改造」那半已于 2026-09-15 完成，本文只做「解释专项」这半）
- 状态：**待用户确认后开工**

---

## 0. 先说清楚：本文相对既有 spec 改了什么

用户 2026-09-16 裁决，**覆盖** spec 原设计三处。这三处是本文与 spec 冲突的全部来源，其余一律照 spec。

| 项 | spec 原设计（§4 决策 4/5/9、§7） | 本文（用户裁决） |
|---|---|---|
| 答题形态 | 区段一「全部字词」+ 区段二「全部句子」一次答完 | **三行对译**：行1 原文 → 行2 该句的关键字词框（无则整行不出现）→ 行3 整句翻译框 |
| 判题粒度 | **整篇一次批量** LLM 调用，返回全部项 | **逐句判**：每句答完立即调 LLM，立即出对错，学生当场改 |
| 内容管线 | extract → load 全量 50 篇入库 | **本轮不碰内容**，只写代码；库里 `key_terms`/`sentences` 全空 |

连带的两处模型调整（新 UI 的硬需求，非我自由发挥）：

1. **`key_terms` 每项增 `sentenceIndex`** —— 「这一句有哪些关键字词」必须能从数据里直接读出来。spec §6.1 的 `key_terms` 是平铺列表，没有句子归属，新 UI 无法渲染行 2。
2. **抽题池加「内容就绪」守卫** —— 解释专项抽题池 = `verified=1 AND is_active=1 AND JSON_LENGTH(sentences) > 0`。不加这条，本轮 50 篇全部无内容，配置页会给出点进去没题目的篇目。

---

## 1. 数据模型

### 1.1 迁移 `tools/db/migrations/2026-09-16_chinese_interpretation_columns.sql`

**纯 `ADD COLUMN`，没有任何 DELETE / DROP**（对照 2026-09-15 那次迁移因级联删题清空 50 行的教训）。幂等写法照 `2026-09-13_add_dictation_memorize_required.sql`：`information_schema` 判列存在 → `SET @ddl := IF(...)` → `PREPARE/EXECUTE/DEALLOCATE`。三列各一段。

```sql
ALTER TABLE chinese_passages
  ADD COLUMN key_terms JSON DEFAULT NULL AFTER body,
  ADD COLUMN sentences JSON DEFAULT NULL AFTER key_terms,
  ADD COLUMN full_translation TEXT DEFAULT NULL AFTER sentences;
```

同表折回 `tools/db/schema.sql`（`install_mysql.sh` 只跑 schema.sql）。

### 1.2 三列的形状（约定，写进数据库设计文档 §3.14）

```jsonc
// key_terms：重点字词。sentenceIndex 必填，指向 sentences 的下标
[ { "term": "谪守", "gloss": "因罪贬谪流放，出任外官", "src": "textbook", "sentenceIndex": 0 } ]

// sentences：逐句。text 含句末标点
[ { "text": "庆历四年春，滕子京谪守巴陵郡。", "translation": "庆历四年的春天，滕子京被贬到巴陵郡做太守。" } ]

// full_translation：整篇译文（TEXT，非 JSON）
```

**不变式**：`''.join(s.text for s in sentences) == body`，逐字相等（含标点）。入库自检断言它。

**驱动差异（两侧都要钉单测）**：
- Node 侧 mysql2 读 JSON 列**已自动 parse**，服务端**不要再 `JSON.parse`**（会抛错）；写时须 `JSON.stringify`。
- Python 侧 pymysql 读回来是**字符串**，须 `json.loads`；写用 `json.dumps`。

### 1.3 抽题池对照表（改动后）

| 专项 | 抽题池谓词 | 改动 |
|---|---|---|
| 默写 | `verified=1 AND memorize_required=1 AND is_active=1` | **一字不动** |
| 解释 | `verified=1 AND is_active=1 AND JSON_LENGTH(sentences) > 0` | 新增 |

两者差异是**有意的**（spec §4 决策 11）：要背诵不是要理解翻译的必要条件，故解释不设 `memorize_required`；但解释多一条「内容就绪」。

---

## 2. 接口清单（共 3 个）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/training/interpretation/passages` | 配置页篇目清单（供「指定篇目」勾选） |
| POST | `/api/training/interpretation/start` | 抽 N 篇（随机）+ 下发句子/字词骨架 |
| POST | `/api/training/interpretation/judge` | 判**一句**（字词 + 整句翻译） |

三个端点都在 `TrainingController`，类级已有 `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles('student')`，无需重复声明。

`GET interpretation/passages` 照 `listDictationPassages` 抄，走解释专项抽题池（§1.3），**只出 `passageId` / `workTitle` / `semester`** —— 释义与译文是答案，清单里绝不下发。

---

## 3. 接口一：`POST /api/training/interpretation/start`

### 3.1 请求

```jsonc
{ "semester": "上册",     // "上册" | "下册" | null（null=全部册次）
  "passageIds": null,     // null=随机抽；非空数组=按指定篇目出题（忽略 semester）
  "count": 3 }            // 1..3
```

### 3.2 Controller 校验（逐条，任一条不过即 400）

| 检查 | 条件 | 失败响应 |
|---|---|---|
| C1 | `Number.isInteger(count) && count >= 1 && count <= 3` | 400 `count 仅允许 1-3 的整数` |
| C2 | `semester === null \|\| semester === '上册' \|\| semester === '下册'`（先 `dto.semester ?? null`） | 400 `semester 仅允许 上册 \| 下册 \| null` |
| C3 | `passageIds === null` 或「是数组且每项都是正整数」 | 400 `passageIds 须为正整数数组或 null` |

`count` 上限取 3 而非默写的 20：每篇要逐句判，3 篇已是长会话（spec §4 决策 5）。

校验写法与报错文案**照抄 `startDictation`**（`training.controller.ts:150-168`），保持三个端点观感一致。

### 3.3 Service `startInterpretation({ semester, passageIds, count })` 逐步逻辑

```
1. rows = (passageIds 非空)
            ? await repo.findVerifiedByIdsForInterpretation(passageIds)   // 忽略 semester
            : await repo.findRandomVerifiedForInterpretation(semester, count)
       ↑ 两条 SQL 见 §3.4

2. passages = []
   for (const r of rows) {
     const sentences = toSentences(r.sentences)   // 见 §3.5，null/坏形状 → []
     if (sentences.length === 0) continue         // 防御：抽题池已挡，手工改库仍可能漏
     const terms = toKeyTerms(r.key_terms)        // 同上
     passages.push({
       passageId: r.id,
       workTitle: r.work_title,
       semester:  r.semester,
       sentences: sentences.map((s, index) => ({
         index,                                   // 用数组下标，不用存储值
         text: s.text,
         terms: terms.filter(t => t.sentenceIndex === index).map(t => t.term),
         //       ↑ 只出 term 名。gloss 是答案，绝不下发
       })),
     })
   }
   return { passages: passages.slice(0, count) }
```

**为什么有 `slice`**：「指定篇目」路径允许勾选多于 `count` 的篇目吗？——不允许，前端按 `count` 限制勾选数；但为与 `startDictation` 行为完全一致（它也有这一句），这里保留 `slice(0, count)` 兜底，参数畸形时也不会下发超额篇目。

### 3.4 repo 新增两个方法（解释专项抽题池）

两条 SQL 共用同一套谓词，只差「怎么选行」：

```sql
-- A. 随机抽（semester != null 时追加 AND dp.semester = ?）
SELECT ${SELECT_COLS} FROM chinese_passages dp
WHERE dp.verified = 1
  AND dp.is_active = 1
  AND JSON_LENGTH(dp.sentences) > 0
  -- semester == null 时追加（「全部册次」按篇名去重，九上/九下有 9 篇重复收录）：
  AND dp.id = (SELECT MIN(dp2.id) FROM chinese_passages dp2
                WHERE dp2.work_title = dp.work_title
                  AND dp2.verified = 1 AND dp2.is_active = 1
                  AND JSON_LENGTH(dp2.sentences) > 0)
ORDER BY RAND() LIMIT ?

-- B. 指定篇目（按 id 批量取，忽略册次）
SELECT ${SELECT_COLS} FROM chinese_passages dp
WHERE dp.verified = 1 AND dp.is_active = 1 AND JSON_LENGTH(dp.sentences) > 0
  AND dp.id IN (…)
```

⚠️ `LIMIT ?` 必须走 `pool.query`，**不能走 `pool.execute`**（mysql2 prepared statement 对 LIMIT 占位符报 `Incorrect arguments`，默写那边已踩过并留了注释）。B 走 `execute` 即可。

**两条都不含 `memorize_required`** —— 解释专项不设「必背」门（spec §4 决策 11）。

### 3.5 防泄题与响应形状

**下发**：`passageId` / `workTitle` / `semester` / `sentences[].index` / `.text` / `.terms[]`
**不下发**：`author` / `dynasty` / `body` / `gloss` / `translation` / `full_translation`

```jsonc
{ "passages": [
    { "passageId": 12, "workTitle": "岳阳楼记", "semester": "上册",
      "sentences": [
        { "index": 0, "text": "庆历四年春，滕子京谪守巴陵郡。", "terms": ["谪守", "越明年"] },
        { "index": 1, "text": "越明年，政通人和，百废具兴。", "terms": [] }
      ] } ] }
```

测试用 `expect(JSON.stringify(res)).not.toContain('因罪贬谪')` 这类全局禁词断言（与 `training.dictation.test.ts:57` 同手法）。

---

## 4. 接口二：`POST /api/training/interpretation/judge`

### 4.1 请求

```jsonc
{ "passageId": 12,
  "sentenceIndex": 0,
  "terms": [ { "term": "谪守", "answer": "被贬官" } ],   // 可缺省 / 空数组
  "translation": "庆历四年的春天，滕子京被贬到巴陵郡。" }
```

### 4.2 Controller 校验与降级

| 字段 | 规则 | 不过时 |
|---|---|---|
| `passageId` | 正整数 | 400 `passageId 须为正整数` |
| `sentenceIndex` | 非负整数（`>= 0`） | 400 `sentenceIndex 须为非负整数` |
| `terms` | 非数组 → 视作 `[]`；数组内元素非对象、或 `term` 非字符串 → **丢弃该条**；`answer` 非字符串 → 降级 `''` | 不报错，静默规范化 |
| `translation` | 非字符串 → 降级 `''` | 不报错，静默规范化 |

`translation` 降级是**必须的**：默写那边踩过 `{"author":123}` 带着 number 进 `normalizeChineseAnswer` 触发 TypeError 变 500（`training.controller.ts:170-174` 有注释）。

### 4.3 Service `judgeInterpretation(input)` 逐步逻辑

```
1) 取篇目
   p = await repo.findById(passageId)
   if (!p) throw NotFoundException(`解释篇目不存在：${passageId}`)
   ※ 判定路径有意不设 verified/is_active 门禁 —— spec §6 守卫适用范围说明，
     理由：古诗文正文属公开内容，且学生提交后本就会看到参考答案；
     「按 ID 直接练某篇」是保留该路径的正当用法。

2) 定位句子
   sentences = toSentences(p.sentences)
   if (sentences.length === 0 || sentenceIndex >= sentences.length)
       throw BadRequestException('sentenceIndex 越界')
   std      = sentences[sentenceIndex]
   stdTerms = toKeyTerms(p.key_terms).filter(t => t.sentenceIndex === sentenceIndex)

3) 配对字词答案
   byTerm = new Map(input.terms.map(t => [t.term.trim(), t.answer]))   // 同名取最后一条
   stuOf(term) = byTerm.get(term.trim()) ?? ''

4) 程序短路（逐项，命中就不进 LLM）
   for (const t of stdTerms) {
     const stu = stuOf(t.term)
     if (stu.trim() === '')                     → { correct:false, method:'unanswered' }
     else if (norm(stu) === norm(t.gloss))      → { correct:true,  method:'exact' }
     else                                       → pending.push({ kind:'term', t })
   }
   const stuTr = input.translation
   if (stuTr.trim() === '')                      → sentence = { correct:false, method:'unanswered' }
   else if (norm(stuTr) === norm(std.translation))→ sentence = { correct:true,  method:'exact' }
   else                                          → pending.push({ kind:'sentence' })
   ※ norm = normalizeChineseAnswer（现有 common/utils/normalize-chinese.util.ts，忽略标点与空格）

5) 待判项打包一次 LLM 调用（仅当 pending.length > 0）
   try {
     r = await interpretationJudge.generate({
           workTitle: p.work_title,
           sentence: std.text,
           standardTranslation: std.translation,
           terms: pending 中 kind==='term' 的项 → [{ term, gloss, answer: stuOf(term) }],
           studentTranslation: pending 含 sentence 时给 stuTr，否则 null,
         })
     // 映射回：
     //   模型给了该项 → { correct, method:'ai', standard, comment }
     //   模型漏了该项 → { correct:null, method:'undetermined', standard, comment:null }
   } catch (err) {
     logger.warn(`interpretationJudge.generate failed (passageId=…, sentenceIndex=…): ${err}`)
     pending 全部 → { correct:null, method:'undetermined', standard, comment:null }
   }
   ※ 一律不抛错出端点的上半部分——判题服务不可用不该让学生看不到任何东西。

6) allCorrect = 所有项（stdTerms 全部 + sentence）的 correct === true
   ※ 空字词 + 句子 exact → true，且 0 次 LLM 调用

7) fullTranslation = (sentenceIndex === sentences.length - 1)
                      ? (p.full_translation ?? null)
                      : null
   ※ 只在最后一句下发。提前下发 = 把整篇答案给了学生。

8) 不写任何学生状态
   无 main_error_books / student_hidden_questions / question_hints /
   question_self_assessments / practice_results —— 一个都不碰（spec §7 第 4 条）。

9) return {
     passageId: p.id,
     sentenceIndex,
     allCorrect,
     terms: [{ term, correct, method, standard, comment }],   // 顺序 = stdTerms 顺序
     sentence: { correct, method, standard, comment },
     fullTranslation,
   }
```

### 4.4 `method` 枚举（4 值，穷举）

| 值 | 含义 | `correct` |
|---|---|---|
| `exact` | 归一化后与标准答案全等 | `true` |
| `ai` | LLM 判定「意思到位」 | `true` / `false` |
| `unanswered` | 学生留空 | `false` |
| `undetermined` | 模型漏项 或 整次调用失败 | `null` |

前端规则：`correct === null` → 显示「未判定」+ 该句「重新判题」按钮。

### 4.5 返回示例

```jsonc
{ "passageId": 12, "sentenceIndex": 0, "allCorrect": false,
  "terms": [ { "term":"谪守", "correct":false, "method":"ai",
               "standard":"因罪贬谪流放，出任外官", "comment":"\"贬官\"方向对，但没点出\"因罪\"；注意"谪"是贬降。" } ],
  "sentence": { "correct":true, "method":"exact",
                "standard":"庆历四年的春天，滕子京被贬到巴陵郡做太守。", "comment":null },
  "fullTranslation": null }
```

---

## 5. ai-core 新增能力 `InterpretationJudgeCapability`

### 5.1 文件与登记点（漏一个就 500 / 模板找不到）

| 文件 | 改动 |
|---|---|
| `ai-core/capabilities/interpretation-judge.capability.ts` | **新建**，照 `dictation-feedback.capability.ts` 抄骨架 |
| `ai-core/types.ts` | `Scene` 加 `'interpretation_judge'`；`CapabilityType` 加 `'interpretation_judge'`；新增 `InterpretationJudgeRequest/Response` |
| `ai-core/model-routes.yaml` | 新增 `interpretation_judge` 路由：`subject: '*'`，primary `local`，fallback `deepseek-flash` |
| `ai-core/retry.yaml` | `timeout.interpretation_judge: 30000` |
| `ai-core/infra/prompt-builder.ts` | `resolveTemplatePath` 加分支 → `interpretation/judge.md` |
| `ai-core/prompts/interpretation/judge.md` | **新建** |
| `modules/training/training.module.ts` | `providers` 加 `InterpretationJudgeCapability`（capability 构造函数参数可选，Nest 可无参实例化，但**必须显式登记 provider**） |
| `scripts/seed-interpretation-judge-route.ts` | **新建**，给已 seed 的库补路由（YAML 只服务新装/DB 空） |

### 5.2 调用细节（照 judgment.capability.ts 的 JSON 写法）

```ts
const route = this.modelRouter.route({ scene: 'interpretation_judge', subject: 'chinese' })

const chatResponse = await this.modelClient.chat({
  model,
  messages: promptResult.messages,
  responseFormat: 'json_object',        // ← 本地 LocalClient 保留此字段（只删 enable_thinking）
  timeout: timeoutConfig.timeout.interpretation_judge ?? timeoutConfig.timeout.default,
  ...(model.provider === 'local' ? { extraBody: LLAMA_CPP_NO_THINKING_BODY } : {}),
})
```

**`thinking: false` 一概不传**。理由：对本地 llama.cpp 是空操作（`LocalClient` 会把 `enable_thinking` 删掉），只有 `extraBody` 的 `chat_template_kwargs` 真关得掉（2026-09-14 实测 13–16s → 1–2s）；而对云端 fallback（deepseek-flash）传了会关掉它的思考、可能拉低判题质量。这与 `dictation-feedback.capability.ts:64` 的策略完全一致，不另立一套。

**fallback**：`try primary catch → if (!fallback) throw; return callOnce(fallback)`。两个都失败 → 抛错，由 service 兜底成全 `undetermined`。

### 5.3 输出 schema 与解析

```ts
const InterpretationJudgeResultSchema = z.object({
  terms: z.array(z.object({
    term: z.string(),
    correct: z.boolean(),
    comment: z.string().nullable().optional(),
  })).default([]),
  sentence: z.object({
    correct: z.boolean(),
    comment: z.string().nullable().optional(),
  }).nullable().optional(),
})

const parsed = this.responseParser.parse<InterpretationJudgeResponse>({
  rawContent: chatResponse.content, mode: 'json', schema: InterpretationJudgeResultSchema,
})
if (!parsed.success || !parsed.data) throw new Error(`Interpretation judge parse failed: ${parsed.errors?.join(', ')}`)
```

`terms` 用 `.default([])`、`sentence` 用 `.nullable().optional()`：**模型漏项不视为解析失败**，漏的项交由 service 标 `undetermined`（spec §7 第 3 条「模型漏项的 id → 逐项 undetermined」）。

### 5.4 prompt `prompts/interpretation/judge.md`

必须含 `## System Prompt` / `## User Message` 两段（`PromptBuilder.buildMessages` 依赖此分段），带 frontmatter `version`。要点：

1. **判题口径**：判「意思是否到位」，不是「措辞是否一致」；可接受同义表述。
2. 字词：要求覆盖核心义项（不必逐字一致）。
3. 句子：关键实词与句式理解正确、大意准确即可。
4. `comment`：只在**判错**时给一句可执行的改进提示（≤60 字）；判对给 `null`。
5. 输出**严格 JSON**，`terms` 只回请求里给出的那些 term，**不得增删**。
6. 变量：`{{workTitle}}` `{{sentence}}` `{{standardTranslation}}` `{{studentTranslation}}` `{{#terms}}{{term}}/{{gloss}}/{{answer}}{{/terms}}`。

---

## 6. 前端

### 6.1 路由（`apps/web/src/routes/index.tsx`，均 `RequireRole role="student"`，不套 layout，页面内自挂 `data-theme="student-day"` + `student-theme-container`）

| 路径 | 页面 |
|---|---|
| `/student/training/chinese/interpretation` | `InterpretationConfigPage`（新建） |
| `/student/training/chinese/interpretation/run` | `InterpretationRunPage`（新建） |

`ChineseSpecialPage`：第二张卡去掉 `opacity-50 cursor-not-allowed` + 「敬请期待」角标，改成和第一张一样的 `<button>`，点击 `navigate('/student/training/chinese/interpretation')`。

### 6.2 `InterpretationConfigPage`

照 `DictationConfigPage` 抄（含「指定篇目」折叠区）：

- 范围：全部 / 上册 / 下册（value 即 `semester`，`null` = 全部）
- 篇数：1 / 2 / 3（不是默写的 3/5/8/10）
- **指定篇目**：折叠区列出 `GET interpretation/passages` 的篇目（按当前范围过滤），可勾选；勾了则忽略范围与随机
  - 勾选上限 = 当前 `count`，超出时禁用其余复选框（并给一行提示「最多选 N 篇」）——**不给后端造成「传递超额 id」的歧义**
  - 范围切换时清空已勾选（与 `DictationConfigPage` 的 `setPicked([])` 一致）
- 开练 → `startInterpretation({ semester, passageIds, count })` → `sessionStorage.setItem('training:interpretation', JSON.stringify(res.passages))` → navigate run 页
- `passages.length === 0` → 错误文案「这个范围内暂时没有可练的篇目」，不跳转
- 按钮文案随勾选变化，与默写一致：`开始练习（指定 N 篇）` / `开始练习（随机 N 篇）`

### 6.3 数据怎么流动（先回答「翻译内容是怎么来的」）

```
配置页   POST interpretation/start { semester, count }
            ↓ 一次返回 N 篇 × 每篇【全部】句子（原文 + 该句字词名）
            { passages:[{ passageId, workTitle, semester,
                         sentences:[{ index, text, terms:["景","万顷"] }] }] }
            ↓ 存 sessionStorage('training:interpretation')
答题页   一次性读入 → 整篇渲染成「逐句卡片」列表（所有句子从第一秒起就在 DOM 里）
            ↓ 学生逐句作答
点「下一句」 → 把【当前这句】的作答 POST interpretation/judge（异步，不等它回来）
            ↓ 判回来 → 结果写回【该卡片】就地显示；其余卡片不动
```

**两个「一次 / 逐句」的分界，是这套设计的关键**：

| 东西 | 何时下发 | 为什么 |
|---|---|---|
| 句子原文、该句有哪些关键字词 | **一次拿全**（`start`） | 前端要能立刻把整篇铺出来、学生看得见上下文；且这些**不是答案** |
| 字词标准释义 `gloss`、整句标准译文 `translation` | **逐句下发**（`judge`） | 这些**就是答案**，提前给等于泄题 |
| 全文译文 `fullTranslation` | **最后一句判完才给** | 同上（见 §4.3 第 7 步） |

### 6.4 `InterpretationRunPage` —— 逐句卡片列表

页面**不是**「一次只显示一句、答完换页」，而是**整篇所有句子从上到下排开、前面答过的句子留在页面上可回看**。翻译题必须看得见上下文，翻页式会把上文弄丢。

**每句一张卡（`SentenceBlock`），三行对译**：

```
┌─ 第 3 句 ────────────────────────────────────────────┐
│ 行1 原文   至若春和景明，波澜不惊，上下天光，一碧万顷。    │
│            ↑「景」「万顷」下划线高亮                       │
│ 行2 字词   〔景〕   [ 日光           ]                   │
│            〔万顷〕 [ 形容广阔无边    ]                   │
│ 行3 翻译   [ 到了春风和煦、阳光明媚的时候，……        ]  │
│                                              [ 下一句 ] │
└─────────────────────────────────────────────────────┘
```

- 行 2 **该句 `terms` 为空则整行不渲染**（不是渲染一行空的）。
- 行 3 是 textarea（多行）。

**卡片三态**（状态在卡片上，不在整页上）：

| 状态 | 何时进入 | 输入框 | 卡片底部 |
|---|---|---|---|
| `editing` | 初始；前一句判完后自动进入 | 可编辑 | 「下一句」（最后一句是「完成」） |
| `judging` | 点了「下一句」/「完成」，该句已送出 | disabled | 线性 SVG 转圈 + 「AI 正在判题…」 |
| `judged` | 判题返回 | disabled（**保留学生答案**，供对照） | 有 `undetermined` 项 → 「重新判题」 |

**判题时机与结果就地显示**：点「下一句」时把**当前这句**送去判题（异步，**不等它回来**就展开下一句）；判回来把结果**写回该卡片原位**，逐项显示在该项输入框的**正下方**：

| `method` | 显示 |
|---|---|
| `exact` | 绿「正确」 |
| `ai` + `correct:true` | 绿「正确」 |
| `ai` + `correct:false` | 红「错误，应为：{standard}」+ `comment`（若有） |
| `unanswered` | 红「未作答，应为：{standard}」 |
| `undetermined` | 灰「未判定」（只有这里才出现「重新判题」） |

字词结果贴在该字词输入框下，整句翻译结果贴在 textarea 下。**学生自己的答案留在输入框里**（disabled），与标准答案上下并排，方便对照——这是不换页的主要收益。

**并发与竞态**：
- 每张卡各持一个在途请求标识 `requestId`；已判过或已有在途请求 → 不重复发。
- 响应回来先校验 `requestId` 仍是当前值，否则丢弃（防「重新判题」连点导致旧响应覆盖新结果）。
- 学生可以连点「下一句」快速划过——空答案由服务端短路成 `unanswered`，**不花 LLM 调用**。

**原文高亮**：把该句 `text` 按 `terms` 切分，每个 term 首次出现处包一层下划线（`text-[var(--brand-500)] underline underline-offset-4 decoration-2`）。term 在 `text` 里找不到 → 不高亮（防御，不报错）。

**「重新判题」的合并语义**（照 spec §7「已判定的项不清空」）：

```
next = await judgeInterpretation(同一 payload)
card.result = merge(card.result, next)
  merge 逐项：若 next 该项 correct === null 而旧值 correct !== null → 保留旧值；否则用 next
```

**输入锁定**：卡片进入 `judging` 后行 2 / 行 3 即 disabled，判完不恢复。学生只能「重新判题」，**不能改答案重判**——同一句出现两份不同答案会让「这句到底算对算错」失去唯一解，本轮不做。

**进度**：页首「《篇名》 · 第 2 / 3 篇 · 已判 4 / 12 句」。

**切篇与完成**：最后一句判完 → 页面底部出现「本篇完成」区：
- **全文对照**：学生逐句译文按序拼接 vs `fullTranslation`（最后一句判题返回）
- **本篇统计**：字词 对/错/未判定、整句 对/错/未判定
- 按钮：「下一篇」（还有篇目时）/「完成」（`removeItem` + 回 `chinese/special`）

**头部退出**：`PageHeader` 的退出走 `components/business/answer/RunExitGuard`（有未判完的作答时拦一下），与 `DictationRunPage` 一致。

### 6.5 组件与服务

| 文件 | 说明 |
|---|---|
| `components/business/interpretation/SentenceBlock.tsx`（新建） | 单句三行对译卡。props `{ sentence, value, onChange, state, result, onNext, onRetry }`。原生 `input`/`textarea` + Tailwind token（`components/base` **没有 Textarea**；照 `DictationAnswerForm` 的 `FIELD_BORDER` 与输入框 class 抄） |
| `components/business/interpretation/ItemResultLine.tsx`（新建） | 单项结果行（正确/错误/未判定 + 标准答案 + 点评），字词项与整句项共用 |
| `services/api.ts`（追加） | interface + 2 个函数，照 dictation 那 4 个的写法（`fetchApi<T>(path, { method, body })`） |

服务函数签名：

```ts
startInterpretation(payload: { semester: string | null; count: number }): Promise<{ passages: InterpretationPassageItem[] }>
judgeInterpretation(payload: { passageId: number; sentenceIndex: number;
                               terms: { term: string; answer: string }[];
                               translation: string }): Promise<InterpretationJudgeResult>
```

约束：`style.md` 硬规则（无 emoji、线性 SVG、单一配色、iPad 横屏优先）；转圈用与 `DictationRunPage` 同款 `animate-spin` 线性 SVG。

---

## 7. 内容管线（输入格式 + 入库）

### 7.0 职责变更（用户 2026-09-16 裁决）

**字词内容由你整理提供**，因此管线大幅缩小：

| 原 spec 的步骤 | 现在 |
|---|---|
| §5.1 实测 MinerU 丢注释、覆盖率 28% | **整节作废** —— 不再依赖 MinerU 的注释 |
| §5.2 步骤 2 从原始页 MD 抽注释 | **作废** |
| §5.2 步骤 3 LLM 补字词 | **作废** |
| §5.3 注释归属（页窗 + 圈号序列重启） | **作废** |
| §5.2 步骤 4 LLM 出逐句/全文翻译 | **待定**（见 §7.5 / §14 问题 1） |
| §5.2 步骤 5-7 自检 / 过目清单 / 幂等入库 | **保留** |
| §5.2 `--export` / `--apply` 校对闭环 | **保留** |

管线保留的职责：**读你的输入 → 解析 → 切句 → 算字词归属 → 出译文（待定）→ 自检 → 幂等入库 → 导出/回写校对**。

### 7.1 输入格式（请你按这个给）

每篇一条，只需要三样：**篇名** + **册次（可选但建议给）** + **重点字词列表（词 + 解释）**。
**正文不用给**——库里 50 篇已校验的 `body` 就是权威正文，管线只对它切句。

#### 格式 A：JSON（推荐，机器稳）

一行一篇（JSONL），或一个文件一个 JSON 数组，两种都支持：

```jsonl
{"work_title":"岳阳楼记","semester":"上册","key_terms":[{"term":"谪守","gloss":"因罪贬谪流放，出任外官"},{"term":"越明年","gloss":"到了第二年"}]}
{"work_title":"醉翁亭记","semester":"上册","key_terms":[{"term":"环","gloss":"环绕"},{"term":"蔚然","gloss":"茂盛的样子"}]}
```

字段名**中英文都认**（解析器做别名归一，你写哪个都行，也可以混用）：

| 语义 | 认的写法 |
|---|---|
| 篇名 | `work_title` / `篇名` / `诗文名` / `题目` |
| 册次 | `semester` / `册次` / `册`（值 `上册` / `下册`） |
| 字词列表 | `key_terms` / `字词` / `重点字词` / `词语` |
| 词 | `term` / `词` / `字词` / `重点词` |
| 解释 | `gloss` / `解释` / `释义` / `意思` |

#### 格式 B：Markdown（手写友好）

`#` / `##` 标题 = 篇名，一个文件可放多篇；标题下可写 `册次：上册`；其余非空行按「词 + 分隔符 + 解释」解析：

```markdown
# 岳阳楼记

册次：上册

1. 谪守：因罪贬谪流放，出任外官
2. 越明年：到了第二年
3. 属：同"嘱"，嘱托

# 醉翁亭记

册次：上册

1. 环：环绕
2. 蔚然：茂盛的样子
```

行解析容错（以下写法全部等价，都认）：

| 变体 | 例子 |
|---|---|
| 行首编号（可无） | `1.` / `1、` / `1` / `①` / `-` / `*` / `（1）` |
| 词带括号（可无） | `〔谪守〕：…` / `[谪守]: …` |
| 分隔符 | `：` / `:` / `＝` / `=` / 首个空白 |
| 你举的写法 | `1 则:那么` → `term=则`，`gloss=那么` |

#### 可选：译文（**给了就以你的为准**，没给由管线生成，见 §7.5）

JSON 里加 `sentences`：

```jsonl
{"work_title":"岳阳楼记","semester":"上册",
 "sentences":[{"text":"庆历四年春，滕子京谪守巴陵郡。","translation":"庆历四年的春天，滕子京被贬到巴陵郡做太守。"}],
 "key_terms":[{"term":"谪守","gloss":"因罪贬谪流放，出任外官"}]}
```

Markdown 里在字词行之外，用「原文 → 译文」两行一组：

```markdown
# 岳阳楼记

册次：上册

> 庆历四年春，滕子京谪守巴陵郡。
> 庆历四年的春天，滕子京被贬到巴陵郡做太守。

1. 谪守：因罪贬谪流放，出任外官
```

给了 `sentences` 时，`text` 必须与库里正文**能逐字拼回**（自检 §7.6 会断言）；拼不回就报错拒绝该篇。

**不需要你给**：作者、朝代。

### 7.2 解析后先做三件事（纯函数，可单测）

1. **别名归一** —— 上表的中英文键映射到内部键。
2. **清洗** —— `term` / `gloss` 去首尾空白；`term` 剥掉包裹的 `〔〕` / `[]` / `（）`；`term` 或 `gloss` 为空的条目**丢弃并记告警**（不静默吞）。
3. **去重** —— 同一篇内按 `term` 归一化去重，保留首次出现，重复项记告警。

### 7.3 切句（就是你说的「需要拆分自己拆分」那一步）

程序按句末标点 `。！？；` 切，**标点留在句尾**，句内其余标点（`，、`等）不动。产出 `sentences[].text`。

**不变式**：`''.join(s.text for s in sentences) == body`，**逐字相等（含标点）**。切完立刻断言，不过就报错拒绝该篇——说明正文里有程序没覆盖的形态，需要人工看，**不许静默入库**。

边界（写进单测）：空正文 / 无句末标点 / 只有一句 / 句末标点后还有残句。

### 7.4 `sentenceIndex` 归属（管线自动算）

对每个 `term`：在 `sentences` 里找**第一个 `text` 包含该 term** 的句子，记其下标。

- 同一 term 出现在多句 → 取首次（学生只答一次，判题也只看这一句）。
- **在正文里找不到的 term** → 按 §14 问题 2 的策略处理（默认：丢弃 + 过目清单告警——点不出来学生也没处答）。

### 7.5 逐句译文与全文译文 —— **混合模式（用户 2026-09-16 裁决）**

```
if 输入里给了 sentences（含 text + translation）:
    以输入为准，管线**不调 LLM**；但自检断言 ''.join(text) == body
else:
    切句由程序做（§7.3），译文由 LLM 生成：
      · 逐句 translation + 整篇 full_translation
      · primary = 本地 Qwen3.8-27B（关 thinking），fallback = deepseek-flash
      · 沿用既有裁决「模型只填 translation、不产出原文字符」——
        text 一律来自程序切句，模型改了也不算
      · 输入附上该篇字词（term + gloss）作参考，帮助模型译准关键处
```

同一篇若先走了 LLM 生成、后来又给上 `sentences`，再跑 `--load` 就覆盖成你的版本（幂等 UPDATE）。

**清单（`GET interpretation/passages`）与抽题池都不看译文来源** —— 只要 `sentences` 落库就进池。

### 7.6 自检（不过不放行）

- `''.join(s.text for s in sentences) == body` 逐字相等
- 句数 ≥ 1；每条 `translation` 非空（若由管线生成）
- 每项 `gloss` 非空；每个 `sentenceIndex` ∈ `[0, len(sentences))`
- `full_translation` 非空（若由管线生成）

### 7.7 `--load` 幂等入库

业务键 `(work_title, semester)` 先查后 UPDATE/INSERT（**不用 `content_hash`**——正文一改 hash 就变，会插重复行）。`ON DUPLICATE KEY UPDATE` **不出现** `verified` / `memorize_required` / `is_active`，否则重跑会刷掉人工标定。写 JSON 列用 `json.dumps(..., ensure_ascii=False)`。

**册次缺失时的匹配**（你没写 `semester` 的情况）：按 `work_title` 查——命中 2 行（九上/九下各一份，实测 9 篇重复）就**两行都写**并打印告警；命中 0 行则报错并列相近篇名（防错字）。

### 7.8 `--export` / `--apply` 校对闭环

照 `answer_importer_cli.py`：导出时**可编辑字段留空、只读参考放 `_ref`**；回写逐字段 diff，**只回写被改过的行**。默认 dry-run + `input("yes")` 确认。

### 7.9 新增文件

| 文件 | 说明 |
|---|---|
| `tools/data-refinery/src/interpretation_cli.py` | CLI：`--extract`（读输入 + 切句 + 生成译文）/ `--load` / `--export` / `--apply` |
| `tools/data-refinery/src/interpretation_input.py` | 输入解析（JSON / MD + 别名归一 + 清洗去重），纯函数 |
| `tools/data-refinery/src/interpretation_split.py` | 切句 + `sentenceIndex` 归属，纯函数 |
| `tools/data-refinery/src/interpretation_check.py` | 自检（`CheckResult` 形状照 `dictation_check.py`） |
| `tools/data-refinery/src/interpretation_loader.py` | 幂等入库（照 `dictation_loader.py`） |
| `tools/data-refinery/src/prompts/interpretation_translate.txt` | 译文 prompt（**仅当 §14 问题 1 选「LLM 生成」**） |
| `tools/data-refinery/tests/test_interpretation_*.py` | 见 §9.2 |

`dictation_*.py`、`answer_importer*` **一行不改**。

### 7.10 CLI 骨架（照 `dictation_cli.py`）

argparse + 互斥 flag，`print("[ok]/[WARN]/[ERROR] ...", flush=True)`，退出码 0/1/2（无动作 → 2）。输入路径 `--input <file.jsonl|file.md>`；产物落 `output/interpretation/语文/<册>/{book}.jsonl` + `-review.md`。

**过目清单 Markdown 内容**：篇名 / 册次 / 正文字数 / 字词数 / 被丢弃的 term 及原因 / 句数 / 首尾样例。

---

## 8. 迁移与脚本执行顺序

```
1. mysql < tools/db/migrations/2026-09-16_chinese_interpretation_columns.sql
2. 验：DESCRIBE chinese_passages 有三列；SELECT COUNT(*) = 50（一行不少）
3. cd apps/server && npx tsx src/scripts/seed-interpretation-judge-route.ts
4. cd apps/server && npx tsx src/scripts/seed-interpretation-fixture.ts     ← 开发假数据
5. 重启后端
```

### 8.1 `seed-interpretation-fixture.ts`（开发假数据，**必需**）

用户裁决本轮不碰内容 ⇒ 库里 `sentences` 全空 ⇒ 前端进去是空题单，**整条链路无法手测**。故加一个假数据脚本，严格照 `seed-dictation-fixture.ts` 的安全阀：

- 只给**已存在的真实篇目行**写 `key_terms` / `sentences` / `full_translation`（不插新行）
- 若该行 `source_ref !== 'DEV-FIXTURE'` → **跳过并告警**，绝不覆盖真实内容
- 选 1 篇短的（如《陋室铭》或已入库的短篇），3-5 句 + 2-3 个字词，够跑通全流程

真实内容入库时 `dictation_loader` 会因 `source_ref='DEV-FIXTURE'` 打 `[WARN]`，痕迹可追。

---

## 9. 测试清单（逐条断言，可直接照抄成用例）

### 9.1 `apps/server`（全部 mock，不连真 DB）

`chinese-passages.repo.test.ts`（追加）
1. `findRandomVerifiedForInterpretation` 的 SQL：**含** `verified = 1`、`is_active = 1`、`JSON_LENGTH(dp.sentences) > 0`；**不含** `memorize_required`
2. 传 `semester='上册'` → SQL 含 `dp.semester = ?` 且 params 首位为 `'上册'`
3. 传 `semester=null` → SQL 含按篇名去重子查询（`MIN(dp2.id)`）
4. 对照：`findDictationRandomVerified` 的 SQL **含** `memorize_required = 1`（证明两条门禁确实不同）

`interpretation-judge.capability.test.ts`（新建）
5. happy path：mock 返回合法 JSON → 映射出 `terms` / `sentence`
6. primary reject → fallback 被调用（`expect(chat).toHaveBeenCalledTimes(2)`）且返回 fallback 结果
7. primary 与 fallback 都 reject → **抛错**（交由 service 兜底）
8. `model.provider === 'local'` → `chat.mock.calls[0][0].extraBody` 等于 `LLAMA_CPP_NO_THINKING_BODY`
9. `model.provider !== 'local'` → `extraBody` 为 `undefined`；且**从未**传 `thinking:false`
10. `responseFormat === 'json_object'`
11. 模型返回 `{"terms":[],"sentence":null}`（全漏）→ 解析**成功**（不抛错），空数组

`training.interpretation.test.ts`（新建，service 层）
12. start：`JSON.stringify(res)` **不含** `gloss` / `translation` / `full_translation` / `author` / `dynasty`
13. start：terms 按 `sentenceIndex` 挂到正确的句子；`sentenceIndex` 越界的 term 不出现在任何句子
14. start：某行 `sentences` 为 `null` / `[]` → 该篇被过滤掉
15. judge 短路-空：全空答案 → 所有项 `method:'unanswered'`、`correct:false`，**LLM 调用 0 次**
16. judge 短路-全等：归一化后与标准答案相等（含「学生整句不打标点」）→ `method:'exact'`、`correct:true`，**LLM 0 次**
17. judge 部分返回：LLM 只回了 2 项中的 1 项 → 回了的 `method:'ai'`，漏的 `method:'undetermined'` + `correct:null`
18. judge 整次失败：`generate` reject → 全部待判项 `undetermined`，**方法不抛错**
19. `fullTranslation`：`sentenceIndex === 最后一句` → 非 null；否则 null
20. 无学生状态：判题结束后 `mainErrorRepo` / `hiddenRepo` / `questionHintsRepo` / `selfAssessRepo` **均未被调用**
21. `sentenceIndex` 越界 → `BadRequestException`；`passageId` 不存在 → `NotFoundException`
22. `allCorrect`：字词对 + 句子对 → true；句子 `undetermined` → false

`training.controller.interpretation.test.ts`（新建，controller 层）
23. `count` = 0 / 4 / 1.5 → 400；`semester` = `'中册'` → 400
24. `passageId` = 0 / 1.5 → 400；`sentenceIndex` = -1 → 400
25. `terms` 传非数组 → 透传 `[]`；`answer` 为 `123` → 降级 `''`；`term` 为 `123` 的条目被丢弃
26. `translation` 为 `123` → 降级 `''`
27. 合法非空入参原样透传（镜像 `fd1dbd0` 那条用例的写法）

### 9.2 `tools/data-refinery`（pytest，不碰真 DB / 真 LLM）

`test_interpretation_input.py`（输入解析）
28. JSONL 与「一个 JSON 数组」两种文件形态都能读
29. 别名归一：`篇名`/`work_title`/`题目` 等价；`字词`/`key_terms` 等价；`词`/`term`、`解释`/`gloss` 等价；中英混用也能读
30. Markdown 解析：`#` 多篇分文件；`册次：上册` 被识别
31. 行容错：`1. 谪守：…` / `1、谪守: …` / `①谪守：…` / `- 〔谪守〕：…` / `1 则:那么` 全部等价
32. 清洗：`term` 剥 `〔〕`/`[]`/`（）`；首尾空白去除
33. 丢弃与告警：`term` 空 / `gloss` 空的条目被丢弃**且产生告警**（不静默）
34. 去重：同篇内重复 `term` 保留首次、产生告警

`test_interpretation_split.py`（切句与归属）
35. 切句恒等：随机/样例正文切完 `''.join(text) == body` 逐字相等
36. 边界：空正文 / 无句末标点 / 只有一句 / 句末标点后有残句
37. 标点留句尾：`…巴陵郡。` 的 `。` 在句内，`，` 不切
38. `sentenceIndex` 归属：term 落在含它的那句；同 term 多句 → 取首次
39. 找不到的 term → 被丢弃且记入告警列表

`test_interpretation_check.py`
40. `''.join(text) != body` → 拒绝
41. `gloss` 空 / `translation` 空 / 句数 0 / `full_translation` 空 → 各自拒绝
42. `sentenceIndex` 越界 → 拒绝

`test_interpretation_loader.py`（`_FakeCursor` + `__new__` 绕过连接，照 `test_dictation_loader.py`）
43. 语句文本**不含** `verified` / `memorize_required` / `is_active`（重跑不刷人工标定）
44. 写 JSON 列用 `json.dumps`（断言参数是字符串且能被 `json.loads` 回来）
45. 重跑不产生重复行（先查后 UPDATE 分支被走到）
46. 册次缺失且同名 2 行 → 两行都写 + 告警；同名 0 行 → 报错并列出相近篇名

`test_interpretation_cli.py`
47. `--export` 产出的行：可编辑字段为空、`_ref` 有只读参考
48. `--export` → 改一处 → `--apply` 往返一致；**未改的行不产生 diff、不写库**

### 9.3 冒烟与手测

49. **冒烟（只出 JSONL、不写库）**：用一小段样例输入跑 `interpretation_cli --extract`，确认解析、切句、归属、自检、过目清单都通。**不执行 `--load`**。
50. **手测**：迁移 → seed 路由 → seed fixture → 重启后端 → 真机走通「训练 → 语文 → 专项 → 解释 → 逐句答 → 判题 → 结果」；顺带验「指定篇目」开练。
51. **回归**：默写专项全链路仍通（三个 dictation 端点 + 页面）；数学专项页零回归。
52. `apps/web`: `npm run lint` + `npm run build` 通过。

---

## 10. 文档更新清单

| 文档 | 更新内容 |
|---|---|
| `docs/K12智学系统-数据库设计文档.md` | §3.14：三列从「待实施」改为已实施；`key_terms` 形状补 `sentenceIndex`；抽题池加「内容就绪」守卫；§8 变更日志 |
| `docs/API接口与数据流设计文档.md` | 新增 2 端点（契约 + 数据流） |
| `docs/api/openapi.yaml` | 新增 2 端点（**须与上一份一致**） |
| `docs/superpowers/specs/2026-09-15-chinese-interpretation-special-design.md` | 加修订说明：判题粒度「整篇批量」→「逐句」（用户 2026-09-16 裁决）、`key_terms.sentenceIndex`、抽题池「内容就绪」守卫；§4 / §7 / §8 逐处内联标注 |
| `CLAUDE.md`（根目录） | 语文段落：解释专项实施状态、逐句判题口径 |
| `docs/data-refinery-使用手册.md` | 新增 `interpretation_cli` 用法（§4.9 旁） |
| `docs/ai-core-changelog.md` | 本轮条目（新 capability + 场景 + 路由） |
| `docs/K12智学系统-架构设计文档.md` | 仅当子系统小节缺解释专项时补（先核对，避免无谓改动） |

---

## 11. 实施顺序

1. **数据层**：迁移 + schema 折回 → 跑迁移 → 验 50 行完好
2. **后端 repo**：三列 + 解释抽题池两方法（+ 单测 1-4）
3. **capability**：capability + types + prompt + routes/retry + prompt-builder + module provider（+ 单测 5-11）
4. **service / controller / DTO**：3 个端点（+ 单测 12-27）
5. **脚本**：`seed-interpretation-judge-route.ts` + `seed-interpretation-fixture.ts`
6. **内容管线代码**：5 个新模块 + 5 个测试文件（+ 测试 28-48），冒烟 49
7. **前端**：special 卡启用 → 配置页（含指定篇目）→ 答题页（逐句卡片）→ api.ts → 路由
8. **文档**：§10 清单一次补齐
9. **验收**：50 / 51 / 52

---

## 12. 本轮不做（明确边界）

- **不跑内容入库**：管线代码写完、单测跑通即可；`--load` 不执行（等你把字词输入整理好再跑）
- 不做「整篇一次批量判题」端点（已被逐句取代，不留死代码）
- 不做语文真题考试页 / 错题练习页（试题类走既有 `questions` 体系）
- 不做手写拍照识别（OCR / VLM）
- 不做从教材页 MD 抽注释（**整条路径已随「字词由你提供」作废**）
- 不做字词/句子级全站错题统计（JSON 列不支持按项聚合）
- 不改数学侧、不改默写专项任何行为

---

## 13. 我替你拍的决定（不同意请直接说，会改）

**页面结构类**

1. **一次拿全、逐句判** —— 原文与字词名由 `start` 一次给全；`gloss`/`translation`/`fullTranslation` 一律不提前给，只在该句判题返回时逐句下发（§6.3 的表）。
2. **逐句卡片列表，不换页** —— 整篇所有句子从上到下排开，前面答过的句子留在页面上、结果就地贴在输入框下方。翻译题必须看得见上下文，翻页式会丢掉上文。
3. **「下一句」= 提交并送判当前句，判题异步不阻塞** —— 点了就展开下一句，不等 LLM 回来；结果回来再原地回填。学生可以连点快速划过（空答案走服务端短路，不花 LLM）。
4. **学生答案保留在输入框里**（disabled），与标准答案上下并排 —— 这是不换页的主要收益。
5. **一篇判完才能进下一篇** —— 与你的要求一致；最后一句判完才出现「下一篇」/「完成」。

**数据/接口类**

6. **3 个端点**（含 `GET interpretation/passages` 供「指定篇目」勾选）。
7. **抽题池加 `JSON_LENGTH(sentences) > 0`** —— 防「点进去没题目」。没有内容的篇目不会出现在清单里，也不会被随机抽到。
8. **`fullTranslation` 只在最后一句判完下发** —— 提前给等于泄题。
9. **判题只下 `extraBody` 关 thinking，不传 `thinking:false`** —— 与 `dictation-feedback.capability.ts` 完全一致。
10. **输入格式同时支持 JSON 与 Markdown，且字段名中英文都认** —— 你手写 MD 或程序导 JSON 都不用改格式。
11. **正文不由你单给**，以库里已校验的 `body` 为准；管线只对它切句。
12. **切句/归属由管线做**（你说的「需要拆分自己拆分」），切完断言拼接恒等，不过就拒绝该篇。
13. **译文混合模式**：输入给了就以你的为准，没给由管线调本地 LLM 生成（§7.5）。
14. **字词定位不到 → 丢弃 + 过目清单告警**，不入库（§7.4）。
15. **册次以你写的为准**（§7.7）；你没写时按篇名匹配、同名两行都写 + 告警，仅作防御。

**交互策略类**

16. **判题后锁定输入，只能「重新判题」不能改答案重判** —— 避免同一句出现两份不同答案、让「这句算对算错」失去唯一解。
17. **未判定重试时前端「保留已判定项」** —— 对齐 spec §7「已判定的项不清空」。
18. **加 `seed-interpretation-fixture.ts` 开发假数据** —— 否则本轮无法手测；有 `source_ref='DEV-FIXTURE'` 安全阀与告警。

---

## 14. 已确认的决定（2026-09-16，用户答复）

| # | 问题 | 裁决 | 落点 |
|---|---|---|---|
| 1 | 译文谁来出 | **混合**：输入给了就用你的；没给由管线调本地 LLM 生成 → 覆盖 | §7.5 |
| 2 | 字词在正文里定位不到 | **丢弃 + 过目清单告警**（不入库） | §7.4 |
| 3 | 册次是否由你提供 | **你写册次**（`册次：上册`）→ 精确落到那一行 | §7.1 / §7.7 |

**开工前置条件**：无。管线代码与后端、前端先做完；等你把字词输入整理好，跑 `interpretation_cli --extract --load` 即可灌数据（不需改任何代码）。

---

## 15. 执行状态（2026-09-16，已全部完成）

| 阶段 | 结果 |
|---|---|
| 1 数据层 | 迁移已跑、幂等（二次执行只打 `SELECT 1`），50 行完好；`schema.sql` 已折回 |
| 2 后端 repo | 三列 + 解释抽题池两方法；repo 测试 22 条 |
| 3 capability | `InterpretationJudgeCapability` + prompt + 路由 + retry + prompt-builder + module provider；11 条测试 |
| 4 service/controller/DTO | 3 端点；service 24 条 + controller 11 条 |
| 5 脚本 | `seed-interpretation-judge-route.ts`（已跑，路由已入 `llm_routes`）+ `seed-interpretation-fixture.ts`（已跑，2 篇假数据） |
| 6 内容管线 | 6 个新模块 + 6 个测试文件；冒烟 `--extract` 通过（**未 `--load`，库里内容仍是那 2 篇假数据**） |
| 7 前端 | 专项页第二张卡已启用 + 配置页（含指定篇目）+ 逐句答题页 + 2 组件；lint 0 error、build 通过 |
| 8 文档 | §10 清单全部执行（含架构文档 §4.2.13 与 PRD 核对——PRD 已于 2026-09-15 覆盖解释专项，无需改） |
| 9 验收 | server **558 passed** / refinery **999 passed** / web lint+build 通过 / curl 手测三端点 + 边界 + 默写回归 + 学生状态零新增 |

**实施中新发现并已修的问题**：`interpretation_cli.main` 只给 `--extract` 时没 `return`，穿透到 `run_apply`——违反了「只出 JSONL 不写库」的承诺。已改为四个动作各自显式 return，并加 5 条 dispatch 单测钉住（`TestMainDispatch`）。

**两点与计划的偏差（都是有意的）**：

1. **前端退出确认用 `RunExitGuard`**，页面**不自己处理导航**（`PageHeader` 的返回按钮触发 `useBlocker` 拦截 → 弹确认 → `blocker.proceed()` 放行）。计划里写的 `onNavigate` 在 `PageHeader` 上并不存在，也不必存在。
2. **`seed-interpretation-fixture.ts` 对不存在的篇目会 INSERT**（计划里写的是「只给已存在的行写」）——否则该脚本与默写的 fixture 脚本要按顺序跑才有意义。安全阀仍在：已存在且 `source_ref !== 'DEV-FIXTURE'` 时跳过并告警。

**未做（用户裁决）**：不跑 `--load`、不灌内容。用户整理好字词后跑
`python src/interpretation_cli.py --all --input <file>` 即可，**不需改任何代码**。
