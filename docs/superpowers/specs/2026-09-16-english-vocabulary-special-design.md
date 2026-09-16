# 英语背单词专项 · 设计

日期：2026-09-16
状态：**后端 + 前端已实施**（内容管线未开工）
相关：`docs/api/openapi.yaml`（§4.18 / §6.22）、`tools/db/migrations/2026-09-16_english_vocabulary.sql`

---

## 1. 定位与边界

训练轨「**训练 → 英语 → 背单词**」是一个**独立子系统**，与语文古诗文专项同形论证。

**边界（勿泛化）**：自己的表、自己的端点（`/api/training/vocabulary/*`）、自己的页面。
**不挂 `questions`、不进错题本、不参与主线清零门禁、不用「不再展示」/提示缓存/自评。**

**判据**：作答单位是「词 / 义项」，标准答案是词条自带属性，不接主线、没有「重做—清零」的对象。
与语文那套的理由完全一致（PRD §6.3 / §7.4 例外）。

**与语文学科划界的区别**：这条只覆盖**背单词**。英语的试题类（试卷/真题）属正常题库业务，
作答单位是「题」、标准答案属题、错题要进错题本参与清零门禁，**仍走 `questions` 体系**，
复用、不另起一套。划界依据是**形态**（作答单位是「词」还是「题」），不是学科。

---

## 2. 定案清单

用户逐项裁决过，改这里之前先确认不是把某个刻意的决定「统一」掉了。

| # | 议题 | 结论 |
|---|---|---|
| 1 | 词库源 | **课标官方 PDF 附录**：义务教育英语课程标准（2022 年版）1600 词 + 普通高中英语课程标准（2017 年版 2020 年修订）3000 词。**不用百度文库/豆丁转载版**（实测有「内容可能由 AI 生成」的副本） |
| 2 | 分层 | 存**四层** `primary`(小学二级 505) / `junior`(初中三级 ~1095) / `senior_required`(必修 500) / `senior_elective`(选择性必修 1000)；页面只暴露「仅初中 / 仅高中 / 全部」三档，小学词并入初中池不单列 |
| 3 | 重叠词归属 | 两表都有的词 `level` 归 `junior`；「仅高中」= 3000 表中不在 1600 表中的词 |
| 4 | 熟词僻义练法 | 内嵌标记 + 配置页勾选「只出熟词僻义」，**不另开专项入口页** |
| 5 | 熟词僻义判题 | 英→中 + 语境提示锁定僻义，LLM 判**三档** `correct` / `off_target` / `wrong` |
| 6 | 进度 | 轻量（`learned` / `wrong_count` / `last_seen_at`），**不做艾宾浩斯排程** |
| 7 | 易错计数 | **两处都存**：词表 `error_count`（全局、只增） + 进度表 `wrong_count`（学生自己的、可清除） |
| 8 | 易错筛选 | 「易错词（全平台高频）」+「我错过的词」两个独立筛选项；「移除易错标记」只清学生自己的 |
| 9 | 异步判定 | **前端异步**（底部累积清单），后端单题同步。无 job 队列、无任务表 |
| 10 | 词根族存储 | **不建新表**。`root_key` 自关联 + `root_affixes` JSON |
| 11 | 词根族数据 | 我出草稿 + 程序硬校验 + 人工审一遍（`--extract` / `--load` 两阶段） |
| 12 | 词根族 UI | **就地展开缩进树**（点「+」号），不用放射图、不引图形库 |
| 13 | 词根族交付 | 独立懒加载端点 `GET .../words/{wordId}/family` |
| 14 | 答案是英文单词的方向（中→英、看音标写单词） | 纯程序比对 + 拼写变体组，**不调 LLM** |
| 16 | 出题方向 | 四个：`en2cn` 给单词 / `cn2en` 给中文 / **`ph2en` 看音标写单词** / `random` 逐题掷。`ph2en` 要求词有可用音标（`/`、`//` 算没有）否则退化成 en2cn 不丢词；熟词僻义题恒为 en2cn |
| 15 | LLM 场景 | 新增 `english_word_judge`：primary=`local`、fallback=`deepseek-flash` |

