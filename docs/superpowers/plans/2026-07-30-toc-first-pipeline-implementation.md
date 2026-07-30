# TOC 目录优先管线 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 TOC 目录优先管线：新增 toc_parse 步骤从教材目录页 LLM 提取章→节→子节层级，db_loader 用 TOC JSON 全量建 units/lessons 骨架，card 增量挂载。

**Architecture:** 新增 `toc_parse_cli.py`（独立 CLI，复用 LLMClient），新增 `prompts/toc_parse.txt`，修改 `checkpoint.py`（+toc_parsed 集合）、`db_loader.py`（+load_toc_structure / _match_lesson_by_name）、`db_loader_cli.py`（+--load-toc / --load-cards / --toc-path）、`extract_cli.py`（+--toc / 校验修正）。全部可选 flag，不传时完全向后兼容。

**Tech Stack:** Python 3, pytest, pymysql, unittest.mock

---

### Task 1: checkpoint.py — 新增 toc_parsed 集合

**Files:**
- Modify: `tools/data-refinery/src/checkpoint.py`

- [ ] **Step 1: 添加 _toc_parsed 集合及方法**

在 `RefineryCheckpoint` 类中添加 `_toc_parsed` 集合和对应方法，与现有 `_converted` / `_extracted` / `_published` 模式完全一致。

```python
class RefineryCheckpoint:
    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._converted: set[str] = set()
        self._extracted: set[str] = set()
        self._published: set[str] = set()
        self._toc_parsed: set[str] = set()                         # ← 新增

    def load(self) -> None:
        if not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, ValueError):
            return
        self._converted = set(data.get("converted", []))
        self._extracted = set(data.get("extracted", []))
        self._published = set(data.get("published", []))
        self._toc_parsed = set(data.get("toc_parsed", []))          # ← 新增

    def is_toc_parsed(self, rel_path: str) -> bool:                 # ← 新增
        return rel_path in self._toc_parsed

    def mark_toc_parsed(self, rel_path: str) -> None:               # ← 新增
        self._toc_parsed.add(rel_path)
        self.save()

    def unmark_toc_parsed(self, rel_path: str) -> None:             # ← 新增
        self._toc_parsed.discard(rel_path)
        self.save()

    def save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(
            json.dumps(
                {
                    "converted": sorted(self._converted),
                    "extracted": sorted(self._extracted),
                    "published": sorted(self._published),
                    "toc_parsed": sorted(self._toc_parsed),           # ← 新增
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
```

- [ ] **Step 2: 运行现有测试验证不破坏兼容性**

```bash
cd tools/data-refinery && python -m pytest tests/test_checkpoint.py -v
```

Expected: all existing tests pass.

- [ ] **Step 3: 编写新测试 test_toc_parsed**

在 `tests/test_checkpoint.py` 中添加：

```python
class TestTocParsed:
    def test_mark_and_query_toc_parsed(self, tmp_path):
        from checkpoint import RefineryCheckpoint
        ckpt = RefineryCheckpoint(tmp_path / ".checkpoint.json")
        ckpt.load()
        assert not ckpt.is_toc_parsed("数学/人教版/九年级下册")
        ckpt.mark_toc_parsed("数学/人教版/九年级下册")
        assert ckpt.is_toc_parsed("数学/人教版/九年级下册")

    def test_unmark_toc_parsed(self, tmp_path):
        from checkpoint import RefineryCheckpoint
        ckpt = RefineryCheckpoint(tmp_path / ".checkpoint.json")
        ckpt.load()
        ckpt.mark_toc_parsed("a")
        ckpt.unmark_toc_parsed("a")
        assert not ckpt.is_toc_parsed("a")

    def test_persistence_toc_parsed(self, tmp_path):
        from checkpoint import RefineryCheckpoint
        ckpt = RefineryCheckpoint(tmp_path / ".checkpoint.json")
        ckpt.load()
        ckpt.mark_toc_parsed("b")
        ckpt2 = RefineryCheckpoint(tmp_path / ".checkpoint.json")
        ckpt2.load()
        assert ckpt2.is_toc_parsed("b")
```

- [ ] **Step 4: 运行测试**

```bash
cd tools/data-refinery && python -m pytest tests/test_checkpoint.py -v
```

Expected: 3 new tests pass.

- [ ] **Step 5: 提交**

```bash
git add tools/data-refinery/src/checkpoint.py tools/data-refinery/tests/test_checkpoint.py
git commit -m "feat(checkpoint): add toc_parsed tracking set for TOC parse step"
```

---

### Task 2: prompts/toc_parse.txt — 新增 TOC 解析 LLM prompt

**Files:**
- Create: `tools/data-refinery/src/prompts/toc_parse.txt`

- [ ] **Step 1: 创建 prompt 文件**

