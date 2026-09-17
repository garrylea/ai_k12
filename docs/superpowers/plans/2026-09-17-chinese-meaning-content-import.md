# 古诗含义 · 手写内容导入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把用户手写的《诗深层含义.md》（31 首诗 / 157 句）安全导入 `chinese_passages`——只写含义/情感与缺失的句读，**绝不覆盖任何既有数据**。

**Architecture:** 扩 `meaning_cli.py` 认用户文档格式（跳过「关键字词」）；新增 `meaning_backfill_cli.py` 给缺 `sentences` 的 16 首诗补切句（按用户文档的切分位置从库里 `body` 切片）与译文；最后跑一次导入。

**Tech Stack:** Python 3 + pymysql + pytest，复用 `interpretation_split` / `interpretation_translate` / `interpretation_check` 的既有能力。

**前置事实（已实测，勿再假设）：**
- 用户文档与库同源（`192.168.1.5` 即本机）。文档 31 首 = 15 首已有 `sentences` + 16 首缺 `sentences`。
- 文档的 16 首切句里，15 首能逐字拼回 `body`；`丑奴儿·书博山道中壁` 因**半角/全角引号**差异拼不回。
- `split_sentences(body)` 只有 11/16 与文档一致：它在 `？！` 处也断句，会把「云横秦岭家何在？雪拥蓝关马不前。」切成两句。库里已有 15 首是按**一联一句**切的，所以**必须用文档的边界**，不能用程序切句。
- 「关键字词」对应 `key_terms` 列，属解释专项在用。用户明确要求：**导入时跳过这一项，永不写 `key_terms`**。

## Global Constraints

- **绝不覆盖**：本次只允许写两列——`sentence_meanings`（含义/情感）与 `sentences` / `full_translation`（补切句）。**永不写 `key_terms`**，永不写 `verified` / `is_active` / `memorize_required`。
- **对齐铁律**：`sentence_meanings[i]` 描述 `sentences[i]`；数组长度必须相等，未填位置写 `null`，**绝不压缩**。
- **切句不变式**：`''.join(sentences[].text) == body` 逐字相等（含标点）。拼不回就**报错跳过该篇，绝不写库**。
- **只做诗**：文言文篇目的 `sentence_meanings` 保持 `NULL`（含义池靠 `IS NOT NULL` 天然排除）。
- 入库幂等；每篇写前先 `--dry-run` 核对。
- refinery 用 `.env` 的 `DB_*`；本地 LLM 用 `LOCAL_LLM_BASE_URL`。

---

## Task 1: meaning_cli 支持用户手写文档格式

**Files:**
- Modify: `tools/data-refinery/src/meaning_cli.py`
- Test: `tools/data-refinery/tests/test_meaning_cli.py`

**Interfaces:**
- Produces: `parse_uidoc(text) -> dict[str, list[tuple[str, str, str]]]`（篇名归一 → [(原文, 含义, 情感)]），与既有 `parse_template` 同形，`--apply` 可直接复用。

用户文档格式（与 `--export` 模板不同，**两套都要认**）：

```md
## 水调歌头(明月几时有)（宋·苏轼）

### 明月几时有？
#### 关键字词
几时：什么时候；
#### 深层含义
劈头一问，问的是月，实际问的是时间与存在的本源。
#### 情感
豪放不羁的浪漫情思，带着微醺的迷惘与好奇。
```

- [ ] **Step 1: 写失败测试**

在 `test_meaning_cli.py` 追加：

