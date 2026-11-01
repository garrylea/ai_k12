# 作答区粘贴图片（物理/化学）— 设计文档

日期：2026-11-01
状态：设计已确认（用户拍板：只接上粘贴；归属靠 alt 标注；不动表结构）

## 1. 背景与问题

物理、化学题常需要画连线图、表格。当前作答区的实际状况：

- 作答编辑器 `LatexEditor` 是纯 `<textarea>`（`apps/web/src/components/business/LatexEditor.tsx:59`），浏览器不会把图片剪贴板写进 textarea，**粘贴图片时界面毫无反应**（静默失败，不报错）。
- 草稿白板能贴图（`DraftWhiteboard` 自己挂了 `document` 级 `paste` 监听），但草稿不导出、提交即清空（`2026-09-08-draft-paste-image-design.md` 明确"不做草稿导出为图片"）。学生"草稿画 → 截图 → 粘贴"的路径在最后一步断掉。
- 一题多小问、每个小问多个空。题干可能是**一篇连续文字、不换行、不编号**，也可能用 `①②③`、`(1)(2)`、`12V;2A` 之类的任意写法。**系统无法从题库可靠推断"有几个空"**（物理 135 题、化学 75 题，无空位标注；拆题规格也明确小问不切）。
- 因此不能采用"按空预生成 N 个输入框"的方案。图片必须由一个**学生输入时天然产生的位置信号**来承载归属。

## 2. 目标与非目标

### 目标

1. 在作答编辑器中 `Cmd/Ctrl+V` 或拖拽图片即可上传并插入，不再截图后无处可放。
2. 图片与文字的**顺序不需要约定**——图插入在哪里，就排在文字流的哪里。
3. 图片的**归属（第几问）由 alt 文字声明**，默认按出现顺序编号，学生想精确就改 alt。
4. 右侧预览区能看清大图；交卷后结果页、错题回顾也能看到。
5. 不改任何表结构。

### 非目标（本期不做）

- 不做「画图」按钮、不做草稿导出为图片。
- 不做视觉判题：模型**不读图**，图只以文本标记形式存在（见 §10 后续）。
- 不做旋转、裁剪、多图去重。
- 不动讨论窗 `DiscussChat`（仍是纯文本 + 无附件）。
- 不改 `/api/files/upload` 端点与 `uploaded_files` 表结构。

## 3. 方案选型

**选定：Markdown 图片语法 `![alt](url)` 写进答案文本本身。**

理由：

- 预览区与结果页本来就用 ReactMarkdown 渲染（`LatexPreview.tsx:146`、`AnswerResultList.tsx:221`），`![]()` 天然支持，`resolveAsset` 对 `data:` 与 `http(s):` 原样透传（`markdown.tsx:49`）。
- 答案在库里就是 `TEXT`（`answers.answer_text`、`exam_answers.answer_text`、`practice_results.student_answer`），URL 随文本落库，**零 schema 改动**，历史回看天然可用。
- alt 是现成的"自由文本字段"，用来承载"第几问"，不需要另造标注体系。

**未选：**

| 方案 | 否掉的原因 |
|---|---|
| base64 内联进答案 | 一串几 MB 的 base64 会刷满编辑区、光标乱跳，进 prompt 也是噪音 |
| 新增附件列 / 附件表 | `answers.attachments` 有列但全仓无读写；`exam_answers`、`practice_results` 根本没有该列；作答入口有 7 个，改造面远大于收益 |
| 结构化"作答项"数组 | 需要改造提交契约与全部入口，且与"题目里到底几个空"这个已知不可靠的信息耦合 |

## 4. 交互时序

### 4.1 粘贴

1. `LatexEditor` 的 textarea 挂 `onPaste`。
2. 检查 `e.clipboardData.items` 里是否有 `image/*`：
   - **没有** → 直接放行，走浏览器原生文本粘贴（不 `preventDefault`）。
   - **有** → `e.preventDefault()`，逐张取出 `File`。
