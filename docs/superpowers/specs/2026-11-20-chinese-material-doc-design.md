# 语文材料文档化设计（material_url / material_text 职责分离）

**日期**：2026-11-20
**状态**：已批准（2026-11-20）；实施计划见 `docs/superpowers/plans/2026-11-20-chinese-material-doc.md`
**范围**：语文（chinese）题库；物化/道法本期不动
**试点卷**：2026 北京市第八中学 初三 期中（DB paper 667）

---

## 1. 背景与目标

`questions` 表本来就有两列：

| 列 | 原设计语义 | 当前实际 |
|---|---|---|
| `material_text` | **题中素材**（题干内部自带的短材料） | 被当成「本节共享文章」的存放处，整篇复制给同节每道子题 |
| `material_url` | **文章文件地址**（长材料/音频，相对路径） | 全库 0 行有值（死列） |

实测（2026-11-20）：

- 语文 908 题，`material_text` 非空 783 题；`material_url` 非空 0 题。
- 同一段文章常被 2–6 道子题各存一份，最长 2581 字；改一个字就断组。
- 八中卷 12–14 题共享《醉翁亭记》，三题各存 555 字同一份；14 题又把《沧浪亭记》节选塞在 `content` 里。

目标：

1. 文章只在文件系统存一份 markdown，`material_url` 指向它；同节每题存同一个 URL。
2. `material_text` 只放「题号之内、这道题自己带的补充材料」。
3. 判题/解析/前端/PDF 仍能拿到完整文章。
4. 存量语文数据可一次性迁移，物化不动。

---

## 2. 判定规则（纯结构，不按长度猜）

对切题器产出的 `material_text`（本节共享材料）和 `content`（题干）分别处理：

| 来源 | 判定 | 去向 |
|---|---|---|
| **题号之前**、本节共享的阅读对象 | 只要去标题/页码/图片后仍有实质文字 | **文章** → md 文档 + `material_url` |
| **题号之内**、题干自己带的补充材料 | 命中「联系/阅读/结合…下面材料」、`【链接材料】`、`材料:` 等引导语 | **题中素材** → `material_text` |
| 只有小节标题（如 `## (一)默写。(共4分)`） | 去标题后无正文 | 丢弃（两列都 NULL） |

**不按长度分流**。短到 55 字的大题导语也进 md；长到 2500 字的文章当然也进 md。理由：

- 长度阈值会让同一篇材料在不同卷里落到不同列，语义不稳。
- 短导语若进 `material_text`，14 题那种「文章 + 题内材料」的渲染顺序会乱（导语会跑到文章与题干之间）。

### 2.1 八中卷实证（1–8 题）

| 题 | 现有 `material_text` | 新去向 |
|---|---|---|
| 1 | 55 字「故宫博物院…完善展板内容。」 | 短文档 `{k1}`（用户裁决 A：只挂 1 题，保持现状） |
| 2、3 | `## 前言` + 1 段 | 同一份 `{k2}` |
| 4 | `## 展板一：典则初立·法度恢弘` + 1 段 | `{k3}` |
| 5、6 | `## 展板二：承唐启宋·诸家鼎峙` + 2 段 | 同一份 `{k4}` |
| 7、8 | `## 展板三：南渡新韵·简逸空灵` + 1 段 | 同一份 `{k5}`，取 7 题带 `<u>` 的版本 |

1–8 题 `material_text` 全部为 NULL；9 题的 `## (一)默写。(共4分)` 丢弃。

### 2.2 12–14 题（文章 + 题内材料并存）

- 共享文章 = `## 醉翁亭记` + 欧阳修 + 四段正文 → `{k6}`，12/13/14 三题同 URL。卷面小节指令 `## (三)阅读下面《醉翁亭记》，完成 12-14题（共7分）` 不进文档（含题号/分值，换卷就变）。
- 14 题题内材料 = `联系《醉翁亭记》及下面材料…` + `予以罪废①…（取材于苏舜钦《沧浪亭记》）` + `注：①…⑥…` + `欧阳修与苏舜钦…不同。` → `material_text`。
- 14 题 `content` = `苏舜钦在沧浪亭中时而放声高歌…在于 ③`。

