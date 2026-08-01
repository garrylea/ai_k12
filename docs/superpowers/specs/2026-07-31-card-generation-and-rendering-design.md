# Card 内容生成与渲染设计文档（v2）

**日期**：2026-07-31  
**关联**：data-refinery 管线、前端渲染  
**前提**：`CourseDetailPage.tsx` 需与参考实现 `http://localhost:3000/student/learn` 保持一致的布局、字号、配色与交互。

---

## 1. 背景与问题

data-refinery 管线在抽卡和前端渲染环节存在以下问题：

1. **front_matter 泄漏**：目录/版权页被 LLM 误判为 content，产出无意义卡片。
2. **渲染基准漂移**：原设计文档使用 1.6 行高（25.6px），但前端实际渲染参考页为 1.625（26px）；文字列宽 736px 与参考页 prose 768px 不一致。
3. **图片算法浪费**：小图按整行 46 字计费，高估计费且渲染时左右留白过多。
4. **容量与前端脱节**：原 700 字上限基于 1.6 行高和 736px 列宽，与参考页实测不一致。

---

## 2. 渲染基准（对齐参考页实测）

### 2.1 参考页实测（1920×825 视口）

| 项 | 值 |
|---|---|
| 左侧任务栏宽度 | 288px |
| 白卡宽度 | 896px（含左右 48px 内边距） |
| 正文栏宽度（prose） | 768px |
| 白卡背景 | `#FDFCF8` |
| H1（小节标题） | 20px / 28px 行高 / `#333333` / 700 |
| H2（卡片内标题） | 18px / 28px 行高 / `#B0C4DE` / 900 |
| 正文 | 16px / 26px 行高（1.625）/ `#3C4A35` / 500 |
| 列表项 | 16px / 32px 行高（2.0）/ `#3C4A35` |
| 圆角 | 12px |

### 2.2 新增 Design Token

写入 `apps/web/style.md` 与 `apps/web/src/styles/global.css`：

```css
/* 学习沉浸页专用 token */
--learn-sidebar-width: 18rem;        /* 288px @root16 */
--learn-card-max-w: 56rem;           /* 896px */
--learn-prose-w: 48rem;              /* 768px */
--learn-card-bg: #FDFCF8;
--learn-text-primary: #3C4A35;
--learn-heading-1: #333333;
--learn-heading-2: #B0C4DE;

--fs-learn-h1: 1.25rem;              /* 20px */
--fs-learn-h2: 1.125rem;             /* 18px */
--fs-learn-body: 1rem;               /* 16px */
--lh-learn-body: 1.625;              /* 26px */
```

### 2.3 布局

```
┌─────────────────┬──────────────────────────────────────────────┐
│  288px 左侧栏   │  面包屑 · 小节标题 H1   第 1 / 5 页   [护眼] │
│                 │  ┌──────────────────────────────────────┐   │
│ 今日任务        │  │ #FDFCF8 白卡（max 896px）              │   │
│ 数学·初二上     │  │                                      │   │
│ [阶段列表]      │  │  【概念引入】一元二次方程…  H2         │   │
│                 │  │                                      │   │
│ 小明            │  │  正文 16px/1.625 垂直居中              │   │
│ 专注学习中…     │  │                                      │   │
│                 │  │  [图片]                              │   │
│                 │  │                            ┌──────┐  │   │
│                 │  │                            │ 答疑 │  │   │
│                 │  └──────────────────────────────────────┘   │
│                 │  上一页                下一页/开始作业        │
└─────────────────┴──────────────────────────────────────────────┘
```

- **护眼模式**：位于主内容区右上角（与进度并排），而非左侧栏。
- **答疑按钮**：悬浮圆形按钮，固定在白卡右下角（`position: absolute`），点击后与当前卡片内容进入 AI 讨论。
- **底部操作栏**：仅保留「上一页」「下一页/开始作业」两个扁平按钮，不重复放答疑入口。

### 2.4 响应式

- **桌面（≥1280px）**：288px 边栏，896px 白卡，768px prose。
- **iPad 横屏（1024px）**：边栏缩至 `14rem`（224px），白卡 `max-w: 100%` 自适应；prose 保持 768px，不足时等比收缩内边距。
- 文字在卡片内垂直居中：`flex flex-col justify-center`；超长时 `overflow-y-auto` 兜底滚动（不裁切）。

### 2.5 标题层级

