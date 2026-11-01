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

- 预览区与结果页本来就用 ReactMarkdown 渲染（`LatexPreview.tsx:146`、`AnswerResultList.tsx:221`），`![]()` 天然支持。**但 `resolveAsset` 必须放行 `/uploads/` 前缀**（现实现只放行 `http(s):` 与 `data:`，会把 `/uploads/a.png` 拼成 `/assets/uploads/a.png` → 404；服务端 `/assets/` 与 `/uploads/` 是两个静态根）。`markdown.tsx:49` 改为三个前缀都原样透传。
- 内联 base64 图（`data:`）**本期不支持**：react-markdown 10 的默认 `urlTransform` 只放行 `https?/ircs?/mailto/xmpp`，`data:` 会被清成空串。学生图走 `/uploads/`，不受影响。
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
3. 单张校验（逐张判断，超限的那张跳过，其余照常处理）：
   - 压缩前 `size > 5MB` → 该张不传，toast「图片过大（最大 5MB）」。
   - HEIC/HEIF → 走 `ensureJpeg`（`apps/web/src/utils/image-convert.ts:8`，动态 import，不加重首屏）。
4. 压缩（新增共享工具 `apps/web/src/utils/image-compress.ts`）：
   - 最长边 > 1600px → 等比缩到 1600，输出 `image/jpeg`，quality 0.85。
   - 最长边 ≤ 1600 且 `size ≤ 1MB` → 原样返回，不重编码。
   - 画布先铺白底再画图（PNG 透明区转 JPEG 会变黑）。
   - 逻辑移植自 `draft-image-utils.ts:20-43`（那边返回 data URL，这里返回 `File`/`Blob` 供上传）。
5. **一次性**把本批所有占位按顺序插入光标处（调用一次 `onChange`，避免逐张插入导致受控组件光标漂移）。占位是**纯文本**，不是 Markdown：
   ```
   ［图1 上传中…］
   ［图2 上传中…］
   ```
   编号 `N` = 当前答案里所有 `图<数字>` 标记（含成功插入的 `![图N](…)` 与失败标记）的最大编号 + 1。
   用纯文本占位而不是 `![](…)`：不产生任何 `<img>`，预览区不会闪破图。
6. 逐张异步上传：`uploadFile(file)`（`apps/web/src/services/api.ts:399`，`POST /api/files/upload`，JWT，multipart）。
   - 成功 → 把这**一个**占位串（精确匹配 `［图N 上传中…］`）替换为：
     ```
     ![图N](/uploads/auxiliary/9f3c….jpg)
     ```
     替换是纯字符串替换，不改光标（学生此时可能已在别处继续打字）。
   - 失败（接口非 0 / 网络错误 / 15s 超时）→ 同一占位替换为 `［图N 上传失败］`，toast，**不阻断继续作答**。
   - 学生在等待期间把占位删掉了 → 精确匹配落空，**丢弃该结果**（不追加、不复活），服务器上的孤儿文件本期不清理。
7. 一次粘贴多张：占位一次性插入，上传串行（避免同时打满并发），结果各自替换自己的占位串。
8. **上传中/失败标记都禁止提交**：只要答案里还有 `上传中…` 或 `上传失败］` 标记，提交按钮 disabled，tooltip 分别为「图片上传中」与「有图片上传失败，请删除标记后重新粘贴」。前者防占位文本落库；后者防失败标记被当成答案交上去（AI 判题会读到、错题本长期存脏文本）。
9. **上传结果按「发起时的题号」写回**：`QuestionRunner` 用 `updateAnswerFor(n, next)` 写缓存，`setAnswer` 仅在 `n === 当前题` 时执行；`LatexEditor` 加 `key={q.n}` 按题重建，保证切题后迟到的上传结果写回**原题**而不是被丢弃或落到当前题。

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

内容变化本身已经会重放：`LatexPreview` 在 `debounced` 变化后调用 `scrollSync.current.apply?.()`（`LatexPreview.tsx:130-132`），所以插入/替换文本**不需要**额外处理。