### 2.1 一处已知的口径瑕疵（保留，未修）

高中 3000 词表原文写「含义务教育阶段要求掌握的 **1500** 个单词」（引 2011 版课标），
而义务教育 2022 版是 **1600** 词。两版差约 100 词，所以「不在初中就标高中」这条规则
在那约 100 个词上会有歧义。

本设计的处理：**以 2022 版 1600 词为义务教育层，重叠词归 `junior`**。
代价是「仅高中」会漏掉那几个恰好落在高中表新增部分、却又在 2022 义务教育表里的词。
内容管线的 check 步骤要**打印这份歧义清单交人工裁决**（预期为空或极少），不自动决定。

---

## 3. 数据模型

### 3.1 `english_words`（内容表，**无外键**）

表即完整边界：不指向任何表，也不被任何表指向（进度表不反向约束它）。

关键列与理由：

- `word` —— 业务键（幂等 upsert 键），存官方原文大小写
- `level` —— 四层，见上
- `meanings` JSON —— 义项数组：
  ```json
  [{"pos":"n.","gloss":"地址","extended":false},
   {"pos":"v.","gloss":"处理；对付（问题）","extended":true,
    "context":"address the problem","note":"中高考阅读完型高频僻义"}]
  ```
  不变式：**至少有一个 `extended:false` 义项**；任一 `extended:true` 义项**必须有非空 `context`**
  （僻义题就是靠这个搭配出题的）。
- `has_extended_sense` —— 冗余列。存在理由只有一个：**MySQL 搜不了 JSON 里的布尔值**
  （`JSON_SEARCH` 只搜字符串、`JSON_CONTAINS` 走不了索引），而抽题池需要一条能走索引的 `WHERE`。
  一致性由内容管线 check 与仓储测试兜住。
- `root_key` / `root_affixes` —— 词根族，见 §3.3
- `error_count` —— **全平台**累计错次，只增。⚠️ 内容管线 loader 的
  `ON DUPLICATE KEY UPDATE` **必须显式排除这一列**，否则一次全量重灌会抹掉全平台的易错统计
  （同 `dictation_loader` 特意不更新 `memorize_required`/`is_active` 的理据）。

### 3.2 `student_word_progress`（本子系统唯一外键）

`student_id → students(id) ON DELETE CASCADE`（同 `practice_results`）。

`word_id` **故意不设外键**：内容表必须能被内容管线随时全量重灌，
入向外键会让 full-reload 的业务数据守卫与重灌互相卡死。

`learned` 单调（用 `GREATEST` 保证答对过就永远是 1），`wrong_count` 只增——
「移除易错标记」是另一条独立 `UPDATE` 只清它。

### 3.3 词根族为什么不建表

族的定义就是「`root_key` 指向同一个中心词」，中心词自己也填自己的 `word`
（这条不变式由管线 check 保证）。于是取全族就是一句：

```sql
SELECT ... FROM english_words WHERE root_key = ? AND verified = 1 AND is_active = 1
```

`care` / `careful` / `careless` / `carefully` 一次全出，点「+」号即可渲染。
**不规则派生**（`decide → decision`、`invent → invention`）也不破例：中心词是 `decide`
（词表内、已核对），成员 `decision` 的词缀注记写 `-sion（decide → decision，拼写有变化）`。

**族中心必须在词表内**这一点由管线硬校验保证 —— 这样永远不会出现 LLM 编造的词根。

**实现补充（2026-09-16，两条易踩的规则）**：
1. **必须上溯到真正的族根，不能只连「一级父节点」**。`interaction → action → act` 若只连一级，
   `action` 会**既是成员又是族中心**，而 `root_key` 只能有一个值 —— 族中心就会从自己的族里消失
   （族查询是 `WHERE root_key = ?`，前端族树又要求中心词在族人里）。做法：每个词沿父指针走到顶，
   词缀沿链累积（`interaction` → 根 `act`，词缀 `inter-` + `-ion`）。