3. 单张校验：
   - 压缩前 `size > 5MB` → 不传，toast「图片过大（最大 5MB）」，本次粘贴结束（其余张继续按序处理）。
   - HEIC/HEIF → 走 `ensureJpeg`（`apps/web/src/utils/image-convert.ts:8`，动态 import，不加重首屏）。
4. 压缩（新增共享工具 `apps/web/src/utils/image-compress.ts`）：
   - 最长边 > 1600px → 等比缩到 1600，输出 `image/jpeg`，quality 0.85。
   - 最长边 ≤ 1600 且 `size ≤ 1MB` → 原样返回，不重编码。
   - 逻辑移植自 `draft-image-utils.ts:20-43`（那边返回 data URL，这里返回 `File`/`Blob` 供上传）。
5. 先在光标处插入占位文本，再异步上传：
   ```
   ![图1 上传中…]()
   ```
   编号 `N` = 当前答案文本中 `![` 的出现次数 + 1。
   占位在预览区不会显示成破图（`MarkdownImg` 的 `onError` 会隐藏，见 `markdown.tsx:299`），不会有"加载失败"图标闪烁。
6. 上传：`uploadFile(file)`（`apps/web/src/services/api.ts:399`，`POST /api/files/upload`，JWT，multipart）。
   - 成功 → 用 `json.data.url` 替换占位：
     ```
     ![图1](/uploads/auxiliary/9f3c….jpg)
     ```
     并把光标移到该行末尾、补一个换行，方便接着写 `2.`。
   - 失败（接口非 0 / 网络错误 / 15s 超时）→ 占位替换为：
     ```
     ［图1 上传失败］
     ```
     toast 提示，**不阻断继续作答**（不弹模态、不清空已写内容）。
7. 一次粘贴多张：串行处理，编号顺延（图1、图2…），每张都独立占一行。

### 4.2 拖拽

`onDrop` 走与粘帖完全相同的 `handleImageFile` 路径（取 `dataTransfer.files`，过滤非图片）。`onDragOver` 仅 `preventDefault` 以允许 drop。

### 4.3 删除

删掉那一行 Markdown 即删图（预览同步消失）。不上传后清理服务器文件——本期不做（见 §10）。

## 5. alt 约定（归属标注）

- 默认 alt = `图N`（纯顺序）。
- 学生可把 alt 改成任意文字，约定写法：
  - `第2问`
  - `第2问 图1`
  - `图1 第2问`
- **对齐口径**（只给消费方用，前端不校验）：

  | alt 内容 | 归属判定 |
  |---|---|
  | 命中 `/第\s*([0-9一二三四五六七八九十]+)\s*问/` | 归该问 |
  | 未命中 | 按图片在文本中的出现顺序，与第 n 个作答分段对齐 |

- 不强制、不提示、不报错。alt 就是普通文字，学生不写也能用。

## 6. 预览渲染

`LatexPreview` 新增可选 prop `imgClassName?: string`：传入时以
`components={{ ...markdownComponents, img: (p) => <MarkdownImg {...p} className={imgClassName} /> }}`
覆盖，不传则完全沿用现状（题干预览不受影响）。仅在作答预览与结果页传入。

- 作答/结果页图片样式（新增常量，供两处共用）：
  `block max-w-full max-h-[40vh] my-2 rounded-lg object-contain cursor-zoom-in`
- 不得沿用 `markdownComponents` 的默认 `h-[50px]`（`markdown.tsx:256`，那是题干小图规格）——否则电路图被压成细条。
- 图片是块级元素，独占一段，前后文字自动分段。这正是"第 2 问单独一块图"的直觉；不做行内嵌图。
- `zoomable` 保留（`MarkdownImg` 已支持点开浮层 + Esc 关闭）。

### 6.1 滚动同步