- **H1**（白卡上方）：小节标题，20px，`#333333`。如“12.2 知识自学与概念理解”。
- **H2**（白卡内）：卡片内容标题，18px，`#B0C4DE`。如“【概念引入】一元二次方程的基本形式”。
- **H3**：与正文同大，16px。Markdown `#` 标记在 content 中对应 H3 时不再额外放大。
- **正文**：16px / 1.625。

---

## 3. 卡片容量与分卡算法

### 3.1 新约束

- 单卡**文字** ≤ **400 字**（统计规则同 `_count_text_chars`：汉字 + 英文单词 + 数字，不含 Markdown 标记和 LaTeX 源码）。
- 单卡**文字 + 图片折算** ≤ **700**。
- 超长文字按句末标点切分。

### 3.2 渲染基准常量

```python
TEXT_LIMIT = 400
TOTAL_LIMIT = 700
LINE_HEIGHT = 26          # 参考页 body 行高
CHARS_PER_LINE = 48       # 768px prose / 16px 字宽
IMG_MAX_WIDTH = 768       # prose 宽度
```

### 3.3 图片折算公式（块级渲染）

```python
def image_cost(raw_w, raw_h):
    if raw_w > IMG_MAX_WIDTH:
        scale = IMG_MAX_WIDTH / raw_w
        scaled_w = IMG_MAX_WIDTH
        scaled_h = raw_h * scale
    else:
        scaled_w = raw_w
        scaled_h = raw_h

    rows = ceil(scaled_h / LINE_HEIGHT)
    return rows * CHARS_PER_LINE
```

示例：
- 200×40 小图：`ceil(40/26)=2` 行 → `2×48=96` 字。
- 1000×500 大图缩到 768×384：`ceil(384/26)=15` 行 → `15×48=720` 字 → 独占卡。
- 500×200 图：`ceil(200/26)=8` 行 → `8×48=384` 字，可与 ≤16 字文字合并（384+16=400≤700），或与更多文字合并时压缩图。

### 3.4 分卡算法（image-aware greedy）

**Step 1：拆 bundle**  
每个自然段 + 属于它的图 = 一个 bundle。若段落文字 >400，按句末标点切成多个子段，图按位置归到对应子段。

**Step 2：贪心合卡**  
维护当前卡，依次尝试放入 bundle：

```
if current.text + bundle.text <= 400
   and current.total + bundle.text + bundle.image_cost <= 700:
    current.add(bundle)
else:
    close current card
    start new card with bundle
```

**Step 3：图压缩**  
若 bundle 自身 `text + image_cost > 700` 但 `text <= 400`：

```python
image_room = TOTAL_LIMIT - bundle.text
if bundle.image_cost > image_room:
    target_rows = floor(image_room / CHARS_PER_LINE)
    target_height = target_rows * LINE_HEIGHT
    scale = target_height / scaled_height
    # 更新 scaled_w / scaled_h / cost
```

**不拆文字优先**：文字连贯性 > 图片完整尺寸。

### 3.5 验证示例

| 场景 | 结果 |
|---|---|
| 400 字 + 260 字图（同段） | total=660≤700，合并到同一张卡 |
| 400 字段落 + 260 字图段落 | 卡 1 放 400 字后 total=400，图加入后 total=660≤700，合并 |
| 260 字 + 400 字图 | total=660≤700，合并到同一张卡 |
| 400 字 + 400 字图 | image_room=300，图压缩到 300 字成本，合并 |

---

## 4. 前端图片渲染

### 4.1 渲染规则

- 所有图片**块级居中**（Markdown 默认行为）。
- 小图（`scaled_w < 768px`）按原宽显示，左右留白；大图缩放到 768px 宽。
- 图片高度等比缩放。

### 4.2 前端 img 组件

```tsx
<img
  src={resolveAsset(src)}
  alt={alt}
  width={meta?.width}      // scaled_w from image_scan
  height={meta?.height}    // scaled_h from image_scan
  className="block mx-auto my-4 max-w-full h-auto"
/>
```

### 4.3 cost 与渲染配对

由于渲染是块级居中，cost 按“高度占多少整行”计算，宽度只影响视觉留白不影响容量预算。此配对保证卡片不会纵向溢出。

---

## 5. front_matter 过滤

### 5.1 问题

实测九年级下册：page_005（目录）、page_006（章目录）、page_007（版权页）均被 LLM 误判为 content 并产出卡片。

### 5.2 根因分析：模型能力与 prompt 的边界

当前使用 **gemma4 26B**（本地部署）进行页类型分类。26B 模型在中文教材排版语义识别上存在天然局限：

