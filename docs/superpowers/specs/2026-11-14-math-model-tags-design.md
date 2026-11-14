# 数学题中考模型标签 — 设计

> **日期**：2026-11-14
> **状态**：设计已与用户逐节确认（6 条裁决见 §3），待用户审阅本文件后转 writing-plans。
> **范围锚点**：训练轨数学专项（`math_targeted`）后续按「新定义 / 几何综合 / 圆综 / 倍长中线」开池的前置数据工程。
> **上游产物**：2026-11-14 brainstorming 会话；本文件是标签口径与落库契约的唯一真源。

---

## 1. 背景与现状（2026-11-14 实测，勿凭记忆）

| 事实 | 实测值 |
|---|---|
| 数学专项选题维度 | **只有教材知识点两级**：`knowledge_points` subject_id=1 共 **79** 行（一级 9 / 二级 70） |
| 现有专项模块 | 数学只有 `math_targeted` 一个；没有按中考题型/模型分的池 |
| 数学题总量 | active **509**；其中挂试卷 **405**，不属任何试卷 **104** |
| 题目证据覆盖 | 题干含图 **186**、选项含图 **11**、有解析 **182**、有思路 **104**、四者皆无 **55** |
| 高难题证据 | difficulty≥4 共 **61**，**全部**至少有图/解析/思路之一 |
| 现有标签能力 | 无 `question_model_tags` 一类表或字段；`question_knowledge_points.role` 只有 `primary`，与模型无关 |
| 关键词可行性 | 509 道里题干含「倍长/新定义/几何综合/圆综」的只有 **1** 道 → **不能靠关键词抽取** |

**结论**：要按模型开专项，必须先补一层独立于教材知识点的题目标签；本期只做这层数据，不做入口。

---

## 2. 范围

### 2.1 本期做

- 新增 `question_model_tags` 表（迁移 + `schema.sql` 同步）
- 新增 Python 标注脚本：读库 → LLM 打标（有图送图）→ 枚举校验 → 写库 → 生成抽检 CSV
- 对全部 active 数学题打标（设计时实测 **509** 道；执行时以实际行数为准）
- 抽检清单按低置信度 / 缺证据 / 高难题空标等规则自动生成

### 2.2 本期不做（明确）

- 学生端专项入口、任何前端页面或状态机
- 任何 HTTP API 变更（`docs/API接口与数据流设计文档.md` / `openapi.yaml` 不动）
- 改 `questions` 内容、答案、知识点标注；不改掌握度 / 薄弱点图谱
- 新导入试卷的自动打标（留待把同一 prompt 接进入库管线，另立计划）
- 人工逐题审核（只按 §6.8 的清单抽检）
- 语文 / 英语 / 物理 / 化学 / 道法的模型标签

---

## 3. 用户裁决记录（实现时勿推翻）

| # | 议题 | 裁决 |
|---|---|---|
| 1 | 交付范围 | **只打标签**；专项入口等标签齐了再单独做 |
| 2 | 标签粒度 | **两级：大类 + 具体模型**（一题可多个模型） |
| 3 | 标注范围 | **全部 509 道** active 数学题，不只试卷题、不只难题 |
| 4 | 标注方式 | **LLM 全量 + 抽检**；人工不逐题看 |
| 5 | 一题多模型 | **允许**，例如同时标「倍长中线」和「手拉手」 |
| 6 | 主次 | **不分主次**；后续按模型抽题时用 `DISTINCT question_id` 去重 |

---

## 4. 标签体系

### 4.1 大类与模型清单

大类代码用于落库与后续 API 过滤，中文名用于展示。**模型必须属于其大类**。

