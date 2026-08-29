"""toc_merge 测试：卡片标签合并进初始 TOC（纯函数，无 LLM/DB）。"""
import json

from toc_merge import (
    _int_to_cn,
    collect_card_labels,
    merge_toc,
    run_merge,
)


def _toc():
    return {
        "book": "数学九上",
        "chapters": [{
            "number": 26, "title": "反比例函数", "label": "第二十六章 反比例函数",
            "sections": [
                {"number": [26, 1], "title": "反比例函数", "label": "26.1 反比例函数",
                 "printed_page": 2, "subsections": []},
                {"number": [26, 2], "title": "实际问题与反比例函数", "label": "26.2 实际问题与反比例函数",
                 "printed_page": 12, "subsections": []},
            ],
            "supplements": [{"type": "supplement", "label": "小结", "printed_page": 30}],
        }],
    }


def _labels():
    return {
        "26.1 反比例函数": {"first_page": 3, "count": 5, },
        "26.1.1 反比例函数": {"first_page": 3, "count": 2},
        "26.1.2 反比例函数的图象和性质": {"first_page": 5, "count": 4},
        "小结": {"first_page": 40, "count": 1},
    }


class TestIntToCn:
    def test_basic(self):
        assert _int_to_cn(1) == "一"
        assert _int_to_cn(9) == "九"
        assert _int_to_cn(10) == "十"
        assert _int_to_cn(16) == "十六"
        assert _int_to_cn(20) == "二十"
        assert _int_to_cn(26) == "二十六"
        assert _int_to_cn(99) == "九十九"


class TestMergeToc:
    def test_input_not_mutated(self):
        import copy
        toc = _toc()
        snapshot = copy.deepcopy(toc)
        merge_toc(toc, _labels())
        assert toc == snapshot

    def test_exact_match_no_change(self):
        toc = _toc()
        merged, report = merge_toc(toc, {"26.1 反比例函数": {"first_page": 3, "count": 5}})
        assert report["matched"] == ["26.1 反比例函数"]
        assert not report["new_sections"]
        assert not report["new_subsections"]
        assert merged == toc

    def test_new_subsection_inserted_sorted(self):
        merged, report = merge_toc(_toc(), _labels())
        ch = merged["chapters"][0]
        sec261 = ch["sections"][0]
        subs = sec261["subsections"]
        assert [s["number"] for s in subs] == [[26, 1, 1], [26, 1, 2]]
        assert subs[0]["label"] == "26.1.1 反比例函数"
        assert subs[0]["printed_page"] == 3
        assert subs[0]["source"] == "card"
        assert report["new_subsections"] == ["26.1.1 反比例函数", "26.1.2 反比例函数的图象和性质"]
        # 既有结构不动
        assert ch["sections"][1]["label"] == "26.2 实际问题与反比例函数"

    def test_new_section_inserted_sorted(self):
        labels = {
            "26.1 反比例函数": {"first_page": 3, "count": 5},
            "26.3 反比例函数的应用": {"first_page": 20, "count": 3},
        }
        merged, report = merge_toc(_toc(), labels)
        secs = merged["chapters"][0]["sections"]
        assert [s["number"] for s in secs] == [[26, 1], [26, 2], [26, 3]]
        assert secs[2]["source"] == "card"
        assert secs[2]["printed_page"] == 20
        assert report["new_sections"] == ["26.3 反比例函数的应用"]

    def test_section_created_from_subsection(self):
        # 目录只列到 26.1（无子节），卡片出现 27.3.1（27.3 整节缺失）
        labels = {"27.3.1 切线": {"first_page": 55, "count": 2}}
        merged, report = merge_toc(_toc(), labels)
        assert report["section_created_from_subsection"] == ["27.3 切线"]
        ch27 = [c for c in merged["chapters"] if c["number"] == 27][0]
        sec = ch27["sections"][0]
        assert sec["number"] == [27, 3]
        assert sec["title"] == "切线"  # 子节标题兜底
        assert sec["subsections"][0]["number"] == [27, 3, 1]
        assert report["new_subsections"] == ["27.3.1 切线"]

    def test_new_chapter_from_overview(self):
        labels = {"第二十七章 相似": {"first_page": 60, "count": 1}}
        merged, report = merge_toc(_toc(), labels)
        assert report["new_chapters"] == ["第二十七章 相似"]
        ch27 = merged["chapters"][1]
        assert ch27["number"] == 27
        assert ch27["title"] == "相似"
        assert ch27["label"] == "第二十七章 相似"
        assert ch27["sections"] == []

    def test_chapter_fallback_label_when_only_section_known(self):
        # 只出现 31.1（第 31 章目录完全缺失）：补建章 + 节，章 label 兜底中文数字
        labels = {"31.1 随机事件": {"first_page": 88, "count": 2}}
        merged, report = merge_toc(_toc(), labels)
        ch31 = [c for c in merged["chapters"] if c["number"] == 31][0]
        assert ch31["label"] == "第三十一章"
        assert ch31["title"] is None
        assert ch31["sections"][0]["label"] == "31.1 随机事件"

    def test_chapter_title_filled_by_overview(self):
        # 已有章（第 26 章）但目录解析时缺 title/label，章综述卡补齐
        toc = _toc()
        toc["chapters"][0]["title"] = None
        toc["chapters"][0]["label"] = None
        merged, report = merge_toc(toc, {"第二十六章 反比例函数": {"first_page": 1, "count": 1}})
        assert report["filled_chapters"] == ["第二十六章 反比例函数"]
        assert merged["chapters"][0]["title"] == "反比例函数"
        assert merged["chapters"][0]["label"] == "第二十六章 反比例函数"

    def test_unresolved_labels_reported(self):
        labels = {"小结与复习": {"first_page": 40, "count": 1}}
        _, report = merge_toc(_toc(), labels)
        assert report["unresolved"] == ["小结与复习"]
        # 不合并进任何结构
        assert not report["new_sections"] and not report["new_subsections"]

    def test_idempotent_rerun(self):
        # 用 merged 结果 + 相同卡片标签再合并一次，应无新增（幂等）
        labels = _labels()
        merged1, _ = merge_toc(_toc(), labels)
        merged2, report2 = merge_toc(merged1, labels)
        assert report2["new_subsections"] == []
        assert report2["new_sections"] == []
        # merged2 的 flatten 标签集合 == merged1（merged2 中原 source:card 项变 matched）
        assert merged2 == merged1


