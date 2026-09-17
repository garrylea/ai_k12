"""meaning_cli 单测：解析、按原文定位下标、同篇合并与三条防丢守卫。

钉住这些事：
- 产出数组**与 sentences 等长**，没填的位置是 `None`（不是压缩掉——压缩会让后面整体错位）；
- 定位**按原文**，不是按行号：模板调序了也跟着原文走；
- 定位不到的原文进 `skipped`，绝不猜、绝不静默丢；
- 同篇名多行（九上/九下重复收录）合并时，**兄弟行填好的值要补上基准行的空**
  （两行状态可能不同步，丢了就会「模板显示空 → --apply 两行一起写成 null」）；
- `--export` 回填库里已填的含义，让「导出 → 改一句 → 回写」这条修订路径无损；
- 三条防丢守卫：整篇全空不写库 / 对不上的原文进过目清单且不猜 / 一行都写不成的行不写库；
- `_UPDATE_SQL` 只碰 `sentence_meanings` 一列，人工标定的三列根本不出现。

全部用假连接，不碰真库。
"""

import json

import src.meaning_cli as cli
from src.meaning_cli import build_meanings_array, parse_input, parse_template, parse_uidoc

TITLE = "酬乐天扬州初逢席上见赠"

TEMPLATE = """# 酬乐天扬州初逢席上见赠

## 第1句
> 巴山楚水凄凉地，二十三年弃置身。
含义：写被贬之地的荒凉。
情感：辛酸

## 第2句
> 沉舟侧畔千帆过，病树前头万木春。
含义：比喻新事物必将取代旧事物。
情感：豁达乐观
"""


def _row(row_id, title, texts, meanings=None):
    """假 DB 行：(id, work_title, sentences JSON, sentence_meanings JSON)。"""
    return (
        row_id,
        title,
        json.dumps([{"text": t} for t in texts], ensure_ascii=False),
        json.dumps(meanings, ensure_ascii=False) if meanings is not None else None,
    )


class _FakeCursor:
    def __init__(self, rows):
        self._rows = rows
        self.executed = []

    def execute(self, sql, args=None):
        self.executed.append((sql, args))

    def fetchall(self):
        return self._rows

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _FakeConn:
    """只记 SQL、不连库：够跑 `_fetch_passages` 与那一条 UPDATE。"""

    def __init__(self, rows):
        self.cur = _FakeCursor(rows)
        self.committed = 0

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed += 1

    def close(self):
        pass


def _args(tmp_path, name="诗词含义.md"):
    class A:
        pass

    a = A()
    a.input = str(tmp_path / name)
    a.output_dir = str(tmp_path / "out")
    a.limit = None
    return a


def _config():
    class C:
        output_dir = None

    return C()


def _updates(conn):
    return [(s, a) for s, a in conn.cur.executed if s.startswith("UPDATE")]


def _review(tmp_path, name="诗词含义") -> str:
    return (tmp_path / "out" / "语文" / f"{name}-review.md").read_text(encoding="utf-8")


# ==================== 模板解析 / 按原文定位（已钉住的四条） ====================


def test_parse_template():
    got = parse_template(TEMPLATE)
    assert list(got) == ["酬乐天扬州初逢席上见赠"]
    entries = got["酬乐天扬州初逢席上见赠"]
    assert entries[0] == ("巴山楚水凄凉地，二十三年弃置身。", "写被贬之地的荒凉。", "辛酸")


def test_build_meanings_array_按原文定位下标():
    sentences = [
        {"text": "巴山楚水凄凉地，二十三年弃置身。"},
        {"text": "沉舟侧畔千帆过，病树前头万木春。"},
        {"text": "今日听君歌一曲，暂凭杯酒长精神。"},  # 人工没填这句
    ]
    entries = parse_template(TEMPLATE)["酬乐天扬州初逢席上见赠"]
    arr, skipped = build_meanings_array(sentences, entries)
    # 长度与 sentences 对齐；第 3 句没填 → null（不是压缩掉，否则整体错位）
    assert arr == [
        {"meaning": "写被贬之地的荒凉。", "emotion": "辛酸"},
        {"meaning": "比喻新事物必将取代旧事物。", "emotion": "豁达乐观"},
        None,
    ]
    assert skipped == []


def test_build_meanings_array_调序也不会错位():
    sentences = [
        {"text": "沉舟侧畔千帆过，病树前头万木春。"},
        {"text": "巴山楚水凄凉地，二十三年弃置身。"},
    ]
    entries = parse_template(TEMPLATE)["酬乐天扬州初逢席上见赠"]
    arr, _ = build_meanings_array(sentences, entries)
    assert arr[0]["emotion"] == "豁达乐观"   # 跟着原文走，不是跟着行号走
    assert arr[1]["emotion"] == "辛酸"


