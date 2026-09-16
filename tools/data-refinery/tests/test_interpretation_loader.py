"""interpretation_loader 单测：用假连接，不碰真库。

核心钉两件事：
1. **只 SET 三列内容列**——`verified` / `memorize_required` / `is_active` 在语句里
   根本不出现（管线重跑不得刷掉内容校验结果与人工标定，默写 loader 栽过一次）；
2. **不 INSERT**——解释内容必须建在库里已校验的正文之上，篇名找不到时报错跳过。
"""

import json

from interpretation_loader import InterpretationLoader

BODY = "庆历四年春，滕子京谪守巴陵郡。越明年，政通人和。"

ITEM = {
    "work_title": "岳阳楼记",
    "semester": "上册",
    "key_terms": [{"term": "谪守", "gloss": "因罪贬谪流放", "src": "user", "sentenceIndex": 0}],
    "sentences": [
        {"text": "庆历四年春，滕子京谪守巴陵郡。", "translation": "庆历四年的春天，滕子京被贬到巴陵郡做太守。"},
        {"text": "越明年，政通人和。", "translation": "到了第二年，政事顺利，百姓和乐。"},
    ],
    "full_translation": "庆历四年的春天……到了第二年……",
}


class _FakeCursor:
    def __init__(self, scripted):
        self._scripted = scripted
        self.executed = []
        self._last = []

    def execute(self, sql, args=None):
        self.executed.append((sql, args))
        for pat, rows in self._scripted:
            if pat in sql:
                self._last = rows
                return
        self._last = []

    def fetchall(self):
        return self._last

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def close(self):
        pass


class _FakeConn:
    def __init__(self, scripted):
        self.cur = _FakeCursor(scripted)
        self.committed = 0

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed += 1


def _loader(scripted):
    loader = InterpretationLoader.__new__(InterpretationLoader)   # 绕过真实连接
    loader._conn = _FakeConn(scripted)
    return loader


def _sqls(loader):
    return [s for s, _ in loader._conn.cur.executed]


def _row(source_ref="PIPELINE", semester="上册", title="岳阳楼记", row_id=11, body=None):
    """`_resolve_rows` 的取行语句选 5 列：(id, semester, body, source_ref, work_title)。"""
    return [(row_id, semester, BODY if body is None else body, source_ref, title)]


class TestOnlyContentColumns:
    def test_update_sets_exactly_three_columns(self):
        loader = _loader([("FROM chinese_passages", _row())])
        loader.load_passages([ITEM])
        update = [s for s in _sqls(loader) if s.startswith("UPDATE")][0]
        assert "key_terms=%s" in update
        assert "sentences=%s" in update
        assert "full_translation=%s" in update

    def test_never_touches_verified_or_flags(self):
        # 管线重跑不得把用户的「必背」与「停用」标定刷掉，也不得改写内容校验结果
        loader = _loader([("FROM chinese_passages", _row())])
        loader.load_passages([ITEM])
        update = [s for s in _sqls(loader) if s.startswith("UPDATE")][0]
        assert "verified" not in update
        assert "memorize_required" not in update
        assert "is_active" not in update

    def test_never_inserts(self):
        # 解释内容必须建在库里已校验的正文之上；凭空 INSERT 会造出没有正文的行
        loader = _loader([("FROM chinese_passages", _row())])
        loader.load_passages([ITEM])
        assert not any(s.strip().startswith("INSERT") for s in _sqls(loader))

    def test_never_writes_questions(self):
        loader = _loader([("FROM chinese_passages", _row())])
        loader.load_passages([ITEM])
        assert not any("questions" in s for s in _sqls(loader))


class TestJsonSerialization:
    def test_json_columns_are_dumped_as_strings(self):
        # pymysql 不做序列化：直接传 list 会变成非法参数
        loader = _loader([("FROM chinese_passages", _row())])
        loader.load_passages([ITEM])
        args = [a for s, a in loader._conn.cur.executed if s.startswith("UPDATE")][0]
        key_terms, sentences = args[0], args[1]
        assert json.loads(key_terms) == ITEM["key_terms"]
        assert json.loads(sentences) == ITEM["sentences"]
        assert json.loads(key_terms)[0]["sentenceIndex"] == 0

    def test_ensure_ascii_false(self):
        loader = _loader([("FROM chinese_passages", _row())])
        loader.load_passages([ITEM])
        args = [a for s, a in loader._conn.cur.executed if s.startswith("UPDATE")][0]
        assert "谪守" in args[0]          # 没被转成 \uXXXX