| 大类（code / 名称） | 二级模型（code / 名称） | 判定要点 |
|---|---|---|
| `new_definition` / 新定义 | `algebra_new_definition` 代数新定义；`geometry_new_definition` 几何新定义 | 题干先给一个新概念/新运算/新变换，再按定义解题；北京卷常见第 28 题 |
| `geometry_synthesis` / 几何综合 | `median_doubling` 倍长中线；`segment_cut_extend` 截长补短；`hand_in_hand` 手拉手（旋转全等）；`half_angle` 半角模型；`three_equal_angles` 一线三等角；`rotation_similarity` 旋转相似；`midpoint_model` 中点模型；`angle_bisector` 角平分线模型；`isosceles_construction` 等腰/等边构造；`translation_construction` 平移构造；`axisymmetry_construction` 轴对称构造；`area_method` 面积法 | 三角形/四边形为载体，需要辅助线或图形变换；常见第 27 题 |
| `circle_synthesis` / 圆综 | `tangent` 切线判定与性质；`perpendicular_chord` 垂径定理；`inscribed_angle` 圆周角与圆内接四边形；`similarity_trig` 相似与三角函数；`point_circle_extremum` 点圆最值；`fixed_chord_fixed_angle` 定弦定角/四点共圆 | 圆与相似、三角函数、切线综合；常见第 24–25 题 |
| `algebra_synthesis` / 代数综合 | `quadratic_equation` 二次函数与方程；`parameter_discussion` 含参讨论；`vieta` 根与系数关系 | 以二次函数/方程为载体的代数推理；常见第 26 题 |
| `function_graph` / 函数与图象 | `basic_graphs` 一次/反比例/二次图象；`graph_transform` 图象变换；`graph_inequality` 图象与不等式 | 识图、性质、平移、图象与不等式；常见选择/填空/中档解答 |
| `stats_probability` / 统计与概率 | `data_representatives` 数据代表数；`variance` 方差；`probability_calc` 概率计算；`statistical_charts` 统计图表 | 数据收集、统计图表、代表数、方差、概率 |
| `application` / 实际应用 | `equation_modeling` 方程建模；`inequality_modeling` 不等式建模；`function_modeling` 函数建模 | 有现实情境，需要建模；纯几何应用题归几何类，不归此类 |

### 4.2 打标规则（写进 prompt，也是校验依据）

1. **只标解题真正依赖的模型**。图形里恰好有中点、角平分线、圆，不等于用了对应模型。
2. **一题可多模型、可跨大类**，但硬上限：**大类 ≤ 2 个、模型 ≤ 3 个**（按置信度保留，平票按上表顺序）。
3. **模型必须属于大类**；不属于的模型降级为 `model=''` 并打 `category_model_mismatch` 标记。
4. `model=''` 只在「大类明确但没有合适二级模型」时使用；`几何综合` / `圆综` 出现空模型进抽检清单。
5. **证据不足宁可不标**：无图、无解析/思路、题干也不含构造描述时，只标文字能确定的；不确定不硬猜，`confidence ≤ 0.60`。
6. **纯计算/直接套公式的题可以无标签**，不强行塞进某个大类。
7. 标签只描述「这题考什么」，**不评价难度、不给答案、不改题面**。

**正/反例（prompt 内固定）**

- 正例：题干写「延长 $AD$ 至 $E$，使 $DE=AD$，连接 $BE$」→ `median_doubling`。
- 反例：只给中线 $AD$、没有倍长构造 → `midpoint_model` 或空，不是 `median_doubling`。
- 正例：共顶点的两个等腰/等边三角形旋转 → `hand_in_hand`。
- 反例：只有一个旋转、没有两组对应边相等 → 按实际的 `rotation_similarity` / `translation_construction` 标，不标手拉手。

---

## 5. 数据模型

### 5.1 新表 `question_model_tags`

