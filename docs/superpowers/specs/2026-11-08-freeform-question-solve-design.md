# 做题入口（自由做题）— 设计 spec

**日期**：2026-11-08
**主题**：`/student/entry` 新增第 4 个入口「做题」；图片/文字录入 → MinerU 识题 → 选题（题干+配图多选）→ 作答（左编辑/预览、右草稿）→ 千问 3.8-max 判题/答疑
**状态**：设计已与用户确认，待写实施计划
**关联**：PRD 新增 §7.15（本文定义）；API 文档新增 §4.30 / §5.33；模型路由新增 `freeform_split` / `freeform_judge`；答疑新增 `aux_freeform` 场景

---

## 1. 背景与目标

### 1.1 用户需求

1. `/student/entry` 增加第 4 张大卡「做题」，与学习/答疑/训练平级。
2. 首屏是一个与「答疑」一样的输入框：可输入文字、可拖拽/粘贴/选择图片（HEIC/JPG/PNG 等），图片可多张、有顺序。
3. 提交后先经 **MinerU** 把图片转成 Markdown + 配图资源，再由 **本地 LLM** 切题/结构化，列出候选题目。
4. 一图多题时学生选择其中一道；一道题可以有多张配图，配图是**多选**（学生可勾选/取消）。
5. 选中后进入作答页，骨架与 `/student/training/exam/run/:id` 第 9 题一致：
   - 题干在上；
   - 作答区左 Markdown+LaTeX 编辑器、右实时预览；
   - 右侧草稿面板（白板，题图配图可拖进去标注）；
   - 底部两个按钮【答疑】【提交】，居中。
6. 点【答疑】或【提交】后用不同提示词让千问 3.8-max 流式回答；随后多出一个 tab 并自动切过去，界面与「答疑」窗口一致（思考过程 + 正式回复 + 底部输入框）。
7. 【提交】判题：分步得分 + 建议；题目入库；不满分进错题本。
8. 提交后可以切回作答 tab 改答案再提交（重判同一题）；AI tab 里可以继续追问（只答疑不改分）。
9. 学生不会做时可直接点【答疑】问怎么做，不必先写答案。

### 1.2 本期目标

- 完整跑通「录入 → 识题 → 选题 → 作答 → 答疑/判题 → 追问」。
- 题目与错题本按用户口径落库：**题库总是、错题本只错题、不发分/不写练习记录/不更新掌握度**。
- 复用现有组件：`DraftWhiteboard`/`DraftPanel`、`LatexEditor`/`LatexPreview`、`AuxChatPanel`/`AuxInputBar`、`MarkdownImg.dragToDraft`、答疑 SSE 管道。
- 识别与判题均可观测（阶段状态、错误提示、可重试）。

### 1.3 边界（本期不做）

- 独立的历史记录页（不保存做题列表；刷新即重新开始）。
- 家长端做题记录/学情聚合。
- PDF/Office 上传（MinerU 支持，但本期 UI 只收图片 + 文字）。
- 学生手动框选配图区域（用 MinerU 自动提取 + 学生多选）。
- 同一会话批量做多道题（一次只做一道）。
- 积分、练习记录、掌握度、错题变式、组卷反哺。
- MinerU 本地私有化部署（本期用 `mineru-open-api` 云 CLI，需 token）。

---

## 2. 关键设计决策（已与用户确认）

| # | 决策 | 理由 |
|---|---|---|
| 1 | 图片 → MinerU（Markdown + 配图）→ 本地 LLM 切题；本地失败回退千问 | 用户明确：MinerU 出 Markdown+配图，再让本地 LLM 切题；印刷卷版面/公式/配图比纯视觉模型可靠 |
| 2 | 判题固定千问 3.8-max，流式返回思考过程 | 用户明确；与答疑同一套「思考过程实时展示」体验 |
| 3 | 题目**总是**入库（判题成功后），`source='freeform'` | 用户明确：无论做对做错都要记录到题库 |
| 4 | 错题本**只在不满分**时写入；满分清零既有未清错题 | 用户明确：错题本只错题；不满分即算错 |
| 5 | 不发积分、不写练习记录、不更新掌握度 | 用户明确：纯工具 |
| 6 | 不入任何自动练习池（专项/同类型/变式/考试/错题练习） | 用户明确：入库但隔离；实现上**不写知识点关联**（专项/同类型/变式/考试天然不入选）；错题练习为**页面不可勾选 + `judgeQuestion` 400/1001**，**未改抽题 SQL**；只留在错题本列表回看 |
| 7 | 不做独立历史；答疑会话落 `ai_dialogues`（`aux_freeform`），答疑列表不展示 | 用户明确：不单独做历史；但追问需要对话上下文 |
| 8 | 再次提交 = 重判同一题，题库更新同一条 | 用户明确 |
| 9 | 首次提交后锁定学科/满分；题干仍可编辑修正 | 避免同一题中途换学科/分值；识别错字允许修正 |
| 10 | 原题照片**不进全局题库**；只存 MinerU 提取出的配图 | 隐私：不同学生同题不应看到彼此的照片；配图是印刷图，泄露风险低 |
| 11 | 配图多选：AI 预选、学生可勾/取消 | 用户明确配图是多选 |
| 12 | 首屏录入用答疑式输入框（多图）；不是白板 | 用户明确交互顺序 |
| 13 | 作答页复用考试第 9 题骨架；草稿面板默认展开 | 用户明确 |
| 14 | 【答疑】复用现有答疑管道；【提交】走新的 freeform 判题管道 | 判题是结构化一次性任务，答疑是多轮对话，prompt/数据分离 |
| 15 | MinerU 不可用 → 报错 + 手动输入题目；不做 VLM 兜底 | 用户明确 |
| 16 | HEIC 在前端 `ensureJpeg` 转 JPEG 后上传 | MinerU/模型都不保证 HEIC；前端已有现成工具 |
| 17 | 最多 6 张题图；单张 ≤5MB；配图最多 6 张；草稿合成图 ≤5MB | 控制 MinerU/模型成本与等待 |
| 18 | 「附上草稿」默认勾选 | 用户明确：可选附草稿，默认勾选 |

---

## 3. 用户流程与页面状态

### 3.1 状态机

```
[entry 第4卡]
   ↓
[录入 input] --开始识题--> [识题中 loading] --成功--> [选题 select]
                                  └--失败--> [录入 input + 错误/手动输入]
   ↓
[选题 select] --开始作答--> [作答 answer]（只有「作答」tab）
   ↓
[作答 answer] --答疑--> [作答 + AI答疑 tab]（默认切 AI）
[作答 answer] --提交--> [作答 + AI答疑 tab]（默认切 AI，显示判题流）
```

- `input` / `select` 是 tab 之前的步骤，不显示 tab 条。
- `answer` 是第一个 tab「作答」。
- 「AI 答疑」tab 在第一次【答疑】或【提交】后创建并自动激活。
- 切回「作答」保留编辑器/草稿/题干状态；AI tab 保留对话。

### 3.2 状态 A · 录入

- 页面居中，标题「把题目发给我」，副标题「可输入文字，或拖入/粘贴题目图片（HEIC、JPG、PNG）」。
- 输入框外观与答疑首屏一致：圆角浅灰底、textarea、右下「+」选图、发送按钮。
- 多图：输入框上方显示缩略图条，最多 6 张，带序号徽标（第 1 页、第 2 页…）与删除按钮；支持一次多选、拖拽多张、连续粘贴。
- 图片状态：`转换中（HEIC）` → `上传中` → `就绪` / `失败（可移除重试）`。
- 「开始识题」按钮条件：至少 1 张图片 **或** 文字非空；所有图片上传完成；不在提交中。
- 文字可选：只输入文字时跳过 MinerU，直接把文字作为唯一候选题。

