# 课堂练习答题与判对错 - 设计文档

- 日期：2026-08-06
- 分支：feat/auxiliary-track
- 状态：待评审
- 关联：PRD §6.1（课堂练习）/ §7.3（错题清零门控）/ §7.4（双错题本）；API 设计文档 §4；DB 设计文档 §3.2/§3.6

## 1. 目标

在 `CourseDetailPage`（`/student/course-detail`）进入"课堂练习"态（当前卡片 `card_type === 'practice'`）后：

1. 卡片中**每一道题**可点击，非题的帮助/说明文字不可点。
2. 点击某题 -> 弹出**解答窗口**：上部渲染该题（markdown + LaTeX），下部左侧 LaTeX 编辑框（含常用符号面板，点击在光标处插入），下部右侧实时 LaTeX 预览，底部"提交"。
3. 提交 -> 服务端**判对错**（非判分，练习不计分）：先查题库，命中且为客观题（choice/true_false/fill_blank）直接比对得对错；命中 short_answer/proof 或未命中 -> 调 ai-core 新增 `JudgmentCapability` 走大模型判定对错。
4. 提交后自动进入下一题，直到本卡所有题作答完毕 -> 给出**答题列表**（每题对错），错题行有"解析"按钮查看判定分析。
5. 答错 -> 进入**主线错题本**（`main_error_books`）；若该题不在题库，结构化后插入 `questions`。错题在下一节课上课时重做清零（既有 PRD 门控，不在本需求内新增）。

## 2. 关键决策（已与用户确认）

| 决策点 | 选定方案 |
|---|---|
| 题目识别 / 数据源 | **A 管线打标**：扩展 `card_labeler` 提示词，对 `practice` 卡输出 `questions:[{n,text}]`，存入 `cards.content_metadata`；回填现有 34 张卡 |
| 判定路由 | `choice`/`true_false`/`fill_blank` -> 规范化直接比对得对错；`short_answer`/`proof` -> AI 判定；未命中题库 -> AI 判定 |
| 判定 vs 判分 | 练习**只判对错，不计分**；新增 `JudgmentCapability`（不复用 `GradingCapability`，后者保留给作业/考试打分） |
| 答题输入 | 始终 LaTeX 编辑框（客观题学生输入 A/B/C 或答案值） |
| 提交后行为 | 提交->下一题->全部做完->答题列表（对错+错题"解析"按钮） |
| 实施范围 | 一次性全做（管线打标 + modal + 编辑器 + 判定端点 + 题库查/插 + 错题本 + 哈希对齐） |

## 3. 现状盘点（已实现，可复用）

- **前端**：`CourseDetailPage` 已有 `practice` 阶段概念；练习卡内容为行内 markdown，已用 ReactMarkdown + remark-math + remarkGfm + rehype-katex 渲染（KaTeX 已是依赖）。已有 `EXERCISE_ITEM_RE=/^\([1-9]\d?\)/`、`EXERCISE_STEM_RE=/[：:]$/`、`preprocessContent`（拆 `(1)(2)`、`（N）->(N)`）。
- **ai-core**：`QuestionStructuringCapability.structure()` 已实现，输出 `{type,difficulty,content,options,answer,explanation,knowledgePoints,quality}`。`GradingCapability`（评分，返回 `totalScore/steps`）**保留给作业/考试打分，不用于练习**。
- **题库**：`QuestionsRepository.findByContentHash` / `findOrCreate`（基于 `content_hash` 竞态安全去重）/ `create` / `deleteById` / `bindKnowledgePoint`。
- **DB**：`questions`（type ∈ choice/fill_blank/true_false/short_answer/proof，answer NOT NULL，options，content_hash UNIQUE）、`main_error_books`（student/subject/question_id NOT NULL/source/source_ref_id/wrong_answer_text/level/is_cleared）、`cards.content_metadata`（TEXT JSON，已存在）。
- **错题本模块**：`error-book.service.insertQuestionAndAux()` 已有"去重+插题+入错题本+孤儿补偿"模式（辅线），可镜像到主线。

## 4. 缺口（需新建）

- LaTeX 编辑器、预览、符号面板、解答 modal、答题列表、解析视图（前端组件）。
- 判对错 HTTP 端点 + `practice` 模块 + **`JudgmentCapability` + judgment 提示词 + `judgment` scene**（后端）。
- `main-error-books.repo.ts`（仅 aux 存在）。
- 管线：`card_labeler` 提示词 + 解析 + `db_loader` 持久化 `content_metadata.questions` + 回填脚本。
- **哈希对齐修复**：服务端 `normalizeForHash` 与 refinery `normalize_content` 不一致（见 §9）。

