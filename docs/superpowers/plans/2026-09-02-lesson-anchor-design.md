# lesson anchor（页码锚定）：db_loader 章归属确定性判定

日期：2026-09-02
状态：实施中

## 背景

新书入库前检查发现三类 lesson 归属错误，根因相同——**章归属信号没有参与判定**（TOC 的 `printed_page` + 卡片的 `textbook_page` 都在手，章归属却全靠 LLM 猜 + db_loader 同名不消歧）：

1. **LLM 错章**：page_092（复习题 27）标成「第二十六章 二次函数」、page_119（复习题 28 续页）同样标 26 章。prompt（textbook_cards.txt:70）规定「复习题/小结等节内标题填 null 系统自动继承」，LLM 违规自选了错章标签，CLI 无法防御「合法格式的错值」。
2. **同名 lesson 歧义**：各章「小结」「数学活动」lesson 同名，`_match_lesson_scoped` 按名匹配返回第一个 → 26-30 章的小结/复习题卡（约 14 页）全部会挂到 25 章的小结。老书同样潜伏。
3. **非 TOC 标签**：page_177/179 的「复习题 30」会经 `_find_or_create_lesson` 创建 TOC 外 lesson，与其它章不一致。

## 方案（用户确认）

TOC 页码锚定——每张卡的章归属由「卡片 `textbook_page`（md 页码）→ 偏移 → TOC 章区间」独立确定性计算；LLM lesson_id 降级为章内小节建议，与锚定冲突时锚定赢。

**锚定只在 db_loader 挂卡时做**：零 LLM 成本、不动 extract/publish/toc_merge、直接修存量数据；重处理任意页不影响结构——锚定每次 load 重算，与 extract 状态解耦。

用户决策：① 复习题卡挂该章「小结」lesson（不建「复习题 N」lesson）；② 老书一并重载修复。

## 设计

### 1. 新模块 `src/lesson_anchor.py`

```python
class LessonAnchor:
    @classmethod
    def build(cls, toc: dict, cards: list[dict]) -> LessonAnchor | None
    def chapter_of(self, md_page: int) -> int | None
```

- **偏移推导**：展平 TOC 中所有带 `printed_page` 的节/补充标签；对每个标签，取持有该标签的卡片的最小 md 页（节起始页），样本 = `min_md - printed_page`；偏移 = 样本众数。样本 < 1 → 返回 None（锚定关闭，退化为现状）。
- **章区间（md 空间）**：章起点 = 该章首个节的 `printed + offset - 3`（留章头/章综述页余量），终点 = 下一章起点 - 1。
- `chapter_of` 返回 md 页所属章；区间外（前置页）返回 None。

依据（已验证）：卡片 `textbook_page`（P92）= md 文件页码；TOC 各节 `printed_page` 完整。例：'25.3 实际问题与一元二次方程' printed 20、首卡 md 28 → 样本 8。

### 2. `db_loader.load_book_cards` TOC 模式接线

进入挂卡循环前（一次性）：
- `anchor = LessonAnchor.build(json.load(toc_path), cards)`
- 预查该书 semester 的 units/lessons：`unit_by_chapter`（units.sort_order 即章号，`_lookup_unit` 同语义）、`lessons_by_unit`、`ambiguous_names`（在 ≥2 个 unit 出现的 lesson 名，动态检测不写死清单）

每张卡在匹配前修正：
- `page_ch = anchor.chapter_of(md页)`；None → 不修正（退化）
- `content_ch` = 卡 content 中 `复习题\s*(\d+)` 解析出的章号（content 标题是最硬证据）
- `label_ch` = `parse_lesson_id(lid)`（第N章/N.M）或 `复习题\s*N` 正则
- **规则 A（错章重写）**：`label_ch` 存在且 ≠ `content_ch or page_ch` → content 含「复习题 N」则目标 = N 章「小结」；否则在目标章 unit 内按 label 标题部分精确匹配；miss → 该章章综述 lesson
- **规则 B（同名消歧）**：lid 名字 ∈ ambiguous_names → 取 `page_ch` unit 下的同名 lesson id
- **规则 C（复习题归一）**：lid 匹配 `复习题\s*N` 且 N == page_ch → 该章「小结」lesson id
- 修正后走既有 `_match_lesson_scoped` → `_match_parent_lesson` → skip 链（匹配逻辑不动）
- 观测日志：`[anchor] offset=8, corrected=N, disambiguated=M`

### 3. 边界（不改）

- extract / publish / toc_merge / prompt / 跨页继承机制全不动；published jsonl 保持 LLM 原始标签
- 无 TOC / 偏移推不出 → 整体退化现有行为，不劣化
- 业务数据守卫、学期替换幂等、sort_order 逻辑不变

## 数据修复（代码完成后）

1. 删 7 条测试练习记录（学生 7、新书卡 4694/4695）
2. `db_loader_cli --load-cards --toc-dir output/toc` 重载（publish 层已是最新，无需重跑）→ 新书入库 + 老书一并重载
3. SQL 复验：092 卡在 27 章小结、119 卡在 28 章小结、177/179 卡在 30 章小结；各章小结卡按章分布；无「复习题 30」lesson；幂等重跑一致

## 实施修正记录

- **章边界升级为两级推导**（首版实测暴露）：首版「首节 printed + 偏移众数 − 3 余量」有两处误差源（偏移 ±1 众数漂移实测得 7 而非 8；余量 3 在「复习题28 续页 → 29章头」间隔 2 页的场景越界），导致 P119 被划入 29 章、老书出现 17 个假修正。改为：**首选综述卡锚定**（每章「第N章」标签卡的最小 md 页 = 章头页，md 空间直接锚定零误差，取 min 天然免疫 LLM 错章综述标签），兜底才用偏移法。升级后老书 corrected 17→0（假修正消失），P119 正确归 28 章。
- **规则 A 兜底顺序新增「时间线活跃节」**：`active_label_at(page)`（全部 TOC 锚点按 printed + offset 折算 md 的排序时间线）排在标题匹配/章综述之前——错章卡落在章末小结区段时直接归该章「小结」（P119 → 28 章小结）。
- 测试：`tests/test_lesson_anchor.py` 19 例 + `tests/test_db_loader.py::TestAnchorCorrection` 9 例；全量 451 passed。
- 真库重载实测（2026-09-02）：新书 799 卡（此前仅 50 卡），anchor 日志 `offset=7, corrected=6, disambiguated=119, normalized=6`；P92/P93 → 27 章小结、P119 → 28 章小结、P177/178/179 → 30 章小结；各章小结卡分布 13/11/13/20/22/16；幂等重跑一致（799 卡不变）。老书 313 卡重载 corrected=0（无错章）。
- 遗留（不阻塞）：老书 9 个「复习题21-29」lesson 是历史空壳（0 卡，早期非 TOC 模式 load 建的），可人工清理；老书 39 张裸编号标签（'23.2'/'24.1'）卡依旧 skipped（既有数据质量问题）。