插入/删除图片会使预览高度突变，现有 `scrollSync` 按比例映射（`preview-scroll-sync.ts`）会把右侧甩到别处。插入或删除占位后必须重放一次 `scrollSync.current.apply?.()`（与 `LatexPreview.tsx:130` 内容变化重放同路）。

### 6.2 autoWrapMath 加固

`LatexPreview.autoWrapMath` 的 `PROTECTED_RE`（`LatexPreview.tsx:30`）需把 Markdown 图片/链接纳入保护，避免长 URL 里的 `_`、`/`、`=` 触发 `LATEX_TRIGGER` 被包进 `$…$`：

- 新增保护分支：`!\[[^\]]*\]\([^)]*\)`（图片）与 `\[[^\]]*\]\([^)]*\)`（链接）。
- 保护顺序排在双 `$` 之后、行内代码之前/后均可，但必须整体匹配、原样保留。

## 7. 结果页与回顾

- `AnswerResultList` 的学生答案已经是 ReactMarkdown（`AnswerResultList.tsx:221`），只需把 `img` 覆盖成 §6 的作答图样式。
- 其他回显学生作答的位置（错题本、家长端、课堂练习结果）统一 grep `student_answer` / `studentAnswer` / `answer_text` 的渲染点，同一套样式；**没有 Markdown 渲染的纯文本回显点，本期不改**（图会显示成 `![图1](url)` 字面文本，不阻断阅读，列入 §10）。

## 8. 边界与已知风险

| 情况 | 本期处理 |
|---|---|
| 上传失败 / 断网 / 超时（15s AbortController） | 文本留 `［图N 上传失败］`，toast，可继续作答 |
| 超过 5MB（压缩前） | 不传，toast |
| 服务端 20MB 上限 | 前端已先压到 5MB 以内，正常不会触发 |
| HEIC | `ensureJpeg` 转 JPEG |
| 同一张图重复粘贴 | 各自上传一份（不去重） |
| 单条作答图片数量 | 软限制：> 6 张时 toast 提示"图片较多，建议精简"，仍允许（避免预览与后续读图过载） |
| 图片访问权限 | `/uploads/*` 为静态公开目录（`main.ts:61-66`），URL 含 UUID 不可猜；本期接受 |
| 存储清理 | 不清理、无配额；孤儿文件（学生删了图但文件仍在）本期接受 |
| 上传归因 | 复用现有端点，`uploaded_files.source` 仍写死 `'auxiliary'`（`files.controller.ts:23`）；本期不改，后续统一 |

## 9. 涉及文件

| 文件 | 变更 |
|---|---|
| `apps/web/src/components/business/LatexEditor.tsx` | `onPaste` / `onDrop` / 拖拽高亮；占位插入与替换；光标位置维持（复用 `insertAtCursor` 的 range 语义） |
| `apps/web/src/utils/image-compress.ts` | **新增**：`compressImageFile(file): Promise<File>`（最长边 1600、JPEG 0.85、小于则原样） |
| `apps/web/src/components/business/LatexPreview.tsx` | 新增图片样式覆盖入口；`PROTECTED_RE` 加 Markdown 图片/链接 |
| `apps/web/src/components/business/PreviewDraftPanel.tsx` | 透传图片样式入口 |
| `apps/web/src/components/business/answer/QuestionRunner.tsx` | 作答预览传入作答图样式（:591 一带） |
| `apps/web/src/components/business/AnswerResultList.tsx` | 学生答案的 `img` 用作答图样式（:221） |
| `apps/web/src/components/markdown.tsx` | 导出作答图样式常量（与 `MarkdownImg` 默认样式并列，避免两处漂移） |

不改动：后端、schema、`/api/files/upload`、`uploaded_files`、判题链路。

## 10. 后续（明确不在本期）