2. **词缀读序**：前缀由外向内、后缀由内向外（`actively` 要显示 `-ive` + `-ly`，不是 `-ly` + `-ive`），
   上溯收集到的顺序是由内向外的，所以两边都要反转。

**族只在已核对词表内连边**，且**专名（大写开头的词）不参与构词分析** —— 否则会出现
`bad → Badal`（人名）这种把词根挂到专名上的荒谬边。`-er`/`-or` 后缀与前缀派生两类**必须逐条人工审**
（`career ≠ care+er`、`display ≠ dis+play`），脚本会给它们打 `_review` 标记，
审核结果固化在 `vocabulary_roots.py` 的 `EXCLUDE_EDGES` 里（每条带排除理由）。
代价是放弃「族级」属性（如给整个族写一句词根说明）；需要时二期加一个只放
`root_key` + `root_gloss` 两列的小表即可。

---

## 4. 判题口径

### 4.1 三条路由

| 题面 | 目标义项 | 路径 | 方式 |
|---|---|---|---|
| 中→英 / 看音标写单词（答案都是英文单词） | — | 归一化比对 `word` → 未命中查拼写变体组 | **纯程序**（`method:'exact'`），不调 LLM |
| 英→中 | 非僻义组 | 全部常见义 gloss 按 `；,、/` 拆原子归一化比对 → 未命中调 LLM | 程序短路 + LLM 二档 |
| 英→中 | 单个 `extended` 义项 | 与目标僻义义项原子比对 → 未命中调 LLM | 程序短路 + LLM **三档** |

### 4.2 计错口径（核心，勿「统一」掉）

规则唯一实现在 `apps/server/src/common/utils/normalize-english.util.ts` 的 `progressDelta`：

| verdict | `learned` | 学生 `wrong_count` | 全局 `error_count` |
|---|---|---|---|
| `correct` | 置 1 | — | — |
| `off_target` | — | — | — |
| `wrong` | — | +1 | +1 |
| `unanswered`（空作答/点「不认识」） | — | — | — |
| `undetermined`（判题失败） | — | — | — |

**`off_target` 是这一档存在的全部理由**：学生答「地址」而本题考「处理；对付」，
他答的没错、只是没答到考点，判错会让人觉得冤。`unanswered` 与 `undetermined` 同理不计错——
「不会」不等于「易错」，判题失败更不该让学生背锅。

### 4.3 程序短路为什么不宽松

短路口径是「**归一化后相等**」，**不是包含**。用包含会让「使用」命中「不使用」这类反义噪声。
宁可漏给 LLM 判，也不能错判对。

拼写变体走**人工整理的组表**，不做规则推导。收组门槛：**组内每个成员的含义必须完全相同**。
因此刻意排除 `storey/story`、`metre/meter`、`tyre/tire`、`kerb/curb`、`draught/draft`——
它们看着像英式/美式变体，但其中一个成员多出别的义项（story 多出「故事」、meter 多出「仪表」…），
收进来就会把错答案判对。代价是学生写美式拼写时会被判错；但这个方向（多判错）比「把错答案判对」安全。

连字符/空格的等价**只在正确答案本身含连字符或空格时生效**，否则 `a part` 会命中 `apart`。
**不剥撇号**：`its`/`it's`、`were`/`we're` 正是要抓的错。

---

## 5. 前端

### 5.1 两条防泄漏铁律

1. **凡是答案等于英文单词的题（`promptKind` 为 `cn2en` 或 `ph2en`），后端不下发**
   `word` / `phonetic` / `context` / `hasFamily`。`ph2en` 的音标只出现在 `prompt` 一处
   （`phonetic` 留 null，免得两处内容打架）。
   题面是中文释义、答案是英文单词——这四项每一项都足以顺出答案。
2. **「+」号只在 `promptKind === 'en2cn' && hasFamily` 时渲染**。
   词根族树里**必然包含单词本身**（`care` 是 `careful` 的族中心），
   中→英题点开 `+` 就等于把答案递给学生。后端在 cn2en / ph2en 题上本就不返回 `hasFamily`，
   这里是前端第二道闸门，并有专门的渲染钉子用例
   （`WordPromptCard.test.tsx`：中→英即使 `hasFamily=true` 也不得渲染按钮）。

