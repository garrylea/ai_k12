# 教材卡片拆分与图片尺寸处理方案

**日期**：2026-07-29
**状态**：设计中
**关联**：data-refinery 管线、前端渲染统一

---

## 1. 问题陈述

当前教材卡片提取管线存在以下问题：

1. **LLM 拆分内容不可靠** — LLM 天然会"润色"输入内容，但教材卡片要求原文一字不改。LLM 按 400 字拆分的精度不可控，实际产出中出现了 content 为纯图片、content 为空等情况。

2. **图片尺寸缺失** — MinerU 输出的 Markdown 中图片仅以 `![](images/hash.jpg)` 引用，无宽高信息。LLM 在拆分卡片时不知道图片实际占用的空间，无法准确判断卡片是否超过 400 字上限。

3. **渲染时无图片尺寸** — 前端 `<img>` 无 `width`/`height` 属性，导致布局抖动（CLS）。

4. **content_metadata 未带宽高** — 当前 `content_metadata.images[]` 仅含 `{url, alt, position}`，缺少宽高维度。

---

## 2. 核心设计原则

### 2.1 内容只读原则

> **Python 程序拆卡，LLM 只做标注。**
> Python 程序处理内容时一字不改，原文原样输出。
> LLM 只负责分类判断（page type / lesson_id / card_type），不触碰 content。

### 2.2 图片唯一真实来源

> 图片尺寸的唯一可靠来源是磁盘上的实际图片文件（`images/hash.jpg`），通过 PIL 读取。
> LLM 不负责输出任何尺寸信息。

### 2.3 统一渲染基准

> 所有学段（小学/初中/高中）统一使用 **16px 字号 + 1.6 行高**，
> 容器内容区宽度 **736px**，折合 **46 汉字/行**。
> 图片折算字数基于此基准计算，前后端共用。

---

## 3. 图片尺寸处理

### 3.1 图片有效显示宽度

卡片内容区宽度 736px，图片左右各留 18px 内边距，有效显示宽度：

```
图片有效宽度 = 700px（即 736 − 36，取整）
```

### 3.2 宽度缩放（第一步）

先确保图片宽度不超出卡片可视范围：

```
if 图片原始宽度 > 700:
    scale = 700 / 原始宽度
    缩放后宽度 = 700
    缩放后高度 = ceil(原始高度 × scale)
else:
    缩放后宽度 = 原始宽度
    缩放后高度 = 原始高度
```

宽度缩放是**等比缩放**，宽高同时按同一比例变化。后续所有计算基于**缩放后高度**。

### 3.3 折算字数（基于缩放后高度）

```
行盒总高 = 字号(16px) × 行高系数(1.6) = 25.6px
每行汉字 = 736px ÷ 16px = 46

图片折算字数 = ceil(缩放后高度 / 25.6) × 46
```

| 项 | 值 | 来源 |
|---|---|---|
| iPad 横屏宽度 | 1024px | iPad 横屏基准 |
| 侧边导航 StudentNav | 224px | `w-56` = 14rem × 16 = 224px |
| 内容区宽度 | 800px | 1024 − 224 |
| 卡片内边距 | 64px | `px-8` = 左右各 32px |
| 文字区宽度 | **736px** | 800 − 64 |
| 图片有效宽度（含留边） | **700px** | 736 − 18×2 |
| 统一字号 | **16px** | 所有学段统一 |
| 统一行高系数 | **1.6** | 所有学段统一 |
| 行盒总高 | **25.6px** | 16 × 1.6 |
| 每行汉字数 | **46** | 736 ÷ 16 |
| 图片占卡 75% 阈值 | **300 字** | 400 × 0.75 |

### 3.4 高度判断（第二步）

宽度适配后，按缩放后的折算字数判断图片在卡片中的排布方式：

