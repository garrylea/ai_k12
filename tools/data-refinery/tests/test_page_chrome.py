from pathlib import Path

from page_chrome import CHROME_MIN_PAGES, compute_book_chrome, strip_chrome


def _write_pages(book_dir: Path, pages: list[str]):
    """pages: 每页完整 md 文本，落 page_001.md 起。"""
    book_dir.mkdir(parents=True, exist_ok=True)
    for i, text in enumerate(pages, 1):
        (book_dir / f"page_{i:03d}.md").write_text(text, encoding="utf-8")


BODY = "这是一段足够长的测试内容，超过三十个字符以避免被前置内容预过滤器拦截，用于验证剥离逻辑。"


class TestComputeBookChrome:
    def test_publisher_header_detected(self, tmp_path):
        # 页首运行页眉「人民教育出版社」出现在 >=3 页 → 进入 chrome 集合
        book = tmp_path / "书"
        _write_pages(book, [
            f"# 人民教育出版社\n\n{BODY}",
            f"## 人民教育出版社\n\n{BODY}",
            f"人民教育出版社\n\n{BODY}",
            BODY,
        ])
        chrome = compute_book_chrome(book)
        assert "人民教育出版社" in chrome

    def test_watermark_footer_detected(self, tmp_path):
        # 页尾水印行出现在 >=3 页 → 进入 chrome 集合（修 123/133/154/181 误杀）
        book = tmp_path / "书"
        footer = "仅供个人学习使用，未经授权不得另做他用"
        _write_pages(book, [
            f"{BODY}\n\n{footer}",
            f"{BODY}\n\n{footer}",
            f"{BODY}\n\n{footer}",
        ])
        chrome = compute_book_chrome(book)
        assert footer in chrome

    def test_page_number_line_detected(self, tmp_path):
        # 纯数字页码行（页首/页尾）出现 >=3 页 → 进入 chrome 集合
        book = tmp_path / "书"
        _write_pages(book, [
            f"{BODY}\n\n12",
            f"{BODY}\n\n13",
            f"14\n\n{BODY}",
        ])
        # 各页页码数字不同，单行频率不足 → 只有同数字行才计
        chrome = compute_book_chrome(book)
        assert chrome == set()

    def test_same_page_number_repeated_detected(self, tmp_path):
        book = tmp_path / "书"
        _write_pages(book, [
            f"{BODY}\n\n12",
            f"{BODY}\n\n12",
            f"{BODY}\n\n12",
        ])
        assert "12" in compute_book_chrome(book)

    def test_content_heading_not_detected(self, tmp_path):
        # 「练习」等高频内容标题不匹配安全模式 → 绝不进入 chrome 集合（关键安全网）
        book = tmp_path / "书"
        _write_pages(book, [
            f"## 练习\n\n{BODY}",
            f"## 练习\n\n{BODY}",
            f"## 练习\n\n{BODY}",
            f"## 练习\n\n{BODY}",
            f"## 小结\n\n{BODY}",
            f"## 小结\n\n{BODY}",
            f"## 小结\n\n{BODY}",
        ])
        assert compute_book_chrome(book) == set()

    def test_display_math_dollar_not_detected(self, tmp_path):
        # 跨页公式续行 $$ 高频出现但不是页眉 → 不剥离
        book = tmp_path / "书"
        _write_pages(book, [
            f"$$\n\nx = 1\n\n$$",
            f"$$\n\nx = 2\n\n$$",
            f"$$\n\nx = 3\n\n$$",
        ])
        assert compute_book_chrome(book) == set()

    def test_one_off_publisher_in_problem_kept(self, tmp_path):
        # 题干里偶现「某出版社…」只出现在 1 页 → 频率不足，保留（防误删题干）
        book = tmp_path / "书"
        _write_pages(book, [
            f"某出版社计划出版一套科普读物，第一天排版 120 页。{BODY}",
            BODY,
            BODY,
        ])
        assert compute_book_chrome(book) == set()

    def test_below_threshold_not_detected(self, tmp_path):
        # 出现 2 页（< CHROME_MIN_PAGES=3）即使匹配安全模式也不剥
        assert CHROME_MIN_PAGES == 3
        book = tmp_path / "书"
        _write_pages(book, [
            f"# 人民教育出版社\n\n{BODY}",
            f"# 人民教育出版社\n\n{BODY}",
            BODY,
        ])
        assert "人民教育出版社" not in compute_book_chrome(book)

    def test_only_first_and_last_two_lines_counted(self, tmp_path):
        # 页眉只统计开头 2 行/结尾 2 行：页中间（前后各有 >=2 个内容行）出现的行不参与频率
        book = tmp_path / "书"
        _write_pages(book, [
            f"{BODY}\n\n{BODY}\n\n人民教育出版社\n\n{BODY}\n\n{BODY}\n\n{BODY}",
        ] * 3)
        assert compute_book_chrome(book) == set()

    def test_missing_dir_returns_empty(self, tmp_path):
        assert compute_book_chrome(tmp_path / "nope") == set()

    def test_non_page_md_ignored(self, tmp_path):
        # 目录里非 page_NNN.md 的文件（如 merged.md）不参与统计
        book = tmp_path / "书"
        _write_pages(book, [BODY])
        (book / "merged.md").write_text("人民教育出版社\n\n" + BODY, encoding="utf-8")
        assert compute_book_chrome(book) == set()


class TestStripChrome:
    def test_strips_matched_lines_anywhere(self, tmp_path):
        book = tmp_path / "书"
        _write_pages(book, [
            f"# 人民教育出版社\n\n{BODY}",
            f"## 人民教育出版社\n\n{BODY}",
            f"人民教育出版社\n\n{BODY}",
        ])
        chrome = compute_book_chrome(book)
        text = f"# 人民教育出版社\n\n{BODY}\n\n人民教育出版社\n"
        out = strip_chrome(text, chrome)
        assert "人民教育出版社" not in out
        assert BODY in out

    def test_content_lines_untouched(self):
        out = strip_chrome(f"## 练习\n\n{BODY}", {"人民教育出版社", "12"})
        assert "## 练习" in out
        assert BODY in out

    def test_empty_chrome_noop(self):
        text = f"# 人民教育出版社\n\n{BODY}"
        assert strip_chrome(text, set()) == text