渲染顺序：文章（URL）→ `material_text` → 题干。

### 2.3 同一篇文章的标注变体

同一节各题拿到的文章可能因「画线/加点」标注不同而文本不同。实测八中 19–22 题：

- 20/21 题版本含 `<u>还好</u>`、`<span class="cn-emphasis-dot">…</span>`，2346 字；
- 19/22 题版本只有 `<sub>．．</sub>`，1949 字。

规则：**取标注最全的版本**（标注标签数量最多；持平取最长）作为唯一正文。文档只写一份，所有子题共用。这样也修掉「20 题问画线处，19 题却看不到画线」的旧问题。

---

## 3. 文档与数据形态

### 3.1 目录与命名

```
output/assets/materials/chinese/{doc_key}/
├── content.md          # 文章正文（canonical 版本）
├── fig_01.jpg          # 文章内图片（按出现顺序）
└── fig_02.png
```

- `doc_key = sha256(normalize(doc_body) + "\n" + "\n".join(sorted(image_sha256)))[:12]`
- `normalize`：去掉 `<u>` / `<span class="cn-emphasis-dot">` / `<sub>` 等标注标签（保留标签内文字）、统一空白、去掉图片 URL 前缀。这样**只改标注不会换 URL / 换题目身份**。
- **图片内容哈希一并入 key**：文字相同但配图不同的两篇文章不能共用 key（否则后写的会覆盖先写的）。`image_sha256` 取文档引用图片的 sha256，按排序后拼接。
- **正文去掉卷面小节指令**：`## (三)阅读下面《醉翁亭记》，完成 12-14题（共7分）` 含卷面题号/分值，不属于文章，写 md 前删掉；正文从文章标题（`## 醉翁亭记`）或第一段开始。否则同一篇文章换一张卷 `doc_key` 就变，跨卷去重失效。识别式：`^#{1,6}\s*.*(阅读|阅读下面|阅读下文).{0,20}完成.{0,10}[题0-9]`。
- `material_url = materials/chinese/{doc_key}/content.md`（相对路径，前端 `resolveAsset` 补 `/assets/`）。
- md 内图片引用改成根相对路径：`materials/chinese/{doc_key}/fig_01.jpg`。现有 `resolveAsset` 已能把相对路径补成 `/assets/...`。
- 相同文章在别的卷再次出现 → 同一份文字 + 同一组图片 → 同一个 `doc_key`，天然去重。

### 3.2 `material_text` 的注释块

14 题的注释按下面的形式落库（`material_text` 内单独一行）：

```markdown
注：①罪废：因获罪被罢官 ②崇阜：高山 … ⑥磨戛（jiá）：摩擦碰撞欧阳修与苏舜钦同处贬谪之境，都借山水安顿身心，但“乐”的内涵不同。
```

按用户 2026-11-20 的原话，这条 `注：…不同。` 整行都算注释，渲染成**灰色小字**；`content` 从「苏舜钦在沧浪亭中…」开始。切分器在最后一个 ①–⑳ 条目之后的第一个 `。` 处切，`注：` 之前另起一行。

前端 `preprocessMaterialMarkdown` 把以 `注：` / `注释：` / `【注】` 开头的整行包成 `<p class="cn-material-note">…</p>`，CSS 定义为**灰色小字**（12px，`var(--text-tertiary)`，行高 1.6）。不改正文里其他 `注` 字。

### 3.3 数据库

不新增表、不新增列：

| 列 | 新语义 |
|---|---|
| `material_url` | 文章 md 相对路径；同节每题相同；题中素材题为 NULL |
| `material_text` | 题中素材；文章题为 NULL |
| `material_method` | 题中素材的抽取方式（`rule`/`llm`/`manual`）；文章题为 NULL |

---

## 4. 数据管线改动

### 4.1 新导入（extract → publish）

为不打断现有切题/标注链路，**文章外置放在 publish 阶段**（此处能拿到整卷所有题、源 md 图片目录、`source_key`）。顺序不能反：必须先记住文章，再切题内材料，否则 14 题的文章会被题内材料覆盖。

