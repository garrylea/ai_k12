# AnswerModal & AnswerResultList  redesign design

> 日期：2026-08-09
> 范围：前端组件（`AnswerModal.tsx`、`AnswerResultList.tsx`、`SymbolPalette.tsx`）
> 后端：无需改动（判题、错题本入库已就绪）

---

## 1. 背景与目标

当前 `AnswerModal` 布局为：顶部题面（32% 高度）+ 左编辑/右预览 + 底部提交按钮。存在以下问题：

1. 底部「退出」和「提交」按钮样式简陋，缺少视觉层级；顶部缺少 PRD 规定的「提示」和「让 AI 讲一讲」苏格拉底辅助入口
2. 提交后无即时反馈，需手动点「下一题」，流程不够顺畅
3. `SymbolPalette` 显示中文分组标签（运算/幂根/几何/其它），视觉冗余
4. `AnswerResultList` 题目文本截断、用 ✓/✗ emoji、解析简陋

本设计重做 `AnswerModal` 布局与交互，并重写 `AnswerResultList`。

---

## 2. 设计约束

- 配色严格遵循 `apps/web/style.md` §2
- 图标仅限线性 SVG，禁用 emoji
- 禁用装饰元素
- iPad 横屏（≥1024px）为主要断点
- 学习沉浸层包裹 `.student-theme-container`，启用日夜模式

---

## 3. AnswerModal 新布局

### 3.1 结构（自上而下）

```
┌─────────────────────────────────────────────────────┐
│  题号栏（第 N / M 题 · 题型）                        │
│  ┌──────────────────────────────┐  ┌─────────────┐ │
│  │ 题目正文（Markdown+LaTeX）    │  │ 💡 提示     │ │
│  │ 粗体大字，行高 1.7            │  │ 💬 AI 讨论  │ │
│  └──────────────────────────────┘  └─────────────┘ │
├──────────────────────┬──────────────────────────────┤
│ ÷ × ± ≤ ≥ ≠ │ √ ½  │ ∵ ∴ ∠ △ ⟂ ∥ °               │ ← 符号工具栏
├──────────────────────┼──────────────────────────────┤
│                      │                              │
│  LaTeX 输入框        │   Markdown+LaTeX 实时预览     │
│  monospace 13px      │   debounced 150ms            │
│                      │                              │
├──────────────────────┴──────────────────────────────┤
│  ○ ✕（关闭）                    ● ✈️（提交）        │
│  40px 圆形，左下角                48px 圆形，右下角    │
└─────────────────────────────────────────────────────┘
```

### 3.2 顶部题目区

- **题号栏**：`11px` / `Text-Tertiary #9C8D80` / `font-weight: 500`，格式「第 N / M 题 · [题型]」
- **题目正文**：`17px` / `font-weight: 700` / `Text-Primary #2A1F18` / `line-height: 1.7`
  - 通过 `ReactMarkdown` + `remarkMath` + `rehypeKatex` 渲染
  - 加粗用 `[&>*]:font-bold`（子选择器穿透）：`global.css` 的 `p{font-weight:normal}` 会覆盖父级继承的 `font-weight:700`，须用 `[&>*]:font-bold` 显式作用于 ReactMarkdown 渲染出的直接子元素（`<p>`/`<ol><li>`），与 `CourseDetailPage` 的 `exercise-stem` 同一方案
  - 题型标签（如「【证明题】」）使用 `Brand-500 #ff6b35` / `font-weight: 800`
- **右侧图标按钮列**：垂直堆叠，间距 `8px`
  - **提示**（💡）：`38×38px` / 圆角 `12px` / 边框 `1px solid Bg-Subtle #F2EBE0` / 背景 `#FFFFFF` / 图标色 `Warning #D89844`
    - hover：`background: #FFF8F0`
    - title="提示"
  - **让 AI 讲一讲**（💬）：同尺寸，图标色 `Info #4A7BA6`
    - hover：`background: #F0F5FA`
    - title="让 AI 讲一讲"
  - 两个按钮均带 `box-shadow: 0 1px 2px rgba(0,0,0,0.04)`

### 3.3 中部编辑+预览区