### 3.3 状态 B · 选题

- 顶部标题「识别到 N 道题」；N=1 时也进入此页，让学生确认。
- 候选列表（单选）：
  - 序号/原题号（如「第 5 题」）；
  - 题干预览（Markdown+LaTeX，最高约 12 行，可滚动）；
  - 配图缩略图（带复选框）。
- 选中一道后：
  - 该题的配图默认按 AI 建议勾选；学生可勾/取消；勾中的配图组成这道题的配图集。
  - 「编辑题干」切换到 textarea（Markdown 源码），可改识别错字/公式；旁边「恢复识别结果」。
- 学科：数学/物理/化学三选一，AI 可预选，学生可改。
- 满分：数字输入，默认 10，范围 1–100。
- 底部：「返回重新上传」（次） + 「开始作答」（主）。
- 若只有文字题：不显示配图区，学科默认数学（可改）。

### 3.4 状态 C · 作答（考试第 9 题骨架）

布局：

```
┌──────────────────────────────────────────────┬───────────────┐
│ [题干：Markdown+LaTeX+配图，可滚动，最高1/3]   │  草稿面板      │
│                                              │  （白板）      │
│ ┌────────────────────┬─────────────────────┐ │  默认展开      │
│ │ LatexEditor        │ LatexPreview        │ │  宽度可拖      │
│ │ （左，50%）         │ （右，50%）          │ │               │
│ └────────────────────┴─────────────────────┘ │               │
│                                              │               │
│        [附上草稿 ☑]      [答疑]  [提交]        │               │
└──────────────────────────────────────────────┴───────────────┘
```

- 页面外壳：`student-theme-container` + 写死 `data-theme="student-day"` + `data-school="junior"`（与现有训练页一致；本页不做夜间切换）。
- 顶栏：左侧「返回入口」+ 标题「做题」；右侧用户信息 + 退出。
- 题干：
  - 用 `ReactMarkdown` + `markdownRemarkPluginsWithBreaks` + `markdownRehypePlugins` 渲染；
  - 图片用 `MarkdownImg dragToDraft`，可拖进右侧草稿白板；
  - 题干高度上限约卡片 1/3，超出内部滚动。
- 作答区：左 `LatexEditor`、右 `LatexPreview`，各占 50%，`min-w-0` 防撑破。
- 草稿面板：
  - 复用 `DraftPanel`（页面级，真实占位，不是浮层）；
  - 默认展开；宽度默认 35%，可拖 25%–55%，双击复位；
  - 头部「草稿」+ 收起按钮；收起后右上角显示 `DraftIconButton`；
  - 白板 `scrollMode="scroll-y"`，保留全部现有工具（手写/圆规/点/直线/矩形/椭圆/三角形/橡皮/选中/撤销/重做/清空）。
- 底部：
  - 三个元素一行：左「附上草稿」勾选框（默认勾选）；中间【答疑】（次按钮）+【提交】（主按钮）；右侧留白；
  - 按钮组相对卡片居中；
  - 提交中禁用，按钮显示 loading。

### 3.5 AI 答疑 tab

- 出现条件：第一次【答疑】或【提交】后；tab 条出现「作答 / AI 答疑」，默认切到 AI。
- 外观与 `/student/auxiliary` 对话态一致：
  - `AuxChatPanel`（消息列表、思考过程折叠块、Markdown+LaTeX 渲染、错误气泡、重试）；
  - `AuxInputBar`（底部输入，支持文字 + 图片）；
  - 顶部无额外工具条。
- 消息：
  - 首次【答疑】：用户气泡「这题怎么做？（我的尝试：…）」+ 题图；助手流式思考 + 苏格拉底引导。
  - 首次【提交】：用户气泡「我的作答」+ 题图 + 作答 Markdown（按 Markdown 渲染）；助手流式思考 + 判题报告。
  - 追问：普通用户/助手气泡。
- 判题报告内容：
  - 总分（`x / max`）+ 结论（完全正确/部分正确/错误）；
  - 分步表：步骤、得分/满分、点评；
  - 改进建议；
  - 参考解析/标准答案（作为报告的一部分，不单独做「看答案」门禁）。
- 提交后切回「作答」再提交：
  - 不新建题；把新的「我的作答」+ 新的判题报告追加到同一个对话；
  - 题目的题库记录更新；错题本按最新结果留/清。
- 追问只答疑：不写题库、不改分、不动错题本。

---

## 4. 数据模型

### 4.1 复用的表

不新增表。

**`questions`**（题库）
- 新增的 freeform 题使用：
  - `subject_id`：学科；
  - `type`：AI 判定的题型（`choice`/`multi_choice`/`fill_blank`/`true_false`/`short_answer`/`proof`/`calculation`，非法回落 `short_answer`）；
  - `difficulty`：1–3，非法回落 2；
  - `full_score`：学生选的满分（1–100）；
  - `content`：最终题干 Markdown（含学生勾选的配图 URL）；
  - `options`：选择题的 `[{label,text,isCorrect}]` JSON，其余 NULL；
  - `answer`：AI 给出的标准答案（必须非空，否则不入库）；
  - `approach`：AI 的解题思路，可空；
  - `explanation`：AI 的解析，可空；
  - `source='freeform'`；
  - `content_hash`：题干文本（**去掉 Markdown 图片**）归一化后的 SHA-256；
  - `answer_verified=0`（默认）；
  - `is_active=1`；
  - `grade_band=NULL`（本期不写学段）；
  - `material_text`/`material_url` NULL（配图在 content 里）。
- **不写 `question_knowledge_points`**：这是「隔离」的实现方式——现有专项/同类型/变式抽题都以 KP 为入口，没有 KP 关联就不会被抽到。
- 去重：
  - 先 `findByContentHash`；
  - 未命中再用 `findByContentPrefix`（与辅助答疑同口径）——**两个匹配都用去图片后的题干文本**，不要拿带 `/uploads/` 的 content 做前缀；
  - 命中则复用已有题，不覆盖其内容/答案；
  - 未命中才插入。
- 重判同一题（`questionId` 已知且 `source='freeform'`）：
  - 更新 content/answer/explanation/approach/type/difficulty/options/full_score/content_hash；
  - 若新 hash 与**另一条**题冲突，保留原 hash 并记 warn，不抛错。

**`main_error_books`**（错题本）
- 不满分：
  - 先 `findUnclearedByStudentQuestionId`；有则复用，无则 `create`；
  - `source='freeform'`、`subject_id`、`question_id`、`question_n=NULL`、`lesson_id=NULL`、`wrong_answer_text=NULL`、`level=1`；
  - `create` 不接收 `dialogue_id`（现有仓库签名）；新建后用 `updateDialogueId(id, dialogueId)` 补写，失败只 warn。
- 满分：
  - `clearUnclearedByStudentQuestionId(student, question)`；
  - **不发订正分**（不调 `PointsService`）。
- 不写 `error_redo_logs`。

**`ai_dialogues`**（答疑会话）
- `track='auxiliary'`、`scene='aux_freeform'`、`subject_id`、`question_id`（判题成功后回填）、`title='做题 · <题号或题干前 20 字>'`、`status='active'`。
- `ConversationsService.SCENE_BY_TRACK.auxiliary` 增加 `aux_freeform`；`AiDialogueScene` 类型增加该值。
- 答疑会话列表 `listAllConversations('auxiliary','aux_qna')` 已按 scene 过滤，**不会**出现在答疑历史里。