def test_build_meanings_array_对不上的原文进skipped():
    sentences = [{"text": "今日听君歌一曲，暂凭杯酒长精神。"}]
    entries = parse_template(TEMPLATE)["酬乐天扬州初逢席上见赠"]
    arr, skipped = build_meanings_array(sentences, entries)
    assert arr == [None]
    assert len(skipped) == 2


# ==================== 同篇名多行合并（九上/九下重复收录） ====================


class TestMergeGroup:
    def test_兄弟行填好的值补上基准行的空(self):
        # 基准行「甲。」是空的（上次 --apply 只写成了兄弟行 / 长度不等把基准行降级成空）
        row0 = _row(1, TITLE, ["甲。", "乙。"],
                    [None, {"meaning": "乙含义", "emotion": "乙情感"}])
        row1 = _row(2, TITLE, ["甲。", "乙。"],
                    [{"meaning": "甲含义", "emotion": "甲情感"},
                     {"meaning": "乙含义", "emotion": "乙情感"}])

        merged = cli._merge_group([row0, row1])

        assert merged == [("甲。", "甲含义", "甲情感"), ("乙。", "乙含义", "乙情感")]

    def test_按字段补齐_不覆盖基准行已有的值(self):
        row0 = _row(1, TITLE, ["甲。"], [{"meaning": "基准含义", "emotion": ""}])
        row1 = _row(2, TITLE, ["甲。"], [{"meaning": "兄弟含义", "emotion": "兄弟情感"}])

        # 基准行有含义 → 保留；情感是空 → 用兄弟行的补上
        assert cli._merge_group([row0, row1]) == [("甲。", "基准含义", "兄弟情感")]

    def test_基准行篇内重复原文不被合并掉(self):
        # 诗经那种重章叠句：同一段原文在基准行里出现两次，兄弟行只有一次
        row0 = _row(1, TITLE, ["甲。", "甲。"], [{"meaning": "一", "emotion": "一"}, None])
        row1 = _row(2, TITLE, ["甲。"], [{"meaning": "二", "emotion": "二"}])

        merged = cli._merge_group([row0, row1])

        assert len(merged) == 2                       # 兄弟行不额外多出一处
        assert merged[0] == ("甲。", "一", "一")

    def test_组_by_title_同名两行归一组(self):
        rows = [_row(1, TITLE, ["甲。"]), _row(2, TITLE, ["甲。"]), _row(3, "另一首", ["乙。"])]

        groups = cli._group_by_title(rows)

        assert [len(g) for g in groups] == [2, 1]

    def test_模板只出一段_且带出兄弟行的值(self):
        row0 = _row(1, TITLE, ["甲。"], [None])
        row1 = _row(2, TITLE, ["甲。"], [{"meaning": "甲含义", "emotion": "甲情感"}])

        md = cli.render_template([row0, row1])

        assert md.count(f"# {TITLE}") == 1            # 合并成一段，不重复列
        assert "含义：甲含义" in md and "情感：甲情感" in md


# ==================== --export 回填（修订路径不丢数据） ====================


class TestSentencePairsBackfill:
    def test_库里已填的含义随模板回填(self):
        row = _row(1, TITLE, ["甲。", "乙。"],
                   [{"meaning": "甲含义", "emotion": "甲情感"}, None])

        pairs = cli._sentence_pairs(row)
        assert pairs == [("甲。", "甲含义", "甲情感"), ("乙。", "", "")]

        md = cli.render_template([row])
        assert md.count("含义：") == 2                # 每句都有含义行
        assert "含义：甲含义" in md and "情感：甲情感" in md   # 已填的回填
        assert "含义：\n情感：" in md                  # 没填的仍是空

    def test_长度不等按无含义处理(self):
        # 与 meaning.service 的口径一致：长度不等 → 整篇按无含义，不回填半截数组
        row = _row(1, TITLE, ["甲。", "乙。"], [{"meaning": "只有一条", "emotion": "x"}])

        assert cli._sentence_pairs(row) == [("甲。", "", ""), ("乙。", "", "")]


# ==================== 三条防丢守卫 ====================


