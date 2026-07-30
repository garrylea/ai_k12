# Card 内容生成与渲染设计文档

**日期**：2026-07-29
**关联**：data-refinery 管线、前端渲染

---

## 1. 概述

将教材图片（MinerU 转换后的 Markdown）拆分为学习卡片，入库并渲染。

**核心原则**：Python 程序拆分卡片（内容一字不改），LLM 仅标注分类。

### 1.1 全链路

```
convert(MinerU) → image_scan → card_splitter → card_labeler(LLM)
  → publish(image_rewrite) → db_loader → MySQL → API → 前端 Markdown 渲染
```

---

## 2. 统一渲染基准

所有学段统一使用 **16px 字号 + 1.6 行高**。容器内容区宽度 736px，折合 46 汉字/行。

| 项 | 值 | 来源 |
|---|---|---|
| iPad 横屏宽度 | 1024px | iPad 横屏基准 |
| 侧边导航 StudentNav | 224px | `w-56` = 14rem × 16 |
| 内容区宽度 | 800px | 1024 − 224 |
| 卡片内边距 | 64px | `px-8` |
| 文字区宽度 | **736px** | 800 − 64 |
| 图片有效宽度（含留边） | **700px** | 736 − 18×2 |
| 统一字号 | **16px** | 所有学段统一 |
| 统一行高系数 | **1.6** | 所有学段统一 |
| 行盒总高 | **25.6px** | 16 × 1.6 |
| 每行汉字数 | **46** | 736 ÷ 16 |
| 单卡字数上限 | **400** | PRD §7.2 |
| 图片占卡 75% 阈值 | **300** | 400 × 0.75 |

---

## 3. 图片尺寸处理算法

### 3.1 折算字数公式

```
行盒总高 = 16px × 1.6 = 25.6px
图片折算字数 = ceil(图片高度px / 25.6) × 46
```

### 3.2 两步走流程

**第一步：宽度适配**

```
if 图片原始宽度 > 700:
    scale = 700 / 原始宽度
    缩放后宽度 = 700
    缩放后高度 = ceil(原始高度 × scale)
else:
    缩放后宽度 = 原始宽度
    缩放后高度 = 原始高度
```

宽度缩放是等比缩放。后续所有计算基于缩放后高度。

**第二步：高度判断（三种情况）**

```
情况 A：缩放后折算字数 ≥ 300
    → 图片独占一张卡，content = 纯图 ![](path)
    → 不计 400 字上限

情况 B：折算字数 < 300，但（折算字数 + 文字字数）> 400
    → 图文放同一张卡放不下，对图片做第二次等比缩小
    → 图可分配行数 m = floor((400 − 文字字数) / 46)
    → 目标高度 = m × 25.6，二次 scale = 目标高度 / 缩放后高度
    → 新折算字数 = m × 46，总字数 ≤ 400

情况 C：折算字数 < 300，且（折算字数 + 文字字数）≤ 400
    → 图文正常合并为一张卡
```

### 3.3 举例

| 场景 | 原始尺寸 | 宽度缩放后 | 折算字数 | 判断 | 结果 |
|---|---|---|---|---|---|
| 超大图 | 1000×500 | 700×350 | 644 | ≥300（A） | 独占卡 |
| 中等图 | 500×200 | 500×200 | 368 | ≥300（A） | 独占卡 |
| 小图+多文 | 400×60 | 400×60 | 138 | <300，超限（B） | 二次缩小 |
| 小图+少文 | 200×40 | 200×40 | 92 | <300，不超（C） | 图文合并 |

---

## 4. 图片尺寸存储

### 4.1 存储位置

`cards.content_metadata` 字段（TEXT/JSON 列），不新增表、不修改表结构。

### 4.2 结构

```json
{
  "images": [
    {
      "url": "textbooks/math/a1b2c3d4/page_08_fig_01.jpg",
      "alt": "雕像高度示意图",
      "position": "inline",
      "width": 400,
      "height": 300
    }
  ]
}
```

### 4.3 写入时机

`image_rewrite.py` 的 `rewrite_card()` 在物化图片到 `assets/` 时，从实际文件读取宽高并写入 `content_metadata.images[]`。

---

## 5. 前端 Markdown 渲染

### 5.1 技术选型（已调研验证）

| 技术 | 用途 | 验证 |
|---|---|---|
| `react-markdown` | Markdown → React 组件 | ✅ |
| `remark-math` | 识别 `$...$` / `$$...$$` | ✅ |
| `rehype-katex` | LaTeX → HTML | ✅ |
| 自定义 `<img>` 组件 | URL 拼接 + 宽高注入 | ✅ |

调研文件：`tools/md/test-render.html`

### 5.2 图片渲染

```tsx
function TextbookImg({ src, alt }: { src?: string; alt?: string }) {
  const meta = contentMetadata?.images?.find(img => img.url === src);
  const fullSrc = src ? `${ASSET_BASE_URL}/${src}` : '';
  return (
    <img
      src={fullSrc}
      alt={alt || ''}
      width={meta?.width}
      height={meta?.height}
      style={{ maxWidth: '100%', height: 'auto', display: 'block' }}
    />
  );
}

<ReactMarkdown
  components={{ img: TextbookImg }}
  remarkPlugins={[remarkMath]}
  rehypePlugins={[rehypeKatex]}
>
  {card.content}
</ReactMarkdown>
```

