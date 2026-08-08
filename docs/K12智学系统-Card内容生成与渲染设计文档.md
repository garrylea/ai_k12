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

正文统一使用 **16px 字号 + 1.6 行高**，卡片标题 **18px**。尺寸以 rem 表达，随根字号
`clamp(14px, 0.234vw + 12px, 21px)` 流式缩放（style.md §3）；下表 px 为 @根字号16px 的等效值。
因文字列宽（46rem）与字号（rem）同步缩放，**「46 汉字/行、700 字上限」在 iPad 与 PC 上渲染一致**。

| 项 | 值 | 来源 |
|---|---|---|
| iPad 横屏宽度（最紧断点） | 1024px | iPad 横屏基准 |
| 侧边导航 StudentNav | 224px | `w-56` = 14rem × 16 |
| 内容区宽度 | 800px | 1024 − 224 |
| 卡片内边距 | 64px | `px-8` |
| 文字区宽度 | **736px = 46rem** | 800 − 64 |
| 图片有效宽度（含留边） | **700px** | 736 − 18×2 |
| 正文字号 | **16px = 1rem** | 所有学段统一 |
| 卡片标题字号 | **18px = 1.125rem** | 所有学段统一 |
| 统一行高系数 | **1.6** | 所有学段统一 |
| 行盒总高 | **25.6px** | 16 × 1.6 |
| 每行汉字数 | **46** | 736 ÷ 16 |
| 无滚动可用正文行数 | **~19 行** | 768高屏：卡片撑满 header/footer 间，减标题块后 body ≈ 499px ÷ 25.6 |
| 单卡字数上限 | **700** | 46 × 19 ≈ 874 物理上限，留 ~15% 余量（标题/标签/公式）→ 700，PRD §7.2 |
| 图片占卡 75% 阈值 | **525** | 700 × 0.75 |

**无滚动约束**：卡片高度由 `flex-1` 撑满 header/footer 之间（不写死），容量上限由最矮的
首发断点（iPad 横屏 768 高）决定。700 字在该断点也不出纵向滚动条；更高的 PC 屏留白更多。

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
情况 A：缩放后折算字数 ≥ 525
    → 图片独占一张卡，content = 纯图 ![](path)
    → 不计 700 字上限

情况 B：折算字数 < 525，但（折算字数 + 文字字数）> 700
    → 图文放同一张卡放不下，对图片做第二次等比缩小
    → 图可分配行数 m = floor((700 − 文字字数) / 46)
    → 目标高度 = m × 25.6，二次 scale = 目标高度 / 缩放后高度
    → 新折算字数 = m × 46，总字数 ≤ 700

情况 C：折算字数 < 525，且（折算字数 + 文字字数）≤ 700
    → 图文正常合并为一张卡
```

### 3.3 举例

| 场景 | 原始尺寸 | 宽度缩放后 | 折算字数 | 判断 | 结果 |
|---|---|---|---|---|---|
| 超大图 | 1000×500 | 700×350 | 644 | ≥525（A） | 独占卡 |
| 大图 | 1000×420 | 700×294 | 552 | ≥525（A） | 独占卡 |
| 中图+多文 | 500×200 | 500×200 | 368 | <525，(368+文字)>700（B） | 二次缩小 |
| 小图+少文 | 200×40 | 200×40 | 92 | <525，(92+文字)≤700（C） | 图文合并 |

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
- 全文 ≤ 700 字则整页一张卡
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
| — | card_splitter.py 页码标注过滤 | ✅ 已完成 |
| — | progress.service.ts 首章/首节解锁逻辑 | ✅ 已完成 |

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

---

## 9. 已知问题与修复记录

### 9.1 章综述卡片混入页码标注（2026-08-01 修复）

**问题描述：**
第二十一章"章综述"在 star-map 中显示 7 页，实际应为 3 页。MinerU 转换 P15 时，将页眉页码 `"3 第二十一章 一元二次方程"` 误识别为正文，被 `card_splitter` 拆分为一张 11 字卡片，进而被 LLM 标注归入章综述 lesson。

**根因：**
1. MinerU `mineru-open-api extract` 没有 `--drop-header`/`--drop-footer` 参数，依赖模型自动过滤，偶有漏网。
2. `card_splitter._split_paragraphs` 对双换行拆分时未过滤页码标注段落。

**核心算法 — 页码标注过滤：**

MinerU 输出的页眉/页码标注特征：行首为教材印刷页码数字，紧跟空格和章标题原文，无 Markdown 标记。例如：
```
3 第二十一章 一元二次方程
```

过滤规则设计为**精确匹配**，避免误杀正常短内容：
- **必须**以数字开头（页码）
- **必须**紧跟 `" 第N章 "` 格式（中文数字章号）
- **必须**后续有非空白字符（章节名）
- 正常标题如 `## 21.2.2 公式法`、`探究`、`练习` 均不匹配