**`ai_messages`**
- 判题成功时写入两条：
  - user：`type='freeform_submit'`，content =「题目：…\n\n我的作答：…」，attachments = 原题图/配图 URL 的 JSON；
  - assistant：`type='freeform_judge'`，content = 去掉尾部 JSON 的判题报告，reasoning = 完整思考，model = 实际模型 key。
- 答疑/追问的消息由现有答疑管道写入（`type='socratic'`）。
- 写入失败只 warn，不影响判题结果返回；但追问上下文可能缺失（会在日志里可见）。

**`uploaded_files`**
- 原题图/作答图/草稿合成图：走 `/api/files/upload?source=freeform`，`uploader_id=学生`。
- MinerU 提取的配图：服务端落盘到 `UPLOAD_DIR/freeform/<uuid>/fig-*.jpg`，并插入 `uploaded_files`（`uploader_type='student'`、`source='freeform_figure'`、`url=/uploads/freeform/...`），用于归属与清理。

### 4.2 content_hash 归一化

新增 `computeFreeformContentHash(content)`：
1. 删除 Markdown 图片 `![alt](url)`；
2. 删除 HTML 注释与 `<!-- page N -->` 标记；
3. 用现有 `normalizeForHash` + `computeContentHash`。

目的：同一道题不同学生的配图 URL 不同，但文本一致时仍命中去重。

### 4.3 抽题池隔离验证

- 专项抽题 `findRandomByKpAndType` JOIN `question_knowledge_points`：freeform 无 KP → 不入选。
- 同类型练习/变式按 KP → 不入选。
- 考试按 `paper_questions` → 不入选。
- 错题练习 `findUnclearedPracticeByStudentSubject`：**实现未改抽题 SQL**——错题练习页把 freeform 条目显示为不可勾选，并由训练判题入口 `judgeQuestion` 对 `source='freeform'` 返回 400/1001 兜底（见 §5.2 实现注）。理由：错题练习会用题库的 `answer` 当标准答案判题，AI 写的答案未经人工核验，进正式练习有判错风险；freeform 错题只在错题本列表回看。
- 家长端错题列表：`TRACK_SOURCES` 把 `freeform` 归 `training` 档（与 `auxiliary` 同）；家长会看到这道错题，但不参与发分/掌握度/练习池。

---

## 5. 后端接口

### 5.1 `POST /api/files/upload?source=freeform`（扩展现有）

**改动**：`FilesController.upload` 增加可选 query `source`，白名单 `auxiliary|freeform`，缺省 `auxiliary`；`FilesService.upload` 已接收 source 参数，无需改逻辑。

**校验**：
- 文件缺失 → 400/1001「缺少上传文件」；
- `source` 非白名单 → 400/1001；
- 文件大小 >20MB → 由 multer 限制，413（现有行为）。

**返回**：`{ fileId, url, taskId? }`（现有形状）。

**用途**：录入图片、作答区粘贴图、草稿合成图。

### 5.2 `POST /api/freeform/recognize`

**鉴权**：`JwtAuthGuard` + `Roles('student')`。

**请求**：

```json
{
  "text": "第 5 题",                       // 可选，≤20000 字
  "attachments": [                          // 可选；有图才走 MinerU
    { "type": "image", "fileId": "123" },
    { "type": "image", "fileId": "124" }
  ]
}
```

**校验链**：
1. `text` 非字符串 / 长度 >20000 → 400/1001；
2. `attachments` 非数组 / >6 项 → 400/1001「最多 6 张题图」；
3. 每项 `type` 必须 `image`、`fileId` 为正整数 → 400/1001；
4. 逐个 `findByIdAndOwner`，不存在/非本人 → 400/1001「文件不存在或无权访问」；
5. MIME 必须 `image/jpeg`、`image/png`、`image/webp`（HEIC 已由前端转 JPEG）→ 400/1001「图片格式不支持」；
6. 单张 >5MB → 400/1001「图片过大（最大 5MB）」；
7. 无图且 `text` 为空 → 400/1001「请上传题目图片或输入题目文字」。

**处理步骤**：

1. **纯文字**：跳过 MinerU 与本地切题，直接返回 1 个候选：
   ```json
   {"candidates":[{"id":"c1","no":"1","content":"<text>","figureUrls":[],"suggestedSubject":null,"confidence":1}],"figures":[]}
   ```
2. **有图**：
   1. 建临时目录 `os.tmpdir()/freeform-recognize-<uuid>/`；
   2. 按 attachments 顺序复制为 `page_01.jpg`、`page_02.jpg`…（扩展名按 MIME）；
   3. 调 MinerU（见 §6），输出到临时目录 `out/`；
   4. 读取 `out/page_*.md`，按页号排序；缺页 → 5501；
   5. 建 `UPLOAD_DIR/freeform/<uuid>/`，把 `out/images/*` 复制进去；重写每个 md 里的 `images/<name>` 为 `/uploads/freeform/<uuid>/<name>`；
   6. 拼接 Markdown，页间插 `<!-- page N -->`；
   7. 若 Markdown 长度 > 24000 字符 → 直接用千问切题；否则先本地切题，失败/超时/JSON 非法 → 千问切题；
   8. 校验候选：至少 1 道、content 非空；最多 20 道；`figureUrls` 必须是本次提取的 URL 子集；
   9. 返回。
3. **清理**：临时目录在 `finally` 删除；复制到 `/uploads` 的配图保留。

**响应**：

```json
{
  "candidates": [
    {
      "id": "c1",
      "no": "5",
      "content": "![图1](/uploads/freeform/xxx/fig-1.jpg)\n\n已知……求……",
      "figureUrls": ["/uploads/freeform/xxx/fig-1.jpg"],
      "suggestedSubject": "math",
      "confidence": 0.92
    }
  ],
  "figures": [
    { "url": "/uploads/freeform/xxx/fig-1.jpg", "name": "fig-1.jpg", "page": 1 }
  ]
}
```

- `figures` 是**本次所有提取出的配图**，供学生多选；`candidates[].figureUrls` 是 AI 建议关联的子集。
- `suggestedSubject` 可为 `math|physics|chemistry|null`。
- `confidence` 0–1；前端可显示「识别把握」但不做硬门禁。

**错误码**：

| 场景 | HTTP | code | 说明 |
|---|---|---|---|
| 入参/张数/格式/大小 | 400 | 1001 | 参数校验失败 |
| 文件不存在/非本人 | 400 | 1001 | 文件不存在或无权访问 |
| MinerU 失败/超时/缺页 | 502 | 5501 | 「图片解析失败，请重试或手动输入题目」 |
| 切题模型失败（本地+千问都失败） | 502 | 5502 | 「题目切分失败，请重试或手动输入题目」 |
| 识别出 0 道题 | 200 | — | `candidates: []`，前端提示换图/手动输入 |
| 服务内部异常 | 500 | 5000 | AI 服务异常 |

> 失败时前端保留已上传的图片与文字，提供「重试」和「手动输入题目」两个出口。手动输入题目 = 把当前输入的文字（或空）作为一个候选，直接进入选题页。

> **实现注（2026-11-08）**：本节的实现与上文草稿有三处差异，**以本注为准**：
> 1. **请求体是 `{text?: string, fileIds: string[]}`**（不是 `attachments: [{type,fileId}]`）；`fileIds` 为**正整数字符串**、按数组顺序即页序、最多 6 张，`text` 与 `fileIds` 至少给一个。
> 2. **recognize 成功返回 201**（Nest `@Post` 默认，未显式 `@HttpCode`），不是 200。
> 3. **抽题池隔离不靠抽题 SQL 过滤**：错题练习页把 freeform 条目显示为不可勾选，并由**训练判题入口**（`JudgeCoreService.judgeQuestion`）对 `q.source='freeform'` 抛 400/1001 兜底；`main_error_books` 抽题 SQL 不改。