真正会跳位的是另一件事：**图片解码完成、高度变大**发生在防抖重放之后，此时没有任何 effect 再触发。因此作答预览里的 `<img>` 在 `onLoad` 时补一次 `scrollSync.current.apply?.()`（`MarkdownImg` 需要加一个可选的 `onLoad` 透传，或由 `LatexPreview` 用容器事件委托监听）。

占位是纯文本（§4.1 第 5 步），加载期不会产生高度突变。

### 6.2 autoWrapMath：现状已安全，只补回归测试

`autoWrapMath` 不会把图片 URL 包进 `$…$`：URL 被 CJK 边界切成 `![` 与 `](…)` 两段，两段都命中 `MD_INLINE`（`LatexPreview.tsx:21` 的 `!\[` 与 `\]\(`）直接跳过，已实测（2026-11-01 用同样正则跑过 `![图1](/uploads/auxiliary/9f3c-a_b=1.jpg)`，三段均 `shouldWrap=false`）。

**不新增保护分支**（`PROTECTED_RE` 改复杂了反而容易误伤）。只在 `LatexPreview.test.tsx` 补两条回归：图片单独一行、图片与 `$x=1$` 混排，均原样输出。

## 7. 结果页与回顾

- `AnswerResultList` 的学生答案已经是 ReactMarkdown（`AnswerResultList.tsx:221`），只需把 `img` 覆盖成 §6 的作答图样式。
- 其他回显学生作答的位置（错题本、家长端、课堂练习结果）统一 grep `student_answer` / `studentAnswer` / `answer_text` 的渲染点，同一套样式；**没有 Markdown 渲染的纯文本回显点，本期不改**（图会显示成 `![图1](url)` 字面文本，不阻断阅读，列入 §10）。

## 8. 边界与已知风险

| 情况 | 本期处理 |
|---|---|
| 上传失败 / 断网 / 超时（15s AbortController） | 文本留 `［图N 上传失败］`，toast，可继续作答 |
| 上传中 / 失败标记残留 | 两种标记都禁用提交（见 §4.1 第 8 步），避免占位或失败文本落库 |
| 上传途中学生删掉占位 | 精确匹配落空即丢弃结果，不追加；服务器文件成孤儿（本期不清理） |
| 超过 5MB（压缩前） | 该张不传，toast；同批其余张照常 |
| 服务端 20MB 上限 | 前端已先压到 5MB 以内，正常不会触发 |
| HEIC | `ensureJpeg` 转 JPEG |
| 透明 PNG | 转 JPEG 前铺白底，避免透明区变黑 |
| 同一张图重复粘贴 | 各自上传一份（不去重） |
| 单条作答图片数量 | 软限制：> 6 张时 toast 提示"图片较多，建议精简"，仍允许（避免预览与后续读图过载） |
| 图片访问权限 | `/uploads/*` 为静态公开目录（`main.ts:61-66`），URL 含 UUID 不可猜；本期接受 |
| 存储清理 | 不清理、无配额；孤儿文件（学生删了图但文件仍在）本期接受 |
| 上传归因 | 复用现有端点，`uploaded_files.source` 仍写死 `'auxiliary'`（`files.controller.ts:23`）；本期不改，后续统一 |
| **iPad 粘贴可达性（未验证）** | iOS Safari 对 `<textarea>` 的图片粘贴行为不稳定，可能 `paste` 事件里拿不到图片。**实施第一步必须先真机验证**；若不可达，需补一个最小入口（一个"插入图片"按钮走 `<input type="file" accept="image/*">`），否则整条链路在 iPad 上不可用 |

## 9. 涉及文件