class TestCollectCardLabels:
    def test_collects_in_page_order(self, tmp_path):
        book = tmp_path / "published" / "数学/书"
        book.mkdir(parents=True)
        def _w(name, cards):
            (book / name).write_text(
                "\n".join(json.dumps(c, ensure_ascii=False) for c in cards) + "\n",
                encoding="utf-8")
        _w("page_002.jsonl", [{"lesson_id": "26.1 反比例函数", "textbook_page": "P5"}])
        _w("page_001.jsonl", [{"lesson_id": "26.1 反比例函数", "textbook_page": "P3"},
                              {"lesson_id": None},
                              {"lesson_id": "26.1.1 反比例函数", "textbook_page": "P3"}])
        labels = collect_card_labels(tmp_path / "published", "数学/书")
        assert list(labels) == ["26.1 反比例函数", "26.1.1 反比例函数"]
        assert labels["26.1 反比例函数"] == {"first_page": 3, "count": 2}
        assert labels["26.1.1 反比例函数"] == {"first_page": 3, "count": 1}

    def test_missing_book_dir(self, tmp_path):
        assert collect_card_labels(tmp_path / "published", "不存在") == {}


class TestRunMerge:
    BOOK_KEY = "数学/初中/人教版/九年级/上册/数学九上"

    def _setup(self, tmp_path):
        # toc 文件：toc/{book_key}.json（book_key 为 md 书目录的相对路径）
        toc_file = tmp_path / "toc" / f"{self.BOOK_KEY}.json"
        toc_file.parent.mkdir(parents=True)
        toc_file.write_text(json.dumps(_toc(), ensure_ascii=False), encoding="utf-8")
        book = tmp_path / "published" / self.BOOK_KEY
        book.mkdir(parents=True)
        (book / "page_001.jsonl").write_text(
            json.dumps({"lesson_id": "26.1.2 反比例函数的图象和性质",
                        "textbook_page": "P5"}, ensure_ascii=False) + "\n",
            encoding="utf-8")
        return tmp_path

    def test_writes_sidecars(self, tmp_path, capsys):
        self._setup(tmp_path)
        paths = run_merge(tmp_path, source="all")
        assert len(paths) == 1
        # sidecar 与原 toc 同目录同名：书.json -> 书.merged.json / 书.merge_report.json
        assert (tmp_path / "toc" / self.BOOK_KEY).with_suffix(".merged.json").exists()
        report = json.loads((tmp_path / "toc" / self.BOOK_KEY).with_suffix(".merge_report.json")
                             .read_text(encoding="utf-8"))
        assert report["new_subsections"] == ["26.1.2 反比例函数的图象和性质"]
        assert "[merge]" in capsys.readouterr().out

    def test_dry_run_writes_nothing(self, tmp_path, capsys):
        self._setup(tmp_path)
        run_merge(tmp_path, source="all", dry_run=True)
        assert not (tmp_path / "toc" / self.BOOK_KEY).with_suffix(".merged.json").exists()
        assert "[dry-run]" in capsys.readouterr().out

    def test_source_filter(self, tmp_path):
        self._setup(tmp_path)
        assert run_merge(tmp_path, source="zgkao") == []
        assert run_merge(tmp_path, source="smartedu") != []

    def test_missing_toc_dir(self, tmp_path):
        assert run_merge(tmp_path / "nope") == []

    def test_sidecars_not_remerged(self, tmp_path):
        # 上轮的 merged sidecar 不应作为输入再次合并
        self._setup(tmp_path)
        run_merge(tmp_path)
        paths = run_merge(tmp_path)
        assert len(paths) == 1