### 5.2 异步判定落在前端，不在后端

后端 `judge` 是**单题同步**（服务端照常等 LLM），前端提交后**立刻翻到下一个词、不等它**，
结果回来再回填到底部累积清单。与古诗文解释页同构（同样的「送判但不 await」）。

这样不需要 job 队列或任务表；刷新即丢也可接受——进度已落库，「今日已背」不会丢。

### 5.3 页面

| 页面 | 路由 | 要点 |
|---|---|---|
| 配置页 | `/student/training/english/vocabulary` | 三档范围 + 数量 10/15/20 + 四种顺序（随机/字母序/倒序/指定字母开头）+ 三个方向 + 四个筛选；题单写 sessionStorage 后跳转 |
| 答题页 | `/student/training/english/vocabulary/run` | 提交即翻词、判定异步回填、底部累积清单兼成绩单 |

四个业务组件：`WordPromptCard` / `WordFamilyTree` / `AnswerFeedList` / `SpellingDiffView`。

**英语不建二选一的 special 页**——目前只有背单词一个功能，语文那页是因为有两个专项。

### 5.4 抽题的三个刻意决定

1. **不走 `ORDER BY RAND() + LIMIT ?`**：mysql2 的 `pool.execute` 不能传 `LIMIT ?`
   （会抛 *Incorrect arguments*），且无法表达四种顺序模式。
   改成「先取候选 id 池 → 服务层洗牌/排序切 N → 按 id 取详情」，四种模式共用一条 SQL。
2. **一个词只出一道题**（不是每个僻义义项各一道）：用户要的是「每天背 10-20 个**词**」，
   会话长度必须等于词数。
3. **普通模式下也会抽到僻义题**（在该词候选里等概率抽）：用户明确说熟词僻义「特别特别重要」，
   若只靠勾选才出现，学生默认根本碰不到；而阅读完型考它的方式本来就是
   「给你一个搭配，看你会不会那个不常见的意思」。勾选的作用是**只留**僻义。

---

## 6. 内容管线（**尚未开工**）

流程：

```
课标官方 PDF ──convert_cli(MinerU)──> md ──vocabulary_cli --from-md──> 词表 JSONL
                                    │
     熟词僻义草稿（我出）+ 词根族边表草稿（我出）──┤  --extract 出待审 md/JSONL
                                    │        ← 人工审（两个闸门）
                                    ▼
                       --check 全绿 ──> --load ──> english_words
```

新增 `tools/data-refinery/src/vocabulary_{cli,loader,check,input}.py` + `tests/test_vocabulary_*.py`，
沿用既有约定（`main() -> int`、`print("[ok] …")`、`pymysql`+`utf8mb4`、结尾单次 commit、
业务键 upsert、`--extract` 只写盘 / `--load` 只读盘、DEV-FIXTURE 只告警不覆盖）。

### 6.1 `--check` 的硬校验（「一定要准确」的凭据）

1. `primary + junior` == 1600；`senior_required + senior_elective` == 1500；总计 == 3000
2. 无重复 `word`；大小写折叠后也无重复（唯一例外 `I`）
3. 全部 word 匹配 `^[a-zA-Z][a-zA-Z' -]*$`（覆盖 `o'clock`、`ice-cream`），无 CJK 泄漏
4. 每个 `level` 的计数与课标原文声明一致，逐条打印
5. 每个词有至少一个 `extended:false` 义项；任一 `extended:true` 义项有非空 `context`
6. `has_extended_sense` 与 `meanings` 一致
7. `root_key` 非 NULL 时必须存在对应 `verified=1` 的行；**且中心词自身 `root_key == word`**
8. 同一 `root_affixes[].code` 在全表 gloss 一致
9. **歧义清单**：既是 2022 义务教育词、又在高中表新增部分出现的词（见 §2.1），打印交人工裁决

计数对不上时 `--check` **报错退出**（exit 1），不静默放行。