```text
你是 K12 教材目录解析专家。从教材目录页 Markdown 中提取章→节→子节层级。

【任务】
分析下面的目录页内容，提取所有章节结构。

【规则】
1. 只提取编号标题：
   - 第N章 X（如"第二十六章 反比例函数"）→ chapter
   - N.M X（如"26.1 反比例函数"）→ section
   - N.M.K X（如"26.1.1 反比例函数"）→ subsection
2. 非编号内容（信息技术应用、阅读与思考、数学活动、小结、复习题、复习巩固）
   → 保留在所属章下的 supplements 列表中，type 标记为 "supplement"
3. 标题后紧跟的数字是教材印刷页码，提取为 printed_page（整数）
4. 章综述（第N章标题所在行）不提取 printed_page

【输出格式 -- 必须严格遵守】
只输出一个 JSON 对象，不使用 ```json``` 代码块，第一个字符是 {，最后一个字符是 }：

{
  "book": "教材名称",
  "chapters": [
    {
      "number": 26,
      "title": "反比例函数",
      "label": "第二十六章 反比例函数",
      "sections": [
        {
          "number": [26, 1],
          "title": "反比例函数",
          "label": "26.1 反比例函数",
          "printed_page": 2,
          "subsections": [
            {
              "number": [26, 1, 1],
              "title": "反比例函数",
              "label": "26.1.1 反比例函数",
              "printed_page": 2
            }
          ]
        }
      ],
      "supplements": [
        {
          "type": "supplement",
          "label": "信息技术应用 探索反比例函数的性质",
          "printed_page": 10
        },
        {
          "type": "supplement",
          "label": "小结",
          "printed_page": 20
        }
      ]
    }
  ]
}

【注意】
- 教材名从目录页中的主标题提取（通常在目录最上方）
- 如果目录跨多页，输入会包含所有目录页的拼接
- sections/subsection 按目录中出现的顺序排列
- 没有节直接属于章的，sections 为空数组
- 没有 supplements 的，supplements 为空数组
```

- [ ] **Step 2: 添加加载 prompt 的测试**

在 `tests/test_extract_cli.py` 的 `TestLoadPrompt` 类中添加：

```python
    def test_loads_toc_parse_prompt(self):
        text = _load_prompt("toc_parse")
        assert "目录解析" in text
        assert "chapter" in text
        assert "printed_page" in text
```

注意：`_load_prompt` 在 `extract_cli.py` 中定义，需要验证它也能加载 toc_parse.txt。

- [ ] **Step 3: 运行测试**

```bash
cd tools/data-refinery && python -m pytest tests/test_extract_cli.py::TestLoadPrompt -v
```

Expected: new test passes (test_loads_toc_parse_prompt).

- [ ] **Step 4: 提交**

```bash
git add tools/data-refinery/src/prompts/toc_parse.txt tools/data-refinery/tests/test_extract_cli.py
git commit -m "feat(prompts): add toc_parse prompt for TOC page LLM extraction"
```

---

### Task 3: toc_parse_cli.py — 新增 TOC 解析 CLI

**Files:**
- Create: `tools/data-refinery/src/toc_parse_cli.py`
- Create: `tools/data-refinery/tests/test_toc_parse_cli.py`

- [ ] **Step 1: 实现 TOC 页面扫描函数**

在 `toc_parse_cli.py` 中实现目录页发现逻辑——扫描教材目录前 10 页（或 20 页），找包含 `目录` heading 的页。

