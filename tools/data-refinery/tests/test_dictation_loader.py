"""dictation_loader 单测：用假连接，不碰真库。

核心是钉住**幂等策略**：以 `dictation_passages` 的业务键 `(work_title, semester)` 为身份，
命中既有篇目就**复用其 question_id 并原地 UPDATE**（不插重复行）。
另钉两条容易被后续改动破坏的约定：
- `memorize_required` **不得**被 upsert 覆盖（否则重跑会把用户标好的必背刷回 0）；
- 题面只放篇名（`请默写《X》`），作者/朝代/正文放 `answer`。
"""

import json

from dictation_loader import DictationLoader


class _FakeCursor:
    """按 (子串, 返回行) 脚本应答的假游标；记录所有执行过的 SQL。"""

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


ITEM = {
    "subject_id": "chinese",
    "work_title": "岳阳楼记",
    "author": "范仲淹",
    "dynasty": "宋",
    "body": "庆历四年春，滕子京谪守巴陵郡。",
    "semester": "上册",
    "grade_band": "junior",
    "grade": "九年级",
    "source_ref": "统编版语文九年级上册 P46-49",
    "verified": 1,
    "_sort_order": 1,
}


def _loader(scripted):
    loader = DictationLoader.__new__(DictationLoader)   # 绕过真实连接
    loader._conn = _FakeConn(scripted)
    return loader


def _sqls(loader):
    return [s for s, _ in loader._conn.cur.executed]


class TestIdempotency:
    def test_existing_passage_reuses_question_and_updates_in_place(self):
        scripted = [
            ("FROM subjects", [(2,)]),
            ("FROM dictation_passages dp", [(5036, "PIPELINE")]),
        ]
        loader = _loader(scripted)
        stats = loader.load_passages([ITEM])

        sqls = _sqls(loader)
        assert any(s.strip().upper().startswith("UPDATE QUESTIONS") for s in sqls)
        assert not any("INSERT INTO questions" in s for s in sqls)
        assert stats == {"inserted": 0, "updated": 1, "passages_upserted": 1}
        assert loader._conn.committed >= 1

    def test_existing_question_id_is_reused_in_passage_upsert(self):
        scripted = [("FROM subjects", [(2,)]), ("FROM dictation_passages dp", [(5036, "PIPELINE")])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        upsert = [a for s, a in loader._conn.cur.executed if "INSERT INTO dictation_passages" in s][0]
        assert upsert[0] == 5036          # 复用既有 question_id，没新建

    def test_new_passage_inserts_question_then_upserts_passage(self):
        scripted = [
            ("FROM subjects", [(2,)]),
            ("FROM dictation_passages dp", []),        # 业务键未命中
            ("LAST_INSERT_ID", [(7001,)]),
        ]
        loader = _loader(scripted)
        stats = loader.load_passages([ITEM])

        sqls = _sqls(loader)
        assert any("INSERT INTO questions" in s for s in sqls)
        assert any("INSERT INTO dictation_passages" in s for s in sqls)
        assert stats == {"inserted": 1, "updated": 0, "passages_upserted": 1}
        upsert = [a for s, a in loader._conn.cur.executed if "INSERT INTO dictation_passages" in s][0]
        assert upsert[0] == 7001

    def test_dev_fixture_row_is_warned_and_overwritten(self, capsys):
        # 开发假数据必须能被真实内容覆盖，且明确告警（不能静默覆盖）
        scripted = [("FROM subjects", [(2,)]), ("FROM dictation_passages dp", [(5036, "DEV-FIXTURE")])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        out = capsys.readouterr().out
        assert "DEV-FIXTURE" in out and "岳阳楼记" in out

    def test_memorize_required_never_overwritten(self):
        # 重跑不得把用户已标的必背刷回 0
        scripted = [("FROM subjects", [(2,)]), ("FROM dictation_passages dp", [(5036, "PIPELINE")])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        upsert = [s for s in _sqls(loader) if "INSERT INTO dictation_passages" in s][0]
        assert "memorize_required=VALUES" not in upsert.replace(" ", "")
        assert "ON DUPLICATE KEY UPDATE" in upsert

    def test_verified_is_written_from_item(self):
        scripted = [("FROM subjects", [(2,)]), ("FROM dictation_passages dp", []),
                    ("LAST_INSERT_ID", [(7001,)])]
        loader = _loader(scripted)
        loader.load_passages([{**ITEM, "verified": 0}])
        upsert = [a for s, a in loader._conn.cur.executed if "INSERT INTO dictation_passages" in s][0]
        # verified 在参数里的倒数第二位（memorize_required 固定 0 在 SQL 字面量中）
        assert 0 in upsert


class TestContentConvention:
    def test_question_content_uses_prompt_convention(self):
        scripted = [("FROM subjects", [(2,)]), ("FROM dictation_passages dp", []),
                    ("LAST_INSERT_ID", [(7001,)])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        ins = [a for s, a in loader._conn.cur.executed if "INSERT INTO questions" in s][0]
        assert "请默写《岳阳楼记》" in ins
        assert "并写出" not in str(ins)          # 上一阶段删掉的噪音文案不得回归

    def test_answer_has_three_labelled_lines(self):
        scripted = [("FROM subjects", [(2,)]), ("FROM dictation_passages dp", []),
                    ("LAST_INSERT_ID", [(7001,)])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        ins = [a for s, a in loader._conn.cur.executed if "INSERT INTO questions" in s][0]
        assert any(str(x).startswith("作者：范仲淹") for x in ins)
        assert any("朝代：宋" in str(x) for x in ins)
        assert any("正文：庆历四年春" in str(x) for x in ins)

    def test_empty_author_dynasty_do_not_crash(self):
        scripted = [("FROM subjects", [(2,)]), ("FROM dictation_passages dp", []),
                    ("LAST_INSERT_ID", [(7001,)])]
        loader = _loader(scripted)
        loader.load_passages([{**ITEM, "author": "", "dynasty": ""}])
        ins = [a for s, a in loader._conn.cur.executed if "INSERT INTO questions" in s][0]
        assert any(str(x).startswith("作者：") for x in ins)

    def test_question_type_is_poem_dictation(self):
        scripted = [("FROM subjects", [(2,)]), ("FROM dictation_passages dp", []),
                    ("LAST_INSERT_ID", [(7001,)])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        ins_sql = [s for s in _sqls(loader) if "INSERT INTO questions" in s][0]
        assert "poem_dictation" in ins_sql

    def test_unknown_subject_code_raises(self):
        loader = _loader([("FROM subjects", [])])
        try:
            loader.load_passages([ITEM])
        except ValueError as e:
            assert "chinese" in str(e)
        else:
            raise AssertionError("未在 subjects 找到 code 时应抛 ValueError")


class TestReadJsonl:
    def test_reads_rows_and_skips_blank_lines(self, tmp_path):
        p = tmp_path / "a.jsonl"
        p.write_text(json.dumps(ITEM, ensure_ascii=False) + "\n\n", encoding="utf-8")
        rows = DictationLoader.read_jsonl(p)
        assert len(rows) == 1 and rows[0]["work_title"] == "岳阳楼记"

    def test_ignores_underscore_keys(self, tmp_path):
        # JSONL 里带 `_locate_notes` / `_repair_note` 等内部字段，入库只取契约字段即可
        p = tmp_path / "a.jsonl"
        row = {**ITEM, "_locate_notes": ["跳过编者导语"], "_repair_note": ""}
        p.write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")
        assert DictationLoader.read_jsonl(p)[0]["work_title"] == "岳阳楼记"