1. **先记文章**：对每道题的 `material_text` 做**归一化分组**（§3.1 的 normalize + 把 `questions/chinese/{src8}/{idx}/` 里的 idx 抹平），同组 = 同一篇共享文章；每组选 canonical 版本暂存。
2. **再切题内材料**：对每条语文题跑 §4.3 **规则**（publish 不调 LLM）；命中则记下 `inline_material`，并用剩余部分替换 `content`。规则切不动的记入 `output/material_inline_review.jsonl`，由单独的 CLI 补切，不阻塞 publish。
3. **回填**：组内每题 `material_url = materials/chinese/{doc_key}/content.md`；若该题有 `inline_material`，`material_text = inline_material`、`material_method = 'rule'`，否则 `material_text = NULL`、`material_method = NULL`。
4. 每组写 `materials/chinese/{doc_key}/content.md`，图片物化到同目录并改写引用。
5. 只有标题/页码的组：不写文档、不设 `material_url`；`material_text` 仍按第 3 步（该题若有题内材料则保留）。
6. 题内材料（`inline_material`）走原有 `rewrite_item` 物化。
7. `PUBLISH_VERSION` 升到 3（规则变化，旧产物自动重发）。

新增/修改文件：

- `tools/data-refinery/src/publish_cli.py`：分组、写 md、回填 URL
- `tools/data-refinery/src/chinese_material_doc.py`（新）：normalize / 选 canonical / 写 md / 命名
- `tools/data-refinery/src/chinese_inline_material_cli.py`（后续）：读 review 清单，LLM 判切点 + 人工确认，结果写回 extracted JSONL / DB。本期只落 `output/material_inline_review.jsonl`，不实现该 CLI。
- `tools/data-refinery/src/image_rewrite.py`：`_CANONICAL_PREFIXES` 增加 `materials/` **和 `material/`**（后者是物化回填已有的单数目录，漏了会在重发布时报“未物化”）
- `tools/data-refinery/src/db_loader.py`：`_CANONICAL_IMG_PREFIXES` 同样加 `materials/` 与 `material/`

### 4.2 存量回填（只语文）

新增 `tools/db/material_doc_backfill.py`，**直接读 DB**（不重跑 extract，避免覆盖人工修题）：

1. 按 **`paper_questions.paper_id`** 取卷（没有 paper 的题才退回 `source` 分组），对 `material_text` 做与 publish 相同的归一化分组，**先把每组 canonical 文章暂存**。
2. 对每条题跑 §4.3 **规则**（回填不调 LLM）；命中则记下 `inline_material`，剩余部分写回 `content`。
3. 每组写 `output/assets/materials/chinese/{doc_key}/content.md`；图片按 `material_text` 里已有的 `questions/chinese/...` 路径复制到文档目录并改写。
4. 组内 `UPDATE questions SET material_url=..., material_text=<inline_material 或 NULL>, material_method=<'rule' 或 NULL>`；只有标题/页码的组 `material_url=NULL`、不写文件。
5. 重算 `content_hash`（§4.4）；**逐行 catch `ER_DUP_ENTRY`**，冲突行回退旧 hash 并记入报告，不能整批失败。
6. 幂等：已有 `material_url` 且文件存在则跳过；dry-run 打印将改行数；写 `backup/YYYYMMDD_material_doc_rollback.sql`（还原 material_text/material_url/material_method/content/content_hash）。

### 4.3 题内材料切分（14 题形态）

新增 `tools/data-refinery/src/subject_strategies/chinese_inline_material.py`：

```
split_inline_material(content) -> (material_text | None, rest)
```

规则优先级：