```sql
CREATE TABLE IF NOT EXISTS question_model_tags (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  question_id   BIGINT       NOT NULL,
  category      VARCHAR(32)  NOT NULL COMMENT '大类代码，见 §4.1',
  category_name VARCHAR(32)  NOT NULL COMMENT '大类中文名（冗余，供读侧直接展示）',
  model         VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '模型代码；无二级时为空串',
  model_name    VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '模型中文名',
  confidence    DECIMAL(3,2) NOT NULL DEFAULT 0.00 COMMENT '0-1，LLM 自评，仅用于排序抽检',
  reason        VARCHAR(255) NOT NULL DEFAULT '' COMMENT '一句话依据，供抽检',
  source        VARCHAR(16)  NOT NULL DEFAULT 'llm' COMMENT 'llm|manual',
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_qmt_question_cat_model (question_id, category, model),
  KEY idx_qmt_category_model (category, model),
  KEY idx_qmt_confidence (confidence),
  CONSTRAINT fk_qmt_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**为什么存 code + 中文名**：现阶段只打标、无 UI；中文名放行内可直接读，后续专项用 code 过滤、直接取 name 展示，不需要再维护字典表。

**为什么不能复用 `knowledge_points`**：`MasteryService` 判题后会对题目关联的**所有**知识点 upsert 掌握度；把「倍长中线」挂进知识点树会污染掌握度与薄弱点图谱。且模型跨知识点（倍长中线同时涉及三角形、全等、中位线），语义上不属于教材章节。

### 5.2 迁移与同步

- 迁移：`tools/db/migrations/2026-11-14_question_model_tags.sql`（`CREATE TABLE IF NOT EXISTS`，幂等，手工 apply）
- 同表必须同步进 `tools/db/schema.sql`（§3.2 内容与课程，`question_knowledge_points` 之后）
- `docs/K12智学系统-数据库设计文档.md` §3.2 增表说明 + 变更日志补一行
- 回滚：`DROP TABLE question_model_tags;`（纯新增，无其它对象依赖）

---

## 6. 标注管线

### 6.1 文件与入口

| 文件 | 职责 |
|---|---|
| `tools/data-refinery/src/model_tags.py` | 标签枚举、归一化/校验、上限/去重、抽检标记等**纯函数** |
| `tools/data-refinery/src/label_model_tags.py` | 主流程：读库 → LLM → 写库 → CSV |
| `tools/data-refinery/src/prompts/model_tagger/math.txt` | 数学打标规则与正反例（**枚举块由代码注入，不手写第二份**） |
| `tools/data-refinery/tests/test_model_tags.py` | 纯函数单测 + prompt 枚举漂移检查 |

**交付给用户只有一条命令**：

```bash
cd tools/data-refinery && python3 src/label_model_tags.py
```

DB 连接复用 `config.RefineryConfig.from_env()`（`tools/data-refinery/.env` 的 `DB_*`），不新增配置项。

可选开发参数：`--limit N`、`--question-id ID`（可重复）、`--model-key`（默认 `qwen3.8-max`）、`--concurrency`（默认 4）、`--no-images`。**不设 `--dry-run`**（工程约定：不让人跑两条命令）。

### 6.2 输入查询

```sql
SELECT q.id, q.type, q.difficulty, q.content, q.options,
       q.material_text, q.explanation, q.approach,
       GROUP_CONCAT(DISTINCT CONCAT(ep.title, ' 第', pq.question_no, '题')
                    ORDER BY ep.title SEPARATOR ' | ') AS paper_refs