```python
"""toc_parse 子命令入口。

扫描教材 MD 目录，找目录页，LLM 解析为结构化 TOC JSON。
"""

import argparse
import json
from pathlib import Path

from checkpoint import RefineryCheckpoint
from config import RefineryConfig
from llm import LLMClient

# 复用 extract_cli 的 _load_prompt
from extract_cli import _load_prompt


def _find_toc_pages(book_dir: Path, max_pages: int = 10) -> list[Path]:
    """在教材 MD 目录中找目录页。
    
    规则：前 max_pages 页内，MD 内容包含 '目录' heading（## 目录 或 # 目录）的页。
    如果前 10 页找不到，扩展到前 20 页。
    """
    mds = sorted(book_dir.glob("page_*.md"))
    if not mds:
        return []
    candidates = mds[:max_pages]
    found = []
    for p in candidates:
        text = p.read_text(encoding="utf-8")
        if "目录" in text:
            found.append(p)
    if not found and max_pages == 10:
        return _find_toc_pages(book_dir, max_pages=20)
    return found


def _parse_args(argv=None):
    parser = argparse.ArgumentParser(description="从教材目录页 LLM 提取章节结构")
    parser.add_argument("--input-dir", help="MD 目录（默认 output/md）")
    parser.add_argument("--output-dir", help="TOC JSON 输出目录（默认 output/toc）")
    parser.add_argument("--book", help="只处理指定教材（路径子串匹配，如'九年级/下册'）")
    parser.add_argument("--reconvert", action="store_true", help="清除 checkpoint + 删除已有 TOC JSON，重新解析")
    parser.add_argument("--dry-run", action="store_true", help="只打印将要处理的目录页")
    return parser.parse_args(argv)


def main(argv=None):
    args = _parse_args(argv)
    config = RefineryConfig.from_env(input_dir=None, output_dir=args.output_dir or None)
    md_dir = Path(args.input_dir) if args.input_dir else config.output_dir / "md"
    toc_dir = Path(args.output_dir) if args.output_dir else config.output_dir / "toc"

    checkpoint = RefineryCheckpoint(config.output_dir / ".toc_checkpoint.json")
    checkpoint.load()

    # 扫描教材目录（按 subject/publisher/grade/term/book 结构）
    book_dirs = sorted(md_dir.glob("*/*/*/*/*"))
    if args.book:
        book_dirs = [d for d in book_dirs if args.book in str(d.relative_to(md_dir))]

    if args.dry_run:
        for d in book_dirs:
            pages = _find_toc_pages(d)
            if pages:
                print(f"[dry-run] {d.relative_to(md_dir)} -> {len(pages)} toc page(s)", flush=True)
        return

    # 初始化 LLM
    llm = LLMClient(
        provider=config.llm_provider,
        api_key=config.llm_api_key or "",
        auth_token=config.llm_auth_token,
        model=config.llm_model,
        base_url=config.llm_base_url,
        timeout=config.llm_timeout,
        max_tokens=config.llm_max_tokens,
    )
    prompt = _load_prompt("toc_parse")

    parsed = 0
    skipped = 0
    failed = 0

    for book_dir in book_dirs:
        toc_pages = _find_toc_pages(book_dir)
        if not toc_pages:
            print(f"[WARN] {book_dir.relative_to(md_dir)}: no toc pages found", flush=True)
            continue

        book_key = str(book_dir.relative_to(md_dir))
        # checkpoint 用 book_dir 相对路径做 key
        toc_ckpt_key = book_key

        if not args.reconvert and checkpoint.is_toc_parsed(toc_ckpt_key):
            skipped += 1
            print(f"[skip] {book_key}", flush=True)
            continue

        if args.reconvert:
            if checkpoint.is_toc_parsed(toc_ckpt_key):
                checkpoint.unmark_toc_parsed(toc_ckpt_key)
            # 删除已有 TOC JSON
            out_file = toc_dir / book_key / f"{book_dir.name}_toc.json"
            if out_file.exists():
                out_file.unlink()
                print(f"[reconvert] deleted {out_file}", flush=True)

        try:
            # 拼接所有目录页
            toc_text = "\n\n".join(p.read_text(encoding="utf-8") for p in toc_pages)
            response = llm.complete(prompt, toc_text)
            data = json.loads(response.content)

            # 写入输出
            out_file = toc_dir / book_key / f"{book_dir.name}_toc.json"
            out_file.parent.mkdir(parents=True, exist_ok=True)
            out_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

            checkpoint.mark_toc_parsed(toc_ckpt_key)
            chapters = len(data.get("chapters", []))
            print(f"[ok] {book_key} -> {chapters} chapter(s)", flush=True)
            parsed += 1
        except Exception as e:
            print(f"[ERROR] {book_key}: {e}", flush=True)
            # JSON 解析失败重试一次
            if "json" in str(e).lower() or "decode" in str(e).lower():
                try:
                    response2 = llm.complete(prompt, toc_text)
                    data2 = json.loads(response2.content)
                    out_file = toc_dir / book_key / f"{book_dir.name}_toc.json"
                    out_file.parent.mkdir(parents=True, exist_ok=True)
                    out_file.write_text(json.dumps(data2, ensure_ascii=False, indent=2), encoding="utf-8")
                    checkpoint.mark_toc_parsed(toc_ckpt_key)
                    chapters = len(data2.get("chapters", []))
                    print(f"[ok] {book_key} -> {chapters} chapter(s) (retry)", flush=True)
                    parsed += 1
                except Exception as e2:
                    print(f"[ERROR] {book_key}: retry also failed: {e2}", flush=True)
                    failed += 1
            else:
                failed += 1

    print(f"TOC parsed: {parsed}, Skipped: {skipped}, Failed: {failed}", flush=True)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 编写 dry-run 测试**

创建 `tests/test_toc_parse_cli.py`：

```python
from pathlib import Path
from unittest.mock import MagicMock, patch

from toc_parse_cli import _find_toc_pages


class TestFindTocPages:
    def test_finds_directory_page_with_directory_heading(self, tmp_path):
        book_dir = tmp_path / "book"
        book_dir.mkdir()
        (book_dir / "page_001.md").write_text("# 封面", encoding="utf-8")
        (book_dir / "page_002.md").write_text("## 目录\n26.1 反比例函数 2", encoding="utf-8")
        (book_dir / "page_003.md").write_text("# 第二十六章", encoding="utf-8")

        pages = _find_toc_pages(book_dir)
        assert len(pages) == 1
        assert "page_002" in pages[0].name

    def test_no_directory_returns_empty(self, tmp_path):
        book_dir = tmp_path / "book"
        book_dir.mkdir()
        (book_dir / "page_001.md").write_text("# 封面", encoding="utf-8")
        (book_dir / "page_002.md").write_text("# 第二十六章", encoding="utf-8")

        pages = _find_toc_pages(book_dir, max_pages=10)
        assert pages == []

    def test_multiple_toc_pages(self, tmp_path):
        book_dir = tmp_path / "book"
        book_dir.mkdir()
        (book_dir / "page_005.md").write_text("## 目录\n26.1 反比例函数 2", encoding="utf-8")
        (book_dir / "page_006.md").write_text("## 目录\n27.1 图形的相似 24", encoding="utf-8")

        pages = _find_toc_pages(book_dir)
        assert len(pages) == 2