1. 命中 `【链接材料】` / `材料:` 标记：从标记起到下一个空行段落止。
2. 命中 `注：` + ①–⑳ 条目：`material_text` = 引导语 + 材料正文 + `注：…` 注释行（含其后的过渡句，整行灰色）；**切点 = 最后一个 ①–⑳ 条目之后的第一个 `。`**，`content` 从该句号之后开始（八中 14 题即 `material_text` 以「…不同。」结尾，`content` 以「苏舜钦在沧浪亭中…」开头）。`注：` 之前插一个换行，让注释独占一行。
3. 命中「联系/阅读/结合/参考 … 下面/上述/以下 … 材料/语段/文字/短文/文章」引导语，且后面有独立材料段：材料 = 引导语到答题段之前；答题段 = 以 `结合/根据/请/谈谈/说说/分析/概括/说明` 开头且含完整句子的最后一段。

**publish / backfill 只跑上面三条规则，不调 LLM。** 规则切不动且 `len(content) >= 200`、有引导语的题，写入 `output/material_inline_review.jsonl`；由 `chinese_inline_material_cli.py` 单独跑 LLM（只判「切在第几行」，按原文切片）和人工确认，结果回写 extracted JSONL / DB。这样 publish 保持离线、确定性。

自校验：`material + rest == content`，**比较前先归一空白**（注与过渡句之间插的展示换行不算原文差异）。不成立即不切。

本期先覆盖八中 14 题这一例（规则 2 可确定性切分）+ 规则明确的若干例；全量 15 道待审题跑规则，失败的进 review 清单，不在 publish 里硬猜。

### 4.4 `content_hash` 口径

文章移出后，`material_text` 变 NULL，原「材料头中尾指纹」会丢失，同题干跨卷可能撞 `uniq_q_content_hash`。改为：

```
material_fingerprint_input = (material_url or "") + "\n" + (material_text or "")
```

即文章 URL 与题中素材**一起**入指纹（只用其一都会漏掉另一半上下文）。`doc_key` 已对标注归一，URL 稳定；只改画线/加点不会换题目身份。

`material_fingerprint` 内部会 `normalize_content`（去全部空白），所以空字符串/只有 `\n` 的输入归一后仍为空 —— **无材料题、纯 `material_text` 题的旧 hash 不变**，只有文章题（`material_url` 有值）的 hash 会重算。

迁移时重算受影响行；若新 hash 与现有行冲突：

- 同卷同题（`paper_questions` 已定位）→ 原址更新；
- 跨卷同题 → 沿用 db_loader 现有的 `_reusable_question` 复用逻辑，并打印告警；
- 无法自动决定的行保持旧 hash 并记入回填报告，不阻塞整批。

---

## 5. 服务端改动

### 5.1 接口

所有题目载荷增加 `materialUrl: string | null`，`materialText` 保留为题中素材：

- `training.service.ts`（专项练习下发）
- `training/history-practice.service.ts`
- `exams.service.ts` + `exam-papers.repo.ts` + `exam-sessions.repo.ts`
- `practice-history/practice-history.service.ts`
- 对应 DTO：`session-create.dto.ts`、`paper-query.dto.ts`、`practice-history.dto.ts`

**不新增 `materialDoc` 字段**。文章正文的入口就是 `materialUrl`，由前端按 URL 取文件。

**契约文档同步（项目硬规则）**：

- `docs/API接口与数据流设计文档.md`：所有题目载荷的字段表加 `materialUrl`；
- `docs/api/openapi.yaml`：对应 schema 加 `materialUrl`；
- `docs/K12智学系统-数据库设计文档.md` §「材料字段使用说明」：把「第一题存材料、后续留空」改为「文章题每题存同一 `material_url`，`material_text` 只放题中素材」，并补 §9 `materials/` 目录说明。

前端 `apps/web/src/services/api.ts` 里四处 `materialText: string | null`（`TrainingRunQuestion` / `ExamQuestion` / `PracticeHistoryQuestion` 等）同步加 `materialUrl: string | null`；`components/business/answer/types.ts`、`AnswerModal.tsx` 的 `PracticeQuestion` 也加。

### 5.2 判题 / 解析

新增 `apps/server/src/modules/practice/material-doc.service.ts`：

```
getText(materialUrl): Promise<string | null>
```