```
情况 A：折算字数 ≥ 300（400 字的 75%）
    → 图片独占一张卡，不配文字，content = 纯图 ![](path)
    → 这张卡不计 400 字限制

情况 B：折算字数 < 300，但（折算字数 + 文字字数）> 400
    → 图文放同一张卡放不下，对图片做第二次等比缩小
    → 图可分配行数 m = floor((400 − 文字字数) / 46)
    → 目标高度 = m × 25.6
    → 二次 scale = 目标高度 / 缩放后高度
    → 宽、高等比缩小，新折算字数 = m × 46
    → 此时总字数（文字 + 新折算）≤ 400

情况 C：折算字数 < 300，且（折算字数 + 文字字数）≤ 400
    → 图文正常合并为一张卡，按 splitter 规则处理
```

### 3.5 举例

| 场景 | 原始尺寸 | 宽度缩放后 | 折算字数 | 判断 | 结果 |
|---|---|---|---|---|---|
| 超大图 | 1000×500 | 700×350 | 644 | ≥300（情况 A） | 独占卡 |
| 大图 | 800×250 | 700×219 | 414 | ≥300（情况 A） | 独占卡 |
| 中等图 | 500×200 | 500×200 | 368 | ≥300（情况 A） | 独占卡 |
| 中等图+少文 | 500×180 | 500×180 | 322 | ≥300（情况 A） | 独占卡 |
| 小图+多文 | 400×60 | 400×60 | 138 | <300，文案超（情况 B） | 二次缩小 |
| 小图+少文 | 200×40 | 200×40 | 92 | <300，不超（情况 C） | 图文合并 |

### 3.6 宽度不影响折算字数，但宽度必须适配

- 折算字数只由**高度**决定（无论多宽，占行数确定后字数就确定了）
- 但宽度需要写入 `content_metadata.images[].width` 供前端渲染
- 前端渲染时 CSS 控制 `max-width:100%; height:auto` 确保不溢出

---

## 4. 数据流

```
┌─────────────────────────────────────────────────┐
│ ① convert（MinerU）                               │
│    page_NNN.jpg → page_NNN.md + images/hash.jpg  │
│    图片引用：![](images/hash.jpg)                  │
└──────────────────────┬──────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│ ② image_scan（新增：Python 程序）                  │
│    扫描 page_NNN.md 中所有 ![](images/*.jpg)      │
│    PIL 读实际宽高 → 计算折算字数                    │
│    输出：图片清单 {path, width, height, charCost}  │
│    不修改 MD 文件                                  │
└──────────────────────┬──────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│ ③ card_splitter（新增：Python 程序）               │
│    输入：MD 正文 + 图片清单（折算字数）              │
│    规则：按自然段落边界切分，总字数 ≤ 400            │
│    输出：list[{content, sort_order, images[]}]    │
│    content 原封不动，一字不改                        │
└──────────────────────┬──────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│ ④ card_labeler（LLM 角色）                        │
│    输入：拆分后的卡片列表 + 页码标记                 │
│    任务：                                         │
│      • 判断页类型（封面/目录/正文/习题 → 是否抽取）  │
│      • 给每张卡标 card_type                        │
│      • 给每张卡标 lesson_id（章节标题或 null）      │
│      • 识别 textbook_page（页码）                   │
│    不触碰 content，不拆分/合并卡片                   │
│    输出：labeled cards（完整 TextbookCard 模型）    │
└──────────────────────┬──────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│ ⑤ publish（image_rewrite）                        │
│    物化图片到 assets/，改写路径                     │
│    从实际文件读宽高 → 写入 content_metadata         │
│    输出 published JSONL                           │
└──────────────────────┬──────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│ ⑥ db_loader                                       │
│    published JSONL → MySQL cards 表               │
│    content_metadata 字段存图片宽高 JSON             │
└──────────────────────┬──────────────────────────┘
                       ↓
┌─────────────────────────────────────────────────┐
│ ⑦ 前端渲染                                        │
│    从 content_metadata.images[] 取 width/height   │
│    <img width={w} height={h} />                  │
│    CSS：max-width: 100%; height: auto;            │
└─────────────────────────────────────────────────┘
```

