"""interpretation_cli 单测：编排逻辑（全部用假连接与假模型，不碰真库、不调真 LLM）。

钉住四件事：
- 译文**混合模式**：输入给了就不调模型，没给才调；
- 字词定位不到就丢弃并告警；
- `--export` 的产出形状（可编辑字段留空、只读参考进 `_ref`）；
- `--apply` **只回写被改过的行**，且改坏的稿子（自检不过）拒绝写库。
"""

import json

import interpretation_cli as cli
from interpretation_input import InputKeyTerm, InputSentence, PassageInput

BODY = "庆历四年春，滕子京谪守巴陵郡。越明年，政通人和。"
ROW = (11, "上册", BODY, "PIPELINE", "岳阳楼记")


class _FakeCursor:
    def __init__(self, scripted):
        self._scripted = scripted
        self.executed = []
        self._last = []
        self._insert_id = 0

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

    def close(self):
        pass


class _FakeLLM:
    def __init__(self, content="{}", model="fake-model"):
        self.content = content
        self.model = model
        self.calls = []

    def complete(self, system_prompt, user_prompt):
        self.calls.append((system_prompt, user_prompt))

        class R:
            pass

        r = R()
        r.content = self.content
        return r


def _passage(**overrides):
    kwargs = dict(
        work_title="岳阳楼记",
        semester="上册",
        key_terms=[InputKeyTerm(term="谪守", gloss="因罪贬谪流放，出任外官")],
    )
    kwargs.update(overrides)
    return PassageInput(**kwargs)


class TestResolveSentences:
    def test_user_provided_texts_and_translations_win(self):
        p = _passage(sentences=[
            InputSentence(text="庆历四年春，滕子京谪守巴陵郡。", translation="T1"),
            InputSentence(text="越明年，政通人和。", translation="T2"),
        ])
        texts, given, warns = cli._resolve_sentences(p, BODY)
        assert texts == ["庆历四年春，滕子京谪守巴陵郡。", "越明年，政通人和。"]
        assert given == ["T1", "T2"]
        assert warns == []

    def test_no_sentences_uses_program_split(self):
        texts, given, _ = cli._resolve_sentences(_passage(), BODY)
        assert texts == ["庆历四年春，滕子京谪守巴陵郡。", "越明年，政通人和。"]
        assert given is None

    def test_translations_without_texts_aligned_by_position(self):
        p = _passage(sentences=[InputSentence(text="", translation="T1"), InputSentence(text="", translation="T2")])
        texts, given, warns = cli._resolve_sentences(p, BODY)
        assert len(texts) == 2 and given == ["T1", "T2"]
        assert any("位置对齐" in w for w in warns)

    def test_translation_count_mismatch_falls_back_to_model(self):
        p = _passage(sentences=[InputSentence(text="", translation="只有一句")])
        texts, given, warns = cli._resolve_sentences(p, BODY)
        assert given is None
        assert any("条数不符" in w for w in warns)


class TestProcessPassage:
    def _run(self, p, conn_rows, translate=None):
        conn = _FakeConn([("SELECT id, semester, body, source_ref, work_title", conn_rows)])
        calls = []

        def fake_translate(primary, fallback, **kwargs):
            calls.append(kwargs)
            return translate or type("R", (), {
                "translations": ["译文1", "译文2"],
                "full_translation": "整篇译文",
                "source": "local:fake",
                "attempts": [],
                "error": None,
            })()

        orig = cli.translate_passage
        cli.translate_passage = fake_translate
        try:
            items, errors, warns = cli.process_passage(
                conn, p, primary_llm=None, fallback_llm=None, translate_prompt="P",
            )
        finally:
            cli.translate_passage = orig
        return items, errors, warns, calls

    def test_translation_generated_when_not_provided(self):
        items, errors, warns, calls = self._run(_passage(), [ROW])
        assert errors == []
        assert len(calls) == 1
        assert items[0]["sentences"][0]["translation"] == "译文1"
        assert items[0]["full_translation"] == "整篇译文"
        assert any("译文来自" in w for w in warns)

    def test_translation_from_input_does_not_call_model(self):
        p = _passage(sentences=[
            InputSentence(text="庆历四年春，滕子京谪守巴陵郡。", translation="输入的译文1"),
            InputSentence(text="越明年，政通人和。", translation="输入的译文2"),
        ])
        items, errors, warns, calls = self._run(p, [ROW])
        assert calls == []                                  # 一次模型调用都没有
        assert items[0]["sentences"][0]["translation"] == "输入的译文1"
        assert items[0]["full_translation"] == "输入的译文1输入的译文2"

    def test_unlocatable_term_dropped_with_warning(self):
        p = _passage(key_terms=[
            InputKeyTerm(term="谪守", gloss="g1"),
            InputKeyTerm(term="岳阳楼记", gloss="标题里的词"),
        ])
        items, errors, warns, _ = self._run(p, [ROW])
        assert [t["term"] for t in items[0]["key_terms"]] == ["谪守"]
        assert any("丢弃字词「岳阳楼记」" in w for w in warns)

    def test_missing_title_yields_error(self):
        conn = _FakeConn([
            ("LIKE", [("岳阳楼记",)]),
            ("SELECT id, semester, body, source_ref, work_title", []),
        ])
        items, errors, _ = cli.process_passage(
            conn, _passage(work_title="岳阳"), primary_llm=None, fallback_llm=None, translate_prompt="P",
        )
        assert items == []
        assert any("在库里找不到" in e for e in errors)

    def test_translate_failure_is_fatal(self):
        bad = type("R", (), {
            "translations": None, "full_translation": None,
            "source": None, "attempts": [], "error": "两个模型都挂了",
        })()
        items, errors, _, _ = self._run(_passage(), [ROW], translate=bad)
        assert items == []
        assert any("译文生成失败" in e for e in errors)

    def test_two_rows_without_semester_produce_two_items(self):
        p = _passage(semester=None)
        items, errors, warns, _ = self._run(
            p, [(11, "上册", BODY, "P", "岳阳楼记"), (12, "下册", BODY, "P", "岳阳楼记")],
        )
        assert [i["semester"] for i in items] == ["上册", "下册"]
        assert any("逐行分别处理" in w for w in warns)

    def test_dev_fixture_overwrite_warned(self):
        items, _, warns, _ = self._run(_passage(), [(11, "上册", BODY, "DEV-FIXTURE", "岳阳楼记")])
        assert len(items) == 1
        assert any("DEV-FIXTURE" in w for w in warns)