### 5.3 `POST /api/freeform/judge/stream`

**鉴权**：`JwtAuthGuard` + `Roles('student')`。

**Content-Type**：`text/event-stream`；手动 `@Res()` 写流，不走全局拦截器。

**请求**：

```json
{
  "dialogueId": "123",                     // 可选；无则服务端创建
  "subjectId": 1,                           // 必填；1/4/5
  "maxScore": 10,                           // 必填；1–100 整数
  "questionId": 456,                        // 可选；再次提交时带
  "questionContent": "Markdown...",         // 必填；最终题干（含勾选配图）
  "questionImages": [                       // 可选；原题图，按顺序
    { "type": "image", "fileId": "123" }
  ],
  "figureUrls": ["/uploads/freeform/..."],  // 可选；勾选的配图
  "answer": "Markdown...",                  // 必填（可为空字符串，但需有草稿图）
  "draftFileId": "130"                      // 可选；附上的草稿合成图
}
```

**校验链**：
1. `subjectId ∈ {1,4,5}` → 否则 400/1001「学科仅支持数学/物理/化学」；
2. `maxScore` 整数 1–100 → 否则 400/1001；
3. `questionContent` 非空、≤30000 字 → 否则 400/1001；
4. `answer` ≤30000 字；`answer.trim()` 为空且无 `draftFileId` → 400/1001「请先写答案或在草稿上作答」；
5. `questionId` 若传：必须是正整数且题目存在；若 `source='freeform'` → 本次更新该行；若 `source` 不是 `freeform`（首次去重命中了真实题库题）→ 只复用、不改题；不存在 → 400/1001；
6. `dialogueId` 若传：必须是正整数、属于当前学生、`scene='aux_freeform'` → 否则 400/1001/1002/1005；
7. 所有 fileId：`findByIdAndOwner`、MIME image、≤5MB → 否则 400/1001；
8. `figureUrls`：必须以 `/uploads/freeform/` 开头、路径在 `UPLOAD_DIR` 内、文件存在、最多 6 张 → 否则 400/1001；
9. `answer` 里内嵌的 `/uploads/` 图片（学生粘贴的作答图）也按同样规则解析归属，最多 6 张。

**处理步骤**：

1. 解析图片：
   - 原题图 → data URL；
   - 勾选配图 → 读文件 → data URL；
   - 草稿图 → data URL；
   - 作答 Markdown 内嵌图 → data URL；
   - 统一编号并打标签（原题图 1..N / 配图 1..M / 草稿 / 作答图 1..K）。
2. 若 `dialogueId` 无：创建 `ai_dialogues`（track=auxiliary、scene=aux_freeform、subject_id、title）。
3. 调 `FreeformJudgeCapability.stream()`：
   - 路由 `scene='freeform_judge'`，`subject=subjectCodeOf(subjectId)`；
   - 模型 qwen3.8-max；`thinking: true`（要思考过程）；
   - 流式产出 `reasoning` / `content`。
4. 服务端把事件原样转发：
   ```
   data: {"type":"start","dialogueId":"123","questionId":null}
   data: {"type":"reasoning","delta":"..."}
   data: {"type":"content","delta":"..."}
   ```