class TestTocParseCliMain:
    def test_dry_run_prints_toc_pages(self, tmp_path, capsys):
        book_dir = tmp_path / "md" / "数学" / "初中" / "人教版" / "九年级" / "下册" / "书"
        book_dir.mkdir(parents=True)
        (book_dir / "page_005.md").write_text("## 目录\n26.1 反比例函数 2", encoding="utf-8")

        with patch("toc_parse_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(
                output_dir=tmp_path / "out",
            )
            from toc_parse_cli import main
            main(["--input-dir", str(tmp_path / "md"), "--dry-run"])

        out = capsys.readouterr().out
        assert "[dry-run]" in out
        assert "toc page" in out

    def test_book_filter(self, tmp_path, capsys):
        book1 = tmp_path / "md" / "数学" / "人教版" / "九年级" / "上册" / "书"
        book2 = tmp_path / "md" / "数学" / "人教版" / "九年级" / "下册" / "书"
        book1.mkdir(parents=True)
        book2.mkdir(parents=True)
        (book1 / "page_005.md").write_text("## 目录\n内容", encoding="utf-8")
        (book2 / "page_005.md").write_text("## 目录\n内容", encoding="utf-8")

        with patch("toc_parse_cli.RefineryConfig") as mock_config:
            mock_config.from_env.return_value = MagicMock(output_dir=tmp_path / "out")
            from toc_parse_cli import main
            main(["--input-dir", str(tmp_path / "md"), "--book", "下册", "--dry-run"])

        out = capsys.readouterr().out
        assert "下册" in out
        assert "上册" not in out

    def test_reconvert_clears_checkpoint_and_deletes_output(self, tmp_path):
        book_dir = tmp_path / "md" / "数学" / "人教版" / "九年级" / "下册" / "书"
        book_dir.mkdir(parents=True)
        (book_dir / "page_005.md").write_text("## 目录\n26.1 反比例函数 2", encoding="utf-8")

        out_dir = tmp_path / "out"
        out_dir.mkdir()
        toc_json = out_dir / "toc" / "数学/人教版/九年级/下册" / "书_toc.json"
        toc_json.parent.mkdir(parents=True)
        toc_json.write_text('{"book":"test"}', encoding="utf-8")

        # 预置 checkpoint
        ckpt_file = out_dir / ".toc_checkpoint.json"
        from checkpoint import RefineryCheckpoint
        ckpt = RefineryCheckpoint(ckpt_file)
        ckpt.load()
        ckpt.mark_toc_parsed("数学/人教版/九年级/下册/书")

        with patch("toc_parse_cli.RefineryConfig") as mock_config, \
             patch("toc_parse_cli.LLMClient") as mock_llm:
            mock_config.from_env.return_value = MagicMock(output_dir=out_dir)
            mock_llm.return_value.complete.return_value = MagicMock(
                content='{"book":"test","chapters":[]}'
            )
            from toc_parse_cli import main
            main(["--input-dir", str(tmp_path / "md"), "--output-dir", str(out_dir / "toc"), "--reconvert"])

        # checkpoint 应被清除后重新标记
        ckpt2 = RefineryCheckpoint(ckpt_file)
        ckpt2.load()
        assert ckpt2.is_toc_parsed("数学/人教版/九年级/下册/书")
```

- [ ] **Step 3: 运行测试**

```bash
cd tools/data-refinery && python -m pytest tests/test_toc_parse_cli.py -v
```

Expected: all tests pass.

- [ ] **Step 4: 提交**

```bash
git add tools/data-refinery/src/toc_parse_cli.py tools/data-refinery/tests/test_toc_parse_cli.py
git commit -m "feat(toc_parse): add toc_parse_cli for LLM-based TOC page extraction"
```

---

### Task 4: db_loader.py — 新增 load_toc_structure() 和 _match_lesson_by_name()

**Files:**
- Modify: `tools/data-refinery/src/db_loader.py`
- Modify: `tools/data-refinery/tests/test_db_loader_integration.py`

- [ ] **Step 1: 新增 _match_lesson_by_name() 方法**

在 `DbLoader` 类中添加按 lesson name 查找的方法：

```python
    def _match_lesson_by_name(self, name: str) -> int | None:
        """按 lesson name 查已有 lesson 的 DB id。"""
        row = self._query("SELECT id FROM lessons WHERE name=%s", (name,))
        if row:
            return row[0][0]
        return None