### 6.2 已定案 / 仍待确认

**音标：做（2026-09-16 第二次定案，**推翻了当天早先的「不做」**）。**

先记下**为什么会有这次反转**，免得日后重走：

1. 课标两份官方词汇表的说明**明确写着「不标注单词的词性和中文释义」**——也不带音标。所以课标只管「哪些词在范围内 + 分层」，**释义和音标都必须来自课本**。
2. 课本单词表**有**音标（人教版格式是 `word /音标/ 词性. 中文释义 p.页码`），但课本是 smartedu 的**逐页 JPG**，要 OCR。
3. 先用 **macOS Vision**（想省 MinerU 额度）：**读不了 IPA**。实测人教版七上 p116：`/mɪ'steik/`→`/mi'steik/`、`/ˈkʌntri/`→`/kAntri/`、`/bəʊθ/`→`/bac0/`、`guitar`→`gquitar`。把 `usesLanguageCorrection` 关掉后**结果一字不差**——不是「被语言纠正坏了」，而是 **Vision 模型不认识 IPA 字符**，把每个特殊符号替换成最像的拉丁字母（ɪ→i、ʌ→A、ɒ→o、ə→a、ʊ→c、æ→ze、θ→0）且不稳定。于是当时判定「修正表」等同于从零重推音标，遂定「先不做音标」。
4. **但换成 MinerU 后 IPA 是准的**（用户提议，实测同一页）：`mistake /mɪˈsteɪk/`、`country /'kʌntri/`、`both /bəʊθ/`、`guitar /ɡɪ'tɑː(r)/`、`information /ˌɪnfəˈmeɪʃn/`、`husband /'hʌzbənd/`、`bat /bæt/`、`together /təˈɡeðə(r)/` **全部正确**，连 `(r)` 这种可选r都保留了。所以**音标入库**，学生看到的与课本记号体系一致。

**结论**：词库抽取走 **`convert_cli` / `mineru-open-api`（MinerU）→ md → 解析**，不用 Vision 那套坐标分栏。MinerU 的 md 里**栏次与阅读顺序本来就是对的**（左栏读完读右栏）、页码规规矩矩在行尾、还自动按 `## Unit 2` 分了小节——解析器因此比「按坐标还原分栏」简单一大截。

代价是 MinerU 是**云 API**（要 token、约 6 秒/页、限速约 50 文件/分）。单词表都在书末，每本只需转最后约 45 页 ≈ 4.5 分钟/本。

**「今日」的时区**：项目里没有明确的时区约定。做法是服务端用**服务器本地时区**算出当日
00:00 的时间戳作参数传给 SQL，不用 `CURDATE()`（避免 DB 会话时区与应用不一致）。
实现时核对一次容器/DB 时区并写进文档。

### 6.3 课本抓取的两个操作要点

- **必须串行 + 加大延时**：smartedu 会限流。实测并发跑两个 `crawler_cli.py`（初中 + 高中）两边都在中途吃 **403 Forbidden** 挂掉。用 `--crawl-delay 1.5` 串行跑，且 `Checkpoint` 会跳过已下页面，重跑同参数即续传。
- **单词表在书末附录**，人教版初中每册有三段：`Vocabulary in Each Unit`（逐单元）、`Vocabulary A-Z`（字母序总表）、`Vocabulary from Primary School`（小学词汇回顾）。取哪一段要在抽取时明确——`A-Z` 最全但也含大量小学词，`in Each Unit` 更贴单元进度。
- **课本词表含词组**（`first name`、`play the guitar`、`Mapo tofu`、`the Great Wall`）与人名地名专名（`Tom`、`Sydney`、`UK`）。它们有音标也有释义，但「背单词」要不要出词组需要单独定（`word` 正则允许空格，技术上都能存）。

### 6.4 OCR 必须配的校验（不能转一遍就入库）

MinerU 的 md **不带逐行置信度**，而且它偶尔会把长释义折行（`both … 两个；` + 下一行 `两个都 p.23`），
所以校验只能走确定性手段：

