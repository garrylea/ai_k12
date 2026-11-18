# 专项练习导出 PDF — 设计

> **日期**：2026-11-18
> **状态**：需求与 5 个口径已与用户确认（§3），本文待用户审阅后转 writing-plans。
> **范围锚点**：学生端训练轨四个答题页（专项 / 错题 / 变式 / 补偿相似题）导出当前题单为 PDF。
> **上游**：2026-11-18 brainstorming 会话；本文是导出内容、版式、入口与保存方式的唯一真源。

---

## 1. 背景与现状（2026-11-18 实测，勿凭记忆）

| 事实 | 实测值 / 位置 |
|---|---|
| 专项答题页 | `apps/web/src/pages/student/training/TargetedRunPage.tsx`，承载数学知识点/中考模型/试卷题号、物理/化学/道法/语文知识点专项、薄弱点、同类型、单题重做 |
| 另外三个答题页 | `ErrorPracticeRunPage.tsx`（错题）、`VariationRunPage.tsx`（变式）、`RemediationRunPage.tsx`（补偿相似题） |
| 题单形状 | 四个页面最终都产出 `RunnerQuestion[]`（`apps/web/src/components/business/answer/types.ts:5-19`）：`{ n, text, type?, options?: {label,text}[], material?, source?, questionNo? }` |
| 题干/材料渲染 | 唯一真源 `apps/web/src/components/markdown.tsx`（ReactMarkdown + remark-math + rehype-katex + rehype-raw）；公式是文本内 LaTeX，图片是 Markdown `![]()`，由 `resolveAsset` 补 `/assets/` 前缀 |
| 答案 / 解析 | 开练接口 `POST /api/training/targeted/start` 白名单序列化，**不含** answer/explanation（防泄露） |
| 现有打印/PDF | 全仓 0 处：无 `window.print`、无 `@media print`、无 `@page`、无 pdf/jspdf/html2canvas 依赖 |
| Electron | 渲染层加载远端 Web 页面（`apps/desktop/server-url.js`）；`preload.js:15-16` 明令不加 `require`/`fs`/`invoke`；主进程无 `dialog` / `will-download` |

**结论**：数据已在前端内存里，渲染链路统一，打印引擎由浏览器/Chromium 提供 → 本功能**不改后端、不新增依赖**。

---

## 2. 范围

### 2.1 本期做

- 新增可复用的 A4 打印纸面组件与全屏预览层
- 四个答题页右上角动作区加「导出」入口（与草稿图标同组）
- 结果弹窗 `AnswerResultList` 底部加「导出 PDF」按钮（做完后仍可导）
- 新增打印样式：A4 纵向、强制白底黑字、题目尽量不被分页截断
- 保存位置由系统打印面板的「另存为 PDF」完成（Web / PC App 一致）

### 2.2 本期不做（明确）

- 语文默写 / 古诗解释 / 古诗含义 / 英语背单词（各自独立数据模型与页面）
- 导出「以前做过的专项」：练习记录详情接口缺 `options`，专项 `materialText` 恒为 null
- 答案页 / 解析（当前题单里没有，需新增服务端接口）
- 服务端生成 PDF（Puppeteer / pdfkit）、html2canvas 位图方案
- Electron 新增文件系统能力或 IPC（除非 §9 的实测兜底被触发，届时单独确认）

---

## 3. 用户裁决记录（实现时勿推翻）

| # | 议题 | 裁决 |
|---|---|---|
| 1 | 导出内容 | **只题干 + 选项，留白作答**；不附答案与解析 |
| 2 | 覆盖范围 | **所有题库类专项**：四个答题页全部接入 |
| 3 | 入口 | **答题页顶栏常驻**，刚生成 / 答到一半 / 做完后都能导 |
| 4 | 版式 | **标准试卷版式**：A4 纵向、页首一行小字、题号连续、主观题留白 |
| 5 | 保存方式 | **系统打印对话框** → 目的地「另存为 PDF」→ 选目录；不新增文件系统权限 |

---

## 4. 纸面内容口径

### 4.1 输入

`PrintPaper` 只接收 `RunnerQuestion[]` + 页眉元信息：

```ts
interface PrintMeta {
  subject?: string;   // 学科名，如「数学」
  title?: string;     // 专项名，如「一元二次方程」；缺省用「{subject}练习」
  date?: string;      // YYYY-MM-DD，缺省取当天
}
```

不新增接口、不改 DTO；四个页面把已构造好的 `RunnerQuestion[]` 直接传入。

### 4.2 渲染规则