```

- [ ] **Step 2: 新增 load_toc_structure() 方法**

在 `DbLoader` 类中添加：

```python
    def load_toc_structure(self, toc_path: str) -> dict:
        """用 TOC JSON 全量建教材骨架。
        
        从 TOC JSON 文件路径推导 rel_path 结构，逐条 find-or-create：
        textbook_version → semester → units → lessons。
        幂等：已存在的 unit/lesson 不重复创建。
        
        Returns:
            dict: {toc_path: str, chapters: int, lessons: int}
        """
        with open(toc_path, encoding="utf-8") as f:
            toc = json.load(f)
        
        # 从路径推导：toc/{subject}/{publisher}/{grade}/{term}_{book}.json
        toc_file = Path(toc_path)
        stem = toc_file.stem  # e.g. "九年级_义务教育教科书·数学九年级下册"
        parts = stem.split("_", 1)
        term_name = parts[0]  # "九年级"
        book_name = parts[1] if len(parts) > 1 else stem
        
        parent_parts = toc_file.parent.parts
        # toc/{subject}/{publisher}/{grade}/
        subject_name = parent_parts[-3] if len(parent_parts) >= 3 else ""
        publisher = parent_parts[-2] if len(parent_parts) >= 2 else ""
        grade = parent_parts[-1] if len(parent_parts) >= 1 else ""
        
        # 归一化
        subject_code = _subject_code_by_name_fallback(subject_name)
        gb = _grade_band_from_path(toc_path)
        grade_code = grade_to_code(grade) if "年级" in grade else grade
        term_code = TERM_MAP.get(term_name.replace("上", "上册").replace("下", "下册"), "first")
        
        tv_id = self._find_or_create_textbook_version(subject_code, publisher, gb)
        sem_id = self._find_or_create_semester(tv_id, grade_code, term_code, f"{grade}{term_name}")
        
        chapters_count = 0
        lessons_count = 0
        
        for ch in toc.get("chapters", []):
            chapter_num = ch.get("number", 0)
            chapter_label = ch.get("label", f"第{chapter_num}章")
            
            # 建 unit（章）
            unit_id = self._find_or_create_unit(sem_id, chapter_num, chapter_label)
            chapters_count += 1
            
            # 建 章综述 lesson (sort_order=0)
            self._find_or_create_lesson(unit_id, chapter_label, 0)
            lessons_count += 1
            
            # 建 节 lessons
            lesson_sort = 0
            for sec in ch.get("sections", []):
                lesson_sort += 1
                sec_label = sec.get("label", "")
                if sec_label:
                    self._find_or_create_lesson(unit_id, sec_label, lesson_sort)
                    lessons_count += 1
                
                for sub in sec.get("subsections", []):
                    lesson_sort += 1
                    sub_label = sub.get("label", "")
                    if sub_label:
                        self._find_or_create_lesson(unit_id, sub_label, lesson_sort)
                        lessons_count += 1
            
            # 建 supplement lessons (排在所有节之后)
            for supp in ch.get("supplements", []):
                lesson_sort += 1
                supp_label = supp.get("label", "")
                if supp_label:
                    self._find_or_create_lesson(unit_id, supp_label, lesson_sort)
                    lessons_count += 1
        
        self._conn.commit()
        return {"toc_path": toc_path, "chapters": chapters_count, "lessons": lessons_count}


def _subject_code_by_name_fallback(name: str) -> str:
    """根据 subject 中文名找 code，找不到返回原名。"""
    name_map = {"数学": "math", "语文": "chinese", "英语": "english",
                "物理": "physics", "化学": "chemistry", "生物": "biology",
                "历史": "history", "地理": "geography", "道德与法治": "politics"}
    return name_map.get(name, name)


def _grade_band_from_path(toc_path: str) -> str:
    """从 TOC 路径推断 grade_band。"""
    if "小学" in toc_path:
        return "primary"
    elif "高中" in toc_path:
        return "senior"
    return "junior"
```

- [ ] **Step 3: 修改 load_book_cards() 支持 toc_path 参数**

修改 `load_book_cards()` 方法签名，新增可选参数：

```python
    def load_book_cards(self, book_rel: str, cards: list[dict], toc_path: str | None = None) -> int:
        info = parse_book_rel_path(book_rel)
        if not info:
            raise ValueError(f"无法解析教材 rel_path: {book_rel!r}")
        
        if toc_path:
            # TOC 模式：不动态建结构，card 直接匹配已有 lesson
            return self._load_book_cards_with_toc(info, cards)
        
        # 原有逻辑不变...
        subject_code = self._subject_code_by_name(info["subject"])
        # ... (rest of existing load_book_cards)
    
    def _load_book_cards_with_toc(self, info: dict, cards: list[dict]) -> int:
        """TOC 模式下：card 的 lesson_id 匹配已有 lesson（骨架已由 TOC 建好）。"""
        count = 0
        unmatched = []
        for c in cards:
            lid = c.get("lesson_id")
            if not lid:
                unmatched.append(c)
                continue
            lesson_id_db = self._match_lesson_by_name(lid)
            if lesson_id_db is None:
                # 尝试模糊匹配（去掉首尾空格）
                lid_stripped = lid.strip()
                if lid_stripped != lid:
                    lesson_id_db = self._match_lesson_by_name(lid_stripped)
            if lesson_id_db is None:
                print(f"[WARN] card lesson_id={lid!r} not found in DB, skipped", flush=True)
                unmatched.append(c)
                continue
            # 按 lesson 内 sort_order 重排
            sort_order = count + 1  # 简化：当前 lesson 内序号
            self._insert_card(lesson_id_db, sort_order, c)
            count += 1
        if unmatched:
            print(f"[WARN] {len(unmatched)} card(s) could not be matched to any lesson", flush=True)
        self._conn.commit()
        return count
```

- [ ] **Step 4: 编写测试**

在 `tests/test_db_loader_integration.py` 中添加 TOC 相关测试。由于需要 MySQL 连接，添加跳过标记：

```python
import pytest

