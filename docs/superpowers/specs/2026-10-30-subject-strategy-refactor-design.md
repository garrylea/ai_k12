# 切题 / 选项 / 答案三层按学科显式实现（学科策略包重构）

日期：2026-10-30
状态：待评审
关联模块：`tools/data-refinery/`（`question_splitter.py`、`subject_cases/`、`question_extract.py`、`question_labeler.py`）

## 背景与问题

用户提出：**「每个学科差异很大，切题、分选项、答案提取必须按学科分开实现」**。

核查现状后的结论是——诉求成立，但落点要挪。当前三层的分科程度并不齐：

| 环节 | 是否按学科分开 | 证据 |
|---|---|---|
| 标注提示词 | ✅ 已分开 | `prompts/question_labeler/`：语文 54 行、数学 36 行、物理 32 行…各科独立角色与规则 |
| 知识点提示词 | ✅ 已分开 | `prompts/question_kps/`：每科一份选点规则 |
| 答案段提取 | ✅ 已分开 | `subject_cases/`：语文 184 行独立实现，其余委托 generic |
| **题号切分 + 选项拆分** | ❌ 一份公共实现 | `question_splitter.py` 972 行，内含 4 处 `if subject == "chinese"` |

问题不在于"没分科"，而在于**学科逻辑埋在公共文件里**：`question_splitter.py` 同时承担通用扫描和语文专属规则，其它学科只能吃通用规则的运气；出偏差时无法判断是"通用规则错了"还是"这个学科本来就特殊"。

已经因此产生一个真实缺口：

- `attach_material`（把题号前的短文挂到该节每道题）**只对 `chinese` 打开**（`question_extract.py:384`）。
- 英语阅读理解的短文、完形填空的语篇同样写在题号之前，现在**不会被挂到题上**。
- 英语试卷素材已有 9 个 PDF（`tools/crawler/data/英语/初中/first/`），尚未进管线，所以这个坑还没爆。

本次不改变的一个事实：**抽取质量本身不会因为重构自动变好**。重构的价值是把每科的差异变成一份可单独阅读、单独修改、单独测试的文件。

## 目标与非目标

### 目标

1. 切题（题号识别）、选项拆分、材料归属、答案提取四件事，**每学科一份显式实现**。
2. 未登记学科**直接报错**，不静默回退到通用规则。
3. 与学科无关的扫描逻辑（行内粘连、日期陷阱、OCR 错认纠正）**保持一份**，不复制。
4. 现有 87 个切分测试与全部答案提取测试**行为不变**。
5. 补齐已知缺口：英语材料归属。

### 非目标（YAGNI）

- 不为暂无素材的学科（生物/历史/地理）写空实现。未登记就报错。
- 不改抽取（`extract`）与标注（`labeler`）的算法；只把"取哪个学科的实现"这件事统一到一个入口。
- 不改提示词内容（已经分科，本次只是调用点不变）。
- 不做前端/服务端任何改动。

## 架构

### 目录

```
src/question_splitter.py          内核：通用扫描 + split_page(text, md_path, strategy)
src/subject_strategies/
    __init__.py                   get_strategy() 注册表 + UnknownStrategyError
    base.py                       QuestionStrategy 协议 + MaterialPolicy
    chinese.py                    从内核搬出（行为必须完全一致）
    math.py                       A–D 四项、小题 (1)(2)(3)
    physics.py                    图选项、实验题小问、无答案段
    chemistry.py                  同 physics（显式登记，不互相 import）
    english.py                    4 项、阅读篇标题不算题号、材料归属
    generic.py                    仅作显式继承基类，禁止被 get_strategy 直接返回
src/subject_cases/                ← 并入 subject_strategies（答案提取搬到各科文件）
```

### 接口

```python
# subject_strategies/base.py
@dataclass(frozen=True)
class MaterialPolicy:
    """题号前 / 两题之间的短文是否归到题目上。"""
    attach: bool = False
    def is_material_title(self, lines: list[str], index: int, line: str) -> bool: ...
    def looks_like_between_material(self, current_content: str, line: str) -> bool: ...

class QuestionStrategy(Protocol):
    code: str                       # "chinese" | "math" | "physics" | ...
    def is_stem(self, line: str) -> tuple[bool, int | None]:
        """该行是否是主题号；返回 (是, 题号)。"""
    def split_options(self, content: str) -> tuple[str, list[dict] | None]:
        """题干/选项拆分；非选择题返回 (原 content, None)。"""
    def material_policy(self) -> MaterialPolicy: ...
    def extract_answers(self, text: str, md_path: Path) -> list[ExtractedAnswer]:
        """答案段 → 逐题答案（沿用 subject_cases.ExtractedAnswer）。"""
```