---

## 5. card_splitter 设计（Python 程序）

### 5.1 输入

```python
@dataclass
class PageContent:
    """单页 MD 的完整信息"""
    md_path: Path                    # page_NNN.md 路径
    text_content: str                # 纯文本内容（含 Markdown/LaTeX 标记）
    images: list[ImageInfo]          # 该页所有图片
    page_number: int                 # 页码（从文件名提取，如 8）

@dataclass
class ImageInfo:
    ref_path: str                    # MD 中的引用路径，如 "images/hash.jpg"
    disk_path: Path                  # 磁盘实际路径
    width: int                       # px
    height: int                      # px
    char_cost: int                   # 折算字数 = ceil(height/25.6) × 46
    position_in_text: int            # 在 text_content 中的字符位置
```

### 5.2 拆分算法

```
输入：PageContent（正文 + 图片清单，每张图片含缩放后宽高和折算字数）

1. 对每张图片，按 §3.2 做宽度适配（缩小超宽图）
2. 按 §3.4 做高度判断：
   a. 折算字数 ≥ 300 → 该图片独占一张卡（只含图片，无文字，不计上限）
   b. 折算字数 < 300，且 (折算字数 + 同段文字字数) > 400 → 二次缩小
   c. 折算字数 < 300，且总字数 ≤ 400 → 正常合并
3. 排除已独占卡的图片后，对其余文字执行段落合并：
   - 按自然段落（\n\n）切分
   - 贪心合并：当前卡片 + 下一段（含图折算）≤ 400 → 合并
   - 超过 400 → 当前卡结束，下一段开始新卡
4. 如果单段（含图）超过 400 字：
   按句末标点（。！？）切割，优先在完整句子处断开
5. 输出：list[CardFragment]{content, sort_order, images[]}
   纯图卡的 content 为 ![](path)，不含文字
```

### 5.3 关键规则

1. **content 原文不动**：输出的 content 是原始 Markdown 片段的原样复制，不做任何文本修改。
2. **段落优先**：合并时优先按 `\n\n` 边界，不在段落中间打破。
3. **图片跟随所属段落**：`![](images/hash.jpg)` 保持在其原始位置不动的 Markdown 中。
4. **一章概述（"第 0 节"）**：由 LLM labeler 判断，splitter 不关心章节逻辑。
5. **前置内容识别**：封面/目录/版权等由 LLM labeler 标记，splitter 不对页面类型做判断。

### 5.4 输出

```python
@dataclass
class CardFragment:
    """拆分后的原始卡片片段"""
    sort_order: int                  # 页内序号，从 1 开始
    content: str                     # 原始 Markdown（含图片引用），不改一字
    images: list[ImageInfo]          # 本卡片包含的图片
    raw_text_char_count: int         # 纯文字字数
    image_char_cost: int             # 图片折算总字数
    total_char_cost: int             # = 前两项之和
    textbook_page: str               # 从 MD 文件名提取，如 "P8"
```

---

## 6. card_labeler 设计（LLM 轻量角色）

### 6.1 职责边界

| 事项 | Python splitter | LLM labeler |
|---|---|---|
| 读取 MD 内容 | ✅ | ✅（作为上下文） |
| 读取图片清单+折算字数 | ✅ | ✅（作为提示） |
| 拆分卡片 | ✅ | ❌ |
| 修改 content | ❌ | ❌ **严禁** |
| 判断页类型 | ❌ | ✅ |
| 标 card_type | ❌ | ✅ |
| 标 lesson_id | ❌ | ✅ |
| 标 textbook_page | ❌ | ✅ |
| 标 title | ❌ | ✅ |

### 6.2 输入