class TestLookup:
    def test_resolves_by_normalized_title(self):
        # 库里 `行路难(其一)` 是半角，输入稿常写全角 `行路难（其一）`
        loader = _loader([("FROM chinese_passages", _row(title="行路难(其一)"))])
        stats = loader.load_passages([{**ITEM, "work_title": "行路难（其一）"}])
        assert stats["updated"] == 1

    def test_cipai_only_matches_title_with_subtitle(self):
        # 用户只给词牌名（水调歌头），库里带题目括号（水调歌头(明月几时有)）
        loader = _loader([("FROM chinese_passages", _row(title="水调歌头(明月几时有)"))])
        stats = loader.load_passages([{**ITEM, "work_title": "水调歌头"}])
        assert stats["updated"] == 1

    def test_semester_filters_to_that_row(self):
        rows = _row(row_id=11, semester="上册") + _row(row_id=12, semester="下册")
        loader = _loader([("FROM chinese_passages", rows)])
        loader.load_passages([ITEM])          # ITEM.semester == 上册
        updates = [a for s, a in loader._conn.cur.executed if s.startswith("UPDATE")]
        assert len(updates) == 1 and updates[0][3] == 11

    def test_two_rows_without_semester_both_written_with_warning(self):
        # 九上/九下重复收录 9 篇：未给册次时两行都写（各自正文可能不同）
        rows = _row(row_id=11, semester="上册") + _row(row_id=12, semester="下册")
        loader = _loader([("FROM chinese_passages", rows)])
        stats = loader.load_passages([{**ITEM, "semester": None}])
        assert stats["updated"] == 2
        assert any("逐行都写" in w for w in stats["warnings"])

    def test_missing_title_skipped_with_near_titles(self):
        loader = _loader([
            ("LIKE", [("岳阳楼记",), ("醉翁亭记",)]),
            ("FROM chinese_passages", []),
        ])
        stats = loader.load_passages([ITEM])
        assert stats["updated"] == 0
        assert len(stats["skipped"]) == 1
        assert "岳阳楼记" in stats["skipped"][0] and "醉翁亭记" in stats["skipped"][0]


class TestGuards:
    def test_join_mismatch_against_db_body_refuses(self):
        # 切句拼不回**这一行**的正文 → 拒绝写入（可能册次给错了：句子来自另一册）
        loader = _loader([("FROM chinese_passages", _row(body="完全不同的正文。"))])
        stats = loader.load_passages([ITEM])
        assert stats["updated"] == 0
        assert any("拼不回该行正文" in s for s in stats["skipped"])

    def test_dev_fixture_overwrite_warns(self):
        loader = _loader([("FROM chinese_passages", _row("DEV-FIXTURE"))])
        stats = loader.load_passages([ITEM])
        assert stats["updated"] == 1
        assert any("DEV-FIXTURE" in w and "岳阳楼记" in w for w in stats["warnings"])

    def test_commits(self):
        loader = _loader([("FROM chinese_passages", _row())])
        loader.load_passages([ITEM])
        assert loader._conn.committed == 1


class TestReadJsonl:
    def test_reads_rows_and_skips_blank_lines(self, tmp_path):
        p = tmp_path / "a.jsonl"
        p.write_text(json.dumps(ITEM, ensure_ascii=False) + "\n\n", encoding="utf-8")
        rows = InterpretationLoader.read_jsonl(p)
        assert len(rows) == 1 and rows[0]["work_title"] == "岳阳楼记"

    def test_ignores_underscore_keys(self, tmp_path):
        p = tmp_path / "a.jsonl"
        row = {**ITEM, "_passage_id": 11, "_source_ref": "PIPELINE"}
        p.write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")
        assert InterpretationLoader.read_jsonl(p)[0]["work_title"] == "岳阳楼记"