```python
_PAGE_NUMBER_HEADER_RE = re.compile(r'^\d+\s+第[一二三四五六七八九十百零]+章\s+\S+.*$')

def _is_page_number_header(text: str) -> bool:
    return bool(_PAGE_NUMBER_HEADER_RE.match(text.strip()))
```

插入点：在 `_make_bundles` 中，段落拆分后、创建 bundle 前跳过匹配段落：
```python
for para in paragraphs:
    if _is_page_number_header(para):
        continue  # 跳过页码标注，不生成 bundle
    # ... 正常创建 bundle
```

全量验证：九年级上册 94 页中仅 page_015.md 包含此模式，无漏杀/误杀。

**修复后状态：**
- 第二十一章章综述卡片：7 张 → **3 张**
- P15-P20 错误归属的配方法/练习卡片已用 deepseek-v4-flash 重新标注，正确归入 `21.2.1 配方法` / `21.2.2 公式法` / `21.2.3 因式分解法`

### 9.2 progress 为空时 star-map 首章/首节点全部锁定（2026-08-01 修复）

**问题描述：**
当 `progress` 表没有学习记录时，学生进入 star-map 后所有章节均为 locked 状态，无法开始学习。

**根因：**
`apps/server/src/modules/progress/progress.service.ts` 第 104 行用 `unit.order === 1` 判断"第一个 unit"，但 `unit.order` 是数据库 `units.sort_order` 字段（教材章节号，如 21, 22, 23...），不是 1-based 数组索引，所以 `=== 1` 永远为 false。同理，第 126 行用 `lesson.order === 1` 判断第一节，忽略了 `sort_order=0` 的章综述。

**核心算法 — 章节/小节状态计算（三态机）：**

状态流转基于 `progress` 表中的 `current_unit_id` 和 `current_lesson_id`，分为三种状态：`completed`（已完成）、`current`（当前学习中）、`locked`（未解锁）。

**1. Unit（章）状态判断：**
```
if currentUnitId === null:
    // 无学习记录：数组第一个 unit 为 current
    unitStatus = (unitIndex === 0) ? 'current' : 'locked'
else if unit.id < currentUnitId:
    unitStatus = 'completed'
else if unit.id === currentUnitId:
    unitStatus = 'current'
else:
    unitStatus = 'locked'
```

**2. Lesson（小节）状态判断（在 current unit 内部）：**
```
if unitStatus === 'completed':
    lessonStatus = 'completed'
else if unitStatus === 'current':
    if currentLessonId === null:
        // 无进度记录：章综述（sort_order=0）为 current 入口
        lessonStatus = (lessonIndex === 0) ? 'current' : 'locked'
    else if lesson.id < currentLessonId:
        lessonStatus = 'completed'
    else if lesson.id === currentLessonId:
        lessonStatus = 'current'
    else:
        lessonStatus = 'locked'
else:
    lessonStatus = 'locked'
```

**关键设计决策：**
- 为什么章综述（`sort_order=0`）是 current 入口而非 `21.1`？
  - 教材阅读顺序：章综述（章前引入）→ 21.1 → 21.2 → ...
  - 章综述包含本章学习目标、引入性故事，应先读
- 为什么用 `unitIndex === 0` 而不是 `unit.order === 1`？
  - `sort_order` 是教材章节号（21, 22...），不是位置索引
  - 第一本书的第一章可能是 21（九年级上册从第21章开始）

**修复：**
```typescript
// 修复前（错误：unit.order 是 21/22/23，永远不等于 1）
unitStatus = unit.order === 1 ? 'current' : 'locked';
lessonStatus = lesson.order === 1 ? 'current' : 'locked';

// 修复后（正确：用数组索引判断位置）
unitStatus = unitIdx === 0 ? 'current' : 'locked';
lessonStatus = lessonIdx === 0 ? 'current' : 'locked';
```

### 9.3 章综述知识点数空数组误判为 1（待修复）

**问题描述：**
`cardsRepo.countKnowledgePointsByLessonId()` 将 JSON 字符串 `"[]"` 当作一个有效 ID 加入 Set，导致空知识点的卡片仍返回 `knowledgePointCount = 1`。

**核心算法 — 知识点计数（当前实现）：**

```typescript
async countKnowledgePointsByLessonId(lessonId: number): Promise<number> {
  const [rows] = await this.pool.execute(
    'SELECT knowledge_point_ids FROM cards WHERE lesson_id = ? AND knowledge_point_ids IS NOT NULL',
    [lessonId],
  );
  const kpSet = new Set<string>();
  for (const row of rows) {
    const ids = (row.knowledge_point_ids as string) || '';
    ids.split(',').map(id => id.trim()).filter(Boolean).forEach(id => kpSet.add(id));
  }
  return kpSet.size;
}
```

**根因：**
`ids.split(',')` 在 `"[]"` 上运行时产生 `['[', ']']`：
- `'['` → trim 后非空 → 被当作有效 ID 加入 Set
- `']'` → trim 后为空 → filter(Boolean) 过滤掉

结果：空数组 `"[]"` 被误判为包含 1 个知识点 `'['`。