LLM 收到一页的信息，包括：
- 当期页的 Markdown 正文
- 图片清单（带折算字数）
- 已拆分好的卡片清单（splitter 输出）
- 跨页上下文（上一页的 lesson_id）

### 6.3 输出

```json
{
  "page_type": "content",
  "items": [
    {
      "sort_order": 1,
      "card_type": "concept",
      "lesson_id": "26.1 反比例函数",
      "title": "反比例函数概念",
      "textbook_page": "P8"
    }
  ]
}
```

注意：输出中**不包含** content 字段。content 由 splitter 直接提供，labeler 只输出标注字段。

### 6.4 页类型判断

| page_type | 含义 | 行为 |
|---|---|---|
| `front_matter` | 封面、版权、目录、前言 | 不产出任何卡片（extract_cli 跳过） |
| `chapter_intro` | 章前综述/章前图 | 产出 card_type="reading"，lesson_id="第N章 X" |
| `content` | 正文内容 | 正常标注 |
| `practice` | 纯习题/练习页 | 正常标注，card_type 多为 "practice" |

### 6.5 优化：减少 LLM 调用次数

- 同一本书里，连续多页通常属于同一节。可以让 LLM 一次处理多页（如 3~5 页），给所有卡片打标注，效率更高。
- 纯正文页（无编号标题出现）自动继承上一页的 lesson_id，无需 LLM 再次确认。

---

## 7. 图片尺寸存储

### 7.1 content_metadata 结构

```json
{
  "images": [
    {
      "url": "textbooks/math/a1b2c3d4/page_08_fig_01.jpg",
      "alt": "雕像高度示意图",
      "position": "inline",
      "width": 400,
      "height": 300
    },
    {
      "url": "textbooks/math/a1b2c3d4/page_08_fig_02.jpg",
      "alt": "函数图像",
      "position": "inline",
      "width": 320,
      "height": 240
    }
  ]
}
```

### 7.2 存储位置

`cards.content_metadata` 字段（TEXT/JSON 列），随 `INSERT` 入库。不新增表、不修改表结构。

### 7.3 写入时机

`image_rewrite.py` 的 `rewrite_card()` 方法在物化图片到 `assets/` 时：
1. 从 `assets/` 复制后的目标文件用 PIL 读取 `width`/`height`
2. 写入 `content_metadata.images[]` 的各条目

### 7.4 多图卡片

同一个卡片包含多张图片时，每张图片独立记录在 `content_metadata.images[]` 数组中，按下标顺序对应 Markdown content 中 `![](路径)` 的出现顺序。

---

## 8. 前端渲染

### 8.1 技术选型（已调研验证）

2026-07-29 完成技术调研（见 `tools/md/test-render.html`），验证以下方案可行：

| 技术 | 用途 | 验证结果 |
|---|---|---|
| `react-markdown` | Markdown → React 组件 | ✅ 6 个检查全通过 |
| `remark-math` | 识别 `$...$` / `$$...$$` | ✅ |
| `rehype-katex` | LaTeX → HTML | ✅ 行内+块级公式正确渲染 |
| 自定义 `<img>` 组件 | 图片 URL 拼接 + 宽高注入 | ✅ 从 content_metadata 匹配成功 |

### 8.2 实现方案

```tsx
// 自定义图片渲染器
function TextbookImg({ src, alt }: { src?: string; alt?: string }) {
  // 1. 在 content_metadata.images[] 中按 url 匹配当前图片
  const meta = contentMetadata?.images?.find(
    (img: ImageMeta) => img.url === src
  );
  // 2. 拼接 ASSET_BASE_URL 得到完整 URL
  const fullSrc = src ? `${ASSET_BASE_URL}/${src}` : '';
  return (
    <img
      src={fullSrc}
      alt={alt || ''}
      width={meta?.width}
      height={meta?.height}
      crossOrigin="anonymous"
      style={{ maxWidth: '100%', height: 'auto', display: 'block' }}
    />
  );
}

// 使用
<ReactMarkdown
  components={{ img: TextbookImg }}
  remarkPlugins={[remarkMath]}
  rehypePlugins={[rehypeKatex]}
>
  {card.content}
</ReactMarkdown>
```