## 5. 数据管线变更（方案 A）

### 5.1 card_labeler 提示词（`tools/data-refinery/src/prompts/textbook_cards.txt`）

> 遵循 [[incremental-edit-prompt-files]]：对已有提示词做**增量 Edit**，不整体重写。

在现有"仅标注"任务基础上，增量增加：当 `card_type === "practice"` 时，额外输出 `questions` 数组，枚举该卡中每一道可作答的题：

```json
{
  "page_type": "practice",
  "items": [{
    "card_type": "practice",
    "lesson_id": null,
    "title": null,
    "textbook_page": "P11",
    "intro": "用公式法解下列方程：",
    "questions": [
      { "n": 1, "text": "(1) $5x^{2}-1=4x$" },
      { "n": 2, "text": "(2) $4x^{2}=81$" }
    ]
  }]
}
```

- `intro`：题前说明/要求文字（可选，无则省略）；非题，不可点。
- `n`：题号（`(N)` 中的 N；无编号题用 1 起的自然序）。
- `text`：该题完整 markdown（含 LaTeX 原样），**逐字取自原文**，作为解答窗口题面、哈希源与可点块内容。
- `questions` 仅 `practice` 卡输出；其余 `card_type` 不输出该字段（或输出 `[]`）。
- **模型**：refinery LLM 用 DeepSeek `deepseek-v4-flash`（reasoner；Gemma 26B 质量不足已弃用）。`.env` 需切回 `LLM_MODEL=deepseek-v4-flash`（前置依赖）。DS v4 flash 做结构化题面抽取可靠，几乎不回退。
- **校验**：`db_loader` 落库前校验每条 `question.text` 是 card content 的子串（容 NFKC/空白差）；不通过则丢弃该条并置 `content_metadata.needs_fallback=true`，前端对该卡走正则兜底。

### 5.2 card_labeler.py / db_loader.py

- `LabelResult` 增加 `intro: str | None` 与 `questions: list[QuestionMarker] | None`；`_parse_json_object` 解析后透传。
- `db_loader` 写 `cards` 时，把 `intro`+`questions` 序列化为 JSON 写入 `content_metadata`（合并已有 metadata，不覆盖其它键）。
- 标注器目前只看 `content[:800]`；**practice 卡改为传完整 content**（去截断）保证题不漏，其余卡维持 800 截断。

### 5.3 回填脚本

`tools/data-refinery/backfill_practice_questions.py`（一次性）：遍历 DB 中所有 `card_type='practice'` 且 `content_metadata.questions` 为空的卡，取完整 `content`，调标注器（或直接复用 `CardLabeler.label` 传完整内容）补 `questions`，更新 `content_metadata`。幂等（已有 questions 则跳过）。

### 5.4 前端兜底

若某练习卡 `content_metadata.questions` 缺失或 `needs_fallback=true`（旧卡未回填 / 标注失败 / text 校验不过），前端回落到增强正则识别（见 §6.1），保证可用。

### 5.5 card_splitter 增强（同节补句 + 题原子性）

当前 `card_splitter` 贪心合并、无标题感知；下一 bundle 放不下即封卡（即使当前 <300）。增强：

- **标题上下文**：`_make_bundles` 遍历段落时记录最近 `##`/`###` 标题，判定"同节"。
- **同节补句**：当前卡文字 <~300 且下一 bundle 同节时，用 `_split_long_text`（按句末标点 `。！？`）从下一 bundle 拉完整句子补到 ~400；不同节即使短也封卡（用户规则）。
- **题原子性**：练习内容里以 `(N)` 开头的题段落作为**原子 bundle**，不在题中间切，避免一道题跨两张卡（labeler 按卡抽题，跨卡题无法恢复）。
- 仅影响切分边界，不改 `content` 原文。

## 6. 前端设计

### 6.1 练习卡结构化渲染（`CourseDetailPage.tsx`）

- **主路径**：从 `card.content_metadata` 取 `{intro?, questions:[{n,text}]}`。渲染 `intro`（markdown，复用渲染栈）+ 逐题把 `question.text` 渲染为**独立可点块**（`button`/`role="button"`），点击 -> 打开 `AnswerModal` 定位该题。
- 不再依赖 `preprocessContent` 正则拆同行题--`;`-less / 无空格场景已由 LLM 切分（§5.1）解决。
- **正则兜底**（§5.4）：无 `questions` 或 `needs_fallback` 的卡，用增强 `EXERCISE_ITEM_RE`（兼容 `N.` 编号、无编号题；`preprocessContent` 对 `(N)` 标记做 NFKC 归一修 `(2）` 半全角混排）识别可点段落。
- 非题段落（说明/提示/图注）不可点。