| 项 | 规则 |
|---|---|
| 题号 | 按数组顺序连续 `1..N`，忽略 `RunnerQuestion.n`（那是 questionId） |
| 材料 | **仅相邻**两题 `material` 字符串完全相同才合并，只印一次；不跨不相邻去重（避免不同文段顺序错乱） |
| 选项 | `options` 存在且非空时，按 `A/B/C/D...` 前缀逐行打印；选项文本走同一 Markdown/KaTeX 渲染 |
| 作答留白 | `choice` / `multi_choice` / `true_false`：不留额外空白（只印选项）；`fill_blank`：24mm；`short_answer` / `proof` / `calculation`：52mm；未知或缺失类型：40mm |
| 题面 | 走 `preprocessMarkdown` + 与答题页相同的 remark/rehype 插件集，确保公式、表格、图片与屏幕一致 |
| 答案 / 解析 | 不渲染 |

### 4.3 页眉与页脚

- 页眉一行：左侧 `学科 · 专项名`，右侧日期；下方 0.5pt 细线。
- 不印姓名 / 班级 / 分数（用户选的是标准版式，不是正式卷子）。
- 不自行排页码（浏览器打印面板的页眉页脚由用户决定，见 §6.3）。

---

## 5. 组件与样式

### 5.1 新增文件

| 文件 | 职责 |
|---|---|
| `apps/web/src/components/business/print/PrintPaper.tsx` | 纯展示：`PrintMeta` + `RunnerQuestion[]` → A4 纸面 DOM（`.print-sheet`） |
| `apps/web/src/components/business/print/PrintPreview.tsx` | `createPortal` 到 `document.body` 的全屏预览层（`.print-portal`）+ 工具栏；对外只暴露 `{ open, meta, questions, onClose }` |
| `apps/web/src/components/business/print/usePrint.ts` | 打印动作：等待纸面图片 decode（最长 3s）→ `window.print()`；无副作用、不抛错 |
| `apps/web/src/styles/print.css` | 屏幕预览样式 + `@media print` + `@page`；在 `main.tsx` 与 `global.css` 一起引入 |

### 5.2 预览层结构

```
.print-portal (fixed inset-0, z-60, 半透明遮罩, 可滚动)
  ├─ .print-toolbar (sticky top-0, 白底)
  │    ├─ 左：说明文字（见 §6.3）
  │    └─ 右：「导出 PDF」主按钮 / 「关闭」次级按钮
  └─ .print-sheet (210mm 宽, 白底, 14mm/12mm 内边距, 屏幕态带阴影)
       └─ .print-doc
            ├─ .print-head (学科 · 专项名 / 日期)
            └─ .print-q × N（每题 break-inside: avoid）
```

用 portal 的原因：答题页根节点是 `h-screen` + `overflow` 容器，结果弹窗还带 `max-h-[80vh]` + 内部滚动；直接把纸面渲染在页面里会被裁切。

### 5.3 打印样式要点

```css
@page { size: A4; margin: 14mm 12mm; }

@media print {
  body > #root { display: none !important; }
  .print-portal { position: static; background: #fff; overflow: visible; }
  .print-toolbar { display: none !important; }
  .print-sheet { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
}
```

- 字体：正文 10.5pt / 行高 1.75；页眉 9pt；专项名 13pt 粗体。
- 强制白底黑字：在 `.print-sheet` 内覆盖主题 token（`--text-primary:#111`、`--text-secondary:#444`、`--learn-card-bg:#fff`、`--learn-card-border:#ddd` 等），保证夜间模式导出仍是白纸。
- 图片：`max-width:100%; height:auto; break-inside: avoid;`；表格 `thead` 跨页重复。
- 题目块 `break-inside: avoid`；单题超过一页时允许自然分页（Chromium 行为，不做特殊处理）。

---

## 6. 交互与状态机

### 6.1 入口

| 页面 | 位置 | 触发 |
|---|---|---|
| 四个答题页（`TargetedRunPage` / `ErrorPracticeRunPage` / `VariationRunPage` / `RemediationRunPage`） | 右上角 `absolute top-4 right-4` 动作组。该容器现在包在 `{!draftOpen && ...}` 里、只放草稿图标，需拆成**常驻容器**：`导出` 始终渲染，`草稿` 仍随面板开合 | 打开预览层 |
| `AnswerResultList`（四个页面的结果态） | 底部按钮区，新增次级按钮「导出 PDF」（`确认` 左侧，`gap-3` 居中） | 打开预览层 |