- **目录行 vs 正文标题**：目录行「26.1 反比例函数 2」末尾带页码数字，但 26B 难以稳定区分「这是目录页的行尾页码」和「这是正文里的数字」。
- **版权页 vs 空白页**：「人民教育出版社」这类短文本，26B 没有足够上下文判断其属于版权页还是正文开头。
- **prompt 无法根治**：即使强化 prompt（加示例、加格式约束），26B 的指令遵循率不足以保证 100% 正确，且 prompt 过长会进一步降低小模型的准确率。

**结论**：这不是 prompt 写得不够好，而是 26B 在结构化分类任务上的能力天花板。**正确的策略不是换更大模型（成本高、延迟大），而是确定性规则兜底 + 保守 fallback。**

### 5.3 方案：确定性预过滤 + LLM + 保守 fallback

在 `extract_cli.py` 调用 `card_labeler.label()` 之前增加 `pre_filter_page(text, page_num)`：

```python
def is_front_matter(text: str, page_num: int) -> bool:
    lines = [l.strip() for l in text.splitlines() if l.strip()]

    # 1. 版权页
    if any(k in text for k in ["出版社", "仅供个人学习", "未经授权", "版权所有"]):
        return True

    # 2. 目录页：大量 "标题 数字" 行
    toc_line_count = sum(
        1 for l in lines
        if re.search(r'[一二三四五六七八九十\d].+\s+\d{1,3}$', l)
    )
    if len(lines) > 0 and toc_line_count / len(lines) >= 0.5:
        return True

    # 3. 空页或前置空白页（前 10 页内极短内容）
    if len(text.strip()) < 30 and page_num <= 10:
        return True

    return False
```

**LLM fallback 修正**：当前 `extract_cli.py` 在 LLM 失败时默认 `page_type="content"`。改为默认 `page_type="front_matter"`（保守跳过），避免版权/目录页因 LLM 失败而泄漏。

### 5.4 边界

- 规则仅针对前置页；正文页若含大量数字列表不会被误伤（数字列表不以“标题 数字”模式行尾聚集）。
- 章节综述/章前图不在过滤范围内，仍由 LLM 标为 `chapter_intro`。

---

## 6. 文件变更清单

### data-refinery（管线）

| 文件 | 变更 |
|---|---|
| `tools/data-refinery/src/image_scan.py` | 更新常量：`LINE_HEIGHT=26`、`CHARS_PER_LINE=48`、`IMG_MAX_WIDTH=768`；cost 公式改为高度整行法；返回 scaled_w/scaled_h |
| `tools/data-refinery/src/card_splitter.py` | `TEXT_LIMIT=400`、`TOTAL_LIMIT=700`；改为 bundle + image-aware greedy；超长段切分；图压缩逻辑 |
| `tools/data-refinery/src/extract_cli.py` | 新增 `pre_filter_page()`；LLM 失败 fallback 改为 `front_matter` |
| `docs/K12智学系统-Card内容生成与渲染设计文档.md` | 更新 §2 常量、§3 图片算法、字数上限推导 |

### apps/web（前端）

| 文件 | 变更 |
|---|---|
| `apps/web/src/styles/global.css` | 新增 learn 页 token（边栏、卡宽、颜色、字号/行高） |
| `apps/web/style.md` | 同步记录 learn 页 token 与参考页依据 |
| `apps/web/src/pages/student/CourseDetailPage.tsx` | 按参考页重构：288px 左侧阶段栏、896px 白卡、768px prose、H1/H2/正文层级、垂直居中、护眼模式移至右上角、答疑为白卡右下角悬浮圆形按钮、上一页/下一页/开始作业 |
| `apps/web/src/components/business/TextbookCard.tsx` | 若保留则对齐新渲染规则；若 CourseDetailPage 内联实现，则合并或废弃 |

---

## 7. 验证计划

1. **管线回归**：跑 `extract_cli.py` 处理九年级下册 page_005–page_010，确认 page_005/006/007 不再产出卡片，page_009/010 正常产出。
2. **容量验证**：构造 400 字 + 260 字图、260 字 + 400 字图、400 字 + 400 字图三种测试用例，检查 JSONL 输出符合预期。
3. **前端视觉还原**：在 1920px 和 1024px 下打开 `CourseDetailPage`，与参考页截图对比布局/字号/颜色。
4. **溢出检查**：在 iPad 768px 高下测试 400 字 + 大图卡片，确认无裁切、可滚动兜底。