- **容器**：`flex: 1` 撑满剩余空间，左右各 `50%`
- **左侧编辑器**：
  - 背景 `Bg-Base #FAF6EE`
  - 右侧边框 `1px solid Bg-Subtle #F2EBE0`
  - 符号工具栏：背景 `#FFFFFF`，底边框 `1px solid Bg-Subtle`，`padding: 8px 12px`，符号按钮 `padding: 3px 8px` / `font-size: 14px` / 圆角 `6px`
  - **去除中文分组标签**，组间用 `1px` 竖线分隔（`Bg-Subtle #F2EBE0`，高 `22px`，垂直居中）
  - 符号按钮 hover：`border-color: Brand-500 #ff6b35; color: Brand-500`
  - **插入行为**：`SymbolPalette` 点击插入时由 `LatexEditor.insertAtCursor` 判断光标上下文——光标前 `$` 为偶数个（数学模式外）时自动用 `$...$` 包裹符号，使右侧预览的 KaTeX 立即渲染；为奇数个（已在 `$...$` 内）时裸插入，避免重复包裹；`$` 按钮直接插入裸 `$` 供手动切换模式（裸 LaTeX 命令若不包裹 `$...$`，remark-math 不识别，预览会原样显示文本）
  - `<textarea>`：`flex: 1`，`padding: 14px`，`font-family: monospace`，`font-size: 13px`，`line-height: 1.8`，placeholder「在此用 LaTeX 作答，用 $...$ 包裹数学公式」
- **右侧预览区**：
  - 背景 `#FFFFFF`
  - `padding: 16px`
  - 空状态：`13px` / `Text-Tertiary #9C8D80` / italic
  - 实时渲染：复用现有 `LatexPreview` 组件（150ms debounce，ReactMarkdown + KaTeX）

### 3.4 底部操作栏

- **布局**：`padding: 12px 18px`，`justify-content: space-between`
- **关闭按钮（左侧）**：
  - `40×40px` 圆形
  - 边框 `1px solid Bg-Subtle #F2EBE0`
  - 背景 `#FFFFFF`
  - X SVG 图标，`16×16`，`stroke-width: 2.5`
  - 图标色 `Text-Tertiary #9C8D80`
  - hover：`background: Bg-Base #FAF6EE; border-color: #E0D8CC`
- **提交按钮（右侧）**：
  - `48×48px` 圆形（比关闭大，突出主操作）
  - 无边框
  - 背景 `Brand-500 #ff6b35`
  - paper-plane SVG 图标，`20×20`，白色
  - `box-shadow: 0 2px 8px rgba(255,107,53,0.3)`
  - hover：`background: Brand-600 #e85a28; transform: scale(1.05)`

### 3.5 交互流

| 步骤 | 触发 | 行为 |
|------|------|------|
| 1 | 学生输入答案，点击提交 | 提交按钮进入 loading 态（旋转图标），禁用 |
| 2 | `judgePractice` API 返回 | 题目区下方显示 toast：绿色 ✓「正确」或红色 ✗「错误」 |
| 3 | 非最后一题 | 1.5s 后 toast 消失，自动切到下一题，输入框清空 |
| 4 | 最后一题 | 1.5s 后关闭 AnswerModal，显示 AnswerResultList |
| 5 | 后端 | 答错自动入主线错题本 + 题库（已有逻辑，无需改动） |
| 6 | 关闭按钮 | 关闭 modal，**不保存**当前未提交的答案 |

- **提示按钮**：点击后展开一个非阻塞的 hint drawer（从顶部题目区下方滑出，显示 AI 给出的下一步思路）
- **讨论按钮**：点击后进入 AI Socratic 对话覆盖层（范围限定在当前题目）

---

## 4. AnswerResultList 新布局

### 4.1 结构

```
┌─────────────────────────────────────────┐
│  答题结果              ● 对 2  ● 错 1   │
├─────────────────────────────────────────┤
│ ┌─────────────────────────────────────┐ │
│ │ ✓  (1) 若方程 x² - 5x + 6 = 0...   │ │
│ │     你的答案：5                     │ │
│ └─────────────────────────────────────┘ │
│ ┌─────────────────────────────────────┐ │
│ │ ✗  (2) 证明：等腰三角形...           │ │
│ │     你的答案：AD垂直BC...            │ │
│ │     [查看解析] ← 点击展开            │ │
│ └─────────────────────────────────────┘ │
│ ┌─────────────────────────────────────┐ │
│ │ ✓  (3) 在 △ABC 中...               │ │
│ │     你的答案：50°                   │ │
│ └─────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│           [  完 成  ]                   │
└─────────────────────────────────────────┘
```