### 5.3 纯图卡片

纯图卡（情况 A）content 为 `![](path)`，渲染时 CSS：`object-fit: contain; max-width: 100%; max-height: 100%`，等比缩放至卡片容器可承载的空间。

### 5.4 图文混排

图片在 Markdown 中为块级元素（独占一行），文字另起行，与 Python splitter 的折算字数计算方式一致。

### 5.5 前端类型定义

```typescript
interface ImageMeta {
  url: string; alt?: string; position: 'inline';
  width: number; height: number;  // 新增
}

interface CardContent {
  id: number; lesson_id: number; sort_order: number;
  card_type: 'concept' | 'example' | 'practice' | 'explore' | 'summary' | 'reading';
  title?: string;
  content: string;  // Markdown 原文
  content_metadata?: { images: ImageMeta[] };
  knowledge_point_ids?: string[]; textbook_page?: string;
}
```

### 5.6 依赖

| 包 | 状态 |
|---|---|
| `katex: ^0.16.11` | 已安装，未接线 |
| `react-markdown` | 需新增 |
| `remark-math` | 需新增 |
| `rehype-katex` | 需新增 |

---

## 6. 管线模块设计

### 6.1 image_scan.py（新增）

- 输入：`page_NNN.md` 路径
- 扫描 `![](images/*.jpg)` 引用
- PIL 读取磁盘文件宽高
- 计算折算字数
- 输出：`List[ImageInfo]`

### 6.2 card_splitter.py（新增）

- 输入：MD 正文 + 图片清单
- 按 §3 算法处理宽度适配 + 高度判断
- 按自然段落（`\n\n`）切分，贪心合并
- 全文 ≤ 400 字则整页一张卡
- 超长段按句末标点切割
- 输出：`List[CardFragment]`，content 原封不动

### 6.3 card_labeler.py（新增）

- 输入：拆分后的卡片列表 + 跨页上下文
- 调用 LLM 标注：page_type / card_type / lesson_id / title / textbook_page
- 不碰 content
- 可批量处理多页（3-5 页一次）

### 6.4 extract_cli.py（改造）

- 引入 image_scan → card_splitter → card_labeler 流程
- 前置内容页由 labeler 标记后跳过

### 6.5 image_rewrite.py（增强）

- `rewrite_card()` 物化图片时从实际文件读取宽高
- 写入 `content_metadata.images[].width` 和 `height`

### 6.6 convert_cli.py（已完成断点续转）

- `--reconvert`：删除已有输出，从头重新转换
- `--force`：跳过 checkpoint，逐页检查 .md 断点续转
- 默认：checkpoint 标记完成的跳过
- MinerU 分批调用（10 张/批，间隔 15s）

### 6.7 checkpoint.py（已增强）

- 新增 `unmark_converted()` / `unmark_extracted()` / `unmark_published()`

---

## 7. 实施任务清单

| # | 任务 | 状态 |
|---|---|---|
| 1 | 前端样式统一 — 全局 16px/1.6 | 待实施 |
| 2 | image_scan.py 新建 | 待实施 |
| 3 | card_splitter.py 新建 | 待实施 |
| 4 | card_labeler.py 新建 + textbook_cards.txt 重写 | 待实施 |
| 5 | extract_cli.py 改造 | 待实施 |
| 6 | image_rewrite.py 增强（写入宽高） | 待实施 |
| 7 | models.py 新增 ImageInfo/CardFragment | 待实施 |
| 8 | 前端 types/index.ts 新增 ImageMeta/CardContent | 待实施 |
| — | convert_cli 断点续转 | ✅ 已完成 |
| — | checkpoint 增强 | ✅ 已完成 |

---

## 8. 文件变更汇总

### 新建

| 文件 | 职责 |
|---|---|
| `tools/data-refinery/src/image_scan.py` | 图片尺寸扫描 + 折算字数 |
| `tools/data-refinery/src/card_splitter.py` | Python 拆卡程序 |
| `tools/data-refinery/src/card_labeler.py` | LLM 标注 |

### 修改

| 文件 | 变更 |
|---|---|
| `tools/data-refinery/src/models.py` | 新增数据类 |
| `tools/data-refinery/src/extract_cli.py` | 新流程串联 |
| `tools/data-refinery/src/extract.py` | 轻量 LLM 标注 |
| `tools/data-refinery/src/image_rewrite.py` | 写入宽高 |
| `tools/data-refinery/src/prompts/textbook_cards.txt` | 标注专用 prompt |
| `tools/data-refinery/src/convert.py` / `convert_cli.py` | 已完成断点续转 |
| `tools/data-refinery/src/checkpoint.py` | 已完成增强 |
| `apps/web/style.md` | 记录统一 16px/1.6 |
| `apps/web/src/styles/global.css` | 统一教材字号行高 |
| `apps/web/src/types/index.ts` | 新增前端类型 |

### 不变

`scanner.py`、`publish_cli.py`、`db_loader.py/cli.py`、`schema.sql`、`config.py`、`asset_store.py`