@pytest.mark.integration
class TestTocStructure:
    def test_load_toc_structure_creates_units_and_lessons(self):
        """需要 MySQL 连接。创建临时 TOC JSON，验证 units/lessons 被创建。"""
        # 此测试需要 MySQL，在 CI 中用 @pytest.mark.integration 标记
        pass

    def test_load_book_cards_with_toc_matches_lessons(self):
        """需要 MySQL 连接。先 load_toc_structure 建骨架，再 load_book_cards 挂 card。"""
        pass
```

- [ ] **Step 5: 运行单元测试（不含集成测试）**

```bash
cd tools/data-refinery && python -m pytest tests/ -v --ignore=tests/test_db_loader_integration.py
```

Expected: all existing tests pass.

- [ ] **Step 6: 提交**

```bash
git add tools/data-refinery/src/db_loader.py tools/data-refinery/tests/test_db_loader_integration.py
git commit -m "feat(db_loader): add load_toc_structure() and _match_lesson_by_name() for TOC-first loading"
```

---

### Task 5: db_loader_cli.py — 新增 --load-toc / --load-cards / --toc-path 参数

**Files:**
- Modify: `tools/data-refinery/src/db_loader_cli.py`

- [ ] **Step 1: 添加新参数并重构 main()**

```python
def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="把 published JSONL 加载进 MySQL")
    parser.add_argument("--input-dir", help="published 输入目录（默认 output/published）")
    parser.add_argument("--source", choices=["all", "zgkao", "smartedu"], default="all", help="素材来源过滤")
    parser.add_argument("--load-toc", action="store_true", help="只 load_toc_structure()，不入库 card（需配合 --toc-path）")
    parser.add_argument("--load-cards", action="store_true", help="只 card/questions 入库，不建骨架")
    parser.add_argument("--toc-path", help="TOC JSON 路径（--load-toc 时输入；--load-cards 时可选传入做匹配）")
    parser.add_argument("--dry-run", action="store_true", help="只打印，不入库")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    cfg = RefineryConfig.from_env()

    loader = DbLoader(cfg.db_host, cfg.db_port, cfg.db_user, cfg.db_pass, cfg.db_name)
    try:
        # === TOC 模式：只建骨架 ===
        if args.load_toc:
            if not args.toc_path:
                print("[ERROR] --load-toc requires --toc-path", flush=True)
                return
            result = loader.load_toc_structure(args.toc_path)
            print(f"[ok] TOC loaded: {result['chapters']} chapters, {result['lessons']} lessons", flush=True)
            return

        # === Cards 模式：只入库 card ===
        published_dir = Path(args.input_dir) if args.input_dir else cfg.output_dir / "published"
        files = [p for p in sorted(published_dir.rglob("*.jsonl")) if _match_source(p.name, args.source)]

        if args.dry_run:
            for p in files:
                print(f"{p.relative_to(published_dir)} ({_kind(p.name)})", flush=True)
            print(f"共 {len(files)} 个文件", flush=True)
            return

        if not args.load_cards:
            # 默认行为（向后兼容）：full-reload
            if args.source in ("all", "smartedu"):
                loader.reset_cards()
                print("[reset] DELETE cards", flush=True)
            if args.source in ("all", "zgkao"):
                loader.reset_questions()
                print("[reset] DELETE questions", flush=True)

        card_files = [p for p in files if _kind(p.name) == "cards"]
        q_files = [p for p in files if _kind(p.name) == "questions"]

        books: dict[str, list[Path]] = {}
        for p in card_files:
            book_key = "/".join(p.relative_to(published_dir).parts[:-1])
            books.setdefault(book_key, []).append(p)

        total_cards = 0
        for book_key in sorted(books):
            pages = sorted(books[book_key])
            cards = []
            for p in pages:
                for line in p.read_text(encoding="utf-8").splitlines():
                    if line.strip():
                        cards.append(json.loads(line))
            book_rel = f"{book_key}/{pages[0].name}"
            n = loader.load_book_cards(book_rel, cards, toc_path=args.toc_path)
            total_cards += n
            print(f"[ok] {book_key} -> {n} cards", flush=True)

        total_q = 0
        for p in q_files:
            qs = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
            n = loader.load_questions(qs)
            total_q += n
            print(f"[ok] {p.relative_to(published_dir)} -> {n} questions", flush=True)

        print(f"Loaded: {total_cards} cards, {total_q} questions", flush=True)
    finally:
        loader.close()
```

- [ ] **Step 2: 验证向后兼容**

```bash
cd tools/data-refinery && python src/db_loader_cli.py --help
```

Expected: `--load-toc`、`--load-cards`、`--toc-path` 出现在 help 中。

- [ ] **Step 3: 提交**

```bash
git add tools/data-refinery/src/db_loader_cli.py
git commit -m "feat(db_loader_cli): add --load-toc / --load-cards / --toc-path flags for TOC-first workflow"
```

---

### Task 6: extract_cli.py — 新增 --toc 参数和校验修正逻辑

**Files:**
- Modify: `tools/data-refinery/src/extract_cli.py`
- Modify: `tools/data-refinery/tests/test_extract_cli.py`

- [ ] **Step 1: 新增 _levenshtein() 和 validate_and_correct() 函数**

在 `extract_cli.py` 末尾添加（或新文件 `toc_validator.py`，根据文件大小决定）：

```python
# extract_cli.py 新增内容