5. 流结束后：
   1. 从累计 content 中提取**最后一个** ```json 块；
   2. zod 校验 §7.2 的结构；失败 → 再发一次非流式「结构化提取」调用（qwen，json_object，thinking=false）只取 JSON；仍失败 → 发 `error`（5502, retryable）；
   3. 清理 content（去掉 JSON 块）→ 发 `{"type":"content","delta":"<cleaned>","replace":true}`；
   4. 写库（§5.3.1）；
   5. 发 `{"type":"result","questionId":456,"totalScore":7,"maxScore":10,"verdict":"partial","errorBookId":789}`；
   6. 发 `{"type":"done"}`。
6. 客户端断开：AbortController 中止上游模型；已生成的部分报告**不写库**（没有结构化结果），只记日志。

**SSE 事件**：

| type | 字段 | 说明 |
|---|---|---|
| `start` | `dialogueId`, `questionId?` | 流开始；前端记住对话 id |
| `reasoning` | `delta` | 思考增量 |
| `content` | `delta`, `replace?` | 正文增量；`replace=true` 时用整段替换 |
| `result` | `questionId`, `totalScore`, `maxScore`, `verdict`, `errorBookId?` | 结构化结果 |
| `error` | `code`, `message`, `retryable` | 判题/解析/入库失败 |
| `done` | — | 结束 |

**5.3.1 落库顺序（事务边界）**

1. 插入/更新 `questions`（§4.1）；
2. 写/清 `main_error_books`；
3. 更新 `ai_dialogues.question_id`（仅 NULL 时）；
4. 写 `ai_messages` 两条（user + assistant）；
5. 更新 `main_error_books.dialogue_id`（仅新建错题行时）。

- 1–2 是**关键写**：任一步失败 → 发 `error`（5000，retryable），不发 `result`；前端显示「判题完成但入库失败，请重试」，报告仍保留。
- 3–5 是**尽力写**：失败只 warn，不阻断 `result`。
- 不在请求路径上 await 埋点/账本（本功能不加埋点）。

**再次提交**：
- 前端带 `questionId`（上次 `result` 返回的）；
- 服务端：若该题 `source='freeform'` → 更新同一条；若首次去重命中了真实题库题（source 非 freeform）→ 只复用、不改题；
- 错题本按最新分数留/清；
- 新的 user/assistant 消息追加到同一 dialogue；
- 前端在 AI tab 追加新的一轮，不重置旧报告。

**错误码**：

| 场景 | HTTP/code | 说明 |
|---|---|---|
| 入参/学科/满分/图片 | 400/1001 | 参数校验失败 |
| 对话不存在/非本人 | 404/1002、403/1005 | — |
| 模型调用失败 | SSE `error` 5502 | 可重试 |
| JSON 解析失败（含二次提取） | SSE `error` 5502 | 可重试 |
| 题库/错题本写失败 | SSE `error` 5000 | 可重试；报告保留 |

### 5.4 答疑 / 追问（复用现有接口）

**创建会话**：`POST /api/conversations`

```json
{
  "track": "auxiliary",
  "scene": "aux_freeform",
  "subjectId": 1,
  "questionText": "<题干 Markdown>"
}
```

- `questionText` 会写成一条 assistant 题面锚消息，供 AI 每轮带上下文。
- 返回 `{ id, ... }`。

**提问 / 追问**：`POST /api/ai/tutor/stream`

```json
{
  "mode": "auxiliary",
  "dialogueId": "123",
  "message": "这题怎么做？请引导我思考，不要直接给答案。",
  "attachments": [{ "type": "image", "fileId": "123" }]
}
```

- 复用现有 SSE（reasoning/content/done/error）。
- 【答疑】按钮行为：
  - 若 `dialogueId` 为空：先创建会话（带题干锚）；
  - 打开 AI tab；
  - 发送：编辑器有内容 →「我这题不太会，我的尝试是：\n<answer>\n请引导我思考，不要直接给答案。」；为空 →「这题怎么做？请引导我思考，不要直接给答案。」
  - 附件 = 原题图。
- 提交后的追问：同上，只是 `message` 是学生自己输入的。
- 首次提交时若 `dialogueId` 为空：前端先创建会话（带题干锚），再调 `judge/stream`。

**答疑会话列表隔离**：`useAuxiliaryStore.fetchConversations()` 只拉 `scene='aux_qna'`，`aux_freeform` 不出现在答疑历史里。本页不做历史入口。

---

## 6. MinerU 集成

### 6.1 依赖与环境变量

- CLI：`mineru-open-api`（本机 `/usr/local/bin/mineru-open-api`；部署环境需安装 `pip install mineru` 并 `mineru-open-api auth`）。
- 环境变量：
  - `MINERU_BIN`：默认 `mineru-open-api`；
  - `MINERU_TOKEN`：必填；`sk-` 开头 API Key 或 `eyJ` 开头 JWT；不能带 `mineru-api/` 前缀；
  - `MINERU_TIMEOUT_MS`：默认 `90000`；
  - `MINERU_CONCURRENCY`：默认 `2`。
- `.env.example` 增加上述四项；部署文档说明安装与 token。

### 6.2 调用

```ts
spawn(bin, [
  'extract',
  ...pageFiles,          // page_01.jpg, page_02.jpg...
  '-o', outDir,
  '-f', 'md',
  '--timeout', '90',
], {
  shell: false,
  env: { ...process.env, MINERU_TOKEN: token },
  cwd: tmpDir,
})
```

- `shell: false`，参数数组，避免注入。
- 进程级超时 `MINERU_TIMEOUT_MS`，超时 `kill('SIGKILL')`。
- 退出码非 0 → 抛 `FreeformMineruError`，message 只保留 stderr 最后 500 字（**剔除 token**）。
- **不自动重试**（在线等待成本高）；前端给「重试」按钮。
- 并发：模块级信号量，最多 `MINERU_CONCURRENCY` 个；超出的请求排队等待（最多 2 分钟，超时 503）。

### 6.3 输出解析

- MinerU 按输入文件 stem 输出 `page_01.md`、`page_02.md`… + 共享 `images/`。
- 按文件名排序读取；缺失页 → 5501。
- 配图引用：Markdown 里的 `![...](images/xxx.jpg)`；复制 `images/*` 到 `/uploads/freeform/<uuid>/`，重写为绝对路径 `/uploads/freeform/<uuid>/xxx.jpg`。
- 图片文件名若重复，加 `fig-N-` 前缀；保留原始扩展名。
- 临时目录 `finally` 递归删除。
- **实现第一步先做 1 张图的冒烟**，以实际 CLI 输出文件名/目录结构为准；如果 CLI 版本差异导致命名不同，解析层按「输入 stem + .md」优先，找不到再扫目录。

---

## 7. AI 能力与提示词

### 7.1 `freeform_split`（MinerU Markdown → 候选题）

- 路由：`primary: local`，`fallback: qwen3.8-max`。
- 输入：拼接后的 Markdown（含 `<!-- page N -->`）、可选 `textHint`（学生输入的文字）、`subjectHint`。
- 模型调用：`responseFormat:'json_object'`、`thinking:false`、`timeout:45000`。
- System 提示词（`prompts/freeform/split.md`）：
  - 你是题目切分器，不是解题器；
  - 找出所有完整题目，按原顺序；
  - 跨页题目合并；
  - 保留题干 Markdown/LaTeX 与图片引用，不改写；
  - 忽略页眉页脚、注意事项、答案解析、分值说明；
  - 一图多题时每题单独一条；
  - 如果学生给了文字提示（如「第 5 题」），优先把对应题目标为 `selectedHint:true`。
- 输出 schema：

```ts
z.object({
  questions: z.array(z.object({
    no: z.string().max(20),                 // 原题号，找不到用 "" 或 "1"
    content: z.string().min(1),             // Markdown，含图片引用
    figureRefs: z.array(z.string()).default([]), // 图片文件名或 Markdown 引用
    suggestedSubject: z.enum(['math','physics','chemistry']).nullable().default(null),
    confidence: z.number().min(0).max(1).default(0.8),
    selectedHint: z.boolean().default(false),
  })),
})
```

- 失败判定：非 JSON / schema 不通过 / `questions` 为空 → 回退千问。
- 千问仍失败 → 5502；前端提示手动输入题目。
- 候选最多 20 道；超出截断并 warn。

### 7.2 `freeform_judge`（判题）

- 路由：`primary: qwen3.8-max`，`fallback: null`（用户指定千问；失败直接报错可重试）。
- 模型调用：流式、`thinking:true`、`responseFormat:'text'`（不强制 json，因为要先流式报告）。
- System 提示词（`prompts/freeform/judge.md`）：
  - 你是理科阅卷老师；
  - 输入：题目 Markdown + 配图、学生作答 Markdown、可选草稿图/作答图；
  - 先独立解题，再按步骤批改；
  - 满分固定为请求里的 `maxScore`，不得改；
  - 结论：`correct`（满分）/`partial`（>0 且 <满分）/`incorrect`（0 分）；
  - 报告先输出 Markdown（总分、结论、分步表、改进建议、参考解析），最后输出**唯一一个** ```json 块；
  - JSON 里的 `question` 必须是可入库的结构化题：type/difficulty/options/answer/explanation/approach；
  - 不要输出第二个 json 块；不要解释 JSON。
- 报告格式（Markdown）：

```markdown
## 判题结果

**得分：7 / 10** · **结论：部分正确**

| 步骤 | 得分 | 点评 |
|---|---|---|
| 1. 设未知数 | 2/2 | 正确 |
| 2. 列方程 | 2/3 | 漏了单位换算 |
| 3. 求解 | 3/5 | 计算错误 |

### 改进建议

- ...
- ...

### 参考解析

...
```

- 尾部 JSON schema：

```ts
z.object({
  verdict: z.enum(['correct','partial','incorrect']),
  totalScore: z.number(),
  maxScore: z.number(),
  steps: z.array(z.object({
    stepNumber: z.number().int(),
    description: z.string(),
    score: z.number(),
    maxScore: z.number(),
    isCorrect: z.boolean(),
    comment: z.string(),
    errorType: z.enum(['logic','calculation','format','missing']).nullable().optional(),
  })).default([]),
  suggestions: z.array(z.string()).default([]),
  question: z.object({
    type: z.enum(['choice','multi_choice','fill_blank','true_false','short_answer','proof','calculation']),
    difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    options: z.array(z.object({
      label: z.string(), text: z.string(), isCorrect: z.boolean(),
    })).nullable().default(null),
    answer: z.string().min(1),
    explanation: z.string().nullable().default(null),
    approach: z.string().nullable().default(null),
  }),
})
```

- 服务端校验：
  - `maxScore` 以请求为准；`totalScore` clamp 到 `[0, maxScore]`；
  - `verdict` 按 `totalScore` 重算（不信任模型给的 verdict）；
  - `steps` 的分数 clamp；sum 不等于 totalScore 时以 totalScore 为准，warn；
  - `question.type` 不在枚举 → `short_answer`；
  - `question.difficulty` 非法 → 2；
  - `question.answer` 为空 → 入库失败（不发 result）。
- 解析失败：二次非流式提取（qwen、json_object、thinking:false、timeout 45s）只取 JSON；仍失败 → 5502。

### 7.3 答疑（复用现有）

- 走 `TutoringCapability`，prompt 仍按学科/`auxiliary` 加载。
- 不在本期改答疑 prompt；`aux_freeform` 只是 scene，不影响 `tutoring/<subject>/auxiliary.md` 的选择。
- 追问的模型路由沿用现有 `tutoring` 路由；数学/物理/化学默认 qwen3.8-max（物理/化学无专门档，走 default）。
- 若后续要求答疑也严格 qwen，可新增 `freeform_tutor` 路由，本期不做。

### 7.4 模型路由与 DB 迁移

`apps/server/src/ai-core/model-routes.yaml` 增加：

```yaml
routes:
  freeform_split:
    - subject: "*"
      primary: local
      fallback: qwen3.8-max
  freeform_judge:
    - subject: "*"
      primary: qwen3.8-max
```

- `Scene` 类型增加 `'freeform_split' | 'freeform_judge'`。
- 运行期真源是 DB `llm_routes`；新增幂等迁移：
  `apps/server/src/scripts/migrate-freeform-routes.ts`
  - 插入 `('freeform_split','*','local','qwen3.8-max')`、`('freeform_judge','*','qwen3.8-max',NULL)`；
  - `ON DUPLICATE KEY UPDATE` 只更新 primary/fallback；
  - 不删除/覆盖其它路由。
- 管理端模型配置页应能看到这两条路由（现有页面按 `llm_routes` 渲染，无需改 UI）。
- 构建：`npm run build` 的 copy-assets 会把新 prompts 拷进 dist（现有脚本）。

---

## 8. 前端实现

### 8.1 路由与入口

- 新路由：`/student/solve`（`RequireRole role="student"`），页面 `SolvePage`。
- `/student/entry`：
  - 三卡改四卡：学习 / 答疑 / 训练 / **做题**；
  - 图标：铅笔 + 直尺（线性 SVG，无 emoji）；
  - 中屏 `grid-cols-2`，PC `lg:grid-cols-4`；
  - 卡片样式与现有三卡一致，不按学段分色；
  - 点击 `navigate('/student/solve')`。
- 页面外壳：
  - `student-theme-container` + `data-theme="student-day"` + `data-school="junior"`；
  - 全屏 `h-screen`（考试答题页同款）；
  - 无夜间切换、无侧栏。

### 8.2 组件拆分

| 组件 | 职责 |
|---|---|
| `SolvePage` | 状态机、tab、页面级数据流 |
| `SolveSourceInput` | 状态 A：文字 + 多图（拖拽/粘贴/选择），缩略图条、上传状态、开始识题 |
| `SolveCandidatePicker` | 状态 B：候选单选、配图多选、题干编辑、学科/满分、开始作答 |
| `SolveAnswerView` | 状态 C：题干 + 左编辑/右预览 + 底部按钮；不含草稿面板（由页面并排） |
| `DraftPanel` | 复用现有；草稿白板 + 宽度拖拽 |
| `AuxChatPanel` | 复用现有；AI tab 消息列表 |
| `AuxInputBar` | 复用现有；AI tab 输入 |
| `SolveTabs` | 简单的「作答 / AI 答疑」tab（可参考 `PreviewDraftPanel` 的 tab 样式） |

新增 hook：
- `useFreeformRecognize()`：上传/识别状态、候选、错误、重试；
- `useFreeformJudge()`：SSE 判题、思考/正文增量、result/error、questionId；
- `useFreeformTutor()`：创建 `aux_freeform` 会话 + 答疑 SSE（参考 `useAuxChat`，但不更新答疑 store）；
- `useSolveDraft()`：草稿 key、快照导出、提交后清空。

### 8.3 状态 A 细节

- 多图输入不能用现有 `AuxInputBar`（它只支持单文件）；新建 `SolveSourceInput`，复用：
  - `ensureJpeg`（HEIC→JPEG）；
  - `uploadFile`；
  - 拖拽/粘贴/文件选择逻辑；
  - 视觉样式对齐 `AuxInputBar`（圆角、浅灰底、右下按钮）。
- 图片列表：`{ localId, file, previewUrl, status, fileId?, url?, error? }`。
- 顺序 = 入库/上传顺序；缩略图显示「第 N 页」。
- 删除中间一张：后面的序号前移；已上传的 fileId 保留在 state，提交时按当前顺序取。
- 开始识题：
  - 校验至少一图或文字非空；
  - 所有图片 `ready`；
  - 组装 `attachments`（按顺序）；
  - 调 `POST /api/freeform/recognize`；
  - 成功 → `setCandidates`、`stage='select'`；
  - 失败 → 保留输入、显示错误条 +「重试」+「手动输入题目」。
- 手动输入题目：`stage='select'`，候选 = `[{content: text, figureUrls: []}]`；若 text 为空，显示 textarea 让用户输入。

### 8.4 状态 B 细节

- 候选题卡片：
  - 单选 radio（自定义样式，品牌橘色选中）；
  - 题干预览：`ReactMarkdown` + KaTeX，最高 12 行滚动；图片用普通 `MarkdownImg`（此处不拖拽）；
  - 配图缩略图 + checkbox；默认勾选 `candidate.figureUrls`；
  - 「编辑题干」切换 textarea，值 = 当前候选 content；编辑后 `figureUrls` 仍保留，渲染时按勾选过滤。
- 学科/满分：
  - 学科三段按钮（数学/物理/化学），默认 `candidate.suggestedSubject ?? 'math'`；
  - 满分 number input，默认 10，min 1 max 100；
  - 校验不过 → 按钮禁用 + 行内提示。
- 开始作答：
  - 组装最终题干：把 content 中未勾选的配图 Markdown 删除；勾选但未在 content 中出现的配图追加到末尾；
  - 进入 `stage='answer'`，初始化 `LatexEditor` 空值、草稿 key；
  - 锁定学科/满分（state 记录 `locked:true`）。

### 8.5 状态 C 细节

- 题干渲染：
  - 组件：`ReactMarkdown` + `markdownRemarkPluginsWithBreaks` + `markdownRehypePlugins`；
  - `img: (props) => <MarkdownImg {...props} dragToDraft bucketHeight className="block mx-auto my-4 max-w-full object-contain rounded-lg" />`；
  - 与 `QuestionRunner` 的 `QUESTION_MD_COMPONENTS` 同款。
- 作答区：
  - 左 `LatexEditor`，`scrollSync` 用 `PreviewScrollSync`；
  - 右 `LatexPreview`，`imgClassName=ANSWER_IMG_CLASS`；
  - 编辑器支持粘贴/拖图上传（现有能力）；上传中禁用提交。
- 草稿：
  - `DraftPanel` 默认展开；`draftKeyPrefix='freeform-'+sessionKey`；
  - 收起后右上角 `DraftIconButton`；
  - 题干配图拖入：`MarkdownImg.dragToDraft` + `DraftWhiteboard` 的 `registerDropTarget` 现有链路；
  - 快照导出：新增 `DraftWhiteboard` 的 `snapshotRef` prop（见 §8.6）。
- 底部：
  - 左「附上草稿」checkbox，默认 true；
  - 中【答疑】次按钮（边框、主色文字/图标）、【提交】主按钮（品牌橘色）；
  - 提交中两个按钮都禁用，【提交】显示 spinner；
  - 提交条件：`answer.trim()` 非空 **或**（勾选附草稿且草稿非空）；否则 toast「请先写答案或在草稿上作答」。
- 提交前：
  - 若勾选附草稿：
    - 调 `snapshotRef.current()` 得到 JPEG data URL；
    - 草稿为空（无笔迹、无贴图）→ **跳过草稿**，不阻塞（若答案也为空则已被提交条件拦住）；
    - 生成失败 → toast「草稿生成失败，可取消附草稿后提交」，中止本次提交；
    - 生成成功 → data URL 转 Blob，`uploadFile(blob, signal, 'freeform')` → fileId；
  - 若 `dialogueId` 为空：`createConversation({track:'auxiliary', scene:'aux_freeform', subjectId, questionText})`；
  - 调 `useFreeformJudge.submit(...)`。
- 提交后：
  - 若 AI tab 不存在 → 创建并激活；
  - 用户气泡：题图缩略图 + 作答 Markdown（`ChatMessage.markdown=true`）；
  - 助手占位消息 `streaming:true`；
  - 消费 SSE，更新 reasoning/content；
  - `result` → 存 `questionId`、`lastScore`；可再次提交；
  - `error` → 错误气泡 + 重试（重试只重发判题，不重复上传已上传的图片/草稿）。

### 8.6 草稿快照导出（对 `DraftWhiteboard` 的最小改动）

- 新增 prop：
  ```ts
  snapshotRef?: React.MutableRefObject<(() => Promise<string | null>) | null>;
  ```
- 组件内把函数挂到 `snapshotRef.current`：
  1. 读取 `strokesRef.current` + `imagesRef.current`；
  2. 新建离屏 canvas，尺寸 = board 的 CSS 尺寸（scroll-y 模式为整块 board 高度），最长边超过 1600px 等比缩；
  3. 白底填充（避免透明背景在 JPEG 里变黑）；
  4. 用抽出的 `drawStrokes(ctx, strokes)` 画笔迹（与 `redraw` 同一实现，抽到 `draft-render.ts`）；
  5. 按 `x/y/w/h` 画贴图（`await` 图片加载；`crossOrigin` 同源不需要）；
  6. `canvas.toDataURL('image/jpeg', 0.85)`；
  7. 返回 data URL；无内容返回 `null`。
- 抽 `draft-render.ts` 时保持 `DraftWhiteboard` 的渲染行为不变（纯函数迁移 + 测试）。
- 快照大小：JPEG ≤5MB；若超限，降质量到 0.7 再试一次，仍超限 → 返回 null。

### 8.7 AI tab 复用与最小改动

- `ChatMessage` 增加可选 `markdown?: boolean`。
- `AuxChatPanel` 用户消息渲染：
  - `m.markdown === true` → 用 `Markdown` 组件渲染（白字继承）；否则原样纯文本（答疑现状不变）。
- 判题思考用现有 `ReasoningBlock`；流式时自动展开预览、结束时折叠。
- 判题报告里的尾部 ```json 由 `stripTrailingJson` 隐藏（现有逻辑）。
- `AuxInputBar` 不变；`showAnswerHint=false`。
- 页面 mount 时 `useChatStore.reset()`；卸载时再 reset，避免与答疑页串消息。

### 8.8 tab 行为

- `answer` 阶段：无 tab 条（只有作答页）。
- 第一次【答疑】/【提交】后：显示 `作答` / `AI 答疑` 两个 tab，默认 `AI 答疑`。
- tab 切换不卸载作答页（隐藏而非销毁），保留编辑器和草稿。
- AI tab 首次渲染时 `AuxChatPanel` 自动滚到底部。
- 刷新页面：回到状态 A（不做断点恢复；草稿白板内存态也丢）。

---

## 9. 错误处理与边界

| 场景 | 行为 |
|---|---|
| MinerU 没装/没 token/超时 | 502/5501；录入页显示「图片解析失败，请重试或手动输入题目」；保留图片/文字 |
| MinerU 输出缺页 | 同 5501 |
| 本地切题失败/超时/JSON 坏 | 自动回退千问；千问仍失败 → 5502 |
| 识别出 0 道题 | 200 + 空候选；提示换清晰图/裁剪/手动输入 |
| 识别出多题 | 选题页单选；不自动猜 |
| 配图 0 张 | 选题页不显示配图区；题干只有文字 |
| 配图多张 | 多选；默认 AI 建议；学生可全不选 |
| 纯文字题 | 跳过 MinerU；学科默认数学可改 |
| 学生只写草稿不写文字答案 | 允许提交（勾选附草稿且草稿非空） |
| 答案为空且无草稿 | 400/1001；前端 toast |
| HEIC | 前端 `ensureJpeg` 转 JPEG；失败提示改用 JPG/PNG |
| 图片 >5MB | 前端拒绝并提示；后端二次校验 |
| 超过 6 张 | 前端拒绝新增；后端二次校验 |
| 判题 JSON 解析失败 | 二次提取；仍失败 → SSE error 5502；报告保留 |
| 题库/错题本写失败 | SSE error 5000；报告保留；可重试 |
| 重复提交 | 前端提交中禁用；后端以 `questionId` 更新同一条 |
| 提交后改答案再提交 | 同题重判；题库更新；错题本按最新结果 |
| 追问 | 只答疑；不改分/不入库 |
| 刷新/关闭页面 | 无历史、无草稿恢复；回到录入 |
| 并发识别 | 前端一次一个；后端 MinerU 信号量排队；超出等待 → 503 |
| 原题照片隐私 | 不写进 questions.content；只存 MinerU 提取的配图 |
| 题图含学生姓名/手写 | 配图只取 MinerU 图片区域；原图不落题库；仍建议产品文案提示「请勿上传含个人信息的照片」 |
| 家长端 | 错题归 training 档可见；不做专门做题记录 |

---

## 10. 测试计划

### 10.1 后端（vitest）

- `mineru-runner.test.ts`
  - 命令行参数、`shell:false`、环境变量注入；
  - 超时 kill、非 0 退出、stderr 脱敏（不含 token）；
  - 输出 `page_*.md` 排序、缺页、`images/` 复制、路径重写；
  - 临时目录清理。
- `freeform-recognize.service.test.ts`
  - 纯文字短路；
  - 1 图/多图顺序；
  - 张数/格式/大小/归属校验；
  - 本地切题成功；本地失败回退千问；两者失败 5502；
  - JSON 非法回退；
  - 候选上限、0 候选；
  - MinerU 失败 5501。
- `freeform-split.capability.test.ts`
  - prompt 构建、schema 校验、`selectedHint`、`figureRefs`；
  - 长 Markdown 直接走千问。
- `freeform-judge.capability.test.ts`
  - 流式 reasoning/content 透传；
  - 尾部 JSON 提取、清理报告、replace 事件；
  - JSON 非法 → 二次提取；
  - 分数 clamp、verdict 重算、type/difficulty 回落。
- `freeform-judge.service.test.ts`
  - 落库顺序、question insert/update、hash 去重/前缀命中；
  - 不满分写错题本、满分清零、不发分、不写 practice_results、不调 mastery；
  - 无 KP 关联；
  - 再次提交更新同一条；
  - dialogue/messages 写入；scene 校验；
  - DB 失败 → error 事件。
- `freeform.controller.test.ts`
  - 鉴权、参数校验、SSE 头、断开中止。
- `content-hash.freeform.test.ts`
  - 去图片后同一题干 hash 相同；不同配图 URL 不影响。
- `model-router` / `model-config-registry`
  - `freeform_split` / `freeform_judge` 路由命中；DB 迁移幂等。

### 10.2 前端（vitest + RTL）

- `EntrySelectPage.test.tsx`：第 4 卡存在、点击跳 `/student/solve`、2×2/4 列 class。
- `SolvePage.test.tsx`：
  - 初始只有录入；文字/图片校验；
  - 识别成功 → 选题；失败 → 错误+手动输入；
  - 单选候选题、配图多选、编辑题干、学科/满分；
  - 开始作答 → 作答页；tab 未出现；
  - 点答疑 → 创建会话 + AI tab 出现并激活；
  - 点提交 → 判题流 + tab；再次提交；
  - 切回答作保留内容；追问不改分。
- `SolveSourceInput.test.tsx`：多图拖拽/粘贴/选择、HEIC mock、最多 6、删除/排序、上传状态。
- `SolveCandidatePicker.test.tsx`：候选单选、配图勾选默认值、编辑/恢复、学科/满分校验。
- `SolveAnswerView.test.tsx`：题干图片带 `dragToDraft`、按钮、提交条件、附草稿。
- `useFreeformJudge.test.ts`：SSE 事件序列、result/error、questionId。
- `draft-render.test.ts` / `DraftWhiteboard.test.tsx`：快照合成、白底、尺寸上限、无内容 null。
- `AuxChatPanel.test.tsx`：`markdown=true` 用户消息渲染；默认行为不变。

### 10.3 手工验收（真环境）

1. 入口第 4 卡 → 做题页。
2. 拖 2 张含 2 道题的照片 → 候选 2 道 → 选第 2 道 → 配图多选 → 作答页。
3. 题干配图拖进草稿 → 手写标注 → 写 LaTeX 答案 → 预览正确。
4. 提交 → 思考过程实时、报告分步得分、题目入库（source=freeform、无 KP）。
5. 不满分 → 错题本出现；满分重提 → 清零。
6. 答疑 → 苏格拉底引导；追问 → 上下文连续。
7. 纯文字题；HEIC；MinerU 断网/token 错；超 6 张；空答案。
8. iPad 横屏：拖图、粘贴、白板、tab 切换。
9. 验证题库 `questions.content` 不含原题整页照片；只含配图 URL。
10. 验证专项/同类型/考试抽题池不出现 freeform 题。

---

## 11. 文档、迁移与交付

### 11.1 必须同步的文档

- `docs/K12智学系统-产品需求文档.md`：新增 §7.15「做题入口（自由做题）」，写明本 spec 的口径；§7.10 继续适用于「答疑」，不要改它的 MinerU/错题本/组卷表述，但在 §7.15 明确本入口的差异。
- `docs/API接口与数据流设计文档.md`：新增 §4.30（端点）+ §5.33（数据流）。
- `docs/api/openapi.yaml`：同步两个端点、请求/响应/错误码；`CreateConversationDto.scene` 枚举加 `aux_freeform`。
- `apps/server/src/ai-core/model-routes.yaml`：新增两条路由。
- `.env.example`：`MINERU_BIN` / `MINERU_TOKEN` / `MINERU_TIMEOUT_MS` / `MINERU_CONCURRENCY`。
- `docs/constraints/做题入口.md`：新增主题约束（MinerU 主路径、原图不入库、无 KP、不发分、scene 隐藏、单命令交付）。
- `CLAUDE.md` 权威文档索引的 constraints 行补 `做题入口.md`（一行）。
- `docs/ai-core-changelog.md`：实现完成后补一条（日期、迁移、冒烟结论）。

### 11.2 数据库迁移

- `tools/db/migrations/2026-11-08_freeform_routes.sql`（幂等）：
  ```sql
  INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
  VALUES
    ('freeform_split', '*', 'local', 'qwen3.8-max'),
    ('freeform_judge', '*', 'qwen3.8-max', NULL)
  ON DUPLICATE KEY UPDATE
    primary_model_key = VALUES(primary_model_key),
    fallback_model_key = VALUES(fallback_model_key);
  ```
- 同步 `tools/db/schema.sql`？`llm_routes` 是数据不是结构，不需要改 schema；但 `schema_reconcile.py` 对账表结构不受影响。
- 含 DDL 的批次不需要跑 reconcile（本迁移纯 DML）；仍建议在交付脚本里跑一次 `schema_reconcile.py` 作为健康检查。

### 11.3 交付命令（只给一条）

新增 `tools/freeform/setup.sh`，内部串起：

1. 检查 `mineru-open-api` 是否存在（否则打印安装命令并退出非 0）；
2. 检查 `MINERU_TOKEN` 是否配置（否则打印获取地址并退出非 0）；
3. 应用路由迁移（`mysql < tools/db/migrations/2026-11-08_freeform_routes.sql`，幂等）；
4. 跑 `python3 tools/db/schema_reconcile.py` 健康检查；
5. 打印「重启后端：node dist/main.js」（不自动杀进程）。

用户只需要执行：

```bash
bash tools/freeform/setup.sh
```

### 11.4 上线前置

- 部署机安装 MinerU CLI 并配置 `MINERU_TOKEN`。
- 管理端模型配置确认 `freeform_split` / `freeform_judge` 两条路由存在且模型可用（本地 llama.cpp / 千问）。
- 对象存储/上传目录 `UPLOAD_DIR` 可写；`/uploads` 静态路由已存在。
- 生产环境若不允许外发学生照片，需改为 MinerU 私有部署（本期不做，作为风险记录）。

---

## 12. 验收标准

1. `/student/entry` 第 4 卡「做题」可进入 `/student/solve`；三卡布局不破。
2. 录入页支持文字 + 最多 6 张图片（HEIC/JPG/PNG），拖拽/粘贴/选择三种方式均可。
3. 图片经 MinerU → 本地 LLM 切题，返回候选题；多题可单选，配图可多选；本地失败回退千问；MinerU 失败可手动输入。
4. 作答页与考试第 9 题骨架一致：题干在上、左编辑右预览、右草稿、底部居中【答疑】【提交】。
5. 题干配图可拖进草稿白板；草稿可手写/图形/撤销重做。
6. 【答疑】以流式思考 + 苏格拉底引导回答；【提交】以流式思考 + 分步得分报告回答；两者共用同一会话上下文。
7. 提交后 AI tab 出现并自动激活；可切回作答改答案再提交；重判同一题，不新建题。
8. 判题成功后题目入库：`source='freeform'`、无 KP、`answer_verified=0`；`questions.content` 不含原题整页照片，只含勾选配图。
9. 不满分 → 错题本新增/复用未清行；满分 → 清零；全程不发积分、不写练习记录、不更新掌握度。
10. 追问只答疑，不改分、不重复入库。
11. 专项/同类型/变式/考试/错题练习抽题池均不出现 freeform 题；freeform 错题只在错题本列表回看。
12. 刷新/关闭页面回到录入，不做历史恢复。
13. 单条命令 `bash tools/freeform/setup.sh` 完成环境检查 + 路由迁移 + 对账；后端重启后可用。

---

## 13. 待办/风险

- **MinerU 依赖**：服务端首次引入 Python CLI + 云 token；部署/PC App 需确认。若生产不方便，后续可改为私有部署或把识别挪到独立服务。
- **MinerU 输出命名**：不同 CLI 版本可能不同；实现第一步必须先冒烟确认。
- **配图关联准确率**：本地 LLM 可能把配图挂错题；本期用学生多选兜底，不保证自动关联全对。
- **判题 JSON 稳定性**：千问尾部 JSON 可能被截断/加围栏；已有二次提取兜底，仍需真模型多轮验证。
- **长等待**：MinerU（数十秒）+ 切题（数十秒）+ 判题（数十秒）；前端阶段提示 + 可重试是必须的，不做后台任务。
- **家长端可见性**：错题归 training 档，家长能看到这道错题；若产品要求做题记录对家长不可见，需要额外过滤（本期未做）。
- **原图隐私**：虽然原图不入题库，但上传文件仍在 `uploaded_files`/磁盘；需要按现有上传清理策略处理，不在本期新增。
