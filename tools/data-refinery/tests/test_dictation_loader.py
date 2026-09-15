"""dictation_loader 单测：用假连接，不碰真库。

核心是钉住**幂等策略**：以 `chinese_passages` 的业务键 `(work_title, semester)` 为身份，
命中既有篇目就**原地 UPDATE**（不插重复行）。
另钉三条容易被后续改动破坏的约定：
- **不写 `questions` 表**（2026-09-15 独立化：古诗文专项不挂 questions）；
- `memorize_required` **不得**被 upsert 覆盖（否则重跑会把用户标好的必背刷回 0）；
- `verified` 由 JSONL 决定，不写死。
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


class TestNoQuestionsWrites:
    """独立化的核心：整条链路不得再碰 questions。"""

    def test_never_writes_questions(self):
        scripted = [("FROM chinese_passages", [])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        sqls = _sqls(loader)
        assert not any("questions" in s for s in sqls), sqls

    def test_never_reads_subjects(self):
        # subject_id 谓词随独立化取消（表本身就是语文），故不必再查 subjects
        scripted = [("FROM chinese_passages", [])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        assert not any("FROM subjects" in s for s in _sqls(loader))


class TestIdempotency:
    def test_existing_passage_updates_in_place(self):
        scripted = [("FROM chinese_passages", [(5036, "PIPELINE")])]
        loader = _loader(scripted)
        stats = loader.load_passages([ITEM])
        assert any("INSERT INTO chinese_passages" in s for s in _sqls(loader))
        assert stats == {"passages_upserted": 1}
        assert loader._conn.committed >= 1

    def test_upsert_has_no_question_id(self):
        scripted = [("FROM chinese_passages", [(5036, "PIPELINE")])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        upsert = [s for s in _sqls(loader) if "INSERT INTO chinese_passages" in s][0]
        assert "question_id" not in upsert

    def test_dev_fixture_row_is_warned(self, capsys):
        # 开发假数据必须能被真实内容覆盖，且明确告警（不能静默覆盖）
        scripted = [("FROM chinese_passages", [(5036, "DEV-FIXTURE")])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        out = capsys.readouterr().out
        assert "DEV-FIXTURE" in out and "岳阳楼记" in out

    def test_memorize_required_never_overwritten(self):
        # 重跑不得把用户已标的必背刷回 0
        scripted = [("FROM chinese_passages", [(5036, "PIPELINE")])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        upsert = [s for s in _sqls(loader) if "INSERT INTO chinese_passages" in s][0]
        assert "memorize_required=VALUES" not in upsert.replace(" ", "")
        assert "ON DUPLICATE KEY UPDATE" in upsert

    def test_verified_is_written_from_item(self):
        scripted = [("FROM chinese_passages", [])]
        loader = _loader(scripted)
        loader.load_passages([{**ITEM, "verified": 0}])
        upsert = [a for s, a in loader._conn.cur.executed if "INSERT INTO chinese_passages" in s][0]
        # 参数顺序：[work_title, author, dynasty, body, grade_band, grade, semester,
        #           sort_order, source_ref, verified]
        assert upsert[9] == 0

    def test_business_key_lookup_uses_title_and_semester(self):
        scripted = [("FROM chinese_passages", [])]
        loader = _loader(scripted)
        loader.load_passages([ITEM])
        lookup = [a for s, a in loader._conn.cur.executed if "FROM chinese_passages" in s][0]
        assert lookup == ("岳阳楼记", "上册")


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