class TestAntiWipeGuards:
    def test_整篇全空不写库(self, tmp_path, monkeypatch):
        (tmp_path / "诗词含义.md").write_text(
            "# 岳阳楼记\n\n## 第1句\n> 甲。\n含义：\n情感：\n", encoding="utf-8")
        conn = _FakeConn([_row(11, "岳阳楼记", ["甲。"])])
        monkeypatch.setattr(cli, "_connect", lambda config: conn)

        assert cli.run_apply(_args(tmp_path), _config()) == 1
        assert _updates(conn) == []                   # 一句都没写 → 库里一字不动
        assert "没填、不入库" in _review(tmp_path)

    def test_对不上的原文进过目清单_跳过_不猜(self, tmp_path, monkeypatch):
        (tmp_path / "诗词含义.md").write_text(
            "# 岳阳楼记\n\n## 第1句\n> 另一句。\n含义：含义A\n情感：情感A\n", encoding="utf-8")
        conn = _FakeConn([_row(11, "岳阳楼记", ["甲。"])])
        monkeypatch.setattr(cli, "_connect", lambda config: conn)

        assert cli.run_apply(_args(tmp_path), _config()) == 1
        assert _updates(conn) == []                   # 不猜下标、不硬塞
        review = _review(tmp_path)
        assert "另一句。" in review and "定位不到" in review

    def test_一行都写不成的行不写库(self, tmp_path, monkeypatch):
        (tmp_path / "诗词含义.md").write_text(
            "# 岳阳楼记\n\n## 第1句\n> 甲。\n含义：含义A\n情感：情感A\n", encoding="utf-8")
        conn = _FakeConn([
            _row(11, "岳阳楼记", ["甲。"]),           # 能对上 → 写
            _row(12, "岳阳楼记", ["丙。"]),           # 兄弟行对不上任何条目 → 不写
        ])
        monkeypatch.setattr(cli, "_connect", lambda config: conn)

        assert cli.run_apply(_args(tmp_path), _config()) == 0
        updates = _updates(conn)
        assert len(updates) == 1                      # 只写对得上的那行
        assert updates[0][1][1] == 11
        assert json.loads(updates[0][1][0])[0]["meaning"] == "含义A"
        assert "一行都没写成" in _review(tmp_path)


# ==================== 只写一列（人工标定不可被重跑刷掉） ====================


def test_UPDATE_SQL_不碰人工标定的三列():
    assert cli._UPDATE_SQL == "UPDATE chinese_passages SET sentence_meanings = %s WHERE id = %s"
    for col in ("verified", "is_active", "memorize_required"):
        assert col not in cli._UPDATE_SQL


# ==================== 用户手写文档格式（--input 的第二种格式） ====================

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


def test_parse_uidoc_篇名括号里没有间隔号时原样保留():
    # 「水调歌头(明月几时有)（宋·苏轼）」：只剥尾部的作者括号，
    # 词牌后那个副题括号里没有 `·`，剥掉就对不上库里的篇名了。
    got = parse_uidoc("## 水调歌头(明月几时有)（宋·苏轼）\n\n### 明月几时有？\n"
                      "#### 深层含义\n劈头一问。\n#### 情感\n迷惘与好奇。\n")
    assert list(got) == ["水调歌头(明月几时有)"]


def test_parse_uidoc_分篇横线不粘进字段正文():
    # 真实文档用 `---` 分篇；不跳过它就会粘到上一句「情感」的尾巴上
    got = parse_uidoc("## 甲（唐·乙）\n\n### 甲句。\n#### 深层含义\n含义甲。\n"
                      "#### 情感\n情感甲。\n\n---\n\n## 丙\n\n### 丙句。\n"
                      "#### 深层含义\n含义丙。\n#### 情感\n情感丙。\n")
    assert got == {"甲": [("甲句。", "含义甲。", "情感甲。")],
                   "丙": [("丙句。", "含义丙。", "情感丙。")]}


def test_parse_input_自动识别两种格式():
    assert parse_input(UIDOC) == parse_uidoc(UIDOC)          # 手写文档 → uidoc
    assert parse_input(TEMPLATE) == parse_template(TEMPLATE)  # 自家模板 → template


def test_apply_的_UPDATE_语句只动_sentence_meanings():
    from src.meaning_cli import _UPDATE_SQL
    for banned in ("key_terms", "verified", "is_active", "memorize_required"):
        assert banned not in _UPDATE_SQL


def test_run_apply_喂手写文档也入库_且不写关键字词(tmp_path, monkeypatch):
    """Step 4 的接线钉子：`--apply` 读用户手写文档时，走的就是 uidoc 解析。"""
    (tmp_path / "诗词含义.md").write_text(UIDOC, encoding="utf-8")
    conn = _FakeConn([_row(11, TITLE, ["巴山楚水凄凉地，二十三年弃置身。",
                                       "沉舟侧畔千帆过，病树前头万木春。"])])
    monkeypatch.setattr(cli, "_connect", lambda config: conn)

    assert cli.run_apply(_args(tmp_path), _config()) == 0
    updates = _updates(conn)
    assert len(updates) == 1
    assert updates[0][0] == cli._UPDATE_SQL          # 只 UPDATE sentence_meanings
    written = json.loads(updates[0][1][0])
    assert written[0]["meaning"] == "以「凄凉地」与「二十三年」两个时空坐标，把半生贬谪一笔写尽。"
    assert "关键字词" not in updates[0][1][0]
    assert "巴山楚水：诗人曾被贬" not in updates[0][1][0]   # key_terms 内容一个字都不写