```python
# subject_strategies/__init__.py
class UnknownStrategyError(ValueError):
    """学科未登记切题策略（明确报错，不猜测、不回退）。"""

def get_strategy(code: str | None) -> QuestionStrategy:
    """按学科 code 取策略。code 为空或未登记 -> UnknownStrategyError。"""
```

### 数据流

```
extract_questions_file()
  ├─ subject_code = _subject_code_for(rel_parts)          # 不变
  ├─ strategy    = get_strategy(subject_code)             # 新增，未登记即抛错
  ├─ text        = strip_qr_images(...)                   # 不变
  ├─ questions   = split_page(text, md_path, strategy)    # 签名改：attach_material → strategy
  ├─ labeler     = QuestionLabeler(prompt=按学科)          # 不变
  └─ writer      = strategy.split_options(content)        # 原 split_options(subject=...)
```

`split_options(content, subject=...)` 的调用点全部改走 strategy，**删除 subject 参数**，避免留一条旁路：

| 调用点 | 现状 | 改后 |
|---|---|---|
| `question_extract.py` 写 JSONL（完整路径） | `split_options(q.content, subject=subject_code)` | `strategy.split_options(q.content)` |
| `question_extract.py` 写 JSONL（缺陷报告路径） | 同上 | 同上 |
| `question_labeler._render_content` | `split_options(content, subject=subject)` | 由 labeler 持有 strategy 实例 |
| `question_splitter._looks_like_between_material` | 硬编码 `subject="chinese"` | 走 `strategy.material_policy()` |

## 各科实现清单

每科文件只做四件事：`is_stem` / `split_options` / `material_policy` / `extract_answers`。下表是各科的**差异点**，也是各文件里必须有对应断言的项。

| 学科 | is_stem 差异 | split_options 差异 | material | answers |
|---|---|---|---|---|
| 语文 | 全角 `1．`；默写 `8（1）`；文言/现代文小节标题 | 甲乙丙丁 / ①②③④ / 3–6 项，label 归一 A–C，原标签存 `original_label` | ✅ 题号前 + 两题之间 | 参考答案段 + 评分标准拆解析 |
| 数学 | `9.`；小题 `(1)(2)(3)` 不算主题号 | A–D 四项 | ✗ | 答案 + 解析（分析/点睛） |
| 物理 | `21.`；实验题 `21.（1）` | A–D 四项；**图选项**（字母在图下方，MinerU 线性化） | ✗ | 暂无（本批卷无答案段） |
| 化学 | 同物理 | 同物理 | ✗ | 答案为表格/逐题 |
| 英语 | 阅读「A 篇/B 篇」不算题号；听力 1–20 | A–D 四项；完形填空选项在句内括号 | ✅ 题号前 | 答案表 |
| 通用（generic） | 现状行为 | A–D 四项 | ✗ | 仅供显式继承 |

**物理/化学的图选项**当前由通用规则处理（`split_options` 的"标记在内容上方"分支）。本次把它们**写进各自文件**，规则一致但归属明确——以后再出问题，改的是 `physics.py`，不用在 972 行公共文件里找。

## 错误处理与边界

| 场景 | 行为 |
|---|---|
| `get_strategy(None)` 或未登记学科 | 抛 `UnknownStrategyError("学科 <code> 未实现切题策略")`；`extract_cli` 现有的单文件 `except Exception`（`extract_cli.py:506`）会打印 `[ERROR] …: 学科 <code> 未实现切题策略`、计入 Failed、跳过该文件继续跑。退出码维持现状（`Failed>0` 不影响退出码，与其它失败同口径） |
| `is_stem` 判不出题号 | 返回 `(False, None)`，由内核按"普通行"并入上一题 |
| `split_options` 拆不出 | 返回 `(原 content, None)`；选择题无选项 → `needs_review=True`（现状不变） |
| 材料策略未实现 | `MaterialPolicy()` 默认 `attach=False`，行为等同现状 |
| 答案段不存在 | `extract_answers` 返回空列表（物理本批即此情况），不报错 |