### 6.2 解答窗口 `AnswerModal`（`components/business/`）

布局（用户指定）：

```
┌─────────────────────────────────────┐
│  上部：题面（markdown+LaTeX 渲染）      │
├──────────────┬──────────────────────┤
│ 左下：LaTeX   │ 右下：实时预览         │
│ 编辑框        │（react-markdown+      │
│ + 符号面板    │  remark-math+         │
│              │  rehype-katex）        │
├──────────────┴──────────────────────┤
│            [提交]                     │
└─────────────────────────────────────┘
```

- 上部：复用 CourseDetailPage 的渲染栈（ReactMarkdown + remarkMath + remarkGfm + rehypeKatex），内容 = `question.text`。
- 左下 `LatexEditor`：`<textarea>` + `SymbolPalette`；符号点击在 `selectionStart` 处插入对应 LaTeX（**裸 LaTeX，如 `\frac{}{}`**），并把光标移到首个占位 `{}` 内。学生用 `$...$` 包裹数学（与题面渲染一致）；编辑器提供快捷键/按钮一键包裹 `$ $`。
- 右下 `LatexPreview`：把编辑框内容用同一渲染栈（react-markdown+remark-math+rehype-katex）实时渲染（debounce ~150ms）；`$...$`/`$$...$$` 原样识别。
- 底部"提交"：非空校验 -> 调 `judgePractice()` -> 记录判定 -> **自动切到下一题**；最后一题提交后 -> 关闭 modal，展示答题列表。
- modal 内支持上一题/下一题导航；中途关闭已答记录保留在 `practiceStore`。

### 6.3 符号面板 `SymbolPalette`（分组，线性 SVG 图标，无 emoji）

| 分组 | 符号 -> LaTeX |
|---|---|
| 运算 | ÷`\div` ×`\times` ±`\pm` ⋅`\cdot` ≤`\leq` ≥`\geq` ≠`\neq` ≈`\approx` |
| 幂根 | `x^{2}` `x^{n}` √`\sqrt{}` ⁿ√`\sqrt[n]{}` 分式`\frac{}{}` `\log` `\ln` |
| 集合 | ∈`\in` ∉`\notin` ∪`\cup` ∩`\cap` ⊆`\subseteq` ∅`\emptyset` |
| 几何 | ∵`\because` ∴`\therefore` △`\triangle` ∠`\angle` ∥`\parallel` ⊥`\perp` ≅`\cong` ∼`\sim` °`\circ` |
| 其它 | ->`\rightarrow` ⇒`\Rightarrow` π`\pi` ∞`\infty` ∑`\sum` ∫`\int` |

### 6.4 答题列表 + 解析

- 全部作答完毕 -> 答题列表（题号 / 题面摘要 / 对✓错✗）。
- 错题行"解析"按钮 -> 展开该题判定返回的 `analysis`（错因 + 正确解法）+ `errorType`，数据来自判定响应（`practiceStore` 持有）。**一次 AI 调用已兼顾判定与解析**，无需再调 ExplanationCapability。
- 客观题错题（exact 比对）的解析：展示题库中的正确答案（`q.answer` / `options`），无 AI。
- 错题同时已落 `main_error_books`；后续在错题本中查看解析，可按需调 `ExplanationCapability`（`explanation/error-analysis.md`）--本需求不强制。

### 6.5 状态管理 `practiceStore`（Zustand，新建）

```
{ cardId, questions: [{n,text}], answers: { n: { studentAnswer, isCorrect, method, analysis, errorType } }, currentIndex }
```

会话态前端持有；刷新丢失（仅错题持久化于错题本，可接受）。

## 7. 后端设计

### 7.1 端点

`POST /api/practice/judge`（JWT 守卫，参考 `AIController`）

请求：
```json
{
  "cardId": 123,
  "lessonId": 45,
  "subjectId": 1,
  "questionText": "(1) $5x^{2}-1=4x$",
  "studentAnswer": "x=\\frac{1\\pm\\sqrt{21}}{2}"
}
```

响应：
```json
{
  "questionId": 678,
  "isCorrect": false,
  "method": "ai",
  "analysis": "第二步符号错了：应为 -b，你写成了 b；正确解法：...",
  "errorType": "calculation",
  "errorBookId": 42
}
```