class TestRenderReview:
    def test_sections_present(self):
        md = cli.render_review(
            [{"work_title": "岳阳楼记", "semester": "上册", "_passage_id": 11,
              "key_terms": [{"term": "谪守", "sentenceIndex": 0}],
              "sentences": [{"text": "甲。", "translation": "T"}],
              "full_translation": "全文"}],
            errors=["《X》拼不回正文"],
            warnings=["《Y》丢弃字词「z」"],
        )
        assert "## 通过" in md
        assert "## 未通过" in md
        assert "## 告警" in md
        assert "《岳阳楼记》" in md and "拼不回正文" in md and "丢弃字词" in md

    def test_no_error_section_when_clean(self):
        md = cli.render_review([], errors=[], warnings=[])
        assert "## 未通过" not in md


def _args(tmp_path, name="words.md"):
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
    c = C()
    c.output_dir = None
    return c


class TestExportApply:
    def test_export_shape(self, tmp_path):
        # 可编辑字段留空、只读参考进 _ref（照 answer_importer 的约定）
        args = _args(tmp_path)
        args.output_dir = str(tmp_path / "out")
        conn = _FakeConn([("SELECT id, work_title, semester, body", [
            (11, "岳阳楼记", "上册", BODY,
             json.dumps([{"term": "谪守", "gloss": "g", "sentenceIndex": 0}], ensure_ascii=False),
             json.dumps([{"text": "甲。", "translation": "T"}], ensure_ascii=False),
             "全文"),
        ])])
        cli._connect = lambda config: conn
        assert cli.run_export(args, _config()) == 0

        row = json.loads((tmp_path / "out").joinpath("语文", "words.jsonl").read_text(encoding="utf-8").strip())
        assert row["key_terms"] == [] and row["sentences"] == [] and row["full_translation"] == ""
        assert row["_ref"]["passage_id"] == 11
        assert row["_ref"]["key_terms"][0]["term"] == "谪守"
        assert row["_ref"]["body"] == BODY

    def test_apply_writes_only_changed_rows(self, tmp_path):
        path = tmp_path / "out" / "语文" / "words.jsonl"
        path.parent.mkdir(parents=True)
        ref = {
            "passage_id": 11, "body": BODY,
            "key_terms": [{"term": "谪守", "gloss": "旧释义", "sentenceIndex": 0}],
            "sentences": [
                {"text": "庆历四年春，滕子京谪守巴陵郡。", "translation": "旧译1"},
                {"text": "越明年，政通人和。", "translation": "旧译2"},
            ],
            "full_translation": "旧全文",
        }
        unchanged = {"work_title": "岳阳楼记", "semester": "上册",
                     "key_terms": [], "sentences": [], "full_translation": "", "_ref": ref}
        changed = json.loads(json.dumps(unchanged))
        changed["key_terms"] = [{"term": "谪守", "gloss": "新释义", "sentenceIndex": 0}]
        path.write_text(
            json.dumps(unchanged, ensure_ascii=False) + "\n" + json.dumps(changed, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

        args = _args(tmp_path)
        args.output_dir = str(tmp_path / "out")
        conn = _FakeConn([])
        cli._connect = lambda config: conn
        assert cli.run_apply(args, _config()) == 0
        updates = [a for s, a in conn.cur.executed if s.startswith("UPDATE")]
        assert len(updates) == 1, updates          # 没改的那行不写库
        assert json.loads(updates[0][0])[0]["gloss"] == "新释义"

    def test_apply_refuses_broken_draft(self, tmp_path):
        # 校对稿改坏了（字词定位不到 / 拼不回正文）必须拒绝写库，不能把坏数据灌进去
        path = tmp_path / "out" / "语文" / "words.jsonl"
        path.parent.mkdir(parents=True)
        ref = {
            "passage_id": 11, "body": BODY,
            "key_terms": [], "sentences": [{"text": BODY, "translation": "T"}],
            "full_translation": "全文",
        }
        broken = json.loads(json.dumps({"work_title": "岳阳楼记", "semester": "上册",
                                        "key_terms": [], "sentences": [], "full_translation": "",
                                        "_ref": ref}))
        broken["sentences"] = [{"text": "只写了半句。", "translation": "T"}]
        path.write_text(json.dumps(broken, ensure_ascii=False) + "\n", encoding="utf-8")

        args = _args(tmp_path)
        args.output_dir = str(tmp_path / "out")
        conn = _FakeConn([])
        cli._connect = lambda config: conn
        assert cli.run_apply(args, _config()) == 0
        assert [s for s, _ in conn.cur.executed if s.startswith("UPDATE")] == []


class TestTitleMatching:
    """篇名匹配（库里格式不统一，人手写几乎不可能全对）。

    实测：库里 `行路难(其一)` 是半角、`山坡羊 · 潼关怀古` 的 `·` 两侧有空格、
    用户输入稿写的是 `行路难（其一）`（全角）、`水调歌头`（只给词牌名）。
    """

    ROWS = [
        (1, "上册", BODY, "P", "行路难(其一)"),
        (2, "上册", BODY, "P", "山坡羊 · 潼关怀古"),
        (3, "上册", BODY, "P", "水调歌头(明月几时有)"),
        (4, "下册", BODY, "P", "水调歌头(明月几时有)"),
        (5, "上册", BODY, "P", "丑奴儿·书博山道中壁"),
    ]

    def _conn(self):
        return _FakeConn([("SELECT id, semester, body, source_ref, work_title", self.ROWS)])

    def test_fullwidth_parens_match_halfwidth(self):
        hits = cli._find_rows(self._conn(), "行路难（其一）", None)
        assert [h[0] for h in hits] == [1]

    def test_spaces_around_middle_dot_ignored(self):
        assert [h[0] for h in cli._find_rows(self._conn(), "山坡羊·潼关怀古", None)] == [2]

    def test_cipai_only_matches_title_with_subtitle(self):
        # 用户只给词牌名，库里带题目括号
        assert [h[0] for h in cli._find_rows(self._conn(), "水调歌头", None)] == [3, 4]

    def test_cipai_only_respects_semester(self):
        assert [h[0] for h in cli._find_rows(self._conn(), "水调歌头", "下册")] == [4]

    def test_unknown_title_returns_empty(self):
        assert cli._find_rows(self._conn(), "不存在的篇目", None) == []

    def test_near_titles_lists_same_initial(self):
        assert "水调歌头(明月几时有)" in cli._near_titles(self._conn(), "水调阁")


class TestMainDispatch:
    """四个动作互斥：只给一个就必须只跑那一个。

    （曾经踩过：`--extract` 成功后没 return，穿透到 `run_apply`，
     于是 `--extract` 会顺带做一次回写——把「只出 JSONL 不写库」的承诺打破。）
    """

    def _patch(self, monkeypatch):
        calls = []
        monkeypatch.setattr(cli, "RefineryConfig", type("C", (), {"from_env": staticmethod(lambda: None)}))
        for name in ("run_extract", "run_load", "run_export", "run_apply"):
            monkeypatch.setattr(cli, name, (lambda n: (lambda args, config: calls.append(n) or 0))(name))
        return calls

    def test_extract_alone_does_not_apply(self, monkeypatch, tmp_path):
        calls = self._patch(monkeypatch)
        assert cli.main(["--extract", "--input", str(tmp_path / "a.md")]) == 0
        assert calls == ["run_extract"], calls

    def test_load_alone_only_loads(self, monkeypatch, tmp_path):
        calls = self._patch(monkeypatch)
        cli.main(["--load", "--input", str(tmp_path / "a.md")])
        assert calls == ["run_load"], calls

    def test_all_runs_extract_then_load(self, monkeypatch, tmp_path):
        calls = self._patch(monkeypatch)
        cli.main(["--all", "--input", str(tmp_path / "a.md")])
        assert calls == ["run_extract", "run_load"], calls

    def test_extract_failure_stops_before_load(self, monkeypatch, tmp_path):
        calls = []
        monkeypatch.setattr(cli, "RefineryConfig", type("C", (), {"from_env": staticmethod(lambda: None)}))
        monkeypatch.setattr(cli, "run_extract", lambda args, config: calls.append("run_extract") or 1)
        monkeypatch.setattr(cli, "run_load", lambda args, config: calls.append("run_load") or 0)
        assert cli.main(["--all", "--input", str(tmp_path / "a.md")]) == 1
        assert calls == ["run_extract"], calls

    def test_no_action_returns_2(self, monkeypatch, tmp_path):
        assert cli.main(["--input", str(tmp_path / "a.md")]) == 2