**禁止**：
- `get_strategy` 不接收 `_generic` 兜底。
- 任何学科文件里出现 `if subject ==`。
- `question_splitter.py` 里保留任何学科名常量（迁移完 `grep -n "chinese" question_splitter.py` 必须为 0 命中）。

## 迁移步骤

每步完成后全量测试必须 1299+ 通过，且**黄金快照零差异**（见下节）。

| 步骤 | 内容 | 判据 |
|---|---|---|
| 1 | 建 `subject_strategies/` 骨架 + `get_strategy` + `UnknownStrategyError`；把语文逻辑从内核搬到 `chinese.py` | 87 个切分测试全绿；黄金快照零差异 |
| 2 | 数学 / 物理 / 化学显式登记（行为继承自现状，但类名写死） | 同上 |
| 3 | 英语实现（阅读篇识别 + 材料归属） | 新增英语用例；9 张英语卷可切出题且短文挂到题上 |
| 4 | `subject_cases` 并入 `subject_strategies`；答案提取走同一入口 | 现有答案提取测试全绿 |

### 黄金快照（关键回归手段）

重构前生成 `tests/fixtures/split_snapshot.json`：对 `output/md/` 下按学科分层抽样的 md（每科 5–10 份，覆盖语文/数学/物理/化学，共约 30 份）记录：

```json
{"<md 相对路径>": {"count": 35, "items": [{"no": 1, "hash": "<content sha1 前 12 位>"}, ...]}}
```

重构每步后对新代码重算并比对，**任何一处题数或题干哈希变化都必须解释并说明原因**。抽样目录与生成脚本一并提交，避免下次重构重新造轮子。

## 测试策略

1. **行为回归**：`tests/test_question_splitter.py`（87 例）全部保留；只允许改调用签名（`split_page(..., attach_material=True)` → `strategy=get_strategy("chinese")`），断言不许改。
2. **策略单测**：`tests/subject_strategies/test_<subject>.py`，每科至少覆盖：
   - `is_stem` 真例 / 假例（含该科特有的陷阱：语文全角句点、英语"阅读 A 篇"、数学 `(1)` 不算主题号）
   - `split_options` 正常拆分 / 拆不出返回 None / 该科特有的选项形态（语文 3 项甲乙丙、物理图选项）
3. **注册表**：`get_strategy("chinese")` 返回实例；`get_strategy("biology")` 抛 `UnknownStrategyError`；`get_strategy(None)` 抛错。
4. **反例守卫**：`test_no_subject_conditionals_in_core()` —— 读 `question_splitter.py` 源码，断言不含 `if subject ==`。
5. **黄金快照**：见上，steps 1–4 每步跑。

## 风险与回退

| 风险 | 应对 |
|---|---|
| 搬运语文逻辑时改出行为差异 | 黄金快照 + 87 例断言；差异必须逐条解释 |
| 材料状态机与策略钩子耦合 | 策略只提供谓词（`is_material_title` / `looks_like_between_material`），状态机（scope 管理）留在内核，不搬 |
| 英语首次接入暴露新坑 | 英语排在 step 3，前面三步先保证零回归再动新学科 |
| 改坏在跑的物理批 | 重构期间不再跑批量抽取；重构完成并回归通过后再恢复 |

## 验收标准

- [ ] `grep -n "chinese" src/question_splitter.py` 无命中（除注释说明策略机制）
- [ ] `get_strategy("biology")` 抛 `UnknownStrategyError`
- [ ] 全量测试通过，黄金快照零差异（各步）
- [ ] 英语卷切出题目且阅读理解短文挂在题目 `material_text` 上
- [ ] 物理卷重跑结果与重构前一致（题数 35、题号 1–35、题干哈希不变）
- [ ] 三份提示词目录保持不变（本次不动提示词）

## 附：本次重构不做、但记录在案的两件事

1. **物理答案缺失**（2026-10-30 实测）：39 张上学期物理卷无参考答案，35 题全部 `answer=''`。与本次重构无关，但会让物理题进抽题池后无法判分，需单独决策。
2. **知识点树缺「导体与绝缘体」**：题 2（金属勺/瓷碗/塑料盒/木铲）被勉强调到 P1003「电阻及其影响因素」，加 1 行 SQL 即可补。