- 相对路径 → `path.resolve(assetsDir, materialUrl)`，**必须校验仍在 assetsDir 内**（拒绝 `../` 穿越）；按 mtime 缓存；
- **服务端只读相对路径**。`http(s)://` 不在服务端 fetch（避免 SSRF），整串原样交给前端取；
- 读不到 → 返回 null + `logger.warn`，**永不抛到请求链路**。

`judge-core.service.ts`（两处）与 `explanation-cache.service.ts`：

```
material = [docText, q.material_text].filter(Boolean).join('\n\n') || null
```

保持「无材料时 prompt 逐字不变」的既有回归钉子。

### 5.3 静态资源

`main.ts` 已把 `tools/data-refinery/output/assets` 挂到 `/assets/`，`materials/` 直接可用，无需新增路由。

---

## 6. 前端改动

### 6.1 取文

新增 `apps/web/src/hooks/useMaterialDoc.ts`：

- `fetch(resolveAsset(url))`，模块级 `Map<string, Promise<string>>` 缓存；
- 返回 `{ text, status: 'loading'|'ready'|'error' }`；
- unmount abort；
- 错误展示一行可点「重试」，不渲染空块。

### 6.2 渲染

四处统一（新增 `MaterialBlock` 小组件）：

1. `QuestionRunner.tsx`（作答页）
2. `AnswerResultList.tsx`（结果页）
3. `PracticeHistoryDetailPage.tsx`（历史回放）
4. `components/business/print/PrintPaper.tsx`（PDF）

顺序：`materialUrl` 文档正文 → `materialText` → 题干。`materialText` 为空时跳过；两者都空不渲染材料区。

样式沿用现有 `data-testid="question-material"`：浅底、理科 38vh 可滚动、结果页/历史 32vh；**不折叠**。

### 6.3 注释灰色小字

`preprocessMaterialMarkdown` 增加一条：整行以 `注：` / `注释：` / `【注】` 开头 → 输出 `<p class="cn-material-note">…</p>`。`global.css` 增加：

```css
.cn-material-note {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-tertiary);
}
```

### 6.4 打印

`usePdfPrint` 目前只等图片。增加：**打开预览前**先把页面里所有 `materialUrl` 拉进模块级缓存（`Promise.all`，3s 超时也继续），`PrintPaper` 从缓存**同步**读正文（缓存缺失才显示占位）。不能等 `window.print()` 时再拉——预览本身就要显示文章。超时/失败时宁可缺材料也不让打印按钮卡死。

`PrintPaper` 的「相邻同材料只印一次」比较键从 `material` 文本改为 `materialUrl + materialText`（文章题只比 URL，题中素材题只比 text）。

---

## 7. 八中卷试点（先做这个，再写全量单测）

对象：DB paper 667（26 题）。

1. 跑 `python3 tools/db/material_doc_backfill.py --paper 667`（dry-run）→ 核对将改行数。
2. 加 `--apply` 落库。
3. 断言：

| 题 | 期望 |
|---|---|
| 1 | `material_url=k1`，`material_text IS NULL` |
| 2、3 | `material_url` 相同（k2） |
| 4 | k3 |
| 5、6 | k4 相同 |
| 7、8 | k5 相同；md 内含 `<u>人们在…</u>` |
| 9 | 两列 NULL |
| 12、13、14 | k6 相同；文件正文含四段《醉翁亭记》；首行是「## 醉翁亭记」，**不含**「阅读下面…完成 12-14题」 |
| 14 | `material_text` 含《沧浪亭记》+ `注：…`；`content` 以「苏舜钦在沧浪亭中」开头；`material_method='rule'` |
| 16–18、19–22、23–25 | 各一组，19–22 取含标注的 canonical |

4. `ls output/assets/materials/chinese/{k}/`：`content.md` 存在，图片引用可解析。
5. 起后端 + 前端，打开 paper 667 的作答页与结果页：
   - 12 题先看到《醉翁亭记》，再看到题干；
   - 14 题依次看到《醉翁亭记》→《沧浪亭记》→ 注（灰色小字）→ 题干；
   - PDF 导出含文章且不重复。
6. 通过后再跑全量语文回填 + 单元测试。