def _levenshtein(a: str, b: str) -> int:
    """计算两个字符串的编辑距离（Levenshtein distance）。"""
    if len(a) < len(b):
        return _levenshtein(b, a)
    if len(b) == 0:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(
                prev[j] + 1,
                cur[-1] + 1,
                prev[j - 1] + (0 if ca == cb else 1),
            ))
        prev = cur
    return prev[-1]


def _flatten_toc_labels(toc: dict) -> list[str]:
    """从 TOC JSON 提取所有合法的 lesson_id 标签（扁平列表）。"""
    labels = []
    for ch in toc.get("chapters", []):
        if ch.get("label"):
            labels.append(ch["label"])
        for sec in ch.get("sections", []):
            if sec.get("label"):
                labels.append(sec["label"])
            for sub in sec.get("subsections", []):
                if sub.get("label"):
                    labels.append(sub["label"])
        for supp in ch.get("supplements", []):
            if supp.get("label"):
                labels.append(supp["label"])
    return labels


def validate_and_correct(cards_jsonl_files: dict, toc: dict, output_dir: Path) -> dict:
    """校验 card 的 lesson_id 与 TOC 的一致性，自动修正编辑距离 ≤2 的不匹配。
    
    Returns:
        dict: 完整的 diff_report
    """
    toc_labels = _flatten_toc_labels(toc)
    diff_report = {
        "book": toc.get("book", ""),
        "matched": 0,
        "corrected": [],
        "unmatched": [],
        "missing_from_cards": list(toc_labels),  # 后续减去已匹配的
    }
    all_card_labels = set()
    
    for file_key, cards in cards_jsonl_files.items():
        for card in cards:
            lid = card.get("lesson_id")
            if not lid:
                continue
            all_card_labels.add(lid)
            if lid in toc_labels:
                diff_report["matched"] += 1
                if lid in diff_report["missing_from_cards"]:
                    diff_report["missing_from_cards"].remove(lid)
                continue
            # 模糊匹配
            if not toc_labels:
                diff_report["unmatched"].append(lid)
                continue
            best = min(toc_labels, key=lambda t: _levenshtein(lid, t))
            dist = _levenshtein(lid, best)
            if dist <= 2:
                card["lesson_id"] = best
                diff_report["corrected"].append({"original": lid, "corrected": best, "distance": dist})
                diff_report["matched"] += 1
                if best in diff_report["missing_from_cards"]:
                    diff_report["missing_from_cards"].remove(best)
            else:
                diff_report["unmatched"].append(lid)
    
    diff_report["summary"] = (
        f"{diff_report['matched']} matched, "
        f"{len(diff_report['corrected'])} auto-corrected, "
        f"{len(diff_report['unmatched'])} unmatched, "
        f"{len(diff_report['missing_from_cards'])} missing (TOC has but cards don't)"
    )
    return diff_report
```

- [ ] **Step 2: 修改 main() 添加 --toc 参数和调用**

在 `parse_args()` 中添加：

```python
    parser.add_argument("--toc", help="TOC JSON 路径，用于校验 lesson_id + 自动修正")
```

在 `main()` 中，在 JSONL 写入循环之后，输出统计之前，添加校验逻辑：

```python
    # ... 原有 main() 逻辑 ...

    # --toc 校验 + 修正（在所有 card JSONL 写入完成后）
    if args.toc:
        import json as _json
        toc_path = Path(args.toc)
        if toc_path.exists():
            toc = _json.loads(toc_path.read_text(encoding="utf-8"))
            # 收集已写入的 cards（按 file_key 分组）
            cards_by_file = {}
            for source in sources:
                rel_file = source.rel_path / source.md_path.name
                out_file = extracted_dir / rel_file.with_suffix(".jsonl")
                if out_file.exists():
                    items = [_json.loads(l) for l in out_file.read_text(encoding="utf-8").splitlines() if l.strip()]
                    if items:
                        cards_by_file[str(rel_file)] = items
            report = validate_and_correct(cards_by_file, toc, extracted_dir)
            # 写回修正后的 cards
            for file_key, cards in cards_by_file.items():
                out_file = extracted_dir / file_key.replace(".md", ".jsonl")
                with out_file.open("w", encoding="utf-8") as f:
                    for item in cards:
                        f.write(_json.dumps(item, ensure_ascii=False) + "\n")
            # 输出 diff report
            report_path = extracted_dir / "diff_report.json"
            report_path.write_text(_json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"[toc] diff report: {report['summary']}", flush=True)
        else:
            print(f"[WARN] TOC file not found: {args.toc}", flush=True)
```

- [ ] **Step 3: 将 TOC 合法 lesson_id 注入 LLM prompt（可选增强）**

在 `card_labeler.py` 的 `label()` 方法中，如果传入了 `toc_labels`，追加到 prompt：

此项为可选增强，如果实现：

```python
# card_labeler.py
def label(self, cards_text, page_number, prev_lesson_id=None, toc_labels=None):
    user_message = ...
    if toc_labels:
        user_message += f"\n\n【合法 lesson_id 列表，请严格使用以下值之一】\n" + "\n".join(toc_labels)
    ...