FROM questions q
LEFT JOIN paper_questions pq ON pq.question_id = q.id
LEFT JOIN exam_papers ep ON ep.id = pq.paper_id
WHERE q.subject_id = 1 AND q.is_active = 1
GROUP BY q.id
ORDER BY q.id;
```

- **只取 active 题**：隐藏题不应进任何抽题池。
- 覆盖数以**执行时** `subject_id=1 AND is_active=1` 为准（设计时实测 509；若届时增减，按新数跑，不改口径）。
- `paper_refs` **只写进抽检 CSV，不送 LLM**（避免「某某模拟卷第 28 题」泄漏预期模型）。
- `material_text`/`material_url` 当前数学库均为空；仍按字段存在处理，未来有材料题不用改 SQL。

### 6.3 模型选择

- 从 **DB `llm_models`** 按 `model_key` 取 `provider_type / model_id / base_url / api_key`（模型与 Key 的真源在数据库，不在 `.env`）。
- 默认 `qwen3.8-max`（多模态，图片直送）；OpenAI 兼容客户端 base_url 用 `base_url + "/v1"`。
- 预检：开跑前发一次极小请求；失败直接退出并提示「检查网络 / 开发 VPN 会让百炼端点连不上 / 模型 Key 是否有效」，不要跑到一半才报错。
- `--model-key local` 只支持纯文本，需同时传 `--no-images`；本地 llama.cpp 不接受图片时不要静默丢图。
- 不设 `temperature`（沿用仓库约定：refinery 不覆盖默认温度，结果不可复现，验收不依赖逐字一致）。

### 6.4 Prompt 契约

System prompt 固定包含：角色、§4.2 规则、正反例、输出 JSON schema（以上来自 `prompts/model_tagger/math.txt`），以及 §4.1 全量枚举（由 `model_tags.py` 生成后注入——**枚举只有一份真源**，prompt 文件里不再手写，防漂移）。User prompt 按题拼：

```
<question>
题型: {type}
难度: {difficulty}
题干: {content 截断 3000 字}
选项: {options 文本 截断 1000 字}
解析: {explanation 截断 1500 字}（无则省略）
思路: {approach 截断 1500 字}（无则省略）
</question>
```

输出严格 JSON：

```json
{"tags": [
  {"category": "geometry_synthesis", "model": "median_doubling",
   "confidence": 0.86, "reason": "延长 AD 至 E 使 DE=AD，连接 BE 构造全等"}
]}
```

- 无合适标签时 `{"tags": []}`，不要输出 `null` 或解释文字。
- `reason` 用中文、≤60 字、只写依据，不写解题过程。
- `max_tokens` 512；优先 JSON mode，失败则用现有 `extract.py` 的 JSON 清洗/修复逻辑解析。

### 6.5 图片处理

- 从 `content` 提取 `![](...)` 与 `<img src="...">`；从 `options` JSON 取 `image_url`。
- 解析根目录：`config.output_dir / "assets"`；去掉前导 `/`；拒绝 `..` 越界；`http(s)://` 外链不下载，按 `image_missing` 处理。
- 去重后**最多 3 张**：先题干图，再选项图；同一题不重复送。
- 单张 > 6MB 或文件缺失/不可读 → 跳过并在抽检行打 `image_missing`，不阻断整题。
- 以 base64 data URL 放进 `image_url` 内容块；无图则纯文本，**不凭空描述图形**。

### 6.6 校验与写库（纯函数 + 单事务）

对 LLM 输出依次做：

1. 代码归一化：strip、去反引号；**接受 code 或中文名，统一映射为 code**；大小写按枚举严格匹配。
2. 未知大类 → 丢弃；未知模型但大类合法 → 保留大类、`model=''`，打 `unknown_model`。
3. 模型不属于该大类 → `model=''`，打 `category_model_mismatch`。
4. `(category, model)` 去重，保留最高 `confidence`。
5. 上限按**确定性算法**执行，避免「模型被砍掉、大类变空壳」：
   1. 全部标签按 `confidence` 降序排序（平票按 §4.1 的清单顺序）；
   2. 取前 3 条 → 满足模型 ≤ 3；空模型 `''` 也占一个名额；
   3. 统计这 3 条涉及的大类，按「该大类内最高置信度」取前 2 类；**不在前 2 类的标签整条丢弃** → 满足大类 ≤ 2；
   4. 结果里不会出现「只有大类、没有任何模型行」的空壳（`model=''` 是有效行，不算空壳）。
6. `confidence` 夹到 `[0,1]`、四舍五入两位；缺失/非数字 → `0.50` 并进 `low_confidence`；`reason` 截 255 字。

写库（每题一个事务）：

```sql
DELETE FROM question_model_tags WHERE question_id = ? AND source = 'llm';
-- 再逐条 INSERT IGNORE（撞 manual 行时人工标签优先）
```

- **只有解析/校验成功的题才进入写库**；失败题保留旧标签不动，避免「跑挂了反而把上次结果清空」。
- 只删/写 `source='llm'` 的行使脚本**幂等**；`manual` 行永不被覆盖。
- LLM 调用可并发；**写库在主线程串行**，避免多线程共享/争抢 DB 连接。
- 不更新 `questions`、不碰知识点表。

### 6.7 失败处理与退出码

- 单题网络错误：最多重试 2 次（指数退避）；解析失败：1 次纠正重试（提示「只输出 JSON」）。
- 仍失败 → 记入 `failed_ids`，继续下一题，不中断全批。
- 结束打印：总题数 / 成功 / 失败 ID / 标签行数 / 有标签题数 / 空标签题数 / 低置信度题数 / 各大类计数 / CSV 路径。
- **有失败时退出码 1**，并打印「重跑同一命令即可补齐」；全成功退出码 0。

### 6.8 抽检清单