1. **课标词表当白名单**：课标两份附录（义务教育 + 高中）就是官方词集，转出来的词不在其中要标记复核。
   注意这是**信号而非硬过滤**——课本本身会收课标之外的词（人名地名、词组、拓展词），
   只是「不在课标里」会显著提高它是 OCR 错的概率。
2. **字母序单调性（首选，确定性）**：单词表按字母序排，乱码词几乎必然破坏单调性 → 能自动揪出来。
3. **字符集白名单**：`^[A-Za-z][A-Za-z'’\- ]*$`，出现数字/杂符号即标记。
4. **结构与形态检查**：词条必须有音标或词性之一；释义必须含中文；`phonetic` 必须是合法 IPA 字符集
   （出现 `A`/`0`/`ze` 这类「像拉丁字母的 IPA 误识」即可疑）。
5. 标记出来的条目**切图人眼复核**（页图与行号都在，切图很容易）。

> 曾经想拿 Vision 的 conf 当报警信号，实测**自相矛盾**（同命令同文件同倍率，单页平均 0.487、
> 一次跑 24 页全变 0.03，原因未查明），且早先「正确行 conf=1.00」的结论是只看一页最上面几条得出的
> **错误结论**。既然改走 MinerU，这条作废，不再追。

---

## 7. 实施状态

**已完成（2026-09-16）**：

- DB：两张表 + 迁移（纯 `CREATE TABLE IF NOT EXISTS`，重跑幂等；`schema.sql` 同步收录，两处 DDL 逐字节一致）
- 后端：5 个端点、两个仓储、三条判题路由、`english_word_judge` 场景、DI 接线
- 前端：配置页 + 答题页 + 四个组件 + 入口/路由
- 测试：server **185** 条新增（748 全绿）、web **30** 条新增（107 全绿）、两端 tsc 干净
- 手测：起真服务 + 真 JWT + 真本地模型跑 **58 项端到端手测全绿**（僻义三档实得 `off_target`）

**未开工**：

- 内容管线与真实词库。当前库里只有 16 条 `source_ref='DEV-FIXTURE'` 假数据
  （`npx tsx src/scripts/seed-vocabulary-fixture.ts`）
- 词库范围/顺序/方向/筛选在真机上按 iPad 横屏与浅色/夜间两种主题的眼检（组件已有渲染测试，
  但布局与配色的观感需要人眼确认）

---

## 8. 踩过的坑（改之前先读）

1. **Nest DI 把接口类型的可选参数当成真 token**
   `VocabularyService` 带 `@Injectable()` 会发 `design:paramtypes`，接口类型的 `deps` 参数
   在运行时被写成 `Object`，Nest 当成可解析的 token 去容器里找、找不到就**启动直接失败**：
   `Nest can't resolve dependencies of the VocabularyService (…, ?)`。必须 `@Optional()`。
   对照 `ai-core/capabilities/*` 那些类**故意不写 `@Injectable()`**（无装饰器就不发
   `design:paramtypes`，Nest 零参实例化），所以它们同样形态的 `deps?: XxxDeps` 一直没事。
   区别只在「有没有 `@Injectable()`」，不是「参数可选不可选」。

2. **Mustache 的 section 对数组是「迭代」不是「判空」**
   `{{#otherGlosses}}…{{/otherGlosses}}` 包住一段标题会让标题被打印 N 次（每个义项一次）。
   空/非空要另用一个布尔标志（`hasOtherGlosses`）。

3. **拼写变体组别收「多一个义项」的词**，见 §4.3。

4. **`grid-cols-13` 不存在**
   本仓 `tailwind.config.js` 的 `theme.extend` 是空的，默认只到 `grid-cols-12`——
   写了不报错也不生效，26 个字母会挤成一列。同理任何非默认刻度都别想当然。

---

## 9. 待办

- [ ] 内容管线（§6）——词表 + 熟词僻义审校 + 词根族审校
- [ ] 确认真实词库是否带音标（§6.2）
- [ ] iPad 横屏 + 浅色/夜间两种主题的眼检
- [ ] 若「今天已背」需要跨时区正确，明确时区约定并写进文档