| 文件 | 变更 |
|---|---|
| `apps/web/src/components/business/LatexEditor.tsx` | `onPaste` / `onDrop` / 拖拽高亮；占位一次性插入与逐张替换；上传中标记暴露给上层（禁提交） |
| `apps/web/src/utils/image-compress.ts` | **新增**：`compressImageFile(file): Promise<File>`（最长边 1600、JPEG 0.85、白底、小于则原样） |
| `apps/web/src/components/business/LatexPreview.tsx` | 新增 `imgClassName?: string` 覆盖；图片 `onLoad` 后重放 `scrollSync` |
| `apps/web/src/components/markdown.tsx` | 导出作答图样式常量；`MarkdownImg` 增加可选 `onLoad` 透传；**`resolveAsset` 放行 `/uploads/` 前缀**（否则 `/uploads/…` 被拼成 `/assets/uploads/…` → 404） |
| `apps/web/src/components/business/PreviewDraftPanel.tsx` | **两个分支都要**透传 `imgClassName`：`!enabled` 时直接返回 `LatexPreview`（物理/化学正好走这条，`:20-22`），`enabled` 时走 tab 分支（`:44-46`） |
| `apps/web/src/components/business/answer/QuestionRunner.tsx` | 给 `PreviewDraftPanel` 传作答图样式（`:601` 一带）；提交按钮加"上传中"禁用条件（`:650-653`） |
| `apps/web/src/components/business/AnswerResultList.tsx` | 学生答案的 `img` 用作答图样式（`:221`） |

不改动：后端、schema、`/api/files/upload`、`uploaded_files`、判题链路。

## 10. 后续（明确不在本期）

1. 让模型真的看图：把答案里的 Markdown 图片按出现顺序解析成 attachments（URL → `uploaded_files` 反查 fileId），走视觉输入。需要讨论/讲评端点接受 attachments，另立一期。
2. 判题/讲评入参预处理：服务端在把学生答案送模型前，把 `![…](…)` 换成 `[图N]`，避免模型读到一长串 URL。本期不改判题链路（物理计算题本就自评早退，影响面小）。
3. 「画图并插入」按钮 + 草稿导出（省掉截图一步）。
4. 图片生命周期：删除孤儿文件、配额、压缩档位统一。
5. 纯文本回显点（无 Markdown 渲染的家长端/管理端列表）的图片展示。
6. 讨论窗 `DiscussChat` 附件支持。

## 11. 测试清单

### 11.1 组件测试（vitest + React Testing Library）

**`LatexEditor.test.tsx`**

1. 粘贴图片 → `onChange` 收到含 `![` 与 URL 的文本，且**插在光标处**（在已有文本中间粘贴，断言前后文保留、标记位置正确）。
2. 上传中先出现纯文本占位 `［图1 上传中…］`（不含 `<img>`、不含 `![](`），`uploadFile` resolve 后替换为真 URL，占位不残留。
3. `uploadFile` reject → 文本中为 `［图1 上传失败］`，有 toast，`onChange` 不抛、不重复插入。
4. 剪贴板只有文本 → 不拦截默认行为，`onChange` 收到原文，无任何上传调用。
5. 一次粘贴两张 → **单次 `onChange`**（断言调用次数）、两个占位、编号 `图1`/`图2`；两个都 resolve 后各自替换，顺序不串。
6. 上传途中学生把占位删掉 → resolve 后文本不变（no-op），不追加、不复活。
7. 上传失败后再粘贴一张 → 编号取 `图2`（跳过已占用编号），不与失败标记撞号。
8. 压缩前 > 5MB → 不调用 `uploadFile`，有提示 toast，文本不变；同批另一张仍正常上传。
9. `onDrop` 拖入图片文件 → 结果与粘贴一致；拖入非图片 → 不处理。
10. HEIC 文件 → 先走 `ensureJpeg`（mock 断言调用），上传的 `File` 为 JPEG。
11. 存在 `上传中…` 标记时，上层拿到的 `isUploading` 为 true（提交按钮据此禁用，见 §4.1 第 8 步）。

**`image-compress.ts`**（jsdom 无 canvas / 无图片解码，DOM 路径只能手工验；只把纯计算抽出来单测）