固定输出 `tools/data-refinery/output/model_tags/review.csv`（`utf-8-sig`，Excel 直接打开不乱码），一次运行覆盖旧文件。

列：`question_id, paper_refs, type, difficulty, category, category_name, model, model_name, confidence, reason, flags`。

- 每个标签一行；**无标签的题也输出一行**（category/model/confidence/reason 留空），否则 `no_tag_hard` 无法抽检。
- 同一题的多个标签按置信度降序排在一起，人工一眼能看全。

`flags`（分号分隔）：

| flag | 触发条件 |
|---|---|
| `low_confidence` | `confidence < 0.70` |
| `no_evidence` | 无图、无解析、无思路 |
| `empty_model` | 大类是几何综合/圆综，但 `model=''` |
| `unknown_model` | LLM 给了枚举外模型 |
| `category_model_mismatch` | 模型不属于该大类 |
| `no_tag_hard` | `difficulty >= 4` 且无任何标签 |
| `image_missing` | 引用的图片文件缺失/超限 |
| `multi_category` | 该题命中 2 个大类 |

**抽检口径**：从 review.csv 抽 **30 条**（15 条几何综合/圆综 + 15 条其他），人工只看这 30 条；明显错标 > 3 条则调整 prompt 后重跑，否则通过。

---

## 7. 验收标准

1. 迁移 apply 成功；`python3 tools/db/schema_reconcile.py` 报该表一致。
2. 一条命令跑完 509 道；`failed_ids` 为空（或重跑后为空）。
3. 落库枚举合法：
   ```sql
   SELECT COUNT(*) FROM question_model_tags
   WHERE category NOT IN (...) OR (category, model) NOT IN (...);
   ```
   结果为 0。
4. 重跑同一命令不产生重复行（唯一键 + 先删后插）。
5. 抽检 30 条，明显错标 ≤ 3。
6. `questions` 表行数与内容不变（脚本无 UPDATE 权限路径；人工抽查 3 行哈希一致）。
7. 交付物只多出：新表、迁移、脚本、prompt、单测、review.csv。

---

## 8. 测试计划

- **纯函数单测**（不连 LLM/DB）：枚举校验、中文名映射、未知模型降级、大类上限 2、模型上限 3、去重保高置信度、confidence 夹取/缺失兜底、图片路径解析与越界拒绝、flags 计算、带 ```json 围栏 / `<think>` 的 JSON 解析。
- **枚举漂移检查**：断言生成的 system prompt 包含 `model_tags.py` 里全部 category/model code（防止 prompt 与代码两处漂移）。
- **冒烟**：`--limit 3` 实跑，确认写库 3 题、CSV 有行、重跑不新增行。
- **全量**：一条命令跑 509 道。
- **DDL**：迁移重复执行两次不报错；`schema_reconcile.py` 通过。
- 不新增 TS 测试（本期无服务端/前端代码变更）。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 几何模型误标/漏标 | 图片直送 + 解析/思路作证据；`confidence` + 抽检清单；宁可漏标不硬猜 |
| 55 道无任何证据 | 只标文字能确定的；`no_evidence` 标记；高难题 61 道全部有证据，核心池不受影响 |
| LLM 结果不可复现 | 验收不要求两次逐字一致；只要求幂等（不重复行）；人工修正走 `source='manual'` |
| 百炼端点被 VPN 阻断 | 预检失败即退出，错误信息点名 VPN |
| DashScope 限流 | `--concurrency 4` + 单题重试；失败清单可重跑 |
| 几何综合/圆综空模型过多 | `empty_model` 进抽检；若占比过高，扩模型清单或调 prompt 后重跑 |

---

## 10. 后续（不在本期，只留接缝）

- **专项入口**：`SELECT DISTINCT question_id FROM question_model_tags WHERE category=? AND model=? AND confidence>=0.7`，叠加现有 `student_hidden_questions` / `answer<>''` 谓词；`POST /api/training/targeted/start` 增加按标签筛选参数（届时另写 API 文档与 spec）。
- **新题自动打标**：把同一 prompt 接进 `question_extract` / `question_labeler` 入库管线。
- **人工修正**：后续管理端或脚本写 `source='manual'`，重跑不覆盖。