- `questionId`：null 若未入库且答对未插。
- `analysis`/`errorType`：仅错题有（ai 路径来自 `JudgmentCapability`；exact 路径 `analysis="正确答案：..."`，无 `errorType`）。答对时 `analysis=null`。
- `errorBookId`：仅答错时返回。

### 7.2 `JudgmentCapability`（新增）

- 提示词 `apps/server/src/ai-core/prompts/judgment/math-judge.md`：「你是数学老师，判断学生解答是否正确。若错，分析错因并给出正确解法。输出 JSON `{isCorrect, analysis, errorType}`」。数学公式 LaTeX 原样；`questionType`（proof/calculation）作上下文变量。
- DI：`constructor(deps?: { modelClient?: ModelClient })`，生产 `new ModelClient()`，测试注入 mock（遵循 ai-core 约定，无 Key 可跑）。
- `model-routes.yaml` 新增 scene `judgment`，复用 grading 同模型；`retry.yaml`/timeout 取 grading 同档（或新增 `judgment:45000`）。
- 返回 `{ isCorrect: boolean, analysis: string, errorType?: 'logic'|'calculation'|'format'|'missing' }`。
- `ResponseParser` + Zod schema 校验；解析失败抛错（`PracticeService` 捕获 -> 返回"判定失败"）。

### 7.3 `PracticeService.judge()` 流程

```
1. normalizeForHash(questionText) -> contentHash
2. q = questionsRepo.findByContentHash(contentHash)
3. if q && q.type ∈ {choice,true_false,fill_blank}:
     isCorrect = compareAnswer(studentAnswer, q.answer, q.options)
     method='exact'; analysis = isCorrect ? null : `正确答案：${q.answer}`
   else (q 是 short_answer/proof 或 q=null):
     questionType = q?.type==='proof' ? 'proof' : 'calculation'
     result = judgmentCapability.judge({ questionContent:questionText,
       standardAnswer: q?.answer ?? '', reference: q?.explanation ?? '',
       studentAnswer, subject:'math', questionType })
     isCorrect=result.isCorrect; method='ai'
     analysis = isCorrect ? null : result.analysis; errorType=result.errorType
4. if !isCorrect:
     if q==null:
       structured = structuring.structure({ rawInput:questionText, inputType:'text',
         studentId, subjectHint:'math' })
       if structured.quality!=='poor' && structured.content:
         { id:questionId } = questionsRepo.findOrCreate({ ...structured, content_hash:hash, source:'practice' })
       else: questionId=null  // 质量差仅入错题本 wrong_answer_text
     else: questionId=q.id
     errorBookId = mainErrorBooksRepo.create({ student_id, subject_id, question_id:questionId,
       level:1, is_cleared:0, source:'practice', source_ref_id:cardId,
       wrong_answer_text: questionId?null:questionText })
5. return { questionId, isCorrect, method, analysis, errorType, errorBookId }
```

说明：
- **未命中且答对**：不插题库（遵循用户"仅错题入库"），`questionId=null`，无 `errorBookId`。
- **未命中且答错**：先判定（AI）-> 结构化 -> `findOrCreate` 插题 -> 入错题本。结构化与判定是两次 AI 调用（已知成本，可接受；未来可合并 prompt 优化）。
- 客观题比对 `compareAnswer`：NFKC 归一 + 去空白 + 去 `$`/markdown 标记 + 转小写；选择题额外支持比对 `options[].isCorrect`。

### 7.4 `main-error-books.repo.ts`（新建，镜像 aux）

`create / findById / findByStudent / markCleared / updateLevel`，对应 `main_error_books` 表。

### 7.5 哈希对齐修复（§9 详述）

`apps/server/src/modules/error-book/content-hash.util.ts` 的 `normalizeForHash` 改用完整 `NFKC`（对齐 `db_loader.normalize_content`），使服务端与管线插入的题能跨源去重。`JudgmentCapability` 与 `PracticeService` 都走该 util。

## 8. 数据模型

- **无新表**。`cards.content_metadata.questions`（既有 TEXT 列，写入 JSON）；复用 `questions` / `main_error_books` / `question_knowledge_points`。
- 会话态不持久化（前端 Zustand）；仅错题落 `main_error_books`。
- `main_error_books.source='practice'`，`source_ref_id=cardId`，`wrong_answer_text` 仅在 question_id=null（质量差）时存原始题面。

## 9. 哈希不一致（必须修）