12. `scaleSize(2000, 1000)` → `{ w: 1600, h: 800 }`；`scaleSize(800, 600)` 原样；`scaleSize(1000, 2500)` → `{ w: 640, h: 1600 }`。
13. 边界：`scaleSize(1600, 1200)` 不缩放；取整后任一边都不超过 1600。

**`LatexPreview.test.tsx`**

14. `![图1](/uploads/a/b.png)` 渲染出 `<img>`，且 `src` **原样是 `/uploads/a/b.png`**（`resolveAsset` 不得补 `/assets/` 前缀）。
15. 已知限制守门：`![图1](data:image/png;base64,…)` 渲染出的 `src` 为空串（react-markdown 默认 `urlTransform` 拦 `data:`）——断言这条是为了让「以后要支持 base64」时必须显式改配置，而不是悄悄回归。
16. 作答预览的图带 `max-h-[40vh]` 一类样式，**不带** `h-[50px]`；不传 `imgClassName` 时仍是原默认样式（题干预览不受影响）。
17. `autoWrapMath('![图1](http://x.com/a_b=1.png)')` 输出与输入完全一致（回归，见 §6.2）。
18. 回归：`$x=1$` 与 `![图1](http://x/a.png)` 混排时，两者各自保持原样，互不吞并。
19. 图片触发 `load` 事件后 `scrollSync.current.apply` 被调用（§6.1）。

**`AnswerResultList.test.tsx`**

20. 学生答案含 `![图1](url)` → 渲染 `<img>` 且使用作答图样式（非 50px 细条）。

### 11.2 手工验证（真机）

1. **iPad Safari：从相册长按复制图片 → 作答框粘贴** —— 这是全案的前提，验不过要走 §8 的最小入口兜底（实施第一步就验）。
2. 桌面 Chrome/Edge 截图后直接 `Ctrl+V` → 上传完成 → 插入 → 右侧预览显示大图。
3. 3000px 大图：上传前压缩生效（网络面板看请求体明显小于原图），预览清晰可辨。
4. 图文混排：`1. 12V` / 图 / `2. 2A` 三块顺序正确，图独占一段、不与文字挤在一行。
5. 删除图片那一行 → 预览同步消失，左右滚动不跳位。
6. 图片加载完成后预览不跳位（弱网慢加载最容易暴露）。
7. 上传中提交按钮禁用；上传完成自动恢复可用。
8. 交卷 → 结果页学生答案处显示图片，可点开放大。
9. 断网粘贴 → 出现失败标记 + 提示；恢复网络重新粘贴可正常插入。
10. 弱网：上传期间继续打字，不卡输入；成功后位置不串。
11. 暗色主题下图片圆角正常，无白底突兀。
12. 一次粘贴 7 张 → 出现"图片较多"提示，仍可全部插入。
13. 超长 URL（UUID 文件名）不会让编辑区横向溢出，预览不报 KaTeX 错。

## 12. 决策记录

| 日期 | 决策 | 决策人 |
|---|---|---|
| 2026-11-01 | 适用范围默认指"作答提交区（LaTeX 编辑器）"，不含讨论窗 `DiscussChat`；若用户所指为讨论窗需另立一期 | 假设待确认 |
| 2026-11-01 | 不按"空/小问"预生成输入框——题库无空位标注、题干可能不分行，系统不猜 | 用户 |
| 2026-11-01 | 顺序由图片在文本流中的位置决定；归属由 alt 声明，默认按出现顺序 | 用户 |
| 2026-11-01 | 入口只做"粘贴/拖拽"，不做画图按钮、不做草稿导出 | 用户 |
| 2026-11-01 | 不改表结构，图片以 URL 形式随答案文本落库 | 用户 |
| 2026-11-01 | 评审修正：占位改纯文本；编号取"已有最大 + 1"；多图一次性插入；上传中禁提交；滚动重放改到图片 `onLoad`；`autoWrapMath` 无需加固（实测已安全，仅补回归测试） | 评审 |