---

## 8. 测试清单

**Python**
- `test_chinese_material_doc.py`（新）：normalize / doc_key 稳定性（只改标注不换 key；文字同、图不同要换 key）/ 卷面小节指令剔除 / canonical 选择 / 标题-only 丢弃 / 八中 1–8 与 12–14 分组。
- `test_chinese_inline_material.py`（新）：14 题切分、`material + rest == content`（空白归一）、无引导语零变化、`注` 切点（最后一个 ①–⑳ 后第一个 `。`）。
- `test_publish_cli.py`：新导入写 md、`material_url` 回填、`materials/` 与 `material/` 白名单、publish 不触发 LLM。
- `test_db_loader.py`：`material_url` 写入/同卷更新、hash 口径、`materials/` 物化校验。
- `test_material_doc_backfill.py`（新）：按 `paper_id` 分组、幂等、dry-run、`ER_DUP_ENTRY` 回退、回滚 SQL。

**Server**
- `exam-papers.repo.test.ts` / `exams.service.test.ts`：SQL 含 `material_url AS materialUrl`，白名单键增加。
- `training.service.test.ts`：序列化键从 7 个变 8 个（`materialUrl`）。
- `material-doc.service.test.ts`（新）：相对路径读文件、缺失返回 null、缓存。
- `judge-core` / `explanation-cache`：有 URL 时 prompt 含文章，无材料时逐字不变。

**Web**
- `useMaterialDoc.test.ts`（新）：加载/缓存/失败重试。
- `QuestionRunner.test.tsx` / `AnswerResultList.test.tsx` / `PracticeHistoryDetailPage.test.tsx`：文章 + 题中素材 + 题干顺序。
- `markdown.test.tsx`：`注：` 行输出 `cn-material-note`。
- `PrintPaper.test.tsx`：同 URL 只印一次、14 题两块材料都印。

---

## 9. 风险与回滚

| 风险 | 缓解 |
|---|---|
| `content_hash` 重算冲突 | 同卷原址更新；跨卷复用并告警；失败行保留旧 hash 写报告 |
| 人工修题只改了 DB、未回写 extracted | 存量回填**只读 DB**，不重跑 extract |
| 标注变体选错，丢画线 | 取标注最多版本；试点人工核对 19–22 |
| 文档图片 404 | 物化到 `materials/{doc_key}/`；`image_rewrite` / `db_loader` 白名单加 `materials/` |
| 前端 fetch 失败导致空白 | 显示「材料加载失败 / 重试」；判题侧读不到只 warn |
| PDF 打印时文章未加载 | 打印前预加载，3s 超时继续 |
| 迁移把 `material_text` 置空后无法回退 | 先写 rollback SQL（含 content/material_text/material_method/material_url/content_hash） |
| 文章文字修正后 `doc_key` 变化，旧 md 变孤儿 | 本期不自动删；回填报告列出孤儿文件，人工确认后再清理 |
| `material_url` 含 `../` 越权读文件 | `MaterialDocService` resolve 后校验仍在 assetsDir 内；服务端不 fetch 绝对 URL |

---

## 10. 明确不做

- 不新增 `materialDoc` 接口字段；URL 即取文入口。
- 不新增 `question_materials` 表；不引入 OSS（本地静态目录 / `/assets/` 足够）。
- 不动物理/化学/道法的 `material_text`（它们是题内材料，语义本来就对）。
- 不做「同组只在第一题显示材料」；保持每题都显示（打印去重）。
- 不折叠材料区。

## 11. 决策记录

| # | 决策点 | 裁决 |
|---|---|---|
| 1 | 文章 vs 题中素材 | 纯结构：题号前共享材料 → md；题号内材料 → `material_text` |
| 2 | 1 题 55 字大题导语 | **A：保持现状，只挂 1 题**（做成短文档） |
| 3 | 前端取文 | 按 `material_url` 取文件，不新增 `materialDoc` |
| 4 | 迁移范围 | 先语文 783 题；物化不动 |
| 5 | 试点 | 先八中 paper 667，通过后再全量 + 单测 |