```python
UIDOC = """# 古诗深层含义逐句解析（九年级）

> **数据来源**：MySQL 数据库 `ai_k12`
> **筛选规则**：仅保留**诗歌**

---

## 酬乐天扬州初逢席上见赠（唐·刘禹锡）

### 巴山楚水凄凉地，二十三年弃置身。
#### 关键字词
巴山楚水：诗人曾被贬夔州、朗州等地；
#### 深层含义
以「凄凉地」与「二十三年」两个时空坐标，把半生贬谪一笔写尽。
#### 情感
回顾贬谪生涯的沉痛与辛酸。

### 沉舟侧畔千帆过，病树前头万木春。
#### 关键字词
沉舟：沉没的船，喻指自己；
#### 深层含义
以「沉舟」「病树」自况，却不作哀音。
#### 情感
豁达超脱、不为个人际遇所困的胸襟。

## 附录：被剔除的非诗歌条目

| 篇目 | 作者 |
| --- | --- |
| 岳阳楼记 | 范仲淹 |
"""


def test_parse_uidoc_认层级与字段名():
    got = parse_uidoc(UIDOC)
    assert list(got) == ["酬乐天扬州初逢席上见赠"]
    assert got["酬乐天扬州初逢席上见赠"] == [
        ("巴山楚水凄凉地，二十三年弃置身。",
         "以「凄凉地」与「二十三年」两个时空坐标，把半生贬谪一笔写尽。",
         "回顾贬谪生涯的沉痛与辛酸。"),
        ("沉舟侧畔千帆过，病树前头万木春。",
         "以「沉舟」「病树」自况，却不作哀音。",
         "豁达超脱、不为个人际遇所困的胸襟。"),
    ]


def test_parse_uidoc_跳过关键字词与文首说明():
    got = parse_uidoc(UIDOC)
    joined = "".join(m + e for _t, m, e in got["酬乐天扬州初逢席上见赠"])
    assert "巴山楚水：诗人曾被贬" not in joined   # 关键字词整段跳过
    assert "数据来源" not in joined                 # 文首说明不当成篇目
    assert "岳阳楼记" not in got                    # 附录表格没 ### 句子，不当篇目


def test_parse_uidoc_篇名去掉作者括号():
    got = parse_uidoc(UIDOC)
    assert "酬乐天扬州初逢席上见赠" in got
    assert not any("刘禹锡" in k for k in got)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python -m pytest tests/test_meaning_cli.py -k uidoc -v`
Expected: FAIL —— `ImportError: cannot import name 'parse_uidoc'`

- [ ] **Step 3: 实现 parse_uidoc**

在 `meaning_cli.py` 内新增（与 `parse_template` 并列；**不改 `parse_template` 行为**）：