- 按钮为线性 SVG + 文本「导出」，aria-label「导出 PDF」；题单为空时不渲染（现有页面已在空题单时提前 return，正常不会出现）。
- 结果态传入的是页面已有的 `resultQuestions`（同为 `RunnerQuestion[]`）。
- 结果弹窗新增可选 prop `onExport?: () => void`；不传时底部布局与现在完全一致（只有「确认」）。
- 四个页面各自新增一个 `printOpen` 状态；预览层关闭时回到原页面状态（不改动答题进度、不触发导航守卫）。

### 6.2 预览层状态机

| 状态 | 行为 |
|---|---|
| `closed` | 不渲染 portal |
| `open` | 渲染预览；`Esc` 与「关闭」→ `closed`；打开时 `document.body` 加 `overflow:hidden`，关闭时还原 |
| 打印中 | 点「导出 PDF」→ `usePrint` 等图片 decode → `window.print()`；打印面板取消 → 回到 `open`，不报错 |

### 6.3 保存位置与提示

- 工具栏左侧一行可操作说明：`在打印面板中选择「另存为 PDF」，并关闭「页眉和页脚」`。
- 该说明同时解决浏览器默认会印出网页 URL / 日期的问题；不提供程序内开关（Chromium 无 API）。

---

## 7. 错误处理与边界

| 场景 | 处理 |
|---|---|
| 图片未加载完就打印 | `usePrint` 对纸面内所有 `img` 调 `decode()`，`Promise.race` 3s 超时后照常打印（缺图不阻塞整份导出） |
| 用户取消打印 | 无副作用，预览层保持打开 |
| 公式超宽 | `.katex-display` 允许溢出滚动在屏幕态；打印态按正常换行，不做裁剪 |
| `material` 相同但不连续 | 各自独立打印（规则见 §4.2） |
| 夜间模式 / 家长主题 | 纸面内 token 强制覆盖，输出恒为白底黑字 |
| 预览层嵌套滚动 | portal 在 body 下、`position: fixed`，不受页面 `overflow:hidden` 影响 |

---

## 8. 测试

| 层级 | 内容 |
|---|---|
| 渲染测试 `PrintPaper.test.tsx` | ① 3 道题 → 题号连续 1/2/3；② 相邻同材料只出现一次、不相邻同材料出现两次；③ 选择题打印 A/B/C/D 且无留白块；④ `fill_blank` / `short_answer` 渲染对应 `data-testid="answer-space"` 高度类；⑤ 不渲染答案/解析 |
| 渲染测试 `AnswerResultList` 现有用例 | 不传 `onExport` 时布局不变；传 `onExport` 时出现「导出 PDF」按钮并可点击 |
| 手工冒烟（必须） | Chrome 打印预览目视：公式、图片、分页、页眉；再在 PC App 内点一次，确认打印面板能弹出 |

`globals: false`：新增测试文件自行 `afterEach(cleanup)`。

---

## 9. PC App 风险与兜底

- 现状：Electron 44，渲染层加载远端页面，`window.print()` 由 Chromium 原生实现，预期弹出系统打印面板。
- 风险：kiosk 全屏 + 学生模式可能影响面板弹出，**必须真机点一次**。
- 若被挡：兜底方案是主进程 `webContents.printToPDF()` + `dialog.showSaveDialog()`，需要新增一条**只做「打印当前预览页到我选的文件」**的窄 IPC。该方案触碰 `preload.js` 的安全边界，**不在本期实现**，触发时单独与用户确认。

---

## 10. 文档同步

- 无 API 变更 → `docs/API接口与数据流设计文档.md` / `docs/api/openapi.yaml` 不动。
- `docs/UX-UI设计文档.md` 增补「答题页导出 PDF」一节（入口位置、预览层、打印面板提示）；`apps/web/style.md` 不新增 token。
- 若实现中发现与 `docs/constraints/专项子系统.md` 冲突，以该文件为准并回报。

---

## 11. 验收标准

1. 数学专项生成 3 道题后，点右上角「导出」→ 预览显示 3 道题 → 点「导出 PDF」→ 系统打印面板 → 另存为 PDF → 文件可选保存目录，打开后公式与图片清晰、白底黑字、题号连续。
2. 答完题进入结果弹窗后，仍能从底部导出同一份题单。
3. 物理/化学/道法/语文知识点专项、中考模型、试卷题号、薄弱点、同类型、错题、变式、补偿相似题各入口均能导出，内容与当前题单一致。
4. 语文共享材料的连续两题，材料只出现一次。
5. 夜间模式下导出，PDF 仍是白底黑字。
6. 导出的 PDF 不含答案与解析。
7. PC App 内点「导出 PDF」能弹出打印面板（若不能，记录现象并按 §9 升级处理）。