### 4.2 Header

- 左侧标题：`17px` / `font-weight: 700` / `Text-Primary #2A1F18`
- 右侧统计：
  - 对：`8px` 圆点 `Success #4A9B6E` + `13px` 文字 `对 X`
  - 错：`8px` 圆点 `Error #C44A3F` + `13px` 文字 `错 Y`
  - 文字色 `Text-Secondary #6B5D52`

### 4.3 题目项

- **容器**：背景 `#FFFFFF`，圆角 `12px`，边框 `1px solid Bg-Subtle #F2EBE0`，`padding: 14px 16px`
- **状态图标**：`24×24px` 圆形，居中
  - 正确：背景 `#E8F5EE`，内嵌 `12×12` ✓ SVG，`stroke: Success #4A9B6E`，`stroke-width: 3`
  - 错误：背景 `#FCE8E6`，内嵌 `12×12` ✗ SVG，`stroke: Error #C44A3F`，`stroke-width: 3`
- **题目正文**：`14px` / `font-weight: 500` / `Text-Primary #2A1F18` / `line-height: 1.6`，通过 ReactMarkdown + KaTeX 渲染
- **学生答案**：`margin-top: 8px`，背景 `Bg-Base #FAF6EE`，圆角 `8px`，`padding: 8px 12px`
  - 标签「你的答案：」`12px` / `Text-Tertiary #9C8D80`
  - 答案内容 `13px` / `Text-Primary #2A1F18` / `font-family: monospace`
- **⚠️ 去除「正确」「错误」文字标签** — 状态图标已足够表达

### 4.4 错题解析（默认收起）

- **查看解析按钮**（仅错题显示）：
  - `padding: 6px 16px`
  - 圆角 `8px`
  - 边框 `1px solid Warning #D89844`
  - 背景 `#FFF8F0`
  - 文字 `Warning #D89844` / `12px` / `font-weight: 500`
  - hover：`background: Warning #D89844; color: #FFFFFF`
- **展开后的解析区**：
  - `padding: 14px 16px`
  - 背景 `#FFF8F0`
  - 圆角 `10px`
  - 左边框 `3px solid Warning #D89844`
  - 错因类型：`12px` / `font-weight: 600` / `Warning #D89844`，如「错因：证明逻辑不完整」
  - 解析正文：`13px` / `Text-Primary #2A1F18` / `line-height: 1.7`，通过 ReactMarkdown + KaTeX 渲染

### 4.5 Footer

- 「完成」按钮居中
- `padding: 10px 32px`
- 圆角 `10px`
- 背景 `Brand-500 #ff6b35`
- 文字 `#FFFFFF` / `14px` / `font-weight: 600`
- `box-shadow: 0 1px 3px rgba(255,107,53,0.25)`
- hover：`background: Brand-600 #e85a28`
- 点击后关闭 result list，返回 `CourseDetailPage`

---

## 5. SymbolPalette 调整

- 去除 `GROUPS` 中的中文标签（运算、幂根、几何、其它）
- 组间插入 `1px` 竖线分隔符（`Bg-Subtle #F2EBE0`，高 `22px`）
- 按钮样式保持：`min-w-[32px] h-8 px-2 rounded-md text-sm bg-[var(--bg-subtle)] hover:bg-[var(--brand-500)] hover:text-white border border-[var(--bg-subtle)]`

---

## 6. 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `apps/web/src/components/business/AnswerModal.tsx` | 重写 | 新布局（顶部/中部/底部三段式），新交互流（toast + 自动下一题） |
| `apps/web/src/components/business/AnswerResultList.tsx` | 重写 | 展开式列表，去掉文字标签，添加【查看解析】按钮 |
| `apps/web/src/components/business/SymbolPalette.tsx` | 修改 | 去除中文分组标签，添加组间竖线分隔 |
| `apps/web/src/components/business/LatexEditor.tsx` | 微调整 | 样式对齐（padding、字体等） |
| `apps/web/src/components/business/LatexPreview.tsx` | 无改动 | 现有逻辑完全复用 |

---

## 7. 后端依赖（已有，无需改动）

- `POST /api/practice/judge` — AI 判题，返回 `isCorrect` / `method` / `analysis` / `errorType` / `errorBookId`
- `MainErrorBooksRepository.create` — 错题自动入库
- `QuestionsRepository.findOrCreate` — 新题自动结构化入库