### 8.3 纯图卡片渲染

纯图卡（情况 A）的 content 为 `![](path)`，渲染时：
- 图片来源：`content_metadata.images[0]` 的宽高
- CSS：`object-fit: contain` + `max-width: 100%` + `max-height: 100%`，等比缩放至卡片容器可承载的空间

### 8.4 图文混排渲染

图片在 Markdown 中为块级元素（独占一行），文字另起行流式排布，与 Python splitter 的折算字数计算逻辑一致。

### 8.5 前端新增类型定义

```typescript
// types/index.ts
interface ImageMeta {
  url: string;
  alt?: string;
  position: 'inline';
  width: number;   // 新增
  height: number;   // 新增
}

interface CardContent {
  id: number;
  lesson_id: number;
  sort_order: number;
  card_type: 'concept' | 'example' | 'practice' | 'explore' | 'summary' | 'reading';
  title?: string;
  content: string;                    // Markdown 文本
  content_metadata?: {                // 新增
    images: ImageMeta[];
  };
  knowledge_point_ids?: string[];
  textbook_page?: string;
}
```

### 8.6 依赖确认

已存在于 `apps/web/package.json`：
- `katex: ^0.16.11` — 已安装但未接线，`rehype-katex` 可直接使用

需新增：
- `react-markdown` — Markdown → React 组件
- `remark-math` — LaTeX 公式识别
- `rehype-katex` — KaTeX 渲染

---

## 9. 文件变更清单

### 新增

| 文件 | 职责 |
|---|---|
| `tools/data-refinery/src/image_scan.py` | 扫描 MD 中图片引用，PIL 读尺寸，计算折算字数 |
| `tools/data-refinery/src/card_splitter.py` | Python 程序：按 400 字上限拆分卡片，内容不动 |
| `tools/data-refinery/src/card_labeler.py` | 调用 LLM，仅标注 card_type/lesson_id/title |

### 修改

| 文件 | 变更 |
|---|---|
| `tools/data-refinery/src/models.py` | 新增 `ImageInfo`、`CardFragment` 数据类 |
| `tools/data-refinery/src/extract_cli.py` | 引入 image_scan + card_splitter + card_labeler，替换旧 extract |
| `tools/data-refinery/src/extract.py` | 改为轻量 LLM 标注模式 |
| `tools/data-refinery/src/image_rewrite.py` | `rewrite_card` 写入宽高到 `content_metadata.images[]` |
| `tools/data-refinery/src/prompts/textbook_cards.txt` | 重写为标注专用 prompt |
| `apps/web/style.md` | 记录统一字号 16px + 行高 1.6 + 46 字/行 |
| `apps/web/src/styles/global.css` | 更新 `--fs-textbook` 和 `--lh-textbook` 为统一值 |

### 不变

| 文件 | 原因 |
|---|---|
| `tools/data-refinery/src/scanner.py` | 扫描逻辑不变 |
| `tools/data-refinery/src/convert.py / convert_cli.py` | MinerU 调用不变 |
| `tools/data-refinery/src/publish_cli.py` | publish 流程不变 |
| `tools/data-refinery/src/db_loader.py` / `db_loader_cli.py` | DB 入库不变 |
| `tools/db/schema.sql` | 无 schema 变更 |
| `tools/data-refinery/src/config.py` | 配置不变 |
| `tools/data-refinery/src/asset_store.py` | 存储接口不变 |

---

## 10. 后续 Plan 范围

本设计文档完成后，将产生两个 implementation plan：

- **Plan A**：data-refinery 管线改造（image_scan、card_splitter、card_labeler、image_rewrite 宽高写入）
- **Plan B**：前端 Markdown 渲染 + 图片宽高注入（后续单独推进）