**修复方向：**
在 `cards.repo.ts` 中增加 JSON 解析或特殊值识别。推荐方案：先尝试 `JSON.parse()` 解析，若为数组则展开处理，非数组才按逗号分割：

```typescript
const ids = (row.knowledge_point_ids as string) || '';
let idList: string[] = [];
try {
    const parsed = JSON.parse(ids);
    if (Array.isArray(parsed)) {
        idList = parsed;
    } else if (typeof parsed === 'string') {
        idList = [parsed];
    }
} catch {
    // 兜底：按逗号分割（兼容旧数据）
    idList = ids.split(',');
}
idList.map(id => id.trim()).filter(Boolean).forEach(id => kpSet.add(id));
```

### 9.4 card_splitter 同行题拆行（2026-08-08 已实施）

**问题**：`_split_paragraphs` 只按双换行拆段，`(1) $5x^{2}-1=4x$ ; (2) $4x^{2}=81$` 不拆，多题挤一行入库。前端 `preprocessContent` step 2.5 在运行时拆，但只覆盖 `;` 分隔案。

**修法**：
1. card_splitter 加 `_split_inline_questions()`——正则按 `(N)` 边界（前有 `;；。！？`）拆同行题，防 `与(2)类似` 误拆。正则使用消费式（非 lookbehind）避免拆分后残留分隔符。
2. db_loader 对 practice 卡用 labeler 的 `questions[].text` 重组 content 为每题独立一行（LLM 兜底正则拆不开的边缘案）。
3. 前端删除 `preprocessContent` step 2.5（管线已保证）。

实施日期：2026-08-08；card_splitter._split_inline_questions ✅ / db_loader.rebuild_practice_content ✅ / 前端 step 2.5 已删除 ✅

详见 `docs/superpowers/specs/2026-08-06-practice-answer-judging-design.md` §5.0/§5.2/§6.1。

### 9.5 practice 卡 content_metadata 分组结构（2026-08-08 已实施）

**问题**：原扁平结构 `{intro, questions:[{n,text}]}` 无法表达多题干练习卡--两个大题题干被塞进一个 `intro`，且跨大题题号 `n` 冲突（两组都有 1,2,3），前端 `practiceStore.answers` 用 `n` 做 key 会互相覆盖。

**新结构**（groups 数组）：
```json
{
  "groups": [
    { "intro": "1. 将下列方程化成一般形式：", "questions": [{"n":1,"text":"(1) $5x^2$"}, {"n":2,"text":"(2) $y^2$"}] },
    { "intro": "2. 根据下列问题列方程：", "questions": [{"n":1,"text":"(1) 4个正方形..."}] }
  ],
  "needs_fallback": false
}
```

**变更点**：
1. **labeler prompt**（`textbook_cards.txt`）：practice 卡输出 `groups` 数组，含正反例 + 醒目分组规则
2. **card_labeler.py**：`LabelResult.groups` 替代扁平 `intro`/`questions`；新增 `_split_groups_if_needed` 程序化兜底
3. **db_loader.py**：`build_content_metadata(groups, ...)` 逐 group 校验；`rebuild_practice_content(groups)` 重组 content
4. **前端**：`practiceMeta` 提取 groups 并展平为复合键 `"groupIdx-n"`；多组渲染每组 intro（加粗）+ 可点题块；`practiceStore.answers` 改为 `Record<string, AnswerRecord>`
5. **迁移脚本** `migrate_flat_to_groups.py`：一次性将旧扁平 metadata 包装为单 group

**程序化分组兜底**（`_split_groups_if_needed`）：
LLM 可能把多组题塞进一个 group。解析后检测两种场景并按原文位置自动拆分：
- Case 1（ID=442 模式）：intro 含多个编号大题 `^\d+[.、]` -> 按大题位置拆
- Case 2（ID=443 模式）：部分 question 在原文中出现在 intro 之前 -> 拆为无 intro 前组 + 有 intro 后组

**端到端验证标准**（以 ID=441/442/443 为基准）：
1. DB 中 practice 卡 `content` 每题独立成行（`\n\n` 分隔）
2. `content_metadata.groups` 正确分组（多题干卡有多个 group）
3. 前端渲染：每个 group 的 intro 加粗显示（`[&>*]:font-bold`），每道题为独立可点 button
4. 点击题目 -> 打开 AnswerModal -> 提交 -> 对错记录到 `practiceStore`（复合键）

**注意事项**：
- intro 以 `N.` 开头时 remarkGfm 解析为 `<ol><li>` 而非 `<p>`，CSS 选择器须用 `[&>*]` 而非 `[&>p]`
- `n` 在 DB metadata 中保持 `number`（组内题号），前端转为复合字符串键 `"groupIdx-n"`
- 旧数据迁移：`migrate_flat_to_groups.py` 将 `{intro, questions}` 包装为 `{groups: [{intro, questions}]}`（幂等）

详见 `docs/superpowers/specs/2026-08-06-practice-answer-judging-design.md` §5.1/§5.2/§6.1。