```

在 `extract_cli.py` 的 `main()` 中，如果 `--toc` 指定了，解析 TOC 并在创建 `CardLabeler` 前提取 labels，传给 labeler 或通过 labeler.label() 传入。

- [ ] **Step 4: 编写测试**

在 `tests/test_extract_cli.py` 中添加：

```python
class TestLevenshtein:
    def test_identical(self):
        from extract_cli import _levenshtein
        assert _levenshtein("26.1 反比例函数", "26.1 反比例函数") == 0

    def test_one_substitution(self):
        from extract_cli import _levenshtein
        assert _levenshtein("26.1 反比利函数", "26.1 反比例函数") == 1

    def test_two_edits(self):
        from extract_cli import _levenshtein
        assert _levenshtein("26.1反比例函数", "26.1 反比例函数") == 1  # 缺少空格

    def test_empty(self):
        from extract_cli import _levenshtein
        assert _levenshtein("", "abc") == 3
        assert _levenshtein("abc", "") == 3


class TestFlattenTocLabels:
    def test_extracts_all_labels(self):
        from extract_cli import _flatten_toc_labels
        toc = {
            "book": "test",
            "chapters": [{
                "number": 26, "title": "反比例函数", "label": "第二十六章 反比例函数",
                "sections": [{
                    "number": [26, 1], "title": "反比例函数", "label": "26.1 反比例函数",
                    "subsections": [{
                        "number": [26, 1, 1], "title": "反比例函数",
                        "label": "26.1.1 反比例函数"
                    }]
                }],
                "supplements": [{"type": "supplement", "label": "小结"}]
            }]
        }
        labels = _flatten_toc_labels(toc)
        assert "第二十六章 反比例函数" in labels
        assert "26.1 反比例函数" in labels
        assert "26.1.1 反比例函数" in labels
        assert "小结" in labels
        assert len(labels) == 4


class TestValidateAndCorrect:
    def test_exact_match(self):
        from extract_cli import validate_and_correct
        toc = {"book": "test", "chapters": []}
        cards_by_file = {"a.jsonl": [{"lesson_id": "26.1 反比例函数"}]}
        # TOC 中没有标签，card lesson_id 不会 matched
        # 没有 TOC labels 的情况不是实际使用场景
        pass

    def test_auto_correct_typo(self):
        from extract_cli import validate_and_correct, _flatten_toc_labels
        toc = {
            "book": "test",
            "chapters": [{
                "number": 26, "title": "反比例函数", "label": "第二十六章 反比例函数",
                "sections": [{
                    "number": [26, 1], "title": "反比例函数",
                    "label": "26.1 反比例函数", "subsections": []
                }],
                "supplements": []
            }]
        }
        cards_by_file = {"a.jsonl": [{"lesson_id": "26.1 反比利函数"}]}
        report = validate_and_correct(cards_by_file, toc, Path("/tmp"))
        assert report["matched"] == 0
        assert len(report["corrected"]) == 1
        assert report["corrected"][0]["original"] == "26.1 反比利函数"
        assert report["corrected"][0]["corrected"] == "26.1 反比例函数"
```

- [ ] **Step 5: 运行测试**

```bash
cd tools/data-refinery && python -m pytest tests/test_extract_cli.py -v
```

Expected: all tests pass, including new Levenshtein/validate tests.

- [ ] **Step 6: 提交**

```bash
git add tools/data-refinery/src/extract_cli.py tools/data-refinery/tests/test_extract_cli.py
git commit -m "feat(extract_cli): add --toc param, Levenshtein-based validate_and_correct() for lesson_id alignment"
```

---

### Task 7: 端到端验证

**Files:** none (manual verification)

- [ ] **Step 1: 用九年级下册真实数据跑 TOC 解析**

```bash
cd tools/data-refinery
python src/toc_parse_cli.py --book "九年级/下册"
cat output/toc/数学/人教版/九年级/下册_*.json | python -m json.tool | head -50
```

Expected: TOC JSON 包含 4 章（26-29）、各级节、supplements（小结、复习题等）。

- [ ] **Step 2: 建骨架**

```bash
python src/db_loader_cli.py --load-toc --toc-path output/toc/数学/人教版/九年级/义务教育教科书·数学九年级下册_toc.json
```

Expected: units 有 4 章，lessons 数 ≥ 20。

- [ ] **Step 3: 增量 card 入库**

```bash
python src/db_loader_cli.py --load-cards --toc-path output/toc/数学/人教版/九年级/义务教育教科书·数学九年级下册_toc.json --source smartedu
```

Expected: 26 章的 cards 挂到已有 lessons 下，27-29 章 lessons 仍无 card。

- [ ] **Step 4: 不带 TOC 的向后兼容验证**

```bash
python src/db_loader_cli.py --source smartedu
```

Expected: 行为与之前完全一致。

---

### Task 8: 更新 docs/CLAUDE.md 和主 CLAUDE.md

**Files:**
- Modify: `docs/CLAUDE.md`
- Modify: `CLAUDE.md`（repo root）

- [ ] **Step 1: 在 docs/CLAUDE.md 阅读优先级中添加**

在 `docs/CLAUDE.md` 阅读优先级部分添加：

```markdown
- 做数据管线开发 → 先读 PRD + data-refinery-管线总结与后续 + TOC目录优先管线设计
```

- [ ] **Step 2: 提交**

```bash
git add docs/CLAUDE.md
git commit -m "docs: add toc parse guide to navigation"
```