```python
#: 用户手写文档的层级：# 篇名（文首大标题不算）/ ### 原文 / #### 字段
_UIDOC_POEM_RE = re.compile(r"^##\s+(.+?)\s*$")
_UIDOC_SENT_RE = re.compile(r"^###\s+(.+?)\s*$")
_UIDOC_FIELD_RE = re.compile(r"^####\s+(关键字词|深层含义|情感)\s*$")
#: 用户文档里「含义」叫「深层含义」——映射到内部字段名
_UIDOC_FIELD_MAP = {"深层含义": "含义", "情感": "情感"}
#: 篇名尾部的（唐·刘禹锡）之类：只在**尾部**且不含书名号时剥掉
_UIDOC_AUTHOR_PAREN_RE = re.compile(r"[（(][^（）()]*[·・][^（）()]*[）)]\s*$")


def _uidoc_strip_author(title: str) -> str:
    """『酬乐天扬州初逢席上见赠（唐·刘禹锡）』→『酬乐天扬州初逢席上见赠』。

    只剥**尾部**且括号内含间隔号（作者·朝代）的；『水调歌头(明月几时有)』这种
    括号里没有间隔号，必须原样保留，否则对不上库里的篇名。
    """
    stripped = _UIDOC_AUTHOR_PAREN_RE.sub("", title).strip()
    return stripped or title


def parse_uidoc(text: str) -> dict[str, list[tuple[str, str, str]]]:
    """解析用户手写文档 → {篇名归一: [(原文, 含义, 情感), …]}。

    **「关键字词」整段跳过、永不进库**（它属 `key_terms` 列，解释专项在用，
    导入覆盖会改到线上题面）。
    文首用 `#` 的说明段与文末附录表格都不含 `###` 句子，天然不会成为篇目。
    """
```

（实现要点：以 `##` 起篇、`###` 起句、`####` 起字段；`关键字词` 字段内容**读入即丢**；字段正文按行累加到下一个 `####`/`###`/`##` 为止。结构与既有 `parse_template` 同形，可直接照抄其状态机。）

- [ ] **Step 4: `--apply` 自动识别两种格式**

`--apply` 与 `--export` 的 `--input` 现在要能喂两种文件。做法：读入文本后先试 `parse_uidoc`（判据：文本里出现 `^###\s` 且出现 `^####\s+深层含义`），命中就用它，否则回退 `parse_template`。

- [ ] **Step 5: 加一条「永不写 key_terms」的钉子**

```python
def test_apply_的_UPDATE_语句只动_sentence_meanings():
    from src.meaning_cli import _UPDATE_SQL
    for banned in ("key_terms", "verified", "is_active", "memorize_required"):
        assert banned not in _UPDATE_SQL
```

- [ ] **Step 6: 跑测试 + 全量**

Run: `cd tools/data-refinery && python -m pytest tests/test_meaning_cli.py -v && python -m pytest -q`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add tools/data-refinery/src/meaning_cli.py tools/data-refinery/tests/test_meaning_cli.py
git commit -m "feat(refinery): meaning_cli 支持用户手写文档格式（关键字词整段跳过）"
```

---

## Task 2: 给缺 sentences 的 16 首诗补切句与译文

**Files:**
- Create: `tools/data-refinery/src/meaning_backfill_cli.py`
- Test: `tools/data-refinery/tests/test_meaning_backfill.py`

**Interfaces:**
- Produces: `slice_by_doc_boundaries(body: str, doc_sentences: list[str]) -> list[str]`（拼不回 body 时抛 `ValueError`）
- Produces: `--dry-run` / `--apply` 两个模式

**为什么不用 `split_sentences`**：它在 `？！` 处也断句，会把「云横秦岭家何在？雪拥蓝关马不前。」切成两句；库里已有 15 首是按**一联一句**切的。所以按用户文档给的**切分位置**切，而**字面文本一律取自库里的 `body`**——这样不变式在构造上成立，也顺带修掉半角/全角引号那类排版差异。

- [ ] **Step 1: 写失败测试**

创建 `tools/data-refinery/tests/test_meaning_backfill.py`：

```python
from src.meaning_backfill_cli import slice_by_doc_boundaries


def test_按文档边界从_body_切片_拼接回原文():
    body = "云横秦岭家何在？雪拥蓝关马不前。知汝远来应有意，好收吾骨瘴江边。"
    doc = ["云横秦岭家何在？雪拥蓝关马不前。", "知汝远来应有意，好收吾骨瘴江边。"]
    got = slice_by_doc_boundaries(body, doc)
    assert got == doc
    assert "".join(got) == body


def test_正文里的引号与文档不一致时也切得对():
    # 库里是全角引号，用户文档被转成了半角——字面必须取自 body
    body = "欲说还休，却道“天凉好个秋”！"
    doc = ['欲说还休，却道"天凉好个秋"！']
    got = slice_by_doc_boundaries(body, doc)
    assert got == [body]          # 拿到的是库里的全角版本
    assert "".join(got) == body


def test_正文含换行与空白时仍能拼回():
    body = "戍鼓断人行，\n边秋一雁声。\n露从今夜白，月是故乡明。"
    doc = ["戍鼓断人行，边秋一雁声。", "露从今夜白，月是故乡明。"]
    got = slice_by_doc_boundaries(body, doc)
    assert "".join(got) == body


def test_切分对不上就抛错_绝不猜():
    body = "床前明月光，疑是地上霜。"
    doc = ["床前明月光，", "疑是地上霜。", "举头望明月。"]   # 多了一句库里没有的
    import pytest
    with pytest.raises(ValueError):
        slice_by_doc_boundaries(body, doc)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd tools/data-refinery && python -m pytest tests/test_meaning_backfill.py -v`
Expected: FAIL —— `ModuleNotFoundError: src.meaning_backfill_cli`

- [ ] **Step 3: 实现切片核心**

```python
_QUOTE_FOLD = str.maketrans({
    "“": '"', "”": '"', "「": '"', "」": '"',
    "‘": "'", "’": "'", "『": "'", "』": "'",
})


def _sig(s: str) -> str:
    """比对用形式：去所有空白 + 引号归一。**只用于比对与计数，不用于落库文本。**"""
    return "".join(s.split()).translate(_QUOTE_FOLD)


def slice_by_doc_boundaries(body: str, doc_sentences: list[str]) -> list[str]:
    """按文档给的切分位置切片，**字面一律取自 body**。

    这样 ``''.join(结果) == body`` 是构造上必然成立的，文档与库的排版差异
    （半角/全角引号等）不会带进库。
    对不上就抛 ``ValueError``——绝不猜、绝不部分采用。
    """
```

实现要点：
1. `sig_body = _sig(body)`，`sig_docs = [_sig(x) for x in doc_sentences]`
2. `"".join(sig_docs) != sig_body` → 抛错，消息里带首处差异的位置与上下文（便于人工定位）
3. 建 `positions: list[int]`——`body` 里每个**非空白**字符的原始下标；`positions[k]` 即 `sig_body` 第 k 字在 `body` 中的下标。
   注意引号归一**不改变长度**（一换一），所以下标能对上。
4. 逐句切：`start = 0 if cursor == 0 else positions[cursor]`；
   `end = positions[cursor + len(d) - 1] + 1`；再把紧随其后的空白并入本段（保证拼回原文）。
5. 尾部若有剩余空白，并入最后一段。

- [ ] **Step 4: 实现 CLI 骨架**

```python
def parse_args(argv=None): ...
    # --input 必填（用户手写文档）
    # --dry-run / --apply 二选一
    # --limit N 打样

# 取数与写库
def _fetch_targets(conn) -> list[tuple]:
    """只取 sentences IS NULL 的行——已有句读的**一律不动**。"""

_UPDATE_SENTENCES_SQL = (
    "UPDATE chinese_passages SET sentences = %s, full_translation = %s WHERE id = %s"
)
```

**硬要求**：`_UPDATE_SENTENCES_SQL` 里**绝不出现** `key_terms` / `verified` / `is_active` / `memorize_required`——加一条断言钉住。

译文：复用 `interpretation_translate.translate_passage`（本地优先、ds-flash 兜底），
`key_terms=[]` 传入（**只为凑参数，不落库**）。译文失败不阻断：该篇仍写 `sentences`，
`translation` 留空串并在 `-review.md` 里点名。

- [ ] **Step 5: dry-run 核对全 16 首**

Run: `cd tools/data-refinery && python src/meaning_backfill_cli.py --dry-run --input /Users/lichao/Downloads/诗深层含义.md`
Expected: 16 首全部切片成功、`join == body`；`丑奴儿·书博山道中壁` 也应通过（引号差异由 body 切片吸收）。

- [ ] **Step 6: 跑测试 + 全量 + 提交**

Run: `cd tools/data-refinery && python -m pytest -q`

```bash
git add tools/data-refinery/src/meaning_backfill_cli.py tools/data-refinery/tests/test_meaning_backfill.py
git commit -m "feat(refinery): 按用户文档边界补切句（字面取自 body，只写 sentences/full_translation）"
```

---

## Task 3: 执行导入与验收

**Files:** 无（数据操作 + 验收）

- [ ] **Step 1: 备份要动的两列**

```bash
mysql -u ai_k12 -pai_k12 ai_k12 -e "SELECT id, work_title, key_terms, sentences, sentence_meanings FROM chinese_passages ORDER BY id" > /tmp/chinese_passages_backup_before_import.tsv
```

- [ ] **Step 2: 补切句**

Run: `cd tools/data-refinery && python src/meaning_backfill_cli.py --apply --input /Users/lichao/Downloads/诗深层含义.md`
Expected: 写 16 行（只 `sentences` + `full_translation`）。

- [ ] **Step 3: 灌含义/情感**

Run: `cd tools/data-refinery && python src/meaning_cli.py --apply --input /Users/lichao/Downloads/诗深层含义.md`
Expected: 写 31 行（只 `sentence_meanings`）。

- [ ] **Step 4: 核对「一个字节都没多写」**

```bash
# key_terms 必须与备份逐字一致（16 首新切句的仍为 NULL；15 首诗的保持原值）
mysql -u ai_k12 -pai_k12 ai_k12 -N -e "
SELECT SUM(key_terms IS NOT NULL) AS 有字词的篇目,
       SUM(sentences IS NOT NULL) AS 有句读的篇目,
       SUM(sentence_meanings IS NOT NULL) AS 有含义的篇目,
       SUM(verified=1 AND is_active=1) AS 状态位正常
FROM chinese_passages;"
```

Expected：有字词的篇目 = 与备份前一致；有含义的篇目 = 31；状态位 = 50。

- [ ] **Step 5: 抽查含义池与文言文排除**

```bash
# 含义池只应有 31 首诗，不含岳阳楼记等 10 首文言文
mysql -u ai_k12 -pai_k12 ai_k12 -N -e "
SELECT COUNT(*) FROM chinese_passages
WHERE verified=1 AND is_active=1 AND JSON_LENGTH(sentences)>0 AND sentence_meanings IS NOT NULL;"
mysql -u ai_k12 -pai_k12 ai_k12 -N -e "
SELECT COUNT(*) FROM chinese_passages
WHERE work_title IN ('岳阳楼记','醉翁亭记','湖心亭看雪','曹刿论战','邹忌讽齐王纳谏',
                     '陈涉世家','出师表','鱼我所欲也','唐雎不辱使命','送东阳马生序')
  AND sentence_meanings IS NOT NULL;"
```

Expected: 第一问 = 31（考虑上下册重复收录，按行数可能更多，须核对是否都是诗）；第二问 = **0**。

- [ ] **Step 6: 端到端抽查一首**

起后端，对新增的一首（如 `月夜忆舍弟`）走一次 `start` + `judge`，确认下发无泄题、判题返回真实对错。

- [ ] **Step 7: 报告结果**

把上述核对数字与抽查结论写进 `.superpowers/sdd/progress.md`。