| | refinery `normalize_content` | 服务端 `normalizeForHash` |
|---|---|---|
| 归一 | `unicodedata.normalize("NFKC", s)` | 仅全角数字 `０-９` 减 0xfee0 |
| 标点 | 保留 | 删除一组 CJK+ASCII 标点 |
| 空白 | 去全部 | 去全部 |
| 大小 | lower | lower |

例：`（1）x²=4` -> refinery `(1)x2=4`（NFKC：`（->(` `）->)` `²->2`）；服务端 `1x²=4`（删 `（）`，`²` 保留）。**哈希不同** -> `findByContentHash` 跨源漏判。

修复决策：**统一**服务端 `normalizeForHash` 为 `NFKC + 去空白 + lower`（不删标点），与 refinery 完全一致。对 aux 错题本既有插入题做**一次性 rehash 迁移脚本**（recompute `questions.content_hash`），避免双重哈希体系。迁移脚本纳入任务分解。

## 10. API 文档同步（遵循项目铁律）

变更后同步：`docs/api/openapi.yaml` + `docs/API接口与数据流设计文档.md` 新增 `POST /api/practice/judge`；`docs/K12智学系统-数据库设计文档.md` 补 `cards.content_metadata.questions` 结构说明；PRD 无需改（既有需求）。遵循 [[update-related-docs-together]]。

## 11. 边界与错误处理

- 练习卡无 `questions` 标记 -> 前端正则兜底识别。
- `(2）` 半全角混排 -> `preprocessContent` NFKC 修。
- 空答案 -> 前端禁止提交。
- AI 判定失败/超时 -> `JudgmentCapability` 内部重试（同 grading fallback 机制）；全失败 -> `PracticeService` 捕获，返回 `{isCorrect:null, error:'判定失败'}`，前端提示"判定失败，请重试"，不入错题本。
- 客观题 exact 比对不匹配但学生答等价形式（如 `1/2` vs `0.5`）-> 判错；可接受（错题进错题本后重做时由解析纠正）。未来可加等价归一。
- 安全：判定输入为数学 LaTeX，低风险；不接 SafetyGuard（与既有 grading 场景一致）。题目来自管线预筛。

## 12. 测试

- 管线：`card_labeler` 新增 practice 卡 `questions` 输出的单测；回填脚本幂等性。
- 后端-判定能力：`JudgmentCapability` Zod 解析 + mock `ModelClient` 单测（无 Key 可跑，遵循 ai-core DI 约定）。
- 后端-端点：`PracticeService.judge` 三路由（客观命中比对 / short_answer·proof 命中 AI 判定 / 未命中 AI 判定 + 错题入库）单测，注入 mock；`compareAnswer` 归一化用例；哈希对齐后与 refinery 一致性用例。
- 前端：`LatexEditor` 光标插入、`LatexPreview` 渲染、modal 题目循环、答题列表对错展示。前端无测试框架，手动验收为主。

## 13. 任务分解（实施计划用）

1. 管线：`textbook_cards.txt` 增量改（practice 输出 `intro`+`questions`，`text` 逐字）+ `card_labeler.py` 解析（practice 传完整 content）+ `db_loader.py` 持久化 + `text` 子串校验（失败置 `needs_fallback`）+ 回填脚本 + 单测；**card_splitter 增强**（§5.5：同节补句 + `(N)` 原子 bundle + 标题感知）；前置 `.env` 切回 `deepseek-v4-flash`。
2. 后端-基础设施：`main-error-books.repo.ts`；`content-hash.util.ts` NFKC 对齐 + aux rehash 迁移脚本。
3. 后端-判定能力：`judgment/math-judge.md` 提示词 + `JudgmentCapability` + `model-routes.yaml` 新增 `judgment` scene + Zod schema + 单测（mock ModelClient）。
4. 后端-端点：`practice` 模块（controller/service/dto）+ `PracticeService.judge` 三路由 + 单测。
5. 前端-组件：`LatexEditor`/`LatexPreview`/`SymbolPalette`/`AnswerModal`。
6. 前端-集成：`CourseDetailPage` 练习卡**结构化渲染**（intro + 可点题块，正则兜底）+ `practiceStore` + 答题列表 + 解析 + `api.ts`。
7. 文档同步：openapi / API 设计文档 / DB 设计文档。

## 14. 不在本需求范围

- 错题清零重做的 AI 判定（既有 `error-book.service.redo` 目前自确认，P1 AI 判定 TODO）--与本需求复用 `JudgmentCapability`，但重做流改造单列。
- 变式练习生成（`variation` capability 已实现，另立需求）。
- 会话历史持久化（家长可见）--YAGNI，错题本已持久化。