1. 让模型真的看图：把答案里的 Markdown 图片按出现顺序解析成 attachments（URL → `uploaded_files` 反查 fileId），走视觉输入。需要讨论/讲评端点接受 attachments，另立一期。
2. 「画图并插入」按钮 + 草稿导出（省掉截图一步）。
3. 图片生命周期：删除孤儿文件、配额、压缩档位统一。
4. 纯文本回显点（无 Markdown 渲染的家长端/管理端列表）的图片展示。
5. 讨论窗 `DiscussChat` 附件支持。

## 11. 测试清单

### 11.1 组件测试（vitest + React Testing Library）

**`LatexEditor.test.tsx`**

1. 粘贴图片 → `onChange` 收到含 `![` 与 URL 的文本，且**插在光标处**（在已有文本中间粘贴，断言前后文保留、标记位置正确）。
2. 上传中先出现 `上传中` 占位，`uploadFile` resolve 后替换为真 URL，占位不残留。
3. `uploadFile` reject → 文本中为 `［图1 上传失败］`，有 toast，`onChange` 不抛、不重复插入。
4. 剪贴板只有文本 → 不拦截默认行为，`onChange` 收到原文，无任何上传调用。
5. 连续粘贴两张 → 出现 `图1`、`图2`，编号顺延，各占一行。
6. 压缩前 > 5MB → 不调用 `uploadFile`，有提示 toast，文本不变。
7. `onDrop` 拖入图片文件 → 结果与粘贴一致；拖入非图片 → 不处理。
8. HEIC 文件 → 先走 `ensureJpeg`（mock 断言调用），上传的 `File` 为 JPEG。

**`LatexPreview.test.tsx`**

9. `![图1](/uploads/a/b.png)` 渲染出 `<img>`，`src` 不被 `resolveAsset` 改写。
10. `![第2问](data:image/png;base64,…)` 也能渲染（`data:` 透传）。
11. 作答预览的图带 `max-h-[40vh]` 一类样式，**不带** `h-[50px]`。
12. `autoWrapMath('![图1](http://x.com/a_b=1.png)')` 输出与输入完全一致（URL 未被 `$…$` 包裹）。
13. 回归：`$x=1$` 与 `![图1](http://x/a.png)` 混排时，两者各自保持原样，互不吞并。
14. 插入图片后 `scrollSync.current.apply` 被调用（防跳位，见 §6.1）。

**`AnswerResultList.test.tsx`**

15. 学生答案含 `![图1](url)` → 渲染 `<img>` 且使用作答图样式（非 50px 细条）。

### 11.2 手工验证（真机）

1. iPad Safari：从相册长按复制图片 → 作答框粘贴 → 上传完成 → 插入 → 右侧预览显示大图。
2. 3000px 大图：上传前压缩生效（网络面板看请求体明显小于原图），预览清晰可辨。
3. 图文混排：`1. 12V` / 图 / `2. 2A` 三块顺序正确，图独占一段、不与文字挤在一行。
4. 删除图片那一行 → 预览同步消失，左右滚动不跳位。
5. 交卷 → 结果页学生答案处显示图片，可点开放大。
6. 断网粘贴 → 出现失败标记 + 提示；恢复网络重新粘贴可正常插入。
7. 弱网：上传占位期间继续打字，不卡输入；成功后位置不串。
8. 暗色主题下图片圆角与边框正常，无白底突兀。
9. 一次粘贴 7 张 → 出现"图片较多"提示，仍可全部插入。
10. 长度极长的 URL（UUID 文件名）不会让编辑区横向溢出，预览不报 KaTeX 错。

## 12. 决策记录

| 日期 | 决策 | 决策人 |
|---|---|---|
| 2026-11-01 | 不按"空/小问"预生成输入框——题库无空位标注、题干可能不分行，系统不猜 | 用户 |
| 2026-11-01 | 顺序由图片在文本流中的位置决定；归属由 alt 声明，默认按出现顺序 | 用户 |
| 2026-11-01 | 入口只做"粘贴/拖拽"，不做画图按钮、不做草稿导出 | 用户 |
| 2026-11-01 | 不改表结构，图片以 URL 形式随答案文本落库 | 用户 |
